// Compact daily × category aggregates. Everything downstream (history, forecast, backtest)
// works from these, never from raw transactions.

import type { Dataset } from '../ingest/ingest';
import { CatResult, DEAL_NO, Series, Cadence, detectSeries, detectOutliers } from '../categorise/engine';
import { Day } from '../dates';

export interface Aggregates {
  startDay: Day;
  /** number of days covered (startDay … startDay + D − 1) */
  D: number;
  /** category ids; index C (= catIds.length) is "uncategorised" */
  catIds: string[];
  /** operational, recurring (feeds the model): (C+1) × D */
  op: Float64Array;
  /** operational, one-off (history only): (C+1) × D */
  opOneOff: Float64Array;
  /** treasury / deal flows (confirmed or suspected): (C+1) × D */
  treasury: Float64Array;
  /** internal transfers (net, normally ~0): D */
  internal: Float64Array;
  /** opening balance of all accounts on startDay (from balance columns, else 0) */
  openingBalance: number;
  openingKnown: boolean;
  rowCounts: Int32Array;
}

export const aggIndex = (agg: Aggregates, c: number, d: number) => c * agg.D + d;

export function buildAggregates(ds: Dataset, res: Pick<CatResult, 'cat' | 'deal' | 'catIds'>, oneOff: Uint8Array, maxDay?: Day): Aggregates {
  const startDay = ds.minDay;
  const endDay = maxDay !== undefined ? Math.min(maxDay, ds.maxDay) : ds.maxDay;
  const D = Math.max(1, endDay - startDay + 1);
  const C = res.catIds.length;
  const internalIdx = res.catIds.indexOf('internal_transfer');
  const op = new Float64Array((C + 1) * D);
  const opOneOff = new Float64Array((C + 1) * D);
  const treasury = new Float64Array((C + 1) * D);
  const internal = new Float64Array(D);
  const rowCounts = new Int32Array(C + 1);
  for (let i = 0; i < ds.n; i++) {
    const day = ds.day[i];
    if (day > endDay) break;
    const d = day - startDay;
    const c = res.cat[i] >= 0 ? res.cat[i] : C;
    const a = ds.amount[i];
    rowCounts[c]++;
    if (c === internalIdx) { internal[d] += a; continue; }
    if (res.deal[i] !== DEAL_NO) treasury[c * D + d] += a;
    else if (oneOff[i]) opOneOff[c * D + d] += a;
    else op[c * D + d] += a;
  }
  return { startDay, D, catIds: res.catIds, op, opOneOff, treasury, internal, openingBalance: ds.openingBalance ?? 0, openingKnown: ds.openingBalance != null, rowCounts };
}

// ---------------------------------------------------------------- forecast basis

export interface SeriesBasis {
  id: number;
  catIdx: number;
  signature: string;
  cadence: Cadence;
  dayOfMonth: number;
  dayOfMonth2?: number;
  lastWorkingDay: boolean;
  regularity: number;
  amountCV: number;
  trendPct: number;
  typicalAmount: number;
  active: boolean;
  firstDay: Day;
  lastDay: Day;
  /** per-day totals of the recurring operational rows in this series */
  days: Int32Array;
  amounts: Float64Array;
}

export interface ForecastBasis {
  agg: Aggregates;
  series: SeriesBasis[];
  dataEnd: Day;
}

const PROJECTABLE: Cadence[] = ['weekly', 'fortnightly', 'semi_monthly', 'four_weekly', 'monthly', 'quarterly', 'half_yearly', 'annual'];

export function buildSeriesBasis(ds: Dataset, res: Pick<CatResult, 'cat' | 'deal'>, oneOff: Uint8Array, seriesList: Series[], seriesArr: Int32Array, maxDay: Day): SeriesBasis[] {
  const keep = seriesList.filter((s) => PROJECTABLE.includes(s.cadence) && s.recurring && s.classification !== 'one_off' && s.categoryIdx >= 0);
  const byId = new Map<number, Map<number, number>>();
  for (const s of keep) byId.set(s.id, new Map());
  for (let i = 0; i < ds.n; i++) {
    if (ds.day[i] > maxDay) break;
    const sid = seriesArr[i];
    if (sid < 0) continue;
    const m = byId.get(sid);
    if (!m) continue;
    const s = seriesList[sid];
    if (res.cat[i] !== s.categoryIdx || res.deal[i] !== DEAL_NO || oneOff[i]) continue;
    m.set(ds.day[i], (m.get(ds.day[i]) ?? 0) + ds.amount[i]);
  }
  const out: SeriesBasis[] = [];
  for (const s of keep) {
    const m = byId.get(s.id)!;
    if (m.size < 3) continue;
    const days = Int32Array.from([...m.keys()].sort((a, b) => a - b));
    const amounts = Float64Array.from(days, (d) => m.get(d)!);
    out.push({
      id: s.id, catIdx: s.categoryIdx, signature: s.signature, cadence: s.cadence, dayOfMonth: s.dayOfMonth, dayOfMonth2: s.dayOfMonth2, lastWorkingDay: s.lastWorkingDay,
      regularity: s.regularity, amountCV: s.amountCV, trendPct: s.trendPct, typicalAmount: s.typicalAmount, active: s.active,
      firstDay: s.firstDay, lastDay: s.lastDay, days, amounts,
    });
  }
  return out;
}

/** Full-history basis from the current categorisation. */
export function buildBasis(ds: Dataset, res: CatResult): ForecastBasis {
  const agg = buildAggregates(ds, res, res.oneOff);
  return { agg, series: buildSeriesBasis(ds, res, res.oneOff, res.seriesList, res.series, ds.maxDay), dataEnd: ds.maxDay };
}

/**
 * Basis built strictly from data before `cutoff`: series detection and outlier tests are re-run
 * on the truncated history so nothing after the cut-off leaks into the profile.
 */
export function buildBasisAsOf(ds: Dataset, res: CatResult, cutoff: Day): ForecastBasis {
  const maxDay = cutoff - 1;
  const internalIdx = res.catIds.indexOf('internal_transfer');
  const det = detectSeries(ds, { sig: res.sig, signatures: res.signatures, cat: res.cat, internalIdx }, maxDay);
  const out = detectOutliers(ds, { cat: res.cat, deal: res.deal, internalIdx, nCats: res.catIds.length, series: det.series }, maxDay);
  const oneOff = new Uint8Array(ds.n);
  for (let i = 0; i < ds.n; i++) {
    if (ds.day[i] > maxDay) break;
    oneOff[i] = res.classOverride[i] >= 0 ? res.classOverride[i] : res.oneOffRule[i] | out.outlier[i];
  }
  const agg = buildAggregates(ds, res, oneOff, maxDay);
  return { agg, series: buildSeriesBasis(ds, res, oneOff, det.seriesList, det.series, maxDay), dataEnd: maxDay };
}
