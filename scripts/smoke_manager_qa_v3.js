#!/usr/bin/env node
// scripts/smoke_manager_qa_v3.js
// Third-tier smoke focused on the latest language-coverage upgrade:
//   A) Exact single-date parsing (MM/DD/YYYY, MM/DD/YY, YYYY-MM-DD, named-month)
//   B) Time-series questions (each day / by day / weekly / monthly)
//   C) Case-insensitive customer resolution
//   D) "How much has X spent" lowercase phrasing
//   E) Customer units bought
//   F) Product detail by partial title
//   G) Inventory value (retail; cost flagged unavailable)
//   H) Data coverage / sync metadata
//   I) Inventory counts (in-stock / oos / low / threshold)
//   J) Total units on hand
//   K) Regression sweep
//
// Coexists with smoke_manager_qa.js and smoke_manager_qa_v2.js.

const assert = require('assert');
const http = require('http');

// Env setup -----------------------------------------------------------------
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34605';
process.env.QA_USER = 'smoke';
process.env.QA_PASS = 'smoke';
process.env.SHOP_DOMAIN  = 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = 'placeholder';

let failures = 0;
function header(t) { console.log('\n=== ' + t + ' ==='); }
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures += 1; console.log('  FAIL ' + label + ' — ' + e.message); }
}

// ---------------------------------------------------------------------------
// 1) Pure-unit tests
// ---------------------------------------------------------------------------

header('temporal parser — exact dates');
const temporal = require('../src/analytics/temporalParser');
function tf(q) { return temporal.parse(q); }

check('1/25/2026 → exact_date Jan 25, 2026', () => {
  const r = tf('how much did we sell on 1/25/2026');
  assert.strictEqual(r.mode, 'exact_date');
  assert.strictEqual(r.label, 'Jan 25, 2026');
  assert.strictEqual(r.sinceIso.slice(0, 10), '2026-01-25');
  assert.strictEqual(r.untilIso.slice(0, 10), '2026-01-26');
  assert.strictEqual(r.grain, 'day');
});
check('01/25/2026 → same result', () => {
  const r = tf('how much did we sell on 01/25/2026');
  assert.strictEqual(r.mode, 'exact_date');
  assert.strictEqual(r.label, 'Jan 25, 2026');
});
check('1/25/26 → 2026', () => {
  const r = tf('how much did we sell on 1/25/26');
  assert.strictEqual(r.mode, 'exact_date');
  assert.strictEqual(r.sinceIso.slice(0, 10), '2026-01-25');
});
check('2026-01-25 → exact date', () => {
  const r = tf('how much did we sell on 2026-01-25');
  assert.strictEqual(r.mode, 'exact_date');
  assert.strictEqual(r.sinceIso.slice(0, 10), '2026-01-25');
});
check('Jan 25 2026 → exact date', () => {
  const r = tf('how much did we sell on Jan 25 2026');
  assert.strictEqual(r.mode, 'exact_date');
  assert.strictEqual(r.label, 'Jan 25, 2026');
});
check('January 25, 2026 → exact date', () => {
  const r = tf('how much did we sell on January 25, 2026');
  assert.strictEqual(r.mode, 'exact_date');
});
check('13/40/2026 → invalid_date', () => {
  const r = tf('how much did we sell on 13/40/2026');
  assert.strictEqual(r.error, 'invalid_date');
});
check('"yesterday" still works (no regression)', () => {
  const r = tf('how much did we sell yesterday');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'yesterday');
});

header('temporal parser — time-series grain');
check('"each day last week" → seriesGrain=day + window=last week', () => {
  const r = tf('how many orders did we have each day last week');
  assert.strictEqual(r.label, 'last week');
  assert.strictEqual(r.seriesGrain, 'day');
});
check('"by day" → day', () => {
  const r = tf('show me sales by day last week');
  assert.strictEqual(r.seriesGrain, 'day');
});
check('"daily" → day', () => {
  const r = tf('daily order count last week');
  assert.strictEqual(r.seriesGrain, 'day');
});
check('"by week this quarter" → week', () => {
  const r = tf('orders by week this quarter');
  assert.strictEqual(r.seriesGrain, 'week');
});
check('"by month this year" → month', () => {
  const r = tf('sales by month this year');
  assert.strictEqual(r.seriesGrain, 'month');
});

