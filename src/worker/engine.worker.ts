/// <reference lib="webworker" />
// The engine worker owns the transaction dataset. The main thread only ever receives
// summaries, aggregates and small pages of rows — the UI never freezes, and raw data never
// leaves this worker except as a CSV the user explicitly asks to save.

import * as Comlink from 'comlink';
import { detectMapping, DetectionReport, ColumnMapping } from '../lib/ingest/detect';
import { ingest, Dataset, IngestSource } from '../lib/ingest/ingest';
import {
  categorise, CatConfig, CatResult, rowKey, SPECIAL_RULE_LABELS, DEAL_NO, DEAL_SUSPECTED, CONF_LOW,
  F_DEAL_LIKE_OP, F_LOAN_PAIR, F_OUTLIER, F_SINGLE, F_LARGE, FLAG_LABELS,
} from '../lib/categorise/engine';
import { computeAccuracy, AccuracyReport } from '../lib/categorise/accuracy';
import { buildBasis, ForecastBasis, Aggregates } from '../lib/analysis/aggregates';
import { runBacktest, runRolling, BacktestOptions, BacktestResult, RollingResult } from '../lib/forecast/backtest';
import { generateDataset, GeneratorOptions } from '../generator';
import type { TruthFile } from '../generator/render';
import { isBusinessDay, isoFromDay, Day } from '../lib/dates';
import type { IngestSummary, CatSummary, TxnRow, ReviewGroup, DealQueue, TxnFilter, CategoryDetail, LoanPair, RegisterInfo } from './types';
import { readRegisterWorkbook, registerFromSnapshot, LoadedRegister, REG } from '../lib/register';
import { registerEvents, registerAccounts, liquidBalances, toDay, CashEvent } from '../lib/register/cashflows';
import { liabilityBenchmark } from '../lib/register/benchmark';
import { fromSession, type CashHistory } from '../lib/history/cashHistory';

let ds: Dataset | null = null;
let res: CatResult | null = null;
let basis: ForecastBasis | null = null;
let truth: TruthFile | null = null;
const demoFiles = new Map<string, string>();
let demoRegister: unknown = null;
let register: { loaded: LoadedRegister; events: CashEvent[]; example: boolean } | null = null;

function registerInfo(): RegisterInfo | null {
  if (!register) return null;
  const { loaded, events, example } = register;
  const reg = loaded.reg;
  const dd = (x: Date | null) => (x ? toDay(x) : null);
  const asAt = reg.asAt;
  const live = (x: { history: boolean; runsOff: boolean }) => !x.history && x.runsOff;
  return {
    name: loaded.name, example, asAt: dd(asAt), stats: loaded.stats, issues: reg.issues.slice(0, 50),
    liquid: liquidBalances(reg),
    events: events.map((e) => ({ day: e.day, amount: e.amount, label: e.label, kind: e.kind, ref: e.ref })),
    loboCalls: reg.loans.filter((l) => live(l) && l.type === 'LOBO' && l.nextCall && asAt && l.nextCall > asAt).map((l) => ({ day: toDay(l.nextCall!), amount: l.principal, label: `LOBO · ${l.lender}` })),
    lb: liabilityBenchmark(reg),
    loans: reg.loans.filter(live).map((l) => ({ ref: `loan:${l.row}`, type: l.type ?? l.typeRaw, lender: l.lender, principal: l.principal, rate: l.rate, start: dd(l.start), maturity: dd(l.maturity), profile: l.profile ?? 'Maturity', nextCall: dd(l.nextCall) })),
    investments: reg.termInvestments.filter(live).map((t) => ({ ref: `term:${t.row}`, type: t.type ?? '', counterparty: t.counterparty, principal: t.principal, rate: t.rate, start: dd(t.start), maturity: dd(t.maturity) })),
  };
}

function setRegister(loaded: LoadedRegister, example: boolean): RegisterInfo {
  register = { loaded, events: registerEvents(loaded.reg), example };
  return registerInfo()!;
}
void REG;
let filterCache: { key: string; idx: Int32Array } | null = null;

type Progress = (p: { phase: string; frac: number; rows?: number }) => void;

function need<T>(x: T | null, what: string): T {
  if (!x) throw new Error(`${what} not available yet`);
  return x;
}

