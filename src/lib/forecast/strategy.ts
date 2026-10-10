// "What you could do": options to discuss, worked from the cash flow forecast (bottom up)
// and, where the council's deal register is loaded, its loans and liability benchmark
// (top down). Nothing here is advice: it sets out the arithmetic a treasury team would
// start a conversation with. Counterparty limits, rates and the treasury management
// strategy are not checked.
//
//  * Borrowing need — the deepest shortfall below the minimum cash balance, split into
//    the part the forecast says recovers within a year ("short term") and the part that
//    does not ("lasting"). For each day, the lasting gap is how far below the minimum the
//    *best* point in the following 12 months still is.
//  * Benchmark check — lasting borrowing is compared with the room under the liability
//    benchmark (benchmark − existing loans). Borrowing above the benchmark would leave the
//    council holding more debt than its balance sheet needs, so that part is better short.
//  * Maturity shape — the room under the benchmark in later years shows how long new
//    borrowing can be kept: a tranche matures in the year the room falls below it.
//  * Term-out ladder — how much cash the forecast says stays above the minimum even on
//    the lower (cautious) line for at least 1, 3, 6, 12 and 24 months.
import type { Day } from '../dates';
import { addMonths, fmtDay, ymdFromDay } from '../dates';
import type { ForecastResult } from './engine';
import { fmtMoney } from './engine';

export interface LBRowLite { fy: string; yearEnd: number; lb: number; existingLoans: number; need: number; over: number; cfr: number; actual: boolean }

export interface StrategyRegister {
  /** future loan principal repayments, by loan */
  repayments: { day: Day; amount: number; label: string; ref: string }[];
  loboCalls: { day: Day; amount: number; label: string }[];
  /** £m, from the Projections sheet; null when the register has none */
  lb: LBRowLite[] | null;
  liquid: number;
  debt: number;
}

export interface Tranche { years: number; untilFy: string; amount: number }
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
  benchmark: null | {
    fy: string; lb: number; loans: number; room: number; over: number;
    lastingWithinRoom: number; lastingAboveRoom: number;
    tranches: Tranche[];
    rows: LBRowLite[];
  };
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

  // ---------- benchmark ----------
  let benchmark: Strategy['benchmark'] = null;
  const future = reg?.lb?.filter((r) => !r.actual) ?? [];
  // compare with the benchmark for the year the low point falls in (31 March on or after it)
  const { y: ly, m: lm } = ymdFromDay(start + lo);
  const lowYE = lm >= 4 ? ly + 1 : ly;
  const at = Math.max(0, future.findIndex((r) => r.yearEnd >= lowYE));
  const rows = future.slice(at);
  if (rows.length) {
    const first = rows[0];
    const room = Math.max(0, first.lb - first.existingLoans) * 1e6;
    const over = Math.max(0, first.existingLoans - Math.max(0, first.lb)) * 1e6;
    const within = Math.min(lasting, room), above = Math.max(0, lasting - room);
    // how long borrowing of `within` can be kept: the running minimum of the room
    const tranches: Tranche[] = [];
    if (within > 0) {
      let m = Infinity, kept = within;
      rows.forEach((r, k) => {
        m = Math.min(m, Math.max(0, r.lb - r.existingLoans) * 1e6);
        const can = Math.min(within, m);
        if (can < kept - 1) { tranches.push({ years: k, untilFy: rows[Math.max(0, k - 1)].fy, amount: kept - can }); kept = can; }
      });
      if (kept > 1) tranches.push({ years: rows.length, untilFy: rows[rows.length - 1].fy, amount: kept });
      // fold slivers (under 5% of the total) into the next shorter tranche, so the shape stays readable
      for (let k = tranches.length - 1; k >= 0; k--) {
        if (tranches.length > 1 && tranches[k].amount < within * 0.05) {
          const into = k > 0 ? k - 1 : 1;
          tranches[into].amount += tranches[k].amount;
          tranches.splice(k, 1);
        }
      }
    }
    benchmark = { fy: first.fy, lb: first.lb * 1e6, loans: first.existingLoans * 1e6, room, over, lastingWithinRoom: within, lastingAboveRoom: above, tranches: tranches.filter((t) => t.years > 0 || t.amount > 1), rows: reg!.lb! };
  }

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
  if (benchmark && lasting > 0) {
    if (benchmark.lastingWithinRoom > 0) {
      const longest = benchmark.tranches[benchmark.tranches.length - 1];
      options.push({
        tone: 'borrow', title: `${m(benchmark.lastingWithinRoom)} could be long-term borrowing`,
        body: benchmark.tranches.length > 1 ? `Spread the maturities: ${benchmark.tranches.map((t) => `${m(t.amount)} to ${t.untilFy}`).join(', ')}.` : longest ? `Your liability benchmark supports it to at least ${longest.untilFy}.` : 'It sits under your liability benchmark.',
        detail: `Your benchmark at the end of ${benchmark.fy} (the year of the low point) is ${m(benchmark.lb)} against ${m(benchmark.loans)} of existing loans, so there is room for ${m(benchmark.room)} of longer-term borrowing. Where the room narrows in later years, loans should mature as it does.`,
      });
    }
    if (benchmark.lastingAboveRoom > 0) options.push({
      tone: 'warn', title: `${m(benchmark.lastingAboveRoom)} more than your benchmark allows`,
      body: 'Borrow that part short term until the forecast and the balance sheet projections agree.',
      detail: `By ${benchmark.fy} the cash forecast (bottom up) needs more borrowing than the balance sheet projections (top down) support. Either the projections understate capital spending or other needs, or the forecast is too cautious, for example its growth rates. Long-term borrowing above the benchmark would leave the council over-borrowed.`,
    });
  }
  if (benchmark && benchmark.over > 0) options.push({ tone: 'warn', title: `Existing loans ${m(benchmark.over)} above the benchmark`, body: 'Repaying early, or not refinancing maturing loans, may be worth discussing.', detail: `In ${benchmark.fy} the council holds more debt than its liability benchmark.` });
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
    const underBorrowed = benchmark && benchmark.room > 0;
    options.push({
      tone: 'invest', title: `Lock away about ${m(longest.amount)} for ${longest.months} month${longest.months > 1 ? 's' : ''}`,
      body: underBorrowed ? 'Or use it instead of new borrowing, which is usually cheaper.' : 'It stays above your minimum even on the cautious line.',
      detail: `Even on the cautious line, cash stays above your minimum by at least: ${ladder.map((r) => `${m(r.amount)} for ${r.months}m`).join(', ')}. Cash not needed for that long could earn more in a longer deposit than in an instant-access fund.` + (underBorrowed ? ' The benchmark shows you are under-borrowed, so using surplus cash instead of new borrowing (internal borrowing) is often cheaper than investing it.' : ''),
    });
  } else if (shortfall === 0) {
    options.push({ tone: 'info', title: 'Keep surplus cash liquid', body: 'The margin above your minimum is small, so instant-access funds suit it.' });
  }
  return {
    shortfall, shortfallDay: shortfall > 0 ? start + lo : null, firstBelow, lasting, lastingFrom, shortTerm,
    lastingWindowShort: lastingClipped && lasting > 0, refinancing, benchmark, ladder, needBy, coreSurplus, options,
  };
}

export const STRATEGY_CAVEAT = 'These are options to discuss, not advice. Decisions sit with your section 151 officer and your treasury management strategy. Counterparty limits, rates and market conditions have not been checked.';
