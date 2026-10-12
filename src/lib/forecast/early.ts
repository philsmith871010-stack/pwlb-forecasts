// Money that arrives (or goes out) before the forecast expected it. Once it's in the statements it
// is part of the cash so far, so the forecast must not count it again on its due date.
//
// Two kinds are matched mechanically:
//  - a regular payment seen twice in one period, the second well before the next due date: the
//    next one, early (December's grant on 28 November);
//  - an item added by hand, still dated ahead, whose amount has already arrived in its category.
// The user confirms each: "early" takes the due payment out of the forecast, "extra" leaves it in.
// Either answer is kept on the scenario (`arrivals`), so it's asked once.
//
// And the mirror image: a regular payment whose due date has passed with nothing in the statements.
// Left alone, the forecast stops expecting it. The user says whether it's late (still coming: the
// forecast keeps it, from the date they expect it) or not coming (it's left out).
import type { ForecastBasis } from '../analysis/aggregates';
import { projectDates, lateArrivedOn, type ForecastResult } from './engine';
import type { OneOff } from '../model';
import { type Day, isoFromDay, dayFromISO, nextBusinessDay } from '../dates';
import { K_ONEOFF, type CashHistory } from '../history/cashHistory';

/**
 * A confirmed answer. Early: this money arrived on `day` for the payment due on `due`. Late: the
 * payment due on `due` hasn't come and is now expected on `day`. Missed: it isn't coming.
 */
export interface Arrival {
  /** what was asked about (see `EarlyCandidate.key`) */
  key: string;
  kind: 'series' | 'oneoff';
  categoryId: string;
  signature?: string;
  oneOffId?: string;
  /** ISO dates: when it arrived, and when the forecast expected it */
  day: string;
  due: string;
  amount: number;
  /** early: take the due payment out of the forecast; extra: it was something else, leave it in;
   *  late: still coming, expected on `day`; missed: not coming */
  answer: 'early' | 'extra' | 'late' | 'missed';
  at: string;
  by: string;
}

export interface EarlyCandidate {
  key: string;
  kind: 'series' | 'oneoff';
  categoryId: string;
  signature?: string;
  oneOffId?: string;
  /** who or what, for people */
  label: string;
  day: Day;
  due: Day;
  /** what arrived, and what the forecast expects on the due date (signed) */
  amount: number;
  expected: number;
}

const INTERVAL: Record<string, number> = { monthly: 30.44, quarterly: 91.3, half_yearly: 182.6, annual: 365.25 };
/** at least this many days ahead of its due date to count as early (a payday on a Friday isn't) */
const MIN_EARLY = 5;
/** hand-added items smaller than this aren't matched: too many day totals would look like them */
const MIN_ONEOFF = 100_000;

/** Money in the statements between `from` and `to` that looks like a payment the forecast still expects later. */
export function findEarly(basis: ForecastBasis, fc: ForecastResult, sc: { oneOffs: OneOff[]; arrivals?: Arrival[] }, from: Day, to: Day): EarlyCandidate[] {
  const asked = new Set((sc.arrivals ?? []).map((a) => a.key));
  const out: EarlyCandidate[] = [];
  const { agg } = basis;

  // regular payments
  for (const e of fc.explain) {
    for (const s of e.series) {
      const I = INTERVAL[s.cadence];
      if (!I || s.next === null || !s.active) continue;
      const b = basis.series.find((x) => x.signature === s.signature && x.catIdx === e.catIdx);
      if (!b || b.days.length < 3) continue;
      const n = b.days.length, last = b.days[n - 1], prev = b.days[n - 2], amt = b.amounts[n - 1];
      if (last < from || last > to) continue;
      // twice in one period, and well before the next due date
      if (last - prev > 0.6 * I) continue;
      const ahead = s.next - last;
      if (ahead < MIN_EARLY || ahead > 1.25 * I) continue;
      // about the usual size, and the same way
      const ratio = s.level ? amt / s.level : 0;
      if (ratio < 0.75 || ratio > 1.33) continue;
      const key = `series|${e.id}|${s.signature}|${isoFromDay(last)}`;
      if (asked.has(key)) continue;
      out.push({ key, kind: 'series', categoryId: e.id, signature: s.signature, label: s.signature, day: last, due: s.next, amount: amt, expected: s.level });
    }
  }

  // items added by hand, still ahead of the statements
  const D = agg.D;
  for (const o of sc.oneOffs) {
    const due = dayFromISO(o.date);
    if (due <= basis.dataEnd || Math.abs(o.amount) < MIN_ONEOFF) continue;
    const c = agg.catIds.indexOf(o.categoryId);
    if (c < 0) continue;
    let best: { day: Day; v: number } | null = null;
    for (let d = Math.max(from, agg.startDay); d <= Math.min(to, basis.dataEnd); d++) {
      const k = c * D + d - agg.startDay;
      const v = agg.op[k] + agg.opOneOff[k];
      // within a tenth of it, the same way; the closest to its date if several
      if (Math.sign(v) !== Math.sign(o.amount) || Math.abs(v - o.amount) > 0.1 * Math.abs(o.amount)) continue;
      if (!best || d > best.day) best = { day: d, v };
    }
    if (!best) continue;
    const key = `oneoff|${o.id}|${isoFromDay(best.day)}`;
    if (asked.has(key)) continue;
    out.push({ key, kind: 'oneoff', categoryId: o.categoryId, oneOffId: o.id, label: o.description || 'Item added by hand', day: best.day, due, amount: best.v, expected: o.amount });
  }
  return out.sort((a, z) => Math.abs(z.amount) - Math.abs(a.amount));
}

