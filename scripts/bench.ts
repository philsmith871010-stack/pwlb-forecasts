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
const res = categorise(ds, {
  categories: team?.categories ?? DEFAULT_CATEGORIES,
  rules: team?.rules ?? [],
  aliases: team?.aliases ?? [],
  seriesOverrides: team?.seriesOverrides ?? [],
  txnOverrides: team?.txnOverrides ?? [],
  useStarterRules: true,
});
lap('categorise');
console.log('  stage ms', JSON.stringify(res.ms));
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
