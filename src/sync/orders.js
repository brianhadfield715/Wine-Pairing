// src/sync/orders.js
// Reliable, observable orders sync.
//
// Design goals:
//   - Never hang: every external call has a bounded timeout, every loop
//     has a hard cap, and failures throw tagged errors so the route layer
//     can always respond with JSON.
//   - Stream the work: pages are fetched one at a time, each page is
//     upserted in a single bounded DB transaction (orders + line_items
//     batched), and memory never holds more than one page.
//   - Defensive against malformed payloads: every field is null-guarded,
//     non-numeric numerics are coerced, and cancelled orders are kept
//     (with cancelled_at set) so the analytics layer can filter them
//     consistently.
//   - Observable: a `log` callback is invoked for every meaningful step
//     (start, page-fetch, page-write, totals, errors). Pass log: console.log
//     to see it in stdout; the admin route attaches a custom logger.
//
// Inputs (all optional, with safe defaults):
//   days     : number of days back to pull (mapped to updated_at_min)
//   limit    : per-page limit (Shopify max 250, default 100 for stability)
//   max      : soft cap on total orders to process
//   sinceIso : explicit updated_at_min override (wins over `days`)
//   untilIso : explicit updated_at_max
//   maxPages : hard cap on Shopify pages (default 200) to guard against loops
//   log      : (event, payload) => void
//
// Throws errors with `.stage` ∈ { fetch | transform | db_write | pagination }
// so the caller can populate the failure JSON.

const db = require('../db');
const shopify = require('../shopify/client');

const DEFAULT_PER_PAGE = Number(process.env.ORDERS_SYNC_PAGE_SIZE || 100);
const DEFAULT_MAX_PAGES = Number(process.env.ORDERS_SYNC_MAX_PAGES || 200);
const DEFAULT_DAYS = Number(process.env.ORDERS_SYNC_DEFAULT_DAYS || 30);

const ORDER_UPSERT = `
insert into orders (
  id, name, customer_id, email, financial_status, fulfillment_status,
  currency, subtotal_price, total_discounts, total_tax, total_price,
  total_line_items_price, processed_at, created_at, updated_at,
  cancelled_at, closed_at, source_name, tags, raw, synced_at
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now()
)
on conflict (id) do update set
  name                   = excluded.name,
  customer_id            = excluded.customer_id,
  email                  = excluded.email,
  financial_status       = excluded.financial_status,
  fulfillment_status     = excluded.fulfillment_status,
  currency               = excluded.currency,
  subtotal_price         = excluded.subtotal_price,
  total_discounts        = excluded.total_discounts,
  total_tax              = excluded.total_tax,
  total_price            = excluded.total_price,
  total_line_items_price = excluded.total_line_items_price,
  processed_at           = excluded.processed_at,
  created_at             = excluded.created_at,
  updated_at             = excluded.updated_at,
  cancelled_at           = excluded.cancelled_at,
  closed_at              = excluded.closed_at,
  source_name            = excluded.source_name,
  tags                   = excluded.tags,
  raw                    = excluded.raw,
  synced_at              = now()
`;

const LINE_UPSERT = `
insert into order_line_items (
  id, order_id, product_id, variant_id, sku, title, variant_title,
  vendor, quantity, price, total_discount, raw, synced_at
) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
on conflict (id) do update set
  order_id       = excluded.order_id,
  product_id     = excluded.product_id,
  variant_id     = excluded.variant_id,
  sku            = excluded.sku,
  title          = excluded.title,
  variant_title  = excluded.variant_title,
  vendor         = excluded.vendor,
  quantity       = excluded.quantity,
  price          = excluded.price,
  total_discount = excluded.total_discount,
  raw            = excluded.raw,
  synced_at      = now()
`;

