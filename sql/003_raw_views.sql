-- sql/003_raw_views.sql
-- Read-only views that flatten useful fields out of orders.raw JSONB so the
-- BI layer can query them without a re-sync. Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- vw_orders_enriched
--   One row per non-cancelled order with derived fields pulled from raw:
--     shipping_state, shipping_country, payment_gateways, total_weight,
--     shipping_method_title, shipping_cost, has_gift_card, note,
--     note_attribute_count, discount_codes (text[]).
-- ---------------------------------------------------------------------------
create or replace view vw_orders_enriched as
select
  o.id                                                                as order_id,
  o.name                                                              as order_name,
  o.customer_id,
  o.email,
  o.financial_status,
  o.fulfillment_status,
  o.currency,
  o.subtotal_price,
  o.total_discounts,
  o.total_tax,
  o.total_price,
  o.processed_at,
  o.created_at,
  o.updated_at,
  o.cancelled_at,
  o.closed_at,
  o.source_name,
  o.tags,

  -- Shipping address (US-state convention)
  nullif(o.raw->'shipping_address'->>'province_code','')              as shipping_state,
  nullif(o.raw->'shipping_address'->>'province','')                   as shipping_state_name,
  nullif(o.raw->'shipping_address'->>'country_code','')               as shipping_country,
  nullif(o.raw->'shipping_address'->>'city','')                       as shipping_city,
  nullif(o.raw->'shipping_address'->>'zip','')                        as shipping_zip,

  -- Payment gateways: Shopify returns an array of strings.
  (
    select array_agg(distinct lower(g))
      from jsonb_array_elements_text(coalesce(o.raw->'payment_gateway_names','[]'::jsonb)) g
  )                                                                   as payment_gateways,

  -- Shipping line(s): first shipping_lines entry covers the common case.
  nullif(o.raw->'shipping_lines'->0->>'title','')                     as shipping_method_title,
  nullif(o.raw->'shipping_lines'->0->>'source','')                    as shipping_source,
  (
    select coalesce(sum((sl->>'price')::numeric), 0)
      from jsonb_array_elements(coalesce(o.raw->'shipping_lines','[]'::jsonb)) sl
  )::numeric(14,2)                                                    as shipping_cost,

  -- Total order weight in grams (Shopify default).
  nullif(o.raw->>'total_weight','')::numeric                          as total_weight_g,

  -- Notes / attributes.
  nullif(o.raw->>'note','')                                           as note_text,
  coalesce(jsonb_array_length(coalesce(o.raw->'note_attributes','[]'::jsonb)), 0)
                                                                      as note_attribute_count,

  -- Gift card line items.
  exists(
    select 1
      from jsonb_array_elements(coalesce(o.raw->'line_items','[]'::jsonb)) li
     where (li->>'gift_card')::boolean is true
  )                                                                   as has_gift_card,

  -- Discount codes used (array of code strings, lowercase).
  (
    select array_agg(distinct lower(dc->>'code'))
      from jsonb_array_elements(coalesce(o.raw->'discount_codes','[]'::jsonb)) dc
     where coalesce(dc->>'code','') <> ''
  )                                                                   as discount_codes,

  -- Refunds summary (computed once per order).
  coalesce(jsonb_array_length(coalesce(o.raw->'refunds','[]'::jsonb)), 0)
                                                                      as refund_count,
  (
    select coalesce(sum( (tx->>'amount')::numeric ), 0)
      from jsonb_array_elements(coalesce(o.raw->'refunds','[]'::jsonb)) r,
           jsonb_array_elements(coalesce(r->'transactions','[]'::jsonb)) tx
     where lower(coalesce(tx->>'kind',''))   in ('refund','partial_refund')
       and lower(coalesce(tx->>'status','')) = 'success'
  )::numeric(14,2)                                                    as refund_amount,
  (
    select min((r->>'created_at')::timestamptz)
      from jsonb_array_elements(coalesce(o.raw->'refunds','[]'::jsonb)) r
  )                                                                   as first_refund_at,

  -- First fulfillment timestamp (covers most fulfilled orders).
  (
    select min((f->>'created_at')::timestamptz)
      from jsonb_array_elements(coalesce(o.raw->'fulfillments','[]'::jsonb)) f
  )                                                                   as first_fulfilled_at

from orders o;

-- ---------------------------------------------------------------------------
-- vw_refunded_line_items
--   Flattens refunds[].refund_line_items[] so we can rank "products with most
--   returns" / "return rate by product".
-- ---------------------------------------------------------------------------
create or replace view vw_refunded_line_items as
select
  o.id                                                  as order_id,
  o.name                                                as order_name,
  (rli->>'line_item_id')::bigint                        as line_item_id,
  (rli->>'quantity')::int                               as quantity,
  ((rli->>'subtotal')::numeric)::numeric(14,2)          as subtotal,
  (rli->'line_item'->>'sku')                            as sku,
  (rli->'line_item'->>'title')                          as product_title,
  (rli->'line_item'->>'vendor')                         as vendor,
  ((r->>'created_at')::timestamptz)                     as refunded_at
from orders o,
     jsonb_array_elements(coalesce(o.raw->'refunds','[]'::jsonb)) r,
     jsonb_array_elements(coalesce(r->'refund_line_items','[]'::jsonb)) rli;
