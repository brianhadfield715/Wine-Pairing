// src/analytics/intentParser.js
//
// Question → { intent, params } where params now also includes:
//   - timeframe   : normalized temporal object from temporalParser
//   - days        : explicit "in the last N days" capture (or tf.days)
//   - dayCount    : explicit numeric N captured from "in N days" patterns
//                   (drives dead_inventory / slow_moving)
//   - limit       : numeric or null
//   - metric      : one of 'revenue' | 'units' | 'orders' | 'aov' | null
//   - color, varietal, vendor, sku, money, unitsBelow, category : hints
//   - customerHint, email, productHint : raw text for resolver.js
//   - scope       : 'storewide' | 'customer' | 'product' | 'vendor' | 'category'
//                   (set by the planner based on which entity hints fire)
//   - sort        : 'asc' | 'desc' (for decline-style routing)
//   - rawQuestion
//
// Backward compatibility:
//   - All previously routed phrases still route to the same intent name.
//   - Old intent names (top_skus, revenue_summary) are kept in the registry
//     as aliases.

const temporal = require('./temporalParser');
const entities = require('./entities');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture the explicit number of days in dead/slow-inventory phrasings:
 *   "products not sold in the last 30 days"
 *   "what hasn't sold in 60 days"
 *   "no sales in the last 90 days"
 *   "no movement in 14 days"
 */
