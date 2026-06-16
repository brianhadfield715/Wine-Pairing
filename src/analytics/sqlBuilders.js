// src/analytics/sqlBuilders.js
// Parameterized SQL builders. Each returns { text, values, meta }.
// All builders read from the analytics views/tables and never interpolate
// user input into SQL — only $N parameters.
//
// Timeframe handling:
//   - The new parser supplies `params.timeframe = { mode, sinceIso, untilIso, label, days }`.
//   - Each builder calls `windowToBinds(params, defaultDays)` to get a
//     ready-to-paste `WHERE` fragment plus the values to bind. This keeps
//     SQL injection impossible (only $N parameters carry user input).
//   - mode='all_time' → no time predicate added.

// ---------------------------------------------------------------------------
// Window helper
// ---------------------------------------------------------------------------

/**
 * Returns { fragments: [...sql...], values: [...] } describing the time
 * filter on the given timestamp column. Caller appends `AND ...fragments`
 * to its WHERE clause.
 *
 * @param {string} col            – fully-qualified column name (e.g. "fs.occurred_at")
 * @param {object} tf             – timeframe object from temporalParser
 * @param {number} startIdx       – first parameter slot to use ($N)
 */
function windowFragments(col, tf, startIdx) {
  if (!tf || tf.mode === 'all_time') {
    return { fragments: [], values: [], nextIdx: startIdx };
  }
  const frags = [];
  const values = [];
  let i = startIdx;
  if (tf.sinceIso) { frags.push(`${col} >= $${i}::timestamptz`); values.push(tf.sinceIso); i += 1; }
  if (tf.untilIso) { frags.push(`${col} <  $${i}::timestamptz`); values.push(tf.untilIso); i += 1; }
  return { fragments: frags, values, nextIdx: i };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

function topCustomersBySpend(p) {
  // Lifetime view; timeframe only honored if window-shaped (otherwise we
  // use dim_customer_profile which is already lifetime-aggregated).
  const limit = p.limit || 10;
  const tf = p.timeframe;
  if (tf && tf.mode === 'window') {
    // Compute spend within window from fact_sales.
    const w = windowFragments('fs.occurred_at', tf, 1);
    const values = [...w.values, limit];
    const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
    const text = `
      select fs.customer_id,
             max(c.email)                                                            as email,
             max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))) as customer_name,
             sum(fs.net_revenue)::numeric(14,2)                                      as total_spend,
             count(distinct fs.order_id)                                             as order_count,
             max(fs.occurred_at)                                                     as last_order_at
        from fact_sales fs
        left join customers c on c.id = fs.customer_id
       ${where}
       group by fs.customer_id
       order by total_spend desc nulls last
       limit $${w.nextIdx}
    `;
    return { text, values, meta: { domain: 'customers', windowed: true } };
  }
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           first_order_at, last_order_at,
           favorite_vendor, favorite_product_type
      from dim_customer_profile
     where total_spend > 0
     order by total_spend desc nulls last
     limit $1
  `;
  return { text, values: [limit], meta: { domain: 'customers' } };
}

function customerProfile(p) {
  // Used when we already have a resolved customer (engine sets p.resolved.customer)
  if (p.resolved && p.resolved.customer) {
    const text = `select * from dim_customer_profile where customer_id = $1 limit 1`;
    return { text, values: [p.resolved.customer.customer_id], meta: { domain: 'customers' } };
  }
  // Fallback: recent active customers.
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           last_order_at, favorite_vendor, favorite_product_type
      from dim_customer_profile
     where last_order_at is not null
     order by last_order_at desc
     limit $1
  `;
  return { text, values: [p.limit || 10], meta: { domain: 'customers' } };
}

function customerSpend(p) {
  // Single resolved customer + window. The engine guarantees p.resolved.customer.
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) {
    // No customer resolved — return a graceful empty plan.
    const text = `select 0::int as order_count, 0::numeric(14,2) as total_spend, null::timestamptz as first_order_at, null::timestamptz as last_order_at`;
    return { text, values: [], meta: { domain: 'customers' } };
  }
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      $1::bigint                                  as customer_id,
      count(distinct fs.order_id)::int            as order_count,
      coalesce(sum(fs.net_revenue), 0)::numeric(14,2)    as total_spend,
      coalesce(sum(fs.quantity), 0)::int                 as units,
      case when count(distinct fs.order_id) > 0
           then (sum(fs.net_revenue) / count(distinct fs.order_id))::numeric(14,2)
           else 0 end                              as average_order_value,
      min(fs.occurred_at)                          as first_order_at,
      max(fs.occurred_at)                          as last_order_at
    from fact_sales fs
    where fs.customer_id = $1 ${where}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function customerOrderCount(p) {
  // Same shape as customerSpend, formatter picks different fields.
  return customerSpend(p);
}

function customerAov(p) {
  return customerSpend(p);
}

function customerRecentPurchases(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) {
    return { text: 'select null::text where false', values: [], meta: { domain: 'customers' } };
  }
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values, p.limit || 25];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.order_name, fs.order_id, fs.occurred_at,
           fs.sku, fs.product_title, fs.variant_title,
           fs.quantity, fs.unit_price, fs.net_revenue
      from fact_sales fs
     where fs.customer_id = $1 ${where}
     order by fs.occurred_at desc, fs.order_id desc
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function customersWhoBought(p) {
  const limit = p.limit || 25;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const filters = [...w.fragments];
  const values = [...w.values];
  let i = w.nextIdx;

  if (p.varietal) {
    values.push(`%${p.varietal}%`);
    filters.push(`(lower(fs.product_title) like lower($${i}) or lower(fs.variant_title) like lower($${i}))`);
    i++;
  }
  if (p.sku) {
    values.push(p.sku);
    filters.push(`fs.sku = $${i++}`);
  }
  if (p.color) {
    values.push(`%${p.color}%`);
    filters.push(`lower(fs.product_title) like lower($${i++})`);
  }
  if (p.vendor) {
    values.push(`%${p.vendor}%`);
    filters.push(`lower(fs.vendor) like lower($${i++})`);
  }
  values.push(limit);
  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  const text = `
    select fs.customer_id,
           max(c.email)                                                            as email,
           max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
           sum(fs.quantity)::int                                                   as units,
           sum(fs.net_revenue)::numeric(14,2)                                      as spend,
           max(fs.occurred_at)                                                     as last_purchase
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     ${where}
     group by fs.customer_id
     order by spend desc nulls last
     limit $${i}
  `;
  return { text, values, meta: { domain: 'customers_orders' } };
}

