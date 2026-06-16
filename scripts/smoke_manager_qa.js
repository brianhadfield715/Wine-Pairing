#!/usr/bin/env node
// scripts/smoke_manager_qa.js
// Exhaustive natural-language smoke for the upgraded manager analytics.
//
// Covers:
//   - temporal parser (yesterday / last week / last month / ytd / all time / on Sunday / etc.)
//   - entity extraction (customer name, email, varietal, vendor, sku, money)
//   - intent classification for the new families
//   - end-to-end /shopify-qa with a stubbed DB:
//       · top items sold yesterday
//       · top items sold last week
//       · top items by revenue last month
//       · customer spend by name all time
//       · customer spend by name last week / last 30 days
//       · customer profile by name (resolved)
//       · ambiguous customer name -> disambiguation response
//       · unknown customer name -> not_found response
//       · customers who bought chardonnay last 90 days
//       · basket pairs / bought_with
//       · low_stock_high_velocity, dead_inventory, runout_risk
//       · top vendor this quarter
//       · period-over-period
//   - auth still enforced on /shopify-qa
//   - /recommend still public and unchanged

const assert = require('assert');
const http = require('http');

// ---------- 1) Pin "now" so date-window tests are deterministic ----------
// Tuesday 2026-06-16 16:00 UTC is what we picked when we wrote these cases.
const PIN_NOW = new Date('2026-06-16T16:00:00Z');

// ---------- 2) Set env BEFORE requiring server.js ------------------------
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34603';
process.env.QA_USER = 'smoke';
process.env.QA_PASS = 'smoke';
process.env.SHOP_DOMAIN  = 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = 'placeholder';

// ---------- 3) Pure unit tests (no HTTP) ---------------------------------
let failures = 0;
function header(t) { console.log('\n=== ' + t + ' ==='); }
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures += 1; console.log('  FAIL ' + label + ' — ' + e.message); }
}

header('temporal parser');
const temporal = require('../src/analytics/temporalParser');

function tf(q) { return temporal.parse(q, { now: PIN_NOW }); }
function dayOf(iso) { return iso ? iso.slice(0, 10) : null; }

check('today', () => {
  const r = tf('top items today');
  assert.strictEqual(r.mode, 'window');
  // local TZ offset -300 (CDT) → "today" is the local day around 2026-06-16
  assert.strictEqual(r.label, 'today');
  assert.ok(r.sinceIso && r.untilIso, 'missing bounds');
});
check('yesterday', () => {
  const r = tf('what were the top items sold yesterday');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'yesterday');
  assert.strictEqual(r.days, 1);
});
check('last week', () => {
  const r = tf('top wines last week');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'last week');
  assert.strictEqual(r.days, 7);
});
check('this month', () => {
  const r = tf('sales summary this month');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'this month');
});
check('last 30 days', () => {
  const r = tf('what sold in the last 30 days');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'last 30 days');
  assert.strictEqual(r.days, 30);
});
check('last quarter', () => {
  const r = tf('top vendors last quarter');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'last quarter');
});
check('year to date', () => {
  const r = tf('revenue year to date');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(r.label, 'year to date');
});
check('all time', () => {
  const r = tf('how much has John Smith spent all time');
  assert.strictEqual(r.mode, 'all_time');
});
check('in May 2026', () => {
  const r = tf('sales in May 2026');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(dayOf(r.sinceIso), '2026-05-01');
});
check('Q1 2026', () => {
  const r = tf('revenue in Q1 2026');
  assert.strictEqual(dayOf(r.sinceIso), '2026-01-01');
  assert.strictEqual(dayOf(r.untilIso), '2026-04-01');
});
check('between two dates', () => {
  const r = tf('sales between 2026-05-01 and 2026-05-15');
  assert.strictEqual(r.mode, 'window');
  assert.strictEqual(dayOf(r.sinceIso), '2026-05-01');
  assert.strictEqual(dayOf(r.untilIso), '2026-05-15');
});
check('since YYYY-MM-DD', () => {
  const r = tf('since 2026-06-01');
  assert.strictEqual(r.mode, 'open_after');
  assert.strictEqual(dayOf(r.sinceIso), '2026-06-01');
});
check('no temporal phrase → all_time', () => {
  const r = tf('top customers by spend');
  assert.strictEqual(r.mode, 'all_time');
});

