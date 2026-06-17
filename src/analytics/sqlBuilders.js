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

// ===========================================================================
// LANGUAGE-EXPANSION v4 builders (smartness pass)
// ===========================================================================

// --- Repeat / new customers (counts and shares) ---------------------------
//
// A customer is "new" in window W if their first-ever purchase falls inside W.
// A customer is "repeat" in W if they bought in W AND had at least one
// earlier order before W.
// Denominator for shares: distinct purchasing customers in W.

function _repeatNewSqlCommon(tf) {
  // Returns shared CTE + WHERE bindings for one window.
  const w = windowFragments('fs.occurred_at', tf, 1);
  return {
    fragments: w.fragments,
    values: w.values,
    nextIdx: w.nextIdx,
    whereWindow: w.fragments.length ? `where ${w.fragments.join(' and ')}` : '',
  };
}

function repeatCustomersCount(p) {
  const tf = p.timeframe;
  const w = _repeatNewSqlCommon(tf);
  const text = `
    with in_window as (
      select distinct fs.customer_id
        from fact_sales fs
       ${w.whereWindow}
         ${w.fragments.length ? 'and' : 'where'} fs.customer_id is not null
    ),
    earliest as (
      select customer_id, min(occurred_at) as first_seen
        from fact_sales
       where customer_id is not null
       group by customer_id
    )
    select
      count(distinct e.customer_id) filter (where ${tf && tf.sinceIso ? `e.first_seen < $${w.nextIdx}` : 'false'})::int as repeat_customers,
      count(distinct iw.customer_id)::int as purchasing_customers
    from in_window iw
    left join earliest e on e.customer_id = iw.customer_id
  `;
  const values = [...w.values];
  if (tf && tf.sinceIso) values.push(tf.sinceIso);
  return { text, values, meta: { domain: 'customers', segment: 'repeat' } };
}

function newCustomersCount(p) {
  const tf = p.timeframe;
  const w = _repeatNewSqlCommon(tf);
  const text = `
    with in_window as (
      select distinct fs.customer_id
        from fact_sales fs
       ${w.whereWindow}
         ${w.fragments.length ? 'and' : 'where'} fs.customer_id is not null
    ),
    earliest as (
      select customer_id, min(occurred_at) as first_seen
        from fact_sales
       where customer_id is not null
       group by customer_id
    )
    select
      count(distinct e.customer_id) filter (where ${tf && tf.sinceIso ? `e.first_seen >= $${w.nextIdx}` : 'false'})::int as new_customers,
      count(distinct iw.customer_id)::int as purchasing_customers
    from in_window iw
    left join earliest e on e.customer_id = iw.customer_id
  `;
  const values = [...w.values];
  if (tf && tf.sinceIso) values.push(tf.sinceIso);
  return { text, values, meta: { domain: 'customers', segment: 'new' } };
}

// Share = same SQL, formatter computes percent from row.
function repeatCustomersShare(p) { return repeatCustomersCount(p); }
function newCustomersShare(p)    { return newCustomersCount(p); }

// --- Distinct purchasing customers in a window ----------------------------
function customersCountPurchasing(p) {
  const tf = p.timeframe;
  const w = windowFragments('fs.occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(distinct fs.customer_id)::int as purchasing_customers,
      count(distinct fs.order_id)::int    as orders,
      coalesce(sum(fs.net_revenue), 0)::numeric(14,2) as net_revenue
      from fact_sales fs
     ${where}
       ${w.fragments.length ? 'and' : 'where'} fs.customer_id is not null
  `;
  return { text, values: w.values, meta: { domain: 'customers' } };
}

// --- Busiest hour (single window) and average busiest pattern -------------
function busiestHour(p) {
  const tf = (p.timeframe && p.timeframe.mode !== 'all_time')
    ? p.timeframe
    : { mode: 'window', sinceIso: new Date(Date.now() - 86400e3).toISOString(), untilIso: new Date().toISOString(), label: 'yesterday' };
  const w = windowFragments('occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      date_part('hour', occurred_at)::int      as hour_of_day,
      count(distinct order_id)::int            as orders,
      coalesce(sum(quantity), 0)::int          as units,
      coalesce(sum(net_revenue), 0)::numeric(14,2) as net_revenue
      from fact_sales
     ${where}
     group by 1
     order by orders desc, net_revenue desc
     limit 24
  `;
  return { text, values: w.values, meta: { domain: 'orders', timeframe: tf } };
}

function busiestPeriodPattern() {
  // Average orders per hour of day × day of week across the last 12 weeks.
  const text = `
    with recent as (
      select * from fact_sales
       where occurred_at >= now() - interval '84 days'
    )
    select
      to_char(occurred_at, 'Dy')::text          as day_of_week,
      date_part('dow', occurred_at)::int        as dow_idx,
      date_part('hour', occurred_at)::int       as hour_of_day,
      count(distinct order_id)::int             as orders,
      coalesce(sum(net_revenue), 0)::numeric(14,2) as net_revenue
      from recent
     group by 1, 2, 3
     order by orders desc, net_revenue desc
     limit 50
  `;
  return { text, values: [], meta: { domain: 'orders' } };
}

// --- Price extremes -------------------------------------------------------
function highestPricedItemSold(p) {
  const tf = p.timeframe;
  const w = windowFragments('fs.occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const values = [...w.values, p.limit || 5];
  const text = `
    select fs.sku, fs.product_title, fs.variant_title, fs.unit_price,
           fs.quantity, fs.occurred_at, fs.order_name,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email as customer_email
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     ${where}
       ${w.fragments.length ? 'and' : 'where'} fs.unit_price is not null
     order by fs.unit_price desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function lowestPricedItemSold(p) {
  const tf = p.timeframe;
  const w = windowFragments('fs.occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const values = [...w.values, p.limit || 5];
  const text = `
    select fs.sku, fs.product_title, fs.variant_title, fs.unit_price,
           fs.quantity, fs.occurred_at, fs.order_name,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email as customer_email
      from fact_sales fs
      left join customers c on c.id = fs.customer_id
     ${where}
       ${w.fragments.length ? 'and' : 'where'} fs.unit_price is not null
       and fs.unit_price > 0
     order by fs.unit_price asc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function buyerOfHighestPricedItem(p) { return highestPricedItemSold(p); }
function buyerOfLowestPricedItem(p)  { return lowestPricedItemSold(p); }

// --- Customer top products / vendors / categories (one customer) ----------
function customerTopProducts(p) {
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
     order by units desc nulls last, spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function customerTopVendors(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values, p.limit || 10];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(fs.vendor,''), '(unknown)') as vendor,
           sum(fs.quantity)::int               as units,
           sum(fs.net_revenue)::numeric(14,2)  as spend,
           count(distinct fs.order_id)         as orders
      from fact_sales fs
     where fs.customer_id = $1 ${where}
     group by 1
     order by spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

function customerTopCategories(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values, p.limit || 10];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(p.product_type,''), '(unknown)') as category,
           sum(fs.quantity)::int                            as units,
           sum(fs.net_revenue)::numeric(14,2)               as spend,
           count(distinct fs.order_id)                       as orders
      from fact_sales fs
      left join products p on p.id = fs.product_id
     where fs.customer_id = $1 ${where}
     group by 1
     order by spend desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// --- Customer cadence -----------------------------------------------------
function customerFrequencyProfile(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const text = `
    with orders_per as (
      select customer_id, order_id, min(occurred_at) as occurred_at
        from fact_sales
       where customer_id = $1
       group by customer_id, order_id
    ),
    spans as (
      select customer_id,
             count(*)::int                                                  as order_count,
             min(occurred_at)                                               as first_order_at,
             max(occurred_at)                                               as last_order_at,
             extract(epoch from (max(occurred_at) - min(occurred_at)))/86400 as window_days
        from orders_per
       group by customer_id
    )
    select
      customer_id,
      order_count,
      first_order_at,
      last_order_at,
      window_days::int                                                       as span_days,
      case when order_count > 1 and window_days > 0
           then round((window_days::numeric / (order_count - 1)), 1)
           else null end                                                     as avg_days_between_orders,
      (extract(epoch from (now() - last_order_at)) / 86400)::int             as days_since_last_order
    from spans
  `;
  return { text, values: [cid], meta: { domain: 'customers' } };
}

// --- Lapsed-but-formerly-frequent customers --------------------------------
function lapsedFrequentCustomers(p) {
  const minOrders = 4;
  const minDays = p.lapsedDays || 60;
  const text = `
    select customer_id, email, customer_name,
           order_count, total_spend, last_order_at, days_since_last_order,
           favorite_vendor, favorite_product_type
      from dim_customer_profile
     where order_count >= $1
       and days_since_last_order >= $2
       and total_spend > 0
     order by total_spend desc nulls last
     limit $3
  `;
  return { text, values: [minOrders, minDays, p.limit || 25], meta: { domain: 'customers', min_orders: minOrders, min_days: minDays } };
}

function customerReactivationCandidates(p) {
  // Customers who recently came back after >= 180 days inactive.
  const reactivationGap = 180;
  const recentWindow = 30;
  const text = `
    with last_two as (
      select customer_id,
             max(occurred_at) as last_at,
             (
               select max(occurred_at)
                 from fact_sales fs2
                where fs2.customer_id = fact_sales.customer_id
                  and fs2.occurred_at < (
                    select max(occurred_at)
                      from fact_sales fs3
                     where fs3.customer_id = fact_sales.customer_id
                  )
             ) as prev_at
        from fact_sales
       where customer_id is not null
       group by customer_id
    )
    select lt.customer_id,
           c.email,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           lt.last_at, lt.prev_at,
           extract(epoch from (lt.last_at - lt.prev_at))/86400 as gap_days
      from last_two lt
      left join customers c on c.id = lt.customer_id
     where lt.last_at >= now() - ($1 || ' days')::interval
       and lt.prev_at is not null
       and lt.last_at - lt.prev_at >= ($2 || ' days')::interval
     order by lt.last_at desc
     limit $3
  `;
  return { text, values: [String(recentWindow), String(reactivationGap), p.limit || 25], meta: { domain: 'customers' } };
}

// --- Type / category / varietal breakdowns -------------------------------
function typeTopSeller(p) {
  // Returns the single best-selling product_type in the window, but also
  // returns the full ranked list so the formatter / table can present it.
  return typeBreakdown(p);
}

function typeBreakdown(p) {
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 10];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(p.product_type,''), '(unknown)') as type,
           sum(fs.quantity)::int                            as units,
           sum(fs.net_revenue)::numeric(14,2)               as revenue,
           count(distinct fs.order_id)                       as orders
      from fact_sales fs
      left join products p on p.id = fs.product_id
     ${where}
     group by 1
     order by units desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'sales', group_by: 'product_type' } };
}

