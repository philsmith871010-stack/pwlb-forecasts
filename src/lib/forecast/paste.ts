// Parse a table pasted from Excel (tab-separated): date + amount, month + amount, or
// financial year + annual total.
import { parseDate, parseAmount } from '../ingest/parseValues';
import { Day, dayFromYMD, daysInMonth, isBusinessDay, nextBusinessDay, prevBusinessDay, isoFromDay, MONTH_NAMES } from '../dates';

export type PasteKind = 'dates' | 'months' | 'years';

export interface PasteRow { line: number; label: string; amount: number; day?: Day; month?: { y: number; m: number }; fy?: number }
export interface PasteParse { kind: PasteKind | null; rows: PasteRow[]; skipped: { line: number; text: string; reason: string }[] }

const MONTH_RE = /^([A-Za-z]{3,9})[\s\-/']*(\d{2}|\d{4})$/;
const YM_RE = /^(\d{4})[-/](\d{1,2})$/;
const MY_RE = /^(\d{1,2})[-/](\d{4})$/;
const FY_RE = /^(?:FY\s*)?(\d{2}|\d{4})\s*[/-]\s*(\d{2}|\d{4})$/i;

const MONTHS: Record<string, number> = Object.fromEntries(MONTH_NAMES.map((m, i) => [m.toUpperCase(), i + 1]));
const full = (y: number) => (y < 100 ? 2000 + y : y);

function parseMonth(s: string): { y: number; m: number } | null {
  let r = MONTH_RE.exec(s.trim());
  if (r) { const m = MONTHS[r[1].slice(0, 3).toUpperCase()]; if (m) return { y: full(+r[2]), m }; }
  r = YM_RE.exec(s.trim());
  if (r && +r[2] >= 1 && +r[2] <= 12) return { y: +r[1], m: +r[2] };
  r = MY_RE.exec(s.trim());
  if (r && +r[1] >= 1 && +r[1] <= 12) return { y: +r[2], m: +r[1] };
  return null;
}

function parseFY(s: string): number | null {
  const r = FY_RE.exec(s.trim());
  if (!r) return null;
  const a = full(+r[1]), b = full(+r[2]);
  return b === a + 1 || (b % 100 === (a + 1) % 100) ? a : null;
}

export function parsePaste(text: string): PasteParse {
  const lines = text.replace(/\r/g, '').split('\n');
  const rows: PasteRow[] = [];
  const skipped: PasteParse['skipped'] = [];
  const kinds: Record<PasteKind, number> = { dates: 0, months: 0, years: 0 };
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((c) => c.trim().replace(/^"|"$/g, '')).filter((c) => c !== '');
    if (cells.length < 2) { skipped.push({ line: i + 1, text: raw, reason: 'needs a label and an amount' }); return; }
    const label = cells[0];
    const amt = parseAmount(cells[cells.length - 1]);
    if (!amt) { skipped.push({ line: i + 1, text: raw, reason: i === 0 ? 'header row' : 'no amount in last column' }); return; }
    const fy = parseFY(label);
    if (fy !== null) { rows.push({ line: i + 1, label, amount: amt.value, fy }); kinds.years++; return; }
    const m = parseMonth(label);
    if (m) { rows.push({ line: i + 1, label, amount: amt.value, month: m }); kinds.months++; return; }
    const d = parseDate(label, 'DMY');
    if (d) { rows.push({ line: i + 1, label, amount: amt.value, day: d.day }); kinds.dates++; return; }
    skipped.push({ line: i + 1, text: raw, reason: `“${label}” is not a date, month or financial year` });
  });
  const kind = (Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][1] ? (Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0] as PasteKind) : null);
  return { kind, rows: kind ? rows.filter((r) => (kind === 'dates' ? r.day !== undefined : kind === 'months' ? !!r.month : r.fy !== undefined)) : [], skipped };
}

export type Spread = 'even_monthly' | 'profile' | 'day_of_month' | 'even_business_days';

export interface ResolveOptions {
  spread: Spread;
  dayOfMonth: number;
  /** monthly shares for 'profile' spreading: index 0 = January */
  profile?: number[];
  negate: boolean;
  fyStartMonth: number;
}

/** Turn parsed rows into dated entries. */
export function resolvePaste(p: PasteParse, o: ResolveOptions): { date: string; amount: number }[] {
  const sign = o.negate ? -1 : 1;
  const out: { date: string; amount: number }[] = [];
  const onDay = (y: number, m: number, amount: number) => {
    if (o.spread === 'even_business_days') {
      const bds: Day[] = [];
      for (let k = 1; k <= daysInMonth(y, m); k++) { const d = dayFromYMD(y, m, k); if (isBusinessDay(d)) bds.push(d); }
      for (const d of bds) out.push({ date: isoFromDay(d), amount: (amount / bds.length) * sign });
    } else {
      const d0 = dayFromYMD(y, m, Math.min(o.dayOfMonth, daysInMonth(y, m)));
      const d = amount * sign < 0 ? prevBusinessDay(d0) : nextBusinessDay(d0);
      out.push({ date: isoFromDay(d), amount: amount * sign });
    }
  };
  for (const r of p.rows) {
    if (r.day !== undefined) out.push({ date: isoFromDay(r.day), amount: r.amount * sign });
    else if (r.month) onDay(r.month.y, r.month.m, r.amount);
    else if (r.fy !== undefined) {
      const shares = o.spread === 'profile' && o.profile && o.profile.some((x) => x)
        ? (() => { const tot = o.profile!.reduce((s, x) => s + Math.abs(x), 0); return o.profile!.map((x) => (tot ? Math.abs(x) / tot : 1 / 12)); })()
        : new Array(12).fill(1 / 12);
      for (let k = 0; k < 12; k++) {
        const m = ((o.fyStartMonth - 1 + k) % 12) + 1;
        const y = m >= o.fyStartMonth ? r.fy : r.fy + 1;
        const share = shares[m - 1];
        if (share) onDay(y, m, r.amount * share);
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
