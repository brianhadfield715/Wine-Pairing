// src/analytics/intentParser.js
// Question → { intent, params } where params now includes:
//   - timeframe : the normalized temporal object from temporalParser
//   - days      : approximate window width (backward-compat with old builders)
//   - limit     : numeric or null
//   - color, varietal, vendor, sku, money, metric : entity hints
//   - customerHint, email : raw text hints for resolver.js
//   - rawQuestion
//
// Intent expansion v2: in addition to the original intents we now expose
// finer-grained ones used by the planner and new builders:
//   - customer_spend            (single-customer revenue in window)
//   - customer_order_count
//   - customer_aov
//   - customer_recent_purchases
//   - top_customers_by_varietal
//   - top_items_by_units        (alias of top_skus when metric != revenue)
//   - top_items_by_revenue
//   - bought_with_product
//   - vendor_growth
//   - period_over_period
//   - sales_summary             (alias of revenue_summary)
//
// Old intent names are preserved so existing tests / formatters keep working.

const temporal = require('./temporalParser');
const entities = require('./entities');

// ---------------------------------------------------------------------------
// Intent classification.
//
// Rules of thumb:
//   - Be specific BEFORE generic.
//   - Singular customer questions (named entity) outrank generic top-N.
//   - "yesterday" / "this week" et al. do NOT themselves change the intent —
//     they only change the timeframe. Intent is about WHAT, not WHEN.
// ---------------------------------------------------------------------------

