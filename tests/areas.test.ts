// The main menu: which areas are open, what state each is in, and what to do next, as a council
// goes from nothing to a signed-off forecast being monitored.
import { describe, it, expect } from 'vitest';
import { computeAreas, type AreaInput } from '../src/lib/areas';
import type { CashHistory } from '../src/lib/history/cashHistory';
import type { Scenario } from '../src/lib/model';
import type { SignedForecast, Tracking } from '../src/lib/forecast/signoff';
import { dayFromISO, isoFromDay } from '../src/lib/dates';

const D = dayFromISO;
const history = (from: string, to: string): CashHistory => ({
  v: 1, updatedAt: '', cats: [], cells: [[]], series: [],
  accounts: [{ key: '1', ranges: [[D(from), D(to)]], opening: null, openingDay: null, closing: null, closingDay: null }],
});
const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
  id: 'fc1', name: 'Base', updatedAt: '', assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [],
  settings: { start: '2026-04-01', end: '2028-03-31', granularity: 'monthly', openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 },
  ...patch,
});
const signed = (start: string): SignedForecast => ({
  v: 1, id: `so_${start}`, scenarioId: 'fc1', scenarioName: 'Base', signedAt: '2026-04-01T10:00:00Z', signedBy: 'Alex', start, end: '2028-03-31',
  borrowingNeed: 14e6, low: -4e6, lowDay: '2027-04-30', buffer: 10e6, opening: 0, knownItems: [], everyday: { cum: [], lower: [], upper: [] }, cats: [],
});
const base: AreaInput = { history: null, expected: D('2026-03-31'), forecasts: [], rules: [], active: [], tracking: null };
const run = (patch: Partial<AreaInput>) => {
  const r = computeAreas({ ...base, ...patch });
  return { ...r, by: Object.fromEntries(r.areas.map((a) => [a.id, a])) };
};

describe('main menu', () => {
  it('a new council starts at Set up and train, with everything else locked and saying why', () => {
    const r = run({});
    expect(r.areas.map((a) => a.id)).toEqual(['setup', 'review', 'today', 'forecast', 'monitor']);
    expect(r.by.setup).toMatchObject({ locked: null, tone: 'action', status: 'Not started' });
    for (const id of ['review', 'today', 'forecast', 'monitor']) {
      expect(r.by[id].tone).toBe('locked');
      expect(r.by[id].locked).toMatch(/Set up and train/);
    }
    expect(r.next).toBe('setup');
  });

  it('a few weeks of history opens past days only', () => {
    const r = run({ history: history('2026-03-01', '2026-03-31') });
    expect(r.by.setup.tone).toBe('action');
    expect(r.by.review).toMatchObject({ locked: null, entry: 'pastday', status: 'Past days only for now' });
    expect(r.by.today.locked).toMatch(/six months/);
    expect(r.by.forecast.locked).toMatch(/six months/);
    expect(r.next).toBe('setup');
  });

  it('with years of history up to date, the forecast is next and Monitor waits for a sign-off', () => {
    const r = run({ history: history('2021-04-01', '2026-03-31') });
    expect(r.by.setup.tone).toBe('done');
    expect(r.by.review).toMatchObject({ tone: 'ready', entry: 'history' });
    expect(r.by.today).toMatchObject({ tone: 'done', status: 'Up to date' });
    expect(r.by.forecast).toMatchObject({ tone: 'action', status: 'Not built yet' });
    expect(r.by.monitor.locked).toMatch(/signed-off forecast/);
    expect(r.next).toBe('forecast');
  });

  it('falling behind: Daily has statements to add; well behind, catching up comes first', () => {
    const h = history('2021-04-01', '2026-03-20');
    const r = run({ history: h, expected: D('2026-03-27') });
    expect(r.by.today).toMatchObject({ tone: 'action', status: 'Statements from 21 Mar 2026 to add' });
    expect(r.by.setup.tone).toBe('done');
    const far = run({ history: h, expected: D('2026-05-29') });
    expect(far.by.setup).toMatchObject({ tone: 'action', status: 'History stops at 20 Mar 2026' });
    expect(far.next).toBe('setup');
  });

  it('the forecast: checked, then signed off, then needing a fresh look as months pass', () => {
    const h = history('2021-04-01', '2026-03-31');
    const checked = scenario({ reviewDone: true, reviewFor: '2026-03-31' });
    expect(run({ history: h, forecasts: [checked] }).by.forecast.status).toBe('Checked, not signed off');
    const so = signed(isoFromDay(D('2026-03-31') + 1));
    const r = run({ history: h, forecasts: [checked], active: [so], tracking: { rec: so, r: null } });
    expect(r.by.forecast).toMatchObject({ tone: 'done', status: '“Base” signed off' });
    expect(r.by.monitor).toMatchObject({ locked: null, tone: 'waiting', status: 'First judged at the end of Apr 2026' });
    // a day's statement later, it still counts as signed off: no daily re-sign-off
    const dayOn = run({ history: history('2021-04-01', '2026-04-01'), expected: D('2026-04-01'), forecasts: [checked], active: [so], tracking: { rec: so, r: null } });
    expect(dayOn.by.forecast).toMatchObject({ tone: 'done', status: '“Base” signed off' });
    expect(dayOn.by.forecast.detail).toMatch(/Sign off again within a month/);
    // two months on: the lines' checks no longer hold, and the sign-off is of an earlier start
    const later = run({ history: history('2021-04-01', '2026-05-29'), expected: D('2026-05-29'), forecasts: [checked], active: [so], tracking: { rec: so, r: null } });
    expect(later.by.forecast).toMatchObject({ tone: 'action', status: 'Lines to check again' });
    expect(later.next).toBe('forecast');
  });

  it('once a sign-off has a month of statements, Monitor says how it’s doing', () => {
    const h = history('2021-04-01', '2026-05-29');
    const so = signed('2026-04-01');
    const tracking = { rec: so, r: {} as NonNullable<Extract<Tracking, { r: object }>['r']>, gap: 7.4e6, asOf: D('2026-04-30'), soFar: false, timing: 3.4e6 } as Tracking;
    const r = run({ history: h, expected: D('2026-05-29'), active: [so], tracking, forecasts: [scenario({ reviewDone: true, reviewFor: '2026-05-29' })] });
    expect(r.by.monitor).toMatchObject({ tone: 'ready', status: '£7.4m ahead of “Base”' });
    expect(r.by.monitor.detail).toBe('At the end of Apr 2026, £3.4m of it timing');
  });

  it('exceptions to check put Daily first among its jobs, opening on them', () => {
    const r = run({ history: history('2021-04-01', '2026-03-31'), exceptionsOpen: 3 });
    expect(r.by.today).toMatchObject({ tone: 'action', status: '3 exceptions to check', entry: 'exceptions' });
    expect(r.by.today.detail).toMatch(/Up to date/);
  });
});
