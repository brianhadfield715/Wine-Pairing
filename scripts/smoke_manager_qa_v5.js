#!/usr/bin/env node
// scripts/smoke_manager_qa_v5.js
// Comprehensive language/CRM/order-drill-down smoke. Covers spec sections
// A-K from the v5 upgrade pass.

const assert = require('assert');
const http = require('http');

// Env setup
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34607';
process.env.QA_USER = 'smoke';
process.env.QA_PASS = 'smoke';
process.env.SHOP_DOMAIN  = 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = 'placeholder';

let failures = 0;
function header(t) { console.log('\n=== ' + t + ' ==='); }
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures += 1; console.log('  FAIL ' + label + ' --- ' + e.message); }
}

// =========================================================================
// Pure unit-level tests
// =========================================================================

header('temporal: anchored week-of parsing');
const temporal = require('../src/analytics/temporalParser');
function tf(q) { return temporal.parse(q); }
check('week of 5/31/2026', () => {
  const r = tf('compare sales for week of 5/31/2026 to week of 6/7/2026');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.grain, 'week');
  assert.strictEqual(r.days, 7);
});
check('week of June 7 2026', () => {
  const r = tf('week of June 7 2026');
  assert.strictEqual(r.label, 'week of Jun 7, 2026');
  assert.strictEqual(r.sinceIso.slice(0, 10), '2026-06-07');
  assert.strictEqual(r.untilIso.slice(0, 10), '2026-06-14');
});
check('week before last', () => {
  const r = tf('how did sales go week before last');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.grain, 'week');
});
check('parsePair for "week of A vs week of B"', () => {
  const pair = temporal.parsePair('compare sales for week of 5/31/2026 to week of 6/7/2026');
  assert.ok(pair && pair.timeframeA && pair.timeframeB);
  assert.strictEqual(pair.timeframeA.label, 'week of May 31, 2026');
  assert.strictEqual(pair.timeframeB.label, 'week of Jun 7, 2026');
});

header('entities: customer name trimming + order ref + customer pair');
const entities = require('../src/analytics/entities');
check('trims "usually buys" from name capture', () => {
  const e = entities.extract('what does brian hadfield usually buy');
  assert.strictEqual(e.customer, 'Brian Hadfield');
});
check('trims "most" / "reorders"', () => {
  const e = entities.extract('what does Brian Hadfield reorder most often');
  assert.strictEqual(e.customer, 'Brian Hadfield');
});
check('trims "like"', () => {
  const e = entities.extract('what does Brian Hadfield like');
  assert.strictEqual(e.customer, 'Brian Hadfield');
});
check('extracts order #37857', () => {
  const e = entities.extract('what was on order #37857');
  assert.deepStrictEqual(e.orderRef && e.orderRef.name, '#37857');
});
check('extracts bare "order 37857"', () => {
  const e = entities.extract('show me order 37857');
  assert.deepStrictEqual(e.orderRef && e.orderRef.name, '#37857');
});
check('extracts "ticket #37857"', () => {
  const e = entities.extract('show me ticket #37857');
  assert.deepStrictEqual(e.orderRef && e.orderRef.name, '#37857');
});
check('extracts customer pair "Brian Hadfield with Chelsey Hadfield"', () => {
  const e = entities.extract('compare brian hadfield with chelsey hadfield');
  assert.ok(e.customerPair, 'expected customerPair');
  assert.strictEqual(e.customerPair.left,  'Brian Hadfield');
  assert.strictEqual(e.customerPair.right, 'Chelsey Hadfield');
});
check('extracts pair "Brian vs Chelsey"', () => {
  const e = entities.extract('brian hadfield vs chelsey hadfield');
  assert.ok(e.customerPair);
});
check('extracts pair "who spends more, Brian or Chelsey"', () => {
  const e = entities.extract('who spends more, brian hadfield or chelsey hadfield');
  assert.ok(e.customerPair);
});

