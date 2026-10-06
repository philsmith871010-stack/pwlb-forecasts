// The "true" cash engine of a fictional mid-sized unitary authority. Produces clean
// ground-truth transactions; render.ts then turns them into deliberately messy bank CSVs.

import { Rng } from '../lib/rng';
import {
  Day, dayFromYMD, ymdFromDay, isBusinessDay, prevBusinessDay, nextBusinessDay, weekday,
  daysInMonth, lastWorkingDayOfMonth, fyOf,
} from '../lib/dates';
import * as N from './names';
import { loanLife } from '../lib/register/loanSchedule';

export interface TrueTxn {
  day: Day;
  /** + = money in, − = money out (pounds, 2dp) */
  amount: number;
  account: number;
  narr: string;
  cat: string;
  deal: boolean;
  recurring: boolean;
  /** true when this row duplicates an earlier one (bank double-posting) */
  dup?: boolean;
}

export interface EngineOptions {
  seed: number | string;
  startFY: number; // e.g. 2021 → Apr 2021
  years: number;
  /** Volume multiplier: 1 ≈ 20k rows over 5 years */
  volume: number;
  accounts: number; // 1–4
  /** 0–1: how often to inject outliers, reversals, duplicates, ambiguity */
  nastiness: number;
}

export const ACCOUNT_NAMES = ['General Account', 'Collection Account', 'Payroll Account', 'Schools Account'];
export const ACCOUNT_NUMBERS = ['40118822', '40118830', '40118849', '40118857'];

const r2 = (x: number) => Math.round(x * 100) / 100;

