-- sql/001_init.sql
-- Base tables for Harvest Wine Market analytics warehouse.
-- All Shopify ids are stored as BIGINT (Shopify uses 64-bit numeric ids).
-- Idempotent: safe to re-run.

create table if not exists schema_migrations (
  filename     text primary key,
  applied_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists products (
  id              bigint primary key,
  title           text,
  handle          text,
  vendor          text,
  product_type    text,
  status          text,
  tags            text,
  body_html       text,
  created_at      timestamptz,
  updated_at      timestamptz,
  published_at    timestamptz,
  raw             jsonb,
  synced_at       timestamptz not null default now()
);

create index if not exists idx_products_vendor       on products (vendor);
create index if not exists idx_products_product_type on products (product_type);
create index if not exists idx_products_status       on products (status);

-- ---------------------------------------------------------------------------
-- variants
-- ---------------------------------------------------------------------------
create table if not exists variants (
  id                  bigint primary key,
  product_id          bigint not null references products(id) on delete cascade,
  sku                 text,
  title               text,
  price               numeric(12,2),
  compare_at_price    numeric(12,2),
  inventory_item_id   bigint,
  inventory_quantity  integer,
  position            integer,
  barcode             text,
  raw                 jsonb,
  synced_at           timestamptz not null default now()
);

create index if not exists idx_variants_product_id        on variants (product_id);
create index if not exists idx_variants_sku               on variants (sku);
create index if not exists idx_variants_inventory_item_id on variants (inventory_item_id);

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------
create table if not exists locations (
  id          bigint primary key,
  name        text,
  active      boolean,
  country     text,
  province    text,
  city        text,
  raw         jsonb,
  synced_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- inventory_levels_current
--   Latest known on-hand per (inventory_item, location).
-- ---------------------------------------------------------------------------
create table if not exists inventory_levels_current (
  inventory_item_id  bigint not null,
  location_id        bigint not null,
  available          integer,
  updated_at         timestamptz,
  synced_at          timestamptz not null default now(),
  primary key (inventory_item_id, location_id)
);

create index if not exists idx_inv_current_item on inventory_levels_current (inventory_item_id);

-- ---------------------------------------------------------------------------
-- inventory_snapshots
--   Append-only daily snapshots for velocity / dead-stock analysis.
-- ---------------------------------------------------------------------------
create table if not exists inventory_snapshots (
  snapshot_date      date    not null,
  inventory_item_id  bigint  not null,
  location_id        bigint  not null,
  available          integer,
  primary key (snapshot_date, inventory_item_id, location_id)
);

create index if not exists idx_inv_snap_date on inventory_snapshots (snapshot_date);

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id                  bigint primary key,
  email               text,
  first_name          text,
  last_name           text,
  phone               text,
  orders_count        integer,
  total_spent         numeric(14,2),
  state               text,
  tags                text,
  created_at          timestamptz,
  updated_at          timestamptz,
  raw                 jsonb,
  synced_at           timestamptz not null default now()
);

create index if not exists idx_customers_email on customers (email);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id                     bigint primary key,
  name                   text,
  customer_id            bigint,
  email                  text,
  financial_status       text,
  fulfillment_status     text,
  currency               text,
  subtotal_price         numeric(14,2),
  total_discounts        numeric(14,2),
  total_tax              numeric(14,2),
  total_price            numeric(14,2),
  total_line_items_price numeric(14,2),
  processed_at           timestamptz,
  created_at             timestamptz,
  updated_at             timestamptz,
  cancelled_at           timestamptz,
  closed_at              timestamptz,
  source_name            text,
  tags                   text,
  raw                    jsonb,
  synced_at              timestamptz not null default now()
);

create index if not exists idx_orders_customer_id  on orders (customer_id);
create index if not exists idx_orders_processed_at on orders (processed_at);
create index if not exists idx_orders_created_at   on orders (created_at);

-- ---------------------------------------------------------------------------
-- order_line_items
-- ---------------------------------------------------------------------------
create table if not exists order_line_items (
  id                bigint primary key,
  order_id          bigint not null references orders(id) on delete cascade,
  product_id        bigint,
  variant_id        bigint,
  sku               text,
  title             text,
  variant_title     text,
  vendor            text,
  quantity          integer,
  price             numeric(12,2),
  total_discount    numeric(12,2),
  raw               jsonb,
  synced_at         timestamptz not null default now()
);

create index if not exists idx_oli_order_id   on order_line_items (order_id);
create index if not exists idx_oli_product_id on order_line_items (product_id);
create index if not exists idx_oli_variant_id on order_line_items (variant_id);
create index if not exists idx_oli_sku        on order_line_items (sku);