function ruleLabel(r: number): { label: string; id: string | null } {
  if (r < 0) return { label: SPECIAL_RULE_LABELS[r] ?? 'Heuristic', id: null };
  const rule = res!.ruleList[r];
  const who = rule.source === 'starter' ? 'Starter rule' : 'Team rule';
  return { label: `${who}: ${rule.type} “${rule.pattern.length > 60 ? rule.pattern.slice(0, 57) + '…' : rule.pattern}”`, id: rule.id };
}

function row(i: number): TxnRow {
  const d = ds!, r = res!;
  const rl = ruleLabel(r.rule[i]);
  return {
    i, key: rowKey(d, i, r.signatures[r.sig[i]]), day: d.day[i], amount: d.amount[i], account: d.accounts[d.account[i]],
    narrative: d.narratives[d.narr[i]], signature: r.signatures[r.sig[i]], catIdx: r.cat[i], rule: rl.label, ruleId: rl.id,
    conf: r.conf[i], deal: r.deal[i], flags: r.flags[i], oneOff: r.oneOff[i], seriesId: r.series[i],
    file: d.files[d.file[i]]?.name ?? '', line: d.line[i] + 1,
  };
}

const api = {
  async sniff(file: File): Promise<DetectionReport> {
    const text = await file.slice(0, 96 * 1024).text();
    return detectMapping(text, file.name);
  },

  async generateDemo(o: GeneratorOptions): Promise<{ files: { name: string; size: number; report: DetectionReport }[]; rows: number }> {
    demoFiles.clear();
    const g = generateDataset(o);
    demoRegister = g.register;
    for (const f of g.files) demoFiles.set(f.name, f.text);
    truth = g.truth;
    return {
      files: g.files.map((f) => ({ name: f.name, size: f.text.length, report: detectMapping(f.text.slice(0, 96 * 1024), f.name) })),
      rows: g.stats.rows,
    };
  },

  // ------------------------------------------------------------- deal register

  async loadRegister(bytes: Uint8Array, name: string): Promise<RegisterInfo> {
    return setRegister(await readRegisterWorkbook(bytes, name), false);
  },

  hasExampleRegister(): boolean { return !!demoRegister; },

  useExampleRegister(o?: GeneratorOptions): RegisterInfo {
    if (!demoRegister) demoRegister = generateDataset(o ?? { seed: 'northbridge', startFY: 2021, years: 5, preset: 'small', accounts: 4, nastiness: 1 }).register;
    return setRegister(registerFromSnapshot(demoRegister, 'Northbridge Council deal register (example)'), true);
  },

  clearRegister(): void { register = null; },

  registerInfo(): RegisterInfo | null { return registerInfo(); },

  /** The example council's statement for its last day, generated afresh (works after a reload). */
  async exampleLastDayStatement(o: GeneratorOptions): Promise<{ name: string; size: number; report: DetectionReport; day: Day }> {
    const g = generateDataset(o);
    demoRegister = g.register;
    const tmp = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96 * 1024), f.name).mapping })));
    const day = tmp.maxDay;
    const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const iso = isoFromDay(day);
    const lines = ['Date,Account Number,Description,Amount'];
    for (let i = 0; i < tmp.n; i++) if (tmp.day[i] === day) lines.push([`${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, tmp.accounts[tmp.account[i]], q(tmp.narratives[tmp.narr[i]]), tmp.amount[i].toFixed(2)].join(','));
    const name = `northbridge_statement_${iso}.csv`;
    const text = lines.join('\n') + '\n';
    demoFiles.set(name, text);
    return { name, size: text.length, report: detectMapping(text, name), day };
  },

  /** The example's bank lines for one day, written as an ordinary statement export (for trying day-to-day use). */
  exampleStatement(day: Day): { name: string; size: number; report: DetectionReport } {
    const d = need(ds, 'Data');
    const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const iso = isoFromDay(day);
    const lines = ['Date,Account Number,Description,Amount'];
    for (let i = 0; i < d.n; i++) {
      if (d.day[i] !== day) continue;
      lines.push([`${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, d.accounts[d.account[i]], q(d.narratives[d.narr[i]]), d.amount[i].toFixed(2)].join(','));
    }
    const name = `northbridge_statement_${iso}.csv`;
    const text = lines.join('\n') + '\n';
    demoFiles.set(name, text);
    return { name, size: text.length, report: detectMapping(text, name) };
  },

  demoFileBlob(name: string): Blob | null {
    const t = demoFiles.get(name);
    return t ? new Blob([t], { type: 'text/csv' }) : null;
  },

  truthBlob(): Blob | null {
    return truth ? new Blob([JSON.stringify(truth)], { type: 'application/json' }) : null;
  },

  loadTruth(text: string): { ok: boolean; files: number; message: string } {
    try {
      const t = JSON.parse(text) as TruthFile;
      if (t.kind !== 'cash-flow-insight-truth') return { ok: false, files: 0, message: 'Not a Cash Flow Insight truth file.' };
      truth = t;
      return { ok: true, files: t.files.length, message: `Truth file loaded (${t.files.length} files).` };
    } catch (e) {
      return { ok: false, files: 0, message: `Could not read truth file: ${(e as Error).message}` };
    }
  },

  hasTruth(): boolean { return !!truth; },

  async ingest(sources: { name: string; file?: File; mapping: ColumnMapping }[], onProgress?: Progress): Promise<IngestSummary> {
    const t0 = performance.now();
    res = null; basis = null; filterCache = null;
    const srcs: IngestSource[] = sources.map((s) => {
      const demo = demoFiles.get(s.name);
      if (!s.file && demo === undefined) throw new Error(`File ${s.name} is no longer available — please add it again.`);
      return { name: s.name, data: s.file ?? demo!, size: s.file ? s.file.size : demo!.length, mapping: s.mapping };
    });
    ds = await ingest(srcs, (p) => onProgress?.({ phase: p.phase, frac: p.total ? p.done / p.total : 0, rows: p.rows }));
    let swapped = 0, dups = 0;
    for (let i = 0; i < ds.n; i++) { if (ds.rowFlags[i] & 1) swapped++; if (ds.rowFlags[i] & 2) dups++; }
    // coverage gaps: runs of ≥ 5 business days with no rows at all
    const gaps: IngestSummary['coverageGaps'] = [];
    if (ds.n) {
      const has = new Uint8Array(ds.maxDay - ds.minDay + 1);
      for (let i = 0; i < ds.n; i++) has[ds.day[i] - ds.minDay] = 1;
      let run = 0, from = -1;
      for (let d = 0; d < has.length; d++) {
        const day = ds.minDay + d;
        if (!isBusinessDay(day)) continue;
        if (!has[d]) { if (run === 0) from = day; run++; }
        else { if (run >= 5) gaps.push({ from, to: day - 1, businessDays: run }); run = 0; }
      }
    }
    return {
      rows: ds.n, files: ds.files, rejectsTotal: ds.files.reduce((s, f) => s + f.rowsRejected, 0), rejectSample: ds.rejects.slice(0, 500),
      accounts: ds.accounts, minDay: ds.minDay, maxDay: ds.maxDay, balanceChecks: ds.balanceChecks, openingBalance: ds.openingBalance,
      swappedDates: swapped, dupCandidates: dups, overlapRemoved: ds.files.reduce((s, f) => s + f.overlapDuplicatesRemoved, 0),
      coverageGaps: gaps, ms: performance.now() - t0,
    };
  },

  rejectLogBlob(): Blob {
    const d = need(ds, 'Data');
    const lines = ['file,line,reason,raw'];
    for (const r of d.rejects) lines.push([r.file, r.line, r.reason, r.raw].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    return new Blob([lines.join('\n')], { type: 'text/csv' });
  },

  async categorise(cfg: CatConfig, onProgress?: Progress): Promise<CatSummary> {
    const d = need(ds, 'Data');
    const t0 = performance.now();
    filterCache = null;
    const withReg: CatConfig = register ? { ...cfg, registerEvents: register.events.filter((e) => e.day <= d.maxDay + 3), registerAccounts: registerAccounts(register.loaded.reg) } : cfg;
    res = categorise(d, withReg, (phase, frac) => onProgress?.({ phase, frac }));
    basis = buildBasis(d, res);
    const r = res;
    const C = r.catIds.length;
    const internalIdx = r.catIds.indexOf('internal_transfer');
    const byCategory = Array.from({ length: C + 1 }, () => ({ rows: 0, valueIn: 0, valueOut: 0, abs: 0, deal: 0, oneOff: 0 }));
    let operationalAbs = 0, treasuryAbs = 0, internalAbs = 0, uncAbs = 0, uncRows = 0, lowAbs = 0, lowRows = 0, dealAbs = 0, suspAbs = 0, suspRows = 0, dlAbs = 0, dlRows = 0, outl = 0;
    const flagCounts: Record<number, number> = {};
    const bySourceMap = new Map<string, { rows: number; abs: number }>();
    for (let i = 0; i < d.n; i++) {
      const c = r.cat[i] >= 0 ? r.cat[i] : C;
      const a = d.amount[i], ab = Math.abs(a);
      const b = byCategory[c];
      b.rows++; b.abs += ab;
      if (a >= 0) b.valueIn += a; else b.valueOut += a;
      if (r.deal[i] !== DEAL_NO) b.deal += ab;
      if (r.oneOff[i]) b.oneOff += ab;
      if (c === internalIdx) internalAbs += ab;
      else if (r.deal[i] !== DEAL_NO) { treasuryAbs += ab; if (r.deal[i] === DEAL_SUSPECTED) { suspAbs += ab; suspRows++; } else dealAbs += ab; }
      else operationalAbs += ab;
      if (r.cat[i] < 0) { uncAbs += ab; uncRows++; }
      else if (r.conf[i] === CONF_LOW && c !== internalIdx) { lowAbs += ab; lowRows++; }
      if (r.flags[i] & F_DEAL_LIKE_OP) { dlAbs += ab; dlRows++; }
      if (r.flags[i] & F_OUTLIER) outl++;
      for (const [f] of FLAG_LABELS) if (r.flags[i] & f) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
      const src = r.rule[i] >= 0 ? (r.ruleList[r.rule[i]].source === 'starter' ? 'Starter rules' : 'Team rules') : r.rule[i] === -1 ? 'Uncategorised' : SPECIAL_RULE_LABELS[r.rule[i]].split(':')[0];
      const bs = bySourceMap.get(src) ?? { rows: 0, abs: 0 };
      bs.rows++; bs.abs += ab;
      bySourceMap.set(src, bs);
    }
    const totalAbs = operationalAbs + treasuryAbs + uncAbs * 0; // uncategorised is inside operationalAbs
    const nonInternal = operationalAbs + treasuryAbs;
    void totalAbs;
    return {
      rows: d.n, ms: performance.now() - t0, stageMs: r.ms, catIds: r.catIds, byCategory,
      operationalAbs, treasuryAbs, internalAbs, uncategorisedAbs: uncAbs, uncategorisedRows: uncRows, lowConfAbs: lowAbs, lowConfRows: lowRows,
      dealAbs, suspectedAbs: suspAbs, suspectedRows: suspRows, dealLikeOpAbs: dlAbs, dealLikeOpRows: dlRows, outlierRows: outl,
      valueCategorisedPct: nonInternal ? 1 - uncAbs / nonInternal : 1,
      seriesCount: r.seriesList.length, recurringUnknown: r.seriesList.filter((s) => s.categoryIdx < 0 && s.recurring).length,
      ruleHits: r.ruleList.map((rule, k) => ({ id: rule.id, hits: r.ruleHits[k] })),
      rulesUsed: r.ruleHits.filter((h) => h > 0).length, flagCounts,
      bySource: [...bySourceMap.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.abs - a.abs),
      registerMatch: r.registerMatch ?? null,
    };
  },

  /** This session's files as cash history (aggregates and regular payments only, no lines). */
  sessionHistory(known: { sig: string; cat: string; dir: 1 | -1 }[]): CashHistory {
    return fromSession(need(ds, 'Data'), need(res, 'Categorisation'), known);
  },

  getAggregates(): Aggregates {
    const b = need(basis, 'Categorisation');
    return Comlink.transfer(cloneAgg(b.agg), [] as Transferable[]);
  },

  getBasis(): ForecastBasis {
    return need(basis, 'Categorisation');
  },

  accuracy(): AccuracyReport | null {
    if (!truth || !ds || !res) return null;
    return computeAccuracy(ds, res, truth);
  },

  // ------------------------------------------------------------- review queues

  uncategorisedQueue(limit = 400): { groups: ReviewGroup[] } {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const internalIdx = r.catIds.indexOf('internal_transfer');
    const groups = groupRows((i) => r.cat[i] !== internalIdx && r.deal[i] === DEAL_NO && (r.cat[i] < 0 || r.conf[i] === CONF_LOW));
    void d;
    return { groups: groups.slice(0, limit) };
  },

  dealQueue(limit = 300): DealQueue {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const groups = groupRows((i) => r.deal[i] !== DEAL_NO).slice(0, limit);
    // loan pairs
    const pairs: LoanPair[] = [];
    const flagged: number[] = [];
    for (let i = 0; i < d.n; i++) if (r.flags[i] & F_LOAN_PAIR) flagged.push(i);
    const used = new Set<number>();
    for (let x = 0; x < flagged.length; x++) {
      const i = flagged[x];
      if (used.has(i)) continue;
      for (let y = x + 1; y < flagged.length; y++) {
        const j = flagged[y];
        if (used.has(j) || d.account[j] !== d.account[i] || Math.sign(d.amount[j]) === Math.sign(d.amount[i])) continue;
        const ratio = Math.abs(d.amount[j]) / Math.abs(d.amount[i]);
        const days = d.day[j] - d.day[i];
        if (ratio < 1 || ratio > 1.08 || days < 7 || days > 400) continue;
        used.add(i); used.add(j);
        pairs.push({ first: row(i), second: row(j), days, impliedRate: days ? (ratio - 1) * 365 / days : 0 });
        break;
      }
      if (pairs.length >= 200) break;
    }
    pairs.sort((a, b) => Math.abs(b.first.amount) - Math.abs(a.first.amount));
    // operational items that look deal-like, plus the largest irregular unconfirmed items
    const cand: number[] = [];
    for (let i = 0; i < d.n; i++) {
      if (r.deal[i] !== DEAL_NO) continue;
      const f = r.flags[i];
      if ((f & F_DEAL_LIKE_OP) || ((f & (F_LARGE | F_SINGLE)) && r.series[i] < 0 && r.rule[i] !== -7)) cand.push(i);
    }
    cand.sort((a, b) => Math.abs(d.amount[b]) - Math.abs(d.amount[a]));
    let excludedAbs = 0, suspectedAbs = 0;
    for (let i = 0; i < d.n; i++) if (r.deal[i] !== DEAL_NO) { excludedAbs += Math.abs(d.amount[i]); if (r.deal[i] === DEAL_SUSPECTED) suspectedAbs += Math.abs(d.amount[i]); }
    return { groups, pairs: pairs.slice(0, 100), dealLike: cand.slice(0, 150).map(row), excludedAbs, suspectedAbs };
  },

  outlierQueue(limit = 300): TxnRow[] {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const internalIdx = r.catIds.indexOf('internal_transfer');
    const idx: number[] = [];
    for (let i = 0; i < d.n; i++) {
      if (r.deal[i] !== DEAL_NO || r.cat[i] < 0 || r.cat[i] === internalIdx) continue;
      if ((r.flags[i] & F_OUTLIER) || ((r.flags[i] & F_SINGLE) && Math.abs(d.amount[i]) >= 1e6) || (r.oneOff[i] && Math.abs(d.amount[i]) >= 1e6)) idx.push(i);
    }
    idx.sort((a, b) => Math.abs(d.amount[b]) - Math.abs(d.amount[a]));
    return idx.slice(0, limit).map(row);
  },

  // ------------------------------------------------------------- transactions

  queryTxns(f: TxnFilter, offset: number, limit: number): { total: number; rows: TxnRow[]; sumIn: number; sumOut: number } {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const key = JSON.stringify(f);
    if (!filterCache || filterCache.key !== key) {
      const out: number[] = [];
      const s = f.search?.trim().toUpperCase();
      const acct = f.account ? d.accounts.indexOf(f.account) : -1;
      for (let i = 0; i < d.n; i++) {
        if (f.catIdx != null && r.cat[i] !== f.catIdx) continue;
        if (f.uncategorised && r.cat[i] >= 0) continue;
        if (f.sigIdx != null && r.sig[i] !== f.sigIdx) continue;
        if (f.seriesId != null && r.series[i] !== f.seriesId) continue;
        if (f.deal === 'deal' && r.deal[i] === DEAL_NO) continue;
        if (f.deal === 'operational' && r.deal[i] !== DEAL_NO) continue;
        if (f.flagMask && !(r.flags[i] & f.flagMask)) continue;
        if (f.oneOff && !r.oneOff[i]) continue;
        if (f.from != null && d.day[i] < f.from) continue;
        if (f.to != null && d.day[i] > f.to) continue;
        if (acct >= 0 && d.account[i] !== acct) continue;
        if (s && !d.narratives[d.narr[i]].toUpperCase().includes(s) && !r.signatures[r.sig[i]].includes(s)) continue;
        out.push(i);
      }
      if (f.sort === 'abs_desc') out.sort((a, b) => Math.abs(d.amount[b]) - Math.abs(d.amount[a]));
      else if (f.sort === 'day_desc') out.reverse();
      filterCache = { key, idx: Int32Array.from(out) };
    }
    const idx = filterCache.idx;
    let sumIn = 0, sumOut = 0;
    for (let k = 0; k < idx.length; k++) { const a = d.amount[idx[k]]; if (a >= 0) sumIn += a; else sumOut += a; }
    const rows: TxnRow[] = [];
    for (let k = offset; k < Math.min(idx.length, offset + limit); k++) rows.push(row(idx[k]));
    return { total: idx.length, rows, sumIn, sumOut };
  },

  rowsForSignature(sigIdx: number, limit = 2000): TxnRow[] {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const out: TxnRow[] = [];
    for (let i = 0; i < d.n && out.length < limit; i++) if (r.sig[i] === sigIdx) out.push(row(i));
    return out;
  },

  categoryDetail(catIdx: number): CategoryDetail {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const sigTot = new Map<number, { count: number; total: number; abs: number }>();
    const seriesIn = new Map<number, number>();
    const oneOffIdx: number[] = [];
    let excluded = 0;
    for (let i = 0; i < d.n; i++) {
      if (r.cat[i] !== catIdx) continue;
      if (r.deal[i] !== DEAL_NO) { excluded += Math.abs(d.amount[i]); continue; }
      const t = sigTot.get(r.sig[i]) ?? { count: 0, total: 0, abs: 0 };
      t.count++; t.total += d.amount[i]; t.abs += Math.abs(d.amount[i]);
      sigTot.set(r.sig[i], t);
      if (r.series[i] >= 0) seriesIn.set(r.series[i], (seriesIn.get(r.series[i]) ?? 0) + d.amount[i]);
      if (r.oneOff[i]) oneOffIdx.push(i);
    }
    oneOffIdx.sort((a, b) => Math.abs(d.amount[b]) - Math.abs(d.amount[a]));
    return {
      series: r.seriesList.filter((s) => seriesIn.has(s.id)).map((s) => ({ ...s, inCategory: seriesIn.get(s.id)! })).sort((a, b) => Math.abs(b.inCategory) - Math.abs(a.inCategory)),
      topSignatures: [...sigTot.entries()].map(([sigIdx, v]) => ({ sigIdx, signature: r.signatures[sigIdx], ...v })).sort((a, b) => b.abs - a.abs).slice(0, 25),
      oneOffs: oneOffIdx.slice(0, 100).map(row),
      excludedAsDeal: excluded,
    };
  },

  seriesInfo(): { id: number; signature: string; cadence: string; categoryIdx: number; typicalAmount: number; occurrences: number; active: boolean; classification: string; lastDay: Day; firstDay: Day; trendPct: number; dayOfMonth: number; lastWorkingDay: boolean; regularity: number; total: number }[] {
    const r = need(res, 'Categorisation');
    return r.seriesList.map((s) => ({ id: s.id, signature: s.signature, cadence: s.cadence, categoryIdx: s.categoryIdx, typicalAmount: s.typicalAmount, occurrences: s.occurrences, active: s.active, classification: s.classification, lastDay: s.lastDay, firstDay: s.firstDay, trendPct: s.trendPct, dayOfMonth: s.dayOfMonth, lastWorkingDay: s.lastWorkingDay, regularity: s.regularity, total: s.total }));
  },

  // ------------------------------------------------------------- backtests

  backtest(o: BacktestOptions): BacktestResult {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation'), b = need(basis, 'Categorisation');
    return runBacktest(d, r, b.agg, o);
  },

  rolling(o: Omit<BacktestOptions, 'cutoff'>, onProgress?: (k: number, n: number) => void): RollingResult {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation'), b = need(basis, 'Categorisation');
    return runRolling(d, r, b.agg, o, onProgress);
  },

  // ------------------------------------------------------------- exports

  categorisedCsv(catNames: string[]): Blob {
    const d = need(ds, 'Data'), r = need(res, 'Categorisation');
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const parts: string[] = ['date,account,amount,narrative,category,deal_flag,classification,confidence,rule,flags,source_file,source_line\n'];
    let buf: string[] = [];
    for (let i = 0; i < d.n; i++) {
      const c = r.cat[i];
      const flags = FLAG_LABELS.filter(([f]) => r.flags[i] & f).map(([, l]) => l).join('; ');
      buf.push([
        isoFromDay(d.day[i]), d.accounts[d.account[i]], d.amount[i].toFixed(2), esc(d.narratives[d.narr[i]]),
        esc(c >= 0 ? catNames[c] : 'Uncategorised'), ['not_deal', 'deal', 'suspected'][r.deal[i]], r.oneOff[i] ? 'one_off' : 'recurring',
        ['low', 'medium', 'high'][r.conf[i]], esc(ruleLabel(r.rule[i]).label), esc(flags), esc(d.files[d.file[i]]?.name ?? ''), String(d.line[i] + 1),
      ].join(',') + '\n');
      if (buf.length >= 20000) { parts.push(buf.join('')); buf = []; }
    }
    parts.push(buf.join(''));
    return new Blob(parts, { type: 'text/csv' });
  },

  datasetInfo(): { rows: number; minDay: Day; maxDay: Day } | null {
    return ds ? { rows: ds.n, minDay: ds.minDay, maxDay: ds.maxDay } : null;
  },
};

