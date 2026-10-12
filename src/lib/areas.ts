// The five areas' state, worked out from what the council has so far: whether each is open yet
// (and if not, what it's waiting for), what state it's in, and which one to do next. Pure, so the
// main menu, each area's header and the tests all get the same answer (see ui/areas for the hook).
import { historySpan, historyDays, MIN_HISTORY_DAYS, type CashHistory } from './history/cashHistory';
import type { Scenario, Rule } from './model';
import { firstFairMonthEnd, aheadWords, asOfWords, type SignedForecast, type Tracking } from './forecast/signoff';
import { day, money } from './format';
import { isoFromDay, dayFromISO, ymdFromDay, MONTH_NAMES } from './dates';

/** the areas, in the order they depend on each other (as on the main menu) */
export type AreaId = 'setup' | 'review' | 'today' | 'forecast' | 'monitor';
export type StepRef = 'load' | 'history' | 'pastday' | 'today' | 'forecast' | 'monitor';
const ORDER: AreaId[] = ['setup', 'review', 'today', 'forecast', 'monitor'];

const monthOf = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };
/** More than this many days behind, catching up is a job for Set up and train, not Daily. */
export const CATCH_UP_DAYS = 14;
/** The lines' checks hold while the history has grown by no more than this (as on Check each line). */
const CHECKS_HOLD_DAYS = 31;

/** done: nothing to do; action: something to do here; waiting: on new statements; ready: open, nothing pending; locked: not yet */
export type Tone = 'done' | 'action' | 'waiting' | 'ready' | 'locked';
export interface AreaState {
  id: AreaId;
  /** why it can't be opened yet, or null */
  locked: string | null;
  tone: Tone;
  /** the state in a few words */
  status: string;
  /** one more line: what's there, or what to do */
  detail: string;
  /** the step it opens on */
  entry: StepRef;
}

export interface AreaInput {
  history: CashHistory | null | undefined;
  /** the day statements are expected up to (yesterday's working day, or the example's last day) */
  expected: number;
  forecasts: Scenario[];
  rules: Rule[];
  /** sign-offs that count (withdrawn ones left out) */
  active: SignedForecast[];
  tracking: Tracking | null;
}

