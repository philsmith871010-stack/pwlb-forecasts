import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { computeAccuracy } from '../src/lib/categorise/accuracy';
import { buildBasis, buildBasisAsOf } from '../src/lib/analysis/aggregates';
import { annualTotals, yearsOf } from '../src/lib/analysis/history';
import { runBacktest } from '../src/lib/forecast/backtest';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { fyOf, dayFromISO, isoFromDay, addMonths } from '../src/lib/dates';
import { runForecast } from '../src/lib/forecast/engine';
import { buildWorkbook } from '../src/lib/export/xlsx';
import { emptyTeamFile } from '../src/lib/teamfile';
import * as XLSX from 'xlsx';

describe('end to end on generated data', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'e2e' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true });
  const basis = buildBasis(ds, res);

  it('categorises accurately and excludes deal flows', () => {
    const acc = computeAccuracy(ds, res, g.truth);
    expect(acc.overall.pctRows).toBeGreaterThan(0.97);
    expect(acc.deal.pctExcluded).toBeGreaterThan(0.95);
    expect(acc.deal.wronglyExcludedValue).toBeLessThan(5e6);
    expect(acc.wrongDates).toBeLessThan(5);
  });

  it('history YoY totals match the truth file for well-categorised categories', () => {
    const years = yearsOf(basis.agg, 'fy', 4);
    const an = annualTotals(basis.agg, years);
    // truth totals by category and FY (excluding duplicate rows the app removes)
    const truthTot = new Map<string, number>();
    for (const f of g.truth.files) for (let k = 0; k < f.line.length; k++) {
      if (f.dup[k] === '1' || f.badDate[k] === '1') continue;
      const key = `${g.truth.categories[f.cat[k]]}|${fyOf(f.day[k])}`;
      truthTot.set(key, (truthTot.get(key) ?? 0) + f.pence[k] / 100);
    }
    for (const id of ['council_tax', 'salaries', 'precepts', 'dsg', 'hmrc_paye']) {
      const c = basis.agg.catIds.indexOf(id);
      years.forEach((y, yi) => {
        const app = an.op[c][yi] + an.treasury[c][yi];
        const truth = truthTot.get(`${id}|${y.key}`) ?? 0;
        expect(Math.abs(app - truth)).toBeLessThan(Math.max(50_000, Math.abs(truth) * 0.002));
      });
    }
  });

  it('backtests use no data after the cut-off', () => {
    const cutoff = dayFromISO('2024-04-01');
    const asOf = buildBasisAsOf(ds, res, cutoff);
    expect(asOf.dataEnd).toBe(cutoff - 1);
    expect(asOf.agg.startDay + asOf.agg.D - 1).toBeLessThan(cutoff);
    for (const s of asOf.series) expect(s.days[s.days.length - 1]).toBeLessThan(cutoff);
    const r = runBacktest(ds, res, basis.agg, { cutoff, horizonMonths: 12, categories: DEFAULT_CATEGORIES, settings: { lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {} }, includeActualOneOffs: false, fyStartMonth: 4 });
    expect(r.usedDataTo).toBe(cutoff - 1);
    expect(r.errorAt.find((e) => e.months === 12)).toBeTruthy();
  });

  it('exports an Excel workbook with every sheet', async () => {
    const start = ds.maxDay + 1;
    const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 12) - 1), granularity: 'monthly' as const, openingPosition: 0, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
    const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 1e7, defaultOpening: 0 });
    const blob = await buildWorkbook({ team: emptyTeamFile('T'), agg: basis.agg, scenario: { id: 's', name: 'Base', updatedAt: '', settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [] }, fc, backtest: null, appName: 'CFI' });
    const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()));
    expect(wb.SheetNames).toEqual(expect.arrayContaining(['Summary', 'History by month', 'Year on year', 'Seasonal profiles', 'Forecast', 'Forecast daily', 'Methods & assumptions', 'Rules']));
  });
});

