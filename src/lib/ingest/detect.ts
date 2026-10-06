import Papa from 'papaparse';
import { parseDate, parseAmount, detectDateOrder, describeDateFormat, DateOrder } from './parseValues';

export type AmountMode = 'signed' | 'debitCredit';

export interface ColumnMapping {
  delimiter: string;
  /** 0-based index of the header line in the file (after Papa line splitting) */
  headerRow: number;
  hasHeader: boolean;
  columns: string[];
  date: number;
  dateOrder: DateOrder;
  amountMode: AmountMode;
  amount: number;
  debit: number;
  credit: number;
  /** For signed amounts: does a positive number mean money in (normal) or money out? */
  positiveIsIn: boolean;
  narrative: number[];
  /** how to join several narrative columns: 'concat' when the bank splits one narrative into fixed-width chunks */
  narrativeJoin: 'space' | 'concat';
  reference: number;
  account: number;
  balance: number;
  type: number;
  /** Account label used when the file has no account column */
  defaultAccount: string;
}

export interface DetectionReport {
  mapping: ColumnMapping;
  headerSignature: string;
  dateFormatLabel: string;
  dateEvidence: { dmy: number; mdy: number; ambiguous: number };
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
  preview: string[][];
  titleLines: string[];
}

const DELIMS = [',', ';', '\t', '|'];

function splitSample(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  return res.data;
}

function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 60);
  let best = ',', bestScore = -1;
  for (const d of DELIMS) {
    const rows = splitSample(lines.join('\n'), d);
    const counts = rows.map((r) => r.length);
    const freq: Record<number, number> = {};
    for (const c of counts) freq[c] = (freq[c] ?? 0) + 1;
    const [mode, n] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] ?? ['1', 0];
    const score = +mode > 1 ? n * Math.min(+mode, 12) : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const H = {
  date: /^(transaction |txn ?|posting |post |entry |booking )?date$|^date posted$|^txndate$|^posted$/i,
  valueDate: /value ?date/i,
  amount: /^(transaction )?(amount|value|amt)( \(?gbp\)?| £)?$|^net amount$/i,
  debit: /debit|paid ?out|withdraw|money ?out|^dr$|payments?$/i,
  credit: /credit|paid ?in|deposit|money ?in|^cr$|receipts?$/i,
  balance: /balance/i,
  narrative: /desc|narrative|details|memo|payee|particulars|^transaction$|^text$|^name$|counterparty|beneficiary/i,
  reference: /^ref|reference/i,
  account: /^account( number| no\.?| name)?$|^acc(ount)? ?(no|num)/i,
  type: /^(transaction )?type$|^subcategory$|^tran(saction)? code$/i,
  junk: /transaction id|bank category|notes|^number$|sort ?code|ccy|currency/i,
};

function cellIsHeaderish(c: string): boolean {
  const s = c.trim();
  return !!s && !parseAmount(s) && !parseDate(s) && s.length < 40;
}

