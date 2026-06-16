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
  try { res.json({ ok: true, result: await syncProductsMod.syncProducts() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

app.get('/health', async (req, res) => {
  const out = { ok: true, db: { enabled: db.isEnabled() } };
  if (db.isEnabled()) {
    out.db = { enabled: true, ...(await db.ping()) };
  }
  res.json(out);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wine pairing backend running on :${port}`));