export function runEngine(o: EngineOptions): { txns: TrueTxn[]; start: Day; end: Day; openingBalances: number[]; register: unknown } {
  const rng = new Rng(o.seed);
  const start = dayFromYMD(o.startFY, 4, 1);
  const end = dayFromYMD(o.startFY + o.years, 3, 31);
  const V = o.volume;
  const nasty = o.nastiness;
  const out: TrueTxn[] = [];

  const acct = {
    general: 0,
    collection: o.accounts >= 2 ? 1 : 0,
    payroll: o.accounts >= 3 ? 2 : 0,
    schools: o.accounts >= 4 ? 3 : 0,
  };

  const yearsSince = (d: Day) => (d - start) / 365.25;
  /** Annual-step growth: level changes each April. */
  const stepGrowth = (d: Day, g: number) => Math.pow(1 + g, fyOf(d) - o.startFY);
  const contGrowth = (d: Day, g: number) => Math.pow(1 + g, yearsSince(d));

  // Narrative style for a flow changes at most once in the history (e.g. a bank or system
  // change), rather than flip-flopping line by line.
  const switchDay = new Map<string, Day>();
  const styleB = (key: string, day: Day) => {
    if (!switchDay.has(key)) switchDay.set(key, start + Math.floor(rng.next() * 1.6 * (end - start)));
    return day >= switchDay.get(key)!;
  };
  const add = (day: Day, amount: number, account: number, narr: string, cat: string, recurring = true, deal = false) => {
    if (day < start || day > end) return;
    const a = r2(amount);
    if (a === 0) return;
    out.push({ day, amount: a, account, narr, cat, deal, recurring });
  };

  const monthsIter: { y: number; m: number }[] = [];
  for (let fy = o.startFY; fy < o.startFY + o.years; fy++) {
    for (let k = 0; k < 12; k++) {
      const m = ((3 + k) % 12) + 1;
      monthsIter.push({ y: m >= 4 ? fy : fy + 1, m });
    }
  }
  const dom = (y: number, m: number, d: number) => dayFromYMD(y, m, Math.min(d, daysInMonth(y, m)));
  const isInstalmentMonth = (m: number) => m !== 2 && m !== 3; // 10 instalments Apr–Jan

  // ---------------- Council tax ----------------
  {
    const A = 165e6;
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.0499) * (1 + 0.004 * rng.normal());
      const ddMonth = A * 0.65 * ((isInstalmentMonth(m) ? 0.85 / 10 : 0) + 0.15 / 12) * lvl;
      const runs: [number, number][] = [[1, 0.55], [15, 0.3], [25, 0.15]];
      for (const [dd, share] of runs) {
        const day = nextBusinessDay(dom(y, m, dd));
        const nLines = Math.max(1, Math.round(1.5 * V * share * 2));
        const w = rng.splitWeights(nLines, 0.4);
        for (let i = 0; i < nLines; i++) {
          const sun = 400000 + (i % 3);
          add(day, ddMonth * share * w[i], acct.collection, !styleB('ctdd', day) ? `BACS DD COLLECTION CTAX SUN ${sun}` : `DD CREDIT COUNCIL TAX ${sun} BATCH ${rng.digits(4)}`, 'council_tax');
        }
        // Returned direct debits a few days later (~1%)
        const nUnpaid = rng.poisson(1.5 * V * share);
        for (let i = 0; i < nUnpaid; i++) {
          add(nextBusinessDay(day + rng.int(2, 5)), -rng.lognormal(Math.log(140), 0.4), acct.collection,
            rng.chance(0.5) ? `UNPAID DD CTAX REF ${rng.digits(8)}` : `RETURNED DD COUNCIL TAX ${rng.digits(9)}`, 'council_tax');
        }
      }
    }
    // Card / online / cash daily
    for (let d = start; d <= end; d++) {
      const { m } = ymdFromDay(d);
      const bd = isBusinessDay(d);
      const seas = isInstalmentMonth(m) ? 1.08 : 0.62;
      const dayTotal = (A * 0.35 / 252) * seas * stepGrowth(d, 0.0499) * (bd ? 1 : 0.08) * (1 + 0.25 * rng.normal() * 0.5);
      const n = bd ? Math.max(1, rng.poisson(4 * V * seas)) : rng.poisson(0.4 * V);
      if (n === 0) continue;
      const w = rng.splitWeights(n, 0.7);
      for (let i = 0; i < n; i++) {
        const k = rng.next();
        const narr = k < 0.35 ? `CTAX ONLINE PAYMENT ${rng.digits(9)}`
          : k < 0.6 ? `COUNCIL TAX CARD ${rng.digits(8)}`
          : k < 0.75 ? `CT PYMT ${rng.digits(9)} ${rng.letters(2)}`
          : k < 0.88 ? `PAYPOINT CTAX ${rng.digits(6)}`
          : `CASH OFFICE BANKING CTAX ${rng.digits(4)}`;
        add(d, dayTotal * w[i], acct.collection, narr, 'council_tax');
      }
    }
  }

  // ---------------- Business rates ----------------
  {
    const A = 75e6;
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.025);
      if (isInstalmentMonth(m)) {
        const day = nextBusinessDay(dom(y, m, 1));
        const n = Math.max(1, Math.round(0.8 * V));
        const w = rng.splitWeights(n, 0.4);
        for (let i = 0; i < n; i++) add(day, A * 0.45 / 10 * lvl * w[i], acct.collection, `BACS DD COLLECTION NNDR SUN 400310`, 'business_rates');
      }
      // Large ratepayers, 12 instalments on the 15th
      for (let i = 0; i < N.RATEPAYERS.length; i++) {
        const day = nextBusinessDay(dom(y, m, 15 + (i % 3)));
        const share = [0.07, 0.05, 0.045, 0.04, 0.035, 0.03, 0.025, 0.02][i];
        const narr = !styleB('rp' + i, day) ? `${N.RATEPAYERS[i]} NNDR ${rng.digits(8)}` : `BUSINESS RATES ${N.RATEPAYERS[i].slice(0, 16)}`;
        add(day, A * share / 12 * lvl * (1 + 0.01 * rng.normal()), acct.collection, narr, 'business_rates');
      }
    }
    for (let d = start; d <= end; d++) {
      if (!isBusinessDay(d)) continue;
      const n = rng.poisson(0.9 * V);
      for (let i = 0; i < n; i++) {
        add(d, A * 0.235 / 252 / Math.max(0.9 * V, 0.3) * rng.lognormal(0, 0.8) * stepGrowth(d, 0.025), acct.collection,
          rng.chance(0.5) ? `NNDR PAYMENT ${rng.digits(9)}` : `BUS RATES ONLINE ${rng.digits(8)}`, 'business_rates');
      }
    }
  }

  // ---------------- Precepts ----------------
  {
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.0495);
      add(prevBusinessDay(dom(y, m, 20)), -(19.5e6 / 12) * lvl, acct.general, 'NORTHSHIRE POLICE & CRIME COMMR PRECEPT', 'precepts');
      add(prevBusinessDay(dom(y, m, 20)), -(6.4e6 / 12) * lvl, acct.general, 'NORTHSHIRE FIRE & RESCUE AUTH PRECEPT', 'precepts');
      if (m === 4 || m === 9) {
        for (let i = 0; i < N.PARISHES.length; i++) {
          add(prevBusinessDay(dom(y, m, 30)), -(2.1e6 / 2) * lvl * [0.3, 0.25, 0.15, 0.12, 0.1, 0.08][i], acct.general, `${N.PARISHES[i]} PRECEPT`, 'precepts');
        }
      }
    }
  }

  // ---------------- Business rates retention ----------------
  {
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.025);
      const govt = d0 >= dayFromYMD(2024, 7, 8) ? 'MHCLG' : 'DLUHC';
      add(prevBusinessDay(dom(y, m, 12)), -(37e6 / 24) * lvl, acct.general, `${govt} NNDR CENTRAL SHARE`, 'nndr_retention');
      add(prevBusinessDay(dom(y, m, 26)), -(37e6 / 24) * lvl, acct.general, `${govt} NNDR CENTRAL SHARE`, 'nndr_retention');
      add(nextBusinessDay(dom(y, m, 6)), (8e6 / 12) * lvl, acct.general, `${govt} BRR TOP UP`, 'nndr_retention');
      if (m % 3 === 0) add(nextBusinessDay(dom(y, m, 21)), (1.2e6 / 4) * lvl * (1 + 0.3 * rng.normal()), acct.general, 'NORTHSHIRE BRR POOL DISTRIBUTION', 'nndr_retention');
    }
  }

  // ---------------- Payroll ----------------
  const netPayByMonth = new Map<number, number>();
  {
    const base = 95e6 / 12;
    const payChange = dayFromYMD(2023, 9, 1);
    let level = base;
    const awards: Record<number, { pct: number; lateMonth?: number }> = {
      2021: { pct: 0.0175, lateMonth: 3 }, // agreed very late, paid in March with arrears
      2022: { pct: 0.065, lateMonth: 11 },
      2023: { pct: 0.06, lateMonth: 11 },
      2024: { pct: 0.045, lateMonth: 10 },
      2025: { pct: 0.032 },
      2026: { pct: 0.03 },
      2027: { pct: 0.03 },
    };
    let currentFY = o.startFY - 1;
    let pending = 0;
    let arrearsMonths = 0;
    let lateMonth: number | undefined;
    for (const { y, m } of monthsIter) {
      const fy = m >= 4 ? y : y - 1;
      if (fy !== currentFY) {
        currentFY = fy;
        const a = awards[fy] ?? { pct: 0.03 };
        level *= 1.012; // incremental drift / headcount
        if (a.lateMonth) { pending = a.pct; lateMonth = a.lateMonth; arrearsMonths = 0; }
        else { level *= 1 + a.pct; pending = 0; lateMonth = undefined; }
      }
      let payday: Day;
      const d28 = dom(y, m, 28);
      if (d28 < payChange) payday = prevBusinessDay(d28);
      else payday = lastWorkingDayOfMonth(y, m);
      if (m === 12 && d28 < payChange) payday = prevBusinessDay(dom(y, 12, 18)); // Christmas early pay
      let arrears = 0;
      if (pending && m === lateMonth) {
        arrears = level * pending * arrearsMonths;
        level *= 1 + pending;
        pending = 0;
      }
      if (pending) arrearsMonths++;
      const total = level * (1 + 0.006 * rng.normal()) * (m === 7 || m === 8 ? 0.985 : 1);
      const groups: [string, number][] = [['OFFICERS', 0.46], ['TEACHERS', 0.31], ['SUPPORT STAFF', 0.2], ['MEMBERS ALLOWANCES', 0.03]];
      for (const [g, share] of groups) {
        const narr = !styleB('sal', payday) ? `SALARIES BACS ${g}` : `PAYROLL NET PAY ${g} M${String(((m + 8) % 12) + 1).padStart(2, '0')}`;
        add(payday, -total * share, acct.payroll, narr, 'salaries');
      }
      if (arrears > 0) add(payday, -arrears, acct.payroll, 'PAY AWARD ARREARS BACS', 'salaries', false);
      netPayByMonth.set(y * 12 + m - 1, total + arrears);
      // Weekly casual payroll, Fridays
      for (let d = dom(y, m, 1); d <= dom(y, m, 31); d++) {
        if (weekday(d) === 5 && isBusinessDay(d)) add(d, -(0.9e6 / 52) * contGrowth(d, 0.04) * (1 + 0.1 * rng.normal()), acct.payroll, 'CASUAL PAYROLL WEEKLY', 'salaries');
      }
    }
    // HMRC & pensions, paid the following month
    for (const { y, m } of monthsIter) {
      const prev = netPayByMonth.get(y * 12 + m - 2);
      if (!prev) continue;
      add(prevBusinessDay(dom(y, m, 22)), -prev * 0.36, acct.payroll, !styleB('hmrc', dom(y, m, 22)) ? `HMRC PAYE NIC 120PA00${rng.digits(5)}` : 'HMRC CUMBERNAULD PAYE', 'hmrc_paye');
      add(prevBusinessDay(dom(y, m, 19)), -prev * 0.255, acct.payroll, !styleB('pen', dom(y, m, 19)) ? 'NORTHSHIRE PENSION FUND CONTRIBS' : 'LGPS CONTRIBUTIONS NORTHSHIRE PF', 'pensions');
      add(prevBusinessDay(dom(y, m, 19)), -prev * 0.07, acct.payroll, 'TEACHERS PENSIONS TPS', 'pensions');
    }
  }

  // ---------------- Government grants ----------------
  {
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.03);
      const govt = d0 >= dayFromYMD(2024, 7, 8) ? 'MHCLG' : 'DLUHC';
      // RSG: 24 instalments
      for (const dd of [4, 18]) add(nextBusinessDay(dom(y, m, dd)), (12e6 / 24) * lvl, acct.general, !styleB('rsg', d0) ? `${govt} RSG ${rng.digits(6)}` : `${govt} REVENUE SUPPORT GRANT`, 'grants_general');
      add(nextBusinessDay(dom(y, m, 9)), (20e6 / 12) * stepGrowth(d0, 0.08), acct.general, 'DHSC SOCIAL CARE GRANT', 'grants_general');
      add(nextBusinessDay(dom(y, m, 7)), (38e6 / 12) * stepGrowth(d0, 0.01) * (1 + 0.04 * rng.normal()), acct.general, 'DWP HB SUBSIDY', 'grants_general');
      if (m % 3 === 1) add(nextBusinessDay(dom(y, m, rng.int(10, 24))), (14e6 / 4) * lvl * (1 + 0.15 * rng.normal()), acct.general, `${govt} S31 GRANT ${rng.digits(5)}`, 'grants_general');
      // Covid additional relief: stops Dec 2021 (structural break)
      if (d0 < dayFromYMD(2022, 1, 1)) add(nextBusinessDay(dom(y, m, 11)), 10e6 / 9, acct.general, 'COVID ADDITIONAL RELIEF FUND', 'grants_general');
      // Household Support Fund: starts Oct 2021, quarterly
      if (d0 >= dayFromYMD(2021, 10, 1) && (m === 10 || m === 1 || m === 4 || m === 7)) add(nextBusinessDay(dom(y, m, 14)), 3.2e6 / 4, acct.general, 'DWP HOUSEHOLD SUPPORT FUND', 'grants_general');
      // Extended producer responsibility: starts Nov 2025, quarterly, sizeable
      if (d0 >= dayFromYMD(2025, 11, 1) && (m === 11 || m === 2 || m === 5 || m === 8)) add(nextBusinessDay(dom(y, m, 16)), 1.6e6, acct.general, 'DEFRA PACKAGING EPR PAYMENT', 'grants_general');
      // DSG: 24 instalments
      const dfe = d0 >= dayFromYMD(2025, 4, 1) ? 'DFE' : 'ESFA';
      for (const dd of [1, 15]) add(nextBusinessDay(dom(y, m, dd)), (120e6 / 24) * stepGrowth(d0, 0.04), acct.general, !styleB('dsg', d0) ? `${dfe} DSG ${rng.digits(7)}` : `${dfe} DEDICATED SCHOOLS GRANT`, 'dsg');
      if (m === 6 || m === 11) add(nextBusinessDay(dom(y, m, 22)), -(0.3e6 + rng.next() * 0.9e6), acct.general, `${dfe} DSG RECOUPMENT ADJ`, 'dsg');
    }
    // One-off grants
    for (let fy = o.startFY; fy < o.startFY + o.years; fy++) {
      const n = rng.int(4, 8);
      for (let i = 0; i < n; i++) {
        const d = nextBusinessDay(dayFromYMD(fy, 4, 1) + rng.int(0, 360));
        const narr = rng.pick(['DLUHC GRANT ', 'DFE CAPITAL GRANT ', 'HOMES ENGLAND GRANT ', 'DFT LOCAL TRANSPORT ', 'ARTS COUNCIL GRANT ']) + rng.digits(6);
        add(d, rng.range(0.2e6, 4e6), acct.general, narr, 'grants_general', false);
      }
    }
  }

  // ---------------- Schools (termly) ----------------
  {
    const A = 105e6;
    const weights = N.SCHOOLS.map((_, i) => 0.6 + ((i * 37) % 11) / 10);
    const ws = weights.reduce((a, b) => a + b, 0);
    for (const { y, m } of monthsIter) {
      const d0 = dom(y, m, 1);
      const lvl = stepGrowth(d0, 0.04);
      const day = nextBusinessDay(dom(y, m, 1));
      for (let i = 0; i < N.SCHOOLS.length; i++) {
        add(day, -(A * 0.82 / 12) * lvl * weights[i] / ws, acct.schools, `${N.SCHOOLS[i]} BUDGET SHARE`, 'schools');
      }
      if (m === 4 || m === 9 || m === 1) {
        const tday = nextBusinessDay(dom(y, m, 8));
        for (let i = 0; i < N.SCHOOLS.length; i++) {
          add(tday, -(A * 0.18 / 3) * lvl * weights[i] / ws * (1 + 0.1 * rng.normal()), acct.schools, `${N.SCHOOLS[i]} PUPIL PREMIUM/TERMLY`, 'schools');
        }
      }
    }
  }

  // ---------------- Suppliers ----------------
  const supplierNames: string[] = [];
  {
    const nSup = Math.round(150 + 250 * Math.min(V, 12));
    for (let i = 0; i < nSup; i++) supplierNames.push(`${rng.pick(N.WORDS_A)} ${rng.pick(N.WORDS_B)} ${rng.pick(N.SUFFIXES)}`.toUpperCase());
    const A = 132e6;
    const seasonal = [1.0, 0.7, 0.95, 1.0, 1.0, 0.95, 1.0, 1.0, 1.05, 0.85, 1.05, 1.0, 1.45]; // index by month 1..12 (0 unused)
    for (let d = start; d <= end; d++) {
      if (!isBusinessDay(d)) continue;
      const { m } = ymdFromDay(d);
      const g = contGrowth(d, 0.04);
      const wd = weekday(d);
      // Weekly BACS run on Tuesday (or Wednesday if Tue is a holiday)
      const isRun = wd === 2 || (wd === 3 && !isBusinessDay(d - 1));
      if (isRun) {
        const total = (A * 0.62 / 52) * seasonal[m] * g * (1 + 0.12 * rng.normal());
        const n = Math.max(5, rng.poisson(14 * V));
        const w = rng.splitWeights(n, 1.3);
        for (let i = 0; i < n; i++) {
          const s = supplierNames[Math.floor(Math.pow(rng.next(), 1.8) * supplierNames.length)];
          add(d, -total * w[i], acct.general, rng.chance(0.85) ? `BACS ${s}` : `${s} INV ${rng.digits(6)}`, 'suppliers');
        }
      }
      // Daily faster payments / CHAPS
      const nf = rng.poisson(1.5 * V);
      for (let i = 0; i < nf; i++) {
        const s = rng.pick(supplierNames);
        add(d, -(A * 0.13 / 252 / Math.max(1.5 * V, 0.3)) * rng.lognormal(0, 1.1) * seasonal[m] * g, acct.general, rng.chance(0.5) ? `FPS ${s}` : `CHAPS ${s.slice(0, 18)} ${rng.digits(4)}`, 'suppliers');
      }
    }
    // Adult social care provider runs, 4-weekly (Thursday)
    let d = start; while (weekday(d) !== 4) d++;
    for (; d <= end; d += 28) {
      const day = prevBusinessDay(d);
      const total = (A * 0.25 / 13) * contGrowth(day, 0.07);
      const n = Math.max(3, Math.round(4 * Math.min(V, 10)));
      const w = rng.splitWeights(n, 0.6);
      for (let i = 0; i < n; i++) add(day, -total * w[i], acct.general, `ASC PROVIDER PAYMENTS ${rng.pick(N.WORDS_A).toUpperCase()} CARE`, 'suppliers');
    }
  }

  // ---------------- Housing benefit ----------------
  {
    for (let d = start; d <= end; d++) {
      if (weekday(d) !== 1) continue;
      const day = nextBusinessDay(d);
      const total = (40e6 * 0.55 / 52) * contGrowth(d, 0.01) * (1 + 0.05 * rng.normal());
      const n = Math.max(1, rng.poisson(5 * V));
      const w = rng.splitWeights(n, 0.9);
      for (let i = 0; i < n; i++) add(day, -total * w[i], acct.general, `HB RENT ALLOWANCE ${rng.digits(7)}`, 'housing_benefit');
    }
    // Fortnightly HB/CTS bulk run
    let d = start; while (weekday(d) !== 3) d++;
    for (; d <= end; d += 14) add(prevBusinessDay(d), -(40e6 * 0.42 / 26) * contGrowth(d, 0.01), acct.general, 'HOUSING BENEFIT BACS RUN', 'housing_benefit');
    // Discretionary housing payments, irregular small
    for (let d2 = start; d2 <= end; d2++) if (isBusinessDay(d2) && rng.chance(0.15)) add(d2, -rng.range(200, 3000), acct.general, `DHP PAYMENT ${rng.digits(6)}`, 'housing_benefit');
  }

  // ---------------- Fees, charges, parking ----------------
  {
    const A = 32e6;
    const seas = [1, 0.85, 0.85, 0.95, 1.0, 1.05, 1.15, 1.25, 1.25, 1.05, 0.95, 0.95, 1.15];
    const merchants = ['4421', '4422', '5108', '7730', '7731'].slice(0, V < 2 ? 2 : V < 8 ? 3 : 5);
    for (let d = start; d <= end; d++) {
      const { m } = ymdFromDay(d);
      const bd = isBusinessDay(d);
      const g = contGrowth(d, 0.04);
      const dayTotal = (A / 300) * seas[m] * g * (bd ? 1 : 0.35);
      // Card settlements per merchant
      for (const mid of merchants) {
        if (!bd && rng.chance(0.85)) continue;
        add(d, dayTotal * 0.6 / merchants.length * rng.lognormal(0, 0.3), acct.collection, `CARD SETTLEMENT MERCHANT ${mid}`, 'fees_charges');
      }
      const n = bd ? rng.poisson(2.5 * V) : 0;
      for (let i = 0; i < n; i++) {
        const k = rng.next();
        const narr = k < 0.3 ? `PARKING PCN ${rng.letters(2)}${rng.digits(8)}` : k < 0.5 ? `PLANNING FEE APP ${rng.digits(2)}/${rng.digits(5)}`
          : k < 0.65 ? `LICENCE FEE ${rng.letters(3)} ${rng.digits(5)}` : k < 0.8 ? `BUILDING CONTROL ${rng.digits(6)}` : `GREEN WASTE SUB ${rng.digits(7)}`;
        add(d, (dayTotal * 0.4 / Math.max(2.5 * V, 0.3)) * rng.lognormal(0, 0.9), acct.general, narr, 'fees_charges');
      }
    }
  }

  // ---------------- Rents ----------------
  {
    const quarterDays: [number, number][] = [[3, 25], [6, 24], [9, 29], [12, 25]];
    for (let fy = o.startFY - 1; fy <= o.startFY + o.years; fy++) {
      for (const [m, dd] of quarterDays) {
        const day = nextBusinessDay(dayFromYMD(fy, m, dd));
        N.TENANTS.forEach((t, i) => add(day + (i % 3), (5e6 / 4) * (0.05 + (i % 4) * 0.06) * contGrowth(day, 0.03), acct.general, `${t} RENT`, 'rents'));
      }
    }
    for (let d = start; d <= end; d++) if (weekday(d) === 1 && isBusinessDay(d)) {
      const n = Math.max(1, rng.poisson(1.2 * V));
      for (let i = 0; i < n; i++) add(d, (3e6 / 52 / Math.max(1.2 * V, 1)) * rng.lognormal(0, 0.5) * contGrowth(d, 0.03), acct.general, `MARKET STALL RENT ${rng.digits(4)}`, 'rents');
    }
  }

  // ---------------- VAT reclaims ----------------
  for (const { y, m } of monthsIter) {
    add(nextBusinessDay(dom(y, m, rng.int(11, 18))), (22e6 / 12) * contGrowth(dom(y, m, 1), 0.03) * (1 + 0.22 * rng.normal()), acct.general,
      !styleB('vat', dom(y, m, 1)) ? 'HMRC VAT126 REPAYMENT' : `HMRC VAT REFUND ${rng.digits(9)}`, 'vat_reclaim');
  }

  // ---------------- Capital ----------------
  {
    for (const { y, m } of monthsIter) {
      for (let i = 0; i < 4; i++) {
        const c = N.CONTRACTORS[i];
        add(prevBusinessDay(dom(y, m, 10 + 5 * i)), -(42e6 / 48) * contGrowth(dom(y, m, 1), 0.06) * rng.lognormal(0, 0.35), acct.general, `${c} CERT ${rng.digits(3)}`, 'capital_spend');
      }
    }
    for (let fy = o.startFY; fy < o.startFY + o.years; fy++) {
      for (let i = 0; i < 4; i++) add(prevBusinessDay(dayFromYMD(fy, 4, 1) + rng.int(10, 355)), -rng.range(1e6, 6e6), acct.general, `${rng.pick(N.CONTRACTORS.slice(4))} ${rng.pick(['FINAL ACCT', 'STAGE PAYMENT', 'RETENTION RELEASE'])}`, 'capital_spend', false);
      const nr = rng.int(3, 6);
      for (let i = 0; i < nr; i++) add(nextBusinessDay(dayFromYMD(fy, 4, 1) + rng.int(5, 355)), rng.range(0.3e6, 3.5e6), acct.general, `COMPLETION ${rng.pick(N.SITES)} ${rng.pick(N.SOLICITORS)}`, 'capital_receipts', false);
    }
  }

  // ---------------- Other receipts / payments ----------------
  {
    for (const { y, m } of monthsIter) {
      add(nextBusinessDay(dom(y, m, 5)), (12e6 / 12) * stepGrowth(dom(y, m, 1), 0.05), acct.general, 'NHS NORTHSHIRE ICB BCF CONTRIB', 'other_receipts');
      add(prevBusinessDay(dom(y, m, 15)), -(3.6e6 / 12) * stepGrowth(dom(y, m, 1), 0.03), acct.general, 'NORTHSHIRE COMBINED AUTH TRANSPORT LEVY', 'other_payments');
      if (m % 3 === 0) {
        // Shared-service recharges to neighbouring councils: genuinely ambiguous lines
        for (const nb of N.NEIGHBOURS) {
          const narr = styleB('rc' + nb, dom(y, m, 1)) ? `${nb.toUpperCase()} BOROUGH COUNCIL` : `${nb.toUpperCase()} BC RECHARGE Q${Math.floor(((m + 8) % 12) / 3) + 1}`;
          add(prevBusinessDay(dom(y, m, 27)), -(2e6 / 4) * rng.lognormal(0, 0.15), acct.general, narr, 'other_payments');
        }
      }
      if (m === 4) add(prevBusinessDay(dom(y, m, 28)), -0.45e6, acct.general, 'ENVIRONMENT AGENCY FLOOD LEVY', 'other_payments');
    }
    for (let d = start; d <= end; d++) {
      if (!isBusinessDay(d)) continue;
      if (rng.chance(0.25 * Math.min(V, 4))) add(d, rng.lognormal(Math.log(4000), 1.2), acct.general, rng.pick(['SUNDRY INCOME ', 'INSURANCE CLAIM SETTLEMENT ', 'S106 CONTRIBUTION ', 'COURT COSTS RECOVERED ']) + rng.digits(6), 'other_receipts', false);
      if (rng.chance(0.2 * Math.min(V, 4))) add(d, -rng.lognormal(Math.log(2500), 1.1), acct.general, rng.pick(['REFUND ', 'GRANT TO VCS ORG ', 'CORONER FEES ', 'MEMBERS EXPENSES ']) + rng.digits(5), 'other_payments', false);
    }
  }

  // ---------------- Nastiness: outliers, reversals, duplicates ----------------
  if (nasty > 0) {
    const mid = start + Math.floor((end - start) * 0.45);
    add(nextBusinessDay(mid), 12e6, acct.general, 'DLUHC EXCEPTIONAL FINANCIAL SUPPORT', 'grants_general', false);
    add(nextBusinessDay(mid + 200), -8.2e6, acct.general, `BACS ${supplierNames[3]}`, 'suppliers', false);
    add(nextBusinessDay(start + Math.floor((end - start) * 0.7)), 15e6, acct.general, `COMPLETION ${N.SITES[0]} ${N.SOLICITORS[0]}`, 'capital_receipts', false);
    add(nextBusinessDay(start + Math.floor((end - start) * 0.3)), 4e6, acct.general, 'DLUHC GRANT 552101', 'grants_general', false);
    // Reversals of supplier payments
    const sup = out.filter((t) => t.cat === 'suppliers' && t.amount < 0);
    const nRev = Math.round(sup.length * 0.003 * nasty * 2);
    for (let i = 0; i < nRev; i++) {
      const t = rng.pick(sup);
      t.recurring = false;
      add(nextBusinessDay(t.day + rng.int(2, 5)), -t.amount, t.account, `BACS RETURN ${t.narr.replace(/^(BACS|FPS|CHAPS) /, '').slice(0, 24)}`, 'suppliers', false);
    }
    // Bank double postings
    const nDup = Math.round(out.length * 0.0006 * nasty * 2);
    for (let i = 0; i < nDup; i++) {
      const t = out[Math.floor(rng.next() * out.length)];
      out.push({ ...t, dup: true });
    }
  }

  // ---------------- Internal transfers between own accounts ----------------
  const openingBalances = [2.4e6, 0.35e6, 0.1e6, 3.2e6].slice(0, o.accounts);
  if (o.accounts >= 2) {
    out.sort((a, b) => a.day - b.day);
    const netBy = new Map<string, number>();
    for (const t of out) {
      if (t.account === 0 || t.dup) continue;
      const k = `${t.account}:${t.day}`;
      netBy.set(k, (netBy.get(k) ?? 0) + t.amount);
    }
    const nums = ACCOUNT_NUMBERS;
    const xfer = (day: Day, from: number, to: number, amt: number, fromNarr: string, toNarr: string) => {
      if (amt <= 0) return;
      add(day, -amt, from, fromNarr, 'internal_transfer', true);
      add(day, amt, to, toNarr, 'internal_transfer', true);
    };
    // Collection account: swept to General the next business day
    for (let d = start; d <= end; d++) {
      const net = netBy.get(`1:${d}`);
      if (net && net > 0) {
        const sd = nextBusinessDay(d + 1);
        xfer(sd, 1, 0, net, !styleB('sweep', sd) ? `SWEEP TO ${nums[0]}` : `TFR TO GENERAL AC ${nums[0]}`, `SWEEP FROM ${nums[1]} COLLECTION`);
      }
    }
    // Payroll account: funded same day from General
    if (o.accounts >= 3) {
      for (let d = start; d <= end; d++) {
        const net = netBy.get(`2:${d}`);
        if (net && net < 0) xfer(d, 0, 2, -net, `FUNDING PAYROLL AC ${nums[2]}`, `TFR FROM ${nums[0]} PAYROLL FUNDING`);
      }
    }
    // Schools account: funded monthly in advance
    if (o.accounts >= 4) {
      for (const { y, m } of monthsIter) {
        let need = 0;
        for (let d = dom(y, m, 1); d <= dom(y, m, 31); d++) need -= netBy.get(`3:${d}`) ?? 0;
        if (need > 0) xfer(prevBusinessDay(dom(y, m, 1) - 1), 0, 3, need, `SCHOOLS AC FUNDING ${nums[3]}`, `TFR FROM ${nums[0]}`);
      }
    }
  }

  // ---------------- Treasury simulation ----------------
  const register = runTreasury(out, rng, start, end, openingBalances, o);

  out.sort((a, b) => a.day - b.day || a.account - b.account);
  return { txns: out, start, end, openingBalances, register };
}

