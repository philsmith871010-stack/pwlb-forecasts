// The cash history in the team file: built from bank files, merged as new files arrive,
// and good enough to forecast from without the files.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest, type Dataset } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { buildBasis } from '../src/lib/analysis/aggregates';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { runForecast } from '../src/lib/forecast/engine';
import { fromSession, mergeHistory, basisFromHistory, historySpan, historyBytes, historyBefore } from '../src/lib/history/cashHistory';
import { isoFromDay, addMonths, dayFromISO } from '../src/lib/dates';
import { runBacktest, backtestFromHistory } from '../src/lib/forecast/backtest';
import { signForecast, compareSigned } from '../src/lib/forecast/signoff';
import { exampleSignOffs } from '../src/lib/forecast/exampleSignoffs';
import { emptyTeamFile, parseTeamFile, serialiseTeamFile, mergeTeamFiles } from '../src/lib/teamfile';

const cfg = { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };

/** The rows of a dataset between two days, as if loaded on their own. */
function slice(ds: Dataset, from: number, to: number): Dataset {
  let a = 0; while (a < ds.n && ds.day[a] < from) a++;
  let b = a; while (b < ds.n && ds.day[b] <= to) b++;
  return {
    ...ds, n: b - a, day: ds.day.slice(a, b), amount: ds.amount.slice(a, b), account: ds.account.slice(a, b), file: ds.file.slice(a, b), line: ds.line.slice(a, b),
    narr: ds.narr.slice(a, b), rowFlags: ds.rowFlags.slice(a, b), minDay: ds.day[a], maxDay: ds.day[b - 1],
    balanceChecks: from <= ds.minDay ? ds.balanceChecks : [], openingBalance: from <= ds.minDay ? ds.openingBalance : null,
  };
}

