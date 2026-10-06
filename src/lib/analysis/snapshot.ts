// Aggregate-only snapshots saved into the team file so colleagues can view history and
// forecasts without the bank CSVs. Category × month totals — no transaction lines.
import type { Aggregates } from './aggregates';
import { monthlyTotals } from './history';
import type { HistorySummary, ResultsSnapshot } from '../model';
import type { ForecastResult } from '../forecast/engine';
import { periodise, sumByPeriod, lastByPeriod } from '../forecast/engine';
import { isoFromDay, fmtDay } from '../dates';

export function buildHistorySummary(agg: Aggregates): HistorySummary {
  const ms = monthlyTotals(agg, 'op');
  const byCategory: Record<string, number[]> = {};
  [...agg.catIds, 'uncategorised'].forEach((id, c) => {
    if (ms.values[c].some((v) => Math.abs(v) > 0.5)) byCategory[id] = ms.values[c].map((v) => Math.round(v * 100) / 100);
  });
  const tr = monthlyTotals(agg, 'treasury');
  const treasury = tr.values.reduce((acc, row) => acc.map((v, k) => v + row[k]), new Array(tr.keys.length).fill(0));
  byCategory.__treasury_net = treasury.map((v: number) => Math.round(v * 100) / 100);
  return {
    generatedAt: new Date().toISOString(),
    firstMonth: `${Math.floor(ms.keys[0] / 12)}-${String((ms.keys[0] % 12) + 1).padStart(2, '0')}`,
    months: ms.keys.map((k) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`),
    byCategory,
    openingPosition: agg.openingBalance,
  };
}

export function buildResultsSnapshot(fc: ForecastResult): ResultsSnapshot {
  const p = periodise(fc.start, fc.H, 'monthly');
  const n = p.labels.length;
  const byCategory: Record<string, number[]> = {};
  fc.catIds.forEach((id, c) => {
    const v = sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, n);
    if (v.some((x) => Math.abs(x) > 0.5)) byCategory[id] = v.map((x) => Math.round(x));
  });
  const r = (a: number[]) => a.map((x) => Math.round(x));
  return {
    generatedAt: new Date().toISOString(),
    granularity: 'monthly',
    periods: p.startDays.map((d) => isoFromDay(d)),
    byCategory,
    net: r(sumByPeriod(fc.net, 0, fc.H, p.index, n)),
    cumulative: r(lastByPeriod(fc.cumulative, fc.H, p.index, n)),
    lower: r(lastByPeriod(fc.lower, fc.H, p.index, n)),
    upper: r(lastByPeriod(fc.upper, fc.H, p.index, n)),
    low: { date: isoFromDay(fc.low.day), amount: Math.round(fc.low.amount) },
    high: { date: isoFromDay(fc.high.day), amount: Math.round(fc.high.amount) },
    summary: fc.summary,
  };
}

export const snapshotLowLabel = (s: ResultsSnapshot) => `${fmtDay(Math.floor(Date.parse(s.low.date) / 864e5))}`;
