-- 004_costs.sql
-- COGS support: unit cost per variant (from Shopify InventoryItem.cost) and
-- margin-aware sales fact view.
--
-- Data flow: /admin/sync/costs pulls inventory_items for every variant's
-- inventory_item_id and upserts unit_cost here. fact_sales_margin joins it
-- into the line-item fact so every margin query is one view away.
--
-- READ-ONLY against Shopify: this migration + sync only pull data down.

create table if not exists variant_costs (
  inventory_item_id bigint primary key,
  variant_id        bigint,
  sku               text,
  unit_cost         numeric(12,2),
  currency          text,
  tracked           boolean,
  updated_at        timestamptz,
  synced_at         timestamptz not null default now()
);

create index if not exists idx_variant_costs_variant_id on variant_costs (variant_id);
create index if not exists idx_variant_costs_sku        on variant_costs (sku);

-- ---------------------------------------------------------------------------
-- fact_sales_margin
--   fact_sales + unit cost. cost fields are NULL when the variant has no
--   recorded cost (5% of catalog as of 2026-09): margin queries must always
--   surface covered vs uncovered so nobody mistakes partial for whole.
-- ---------------------------------------------------------------------------
create or replace view fact_sales_margin as
select
  fs.*,
  vc.unit_cost,
  (fs.quantity * vc.unit_cost)::numeric(14,2)                        as line_cost,
  case when vc.unit_cost is not null
       then (fs.net_revenue - fs.quantity * vc.unit_cost)::numeric(14,2)
  end                                                                as line_margin
from fact_sales fs
left join variants v        on v.id = fs.variant_id
left join variant_costs vc  on vc.inventory_item_id = v.inventory_item_id;