describe('cash history', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'hist' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, cfg);
  const full = buildBasis(ds, res);
  const start = full.dataEnd + 1;
  const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 12) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  const fc = (basis: NonNullable<ReturnType<typeof basisFromHistory>>) => runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 });
  const net12 = (f: ReturnType<typeof fc>) => f.net.reduce((t, v) => t + v, 0);
  const catIds = res.catIds;

  it('tests the forecast a year back from the saved history alone, as the files do', () => {
    const h = fromSession(ds, res);
    const cutoff = addMonths(full.dataEnd + 1, -12);
    const o = { cutoff, horizonMonths: 12, categories: DEFAULT_CATEGORIES, settings: { lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {} }, includeActualOneOffs: false, fyStartMonth: 4 };
    const fromFiles = runBacktest(ds, res, full.agg, o);
    const fromHist = backtestFromHistory(h, o)!;
    expect(fromHist.H).toBe(fromFiles.H);
    const end = fromHist.H - 1;
    // what actually happened is the same to the penny; the forecast within a small margin of the year's flow
    expect(fromHist.actualCum[end]).toBeCloseTo(fromFiles.actualCum[end], 0);
    const gross = fromFiles.errorAt.find((e) => e.months === 12)!.actualAbsFlow;
    expect(Math.abs(fromHist.forecastCum[end] - fromFiles.forecastCum[end]) / gross).toBeLessThan(0.01);
  });

  it('keeps a signed-off forecast and compares it with what happened', () => {
    const h = fromSession(ds, res);
    const cutoff = addMonths(full.dataEnd + 1, -12);
    const before = basisFromHistory(historyBefore(h, cutoff), catIds)!;
    const st = { ...settings, start: isoFromDay(cutoff), end: isoFromDay(addMonths(cutoff, 24) - 1), openingPosition: 0, includePossible: false };
    const f = runForecast({ basis: before, categories: DEFAULT_CATEGORIES, settings: st, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 });
    const sc = { id: 'fc1', name: 'Base', updatedAt: '', settings: st, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [] };
    const rec = signForecast(f, sc, { id: 'so1', signedAt: '2025-04-02T10:00:00Z', signedBy: 'Test', knownItems: [] });
    expect(rec.everyday.cum).toHaveLength(f.H);
    // small enough to keep many in the team file (and, later, in a database row)
    expect(JSON.stringify(rec).length).toBeLessThan(40_000);
    const r = compareSigned(rec, h, DEFAULT_CATEGORIES)!;
    expect(r.H).toBe(full.dataEnd - cutoff + 1); // compared up to the latest statement
    // the same answer as testing the method from that date
    const bt = backtestFromHistory(h, { cutoff, horizonMonths: 12, categories: DEFAULT_CATEGORIES, settings: st, includeActualOneOffs: false, fyStartMonth: 4 })!;
    const end = r.H - 1;
    expect(r.actualCum[end]).toBeCloseTo(bt.actualCum[end], 0);
    expect(Math.abs(r.forecastCum[end] - bt.forecastCum[end])).toBeLessThan(2);
    // nothing to compare until statements after the start come in
    expect(compareSigned({ ...rec, start: isoFromDay(full.dataEnd + 1) }, h, DEFAULT_CATEGORIES)).toBeNull();
  });

  it('keeps everyone’s sign-offs when team files are saved and merged', () => {
    const h = fromSession(ds, res);
    const recs = exampleSignOffs(h, DEFAULT_CATEGORIES, 10e6);
    expect(recs.map((x) => x.scenarioName)).toEqual(['Budget forecast', 'Mid-year review']);
    const mine = { ...emptyTeamFile('X'), signedOff: [recs[0]] }, theirs = { ...emptyTeamFile('X'), signedOff: [recs[1]] };
    const back = parseTeamFile(serialiseTeamFile(mine, 'me', 'test').json).team!;
    expect(back.signedOff).toEqual([recs[0]]);
    expect(mergeTeamFiles(mine, theirs).merged.signedOff!.map((x) => x.id)).toEqual(recs.map((x) => x.id));
  });

  it('holds no bank lines, and forecasts exactly as the files do', () => {
    const h = fromSession(ds, res);
    const text = JSON.stringify(h);
    // no narratives other than regular payees' names
    const payees = new Set(h.series.map((s) => s.sig));
    const sample = ds.narratives.filter((n) => !payees.has(n)).slice(0, 200);
    expect(sample.some((n) => n.length > 12 && text.includes(n))).toBe(false);
    const b = basisFromHistory(h, catIds)!;
    expect(b.dataEnd).toBe(full.dataEnd);
    expect(b.agg.openingBalance).toBeCloseTo(full.agg.openingBalance, 1);
    for (const k of ['op', 'opOneOff', 'treasury'] as const) {
      const x = b.agg[k], y = full.agg[k];
      let diff = 0; for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]));
      expect(diff).toBeLessThan(0.02);
    }
    expect(b.series.length).toBe(full.series.length);
    expect(net12(fc(b))).toBeCloseTo(net12(fc(full)), -3);
    expect(historyBytes(h)).toBeLessThan(2_000_000);
  });

  it('four years saved plus the latest year added forecasts like all five loaded at once', () => {
    const cut = addMonths(full.dataEnd + 1, -12);
    const s1 = slice(ds, ds.minDay, cut - 1), s2 = slice(ds, cut, ds.maxDay);
    const h1 = fromSession(s1, categorise(s1, cfg));
    const r2 = categorise(s2, cfg);
    const h2 = fromSession(s2, r2, h1.series);
    const { history, report } = mergeHistory(h1, h2);
    expect(historySpan(history)).toEqual({ from: ds.minDay, to: ds.maxDay });
    expect(report.gaps).toEqual([]);
    const b = basisFromHistory(history, catIds)!;
    const A = fc(b), E = fc(full);
    // against the money flowing (the net is a small difference of big numbers)
    const gross = E.explain.reduce((t, x) => t + Math.abs(x.forecastTotal), 0);
    expect(Math.abs(net12(A) - net12(E)) / gross).toBeLessThan(0.005);
    for (const e of E.explain) {
      const a = A.explain.find((x) => x.id === e.id)!;
      if (Math.abs(e.forecastTotal) > 10e6) expect(Math.abs(a.forecastTotal - e.forecastTotal) / Math.abs(e.forecastTotal)).toBeLessThan(0.05);
    }
  });

  it('loading the same period again replaces it rather than counting it twice', () => {
    const h = fromSession(ds, res);
    const last = slice(ds, addMonths(ds.maxDay + 1, -3), ds.maxDay);
    const again = fromSession(last, categorise(last, cfg), h.series);
    const { history, report } = mergeHistory(h, again);
    expect(report.added.every((x) => x.replacedDays > 0)).toBe(true);
    const tot = (x: typeof h) => x.cells.reduce((t, c) => { for (let k = 0; k < c.length; k += 4) t += c[k + 3]; return t; }, 0);
    expect(tot(history)).toBe(tot(h));
  });

  it('one day added to the history extends its regular payments', () => {
    const before = slice(ds, ds.minDay, ds.maxDay - 1);
    const h = fromSession(before, categorise(before, cfg));
    // the last day in the data that has a regular payment
    const day = ds.maxDay;
    const one = slice(ds, day, day);
    const add = fromSession(one, categorise(one, cfg), h.series);
    const { history, report } = mergeHistory(h, add);
    expect(report.added.length).toBeGreaterThan(0);
    expect(historySpan(history)!.to).toBe(day);
    const occAfter = history.series.reduce((t, s) => t + s.occ.length, 0), occBefore = h.series.reduce((t, s) => t + s.occ.length, 0);
    expect(occAfter).toBeGreaterThanOrEqual(occBefore);
    expect(basisFromHistory(history, catIds)!.dataEnd).toBe(day);
  });

  it('holding back the last day, then adding it again, gives the full history back', () => {
    const h = fromSession(ds, res);
    const back = historyBefore(h, ds.maxDay);
    expect(historySpan(back)!.to).toBeLessThan(ds.maxDay);
    const one = slice(ds, ds.maxDay, ds.maxDay);
    const { history } = mergeHistory(back, fromSession(one, categorise(one, cfg), back.series));
    const tot = (x: typeof h) => x.cells.reduce((t, c) => { for (let k = 0; k < c.length; k += 4) t += c[k + 3]; return t; }, 0);
    expect(tot(history)).toBe(tot(h));
    expect(historySpan(history)).toEqual(historySpan(h));
  });

  it('reports a gap when a period is missing', () => {
    const a = slice(ds, ds.minDay, dayFromISO('2023-03-31'));
    const b = slice(ds, dayFromISO('2023-07-01'), ds.maxDay);
    const { report } = mergeHistory(fromSession(a, categorise(a, cfg)), fromSession(b, categorise(b, cfg)));
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(isoFromDay(report.gaps[0].from) <= '2023-04-03').toBe(true);
  });
});

