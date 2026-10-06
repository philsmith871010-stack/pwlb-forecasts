import { describe, it, expect } from 'vitest';
import { emptyTeamFile, parseTeamFile, serialiseTeamFile, mergeTeamFiles } from '../src/lib/teamfile';
import type { Rule, Scenario } from '../src/lib/model';

const rule = (id: string, pattern: string, categoryId = 'mmf'): Rule => ({ id, type: 'contains', pattern, categoryId, dealFlag: 'deal' });
const scenario = (id: string, name: string): Scenario => ({
  id, name, updatedAt: '2026-01-01T00:00:00Z',
  settings: { start: '2026-04-01', end: '2027-03-31', granularity: 'monthly', openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 },
  assumptions: [{ id: 'a1', kind: 'growth', categoryId: 'salaries', pct: 2, mode: 'annual_step' }], oneOffs: [], pastedSchedules: [], treasurySchedule: [],
});

describe('team file', () => {
  it('round-trips rules, profiles and forecasts, and never contains transactions', () => {
    const t = emptyTeamFile('Test Council');
    t.rules.push(rule('r1', 'ALBION CASH'));
    t.forecasts.push(scenario('f1', 'Base'));
    t.bankProfiles.push({ id: 'b1', name: 'Main', headerSignature: ',|date|amount', mapping: {} as never });
    const { json } = serialiseTeamFile(t, 'PS', 'test');
    const back = parseTeamFile(json);
    expect(back.ok).toBe(true);
    expect(back.team!.rules.map((r) => r.pattern)).toEqual(['ALBION CASH']);
    expect(back.team!.forecasts[0].assumptions[0]).toMatchObject({ kind: 'growth', pct: 2 });
    expect(back.team!.bankProfiles[0].name).toBe('Main');
    expect(back.team!.savedBy).toBe('PS');
    expect(json).not.toMatch(/narrative/i);
  });

  it('rejects garbage and tolerates missing fields', () => {
    expect(parseTeamFile('not json').ok).toBe(false);
    const r = parseTeamFile('{"authorityName":"X"}');
    expect(r.ok).toBe(true);
    expect(r.team!.categories.length).toBeGreaterThan(10);
  });

  it('merges two diverging copies without losing rules', () => {
    const base = emptyTeamFile('C');
    base.rules = [rule('r0', 'PWLB')];
    const a = structuredClone(base), b = structuredClone(base);
    a.rules.push(rule('ra', 'ALBION CASH'));
    a.forecasts.push(scenario('fa', 'Mine'));
    b.rules.push(rule('rb', 'MERCIA LIQ'));
    b.forecasts.push(scenario('fb', 'Theirs'));
    b.aliases.push({ canonical: 'PWLB', variants: ['P W L B'] });
    const m = mergeTeamFiles(a, b);
    expect(m.merged.rules.map((r) => r.id).sort()).toEqual(['r0', 'ra', 'rb']);
    expect(m.merged.forecasts.map((f) => f.name).sort()).toEqual(['Mine', 'Theirs']);
    expect(m.merged.aliases).toHaveLength(1);
    expect(m.conflicts).toHaveLength(0);
  });

  it('reports a genuine conflict when the same rule was edited in both copies', () => {
    const a = emptyTeamFile(), b = emptyTeamFile();
    a.rules = [rule('r1', 'ALBION', 'mmf')];
    b.rules = [rule('r1', 'ALBION', 'bank_deposits')];
    const m = mergeTeamFiles(a, b);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0].kind).toBe('rule');
  });
});
