#!/usr/bin/env node
// scripts/smoke.js
// Local smoke checks that DO NOT require a live Shopify or Postgres.
//
// 1) intentParser classifies a battery of manager questions to expected intents
// 2) every intent in the registry produces valid parameterized SQL
//    (text + values array with matching $N placeholders)
// 3) the basic auth middleware rejects unauthenticated requests against
//    /shopify-qa and /admin/sync/*, while /recommend remains public
//
// Exits 0 on success, 1 on any failure.

const assert = require('assert');
const http = require('http');

function header(t) {
  console.log('\n=== ' + t + ' ===');
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('  ok  ' + label);
  } catch (e) {
    failures += 1;
    console.log('  FAIL ' + label + ' — ' + e.message);
  }
}

// 1) Intent classification ---------------------------------------------------
header('intent classification');
const { parse } = require('../src/analytics/intentParser');

// Uses the real parser (entity-aware), not the raw classifyIntent fn.
const cases = [
  ['who spends the most', 'top_customers_by_spend'],
  ['best customers last year', 'top_customers_by_spend'],
  ['top 5 customers by spend', 'top_customers_by_spend'],
  ['profile of customer jane@example.com', 'customer_profile'],
  ['Profile of John Smith', 'customer_profile'],
  ['customers who bought chardonnay', 'customers_who_bought'],
  ['how many customers', 'customer_count'],
  ['new customers last 30 days', 'new_customers'],
  ['lapsed customers', 'lapsed_customers'],
  ['what sells together', 'basket_pairs'],
  ['What products are most commonly sold together?', 'basket_pairs'],
  ['commonly bought together', 'basket_pairs'],
  ['products purchased together', 'basket_pairs'],
  ['basket pairs', 'basket_pairs'],
  ['market basket', 'basket_pairs'],
  ['which SKUs are usually bought together', 'basket_pairs'],
  ['dead inventory', 'dead_inventory'],
  ['low stock high velocity', 'low_stock_high_velocity'],
  ['what is low stock', 'low_stock'],
  ['out of stock', 'out_of_stock'],
  ['in stock red wine under $30', 'in_stock_filtered'],
  // top_skus was renamed to top_items_by_units (registry still serves the
  // old alias so existing callers keep working).
  ['top selling wines last 30 days', 'top_items_by_units'],
  ['units sold per sku', 'units_sold_per_sku'],
  ['top vendors this quarter', 'top_vendors'],
  ['recent orders', 'recent_orders'],
  // revenue_summary was renamed to sales_summary (alias still registered).
  ['revenue last month', 'sales_summary'],
  ['hello there', 'general_help'],
];
for (const [q, expected] of cases) {
  check(`"${q}" -> ${expected}`, () => {
    const got = parse(q).intent;
    assert.strictEqual(got, expected, `got ${got}`);
  });
}

// 2) Builders produce safe parameterized SQL --------------------------------
header('sql builders produce valid parameterized SQL');
const registry = require('../src/analytics/queryRegistry');

function maxPlaceholder(text) {
  let max = 0;
  const re = /\$(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

const nowIso = new Date().toISOString();
const sinceIso = new Date(Date.now() - 30 * 86400e3).toISOString();
const sampleParams = {
  limit: 5,
  days: 30,
  timeframe: { mode: 'window', sinceIso, untilIso: nowIso, label: 'last 30 days', days: 30 },
  color: 'red',
  vendor: 'Acme',
  sku: 'HWM-001',
  varietal: 'chardonnay',
  money: { op: '<', value: 30 },
  rawQuestion: 'profile of jane@example.com',
  resolved: { customer: { customer_id: 1, customer_name: 'Test User', email: 't@x.com' }, product: { product_id: 1, product_title: 'X' } },
};

for (const name of Object.keys(registry.registry)) {
  check(`builder ${name} compiles`, () => {
    const { text, values, meta } = registry.registry[name].builder(sampleParams);
    assert.ok(typeof text === 'string' && text.length > 10, 'text empty');
    assert.ok(Array.isArray(values), 'values not array');
    const m = maxPlaceholder(text);
    assert.strictEqual(m, values.length, `placeholder count $${m} != values.length ${values.length}`);
    assert.ok(meta && meta.domain, 'meta.domain missing');
    // No raw user values should be string-interpolated into text; we check the
    // text never contains the sample sku verbatim.
    assert.ok(!text.includes('HWM-001'), 'sku appears inline in SQL — must be parameterized');
  });
}

// 3) Live server smoke (no Shopify / no DB calls hit) -----------------------
header('server route protection');

// Ensure DB is treated as disabled for this smoke run.
delete process.env.DATABASE_URL;
process.env.PORT = process.env.SMOKE_PORT || '34567';
process.env.QA_USER = process.env.QA_USER || 'smoke';
process.env.QA_PASS = process.env.QA_PASS || 'smoke';
process.env.SHOP_DOMAIN  = process.env.SHOP_DOMAIN  || 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || 'placeholder';

// Require server AFTER setting env so dotenv inside it doesn't override.
require('../server.js');

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port: Number(process.env.PORT), path, method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // small wait to let listen() bind
  await new Promise((r) => setTimeout(r, 250));

  const health = await request('/health');
  check('GET /health -> 200', () => assert.strictEqual(health.status, 200));

  const qaNoAuth = await request('/shopify-qa', { method: 'POST', body: { question: 'top customers' } });
  check('POST /shopify-qa without auth -> 401', () => assert.strictEqual(qaNoAuth.status, 401));

  const syncNoAuth = await request('/admin/sync/products', { method: 'POST' });
  check('POST /admin/sync/products without auth -> 401', () => assert.strictEqual(syncNoAuth.status, 401));

  const badAuth = Buffer.from('nope:nope').toString('base64');
  const qaBad = await request('/shopify-qa', { method: 'POST', headers: { Authorization: 'Basic ' + badAuth }, body: { question: 'top customers' } });
  check('POST /shopify-qa with WRONG auth -> 401', () => assert.strictEqual(qaBad.status, 401));

  // /recommend should be reachable without auth (returns the empty-dish path
  // without ever calling Shopify, so no real token needed).
  const rec = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('POST /recommend (no auth) -> 200', () => assert.strictEqual(rec.status, 200));
  check('POST /recommend returns recommendations key', () => {
    const j = JSON.parse(rec.body);
    assert.ok('recommendations' in j, 'missing recommendations key');
  });

  console.log('');
  if (failures) {
    console.error(`smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log('smoke: ALL OK');
    process.exit(0);
  }
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
