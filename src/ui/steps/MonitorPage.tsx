// Monitor: signed-off forecasts against what actually happened. Ad hoc, whenever you like; it
// works from the saved history and the sign-offs alone.
import { useStore, defaultSettings } from '../../state/store';
import { PageHead, PracticeNote } from '../components/common';
import { PastCheck } from '../forecast/PastCheck';
import { historyDays, MIN_HISTORY_DAYS } from '../../lib/history/cashHistory';
import type { Scenario } from '../../lib/model';

export function MonitorPage() {
  const { team, historyBase, activeScenarioId, goto } = useStore();
  const h = team.cashHistory ?? historyBase;
  // the method test uses your forecast's settings, or the defaults before you have one
  const sc: Scenario = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0]
    ?? { id: 'default', name: 'Default', updatedAt: '', settings: defaultSettings(null), assumptions: [], oneOffs: [], pastedSchedules: [], treasurySchedule: [] };
  return (
    <div className="page">
      <PageHead title="Forecast vs actual">Signed-off forecasts against what actually happened, to the latest statement.</PageHead>
      {historyDays(h) < MIN_HISTORY_DAYS
        ? <div className="callout navy small">This needs your bank history first. <button className="link-btn" onClick={() => goto('history')}>Load it under History</button>.</div>
        : <>{useStore.getState().space === 'example' && <PracticeNote>The example’s treasury team signed off two forecasts in the past year. Yours joins them, and is compared as each new statement comes in.</PracticeNote>}<PastCheck sc={sc} /></>}
    </div>
  );
}
