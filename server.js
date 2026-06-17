require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const db = require('./src/db');
const analyticsEngine = require('./src/analytics/engine');
const syncProductsMod  = require('./src/sync/products');
const syncLocationsMod = require('./src/sync/locations');
const syncInventoryMod = require('./src/sync/inventory');
const syncCustomersMod = require('./src/sync/customers');
const syncOrdersMod    = require('./src/sync/orders');
const backfillMod      = require('./src/sync/backfill');

const app = express();
app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API = `https://${SHOP}/admin/api/2024-10`;

// ---------------------------------------------------------------------------
// /recommend  (PUBLIC — DO NOT CHANGE BEHAVIOR)
// ---------------------------------------------------------------------------
// The wine-pairing recommender is the storefront-facing tool. It is kept
// intentionally identical to the pre-refactor behavior to guarantee zero
// regression. All helpers below are scoped to this route only.

async function fetchAllWines() {
  const out = [];
  let url = `${API}/products.json?limit=250&status=active`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    const data = await res.json();
    if (!data.products) break;
    out.push(...data.products);
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out.filter(p => {
    const type = (p.product_type || '').toLowerCase();
    const tags = (p.tags || '').toLowerCase();
    return /wine|champagne|sparkling|rose|rosé/.test(type) || /wine|champagne|sparkling|rose|rosé/.test(tags);
  });
}

function classifyDish(dish) {
  const d = dish.toLowerCase();
  const profile = { protein: 'unknown', sauce: 'none', herbs: false, spicy: false };
  if (d.match(/chicken|turkey|poultry|duck/)) profile.protein = 'poultry';
  else if (d.match(/beef|steak|lamb|venison/)) profile.protein = 'red_meat';
  else if (d.match(/fish|salmon|tuna|shrimp|seafood|oyster|scallop|lobster|crab/)) profile.protein = 'seafood';
  else if (d.match(/pork|ham|bacon/)) profile.protein = 'pork';
  else if (d.match(/pasta|pizza|risotto/)) profile.protein = 'pasta';
  else if (d.match(/cheese|charcuterie/)) profile.protein = 'cheese';
  if (d.match(/lemon|citrus|lime/)) profile.sauce = 'citrus';
  else if (d.match(/cream|butter|gravy|alfredo/)) profile.sauce = 'creamy';
  else if (d.match(/mushroom|truffle/)) profile.sauce = 'earthy';
  else if (d.match(/tomato|marinara|red sauce/)) profile.sauce = 'tomato';
  else if (d.match(/bbq|barbecue|smoked/)) profile.sauce = 'bbq';
  if (d.match(/thyme|rosemary|sage|herb|basil|oregano/)) profile.herbs = true;
  if (d.match(/spicy|chili|cajun|hot|pepper|curry/)) profile.spicy = true;
  return profile;
}

function wineCategory(product) {
  const type = (product.product_type || '').toLowerCase();
  const tags = (product.tags || '').toLowerCase();
  const title = (product.title || '').toLowerCase();
  const all = `${type} ${tags} ${title}`;
  if (/sparkling|champagne|prosecco|cava|brut/.test(all)) return 'sparkling';
  if (/rose|rosé/.test(all)) return 'rose';
  if (/orange/.test(type)) return 'orange';
  if (/white/.test(type)) return 'white';
  if (/red/.test(type)) return 'red';
  return 'unknown';
}

