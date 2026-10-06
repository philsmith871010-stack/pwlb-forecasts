import { Day, dayFromYMD, isValidYMD } from '../dates';

// ---------------------------------------------------------------- dates

export type DateOrder = 'DMY' | 'MDY';

export interface DateResult {
  day: Day;
  /** set when the date only made sense with day/month swapped */
  swapped?: boolean;
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

const RE_ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/;
const RE_NUMERIC = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/;
const RE_TEXTMONTH = /^(\d{1,2})[\s-]*([A-Za-z]{3,9})[\s,-]*(\d{2}|\d{4})$/;
const RE_TEXTMONTH_US = /^([A-Za-z]{3,9})[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/;
const RE_SERIAL = /^\d{5}(?:\.\d+)?$/;

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

/**
 * Parse a date cell. Handles DD/MM/YYYY, MM/DD/YYYY (per `order`), ISO, "DD Mon YY(YY)",
 * "Mon DD, YYYY" and Excel serial numbers. Returns null for anything that cannot be a date.
 */
export function parseDate(raw: string, order: DateOrder = 'DMY'): DateResult | null {
  const s = raw.trim().replace(/^"|"$/g, '').replace(/^'/, '');
  if (!s) return null;
  let m = RE_ISO.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return isValidYMD(y, mo, d) ? { day: dayFromYMD(y, mo, d) } : null;
  }
  m = RE_NUMERIC.exec(s);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    const [d, mo] = order === 'DMY' ? [a, b] : [b, a];
    if (isValidYMD(y, mo, d)) return { day: dayFromYMD(y, mo, d) };
    // Fall back to the other order if that is the only valid reading
    const [d2, mo2] = [mo, d];
    if (isValidYMD(y, mo2, d2)) return { day: dayFromYMD(y, mo2, d2), swapped: true };
    return null;
  }
  m = RE_TEXTMONTH.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toUpperCase()];
    const y = fullYear(+m[3]), d = +m[1];
    return mo && isValidYMD(y, mo, d) ? { day: dayFromYMD(y, mo, d) } : null;
  }
  m = RE_TEXTMONTH_US.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toUpperCase()];
    const y = +m[3], d = +m[2];
    return mo && isValidYMD(y, mo, d) ? { day: dayFromYMD(y, mo, d) } : null;
  }
  if (RE_SERIAL.test(s)) {
    const n = Math.floor(parseFloat(s));
    // Plausible Excel serials: 1990–2070
    if (n > 32874 && n < 62000) return { day: n - 25569 };
  }
  return null;
}

/** Inspect sample date cells and decide day/month order. */
export function detectDateOrder(samples: string[]): { order: DateOrder; evidence: { dmy: number; mdy: number; ambiguous: number } } {
  let dmy = 0, mdy = 0, ambiguous = 0;
  for (const raw of samples) {
    const m = RE_NUMERIC.exec(raw.trim().replace(/^"|"$/g, ''));
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
    else ambiguous++;
  }
  // UK default when the evidence is thin or balanced
  return { order: mdy > dmy * 3 && mdy >= 3 ? 'MDY' : 'DMY', evidence: { dmy, mdy, ambiguous } };
}

export function describeDateFormat(samples: string[]): string {
  const counts: Record<string, number> = {};
  for (const raw of samples) {
    const s = raw.trim();
    const k = RE_ISO.test(s) ? 'YYYY-MM-DD' : RE_NUMERIC.test(s) ? 'DD/MM/YYYY' : RE_TEXTMONTH.test(s) ? 'DD Mon YYYY' : RE_SERIAL.test(s) ? 'Excel serial' : RE_TEXTMONTH_US.test(s) ? 'Mon DD, YYYY' : 'other';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 2).join(' + ') || 'unknown';
}

// ---------------------------------------------------------------- amounts

export interface AmountResult {
  value: number;
  /** explicit CR/DR marker found in the cell */
  marker?: 'CR' | 'DR';
}

const JUNK = /Â|â€™|â€œ|â€\u009d| |GBP|£|\$|€|\s/g;

/**
 * Parse an amount cell. Handles thousands separators, currency symbols (and their
 * mis-encoded forms), brackets for negatives, leading/trailing minus and CR/DR suffixes.
 */
export function parseAmount(raw: string): AmountResult | null {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^"|"$/g, '').replace(/^'/, '');
  if (!s) return null;
  let marker: 'CR' | 'DR' | undefined;
  const up = s.toUpperCase();
  const mk = /(CR|DR)\.?$/.exec(up);
  if (mk) { marker = mk[1] as 'CR' | 'DR'; s = s.slice(0, mk.index); }
  s = s.replace(JUNK, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('(') && s.endsWith(')')) { neg = !neg; s = s.slice(1, -1); }
  s = s.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  let v = parseFloat(s);
  if (!isFinite(v)) return null;
  if (marker === 'DR') v = -Math.abs(v);
  else if (marker === 'CR') v = Math.abs(v);
  else if (neg) v = -v;
  return { value: Math.round(v * 100) / 100, marker };
}

export function looksNumeric(raw: string): boolean {
  return parseAmount(raw) !== null;
}
