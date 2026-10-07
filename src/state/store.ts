import { create } from 'zustand';
import type { DetectionReport, ColumnMapping } from '../lib/ingest/detect';
import { headerSignature } from '../lib/ingest/detect';
import type { TeamFile, Rule, Scenario, TxnOverride, SeriesOverride, ForecastSettings, Alias } from '../lib/model';
import { uid } from '../lib/model';
import { emptyTeamFile, parseTeamFile, serialiseTeamFile, teamHash, fsAccessSupported, readHandle, writeHandle, saveAsWithPicker, downloadText, mergeTeamFiles, MergeConflict } from '../lib/teamfile';
import type { IngestSummary, CatSummary, RegisterInfo } from '../worker/types';
import { mergeHistory, basisFromHistory, type CashHistory, type MergeReport } from '../lib/history/cashHistory';
import type { Aggregates, ForecastBasis } from '../lib/analysis/aggregates';
import { engine, proxy } from '../worker/client';
import type { GeneratorOptions } from '../generator';
import { isoFromDay, addMonths } from '../lib/dates';
import { TEAM_FILE_DEFAULT_NAME } from '../config';

export type StepId = 'load' | 'map' | 'categorise' | 'review' | 'history' | 'forecast' | 'backtest' | 'save' | 'data' | 'settings' | 'home';
/** Full step list (advanced tools on). */
export const STEPS: { id: StepId; label: string; sub: string; icon: string }[] = [
  { id: 'load', label: 'Add your data', sub: 'Bank statement files', icon: 'bi-cloud-arrow-up' },
  { id: 'map', label: 'Check the files', sub: 'How each column is read', icon: 'bi-layout-three-columns' },
  { id: 'categorise', label: 'Sorting results', sub: 'How lines were sorted', icon: 'bi-tags' },
  { id: 'review', label: 'Check the sorting', sub: 'Confirm a few items', icon: 'bi-ui-checks' },
  { id: 'history', label: 'Look back', sub: 'Your cash so far', icon: 'bi-bar-chart-line' },
  { id: 'forecast', label: 'Look ahead', sub: 'Build your forecast', icon: 'bi-graph-up-arrow' },
  { id: 'backtest', label: 'Test the forecast', sub: 'Against past years', icon: 'bi-bullseye' },
  { id: 'save', label: 'Save & share', sub: 'Report, Excel, team file', icon: 'bi-box-arrow-down' },
];

/** The beginner's path. */
export const SIMPLE_STEPS = STEPS.filter((s) => ['load', 'review', 'history', 'forecast', 'save'].includes(s.id));

export function stepsFor(advanced: boolean) {
  return advanced ? STEPS : SIMPLE_STEPS;
}

/** "Step 2 of 5" for a step in the current list. */
export function useEyebrow(id: StepId): string {
  const advanced = useStore((s) => s.advanced);
  const list = stepsFor(advanced);
  const i = list.findIndex((x) => x.id === id);
  return i >= 0 ? `Step ${i + 1} of ${list.length}` : advanced ? 'Advanced tool' : '';
}

export interface Source {
  name: string;
  size: number;
  file?: File;
  demo: boolean;
  report: DetectionReport;
  mapping: ColumnMapping;
  profileId?: string;
  profileName?: string;
}

export interface Busy { phase: string; frac: number; rows?: number }

export interface SessionChange { id: string; at: string; label: string; kind: 'rule' | 'txnOverride' | 'seriesOverride' | 'alias'; ref: string }

export interface Toast { id: string; text: string; kind?: 'ok' | 'err'; action?: { label: string; run: () => void } }

