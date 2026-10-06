// Typed wrapper around the vendored PWLBreports deal register reader.
// The register is the council's own record of its loans and investments (an Excel
// workbook it keeps). It is read here, in the browser, exactly as PWLBreports reads it.
import XLraw from './vendor/xlsx.js';
import REGraw from './vendor/model.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const XL = XLraw as any;
export const REG = REGraw as any;

export type RegDate = Date; // UTC midnight

export interface RegLoan {
  row: number; issues: string[];
  type: string | null; typeRaw: string; lender: string; lenderType: string | null;
  principal: number; start: RegDate | null; maturity: RegDate | null; rate: number | null;
  profile: 'Maturity' | 'EIP' | 'Annuity' | null; frequency: 'Half-yearly' | 'Annual' | 'Quarterly' | null;
  firstRepayment: RegDate | null; fund: string | null; nextCall: RegDate | null;
  history: boolean; forward: boolean; counts: boolean; runsOff: boolean; raised: number;
  schedule: { date: RegDate; amount: number }[];
}

export interface RegTerm {
  row: number; issues: string[];
  type: string | null; counterparty: string; cpType: string | null;
  principal: number; start: RegDate | null; maturity: RegDate | null; rate: number | null;
  faceValue: number | null; carryingValue: number | null; rating: string;
  nominal: number; history: boolean; forward: boolean; counts: boolean; runsOff: boolean;
}

export interface RegCall {
  row: number; issues: string[]; type: string | null; counterparty: string; cpType: string | null;
  balance: number; rate: number | null; noticeDays: number | null; counts: boolean;
}

export interface RegFund { row: number; issues: string[]; name: string; carryingValue: number; latestValue: number | null; rate: number | null; counts: boolean }

export interface ProjectionBlock { head: string[]; rows: (string | number | null)[][]; title: string }

export interface Register {
  asAt: RegDate | null; hra: string | null; twoPools: boolean; version: number | null;
  termInvestments: RegTerm[]; callAccounts: RegCall[]; loans: RegLoan[]; pooledFunds: RegFund[];
  projections: { gf?: ProjectionBlock; hra?: ProjectionBlock } | null;
  issues: string[]; name: string;
}

export interface LoadedRegister {
  reg: Register;
  /** what was read, small and the council's own — kept for the session */
  name: string;
  readAt: string;
  stats: { debt: number; invested: number; callTotal: number; loans: number; deals: number; flagged: number };
}

function finish(reg: Register, name: string): LoadedRegister {
  const st = REG.stats(reg);
  return {
    reg, name, readAt: new Date().toISOString(),
    stats: { debt: st.debt, invested: st.invested, callTotal: st.callTotal, loans: st.loans, deals: st.deals, flagged: st.flagged },
  };
}

/** Read a register workbook (.xlsx bytes). */
export async function readRegisterWorkbook(bytes: Uint8Array, name: string): Promise<LoadedRegister> {
  const wb = await XL.readWorkbook(bytes);
  const reg = REG.readRegister(wb) as Register;
  if (!reg.projections) reg.projections = REG.readProjections(wb, reg.issues);
  const hasTables = wb.tables && wb.tables.length;
  if (!hasTables && !reg.loans.length && !reg.termInvestments.length) throw new Error('This doesn’t look like a PWLBtoday deal register: no Loans or Term investments table was found.');
  return finish(reg, name);
}

/** Rebuild a register from its snapshot (the register's own small JSON form). */
export function registerFromSnapshot(snap: unknown, name = 'Example deal register'): LoadedRegister {
  const reg = REG.fromSnapshot(snap) as Register;
  return finish(reg, name);
}
