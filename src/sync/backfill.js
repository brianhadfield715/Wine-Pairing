// src/sync/backfill.js
// Orchestrates a full or windowed backfill of the analytics warehouse.
// Order matters: locations -> products -> inventory -> customers -> orders.

const { syncLocations } = require('./locations');
const { syncProducts } = require('./products');
const { syncInventory } = require('./inventory');
const { syncCustomers } = require('./customers');
const { syncOrders } = require('./orders');

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * Run a full backfill. By default pulls the last 365 days of orders and all
 * products / locations / inventory. Pass { days } to widen or narrow the
 * order/customer window.
 */
async function runBackfill({ days = 365, includeInventory = true } = {}) {
  const since = daysAgoIso(days);
  const result = {};

  result.locations = await syncLocations();
  result.products  = await syncProducts();
  if (includeInventory) {
    result.inventory = await syncInventory({ snapshot: true });
  }
  result.customers = await syncCustomers({ sinceIso: since });
  result.orders    = await syncOrders({ sinceIso: since });
  result.window    = { days, sinceIso: since };
  return result;
}

module.exports = { runBackfill };