header('intent parser — lower-case customer names');
const parser = require('../src/analytics/intentParser');
check('"how much has brian hadfield spent" → customer_spend', () => {
  const p = parser.parse('how much has brian hadfield spent');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
  assert.strictEqual(p.params.scope, 'customer');
});
check('"How much has Brian Hadfield spent" → customer_spend', () => {
  const p = parser.parse('How much has Brian Hadfield spent');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"how much has BRIAN HADFIELD spent" → customer_spend', () => {
  const p = parser.parse('how much has BRIAN HADFIELD spent');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"how much has brian hadfield spent last month" → customer_spend + last month', () => {
  const p = parser.parse('how much has brian hadfield spent last month');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.timeframe.label, 'last month');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"how much has brian hadfield spent all time" → all_time + customer name', () => {
  const p = parser.parse('how much has brian hadfield spent all time');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.timeframe.mode, 'all_time');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"what has brian hadfield spent with us" → customer_spend (trim "with us")', () => {
  const p = parser.parse('what has brian hadfield spent with us');
  assert.strictEqual(p.intent, 'customer_spend');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"when did brian hadfield last shop with us" → customer_last_order', () => {
  const p = parser.parse('when did brian hadfield last shop with us');
  assert.strictEqual(p.intent, 'customer_last_order');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"how many units has brian hadfield bought" → customer_units_bought', () => {
  const p = parser.parse('how many units has brian hadfield bought');
  assert.strictEqual(p.intent, 'customer_units_bought');
  assert.strictEqual(p.params.customerHint, 'Brian Hadfield');
});
check('"how many bottles has brian hadfield bought" → customer_units_bought', () => {
  const p = parser.parse('how many bottles has brian hadfield bought');
  assert.strictEqual(p.intent, 'customer_units_bought');
});
check('"what did brian hadfield buy last week" → customer_recent_purchases', () => {
  const p = parser.parse('what did brian hadfield buy last week');
  assert.strictEqual(p.intent, 'customer_recent_purchases');
});

