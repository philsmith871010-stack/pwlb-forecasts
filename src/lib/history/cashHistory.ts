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
import { payeeHash } from '../governance/exceptions';
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
  /**
   * per account (same order as `accounts`): flat [day, number of bank lines, …]. Just a count, so a
   * statement loaded again can be told from a part export of it. Missing in histories saved before.
   */
  lines?: number[][];
  /**
   * every payee seen, one-way hashed (governance/exceptions `payeeHash`): enough to tell a new payee
   * from a known one, nothing more. Missing in histories saved before; filled again when the whole
   * history is loaded.
   */
  seen?: string[];
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
  const lineMaps = ds.accounts.map(() => new Map<Day, number>());
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
    lineMaps[a].set(day, (lineMaps[a].get(day) ?? 0) + 1);
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
  const lines = lineMaps.map((m) => [...m].flat());
  const seen = [...new Set(Array.from(res.sig, (s) => payeeHash(res.signatures[s])))];
  return { v: 1, updatedAt: new Date().toISOString(), cats, accounts, cells, lines, seen, series: [...series.values()].filter((s) => s.occ.length) };
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
  const lines: number[][] = base.accounts.map((_, i) => [...(base.lines?.[i] ?? [])]);
  const acctIx = (key: string) => {
    let i = accounts.findIndex((a) => a.key === key);
    if (i < 0) { accounts.push({ key, ranges: [], opening: null, openingDay: null, closing: null, closingDay: null }); cells.push([]); lines.push([]); i = accounts.length - 1; }
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
    const keptLines: number[] = [];
    for (let k = 0; k < lines[i].length; k += 2) if (!inRanges(lines[i][k], a.ranges)) keptLines.push(lines[i][k], lines[i][k + 1]);
    lines[i] = [...keptLines, ...(add.lines?.[j] ?? [])];
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
  // payees seen: both; or, for a history saved before they were kept, only once these files cover all of it
  const bs = historySpan(base), as = historySpan(add);
  const covers = !!bs && !!as && as.from <= bs.from + 31 && as.to >= bs.to;
  const seen = base.seen ? [...new Set([...base.seen, ...(add.seen ?? [])])] : covers ? add.seen : undefined;
  return { history: { v: 1, updatedAt: new Date().toISOString(), cats, accounts, cells, lines, seen, series: [...series.values()] }, report };
}

// ---------------------------------------------------------------- back to a forecast basis

/** Less history than this can't show a pattern: no look back or forecast from it yet. */
export const MIN_HISTORY_DAYS = 180;
export function historyDays(h: CashHistory | null | undefined): number { const s = h ? historySpan(h) : null; return s ? s.to - s.from + 1 : 0; }

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

// ---------------------------------------------------------------- a past day

export interface PastDaySummary {
  /** one row per category and kind, net for the day */
  rows: { cat: string; kind: number; net: number }[];
  /** accounts that hold this day */
  accounts: number;
  /** regular payments that day: payee, category and amount */
  regular: { sig: string; cat: string; amount: number }[];
  /** total balance at the end of the day, when every account's opening balance is known */
  closing: number | null;
  /**
   * The day as a bank statement, one row per account with a statement that day: the balance at the
   * start and end of the day (null when the files didn't show a balance), and money in and out.
   */
  statement: { key: string; opening: number | null; closing: number | null; in: number; out: number }[];
}

/** Days the history holds any money moving on, ascending. */
export function daysWithFlows(h: CashHistory): number[] {
  const s = new Set<number>();
  for (const c of h.cells) for (let k = 0; k < c.length; k += 4) s.add(c[k]);
  return [...s].sort((a, b) => a - b);
}

