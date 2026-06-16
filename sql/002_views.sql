-- sql/002_views.sql
-- Analytics views used by the /shopify-qa analytics engine.
-- All views are read-only. They are owned by the application user and may be
-- re-created safely (CREATE OR REPLACE).

-- ---------------------------------------------------------------------------
-- vw_current_inventory
--   Per-variant current on-hand (summed across locations), with product
--   identity and price. Drives "low stock", "out of stock", "in stock under
--   $N", "dead inventory" style questions.
-- ---------------------------------------------------------------------------
create or replace view vw_current_inventory as
select
  p.id                          as product_id,
  p.title                       as product_title,
  p.handle                      as product_handle,
  p.vendor                      as vendor,
  p.product_type                as product_type,
  p.status                      as product_status,
  v.id                          as variant_id,
  coalesce(nullif(v.sku, ''), '') as sku,
  v.title                       as variant_title,
  v.price                       as price,
  v.inventory_item_id           as inventory_item_id,
  coalesce(
    (select sum(ilc.available)
     from inventory_levels_current ilc
     where ilc.inventory_item_id = v.inventory_item_id),
    v.inventory_quantity,
    0
  )::int                        as on_hand
from products p
join variants v on v.product_id = p.id;

-- ---------------------------------------------------------------------------
-- fact_sales
--   One row per line item with order context, used for top SKUs, vendor
--   performance, customer spend, time-window queries.
-- ---------------------------------------------------------------------------
create or replace view fact_sales as
select
  oli.id                                as line_item_id,
  oli.order_id                          as order_id,
  o.name                                as order_name,
  o.customer_id                         as customer_id,
  o.email                               as order_email,
  coalesce(o.processed_at, o.created_at) as occurred_at,
  o.financial_status                    as financial_status,
  o.cancelled_at                        as cancelled_at,
  oli.product_id                        as product_id,
  oli.variant_id                        as variant_id,
  coalesce(nullif(oli.sku, ''), '')     as sku,
  oli.title                             as product_title,
  oli.variant_title                     as variant_title,
  oli.vendor                            as vendor,
  coalesce(oli.quantity, 0)             as quantity,
  coalesce(oli.price, 0)::numeric(12,2) as unit_price,
  (coalesce(oli.quantity, 0) * coalesce(oli.price, 0))::numeric(14,2)
                                        as gross_revenue,
  coalesce(oli.total_discount, 0)::numeric(12,2)
                                        as line_discount,
  ((coalesce(oli.quantity, 0) * coalesce(oli.price, 0))
    - coalesce(oli.total_discount, 0))::numeric(14,2)
                                        as net_revenue
from order_line_items oli
join orders o on o.id = oli.order_id
where o.cancelled_at is null;

-- ---------------------------------------------------------------------------
-- dim_customer_profile
--   Per-customer spend, frequency, recency, and a derived buying profile
--   (favorite vendor + favorite product type by net revenue).
-- ---------------------------------------------------------------------------
create or replace view dim_customer_profile as
with sales as (
  select customer_id,
         vendor,
         (select p.product_type from products p where p.id = fs.product_id) as product_type,
         net_revenue,
         occurred_at
  from fact_sales fs
  where customer_id is not null
),
agg as (
  select
    customer_id,
    sum(net_revenue)::numeric(14,2) as total_spend,
    count(distinct order_id_for_count) filter (where order_id_for_count is not null) as order_count,
    min(occurred_at) as first_order_at,
    max(occurred_at) as last_order_at
  from (
    select fs.customer_id,
           fs.order_id as order_id_for_count,
           fs.net_revenue,
           fs.occurred_at
    from fact_sales fs
    where fs.customer_id is not null
  ) s
  group by customer_id
),
fav_vendor as (
  select distinct on (customer_id)
         customer_id,
         vendor as favorite_vendor,
         sum(net_revenue) over (partition by customer_id, vendor) as vendor_spend
  from sales
  where vendor is not null and vendor <> ''
  order by customer_id, vendor_spend desc nulls last
),
fav_type as (
  select distinct on (customer_id)
         customer_id,
         product_type as favorite_product_type,
         sum(net_revenue) over (partition by customer_id, product_type) as type_spend
  from sales
  where product_type is not null and product_type <> ''
  order by customer_id, type_spend desc nulls last
)
select
  c.id                       as customer_id,
  c.email                    as email,
  trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as customer_name,
  coalesce(a.total_spend, 0) as total_spend,
  coalesce(a.order_count, 0) as order_count,
  a.first_order_at           as first_order_at,
  a.last_order_at            as last_order_at,
  case when a.last_order_at is not null
       then (extract(epoch from (now() - a.last_order_at)) / 86400)::int
       else null end          as days_since_last_order,
  fv.favorite_vendor         as favorite_vendor,
  ft.favorite_product_type   as favorite_product_type
from customers c
left join agg a       on a.customer_id   = c.id
left join fav_vendor fv on fv.customer_id = c.id
left join fav_type   ft on ft.customer_id = c.id;

-- ---------------------------------------------------------------------------
-- dim_sku_profile
--   Per-SKU lifetime sales aggregates + current on-hand, used for top
--   sellers, dead inventory, and low-stock-but-high-velocity questions.
-- ---------------------------------------------------------------------------
create or replace view dim_sku_profile as
with sales as (
  select
    sku,
    max(product_title) as product_title,
    max(vendor)        as vendor,
    sum(quantity)      as units_sold,
    sum(net_revenue)   as net_revenue,
    max(occurred_at)   as last_sold_at,
    sum(case when occurred_at >= now() - interval '30 days' then quantity else 0 end) as units_sold_30d,
    sum(case when occurred_at >= now() - interval '90 days' then quantity else 0 end) as units_sold_90d
  from fact_sales
  where sku <> ''
  group by sku
),
inv as (
  select sku,
         sum(on_hand) as on_hand
  from vw_current_inventory
  where sku <> ''
  group by sku
)
select
  coalesce(s.sku, i.sku)               as sku,
  s.product_title                      as product_title,
  s.vendor                             as vendor,
  coalesce(s.units_sold, 0)::int       as units_sold,
  coalesce(s.units_sold_30d, 0)::int   as units_sold_30d,
  coalesce(s.units_sold_90d, 0)::int   as units_sold_90d,
  coalesce(s.net_revenue, 0)::numeric(14,2) as net_revenue,
  s.last_sold_at                       as last_sold_at,
  coalesce(i.on_hand, 0)::int          as on_hand
from sales s
full outer join inv i on i.sku = s.sku;

-- ---------------------------------------------------------------------------
-- fact_basket_pairs
--   Co-purchase pairs at the order level, used for "what sells together".
--   Each unordered pair is emitted once per order via a < b. Counts are
--   distinct orders containing the pair.
-- ---------------------------------------------------------------------------
create or replace view fact_basket_pairs as
with line_items as (
  select distinct order_id, sku, product_title
  from fact_sales
  where sku <> ''
)
select
  a.sku                            as sku_a,
  max(a.product_title)             as title_a,
  b.sku                            as sku_b,
  max(b.product_title)             as title_b,
  count(distinct a.order_id)::int  as orders_together
from line_items a
join line_items b
  on a.order_id = b.order_id
 and a.sku < b.sku
group by a.sku, b.sku;
