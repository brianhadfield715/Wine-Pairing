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
    return `${(plan && plan.timeframe && plan.timeframe.label) || 'window'}: ${intish(r.orders)} orders, ${intish(r.units)} units, ${money(r.net_revenue)} net (${money(r.discounts)} in discounts).`;
  },

  revenue_summary(rows, plan) { return F.sales_summary(rows, plan); },

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
};

function format(intent, rows, plan) {
  const fn = F[intent];
  if (!fn) return `Returned ${rows.length} row(s).`;
  return fn(rows, plan);
}

module.exports = { format, money, intish, shortDate };
