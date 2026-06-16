// src/analytics/entities.js
// Pulls non-temporal "what's the question about" hints out of a question:
// customer name / email, product hint, vendor, sku, color, varietal, money
// threshold, limit. These are *hints*, not resolved DB ids - see resolver.js.

const COLOR_WORDS = ['sparkling', 'red', 'white', 'rose', 'rose', 'orange'];
const COLOR_NORMALIZE = { 'rose': 'rose' };

const VARIETALS = [
  // reds
  'pinot noir', 'cabernet sauvignon', 'cabernet', 'merlot', 'syrah', 'shiraz',
  'grenache', 'tempranillo', 'malbec', 'zinfandel', 'sangiovese', 'nebbiolo',
  'barolo', 'gamay', 'beaujolais', 'montepulciano', 'barbera',
  // whites
  'chardonnay', 'sauvignon blanc', 'riesling', 'chenin blanc', 'chenin',
  'viognier', 'pinot grigio', 'pinot gris', 'gruner veltliner', 'gruner',
  'albarino', 'albarino', 'vermentino', 'gewurztraminer',
  // sparkling / other
  'champagne', 'prosecco', 'cava', 'lambrusco', 'rose', 'rose',
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
  const matches = raw.match(/\b[A-Z][a-zA-Z''\-]{1,}(?:\s+[A-Z][a-zA-Z''\-]+){0,4}/g);
  return matches || [];
}

function cleanCustomerCandidate(s) {
  // Trim, collapse whitespace, drop trailing punctuation.
  return s.replace(/[^A-Za-z''\- ]+$/g, '').replace(/\s+/g, ' ').trim();
}

