// src/sync/costs.js
// Pulls unit costs (Shopify InventoryItem.cost) for every variant we know
// about and upserts into variant_costs. READ-ONLY against Shopify: GET only.
//
// Shopify keeps cost on the InventoryItem resource, not the product/variant
// payload, so this is its own sync: collect inventory_item_ids from the
// variants table, then fetch /inventory_items.json?ids=... in batches of 100
// (the endpoint's documented max).

const db = require('../db');
const shopify = require('../shopify/client');

const COST_UPSERT = `
insert into variant_costs
  (inventory_item_id, variant_id, sku, unit_cost, currency, tracked, updated_at, synced_at)
values ($1,$2,$3,$4,$5,$6,$7, now())
on conflict (inventory_item_id) do update set
  variant_id = excluded.variant_id,
  sku        = excluded.sku,
  unit_cost  = excluded.unit_cost,
  currency   = excluded.currency,
  tracked    = excluded.tracked,
  updated_at = excluded.updated_at,
  synced_at  = now()
`;

async function syncCosts() {
  const { rows } = await db.query(
    `select inventory_item_id, id as variant_id, sku
       from variants
      where inventory_item_id is not null`
  );
  if (!rows.length) {
    return { variants: 0, costs_written: 0, note: 'no variants with inventory_item_id; run /admin/sync/products first' };
  }
  const byItem = new Map();
  for (const r of rows) byItem.set(String(r.inventory_item_id), r);

  const ids = [...byItem.keys()];
  let written = 0;
  let withCost = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const page = await shopify.rest(
      `/inventory_items.json?ids=${batch.join(',')}&limit=100`
    );
    for (const item of page.inventory_items || []) {
      const v = byItem.get(String(item.id)) || {};
      const cost = item.cost != null && item.cost !== '' ? Number(item.cost) : null;
      if (cost != null) withCost += 1;
      await db.query(COST_UPSERT, [
        item.id,
        v.variant_id || null,
        v.sku || null,
        cost,
        item.currency_code || null,
        item.tracked != null ? Boolean(item.tracked) : null,
        item.updated_at || null,
      ]);
      written += 1;
    }
  }
  return {
    variants: ids.length,
    costs_written: written,
    with_cost: withCost,
    coverage_pct: written ? Math.round((withCost / written) * 1000) / 10 : 0,
  };
}

module.exports = { syncCosts };