// =====================================================================================
// Treasury: a simple but realistic cash manager reacting to the General account balance.
// =====================================================================================

function bankRate(d: Day): number {
  const { y, m } = ymdFromDay(d);
  const t = y + (m - 1) / 12;
  if (t < 2021.9) return 0.001;
  if (t < 2023.6) return 0.001 + (t - 2021.9) / 1.7 * 0.0515;
  if (t < 2024.6) return 0.0525;
  if (t < 2026.0) return 0.0525 - (t - 2024.6) / 1.4 * 0.0125;
  return 0.0375;
}


interface Pos { kind: 'la_loan' | 'dmadf' | 'fd'; principal: number; start: Day; mat: Day; rate: number; cp: string; ref: string; deposit: boolean; bank?: string; cpType?: string }

/** A loan with its whole life of cash on the register's conventions (see register/loanSchedule). */
interface GLoan {
  ref: string; type: 'PWLB fixed' | 'LOBO'; lender: string; lenderType: string; principal: number; rate: number;
  start: Day; mat: Day; profile: 'Maturity' | 'EIP' | 'Annuity'; nextCall?: Day;
  life: { day: Day; principal: number; interest: number }[];
}

const dateOf = (d: Day) => new Date(d * 86_400_000);
const dayOf = (d: Date) => Math.round(d.getTime() / 86_400_000);
const isoOf = (d: Day) => dateOf(d).toISOString().slice(0, 10);

