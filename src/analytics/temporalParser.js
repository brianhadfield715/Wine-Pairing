// src/analytics/temporalParser.js
// Dedicated temporal phrase → concrete date-range parser.
//
// Output shape (all fields optional except mode and label):
//   {
//     mode: 'point' | 'window' | 'all_time' | 'open_after' | 'open_before',
//     sinceIso?: ISO8601 string,   // lower bound, inclusive
//     untilIso?: ISO8601 string,   // upper bound, exclusive
//     label: string,               // human label for the window ("yesterday")
//     grain?: 'day'|'week'|'month'|'quarter'|'year',
//     days?: number                // approximate days width, when meaningful
//   }
//
// Design notes:
//   - "all time" returns mode='all_time' with no since/until so SQL builders
//     can omit the time filter entirely.
//   - "today", "yesterday" snap to calendar days in the configured timezone.
//   - Phrases like "last 30 days" produce a rolling-window range
//     [now()-30d, now()).
//   - Calendar phrases ("last month", "this month", "in May", "Q1") snap to
//     calendar boundaries.
//   - The parser is conservative: if no temporal phrase is found, mode='all_time'
//     so callers can decide their own default window.

const TZ_OFFSET_MIN = Number(process.env.ANALYTICS_TZ_OFFSET_MIN || -300); // CDT default

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_INDEX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

const DAYS_OF_WEEK = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];
const DAY_INDEX = Object.fromEntries(DAYS_OF_WEEK.map((d, i) => [d, i]));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowLocal(now = new Date()) {
  // Shift the timestamp by TZ_OFFSET_MIN so date math feels like it's in the
  // configured wall-clock zone. We always serialize back to ISO/UTC at the end.
  return new Date(now.getTime() + TZ_OFFSET_MIN * 60_000);
}

function toIsoUtc(localDate) {
  // Reverse the shift so the wall-clock boundary we computed corresponds to
  // the right UTC instant.
  return new Date(localDate.getTime() - TZ_OFFSET_MIN * 60_000).toISOString();
}

function startOfDayLocal(d) {
  const x = new Date(d.getTime());
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function startOfWeekLocal(d) {
  // Week starts Monday. (Adjust to 0=Sunday by changing the +6 below.)
  const x = startOfDayLocal(d);
  const dow = x.getUTCDay(); // 0..6, 0=Sunday
  const delta = (dow + 6) % 7; // days since Monday
  x.setUTCDate(x.getUTCDate() - delta);
  return x;
}

function startOfMonthLocal(d) {
  const x = startOfDayLocal(d);
  x.setUTCDate(1);
  return x;
}

function startOfQuarterLocal(d) {
  const x = startOfMonthLocal(d);
  const m = x.getUTCMonth();
  x.setUTCMonth(m - (m % 3));
  return x;
}

function startOfYearLocal(d) {
  const x = startOfDayLocal(d);
  x.setUTCMonth(0, 1);
  return x;
}

function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() + n); return x; }
function addYears(d, n) { const x = new Date(d.getTime()); x.setUTCFullYear(x.getUTCFullYear() + n); return x; }

