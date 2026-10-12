// The latest signed-off forecast against what has happened since: one answer for Home, Today's
// statement and Forecast vs actual, so they always agree.
import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { trackSignOffs, activeSignOffs, aheadWords, asOfWords, type Tracking } from '../../lib/forecast/signoff';

export { aheadWords, asOfWords };
import type { Arrival } from '../../lib/forecast/early';

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

/** ", £3.4m of it money that came in early" when timing explains a part worth mentioning; else "". */
export function timingWords(timing: number, money: (x: number) => string): string {
  return Math.abs(timing) < 0.1e6 ? '' : `, ${money(Math.abs(timing))} of it money that ${timing > 0 ? 'came in' : 'went out'} early`;
}
