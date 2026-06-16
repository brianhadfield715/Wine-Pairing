// src/analytics/sqlBuilders.js
// Each builder returns { text, values, meta } where `text` is a parameterized
// SQL string and `values` is the parameter array. Builders only read from
// analytics views and never accept raw SQL from user input — all user input
// is bound as parameters.

// Helpers ---------------------------------------------------------------

function sinceClause(days, idx) {
  // Returns SQL fragment + a single value for parameter slot idx.
  return {
    sql: `(now() - ($${idx} || ' days')::interval)`,
    value: String(Math.max(1, days)),
  };
}

// Builders --------------------------------------------------------------

function topCustomersBySpend(params) {
  const limit = params.limit || 10;
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           first_order_at, last_order_at,
           favorite_vendor, favorite_product_type
    from dim_customer_profile
    where total_spend > 0
    order by total_spend desc nulls last
    limit $1
  `;
  return { text, values: [limit], meta: { domain: 'customers', view: 'dim_customer_profile' } };
}

function customerProfile(params) {
  // Look up by email if provided in the raw question; otherwise fall back to
  // a list ordered by recency.
  const emailMatch = (params.rawQuestion || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    const text = `
      select * from dim_customer_profile
      where lower(email) = lower($1)
      limit 1
    `;
    return { text, values: [emailMatch[0]], meta: { domain: 'customers' } };
  }
  // No email — return top recent active customers as a useful default.
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           last_order_at, favorite_vendor, favorite_product_type
    from dim_customer_profile
    where last_order_at is not null
    order by last_order_at desc
    limit $1
  `;
  return { text, values: [params.limit || 10], meta: { domain: 'customers' } };
}

