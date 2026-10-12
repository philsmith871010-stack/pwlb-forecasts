// Forecast engine. Pure and fast (a few ms for 5 years × 30 categories) so the UI can
// recompute on every keystroke. Every number traces back to: historic data (profile, series),
// an assumption, a pasted schedule or a one-off the user entered.

import { type Arrival, DUE_MATCH_DAYS } from './early';
import type { Category, ForecastMethod } from '../categories';
import type { Assumption, ForecastSettings, OneOff, PastedSchedule, TreasuryItem, GrowthMode, GridOverride } from '../model';
import type { ForecastBasis, SeriesBasis } from '../analysis/aggregates';
import {
  Day, dayFromISO, ymdFromDay, dayFromYMD, daysInMonth, isBusinessDay, prevBusinessDay, nextBusinessDay,
  lastWorkingDayOfMonth, weekday, fyOf, fmtDay, MONTH_NAMES,
} from '../dates';

export interface ForecastRequest {
  basis: ForecastBasis;
  categories: Category[];
  settings: ForecastSettings;
  assumptions: Assumption[];
  oneOffs: OneOff[];
  pastedSchedules: PastedSchedule[];
  treasurySchedule: TreasuryItem[];
  fyStartMonth: number;
  liquidityBuffer: number;
  /** default opening position if settings.openingPosition is null */
  defaultOpening: number;
  /** the council's deal register: money available now (MMFs, call accounts) and its dated
   * loan and investment cash flows. When present the headline position includes both. */
  register?: { liquid: number; events: { day: Day; amount: number; label: string; kind: string }[] } | null;
  /** month-by-month figures from the grid: final, applied after everything else in the model */
  overrides?: GridOverride[];
  /** money that already arrived early: its due payment isn't forecast again */
  arrivals?: Arrival[];
}

/** One row of a category's month-by-month grid. */
export interface GridRow {
  key: string;
  label: string;
  kind: 'series' | 'pattern' | 'custom' | 'added' | 'schedule' | 'oneoff';
  editable: boolean;
  /** per month */
  values: number[];
  /** the month has a figure of the user's (a month total or any day) */
  overridden: boolean[];
  /** the month has figures typed for single days */
  byDay: boolean[];
  /** per day of the forecast (index 0 = start) */
  daily: Float64Array;
  dayOverridden: Uint8Array;
  /** a regular payment the user removed */
  removed?: boolean;
}
export interface CategoryGrid { months: string[]; start: Day; rows: GridRow[] }

export interface Clamp { year: number; month: number; value: number; clampedTo: number }

export interface CategoryExplain {
  catIdx: number;
  id: string;
  name: string;
  method: ForecastMethod;
  growthPct: number;
  growthMode: GrowthMode;
  growthSource: 'historic' | 'assumption' | 'none';
  historicCagr: number;
  inflationPct: number;
  /** base monthly level by calendar month (index 0 = Jan), at the data end date */
  profile: number[];
  clamps: Clamp[];
  sigmaMonthly: number;
  distribution: 'day_of_month' | 'weekday' | 'even' | 'series';
  series: { signature: string; cadence: string; level: number; next: Day | null; projected: number; active: boolean; dayOfMonth: number; lastWorkingDay: boolean; regularity: number; lastDay: Day; timing: 'history' | 'user' }[];
  notes: string[];
  forecastTotal: number;
  historyAnnual: number;
}

export interface Marker { day: Day; label: string; kind: 'assumption' | 'oneoff' | 'schedule' | 'treasury'; amount?: number }

export interface ForecastResult {
  start: Day;
  H: number;
  catIds: string[];
  /** (C+1) × H daily flows (modelled + assumptions + schedules + weighted one-offs) */
  daily: Float64Array;
  /** one-offs only, per day (already included in daily) */
  oneOffDaily: Float64Array;
  treasuryDaily: Float64Array;
  net: Float64Array;
  cumulative: Float64Array;
  cumulativeAfterTreasury: Float64Array;
  /** everyday cash only, before the deal register (equals cumulative when there is no register) */
  cumulativeBefore: Float64Array;
  /** deal register cash flows per day (included in cumulative) */
  registerDaily: Float64Array;
  register: { liquid: number; events: number; net: number } | null;
  /** month-by-month rows for each forecast category (by category id) */
  grid: Record<string, CategoryGrid>;
  lower: Float64Array;
  upper: Float64Array;
  opening: number;
  low: { day: Day; amount: number };
  high: { day: Day; amount: number };
  lowAfterTreasury: { day: Day; amount: number };
  breaches: { from: Day; to: Day; min: number }[];
  borrowingRequirement: number;
  buffer: number;
  explain: CategoryExplain[];
  markers: Marker[];
  summary: string;
  drivers: { id: string; name: string; amount: number }[];
  ms: number;
}

const DEFAULT_LOOKBACK_CAP = 0.2;

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const CADENCE_DAYS: Partial<Record<string, number>> = { monthly: 30.4, quarterly: 91.3, half_yearly: 182.6, annual: 365.25 };

/**
 * A stopped regular payment that carries on under another name: after its last payment, amounts
 * in its recent range keep arriving in the same category on the same rhythm, right
 * up to the end of the data. Only for monthly or less frequent payments, where such amounts stand
 * out. Returns the matching [day, amount] pairs, or null.
 */
function continuation(s: SeriesBasis, residual: Float64Array, startDay: Day, dataEnd: Day): [Day, number][] | null {
  const I = CADENCE_DAYS[s.cadence];
  if (!I || !s.amounts.length) return null;
  const last = s.days[s.days.length - 1];
  const expected = Math.floor((dataEnd - last) / I);
  if (expected < 1) return null;
  const recent = Array.from(s.amounts.slice(-6));
  const typical = median(recent);
  // as small as it has recently been, with some room: VAT repayments, say, vary month to month
  const floor = 0.6 * Math.min(...recent.map(Math.abs));
  const hits: [Day, number][] = [];
  let prev = last;
  for (let day = last + 1; day <= dataEnd; day++) {
    const v = residual[day - startDay];
    if (!v || Math.sign(v) !== Math.sign(typical) || Math.abs(v) < floor) continue;
    const gap = day - prev;
    if (gap < 0.65 * I) continue;
    if (gap > 1.35 * I) return null; // a missed payment: not a steady continuation
    // on a busy day it may have arrived with something else: take only its usual size
    hits.push([day, Math.abs(v) > 1.5 * Math.max(...recent.map(Math.abs)) ? typical : v]);
    prev = day;
  }
  return hits.length >= Math.max(1, expected - 1) && dataEnd - prev <= 1.35 * I ? hits : null;
}