/** One day of the saved history, by category. Null when no account's statements cover it. */
export function pastDaySummary(h: CashHistory, d: number): PastDaySummary | null {
  const held = h.accounts.map((a) => a.ranges.some(([f, t]) => d >= f && d <= t));
  if (!held.some(Boolean)) return null;
  const byKey = new Map<string, { cat: string; kind: number; net: number }>();
  const statement: PastDaySummary['statement'] = [];
  let closing = 0, closingKnown = true;
  h.accounts.forEach((a, i) => {
    const cells = h.cells[i];
    let before = 0, upTo = 0, after = 0, inP = 0, outP = 0;
    for (let k = 0; k < cells.length; k += 4) {
      const cd = cells[k], v = cells[k + 3];
      if (a.openingDay !== null && cd < a.openingDay) before += v;
      if (cd <= d) upTo += v;
      if (a.closingDay !== null && cd > d && cd <= a.closingDay) after += v;
      if (cd !== d) continue;
      if (v > 0) inP += v; else outP += v;
      const cat = h.cats[cells[k + 1]], kind = cells[k + 2], key = `${cat}|${kind}`;
      const r = byKey.get(key) ?? { cat, kind, net: 0 };
      r.net += v / 100;
      byKey.set(key, r);
    }
    if (a.opening === null || a.openingDay === null) closingKnown = false;
    else closing += a.opening + (upTo - before) / 100;
    if (!held[i]) return;
    // the balance at the end of the day: forward from the first balance shown, else back from the last
    const end = a.opening !== null && a.openingDay !== null && d >= a.openingDay ? a.opening + (upTo - before) / 100
      : a.closing !== null && a.closingDay !== null && d <= a.closingDay ? a.closing - after / 100 : null;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    statement.push({ key: a.key, opening: end === null ? null : r2(end - (inP + outP) / 100), closing: end === null ? null : r2(end), in: inP / 100, out: outP / 100 });
  });
  const regular: PastDaySummary['regular'] = [];
  for (const s of h.series) for (const [od, p] of s.occ) if (od === d) regular.push({ sig: s.sig, cat: s.cat, amount: p / 100 });
  regular.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    rows: [...byKey.values()].filter((r) => Math.round(r.net * 100) !== 0),
    accounts: held.filter(Boolean).length, regular,
    closing: closingKnown ? Math.round(closing * 100) / 100 : null,
    statement,
  };
}

/** Rough size in the team file, for telling the user. */
export const historyBytes = (h: CashHistory) => JSON.stringify(h).length;

/** The history as it stood before `day` (used to hold back a day as "today's statement" in the example). */
export function historyBefore(h: CashHistory, day: Day): CashHistory {
  const accounts: HistoryAccount[] = [];
  const cells: number[][] = [];
  const lines: number[][] = [];
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
    const l = h.lines?.[i] ?? [];
    const kl: number[] = [];
    for (let k = 0; k < l.length; k += 2) if (l[k] < day) kl.push(l[k], l[k + 1]);
    lines.push(kl);
  });
  const acctMap = new Map(h.accounts.map((a, i) => [i, accounts.findIndex((x) => x.key === a.key)]));
  const series = h.series.map((s) => ({ ...s, occ: s.occ.filter(([d]) => d < day).map(([d, p, a]) => [d, p, acctMap.get(a)!] as [Day, number, number]) })).filter((s) => s.occ.length);
  return { ...h, updatedAt: new Date().toISOString(), accounts, cells, lines: h.lines ? lines : undefined, series };
}

// ---------------------------------------------------------------- loading what's already loaded

/** per account key: day → { net, gross } in pence, from the daily totals */
function dayTotals(h: CashHistory): Map<string, Map<Day, { net: number; gross: number }>> {
  const out = new Map<string, Map<Day, { net: number; gross: number }>>();
  h.accounts.forEach((a, i) => {
    const m = new Map<Day, { net: number; gross: number }>();
    const cells = h.cells[i] ?? [];
    for (let k = 0; k < cells.length; k += 4) {
      const t = m.get(cells[k]) ?? { net: 0, gross: 0 };
      t.net += cells[k + 3]; t.gross += Math.abs(cells[k + 3]);
      m.set(cells[k], t);
    }
    out.set(a.key, m);
  });
  return out;
}

/**
 * The same bank account under another name. A file with no account number is named after the
 * file, so the same statement saved as "export (2).csv" would otherwise become a second account
 * and be counted twice. A new account in `add` is the saved account whose days it shares match
 * figure for figure (most of them, and at least three), or, with no days in common, whose regular
 * payees are mostly its own. Returns `add` with those accounts renamed.
 */
