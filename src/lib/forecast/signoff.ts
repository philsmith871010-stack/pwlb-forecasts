// Signed-off forecasts: a forecast frozen exactly as it stood when someone signed it off, so it
// can be compared with what actually happens as new statements arrive.
//
// Each record is self-contained and never changes once made (immutable, keyed by `id`), so it can
// move as is into a shared database later: one row per sign-off, scoped to the council, with the
// figures as a JSON payload. Today the records live in the team file (`TeamFile.signedOff`).
import type { ForecastResult } from './engine';
import type { BacktestResult } from './backtest';
import type { Scenario } from '../model';
import type { Category } from '../categories';
import { basisFromHistory, historySpan, type CashHistory } from '../history/cashHistory';
import { Day, dayFromISO, isoFromDay, monthIndex, monthFromIndex, ymdFromDay, MONTH_NAMES } from '../dates';

export interface SignedForecast {
  v: 1;
  /** unique and stable: the database key later */
  id: string;
  scenarioId: string;
  scenarioName: string;
  /** ISO timestamp */
  signedAt: string;
  signedBy: string;
  note?: string;
  /** first and last forecast day (ISO dates) */
  start: string;
  end: string;
  /** the headline when it was signed off */
  borrowingNeed: number;
  low: number;
  lowDay: string;
  buffer: number;
  opening: number;
  /** what people added by hand: the judgement in it */
  knownItems: string[];
  /** everyday cash: change since the start, one figure per day (whole pounds), with the likely range */
  everyday: { cum: number[]; lower: number[]; upper: number[] };
  /** each category forecast, one figure per calendar month from the start's month (whole pounds) */
  cats: { id: string; name: string; months: number[] }[];
}

export function signForecast(fc: ForecastResult, sc: Scenario, meta: { id: string; signedAt: string; signedBy: string; note?: string; knownItems: string[] }): SignedForecast {
  const H = fc.H;
  const modelled = fc.explain.filter((e) => e.method !== 'exclude');
  // everyday cash, like for like with the actuals: the modelled categories only (no deal register)
  const cum: number[] = [], lower: number[] = [], upper: number[] = [];
  let s = 0;
  for (let d = 0; d < H; d++) {
    for (const e of modelled) s += fc.daily[e.catIdx * H + d];
    // the likely range keeps its width around the everyday line
    const mid = fc.cumulative[d];
    cum.push(Math.round(s));
    lower.push(Math.round(s + fc.lower[d] - mid));
    upper.push(Math.round(s + fc.upper[d] - mid));
  }
  const m0 = monthIndex(fc.start), nm = monthIndex(fc.start + H - 1) - m0 + 1;
  const cats = modelled.map((e) => {
    const months = new Array(nm).fill(0);
    for (let d = 0; d < H; d++) months[monthIndex(fc.start + d) - m0] += fc.daily[e.catIdx * H + d];
    // kept even when forecast at nothing: what actually arrives in it still counts
    return { id: e.id, name: e.name, months: months.map(Math.round) };
  });
  return {
    v: 1, ...meta, scenarioId: sc.id, scenarioName: sc.name,
    start: isoFromDay(fc.start), end: isoFromDay(fc.start + H - 1),
    borrowingNeed: Math.round(fc.borrowingRequirement), low: Math.round(fc.low.amount), lowDay: isoFromDay(fc.low.day),
    buffer: fc.buffer, opening: Math.round(fc.opening),
    everyday: { cum, lower, upper }, cats,
  };
}

/**
 * A signed-off forecast against what has happened since, from the saved history. Null until
 * there's at least one day of actuals after it starts. Category figures cover complete months only.
 */
