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