export function detectMapping(sampleText: string, fileName: string): DetectionReport {
  const notes: string[] = [];
  const delimiter = detectDelimiter(sampleText);
  const rows = splitSample(sampleText, delimiter).slice(0, 400);
  // Header row: first row (within 30) where most cells are header-like and the next rows
  // have the same width and a parseable date somewhere.
  let headerRow = -1;
  const modeWidth = (() => {
    const f: Record<number, number> = {};
    for (const r of rows) if (r.length > 1) f[r.length] = (f[r.length] ?? 0) + 1;
    return +(Object.entries(f).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1);
  })();
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const r = rows[i];
    if (r.length !== modeWidth) continue;
    const headerish = r.filter(cellIsHeaderish).length;
    if (headerish >= Math.max(2, Math.ceil(r.filter((c) => c.trim()).length * 0.7))) {
      const next = rows.slice(i + 1, i + 6).filter((x) => x.length === modeWidth);
      if (next.some((x) => x.some((c) => parseDate(c)))) { headerRow = i; break; }
    }
  }
  const hasHeader = headerRow >= 0;
  if (!hasHeader) {
    notes.push('No header row found — columns were identified from their contents.');
    headerRow = rows.findIndex((r) => r.length === modeWidth && r.some((c) => parseDate(c))) - 1;
  } else if (headerRow > 0) {
    notes.push(`Header found on line ${headerRow + 1}; ${headerRow} title line(s) above it will be skipped.`);
  }
  const columns = hasHeader ? rows[headerRow].map((c) => c.trim()) : Array.from({ length: modeWidth }, (_, i) => `Column ${i + 1}`);
  const data = rows.slice(headerRow + 1).filter((r) => r.length === modeWidth);
  const titleLines = rows.slice(0, Math.max(0, headerRow)).map((r) => r.join(' ').trim()).filter(Boolean);

  const colVals = (j: number) => data.map((r) => r[j] ?? '').filter((x) => x.trim() !== '');
  const share = (j: number, f: (s: string) => boolean) => {
    const v = colVals(j);
    return v.length ? v.filter(f).length / v.length : 0;
  };
  const dateShare = columns.map((_, j) => share(j, (s) => !!parseDate(s)));
  const numShare = columns.map((_, j) => share(j, (s) => !!parseAmount(s)));
  const fill = columns.map((_, j) => colVals(j).length / Math.max(1, data.length));
  const avgLen = columns.map((_, j) => { const v = colVals(j); return v.reduce((a, b) => a + b.length, 0) / Math.max(1, v.length); });
  const distinct = columns.map((_, j) => new Set(colVals(j)).size);

  const byHeader = (re: RegExp, exclude?: RegExp) => columns.findIndex((c) => re.test(c) && !(exclude && exclude.test(c)));

  // Date
  let date = byHeader(H.date);
  if (date < 0 || dateShare[date] < 0.5) {
    const candidates = columns.map((_, j) => j).filter((j) => dateShare[j] > 0.8 && !H.valueDate.test(columns[j]));
    date = candidates[0] ?? columns.map((_, j) => j).filter((j) => dateShare[j] > 0.8)[0] ?? -1;
  }
  // Amounts
  let amount = byHeader(H.amount, H.valueDate);
  let debit = byHeader(H.debit, /balance/i);
  let credit = byHeader(H.credit, /balance|card/i);
  let balance = byHeader(H.balance);
  let amountMode: AmountMode = 'signed';
  if (debit >= 0 && credit >= 0 && debit !== credit) { amountMode = 'debitCredit'; amount = -1; }
  else {
    debit = credit = -1;
    if (amount < 0) {
      const numericCols = columns.map((_, j) => j).filter((j) => numShare[j] > 0.9 && j !== date && dateShare[j] < 0.5 && fill[j] > 0.9 && j !== balance);
      amount = numericCols.find((j) => colVals(j).some((v) => /[.,]\d{2}\b/.test(v))) ?? numericCols[0] ?? -1;
      if (amount >= 0) notes.push(`Amount column guessed from content: "${columns[amount]}".`);
    }
  }
  // Narrative: all text-like columns matched by header, else the longest text column
  let narrative = columns.map((c, j) => (H.narrative.test(c) && !H.junk.test(c) ? j : -1)).filter((j) => j >= 0);
  if (!narrative.length) {
    const textCols = columns.map((_, j) => j).filter((j) => numShare[j] < 0.5 && dateShare[j] < 0.5 && j !== date);
    textCols.sort((a, b) => avgLen[b] * distinct[b] - avgLen[a] * distinct[a]);
    if (textCols[0] !== undefined) narrative = [textCols[0]];
  }
  // Fixed-width split narratives (e.g. 18-char "Narrative 1" continued in "Narrative 2")
  let narrativeJoin: 'space' | 'concat' = 'space';
  if (narrative.length > 1) {
    const lens = data.map((r) => (r[narrative[0]] ?? '').length).filter((l) => l > 0);
    const max = Math.max(0, ...lens);
    const full = lens.filter((l) => l === max).length;
    const contFilled = data.filter((r) => (r[narrative[0]] ?? '').length === max && (r[narrative[1]] ?? '').trim()).length;
    if (max <= 40 && lens.length && full / lens.length > 0.2 && contFilled / Math.max(1, full) > 0.8) {
      narrativeJoin = 'concat';
      notes.push(`"${columns[narrative[0]]}" looks like a ${max}-character chunk continued in "${columns[narrative[1]]}" — they will be joined without a space.`);
    }
  }
  const reference = byHeader(H.reference);
  let account = byHeader(H.account);
  if (account >= 0 && /name/i.test(columns[account])) {
    const num = columns.findIndex((c) => /account (number|no)/i.test(c));
    if (num >= 0) account = num;
  }
  const type = byHeader(H.type);

  // Default account label: look for an account number in title lines, else the file name
  const titleAcct = /\b(\d{8})\b/.exec(titleLines.join(' '))?.[1];
  const defaultAccount = titleAcct ?? fileName.replace(/\.(csv|txt|tsv)$/i, '');

  // Amount sign convention: signed amounts nearly always use + for money in.
  const positiveIsIn = true;

  const dateSamples = date >= 0 ? colVals(date).slice(0, 400) : [];
  const { order, evidence } = detectDateOrder(dateSamples);
  if (evidence.mdy > 0 && order === 'DMY') notes.push(`${evidence.mdy} date(s) only make sense as month/day — those rows will be read with day and month swapped and flagged.`);
  if (order === 'MDY') notes.push('Dates look US-style (month first).');

  const mapping: ColumnMapping = {
    delimiter, headerRow, hasHeader, columns, date, dateOrder: order, amountMode, amount, debit, credit,
    positiveIsIn, narrative, narrativeJoin, reference, account, balance, type, defaultAccount,
  };
  const missing = [date < 0 && 'date', amountMode === 'signed' && amount < 0 && 'amount', !narrative.length && 'narrative'].filter(Boolean);
  const confidence: DetectionReport['confidence'] = missing.length ? 'low' : hasHeader ? 'high' : 'medium';
  if (missing.length) notes.push(`Could not identify: ${missing.join(', ')}.`);

  return {
    mapping,
    headerSignature: headerSignature(columns, delimiter),
    dateFormatLabel: describeDateFormat(dateSamples.slice(0, 100)),
    dateEvidence: evidence,
    confidence,
    notes,
    preview: rows.slice(Math.max(0, headerRow + 1), headerRow + 21),
    titleLines,
  };
}

export function headerSignature(columns: string[], delimiter: string): string {
  return `${delimiter === '\t' ? 'TAB' : delimiter}|` + columns.map((c) => c.trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
}

export function mappingIsUsable(m: ColumnMapping): boolean {
  return m.date >= 0 && m.narrative.length > 0 && (m.amountMode === 'signed' ? m.amount >= 0 : m.debit >= 0 && m.credit >= 0);
}
