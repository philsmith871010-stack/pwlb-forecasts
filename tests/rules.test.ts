// Sorting rules people can see, change, delete and add: what a rule matches, and that a team rule
// sorts lines its way, ahead of the built-in rules.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise, ruleMatcher, ruleProblem } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import type { Rule } from '../src/lib/model';

const rule = (p: Partial<Rule>): Rule => ({ id: 'r1', type: 'contains', pattern: 'DWP HB', categoryId: 'grants_general', source: 'team', ...p });

describe('sorting rules', () => {
  it('matches the description, ignoring case, with its conditions on the amount', () => {
    const m = ruleMatcher(rule({ direction: 'in', minAmount: 1e6 }));
    expect(m('DWP HB SUBSIDY', 3.4e6)).toBe(true);
    expect(m('dwp hb subsidy'.toUpperCase(), 3.4e6)).toBe(true);
    expect(m('DWP HB SUBSIDY', -3.4e6)).toBe(false); // money out
    expect(m('DWP HB SUBSIDY', 5e5)).toBe(false); // too small
    expect(ruleMatcher(rule({ type: 'alias', pattern: 'dwp hb' }))('DWP HB SUBSIDY', 1)).toBe(false);
    expect(ruleMatcher(rule({ type: 'regex', pattern: '^DWP .* SUBSIDY$' }))('DWP HB SUBSIDY', 1)).toBe(true);
  });
  it('says what is wrong with a rule that cannot be used', () => {
    expect(ruleProblem({ type: 'contains', pattern: '  ' })).toMatch(/words/);
    expect(ruleProblem({ type: 'regex', pattern: '(' })).toMatch(/isn’t valid/);
    expect(ruleProblem({ type: 'contains', pattern: 'PWLB' })).toBeNull();
  });
  it('a team rule sorts its lines its way, ahead of the built-in rules; deleting it puts them back', async () => {
    const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'rules', years: 2, nastiness: 0 });
    const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
    const cfg = { categories: DEFAULT_CATEGORIES, rules: [] as Rule[], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };
    const before = categorise(ds, cfg);
    // the council tax lines, sorted as other receipts instead
    const ct = before.catIds.indexOf('council_tax'), other = before.catIds.indexOf('other_receipts');
    const sigOf = (i: number) => before.signatures[before.sig[i]];
    const i0 = Array.from(before.cat).findIndex((c) => c === ct);
    const word = sigOf(i0).split(' ')[0];
    const after = categorise(ds, { ...cfg, rules: [rule({ pattern: word, categoryId: 'other_receipts', direction: 'any' })] });
    expect(after.cat[i0]).toBe(other);
    expect(categorise(ds, cfg).cat[i0]).toBe(ct);
  });
});