describe('end to end with the example deal register', async () => {
  const { registerFromSnapshot } = await import('../src/lib/register');
  const { registerEvents, registerAccounts, liquidBalances } = await import('../src/lib/register/cashflows');
  const { liabilityBenchmark } = await import('../src/lib/register/benchmark');
  const { buildStrategy } = await import('../src/lib/forecast/strategy');
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'e2e-reg' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const reg = registerFromSnapshot(g.register).reg;
  const ev = registerEvents(reg);
  const res = categorise(ds, { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true, registerEvents: ev.filter((e) => !e.future), registerAccounts: registerAccounts(reg) });

  it('matches bank lines to the register and excludes every deal, with nothing operational taken', () => {
    const m = res.registerMatch!;
    expect(m.matched / m.events).toBeGreaterThan(0.9);
    expect(m.interest.found / m.interest.estimated).toBeGreaterThan(0.9);
    const acc = computeAccuracy(ds, res, g.truth);
    expect(acc.deal.pctExcluded).toBeGreaterThan(0.995);
    expect(acc.deal.wronglyExcludedValue, JSON.stringify(acc.deal.wrongExclusions)).toBe(0);
  });

  it('carries the register into the forecast and the options', () => {
    const basis = buildBasis(ds, res);
    const start = basis.dataEnd + 1;
    const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 24) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
    const liq = liquidBalances(reg);
    const future = ev.filter((e) => e.future);
    const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 2e6, register: { liquid: liq.total, events: future } });
    // the headline line = everyday cash + funds + every register cash flow in the window
    const inWindow = future.filter((e) => e.day >= fc.start && e.day < fc.start + fc.H).reduce((s, e) => s + e.amount, 0);
    expect(fc.cumulative[fc.H - 1] - fc.cumulativeBefore[fc.H - 1]).toBeCloseTo(liq.total + inWindow, 0);
    const st = buildStrategy(fc, { repayments: future.filter((e) => e.kind === 'loan_repayment'), loboCalls: [], lb: liabilityBenchmark(reg), liquid: liq.total, debt: 0 });
    expect(st.lasting + st.shortTerm).toBeCloseTo(st.shortfall, 0);
    expect(st.benchmark).not.toBeNull();
    expect(st.options.length).toBeGreaterThan(1);
  });
});

describe('checking a line: payment day for one series', async () => {
  const { lastWorkingDayOfMonth, ymdFromDay } = await import('../src/lib/dates');
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'e2e-timing' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true });
  const basis = buildBasis(ds, res);
  const start = basis.dataEnd + 1;
  const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 12) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  const req = { basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 };

  it('moves only that series to the last working day, keeping the total', () => {
    const fc0 = runForecast(req);
    // the largest monthly payment not already on the last working day, in whichever line it is
    const sal = fc0.explain.filter((e) => e.series.some((x) => x.cadence === 'monthly' && !x.lastWorkingDay && x.active))
      .sort((a, z) => Math.max(...z.series.map((x) => Math.abs(x.level))) - Math.max(...a.series.map((x) => Math.abs(x.level))))[0];
    const s = sal.series.filter((x) => x.cadence === 'monthly' && !x.lastWorkingDay && x.active).sort((a, z) => Math.abs(z.level) - Math.abs(a.level))[0];
    expect(s).toBeDefined();
    const fc1 = runForecast({ ...req, assumptions: [{ id: 't', kind: 'timing', categoryId: sal.id, signature: s.signature, from: settings.start, rule: 'last_working_day' }] });
    const c = sal.catIdx, H = fc0.H;
    const row = (fc: typeof fc0) => fc.daily.subarray(c * H, (c + 1) * H);
    const tot = (a: Float64Array) => a.reduce((x, v) => x + v, 0);
    // same payments, a few days later (growth is by date, so the total moves a hair)
    expect(Math.abs(tot(row(fc1)) / tot(row(fc0)) - 1)).toBeLessThan(0.001);
    // in a month where the usual day isn't the last working day, that series' payment moves there
    const { y, m } = ymdFromDay(addMonths(start, 2));
    const lwd = lastWorkingDayOfMonth(y, m) - fc0.start;
    const moved = row(fc1)[lwd] - row(fc0)[lwd];
    expect(Math.abs(moved / s.level - 1)).toBeLessThan(0.03); // the payment, plus a little growth
    expect(fc1.explain.find((e) => e.id === sal.id)!.series.find((x) => x.signature === s.signature)!.timing).toBe('user');
  });

  it('moves a weekly payment to another weekday, keeping one a week', async () => {
    const { weekday } = await import('../src/lib/dates');
    const fc0 = runForecast(req);
    const sal = fc0.explain.find((e) => e.id === 'salaries')!;
    const w = sal.series.find((x) => x.cadence === 'weekly')!;
    expect(w).toBeDefined();
    const target = (weekday(w.lastDay) + 5) % 7 || 3; // a different weekday (never Sunday)
    const fc1 = runForecast({ ...req, assumptions: [{ id: 't', kind: 'timing', categoryId: 'salaries', signature: w.signature, from: settings.start, rule: 'weekday', weekday: target === 6 ? 3 : target }] });
    const want = target === 6 ? 3 : target;
    const c = sal.catIdx, H = fc0.H;
    // the days that gained money are (nearly all) the chosen weekday — bank holidays roll forward
    const gained: number[] = [];
    for (let d = 0; d < H; d++) if (fc1.daily[c * H + d] - fc0.daily[c * H + d] < -1) gained.push(fc0.start + d);
    const onDay = gained.filter((d) => weekday(d) === want).length;
    expect(onDay / gained.length).toBeGreaterThan(0.9);
    expect(gained.length).toBeGreaterThan(45);
    expect(gained.length).toBeLessThan(56);
  });
});

