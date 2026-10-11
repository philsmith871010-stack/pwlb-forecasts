// Headless end-to-end: generate → ingest → categorise → accuracy, with timings.
// Usage: npm run bench -- [--preset small|large|brutal] [--team data/sample-team-file.json]
import { readFileSync } from 'node:fs';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS, VolumePreset } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { computeAccuracy } from '../src/lib/categorise/accuracy';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import type { TeamFile } from '../src/lib/model';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const preset = (arg('preset') ?? 'small') as VolumePreset;
const team: TeamFile | null = arg('team') ? JSON.parse(readFileSync(arg('team')!, 'utf8')) : null;

let t = performance.now();
const lap = (label: string) => { const now = performance.now(); console.log(`${label.padEnd(28)} ${(now - t).toFixed(0).padStart(6)} ms`); t = now; };
const ds0 = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, preset, seed: arg('seed') ?? DEFAULT_GENERATOR_OPTIONS.seed });
lap(`generate (${ds0.stats.rows} rows)`);
const sources = ds0.files.map((f) => {
  const rep = detectMapping(f.text.slice(0, 64000), f.name);
  return { name: f.name, data: f.text, size: f.text.length, mapping: rep.mapping };
});
lap('detect');
const ds = await ingest(sources);
lap(`ingest (${ds.n} rows kept)`);
const { registerFromSnapshot } = await import('../src/lib/register');
const { registerEvents, registerAccounts } = await import('../src/lib/register/cashflows');
const regEvents = args.includes('--register') ? registerEvents(registerFromSnapshot(ds0.register).reg).filter((e) => !e.future) : undefined;
const res = categorise(ds, {
  registerEvents: regEvents,
  registerAccounts: args.includes('--register') ? registerAccounts(registerFromSnapshot(ds0.register).reg) : undefined,
  categories: team?.categories ?? DEFAULT_CATEGORIES,
  rules: team?.rules ?? [],
  aliases: team?.aliases ?? [],
  seriesOverrides: team?.seriesOverrides ?? [],
  txnOverrides: team?.txnOverrides ?? [],
  useStarterRules: true,
});
lap('categorise');
console.log('  stage ms', JSON.stringify(res.ms));
if (res.registerMatch) console.log(`  register: ${res.registerMatch.matched} of ${res.registerMatch.events} events matched (£${(res.registerMatch.matchedAbs / 1e6).toFixed(0)}m); ${res.registerMatch.unmatched.length} not found`, res.registerMatch.unmatched.slice(0, 5));
const acc = computeAccuracy(ds, res, ds0.truth);
lap('accuracy');

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const m = (x: number) => '£' + (x / 1e6).toFixed(1) + 'm';
console.log(`\nRejected rows: ${ds.rejects.length} (truth rows not loaded: ${acc.rejectedTruthRows}, of which bad dates ${acc.rejectedBadDates}); wrong dates: ${acc.wrongDates}`);
console.log(`Overlap dups removed: ${ds.files.map((f) => f.overlapDuplicatesRemoved).join(',')}; accounts: ${ds.accounts.join(', ')}`);
console.log(`Balance checks: ${ds.balanceChecks.map((b) => `${b.file}: ${b.breaks}/${b.checked} breaks`).join('; ')}`);
console.log(`\nOverall: rows ${pct(acc.overall.pctRows)}  value ${pct(acc.overall.pctValue)}   uncategorised value ${m(acc.uncategorisedValue)}`);
console.log(`Deal: ${pct(acc.deal.pctExcluded)} of ${m(acc.deal.truthDealValue)} excluded; leaked ${m(acc.deal.leakedValue)} (${acc.deal.leakedRows} rows); wrongly excluded ${m(acc.deal.wronglyExcludedValue)} (${acc.deal.wronglyExcludedRows} rows)`);
console.log(`Recurring flag agreement: ${pct(acc.recurring.pct)}`);
console.log('\nPer category (rows%, value%, precision):');
for (const p of acc.perCategory) if (p.truthRows) console.log(`  ${p.id.padEnd(20)} ${String(p.truthRows).padStart(7)}  ${pct(p.pct).padStart(6)}  ${pct(p.pctValue).padStart(6)}  ${pct(p.precision).padStart(6)}`);
console.log('\nTop leaks:');
for (const l of acc.deal.topLeaks.slice(0, 12)) console.log(`  ${m(l.amount).padStart(9)}  ${l.truthCat.padEnd(14)} → ${l.predicted.padEnd(16)} ${l.narrative}`);
// Biggest confusions
const conf: [number, string, string][] = [];
acc.confusion.counts.forEach((row, ti) => row.forEach((c, pi) => { if (c && acc.confusion.truth[ti] !== acc.confusion.predicted[pi]) conf.push([c, acc.confusion.truth[ti], acc.confusion.predicted[pi]]); }));
conf.sort((a, b) => b[0] - a[0]);
console.log('\nTop confusions:');
for (const [c, a, b] of conf.slice(0, 15)) console.log(`  ${String(c).padStart(6)}  ${a} → ${b}`);
console.log(`\nSeries detected: ${res.seriesList.length} (${res.seriesList.filter((s) => s.categoryIdx < 0).length} uncategorised)`);

