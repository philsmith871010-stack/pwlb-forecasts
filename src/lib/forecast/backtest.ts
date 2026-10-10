// Backtesting: forecast "as if it were" a past date using only data before it, then compare.
import type { Dataset } from '../ingest/ingest';
import type { CatResult } from '../categorise/engine';
import type { Category } from '../categories';
import type { ForecastSettings } from '../model';
import { buildBasisAsOf, Aggregates, ForecastBasis } from '../analysis/aggregates';
import { basisFromHistory, historyBefore, type CashHistory } from '../history/cashHistory';
import { runForecast } from './engine';
import { Day, isoFromDay, addMonths, monthIndex, MONTH_NAMES, monthFromIndex } from '../dates';

export interface BacktestOptions {
  cutoff: Day;
  horizonMonths: number;
  categories: Category[];
  settings: Pick<ForecastSettings, 'lookbackYears' | 'recencyWeight' | 'methodByCategory'>;
  includeActualOneOffs: boolean;
  fyStartMonth: number;
}

export interface BacktestResult {
  cutoff: Day;
  end: Day;
  H: number;
  /** cumulative change in operational position from the cut-off (both start at 0) */
  forecastCum: number[];
  actualCum: number[];
  actualCoreCum: number[];
  lowerCum: number[];
  upperCum: number[];
  errorAt: { months: number; error: number; coreError: number; actualAbsFlow: number }[];
  lowForecast: { day: Day; amount: number };
  lowActual: { day: Day; amount: number };
  categories: { id: string; name: string; forecast: number; actual: number; actualCore: number; error: number; mape: number | null; excluded?: boolean }[];
  monthly: { labels: string[]; forecastNet: number[]; actualNet: number[]; actualOneOff: number[] };
  surpriseOneOffs: number;
  usedDataTo: Day;
  ms: number;
}

export function runBacktest(ds: Dataset, res: CatResult, full: Aggregates, o: BacktestOptions): BacktestResult {
  return backtestFromBasis(buildBasisAsOf(ds, res, o.cutoff), full, o);
}

/**
 * The same test from the saved cash history alone (no bank lines needed): the history before the
 * cut-off is what the forecast learns from; the history after it is what actually happened.
 */
export function backtestFromHistory(h: CashHistory, o: BacktestOptions): BacktestResult | null {
  const catIds = o.categories.map((c) => c.id);
  const full = basisFromHistory(h, catIds);
  const before = basisFromHistory(historyBefore(h, o.cutoff), catIds);
  if (!full || !before) return null;
  return backtestFromBasis(before, full.agg, o);
}

/** Forecast from `basis` (data up to the cut-off) and compare with `full` (what happened). */
export function backtestFromBasis(basis: ForecastBasis, full: Aggregates, o: BacktestOptions): BacktestResult {
  const t0 = performance.now();
  const end = Math.min(addMonths(o.cutoff, o.horizonMonths) - 1, full.startDay + full.D - 1);
  const fc = runForecast({
    basis,
    categories: o.categories,
    settings: {
      start: isoFromDay(o.cutoff), end: isoFromDay(end), granularity: 'monthly', openingPosition: 0,
      lookbackYears: o.settings.lookbackYears, recencyWeight: o.settings.recencyWeight, methodByCategory: o.settings.methodByCategory,
      includePossible: false, bandZ: 1.645,
    },
    assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [],
    fyStartMonth: o.fyStartMonth, liquidityBuffer: 0, defaultOpening: 0,
  });
  const H = fc.H;
  const C = full.catIds.length;
  const off = o.cutoff - full.startDay;
  const actualNet = new Float64Array(H), actualCore = new Float64Array(H), actualOO = new Float64Array(H);
  // Like-for-like: categories the forecast deliberately excludes are left out of the actuals too
  const modelled = new Set(fc.explain.filter((e) => e.method !== 'exclude').map((e) => e.catIdx));
  for (let c = 0; c <= C; c++) {
    if (!modelled.has(c)) continue;
    for (let d = 0; d < H; d++) {
      const k = c * full.D + off + d;
      actualCore[d] += full.op[k];
      actualOO[d] += full.opOneOff[k];
    }
  }
  for (let d = 0; d < H; d++) actualNet[d] = actualCore[d] + actualOO[d];
  const forecastNet = Float64Array.from(fc.net);
  if (o.includeActualOneOffs) for (let d = 0; d < H; d++) forecastNet[d] += actualOO[d];
  const cum = (a: Float64Array) => { const out: number[] = []; let s = 0; for (let d = 0; d < H; d++) { s += a[d]; out.push(s); } return out; };
  const forecastCum = cum(forecastNet), actualCum = cum(actualNet), actualCoreCum = cum(actualCore);
  const lowerCum = Array.from(fc.lower), upperCum = Array.from(fc.upper);
  if (o.includeActualOneOffs) { const ooc = cum(actualOO); for (let d = 0; d < H; d++) { lowerCum[d] += ooc[d]; upperCum[d] += ooc[d]; } }

  const errorAt = [3, 6, 12, 24].filter((mo) => mo <= o.horizonMonths).map((months) => {
    const d = Math.min(H - 1, addMonths(o.cutoff, months) - o.cutoff - 1);
    let gross = 0;
    for (let k = 0; k <= d; k++) gross += Math.abs(actualNet[k]);
    return { months, error: forecastCum[d] - actualCum[d], coreError: forecastCum[d] - actualCoreCum[d], actualAbsFlow: gross };
  });
  const argmin = (a: number[]) => a.reduce((b, v, i) => (v < a[b] ? i : b), 0);
  const lf = argmin(forecastCum), la = argmin(actualCum);

  // per-category totals and monthly MAPE
  const m0 = monthIndex(o.cutoff), m1 = monthIndex(o.cutoff + H - 1);
  const nm = m1 - m0 + 1;
  const categories: BacktestResult['categories'] = [];
  const nameOf = (id: string) => o.categories.find((c) => c.id === id)?.name ?? (id === 'uncategorised' ? 'Uncategorised' : id);
  const fcIds = fc.catIds;
  for (let c = 0; c <= C; c++) {
    const id = c === C ? 'uncategorised' : full.catIds[c];
    const fci = fcIds.indexOf(id);
    const fm = new Array(nm).fill(0), am = new Array(nm).fill(0);
    let f = 0, a = 0, ac = 0;
    for (let d = 0; d < H; d++) {
      const mi = monthIndex(o.cutoff + d) - m0;
      const fv = fci >= 0 ? fc.daily[fci * H + d] : 0;
      const k = c * full.D + off + d;
      const av = full.op[k] + full.opOneOff[k];
      fm[mi] += fv; am[mi] += av; f += fv; a += av; ac += full.op[k];
    }
    if (!f && !a) continue;
    if (!modelled.has(c)) { categories.push({ id, name: nameOf(id), forecast: 0, actual: a, actualCore: ac, error: 0, mape: null, excluded: true }); continue; }
    let ape = 0, cnt = 0;
    for (let k = 0; k < nm; k++) if (Math.abs(am[k]) > 1000) { ape += Math.abs((fm[k] - am[k]) / am[k]); cnt++; }
    categories.push({ id, name: nameOf(id), forecast: f, actual: a, actualCore: ac, error: f - a, mape: cnt ? ape / cnt : null });
  }
  categories.sort((x, y) => Math.abs(y.error) - Math.abs(x.error));

  const labels: string[] = [], fN: number[] = [], aN: number[] = [], aO: number[] = [];
  for (let k = 0; k < nm; k++) { const { y, m } = monthFromIndex(m0 + k); labels.push(`${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`); fN.push(0); aN.push(0); aO.push(0); }
  for (let d = 0; d < H; d++) { const k = monthIndex(o.cutoff + d) - m0; fN[k] += forecastNet[d]; aN[k] += actualNet[d]; aO[k] += actualOO[d]; }

  return {
    cutoff: o.cutoff, end, H, forecastCum, actualCum, actualCoreCum, lowerCum, upperCum, errorAt,
    lowForecast: { day: o.cutoff + lf, amount: forecastCum[lf] }, lowActual: { day: o.cutoff + la, amount: actualCum[la] },
    categories, monthly: { labels, forecastNet: fN, actualNet: aN, actualOneOff: aO },
    surpriseOneOffs: actualOO.reduce((s, x) => s + x, 0), usedDataTo: basis.dataEnd, ms: performance.now() - t0,
  };
}

