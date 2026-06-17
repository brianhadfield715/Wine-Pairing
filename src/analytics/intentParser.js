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

  // =========================================================================
  // V6 priority block: order status, shipping, payment, discounts, refunds,
  // operational, customer aggregates, etc. These ride above the older
  // intents so the phrasings from the 84-query spec route correctly.
  // =========================================================================

  // --- "Capability not synced" graceful responses --------------------------
  if (/\bconversion\s+rate\b/.test(q))                        return 'capability_unsupported_conversion_rate';
  if (/\babandoned\s+cart(?:\s+rate)?\b/.test(q))             return 'capability_unsupported_abandoned_cart_rate';
  if (/\bemail\s+campaign(?:\s+performance)?\b/.test(q))      return 'capability_unsupported_email';
  if (/\btraffic\s+sources?\b/.test(q))                       return 'capability_unsupported_traffic_sources';

  // --- Order extreme totals (LARGEST/HIGHEST/LOWEST single order) ----------
  if (/\b(?:largest|biggest|highest[- ]?value|highest[- ]?total)\s+(?:order|sale)(?:\s+ever)?\b/.test(q) ||
      /\bhighest\s+order\s+value\b/.test(q) ||
      /\bbiggest\s+single\s+order\b/.test(q)) {
    return 'highest_order_total';
  }
  if (/\b(?:lowest|smallest)[- ]?(?:order|sale|value|total)\b/.test(q) ||
      /\blowest\s+order\s+value\b/.test(q)) {
    return 'lowest_order_total';
  }
  if (/\borders?\s+(?:over|above|greater\s+than|>=?)\s+\$?(\d+)/.test(q)) {
    return 'orders_above';
  }

  // --- Order status / refund / cancel / fulfill / drafts / archives ------
  // fulfillment-specific status breakdown FIRST (it includes the word "status")
  if (/\bfulfillment\s+status\s+breakdown\b|\b(?:fulfilled|unfulfilled)\s+breakdown\b|\bfulfillment\s+breakdown\b/.test(q)) {
    return 'fulfillment_status_breakdown';
  }
  if (/\borders?\s+by\s+status\b|\border\s+status\s+breakdown\b|\bstatus\s+breakdown\b/.test(q)) {
    return 'order_status_breakdown';
  }
  if (/\borders?\s+pending\s+fulfillment\b|\bpending\s+orders?\b/.test(q)) {
    return 'orders_pending_fulfillment';
  }
  if (/\brefunded\s+orders?(?:\s+count)?\b|\bhow\s+many\s+refunds?\b|\bcount\s+of\s+refunds?\b/.test(q)) {
    return 'refunded_orders_count';
  }
  if (/\bcancell?ed\s+orders?(?:\s+count)?\b|\bhow\s+many\s+cancell?ed\s+orders?\b/.test(q)) {
    return 'cancelled_orders_count';
  }
  if (/\bdraft\s+orders?(?:\s+count)?\b/.test(q)) {
    return 'draft_orders_count';
  }
  if (/\barchived\s+orders?(?:\s+count)?\b/.test(q)) {
    return 'archived_orders_count';
  }
  if (/\borders?\s+with\s+notes?\b/.test(q)) {
    return 'orders_with_notes';
  }
  if (/\borders?\s+with\s+custom\s+attributes?\b/.test(q)) {
    return 'orders_with_custom_attrs';
  }
  if (/\borders?\s+(?:by\s+|grouped\s+by\s+)referrer\b|\border\s+source\s+breakdown\b/.test(q)) {
    return 'orders_by_referrer';
  }
  if (/\btotal\s+tags?\s+used\s+on\s+orders\b|\border\s+tag\s+breakdown\b/.test(q)) {
    return 'orders_by_tag';
  }
  if (/\borders?\s+tagged\s+(?:with\s+)?["']?([\w\- ]+)["']?\b/.test(q)) {
    return 'orders_by_tag';
  }

  // --- Discounts / coupons / taxes / refund rate -------------------------
  if (/\btotal\s+discounts?\s+given\b|\btotal\s+discount\s+(?:dollars|amount)\b/.test(q)) {
    return 'total_discounts_given';
  }
  if (/\btotal\s+tax(?:es)?\s+collected\b/.test(q)) {
    return 'total_taxes_collected';
  }
  if (/\borders?\s+with\s+discounts?\b/.test(q)) {
    return 'orders_with_discounts';
  }
  if (/\borders?\s+without\s+(?:a\s+)?discounts?\b|\borders?\s+with\s+no\s+discount\b/.test(q)) {
    return 'orders_without_discount';
  }
  if (/\baverage\s+discount\s+percentage\b|\bavg\s+discount\s+%\b|\baverage\s+discount\s+%\b/.test(q)) {
    return 'avg_discount_percentage';
  }
  if (/\bwhich\s+discount\s+codes?\s+(?:are\s+)?used\s+(?:the\s+)?most\b|\btop\s+discount\s+codes?\b|\bmost\s+used\s+discount\s+codes?\b/.test(q)) {
    return 'top_discount_codes';
  }
  if (/\bcoupon\s+usage\s+rate\b|\bdiscount\s+code\s+usage\s+rate\b/.test(q)) {
    return 'coupon_usage_rate';
  }
  if (/\brefund\s+rate(?:\s+percentage)?\b|\baverage\s+refund\s+amount\b|\bavg\s+refund\b|\bhow\s+long\s+do\s+refunds?\s+take\b/.test(q)) {
    return 'refund_rate_and_avg';
  }
  if (/\bproducts?\s+with\s+(?:the\s+)?most\s+returns?\b|\breturn\s+rate\s+by\s+product\b/.test(q)) {
    return 'products_with_most_returns';
  }

  // --- Shipping / fulfillment time / address-based -----------------------
  if (/\borders?\s+shipped\s+to\s+([a-z]{2,})\b/i.test(qRaw)) {
    // Real state filter — leave the value to params (entities)
    return 'orders_shipped_to_state';
  }
  if (/\bmost\s+common\s+shipping\s+state\b|\bshipping\s+state\s+breakdown\b|\borders?\s+by\s+(?:shipping\s+)?state\b/.test(q)) {
    return 'orders_shipped_to_state';
  }
  if (/\binternational\s+orders?(?:\s+count)?\b|\borders?\s+shipped\s+(?:abroad|overseas|outside\s+the\s+us)\b/.test(q)) {
    return 'international_orders_count';
  }
  if (/\baverage\s+shipping\s+time\b|\baverage\s+fulfillment\s+time\b|\baverage\s+order\s+lead\s+time\b|\bavg\s+shipping\s+time\b/.test(q)) {
    return 'avg_fulfillment_time';
  }
  if (/\bshipping\s+cost\s+breakdown\b|\bshipping\s+method\s+breakdown\b|\borders?\s+by\s+shipping\s+method\b/.test(q)) {
    return 'shipping_method_breakdown';
  }
  if (/\borders?\s+with\s+free\s+shipping\b|\bfree\s+shipping\s+orders?\b|\bfree\s+shipping\s+threshold\b/.test(q)) {
    return 'free_shipping_orders';
  }
  if (/\borders?\s+with\s+same[- ]?day\s+shipping\b|\bsame[- ]?day\s+shipping\s+orders?\b/.test(q)) {
    return 'orders_by_shipping_title_sameday';
  }
  if (/\borders?\s+with\s+express\s+shipping\b|\bexpress\s+shipping\s+orders?\b/.test(q)) {
    return 'orders_by_shipping_title_express';
  }
  if (/\bstore\s+pick[- ]?up\s+orders?\b|\borders?\s+picked\s+up\s+in\s+store\b/.test(q)) {
    return 'orders_by_shipping_title_pickup';
  }
  if (/\blocal\s+delivery\s+orders?\b|\borders?\s+with\s+local\s+delivery\b/.test(q)) {
    return 'orders_by_shipping_title_localdelivery';
  }
  if (/\borders?\s+shipped\s+(?:this|last)\s+(?:week|month|day|year)\b/.test(q)) {
    return 'orders_shipped_this_window';
  }

  // --- Payment gateway ---------------------------------------------------
  if (/\bpayment\s+method\s+breakdown\b|\borders?\s+by\s+payment\s+method\b|\bpayment\s+gateway\s+breakdown\b/.test(q)) {
    return 'payment_method_breakdown';
  }
  if (/\borders?\s+paid\s+with\s+credit\s+card\b|\bcredit\s+card\s+orders?\b/.test(q)) {
    return 'orders_paid_credit';
  }
  if (/\borders?\s+paid\s+with\s+paypal\b|\bpaypal\s+orders?\b/.test(q)) {
    return 'orders_paid_paypal';
  }

  // --- Misc operational --------------------------------------------------
  if (/\borders?\s+placed\s+after\s+(\d{1,2})\s*(?:am|pm)?\b/.test(q)) {
    return 'orders_after_hour';
  }
  if (/\bgift\s+card\s+orders?\b|\borders?\s+with\s+gift\s+cards?\b/.test(q)) {
    return 'orders_with_gift_cards';
  }
  if (/\btotal\s+weight\s+of\s+(?:all\s+)?orders\b|\btotal\s+order\s+weight\b/.test(q)) {
    return 'total_weight';
  }
  if (/\bheaviest\s+orders?\b/.test(q)) {
    return 'heaviest_orders';
  }
  if (/\baverage\s+items?\s+per\s+order\b|\bavg\s+items?\s+per\s+order\b/.test(q)) {
    return 'avg_items_per_order';
  }
  if (/\btotal\s+line\s+items?\s+sold\b|\btotal\s+line\s+items\b/.test(q)) {
    return 'total_line_items_sold';
  }
  if (/\baverage\s+quantity\s+per\s+line\s+item\b|\bavg\s+quantity\s+per\s+line\s+item\b/.test(q)) {
    return 'avg_quantity_per_line_item';
  }
  if (/\border\s+completion\s+rate\b|\bcompleted\s+order\s+rate\b/.test(q)) {
    return 'order_completion_rate';
  }

  // --- Customer aggregates (storewide lifetime) --------------------------
  if (/\baverage\s+customer\s+(?:lifetime\s+value|ltv)\b|\bavg\s+customer\s+ltv\b|\bmean\s+ltv\b/.test(q)) {
    return 'avg_customer_ltv';
  }
  if (/^customer\s+order\s+frequency\b|\baverage\s+customer\s+order\s+frequency\b|\bavg\s+orders\s+per\s+customer\b/.test(q)) {
    return 'customer_order_frequency';
  }
  if (/\brepeat\s+customer\s+rate\b|\bpercent(?:age)?\s+of\s+(?:repeat|returning)\s+customers\b/.test(q)) {
    return 'repeat_customer_rate';
  }
  if (/\bcustomers?\s+(?:who\s+)?spent\s+(?:over|more\s+than|above|>=?)\s+\$?(\d+)/.test(q)) {
    return 'customers_with_orders_above';
  }
  // "high value customers (this month)" → top_customers_by_spend with window
  if (/\bhigh[- ]?value\s+(?:customers?|buyers?|spenders?)\b/.test(q)) {
    return 'top_customers_by_spend';
  }
  // "churned customers in last 30 days" → lapsed_customers with lapsedDays
  if (/\bchurned\s+customers?\b/.test(q)) {
    return 'lapsed_customers';
  }
  if (/\bcustomers?\s+with\s+no\s+orders?\b|\bcustomers?\s+who\s+haven'?t\s+ordered\b/.test(q)) {
    return 'customers_with_no_orders';
  }
  if (/\bcustomer\s+locations?\s+breakdown\b|\bcustomers?\s+by\s+state\b|\bcustomer\s+geo(?:graphic)?\s+breakdown\b/.test(q)) {
    return 'customer_locations_breakdown';
  }
  if (/\blast\s+order\s+date\s+per\s+customer\b|\beach\s+customer'?s?\s+last\s+order\b/.test(q)) {
    return 'last_order_date_per_customer';
  }
  if (/\borders?\s+from\s+first[- ]?time\s+(?:buyers?|customers?)\b/.test(q)) {
    return 'first_time_buyer_orders';
  }
  // wholesale / retail tag-based
  if (/\bwholesale\s+orders?\b/.test(q)) {
    return 'orders_by_tag_wholesale';
  }
  if (/\bretail\s+orders?\b/.test(q)) {
    return 'orders_by_tag_retail';
  }

  // --- Weekday vs weekend ------------------------------------------------
  if (/\bweekday\s+vs\s+weekend\b|\bweekday\s+versus\s+weekend\b|\bweekend\s+vs\s+weekday\b/.test(q)) {
    return 'weekday_vs_weekend';
  }
  if (/\bwhich\s+day\s+(?:of\s+the\s+week\s+)?has\s+the\s+most\s+orders\b/.test(q)) {
    return 'busiest_period_pattern';
  }
  // Bare "busiest day of the week" / "busiest hour of the day" (no qualifier)
  if (/\bbusiest\s+day\s+of\s+the\s+week\b|\bbusiest\s+hour\s+of\s+the\s+day\b/.test(q)) {
    return 'busiest_period_pattern';
  }

  // --- Products / catalog / inventory ------------------------------------
  if (/\bwhat\s+products?\s+do\s+we\s+sell\b/.test(q)) {
    return 'what_products_do_we_sell';
  }
  if (/\bworst[- ]?selling\s+(?:products?|skus?)\b|\bworst\s+sellers?\b|\bproducts?\s+with\s+the\s+(?:fewest|least)\s+sales\b/.test(q)) {
    return 'worst_selling_products';
  }
  if (/\bnewest\s+products?\s+added\b|\bmost\s+recently\s+added\s+products?\b|\brecently\s+added\s+products?\b/.test(q)) {
    return 'newest_products_added';
  }
  if (/\binventory\s+by\s+location\b/.test(q)) {
    return 'inventory_by_location';
  }
  if (/\binventory\s+levels?\s+by\s+product\b|\binventory\s+per\s+product\b/.test(q)) {
    return 'inventory_levels_by_product';
  }
  if (/\bproducts?\s+not\s+in\s+inventory\b|\bproducts?\s+(?:that\s+)?have\s+no\s+inventory\b/.test(q)) {
    return 'products_not_in_inventory';
  }
  if (/\binventory\s+turnover(?:\s+rate)?\b/.test(q)) {
    return 'inventory_turnover_rate';
  }
  if (/\bdays\s+of\s+inventory\s+remaining\b|\bdays\s+of\s+stock\s+remaining\b/.test(q)) {
    return 'days_of_inventory_remaining';
  }
  if (/^inventory\s+status\b|\binventory\s+overview\b|\bcurrent\s+inventory\s+status\b/.test(q)) {
    return 'data_coverage_all';   // inventory + product coverage; existing intent
  }

  // --- Comparisons -------------------------------------------------------
  if (/\bweek[- ]?over[- ]?week\s+comparison\b|\bweek[- ]?over[- ]?week\b(?!.*\bby\s)/.test(q)) {
    return 'week_over_week';
  }
  if (/\byear[- ]?over[- ]?year(?:\s+growth)?\b|\byoy\b/.test(q)) {
    return 'year_over_year';
  }
  // "revenue vs last month" / "this month vs last month" stays on period_over_period

  // --- "How many SKUs do we have" → existing inventory_count_in_stock alias
  if (/\bhow\s+many\s+skus?\s+(?:do\s+we\s+have|are\s+there)\b/.test(q)) {
    return 'inventory_count_in_stock';
  }
  if (/\bproduct\s+categories?\s+breakdown\b|\bcategor(?:y|ies)\s+breakdown\b/.test(q)) {
    return 'what_products_do_we_sell';
  }

  // ---- -1. Order drill-down (always wins when an order ref is present) ----
  if (ent.orderRef) {
    // "how much was order #X" / "what was the total for order #X"
    if (/\bhow\s+much\s+was\b|\btotal\s+for\s+order|\border\s+total/.test(q)) return 'order_total_lookup';
    // "who placed order #X" / "what customer placed order #X"
    if (/\bwho\s+(?:placed|bought|made|owns)\b|\bwhat\s+customer\s+placed\b|\bwhich\s+customer\b/.test(q)) return 'order_customer_lookup';
    // "was order X cancelled" / "what was the status" / "fulfilled" / "refunded"
    if (/\bcancell?ed\b|\brefunded?\b|\bstatus\s+of\b|\bfulfilled\b|\bfulfillment\s+status\b/.test(q)) return 'order_status_lookup';
    // "most expensive / cheapest item on order X"
    if (/\bmost\s+expensive\b|\bhighest[- ]?priced\b|\bcheapest\b|\bleast\s+expensive\b|\blowest[- ]?priced\b/.test(q)) return 'order_extreme_item_lookup';
    // "did order X include liquor / wine / both"
    if (/\b(?:did|does)\s+order\b.*\b(?:include|contain|have)\b/.test(q) || /\binclude\s+(?:liquor|wine|spirits?|beer)/.test(q)) return 'order_includes_category';
    // "what was on order X" / "what was in order X" / "what did they buy" / "items on order X" / "list every line item" / "break out order"
    if (/\bwhat\s+(?:was|is|did)\s+(?:on|in|they\s+buy\s+on)\b|\b(?:items?|line\s+items?|bottles?)\s+(?:on|in)\b|\bshow\s+me\s+(?:the\s+)?items?\b|\blist\s+(?:every\s+)?line\s+item|\bbreak\s+out\s+order\b|\bshow\s+me\s+(?:order|receipt|ticket)\b|\bpull\s+up\s+order\b|\bopen\s+order\b|\bcontain(?:ed)?\b/.test(q)) {
      return 'order_items_lookup';
    }
    // Default for an order-ref-bearing question: full detail.
    return 'order_detail_lookup';
  }

  // ---- -0.5 Customer comparison (always wins when a pair is detected) ----
  if (ent.customerPair) {
    return 'customer_comparison';
  }

  // ---- 00. Dashboard / executive summary (very explicit phrase) -----------
  if (/\b(?:dashboard|executive\s+summary|key\s+metrics|kpi\s+dashboard|important\s+metrics|summarize\s+(?:last|this|the))\b/.test(q)) {
    return 'dashboard_summary';
  }

  // ---- 01. Repeat / returning / first-time customers ----------------------
  // Numerator/denominator-style share questions land in *_share intents;
  // raw counts land in *_count intents.
  const isShare = ent.shareIntent || /\bwhat\s+(?:percent|percentage|share|fraction)\b/.test(q);
  if (ent.customerSegment === 'repeat' || /\b(?:repeat|returning)\s+(?:customers?|buyers?|shoppers?)\b/.test(q)) {
    return isShare ? 'repeat_customers_share' : 'repeat_customers_count';
  }
  if (ent.customerSegment === 'new' || /\b(?:first[- ]?time|new)\s+(?:customers?|buyers?|shoppers?)\b/.test(q)) {
    // "which customers are new this month" still routes to new_customers
    // (lifetime first-order), but a count/share question goes here.
    if (isShare || /^how\s+many\b/.test(q) || /\bcount\b/.test(q) || /\bcame\s+in\b/.test(q) || /\bwere\s+in\s+the\s+store\b/.test(q) || /\bbought\b.*\byesterday\b|\bbought\b.*\blast\b|\bbought\b.*\bthis\b/.test(q)) {
      return isShare ? 'new_customers_share' : 'new_customers_count';
    }
  }

  // ---- 02. Customer traffic-like counts ("how many customers came in") ---
  // Only when no segment word is present (segment cases handled above).
  if (
    /how\s+many\s+(?:distinct\s+)?customers?\s+(?:came\s+in|were\s+in\s+the\s+store|bought|purchased|placed\s+orders?|shopped(?:\s+with\s+us)?)/.test(q)
  ) {
    return 'customers_count_purchasing';
  }

  // ---- 03. Busiest hour / typical busy period -----------------------------
  if (/\b(?:what|which)\s+hour\s+(?:was|had|is)\s+(?:busiest|the\s+most|usually)/.test(q) ||
      /\bwhat\s+(?:was|is)\s+(?:our\s+)?busiest\s+hour\b/.test(q) ||
      /\bwhat\s+time\s+of\s+day\s+(?:was|is)\s+busiest\b/.test(q) ||
      /\bwhat\s+hour\s+had\s+the\s+most\s+(?:orders|sales)\b/.test(q)) {
    // Specific day if "yesterday/today/last X" → one-day busiest hour
    if (ent.timeframeLike || /\b(?:today|yesterday|last\s+\w+|this\s+\w+|on\s+\d)/.test(q)) {
      return 'busiest_hour';
    }
    return /\btypical|usually|on\s+average\b/.test(q) ? 'busiest_period_pattern' : 'busiest_hour';
  }
  if (/\btypically.*busiest|\busually.*busiest|\bbusiest\s+on\s+average\b|\bbusiest\s+.*\bon\s+average\b|\bpeak\s+(?:shopping\s+)?(?:hours?|times?)|\bbusiest\s+days?\s+and\s+times?|\bwhen\s+is\s+the\s+store\s+(?:usually\s+)?busiest|\bwhen\s+do\s+we\s+usually\s+sell\s+the\s+most|\bwhat\s+day\s+of\s+week\s+is\s+busiest\b/.test(q)) {
    return 'busiest_period_pattern';
  }

  // ---- 04. Price extremes -------------------------------------------------
  const wantsCheapest = /\b(?:cheapest|least\s+expensive|lowest[- ]?priced)\b/.test(q);
  const wantsExpensive = /\b(?:most\s+expensive|highest[- ]?priced|priciest|priciest|sold\s+for\s+the\s+most)\b/.test(q);
  const wantsBuyer    = /\b(?:who\s+(?:bought|purchased)|which\s+customer)\b/.test(q);
  if (wantsCheapest || wantsExpensive) {
    if (wantsBuyer) return wantsCheapest ? 'buyer_of_lowest_priced_item' : 'buyer_of_highest_priced_item';
    return wantsCheapest ? 'lowest_priced_item_sold' : 'highest_priced_item_sold';
  }

  // ---- 05. Share / mix percentages (non-customer-segment) -----------------
  // Overlap: "what percent of orders have BOTH X and Y" wins over generic
  // share rules because the numerator semantics differ.
  if (/\bhow\s+many\s+orders\s+have\s+both\b|\bwhat\s+(?:percent|percentage|share|fraction)\s+of\s+orders\s+(?:have|include|contain)\s+both\b|\borders\s+with\s+both\b/.test(q)) {
    return 'order_overlap_share';
  }
  if (isShare) {
    if (/\bdead\s+inventory\b/.test(q)) return 'share_of_dead_inventory_value';
    if (/\borders\s+included\b|\borders\s+containing\b|\borders\s+with\b/.test(q)) return 'share_of_orders_with_filter';
    if (/\btop\s+(\d+)\s+products?\b|\btop\s+products?\b/.test(q)) return 'share_of_revenue_top_n';
    // generic: percentage of revenue/units/sales came from <filter>
    if (/\bof\s+(?:sales|revenue|units?|orders?)\b/.test(q)) return 'share_of_sales_by_filter';
  }

  // ---- 06. Customer preference ("X buys the most of...") ------------------
  // Must fire BEFORE the haveCustomer block's customer_recent_purchases
  // (which catches "what does X buy" too broadly).
  if (ent.customer || ent.email) {
    // 6a) red-or-white / color mix
    if (/\b(?:does|do|did)\s+.+\s+(?:usually|typically|normally|mostly|mainly)?\s*(?:buy|drink|get|purchase|order|prefer)\s+(?:more\s+)?(?:red|white|sparkling|ros[eé])\b|\bred\s+or\s+white\b/.test(q)) {
      return 'customer_color_mix';
    }
    // 6b) "what regions does X buy from"
    if (/\bwhat\s+regions?\s+(?:does|do|did)\s+.+\s+(?:buy|purchase|order|prefer)/.test(q)) {
      return 'customer_top_vendors'; // region inferred from vendor; formatter notes the proxy
    }
    // 6c) "does X buy liquor / spirits / wine" — preference probe by category
    if (/\b(?:does|do|did)\s+.+\s+(?:buy|drink|get|purchase|order)\s+(?:liquor|spirits?|beer|wine|gift|gifts)/.test(q)) {
      return 'customer_top_categories';
    }
    // 6d) Taste-profile composite — "favorite X" where X is SINGULAR (one
    // vendor / one varietal / one category / one price range) is a one-row
    // single composite. Plural "favorite products" / "favorite wines" /
    // "favorites" (generic) falls through to the top_* preference dispatch.
    if (
      /\bfavorite\s+(?:vendor|producer|winery|varietal|wine|category|price\s+range|brand)\b(?!s)/.test(q) ||
      /\bwhat\s+(?:is|are)\s+.+(?:'s)?\s+favorite\s+(?:vendor|varietal|wine|category|price\s+range|brand)\b(?!s)/.test(q)
    ) {
      return 'customer_taste_profile';
    }
    // 6e) "what does X like / favorites / reorder most often / usually buy / typically purchase"
    // Also covers bare "what does X buy" (treated as taste/preference, not
    // single-order recent purchases, when the verb is present-tense "does").
    if (
      /what\s+(?:does|do|did)\s+.+\s+(?:like|likes|prefer|prefers)\b/.test(q) ||
      /what\s+(?:are|is)\s+.+(?:'s)?\s+favorites?\b/.test(q) ||
      /favorite\s+(?:products?|wines?|varietals?|vendors?|producers?|categor(?:y|ies)|brand|brands)/.test(q) ||
      /what\s+(?:does|do)\s+.+\s+(?:buy|buys|drink|drinks|reorder|reorders|order|orders|purchase|purchases|get|gets)\b/.test(q) ||
      /what\s+(?:does|do|did)\s+.+\s+(?:reorder|re-?order)\s+(?:most|the\s+most)?(?:\s+often)?/.test(q) ||
      /what\s+(?:does|do|did)\s+.+\s+(?:buy|buys|bought|purchase|purchases|purchased|order|orders|ordered)\s+(?:the\s+)?most(?:\s+of)?(?:\s+often)?/.test(q) ||
      /what\s+(?:does|do|did)\s+.+\s+(?:usually|typically|normally|mostly|mainly|generally|most\s+often)\s+(?:buy|drink|prefer|order|purchase|reorder|get)/.test(q) ||
      /what\s+(?:varietals?|vendors?|products?|categor(?:y|ies)|wine|wines|brands?|regions?|types?)\s+(?:does|do|did)\s+.+\s+(?:buy|buys|bought|purchase|purchases|purchased|like|prefer|order|orders|ordered|usually|typically|normally|mostly)/.test(q) ||
      /what\s+wines?\s+(?:does|do|did)\s+.+\s+(?:usually|typically|normally)\s+(?:buy|drink|prefer|order)/.test(q)
    ) {
      // Vendor / varietal / category / product preference selection. "Wines"
      // in this family maps to varietals because wines are the natural
      // varietal axis in this store.
      if (/\bvarietals?\b/.test(q) || /\bwines?\b/.test(q)) return 'customer_top_varietals';
      if (/\bvendors?\b/.test(q) || /\bproducers?\b/.test(q) || /\bwiner(?:y|ies)\b/.test(q) || /\bbrands?\b/.test(q)) return 'customer_top_vendors';
      if (/\bcategor(?:y|ies)\b/.test(q) || /\btypes?\b/.test(q)) return 'customer_top_categories';
      return 'customer_top_products';
    }
    // 6e) change over time: "how has X's buying changed" / "shifted from red to white" / "more sparkling lately" / "last 6 months vs prior 6"
    if (
      /\bhas\s+.+\s+(?:buying|spending|shopping)\s+changed\b|\bhow\s+has\s+.+\s+(?:buying|spending|shopping|tastes?)\b|\b(?:has|have)\s+.+\s+(?:shifted|moved|migrated)\s+from\b|\b(?:has|have)\s+.+\s+been\s+buying\s+more\s+\w+\s+lately\b|\bcompare\s+.+\s+last\s+\d+\s+months?\s+to\s+(?:the\s+)?prior\s+\d+\s+months?\b/.test(q)
    ) {
      return 'customer_change_over_time';
    }
    // 6f) per-customer time series chart / "chart X revenue by week for the last 10 weeks"
    // Also "show X units bought by week" (allows a word like "bought" between
    // the metric and "by").
    if (
      /\bchart\s+.+\s+(?:revenue|units|spend|orders?|sales|bottles)\b/.test(q) ||
      /\bshow\s+.+\s+(?:revenue|units|spend|orders?|sales|bottles)(?:\s+\w+)?\s+by\s+(?:day|week|month)\b/.test(q) ||
      /\b(?:revenue|units|spend|orders?|sales|bottles)(?:\s+\w+)?\s+by\s+(?:day|week|month)\b/.test(q) ||
      ((ent.outputMode === 'chart' || ent.chartType) && /\b(?:by|each)\s+(?:day|week|month)\b/.test(q))
    ) {
      return 'customer_time_series';
    }
  }

  // ---- 07. Customer frequency / cadence -----------------------------------
  if (ent.customer || ent.email) {
    if (/\bhow\s+often\s+(?:does|do)\s+.+\s+(?:shop|order|buy|purchase)|\baverage\s+time\s+between\s+orders|\bcadence\b/.test(q)) {
      return 'customer_frequency_profile';
    }
  }
  if (/\bwhich\s+customers\s+shop\s+(?:most\s+)?frequently|who\s+shops\s+(?:with\s+us\s+)?the\s+most\s+often|who\s+orders\s+most\s+often|which\s+customers\s+buy\s+(?:weekly|monthly)/.test(q)) {
    return 'top_customers_by_order_count';
  }
  if (/\b(?:has\s+not|haven'?t)\s+shopped\s+in\s+a\s+while\s+that\s+previously\s+came\s+in\s+frequently|\bused\s+to\s+buy\s+often\s+but\s+(?:has|have)?\s*stopped|\blapsed\s+frequent\s+customers?|\bregulars?\s+but\s+(?:has|have)\s+gone\s+quiet|\bpreviously\s+active\s+customers?\s+(?:that|who)\s+have\s+not\s+purchased\s+recently|\bloyal\s+customers?\s+(?:that|who)\s+have\s+dropped\s+off|\btop\s+customers?\s+(?:that|who)\s+have\s+not\s+purchased\s+in\s+\d+\s+days/.test(q)) {
    return 'lapsed_frequent_customers';
  }
  if (/\bcustomers?\s+(?:that\s+|who\s+)?came\s+back\s+after\s+being\s+inactive|reactivation\s+candidates?/.test(q)) {
    return 'customer_reactivation_candidates';
  }

  // ---- 08. Type / category breakdown (storewide) --------------------------
  // "what type sold the most" / "show me units by type/category" / "top varietals"
  if (/\bwhat\s+(?:type|category)\s+(?:of\s+product\s+)?sold\s+the\s+most|\bwhich\s+(?:product\s+)?(?:type|category)\s+sold\s+the\s+most|\bwhat\s+types?\s+sold\b/.test(q)) {
    return 'type_top_seller';
  }
  if (/\bshow\s+me\s+(?:how\s+many\s+)?units\s+(?:of\s+each\s+type|by\s+(?:type|category))|\bunits\s+sold\s+by\s+(?:type|category)|\bbreak\s+out\s+.+\s+by\s+(?:type|category|vendor)|\bshow\s+me\s+.+\s+by\s+(?:type|category|vendor)\s+in\s+a\s+table|\btable\s+of\s+units\s+sold\s+by\s+(?:type|category)/.test(q)) {
    return 'type_breakdown';
  }
  if (/\b(?:top|best[- ]?selling)\s+\d*\s*varietals?\b|\bvarietal\s+ranking|\bwhich\s+varietals?\s+sold\s+the\s+most|\btop\s+\d+\s+varietals?\b|\bbest\s+varietals?\b/.test(q)) {
    return 'varietal_ranking';
  }

  // ---- 0. Meta / data-coverage questions ----------------------------------
  // These fire before everything else because their phrasing is unambiguous.
  if (
    /\b(?:what\s+(?:date\s+range|dates?|period)\s+(?:does|do|is|are)\s+(?:the\s+order\s+(?:data|records)|covered\s+in\s+the\s+order\s+(?:data|records)))/.test(q) ||
    /\b(?:what\s+(?:date\s+range|dates?|period)\s+is\s+covered\s+in\s+the\s+order\s+(?:data|records))/.test(q) ||
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
    // "how many units/bottles are in the store / on hand / in inventory / in stock"
    /\bhow\s+many\s+(?:units?|bottles?|items?|cases?)\s+are\s+(?:in\s+(?:the\s+)?store|in\s+inventory|on\s+hand|in\s+stock|currently\s+in\s+stock|currently)\b/.test(q) ||
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
    // "show me X's last order" / "what was on X's last order" / "last N orders"
    if (
      /\b(?:show\s+me\s+|what\s+(?:was|is)\s+(?:on|in)\s+|what\s+did\s+.+\s+(?:buy|order)\s+(?:on|in)\s+)?.+(?:'s)?\s+last\s+order\b/.test(q) ||
      /\b(?:last|biggest|largest|highest[- ]?value|smallest)\s+order(?:\s+from)?\b/.test(q) && /\b(?:show|what|give)\b/.test(q)
    ) {
      return 'customer_last_order_items';
    }
    if (/\b(?:show\s+me\s+|what\s+(?:were|are)\s+)?.+(?:'s)?\s+last\s+\d+\s+orders\b/.test(q) ||
        /\b(?:show|list)\s+.+\s+(?:last|recent)\s+\d+\s+orders\b/.test(q)) {
      return 'customer_last_n_orders';
    }
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
  // *Explicit* order-count phrasings beat the broader "top customers" rule.
  if (
    /(?:rank|top)\s+customers?\s+(?:by|with\s+the\s+most)\s+(?:order\s+count|orders?|frequency)|top\s+\d+\s+customers?\s+by\s+order\s+count|which\s+customers?\s+(?:buy|shop)\s+(?:the\s+)?most\s+often|most\s+frequent\s+customers?|recurring\s+customers?|strongest\s+recurring|which\s+customers?\s+placed\s+the\s+most\s+orders|who\s+(?:orders|ordered|shops|shopped)\s+(?:the\s+)?most\s+often/.test(q)
  ) {
    return 'top_customers_by_order_count';
  }
  if (/highest\s+average\s+order\s+value|highest\s+aov|biggest\s+spenders\s+per\s+order/.test(q)) {
    return 'top_customers_by_aov';
  }
  // Lapsed-frequent customers must fire BEFORE generic "top customers" so
  // "which top customers have not purchased in 60 days" doesn't get eaten.
  if (/\b(?:has\s+not|haven'?t)\s+shopped\s+in\s+a\s+while\s+that\s+previously\s+came\s+in\s+frequently|\bused\s+to\s+buy\s+often\s+but\s+(?:has|have)?\s*stopped|\blapsed\s+frequent\s+customers?|\bregulars?\s+but\s+(?:has|have)\s+gone\s+quiet|\bpreviously\s+active\s+customers?\s+(?:that|who)\s+have\s+not\s+purchased\s+recently|\bloyal\s+customers?\s+(?:that|who)\s+have\s+dropped\s+off|\b(?:top\s+|loyal\s+|previously\s+(?:active\s+|frequent\s+)?)customers?\s+(?:that|who)?\s*have\s+not\s+purchased\s+in\s+\d+\s+days/.test(q)) {
    return 'lapsed_frequent_customers';
  }
  if (/(top|biggest|highest|best).*(spend|customer|buyer|spender)/.test(q) ||
      /who\s+(?:spends|spent|buys|purchases|purchased|bought|drinks?|drank)\s+(?:the\s+)?most/.test(q) ||
      /which\s+customers?\s+(?:spend|spent|buy|bought|drink|drank)\s+(?:the\s+)?most/.test(q) ||
      /which\s+customers?\s+buy\s+mostly/.test(q) ||
      /which\s+customer\s+spent\s+the\s+most/.test(q) ||
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
    /what sells together|sold together|bought together|buy together|purchased together|commonly sold together|commonly bought together|most commonly sold together|basket pairs|market basket|affinity|wines? (?:are )?usually bought together|skus? (?:are )?usually bought together|items?\s+sell\s+together\s+the\s+most|products?\s+sell\s+together\s+the\s+most|products?\s+are\s+bought\s+together\s+the\s+most|items?\s+(?:are\s+)?most\s+commonly\s+bought\s+together|products?\s+pair\s+together\s+(?:most\s+)?often/.test(q)
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
  if (
    /period[- ]over[- ]period|vs\s+(?:last|previous)\s+(?:week|month|quarter|year|day)|compared?\s+to\s+(?:last|previous|the\s+prior|the\s+week\s+before|the\s+month\s+before|the\s+quarter\s+before|the\s+year\s+before|week\s+of\b|month\s+of\b)|\bcompare\s+(?:last|this|sales|revenue|week\s+of|month\s+of)\b.*\b(?:to|vs|versus|with)\s+(?:the\s+(?:week|month|quarter|year)\s+before|the\s+prior|last|previous|week\s+of|month\s+of)|this\s+(?:week|month|quarter|year)\s+(?:compared|vs)\s+(?:last|previous)|sales\s+yesterday\s+compared\s+to\s+the\s+prior\s+day|what\s+(?:improved|declined)\s+(?:this|last)\s+(?:week|month|quarter|year)\s+versus|how\s+did\s+(?:last|this|week\s+of\s+\S+)\s+(?:week|month|quarter|year)?\s*compare(?:d)?\s+(?:to|with)\s+(?:the\s+)?(?:week|month|quarter|year|week\s+of)|was\s+last\s+(?:week|month|quarter|year)\s+better\s+than\s+the\s+(?:week|month|quarter|year)\s+before|how\s+were\s+sales\s+last\s+\w+\s+versus|how\s+did\s+we\s+do\s+last\s+\w+\s+compared\s+with|compare\s+sales\s+this\s+\w+\s+vs/.test(q)
  ) {
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
  // Tightened: require "recent orders" OR a strong "show me orders" form so
  // questions like "which customers placed the most orders last month" don't
  // get eaten.
  if (/\brecent\s+orders?\b|\bshow\s+me\s+(?:recent\s+)?orders?\b|\bwhat\s+orders\s+came\s+in\b|\borders\s+(?:from\s+)?(?:yesterday|today)\b/.test(q)) {
    return 'recent_orders';
  }
  // Storewide sales / revenue / units / orders / aov questions.
  // We deliberately fire LAST so customer / product / vendor scopes win
  // when their entity hints are present.
  if (
    // "how much (did|have|has) we sell" — optionally with a noun between
    // ("how much liquor did we sell").
    /how\s+much\s+(?:[a-z][a-z\- ]{0,30}\s+)?(?:did|have|has)\s+we\s+(?:sell|sold|make|made)/.test(q) ||
    /what\s+(?:did|do)\s+we\s+do\b/.test(q) ||
    // "what were liquor/spirit/beer/gift sales last week" / "what were total
    // sales / net sales / store sales / revenue last week"
    /what\s+(?:were|was|is)\s+(?:our\s+)?(?:[a-z][a-z\- ]{0,30}\s+)?(?:total\s+sales|net\s+sales|revenue|store\s+sales|total\s+revenue|sales)\b/.test(q) ||
    /^(?:total\s+)?(?:store\s+)?sales\b/.test(q) ||
    /\b(?:month|quarter|year)[- ]to[- ]date\s+(?:sales|revenue)\b/.test(q) ||
    /^(?:total\s+)?revenue\b/.test(q) ||
    /\bnet\s+sales\b/.test(q) ||
    /\btotal\s+sales\b/.test(q) ||
    // "how many <noun?> units/items/bottles/cases did we sell"
    /how\s+many\s+(?:[a-z][a-z\- ]{0,30}\s+)?(?:units?|items?|bottles?|cases?)\s+did\s+we\s+sell/.test(q) ||
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

  // Fallback: anchored timeframe + the bare word "sales" → storewide summary.
  // e.g. "week of June 7 2026 sales", "sales 2026-01-25"
  if (/\bsales?\b/.test(q) && /\bweek\s+of\b|\bon\s+\d|\d{4}-\d{2}-\d{2}|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/.test(q)) {
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
    outputMode: ent.outputMode,           // 'chart' | 'table' | null
    chartType: ent.chartType,             // 'bar' | 'line' | 'pie' | 'donut' | 'stacked_bar' | null
    customerSegment: ent.customerSegment, // 'repeat' | 'new' | null
    shareIntent: ent.shareIntent,         // boolean
    orderRef: ent.orderRef,               // { id, name, raw } | null
    customerPair: ent.customerPair,       // { left, right } | null
    scope: deriveScope(intent, ent),
  };

  // Order-extreme direction (high vs low) for order_extreme_item_lookup.
  if (/\bcheapest|\bleast\s+expensive|\blowest[- ]?priced\b/.test(q)) {
    params.extremeDirection = 'low';
  } else if (/\bmost\s+expensive|\bhighest[- ]?priced\b|\bpriciest\b/.test(q)) {
    params.extremeDirection = 'high';
  }

  // Categories for order_includes_category / order_overlap_share.
  if (intent === 'order_includes_category' || intent === 'order_overlap_share') {
    const cats = [];
    if (/\bliquor|\bspirits?\b|\bhard\s+alcohol\b/.test(q)) cats.push('liquor');
    if (/\bwine|\bwines\b/.test(q)) cats.push('wine');
    if (/\bbeer|\bciders?\b/.test(q)) cats.push('beer');
    if (/\bgift|\bgifts\b/.test(q)) cats.push('gift');
    if (/\bmixers?\b|\btonic\b/.test(q)) cats.push('mixer');
    if (cats.length) {
      if (intent === 'order_overlap_share') params.overlapFilters = cats;
      else params.includeCategories = cats;
    }
  }

  // If user said "vendor decline" we route via vendor_decline intent; planner
  // adds sort='asc' on the same builder.
  if (intent === 'vendor_decline') {
    params.sort = 'asc';
  }

  // --- v6: rewrite virtual aliases into real intents + params ------------
  const aliasMap = {
    capability_unsupported_conversion_rate:    { intent: 'capability_unsupported', set: { unsupportedKey: 'conversion_rate' } },
    capability_unsupported_abandoned_cart_rate:{ intent: 'capability_unsupported', set: { unsupportedKey: 'abandoned_cart_rate' } },
    capability_unsupported_email:              { intent: 'capability_unsupported', set: { unsupportedKey: 'email_campaign_performance' } },
    capability_unsupported_traffic_sources:    { intent: 'capability_unsupported', set: { unsupportedKey: 'traffic_sources' } },
    orders_paid_credit:                        { intent: 'orders_by_gateway',      set: { gatewayPattern: '%credit%' } },
    orders_paid_paypal:                        { intent: 'orders_by_gateway',      set: { gatewayPattern: '%paypal%' } },
    orders_by_tag_wholesale:                   { intent: 'orders_by_tag',          set: { tagHint: 'wholesale' } },
    orders_by_tag_retail:                      { intent: 'orders_by_tag',          set: { tagHint: 'retail' } },
    orders_by_shipping_title_sameday:          { intent: 'orders_by_shipping_title', set: { shippingTitlePattern: '%same%day%' } },
    orders_by_shipping_title_express:          { intent: 'orders_by_shipping_title', set: { shippingTitlePattern: '%express%' } },
    orders_by_shipping_title_pickup:           { intent: 'orders_by_shipping_title', set: { shippingTitlePattern: '%pick%up%' } },
    orders_by_shipping_title_localdelivery:    { intent: 'orders_by_shipping_title', set: { shippingTitlePattern: '%local%deliver%' } },
  };
  if (aliasMap[intent]) {
    const mapped = aliasMap[intent];
    intent = mapped.intent;
    Object.assign(params, mapped.set);
  }

  // Extract shipping-state hint from "orders shipped to <STATE>".
  if (intent === 'orders_shipped_to_state') {
    const m = q.match(/\borders?\s+shipped\s+to\s+([a-z]{2,})\b/);
    if (m) params.shippingStateHint = m[1].toUpperCase();
  }
  // Extract tag from "orders tagged X" / "orders tagged with X".
  if (intent === 'orders_by_tag' && !params.tagHint) {
    const m = q.match(/\borders?\s+tagged\s+(?:with\s+)?["']?([\w][\w\- ]+?)["']?(?:\s|$|[?.,!])/);
    if (m) params.tagHint = m[1].trim();
  }
  // Extract "orders placed after Npm" → after-hour.
  if (intent === 'orders_after_hour') {
    const m = q.match(/\bafter\s+(\d{1,2})\s*(am|pm)?\b/);
    if (m) {
      let h = parseInt(m[1], 10);
      const period = (m[2] || '').toLowerCase();
      if (period === 'pm' && h < 12) h += 12;
      if (period === 'am' && h === 12) h = 0;
      params.afterHour = h;
    } else {
      params.afterHour = 17; // default
    }
  }
  // Money threshold for "orders over $N" / "customers spent over $N".
  if ((intent === 'orders_above' || intent === 'customers_with_orders_above') && !params.money) {
    const m = q.match(/(?:over|above|more\s+than|greater\s+than)\s+\$?(\d+)/);
    if (m) params.money = { op: '>', value: parseInt(m[1], 10) };
  }

  return { intent, params };
}

module.exports = {
  parse,
  classifyIntent,
};