// --- helpers --------------------------------------------------------------

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(0, Number(days) || 0));
  return d.toISOString();
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeId(v) {
  // Shopify ids are numeric. Coerce; refuse junk.
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function noop() {}

function stage(err, st) {
  if (err && !err.stage) err.stage = st;
  return err;
}

/**
 * Build the bind values for an order row. Returns null if the order is so
 * malformed we cannot safely store it (no id).
 */
function buildOrderBinds(o) {
  const id = safeId(o && o.id);
  if (!id) return null;
  return [
    id,
    o.name || null,
    safeId(o.customer && o.customer.id),
    o.email || null,
    o.financial_status || null,
    o.fulfillment_status || null,
    o.currency || null,
    num(o.subtotal_price),
    num(o.total_discounts),
    num(o.total_tax),
    num(o.total_price),
    num(o.total_line_items_price),
    o.processed_at || null,
    o.created_at || null,
    o.updated_at || null,
    o.cancelled_at || null,
    o.closed_at || null,
    o.source_name || null,
    o.tags || null,
    o,
  ];
}

/**
 * Build the bind values for one line item. Returns null if junk (no id).
 */
function buildLineBinds(orderId, li) {
  const id = safeId(li && li.id);
  if (!id) return null;
  return [
    id,
    orderId,
    safeId(li.product_id),
    safeId(li.variant_id),
    li.sku || null,
    li.title || null,
    li.variant_title || null,
    li.vendor || null,
    num(li.quantity),
    num(li.price),
    num(li.total_discount),
    li,
  ];
}

/**
 * Write one Shopify page worth of orders + line items inside a single
 * DB transaction. Returns counts. Throws with stage='db_write' on failure.
 */
async function writePage(orders, log) {
  let ordersWritten = 0;
  let linesWritten = 0;
  let skippedOrders = 0;
  let skippedLines = 0;
  let cancelledSeen = 0;

  try {
    await db.withClient(async (client) => {
      await client.query('begin');
      try {
        for (const o of orders) {
          const orderBinds = buildOrderBinds(o);
          if (!orderBinds) {
            skippedOrders += 1;
            log('order_skipped', { reason: 'missing_id', raw_keys: o ? Object.keys(o) : null });
            continue;
          }
          if (o.cancelled_at) cancelledSeen += 1;

          await client.query(ORDER_UPSERT, orderBinds);
          ordersWritten += 1;

          const lineItems = Array.isArray(o.line_items) ? o.line_items : [];
          for (const li of lineItems) {
            const binds = buildLineBinds(orderBinds[0], li);
            if (!binds) {
              skippedLines += 1;
              continue;
            }
            await client.query(LINE_UPSERT, binds);
            linesWritten += 1;
          }
        }
        await client.query('commit');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      }
    });
  } catch (e) {
    throw stage(e, 'db_write');
  }

  return { ordersWritten, linesWritten, skippedOrders, skippedLines, cancelledSeen };
}

// --- main -----------------------------------------------------------------

async function syncOrders(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : noop;
  const t0 = Date.now();

  // Resolve the window. `days` is the friendly knob the route exposes.
  let sinceIso = opts.sinceIso || null;
  if (!sinceIso && opts.days != null) {
    sinceIso = daysAgoIso(opts.days);
  } else if (!sinceIso) {
    sinceIso = daysAgoIso(DEFAULT_DAYS);
  }
  const untilIso = opts.untilIso || null;

  const perPage = Math.min(250, Math.max(1, Number(opts.limit) || DEFAULT_PER_PAGE));
  const maxOrders = Number(opts.max) > 0 ? Number(opts.max) : Infinity;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : DEFAULT_MAX_PAGES;

  log('start', {
    sinceIso,
    untilIso,
    perPage,
    maxOrders: Number.isFinite(maxOrders) ? maxOrders : null,
    maxPages,
    days: opts.days != null ? Number(opts.days) : null,
  });

  // Build initial path. Shopify orders use updated_at_min/_max for windowing,
  // status=any so cancelled / unfulfilled orders are included.
  const params = [
    'status=any',
    `limit=${perPage}`,
    `updated_at_min=${encodeURIComponent(sinceIso)}`,
  ];
  if (untilIso) params.push(`updated_at_max=${encodeURIComponent(untilIso)}`);
  // NOTE: explicitly do NOT send an `order=` param. Shopify uses Link-header
  // cursor pagination once a filter is applied; supplying `order=` can
  // suppress the cursor. Plain Link pagination is the documented path.

  const totals = {
    pages_fetched: 0,
    orders_written: 0,
    line_items_written: 0,
    orders_skipped: 0,
    lines_skipped: 0,
    cancelled_seen: 0,
  };

  let path = `/orders.json?${params.join('&')}`;
  let pageIdx = 0;

  while (path) {
    if (pageIdx >= maxPages) {
      log('pagination_capped', { pageIdx, maxPages });
      break;
    }
    pageIdx += 1;

    // Fetch one page.
    let pageBody;
    let nextUrl = null;
    const tFetch = Date.now();
    try {
      const { body, headers } = await shopify.rest(path, {});
      pageBody = body;
      const link = headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = m ? m[1] : null;
    } catch (e) {
      throw stage(e, 'fetch');
    }
    const orders = Array.isArray(pageBody && pageBody.orders) ? pageBody.orders : [];
    log('page_fetched', {
      page: pageIdx,
      orders_in_page: orders.length,
      elapsed_ms: Date.now() - tFetch,
      has_next: Boolean(nextUrl),
    });

    if (!orders.length) {
      // Nothing on this page but Shopify might still indicate a next cursor;
      // honor it once but cap on maxPages.
      path = nextUrl;
      continue;
    }

    // Cap to the soft `max` if requested.
    let toProcess = orders;
    const remaining = maxOrders - totals.orders_written;
    if (Number.isFinite(remaining) && remaining < orders.length) {
      toProcess = orders.slice(0, Math.max(0, remaining));
    }

    const tWrite = Date.now();
    let pageResult;
    try {
      pageResult = await writePage(toProcess, log);
    } catch (e) {
      // Already stage-tagged by writePage.
      throw e;
    }
    totals.pages_fetched += 1;
    totals.orders_written += pageResult.ordersWritten;
    totals.line_items_written += pageResult.linesWritten;
    totals.orders_skipped += pageResult.skippedOrders;
    totals.lines_skipped += pageResult.skippedLines;
    totals.cancelled_seen += pageResult.cancelledSeen;

    log('page_written', {
      page: pageIdx,
      orders_written: pageResult.ordersWritten,
      line_items_written: pageResult.linesWritten,
      skipped_orders: pageResult.skippedOrders,
      skipped_lines: pageResult.skippedLines,
      cancelled_in_page: pageResult.cancelledSeen,
      elapsed_ms: Date.now() - tWrite,
      totals,
    });

    if (totals.orders_written >= maxOrders) {
      log('max_reached', { totals });
      break;
    }

    // Defensive: detect non-advancing pagination to avoid infinite loops.
    if (nextUrl && nextUrl === path) {
      throw stage(new Error('shopify pagination did not advance'), 'pagination');
    }
    path = nextUrl;
  }

  const elapsed_ms = Date.now() - t0;
  const summary = {
    sinceIso,
    untilIso,
    chunks_processed: totals.pages_fetched, // 1 page == 1 chunk in this design
    pages_fetched: totals.pages_fetched,
    orders_written: totals.orders_written,
    line_items_written: totals.line_items_written,
    orders_skipped: totals.orders_skipped,
    lines_skipped: totals.lines_skipped,
    cancelled_seen: totals.cancelled_seen,
    elapsed_ms,
  };
  log('done', summary);
  return summary;
}

module.exports = { syncOrders };
