#!/usr/bin/env node
// scripts/smoke_33_failures.js
// Unit-level smoke for the 33 phrasings that fell through in round 4 plus
// the 4 named bugs. Each must route to a real registered intent.

const assert = require('assert');
const parser  = require('../src/analytics/intentParser');
const registry = require('../src/analytics/queryRegistry');

const CASES = [
  // Phrase routing (intent should exist, just wasn't catching the wording)
  ['what did we sell the most of last week',          'top_items_by_units'],
  ['what sold the most last week',                    'top_items_by_units'],
  ['what product types do we sell',                   'what_products_do_we_sell'],
  ['list all product categories',                     'what_products_do_we_sell'],
  ['what categories do we have',                      'what_products_do_we_sell'],
  ['when was our first order',                        'oldest_order_date'],
  ['when was our last order',                         'newest_order_date'],
  ['who has bought the most units',                   'top_customers_by_units_purchased'],
  ['who ordered the most units',                      'top_customers_by_units_purchased'],
  ['which customer has the most units',               'top_customers_by_units_purchased'],
  ['customers by total units',                        'top_customers_by_units_purchased'],
  ['what sku have we sold the most of',               'sku_top_seller'],
  ['what sku sold the most',                          'sku_top_seller'],
  ['which sku sold the most',                         'sku_top_seller'],
  ['what variant sold the most',                      'sku_top_seller'],
  ['top variant last week',                           'sku_top_seller'],
  ['chart of sales last week',                        'sales_time_series'],
  ['trending products this month',                    'trending_up'],
  ['average order to delivery time',                  'avg_days_to_ship'],
  ['how long does shipping take',                     'avg_days_to_ship'],

  // New intents
  ['what is the date range of the data in your system','data_date_range'],
  ['what date range does your data cover',             'data_date_range'],
  ['how old is your data',                             'data_date_range'],
  ['when did we last sync data',                       'data_sync_status'],
  ['last data sync time',                              'data_sync_status'],
  ['data last updated',                                'data_sync_status'],
  ['how fresh is your data',                           'data_sync_status'],
  ['when was Brian Hadfield first order',              'customer_first_last_order'],
  ['when was Brian Hadfield last order',               'customer_first_last_order'],
  ['how many unique customers do we have',             'customer_unique_count'],
  ['products on sale',                                 'products_on_sale'],
  ['discounted products',                              'products_on_sale'],
  ['products with a discount',                         'products_on_sale'],

  // The 4 named bugs
  ['bhadfield@myfsi.et last order',                    'customer_first_last_order'],   // Bug A
  ['chart of new vs returning customer counts by month','new_vs_returning_by_month'],   // Bug B
  ['who bought the most units',                        'top_customers_by_units_purchased'], // Bug C
  // Bug D is a visualization fix; tested via live smoke (no intent change).
];

let pass = 0, fail = 0;
const failures = [];
for (const [q, expected] of CASES) {
  const got = parser.parse(q).intent;
  const ok = got === expected;
  if (ok) {
    console.log(`  ok   "${q}" -> ${got}`);
    pass += 1;
  } else {
    console.log(`  FAIL "${q}" -> expected=${expected} got=${got}`);
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
console.log(`33-failure smoke: ${pass}/${CASES.length} passed, ${fail} failed, ${missingRegistry} unregistered`);
if (fail > 0 || missingRegistry > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f.q}: expected ${f.expected}, got ${f.got}`));
  process.exit(1);
}
process.exit(0);
