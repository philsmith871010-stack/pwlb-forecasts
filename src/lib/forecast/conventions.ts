// Payment conventions: the rule a regular payment's date follows each month. "The 15th, or the next
// working day", "the working day before", "the second Tuesday", "the third working day", "the last
// working day". Learned from a payment's own past dates (the rule that would have produced the most
// of them exactly), so the forecast books it on the right day, weekends and bank holidays included.
import { type Day, dayFromYMD, ymdFromDay, daysInMonth, weekday, isBusinessDay, nextBusinessDay, prevBusinessDay } from '../dates';

export type Convention =
  /** a day of the month; when that isn't a working day, the next one, the one before, or that day regardless */
  | { kind: 'dom'; day: number; roll: 'next' | 'prev' | 'none' }
  /** the nth weekday of the month (n = 1…4, or −1 for the last), weekday 0 = Sunday … 6 = Saturday */
  | { kind: 'weekday'; n: number; weekday: number }
  /** the nth working day of the month (1 = first), or counted from the end (−1 = last) */
  | { kind: 'working'; n: number };

/** The day a convention gives in a month, or null when there's none (a fifth Tuesday, say). */
export function dateFor(c: Convention, y: number, m: number): Day | null {
  const dim = daysInMonth(y, m), first = dayFromYMD(y, m, 1), last = dayFromYMD(y, m, dim);
  if (c.kind === 'dom') {
    const d = dayFromYMD(y, m, Math.min(c.day, dim));
    if (c.roll === 'none' || isBusinessDay(d)) return d;
    return c.roll === 'next' ? nextBusinessDay(d) : prevBusinessDay(d);
  }
  if (c.kind === 'weekday') {
    if (c.n > 0) {
      const d = first + ((c.weekday - weekday(first) + 7) % 7) + 7 * (c.n - 1);
      return d <= last ? d : null;
    }
    return last - ((weekday(last) - c.weekday + 7) % 7);
  }
  let k = 0;
  if (c.n > 0) { for (let d = first; d <= last; d++) if (isBusinessDay(d) && ++k === c.n) return d; }
  else { for (let d = last; d >= first; d--) if (isBusinessDay(d) && ++k === -c.n) return d; }
  return null;
}

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** "on the 15th, or the next working day if that isn't one" */
export function conventionWords(c: Convention): string {
  if (c.kind === 'dom') return c.roll === 'none' ? `on the ${nth(c.day)}` : `on the ${nth(c.day)}, or the ${c.roll === 'next' ? 'next working day' : 'working day before'} if that isn’t one`;
  if (c.kind === 'weekday') return `on the ${c.n > 0 ? ORD[c.n] : 'last'} ${WEEKDAYS[c.weekday]}`;
  if (c.n === -1) return 'on the last working day';
  return c.n > 0 ? `on the ${ORD[c.n] ?? nth(c.n)} working day` : `on the ${ORD[-c.n] ?? nth(-c.n)}-to-last working day`;
}

/** As a short token, to store a choice ("dom:15:next", "weekday:2:2", "working:-1") and read it back. */
export function conventionToken(c: Convention): string {
  return c.kind === 'dom' ? `dom:${c.day}:${c.roll}` : c.kind === 'weekday' ? `weekday:${c.n}:${c.weekday}` : `working:${c.n}`;
}
export function parseConvention(t: string | undefined): Convention | null {
  if (!t) return null;
  const [k, a, b] = t.split(':');
  if (k === 'dom' && +a >= 1 && +a <= 31 && (b === 'next' || b === 'prev' || b === 'none')) return { kind: 'dom', day: +a, roll: b };
  if (k === 'weekday' && (+a === -1 || (+a >= 1 && +a <= 5)) && +b >= 0 && +b <= 6) return { kind: 'weekday', n: +a, weekday: +b };
  if (k === 'working' && +a !== 0 && Math.abs(+a) <= 23) return { kind: 'working', n: +a };
  return null;
}

