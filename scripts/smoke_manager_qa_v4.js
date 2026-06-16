#!/usr/bin/env node
// scripts/smoke_manager_qa_v4.js
// Smartness-pass smoke. Covers spec sections A–O plus the GET /qa page.

const assert = require('assert');
const http = require('http');

// Env setup
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34606';
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

// ----- Pure unit tests ----------------------------------------------------
header('intent classification — v4 smartness pass');
const parser = require('../src/analytics/intentParser');
const cases = [
  // A. Repeat / returning / first-time
  ['how many repeat customers did we have yesterday',          'repeat_customers_count'],
  ['how many returning customers did we have yesterday',       'repeat_customers_count'],
  ['how many repeat buyers did we have yesterday',             'repeat_customers_count'],
  ['how many returning buyers bought last week',               'repeat_customers_count'],
  ['how many first time customers were in the store yesterday','new_customers_count'],
  ['how many new customers bought yesterday',                  'new_customers_count'],
  ['how many first-time buyers did we have yesterday',         'new_customers_count'],
  ['what percent of customers last week were first time customers',     'new_customers_share'],
  ['what percentage of customers last week were new customers',         'new_customers_share'],
  ['what share of customers last week were first time buyers',          'new_customers_share'],
  ['what percent of customers yesterday were repeat buyers',            'repeat_customers_share'],
  ['what percentage of customers this month are returning customers',   'repeat_customers_share'],

  // B. Top spender
  ['who spent the most yesterday',                             'top_customers_by_spend'],
  ['who spent the most last week',                             'top_customers_by_spend'],
  ['who was our top spender yesterday',                        'top_customers_by_spend'],
  ['which customer spent the most yesterday',                  'top_customers_by_spend'],
  ['rank customers by order count last month',                 'top_customers_by_order_count'],
  ['top customers by order count last month',                  'top_customers_by_order_count'],
  ['which customers placed the most orders last month',        'top_customers_by_order_count'],
  ['who ordered most often last month',                        'top_customers_by_order_count'],
  ['show me the top 10 customers by order count',              'top_customers_by_order_count'],

  // C. Customer frequency / cadence
  ['how often does Brian Hadfield shop with us',               'customer_frequency_profile'],
  ['what is Brian Hadfield average time between orders',       'customer_frequency_profile'],
  ['which customers shop most frequently',                     'top_customers_by_order_count'],
  ['who shops with us the most often',                         'top_customers_by_order_count'],
  ['who has not shopped in a while that previously came in frequently', 'lapsed_frequent_customers'],
  ['which customers used to buy often but have stopped',       'lapsed_frequent_customers'],
  ['who are our lapsed frequent customers',                    'lapsed_frequent_customers'],
  ['which customers were regulars but have gone quiet',        'lapsed_frequent_customers'],
  ['which top customers have not purchased in 60 days',        'lapsed_frequent_customers'],
  ['which customers came back after being inactive',           'customer_reactivation_candidates'],

  // D. Customer preference
  ['what does brian hadfield buy the most of',                 'customer_top_products'],
  ['what does Brian Hadfield usually buy',                     'customer_top_products'],
  ['what varietal does brian hadfield buy the most',           'customer_top_varietals'],
  ['what varietal does Brian Hadfield purchase most often',    'customer_top_varietals'],
  ['what vendor does Brian Hadfield buy the most',             'customer_top_vendors'],
  ['what category does Brian Hadfield buy the most',           'customer_top_categories'],

  // E. Type / category / varietal breakdown
  ['what type of product sold the most yesterday',             'type_top_seller'],
  ['which product type sold the most yesterday',               'type_top_seller'],
  ['what types sold last week',                                'type_top_seller'],
  ['show me how many units of each type sold last week',       'type_breakdown'],
  ['show me units sold by type last week',                     'type_breakdown'],
  ['break out last week sales by vendor in a table',           'type_breakdown'],
  ['show me the top 5 varietals last week',                    'varietal_ranking'],
  ['what were the best-selling varietals last week',           'varietal_ranking'],
  ['top varietals by units last week',                         'varietal_ranking'],
  ['top 10 varietals this month',                              'varietal_ranking'],
  ['which varietals sold the most yesterday',                  'varietal_ranking'],

  // G. Explicit top-N
  ['top 20 items sold yesterday',                              'top_items_by_units'],
  ['top 25 products sold last week',                           'top_items_by_units'],
  ['top 15 SKUs this month',                                   'top_items_by_units'],
  ['top 30 customers by spend',                                'top_customers_by_spend'],
  ['top 12 vendors last quarter',                              'top_vendors'],

  // H. Basket variants
  ['what items sell together the most',                        'basket_pairs'],
  ['which items sell together the most',                       'basket_pairs'],
  ['what products sell together the most',                     'basket_pairs'],
  ['what products are bought together the most',               'basket_pairs'],
  ['which items are most commonly bought together',            'basket_pairs'],
  ['what products pair together most often',                   'basket_pairs'],

  // I. Busiest hour
  ['what hour was busiest yesterday',                          'busiest_hour'],
  ['what was our busiest hour yesterday',                      'busiest_hour'],
  ['what time of day was busiest yesterday',                   'busiest_hour'],
  ['what hour had the most orders yesterday',                  'busiest_hour'],
  ['what hour had the most sales yesterday',                   'busiest_hour'],
  ['typically, when is the store busiest',                     'busiest_period_pattern'],
  ['when is the store usually busiest',                        'busiest_period_pattern'],
  ['what time is the store busiest on average',                'busiest_period_pattern'],
  ['what day of week is busiest',                              'busiest_period_pattern'],
  ['when do we usually sell the most',                         'busiest_period_pattern'],
  ['what are our peak shopping hours',                         'busiest_period_pattern'],
  ['what are our busiest days and times',                      'busiest_period_pattern'],

  // J. Dashboard
  ['give me a dashboard of all the important metrics for last week', 'dashboard_summary'],
  ['show me a dashboard for last week',                              'dashboard_summary'],
  ['summarize last week business',                                   'dashboard_summary'],
  ['give me the key metrics for last week',                          'dashboard_summary'],
  ['show me last week KPI dashboard',                                'dashboard_summary'],
  ['what were the important metrics last week',                      'dashboard_summary'],
  ['give me an executive summary for last week',                     'dashboard_summary'],

  // L. Comparisons
  ['how did last week compare to the week before',             'period_over_period'],
  ['how did last week compare to the prior week',              'period_over_period'],
  ['compare last week to the week before',                     'period_over_period'],
  ['was last week better than the week before',                'period_over_period'],
  ['how were sales last week versus the prior week',           'period_over_period'],
  ['how did we do last week compared with the week before',    'period_over_period'],

  // M. Price extremes
  ['what was the most expensive bottle sold last week',        'highest_priced_item_sold'],
  ['what was the highest priced bottle sold last week',        'highest_priced_item_sold'],
  ['what was the most expensive item sold yesterday',          'highest_priced_item_sold'],
  ['what was the highest priced wine sold this month',         'highest_priced_item_sold'],
  ['which bottle sold for the most last quarter',              'highest_priced_item_sold'],
  ['who bought the most expensive bottle yesterday',           'buyer_of_highest_priced_item'],
  ['who bought the highest priced bottle yesterday',           'buyer_of_highest_priced_item'],
  ['which customer bought the highest priced item last week',  'buyer_of_highest_priced_item'],
  ['who purchased the most expensive wine this month',         'buyer_of_highest_priced_item'],
  ['who bought the cheapest bottle yesterday',                 'buyer_of_lowest_priced_item'],
  ['who bought the least expensive bottle yesterday',          'buyer_of_lowest_priced_item'],
  ['who bought the cheapest item yesterday',                   'buyer_of_lowest_priced_item'],
  ['what was the cheapest bottle sold yesterday',              'lowest_priced_item_sold'],
  ['what was the least expensive item sold yesterday',         'lowest_priced_item_sold'],

  // N. Customer count / traffic-like
  ['how many customers came in the store yesterday',           'customers_count_purchasing'],
  ['how many customers bought yesterday',                      'customers_count_purchasing'],
  ['how many distinct customers purchased yesterday',          'customers_count_purchasing'],
  ['how many customers placed orders yesterday',               'customers_count_purchasing'],
  ['how many customers shopped with us yesterday',             'customers_count_purchasing'],
  ['how many first time customers were in the store yesterday','new_customers_count'],
  ['how many returning customers were in the store yesterday', 'repeat_customers_count'],

  // O. Share / percentage
  ['what percent of customers last week were first time customers', 'new_customers_share'],
  ['what percentage of customers last week were repeat customers',  'repeat_customers_share'],
  ['what percentage of sales yesterday was white wine',             'share_of_sales_by_filter'],
  ['what percentage of revenue this month came from sparkling',     'share_of_sales_by_filter'],
  ['what share of units last week was Pinot Noir',                  'share_of_sales_by_filter'],
  ['what percentage of orders included gift items',                 'share_of_orders_with_filter'],
  ['what percentage of revenue came from the top 10 products',      'share_of_revenue_top_n'],
  ['what share of inventory value is dead inventory',               'share_of_dead_inventory_value'],

  // F. Category synonyms (route into top_items via category filter)
  ['what were liquor sales last week',                              'sales_summary'],
  ['what were spirit sales last week',                              'sales_summary'],
  ['what were spirits sales last week',                             'sales_summary'],
  ['what were beer sales last week',                                'sales_summary'],
  ['how much liquor did we sell last week',                         'sales_summary'],
  ['how much spirit did we sell last week',                         'sales_summary'],
  ['how much beer did we sell yesterday',                           'sales_summary'],
  ['what were non-wine sales last month',                           'sales_summary'],
  ['what were gift sales last week',                                'sales_summary'],
  ['what were mixer sales last week',                               'sales_summary'],
];
for (const [q, expected] of cases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parser.parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

// K. Output-mode detection
header('output-mode + chart-type detection');
check('"create a chart of revenue" → outputMode=chart', () => {
  const p = parser.parse('create a chart of revenue for the last 8 weeks');
  assert.strictEqual(p.params.outputMode, 'chart');
});
check('"bar graph of sales by day" → chartType=bar', () => {
  const p = parser.parse('show me a bar graph of sales by day last month');
  assert.strictEqual(p.params.chartType, 'bar');
});
check('"line chart of revenue by month" → chartType=line', () => {
  const p = parser.parse('show me a line chart of revenue by month this year');
  assert.strictEqual(p.params.chartType, 'line');
});
check('"show me a table of dead inventory" → outputMode=table', () => {
  const p = parser.parse('show me dead inventory in a table');
  assert.strictEqual(p.params.outputMode, 'table');
});
check('"break out last week sales by vendor" → outputMode=table', () => {
  const p = parser.parse('break out last week sales by vendor in a table');
  assert.strictEqual(p.params.outputMode, 'table');
});

// G. Top-N is preserved through to params.limit
header('explicit top-N propagation');
check('top 20 → limit=20', () => assert.strictEqual(parser.parse('top 20 items sold yesterday').params.limit, 20));
check('top 25 → limit=25', () => assert.strictEqual(parser.parse('top 25 products sold last week').params.limit, 25));
check('top 5 → limit=5',   () => assert.strictEqual(parser.parse('top 5 varietals last week').params.limit, 5));
check('top 30 → limit=30', () => assert.strictEqual(parser.parse('top 30 customers by spend').params.limit, 30));
check('top 12 → limit=12', () => assert.strictEqual(parser.parse('top 12 vendors last quarter').params.limit, 12));

// F. Category synonyms carry through
header('category synonym extraction');
check('"liquor" → category=spirit',  () => assert.strictEqual(parser.parse('what were liquor sales last week').params.category, 'spirit'));
check('"spirits" → category=spirit', () => assert.strictEqual(parser.parse('what were spirits sales last week').params.category, 'spirit'));
check('"beer" → category=beer',      () => assert.strictEqual(parser.parse('what were beer sales last week').params.category, 'beer'));
check('"non-wine" → category=non-wine', () => assert.strictEqual(parser.parse('what were non-wine sales last month').params.category, 'non-wine'));
check('"gift" → category=gift',      () => assert.strictEqual(parser.parse('what were gift sales last week').params.category, 'gift'));
check('"mixer" → category=mixer',    () => assert.strictEqual(parser.parse('what were mixer sales last week').params.category, 'mixer'));

// ----- Live tests -----
header('live /shopify-qa with stubbed db + GET /qa page');

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
    return { rows: [] };
  }
  if (/from customers\s+where \(lower\(coalesce\(first_name/.test(t)) return { rows: [] };

  // Dashboard summary UNION ALL
  if (/select 'kpi'::text as bucket/.test(t)) {
    return { rows: [
      { bucket: 'kpi',         label: null,                revenue: 7500, units: 150, orders: 20, customers: 14, aov: 375 },
      { bucket: 'top_product', label: 'Sancerre',          revenue: 600,  units: 12,  orders: 8,  customers: null, aov: null },
      { bucket: 'top_product', label: 'Pinot Noir Vintage',revenue: 480,  units: 9,   orders: 6,  customers: null, aov: null },
      { bucket: 'top_vendor',  label: 'Loire House',       revenue: 1100, units: 28,  orders: 14, customers: null, aov: null },
    ] };
  }

  // Repeat/new customer count SQL (CTEs in_window + earliest)
  if (/with in_window as/.test(t) && /earliest as/.test(t)) {
    // The same shape is used for both repeat and new — formatter reads either
    // r.repeat_customers or r.new_customers, so include both with appropriate
    // values when the SQL selects them.
    if (/as repeat_customers/.test(t)) return { rows: [{ repeat_customers: 18, purchasing_customers: 92 }] };
    if (/as new_customers/.test(t))    return { rows: [{ new_customers: 22, purchasing_customers: 92 }] };
    return { rows: [{ purchasing_customers: 92 }] };
  }

  // customers_count_purchasing
  if (/count\(distinct fs.customer_id\)::int\s+as purchasing_customers/.test(t)) {
    return { rows: [{ purchasing_customers: 92, orders: 110, net_revenue: 4250.55 }] };
  }

  // Busiest hour single window
  if (/date_part\('hour', occurred_at\)::int\s+as hour_of_day/.test(t)) {
    return { rows: [
      { hour_of_day: 17, orders: 18, units: 38, net_revenue: 940 },
      { hour_of_day: 18, orders: 16, units: 30, net_revenue: 820 },
      { hour_of_day: 16, orders: 12, units: 22, net_revenue: 660 },
    ] };
  }
  // Busiest period pattern
  if (/to_char\(occurred_at, 'Dy'\)::text/.test(t)) {
    return { rows: [
      { day_of_week: 'Fri', dow_idx: 5, hour_of_day: 17, orders: 50, net_revenue: 2400 },
      { day_of_week: 'Sat', dow_idx: 6, hour_of_day: 16, orders: 47, net_revenue: 2200 },
    ] };
  }

  // Price extremes (fact_sales unit_price desc/asc)
  if (/order by fs.unit_price desc/.test(t)) {
    return { rows: [
      { sku: 'CH-1', product_title: 'Grand Cru Chardonnay', variant_title: '750ml', unit_price: 320, quantity: 1, occurred_at: '2026-06-15T20:00:00Z', order_name: '#5210', customer_name: 'Terry White', customer_email: 'terry@example.com' },
    ] };
  }
  if (/order by fs.unit_price asc/.test(t)) {
    return { rows: [
      { sku: 'MM-1', product_title: 'Mini Cider', variant_title: '12oz', unit_price: 3, quantity: 1, occurred_at: '2026-06-15T11:00:00Z', order_name: '#5212', customer_name: 'Sam Lin', customer_email: 'sam@example.com' },
    ] };
  }

  // customer_top_products / vendors / categories  (fact_sales fs where fs.customer_id = $1 group by ...)
  if (/from fact_sales fs[\s\S]+where fs.customer_id = \$1[\s\S]+group by fs.product_title/.test(t)) {
    return { rows: [{ product_title: 'Sancerre', units: 12, spend: 360, orders: 6 }] };
  }
  if (/from fact_sales fs[\s\S]+where fs.customer_id = \$1[\s\S]+group by 1\s+order by spend desc/.test(t) && /vendor/.test(t)) {
    return { rows: [{ vendor: 'Loire House', units: 18, spend: 540, orders: 8 }] };
  }
  if (/left join products p on p.id = fs.product_id\s+where fs.customer_id = \$1/.test(t)) {
    return { rows: [{ category: 'White', units: 22, spend: 660, orders: 10 }] };
  }

  // customer_frequency_profile
  if (/with orders_per as/.test(t) && /spans as/.test(t)) {
    return { rows: [{ customer_id: 100, order_count: 12, first_order_at: '2025-01-10T00:00:00Z', last_order_at: '2026-06-10T00:00:00Z', span_days: 516, avg_days_between_orders: 46.9, days_since_last_order: 6 }] };
  }

  // lapsed_frequent_customers
  if (/from dim_customer_profile\s+where order_count >= \$1\s+and days_since_last_order >= \$2/.test(t)) {
    return { rows: [{ customer_id: 200, email: 'lapsed@example.com', customer_name: 'Lap Sed', order_count: 9, total_spend: 1200, last_order_at: '2026-02-01T00:00:00Z', days_since_last_order: 135 }] };
  }

  // reactivation candidates
  if (/with last_two as/.test(t)) {
    return { rows: [{ customer_id: 300, email: 're@example.com', customer_name: 'Re Activated', last_at: '2026-06-10T00:00:00Z', prev_at: '2025-09-01T00:00:00Z', gap_days: 282 }] };
  }

  // type_breakdown / type_top_seller / varietal_ranking
  if (/left join products p on p.id = fs.product_id[\s\S]+group by 1\s+order by units/.test(t)) {
    return { rows: [
      { type: 'Red Wine',   units: 60, revenue: 2400, orders: 35 },
      { type: 'White Wine', units: 45, revenue: 1800, orders: 28 },
    ] };
  }
  if (/select fs.product_title\s+as varietal/.test(t)) {
    return { rows: [
      { varietal: 'Sancerre',   units: 24, revenue: 720, customers: 12 },
      { varietal: 'Chardonnay', units: 18, revenue: 540, customers: 9 },
    ] };
  }

  // share_of_sales_by_filter (sum case when ... then net_revenue end)
  if (/sum\(case when[\s\S]+then fs.net_revenue end\)/.test(t)) {
    return { rows: [{ numerator: 1500, denominator: 5000, units_numerator: 30, units_denominator: 120 }] };
  }
  // share_of_revenue_top_n
  if (/with totals as[\s\S]+ranked as/.test(t)) {
    return { rows: [{ denominator: 10000, numerator: 4000, top_n: 10, top_products: ['A','B','C'] }] };
  }
  // share_of_dead_inventory_value
  if (/with totals as[\s\S]+dead as/.test(t)) {
    return { rows: [{ numerator: 6000, denominator: 50000 }] };
  }
  // share_of_orders_with_filter
  if (/count\(distinct o\.id\) filter \(where exists/.test(t)) {
    return { rows: [{ numerator: 14, denominator: 88 }] };
  }

  // top_customers_by_spend → dim_customer_profile
  if (/from dim_customer_profile\s+where total_spend > 0/.test(t)) {
    return { rows: [{ customer_id: 1, email: 'a@b.com', customer_name: 'Top Spender', total_spend: 3210, order_count: 18 }] };
  }
  // top_customers_by_spend windowed (sum from fact_sales)
  if (/from fact_sales fs[\s\S]+order by total_spend desc/.test(t)) {
    return { rows: [{ customer_id: 1, email: 'a@b.com', customer_name: 'Top Spender', total_spend: 540, order_count: 4 }] };
  }
  // top_customers_by_order_count windowed
  if (/order by order_count desc/.test(t)) {
    return { rows: [{ customer_id: 2, email: 'c@d.com', customer_name: 'Frequent Sue', order_count: 7, total_spend: 410 }] };
  }
  // top_customers_by_aov
  if (/order by average_order_value desc/.test(t)) {
    return { rows: [{ customer_id: 3, email: 'e@f.com', customer_name: 'High AOV', order_count: 3, total_spend: 900, average_order_value: 300 }] };
  }
  // top_items_by_units / revenue
  if (/from fact_sales fs[\s\S]+group by fs.product_id, fs.sku/.test(t)) {
    return { rows: [{ product_id: 1, sku: 'A', product_title: 'Sample', units_sold: 22, net_revenue: 660 }] };
  }
  // top_vendors
  if (/from fact_sales[\s\S]+group by 1\s+order by net_revenue/.test(t)) {
    return { rows: [{ vendor: 'Acme', units_sold: 50, net_revenue: 4200, orders: 30 }] };
  }
  // basket_pairs
  if (/from order_line_items a[\s\S]+join order_line_items b/.test(t)) {
    return { rows: [{ product_a: 'A', product_b: 'B', times_bought_together: 5 }] };
  }
  // sales_summary
  if (/as net_revenue/.test(t) && /as average_order_value/.test(t) && /from fact_sales/.test(t) && !/date_trunc/.test(t)) {
    return { rows: [{ orders: 110, units: 380, net_revenue: 4250.55, gross_revenue: 4400, discounts: 150, average_order_value: 38.64 }] };
  }
  // sales_time_series (date_trunc)
  if (/date_trunc/.test(t) && /from fact_sales/.test(t)) {
    return { rows: [
      { bucket: '2026-06-08T00:00:00Z', orders: 11, units: 25, net_revenue: 480, average_order_value: 43.6 },
      { bucket: '2026-06-09T00:00:00Z', orders: 14, units: 32, net_revenue: 612, average_order_value: 43.7 },
    ] };
  }
  // period_over_period
  if (/union all\s+select 'previous'/.test(t)) {
    return { rows: [
      { bucket: 'current',  revenue: 7500, units: 150, orders: 20 },
      { bucket: 'previous', revenue: 6000, units: 130, orders: 18 },
    ] };
  }
  // low_stock
  if (/from vw_current_inventory\s+where on_hand > 0\s+and on_hand <= \$1/.test(t)) {
    return { rows: [{ product_title: 'Tiny', sku: 'T', on_hand: 3, price: 30 }] };
  }
  // dead inventory
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
          if ((res.headers['content-type'] || '').includes('json')) {
            try { parsed = JSON.parse(buf); } catch { parsed = { _raw: buf }; }
          } else {
            parsed = buf;
          }
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

  // Live: repeat / new / share
  header('live: repeat / new / share');
  const a1 = await ask('how many repeat customers did we have yesterday');
  check('repeat count: intent=repeat_customers_count + answer mentions 18/92', () => {
    assert.strictEqual(a1.body.intent, 'repeat_customers_count');
    assert.ok(/18 repeat/i.test(a1.body.answer));
    assert.ok(/92 purchasing/i.test(a1.body.answer));
  });
  const a2 = await ask('what percent of customers last week were first time customers');
  check('new share: intent=new_customers_share + 23.9% (22/92)', () => {
    assert.strictEqual(a2.body.intent, 'new_customers_share');
    assert.ok(/23\.9%/.test(a2.body.answer));
  });

  // Live: dashboard
  header('live: dashboard');
  const a3 = await ask('give me a dashboard for last week');
  check('dashboard intent + visualization spec present', () => {
    assert.strictEqual(a3.body.intent, 'dashboard_summary');
    assert.ok(a3.body.visualization, 'expected visualization object');
  });

  // Live: busiest hour
  header('live: busiest hour');
  const a4 = await ask('what hour was busiest yesterday');
  check('busiest_hour + answer mentions hour', () => {
    assert.strictEqual(a4.body.intent, 'busiest_hour');
    assert.ok(/5 PM/.test(a4.body.answer));
  });
  const a4p = await ask('typically, when is the store busiest');
  check('busiest_period_pattern returned', () => {
    assert.strictEqual(a4p.body.intent, 'busiest_period_pattern');
  });

  // Live: price extremes
  header('live: price extremes');
  const a5 = await ask('what was the most expensive bottle sold last week');
  check('highest_priced_item_sold + customer name + $320', () => {
    assert.strictEqual(a5.body.intent, 'highest_priced_item_sold');
    assert.ok(/Grand Cru Chardonnay/.test(a5.body.answer));
    assert.ok(/\$320/.test(a5.body.answer));
  });
  const a6 = await ask('who bought the most expensive bottle yesterday');
  check('buyer_of_highest_priced_item + Terry White', () => {
    assert.strictEqual(a6.body.intent, 'buyer_of_highest_priced_item');
    assert.ok(/Terry White/.test(a6.body.answer));
  });
  const a7 = await ask('who bought the cheapest bottle yesterday');
  check('buyer_of_lowest_priced_item + Sam Lin + $3', () => {
    assert.strictEqual(a7.body.intent, 'buyer_of_lowest_priced_item');
    assert.ok(/Sam Lin/.test(a7.body.answer));
  });

  // Live: customer preference + cadence
  header('live: customer preference + cadence');
  const a8 = await ask('what does brian hadfield buy the most of');
  check('customer_top_products + resolved Brian Hadfield', () => {
    assert.strictEqual(a8.body.intent, 'customer_top_products');
    assert.strictEqual(a8.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
    assert.ok(/Sancerre/.test(a8.body.answer));
  });
  const a9 = await ask('how often does Brian Hadfield shop with us');
  check('customer_frequency_profile + avg days between', () => {
    assert.strictEqual(a9.body.intent, 'customer_frequency_profile');
    assert.ok(/46\.9d/.test(a9.body.answer));
  });

  // Live: type breakdown
  header('live: type / category / varietal breakdowns');
  const a10 = await ask('what type of product sold the most yesterday');
  check('type_top_seller intent', () => assert.strictEqual(a10.body.intent, 'type_top_seller'));
  const a11 = await ask('show me how many units of each type sold last week');
  check('type_breakdown + visualization', () => {
    assert.strictEqual(a11.body.intent, 'type_breakdown');
    assert.ok(a11.body.visualization);
  });
  const a12 = await ask('show me the top 5 varietals last week');
  check('varietal_ranking + limit=5', () => {
    assert.strictEqual(a12.body.intent, 'varietal_ranking');
    assert.strictEqual(a12.body.meta.params.limit, 5);
  });

  // Live: visualization spec
  header('live: visualization specs');
  const v1 = await ask('create a chart of revenue for the last 8 weeks');
  check('chart request sets output_mode=chart', () => {
    assert.strictEqual(v1.body.meta.params.output_mode, 'chart');
    assert.ok(v1.body.visualization);
    assert.strictEqual(v1.body.visualization.output_mode, 'chart');
  });
  const v2 = await ask('show me a table of dead inventory');
  check('table request sets output_mode=table', () => {
    assert.strictEqual(v2.body.meta.params.output_mode, 'table');
    assert.strictEqual(v2.body.visualization.output_mode, 'table');
  });
  const v3 = await ask('compare sales this week vs last week in a bar chart');
  check('period_over_period + chart_type=bar', () => {
    assert.strictEqual(v3.body.intent, 'period_over_period');
    assert.ok(/bar/.test(v3.body.visualization.chart_type || ''));
  });
  const v4 = await ask('show me sales by day last week');
  check('sales_time_series gets line chart by default', () => {
    assert.strictEqual(v4.body.intent, 'sales_time_series');
    assert.strictEqual(v4.body.visualization.chart_type, 'line');
  });

  // Live: shares
  header('live: shares');
  const sh1 = await ask('what percentage of sales yesterday was white wine');
  check('share_of_sales_by_filter answer contains %', () => {
    assert.strictEqual(sh1.body.intent, 'share_of_sales_by_filter');
    assert.ok(/%/.test(sh1.body.answer));
  });
  const sh2 = await ask('what share of inventory value is dead inventory');
  check('share_of_dead_inventory_value', () => {
    assert.strictEqual(sh2.body.intent, 'share_of_dead_inventory_value');
  });

  // Live: traffic-like customer count
  header('live: traffic-like count');
  const t1 = await ask('how many customers came in the store yesterday');
  check('customers_count_purchasing + footnote about purchase records', () => {
    assert.strictEqual(t1.body.intent, 'customers_count_purchasing');
    assert.ok(/purchase records/i.test(t1.body.answer));
  });

  // GET /qa page
  header('live: GET /qa page');
  const qa1 = await request('/qa', { method: 'GET' });
  check('GET /qa without auth → 401', () => assert.strictEqual(qa1.status, 401));
  const qa2 = await request('/qa', { method: 'GET', headers: { Authorization: auth } });
  check('GET /qa with auth → 200 + HTML', () => {
    assert.strictEqual(qa2.status, 200);
    assert.ok(/text\/html/.test(qa2.headers['content-type']));
    assert.ok(/<title>Harvest BI<\/title>/.test(qa2.body));
    assert.ok(/renderChart/.test(qa2.body));
  });

  // Regression sweep
  header('regression');
  const r1 = await ask('what is low stock');
  check('low_stock still works', () => assert.strictEqual(r1.body.intent, 'low_stock'));
  const r2 = await ask('top customers by spend');
  check('top_customers_by_spend still works', () => assert.strictEqual(r2.body.intent, 'top_customers_by_spend'));
  const r3 = await ask('what sells together');
  check('basket_pairs still works', () => assert.strictEqual(r3.body.intent, 'basket_pairs'));
  const r4 = await ask('which products have not sold in the last 30 days');
  check('dead_inventory + day_count=30', () => {
    assert.strictEqual(r4.body.intent, 'dead_inventory');
    assert.strictEqual(r4.body.meta.params.day_count, 30);
  });
  const r5 = await ask('how much has brian hadfield spent');
  check('lowercase customer still resolves', () => {
    assert.strictEqual(r5.body.intent, 'customer_spend');
    assert.strictEqual(r5.body.meta.resolved.customer.customer_name, 'Brian Hadfield');
  });

  // Auth + /recommend
  const noAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('no auth /shopify-qa → 401', () => assert.strictEqual(noAuth.status, 401));
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('/recommend 200 + recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });

  console.log('');
  if (failures) {
    console.error(`manager-qa v4 smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`manager-qa v4 smoke: ALL OK (${queryLog.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('manager-qa v4 smoke crashed:', e);
  process.exit(1);
});
