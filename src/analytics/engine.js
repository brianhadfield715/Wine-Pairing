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

const HELP_TEXT = [
  'I can answer broad questions about Harvest Wine Market sales, customers, and inventory. Try:',
  '· "Top items sold yesterday" / "Best sellers last week"',
  '· "How much did John Smith spend last month?" / "all time"',
  '· "What did Terry White buy in the last 30 days?"',
  '· "Top customers by spend" / "Who bought the most chardonnay this quarter?"',
  '· "What sells together" / "What is often bought with <product>?"',
  '· "Low stock high velocity" / "Dead inventory" / "Runout risk"',
  '· "Top vendors this quarter" / "Vendor growth" / "Period over period"',
].join('\n');

function helpResponse(question, intent = 'general_help') {
  return {
    question,
    intent,
    domain: 'meta',
    answer: HELP_TEXT,
    data: registry.listIntents(),
    meta: { status: 'help' },
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
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: disambiguationAnswer(r.hint, r.candidates),
          data: r.candidates,
          meta: { status: 'disambiguation', resolution: { customer: r } },
        };
      }
      if (r.status === 'not_found') {
        return {
          question,
          intent: parsed.intent,
          domain: entry.domain,
          answer: parsed.params.customerHint
            ? `No customer found matching "${parsed.params.customerHint}". Try the exact email, or a fuller name.`
            : 'I need a customer name or email to answer that.',
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

  return {
    question,
    intent: parsed.intent,
    domain: (buildResult.meta && buildResult.meta.domain) || entry.domain,
    answer: format(parsed.intent, rows, plan),
    data: rows,
    meta: {
      status: 'ok',
      row_count: rows.length,
      elapsed_ms,
      timeframe: parsed.params.timeframe,
      scope: parsed.params.scope || null,
      params: {
        days:           parsed.params.days,
        day_count:      parsed.params.dayCount || null,
        lapsed_days:    parsed.params.lapsedDays || null,
        limit:          parsed.params.limit,
        metric:         parsed.params.metric,
        color:          parsed.params.color || null,
        vendor:         parsed.params.vendor || null,
        sku:            parsed.params.sku || null,
        varietal:       parsed.params.varietal || null,
        category:       parsed.params.category || null,
        money:          parsed.params.money || null,
        units_below:    parsed.params.unitsBelow || null,
        customer_hint:  parsed.params.customerHint || null,
        email_hint:     parsed.params.email || null,
        product_hint:   parsed.params.productHint || null,
        two_varietals:  parsed.params.twoVarietals || null,
      },
      resolved: plan.resolved,
    },
  };
}

module.exports = { answer };
