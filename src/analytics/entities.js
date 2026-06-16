// src/analytics/entities.js
// Pulls non-temporal "what's the question about" hints out of a question:
// customer name / email, product hint, vendor, sku, color, varietal, money
// threshold, limit. These are *hints*, not resolved DB ids — see resolver.js.

const COLOR_WORDS = ['sparkling', 'red', 'white', 'rose', 'rosé', 'orange'];
const COLOR_NORMALIZE = { 'rosé': 'rose' };

const VARIETALS = [
  // reds
  'pinot noir', 'cabernet sauvignon', 'cabernet', 'merlot', 'syrah', 'shiraz',
  'grenache', 'tempranillo', 'malbec', 'zinfandel', 'sangiovese', 'nebbiolo',
  'barolo', 'gamay', 'beaujolais', 'montepulciano', 'barbera',
  // whites
  'chardonnay', 'sauvignon blanc', 'riesling', 'chenin blanc', 'chenin',
  'viognier', 'pinot grigio', 'pinot gris', 'gruner veltliner', 'gruner',
  'albarino', 'albariño', 'vermentino', 'gewurztraminer',
  // sparkling / other
  'champagne', 'prosecco', 'cava', 'lambrusco', 'rose', 'rosé',
];

// Words that should NEVER be treated as a customer name even if capitalized.
const NAME_STOPWORDS = new Set([
  'top', 'best', 'worst', 'show', 'list', 'who', 'what', 'which', 'when',
  'how', 'why', 'where', 'is', 'are', 'do', 'does', 'did',
  'last', 'this', 'next', 'past', 'today', 'yesterday', 'tomorrow',
  'week', 'month', 'quarter', 'year', 'day', 'days',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'q1', 'q2', 'q3', 'q4', 'ytd',
  'sales', 'revenue', 'orders', 'order', 'units', 'customers', 'customer',
  'product', 'products', 'sku', 'skus', 'item', 'items',
  'shopify', 'harvest', 'wine', 'wines', 'bottle', 'bottles', 'case', 'cases',
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tokensFromCapWords(raw) {
  // Find runs of capitalized words in the original (case-sensitive) question.
  // Returns each run as a string ("John Smith", "Mary Jane O'Brien").
  if (!raw) return [];
  const matches = raw.match(/\b[A-Z][a-zA-Z'’\-]{1,}(?:\s+[A-Z][a-zA-Z'’\-]+){0,4}/g);
  return matches || [];
}

function cleanCustomerCandidate(s) {
  // Trim, collapse whitespace, drop trailing punctuation.
  return s.replace(/[^A-Za-z'’\- ]+$/g, '').replace(/\s+/g, ' ').trim();
}

function looksLikeName(s) {
  if (!s) return false;
  const parts = s.split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  for (const w of parts) {
    if (NAME_STOPWORDS.has(w.toLowerCase())) return false;
    if (!/^[A-Z][a-zA-Z'’\-]{1,}$/.test(w)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// extractors
// ---------------------------------------------------------------------------

function extractEmail(raw) {
  const m = String(raw || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : null;
}

function extractCustomerHint(raw) {
  if (!raw) return null;

  // 1) Explicit "for/about/by Foo Bar" or possessive "Foo Bar's"
  const explicit = raw.match(/(?:for|about|by)\s+([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+){0,3})/);
  if (explicit && looksLikeName(cleanCustomerCandidate(explicit[1]))) {
    return cleanCustomerCandidate(explicit[1]);
  }
  const possessive = raw.match(/([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+){0,3})['’]s\b/);
  if (possessive && looksLikeName(cleanCustomerCandidate(possessive[1]))) {
    return cleanCustomerCandidate(possessive[1]);
  }

  // 2) Any 2-5 word capitalized run that passes looksLikeName.
  const candidates = tokensFromCapWords(raw)
    .map(cleanCustomerCandidate)
    .filter(looksLikeName);

  // Prefer the longest run (more specific).
  candidates.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  return candidates[0] || null;
}

function extractColor(q) {
  const lower = q.toLowerCase();
  for (const w of COLOR_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) {
      return COLOR_NORMALIZE[w] || w;
    }
  }
  return null;
}

function extractVarietal(q) {
  const lower = q.toLowerCase();
  // Prefer the longest match.
  let best = null;
  for (const v of VARIETALS) {
    if (lower.includes(v) && (!best || v.length > best.length)) best = v;
  }
  // Normalize accented variants to canonical form.
  if (best === 'albariño') best = 'albarino';
  if (best === 'rosé') best = 'rose';
  return best;
}

function extractVendor(q) {
  // Heuristic only — `vendor X`, `winery X`, `producer X`.
  const m = q.match(/(?:vendor|producer|winery)\s+([a-z0-9 &.\-']{2,40})/i);
  if (m) return m[1].trim();
  return null;
}

function extractSku(raw) {
  if (!raw) return null;
  const m1 = raw.match(/\bsku[: ]+([A-Za-z0-9\-]+)/i);
  if (m1) return m1[1];
  // Capitalized alphanumeric with dash, 4+ chars.
  const m2 = raw.match(/\b([A-Z][A-Z0-9]+\-[A-Z0-9\-]{1,30})\b/);
  if (m2) return m2[1];
  return null;
}

function extractMoneyThreshold(q) {
  const m = q.match(/under\s+\$?(\d+(?:\.\d+)?)/);
  if (m) return { op: '<', value: parseFloat(m[1]) };
  const m2 = q.match(/over\s+\$?(\d+(?:\.\d+)?)/);
  if (m2) return { op: '>', value: parseFloat(m2[1]) };
  const m3 = q.match(/between\s+\$?(\d+(?:\.\d+)?)\s+and\s+\$?(\d+(?:\.\d+)?)/);
  if (m3) return { op: 'between', min: parseFloat(m3[1]), max: parseFloat(m3[2]) };
  return null;
}

function extractLimit(q) {
  const m = q.match(/top\s+(\d+)/);
  if (m) return Math.min(100, Math.max(1, parseInt(m[1], 10)));
  const m2 = q.match(/\b(\d+)\s+(customers?|skus?|products?|wines?|vendors?|items?)/);
  if (m2) return Math.min(100, Math.max(1, parseInt(m2[1], 10)));
  return null;
}

function extractMetric(q) {
  if (/\brevenue|\bsales?\b|\bdollars?\b|\$\d|\bmoney\b/.test(q)) return 'revenue';
  if (/\bunits?\b|\bbottles?\b|\bcases?\b|\bcount\b|\bsold\b/.test(q)) return 'units';
  if (/\borders?\b/.test(q)) return 'orders';
  return null;
}

/**
 * Pull all entity hints from a question in one pass.
 * Returns:
 *   { customer, email, sku, varietal, color, vendor, money, limit, metric }
 */
function extract(raw) {
  const q = String(raw || '');
  const lower = q.toLowerCase();
  return {
    customer: extractCustomerHint(q),
    email:    extractEmail(q),
    sku:      extractSku(q),
    varietal: extractVarietal(lower),
    color:    extractColor(lower),
    vendor:   extractVendor(lower),
    money:    extractMoneyThreshold(lower),
    limit:    extractLimit(lower),
    metric:   extractMetric(lower),
  };
}

module.exports = {
  extract,
  // Re-exported individuals for tests / re-use
  extractCustomerHint,
  extractEmail,
  extractSku,
  extractVarietal,
  extractColor,
  extractVendor,
  extractMoneyThreshold,
  extractLimit,
  extractMetric,
  looksLikeName,
  VARIETALS,
};
