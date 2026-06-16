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
  if (p.category) {
    values.push(`%${p.category}%`);
    filters.push(`(lower(fs.product_title) like lower($${i}) or lower(fs.variant_title) like lower($${i}))`);
    i++;
  }
  // Price-band filter: "premium" => unit price > N; "under $25" => < N.
  if (p.money) {
    if (p.money.op === '<') { values.push(p.money.value); filters.push(`fs.unit_price < $${i++}`); }
    else if (p.money.op === '>') { values.push(p.money.value); filters.push(`fs.unit_price > $${i++}`); }
    else if (p.money.op === 'between') { values.push(p.money.min, p.money.max); filters.push(`fs.unit_price between $${i++} and $${i++}`); }
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
  // Priority for the lapsed-cutoff:
  //   1. explicit "not purchased in N days" → p.lapsedDays
  //   2. timeframe width (e.g. "in the last 60 days")
  //   3. default 180 days
  const minDays = p.lapsedDays || (p.timeframe && p.timeframe.days) || 180;
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           last_order_at, days_since_last_order
      from dim_customer_profile
     where days_since_last_order >= $1
       and total_spend > 0
     order by total_spend desc
     limit $2
  `;
  return { text, values: [minDays, p.limit || 25], meta: { domain: 'customers', lapsed_days: minDays } };
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
  // Honor timeframe by filtering on the parent order's created_at.
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const filters = [
    `o.cancelled_at is null`,
    `a.product_id is not null`,
    `b.product_id is not null`,
    ...w.fragments,
  ];
  const values = [...w.values, limit];
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
    where ${filters.join(' and ')}
    group by a.title, b.title
    order by times_bought_together desc
    limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'orders' } };
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
  // For all_time we DO want to honor it (return cumulative totals); only
  // fall back to "last 30 days" when no temporal phrase was detected at
  // all (the parser already labels that as all_time, so we treat truly
  // absent temporal phrases by checking the question — engine sets
  // `p.timeframe` directly).
  const tf = p.timeframe || { mode: 'all_time', label: 'all time' };
  const w = windowFragments('occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(distinct order_id)::int                       as orders,
      coalesce(sum(quantity), 0)::int                     as units,
      coalesce(sum(net_revenue), 0)::numeric(14,2)        as net_revenue,
      coalesce(sum(gross_revenue), 0)::numeric(14,2)      as gross_revenue,
      coalesce(sum(line_discount), 0)::numeric(14,2)      as discounts,
      case when count(distinct order_id) > 0
           then (sum(net_revenue) / count(distinct order_id))::numeric(14,2)
           else 0 end                                      as average_order_value
      from fact_sales
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'revenue', timeframe: tf, metric: p.metric || 'revenue' } };
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
  // Days come from explicit "...in N days" capture first, then the
  // timeframe width, then a sane default.
  const days = p.dayCount || (p.timeframe && p.timeframe.days) || 90;
  const filters = [
    `on_hand > 0`,
    `(last_sold_at is null or last_sold_at < now() - ($1 || ' days')::interval)`,
  ];
  const values = [String(days)];
  let i = 2;
  if (p.vendor) {
    values.push(`%${p.vendor}%`);
    filters.push(`lower(coalesce(vendor,'')) like lower($${i++})`);
  }
  if (p.color || p.varietal) {
    values.push(`%${p.color || p.varietal}%`);
    filters.push(`lower(coalesce(product_title,'')) like lower($${i++})`);
  }
  values.push(p.limit || 25);
  const text = `
    select sku, product_title, vendor, on_hand, units_sold,
           units_sold_30d, units_sold_90d, last_sold_at
      from dim_sku_profile
     where ${filters.join(' and ')}
     order by on_hand desc, sku asc
     limit $${i}
  `;
  return { text, values, meta: { domain: 'inventory', days } };
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

// ---------------------------------------------------------------------------
// NEW BUILDERS for the expanded language coverage
// ---------------------------------------------------------------------------

// Top spenders ranked by ORDER COUNT (recurring customers).
function topCustomersByOrderCount(p) {
  const limit = p.limit || 10;
  const tf = p.timeframe;
  if (tf && tf.mode === 'window') {
    const w = windowFragments('fs.occurred_at', tf, 1);
    const values = [...w.values, limit];
    const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
    const text = `
      select fs.customer_id,
             max(c.email)                                                            as email,
             max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
             count(distinct fs.order_id)::int                                        as order_count,
             sum(fs.net_revenue)::numeric(14,2)                                      as total_spend
        from fact_sales fs
        left join customers c on c.id = fs.customer_id
       ${where}
       group by fs.customer_id
       order by order_count desc nulls last
       limit $${w.nextIdx}
    `;
    return { text, values, meta: { domain: 'customers' } };
  }
  const text = `
    select customer_id, email, customer_name, order_count, total_spend, last_order_at
      from dim_customer_profile
     where order_count > 0
     order by order_count desc nulls last
     limit $1
  `;
  return { text, values: [limit], meta: { domain: 'customers' } };
}

// Top spenders ranked by AVERAGE ORDER VALUE.
function topCustomersByAov(p) {
  const limit = p.limit || 10;
  const tf = p.timeframe;
  if (tf && tf.mode === 'window') {
    const w = windowFragments('fs.occurred_at', tf, 1);
    const values = [...w.values, limit];
    const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
    const text = `
      with per_order as (
        select fs.customer_id, fs.order_id, sum(fs.net_revenue) as order_total
          from fact_sales fs
         ${where}
         group by fs.customer_id, fs.order_id
      )
      select po.customer_id,
             max(c.email)                                                            as email,
             max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
             count(*)::int                                                            as order_count,
             sum(po.order_total)::numeric(14,2)                                       as total_spend,
             avg(po.order_total)::numeric(14,2)                                       as average_order_value
        from per_order po
        left join customers c on c.id = po.customer_id
       group by po.customer_id
      having count(*) >= 2
       order by average_order_value desc nulls last
       limit $${w.nextIdx}
    `;
    return { text, values, meta: { domain: 'customers' } };
  }
  const text = `
    select customer_id, email, customer_name, order_count, total_spend,
           case when order_count > 0
                then (total_spend / order_count)::numeric(14,2)
                else 0 end as average_order_value
      from dim_customer_profile
     where order_count >= 2
     order by average_order_value desc nulls last
     limit $1
  `;
  return { text, values: [limit], meta: { domain: 'customers' } };
}

// Top customers for a specific SKU.
function topCustomersBySku(p) {
  const sku = (p.sku || '').toString();
  if (!sku) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [sku, ...w.values, p.limit || 10];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.customer_id,
           max(c.email)                                                            as email,
           max(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')))  as customer_name,
           sum(fs.quantity)::int                                                   as units,
           sum(fs.net_revenue)::numeric(14,2)                                      as spend
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     where fs.sku = $1 ${where}
     group by fs.customer_id
     order by units desc, spend desc
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// Customers who bought BOTH varietal X AND varietal Y in the window.
function customersBoughtBoth(p) {
  const [vA, vB] = p.twoVarietals || ['', ''];
  if (!vA || !vB) {
    return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  }
  const w = windowFragments('fs.occurred_at', p.timeframe, 3);
  const values = [`%${vA}%`, `%${vB}%`, ...w.values, p.limit || 25];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with cust_a as (
      select distinct fs.customer_id from fact_sales fs
       where lower(fs.product_title) like lower($1) ${where}
    ),
    cust_b as (
      select distinct fs.customer_id from fact_sales fs
       where lower(fs.product_title) like lower($2) ${where}
    )
    select cust_a.customer_id,
           c.email,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           dim.total_spend, dim.order_count
      from cust_a
      join cust_b using (customer_id)
      left join customers c on c.id = cust_a.customer_id
      left join dim_customer_profile dim on dim.customer_id = cust_a.customer_id
     where cust_a.customer_id is not null
     order by dim.total_spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// Top varietals for one customer (favorite varietal proxy via title match).
function customerTopVarietals(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values, p.limit || 10];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.product_title,
           sum(fs.quantity)::int               as units,
           sum(fs.net_revenue)::numeric(14,2)  as spend,
           count(distinct fs.order_id)         as orders
      from fact_sales fs
     where fs.customer_id = $1 ${where}
     group by fs.product_title
     order by spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// One-row taste profile: favorite vendor + favorite category + typical price.
function customerTasteProfile(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const text = `
    with v as (
      select vendor, sum(net_revenue) as rev
        from fact_sales where customer_id = $1 and vendor is not null
       group by vendor order by rev desc limit 1
    ),
    t as (
      select product_title, sum(net_revenue) as rev
        from fact_sales where customer_id = $1
       group by product_title order by rev desc limit 1
    ),
    p as (
      select avg(unit_price)::numeric(12,2) as avg_unit_price,
             min(unit_price) as min_price,
             max(unit_price) as max_price
        from fact_sales where customer_id = $1
    )
    select
      (select vendor from v)         as favorite_vendor,
      (select product_title from t)  as favorite_product,
      (select avg_unit_price from p) as avg_unit_price,
      (select min_price from p)      as min_unit_price,
      (select max_price from p)      as max_unit_price,
      (select customer_name from dim_customer_profile where customer_id = $1) as customer_name,
      (select favorite_product_type from dim_customer_profile where customer_id = $1) as favorite_product_type,
      (select last_order_at from dim_customer_profile where customer_id = $1) as last_order_at
  `;
  return { text, values: [cid], meta: { domain: 'customers' } };
}

// When did the customer last shop with us?
function customerLastOrder(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const text = `
    select
      customer_id,
      customer_name,
      email,
      last_order_at,
      days_since_last_order,
      order_count,
      total_spend
    from dim_customer_profile
    where customer_id = $1
  `;
  return { text, values: [cid], meta: { domain: 'customers' } };
}

// SKU inventory snapshot for one SKU.
function skuInventory(p) {
  if (!p.sku) return { text: 'select null where false', values: [], meta: { domain: 'inventory' } };
  const text = `
    select sku, product_title, variant_title, vendor, price, on_hand,
           product_handle, product_status
      from vw_current_inventory
     where sku = $1
     order by variant_title nulls last
  `;
  return { text, values: [p.sku], meta: { domain: 'inventory' } };
}

// Average selling price for one SKU.
function skuAvgPrice(p) {
  if (!p.sku) return { text: 'select null where false', values: [], meta: { domain: 'sales' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [p.sku, ...w.values];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      $1::text                                              as sku,
      max(fs.product_title)                                 as product_title,
      count(*)::int                                         as line_items,
      sum(fs.quantity)::int                                 as units_sold,
      sum(fs.net_revenue)::numeric(14,2)                    as net_revenue,
      avg(fs.unit_price)::numeric(12,2)                     as avg_unit_price,
      min(fs.unit_price)                                    as min_unit_price,
      max(fs.unit_price)                                    as max_unit_price
      from fact_sales fs
     where fs.sku = $1 ${where}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

// When was the SKU last sold?
function skuLastSold(p) {
  if (!p.sku) return { text: 'select null where false', values: [], meta: { domain: 'sales' } };
  const text = `
    select sku, product_title, last_sold_at,
           units_sold, units_sold_30d, units_sold_90d, on_hand
      from dim_sku_profile
     where sku = $1
     limit 1
  `;
  return { text, values: [p.sku], meta: { domain: 'sales' } };
}

// Slow-movers: "sold fewer than N units in the last M days".
function slowMoving(p) {
  const slow = p.slow || { maxUnits: 3, days: 30 };
  const days = slow.days;
  const cap = slow.maxUnits;
  // dim_sku_profile gives 30d and 90d windows; if user asks for a different
  // window we approximate by running against fact_sales.
  if (days === 30) {
    const text = `
      select sku, product_title, vendor, on_hand, units_sold_30d, units_sold_90d, last_sold_at
        from dim_sku_profile
       where on_hand > 0
         and coalesce(units_sold_30d, 0) < $1
       order by units_sold_30d asc nulls first, on_hand desc
       limit $2
    `;
    return { text, values: [cap, p.limit || 25], meta: { domain: 'inventory', days } };
  }
  // General window via fact_sales.
  const sinceIso = new Date(Date.now() - days * 86400e3).toISOString();
  const text = `
    with sold as (
      select sku, sum(quantity) as units
        from fact_sales
       where occurred_at >= $1::timestamptz and sku <> ''
       group by sku
    )
    select v.sku, v.product_title, v.vendor, v.on_hand,
           coalesce(s.units, 0)::int as units_sold_window,
           v.product_status
      from vw_current_inventory v
      left join sold s on s.sku = v.sku
     where v.on_hand > 0
       and coalesce(s.units, 0) < $2
     order by units_sold_window asc, v.on_hand desc
     limit $3
  `;
  return { text, values: [sinceIso, cap, p.limit || 25], meta: { domain: 'inventory', days } };
}

// Vendors with the most dead inventory.
function vendorsDeadInventory(p) {
  const days = p.dayCount || (p.timeframe && p.timeframe.days) || 90;
  const text = `
    select coalesce(nullif(vendor,''), '(unknown)') as vendor,
           count(*)::int                            as dead_skus,
           sum(on_hand)::int                        as dead_units
      from dim_sku_profile
     where on_hand > 0
       and (last_sold_at is null or last_sold_at < now() - ($1 || ' days')::interval)
     group by 1
     order by dead_units desc nulls last
     limit $2
  `;
  return { text, values: [String(days), p.limit || 10], meta: { domain: 'vendors', days } };
}

// Vendor average selling price.
function vendorAvgSellingPrice(p) {
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 10];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(fs.vendor,''), '(unknown)') as vendor,
           sum(fs.quantity)::int                       as units,
           sum(fs.net_revenue)::numeric(14,2)          as revenue,
           case when sum(fs.quantity) > 0
                then (sum(fs.net_revenue) / sum(fs.quantity))::numeric(12,2)
                else 0 end                              as avg_selling_price
      from fact_sales fs
     ${where}
     group by 1
    having sum(fs.quantity) >= 5
     order by avg_selling_price desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'vendors' } };
}

// Vendor decline: same shape as vendorGrowth but sorted ascending so the
// biggest losers are at the top.
function vendorDecline(p) {
  // Reuse the vendorGrowth shape so the formatter doesn't need to branch.
  let tf = p.timeframe;
  if (!tf || tf.mode !== 'window') {
    const now = new Date();
    tf = {
      mode: 'window',
      sinceIso: new Date(now - 30 * 86400e3).toISOString(),
      untilIso: now.toISOString(),
      days: 30,
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
     where coalesce(prev.revenue, 0) > 0
     order by revenue_delta asc nulls last
     limit $5
  `;
  return {
    text,
    values: [tf.sinceIso, tf.untilIso, priorSince, priorUntil, p.limit || 10],
    meta: { domain: 'vendors', window_current: { sinceIso: tf.sinceIso, untilIso: tf.untilIso }, window_previous: { sinceIso: priorSince, untilIso: priorUntil } },
  };
}