header('intent classification - v5 families');
const parser = require('../src/analytics/intentParser');
const cases = [
  // Exact-date regression
  ['how much did we sell on 1/25/2026',                  'sales_summary'],
  ['who bought chardonnay on 1/25/2026',                 'customers_who_bought'],

  // Anchored week + week comparison
  ['week of June 7 2026 sales',                          'sales_summary'],
  ['compare sales for week of 5/31/2026 to week of 6/7/2026', 'period_over_period'],
  ['compare week of 5/31/2026 with week of 6/7/2026',    'period_over_period'],
  ['how did week of 5/31/2026 compare to week of 6/7/2026', 'period_over_period'],

  // Repeat / new
  ['how many repeat customers did we have yesterday',    'repeat_customers_count'],
  ['how many first time customers were in the store yesterday', 'new_customers_count'],
  ['what percent of customers last week were first time customers', 'new_customers_share'],

  // Customer preference - case-insensitive name
  ['what does brian hadfield usually buy',               'customer_top_products'],
  ['what does brian hadfield buy',                       'customer_top_products'],
  ['what does brian hadfield like',                      'customer_top_products'],
  ['what are brian hadfield favorites',                  'customer_top_products'],
  ['what does brian hadfield reorder most often',        'customer_top_products'],
  ['what varietal does brian hadfield like',             'customer_top_varietals'],
  ['what varietals does brian hadfield usually buy',     'customer_top_varietals'],
  ['does brian hadfield usually get red or white',       'customer_color_mix'],
  ['what regions does brian hadfield usually buy from',  'customer_top_vendors'],
  ['what categories does brian hadfield buy most often', 'customer_top_categories'],
  ['does brian hadfield buy liquor',                     'customer_top_categories'],
  ['what wines does brian hadfield usually buy',         'customer_top_varietals'],

  // Single-row taste profile (singular favorite + a recognized noun)
  ['what is brian hadfield favorite vendor',             'customer_taste_profile'],
  ['what is brian hadfield favorite varietal',           'customer_taste_profile'],
  ['what is brian hadfield favorite price range',        'customer_taste_profile'],

  // Customer change over time
  ['how has brian hadfield buying changed over the last 12 months', 'customer_change_over_time'],
  ['has brian hadfield shifted from red to white',       'customer_change_over_time'],
  ['compare brian hadfield last 6 months to the prior 6 months',    'customer_change_over_time'],

  // Per-customer time series chart
  ['chart brian hadfield revenue by week for the last 10 weeks',    'customer_time_series'],
  ['show brian hadfield units bought by week for the last 10 weeks','customer_time_series'],

  // Customer comparison
  ['compare brian hadfield with chelsey hadfield',       'customer_comparison'],
  ['brian hadfield vs chelsey hadfield',                 'customer_comparison'],
  ['who spends more, brian hadfield or chelsey hadfield','customer_comparison'],
  ['compare brian hadfield and chelsey hadfield by spend','customer_comparison'],

  // Customer units bought (regression)
  ['how many units has brian hadfield bought',           'customer_units_bought'],
  ['how many bottles has brian hadfield bought',         'customer_units_bought'],

  // Customer spend + timeframe preserved
  ['how much has brian hadfield spent',                  'customer_spend'],
  ['how much has brian hadfield spent last week',        'customer_spend'],
  ['how much did brian hadfield spend yesterday',        'customer_spend'],

  // Top spender / ranking
  ['who spent the most yesterday',                       'top_customers_by_spend'],
  ['rank customers by order count last month',           'top_customers_by_order_count'],

  // Order drill-down family
  ['what was on order #37857',                           'order_items_lookup'],
  ['what was in order #37857',                           'order_items_lookup'],
  ['what did they buy on order #37857',                  'order_items_lookup'],
  ['show me the items on order #37857',                  'order_items_lookup'],
  ['list every line item on order #37857',               'order_items_lookup'],
  ['break out order #37857 line by line',                'order_items_lookup'],
  ['show me order #37857',                               'order_items_lookup'],
  ['show me receipt #37857',                             'order_items_lookup'],
  ['show me ticket #37857',                              'order_items_lookup'],
  ['pull up order #37857',                               'order_items_lookup'],
  ['open order #37857',                                  'order_items_lookup'],
  ['give me the details for order #37857',               'order_detail_lookup'],
  ['who placed order #37857',                            'order_customer_lookup'],
  ['what customer placed order #37857',                  'order_customer_lookup'],
  ['how much was order #37857',                          'order_total_lookup'],
  ['what was the total for order #37857',                'order_total_lookup'],
  ['was order #37857 cancelled',                         'order_status_lookup'],
  ['what was the status of order #37857',                'order_status_lookup'],
  ['was order #37857 refunded',                          'order_status_lookup'],
  ['was order #37857 fulfilled',                         'order_status_lookup'],
  ['what was the most expensive item on order #37857',   'order_extreme_item_lookup'],
  ['what was the cheapest item on order #37857',         'order_extreme_item_lookup'],
  ['did order #37857 include liquor',                    'order_includes_category'],
  ['did order #37857 include both liquor and wine',      'order_includes_category'],

  // Customer last-order / last-N
  ['show me brian hadfield last order',                  'customer_last_order_items'],
  ['what was on brian hadfield last order',              'customer_last_order_items'],
  ['show me brian hadfield last 5 orders',               'customer_last_n_orders'],

  // Overlap share
  ['how many orders have both liquor and wine',          'order_overlap_share'],
  ['what percent of orders have both liquor and wine',   'order_overlap_share'],

  // Inventory units (bottles must map to units_on_hand)
  ['how many units are in the store',                    'inventory_units_on_hand'],
  ['how many bottles are in the store',                  'inventory_units_on_hand'],
  ['how many bottles are in stock',                      'inventory_units_on_hand'],

  // Inventory counts
  ['how many skus have inventory',                       'inventory_count_in_stock'],
  ['how many variants are in stock',                     'inventory_count_in_stock'],

  // Data coverage
  ['what date range is covered in the order data',       'data_coverage_orders'],
  ['what dates are covered in the order data',           'data_coverage_orders'],

  // Storewide breakdowns
  ['show me the top 5 varietals last week',              'varietal_ranking'],
  ['show me how many units of each type sold last week', 'type_breakdown'],

  // Taxonomy synonyms
  ['what were liquor sales last week',                   'sales_summary'],
  ['what were spirit sales last week',                   'sales_summary'],
  ['what were beer sales last week',                     'sales_summary'],

  // Busy time + basket
  ['what hour was busiest yesterday',                    'busiest_hour'],
  ['typically, when is the store busiest',               'busiest_period_pattern'],
  ['what items sell together the most',                  'basket_pairs'],

  // Price extremes
  ['what was the most expensive bottle sold last week',  'highest_priced_item_sold'],
  ['who bought the most expensive bottle yesterday',     'buyer_of_highest_priced_item'],
  ['who bought the cheapest bottle yesterday',           'buyer_of_lowest_priced_item'],
];
for (const [q, expected] of cases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parser.parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

// Output mode + chart-type detection on representative phrasings
header('output mode detection');
check('"make a chart of revenue from brian hadfield ..." → outputMode=chart', () => {
  const p = parser.parse('make a chart of revenue from brian hadfield for the last 10 weeks');
  assert.strictEqual(p.params.outputMode, 'chart');
});
check('"compare sales this week vs last week in a bar chart" → bar', () => {
  const p = parser.parse('compare sales this week vs last week in a bar chart');
  assert.strictEqual(p.params.chartType, 'bar');
});
check('explicit "top 20" honored → limit=20', () => {
  const p = parser.parse('top 20 items sold yesterday');
  assert.strictEqual(p.params.limit, 20);
});

// Order-extreme direction
check('extremeDirection=low for "cheapest item on order #37857"', () => {
  const p = parser.parse('what was the cheapest item on order #37857');
  assert.strictEqual(p.params.extremeDirection, 'low');
});

// Category extraction (overlap)
check('overlapFilters for "orders have both liquor and wine"', () => {
  const p = parser.parse('what percent of orders have both liquor and wine');
  assert.deepStrictEqual(p.params.overlapFilters, ['liquor', 'wine']);
});

// =========================================================================
// Live HTTP tests with stubbed DB
// =========================================================================

header('live /shopify-qa with stubbed db (v5)');
const db = require('../src/db');
db.isEnabled = () => true;
const queryLog = [];
db.query = async function (text, values) {
  queryLog.push({ text, values });
  const t = String(text || '');

  // Customer resolver (exact full name)
  if (/from customers\s+where lower\(trim\(coalesce\(first_name/.test(t)) {
    const name = (values[0] || '').toLowerCase();
    if (name === 'brian hadfield')   return { rows: [{ customer_id: 100, email: 'brian@example.com',   customer_name: 'Brian Hadfield',   total_spent: 8421 }] };
    if (name === 'chelsey hadfield') return { rows: [{ customer_id: 101, email: 'chelsey@example.com', customer_name: 'Chelsey Hadfield', total_spent: 4210 }] };
    return { rows: [] };
  }
  if (/from customers\s+where \(lower\(coalesce\(first_name/.test(t)) return { rows: [] };

  // Order resolver
  if (/from orders\s+where name = \$1/.test(t)) {
    if (values[0] === '#37857') {
      return { rows: [{ order_id: 9001, name: '#37857', customer_id: 100, email: 'brian@example.com',
        processed_at: '2026-06-15T18:30:00Z', created_at: '2026-06-15T18:30:00Z', cancelled_at: null, closed_at: null,
        financial_status: 'paid', fulfillment_status: 'fulfilled', currency: 'USD',
        subtotal_price: 200, total_discounts: 0, total_tax: 16, total_price: 216,
        total_line_items_price: 200, source_name: 'web', tags: '' }] };
    }
    if (values[0] === '#37892') {
      return { rows: [{ order_id: 9002, name: '#37892', customer_id: 101, email: 'chelsey@example.com',
        processed_at: '2026-06-16T10:00:00Z', created_at: '2026-06-16T10:00:00Z', cancelled_at: null, closed_at: null,
        financial_status: 'paid', fulfillment_status: 'fulfilled', currency: 'USD',
        subtotal_price: 150, total_discounts: 10, total_tax: 12, total_price: 152,
        total_line_items_price: 150, source_name: 'web', tags: '' }] };
    }
    return { rows: [] };
  }
  if (/from orders\s+where id = \$1/.test(t)) {
    return { rows: [] };
  }

  // Order detail builder (one row with derived counts)
  if (/select o.id as order_id[\s\S]+from orders o[\s\S]+left join customers c[\s\S]+where o.id = \$1/.test(t)) {
    return { rows: [{ order_id: values[0], name: '#37857', customer_name: 'Brian Hadfield', email: 'brian@example.com',
      occurred_at: '2026-06-15T18:30:00Z', cancelled_at: null,
      financial_status: 'paid', fulfillment_status: 'fulfilled',
      subtotal_price: 200, total_discounts: 0, total_tax: 16, total_price: 216,
      line_item_count: 2, total_units: 3 }] };
  }
  // Order items
  if (/from order_line_items oli\s+left join products p[\s\S]+where oli.order_id = \$1/.test(t)) {
    return { rows: [
      { line_item_id: 1, sku: 'WIN-1', product_title: 'Sancerre',          variant_title: '750ml', vendor: 'Loire',  quantity: 2, unit_price: 50, line_discount: 0,  line_total: 100, product_type: 'White Wine' },
      { line_item_id: 2, sku: 'WIN-2', product_title: 'Champagne Reserve', variant_title: '750ml', vendor: 'Cuvee',  quantity: 1, unit_price: 100, line_discount: 0, line_total: 100, product_type: 'Sparkling' },
    ] };
  }
  // Order extreme item
  if (/from order_line_items oli\s+where oli.order_id = \$1\s+and oli.price is not null\s+order by oli.price (desc|asc) nulls last\s+limit 5/.test(t)) {
    const desc = /desc/.test(t);
    return { rows: desc
      ? [{ sku: 'WIN-2', product_title: 'Champagne Reserve', variant_title: '750ml', vendor: 'Cuvee', quantity: 1, unit_price: 100, line_total: 100 }]
      : [{ sku: 'WIN-1', product_title: 'Sancerre',          variant_title: '750ml', vendor: 'Loire', quantity: 2, unit_price: 50,  line_total: 100 }] };
  }
  // Order includes category (boolean checks)
  if (/select\s+(?:exists \([\s\S]+\)\s+as has_\w+(?:,\s+)?)+\s*$/m.test(t) || /\sas\s+has_\w+/.test(t)) {
    return { rows: [{ has_liquor: false, has_wine: true }] };
  }

  // Customer last order (UNION ALL with bucket order/line)
  if (/with latest as[\s\S]+order_line_items oli on oli.order_id = latest.order_id/.test(t)) {
    return { rows: [
      { bucket: 'order', order_id: 9001, order_name: '#37857', occurred_at: '2026-06-15T18:30:00Z', total_price: 216, financial_status: 'paid', fulfillment_status: 'fulfilled',
        sku: null, product_title: null, variant_title: null, quantity: null, unit_price: null },
      { bucket: 'line',  order_id: 9001, order_name: '#37857', occurred_at: null, total_price: null, financial_status: null, fulfillment_status: null,
        sku: 'WIN-1', product_title: 'Sancerre',          variant_title: '750ml', quantity: 2, unit_price: 50 },
      { bucket: 'line',  order_id: 9001, order_name: '#37857', occurred_at: null, total_price: null, financial_status: null, fulfillment_status: null,
        sku: 'WIN-2', product_title: 'Champagne Reserve', variant_title: '750ml', quantity: 1, unit_price: 100 },
    ] };
  }
  // Customer last-N orders
  if (/from orders o\s+where o.customer_id = \$1\s+and o.cancelled_at is null\s+order by coalesce\(o.processed_at, o.created_at\) desc\s+limit \$2/.test(t)) {
    return { rows: [
      { order_id: 9001, name: '#37857', occurred_at: '2026-06-15T18:30:00Z', total_price: 216, financial_status: 'paid', fulfillment_status: 'fulfilled', line_items: 2 },
      { order_id: 9000, name: '#37800', occurred_at: '2026-05-10T16:00:00Z', total_price: 88,  financial_status: 'paid', fulfillment_status: 'fulfilled', line_items: 1 },
    ] };
  }

  // Customer comparison (UNION ALL side=A/B)
  if (/select\s+\$1::bigint as customer_id,\s+'A'/.test(t)) {
    return { rows: [
      { customer_id: 100, side: 'A', total_spend: 8421, units: 42, order_count: 33, average_order_value: 255.18, first_order_at: '2025-01-01T00:00:00Z', last_order_at: '2026-06-15T00:00:00Z' },
      { customer_id: 101, side: 'B', total_spend: 4210, units: 21, order_count: 18, average_order_value: 233.89, first_order_at: '2025-05-01T00:00:00Z', last_order_at: '2026-05-10T00:00:00Z' },
    ] };
  }

  // Customer time series
  if (/date_trunc[\s\S]+from fact_sales fs\s+where fs.customer_id = \$1/.test(t)) {
    return { rows: [
      { bucket: '2026-04-06T00:00:00Z', units: 5,  net_revenue: 200,  orders: 2 },
      { bucket: '2026-04-13T00:00:00Z', units: 8,  net_revenue: 320,  orders: 3 },
      { bucket: '2026-04-20T00:00:00Z', units: 12, net_revenue: 480,  orders: 4 },
    ] };
  }
  // Customer change over time
  if (/with cur as[\s\S]+prev as[\s\S]+from fact_sales fs[\s\S]+where fs.customer_id = \$1/.test(t)) {
    return { rows: [
      { bucket: 'current',  revenue: 5000, units: 80, orders: 28 },
      { bucket: 'previous', revenue: 3500, units: 60, orders: 22 },
    ] };
  }
  // Customer color mix
  if (/case[\s\S]+when lower\(fs.product_title\) like '%sparkling%'/.test(t)) {
    return { rows: [
      { color_bucket: 'red',       units: 20, spend: 800, orders: 12 },
      { color_bucket: 'white',     units: 14, spend: 560, orders: 9 },
      { color_bucket: 'sparkling', units: 3,  spend: 240, orders: 3 },
    ] };
  }

  // Overlap share
  if (/count\(distinct o\.id\) filter \(where o.cancelled_at is null and exists/.test(t)) {
    return { rows: [{ numerator: 12, denominator: 88 }] };
  }

  // Customer-level top product/vendor/category
  if (/from fact_sales fs[\s\S]+where fs.customer_id = \$1[\s\S]+group by fs.product_title/.test(t)) {
    return { rows: [{ product_title: 'Sancerre', units: 12, spend: 360, orders: 6 }] };
  }

  // Customer spend / units bought
  if (/from fact_sales fs\s+where fs.customer_id = \$1/.test(t)) {
    return { rows: [{ customer_id: 100, units: 42, order_count: 33, total_spend: 8421, average_order_value: 255.18 }] };
  }

  // Sales summary single row
  if (/as net_revenue/.test(t) && /as average_order_value/.test(t) && /from fact_sales/.test(t) && !/date_trunc/.test(t)) {
    return { rows: [{ orders: 110, units: 380, net_revenue: 4250.55, gross_revenue: 4400, discounts: 150, average_order_value: 38.64 }] };
  }
  // Period over period
  if (/union all\s+select 'previous'/.test(t)) {
    return { rows: [
      { bucket: 'current',  revenue: 7500, units: 150, orders: 20 },
      { bucket: 'previous', revenue: 6000, units: 130, orders: 18 },
    ] };
  }

  // basket / top customers / top items fallthroughs
  if (/from order_line_items a[\s\S]+join order_line_items b/.test(t)) {
    return { rows: [{ product_a: 'A', product_b: 'B', times_bought_together: 5 }] };
  }
  if (/from dim_customer_profile\s+where total_spend > 0/.test(t)) {
    return { rows: [{ customer_id: 1, customer_name: 'T S', email: 't@x.com', total_spend: 8000, order_count: 33 }] };
  }
  if (/from fact_sales fs[\s\S]+group by fs.product_id, fs.sku/.test(t)) {
    return { rows: [{ product_id: 1, sku: 'A', product_title: 'X', units_sold: 22, net_revenue: 660 }] };
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
          if ((res.headers['content-type'] || '').includes('json')) {
            try { parsed = JSON.parse(buf); } catch { parsed = { _raw: buf }; }
          } else { parsed = buf; }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
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

  // Order detail
  header('live: order detail');
  const o1 = await ask('what was on order #37857');
  check('order_items_lookup resolves + line items present', () => {
    assert.strictEqual(o1.body.intent, 'order_items_lookup');
    assert.strictEqual(o1.body.meta.status, 'ok');
    assert.strictEqual(o1.body.data.length, 2);
    assert.ok(/Sancerre/.test(o1.body.answer));
  });
  const o2 = await ask('who placed order #37857');
  check('order_customer_lookup names Brian Hadfield', () => {
    assert.strictEqual(o2.body.intent, 'order_customer_lookup');
    assert.ok(/Brian Hadfield/.test(o2.body.answer));
  });
  const o3 = await ask('how much was order #37857');
  check('order_total_lookup answer mentions $216', () => {
    assert.strictEqual(o3.body.intent, 'order_total_lookup');
    assert.ok(/\$216/.test(o3.body.answer));
  });
  const o4 = await ask('was order #37857 cancelled');
  check('order_status_lookup', () => assert.strictEqual(o4.body.intent, 'order_status_lookup'));
  const o5 = await ask('what was the most expensive item on order #37857');
  check('order_extreme_item_lookup (high) - Champagne Reserve', () => {
    assert.strictEqual(o5.body.intent, 'order_extreme_item_lookup');
    assert.ok(/Champagne Reserve/.test(o5.body.answer));
  });
  const o6 = await ask('what was the cheapest item on order #37857');
  check('order_extreme_item_lookup (low) - Sancerre', () => {
    assert.strictEqual(o6.body.intent, 'order_extreme_item_lookup');
    assert.ok(/Sancerre/.test(o6.body.answer));
  });
  const o7 = await ask('did order #37857 include liquor');
  check('order_includes_category - liquor: no', () => {
    assert.strictEqual(o7.body.intent, 'order_includes_category');
    assert.ok(/liquor:\s*no/i.test(o7.body.answer));
  });
  const oNotFound = await ask('what was on order #99999');
  check('unknown order returns not_found', () => {
    assert.strictEqual(oNotFound.body.meta.status, 'not_found');
  });

  // Customer last order
  header('live: customer last order');
  const c1 = await ask('show me brian hadfield last order');
  check('customer_last_order_items resolves + items present', () => {
    assert.strictEqual(c1.body.intent, 'customer_last_order_items');
    assert.ok(/#37857/.test(c1.body.answer));
    assert.ok(/Sancerre/.test(c1.body.answer));
  });
  const c2 = await ask('show me brian hadfield last 5 orders');
  check('customer_last_n_orders returns rows', () => {
    assert.strictEqual(c2.body.intent, 'customer_last_n_orders');
    assert.ok(c2.body.data.length >= 1);
  });

  // Customer comparison
  header('live: customer comparison');
  const cmp = await ask('compare brian hadfield with chelsey hadfield');
  check('customer_comparison resolves both sides + multi-metric answer', () => {
    assert.strictEqual(cmp.body.intent, 'customer_comparison');
    assert.strictEqual(cmp.body.meta.status, 'ok');
    assert.strictEqual(cmp.body.meta.resolved.customerPair.left.customer_name, 'Brian Hadfield');
    assert.strictEqual(cmp.body.meta.resolved.customerPair.right.customer_name, 'Chelsey Hadfield');
    assert.ok(/Spend:/.test(cmp.body.answer));
    assert.ok(/AOV:/.test(cmp.body.answer));
  });

  // Customer change over time
  header('live: customer change-over-time');
  const cot = await ask('how has brian hadfield buying changed over the last 12 months');
  check('customer_change_over_time + change % derived', () => {
    assert.strictEqual(cot.body.intent, 'customer_change_over_time');
    assert.ok(/Change:/.test(cot.body.answer));
  });

  // Customer color mix
  header('live: customer color mix');
  const mix = await ask('does brian hadfield usually get red or white');
  check('customer_color_mix returns red/white/sparkling rows', () => {
    assert.strictEqual(mix.body.intent, 'customer_color_mix');
    assert.ok(/red/.test(mix.body.answer));
    assert.ok(/white/.test(mix.body.answer));
  });

  // Customer time series
  header('live: customer time series');
  const cts = await ask('chart brian hadfield revenue by week for the last 10 weeks');
  check('customer_time_series + visualization', () => {
    assert.strictEqual(cts.body.intent, 'customer_time_series');
    assert.ok(cts.body.visualization);
    assert.strictEqual(cts.body.visualization.chart_type, 'line');
  });

  // Customer preference (case-insensitive)
  header('live: case-insensitive customer preference');
  const pref = await ask('what does brian hadfield usually buy');
  check('customer_top_products resolves Brian Hadfield', () => {
    assert.strictEqual(pref.body.intent, 'customer_top_products');
    assert.strictEqual(pref.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
  });

  // Overlap share
  header('live: overlap share');
  const ov = await ask('what percent of orders have both liquor and wine');
  check('order_overlap_share + percent in answer', () => {
    assert.strictEqual(ov.body.intent, 'order_overlap_share');
    assert.ok(/13\.6%/.test(ov.body.answer));
  });

  // Anchored-week comparison (period_over_period)
  header('live: anchored-week comparison');
  const wkcmp = await ask('compare sales for week of 5/31/2026 to week of 6/7/2026');
  check('period_over_period intent', () => {
    assert.strictEqual(wkcmp.body.intent, 'period_over_period');
  });

  // /qa page still works
  header('live: /qa page');
  const qaNo = await request('/qa', { method: 'GET' });
  check('GET /qa without auth -> 401', () => assert.strictEqual(qaNo.status, 401));
  const qaOk = await request('/qa', { method: 'GET', headers: { Authorization: auth } });
  check('GET /qa with auth -> 200 + HTML', () => {
    assert.strictEqual(qaOk.status, 200);
    assert.ok(/<title>Harvest BI<\/title>/.test(qaOk.body));
  });

  // Regression: /recommend
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('/recommend 200 + recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });
  // Auth still enforced
  const noAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('/shopify-qa no auth -> 401', () => assert.strictEqual(noAuth.status, 401));

  console.log('');
  if (failures) {
    console.error(`manager-qa v5 smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`manager-qa v5 smoke: ALL OK (${queryLog.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('manager-qa v5 smoke crashed:', e);
  process.exit(1);
});
