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

describe('grid cells', async () => {
  const { parseCell } = await import('../src/ui/forecast/GridEditor');
  it('reads what people paste from Excel', () => {
    expect(parseCell('3,200,000')).toBe(3.2e6);
    expect(parseCell('£2.5m')).toBe(2.5e6);
    expect(parseCell('250k')).toBe(250000);
    expect(parseCell('(1,234)')).toBe(-1234);
    expect(parseCell('-1234.5')).toBe(-1234.5);
    expect(Object.is(parseCell('(0)'), 0)).toBe(true);
    expect(parseCell('')).toBeNull();
    expect(parseCell('n/a')).toBeNaN();
  });
});

describe('money format', async () => {
  const { money, setExactAmounts } = await import('../src/lib/format');
  it('rounds to £m / £k by default, and to the penny when asked', () => {
    expect(money(12_634_512.34)).toBe('£12.6m');
    expect(money(-25_400)).toBe('−£25k');
    setExactAmounts(true);
    expect(money(12_634_512.34)).toBe('£12,634,512.34');
    expect(money(25_400, { sign: true })).toBe('+£25,400.00');
    setExactAmounts(false);
  });
});

describe('a regular payment under a new name', async () => {
  const { basisFromHistory } = await import('../src/lib/history/cashHistory');
  const { runForecast } = await import('../src/lib/forecast/engine');
  const { DEFAULT_CATEGORIES } = await import('../src/lib/categories');
  const { dayFromYMD, addMonths } = await import('../src/lib/dates');
  const catIds = DEFAULT_CATEGORIES.map((c) => c.id);
  const ci = catIds.indexOf('grants_general');
  /** A quarterly £3.5m grant for three years; then, if `renamed`, the same grant under a new name. */
  const history = (renamed: boolean) => {
    const cells: number[] = [], occ: [number, number, number][] = [];
    const from = dayFromYMD(2022, 4, 10), end = dayFromYMD(2025, 3, 31);
    for (let k = 0; k < 12; k++) {
      const d = addMonths(from, 3 * k);
      if (d > end) break;
      const paidUnderOldName = d < dayFromYMD(2024, 8, 1);
      if (!paidUnderOldName && !renamed) continue;
      cells.push(d, ci, 0, 350_000_000);
      if (paidUnderOldName) occ.push([d, 350_000_000, 0]);
    }
    cells.push(end, ci, 0, 1); // the statement runs to the end of March
    return { v: 1 as const, updatedAt: '', cats: [...catIds, 'uncategorised'], accounts: [{ key: 'a', ranges: [[dayFromYMD(2022, 4, 1), end]] as [number, number][], opening: 0, openingDay: dayFromYMD(2022, 4, 1), closing: null, closingDay: null }], cells: [cells], series: [{ sig: 'DLUHC S# GRANT', cat: 'grants_general', dir: 1 as const, occ }] };
  };
  const grantsNextYear = (renamed: boolean) => {
    const basis = basisFromHistory(history(renamed), catIds)!;
    const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings: { start: '2025-04-01', end: '2026-03-31', granularity: 'monthly', openingPosition: 0, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: false, bandZ: 1.645 }, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 0, defaultOpening: 0 });
    return fc.explain.find((e) => e.id === 'grants_general')!;
  };
  it('keeps projecting it when the same amount carries on under the new name', () => {
    const e = grantsNextYear(true);
    expect(e.forecastTotal).toBeGreaterThan(12e6);
    expect(e.notes.some((n) => n.includes('carries on'))).toBe(true);
  });
  it('treats it as stopped when nothing replaces it', () => {
    expect(grantsNextYear(false).forecastTotal).toBeLessThan(1e6);
  });
});

describe('a payday that moves to the last working day', async () => {
  const { describeDays } = await import('../src/lib/categorise/engine');
  const { dayFromYMD, lastWorkingDayOfMonth } = await import('../src/lib/dates');
  it('follows the latest four paydays, whatever went before', () => {
    const days: number[] = [];
    for (let k = 0; k < 24; k++) { const y = 2023 + Math.floor((k + 3) / 12), m = ((k + 3) % 12) + 1; days.push(k < 20 ? dayFromYMD(y, m, 28) - (k % 3 === 0 ? 1 : 0) : lastWorkingDayOfMonth(y, m)); }
    expect(describeDays(days, days.map(() => 1e6), days[days.length - 1]).lwdShare).toBeGreaterThan(0.7);
    expect(describeDays(days.slice(0, 20), days.slice(0, 20).map(() => 1e6), days[19]).lwdShare).toBeLessThan(0.7);
  });
});
