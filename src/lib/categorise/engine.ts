// Deterministic categorisation pipeline. Every decision records *which rule* made it.
//
//  1. normalise narratives (+ team aliases)          → signature per row
//  2. per-transaction overrides from the team file
//  3. internal transfers (equal & opposite between own accounts)
//  4. team rules, then built-in starter rules
//  5. treasury counterparty dictionary + "another local authority" detector
//  6. recurrence detection (series by signature & cadence)
//  7. heuristic flags: loan pairs, round sums, fixed half-yearly amounts, outliers, singles
//  8. anything left → uncategorised

import type { Category } from '../categories';
import type { Alias, Rule, SeriesOverride, TxnOverride, Classification } from '../model';
import type { Dataset } from '../ingest/ingest';
import { ROW_DATE_SWAPPED, ROW_DUP_CANDIDATE } from '../ingest/ingest';
import { cleanNarrative, signatureOf } from './normalise';
import { STARTER_RULES, TREASURY_COUNTERPARTIES, LA_PATTERN } from './starterRules';
import { ymdFromDay, isBusinessDay, Day } from '../dates';
import { hashString } from '../rng';

export const DEAL_NO = 0, DEAL_YES = 1, DEAL_SUSPECTED = 2;
export const CONF_LOW = 0, CONF_MED = 1, CONF_HIGH = 2;

export const RULE_NONE = -1;
export const RULE_INTERNAL_PAIR = -2;
export const RULE_COUNTERPARTY = -3;
export const RULE_LA_DETECTOR = -4;
export const RULE_LOAN_PAIR = -5;
export const RULE_ROUND = -6;
export const RULE_OVERRIDE = -7;
export const RULE_FIXED_HALFYEARLY = -8;

export const F_LARGE = 1;
export const F_ROUND = 2;
export const F_SINGLE = 4;
export const F_OUTLIER = 8;
export const F_LOAN_PAIR = 16;
export const F_INTEREST_LIKE = 32;
export const F_DUP = 64;
export const F_DATE_SWAPPED = 128;
export const F_COUNCIL = 256;
export const F_DEAL_LIKE_OP = 512;

export const FLAG_LABELS: [number, string][] = [
  [F_LARGE, 'Unusually large'], [F_ROUND, 'Round sum'], [F_SINGLE, 'Single occurrence'], [F_OUTLIER, 'Outlier for its category'],
  [F_LOAN_PAIR, 'Loan-and-repayment pattern'], [F_INTEREST_LIKE, 'Fixed half-yearly amount (interest-like)'], [F_DUP, 'Possible duplicate'],
  [F_DATE_SWAPPED, 'Date read with day/month swapped'], [F_COUNCIL, 'Another local authority'], [F_DEAL_LIKE_OP, 'Looks deal-like but left in operational'],
];

export const SPECIAL_RULE_LABELS: Record<number, string> = {
  [RULE_NONE]: 'No rule matched',
  [RULE_INTERNAL_PAIR]: 'Internal transfer: equal and opposite between your accounts',
  [RULE_COUNTERPARTY]: 'Treasury counterparty dictionary',
  [RULE_LA_DETECTOR]: 'Another local authority + round sum',
  [RULE_LOAN_PAIR]: 'Heuristic: money in and out again (loan pattern)',
  [RULE_ROUND]: 'Heuristic: large round sum with no other match',
  [RULE_OVERRIDE]: 'Your decision on this transaction',
  [RULE_FIXED_HALFYEARLY]: 'Heuristic: identical amount every six months (interest-like)',
};

export type Cadence = 'daily' | 'weekly' | 'fortnightly' | 'semi_monthly' | 'four_weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'irregular';

export const CADENCE_DAYS: Record<Exclude<Cadence, 'irregular'>, [number, number, number]> = {
  daily: [1, 0.5, 4],
  weekly: [7, 5.5, 8.5],
  fortnightly: [14, 12, 16],
  semi_monthly: [15.2, 12, 18],
  four_weekly: [28, 27, 29],
  monthly: [30.4, 24, 38],
  quarterly: [91, 80, 102],
  half_yearly: [182, 170, 195],
  annual: [365, 350, 380],
};