header('entity extraction');
const entities = require('../src/analytics/entities');
check('extract customer "John Smith"', () => {
  const e = entities.extract('How much did John Smith spend last week?');
  assert.strictEqual(e.customer, 'John Smith');
});
check('extract customer "Terry White"', () => {
  const e = entities.extract('What did Terry White buy in the last 30 days?');
  assert.strictEqual(e.customer, 'Terry White');
});
check('extract email', () => {
  const e = entities.extract('Profile of customer jane@example.com please');
  assert.strictEqual(e.email, 'jane@example.com');
});
check('extract varietal chardonnay', () => {
  const e = entities.extract('Who bought the most chardonnay this quarter');
  assert.strictEqual(e.varietal, 'chardonnay');
});
check('extract metric "revenue"', () => {
  const e = entities.extract('top products by revenue last month');
  assert.strictEqual(e.metric, 'revenue');
});
check('extract metric "units"', () => {
  const e = entities.extract('top items by units sold this month');
  assert.strictEqual(e.metric, 'units');
});
check('extract limit "top 5"', () => {
  const e = entities.extract('top 5 customers by spend');
  assert.strictEqual(e.limit, 5);
});
check('name stopwords ignored', () => {
  const e = entities.extract('Top Items Sold Yesterday');
  assert.strictEqual(e.customer, null);
});