export interface RollingResult {
  cutoffs: Day[];
  horizonMonths: number;
  /** mean absolute cumulative error by months ahead (1…H) */
  maeByMonth: number[];
  coreMaeByMonth: number[];
  /** average monthly gross operational flow, for scale */
  avgMonthlyGross: number;
  perRun: { cutoff: Day; errorAt12: number | null; lowErr: number }[];
}

export function runRolling(ds: Dataset, res: CatResult, full: Aggregates, base: Omit<BacktestOptions, 'cutoff'>, onProgress?: (k: number, n: number) => void): RollingResult {
  const first = addMonths(full.startDay, 12);
  const last = addMonths(full.startDay + full.D, -base.horizonMonths);
  const cutoffs: Day[] = [];
  const span = monthIndex(last) - monthIndex(first);
  const step = Math.max(1, Math.ceil(span / 16));
  for (let d = first; d <= last; d = addMonths(d, step)) {
    const { y, m } = monthFromIndex(monthIndex(d));
    cutoffs.push(Date.UTC(y, m - 1, 1) / 86400000);
  }
  const sums = new Array(base.horizonMonths).fill(0), coreSums = new Array(base.horizonMonths).fill(0), counts = new Array(base.horizonMonths).fill(0);
  const perRun: RollingResult['perRun'] = [];
  let gross = 0, grossN = 0;
  cutoffs.forEach((cutoff, k) => {
    onProgress?.(k, cutoffs.length);
    const r = runBacktest(ds, res, full, { ...base, cutoff });
    for (let mo = 1; mo <= base.horizonMonths; mo++) {
      const d = addMonths(cutoff, mo) - cutoff - 1;
      if (d >= r.H) break;
      sums[mo - 1] += Math.abs(r.forecastCum[d] - r.actualCum[d]);
      coreSums[mo - 1] += Math.abs(r.forecastCum[d] - r.actualCoreCum[d]);
      counts[mo - 1]++;
    }
    for (const v of r.monthly.actualNet) { gross += Math.abs(v); grossN++; }
    const e12 = r.errorAt.find((e) => e.months === 12);
    perRun.push({ cutoff, errorAt12: e12 ? e12.error : null, lowErr: r.lowForecast.amount - r.lowActual.amount });
  });
  return {
    cutoffs, horizonMonths: base.horizonMonths,
    maeByMonth: sums.map((s, i) => (counts[i] ? s / counts[i] : 0)),
    coreMaeByMonth: coreSums.map((s, i) => (counts[i] ? s / counts[i] : 0)),
    avgMonthlyGross: grossN ? gross / grossN : 0, perRun,
  };
}
