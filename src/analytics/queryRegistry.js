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
  top_customers_by_sku:        { builder: b.topCustomersBySku,        describe: 'Top buyers of a specific SKU.', domain: 'customers' },
  top_customers_by_order_count:{ builder: b.topCustomersByOrderCount, describe: 'Customers ranked by order count (most frequent).', domain: 'customers' },
  top_customers_by_aov:        { builder: b.topCustomersByAov,        describe: 'Customers ranked by average order value.', domain: 'customers' },
  customers_bought_both:       { builder: b.customersBoughtBoth,      describe: 'Customers who bought BOTH varietal A and B in window.', domain: 'customers' },
  customer_top_varietals:      { builder: b.customerTopVarietals,     describe: 'What one customer typically buys.', domain: 'customers', needsCustomer: true },
  customer_taste_profile:      { builder: b.customerTasteProfile,     describe: 'Favorite vendor / product / typical price for one customer.', domain: 'customers', needsCustomer: true },
  customer_last_order:         { builder: b.customerLastOrder,        describe: 'When did one customer last shop.', domain: 'customers', needsCustomer: true },

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
  vendor_decline:       { builder: b.vendorDecline,      describe: 'Vendors with the biggest revenue declines vs prior window.', domain: 'vendors' },
  vendor_avg_selling_price: { builder: b.vendorAvgSellingPrice, describe: 'Vendors ranked by average selling price.', domain: 'vendors' },
  vendors_dead_inventory:   { builder: b.vendorsDeadInventory,    describe: 'Vendors with the most dead/unsold inventory.', domain: 'vendors' },
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
  slow_moving:             { builder: b.slowMoving,           describe: 'SKUs that sold fewer than N units in a window.', domain: 'inventory' },
  sku_inventory:           { builder: b.skuInventory,         describe: 'Inventory snapshot for a single SKU.', domain: 'inventory' },
  sku_avg_price:           { builder: b.skuAvgPrice,          describe: 'Average / min / max selling price for a SKU.', domain: 'sales' },
  sku_last_sold:           { builder: b.skuLastSold,          describe: 'When was a given SKU last sold.', domain: 'sales' },

  // --- Time-series ---
  sales_time_series:       { builder: b.salesTimeSeries,      describe: 'Storewide revenue/units/orders/AOV grouped by day/week/month.', domain: 'revenue' },

  // --- Customer units bought ---
  customer_units_bought:   { builder: b.customerUnitsBought,  describe: 'Total units a single customer purchased in window.', domain: 'customers', needsCustomer: true },

  // --- Inventory value (RETAIL only — cost data not in synced schema) ---
  inventory_value_total:       { builder: b.inventoryValueTotal,       describe: 'Total retail value of current on-hand inventory.',         domain: 'inventory' },
  inventory_value_by_vendor:   { builder: b.inventoryValueByVendor,    describe: 'Retail inventory value broken down by vendor.',           domain: 'inventory' },
  inventory_value_by_category: { builder: b.inventoryValueByCategory,  describe: 'Retail inventory value broken down by product category.', domain: 'inventory' },
  inventory_value_dead:        { builder: b.inventoryValueDead,        describe: 'Retail value of dead inventory (no sales in N days).',    domain: 'inventory' },
  inventory_value_low_stock:   { builder: b.inventoryValueLowStock,    describe: 'Retail value of low-stock inventory.',                    domain: 'inventory' },

  // --- Inventory counts ---
  inventory_count_in_stock:     { builder: b.inventoryCountInStock,     describe: 'How many products / SKUs have inventory on hand.',       domain: 'inventory' },
  inventory_count_out_of_stock: { builder: b.inventoryCountOutOfStock,  describe: 'How many products / SKUs are out of stock.',             domain: 'inventory' },
  inventory_count_low_stock:    { builder: b.inventoryCountLowStock,    describe: 'How many products / SKUs are at or below a low-stock threshold.', domain: 'inventory' },
  inventory_count_threshold:    { builder: b.inventoryCountThreshold,   describe: 'How many products / SKUs have more than / fewer than N units.', domain: 'inventory' },
  inventory_units_on_hand:      { builder: b.inventoryUnitsOnHand,      describe: 'Total on-hand unit count across the store (or filtered).', domain: 'inventory' },

  // --- Data coverage / metadata ---
  data_coverage_orders:    { builder: b.dataCoverageOrders,    describe: 'Order data date range and count.',                              domain: 'meta' },
  data_coverage_customers: { builder: b.dataCoverageCustomers, describe: 'Customer data totals.',                                         domain: 'meta' },
  data_coverage_products:  { builder: b.dataCoverageProducts,  describe: 'Product / variant counts.',                                     domain: 'meta' },
  data_coverage_all:       { builder: b.dataCoverageAll,       describe: 'Combined order / customer / product coverage.',                 domain: 'meta' },

  // --- Product detail by partial-title hint ---
  product_detail_search:   { builder: b.productDetailSearch,   describe: 'Product detail resolved by partial title / keyword.', domain: 'sales', needsProductSearch: true },

  // --- v4 smartness pass: repeat / new / share -------------------------
  repeat_customers_count:        { builder: b.repeatCustomersCount,        describe: 'Count of repeat (returning) customers in window.',      domain: 'customers' },
  new_customers_count:           { builder: b.newCustomersCount,           describe: 'Count of new (first-time) customers in window.',        domain: 'customers' },
  repeat_customers_share:        { builder: b.repeatCustomersShare,        describe: 'Repeat-customer share of purchasing customers.',         domain: 'customers' },
  new_customers_share:           { builder: b.newCustomersShare,           describe: 'New-customer share of purchasing customers.',            domain: 'customers' },
  customers_count_purchasing:    { builder: b.customersCountPurchasing,    describe: 'Distinct purchasing customers in window.',               domain: 'customers' },

  // --- v4: busiest hour / pattern --------------------------------------
  busiest_hour:                  { builder: b.busiestHour,                 describe: 'Single-window busiest hour by orders/units/revenue.',    domain: 'orders' },
  busiest_period_pattern:        { builder: b.busiestPeriodPattern,        describe: 'Typical busiest day/hour pattern across last 12 weeks.', domain: 'orders' },

  // --- v4: price extremes ----------------------------------------------
  highest_priced_item_sold:      { builder: b.highestPricedItemSold,       describe: 'Highest unit-priced item sold in window.',               domain: 'sales' },
  lowest_priced_item_sold:       { builder: b.lowestPricedItemSold,        describe: 'Lowest unit-priced item sold in window.',                domain: 'sales' },
  buyer_of_highest_priced_item:  { builder: b.buyerOfHighestPricedItem,    describe: 'Customer who bought the most expensive item.',           domain: 'sales' },
  buyer_of_lowest_priced_item:   { builder: b.buyerOfLowestPricedItem,     describe: 'Customer who bought the cheapest item.',                 domain: 'sales' },

  // --- v4: customer preference (one customer) --------------------------
  customer_top_products:         { builder: b.customerTopProducts,         describe: 'Top products for one customer in window.',               domain: 'customers', needsCustomer: true },
  customer_top_vendors:          { builder: b.customerTopVendors,          describe: 'Top vendors for one customer in window.',                domain: 'customers', needsCustomer: true },
  customer_top_categories:       { builder: b.customerTopCategories,       describe: 'Top product categories for one customer in window.',     domain: 'customers', needsCustomer: true },

  // --- v4: customer cadence / lapsed-frequent --------------------------
  customer_frequency_profile:    { builder: b.customerFrequencyProfile,    describe: 'One customer cadence: order span, avg days between, recency.', domain: 'customers', needsCustomer: true },
  lapsed_frequent_customers:     { builder: b.lapsedFrequentCustomers,     describe: 'Previously frequent customers who have gone quiet.',     domain: 'customers' },
  customer_reactivation_candidates: { builder: b.customerReactivationCandidates, describe: 'Customers who recently came back after a long gap.', domain: 'customers' },

  // --- v4: storewide breakdowns ----------------------------------------
  type_top_seller:               { builder: b.typeTopSeller,               describe: 'Top product types in window (ranked list).',             domain: 'sales' },
  type_breakdown:                { builder: b.typeBreakdown,               describe: 'Units/revenue broken down by product type.',             domain: 'sales' },
  varietal_ranking:              { builder: b.varietalRanking,             describe: 'Top varietals/products in window.',                       domain: 'sales' },

  // --- v4: share / mix --------------------------------------------------
  share_of_sales_by_filter:      { builder: b.shareOfSalesByFilter,        describe: 'Share of revenue/units for a filter (color/varietal/vendor/category).', domain: 'sales' },
  share_of_revenue_top_n:        { builder: b.shareOfRevenueTopN,          describe: 'Share of revenue from the top N products.',              domain: 'sales' },
  share_of_dead_inventory_value: { builder: b.shareOfDeadInventoryValue,   describe: 'Share of retail inventory value that is dead.',          domain: 'inventory' },
  share_of_orders_with_filter:   { builder: b.shareOfOrdersWithFilter,     describe: 'Share of orders containing a given category/varietal/etc.', domain: 'orders' },

  // --- v4: dashboard ---------------------------------------------------
  dashboard_summary:             { builder: b.dashboardSummary,            describe: 'Bundled KPI dashboard + top products + top vendors.',    domain: 'dashboard' },

  // --- v5: order drill-down --------------------------------------------
  order_detail_lookup:          { builder: b.orderDetail,                 describe: 'Full detail (header) for one order.',                     domain: 'orders', needsOrder: true },
  order_items_lookup:           { builder: b.orderItems,                  describe: 'Line items for one order.',                                domain: 'orders', needsOrder: true },
  order_customer_lookup:        { builder: b.orderDetail,                 describe: 'Who placed one order.',                                    domain: 'orders', needsOrder: true },
  order_total_lookup:           { builder: b.orderDetail,                 describe: 'Total for one order.',                                     domain: 'orders', needsOrder: true },
  order_status_lookup:          { builder: b.orderDetail,                 describe: 'Status of one order (cancelled/fulfilled/refunded).',     domain: 'orders', needsOrder: true },
  order_extreme_item_lookup:    { builder: b.orderExtremeItem,            describe: 'Most/least expensive item on one order.',                 domain: 'orders', needsOrder: true },
  order_includes_category:      { builder: b.orderIncludesCategory,       describe: 'Whether one order includes a given category (wine/liquor/...).', domain: 'orders', needsOrder: true },

  // --- v5: customer drill-down + comparison ---------------------------
  customer_last_order_items:    { builder: b.customerLastOrderItems,      describe: 'A customer\'s most recent order + its line items.',       domain: 'orders',    needsCustomer: true },
  customer_last_n_orders:       { builder: b.customerLastNOrders,         describe: 'A customer\'s last N orders.',                             domain: 'orders',    needsCustomer: true },
  customer_comparison:          { builder: b.customerComparison,          describe: 'Compare two resolved customers across spend/units/orders/AOV.', domain: 'customers', needsCustomerPair: true },
  customer_time_series:         { builder: b.customerTimeSeries,          describe: 'Per-customer revenue/units/orders by day/week/month.',    domain: 'customers', needsCustomer: true },
  customer_change_over_time:    { builder: b.customerChangeOverTime,      describe: 'Customer current window vs prior equal-length window.',   domain: 'customers', needsCustomer: true },
  customer_color_mix:           { builder: b.customerColorMix,            describe: 'Red/white/sparkling mix for one customer.',                domain: 'customers', needsCustomer: true },

  // --- v5: overlap share ----------------------------------------------
  order_overlap_share:          { builder: b.orderOverlapShare,           describe: 'Share of orders containing BOTH listed categories.',      domain: 'orders' },
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
