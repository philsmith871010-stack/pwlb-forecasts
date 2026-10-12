// The five areas' state for the main menu and each area's header (the rules are in lib/areas).
import { useStore, expectedStatementDay } from '../state/store';
import { useTracking, useActiveSignOffs } from './forecast/useTracking';
import { computeAreas, type AreaState, type AreaId } from '../lib/areas';

export type { AreaState, AreaId };

export function useAreas(): { areas: AreaState[]; next: AreaId } {
  const { team, historyBase, space } = useStore();
  const tracking = useTracking();
  const active = useActiveSignOffs();
  return computeAreas({ history: team.cashHistory ?? historyBase, expected: expectedStatementDay(space), forecasts: team.forecasts, rules: team.rules, active, tracking });
}