export interface Series {
  id: number;
  signature: string;
  categoryIdx: number;
  direction: 1 | -1;
  cadence: Cadence;
  regularity: number;
  occurrences: number;
  firstDay: Day;
  lastDay: Day;
  typicalAmount: number;
  amountCV: number;
  dayOfMonth: number;
  /** second day of month for twice-monthly series */
  dayOfMonth2?: number;
  lastWorkingDay: boolean;
  trendPct: number;
  active: boolean;
  total: number;
  classification: Classification;
  recurring: boolean;
}

export interface CatConfig {
  categories: Category[];
  rules: Rule[];
  aliases: Alias[];
  seriesOverrides: SeriesOverride[];
  txnOverrides: TxnOverride[];
  useStarterRules: boolean;
}

export interface CatResult {
  catIds: string[];
  signatures: string[];
  sig: Int32Array;
  cat: Int16Array;
  rule: Int32Array;
  conf: Uint8Array;
  deal: Uint8Array;
  series: Int32Array;
  flags: Uint16Array;
  oneOff: Uint8Array;
  /** one-off classification from rules only (before outlier detection / overrides) — used to rebuild for backtests */
  oneOffRule: Uint8Array;
  /** -1 none, 0 forced recurring, 1 forced one-off (series or transaction override) */
  classOverride: Int8Array;
  seriesList: Series[];
  ruleList: Rule[];
  ruleHits: Int32Array;
  ms: Record<string, number>;
}

export function rowKey(ds: Dataset, i: number, signature: string): string {
  return (hashString(`${ds.accounts[ds.account[i]]}|${ds.day[i]}|${Math.round(ds.amount[i] * 100)}|${signature}`) >>> 0).toString(36);
}

