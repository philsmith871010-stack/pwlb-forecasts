// Render ground-truth transactions as deliberately messy bank exports ("dialects").

import { Rng } from '../lib/rng';
import { Day, ymdFromDay, isoFromDay, MONTH_NAMES } from '../lib/dates';
import { TrueTxn, ACCOUNT_NAMES, ACCOUNT_NUMBERS } from './engine';
import { AUTHORITY } from './names';

export type DialectId = 'A' | 'B' | 'C' | 'D' | 'E';

export const DIALECT_DESCRIPTIONS: Record<DialectId, string> = {
  A: 'Debit/Credit columns, running balance, DD/MM/YYYY, everything quoted',
  B: 'Single signed Value column, balance, "DD Mon YYYY" dates, truncated narratives',
  C: 'Signed text amounts with £ and brackets, junk columns, mixed case',
  D: 'Title rows above header, ISO dates, Paid out / Paid in, split narrative, footer totals',
  E: 'Semicolon-delimited, Excel serial dates, CR/DR suffixes',
};

export interface TruthFile {
  kind: 'cash-flow-insight-truth';
  version: 1;
  seed: string;
  generatedAt: string;
  categories: string[];
  files: TruthFileEntry[];
}

export interface TruthFileEntry {
  name: string;
  account: string;
  dialect: DialectId;
  /** Columnar arrays, one entry per data row */
  line: number[];
  cat: number[];
  /** '0'/'1' strings, one char per data row */
  deal: string;
  recurring: string;
  dup: string;
  day: number[];
  pence: number[];
  /** Data rows that were deliberately written with an invalid date */
  badDate: string;
}

export interface RenderOptions {
  nastiness: number;
  seed: string;
}

interface Row { t: TrueTxn; balance: number }

