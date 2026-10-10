// Home inside the app: the three jobs, for your council or the example council.
import { useStore } from '../../state/store';
import { historySpan } from '../../lib/history/cashHistory';
import { day, int } from '../../lib/format';

export function JobsPage() {
  const { goto, team, ingest, cat, historyOnly, historyBase, basis, space, switchWorkspace, exampleBusy } = useStore();
  const span = historyBase ? historySpan(historyBase) : null;
  const checked = team.forecasts.find((f) => f.reviewDone);
  const example = space === 'example';
  return (
    <div className="jobs-page">
      <section className="home-hero compact">
        <div className="home-hero-inner">
          <div className="space-switch big" role="tablist" aria-label="Whose cash">
            <button role="tab" aria-selected={!example} className={!example ? 'on' : ''} onClick={() => void switchWorkspace('mine')}><i className="bi bi-building" /> Your council</button>
            <button role="tab" aria-selected={example} className={example ? 'on' : ''} onClick={() => void switchWorkspace('example')}><i className="bi bi-stars" /> Example council</button>
          </div>
          <h1 className="jobs-title">{example ? 'Northbridge Council (example)' : team.authorityName === 'My Council' ? 'What would you like to do?' : team.authorityName}</h1>
          <p className="home-lead">{example
            ? 'A made-up council with five years of history, ready to try every job. Nothing you do here touches your own council’s work.'
            : span ? 'Pick up where you left off. Everything is saved in this browser as you go.' : 'Start with History the first time: load a few years of bank statements. Everything is saved in this browser as you go.'}</p>
          {exampleBusy ? (
            <div className="jobs-busy"><span className="spinner" /> Setting up the example council: five years of statements, sorted…</div>
          ) : (
            <div className="jobs">
              <button className="job" onClick={() => goto('today')}>
                <i className="bi bi-calendar-day" />
                <strong>Today’s statement</strong>
                <span>Sort today’s bank statement in seconds.</span>
                <em>{span ? `History saved to ${day(span.to)}` : 'Works best once your history is loaded'}</em>
              </button>
              <button className="job" onClick={() => goto(cat || historyOnly ? 'history' : 'load')}>
                <i className="bi bi-bar-chart-line" />
                <strong>History</strong>
                <span>Load years of statements and see how your cash behaves.</span>
                <em>{cat ? `${int(ingest?.rows ?? 0)} bank lines loaded` : span ? `Saved: ${day(span.from)} to ${day(span.to)}` : 'Start here the first time'}</em>
              </button>
              <button className="job" onClick={() => goto('forecast')}>
                <i className="bi bi-graph-up-arrow" />
                <strong>Forecast</strong>
                <span>See when you’d need to borrow, and your options.</span>
                <em>{checked ? `“${checked.name}” checked` : basis || span ? 'Ready to build' : 'Needs your history first'}</em>
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
