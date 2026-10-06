// Historic analysis from the daily × category aggregates. Pure functions; fast enough to run
// on the main thread (a few ms for 5 years × 30 categories).

import type { Aggregates } from './aggregates';
import { Day, ymdFromDay, fyOf, fyLabel, MONTH_NAMES, dayFromYMD, daysInMonth, isBusinessDay } from '../dates';

export type YearMode = 'fy' | 'calendar';

export interface YearInfo { key: number; label: string; start: Day; end: Day; complete: boolean; days: number }

export function yearsOf(agg: Aggregates, mode: YearMode, fyStartMonth: number): YearInfo[] {
  const first = agg.startDay, last = agg.startDay + agg.D - 1;
  const keyOf = (d: Day) => (mode === 'fy' ? fyOf(d, fyStartMonth) : ymdFromDay(d).y);
  const out: YearInfo[] = [];
  for (let k = keyOf(first); k <= keyOf(last); k++) {
    const start = mode === 'fy' ? dayFromYMD(k, fyStartMonth, 1) : dayFromYMD(k, 1, 1);
    const end = (mode === 'fy' ? dayFromYMD(k + 1, fyStartMonth, 1) : dayFromYMD(k + 1, 1, 1)) - 1;
    const s = Math.max(start, first), e = Math.min(end, last);
    out.push({ key: k, label: mode === 'fy' ? fyLabel(k, fyStartMonth) : String(k), start, end, complete: s === start && e === end, days: e - s + 1 });
  }
  return out;
}

export interface AnnualTable {
  years: YearInfo[];
  /** [cat][year] operational totals (recurring + one-off) */
  op: number[][];
  recurring: number[][];
  oneOff: number[][];
  treasury: number[][];
}

export function annualTotals(agg: Aggregates, years: YearInfo[]): AnnualTable {
  const C1 = agg.catIds.length + 1;
  const mk = () => Array.from({ length: C1 }, () => new Array(years.length).fill(0));
  const op = mk(), recurring = mk(), oneOff = mk(), treasury = mk();
  const yIdx = new Int16Array(agg.D);
  let yi = 0;
  for (let d = 0; d < agg.D; d++) {
    const day = agg.startDay + d;
    while (yi < years.length - 1 && day > years[yi].end) yi++;
    yIdx[d] = yi;
  }
  for (let c = 0; c < C1; c++) {
    const base = c * agg.D;
    for (let d = 0; d < agg.D; d++) {
      const r = agg.op[base + d], o = agg.opOneOff[base + d], t = agg.treasury[base + d];
      if (!r && !o && !t) continue;
      const y = yIdx[d];
      recurring[c][y] += r; oneOff[c][y] += o; op[c][y] += r + o; treasury[c][y] += t;
    }
  }
  return { years, op, recurring, oneOff, treasury };
}

