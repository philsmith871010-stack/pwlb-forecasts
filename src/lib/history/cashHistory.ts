// The cash history kept in the team file, so a team never has to load every bank statement
// again: daily totals by category for each bank account, and the dates and amounts of each
// regular payment. No individual bank lines, no narratives other than regular payees.
//
// Each session's files become a history of the same shape (`fromSession`, built in the worker),
// merged into the saved one account by account: the days a new file covers replace whatever was
// held for those days of that account, so re-loading a statement never counts it twice and a
// part-day file can be loaded again at the end of the day.
import type { Dataset } from '../ingest/ingest';
import { type CatResult, DEAL_NO, describeDays, type Cadence } from '../categorise/engine';
import type { Aggregates, ForecastBasis, SeriesBasis } from '../analysis/aggregates';
import type { Day } from '../dates';

/** kind of a daily total */
export const K_OP = 0, K_ONEOFF = 1, K_TREASURY = 2, K_INTERNAL = 3;

export interface HistoryAccount {
  key: string;
  /** day ranges held, merged ([from, to], inclusive) */
  ranges: [Day, Day][];
  /** balance at the start of the first day held, if a statement showed it */
  opening: number | null;
  openingDay: Day | null;
  /** balance at the end of the last day held, if known */
  closing: number | null;
  closingDay: Day | null;
}

/** A regular payment: who, which category, which way, and every occurrence held. */
export interface HistorySeries {
  sig: string;
  cat: string;
  dir: 1 | -1;
  /** [day, amount (pence, signed), account index] */
  occ: [Day, number, number][];
}

export interface CashHistory {
  v: 1;
  updatedAt: string;
  /** built from the example data: never merged with a real council's history */
  example?: boolean;
  /** category ids used by `cells` (by index) */
  cats: string[];
  accounts: HistoryAccount[];
  /** per account (same order as `accounts`): flat [day, cat index, kind, pence, …] */
  cells: number[][];
  series: HistorySeries[];
}

const pence = (x: number) => Math.round(x * 100);

const PROJECTABLE: Cadence[] = ['weekly', 'fortnightly', 'semi_monthly', 'four_weekly', 'monthly', 'quarterly', 'half_yearly', 'annual'];

// ---------------------------------------------------------------- from a session's files

/**
 * The history held in this session's files. `knownSeries` are regular payments already in the
 * saved history: their lines here are kept as occurrences even if this session alone is too short
 * to see them repeat (e.g. one day's statement).
 */