// ---------------------------------------------------------------------------
// Time-series builders (grain = day / week / month)
// ---------------------------------------------------------------------------

function grainToTrunc(grain) {
  return { day: 'day', week: 'week', month: 'month' }[grain] || 'day';
}

function salesTimeSeries(p) {
  // Default window: last week when nothing else parsed.
  const grain = grainToTrunc(p.grain || (p.timeframe && p.timeframe.seriesGrain) || 'day');
  let tf = p.timeframe;
  if (!tf || tf.mode === 'all_time') {
    const now = new Date();
    tf = {
      mode: 'window',
      sinceIso: new Date(now - 7 * 86400e3).toISOString(),
      untilIso: now.toISOString(),
      label: 'last 7 days (default)',
      days: 7,
    };
  }
  const w = windowFragments('occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      date_trunc('${grain}', occurred_at)             as bucket,
      count(distinct order_id)::int                   as orders,
      coalesce(sum(quantity), 0)::int                 as units,
      coalesce(sum(net_revenue), 0)::numeric(14,2)    as net_revenue,
      case when count(distinct order_id) > 0
           then (sum(net_revenue) / count(distinct order_id))::numeric(14,2)
           else 0 end                                  as average_order_value
      from fact_sales
     ${where}
     group by bucket
     order by bucket asc
  `;
  return { text, values: w.values, meta: { domain: 'revenue', grain, timeframe: tf } };
}

// ---------------------------------------------------------------------------
// Customer units bought (lifetime or windowed quantity)
// ---------------------------------------------------------------------------

function customerUnitsBought(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) {
    return { text: `select 0::int as units, 0::int as order_count`, values: [], meta: { domain: 'customers' } };
  }
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      $1::bigint                                  as customer_id,
      coalesce(sum(fs.quantity), 0)::int          as units,
      count(distinct fs.order_id)::int            as order_count,
      coalesce(sum(fs.net_revenue), 0)::numeric(14,2) as total_spend,
      min(fs.occurred_at)                         as first_order_at,
      max(fs.occurred_at)                         as last_order_at
      from fact_sales fs
     where fs.customer_id = $1 ${where}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// ---------------------------------------------------------------------------
// Inventory value (retail). Cost-based value is not supported by the
// currently-synced schema (variants/inventory_levels_current have no cost
// column). Builders below say so explicitly via meta.has_cost_data: false.
// ---------------------------------------------------------------------------

function inventoryValueTotal(p) {
  const filters = [`v.on_hand > 0`, `coalesce(v.product_status, 'active') = 'active'`];
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
  if (p.category) {
    values.push(`%${p.category}%`);
    filters.push(`(lower(v.product_type) like lower($${i}) or lower(v.product_title) like lower($${i}))`);
    i++;
  }
  const where = `where ${filters.join(' and ')}`;
  const text = `
    select
      coalesce(sum(v.on_hand * v.price), 0)::numeric(14,2) as retail_value,
      coalesce(sum(v.on_hand), 0)::int                     as on_hand_units,
      count(*)::int                                        as sku_count
      from vw_current_inventory v
     ${where}
  `;
  return { text, values, meta: { domain: 'inventory', valuation: 'retail', has_cost_data: false } };
}

function inventoryValueByVendor(p) {
  const filters = [`v.on_hand > 0`, `coalesce(v.product_status, 'active') = 'active'`];
  const values = [];
  let i = 1;
  if (p.color) {
    values.push(`%${p.color}%`);
    filters.push(`lower(v.product_title) like lower($${i++})`);
  }
  values.push(p.limit || 25);
  const where = `where ${filters.join(' and ')}`;
  const text = `
    select coalesce(nullif(v.vendor,''), '(unknown)') as vendor,
           coalesce(sum(v.on_hand * v.price), 0)::numeric(14,2) as retail_value,
           coalesce(sum(v.on_hand), 0)::int          as on_hand_units,
           count(*)::int                              as sku_count
      from vw_current_inventory v
     ${where}
     group by 1
     order by retail_value desc nulls last
     limit $${i}
  `;
  return { text, values, meta: { domain: 'inventory', valuation: 'retail', has_cost_data: false } };
}

function inventoryValueByCategory(p) {
  const text = `
    select coalesce(nullif(v.product_type,''), '(unknown)') as category,
           coalesce(sum(v.on_hand * v.price), 0)::numeric(14,2) as retail_value,
           coalesce(sum(v.on_hand), 0)::int                     as on_hand_units,
           count(*)::int                                         as sku_count
      from vw_current_inventory v
     where v.on_hand > 0
       and coalesce(v.product_status, 'active') = 'active'
     group by 1
     order by retail_value desc nulls last
     limit $1
  `;
  return { text, values: [p.limit || 25], meta: { domain: 'inventory', valuation: 'retail', has_cost_data: false } };
}

function inventoryValueDead(p) {
  const days = p.dayCount || (p.timeframe && p.timeframe.days) || 90;
  const text = `
    select
      coalesce(sum(d.on_hand * v.price), 0)::numeric(14,2) as retail_value,
      coalesce(sum(d.on_hand), 0)::int                      as on_hand_units,
      count(*)::int                                          as sku_count
      from dim_sku_profile d
      join vw_current_inventory v on v.sku = d.sku
     where d.on_hand > 0
       and (d.last_sold_at is null or d.last_sold_at < now() - ($1 || ' days')::interval)
  `;
  return { text, values: [String(days)], meta: { domain: 'inventory', valuation: 'retail', has_cost_data: false, days } };
}

function inventoryValueLowStock(p) {
  const threshold = (p.unitsBelow && p.unitsBelow.value) || (p.money && p.money.value) || 6;
  const text = `
    select
      coalesce(sum(v.on_hand * v.price), 0)::numeric(14,2) as retail_value,
      coalesce(sum(v.on_hand), 0)::int                     as on_hand_units,
      count(*)::int                                        as sku_count
      from vw_current_inventory v
     where v.on_hand > 0
       and v.on_hand <= $1
       and coalesce(v.product_status, 'active') = 'active'
  `;
  return { text, values: [threshold], meta: { domain: 'inventory', valuation: 'retail', has_cost_data: false, threshold } };
}

// ---------------------------------------------------------------------------
// Inventory counts (distinct product/sku counts)
// ---------------------------------------------------------------------------

function inventoryCountInStock(p) {
  const filters = [`v.on_hand > 0`, `coalesce(v.product_status, 'active') = 'active'`];
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
  if (p.category) {
    values.push(`%${p.category}%`);
    filters.push(`(lower(v.product_type) like lower($${i}) or lower(v.product_title) like lower($${i}))`);
    i++;
  }
  const where = `where ${filters.join(' and ')}`;
  const text = `
    select
      count(distinct v.product_id)::int as product_count,
      count(*)::int                     as sku_count,
      coalesce(sum(v.on_hand), 0)::int  as on_hand_units
      from vw_current_inventory v
     ${where}
  `;
  return { text, values, meta: { domain: 'inventory' } };
}

function inventoryCountOutOfStock() {
  const text = `
    select
      count(distinct v.product_id)::int as product_count,
      count(*)::int                     as sku_count
      from vw_current_inventory v
     where v.on_hand <= 0
       and coalesce(v.product_status, 'active') = 'active'
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

function inventoryCountLowStock(p) {
  const threshold = (p.unitsBelow && p.unitsBelow.value) || (p.money && p.money.value) || 6;
  const text = `
    select
      count(distinct v.product_id)::int as product_count,
      count(*)::int                     as sku_count,
      $1::int                           as threshold
      from vw_current_inventory v
     where v.on_hand > 0
       and v.on_hand <= $1
       and coalesce(v.product_status, 'active') = 'active'
  `;
  return { text, values: [threshold], meta: { domain: 'inventory' } };
}

function inventoryCountThreshold(p) {
  // "more than N" / "fewer than N" / "between A and B".
  const m = p.money || p.unitsBelow;
  if (!m) {
    return inventoryCountInStock(p);
  }
  let cond;
  const values = [];
  if (m.op === '<')      { cond = `v.on_hand < $1`;             values.push(m.value); }
  else if (m.op === '>') { cond = `v.on_hand > $1`;             values.push(m.value); }
  else if (m.op === 'between') { cond = `v.on_hand between $1 and $2`; values.push(m.min, m.max); }
  else                   { cond = `v.on_hand > 0`; }
  const text = `
    select
      count(distinct v.product_id)::int as product_count,
      count(*)::int                     as sku_count
      from vw_current_inventory v
     where coalesce(v.product_status, 'active') = 'active'
       and ${cond}
  `;
  return { text, values, meta: { domain: 'inventory', condition: m } };
}

function inventoryUnitsOnHand(p) {
  const filters = [`v.on_hand > 0`, `coalesce(v.product_status, 'active') = 'active'`];
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
  if (p.category) {
    values.push(`%${p.category}%`);
    filters.push(`(lower(v.product_type) like lower($${i}) or lower(v.product_title) like lower($${i}))`);
    i++;
  }
  const where = `where ${filters.join(' and ')}`;
  const text = `
    select
      coalesce(sum(v.on_hand), 0)::int  as on_hand_units,
      count(distinct v.product_id)::int as product_count,
      count(*)::int                     as sku_count
      from vw_current_inventory v
     ${where}
  `;
  return { text, values, meta: { domain: 'inventory' } };
}

// ---------------------------------------------------------------------------
// Data coverage / metadata
// ---------------------------------------------------------------------------

function dataCoverageOrders() {
  const text = `
    select
      min(coalesce(processed_at, created_at)) as earliest_order_at,
      max(coalesce(processed_at, created_at)) as latest_order_at,
      count(*)::int                            as total_orders,
      count(*) filter (where cancelled_at is null)::int as active_orders
      from orders
  `;
  return { text, values: [], meta: { domain: 'meta', resource: 'orders' } };
}

function dataCoverageCustomers() {
  const text = `
    select
      count(*)::int                                         as total_customers,
      count(*) filter (where orders_count > 0)::int         as customers_with_orders,
      min(created_at)                                       as earliest_customer_at,
      max(created_at)                                       as latest_customer_at
      from customers
  `;
  return { text, values: [], meta: { domain: 'meta', resource: 'customers' } };
}

function dataCoverageProducts() {
  const text = `
    select
      (select count(*) from products)                                as total_products,
      (select count(*) from products where status = 'active')        as active_products,
      (select count(*) from variants)                                as total_variants,
      (select count(distinct product_id) from vw_current_inventory
        where on_hand > 0)                                           as products_in_stock
  `;
  return { text, values: [], meta: { domain: 'meta', resource: 'products' } };
}

function dataCoverageAll() {
  // One row combining the three resources.
  const text = `
    select
      (select min(coalesce(processed_at, created_at)) from orders) as earliest_order_at,
      (select max(coalesce(processed_at, created_at)) from orders) as latest_order_at,
      (select count(*) from orders)::int                            as total_orders,
      (select count(*) from customers)::int                         as total_customers,
      (select count(*) from products)::int                          as total_products,
      (select count(*) from variants)::int                          as total_variants,
      (select count(distinct product_id) from vw_current_inventory where on_hand > 0)::int as products_in_stock
  `;
  return { text, values: [], meta: { domain: 'meta', resource: 'all' } };
}

// ---------------------------------------------------------------------------
// Product detail search — when the user gives a fuzzy hint and we already
// resolved it via resolver.resolveProductByHint, the engine attaches the
// candidate(s) to plan.resolved.product. If resolved.product is a single
// row we re-use productDetail() so the answer is unified.
// ---------------------------------------------------------------------------
function productDetailSearch(p) {
  return productDetail(p);
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
  topCustomersByOrderCount,
  topCustomersByAov,
  topCustomersBySku,
  customersBoughtBoth,
  customerTopVarietals,
  customerTasteProfile,
  customerLastOrder,
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
  vendorDecline,
  vendorAvgSellingPrice,
  vendorsDeadInventory,
  categoryPerformance,
  varietalPerformance,
  periodOverPeriod,
  trendingUp,
  trendingDown,
  recentOrders,
  salesSummary,
  skuInventory,
  skuAvgPrice,
  skuLastSold,
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
  slowMoving,
  // time-series
  salesTimeSeries,
  // customer units bought
  customerUnitsBought,
  // inventory value
  inventoryValueTotal,
  inventoryValueByVendor,
  inventoryValueByCategory,
  inventoryValueDead,
  inventoryValueLowStock,
  // inventory counts
  inventoryCountInStock,
  inventoryCountOutOfStock,
  inventoryCountLowStock,
  inventoryCountThreshold,
  inventoryUnitsOnHand,
  // data coverage
  dataCoverageOrders,
  dataCoverageCustomers,
  dataCoverageProducts,
  dataCoverageAll,
  // product detail search wrapper
  productDetailSearch,
};
