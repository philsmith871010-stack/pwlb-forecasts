// Usage: npm run generate -- [--preset small|large|brutal] [--seed northbridge] [--years 5]
//        [--start 2021] [--accounts 4] [--nastiness 1] [--out data/small]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS, VolumePreset, VOLUME_PRESETS } from '../src/generator';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

const preset = (arg('preset') ?? 'small') as VolumePreset;
if (!VOLUME_PRESETS[preset]) throw new Error(`Unknown preset ${preset}`);
const opts = {
  ...DEFAULT_GENERATOR_OPTIONS,
  preset,
  seed: arg('seed') ?? DEFAULT_GENERATOR_OPTIONS.seed,
  years: Number(arg('years') ?? DEFAULT_GENERATOR_OPTIONS.years),
  startFY: Number(arg('start') ?? DEFAULT_GENERATOR_OPTIONS.startFY),
  accounts: Number(arg('accounts') ?? DEFAULT_GENERATOR_OPTIONS.accounts),
  nastiness: Number(arg('nastiness') ?? DEFAULT_GENERATOR_OPTIONS.nastiness),
};
const outDir = arg('out') ?? join('data', preset);

const t0 = Date.now();
const ds = generateDataset(opts);
mkdirSync(outDir, { recursive: true });
for (const f of ds.files) writeFileSync(join(outDir, f.name), f.text);
writeFileSync(join(outDir, 'truth.json'), JSON.stringify(ds.truth));
console.log(`Generated ${ds.stats.rows.toLocaleString()} rows in ${ds.stats.files} files (${ds.stats.startISO} → ${ds.stats.endISO}) in ${Date.now() - t0}ms → ${outDir}`);
for (const f of ds.files) console.log(`  ${f.name}  ${(f.text.length / 1e6).toFixed(1)} MB`);
