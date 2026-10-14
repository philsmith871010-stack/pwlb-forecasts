import type { SignedForecast, SignOffChange } from './forecast/signoff';
import type { ExceptionReview } from './governance/exceptions';
import { mergeHistory, type CashHistory } from './history/cashHistory';
// The shared team JSON file: everything the team needs except transaction data.
import { DEFAULT_CATEGORIES } from './categories';
import type { TeamFile, Rule, Scenario, BankProfile, Alias, SeriesOverride, TxnOverride } from './model';
import { hashString } from './rng';

export function emptyTeamFile(authorityName = 'My Council'): TeamFile {
  return {
    kind: 'cash-flow-insight-team-file',
    schemaVersion: 1,
    authorityName,
    savedAt: '',
    savedBy: '',
    settings: { financialYearStart: '04-01', currency: 'GBP', liquidityBuffer: 10_000_000, includeHistorySummary: true },
    bankProfiles: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    rules: [],
    aliases: [],
    seriesOverrides: [],
    txnOverrides: [],
    forecasts: [],
    changeLog: [],
  };
}

export interface ValidationResult { ok: boolean; team?: TeamFile; errors: string[]; warnings: string[] }

/** Parse, validate and (if needed) migrate a team file. Never trusts the input shape. */
export function parseTeamFile(text: string): ValidationResult {
  const errors: string[] = [], warnings: string[] = [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings }; }
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['File is empty or not an object.'], warnings };
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'cash-flow-insight-team-file') warnings.push('File does not declare itself as a PWLBforecast team file; loading what we can.');
  if (o.schemaVersion !== undefined && o.schemaVersion !== 1) warnings.push(`Schema version ${String(o.schemaVersion)} is newer than this app understands (1). Unknown fields are ignored.`);
  const base = emptyTeamFile();
  const arr = <T>(k: string): T[] => (Array.isArray(o[k]) ? (o[k] as T[]) : []);
  const team: TeamFile = {
    ...base,
    authorityName: typeof o.authorityName === 'string' ? o.authorityName : base.authorityName,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    savedBy: typeof o.savedBy === 'string' ? o.savedBy : '',
    settings: { ...base.settings, ...(typeof o.settings === 'object' && o.settings ? (o.settings as object) : {}) },
    bankProfiles: arr<BankProfile>('bankProfiles').filter((p) => p && p.id && p.mapping),
    categories: arr<TeamFile['categories'][number]>('categories').filter((c) => c && c.id && c.name),
    rules: arr<Rule>('rules').filter((r) => r && r.id && r.pattern && r.categoryId),
    aliases: arr<Alias>('aliases').filter((a) => a && a.canonical && Array.isArray(a.variants)),
    seriesOverrides: arr<SeriesOverride>('seriesOverrides'),
    txnOverrides: arr<TxnOverride>('txnOverrides'),
    historySummary: (o.historySummary as TeamFile['historySummary']) ?? undefined,
    cashHistory: validHistory(o.cashHistory) ? (o.cashHistory as CashHistory) : undefined,
    forecasts: arr<Scenario>('forecasts').filter((f) => f && f.id && f.settings),
    signedOff: arr<SignedForecast>('signedOff').filter((x) => x && x.v === 1 && x.id && x.everyday && Array.isArray(x.everyday.cum)),
    exceptionReviews: arr<ExceptionReview>('exceptionReviews').filter((r) => r && typeof r.key === 'string' && (r.status === 'checked' || r.status === 'query') && typeof r.at === 'string'),
    signOffChanges: arr<SignOffChange>('signOffChanges').filter((c) => c && typeof c.id === 'string' && (c.action === 'withdraw' || c.action === 'restore') && typeof c.at === 'string'),
    changeLog: arr<TeamFile['changeLog'][number]>('changeLog'),
  };
  if (!team.categories.length) { team.categories = base.categories; warnings.push('No categories found — default categories added.'); }
  // categories referenced by rules must exist
  const ids = new Set(team.categories.map((c) => c.id));
  const orphan = team.rules.filter((r) => !ids.has(r.categoryId));
  if (orphan.length) warnings.push(`${orphan.length} rule(s) point at categories that no longer exist; they will be ignored.`);
  for (const r of team.rules) r.source = 'team';
  return { ok: errors.length === 0, team, errors, warnings };
}

