// src/analytics/formatters.js
// Produces the manager-facing answer string for each intent. Long lists are
// truncated; structured data lives in the JSON response's `data` field.

function money(n) {
  if (n == null) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function intish(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function nameOrEmail(row) {
  return (row.customer_name && row.customer_name.trim()) || row.email || `#${row.customer_id || '?'}`;
}

function shortDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return String(iso); }
}

function windowLabel(plan) {
  if (!plan) return '';
  const tf = plan.timeframe;
  if (!tf) return '';
  if (tf.label) return ` (${tf.label})`;
  return '';
}

const F = {
  // -------- customer aggregates ------------------------------------------
  top_customers_by_spend(rows, plan) {
    if (!rows.length) return 'No customers with spend on file.';
    const top = rows.slice(0, 5).map((r, i) =>
      `${i + 1}. ${nameOrEmail(r)} — ${money(r.total_spend)} (${intish(r.order_count)} orders)`
    );
    return `Top spenders${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  customer_profile(rows, plan) {
    if (!rows.length) return 'No matching customer found.';
    if (rows.length === 1) {
      const r = rows[0];
      const bits = [`${nameOrEmail(r)} — ${money(r.total_spend)} across ${intish(r.order_count)} orders`];
      if (r.favorite_vendor) bits.push(`favorite vendor: ${r.favorite_vendor}`);
      if (r.favorite_product_type) bits.push(`favorite category: ${r.favorite_product_type}`);
      if (r.last_order_at) bits.push(`last order: ${shortDate(r.last_order_at)}`);
      return bits.join(' · ');
    }
    return `Recent active customers (${rows.length}). See data for details.`;
  },

  customer_spend(rows, plan) {
    const r = rows[0] || {};
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const who2 = who || '(unknown)';
    if (!r.total_spend || Number(r.total_spend) === 0) {
      return `${who2} has no recorded spend${windowLabel(plan)}.`;
    }
    const aov = r.average_order_value || (r.order_count ? Number(r.total_spend) / Number(r.order_count) : 0);
    return `${who2} spent ${money(r.total_spend)}${windowLabel(plan)} across ${intish(r.order_count)} orders. Average order value: ${money(aov)}.`;
  },

  customer_order_count(rows, plan) {
    const r = rows[0] || {};
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || '(unknown)'} placed ${intish(r.order_count)} order(s)${windowLabel(plan)}.`;
  },

  customer_aov(rows, plan) {
    const r = rows[0] || {};
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || '(unknown)'} average order value${windowLabel(plan)}: ${money(r.average_order_value)} (${intish(r.order_count)} orders).`;
  },

  customer_recent_purchases(rows, plan) {
    if (!rows.length) return `No purchases found${windowLabel(plan)}.`;
    const top = rows.slice(0, 8).map((r) =>
      `${shortDate(r.occurred_at)} · ${r.product_title || '(unknown)'} (${r.sku || '-'}) × ${intish(r.quantity)} — ${money(r.net_revenue)}`
    );
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || 'Customer'} recent purchases${windowLabel(plan)} (${rows.length}):\n${top.join('\n')}`;
  },

  customers_who_bought(rows, plan) {
    if (!rows.length) return 'No customers matched.';
    const top = rows.slice(0, 5).map((r) => `${nameOrEmail(r)} — ${intish(r.units)} units, ${money(r.spend)}`);
    return `Matched ${rows.length} customer(s)${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  customer_count(rows) {
    const r = rows[0] || {};
    return `Customers: ${intish(r.total_customers)} total, ${intish(r.customers_with_orders)} with orders, ${intish(r.active_90d)} active in last 90 days.`;
  },

  new_customers(rows, plan) {
    if (!rows.length) return `No new customers${windowLabel(plan)}.`;
    const top = rows.slice(0, 5).map((r) =>
      `${nameOrEmail(r)} — first order ${shortDate(r.first_order_at)}, ${money(r.total_spend)} lifetime`
    );
    return `${rows.length} new customer(s)${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  lapsed_customers(rows) {
    if (!rows.length) return 'No lapsed customers found.';
    const top = rows.slice(0, 5).map((r) =>
      `${nameOrEmail(r)} — ${money(r.total_spend)}, last seen ${intish(r.days_since_last_order)}d ago`
    );
    return `Lapsed customers (${rows.length}):\n${top.join('\n')}`;
  },

  customers_one_time_only(rows, plan) {
    if (!rows.length) return 'No one-time customers in window.';
    const top = rows.slice(0, 5).map((r) => `${nameOrEmail(r)} — ${money(r.total_spend)} on ${shortDate(r.first_order_at)}`);
    return `One-time customers${windowLabel(plan)} (${rows.length}):\n${top.join('\n')}`;
  },

  top_customers_by_varietal(rows, plan) {
    if (!rows.length) return `No customers matched that varietal${windowLabel(plan)}.`;
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${nameOrEmail(r)} — ${money(r.spend)} (${intish(r.units)} units)`);
    return `Top spenders on ${plan && plan.params && plan.params.varietal ? plan.params.varietal : 'that varietal'}${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  top_customers_by_vendor(rows, plan) {
    if (!rows.length) return `No customers matched that vendor${windowLabel(plan)}.`;
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${nameOrEmail(r)} — ${money(r.spend)} (${intish(r.units)} units)`);
    return `Top spenders on ${plan && plan.params && plan.params.vendor ? plan.params.vendor : 'that vendor'}${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  // -------- basket --------------------------------------------------------
  basket_pairs(rows) {
    if (!rows.length) return 'No product-pair data found yet.';
    return rows.map((r, i) =>
      `${i + 1}. ${r.product_a} + ${r.product_b} — ${intish(r.times_bought_together)} orders`
    ).join('\n');
  },

  bought_with_product(rows, plan) {
    if (!rows.length) return 'No co-purchase data for that product.';
    const top = rows.slice(0, 8).map((r, i) => `${i + 1}. ${r.product} (${r.sku || '-'}) — ${intish(r.orders_together)} orders`);
    const target = plan && plan.resolved && plan.resolved.product && plan.resolved.product.product_title;
    return `Often bought with ${target || 'that product'}:\n${top.join('\n')}`;
  },

  // -------- sales ---------------------------------------------------------
  top_items_by_units(rows, plan) {
    if (!rows.length) return `No sales${windowLabel(plan)}.`;
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku || '-'}) — ${intish(r.units_sold)} units · ${money(r.net_revenue)}`
    );
    return `Top items by units${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  top_items_by_revenue(rows, plan) {
    if (!rows.length) return `No sales${windowLabel(plan)}.`;
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku || '-'}) — ${money(r.net_revenue)} · ${intish(r.units_sold)} units`
    );
    return `Top items by revenue${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  top_skus(rows, plan) { return F.top_items_by_units(rows, plan); },

  units_sold_per_sku(rows, plan) {
    if (!rows.length) return 'No matching SKU sales.';
    if (rows.length === 1 && rows[0].sku && rows[0].units_sold != null && rows[0].on_hand != null) {
      const r = rows[0];
      return `${r.product_title} (${r.sku}): ${intish(r.units_sold)} units lifetime · ${intish(r.units_sold_30d)} last 30d · on hand ${intish(r.on_hand)}.`;
    }
    return F.top_items_by_units(rows, plan);
  },

  product_detail(rows, plan) {
    const r = rows[0] || {};
    if (!r.product_id && !r.units_sold) return 'No product detail available.';
    return `${r.product_title || '(unknown)'}: ${intish(r.units_sold)} units · ${money(r.net_revenue)} · ${intish(r.orders)} orders · ${intish(r.customers)} customers${windowLabel(plan)}.`;
  },

  top_vendors(rows, plan) {
    if (!rows.length) return `No vendor sales${windowLabel(plan)}.`;
    const top = rows.slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.vendor} — ${money(r.net_revenue)} (${intish(r.units_sold)} units, ${intish(r.orders)} orders)`
    );
    return `Top vendors${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  vendor_growth(rows, plan) {
    if (!rows.length) return 'No vendor growth data.';
    const top = rows.slice(0, 5).map((r, i) => {
      const pct = r.pct_change == null ? 'new' : `${r.pct_change > 0 ? '+' : ''}${r.pct_change}%`;
      return `${i + 1}. ${r.vendor} — ${money(r.revenue_current)} (${pct}, was ${money(r.revenue_previous)})`;
    });
    return `Fastest-growing vendors${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  category_performance(rows, plan) {
    if (!rows.length) return `No category sales${windowLabel(plan)}.`;
    const top = rows.slice(0, 10).map((r) => `${r.category} — ${money(r.revenue)} (${intish(r.units)} units, ${intish(r.orders)} orders)`);
    return `Category performance${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  varietal_performance(rows, plan) {
    const r = rows[0] || {};
    return `${r.varietal || 'varietal'}: ${money(r.revenue)} · ${intish(r.units)} units · ${intish(r.orders)} orders · ${intish(r.customers)} customers${windowLabel(plan)}.`;
  },

  period_over_period(rows, plan) {
    const cur = rows.find((r) => r.bucket === 'current') || {};
    const prev = rows.find((r) => r.bucket === 'previous') || {};
    const delta = Number(cur.revenue || 0) - Number(prev.revenue || 0);
    const pct = prev.revenue > 0 ? Math.round((delta / Number(prev.revenue)) * 1000) / 10 : null;
    const pctTxt = pct == null ? 'n/a' : `${pct > 0 ? '+' : ''}${pct}%`;
    return `Current ${windowLabel(plan).slice(2, -1) || 'period'}: ${money(cur.revenue)} (${intish(cur.orders)} orders, ${intish(cur.units)} units). Previous: ${money(prev.revenue)}. Change: ${pctTxt}.`;
  },

  trending_up(rows) {
    if (!rows.length) return 'No clearly trending-up SKUs.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — 30d: ${intish(r.units_sold_30d)} · 90d: ${intish(r.units_sold_90d)}`);
    return `Trending up:\n${top.join('\n')}`;
  },

  trending_down(rows) {
    if (!rows.length) return 'No clearly trending-down SKUs.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — 30d: ${intish(r.units_sold_30d)} · 90d: ${intish(r.units_sold_90d)}`);
    return `Trending down:\n${top.join('\n')}`;
  },

  recent_orders(rows, plan) {
    if (!rows.length) return `No orders${windowLabel(plan)}.`;
    const top = rows.slice(0, 8).map((r) =>
      `${r.name} — ${money(r.total_price)} ${r.customer_name ? `(${r.customer_name})` : ''}`
    );
    return `Recent orders${windowLabel(plan)} (${rows.length}):\n${top.join('\n')}`;
  },

  sales_summary(rows, plan) {
    const r = rows[0] || {};
    const label = (plan && plan.timeframe && plan.timeframe.label) || 'window';
    const niceLabel = label.charAt(0).toUpperCase() + label.slice(1);
    const metric = plan && plan.params && plan.params.metric;
    // Lead with the metric the user asked about; keep the others as context.
    if (metric === 'units') {
      return `${niceLabel} we sold ${intish(r.units)} units across ${intish(r.orders)} orders (net ${money(r.net_revenue)}).`;
    }
    if (metric === 'orders') {
      return `${niceLabel} we had ${intish(r.orders)} orders (${intish(r.units)} units · net ${money(r.net_revenue)}).`;
    }
    if (metric === 'aov') {
      return `${niceLabel} average order value: ${money(r.average_order_value)} (${intish(r.orders)} orders · net ${money(r.net_revenue)}).`;
    }
    // Default: revenue-led summary.
    return `${niceLabel} we sold ${money(r.net_revenue)} across ${intish(r.orders)} orders and ${intish(r.units)} units. Average order value: ${money(r.average_order_value)}.`;
  },

  revenue_summary(rows, plan) { return F.sales_summary(rows, plan); },

  // ----- new builders ----------------------------------------------------
  top_customers_by_order_count(rows, plan) {
    if (!rows.length) return 'No matching customers.';
    const top = rows.slice(0, 5).map((r, i) =>
      `${i + 1}. ${nameOrEmail(r)} — ${intish(r.order_count)} orders (${money(r.total_spend)})`
    );
    return `Most frequent customers${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  top_customers_by_aov(rows, plan) {
    if (!rows.length) return 'No matching customers.';
    const top = rows.slice(0, 5).map((r, i) =>
      `${i + 1}. ${nameOrEmail(r)} — AOV ${money(r.average_order_value)} (${intish(r.order_count)} orders)`
    );
    return `Highest average order value${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  top_customers_by_sku(rows, plan) {
    if (!rows.length) return `No buyers found for ${plan && plan.params && plan.params.sku || 'that SKU'}.`;
    const top = rows.slice(0, 8).map((r, i) =>
      `${i + 1}. ${nameOrEmail(r)} — ${intish(r.units)} units · ${money(r.spend)}`
    );
    const sku = plan && plan.params && plan.params.sku;
    return `Top customers for ${sku || 'SKU'}${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  customers_bought_both(rows, plan) {
    if (!rows.length) return 'No customers bought both.';
    const top = rows.slice(0, 8).map((r) => `${nameOrEmail(r)} — ${money(r.total_spend)} lifetime`);
    const [a, b] = (plan && plan.params && plan.params.twoVarietals) || ['A', 'B'];
    return `Customers who bought both ${a} and ${b}${windowLabel(plan)} (${rows.length}):\n${top.join('\n')}`;
  },

  customer_top_varietals(rows, plan) {
    if (!rows.length) return 'No purchase history.';
    const top = rows.slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.product_title} — ${money(r.spend)} (${intish(r.units)} units)`
    );
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || 'Customer'} usually buys${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  customer_taste_profile(rows, plan) {
    const r = rows[0] || {};
    const who = r.customer_name || (plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name) || 'Customer';
    const bits = [`${who} taste profile`];
    if (r.favorite_vendor)         bits.push(`favorite vendor: ${r.favorite_vendor}`);
    if (r.favorite_product_type)   bits.push(`favorite category: ${r.favorite_product_type}`);
    if (r.favorite_product)        bits.push(`top product: ${r.favorite_product}`);
    if (r.avg_unit_price != null)  bits.push(`typical price: ${money(r.avg_unit_price)} (${money(r.min_unit_price)}–${money(r.max_unit_price)})`);
    if (r.last_order_at)           bits.push(`last order: ${shortDate(r.last_order_at)}`);
    return bits.join(' · ');
  },

  customer_last_order(rows, plan) {
    const r = rows[0] || {};
    const who = r.customer_name || (plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name) || 'Customer';
    if (!r.last_order_at) return `${who} has no recorded orders.`;
    const days = r.days_since_last_order;
    const status = days != null && days > 180 ? ' — likely inactive' : (days != null && days > 90 ? ' — slipping' : '');
    return `${who} last shopped ${shortDate(r.last_order_at)} (${intish(days)} days ago${status}). Lifetime: ${money(r.total_spend)} across ${intish(r.order_count)} orders.`;
  },

  vendor_decline(rows, plan) {
    if (!rows.length) return 'No vendor declines detected.';
    const top = rows.slice(0, 5).map((r, i) => {
      const pct = r.pct_change == null ? 'n/a' : `${r.pct_change > 0 ? '+' : ''}${r.pct_change}%`;
      return `${i + 1}. ${r.vendor} — ${money(r.revenue_current)} (${pct}, was ${money(r.revenue_previous)})`;
    });
    return `Vendors down vs prior period${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  vendor_avg_selling_price(rows, plan) {
    if (!rows.length) return 'No vendor pricing data.';
    const top = rows.slice(0, 8).map((r, i) =>
      `${i + 1}. ${r.vendor} — ASP ${money(r.avg_selling_price)} (${intish(r.units)} units, ${money(r.revenue)})`
    );
    return `Vendors by average selling price${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  vendors_dead_inventory(rows) {
    if (!rows.length) return 'No vendor dead-inventory issues detected.';
    const top = rows.slice(0, 8).map((r, i) =>
      `${i + 1}. ${r.vendor} — ${intish(r.dead_skus)} SKUs · ${intish(r.dead_units)} units stuck`
    );
    return `Vendors with the most dead inventory:\n${top.join('\n')}`;
  },

  slow_moving(rows, plan) {
    if (!rows.length) return 'No slow-moving SKUs match.';
    const slow = plan && plan.params && plan.params.slow;
    const tag = slow ? `< ${slow.maxUnits} units in ${slow.days}d` : 'slow';
    const top = rows.slice(0, 8).map((r) => {
      const sold = r.units_sold_30d != null ? r.units_sold_30d : r.units_sold_window;
      return `${r.product_title} (${r.sku}) — sold ${intish(sold)}, on hand ${intish(r.on_hand)}`;
    });
    return `Slow movers (${tag}) — ${rows.length}:\n${top.join('\n')}`;
  },

  sku_inventory(rows, plan) {
    if (!rows.length) return `No inventory found for ${plan && plan.params && plan.params.sku || 'that SKU'}.`;
    const lines = rows.map((r) =>
      `${r.product_title} (${r.sku}${r.variant_title ? ' · ' + r.variant_title : ''}) — ${intish(r.on_hand)} on hand @ ${money(r.price)} [${r.product_status || 'active'}]`
    );
    return `Inventory for ${plan && plan.params && plan.params.sku}:\n${lines.join('\n')}`;
  },

  sku_avg_price(rows, plan) {
    const r = rows[0] || {};
    if (!r.units_sold) return `No sales found for ${plan && plan.params && plan.params.sku || 'that SKU'}.`;
    return `${r.product_title || r.sku}: avg selling price ${money(r.avg_unit_price)} (range ${money(r.min_unit_price)}–${money(r.max_unit_price)}) across ${intish(r.units_sold)} units${windowLabel(plan)}.`;
  },

  sku_last_sold(rows) {
    const r = rows[0] || {};
    if (!r.sku) return 'SKU not found in sales history.';
    if (!r.last_sold_at) return `${r.product_title || r.sku} has never sold (lifetime units: ${intish(r.units_sold)}).`;
    return `${r.product_title || r.sku} last sold ${shortDate(r.last_sold_at)}. Lifetime ${intish(r.units_sold)} units · 30d ${intish(r.units_sold_30d)} · on hand ${intish(r.on_hand)}.`;
  },

  // ----- time-series ----------------------------------------------------
  sales_time_series(rows, plan) {
    if (!rows.length) return `No sales${windowLabel(plan)}.`;
    const grain = (plan && plan.params && plan.params.grain) || 'day';
    const metric = (plan && plan.params && plan.params.metric) || 'revenue';
    const fmt = (r) => {
      if (metric === 'orders') return intish(r.orders);
      if (metric === 'units')  return intish(r.units);
      if (metric === 'aov')    return money(r.average_order_value);
      return money(r.net_revenue);
    };
    const labels = rows.map((r) => {
      const d = new Date(r.bucket);
      if (grain === 'day')   return d.toISOString().slice(0, 10);
      if (grain === 'week')  return `wk ${d.toISOString().slice(0, 10)}`;
      if (grain === 'month') return d.toISOString().slice(0, 7);
      return d.toISOString().slice(0, 10);
    });
    const seq = rows.map(fmt).join(', ');
    const totals = rows.reduce(
      (a, r) => ({
        orders: a.orders + Number(r.orders || 0),
        units:  a.units  + Number(r.units  || 0),
        net:    a.net    + Number(r.net_revenue || 0),
      }),
      { orders: 0, units: 0, net: 0 }
    );
    const totalsLine =
      metric === 'orders' ? `Total: ${intish(totals.orders)} orders.`
      : metric === 'units' ? `Total: ${intish(totals.units)} units.`
      : metric === 'aov'   ? `Avg AOV: ${money(totals.orders ? totals.net / totals.orders : 0)}.`
      : `Total: ${money(totals.net)} across ${intish(totals.orders)} orders.`;
    return `${(plan && plan.timeframe && plan.timeframe.label) || ''} by ${grain} (${labels.length} buckets):\n${labels.map((l, i) => `${l}: ${fmt(rows[i])}`).join('\n')}\n${totalsLine}`;
  },

  // ----- customer units bought ------------------------------------------
  customer_units_bought(rows, plan) {
    const r = rows[0] || {};
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    if (!r.units) return `${who || '(unknown)'} has no recorded purchases${windowLabel(plan)}.`;
    return `${who || 'Customer'} has bought ${intish(r.units)} units${windowLabel(plan)} across ${intish(r.order_count)} orders (${money(r.total_spend)}).`;
  },

  // ----- inventory value -------------------------------------------------
  inventory_value_total(rows, plan) {
    const r = rows[0] || {};
    const valuation = plan && plan.params && /cost/.test(plan.params.rawQuestion || '') ? 'cost' : 'retail';
    if (valuation === 'cost') {
      return `Cost-based inventory value is not available in the current synced data. Retail inventory value is ${money(r.retail_value)} across ${intish(r.sku_count)} SKUs (${intish(r.on_hand_units)} units on hand).`;
    }
    return `Current retail inventory value is ${money(r.retail_value)} across ${intish(r.sku_count)} in-stock SKUs (${intish(r.on_hand_units)} units on hand).`;
  },

  inventory_value_by_vendor(rows) {
    if (!rows.length) return 'No inventory found.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.vendor} — ${money(r.retail_value)} (${intish(r.on_hand_units)} units · ${intish(r.sku_count)} SKUs)`
    );
    return `Inventory value by vendor (retail):\n${top.join('\n')}`;
  },

  inventory_value_by_category(rows) {
    if (!rows.length) return 'No inventory found.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.category} — ${money(r.retail_value)} (${intish(r.on_hand_units)} units · ${intish(r.sku_count)} SKUs)`
    );
    return `Inventory value by category (retail):\n${top.join('\n')}`;
  },

  inventory_value_dead(rows, plan) {
    const r = rows[0] || {};
    const days = plan && plan.params && plan.params.day_count;
    return `Dead inventory (no sales in ${days || 90} days): ${money(r.retail_value)} retail across ${intish(r.sku_count)} SKUs (${intish(r.on_hand_units)} units).`;
  },

  inventory_value_low_stock(rows) {
    const r = rows[0] || {};
    return `Low-stock inventory value: ${money(r.retail_value)} across ${intish(r.sku_count)} SKUs (${intish(r.on_hand_units)} units).`;
  },

  // ----- inventory counts -----------------------------------------------
  inventory_count_in_stock(rows) {
    const r = rows[0] || {};
    return `Currently, ${intish(r.product_count)} products have inventory on hand (${intish(r.sku_count)} SKUs · ${intish(r.on_hand_units)} units).`;
  },
  inventory_count_out_of_stock(rows) {
    const r = rows[0] || {};
    return `${intish(r.product_count)} products are currently out of stock (${intish(r.sku_count)} SKUs).`;
  },
  inventory_count_low_stock(rows) {
    const r = rows[0] || {};
    return `${intish(r.product_count)} products are at or below ${intish(r.threshold)} units on hand (${intish(r.sku_count)} SKUs).`;
  },
  inventory_count_threshold(rows, plan) {
    const r = rows[0] || {};
    const c = (plan && plan.meta && plan.meta.params && plan.meta.params.units_below) || (plan && plan.params && plan.params.unitsBelow);
    const m = c || (plan && plan.params && plan.params.money);
    const tag = m
      ? (m.op === '<' ? `< ${m.value} units` : m.op === '>' ? `> ${m.value} units` : 'in range')
      : 'in stock';
    return `${intish(r.product_count)} products match ${tag} (${intish(r.sku_count)} SKUs).`;
  },
  inventory_units_on_hand(rows, plan) {
    const r = rows[0] || {};
    const filter = plan && plan.params && (plan.params.color || plan.params.varietal || plan.params.vendor || plan.params.category);
    const tag = filter ? ` matching "${filter}"` : '';
    return `There are currently ${intish(r.on_hand_units)} units on hand across the store${tag} (${intish(r.product_count)} products, ${intish(r.sku_count)} SKUs).`;
  },

  // ----- data coverage --------------------------------------------------
  data_coverage_orders(rows) {
    const r = rows[0] || {};
    if (!r.earliest_order_at) return 'No orders are loaded in the analytics database yet.';
    return `Order data currently covers ${shortDate(r.earliest_order_at)} through ${shortDate(r.latest_order_at)} across ${intish(r.total_orders)} orders (${intish(r.active_orders)} not cancelled).`;
  },
  data_coverage_customers(rows) {
    const r = rows[0] || {};
    return `Customer data: ${intish(r.total_customers)} customers (${intish(r.customers_with_orders)} with orders). Earliest record ${shortDate(r.earliest_customer_at)}, latest ${shortDate(r.latest_customer_at)}.`;
  },
  data_coverage_products(rows) {
    const r = rows[0] || {};
    return `Product data: ${intish(r.total_products)} products (${intish(r.active_products)} active) · ${intish(r.total_variants)} variants · ${intish(r.products_in_stock)} products currently in stock.`;
  },
  data_coverage_all(rows) {
    const r = rows[0] || {};
    if (!r.earliest_order_at) return 'No order data loaded yet. Products and customers may still be present.';
    return `Coverage: orders ${shortDate(r.earliest_order_at)} → ${shortDate(r.latest_order_at)} (${intish(r.total_orders)} orders) · ${intish(r.total_customers)} customers · ${intish(r.total_products)} products (${intish(r.products_in_stock)} in stock) · ${intish(r.total_variants)} variants.`;
  },

  // ----- product_detail_search (reuses product_detail formatter) --------
  product_detail_search(rows, plan) {
    return F.product_detail(rows, plan);
  },

  // ===== v4 smartness pass =================================================

  // Repeat / new customers
  repeat_customers_count(rows, plan) {
    const r = rows[0] || {};
    return `${(plan && plan.timeframe && plan.timeframe.label) || 'In window'}: ${intish(r.repeat_customers)} repeat customer(s) out of ${intish(r.purchasing_customers)} purchasing customers.`;
  },
  new_customers_count(rows, plan) {
    const r = rows[0] || {};
    return `${(plan && plan.timeframe && plan.timeframe.label) || 'In window'}: ${intish(r.new_customers)} first-time customer(s) out of ${intish(r.purchasing_customers)} purchasing customers.`;
  },
  repeat_customers_share(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.repeat_customers || 0);
    const den = Number(r.purchasing_customers || 0);
    const pct = den ? (num / den) * 100 : 0;
    return `${(plan && plan.timeframe && plan.timeframe.label) || 'In window'}: ${intish(num)} of ${intish(den)} purchasing customers (${pct.toFixed(1)}%) were repeat customers.`;
  },
  new_customers_share(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.new_customers || 0);
    const den = Number(r.purchasing_customers || 0);
    const pct = den ? (num / den) * 100 : 0;
    return `${(plan && plan.timeframe && plan.timeframe.label) || 'In window'}: ${intish(num)} of ${intish(den)} purchasing customers (${pct.toFixed(1)}%) were first-time customers.`;
  },

  customers_count_purchasing(rows, plan) {
    const r = rows[0] || {};
    const label = (plan && plan.timeframe && plan.timeframe.label) || 'In window';
    return `${label}: ${intish(r.purchasing_customers)} distinct purchasing customers across ${intish(r.orders)} orders (${money(r.net_revenue)}). Note: based on purchase records, not foot traffic.`;
  },

  // Busiest hour / pattern
  busiest_hour(rows, plan) {
    if (!rows.length) return `No orders${windowLabel(plan)}.`;
    const top = rows[0];
    const fmt = (h) => `${((h + 11) % 12) + 1}${h < 12 ? ' AM' : ' PM'}`;
    const all = rows.slice(0, 6).map((r) => `${fmt(r.hour_of_day)}: ${intish(r.orders)} orders / ${money(r.net_revenue)}`);
    return `Busiest hour${windowLabel(plan)} was ${fmt(top.hour_of_day)} with ${intish(top.orders)} orders (${money(top.net_revenue)}). Top hours:\n${all.join('\n')}`;
  },
  busiest_period_pattern(rows) {
    if (!rows.length) return 'Not enough order history for a busy-time pattern.';
    const top = rows.slice(0, 5);
    const fmt = (h) => `${((h + 11) % 12) + 1}${h < 12 ? ' AM' : ' PM'}`;
    const lines = top.map((r) => `${r.day_of_week} ${fmt(r.hour_of_day)} — ${intish(r.orders)} orders (${money(r.net_revenue)})`);
    return `Typical peak hours (last 12 weeks):\n${lines.join('\n')}`;
  },

  // Price extremes
  highest_priced_item_sold(rows, plan) {
    if (!rows.length) return `No items sold${windowLabel(plan)}.`;
    const r = rows[0];
    return `Highest-priced item sold${windowLabel(plan)}: ${r.product_title}${r.variant_title ? ' · ' + r.variant_title : ''} at ${money(r.unit_price)} on ${shortDate(r.occurred_at)}${r.customer_name ? ' (' + r.customer_name + ')' : ''}.`;
  },
  lowest_priced_item_sold(rows, plan) {
    if (!rows.length) return `No items sold${windowLabel(plan)}.`;
    const r = rows[0];
    return `Lowest-priced item sold${windowLabel(plan)}: ${r.product_title}${r.variant_title ? ' · ' + r.variant_title : ''} at ${money(r.unit_price)} on ${shortDate(r.occurred_at)}${r.customer_name ? ' (' + r.customer_name + ')' : ''}.`;
  },
  buyer_of_highest_priced_item(rows, plan) {
    if (!rows.length) return `No items sold${windowLabel(plan)}.`;
    const r = rows[0];
    return `${windowLabel(plan).replace(/[() ]/g, '').replace(/^./, (c) => c.toUpperCase()) || 'Window'}: the customer who bought the most expensive item was ${r.customer_name || r.customer_email || '(unknown)'} — ${r.product_title} at ${money(r.unit_price)}.`;
  },
  buyer_of_lowest_priced_item(rows, plan) {
    if (!rows.length) return `No items sold${windowLabel(plan)}.`;
    const r = rows[0];
    return `${windowLabel(plan).replace(/[() ]/g, '').replace(/^./, (c) => c.toUpperCase()) || 'Window'}: the customer who bought the cheapest item was ${r.customer_name || r.customer_email || '(unknown)'} — ${r.product_title} at ${money(r.unit_price)}.`;
  },

  // Customer preference
  customer_top_products(rows, plan) {
    if (!rows.length) return 'No purchases on record.';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.product_title} — ${intish(r.units)} units · ${money(r.spend)}`);
    return `${who || 'Customer'} top products${windowLabel(plan)}:\n${top.join('\n')}`;
  },
  customer_top_vendors(rows, plan) {
    if (!rows.length) return 'No vendor purchases on record.';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.vendor} — ${money(r.spend)} (${intish(r.units)} units)`);
    return `${who || 'Customer'} top vendors${windowLabel(plan)}:\n${top.join('\n')}`;
  },
  customer_top_categories(rows, plan) {
    if (!rows.length) return 'No category data on record.';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.category} — ${money(r.spend)} (${intish(r.units)} units)`);
    return `${who || 'Customer'} top categories${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  // Cadence
  customer_frequency_profile(rows, plan) {
    const r = rows[0] || {};
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    if (!r.order_count) return `${who || 'Customer'} has no orders on record.`;
    if (r.order_count === 1) {
      return `${who || 'Customer'} has 1 order on record (${shortDate(r.first_order_at)}). No cadence yet.`;
    }
    return `${who || 'Customer'} typically shops every ${r.avg_days_between_orders}d. Lifetime ${intish(r.order_count)} orders from ${shortDate(r.first_order_at)} to ${shortDate(r.last_order_at)} (last seen ${intish(r.days_since_last_order)}d ago).`;
  },

  lapsed_frequent_customers(rows, plan) {
    if (!rows.length) return 'No lapsed frequent customers found.';
    const top = rows.slice(0, 8).map((r) => `${nameOrEmail(r)} — ${intish(r.order_count)} orders, ${money(r.total_spend)}, last seen ${intish(r.days_since_last_order)}d ago`);
    return `Lapsed frequent customers (${rows.length}):\n${top.join('\n')}`;
  },

  customer_reactivation_candidates(rows) {
    if (!rows.length) return 'No recent reactivations detected.';
    const top = rows.slice(0, 8).map((r) => `${r.customer_name || r.email || '(unknown)'} — came back ${shortDate(r.last_at)} after ${Math.round(Number(r.gap_days || 0))}d away`);
    return `Reactivation candidates (${rows.length}):\n${top.join('\n')}`;
  },

  // Type / category / varietal
  type_top_seller(rows, plan) {
    if (!rows.length) return `No sales${windowLabel(plan)}.`;
    const top = rows[0];
    const lines = rows.slice(0, 8).map((r, i) => `${i + 1}. ${r.type} — ${intish(r.units)} units · ${money(r.revenue)}`);
    return `Top-selling type${windowLabel(plan)}: ${top.type} (${intish(top.units)} units). All:\n${lines.join('\n')}`;
  },
  type_breakdown(rows, plan) {
    if (!rows.length) return `No sales${windowLabel(plan)}.`;
    const lines = rows.slice(0, 12).map((r) => `${r.type} — ${intish(r.units)} units · ${money(r.revenue)} · ${intish(r.orders)} orders`);
    return `Units sold by type${windowLabel(plan)}:\n${lines.join('\n')}`;
  },
  varietal_ranking(rows, plan) {
    if (!rows.length) return `No varietals sold${windowLabel(plan)}.`;
    const lines = rows.slice(0, 12).map((r, i) => `${i + 1}. ${r.varietal} — ${intish(r.units)} units · ${money(r.revenue)}`);
    return `Top varietals${windowLabel(plan)}:\n${lines.join('\n')}`;
  },

  // Share / mix
  share_of_sales_by_filter(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.numerator || 0);
    const den = Number(r.denominator || 0);
    const pct = den ? (num / den) * 100 : 0;
    const what = (plan && plan.params && (plan.params.varietal || plan.params.color || plan.params.category || plan.params.vendor)) || 'filter';
    return `${windowLabel(plan).slice(2, -1) || 'Window'}: ${money(num)} of ${money(den)} revenue (${pct.toFixed(1)}%) was from ${what}.`;
  },
  share_of_revenue_top_n(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.numerator || 0);
    const den = Number(r.denominator || 0);
    const pct = den ? (num / den) * 100 : 0;
    return `Top ${r.top_n} products generated ${money(num)} of ${money(den)} (${pct.toFixed(1)}% of revenue)${windowLabel(plan)}.`;
  },
  share_of_dead_inventory_value(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.numerator || 0);
    const den = Number(r.denominator || 0);
    const pct = den ? (num / den) * 100 : 0;
    const days = (plan && plan.params && plan.params.day_count) || 90;
    return `Dead inventory (no sales in ${days}d) is ${money(num)} of ${money(den)} retail value (${pct.toFixed(1)}%).`;
  },
  share_of_orders_with_filter(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.numerator || 0);
    const den = Number(r.denominator || 0);
    const pct = den ? (num / den) * 100 : 0;
    const what = (plan && plan.params && (plan.params.category || plan.params.varietal || plan.params.color)) || 'filter';
    return `${intish(num)} of ${intish(den)} orders (${pct.toFixed(1)}%) included ${what}${windowLabel(plan)}.`;
  },

  // ===== v5: order drill-down =============================================
  order_detail_lookup(rows, plan) {
    const r = rows[0] || {};
    if (!r.order_id) return 'Order not found.';
    const who = r.customer_name || r.email || '(no customer attached)';
    const when = shortDate(r.occurred_at);
    const lines = [];
    lines.push(`${r.name} was placed on ${when} by ${who}. Total: ${money(r.total_price)}.`);
    if (r.cancelled_at) lines.push('  STATUS: cancelled on ' + shortDate(r.cancelled_at));
    else lines.push(`  status: ${r.financial_status || 'n/a'} / ${r.fulfillment_status || 'n/a'}`);
    lines.push(`  items: ${intish(r.line_item_count)} line item(s), ${intish(r.total_units)} units`);
    if (Number(r.total_discounts) > 0) lines.push(`  discounts: ${money(r.total_discounts)}`);
    if (Number(r.total_tax) > 0) lines.push(`  tax: ${money(r.total_tax)}`);
    return lines.join('\n');
  },

  order_items_lookup(rows, plan) {
    if (!rows.length) return 'No line items found for that order.';
    const orderName = plan && plan.resolved && plan.resolved.order && plan.resolved.order.name;
    const header = orderName ? `${orderName} items (${rows.length}):` : `Items (${rows.length}):`;
    const lines = rows.slice(0, 50).map((r, i) =>
      `${i + 1}. ${r.product_title}${r.variant_title ? ' · ' + r.variant_title : ''} (${r.sku || '-'}) — qty ${intish(r.quantity)} @ ${money(r.unit_price)} = ${money(r.line_total)}`
    );
    return `${header}\n${lines.join('\n')}`;
  },

  order_customer_lookup(rows, plan) {
    const r = rows[0] || {};
    if (!r.order_id) return 'Order not found.';
    const who = r.customer_name || r.email || '(no customer attached — walk-in / guest)';
    return `${r.name} was placed by ${who}.`;
  },

  order_total_lookup(rows, plan) {
    const r = rows[0] || {};
    if (!r.order_id) return 'Order not found.';
    return `${r.name} total: ${money(r.total_price)} (subtotal ${money(r.subtotal_price)}, discounts ${money(r.total_discounts)}, tax ${money(r.total_tax)}).`;
  },

  order_status_lookup(rows, plan) {
    const r = rows[0] || {};
    if (!r.order_id) return 'Order not found.';
    if (r.cancelled_at) return `${r.name} was cancelled on ${shortDate(r.cancelled_at)}.`;
    return `${r.name}: financial=${r.financial_status || 'n/a'}, fulfillment=${r.fulfillment_status || 'n/a'}, closed=${r.closed_at ? shortDate(r.closed_at) : 'no'}.`;
  },

  order_extreme_item_lookup(rows, plan) {
    if (!rows.length) return 'No line items found for that order.';
    const dir = (plan && plan.params && plan.params.extremeDirection === 'low') ? 'cheapest' : 'most expensive';
    const r = rows[0];
    const orderName = plan && plan.resolved && plan.resolved.order && plan.resolved.order.name;
    return `${orderName ? orderName + ' ' : ''}${dir} item: ${r.product_title}${r.variant_title ? ' · ' + r.variant_title : ''} (${r.sku || '-'}) at ${money(r.unit_price)} × ${intish(r.quantity)} = ${money(r.line_total)}.`;
  },

  order_includes_category(rows, plan) {
    const r = rows[0] || {};
    const cats = (plan && plan.params && plan.params.includeCategories) || [];
    if (!cats.length) return 'No category specified.';
    const orderName = plan && plan.resolved && plan.resolved.order && plan.resolved.order.name;
    const parts = cats.map((c) => {
      const key = 'has_' + c.replace(/[^a-z0-9]+/gi, '_');
      const has = r[key];
      return `${c}: ${has ? 'yes' : 'no'}`;
    });
    return `${orderName ? orderName + ' — ' : ''}${parts.join(' · ')}`;
  },

  // Customer-side drill-down
  customer_last_order_items(rows, plan) {
    const header = rows.find((r) => r.bucket === 'order');
    const items  = rows.filter((r) => r.bucket === 'line');
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    if (!header) return `${who || 'Customer'} has no orders on record.`;
    const lines = [];
    lines.push(`${who || 'Customer'} last order ${header.order_name} on ${shortDate(header.occurred_at)} — ${money(header.total_price)} (${items.length} item${items.length === 1 ? '' : 's'}).`);
    items.slice(0, 20).forEach((it, i) => {
      lines.push(`  ${i + 1}. ${it.product_title}${it.variant_title ? ' · ' + it.variant_title : ''} (${it.sku || '-'}) — qty ${intish(it.quantity)} @ ${money(it.unit_price)}`);
    });
    return lines.join('\n');
  },

  customer_last_n_orders(rows, plan) {
    if (!rows.length) return 'No orders on record for that customer.';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.name} — ${shortDate(r.occurred_at)} — ${money(r.total_price)} (${intish(r.line_items)} items)`
    );
    return `${who || 'Customer'} last ${rows.length} order(s):\n${lines.join('\n')}`;
  },

  customer_comparison(rows, plan) {
    const pair = plan && plan.resolved && plan.resolved.customerPair;
    if (!pair) return 'Customer pair not resolved.';
    const a = rows.find((r) => r.side === 'A') || {};
    const b = rows.find((r) => r.side === 'B') || {};
    const aName = pair.left && pair.left.customer_name;
    const bName = pair.right && pair.right.customer_name;
    const lines = [];
    lines.push(`${aName} vs ${bName}${windowLabel(plan)}:`);
    lines.push(`  Spend: ${money(a.total_spend)} vs ${money(b.total_spend)}`);
    lines.push(`  Orders: ${intish(a.order_count)} vs ${intish(b.order_count)}`);
    lines.push(`  Units: ${intish(a.units)} vs ${intish(b.units)}`);
    lines.push(`  AOV: ${money(a.average_order_value)} vs ${money(b.average_order_value)}`);
    return lines.join('\n');
  },

  customer_time_series(rows, plan) {
    if (!rows.length) return 'No purchase activity in window.';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    const grain = (plan && plan.params && plan.params.grain) || 'week';
    const totals = rows.reduce((acc, r) => ({
      revenue: acc.revenue + Number(r.net_revenue || 0),
      units:   acc.units   + Number(r.units || 0),
      orders:  acc.orders  + Number(r.orders || 0),
    }), { revenue: 0, units: 0, orders: 0 });
    const buckets = rows.slice(0, 12).map((r) =>
      `${new Date(r.bucket).toISOString().slice(0, 10)}: ${money(r.net_revenue)} · ${intish(r.units)}u · ${intish(r.orders)}o`
    );
    return `${who || 'Customer'} by ${grain}${windowLabel(plan)}:\n${buckets.join('\n')}\nTotal: ${money(totals.revenue)} · ${intish(totals.units)} units · ${intish(totals.orders)} orders.`;
  },

  customer_change_over_time(rows, plan) {
    const cur = rows.find((r) => r.bucket === 'current') || {};
    const prev = rows.find((r) => r.bucket === 'previous') || {};
    const delta = Number(cur.revenue || 0) - Number(prev.revenue || 0);
    const pct = Number(prev.revenue) > 0 ? Math.round((delta / Number(prev.revenue)) * 1000) / 10 : null;
    const pctTxt = pct == null ? 'n/a' : (pct > 0 ? '+' : '') + pct + '%';
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || 'Customer'} current period: ${money(cur.revenue)} (${intish(cur.orders)} orders, ${intish(cur.units)} units). Prior period: ${money(prev.revenue)}. Change: ${pctTxt}.`;
  },

  customer_color_mix(rows, plan) {
    if (!rows.length) return 'No purchases on record for that customer.';
    const totalSpend = rows.reduce((a, r) => a + Number(r.spend || 0), 0) || 1;
    const lines = rows.map((r) => {
      const pct = (Number(r.spend || 0) / totalSpend * 100).toFixed(1);
      return `  ${r.color_bucket}: ${money(r.spend)} (${pct}% · ${intish(r.units)} units)`;
    });
    const who = plan && plan.resolved && plan.resolved.customer && plan.resolved.customer.customer_name;
    return `${who || 'Customer'} color mix${windowLabel(plan)}:\n${lines.join('\n')}`;
  },

  // Overlap share (e.g. liquor + wine)
  order_overlap_share(rows, plan) {
    const r = rows[0] || {};
    const num = Number(r.numerator || 0);
    const den = Number(r.denominator || 0);
    const pct = den ? (num / den) * 100 : 0;
    const filters = (plan && plan.params && plan.params.overlapFilters) || ['A', 'B'];
    return `${intish(num)} of ${intish(den)} orders (${pct.toFixed(1)}%) included BOTH ${filters.join(' AND ')}${windowLabel(plan)}.`;
  },

  // Dashboard
  dashboard_summary(rows, plan) {
    const kpi = rows.find((r) => r.bucket === 'kpi') || {};
    const topProducts = rows.filter((r) => r.bucket === 'top_product');
    const topVendors  = rows.filter((r) => r.bucket === 'top_vendor');
    const lines = [];
    lines.push(`📊 ${(plan && plan.timeframe && plan.timeframe.label) || 'Window'} dashboard`);
    lines.push(`Revenue: ${money(kpi.revenue)} · Orders: ${intish(kpi.orders)} · Units: ${intish(kpi.units)} · AOV: ${money(kpi.aov)} · Customers: ${intish(kpi.customers)}`);
    if (topProducts.length) {
      lines.push('Top products:');
      topProducts.slice(0, 5).forEach((r, i) => lines.push(`  ${i + 1}. ${r.label} — ${intish(r.units)} units · ${money(r.revenue)}`));
    }
    if (topVendors.length) {
      lines.push('Top vendors:');
      topVendors.slice(0, 5).forEach((r, i) => lines.push(`  ${i + 1}. ${r.label} — ${intish(r.units)} units · ${money(r.revenue)}`));
    }
    return lines.join('\n');
  },

  // -------- inventory -----------------------------------------------------
  low_stock(rows) {
    if (!rows.length) return 'No low-stock variants right now.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'}) — ${intish(r.on_hand)} left @ ${money(r.price)}`);
    return `Low stock (${rows.length}):\n${top.join('\n')}`;
  },

  out_of_stock(rows) {
    if (!rows.length) return 'Nothing is out of stock.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'})`);
    return `Out of stock (${rows.length}):\n${top.join('\n')}`;
  },

  in_stock_filtered(rows) {
    if (!rows.length) return 'No matching in-stock variants.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'}) — ${intish(r.on_hand)} on hand @ ${money(r.price)}`);
    return `Matched ${rows.length} variant(s):\n${top.join('\n')}`;
  },

  dead_inventory(rows, plan) {
    if (!rows.length) return 'No dead inventory detected.';
    const top = rows.slice(0, 8).map((r) =>
      `${r.product_title} (${r.sku}) — ${intish(r.on_hand)} on hand, last sold ${r.last_sold_at ? shortDate(r.last_sold_at) : 'never'}`
    );
    return `Dead inventory${windowLabel(plan)} (${rows.length}):\n${top.join('\n')}`;
  },

  unsold_in_period(rows, plan) { return F.dead_inventory(rows, plan); },
  aged_inventory(rows, plan)   { return F.dead_inventory(rows, plan); },

  overstock(rows) {
    if (!rows.length) return 'No overstock issues detected.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — ${intish(r.on_hand)} on hand, 30d sold: ${intish(r.units_sold_30d)}`);
    return `Overstock candidates (${rows.length}):\n${top.join('\n')}`;
  },

  runout_risk(rows) {
    if (!rows.length) return 'No imminent runout risk.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — ${intish(r.on_hand)} left · ~${r.days_of_cover}d cover`);
    return `Runout risk (${rows.length}):\n${top.join('\n')}`;
  },

  inventory_velocity(rows) {
    if (!rows.length) return 'No velocity data.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — 30d: ${intish(r.units_sold_30d)} · on hand: ${intish(r.on_hand)}`);
    return `Top velocity:\n${top.join('\n')}`;
  },

  sell_through(rows) {
    if (!rows.length) return 'No sell-through data.';
    const top = rows.slice(0, 8).map((r) =>
      `${r.product_title} (${r.sku}) — sell-through 30d: ${(Number(r.sell_through_30d) * 100).toFixed(1)}%`
    );
    return `Best sell-through (30d):\n${top.join('\n')}`;
  },

  low_stock_high_velocity(rows) {
    if (!rows.length) return 'No reorder candidates right now.';
    const top = rows.slice(0, 8).map((r) =>
      `${r.product_title} (${r.sku}) — ${intish(r.on_hand)} left, sold ${intish(r.units_sold_30d)} in 30d`
    );
    return `Reorder candidates (${rows.length}):\n${top.join('\n')}`;
  },

  // ===== v6 formatters (manager-ready, mirror spec phrasing) ==============

  order_status_breakdown(rows, plan) {
    if (!rows.length) return 'No orders in that window.';
    const buckets = rows.slice(0, 12).map((r) => {
      const status = r.cancelled
        ? 'canceled'
        : `${r.financial_status}/${r.fulfillment_status}`;
      return `${status}: ${intish(r.orders)} orders, ${money(r.revenue)}`;
    });
    return `Here are the order statuses${windowLabel(plan)}:\n${buckets.join('\n')}`;
  },

  fulfillment_status_breakdown(rows, plan) {
    if (!rows.length) return 'No orders in that window.';
    const parts = rows.map((r) => `${r.fulfillment_status}: ${intish(r.orders)}`);
    return `Fulfillment status${windowLabel(plan)} — ${parts.join(' | ')}`;
  },

  orders_pending_fulfillment(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders are pending fulfillment${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  refunded_orders_count(rows, plan) {
    const r = rows[0] || {};
    if (!r.orders) return `No refunded orders${windowLabel(plan)}.`;
    return `There are ${intish(r.orders)} refunded orders${windowLabel(plan)} totaling ${money(r.refund_total)}.`;
  },

  cancelled_orders_count(rows, plan) {
    const r = rows[0] || {};
    return `You have ${intish(r.orders)} canceled orders${windowLabel(plan)} totaling ${money(r.cancelled_total)}.`;
  },

  draft_orders_count(rows) {
    const r = rows[0] || {};
    if (r.supported === false) {
      return `Draft orders are not in the currently-synced data. Shopify keeps them in a separate /draft_orders endpoint that we don't sync today.`;
    }
    return `You have ${intish(r.drafts || 0)} draft orders.`;
  },

  archived_orders_count(rows, plan) {
    const r = rows[0] || {};
    return `You have ${intish(r.orders)} archived (closed) orders${windowLabel(plan)}.`;
  },

  orders_with_notes(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders have notes attached${windowLabel(plan)}.`;
  },

  orders_with_custom_attrs(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders have custom attributes${windowLabel(plan)}.`;
  },

  orders_by_referrer(rows, plan) {
    if (!rows.length) return 'No orders in that window.';
    const top = rows.slice(0, 8).map((r, i) =>
      `${i + 1}. ${r.source_name} — ${intish(r.orders)} orders (${money(r.revenue)})`
    );
    return `Orders by referrer${windowLabel(plan)} — note: this is Shopify "source_name" (web/pos/iphone), not external referral attribution:\n${top.join('\n')}`;
  },

  orders_by_tag(rows, plan) {
    if (rows.length === 1 && rows[0].orders != null && plan && plan.params && plan.params.tagHint) {
      return `${intish(rows[0].orders)} orders tagged "${plan.params.tagHint}"${windowLabel(plan)} (${money(rows[0].revenue)}).`;
    }
    if (!rows.length) return 'No tagged orders in that window.';
    const top = rows.slice(0, 12).map((r) => `${r.tag}: ${intish(r.orders)}`);
    return `Top order tags${windowLabel(plan)} — ${top.join(' | ')}`;
  },

  highest_order_total(rows, plan) {
    if (!rows.length) return 'No orders found.';
    const r = rows[0];
    const who = r.customer_name || r.customer_email || '(no customer attached)';
    return `Your largest order was ${money(r.total_price)} (${r.order_name}) from ${who} on ${shortDate(r.occurred_at)}.`;
  },

  lowest_order_total(rows, plan) {
    if (!rows.length) return 'No orders found.';
    const r = rows[0];
    const who = r.customer_name || r.customer_email || '(no customer attached)';
    return `Your smallest order was ${money(r.total_price)} (${r.order_name}) from ${who} on ${shortDate(r.occurred_at)}.`;
  },

  orders_above(rows, plan) {
    const r = rows[0] || {};
    const v = (plan && plan.params && plan.params.money && plan.params.money.value) || 500;
    if (!r.orders) return `No orders over ${money(v)}${windowLabel(plan)}.`;
    return `There are ${intish(r.orders)} orders over ${money(v)}${windowLabel(plan)}, totaling ${money(r.revenue)} in revenue (range ${money(r.min_total)} – ${money(r.max_total)}).`;
  },

  avg_items_per_order(rows, plan) {
    const r = rows[0] || {};
    return `Average of ${r.avg_items_per_order || 0} items per order${windowLabel(plan)} (${intish(r.total_line_items)} line-items across ${intish(r.orders)} orders).`;
  },

  total_line_items_sold(rows, plan) {
    const r = rows[0] || {};
    return `You've sold ${intish(r.total_line_items)} line items total${windowLabel(plan)} (across ${intish(r.orders)} orders).`;
  },

  avg_quantity_per_line_item(rows, plan) {
    const r = rows[0] || {};
    return `Average of ${r.avg_quantity || 0} units per line item${windowLabel(plan)} (${intish(r.line_items)} line items).`;
  },

  order_completion_rate(rows, plan) {
    const r = rows[0] || {};
    const total = Number(r.total || 0);
    const done = Number(r.completed || 0);
    const cancelled = Number(r.cancelled || 0);
    const pct = total ? (done / total) * 100 : 0;
    return `Order completion rate${windowLabel(plan)}: ${pct.toFixed(1)}% (${intish(done)} fulfilled / ${intish(cancelled)} cancelled / ${intish(total)} total).`;
  },

  total_discounts_given(rows, plan) {
    const r = rows[0] || {};
    return `Total discounts${windowLabel(plan)}: ${money(r.total_discounts)} across ${intish(r.discounted_orders)} discounted orders (out of ${intish(r.orders)} total).`;
  },

  total_taxes_collected(rows, plan) {
    const r = rows[0] || {};
    return `Total tax collected${windowLabel(plan)}: ${money(r.total_tax)} across ${intish(r.orders)} orders.`;
  },

  orders_with_discounts(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders had discounts applied${windowLabel(plan)}, totaling ${money(r.discount_total)} in discounts given (avg ${money(r.avg_discount)}/order).`;
  },

  orders_without_discount(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders had no discount${windowLabel(plan)}.`;
  },

  avg_discount_percentage(rows, plan) {
    const r = rows[0] || {};
    return `Average discount: ${r.avg_pct || 0}%${windowLabel(plan)} (across ${intish(r.discounted_orders)} discounted orders).`;
  },

  top_discount_codes(rows, plan) {
    if (!rows.length) return `No discount codes used${windowLabel(plan)}.`;
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.code} — ${intish(r.orders)} orders (${money(r.discount_total)} in discounts)`
    );
    return `Top discount codes${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  coupon_usage_rate(rows, plan) {
    const r = rows[0] || {};
    const w = Number(r.with_code || 0);
    const t = Number(r.orders || 0);
    const pct = t ? (w / t) * 100 : 0;
    return `${pct.toFixed(1)}% of orders used a discount code${windowLabel(plan)} (${intish(w)} of ${intish(t)}).`;
  },

  refund_rate_and_avg(rows, plan) {
    const r = rows[0] || {};
    const tot = Number(r.orders || 0);
    const ref = Number(r.refunded_orders || 0);
    const pct = tot ? (ref / tot) * 100 : 0;
    return `Refund rate: ${pct.toFixed(1)}%${windowLabel(plan)} (${intish(ref)} refunds out of ${intish(tot)} orders). Avg refund: ${money(r.avg_refund)}. Avg ${r.avg_days_to_refund || 0} days to refund.`;
  },

  products_with_most_returns(rows, plan) {
    if (!rows.length) return `No refunded line items${windowLabel(plan)}. Note: refunds come from orders.raw.refunds; check that recent orders carry refund payloads.`;
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku || '-'}) — ${intish(r.refunded_units)} units returned (${money(r.refunded_value)})`
    );
    return `Products with most returns${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  orders_shipped_to_state(rows, plan) {
    if (rows.length === 1 && rows[0].orders != null && plan && plan.params && plan.params.shippingStateHint) {
      const r = rows[0];
      return `Orders to ${plan.params.shippingStateHint}${windowLabel(plan)}: ${intish(r.orders)} totaling ${money(r.revenue)}.`;
    }
    if (!rows.length) return `No orders in that window.`;
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.state} — ${intish(r.orders)} orders (${money(r.revenue)})`
    );
    const note = rows.length ? `Your most common shipping state is ${rows[0].state} with ${intish(rows[0].orders)} orders.\n` : '';
    return `${note}Top shipping states${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  international_orders_count(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders shipped internationally${windowLabel(plan)} (outside the US).`;
  },

  avg_fulfillment_time(rows, plan) {
    const r = rows[0] || {};
    if (!r.orders) return `Not enough fulfillment data${windowLabel(plan)}.`;
    const note = r.has_precise
      ? '(based on precise fulfillment timestamps from Shopify)'
      : '(approximate — based on order closed_at; precise fulfillment timestamps not always present)';
    return `Average fulfillment time: ${r.avg_days || 0} days${windowLabel(plan)} ${note} across ${intish(r.orders)} orders.`;
  },

  shipping_method_breakdown(rows, plan) {
    if (!rows.length) return 'No shipping data in window.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.shipping_method} — ${intish(r.orders)} orders, ${money(r.shipping_revenue)} shipping (avg ${money(r.avg_shipping_cost)})`
    );
    return `Shipping methods${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  orders_by_shipping_title(rows, plan) {
    const r = rows[0] || {};
    const pat = plan && plan.params && plan.params.shippingTitlePattern;
    const tag = pat ? pat.replace(/%/g, '') : 'matching method';
    return `${intish(r.orders)} orders with shipping method "${tag}"${windowLabel(plan)} (${money(r.revenue)} in revenue, ${money(r.shipping_total)} in shipping).`;
  },

  free_shipping_orders(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders had free shipping${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  payment_method_breakdown(rows, plan) {
    if (!rows.length) return 'No payment data in window. (Payment gateway names come from orders.raw.payment_gateway_names.)';
    const total = rows.reduce((a, r) => a + Number(r.orders || 0), 0) || 1;
    const top = rows.slice(0, 10).map((r) => {
      const pct = (Number(r.orders) / total * 100).toFixed(1);
      return `${r.payment_gateway}: ${pct}% (${intish(r.orders)} orders, ${money(r.revenue)})`;
    });
    return `Payment method breakdown${windowLabel(plan)} — ${top.join(' | ')}`;
  },

  orders_by_gateway(rows, plan) {
    const r = rows[0] || {};
    const pat = plan && plan.params && plan.params.gatewayPattern;
    const tag = pat ? pat.replace(/%/g, '') : 'matching gateway';
    return `${intish(r.orders)} orders paid with ${tag}${windowLabel(plan)} (${money(r.revenue)}).`;
  },

  orders_after_hour(rows, plan) {
    const r = rows[0] || {};
    const h = (plan && plan.params && plan.params.afterHour) || 17;
    const ampm = h === 12 ? '12 PM' : (h > 12 ? `${h - 12} PM` : `${h} AM`);
    return `${intish(r.orders)} orders placed after ${ampm}${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  orders_with_gift_cards(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders included a gift card${windowLabel(plan)}.`;
  },

  total_weight(rows, plan) {
    const r = rows[0] || {};
    const g = Number(r.total_grams || 0);
    const kg = (g / 1000).toFixed(2);
    const lb = (g * 0.00220462).toFixed(2);
    return `Total weight of all orders${windowLabel(plan)}: ${kg} kg (~${lb} lb) across ${intish(r.orders_with_weight)} of ${intish(r.orders)} orders (some may not have a weight set).`;
  },

  heaviest_orders(rows, plan) {
    if (!rows.length) return 'No order weight data in window.';
    const top = rows.slice(0, 10).map((r, i) => {
      const kg = ((Number(r.total_weight_g || 0)) / 1000).toFixed(2);
      const who = r.customer_name ? ` — ${r.customer_name}` : '';
      return `${i + 1}. ${r.order_name} — ${kg} kg (${money(r.total_price)})${who}`;
    });
    return `Heaviest orders${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  avg_customer_ltv(rows) {
    const r = rows[0] || {};
    return `Your average customer LTV is ${money(r.avg_ltv)} (based on ${intish(r.customers_with_orders)} customers with ≥1 order, out of ${intish(r.customers_total)} total).`;
  },

  customer_order_frequency(rows) {
    const r = rows[0] || {};
    return `Customers order an average of ${r.avg_orders_per_customer || 0} times (across ${intish(r.customers_with_orders)} customers with ≥1 order).`;
  },

  repeat_customer_rate(rows) {
    const r = rows[0] || {};
    const rep = Number(r.repeat_customers || 0);
    const w = Number(r.customers_with_orders || 0);
    const tot = Number(r.customers_total || 0);
    const pct = w ? (rep / w) * 100 : 0;
    return `${pct.toFixed(1)}% of customers have ordered more than once (${intish(rep)} repeat customers out of ${intish(w)} with ≥1 order, ${intish(tot)} total).`;
  },

  customers_with_orders_above(rows, plan) {
    const r = rows[0] || {};
    const v = (plan && plan.params && plan.params.money && plan.params.money.value) || 1000;
    return `${intish(r.customers)} customers have spent over ${money(v)} (total ${money(r.total_spend)}, avg ${money(r.avg_spend)} per customer).`;
  },

  customers_with_no_orders(rows) {
    const r = rows[0] || {};
    return `${intish(r.customers)} customers have no orders on file.`;
  },

  customer_locations_breakdown(rows) {
    if (!rows.length) return `No customer location data available. Note: location comes from each customer's most recent shipping address.`;
    const top = rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.state} — ${intish(r.customers)} customers`);
    return `Customer locations (most recent shipping state per customer):\n${top.join('\n')}`;
  },

  last_order_date_per_customer(rows) {
    if (!rows.length) return 'No customer order data.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.customer_name || r.email || '#' + r.customer_id} — last ordered ${shortDate(r.last_order_at)} (${intish(r.days_since_last_order)}d ago, ${intish(r.order_count)} orders, ${money(r.total_spend)} lifetime)`
    );
    return `Most recent activity:\n${top.join('\n')}`;
  },

  first_time_buyer_orders(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders were from first-time customers${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  orders_shipped_this_window(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders shipped${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  weekday_vs_weekend(rows, plan) {
    const r = rows[0] || {};
    return `Weekday average: ${money(r.weekday_avg_revenue)}/day (${r.weekday_avg_orders || 0} orders) | Weekend average: ${money(r.weekend_avg_revenue)}/day (${r.weekend_avg_orders || 0} orders)${windowLabel(plan)}. Sample: ${intish(r.weekday_days)} weekdays, ${intish(r.weekend_days)} weekend days.`;
  },

  what_products_do_we_sell(rows) {
    if (!rows.length) return 'No product catalog data.';
    const top = rows.slice(0, 12).map((r, i) => `${i + 1}. ${r.category} — ${intish(r.products)} products`);
    return `What we sell (top categories by product count):\n${top.join('\n')}`;
  },

  worst_selling_products(rows) {
    if (!rows.length) return 'No worst-seller data.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku || '-'}) — ${intish(r.units_sold_30d)} sold last 30d, on hand ${intish(r.on_hand)}, last sold ${r.last_sold_at ? shortDate(r.last_sold_at) : 'never'}`
    );
    return `Worst-selling on-hand SKUs (30d):\n${top.join('\n')}`;
  },

  newest_products_added(rows) {
    if (!rows.length) return 'No products on file.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.title} (${r.vendor || '-'}) — added ${shortDate(r.created_at)}`
    );
    return `Newest products added:\n${top.join('\n')}`;
  },

  inventory_by_location(rows) {
    if (!rows.length) return 'No location inventory data.';
    const top = rows.slice(0, 10).map((r) =>
      `${r.location_name || '(unknown)'} — ${intish(r.inventory_items)} items, ${intish(r.on_hand_units)} units on hand`
    );
    return `Inventory by location:\n${top.join('\n')}`;
  },

  inventory_levels_by_product(rows) {
    if (!rows.length) return 'No inventory data.';
    const top = rows.slice(0, 12).map((r) =>
      `${r.product_title}${r.variant_title ? ' · ' + r.variant_title : ''} (${r.sku || '-'}) — ${intish(r.on_hand)} on hand @ ${money(r.price)}`
    );
    return `Top inventory levels:\n${top.join('\n')}`;
  },

  products_not_in_inventory(rows) {
    const r = rows[0] || {};
    return `${intish(r.products_without_inventory)} products have no inventory data (out of ${intish(r.products_total)} total).`;
  },

  inventory_turnover_rate(rows) {
    const r = rows[0] || {};
    return `Inventory turnover (30 days): ${r.turnover_ratio || 0}× (${intish(r.units_sold_30d)} units sold ÷ ${intish(r.on_hand)} on hand).`;
  },

  days_of_inventory_remaining(rows) {
    if (!rows.length) return 'No SKUs with both inventory and recent sales.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku}) — ${r.days_of_inventory_remaining || 0} days (${intish(r.on_hand)} on hand, ${intish(r.units_sold_30d)} sold/30d)`
    );
    return `Days of inventory remaining (lowest first):\n${top.join('\n')}`;
  },

  week_over_week(rows) {
    const cur = rows.find((r) => r.bucket === 'current') || {};
    const prev = rows.find((r) => r.bucket === 'previous') || {};
    const c = Number(cur.revenue || 0);
    const p = Number(prev.revenue || 0);
    const delta = c - p;
    const pct = p > 0 ? (delta / p) * 100 : null;
    const pctTxt = pct == null ? 'n/a' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
    return `This week: ${money(c)} | Last week: ${money(p)} | Change: ${pctTxt}`;
  },

  year_over_year(rows) {
    const cur = rows.find((r) => r.bucket === 'current') || {};
    const prev = rows.find((r) => r.bucket === 'previous') || {};
    const c = Number(cur.revenue || 0);
    const p = Number(prev.revenue || 0);
    const delta = c - p;
    const pct = p > 0 ? (delta / p) * 100 : null;
    const pctTxt = pct == null ? 'n/a' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
    return `This year vs last year: ${money(c)} vs ${money(p)} (${pctTxt} change).`;
  },

  capability_unsupported(rows, plan) {
    const key = (plan && plan.params && plan.params.unsupportedKey) || 'this metric';
    const msgs = {
      conversion_rate: `Conversion rate is not in the currently-synced data. Computing it requires session / visitor data (Shopify Analytics or GA), which we do not sync today. We can answer order-side metrics (orders, revenue, customers, AOV) directly.`,
      abandoned_cart_rate: `Abandoned cart rate is not in the currently-synced data. Shopify keeps these in /checkouts.json, which we do not sync today.`,
      email_campaign_performance: `Email campaign performance is not in the currently-synced data. Shopify Email / Klaviyo / Mailchimp data is not connected.`,
      traffic_sources: `External traffic sources (Google / Facebook / Direct) are not in the currently-synced data. We do have Shopify "source_name" (web / pos / iphone / android) — try "orders by referrer".`,
    };
    return msgs[key] || `That metric isn't in the currently-synced data, so I can't compute it from order/customer/product records alone.`;
  },

  // ===== v7 formatters (Round-3) ===========================================

  orders_by_period_count(rows, plan) {
    const r = rows[0] || {};
    const label = (plan && plan.timeframe && plan.timeframe.label) || 'window';
    return `${intish(r.orders)} orders placed ${label} (${money(r.revenue)} in revenue).`;
  },

  orders_under_amount(rows, plan) {
    const r = rows[0] || {};
    const v = (plan && plan.params && plan.params.underAmount) || 50;
    return `${intish(r.orders)} orders under ${money(v)}${windowLabel(plan)} (${money(r.revenue)} in revenue, avg ${money(r.avg_total)}).`;
  },

  order_count_by_day(rows, plan) {
    if (!rows.length) return `No orders${windowLabel(plan)}.`;
    const lines = rows.slice(0, 14).map((r) =>
      `${shortDate(r.bucket)}: ${intish(r.orders)} orders (${money(r.net_revenue)})`
    );
    const total = rows.reduce((s, r) => s + Number(r.orders || 0), 0);
    return `Orders by day${windowLabel(plan)}:\n${lines.join('\n')}\nTotal: ${intish(total)} orders.`;
  },

  orders_on_weekends(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders were placed on weekends${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  customer_most_orders(rows) {
    if (!rows.length) return 'No customer order data.';
    const r = rows[0];
    const who = r.customer_name || r.email || `#${r.customer_id}`;
    return `Your customer with the most orders is ${who} with ${intish(r.order_count)} orders (${money(r.total_spend)} lifetime, last seen ${shortDate(r.last_order_at)}).`;
  },

  customers_one_time_only_period(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.customers_one_time_only)} customers ordered exactly once${windowLabel(plan)} (avg order ${money(r.avg_order_value)}).`;
  },

  customer_retention_rate(rows, plan) {
    const r = rows[0] || {};
    const retained = Number(r.retained_customers || 0);
    const purch = Number(r.purchasing_customers || 0);
    const pct = purch ? (retained / purch) * 100 : 0;
    return `Customer retention rate${windowLabel(plan)}: ${pct.toFixed(1)}% (${intish(retained)} of ${intish(purch)} purchasing customers had ordered before this window).`;
  },

  avg_days_between_orders(rows) {
    const r = rows[0] || {};
    return `The average days between repeat orders is ${r.avg_days_between_orders || 0} days (across ${intish(r.repeat_customers)} repeat customers).`;
  },

  bottom_products_by_units(rows, plan) {
    if (!rows.length) return `No product sales${windowLabel(plan)}.`;
    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.product} — ${intish(r.units)} units · ${money(r.revenue)}`
    );
    return `Bottom products by units${windowLabel(plan)}:\n${lines.join('\n')}`;
  },

  products_zero_sales_period(rows, plan) {
    if (!rows.length) return `Every on-hand SKU sold at least one unit${windowLabel(plan)}.`;
    const lines = rows.slice(0, 12).map((r, i) =>
      `${i + 1}. ${r.product_title} (${r.sku}) — ${intish(r.on_hand)} on hand`
    );
    return `${rows.length} products had zero sales${windowLabel(plan)} (showing first 12):\n${lines.join('\n')}`;
  },

  newest_products_added_period(rows, plan) {
    if (!rows.length) return `No new products added${windowLabel(plan)}.`;
    const lines = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.title} (${r.vendor || '-'}) — added ${shortDate(r.created_at)}`
    );
    return `${rows.length} products added${windowLabel(plan)} (showing newest 10):\n${lines.join('\n')}`;
  },

  varietal_top_seller(rows, plan) {
    if (!rows.length) return `No varietal sales${windowLabel(plan)}.`;
    const r = rows[0];
    const ranked = rows.slice(0, 5).map((x, i) => `${i + 1}. ${x.varietal} — ${intish(x.units)} units (${money(x.revenue)})`);
    return `The varietal that sells the most${windowLabel(plan)} is ${r.varietal} with ${intish(r.units)} units (${money(r.revenue)}).\nTop 5:\n${ranked.join('\n')}`;
  },

  product_count_total(rows) {
    const r = rows[0] || {};
    return `You have ${intish(r.products)} products in the catalog (${intish(r.active_products)} active, ${intish(r.variants)} variants).`;
  },

  inventory_per_product_summary(rows) {
    if (!rows.length) return 'No inventory data.';
    const lines = rows.slice(0, 12).map((r, i) =>
      `${i + 1}. ${r.product_title} — ${intish(r.total_on_hand)} units (${intish(r.variant_count)} variants, avg ${money(r.avg_price)})`
    );
    return `Inventory levels by product (top 12):\n${lines.join('\n')}`;
  },

  inventory_by_location_most(rows) {
    if (!rows.length) return 'No location inventory data.';
    const r = rows[0];
    return `The location with the most inventory is ${r.location_name || '(unknown)'} with ${intish(r.on_hand_units)} units (${intish(r.inventory_items)} inventory items).`;
  },

  avg_days_to_ship(rows, plan) {
    const r = rows[0] || {};
    if (!r.orders) return `Not enough fulfillment data${windowLabel(plan)}.`;
    const note = r.has_precise ? '(precise fulfillment timestamps)' : '(approximate — using closed_at)';
    return `Average days to ship: ${r.avg_days || 0} days${windowLabel(plan)} ${note} across ${intish(r.orders)} orders.`;
  },

  orders_same_day_shipped(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders shipped same-day${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  orders_shipped_within_days(rows, plan) {
    const r = rows[0] || {};
    const d = (plan && plan.params && plan.params.shipWithinDays) || 2;
    return `${intish(r.orders)} orders shipped within ${d} day${d === 1 ? '' : 's'}${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  most_common_shipping_method(rows, plan) {
    if (!rows.length) return 'No shipping data.';
    const r = rows[0];
    return `Your most common shipping method${windowLabel(plan)} is "${r.shipping_method}" with ${intish(r.orders)} orders (${money(r.shipping_revenue)} in shipping revenue).`;
  },

  avg_shipping_cost_per_order(rows, plan) {
    const r = rows[0] || {};
    return `Average shipping cost per order${windowLabel(plan)}: ${money(r.avg_shipping)} (total ${money(r.total_shipping)} across ${intish(r.orders)} orders).`;
  },

  orders_pending_shipment(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders are pending shipment right now${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  avg_discount_per_order(rows, plan) {
    const r = rows[0] || {};
    return `Average discount per order${windowLabel(plan)}: ${money(r.avg_discount)} (${intish(r.discounted_orders)} of ${intish(r.orders)} orders had a discount).`;
  },

  refund_trend_period(rows, plan) {
    if (!rows.length) return `No refunds${windowLabel(plan)}.`;
    const lines = rows.slice(0, 14).map((r) => `${shortDate(r.bucket)}: ${intish(r.refunds)} refunds · ${money(r.refund_amount)}`);
    const totalR = rows.reduce((a, r) => a + Number(r.refund_amount || 0), 0);
    const totalC = rows.reduce((a, r) => a + Number(r.refunds || 0), 0);
    return `Refund trend${windowLabel(plan)}:\n${lines.join('\n')}\nTotal: ${intish(totalC)} refunds · ${money(totalR)}.`;
  },

  total_refunded_period(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.refunded_orders)} refunded orders${windowLabel(plan)} totaling ${money(r.refund_total)}.`;
  },

  orders_between_hours(rows, plan) {
    const r = rows[0] || {};
    const a = (plan && plan.params && plan.params.hourStart) != null ? plan.params.hourStart : 18;
    const b = (plan && plan.params && plan.params.hourEnd)   != null ? plan.params.hourEnd   : 21;
    const fmt = (h) => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
    return `${intish(r.orders)} orders placed between ${fmt(a)} and ${fmt(b)}${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  compare_product_sales_periods(rows, plan) {
    if (!rows.length) return 'No products to compare.';
    const lines = rows.slice(0, 10).map((r, i) => {
      const delta = Number(r.units_delta || 0);
      const sign = delta > 0 ? '+' : '';
      return `${i + 1}. ${r.product} — current ${intish(r.units_current)} vs prior ${intish(r.units_previous)} (${sign}${delta})`;
    });
    return `Product sales: this window vs prior window${windowLabel(plan)} (top by improvement):\n${lines.join('\n')}`;
  },

  net_after_refunds_discounts(rows, plan) {
    const r = rows[0] || {};
    return `Net (gross - refunds)${windowLabel(plan)}: ${money(r.net_after_refunds)} (gross ${money(r.gross)}, discounts ${money(r.discounts)}, refunds ${money(r.refunds)}, tax ${money(r.tax)}). Note: COGS/cost-based profit is not in the synced schema, so this is net-after-discounts-and-refunds, not net profit.`;
  },

  avg_tax_per_order(rows, plan) {
    const r = rows[0] || {};
    return `Average tax per order${windowLabel(plan)}: ${money(r.avg_tax)} (total ${money(r.total_tax)} across ${intish(r.orders)} orders).`;
  },

  cross_sell_by_category(rows, plan) {
    if (!rows.length) return `No category co-purchase data${windowLabel(plan)}.`;
    const lines = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.category_a} + ${r.category_b} — ${intish(r.orders_with_both)} orders`
    );
    return `Cross-sell patterns by category${windowLabel(plan)}:\n${lines.join('\n')}`;
  },

  customers_medium_value(rows, plan) {
    const r = rows[0] || {};
    const lo = (plan && plan.params && plan.params.spendMin) != null ? plan.params.spendMin : 100;
    const hi = (plan && plan.params && plan.params.spendMax) != null ? plan.params.spendMax : 500;
    return `${intish(r.customers)} customers have lifetime spend between ${money(lo)} and ${money(hi)} (total ${money(r.total_spend)}, avg ${money(r.avg_spend)}).`;
  },

  orders_never_fulfilled(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} orders were never fulfilled${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  completed_orders_period(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} completed orders${windowLabel(plan)} (${money(r.revenue)} in revenue).`;
  },

  all_discount_codes_used(rows) {
    if (!rows.length) return 'No discount codes have been used.';
    const codes = rows.slice(0, 50).map((r) => r.code).filter(Boolean);
    return `Discount codes used (${rows.length} distinct codes):\n${codes.join(', ')}`;
  },

  largest_line_item_by_quantity(rows, plan) {
    if (!rows.length) return `No line items${windowLabel(plan)}.`;
    const r = rows[0];
    return `Largest single line item by quantity${windowLabel(plan)}: ${r.product_title} (${r.sku || '-'}) — qty ${intish(r.quantity)} @ ${money(r.unit_price)} (order ${r.order_name} on ${shortDate(r.occurred_at)}).`;
  },

  product_highest_avg_qty(rows, plan) {
    if (!rows.length) return `Not enough data${windowLabel(plan)}.`;
    const r = rows[0];
    const lines = rows.slice(0, 5).map((x, i) =>
      `${i + 1}. ${x.product_title} — avg qty ${x.avg_qty} (across ${intish(x.orders)} orders, total ${intish(x.total_qty)} units)`
    );
    return `Product with highest avg quantity per order${windowLabel(plan)}: ${r.product_title} (avg ${r.avg_qty} units/order).\n${lines.join('\n')}`;
  },

  orders_containing_product(rows, plan) {
    const r = rows[0] || {};
    const what = (plan && plan.params && (plan.params.varietal || plan.params.productContainsHint)) || 'that product';
    if (!r.orders) return `No orders include "${what}"${windowLabel(plan)}.`;
    return `${intish(r.orders)} orders include "${what}"${windowLabel(plan)} (${intish(r.line_items)} line items, ${money(r.revenue)} in revenue).`;
  },

  orders_pending_over_days(rows, plan) {
    const r = rows[0] || {};
    const d = (plan && plan.params && plan.params.pendingOverDays) || 3;
    return `${intish(r.orders)} orders have been pending more than ${d} day${d === 1 ? '' : 's'} (${money(r.revenue)} in revenue).`;
  },

  repeat_purchase_rate_period(rows, plan) {
    const r = rows[0] || {};
    const rep = Number(r.repeat_customers || 0);
    const purch = Number(r.purchasing_customers || 0);
    const pct = purch ? (rep / purch) * 100 : 0;
    return `Repeat purchase rate${windowLabel(plan)}: ${pct.toFixed(1)}% (${intish(rep)} of ${intish(purch)} purchasing customers placed ≥2 orders).`;
  },

  avg_time_between_repeat(rows) {
    const r = rows[0] || {};
    return `The average time between repeat purchases is ${r.avg_days || 0} days (across ${intish(r.repeat_customers)} customers who ordered at least twice).`;
  },

  orders_with_multiple_lines(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.multi_item_orders)} orders had multiple line items${windowLabel(plan)} (out of ${intish(r.total_orders)} total). Single-item orders: ${intish(r.single_item_orders)}.`;
  },

  orders_single_line_item(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.single_item_orders)} orders had a single line item${windowLabel(plan)} (out of ${intish(r.total_orders)} total).`;
  },

  guest_checkout_orders(rows, plan) {
    const r = rows[0] || {};
    return `${intish(r.orders)} guest checkout orders${windowLabel(plan)} (no customer attached) totaling ${money(r.revenue)}.`;
  },

  email_subscriber_orders(rows, plan) {
    const r = rows[0] || {};
    if (!r.orders) {
      return `0 orders from email subscribers${windowLabel(plan)}. Note: this requires customers.raw.accepts_marketing to be set on each customer — if it's not in the synced data this number will be 0.`;
    }
    return `${intish(r.orders)} orders came from email subscribers${windowLabel(plan)} (${intish(r.customers)} distinct subscribers, ${money(r.revenue)} in revenue).`;
  },

  // ===== v8 formatters (Round-4) ==========================================

  sku_top_seller(rows, plan) {
    if (!rows.length) return `No SKU sales${windowLabel(plan)}.`;
    const lines = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.sku} — ${r.product_title}${r.variant_title && r.variant_title !== 'Default Title' ? ' · ' + r.variant_title : ''} — ${intish(r.units_sold)} units (${money(r.net_revenue)})`
    );
    return `Top SKUs by units${windowLabel(plan)}:\n${lines.join('\n')}`;
  },

  data_date_range(rows) {
    const r = rows[0] || {};
    if (!r.oldest) return 'No order data on file.';
    const span = Math.round(Number(r.span_days || 0));
    return `Order data covers ${shortDate(r.oldest)} through ${shortDate(r.newest)} (${intish(r.total_orders)} orders across ${intish(span)} days).`;
  },

  data_sync_status(rows) {
    const r = rows[0] || {};
    if (!r.last_sync_at) return 'No sync data on file.';
    const h = Number(r.hours_since_sync || 0);
    const hOrder = Number(r.hours_since_newest_order || 0);
    const fresh = h < 24 ? 'fresh' : h < 72 ? 'a bit stale' : 'stale';
    const daysSince = (h / 24).toFixed(1);
    return `Data was last synced ${shortDate(r.last_sync_at)} (${daysSince} days ago — ${fresh}). Newest order in DB: ${shortDate(r.newest_order_at)} (${(hOrder / 24).toFixed(1)} days ago). ${intish(r.total_orders)} orders total.`;
  },

  oldest_order_date(rows) {
    const r = rows[0] || {};
    if (!r.oldest) return 'No order data.';
    return `Our first order was on ${shortDate(r.oldest)}.`;
  },

  newest_order_date(rows) {
    const r = rows[0] || {};
    if (!r.newest) return 'No order data.';
    return `Our most recent order was on ${shortDate(r.newest)}.`;
  },

  customer_first_last_order(rows, plan) {
    const r = rows[0] || {};
    const who = r.customer_name || r.email || '(unknown)';
    if (!r.first_order_at) return `${who} has no orders on file.`;
    return `${who} — first order ${shortDate(r.first_order_at)} · last order ${shortDate(r.last_order_at)} · ${intish(r.order_count)} orders · ${money(r.total_spent)} lifetime.`;
  },

  customer_unique_count(rows) {
    const r = rows[0] || {};
    return `You have ${intish(r.total_customers)} customers on file. ${intish(r.purchasing_customers)} have placed an order. ${intish(r.guest_orders)} orders were guest checkouts (no customer attached).`;
  },

  products_on_sale(rows) {
    if (!rows.length) return 'No products are currently on sale (compare_at_price > price).';
    const top = rows.slice(0, 12).map((r, i) =>
      `${i + 1}. ${r.title}${r.variant_title && r.variant_title !== 'Default Title' ? ' · ' + r.variant_title : ''} — was ${money(r.compare_at_price)}, now ${money(r.price)} (-${r.discount_pct || 0}%)`
    );
    return `Products on sale (${rows.length}):\n${top.join('\n')}`;
  },

  top_customers_by_units_purchased(rows, plan) {
    if (!rows.length) return 'No customers found.';
    const top = rows.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.customer_name || r.email || '#' + r.customer_id} — ${intish(r.units)} units (${money(r.total_spend)}, ${intish(r.order_count)} orders)`
    );
    return `Top customers by units purchased${windowLabel(plan)}:\n${top.join('\n')}`;
  },

  new_vs_returning_by_month(rows, plan) {
    if (!rows.length) return `No customer activity in window.`;
    const lines = rows.map((r) => {
      const month = new Date(r.bucket).toISOString().slice(0, 7);
      const total = Number(r.purchasing_customers || 0);
      const newPct = total ? ((Number(r.new_customers) / total) * 100).toFixed(1) : '0.0';
      return `${month}: ${intish(r.new_customers)} new · ${intish(r.returning_customers)} returning (${newPct}% new)`;
    });
    return `New vs returning customers by month:\n${lines.join('\n')}`;
  },
};

function format(intent, rows, plan) {
  const fn = F[intent];
  if (!fn) return `Returned ${rows.length} row(s).`;
  return fn(rows, plan);
}

module.exports = { format, money, intish, shortDate };