describe('cash history in the team file', async () => {
  const { emptyTeamFile, serialiseTeamFile, parseTeamFile, mergeTeamFiles } = await import('../src/lib/teamfile');
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'hist-team' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, cfg);
  const cut = addMonths(ds.maxDay + 1, -6);
  const a = slice(ds, ds.minDay, cut - 1), b = slice(ds, cut, ds.maxDay);
  const ha = fromSession(a, categorise(a, cfg));
  const hb = fromSession(b, categorise(b, cfg), ha.series);

  it('survives saving and opening, compactly, and can be left out', () => {
    const team = { ...emptyTeamFile('Test'), cashHistory: ha };
    const { json } = serialiseTeamFile(team, 'me', 'test');
    const back = parseTeamFile(json).team!;
    expect(back.cashHistory).toEqual(ha);
    expect(json.split('\n').length).toBeLessThan(400); // the number lists stay on single lines
    const off = serialiseTeamFile({ ...team, settings: { ...team.settings, keepCashHistory: false } }, 'me', 'test');
    expect(parseTeamFile(off.json).team!.cashHistory).toBeUndefined();
    void res;
  });

  it('two colleagues’ files combine their histories', () => {
    const mine = { ...emptyTeamFile('Test'), cashHistory: hb };
    const theirs = { ...emptyTeamFile('Test'), cashHistory: ha };
    const { merged, summary } = mergeTeamFiles(mine, theirs);
    expect(historySpan(merged.cashHistory!)).toEqual({ from: ds.minDay, to: ds.maxDay });
    expect(summary.join(' ')).toMatch(/cash history/);
  });
});
