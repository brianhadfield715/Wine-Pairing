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

  // --- v6: orders status / fulfillment / drafts / archived ---------------
  order_status_breakdown:        { builder: b.orderStatusBreakdown,        describe: 'Orders bucketed by financial / fulfillment / cancelled.', domain: 'orders' },
  fulfillment_status_breakdown:  { builder: b.fulfillmentStatusBreakdown,  describe: 'Orders by fulfillment status.',                            domain: 'orders' },
  orders_pending_fulfillment:    { builder: b.ordersPendingFulfillment,    describe: 'Open / unfulfilled / partial orders.',                     domain: 'orders' },
  refunded_orders_count:         { builder: b.refundedOrdersCount,         describe: 'Number of orders that received a refund + refund total.',  domain: 'orders' },
  cancelled_orders_count:        { builder: b.cancelledOrdersCount,        describe: 'Cancelled-order count + total cancelled value.',           domain: 'orders' },
  draft_orders_count:            { builder: b.draftOrdersCount,            describe: 'Shopify draft orders (not synced).',                       domain: 'meta' },
  archived_orders_count:         { builder: b.archivedOrdersCount,         describe: 'Closed / archived order count.',                           domain: 'orders' },
  orders_with_notes:             { builder: b.ordersWithNotes,             describe: 'Orders that have a note attached.',                        domain: 'orders' },
  orders_with_custom_attrs:      { builder: b.ordersWithCustomAttrs,       describe: 'Orders with custom note_attributes.',                      domain: 'orders' },
  orders_by_referrer:            { builder: b.ordersByReferrer,            describe: 'Orders bucketed by source_name (web / pos / iphone / …).', domain: 'orders' },
  orders_by_tag:                 { builder: b.ordersByTag,                 describe: 'Order counts by tag, or count for one tag.',               domain: 'orders' },

  // --- v6: order extremes (BY TOTAL_PRICE, not unit price) ---------------
  highest_order_total:           { builder: b.highestOrderTotal,           describe: 'Largest single order by total_price.',                     domain: 'orders' },
  lowest_order_total:            { builder: b.lowestOrderTotal,            describe: 'Smallest single order by total_price (>0).',               domain: 'orders' },
  orders_above:                  { builder: b.ordersAbove,                 describe: 'Number of orders above a $ threshold + their revenue.',    domain: 'orders' },

  // --- v6: aggregations ----------------------------------------------------
  avg_items_per_order:           { builder: b.avgItemsPerOrder,            describe: 'Average items per order in window.',                       domain: 'orders' },
  total_line_items_sold:         { builder: b.totalLineItemsSold,          describe: 'Total line-item quantity sold in window.',                 domain: 'orders' },
  avg_quantity_per_line_item:    { builder: b.avgQuantityPerLineItem,      describe: 'Average quantity per line item.',                          domain: 'orders' },
  order_completion_rate:         { builder: b.orderCompletionRate,         describe: '% of orders fulfilled vs cancelled.',                      domain: 'orders' },

  // --- v6: discounts / taxes / refunds -----------------------------------
  total_discounts_given:         { builder: b.totalDiscountsGiven,         describe: 'Total discount dollars + # of discounted orders.',         domain: 'orders' },
  total_taxes_collected:         { builder: b.totalTaxesCollected,         describe: 'Total tax dollars collected in window.',                   domain: 'orders' },
  orders_with_discounts:         { builder: b.ordersWithDiscounts,         describe: 'Orders that had any discount applied.',                    domain: 'orders' },
  orders_without_discount:       { builder: b.ordersWithoutDiscount,       describe: 'Orders with no discount applied.',                         domain: 'orders' },
  avg_discount_percentage:       { builder: b.avgDiscountPercentage,       describe: 'Average discount % across discounted orders.',             domain: 'orders' },
  top_discount_codes:            { builder: b.topDiscountCodes,            describe: 'Discount codes ranked by orders that used them.',          domain: 'orders' },
  coupon_usage_rate:             { builder: b.couponUsageRate,             describe: '% of orders that used a discount code.',                   domain: 'orders' },
  refund_rate_and_avg:           { builder: b.refundRateAndAvg,            describe: 'Refund rate %, avg refund, avg days to refund.',           domain: 'orders' },
  products_with_most_returns:    { builder: b.productsWithMostReturns,     describe: 'Top SKUs by refund quantity.',                             domain: 'orders' },

  // --- v6: shipping / fulfillment time -----------------------------------
  orders_shipped_to_state:       { builder: b.ordersShippedToState,        describe: 'Orders shipped to a US state (or full breakdown).',        domain: 'orders' },
  international_orders_count:    { builder: b.internationalOrdersCount,    describe: 'Orders with shipping_country != US.',                      domain: 'orders' },
  avg_fulfillment_time:          { builder: b.avgFulfillmentTime,          describe: 'Average fulfillment time in days (approximate caveat).',   domain: 'orders' },
  shipping_method_breakdown:     { builder: b.shippingMethodBreakdown,     describe: 'Orders + revenue grouped by shipping_method_title.',       domain: 'orders' },
  orders_by_shipping_title:      { builder: b.ordersByShippingTitle,       describe: 'Orders whose shipping method matches a pattern.',          domain: 'orders' },
  free_shipping_orders:          { builder: b.freeShippingOrders,          describe: 'Orders with $0 shipping or a free-named method.',          domain: 'orders' },

  // --- v6: payment ------------------------------------------------------
  payment_method_breakdown:      { builder: b.paymentMethodBreakdown,      describe: 'Orders + revenue grouped by payment gateway.',             domain: 'orders' },
  orders_by_gateway:             { builder: b.ordersByGateway,             describe: 'Orders that used a specific payment gateway.',             domain: 'orders' },

  // --- v6: misc operational ---------------------------------------------
  orders_after_hour:             { builder: b.ordersAfterHour,             describe: 'Orders placed at/after a given hour of day.',              domain: 'orders' },
  orders_with_gift_cards:        { builder: b.ordersWithGiftCards,         describe: 'Orders that included a gift-card line item.',              domain: 'orders' },
  total_weight:                  { builder: b.totalWeight,                 describe: 'Total weight (grams) of all orders in window.',            domain: 'orders' },
  heaviest_orders:               { builder: b.heaviestOrders,              describe: 'Heaviest individual orders in window.',                    domain: 'orders' },

  // --- v6: customer aggregates ------------------------------------------
  avg_customer_ltv:              { builder: b.avgCustomerLtv,              describe: 'Average lifetime spend across customers with ≥1 order.',   domain: 'customers' },
  customer_order_frequency:      { builder: b.customerOrderFrequency,      describe: 'Average # of orders per customer.',                         domain: 'customers' },
  repeat_customer_rate:          { builder: b.repeatCustomerRate,          describe: '% of customers with ≥2 orders (storewide, lifetime).',     domain: 'customers' },
  customers_with_orders_above:   { builder: b.customersWithOrdersAbove,    describe: '# customers whose lifetime spend ≥ $threshold.',           domain: 'customers' },
  customers_with_no_orders:      { builder: b.customersWithNoOrders,       describe: 'Customers with 0 orders on file.',                          domain: 'customers' },
  customer_locations_breakdown:  { builder: b.customerLocationsBreakdown,  describe: 'Customers bucketed by last shipping_state.',                domain: 'customers' },
  last_order_date_per_customer:  { builder: b.lastOrderDatePerCustomer,    describe: 'Each customer\'s last order date.',                         domain: 'customers' },
  first_time_buyer_orders:       { builder: b.firstTimeBuyerOrders,        describe: 'Orders that were each customer\'s first order in window.',  domain: 'orders' },
  orders_shipped_this_window:    { builder: b.ordersShippedThisWindow,     describe: 'Orders that were fulfilled within the window.',             domain: 'orders' },

  // --- v6: weekday vs weekend -------------------------------------------
  weekday_vs_weekend:            { builder: b.weekdayVsWeekend,            describe: 'Avg daily revenue weekday vs weekend.',                     domain: 'sales' },

  // --- v6: products / catalog / inventory --------------------------------
  what_products_do_we_sell:      { builder: b.whatProductsDoWeSell,        describe: 'Catalog overview by product_type.',                         domain: 'sales' },
  worst_selling_products:        { builder: b.worstSellingProducts,        describe: 'On-hand SKUs with the lowest 30d/90d sell-through.',        domain: 'sales' },
  newest_products_added:         { builder: b.newestProductsAdded,         describe: 'Most recently created products in the catalog.',            domain: 'sales' },
  inventory_by_location:         { builder: b.inventoryByLocation,         describe: 'Inventory items + on-hand units per location.',             domain: 'inventory' },
  inventory_levels_by_product:   { builder: b.inventoryLevelsByProduct,    describe: 'On-hand per variant (top N).',                              domain: 'inventory' },
  products_not_in_inventory:     { builder: b.productsNotInInventory,      describe: 'Products with no positive inventory level on file.',        domain: 'inventory' },
  inventory_turnover_rate:       { builder: b.inventoryTurnoverRate,       describe: '30d units sold / on-hand (turnover ratio).',                domain: 'inventory' },
  days_of_inventory_remaining:   { builder: b.daysOfInventoryRemaining,    describe: 'Days of cover per SKU at 30d velocity.',                    domain: 'inventory' },

  // --- v6: comparisons ---------------------------------------------------
  week_over_week:                { builder: b.weekOverWeek,                describe: 'Last 7 days vs prior 7 days.',                              domain: 'sales' },
  year_over_year:                { builder: b.yearOverYear,                describe: 'Last 365 days vs prior 365 days.',                          domain: 'sales' },

  // --- v6: capability-not-supported (honest no-data answer) --------------
  capability_unsupported:        { builder: b.capabilityUnsupported,       describe: 'Honest "not in synced data" response.',                     domain: 'meta' },

  // --- v7 (Round-3 56 queries) -------------------------------------------
  orders_by_period_count:        { builder: b.ordersByPeriodCount,         describe: 'How many orders placed in window.',                         domain: 'orders' },
  orders_under_amount:           { builder: b.ordersUnderAmount,           describe: 'Orders with total below $threshold.',                       domain: 'orders' },
  order_count_by_day:            { builder: b.orderCountByDay,             describe: 'Daily order counts grouped by day.',                        domain: 'orders' },
  orders_on_weekends:            { builder: b.ordersOnWeekends,            describe: 'Orders placed on Saturday or Sunday.',                      domain: 'orders' },
  customer_most_orders:          { builder: b.customerMostOrders,          describe: 'Top customer by order count.',                              domain: 'customers' },
  customers_one_time_only_period:{ builder: b.customersOneTimeOnlyPeriod,  describe: 'Customers with exactly one order in window.',               domain: 'customers' },
  customer_retention_rate:       { builder: b.customerRetentionRate,       describe: '% of in-window purchasers who had prior orders.',           domain: 'customers' },
  avg_days_between_orders:       { builder: b.avgDaysBetweenOrders,        describe: 'Avg gap between orders per repeat customer.',               domain: 'customers' },
  bottom_products_by_units:      { builder: b.bottomProductsByUnits,       describe: 'Worst-selling products by units in window.',                domain: 'sales' },
  products_zero_sales_period:    { builder: b.productsZeroSalesPeriod,     describe: 'On-hand SKUs with zero sales in window.',                   domain: 'inventory' },
  newest_products_added_period:  { builder: b.newestProductsAddedPeriod,   describe: 'Products created within window.',                           domain: 'sales' },
  varietal_top_seller:           { builder: b.varietalTopSeller,           describe: 'Top varietal/product by units in window.',                  domain: 'sales' },
  product_count_total:           { builder: b.productCountTotal,           describe: 'Total products + active count.',                            domain: 'sales' },
  inventory_per_product_summary: { builder: b.inventoryPerProductSummary,  describe: 'Per-product variant + on-hand summary.',                    domain: 'inventory' },
  inventory_by_location_most:    { builder: b.inventoryByLocationMost,     describe: 'Location with the most on-hand units.',                     domain: 'inventory' },
  avg_days_to_ship:              { builder: b.avgDaysToShip,               describe: 'Avg days from order to fulfillment.',                       domain: 'orders' },
  orders_same_day_shipped:       { builder: b.ordersSameDayShipped,        describe: 'Orders fulfilled within 24h of creation.',                  domain: 'orders' },
  orders_shipped_within_days:    { builder: b.ordersShippedWithinDays,     describe: 'Orders fulfilled within N days of creation.',               domain: 'orders' },
  most_common_shipping_method:   { builder: b.mostCommonShippingMethod,    describe: 'Most-used shipping method.',                                domain: 'orders' },
  avg_shipping_cost_per_order:   { builder: b.avgShippingCostPerOrder,     describe: 'Avg shipping cost per order.',                              domain: 'orders' },
  orders_pending_shipment:       { builder: b.ordersPendingShipment,       describe: 'Orders that have not yet been fulfilled.',                  domain: 'orders' },
  avg_discount_per_order:        { builder: b.avgDiscountPerOrder,         describe: 'Avg discount $ per order (all orders).',                    domain: 'orders' },
  refund_trend_period:           { builder: b.refundTrendPeriod,           describe: 'Refunds by day in window.',                                 domain: 'orders' },
  total_refunded_period:         { builder: b.totalRefundedPeriod,         describe: 'Sum of refunds in window.',                                 domain: 'orders' },
  orders_between_hours:          { builder: b.ordersBetweenHours,          describe: 'Orders placed between hour A and hour B.',                  domain: 'orders' },
  compare_product_sales_periods: { builder: b.compareProductSalesPeriods,  describe: 'Product-by-product window vs prior-window comparison.',     domain: 'sales' },
  net_after_refunds_discounts:   { builder: b.netAfterRefundsDiscounts,    describe: 'Gross - refunds (cost data not synced).',                   domain: 'orders' },
  avg_tax_per_order:             { builder: b.avgTaxPerOrder,              describe: 'Average sales-tax dollars per order.',                      domain: 'orders' },
  cross_sell_by_category:        { builder: b.crossSellByCategory,         describe: 'Pairs of categories that appear together in same order.',   domain: 'sales' },
  customers_medium_value:        { builder: b.customersMediumValue,        describe: 'Customers whose lifetime spend is in $A-$B range.',          domain: 'customers' },
  orders_never_fulfilled:        { builder: b.ordersNeverFulfilled,        describe: 'Open / unfulfilled orders that never shipped.',             domain: 'orders' },
  completed_orders_period:       { builder: b.completedOrdersPeriod,       describe: 'Fulfilled orders within window.',                           domain: 'orders' },
  all_discount_codes_used:       { builder: b.allDiscountCodesUsed,        describe: 'Distinct discount codes ever used.',                        domain: 'orders' },
  largest_line_item_by_quantity: { builder: b.largestLineItemByQuantity,   describe: 'Single largest line item by quantity.',                     domain: 'sales' },
  product_highest_avg_qty:       { builder: b.productHighestAvgQty,        describe: 'Products with highest avg qty per order.',                  domain: 'sales' },
  orders_containing_product:     { builder: b.ordersContainingProduct,     describe: 'Orders that include lines matching a product hint.',        domain: 'orders' },
  orders_pending_over_days:      { builder: b.ordersPendingOverDays,       describe: 'Unfulfilled orders older than N days.',                     domain: 'orders' },
  repeat_purchase_rate_period:   { builder: b.repeatPurchaseRatePeriod,    describe: '% of purchasers in window with ≥2 orders in window.',       domain: 'customers' },
  avg_time_between_repeat:       { builder: b.avgTimeBetweenRepeat,        describe: 'Avg days between 1st and 2nd order for repeat customers.',  domain: 'customers' },
  orders_with_multiple_lines:    { builder: b.ordersWithMultipleLines,     describe: 'Orders with ≥2 line items / single-item orders.',           domain: 'orders' },
  orders_single_line_item:       { builder: b.ordersWithMultipleLines,     describe: '(alias) — same SQL, formatter shows single-item count.',    domain: 'orders' },
  guest_checkout_orders:         { builder: b.guestCheckoutOrders,         describe: 'Orders with no attached customer record.',                  domain: 'orders' },
  email_subscriber_orders:       { builder: b.emailSubscriberOrders,       describe: 'Orders where customer accepts_marketing = true.',           domain: 'orders' },
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