export function serialiseTeamFile(team: TeamFile, savedBy: string, summary: string): { json: string; team: TeamFile } {
  const now = new Date().toISOString();
  const out: TeamFile = {
    ...team,
    savedAt: now,
    savedBy,
    rules: team.rules.map(({ source: _s, ...r }) => r as Rule),
    historySummary: team.settings.includeHistorySummary ? team.historySummary : undefined,
    cashHistory: team.settings.keepCashHistory === false ? undefined : team.cashHistory,
    changeLog: [...team.changeLog, { at: now, by: savedBy, summary }].slice(-200),
  };
  // readable, except the cash history's long number lists, which stay on single lines
  const { cashHistory, ...rest } = out;
  let json = JSON.stringify(cashHistory ? { ...rest, cashHistory: '__CASH_HISTORY__' } : rest, null, 2);
  if (cashHistory) json = json.replace('"__CASH_HISTORY__"', JSON.stringify(cashHistory));
  return { json, team: out };
}

export function teamHash(text: string): string {
  return hashString(text).toString(36);
}

// ---------------------------------------------------------------- merging

export interface MergeConflict {
  kind: 'rule' | 'forecast' | 'bankProfile' | 'category';
  id: string;
  label: string;
  mine: unknown;
  theirs: unknown;
}

export interface MergeResult { merged: TeamFile; conflicts: MergeConflict[]; summary: string[] }

/**
 * Three-way-ish merge: union by id. When both sides hold the same id with different content,
 * that is a conflict for the user to resolve (default: keep mine).
 */
export function mergeTeamFiles(mine: TeamFile, theirs: TeamFile): MergeResult {
  const conflicts: MergeConflict[] = [];
  const summary: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  function unionBy<T extends { id: string }>(kind: MergeConflict['kind'], a: T[], b: T[], label: (x: T) => string): T[] {
    const map = new Map<string, T>();
    for (const x of a) map.set(x.id, x);
    let added = 0;
    for (const y of b) {
      const x = map.get(y.id);
      if (!x) { map.set(y.id, y); added++; }
      else if (!same(x, y)) conflicts.push({ kind, id: y.id, label: label(y), mine: x, theirs: y });
    }
    if (added) summary.push(`${added} ${kind}${added > 1 ? 's' : ''} added from the file on disk`);
    return [...map.values()];
  }
  const merged: TeamFile = {
    ...mine,
    categories: unionBy('category', mine.categories, theirs.categories, (c) => c.name),
    rules: unionBy('rule', mine.rules, theirs.rules, (r) => `${r.type} “${r.pattern}” → ${r.categoryId}`),
    bankProfiles: unionBy('bankProfile', mine.bankProfiles, theirs.bankProfiles, (p) => p.name),
    forecasts: unionBy('forecast', mine.forecasts, theirs.forecasts, (f) => f.name),
    // sign-offs never change once made: everyone's are kept
    signedOff: unionByKey(mine.signedOff ?? [], theirs.signedOff ?? [], (x) => x.id).sort((a, b) => a.signedAt.localeCompare(b.signedAt)),
    // withdrawals and restores likewise: the latest for each sign-off decides
    signOffChanges: unionByKey(mine.signOffChanges ?? [], theirs.signOffChanges ?? [], (c) => `${c.id}|${c.at}|${c.action}`).sort((a, b) => a.at.localeCompare(b.at)),
    // reviews of exceptions likewise: everyone's kept, the latest for each counts
    exceptionReviews: unionByKey(mine.exceptionReviews ?? [], theirs.exceptionReviews ?? [], (r) => `${r.key}|${r.at}|${r.status}`).sort((a, b) => a.at.localeCompare(b.at)),
    aliases: unionAliases(mine.aliases, theirs.aliases),
    seriesOverrides: unionByKey(mine.seriesOverrides, theirs.seriesOverrides, (s) => s.signature),
    txnOverrides: unionByKey(mine.txnOverrides, theirs.txnOverrides, (t) => t.key),
    changeLog: unionByKey([...theirs.changeLog, ...mine.changeLog], [], (c) => `${c.at}|${c.by}|${c.summary}`).sort((a, b) => a.at.localeCompare(b.at)),
    // both histories kept; where they cover the same days of an account, ours (the newer load) wins
    cashHistory: mine.cashHistory && theirs.cashHistory ? mergeHistory(theirs.cashHistory, mine.cashHistory).history : mine.cashHistory ?? theirs.cashHistory,
  };
  if (mine.cashHistory && theirs.cashHistory && JSON.stringify(mine.cashHistory) !== JSON.stringify(theirs.cashHistory)) summary.push('cash history combined with the file on disk');
  return { merged, conflicts, summary };
}

