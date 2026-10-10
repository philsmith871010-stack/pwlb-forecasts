import { fmtDay, isoFromDay, Day } from './dates';

/** "Show exact amounts": every figure in pounds and pence instead of £m / £k (a user setting). */
let exactAmounts = false;
export function setExactAmounts(v: boolean) { exactAmounts = v; }

/** `unit: 'm'` keeps a whole table column in £m (so −£92k shows as −£0.1m beside £9.7m). */
export function money(x: number, opts: { dp?: number; compact?: boolean; sign?: boolean; unit?: 'm' } = {}): string {
  const { dp, compact = true, sign = false, unit } = opts;
  if (!isFinite(x)) return '–';
  if (exactAmounts && compact) { const f = moneyFull(x); return sign && x > 0 ? `+${f}` : f; }
  const a = Math.abs(x);
  let s: string;
  if (compact && unit === 'm' && a < 1e9) s = `£${(a / 1e6).toFixed(dp ?? 1)}m`;
  else if (compact && a >= 1e9) s = `£${(a / 1e9).toFixed(dp ?? 2)}bn`;
  else if (compact && a >= 1e6) s = `£${(a / 1e6).toFixed(dp ?? 1)}m`;
  else if (compact && a >= 1e4) s = `£${(a / 1e3).toFixed(dp ?? 0)}k`;
  else s = `£${a.toLocaleString('en-GB', { minimumFractionDigits: dp ?? (a < 100 && a % 1 ? 2 : 0), maximumFractionDigits: dp ?? (a < 100 ? 2 : 0) })}`;
  if (/^£0(\.0+)?m$/.test(s)) return s; // rounds to nothing: no sign
  if (x < 0) return `−${s}`;
  return sign && x > 0 ? `+${s}` : s;
}

export function moneyFull(x: number): string {
  const s = Math.abs(x).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? `−£${s}` : `£${s}`;
}

export function pct(x: number, dp = 1, sign = false): string {
  if (!isFinite(x)) return '–';
  const s = `${(x * 100).toFixed(dp)}%`;
  return sign && x > 0 ? `+${s}` : s.replace('-', '−');
}

export function int(x: number): string {
  return Math.round(x).toLocaleString('en-GB');
}

export const day = (d: Day | null | undefined) => (d == null ? '–' : fmtDay(d));
export const iso = (d: Day) => isoFromDay(d);

export function bytes(n: number): string {
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function ago(isoStr: string): string {
  if (!isoStr) return 'never';
  const ms = Date.now() - new Date(isoStr).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A share of something done, rounded down: 99.96% sorted shows as 99.9%, never 100%. */
export const pctDone = (x: number) => pct(Math.floor(x * 1000) / 1000);