/** Each area's lock and state, and the one to do next, from what the council has so far. */
export function computeAreas({ history: h, expected, forecasts, rules: allRules, active, tracking: tr }: AreaInput): { areas: AreaState[]; next: AreaId } {
  const span = h ? historySpan(h) : null;
  const days = historyDays(h);
  const years = Math.round((days / 365.25) * 2) / 2;
  const enough = days >= MIN_HISTORY_DAYS;
  const behind = span ? Math.max(0, expected - span.to) : 0;
  const upToDate = !!span && behind === 0;
  const NEED_HISTORY = 'Needs at least six months of bank history first: load it under Set up and train.';

  // ---- Set up and train
  const rules = allRules.filter((r) => r.source !== 'starter').length;
  const setup: AreaState = !span
    ? { id: 'setup', locked: null, tone: 'action', status: 'Not started', detail: 'Start here: load three to five years of bank statements.', entry: 'load' }
    : !enough
      ? { id: 'setup', locked: null, tone: 'action', status: `${days} day${days === 1 ? '' : 's'} of history`, detail: 'Add earlier statements: at least six months is needed, three to five years is best.', entry: 'load' }
      : behind > CATCH_UP_DAYS
        ? { id: 'setup', locked: null, tone: 'action', status: `History stops at ${day(span.to)}`, detail: `${behind} days behind: add the statements since then.`, entry: 'load' }
        : { id: 'setup', locked: null, tone: 'done', status: `${years.toLocaleString('en-GB')} years of history`, detail: `${monthOf(span.from)} to ${day(span.to)}${rules ? ` · ${rules} sorting rule${rules === 1 ? '' : 's'} learned` : ''}`, entry: 'load' };

  // ---- Review history
  const review: AreaState = !span
    ? { id: 'review', locked: 'Needs your bank history first: load it under Set up and train.', tone: 'locked', status: 'Locked', detail: '', entry: 'history' }
    : { id: 'review', locked: null, tone: 'ready', status: enough ? `${years.toLocaleString('en-GB')} years to look back on` : 'Past days only for now', detail: enough ? `Any day from ${day(span.from)} to ${day(span.to)}` : 'Look back opens with six months of history.', entry: enough ? 'history' : 'pastday' };

  // ---- Daily
  const today: AreaState = !enough
    ? { id: 'today', locked: NEED_HISTORY, tone: 'locked', status: 'Locked', detail: '', entry: 'today' }
    : upToDate
      ? { id: 'today', locked: null, tone: 'done', status: 'Up to date', detail: `Latest statement ${day(span!.to)}`, entry: 'today' }
      : { id: 'today', locked: null, tone: 'action', status: `Statements from ${day(span!.to + 1)} to add`, detail: behind > CATCH_UP_DAYS ? 'More than two weeks behind: catching up is quicker under Set up and train.' : `Latest statement ${day(span!.to)}`, entry: 'today' };

  // ---- Forecast
  const fcs = forecasts;
  const start = span ? isoFromDay(span.to + 1) : '';
  // a sign-off of the forecast as it now starts (the day after the latest statement)
  const signedNow = active.filter((x) => x.start === start).sort((a, z) => z.signedAt.localeCompare(a.signedAt))[0];
  const lastSigned = [...active].filter((x) => !x.id.startsWith('so_example_')).sort((a, z) => z.signedAt.localeCompare(a.signedAt))[0];
  const checked = fcs.filter((f) => f.reviewDone && f.reviewFor && span && span.to - dayFromISO(f.reviewFor) <= CHECKS_HOLD_DAYS && span.to >= dayFromISO(f.reviewFor));
  const forecast: AreaState = !enough
    ? { id: 'forecast', locked: NEED_HISTORY, tone: 'locked', status: 'Locked', detail: '', entry: 'forecast' }
    : signedNow
      ? { id: 'forecast', locked: null, tone: 'done', status: `“${signedNow.scenarioName}” signed off`, detail: `${day(dayFromISO(signedNow.signedAt.slice(0, 10)))} by ${signedNow.signedBy}: may need to borrow ${money(signedNow.borrowingNeed)}`, entry: 'forecast' }
      : checked.length
        ? { id: 'forecast', locked: null, tone: 'action', status: 'Checked, not signed off', detail: lastSigned ? `New statements since “${lastSigned.scenarioName}” was signed off: sign off again to monitor the latest.` : `“${checked[0].name}” is ready: see it and sign it off.`, entry: 'forecast' }
        : fcs.some((f) => f.reviewDone)
          ? { id: 'forecast', locked: null, tone: 'action', status: 'Lines to check again', detail: 'Enough new statements have come in that each line needs a quick look before signing off.', entry: 'forecast' }
          : { id: 'forecast', locked: null, tone: 'action', status: 'Not built yet', detail: 'Check each line we propose, add what you know, then sign it off.', entry: 'forecast' };

  // ---- Monitor
  const monitor: AreaState = !enough
    ? { id: 'monitor', locked: NEED_HISTORY, tone: 'locked', status: 'Locked', detail: '', entry: 'monitor' }
    : !active.length || !tr
      ? { id: 'monitor', locked: 'Needs a signed-off forecast: sign one off under Forecast.', tone: 'locked', status: 'Locked', detail: '', entry: 'monitor' }
      : tr.r
        ? { id: 'monitor', locked: null, tone: 'ready', status: `${aheadWords(tr.gap, money).replace(/^./, (c) => c.toUpperCase())} “${tr.rec.scenarioName}”`, detail: `${asOfWords(tr).replace(/^./, (c) => c.toUpperCase())}${Math.abs(tr.timing) >= 0.1e6 ? `, ${money(Math.abs(tr.timing))} of it timing` : ''}`, entry: 'monitor' }
        : { id: 'monitor', locked: null, tone: 'waiting', status: `First judged at the end of ${monthOf(firstFairMonthEnd(dayFromISO(tr.rec.start)))}`, detail: `“${tr.rec.scenarioName}” is compared as statements from ${day(dayFromISO(tr.rec.start))} come in.`, entry: 'monitor' };

  const byId: Record<AreaId, AreaState> = { setup, review, today, forecast, monitor };
  const areas = ORDER.map((id) => byId[id]);
  // what to do next: the first job in the order they depend on each other that wants something
  const next: AreaId = (['setup', 'forecast', 'today'] as AreaId[]).find((id) => byId[id].tone === 'action') ?? (monitor.locked ? 'forecast' : 'monitor');
  return { areas, next };
}