function csvField(s: string, forceQuote: boolean, delim = ','): string {
  if (forceQuote || s.includes(delim) || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const fmt2 = (x: number) => x.toFixed(2);
function thousands(x: number): string {
  const [i, d] = Math.abs(x).toFixed(2).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
}

function excelSerial(day: Day): number {
  return day + 25569; // 1970-01-01 = 25569 in Excel's 1900 system
}

class Chaos {
  constructor(private rng: Rng, private n: number) {}
  p(x: number) { return this.rng.chance(x * this.n); }

  narrative(s: string, maxLen: number, caseMode: 'upper' | 'mixed'): string {
    let out = s;
    if (this.p(0.02)) out = out.replace(/&/g, 'AND');
    if (this.p(0.015)) out = out.replace(/ /, '  ');
    if (this.p(0.01)) out = '  ' + out + '   ';
    if (this.p(0.004)) out = out.replace(/'/g, 'â€™').replace(/ /, ' Â£ ');
    if (this.p(0.003)) out = out + ' â€œREFâ€\u009d';
    if (this.p(0.02)) out = out + ' ' + this.rng.digits(this.rng.int(6, 12));
    if (caseMode === 'mixed') out = out.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    if (maxLen && out.length > maxLen) out = out.slice(0, maxLen);
    return out;
  }

  /** Mostly the file's own date format, with occasional alternates, US-style swaps and invalid dates. */
  date(day: Day, primary: (d: Day) => string): { text: string; bad: boolean } {
    if (this.p(0.0002)) {
      const { y } = ymdFromDay(day);
      return { text: this.rng.pick([`31/02/${y}`, `00/13/${y}`, 'TBC', `${y}-02-30`, '']), bad: true };
    }
    if (this.p(0.001)) {
      const { y, m, d } = ymdFromDay(day);
      // US-style month/day — detectable when day > 12, silently ambiguous otherwise
      return { text: `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`, bad: false };
    }
    if (this.p(0.003)) return { text: isoFromDay(day), bad: false };
    if (this.p(0.002)) {
      const { y, m, d } = ymdFromDay(day);
      return { text: `${String(d).padStart(2, '0')}-${MONTH_NAMES[m - 1]}-${String(y).slice(2)}`, bad: false };
    }
    return { text: primary(day), bad: false };
  }
}

const dmy = (day: Day) => { const { y, m, d } = ymdFromDay(day); return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`; };
const dMonY = (day: Day) => { const { y, m, d } = ymdFromDay(day); return `${String(d).padStart(2, '0')} ${MONTH_NAMES[m - 1]} ${y}`; };

function typeCode(t: TrueTxn, rng: Rng): string {
  if (/^DD|BACS DD|DD CREDIT/.test(t.narr)) return 'DD';
  if (/^CHAPS/.test(t.narr)) return 'CHP';
  if (/^FPS/.test(t.narr)) return 'FPO';
  if (/^BACS|BACS/.test(t.narr)) return 'BAC';
  if (/SWEEP|TFR|FUNDING/.test(t.narr)) return 'TFR';
  if (/CARD/.test(t.narr)) return 'CRD';
  return t.amount >= 0 ? rng.pick(['CR', 'BGC', 'CR']) : rng.pick(['DEB', 'CHG', 'DR']);
}

export interface RenderedFile { name: string; text: string; truth: TruthFileEntry }

export function renderFiles(
  txns: TrueTxn[],
  accounts: number,
  openingBalances: number[],
  opts: RenderOptions,
  categoryIds: string[],
): RenderedFile[] {
  const rng = new Rng(opts.seed + ':render');
  const chaos = new Chaos(rng, opts.nastiness);
  const catIndex = new Map(categoryIds.map((c, i) => [c, i]));
  const files: RenderedFile[] = [];

  // Running balances per account (computed on clean, in-order data, duplicates included — the bank posted them)
  const byAcct: Row[][] = Array.from({ length: accounts }, () => []);
  const bal = openingBalances.slice();
  for (const t of txns) {
    bal[t.account] += t.amount;
    byAcct[t.account].push({ t, balance: Math.round(bal[t.account] * 100) / 100 });
  }

  const makeTruth = (name: string, account: number, dialect: DialectId): TruthFileEntry => ({
    name, account: ACCOUNT_NAMES[account], dialect, line: [], cat: [], deal: '', recurring: '', dup: '', day: [], pence: [], badDate: '',
  });
  const pushTruth = (tr: TruthFileEntry, line: number, t: TrueTxn, bad: boolean) => {
    tr.line.push(line);
    tr.cat.push(catIndex.get(t.cat) ?? -1);
    tr.deal += t.deal ? '1' : '0';
    tr.recurring += t.recurring ? '1' : '0';
    tr.dup += t.dup ? '1' : '0';
    tr.day.push(t.day);
    tr.pence.push(Math.round(t.amount * 100));
    tr.badDate += bad ? '1' : '0';
  };

  const yr = (d: Day) => ymdFromDay(d).y;

  // ---------- Dialect A ----------
  const renderA = (rows: Row[], account: number, name: string) => {
    const tr = makeTruth(name, account, 'A');
    const lines: string[] = ['"Date","Type","Sort Code","Account Number","Description","Debit Amount","Credit Amount","Balance"'];
    for (const { t, balance } of rows) {
      const { text, bad } = chaos.date(t.day, dmy);
      const amt = Math.abs(t.amount);
      const money = (x: number) => (chaos.p(0.01) ? '£' : '') + thousands(x);
      let debit = t.amount < 0 ? money(amt) : '';
      const credit = t.amount >= 0 ? money(amt) : '';
      if (debit && chaos.p(0.004)) debit = '-' + debit; // the odd sign flipped versus convention
      const f = [text, typeCode(t, rng), '30-12-80', ACCOUNT_NUMBERS[account], chaos.narrative(t.narr, 35, 'upper'), debit, credit, thousands(balance) + (balance < 0 ? '' : '')];
      if (balance < 0) f[7] = '-' + f[7];
      pushTruth(tr, lines.length, t, bad);
      lines.push(f.map((x) => csvField(x, true)).join(','));
      if (chaos.p(0.0005)) lines.push('');
    }
    files.push({ name, text: lines.join('\r\n') + '\r\n', truth: tr });
  };

  // ---------- Dialect B ----------
  const renderB = (rows: Row[], account: number, name: string) => {
    const tr = makeTruth(name, account, 'B');
    const lines: string[] = ['Date,Type,Description,Value,Balance,Account Name,Account Number'];
    for (const { t, balance } of rows) {
      const { text, bad } = chaos.date(t.day, dMonY);
      let v = fmt2(t.amount);
      if (chaos.p(0.01)) v = (t.amount < 0 ? '-' : '') + 'Â£' + fmt2(Math.abs(t.amount));
      const f = [text, typeCode(t, rng), chaos.narrative(t.narr, 30, 'upper'), v, fmt2(balance), ACCOUNT_NAMES[account].toUpperCase(), `'${ACCOUNT_NUMBERS[account]}`];
      pushTruth(tr, lines.length, t, bad);
      lines.push(f.map((x) => csvField(x, false)).join(','));
    }
    files.push({ name, text: lines.join('\n') + '\n', truth: tr });
  };

  // ---------- Dialect C ----------
  const renderC = (rows: Row[], account: number, name: string) => {
    const tr = makeTruth(name, account, 'C');
    const lines: string[] = ['Number,Date,Account,Amount,Subcategory,Memo,Transaction ID,Bank Category,Notes'];
    let n = 1;
    for (const { t } of rows) {
      const { text, bad } = chaos.date(t.day, dmy);
      let amt: string;
      const k = rng.next();
      if (t.amount < 0 && k < 0.5) amt = `(${thousands(t.amount)})`;
      else if (k < 0.75) amt = (t.amount < 0 ? '-' : '') + '£' + thousands(t.amount);
      else amt = fmt2(t.amount);
      const f = [String(n++), text, `${ACCOUNT_NUMBERS[account]} ${ACCOUNT_NAMES[account]}`, amt, typeCode(t, rng), chaos.narrative(t.narr, 0, rng.chance(0.6) ? 'mixed' : 'upper'),
        `TX${rng.digits(10)}`, rng.pick(['Payments', 'Transfers', 'Income', 'Other', 'Bills']), rng.chance(0.03) ? rng.pick(['checked', 'query w/ finance', 'see email 12/3']) : ''];
      pushTruth(tr, lines.length, t, bad);
      lines.push(f.map((x) => csvField(x, false)).join(','));
    }
    files.push({ name, text: lines.join('\n'), truth: tr });
  };

  // ---------- Dialect D ----------
  const renderD = (rows: Row[], account: number, name: string) => {
    const tr = makeTruth(name, account, 'D');
    const first = rows[0]?.t.day ?? 0, last = rows[rows.length - 1]?.t.day ?? 0;
    const lines: string[] = [
      `${AUTHORITY} - ${ACCOUNT_NAMES[account]} (${ACCOUNT_NUMBERS[account]})`,
      `Statement period: ${isoFromDay(first)} to ${isoFromDay(last)}`,
      `Exported ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Posting Date,Value Date,Narrative 1,Narrative 2,Reference,Paid out,Paid in',
    ];
    let tOut = 0, tIn = 0;
    for (const { t } of rows) {
      const { text, bad } = chaos.date(t.day, isoFromDay);
      const narr = chaos.narrative(t.narr, 0, 'upper');
      const n1 = narr.slice(0, 18), n2 = narr.slice(18, 36);
      const ref = rng.chance(0.3) ? rng.digits(8) : '';
      const out = t.amount < 0 ? fmt2(-t.amount) : '';
      const inn = t.amount >= 0 ? fmt2(t.amount) : '';
      if (t.amount < 0) tOut -= t.amount; else tIn += t.amount;
      pushTruth(tr, lines.length, t, bad);
      lines.push([text, isoFromDay(t.day), n1, n2, ref, out, inn].map((x) => csvField(x, false)).join(','));
      if (chaos.p(0.001)) lines.push(',,,,,,');
    }
    lines.push('');
    lines.push(`,,,,TOTALS,${fmt2(tOut)},${fmt2(tIn)}`);
    lines.push(`End of statement,,,,,,`);
    files.push({ name, text: lines.join('\n') + '\n', truth: tr });
  };

  // ---------- Dialect E ----------
  const renderE = (rows: Row[], account: number, name: string) => {
    const tr = makeTruth(name, account, 'E');
    const lines: string[] = ['TxnDate;Details;Ref;Amount;Ccy'];
    for (const { t } of rows) {
      const ser = chaos.date(t.day, (d) => String(excelSerial(d)));
      const k = rng.next();
      let amt: string;
      if (k < 0.45) amt = thousands(t.amount) + (t.amount < 0 ? ' DR' : ' CR');
      else if (k < 0.6) amt = thousands(t.amount) + (t.amount < 0 ? 'DR' : 'CR');
      else if (k < 0.8 && t.amount < 0) amt = `(${thousands(t.amount)})`;
      else amt = (t.amount < 0 ? '-' : '') + thousands(t.amount);
      const ref = rng.chance(0.5) ? `R${rng.digits(7)}` : '';
      pushTruth(tr, lines.length, t, ser.bad);
      lines.push([ser.text, chaos.narrative(t.narr, 40, 'upper'), ref, amt, 'GBP'].map((x) => csvField(x, false, ';')).join(';'));
    }
    files.push({ name, text: lines.join('\r\n') + '\r\n', truth: tr });
  };

  // ---------- Assign accounts to files ----------
  const general = byAcct[0];
  if (general.length) {
    // General account: split into two exports at the mid-point, with a 3-day overlap
    const midDay = general[Math.floor(general.length / 2)].t.day;
    const first = general.filter((r) => r.t.day <= midDay + 2);
    const second = general.filter((r) => r.t.day >= midDay);
    // Rows in the overlap that appear in file 2 are duplicates of file 1
    const secondMarked = second.map((r) => (r.t.day <= midDay + 2 ? { ...r, t: { ...r.t, dup: true } } : r));
    renderA(first, 0, `northbridge_general_${yr(first[0].t.day)}-${yr(first[first.length - 1].t.day)}.csv`);
    renderE(secondMarked, 0, `northbridge_general_${yr(second[0].t.day)}-${yr(second[second.length - 1].t.day)}_erp.csv`);
  }
  if (accounts >= 2 && byAcct[1].length) renderB(byAcct[1], 1, 'northbridge_collection_account.csv');
  if (accounts >= 3 && byAcct[2].length) renderC(byAcct[2], 2, 'northbridge_payroll_account.csv');
  if (accounts >= 4 && byAcct[3].length) renderD(byAcct[3], 3, 'northbridge_schools_account.csv');
  return files;
}