header('intent classification (parse)');
const parser = require('../src/analytics/intentParser');
const cases = [
  ['What were the top items sold yesterday?', 'top_items_by_units'],
  ['best sellers yesterday',                   'top_items_by_units'],
  ['what sold most yesterday',                 'top_items_by_units'],
  ['top wines yesterday',                      'top_items_by_units'],
  ['top items by revenue last month',          'top_items_by_revenue'],
  ['What are the top SKUs by units sold this month?', 'top_items_by_units'],
  ['How much did John Smith spend last week?', 'customer_spend'],
  ['How much has John Smith spent all time?',  'customer_spend'],
  ['What has John Smith spent?',               'customer_spend'],
  ['What did John Smith spend with us?',       'customer_spend'],
  ['How much revenue came from John Smith?',   'customer_spend'],
  ['What did Terry White buy in the last 30 days?', 'customer_recent_purchases'],
  ['How many orders has Mary Jones placed last month?', 'customer_order_count'],
  ['What is the average order value for Sarah Connor?', 'customer_aov'],
  ['Profile of Jane Doe',                      'customer_profile'],
  ['Who bought the most Chardonnay this quarter?', 'top_customers_by_varietal'],
  ['customers who bought chardonnay last 90 days', 'customers_who_bought'],
  ['Which items sold well but are now low stock?', 'low_stock_high_velocity'],
  ['What vendors are growing fastest?',        'vendor_growth'],
  ['What products have not sold in 90 days?',  'dead_inventory'],
  ['runout risk',                              'runout_risk'],
  ['overstock candidates',                     'overstock'],
  ['period over period',                       'period_over_period'],
  ['compared to last month',                   'period_over_period'],
  ['top vendors this quarter',                 'top_vendors'],
  ['what is often bought with our top chardonnay', 'bought_with_product'],
  ['one-time customers last month',            'customers_one_time_only'],
];
for (const [q, expected] of cases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parser.parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

// ---------- 4) Live HTTP test against the engine with stubbed DB ---------

header('live /shopify-qa with stubbed db');
// Pre-load the project db module and replace its query / withClient / isEnabled.
const db = require('../src/db');
db.isEnabled = () => true;

// Tiny query router that mimics realistic responses for each intent's SQL.
const queryLog = [];
db.query = async function (text, values) {
  queryLog.push({ text, values });
  const t = String(text || '');

  // Customer resolver – exact full-name match (case-insensitive)
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
  // Resolver: partial customer match (tokens "like %x%")
  if (/from customers\s+where \(lower\(coalesce\(first_name/.test(t)) {
    return { rows: [] }; // simulate "no partial match found"
  }

  // customer_spend / order_count / aov SQL
  if (/from fact_sales fs\s+where fs.customer_id = \$1/.test(t)) {
    // John Smith all-time vs windowed responses
    const cid = values[0];
    const hadWindow = values.length >= 3;
    if (cid === 10) {
      return { rows: [{ customer_id: 10, order_count: hadWindow ? 2 : 12, total_spend: hadWindow ? 410 : 5000, units: hadWindow ? 4 : 60, average_order_value: hadWindow ? 205 : 416.67, first_order_at: '2025-09-01T00:00:00Z', last_order_at: '2026-06-10T00:00:00Z' }] };
    }
    if (cid === 11) {
      // customer_recent_purchases
      if (/order by fs.occurred_at desc/.test(t)) {
        return { rows: [
          { occurred_at: '2026-06-15T00:00:00Z', sku: 'WIN-1', product_title: 'Sample Chardonnay', variant_title: '750ml', quantity: 2, net_revenue: 60, order_name: '#1001', order_id: 9001 },
          { occurred_at: '2026-05-10T00:00:00Z', sku: 'WIN-2', product_title: 'Sample Pinot Noir', variant_title: '750ml', quantity: 1, net_revenue: 40, order_name: '#1002', order_id: 9002 },
        ] };
      }
      return { rows: [{ customer_id: 11, order_count: 3, total_spend: 220, units: 4, average_order_value: 73.33, last_order_at: '2026-06-15T00:00:00Z' }] };
    }
    return { rows: [{ order_count: 0, total_spend: 0, units: 0, average_order_value: 0 }] };
  }

  // dim_customer_profile by id (customer_profile after resolution)
  if (/from dim_customer_profile where customer_id = \$1/.test(t)) {
    return { rows: [{ customer_id: values[0], email: 'jane1@example.com', customer_name: 'Jane Doe', total_spend: 500, order_count: 4, favorite_vendor: 'V1', favorite_product_type: 'Red', last_order_at: '2026-05-01T00:00:00Z' }] };
  }

  // top_items_by_units / top_items_by_revenue
  if (/from fact_sales fs[\s\S]+group by fs.product_id, fs.sku/.test(t)) {
    const orderBy = /order by net_revenue/.test(t) ? 'revenue' : 'units';
    if (orderBy === 'revenue') {
      return { rows: [
        { product_id: 1, sku: 'A', product_title: 'Wine A', vendor: 'V', units_sold: 8, net_revenue: 480 },
        { product_id: 2, sku: 'B', product_title: 'Wine B', vendor: 'V', units_sold: 12, net_revenue: 360 },
      ] };
    }
    return { rows: [
      { product_id: 2, sku: 'B', product_title: 'Wine B', vendor: 'V', units_sold: 22, net_revenue: 660 },
      { product_id: 1, sku: 'A', product_title: 'Wine A', vendor: 'V', units_sold: 18, net_revenue: 1080 },
    ] };
  }

  // top_customers_by_varietal
  if (/from fact_sales fs[\s\S]+group by fs.customer_id/.test(t)) {
    return { rows: [
      { customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', spend: 1200, units: 24, last_purchase: '2026-06-01T00:00:00Z' },
      { customer_id: 11, email: 'terry@example.com', customer_name: 'Terry White', spend: 800, units: 16 },
    ] };
  }

  // top_vendors
  if (/from fact_sales[\s\S]+group by 1\s+order by net_revenue/.test(t)) {
    return { rows: [
      { vendor: 'Acme', units_sold: 50, net_revenue: 4200, orders: 30 },
      { vendor: 'Beta', units_sold: 30, net_revenue: 2400, orders: 18 },
    ] };
  }

  // vendor_growth
  if (/with cur as[\s\S]+full outer join prev/.test(t)) {
    return { rows: [
      { vendor: 'Acme', revenue_current: 5000, revenue_previous: 3000, revenue_delta: 2000, pct_change: 66.7 },
      { vendor: 'Beta', revenue_current: 1000, revenue_previous: 1500, revenue_delta: -500, pct_change: -33.3 },
    ] };
  }

  // basket_pairs SQL (two joins on order_line_items)
  if (/from order_line_items a[\s\S]+join order_line_items b/.test(t)) {
    return { rows: [
      { product_a: 'Sancerre', product_b: 'Loire Rosé', times_bought_together: 9 },
    ] };
  }

  // dead inventory / aged / unsold_in_period (dim_sku_profile)
  if (/from dim_sku_profile\s+where on_hand > 0/.test(t) && /last_sold_at is null or last_sold_at </.test(t)) {
    return { rows: [
      { sku: 'X-1', product_title: 'Dusty Bottle', vendor: 'V', on_hand: 18, units_sold: 0, last_sold_at: null },
    ] };
  }
  // low_stock_high_velocity
  if (/units_sold_30d >= \$2/.test(t)) {
    return { rows: [
      { sku: 'Z-1', product_title: 'Hot Pinot', vendor: 'V', on_hand: 4, units_sold_30d: 12, units_sold_90d: 30 },
    ] };
  }
  // runout_risk
  if (/days_of_cover/.test(t)) {
    return { rows: [
      { sku: 'R-1', product_title: 'Almost Out', vendor: 'V', on_hand: 3, units_sold_30d: 24, days_of_cover: 3.75 },
    ] };
  }

  // sales_summary
  if (/sum\(net_revenue\)::numeric\(14,2\)\s+as net_revenue/.test(t)) {
    return { rows: [{ orders: 20, units: 150, net_revenue: 7500, gross_revenue: 8000, discounts: 500 }] };
  }

  // period_over_period
  if (/union all\s+select 'previous'/.test(t)) {
    return { rows: [
      { bucket: 'current',  revenue: 7500, units: 150, orders: 20 },
      { bucket: 'previous', revenue: 6000, units: 130, orders: 18 },
    ] };
  }

  // customers_who_bought (fact_sales group by customer)
  if (/group by fs.customer_id/.test(t)) {
    return { rows: [
      { customer_id: 10, email: 'john@example.com', customer_name: 'John Smith', units: 6, spend: 240 },
    ] };
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

  header('live: top items sold yesterday');
  const r1 = await ask('What were the top items sold yesterday?');
  check('returns 200', () => assert.strictEqual(r1.status, 200));
  check('intent=top_items_by_units', () => assert.strictEqual(r1.body.intent, 'top_items_by_units'));
  check('timeframe.label=yesterday', () => assert.strictEqual(r1.body.meta.timeframe.label, 'yesterday'));
  check('answer mentions units', () => assert.ok(/units/i.test(r1.body.answer)));

  header('live: top items sold last week');
  const r2 = await ask('top items sold last week');
  check('intent=top_items_by_units', () => assert.strictEqual(r2.body.intent, 'top_items_by_units'));
  check('timeframe.label=last week', () => assert.strictEqual(r2.body.meta.timeframe.label, 'last week'));

  header('live: top items by revenue last month');
  const r3 = await ask('top items by revenue last month');
  check('intent=top_items_by_revenue', () => assert.strictEqual(r3.body.intent, 'top_items_by_revenue'));
  check('timeframe.label=last month', () => assert.strictEqual(r3.body.meta.timeframe.label, 'last month'));

  header('live: customer spend all time');
  const r4 = await ask('How much has John Smith spent all time?');
  check('intent=customer_spend', () => assert.strictEqual(r4.body.intent, 'customer_spend'));
  check('resolved customer name', () => assert.strictEqual(r4.body.meta.resolved.customer.customer_name, 'John Smith'));
  check('timeframe=all_time', () => assert.strictEqual(r4.body.meta.timeframe.mode, 'all_time'));
  check('answer mentions $5,000', () => assert.ok(/\$5,000/.test(r4.body.answer)));

  header('live: customer spend last week');
  const r5 = await ask('How much did John Smith spend last week?');
  check('intent=customer_spend', () => assert.strictEqual(r5.body.intent, 'customer_spend'));
  check('timeframe.label=last week', () => assert.strictEqual(r5.body.meta.timeframe.label, 'last week'));
  check('answer mentions $410', () => assert.ok(/\$410/.test(r5.body.answer)));

  header('live: customer spend last 30 days');
  const r6 = await ask('What has John Smith spent in the last 30 days?');
  check('intent=customer_spend', () => assert.strictEqual(r6.body.intent, 'customer_spend'));
  check('timeframe.days=30', () => assert.strictEqual(r6.body.meta.timeframe.days, 30));

  header('live: customer recent purchases');
  const r7 = await ask('What did Terry White buy in the last 30 days?');
  check('intent=customer_recent_purchases', () => assert.strictEqual(r7.body.intent, 'customer_recent_purchases'));
  check('data has rows', () => assert.ok(r7.body.data.length >= 1));
  check('answer mentions Sample Chardonnay', () => assert.ok(/Sample Chardonnay/.test(r7.body.answer)));

  header('live: customer profile by name (resolved single match)');
  const r8 = await ask('Profile of John Smith');
  check('intent=customer_profile', () => assert.strictEqual(r8.body.intent, 'customer_profile'));
  check('status=ok', () => assert.strictEqual(r8.body.meta.status, 'ok'));

  header('live: ambiguous customer name');
  const r9 = await ask('How much did Jane Doe spend last month?');
  check('status=disambiguation', () => assert.strictEqual(r9.body.meta.status, 'disambiguation'));
  check('answer lists candidates', () => assert.ok(/jane1@example\.com/.test(r9.body.answer) && /jane2@example\.com/.test(r9.body.answer)));
  check('data is candidate list', () => assert.ok(r9.body.data.length === 2));

  header('live: unknown customer name');
  const r10 = await ask('How much did Zorba Lebowski spend last week?');
  check('status=not_found', () => assert.strictEqual(r10.body.meta.status, 'not_found'));
  check('answer suggests fuller match', () => assert.ok(/no customer found/i.test(r10.body.answer)));

  header('live: top customers by varietal');
  const r11 = await ask('Who bought the most Chardonnay this quarter?');
  check('intent=top_customers_by_varietal', () => assert.strictEqual(r11.body.intent, 'top_customers_by_varietal'));
  check('answer mentions John Smith', () => assert.ok(/John Smith/.test(r11.body.answer)));

  header('live: customers who bought chardonnay last 90 days');
  const r12 = await ask('customers who bought chardonnay last 90 days');
  check('intent=customers_who_bought', () => assert.strictEqual(r12.body.intent, 'customers_who_bought'));
  check('timeframe.days=90', () => assert.strictEqual(r12.body.meta.timeframe.days, 90));

  header('live: basket pairs');
  const r13 = await ask('what sells together');
  check('intent=basket_pairs', () => assert.strictEqual(r13.body.intent, 'basket_pairs'));
  check('domain=orders', () => assert.strictEqual(r13.body.domain, 'orders'));

  header('live: low stock high velocity');
  const r14 = await ask('Which items sold well but are now low stock?');
  check('intent=low_stock_high_velocity', () => assert.strictEqual(r14.body.intent, 'low_stock_high_velocity'));
  check('answer mentions Hot Pinot', () => assert.ok(/Hot Pinot/.test(r14.body.answer)));

  header('live: dead inventory 90 days');
  const r15 = await ask('What products have not sold in 90 days?');
  check('intent=dead_inventory', () => assert.strictEqual(r15.body.intent, 'dead_inventory'));

  header('live: runout risk');
  const r16 = await ask('runout risk');
  check('intent=runout_risk', () => assert.strictEqual(r16.body.intent, 'runout_risk'));
  check('answer mentions Almost Out', () => assert.ok(/Almost Out/.test(r16.body.answer)));

  header('live: top vendors this quarter');
  const r17 = await ask('top vendors this quarter');
  check('intent=top_vendors', () => assert.strictEqual(r17.body.intent, 'top_vendors'));
  check('timeframe.label=this quarter', () => assert.strictEqual(r17.body.meta.timeframe.label, 'this quarter'));

  header('live: vendor growth');
  const r18 = await ask('What vendors are growing fastest?');
  check('intent=vendor_growth', () => assert.strictEqual(r18.body.intent, 'vendor_growth'));
  check('answer mentions Acme +66.7%', () => assert.ok(/Acme/.test(r18.body.answer) && /66\.7%/.test(r18.body.answer)));

  header('live: period over period');
  const r19 = await ask('compared to last month, how did we do?');
  check('intent=period_over_period', () => assert.strictEqual(r19.body.intent, 'period_over_period'));
  check('answer mentions Current and Previous', () => assert.ok(/Current/.test(r19.body.answer) && /Previous/.test(r19.body.answer)));

  header('live: existing low_stock still works');
  const r20 = await ask('what is low stock');
  check('intent=low_stock', () => assert.strictEqual(r20.body.intent, 'low_stock'));

  header('live: existing top_customers_by_spend still works');
  const r21 = await ask('top customers by spend');
  check('intent=top_customers_by_spend', () => assert.strictEqual(r21.body.intent, 'top_customers_by_spend'));

  header('live: auth still enforced');
  const noAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('no auth -> 401', () => assert.strictEqual(noAuth.status, 401));

  header('live: /recommend still public + unchanged');
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('/recommend 200 with recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });

  console.log('');
  if (failures) {
    console.error(`manager-qa smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`manager-qa smoke: ALL OK (${queryLog.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('manager-qa smoke crashed:', e);
  process.exit(1);
});