export function compareSigned(rec: SignedForecast, h: CashHistory, categories: Category[]): BacktestResult | null {
  const span = historySpan(h);
  const start = dayFromISO(rec.start);
  if (!span || span.to < start) return null;
  const full = basisFromHistory(h, categories.map((c) => c.id));
  if (!full) return null;
  const agg = full.agg, C = agg.catIds.length;
  const end = Math.min(dayFromISO(rec.end), span.to);
  const H = end - start + 1;
  const off = start - agg.startDay;
  const rowOf = (id: string) => (id === 'uncategorised' ? C : agg.catIds.indexOf(id));
  const rows = rec.cats.map((c) => rowOf(c.id)).filter((r) => r >= 0);
  const actualCum: number[] = [], actualCoreCum: number[] = [];
  let a = 0, core = 0, gross = 0;
  for (let d = 0; d < H; d++) {
    let day = 0;
    for (const r of rows) {
      const k = r * agg.D + off + d;
      if (off + d < 0 || off + d >= agg.D) continue;
      day += agg.op[k] + agg.opOneOff[k];
      core += agg.op[k];
    }
    a += day; gross += Math.abs(day);
    actualCum.push(a); actualCoreCum.push(core);
  }
  const forecastCum = rec.everyday.cum.slice(0, H), lowerCum = rec.everyday.lower.slice(0, H), upperCum = rec.everyday.upper.slice(0, H);
  const errorAt = [3, 6, 12, 24].map((months) => ({ months, d: Math.round((months * 365.25) / 12) - 1 })).filter((x) => x.d < H)
    .map(({ months, d }) => ({ months, error: forecastCum[d] - actualCum[d], coreError: forecastCum[d] - actualCoreCum[d], actualAbsFlow: gross }));

  // categories over the complete months so far
  const m0 = monthIndex(start);
  const lastFull = monthIndex(end + 1) - 1; // the month before the one `end + 1` falls in
  const nFull = Math.max(0, lastFull - m0 + 1);
  const cats: BacktestResult['categories'] = rec.cats.map((c) => {
    const r = rowOf(c.id);
    let f = 0, act = 0, actCore = 0;
    for (let k = 0; k < nFull; k++) f += c.months[k] ?? 0;
    if (r >= 0) for (let d = 0; d < H; d++) {
      if (monthIndex(start + d) - m0 >= nFull) break;
      const i = r * agg.D + off + d;
      act += agg.op[i] + agg.opOneOff[i]; actCore += agg.op[i];
    }
    return { id: c.id, name: c.name, forecast: f, actual: act, actualCore: actCore, error: f - act, mape: null };
  }).sort((x, y) => Math.abs(y.error) - Math.abs(x.error));

  const argmin = (xs: number[]) => xs.reduce((b, v, i) => (v < xs[b] ? i : b), 0);
  const lf = argmin(forecastCum), la = argmin(actualCum);
  const labels: string[] = [];
  for (let k = 0; k < nFull; k++) { const { y, m } = monthFromIndex(m0 + k); labels.push(`${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`); }
  return {
    cutoff: start, end, H, forecastCum, actualCum, actualCoreCum, lowerCum, upperCum, errorAt,
    lowForecast: { day: start + lf, amount: forecastCum[lf] }, lowActual: { day: start + la, amount: actualCum[la] },
    categories: cats, monthly: { labels, forecastNet: [], actualNet: [], actualOneOff: [] },
    surpriseOneOffs: actualCum[H - 1] - actualCoreCum[H - 1], usedDataTo: (start - 1) as Day, ms: 0,
  };
}

/** The complete months the category comparison covers, e.g. "Apr to Sep 2025". */
export function fullMonthsLabel(r: BacktestResult): string {
  const l = r.monthly.labels;
  return !l.length ? '' : l.length === 1 ? l[0] : `${l[0]} to ${l[l.length - 1]}`;
}

/** The items people added by hand, in a few words each, so a reviewer sees the judgement in it. */
export function knownItemsOf(sc: Scenario, categories: Category[]): string[] {
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  const when = (iso: string) => { const { y, m } = monthFromIndex(monthIndex(dayFromISO(iso))); return `${MONTH_NAMES[m - 1]} ${y}`; };
  const pounds = (x: number) => `${x < 0 ? '−' : '+'}£${(Math.abs(x) / 1e6).toFixed(1)}m`;
  const out: string[] = [];
  for (const o of sc.oneOffs) out.push(`${o.description || name(o.categoryId)}: ${pounds(o.amount)} in ${when(o.date)}${o.confidence !== 'firm' ? ` (${o.confidence})` : ''}`);
  for (const a of sc.assumptions) {
    if (a.kind === 'growth') out.push(`${name(a.categoryId)}: ${a.pct >= 0 ? '+' : ''}${a.pct}% a year`);
    else if (a.kind === 'step') out.push(`${name(a.categoryId)}: ${a.pct >= 0 ? '+' : ''}${a.pct}% from ${when(a.effective)}`);
    else if (a.kind === 'stop') out.push(`${a.signature ?? name(a.categoryId)} stops from ${when(a.from)}`);
    else if (a.kind === 'start') out.push(`New payment in ${name(a.categoryId)} from ${when(a.from)}`);
    else if (a.kind === 'inflation') out.push(`Inflation +${a.pct}% a year`);
  }
  for (const p of sc.pastedSchedules) out.push(`${p.name}: a schedule of ${p.entries.length} payments`);
  const ov = sc.overrides ?? [];
  if (ov.length) out.push(`${ov.length} figure${ov.length > 1 ? 's' : ''} typed or pasted into the grids`);
  return out;
}

/**
 * Where to read a comparison: the latest month end inside it, so a payday or a grant landing a day
 * earlier or later than forecast doesn't swing the figure. Null before the first month end.
 */
export function monthEndIndex(r: Pick<BacktestResult, 'cutoff' | 'H'>): number | null {
  for (let d = r.H - 1; d >= 0; d--) if (ymdFromDay(r.cutoff + d + 1).d === 1) return d;
  return null;
}
