// Importing a schedule another department sent: a table of date, category and amount (and
// perhaps a description), from Excel, CSV or the clipboard. The table is read in the browser,
// its columns found, its category names matched to ours, and the result turned into rows of
// the month/day grid (so every imported figure stays visible and editable).
import { parseDate, parseAmount, type DateOrder } from '../ingest/parseValues';
import type { Category } from '../categories';
import type { GridOverride } from '../model';
import { isoFromDay, type Day } from '../dates';

export interface ImportColumns { header: number; date: number; amount: number; category: number | null; description: number | null }

/** Read the first sheet of an .xlsx/.xls, or a CSV/TSV/text file, into rows of text cells. */
export async function readTableFile(file: File): Promise<string[][]> {
  if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' }) as unknown[][];
      const out = rows.map((r) => r.map((c) => (c instanceof Date ? isoFromDay(Math.round(c.getTime() / 864e5)) : String(c ?? '')))).filter((r) => r.some((c) => c.trim()));
      if (out.length >= 2) return out;
    }
    return [];
  }
  return readTableText(await file.text());
}

/** CSV, TSV (e.g. pasted from Excel) or semicolon-separated text into rows. */
export function readTableText(text: string): string[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  return lines.map((l) => splitLine(l, sep));
}

function splitLine(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t').map((c) => c.trim());
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Which order to read 03/04/2027 in: a part above 12 settles it; UK order otherwise. */
export function guessDateOrder(values: string[]): DateOrder {
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(v.trim());
    if (m && +m[2] > 12) return 'MDY';
    if (m && +m[1] > 12) return 'DMY';
  }
  return 'DMY';
}

const isDate = (v: string) => !!parseDate(v, 'DMY') || !!parseDate(v, 'MDY');
const isAmount = (v: string) => { const a = parseAmount(v); return !!a && /\d/.test(v) && !isDate(v); };

/** Find the header row and the date, amount, category and description columns. */
export function detectColumns(rows: string[][]): ImportColumns | null {
  if (!rows.length) return null;
  // the header is the last row, near the top, that is mostly text and followed by data
  let header = -1;
  for (let i = 0; i < Math.min(12, rows.length - 1); i++) {
    const r = rows[i];
    const text = r.filter((c) => c && !isDate(c) && !isAmount(c)).length;
    const next = rows[i + 1] ?? [];
    if (text >= 2 && next.some(isDate) && next.some(isAmount)) { header = i; break; }
  }
  const body = rows.slice(header + 1, header + 201);
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const score = (f: (v: string) => boolean) => Array.from({ length: width }, (_, j) => body.filter((r) => r[j] && f(r[j])).length / Math.max(1, body.length));
  const head = (j: number) => (header >= 0 ? (rows[header][j] ?? '').toLowerCase() : '');
  const ds = score(isDate), as = score(isAmount), ts = score((v) => !isDate(v) && !isAmount(v) && /[a-z]/i.test(v));
  const pick = (s: number[], prefer: RegExp, exclude: number[] = []) => {
    let best = -1, bs = 0.5;
    s.forEach((v, j) => { if (exclude.includes(j)) return; const b = v + (prefer.test(head(j)) ? 0.6 : 0); if (b > bs) { bs = b; best = j; } });
    return best;
  };
  const date = pick(ds, /date|day|when|due|paid/);
  const amount = pick(as, /amount|value|£|gbp|total|sum|payment|receipt|net|cash/, [date]);
  if (date < 0 || amount < 0) return null;
  // category: a text column with a category-like heading, or one with few distinct values
  const distinct = (j: number) => new Set(body.map((r) => (r[j] ?? '').trim().toLowerCase()).filter(Boolean)).size;
  let category = -1, cs = 0;
  ts.forEach((v, j) => {
    if (j === date || j === amount || v < 0.5) return;
    const s = v + (/categor|type|service|stream|budget|head|line|cost cent|class|code/.test(head(j)) ? 1 : 0) + (distinct(j) <= Math.max(3, body.length / 4) ? 0.5 : 0);
    if (s > cs) { cs = s; category = j; }
  });
  let description = -1, dsc = 0;
  ts.forEach((v, j) => {
    if (j === date || j === amount || j === category || v < 0.3) return;
    const s = v + (/desc|detail|narr|memo|note|payee|supplier|name|reference|ref/.test(head(j)) ? 1 : 0);
    if (s > dsc) { dsc = s; description = j; }
  });
  return { header, date, amount, category: category >= 0 ? category : null, description: description >= 0 ? description : null };
}

// ---------------------------------------------------------------- category names