export function fromSession(ds: Dataset, res: CatResult, knownSeries: { sig: string; cat: string; dir: 1 | -1 }[] = []): CashHistory {
  const cats = [...res.catIds, 'uncategorised'];
  const C = res.catIds.length;
  const internalIdx = res.catIds.indexOf('internal_transfer');
  const known = new Map(knownSeries.map((k) => [`${k.sig}|${k.dir}`, k]));
  // regular payments seen in this session (projectable, recurring, not one-off)
  const sessionSeries = new Map<number, HistorySeries>();
  for (const s of res.seriesList) {
    if (!PROJECTABLE.includes(s.cadence) || !s.recurring || s.classification === 'one_off' || s.categoryIdx < 0) continue;
    sessionSeries.set(s.id, { sig: s.signature, cat: res.catIds[s.categoryIdx], dir: s.direction, occ: [] });
  }
  const knownOcc = new Map<string, HistorySeries>();

  const cellMaps = ds.accounts.map(() => new Map<string, number>()); // `${day}|${cat}|${kind}` → pence
  const span = ds.accounts.map(() => ({ from: Infinity, to: -Infinity, flow: 0 }));
  for (let i = 0; i < ds.n; i++) {
    const a = ds.account[i], day = ds.day[i], amt = ds.amount[i];
    const c = res.cat[i] >= 0 ? res.cat[i] : C;
    span[a].from = Math.min(span[a].from, day); span[a].to = Math.max(span[a].to, day); span[a].flow += amt;
    const sig = res.signatures[res.sig[i]];
    const dir: 1 | -1 = amt < 0 ? -1 : 1;
    const kn = known.get(`${sig}|${dir}`);
    const inSessionSeries = res.series[i] >= 0 && sessionSeries.has(res.series[i]);
    let kind: number;
    if (c === internalIdx) kind = K_INTERNAL;
    else if (res.deal[i] !== DEAL_NO) kind = K_TREASURY;
    // as the forecast treats them: one-offs (outliers, or marked by the user) stay one-offs, except
    // that a payment the saved history knows is regular isn't a one-off just because this
    // session is too short to see it repeat
    else if (res.oneOff[i]) kind = kn && !inSessionSeries && res.classOverride[i] !== 1 && res.oneOffRule[i] !== 1 ? K_OP : K_ONEOFF;
    else kind = K_OP;
    const k = `${day}|${c}|${kind}`;
    cellMaps[a].set(k, (cellMaps[a].get(k) ?? 0) + pence(amt));
    // occurrences of regular payments
    if (kind === K_OP) {
      const ss = res.series[i] >= 0 ? sessionSeries.get(res.series[i]) : undefined;
      if (ss && res.catIds[c] === ss.cat) ss.occ.push([day, pence(amt), a]);
      else if (kn && res.catIds[c] === kn.cat) {
        let h = knownOcc.get(`${sig}|${dir}`);
        if (!h) knownOcc.set(`${sig}|${dir}`, (h = { sig, cat: kn.cat, dir, occ: [] }));
        h.occ.push([day, pence(amt), a]);
      }
    }
  }
  // the opening balance each account's statements show
  const opening = new Map<string, { bal: number; day: Day }>();
  for (const b of ds.balanceChecks) if (b.openingBalance !== null && b.openingDay !== null) {
    const cur = opening.get(b.account);
    if (!cur || b.openingDay < cur.day) opening.set(b.account, { bal: b.openingBalance, day: b.openingDay });
  }
  const accounts: HistoryAccount[] = ds.accounts.map((key, a) => {
    const o = opening.get(key);
    const from = Number.isFinite(span[a].from) ? span[a].from : ds.minDay, to = Number.isFinite(span[a].to) ? span[a].to : ds.maxDay;
    return { key, ranges: [[from, to]], opening: o ? o.bal : null, openingDay: o ? o.day : null, closing: o ? Math.round((o.bal + span[a].flow) * 100) / 100 : null, closingDay: o ? to : null };
  });
  const cells = cellMaps.map((m) => {
    const out: number[] = [];
    for (const [k, v] of m) { if (!v) continue; const [d, c, kind] = k.split('|').map(Number); out.push(d, c, kind, v); }
    return out;
  });
  // the same payment in this session's series and the saved one: one record
  const series = new Map<string, HistorySeries>();
  for (const s of [...sessionSeries.values(), ...knownOcc.values()]) {
    const key = `${s.sig}|${s.cat}|${s.dir}`;
    const cur = series.get(key);
    if (cur) cur.occ.push(...s.occ); else series.set(key, { ...s, occ: [...s.occ] });
  }
  return { v: 1, updatedAt: new Date().toISOString(), cats, accounts, cells, series: [...series.values()].filter((s) => s.occ.length) };
}

// ---------------------------------------------------------------- merging

