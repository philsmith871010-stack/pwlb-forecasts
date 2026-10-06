// Parity with PWLBreports: the vendored reader against the template the register ships with.
// Expected figures are worked by hand here (as the register's own test_reader.js does).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readRegisterWorkbook, REG } from '../src/lib/register';
import { registerEvents, liquidBalances, toDay } from '../src/lib/register/cashflows';
import { liabilityBenchmark } from '../src/lib/register/benchmark';
import { dayFromYMD } from '../src/lib/dates';

const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

describe('deal register: parity with PWLBreports', async () => {
  const loaded = await readRegisterWorkbook(new Uint8Array(readFileSync('tests/fixtures/pwlb-register.xlsx')), 'pwlb-register.xlsx');
  const reg = loaded.reg;
  const L = reg.loans;

  it('reads the template exactly as the register page does', () => {
    expect(reg.issues).toEqual([]);
    expect(reg.asAt!.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect([reg.termInvestments.length, reg.callAccounts.length, reg.loans.length, reg.pooledFunds.length]).toEqual([15, 3, 10, 2]);
    expect(loaded.stats.debt).toBe(55e6);
  });

  it('builds the same repayment schedules (maturity, EIP, annuity, LOBO at call)', () => {
    const by = (f: (l: (typeof L)[number]) => boolean) => L.find((l) => !l.history && f(l))!;
    const mat = by((l) => l.type === 'PWLB fixed' && l.profile === 'Maturity' && l.principal === 10e6);
    expect(mat.schedule).toHaveLength(1);
    expect(+mat.schedule[0].date).toBe(+D(2045, 3, 20));
    const lobo = by((l) => l.type === 'LOBO');
    expect(+lobo.schedule[0].date).toBe(+D(2027, 3, 15));
    const eip = by((l) => l.profile === 'EIP').schedule;
    expect(eip).toHaveLength(27);
    expect(+eip[0].date).toBe(+D(2027, 3, 31));
    expect(eip.every((p: { amount: number }) => near(p.amount, 20e6 / 27))).toBe(true);
    const ann = by((l) => l.profile === 'Annuity').schedule, r = 0.026, n = 12, pay = 5e6 * r / (1 - Math.pow(1 + r, -n));
    expect(ann).toHaveLength(12);
    expect(near(ann[0].amount, pay - 5e6 * r)).toBe(true);
  });

  const ev = registerEvents(reg);
  const future = ev.filter((e) => e.future);

  it('turns every repayment into a dated cash event, matching the register', () => {
    const repaid = future.filter((e) => e.kind === 'loan_repayment').reduce((s, e) => s - e.amount, 0);
    // everything outstanding at the as-at date is repaid in the run-off
    expect(near(repaid, 55e6, 1)).toBe(true);
  });

  it('works interest on the payment cycle that ends at maturity (half-yearly by default)', () => {
    // £10m PWLB maturity loan at 3.50% from 20 Mar 2015 to 20 Mar 2045: £175,000 every 20 Mar / 20 Sep
    const pwl = L.find((l) => l.profile === 'Maturity' && l.type === 'PWLB fixed' && l.principal === 10e6)!;
    const pw = future.filter((e) => e.ref === `loan:${pwl.row}` && e.kind === 'loan_interest');
    expect(pw[0].day).toBe(toDay(D(2027, 3, 20)));
    expect(pw.every((e) => near(e.amount, -175000))).toBe(true);
    expect(pw).toHaveLength(37); // 20 Mar 2027 … 20 Mar 2045
    // temporary borrowing: £5m at 4.30%, 1 Aug to 2 Nov 2026 (93 days), all interest at maturity
    const tl = L.find((l) => l.type === 'Temporary borrowing' && !l.history)!;
    const temp = future.filter((e) => e.ref === `loan:${tl.row}` && e.kind === 'loan_interest');
    expect(temp).toHaveLength(1);
    expect(near(temp[0].amount, -5e6 * 0.043 * 93 / 365)).toBe(true);
    // the LOBO pays interest only until its call date
    const lobo = future.filter((e) => e.ref === `loan:${L[7].row}` && e.kind === 'loan_interest');
    expect(Math.max(...lobo.map((e) => e.day))).toBeLessThanOrEqual(toDay(D(2027, 3, 15)));
  });

  it('pays deposit interest at maturity, and discount instruments through their face value', () => {
    const fd = future.filter((e) => e.ref === `term:${reg.termInvestments.find((t) => t.counterparty === 'Lloyds Bank' && !t.history)!.row}`);
    // £5m Lloyds 15 Jul → 15 Oct 2026 at 4.10%: 92 days
    expect(fd.find((e) => e.kind === 'inv_maturity')!.amount).toBe(5e6);
    expect(near(fd.find((e) => e.kind === 'inv_interest')!.amount, 5e6 * 0.041 * 92 / 365)).toBe(true);
    const tbill = future.filter((e) => e.ref === `term:${reg.termInvestments.find((t) => t.type === 'Treasury bill' && !t.history)!.row}`);
    expect(tbill.find((e) => e.kind === 'inv_maturity')!.amount).toBe(10e6);
    expect(tbill.find((e) => e.kind === 'inv_interest')).toBeUndefined();
  });

  it('counts call accounts and money market funds as cash available', () => {
    const liq = liquidBalances(reg);
    expect(liq.total).toBe(17e6);
    expect(liq.notice).toBe(5e6);
  });

  it('works the liability benchmark from the Projections sheet', () => {
    const lb = liabilityBenchmark(reg)!;
    expect(lb.length).toBeGreaterThan(10);
    for (const r of lb) {
      expect(near(r.ntp, r.cfr - r.obs, 1e-9)).toBe(true);
      expect(near(r.lb, r.ntp + Math.max(r.liq, -r.ntp), 1e-9)).toBe(true);
    }
    // the existing loans run off from the register when the column is blank
    const y27 = lb.find((r) => r.yearEnd === 2027)!;
    const dye = REG.debtYearEnds(reg, 5).find((x: { date: Date }) => x.date.getUTCFullYear() === 2027).total / 1e6;
    expect(near(y27.existingLoans, dye, 1e-6)).toBe(true);
    void dayFromYMD;
  });
});
