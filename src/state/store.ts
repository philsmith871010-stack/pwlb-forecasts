import { create } from 'zustand';
import type { DetectionReport, ColumnMapping } from '../lib/ingest/detect';
import { headerSignature } from '../lib/ingest/detect';
import type { TeamFile, Rule, Scenario, TxnOverride, SeriesOverride, ForecastSettings, Alias } from '../lib/model';
import { uid } from '../lib/model';
import { emptyTeamFile, parseTeamFile, serialiseTeamFile, teamHash, fsAccessSupported, readHandle, writeHandle, saveAsWithPicker, downloadText, mergeTeamFiles, MergeConflict } from '../lib/teamfile';
import type { IngestSummary, CatSummary, RegisterInfo } from '../worker/types';
import { signForecast, knownItemsOf, type SignedForecast } from '../lib/forecast/signoff';
import { exampleSignOffs } from '../lib/forecast/exampleSignoffs';
import type { ForecastResult } from '../lib/forecast/engine';
import { mergeHistory, basisFromHistory, historyBefore, historyDays, MIN_HISTORY_DAYS, type CashHistory, type MergeReport } from '../lib/history/cashHistory';
import type { Aggregates, ForecastBasis } from '../lib/analysis/aggregates';
import { engine, proxy } from '../worker/client';
import type { GeneratorOptions } from '../generator';
import { isoFromDay, addMonths } from '../lib/dates';
import { setExactAmounts as setExactAmountsFormat } from '../lib/format';
import { TEAM_FILE_DEFAULT_NAME } from '../config';

export type StepId = 'load' | 'map' | 'categorise' | 'review' | 'history' | 'forecast' | 'backtest' | 'save' | 'data' | 'settings' | 'home' | 'today';
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

// ---------------------------------------------------------------- the three jobs

export type StreamId = 'today' | 'history' | 'forecast';
export interface Stream { id: StreamId; label: string; short: string; icon: string; steps: { id: StepId; label: string; advanced?: boolean }[] }
/** Everything the tool does, as three jobs, each a short path of steps. */
export const STREAMS: Stream[] = [
  { id: 'today', label: 'Today’s statement', short: 'Today', icon: 'bi-calendar-day', steps: [{ id: 'today', label: 'Today’s statement' }] },
  { id: 'history', label: 'History', short: 'History', icon: 'bi-bar-chart-line', steps: [
    { id: 'load', label: 'Load statements' },
    { id: 'map', label: 'Check the files', advanced: true },
    { id: 'categorise', label: 'Sorting results', advanced: true },
    { id: 'review', label: 'Check the sorting' },
    { id: 'history', label: 'Look back' },
    { id: 'data', label: 'All transactions', advanced: true },
  ] },
  { id: 'forecast', label: 'Forecast', short: 'Forecast', icon: 'bi-graph-up-arrow', steps: [
    { id: 'forecast', label: 'Build the forecast' },
    { id: 'backtest', label: 'Test it', advanced: true },
    { id: 'save', label: 'Save & share', advanced: true },
  ] },
];
export const streamSteps = (st: Stream, advanced: boolean) => st.steps.filter((x) => advanced || !x.advanced);
export const streamOf = (step: StepId): Stream | undefined => STREAMS.find((st) => st.steps.some((x) => x.id === step));

