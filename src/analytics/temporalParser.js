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

// ---- Anchored weeks ("week of 5/31/2026" / "week of June 7 2026") --------
// A week is treated as the 7-day span starting at the given date.
function _parseAnyDate(raw, now) {
  const r1 = tryExactDateNumeric('on ' + raw);
  if (r1 && !r1.error) return r1;
  const r2 = tryExactDateIso('on ' + raw);
  if (r2 && !r2.error) return r2;
  const r3 = tryExactDateNamed('on ' + raw);
  if (r3 && !r3.error) return r3;
  return null;
}

function tryWeekOf(q, now) {
  // "week of <date>" — date may be numeric (5/31/2026 / 2026-05-31) or named
  // ("June 7 2026" / "June 7, 2026"). Prefer 4-digit year first so 2026 isn't
  // truncated to "20".
  const re = /\bweek\s+of\s+((?:\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))|(?:\d{4}-\d{2}-\d{2})|(?:(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}))/i;
  const m = q.match(re);
  if (!m) return null;
  const d = _parseAnyDate(m[1], now);
  if (!d) return null;
  const start = new Date(d.sinceIso);
  const end = addDays(start, 7);
  return {
    mode: 'window',
    sinceIso: start.toISOString(),
    untilIso: end.toISOString(),
    label: `week of ${d.label}`,
    grain: 'week',
    days: 7,
  };
}

function tryWeekBeforeLast(q, now) {
  if (!/\bweek\s+before\s+last\b/.test(q)) return null;
  const thisWk = startOfWeekLocal(now);
  const s = addDays(thisWk, -14);
  const e = addDays(s, 7);
  return { mode: 'window', sinceIso: toIsoUtc(s), untilIso: toIsoUtc(e), label: 'week before last', grain: 'week', days: 7 };
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

// ---- Exact single calendar dates ----------------------------------------
// Supported forms:
//   1/25/2026   01/25/2026   1/25/26          (M/D/Y, US convention)
//   2026-01-25                                (ISO)
//   Jan 25 2026   January 25, 2026            (named-month)
//
// All become mode='exact_date' with sinceIso=start-of-day and
// untilIso=start-of-next-day. label is a human-friendly form.
// Returns { error: 'invalid_date', label } when the literal is malformed
// (e.g. month > 12) so the engine can surface a clean help message.
const MONTH_NAMES_FULL = MONTHS;
const MONTH_NAMES_SHORT = MONTHS.map((m) => m.slice(0, 3));

function buildExactDate(year, monthIdx, day, originalLabel) {
  // Validate: monthIdx 0..11, day 1..31, plus actual day-validity per month.
  if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || !Number.isFinite(day)) {
    return { error: 'invalid_date', mode: 'all_time', label: `invalid date "${originalLabel}"` };
  }
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) {
    return { error: 'invalid_date', mode: 'all_time', label: `invalid date "${originalLabel}"` };
  }
  const start = new Date(Date.UTC(year, monthIdx, day));
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== monthIdx ||
    start.getUTCDate() !== day
  ) {
    return { error: 'invalid_date', mode: 'all_time', label: `invalid date "${originalLabel}"` };
  }
  const end = addDays(start, 1);
  const fmt = `${MONTH_NAMES_SHORT[monthIdx][0].toUpperCase() + MONTH_NAMES_SHORT[monthIdx].slice(1)} ${day}, ${year}`;
  return {
    mode: 'exact_date',
    sinceIso: start.toISOString(),
    untilIso: end.toISOString(),
    label: fmt,
    grain: 'day',
    days: 1,
  };
}

function tryExactDateNumeric(q) {
  // "on 1/25/2026", "on 01/25/2026", "on 1/25/26"
  // Also bare "1/25/2026" anywhere in the question (rarer but supported).
  const m = q.match(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return buildExactDate(year, month - 1, day, m[0]);
}

function tryExactDateIso(q) {
  // "on 2026-01-25" or bare "2026-01-25". This intentionally does NOT
  // collide with "between A and B" because that handler runs earlier.
  const m = q.match(/\b(?:on\s+)?(\d{4})-(\d{2})-(\d{2})\b/);
  if (!m) return null;
  return buildExactDate(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), m[0]);
}

