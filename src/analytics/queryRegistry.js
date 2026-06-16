// src/analytics/queryRegistry.js
// Intent name -> { builder, describe, domain, needsCustomer?, needsProduct? }
// `needsCustomer` and `needsProduct` tell the engine to run the resolver
// before the SQL builder and to handle disambiguation / not-found uniformly.

const b = require('./sqlBuilders');

const registry = {
  // --- Customer aggregates ---------------------------------------------
  top_customers_by_spend:    { builder: b.topCustomersBySpend,   describe: 'Top customers ranked by net spend (window-aware).', domain: 'customers' },
  customer_profile:          { builder: b.customerProfile,       describe: 'Customer profile (resolved).', domain: 'customers', needsCustomer: true },
  customer_spend:            { builder: b.customerSpend,         describe: 'Revenue for one customer in window.', domain: 'customers', needsCustomer: true },
  customer_order_count:      { builder: b.customerOrderCount,    describe: 'Order count for one customer in window.', domain: 'customers', needsCustomer: true },
  customer_aov:              { builder: b.customerAov,           describe: 'Average order value for one customer in window.', domain: 'customers', needsCustomer: true },
  customer_recent_purchases: { builder: b.customerRecentPurchases, describe: 'Recent purchases for one customer in window.', domain: 'customers', needsCustomer: true },
  customers_who_bought:      { builder: b.customersWhoBought,    describe: 'Customers who bought a varietal / SKU / vendor in window.', domain: 'customers_orders' },
  customer_count:            { builder: b.customerCount,         describe: 'Customer counts overall and active.', domain: 'customers' },
  new_customers:             { builder: b.newCustomers,          describe: 'Customers whose first order is within window.', domain: 'customers' },
  lapsed_customers:          { builder: b.lapsedCustomers,       describe: 'Customers with spend but no recent order.', domain: 'customers' },
  customers_one_time_only:   { builder: b.customersOneTimeOnly,  describe: 'Customers with exactly one order.', domain: 'customers' },
  top_customers_by_varietal: { builder: b.topCustomersByVarietal, describe: 'Top spenders on a varietal in window.', domain: 'customers' },
  top_customers_by_vendor:   { builder: b.topCustomersByVendor,   describe: 'Top spenders for a vendor in window.', domain: 'customers' },

  // --- Basket / affinity -----------------------------------------------
  basket_pairs:         { builder: b.basketPairs,        describe: 'Products purchased together in the same order.', domain: 'orders' },
  bought_with_product:  { builder: b.boughtWithProduct,  describe: 'Products co-purchased with a given product/SKU.', domain: 'orders' },

  // --- Sales / SKU ------------------------------------------------------
  top_items_by_units:   { builder: b.topItemsByUnits,    describe: 'Top items ranked by units in window.', domain: 'sales' },
  top_items_by_revenue: { builder: b.topItemsByRevenue,  describe: 'Top items ranked by net revenue in window.', domain: 'sales' },
  // Legacy alias kept for backward compatibility:
  top_skus:             { builder: b.topItemsByUnits,    describe: '(alias of top_items_by_units)', domain: 'sales' },
  units_sold_per_sku:   { builder: b.unitsSoldPerSku,    describe: 'Units sold per SKU, or detail for one SKU.', domain: 'sales' },
  product_detail:       { builder: b.productDetail,      describe: 'Product detail / lifetime + window aggregates.', domain: 'sales' },
  top_vendors:          { builder: b.topVendors,         describe: 'Top vendors by revenue in window.', domain: 'vendors' },
  vendor_growth:        { builder: b.vendorGrowth,       describe: 'Vendor revenue change vs prior equal-length window.', domain: 'vendors' },
  category_performance: { builder: b.categoryPerformance, describe: 'Product type / category performance in window.', domain: 'sales' },
  varietal_performance: { builder: b.varietalPerformance, describe: 'Varietal performance in window.', domain: 'sales' },
  period_over_period:   { builder: b.periodOverPeriod,   describe: 'Revenue/units/orders vs prior equal-length window.', domain: 'sales' },
  trending_up:          { builder: b.trendingUp,         describe: 'SKUs whose 30-day pace is accelerating.', domain: 'sales' },
  trending_down:        { builder: b.trendingDown,       describe: 'SKUs whose 30-day pace is decelerating.', domain: 'sales' },
  recent_orders:        { builder: b.recentOrders,       describe: 'Recent orders in window.', domain: 'orders' },
  sales_summary:        { builder: b.salesSummary,       describe: 'Revenue / units / discounts in window.', domain: 'revenue' },
  // Legacy alias:
  revenue_summary:      { builder: b.salesSummary,       describe: '(alias of sales_summary)', domain: 'revenue' },

  // --- Inventory --------------------------------------------------------
  low_stock:               { builder: b.lowStock,             describe: 'Variants with low on-hand stock.', domain: 'inventory' },
  out_of_stock:            { builder: b.outOfStock,           describe: 'Variants currently out of stock.', domain: 'inventory' },
  in_stock_filtered:       { builder: b.inStockFiltered,      describe: 'In-stock variants filtered by color/varietal/vendor/price.', domain: 'inventory' },
  dead_inventory:          { builder: b.deadInventory,        describe: 'On-hand SKUs not sold in N days.', domain: 'inventory' },
  unsold_in_period:        { builder: b.unsoldInPeriod,       describe: '(alias of dead_inventory)', domain: 'inventory' },
  aged_inventory:          { builder: b.agedInventory,        describe: 'Long-held inventory.', domain: 'inventory' },
  overstock:               { builder: b.overstock,            describe: 'SKUs with on-hand vastly above velocity.', domain: 'inventory' },
  runout_risk:             { builder: b.runoutRisk,           describe: 'SKUs likely to run out within 2 weeks.', domain: 'inventory' },
  inventory_velocity:      { builder: b.inventoryVelocity,    describe: 'SKUs ranked by 30-day units velocity.', domain: 'inventory' },
  sell_through:            { builder: b.sellThrough,          describe: 'Sell-through ratio per SKU (30 days).', domain: 'inventory' },
  low_stock_high_velocity: { builder: b.lowStockHighVelocity, describe: 'Low on-hand SKUs still selling — reorder candidates.', domain: 'inventory' },
};

function get(intent) { return registry[intent] || null; }

function listIntents() {
  return Object.keys(registry).map((name) => ({
    name,
    domain: registry[name].domain,
    describe: registry[name].describe,
    needsCustomer: !!registry[name].needsCustomer,
    needsProduct: !!registry[name].needsProduct,
  }));
}

module.exports = { get, listIntents, registry };