const SYNONYMS: [RegExp, string][] = [
  // money the council receives from government comes first: "Housing Benefit subsidy" is a grant in, not benefit paid out
  [/subsidy|new homes bonus|\bnhb\b|section 31|\bs31\b|revenue support|\brsg\b|better care|\bbcf\b|public health grant/, 'grants_general'],
  [/council ?tax|\bctax\b/, 'council_tax'],
  [/business rates|\bnndr\b|non.?domestic/, 'business_rates'],
  [/\bdsg\b|dedicated schools/, 'dsg'],
  [/schools? (budget|funding|share)|delegated/, 'schools'],
  [/net pay|salar|payroll|wages/, 'salaries'],
  [/\bhmrc\b|\bpaye\b|national insurance|\bni\b/, 'hmrc_paye'],
  [/pension|lgps|\btps\b/, 'pensions'],
  [/precept|police|fire authority/, 'precepts'],
  [/levy|retention|tariff|top.?up/, 'nndr_retention'],
  [/housing benefit|\bhb\b|welfare|universal credit/, 'housing_benefit'],
  [/supplier|creditor|purchase|invoice|procure/, 'suppliers'],
  [/capital (exp|spend|programme|works)|capex/, 'capital_spend'],
  [/capital receipt|asset sale|land sale|disposal/, 'capital_receipts'],
  [/\bvat\b/, 'vat_reclaim'],
  [/\brents?\b|lettings|leases?/, 'rents'],
  [/fees|charges|parking|licen[cs]/, 'fees_charges'],
  [/grant|\bdluhc\b|\bmhclg\b|\bdwp\b|\bdhsc\b|\bdfe\b|\besfa\b/, 'grants_general'],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Our category for a name in someone else's file, or null if we can't tell. */
export function matchCategory(text: string, categories: Category[]): string | null {
  const t = norm(text);
  if (!t) return null;
  const usable = categories.filter((c) => c.group === 'receipts_operational' || c.group === 'payments_operational');
  const exact = usable.find((c) => norm(c.name) === t || c.id === t.replace(/ /g, '_'));
  if (exact) return exact.id;
  for (const [re, id] of SYNONYMS) if (re.test(t) && usable.some((c) => c.id === id)) return id;
  const partial = usable.find((c) => t.includes(norm(c.name)) || norm(c.name).includes(t));
  return partial?.id ?? null;
}

// ---------------------------------------------------------------- building the import

export interface ImportOptions {
  columns: ImportColumns;
  dateOrder: DateOrder;
  /** a category for every row (when the file has no category column, or to override it) */
  singleCategory: string | null;
  /** file text → category id ('' = leave these rows out) */
  categoryMap: Record<string, string>;
  /** 'direction': amounts are all positive, take the sign from the category; 'signed': + in, − out */
  signs: 'direction' | 'signed';
  categories: Category[];
}

export interface ImportedLine { categoryId: string; day: Day; amount: number; description: string; /** the file's own category name */ source: string }
export interface ImportResult { lines: ImportedLine[]; skipped: { row: number; reason: string }[]; categoryNames: string[] }

/** The distinct category names in the file, in order of first appearance. */
export function categoryNames(rows: string[][], c: ImportColumns): string[] {
  if (c.category === null) return [];
  const seen = new Set<string>();
  for (const r of rows.slice(c.header + 1)) { const v = (r[c.category] ?? '').trim(); if (v) seen.add(v); }
  return [...seen];
}

export function buildImport(rows: string[][], o: ImportOptions): ImportResult {
  const { columns: c } = o;
  const lines: ImportedLine[] = [];
  const skipped: ImportResult['skipped'] = [];
  const dir = new Map(o.categories.map((x) => [x.id, x.group === 'payments_operational' ? -1 : 1]));
  rows.slice(c.header + 1).forEach((r, k) => {
    const rowNo = c.header + 2 + k;
    const dateText = (r[c.date] ?? '').trim(), amtText = (r[c.amount] ?? '').trim();
    if (!dateText && !amtText) return;
    const d = parseDate(dateText, o.dateOrder);
    if (!d) { skipped.push({ row: rowNo, reason: dateText ? `“${dateText}” isn’t a date` : 'no date' }); return; }
    const a = parseAmount(amtText);
    if (!a) { skipped.push({ row: rowNo, reason: amtText ? `“${amtText}” isn’t an amount` : 'no amount' }); return; }
    const catText = c.category !== null ? (r[c.category] ?? '').trim() : '';
    const cat = o.singleCategory ?? o.categoryMap[catText] ?? '';
    if (!cat) { skipped.push({ row: rowNo, reason: catText ? `“${catText}” isn’t matched to a category` : 'no category' }); return; }
    const amount = o.signs === 'signed' ? a.value : Math.abs(a.value) * (dir.get(cat) ?? 1);
    lines.push({ categoryId: cat, day: d.day, amount, description: c.description !== null ? (r[c.description] ?? '').trim() : '', source: catText });
  });
  return { lines, skipped, categoryNames: categoryNames(rows, c) };
}

export type ImportMode = 'replace_months' | 'replace_all' | 'add';

/**
 * Turn imported lines into grid figures: one row per category named after the source, a
 * figure for each day (amounts on the same day added). With 'replace_months', our own rows
 * for the months the file covers (per category) are set to zero; 'replace_all' is done by the
 * caller (it switches the line's model off).
 */
/** Our rows a schedule replaces: each row, and (if known) the months the file covers for that payment. */
export type ReplacedRows = Record<string, { row: string; months?: string[] }[]>;

export function importToOverrides(lines: ImportedLine[], rowName: string, mode: ImportMode, ourRows: ReplacedRows, range: { from: Day; to: Day }): { overrides: GridOverride[]; outside: number } {
  const byKey = new Map<string, GridOverride>();
  let outside = 0;
  const months = new Map<string, Set<string>>();
  for (const l of lines) {
    if (l.day < range.from || l.day > range.to) { outside++; continue; }
    const iso = isoFromDay(l.day);
    const k = `${l.categoryId}|${iso}`;
    const o = byKey.get(k);
    if (o) o.amount += l.amount;
    else byKey.set(k, { categoryId: l.categoryId, row: `custom:${rowName}`, month: iso.slice(0, 7), date: iso, amount: l.amount, source: rowName });
    if (!months.has(l.categoryId)) months.set(l.categoryId, new Set());
    months.get(l.categoryId)!.add(iso.slice(0, 7));
  }
  const out = [...byKey.values()];
  if (mode === 'replace_months') {
    for (const [cat, ms] of months) for (const r of ourRows[cat] ?? []) for (const m of r.months ?? ms) if (ms.has(m)) out.push({ categoryId: cat, row: r.row, month: m, amount: 0, source: rowName });
  }
  return { overrides: out, outside };
}

const GENERIC = new Set([
  'GRANT', 'GRANTS', 'PAYMENT', 'PAYMENTS', 'RECEIPT', 'RECEIPTS', 'FUND', 'FUNDING', 'THE', 'AND', 'FOR', 'FROM', 'COUNCIL', 'MONTHLY', 'ANNUAL', 'INCOME', 'COSTS', 'COST',
  // the paying department says who, not which grant
  'DWP', 'MHCLG', 'DLUHC', 'DHSC', 'DFE', 'ESFA', 'HMRC', 'DFT', 'DEFRA', 'HO', 'MOJ', 'GOV', 'GOVERNMENT', 'DEPT', 'DEPARTMENT',
  // dates and periods
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC', 'QTR', 'QUARTER', 'Q1', 'Q2', 'Q3', 'Q4', 'FY',
]);
const words = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !GENERIC.has(w)));
const ABBREV: [RegExp, string][] = [[/HOUSING BENEFIT/, 'HB'], [/DEDICATED SCHOOLS GRANT/, 'DSG'], [/REVENUE SUPPORT/, 'RSG'], [/NEW HOMES BONUS/, 'NHB'], [/BETTER CARE/, 'BCF']];
const withAbbrev = (s: string) => { const u = s.toUpperCase(); return ABBREV.reduce((t, [re, a]) => (re.test(u) ? `${t} ${a}` : t), u); };

/**
 * Which of our rows in a line a schedule replaces: those whose names share a word with the
 * file's own names for that line. If none do, a line with a single pattern (and at most one
 * regular payment) is replaced whole; otherwise nothing is ticked and the user decides.
 */
export function suggestReplacedRows(fileNames: string[], rows: { key: string; label: string }[]): string[] {
  const file = new Set(fileNames.flatMap((n) => [...words(withAbbrev(n))]));
  const hit = rows.filter((r) => r.key !== 'pattern' && [...words(withAbbrev(r.label))].some((w) => file.has(w))).map((r) => r.key);
  if (hit.length) return hit;
  return rows.filter((r) => r.key !== 'pattern').length <= 1 ? rows.map((r) => r.key) : [];
}

/** Do any of these names (from the file) name this row of ours? */
export function namesMatch(fileNames: string[], label: string): boolean {
  const file = new Set(fileNames.flatMap((n) => [...words(withAbbrev(n))]));
  return [...words(withAbbrev(label))].some((w) => file.has(w));
}
