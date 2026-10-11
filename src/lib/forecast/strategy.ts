// "What you could do": options to discuss, worked from the cash flow forecast and, where the
// council's deal register is loaded, its loans. Nothing here is advice: it sets out the
// arithmetic a treasury team would start a conversation with. Counterparty limits, rates and
// the treasury management strategy are not checked.
//
//  * Borrowing need — the deepest shortfall below the minimum cash balance, split into
//    the part the forecast says recovers within a year ("short term") and the part that
//    does not ("lasting"). For each day, the lasting gap is how far below the minimum the
//    *best* point in the following 12 months still is.
//  * Term-out ladder — how much cash the forecast says stays above the minimum even on
//    the lower (cautious) line for at least 1, 3, 6, 12 and 24 months.
import type { Day } from '../dates';
import { addMonths, fmtDay } from '../dates';
import type { ForecastResult } from './engine';
import { fmtMoney } from './engine';

export interface StrategyRegister {
  /** future loan principal repayments, by loan */
  repayments: { day: Day; amount: number; label: string; ref: string }[];
  loboCalls: { day: Day; amount: number; label: string }[];
  liquid: number;
  debt: number;
}

export interface Rung { months: number; amount: number; until: Day }

export interface Strategy {
  shortfall: number;
  shortfallDay: Day | null;
  firstBelow: Day | null;
  lasting: number;
  lastingFrom: Day | null;
  shortTerm: number;
  /** some of the lasting need is only "not recovered before the forecast ends" */
  lastingWindowShort: boolean;
  refinancing: { total: number; items: { day: Day; amount: number; label: string }[]; lobo: { day: Day; amount: number; label: string }[] };
  ladder: Rung[];
  /** total borrowing needed by each quarter end (to stay above the minimum) */
  needBy: { day: Day; amount: number }[];
  /** surplus that stays above the minimum for the whole forecast on the cautious line */
  coreSurplus: number;
  /** a headline, one supporting line, and (optionally) the full reasoning */
  options: { title: string; body: string; detail?: string; tone: 'borrow' | 'invest' | 'info' | 'warn' }[];
}

const TENORS = [1, 3, 6, 12, 24];