/** how a convention ranks when several fit equally well: the plainest first */
function rank(c: Convention, sign: number): number {
  if (c.kind === 'working' && c.n === -1) return 0;
  if (c.kind === 'dom') return c.roll === (sign < 0 ? 'prev' : 'next') ? 1 : c.roll === 'none' ? 3 : 2;
  if (c.kind === 'working') return 4 + (c.n > 0 ? c.n : 10 - c.n) / 100;
  return 5;
}

/** At least this many past dates, and this share of them matched exactly, to call it a convention. */
export const MIN_DATES = 4, MIN_SHARE = 0.75;

/**
 * The convention a payment's dates follow: the one that would have produced most of its latest
 * dates (up to a year's worth of monthly ones) exactly. Ties go to the plainest, and for a day of
 * the month to the usual roll for its direction (money out the working day before, money in the
 * next). Null when nothing fits well enough: the dates are too few or too scattered.
 */
export function detectConvention(days: ArrayLike<number>, sign = -1): { convention: Convention; share: number } | null {
  const recent = Array.from(days).slice(-12);
  if (recent.length < MIN_DATES) return null;
  const cands = new Map<string, Convention>();
  const add = (c: Convention) => cands.set(conventionToken(c), c);
  for (const d of recent) {
    const { y, m, d: dd } = ymdFromDay(d), dim = daysInMonth(y, m);
    // the day it was meant for: this one, or a few either side when a weekend or holiday moved it
    for (let off = -3; off <= 3; off++) {
      const base = dd + off;
      if (base < 1 || base > 31) continue;
      for (const roll of ['next', 'prev', 'none'] as const) add({ kind: 'dom', day: base, roll });
    }
    add({ kind: 'weekday', n: Math.ceil(dd / 7), weekday: weekday(d) });
    if (dd + 7 > dim) add({ kind: 'weekday', n: -1, weekday: weekday(d) });
    if (isBusinessDay(d)) {
      let k = 0;
      for (let x = dayFromYMD(y, m, 1); x <= d; x++) if (isBusinessDay(x)) k++;
      add({ kind: 'working', n: k });
      k = 0;
      for (let x = dayFromYMD(y, m, dim); x >= d; x--) if (isBusinessDay(x)) k++;
      add({ kind: 'working', n: -k });
    }
  }
  let best: { convention: Convention; share: number; r: number } | null = null;
  for (const c of cands.values()) {
    let hit = 0;
    for (const d of recent) { const { y, m } = ymdFromDay(d); if (dateFor(c, y, m) === d) hit++; }
    // a rolled date can land in the next month (the 31st, rolled on): count the month it was meant for
    if (c.kind === 'dom' && c.roll === 'next') for (const d of recent) {
      const { y, m, d: dd } = ymdFromDay(d);
      if (dd > 3) continue;
      const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
      if (dateFor(c, py, pm) === d) hit++;
    }
    const share = hit / recent.length, r = rank(c, sign);
    if (!best || share > best.share + 1e-9 || (Math.abs(share - best.share) < 1e-9 && r < best.r)) best = { convention: c, share, r };
  }
  return best && best.share >= MIN_SHARE ? { convention: best.convention, share: best.share } : null;
}

/** A timing change's rule in words, e.g. "on the last working day", "on Fridays", "on the 2nd Tuesday". */
export function timingRuleWords(a: { rule: 'last_working_day' | 'day_of_month' | 'weekday' | 'convention'; dayOfMonth?: number; weekday?: number; convention?: string }): string {
  if (a.rule === 'last_working_day') return 'on the last working day';
  if (a.rule === 'weekday') return `on ${WEEKDAYS[a.weekday ?? 5]}s`;
  if (a.rule === 'convention') { const c = parseConvention(a.convention); return c ? conventionWords(c) : 'on its usual days'; }
  return `on day ${a.dayOfMonth}`;
}