function validHistory(h: unknown): boolean {
  const x = h as CashHistory | undefined;
  return !!x && x.v === 1 && Array.isArray(x.accounts) && Array.isArray(x.cells) && Array.isArray(x.cats) && Array.isArray(x.series) && x.cells.length === x.accounts.length;
}

function strip(x: unknown): unknown {
  if (!x || typeof x !== 'object') return x;
  const { hits: _h, source: _s, resultsSnapshot: _r, ...rest } = x as Record<string, unknown>;
  return rest;
}

function unionByKey<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of a) m.set(key(x), x);
  for (const y of b) if (!m.has(key(y))) m.set(key(y), y);
  return [...m.values()];
}

function unionAliases(a: Alias[], b: Alias[]): Alias[] {
  const m = new Map<string, Set<string>>();
  for (const x of [...a, ...b]) {
    const s = m.get(x.canonical) ?? new Set<string>();
    for (const v of x.variants) s.add(v);
    m.set(x.canonical, s);
  }
  return [...m.entries()].map(([canonical, v]) => ({ canonical, variants: [...v] }));
}

// ---------------------------------------------------------------- file access

type FSHandle = FileSystemFileHandle;
interface FSWindow {
  showOpenFilePicker?: (o?: unknown) => Promise<FSHandle[]>;
  showSaveFilePicker?: (o?: unknown) => Promise<FSHandle>;
}

export const fsAccessSupported = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window;

const PICKER_TYPES = [{ description: 'PWLBforecast team file', accept: { 'application/json': ['.json'] } }];

export async function openWithPicker(): Promise<{ handle: FSHandle; text: string; name: string } | null> {
  const w = window as unknown as FSWindow;
  if (!w.showOpenFilePicker) return null;
  const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
  const file = await handle.getFile();
  return { handle, text: await file.text(), name: file.name };
}

export async function readHandle(handle: FSHandle): Promise<string> {
  return (await handle.getFile()).text();
}

export async function writeHandle(handle: FSHandle, text: string): Promise<void> {
  const h = handle as FSHandle & { requestPermission?: (o: unknown) => Promise<string>; createWritable: () => Promise<FileSystemWritableFileStream> };
  if (h.requestPermission) {
    const p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error('Permission to write the team file was not granted.');
  }
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}

export async function saveAsWithPicker(suggestedName: string, text: string): Promise<FSHandle | null> {
  const w = window as unknown as FSWindow;
  if (!w.showSaveFilePicker) return null;
  const handle = await w.showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
  await writeHandle(handle, text);
  return handle;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, name: string, type = 'application/json') {
  downloadBlob(new Blob([text], { type }), name);
}
