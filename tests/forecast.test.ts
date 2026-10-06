import { describe, it, expect } from 'vitest';
import { parsePaste, resolvePaste } from '../src/lib/forecast/paste';
import { projectDates } from '../src/lib/forecast/engine';
import { dayFromISO, isoFromDay } from '../src/lib/dates';

describe('paste from Excel', () => {
  const o = { spread: 'day_of_month' as const, dayOfMonth: 15, negate: false, fyStartMonth: 4 };
  it('reads dated rows with a header', () => {
    const p = parsePaste('Date\tAmount\n15/04/2027\t2,400,000\n15/07/2027\t£2,400,000');
    expect(p.kind).toBe('dates');
    expect(resolvePaste(p, o)).toEqual([{ date: '2027-04-15', amount: 2.4e6 }, { date: '2027-07-15', amount: 2.4e6 }]);
  });
  it('reads months and rolls to a business day', () => {
    const p = parsePaste('Aug-27\t1000\nSep 2027\t1000');
    expect(p.kind).toBe('months');
    const r = resolvePaste(p, o);
    expect(r[0].date).toBe('2027-08-16'); // 15 Aug 2027 is a Sunday → next business day
  });
  it('spreads a financial-year total evenly', () => {
    const p = parsePaste('2027/28\t12,000,000');
    expect(p.kind).toBe('years');
    const r = resolvePaste(p, o);
    expect(r).toHaveLength(12);
    expect(r.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(12e6);
    expect(r[0].date.startsWith('2027-04')).toBe(true);
    expect(r[11].date.startsWith('2028-03')).toBe(true);
  });
});

describe('series projection', () => {
  it('projects twice-monthly payments on both days', () => {
    const d = projectDates({ cadence: 'semi_monthly', dayOfMonth: 1, dayOfMonth2: 15, lastWorkingDay: false, amounts: Float64Array.of(5e6) }, dayFromISO('2026-03-16'), dayFromISO('2026-05-31')).map(isoFromDay);
    expect(d).toEqual(['2026-04-01', '2026-04-15', '2026-05-01', '2026-05-15']);
  });
  it('projects monthly last-working-day payroll', () => {
    const d = projectDates({ cadence: 'monthly', dayOfMonth: 28, lastWorkingDay: true, amounts: Float64Array.of(-1) }, dayFromISO('2026-03-31'), dayFromISO('2026-06-30')).map(isoFromDay);
    expect(d).toEqual(['2026-04-30', '2026-05-29', '2026-06-30']);
  });
});
