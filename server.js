require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API = `https://${SHOP}/admin/api/2024-10`;

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

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wine pairing backend running on :${port}`));
