// Shared types: rules, bank profiles, forecasts and the team file.
import type { Category, ForecastMethod } from './categories';
import type { ColumnMapping } from './ingest/detect';

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
  | { id: string; kind: 'timing'; categoryId: string; from: string; rule: 'last_working_day' | 'day_of_month'; dayOfMonth?: number; note?: string }
  | { id: string; kind: 'stop'; categoryId: string; from: string; note?: string }
  | { id: string; kind: 'start'; categoryId: string; from: string; until?: string; amount: number; cadence: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual'; dayOfMonth?: number; note?: string }
  | { id: string; kind: 'inflation'; pct: number; categoryIds: string[]; note?: string };

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
  settings: { financialYearStart: string; currency: 'GBP'; liquidityBuffer: number; includeHistorySummary: boolean };
  bankProfiles: BankProfile[];
  categories: Category[];
  rules: Rule[];
  aliases: Alias[];
  seriesOverrides: SeriesOverride[];
  txnOverrides: TxnOverride[];
  historySummary?: HistorySummary;
  forecasts: Scenario[];
  changeLog: ChangeLogEntry[];
}

export function uid(prefix = 'id'): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${r}`;
}