describe('month-by-month grid', async () => {
  const { periodise, sumByPeriod } = await import('../src/lib/forecast/engine');
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'e2e-grid' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true });
  const basis = buildBasis(ds, res);
  const start = basis.dataEnd + 1;
  const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 12) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  const req = { basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [{ id: 'o', date: isoFromDay(start + 40), amount: 3e6, categoryId: 'grants_general', description: 'x', confidence: 'firm' as const }], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 };
  const monthly = (fc: ReturnType<typeof runForecast>, id: string) => {
    const c = fc.explain.find((e) => e.id === id)!.catIdx;
    const p = periodise(fc.start, fc.H, 'monthly');
    return sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, p.labels.length);
  };
  const colSum = (fc: ReturnType<typeof runForecast>, id: string) => fc.grid[id].months.map((_, k) => fc.grid[id].rows.reduce((t, r) => t + r.values[k], 0));

  it('rows add up to the forecast, month by month', () => {
    const fc = runForecast(req);
    for (const id of ['salaries', 'council_tax', 'grants_general', 'suppliers']) {
      const a = monthly(fc, id), b = colSum(fc, id);
      a.forEach((v, k) => expect(b[k]).toBeCloseTo(v, 0));
    }
  });

  it('a typed figure is final, a pasted block lands cell by cell, and a new row adds money', () => {
    const fc0 = runForecast(req);
    const gr = fc0.grid.salaries;
    const sRow = gr.rows.find((r) => r.kind === 'series')!;
    const [m1, m2, m3] = gr.months;
    const ov = [
      { categoryId: 'salaries', row: sRow.key, month: m2, amount: -1_234_567 },
      // a pasted block: three months of the "everything else" row
      ...[m1, m2, m3].map((m, k) => ({ categoryId: 'salaries', row: 'pattern', month: m, amount: -100_000 * (k + 1) })),
      { categoryId: 'grants_general', row: 'custom:New grant', month: m3, amount: 2_500_000 },
    ];
    const fc1 = runForecast({ ...req, assumptions: [{ id: 'g', kind: 'growth', categoryId: 'salaries', pct: 10, mode: 'annual_step' }], overrides: ov });
    const g1 = fc1.grid.salaries;
    expect(g1.rows.find((r) => r.key === sRow.key)!.values[1]).toBe(-1_234_567);
    expect(g1.rows.find((r) => r.key === 'pattern')!.values.slice(0, 3)).toEqual([-100_000, -200_000, -300_000]);
    // still adds up after the edits (growth applies elsewhere, never to typed figures)
    const a = monthly(fc1, 'salaries'), b = colSum(fc1, 'salaries');
    a.forEach((v, k) => expect(b[k]).toBeCloseTo(v, 0));
    expect(monthly(fc1, 'grants_general')[2] - monthly(fc0, 'grants_general')[2]).toBeCloseTo(2_500_000, 0);
    expect(fc1.grid.grants_general.rows.find((r) => r.key === 'custom:New grant')!.values[2]).toBe(2_500_000);
    expect(fc1.grid.grants_general.rows.find((r) => r.kind === 'oneoff')!.values.some((v) => Math.abs(v - 3e6) < 1)).toBe(true);
  });

  it('a figure typed for one day lands on that day, exactly', () => {
    const fc0 = runForecast(req);
    const gr = fc0.grid.salaries;
    const sRow = gr.rows.find((r) => r.kind === 'series')!;
    // the day the payment is usually made in the second month, moved to a figure of our own
    const [d0] = [...sRow.daily.keys()].filter((d) => sRow.daily[d] !== 0 && d > 31);
    const day = isoFromDay(fc0.start + d0);
    const quiet = isoFromDay(fc0.start + d0 + 2);
    const fc1 = runForecast({ ...req, overrides: [
      { categoryId: 'salaries', row: sRow.key, month: day.slice(0, 7), date: day, amount: -42 },
      { categoryId: 'salaries', row: sRow.key, month: quiet.slice(0, 7), date: quiet, amount: -1_000_000 },
    ] });
    const r1 = fc1.grid.salaries.rows.find((r) => r.key === sRow.key)!;
    expect(r1.daily[d0]).toBe(-42);
    expect(r1.daily[d0 + 2]).toBe(-1_000_000);
    expect(r1.dayOverridden[d0]).toBe(1);
    const c = fc1.explain.find((e) => e.id === 'salaries')!.catIdx;
    expect(fc1.daily[c * fc1.H + d0] - fc0.daily[c * fc0.H + d0]).toBeCloseTo(-42 - sRow.daily[d0], 4);
    const k = fc1.grid.salaries.months.indexOf(day.slice(0, 7));
    expect(r1.byDay[k]).toBe(true);
    // rows still add up to the line
    const a = monthly(fc1, 'salaries'), b = colSum(fc1, 'salaries');
    a.forEach((v, j) => expect(b[j]).toBeCloseTo(v, 0));
  });

  it('day figures sit on top of a month total for the same row', () => {
    const fc0 = runForecast(req);
    const m = fc0.grid.salaries.months[3];
    const mStart = dayFromISO(`${m}-01`) - fc0.start;
    const fc1 = runForecast({ ...req, overrides: [
      { categoryId: 'salaries', row: 'pattern', month: m, amount: -500_000 },
      { categoryId: 'salaries', row: 'pattern', month: m, date: isoFromDay(fc0.start + mStart + 9), amount: -77_000 },
    ] });
    const r = fc1.grid.salaries.rows.find((x) => x.key === 'pattern')!;
    expect(r.daily[mStart + 9]).toBe(-77_000);
    expect(r.overridden[3]).toBe(true);
  });

  it('removing one regular payment removes only that payment', () => {
    const fc0 = runForecast(req);
    const sRow = fc0.grid.salaries.rows.find((r) => r.kind === 'series')!;
    const sig = sRow.key.slice(7);
    const fc1 = runForecast({ ...req, assumptions: [{ id: 's', kind: 'stop', categoryId: 'salaries', signature: sig, from: settings.start }] });
    const r1 = fc1.grid.salaries.rows.find((r) => r.key === sRow.key)!;
    expect(r1.removed).toBe(true);
    expect(r1.values.every((v) => v === 0)).toBe(true);
    const drop = monthly(fc0, 'salaries').reduce((t, v) => t + v, 0) - monthly(fc1, 'salaries').reduce((t, v) => t + v, 0);
    expect(drop).toBeCloseTo(sRow.values.reduce((t, v) => t + v, 0), 0);
  });
});

