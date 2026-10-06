// Dated cash events implied by the deal register: drawdowns, repayments, interest,
// placements and maturities. Principal repayments use the register's own schedule
// (REG.schedule / REG.pastSchedule), so this tool and PWLBreports always agree.
//
// Interest is not in the register, so it is worked here from the same conventions:
//  * a loan pays interest on its payment cycle, which ends on the maturity date and steps
//    back by the frequency (half-yearly when none is given, as PWLB loans pay), with a
//    front-end stub — exactly how the register builds repayment dates;
//  * each payment is the balance outstanding in the period × rate ÷ payments a year
//    (the stub pro rata, actual/365);
//  * a loan of a year or less (temporary or council-to-council borrowing) pays all its
//    interest at maturity, actual/365;
//  * a LOBO is assumed called at its next call date (the Code's assumption, as the register).
//  * a deposit's interest is paid at maturity, actual/365; an instrument bought at a
//    discount (face value above principal) earns through its face value instead.
import { REG, Register, RegLoan, RegTerm } from './index';
import type { Day } from '../dates';

export type EventKind = 'loan_drawdown' | 'loan_repayment' | 'loan_interest' | 'inv_placement' | 'inv_maturity' | 'inv_interest';

export interface CashEvent {
  day: Day;
  /** + money in, − money out */
  amount: number;
  kind: EventKind;
  categoryId: string;
  label: string;
  /** stable id of the register row this came from */
  ref: string;
  future: boolean;
}

export const KIND_LABEL: Record<EventKind, string> = {
  loan_drawdown: 'New borrowing received', loan_repayment: 'Loan repaid', loan_interest: 'Loan interest paid',
  inv_placement: 'Investment placed', inv_maturity: 'Investment matures', inv_interest: 'Investment interest received',
};

const DAYMS = 86_400_000;
export const toDay = (d: Date) => Math.round(d.getTime() / DAYMS);
const PER_YEAR: Record<string, number> = { 'Half-yearly': 2, Annual: 1, Quarterly: 4 };

export function loanCategory(l: RegLoan): string {
  switch (l.type) {
    case 'PWLB fixed': return 'pwlb';
    case 'LOBO': return 'lobo';
    case 'Local authority loan': case 'Temporary borrowing': return 'la_loans';
    default: return l.lenderType === 'PWLB' ? 'pwlb' : l.lenderType === 'Local authority' ? 'la_loans' : 'other_borrowing';
  }
}

export function termCategory(t: RegTerm): string {
  if (t.type === 'Loan to local authority' || t.cpType === 'Local authority') return 'la_loans';
  if (t.type === 'Fixed deposit' && t.cpType === 'UK Government') return 'dmadf';
  return 'bank_deposits';
}

const loanName = (l: RegLoan) => `${l.type ?? 'Loan'} · ${l.lender}`;
const termName = (t: RegTerm) => `${t.type ?? 'Investment'} · ${t.counterparty}`;

/** The interest cycle: payment dates ending at maturity, stepping back by the frequency. */
function interestDates(l: RegLoan, end: Date): Date[] {
  if (!l.maturity) return [];
  const step = 12 / (PER_YEAR[l.frequency ?? 'Half-yearly'] ?? 2);
  const from = l.start ?? new Date(Date.UTC(1990, 0, 1));
  const out: Date[] = [];
  for (let k = 0; k < 4000; k++) {
    const d = REG.addMonths(l.maturity, -step * k) as Date;
    if (d <= from) break;
    if (d <= end) out.push(d);
  }
  return out.reverse();
}

const isShort = (l: RegLoan) => !!(l.start && l.maturity && (l.maturity.getTime() - l.start.getTime()) / DAYMS <= 366 && (l.profile ?? 'Maturity') === 'Maturity');