function growthFactor(g: number, mode: GrowthMode, from: Day, to: Day, fyStartMonth: number): number {
  if (!g) return 1;
  if (mode === 'annual_step') return Math.pow(1 + g, fyOf(to, fyStartMonth) - fyOf(from, fyStartMonth));
  return Math.pow(1 + g, (to - from) / 365.25);
}

const monthKey = (d: Day) => { const { y, m } = ymdFromDay(d); return y * 12 + m - 1; };
const monthStart = (mk: number) => dayFromYMD(Math.floor(mk / 12), (mk % 12) + 1, 1);
const monthEnd = (mk: number) => dayFromYMD(Math.floor(mk / 12), (mk % 12) + 1, daysInMonth(Math.floor(mk / 12), (mk % 12) + 1));

const rollFor = (day: Day, amount: number) => (isBusinessDay(day) ? day : amount < 0 ? prevBusinessDay(day) : nextBusinessDay(day));

export function runForecast(req: ForecastRequest): ForecastResult {
  const t0 = performance.now();
  const { basis, settings } = req;
  const agg = basis.agg;
  const C = agg.catIds.length;
  const catIds = [...agg.catIds, 'uncategorised'];
  const catById = new Map(req.categories.map((c) => [c.id, c]));
  const start = dayFromISO(settings.start);
  const end = Math.max(start, dayFromISO(settings.end));
  const H = end - start + 1;
  const daily = new Float64Array((C + 1) * H);
  const oneOffDaily = new Float64Array(H);
  const treasuryDaily = new Float64Array(H);
  const markers: Marker[] = [];
  const explain: CategoryExplain[] = [];
  const fyM = req.fyStartMonth;
  const dataEnd = basis.dataEnd;
  const put = (c: number, day: Day, amt: number) => {
    const d = day - start;
    if (d >= 0 && d < H) daily[c * H + d] += amt;
  };
  // each regular payment's own projection, so the grid can show and edit it row by row
  const seriesRows = new Map<number, Map<string, Float64Array>>();

  // ---------- complete months available for profiling ----------
  const firstFull = (() => { const { y, m, d } = ymdFromDay(agg.startDay); return d === 1 ? y * 12 + m - 1 : y * 12 + m; })();
  const lastFull = (() => { const mk = monthKey(dataEnd); return dataEnd === monthEnd(mk) ? mk : mk - 1; })();
  const lookMonths = Math.max(12, Math.round(settings.lookbackYears * 12));
  const profFrom = Math.max(firstFull, lastFull - lookMonths + 1);
  const baseDay = monthEnd(lastFull);

  // global assumptions
  const inflation = req.assumptions.filter((a) => a.kind === 'inflation') as Extract<Assumption, { kind: 'inflation' }>[];

  // ---------- per-category projection ----------
  for (let c = 0; c <= C; c++) {
    const id = catIds[c];
    const cat = catById.get(id);
    const isUnc = c === C;
    if (!isUnc && (!cat || cat.group === 'treasury' || cat.group === 'internal')) continue;
    const method: ForecastMethod = settings.methodByCategory[id] ?? (isUnc ? 'exclude' : cat!.forecastMethod);
    const name = isUnc ? 'Uncategorised' : cat!.name;
    const row = agg.op.subarray(c * agg.D, (c + 1) * agg.D);
    const notes: string[] = [];

    // monthly totals (recurring operational only)
    const monthTotals = new Map<number, number>();
    for (let mk = profFrom; mk <= lastFull; mk++) monthTotals.set(mk, 0);
    for (let d = 0; d < agg.D; d++) {
      const v = row[d];
      if (!v) continue;
      const mk = monthKey(agg.startDay + d);
      if (mk >= profFrom && mk <= lastFull) monthTotals.set(mk, monthTotals.get(mk)! + v);
    }
    // historic trend: log-linear fit through every rolling 12-month total in the full history
    // (smoother and less noise-prone than comparing two end points)
    let historicCagr = 0;
    {
      const all: number[] = [];
      for (let mk = firstFull; mk <= lastFull; mk++) all.push(0);
      for (let d = 0; d < agg.D; d++) {
        const v = row[d];
        if (!v) continue;
        const mk = monthKey(agg.startDay + d);
        if (mk >= firstFull && mk <= lastFull) all[mk - firstFull] += v;
      }
      const sums: number[] = [];
      for (let k = 11; k < all.length; k++) { let t = 0; for (let j = k - 11; j <= k; j++) t += all[j]; sums.push(t); }
      if (sums.length >= 6) {
        const sign = Math.sign(sums[sums.length - 1]);
        if (sign && sums.every((x) => Math.sign(x) === sign && Math.abs(x) > 1000)) {
          const ys = sums.map((x) => Math.log(Math.abs(x)));
          const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
          let sxy = 0, sxx = 0;
          for (let k = 0; k < n; k++) { sxy += (k - mx) * (ys[k] - my); sxx += (k - mx) ** 2; }
          historicCagr = Math.exp((sxy / sxx) * 12) - 1;
        }
      }
      historicCagr = Math.max(-DEFAULT_LOOKBACK_CAP, Math.min(DEFAULT_LOOKBACK_CAP, historicCagr));
    }
    const ga = [...req.assumptions].reverse().find((a) => a.kind === 'growth' && a.categoryId === id) as Extract<Assumption, { kind: 'growth' }> | undefined;
    if (isUnc) historicCagr = 0;
    let g = ga ? ga.pct / 100 : historicCagr;
    const mode: GrowthMode = ga ? ga.mode : 'continuous';
    let inflationPct = 0;
    for (const inf of inflation) if (inf.categoryIds.includes(id)) inflationPct += inf.pct;
    if (inflationPct) g = (1 + g) * (1 + inflationPct / 100) - 1;
    const G = (from: Day, to: Day) => growthFactor(g, mode, from, to, fyM);

    // ---------- series (subtract from history; project active ones) ----------
    let catSeries: SeriesBasis[] = method === 'series' ? basis.series.filter((s) => s.catIdx === c) : [];
    let residual = row;
    const renamed: { signature: string; from: Day }[] = [];
    if (catSeries.length) {
      residual = row.slice();
      for (const s of catSeries) for (let k = 0; k < s.days.length; k++) {
        const d = s.days[k] - agg.startDay;
        if (d >= 0 && d < agg.D) residual[d] -= s.amounts[k];
      }
      // a payment that "stopped" but carries on under a new name (a department renamed, say)
      catSeries = catSeries.map((s) => {
        if (s.active) return s;
        const cont = continuation(s, residual, agg.startDay, dataEnd);
        if (!cont) return s;
        for (const [day, v] of cont) residual[day - agg.startDay] -= v;
        renamed.push({ signature: s.signature, from: cont[0][0] });
        return { ...s, active: true, lastDay: cont[cont.length - 1][0], days: Int32Array.from([...s.days, ...cont.map((x) => x[0])]), amounts: Float64Array.from([...s.amounts, ...cont.map((x) => x[1])]) };
      });
    }

    // ---------- within-month distribution ----------
    let distribution: CategoryExplain['distribution'] = 'day_of_month';
    const domShare = new Array(32).fill(0);
    const wdShare = new Array(7).fill(0);
    {
      let signed = 0, gross = 0;
      const fromD = Math.max(0, monthStart(profFrom) - agg.startDay);
      for (let d = fromD; d < agg.D; d++) {
        const v = residual[d];
        if (!v) continue;
        const day = agg.startDay + d;
        domShare[ymdFromDay(day).d] += v;
        wdShare[weekday(day)] += Math.abs(v);
        signed += v; gross += Math.abs(v);
      }
      const wdTot = wdShare.reduce((a, b) => a + b, 0);
      const maxWd = wdTot ? Math.max(...wdShare) / wdTot : 0;
      if (gross === 0) distribution = 'even';
      else if (maxWd >= 0.55) { distribution = 'weekday'; for (let k = 0; k < 7; k++) wdShare[k] /= wdTot; }
      else if (Math.abs(signed) < 0.1 * gross) distribution = 'even';
      else for (let k = 1; k <= 31; k++) domShare[k] /= signed;
    }
    // Weekly-run categories (e.g. a Tuesday BACS run): a month's total depends on how many
    // run days it contains, so the profile is built per unit of run-day capacity.
    const capCache = new Map<number, number>();
    const cap = (mk: number): number => {
      if (distribution !== 'weekday' || method === 'flat') return 1;
      let c = capCache.get(mk);
      if (c === undefined) {
        c = 0;
        for (let day = monthStart(mk); day <= monthEnd(mk); day++) if (isBusinessDay(day)) c += wdShare[weekday(day)];
        capCache.set(mk, c || 1);
      }
      return c || 1;
    };
    // ---------- seasonal profile (of residual if series method) ----------
    const resMonth = new Map<number, number>();
    if (residual !== row) {
      for (let mk = profFrom; mk <= lastFull; mk++) resMonth.set(mk, 0);
      for (let d = 0; d < agg.D; d++) {
        const v = residual[d];
        if (!v) continue;
        const mk = monthKey(agg.startDay + d);
        if (mk >= profFrom && mk <= lastFull) resMonth.set(mk, resMonth.get(mk)! + v);
      }
    }
    const mt = residual === row ? monthTotals : resMonth;
    const profile = new Array(12).fill(0);
    const clamps: Clamp[] = [];
    const residuals: number[] = [];
    const w = Math.max(0.05, Math.min(1, settings.recencyWeight));
    for (let cm = 0; cm < 12; cm++) {
      const vals: { v: number; w: number; mk: number }[] = [];
      for (let mk = profFrom; mk <= lastFull; mk++) {
        if (mk % 12 !== cm) continue;
        const mid = monthStart(mk) + 14;
        const ageYears = Math.floor((lastFull - mk) / 12);
        vals.push({ v: ((mt.get(mk) ?? 0) / cap(mk)) * G(mid, baseDay), w: Math.pow(w, ageYears), mk });
      }
      if (!vals.length) continue;
      if (vals.length >= 3) {
        const med = median(vals.map((x) => x.v));
        const mad = median(vals.map((x) => Math.abs(x.v - med)));
        const band = Math.max(3 * 1.4826 * mad, 0.1 * Math.abs(med));
        for (const x of vals) {
          const lo = med - band, hi = med + band;
          if (x.v < lo || x.v > hi) {
            const to = Math.min(hi, Math.max(lo, x.v));
            clamps.push({ year: Math.floor(x.mk / 12), month: (x.mk % 12) + 1, value: x.v, clampedTo: to });
            x.v = to;
          }
        }
      }
      const sw = vals.reduce((s, x) => s + x.w, 0);
      profile[cm] = vals.reduce((s, x) => s + x.v * x.w, 0) / sw;
      for (const x of vals) residuals.push(x.v - profile[cm]);
    }
    // profile shown to users in money per month (average run-day capacity for that month)
    const profileShown = profile.map((v, cm) => {
      if (distribution !== 'weekday' || method === 'flat') return v;
      let cs = 0, k = 0;
      for (let mk = profFrom; mk <= lastFull; mk++) if (mk % 12 === cm) { cs += cap(mk); k++; }
      return k ? v * (cs / k) : v;
    });
    // monthly variability of the whole category (for the uncertainty band)
    let sigmaMonthly = 0;
    {
      const r: number[] = [];
      const fullProfile = new Array(12).fill(0);
      const counts = new Array(12).fill(0);
      for (let mk = profFrom; mk <= lastFull; mk++) { fullProfile[mk % 12] += (monthTotals.get(mk) ?? 0) * G(monthStart(mk) + 14, baseDay); counts[mk % 12]++; }
      for (let k = 0; k < 12; k++) if (counts[k]) fullProfile[k] /= counts[k];
      for (let mk = profFrom; mk <= lastFull; mk++) r.push((monthTotals.get(mk) ?? 0) * G(monthStart(mk) + 14, baseDay) - fullProfile[mk % 12]);
      const med = median(r);
      sigmaMonthly = 1.4826 * median(r.map((x) => Math.abs(x - med)));
    }
    void residuals;

    if (method === 'flat') distribution = 'even';

    const spread = (mk: number, total: number) => {
      if (!total) return;
      const y = Math.floor(mk / 12), m = (mk % 12) + 1;
      const dim = daysInMonth(y, m);
      if (distribution === 'even' || distribution === 'series') {
        const bds: Day[] = [];
        for (let k = 1; k <= dim; k++) { const day = dayFromYMD(y, m, k); if (isBusinessDay(day)) bds.push(day); }
        for (const day of bds) put(c, day, total / bds.length);
      } else if (distribution === 'weekday') {
        let wsum = 0;
        const bds: Day[] = [];
        for (let k = 1; k <= dim; k++) { const day = dayFromYMD(y, m, k); if (isBusinessDay(day)) { bds.push(day); wsum += wdShare[weekday(day)]; } }
        if (!wsum) { for (const day of bds) put(c, day, total / bds.length); return; }
        for (const day of bds) put(c, day, (total * wdShare[weekday(day)]) / wsum);
      } else {
        for (let k = 1; k <= 31; k++) {
          const share = domShare[k];
          if (!share) continue;
          const day = dayFromYMD(y, m, Math.min(k, dim));
          put(c, rollFor(day, total * share), total * share);
        }
      }
    };

    // ---------- project ----------
    const firstMk = monthKey(start), lastMk = monthKey(end);
    let forecastTotal = 0;
    const seriesExplain: CategoryExplain['series'] = [];
    if (method === 'seasonal' || method === 'series') {
      for (let mk = firstMk; mk <= lastMk; mk++) {
        const mid = monthStart(mk) + 14;
        let total = profile[mk % 12] * cap(mk) * G(baseDay, mid);
        // part months at the edges
        const ms = Math.max(monthStart(mk), start), me = Math.min(monthEnd(mk), end);
        if (ms > monthStart(mk) || me < monthEnd(mk)) {
          // keep only the share of the month inside the horizon, by distribution
          const before = daily.slice(c * H, (c + 1) * H);
          spread(mk, total);
          let inside = 0;
          for (let d = 0; d < H; d++) inside += daily[c * H + d] - before[d];
          total = inside;
        } else spread(mk, total);
        forecastTotal += total;
      }
    } else if (method === 'flat') {
      let s = 0, k = 0;
      for (const v of monthTotals.values()) { s += v; k++; }
      const avg = k ? s / k : 0;
      for (let mk = firstMk; mk <= lastMk; mk++) {
        const before = daily.slice(c * H, (c + 1) * H);
        spread(mk, avg * G(baseDay, monthStart(mk) + 14));
        for (let d = 0; d < H; d++) forecastTotal += daily[c * H + d] - before[d];
      }
      notes.push(`Flat average of £${Math.round(avg).toLocaleString('en-GB')} a month over the last ${k} months.`);
    } else if (method === 'manual') {
      notes.push('Manual: only pasted schedules and one-offs are used.');
    } else if (method === 'exclude') {
      notes.push('Excluded from the forecast.');
    }
    if (method === 'series') {
      distribution = catSeries.length ? 'series' : distribution;
      const LOOK: Record<string, number> = { weekly: 8, fortnightly: 6, semi_monthly: 6, four_weekly: 4, monthly: 3, quarterly: 2, half_yearly: 2, annual: 1 };
      for (const s of catSeries) {
        // stable series: the last few payments; volatile ones: a longer, growth-adjusted window
        const base = LOOK[s.cadence] ?? 3;
        const k = Math.min(s.amountCV > 0.1 ? base * 4 : base, s.amounts.length);
        const last = s.days[s.days.length - 1];
        const recent: number[] = [];
        for (let j = s.amounts.length - k; j < s.amounts.length; j++) recent.push(s.amounts[j] * G(s.days[j], last));
        const level = median(recent);
        let projected = 0, next: Day | null = null;
        // the user may have said when this payment is made
        const tm = [...req.assumptions].reverse().find((a) => a.kind === 'timing' && a.signature === s.signature && a.categoryId === id) as Extract<Assumption, { kind: 'timing' }> | undefined;
        if (s.active && last >= dataEnd - 400) {
          let anchor = last;
          if (tm?.rule === 'weekday' && tm.weekday !== undefined) {
            // weekly-type payments: re-anchor on the nearest chosen weekday, keeping the rhythm
            let delta = (((tm.weekday - weekday(last)) % 7) + 7) % 7;
            if (delta > 3) delta -= 7;
            anchor = last + delta;
          }
          const sched = tm && tm.rule !== 'weekday' ? { ...s, lastWorkingDay: tm.rule === 'last_working_day', dayOfMonth: tm.rule === 'day_of_month' ? tm.dayOfMonth ?? s.dayOfMonth : s.dayOfMonth } : s;
          const dates = projectDates(sched, anchor, end).filter((d) => d > last);
          // the user may have removed this payment from a date
          const stopS = [...req.assumptions].reverse().find((a) => a.kind === 'stop' && a.signature === s.signature && a.categoryId === id) as Extract<Assumption, { kind: 'stop' }> | undefined;
          const stopDay = stopS ? dayFromISO(stopS.from) : Infinity;
          let rowArr = seriesRows.get(c)?.get(s.signature);
          if (!rowArr) { rowArr = new Float64Array(H); if (!seriesRows.has(c)) seriesRows.set(c, new Map()); seriesRows.get(c)!.set(s.signature, rowArr); }
          // payments that already arrived early, for a due date near one of these
          const early = (req.arrivals ?? []).filter((a) => a.answer === 'early' && a.kind === 'series' && a.signature === s.signature && a.categoryId === id).map((a) => dayFromISO(a.due));
          for (const due of dates) {
            const ei = early.findIndex((d) => Math.abs(d - due) <= DUE_MATCH_DAYS);
            if (ei >= 0) { early.splice(ei, 1); continue; }
            // due in the last few days before the forecast starts but not in the statements yet:
            // it's late, not skipped (a payday on a weekend, say), so it's counted on the first day
            const day = due < start && start - due <= 5 ? start : due;
            if (day < start || day >= stopDay) continue;
            const amt = level * G(last, day);
            put(c, day, amt);
            if (day - start < H) rowArr[day - start] += amt;
            projected += amt;
            if (next === null) next = day;
          }
        }
        forecastTotal += projected;
        seriesExplain.push({ signature: s.signature, cadence: s.cadence, level, next, projected, active: s.active, dayOfMonth: s.dayOfMonth, lastWorkingDay: s.lastWorkingDay, regularity: s.regularity, lastDay: last, timing: tm ? 'user' : 'history' });
      }
      for (const x of renamed) notes.push(`${x.signature} stopped under that name, but the same payment carries on from ${fmtDay(x.from)} (probably a new name), so it is still projected.`);
      const stopped = catSeries.filter((s) => !s.active);
      if (stopped.length) notes.push(`${stopped.length} series stopped before the end of the data and are not projected: ${stopped.map((s) => s.signature).slice(0, 3).join('; ')}.`);
    }
    if (clamps.length) notes.push(`${clamps.length} unusual month(s) were down-weighted when building the profile.`);

    // history annual (last 12 complete months, recurring)
    let historyAnnual = 0;
    for (let mk = lastFull - 11; mk <= lastFull; mk++) historyAnnual += monthTotals.get(mk) ?? 0;

    explain.push({
      catIdx: c, id, name, method, growthPct: g * 100, growthMode: mode, growthSource: ga ? 'assumption' : historicCagr ? 'historic' : 'none',
      historicCagr: historicCagr * 100, inflationPct, profile: profileShown, clamps, sigmaMonthly: method === 'exclude' || method === 'manual' ? 0 : sigmaMonthly,
      distribution, series: seriesExplain, notes, forecastTotal, historyAnnual,
    });
  }

  const ci = (id: string) => catIds.indexOf(id);
  // the model before any change, how changes scale it day by day, and what changes add
  const modelBase = daily.slice();
  const mult = new Float64Array((C + 1) * H).fill(1);
  const added = new Float64Array((C + 1) * H);
  const putAdded = (c: number, day: Day, amt: number) => { put(c, day, amt); const d = day - start; if (d >= 0 && d < H) added[c * H + d] += amt; };

  // ---------- assumptions ----------
  for (const a of req.assumptions) {
    if (a.kind === 'timing' && a.signature) continue; // applied to its series above
    if (a.kind === 'stop' && a.signature) continue;   // likewise
    if (a.kind === 'growth' || a.kind === 'inflation') {
      markers.push({ day: start, label: a.kind === 'growth' ? `${nameOf(req, a.categoryId)} ${a.pct >= 0 ? '+' : ''}${a.pct}% p.a.` : `Inflation +${a.pct}% on ${a.categoryIds.length} categories`, kind: 'assumption' });
      continue;
    }
    const c = ci(a.categoryId);
    if (c < 0) continue;
    const base = c * H;
    if (a.kind === 'stop') {
      const from = dayFromISO(a.from) - start;
      for (let d = Math.max(0, from); d < H; d++) { daily[base + d] = 0; mult[base + d] = 0; added[base + d] = 0; }
      markers.push({ day: dayFromISO(a.from), label: `${nameOf(req, a.categoryId)} stops`, kind: 'assumption' });
    } else if (a.kind === 'start') {
      const from = dayFromISO(a.from);
      const until = a.until ? dayFromISO(a.until) : end;
      const s = { cadence: a.cadence, dayOfMonth: a.dayOfMonth ?? ymdFromDay(from).d, lastWorkingDay: false, amounts: Float64Array.of(a.amount) };
      const dates = [from, ...projectDates(s, from, until)].filter((d, i, arr) => arr.indexOf(d) === i);
      for (const day of dates) if (day >= from && day <= until) putAdded(c, rollFor(day, a.amount), a.amount);
      markers.push({ day: from, label: `New: ${a.note || nameOf(req, a.categoryId)} ${fmtMoney(a.amount)} ${a.cadence.replace('_', '-')}`, kind: 'assumption' });
    } else if (a.kind === 'step') {
      const eff = dayFromISO(a.effective);
      const pct = a.pct / 100;
      let arrears = 0;
      if (a.backdateFrom) {
        const bf = dayFromISO(a.backdateFrom);
        for (let d = Math.max(0, bf - start); d < Math.min(H, eff - start); d++) arrears += daily[base + d] * pct;
      }
      for (let d = Math.max(0, eff - start); d < H; d++) { daily[base + d] *= 1 + pct; mult[base + d] *= 1 + pct; added[base + d] *= 1 + pct; }
      if (arrears && a.arrearsPaidOn) putAdded(c, rollFor(dayFromISO(a.arrearsPaidOn), arrears), arrears);
      markers.push({ day: eff, label: `${nameOf(req, a.categoryId)} ${a.pct >= 0 ? '+' : ''}${a.pct}%${arrears ? ` (arrears ${fmtMoney(arrears)})` : ''}`, kind: 'assumption' });
    } else if (a.kind === 'timing' && !a.signature && a.rule !== 'weekday') {
      const from = dayFromISO(a.from);
      for (let mk = monthKey(Math.max(from, start)); mk <= monthKey(end); mk++) {
        const ms = Math.max(monthStart(mk), from, start), me = Math.min(monthEnd(mk), end);
        let tot = 0;
        for (let day = ms; day <= me; day++) { tot += daily[base + day - start]; daily[base + day - start] = 0; }
        const y = Math.floor(mk / 12), m = (mk % 12) + 1;
        const target = a.rule === 'last_working_day' ? lastWorkingDayOfMonth(y, m) : rollFor(dayFromYMD(y, m, Math.min(a.dayOfMonth ?? 28, daysInMonth(y, m))), tot);
        put(c, target, tot);
      }
      markers.push({ day: from, label: `${nameOf(req, a.categoryId)} moves to ${a.rule === 'last_working_day' ? 'last working day' : `day ${a.dayOfMonth}`}`, kind: 'assumption' });
    }
  }

  // ---------- pasted schedules ----------
  const scheduled = new Float64Array((C + 1) * H);
  for (const s of req.pastedSchedules) {
    const c = ci(s.categoryId);
    if (c < 0) continue;
    if (s.mode === 'replace' && s.entries.length) {
      // replace the model only over the months the schedule covers
      const days = s.entries.map((e) => dayFromISO(e.date));
      const from = monthStart(monthKey(Math.min(...days))), to = monthEnd(monthKey(Math.max(...days)));
      for (let d = Math.max(0, from - start); d < Math.min(H, to - start + 1); d++) { daily[c * H + d] = 0; mult[c * H + d] = 0; added[c * H + d] = 0; scheduled[c * H + d] = 0; }
    }
    for (const e of s.entries) { put(c, dayFromISO(e.date), e.amount); const d = dayFromISO(e.date) - start; if (d >= 0 && d < H) scheduled[c * H + d] += e.amount; }
    const first = s.entries[0];
    if (first) markers.push({ day: dayFromISO(first.date), label: `Schedule: ${s.name}`, kind: 'schedule' });
  }

  // ---------- month-by-month grid: the user's own figures, then the rows shown ----------
  const mk0 = monthKey(start), mk1 = monthKey(end);
  const nM = mk1 - mk0 + 1;
  const mkLabel = (mk: number) => `${Math.floor(mk / 12)}-${String((mk % 12) + 1).padStart(2, '0')}`;
  const mkOf = (label: string) => { const [y, m] = label.split('-').map(Number); return y * 12 + m - 1; };
  const monthDays = (mk: number): [number, number] => [Math.max(monthStart(mk), start) - start, Math.min(monthEnd(mk), end) - start];
  const rowBase = (c: number, key: string): Float64Array | null => {
    if (key.startsWith('series:')) return seriesRows.get(c)?.get(key.slice(7)) ?? null;
    if (key === 'pattern') {
      const out = modelBase.slice(c * H, (c + 1) * H);
      for (const arr of seriesRows.get(c)?.values() ?? []) for (let d = 0; d < H; d++) out[d] -= arr[d];
      return out;
    }
    return null;
  };
  const patternCache = new Map<number, Float64Array>();
  const rowOf = (c: number, key: string) => {
    if (key === 'pattern') { if (!patternCache.has(c)) patternCache.set(c, rowBase(c, 'pattern')!); return patternCache.get(c)!; }
    return rowBase(c, key);
  };
  // each row's amount per day as it stands (the model, scaled by changes, then the user's figures)
  const effCache = new Map<string, Float64Array>();
  const eff = (c: number, key: string) => {
    const k = `${c}|${key}`;
    let arr = effCache.get(k);
    if (!arr) {
      arr = new Float64Array(H);
      const rb = rowOf(c, key);
      if (rb) for (let d = 0; d < H; d++) arr[d] = rb[d] * mult[c * H + d];
      effCache.set(k, arr);
    }
    return arr;
  };
  const overrideAt = new Map<string, number>(); // `${c}|${row}|${mk}` → month total
  const dayOverride = new Set<string>();         // `${c}|${row}|${d}`
  const ovs = req.overrides ?? [];
  // month totals first…
  for (const o of ovs) {
    if (o.date) continue;
    const c = ci(o.categoryId);
    const mk = mkOf(o.month);
    if (c < 0 || mk < mk0 || mk > mk1) continue;
    overrideAt.set(`${c}|${o.row}|${mk}`, o.amount);
    const [d0, d1] = monthDays(mk);
    const arr = eff(c, o.row);
    const rb = rowOf(c, o.row);
    // where the row usually pays: this month's days as they stand, else the model's days ignoring changes, else the 15th
    const shape = (src: Float64Array) => { const w = Array.from({ length: d1 - d0 + 1 }, (_, k) => Math.abs(src[d0 + k])); const t = w.reduce((a, b) => a + b, 0); return t > 0 ? w.map((x) => x / t) : null; };
    const weights = shape(arr) ?? (rb ? shape(rb) : null);
    for (let d = d0; d <= d1; d++) { daily[c * H + d] -= arr[d]; arr[d] = 0; }
    if (weights) for (let d = d0; d <= d1; d++) { const v = o.amount * weights[d - d0]; arr[d] = v; daily[c * H + d] += v; }
    else {
      const y = Math.floor(mk / 12), m = (mk % 12) + 1;
      const d = Math.min(end, Math.max(start, rollFor(dayFromYMD(y, m, 15), o.amount))) - start;
      arr[d] += o.amount; daily[c * H + d] += o.amount;
    }
  }
  // …then single days, exactly as typed
  for (const o of ovs) {
    if (!o.date) continue;
    const c = ci(o.categoryId);
    const d = dayFromISO(o.date) - start;
    if (c < 0 || d < 0 || d >= H) continue;
    const arr = eff(c, o.row);
    daily[c * H + d] += o.amount - arr[d];
    arr[d] = o.amount;
    dayOverride.add(`${c}|${o.row}|${d}`);
  }

  const oneOffByCat = new Float64Array((C + 1) * H);

  // ---------- one-offs ----------
  const arrivedIds = new Set((req.arrivals ?? []).filter((a) => a.answer === 'early' && a.kind === 'oneoff').map((a) => a.oneOffId));
  for (const o of req.oneOffs) {
    // already in the statements
    if (arrivedIds.has(o.id)) continue;
    const day = dayFromISO(o.date);
    const p = o.confidence === 'possible' ? (settings.includePossible ? (o.probability ?? 0.5) : 0) : 1;
    const c = ci(o.categoryId) >= 0 ? ci(o.categoryId) : C;
    const amt = o.amount * p;
    if (day >= start && day <= end) {
      put(c, day, amt);
      oneOffDaily[day - start] += amt;
      oneOffByCat[c * H + day - start] += amt;
    }
    markers.push({ day, label: `${o.description || 'One-off'} ${fmtMoney(o.amount)}${o.confidence === 'possible' ? ` (possible, ${Math.round((o.probability ?? 0.5) * 100)}%)` : o.confidence === 'likely' ? ' (likely)' : ''}`, kind: 'oneoff', amount: o.amount });
  }

  // the rows shown in each category's grid
  const grid: Record<string, CategoryGrid> = {};
  const months = Array.from({ length: nM }, (_, k) => mkLabel(mk0 + k));
  /** monthly sums of a per-day array: a row's own (length H) or a category slice of a (C+1)×H array */
  const byMonth = (arr: Float64Array, c: number, _scale: boolean, own = false) => {
    const out = new Array(nM).fill(0);
    for (let k = 0; k < nM; k++) { const [d0, d1] = monthDays(mk0 + k); for (let d = d0; d <= d1; d++) out[k] += arr[(own ? 0 : c * H) + d]; }
    return out;
  };
  for (const e of explain) {
    if (e.method === 'exclude') continue;
    const c = e.catIdx;
    const rows: GridRow[] = [];
    const editableRow = (key: string, label: string, kind: GridRow['kind'], removed = false) => {
      const arr = eff(c, key);
      const values = byMonth(arr, c, false, true);
      const dayOv = new Uint8Array(H);
      for (let d = 0; d < H; d++) if (dayOverride.has(`${c}|${key}|${d}`)) dayOv[d] = 1;
      const byDay = values.map((_, k) => { const [d0, d1] = monthDays(mk0 + k); for (let d = d0; d <= d1; d++) if (dayOv[d]) return true; return false; });
      const overridden = values.map((_, k) => overrideAt.has(`${c}|${key}|${mk0 + k}`) || byDay[k]);
      // a month total the user typed is shown exactly as typed
      values.forEach((_, k) => { if (!byDay[k] && overrideAt.has(`${c}|${key}|${mk0 + k}`)) values[k] = overrideAt.get(`${c}|${key}|${mk0 + k}`)!; });
      rows.push({ key, label, kind, editable: true, values, overridden, byDay, removed, daily: arr, dayOverridden: dayOv });
    };
    for (const sx of e.series) {
      if (!sx.active) continue;
      const removed = req.assumptions.some((a) => a.kind === 'stop' && a.signature === sx.signature && a.categoryId === e.id);
      editableRow(`series:${sx.signature}`, sx.signature, 'series', removed);
    }
    if (e.method !== 'manual') editableRow('pattern', e.series.length ? 'Everything else (usual pattern)' : 'Usual pattern', 'pattern');
    const customs = [...new Set((req.overrides ?? []).filter((o) => o.categoryId === e.id && o.row.startsWith('custom:')).map((o) => o.row))];
    for (const key of customs) editableRow(key, key.slice(7), 'custom');
    const ro = (key: string, label: string, kind: GridRow['kind'], arr: Float64Array) => {
      const values = byMonth(arr, c, false);
      if (values.some((v) => Math.abs(v) >= 0.5)) rows.push({ key, label, kind, editable: false, values, overridden: values.map(() => false), byDay: values.map(() => false), daily: arr.slice(c * H, (c + 1) * H), dayOverridden: new Uint8Array(H) });
    };
    ro('added', 'Changes from Known future items', 'added', added);
    ro('schedule', 'Pasted schedules', 'schedule', scheduled);
    ro('oneoff', 'One-offs', 'oneoff', oneOffByCat);
    grid[e.id] = { months, start, rows };
  }

  // ---------- treasury schedule (separate layer) ----------
  for (const t of req.treasurySchedule) {
    const day = dayFromISO(t.date);
    if (day >= start && day <= end) treasuryDaily[day - start] += t.amount;
  }

  // ---------- the deal register (loans, investments, money market funds) ----------
  const registerDaily = new Float64Array(H);
  let regInfo: ForecastResult['register'] = null;
  if (req.register) {
    let k = 0, sum = 0;
    for (const e of req.register.events) {
      if (e.day < start || e.day > end) continue;
      const day = isBusinessDay(e.day) ? e.day : nextBusinessDay(e.day);
      const d = Math.min(H - 1, Math.max(0, day - start));
      registerDaily[d] += e.amount; k++; sum += e.amount;
      if (Math.abs(e.amount) >= 1e6 && !/interest/.test(e.kind)) markers.push({ day: start + d, label: `${e.label} ${fmtMoney(e.amount)}`, kind: 'treasury', amount: e.amount });
    }
    regInfo = { liquid: req.register.liquid, events: k, net: sum };
  }

  // ---------- totals ----------
  const everyday = settings.openingPosition ?? req.defaultOpening;
  const opening = everyday + (regInfo?.liquid ?? 0);
  const net = new Float64Array(H);
  for (let c = 0; c <= C; c++) for (let d = 0; d < H; d++) net[d] += daily[c * H + d];
  const cumulative = new Float64Array(H);
  const cumulativeAfterTreasury = new Float64Array(H);
  const cumulativeBefore = new Float64Array(H);
  let run = opening, runB = everyday, runT = 0;
  for (let d = 0; d < H; d++) {
    run += net[d] + registerDaily[d]; runB += net[d]; runT += treasuryDaily[d];
    cumulative[d] = run; cumulativeBefore[d] = runB; cumulativeAfterTreasury[d] = run + runT;
  }

  // uncertainty: random-walk accumulation of monthly category variability
  const sigma2 = explain.reduce((s, e) => s + e.sigmaMonthly * e.sigmaMonthly, 0);
  const lower = new Float64Array(H), upper = new Float64Array(H);
  const z = settings.bandZ || 1.645;
  for (let d = 0; d < H; d++) {
    const months = (d + 1) / 30.44;
    const sd = Math.sqrt(sigma2 * months);
    lower[d] = cumulative[d] - z * sd;
    upper[d] = cumulative[d] + z * sd;
  }

  let lo = 0, hi = 0, loT = 0;
  for (let d = 1; d < H; d++) {
    if (cumulative[d] < cumulative[lo]) lo = d;
    if (cumulative[d] > cumulative[hi]) hi = d;
    if (cumulativeAfterTreasury[d] < cumulativeAfterTreasury[loT]) loT = d;
  }
  const buffer = req.liquidityBuffer;
  const breaches: ForecastResult['breaches'] = [];
  let cur: { from: Day; to: Day; min: number } | null = null;
  for (let d = 0; d < H; d++) {
    if (cumulative[d] < buffer) {
      if (!cur) cur = { from: start + d, to: start + d, min: cumulative[d] };
      cur.to = start + d;
      cur.min = Math.min(cur.min, cumulative[d]);
    } else if (cur) { breaches.push(cur); cur = null; }
  }
  if (cur) breaches.push(cur);
  const borrowingRequirement = Math.max(0, buffer - cumulative[lo]);

  // drivers: from the preceding high to the low point
  let peak = 0;
  for (let d = 0; d <= lo; d++) if (cumulative[d] >= cumulative[peak]) peak = d;
  const windowFrom = peak < lo ? peak + 1 : Math.max(0, lo - 60);
  const drivers = catIds.map((id, c) => {
    let s = 0;
    for (let d = windowFrom; d <= lo; d++) s += daily[c * H + d];
    return { id, name: c === C ? 'Uncategorised' : catById.get(id)?.name ?? id, amount: s };
  }).filter((x) => x.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 3);
  const summary = buildSummary({ start, lo, hi, cumulative, buffer, borrowingRequirement, drivers, windowFrom, breaches, H, end, withRegister: !!regInfo });

  return {
    start, H, catIds, daily, oneOffDaily, treasuryDaily, net, cumulative, cumulativeAfterTreasury, cumulativeBefore, registerDaily, register: regInfo, grid, lower, upper, opening,
    low: { day: start + lo, amount: cumulative[lo] }, high: { day: start + hi, amount: cumulative[hi] },
    lowAfterTreasury: { day: start + loT, amount: cumulativeAfterTreasury[loT] },
    breaches, borrowingRequirement, buffer, explain, markers: markers.sort((a, b) => a.day - b.day), summary, drivers, ms: performance.now() - t0,
  };
}

