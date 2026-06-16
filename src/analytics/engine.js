// src/analytics/engine.js
// High-level orchestrator: question -> intent -> SQL -> rows -> answer.

const db = require('../db');
const { parse } = require('./intentParser');
const registry = require('./queryRegistry');
const { format } = require('./formatters');

/**
 * Answer a free-form manager question against the analytics DB.
 *
 * @param {string} question
 * @returns {Promise<{answer:string,data:Array,intent:string,domain:string,query?:object}>}
 */
async function answer(question) {
  const parsed = parse(question);

  // Help / fallback intent: never executes SQL, just describes what we can do.
  if (parsed.intent === 'general_help' || !registry.get(parsed.intent)) {
    return {
      question,
      intent: 'general_help',
      domain: 'meta',
      answer:
        'I can answer broad questions about Harvest Wine Market sales, customers, and inventory. Try: "top customers by spend", "best selling wines last 30 days", "what sells together", "dead inventory", "low stock high velocity", "customers who bought chardonnay", "vendor performance last quarter".',
      data: registry.listIntents(),
    };
  }

  const entry = registry.get(parsed.intent);
  const { text, values, meta } = entry.builder(parsed.params);
  const t0 = Date.now();
  const result = await db.query(text, values);
  const elapsedMs = Date.now() - t0;

  const rows = result.rows || [];
  return {
    question,
    intent: parsed.intent,
    domain: (meta && meta.domain) || entry.domain || 'unknown',
    answer: format(parsed.intent, rows),
    data: rows,
    meta: {
      row_count: rows.length,
      elapsed_ms: elapsedMs,
      params: {
        days: parsed.params.days,
        limit: parsed.params.limit,
        color: parsed.params.color || null,
        vendor: parsed.params.vendor || null,
        sku: parsed.params.sku || null,
        varietal: parsed.params.varietal || null,
        money: parsed.params.money || null,
      },
    },
  };
}

module.exports = { answer };