function looksLikeName(s) {
  if (!s) return false;
  const parts = s.split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  for (const w of parts) {
    if (NAME_STOPWORDS.has(w.toLowerCase())) return false;
    if (!/^[A-Z][a-zA-Z''\-]{1,}$/.test(w)) return false;
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

// Trim trailing helper / timeframe / context fragments that managers append
// to questions but that are NOT part of the customer name.
const NAME_TAIL_TRIM = [
  /\s+with\s+us\b.*$/i,
  /\s+all[- ]?time\b.*$/i,
  /\s+lifetime\b.*$/i,
  /\s+ever\b.*$/i,
  /\s+(?:in|over|since|after|before)\s+(?:the\s+)?\d.*$/i,
  /\s+(?:in|over)\s+(?:the\s+)?(?:last|past)\s+\d+\s+(?:days?|weeks?|months?|years?)\b.*$/i,
  /\s+(?:last|past|this|next)\s+\d+\s+(?:days?|weeks?|months?|years?)\b.*$/i,
  /\s+(?:last|past|this|next)\s+(?:week|month|quarter|year|day)\b.*$/i,
  /\s+(?:today|yesterday|tomorrow)\b.*$/i,
  /\s+(?:year[- ]to[- ]date|ytd|month[- ]to[- ]date|mtd|quarter[- ]to[- ]date|qtd)\b.*$/i,
  // Behavior / preference / comparison verbs that should NOT be part of a name.
  /\s+(?:usually|typically|normally|often|mostly|mainly|generally|most|reorder|reorders)\b.*$/i,
  /\s+(?:like|likes|prefer|prefers|favorite|favorites|favourite|favourites)\b.*$/i,
  /\s+(?:buy|buys|bought|buying|purchase|purchases|purchased|purchasing|order|orders|ordered|ordering|get|gets|spend|spent|spending|shop|shops|shopped|shopping|drink|drinks|drank|drinking|tastes?)\b.*$/i,
  // "compare X with/and/vs/versus Y" - the trailing connector + Y is not part of X.
  /\s+(?:with|and|vs|versus|against|or)\s+.+$/i,
  /[?.!,;:]+$/,
];

function trimNameTail(s) {
  let v = String(s || '');
  for (const re of NAME_TAIL_TRIM) v = v.replace(re, '');
  return v.replace(/\s+/g, ' ').trim();
}

// Phrase-anchored extractors. These run case-INSENSITIVELY so we can pull
// "brian hadfield" out of "how much has brian hadfield spent". The capture
// group stops at common helper/temporal words via a non-greedy match plus
// the NAME_TAIL_TRIM pass.
const PHRASE_PATTERNS = [
  // "how much (did|has|have|do|does) <name> (spent|spend|spending|spends|owe|owed)..."
  /how\s+much\s+(?:did|has|have|do|does)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:spend|spent|spending|spends|owe|owed)/i,
  // "what (has|did|does|do) <name> (spent|spend|spending|bought|buy|buys|order|ordered|orders|purchased|purchase|purchases|like|prefer|reorder|drink|get)..."
  /what\s+(?:has|did|have|does|do)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:spent|spend|spending|bought|buy|buys|order|orders|ordered|purchased|purchase|purchases|like|likes|prefer|prefers|reorder|reorders|drink|drinks|drank|get|gets)/i,
  // "what (varietal|vendor|product|category|wine|wines|regions|brands|types|categories) (does|do) <name> (buy|purchase|like|prefer) ..."
  /what\s+(?:varietal|varietals|vendor|vendors|product|products|category|categories|wine|wines|brand|brands|region|regions|type|types)\s+(?:does|do|did)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:buy|buys|bought|purchase|purchases|purchased|like|likes|prefer|prefers|order|orders|ordered|usually|typically|normally|mostly)/i,
  // "what (is|are) <name>('s)? favorite(s)? ..."
  /what\s+(?:is|are)\s+([a-z][a-z .''\-]{1,60}?)(?:'s)?\s+favorites?(?:\s+\w+)?/i,
  // "how many (units|bottles|items|cases|orders) (has|did|have) <name> (bought|buy|placed|ordered|order)..."
  /how\s+many\s+(?:units?|bottles?|items?|cases?|orders?)\s+(?:has|did|have)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:bought|buy|placed|ordered|order|purchased)/i,
  // "(does|do|did) <name> (usually|typically|normally|mostly)? (buy|drink|get|purchase|order|prefer|reorder) ..."
  /(?:does|do|did)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:usually|typically|normally|mostly|mainly)?\s*(?:buy|buys|bought|drink|drinks|drank|get|gets|purchase|purchases|purchased|order|orders|ordered|prefer|prefers|reorder|reorders|shop|shops|shopped)/i,
  // "(has|have) <name> (shifted|moved|migrated|been|usually|started) ..."
  /(?:has|have)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:shifted|moved|migrated|been|usually|started|stopped|changed)/i,
  // "how has <name> (buying|spending|shopping|tastes?) changed..."
  /how\s+has\s+([a-z][a-z .''\-]{1,60}?)\s+(?:buying|spending|shopping|tastes?)/i,
  // "when did <name> last (shop|order|buy|purchase|visit)..."
  /when\s+(?:did|was)\s+([a-z][a-z .''\-]{1,60}?)\s+(?:last|most\s+recently)\s+(?:shop|order|buy|purchase|visit)/i,
  // "what did <name> (buy|order|purchase|spend) ..."
  /what\s+did\s+([a-z][a-z .''\-]{1,60}?)\s+(?:buy|bought|order|ordered|purchase|purchased|spend|spent)/i,
  // "show me <name>('s)? last (order|N orders|recent purchases)"
  /show\s+me\s+([a-z][a-z .''\-]{1,60}?)(?:'s)?\s+(?:last|recent|biggest|largest|smallest|most\s+recent)\s+(?:order|orders|\d+\s+orders|purchases?)/i,
  // "what was on <name>('s)? last order"
  /what\s+(?:was|is)\s+(?:on|in)\s+([a-z][a-z .''\-]{1,60}?)(?:'s)?\s+(?:last|biggest|recent|most\s+recent)\s+(?:order|orders)/i,
  // "(chart|graph|plot|show|make a chart of) <name>('s)? (revenue|units|spend|orders|sales)"
  /(?:chart|graph|plot|show|make\s+a\s+chart\s+of)\s+([a-z][a-z .'\-]{1,60}?)(?:'s)?\s+(?:revenue|units|spend|orders?|sales|units\s+bought|bottles\s+bought)/i,
  // "compare <name> (with|and|to|vs|versus) ..."  (captures left side; pair extractor handles both)
  // Allow any character in the capture so phrases like "compare X last 6 months to"
  // can still progress past the digit; trimNameTail then strips the tail.
  /compare\s+([a-z][^?.!,;:]{1,80}?)\s+(?:with|and|to|vs\.?|versus|against)\s/i,
  // "<name> (vs|versus|against) <other>" - captures left side
  /^([a-z][a-z .'\-]{1,60}?)\s+(?:vs\.?|versus|against)\s+/i,
  // "is <name> still active"
  /is\s+([a-z][a-z .''\-]{1,60}?)\s+still\s+active/i,
  // possessive: "<name>'s recent purchases / favorite / average order value"
  /([a-z][a-z .''\-]{1,60}?)['']s\s+(?:recent|favorite|favourite|average|last|last\s+\d+|order|spend|spending|profile|customer\s+profile)/i,
  // "(show me )?(customer profile|profile) for/of <name>" - must explicitly
  // mention customer/profile to avoid eating product hints like "show me
  // details about olive brine".
  /(?:show\s+me\s+the\s+|the\s+)?(?:customer\s+profile|profile)\s+(?:for|of)\s+([a-z][a-z .''\-]{1,60}?)(?:[?.!,;:]|$)/i,
];

function extractCustomerHint(raw) {
  if (!raw) return null;
  const text = String(raw);

  // 1) Phrase-anchored captures (case-insensitive). Try each in order; the
  //    captured fragment is run through trimNameTail() to drop trailing
  //    timeframe/helper phrases.
  for (const re of PHRASE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    let candidate = trimNameTail(m[1]);
    // The candidate must look like a name (2-5 words, each alpha-ish) but
    // case-insensitively this time.
    if (looksLikeNameCI(candidate)) return normalizeName(candidate);
  }

  // 2) Capitalized-run fallback (legacy heuristic).
  const candidates = tokensFromCapWords(text)
    .map(cleanCustomerCandidate)
    .filter(looksLikeName);
  candidates.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  return candidates[0] || null;
}

// Case-insensitive variant of looksLikeName: 2-5 alpha tokens, no stopwords.
function looksLikeNameCI(s) {
  if (!s) return false;
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  for (const w of parts) {
    if (NAME_STOPWORDS.has(w.toLowerCase())) return false;
    if (!/^[a-zA-Z][a-zA-Z''\-]{1,}$/.test(w)) return false;
  }
  return true;
}

// Title-case for display, but the resolver matches case-insensitively so
// this is purely cosmetic.
function normalizeName(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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
  if (best === 'albarino') best = 'albarino';
  if (best === 'rose') best = 'rose';
  return best;
}

function extractVendor(q) {
  // Heuristic only - `vendor X`, `winery X`, `producer X`.
  const m = q.match(/(?:vendor|producer|winery)\s+([a-z0-9 &.\-']{2,40})/i);
  if (m) return m[1].trim();
  return null;
}

function extractSku(raw) {
  if (!raw) return null;
  // 1) Explicit "SKU XYZ" or "sku: XYZ" form.
  const m1 = raw.match(/\bsku[: ]+([A-Za-z0-9\-]{3,40})/i);
  if (m1) return m1[1];
  // 2) Capitalized alphanumeric with a dash (legacy shape).
  const m2 = raw.match(/\b([A-Z][A-Z0-9]+\-[A-Z0-9\-]{1,30})\b/);
  if (m2) return m2[1];
  // 3) Bare alphanumeric token after the word "SKU" (e.g. "SKU DTALPG22").
  //    Already covered by m1 because the SKU keyword is required for the
  //    bare form (otherwise random words like "WINE2026" would be misread).
  // 4) All-digits long codes ("50082043") when preceded by SKU/item/product.
  const m4 = raw.match(/\b(?:sku|item|product)[\s#:]+(\d{4,})/i);
  if (m4) return m4[1];
  return null;
}

function extractMoneyThreshold(q) {
  // $ prefix is optional. Catch both literal "$25" and "25 dollars".
  const m = q.match(/under\s+\$?(\d+(?:\.\d+)?)/);
  if (m) return { op: '<', value: parseFloat(m[1]) };
  const m2 = q.match(/over\s+\$?(\d+(?:\.\d+)?)/);
  if (m2) return { op: '>', value: parseFloat(m2[1]) };
  const m3 = q.match(/between\s+\$?(\d+(?:\.\d+)?)\s+and\s+\$?(\d+(?:\.\d+)?)/);
  if (m3) return { op: 'between', min: parseFloat(m3[1]), max: parseFloat(m3[2]) };
  // "less than $25" / "more than $100" / "above $50" / "below $30"
  const lt = q.match(/(?:less\s+than|below|cheaper\s+than)\s+\$?(\d+(?:\.\d+)?)/);
  if (lt) return { op: '<', value: parseFloat(lt[1]) };
  const gt = q.match(/(?:more\s+than|above|pricier\s+than|premium|over)\s+\$?(\d+(?:\.\d+)?)/);
  if (gt) return { op: '>', value: parseFloat(gt[1]) };
  return null;
}

// "fewer than 6 units left", "less than 3 units", "below 10 units" - these
// are about *quantity*, not price. Returned as { op:'<', value:N }.
function extractUnitThreshold(q) {
  const m = q.match(/(?:fewer\s+than|less\s+than|below|under)\s+(\d+)\s+(?:units?|bottles?|cases?|items?)\s*(?:left|on\s+hand|in\s+stock)?/);
  if (m) return { op: '<', value: parseInt(m[1], 10) };
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
  // Order matters: "average order value" wins over generic "orders" and
  // generic "revenue".
  if (/\baverage\s+order\s+value|\baov\b|\bavg\s+order\b/.test(q)) return 'aov';
  if (/\bhow\s+many\s+orders|\border\s+count\b|\bnumber\s+of\s+orders\b/.test(q)) return 'orders';
  if (/\bhow\s+many\s+(?:units?|bottles?|items?|cases?)/.test(q)) return 'units';
  if (/\brevenue\b|\bsales\b|\bnet\s+sales\b|\btotal\s+sales\b|\bdollars?\b|\$\d|\bmoney\b|\bhow\s+much\s+(?:did|have|has)\s+(?:we|i)\s+(?:sell|sold|made)|\bhow\s+much\s+(?:did|have|has)\s+(?:we|i)\s+make/.test(q)) return 'revenue';
  if (/\bunits?\b|\bbottles?\b|\bcases?\b|\bquantity\b/.test(q)) return 'units';
  if (/\borders?\b/.test(q)) return 'orders';
  return null;
}

// "gift items", "gift boxes" -> category hint that survives into builders as
// a substring filter on product type/title.
//
// Also covers broader taxonomy synonyms requested by the manager spec:
//   liquor / spirit / spirits / hard alcohol -> 'spirit'
//   beer / cider                              -> 'beer'
//   non-wine / non wine                       -> 'non-wine'
//   mixer / mixers / tonic / soda             -> 'mixer'
//   gift items / gift boxes / gift sets       -> 'gift'
function extractCategory(q) {
  if (/\b(?:spirits?|liquor|hard\s+alcohol)\b/.test(q)) return 'spirit';
  if (/\b(?:beer|ciders?)\b/.test(q)) return 'beer';
  if (/\bmixers?\b|\btonic\b|\bbitters?\b|\bvermouth\b/.test(q)) {
    return /\bvermouth\b/.test(q) ? 'vermouth' : 'mixer';
  }
  if (/\bgift\s+(?:box|boxes|set|sets|items?|cards?)\b|\bgifts?\b/.test(q)) return 'gift';
  if (/\bnon[- ]?wine\b/.test(q)) return 'non-wine';
  if (/\bolive\s+brine\b/.test(q)) return 'olive brine';
  return null;
}

// Output-mode detection: chart > table > text (chart wins because chart
// words are more specific than "show me <X>").
function extractOutputMode(q) {
  if (/\b(?:chart|graph|graph\s+of|plot|visuali[sz]e|visual\s+of|bar\s+(?:chart|graph)|line\s+chart|line\s+graph|pie\s+chart|donut\s+chart|stacked\s+bar)\b/.test(q)) {
    return 'chart';
  }
  if (/\b(?:table|tabulate|rows|break\s+out|show\s+me\s+by|in\s+a\s+table|as\s+a\s+table)\b/.test(q)) {
    return 'table';
  }
  return null; // null = let the engine pick the default for the intent
}

function extractChartType(q) {
  if (/\bbar\s+(?:chart|graph)\b/.test(q)) return 'bar';
  if (/\bline\s+(?:chart|graph)\b/.test(q)) return 'line';
  if (/\bstacked\s+bar\b/.test(q)) return 'stacked_bar';
  if (/\bdonut\b/.test(q)) return 'donut';
  if (/\bpie\b/.test(q)) return 'pie';
  return null;
}

// "repeat customers" / "returning customers" / "first-time customers".
function extractCustomerSegment(q) {
  if (/\brepeat\s+(?:customers?|buyers?|shoppers?)|returning\s+(?:customers?|buyers?|shoppers?)/.test(q)) return 'repeat';
  if (/\bfirst[- ]?time\s+(?:customers?|buyers?|shoppers?)|new\s+(?:customers?|buyers?|shoppers?)/.test(q)) return 'new';
  return null;
}

// "what percent/percentage of customers ... were ..." / "share of ...".
function extractShareIntent(q) {
  return /\b(?:what\s+(?:percent|percentage|share|fraction)|share\s+of)\b/.test(q);
}

// Order number / order reference extraction.
// Accepts:
//   - "#37857"
//   - "order #37857" / "order 37857" / "order number 37857"
//   - "ticket #37857" / "receipt #37857"
// Returns the numeric id (without the leading #) plus the canonical name
// ("#37857") that the orders table stores.
function extractOrderRef(raw) {
  if (!raw) return null;
  const text = String(raw);
  // 1) "order|ticket|receipt (#|number)?  N"
  let m = text.match(/\b(?:order|ticket|receipt)\s*(?:number\s+|#)?(\d{2,12})\b/i);
  if (m) {
    const n = m[1];
    return { id: n, name: '#' + n, raw: m[0] };
  }
  // 2) Hash-prefixed: "#37857" anywhere
  m = text.match(/(?:^|[^A-Za-z0-9])#(\d{2,12})\b/);
  if (m) {
    const n = m[1];
    return { id: n, name: '#' + n, raw: '#' + n };
  }
  return null;
}

// Extracts a customer-pair: "compare X to Y" / "X vs Y" / "who spends more, X or Y".
// Returns { left, right } when two plausible names found, otherwise null.
function extractCustomerPair(raw) {
  if (!raw) return null;
  const text = String(raw);

  // Pattern A: "compare X (with|and|to|vs|versus|against) Y"
  let m = text.match(/\bcompare\s+(.+?)\s+(?:with|and|to|vs\.?|versus|against)\s+(.+?)(?:[?.!,;:]|$)/i);
  if (m) {
    const left = trimNameTail(m[1]);
    const right = trimNameTail(m[2]);
    if (looksLikeNameCI(left) && looksLikeNameCI(right)) {
      return { left: normalizeName(left), right: normalizeName(right) };
    }
  }
  // Pattern B: "who (spends|orders|buys) more, X or Y" / "who (spends|orders|buys) more X or Y"
  m = text.match(/\bwho\s+(?:spends|spent|orders|ordered|buys|bought|shops|shopped|drinks?)\s+more,?\s+(.+?)\s+or\s+(.+?)(?:[?.!,;:]|$)/i);
  if (m) {
    const left = trimNameTail(m[1]);
    const right = trimNameTail(m[2]);
    if (looksLikeNameCI(left) && looksLikeNameCI(right)) {
      return { left: normalizeName(left), right: normalizeName(right) };
    }
  }
  // Pattern C: bare "X vs Y" / "X versus Y" / "X against Y"
  m = text.match(/([A-Za-z][A-Za-z .''\-]{1,40})\s+(?:vs\.?|versus|against)\s+([A-Za-z][A-Za-z .''\-]{1,40})/);
  if (m) {
    const left = trimNameTail(m[1]);
    const right = trimNameTail(m[2]);
    if (looksLikeNameCI(left) && looksLikeNameCI(right)) {
      return { left: normalizeName(left), right: normalizeName(right) };
    }
  }
  return null;
}

// Pulls a free-text product hint from common phrasings:
//   "commonly bought with <X>"
//   "what is sold with <X>"
//   "tell/show/give me the details (about|on|for|of) <X>"
//   "details for SKU <X>"  (the SKU side is already extracted separately)
//   "tell me about <X>" - broad fallback when no email present
function extractProductHint(raw) {
  if (!raw) return null;
  const q = String(raw);

  // 1) "bought/sold/paired/purchased/together with <hint>"
  let m = q.match(/\b(?:bought|sold|paired|purchased|together)\s+with\s+([A-Za-z][A-Za-z0-9 ''\-]{2,60})/i);
  if (m) return trimProductHint(m[1]);

  // 2) "(tell|show|give) (me )?(the )?(full )?(product )?details? (about|on|for|of) <hint>"
  m = q.match(/\b(?:tell|show|give)\s+(?:me\s+)?(?:the\s+)?(?:full\s+)?(?:product\s+)?details?\s+(?:about|on|for|of)\s+(.+?)$/i);
  if (m) return trimProductHint(m[1]);

  // 3) "tell me about <hint>" (broad)
  m = q.match(/\btell\s+me\s+about\s+(.+?)$/i);
  if (m) return trimProductHint(m[1]);

  // 4) capitalized after bare "with " (existing behavior)
  m = q.match(/\bwith\s+([A-Z][A-Za-z0-9 ''\-]{2,40})/);
  if (m) return trimProductHint(m[1]);

  return null;
}

function trimProductHint(s) {
  let v = String(s || '').trim();
  // Strip the leading "SKU XXX" form - SKUs are handled by extractSku.
  v = v.replace(/^sku\s+/i, '');
  // Trim trailing punctuation.
  v = v.replace(/[?.!,;:]+$/g, '').trim();
  // Trim trailing temporal helper phrases that snuck into the capture.
  v = v.replace(/\s+(?:today|yesterday|this|last|past|all|in|over|since|after|before|with\s+us)\b.*$/i, '').trim();
  if (v.length < 3) return null;
  return v;
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
    customer:        extractCustomerHint(q),
    email:           extractEmail(q),
    sku:             extractSku(q),
    varietal:        extractVarietal(lower),
    color:           extractColor(lower),
    vendor:          extractVendor(lower),
    category:        extractCategory(lower),
    money:           extractMoneyThreshold(lower),
    unitsBelow:      extractUnitThreshold(lower),
    limit:           extractLimit(lower),
    metric:          extractMetric(lower),
    productHint:     extractProductHint(q),
    outputMode:      extractOutputMode(lower),
    chartType:       extractChartType(lower),
    customerSegment: extractCustomerSegment(lower),
    shareIntent:     extractShareIntent(lower),
    orderRef:        extractOrderRef(q),
    customerPair:    extractCustomerPair(q),
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
  extractCategory,
  extractMoneyThreshold,
  extractUnitThreshold,
  extractLimit,
  extractMetric,
  extractProductHint,
  extractOutputMode,
  extractChartType,
  extractCustomerSegment,
  extractShareIntent,
  extractOrderRef,
  extractCustomerPair,
  looksLikeName,
  looksLikeNameCI,
  normalizeName,
  trimNameTail,
  VARIETALS,
};