function widthDays(sinceIso, untilIso) {
  if (!sinceIso || !untilIso) return null;
  return Math.round((new Date(untilIso) - new Date(sinceIso)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Pattern handlers
// ---------------------------------------------------------------------------

function tryRollingDays(q, now) {
  const m = q.match(/\b(?:last|past)\s+(\d+)\s+day/);
  if (!m) return null;
  const n = Math.max(1, parseInt(m[1], 10));
  const since = addDays(now, -n);
  return {
    mode: 'window',
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    label: `last ${n} days`,
    grain: 'day',
    days: n,
  };
}

function tryRollingMonths(q, now) {
  const m = q.match(/\b(?:last|past)\s+(\d+)\s+month/);
  if (!m) return null;
  const n = Math.max(1, parseInt(m[1], 10));
  const since = addMonths(now, -n);
  return {
    mode: 'window',
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    label: `last ${n} months`,
    grain: 'month',
    days: widthDays(since.toISOString(), now.toISOString()),
  };
}

function tryRollingWeeks(q, now) {
  const m = q.match(/\b(?:last|past)\s+(\d+)\s+week/);
  if (!m) return null;
  const n = Math.max(1, parseInt(m[1], 10));
  const since = addDays(now, -n * 7);
  return {
    mode: 'window',
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    label: `last ${n} weeks`,
    grain: 'week',
    days: n * 7,
  };
}

function tryToday(q, now) {
  if (!/\btoday\b/.test(q)) return null;
  const s = startOfDayLocal(now);
  const e = addDays(s, 1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: 'today', grain: 'day', days: 1 };
}

function tryYesterday(q, now) {
  if (!/\byesterday\b/.test(q)) return null;
  const today = startOfDayLocal(now);
  const yest = addDays(today, -1);
  return { mode: 'window', sinceIso: toIsoUtc(yest), untilIso: toIsoUtc(today), label: 'yesterday', grain: 'day', days: 1 };
}

function tryThisWeek(q, now) {
  if (!/\bthis\s+week\b/.test(q)) return null;
  const s = startOfWeekLocal(now);
  const e = addDays(s, 7);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: 'this week', grain: 'week', days: 7 };
}

function tryLastWeek(q, now) {
  if (!/\blast\s+week\b/.test(q) && !/\bpast\s+week\b/.test(q)) return null;
  const thisWk = startOfWeekLocal(now);
  const s = addDays(thisWk, -7);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(thisWk), label: 'last week', grain: 'week', days: 7 };
}

function tryThisMonth(q, now) {
  if (!/\bthis\s+month\b/.test(q)) return null;
  const s = startOfMonthLocal(now);
  const e = addMonths(s, 1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: 'this month', grain: 'month' };
}

function tryLastMonth(q, now) {
  if (!/\blast\s+month\b/.test(q) && !/\bpast\s+month\b/.test(q)) return null;
  const thisMo = startOfMonthLocal(now);
  const s = addMonths(thisMo, -1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(thisMo), label: 'last month', grain: 'month' };
}

function tryThisQuarter(q, now) {
  if (!/\bthis\s+quarter\b/.test(q)) return null;
  const s = startOfQuarterLocal(now);
  const e = addMonths(s, 3);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: 'this quarter', grain: 'quarter' };
}

function tryLastQuarter(q, now) {
  if (!/\blast\s+quarter\b/.test(q) && !/\bpast\s+quarter\b/.test(q)) return null;
  const thisQ = startOfQuarterLocal(now);
  const s = addMonths(thisQ, -3);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(thisQ), label: 'last quarter', grain: 'quarter' };
}

function tryYearToDate(q, now) {
  if (!/\byear[- ]to[- ]date|ytd|this\s+year\b/.test(q)) return null;
  const s = startOfYearLocal(now);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: now.toISOString(), label: 'year to date', grain: 'year' };
}

function tryLastYear(q, now) {
  if (!/\blast\s+year\b/.test(q)) return null;
  const thisY = startOfYearLocal(now);
  const s = addYears(thisY, -1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(thisY), label: 'last year', grain: 'year' };
}

function tryAllTime(q) {
  if (/\ball[- ]?time\b|\blifetime\b|\bever\b|\boverall\b|\btotal(?:ly)?\s+(?:spent|spend|revenue|sales)\b/.test(q)) {
    return { mode: 'all_time', label: 'all time' };
  }
  return null;
}

function tryQuarterNumber(q, now) {
  const m = q.match(/\bq([1-4])\b(?:\s+(\d{4}))?/);
  if (!m) return null;
  const qi = parseInt(m[1], 10) - 1;
  const year = m[2] ? parseInt(m[2], 10) : now.getUTCFullYear();
  const s = new Date(Date.UTC(year, qi * 3, 1));
  const e = addMonths(s, 3);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: `Q${qi+1} ${year}`, grain: 'quarter' };
}

function tryNamedMonth(q, now) {
  // "in May", "in March 2026"
  const m = q.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/);
  if (!m) return null;
  const monthIdx = MONTH_INDEX[m[1]];
  const year = m[2] ? parseInt(m[2], 10) : now.getUTCFullYear();
  const s = new Date(Date.UTC(year, monthIdx, 1));
  const e = addMonths(s, 1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: `${MONTHS[monthIdx]} ${year}`, grain: 'month' };
}

