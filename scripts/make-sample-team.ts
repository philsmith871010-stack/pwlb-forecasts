// Builds data/sample-team-file.json: starter categories, a few learned rules and aliases,
// bank profiles for the five demo dialects, and a saved "Base" forecast with its results
// snapshot and a history summary — so it can be opened and viewed without any CSV.
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { buildBasis } from '../src/lib/analysis/aggregates';
import { positions } from '../src/lib/analysis/history';
import { runForecast } from '../src/lib/forecast/engine';
import { buildHistorySummary, buildResultsSnapshot } from '../src/lib/analysis/snapshot';
import { emptyTeamFile, serialiseTeamFile } from '../src/lib/teamfile';
import { isoFromDay, addMonths } from '../src/lib/dates';
import type { Rule, Scenario } from '../src/lib/model';

const team = emptyTeamFile('Northbridge Council (demo)');
const now = new Date().toISOString();
const rule = (id: string, type: Rule['type'], pattern: string, categoryId: string, extra: Partial<Rule> = {}): Rule =>
  ({ id, type, pattern, categoryId, dealFlag: ['mmf', 'pwlb', 'la_loans', 'dmadf', 'bank_deposits', 'lobo', 'treasury_interest'].includes(categoryId) ? 'deal' : 'not_deal', createdBy: 'demo', createdAt: now, ...extra });
team.rules = [
  rule('rule_demo_albion', 'alias', 'ALBION CASH', 'mmf', { note: 'Albion Cash Reserves Fund — the bank shortens the fund name' }),
  rule('rule_demo_nndr_trunc', 'regex', '\\bNND?$', 'business_rates', { direction: 'in', note: 'NNDR truncated by the 30-character export' }),
  rule('rule_demo_harbour', 'contains', 'HARBOUR POINT SHOPPING', 'business_rates', { direction: 'in' }),
  rule('rule_demo_recharge', 'contains', 'BOROUGH COUNCIL', 'other_payments', { direction: 'out', maxAmount: 999_999, note: 'Shared-service recharges to neighbours are under £1m; loans are larger and round' }),
];
team.aliases = [{ canonical: 'PWLB', variants: ['P W L B', 'PUBLIC WORKS LOAN BOARD', 'PUBLIC WORKS LOAN'] }];

const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, preset: 'small' });
const names: Record<string, string> = { A: 'General account — debit/credit export', B: 'Collection account export', C: 'Payroll account export', D: 'Schools account statement', E: 'General account — ERP export' };
team.bankProfiles = g.files.map((f, i) => {
  const rep = detectMapping(f.text.slice(0, 96000), f.name);
  const dialect = g.truth.files[i].dialect;
  return { id: `bank_demo_${dialect}`, name: names[dialect], headerSignature: rep.headerSignature, mapping: { ...rep.mapping, defaultAccount: rep.mapping.account >= 0 ? '' : rep.mapping.defaultAccount }, createdAt: now };
});

const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
const res = categorise(ds, { categories: team.categories, rules: team.rules, aliases: team.aliases, seriesOverrides: [], txnOverrides: [], useStarterRules: true });
const basis = buildBasis(ds, res);
const pos = positions(basis.agg);
const start = ds.maxDay + 1;
const sc: Scenario = {
  id: 'fc_demo_base', name: 'Base', createdBy: 'demo', updatedAt: now,
  settings: { start: isoFromDay(start), end: isoFromDay(addMonths(start, 24) - 1), granularity: 'monthly', openingPosition: null, openingMode: 'bank', lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 },
  assumptions: [
    { id: 'as_demo_pay', kind: 'growth', categoryId: 'salaries', pct: 3, mode: 'annual_step', note: 'Pay award assumption' },
    { id: 'as_demo_ct', kind: 'growth', categoryId: 'council_tax', pct: 4.99, mode: 'annual_step', note: 'Council tax referendum limit' },
  ],
  oneOffs: [{ id: 'oo_demo_land', date: isoFromDay(addMonths(start, 7)), amount: 6_500_000, categoryId: 'capital_receipts', description: 'Land sale — former depot', confidence: 'likely' }],
  pastedSchedules: [], treasurySchedule: [],
};
const fc = runForecast({ basis, categories: team.categories, settings: sc.settings, assumptions: sc.assumptions, oneOffs: sc.oneOffs, pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: team.settings.liquidityBuffer, defaultOpening: pos.actual[pos.actual.length - 1] });
sc.resultsSnapshot = buildResultsSnapshot(fc);
team.forecasts = [sc];
team.historySummary = buildHistorySummary(basis.agg);
const { json } = serialiseTeamFile(team, 'demo', 'Sample team file with starter rules, demo bank profiles and a Base forecast');
mkdirSync('data', { recursive: true });
writeFileSync('data/sample-team-file.json', json);
console.log(`Wrote data/sample-team-file.json (${(json.length / 1024).toFixed(0)} KB): ${team.rules.length} rules, ${team.bankProfiles.length} profiles; Base low ${Math.round(fc.low.amount / 1e5) / 10}m`);
