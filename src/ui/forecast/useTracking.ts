// The latest signed-off forecast against what has happened since: one answer for Home, Today's
// statement and Forecast vs actual, so they always agree.
import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { compareSigned, monthEndIndex, MIN_COMPARE_DAYS, type SignedForecast } from '../../lib/forecast/signoff';
import type { BacktestResult } from '../../lib/forecast/backtest';
import { ymdFromDay, MONTH_NAMES } from '../../lib/dates';

export type Tracking =
  // `asOf` is the latest month end compared (or the latest day, `soFar`, before the first one)
  | { rec: SignedForecast; r: BacktestResult; gap: number; asOf: number; soFar: boolean }
  | { rec: SignedForecast; r: null };

/** The newest sign-off with a month or more of actuals, read at the latest month end; else the newest one, still waiting. */
export function useTracking(): Tracking | null {
  const signed = useStore((s) => s.team.signedOff);
  const history = useStore((s) => s.team.cashHistory ?? s.historyBase);
  const categories = useStore((s) => s.team.categories);
  return useMemo(() => {
    const list = [...(signed ?? [])].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
    if (!list.length || !history) return null;
    // the newest with at least a month of actuals to judge it by; else the newest, still too early
    const compared = list.map((rec) => ({ rec, r: compareSigned(rec, history, categories) }));
    const pick = compared.find((x) => x.r && x.r.H >= MIN_COMPARE_DAYS);
    if (!pick) return { rec: list[0], r: null };
    const r = pick.r!, me = monthEndIndex(r), d = me ?? r.H - 1;
    return { rec: pick.rec, r, gap: r.actualCum[d] - r.forecastCum[d], asOf: r.cutoff + d, soFar: me === null };
  }, [signed, history, categories]);
}

/** "£11.2m ahead of" / "£3.0m behind" / "in line with": everyday cash against the signed-off forecast. */
export function aheadWords(gap: number, money: (x: number) => string): string {
  return Math.abs(gap) < 0.5e6 ? 'in line with' : gap > 0 ? `${money(gap)} ahead of` : `${money(-gap)} behind`;
}

/** "at the end of Mar 2026", or "so far (to 12 Oct 2025)" before the first month end. */
export function asOfWords(t: { asOf: number; soFar: boolean }): string {
  const { y, m, d } = ymdFromDay(t.asOf);
  return t.soFar ? `so far (to ${d} ${MONTH_NAMES[m - 1]} ${y})` : `at the end of ${MONTH_NAMES[m - 1]} ${y}`;
}
