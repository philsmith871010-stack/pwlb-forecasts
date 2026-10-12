// Money that arrives (or goes out) before the forecast expected it. Once it's in the statements it
// is part of the cash so far, so the forecast must not count it again on its due date.
//
// Two kinds are matched mechanically:
//  - a regular payment seen twice in one period, the second well before the next due date: the
//    next one, early (December's grant on 28 November);
//  - an item added by hand, still dated ahead, whose amount has already arrived in its category.
// The user confirms each: "early" takes the due payment out of the forecast, "extra" leaves it in.
// Either answer is kept on the scenario (`arrivals`), so it's asked once.
import type { ForecastBasis } from '../analysis/aggregates';
import type { ForecastResult } from './engine';
import type { OneOff } from '../model';
import { type Day, isoFromDay, dayFromISO } from '../dates';

/** A confirmed answer: this money arrived on `day` for the payment due on `due`. */
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
  /** early: take the due payment out of the forecast; extra: it was something else, leave it in */
  answer: 'early' | 'extra';
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

/** A regular payment's projected date this early arrival stands in for (within this many days of the due date it was given). */
export const DUE_MATCH_DAYS = 10;
