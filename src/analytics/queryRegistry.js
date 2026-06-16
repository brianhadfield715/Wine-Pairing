// src/analytics/queryRegistry.js
// Central registry mapping intent name -> { builder, describe }. The engine
// consults this to decide which SQL builder to call.

const b = require('./sqlBuilders');

const registry = {
  top_customers_by_spend: {
    builder: b.topCustomersBySpend,
    describe: 'Top customers ranked by lifetime net spend.',
    domain: 'customers',
  },
  customer_profile: {
    builder: b.customerProfile,
    describe: 'Profile of one customer (by email) or recent active customers.',
    domain: 'customers',
  },
  customers_who_bought: {
    builder: b.customersWhoBought,
    describe: 'Customers who purchased a given varietal / SKU / color in a window.',
    domain: 'customers_orders',
  },
  customer_count: {
    builder: b.customerCount,
    describe: 'Total customer counts and recent active counts.',
    domain: 'customers',
  },
  new_customers: {
    builder: b.newCustomers,
    describe: 'Customers whose first order is within the window.',
    domain: 'customers',
  },
  lapsed_customers: {
    builder: b.lapsedCustomers,
    describe: 'Customers with spend but no recent order.',
    domain: 'customers',
  },

  basket_pairs: {
    builder: b.basketPairs,
    describe: 'SKUs that are purchased together in the same order.',
    domain: 'basket',
  },

  top_skus: {
    builder: b.topSkus,
    describe: 'Best-selling SKUs by units in window.',
    domain: 'sales',
  },
  units_sold_per_sku: {
    builder: b.unitsSoldPerSku,
    describe: 'Units sold per SKU, or detail for a specific SKU.',
    domain: 'sales',
  },
  top_vendors: {
    builder: b.topVendors,
    describe: 'Vendor performance by net revenue in window.',
    domain: 'vendors',
  },

  recent_orders: {
    builder: b.recentOrders,
    describe: 'Recent orders within the window.',
    domain: 'orders',
  },
  revenue_summary: {
    builder: b.revenueSummary,
    describe: 'Headline revenue / units / discounts for the window.',
    domain: 'revenue',
  },

  low_stock: {
    builder: b.lowStock,
    describe: 'Variants with low on-hand stock.',
    domain: 'inventory',
  },
  out_of_stock: {
    builder: b.outOfStock,
    describe: 'Variants currently out of stock.',
    domain: 'inventory',
  },
  in_stock_filtered: {
    builder: b.inStockFiltered,
    describe: 'In-stock variants filtered by color/varietal/vendor/price.',
    domain: 'inventory',
  },
  dead_inventory: {
    builder: b.deadInventory,
    describe: 'SKUs with on-hand stock that have not sold in N days.',
    domain: 'inventory',
  },
  low_stock_high_velocity: {
    builder: b.lowStockHighVelocity,
    describe: 'Low on-hand SKUs that are nonetheless selling — reorder candidates.',
    domain: 'inventory',
  },
};

function get(intent) {
  return registry[intent] || null;
}

function listIntents() {
  return Object.keys(registry).map((name) => ({
    name,
    domain: registry[name].domain,
    describe: registry[name].describe,
  }));
}

module.exports = { get, listIntents, registry };
