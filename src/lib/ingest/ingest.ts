// Streaming ingest: CSV → compact typed-array dataset. Works in a Web Worker (File input)
// and in node (string input) so the same code powers the app and the bench script.

import Papa from 'papaparse';
import { ColumnMapping } from './detect';
import { parseAmount, parseDate } from './parseValues';
import { normaliseAccount } from '../categorise/normalise';
import { Day } from '../dates';

export const ROW_DATE_SWAPPED = 1;
export const ROW_DUP_CANDIDATE = 2;

export interface RejectedRow {
  file: string;
  line: number;
  reason: string;
  raw: string;
}

export interface BalanceCheck {
  file: string;
  account: string;
  checked: number;
  breaks: number;
  firstBreaks: { line: number; expected: number; actual: number }[];
  openingBalance: number | null;
  openingDay: Day | null;
}

export interface FileSummary {
  name: string;
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  blankLines: number;
  firstDay: Day | null;
  lastDay: Day | null;
  accounts: string[];
  accountFromColumn: boolean;
  overlapDuplicatesRemoved: number;
  swappedDates: number;
}

export interface Dataset {
  n: number;
  day: Int32Array;
  amount: Float64Array;
  account: Uint16Array;
  file: Uint16Array;
  line: Int32Array;
  /** index into narratives */
  narr: Int32Array;
  rowFlags: Uint8Array;
  narratives: string[];
  accounts: string[];
  files: FileSummary[];
  rejects: RejectedRow[];
  balanceChecks: BalanceCheck[];
  minDay: Day;
  maxDay: Day;
  /** opening balance across accounts if derivable from balance columns */
  openingBalance: number | null;
}

export interface IngestSource {
  name: string;
  /** browser: File; node: string */
  data: File | string;
  size: number;
  mapping: ColumnMapping;
}

export type ProgressFn = (p: { phase: string; done: number; total: number; rows: number }) => void;

class Growable {
  day = new Int32Array(1 << 16);
  amount = new Float64Array(1 << 16);
  account = new Uint16Array(1 << 16);
  file = new Uint16Array(1 << 16);
  line = new Int32Array(1 << 16);
  narr = new Int32Array(1 << 16);
  flags = new Uint8Array(1 << 16);
  balance = new Float64Array(1 << 16);
  n = 0;
  push(day: number, amount: number, account: number, file: number, line: number, narr: number, flags: number, balance: number) {
    if (this.n === this.day.length) this.grow();
    const i = this.n++;
    this.day[i] = day; this.amount[i] = amount; this.account[i] = account; this.file[i] = file;
    this.line[i] = line; this.narr[i] = narr; this.flags[i] = flags; this.balance[i] = balance;
  }
  private grow() {
    const g = <T extends Int32Array | Float64Array | Uint16Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as { new (n: number): T })(a.length * 2);
      b.set(a);
      return b;
    };
    this.day = g(this.day); this.amount = g(this.amount); this.account = g(this.account); this.file = g(this.file);
    this.line = g(this.line); this.narr = g(this.narr); this.flags = g(this.flags); this.balance = g(this.balance);
  }
}

