// The latest signed-off forecast against what has happened since: one answer for Home, Today's
// statement and Forecast vs actual, so they always agree.
import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { trackSignOffs, activeSignOffs, type Tracking } from '../../lib/forecast/signoff';
import type { Arrival } from '../../lib/forecast/early';
import { ymdFromDay, MONTH_NAMES } from '../../lib/dates';

export type { Tracking };

/** One answer for Home, Today's statement and Forecast vs actual (see `trackSignOffs`). */
export function useTracking(): Tracking | null {
  const signed = useActiveSignOffs();
  const chosen = useStore((s) => s.team.settings.trackedSignOff);
  const history = useStore((s) => s.team.cashHistory ?? s.historyBase);
  const categories = useStore((s) => s.team.categories);
  const arrivals = useArrivals();
  return useMemo(() => trackSignOffs(signed, history, categories, chosen, arrivals), [signed, chosen, history, categories, arrivals]);
}

/** Money confirmed as early, on any of your forecasts (each counts once: see `timingAt`). */
export function useArrivals(): Arrival[] {
  const forecasts = useStore((s) => s.team.forecasts);
  return useMemo(() => forecasts.flatMap((f) => f.arrivals ?? []), [forecasts]);
}

/** The sign-offs that count: withdrawn ones left out. */
export function useActiveSignOffs() {
  const signed = useStore((s) => s.team.signedOff);
  const changes = useStore((s) => s.team.signOffChanges);
  return useMemo(() => activeSignOffs(signed, changes), [signed, changes]);
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

/** ", £3.4m of it money that came in early" when timing explains a part worth mentioning; else "". */
export function timingWords(timing: number, money: (x: number) => string): string {
  return Math.abs(timing) < 0.1e6 ? '' : `, ${money(Math.abs(timing))} of it money that ${timing > 0 ? 'came in' : 'went out'} early`;
}