function nameOf(req: ForecastRequest, id: string): string {
  return req.categories.find((c) => c.id === id)?.name ?? id;
}

export function fmtMoney(x: number, dp = 1): string {
  const a = Math.abs(x);
  const s = a >= 1e9 ? `£${(a / 1e9).toFixed(2)}bn` : a >= 1e6 ? `£${(a / 1e6).toFixed(dp)}m` : a >= 1e3 ? `£${(a / 1e3).toFixed(0)}k` : `£${a.toFixed(0)}`;
  return x < 0 ? `−${s}` : s;
}

/** Next occurrence dates for a series after `last`, up to `end`. */
export function projectDates(s: Pick<SeriesBasis, 'cadence' | 'dayOfMonth' | 'lastWorkingDay'> & { amounts?: Float64Array; dayOfMonth2?: number }, last: Day, end: Day): Day[] {
  const out: Day[] = [];
  const sign = s.amounts && s.amounts.length ? s.amounts[s.amounts.length - 1] : -1;
  if (s.cadence === 'semi_monthly') {
    const { y, m } = ymdFromDay(last);
    for (let k = 0; ; k++) {
      const mi = y * 12 + (m - 1) + k;
      const yy = Math.floor(mi / 12), mm = (mi % 12) + 1;
      if (dayFromYMD(yy, mm, 1) > end) break;
      for (const dd of [s.dayOfMonth, s.dayOfMonth2 ?? s.dayOfMonth + 15]) {
        const day = rollFor(dayFromYMD(yy, mm, Math.min(Math.max(1, dd), daysInMonth(yy, mm))), sign);
        if (day > last + 3 && day <= end) out.push(day);
      }
    }
    return out.sort((a, b) => a - b);
  }
  const stepDays: Record<string, number> = { weekly: 7, fortnightly: 14, four_weekly: 28 };
  if (stepDays[s.cadence]) {
    const step = stepDays[s.cadence];
    // anchor on the nominal (un-rolled) weekday cadence
    for (let d = last + step; d <= end + 3; d += step) {
      const r = rollFor(d, sign);
      if (r <= end) out.push(r);
    }
    return out;
  }
  const monthsStep: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 };
  const ms = monthsStep[s.cadence];
  if (!ms) return out;
  const { y, m } = ymdFromDay(last);
  for (let k = 1; ; k++) {
    const mi = y * 12 + (m - 1) + k * ms;
    const yy = Math.floor(mi / 12), mm = (mi % 12) + 1;
    if (dayFromYMD(yy, mm, 1) > end) break;
    const day = s.lastWorkingDay ? lastWorkingDayOfMonth(yy, mm) : rollFor(dayFromYMD(yy, mm, Math.min(s.dayOfMonth, daysInMonth(yy, mm))), sign);
    if (day <= end && day > last) out.push(day);
  }
  return out;
}