describe('grid edits: days and months together', async () => {
  const { applyCells } = await import('../src/ui/forecast/GridEditor');
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'e2e-grid2' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const res = categorise(ds, { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true });
  const basis = buildBasis(ds, res);
  const start = basis.dataEnd + 1;
  const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 6) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  const req = { basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 };

  it('a day edit inside a typed month total keeps the rest of that month where it was', () => {
    const fc0 = runForecast(req);
    const row = fc0.grid.grants_general.rows.find((r) => r.kind === 'pattern')!;
    const m = fc0.grid.grants_general.months[1];
    const dayIso = Array.from({ length: fc0.H }, (_, d) => isoFromDay(fc0.start + d));
    const ctx = (fc: typeof fc0) => ({ catId: 'grants_general', sign: 1, grid: fc.grid.grants_general, dayIso });
    // 1. a month total
    let ov = applyCells([], [{ row: 'pattern', month: m, shown: 900_000 }], ctx(fc0));
    const fc1 = runForecast({ ...req, overrides: ov });
    const r1 = fc1.grid.grants_general.rows.find((r) => r.key === 'pattern')!;
    const monthDays = dayIso.map((iso, d) => ({ iso, d })).filter((x) => x.iso.slice(0, 7) === m);
    const before = monthDays.map((x) => r1.daily[x.d]);
    // 2. one day in that month changed
    const target = monthDays.find((x) => r1.daily[x.d] === 0)!;
    ov = applyCells(ov, [{ row: 'pattern', month: m, date: target.iso, shown: 50_000 }], ctx(fc1));
    expect(ov.some((o) => !o.date && o.month === m)).toBe(false);
    const fc2 = runForecast({ ...req, overrides: ov });
    const r2 = fc2.grid.grants_general.rows.find((r) => r.key === 'pattern')!;
    monthDays.forEach((x, k) => expect(r2.daily[x.d]).toBeCloseTo(x.d === target.d ? 50_000 : before[k], 2));
    expect(r2.values[1]).toBeCloseTo(950_000, 0);
    // 3. a new month total wipes that month's day figures
    ov = applyCells(ov, [{ row: 'pattern', month: m, shown: 1_000_000 }], ctx(fc2));
    expect(ov.filter((o) => o.month === m && o.date)).toHaveLength(0);
    expect(runForecast({ ...req, overrides: ov }).grid.grants_general.rows.find((r) => r.key === 'pattern')!.values[1]).toBe(1_000_000);
    void row;
  });
});