function extractInventoryDays(q) {
  // Covers "not sold in N days", "no sales in N days", "hasn't sold",
  // "has not sold", "hasn't moved", "has not moved", "no movement in N days".
  const m = q.match(/\b(?:not\s+sold|no\s+sales|haven'?t\s+sold|haven'?t\s+moved|hasn'?t\s+sold|hasn'?t\s+moved|has\s+not\s+sold|has\s+not\s+moved|no\s+movement|inactive|unsold)\s+(?:in|for|over)\s+(?:the\s+)?(?:last\s+|past\s+)?(\d+)\s+days?\b/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  return null;
}

/**
 * "sold fewer than 3 units in the last 30 days" or
 * "sold less than 5 units in 30 days" → { maxUnits, days }
 */
function extractSlowMoving(q) {
  const m = q.match(/sold\s+(?:fewer|less)\s+than\s+(\d+)\s+(?:units?|bottles?|cases?|items?)\s+in\s+(?:the\s+)?(?:last\s+)?(\d+)\s+days?/);
  if (m) return { maxUnits: parseInt(m[1], 10), days: parseInt(m[2], 10) };
  return null;
}

/**
 * "lapsed N days" / "not purchased in N days" / "haven't ordered in N days"
 */
function extractLapsedDays(q) {
  const m = q.match(/(?:not\s+purchased|haven'?t\s+(?:purchased|ordered|bought)|inactive|lapsed)\s+(?:in|for)\s+(?:the\s+)?(?:last\s+|past\s+)?(\d+)\s+days?/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  return null;
}

/**
 * "which customers bought both X and Y" → ['X', 'Y']
 * Captures everything between "both" and the trailing terminator/keyword,
 * splitting on " and ". Greedy enough to preserve "pinot noir".
 */
function extractTwoVarietals(q) {
  const m = q.match(/bought\s+both\s+(.+?)(?:\s+(?:in|during|this|last|past|all|over|since)\s+|[?.!,]|$)/);
  if (!m) return null;
  const pair = m[1].split(/\s+and\s+/);
  if (pair.length !== 2) return null;
  const left = pair[0].replace(/\s+(?:wine|wines|the)$/i, '').trim().toLowerCase();
  const right = pair[1].replace(/\s+(?:wine|wines|the)$/i, '').trim().toLowerCase();
  if (left.length < 3 || right.length < 3) return null;
  return [left, right];
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

function classifyIntent(qRaw, ent = {}) {
  const q = qRaw.toLowerCase();

  // ---- 0. Meta / data-coverage questions ----------------------------------
  // These fire before everything else because their phrasing is unambiguous.
  if (
    /\b(?:what\s+(?:date\s+range|dates?|period)\s+(?:does|do)\s+the\s+order\s+(?:data|records))/.test(q) ||
    /\bhow\s+far\s+back\s+does\s+the\s+order\s+data/.test(q) ||
    /\bwhat\s+is\s+the\s+(?:earliest|latest)\s+order\s+date/.test(q) ||
    /\bwhat\s+order\s+(?:history|date\s+range)\s+(?:do\s+we\s+(?:currently\s+)?have|is\s+currently\s+synced)/.test(q) ||
    /\bdo\s+we\s+have\s+full[- ]?year\s+order\s+data/.test(q) ||
    /\bhow\s+current\s+is\s+the\s+order\s+data/.test(q) ||
    /\bwhat\s+was\s+the\s+latest\s+order\s+imported/.test(q) ||
    /\bhow\s+many\s+orders\s+are\s+(?:in|stored\s+in)\s+the\s+(?:analytics\s+)?database/.test(q)
  ) {
    return 'data_coverage_orders';
  }
  if (
    /\bwhat\s+date\s+range\s+does\s+customer\s+data/.test(q) ||
    /\bhow\s+many\s+customers\s+are\s+(?:in|stored\s+in)\s+the\s+(?:analytics\s+)?database/.test(q)
  ) {
    return 'data_coverage_customers';
  }
  if (
    /\bhow\s+many\s+products\s+are\s+(?:in|stored\s+in)\s+the\s+(?:analytics\s+)?database/.test(q)
  ) {
    return 'data_coverage_products';
  }
  if (
    /\b(?:current\s+)?data\s+coverage\b|\bwhat\s+is\s+the\s+(?:current\s+)?data\s+coverage\b|\bdate\s+range\s+does\s+sales\s+data/.test(q)
  ) {
    return 'data_coverage_all';
  }

  // ---- 0.5 Inventory value (retail by default; cost flagged unavailable) -
  if (
    /\b(?:what\s+is\s+|show\s+me\s+|tell\s+me\s+)?(?:our\s+|the\s+)?(?:total\s+|retail\s+|cost\s+|on[- ]hand\s+)?inventory\s+value\b/.test(q) ||
    /\bvalue\s+of\s+(?:our\s+|the\s+)?(?:current\s+|on[- ]hand\s+)?(?:inventory|stock(?:\s+on\s+hand)?)\b/.test(q) ||
    /\b(?:retail|cost)\s+inventory\s+value\b/.test(q) ||
    /\bvalue\s+of\s+low[- ]?stock\s+items\b/.test(q) ||
    /\bvalue\s+of\s+inventory\s+that\s+has\s+not\s+sold/.test(q) ||
    /\binventory\s+value\s+by\s+(?:vendor|category|color|varietal|product\s+type)\b/.test(q) ||
    /\bwhich\s+vendors\s+represent\s+the\s+most\s+inventory\s+value\b/.test(q) ||
    /\bwhich\s+products\s+carry\s+the\s+most\s+inventory\s+value\b/.test(q)
  ) {
    if (/by\s+vendor\b|which\s+vendors\s+represent/.test(q)) return 'inventory_value_by_vendor';
    if (/by\s+category\b|by\s+(?:color|varietal|product\s+type)\b/.test(q)) return 'inventory_value_by_category';
    if (/dead\s+inventory|has\s+not\s+sold/.test(q)) return 'inventory_value_dead';
    if (/low[- ]?stock/.test(q)) return 'inventory_value_low_stock';
    return 'inventory_value_total';
  }

  // ---- 0.6 Inventory units on hand ----------------------------------------
  if (
    // "how many units are in the store / on hand / in inventory"
    /\bhow\s+many\s+(?:units?|bottles?|items?|cases?)\s+are\s+(?:in\s+(?:the\s+)?store|in\s+inventory|on\s+hand|currently\s+in\s+stock|currently)\b/.test(q) ||
    // "how many units do we (currently) have"
    /\bhow\s+many\s+(?:units?|bottles?|items?|cases?)\s+do\s+we\s+(?:currently\s+)?have\b/.test(q) ||
    // "how many units do we have (in the store|on hand|in inventory)"
    /\bhow\s+many\s+(?:units?|bottles?|items?|cases?)\s+do\s+we\s+have\s+(?:in\s+(?:the\s+)?store|in\s+inventory|on\s+hand)\b/.test(q) ||
    /\bwhat\s+is\s+(?:our\s+)?total\s+on[- ]?hand\s+unit\s+count\b/.test(q) ||
    // Filtered: "how many <color/varietal> units are in the store"
    /\bhow\s+many\s+(?:white\s+wine|sparkling|gift|vendor|chardonnay|red\s+wine|rose|orange)\s+(?:units?|bottles?)\s+are\s+in\s+the\s+store\b/.test(q)
  ) {
    return 'inventory_units_on_hand';
  }

  // ---- 0.7 Inventory counts (product / sku) -------------------------------
  if (
    /\bhow\s+many\s+(?:products?|items?|skus?|variants?)\s+(?:have|are|currently)/.test(q) ||
    /\bhow\s+many\s+(?:white\s+wine|sparkling|gift|vendor|red\s+wine|rose|orange)\s+(?:wines?|products?|items?)\s+are\s+currently\s+in\s+stock\b/.test(q)
  ) {
    if (/out\s+of\s+stock\b|are\s+out\s+of\s+stock\b/.test(q)) return 'inventory_count_out_of_stock';
    if (/low\s+stock\b|are\s+low\s+stock\b/.test(q)) return 'inventory_count_low_stock';
    if (/fewer\s+than\s+\d+\s+units?\b|less\s+than\s+\d+\s+units?\b|more\s+than\s+\d+\s+units?\b|over\s+\d+\s+units?\b|under\s+\d+\s+units?\b/.test(q)) {
      return 'inventory_count_threshold';
    }
    if (/in\s+stock|have\s+inventory|have\s+stock|currently\s+(?:in\s+stock|have)/.test(q)) {
      return 'inventory_count_in_stock';
    }
  }

  // ---- 0.8 Product detail search ("tell me about X") ----------------------
  // Anchored verbs: tell/show/give + "the? (product )?details? (about|on|for|of)"
  // OR bare "tell me about <X>" when no email is present (an email is a much
  // stronger customer signal than a capitalized phrase).
  if (
    /\b(?:tell\s+me|show\s+me|give\s+me)\s+(?:the\s+)?(?:full\s+)?(?:product\s+)?details?\s+(?:about|on|for|of)\s+\S/.test(q) ||
    (/\btell\s+me\s+about\s+\S/.test(q) && !ent.email)
  ) {
    return 'product_detail_search';
  }

  // ---- A. Single-customer questions (only valid if we have a name/email) --
  const haveCustomer = Boolean(ent.customer || ent.email);
  if (haveCustomer) {
    // How many units/items/bottles/cases has X bought  → customer_units_bought
    if (/how\s+many\s+(?:units?|bottles?|items?|cases?)\s+(?:has|have|did)\s+.+\s+(?:bought|buy|purchased|purchase|ordered|order)/.test(q)) {
      return 'customer_units_bought';
    }
    // What did <name> buy ...  (recent purchases). Includes "last thing X bought"
    // and "what were X's last N purchases/orders".
    if (
      /what\s+(?:did|has|were|was)\s+.+\s+(?:buy|bought|order|ordered|purchase|purchased|last\s+\d+\s+(?:orders?|purchases?))/.test(q) ||
      /recent\s+purchases?/.test(q) ||
      /last\s+(?:few\s+|\d+\s+)?(?:orders?|purchases?|thing(?:s)?)\s*(?:bought|ordered|purchased)?/.test(q) ||
      /the\s+last\s+thing\s+.+\s+bought/.test(q)
    ) {
      return 'customer_recent_purchases';
    }
    // Taste / favorite-style questions.
    if (/favorite\s+(?:vendor|producer|winery|varietal|wine|category|price)/.test(q)) {
      return 'customer_taste_profile';
    }
    // What wines does X usually buy / typically drinks
    if (/what\s+wines?\s+(?:does|do)\s+.+\s+(?:usually|typically|normally)\s+(?:buy|drink|prefer|order)/.test(q)) {
      return 'customer_top_varietals';
    }
    // Last shop / still active
    if (/when\s+(?:did|was)\s+.+\s+(?:last|most\s+recently)\s+(?:shop|order|buy|purchase|visit)|is\s+.+\s+still\s+active|when\s+did\s+.+\s+last/.test(q)) {
      return 'customer_last_order';
    }
    if (/how\s+many\s+orders|order\s+count|number\s+of\s+orders/.test(q)) {
      return 'customer_order_count';
    }
    if (/average\s+order|aov|avg\s+order/.test(q)) {
      return 'customer_aov';
    }
    if (/(spend|spent|spend\s+with\s+us|how\s+much\s+(?:did|has|have)|revenue\s+(?:from|came\s+from)|total\s+(?:spend|sales|revenue))/.test(q)) {
      return 'customer_spend';
    }
    if (/profile\s+of|customer\s+profile|who\s+is\b|tell\s+me\s+about/.test(q)) {
      return 'customer_profile';
    }
  }

  // ---- B. Customer aggregates --------------------------------------------
  // Order-count specific phrasings ("most often", "recurring", "frequent")
  // beat the broader "buy the most" rule.
  if (/which\s+customers?\s+buy\s+(?:the\s+)?most\s+often|most\s+frequent\s+customers?|recurring\s+customers?|strongest\s+recurring/.test(q)) {
    return 'top_customers_by_order_count';
  }
  if (/highest\s+average\s+order\s+value|highest\s+aov|biggest\s+spenders\s+per\s+order/.test(q)) {
    return 'top_customers_by_aov';
  }
  if (/(top|biggest|highest|best).*(spend|customer|buyer|spender)/.test(q) ||
      /who\s+(?:spends|buys|purchases|bought|drinks?|drank)\s+(?:the\s+)?most/.test(q) ||
      /which\s+customers?\s+(?:spend|spent|buy|bought|drink|drank)\s+(?:the\s+)?most/.test(q) ||
      /which\s+customers?\s+buy\s+mostly/.test(q) ||
      /best customers/.test(q) ||
      /top\s+(?:chardonnay|pinot\s+noir|cabernet|merlot|riesling|sparkling|red|white|rose|rosé)\s+(?:customers?|buyers?)/.test(q) ||
      /(?:top|best)\s+customers?\s+for\b/.test(q)) {
    if (ent.varietal) return 'top_customers_by_varietal';
    if (ent.vendor)   return 'top_customers_by_vendor';
    if (ent.sku)      return 'top_customers_by_sku';
    return 'top_customers_by_spend';
  }
  if (/customers? (who )?bought|who bought|which\s+customers?\s+bought/.test(q)) {
    if (extractTwoVarietals(q)) return 'customers_bought_both';
    return 'customers_who_bought';
  }
  if (/customer count|how many customers/.test(q)) {
    return 'customer_count';
  }
  if (/new customers|first[- ]time customers|new buyers|customers?\s+(?:that\s+are\s+|who\s+are\s+|are\s+)new/.test(q)) {
    return 'new_customers';
  }
  if (/lapsed|inactive customers|customers?\s+at\s+risk|becoming inactive|haven'?t (?:ordered|bought|purchased)|have\s+not\s+(?:ordered|bought|purchased)|not\s+purchased\s+in/.test(q)) {
    return 'lapsed_customers';
  }
  if (/one[- ]time\s+customers?|single[- ]order\s+customers?|bought\s+only\s+once|placed\s+only\s+one\s+order/.test(q)) {
    return 'customers_one_time_only';
  }

  // ---- C. Basket / affinity ----------------------------------------------
  if (
    /what sells together|sold together|bought together|buy together|purchased together|commonly sold together|commonly bought together|most commonly sold together|basket pairs|market basket|affinity|wines? (?:are )?usually bought together|skus? (?:are )?usually bought together/.test(q)
  ) {
    return 'basket_pairs';
  }
  if (/(?:bought|purchased|sold|paired)\s+(?:with|alongside)\s+/.test(q) ||
      /what(?:'s|s)?\s+(?:often\s+|commonly\s+)?bought\s+with\b/.test(q) ||
      /(?:also\s+buy|also\s+bought)\b/.test(q)) {
    return 'bought_with_product';
  }

  // ---- D. Inventory health -----------------------------------------------
  // Vendor-bucket questions about dead inventory go FIRST so the generic
  // dead_inventory rule doesn't swallow them. Cover "vendors with", "vendors
  // having", AND "vendors have the most dead inventory".
  if (/vendors?\s+(?:with|having|have)\s+(?:the\s+)?(?:most\s+|biggest\s+)?dead\s+inventory|vendors?\s+(?:with|having|have)\s+(?:the\s+)?(?:most\s+)?stuck/.test(q)) {
    return 'vendors_dead_inventory';
  }
  if (extractSlowMoving(q)) return 'slow_moving';
  if (/dead (stock|inventory)/.test(q) || /which\s+products?\s+are\s+(?:dead|aging|stale)/.test(q)) {
    return 'dead_inventory';
  }
  // "products not sold in 30 days" / "no sales in 90 days" / "hasn't moved in 14 days"
  if (extractInventoryDays(q) != null) {
    return 'dead_inventory';
  }
  if (/aged\s+inventory|old\s+inventory|on[- ]hand\s+for\s+a\s+while/.test(q)) {
    return 'aged_inventory';
  }
  if (/overstock|too\s+much\s+stock|excess\s+inventory|overstocked\s+relative/.test(q)) {
    return 'overstock';
  }
  // Runout / stockout risk — note "at risk of stockout" must come BEFORE
  // generic "at risk" patterns elsewhere (lapsed_customers was tightened).
  if (/runout|run\s+out|could\s+run\s+out|stockout\s+risk|about\s+to\s+run\s+out|risk\s+of\s+stockout|at\s+risk\s+of\s+(?:stockout|running\s+out)|need\s+reordering|need\s+to\s+reorder/.test(q)) {
    return 'runout_risk';
  }
  if (/sell[- ]through|sellthrough/.test(q)) {
    return 'sell_through';
  }
  if (/(velocity|fast[- ]?moving|sells\s+well\s+but\s+low\s+stock|sold\s+well.*low\s+stock|low\s+stock.*(?:but\s+)?(?:high|fast|good).*(?:velocity|sell|seller)|low\s+stock\s+but\s+(?:selling\s+fast|high\s+velocity|moving\s+fast)|top\s+sellers?\s+(?:are|that\s+are)\s+low\s+stock|fast\s+movers?\s+have\s+low|high[- ]revenue\s+items?\s+have\s+low)/.test(q) ||
      /reorder/.test(q)) {
    return 'low_stock_high_velocity';
  }
  if (/low stock|running low|almost out|below\s+threshold|fewer\s+than\s+\d+\s+units/.test(q)) {
    return 'low_stock';
  }
  if (/out of stock|sold out|stockout/.test(q)) {
    return 'out_of_stock';
  }
  if (/in stock|available/.test(q)) {
    return 'in_stock_filtered';
  }

  // ---- E. Product / SKU detail (when SKU/product extracted) ---------------
  if (ent.sku || ent.productHint) {
    if (/top\s+customers?\s+for/.test(q)) return 'top_customers_by_sku';
    if (/current\s+inventory|in\s+stock\s+for|on\s+hand\s+for|how\s+many\s+(?:are\s+)?in\s+stock/.test(q)) return 'sku_inventory';
    if (/average\s+(?:selling\s+)?price|avg\s+price/.test(q)) return 'sku_avg_price';
    if (/when\s+(?:was|did)\s+.+\s+last\s+sold|last\s+sold/.test(q)) return 'sku_last_sold';
    if (/has\s+.+\s+sold\s+(?:in|over)\s+(?:the\s+)?(?:last\s+)?\d+\s+days?/.test(q)) return 'product_detail';
    if (/sell[- ]through/.test(q)) return 'sell_through';
    if (/how\s+many\s+orders?\s+included|orders?\s+containing/.test(q)) return 'product_detail';
    if (/how\s+much\s+revenue|revenue\s+has|revenue\s+generated|total\s+revenue/.test(q)) return 'product_detail';
    if (/how\s+many\s+units|units?\s+sold|units?\s+of|sales?\s+details?|performance\s+for|profile\s+for|sales\s+for|sku\s+detail|product\s+detail|sku\s+profile/.test(q)) {
      return 'product_detail';
    }
  }

  // ---- F. Vendor / category / varietal / trend (MUST run before top-items)
  if (/vendor\s+growth|growing\s+vendors?|fastest[- ]growing\s+vendors?|vendors?\s+are\s+growing|vendors?\s+up\s+(?:month|week|quarter|year)\s+over/.test(q)) {
    return 'vendor_growth';
  }
  if (/vendors?\s+(?:are\s+)?down\s+(?:versus|vs|compared\s+to)|declining\s+vendors?|vendors?\s+(?:are\s+)?slipping/.test(q)) {
    return 'vendor_decline';
  }
  if (/strongest\s+average\s+selling\s+price|highest\s+(?:average|avg)\s+(?:selling\s+)?price\b.*vendor|vendor.*(?:strongest|highest)\s+(?:average|avg)\s+(?:selling\s+)?price/.test(q)) {
    return 'vendor_avg_selling_price';
  }
  if (/(top|best).*(vendor|producer|winery)|vendor performance|which\s+vendors?\s+sold\s+(?:best|the\s+most)|which\s+vendors?\s+generated\s+the\s+most\s+revenue|which\s+vendors?\s+sold\s+the\s+most\s+units/.test(q)) {
    return 'top_vendors';
  }
  // Period over period — must run BEFORE varietal_performance which catches
  // "how is X doing this quarter".
  if (/period[- ]over[- ]period|vs\s+(?:last|previous)\s+(?:week|month|quarter|year|day)|compared\s+to\s+(?:last|previous|the\s+prior)|this\s+(?:week|month|quarter|year)\s+(?:compared|vs)\s+(?:last|previous)|sales\s+yesterday\s+compared\s+to\s+the\s+prior\s+day|what\s+(?:improved|declined)\s+(?:this|last)\s+(?:week|month|quarter|year)\s+versus/.test(q)) {
    return 'period_over_period';
  }
  // Varietal performance — checks specific named varietals AND the plural
  // "how are X wines performing" form, which is varietal-style.
  if (/varietal\s+performance|how\s+is\s+(?:chardonnay|pinot\s+noir|cabernet|merlot|riesling|sauvignon\s+blanc)\s+(?:doing|performing)|how\s+are\s+(?:sparkling|red|white|rose|orange)\s+wines?\s+(?:doing|performing)|which\s+varietals\s+are\s+(?:growing|down|declining|performing)/.test(q)) {
    return 'varietal_performance';
  }
  // Category performance — singular "how is X doing" for color words; or
  // "which categories" / "category performance".
  if (/category\s+performance|how\s+is\s+(?:red|white|sparkling|rose|orange)\s+(?:wine\s+)?(?:doing|performing)|which\s+categories\s+are\s+(?:performing|slowing)|categories?\s+(?:are\s+)?slowing/.test(q)) {
    return 'category_performance';
  }
  if (/trending\s+up|growing\s+products?|gaining\s+momentum|items?\s+are\s+trending\s+up/.test(q)) {
    return 'trending_up';
  }
  if (/trending\s+down|declining|losing\s+steam|items?\s+are\s+trending\s+down/.test(q)) {
    return 'trending_down';
  }

  // ---- G. Sales / SKU performance leaderboards (after vendor/category) ---
  if (/(top|best|highest|most).*(seller|selling|skus?|products?|wines?|items?)/.test(q) ||
      /best\s+selling|top\s+sales|what\s+sold\s+most|most\s+sold|what\s+sold\s+best|sold\s+best/.test(q) ||
      /top\s+items|best\s+items|top\s+gift\s+items?/.test(q)) {
    if (ent.metric === 'revenue') return 'top_items_by_revenue';
    return 'top_items_by_units';
  }
  if (/units?\s+sold|how\s+many\s+.*\s+sold|units?\s+per/.test(q)) {
    return 'units_sold_per_sku';
  }

  // ---- H. Time-windowed views & storewide totals --------------------------
  if (/recent orders|orders (yesterday|today|last|this)|what orders/.test(q)) {
    return 'recent_orders';
  }
  // Storewide sales / revenue / units / orders / aov questions.
  // We deliberately fire LAST so customer / product / vendor scopes win
  // when their entity hints are present.
  if (
    /how\s+much\s+(?:did|have|has)\s+(?:we|i)\s+(?:sell|sold|make|made)/.test(q) ||
    /what\s+(?:did|do)\s+we\s+do\b/.test(q) ||
    /what\s+(?:were|was|is)\s+(?:our\s+)?(?:total\s+sales|net\s+sales|revenue|store\s+sales|total\s+revenue|sales)\b/.test(q) ||
    /^(?:total\s+)?(?:store\s+)?sales\b/.test(q) ||
    /\b(?:month|quarter|year)[- ]to[- ]date\s+(?:sales|revenue)\b/.test(q) ||
    /^(?:total\s+)?revenue\b/.test(q) ||
    /\bnet\s+sales\b/.test(q) ||
    /\btotal\s+sales\b/.test(q) ||
    /how\s+many\s+(?:units?|items?|bottles?|cases?)\s+did\s+we\s+sell/.test(q) ||
    /how\s+many\s+orders?\s+did\s+we\s+(?:have|get|receive)/.test(q) ||
    /what\s+was\s+(?:our\s+)?average\s+order\s+value/.test(q) ||
    /\baverage\s+order\s+value\b/.test(q) ||
    // Grouped phrasings — these don't always look like a "sales question"
    // unless we explicitly catch them here. Promotion to sales_time_series
    // happens later in parse() when timeframe.seriesGrain is set.
    /\b(?:show\s+me\s+|show\s+)?(?:total\s+)?(?:orders|sales|revenue|units)\s+by\s+(?:day|week|month)\b/.test(q) ||
    /\bdaily\s+(?:orders?|order\s+count|sales|revenue|units?)\b/.test(q) ||
    /\bweekly\s+(?:orders?|order\s+count|sales|revenue|units?)\b/.test(q) ||
    /\bmonthly\s+(?:orders?|order\s+count|sales|revenue|units?)\b/.test(q) ||
    /\b(?:orders|sales|revenue|units|aov|average\s+order\s+value)\s+by\s+(?:day|week|month)\b/.test(q)
  ) {
    return 'sales_summary';
  }
  // Legacy generic catch (kept):
  if (/revenue|total sales|how much .* sold|sales trend|sales\s+summary/.test(q)) {
    return 'sales_summary';
  }

  return 'general_help';
}

// ---------------------------------------------------------------------------
// Scope tag (for the planner's response meta)
// ---------------------------------------------------------------------------

function deriveScope(intent, ent) {
  if (intent === 'sales_summary' || intent === 'sales_time_series' ||
      intent === 'period_over_period' || intent === 'recent_orders') return 'storewide';
  if (intent && intent.startsWith('data_coverage')) return 'meta';
  if (intent && intent.startsWith('inventory_value')) return 'inventory';
  if (intent && intent.startsWith('inventory_count')) return 'inventory';
  if (intent === 'inventory_units_on_hand') return 'inventory';
  if (intent === 'product_detail_search') return 'product';
  if (intent && intent.startsWith('customer')) return 'customer';
  if (intent && intent.startsWith('top_customers')) return 'customer';
  if (intent === 'customers_who_bought' || intent === 'customers_bought_both' ||
      intent === 'customers_one_time_only' || intent === 'lapsed_customers' ||
      intent === 'new_customers' || intent === 'customer_count') return 'customer';
  if (intent === 'top_vendors' || intent === 'vendor_growth' ||
      intent === 'vendor_decline' || intent === 'vendor_avg_selling_price' ||
      intent === 'vendors_dead_inventory') return 'vendor';
  if (intent === 'category_performance' || intent === 'varietal_performance') return 'category';
  if (intent === 'product_detail' || intent === 'sku_inventory' ||
      intent === 'sku_avg_price' || intent === 'sku_last_sold' ||
      intent === 'top_customers_by_sku') return 'product';
  if (ent.sku || ent.productHint) return 'product';
  if (ent.vendor) return 'vendor';
  if (ent.varietal || ent.color || ent.category) return 'category';
  if (ent.customer || ent.email) return 'customer';
  return 'storewide';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parse(questionRaw, { now } = {}) {
  const question = String(questionRaw || '').trim();
  const q = question.toLowerCase();
  const ent = entities.extract(question);
  const tf = temporal.parse(question, now ? { now } : undefined);
  let intent = classifyIntent(question, ent);

  // Inventory-style explicit day counts override the temporal window for
  // dead_inventory / slow_moving.
  const invDays = extractInventoryDays(q);
  const slow = extractSlowMoving(q);
  const lapsedDays = extractLapsedDays(q);
  const twoVarietals = extractTwoVarietals(q);

  // Time-series escalation: if the classifier landed on a summary-shaped
  // storewide intent AND the temporal parser detected a series grain
  // (each day / by day / weekly / ...) promote the intent to a grouped
  // version. We escalate sales_summary AND units_sold_per_sku because both
  // are common landing points for grouped-time questions.
  if (tf && tf.seriesGrain && (intent === 'sales_summary' || intent === 'units_sold_per_sku' || intent === 'recent_orders')) {
    intent = 'sales_time_series';
  }

  // Surface the invalid_date temporal error as a help/error intent so the
  // engine can show a clean message.
  if (tf && tf.error === 'invalid_date') {
    intent = 'invalid_date';
  }

  const params = {
    rawQuestion: question,
    timeframe: tf,
    days: invDays || (tf.days || null),
    dayCount: invDays || null,
    slow: slow || null,
    lapsedDays: lapsedDays || null,
    twoVarietals: twoVarietals || null,
    grain: tf && tf.seriesGrain ? tf.seriesGrain : null,
    limit: ent.limit,
    metric: ent.metric,
    color: ent.color,
    varietal: ent.varietal,
    vendor: ent.vendor,
    category: ent.category,
    sku: ent.sku,
    money: ent.money,
    unitsBelow: ent.unitsBelow,
    customerHint: ent.customer,
    email: ent.email,
    productHint: ent.productHint,
    scope: deriveScope(intent, ent),
  };

  // If user said "vendor decline" we route via vendor_decline intent; planner
  // adds sort='asc' on the same builder.
  if (intent === 'vendor_decline') {
    params.sort = 'asc';
  }

  return { intent, params };
}

module.exports = {
  parse,
  classifyIntent,
};
