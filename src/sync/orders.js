// src/sync/orders.js
// Pulls orders (status=any) + line items and upserts both. Supports
// time-bounded backfills via { sinceIso, untilIso } and a soft cap via { max }.

const db = require('../db');
const shopify = require('../shopify/client');

const ORDER_UPSERT = `
insert into orders (
  id, name, customer_id, email, financial_status, fulfillment_status,
  currency, subtotal_price, total_discounts, total_tax, total_price,
  total_line_items_price, processed_at, created_at, updated_at,
  cancelled_at, closed_at, source_name, tags, raw, synced_at
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now()
)
on conflict (id) do update set
  name                   = excluded.name,
  customer_id            = excluded.customer_id,
  email                  = excluded.email,
  financial_status       = excluded.financial_status,
  fulfillment_status     = excluded.fulfillment_status,
  currency               = excluded.currency,
  subtotal_price         = excluded.subtotal_price,
  total_discounts        = excluded.total_discounts,
  total_tax              = excluded.total_tax,
  total_price            = excluded.total_price,
  total_line_items_price = excluded.total_line_items_price,
  processed_at           = excluded.processed_at,
  created_at             = excluded.created_at,
  updated_at             = excluded.updated_at,
  cancelled_at           = excluded.cancelled_at,
  closed_at              = excluded.closed_at,
  source_name            = excluded.source_name,
  tags                   = excluded.tags,
  raw                    = excluded.raw,
  synced_at              = now()
`;

const LINE_UPSERT = `
insert into order_line_items (
  id, order_id, product_id, variant_id, sku, title, variant_title,
  vendor, quantity, price, total_discount, raw, synced_at
) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
on conflict (id) do update set
  order_id       = excluded.order_id,
  product_id     = excluded.product_id,
  variant_id     = excluded.variant_id,
  sku            = excluded.sku,
  title          = excluded.title,
  variant_title  = excluded.variant_title,
  vendor         = excluded.vendor,
  quantity       = excluded.quantity,
  price          = excluded.price,
  total_discount = excluded.total_discount,
  raw            = excluded.raw,
  synced_at      = now()
`;

async function syncOrders({ sinceIso, untilIso, max = Infinity } = {}) {
  const params = ['status=any', 'limit=250', 'order=updated_at+asc'];
  if (sinceIso) params.push(`updated_at_min=${encodeURIComponent(sinceIso)}`);
  if (untilIso) params.push(`updated_at_max=${encodeURIComponent(untilIso)}`);
  const path = `/orders.json?${params.join('&')}`;

  let orders = 0;
  let lines = 0;
  outer: for await (const page of shopify.restPaginated(path, {}, 'orders')) {
    for (const o of page.orders || []) {
      await db.query(ORDER_UPSERT, [
        o.id,
        o.name || null,
        o.customer ? o.customer.id : null,
        o.email || null,
        o.financial_status || null,
        o.fulfillment_status || null,
        o.currency || null,
        o.subtotal_price != null ? Number(o.subtotal_price) : null,
        o.total_discounts != null ? Number(o.total_discounts) : null,
        o.total_tax != null ? Number(o.total_tax) : null,
        o.total_price != null ? Number(o.total_price) : null,
        o.total_line_items_price != null ? Number(o.total_line_items_price) : null,
        o.processed_at || null,
        o.created_at || null,
        o.updated_at || null,
        o.cancelled_at || null,
        o.closed_at || null,
        o.source_name || null,
        o.tags || null,
        o,
      ]);
      orders += 1;
      for (const li of o.line_items || []) {
        await db.query(LINE_UPSERT, [
          li.id,
          o.id,
          li.product_id || null,
          li.variant_id || null,
          li.sku || null,
          li.title || null,
          li.variant_title || null,
          li.vendor || null,
          li.quantity != null ? Number(li.quantity) : null,
          li.price != null ? Number(li.price) : null,
          li.total_discount != null ? Number(li.total_discount) : null,
          li,
        ]);
        lines += 1;
      }
      if (orders >= max) break outer;
    }
  }
  return { orders, lines };
}

module.exports = { syncOrders };
