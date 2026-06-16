// src/sync/customers.js
const db = require('../db');
const shopify = require('../shopify/client');

const UPSERT = `
insert into customers (
  id, email, first_name, last_name, phone, orders_count, total_spent,
  state, tags, created_at, updated_at, raw, synced_at
) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
on conflict (id) do update set
  email        = excluded.email,
  first_name   = excluded.first_name,
  last_name    = excluded.last_name,
  phone        = excluded.phone,
  orders_count = excluded.orders_count,
  total_spent  = excluded.total_spent,
  state        = excluded.state,
  tags         = excluded.tags,
  created_at   = excluded.created_at,
  updated_at   = excluded.updated_at,
  raw          = excluded.raw,
  synced_at    = now()
`;

async function syncCustomers({ sinceIso } = {}) {
  let count = 0;
  let path = '/customers.json?limit=250';
  if (sinceIso) {
    path += `&updated_at_min=${encodeURIComponent(sinceIso)}`;
  }
  for await (const page of shopify.restPaginated(path, {}, 'customers')) {
    for (const c of page.customers || []) {
      await db.query(UPSERT, [
        c.id,
        c.email || null,
        c.first_name || null,
        c.last_name || null,
        c.phone || null,
        c.orders_count != null ? Number(c.orders_count) : null,
        c.total_spent != null ? Number(c.total_spent) : null,
        c.state || null,
        c.tags || null,
        c.created_at || null,
        c.updated_at || null,
        c,
      ]);
      count += 1;
    }
  }
  return { customers: count };
}

module.exports = { syncCustomers };
