// src/analytics/visualizations.js
// Builds a machine-readable visualization spec for an intent's rows, used by
// any frontend that wants to render a chart or table. Spec shape:
//
//   {
//     output_mode: 'chart' | 'table' | 'text',
//     chart_type?: 'bar' | 'line' | 'pie' | 'donut' | 'stacked_bar',
//     title: string,
//     subtitle?: string,
//     x_field?: string,       // column name on rows used for x axis
//     y_field?: string,       // column name on rows used for y axis
//     series?: [              // for multi-series charts
//       { name, x_field, y_field }
//     ],
//     value_format?: 'currency' | 'integer' | 'percent',
//     rows: array              // structured rows for the chosen visualization
//   }
//
// Intents that are inherently visual (time-series, breakdowns, dashboards)
// emit a visualization spec automatically. Other intents emit one only when
// the user explicitly asked for chart/table (params.outputMode).

function _label(plan) {
  return (plan && plan.timeframe && plan.timeframe.label) || '';
}

// Inherently-visual intents and their default chart type.
const VISUAL_DEFAULTS = {
  sales_time_series:        { chart_type: 'line',  y_field: null /* metric-driven */ },
  type_breakdown:           { chart_type: 'bar',   x_field: 'type',     y_field: 'units' },
  type_top_seller:          { chart_type: 'bar',   x_field: 'type',     y_field: 'units' },
  varietal_ranking:         { chart_type: 'bar',   x_field: 'varietal', y_field: 'units' },
  top_items_by_units:       { chart_type: 'bar',   x_field: 'product_title', y_field: 'units_sold' },
  top_items_by_revenue:     { chart_type: 'bar',   x_field: 'product_title', y_field: 'net_revenue' },
  top_vendors:              { chart_type: 'bar',   x_field: 'vendor', y_field: 'net_revenue' },
  inventory_value_by_vendor:{ chart_type: 'bar',   x_field: 'vendor', y_field: 'retail_value' },
  inventory_value_by_category: { chart_type: 'bar', x_field: 'category', y_field: 'retail_value' },
  vendor_growth:            { chart_type: 'bar',   x_field: 'vendor', y_field: 'revenue_delta' },
  vendor_decline:           { chart_type: 'bar',   x_field: 'vendor', y_field: 'revenue_delta' },
  category_performance:     { chart_type: 'bar',   x_field: 'category', y_field: 'revenue' },
  basket_pairs:             { chart_type: null /* table */, x_field: null, y_field: null },
  dashboard_summary:        { chart_type: null /* mixed */, x_field: null, y_field: null },
  busiest_hour:             { chart_type: 'bar',   x_field: 'hour_of_day', y_field: 'orders' },
  busiest_period_pattern:   { chart_type: 'bar',   x_field: 'hour_of_day', y_field: 'orders' },
  period_over_period:       { chart_type: 'bar',   x_field: 'bucket', y_field: 'revenue' },
  lapsed_frequent_customers:{ chart_type: null /* table */, x_field: null, y_field: null },
  customer_reactivation_candidates: { chart_type: null /* table */, x_field: null, y_field: null },
};

function intentDefault(intent) {
  return VISUAL_DEFAULTS[intent] || null;
}

function build(intent, rows, plan) {
  const def = intentDefault(intent);
  const explicit = plan && plan.params && plan.params.outputMode;
  // No explicit user ask AND no default → skip viz spec entirely.
  if (!def && !explicit) return null;

  // Choose output mode.
  let output_mode = explicit || 'chart';
  if (def && def.chart_type === null && !explicit) output_mode = 'table';
  if (explicit === 'table') output_mode = 'table';
  if (explicit === 'chart') output_mode = 'chart';

  // Choose chart type.
  let chart_type = (plan && plan.params && plan.params.chartType) || (def && def.chart_type) || null;
  if (output_mode === 'table') chart_type = null;

  const out = {
    output_mode,
    chart_type,
    title: titleFor(intent, plan),
    subtitle: _label(plan) || null,
    rows: rows || [],
  };

  // Per-intent shaping.
  if (intent === 'sales_time_series') {
    const metric = (plan && plan.params && plan.params.metric) || 'revenue';
    const yMap = { orders: 'orders', units: 'units', aov: 'average_order_value', revenue: 'net_revenue' };
    out.x_field = 'bucket';
    out.y_field = yMap[metric] || 'net_revenue';
    out.value_format = metric === 'revenue' || metric === 'aov' ? 'currency' : 'integer';
    if (!plan || !plan.params || !plan.params.chartType) out.chart_type = 'line';
  } else if (intent === 'period_over_period') {
    out.x_field = 'bucket';
    out.y_field = 'revenue';
    out.value_format = 'currency';
    out.chart_type = (plan && plan.params && plan.params.chartType) || 'bar';
  } else if (def) {
    out.x_field = def.x_field;
    out.y_field = def.y_field;
    if (/revenue|spend|retail_value|delta/.test(out.y_field || '')) out.value_format = 'currency';
    else if (/share|percent|pct/.test(out.y_field || '')) out.value_format = 'percent';
    else out.value_format = 'integer';
  } else {
    // Explicit user ask with no default → pick a sensible field pair from
    // the row keys.
    const sample = rows && rows[0];
    if (sample) {
      const keys = Object.keys(sample);
      const numericKey = keys.find((k) => typeof sample[k] === 'number' || (typeof sample[k] === 'string' && /^-?\d+(\.\d+)?$/.test(sample[k])));
      const labelKey = keys.find((k) => typeof sample[k] === 'string' && !/^-?\d+(\.\d+)?$/.test(sample[k]));
      out.x_field = labelKey || keys[0];
      out.y_field = numericKey || keys[1];
      out.value_format = /revenue|spend|price|value/.test(out.y_field || '') ? 'currency' : 'integer';
    }
  }

  return out;
}

function titleFor(intent, plan) {
  const tl = _label(plan);
  const T = {
    sales_time_series:            `Sales by ${plan && plan.params && plan.params.grain || 'period'}${tl ? ' — ' + tl : ''}`,
    top_items_by_units:           `Top items by units${tl ? ' — ' + tl : ''}`,
    top_items_by_revenue:         `Top items by revenue${tl ? ' — ' + tl : ''}`,
    top_vendors:                  `Top vendors${tl ? ' — ' + tl : ''}`,
    type_breakdown:               `Units by type${tl ? ' — ' + tl : ''}`,
    type_top_seller:              `Top types${tl ? ' — ' + tl : ''}`,
    varietal_ranking:             `Top varietals${tl ? ' — ' + tl : ''}`,
    inventory_value_by_vendor:    `Inventory value by vendor`,
    inventory_value_by_category:  `Inventory value by category`,
    vendor_growth:                `Vendor growth${tl ? ' — ' + tl : ''}`,
    vendor_decline:               `Vendor decline${tl ? ' — ' + tl : ''}`,
    category_performance:         `Category performance${tl ? ' — ' + tl : ''}`,
    basket_pairs:                 `Products bought together${tl ? ' — ' + tl : ''}`,
    dashboard_summary:            `KPI dashboard${tl ? ' — ' + tl : ''}`,
    busiest_hour:                 `Busiest hour${tl ? ' — ' + tl : ''}`,
    busiest_period_pattern:       `Typical busiest hours (last 12 weeks)`,
    period_over_period:           `Period over period`,
    lapsed_frequent_customers:    `Lapsed frequent customers`,
    customer_reactivation_candidates: `Reactivation candidates`,
  };
  return T[intent] || (intent ? intent.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Result');
}

module.exports = { build, intentDefault };