if (args.includes('--examples')) {
  // Example narratives for the top confusions
  const fileIdx = new Map(ds0.truth.files.map((f, i) => [f.name, i]));
  const lineMaps = ds0.truth.files.map((f) => new Map(f.line.map((l, k) => [l, k])));
  const ex = new Map<string, string[]>();
  for (let i = 0; i < ds.n; i++) {
    const fi = fileIdx.get(ds.files[ds.file[i]].name)!;
    const k = lineMaps[fi].get(ds.line[i]);
    if (k === undefined) continue;
    const t = ds0.truth.categories[ds0.truth.files[fi].cat[k]];
    const p = res.cat[i] >= 0 ? res.catIds[res.cat[i]] : 'uncategorised';
    if (t === p) continue;
    const key = `${t} → ${p}`;
    const a = ex.get(key) ?? [];
    if (a.length < 4) a.push(`${ds.narratives[ds.narr[i]]}  [${ds.amount[i].toFixed(2)}] rule=${res.rule[i]}`);
    ex.set(key, a);
  }
  for (const [k, v] of ex) console.log(`\n${k}\n   ${v.join('\n   ')}`);
}

if (args.includes('--forecast')) {
  const { buildBasis } = await import('../src/lib/analysis/aggregates');
  const { runForecast, fmtMoney } = await import('../src/lib/forecast/engine');
  const { runBacktest, runRolling } = await import('../src/lib/forecast/backtest');
  const { isoFromDay, addMonths, fmtDay } = await import('../src/lib/dates');
  const cats = team?.categories ?? DEFAULT_CATEGORIES;
  t = performance.now();
  const basis = buildBasis(ds, res);
  lap('basis');
  const start = ds.maxDay + 1;
  const settings = { start: isoFromDay(start), end: isoFromDay(addMonths(start, 24) - 1), granularity: 'monthly' as const, openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 };
  let fc = runForecast({ basis, categories: cats, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 1.5e6 });
  lap('forecast');
  console.log(`\nForecast (${fc.ms.toFixed(1)} ms): ${fc.summary}`);
  for (const e of fc.explain.filter((e) => e.forecastTotal || e.historyAnnual)) console.log(`  ${e.id.padEnd(20)} ${e.method.padEnd(9)} g=${e.growthPct.toFixed(1).padStart(5)}%  hist12=${fmtMoney(e.historyAnnual).padStart(9)}  fc=${fmtMoney(e.forecastTotal).padStart(9)}  σ=${fmtMoney(e.sigmaMonthly)} ${e.distribution} ${e.series.length ? e.series.filter((s) => s.projected).length + ' series' : ''} ${e.clamps.length ? e.clamps.length + ' clamps' : ''}`);
  fc = runForecast({ basis, categories: cats, settings, assumptions: [{ id: 'a', kind: 'growth', categoryId: 'salaries', pct: 2, mode: 'annual_step' }], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 1.5e6 });
  console.log(`  With salaries +2%: low ${fmtMoney(fc.low.amount)} on ${fmtDay(fc.low.day)} (${fc.ms.toFixed(1)} ms)`);
  const cutoff = addMonths(ds.maxDay + 1, -24);
  const bt = runBacktest(ds, res, basis.agg, { cutoff, horizonMonths: 12, categories: cats, settings, includeActualOneOffs: false, fyStartMonth: 4 });
  console.log(`\nBacktest from ${fmtDay(cutoff)} (used data to ${fmtDay(bt.usedDataTo)}; ${bt.ms.toFixed(0)} ms)`);
  for (const e of bt.errorAt) console.log(`  ${e.months}m: error ${fmtMoney(e.error)} (core ${fmtMoney(e.coreError)}) vs gross flow ${fmtMoney(e.actualAbsFlow)}`);
  console.log(`  low forecast ${fmtMoney(bt.lowForecast.amount)} ${fmtDay(bt.lowForecast.day)}; actual ${fmtMoney(bt.lowActual.amount)} ${fmtDay(bt.lowActual.day)}`);
  for (const c of bt.categories.slice(0, 6)) console.log(`  ${c.id.padEnd(20)} err ${fmtMoney(c.error).padStart(9)}  mape ${c.mape === null ? '-' : (c.mape * 100).toFixed(0) + '%'}`);
  t = performance.now();
  const roll = runRolling(ds, res, basis.agg, { horizonMonths: 12, categories: cats, settings, includeActualOneOffs: false, fyStartMonth: 4 });
  lap(`rolling (${roll.cutoffs.length} runs)`);
  console.log('  MAE by month:', roll.maeByMonth.map((x) => fmtMoney(x)).join(' '));
  console.log('  core MAE    :', roll.coreMaeByMonth.map((x) => fmtMoney(x)).join(' '), ' gross/month', fmtMoney(roll.avgMonthlyGross));
}
if (args.includes('--register-debug')) {
  const fileIdx = new Map(ds0.truth.files.map((f, i) => [f.name, i]));
  const lineMaps = ds0.truth.files.map((f) => new Map(f.line.map((l, k) => [l, k])));
  let good = 0, bad = 0; const badEx: string[] = [];
  for (let i = 0; i < ds.n; i++) {
    if (res.rule[i] !== -9) continue;
    const fi = fileIdx.get(ds.files[ds.file[i]].name)!; const k = lineMaps[fi].get(ds.line[i]); if (k === undefined) continue;
    const tdeal = ds0.truth.files[fi].deal[k] === '1';
    if (tdeal) good++; else { bad++; if (badEx.length < 12) badEx.push(`${ds.narratives[ds.narr[i]]} ${ds.amount[i]} truth=${ds0.truth.categories[ds0.truth.files[fi].cat[k]]}`); }
  }
  console.log('register-matched rows: deal', good, 'non-deal', bad, 'interest check', res.registerMatch?.interest); console.log(badEx.join('\n'));
  console.log('unmatched sample', res.registerMatch?.unmatched.slice(0, 12).map((u) => `${new Date(u.day * 864e5).toISOString().slice(0, 10)} ${Math.round(u.amount)} ${u.label}`).join('\n'));
}
if (args.includes('--strategy')) {
  const { buildBasis } = await import('../src/lib/analysis/aggregates');
  const { runForecast, fmtMoney } = await import('../src/lib/forecast/engine');
  const { buildStrategy } = await import('../src/lib/forecast/strategy');
  const { liquidBalances } = await import('../src/lib/register/cashflows');
  const { defaultSettings } = await import('../src/state/store');
  const loaded = registerFromSnapshot(ds0.register);
  const ev = registerEvents(loaded.reg);
  const basis = buildBasis(ds, res);
  const settings = defaultSettings(basis);
  const liq = liquidBalances(loaded.reg);
  const pos = basis.agg;
  void pos;
  const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 1.5e6, register: { liquid: liq.total, events: ev.filter((e) => e.future) } });
  console.log(`\nWith register: liquid ${fmtMoney(liq.total)}, ${fc.register?.events} events net ${fmtMoney(fc.register?.net ?? 0)}; low ${fmtMoney(fc.low.amount)} ${new Date(fc.low.day * 864e5).toISOString().slice(0, 10)}; before-register low ${fmtMoney(Math.min(...fc.cumulativeBefore))}`);
  const st = buildStrategy(fc, { repayments: ev.filter((e) => e.future && e.kind === 'loan_repayment'), loboCalls: [], liquid: liq.total, debt: 0 });
  console.log(`shortfall ${fmtMoney(st.shortfall)} lasting ${fmtMoney(st.lasting)} short ${fmtMoney(st.shortTerm)}; ladder ${st.ladder.map((r) => `${r.months}m ${fmtMoney(r.amount)}`).join(' ')}`);
  for (const o of st.options) console.log(`- [${o.tone}] ${o.title}\n    ${o.body}`);
}
