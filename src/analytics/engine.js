// src/analytics/engine.js
// Orchestrator:
//   question
//     -> intentParser.parse        (intent + entity hints + timeframe)
//     -> registry.get(intent)
//     -> if needsCustomer: resolver.resolveCustomer
//          - status='ambiguous'  -> disambiguation response (no SQL)
//          - status='not_found'  -> not-found response       (no SQL)
//          - status='ok'         -> attach to plan and continue
//     -> if needsProduct: resolver.resolveProduct (same UX)
//     -> builder(plan)             (parameterized SQL)
//     -> db.query
//     -> formatter(intent, rows, plan)
//
// Response shape:
//   {
//     question,
//     intent, domain,
//     answer, data,
//     meta: { row_count, elapsed_ms, params, timeframe, resolved, status }
//   }
//
// `status` is one of:
//   'ok' | 'disambiguation' | 'not_found' | 'help' | 'error'

const db = require('../db');
const { parse } = require('./intentParser');
const registry = require('./queryRegistry');
const { format, money, intish } = require('./formatters');
const resolver = require('./resolver');
const visualizations = require('./visualizations');

const HELP_HEADER = "I don't recognize that question yet. The closest things I can answer right now are:";

// Lightweight keyword → intent suggestion lookup for the "closest matches"
// help response. We don't ship full vector search; this is a focused mapping
// from common nouns/verbs to canonical intents.
const SUGGEST_KEYWORDS = [
  // sales
  { kw: ['revenue','sales','sold','sell','sale'], suggestions: ['sales_summary','sales_time_series','period_over_period','dashboard_summary'] },
  { kw: ['top','best','most'],                    suggestions: ['top_items_by_units','top_items_by_revenue','top_customers_by_spend','top_vendors'] },
  // orders status / fulfillment
  { kw: ['status','statuses','fulfilled','pending','cancelled','refund','refunded','canceled','draft','archived'],
                                                  suggestions: ['order_status_breakdown','fulfillment_status_breakdown','orders_pending_fulfillment','refunded_orders_count','cancelled_orders_count'] },
  // shipping
  { kw: ['shipping','ship','shipped','delivery','pickup'],
                                                  suggestions: ['shipping_method_breakdown','orders_shipped_to_state','avg_fulfillment_time','free_shipping_orders'] },
  // discounts / refunds
  { kw: ['discount','discounts','coupon','code','refund','refunds'],
                                                  suggestions: ['total_discounts_given','top_discount_codes','coupon_usage_rate','refund_rate_and_avg','products_with_most_returns'] },
  // taxes
  { kw: ['tax','taxes'],                          suggestions: ['total_taxes_collected'] },
  // payment
  { kw: ['payment','paid','paypal','credit','gateway'],
                                                  suggestions: ['payment_method_breakdown','orders_by_gateway'] },
  // customer
  { kw: ['customer','customers','buyer','ltv','lifetime','frequency','repeat','returning','churned','lapsed'],
                                                  suggestions: ['avg_customer_ltv','customer_order_frequency','repeat_customer_rate','customers_with_no_orders','lapsed_customers','customers_with_orders_above'] },
  // products / inventory
  { kw: ['product','products','sku','skus','inventory','stock','catalog','category','categories'],
                                                  suggestions: ['what_products_do_we_sell','inventory_count_in_stock','inventory_value_total','dead_inventory','newest_products_added'] },
  // time series / dashboard
  { kw: ['busiest','hour','day','peak'],          suggestions: ['busiest_hour','busiest_period_pattern','weekday_vs_weekend'] },
  { kw: ['compare','vs','versus','growth'],       suggestions: ['period_over_period','week_over_week','year_over_year','vendor_growth'] },
];

