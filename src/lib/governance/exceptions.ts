// Exceptions: lines in the statements that deserve a second look before they're accepted. A
// detective check on the money that actually moved, alongside (not instead of) purchase-to-pay
// controls. Each is found from the lines read in this session, against what the saved history
// already knows: the payees seen before (kept only as one-way hashes) and each regular payment's
// usual amounts and dates.
import type { Dataset } from '../ingest/ingest';
import { type CatResult, DEAL_NO, CONF_LOW, F_LARGE, F_OUTLIER } from '../categorise/engine';
import type { CashHistory } from '../history/cashHistory';
import { hashString } from '../rng';
import { isBusinessDay, isBankHoliday, weekday, type Day } from '../dates';

export type ExceptionKind = 'duplicate' | 'out_of_line' | 'new_payee' | 'large_one_off' | 'non_working_day' | 'unsorted';

/** in the order they're shown: the likeliest to need action first */
export const EXCEPTION_KINDS: { kind: ExceptionKind; label: string; what: string }[] = [
  { kind: 'duplicate', label: 'Possible duplicate', what: 'The same payee and amount twice within a few days.' },
  { kind: 'out_of_line', label: 'Out of line', what: 'Much more than this payee’s usual amount.' },
  { kind: 'new_payee', label: 'New payee', what: 'A payee not seen in your history before, above your threshold.' },
  { kind: 'large_one_off', label: 'Large one-off', what: 'A one-off, unusually large for its category.' },
  { kind: 'non_working_day', label: 'Non-working day', what: 'Money moved on a weekend or bank holiday.' },
  { kind: 'unsorted', label: 'Not sorted', what: 'Not sorted, or sorted only by a weak guess.' },
];

export interface ExceptionSettings {
  /** lines smaller than this aren't raised (duplicates and unsorted lines: a tenth of it) */
  minAmount: number;
  /** "out of line": more than this many times the payee's usual amount */
  factor: number;
  /** "possible duplicate": the same payee and amount within this many days */
  dupDays: number;
}
export const DEFAULT_EXCEPTION_SETTINGS: ExceptionSettings = { minAmount: 25_000, factor: 2.5, dupDays: 5 };

export interface ExceptionItem {
  /** stable and private: a hash of the kind, account, day, amount and payee (no bank details) */
  key: string;
  kind: ExceptionKind;
  /** the dataset rows it's about (two for a duplicate) */
  rows: number[];
  day: Day;
  amount: number;
  signature: string;
  why: string;
}

/** What the saved history knows: payees seen before (hashed), and regular payments' amounts and dates. */
export interface Known {
  /** null when the history doesn't hold them (saved before payees were kept, or no history) */
  seen: Set<string> | null;
  regular: Map<string, { amounts: number[]; days: number[] }>;
}

/** banking words around a payee's name that change from line to line, and company endings */
const NOISE = new Set(['BACS', 'FPS', 'FP', 'CHAPS', 'DD', 'SO', 'STO', 'TFR', 'TRF', 'TRANSFER', 'PAYMENT', 'PAYMENTS', 'PYMT', 'PMT', 'INV', 'INVOICE', 'REF', 'CR', 'DR', 'CHQ', 'BGC', 'DIRECT', 'DEBIT', 'CREDIT', 'FASTER', 'RECEIVED', 'TO', 'FROM', 'LTD', 'PLC', 'LLP', 'LIMITED', 'THE', 'AND', 'OF', 'BANK', 'GIRO']);

/** The core of a payee's name: "BACS NORTHSHIRE CONSULTING LLP INV" and "NORTHSHIRE CONSULTING LLP" are one payee. */
export function payeeKey(signature: string): string {
  const words = signature.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !NOISE.has(w));
  return words.slice(0, 3).join(' ') || signature.toUpperCase().trim();
}

/** a payee, one-way hashed: enough to tell whether it was seen before, nothing more */
export const payeeHash = (signature: string) => (hashString(payeeKey(signature)) >>> 0).toString(36);

