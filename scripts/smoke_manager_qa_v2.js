#!/usr/bin/env node
// scripts/smoke_manager_qa_v2.js
// Second-tier smoke focused on the language-expansion pass (families A..L
// from the spec). Coexists with smoke_manager_qa.js.
//
// Covers:
//   A) Storewide sales: revenue / units / orders / aov across time windows
//   B) Top items / top wines / "sold best on Sunday" / top 20
//   C) Product/SKU detail (units, revenue, avg price, last sold, inventory,
//      top customers for SKU)
//   D) Customer name questions with time filters incl. "yesterday"
//      and customer last-order / taste-profile questions
//   E) Customer segments (premium / one-time / not purchased in N days /
//      bought both X and Y / new this month / strongest recurring)
//   F) Recent purchases including "the last thing X bought"
//   G) Basket pairs with timeframe + bought_with_product hint extraction
//   H) Inventory low/out/below-N-units/top-sellers-low-stock
//   I) Dead/aging/no-movement/no-sales-in-N-days/slow-moving
//   J) Vendor / category / varietal trend including period-over-period
//      vs prior day
//   K) Disambiguation / not-found
//
// Auth + /recommend integrity also re-asserted.

const assert = require('assert');
const http = require('http');

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34604';
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
// Pure unit-level intent classification tests (no HTTP)
// ---------------------------------------------------------------------------
header('intent classification (parse) — language expansion pass');
const parser = require('../src/analytics/intentParser');

