// The "options to discuss" arithmetic on hand-made forecast lines.
import { describe, it, expect } from 'vitest';
import { buildStrategy } from '../src/lib/forecast/strategy';
import type { ForecastResult } from '../src/lib/forecast/engine';

function fakeFc(cum: number[], buffer = 10, band = 0): ForecastResult {
  const H = cum.length;
  const c = Float64Array.from(cum);
  return {
    start: 20000, H, cumulative: c, lower: Float64Array.from(cum, (v) => v - band), upper: Float64Array.from(cum, (v) => v + band), buffer,
  } as unknown as ForecastResult;
}

describe('strategy', () => {
  it('splits a dip that recovers within a year into short-term borrowing', () => {
    // 730 days: dips to −20 around day 100, back to 50 by day 200, stays there
    const cum = Array.from({ length: 730 }, (_, d) => (d < 100 ? 50 - 0.7 * d : d < 200 ? -20 + 0.7 * (d - 100) : 50));
    const st = buildStrategy(fakeFc(cum), null);
    expect(st.shortfall).toBeCloseTo(30, 6);
    expect(st.lasting).toBe(0);
    expect(st.shortTerm).toBeCloseTo(30, 6);
  });

  it('treats a fall that never recovers as lasting', () => {
    const cum = Array.from({ length: 730 }, (_, d) => 20 - d * 0.1); // ends at −53
    const st = buildStrategy(fakeFc(cum), null);
    expect(st.shortfall).toBeCloseTo(10 + 52.9, 6);
    // it never recovers before the forecast ends, so all of it is lasting (and flagged as such)
    expect(st.lasting).toBeCloseTo(st.shortfall, 6);
    expect(st.lastingWindowShort).toBe(true);
    expect(st.lasting + st.shortTerm).toBeCloseTo(st.shortfall, 6);
  });

  it('builds a nested term-out ladder from the cautious line', () => {
    const cum = Array.from({ length: 900 }, (_, d) => (d < 400 ? 100 : 30));
    const st = buildStrategy(fakeFc(cum, 10, 5), null);
    const at = (m: number) => st.ladder.find((r) => r.months === m)!.amount;
    expect(at(1)).toBe(85);      // 100 − 5 − 10
    expect(at(12)).toBe(85);
    expect(at(24)).toBe(15);     // 30 − 5 − 10
    for (let k = 1; k < st.ladder.length; k++) expect(st.ladder[k].amount).toBeLessThanOrEqual(st.ladder[k - 1].amount);
  });

  it('caps lasting borrowing at the benchmark room and shapes maturities by it', () => {
    const cum = Array.from({ length: 730 }, (_, d) => 20 - d * 0.1);
    // room in £m: 40, then 30, then 30, then 10
    const rows = [40, 30, 30, 10].map((room, k) => ({ fy: `${2026 + k}/${27 + k}`, yearEnd: 2027 + k, lb: (room + 100) / 1e6, existingLoans: 100 / 1e6, need: room / 1e6, over: 0, cfr: 0, actual: false }));
    const st = buildStrategy(fakeFc(cum), { repayments: [], loboCalls: [], lb: rows, liquid: 0, debt: 0 });
    const b = st.benchmark!;
    expect(b.room).toBeCloseTo(40, 6);
    expect(b.lastingWithinRoom).toBeCloseTo(Math.min(st.lasting, 40), 6);
    expect(b.lastingAboveRoom).toBeCloseTo(Math.max(0, st.lasting - 40), 6);
    const total = b.tranches.reduce((s, t) => s + t.amount, 0);
    expect(total).toBeCloseTo(b.lastingWithinRoom, 6);
  });

  it('works the quarterly need profile as a running maximum', () => {
    const cum = Array.from({ length: 365 }, (_, d) => (d < 150 ? -d : -150 + (d - 150)));
    const st = buildStrategy(fakeFc(cum, 0), null);
    for (let k = 1; k < st.needBy.length; k++) expect(st.needBy[k].amount).toBeGreaterThanOrEqual(st.needBy[k - 1].amount);
    expect(st.needBy[st.needBy.length - 1].amount).toBe(150);
  });
});