function varietalRanking(p) {
  // Group by product_title tokens — proxy varietal extraction is too lossy,
  // so we group by full product_title (close enough at store level) when no
  // dedicated varietal column exists. Top items by units within window.
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values, p.limit || 10];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.product_title                                  as varietal,
           sum(fs.quantity)::int                              as units,
           sum(fs.net_revenue)::numeric(14,2)                 as revenue,
           count(distinct fs.customer_id)                     as customers
      from fact_sales fs
     ${where}
     group by 1
     order by units desc nulls last
     limit $${w.nextIdx}
  `;
  return { text, values, meta: { domain: 'sales', group_by: 'product_title' } };
}

// --- Share / mix percentages ---------------------------------------------
function shareOfSalesByFilter(p) {
  // numerator = sum where filter matches; denominator = total.
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values];
  let i = w.nextIdx;
  // Build the matching filter on the same fact_sales row.
  const matchers = [];
  if (p.color)    { values.push(`%${p.color}%`);    matchers.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.varietal) { values.push(`%${p.varietal}%`); matchers.push(`lower(fs.product_title) like lower($${i++})`); }
  if (p.vendor)   { values.push(`%${p.vendor}%`);   matchers.push(`lower(fs.vendor) like lower($${i++})`); }
  if (p.category) { values.push(`%${p.category}%`); matchers.push(`(lower(fs.product_title) like lower($${i}) or lower(fs.variant_title) like lower($${i}))`); i++; }
  if (!matchers.length) {
    // Nothing to filter by → degenerate, returns 100%.
    matchers.push('true');
  }
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      coalesce(sum(case when ${matchers.join(' and ')} then fs.net_revenue end), 0)::numeric(14,2) as numerator,
      coalesce(sum(fs.net_revenue), 0)::numeric(14,2)                                              as denominator,
      coalesce(sum(case when ${matchers.join(' and ')} then fs.quantity end), 0)::int              as units_numerator,
      coalesce(sum(fs.quantity), 0)::int                                                            as units_denominator
      from fact_sales fs
     ${where}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function shareOfRevenueTopN(p) {
  const n = p.limit || 10;
  const w = windowFragments('fs.occurred_at', p.timeframe, 1);
  const values = [...w.values, n];
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    with totals as (
      select coalesce(sum(net_revenue), 0)::numeric(14,2) as total_revenue
        from fact_sales ${where}
    ),
    ranked as (
      select fs.product_id, max(fs.product_title) as product_title,
             sum(fs.net_revenue) as revenue
        from fact_sales fs ${where}
       group by fs.product_id
       order by revenue desc nulls last
       limit $${w.nextIdx}
    )
    select
      (select total_revenue from totals)                            as denominator,
      coalesce(sum(r.revenue), 0)::numeric(14,2)                     as numerator,
      $${w.nextIdx}::int                                              as top_n,
      array_agg(r.product_title order by r.revenue desc)              as top_products
      from ranked r
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function shareOfDeadInventoryValue(p) {
  const days = p.dayCount || 90;
  const text = `
    with totals as (
      select coalesce(sum(v.on_hand * v.price), 0)::numeric(14,2) as total_retail
        from vw_current_inventory v
       where v.on_hand > 0
         and coalesce(v.product_status, 'active') = 'active'
    ),
    dead as (
      select coalesce(sum(d.on_hand * v.price), 0)::numeric(14,2) as dead_retail
        from dim_sku_profile d
        join vw_current_inventory v on v.sku = d.sku
       where d.on_hand > 0
         and (d.last_sold_at is null or d.last_sold_at < now() - ($1 || ' days')::interval)
    )
    select
      (select dead_retail from dead)        as numerator,
      (select total_retail from totals)      as denominator
  `;
  return { text, values: [String(days)], meta: { domain: 'inventory', days } };
}

function shareOfOrdersWithFilter(p) {
  // "what percentage of orders included gift items"
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const values = [...w.values];
  let i = w.nextIdx;
  let matcher = 'false';
  if (p.color)    { values.push(`%${p.color}%`);    matcher = `lower(oli.title) like lower($${i++})`; }
  else if (p.varietal) { values.push(`%${p.varietal}%`); matcher = `lower(oli.title) like lower($${i++})`; }
  else if (p.category) { values.push(`%${p.category}%`); matcher = `(lower(oli.title) like lower($${i}) or lower(oli.variant_title) like lower($${i}))`; i++; }
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(distinct o.id) filter (where exists (
        select 1 from order_line_items oli
         where oli.order_id = o.id and ${matcher}
      ))::int                                              as numerator,
      count(distinct o.id)::int                            as denominator
      from orders o
     ${where}
       ${w.fragments.length ? 'and' : 'where'} o.cancelled_at is null
  `;
  return { text, values, meta: { domain: 'orders' } };
}