function makeLoan(o: Omit<GLoan, 'life'>): GLoan {
  const life = loanLife(dateOf(o.start), dateOf(o.mat), o.principal, o.rate, o.profile, 2).map((x) => ({ day: dayOf(x.date), principal: x.principal, interest: x.interest }));
  return { ...o, life };
}

/** Returns the register snapshot (the council's deal register at the end of the history). */
function runTreasury(out: TrueTxn[], rng: Rng, start: Day, end: Day, opening: number[], o: EngineOptions): unknown {
  const V = o.volume;
  const add = (day: Day, amount: number, narr: string, cat: string) => {
    if (day < start || day > end) return;
    out.push({ day, amount: r2(amount), account: 0, narr, cat, deal: true, recurring: false });
  };
  // Existing PWLB portfolio: start days ≤ 28, maturity on the same day and month, so the
  // half-yearly cycle (which ends at maturity) falls on the start's anniversaries.
  const loans: GLoan[] = [];
  const s0 = ymdFromDay(start);
  for (let i = 0; i < 12; i++) {
    const sy = s0.y - rng.int(2, 30), sm = rng.int(1, 12), sd = rng.int(1, 28);
    const sday = dayFromYMD(sy, sm, sd);
    let my = sy + rng.int(25, 50);
    if (i < 3) my = s0.y + rng.int(1, 4); // a few mature during the history
    const profile = i < 8 ? 'Maturity' : i < 10 ? 'Annuity' : 'EIP';
    loans.push(makeLoan({ ref: rng.digits(6), type: 'PWLB fixed', lender: 'Public Works Loan Board', lenderType: 'PWLB', principal: rng.pick([5e6, 8e6, 10e6, 12.5e6, 15e6, 20e6, 25e6, 30e6]), rate: Math.round(rng.range(0.018, 0.048) * 10000) / 10000, start: sday, mat: dayFromYMD(my, sm, sd), profile }));
  }
  // Two LOBOs: half-yearly interest on the 1st; one has an option date after the history ends
  const lobos = [
    makeLoan({ ref: 'LOBO1', type: 'LOBO', lender: N.LOBO_LENDERS[0], lenderType: 'Overseas bank', principal: 10e6, rate: 0.0465, start: dayFromYMD(2005, 5, 1), mat: dayFromYMD(2055, 5, 1), profile: 'Maturity', nextCall: dayFromYMD(ymdFromDay(end).y + 1, 5, 1) }),
    makeLoan({ ref: 'LOBO2', type: 'LOBO', lender: N.LOBO_LENDERS[1], lenderType: 'UK bank', principal: 10e6, rate: 0.0438, start: dayFromYMD(2006, 2, 1), mat: dayFromYMD(2056, 2, 1), profile: 'Maturity', nextCall: dayFromYMD(ymdFromDay(end).y + 5, 2, 1) }),
  ];
  const pwlbNarr = (ref: string, what: 'INT' | 'PRIN' | 'ADV') => {
    const k = rng.next();
    if (k < 0.12) return `TRF ${rng.digits(5)} REF ${ref}`; // cryptic
    if (k < 0.3) return what === 'ADV' ? 'P.W.L.B ADVANCE' : `P.W.L.B ${what}`;
    if (k < 0.5) return `DMO PWLB LN ${ref} ${what}`;
    if (k < 0.65) return what === 'ADV' ? 'PUBLIC WORKS LOAN BOARD' : `PUBLIC WORKS LOAN ${what === 'INT' ? 'INTEREST' : 'REPAYMNT'}`;
    if (k < 0.8) return `UK DEBT MGMT OFFICE ${ref}`;
    return `PWLB ${what} ${ref}`;
  };
  const positions: Pos[] = [];
  const deals: Pos[] = [];                     // every deal ever, for the register
  const open = (p: Pos) => { positions.push(p); deals.push(p); };
  const mmf = N.MMF_FUNDS.map(() => 0);
  mmf[0] = 12e6; mmf[1] = 8e6; mmf[2] = 5e6;
  open({ kind: 'dmadf', principal: 10e6, start: start - 20, mat: nextBusinessDay(start + 25), rate: bankRate(start), cp: 'DMADF', ref: rng.digits(6), deposit: true });
  open({ kind: 'la_loan', principal: 10e6, start: start - 100, mat: nextBusinessDay(start + 60), rate: 0.002, cp: `${N.TOWNS[3].toUpperCase()} CITY COUNCIL`, ref: `LA/${rng.digits(2)}/${rng.digits(3)}`, deposit: false });
  open({ kind: 'la_loan', principal: 5e6, start: start - 50, mat: nextBusinessDay(start + 120), rate: 0.002, cp: `${N.TOWNS[7].toUpperCase()} BOROUGH COUNCIL`, ref: `LA/${rng.digits(2)}/${rng.digits(3)}`, deposit: false });

  const netByDay = new Map<Day, number>();
  for (const t of out) if (t.account === 0) netByDay.set(t.day, (netByDay.get(t.day) ?? 0) + t.amount);

  let bal = opening[0];
  const ambiguousDay = nextBusinessDay(start + Math.floor((end - start) * 0.3));
  for (let d = start; d <= end; d++) {
    bal += netByDay.get(d) ?? 0;
    if (!isBusinessDay(d)) continue;
    const today: [number, string, string][] = [];
    const tx = (amt: number, narr: string, cat: string) => { today.push([amt, narr, cat]); bal += amt; };
    // Loan servicing: each scheduled date posts on its next business day
    for (const l of [...loans, ...lobos]) {
      for (const x of l.life) {
        if (nextBusinessDay(x.day) !== d) continue;
        if (l.type === 'LOBO') { if (x.interest > 0.5) tx(-x.interest, rng.chance(0.6) ? `LOBO INT ${l.lender}` : `${l.lender.slice(0, 14)} LN INT ${rng.digits(5)}`, 'lobo'); continue; }
        if (x.principal > 0.5) tx(-x.principal, pwlbNarr(l.ref, 'PRIN'), 'pwlb');
        if (x.interest > 0.5) tx(-x.interest, pwlbNarr(l.ref, 'INT'), 'pwlb');
      }
    }
    const { y: yy, m: mm } = ymdFromDay(d);
    const firstBD = nextBusinessDay(dayFromYMD(yy, mm, 1)) === d;
    // Maturing positions
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i];
      if (p.mat > d) continue;
      const interest = p.principal * p.rate * (p.mat - p.start) / 365;
      if (p.deposit) {
        const isD = p.kind === 'dmadf';
        tx(p.principal, isD ? rng.pick(['DMADF MATURITY', `DMO DMADF ${p.ref} MAT`, `DEBT MANAGEMENT OFFICE ${p.ref}`, `TRF ${rng.digits(5)} REF ${p.ref}`]) : rng.pick([`FD MATURITY ${p.cp}`, `REF FD/${p.ref}`, `TRF ${rng.digits(5)} REF FD/${p.ref}`]), isD ? 'dmadf' : 'bank_deposits');
        if (interest > 1) tx(interest, isD ? rng.pick(['DMADF INT', `DMO INTEREST ${p.ref}`]) : rng.pick([`FD INT ${p.cp}`, `INT FD/${p.ref}`]), 'treasury_interest');
      } else {
        tx(-p.principal, rng.chance(0.4) ? `${p.cp} LOAN REPAYMENT` : rng.chance(0.5) ? `TRF ${rng.digits(5)} REF ${p.ref}` : `CHAPS ${p.cp.slice(0, 18)} ${p.ref}`, 'la_loans');
        tx(-interest, rng.chance(0.5) ? `${p.cp} LOAN INT` : `CHAPS INT ${p.ref}`, 'la_loans');
      }
      positions.splice(i, 1);
    }
    // MMF monthly dividends
    if (firstBD) {
      N.MMF_FUNDS.forEach((f, i) => { if (mmf[i] > 1e5) tx(mmf[i] * Math.max(0.0005, bankRate(d) - 0.001) / 12, rng.chance(0.5) ? `${f.short} DIVIDEND` : `${f.name} INT`, 'treasury_interest'); });
    }
    // A deliberately ambiguous £4m short loan from a neighbouring council (same day as a £4m grant)
    if (d === ambiguousDay) {
      open({ kind: 'la_loan', principal: 4e6, start: d, mat: nextBusinessDay(d + 91), rate: bankRate(d) + 0.002, cp: 'BRAMFORD BOROUGH COUNCIL', ref: `LA/${String(yy).slice(2)}/${rng.digits(3)}`, deposit: false });
      tx(4e6, 'BRAMFORD BOROUGH COUNCIL', 'la_loans');
    }
    // Annual PWLB refinancing of short-term LA borrowing
    const laBorrow = positions.filter((p) => !p.deposit).reduce((s, p) => s + p.principal, 0);
    if (mm === 10 && ymdFromDay(d).d <= 7 && laBorrow > 30e6 && !loans.some((l) => l.start > d - 60)) {
      const amt = Math.round(laBorrow * 0.8 / 5e6) * 5e6;
      const ref = rng.digits(6);
      const { d: dd } = ymdFromDay(d);
      loans.push(makeLoan({ ref, type: 'PWLB fixed', lender: 'Public Works Loan Board', lenderType: 'PWLB', principal: amt, rate: Math.round((bankRate(d) + 0.008) * 10000) / 10000, start: d, mat: dayFromYMD(yy + rng.int(10, 40), mm, dd), profile: rng.pick(['Maturity', 'Annuity', 'EIP'] as const) }));
      tx(amt, pwlbNarr(ref, 'ADV'), 'pwlb');
    }
    // Cash manager: target £0.5m–£3m
    const hi = 3e6, lo = 0.5e6, target = 1.5e6;
    if (bal > hi) {
      let surplus = bal - target;
      if (surplus >= 5e6 && rng.chance(0.35)) {
        const amt = Math.floor(surplus / 1e6) * 1e6 - (rng.chance(0.5) ? 0 : 1e6);
        if (amt >= 2e6) {
          const isD = rng.chance(0.6);
          const term = rng.pick([7, 14, 21, 28, 35, 63, 91, 182]);
          const ref = `${String(ymdFromDay(d).y).slice(2)}/${rng.digits(3)}`;
          const bank = rng.pick(N.BANKS);
          open({ kind: isD ? 'dmadf' : 'fd', principal: amt, start: d, mat: nextBusinessDay(d + term), rate: bankRate(d) - (isD ? 0.0005 : -0.001), cp: isD ? 'DMADF' : bank.short, bank: bank.name, ref, deposit: true });
          tx(-amt, isD ? rng.pick(['DMADF DEPOSIT', `DMO DMADF DEP ${ref}`, `TRF ${rng.digits(5)} REF ${ref}`]) : rng.pick([`FIXED DEPOSIT ${bank.name}`, `FD/${ref} ${bank.short}`, `TRF ${rng.digits(5)} REF FD/${ref}`]), isD ? 'dmadf' : 'bank_deposits');
          surplus -= amt;
        }
      }
      if (surplus > 0.25e6) {
        const i = rng.int(0, N.MMF_FUNDS.length - 1);
        const amt = Math.round(surplus / 5e4) * 5e4;
        mmf[i] += amt;
        const f = N.MMF_FUNDS[i];
        tx(-amt, rng.chance(0.25) ? `MMF SUB ${rng.digits(7)}` : rng.chance(0.5) ? `${f.name} SUBSCRIPTION` : `${f.short} ${rng.digits(6)}`, 'mmf');
      }
    } else if (bal < lo) {
      let need = target - bal;
      for (let i = 0; i < mmf.length && need > 0; i++) {
        const w = Math.min(mmf[i], Math.ceil(need / 5e4) * 5e4);
        if (w <= 0) continue;
        mmf[i] -= w; need -= w;
        const f = N.MMF_FUNDS[i];
        tx(w, rng.chance(0.25) ? `REDM ${rng.digits(7)}` : rng.chance(0.5) ? `${f.name} REDEMPTION` : `${f.short} ${rng.digits(6)}`, 'mmf');
      }
      if (need > 0) {
        const amt = Math.ceil((need + 2e6) / 5e6) * 5e6;
        const town = rng.pick(N.TOWNS.filter((t) => !N.NEIGHBOURS.includes(t) || rng.chance(0.3)));
        const cp = `${town.toUpperCase()} ${rng.pick(N.COUNCIL_TYPES)}`;
        const ref = `LA/${String(ymdFromDay(d).y).slice(2)}/${rng.digits(3)}`;
        open({ kind: 'la_loan', principal: amt, start: d, mat: nextBusinessDay(d + rng.pick([30, 60, 91, 182, 273, 364])), rate: bankRate(d) + 0.002, cp, ref, deposit: false });
        tx(amt, rng.chance(0.35) ? `${cp} LOAN` : rng.chance(0.5) ? `TRF ${rng.digits(5)} REF ${ref}` : cp, 'la_loans');
      }
    }
    for (const [amt, narr, cat] of today) add(d, amt, narr, cat);
    if (V > 2 && rng.chance(Math.min(0.6, V / 30))) {
      const i = rng.int(0, mmf.length - 1);
      if (mmf[i] > 2e6) {
        const amt = Math.round(rng.range(0.5e6, 2e6) / 5e4) * 5e4;
        add(d, amt, `${N.MMF_FUNDS[i].name} REDEMPTION`, 'mmf');
        add(d, -amt, `${N.MMF_FUNDS[(i + 1) % mmf.length].name} SUBSCRIPTION`, 'mmf');
        mmf[i] -= amt; mmf[(i + 1) % mmf.length] += amt;
      }
    }
  }
  return buildRegisterSnapshot({ loans, lobos, deals, mmf, end, start });
}