const cases = [
  // A. storewide sales
  ['how much did we sell yesterday',          'sales_summary'],
  ['how much did we sell last week',          'sales_summary'],
  ['how much did we sell last month',         'sales_summary'],
  ['how much did we sell this month',         'sales_summary'],
  ['how much did we sell this quarter',       'sales_summary'],
  ['how much did we sell this year',          'sales_summary'],
  ['how much did we sell all time',           'sales_summary'],
  ['what did we do yesterday',                'sales_summary'],
  ['what did we do last week',                'sales_summary'],
  ['what were total sales yesterday',         'sales_summary'],
  ['what were total sales last week',         'sales_summary'],
  ['what was our revenue yesterday',          'sales_summary'],
  ['what was our revenue last month',         'sales_summary'],
  ['sales yesterday',                         'sales_summary'],
  ['sales this month',                        'sales_summary'],
  ['store sales yesterday',                   'sales_summary'],
  ['total revenue this quarter',              'sales_summary'],
  ['net sales this month',                    'sales_summary'],
  ['month to date sales',                     'sales_summary'],
  ['quarter to date sales',                   'sales_summary'],
  ['year to date sales',                      'sales_summary'],
  ['how many units did we sell yesterday',    'sales_summary'],
  ['how many items did we sell yesterday',    'sales_summary'],
  ['how many bottles did we sell yesterday',  'sales_summary'],
  ['how many orders did we have yesterday',   'sales_summary'],
  ['how many orders did we have last week',   'sales_summary'],
  ['what was average order value yesterday',  'sales_summary'],
  ['what was average order value last month', 'sales_summary'],

  // B. top items
  ['what were the top items sold yesterday',  'top_items_by_units'],
  ['what were the top products sold yesterday','top_items_by_units'],
  ['what sold best yesterday',                'top_items_by_units'],
  ['what were the best sellers last week',    'top_items_by_units'],
  ['what were the top wines sold last month', 'top_items_by_units'],
  ['what were the top items by revenue last month', 'top_items_by_revenue'],
  ['what were the top items by units last month',   'top_items_by_units'],
  // v8: "top SKUs" routes to the dedicated SKU-granular intent
  ['what were the top SKUs by units this week',     'sku_top_seller'],
  ['what were the top SKUs by revenue this month',  'sku_top_seller'],
  ['what are our best-selling wines all time',      'top_items_by_units'],
  ['what are our best-selling whites this quarter', 'top_items_by_units'],
  ['what are our best-selling reds this month',     'top_items_by_units'],
  ['what are our top sparkling wines',              'top_items_by_units'],
  ['what are the top gift items',                   'top_items_by_units'],
  ['what sold best on Sunday',                      'top_items_by_units'],
  ['show me the top 20 items sold this month',      'top_items_by_units'],

  // C. product / SKU detail
  ['how many units of SKU DTALPG22 have we sold',                'product_detail'],
  ['how many units of SKU DTALPG22 have we sold this month',     'product_detail'],
  ['how much revenue has SKU DTALPG22 generated',                'product_detail'],
  ['give me sales details for SKU 50082043',                     'product_detail'],
  ['what is the average selling price for SKU DTALPG22',         'sku_avg_price'],
  ['how many orders included SKU DTALPG22',                      'product_detail'],
  ['when was SKU DTALPG22 last sold',                            'sku_last_sold'],
  ['has SKU DTALPG22 sold in the last 30 days',                  'product_detail'],
  ['what are the top customers for SKU DTALPG22',                'top_customers_by_sku'],
  ['what is the current inventory for SKU DTALPG22',             'sku_inventory'],
  ['what is the sell-through for SKU DTALPG22',                  'sell_through'],

  // D. customer-name questions with time filters (existing names re-checked)
  ['how much did John Smith spend',                              'customer_spend'],
  ['how much did John Smith spend all time',                     'customer_spend'],
  ['how much did John Smith spend yesterday',                    'customer_spend'],
  ['how much did John Smith spend last week',                    'customer_spend'],
  ['how much did John Smith spend last month',                   'customer_spend'],
  ['how much did John Smith spend this year',                    'customer_spend'],
  ['how many orders has John Smith placed',                      'customer_order_count'],
  ['what is John Smith average order value',                     'customer_aov'],
  ['what did John Smith buy in the last 30 days',                'customer_recent_purchases'],
  ['what did John Smith buy all time',                           'customer_recent_purchases'],
  ['what wines does John Smith usually buy',                     'customer_top_varietals'],
  ['what is John Smith favorite vendor',                         'customer_taste_profile'],
  ['what is John Smith favorite varietal',                       'customer_taste_profile'],
  ['what is John Smith favorite price range',                    'customer_taste_profile'],
  ['when did John Smith last shop with us',                      'customer_last_order'],
  ['is John Smith still active',                                 'customer_last_order'],
  ['how much has Terry White spent this quarter',                'customer_spend'],
  ['what did Terry White buy this month',                        'customer_recent_purchases'],
  ['show me the customer profile for Terry White',               'customer_profile'],

  // E. customer segments
  ['who bought Chardonnay in the last 90 days',                  'customers_who_bought'],
  ['who bought Pinot Noir this month',                           'customers_who_bought'],
  ['who bought sparkling wine last quarter',                     'customers_who_bought'],
  ['who bought Sancerre in the last 60 days',                    'customers_who_bought'],
  ['which customers buy the most white wine',                    'top_customers_by_spend'],
  ['which customers buy the most red wine',                      'top_customers_by_spend'],
  ['which customers buy the most premium wine',                  'top_customers_by_spend'],
  ['which customers buy the most often',                         'top_customers_by_order_count'],
  ['which customers have the highest average order value',       'top_customers_by_aov'],
  ['which customers have placed only one order',                 'customers_one_time_only'],
  ['which customers have not purchased in 60 days',              'lapsed_customers'],
  ['which customers have not purchased in 90 days',              'lapsed_customers'],
  ['which customers are becoming inactive',                      'lapsed_customers'],
  ['which customers bought both Chardonnay and Pinot Noir',      'customers_bought_both'],
  ['which customers buy mostly under $25 wines',                 'top_customers_by_spend'],
  ['which customers buy mostly over $100 wines',                 'top_customers_by_spend'],
  ['which customers are new this month',                         'new_customers'],
  ['which customers are our strongest recurring customers',      'top_customers_by_order_count'],
  ['who are our top Chardonnay customers',                       'top_customers_by_varietal'],
  ['who are our top sparkling customers',                        'top_customers_by_spend'],

  // F. recent purchases / history
  ['what did John Smith buy yesterday',                          'customer_recent_purchases'],
  ['what did John Smith buy last week',                          'customer_recent_purchases'],
  ['what did John Smith buy this month',                         'customer_recent_purchases'],
  ['show me John Smith recent purchases',                        'customer_recent_purchases'],
  ['what were Terry White last 10 purchases',                    'customer_recent_purchases'],
  ['what was the last thing Cynthia Arnholt bought',             'customer_recent_purchases'],

  // G. basket / bought-with
  ['what is commonly bought with Chardonnay',                    'bought_with_product'],
  ['what is commonly bought with Pinot Noir',                    'bought_with_product'],
  ['what is commonly bought with Sancerre',                      'bought_with_product'],
  ['what is commonly bought with SKU DTALPG22',                  'bought_with_product'],
  ['what is commonly bought with gift boxes',                    'bought_with_product'],
  ['what is commonly bought with olive brine',                   'bought_with_product'],
  ['what is commonly bought with vermouth',                      'bought_with_product'],
  ['what are the top basket pairs this month',                   'basket_pairs'],
  ['what are the top basket pairs all time',                     'basket_pairs'],

  // H. inventory low / risk
  ['which items are low stock',                                  'low_stock'],
  ['which items are out of stock',                               'out_of_stock'],
  ['which items are low stock but selling fast',                 'low_stock_high_velocity'],
  ['which top sellers are low stock',                            'low_stock_high_velocity'],
  ['which products are at risk of stockout',                     'runout_risk'],
  ['which products could run out this week',                     'runout_risk'],
  ['which fast movers have low inventory',                       'low_stock_high_velocity'],
  ['which high-revenue items have low inventory',                'low_stock_high_velocity'],
  ['which SKUs need reordering soon',                            'runout_risk'],
  ['which products are in stock but below threshold',            'low_stock'],
  ['which items have fewer than 6 units left',                   'low_stock'],
  ['which products are low stock but high velocity',             'low_stock_high_velocity'],

  // I. dead / aged / unsold
  ['which products have not sold in the last 7 days',            'dead_inventory'],
  ['which products have not sold in the last 14 days',           'dead_inventory'],
  ['which products have not sold in the last 30 days',           'dead_inventory'],
  ['which products have not sold in the last 60 days',           'dead_inventory'],
  ['which products have not sold in the last 90 days',           'dead_inventory'],
  ['which items have not sold in the last 30 days',              'dead_inventory'],
  ['which SKUs have not sold in the last 30 days',               'dead_inventory'],
  ["what hasn't sold in 30 days",                                'dead_inventory'],
  ['what has not moved in 30 days',                              'dead_inventory'],
  ['which products have had no sales in the last 60 days',       'dead_inventory'],
  ['show me inventory with no sales in the last 90 days',        'dead_inventory'],
  ['which in-stock products have not sold in the last 30 days',  'dead_inventory'],
  ['which products sold fewer than 3 units in the last 30 days', 'slow_moving'],
  ['which products are dead inventory',                          'dead_inventory'],
  ['which products are aging',                                   'dead_inventory'],
  ['which products are overstocked relative to recent sales',    'overstock'],

  // J. vendor / category / varietal / trend / comparison
  ['which vendors sold best last month',                         'top_vendors'],
  ['which vendors sold the most units this quarter',             'top_vendors'],
  ['which vendors generated the most revenue this year',         'top_vendors'],
  ['which vendors are growing fastest',                          'vendor_growth'],
  ['which vendors are down versus last month',                   'vendor_decline'],
  ['which vendors have the strongest average selling price',     'vendor_avg_selling_price'],
  ['which vendors have the most dead inventory',                 'vendors_dead_inventory'],
  ['how is Chardonnay performing this month',                    'varietal_performance'],
  ['how is Pinot Noir performing this quarter',                  'varietal_performance'],
  ['how are sparkling wines performing this year',               'varietal_performance'],
  ['which varietals are growing fastest',                        'varietal_performance'],
  ['which categories are performing best',                       'category_performance'],
  ['which categories are slowing down',                          'category_performance'],
  ['sales this month compared to last month',                    'period_over_period'],
  ['sales this week compared to last week',                      'period_over_period'],
  ['sales yesterday compared to the prior day',                  'period_over_period'],
  ['which items are trending up',                                'trending_up'],
  ['which items are trending down',                              'trending_down'],
  ['what improved this week versus last week',                   'period_over_period'],
  ['what declined this month versus last month',                 'period_over_period'],
];

