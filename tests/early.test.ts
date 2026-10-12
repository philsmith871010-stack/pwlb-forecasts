// Money that arrives before the forecast expected it: once it's in the statements, the forecast
// mustn't count it again on its due date.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { runForecast } from '../src/lib/forecast/engine';
import { fromSession, basisFromHistory, historyBefore, K_OP, K_ONEOFF, type CashHistory } from '../src/lib/history/cashHistory';
import type { ForecastBasis } from '../src/lib/analysis/aggregates';
import { isoFromDay, addMonths } from '../src/lib/dates';
import { findEarly, answerEarly, timingAt, heldAsOneOff, findLate, answerLate } from '../src/lib/forecast/early';
import { dayFromISO } from '../src/lib/dates';
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

  it('on Monitor, money that came early is timing until its due date passes', () => {
    const a = (key: string, day: string, due: string, amount: number, answer: 'early' | 'extra' = 'early'): Arrival =>
      ({ key, kind: 'series', categoryId: 'grants_general', signature: 'GRANT', day, due, amount, answer, at: '', by: '' });
    const arrivals = [
      a('k1', '2024-11-21', '2024-12-09', 3.4e6),
      a('k1', '2024-11-21', '2024-12-09', 3.4e6), // the same arrival confirmed on a duplicated forecast
      a('k2', '2024-11-25', '2024-12-02', -1e6),
      a('k3', '2024-11-22', '2024-12-15', 2e6, 'extra'), // not early: it was something else
      a('k4', '2024-09-20', '2024-10-07', 5e6), // due date already passed: evened out
    ];
    const from = dayFromISO('2024-10-01'), end = dayFromISO('2026-09-30');
    const t = timingAt(arrivals, from, dayFromISO('2024-11-30'), end);
    expect(t.items.map((x) => x.key)).toEqual(['k1', 'k2']);
    expect(t.total).toBeCloseTo(2.4e6, 0);
    // read before it arrived, or after its due date: no timing
    expect(timingAt(arrivals, from, dayFromISO('2024-11-20'), end).total).toBe(0);
    expect(timingAt(arrivals, from, dayFromISO('2024-12-31'), end).total).toBe(0);
    // due after the signed-off forecast ends: it never expected it, so not timing
    expect(timingAt(arrivals, from, dayFromISO('2024-11-30'), dayFromISO('2024-12-05')).total).toBeCloseTo(-1e6, 0);
    // arrived before the forecast started: not part of what it's judged on
    expect(timingAt(arrivals, dayFromISO('2024-11-22'), dayFromISO('2024-11-30'), end).items.map((x) => x.key)).toEqual(['k2']);
  });

  it('an early payment held as a one-off is counted once on Monitor', () => {
    const h = withEarly();
    const basis = basisFromHistory(h, catIds)!;
    const c = findEarly(basis, forecast(basis), { oneOffs: [] }, E - 6, E).find((x) => x.signature === grant.signature)!;
    const a = answerEarly(c, 'early', 'Test');
    // as built here it's everyday cash, not a one-off
    expect(heldAsOneOff(h, a)).toBe(0);
    // the same day held as a one-off instead
    const asOneOff: CashHistory = { ...h, cells: h.cells.map((cells) => { const out = [...cells]; for (let k = 0; k < out.length; k += 4) if (out[k] === E && h.cats[out[k + 1]] === a.categoryId && out[k + 2] === K_OP) out[k + 2] = K_ONEOFF; return out; }) };
    const held = heldAsOneOff(asOneOff, a);
    expect(Math.sign(held)).toBe(Math.sign(a.amount));
    expect(Math.abs(held)).toBeLessThanOrEqual(Math.abs(a.amount));
    expect(Math.abs(held)).toBeGreaterThan(0.5 * Math.abs(a.amount));
  });

  // ---- late: May's payment hasn't come
  const nextDue = grant.days[j + 2];
  const acct = hs.occ.find(([d]) => d === due)![2];
  /** the history to `to`, without the payment due on `due`, and (optionally) with it arriving on `on` */
  const withLate = (to: number, on?: number): CashHistory => {
    const h = historyBefore(full, to + 1);
    const pence = Math.round(grant.amounts[j + 1] * 100);
    const ci = h.cats.indexOf(hs.cat);
    const series = h.series.map((s) => (s.sig === hs.sig && s.cat === hs.cat ? { ...s, occ: [...s.occ.filter(([d]) => d !== due), ...(on ? [[on, pence, acct] as [number, number, number]] : [])] } : s));
    const cells = h.cells.map((c, i) => {
      if (i !== acct) return c;
      const out: number[] = [];
      for (let k = 0; k < c.length; k += 4) if (!(c[k] === due && c[k + 1] === ci && c[k + 2] === K_OP && Math.abs(c[k + 3] - pence) < 100)) out.push(c[k], c[k + 1], c[k + 2], c[k + 3]);
      if (on) out.push(on, ci, K_OP, pence);
      return out;
    });
    return { ...h, series, cells };
  };
  const forecastFrom = (basis: ForecastBasis, start: number, arrivals: Arrival[] = []) =>
    runForecast({ basis, categories: DEFAULT_CATEGORIES, settings: { ...settings, start: isoFromDay(start), end: isoFromDay(addMonths(start, 12) - 1) }, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0, arrivals });

  it('left alone, a late payment drops out of the forecast; confirmed late, it stays in', () => {
    const to = due + 10;
    const basis = basisFromHistory(withLate(to), catIds)!;
    const fc = forecastFrom(basis, to + 1);
    // the forecast has moved on to the next one: May's is gone
    expect(Math.abs(projected(fc).next! - nextDue)).toBeLessThanOrEqual(3);
    const c = findLate(basis, fc, { arrivals: [] }, to - 45, to).find((x) => x.signature === grant.signature)!;
    expect(c).toBeDefined();
    expect(Math.abs(c.due - due)).toBeLessThanOrEqual(3);
    const late = answerLate(c, 'late', to + 3, 'Test');
    const after = forecastFrom(basis, to + 1, [late]);
    expect(projected(after).next).toBe(to + 3);
    const total = (f: ReturnType<typeof runForecast>) => f.net.reduce((t, v) => t + v, 0);
    expect(total(after) - total(fc)).toBeCloseTo(projected(fc).level, -5);
    // not coming: left out, as before; either answer is asked once
    expect(total(forecastFrom(basis, to + 1, [answerLate(c, 'missed', to + 3, 'Test')]))).toBeCloseTo(total(fc), 0);
    expect(findLate(basis, after, { arrivals: [late] }, to - 45, to)).toHaveLength(0);
  });

  it('a late payment that comes in the next month doesn’t push that month’s payment out', () => {
    const on = nextDue - 3;
    const basis = basisFromHistory(withLate(on, on), catIds)!;
    // left alone, the next one forecast is a month after the late one: this month's is lost
    expect(projected(forecastFrom(basis, on + 1)).next! - nextDue).toBeGreaterThan(20);
    // confirmed late earlier: this month's is still expected
    const late: Arrival = { key: 'k', kind: 'series', categoryId: catIds[grant.catIdx], signature: grant.signature, day: isoFromDay(due + 12), due: isoFromDay(due), amount: Math.round(grant.amounts[j + 1]), answer: 'late', at: '', by: '' };
    expect(Math.abs(projected(forecastFrom(basis, on + 1, [late])).next! - nextDue)).toBeLessThanOrEqual(3);
  });

  it('on Monitor, a late payment is timing until it comes in', () => {
    const late: Arrival = { key: 'k', kind: 'series', categoryId: catIds[grant.catIdx], signature: grant.signature, day: isoFromDay(due + 12), due: isoFromDay(due), amount: 3.4e6, answer: 'late', at: '', by: '' };
    const end = due + 365;
    // not in by the month end read: actuals behind by it
    const notIn = withLate(due + 20);
    expect(timingAt([late], due - 30, due + 20, end, notIn).total).toBeCloseTo(-3.4e6, 0);
    // read before it was due: nothing
    expect(timingAt([late], due - 30, due - 1, end, notIn).total).toBe(0);
    // came in by then: evened out
    const came = withLate(due + 20, due + 15);
    expect(timingAt([late], due - 30, due + 20, end, came).total).toBe(0);
    // ...but if read before it came, still timing
    expect(timingAt([late], due - 30, due + 10, end, came).total).toBeCloseTo(-3.4e6, 0);
    // not coming isn't timing: it's a real difference
    expect(timingAt([{ ...late, answer: 'missed' }], due - 30, due + 20, end, notIn).total).toBe(0);
  });

  it('a payment most of a month late looks stopped, dropping all of it; confirming puts it all back', () => {
    // nearly two months since the last one came (the previous check only looked back a month and a half)
    const to = nextDue - 4;
    expect(to - grant.days[j]).toBeGreaterThan(1.5 * 30.44);
    const basis = basisFromHistory(withLate(to), catIds)!;
    const fc = forecastFrom(basis, to + 1);
    const c = findLate(basis, fc, { arrivals: [] }, to - 45, to).find((x) => x.signature === grant.signature)!;
    expect(c).toBeDefined();
    expect(Math.abs(c.due - due)).toBeLessThanOrEqual(3);
    const total = (f: ReturnType<typeof runForecast>) => f.net.reduce((t, v) => t + v, 0);
    // left alone, not just this one but every one after it is gone
    expect(projected(fc).projected).toBe(0);
    const after = forecastFrom(basis, to + 1, [answerLate(c, 'late', to + 2, 'Test')]);
    expect(projected(after).next).toBe(to + 2);
    expect(total(after) - total(fc)).toBeGreaterThan(10 * Math.abs(c.amount));
  });

});
