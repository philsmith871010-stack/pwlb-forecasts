// The liability benchmark ("top down"), from the register's Projections sheet, on the
// definitions PWLBreports uses (CIPFA 2026 consultation draft):
//   net treasury position  = CFR − other balance sheet items
//   treasury inv. benchmark = max(liquidity allowance, −net treasury position)
//   liability benchmark    = net treasury position + treasury investment benchmark
//   borrowing requirement  = max(0, LB − existing loans) − max(0, existing loans − max(0, LB))
// Existing loans are the typed column where given, otherwise the register's own run-off at
// each 31 March. The whole authority is used (General Fund and HRA added before the
// benchmark is worked), because cash is managed for the whole authority. Nothing is
// extrapolated: a year left blank is a year not projected.
import { REG, Register } from './index';

export interface LBRow {
  fy: string;          // "2026/27"
  yearEnd: number;     // calendar year of the 31 March
  cfr: number; obs: number; liq: number; existingLoans: number;
  ntp: number; tib: number; lb: number;
  need: number;        // borrowing to arrange (≥ 0)
  over: number;        // debt held above the benchmark (≥ 0)
  requirement: number; // need − over
  actual: boolean;
}

const KEYS: [string, RegExp][] = [
  ['cfr', /capital financing requirement/i],
  ['obs', /other balance sheet/i],
  ['loans', /existing loan commitments/i],
  ['liq', /liquidity allowance/i],
];

function columns(head: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  head.forEach((h, j) => { for (const [k, re] of KEYS) if (re.test(h) && out[k] === undefined) out[k] = j; });
  return out;
}

/** £m figures from one projection block, by financial-year label. */
function blockValues(b: { head: string[]; rows: (string | number | null)[][] } | undefined) {
  const out = new Map<string, Record<string, number | null>>();
  if (!b) return out;
  const c = columns(b.head);
  for (const r of b.rows) {
    const label = String(r[0] ?? '').trim();
    if (!label) continue;
    const v: Record<string, number | null> = {};
    for (const k of Object.keys(c)) { const x = r[c[k]]; v[k] = typeof x === 'number' ? (Math.abs(x) > 100000 ? x / 1e6 : x) : null; }
    out.set(label, v);
  }
  return out;
}

const fyEndYear = (label: string): number | null => {
  const m = /^(\d{4})\s*\/\s*(\d{2,4})/.exec(label);
  return m ? +m[1] + 1 : null;
};

export function liabilityBenchmark(reg: Register): LBRow[] | null {
  const p = reg.projections;
  if (!p || (!p.gf && !p.hra)) return null;
  const gf = blockValues(p.gf), hra = reg.hra && reg.hra !== 'None' ? blockValues(p.hra) : new Map();
  const labels = [...new Set([...gf.keys(), ...hra.keys()])].filter((l) => fyEndYear(l) != null).sort();
  if (!labels.length) return null;
  const runoff: { date: Date; total: number }[] = REG.debtYearEnds(reg, 60);
  const loansAt = (yearEnd: number) => {
    const hit = runoff.find((r) => r.date.getUTCFullYear() === yearEnd)?.total;
    if (hit != null) return hit;
    // the as-at year (or earlier): what was owed that 31 March, by the register's own rule
    const ye = new Date(Date.UTC(yearEnd, 2, 31));
    if (reg.asAt && ye <= reg.asAt) return reg.loans.filter((l) => l.runsOff && !(l.start && l.start > ye)).reduce((t, l) => t + Math.max(0, REG.outstandingAt(l, ye)), 0);
    return undefined;
  };
  const rows: LBRow[] = [];
  labels.forEach((label, i) => {
    const a = gf.get(label) ?? {}, b = hra.get(label) ?? {};
    const sum = (k: string) => ((a[k] ?? 0) as number) + ((b[k] ?? 0) as number);
    const anyCfr = a.cfr != null || b.cfr != null || a.obs != null;
    if (!anyCfr) return;
    const yearEnd = fyEndYear(label)!;
    const cfr = sum('cfr'), obs = sum('obs'), liq = (a.liq ?? 0) as number;
    const typedLoans = a.loans != null || b.loans != null ? sum('loans') : null;
    const derived = loansAt(yearEnd);
    const existingLoans = typedLoans ?? (derived != null ? derived / 1e6 : 0);
    const ntp = cfr - obs, tib = Math.max(liq, -ntp), lb = ntp + tib;
    const need = Math.max(0, lb - existingLoans), over = Math.max(0, existingLoans - Math.max(0, lb));
    rows.push({ fy: label, yearEnd, cfr, obs, liq, existingLoans, ntp, tib, lb, need, over, requirement: need - over, actual: i === 0 });
  });
  return rows.length ? rows : null;
}