function buildClosestMatches(question) {
  const q = String(question || '').toLowerCase();
  const scores = new Map();
  for (const entry of SUGGEST_KEYWORDS) {
    for (const k of entry.kw) {
      if (q.includes(k)) {
        for (const s of entry.suggestions) {
          scores.set(s, (scores.get(s) || 0) + 1);
        }
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
  return ranked;
}

function describeIntent(name) {
  const e = registry.get(name);
  return e ? `· ${name} — ${e.describe}` : `· ${name}`;
}

function helpResponse(question, intent = 'general_help') {
  const closest = buildClosestMatches(question);
  let answer;
  if (closest.length) {
    answer = HELP_HEADER + '\n' + closest.map(describeIntent).join('\n') +
      '\n\n(Phrase your question one of these ways, or ask me to add the metric if it isn\'t here.)';
  } else {
    answer = [
      "I don't recognize that question yet. Some things I can answer:",
      '· sales / revenue / units / orders for any timeframe',
      '· order detail by # (e.g. "what was on order #37857")',
      '· customer spend / LTV / order frequency / preferences',
      '· repeat customer rate / new customer count',
      '· top items / vendors / varietals / categories',
      '· inventory value / counts / dead inventory / runout risk',
      '· discounts / refunds / shipping / fulfillment breakdowns',
      '· week-over-week / year-over-year comparisons',
    ].join('\n');
  }
  return {
    question,
    intent,
    domain: 'meta',
    answer,
    data: closest.map((name) => ({ name, describe: (registry.get(name) || {}).describe || '' })),
    meta: { status: 'help', suggestions: closest },
  };
}

function disambiguationAnswer(hint, candidates) {
  const lines = candidates.map((c, i) =>
    `${i + 1}. ${c.customer_name || c.email} — ${c.email || ''}${c.total_spent ? ` · lifetime ${money(c.total_spent)}` : ''}`
  );
  return `Multiple customers match "${hint}". Please pick one by email:\n${lines.join('\n')}`;
}

async function answer(question) {
  const parsed = parse(question);
  const entry = registry.get(parsed.intent);
  const plan = {
    intent: parsed.intent,
    domain: entry ? entry.domain : 'unknown',
    timeframe: parsed.params.timeframe,
    params: parsed.params,
    resolved: {},
  };

  // Special-case: temporal parser flagged an invalid explicit date literal.
  if (parsed.intent === 'invalid_date') {
    const label = parsed.params.timeframe && parsed.params.timeframe.label;
    return {
      question,
      intent: 'invalid_date',
      domain: 'meta',
      answer: `That date doesn't look valid${label ? ` (${label})` : ''}. Try MM/DD/YYYY, YYYY-MM-DD, or a named-month form like "January 25, 2026".`,
      data: [],
      meta: { status: 'error', error: 'invalid_date', timeframe: parsed.params.timeframe || null },
    };
  }

  if (!entry) {
    return helpResponse(question, 'general_help');
  }

  // ---- Entity resolution (only when builder needs it) ---------------------
  if (entry.needsCustomer) {
    try {
      const r = await resolver.resolveCustomer({
        customer: parsed.params.customerHint,
        email: parsed.params.email,
      });
      if (r.status === 'ambiguous') {
        // Auto-pick when the top-2 candidates have meaningfully different
        // activity (one clearly more active). This handles the
        // "two Brian Hadfields" case where one is the personal account and
        // the other is a wine club / system account. We pick by orders_count
        // descending, with total_spent as tiebreaker.
        const sorted = (r.candidates || []).slice().sort((a, b) => {
          const ao = Number(a.orders_count || 0);
          const bo = Number(b.orders_count || 0);
          if (bo !== ao) return bo - ao;
          return Number(b.total_spent || 0) - Number(a.total_spent || 0);
        });
        const top = sorted[0];
        const runnerUp = sorted[1];
        const topOrders = Number(top && top.orders_count || 0);
        const runnerOrders = Number(runnerUp && runnerUp.orders_count || 0);
        // Auto-pick when the top candidate has ≥2x the runner-up's orders
        // (clear preference). Otherwise stay with the disambiguation prompt
        // so the user picks.
        const shouldAutoPick = top && runnerUp && topOrders >= 3 && topOrders >= 2 * runnerOrders;
        if (shouldAutoPick) {
          plan.resolved.customer = top;
          plan.resolved.customerNote =
            `(showing the account with ${topOrders} orders; there is also a ${runnerOrders}-order account under the same name — ask by email if you meant the other one)`;
          // Fall through to query execution.
        } else {
          return {
            question,
            intent: parsed.intent,
            domain: entry.domain,
            answer: disambiguationAnswer(r.hint, r.candidates),
            data: r.candidates,
            meta: { status: 'disambiguation', resolution: { customer: r } },
          };
        }
      }
      if (r.status === 'not_found') {
        // Bug A: if an email was provided but didn't match, say so clearly
        // instead of falling back to "I need a customer name or email".
        let msg;
        if (parsed.params.email) {
          msg = `No customer found matching email "${parsed.params.email}". Double-check the address, or try the customer's name.`;
        } else if (parsed.params.customerHint) {
          msg = `No customer found matching "${parsed.params.customerHint}". Try the exact email, or a fuller name.`;
        } else {
          msg = 'I need a customer name or email to answer that.';
        }
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: msg,
          data: [],
          meta: { status: 'not_found', resolution: { customer: r } },
        };
      }
      plan.resolved.customer = r.customer;
    } catch (e) {
      return {
        question,
        intent: parsed.intent,
        domain: entry.domain,
        answer: `Customer lookup failed: ${e.message}`,
        data: [],
        meta: { status: 'error', error: e.message },
      };
    }
  }

  if (entry.needsProductSearch) {
    // Stronger product resolution: tries SKU, exact title, starts-with,
    // contains; returns disambiguation candidates with enough detail to
    // pick (SKU / vendor / inventory / price).
    try {
      const r = await resolver.resolveProductByHint({
        productHint: parsed.params.productHint,
        sku: parsed.params.sku,
      });
      if (r.status === 'ambiguous') {
        const lines = r.candidates.map((c, i) =>
          `${i + 1}. ${c.product_title}${c.primary_sku ? ' · ' + c.primary_sku : ''}${c.vendor ? ' · ' + c.vendor : ''}${c.on_hand_total != null ? ' · on hand ' + c.on_hand_total : ''}${c.min_price ? ' · $' + Number(c.min_price).toFixed(2) : ''}`
        );
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: `Multiple products match "${r.hint}":\n${lines.join('\n')}`,
          data: r.candidates,
          meta: { status: 'disambiguation', resolution: { product: r } },
        };
      }
      if (r.status === 'not_found') {
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: `No product found matching "${parsed.params.productHint || parsed.params.sku || '(none)'}".`,
          data: [],
          meta: { status: 'not_found', resolution: { product: r } },
        };
      }
      plan.resolved.product = r.product;
    } catch (e) {
      return {
        question,
        intent: parsed.intent,
        domain: entry.domain,
        answer: `Product lookup failed: ${e.message}`,
        data: [],
        meta: { status: 'error', error: e.message },
      };
    }
  }

  if (entry.needsOrder) {
    try {
      const ref = parsed.params.orderRef;
      const r = await resolver.resolveOrder({ name: ref && ref.name, id: ref && ref.id });
      if (r.status === 'not_found') {
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: `No order found matching "${(ref && (ref.name || ref.raw)) || '(none)'}".`,
          data: [],
          meta: { status: 'not_found', resolution: { order: r } },
        };
      }
      plan.resolved.order = r.order;
    } catch (e) {
      return {
        question,
        intent: parsed.intent,
        domain: entry.domain,
        answer: `Order lookup failed: ${e.message}`,
        data: [],
        meta: { status: 'error', error: e.message },
      };
    }
  }

  if (entry.needsCustomerPair) {
    try {
      const pair = parsed.params.customerPair;
      if (!pair) {
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: 'I need two customer names to compare (e.g., "compare Brian Hadfield with Chelsey Hadfield").',
          data: [],
          meta: { status: 'not_found' },
        };
      }
      const [a, b] = await Promise.all([
        resolver.resolveCustomer({ customer: pair.left,  email: null }),
        resolver.resolveCustomer({ customer: pair.right, email: null }),
      ]);
      const partial = [];
      if (a.status !== 'ok') partial.push({ side: 'left',  hint: pair.left,  result: a });
      if (b.status !== 'ok') partial.push({ side: 'right', hint: pair.right, result: b });
      if (partial.length) {
        // Compose a single message describing each side.
        const lines = partial.map((p) => {
          if (p.result.status === 'ambiguous') {
            const opts = p.result.candidates.slice(0, 5).map((c) => `${c.customer_name || c.email}`).join(', ');
            return `${p.side === 'left' ? 'Left' : 'Right'} side "${p.hint}" is ambiguous: ${opts}`;
          }
          return `${p.side === 'left' ? 'Left' : 'Right'} side "${p.hint}" not found.`;
        });
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: lines.join('\n'),
          data: partial,
          meta: { status: partial.some((p) => p.result.status === 'ambiguous') ? 'disambiguation' : 'not_found', resolution: { customerPair: partial } },
        };
      }
      plan.resolved.customerPair = { left: a.customer, right: b.customer };
    } catch (e) {
      return {
        question,
        intent: parsed.intent,
        domain: entry.domain,
        answer: `Customer-pair lookup failed: ${e.message}`,
        data: [],
        meta: { status: 'error', error: e.message },
      };
    }
  }

  if (entry.needsProduct) {
    try {
      const r = await resolver.resolveProduct({
        productHint: parsed.params.productHint,
        sku: parsed.params.sku,
      });
      if (r.status === 'ambiguous') {
        const lines = r.candidates.map((c, i) => `${i + 1}. ${c.product_title} (${c.handle})`);
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: `Multiple products match "${r.hint}":\n${lines.join('\n')}`,
          data: r.candidates,
          meta: { status: 'disambiguation', resolution: { product: r } },
        };
      }
      if (r.status === 'not_found') {
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: `No product found matching "${parsed.params.productHint || parsed.params.sku || '(none)'}".`,
          data: [],
          meta: { status: 'not_found', resolution: { product: r } },
        };
      }
      plan.resolved.product = r.product;
    } catch (e) {
      return {
        question,
        intent: parsed.intent,
        domain: entry.domain,
        answer: `Product lookup failed: ${e.message}`,
        data: [],
        meta: { status: 'error', error: e.message },
      };
    }
  }

  // ---- Build + run SQL ----------------------------------------------------
  let buildResult;
  try {
    buildResult = entry.builder({ ...parsed.params, resolved: plan.resolved });
  } catch (e) {
    return {
      question,
      intent: parsed.intent,
      domain: entry.domain,
      answer: `Query build failed: ${e.message}`,
      data: [],
      meta: { status: 'error', error: e.message },
    };
  }

  const t0 = Date.now();
  let result;
  try {
    result = await db.query(buildResult.text, buildResult.values);
  } catch (e) {
    return {
      question,
      intent: parsed.intent,
      domain: entry.domain,
      answer: `Analytics query failed: ${e.message}`,
      data: [],
      meta: { status: 'error', error: e.message },
    };
  }
  const elapsed_ms = Date.now() - t0;
  const rows = result.rows || [];

  // Build a visualization spec when the intent is inherently visual OR the
  // user explicitly asked for a chart/table.
  let visualization = null;
  try {
    visualization = visualizations.build(parsed.intent, rows, plan);
  } catch (e) {
    // Visualization failure should never break the JSON response.
    console.error('[engine] visualization build failed:', e.message);
  }

  // For chart/table-requested outputs, signal the output mode in meta.
  const outputMode = (visualization && visualization.output_mode) || 'text';

  return {
    question,
    intent: parsed.intent,
    domain: (buildResult.meta && buildResult.meta.domain) || entry.domain,
    answer: (() => {
      const a = format(parsed.intent, rows, plan);
      const note = plan && plan.resolved && plan.resolved.customerNote;
      return note ? `${a}\n${note}` : a;
    })(),
    data: rows,
    visualization,
    meta: {
      status: 'ok',
      row_count: rows.length,
      elapsed_ms,
      timeframe: parsed.params.timeframe,
      scope: parsed.params.scope || null,
      output_mode: outputMode,
      chart_type: (visualization && visualization.chart_type) || null,
      params: {
        days:             parsed.params.days,
        day_count:        parsed.params.dayCount || null,
        lapsed_days:      parsed.params.lapsedDays || null,
        limit:            parsed.params.limit,
        metric:           parsed.params.metric,
        grain:            parsed.params.grain || null,
        color:            parsed.params.color || null,
        vendor:           parsed.params.vendor || null,
        sku:              parsed.params.sku || null,
        varietal:         parsed.params.varietal || null,
        category:         parsed.params.category || null,
        money:            parsed.params.money || null,
        units_below:      parsed.params.unitsBelow || null,
        customer_hint:    parsed.params.customerHint || null,
        email_hint:       parsed.params.email || null,
        product_hint:     parsed.params.productHint || null,
        two_varietals:    parsed.params.twoVarietals || null,
        customer_segment: parsed.params.customerSegment || null,
        share_intent:     !!parsed.params.shareIntent || null,
        output_mode:      parsed.params.outputMode || null,
        chart_type:       parsed.params.chartType || null,
      },
      resolved: plan.resolved,
    },
  };
}

module.exports = { answer };