function compileRule(r: Rule): (sig: string) => boolean {
  const p = r.pattern;
  switch (r.type) {
    case 'alias': { const u = p.toUpperCase().trim(); return (s) => s === u; }
    case 'contains':
    case 'counterparty': { const u = p.toUpperCase().trim(); return (s) => s.includes(u); }
    case 'regex': {
      try { const re = new RegExp(p, 'i'); return (s) => re.test(s); } catch { return () => false; }
    }
  }
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function categorise(ds: Dataset, cfg: CatConfig, onProgress?: (phase: string, frac: number) => void): CatResult {
  const ms: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (k: string) => { const t = performance.now(); ms[k] = Math.round(t - t0); t0 = t; };
  const n = ds.n;
  const catIds = cfg.categories.map((c) => c.id);
  const catIndex = new Map(catIds.map((c, i) => [c, i]));
  const groupOf = cfg.categories.map((c) => c.group);
  const isTreasuryIdx = (c: number) => c >= 0 && groupOf[c] === 'treasury';
  const internalIdx = catIndex.get('internal_transfer') ?? -1;
  const ci = (id: string) => catIndex.get(id) ?? -1;

  // ---------- 1. Signatures ----------
  onProgress?.('Normalising narratives', 0.05);
  const aliasPairs: [RegExp, string][] = [];
  for (const a of cfg.aliases) for (const v of a.variants) {
    const vv = cleanNarrative(v);
    if (vv) aliasPairs.push([new RegExp(`\\b${vv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), cleanNarrative(a.canonical)]);
  }
  const narrSig = new Int32Array(ds.narratives.length);
  const signatures: string[] = [];
  const sigIndex = new Map<string, number>();
  for (let k = 0; k < ds.narratives.length; k++) {
    let c = cleanNarrative(ds.narratives[k]);
    for (const [re, canon] of aliasPairs) c = c.replace(re, canon);
    const s = signatureOf(c);
    let si = sigIndex.get(s);
    if (si === undefined) { si = signatures.length; signatures.push(s); sigIndex.set(s, si); }
    narrSig[k] = si;
  }
  const sig = new Int32Array(n);
  for (let i = 0; i < n; i++) sig[i] = narrSig[ds.narr[i]];
  lap('normalise');

  const cat = new Int16Array(n).fill(-1);
  const rule = new Int32Array(n).fill(RULE_NONE);
  const conf = new Uint8Array(n);
  const deal = new Uint8Array(n);
  const flags = new Uint16Array(n);
  const oneOff = new Uint8Array(n);
  const done = new Uint8Array(n); // 1 = decided by override/internal, skip later steps
  for (let i = 0; i < n; i++) {
    if (ds.rowFlags[i] & ROW_DUP_CANDIDATE) flags[i] |= F_DUP;
    if (ds.rowFlags[i] & ROW_DATE_SWAPPED) flags[i] |= F_DATE_SWAPPED;
  }

  // ---------- 2. Transaction overrides ----------
  const overrideMap = new Map(cfg.txnOverrides.map((o) => [o.key, o]));
  const overrideClass = new Map<number, Classification>();
  if (overrideMap.size) {
    for (let i = 0; i < n; i++) {
      const o = overrideMap.get(rowKey(ds, i, signatures[sig[i]]));
      if (!o) continue;
      if (o.classification) overrideClass.set(i, o.classification);
      if (o.categoryId && catIndex.has(o.categoryId)) {
        const c = catIndex.get(o.categoryId)!;
        cat[i] = c; rule[i] = RULE_OVERRIDE; conf[i] = CONF_HIGH;
        deal[i] = o.dealFlag === 'deal' ? DEAL_YES : o.dealFlag === 'suspected' ? DEAL_SUSPECTED : o.dealFlag === 'not_deal' ? DEAL_NO : isTreasuryIdx(c) ? DEAL_YES : DEAL_NO;
        done[i] = 1;
      } else if (o.dealFlag) {
        // deal decision without category: handled after rules
      }
    }
  }
  lap('overrides');

  // ---------- 3. Internal transfers ----------
  onProgress?.('Matching internal transfers', 0.15);
  if (ds.accounts.length > 1 && internalIdx >= 0) {
    const internalRe = /\bSWEEP\b|\bTFR\b|TRANSFER|FUNDING|\bINTERNAL\b|OWN A ?C|INTER ?ACC/;
    const acctNums = ds.accounts.filter((a) => /^\d{6,10}$/.test(a));
    const negByPence = new Map<number, number[]>();
    for (let i = 0; i < n; i++) if (ds.amount[i] < 0 && !done[i]) {
      const p = Math.round(-ds.amount[i] * 100);
      let a = negByPence.get(p);
      if (!a) negByPence.set(p, (a = []));
      a.push(i);
    }
    const paired = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (ds.amount[i] <= 0 || done[i]) continue;
      const cands = negByPence.get(Math.round(ds.amount[i] * 100));
      if (!cands) continue;
      const matches: number[] = [];
      for (const j of cands) {
        if (paired[j] || ds.account[j] === ds.account[i]) continue;
        const dd = ds.day[j] - ds.day[i];
        if (dd < -3 || dd > 3) continue;
        matches.push(j);
      }
      if (!matches.length) continue;
      const si = signatures[sig[i]];
      const hint = (k: number) => {
        const s = signatures[sig[k]];
        const raw = ds.narratives[ds.narr[k]];
        return internalRe.test(s) || acctNums.some((a) => a !== ds.accounts[ds.account[k]] && raw.includes(a));
      };
      let pick = -1;
      for (const j of matches) if (hint(i) || hint(j)) { pick = j; break; }
      if (pick < 0 && matches.length === 1 && ds.amount[i] >= 1000 && !/PWLB|DMADF|LOAN|MMF|FUND/.test(si)) pick = matches[0];
      if (pick < 0) continue;
      for (const k of [i, pick]) {
        paired[k] = 1; done[k] = 1;
        cat[k] = internalIdx; rule[k] = RULE_INTERNAL_PAIR; conf[k] = CONF_HIGH; deal[k] = DEAL_NO;
      }
    }
  }
  lap('internal');

  // ---------- 4. Rules ----------
  onProgress?.('Applying rules', 0.3);
  const ruleList: Rule[] = [...cfg.rules.map((r) => ({ ...r })), ...(cfg.useStarterRules ? STARTER_RULES : [])].filter((r) => catIndex.has(r.categoryId));
  const compiled = ruleList.map(compileRule);
  const ruleCat = ruleList.map((r) => catIndex.get(r.categoryId)!);
  const unconditional = ruleList.map((r) => (!r.direction || r.direction === 'any') && r.minAmount == null && r.maxAmount == null);
  // candidate rules per signature (lazily)
  const sigCands: (Int32Array | null)[] = new Array(signatures.length).fill(null);
  const candsFor = (s: number): Int32Array => {
    let c = sigCands[s];
    if (c) return c;
    const text = signatures[s];
    const out: number[] = [];
    for (let r = 0; r < compiled.length; r++) {
      if (compiled[r](text)) { out.push(r); if (unconditional[r]) break; }
    }
    c = Int32Array.from(out);
    sigCands[s] = c;
    return c;
  };
  const ruleHits = new Int32Array(ruleList.length);
  const confOf = (r: Rule) => (r.confidence === 'low' ? CONF_LOW : r.confidence === 'medium' ? CONF_MED : CONF_HIGH);
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    const cands = candsFor(sig[i]);
    const a = ds.amount[i];
    for (let k = 0; k < cands.length; k++) {
      const r = ruleList[cands[k]];
      if (r.direction === 'in' && a < 0) continue;
      if (r.direction === 'out' && a >= 0) continue;
      if (r.minAmount != null && Math.abs(a) < r.minAmount) continue;
      if (r.maxAmount != null && Math.abs(a) > r.maxAmount) continue;
      const c = ruleCat[cands[k]];
      cat[i] = c; rule[i] = cands[k]; conf[i] = confOf(r);
      deal[i] = r.dealFlag === 'deal' ? DEAL_YES : r.dealFlag === 'suspected' ? DEAL_SUSPECTED : isTreasuryIdx(c) ? DEAL_YES : DEAL_NO;
      if (r.classification === 'one_off') oneOff[i] = 1;
      ruleHits[cands[k]]++;
      break;
    }
  }
  lap('rules');

  // ---------- 5. Counterparty dictionary & local authority detector ----------
  onProgress?.('Checking treasury counterparties', 0.45);
  const sigCp = new Int16Array(signatures.length).fill(-2); // -2 unknown, -1 none, else index
  const sigLA = new Int8Array(signatures.length).fill(-1);
  const isRoundBig = (a: number) => Math.abs(a) >= 1e6 && Math.round(Math.abs(a) * 100) % 25_000_000 === 0;
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    const s = sig[i];
    if (sigLA[s] < 0) sigLA[s] = LA_PATTERN.test(signatures[s]) ? 1 : 0;
    if (sigLA[s]) flags[i] |= F_COUNCIL;
    if (cat[i] >= 0) continue;
    if (sigCp[s] === -2) {
      const hit = TREASURY_COUNTERPARTIES.findIndex((c) => c.pattern.test(signatures[s]));
      sigCp[s] = hit;
    }
    if (sigCp[s] >= 0) {
      const c = ci(TREASURY_COUNTERPARTIES[sigCp[s]].categoryId);
      cat[i] = c; rule[i] = RULE_COUNTERPARTY; conf[i] = CONF_MED; deal[i] = DEAL_YES;
      continue;
    }
    if (sigLA[s]) {
      const a = ds.amount[i];
      if (isRoundBig(a)) {
        cat[i] = ci('la_loans'); rule[i] = RULE_LA_DETECTOR; conf[i] = CONF_LOW; deal[i] = DEAL_SUSPECTED;
        flags[i] |= F_ROUND;
      } else {
        // a council counterparty paying or receiving an odd amount: most likely a recharge
        cat[i] = ci(a < 0 ? 'other_payments' : 'other_receipts'); rule[i] = RULE_LA_DETECTOR; conf[i] = CONF_LOW; deal[i] = DEAL_NO;
      }
    }
  }
  lap('counterparty');

  // ---------- 6. Recurrence detection ----------
  onProgress?.('Detecting recurring series', 0.6);
  const seriesList: Series[] = [];
  const series = new Int32Array(n).fill(-1);
  {
    const sigCount = new Int32Array(signatures.length);
    for (let i = 0; i < n; i++) sigCount[sig[i]]++;
    for (let i = 0; i < n; i++) if (sigCount[sig[i]] === 1 && Math.abs(ds.amount[i]) >= 250_000) flags[i] |= F_SINGLE;
    const det = detectSeries(ds, { sig, signatures, cat, internalIdx }, ds.maxDay, new Map(cfg.seriesOverrides.map((o) => [o.signature, o.classification])));
    seriesList.push(...det.seriesList);
    series.set(det.series);

    // Fixed amounts recurring half-yearly/annually with no category: interest-like
    const exact = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (cat[i] >= 0 || Math.abs(ds.amount[i]) < 10_000) continue;
      const k = `${sig[i]}|${Math.round(ds.amount[i] * 100)}`;
      let a = exact.get(k);
      if (!a) exact.set(k, (a = []));
      a.push(i);
    }
    for (const rows of exact.values()) {
      if (rows.length < 2) continue;
      let ok = 0;
      for (let k = 1; k < rows.length; k++) {
        const d = ds.day[rows[k]] - ds.day[rows[k - 1]];
        if ((d >= 170 && d <= 195) || (d >= 350 && d <= 380)) ok++;
      }
      if (ok >= Math.max(1, (rows.length - 1) * 0.6)) {
        for (const i of rows) {
          flags[i] |= F_INTEREST_LIKE;
          cat[i] = ci(ds.amount[i] < 0 ? 'pwlb' : 'treasury_interest'); rule[i] = RULE_FIXED_HALFYEARLY; conf[i] = CONF_LOW; deal[i] = DEAL_SUSPECTED;
        }
      }
    }
  }
  lap('recurrence');

  // ---------- 7. Heuristics: loan pairs, round sums ----------
  onProgress?.('Looking for loan patterns', 0.75);
  {
    const big: number[] = [];
    for (let i = 0; i < n; i++) {
      if (done[i] && rule[i] !== RULE_OVERRIDE) continue;
      if (Math.abs(ds.amount[i]) < 1e6) continue;
      if (cat[i] === internalIdx) continue;
      big.push(i);
    }
    const eligible = (i: number) => cat[i] < 0 || deal[i] === DEAL_SUSPECTED || (flags[i] & F_COUNCIL) || conf[i] === CONF_LOW || isTreasuryIdx(cat[i]);
    const byAcct = new Map<number, number[]>();
    for (const i of big) { let a = byAcct.get(ds.account[i]); if (!a) byAcct.set(ds.account[i], (a = [])); a.push(i); }
    const used = new Uint8Array(n);
    for (const rows of byAcct.values()) {
      for (let x = 0; x < rows.length; x++) {
        const i = rows[x];
        if (used[i] || !eligible(i)) continue;
        const a = ds.amount[i];
        for (let y = x + 1; y < rows.length; y++) {
          const j = rows[y];
          const dd = ds.day[j] - ds.day[i];
          if (dd > 400) break;
          if (dd < 7 || used[j]) continue;
          const b = ds.amount[j];
          if (Math.sign(a) === Math.sign(b)) continue;
          const ratio = Math.abs(b) / Math.abs(a);
          if (ratio < 1 || ratio > 1.08) continue;
          if (!eligible(j) && sig[i] !== sig[j]) continue;
          used[i] = used[j] = 1;
          for (const k of [i, j]) {
            flags[k] |= F_LOAN_PAIR;
            if (cat[k] < 0 || (!isTreasuryIdx(cat[k]) && conf[k] <= CONF_MED && rule[k] !== RULE_OVERRIDE)) {
              cat[k] = ci(a > 0 ? 'la_loans' : 'bank_deposits'); rule[k] = RULE_LOAN_PAIR; conf[k] = CONF_LOW; deal[k] = DEAL_SUSPECTED;
            }
          }
          break;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (cat[i] >= 0 || !isRoundBig(ds.amount[i])) continue;
      flags[i] |= F_ROUND;
      cat[i] = ci(ds.amount[i] > 0 ? 'la_loans' : 'bank_deposits'); rule[i] = RULE_ROUND; conf[i] = CONF_LOW; deal[i] = DEAL_SUSPECTED;
    }
  }
  lap('heuristics');

  // Deal decisions the user made without changing the category
  if (overrideMap.size) {
    for (let i = 0; i < n; i++) {
      if (rule[i] === RULE_OVERRIDE) continue;
      const o = overrideMap.get(rowKey(ds, i, signatures[sig[i]]));
      if (o?.dealFlag) deal[i] = o.dealFlag === 'deal' ? DEAL_YES : o.dealFlag === 'suspected' ? DEAL_SUSPECTED : DEAL_NO;
    }
  }

  // ---------- Outliers within operational categories ----------
  onProgress?.('Checking for outliers', 0.85);
  const oneOffRule = oneOff.slice();
  {
    const o = detectOutliers(ds, { cat, deal, internalIdx, nCats: catIds.length, series }, ds.maxDay);
    for (let i = 0; i < n; i++) {
      if (o.large[i]) flags[i] |= F_LARGE;
      if (o.outlier[i]) { flags[i] |= F_OUTLIER; oneOff[i] = 1; }
    }
  }

  // ---------- Classification overrides (series, then individual transactions) ----------
  const classOverride = new Int8Array(n).fill(-1);
  if (cfg.seriesOverrides.length) {
    const bySig = new Map(cfg.seriesOverrides.map((o) => [o.signature, o.classification]));
    for (let i = 0; i < n; i++) {
      const c = bySig.get(signatures[sig[i]]);
      if (c) classOverride[i] = c === 'one_off' ? 1 : 0;
    }
  }
  for (const [i, c] of overrideClass) classOverride[i] = c === 'one_off' ? 1 : 0;
  for (let i = 0; i < n; i++) if (classOverride[i] >= 0) oneOff[i] = classOverride[i];

  // ---------- Deal-like rows left in the operational model ----------
  const userDecidedDeal = new Uint8Array(n);
  if (overrideMap.size) for (let i = 0; i < n; i++) { const o = overrideMap.get(rowKey(ds, i, signatures[sig[i]])); if (o && (o.dealFlag || o.categoryId)) userDecidedDeal[i] = 1; }
  for (let i = 0; i < n; i++) {
    if (deal[i] !== DEAL_NO || cat[i] === internalIdx || userDecidedDeal[i]) continue;
    if (rule[i] >= 0 && conf[i] === CONF_HIGH) continue; // confidently sorted by a specific rule
    if (rule[i] >= 0 && ruleList[rule[i]].source !== 'starter' && ruleList[rule[i]].dealFlag === 'not_deal') continue;
    const f = flags[i];
    if ((f & (F_LOAN_PAIR | F_INTEREST_LIKE)) || ((f & F_ROUND) && Math.abs(ds.amount[i]) >= 1e6) || ((f & F_COUNCIL) && Math.abs(ds.amount[i]) >= 1e6)) flags[i] |= F_DEAL_LIKE_OP;
  }
  lap('flags');
  onProgress?.('Done', 1);

  return { catIds, signatures, sig, cat, rule, conf, deal, series, flags, oneOff, oneOffRule, classOverride, seriesList, ruleList, ruleHits, ms };
}

/**
 * Recurrence detection: rows grouped by signature × direction, tested for a regular cadence.
 * Only rows on or before `maxDay` are used (so backtests never see the future).
 */
export function detectSeries(
  ds: Dataset,
  r: { sig: Int32Array; signatures: string[]; cat: Int16Array; internalIdx: number },
  maxDay: Day,
  overrideBySig: Map<string, Classification> = new Map(),
): { seriesList: Series[]; series: Int32Array } {
  const { sig, signatures, cat, internalIdx } = r;
  const n = ds.n;
  const seriesList: Series[] = [];
  const series = new Int32Array(n).fill(-1);
  {
    // group rows by signature × direction
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (ds.day[i] > maxDay) break;
      if (cat[i] === internalIdx && internalIdx >= 0) continue;
      const key = sig[i] * 2 + (ds.amount[i] < 0 ? 1 : 0);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    for (const [key, rows] of groups) {
      if (rows.length < 3) continue;
      // per-day totals
      const dayTot = new Map<number, number>();
      for (const i of rows) dayTot.set(ds.day[i], (dayTot.get(ds.day[i]) ?? 0) + ds.amount[i]);
      const days = [...dayTot.keys()].sort((a, b) => a - b);
      if (days.length < 3) continue;
      const iv: number[] = [];
      for (let k = 1; k < days.length; k++) iv.push(days[k] - days[k - 1]);
      const med = median(iv);
      // candidate cadences whose band contains the median interval; best regularity wins,
      // ties go to the narrower band (a strict 28-day cycle is four-weekly, not monthly)
      let cadence: Cadence = 'irregular';
      let regularity = 0, bestWidth = Infinity;
      for (const [cd, [, lo, hi]] of Object.entries(CADENCE_DAYS) as [Exclude<Cadence, 'irregular'>, [number, number, number]][]) {
        if (med < lo || med > hi) continue;
        const reg = iv.filter((x) => x >= lo && x <= hi).length / iv.length;
        if (reg > regularity + 1e-9 || (Math.abs(reg - regularity) < 1e-9 && hi - lo < bestWidth)) { cadence = cd; regularity = reg; bestWidth = hi - lo; }
      }
      // twice a month on set dates (1st & 15th) vs. a strict 14-day cycle
      if (cadence === 'fortnightly' || cadence === 'semi_monthly') {
        const exact14 = iv.filter((x) => x === 14).length / iv.length;
        cadence = exact14 >= 0.6 ? 'fortnightly' : 'semi_monthly';
        const [, lo, hi] = CADENCE_DAYS[cadence];
        regularity = iv.filter((x) => x >= lo && x <= hi).length / iv.length;
      }
      const amounts = days.map((d) => Math.abs(dayTot.get(d)!));
      const medAmt = median(amounts);
      const mad = median(amounts.map((x) => Math.abs(x - medAmt)));
      const cv = medAmt ? (1.4826 * mad) / medAmt : 0;
      // modal day of month & last-working-day pattern
      const domCount = new Map<number, number>();
      let lwd = 0;
      for (const d of days) {
        const { y, m, d: dd } = ymdFromDay(d);
        domCount.set(dd, (domCount.get(dd) ?? 0) + 1);
        // last business day of month?
        let k = d + 1;
        while (!isBusinessDay(k) && ymdFromDay(k).m === m) k++;
        if (ymdFromDay(k).m !== m || (ymdFromDay(k).y !== y)) lwd++;
      }
      const dom = [...domCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const modeIn = (f: (d: number) => boolean) => [...domCount.entries()].filter(([d]) => f(d)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
      const dom1 = modeIn((d) => d <= 14), dom2 = modeIn((d) => d >= 15);
      // trend: log-linear regression of amounts on years
      let trend = 0;
      if (days.length >= 6 && amounts.every((x) => x > 0)) {
        const xs = days.map((d) => (d - days[0]) / 365.25);
        const ys = amounts.map((x) => Math.log(x));
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
        let sxy = 0, sxx = 0;
        for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
        if (sxx > 0.05) trend = Math.exp(sxy / sxx) - 1;
      }
      const recurring = cadence !== 'irregular' && regularity >= 0.6;
      if (!recurring && cadence !== 'daily') continue;
      const s = key >> 1;
      const catVotes = new Map<number, number>();
      for (const i of rows) catVotes.set(cat[i], (catVotes.get(cat[i]) ?? 0) + 1);
      const catMajor = [...catVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const spanEnd = maxDay;
      const period = cadence === 'irregular' ? 30 : CADENCE_DAYS[cadence][0];
      const total = rows.reduce((t, i) => t + ds.amount[i], 0);
      const ser: Series = {
        id: seriesList.length, signature: signatures[s], categoryIdx: catMajor, direction: key & 1 ? -1 : 1,
        cadence, regularity, occurrences: days.length, firstDay: days[0], lastDay: days[days.length - 1],
        typicalAmount: medAmt * (key & 1 ? -1 : 1), amountCV: cv, dayOfMonth: cadence === 'semi_monthly' ? dom1 : dom, dayOfMonth2: cadence === 'semi_monthly' ? dom2 : undefined, lastWorkingDay: lwd / days.length > 0.7 && cadence === 'monthly',
        trendPct: trend, active: spanEnd - days[days.length - 1] <= period * 1.6 + 7, total,
        classification: overrideBySig.get(signatures[s]) ?? 'recurring', recurring: recurring || cadence === 'daily',
      };
      seriesList.push(ser);
      for (const i of rows) series[i] = ser.id;
    }

  }
  return { seriesList, series };
}

/**
 * Robust outlier test. Rows inside a regular recurring series are compared with that series'
 * typical amount; everything else with its category (log-amount z-score + share of a typical month).
 */
export function detectOutliers(
  ds: Dataset,
  r: { cat: Int16Array; deal: Uint8Array; internalIdx: number; nCats: number; series?: Int32Array },
  maxDay: Day,
): { outlier: Uint8Array; large: Uint8Array } {
  const { cat, deal, internalIdx, series } = r;
  const n = ds.n;
  const C = r.nCats;
  const outlier = new Uint8Array(n);
  const large = new Uint8Array(n);
  const logs: number[][] = Array.from({ length: C }, () => []);
  const monthTot: Map<number, number>[] = Array.from({ length: C }, () => new Map());
  const seriesAmts = new Map<number, number[]>();
  let last = n;
  for (let i = 0; i < n; i++) {
    if (ds.day[i] > maxDay) { last = i; break; }
    const c = cat[i];
    if (c < 0 || deal[i] !== DEAL_NO || c === internalIdx) continue;
    const a = Math.abs(ds.amount[i]);
    const sid = series ? series[i] : -1;
    if (sid >= 0) {
      let arr = seriesAmts.get(sid);
      if (!arr) seriesAmts.set(sid, (arr = []));
      arr.push(a);
      continue;
    }
    if (a > 0) logs[c].push(Math.log10(a));
    const mi = Math.floor(ds.day[i] / 30.44);
    monthTot[c].set(mi, (monthTot[c].get(mi) ?? 0) + a);
  }
  const seriesThr = new Map<number, number>();
  for (const [sid, arr] of seriesAmts) {
    const med = median(arr);
    const mad = median(arr.map((x) => Math.abs(x - med)));
    seriesThr.set(sid, Math.max(3 * med, med + 8 * 1.4826 * mad));
  }
  const thr: { med: number; s: number; monthMed: number }[] = [];
  for (let c = 0; c < C; c++) {
    const med = median(logs[c]);
    const mad = median(logs[c].map((x) => Math.abs(x - med)));
    thr.push({ med, s: Math.max(1.4826 * mad, 0.12), monthMed: median([...monthTot[c].values()]) });
  }
  let allAbs: number[] = [];
  for (let i = 0; i < last; i += Math.max(1, Math.floor(last / 50000))) allAbs.push(Math.abs(ds.amount[i]));
  allAbs = allAbs.sort((a, b) => a - b);
  const p999 = allAbs[Math.floor(allAbs.length * 0.999)] ?? 1e6;
  const largeThr = Math.max(1e6, p999);
  for (let i = 0; i < last; i++) {
    const a = Math.abs(ds.amount[i]);
    if (a >= largeThr) large[i] = 1;
    const c = cat[i];
    if (c < 0 || deal[i] !== DEAL_NO || c === internalIdx || a < 250_000) continue;
    const sid = series ? series[i] : -1;
    if (sid >= 0) {
      if (a > (seriesThr.get(sid) ?? Infinity)) outlier[i] = 1;
      continue;
    }
    const t = thr[c];
    const z = (Math.log10(a) - t.med) / t.s;
    if ((z > 4 && a > 0.15 * t.monthMed) || (t.monthMed > 0 && a > 0.6 * t.monthMed && z > 2.5)) outlier[i] = 1;
  }
  return { outlier, large };
}