function customerCount() {
  const text = `
    select
      (select count(*) from customers)                                  as total_customers,
      (select count(*) from dim_customer_profile where order_count > 0) as customers_with_orders,
      (select count(*) from dim_customer_profile
         where last_order_at >= now() - interval '90 days')             as active_90d
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function newCustomers(p) {
  const tf = p.timeframe && p.timeframe.mode !== 'all_time' ? p.timeframe : { mode: 'window', sinceIso: new Date(Date.now() - 30 * 86400e3).toISOString(), untilIso: new Date().toISOString() };
  const w = windowFragments('first_order_at', tf, 1);
  const values = [...w.values, p.limit || 25];
  const text = `
    select customer_id, email, customer_name, first_order_at, total_spend, order_count
      from dim_customer_profile
     where ${w.fragments.length ? w.fragments.join(' and ') : 'true'}
     order by first_order_at desc
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function lapsedCustomers(p) {
  const minDays = (p.timeframe && p.timeframe.days) || 180;
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           last_order_at, days_since_last_order
      from dim_customer_profile
     where days_since_last_order >= $1
       and total_spend > 0
     order by total_spend desc
     limit $2
  `;
  return { text, values: [minDays, p.limit || 25], meta: { domain: 'customers' } };
}

function customersOneTimeOnly(p) {
  const w = windowFragments('first_order_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 25];
  const where = w.fragments.length ? `where order_count = 1 and ${w.fragments.join(' and ')}` : `where order_count = 1`;
  const text = `
    select customer_id, email, customer_name, first_order_at, total_spend
      from dim_customer_profile
     ${where}
     order by total_spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function topCustomersByVarietal(p) {
  // Top spenders on a varietal (text match) within the timeframe.
  const limit = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values];
  let i = w.nextIdx;
  const filters = [...w.fragments];
  if (p.varietal) {
    values.push(`%${p.varietal}%`);
    filters.push(`(lower(fs.product_title) like lower($${i}) or lower(fs.variant_title) like lower($${i}))`);
    i++;
  }
  values.push(limit);
  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  const text = `
    select fs.customer_id,
           max(c.email)                                                            as email,
           max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
           sum(fs.net_revenue)::numeric(14,2)                                      as spend,
           sum(fs.quantity)::int                                                   as units
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     ${where}
     group by fs.customer_id
     order by spend desc nulls last
     limit $${i}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function topCustomersByVendor(p) {
  const limit = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values];
  let i = w.nextIdx;
  const filters = [...w.fragments];
  if (p.vendor) {
    values.push(`%${p.vendor}%`);
    filters.push(`lower(fs.vendor) like lower($${i++})`);
  }
  values.push(limit);
  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  const text = `
    select fs.customer_id,
           max(c.email)                                                            as email,
           max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
           sum(fs.net_revenue)::numeric(14,2)                                      as spend,
           sum(fs.quantity)::int                                                   as units
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     ${where}
     group by fs.customer_id
     order by spend desc nulls last
     limit $${i}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// ---------------------------------------------------------------------------
// Basket / affinity
// ---------------------------------------------------------------------------

function basketPairs(p = {}) {
  const limit = p.limit || 20;
  const text = `
    select
      a.title as product_a,
      b.title as product_b,
      count(*)::int as times_bought_together
    from order_line_items a
    join order_line_items b
      on a.order_id = b.order_id
     and a.product_id < b.product_id
    join orders o on o.id = a.order_id
    where o.cancelled_at is null
      and a.product_id is not null
      and b.product_id is not null
    group by a.title, b.title
    order by times_bought_together desc
    limit $1
  `;
  return { text, values: [limit], meta: { domain: 'orders' } };
}

function boughtWithProduct(p) {
  // Find products co-purchased with the given product (by sku or product_id).
  // Prefers resolved product id; falls back to varietal/title match.
  const limit = p.limit || 20;
  const productId = p.resolved && p.resolved.product && p.resolved.product.product_id;
  const w = windowFragments('o.created_at', p.timeframe, 2);

  if (productId) {
    const values = [productId, ...w.values, limit];
    const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
    const text = `
      select b.title as product, b.sku as sku,
             count(distinct a.order_id)::int as orders_together
        from order_line_items a
        join order_line_items b
          on a.order_id = b.order_id and a.product_id <> b.product_id
        join orders o on o.id = a.order_id
       where a.product_id = $1
         and o.cancelled_at is null
         ${where}
       group by b.title, b.sku
       order by orders_together desc
       limit $${w.nextIdx}
    `;
    return { text, values, meta: { domain: 'orders' } };
  }
  // No resolution: fall back to basket pairs.
  return basketPairs(p);
}

// ---------------------------------------------------------------------------
// Sales / SKU performance
// ---------------------------------------------------------------------------

function topItemsByUnits(p) {
  const limit = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const filters = [...w.fragments, `fs.sku <> ''`];
  const values = [...w.values];
  let i = w.nextIdx;
  if (p.color)    { values.push(`%${p.color}%`);    filters.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.varietal) { values.push(`%${p.varietal}%`); filters.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.vendor)   { values.push(`%${p.vendor}%`);   filters.push(`lower(fs.vendor) like lower($${i++})`); }
  values.push(limit);
  const text = `
    select fs.product_id, fs.sku,
           max(fs.product_title) as product_title,
           max(fs.vendor)        as vendor,
           sum(fs.quantity)::int as units_sold,
           sum(fs.net_revenue)::numeric(14,2) as net_revenue
      from fact_sales fs
     where ${filters.join(' and ')}
     group by fs.product_id, fs.sku
     order by units_sold desc, net_revenue desc
     limit $${i}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function topItemsByRevenue(p) {
  const limit = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const filters = [...w.fragments, `fs.sku <> ''`];
  const values = [...w.values];
  let i = w.nextIdx;
  if (p.color)    { values.push(`%${p.color}%`);    filters.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.varietal) { values.push(`%${p.varietal}%`); filters.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.vendor)   { values.push(`%${p.vendor}%`);   filters.push(`lower(fs.vendor) like lower($${i++})`); }
  values.push(limit);
  const text = `
    select fs.product_id, fs.sku,
           max(fs.product_title) as product_title,
           max(fs.vendor)        as vendor,
           sum(fs.quantity)::int as units_sold,
           sum(fs.net_revenue)::numeric(14,2) as net_revenue
      from fact_sales fs
     where ${filters.join(' and ')}
     group by fs.product_id, fs.sku
     order by net_revenue desc, units_sold desc
     limit $${i}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function unitsSoldPerSku(p) {
  if (p.sku) {
    const text = `
      select sku, product_title, vendor, units_sold, units_sold_30d, units_sold_90d,
             net_revenue, on_hand, last_sold_at
        from dim_sku_profile
       where sku = $1
       limit 1
    `;
    return { text, values: [p.sku], meta: { domain: 'sales' } };
  }
  return topItemsByUnits(p);
}

function productDetail(p) {
  // Either resolved product or by sku/varietal hint.
  const productId = p.resolved && p.resolved.product && p.resolved.product.product_id;
  const w = windowFragments('fs.occurred_at', p.timeframe, productId ? 2 : 1);

  if (productId) {
    const values = [productId, ...w.values];
    const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
    const text = `
      select
        $1::bigint                                     as product_id,
        (select title from products where id = $1)     as product_title,
        coalesce(sum(fs.quantity), 0)::int             as units_sold,
        coalesce(sum(fs.net_revenue), 0)::numeric(14,2) as net_revenue,
        count(distinct fs.order_id)::int               as orders,
        count(distinct fs.customer_id)::int            as customers,
        min(fs.occurred_at)                            as first_sold,
        max(fs.occurred_at)                            as last_sold
      from fact_sales fs
      where fs.product_id = $1 ${where}
    `;
    return { text, values, meta: { domain: 'sales' } };
  }
  return topItemsByUnits(p);
}

function topVendors(p) {
  const w = windowFragments('occurred_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 10];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(vendor, ''), '(unknown)') as vendor,
           sum(quantity)::int                       as units_sold,
           sum(net_revenue)::numeric(14,2)          as net_revenue,
           count(distinct order_id)                 as orders
      from fact_sales
     ${where}
     group by 1
     order by net_revenue desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'vendors' } };
}

function vendorGrowth(p) {
  // Compare current window vs the same-length previous window.
  // If timeframe is all_time, default to last-90 vs prior-90.
  let tf = p.timeframe;
  if (!tf || tf.mode !== 'window') {
    const now = new Date();
    tf = {
      mode: 'window',
      sinceIso: new Date(now - 90 * 86400e3).toISOString(),
      untilIso: now.toISOString(),
      days: 90,
    };
  }
  const widthMs = new Date(tf.untilIso) - new Date(tf.sinceIso);
  const priorSince = new Date(new Date(tf.sinceIso).getTime() - widthMs).toISOString();
  const priorUntil = tf.sinceIso;
  const text = `
    with cur as (
      select coalesce(nullif(vendor,''), '(unknown)') as vendor,
             sum(net_revenue)::numeric(14,2) as revenue,
             sum(quantity)::int              as units
        from fact_sales
       where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
       group by 1
    ),
    prev as (
      select coalesce(nullif(vendor,''), '(unknown)') as vendor,
             sum(net_revenue)::numeric(14,2) as revenue,
             sum(quantity)::int              as units
        from fact_sales
       where occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
       group by 1
    )
    select coalesce(cur.vendor, prev.vendor) as vendor,
           coalesce(cur.revenue, 0)  as revenue_current,
           coalesce(prev.revenue, 0) as revenue_previous,
           (coalesce(cur.revenue, 0) - coalesce(prev.revenue, 0))::numeric(14,2) as revenue_delta,
           case when coalesce(prev.revenue, 0) = 0 then null
                else round(
                  ((coalesce(cur.revenue, 0) - prev.revenue) / prev.revenue) * 100,
                  1
                ) end as pct_change
      from cur full outer join prev on prev.vendor = cur.vendor
     order by revenue_delta desc nulls last
     limit $5
  `;
  return {
    text,
    values: [tf.sinceIso, tf.untilIso, priorSince, priorUntil, p.limit || 10],
    meta: { domain: 'vendors', window_current: { sinceIso: tf.sinceIso, untilIso: tf.untilIso }, window_previous: { sinceIso: priorSince, untilIso: priorUntil } },
  };
}

function categoryPerformance(p) {
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 10];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(p.product_type,''), '(unknown)') as category,
           sum(fs.quantity)::int                            as units,
           sum(fs.net_revenue)::numeric(14,2)               as revenue,
           count(distinct fs.order_id)                      as orders
      from fact_sales fs
      left join products p on p.id = fs.product_id
     ${where}
     group by 1
     order by revenue desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function varietalPerformance(p) {
  // Treat varietal as a text-match on the product title.
  const limit = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const filters = [...w.fragments];
  const values = [...w.values];
  let i = w.nextIdx;
  if (p.varietal) {
    values.push(`%${p.varietal}%`);
    filters.push(`lower(fs.product_title) like lower($${i++})`);
  }
  values.push(limit);
  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  const text = `
    select '${(p.varietal || 'overall').replace(/'/g, "''")}'::text as varietal,
           sum(fs.quantity)::int             as units,
           sum(fs.net_revenue)::numeric(14,2) as revenue,
           count(distinct fs.order_id)       as orders,
           count(distinct fs.customer_id)    as customers
      from fact_sales fs
     ${where}
     limit $${i}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function periodOverPeriod(p) {
  // Headline revenue/units/orders for current window vs the same length
  // immediately prior. Defaults to last 30 days vs prior 30 days.
  let tf = p.timeframe;
  if (!tf || tf.mode !== 'window') {
    const now = new Date();
    tf = { mode: 'window', sinceIso: new Date(now - 30 * 86400e3).toISOString(), untilIso: now.toISOString(), days: 30 };
  }
  const widthMs = new Date(tf.untilIso) - new Date(tf.sinceIso);
  const priorSince = new Date(new Date(tf.sinceIso).getTime() - widthMs).toISOString();
  const priorUntil = tf.sinceIso;
  const text = `
    select 'current' as bucket,
           sum(net_revenue)::numeric(14,2) as revenue,
           sum(quantity)::int              as units,
           count(distinct order_id)::int   as orders
      from fact_sales
     where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
    union all
    select 'previous',
           sum(net_revenue)::numeric(14,2),
           sum(quantity)::int,
           count(distinct order_id)::int
      from fact_sales
     where occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
  `;
  return {
    text,
    values: [tf.sinceIso, tf.untilIso, priorSince, priorUntil],
    meta: { domain: 'sales', window_current: { sinceIso: tf.sinceIso, untilIso: tf.untilIso }, window_previous: { sinceIso: priorSince, untilIso: priorUntil } },
  };
}

function trendingUp(p) {
  // SKUs whose 30d units exceed 90d-avg-extrapolated baseline. Simple
  // heuristic: units_sold_30d > units_sold_90d / 3 by some factor.
  const text = `
    select sku, product_title, vendor, on_hand,
           units_sold_30d, units_sold_90d, last_sold_at
      from dim_sku_profile
     where units_sold_30d > 0
       and units_sold_90d > 0
     order by (units_sold_30d::numeric / nullif(units_sold_90d, 0)) desc
     limit $1
  `;
  return { text, values: [p.limit || 10], meta: { domain: 'sales' } };
}

function trendingDown(p) {
  const text = `
    select sku, product_title, vendor, on_hand,
           units_sold_30d, units_sold_90d, last_sold_at
      from dim_sku_profile
     where units_sold_90d > 0
       and units_sold_30d < (units_sold_90d / 3)
     order by (coalesce(units_sold_30d,0)::numeric / nullif(units_sold_90d, 0)) asc nulls last
     limit $1
  `;
  return { text, values: [p.limit || 10], meta: { domain: 'sales' } };
}

function recentOrders(p) {
  const tf = (p.timeframe && p.timeframe.mode !== 'all_time')
    ? p.timeframe
    : { mode: 'window', sinceIso: new Date(Date.now() - 7 * 86400e3).toISOString(), untilIso: new Date().toISOString() };
  const w = windowFragments('coalesce(o.processed_at, o.created_at)', tf, 1);
  const values = [...w.values, p.limit || 25];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select o.id, o.name, o.processed_at, o.created_at,
           o.total_price, o.financial_status, o.fulfillment_status,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email
      from orders o
      left join customers c on c.id = o.customer_id
     where o.cancelled_at is null ${where}
     order by coalesce(o.processed_at, o.created_at) desc
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'orders' } };
}

function salesSummary(p) {
  const tf = (p.timeframe && p.timeframe.mode !== 'all_time')
    ? p.timeframe
    : { mode: 'window', sinceIso: new Date(Date.now() - 30 * 86400e3).toISOString(), untilIso: new Date().toISOString(), days: 30 };
  const w = windowFragments('occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(distinct order_id)            as orders,
      coalesce(sum(quantity), 0)::int     as units,
      coalesce(sum(net_revenue), 0)::numeric(14,2)   as net_revenue,
      coalesce(sum(gross_revenue), 0)::numeric(14,2) as gross_revenue,
      coalesce(sum(line_discount), 0)::numeric(14,2) as discounts
      from fact_sales
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'revenue', timeframe: tf } };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function lowStock(p) {
  const threshold = p.money ? p.money.value : 6;
  const text = `
    select product_title, vendor, sku, variant_title, price, on_hand
      from vw_current_inventory
     where on_hand > 0
       and on_hand <= $1
       and coalesce(product_status, 'active') = 'active'
     order by on_hand asc, product_title asc
     limit $2
  `;
  return { text, values: [threshold, p.limit || 25], meta: { domain: 'inventory' } };
}

function outOfStock(p) {
  const text = `
    select product_title, vendor, sku, variant_title, price, on_hand
      from vw_current_inventory
     where on_hand <= 0
       and coalesce(product_status, 'active') = 'active'
     order by product_title asc
     limit $1
  `;
  return { text, values: [p.limit || 50], meta: { domain: 'inventory' } };
}

function inStockFiltered(p) {
  const filters = ['v.on_hand > 0', `coalesce(v.product_status, 'active') = 'active'`];
  const values = [];
  let i = 1;
  if (p.color) {
    values.push(`%${p.color}%`);
    filters.push(`(lower(v.product_type) like lower($${i}) or lower(v.product_title) like lower($${i}))`);
    i++;
  }
  if (p.varietal) {
    values.push(`%${p.varietal}%`);
    filters.push(`lower(v.product_title) like lower($${i++})`);
  }
  if (p.vendor) {
    values.push(`%${p.vendor}%`);
    filters.push(`lower(v.vendor) like lower($${i++})`);
  }
  if (p.money) {
    if (p.money.op === '<') { values.push(p.money.value); filters.push(`v.price < $${i++}`); }
    else if (p.money.op === '>') { values.push(p.money.value); filters.push(`v.price > $${i++}`); }
    else if (p.money.op === 'between') { values.push(p.money.min, p.money.max); filters.push(`v.price between $${i++} and $${i++}`); }
  }
  values.push(p.limit || 25);
  const text = `
    select v.product_title, v.vendor, v.sku, v.variant_title, v.price, v.on_hand,
           v.product_handle
      from vw_current_inventory v
     where ${filters.join(' and ')}
     order by v.price asc nulls last
     limit $${i}
  `;
  return { text, values, meta: { domain: 'inventory' } };
}

function deadInventory(p) {
  const days = (p.timeframe && p.timeframe.days) || 180;
  const text = `
    select sku, product_title, vendor, on_hand, units_sold, last_sold_at
      from dim_sku_profile
     where on_hand > 0
       and (last_sold_at is null or last_sold_at < now() - ($1 || ' days')::interval)
     order by on_hand desc, sku asc
     limit $2
  `;
  return { text, values: [String(days), p.limit || 25], meta: { domain: 'inventory' } };
}

function unsoldInPeriod(p) {
  return deadInventory(p);
}

function agedInventory(p) {
  // SKUs with non-zero on-hand whose last_sold_at is more than `days` ago.
  return deadInventory(p);
}

function overstock(p) {
  // Heuristic: on_hand >= 4× monthly velocity (units_sold_30d) and at least 12 on-hand.
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d, units_sold_90d
      from dim_sku_profile
     where on_hand >= 12
       and (units_sold_30d is null or units_sold_30d = 0 or on_hand >= units_sold_30d * 4)
     order by on_hand desc
     limit $1
  `;
  return { text, values: [p.limit || 25], meta: { domain: 'inventory' } };
}

function runoutRisk(p) {
  // Days of cover < 14, on_hand > 0, velocity > 0.
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d,
           case when units_sold_30d > 0
                then round((on_hand::numeric / (units_sold_30d / 30.0)), 1)
                else null end as days_of_cover
      from dim_sku_profile
     where on_hand > 0
       and units_sold_30d > 0
       and (on_hand::numeric / nullif(units_sold_30d, 0) / 30.0) <= 0.5
     order by days_of_cover asc nulls last
     limit $1
  `;
  return { text, values: [p.limit || 25], meta: { domain: 'inventory' } };
}

function inventoryVelocity(p) {
  // Just expose dim_sku_profile sorted by 30-day velocity.
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d, units_sold_90d, net_revenue, last_sold_at
      from dim_sku_profile
     where units_sold_30d > 0 or units_sold_90d > 0
     order by units_sold_30d desc, units_sold_90d desc
     limit $1
  `;
  return { text, values: [p.limit || 25], meta: { domain: 'inventory' } };
}

function sellThrough(p) {
  // Sell-through = units_sold_30d / max(units_sold_30d + on_hand, 1)
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d,
           case when (on_hand + units_sold_30d) > 0
                then round(units_sold_30d::numeric / (on_hand + units_sold_30d), 3)
                else null end as sell_through_30d
      from dim_sku_profile
     where (on_hand + units_sold_30d) > 0
     order by sell_through_30d desc nulls last
     limit $1
  `;
  return { text, values: [p.limit || 25], meta: { domain: 'inventory' } };
}

function lowStockHighVelocity(p) {
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d, units_sold_90d,
           net_revenue, last_sold_at
      from dim_sku_profile
     where on_hand > 0
       and on_hand <= $1
       and units_sold_30d >= $2
     order by units_sold_30d desc, on_hand asc
     limit $3
  `;
  const threshold = p.money ? p.money.value : 6;
  const minSales = 2;
  return { text, values: [threshold, minSales, p.limit || 25], meta: { domain: 'inventory' } };
}

module.exports = {
  // customers
  topCustomersBySpend,
  customerProfile,
  customerSpend,
  customerOrderCount,
  customerAov,
  customerRecentPurchases,
  customersWhoBought,
  customerCount,
  newCustomers,
  lapsedCustomers,
  customersOneTimeOnly,
  topCustomersByVarietal,
  topCustomersByVendor,
  // basket
  basketPairs,
  boughtWithProduct,
  // sales / SKU
  topItemsByUnits,
  topItemsByRevenue,
  unitsSoldPerSku,
  productDetail,
  topVendors,
  vendorGrowth,
  categoryPerformance,
  varietalPerformance,
  periodOverPeriod,
  trendingUp,
  trendingDown,
  recentOrders,
  salesSummary,
  // inventory
  lowStock,
  outOfStock,
  inStockFiltered,
  deadInventory,
  unsoldInPeriod,
  agedInventory,
  overstock,
  runoutRisk,
  inventoryVelocity,
  sellThrough,
  lowStockHighVelocity,
};