export function matchAccounts(base: CashHistory, add: CashHistory): { add: CashHistory; matched: { from: string; to: string; why: string }[] } {
  const known = new Set(base.accounts.map((a) => a.key));
  const bt = dayTotals(base), at = dayTotals(add);
  const matched: { from: string; to: string; why: string }[] = [];
  const rename = new Map<string, string>();
  const taken = new Set(add.accounts.filter((a) => known.has(a.key)).map((a) => a.key));
  add.accounts.forEach((a, ai) => {
    if (known.has(a.key)) return;
    const mine = at.get(a.key)!;
    let best: { key: string; why: string; score: number } | null = null;
    for (const b of base.accounts) {
      if (taken.has(b.key)) continue;
      const theirs = bt.get(b.key)!;
      let shared = 0, same = 0;
      for (const [d, t] of mine) {
        if (!b.ranges.some(([f, to]) => d >= f && d <= to)) continue;
        shared++;
        const s = theirs.get(d);
        if (s && Math.abs(s.net - t.net) <= 100 && Math.abs(s.gross - t.gross) <= 100) same++;
      }
      if (shared >= 3 && same / shared >= 0.8) {
        const score = 1 + same / shared;
        if (!best || score > best.score) best = { key: b.key, why: `the same figures on ${same} of the ${shared} days you'd already loaded`, score };
        continue;
      }
      if (shared) continue;
      // no days in common: the regular payees
      const bi = base.accounts.indexOf(b);
      const theirSigs = new Set(base.series.filter((s) => s.occ.some((o) => o[2] === bi)).map((s) => s.sig));
      const mySigs = new Set(add.series.filter((s) => s.occ.some((o) => o[2] === ai)).map((s) => s.sig));
      if (mySigs.size < 3) continue;
      const inter = [...mySigs].filter((s) => theirSigs.has(s)).length / mySigs.size;
      if (inter >= 0.6 && (!best || inter > best.score)) best = { key: b.key, why: `${Math.round(inter * 100)}% of its regular payments are that account's`, score: inter };
    }
    if (best) { rename.set(a.key, best.key); taken.add(best.key); matched.push({ from: a.key, to: best.key, why: best.why }); }
  });
  if (!rename.size) return { add, matched };
  return { add: { ...add, accounts: add.accounts.map((a) => (rename.has(a.key) ? { ...a, key: rename.get(a.key)! } : a)) }, matched };
}

/** How a new file's days compare with the days the history already held for the same account. */
export interface OverlapReport {
  /** days already held with the same figures: nothing changes */
  same: number;
  /** days already held with different figures; `less`: the file has fewer bank lines that day than were saved (or, without counts, less money moving) */
  changed: { account: string; day: Day; saved: number; file: number; savedLines?: number; fileLines?: number; less: boolean }[];
  /** days not held before */
  fresh: number;
}

export function compareOverlap(base: CashHistory | null, add: CashHistory): OverlapReport {
  const r: OverlapReport = { same: 0, changed: [], fresh: 0 };
  const bt = base ? dayTotals(base) : new Map<string, Map<Day, { net: number; gross: number }>>();
  const at = dayTotals(add);
  const counts = (h: CashHistory | null, key: string) => {
    const i = h ? h.accounts.findIndex((x) => x.key === key) : -1;
    const l = i >= 0 ? h!.lines?.[i] : undefined;
    if (!l) return null;
    const m = new Map<Day, number>();
    for (let k = 0; k < l.length; k += 2) m.set(l[k], l[k + 1]);
    return m;
  };
  add.accounts.forEach((a) => {
    const savedLines = counts(base, a.key), fileLines = counts(add, a.key);
    const held = base?.accounts.find((b) => b.key === a.key);
    const theirs = bt.get(a.key), mine = at.get(a.key)!;
    for (const [f, t] of a.ranges) for (let d = f; d <= t; d++) {
      if (!held || !held.ranges.some(([x, y]) => d >= x && d <= y)) { if (mine.has(d)) r.fresh++; continue; }
      const s = theirs?.get(d) ?? { net: 0, gross: 0 }, n = mine.get(d) ?? { net: 0, gross: 0 };
      if (!s.gross && !n.gross) continue;
      // fewer bank lines than were saved (or, for histories saved before lines were counted, less money moving)
      const sl = savedLines?.get(d), fl = fileLines?.get(d) ?? 0;
      const sameFigures = Math.abs(s.net - n.net) <= 100 && Math.abs(s.gross - n.gross) <= 100;
      if (sameFigures && (sl === undefined || sl === fl)) r.same++;
      else r.changed.push({ account: a.key, day: d, saved: s.gross / 100, file: n.gross / 100, savedLines: sl, fileLines: sl !== undefined ? fl : undefined, less: sl !== undefined ? fl < sl : n.gross < s.gross - 100 });
    }
  });
  return r;
}

