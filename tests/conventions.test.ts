// Payment conventions: learned from a payment's past dates, then used for its future ones, with
// weekends and bank holidays where real councils' payments fall.
import { describe, it, expect } from 'vitest';
import { dateFor, detectConvention, conventionWords, parseConvention, conventionToken, type Convention } from '../src/lib/forecast/conventions';
import { dayFromYMD, isoFromDay, isBusinessDay } from '../src/lib/dates';
import { projectDates } from '../src/lib/forecast/engine';

/** the dates a convention gives each month for `months` months from (y, m) */
const datesOf = (c: Convention, y: number, m: number, months: number) => {
  const out: number[] = [];
  for (let k = 0; k < months; k++) { const mi = y * 12 + m - 1 + k; const d = dateFor(c, Math.floor(mi / 12), (mi % 12) + 1); if (d !== null) out.push(d); }
  return out;
};
const iso = (d: number | null) => (d === null ? null : isoFromDay(d));

describe('payment conventions', () => {
  it('gives the right day, weekends and bank holidays included', () => {
    // 15 Jun 2024 was a Saturday
    expect(iso(dateFor({ kind: 'dom', day: 15, roll: 'next' }, 2024, 6))).toBe('2024-06-17');
    expect(iso(dateFor({ kind: 'dom', day: 15, roll: 'prev' }, 2024, 6))).toBe('2024-06-14');
    // 1 Jan is a bank holiday: the next working day
    expect(iso(dateFor({ kind: 'dom', day: 1, roll: 'next' }, 2025, 1))).toBe('2025-01-02');
    // second Tuesday of October 2025; last Friday of February 2025
    expect(iso(dateFor({ kind: 'weekday', n: 2, weekday: 2 }, 2025, 10))).toBe('2025-10-14');
    expect(iso(dateFor({ kind: 'weekday', n: -1, weekday: 5 }, 2025, 2))).toBe('2025-02-28');
    // third working day of September 2025 (Mon 1st) and of December 2025
    expect(iso(dateFor({ kind: 'working', n: 3 }, 2025, 9))).toBe('2025-09-03');
    // last working day of March 2024: Good Friday the 29th, so Thursday 28th
    expect(iso(dateFor({ kind: 'working', n: -1 }, 2024, 3))).toBe('2024-03-28');
    // no fifth Tuesday in February 2025
    expect(dateFor({ kind: 'weekday', n: 5, weekday: 2 }, 2025, 2)).toBeNull();
  });

  const cases: [Convention, number][] = [
    [{ kind: 'dom', day: 15, roll: 'next' }, 1],
    [{ kind: 'dom', day: 15, roll: 'prev' }, 1],
    [{ kind: 'dom', day: 1, roll: 'next' }, 1],
    [{ kind: 'dom', day: 28, roll: 'prev' }, -1],
    [{ kind: 'weekday', n: 2, weekday: 2 }, -1],
    [{ kind: 'weekday', n: -1, weekday: 5 }, -1],
    [{ kind: 'working', n: 3 }, 1],
    [{ kind: 'working', n: -1 }, -1],
    [{ kind: 'working', n: -2 }, 1],
  ];
  for (const [truth, sign] of cases) {
    it(`learns “${conventionWords(truth)}” from a year of dates and books the next year exactly`, () => {
      const past = datesOf(truth, 2024, 1, 12);
      const found = detectConvention(past, sign);
      expect(found).not.toBeNull();
      const future = datesOf(truth, 2025, 1, 12);
      expect(datesOf(found!.convention, 2025, 1, 12).map(iso)).toEqual(future.map(iso));
    });
  }

  it('the old rule got these wrong: a second Tuesday is not a day of the month', () => {
    const truth: Convention = { kind: 'weekday', n: 2, weekday: 2 };
    const past = datesOf(truth, 2024, 1, 12);
    // the usual day of the month of a second Tuesday is right in at most a few months
    const dom = { kind: 'dom', day: new Date(past[0] * 864e5).getUTCDate(), roll: 'prev' } as Convention;
    const future = datesOf(truth, 2025, 1, 12);
    const right = datesOf(dom, 2025, 1, 12).filter((d, k) => d === future[k]).length;
    expect(right).toBeLessThan(6);
  });

  it('a payment that comes when it likes has no convention', () => {
    const scattered = [3, 11, 19, 6, 27, 14, 9, 22].map((d, k) => dayFromYMD(2024, k + 1, d)).filter(isBusinessDay);
    expect(detectConvention(scattered)).toBeNull();
  });

  it('a choice is stored as a token and read back', () => {
    for (const [c] of cases) expect(parseConvention(conventionToken(c))).toEqual(c);
    expect(parseConvention('dom:40:next')).toBeNull();
    expect(conventionWords({ kind: 'dom', day: 15, roll: 'next' })).toBe('on the 15th, or the next working day if that isn’t one');
    expect(conventionWords({ kind: 'weekday', n: 2, weekday: 2 })).toBe('on the second Tuesday');
  });

  it('the forecast books a regular payment on its convention’s days', () => {
    // schools' budget shares: paid out on the 1st, or the next working day (money out, but rolled forward)
    const truth: Convention = { kind: 'dom', day: 1, roll: 'next' };
    const days = Float64Array.from(datesOf(truth, 2024, 1, 12));
    const s = { cadence: 'monthly' as const, dayOfMonth: 1, lastWorkingDay: false, days: Int32Array.from(days), amounts: Float64Array.from(days, () => -250000) };
    const next = projectDates(s, days[days.length - 1], dayFromYMD(2025, 12, 31));
    expect(next.map(iso)).toEqual(datesOf(truth, 2025, 1, 12).map(iso));
    // the old rule (no convention) rolled money out back into the month before
    const old = projectDates({ ...s, convention: null }, days[days.length - 1], dayFromYMD(2025, 12, 31));
    expect(old.filter((d, k) => d !== next[k]).length).toBeGreaterThan(2);
  });
});
