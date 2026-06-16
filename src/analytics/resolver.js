// src/analytics/resolver.js
// Resolves "hints" (customer name, product title) to concrete DB rows.
//
// Customer resolution rules (in priority order):
//   1. exact email match
//   2. exact full-name match (case-insensitive)
//   3. partial-name match when unique
//   4. otherwise: return a list of candidates for the engine to format
//      as a disambiguation response
//
// Returns one of:
//   { status: 'ok',           customer: {...} }
//   { status: 'ambiguous',    candidates: [...up to 8...] }
//   { status: 'not_found',    hint: '...' }

const db = require('../db');

async function resolveCustomer({ customer, email }) {
  if (email) {
    const r = await db.query(
      `select id as customer_id, email,
              trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) as customer_name,
              orders_count, total_spent
         from customers
        where lower(email) = lower($1)
        limit 1`,
      [email]
    );
    if (r.rows.length === 1) return { status: 'ok', customer: r.rows[0] };
    if (r.rows.length === 0) return { status: 'not_found', hint: email };
  }

  if (!customer) return { status: 'not_found', hint: null };

  // Normalize: collapse whitespace.
  const name = customer.trim().replace(/\s+/g, ' ');

  // 1) exact full-name match
  const exact = await db.query(
    `select id as customer_id, email,
            trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) as customer_name,
            orders_count, total_spent
       from customers
      where lower(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) = lower($1)`,
    [name]
  );
  if (exact.rows.length === 1) return { status: 'ok', customer: exact.rows[0] };
  if (exact.rows.length > 1) {
    return { status: 'ambiguous', candidates: exact.rows.slice(0, 8), hint: name };
  }

  // 2) partial / contains match.
  // Split on whitespace; require every token to appear somewhere.
  const tokens = name.split(/\s+/);
  const wheres = tokens.map((_, i) => `(lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'')) like lower($${i + 1}))`).join(' and ');
  const values = tokens.map((t) => `%${t}%`);
  const partial = await db.query(
    `select id as customer_id, email,
            trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) as customer_name,
            orders_count, total_spent
       from customers
      where ${wheres}
      order by total_spent desc nulls last
      limit 25`,
    values
  );
  if (partial.rows.length === 1) return { status: 'ok', customer: partial.rows[0] };
  if (partial.rows.length === 0) return { status: 'not_found', hint: name };
  return { status: 'ambiguous', candidates: partial.rows.slice(0, 8), hint: name };
}

/**
 * Resolve a free-text product hint to a single product id when possible.
 * Used by "bought_with_product" / "product_detail".
 */
async function resolveProduct({ productHint, sku }) {
  if (sku) {
    const r = await db.query(
      `select distinct on (p.id) p.id as product_id, p.title as product_title, p.vendor, p.handle
         from variants v join products p on p.id = v.product_id
        where v.sku = $1 limit 1`,
      [sku]
    );
    if (r.rows.length === 1) return { status: 'ok', product: r.rows[0] };
    if (r.rows.length === 0) return { status: 'not_found', hint: sku };
  }
  if (!productHint) return { status: 'not_found', hint: null };
  const r = await db.query(
    `select id as product_id, title as product_title, vendor, handle
       from products
      where lower(title) like lower($1)
      order by length(title) asc
      limit 10`,
    [`%${productHint}%`]
  );
  if (r.rows.length === 1) return { status: 'ok', product: r.rows[0] };
  if (r.rows.length === 0) return { status: 'not_found', hint: productHint };
  return { status: 'ambiguous', candidates: r.rows, hint: productHint };
}

module.exports = { resolveCustomer, resolveProduct };