function groupRows(pred: (i: number) => boolean): ReviewGroup[] {
  const d = ds!, r = res!;
  const groups = new Map<number, { rows: number[]; total: number; abs: number; inn: boolean; out: boolean; flags: number }>();
  for (let i = 0; i < d.n; i++) {
    if (!pred(i)) continue;
    const s = r.sig[i];
    let g = groups.get(s);
    if (!g) groups.set(s, (g = { rows: [], total: 0, abs: 0, inn: false, out: false, flags: 0 }));
    g.rows.push(i);
    g.total += d.amount[i]; g.abs += Math.abs(d.amount[i]);
    if (d.amount[i] >= 0) g.inn = true; else g.out = true;
    g.flags |= r.flags[i];
  }
  const out: ReviewGroup[] = [];
  for (const [s, g] of groups) {
    const first = g.rows[0], last = g.rows[g.rows.length - 1];
    const samples = new Set<string>();
    for (const i of g.rows) { samples.add(d.narratives[d.narr[i]]); if (samples.size >= 4) break; }
    const seriesIds = new Set(g.rows.map((i) => r.series[i]).filter((x) => x >= 0));
    const ser = seriesIds.size ? r.seriesList[[...seriesIds][0]] : null;
    const votes = new Map<number, number>();
    for (const i of g.rows) votes.set(r.cat[i], (votes.get(r.cat[i]) ?? 0) + Math.abs(d.amount[i]));
    const catIdx = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const repr = g.rows.find((i) => r.cat[i] === catIdx) ?? first;
    out.push({
      sigIdx: s, signature: r.signatures[s], samples: [...samples], count: g.rows.length, total: g.total, abs: g.abs,
      firstDay: d.day[first], lastDay: d.day[last], cadence: ser && ser.recurring ? ser.cadence : null, catIdx, conf: r.conf[repr], deal: r.deal[repr],
      direction: g.inn && g.out ? 'mixed' : g.inn ? 'in' : 'out', flags: g.flags, rule: ruleLabel(r.rule[repr]).label,
      rowKeys: g.rows.length <= 50 ? g.rows.map((i) => rowKey(d, i, r.signatures[s])) : undefined,
    });
  }
  return out.sort((a, b) => b.abs - a.abs);
}

function cloneAgg(a: Aggregates): Aggregates {
  return { ...a, op: a.op.slice(), opOneOff: a.opOneOff.slice(), treasury: a.treasury.slice(), internal: a.internal.slice(), rowCounts: a.rowCounts.slice() };
}

export type EngineApi = typeof api;
Comlink.expose(api);
