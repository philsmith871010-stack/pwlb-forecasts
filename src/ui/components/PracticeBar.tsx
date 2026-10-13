// The example council's practice run: where you are in the eight steps, what to do on this screen,
// and the way to the next step. About five minutes end to end.
import { useStore, expectedStatementDay, streamOf, STREAMS, type StepId, type StreamId } from '../../state/store';
import { ToMenu } from './common';
import { historyDays, historySpan, MIN_HISTORY_DAYS } from '../../lib/history/cashHistory';

/** `then`: for a step that's just a look, the way on from it */
interface PStep { label: string; area: StreamId; hint: string; done: boolean; at: (step: StepId, tab: string) => boolean; go: () => void; then?: { label: string; area: StreamId; go: () => void } }

/** The practice run's steps, and the next one to do. Home uses it too, so both always agree. */
export function usePractice() {
  const { team, historyBase, practiceSeen, stepTab, goto, setStepTab, advanced } = useStore();
  const fcKey = advanced ? 'forecast' : 'forecast-simple';
  const fcTab = stepTab[fcKey] ?? 'lines';
  const toTab = (tab: string) => () => { setStepTab(fcKey, tab); goto('forecast'); };
  const h = team.cashHistory ?? historyBase;
  const span = h ? historySpan(h) : null;
  const seen = (k: string) => practiceSeen.includes(k);
  const steps: PStep[] = [
    { label: 'Load the history', area: 'setup', hint: 'Click the box: it picks the example’s statement files, as choosing yours would. Then Read my files.', done: historyDays(h) >= MIN_HISTORY_DAYS, at: (st) => st === 'load', go: () => goto('load') },
    { label: 'Check the sorting', area: 'setup', hint: 'Save an item or two, or accept all our best guesses in one click (each choice is remembered for next time). Then back to the main menu.', done: seen('left:setup') || seen('history') || seen('forecast'), at: (st) => st === 'review', go: () => goto('review') },
    { label: 'Look back', area: 'review', hint: 'How the council’s cash has behaved, year by year: the pattern the forecast builds on.', done: seen('left:review') || seen('forecast'), at: (st) => st === 'history', go: () => goto('history'), then: { label: 'On to the forecast', area: 'forecast', go: toTab('lines') } },
    { label: 'Check the forecast', area: 'forecast', hint: 'Open a line or two to see how it’s worked out (change one if you like), then Accept all.', done: team.forecasts.some((f) => f.reviewDone), at: (st, t) => st === 'forecast' && t === 'lines', go: toTab('lines') },
    { label: 'See the forecast and sign it off', area: 'forecast', hint: 'When the council may need to borrow, and how much. Happy with it? Sign it off: it’s kept as it stands and checked against what happens.', done: (team.signedOff ?? []).some((x) => !x.id.startsWith('so_example_')), at: (st, t) => st === 'forecast' && t === 'result', go: toTab('result') },
    { label: 'What you could do', area: 'forecast', hint: fcTab === 'report' ? 'The board report, ready to print or save as PDF, and Excel with every number.' : 'Borrowing options from the forecast and the deal register, to take to your treasury meeting.', done: (seen('fc:options') && seen('left:forecast')) || seen('today') || seen('monitor'), at: (st, t) => st === 'forecast' && (t === 'options' || t === 'report'), go: toTab('options'),
      then: fcTab === 'report' ? { label: 'On to today’s statement', area: 'today', go: () => goto('today') } : { label: 'See the board report', area: 'forecast', go: toTab('report') } },
    { label: 'Today’s statement', area: 'today', hint: 'Click the box: it picks the next day’s statement, as dropping yours would. Sorted in seconds, and anything unusual is raised under Exceptions: try checking one.', done: !!span && span.to >= expectedStatementDay('example'), at: (st) => st === 'today', go: () => goto('today') },
    { label: 'Forecast vs actual', area: 'monitor', hint: 'Signed-off forecasts against what actually happened.', done: seen('monitor'), at: (st) => st === 'monitor', go: () => goto('monitor') },
  ];
  const i = steps.findIndex((x) => !x.done);
  return { steps, next: i >= 0 ? steps[i] : null, n: i >= 0 ? i + 1 : steps.length, fcTab, toTab };
}

export function PracticeBar() {
  const s = useStore();
  const { step, goto, space } = s;
  const { steps, next, n, fcTab } = usePractice();
  if (space !== 'example' || step === 'home') return null;
  const here = next?.at(step, fcTab);
  // steps in another area are reached through the main menu
  const area = streamOf(step)?.id;
  const elsewhere = !!next && next.area !== area;
  const areaName = (id: StreamId) => STREAMS.find((x) => x.id === id)!.label;
  return (
    <div className="practice-bar" role="region" aria-label="Practice run">
      <span className="pb-title"><i className="bi bi-mortarboard" /> Practice run</span>
      <span className="pb-dots" aria-label={`step ${n} of ${steps.length}`}>
        {steps.map((x, i) => <span key={i} className={x.done ? 'done' : x === next ? 'next' : ''} title={x.label} />)}
      </span>
      {next ? (
        <>
          <span className="pb-step"><strong>{n} of {steps.length}: {next.label}{elsewhere ? <>, under {areaName(next.area)}</> : ''}.</strong> <span className="pb-hint">{here ? next.hint : elsewhere ? 'Done here: go back to the main menu to open it.' : ''}</span></span>
          {elsewhere ? <ToMenu primary />
            : !here ? <button className="btn sm primary" onClick={next.go}>Go <i className="bi bi-arrow-right" /></button>
            : next.then && (next.then.area === area ? <button className="btn sm primary" onClick={next.then.go}>{next.then.label} <i className="bi bi-arrow-right" /></button> : <ToMenu primary label={`Back to main menu: ${areaName(next.then.area)} next`} />)}
        </>
      ) : (
        <>
          <span className="pb-step"><strong>Done: that’s the whole cycle.</strong> <span className="pb-hint">Your own council works the same way.</span></span>
          <ToMenu />
          <button className="btn sm primary" onClick={() => void s.switchWorkspace('mine').then(() => goto('home'))}>Start with my council <i className="bi bi-arrow-right" /></button>
        </>
      )}
    </div>
  );
}
