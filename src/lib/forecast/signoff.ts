// Signed-off forecasts: a forecast frozen exactly as it stood when someone signed it off, so it
// can be compared with what actually happens as new statements arrive.
//
// Each record is self-contained and never changes once made (immutable, keyed by `id`), so it can
// move as is into a shared database later: one row per sign-off, scoped to the council, with the
// figures as a JSON payload. Today the records live in the team file (`TeamFile.signedOff`).
import { runForecast, type ForecastResult } from './engine';
import type { BacktestResult } from './backtest';
import type { Scenario } from '../model';
import type { Category } from '../categories';
import { basisFromHistory, historySpan, type CashHistory } from '../history/cashHistory';
import { Day, dayFromISO, isoFromDay, monthIndex, monthFromIndex, ymdFromDay, isBusinessDay, MONTH_NAMES } from '../dates';

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

/**
 * A forecast starts the day after the latest statement. A saved forecast whose start the history
 * has since passed (new statements came in) moves forward to it, keeping its length: otherwise it
 * would forecast days that have already happened, from a balance taken after them.
 */
export function rollForward<S extends { start: string; end: string }>(settings: S, dataEnd: Day): S {
  const s0 = dayFromISO(settings.start), first = dataEnd + 1;
  if (s0 >= first) return settings;
  return { ...settings, start: isoFromDay(first), end: isoFromDay(Math.max(first, dayFromISO(settings.end) + first - s0)) };
}

/** Everyday cash, like for like with the actuals: change since the start, per day, with the likely range. */
export function everydayPath(fc: ForecastResult): SignedForecast['everyday'] {
  const H = fc.H;
  // the modelled categories only (no deal register)
  const modelled = fc.explain.filter((e) => e.method !== 'exclude');
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
  return { cum, lower, upper };
}

export function signForecast(fc: ForecastResult, sc: Scenario, meta: { id: string; signedAt: string; signedBy: string; note?: string; knownItems: string[] }): SignedForecast {
  const H = fc.H;
  const modelled = fc.explain.filter((e) => e.method !== 'exclude');
  const { cum, lower, upper } = everydayPath(fc);
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
  const lastFull = monthIndex(completeTo(end) + 1) - 1; // the month before the one the next day falls in
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

/**
 * The rest of a signed-off forecast's period seen from today: a fresh forecast of everyday cash
 * from the day after the latest statement to the signed-off end, made with `sc` from the whole
 * history. Change since that day, with its likely range. Null once the period is over.
 */
export function reforecastSigned(rec: SignedForecast, h: CashHistory, sc: Scenario, categories: Category[], buffer: number, fyStartMonth: number): (SignedForecast['everyday'] & { start: Day }) | null {
  const span = historySpan(h);
  const end = dayFromISO(rec.end);
  if (!span || span.to >= end || span.to < dayFromISO(rec.start)) return null;
  const basis = basisFromHistory(h, categories.map((c) => c.id));
  if (!basis) return null;
  const start = span.to + 1;
  // the opening doesn't move everyday cash's change, so any will do
  const fc = runForecast({
    basis, categories, settings: { ...sc.settings, start: isoFromDay(start), end: rec.end, openingPosition: null },
    assumptions: sc.assumptions, oneOffs: sc.oneOffs, pastedSchedules: sc.pastedSchedules, treasurySchedule: sc.treasurySchedule,
    fyStartMonth, liquidityBuffer: buffer, defaultOpening: 0, register: null, overrides: sc.overrides ?? [],
  });
  return { start, ...everydayPath(fc) };
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

/** Less than this many days of actuals is too early to judge a forecast. */
export const MIN_COMPARE_DAYS = 28;

/** The first month end at least MIN_COMPARE_DAYS after a forecast starts: when it can first be judged. */
export function firstFairMonthEnd(start: Day): Day {
  let d = start + MIN_COMPARE_DAYS - 1;
  while (ymdFromDay(d + 1).d !== 1) d++;
  return d;
}

/**
 * Where to read a comparison: the latest month end inside it, so a payday or a grant landing a day
 * earlier or later than forecast doesn't swing the figure. Null before the first month end.
 */
export function monthEndIndex(r: Pick<BacktestResult, 'cutoff' | 'H'>): number | null {
  // statements to the last working day complete a month that ends on a weekend or bank holiday
  if (r.H > 0 && ymdFromDay(completeTo(r.cutoff + r.H - 1) + 1).d === 1) return r.H - 1;
  for (let d = r.H - 2; d >= 0; d--) if (ymdFromDay(r.cutoff + d + 1).d === 1) return d;
  return null;
}

/**
 * How far statements to `end` really reach: to the month's last day when only weekends or bank
 * holidays (no bank activity) are left in it, so a month ending on a Saturday counts as complete
 * from Friday's statement.
 */
export function completeTo(end: Day): Day {
  let d = end + 1;
  while (ymdFromDay(d).d !== 1) { if (isBusinessDay(d)) return end; d++; }
  return d - 1;
}

export type Tracking =
  // `asOf` is the latest month end compared (or the latest day, `soFar`, before the first one)
  | { rec: SignedForecast; r: BacktestResult; gap: number; asOf: number; soFar: boolean }
  | { rec: SignedForecast; r: null };

/**
 * The sign-off to report on: the one the team chose (`chosen`), else the newest with a month or
 * more of actuals; read at the latest month end. Before it has a month of actuals, it's waiting.
 */
export function trackSignOffs(signed: SignedForecast[], history: CashHistory | null | undefined, categories: Category[], chosen?: string): Tracking | null {
  const list = [...signed].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  if (!list.length || !history) return null;
  const own = list.find((x) => x.id === chosen);
  const compared = (own ? [own] : list).map((rec) => ({ rec, r: compareSigned(rec, history, categories) }));
  const pick = compared.find((x) => x.r && x.r.H >= MIN_COMPARE_DAYS);
  if (!pick) return { rec: own ?? list[0], r: null };
  const r = pick.r!, me = monthEndIndex(r), d = me ?? r.H - 1;
  return { rec: pick.rec, r, gap: r.actualCum[d] - r.forecastCum[d], asOf: r.cutoff + d, soFar: me === null };
}