// --- Dashboard summary (multi-metric bundle) ------------------------------
function dashboardSummary(p) {
  // Returns a single row with multiple aggregates plus separate rows for
  // top products / top vendors so the formatter can stitch them together.
  const tf = (p.timeframe && p.timeframe.mode !== 'all_time')
    ? p.timeframe
    : { mode: 'window', sinceIso: new Date(Date.now() - 7 * 86400e3).toISOString(), untilIso: new Date().toISOString(), label: 'last 7 days (default)' };
  const w = windowFragments('fs.occurred_at', tf, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  // Two parallel queries are easier than one giant CTE — but we keep it in
  // a single statement using UNION ALL of typed rows so engine code stays
  // simple. Each row has a `bucket` column distinguishing the section.
  const text = `
    select 'kpi'::text as bucket,
           null::text  as label,
           coalesce(sum(fs.net_revenue), 0)::numeric(14,2)            as revenue,
           coalesce(sum(fs.quantity), 0)::int                         as units,
           count(distinct fs.order_id)::int                           as orders,
           count(distinct fs.customer_id)::int                        as customers,
           case when count(distinct fs.order_id) > 0
                then (sum(fs.net_revenue) / count(distinct fs.order_id))::numeric(14,2)
                else 0 end                                             as aov
      from fact_sales fs
     ${where}
    union all
    select 'top_product',
           x.product_title,
           x.revenue, x.units, x.orders, null::int, null::numeric
      from (
        select fs.product_title,
               sum(fs.net_revenue)::numeric(14,2) as revenue,
               sum(fs.quantity)::int              as units,
               count(distinct fs.order_id)::int   as orders
          from fact_sales fs
         ${where}
         group by fs.product_title
         order by revenue desc nulls last
         limit 5
      ) x
    union all
    select 'top_vendor',
           coalesce(nullif(fs.vendor,''), '(unknown)'),
           sum(fs.net_revenue)::numeric(14,2),
           sum(fs.quantity)::int,
           count(distinct fs.order_id)::int,
           null::int, null::numeric
      from fact_sales fs
     ${where}
     group by 2
     order by 3 desc nulls last
     limit 5
  `;
  // The third arm reuses the same window twice — fragment indices are
  // already $1/$2-style, but `union all` requires all branches to have the
  // same parameter list. Postgres handles this fine because each occurrence
  // of $N refers to the same value.
  // Bind values: window appears three times → pad accordingly. With the
  // simple windowFragments approach we already use $1/$2 for the window.
  // Postgres allows re-using parameters in different branches.
  return { text, values: w.values, meta: { domain: 'dashboard', timeframe: tf } };
}

// ===========================================================================
// LANGUAGE-EXPANSION v5: CRM, order drill-down, customer comparisons,
// customer change-over-time, overlap shares.
// ===========================================================================

// --- Order drill-down -----------------------------------------------------
//
// All builders assume resolveOrder() already populated plan.resolved.order
// (single row from `orders`). They DO NOT use any user-supplied id directly
// inside the SQL text — only as a $N parameter.

function orderDetail(p) {
  const oid = p.resolved && p.resolved.order && p.resolved.order.order_id;
  if (!oid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const text = `
    select o.id as order_id, o.name, o.customer_id, o.email,
           coalesce(o.processed_at, o.created_at) as occurred_at,
           o.cancelled_at, o.closed_at,
           o.financial_status, o.fulfillment_status, o.currency,
           o.subtotal_price, o.total_discounts, o.total_tax, o.total_price,
           o.total_line_items_price, o.source_name, o.tags,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           (select count(*) from order_line_items oli where oli.order_id = o.id)::int as line_item_count,
           (select coalesce(sum(quantity), 0) from order_line_items oli where oli.order_id = o.id)::int as total_units
      from orders o
      left join customers c on c.id = o.customer_id
     where o.id = $1
     limit 1
  `;
  return { text, values: [oid], meta: { domain: 'orders' } };
}

function orderItems(p) {
  const oid = p.resolved && p.resolved.order && p.resolved.order.order_id;
  if (!oid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const text = `
    select oli.id as line_item_id,
           oli.sku, oli.title as product_title, oli.variant_title,
           oli.vendor, oli.quantity, oli.price as unit_price,
           coalesce(oli.total_discount, 0)::numeric(12,2) as line_discount,
           (oli.quantity * oli.price)::numeric(14,2)       as line_total,
           p.product_type
      from order_line_items oli
      left join products p on p.id = oli.product_id
     where oli.order_id = $1
     order by oli.id asc
  `;
  return { text, values: [oid], meta: { domain: 'orders' } };
}

function orderExtremeItem(p) {
  // Most-expensive (default) or cheapest line item ON one specific order.
  const oid = p.resolved && p.resolved.order && p.resolved.order.order_id;
  if (!oid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const direction = (p.extremeDirection === 'low') ? 'asc' : 'desc';
  const text = `
    select oli.sku, oli.title as product_title, oli.variant_title, oli.vendor,
           oli.quantity, oli.price as unit_price,
           (oli.quantity * oli.price)::numeric(14,2) as line_total
      from order_line_items oli
     where oli.order_id = $1
       and oli.price is not null
     order by oli.price ${direction} nulls last
     limit 5
  `;
  return { text, values: [oid], meta: { domain: 'orders' } };
}

// "Did order X include liquor / wine / both?" — runs the category match
// against the order's line items.
function orderIncludesCategory(p) {
  const oid = p.resolved && p.resolved.order && p.resolved.order.order_id;
  if (!oid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const cats = Array.isArray(p.includeCategories) ? p.includeCategories : [p.category || 'wine'];
  // Build a series of EXISTS(...) tests, one per category.
  const values = [oid];
  let i = 2;
  const selectExprs = cats.map((c) => {
    values.push(`%${c}%`);
    const idx = i++;
    // Match against title/variant_title/product_type.
    return `exists (select 1 from order_line_items x left join products p on p.id = x.product_id
                    where x.order_id = $1
                      and (lower(x.title) like lower($${idx})
                        or lower(x.variant_title) like lower($${idx})
                        or lower(coalesce(p.product_type,'')) like lower($${idx})))
            as has_${c.replace(/[^a-z0-9]+/gi, '_')}`;
  });
  const text = `select ${selectExprs.join(', ')}`;
  return { text, values, meta: { domain: 'orders', categories: cats } };
}

// --- Customer-side drill-down ---------------------------------------------

function customerLastOrderItems(p) {
  // The LAST order for the resolved customer, plus its line items, in one
  // statement returned as two-row-shape: first row {bucket:'order',...},
  // followed by N rows {bucket:'line',...}.
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const text = `
    with latest as (
      select o.id as order_id, o.name, o.customer_id,
             coalesce(o.processed_at, o.created_at) as occurred_at,
             o.total_price, o.cancelled_at, o.financial_status, o.fulfillment_status
        from orders o
       where o.customer_id = $1
         and o.cancelled_at is null
       order by coalesce(o.processed_at, o.created_at) desc
       limit 1
    )
    select 'order'::text as bucket,
           latest.order_id, latest.name as order_name, latest.occurred_at,
           latest.total_price::numeric(14,2) as total_price,
           latest.financial_status, latest.fulfillment_status,
           null::text as sku, null::text as product_title, null::text as variant_title,
           null::int  as quantity, null::numeric(12,2) as unit_price
      from latest
    union all
    select 'line', latest.order_id, latest.name, null,
           null, null, null,
           oli.sku, oli.title, oli.variant_title,
           oli.quantity, oli.price
      from latest
      join order_line_items oli on oli.order_id = latest.order_id
     order by bucket desc, quantity desc nulls last
  `;
  return { text, values: [cid], meta: { domain: 'orders' } };
}

function customerLastNOrders(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'orders' } };
  const limit = p.limit || 5;
  const text = `
    select o.id as order_id, o.name, coalesce(o.processed_at, o.created_at) as occurred_at,
           o.total_price::numeric(14,2) as total_price,
           o.financial_status, o.fulfillment_status,
           (select count(*) from order_line_items oli where oli.order_id = o.id)::int as line_items
      from orders o
     where o.customer_id = $1
       and o.cancelled_at is null
     order by coalesce(o.processed_at, o.created_at) desc
     limit $2
  `;
  return { text, values: [cid, limit], meta: { domain: 'orders' } };
}

// --- Customer comparison (multi-metric, two customers) --------------------
function customerComparison(p) {
  const pair = p.resolved && p.resolved.customerPair;
  if (!pair || !pair.left || !pair.right) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const a = pair.left.customer_id;
  const b = pair.right.customer_id;
  const w = windowFragments('fs.occurred_at', p.timeframe, 3);
  const values = [a, b, ...w.values];
  const wFrag = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      $1::bigint as customer_id,
      'A'::text  as side,
      coalesce(sum(case when fs.customer_id = $1 then fs.net_revenue end), 0)::numeric(14,2) as total_spend,
      coalesce(sum(case when fs.customer_id = $1 then fs.quantity end), 0)::int              as units,
      count(distinct case when fs.customer_id = $1 then fs.order_id end)::int                as order_count,
      case when count(distinct case when fs.customer_id = $1 then fs.order_id end) > 0
           then (sum(case when fs.customer_id = $1 then fs.net_revenue end)
                 / count(distinct case when fs.customer_id = $1 then fs.order_id end))::numeric(14,2)
           else 0 end                                                                          as average_order_value,
      min(case when fs.customer_id = $1 then fs.occurred_at end) as first_order_at,
      max(case when fs.customer_id = $1 then fs.occurred_at end) as last_order_at
      from fact_sales fs
     where (fs.customer_id = $1 or fs.customer_id = $2) ${wFrag}
    union all
    select
      $2::bigint,
      'B',
      coalesce(sum(case when fs.customer_id = $2 then fs.net_revenue end), 0)::numeric(14,2),
      coalesce(sum(case when fs.customer_id = $2 then fs.quantity end), 0)::int,
      count(distinct case when fs.customer_id = $2 then fs.order_id end)::int,
      case when count(distinct case when fs.customer_id = $2 then fs.order_id end) > 0
           then (sum(case when fs.customer_id = $2 then fs.net_revenue end)
                 / count(distinct case when fs.customer_id = $2 then fs.order_id end))::numeric(14,2)
           else 0 end,
      min(case when fs.customer_id = $2 then fs.occurred_at end),
      max(case when fs.customer_id = $2 then fs.occurred_at end)
      from fact_sales fs
     where (fs.customer_id = $1 or fs.customer_id = $2) ${wFrag}
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// --- Customer time series (per-customer weekly revenue/units) ------------
function customerTimeSeries(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const grain = grainToTrunc(p.grain || (p.timeframe && p.timeframe.seriesGrain) || 'week');
  // Default to last 10 weeks if no timeframe.
  let tf = p.timeframe;
  if (!tf || tf.mode === 'all_time') {
    const now = new Date();
    tf = {
      mode: 'window',
      sinceIso: new Date(now - 10 * 7 * 86400e3).toISOString(),
      untilIso: now.toISOString(),
      label: 'last 10 weeks (default)',
      days: 70,
    };
  }
  const w = windowFragments('fs.occurred_at', tf, 2);
  const values = [cid, ...w.values];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select date_trunc('${grain}', fs.occurred_at) as bucket,
           sum(fs.quantity)::int                  as units,
           sum(fs.net_revenue)::numeric(14,2)     as net_revenue,
           count(distinct fs.order_id)::int       as orders
      from fact_sales fs
     where fs.customer_id = $1 ${where}
     group by bucket
     order by bucket asc
  `;
  return { text, values, meta: { domain: 'customers', grain, timeframe: tf } };
}

// --- Customer change-over-time (window vs prior equal-length window) -----
function customerChangeOverTime(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  // Default 6 months vs prior 6 months.
  let tf = p.timeframe;
  if (!tf || tf.mode === 'all_time') {
    const now = new Date();
    tf = {
      mode: 'window',
      sinceIso: new Date(now - 180 * 86400e3).toISOString(),
      untilIso: now.toISOString(),
      label: 'last 6 months (default)',
      days: 180,
    };
  }
  const widthMs = new Date(tf.untilIso) - new Date(tf.sinceIso);
  const priorSince = new Date(new Date(tf.sinceIso).getTime() - widthMs).toISOString();
  const priorUntil = tf.sinceIso;
  const text = `
    with cur as (
      select
        sum(fs.net_revenue)::numeric(14,2) as revenue,
        sum(fs.quantity)::int              as units,
        count(distinct fs.order_id)::int   as orders
        from fact_sales fs
       where fs.customer_id = $1
         and fs.occurred_at >= $2::timestamptz
         and fs.occurred_at <  $3::timestamptz
    ),
    prev as (
      select
        sum(fs.net_revenue)::numeric(14,2) as revenue,
        sum(fs.quantity)::int              as units,
        count(distinct fs.order_id)::int   as orders
        from fact_sales fs
       where fs.customer_id = $1
         and fs.occurred_at >= $4::timestamptz
         and fs.occurred_at <  $5::timestamptz
    )
    select 'current'  as bucket, coalesce(cur.revenue, 0)::numeric(14,2) as revenue,
           coalesce(cur.units, 0)::int as units, coalesce(cur.orders, 0)::int as orders
      from cur
    union all
    select 'previous', coalesce(prev.revenue, 0)::numeric(14,2),
           coalesce(prev.units, 0)::int, coalesce(prev.orders, 0)::int
      from prev
  `;
  return {
    text,
    values: [cid, tf.sinceIso, tf.untilIso, priorSince, priorUntil],
    meta: { domain: 'customers', window_current: { sinceIso: tf.sinceIso, untilIso: tf.untilIso }, window_previous: { sinceIso: priorSince, untilIso: priorUntil } },
  };
}

// Color/red-vs-white mix for one customer.
function customerColorMix(p) {
  const cid = p.resolved && p.resolved.customer && p.resolved.customer.customer_id;
  if (!cid) return { text: 'select null where false', values: [], meta: { domain: 'customers' } };
  const w = windowFragments('fs.occurred_at', p.timeframe, 2);
  const values = [cid, ...w.values];
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      case
        when lower(fs.product_title) like '%sparkling%' or lower(fs.product_title) like '%champagne%'
             or lower(fs.product_title) like '%prosecco%' or lower(fs.product_title) like '%cava%' then 'sparkling'
        when lower(fs.product_title) like '%ros%' then 'rose'
        when lower(fs.product_title) like '%white%'
             or lower(fs.product_title) like '%chardonnay%' or lower(fs.product_title) like '%sauvignon blanc%'
             or lower(fs.product_title) like '%riesling%' or lower(fs.product_title) like '%pinot grigio%'
             or lower(fs.product_title) like '%pinot gris%' or lower(fs.product_title) like '%albari%'
             or lower(fs.product_title) like '%vermentino%' or lower(fs.product_title) like '%gru%veltliner%' then 'white'
        when lower(fs.product_title) like '%red%'
             or lower(fs.product_title) like '%pinot noir%' or lower(fs.product_title) like '%cabernet%'
             or lower(fs.product_title) like '%merlot%' or lower(fs.product_title) like '%syrah%'
             or lower(fs.product_title) like '%malbec%' or lower(fs.product_title) like '%zinfandel%'
             or lower(fs.product_title) like '%sangiovese%' or lower(fs.product_title) like '%nebbiolo%'
             or lower(fs.product_title) like '%grenache%' or lower(fs.product_title) like '%tempranillo%' then 'red'
        else 'other'
      end as color_bucket,
      sum(fs.quantity)::int              as units,
      sum(fs.net_revenue)::numeric(14,2) as spend,
      count(distinct fs.order_id)        as orders
      from fact_sales fs
     where fs.customer_id = $1 ${where}
     group by 1
     order by spend desc nulls last
  `;
  return { text, values, meta: { domain: 'customers' } };
}

// --- Overlap: orders with both X and Y (e.g., liquor + wine) -------------
function orderOverlapShare(p) {
  // Numerator: orders containing ALL listed filters (e.g. wine AND liquor).
  // Denominator: all non-cancelled orders in window.
  const filters = Array.isArray(p.overlapFilters) && p.overlapFilters.length
    ? p.overlapFilters
    : ['wine', 'liquor'];
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const values = [...w.values];
  let i = w.nextIdx;
  const exists = filters.map((f) => {
    values.push(`%${f}%`);
    const idx = i++;
    return `exists (
      select 1 from order_line_items x
       left join products p on p.id = x.product_id
       where x.order_id = o.id
         and (lower(x.title) like lower($${idx})
           or lower(x.variant_title) like lower($${idx})
           or lower(coalesce(p.product_type,'')) like lower($${idx})))`;
  }).join(' and ');
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(distinct o.id) filter (where o.cancelled_at is null and ${exists})::int as numerator,
      count(distinct o.id) filter (where o.cancelled_at is null)::int                as denominator
      from orders o
     ${where}
  `;
  return { text, values, meta: { domain: 'orders', filters } };
}

// ===========================================================================
// v6 builders: operational / status / segmentation / shipping / financial
// All read from existing schema + vw_orders_enriched / vw_refunded_line_items.
// ===========================================================================

// ---- Order status / fulfillment / drafts / archived ----------------------

function orderStatusBreakdown(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      coalesce(o.financial_status, '(unknown)')     as financial_status,
      coalesce(o.fulfillment_status, 'unfulfilled') as fulfillment_status,
      (o.cancelled_at is not null)                  as cancelled,
      count(*)::int                                  as orders,
      coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     ${where}
     group by 1, 2, 3
     order by orders desc
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function fulfillmentStatusBreakdown(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(o.fulfillment_status, 'unfulfilled') as fulfillment_status,
           count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     ${where}
     group by 1
     order by orders desc
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersPendingFulfillment(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and` : 'where';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     ${where} o.cancelled_at is null
       and (o.fulfillment_status is null
            or lower(o.fulfillment_status) in ('partial','unfulfilled','open',''))
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function refundedOrdersCount(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and` : 'where';
  const text = `
    select count(*)::int                                 as orders,
           coalesce(sum(refund_amount), 0)::numeric(14,2) as refund_total
      from vw_orders_enriched
     ${where} refund_count > 0
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function cancelledOrdersCount(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = ['cancelled_at is not null', ...w.fragments];
  const text = `
    select count(*)::int                                as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as cancelled_total
      from orders
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function draftOrdersCount() {
  // Shopify draft orders are not in /orders (separate /draft_orders endpoint);
  // we sync only the real orders table. We answer honestly and surface zero
  // with a caveat-friendly intent name.
  const text = `select 0::int as drafts, false as supported`;
  return { text, values: [], meta: { domain: 'orders', supported: false } };
}

function archivedOrdersCount(p) {
  // Shopify "archived" = orders that are closed (closed_at set). Best proxy.
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = ['closed_at is not null', ...w.fragments];
  const text = `
    select count(*)::int as orders
      from orders
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersWithNotes(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = [`note_text is not null and length(note_text) > 0`, ...w.fragments];
  const text = `
    select count(*)::int as orders
      from vw_orders_enriched
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersWithCustomAttrs(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = [`note_attribute_count > 0`, ...w.fragments];
  const text = `
    select count(*)::int as orders
      from vw_orders_enriched
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersByReferrer(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(nullif(o.source_name,''), '(unknown)') as source_name,
           count(*)::int                                    as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2)   as revenue
      from orders o
     ${where}
     group by 1
     order by orders desc
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersByTag(p) {
  // Either count of orders carrying a given tag, or breakdown of tag usage.
  const tagHint = p.tagHint;
  const w = windowFragments('created_at', p.timeframe, tagHint ? 2 : 1);
  if (tagHint) {
    const text = `
      select count(*)::int                                as orders,
             coalesce(sum(total_price), 0)::numeric(14,2) as revenue
        from orders
       where coalesce(tags,'') ilike $1 ${w.fragments.length ? 'and ' + w.fragments.join(' and ') : ''}
    `;
    return { text, values: [`%${tagHint}%`, ...w.values], meta: { domain: 'orders', tag: tagHint } };
  }
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select trim(tag)                              as tag,
           count(*)::int                          as orders
      from orders, unnest(string_to_array(coalesce(tags,''), ',')) as tag
     ${where}
     where length(trim(tag)) > 0
     group by 1
     order by orders desc
     limit 25
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Order extreme totals (largest / highest / lowest by total_price) ----

function highestOrderTotal(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and` : 'where';
  const text = `
    select o.id as order_id, o.name as order_name, o.total_price,
           coalesce(o.processed_at, o.created_at) as occurred_at,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email as customer_email
      from orders o
      left join customers c on c.id = o.customer_id
     ${where} o.cancelled_at is null
       and o.total_price is not null
     order by o.total_price desc
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 5}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function lowestOrderTotal(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and` : 'where';
  const text = `
    select o.id as order_id, o.name as order_name, o.total_price,
           coalesce(o.processed_at, o.created_at) as occurred_at,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email as customer_email
      from orders o
      left join customers c on c.id = o.customer_id
     ${where} o.cancelled_at is null
       and o.total_price is not null
       and o.total_price > 0
     order by o.total_price asc
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 5}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersAbove(p) {
  // "orders over $500", "orders above $X" — count + total revenue + sample list.
  const v = (p.money && p.money.value) || 500;
  const w = windowFragments('o.created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue,
           min(o.total_price)::numeric(14,2)              as min_total,
           max(o.total_price)::numeric(14,2)              as max_total
      from orders o
     where o.cancelled_at is null
       and o.total_price >= $1 ${where}
  `;
  return { text, values: [v, ...w.values], meta: { domain: 'orders', threshold: v } };
}

// ---- Aggregations: average items per order, total line items, etc -------

function avgItemsPerOrder(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      coalesce(sum(oli.quantity), 0)::int            as total_line_items,
      count(distinct o.id)::int                       as orders,
      case when count(distinct o.id) > 0
           then (sum(oli.quantity)::numeric / count(distinct o.id))::numeric(10,2)
           else 0 end                                  as avg_items_per_order
      from orders o
      join order_line_items oli on oli.order_id = o.id
     where o.cancelled_at is null ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function totalLineItemsSold(p) {
  return avgItemsPerOrder(p); // same SQL; formatter picks different field
}

function avgQuantityPerLineItem(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select avg(oli.quantity)::numeric(10,2) as avg_quantity,
           count(*)::int                     as line_items
      from order_line_items oli
      join orders o on o.id = oli.order_id
     where o.cancelled_at is null ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function orderCompletionRate(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(*)::int                                         as total,
      count(*) filter (where cancelled_at is null
                         and lower(coalesce(fulfillment_status,'')) = 'fulfilled')::int as completed,
      count(*) filter (where cancelled_at is not null)::int as cancelled
      from orders
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Discounts / taxes / refunds -----------------------------------------

function totalDiscountsGiven(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(sum(total_discounts), 0)::numeric(14,2) as total_discounts,
           count(*) filter (where total_discounts > 0)::int  as discounted_orders,
           count(*)::int                                      as orders
      from orders
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function totalTaxesCollected(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(sum(total_tax), 0)::numeric(14,2) as total_tax,
           count(*)::int                                as orders
      from orders
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersWithDiscounts(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = ['total_discounts > 0', ...w.fragments];
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(total_discounts), 0)::numeric(14,2) as discount_total,
           coalesce(avg(total_discounts), 0)::numeric(10,2) as avg_discount
      from orders
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersWithoutDiscount(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = ['coalesce(total_discounts, 0) = 0', 'cancelled_at is null', ...w.fragments];
  const text = `
    select count(*)::int as orders
      from orders
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function avgDiscountPercentage(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const filters = ['total_discounts > 0', 'subtotal_price > 0', ...w.fragments];
  const text = `
    select avg(total_discounts / subtotal_price * 100)::numeric(10,2) as avg_pct,
           count(*)::int                                                as discounted_orders
      from orders
     where ${filters.join(' and ')}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function topDiscountCodes(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select code,
           count(*)::int                                    as orders,
           coalesce(sum(total_discounts), 0)::numeric(14,2) as discount_total
      from vw_orders_enriched,
           unnest(coalesce(discount_codes, '{}'::text[])) as code
     where coalesce(code, '') <> '' ${where}
     group by code
     order by orders desc
     limit 20
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function couponUsageRate(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(*) filter (where coalesce(array_length(v.discount_codes, 1), 0) > 0)::int as with_code,
      count(*)::int                                                                    as orders
      from vw_orders_enriched v
      join orders o on o.id = v.order_id
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function refundRateAndAvg(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      count(*)::int                                                       as orders,
      count(*) filter (where refund_count > 0)::int                       as refunded_orders,
      coalesce(sum(refund_amount), 0)::numeric(14,2)                      as refund_total,
      coalesce(avg(refund_amount) filter (where refund_count > 0), 0)::numeric(14,2) as avg_refund,
      coalesce(avg(extract(epoch from (first_refund_at - created_at))/86400)
               filter (where refund_count > 0), 0)::numeric(10,2)         as avg_days_to_refund
      from vw_orders_enriched
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function productsWithMostReturns(p) {
  const w = windowFragments('refunded_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select sku, product_title, vendor,
           sum(quantity)::int                       as refunded_units,
           coalesce(sum(subtotal), 0)::numeric(14,2) as refunded_value,
           count(distinct order_id)                  as refund_events
      from vw_refunded_line_items
     ${where}
     group by sku, product_title, vendor
     order by refunded_units desc
     limit 20
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Shipping / fulfillment-time -----------------------------------------

function ordersShippedToState(p) {
  // If user named a state via params.shippingStateHint, filter; else breakdown.
  const w = windowFragments('created_at', p.timeframe, 1);
  if (p.shippingStateHint) {
    const text = `
      select count(*)::int                                as orders,
             coalesce(sum(total_price), 0)::numeric(14,2) as revenue
        from vw_orders_enriched
       where (upper(shipping_state) = upper($1)
              or lower(shipping_state_name) = lower($1))
         ${w.fragments.length ? 'and ' + w.fragments.join(' and ') : ''}
    `;
    return { text, values: [p.shippingStateHint, ...w.values], meta: { domain: 'orders', state: p.shippingStateHint } };
  }
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(shipping_state, '(unknown)')        as state,
           count(*)::int                                as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     ${where}
     group by 1
     order by orders desc
     limit 25
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function internationalOrdersCount(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders
      from vw_orders_enriched
     where coalesce(upper(shipping_country), '') not in ('US', '')
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function avgFulfillmentTime(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      avg(extract(epoch from (coalesce(first_fulfilled_at, closed_at) - created_at)) / 86400)::numeric(10,2) as avg_days,
      count(*) filter (where first_fulfilled_at is not null or closed_at is not null)::int as orders,
      bool_or(first_fulfilled_at is not null) as has_precise
      from vw_orders_enriched
     where cancelled_at is null ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function shippingMethodBreakdown(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(shipping_method_title, '(unknown)')      as shipping_method,
           count(*)::int                                      as orders,
           coalesce(sum(shipping_cost), 0)::numeric(14,2)     as shipping_revenue,
           coalesce(avg(shipping_cost), 0)::numeric(10,2)     as avg_shipping_cost
      from vw_orders_enriched
     ${where}
     group by 1
     order by orders desc
     limit 25
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersByShippingTitle(p) {
  // "free shipping", "same day", "express", "store pickup", "local delivery" — pattern match.
  const pat = p.shippingTitlePattern || '%';
  const w = windowFragments('created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue,
           coalesce(sum(shipping_cost), 0)::numeric(14,2) as shipping_total
      from vw_orders_enriched
     where coalesce(shipping_method_title, '') ilike $1 ${where}
  `;
  return { text, values: [pat, ...w.values], meta: { domain: 'orders', pattern: pat } };
}

function freeShippingOrders(p) {
  // Either shipping_method_title says "free" OR shipping_cost = 0.
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     where cancelled_at is null
       and (coalesce(shipping_method_title, '') ilike '%free%'
            or coalesce(shipping_cost, 0) = 0)
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Payment method breakdown --------------------------------------------

function paymentMethodBreakdown(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select gw                                            as payment_gateway,
           count(*)::int                                 as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched v
      join orders o on o.id = v.order_id,
           unnest(coalesce(v.payment_gateways, '{}'::text[])) as gw
     where coalesce(gw, '') <> '' ${where}
     group by gw
     order by orders desc
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersByGateway(p) {
  // "orders paid with paypal", "credit card", etc. — pattern match.
  const pat = p.gatewayPattern || '%';
  const w = windowFragments('o.created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched v
      join orders o on o.id = v.order_id
     where exists (
       select 1 from unnest(coalesce(v.payment_gateways, '{}'::text[])) gw
        where gw ilike $1
     ) ${where}
  `;
  return { text, values: [pat, ...w.values], meta: { domain: 'orders', pattern: pat } };
}

// ---- Misc operational ----------------------------------------------------

function ordersAfterHour(p) {
  const hour = p.afterHour || 17;
  const w = windowFragments('created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from orders
     where cancelled_at is null
       and extract(hour from coalesce(processed_at, created_at)) >= $1
       ${where}
  `;
  return { text, values: [hour, ...w.values], meta: { domain: 'orders', hour } };
}

function ordersWithGiftCards(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders
      from vw_orders_enriched
     where has_gift_card is true ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function totalWeight(p) {
  const w = windowFragments('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(sum(total_weight_g), 0)::numeric as total_grams,
           count(*) filter (where total_weight_g is not null)::int as orders_with_weight,
           count(*)::int                                           as orders
      from vw_orders_enriched
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function heaviestOrders(p) {
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and` : 'where';
  const text = `
    select o.id as order_id, o.name as order_name,
           v.total_weight_g, o.total_price,
           coalesce(o.processed_at, o.created_at) as occurred_at,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name
      from vw_orders_enriched v
      join orders o on o.id = v.order_id
      left join customers c on c.id = o.customer_id
     ${where} v.total_weight_g is not null
     order by v.total_weight_g desc
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 10}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Customer aggregates -------------------------------------------------

function avgCustomerLtv() {
  const text = `
    select
      avg(total_spend)::numeric(14,2)                                                  as avg_ltv,
      count(*) filter (where order_count >= 1)::int                                    as customers_with_orders,
      count(*)::int                                                                     as customers_total
      from dim_customer_profile
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function customerOrderFrequency() {
  const text = `
    select
      avg(order_count) filter (where order_count >= 1)::numeric(10,2) as avg_orders_per_customer,
      count(*) filter (where order_count >= 1)::int                   as customers_with_orders
      from dim_customer_profile
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function repeatCustomerRate() {
  const text = `
    select
      count(*) filter (where order_count >= 2)::int as repeat_customers,
      count(*) filter (where order_count >= 1)::int as customers_with_orders,
      count(*)::int                                  as customers_total
      from dim_customer_profile
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function customersWithOrdersAbove(p) {
  const v = (p.money && p.money.value) || 1000;
  const text = `
    select count(*)::int                                  as customers,
           coalesce(sum(total_spend), 0)::numeric(14,2)    as total_spend,
           coalesce(avg(total_spend), 0)::numeric(14,2)    as avg_spend
      from dim_customer_profile
     where total_spend >= $1
  `;
  return { text, values: [v], meta: { domain: 'customers', threshold: v } };
}

function customersWithNoOrders() {
  const text = `
    select count(*)::int as customers
      from customers c
      left join dim_customer_profile d on d.customer_id = c.id
     where coalesce(d.order_count, 0) = 0
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function customerLocationsBreakdown() {
  // Real customer location is in shipping address on their most recent order.
  // We answer via vw_orders_enriched as a proxy.
  const text = `
    with last_per as (
      select v.customer_id, max(v.created_at) as last_at
        from vw_orders_enriched v
       where v.customer_id is not null and v.shipping_state is not null
       group by v.customer_id
    )
    select coalesce(v.shipping_state, '(unknown)') as state,
           count(distinct v.customer_id)::int       as customers
      from vw_orders_enriched v
      join last_per lp on lp.customer_id = v.customer_id and lp.last_at = v.created_at
     group by 1
     order by customers desc
     limit 25
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function lastOrderDatePerCustomer(p) {
  const text = `
    select customer_id, customer_name, email,
           last_order_at, days_since_last_order, order_count, total_spend
      from dim_customer_profile
     where last_order_at is not null
     order by last_order_at desc
     limit ${p.limit && p.limit > 0 ? Math.min(100, p.limit) : 25}
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

function firstTimeBuyerOrders(p) {
  // Orders where the placing customer had no earlier order before this one.
  const w = windowFragments('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with first_per as (
      select customer_id, min(coalesce(processed_at, created_at)) as first_at
        from orders
       where customer_id is not null and cancelled_at is null
       group by customer_id
    )
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
      join first_per fp on fp.customer_id = o.customer_id
                       and fp.first_at = coalesce(o.processed_at, o.created_at)
     where o.cancelled_at is null ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

function ordersShippedThisWindow(p) {
  // "orders shipped (this week / last week / yesterday / ...)" → fulfilled within window.
  const w = windowFragments('coalesce(first_fulfilled_at, closed_at)', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : 'where coalesce(first_fulfilled_at, closed_at) is not null';
  const text = `
    select count(*)::int                                as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// ---- Weekday vs weekend (average per day) --------------------------------

function weekdayVsWeekend(p) {
  // Aggregate per-day revenue, then split into weekday vs weekend averages.
  const w = windowFragments('occurred_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    with per_day as (
      select date_trunc('day', occurred_at) as d,
             extract(dow from occurred_at)::int as dow,
             sum(net_revenue)::numeric(14,2)    as revenue,
             count(distinct order_id)::int      as orders
        from fact_sales
       ${where}
       group by 1, 2
    )
    select
      avg(revenue) filter (where dow in (1,2,3,4,5))::numeric(14,2) as weekday_avg_revenue,
      avg(revenue) filter (where dow in (0,6))::numeric(14,2)       as weekend_avg_revenue,
      avg(orders)  filter (where dow in (1,2,3,4,5))::numeric(10,2) as weekday_avg_orders,
      avg(orders)  filter (where dow in (0,6))::numeric(10,2)       as weekend_avg_orders,
      count(*) filter (where dow in (1,2,3,4,5))::int               as weekday_days,
      count(*) filter (where dow in (0,6))::int                     as weekend_days
      from per_day
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// ---- Products / catalog / inventory --------------------------------------

function whatProductsDoWeSell() {
  // Top categories by product count + counts.
  const text = `
    select coalesce(nullif(product_type,''), '(unknown)') as category,
           count(*)::int                                   as products
      from products
     group by 1
     order by products desc
     limit 25
  `;
  return { text, values: [], meta: { domain: 'sales' } };
}

function worstSellingProducts(p) {
  // Products in catalog with the lowest 30-day units; restricts to those with on-hand>0.
  const text = `
    select sku, product_title, vendor, on_hand, units_sold_30d, units_sold_90d, last_sold_at
      from dim_sku_profile
     where on_hand > 0
     order by units_sold_30d asc nulls first, units_sold_90d asc nulls first
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 25}
  `;
  return { text, values: [], meta: { domain: 'sales' } };
}

function newestProductsAdded(p) {
  const text = `
    select id as product_id, title, vendor, product_type, status, created_at
      from products
     order by created_at desc nulls last
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 15}
  `;
  return { text, values: [], meta: { domain: 'sales' } };
}

function inventoryByLocation() {
  const text = `
    select l.id as location_id, l.name as location_name,
           count(distinct ilc.inventory_item_id)::int as inventory_items,
           coalesce(sum(ilc.available), 0)::int         as on_hand_units
      from locations l
      left join inventory_levels_current ilc on ilc.location_id = l.id
     group by l.id, l.name
     order by on_hand_units desc nulls last
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

function inventoryLevelsByProduct(p) {
  const text = `
    select v.product_title, v.sku, v.variant_title, v.vendor, v.on_hand, v.price
      from vw_current_inventory v
     order by v.on_hand desc nulls last
     limit ${p.limit && p.limit > 0 ? Math.min(100, p.limit) : 25}
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

function productsNotInInventory() {
  const text = `
    select count(*)::int as products_without_inventory,
           (select count(*) from products)::int as products_total
      from products p
     where not exists (
       select 1
         from variants v
         join inventory_levels_current ilc on ilc.inventory_item_id = v.inventory_item_id
        where v.product_id = p.id
          and coalesce(ilc.available, 0) > 0
     )
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

function inventoryTurnoverRate(p) {
  // 30-day units sold ÷ avg on-hand.
  const text = `
    select
      coalesce(sum(units_sold_30d), 0)::int as units_sold_30d,
      coalesce(sum(on_hand), 0)::int         as on_hand,
      case when coalesce(sum(on_hand), 0) > 0
           then (sum(units_sold_30d)::numeric / sum(on_hand))::numeric(10,2)
           else 0 end                         as turnover_ratio
      from dim_sku_profile
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

function daysOfInventoryRemaining() {
  // On-hand / (30d units / 30) = days of cover.
  const text = `
    select sku, product_title, on_hand, units_sold_30d,
           case when coalesce(units_sold_30d, 0) > 0
                then round(on_hand::numeric / (units_sold_30d::numeric / 30), 1)
                else null end as days_of_inventory_remaining
      from dim_sku_profile
     where on_hand > 0 and units_sold_30d > 0
     order by days_of_inventory_remaining asc
     limit 25
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

// ---- Comparisons: week-over-week, year-over-year, vs last month ----------

function weekOverWeek(p) {
  // Last 7 days vs the prior 7 days. Returns revenue / orders / units / aov.
  const now = new Date();
  const aSince = new Date(now - 7 * 86400e3).toISOString();
  const bSince = new Date(now - 14 * 86400e3).toISOString();
  const text = `
    select 'current' as bucket,
           coalesce(sum(net_revenue), 0)::numeric(14,2) as revenue,
           sum(quantity)::int                            as units,
           count(distinct order_id)::int                 as orders
      from fact_sales
     where occurred_at >= $1::timestamptz
       and occurred_at <  $2::timestamptz
    union all
    select 'previous',
           coalesce(sum(net_revenue), 0)::numeric(14,2),
           sum(quantity)::int,
           count(distinct order_id)::int
      from fact_sales
     where occurred_at >= $3::timestamptz
       and occurred_at <  $1::timestamptz
  `;
  return {
    text,
    values: [aSince, now.toISOString(), bSince],
    meta: { domain: 'sales', label: 'week-over-week' },
  };
}

function yearOverYear() {
  // Last 365 days vs prior 365 days.
  const now = new Date();
  const aSince = new Date(now - 365 * 86400e3).toISOString();
  const bSince = new Date(now - 730 * 86400e3).toISOString();
  const text = `
    select 'current' as bucket,
           coalesce(sum(net_revenue), 0)::numeric(14,2) as revenue,
           sum(quantity)::int                            as units,
           count(distinct order_id)::int                 as orders
      from fact_sales
     where occurred_at >= $1::timestamptz
       and occurred_at <  $2::timestamptz
    union all
    select 'previous',
           coalesce(sum(net_revenue), 0)::numeric(14,2),
           sum(quantity)::int,
           count(distinct order_id)::int
      from fact_sales
     where occurred_at >= $3::timestamptz
       and occurred_at <  $1::timestamptz
  `;
  return {
    text,
    values: [aSince, now.toISOString(), bSince],
    meta: { domain: 'sales', label: 'year-over-year' },
  };
}

// ---- "Capability not in synced data" graceful answer ---------------------
function capabilityUnsupported(p) {
  const text = `select $1::text as capability`;
  return {
    text,
    values: [p.unsupportedKey || 'unknown'],
    meta: { domain: 'meta', supported: false },
  };
}

// ===========================================================================
// v7 builders (Round-3 56-query upgrade)
// All read existing schema + vw_orders_enriched. No re-sync required.
// ===========================================================================

function _w(col, tf, idx) { return windowFragments(col, tf, idx); }

// 1) orders_by_period_count — count + total in window
function ordersByPeriodCount(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')} and o.cancelled_at is null`
                                   : `where o.cancelled_at is null`;
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 2) orders_under_amount — total_price < threshold
function ordersUnderAmount(p) {
  const v = (p.money && p.money.op === '<' ? p.money.value : null) ||
            (p.underAmount) || 50;
  const w = _w('o.created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue,
           coalesce(avg(o.total_price), 0)::numeric(14,2) as avg_total
      from orders o
     where o.cancelled_at is null
       and o.total_price < $1 ${where}
  `;
  return { text, values: [v, ...w.values], meta: { domain: 'orders', threshold: v } };
}

// 3) order_count_by_day — daily order count grouped
function orderCountByDay(p) {
  // Use the storewide time-series builder shape, force grain=day, metric=orders
  const w = _w('occurred_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select date_trunc('day', occurred_at)            as bucket,
           count(distinct order_id)::int             as orders,
           coalesce(sum(net_revenue), 0)::numeric(14,2) as net_revenue,
           coalesce(sum(quantity), 0)::int           as units
      from fact_sales
     ${where}
     group by bucket
     order by bucket asc
  `;
  return { text, values: w.values, meta: { domain: 'orders', grain: 'day' } };
}

// 5) orders_on_weekends — weekday ∈ {Sat, Sun}
function ordersOnWeekends(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     where o.cancelled_at is null
       and extract(dow from coalesce(o.processed_at, o.created_at)) in (0, 6)
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 8) customer_most_orders — top-1 customer by order count
function customerMostOrders() {
  const text = `
    select customer_id, customer_name, email,
           order_count, total_spend, last_order_at
      from dim_customer_profile
     order by order_count desc nulls last
     limit 5
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

// 9) customers_one_time_only_period — exactly one order in window
function customersOneTimeOnlyPeriod(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with per_customer as (
      select o.customer_id, count(*) as orders, max(o.total_price) as max_total
        from orders o
       where o.customer_id is not null
         and o.cancelled_at is null ${where}
       group by o.customer_id
    )
    select count(*)::int as customers_one_time_only,
           coalesce(avg(max_total), 0)::numeric(14,2) as avg_order_value
      from per_customer
     where orders = 1
  `;
  return { text, values: w.values, meta: { domain: 'customers' } };
}

// 10) customer_retention_rate — % of customers who ordered in window AND had prior orders
function customerRetentionRate(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with in_window as (
      select distinct o.customer_id
        from orders o
       where o.customer_id is not null
         and o.cancelled_at is null ${where}
    ),
    earliest as (
      select customer_id, min(coalesce(processed_at, created_at)) as first_seen
        from orders
       where customer_id is not null and cancelled_at is null
       group by customer_id
    )
    select
      count(distinct iw.customer_id) filter (where ${p.timeframe && p.timeframe.sinceIso ? `e.first_seen < $${w.nextIdx}` : 'false'})::int as retained_customers,
      count(distinct iw.customer_id)::int as purchasing_customers
    from in_window iw
    left join earliest e on e.customer_id = iw.customer_id
  `;
  const values = [...w.values];
  if (p.timeframe && p.timeframe.sinceIso) values.push(p.timeframe.sinceIso);
  return { text, values, meta: { domain: 'customers' } };
}

// 11) avg_days_between_orders — avg of (max-min)/(orders-1) per multi-order customer
function avgDaysBetweenOrders() {
  const text = `
    with spans as (
      select customer_id,
             count(*) as orders,
             min(coalesce(processed_at, created_at)) as first_at,
             max(coalesce(processed_at, created_at)) as last_at
        from orders
       where customer_id is not null and cancelled_at is null
       group by customer_id
      having count(*) >= 2
    )
    select avg(extract(epoch from (last_at - first_at)) / 86400 / nullif(orders - 1, 0))::numeric(10,2)
              as avg_days_between_orders,
           count(*)::int as repeat_customers
      from spans
  `;
  return { text, values: [], meta: { domain: 'customers' } };
}

// 12) bottom_products_by_units — varietal_ranking ASC
function bottomProductsByUnits(p) {
  const limit = p.limit && p.limit > 0 ? Math.min(50, p.limit) : 5;
  const w = _w('fs.occurred_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.product_title                                 as product,
           sum(fs.quantity)::int                             as units,
           coalesce(sum(fs.net_revenue), 0)::numeric(14,2)   as revenue,
           count(distinct fs.order_id)::int                  as orders
      from fact_sales fs
     ${where}
     group by 1
     order by units asc, revenue asc
     limit ${limit}
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 13) products_zero_sales_period — on-hand SKUs with 0 sales in window
function productsZeroSalesPeriod(p) {
  // Use dim_sku_profile.units_sold_30d when window is ~30d; else compute from fact_sales
  const days = (p.timeframe && p.timeframe.days) || 30;
  if (days === 30) {
    const text = `
      select sku, product_title, vendor, on_hand
        from dim_sku_profile
       where on_hand > 0
         and coalesce(units_sold_30d, 0) = 0
       order by on_hand desc
       limit 25
    `;
    return { text, values: [], meta: { domain: 'inventory' } };
  }
  // General window
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const text = `
    select v.sku, v.product_title, v.vendor, v.on_hand
      from vw_current_inventory v
     where v.on_hand > 0
       and not exists (
         select 1 from fact_sales fs
          where fs.sku = v.sku
            and fs.occurred_at >= $1::timestamptz
       )
     order by v.on_hand desc
     limit 25
  `;
  return { text, values: [since], meta: { domain: 'inventory', days } };
}

// 14) newest_products_added_period — products.created_at in window
function newestProductsAddedPeriod(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select id as product_id, title, vendor, product_type, status, created_at
      from products
     ${where}
     order by created_at desc nulls last
     limit ${p.limit && p.limit > 0 ? Math.min(50, p.limit) : 20}
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 15) varietal_top_seller — winner only (top 1 by units, in window)
function varietalTopSeller(p) {
  const w = _w('fs.occurred_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select fs.product_title as varietal,
           sum(fs.quantity)::int as units,
           coalesce(sum(fs.net_revenue), 0)::numeric(14,2) as revenue
      from fact_sales fs
     ${where}
     group by 1
     order by units desc nulls last
     limit 5
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 16) product_count_total
function productCountTotal() {
  const text = `
    select count(*)::int as products,
           count(*) filter (where status = 'active')::int as active_products,
           (select count(*) from variants)::int as variants
      from products
  `;
  return { text, values: [], meta: { domain: 'sales' } };
}

// 17) inventory_per_product_summary
function inventoryPerProductSummary(p) {
  const limit = p.limit && p.limit > 0 ? Math.min(100, p.limit) : 25;
  const text = `
    select product_title,
           count(*)::int                  as variant_count,
           coalesce(sum(on_hand), 0)::int as total_on_hand,
           avg(price)::numeric(12,2)      as avg_price
      from vw_current_inventory
     where on_hand > 0
     group by product_title
     order by total_on_hand desc
     limit ${limit}
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

// 18) inventory_by_location_most — top location by units
function inventoryByLocationMost() {
  const text = `
    select l.id as location_id, l.name as location_name,
           coalesce(sum(ilc.available), 0)::int as on_hand_units,
           count(distinct ilc.inventory_item_id)::int as inventory_items
      from locations l
      left join inventory_levels_current ilc on ilc.location_id = l.id
     group by l.id, l.name
     order by on_hand_units desc nulls last
     limit 10
  `;
  return { text, values: [], meta: { domain: 'inventory' } };
}

// 19) avg_days_to_ship — AVG(first_fulfilled_at - created_at)
function avgDaysToShip(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      avg(extract(epoch from (first_fulfilled_at - created_at)) / 86400)::numeric(10,2) as avg_days,
      count(*) filter (where first_fulfilled_at is not null)::int as orders,
      bool_or(first_fulfilled_at is not null) as has_precise
      from vw_orders_enriched
     where cancelled_at is null ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 20) orders_same_day_shipped — fulfilled within 24h of creation
function ordersSameDayShipped(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     where cancelled_at is null
       and first_fulfilled_at is not null
       and first_fulfilled_at - created_at <= interval '24 hours'
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 21) orders_shipped_within_days
function ordersShippedWithinDays(p) {
  const days = p.shipWithinDays || 2;
  const w = _w('created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     where cancelled_at is null
       and first_fulfilled_at is not null
       and first_fulfilled_at - created_at <= ($1 || ' days')::interval
       ${where}
  `;
  return { text, values: [String(days), ...w.values], meta: { domain: 'orders', within_days: days } };
}

// 22) most_common_shipping_method
function mostCommonShippingMethod(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(shipping_method_title, '(unknown)') as shipping_method,
           count(*)::int                                 as orders,
           coalesce(sum(shipping_cost), 0)::numeric(14,2) as shipping_revenue
      from vw_orders_enriched
     ${where}
     group by 1
     order by orders desc
     limit 10
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 23) avg_shipping_cost_per_order
function avgShippingCostPerOrder(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(avg(shipping_cost), 0)::numeric(10,2)  as avg_shipping,
           coalesce(sum(shipping_cost), 0)::numeric(14,2)  as total_shipping,
           count(*) filter (where shipping_cost is not null)::int as orders
      from vw_orders_enriched
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 24) orders_pending_shipment — created but never fulfilled
function ordersPendingShipment(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from vw_orders_enriched
     where cancelled_at is null
       and first_fulfilled_at is null
       and (lower(coalesce(fulfillment_status, '')) in ('', 'partial', 'unfulfilled', 'open'))
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 25) orders_fulfilled_period — fulfilled within window (already via orders_shipped_this_window)

// 26) avg_discount_per_order
function avgDiscountPerOrder(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(avg(total_discounts), 0)::numeric(10,2)  as avg_discount,
           coalesce(sum(total_discounts), 0)::numeric(14,2)  as total_discounts,
           count(*) filter (where total_discounts > 0)::int   as discounted_orders,
           count(*)::int                                       as orders
      from orders
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 27) refunds_amount_period — same shape as refund_rate_and_avg, formatter picks fields
// 28) avg_refund_processing_time — covered by refund_rate_and_avg (avg_days_to_refund)
// 29) products_most_refund_requests — already products_with_most_returns

// 30) refund_trend_period — refunds per day in window
function refundTrendPeriod(p) {
  const w = _w('first_refund_at', p.timeframe, 1);
  const where = w.fragments.length
    ? `where ${w.fragments.join(' and ')} and refund_count > 0`
    : `where refund_count > 0 and first_refund_at >= now() - interval '30 days'`;
  const text = `
    select date_trunc('day', first_refund_at)             as bucket,
           count(*)::int                                   as refunds,
           coalesce(sum(refund_amount), 0)::numeric(14,2)  as refund_amount
      from vw_orders_enriched
     ${where}
     group by 1
     order by 1 asc
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 31) total_refunded_period — sum refund_amount in window
function totalRefundedPeriod(p) {
  const w = _w('first_refund_at', p.timeframe, 1);
  const where = w.fragments.length
    ? `where ${w.fragments.join(' and ')} and refund_count > 0`
    : `where refund_count > 0`;
  const text = `
    select count(*)::int                                   as refunded_orders,
           coalesce(sum(refund_amount), 0)::numeric(14,2)  as refund_total
      from vw_orders_enriched
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 33) orders_between_hours
function ordersBetweenHours(p) {
  const a = p.hourStart != null ? p.hourStart : 18;
  const b = p.hourEnd != null ? p.hourEnd : 21;
  const w = _w('created_at', p.timeframe, 3);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int as orders,
           coalesce(sum(total_price), 0)::numeric(14,2) as revenue
      from orders
     where cancelled_at is null
       and extract(hour from coalesce(processed_at, created_at)) >= $1
       and extract(hour from coalesce(processed_at, created_at)) < $2
       ${where}
  `;
  return { text, values: [a, b, ...w.values], meta: { domain: 'orders', hour_start: a, hour_end: b } };
}

// 35) compare_product_sales_periods — top-10 products this window vs prior equal-length
function compareProductSalesPeriods(p) {
  let tf = p.timeframe;
  if (!tf || tf.mode === 'all_time') {
    const now = new Date();
    tf = { mode: 'window', sinceIso: new Date(now - 30*86400e3).toISOString(), untilIso: now.toISOString(), days: 30 };
  }
  const widthMs = new Date(tf.untilIso) - new Date(tf.sinceIso);
  const priorSince = new Date(new Date(tf.sinceIso).getTime() - widthMs).toISOString();
  const priorUntil = tf.sinceIso;
  const text = `
    with cur as (
      select fs.product_title,
             sum(fs.quantity)::int as units,
             sum(fs.net_revenue)::numeric(14,2) as revenue
        from fact_sales fs
       where fs.occurred_at >= $1::timestamptz and fs.occurred_at < $2::timestamptz
       group by 1
    ),
    prev as (
      select fs.product_title,
             sum(fs.quantity)::int as units,
             sum(fs.net_revenue)::numeric(14,2) as revenue
        from fact_sales fs
       where fs.occurred_at >= $3::timestamptz and fs.occurred_at < $4::timestamptz
       group by 1
    )
    select coalesce(cur.product_title, prev.product_title) as product,
           coalesce(cur.units, 0)::int                     as units_current,
           coalesce(prev.units, 0)::int                    as units_previous,
           (coalesce(cur.units, 0) - coalesce(prev.units, 0))::int as units_delta,
           coalesce(cur.revenue, 0)::numeric(14,2)         as revenue_current,
           coalesce(prev.revenue, 0)::numeric(14,2)        as revenue_previous
      from cur full outer join prev using (product_title)
     order by units_delta desc nulls last
     limit 15
  `;
  return { text, values: [tf.sinceIso, tf.untilIso, priorSince, priorUntil], meta: { domain: 'sales' } };
}

// 36) net_profit_after_refunds_discounts — net_revenue - refunds - discounts (no cost data)
function netAfterRefundsDiscounts(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select
      coalesce(sum(o.total_price), 0)::numeric(14,2)                  as gross,
      coalesce(sum(o.total_discounts), 0)::numeric(14,2)              as discounts,
      coalesce(sum(v.refund_amount), 0)::numeric(14,2)                as refunds,
      coalesce(sum(o.total_tax), 0)::numeric(14,2)                    as tax,
      (coalesce(sum(o.total_price), 0) - coalesce(sum(v.refund_amount), 0))::numeric(14,2)
                                                                        as net_after_refunds,
      count(*)::int                                                    as orders
      from orders o
      left join vw_orders_enriched v on v.order_id = o.id
     ${where}
       ${w.fragments.length ? 'and' : 'where'} o.cancelled_at is null
  `;
  return { text, values: w.values, meta: { domain: 'orders', has_cost_data: false } };
}

// 37) avg_tax_per_order — AVG(total_tax)
function avgTaxPerOrder(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `where ${w.fragments.join(' and ')}` : '';
  const text = `
    select coalesce(avg(total_tax), 0)::numeric(10,2)  as avg_tax,
           coalesce(sum(total_tax), 0)::numeric(14,2)  as total_tax,
           count(*)::int                                as orders
      from orders
     ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 38) cross_sell_by_category — pairs of product_types co-occurring in same order
function crossSellByCategory(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with cats as (
      select distinct o.id as order_id,
             coalesce(nullif(p.product_type,''), '(unknown)') as category
        from orders o
        join order_line_items oli on oli.order_id = o.id
        join products p on p.id = oli.product_id
       where o.cancelled_at is null ${where}
    )
    select a.category as category_a,
           b.category as category_b,
           count(*)::int as orders_with_both
      from cats a
      join cats b on a.order_id = b.order_id and a.category < b.category
     group by 1, 2
     order by orders_with_both desc
     limit 15
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 39) customers_medium_value — lifetime spend 100..500
function customersMediumValue(p) {
  const lo = p.spendMin != null ? p.spendMin : 100;
  const hi = p.spendMax != null ? p.spendMax : 500;
  const text = `
    select count(*)::int                                  as customers,
           coalesce(sum(total_spend), 0)::numeric(14,2)   as total_spend,
           coalesce(avg(total_spend), 0)::numeric(14,2)   as avg_spend
      from dim_customer_profile
     where total_spend between $1 and $2
  `;
  return { text, values: [lo, hi], meta: { domain: 'customers', range: [lo, hi] } };
}

// 41) orders_never_fulfilled — fulfillment_status is null/unfulfilled and no first_fulfilled_at
function ordersNeverFulfilled(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
      left join vw_orders_enriched v on v.order_id = o.id
     where o.cancelled_at is null
       and v.first_fulfilled_at is null
       and (lower(coalesce(o.fulfillment_status, '')) in ('', 'unfulfilled', 'partial', 'open'))
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 42) completed_orders_period — fulfilled in window
function completedOrdersPeriod(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue
      from orders o
     where o.cancelled_at is null
       and lower(coalesce(o.fulfillment_status, '')) = 'fulfilled'
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 43) all_discount_codes_used — distinct codes
function allDiscountCodesUsed(p) {
  const w = _w('v.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select distinct code
      from vw_orders_enriched v,
           unnest(coalesce(v.discount_codes, '{}'::text[])) as code
     where coalesce(code, '') <> '' ${where}
     order by code asc
     limit 100
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 44) orders_grouped_by_discount_code — already top_discount_codes; alias-ready

// 47) largest_line_item_by_quantity
function largestLineItemByQuantity(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select oli.id as line_item_id,
           oli.title as product_title,
           oli.sku, oli.vendor,
           oli.quantity, oli.price as unit_price,
           o.name as order_name,
           coalesce(o.processed_at, o.created_at) as occurred_at
      from order_line_items oli
      join orders o on o.id = oli.order_id
     where o.cancelled_at is null ${where}
     order by oli.quantity desc nulls last
     limit 10
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 48) product_highest_avg_qty_per_order
function productHighestAvgQty(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select oli.title as product_title,
           avg(oli.quantity)::numeric(10,2) as avg_qty,
           count(distinct oli.order_id)::int as orders,
           sum(oli.quantity)::int            as total_qty
      from order_line_items oli
      join orders o on o.id = oli.order_id
     where o.cancelled_at is null ${where}
     group by oli.title
    having count(distinct oli.order_id) >= 3
     order by avg_qty desc nulls last
     limit 15
  `;
  return { text, values: w.values, meta: { domain: 'sales' } };
}

// 49) orders_containing_product — substring match on line item title
function ordersContainingProduct(p) {
  const hint = (p.productContainsHint || p.varietal || '').toString();
  if (!hint) {
    return { text: 'select 0::int as orders, 0::int as line_items, 0::numeric(14,2) as revenue', values: [], meta: { domain: 'orders' } };
  }
  const w = _w('o.created_at', p.timeframe, 2);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(distinct o.id)::int                                  as orders,
           count(*)::int                                                as line_items,
           coalesce(sum(oli.quantity * oli.price), 0)::numeric(14,2)   as revenue
      from orders o
      join order_line_items oli on oli.order_id = o.id
     where o.cancelled_at is null
       and (lower(oli.title) like lower($1) or lower(oli.variant_title) like lower($1))
       ${where}
  `;
  return { text, values: [`%${hint}%`, ...w.values], meta: { domain: 'orders', match: hint } };
}

// 50) orders_pending_over_days
function ordersPendingOverDays(p) {
  const d = p.pendingOverDays || 3;
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(total_price), 0)::numeric(14,2)   as revenue
      from vw_orders_enriched
     where cancelled_at is null
       and first_fulfilled_at is null
       and created_at < now() - ($1 || ' days')::interval
  `;
  return { text, values: [String(d)], meta: { domain: 'orders', threshold_days: d } };
}

// 51) repeat_purchase_rate_period — % of customers in window who had ≥2 orders in window
function repeatPurchaseRatePeriod(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with per_customer as (
      select customer_id, count(*) as orders
        from orders o
       where customer_id is not null and o.cancelled_at is null ${where}
       group by customer_id
    )
    select count(*) filter (where orders >= 2)::int as repeat_customers,
           count(*)::int                              as purchasing_customers
      from per_customer
  `;
  return { text, values: w.values, meta: { domain: 'customers' } };
}

// 52) avg_time_between_repeat_purchases — avg gap from 1st to 2nd order for multi-order customers
function avgTimeBetweenRepeat(p) {
  // For each customer with ≥2 orders we take the gap between their first
  // and second orders. Storewide lifetime; window optional.
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with ranked as (
      select o.customer_id,
             coalesce(o.processed_at, o.created_at) as at,
             row_number() over (partition by o.customer_id
                                order by coalesce(o.processed_at, o.created_at)) as rn
        from orders o
       where o.customer_id is not null and o.cancelled_at is null ${where}
    ),
    gaps as (
      select customer_id,
             extract(epoch from (max(at) filter (where rn = 2) - max(at) filter (where rn = 1))) / 86400 as gap_days
        from ranked
       where rn in (1, 2)
       group by customer_id
      having max(rn) = 2
    )
    select avg(gap_days)::numeric(10,2) as avg_days,
           count(*)::int                  as repeat_customers
      from gaps
  `;
  return { text, values: w.values, meta: { domain: 'customers' } };
}

// 53) orders_with_multiple_line_items
function ordersWithMultipleLines(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    with per_order as (
      select o.id, count(*) as items
        from orders o
        join order_line_items oli on oli.order_id = o.id
       where o.cancelled_at is null ${where}
       group by o.id
    )
    select count(*) filter (where items >= 2)::int as multi_item_orders,
           count(*) filter (where items = 1)::int   as single_item_orders,
           count(*)::int                              as total_orders
      from per_order
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 54) orders_single_line_item — same SQL, formatter picks different field

// 55) guest_checkout_orders — orders with customer_id IS NULL
function guestCheckoutOrders(p) {
  const w = _w('created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(total_price), 0)::numeric(14,2)   as revenue
      from orders
     where customer_id is null
       and cancelled_at is null
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
}

// 56) email_subscriber_orders — orders where customers.raw.accepts_marketing = true
function emailSubscriberOrders(p) {
  const w = _w('o.created_at', p.timeframe, 1);
  const where = w.fragments.length ? `and ${w.fragments.join(' and ')}` : '';
  const text = `
    select count(*)::int                                  as orders,
           coalesce(sum(o.total_price), 0)::numeric(14,2) as revenue,
           count(distinct o.customer_id)::int             as customers
      from orders o
      join customers c on c.id = o.customer_id
     where o.cancelled_at is null
       and coalesce((c.raw->>'accepts_marketing')::boolean, false) = true
       ${where}
  `;
  return { text, values: w.values, meta: { domain: 'orders' } };
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
  // smartness pass v4
  repeatCustomersCount,
  newCustomersCount,
  repeatCustomersShare,
  newCustomersShare,
  customersCountPurchasing,
  busiestHour,
  busiestPeriodPattern,
  highestPricedItemSold,
  lowestPricedItemSold,
  buyerOfHighestPricedItem,
  buyerOfLowestPricedItem,
  customerTopProducts,
  customerTopVendors,
  customerTopCategories,
  customerFrequencyProfile,
  lapsedFrequentCustomers,
  customerReactivationCandidates,
  typeTopSeller,
  typeBreakdown,
  varietalRanking,
  shareOfSalesByFilter,
  shareOfRevenueTopN,
  shareOfDeadInventoryValue,
  shareOfOrdersWithFilter,
  dashboardSummary,
  // v5
  orderDetail,
  orderItems,
  orderExtremeItem,
  orderIncludesCategory,
  customerLastOrderItems,
  customerLastNOrders,
  customerComparison,
  customerTimeSeries,
  customerChangeOverTime,
  customerColorMix,
  orderOverlapShare,
  // v6 (84-query upgrade)
  orderStatusBreakdown,
  fulfillmentStatusBreakdown,
  ordersPendingFulfillment,
  refundedOrdersCount,
  cancelledOrdersCount,
  draftOrdersCount,
  archivedOrdersCount,
  ordersWithNotes,
  ordersWithCustomAttrs,
  ordersByReferrer,
  ordersByTag,
  highestOrderTotal,
  lowestOrderTotal,
  ordersAbove,
  avgItemsPerOrder,
  totalLineItemsSold,
  avgQuantityPerLineItem,
  orderCompletionRate,
  totalDiscountsGiven,
  totalTaxesCollected,
  ordersWithDiscounts,
  ordersWithoutDiscount,
  avgDiscountPercentage,
  topDiscountCodes,
  couponUsageRate,
  refundRateAndAvg,
  productsWithMostReturns,
  ordersShippedToState,
  internationalOrdersCount,
  avgFulfillmentTime,
  shippingMethodBreakdown,
  ordersByShippingTitle,
  freeShippingOrders,
  paymentMethodBreakdown,
  ordersByGateway,
  ordersAfterHour,
  ordersWithGiftCards,
  totalWeight,
  heaviestOrders,
  avgCustomerLtv,
  customerOrderFrequency,
  repeatCustomerRate,
  customersWithOrdersAbove,
  customersWithNoOrders,
  customerLocationsBreakdown,
  lastOrderDatePerCustomer,
  firstTimeBuyerOrders,
  ordersShippedThisWindow,
  weekdayVsWeekend,
  whatProductsDoWeSell,
  worstSellingProducts,
  newestProductsAdded,
  inventoryByLocation,
  inventoryLevelsByProduct,
  productsNotInInventory,
  inventoryTurnoverRate,
  daysOfInventoryRemaining,
  weekOverWeek,
  yearOverYear,
  capabilityUnsupported,
  // v7 (56-query round 3)
  ordersByPeriodCount,
  ordersUnderAmount,
  orderCountByDay,
  ordersOnWeekends,
  customerMostOrders,
  customersOneTimeOnlyPeriod,
  customerRetentionRate,
  avgDaysBetweenOrders,
  bottomProductsByUnits,
  productsZeroSalesPeriod,
  newestProductsAddedPeriod,
  varietalTopSeller,
  productCountTotal,
  inventoryPerProductSummary,
  inventoryByLocationMost,
  avgDaysToShip,
  ordersSameDayShipped,
  ordersShippedWithinDays,
  mostCommonShippingMethod,
  avgShippingCostPerOrder,
  ordersPendingShipment,
  avgDiscountPerOrder,
  refundTrendPeriod,
  totalRefundedPeriod,
  ordersBetweenHours,
  compareProductSalesPeriods,
  netAfterRefundsDiscounts,
  avgTaxPerOrder,
  crossSellByCategory,
  customersMediumValue,
  ordersNeverFulfilled,
  completedOrdersPeriod,
  allDiscountCodesUsed,
  largestLineItemByQuantity,
  productHighestAvgQty,
  ordersContainingProduct,
  ordersPendingOverDays,
  repeatPurchaseRatePeriod,
  avgTimeBetweenRepeat,
  ordersWithMultipleLines,
  guestCheckoutOrders,
  emailSubscriberOrders,
};
