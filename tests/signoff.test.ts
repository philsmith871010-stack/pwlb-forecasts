// Signing off forecasts and monitoring them: what a team does month after month. A forecast is
// signed off, statements keep arriving, the forecast moves on and is signed off again, and Home
// reports on the right one.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { runForecast } from '../src/lib/forecast/engine';
import { fromSession, basisFromHistory, historyBefore, type CashHistory } from '../src/lib/history/cashHistory';
import { isoFromDay, dayFromISO, dayFromYMD, addMonths } from '../src/lib/dates';
import { signForecast, compareSigned, rollForward, completeTo, monthEndIndex, trackSignOffs, fullMonthsLabel, activeSignOffs, withdrawals, MIN_COMPARE_DAYS, type SignOffChange } from '../src/lib/forecast/signoff';
import { emptyTeamFile, parseTeamFile, serialiseTeamFile, mergeTeamFiles } from '../src/lib/teamfile';
import type { Scenario } from '../src/lib/model';

const cfg = { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };
const ymd = (iso: string) => dayFromISO(iso);

describe('a forecast starts after the latest statement', () => {
  const settings = { start: '2024-10-01', end: '2026-09-30' };
  it('moves on when statements arrive after its start, keeping its length', () => {
    const r = rollForward(settings, ymd('2024-10-31'));
    expect(r).toEqual({ start: '2024-11-01', end: '2026-10-31' });
  });
  it('is left alone while its start is still ahead', () => {
    expect(rollForward(settings, ymd('2024-09-30'))).toBe(settings);
    expect(rollForward(settings, ymd('2024-08-31'))).toBe(settings);
  });
});

describe('month ends', () => {
  it('a month ending on a weekend is complete from its last working day', () => {
    // 30 Nov 2024 was a Saturday
    expect(completeTo(ymd('2024-11-29'))).toBe(ymd('2024-11-30'));
    expect(completeTo(ymd('2024-11-28'))).toBe(ymd('2024-11-28'));
    // Easter 2024: Good Friday 29 Mar, then the weekend
    expect(completeTo(ymd('2024-03-28'))).toBe(ymd('2024-03-31'));
    // a month's own last day stays as it is
    expect(completeTo(ymd('2024-10-31'))).toBe(ymd('2024-10-31'));
  });
  it('reads a comparison at that month end', () => {
    const cutoff = ymd('2024-11-01');
    expect(monthEndIndex({ cutoff, H: ymd('2024-11-29') - cutoff + 1 })).toBe(28);
    expect(monthEndIndex({ cutoff, H: ymd('2024-11-28') - cutoff + 1 })).toBeNull();
    // past a month end, the latest one inside
    expect(monthEndIndex({ cutoff, H: ymd('2024-12-10') - cutoff + 1 })).toBe(29);
  });
});

