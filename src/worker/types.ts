import type { Day } from '../lib/dates';
import type { BalanceCheck, FileSummary, RejectedRow } from '../lib/ingest/ingest';
import type { Series } from '../lib/categorise/engine';

export interface IngestSummary {
  rows: number;
  files: FileSummary[];
  rejectsTotal: number;
  rejectSample: RejectedRow[];
  accounts: string[];
  minDay: Day;
  maxDay: Day;
  balanceChecks: BalanceCheck[];
  openingBalance: number | null;
  swappedDates: number;
  dupCandidates: number;
  overlapRemoved: number;
  coverageGaps: { from: Day; to: Day; businessDays: number }[];
  ms: number;
}

export interface CatSummary {
  rows: number;
  ms: number;
  stageMs: Record<string, number>;
  catIds: string[];
  byCategory: { rows: number; valueIn: number; valueOut: number; abs: number; deal: number; oneOff: number }[];
  operationalAbs: number;
  treasuryAbs: number;
  internalAbs: number;
  uncategorisedAbs: number;
  uncategorisedRows: number;
  lowConfAbs: number;
  lowConfRows: number;
  dealAbs: number;
  suspectedAbs: number;
  suspectedRows: number;
  dealLikeOpAbs: number;
  dealLikeOpRows: number;
  outlierRows: number;
  valueCategorisedPct: number;
  seriesCount: number;
  recurringUnknown: number;
  ruleHits: { id: string; hits: number }[];
  rulesUsed: number;
  flagCounts: Record<number, number>;
  bySource: { label: string; rows: number; abs: number }[];
}

export interface TxnRow {
  i: number;
  key: string;
  day: Day;
  amount: number;
  account: string;
  narrative: string;
  signature: string;
  catIdx: number;
  rule: string;
  ruleId: string | null;
  conf: number;
  deal: number;
  flags: number;
  oneOff: number;
  seriesId: number;
  file: string;
  line: number;
}

export interface ReviewGroup {
  sigIdx: number;
  signature: string;
  samples: string[];
  count: number;
  total: number;
  abs: number;
  firstDay: Day;
  lastDay: Day;
  cadence: string | null;
  catIdx: number;
  conf: number;
  deal: number;
  direction: 'in' | 'out' | 'mixed';
  flags: number;
  rule: string;
  rowKeys?: string[];
}

export interface LoanPair {
  first: TxnRow;
  second: TxnRow;
  days: number;
  impliedRate: number;
}

export interface DealQueue {
  groups: ReviewGroup[];
  pairs: LoanPair[];
  dealLike: TxnRow[];
  excludedAbs: number;
  suspectedAbs: number;
}

export interface TxnFilter {
  catIdx?: number | null;
  uncategorised?: boolean;
  sigIdx?: number;
  seriesId?: number;
  deal?: 'any' | 'deal' | 'operational';
  flagMask?: number;
  oneOff?: boolean;
  search?: string;
  from?: Day;
  to?: Day;
  account?: string;
  sort?: 'day' | 'day_desc' | 'abs_desc';
}

export interface CategoryDetail {
  series: (Series & { inCategory: number })[];
  topSignatures: { sigIdx: number; signature: string; count: number; total: number; abs: number }[];
  oneOffs: TxnRow[];
  excludedAsDeal: number;
}