header('intent parser — new families');
const intentCases = [
  // Exact dates
  ['how much did we sell on 1/25/2026',             'sales_summary'],
  ['how much did we sell on 01/25/2026',            'sales_summary'],
  ['how much did we sell on 2026-01-25',            'sales_summary'],
  ['how many orders did we have on 1/25/2026',      'sales_summary'],
  ['what sold best on 1/25/2026',                   'top_items_by_units'],
  ['who bought Chardonnay on 1/25/2026',            'customers_who_bought'],
  // Time series
  ['how many orders did we have each day last week','sales_time_series'],
  ['how many orders did we have by day last week',  'sales_time_series'],
  ['show me orders by day last week',               'sales_time_series'],
  // v7 upgrade: "daily order count" now routes to the dedicated grouped
  // intent (order_count_by_day) which returns per-day rows directly.
  ['daily order count last week',                   'order_count_by_day'],
  ['how much did we sell each day last week',       'sales_time_series'],
  ['revenue by day this month',                     'sales_time_series'],
  ['units sold by day last week',                   'sales_time_series'],
  ['orders by week this quarter',                   'sales_time_series'],
  ['sales by month this year',                      'sales_time_series'],
  // Product detail search
  ['tell me the details about Sancerre',            'product_detail_search'],
  ['give me the details on Pinot Grigio',           'product_detail_search'],
  ['tell me about olive brine',                     'product_detail_search'],
  ['show me product details for gift box',          'product_detail_search'],
  ['show me the details for SKU DTALPG22',          'product_detail_search'],
  // Inventory value
  ['what is our inventory value',                            'inventory_value_total'],
  ['what is our total inventory value',                      'inventory_value_total'],
  ['what is the value of our current inventory',             'inventory_value_total'],
  ['what is our retail inventory value',                     'inventory_value_total'],
  ['what is our cost inventory value',                       'inventory_value_total'],
  ['what is the value of our stock on hand',                 'inventory_value_total'],
  ['what is our white wine inventory value',                 'inventory_value_total'],
  ['what is our dead inventory value',                       'inventory_value_dead'],
  ['what is the value of low-stock items',                   'inventory_value_low_stock'],
  ['show me inventory value by vendor',                      'inventory_value_by_vendor'],
  ['show me inventory value by category',                    'inventory_value_by_category'],
  ['which vendors represent the most inventory value',       'inventory_value_by_vendor'],
  // Data coverage
  ['what date range does the order data cover',              'data_coverage_orders'],
  ['what dates do the order records cover',                  'data_coverage_orders'],
  ['how far back does the order data go',                    'data_coverage_orders'],
  ['what is the earliest order date in the database',        'data_coverage_orders'],
  ['what is the latest order date in the database',          'data_coverage_orders'],
  ['what order date range is currently synced',              'data_coverage_orders'],
  ['how many orders are in the analytics database',          'data_coverage_orders'],
  ['how many customers are in the analytics database',       'data_coverage_customers'],
  ['how many products are in the analytics database',        'data_coverage_products'],
  ['what is the current data coverage for orders, customers, and inventory', 'data_coverage_all'],
  // Inventory counts
  ['how many products have inventory currently',             'inventory_count_in_stock'],
  ['how many products are currently in stock',               'inventory_count_in_stock'],
  ['how many SKUs have inventory currently',                 'inventory_count_in_stock'],
  ['how many variants have inventory currently',             'inventory_count_in_stock'],
  ['how many products are out of stock',                     'inventory_count_out_of_stock'],
  ['how many products are low stock',                        'inventory_count_low_stock'],
  ['how many products have fewer than 6 units',              'inventory_count_threshold'],
  ['how many products have more than 10 units',              'inventory_count_threshold'],
  // Units on hand
  ['how many units are in the store',                        'inventory_units_on_hand'],
  ['how many units do we currently have',                    'inventory_units_on_hand'],
  ['how many bottles are in the store',                      'inventory_units_on_hand'],
  ['how many bottles do we have on hand',                    'inventory_units_on_hand'],
  ['what is our total on-hand unit count',                   'inventory_units_on_hand'],
  ['how many white wine units are in the store',             'inventory_units_on_hand'],
  ['how many sparkling units are in the store',              'inventory_units_on_hand'],
  // Regression
  ['what is low stock',                                      'low_stock'],
  ['top customers by spend',                                 'top_customers_by_spend'],
  ['what sells together',                                    'basket_pairs'],
  ['which products have not sold in the last 30 days',       'dead_inventory'],
];
for (const [q, expected] of intentCases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parser.parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

check('metric=order_count for "how many orders did we have each day last week"', () => {
  const p = parser.parse('how many orders did we have each day last week');
  assert.strictEqual(p.params.metric, 'orders');
  assert.strictEqual(p.params.grain, 'day');
});
check('metric=units for "units sold by day last week"', () => {
  const p = parser.parse('units sold by day last week');
  assert.strictEqual(p.params.metric, 'units');
  assert.strictEqual(p.params.grain, 'day');
});
check('metric=revenue for "how much did we sell each day last week"', () => {
  const p = parser.parse('how much did we sell each day last week');
  assert.strictEqual(p.params.metric, 'revenue');
});
check('metric=aov for "average order value by day last week"', () => {
  const p = parser.parse('average order value by day last week');
  assert.strictEqual(p.params.metric, 'aov');
  assert.strictEqual(p.params.grain, 'day');
});
check('scope=meta for data_coverage', () => {
  const p = parser.parse('what date range does the order data cover');
  assert.strictEqual(p.params.scope, 'meta');
});
check('scope=inventory for inventory_value_total', () => {
  const p = parser.parse('what is our inventory value');
  assert.strictEqual(p.params.scope, 'inventory');
});
check('exact_date does NOT fall back to all_time', () => {
  const p = parser.parse('how much did we sell on 1/25/2026');
  assert.notStrictEqual(p.params.timeframe.mode, 'all_time');
  assert.strictEqual(p.params.timeframe.mode, 'exact_date');
});
check('invalid date triggers invalid_date intent', () => {
  const p = parser.parse('how much did we sell on 13/40/2026');
  assert.strictEqual(p.intent, 'invalid_date');
});

// ---------------------------------------------------------------------------
// 2) Live tests with stubbed DB
// ---------------------------------------------------------------------------
header('live /shopify-qa with stubbed db (new families)');

const db = require('../src/db');
db.isEnabled = () => true;

const queryLog = [];
db.query = async function (text, values) {
  queryLog.push({ text, values });
  const t = String(text || '');

  // Customer resolver — exact full-name lowercased
  if (/from customers\s+where lower\(trim\(coalesce\(first_name/.test(t)) {
    const name = (values[0] || '').toLowerCase();
    if (name === 'brian hadfield') return { rows: [{ customer_id: 100, email: 'brian@example.com', customer_name: 'Brian Hadfield', total_spent: 8421 }] };
    if (name === 'terry white')    return { rows: [{ customer_id: 101, email: 'terry@example.com', customer_name: 'Terry White', total_spent: 1200 }] };
    return { rows: [] };
  }
  if (/from customers\s+where \(lower\(coalesce\(first_name/.test(t)) {
    return { rows: [] };
  }

  // Storewide sales summary (single row)
  if (/from fact_sales\s*$|from fact_sales[\s\S]+as average_order_value/.test(t) && /from fact_sales\b/.test(t) && !/date_trunc/.test(t)) {
    return { rows: [{ orders: 7, units: 45, net_revenue: 1820.50, gross_revenue: 1900, discounts: 50, average_order_value: 260.07 }] };
  }

  // Time-series SQL (date_trunc)
  if (/date_trunc/.test(t) && /from fact_sales/.test(t)) {
    return { rows: [
      { bucket: '2026-06-08T00:00:00Z', orders: 11, units: 25, net_revenue: 480, average_order_value: 43.6 },
      { bucket: '2026-06-09T00:00:00Z', orders: 14, units: 32, net_revenue: 612, average_order_value: 43.7 },
      { bucket: '2026-06-10T00:00:00Z', orders:  9, units: 18, net_revenue: 410, average_order_value: 45.6 },
    ] };
  }

  // top items (by units / revenue) — single row enough
  if (/from fact_sales fs[\s\S]+group by fs.product_id, fs.sku/.test(t)) {
    return { rows: [{ product_id: 1, sku: 'A', product_title: 'Sample Wine', units_sold: 8, net_revenue: 240 }] };
  }

  // customers_who_bought
  if (/from fact_sales fs[\s\S]+group by fs.customer_id/.test(t)) {
    return { rows: [{ customer_id: 100, email: 'brian@example.com', customer_name: 'Brian Hadfield', units: 4, spend: 160 }] };
  }

  // customer_spend / customer_units_bought (where fs.customer_id = $1)
  if (/from fact_sales fs\s+where fs.customer_id = \$1/.test(t)) {
    return { rows: [{ customer_id: 100, units: 42, order_count: 9, total_spend: 1680, average_order_value: 186.67, first_order_at: '2025-09-01T00:00:00Z', last_order_at: '2026-06-10T00:00:00Z' }] };
  }

  // customer_last_order (from dim_customer_profile by id)
  if (/from dim_customer_profile\s+where customer_id = \$1/.test(t)) {
    return { rows: [{ customer_id: 100, email: 'brian@example.com', customer_name: 'Brian Hadfield', last_order_at: '2026-06-10T00:00:00Z', days_since_last_order: 6, order_count: 9, total_spend: 1680 }] };
  }

  // Product detail search resolver (with baseCols subquery shape) →
  // exact / starts-with / contains
  if (/from products p\s+where lower\(p\.title\) = lower/.test(t)) {
    const hint = (values[0] || '').toLowerCase();
    if (hint === 'sancerre') return { rows: [{ product_id: 200, product_title: 'Sancerre', vendor: 'Loire', handle: 'sancerre', on_hand_total: 8, min_price: 35, primary_sku: 'SNC-1' }] };
    return { rows: [] };
  }
  if (/from products p\s+where lower\(p\.title\) like lower/.test(t)) {
    const hint = (values[0] || '').toLowerCase();
    if (/sancerre/.test(hint)) return { rows: [{ product_id: 200, product_title: 'Sancerre', vendor: 'Loire', handle: 'sancerre', on_hand_total: 8, min_price: 35, primary_sku: 'SNC-1' }] };
    if (/pinot grigio/.test(hint)) {
      return { rows: [
        { product_id: 201, product_title: 'Alois Lageder Pinot Grigio', vendor: 'Alois Lageder', handle: 'alois', on_hand_total: 12, min_price: 24, primary_sku: 'DTALPG22' },
        { product_id: 202, product_title: 'Santa Margherita Pinot Grigio', vendor: 'SantaM', handle: 'sm', on_hand_total: 6, min_price: 27, primary_sku: 'SMPG-1' },
      ] };
    }
    if (/olive brine/.test(hint)) return { rows: [{ product_id: 203, product_title: 'Castelvetrano Olive Brine', vendor: 'Pantry', handle: 'olive-brine', on_hand_total: 24, min_price: 6, primary_sku: 'OLV-1' }] };
    if (/gift box/.test(hint)) {
      return { rows: [
        { product_id: 204, product_title: 'Holiday Gift Box', vendor: 'Internal', handle: 'gb-holiday', on_hand_total: 10, min_price: 60, primary_sku: 'GB-H' },
        { product_id: 205, product_title: 'Premium Gift Box', vendor: 'Internal', handle: 'gb-premium', on_hand_total: 4, min_price: 120, primary_sku: 'GB-P' },
      ] };
    }
    return { rows: [] };
  }
  if (/from variants v join products p\s+on p.id = v.product_id\s+where v.sku = \$1/.test(t)) {
    return { rows: [{ product_id: 201, product_title: 'Alois Lageder Pinot Grigio', vendor: 'Alois Lageder', handle: 'alois' }] };
  }

  // productDetail (resolved product_id present)
  if (/from fact_sales fs[\s\S]+where fs.product_id = \$1/.test(t)) {
    return { rows: [{ product_id: values[0], product_title: 'Sancerre', units_sold: 33, net_revenue: 1155, orders: 22, customers: 18, first_sold: '2025-09-01T00:00:00Z', last_sold: '2026-06-10T00:00:00Z' }] };
  }

  // Inventory value: total
  if (/from vw_current_inventory v\s*$|coalesce\(sum\(v\.on_hand \* v\.price\)/.test(t) && !/group by 1/.test(t) && !/dim_sku_profile/.test(t)) {
    return { rows: [{ retail_value: 184250.55, on_hand_units: 4823, sku_count: 412 }] };
  }
  // Inventory value by vendor / category
  if (/coalesce\(sum\(v\.on_hand \* v\.price\)/.test(t) && /group by 1/.test(t)) {
    if (/vendor/.test(t)) return { rows: [{ vendor: 'Premier Vendor', retail_value: 42100, on_hand_units: 800, sku_count: 75 }] };
    return { rows: [{ category: 'Red', retail_value: 85000, on_hand_units: 2100, sku_count: 180 }] };
  }
  // Inventory value dead
  if (/from dim_sku_profile d[\s\S]+join vw_current_inventory v/.test(t)) {
    return { rows: [{ retail_value: 8400, on_hand_units: 220, sku_count: 35 }] };
  }
  // Inventory value low stock
  if (/from vw_current_inventory v\s+where v\.on_hand > 0\s+and v\.on_hand <= \$1\s+and coalesce\(v\.product_status/.test(t) && /coalesce\(sum\(v\.on_hand \* v\.price\)/.test(t)) {
    return { rows: [{ retail_value: 2400, on_hand_units: 45, sku_count: 18 }] };
  }

  // Inventory counts
  if (/count\(distinct v\.product_id\)::int as product_count/.test(t)) {
    if (/v\.on_hand <= 0/.test(t))   return { rows: [{ product_count: 14, sku_count: 22 }] };
    if (/v\.on_hand > 0\s+and v\.on_hand <= \$1/.test(t)) return { rows: [{ product_count: 37, sku_count: 60, threshold: values[0] }] };
    if (/v\.on_hand < \$1/.test(t) || /v\.on_hand > \$1/.test(t)) return { rows: [{ product_count: 80, sku_count: 130 }] };
    return { rows: [{ product_count: 842, sku_count: 1567, on_hand_units: 12842 }] };
  }
  // Units on hand
  if (/coalesce\(sum\(v\.on_hand\), 0\)::int\s+as on_hand_units/.test(t)) {
    return { rows: [{ on_hand_units: 12842, product_count: 842, sku_count: 1567 }] };
  }

  // Data coverage
  if (/min\(coalesce\(processed_at, created_at\)\) as earliest_order_at/.test(t)) {
    return { rows: [{ earliest_order_at: '2025-06-16T00:00:00Z', latest_order_at: '2026-06-16T00:00:00Z', total_orders: 5240, active_orders: 5195 }] };
  }
  if (/total_customers[\s\S]+customers_with_orders/.test(t)) {
    return { rows: [{ total_customers: 1820, customers_with_orders: 1410, earliest_customer_at: '2025-01-01T00:00:00Z', latest_customer_at: '2026-06-16T00:00:00Z' }] };
  }
  if (/total_products[\s\S]+active_products[\s\S]+total_variants/.test(t)) {
    return { rows: [{ total_products: 980, active_products: 842, total_variants: 1567, products_in_stock: 842 }] };
  }
  if (/select\s+\(select min\(coalesce\(processed_at/.test(t)) {
    return { rows: [{ earliest_order_at: '2025-06-16T00:00:00Z', latest_order_at: '2026-06-16T00:00:00Z', total_orders: 5240, total_customers: 1820, total_products: 980, total_variants: 1567, products_in_stock: 842 }] };
  }

  // basket_pairs
  if (/from order_line_items a[\s\S]+join order_line_items b/.test(t)) {
    return { rows: [{ product_a: 'A', product_b: 'B', times_bought_together: 5 }] };
  }
  // top_customers_by_spend / dim_customer_profile
  if (/from dim_customer_profile\s+where total_spend > 0/.test(t)) {
    return { rows: [{ customer_id: 100, email: 'brian@example.com', customer_name: 'Brian Hadfield', total_spend: 8421, order_count: 33 }] };
  }
  // low_stock
  if (/from vw_current_inventory\s+where on_hand > 0\s+and on_hand <= \$1/.test(t)) {
    return { rows: [{ product_title: 'Tiny', sku: 'T', on_hand: 3, price: 30 }] };
  }
  // dead inventory (dim_sku_profile)
  if (/from dim_sku_profile[\s\S]+last_sold_at is null or last_sold_at </.test(t)) {
    return { rows: [{ sku: 'X', product_title: 'Stale', vendor: 'V', on_hand: 10, units_sold: 0, last_sold_at: null }] };
  }

  return { rows: [] };
};

require('../server.js');

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port: Number(process.env.PORT), path, method,
        headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); } catch { parsed = { _raw: buf }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const auth = 'Basic ' + Buffer.from('smoke:smoke').toString('base64');
async function ask(q) {
  return request('/shopify-qa', { method: 'POST', headers: { Authorization: auth }, body: { question: q } });
}

(async () => {
  await new Promise((r) => setTimeout(r, 250));

  // A. exact date sales
  header('live A: exact-date sales');
  const a1 = await ask('how much did we sell on 1/25/2026');
  check('exact-date routes to sales_summary, timeframe.mode=exact_date', () => {
    assert.strictEqual(a1.body.intent, 'sales_summary');
    assert.strictEqual(a1.body.meta.timeframe.mode, 'exact_date');
    assert.notStrictEqual(a1.body.meta.timeframe.mode, 'all_time');
  });
  check('exact-date answer uses Jan 25, 2026 label', () => {
    assert.ok(/Jan 25, 2026/.test(a1.body.answer));
  });
  const aBad = await ask('how much did we sell on 13/40/2026');
  check('invalid date → status=error + intent=invalid_date', () => {
    assert.strictEqual(aBad.body.intent, 'invalid_date');
    assert.strictEqual(aBad.body.meta.status, 'error');
    assert.strictEqual(aBad.body.meta.error, 'invalid_date');
  });

  // B. time-series
  header('live B: time-series');
  const b1 = await ask('how many orders did we have each day last week');
  check('time-series intent + grain=day + metric=orders', () => {
    assert.strictEqual(b1.body.intent, 'sales_time_series');
    assert.strictEqual(b1.body.meta.timeframe.seriesGrain, 'day');
    assert.strictEqual(b1.body.meta.params.metric, 'orders');
  });
  check('time-series returns multiple rows', () => assert.strictEqual(b1.body.data.length, 3));
  check('time-series answer lists each bucket', () => {
    assert.ok(/2026-06-08/.test(b1.body.answer));
    assert.ok(/2026-06-10/.test(b1.body.answer));
  });

  // C+D. lower-case customer resolution + has-spent phrasing
  header('live C/D: case-insensitive customer + has-spent phrasing');
  const cd1 = await ask('how much has brian hadfield spent');
  check('lowercase customer resolved', () => {
    assert.strictEqual(cd1.body.intent, 'customer_spend');
    assert.strictEqual(cd1.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
    assert.strictEqual(cd1.body.meta.status, 'ok');
  });
  const cd2 = await ask('How much has Brian Hadfield spent');
  check('mixed-case customer resolves to same person', () => {
    assert.strictEqual(cd2.body.meta.resolved.customer.customer_id, 100);
  });
  const cd3 = await ask('how much has BRIAN HADFIELD spent');
  check('UPPERCASE customer resolves to same person', () => {
    assert.strictEqual(cd3.body.meta.resolved.customer.customer_id, 100);
  });
  const cd4 = await ask('how much has brian hadfield spent last month');
  check('has-spent with last month timeframe', () => {
    assert.strictEqual(cd4.body.meta.timeframe.label, 'last month');
    assert.strictEqual(cd4.body.intent, 'customer_spend');
  });
  const cd5 = await ask('what has brian hadfield spent with us');
  check('"with us" tail trimmed; customer still resolved', () => {
    assert.strictEqual(cd5.body.intent, 'customer_spend');
    assert.strictEqual(cd5.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
  });

  // E. customer units bought
  header('live E: customer units bought');
  const e1 = await ask('how many units has brian hadfield bought');
  check('intent=customer_units_bought + resolved + units in answer', () => {
    assert.strictEqual(e1.body.intent, 'customer_units_bought');
    assert.strictEqual(e1.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
    assert.ok(/42 units/.test(e1.body.answer));
  });
  const e2 = await ask('how many bottles has brian hadfield bought');
  check('"bottles" synonym also routes to customer_units_bought', () => {
    assert.strictEqual(e2.body.intent, 'customer_units_bought');
  });
  const e3 = await ask('how many units did brian hadfield buy last month');
  check('windowed customer_units_bought', () => {
    assert.strictEqual(e3.body.intent, 'customer_units_bought');
    assert.strictEqual(e3.body.meta.timeframe.label, 'last month');
  });

  // F. product detail by partial title
  header('live F: product detail by partial title');
  const f1 = await ask('tell me the details about Sancerre');
  check('single-match product → ok + resolved product', () => {
    assert.strictEqual(f1.body.intent, 'product_detail_search');
    assert.strictEqual(f1.body.meta.status, 'ok');
    assert.strictEqual(f1.body.meta.resolved.product.product_title, 'Sancerre');
  });
  const f2 = await ask('give me the details on Pinot Grigio');
  check('ambiguous Pinot Grigio → disambiguation', () => {
    assert.strictEqual(f2.body.meta.status, 'disambiguation');
    assert.ok(/Alois Lageder/.test(f2.body.answer));
    assert.ok(/Santa Margherita/.test(f2.body.answer));
  });
  const f3 = await ask('show me product details for gift box');
  check('ambiguous gift box → disambiguation', () => {
    assert.strictEqual(f3.body.meta.status, 'disambiguation');
    assert.strictEqual(f3.body.data.length, 2);
  });
  const f4 = await ask('tell me about olive brine');
  check('olive brine → single match resolved', () => {
    assert.strictEqual(f4.body.meta.status, 'ok');
    assert.strictEqual(f4.body.meta.resolved.product.product_title, 'Castelvetrano Olive Brine');
  });
  const f5 = await ask('tell me the details about Nonexistent Wine XYZ');
  check('unknown product → not_found', () => {
    assert.strictEqual(f5.body.meta.status, 'not_found');
  });

  // G. inventory value
  header('live G: inventory value');
  const g1 = await ask('what is our inventory value');
  check('inventory_value_total + retail framing', () => {
    assert.strictEqual(g1.body.intent, 'inventory_value_total');
    assert.ok(/retail/i.test(g1.body.answer));
    assert.ok(/\$184,250/.test(g1.body.answer));
  });
  const g2 = await ask('what is our cost inventory value');
  check('cost variant clearly notes cost is unavailable', () => {
    assert.ok(/cost-based.*not available/i.test(g2.body.answer));
  });
  const g3 = await ask('what is our dead inventory value');
  check('inventory_value_dead routes correctly', () => {
    assert.strictEqual(g3.body.intent, 'inventory_value_dead');
  });
  const g4 = await ask('show me inventory value by vendor');
  check('inventory_value_by_vendor', () => {
    assert.strictEqual(g4.body.intent, 'inventory_value_by_vendor');
    assert.ok(/Premier Vendor/.test(g4.body.answer));
  });

  // H. data coverage
  header('live H: data coverage');
  const h1 = await ask('what date range does the order data cover');
  check('data_coverage_orders + meta status ok + answer contains 5,240 orders', () => {
    assert.strictEqual(h1.body.intent, 'data_coverage_orders');
    assert.strictEqual(h1.body.domain, 'meta');
    assert.ok(/5,240 orders/.test(h1.body.answer));
    assert.ok(/2025-06-16/.test(h1.body.answer));
    assert.ok(/2026-06-16/.test(h1.body.answer));
  });
  const h2 = await ask('how many customers are in the analytics database');
  check('data_coverage_customers', () => assert.strictEqual(h2.body.intent, 'data_coverage_customers'));
  const h3 = await ask('how many products are in the analytics database');
  check('data_coverage_products', () => assert.strictEqual(h3.body.intent, 'data_coverage_products'));

  // I. inventory counts
  header('live I: inventory counts');
  const i1 = await ask('how many products have inventory currently');
  check('inventory_count_in_stock + 842 products in answer', () => {
    assert.strictEqual(i1.body.intent, 'inventory_count_in_stock');
    assert.ok(/842 products/.test(i1.body.answer));
  });
  const i2 = await ask('how many products are out of stock');
  check('inventory_count_out_of_stock', () => assert.strictEqual(i2.body.intent, 'inventory_count_out_of_stock'));
  const i3 = await ask('how many products have fewer than 6 units');
  check('inventory_count_threshold + units_below extracted', () => {
    assert.strictEqual(i3.body.intent, 'inventory_count_threshold');
    assert.deepStrictEqual(i3.body.meta.params.units_below, { op: '<', value: 6 });
  });

  // J. units on hand
  header('live J: total units on hand');
  const j1 = await ask('how many units are in the store');
  check('inventory_units_on_hand + 12,842 units', () => {
    assert.strictEqual(j1.body.intent, 'inventory_units_on_hand');
    assert.ok(/12,842 units/.test(j1.body.answer));
  });
  const j2 = await ask('how many bottles are in the store');
  check('"bottles" synonym → inventory_units_on_hand', () => {
    assert.strictEqual(j2.body.intent, 'inventory_units_on_hand');
  });
  const j3 = await ask('how many white wine units are in the store');
  check('filtered "white wine" still routes correctly', () => {
    assert.strictEqual(j3.body.intent, 'inventory_units_on_hand');
    assert.strictEqual(j3.body.meta.params.color, 'white');
  });

  // K. regression
  header('live K: regression');
  const k1 = await ask('what is low stock');
  check('low_stock still works', () => assert.strictEqual(k1.body.intent, 'low_stock'));
  const k2 = await ask('top customers by spend');
  check('top_customers_by_spend still works', () => assert.strictEqual(k2.body.intent, 'top_customers_by_spend'));
  const k3 = await ask('what sells together');
  check('basket_pairs still works', () => assert.strictEqual(k3.body.intent, 'basket_pairs'));
  const k4 = await ask('which products have not sold in the last 30 days');
  check('dead_inventory + day_count=30 still captured', () => {
    assert.strictEqual(k4.body.intent, 'dead_inventory');
    assert.strictEqual(k4.body.meta.params.day_count, 30);
  });

  // Auth + /recommend
  const noAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('no auth → 401', () => assert.strictEqual(noAuth.status, 401));
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('/recommend 200 + recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });

  console.log('');
  if (failures) {
    console.error(`manager-qa v3 smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`manager-qa v3 smoke: ALL OK (${queryLog.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('manager-qa v3 smoke crashed:', e);
  process.exit(1);
});