export async function ingest(sources: IngestSource[], onProgress?: ProgressFn): Promise<Dataset> {
  const G = new Growable();
  const narratives: string[] = [];
  const narrIndex = new Map<string, number>();
  const accounts: string[] = [];
  const accountIndex = new Map<string, number>();
  const rejects: RejectedRow[] = [];
  const files: FileSummary[] = [];
  const balanceChecks: BalanceCheck[] = [];
  const totalBytes = sources.reduce((s, x) => s + x.size, 0);
  let bytesBefore = 0;
  const MAX_REJECT_LOG = 5000;

  const acctId = (label: string) => {
    let i = accountIndex.get(label);
    if (i === undefined) { i = accounts.length; accounts.push(label); accountIndex.set(label, i); }
    return i;
  };
  const narrId = (s: string) => {
    let i = narrIndex.get(s);
    if (i === undefined) { i = narratives.length; narratives.push(s); narrIndex.set(s, i); }
    return i;
  };

  for (let fi = 0; fi < sources.length; fi++) {
    const src = sources[fi];
    const m = src.mapping;
    const summary: FileSummary = {
      name: src.name, rowsRead: 0, rowsAccepted: 0, rowsRejected: 0, blankLines: 0, firstDay: null, lastDay: null,
      accounts: [], accountFromColumn: m.account >= 0, overlapDuplicatesRemoved: 0, swappedDates: 0,
    };
    const defaultAcct = normaliseAccount(m.defaultAccount || src.name);
    const fileAccounts = new Set<number>();
    let lineNo = -1;
    const width = m.columns.length;
    let bal: BalanceCheck | null = m.balance >= 0 ? { file: src.name, account: '', checked: 0, breaks: 0, firstBreaks: [], openingBalance: null, openingDay: null } : null;
    let prevBal: number | null = null;

    await new Promise<void>((resolve, reject) => {
      Papa.parse<string[]>(src.data as never, {
        delimiter: m.delimiter,
        skipEmptyLines: false,
        chunkSize: 1024 * 1024 * 2,
        chunk: (res: Papa.ParseResult<string[]>) => {
          for (const r of res.data) {
            lineNo++;
            if (lineNo <= m.headerRow) continue;
            if (r.length === 1 && r[0].trim() === '') { summary.blankLines++; continue; }
            if (r.every((c) => !c || !c.trim())) { summary.blankLines++; continue; }
            summary.rowsRead++;
            const rej = (reason: string) => {
              summary.rowsRejected++;
              if (rejects.length < MAX_REJECT_LOG) rejects.push({ file: src.name, line: lineNo + 1, reason, raw: r.join(m.delimiter).slice(0, 300) });
              prevBal = null;
            };
            if (r.length < width - 1) { rej(`Only ${r.length} of ${width} columns`); continue; }
            const dateCell = r[m.date] ?? '';
            const dr = parseDate(dateCell, m.dateOrder);
            if (!dr) {
              const joined = r.join(' ').toUpperCase();
              rej(/TOTAL|END OF|BALANCE B\/?F|BROUGHT FORWARD|CARRIED FORWARD/.test(joined) ? 'Footer / total row' : dateCell.trim() ? `Unreadable date "${dateCell.trim().slice(0, 20)}"` : 'Missing date');
              continue;
            }
            let amount: number;
            if (m.amountMode === 'signed') {
              const a = parseAmount(r[m.amount] ?? '');
              if (!a) { rej(`Unreadable amount "${(r[m.amount] ?? '').slice(0, 20)}"`); continue; }
              amount = m.positiveIsIn ? a.value : -a.value;
            } else {
              const d = (r[m.debit] ?? '').trim() ? parseAmount(r[m.debit]) : { value: 0 };
              const c = (r[m.credit] ?? '').trim() ? parseAmount(r[m.credit]) : { value: 0 };
              if (!d || !c) { rej('Unreadable debit/credit amount'); continue; }
              if (!d.value && !c.value) { rej('No amount in debit or credit column'); continue; }
              amount = Math.round((Math.abs(c.value) - Math.abs(d.value)) * 100) / 100;
            }
            // narrative
            let narr: string;
            if (m.narrative.length > 1) {
              const parts = m.narrative.map((j) => r[j] ?? '');
              narr = (m.narrativeJoin === 'concat' ? parts.join('') : parts.join(' ')).trim();
            } else narr = (r[m.narrative[0]] ?? '').trim();
            if (m.reference >= 0) {
              const ref = (r[m.reference] ?? '').trim();
              if (ref && !narr.includes(ref)) narr = narr ? `${narr} ${ref}` : ref;
            }
            if (!narr) narr = '(no narrative)';
            const acctLabel = m.account >= 0 && (r[m.account] ?? '').trim() ? normaliseAccount(r[m.account]) : defaultAcct;
            const ai = acctId(acctLabel);
            fileAccounts.add(ai);
            let flags = 0;
            if (dr.swapped) { flags |= ROW_DATE_SWAPPED; summary.swappedDates++; }
            let balance = NaN;
            if (bal && m.balance >= 0) {
              const b = parseAmount(r[m.balance] ?? '');
              if (b) {
                balance = b.value;
                if (prevBal !== null) {
                  bal.checked++;
                  const expected = Math.round((prevBal + amount) * 100) / 100;
                  if (Math.abs(expected - b.value) > 0.015) {
                    bal.breaks++;
                    if (bal.firstBreaks.length < 20) bal.firstBreaks.push({ line: lineNo + 1, expected, actual: b.value });
                  }
                } else if (bal.openingBalance === null) {
                  bal.openingBalance = Math.round((b.value - amount) * 100) / 100;
                  bal.openingDay = dr.day;
                  bal.account = acctLabel;
                }
                prevBal = b.value;
              }
            }
            G.push(dr.day, amount, ai, fi, lineNo, narrId(narr), flags, balance);
            summary.rowsAccepted++;
            if (summary.firstDay === null || dr.day < summary.firstDay) summary.firstDay = dr.day;
            if (summary.lastDay === null || dr.day > summary.lastDay) summary.lastDay = dr.day;
          }
          const cursor = res.meta.cursor ?? 0;
          onProgress?.({ phase: `Reading ${src.name}`, done: bytesBefore + Math.min(cursor, src.size), total: totalBytes, rows: G.n });
        },
        complete: () => resolve(),
        error: (err: Error) => reject(err),
      });
    });
    bytesBefore += src.size;
    summary.accounts = [...fileAccounts].map((i) => accounts[i]);
    if (bal) balanceChecks.push(bal);
    files.push(summary);
  }

  // ---------- Assign accountless files to the most similar known account ----------
  // (files with no account column and no account number in their title lines)
  const filesWithoutAcct = files
    .map((f, i) => ({ f, i, label: normaliseAccount(sources[i].mapping.defaultAccount || f.name) }))
    .filter(({ f, label }) => !f.accountFromColumn && !/^\d{6,10}$/.test(label))
    .map(({ i }) => i);
  if (filesWithoutAcct.length) {
    const sigSets = new Map<number, Set<string>>();
    const short = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
    for (let i = 0; i < G.n; i++) {
      if (filesWithoutAcct.includes(G.file[i])) continue;
      const a = G.account[i];
      let set = sigSets.get(a);
      if (!set) sigSets.set(a, (set = new Set()));
      if (set.size < 20000) set.add(short(narratives[G.narr[i]]));
    }
    for (const fi of filesWithoutAcct) {
      const mine = new Set<string>();
      let fromAcct = -1;
      for (let i = 0; i < G.n; i++) if (G.file[i] === fi) { mine.add(short(narratives[G.narr[i]])); fromAcct = G.account[i]; }
      let best = -1, bestScore = 0;
      for (const [a, set] of sigSets) {
        let inter = 0;
        for (const s of mine) if (set.has(s)) inter++;
        const score = inter / Math.max(1, Math.min(mine.size, set.size));
        if (score > bestScore) { bestScore = score; best = a; }
      }
      if (best >= 0 && bestScore >= 0.35 && fromAcct >= 0 && best !== fromAcct) {
        for (let i = 0; i < G.n; i++) if (G.file[i] === fi) G.account[i] = best;
        files[fi].accounts = [accounts[best]];
        files[fi].accountFromColumn = false;
        (files[fi] as FileSummary & { accountMatchedBy?: string }).accountMatchedBy = `narrative overlap ${(bestScore * 100).toFixed(0)}%`;
      }
    }
  }

  onProgress?.({ phase: 'Removing overlapping rows between files', done: totalBytes, total: totalBytes, rows: G.n });

  // ---------- Remove overlap duplicates between files of the same account ----------
  const keep = new Uint8Array(G.n).fill(1);
  {
    // For each account, files sorted by first day; rows of a later file that fall inside the
    // earlier file's range and match (day, amount) one-for-one are removed.
    const byAcctFile = new Map<string, number[]>();
    for (let i = 0; i < G.n; i++) {
      const k = `${G.account[i]}:${G.file[i]}`;
      let arr = byAcctFile.get(k);
      if (!arr) byAcctFile.set(k, (arr = []));
      arr.push(i);
    }
    const acctFiles = new Map<number, number[]>();
    for (const k of byAcctFile.keys()) {
      const [a, f] = k.split(':').map(Number);
      if (!acctFiles.has(a)) acctFiles.set(a, []);
      acctFiles.get(a)!.push(f);
    }
    for (const [a, fl] of acctFiles) {
      if (fl.length < 2) continue;
      fl.sort((x, y) => (files[x].firstDay ?? 0) - (files[y].firstDay ?? 0));
      for (let j = 1; j < fl.length; j++) {
        const later = byAcctFile.get(`${a}:${fl[j]}`)!;
        for (let k = 0; k < j; k++) {
          const earlier = byAcctFile.get(`${a}:${fl[k]}`)!;
          const lo = Math.max(files[fl[j]].firstDay ?? 0, files[fl[k]].firstDay ?? 0);
          const hi = Math.min(files[fl[j]].lastDay ?? 0, files[fl[k]].lastDay ?? 0);
          if (hi < lo) continue;
          const pool = new Map<string, number>();
          for (const i of earlier) if (G.day[i] >= lo && G.day[i] <= hi) { const key = `${G.day[i]}|${Math.round(G.amount[i] * 100)}`; pool.set(key, (pool.get(key) ?? 0) + 1); }
          for (const i of later) {
            if (G.day[i] < lo || G.day[i] > hi || !keep[i]) continue;
            const key = `${G.day[i]}|${Math.round(G.amount[i] * 100)}`;
            const c = pool.get(key) ?? 0;
            if (c > 0) { pool.set(key, c - 1); keep[i] = 0; files[fl[j]].overlapDuplicatesRemoved++; }
          }
        }
      }
    }
  }

  // ---------- Compact into final sorted arrays ----------
  const idx: number[] = [];
  for (let i = 0; i < G.n; i++) if (keep[i]) idx.push(i);
  idx.sort((x, y) => G.day[x] - G.day[y] || G.account[x] - G.account[y] || G.file[x] - G.file[y] || G.line[x] - G.line[y]);
  const n = idx.length;
  const ds: Dataset = {
    n,
    day: new Int32Array(n), amount: new Float64Array(n), account: new Uint16Array(n), file: new Uint16Array(n),
    line: new Int32Array(n), narr: new Int32Array(n), rowFlags: new Uint8Array(n),
    narratives, accounts, files, rejects, balanceChecks, minDay: 0, maxDay: 0, openingBalance: null,
  };
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    ds.day[k] = G.day[i]; ds.amount[k] = G.amount[i]; ds.account[k] = G.account[i]; ds.file[k] = G.file[i];
    ds.line[k] = G.line[i]; ds.narr[k] = G.narr[i]; ds.rowFlags[k] = G.flags[i];
  }
  ds.minDay = n ? ds.day[0] : 0;
  ds.maxDay = n ? ds.day[n - 1] : 0;

  // Within-file exact duplicates (same account, day, amount, narrative): flag, keep
  {
    const seen = new Map<string, number>();
    for (let k = 0; k < n; k++) {
      const key = `${ds.account[k]}|${ds.day[k]}|${Math.round(ds.amount[k] * 100)}|${ds.narr[k]}`;
      const prev = seen.get(key);
      if (prev !== undefined) { ds.rowFlags[k] |= ROW_DUP_CANDIDATE; ds.rowFlags[prev] |= ROW_DUP_CANDIDATE; }
      else seen.set(key, k);
    }
  }

  // Drop account labels that no longer have rows (e.g. a file re-assigned to a known account)
  {
    const used = new Set<number>();
    for (let k = 0; k < n; k++) used.add(ds.account[k]);
    if (used.size < accounts.length) {
      const remap = new Map<number, number>();
      const kept: string[] = [];
      accounts.forEach((a, i) => { if (used.has(i)) { remap.set(i, kept.length); kept.push(a); } });
      for (let k = 0; k < n; k++) ds.account[k] = remap.get(ds.account[k])!;
      ds.accounts = kept;
    }
  }

  // Opening balance: sum of each account's earliest balance-derived opening (accounts without a
  // balance column are assumed to open at zero)
  {
    const byAcct = new Map<string, BalanceCheck>();
    for (const b of balanceChecks) if (b.openingBalance !== null) {
      const cur = byAcct.get(b.account);
      if (!cur || (b.openingDay ?? 0) < (cur.openingDay ?? 0)) byAcct.set(b.account, b);
    }
    if (byAcct.size) ds.openingBalance = Math.round([...byAcct.values()].reduce((s, b) => s + (b.openingBalance ?? 0), 0) * 100) / 100;
  }
  return ds;
}
