// src/sync/inventory.js
// Pulls inventory_levels for all known locations and refreshes both
// inventory_levels_current and today's inventory_snapshots row.

const db = require('../db');
const shopify = require('../shopify/client');

const CURRENT_UPSERT = `
insert into inventory_levels_current
  (inventory_item_id, location_id, available, updated_at, synced_at)
values ($1,$2,$3,$4, now())
on conflict (inventory_item_id, location_id) do update set
  available  = excluded.available,
  updated_at = excluded.updated_at,
  synced_at  = now()
`;

const SNAPSHOT_UPSERT = `
insert into inventory_snapshots (snapshot_date, inventory_item_id, location_id, available)
values (current_date, $1, $2, $3)
on conflict (snapshot_date, inventory_item_id, location_id) do update set
  available = excluded.available
`;

async function syncInventory({ snapshot = true } = {}) {
  // Need the list of location ids from DB.
  const locs = await db.query('select id from locations');
  if (!locs.rows.length) {
    return { locations: 0, levels: 0, note: 'no locations in DB; run /admin/sync/locations first' };
  }

  let totalLevels = 0;
  for (const { id: locationId } of locs.rows) {
    for await (const page of shopify.restPaginated(
      `/inventory_levels.json?location_ids=${locationId}&limit=250`,
      {},
      'inventory_levels'
    )) {
      const levels = page.inventory_levels || [];
      for (const lvl of levels) {
        await db.query(CURRENT_UPSERT, [
          lvl.inventory_item_id,
          lvl.location_id,
          lvl.available != null ? Number(lvl.available) : null,
          lvl.updated_at || null,
        ]);
        if (snapshot) {
          await db.query(SNAPSHOT_UPSERT, [
            lvl.inventory_item_id,
            lvl.location_id,
            lvl.available != null ? Number(lvl.available) : null,
          ]);
        }
        totalLevels += 1;
      }
    }
  }
  return { locations: locs.rows.length, levels: totalLevels };
}

module.exports = { syncInventory };