function customersWhoBought(params) {
  const limit = params.limit || 25;
  const days = params.days || 365;
  const filters = [];
  const values = [];
  let i = 1;

  const since = sinceClause(days, i++);
  values.push(since.value);
  filters.push(`fs.occurred_at >= ${since.sql}`);

  if (params.varietal) {
    values.push(`%${params.varietal}%`);
    filters.push(`(lower(fs.product_title) like lower($${i}) or lower(fs.variant_title) like lower($${i}))`);
    i++;
  }
  if (params.sku) {
    values.push(params.sku);
    filters.push(`fs.sku = $${i++}`);
  }
  if (params.color) {
    // crude color match via product_title text
    values.push(`%${params.color}%`);
    filters.push(`lower(fs.product_title) like lower($${i++})`);
  }
  values.push(limit);
  const text = `
    select fs.customer_id,
           c.email,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           sum(fs.quantity)::int  as units,
           sum(fs.net_revenue)::numeric(14,2) as spend,
           max(fs.occurred_at)    as last_purchase
    from fact_sales fs
    left join customers c on c.id = fs.customer_id
    where ${filters.join(' and ')}
    group by fs.customer_id, c.email, c.first_name, c.last_name
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

function newCustomers(params) {
  const days = params.days || 30;
  const since = sinceClause(days, 1);
  const text = `
    select customer_id, email, customer_name, first_order_at, total_spend, order_count
    from dim_customer_profile
    where first_order_at >= ${since.sql}
    order by first_order_at desc
    limit $2
  `;
  return { text, values: [since.value, params.limit || 25], meta: { domain: 'customers' } };
}

function lapsedCustomers(params) {
  const days = params.days || 180;
  const text = `
    select customer_id, email, customer_name, total_spend, order_count,
           last_order_at, days_since_last_order
    from dim_customer_profile
    where days_since_last_order >= $1
      and total_spend > 0
    order by total_spend desc
    limit $2
  `;
  return { text, values: [days, params.limit || 25], meta: { domain: 'customers' } };
}

function basketPairs(params = {}) {
  // Market-basket analysis: rank product pairs co-occurring in the same order.
  // Operates directly on order_line_items (with an orders join to exclude
  // cancelled orders, matching the rest of the analytics layer).
  // Schema note: order_line_items uses `title` for the product title — there
  // is no separate `product_title` column — so we alias it on the way out.
  const limit = params.limit || 20;
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

function topSkus(params) {
  const days = params.days || 90;
  const since = sinceClause(days, 1);
  const filters = [`fs.occurred_at >= ${since.sql}`];
  const values = [since.value];
  let i = 2;
  if (params.color) {
    values.push(`%${params.color}%`);
    filters.push(`lower(fs.product_title) like lower($${i++})`);
  }
  if (params.vendor) {
    values.push(`%${params.vendor}%`);
    filters.push(`lower(fs.vendor) like lower($${i++})`);
  }
  values.push(params.limit || 10);
  const text = `
    select fs.sku,
           max(fs.product_title) as product_title,
           max(fs.vendor)        as vendor,
           sum(fs.quantity)::int as units_sold,
           sum(fs.net_revenue)::numeric(14,2) as net_revenue,
           max(fs.occurred_at)   as last_sold_at
    from fact_sales fs
    where ${filters.join(' and ')}
      and fs.sku <> ''
    group by fs.sku
    order by units_sold desc, net_revenue desc
    limit $${i}
  `;
  return { text, values, meta: { domain: 'sales' } };
}

function unitsSoldPerSku(params) {
  // Same shape as topSkus but without a forced sort by units; if a SKU is
  // present we narrow to it.
  if (params.sku) {
    const text = `
      select sku, product_title, vendor, units_sold, units_sold_30d, units_sold_90d,
             net_revenue, on_hand, last_sold_at
      from dim_sku_profile
      where sku = $1
      limit 1
    `;
    return { text, values: [params.sku], meta: { domain: 'sales' } };
  }
  return topSkus(params);
}

function topVendors(params) {
  const days = params.days || 90;
  const since = sinceClause(days, 1);
  const text = `
    select coalesce(nullif(vendor, ''), '(unknown)') as vendor,
           sum(quantity)::int                       as units_sold,
           sum(net_revenue)::numeric(14,2)          as net_revenue,
           count(distinct order_id)                 as orders
    from fact_sales
    where occurred_at >= ${since.sql}
    group by 1
    order by net_revenue desc nulls last
    limit $2
  `;
  return { text, values: [since.value, params.limit || 10], meta: { domain: 'vendors' } };
}

function recentOrders(params) {
  const days = params.days || 7;
  const since = sinceClause(days, 1);
  const text = `
    select o.id, o.name, o.processed_at, o.created_at,
           o.total_price, o.financial_status, o.fulfillment_status,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
           c.email
    from orders o
    left join customers c on c.id = o.customer_id
    where coalesce(o.processed_at, o.created_at) >= ${since.sql}
      and o.cancelled_at is null
    order by coalesce(o.processed_at, o.created_at) desc
    limit $2
  `;
  return { text, values: [since.value, params.limit || 25], meta: { domain: 'orders' } };
}

function revenueSummary(params) {
  const days = params.days || 30;
  const since = sinceClause(days, 1);
  const text = `
    select
      $1::text                                       as window_days,
      count(distinct order_id)                       as orders,
      sum(quantity)::int                             as units,
      sum(net_revenue)::numeric(14,2)                as net_revenue,
      sum(gross_revenue)::numeric(14,2)              as gross_revenue,
      sum(line_discount)::numeric(14,2)              as discounts
    from fact_sales
    where occurred_at >= ${since.sql}
  `;
  return { text, values: [String(days)], meta: { domain: 'revenue' } };
}

function lowStock(params) {
  const threshold = params.money ? params.money.value : 6;
  const text = `
    select product_title, vendor, sku, variant_title, price, on_hand
    from vw_current_inventory
    where on_hand > 0
      and on_hand <= $1
      and coalesce(product_status, 'active') = 'active'
    order by on_hand asc, product_title asc
    limit $2
  `;
  return { text, values: [threshold, params.limit || 25], meta: { domain: 'inventory' } };
}

function outOfStock(params) {
  const text = `
    select product_title, vendor, sku, variant_title, price, on_hand
    from vw_current_inventory
    where on_hand <= 0
      and coalesce(product_status, 'active') = 'active'
    order by product_title asc
    limit $1
  `;
  return { text, values: [params.limit || 50], meta: { domain: 'inventory' } };
}

function inStockFiltered(params) {
  const filters = ['v.on_hand > 0', `coalesce(v.product_status, 'active') = 'active'`];
  const values = [];
  let i = 1;
  if (params.color) {
    values.push(`%${params.color}%`);
    filters.push(
      `(lower(v.product_type) like lower($${i}) or lower(v.product_title) like lower($${i}))`
    );
    i++;
  }
  if (params.varietal) {
    values.push(`%${params.varietal}%`);
    filters.push(`lower(v.product_title) like lower($${i++})`);
  }
  if (params.vendor) {
    values.push(`%${params.vendor}%`);
    filters.push(`lower(v.vendor) like lower($${i++})`);
  }
  if (params.money) {
    if (params.money.op === '<') {
      values.push(params.money.value);
      filters.push(`v.price < $${i++}`);
    } else if (params.money.op === '>') {
      values.push(params.money.value);
      filters.push(`v.price > $${i++}`);
    } else if (params.money.op === 'between') {
      values.push(params.money.min, params.money.max);
      filters.push(`v.price between $${i++} and $${i++}`);
    }
  }
  values.push(params.limit || 25);
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

function deadInventory(params) {
  const days = params.days || 180;
  const text = `
    select sku, product_title, vendor, on_hand, units_sold, last_sold_at
    from dim_sku_profile
    where on_hand > 0
      and (last_sold_at is null or last_sold_at < now() - ($1 || ' days')::interval)
    order by on_hand desc, sku asc
    limit $2
  `;
  return { text, values: [String(days), params.limit || 25], meta: { domain: 'inventory' } };
}

function lowStockHighVelocity(params) {
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
  const threshold = params.money ? params.money.value : 6;
  const minSales = 2;
  return { text, values: [threshold, minSales, params.limit || 25], meta: { domain: 'inventory' } };
}

module.exports = {
  topCustomersBySpend,
  customerProfile,
  customersWhoBought,
  customerCount,
  newCustomers,
  lapsedCustomers,
  basketPairs,
  topSkus,
  unitsSoldPerSku,
  topVendors,
  recentOrders,
  revenueSummary,
  lowStock,
  outOfStock,
  inStockFiltered,
  deadInventory,
  lowStockHighVelocity,
};
