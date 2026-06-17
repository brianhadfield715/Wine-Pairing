#!/usr/bin/env node
// scripts/smoke_56_queries.js
// Unit-level smoke for the Round-3 56 queries. Each must route to a real
// registered intent (not general_help).

const assert = require('assert');
const parser  = require('../src/analytics/intentParser');
const registry = require('../src/analytics/queryRegistry');

const CASES = [
  ['how many orders placed today',                       'orders_by_period_count'],
  ['orders in the last 24 hours',                        'orders_by_period_count'],
  ['how many orders under $50',                          'orders_under_amount'],
  ['order count by day last week',                       'order_count_by_day'],
  ['how many orders were placed on weekends',            'orders_on_weekends'],
  ['how many orders have a note',                        'orders_with_notes'],
  ['orders with total over $200',                        'orders_above'],
  ['customer with most orders',                          'customer_most_orders'],
  ['customers who ordered only once this month',         'customers_one_time_only_period'],
  ['customer retention rate this quarter',               'customer_retention_rate'],
  ['average days between orders per customer',           'avg_days_between_orders'],
  ['bottom 5 products by units',                         'bottom_products_by_units'],
  ['products with zero sales this month',                'products_zero_sales_period'],
  ['new products added in the last 30 days',             'newest_products_added_period'],
  ['which varietal sells the most',                      'varietal_top_seller'],
  ['how many products do we have',                       'product_count_total'],
  ['current inventory count per product',                'inventory_per_product_summary'],
  ['which location has most inventory',                  'inventory_by_location_most'],
  ['average days to ship an order',                      'avg_days_to_ship'],
  ['how many orders shipped same day',                   'orders_same_day_shipped'],
  ['orders shipped within 2 days',                       'orders_shipped_within_days'],
  ['most common shipping method',                        'most_common_shipping_method'],
  ['average shipping cost per order',                    'avg_shipping_cost_per_order'],
  ['orders pending shipment right now',                  'orders_pending_shipment'],
  ['orders fulfilled this week',                         'orders_shipped_this_window'],
  ['average discount per order',                         'avg_discount_per_order'],
  ['refunds this month amount',                          'total_refunded_period'],
  ['average refund processing time',                     'refund_rate_and_avg'],
  ['products with most refund requests',                 'products_with_most_returns'],
  ['refund trend over last 30 days',                     'refund_trend_period'],
  ['total refunded this quarter',                        'total_refunded_period'],
  ['busiest hour today',                                 'busiest_hour'],
  ['which hour has most orders',                         'busiest_period_pattern'],
  ['orders placed between 6pm and 9pm',                  'orders_between_hours'],
  ['compare product sales this month to last month',     'compare_product_sales_periods'],
  ['net profit after refunds and discounts this month',  'net_after_refunds_discounts'],
  ['average tax per order',                              'avg_tax_per_order'],
  ['cross sell patterns by category',                    'cross_sell_by_category'],
  ['medium value customers $100 to $500',                'customers_medium_value'],
  ['orders still in draft status',                       'draft_orders_count'],
  ['orders that were never fulfilled',                   'orders_never_fulfilled'],
  ['how many completed orders this month',               'completed_orders_period'],
  ['all discount codes used',                            'all_discount_codes_used'],
  ['orders grouped by discount code',                    'top_discount_codes'],
  ['orders from wholesale customers',                    'orders_by_tag'],
  ['orders from retail customers',                       'orders_by_tag'],
  ['largest single line item by quantity',               'largest_line_item_by_quantity'],
  ['product with highest average quantity per order',    'product_highest_avg_qty'],
  ['how many orders include champagne',                  'orders_containing_product'],
  ['orders pending more than 3 days',                    'orders_pending_over_days'],
  ['repeat purchase rate last 30 days',                  'repeat_purchase_rate_period'],
  ['average time between repeat purchases',              'avg_time_between_repeat'],
  ['orders with multiple line items',                    'orders_with_multiple_lines'],
  ['orders with single item only',                       'orders_single_line_item'],
  ['how many guest checkout orders',                     'guest_checkout_orders'],
  ['email subscriber orders this month',                 'email_subscriber_orders'],
];

let pass = 0, fail = 0;
const failures = [];
for (const [q, expected] of CASES) {
  const got = parser.parse(q).intent;
  const ok = Array.isArray(expected) ? expected.includes(got) : got === expected;
  if (ok) {
    console.log(`  ok   "${q}" -> ${got}`);
    pass += 1;
  } else {
    console.log(`  FAIL "${q}" -> expected=${JSON.stringify(expected)} got=${got}`);
    failures.push({ q, expected, got });
    fail += 1;
  }
}

let missingRegistry = 0;
for (const [q] of CASES) {
  const got = parser.parse(q).intent;
  if (got === 'general_help' || got === 'invalid_date') continue;
  if (!registry.get(got)) {
    console.log(`  REG  "${q}" -> ${got} (NOT IN REGISTRY)`);
    missingRegistry += 1;
  }
}

console.log('');
console.log(`56-query smoke: ${pass}/${CASES.length} passed, ${fail} failed, ${missingRegistry} unregistered`);
if (fail > 0 || missingRegistry > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f.q}: expected ${JSON.stringify(f.expected)}, got ${f.got}`));
  process.exit(1);
}
process.exit(0);