function tryExactDateNamed(q) {
  // "Jan 25 2026", "January 25, 2026", "on Jan 25 2026"
  const re = new RegExp(
    `\\b(?:on\\s+)?(${[...MONTH_NAMES_FULL, ...MONTH_NAMES_SHORT].join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
    'i'
  );
  const m = q.match(re);
  if (!m) return null;
  const monthLower = m[1].toLowerCase();
  let monthIdx = MONTH_NAMES_FULL.indexOf(monthLower);
  if (monthIdx === -1) monthIdx = MONTH_NAMES_SHORT.indexOf(monthLower);
  return buildExactDate(parseInt(m[3], 10), monthIdx, parseInt(m[2], 10), m[0]);
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
  tryAllTime,             // very explicit "all time" / "lifetime"
  tryBetween, trySince, tryBefore,
  // Anchored week ("week of 5/31/2026") wins over plain exact-date so the
  // date literal is interpreted as a 7-day window, not a single day.
  tryWeekOf,
  tryWeekBeforeLast,
  // Exact-date literals must run BEFORE the rolling / named-month handlers
  // so "1/25/2026" wins over a generic "yesterday" or "in May".
  tryExactDateNumeric, tryExactDateIso, tryExactDateNamed,
  tryRollingDays, tryRollingMonths, tryRollingWeeks,
  tryToday, tryYesterday,
  tryThisWeek, tryLastWeek,
  tryThisMonth, tryLastMonth,
  tryThisQuarter, tryLastQuarter,
  tryYearToDate, tryLastYear,
  tryQuarterNumber, tryNamedMonth,
  tryOnDayOfWeek, tryWeekend,
];

// ---------------------------------------------------------------------------
// Comparison-pair parsing: "week of A vs week of B", "<period> vs <period>",
// "compare X to Y". Returns { timeframeA, timeframeB } when both anchors are
// detected, otherwise null. Used by intentParser to power explicit
// period-over-period comparisons with non-symmetric custom windows.
// ---------------------------------------------------------------------------
function parsePair(questionRaw, opts = {}) {
  const now = opts.now || new Date();
  const q = String(questionRaw || '').toLowerCase();

  // 1) "compare <left> to <right>"  /  "<left> vs <right>"  /  "<left> versus <right>"
  //    "compare <left> with <right>" — left side may follow "compare ", right side may follow "to|vs|with|versus|against".
  const splitRe = /\s+(?:to|vs|versus|with|against)\s+/i;
  // Drop leading "compare ", "how did ", "was ", etc.
  const stripped = q.replace(/^(?:compare\s+|how\s+(?:did|do)\s+|was\s+|did\s+|were\s+|how\s+were\s+|how\s+much\s+)/i, '').trim();
  const halves = stripped.split(splitRe);
  if (halves.length !== 2) return null;
  const [leftRaw, rightRaw] = halves.map((s) => s.trim().replace(/[?.!,;:]+$/g, ''));
  const tfA = parse(leftRaw, { now });
  const tfB = parse(rightRaw, { now });
  // Both halves must resolve to concrete windows (not all_time).
  if (!tfA || tfA.mode === 'all_time' || !tfB || tfB.mode === 'all_time') return null;
  return { timeframeA: tfA, timeframeB: tfB };
}

// Time-series grain detector. Returns one of 'day' | 'week' | 'month' | null.
function detectSeriesGrain(qLower) {
  if (/\b(?:each|by|per)\s+day\b|\bdaily\b/.test(qLower)) return 'day';
  if (/\b(?:each|by|per)\s+week\b|\bweekly\b/.test(qLower)) return 'week';
  if (/\b(?:each|by|per)\s+month\b|\bmonthly\b/.test(qLower)) return 'month';
  return null;
}

/**
 * Parse a question and return its temporal window. If no temporal phrase is
 * detected, returns { mode:'all_time', label:'all time' } so the caller can
 * decide whether to apply a sensible default.
 *
 * Tests can pin "now" by passing { now: Date }.
 */
function parse(questionRaw, { now = new Date() } = {}) {
  const q = String(questionRaw || '').toLowerCase();
  let result = null;
  for (const fn of HANDLERS) {
    const r = fn(q, now);
    if (r) { result = r; break; }
  }
  if (!result) result = { mode: 'all_time', label: 'all time' };
  // Tag time-series grain on top of whatever window was matched.
  const seriesGrain = detectSeriesGrain(q);
  if (seriesGrain) result.seriesGrain = seriesGrain;
  return result;
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

module.exports = { parse, withDefault, detectSeriesGrain, parsePair };