function classifyIntent(qRaw, ent = {}) {
  const q = qRaw.toLowerCase();

  // ---- A. Single-customer questions (only valid if we have a name/email) --
  const haveCustomer = Boolean(ent.customer || ent.email);
  if (haveCustomer) {
    if (/(spend|spent|spend\s+with\s+us|how\s+much\s+(?:did|has)|revenue\s+(?:from|came\s+from)|total\s+(?:spend|sales|revenue))/.test(q)) {
      return 'customer_spend';
    }
    if (/how\s+many\s+orders|order\s+count|number\s+of\s+orders/.test(q)) {
      return 'customer_order_count';
    }
    if (/average\s+order|aov|avg\s+order/.test(q)) {
      return 'customer_aov';
    }
    if (/what\s+did\s+.+\s+(?:buy|order|purchase)|recent\s+purchases?|last\s+(?:few\s+)?(?:orders?|purchases?)/.test(q)) {
      return 'customer_recent_purchases';
    }
    if (/profile\s+of|who\s+is\b|tell\s+me\s+about/.test(q)) {
      return 'customer_profile';
    }
    // Default for "John Smith" alone: profile.
    if (/^.{0,40}$/.test(q.trim()) && /[a-z]/.test(q)) {
      // very short question containing a name → assume profile
      // (handled by entity presence above)
    }
  }

  // ---- B. Customer aggregates ---------------------------------------------
  if (/(top|biggest|highest|best).*(spend|customer|buyer|spender)/.test(q) ||
      /who (spends|buys|purchases|bought|buys|drinks?|drank) (the )?most/.test(q) ||
      /best customers/.test(q)) {
    // Specialize by category/varietal/vendor when present.
    if (ent.varietal) return 'top_customers_by_varietal';
    if (ent.vendor)   return 'top_customers_by_vendor';
    return 'top_customers_by_spend';
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
  if (/one[- ]time\s+customers?|single[- ]order\s+customers?|bought\s+only\s+once/.test(q)) {
    return 'customers_one_time_only';
  }

  // ---- C. Basket / affinity ----------------------------------------------
  if (
    /what sells together|sold together|bought together|buy together|purchased together|commonly sold together|commonly bought together|most commonly sold together|basket pairs|market basket|affinity/.test(q)
  ) {
    return 'basket_pairs';
  }
  if (/(?:bought|purchased|sold)\s+(?:with|alongside)\s+/.test(q) ||
      /what(?:'s|s)?\s+(?:often\s+)?bought\s+with/.test(q)) {
    return 'bought_with_product';
  }

  // ---- D. Inventory health -----------------------------------------------
  if (/dead (stock|inventory)|not sold|never sold|stale inventory|sitting|haven'?t sold|gathering dust/.test(q)) {
    return 'dead_inventory';
  }
  if (/unsold\s+in|unsold\s+for|nothing\s+sold\s+in/.test(q)) {
    return 'unsold_in_period';
  }
  if (/aged\s+inventory|old\s+inventory|on[- ]hand\s+for\s+a\s+while/.test(q)) {
    return 'aged_inventory';
  }
  if (/overstock|too\s+much\s+stock|excess\s+inventory/.test(q)) {
    return 'overstock';
  }
  if (/runout|run\s+out|stockout\s+risk|about\s+to\s+run\s+out/.test(q)) {
    return 'runout_risk';
  }
  if (/sell[- ]through|sellthrough/.test(q)) {
    return 'sell_through';
  }
  if (/(velocity|fast[- ]?moving|sells\s+well\s+but\s+low\s+stock|sold\s+well.*low\s+stock|low\s+stock.*(high|fast|good).*(velocity|sell|seller))/.test(q) ||
      /reorder/.test(q)) {
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

  // ---- E. Sales / SKU performance ----------------------------------------
  // Top items / products / wines: pick metric.
  if (/(top|best|highest|most).*(seller|selling|skus?|products?|wines?|items?)/.test(q) ||
      /best\s+selling|top\s+sales|what\s+sold\s+most|most\s+sold/.test(q) ||
      /top\s+items|best\s+items/.test(q)) {
    if (ent.metric === 'revenue') return 'top_items_by_revenue';
    return 'top_items_by_units';
  }
  if (/units?\s+sold|how\s+many\s+.*\s+sold|units?\s+per/.test(q)) {
    return 'units_sold_per_sku';
  }
  if (/sku\s+detail|product\s+detail|tell\s+me\s+about\s+(?:product|sku)/.test(q)) {
    return 'product_detail';
  }

  // ---- F. Vendor / category trends ---------------------------------------
  if (/vendor\s+growth|growing\s+vendors?|fastest[- ]growing\s+vendors?|vendors?\s+are\s+growing/.test(q)) {
    return 'vendor_growth';
  }
  if (/(top|best).*(vendor|producer|winery)|vendor performance/.test(q)) {
    return 'top_vendors';
  }
  if (/category\s+performance|how\s+is\s+(?:red|white|sparkling|rose|orange)\s+doing/.test(q)) {
    return 'category_performance';
  }
  if (/varietal\s+performance|how\s+is\s+(?:chardonnay|pinot\s+noir|cabernet|merlot|riesling)\s+doing/.test(q)) {
    return 'varietal_performance';
  }
  if (/period[- ]over[- ]period|vs\s+(?:last|previous)\s+(?:week|month|quarter|year)|compared\s+to\s+(?:last|previous)/.test(q)) {
    return 'period_over_period';
  }
  if (/trending\s+up|growing\s+products?|gaining\s+momentum/.test(q)) {
    return 'trending_up';
  }
  if (/trending\s+down|declining|losing\s+steam/.test(q)) {
    return 'trending_down';
  }

  // ---- G. Time-windowed views --------------------------------------------
  if (/recent orders|orders (yesterday|today|last|this)|what orders/.test(q)) {
    return 'recent_orders';
  }
  if (/revenue|total sales|how much .* sold|sales trend|sales\s+summary/.test(q)) {
    return 'sales_summary';
  }

  return 'general_help';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parse(questionRaw, { now } = {}) {
  const question = String(questionRaw || '').trim();
  const ent = entities.extract(question);
  const tf = temporal.parse(question, now ? { now } : undefined);
  const intent = classifyIntent(question, ent);

  const params = {
    rawQuestion: question,
    timeframe: tf,
    days: tf.days || null,
    limit: ent.limit,
    metric: ent.metric,
    color: ent.color,
    varietal: ent.varietal,
    vendor: ent.vendor,
    sku: ent.sku,
    money: ent.money,
    customerHint: ent.customer,
    email: ent.email,
    productHint: null, // reserved for explicit product references
  };

  return { intent, params };
}

module.exports = {
  parse,
  classifyIntent,
};
