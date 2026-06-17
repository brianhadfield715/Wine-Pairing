#!/usr/bin/env node
// scripts/smoke_84_queries.js
// Pure unit-level smoke for the 84 spec queries. Confirms each routes to a
// real registered intent (not general_help, unless explicitly designed to).

const assert = require('assert');
const parser = require('../src/analytics/intentParser');
const registry = require('../src/analytics/queryRegistry');

const CASES = [
  // Format: [question, expectedIntent OR allowedIntents[]]
  ['orders by status',                       'order_status_breakdown'],
  ['refunded orders count',                  'refunded_orders_count'],
  ['canceled orders',                        'cancelled_orders_count'],
  ['highest order value',                    'highest_order_total'],
  ['lowest order value',                     'lowest_order_total'],
  ['what products do we sell',               'what_products_do_we_sell'],
  ['worst selling product',                  'worst_selling_products'],
  ['how many SKUs do we have',               'inventory_count_in_stock'],
  ['product categories breakdown',           'what_products_do_we_sell'],
  ['newest products added',                  'newest_products_added'],
  ['average customer lifetime value',        'avg_customer_ltv'],
  ['customer order frequency',               'customer_order_frequency'],
  ['customer locations breakdown',           'customer_locations_breakdown'],
  ['customers with no orders',               'customers_with_no_orders'],
  ['inventory status',                       'data_coverage_all'],
  ['inventory levels by product',            'inventory_levels_by_product'],
  ['inventory by location',                  'inventory_by_location'],
  ['products not in inventory',              'products_not_in_inventory'],
  ['orders placed after 5pm',                'orders_after_hour'],
  ['orders over $500',                       'orders_above'],
  ['orders from first time buyers',          'first_time_buyer_orders'],
  ['average items per order',                'avg_items_per_order'],
  ['largest order ever',                     'highest_order_total'],
  ['orders with discounts',                  'orders_with_discounts'],
  ['order completion rate',                  'order_completion_rate'],
  ['fulfillment status breakdown',           'fulfillment_status_breakdown'],
  ['orders shipped this week',               'orders_shipped_this_window'],
  ['orders pending fulfillment',             'orders_pending_fulfillment'],
  ['week over week comparison',              'week_over_week'],
  ['busiest day of the week',                'busiest_period_pattern'],
  ['busiest hour of the day',                'busiest_period_pattern'],
  ['total discounts given',                  'total_discounts_given'],
  ['total taxes collected',                  'total_taxes_collected'],
  ['payment method breakdown',               'payment_method_breakdown'],
  ['orders paid with credit card',           'orders_by_gateway'],
  ['orders paid with PayPal',                'orders_by_gateway'],
  ['traffic sources',                        'capability_unsupported'],
  ['conversion rate',                        'capability_unsupported'],
  ['abandoned cart rate',                    'capability_unsupported'],
  ['email campaign performance',             'capability_unsupported'],
  ['average shipping time',                  'avg_fulfillment_time'],
  ['orders shipped to state',                'orders_shipped_to_state'],
  ['most common shipping state',             'orders_shipped_to_state'],
  ['international orders count',             'international_orders_count'],
  ['year over year growth',                  'year_over_year'],
  ['weekday vs weekend sales',               'weekday_vs_weekend'],
  ['total line items sold',                  'total_line_items_sold'],
  ['average quantity per line item',         'avg_quantity_per_line_item'],
  ['orders with free shipping',              'free_shipping_orders'],
  ['gift card orders',                       'orders_with_gift_cards'],
  ['total tags used on orders',              'orders_by_tag'],
  ['orders tagged with VIP',                 'orders_by_tag'],
  ['draft orders count',                     'draft_orders_count'],
  ['archived orders count',                  'archived_orders_count'],
  ['orders with notes',                      'orders_with_notes'],
  ['orders with custom attributes',          'orders_with_custom_attrs'],
  ['high value customers this month',        ['top_customers_by_spend','top_customers_by_aov']],
  ['customers who spent over $1000',         'customers_with_orders_above'],
  ['last order date per customer',           'last_order_date_per_customer'],
  ['churned customers in last 30 days',      'lapsed_customers'],
  ['inventory turnover rate',                'inventory_turnover_rate'],
  ['days of inventory remaining',            'days_of_inventory_remaining'],
  ['orders by referrer',                     'orders_by_referrer'],
  ['which day has the most orders',          'busiest_period_pattern'],
  ['average order lead time',                'avg_fulfillment_time'],
  ['total weight of all orders',             'total_weight'],
  ['heaviest orders',                        'heaviest_orders'],
  ['orders with same day shipping',          'orders_by_shipping_title'],
  ['orders with express shipping',           'orders_by_shipping_title'],
  ['refund rate percentage',                 'refund_rate_and_avg'],
  ['average refund amount',                  'refund_rate_and_avg'],
  ['how long do refunds take',               'refund_rate_and_avg'],
  ['products with most returns',             'products_with_most_returns'],
  ['return rate by product',                 'products_with_most_returns'],
  ['store pick up orders',                   'orders_by_shipping_title'],
  ['local delivery orders',                  'orders_by_shipping_title'],
  ['shipping cost breakdown',                'shipping_method_breakdown'],
  ['free shipping threshold performance',    'free_shipping_orders'],
  ['coupon usage rate',                      'coupon_usage_rate'],
  ['which discount codes are used most',     'top_discount_codes'],
  ['average discount percentage',            'avg_discount_percentage'],
  ['orders without discount',                'orders_without_discount'],
  ['wholesale orders',                       'orders_by_tag'],
  ['retail orders',                          'orders_by_tag'],
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

// Bonus: every classified intent (other than capability_unsupported) must
// resolve to a registered builder in queryRegistry.
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
console.log(`84-query smoke: ${pass}/${CASES.length} passed, ${fail} failed, ${missingRegistry} unregistered intents`);
if (fail > 0 || missingRegistry > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f.q}: expected ${JSON.stringify(f.expected)}, got ${f.got}`));
  process.exit(1);
}
process.exit(0);