function tryOnDayOfWeek(q, now) {
  // "on Sunday" → most recent past Sunday (single day).
  const m = q.match(/\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (!m) return null;
  const target = DAY_INDEX[m[1]];
  const today = startOfDayLocal(now);
  const todayDow = today.getUTCDay();
  let delta = (todayDow - target + 7) % 7;
  if (delta === 0) delta = 7; // most recent past, not today
  const s = addDays(today, -delta);
  const e = addDays(s, 1);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: `on ${m[1]}`, grain: 'day', days: 1 };
}

function tryWeekend(q, now) {
  if (!/\b(?:over the )?(?:last )?weekend\b/.test(q)) return null;
  // Most recent past weekend: Saturday 00:00 → Monday 00:00.
  const today = startOfDayLocal(now);
  const dow = today.getUTCDay(); // 0=Sun
  // Saturday of the most recent past weekend:
  // If today is Mon..Fri, Sat = today - (dow+1) effectively, or simpler:
  // walk back until we hit Saturday.
  let walk = 0;
  while (((today.getUTCDay() - walk + 7) % 7) !== 6 || walk === 0) {
    walk += 1;
    if (walk > 7) break;
  }
  const sat = addDays(today, -walk);
  const mon = addDays(sat, 2);
  return { mode: 'window', sinceIso: toIsoUtc(sat), untilIso: toIsoUtc(mon), label: 'over the weekend', grain: 'day', days: 2 };
}

function tryBetween(q) {
  const m = q.match(/\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  const s = new Date(`${m[1]}T00:00:00Z`);
  const e = new Date(`${m[2]}T00:00:00Z`);
  return { mode: 'window', sinceIso: s.toISOString(), untilIso: e.toISOString(), label: `between ${m[1]} and ${m[2]}` };
}

function trySince(q) {
  const m = q.match(/\b(?:since|after)\s+(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  const s = new Date(`${m[1]}T00:00:00Z`);
  return { mode: 'open_after', sinceIso: s.toISOString(), label: `since ${m[1]}` };
}

function tryBefore(q) {
  const m = q.match(/\bbefore\s+(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  const e = new Date(`${m[1]}T00:00:00Z`);
  return { mode: 'open_before', untilIso: e.toISOString(), label: `before ${m[1]}` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const HANDLERS = [
  tryAllTime,         // very explicit "all time" / "lifetime"
  tryBetween, trySince, tryBefore,
  tryRollingDays, tryRollingMonths, tryRollingWeeks,
  tryToday, tryYesterday,
  tryThisWeek, tryLastWeek,
  tryThisMonth, tryLastMonth,
  tryThisQuarter, tryLastQuarter,
  tryYearToDate, tryLastYear,
  tryQuarterNumber, tryNamedMonth,
  tryOnDayOfWeek, tryWeekend,
];

/**
 * Parse a question and return its temporal window. If no temporal phrase is
 * detected, returns { mode:'all_time', label:'all time' } so the caller can
 * decide whether to apply a sensible default.
 *
 * Tests can pin "now" by passing { now: Date }.
 */
function parse(questionRaw, { now = new Date() } = {}) {
  const q = String(questionRaw || '').toLowerCase();
  for (const fn of HANDLERS) {
    const r = fn(q, now);
    if (r) return r;
  }
  return { mode: 'all_time', label: 'all time' };
}

/**
 * Convenience: return SQL-ready `since`/`until` strings + a width-in-days
 * estimate, applying a default window when caller passes one.
 */
function withDefault(parsed, defaultDays) {
  if (parsed.mode !== 'all_time') return parsed;
  if (!defaultDays) return parsed;
  const now = new Date();
  const since = addDays(now, -defaultDays);
  return {
    mode: 'window',
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    label: `last ${defaultDays} days (default)`,
    grain: 'day',
    days: defaultDays,
  };
}

module.exports = { parse, withDefault };