describe('signing off and monitoring, month after month', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'signoff' });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const full = fromSession(ds, categorise(ds, cfg));
  const catIds = DEFAULT_CATEGORIES.map((c) => c.id);
  // the team's history as it stood on a day: everything before it
  const asAt = (day: number): CashHistory => historyBefore(full, day);
  const firstOf = (y: number, m: number) => dayFromYMD(y, m, 1);
  // a year before the data ends (31 Mar), a month at a time
  const m0 = addMonths(firstOf(Number(isoFromDay(ds.maxDay).slice(0, 4)), 4), -12);
  const sc = (id: string, start: number): Scenario => ({
    id, name: id, updatedAt: '', assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [],
    settings: { start: isoFromDay(start), end: isoFromDay(addMonths(start, 24) - 1), granularity: 'monthly', openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 },
  });
  /** sign off scenario `s` against the history held on `day`, as the app does (start rolled to the latest statement) */
  const signAt = (s: Scenario, day: number, signedAt: string, note?: string) => {
    const h = asAt(day);
    const basis = basisFromHistory(h, catIds)!;
    const settings = rollForward(s.settings, basis.dataEnd);
    const fc = runForecast({ basis, categories: DEFAULT_CATEGORIES, settings, assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: 10e6, defaultOpening: 0 });
    return signForecast(fc, s, { id: `so_${signedAt}`, signedAt, signedBy: 'Test', note, knownItems: [] });
  };

  it('a forecast saved a month ago, signed off now, starts after the latest statement', () => {
    const base = sc('Base', m0); // made when the history ended the day before m0
    const rec = signAt(base, addMonths(m0, 1), '2024-01-01T10:00:00Z');
    // not from m0: that month has already happened
    expect(rec.start).toBe(isoFromDay(addMonths(m0, 1)));
    expect(rec.everyday.cum).toHaveLength(dayFromISO(rec.end) - dayFromISO(rec.start) + 1);
  });

  it('Home reports on the newest sign-off with a month of statements, or the one the team chose', () => {
    const base = sc('Base', m0);
    const a = signAt(base, m0, '2024-01-01T10:00:00Z', 'Budget');
    const b = signAt(base, addMonths(m0, 2), '2024-03-01T10:00:00Z', 'Refresh');
    // two months after the first, a week after the second
    const h = asAt(addMonths(m0, 2) + 7);
    const t = trackSignOffs([a, b], h, DEFAULT_CATEGORIES)!;
    expect(t.rec.id).toBe(a.id);
    expect(t.r).not.toBeNull();
    // the team chose the newer one: reported on, but it's too early to judge
    const chosen = trackSignOffs([a, b], h, DEFAULT_CATEGORIES, b.id)!;
    expect(chosen.rec.id).toBe(b.id);
    expect(chosen.r).toBeNull();
    // a month later the newer one has its own figures, and is newest: reported on either way
    const later = asAt(addMonths(m0, 3) + 7);
    expect(trackSignOffs([a, b], later, DEFAULT_CATEGORIES)!.rec.id).toBe(b.id);
    expect(trackSignOffs([a, b], later, DEFAULT_CATEGORIES, a.id)!.rec.id).toBe(a.id);
    // a choice that's no longer there falls back to the newest
    expect(trackSignOffs([a, b], later, DEFAULT_CATEGORIES, 'gone')!.rec.id).toBe(b.id);
    // nothing signed off, nothing to report
    expect(trackSignOffs([], later, DEFAULT_CATEGORIES)).toBeNull();
  });

  it('judges each sign-off over its own period, at the latest month end', () => {
    const base = sc('Base', m0);
    const a = signAt(base, m0, '2024-01-01T10:00:00Z');
    const b = signAt(base, addMonths(m0, 2), '2024-03-01T10:00:00Z');
    const h = asAt(addMonths(m0, 4));
    const ra = compareSigned(a, h, DEFAULT_CATEGORIES)!, rb = compareSigned(b, h, DEFAULT_CATEGORIES)!;
    expect(ra.cutoff).toBe(m0);
    expect(rb.cutoff).toBe(addMonths(m0, 2));
    expect(ra.H - rb.H).toBe(addMonths(m0, 2) - m0);
    // complete months only: four for the first, two for the second
    expect(ra.monthly.labels).toHaveLength(4);
    expect(rb.monthly.labels).toHaveLength(2);
    expect(fullMonthsLabel(rb)).toMatch(/ to /);
    // the actuals over the overlap are the same days, so they move the same way
    const off = rb.cutoff - ra.cutoff, end = rb.H - 1;
    expect(ra.actualCum[off + end] - ra.actualCum[off - 1]).toBeCloseTo(rb.actualCum[end], 0);
    expect(rb.H).toBeGreaterThanOrEqual(MIN_COMPARE_DAYS);
  });

  it('keeps what the team wrote when signing off', () => {
    const rec = signAt(sc('Base', m0), m0, '2024-01-01T10:00:00Z', 'Budget 2024/25, agreed with the s151 officer');
    expect(rec.note).toBe('Budget 2024/25, agreed with the s151 officer');
  });

  it('a sign-off made by mistake can be withdrawn, and restored, without being deleted', () => {
    const base = sc('Base', m0);
    const a = signAt(base, m0, '2024-01-01T10:00:00Z', 'Budget');
    const b = signAt(base, addMonths(m0, 2), '2024-03-01T10:00:00Z', 'Signed off by mistake');
    const w: SignOffChange = { id: b.id, action: 'withdraw', at: '2024-03-02T09:00:00Z', by: 'Alex', reason: 'by mistake' };
    expect(activeSignOffs([a, b], [w]).map((x) => x.id)).toEqual([a.id]);
    expect(withdrawals([w]).get(b.id)?.reason).toBe('by mistake');
    // Home no longer reports on it, even when the team had chosen it
    const h = asAt(addMonths(m0, 3) + 7);
    expect(trackSignOffs(activeSignOffs([a, b], [w]), h, DEFAULT_CATEGORIES, b.id)!.rec.id).toBe(a.id);
    // the latest change decides, whatever order the log is in
    const r: SignOffChange = { id: b.id, action: 'restore', at: '2024-03-05T09:00:00Z', by: 'Sam' };
    expect(activeSignOffs([a, b], [r, w]).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(withdrawals([w, r]).size).toBe(0);
  });

  it('a withdrawal survives saving, and merging with a copy that never had it', () => {
    const base = sc('Base', m0);
    const a = signAt(base, m0, '2024-01-01T10:00:00Z');
    const b = signAt(base, addMonths(m0, 2), '2024-03-01T10:00:00Z');
    const w: SignOffChange = { id: b.id, action: 'withdraw', at: '2024-03-02T09:00:00Z', by: 'Alex' };
    const mine = { ...emptyTeamFile('X'), signedOff: [a, b], signOffChanges: [w] };
    const back = parseTeamFile(serialiseTeamFile(mine, 'me', 'test').json).team!;
    expect(back.signOffChanges).toEqual([w]);
    // a colleague's older copy still has the sign-off, not withdrawn: it stays withdrawn
    const theirs = { ...emptyTeamFile('X'), signedOff: [a, b] };
    const m1 = mergeTeamFiles(theirs, mine).merged;
    expect(activeSignOffs(m1.signedOff, m1.signOffChanges).map((x) => x.id)).toEqual([a.id]);
    // and a restore made in one copy wins over the earlier withdrawal in the other
    const r: SignOffChange = { id: b.id, action: 'restore', at: '2024-03-05T09:00:00Z', by: 'Sam' };
    const m2 = mergeTeamFiles(mine, { ...mine, signOffChanges: [w, r] }).merged;
    expect(m2.signOffChanges).toHaveLength(2);
    expect(activeSignOffs(m2.signedOff, m2.signOffChanges)).toHaveLength(2);
    // a log entry that isn't one is dropped on reading
    const junk = parseTeamFile(JSON.stringify({ ...JSON.parse(serialiseTeamFile(mine, 'me', 'test').json), signOffChanges: [w, { id: 1 }, { id: 'x', action: 'delete', at: 'z' }] })).team!;
    expect(junk.signOffChanges).toEqual([w]);
  });
});
