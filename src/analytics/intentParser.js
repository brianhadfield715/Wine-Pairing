// src/analytics/intentParser.js
// Lightweight intent parser. Converts a free-form manager question into a
// structured intent: { intent, params } where `intent` matches a key in
// queryRegistry and `params` carries normalized arguments (limit, days, etc).
//
// Goals:
//   - Cover broad question classes (not 50 exact-phrase regexes).
//   - Extract universal modifiers (limit, time window, color, vendor, etc.)
//     once and pass them to whichever intent is chosen.
//   - Be permissive: ambiguous questions fall back to 'general_help' instead
//     of crashing.

const COLOR_WORDS = ['sparkling', 'red', 'white', 'rose', 'rosé', 'orange'];
const COLOR_NORMALIZE = { 'rosé': 'rose' };

function normalizeColor(word) {
  return COLOR_NORMALIZE[word] || word;
}

function extractDays(q, fallback = 90) {
  const m = q.match(/last\s+(\d+)\s+day/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  const m2 = q.match(/past\s+(\d+)\s+day/);
  if (m2) return Math.max(1, parseInt(m2[1], 10));
  const mm = q.match(/last\s+(\d+)\s+month/);
  if (mm) return Math.max(1, parseInt(mm[1], 10) * 30);
  if (/yesterday/.test(q)) return 1;
  if (/last week|past week|this week/.test(q)) return 7;
  if (/last month|past month|this month/.test(q)) return 30;
  if (/last quarter|past quarter|q[1-4]\b/.test(q)) return 90;
  if (/this year|ytd|year to date/.test(q)) return 365;
  return fallback;
}

function extractLimit(q, fallback = 10) {
  const m = q.match(/top\s+(\d+)/);
  if (m) return Math.min(100, Math.max(1, parseInt(m[1], 10)));
  const m2 = q.match(/\b(\d+)\s+(customers?|skus?|products?|wines?|vendors?|items?)/);
  if (m2) return Math.min(100, Math.max(1, parseInt(m2[1], 10)));
  return fallback;
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

function extractColor(q) {
  for (const w of COLOR_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(q)) return normalizeColor(w);
  }
  return null;
}

function extractVendor(q) {
  const m = q.match(/(?:vendor|producer|winery)\s+([a-z0-9 &.\-']{2,40})/i);
  if (m) return m[1].trim();
  const m2 = q.match(/from\s+([a-z][a-z0-9 &.\-']{2,30})/i);
  if (m2) return m2[1].trim();
  return null;
}

function extractSku(q) {
  // Match common SKU shapes: alphanum with optional dashes, 4+ chars, uppercase.
  const m = q.match(/\b([A-Z][A-Z0-9\-]{3,30})\b/);
  if (m) return m[1];
  // Or explicitly "sku XYZ"
  const m2 = q.match(/sku[: ]+([A-Za-z0-9\-]+)/i);
  if (m2) return m2[1];
  return null;
}

/**
 * Map the lowercased question to an intent. Order matters: more specific
 * intents come first.
 */
function classifyIntent(qRaw) {
  const q = qRaw.toLowerCase();

  // Customer-centric
  if (/(top|biggest|highest|best).*(spend|customer|buyer)/.test(q) ||
      /who (spends|buys|purchases) (the )?most/.test(q) ||
      /best customers/.test(q)) {
    return 'top_customers_by_spend';
  }
  if (/customer profile|profile of (a )?customer|who is\b|buying profile/.test(q)) {
    return 'customer_profile';
  }
  if (/customers? (who )?bought|who bought/.test(q)) {
    return 'customers_who_bought';
  }
  if (/customer count|how many customers/.test(q)) {
    return 'customer_count';
  }
  if (/new customers|first[- ]time customers|new buyers/.test(q)) {
    return 'new_customers';
  }
  if (/lapsed|haven'?t (ordered|bought)|inactive customers|at risk/.test(q)) {
    return 'lapsed_customers';
  }

  // Basket
  if (/sell together|bought together|frequently (bought|purchased) (together|with)|basket|pairs of|combo/.test(q)) {
    return 'basket_pairs';
  }

  // Inventory health
  if (/dead (stock|inventory)|not sold|never sold|stale inventory|sitting/.test(q)) {
    return 'dead_inventory';
  }
  if (/low stock.*(high|fast|good).*(velocity|sell|seller)|reorder/.test(q) ||
      /high velocity.*low stock|hot.*low stock/.test(q)) {
    return 'low_stock_high_velocity';
  }
  if (/low stock|running low|almost out/.test(q)) {
    return 'low_stock';
  }
  if (/out of stock|sold out|stockout/.test(q)) {
    return 'out_of_stock';
  }
  if (/in stock|available/.test(q)) {
    return 'in_stock_filtered';
  }

  // Sales / SKU performance
  if (/(top|best|highest).*(seller|selling|skus?|products?|wines?)/.test(q) ||
      /best selling|top sales/.test(q)) {
    return 'top_skus';
  }
  if (/units? sold|how many .* sold|units? per/.test(q)) {
    return 'units_sold_per_sku';
  }
  if (/(top|best).*(vendor|producer|winery)|vendor performance/.test(q)) {
    return 'top_vendors';
  }

  // Trends / windows
  if (/recent orders|orders (yesterday|today|last|this)|what orders/.test(q)) {
    return 'recent_orders';
  }
  if (/revenue|total sales|how much .* sold|sales trend/.test(q)) {
    return 'revenue_summary';
  }

  return 'general_help';
}

function parse(questionRaw) {
  const question = String(questionRaw || '').trim();
  const q = question.toLowerCase();
  const intent = classifyIntent(q);

  const params = {
    days: extractDays(q),
    limit: extractLimit(q),
    money: extractMoneyThreshold(q),
    color: extractColor(q),
    vendor: extractVendor(q),
    sku: extractSku(question), // case-sensitive helps with SKU codes
    rawQuestion: question,
  };

  // Extract a "wine keyword" (varietal-ish) to support
  // "customers who bought chardonnay".
  const varietals = [
    'chardonnay', 'pinot noir', 'cabernet', 'merlot', 'sauvignon blanc',
    'riesling', 'chenin', 'viognier', 'tempranillo', 'gamay', 'grenache',
    'syrah', 'shiraz', 'malbec', 'zinfandel', 'sangiovese', 'nebbiolo',
    'barolo', 'champagne', 'prosecco',
  ];
  params.varietal = varietals.find((v) => q.includes(v)) || null;

  return { intent, params };
}

module.exports = {
  parse,
  classifyIntent,
  extractDays,
  extractLimit,
  extractMoneyThreshold,
  extractColor,
  extractVendor,
  extractSku,
};