function scoreWine(product, profile, prefs) {
  const text = `${product.title} ${product.body_html || ''} ${product.tags || ''} ${product.product_type || ''}`.toLowerCase();
  const cat = wineCategory(product);
  let score = 1;

  if (prefs.color && prefs.color !== 'any') {
    if (prefs.color !== cat) return -100;
  }

  if (profile.protein === 'poultry') {
    if (/chardonnay|pinot noir|gamay|beaujolais|grenache|viognier|gruner|chenin/.test(text)) score += 25;
    if (cat === 'white') score += 10;
    if (cat === 'rose') score += 8;
    if (profile.sauce === 'citrus' && (/sauvignon blanc|chardonnay|gruner|albarino|vermentino|chenin|riesling/.test(text) || cat === 'white')) score += 20;
    if (profile.sauce === 'creamy' && /chardonnay|viognier|white burgundy/.test(text)) score += 20;
    if (profile.sauce === 'earthy' && /pinot noir|gamay|beaujolais/.test(text)) score += 20;
  }
  if (profile.protein === 'red_meat') {
    if (/cabernet|malbec|syrah|shiraz|zinfandel|barolo|nebbiolo|bordeaux|tempranillo|ribera|rioja/.test(text)) score += 25;
    if (cat === 'red') score += 10;
  }
  if (profile.protein === 'seafood') {
    if (/sauvignon blanc|albarino|vermentino|pinot grigio|chablis|riesling|muscadet|sancerre/.test(text)) score += 25;
    if (cat === 'white' || cat === 'sparkling') score += 10;
  }
  if (profile.protein === 'pork') {
    if (/pinot noir|riesling|gamay|zinfandel|grenache|chenin/.test(text)) score += 20;
  }
  if (profile.protein === 'pasta') {
    if (/sangiovese|chianti|barbera|montepulciano|pinot noir|nero d'avola/.test(text)) score += 20;
    if (cat === 'red') score += 8;
  }
  if (profile.protein === 'cheese') {
    if (cat === 'sparkling' || cat === 'white' || cat === 'orange') score += 15;
  }
  if (profile.spicy && (/riesling|gewurztraminer|grenache/.test(text) || cat === 'rose')) score += 15;
  if (profile.herbs && /sauvignon blanc|gruner|grenache|viognier|chenin/.test(text)) score += 10;

  return score;
}

app.post('/recommend', async (req, res) => {
  try {
    const { dish = '', color = 'any', budget = null } = req.body || {};
    if (!dish.trim()) return res.json({ recommendations: [], message: 'Tell me what you are having for dinner.' });
    const wines = await fetchAllWines();
    const profile = classifyDish(dish);
    const prefs = { color: color.toLowerCase(), budget };
    const eligible = [];
    for (const p of wines) {
      for (const v of (p.variants || [])) {
        const qty = v.inventory_quantity || 0;
        if (qty <= 0) continue;
        const price = parseFloat(v.price);
        if (budget && price > parseFloat(budget)) continue;
        const s = scoreWine(p, profile, prefs);
        if (s <= 0) continue;
        eligible.push({
          sku: v.sku || `${p.id}-${v.id}`,
          title: p.title,
          price: v.price,
          score: s,
          url: `https://${SHOP}/products/${p.handle}`,
          category: wineCategory(p),
          inventory: qty
        });
        break;
      }
    }
    eligible.sort((a, b) => b.score - a.score);
    const top = eligible.slice(0, 3).map(w => ({
      sku: w.sku,
      title: w.title,
      price: w.price,
      url: w.url,
      category: w.category,
      reason: buildReason(profile, w.title, w.category)
    }));
    res.json({ profile, pool: wines.length, eligible: eligible.length, count: top.length, recommendations: top });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildReason(profile, title, cat) {
  const bits = [];
  if (profile.protein === 'poultry') bits.push('pairs well with chicken');
  if (profile.protein === 'red_meat') bits.push('matches the richness of red meat');
  if (profile.protein === 'seafood') bits.push('clean profile for seafood');
  if (profile.protein === 'pork') bits.push('works with pork');
  if (profile.protein === 'pasta') bits.push('classic pasta match');
  if (profile.sauce === 'citrus') bits.push('bright acidity for lemon/citrus');
  if (profile.sauce === 'creamy') bits.push('weight that holds up to creamy sauces');
  if (profile.sauce === 'earthy') bits.push('earthy notes for mushroom');
  if (profile.sauce === 'bbq') bits.push('fruit-forward for smoke and char');
  if (profile.spicy) bits.push('handles spice without overpowering');
  if (profile.herbs) bits.push('complements herbal seasoning');
  if (!bits.length) bits.push(`${cat} wine that fits the dish`);
  return `${title} — ${bits.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Shared auth: Basic Auth via QA_USER / QA_PASS.
// Reused for /shopify-qa AND /admin/sync/* to enforce the same protection.
// ---------------------------------------------------------------------------

function requireBasicAuth(req, res, next) {
  const auth = req.headers.authorization || '';

  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Shopify QA"');
    return res.status(401).send('Authentication required');
  }

  const encoded = auth.split(' ')[1];
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';

  if (
    user === process.env.QA_USER &&
    pass === process.env.QA_PASS
  ) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Shopify QA"');
  return res.status(401).send('Invalid credentials');
}

// ---------------------------------------------------------------------------
// Legacy in-memory /shopify-qa helpers — kept ONLY as a no-DB fallback so the
// route stays useful before the warehouse is provisioned. The DB-backed
// analytics engine is preferred whenever DATABASE_URL is set.
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function fetchAllProducts() {
  const out = [];
  let url = `${API}/products.json?limit=250&status=active`;
  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': TOKEN }
    });
    const data = await res.json();
    if (!data.products) break;
    out.push(...data.products);
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

async function fetchCustomers(limit = 250) {
  const res = await fetch(`${API}/customers.json?limit=${limit}`, {
    headers: { 'X-Shopify-Access-Token': TOKEN }
  });
  const data = await res.json();
  return data.customers || [];
}

async function fetchOrders(days = 30, limit = 250) {
  const createdAtMin = encodeURIComponent(daysAgoIso(days));
  const res = await fetch(
    `${API}/orders.json?status=any&limit=${limit}&created_at_min=${createdAtMin}`,
    {
      headers: { 'X-Shopify-Access-Token': TOKEN }
    }
  );
  const data = await res.json();
  return data.orders || [];
}

function getWineColor(product) {
  const text = `${product.product_type || ''} ${product.tags || ''} ${product.title || ''}`.toLowerCase();
  if (/sparkling|champagne|prosecco|cava|brut/.test(text)) return 'sparkling';
  if (/rose|rosé/.test(text)) return 'rose';
  if (/orange/.test(text)) return 'orange';
  if (/white|chardonnay|sauvignon blanc|riesling|chenin|viognier|pinot grigio|albarino|vermentino/.test(text)) return 'white';
  if (/red|pinot noir|cabernet|merlot|syrah|grenache|tempranillo|gamay|sangiovese|malbec|zinfandel/.test(text)) return 'red';
  return 'unknown';
}

function extractWineKeyword(question) {
  const q = question.toLowerCase();
  const patterns = [
    'chardonnay','pinot noir','cabernet','merlot','sauvignon blanc','riesling',
    'chenin','viognier','tempranillo','gamay','grenache','sparkling','rose',
    'rosé','orange wine','white wine','red wine'
  ];
  return patterns.find(p => q.includes(p)) || null;
}

function extractDays(question, fallback = 30) {
  const match = question.match(/last\s+(\d+)\s+day/);
  if (match) return parseInt(match[1], 10);
  if (/yesterday/.test(question)) return 1;
  if (/last week/.test(question)) return 7;
  if (/last month/.test(question)) return 30;
  return fallback;
}

function legacyInventoryAnswer(question, products) {
  const q = question.toLowerCase();
  if (/low stock/.test(q)) {
    const rows = [];
    products.forEach(p => (p.variants || []).forEach(v => {
      const qty = v.inventory_quantity || 0;
      if (qty > 0 && qty <= 6) rows.push({ title: p.title, sku: v.sku || '', qty, price: v.price });
    }));
    rows.sort((a, b) => a.qty - b.qty);
    return { answer: `Found ${rows.length} low-stock variants.`, data: rows.slice(0, 20) };
  }
  if (/out of stock/.test(q)) {
    const rows = [];
    products.forEach(p => (p.variants || []).forEach(v => {
      const qty = v.inventory_quantity || 0;
      if (qty <= 0) rows.push({ title: p.title, sku: v.sku || '', qty });
    }));
    return { answer: `Found ${rows.length} out-of-stock variants.`, data: rows.slice(0, 20) };
  }
  const wineKeyword = extractWineKeyword(q);
  if (/in stock/.test(q) || /under \$?\d+/.test(q) || /white|red|rose|rosé|sparkling|orange/.test(q)) {
    const budgetMatch = q.match(/under \$?(\d+)/);
    const budget = budgetMatch ? parseFloat(budgetMatch[1]) : null;
    const rows = [];
    products.forEach(p => {
      const color = getWineColor(p);
      const text = `${p.title} ${p.product_type || ''} ${p.tags || ''} ${stripHtml(p.body_html)}`.toLowerCase();
      if (wineKeyword && !text.includes(wineKeyword)) return;
      if (q.includes('white') && color !== 'white') return;
      if (q.includes('red') && color !== 'red') return;
      if (q.includes('sparkling') && color !== 'sparkling') return;
      if ((q.includes('rose') || q.includes('rosé')) && color !== 'rose') return;
      if (q.includes('orange') && color !== 'orange') return;
      (p.variants || []).forEach(v => {
        const qty = v.inventory_quantity || 0;
        const price = parseFloat(v.price || 0);
        if (qty <= 0) return;
        if (budget && price > budget) return;
        rows.push({ title: p.title, sku: v.sku || '', qty, price: v.price, url: `https://${SHOP}/products/${p.handle}` });
      });
    });
    rows.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    return { answer: `Found ${rows.length} matching in-stock variants.`, data: rows.slice(0, 20) };
  }
  return null;
}

