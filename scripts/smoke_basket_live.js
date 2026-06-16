#!/usr/bin/env node
// scripts/smoke_basket_live.js
// Live HTTP test of the four required basket-pair questions against the
// running server. Stubs the pg query so the DB-engine code path executes
// end-to-end without needing a real Postgres connection. Confirms the
// response carries intent=basket_pairs, domain=orders, engine=db, and that
// the existing analytics intents (low_stock, top_customers_by_spend) still
// route correctly. Also re-verifies /recommend is public and unchanged.

const assert = require('assert');
const http = require('http');

// --- 1. Fake DATABASE_URL so db.isEnabled() returns true ------------------
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34601';
process.env.QA_USER = 'smoke';
process.env.QA_PASS = 'smoke';
process.env.SHOP_DOMAIN  = 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = 'placeholder';

// --- 2. Stub the db module's query() so no real connection is needed -----
// We intercept by replacing the function on the db module BEFORE server.js
// requires the analytics engine. Because Node caches modules, the same
// instance will be used by src/analytics/engine.js.
const db = require('../src/db');

// Record the calls so we can assert on the SQL routed per question.
const queryCalls = [];
db.query = async function fakeQuery(text, values) {
  queryCalls.push({ text, values });

  // Detect basket-pairs SQL by a couple of unique tokens.
  if (/order_line_items[\s\S]*order_line_items/.test(text) && /times_bought_together/.test(text)) {
    return {
      rows: [
        { product_a: 'Sancerre Domaine X', product_b: 'Loire Rosé Y',     times_bought_together: 12 },
        { product_a: 'Côtes du Rhône Z',   product_b: 'Saint-Joseph A',   times_bought_together:  9 },
        { product_a: 'Champagne B',        product_b: 'Brut Reserve C',   times_bought_together:  7 },
      ],
    };
  }

  // Low-stock SQL ships through vw_current_inventory.
  if (/vw_current_inventory/.test(text)) {
    return {
      rows: [
        { product_title: 'Tiny Pinot',     vendor: 'Foo', sku: 'SKU-1', variant_title: '750ml', price: 29.99, on_hand: 2 },
        { product_title: 'Last Three Reds', vendor: 'Bar', sku: 'SKU-2', variant_title: '750ml', price: 34.50, on_hand: 3 },
      ],
    };
  }

  // Top customers by spend ships through dim_customer_profile.
  if (/dim_customer_profile/.test(text)) {
    return {
      rows: [
        { customer_id: 1, email: 'a@x.com', customer_name: 'Anne Adams',   total_spend: 8421.10, order_count: 41, first_order_at: null, last_order_at: null, favorite_vendor: 'V', favorite_product_type: 'Red' },
        { customer_id: 2, email: 'b@x.com', customer_name: 'Brian Brooks', total_spend: 6210.55, order_count: 33, first_order_at: null, last_order_at: null, favorite_vendor: 'V', favorite_product_type: 'White' },
      ],
    };
  }

  // Default: empty rows for any other intent.
  return { rows: [] };
};
db.isEnabled = () => true;

// Now bring up the server.
require('../server.js');

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(process.env.PORT),
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); } catch { parsed = { _raw: buf }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const authHeader = 'Basic ' + Buffer.from('smoke:smoke').toString('base64');

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

(async () => {
  await new Promise((r) => setTimeout(r, 250));

  console.log('=== live /shopify-qa: required basket questions ===');
  const required = [
    'what sells together',
    'What products are most commonly sold together?',
    'commonly bought together',
    'products purchased together',
  ];
  for (const q of required) {
    const r = await request('/shopify-qa', {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: { question: q },
    });
    check(`POST /shopify-qa "${q}" -> 200 + intent=basket_pairs + domain=orders + engine=db`, () => {
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      assert.strictEqual(r.body.intent, 'basket_pairs', `intent=${r.body.intent}`);
      assert.strictEqual(r.body.domain, 'orders', `domain=${r.body.domain}`);
      assert.strictEqual(r.body.engine, 'db', `engine=${r.body.engine}`);
      assert.ok(Array.isArray(r.body.data) && r.body.data.length === 3, `data len=${r.body.data && r.body.data.length}`);
      assert.ok(/Sancerre Domaine X \+ Loire Rosé Y — 12 orders/.test(r.body.answer), 'formatter output missing line 1');
    });
  }

  console.log('\n=== live /shopify-qa: existing intents still work ===');
  const lowStock = await request('/shopify-qa', {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: { question: 'what is low stock' },
  });
  check('low stock -> intent=low_stock + domain=inventory + engine=db', () => {
    assert.strictEqual(lowStock.status, 200);
    assert.strictEqual(lowStock.body.intent, 'low_stock');
    assert.strictEqual(lowStock.body.domain, 'inventory');
    assert.strictEqual(lowStock.body.engine, 'db');
    assert.strictEqual(lowStock.body.data.length, 2);
  });

  const top = await request('/shopify-qa', {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: { question: 'top customers by spend' },
  });
  check('top customers -> intent=top_customers_by_spend + domain=customers + engine=db', () => {
    assert.strictEqual(top.status, 200);
    assert.strictEqual(top.body.intent, 'top_customers_by_spend');
    assert.strictEqual(top.body.domain, 'customers');
    assert.strictEqual(top.body.engine, 'db');
    assert.strictEqual(top.body.data.length, 2);
  });

  console.log('\n=== /recommend remains public and unchanged ===');
  const rec = await request('/recommend', {
    method: 'POST',
    body: { dish: '' },
  });
  check('POST /recommend (no auth) -> 200 with recommendations key', () => {
    assert.strictEqual(rec.status, 200);
    assert.ok('recommendations' in rec.body);
  });

  console.log('\n=== auth still enforced ===');
  const noAuth = await request('/shopify-qa', {
    method: 'POST',
    body: { question: 'what sells together' },
  });
  check('POST /shopify-qa without auth -> 401', () => {
    assert.strictEqual(noAuth.status, 401);
  });

  console.log('');
  if (failures) {
    console.error(`basket smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log(`basket smoke: ALL OK (${queryCalls.length} stubbed query call(s))`);
    process.exit(0);
  }
})().catch((e) => {
  console.error('basket smoke crashed:', e);
  process.exit(1);
});