function loanEvents(l: RegLoan, asAt: Date, out: CashEvent[]) {
  if (!(l.principal > 0) || !l.maturity) return;
  const cat = loanCategory(l), name = loanName(l), ref = `loan:${l.row}`;
  const asAtDay = toDay(asAt);
  const push = (d: Date, amount: number, kind: EventKind) => { if (Math.abs(amount) >= 0.5) out.push({ day: toDay(d), amount: Math.round(amount * 100) / 100, kind, categoryId: kind === 'loan_interest' ? cat : cat, label: `${KIND_LABEL[kind]}: ${name}`, ref, future: toDay(d) > asAtDay }); };
  const rate = l.rate ?? 0;

  if (l.history) {
    // repaid before the as-at date: Principal is the amount repaid
    if (l.start) push(l.start, l.principal, 'loan_drawdown');
    push(l.maturity, -l.principal, 'loan_repayment');
    if (rate > 0 && l.start) {
      if (isShort(l)) push(l.maturity, -l.principal * rate * (l.maturity.getTime() - l.start.getTime()) / DAYMS / 365, 'loan_interest');
      else for (const d of interestDates(l, l.maturity)) push(d, -l.principal * rate / (PER_YEAR[l.frequency ?? 'Half-yearly'] ?? 2), 'loan_interest');
    }
    return;
  }
  if (!l.runsOff) return;
  const end: Date = REG.loanEnd(l, asAt);
  const past: { date: Date; amount: number }[] = REG.pastSchedule(l, asAt);
  const future: { date: Date; amount: number }[] = l.schedule ?? [];
  // drawdown: a forward loan in the future, otherwise what was raised, when it was raised
  if (l.start) push(l.start, l.forward ? l.principal : l.raised || l.principal, 'loan_drawdown');
  for (const p of past) push(p.date, -p.amount, 'loan_repayment');
  for (const p of future) push(p.date, -p.amount, 'loan_repayment');
  if (!(rate > 0)) return;
  // balance outstanding just before a date: principal now, plus past instalments not yet paid, less future ones already paid
  const balanceBefore = (d: Date) => l.principal + past.filter((p) => p.date >= d).reduce((t, p) => t + p.amount, 0) - future.filter((p) => p.date < d).reduce((t, p) => t + p.amount, 0);
  if (isShort(l) && l.start) { push(end, -l.principal * rate * (end.getTime() - l.start.getTime()) / DAYMS / 365, 'loan_interest'); return; }
  const per = PER_YEAR[l.frequency ?? 'Half-yearly'] ?? 2;
  const dates = interestDates(l, end);
  dates.forEach((d, i) => {
    const bal = balanceBefore(d);
    if (bal <= 0.5) return;
    // the first period after the start is a stub
    const prev = i === 0 ? (REG.addMonths(d, -12 / per) as Date) : dates[i - 1];
    const stubStart = i === 0 && l.start && l.start > prev ? l.start : null;
    const amount = stubStart ? bal * rate * (d.getTime() - stubStart.getTime()) / DAYMS / 365 : bal * rate / per;
    push(d, -amount, 'loan_interest');
  });
  // a LOBO called (or a loan ending) between cycle dates pays its broken period at the end
  const lastDate = dates[dates.length - 1];
  if (end < l.maturity && lastDate && end > lastDate) {
    const bal = balanceBefore(end);
    push(end, -bal * rate * (end.getTime() - lastDate.getTime()) / DAYMS / 365, 'loan_interest');
  }
}

function termEvents(t: RegTerm, asAt: Date, out: CashEvent[]) {
  if (!(t.principal > 0) || !t.maturity) return;
  const cat = termCategory(t), name = termName(t), ref = `term:${t.row}`;
  const asAtDay = toDay(asAt);
  const push = (d: Date, amount: number, kind: EventKind, c = cat) => { if (Math.abs(amount) >= 0.5) out.push({ day: toDay(d), amount: Math.round(amount * 100) / 100, kind, categoryId: c, label: `${KIND_LABEL[kind]}: ${name}`, ref, future: toDay(d) > asAtDay }); };
  if (t.start) push(t.start, -t.principal, 'inv_placement');
  push(t.maturity, t.nominal, 'inv_maturity');
  const discount = t.faceValue != null && t.faceValue > t.principal;
  if (!discount && t.rate && t.start) push(t.maturity, t.principal * t.rate * (t.maturity.getTime() - t.start.getTime()) / DAYMS / 365, 'inv_interest', 'treasury_interest');
}

/** Every dated cash event the register implies, past and future. */
export function registerEvents(reg: Register): CashEvent[] {
  if (!reg.asAt) return [];
  const out: CashEvent[] = [];
  reg.loans.forEach((l) => loanEvents(l, reg.asAt!, out));
  reg.termInvestments.forEach((t) => termEvents(t, reg.asAt!, out));
  return out.sort((a, b) => a.day - b.day);
}

/** Money available at once: call accounts, notice accounts and money market funds at the as-at date. */
export function liquidBalances(reg: Register): { total: number; instant: number; notice: number; rows: { name: string; amount: number; notice: number | null }[] } {
  const rows = reg.callAccounts.filter((c) => c.counts).map((c) => ({ name: `${c.type ?? 'Account'} · ${c.counterparty}`, amount: c.balance, notice: c.noticeDays }));
  const notice = rows.filter((r) => r.notice && r.notice > 0).reduce((s, r) => s + r.amount, 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { total, instant: total - notice, notice, rows };
}

/** Call accounts, notice accounts and money market funds by name, for recognising their bank lines. */
export function registerAccounts(reg: Register): { name: string; categoryId: string }[] {
  return [
    ...reg.callAccounts.map((c) => ({ name: c.counterparty, categoryId: /money market/i.test(`${c.type} ${c.cpType}`) ? 'mmf' : 'bank_deposits' })),
    ...reg.pooledFunds.map((f) => ({ name: f.name, categoryId: 'mmf' })),
  ].filter((a) => a.name);
}

/** Summaries for the screens: what the register says is coming, by kind, between two days. */
export function commitmentsBetween(events: CashEvent[], from: Day, to: Day) {
  const sel = events.filter((e) => e.day >= from && e.day <= to);
  const by = (k: EventKind) => sel.filter((e) => e.kind === k).reduce((s, e) => s + e.amount, 0);
  return {
    events: sel,
    loansRepaid: by('loan_repayment'), loanInterest: by('loan_interest'), newBorrowing: by('loan_drawdown'),
    invMaturing: by('inv_maturity'), invInterest: by('inv_interest'), invPlaced: by('inv_placement'),
    net: sel.reduce((s, e) => s + e.amount, 0),
  };
}
