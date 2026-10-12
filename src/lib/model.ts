import type { SignedForecast, SignOffChange } from './forecast/signoff';
// Shared types: rules, bank profiles, forecasts and the team file.
import type { Category, ForecastMethod } from './categories';
import type { ColumnMapping } from './ingest/detect';
import type { CashHistory } from './history/cashHistory';

export type DealFlag = 'deal' | 'not_deal' | 'suspected';
export type Confidence = 'high' | 'medium' | 'low';
export type Classification = 'recurring' | 'one_off';

export type RuleType = 'alias' | 'contains' | 'regex' | 'counterparty';

export interface Rule {
  id: string;
  type: RuleType;
  /** alias: exact normalised signature; contains: substring of signature; regex: JS regex source on signature */
  pattern: string;
  categoryId: string;
  dealFlag?: DealFlag;
  direction?: 'in' | 'out' | 'any';
  minAmount?: number;
  maxAmount?: number;
  classification?: Classification;
  confidence?: Confidence;
  createdBy?: string;
  createdAt?: string;
  hits?: number;
  note?: string;
  /** starter rules are built in and not saved to the team file */
  source?: 'team' | 'starter' | 'session';
}

export interface Alias {
  canonical: string;
  variants: string[];
}

export interface BankProfile {
  id: string;
  name: string;
  headerSignature: string;
  mapping: ColumnMapping;
  createdAt?: string;
}

export interface SeriesOverride {
  signature: string;
  classification: Classification;
}

/** Per-transaction override, keyed by a one-way hash (no transaction data is stored). */
export interface TxnOverride {
  key: string;
  categoryId?: string;
  classification?: Classification;
  dealFlag?: DealFlag;
}

// ---------------------------------------------------------------- forecasting

export type GrowthMode = 'annual_step' | 'continuous';

export type Assumption =
  | { id: string; kind: 'growth'; categoryId: string; pct: number; mode: GrowthMode; note?: string }
  | { id: string; kind: 'step'; categoryId: string; pct: number; effective: string; backdateFrom?: string; arrearsPaidOn?: string; note?: string }
  /** moves payments to a day: a whole category, or (with `signature`) just one regular payment series */
  | { id: string; kind: 'timing'; categoryId: string; from: string; rule: 'last_working_day' | 'day_of_month' | 'weekday'; dayOfMonth?: number; /** 0 = Sunday … 6 = Saturday (rule 'weekday', series only) */ weekday?: number; signature?: string; note?: string }
  /** stops a whole category, or (with `signature`) just one regular payment series */
  | { id: string; kind: 'stop'; categoryId: string; from: string; signature?: string; note?: string }
  | { id: string; kind: 'start'; categoryId: string; from: string; until?: string; amount: number; cadence: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual'; dayOfMonth?: number; note?: string }
  | { id: string; kind: 'inflation'; pct: number; categoryIds: string[]; note?: string };

/** A figure typed or pasted into a category's month-by-month grid. It is final: growth and
 * size changes are not applied on top. `row` is 'series:<signature>', 'pattern' (everything
 * else in the category) or 'custom:<label>' (a row the user added, e.g. a new grant). */
export interface GridOverride {
  categoryId: string;
  row: string;
  /** YYYY-MM: the row's total for that month */
  month: string;
  /** YYYY-MM-DD: the row's amount on that day (applied after month totals) */
  date?: string;
  /** signed: + in, − out */
  amount: number;
  /** the import or wizard this came from (its row name): deleting that row removes all of it */
  source?: string;
}

export interface OneOff {
  id: string;
  date: string;
  /** signed: + in, − out */
  amount: number;
  categoryId: string;
  description: string;
  confidence: 'firm' | 'likely' | 'possible';
  probability?: number;
}

export interface PastedSchedule {
  id: string;
  name: string;
  categoryId: string;
  mode: 'replace' | 'add';
  /** Resolved daily entries (ISO date → signed amount) */
  entries: { date: string; amount: number }[];
  sourceText?: string;
}

export interface TreasuryItem {
  id: string;
  date: string;
  amount: number;
  description: string;
}

export interface ForecastSettings {
  start: string;
  end: string;
  granularity: 'daily' | 'weekly' | 'monthly';
  openingPosition: number | null;
  /** where the opening position comes from when openingPosition is null */
  openingMode?: 'bank' | 'operational' | 'manual';
  lookbackYears: number;
  recencyWeight: number;
  methodByCategory: Record<string, ForecastMethod>;
  includePossible: boolean;
  bandZ: number;
}

export interface ResultsSnapshot {
  generatedAt: string;
  granularity: 'monthly' | 'weekly';
  periods: string[];
  /** category id → period values */
  byCategory: Record<string, number[]>;
  net: number[];
  cumulative: number[];
  lower: number[];
  upper: number[];
  low: { date: string; amount: number };
  high: { date: string; amount: number };
  summary: string;
}

export interface Scenario {
  id: string;
  name: string;
  createdBy?: string;
  updatedAt: string;
  settings: ForecastSettings;
  assumptions: Assumption[];
  oneOffs: OneOff[];
  pastedSchedules: PastedSchedule[];
  treasurySchedule: TreasuryItem[];
  resultsSnapshot?: ResultsSnapshot;
  /** month-by-month figures the user typed or pasted */
  overrides?: GridOverride[];
  /** categories the user has checked on "Check each line" */
  reviewed?: string[];
  /** the user has checked the proposal and asked to see the forecast */
  reviewDone?: boolean;
  /** the data end date (ISO) the checks were made against: new data means checking again */
  reviewFor?: string;
}

export interface HistorySummary {
  generatedAt: string;
  firstMonth: string;
  /** month labels yyyy-mm */
  months: string[];
  /** category id → monthly totals */
  byCategory: Record<string, number[]>;
  openingPosition: number;
}

export interface ChangeLogEntry {
  at: string;
  by: string;
  summary: string;
}

export interface TeamFile {
  kind: 'cash-flow-insight-team-file';
  schemaVersion: 1;
  authorityName: string;
  savedAt: string;
  savedBy: string;
  settings: { financialYearStart: string; currency: 'GBP'; liquidityBuffer: number; includeHistorySummary: boolean; /** keep the cash history in the team file (default yes) */ keepCashHistory?: boolean;
    /** the sign-off Home and Today's statement report on (by id); otherwise the newest with a month of statements */ trackedSignOff?: string };
  bankProfiles: BankProfile[];
  categories: Category[];
  rules: Rule[];
  aliases: Alias[];
  seriesOverrides: SeriesOverride[];
  txnOverrides: TxnOverride[];
  historySummary?: HistorySummary;
  /** daily totals by category per bank account, and regular payments: never bank lines */
  cashHistory?: CashHistory;
  forecasts: Scenario[];
  /** forecasts as they stood when signed off: never edited, only added (see lib/forecast/signoff) */
  signedOff?: SignedForecast[];
  /** sign-offs withdrawn (made by mistake) and restored: a log, only added to, so it merges like the sign-offs (see lib/forecast/signoff) */
  signOffChanges?: SignOffChange[];
  changeLog: ChangeLogEntry[];
}

export function uid(prefix = 'id'): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${r}`;
}