interface State {
  team: TeamFile;
  teamName: string | null;
  teamHandle: FileSystemFileHandle | null;
  teamLoadedHash: string | null;
  teamLoadedSavedAt: string | null;
  dirty: boolean;
  user: string;
  sessionChanges: SessionChange[];
  sources: Source[];
  ingest: IngestSummary | null;
  ingestBusy: Busy | null;
  ingestError: string | null;
  cat: CatSummary | null;
  catBusy: Busy | null;
  catVersion: number;
  agg: Aggregates | null;
  basis: ForecastBasis | null;
  hasTruth: boolean;
  demo: { rows: number; options: GeneratorOptions } | null;
  /** the council's deal register, read in this browser for this session only (never saved to the team file) */
  register: RegisterInfo | null;
  /** the cash history as it was before this session's files (from the team file) */
  historyBase: CashHistory | null;
  /** what adding this session's files to the history did */
  historyReport: MergeReport | null;
  /** looking at the saved history alone, without loading bank files */
  historyOnly: boolean;
  registerBusy: boolean;
  registerError: string | null;
  step: StepId;
  reached: number;
  workspace: boolean;
  activeScenarioId: string | null;
  compareIds: string[];
  toasts: Toast[];
  showTips: boolean;
  advanced: boolean;
  stepTab: Record<string, string>;
  mergeState: { theirs: TeamFile; conflicts: MergeConflict[]; summary: string[]; resolve: Record<string, 'mine' | 'theirs'> } | null;
}

interface Actions {
  toast: (text: string, kind?: 'ok' | 'err', action?: Toast['action']) => void;
  dismissToast: (id: string) => void;
  setShowTips: (v: boolean) => void;
  setAdvanced: (v: boolean) => void;
  setStepTab: (step: string, tab: string) => void;
  setUser: (u: string) => void;
  goto: (s: StepId) => void;
  next: () => void;
  enterWorkspace: () => void;
  loadTeamText: (text: string, name: string, handle?: FileSystemFileHandle | null) => { ok: boolean; message: string };
  startFresh: (authority?: string) => void;
  updateTeam: (fn: (t: TeamFile) => TeamFile, opts?: { recategorise?: boolean }) => void;
  addRule: (r: Omit<Rule, 'id' | 'createdAt' | 'createdBy' | 'source'>, label?: string) => string;
  addTxnOverrides: (o: TxnOverride[], label: string) => void;
  setSeriesOverride: (o: SeriesOverride, label: string) => void;
  addAlias: (a: Alias, label: string) => void;
  undoChange: (id: string) => void;
  addFiles: (files: File[]) => Promise<void>;
  removeSource: (name: string) => void;
  setMapping: (name: string, m: ColumnMapping) => void;
  saveProfile: (name: string, profileName: string) => void;
  generateDemo: (o: GeneratorOptions) => Promise<void>;
  loadRegisterFile: (f: File) => Promise<void>;
  useExampleRegister: () => Promise<void>;
  clearRegister: () => Promise<void>;
  runIngest: () => Promise<boolean>;
  runCategorise: () => Promise<void>;
  useSavedHistory: () => void;
  forgetHistory: () => void;
  saveTeam: (mode?: 'save' | 'saveAs' | 'download') => Promise<void>;
  resolveMerge: (apply: boolean) => Promise<void>;
  setMergeChoice: (key: string, v: 'mine' | 'theirs') => void;
  newScenario: (name: string, from?: Scenario) => string;
  updateScenario: (id: string, fn: (s: Scenario) => Scenario) => void;
  deleteScenario: (id: string) => void;
  setActiveScenario: (id: string | null) => void;
  setCompare: (ids: string[]) => void;
}

const LS_USER = 'cfi.user';
const LS_TEAM = 'cfi.teamCache';

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

export function defaultSettings(basis: ForecastBasis | null): ForecastSettings {
  const start = basis ? basis.dataEnd + 1 : Math.floor(Date.now() / 86400000);
  return {
    start: isoFromDay(start), end: isoFromDay(addMonths(start, 24) - 1), granularity: 'monthly', openingPosition: null,
    lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645,
  };
}

