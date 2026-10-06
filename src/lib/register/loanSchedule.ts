// A loan's whole life of cash, on the register's conventions: the payment cycle ends at
// maturity and steps back by the frequency (a front-end stub), EIP repays equal principal
// at each date, an annuity pays level amounts (principal part = payment − balance × rate),
// interest each period is balance × rate ÷ payments a year (the stub pro rata, actual/365).
// Used by the example council's generator so its bank lines and its register agree.
import { REG } from './index';

export interface LoanCash { date: Date; principal: number; interest: number }

const DAYMS = 86_400_000;

export function loanLife(start: Date, maturity: Date, principal: number, rate: number, profile: 'Maturity' | 'EIP' | 'Annuity', perYear = 2): LoanCash[] {
  const step = 12 / perYear;
  const dates: Date[] = [];
  for (let k = 0; k < 4000; k++) {
    const d = REG.addMonths(maturity, -step * k) as Date;
    if (d <= start) break;
    dates.push(d);
  }
  dates.reverse();
  const n = dates.length;
  const r = rate / perYear;
  const pay = profile === 'Annuity' && r > 0 ? principal * r / (1 - Math.pow(1 + r, -n)) : 0;
  let bal = principal;
  const out: LoanCash[] = [];
  dates.forEach((d, i) => {
    const prev = i === 0 ? (REG.addMonths(d, -step) as Date) : dates[i - 1];
    const interest = i === 0 && start > prev ? bal * rate * (d.getTime() - start.getTime()) / DAYMS / 365 : bal * r;
    let p = 0;
    if (profile === 'EIP') p = principal / n;
    else if (profile === 'Annuity') p = i === n - 1 ? bal : pay - bal * r;
    else p = i === n - 1 ? bal : 0;
    out.push({ date: d, principal: p, interest });
    bal -= p;
  });
  return out;
}

/** Principal still owed just after a date. */
export function outstandingAfter(life: LoanCash[], principal: number, at: Date): number {
  return principal - life.filter((x) => x.date <= at).reduce((s, x) => s + x.principal, 0);
}
