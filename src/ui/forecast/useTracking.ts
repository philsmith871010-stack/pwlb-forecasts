// The latest signed-off forecast against what has happened since: one answer for Home, Today's
// statement and Forecast vs actual, so they always agree.
import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { compareSigned, type SignedForecast } from '../../lib/forecast/signoff';
import type { BacktestResult } from '../../lib/forecast/backtest';

export type Tracking =
  | { rec: SignedForecast; r: BacktestResult; gap: number; asOf: number }
  | { rec: SignedForecast; r: null };

/** The newest sign-off with actuals to compare; else the newest one, still waiting for them. */
export function useTracking(): Tracking | null {
  const signed = useStore((s) => s.team.signedOff);
  const history = useStore((s) => s.team.cashHistory ?? s.historyBase);
  const categories = useStore((s) => s.team.categories);
  return useMemo(() => {
    const list = [...(signed ?? [])].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
    if (!list.length || !history) return null;
    for (const rec of list) {
      const r = compareSigned(rec, history, categories);
      if (r) return { rec, r, gap: r.actualCum[r.H - 1] - r.forecastCum[r.H - 1], asOf: r.end };
    }
    return { rec: list[0], r: null };
  }, [signed, history, categories]);
}

/** "£11.2m ahead of" / "£3.0m behind" / "in line with": everyday cash against the signed-off forecast. */
export function aheadWords(gap: number, money: (x: number) => string): string {
  return Math.abs(gap) < 0.5e6 ? 'in line with' : gap > 0 ? `${money(gap)} ahead of` : `${money(-gap)} behind`;
}