/** No "step 2 of 5" labels any more: the menu and the step strip already say where you are. */
export function useEyebrow(id: StepId): string {
  void id;
  return '';
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

/** Your council's work, or the example council's: each kept separately in this browser. */
export type Workspace = 'mine' | 'example';
export const EXAMPLE_OPTIONS: GeneratorOptions = { seed: 'northbridge', startFY: 2021, years: 5, preset: 'small', accounts: 4, nastiness: 1 };

interface State {
  /** past the landing page */
  entered: boolean;
  /** an in-app confirmation waiting for an answer (the browser's own pop-ups can be blocked) */
  confirmBox: { title: string; body: string; ok: string; danger?: boolean; input?: ConfirmInput; resolve: (yes: boolean) => void } | null;
  /** every figure in pounds and pence, rather than £m / £k */
  exactAmounts: boolean;
  space: Workspace;
  exampleBusy: boolean;
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
  tryDayToDay: () => Promise<void>;
  enter: (ws: Workspace) => Promise<void>;
  setExactAmounts: (v: boolean) => void;
  askConfirm: (o: { title: string; body: string; ok: string; danger?: boolean; input?: ConfirmInput }) => Promise<boolean>;
  switchWorkspace: (ws: Workspace) => Promise<void>;
  setupExample: () => Promise<void>;
  useExampleStatement: () => Promise<void>;
  loadExampleHistory: () => Promise<void>;
  forgetWorkspace: () => void;
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
  /** freeze this forecast as it stands, to compare with what actually happens */
  signOff: (fc: ForecastResult, sc: Scenario, note?: string) => SignedForecast;
  updateScenario: (id: string, fn: (s: Scenario) => Scenario) => void;
  deleteScenario: (id: string) => void;
  setActiveScenario: (id: string | null) => void;
  setCompare: (ids: string[]) => void;
}

/** an optional box in the confirm dialog (e.g. your name); `onValue` gets what was typed on OK */
export interface ConfirmInput { label: string; value: string; placeholder?: string; onValue: (v: string) => void }

const LS_USER = 'cfi.user';
const LS_WS = 'cfi.workspace';
/** each workspace's team (rules, saved history, forecasts) lives in this browser under its own key */
const teamKey = (ws: Workspace) => (ws === 'example' ? 'cfi.teamCache.example' : 'cfi.teamCache');
function persistTeam(json: string) { lsSet(teamKey(useStore.getState().space), json); }
function cachedTeam(ws: Workspace): TeamFile {
  const cached = lsGet(teamKey(ws));
  if (cached) { const r = parseTeamFile(cached); if (r.ok && r.team) return r.team; }
  return emptyTeamFile(ws === 'example' ? 'Northbridge Council (example)' : undefined);
}
const initialExact = lsGet('cfi.exact') === '1';
setExactAmountsFormat(initialExact);
const initialWs: Workspace = lsGet('cfi.workspace') === 'example' ? 'example' : 'mine';

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
  entered: false,
  confirmBox: null,
  exactAmounts: initialExact,
  space: initialWs,
  exampleBusy: false,
  team: cachedTeam(initialWs),
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
  showTips: lsGet('cfi.tips') === '1',
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
    // with a saved history there's nothing to choose: look back and forecast work from it straight away
    if ((step === 'history' || step === 'forecast') && !get().basis && historyDays(get().historyBase) >= MIN_HISTORY_DAYS) get().useSavedHistory();
    if (step === 'history' && !get().basis) step = 'load';
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
    // example data doesn't belong to a real team file, and a team file with its own cash history
    // starts afresh: show what it holds and where to add new statements
    const fresh = !!get().demo || get().sources.some((x) => x.demo) || !!r.team.cashHistory;
    set({ team: r.team, teamName: name, teamHandle: handle, teamLoadedHash: teamHash(text), teamLoadedSavedAt: r.team.savedAt, dirty: false, sessionChanges: [], activeScenarioId: r.team.forecasts[0]?.id ?? null, historyBase: r.team.cashHistory ?? null, historyReport: null, historyOnly: false });
    if (fresh) set((s) => ({ sources: [], ingest: null, cat: null, agg: null, basis: null, demo: null, ingestError: null, register: s.register?.example ? null : s.register }));
    persistTeam(text);
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
    persistTeam(JSON.stringify(get().team));
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
      set({ sources, demo: { rows: r.rows, options: o }, hasTruth: true });
      // the example council comes with its deal register, so the whole tool can be tried
      if (!get().register || get().register!.example) set({ register: await engine().useExampleRegister(), registerError: null });
      await get().runIngest();
    } catch (e) {
      set({ ingestBusy: null, ingestError: (e as Error).message });
    }
  },

  /** The example as a returning user sees it: a saved history up to yesterday, and today's statement. */
  tryDayToDay: async () => {
    await get().switchWorkspace('example');
    get().goto('today');
  },

  askConfirm: (o) => new Promise<boolean>((resolve) => {
    set({ confirmBox: { ...o, resolve: (yes) => { set({ confirmBox: null }); resolve(yes); } } });
  }),

  setExactAmounts: (v) => { lsSet('cfi.exact', v ? '1' : '0'); setExactAmountsFormat(v); set({ exactAmounts: v }); },

  enter: async (ws) => {
    set({ entered: true });
    get().goto('home');
    await get().switchWorkspace(ws);
  },

  switchWorkspace: async (ws) => {
    if (ws !== get().space) {
      lsSet(LS_WS, ws);
      const team = cachedTeam(ws);
      set({
        space: ws, team, teamName: null, teamHandle: null, dirty: false, sessionChanges: [], activeScenarioId: team.forecasts[0]?.id ?? null,
        historyBase: team.cashHistory ?? null, historyReport: null, historyOnly: false,
        sources: [], ingest: null, cat: null, agg: null, basis: null, demo: null, register: null, ingestError: null,
      });
    }
    if (ws === 'example' && !get().team.cashHistory) await get().setupExample();
    // an example saved before sign-offs existed gets its two signed-off forecasts
    else if (ws === 'example' && !get().team.signedOff?.length && get().team.cashHistory) {
      const h = get().team.cashHistory!;
      get().updateTeam((t) => ({ ...t, signedOff: exampleSignOffs(h, t.categories, t.settings.liquidityBuffer) }));
    }
    // the example council's deal register is always connected
    if (ws === 'example' && !get().register) await get().useExampleRegister();
    // stay on the same job, now working from this workspace's saved history
    const st = get().step;
    if (st === 'forecast' || st === 'history' || st === 'load' || st === 'review') get().goto(st === 'forecast' ? 'forecast' : 'history');
  },

  /** The example council's saved history: five years, up to the day before its last statement. */
  setupExample: async () => {
    if (get().exampleBusy) return;
    set({ exampleBusy: true });
    try {
      set({ team: emptyTeamFile('Northbridge Council (example)'), historyBase: null });
      await get().generateDemo({ ...EXAMPLE_OPTIONS });
      const ing = get().ingest, h = get().team.cashHistory;
      if (ing && h) {
        const base = historyBefore(h, ing.maxDay);
        const signedOff = exampleSignOffs(base, get().team.categories, get().team.settings.liquidityBuffer);
        set((s) => ({ team: { ...s.team, authorityName: 'Northbridge Council (example)', cashHistory: base, signedOff }, historyBase: base, historyReport: null, sources: [], ingest: null, cat: null, agg: null, basis: null, demo: null }));
        persistTeam(JSON.stringify(get().team));
      }
    } finally { set({ exampleBusy: false }); }
  },

  /** Example workspace: today's statement, ready to go. */
  useExampleStatement: async () => {
    set({ ingestBusy: { phase: 'Preparing the example statement…', frac: 0.1 } });
    const st = await engine().exampleLastDayStatement({ ...EXAMPLE_OPTIONS });
    set({ sources: [{ name: st.name, size: st.size, demo: true, report: st.report, mapping: st.report.mapping }], demo: null, ingest: null, cat: null, agg: null, basis: null });
    await get().runIngest();
  },

  /** Example workspace: its five years of statements, as if loaded. */
  loadExampleHistory: async () => { await get().generateDemo({ ...EXAMPLE_OPTIONS }); },

  /** Clear this workspace's saved work from the browser. */
  forgetWorkspace: () => {
    const ws = get().space;
    try { localStorage.removeItem(teamKey(ws)); } catch { /* storage unavailable */ }
    const team = emptyTeamFile(ws === 'example' ? 'Northbridge Council (example)' : undefined);
    set({ team, historyBase: null, historyReport: null, historyOnly: false, sources: [], ingest: null, cat: null, agg: null, basis: null, demo: null, register: null, activeScenarioId: null, sessionChanges: [] });
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
      // a saved history these files can't join is left exactly as it was
      const keepSaved = !!hb && !base;
      // record rule hit counts on team rules
      const hits = new Map(summary.ruleHits.map((h) => [h.id, h.hits]));
      set((s) => ({
        cat: summary, basis, agg: basis.agg, catBusy: null, catVersion: s.catVersion + 1, historyReport: keepSaved ? null : report, historyOnly: false,
        team: { ...s.team, cashHistory: keepSaved ? hb! : history, rules: s.team.rules.map((r) => (hits.has(r.id) ? { ...r, hits: hits.get(r.id) } : r)) },
      }));
      persistTeam(JSON.stringify(get().team));
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
    persistTeam(JSON.stringify(get().team));
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
      persistTeam(json);
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

  signOff: (fc, sc, note) => {
    const rec = signForecast(fc, sc, { id: uid('so'), signedAt: new Date().toISOString(), signedBy: get().user || 'Not named', note: note || undefined, knownItems: knownItemsOf(sc, get().team.categories) });
    get().updateTeam((t) => ({ ...t, signedOff: [...(t.signedOff ?? []), rec] }));
    return rec;
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