export function knownFrom(h: CashHistory | null | undefined): Known {
  const regular = new Map<string, { amounts: number[]; days: number[] }>();
  for (const s of h?.series ?? []) {
    const k = `${s.sig}|${s.dir}`;
    const r = regular.get(k) ?? { amounts: [], days: [] };
    for (const [d, p] of s.occ) { r.amounts.push(Math.abs(p) / 100); r.days.push(d); }
    regular.set(k, r);
  }
  return { seen: h?.seen ? new Set(h.seen) : null, regular };
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (x: number) => `£${Math.abs(x) >= 1e6 ? `${(Math.abs(x) / 1e6).toFixed(1)}m` : Math.abs(x) >= 1e3 ? `${Math.round(Math.abs(x) / 1e3)}k` : Math.round(Math.abs(x))}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The lines between `from` and `to` (all of this session's by default) that deserve a look.
 * Transfers between the council's own accounts are left out, and so are loans and investments,
 * except where they're unsorted.
 */
export function findExceptions(ds: Dataset, res: CatResult, known: Known, st: ExceptionSettings = DEFAULT_EXCEPTION_SETTINGS, from = ds.minDay, to = ds.maxDay): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  const internal = res.catIds.indexOf('internal_transfer');
  const sigOf = (i: number) => res.signatures[res.sig[i]];
  const key = (kind: ExceptionKind, i: number) => (hashString(`${kind}|${ds.accounts[ds.account[i]]}|${ds.day[i]}|${Math.round(ds.amount[i] * 100)}|${sigOf(i)}`) >>> 0).toString(36);
  const flagged = new Set<number>();
  const add = (kind: ExceptionKind, rows: number[], why: string) => {
    const i = rows[0];
    out.push({ key: key(kind, i), kind, rows, day: ds.day[i], amount: ds.amount[i], signature: sigOf(i), why });
    for (const r of rows) flagged.add(r);
  };
  const inRange: number[] = [];
  for (let i = 0; i < ds.n; i++) if (ds.day[i] >= from && ds.day[i] <= to && res.cat[i] !== internal) inRange.push(i);
  const everyday = (i: number) => res.deal[i] === DEAL_NO;

  // the session's own first sighting of each payee, for when the history holds no payees
  const firstPayee = new Map<string, Day>();
  for (let i = 0; i < ds.n; i++) { const k = payeeKey(res.signatures[res.sig[i]]); if (!firstPayee.has(k)) firstPayee.set(k, ds.day[i]); }
  const sessionLong = ds.maxDay - ds.minDay >= 180;

  // ---- possible duplicates: the same payee and amount within a few days (here, or in the history)
  const groups = new Map<string, number[]>();
  for (const i of inRange) {
    if (!everyday(i) || Math.abs(ds.amount[i]) < st.minAmount / 10) continue;
    const k = `${res.sig[i]}|${Math.round(ds.amount[i] * 100)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => ds.day[a] - ds.day[b]);
    for (let k = 1; k < rows.length; k++) {
      const gap = ds.day[rows[k]] - ds.day[rows[k - 1]];
      if (gap <= st.dupDays) add('duplicate', [rows[k - 1], rows[k]], gap === 0 ? `Paid twice on the same day: ${money(ds.amount[rows[k]])} each.` : `The same ${money(ds.amount[rows[k]])} ${gap} day${gap === 1 ? '' : 's'} apart.`);
    }
  }
  for (const i of inRange) {
    if (flagged.has(i) || !everyday(i) || Math.abs(ds.amount[i]) < st.minAmount / 10) continue;
    const r = known.regular.get(`${sigOf(i)}|${ds.amount[i] < 0 ? -1 : 1}`);
    if (!r) continue;
    const p = Math.abs(ds.amount[i]);
    const near = r.days.findIndex((d, k) => d !== ds.day[i] && Math.abs(d - ds.day[i]) <= st.dupDays && Math.abs(r.amounts[k] - p) < 0.01);
    if (near >= 0) add('duplicate', [i], `The same ${money(p)} was paid on a day already in your history, ${Math.abs(r.days[near] - ds.day[i])} days apart.`);
  }

  for (const i of inRange) {
    if (flagged.has(i)) continue;
    const a = ds.amount[i], p = Math.abs(a), sig = sigOf(i);
    // ---- out of line with the payee's usual amount
    if (everyday(i) && p >= st.minAmount) {
      const sid = res.series[i];
      const usual = sid >= 0 ? Math.abs(res.seriesList[sid].typicalAmount) : median(known.regular.get(`${sig}|${a < 0 ? -1 : 1}`)?.amounts ?? []);
      if (usual > 0 && p > st.factor * usual) { add('out_of_line', [i], `${money(p)}, about ${(p / usual).toFixed(1)} times this payee’s usual ${money(usual)}.`); continue; }
    }
    // ---- a payee not seen before, being paid (a new supplier is where the risk is; large new
    // receipts show as one-offs)
    if (everyday(i) && a < 0 && p >= st.minAmount) {
      const isNew = known.seen ? !known.seen.has(payeeHash(sig)) : sessionLong && (firstPayee.get(payeeKey(sig)) ?? 0) >= ds.maxDay - 30;
      if (isNew) { add('new_payee', [i], known.seen ? `${money(p)} paid to a payee not in your history before.` : `${money(p)} paid to a payee who first appears in the last month of these statements.`); continue; }
    }
    // ---- a large one-off
    if (everyday(i) && p >= st.minAmount && res.oneOff[i] && (res.flags[i] & (F_LARGE | F_OUTLIER))) {
      const cat = res.cat[i] >= 0 ? res.catIds[res.cat[i]].replace(/_/g, ' ') : 'its category';
      add('large_one_off', [i], `A one-off ${money(p)}, unusually large for ${cat}.`); continue;
    }
    // ---- money moving on a non-working day
    if (p >= st.minAmount && !isBusinessDay(ds.day[i])) {
      add('non_working_day', [i], `${money(p)} on ${isBankHoliday(ds.day[i]) ? 'a bank holiday' : `a ${DAYS[weekday(ds.day[i])]}`}.`); continue;
    }
    // ---- not sorted, or only by a weak guess
    if (res.cat[i] < 0 && p >= st.minAmount / 10) { add('unsorted', [i], `${money(p)} not sorted into a category yet.`); continue; }
    if (res.cat[i] >= 0 && res.conf[i] === CONF_LOW && p >= st.minAmount) add('unsorted', [i], res.deal[i] !== DEAL_NO ? `${money(p)} that looks like a loan or investment, by a weak guess: confirm it on Check the sorting.` : `${money(p)} sorted only by a weak guess: confirm it on Check the sorting.`);
  }
  // a line raised for something else that also moved on a non-working day says so too
  for (const e of out) {
    if (e.kind === 'non_working_day' || isBusinessDay(e.day)) continue;
    e.why += ` And on ${isBankHoliday(e.day) ? 'a bank holiday' : `a ${DAYS[weekday(e.day)]}`}.`;
  }
  const order = EXCEPTION_KINDS.map((k) => k.kind);
  return out.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || Math.abs(y.amount) - Math.abs(x.amount));
}

/** What someone decided about an exception: looked at and fine, or a query raised. */
export interface ExceptionReview {
  key: string;
  status: 'checked' | 'query';
  by: string;
  /** ISO timestamp */
  at: string;
  note?: string;
}

/** The latest review of each exception, by key. */
export function latestReviews(reviews: ExceptionReview[] | undefined): Map<string, ExceptionReview> {
  const m = new Map<string, ExceptionReview>();
  for (const r of reviews ?? []) { const cur = m.get(r.key); if (!cur || r.at >= cur.at) m.set(r.key, r); }
  return m;
}
