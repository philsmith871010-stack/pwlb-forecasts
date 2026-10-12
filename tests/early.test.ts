// Money that arrives before the forecast expected it: once it's in the statements, the forecast
// mustn't count it again on its due date.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { runForecast } from '../src/lib/forecast/engine';
import { fromSession, basisFromHistory, historyBefore, K_OP, type CashHistory } from '../src/lib/history/cashHistory';
import type { ForecastBasis } from '../src/lib/analysis/aggregates';
import { isoFromDay, addMonths } from '../src/lib/dates';
import { findEarly, answerEarly } from '../src/lib/forecast/early';
import type { OneOff } from '../src/lib/model';
import type { Arrival } from '../src/lib/forecast/early';

const cfg = { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };
const catIds = DEFAULT_CATEGORIES.map((c) => c.id);

describe('money that arrives early', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'early' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const full = fromSession(ds, categorise(ds, cfg));
  const fullBasis = basisFromHistory(full, catIds)!;

  // a large monthly receipt, paid on a steady day: the kind of grant that sometimes comes early
  const grant = fullBasis.series
    .filter((s) => s.cadence === 'monthly' && s.active && s.typicalAmount > 1e6 && s.regularity > 0.8 && s.days.length > 24)
    .sort((a, z) => z.typicalAmount - a.typicalAmount)[0];
  // a year before the data ends: one payment (X) is in, the next (due) is a month later
  const j = grant.days.findIndex((d) => d > fullBasis.dataEnd - 365);
  const X = grant.days[j], due = grant.days[j + 1];
  const E = X + 13; // next month's payment arrives 13 days after this one
  const hs = full.series.find((s) => s.sig === grant.signature && s.cat === catIds[grant.catIdx])!;

  /** the history to E, with next month's payment arriving early on E */
  const withEarly = (): CashHistory => {
    const h = historyBefore(full, E + 1);
    const acct = hs.occ.find(([d]) => d === due)![2];
    const pence = Math.round(grant.amounts[j + 1] * 100);
    const series = h.series.map((s) => (s.sig === hs.sig && s.cat === hs.cat ? { ...s, occ: [...s.occ, [E, pence, acct] as [number, number, number]] } : s));
    const cells = h.cells.map((c, i) => (i === acct ? [...c, E, h.cats.indexOf(hs.cat), K_OP, pence] : c));
    return { ...h, series, cells };
  };
  const settings = { start: isoFromDay(E + 1), end: isoFromDay(addMonths(E + 1, 12) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  const forecast = (basis: ForecastBasis, oneOffs: OneOff[] = [], arrivals: Arrival[] = []) =>
    runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs, pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0, arrivals });
  const projected = (fc: ReturnType<typeof forecast>) => fc.explain.find((e) => e.catIdx === grant.catIdx)!.series.find((s) => s.signature === grant.signature)!;

  it('left alone, the forecast counts an early payment twice', () => {
    const basis = basisFromHistory(withEarly(), catIds)!;
    const s = projected(forecast(basis));
    // the payment already in the statements is forecast again on its usual date
    expect(Math.abs(s.next! - due)).toBeLessThanOrEqual(3);
  });

  it('spots it, and once confirmed takes the due payment out of the forecast', () => {
    const basis = basisFromHistory(withEarly(), catIds)!;
    const fc = forecast(basis);
    const found = findEarly(basis, fc, { oneOffs: [] }, E - 6, E);
    const c = found.find((x) => x.signature === grant.signature)!;
    expect(c).toBeDefined();
    expect(c.day).toBe(E);
    expect(Math.abs(c.due - due)).toBeLessThanOrEqual(3);
    const a = answerEarly(c, 'early', 'Test');
    const after = forecast(basis, [], [a]);
    // the next one forecast is the month after
    expect(projected(after).next! - due).toBeGreaterThan(20);
    // the forecast is lower by about one payment over the year
    const total = (f: ReturnType<typeof forecast>) => f.net.reduce((t, v) => t + v, 0);
    expect(total(fc) - total(after)).toBeCloseTo(projected(fc).level, -5);
    // asked once: answered either way, it isn't raised again
    expect(findEarly(basis, after, { oneOffs: [], arrivals: [a] }, E - 6, E)).toHaveLength(0);
    expect(findEarly(basis, fc, { oneOffs: [], arrivals: [answerEarly(c, 'extra', 'Test')] }, E - 6, E)).toHaveLength(0);
  });

  it('a normal month raises nothing', () => {
    // the history to the day after X: the payment came on its usual day
    const basis = basisFromHistory(historyBefore(full, X + 1), catIds)!;
    const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings: { ...settings, start: isoFromDay(X + 1), end: isoFromDay(addMonths(X + 1, 12) - 1) }, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 });
    expect(findEarly(basis, fc, { oneOffs: [] }, X - 31, X).filter((x) => x.signature === grant.signature)).toHaveLength(0);
  });

  it('an item added by hand that has already arrived', () => {
    const basis = basisFromHistory(withEarly(), catIds)!;
    // the team expected the grant's next payment as a known item in a month's time
    const o: OneOff = { id: 'oo1', date: isoFromDay(E + 30), amount: Math.round(grant.amounts[j + 1]), categoryId: catIds[grant.catIdx], description: 'Grant top-up', confidence: 'firm' };
    const fc = forecast(basis, [o]);
    const c = findEarly(basis, fc, { oneOffs: [o] }, E - 6, E).find((x) => x.kind === 'oneoff')!;
    expect(c.oneOffId).toBe('oo1');
    expect(c.day).toBe(E);
    const after = forecast(basis, [o], [answerEarly(c, 'early', 'Test')]);
    const total = (f: ReturnType<typeof forecast>) => f.net.reduce((t, v) => t + v, 0);
    expect(total(fc) - total(after)).toBeCloseTo(o.amount, -3);
    // not raised for an item with no money like it
    expect(findEarly(basis, fc, { oneOffs: [{ ...o, amount: o.amount * 3 }] }, E - 6, E).filter((x) => x.kind === 'oneoff')).toHaveLength(0);
  });
});