/** `add` without some days of some accounts (by key), so a merge keeps what was saved for them. */
export function withoutDays(add: CashHistory, drop: Map<string, Set<Day>>): CashHistory {
  if (!drop.size) return add;
  const accounts = add.accounts.map((a) => {
    const d = drop.get(a.key);
    if (!d?.size) return a;
    const ranges: [Day, Day][] = [];
    for (const [f, t] of a.ranges) {
      let s: Day | null = null;
      for (let x = f; x <= t + 1; x++) {
        const keep = x <= t && !d.has(x);
        if (keep && s === null) s = x;
        if (!keep && s !== null) { ranges.push([s, x - 1]); s = null; }
      }
    }
    return { ...a, ranges };
  });
  const cells = add.cells.map((c, i) => {
    const d = drop.get(add.accounts[i].key);
    if (!d?.size) return c;
    const out: number[] = [];
    for (let k = 0; k < c.length; k += 4) if (!d.has(c[k])) out.push(c[k], c[k + 1], c[k + 2], c[k + 3]);
    return out;
  });
  const lines = add.lines?.map((l, i) => {
    const d = drop.get(add.accounts[i].key);
    if (!d?.size) return l;
    const out: number[] = [];
    for (let k = 0; k < l.length; k += 2) if (!d.has(l[k])) out.push(l[k], l[k + 1]);
    return out;
  });
  const series = add.series.map((s) => ({ ...s, occ: s.occ.filter(([day, , ai]) => !drop.get(add.accounts[ai].key)?.has(day)) })).filter((s) => s.occ.length);
  return { ...add, accounts: accounts.filter((a) => a.ranges.length), cells: cells.filter((_, i) => accounts[i].ranges.length), lines: lines?.filter((_, i) => accounts[i].ranges.length), series: reindexSeries(series, accounts) };
}

/** series' account indexes after accounts with nothing left were dropped */
function reindexSeries(series: HistorySeries[], accounts: HistoryAccount[]): HistorySeries[] {
  const map: number[] = [];
  let j = 0;
  accounts.forEach((a, i) => { map[i] = a.ranges.length ? j++ : -1; });
  return series.map((s) => ({ ...s, occ: s.occ.filter(([, , ai]) => map[ai] >= 0).map(([d, p, ai]) => [d, p, map[ai]] as [Day, number, number]) })).filter((s) => s.occ.length);
}

/**
 * A session's history joined to the saved one without counting anything twice: accounts matched
 * to the saved ones they are, and days already held compared. Identical days change nothing;
 * days where this file has less money moving than was saved (a part export, say) keep what was
 * saved unless `useFileFor` says otherwise; other differences (a fuller or corrected statement)
 * take the file's figures.
 */
export function addToHistory(base: CashHistory | null, session: CashHistory, useFile = false): { history: CashHistory; report: MergeReport; overlap: OverlapReport; matched: { from: string; to: string; why: string }[]; kept: number } {
  const { add, matched } = base ? matchAccounts(base, session) : { add: session, matched: [] };
  const overlap = compareOverlap(base, add);
  const keep = new Map<string, Set<Day>>();
  if (!useFile) for (const c of overlap.changed) if (c.less) { if (!keep.has(c.account)) keep.set(c.account, new Set()); keep.get(c.account)!.add(c.day); }
  const kept = [...keep.values()].reduce((t, s) => t + s.size, 0);
  const { history, report } = mergeHistory(base, withoutDays(add, keep));
  return { history, report, overlap, matched, kept };
}
