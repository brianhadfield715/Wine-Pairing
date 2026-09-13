-- 007_refund_timing.sql
-- Refund attribution now matches Shopify's Finance report (Brian 2026-09-13):
-- a refund reduces sales in the month the REFUND happened, not the month of
-- the original order. Implementation: fact_sales_margin becomes a UNION of
--   (a) sale rows   — occurred_at = order date, no refund netting, discounts
--                     allocated from raw discount_allocations (006 behavior);
--   (b) refund rows — one negative row per refund_line_item, occurred_at =
--                     the refund's processed_at/created_at, negative units,
--                     negative net_revenue (refund subtotal), negative COGS.
-- Sums over any window that contains both events are unchanged; monthly
-- buckets now match Shopify's convention.

drop view if exists fact_sales_margin;
create view fact_sales_margin as
with line_disc as (
  select li.id as line_item_id,
         coalesce((
           select sum((a->>'amount')::numeric)
             from jsonb_array_elements(coalesce(li.raw->'discount_allocations','[]'::jsonb)) a
         ), 0) as allocated_discount
    from order_line_items li
)
-- (a) sale rows
select
  oli.id                                 as line_item_id,
  oli.order_id                           as order_id,
  o.name                                 as order_name,
  o.customer_id                          as customer_id,
  o.email                                as order_email,
  coalesce(o.processed_at, o.created_at) as occurred_at,
  o.financial_status                     as financial_status,
  o.cancelled_at                         as cancelled_at,
  oli.product_id                         as product_id,
  oli.variant_id                         as variant_id,
  coalesce(nullif(oli.sku, ''), '')      as sku,
  oli.title                              as product_title,
  oli.variant_title                      as variant_title,
  oli.vendor                             as vendor,
  coalesce(oli.quantity, 0)              as quantity,
  coalesce(oli.price, 0)::numeric(12,2)  as unit_price,
  (coalesce(oli.quantity, 0) * coalesce(oli.price, 0))::numeric(14,2)
                                         as gross_revenue,
  greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0))::numeric(12,2)
                                         as line_discount,
  0::numeric(12,2)                       as refund_subtotal,
  ((coalesce(oli.quantity, 0) * coalesce(oli.price, 0))
    - greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0)))::numeric(14,2)
                                         as net_revenue,
  vc.unit_cost,
  (coalesce(oli.quantity, 0) * vc.unit_cost)::numeric(14,2)
                                         as line_cost,
  case when vc.unit_cost is not null then
    ((coalesce(oli.quantity, 0) * coalesce(oli.price, 0))
      - greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0))
      - (coalesce(oli.quantity, 0) * vc.unit_cost))::numeric(14,2)
  end                                    as line_margin
from order_line_items oli
join orders o             on o.id = oli.order_id
left join line_disc ld    on ld.line_item_id = oli.id
left join variants v      on v.id = oli.variant_id
left join variant_costs vc on vc.inventory_item_id = v.inventory_item_id
where o.cancelled_at is null

union all

-- (b) refund rows: negative, dated at the refund
select
  oli.id                                 as line_item_id,
  oli.order_id                           as order_id,
  o.name                                 as order_name,
  o.customer_id                          as customer_id,
  o.email                                as order_email,
  coalesce(
    nullif(r->>'processed_at','')::timestamptz,
    nullif(r->>'created_at','')::timestamptz,
    coalesce(o.processed_at, o.created_at)
  )                                      as occurred_at,
  o.financial_status                     as financial_status,
  o.cancelled_at                         as cancelled_at,
  oli.product_id                         as product_id,
  oli.variant_id                         as variant_id,
  coalesce(nullif(oli.sku, ''), '')      as sku,
  oli.title                              as product_title,
  oli.variant_title                      as variant_title,
  oli.vendor                             as vendor,
  -(coalesce((rli->>'quantity')::numeric, 0))::int
                                         as quantity,
  coalesce(oli.price, 0)::numeric(12,2)  as unit_price,
  0::numeric(14,2)                       as gross_revenue,
  0::numeric(12,2)                       as line_discount,
  coalesce((rli->>'subtotal')::numeric, 0)::numeric(12,2)
                                         as refund_subtotal,
  (-coalesce((rli->>'subtotal')::numeric, 0))::numeric(14,2)
                                         as net_revenue,
  vc.unit_cost,
  (-(coalesce((rli->>'quantity')::numeric, 0)) * vc.unit_cost)::numeric(14,2)
                                         as line_cost,
  case when vc.unit_cost is not null then
    (-coalesce((rli->>'subtotal')::numeric, 0)
      + (coalesce((rli->>'quantity')::numeric, 0)) * vc.unit_cost)::numeric(14,2)
  end                                    as line_margin
from orders o,
     jsonb_array_elements(coalesce(o.raw->'refunds','[]'::jsonb)) r,
     jsonb_array_elements(coalesce(r->'refund_line_items','[]'::jsonb)) rli
join order_line_items oli on oli.id = (rli->>'line_item_id')::bigint
left join variants v       on v.id = oli.variant_id
left join variant_costs vc on vc.inventory_item_id = v.inventory_item_id
where o.cancelled_at is null;