export function buildStrategy(fc: ForecastResult, reg: StrategyRegister | null): Strategy {
  const H = fc.H, cum = fc.cumulative, lower = fc.lower, buffer = fc.buffer, start = fc.start;

  // ---------- borrowing need: total and lasting ----------
  let lo = 0;
  for (let d = 1; d < H; d++) if (cum[d] < cum[lo]) lo = d;
  const shortfall = Math.max(0, buffer - cum[lo]);
  let firstBelow: Day | null = null;
  for (let d = 0; d < H; d++) if (cum[d] < buffer) { firstBelow = start + d; break; }
  // best position in the next 365 days (sliding-window maximum, monotone deque)
  const win = 365;
  const bestAhead = new Float64Array(H);
  const dq: number[] = [];
  for (let d = H - 1; d >= 0; d--) {
    while (dq.length && cum[dq[dq.length - 1]] <= cum[d]) dq.pop();
    dq.push(d);
    while (dq[0] > d + win) dq.shift();
    bestAhead[d] = cum[dq[0]];
  }
  // a gap that hasn't recovered by the end of the forecast counts as lasting (flagged)
  let lasting = 0, lastingFrom: Day | null = null, lastingClipped = false;
  for (let d = 0; d < H; d++) {
    const gap = buffer - bestAhead[d];
    if (gap > lasting) { lasting = gap; lastingClipped = d + win >= H; }
    if (gap > 0 && lastingFrom === null) lastingFrom = start + d;
  }
  lasting = Math.min(Math.max(0, lasting), shortfall);
  const shortTerm = Math.max(0, shortfall - lasting);

  // ---------- refinancing in the horizon ----------
  const end = start + H - 1;
  const items = (reg?.repayments ?? []).filter((r) => r.day >= start && r.day <= end && Math.abs(r.amount) >= 1).map((r) => ({ day: r.day, amount: Math.abs(r.amount), label: r.label }));
  const refinancing = { total: items.reduce((s, r) => s + r.amount, 0), items, lobo: (reg?.loboCalls ?? []).filter((r) => r.day >= start && r.day <= end) };

  // ---------- term-out ladder on the cautious line ----------
  const ladder: Rung[] = [];
  let runMin = Infinity, d = 0;
  for (const months of TENORS) {
    const until = addMonths(start, months);
    if (until - start >= H) break;
    for (; d <= until - start && d < H; d++) runMin = Math.min(runMin, lower[d]);
    ladder.push({ months, amount: Math.max(0, runMin - buffer), until });
  }
  let coreSurplus = Infinity;
  for (let k = 0; k < H; k++) coreSurplus = Math.min(coreSurplus, lower[k]);
  coreSurplus = Math.max(0, coreSurplus - buffer);

  // ---------- how the need builds, quarter by quarter ----------
  const needBy: Strategy['needBy'] = [];
  {
    let mn = Infinity, q = 3;
    for (let k = 0; k < H; k++) {
      mn = Math.min(mn, cum[k]);
      const qEnd = addMonths(start, q) - 1;
      if (start + k === Math.min(qEnd, end)) { needBy.push({ day: start + k, amount: Math.max(0, buffer - mn) }); q += 3; }
    }
  }

  // ---------- options to discuss: a headline, one line, and the reasoning behind "More" ----------
  const options: Strategy['options'] = [];
  const m = (x: number) => fmtMoney(x);
  if (shortfall > 0) {
    options.push({
      tone: 'borrow', title: `Borrow about ${m(shortfall)} by ${fmtDay(start + lo)}`,
      body: `Have the first in place by ${fmtDay(firstBelow ?? start + lo)}, when cash first dips below your ${m(buffer)} minimum.` +
        (lasting > 0 ? ` ${m(lasting)} doesn’t recover within a year${shortTerm > 0 ? `; ${m(shortTerm)} does` : ''}.` : ' It all recovers within a year.'),
      detail: `Cash is forecast to fall ${m(shortfall)} below your ${m(buffer)} minimum at its lowest point, on ${fmtDay(start + lo)}. ` +
        (lasting > 0 ? `About ${m(lasting)} does not recover within a year${lastingClipped ? ' or before the forecast ends' : ''} (lasting)${shortTerm > 0 ? `, and ${m(shortTerm)} recovers within a year (short term)` : ''}.` : 'The forecast shows it recovering within a year, so short-term borrowing could cover it.') +
        (lastingClipped ? ' A longer forecast would show whether the later part recovers.' : ''),
    });
    if (shortTerm > 0) options.push({ tone: 'borrow', title: `Short term: ${m(shortTerm)}`, body: 'Borrow it for up to a year, timed for the low point.', detail: 'The part that recovers within a year could be covered by short borrowing (for example from another council) rather than by long-term loans.' });
  } else {
    options.push({ tone: 'info', title: 'No new borrowing needed', body: `Cash stays above your ${m(buffer)} minimum; the lowest point is ${m(cum[lo])} on ${fmtDay(start + lo)}.` });
  }
  if (refinancing.total > 0) {
    const big = refinancing.items.slice().sort((a, b) => b.amount - a.amount);
    options.push({
      tone: 'info', title: `${m(refinancing.total)} of loans fall due`,
      body: `Largest: ${m(big[0].amount)} on ${fmtDay(big[0].day)} (${big[0].label.replace(/^[^:]*: /, '')}).`,
      detail: `These repayments are already in the forecast; whether to refinance them is the same question as the lasting need. The largest: ${big.slice(0, 3).map((r) => `${m(r.amount)} on ${fmtDay(r.day)} (${r.label.replace(/^[^:]*: /, '')})`).join('; ')}.`,
    });
  }
  if (refinancing.lobo.length) options.push({ tone: 'warn', title: `${refinancing.lobo.length} LOBO call date${refinancing.lobo.length > 1 ? 's' : ''}`, body: `Assumed called on ${refinancing.lobo.map((l) => fmtDay(l.day)).join(', ')}; cash is higher if not.`, detail: 'Assuming the lender calls is the usual cautious view.' });
  const best = ladder.filter((r) => r.amount >= 1e6);
  if (best.length) {
    const longest = best[best.length - 1];
    // with borrowing needed later, using surplus cash first (rather than investing it) is often cheaper
    const underBorrowed = shortfall > 0;
    options.push({
      tone: 'invest', title: `Lock away about ${m(longest.amount)} for ${longest.months} month${longest.months > 1 ? 's' : ''}`,
      body: underBorrowed ? 'Or use it instead of new borrowing, which is usually cheaper.' : 'It stays above your minimum even on the cautious line.',
      detail: `Even on the cautious line, cash stays above your minimum by at least: ${ladder.map((r) => `${m(r.amount)} for ${r.months}m`).join(', ')}. Cash not needed for that long could earn more in a longer deposit than in an instant-access fund.` + (underBorrowed ? ' With borrowing needed later, using surplus cash instead of new borrowing (internal borrowing) is often cheaper than investing it.' : ''),
    });
  } else if (shortfall === 0) {
    options.push({ tone: 'info', title: 'Keep surplus cash liquid', body: 'The margin above your minimum is small, so instant-access funds suit it.' });
  }
  return {
    shortfall, shortfallDay: shortfall > 0 ? start + lo : null, firstBelow, lasting, lastingFrom, shortTerm,
    lastingWindowShort: lastingClipped && lasting > 0, refinancing, ladder, needBy, coreSurplus, options,
  };
}

export const STRATEGY_CAVEAT = 'These are options to discuss, not advice. Decisions sit with your section 151 officer and your treasury management strategy. Counterparty limits, rates and market conditions have not been checked.';
