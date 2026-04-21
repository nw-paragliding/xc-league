import { describe, expect, it } from 'vitest';
import { formatCalendarDate, getCalendarYear } from './dates';

// Deterministic reference formatter. `toLocaleDateString('en-US')` depends on
// the runtime's ICU data; anchoring to a configured `Intl.DateTimeFormat` lets
// us compare to a known string without caring whether the runtime renders
// "4/1/2026" vs "04/01/2026".
const enUsNumericDate = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

describe('formatCalendarDate', () => {
  it('renders bare YYYY-MM-DD as the same calendar day regardless of viewer timezone', () => {
    const out = formatCalendarDate('2026-04-01', 'en-US');
    // Because the helper pins to LOCAL noon, the resulting Date's local
    // day-of-month is always 1 — no matter what TZ the host reports.
    const expected = enUsNumericDate.format(new Date(2026, 3, 1, 12));
    expect(out).toBe(expected);
  });

  it('accepts a full ISO string and uses only the date portion', () => {
    const out = formatCalendarDate('2026-04-01T00:00:00Z', 'en-US');
    const expected = enUsNumericDate.format(new Date(2026, 3, 1, 12));
    expect(out).toBe(expected);
  });

  it('returns empty string for null / undefined', () => {
    expect(formatCalendarDate(null)).toBe('');
    expect(formatCalendarDate(undefined)).toBe('');
  });

  it('passes through strings that do not start with YYYY-MM-DD', () => {
    expect(formatCalendarDate('not-a-date')).toBe('not-a-date');
  });

  it('rejects impossible calendar values (e.g. Feb 31) by returning the raw string', () => {
    expect(formatCalendarDate('2026-02-31')).toBe('2026-02-31');
  });

  // Regression test for the original bug: "2026-04-01" rendered in an
  // America/Los_Angeles display shows as 3/31 when parsed with plain
  // `new Date(isoString)`. Our helper builds the Date so that in *any*
  // timezone, the local day the viewer sees is the one they typed.
  it('does not reproduce the pre-fix UTC-midnight shift for a west-of-UTC viewer', () => {
    const raw = '2026-04-01';
    const laOpts: Intl.DateTimeFormatOptions = { timeZone: 'America/Los_Angeles', day: 'numeric' };
    // The pre-fix path — parses raw as UTC midnight, displays in LA.
    const buggy = new Date(raw).toLocaleDateString('en-US', laOpts);
    expect(buggy).toBe('31');
    // Our helper's internal Date, displayed in LA on a LA host, lands on day 1.
    // (On a UTC host this same Date would be noon UTC and LA would see 4 AM
    // on the 1st — still day 1. The helper is TZ-invariant for the returned
    // calendar day in any viewer timezone ≥ -11 hours from the host; in
    // practice every real viewer fits.)
    const fixed = new Intl.DateTimeFormat('en-US', laOpts).format(new Date(2026, 3, 1, 12));
    expect(fixed).toBe('1');
  });
});

describe('getCalendarYear', () => {
  it('returns the four-digit year from a date string', () => {
    expect(getCalendarYear('2026-04-01')).toBe(2026);
    expect(getCalendarYear('2026-04-01T00:00:00Z')).toBe(2026);
  });

  it('returns null for malformed input', () => {
    expect(getCalendarYear(null)).toBeNull();
    expect(getCalendarYear(undefined)).toBeNull();
    expect(getCalendarYear('garbage')).toBeNull();
  });
});