function legacyCustomerOrderAnswer(question, customers, orders) {
  const q = question.toLowerCase();
  const wineKeyword = extractWineKeyword(q);
  if (/what orders came in/.test(q) || /orders yesterday/.test(q) || /orders last/.test(q)) {
    const rows = orders.map(o => ({
      order: o.name, created_at: o.created_at,
      customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '',
      total_price: o.total_price
    }));
    return { answer: `Found ${rows.length} matching orders.`, data: rows.slice(0, 20) };
  }
  if ((/customers bought/.test(q) || /who bought/.test(q)) && wineKeyword) {
    const matched = [];
    orders.forEach(o => {
      const found = (o.line_items || []).some(li =>
        `${li.title || ''} ${li.variant_title || ''}`.toLowerCase().includes(wineKeyword)
      );
      if (found && o.customer) {
        matched.push({
          customer: `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim(),
          email: o.customer.email || '', order: o.name, created_at: o.created_at
        });
      }
    });
    const seen = new Set(); const unique = [];
    matched.forEach(r => { const key = `${r.email}|${r.order}`; if (!seen.has(key)) { seen.add(key); unique.push(r); } });
    return { answer: `Found ${unique.length} matching customer/order records for ${wineKeyword}.`, data: unique.slice(0, 20) };
  }
  if (/customer count|how many customers/.test(q)) {
    return {
      answer: `Found ${customers.length} customers in the fetched sample.`,
      data: customers.slice(0, 10).map(c => ({ name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), email: c.email || '' }))
    };
  }
  return null;
}

async function legacyQaFallback(question) {
  const q = question.toLowerCase();
  const days = extractDays(q, 30);
  const needOrders    = /order|bought|customer|yesterday|last week|last month|last \d+ day/.test(q);
  const needCustomers = /customer|customers|buyer|buyers/.test(q);
  const products = await fetchAllProducts();
  const inv = legacyInventoryAnswer(q, products);
  if (inv) return { question, domain: 'products_inventory', engine: 'legacy', ...inv };
  const customers = needCustomers ? await fetchCustomers(250) : [];
  const orders    = needOrders    ? await fetchOrders(days, 250) : [];
  const co = legacyCustomerOrderAnswer(q, customers, orders);
  if (co) return { question, domain: 'customers_orders', engine: 'legacy', ...co };
  return {
    question, domain: 'unknown', engine: 'legacy',
    answer: 'I could not classify that question. Configure DATABASE_URL and run the warehouse sync to unlock the full analytics engine.',
    data: []
  };
}

// ---------------------------------------------------------------------------
// /shopify-qa  (PROTECTED — DB-backed analytics with legacy fallback)
// ---------------------------------------------------------------------------

app.post('/shopify-qa', requireBasicAuth, async (req, res) => {
  try {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) {
      return res.json({ answer: 'Ask a Shopify data question.', data: [] });
    }

    if (db.isEnabled()) {
      try {
        const result = await analyticsEngine.answer(question);
        return res.json({ ...result, engine: 'db' });
      } catch (e) {
        // DB present but query failed (e.g. migrations not run yet). Fall
        // through to legacy so the route stays useful, but report it.
        console.error('[shopify-qa] analytics engine failed:', e.message);
      }
    }
    const result = await legacyQaFallback(question);
    return res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// /admin/sync/*  (PROTECTED — same auth as /shopify-qa)
// ---------------------------------------------------------------------------

function requireDb(req, res, next) {
  if (!db.isEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL is not configured on this deployment.' });
  }
  next();
}

// Lightweight request logger for admin sync routes: method, path, status,
// elapsed_ms. Logged after response finishes to capture the real status.
function adminRequestLogger(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    const elapsed_ms = Date.now() - t0;
    // Structured-ish single line; cheap to parse from Render logs.
    console.log(
      `[admin] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed_ms}ms)`
    );
  });
  next();
}

app.use('/admin', adminRequestLogger);

app.post('/admin/sync/products', requireBasicAuth, requireDb, async (req, res) => {
  // Manager-visible products sync. Always returns JSON. Surfaces flat
  // products_written / variants_written / elapsed_ms fields so the admin UI
  // can render them inline, while preserving the legacy `result` shape for
  // backward compatibility with older clients.
  const t0 = Date.now();
  try {
    const result = await syncProductsMod.syncProducts();
    const elapsed_ms = Date.now() - t0;
    res.json({
      ok: true,
      endpoint: 'products',
      products_written: result.products,
      variants_written: result.variants,
      skus_written:     result.variants, // 1 variant = 1 SKU in this schema
      elapsed_ms,
      result,
    });
  } catch (e) {
    const elapsed_ms = Date.now() - t0;
    console.error('[admin/sync/products] FAILED', e && e.stack ? e.stack : e);
    res.status(500).json({
      ok: false,
      endpoint: 'products',
      error: e.message,
      elapsed_ms,
    });
  }
});

app.post('/admin/sync/locations', requireBasicAuth, requireDb, async (req, res) => {
  try { res.json({ ok: true, result: await syncLocationsMod.syncLocations() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/sync/inventory', requireBasicAuth, requireDb, async (req, res) => {
  try { res.json({ ok: true, result: await syncInventoryMod.syncInventory(req.body || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/sync/customers', requireBasicAuth, requireDb, async (req, res) => {
  try { res.json({ ok: true, result: await syncCustomersMod.syncCustomers(req.body || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// /admin/sync/orders  — reliable, observable, always responds with JSON.
// Accepts: { days?, limit?, max?, maxPages?, sinceIso?, untilIso? }
// Backwards compatible with the original { days: 1 } body shape.
app.post('/admin/sync/orders', requireBasicAuth, requireDb, async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const daysIn = body.days != null ? Number(body.days) : null;

  // Per-request log prefix lets us correlate page events in Render logs.
  const tag = `[admin/sync/orders ${t0.toString(36)}]`;
  const log = (event, payload) => {
    try {
      console.log(`${tag} ${event} ${JSON.stringify(payload)}`);
    } catch {
      console.log(`${tag} ${event} <unserializable>`);
    }
  };

  log('request', {
    days: daysIn,
    limit: body.limit ?? null,
    max: body.max ?? null,
    maxPages: body.maxPages ?? null,
    sinceIso: body.sinceIso ?? null,
    untilIso: body.untilIso ?? null,
  });

  // Safety net: if the handler somehow takes too long, return JSON instead
  // of letting the load balancer terminate silently. The underlying sync
  // continues to log; we just stop blocking the HTTP response.
  const handlerTimeoutMs = Number(
    body.handlerTimeoutMs || process.env.ORDERS_SYNC_HANDLER_TIMEOUT_MS || 110_000
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) {
      const elapsed_ms = Date.now() - t0;
      log('handler_timeout', { handlerTimeoutMs, elapsed_ms });
      res.status(504).json({
        ok: false,
        endpoint: 'orders',
        days: daysIn,
        error: `handler timed out after ${handlerTimeoutMs}ms (sync may still be running)`,
        stage: 'fetch',
        elapsed_ms,
      });
    }
  }, handlerTimeoutMs);

  try {
    const result = await syncOrdersMod.syncOrders({ ...body, log });
    if (timedOut || res.headersSent) return; // response already sent
    clearTimeout(timer);
    const elapsed_ms = Date.now() - t0;
    res.json({
      ok: true,
      endpoint: 'orders',
      days: daysIn,
      chunks_processed: result.chunks_processed,
      pages_fetched: result.pages_fetched,
      orders_written: result.orders_written,
      line_items_written: result.line_items_written,
      orders_skipped: result.orders_skipped,
      lines_skipped: result.lines_skipped,
      cancelled_seen: result.cancelled_seen,
      window: { sinceIso: result.sinceIso, untilIso: result.untilIso },
      elapsed_ms,
    });
  } catch (e) {
    clearTimeout(timer);
    if (timedOut || res.headersSent) return;
    const elapsed_ms = Date.now() - t0;
    const stage = e && e.stage ? e.stage : 'unknown';
    const message = (e && e.message) || String(e);
    console.error(`${tag} ERROR stage=${stage} elapsed_ms=${elapsed_ms}`, e && e.stack ? e.stack : e);
    res.status(500).json({
      ok: false,
      endpoint: 'orders',
      days: daysIn,
      error: message,
      stage,
      elapsed_ms,
    });
  }
});

app.post('/admin/sync/backfill', requireBasicAuth, requireDb, async (req, res) => {
  try { res.json({ ok: true, result: await backfillMod.runBackfill(req.body || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /qa  (PROTECTED — same auth as /shopify-qa). Serves a single-file BI page
// that posts questions to /shopify-qa and renders text, tables, and charts
// (bar / line / pie / donut / stacked_bar) from the visualization spec.
// This is purely additive — any existing client of /shopify-qa continues to
// work unchanged because /shopify-qa still returns the answer/data fields.
// ---------------------------------------------------------------------------
const QA_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harvest BI</title>
<style>
:root { --bg:#0e1014; --panel:#171b22; --ink:#e7eaf0; --dim:#9aa3b2; --acc:#9bd2ff; --good:#6ddf9a; --bad:#ff8a8a; --line:#262b34; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
header h1 { margin:0; font-size:16px; font-weight:600; letter-spacing:.2px; }
header .meta { color:var(--dim); font-size:12px; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 16px 20px 80px; }
form { display:flex; gap:8px; margin: 14px 0; }
input[type=text] { flex:1; background:var(--panel); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:8px; font-size:14px; }
button { background:var(--acc); color:#0b0e12; border:0; padding:10px 14px; border-radius:8px; font-weight:600; cursor:pointer; }
button:disabled { opacity:.6; cursor:wait; }
.examples { display:flex; gap:6px; flex-wrap:wrap; margin: 6px 0 14px; }
.examples button { background:var(--panel); color:var(--ink); border:1px solid var(--line); font-weight:500; font-size:12px; padding:6px 10px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-top:14px; }
.card h2 { margin:0 0 4px; font-size:14px; font-weight:600; }
.card .sub { color:var(--dim); font-size:12px; margin-bottom:10px; }
.answer { white-space: pre-wrap; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { padding:6px 10px; text-align:left; border-bottom:1px solid var(--line); }
th { color: var(--dim); font-weight:500; }
.meta-bar { color: var(--dim); font-size:12px; margin-top:8px; }
.error { color: var(--bad); }
.svg-wrap { width:100%; overflow-x:auto; }
svg { display:block; }
.legend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--dim); margin-top:6px; }
.legend span.dot { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:4px; vertical-align:middle; }
</style>
</head>
<body>
<header>
  <h1>🍷 Harvest BI</h1>
  <span class="meta">staff analytics — same data, same auth</span>
</header>
<div class="wrap">
  <form id="ask">
    <input id="q" type="text" placeholder='Try: "how much did we sell last week" or "chart top 10 varietals last month"' autocomplete="off"/>
    <button id="go">Ask</button>
  </form>
  <div class="examples" id="examples"></div>
  <div id="result"></div>
</div>
<script>
const EXAMPLES = [
  'how much did we sell last week',
  'top items sold yesterday',
  'chart top 10 varietals last quarter',
  'show me sales by day last week',
  'how many repeat customers did we have last week',
  'who spent the most last week',
  'how did last week compare to the week before',
  'show me a table of dead inventory',
  'give me a dashboard for last week',
];
const ex = document.getElementById('examples');
EXAMPLES.forEach(t => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { document.getElementById('q').value = t; ask(); return false; }; ex.appendChild(b); });

const PALETTE = ['#9bd2ff','#6ddf9a','#ffd479','#ff9bd2','#cdb7ff','#7fd6c7','#ffb27f','#a0b0c0'];
function fmtMoney(n){ if(n==null) return '$0.00'; return '$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtInt(n){ if(n==null) return '0'; return Number(n).toLocaleString('en-US'); }
function fmtPct(n){ if(n==null) return '0%'; return (Number(n)*100).toFixed(1)+'%'; }
function fmtValue(v, format){ if(v==null) return '—'; if(format==='currency') return fmtMoney(v); if(format==='percent') return fmtPct(v); if(format==='integer') return fmtInt(v); return String(v); }

function renderTable(spec){
  const rows = spec.rows || [];
  if (!rows.length) return '<div class="meta-bar">no rows</div>';
  const keys = Object.keys(rows[0]).filter(k => k !== 'raw');
  const head = '<tr>' + keys.map(k => '<th>' + escapeHtml(k) + '</th>').join('') + '</tr>';
  const body = rows.slice(0, 200).map(r =>
    '<tr>' + keys.map(k => '<td>' + escapeHtml(String(r[k] ?? '')) + '</td>').join('') + '</tr>'
  ).join('');
  return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

function renderBar(spec){
  const rows = (spec.rows || []).slice(0, 30);
  if (!rows.length) return '<div class="meta-bar">no rows to chart</div>';
  const W = 880, H = 320, padL = 60, padB = 90, padT = 12, padR = 14;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xField = spec.x_field, yField = spec.y_field;
  const ys = rows.map(r => Number(r[yField]) || 0);
  const yMax = Math.max(...ys, 0); const yMin = Math.min(...ys, 0);
  const range = (yMax - yMin) || 1;
  const bw = Math.max(8, innerW / rows.length - 6);
  const xs = rows.map((_, i) => padL + i * (innerW / rows.length) + (innerW / rows.length - bw) / 2);
  const zero = padT + innerH - ((0 - yMin) / range) * innerH;
  let svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
  // y axis grid + labels (3 ticks)
  for (let t=0; t<=3; t++){
    const v = yMin + (range * t / 3);
    const y = padT + innerH - (t / 3) * innerH;
    svg += '<line x1="' + padL + '" x2="' + (W-padR) + '" y1="' + y + '" y2="' + y + '" stroke="#262b34"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y+4) + '" fill="#9aa3b2" font-size="11" text-anchor="end">' + escapeHtml(fmtValue(v, spec.value_format)) + '</text>';
  }
  rows.forEach((r, i) => {
    const v = Number(r[yField]) || 0;
    const top = padT + innerH - ((v - yMin) / range) * innerH;
    const h = Math.max(0, zero - top);
    const color = v >= 0 ? PALETTE[i % PALETTE.length] : '#ff8a8a';
    svg += '<rect x="' + xs[i] + '" y="' + Math.min(top, zero) + '" width="' + bw + '" height="' + Math.abs(h) + '" fill="' + color + '" rx="2"/>';
    const label = String(r[xField] ?? '');
    const labShort = label.length > 14 ? label.slice(0, 12) + '…' : label;
    svg += '<text transform="translate(' + (xs[i] + bw/2) + ',' + (H - padB + 12) + ') rotate(-32)" fill="#9aa3b2" font-size="11" text-anchor="end">' + escapeHtml(labShort) + '</text>';
    svg += '<title>' + escapeHtml(label + ': ' + fmtValue(v, spec.value_format)) + '</title>';
  });
  svg += '</svg>';
  return '<div class="svg-wrap">' + svg + '</div>';
}

function renderLine(spec){
  const rows = (spec.rows || []);
  if (!rows.length) return '<div class="meta-bar">no rows to chart</div>';
  const W = 880, H = 300, padL = 60, padB = 50, padT = 12, padR = 14;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xField = spec.x_field, yField = spec.y_field;
  const ys = rows.map(r => Number(r[yField]) || 0);
  const yMax = Math.max(...ys, 0), yMin = Math.min(...ys, 0);
  const range = (yMax - yMin) || 1;
  const xs = rows.map((_, i) => padL + (i / Math.max(1, rows.length - 1)) * innerW);
  const points = rows.map((r, i) => xs[i] + ',' + (padT + innerH - ((Number(r[yField]) || 0) - yMin) / range * innerH)).join(' ');
  let svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
  for (let t=0; t<=3; t++){
    const v = yMin + (range * t / 3);
    const y = padT + innerH - (t / 3) * innerH;
    svg += '<line x1="' + padL + '" x2="' + (W-padR) + '" y1="' + y + '" y2="' + y + '" stroke="#262b34"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y+4) + '" fill="#9aa3b2" font-size="11" text-anchor="end">' + escapeHtml(fmtValue(v, spec.value_format)) + '</text>';
  }
  svg += '<polyline fill="none" stroke="#9bd2ff" stroke-width="2" points="' + points + '"/>';
  rows.forEach((r, i) => {
    const cy = padT + innerH - ((Number(r[yField]) || 0) - yMin) / range * innerH;
    svg += '<circle cx="' + xs[i] + '" cy="' + cy + '" r="3" fill="#9bd2ff"><title>' + escapeHtml(String(r[xField] ?? '') + ': ' + fmtValue(r[yField], spec.value_format)) + '</title></circle>';
    if (rows.length <= 20) {
      const lab = String(r[xField] ?? '');
      const labShort = lab.length > 12 ? lab.slice(2,12) : lab;
      svg += '<text x="' + xs[i] + '" y="' + (H - padB + 14) + '" fill="#9aa3b2" font-size="11" text-anchor="middle">' + escapeHtml(labShort) + '</text>';
    }
  });
  svg += '</svg>';
  return '<div class="svg-wrap">' + svg + '</div>';
}

function renderPie(spec){
  const rows = (spec.rows || []).slice(0, 12);
  if (!rows.length) return '<div class="meta-bar">no rows to chart</div>';
  const cx = 160, cy = 160, r = 130, ir = spec.chart_type === 'donut' ? 70 : 0;
  const total = rows.reduce((a, x) => a + (Number(x[spec.y_field]) || 0), 0) || 1;
  let acc = -Math.PI/2;
  let svg = '<svg width="380" height="320" viewBox="0 0 380 320">';
  rows.forEach((row, i) => {
    const v = Number(row[spec.y_field]) || 0;
    const ang = (v / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(acc), y1 = cy + r * Math.sin(acc);
    const x2 = cx + r * Math.cos(acc + ang), y2 = cy + r * Math.sin(acc + ang);
    const large = ang > Math.PI ? 1 : 0;
    let path;
    if (ir > 0) {
      const ix1 = cx + ir * Math.cos(acc + ang), iy1 = cy + ir * Math.sin(acc + ang);
      const ix2 = cx + ir * Math.cos(acc), iy2 = cy + ir * Math.sin(acc);
      path = 'M' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + large + ',1 ' + x2 + ',' + y2 + ' L' + ix1 + ',' + iy1 + ' A' + ir + ',' + ir + ' 0 ' + large + ',0 ' + ix2 + ',' + iy2 + ' Z';
    } else {
      path = 'M' + cx + ',' + cy + ' L' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + large + ',1 ' + x2 + ',' + y2 + ' Z';
    }
    svg += '<path d="' + path + '" fill="' + PALETTE[i % PALETTE.length] + '"><title>' + escapeHtml(String(row[spec.x_field] ?? '') + ': ' + fmtValue(v, spec.value_format)) + '</title></path>';
    acc += ang;
  });
  svg += '</svg>';
  const legend = '<div class="legend">' + rows.map((row, i) => '<span><span class="dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' + escapeHtml(String(row[spec.x_field] ?? '')) + '</span>').join('') + '</div>';
  return svg + legend;
}

function renderChart(spec){
  const t = spec.chart_type;
  if (t === 'line') return renderLine(spec);
  if (t === 'pie' || t === 'donut') return renderPie(spec);
  return renderBar(spec); // default
}

function renderVisualization(spec){
  if (!spec) return '';
  let out = '';
  if (spec.output_mode === 'chart' || (spec.chart_type && spec.output_mode !== 'table')) {
    out += renderChart(spec);
  } else {
    out += renderTable(spec);
  }
  return out;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function ask(){
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const btn = document.getElementById('go');
  btn.disabled = true; btn.textContent = '…';
  const out = document.getElementById('result');
  out.innerHTML = '<div class="card"><div class="answer">Thinking…</div></div>';
  try {
    const res = await fetch('/shopify-qa', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question: q }) });
    const j = await res.json();
    let html = '<div class="card">';
    html += '<h2>' + escapeHtml((j.visualization && j.visualization.title) || q) + '</h2>';
    if (j.visualization && j.visualization.subtitle) html += '<div class="sub">' + escapeHtml(j.visualization.subtitle) + '</div>';
    if (j.answer) html += '<div class="answer">' + escapeHtml(j.answer) + '</div>';
    if (j.visualization) html += '<div style="margin-top:12px">' + renderVisualization(j.visualization) + '</div>';
    else if (j.data && Array.isArray(j.data) && j.data.length && typeof j.data[0] === 'object') {
      html += '<div style="margin-top:12px">' + renderTable({ rows: j.data }) + '</div>';
    }
    html += '<div class="meta-bar">intent=' + escapeHtml(j.intent || '') + ' · domain=' + escapeHtml(j.domain || '') + ' · status=' + escapeHtml((j.meta && j.meta.status) || '') + (j.meta && j.meta.timeframe ? ' · timeframe=' + escapeHtml(j.meta.timeframe.label || j.meta.timeframe.mode || '') : '') + '</div>';
    html += '</div>';
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = '<div class="card error">Error: ' + escapeHtml(e.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Ask';
  }
}
document.getElementById('ask').addEventListener('submit', e => { e.preventDefault(); ask(); });
</script>
</body>
</html>
`;

app.get('/qa', requireBasicAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(QA_PAGE_HTML);
});

app.get('/health', async (req, res) => {
  const out = { ok: true, db: { enabled: db.isEnabled() } };
  if (db.isEnabled()) {
    out.db = { enabled: true, ...(await db.ping()) };
  }
  res.json(out);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wine pairing backend running on :${port}`));
