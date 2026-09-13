-- 005_true_margin.sql
-- Correct fact_sales_margin to match Shopify's Finance-summary definitions
-- (2026-09-13, found by Brian comparing against Shopify's native report):
--
--   1. DISCOUNTS: Harvest applies order-level discount codes; Shopify spreads
--      them across lines via line_items[].discount_allocations. The line's
--      total_discount field stays 0.00, so the old view treated ~$73k/yr of
--      discounts as revenue. Read allocations from the stored raw JSONB;
--      fall back to total_discount when allocations are absent.
--   2. RETURNS: refunds (order raw -> refunds[].refund_line_items) now net
--      out both revenue and units, so GM = net sales - COGS like Shopify's
--      gross profit. Refunds are attributed to the ORDER's month (Shopify's
--      finance report attributes them to the refund date — small timing
--      differences between the two reports are expected, totals reconcile).
--
-- fact_sales (used by the 173 existing revenue queries) is left untouched;
-- this view feeds only the margin/commission intents.

create or replace view fact_sales_margin as
with line_disc as (
  select li.id as line_item_id,
         coalesce((
           select sum((a->>'amount')::numeric)
             from jsonb_array_elements(coalesce(li.raw->'discount_allocations','[]'::jsonb)) a
         ), 0) as allocated_discount
    from order_line_items li
),
line_refund as (
  select li.id as line_item_id,
         coalesce(sum((rli->>'quantity')::numeric), 0)              as refund_qty,
         coalesce(sum((rli->>'subtotal')::numeric), 0)              as refund_subtotal
    from order_line_items li
    join orders o on o.id = li.order_id,
         jsonb_array_elements(coalesce(o.raw->'refunds','[]'::jsonb)) r,
         jsonb_array_elements(coalesce(r->'refund_line_items','[]'::jsonb)) rli
   where (rli->>'line_item_id')::bigint = li.id
   group by li.id
)
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
  -- net units: sold minus returned
  (coalesce(oli.quantity, 0) - coalesce(lr.refund_qty, 0))          as quantity,
  coalesce(oli.price, 0)::numeric(12,2)  as unit_price,
  (coalesce(oli.quantity, 0) * coalesce(oli.price, 0))::numeric(14,2)
                                         as gross_revenue,
  greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0))::numeric(12,2)
                                         as line_discount,
  coalesce(lr.refund_subtotal, 0)::numeric(12,2)
                                         as refund_subtotal,
  -- net sales, Shopify definition: gross - discounts - returns
  ((coalesce(oli.quantity, 0) * coalesce(oli.price, 0))
    - greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0))
    - coalesce(lr.refund_subtotal, 0))::numeric(14,2)
                                         as net_revenue,
  vc.unit_cost,
  -- COGS on net (kept) units only
  ((coalesce(oli.quantity, 0) - coalesce(lr.refund_qty, 0)) * vc.unit_cost)::numeric(14,2)
                                         as line_cost,
  case when vc.unit_cost is not null then
    (((coalesce(oli.quantity, 0) * coalesce(oli.price, 0))
      - greatest(coalesce(ld.allocated_discount, 0), coalesce(oli.total_discount, 0))
      - coalesce(lr.refund_subtotal, 0))
     - ((coalesce(oli.quantity, 0) - coalesce(lr.refund_qty, 0)) * vc.unit_cost))::numeric(14,2)
  end                                    as line_margin
from order_line_items oli
join orders o           on o.id = oli.order_id
left join line_disc ld   on ld.line_item_id = oli.id
left join line_refund lr on lr.line_item_id = oli.id
left join variants v     on v.id = oli.variant_id
left join variant_costs vc on vc.inventory_item_id = v.inventory_item_id
where o.cancelled_at is null;
