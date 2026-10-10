// Home inside the app: the three jobs, for your council or the example council.
import { useStore } from '../../state/store';
import { historySpan, MIN_HISTORY_DAYS } from '../../lib/history/cashHistory';
import { day } from '../../lib/format';
import { ymdFromDay, MONTH_NAMES } from '../../lib/dates';

const monthOf = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };

export function JobsPage() {
  const { goto, team, historyBase, space, switchWorkspace, exampleBusy, register } = useStore();
  // the saved history including anything added this session
  const saved = team.cashHistory ?? historyBase;
  const span = saved ? historySpan(saved) : null;
  const days = span ? span.to - span.from + 1 : 0;
  const years = Math.round((days / 365.25) * 2) / 2;
  const enough = days >= MIN_HISTORY_DAYS;
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
              <button className={`job ${span ? 'ready' : 'waiting'}`} onClick={() => goto('today')}>
                <i className="bi bi-calendar-day" />
                <strong>Today’s statement</strong>
                <span>Sort today’s bank statement in seconds.</span>
                <em>{span ? `Saved up to ${day(span.to)}` : 'Works best once your history is loaded'}</em>
              </button>
              <button className={`job ${enough ? 'ready' : 'start'}`} onClick={() => goto('history')}>
                {!enough && <b className="job-flag">Start here</b>}
                <i className="bi bi-bar-chart-line" />
                <strong>History</strong>
                <span>Load years of statements and see how your cash behaves.</span>
                <em>{!span ? 'Three to five years of statements' : years >= 1 ? `${years.toLocaleString('en-GB')} years saved, ${monthOf(span.from)} to ${monthOf(span.to)}` : `${days} day${days === 1 ? '' : 's'} saved: add past years to see patterns`}</em>
              </button>
              <button className={`job ${checked || enough ? 'ready' : 'waiting'}`} onClick={() => goto('forecast')}>
                <i className="bi bi-graph-up-arrow" />
                <strong>Forecast</strong>
                <span>See when you’d need to borrow, and your options.</span>
                <em>{checked && enough ? `“${checked.name}” checked` : enough ? 'Ready to build' : register ? 'Deal register loaded' : 'Needs your history first'}</em>
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
