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

/**
 * Stronger product resolution used by /product_detail_search/.
 *
 * Strategy (case-insensitive throughout):
 *   1. SKU first if present                          (single hit -> ok)
 *   2. Exact title match                              (single hit -> ok)
 *   3. Title starts-with match                        (single hit -> ok)
 *   4. Title contains match                           (1 hit -> ok; many -> ambiguous)
 *
 * Disambiguation rows are enriched with a current-inventory summary so
 * the staff can pick by SKU/price/stock.
 */
async function resolveProductByHint({ productHint, sku }) {
  if (sku) return resolveProduct({ productHint: null, sku });
  if (!productHint) return { status: 'not_found', hint: null };

  const hint = productHint.trim();
  const baseCols = `
    p.id as product_id, p.title as product_title, p.vendor, p.handle,
    (select coalesce(sum(on_hand), 0)::int from vw_current_inventory v
       where v.product_id = p.id) as on_hand_total,
    (select coalesce(min(price), 0)::numeric(12,2) from variants v
       where v.product_id = p.id) as min_price,
    (select sku from variants v where v.product_id = p.id
       order by position nulls last limit 1) as primary_sku
  `;

  // 2) exact case-insensitive title
  let r = await db.query(
    `select ${baseCols} from products p where lower(p.title) = lower($1) limit 5`,
    [hint]
  );
  if (r.rows.length === 1) return { status: 'ok', product: r.rows[0] };
  if (r.rows.length > 1)   return { status: 'ambiguous', candidates: r.rows, hint };

  // 3) starts-with
  r = await db.query(
    `select ${baseCols} from products p
      where lower(p.title) like lower($1)
      order by length(p.title) asc
      limit 10`,
    [`${hint}%`]
  );
  if (r.rows.length === 1) return { status: 'ok', product: r.rows[0] };
  if (r.rows.length > 1)   return { status: 'ambiguous', candidates: r.rows, hint };

  // 4) contains
  r = await db.query(
    `select ${baseCols} from products p
      where lower(p.title) like lower($1)
      order by length(p.title) asc
      limit 10`,
    [`%${hint}%`]
  );
  if (r.rows.length === 1) return { status: 'ok', product: r.rows[0] };
  if (r.rows.length > 1)   return { status: 'ambiguous', candidates: r.rows, hint };

  return { status: 'not_found', hint };
}

/**
 * Resolve an order by canonical name ("#37857") or numeric id.
 * Returns one of:
 *   { status: 'ok',         order: {...} }
 *   { status: 'not_found',  hint: '...' }
 *
 * We try by name first (the Shopify-shop-facing identifier) and fall back to
 * a numeric id match. We never confuse this with a SKU because resolveOrder
 * is called by the engine ONLY when intentParser has already classified the
 * question as an order_* intent and `params.orderRef` is set.
 */
async function resolveOrder({ name, id }) {
  if (!name && !id) return { status: 'not_found', hint: null };
  // 1) By Shopify "name" (which IS the #-prefixed string).
  if (name) {
    const r = await db.query(
      `select id as order_id, name, customer_id, email,
              processed_at, created_at, cancelled_at, closed_at,
              financial_status, fulfillment_status, currency,
              subtotal_price, total_discounts, total_tax, total_price,
              total_line_items_price, source_name, tags, raw
         from orders
        where name = $1
        limit 1`,
      [name]
    );
    if (r.rows.length === 1) return { status: 'ok', order: r.rows[0] };
  }
  // 2) By numeric id (bare digits in the question, no #).
  if (id) {
    const r = await db.query(
      `select id as order_id, name, customer_id, email,
              processed_at, created_at, cancelled_at, closed_at,
              financial_status, fulfillment_status, currency,
              subtotal_price, total_discounts, total_tax, total_price,
              total_line_items_price, source_name, tags, raw
         from orders
        where id = $1
        limit 1`,
      [id]
    );
    if (r.rows.length === 1) return { status: 'ok', order: r.rows[0] };
  }
  return { status: 'not_found', hint: name || (id ? String(id) : null) };
}

module.exports = { resolveCustomer, resolveProduct, resolveProductByHint, resolveOrder };