function buildSummary(x: {
  start: Day; lo: number; hi: number; cumulative: Float64Array; buffer: number; borrowingRequirement: number;
  drivers: { name: string; amount: number }[]; windowFrom: number; breaches: { from: Day; to: Day }[]; H: number; end: Day; withRegister?: boolean;
}): string {
  const low = x.cumulative[x.lo];
  const lowDay = x.start + x.lo;
  const parts: string[] = [];
  const falls = low < x.cumulative[0];
  parts.push(`${x.withRegister ? 'Your cash, after the loans and investments in your deal register,' : 'Your everyday cash'} is expected to ${falls ? 'fall to' : 'be'} its lowest point of ${fmtMoney(low)} on ${fmtDay(lowDay)}.`);
  if (x.drivers.length) {
    const names = x.drivers.map((d) => d.name.toLowerCase());
    parts.push(`The biggest reasons are ${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]}.`);
  }
  if (x.borrowingRequirement > 0) {
    parts.push(`To keep at least ${fmtMoney(x.buffer)} in the bank, you may need to borrow about ${fmtMoney(x.borrowingRequirement)} by then.`);
    if (x.breaches.length) parts.push(`Cash first drops below ${fmtMoney(x.buffer)} on ${fmtDay(x.breaches[0].from)}.`);
  } else {
    parts.push(`It stays above the ${fmtMoney(x.buffer)} you want to keep, so you shouldn’t need to borrow. The most spare cash is ${fmtMoney(x.cumulative[x.hi])} on ${fmtDay(x.start + x.hi)} — a good time to invest.`);
  }
  if (x.lo !== x.H - 1) parts.push(`By ${MONTH_NAMES[ymdFromDay(x.end).m - 1]} ${ymdFromDay(x.end).y} it is ${fmtMoney(x.cumulative[x.H - 1])}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- period aggregation

export type Granularity = 'daily' | 'weekly' | 'monthly';

export function periodise(start: Day, H: number, g: Granularity): { labels: string[]; index: Int32Array; startDays: Day[] } {
  const index = new Int32Array(H);
  const labels: string[] = [];
  const startDays: Day[] = [];
  let cur = -1, key = '';
  for (let d = 0; d < H; d++) {
    const day = start + d;
    let k: string;
    if (g === 'daily') k = String(day);
    else if (g === 'weekly') { const mon = day - ((weekday(day) + 6) % 7); k = String(mon); }
    else { const { y, m } = ymdFromDay(day); k = `${y}-${m}`; }
    if (k !== key) {
      key = k; cur++;
      startDays.push(g === 'weekly' ? Number(k) : day);
      const { y, m, d: dd } = ymdFromDay(g === 'weekly' ? Number(k) : day);
      labels.push(g === 'monthly' ? `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}` : `${dd} ${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`);
    }
    index[d] = cur;
  }
  return { labels, index, startDays };
}

export function sumByPeriod(arr: Float64Array, offset: number, H: number, index: Int32Array, nPeriods: number): number[] {
  const out = new Array(nPeriods).fill(0);
  for (let d = 0; d < H; d++) out[index[d]] += arr[offset + d];
  return out;
}

export function lastByPeriod(arr: Float64Array, H: number, index: Int32Array, nPeriods: number): number[] {
  const out = new Array(nPeriods).fill(0);
  for (let d = 0; d < H; d++) out[index[d]] = arr[d];
  return out;
}
