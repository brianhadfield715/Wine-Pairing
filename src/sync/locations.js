// src/sync/locations.js
const db = require('../db');
const shopify = require('../shopify/client');

const UPSERT = `
insert into locations (id, name, active, country, province, city, raw, synced_at)
values ($1,$2,$3,$4,$5,$6,$7, now())
on conflict (id) do update set
  name      = excluded.name,
  active    = excluded.active,
  country   = excluded.country,
  province  = excluded.province,
  city      = excluded.city,
  raw       = excluded.raw,
  synced_at = now()
`;

async function syncLocations() {
  const { body } = await shopify.rest('/locations.json');
  const list = body.locations || [];
  for (const l of list) {
    await db.query(UPSERT, [
      l.id,
      l.name || null,
      l.active != null ? Boolean(l.active) : null,
      l.country || null,
      l.province || null,
      l.city || null,
      l,
    ]);
  }
  return { locations: list.length };
}

module.exports = { syncLocations };
