// =============================================================================
// Calendar-date helpers for server strings (seasons, and anywhere else the
// source of truth is a YYYY-MM-DD whole-day value, not a real timestamp).
//
// Season start/end dates come off the server as ISO strings that typically
// land at UTC midnight (e.g. "2026-04-01T00:00:00Z"). Feeding those into
// `new Date()` and rendering with `toLocaleDateString` shifts the visible day
// by the viewer's UTC offset — a PDT viewer sees "2026-03-31".
//
// These helpers slice the YYYY-MM-DD prefix and build a Date at noon in the
// *viewer's* local timezone, so the displayed day-of-month is stable across
// timezones. Do NOT use them for task open/close dates or any other field
// whose time-of-day is meaningful — those are real datetimes and render
// correctly via `new Date(iso).toLocaleDateString()`.
// =============================================================================

function ymdPart(raw: string): string | null {
  const ymd = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null;
}

/**
 * Build a Date for local noon of the given YYYY-MM-DD. Validates round-trip
 * to reject impossible inputs like "2026-02-31".
 */
function localNoonFromYmd(ymd: string): Date {
  const [yearPart, monthPart, dayPart] = ymd.split('-');
  const year = Number.parseInt(yearPart, 10);
  const monthIndex = Number.parseInt(monthPart, 10) - 1;
  const day = Number.parseInt(dayPart, 10);
  const d = new Date(year, monthIndex, day, 12, 0, 0);
  if (Number.isNaN(d.getTime()) || d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) {
    return new Date(Number.NaN);
  }
  return d;
}

/** Render YYYY-MM-DD as the viewer's localized calendar date. */
export function formatCalendarDate(raw: string | null | undefined, locale?: string): string {
  if (!raw) return '';
  const ymd = ymdPart(raw);
  if (!ymd) return raw;
  const d = localNoonFromYmd(ymd);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(locale);
}

/** Year portion of a calendar-date string, regardless of viewer timezone. */
export function getCalendarYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ymd = ymdPart(raw);
  if (!ymd) return null;
  return Number.parseInt(ymd.slice(0, 4), 10);
}
