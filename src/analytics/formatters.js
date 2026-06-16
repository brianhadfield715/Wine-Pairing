// src/analytics/formatters.js
// Turns the SQL row set for an intent into a short human-readable answer
// string. Long lists are truncated; counts always reflect the underlying
// row count.

function money(n) {
  if (n == null) return '$0';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nameOrEmail(row) {
  return (row.customer_name && row.customer_name.trim()) || row.email || `#${row.customer_id || '?'}`;
}

const formatters = {
  top_customers_by_spend(rows) {
    if (!rows.length) return 'No customers with spend on file.';
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${nameOrEmail(r)} — ${money(r.total_spend)} (${r.order_count} orders)`);
    return `Top spenders:\n${top.join('\n')}`;
  },

  customer_profile(rows) {
    if (!rows.length) return 'No matching customer found.';
    if (rows.length === 1) {
      const r = rows[0];
      const bits = [`${nameOrEmail(r)} — ${money(r.total_spend)} across ${r.order_count} orders`];
      if (r.favorite_vendor) bits.push(`favorite vendor: ${r.favorite_vendor}`);
      if (r.favorite_product_type) bits.push(`favorite category: ${r.favorite_product_type}`);
      if (r.last_order_at) bits.push(`last order: ${new Date(r.last_order_at).toISOString().slice(0, 10)}`);
      return bits.join(' · ');
    }
    return `Recent active customers (${rows.length}). See data for details.`;
  },

  customers_who_bought(rows) {
    if (!rows.length) return 'No customers matched.';
    const top = rows.slice(0, 5).map((r) => `${nameOrEmail(r)} — ${r.units} units, ${money(r.spend)}`);
    return `Matched ${rows.length} customer(s):\n${top.join('\n')}`;
  },

  customer_count(rows) {
    const r = rows[0] || {};
    return `Customers: ${r.total_customers ?? 0} total, ${r.customers_with_orders ?? 0} with orders, ${r.active_90d ?? 0} active in last 90 days.`;
  },

  new_customers(rows) {
    if (!rows.length) return 'No new customers in that window.';
    return `${rows.length} new customer(s) in window. Top: ${nameOrEmail(rows[0])} (${money(rows[0].total_spend)}).`;
  },

  lapsed_customers(rows) {
    if (!rows.length) return 'No lapsed customers found.';
    const top = rows.slice(0, 5).map((r) => `${nameOrEmail(r)} — ${money(r.total_spend)}, last seen ${r.days_since_last_order}d ago`);
    return `Lapsed customers (${rows.length}):\n${top.join('\n')}`;
  },

  basket_pairs(rows) {
    if (!rows.length) return 'No co-purchase pairs found yet (need more order history).';
    const top = rows.slice(0, 5).map((r) => `${r.title_a} + ${r.title_b} — ${r.orders_together} orders`);
    return `Top SKU pairs:\n${top.join('\n')}`;
  },

  top_skus(rows) {
    if (!rows.length) return 'No sales in that window.';
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.product_title} (${r.sku}) — ${r.units_sold} units / ${money(r.net_revenue)}`);
    return `Top SKUs:\n${top.join('\n')}`;
  },

  units_sold_per_sku(rows) {
    if (!rows.length) return 'No matching SKU sales.';
    if (rows.length === 1 && rows[0].sku && rows[0].units_sold != null) {
      const r = rows[0];
      return `${r.product_title} (${r.sku}): ${r.units_sold} units lifetime, ${r.units_sold_30d ?? '-'} last 30d, on hand ${r.on_hand ?? '-'}.`;
    }
    return formatters.top_skus(rows);
  },

  top_vendors(rows) {
    if (!rows.length) return 'No vendor sales in that window.';
    const top = rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.vendor} — ${money(r.net_revenue)} (${r.units_sold} units, ${r.orders} orders)`);
    return `Top vendors:\n${top.join('\n')}`;
  },

  recent_orders(rows) {
    if (!rows.length) return 'No orders in that window.';
    const top = rows.slice(0, 5).map((r) =>
      `${r.name} — ${money(r.total_price)} ${r.customer_name ? `(${r.customer_name})` : ''}`
    );
    return `Recent orders (${rows.length}):\n${top.join('\n')}`;
  },

  revenue_summary(rows) {
    const r = rows[0] || {};
    return `Last ${r.window_days} days: ${r.orders || 0} orders, ${r.units || 0} units, ${money(r.net_revenue)} net (${money(r.discounts)} in discounts).`;
  },

  low_stock(rows) {
    if (!rows.length) return 'No low-stock variants right now.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'}) — ${r.on_hand} left @ ${money(r.price)}`);
    return `Low stock (${rows.length}):\n${top.join('\n')}`;
  },

  out_of_stock(rows) {
    if (!rows.length) return 'Nothing is out of stock.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'})`);
    return `Out of stock (${rows.length}):\n${top.join('\n')}`;
  },

  in_stock_filtered(rows) {
    if (!rows.length) return 'No matching in-stock variants.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku || '-'}) — ${r.on_hand} on hand @ ${money(r.price)}`);
    return `Matched ${rows.length} variant(s):\n${top.join('\n')}`;
  },

  dead_inventory(rows) {
    if (!rows.length) return 'No dead inventory detected.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — ${r.on_hand} on hand, last sold ${r.last_sold_at ? new Date(r.last_sold_at).toISOString().slice(0,10) : 'never'}`);
    return `Dead inventory candidates (${rows.length}):\n${top.join('\n')}`;
  },

  low_stock_high_velocity(rows) {
    if (!rows.length) return 'No reorder candidates right now.';
    const top = rows.slice(0, 8).map((r) => `${r.product_title} (${r.sku}) — ${r.on_hand} left, sold ${r.units_sold_30d} in 30d`);
    return `Reorder candidates (${rows.length}):\n${top.join('\n')}`;
  },
};

function format(intent, rows) {
  const fn = formatters[intent];
  if (!fn) return `Returned ${rows.length} row(s).`;
  return fn(rows);
}

module.exports = { format, money };
