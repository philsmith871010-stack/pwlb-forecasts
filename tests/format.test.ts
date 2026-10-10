// Figures as people read them: tables in one unit, progress never rounded up to done.
import { describe, it, expect } from 'vitest';
import { money, pctDone } from '../src/lib/format';
import { historyDays, MIN_HISTORY_DAYS, type CashHistory } from '../src/lib/history/cashHistory';

describe('format', () => {
  it('keeps a table column in £m', () => {
    expect(money(-92_000, { unit: 'm' })).toBe('−£0.1m');
    expect(money(9_700_000, { unit: 'm', sign: true })).toBe('+£9.7m');
    expect(money(-20_000, { unit: 'm' })).toBe('£0.0m'); // rounds to nothing: no sign
    expect(money(-92_000)).toBe('−£92k');
  });
  it('never shows a share as done before it is', () => {
    expect(pctDone(0.99996)).toBe('99.9%');
    expect(pctDone(1)).toBe('100.0%');
  });
});

describe('minimum history', () => {
  const h = (from: number, to: number) => ({ accounts: [{ ranges: [[from, to]] }] } as unknown as CashHistory);
  it('counts the days held', () => {
    expect(historyDays(null)).toBe(0);
    expect(historyDays(h(100, 100))).toBe(1);
    expect(historyDays(h(100, 100 + MIN_HISTORY_DAYS - 1))).toBe(MIN_HISTORY_DAYS);
  });
});

describe('comparisons read at month ends', async () => {
  const { monthEndIndex } = await import('../src/lib/forecast/signoff');
  const { dayFromYMD } = await import('../src/lib/dates');
  const cutoff = dayFromYMD(2025, 10, 1);
  it('uses the latest month end inside the period', () => {
    expect(monthEndIndex({ cutoff, H: dayFromYMD(2026, 3, 30) - cutoff + 1 })).toBe(dayFromYMD(2026, 2, 28) - cutoff);
    expect(monthEndIndex({ cutoff, H: dayFromYMD(2026, 3, 31) - cutoff + 1 })).toBe(dayFromYMD(2026, 3, 31) - cutoff);
  });
  it('has none before the first month end', () => {
    expect(monthEndIndex({ cutoff, H: 20 })).toBeNull();
  });
});

describe('when a signed-off forecast can first be judged', async () => {
  const { firstFairMonthEnd } = await import('../src/lib/forecast/signoff');
  const { dayFromYMD } = await import('../src/lib/dates');
  it('is the first month end at least four weeks in', () => {
    expect(firstFairMonthEnd(dayFromYMD(2026, 3, 31))).toBe(dayFromYMD(2026, 4, 30));
    expect(firstFairMonthEnd(dayFromYMD(2025, 10, 1))).toBe(dayFromYMD(2025, 10, 31));
  });
});