function mergeRanges(r: [Day, Day][]): [Day, Day][] {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: [Day, Day][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}
const inRanges = (d: Day, r: [Day, Day][]) => r.some(([a, b]) => d >= a && d <= b);

/** What a merge did, for telling the user. */
export interface MergeReport { added: { account: string; from: Day; to: Day; replacedDays: number }[]; gaps: { account: string; from: Day; to: Day }[] }

/**
 * `add` laid over `base`: for each account in `add`, the days it covers replace what `base`
 * held for those days of that account. Everything else is kept.
 */
export function mergeHistory(base: CashHistory | null, add: CashHistory): { history: CashHistory; report: MergeReport } {
  const report: MergeReport = { added: [], gaps: [] };
  if (!base) {
    for (const a of add.accounts) for (const [f, t] of a.ranges) report.added.push({ account: a.key, from: f, to: t, replacedDays: 0 });
    return { history: add, report };
  }
  const cats = [...base.cats];
  const catIx = (id: string) => { let i = cats.indexOf(id); if (i < 0) { cats.push(id); i = cats.length - 1; } return i; };
  const accounts: HistoryAccount[] = base.accounts.map((a) => ({ ...a, ranges: a.ranges.map((r) => [r[0], r[1]] as [Day, Day]) }));
  const cells: number[][] = base.cells.map((c) => [...c]);
  const acctIx = (key: string) => {
    let i = accounts.findIndex((a) => a.key === key);
    if (i < 0) { accounts.push({ key, ranges: [], opening: null, openingDay: null, closing: null, closingDay: null }); cells.push([]); i = accounts.length - 1; }
    return i;
  };
  const addIx = add.accounts.map((a) => acctIx(a.key));
  // replace each account's covered days
  add.accounts.forEach((a, j) => {
    const i = addIx[j];
    const was = accounts[i];
    const replaced = new Set<Day>();
    const kept: number[] = [];
    const old = cells[i];
    for (let k = 0; k < old.length; k += 4) {
      if (inRanges(old[k], a.ranges)) { replaced.add(old[k]); continue; }
      kept.push(old[k], old[k + 1], old[k + 2], old[k + 3]);
    }
    const src = add.cells[j];
    for (let k = 0; k < src.length; k += 4) kept.push(src[k], catIx(add.cats[src[k + 1]]), src[k + 2], src[k + 3]);
    cells[i] = kept;
    // gaps between what was held and what's added
    const lastHeld = was.ranges.length ? Math.max(...was.ranges.map((r) => r[1])) : null;
    for (const [f, t] of a.ranges) {
      report.added.push({ account: a.key, from: f, to: t, replacedDays: [...replaced].filter((d) => d >= f && d <= t).length });
      if (lastHeld !== null && f > lastHeld + 4) report.gaps.push({ account: a.key, from: lastHeld + 1, to: f - 1 });
    }
    const ranges = mergeRanges([...was.ranges, ...a.ranges]);
    // balances: the earliest opening and the latest closing we know
    const opening = a.openingDay !== null && (was.openingDay === null || a.openingDay <= was.openingDay) ? { v: a.opening, d: a.openingDay } : { v: was.opening, d: was.openingDay };
    const closing = a.closingDay !== null && (was.closingDay === null || a.closingDay >= was.closingDay) ? { v: a.closing, d: a.closingDay } : { v: was.closing, d: was.closingDay };
    accounts[i] = { key: a.key, ranges, opening: opening.v, openingDay: opening.d, closing: closing.v, closingDay: closing.d };
  });
  // regular payments: occurrences on replaced days give way to the new ones
  const covered = (acct: number, d: Day) => { const j = addIx.indexOf(acct); return j >= 0 && inRanges(d, add.accounts[j].ranges); };
  const series = new Map<string, HistorySeries>();
  for (const s of base.series) {
    const occ = s.occ.filter(([d, , acct]) => !covered(acct, d));
    if (occ.length) series.set(`${s.sig}|${s.cat}|${s.dir}`, { ...s, occ });
  }
  for (const s of add.series) {
    const occ = s.occ.map(([d, p, acct]) => [d, p, addIx[acct]] as [Day, number, number]);
    const key = `${s.sig}|${s.cat}|${s.dir}`;
    const cur = series.get(key);
    if (cur) cur.occ = [...cur.occ, ...occ].sort((a, b) => a[0] - b[0]);
    else series.set(key, { ...s, occ });
  }
  return { history: { v: 1, updatedAt: new Date().toISOString(), cats, accounts, cells, series: [...series.values()] }, report };
}

// ---------------------------------------------------------------- back to a forecast basis

export function historySpan(h: CashHistory): { from: Day; to: Day } | null {
  const all = h.accounts.flatMap((a) => a.ranges);
  if (!all.length) return null;
  return { from: Math.min(...all.map((r) => r[0])), to: Math.max(...all.map((r) => r[1])) };
}

/** The forecast's view of the history: daily totals by category and the regular payments. */
export function basisFromHistory(h: CashHistory, catIds: string[]): ForecastBasis | null {
  const span = historySpan(h);
  if (!span) return null;
  const C = catIds.length;
  const startDay = span.from, D = span.to - span.from + 1;
  const op = new Float64Array((C + 1) * D), opOneOff = new Float64Array((C + 1) * D), treasury = new Float64Array((C + 1) * D), internal = new Float64Array(D);
  const rowCounts = new Int32Array(C + 1);
  const map = h.cats.map((id) => { const i = catIds.indexOf(id); return i >= 0 ? i : C; });
  for (const cells of h.cells) for (let k = 0; k < cells.length; k += 4) {
    const d = cells[k] - startDay, c = map[cells[k + 1]], kind = cells[k + 2], v = cells[k + 3] / 100;
    if (d < 0 || d >= D) continue;
    rowCounts[c]++;
    if (kind === K_INTERNAL) internal[d] += v;
    else if (kind === K_TREASURY) treasury[c * D + d] += v;
    else if (kind === K_ONEOFF) opOneOff[c * D + d] += v;
    else op[c * D + d] += v;
  }
  // the balance at the start: each account's opening, carried back to the history's first day
  let openingBalance = 0, openingKnown = false;
  h.accounts.forEach((a, i) => {
    if (a.opening === null || a.openingDay === null) return;
    openingKnown = true;
    // flows held for this account before its known opening day move it back
    let before = 0;
    const cells = h.cells[i];
    for (let k = 0; k < cells.length; k += 4) if (cells[k] < a.openingDay) before += cells[k + 3] / 100;
    openingBalance += a.opening - before;
  });
  const agg: Aggregates = { startDay, D, catIds, op, opOneOff, treasury, internal, openingBalance: Math.round(openingBalance * 100) / 100, openingKnown, rowCounts };

  const series: SeriesBasis[] = [];
  h.series.forEach((s, id) => {
    const catIdx = catIds.indexOf(s.cat);
    if (catIdx < 0) return;
    const byDay = new Map<Day, number>();
    for (const [d, p] of s.occ) byDay.set(d, (byDay.get(d) ?? 0) + p / 100);
    const days = [...byDay.keys()].filter((d) => byDay.get(d)! !== 0).sort((a, b) => a - b);
    if (days.length < 3) return;
    const amounts = days.map((d) => byDay.get(d)!);
    const dd = describeDays(days, amounts.map(Math.abs), span.to);
    if (!PROJECTABLE.includes(dd.cadence) || !dd.recurring) return;
    series.push({
      id, catIdx, signature: s.sig, cadence: dd.cadence, dayOfMonth: dd.cadence === 'semi_monthly' ? dd.dom1 : dd.dom, dayOfMonth2: dd.cadence === 'semi_monthly' ? dd.dom2 : undefined,
      lastWorkingDay: dd.lwdShare > 0.7 && dd.cadence === 'monthly', regularity: dd.regularity, amountCV: dd.cv, trendPct: dd.trend,
      typicalAmount: dd.medAmt * s.dir, active: dd.active, firstDay: days[0], lastDay: days[days.length - 1],
      days: Int32Array.from(days), amounts: Float64Array.from(amounts),
    });
  });
  return { agg, series, dataEnd: span.to };
}

/** Rough size in the team file, for telling the user. */
export const historyBytes = (h: CashHistory) => JSON.stringify(h).length;

/** The history as it stood before `day` (used to hold back a day as "today's statement" in the example). */
export function historyBefore(h: CashHistory, day: Day): CashHistory {
  const accounts: HistoryAccount[] = [];
  const cells: number[][] = [];
  h.accounts.forEach((a, i) => {
    const keep: number[] = [];
    let removed = 0;
    const src = h.cells[i];
    for (let k = 0; k < src.length; k += 4) {
      if (src[k] >= day) { removed += src[k + 3]; continue; }
      keep.push(src[k], src[k + 1], src[k + 2], src[k + 3]);
    }
    const ranges = a.ranges.filter((r) => r[0] < day).map((r) => [r[0], Math.min(r[1], day - 1)] as [Day, Day]);
    if (!ranges.length) return;
    const last = Math.max(...ranges.map((r) => r[1]));
    accounts.push({
      ...a, ranges,
      closing: a.closing !== null && a.closingDay !== null ? Math.round((a.closing - (a.closingDay >= day ? removed / 100 : 0)) * 100) / 100 : null,
      closingDay: a.closingDay !== null ? Math.min(a.closingDay, last) : null,
    });
    cells.push(keep);
  });
  const acctMap = new Map(h.accounts.map((a, i) => [i, accounts.findIndex((x) => x.key === a.key)]));
  const series = h.series.map((s) => ({ ...s, occ: s.occ.filter(([d]) => d < day).map(([d, p, a]) => [d, p, acctMap.get(a)!] as [Day, number, number]) })).filter((s) => s.occ.length);
  return { ...h, updatedAt: new Date().toISOString(), accounts, cells, series };
}