export function cagr(values: number[], years: YearInfo[]): number | null {
  const idx = years.map((y, i) => (y.complete ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return null;
  const a = values[idx[0]], b = values[idx[idx.length - 1]];
  if (!a || !b || Math.sign(a) !== Math.sign(b)) return null;
  return Math.pow(b / a, 1 / (idx.length - 1)) - 1;
}

/** Daily cumulative positions. */
export function positions(agg: Aggregates): { operational: Float64Array; actual: Float64Array; treasuryCum: Float64Array } {
  const C1 = agg.catIds.length + 1;
  const opNet = new Float64Array(agg.D), trNet = new Float64Array(agg.D);
  for (let c = 0; c < C1; c++) {
    const base = c * agg.D;
    for (let d = 0; d < agg.D; d++) { opNet[d] += agg.op[base + d] + agg.opOneOff[base + d]; trNet[d] += agg.treasury[base + d]; }
  }
  const operational = new Float64Array(agg.D), actual = new Float64Array(agg.D), treasuryCum = new Float64Array(agg.D);
  let o = agg.openingBalance, a = agg.openingBalance, t = 0;
  for (let d = 0; d < agg.D; d++) {
    o += opNet[d]; t += trNet[d]; a += opNet[d] + trNet[d] + agg.internal[d];
    operational[d] = o; actual[d] = a; treasuryCum[d] = t;
  }
  return { operational, actual, treasuryCum };
}

export interface MonthlySeries { keys: number[]; labels: string[]; values: number[][] }

/** Monthly totals per category (op recurring + one-off unless split) */
export function monthlyTotals(agg: Aggregates, which: 'op' | 'recurring' | 'oneOff' | 'treasury' = 'op'): MonthlySeries {
  const first = ymdFromDay(agg.startDay), last = ymdFromDay(agg.startDay + agg.D - 1);
  const m0 = first.y * 12 + first.m - 1, m1 = last.y * 12 + last.m - 1;
  const n = m1 - m0 + 1;
  const C1 = agg.catIds.length + 1;
  const values = Array.from({ length: C1 }, () => new Array(n).fill(0));
  const mIdx = new Int32Array(agg.D);
  for (let d = 0; d < agg.D; d++) { const { y, m } = ymdFromDay(agg.startDay + d); mIdx[d] = y * 12 + m - 1 - m0; }
  for (let c = 0; c < C1; c++) {
    const base = c * agg.D;
    for (let d = 0; d < agg.D; d++) {
      const v = which === 'op' ? agg.op[base + d] + agg.opOneOff[base + d] : which === 'recurring' ? agg.op[base + d] : which === 'oneOff' ? agg.opOneOff[base + d] : agg.treasury[base + d];
      if (v) values[c][mIdx[d]] += v;
    }
  }
  const keys = Array.from({ length: n }, (_, k) => m0 + k);
  return { keys, labels: keys.map((k) => `${MONTH_NAMES[k % 12]} ${String(Math.floor(k / 12)).slice(2)}`), values };
}

export interface SeasonalProfile {
  /** month labels in FY order */
  months: string[];
  /** per year: 12 values (null when that month is not covered) */
  byYear: { label: string; values: (number | null)[] }[];
  typical: number[];
  lo: number[];
  hi: number[];
}

export function seasonalProfile(agg: Aggregates, c: number, years: YearInfo[], mode: YearMode, fyStartMonth: number, which: 'op' | 'recurring' = 'recurring'): SeasonalProfile {
  const ms = monthlyTotals(agg, which);
  const startM = mode === 'fy' ? fyStartMonth : 1;
  const months = Array.from({ length: 12 }, (_, k) => MONTH_NAMES[(startM - 1 + k) % 12]);
  const first = ymdFromDay(agg.startDay), last = ymdFromDay(agg.startDay + agg.D - 1);
  const firstFull = first.d === 1 ? first.y * 12 + first.m - 1 : first.y * 12 + first.m;
  const lastFull = last.d === daysInMonth(last.y, last.m) ? last.y * 12 + last.m - 1 : last.y * 12 + last.m - 2;
  const byYear = years.map((y) => {
    const vals: (number | null)[] = [];
    for (let k = 0; k < 12; k++) {
      const mi = (mode === 'fy' ? y.key : y.key) * 12 + (startM - 1) + k;
      const idx = ms.keys.indexOf(mi);
      vals.push(idx >= 0 && mi >= firstFull && mi <= lastFull ? ms.values[c][idx] : null);
    }
    return { label: y.label, values: vals };
  });
  const typical: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let k = 0; k < 12; k++) {
    const v = byYear.map((y) => y.values[k]).filter((x): x is number => x !== null).sort((a, b) => a - b);
    if (!v.length) { typical.push(0); lo.push(0); hi.push(0); continue; }
    const mid = v.length >> 1;
    typical.push(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
    lo.push(v[0]); hi.push(v[v.length - 1]);
  }
  return { months, byYear, typical, lo, hi };
}

/** Average share of a category's flow landing on each day of the month (1–31). */
export function dayOfMonthProfile(agg: Aggregates, c: number): { share: number[]; peakDays: number[] } {
  const base = c * agg.D;
  const s = new Array(32).fill(0);
  let tot = 0;
  for (let d = 0; d < agg.D; d++) {
    const v = Math.abs(agg.op[base + d]);
    if (!v) continue;
    s[ymdFromDay(agg.startDay + d).d] += v; tot += v;
  }
  const share = s.slice(1).map((x) => (tot ? x / tot : 0));
  const peakDays = share.map((v, i) => [v, i + 1]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter(([v]) => v > 0.08).map(([, d]) => d);
  return { share, peakDays };
}

export interface Break { day: Day; kind: 'level' | 'timing' | 'start' | 'stop'; text: string }

/** Simple, explainable structural-break detection on a category. */
export function detectBreaks(agg: Aggregates, c: number, series: { signature: string; firstDay: Day; lastDay: Day; active: boolean; categoryIdx: number; cadence: string; occurrences: number }[]): Break[] {
  const out: Break[] = [];
  const end = agg.startDay + agg.D - 1;
  // series starting / stopping
  for (const s of series) {
    if (s.categoryIdx !== c || s.cadence === 'daily' || s.occurrences < 3) continue;
    if (!s.active) out.push({ day: s.lastDay, kind: 'stop', text: `“${s.signature}” stopped (last seen ${fmt(s.lastDay)})` });
    if (s.firstDay > agg.startDay + 120) out.push({ day: s.firstDay, kind: 'start', text: `“${s.signature}” started ${fmt(s.firstDay)}` });
  }
  // timing: peak payment day per month (only for categories with one dominant monthly run)
  const base = c * agg.D;
  const peaks: { mi: number; dom: number; lwd: boolean; share: number }[] = [];
  let cur = -1, best = 0, bestDay = 0, tot = 0;
  const flush = () => {
    if (cur >= 0 && tot) {
      const { y, m, d } = ymdFromDay(bestDay);
      let k = bestDay + 1; while (!isBusinessDay(k) && ymdFromDay(k).m === m) k++;
      peaks.push({ mi: y * 12 + m - 1, dom: d, lwd: ymdFromDay(k).m !== m, share: best / tot });
    }
  };
  for (let d = 0; d < agg.D; d++) {
    const day = agg.startDay + d;
    const { y, m } = ymdFromDay(day);
    const mi = y * 12 + m - 1;
    if (mi !== cur) { flush(); cur = mi; best = 0; bestDay = day; tot = 0; }
    const v = Math.abs(agg.op[base + d]);
    tot += v;
    if (v > best) { best = v; bestDay = day; }
  }
  flush();
  if (peaks.length >= 18 && peaks.filter((p) => p.share > 0.5).length > peaks.length * 0.8) {
    const sig = (p: { dom: number; lwd: boolean }) => (p.lwd ? 'LWD' : String(p.dom));
    for (let k = 6; k < peaks.length - 6; k++) {
      const before = peaks.slice(Math.max(0, k - 9), k), after = peaks.slice(k, k + 9);
      const mode = (a: typeof peaks) => { const m = new Map<string, number>(); for (const p of a) m.set(sig(p), (m.get(sig(p)) ?? 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1])[0]; };
      const mb = mode(before), ma = mode(after);
      const domB = median(before.map((p) => p.dom)), domA = median(after.map((p) => p.dom));
      if (mb[0] !== ma[0] && mb[1] >= before.length * 0.6 && ma[1] >= after.length * 0.6 && Math.abs(domA - domB) >= 1) {
        const lbl = (s: string) => (s === 'LWD' ? 'the last working day' : `around the ${ordinal(+s)}`);
        out.push({ day: dayFromYMD(Math.floor(peaks[k].mi / 12), (peaks[k].mi % 12) + 1, 1), kind: 'timing', text: `Main payment day moved from ${lbl(mb[0])} to ${lbl(ma[0])} from ${MONTH_NAMES[peaks[k].mi % 12]} ${Math.floor(peaks[k].mi / 12)}` });
        break;
      }
    }
  }
  // level: largest shift between 6-month means
  const ms = monthlyTotals(agg, 'recurring').values[c];
  if (ms.length >= 18) {
    let bestT = 0, bestK = -1, bestRatio = 0;
    for (let k = 6; k <= ms.length - 6; k++) {
      const a = ms.slice(k - 6, k), b = ms.slice(k, k + 6);
      const ma = mean(a), mb = mean(b);
      const sd = Math.sqrt((variance(a) + variance(b)) / 2) || 1;
      const t = Math.abs(mb - ma) / (sd / Math.sqrt(3));
      if (t > bestT && Math.abs(ma) > 0) { bestT = t; bestK = k; bestRatio = mb / ma - 1; }
    }
    // ignore ordinary annual growth: needs a sharp step
    if (bestT > 6 && Math.abs(bestRatio) > 0.2 && bestK > 0) {
      const first = ymdFromDay(agg.startDay);
      const mi = first.y * 12 + first.m - 1 + bestK;
      out.push({ day: dayFromYMD(Math.floor(mi / 12), (mi % 12) + 1, 1), kind: 'level', text: `Step change in level around ${MONTH_NAMES[mi % 12]} ${Math.floor(mi / 12)} (${bestRatio > 0 ? '+' : ''}${(bestRatio * 100).toFixed(0)}% on the previous six months)` });
    }
  }
  return out.filter((b) => b.day <= end).sort((a, b) => a.day - b.day);
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const variance = (a: number[]) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); };
function median(a: number[]): number { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const fmt = (d: Day) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };

/** Min and max of a daily series within [from, to] (day numbers). */
export function extremes(arr: Float64Array, startDay: Day, from: Day, to: Day): { min: number; minDay: Day; max: number; maxDay: Day } {
  let min = Infinity, max = -Infinity, minDay = from, maxDay = from;
  for (let d = Math.max(0, from - startDay); d <= Math.min(arr.length - 1, to - startDay); d++) {
    if (arr[d] < min) { min = arr[d]; minDay = startDay + d; }
    if (arr[d] > max) { max = arr[d]; maxDay = startDay + d; }
  }
  return { min, minDay, max, maxDay };
}