export const useStore = create<State & Actions>((set, get) => ({
  team: (() => {
    const cached = lsGet(LS_TEAM);
    if (cached) { const r = parseTeamFile(cached); if (r.ok && r.team) return r.team; }
    return emptyTeamFile();
  })(),
  teamName: null,
  teamHandle: null,
  teamLoadedHash: null,
  teamLoadedSavedAt: null,
  dirty: false,
  user: lsGet(LS_USER) ?? '',
  sessionChanges: [],
  sources: [],
  ingest: null,
  ingestBusy: null,
  ingestError: null,
  cat: null,
  catBusy: null,
  catVersion: 0,
  agg: null,
  basis: null,
  hasTruth: false,
  demo: null,
  register: null,
  historyBase: null,
  historyReport: null,
  historyOnly: false,
  registerBusy: false,
  registerError: null,
  step: 'home',
  reached: 0,
  workspace: false,
  activeScenarioId: null,
  compareIds: [],
  toasts: [],
  showTips: lsGet('cfi.tips') !== '0',
  advanced: lsGet('cfi.advanced') === '1',
  stepTab: {},
  mergeState: null,

  setAdvanced: (v) => { lsSet('cfi.advanced', v ? '1' : '0'); set({ advanced: v }); },
  setShowTips: (v) => { lsSet('cfi.tips', v ? '1' : '0'); set({ showTips: v }); },
  setStepTab: (step, tab) => { set((s) => ({ stepTab: { ...s.stepTab, [step]: tab } })); document.querySelector('.main')?.scrollTo({ top: 0 }); },
  toast: (text, kind = 'ok', action) => {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
    setTimeout(() => get().dismissToast(id), action ? 9000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setUser: (u) => { lsSet(LS_USER, u); set({ user: u }); },

  goto: (step) => {
    const list = stepsFor(get().advanced);
    const i = list.findIndex((s) => s.id === step);
    set((s) => ({ step, reached: Math.max(s.reached, i) }));
    document.querySelector('.main')?.scrollTo({ top: 0 });
  },
  next: () => {
    const list = stepsFor(get().advanced);
    const i = list.findIndex((s) => s.id === get().step);
    if (i < list.length - 1) get().goto(list[i + 1].id);
  },
  enterWorkspace: () => set({ workspace: true }),

  loadTeamText: (text, name, handle = null) => {
    const r = parseTeamFile(text);
    if (!r.ok || !r.team) return { ok: false, message: r.errors.join(' ') };
    set({ team: r.team, teamName: name, teamHandle: handle, teamLoadedHash: teamHash(text), teamLoadedSavedAt: r.team.savedAt, dirty: false, sessionChanges: [], activeScenarioId: r.team.forecasts[0]?.id ?? null, historyBase: r.team.cashHistory ?? null, historyReport: null, historyOnly: false });
    lsSet(LS_TEAM, text);
    // re-match bank profiles for sources already added
    set((s) => ({ sources: s.sources.map((src) => applyProfile(src, r.team!)) }));
    if (get().ingest) void get().runCategorise();
    return { ok: true, message: r.warnings.join(' ') };
  },
  startFresh: (authority) => {
    const t = emptyTeamFile(authority);
    set({ team: t, teamName: null, teamHandle: null, teamLoadedHash: null, teamLoadedSavedAt: null, dirty: true, sessionChanges: [], activeScenarioId: null, historyBase: null, historyReport: null, historyOnly: false });
  },

  updateTeam: (fn, opts) => {
    set((s) => ({ team: fn(s.team), dirty: true }));
    lsSet(LS_TEAM, JSON.stringify(get().team));
    if (opts?.recategorise && get().ingest) void get().runCategorise();
  },

  addRule: (r, label) => {
    const id = uid('rule');
    const rule: Rule = { ...r, id, createdAt: new Date().toISOString(), createdBy: get().user || undefined, source: 'team' };
    get().updateTeam((t) => ({ ...t, rules: [rule, ...t.rules] }), { recategorise: true });
    set((s) => ({ sessionChanges: [{ id: uid('c'), at: rule.createdAt!, label: label ?? `${r.type} “${r.pattern}” → ${r.categoryId}`, kind: 'rule', ref: id }, ...s.sessionChanges] }));
    return id;
  },
  addTxnOverrides: (os, label) => {
    const keys = new Set(os.map((o) => o.key));
    get().updateTeam((t) => ({ ...t, txnOverrides: [...t.txnOverrides.filter((x) => !keys.has(x.key)), ...os] }), { recategorise: true });
    set((s) => ({ sessionChanges: [{ id: uid('c'), at: new Date().toISOString(), label, kind: 'txnOverride', ref: [...keys].join(',') }, ...s.sessionChanges] }));
  },
  setSeriesOverride: (o, label) => {
    get().updateTeam((t) => ({ ...t, seriesOverrides: [...t.seriesOverrides.filter((x) => x.signature !== o.signature), o] }), { recategorise: true });
    set((s) => ({ sessionChanges: [{ id: uid('c'), at: new Date().toISOString(), label, kind: 'seriesOverride', ref: o.signature }, ...s.sessionChanges] }));
  },
  addAlias: (a, label) => {
    get().updateTeam((t) => {
      const ex = t.aliases.find((x) => x.canonical === a.canonical);
      const aliases = ex ? t.aliases.map((x) => (x === ex ? { ...x, variants: [...new Set([...x.variants, ...a.variants])] } : x)) : [...t.aliases, a];
      return { ...t, aliases };
    }, { recategorise: true });
    set((s) => ({ sessionChanges: [{ id: uid('c'), at: new Date().toISOString(), label, kind: 'alias', ref: `${a.canonical}|${a.variants.join('|')}` }, ...s.sessionChanges] }));
  },
  undoChange: (id) => {
    const c = get().sessionChanges.find((x) => x.id === id);
    if (!c) return;
    get().updateTeam((t) => {
      if (c.kind === 'rule') return { ...t, rules: t.rules.filter((r) => r.id !== c.ref) };
      if (c.kind === 'txnOverride') { const keys = new Set(c.ref.split(',')); return { ...t, txnOverrides: t.txnOverrides.filter((o) => !keys.has(o.key)) }; }
      if (c.kind === 'seriesOverride') return { ...t, seriesOverrides: t.seriesOverrides.filter((o) => o.signature !== c.ref) };
      const [canon, ...vars] = c.ref.split('|');
      return { ...t, aliases: t.aliases.map((a) => (a.canonical === canon ? { ...a, variants: a.variants.filter((v) => !vars.includes(v)) } : a)).filter((a) => a.variants.length) };
    }, { recategorise: true });
    set((s) => ({ sessionChanges: s.sessionChanges.filter((x) => x.id !== id) }));
    get().toast(`Undone: ${c.label}`);
  },

  addFiles: async (files) => {
    const csv = files.filter((f) => /\.(csv|txt|tsv)$/i.test(f.name) || f.type.includes('csv') || f.type === 'text/plain');
    const skipped = files.length - csv.length;
    if (skipped) get().toast(`${skipped} file(s) skipped — only CSV/TXT bank exports are supported.`, 'err');
    const added: Source[] = [];
    for (const f of csv) {
      const report = await engine().sniff(f);
      added.push(applyProfile({ name: f.name, size: f.size, file: f, demo: false, report, mapping: report.mapping }, get().team));
    }
    set((s) => {
      const names = new Set(added.map((a) => a.name));
      const demoOnly = s.sources.every((x) => x.demo);
      return { sources: [...(demoOnly && added.length ? [] : s.sources.filter((x) => !names.has(x.name))), ...added], demo: demoOnly && added.length ? null : s.demo };
    });
  },
  removeSource: (name) => set((s) => ({ sources: s.sources.filter((x) => x.name !== name) })),
  setMapping: (name, m) => set((s) => ({ sources: s.sources.map((x) => (x.name === name ? { ...x, mapping: m } : x)) })),
  saveProfile: (name, profileName) => {
    const src = get().sources.find((s) => s.name === name);
    if (!src) return;
    const sig = headerSignature(src.mapping.columns, src.mapping.delimiter);
    const existing = get().team.bankProfiles.find((p) => p.headerSignature === sig);
    const { defaultAccount: _d, ...mappingNoAcct } = src.mapping;
    const mapping = { ...mappingNoAcct, defaultAccount: src.mapping.account >= 0 ? '' : src.mapping.defaultAccount };
    const profile = { id: existing?.id ?? uid('bank'), name: profileName, headerSignature: sig, mapping, createdAt: new Date().toISOString() };
    get().updateTeam((t) => ({ ...t, bankProfiles: [...t.bankProfiles.filter((p) => p.id !== profile.id), profile] }));
    set((s) => ({ sources: s.sources.map((x) => (x.name === name ? { ...x, profileId: profile.id, profileName } : x)) }));
    get().toast(`Saved bank profile “${profileName}” — files with these headers will map automatically next time.`);
  },

  generateDemo: async (o) => {
    set({ ingestBusy: { phase: 'Generating synthetic bank history…', frac: 0.05 }, ingestError: null });
    try {
      const r = await engine().generateDemo(o);
      const sources: Source[] = r.files.map((f) => applyProfile({ name: f.name, size: f.size, demo: true, report: f.report, mapping: f.report.mapping }, get().team));
      if (get().team.authorityName === 'My Council') set((st) => ({ team: { ...st.team, authorityName: 'Northbridge Council (example)' } }));
      set({ sources, demo: { rows: r.rows, options: o }, hasTruth: true, historyBase: null });
      // the example council comes with its deal register, so the whole tool can be tried
      if (!get().register || get().register!.example) set({ register: await engine().useExampleRegister(), registerError: null });
      await get().runIngest();
    } catch (e) {
      set({ ingestBusy: null, ingestError: (e as Error).message });
    }
  },

  loadRegisterFile: async (f) => {
    set({ registerBusy: true, registerError: null });
    try {
      const info = await engine().loadRegister(new Uint8Array(await f.arrayBuffer()), f.name);
      set({ register: info, registerBusy: false });
      get().toast(`Deal register read: ${info.stats.loans} loans, ${info.stats.deals} deals`, 'ok');
      if (get().ingest) await get().runCategorise();
    } catch (e) {
      set({ registerBusy: false, registerError: (e as Error).message });
    }
  },

  useExampleRegister: async () => {
    set({ registerBusy: true, registerError: null });
    try {
      set({ register: await engine().useExampleRegister(), registerBusy: false });
      if (get().ingest) await get().runCategorise();
    } catch (e) {
      set({ registerBusy: false, registerError: (e as Error).message });
    }
  },

  clearRegister: async () => {
    await engine().clearRegister();
    set({ register: null, registerError: null });
    if (get().ingest) await get().runCategorise();
  },

  runIngest: async () => {
    const sources = get().sources;
    if (!sources.length) return false;
    set({ ingestBusy: { phase: 'Starting…', frac: 0 }, ingestError: null, cat: null, agg: null, basis: null });
    try {
      // progress messages can arrive after the result (small files): ignore any once it's done
      let live = true;
      const summary = await engine().ingest(
        sources.map((s) => ({ name: s.name, file: s.file, mapping: s.mapping })),
        proxy((p: Busy) => { if (live) set({ ingestBusy: p }); }),
      );
      live = false;
      set({ ingest: summary, ingestBusy: null });
      set({ hasTruth: await engine().hasTruth() });
      await get().runCategorise();
      return true;
    } catch (e) {
      set({ ingestBusy: null, ingestError: (e as Error).message });
      return false;
    }
  },

  runCategorise: async () => {
    const t = get().team;
    set({ catBusy: { phase: 'Categorising…', frac: 0 } });
    try {
      let live = true;
      const summary = await engine().categorise(
        { categories: t.categories, rules: t.rules, aliases: t.aliases, seriesOverrides: t.seriesOverrides, txnOverrides: t.txnOverrides, useStarterRules: true },
        proxy((p: Busy) => { if (live) set({ catBusy: p }); }),
      );
      live = false;
      let basis = await engine().getBasis();
      // add this session's files to the cash history (example data never mixes with a real council's)
      const isDemo = !!get().demo;
      const hb = get().historyBase;
      const accts = get().ingest?.accounts ?? [];
      // an example history only takes more of its own example accounts; a real one never takes example data
      const base = hb && (hb.example ? accts.length > 0 && accts.every((a) => hb.accounts.some((x) => x.key === a)) : !isDemo) ? hb : null;
      const session = await engine().sessionHistory(base?.series.map(({ sig, cat, dir }) => ({ sig, cat, dir })) ?? []);
      const example = isDemo || !!base?.example;
      const { history, report } = mergeHistory(base, { ...session, example: example || undefined });
      history.example = example || undefined;
      if (base) basis = basisFromHistory(history, summary.catIds) ?? basis;
      // record rule hit counts on team rules
      const hits = new Map(summary.ruleHits.map((h) => [h.id, h.hits]));
      set((s) => ({
        cat: summary, basis, agg: basis.agg, catBusy: null, catVersion: s.catVersion + 1, historyReport: report, historyOnly: false,
        team: { ...s.team, cashHistory: history, rules: s.team.rules.map((r) => (hits.has(r.id) ? { ...r, hits: hits.get(r.id) } : r)) },
      }));
      lsSet(LS_TEAM, JSON.stringify(get().team));
      if (!get().activeScenarioId && !get().team.forecasts.length) {
        const wasDirty = get().dirty;
        const id = get().newScenario('Base');
        set({ activeScenarioId: id, dirty: wasDirty });
      }
    } catch (e) {
      set({ catBusy: null });
      get().toast(`Categorisation failed: ${(e as Error).message}`, 'err');
    }
  },

  useSavedHistory: () => {
    const h = get().historyBase;
    if (!h) return;
    const basis = basisFromHistory(h, get().team.categories.map((c) => c.id));
    if (!basis) return;
    set({ basis, agg: basis.agg, historyOnly: true, catVersion: get().catVersion + 1 });
    if (!get().activeScenarioId && !get().team.forecasts.length) set({ activeScenarioId: get().newScenario('Base') });
  },

  forgetHistory: () => {
    set((s) => ({ historyBase: null, historyReport: null, historyOnly: false, team: { ...s.team, cashHistory: undefined }, dirty: true }));
    lsSet(LS_TEAM, JSON.stringify(get().team));
  },

  saveTeam: async (mode = 'save') => {
    const s = get();
    const by = s.user || 'unknown';
    const summary = summariseChanges(s);
    // Merge-on-save: if the file on disk changed since we loaded it, offer a merge first
    if (mode === 'save' && s.teamHandle && s.teamLoadedHash) {
      try {
        const onDisk = await readHandle(s.teamHandle);
        if (teamHash(onDisk) !== s.teamLoadedHash) {
          const theirs = parseTeamFile(onDisk);
          if (theirs.ok && theirs.team) {
            const m = mergeTeamFiles(s.team, theirs.team);
            set({ mergeState: { theirs: theirs.team, conflicts: m.conflicts, summary: m.summary, resolve: Object.fromEntries(m.conflicts.map((c) => [`${c.kind}:${c.id}`, 'mine'])) } });
            return;
          }
        }
      } catch { /* fall through to a plain save */ }
    }
    const { json, team } = serialiseTeamFile(s.team, by, summary);
    try {
      if (mode === 'download' || !fsAccessSupported()) {
        downloadText(json, s.teamName ?? TEAM_FILE_DEFAULT_NAME);
        set({ team, dirty: false, teamLoadedHash: teamHash(json), teamLoadedSavedAt: team.savedAt });
        get().toast('Team file downloaded. Put it back on your shared drive to share it.');
      } else if (mode === 'saveAs' || !s.teamHandle) {
        const h = await saveAsWithPicker(s.teamName ?? TEAM_FILE_DEFAULT_NAME, json);
        if (!h) return;
        set({ team, dirty: false, teamHandle: h, teamName: h.name, teamLoadedHash: teamHash(json), teamLoadedSavedAt: team.savedAt });
        get().toast(`Saved to ${h.name}.`);
      } else {
        await writeHandle(s.teamHandle, json);
        set({ team, dirty: false, teamLoadedHash: teamHash(json), teamLoadedSavedAt: team.savedAt });
        get().toast(`Saved ${s.teamName}.`);
      }
      lsSet(LS_TEAM, json);
      set({ sessionChanges: [] });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') get().toast(`Could not save: ${(e as Error).message}`, 'err');
    }
  },

  setMergeChoice: (key, v) => set((s) => (s.mergeState ? { mergeState: { ...s.mergeState, resolve: { ...s.mergeState.resolve, [key]: v } } } : {})),
  resolveMerge: async (apply) => {
    const ms = get().mergeState;
    if (!ms) return;
    if (!apply) { set({ mergeState: null }); return; }
    const m = mergeTeamFiles(get().team, ms.theirs);
    const merged = { ...m.merged };
    for (const c of m.conflicts) {
      if (ms.resolve[`${c.kind}:${c.id}`] !== 'theirs') continue;
      const key = ({ rule: 'rules', forecast: 'forecasts', bankProfile: 'bankProfiles', category: 'categories' } as const)[c.kind];
      (merged[key] as { id: string }[]) = (merged[key] as { id: string }[]).map((x) => (x.id === c.id ? (c.theirs as { id: string }) : x));
    }
    set({ team: merged, mergeState: null, teamLoadedHash: '__merged__' });
    // after merging, write without re-checking
    const s = get();
    const { json, team } = serialiseTeamFile(merged, s.user || 'unknown', `Merged with changes on disk; ${summariseChanges(s)}`);
    try {
      if (s.teamHandle) await writeHandle(s.teamHandle, json);
      else downloadText(json, s.teamName ?? TEAM_FILE_DEFAULT_NAME);
      set({ team, dirty: false, teamLoadedHash: teamHash(json), teamLoadedSavedAt: team.savedAt, sessionChanges: [] });
      get().toast(`Merged and saved. ${m.summary.join('; ') || 'No new items from disk.'}`);
      if (get().ingest) void get().runCategorise();
    } catch (e) {
      get().toast(`Could not save merged file: ${(e as Error).message}`, 'err');
    }
  },

  newScenario: (name, from) => {
    const id = uid('fc');
    const base: Scenario = from
      ? { ...structuredClone(from), id, name, updatedAt: new Date().toISOString(), createdBy: get().user || undefined, resultsSnapshot: undefined }
      : { id, name, createdBy: get().user || undefined, updatedAt: new Date().toISOString(), settings: defaultSettings(get().basis), assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [] };
    get().updateTeam((t) => ({ ...t, forecasts: [...t.forecasts, base] }));
    set({ activeScenarioId: id });
    return id;
  },
  updateScenario: (id, fn) => get().updateTeam((t) => ({ ...t, forecasts: t.forecasts.map((f) => (f.id === id ? { ...fn(f), updatedAt: new Date().toISOString() } : f)) })),
  deleteScenario: (id) => {
    get().updateTeam((t) => ({ ...t, forecasts: t.forecasts.filter((f) => f.id !== id) }));
    set((s) => ({ activeScenarioId: s.activeScenarioId === id ? s.team.forecasts[0]?.id ?? null : s.activeScenarioId, compareIds: s.compareIds.filter((x) => x !== id) }));
  },
  setActiveScenario: (id) => set({ activeScenarioId: id }),
  setCompare: (ids) => set({ compareIds: ids.slice(0, 3) }),
}));

function applyProfile(src: Source, team: TeamFile): Source {
  const sig = headerSignature(src.report.mapping.columns, src.report.mapping.delimiter);
  const p = team.bankProfiles.find((x) => x.headerSignature === sig);
  if (!p) return src;
  const mapping: ColumnMapping = { ...src.report.mapping, ...p.mapping, headerRow: src.report.mapping.headerRow, defaultAccount: p.mapping.defaultAccount || src.report.mapping.defaultAccount };
  return { ...src, mapping, profileId: p.id, profileName: p.name };
}

function summariseChanges(s: State): string {
  const parts: string[] = [];
  const rules = s.sessionChanges.filter((c) => c.kind === 'rule').length;
  const ov = s.sessionChanges.filter((c) => c.kind !== 'rule').length;
  if (rules) parts.push(`added ${rules} rule${rules > 1 ? 's' : ''}`);
  if (ov) parts.push(`${ov} review decision${ov > 1 ? 's' : ''}`);
  const fc = s.team.forecasts.find((f) => f.id === s.activeScenarioId);
  if (fc) parts.push(`saved forecast “${fc.name}”`);
  return parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Saved';
}

// the cash history from the cached team file is the base for this browser session
useStore.setState({ historyBase: useStore.getState().team.cashHistory ?? null });