for (const [q, expected] of cases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parser.parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

// Spot-checks on temporal + metric extraction working end-to-end through parse():
check('timeframe.label = yesterday', () => {
  const p = parser.parse('how much did we sell yesterday');
  assert.strictEqual(p.params.timeframe.label, 'yesterday');
  assert.strictEqual(p.params.metric, 'revenue');
  assert.strictEqual(p.params.scope, 'storewide');
});
check('metric=units for "how many units did we sell yesterday"', () => {
  const p = parser.parse('how many units did we sell yesterday');
  assert.strictEqual(p.params.metric, 'units');
  assert.strictEqual(p.params.scope, 'storewide');
});
check('metric=orders for "how many orders did we have yesterday"', () => {
  const p = parser.parse('how many orders did we have yesterday');
  assert.strictEqual(p.params.metric, 'orders');
});
check('metric=aov for "what was average order value yesterday"', () => {
  const p = parser.parse('what was average order value yesterday');
  assert.strictEqual(p.params.metric, 'aov');
});
check('dayCount = 30 captured from "not sold in the last 30 days"', () => {
  const p = parser.parse('which products have not sold in the last 30 days');
  assert.strictEqual(p.params.dayCount, 30);
});
check('lapsedDays = 60 captured', () => {
  const p = parser.parse('which customers have not purchased in 60 days');
  assert.strictEqual(p.params.lapsedDays, 60);
});
check('twoVarietals captured for "bought both X and Y"', () => {
  const p = parser.parse('which customers bought both Chardonnay and Pinot Noir');
  assert.deepStrictEqual(p.params.twoVarietals, ['chardonnay', 'pinot noir']);
});
check('slow capture for "fewer than 3 units in 30 days"', () => {
  const p = parser.parse('which products sold fewer than 3 units in the last 30 days');
  assert.deepStrictEqual(p.params.slow, { maxUnits: 3, days: 30 });
});
check('scope=customer when name present', () => {
  const p = parser.parse('how much did John Smith spend last week');
  assert.strictEqual(p.params.scope, 'customer');
});
check('scope=storewide when no entity present', () => {
  const p = parser.parse('sales this month');
  assert.strictEqual(p.params.scope, 'storewide');
});
check('productHint extracted after "with"', () => {
  const p = parser.parse('what is commonly bought with Sancerre');
  // Sancerre is a region, not in our varietal list — productHint should
  // pick it up as a 3+ char capitalized run.
  assert.ok(/sancerre/i.test(p.params.productHint || p.params.varietal || ''),
    `productHint=${p.params.productHint} varietal=${p.params.varietal}`);
});

// ---------------------------------------------------------------------------
// Live /shopify-qa with stubbed DB
// ---------------------------------------------------------------------------
header('live /shopify-qa with stubbed db (broad coverage)');

const db = require('../src/db');
db.isEnabled = () => true;

const queryLog = [];
db.query = async function (text, values) {
  queryLog.push({ text, values });
  const t = String(text || '');

  // Customer resolver - exact full-name
  if (/from customers\s+where lower\(trim\(coalesce\(first_name/.test(t)) {
    const name = (values[0] || '').toLowerCase();
    if (name === 'john smith')  return { rows: [{ customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', total_spent: 5000 }] };
    if (name === 'terry white') return { rows: [{ customer_id: 11, email: 'terry@example.com', customer_name: 'Terry White', total_spent: 1200 }] };
    if (name === 'jane doe')    return { rows: [
      { customer_id: 12, email: 'jane1@example.com', customer_name: 'Jane Doe', total_spent: 500 },
      { customer_id: 13, email: 'jane2@example.com', customer_name: 'Jane Doe', total_spent: 300 },
    ] };
    return { rows: [] };
  }
  if (/from customers\s+where \(lower\(coalesce\(first_name/.test(t)) {
    return { rows: [] };
  }

  // Storewide sales summary SQL — match by the columns we expect back.
  if (/as net_revenue/.test(t) && /as average_order_value/.test(t) && /from fact_sales/.test(t)) {
    return { rows: [{ orders: 12, units: 88, net_revenue: 4250.55, gross_revenue: 4400, discounts: 150, average_order_value: 354.21 }] };
  }

  // top_items_by_units / by_revenue
  if (/from fact_sales fs[\s\S]+group by fs.product_id, fs.sku/.test(t)) {
    const byRev = /order by net_revenue/.test(t);
    return { rows: byRev
      ? [{ product_id: 1, sku: 'A', product_title: 'Wine A', units_sold: 8, net_revenue: 480 }]
      : [{ product_id: 1, sku: 'A', product_title: 'Wine A', units_sold: 22, net_revenue: 660 }] };
  }

  // product_detail (one-row)
  if (/(select|with)[\s\S]+from fact_sales fs[\s\S]+where fs.product_id = \$1/.test(t) && !/sum\(fs.unit_price\)/.test(t)) {
    return { rows: [{ product_id: 1, product_title: 'Pinot Grigio', units_sold: 40, net_revenue: 1200, orders: 25, customers: 18, first_sold: '2025-09-01T00:00:00Z', last_sold: '2026-06-10T00:00:00Z' }] };
  }

  // SKU lookups
  if (/from dim_sku_profile\s+where sku = \$1/.test(t)) {
    return { rows: [{ sku: 'DTALPG22', product_title: 'Alois Lageder Pinot Grigio', units_sold: 100, units_sold_30d: 8, units_sold_90d: 25, on_hand: 12, last_sold_at: '2026-06-10T00:00:00Z' }] };
  }
  if (/from vw_current_inventory\s+where sku = \$1/.test(t)) {
    return { rows: [{ sku: 'DTALPG22', product_title: 'Alois Lageder Pinot Grigio', variant_title: '750ml', vendor: 'Alois Lageder', price: 24.99, on_hand: 12, product_handle: 'alois', product_status: 'active' }] };
  }
  if (/avg\(fs.unit_price\)::numeric/.test(t)) {
    return { rows: [{ sku: 'DTALPG22', product_title: 'Alois Lageder Pinot Grigio', line_items: 30, units_sold: 100, net_revenue: 2400, avg_unit_price: 24.50, min_unit_price: 22.00, max_unit_price: 27.00 }] };
  }

  // dead inventory / aged
  if (/from dim_sku_profile[\s\S]+last_sold_at is null or last_sold_at </.test(t)) {
    return { rows: [
      { sku: 'X-1', product_title: 'Dusty Bottle', vendor: 'V', on_hand: 18, units_sold: 0, units_sold_30d: 0, units_sold_90d: 0, last_sold_at: null },
    ] };
  }

  // slow_moving (dim_sku_profile path)
  if (/coalesce\(units_sold_30d, 0\) < \$1/.test(t)) {
    return { rows: [{ sku: 'S-1', product_title: 'Sleepy Wine', vendor: 'V', on_hand: 10, units_sold_30d: 1, units_sold_90d: 3, last_sold_at: '2026-06-01T00:00:00Z' }] };
  }

  // top_customers_by_order_count / by_aov / by_sku
  if (/order by order_count desc/.test(t)) {
    return { rows: [{ customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', order_count: 33, total_spend: 4200 }] };
  }
  if (/order by average_order_value desc/.test(t) || /order by\s+(?:po\.|)average_order_value desc/.test(t)) {
    return { rows: [{ customer_id: 11, email: 'terry@example.com', customer_name: 'Terry White', order_count: 5, total_spend: 1200, average_order_value: 240 }] };
  }
  if (/where fs.sku = \$1[\s\S]+group by fs.customer_id/.test(t)) {
    return { rows: [{ customer_id: 10, customer_name: 'John Smith', email: 'john@example.com', units: 8, spend: 200 }] };
  }

  // customers_bought_both
  if (/with cust_a as[\s\S]+with cust_b as|cust_a[\s\S]+cust_b\s+using/.test(t)) {
    return { rows: [{ customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', total_spend: 5000, order_count: 12 }] };
  }

  // lapsed_customers
  if (/from dim_customer_profile\s+where days_since_last_order >= \$1/.test(t)) {
    return { rows: [{ customer_id: 11, email: 'terry@example.com', customer_name: 'Terry White', total_spend: 1200, order_count: 4, last_order_at: '2026-02-01T00:00:00Z', days_since_last_order: 135 }] };
  }

  // recent purchases
  if (/order by fs.occurred_at desc/.test(t)) {
    return { rows: [
      { order_name: '#1001', order_id: 9001, occurred_at: '2026-06-15T00:00:00Z', sku: 'WIN-1', product_title: 'Sample Chardonnay', variant_title: '750ml', quantity: 2, unit_price: 30, net_revenue: 60 },
    ] };
  }

  // customer_top_varietals
  if (/from fact_sales fs[\s\S]+where fs.customer_id = \$1[\s\S]+group by fs.product_title/.test(t)) {
    return { rows: [{ product_title: 'Sancerre', units: 6, spend: 240, orders: 3 }] };
  }
  // customer_taste_profile (single composite row)
  if (/favorite_vendor[\s\S]+favorite_product[\s\S]+avg_unit_price/.test(t)) {
    return { rows: [{ favorite_vendor: 'Loire House', favorite_product: 'Sancerre', avg_unit_price: 30, min_unit_price: 24, max_unit_price: 50, customer_name: 'John Smith', favorite_product_type: 'White', last_order_at: '2026-06-10T00:00:00Z' }] };
  }
  // customer_last_order
  if (/from dim_customer_profile\s+where customer_id = \$1\s*$/m.test(t) || /from dim_customer_profile\s+where customer_id = \$1\s*\n?\s*$/.test(t)) {
    return { rows: [{ customer_id: 10, customer_name: 'John Smith', email: 'john@example.com', last_order_at: '2026-06-10T00:00:00Z', days_since_last_order: 6, order_count: 12, total_spend: 5000, favorite_vendor: 'Loire House', favorite_product_type: 'White' }] };
  }

  // customer_spend / order_count / aov SQL
  if (/from fact_sales fs\s+where fs.customer_id = \$1/.test(t)) {
    const hadWindow = values.length >= 3;
    if (values[0] === 10) {
      return { rows: [{ customer_id: 10, order_count: hadWindow ? 2 : 12, total_spend: hadWindow ? 410 : 5000, units: hadWindow ? 4 : 60, average_order_value: hadWindow ? 205 : 416.67, first_order_at: '2025-09-01T00:00:00Z', last_order_at: '2026-06-10T00:00:00Z' }] };
    }
    if (values[0] === 11) {
      return { rows: [{ customer_id: 11, order_count: 3, total_spend: 220, units: 4, average_order_value: 73.33, last_order_at: '2026-06-15T00:00:00Z' }] };
    }
    return { rows: [{ order_count: 0, total_spend: 0, units: 0, average_order_value: 0 }] };
  }

  // basket_pairs (joins two order_line_items)
  if (/from order_line_items a[\s\S]+join order_line_items b/.test(t)) {
    return { rows: [{ product_a: 'Sancerre', product_b: 'Loire Rosé', times_bought_together: 9 }] };
  }

  // top_vendors
  if (/from fact_sales[\s\S]+group by 1\s+order by net_revenue/.test(t)) {
    return { rows: [{ vendor: 'Acme', units_sold: 50, net_revenue: 4200, orders: 30 }] };
  }
  // vendor_growth / decline (with cur / prev CTE)
  if (/with cur as[\s\S]+full outer join prev/.test(t)) {
    return { rows: [
      { vendor: 'Acme',  revenue_current: 5000, revenue_previous: 3000, revenue_delta:  2000, pct_change:  66.7 },
      { vendor: 'Beta',  revenue_current: 1000, revenue_previous: 1500, revenue_delta:  -500, pct_change: -33.3 },
    ] };
  }
  // vendor_avg_selling_price
  if (/avg_selling_price/.test(t) && /from fact_sales fs/.test(t)) {
    return { rows: [{ vendor: 'Premier', units: 20, revenue: 2000, avg_selling_price: 100 }] };
  }
  // vendors_dead_inventory
  if (/from dim_sku_profile[\s\S]+group by 1\s+order by dead_units/.test(t)) {
    return { rows: [{ vendor: 'StuckCo', dead_skus: 5, dead_units: 60 }] };
  }

  // period_over_period
  if (/union all\s+select 'previous'/.test(t)) {
    return { rows: [
      { bucket: 'current',  revenue: 7500, units: 150, orders: 20 },
      { bucket: 'previous', revenue: 6000, units: 130, orders: 18 },
    ] };
  }

  // varietal_performance / category_performance
  if (/'.*'::text as varietal/.test(t)) {
    return { rows: [{ varietal: 'chardonnay', units: 70, revenue: 2800, orders: 50, customers: 35 }] };
  }
  if (/(p\.product_type[\s\S]+group by 1|coalesce\(nullif\(p\.product_type,''\),)/.test(t)) {
    return { rows: [{ category: 'Red', units: 200, revenue: 6000, orders: 80 }] };
  }

  // customers_who_bought
  if (/group by fs.customer_id/.test(t)) {
    return { rows: [{ customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', units: 6, spend: 240 }] };
  }

  // dim_customer_profile by id (customer_profile)
  if (/from dim_customer_profile where customer_id = \$1/.test(t)) {
    return { rows: [{ customer_id: values[0], email: 'terry@example.com', customer_name: 'Terry White', total_spend: 1200, order_count: 4, favorite_vendor: 'V1', favorite_product_type: 'White', last_order_at: '2026-05-01T00:00:00Z' }] };
  }

  // low_stock_high_velocity
  if (/units_sold_30d >= \$2/.test(t)) {
    return { rows: [{ sku: 'Z-1', product_title: 'Hot Pinot', vendor: 'V', on_hand: 4, units_sold_30d: 12, units_sold_90d: 30 }] };
  }
  // runout_risk
  if (/days_of_cover/.test(t)) {
    return { rows: [{ sku: 'R-1', product_title: 'Almost Out', vendor: 'V', on_hand: 3, units_sold_30d: 24, days_of_cover: 3.75 }] };
  }
  // generic dim_customer_profile listings
  if (/from dim_customer_profile/.test(t)) {
    return { rows: [{ customer_id: 99, email: 'x@x.com', customer_name: 'X X', total_spend: 100, order_count: 1, last_order_at: '2026-06-10T00:00:00Z' }] };
  }

  return { rows: [] };
};

// Boot server
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

  // A. storewide totals
  header('live: storewide totals');
  const r1 = await ask('how much did we sell yesterday');
  check('storewide sales yesterday -> 200', () => assert.strictEqual(r1.status, 200));
  check('intent=sales_summary, scope=storewide, metric=revenue, timeframe=yesterday', () => {
    assert.strictEqual(r1.body.intent, 'sales_summary');
    assert.strictEqual(r1.body.meta.scope, 'storewide');
    assert.strictEqual(r1.body.meta.params.metric, 'revenue');
    assert.strictEqual(r1.body.meta.timeframe.label, 'yesterday');
  });
  check('answer leads with revenue dollars', () => assert.ok(/\$4,250\.55/.test(r1.body.answer)));

  const r1u = await ask('how many units did we sell yesterday');
  check('units variant -> metric=units', () => assert.strictEqual(r1u.body.meta.params.metric, 'units'));
  check('units answer leads with unit count', () => assert.ok(/88 units/.test(r1u.body.answer)));

  const r1a = await ask('what was average order value yesterday');
  check('aov variant -> metric=aov', () => assert.strictEqual(r1a.body.meta.params.metric, 'aov'));
  check('aov answer leads with AOV', () => assert.ok(/average order value/i.test(r1a.body.answer)));

  // B. top items
  const r2 = await ask('what were the top items sold yesterday');
  check('top items yesterday -> top_items_by_units', () => assert.strictEqual(r2.body.intent, 'top_items_by_units'));
  const r2r = await ask('what were the top items by revenue last month');
  check('top items by revenue -> top_items_by_revenue', () => assert.strictEqual(r2r.body.intent, 'top_items_by_revenue'));

  // C. SKU detail
  const r3 = await ask('how many units of SKU DTALPG22 have we sold this month');
  check('SKU detail returns product_detail intent + scope=product', () => {
    assert.strictEqual(r3.body.intent, 'product_detail');
    assert.strictEqual(r3.body.meta.scope, 'product');
  });
  const r3inv = await ask('what is the current inventory for SKU DTALPG22');
  check('SKU inventory -> sku_inventory + 200', () => {
    assert.strictEqual(r3inv.body.intent, 'sku_inventory');
    assert.strictEqual(r3inv.status, 200);
  });
  const r3price = await ask('what is the average selling price for SKU DTALPG22');
  check('SKU avg price -> sku_avg_price', () => assert.strictEqual(r3price.body.intent, 'sku_avg_price'));
  const r3last = await ask('when was SKU DTALPG22 last sold');
  check('SKU last sold -> sku_last_sold', () => assert.strictEqual(r3last.body.intent, 'sku_last_sold'));
  const r3tc = await ask('what are the top customers for SKU DTALPG22');
  check('Top customers for SKU -> top_customers_by_sku', () => assert.strictEqual(r3tc.body.intent, 'top_customers_by_sku'));

  // D. customer by name with time filters
  const r4yes = await ask('how much did John Smith spend yesterday');
  check('customer spend yesterday -> resolved + timeframe=yesterday', () => {
    assert.strictEqual(r4yes.body.intent, 'customer_spend');
    assert.strictEqual(r4yes.body.meta.timeframe.label, 'yesterday');
    assert.strictEqual(r4yes.body.meta.resolved.customer.customer_name, 'John Smith');
  });
  const r4all = await ask('how much did John Smith spend all time');
  check('customer spend all_time mode', () => assert.strictEqual(r4all.body.meta.timeframe.mode, 'all_time'));
  const r4last = await ask('when did John Smith last shop with us');
  check('customer_last_order intent', () => assert.strictEqual(r4last.body.intent, 'customer_last_order'));
  const r4taste = await ask('what is John Smith favorite vendor');
  check('customer_taste_profile intent', () => assert.strictEqual(r4taste.body.intent, 'customer_taste_profile'));
  check('taste profile mentions Loire House', () => assert.ok(/Loire House/.test(r4taste.body.answer)));
  const r4top = await ask('what wines does John Smith usually buy');
  check('customer_top_varietals intent', () => assert.strictEqual(r4top.body.intent, 'customer_top_varietals'));

  // E. customer segments
  const r5lap = await ask('which customers have not purchased in 90 days');
  check('lapsed_customers + lapsedDays=90', () => {
    assert.strictEqual(r5lap.body.intent, 'lapsed_customers');
    assert.strictEqual(r5lap.body.meta.params.lapsed_days, 90);
  });
  const r5both = await ask('which customers bought both Chardonnay and Pinot Noir');
  check('customers_bought_both', () => assert.strictEqual(r5both.body.intent, 'customers_bought_both'));
  const r5freq = await ask('which customers buy the most often');
  check('top_customers_by_order_count', () => assert.strictEqual(r5freq.body.intent, 'top_customers_by_order_count'));
  const r5aov = await ask('which customers have the highest average order value');
  check('top_customers_by_aov', () => assert.strictEqual(r5aov.body.intent, 'top_customers_by_aov'));

  // F. recent purchases
  const r6last = await ask('what was the last thing Terry White bought');
  check('last thing bought -> customer_recent_purchases', () => assert.strictEqual(r6last.body.intent, 'customer_recent_purchases'));

  // G. basket / bought-with with timeframe
  const r7bp = await ask('what are the top basket pairs this month');
  check('basket pairs this month -> basket_pairs', () => assert.strictEqual(r7bp.body.intent, 'basket_pairs'));
  check('basket pairs timeframe applied', () => assert.strictEqual(r7bp.body.meta.timeframe.label, 'this month'));
  const r7bw = await ask('what is commonly bought with Sancerre');
  check('bought_with_product intent', () => assert.strictEqual(r7bw.body.intent, 'bought_with_product'));

  // H. inventory
  const r8low = await ask('which items have fewer than 6 units left');
  check('low_stock intent + units_below captured', () => {
    assert.strictEqual(r8low.body.intent, 'low_stock');
    assert.deepStrictEqual(r8low.body.meta.params.units_below, { op: '<', value: 6 });
  });

  // I. dead / slow
  const r9d = await ask('which products have not sold in the last 30 days');
  check('dead_inventory + dayCount=30', () => {
    assert.strictEqual(r9d.body.intent, 'dead_inventory');
    assert.strictEqual(r9d.body.meta.params.day_count, 30);
  });
  const r9s = await ask('which products sold fewer than 3 units in the last 30 days');
  check('slow_moving intent', () => assert.strictEqual(r9s.body.intent, 'slow_moving'));

  // J. vendor / trend
  const r10g = await ask('which vendors are growing fastest');
  check('vendor_growth intent', () => assert.strictEqual(r10g.body.intent, 'vendor_growth'));
  const r10d = await ask('which vendors are down versus last month');
  check('vendor_decline intent', () => assert.strictEqual(r10d.body.intent, 'vendor_decline'));
  const r10asp = await ask('which vendors have the strongest average selling price');
  check('vendor_avg_selling_price', () => assert.strictEqual(r10asp.body.intent, 'vendor_avg_selling_price'));
  const r10di = await ask('which vendors have the most dead inventory');
  check('vendors_dead_inventory', () => assert.strictEqual(r10di.body.intent, 'vendors_dead_inventory'));
  const r10pop = await ask('sales yesterday compared to the prior day');
  check('period_over_period intent', () => assert.strictEqual(r10pop.body.intent, 'period_over_period'));

  // K. disambiguation / not_found
  const r11dis = await ask('how much did Jane Doe spend last month');
  check('ambiguous Jane Doe -> disambiguation', () => assert.strictEqual(r11dis.body.meta.status, 'disambiguation'));
  const r11nf = await ask('how much did Michael Jordan spend with us');
  check('unknown Michael Jordan -> not_found', () => assert.strictEqual(r11nf.body.meta.status, 'not_found'));

  // Regression: existing intents still work
  const rExA = await ask('low stock');
  check('low_stock still works', () => assert.strictEqual(rExA.body.intent, 'low_stock'));
  const rExB = await ask('top customers by spend');
  check('top_customers_by_spend still works', () => assert.strictEqual(rExB.body.intent, 'top_customers_by_spend'));
  const rExC = await ask('what sells together');
  check('basket_pairs still works', () => assert.strictEqual(rExC.body.intent, 'basket_pairs'));

  // Auth + /recommend
  const noAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('no auth -> 401', () => assert.strictEqual(noAuth.status, 401));
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('/recommend 200 + recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });

  console.log('');
  if (failures) {
    console.error(`manager-qa v2 smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`manager-qa v2 smoke: ALL OK (${queryLog.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('manager-qa v2 smoke crashed:', e);
  process.exit(1);
});
