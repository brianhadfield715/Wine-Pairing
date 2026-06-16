#!/usr/bin/env node
// scripts/smoke_orders_sync.js
// Live HTTP test of POST /admin/sync/orders with mocked Shopify and Postgres,
// covering:
//   1. days=1 success path with multi-page Shopify pagination
//   2. JSON success-shape contract (ok, endpoint, days, chunks_processed,
//      pages_fetched, orders_written, line_items_written, elapsed_ms)
//   3. malformed order payloads are skipped, not fatal
//   4. failure path returns JSON with { ok:false, stage, error, elapsed_ms }
//   5. {days:1, limit:10} debug knob is honored
//   6. existing protections still hold (no auth -> 401)
//
// No Shopify or Postgres is contacted. node-fetch is monkey-patched before
// server.js is required so the Shopify client uses the fake.

const assert = require('assert');
const http = require('http');

// ---------------------------------------------------------------------------
// 1) Patch node-fetch BEFORE anything requires it
// ---------------------------------------------------------------------------

// fakeShopify provides successive pages by URL. Tests reassign this between
// requests as needed.
let fakeShopify = {
  pages: [],   // [{ orders: [...], nextUrl: 'https://.../page2' | null }, ...]
  callLog: [],
  forceError: null, // e.g. { onPage: 2, status: 500 } or { onPage: 1, networkError: 'ECONNRESET' }
};

const fakeFetch = async (url, init = {}) => {
  fakeShopify.callLog.push({ url, init });
  const fe = fakeShopify.forceError;
  if (fe) {
    if (fe.networkError) {
      throw new Error(fe.networkError);
    }
    // Return the same HTTP error every call so the Shopify client retry
    // loop exhausts and the orders sync sees a 5xx.
    return makeRes(fe.status || 500, JSON.stringify({ error: 'forced' }), {});
  }
  // Count only successful page reads against the page index so retries
  // don't desync the test. (No retries happen in success paths.)
  const idx = fakeShopify._pageIdx || 0;
  fakeShopify._pageIdx = idx + 1;
  const page = fakeShopify.pages[idx] || { orders: [] };
  const headers = {};
  if (page.nextUrl) {
    headers.link = `<${page.nextUrl}>; rel="next"`;
  }
  return makeRes(200, JSON.stringify({ orders: page.orders }), headers);
};

function makeRes(status, bodyText, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] || null,
    },
    async text() { return bodyText; },
    async json() { return JSON.parse(bodyText); },
  };
}

// Install fake into the module cache so any later require('node-fetch') gets
// our function. Pre-populating require.cache before server.js / shopify
// client are required is sufficient; no resolver patch needed.
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: fakeFetch,
};

// ---------------------------------------------------------------------------
// 2) Patch the project's db module so writePage() runs without Postgres
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.PGSSL = 'disable';
process.env.PORT = process.env.SMOKE_PORT || '34602';
process.env.QA_USER = 'smoke';
process.env.QA_PASS = 'smoke';
process.env.SHOP_DOMAIN  = 'example.myshopify.com';
process.env.SHOPIFY_TOKEN = 'placeholder';
process.env.SHOPIFY_HTTP_TIMEOUT_MS = '5000';
process.env.SHOPIFY_HTTP_MAX_ATTEMPTS = '1'; // smoke: don't retry, fail fast

const db = require('../src/db');

const dbLog = { transactions: 0, orderUpserts: 0, lineUpserts: 0 };
let dbFail = null; // { afterRows: N } to trigger a failure mid-write

