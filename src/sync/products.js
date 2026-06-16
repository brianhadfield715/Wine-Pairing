// src/sync/products.js
// Pulls products + variants from Shopify REST and upserts into Postgres.

const db = require('../db');
const shopify = require('../shopify/client');

const PRODUCT_UPSERT = `
insert into products (
  id, title, handle, vendor, product_type, status, tags, body_html,
  created_at, updated_at, published_at, raw, synced_at
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()
)
on conflict (id) do update set
  title         = excluded.title,
  handle        = excluded.handle,
  vendor        = excluded.vendor,
  product_type  = excluded.product_type,
  status        = excluded.status,
  tags          = excluded.tags,
  body_html     = excluded.body_html,
  created_at    = excluded.created_at,
  updated_at    = excluded.updated_at,
  published_at  = excluded.published_at,
  raw           = excluded.raw,
  synced_at     = now()
`;

const VARIANT_UPSERT = `
insert into variants (
  id, product_id, sku, title, price, compare_at_price,
  inventory_item_id, inventory_quantity, position, barcode, raw, synced_at
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()
)
on conflict (id) do update set
  product_id          = excluded.product_id,
  sku                 = excluded.sku,
  title               = excluded.title,
  price               = excluded.price,
  compare_at_price    = excluded.compare_at_price,
  inventory_item_id   = excluded.inventory_item_id,
  inventory_quantity  = excluded.inventory_quantity,
  position            = excluded.position,
  barcode             = excluded.barcode,
  raw                 = excluded.raw,
  synced_at           = now()
`;

async function syncProducts() {
  let products = 0;
  let variants = 0;
  for await (const page of shopify.restPaginated(
    '/products.json?limit=250&status=any',
    {},
    'products'
  )) {
    if (!Array.isArray(page.products)) continue;
    for (const p of page.products) {
      await db.query(PRODUCT_UPSERT, [
        p.id,
        p.title || null,
        p.handle || null,
        p.vendor || null,
        p.product_type || null,
        p.status || null,
        p.tags || null,
        p.body_html || null,
        p.created_at || null,
        p.updated_at || null,
        p.published_at || null,
        p,
      ]);
      products += 1;
      for (const v of p.variants || []) {
        await db.query(VARIANT_UPSERT, [
          v.id,
          p.id,
          v.sku || null,
          v.title || null,
          v.price != null ? Number(v.price) : null,
          v.compare_at_price != null ? Number(v.compare_at_price) : null,
          v.inventory_item_id || null,
          v.inventory_quantity != null ? Number(v.inventory_quantity) : null,
          v.position != null ? Number(v.position) : null,
          v.barcode || null,
          v,
        ]);
        variants += 1;
      }
    }
  }
  return { products, variants };
}

module.exports = { syncProducts };