/** The answer to keep for a candidate. */
export function answerEarly(c: EarlyCandidate, answer: Arrival['answer'], by: string): Arrival {
  return {
    key: c.key, kind: c.kind, categoryId: c.categoryId, signature: c.signature, oneOffId: c.oneOffId,
    day: isoFromDay(c.day), due: isoFromDay(c.due), amount: Math.round(c.amount), answer, at: new Date().toISOString(), by,
  };
}

export { DUE_MATCH_DAYS } from './engine';

/**
 * Timing, when judging a signed-off forecast at `at`:
 *  - money confirmed as early that arrived between the forecast's start and `at`, for a payment it
 *    expected after `at` (and by its `end`): in the actuals already, evening out at the due date;
 *  - a payment confirmed as late, due between the start and `at`, not in by `at` (from `h`): missing
 *    from the actuals, evening out when it comes.
 * The same answer on several forecasts (a duplicated scenario) counts once. Signed: + means the
 * actuals are ahead.
 */
export function timingAt(arrivals: Arrival[], from: Day, at: Day, end: Day, h?: CashHistory | null): { items: Arrival[]; total: number } {
  const seen = new Set<string>();
  const items = arrivals.filter((a) => {
    if (seen.has(a.key)) return false;
    const d = dayFromISO(a.day), due = dayFromISO(a.due);
    if (a.answer === 'early') {
      if (d < from || d > at || due <= at || due > end) return false;
    } else if (a.answer === 'late') {
      // due inside the period read, and not in yet by then: the forecast had it, the statements don't
      if (due < from || due > at) return false;
      const came = h ? lateArrivedOn(seriesDays(h, a), a) : null;
      if (came !== null && came <= at) return false;
    } else return false;
    seen.add(a.key);
    return true;
  }).sort((x, z) => Math.abs(z.amount) - Math.abs(x.amount));
  // early money is in the actuals ahead of time (+ for money in); late money is missing from them (− for money in)
  return { items, total: items.reduce((t, a) => t + (a.answer === 'late' ? -a.amount : a.amount), 0) };
}

/**
 * How much of an early arrival the history holds as a one-off (an outlier in its category that day:
 * a second payment in one month often is). Signed like the arrival, and no bigger than it. Lets
 * Monitor set one-offs and timing aside together without taking the same money off twice.
 */
export function heldAsOneOff(h: CashHistory, a: Arrival): number {
  const d = dayFromISO(a.day), c = h.cats.indexOf(a.categoryId);
  if (c < 0) return 0;
  let v = 0;
  for (const cells of h.cells) for (let k = 0; k < cells.length; k += 4) if (cells[k] === d && cells[k + 1] === c && cells[k + 2] === K_ONEOFF) v += cells[k + 3] / 100;
  return Math.sign(v) === Math.sign(a.amount) ? Math.sign(a.amount) * Math.min(Math.abs(v), Math.abs(a.amount)) : 0;
}

// ---------------------------------------------------------------- late

/** a due date this many days behind the latest statement, with nothing in, is late (not a payday that fell on a weekend) */
export const LATE_DAYS = 5;

export interface LateCandidate {
  key: string;
  categoryId: string;
  signature: string;
  label: string;
  /** when it was due, and what the forecast would have expected (signed) */
  due: Day;
  amount: number;
  /** a sensible day to expect it now: the next working day after the latest statement */
  expectOn: Day;
}

/** Regular payments due between `from` and `to` that haven't come, now more than a few days on. */
export function findLate(basis: ForecastBasis, fc: ForecastResult, sc: { arrivals?: Arrival[] }, from: Day, to: Day): LateCandidate[] {
  const asked = new Set((sc.arrivals ?? []).map((a) => a.key));
  const out: LateCandidate[] = [];
  const end = basis.dataEnd;
  for (const e of fc.explain) {
    for (const s of e.series) {
      const I = INTERVAL[s.cadence];
      if (!I) continue;
      const b = basis.series.find((x) => x.signature === s.signature && x.catIdx === e.catIdx);
      if (!b || b.days.length < 3) continue;
      const last = b.days[b.days.length - 1];
      // a regular payment until lately: a missed one or two can make it look stopped, which is
      // exactly when to ask (left alone, a stopped payment drops out of the forecast altogether)
      if (end - last > 2.5 * I) continue;
      const due = projectDates(b, last, end + 1).find((d) => d > last);
      if (due === undefined || due > end - LATE_DAYS || due < from || due > to) continue;
      const key = `late|${e.id}|${s.signature}|${isoFromDay(due)}`;
      if (asked.has(key)) continue;
      out.push({ key, categoryId: e.id, signature: s.signature, label: s.signature, due, amount: s.level, expectOn: nextBusinessDay(end) });
    }
  }
  return out.sort((a, z) => Math.abs(z.amount) - Math.abs(a.amount));
}

/** The answer to keep for a late payment: still coming (expected on `expectOn`), or not coming. */
export function answerLate(c: LateCandidate, answer: 'late' | 'missed', expectOn: Day, by: string): Arrival {
  return {
    key: c.key, kind: 'series', categoryId: c.categoryId, signature: c.signature,
    day: isoFromDay(expectOn), due: isoFromDay(c.due), amount: Math.round(c.amount), answer, at: new Date().toISOString(), by,
  };
}

export { lateArrivedOn };

/** The days a regular payment shows in a saved history (for `lateArrivedOn`). */
export function seriesDays(h: CashHistory, a: Arrival): number[] {
  return h.series.filter((s) => s.sig === a.signature && s.cat === a.categoryId).flatMap((s) => s.occ.map((o) => o[0])).sort((x, y) => x - y);
}