db.isEnabled = () => true;
db.query = async () => { throw new Error('direct db.query not expected in orders sync'); };
db.withClient = async (fn) => {
  const fake = {
    async query(text /*, params */) {
      const t = String(text || '').trim().toLowerCase();
      if (t.startsWith('begin')) { dbLog.transactions += 1; return { rows: [] }; }
      if (t.startsWith('commit') || t.startsWith('rollback')) return { rows: [] };
      if (t.includes('insert into orders')) {
        dbLog.orderUpserts += 1;
        if (dbFail && dbLog.orderUpserts > dbFail.afterRows) {
          throw new Error('simulated DB write failure');
        }
        return { rows: [] };
      }
      if (t.includes('insert into order_line_items')) {
        dbLog.lineUpserts += 1;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return fn(fake);
};

// ---------------------------------------------------------------------------
// 3) Bring up server
// ---------------------------------------------------------------------------
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

const auth = 'Basic ' + Buffer.from('smoke:smoke').toString('base64');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures += 1; console.log('  FAIL ' + label + ' — ' + e.message); }
}

function resetState() {
  fakeShopify.pages = [];
  fakeShopify.callLog = [];
  fakeShopify.forceError = null;
  fakeShopify._pageIdx = 0;
  dbLog.transactions = 0;
  dbLog.orderUpserts = 0;
  dbLog.lineUpserts = 0;
  dbFail = null;
}

function makeOrder(id, opts = {}) {
  return {
    id,
    name: `#${1000 + id}`,
    customer: opts.customer === null ? null : { id: 9000 + id },
    email: opts.email || `c${id}@example.com`,
    financial_status: 'paid',
    fulfillment_status: null,
    currency: 'USD',
    subtotal_price: '50.00',
    total_discounts: '0.00',
    total_tax: '4.00',
    total_price: '54.00',
    total_line_items_price: '50.00',
    processed_at: '2026-06-15T18:00:00Z',
    created_at: '2026-06-15T18:00:00Z',
    updated_at: '2026-06-15T18:00:00Z',
    cancelled_at: opts.cancelled ? '2026-06-15T19:00:00Z' : null,
    closed_at: null,
    source_name: 'web',
    tags: '',
    line_items: opts.line_items !== undefined ? opts.line_items : [
      { id: 70000 + id * 2,     product_id: 6000 + id, variant_id: 7000 + id, sku: `SKU-${id}-A`, title: `Wine A ${id}`, variant_title: '750ml', vendor: 'V', quantity: 1, price: '25.00', total_discount: '0' },
      { id: 70000 + id * 2 + 1, product_id: 6100 + id, variant_id: 7100 + id, sku: `SKU-${id}-B`, title: `Wine B ${id}`, variant_title: '750ml', vendor: 'V', quantity: 1, price: '25.00', total_discount: '0' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4) Tests
// ---------------------------------------------------------------------------

(async () => {
  await new Promise((r) => setTimeout(r, 250));

  // --- T1: success with pagination
  console.log('=== T1: days=1 success with 3-page Shopify pagination ===');
  resetState();
  fakeShopify.pages = [
    { orders: [ makeOrder(1), makeOrder(2) ],  nextUrl: 'https://example.myshopify.com/admin/api/2024-10/orders.json?page_info=p2' },
    { orders: [ makeOrder(3), makeOrder(4) ],  nextUrl: 'https://example.myshopify.com/admin/api/2024-10/orders.json?page_info=p3' },
    { orders: [ makeOrder(5) ],                nextUrl: null },
  ];
  const r1 = await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1 } });
  check('T1 returns 200', () => assert.strictEqual(r1.status, 200));
  check('T1 ok=true', () => assert.strictEqual(r1.body.ok, true));
  check('T1 endpoint=orders', () => assert.strictEqual(r1.body.endpoint, 'orders'));
  check('T1 days echoed', () => assert.strictEqual(r1.body.days, 1));
  check('T1 pages_fetched=3', () => assert.strictEqual(r1.body.pages_fetched, 3));
  check('T1 chunks_processed=3', () => assert.strictEqual(r1.body.chunks_processed, 3));
  check('T1 orders_written=5', () => assert.strictEqual(r1.body.orders_written, 5));
  check('T1 line_items_written=10', () => assert.strictEqual(r1.body.line_items_written, 10));
  check('T1 elapsed_ms is a number >= 0', () => assert.ok(typeof r1.body.elapsed_ms === 'number' && r1.body.elapsed_ms >= 0));
  check('T1 db transactions == pages (per-page batching)', () => assert.strictEqual(dbLog.transactions, 3));
  check('T1 first Shopify URL includes updated_at_min', () => assert.ok(/updated_at_min=/.test(fakeShopify.callLog[0].url)));
  check('T1 no infinite loop (calls == pages)', () => assert.strictEqual(fakeShopify.callLog.length, 3));

  // --- T2: malformed payloads tolerated
  console.log('\n=== T2: malformed orders + line items are skipped, not fatal ===');
  resetState();
  fakeShopify.pages = [
    {
      orders: [
        makeOrder(10),
        { /* no id at all */ name: '#bogus', line_items: [{ id: 1 }] },
        makeOrder(11, { customer: null, line_items: null }),
        makeOrder(12, { cancelled: true, line_items: [ { /* missing id */ product_id: 1, title: 'X', price: '1' } ] }),
      ],
      nextUrl: null,
    },
  ];
  const r2 = await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1 } });
  check('T2 200 + ok', () => { assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.ok, true); });
  check('T2 wrote 3 orders, skipped 1', () => {
    assert.strictEqual(r2.body.orders_written, 3);
    assert.strictEqual(r2.body.orders_skipped, 1);
  });
  check('T2 line_items_skipped >= 1 (malformed line)', () => assert.ok(r2.body.lines_skipped >= 1));
  check('T2 line_items_written = 2 (only order #10 had valid lines)', () => assert.strictEqual(r2.body.line_items_written, 2));
  check('T2 cancelled_seen = 1', () => assert.strictEqual(r2.body.cancelled_seen, 1));

  // --- T3: fetch failure -> JSON error with stage='fetch'
  console.log('\n=== T3: Shopify network/HTTP failure -> JSON error with stage=fetch ===');
  resetState();
  fakeShopify.pages = [];
  fakeShopify.forceError = { onPage: 1, status: 500 };
  const r3 = await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1 } });
  check('T3 status=500', () => assert.strictEqual(r3.status, 500));
  check('T3 ok=false', () => assert.strictEqual(r3.body.ok, false));
  check('T3 stage=fetch', () => assert.strictEqual(r3.body.stage, 'fetch'));
  check('T3 error message present', () => assert.ok(typeof r3.body.error === 'string' && r3.body.error.length > 0));
  check('T3 endpoint=orders, days echoed, elapsed_ms present', () => {
    assert.strictEqual(r3.body.endpoint, 'orders');
    assert.strictEqual(r3.body.days, 1);
    assert.ok(typeof r3.body.elapsed_ms === 'number');
  });

  // --- T4: db_write failure mid-page -> JSON error with stage='db_write'
  console.log('\n=== T4: DB failure mid-write -> JSON error with stage=db_write ===');
  resetState();
  fakeShopify.pages = [{ orders: [ makeOrder(20), makeOrder(21), makeOrder(22) ], nextUrl: null }];
  dbFail = { afterRows: 1 };
  const r4 = await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1 } });
  check('T4 status=500', () => assert.strictEqual(r4.status, 500));
  check('T4 ok=false', () => assert.strictEqual(r4.body.ok, false));
  check('T4 stage=db_write', () => assert.strictEqual(r4.body.stage, 'db_write'));
  check('T4 error message present', () => assert.ok(/simulated/i.test(r4.body.error)));

  // --- T5: debug limit honored ({days:1, limit:10})
  console.log('\n=== T5: {days:1, limit:10} debug knob -> per_page limit reflected in URL ===');
  resetState();
  fakeShopify.pages = [{ orders: [ makeOrder(30) ], nextUrl: null }];
  await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1, limit: 10 } });
  check('T5 Shopify URL contains limit=10', () => assert.ok(/limit=10/.test(fakeShopify.callLog[0].url)));

  // --- T6: maxPages cap prevents infinite loops
  console.log('\n=== T6: maxPages cap prevents infinite-cursor loops ===');
  resetState();
  // Build 5 pages that always claim a next cursor — without the cap this
  // would loop forever.
  for (let i = 0; i < 50; i++) {
    fakeShopify.pages.push({ orders: [ makeOrder(100 + i) ], nextUrl: `https://example.myshopify.com/admin/api/2024-10/orders.json?page_info=p${i+1}` });
  }
  const r6 = await request('/admin/sync/orders', { method: 'POST', headers: { Authorization: auth }, body: { days: 1, maxPages: 3 } });
  check('T6 status=200 ok=true', () => { assert.strictEqual(r6.status, 200); assert.strictEqual(r6.body.ok, true); });
  check('T6 pages_fetched bounded by maxPages=3', () => assert.strictEqual(r6.body.pages_fetched, 3));

  // --- T7: auth still enforced
  console.log('\n=== T7: existing protection holds ===');
  const r7 = await request('/admin/sync/orders', { method: 'POST', body: { days: 1 } });
  check('T7 no-auth -> 401', () => assert.strictEqual(r7.status, 401));

  // --- T8: /recommend untouched
  console.log('\n=== T8: /recommend still public + unchanged shape ===');
  const r8 = await request('/recommend', { method: 'POST', body: { dish: '' } });
  check('T8 /recommend 200 with recommendations key', () => {
    assert.strictEqual(r8.status, 200);
    assert.ok('recommendations' in r8.body);
  });

  console.log('');
  if (failures) {
    console.error(`orders smoke: ${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log('orders smoke: ALL OK');
    process.exit(0);
  }
})().catch((e) => {
  console.error('orders smoke crashed:', e);
  process.exit(1);
});