const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bBc\b/, 'BC').replace(/\bMetropolitan Bc\b/, 'Metropolitan BC');

/** The example council's deal register at the end of its history, in the register's snapshot form. */
function buildRegisterSnapshot(x: { loans: GLoan[]; lobos: GLoan[]; deals: Pos[]; mmf: number[]; end: Day; start: Day }) {
  const asAt = x.end;
  let row = 4;
  const outstanding = (l: GLoan) => l.principal - l.life.filter((p) => p.day <= asAt).reduce((s, p) => s + p.principal, 0);
  const loansRows = [...x.loans, ...x.lobos].filter((l) => l.mat > x.start - 1).map((l) => {
    const matured = l.mat <= asAt;
    return {
      row: row++, type: l.type, lender: l.type === 'LOBO' ? title(l.lender) : 'Public Works Loan Board', lenderType: l.lenderType,
      principal: Math.round(matured ? l.principal : outstanding(l)), start: isoOf(l.start), maturity: isoOf(l.mat), rate: l.rate,
      profile: l.profile, frequency: 'Half-yearly', firstRepayment: null, fund: '', nextCall: l.nextCall ? isoOf(l.nextCall) : null,
    };
  });
  for (const p of x.deals.filter((p) => !p.deposit)) {
    loansRows.push({
      row: row++, type: p.mat - p.start <= 364 ? 'Temporary borrowing' : 'Local authority loan', lender: title(p.cp), lenderType: 'Local authority',
      principal: p.principal, start: isoOf(p.start), maturity: isoOf(p.mat), rate: Math.round(p.rate * 100000) / 100000, profile: 'Maturity', frequency: '', firstRepayment: null, fund: '', nextCall: null,
    } as never);
  }
  row = 4;
  const term = x.deals.filter((p) => p.deposit).map((p) => ({
    row: row++, type: 'Fixed deposit', counterparty: p.kind === 'dmadf' ? 'UK Debt Management Office' : (p.bank ?? p.cp), cpType: p.kind === 'dmadf' ? 'UK Government' : /BUILDING SOC/.test(p.bank ?? '') ? 'Building society' : 'UK bank',
    principal: p.principal, start: isoOf(p.start), maturity: isoOf(p.mat), rate: Math.round(p.rate * 100000) / 100000, faceValue: null, carryingValue: null, rating: p.kind === 'dmadf' ? '' : 'A',
  }));
  row = 4;
  const call = N.MMF_FUNDS.map((f, i) => ({ row: row++, type: 'Money market fund', counterparty: f.name.replace(/\b[A-Z]+\b/g, (w) => w[0] + w.slice(1).toLowerCase()), cpType: 'Money market fund', balance: Math.round(x.mmf[i] / 1000) * 1000, rate: Math.max(0.0005, bankRate(asAt) - 0.001), noticeDays: null, rating: 'AAAm', avgBalance: null, avgRate: null }));

  // The top-down projection (£m): CFR from the debt and resources at the as-at date,
  // a five-year capital programme financed by borrowing, MRP at 3.5%, reserves used.
  const extDebt = loansRows.filter((l) => l.maturity > isoOf(asAt) && !(l.start > isoOf(asAt))).reduce((s, l) => s + l.principal, 0) / 1e6;
  const invested = (term.filter((t) => t.maturity > isoOf(asAt)).reduce((s, t) => s + t.principal, 0) + call.reduce((s, c) => s + c.balance, 0)) / 1e6;
  const obs0 = 95;
  const cfr0 = Math.round((extDebt - invested + obs0) * 10) / 10;
  const fy0 = fyOf(asAt);
  const capex = [46, 48, 41, 34, 28];
  const rows: (string | number | null)[][] = [];
  let cfr = cfr0;
  for (let k = 0; k <= 30; k++) {
    const yLabel = `${fy0 + k}/${String((fy0 + k + 1) % 100).padStart(2, '0')}`;
    let mrp = 0, cx = 0, rec = 0;
    if (k > 0) { cx = capex[k - 1] ?? 0; mrp = Math.round(cfr * 0.035 * 10) / 10; rec = k <= 5 ? 2 : 0; cfr = Math.round((cfr + cx - mrp - rec) * 10) / 10; }
    const obs = Math.round(obs0 * Math.max(0.6, Math.pow(0.95, k)) * 10) / 10;
    rows.push([yLabel, cfr, k ? mrp : Math.round(cfr0 * 0.035 * 10) / 10, k ? rec : null, obs, null, null, 10, k ? cx : null]);
  }
  return {
    v: 1, name: 'Northbridge Council deal register (example)', asAt: isoOf(asAt), hra: 'None', version: 3, periodFrom: isoOf(dayFromYMD(fyOf(asAt), 4, 1)),
    settingsIssues: [],
    projections: { gf: { head: ['Year end', 'Capital financing requirement', 'MRP', 'Capital receipts applied', 'Other balance sheet items', 'Existing loan commitments', 'Existing investment commitments', 'Liquidity allowance', 'Capital expenditure financed by borrowing'], rows, title: 'General Fund', at: 'A5' } },
    readiness: null,
    term, call, loans: loansRows, funds: [],
  };
}
