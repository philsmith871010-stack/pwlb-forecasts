// Home inside the app: the four jobs in the order they depend on each other, and the one thing to
// do next. For your council or the example council.
import { useStore, expectedStatementDay, type StepId } from '../../state/store';
import { historySpan, MIN_HISTORY_DAYS } from '../../lib/history/cashHistory';
import { day, money } from '../../lib/format';
import { useTracking, aheadWords, asOfWords } from '../forecast/useTracking';
import { usePractice } from '../components/PracticeBar';
import { ymdFromDay, dayFromISO, MONTH_NAMES } from '../../lib/dates';

const monthOf = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };
/** More than this many days behind, catching up is a job for History, not Today's statement. */
const CATCH_UP_DAYS = 14;

type Status = 'done' | 'next' | 'todo' | 'waiting';
interface Job { id: StepId; n: number; icon: string; title: string; what: string; status: Status; note: string }

export function JobsPage() {
  const { goto, team, historyBase, space, switchWorkspace, exampleBusy, askConfirm, forgetWorkspace } = useStore();
  const restart = async () => {
    if (await askConfirm({ title: 'Start the practice again?', body: 'The example council goes back to the start, with no history or forecasts, so you can go through every step again. Your own council isn’t affected.', ok: 'Start again' })) { forgetWorkspace(); goto('home'); }
  };
  const tr = useTracking();
  const example = space === 'example';

  // ---- where this council is
  const saved = team.cashHistory ?? historyBase;
  const span = saved ? historySpan(saved) : null;
  const days = span ? span.to - span.from + 1 : 0;
  const years = Math.round((days / 365.25) * 2) / 2;
  const enough = days >= MIN_HISTORY_DAYS;
  const expected = expectedStatementDay(space);
  const behind = span ? Math.max(0, expected - span.to) : 0;
  const upToDate = !!span && behind === 0;
  // in the example, only your own sign-offs count as yours (its treasury team's are for comparing)
  const signed = [...(team.signedOff ?? [])].filter((x) => !example || !x.id.startsWith('so_example_')).sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  const latest = signed[0];

  // ---- the one thing to do next
  // the example: its practice run decides what's next
  const pr = usePractice();
  const prJob: StepId[] = ['history', 'history', 'history', 'forecast', 'forecast', 'forecast', 'today', 'monitor'];
  const practiceNext = example && pr.next ? { id: prJob[pr.n - 1], title: `${pr.n} of ${pr.steps.length}: ${pr.next.label}`, why: pr.next.hint, cta: 'Go', go: pr.next.go } : null;
  const next: { id: StepId; title: string; why: string; cta: string; go?: () => void } = practiceNext ??
    (!enough ? { id: 'history', title: 'Load your bank history', why: 'Three to five years of bank statements. The forecast learns your council’s patterns from them, and everything else builds on them.', cta: 'Load bank statements' }
    : behind > CATCH_UP_DAYS ? { id: 'history', title: `Catch up from ${day(span!.to + 1)}`, why: `Your history stops ${behind} days ago. Add the statements since then under History, so the forecast starts from where you are.`, cta: 'Add statements' }
    : !latest ? { id: 'forecast', title: 'Build your forecast and sign it off', why: 'Check each line we propose, add anything you know is coming, then sign it off. Signed-off forecasts are what you monitor against.', cta: 'Build the forecast' }
    : !upToDate ? { id: 'today', title: 'Add today’s statement', why: `Your history runs to ${day(span!.to)}. Drop in the latest statement: it’s sorted in seconds and checked against your signed-off forecast.`, cta: 'Add today’s statement' }
    : { id: 'monitor', title: 'You’re up to date', why: tr?.r ? `Everyday cash was ${aheadWords(tr.gap, money)} the signed-off “${tr.rec.scenarioName}” ${asOfWords(tr)}.` : `“${latest.scenarioName}” is signed off. It’s compared with what happens as statements come in.`, cta: 'See forecast vs actual' });

  // ---- the four jobs, in order
  // the example: a job is done when its practice steps are
  const practiceDone = (id: StepId) => pr.steps.every((x, k) => prJob[k] !== id || x.done);
  const status = (id: StepId, done: boolean, waiting = false): Status => (next.id === id ? 'next' : (example ? practiceDone(id) : done) ? 'done' : waiting && !example ? 'waiting' : 'todo');
  const jobs: Job[] = [
    { id: 'history', n: 1, icon: 'bi-bar-chart-line', title: 'History', what: 'Learn from years of bank statements.',
      status: status('history', enough && behind <= CATCH_UP_DAYS),
      note: !span ? 'Start here: three to five years' : enough ? `${years.toLocaleString('en-GB')} years, ${monthOf(span.from)} to ${monthOf(span.to)}` : `${days} day${days === 1 ? '' : 's'} so far: add past years` },
    { id: 'forecast', n: 2, icon: 'bi-graph-up-arrow', title: 'Forecast', what: 'Build it, check it, sign it off.',
      status: status('forecast', !!latest, !enough),
      note: latest ? `“${latest.scenarioName}” signed off ${day(dayFromISO(latest.signedAt.slice(0, 10)))}` : enough ? 'Not signed off yet' : 'Needs your history first' },
    { id: 'today', n: 3, icon: 'bi-calendar-day', title: 'Today’s statement', what: 'Each day: sort it and add it to your history.',
      status: status('today', upToDate, !span),
      note: upToDate ? `Up to date: ${day(span!.to)}` : span ? `Last statement ${day(span.to)}` : 'Once your history is loaded' },
    { id: 'monitor', n: 4, icon: 'bi-activity', title: 'Monitor', what: 'Signed-off forecasts against what happened.',
      status: status('monitor', !!tr?.r, !latest),
      note: tr?.r ? `${aheadWords(tr.gap, money).replace(/^./, (c) => c.toUpperCase())} “${tr.rec.scenarioName}” ${asOfWords(tr)}` : latest ? 'Waiting for statements after it' : 'After your first sign-off' },
  ];

  return (
    <div className="jobs-page">
      <section className="home-hero compact">
        <div className="home-hero-inner">
          <div className="space-switch big" role="tablist" aria-label="Whose cash">
            <button role="tab" aria-selected={!example} className={!example ? 'on' : ''} onClick={() => void switchWorkspace('mine')}><i className="bi bi-building" /> Your council</button>
            <button role="tab" aria-selected={example} className={example ? 'on' : ''} onClick={() => void switchWorkspace('example')}><i className="bi bi-stars" /> Example council</button>
          </div>
          <h1 className="jobs-title">{example ? 'Northbridge Council (example)' : team.authorityName === 'My Council' ? 'Your council’s cash' : team.authorityName}</h1>
          {example && <p className="home-lead">A practice run on a made-up council: eight short steps, about five minutes, exactly as with your own. Wherever you’d choose a file, a click picks the example’s. Your own council’s work isn’t touched.{' '}
            {(span || latest) && <button className="link-btn on-dark" onClick={() => void restart()}>Start the practice again</button>}</p>}
          {exampleBusy ? (
            <div className="jobs-busy"><span className="spinner" /> Setting up the example council: five years of statements, sorted…</div>
          ) : (
            <>
              <button className="next-step" onClick={() => (next.go ? next.go() : goto(next.id))}>
                <span className="ns-label">{practiceNext ? <><i className="bi bi-mortarboard" /> Practice run</> : next.id === 'monitor' ? <><i className="bi bi-check-circle-fill" /> All set</> : 'Next step'}</span>
                <strong>{next.title}</strong>
                <span className="ns-why">{next.why}</span>
                <span className="btn primary lg">{next.cta} <i className="bi bi-arrow-right" /></span>
              </button>
              {!example && !span && <p className="jobs-try">New here? <button className="link-btn on-dark" onClick={() => void switchWorkspace('example')}>Try the example council first</button>: about five minutes, no files needed, every step just as with your own.</p>}
              <div className="jobs four">
                {jobs.map((j) => (
                  <button key={j.id} className={`job ${j.status}`} onClick={() => goto(j.id)}>
                    <span className="job-top"><span className="job-n">{j.status === 'done' ? <i className="bi bi-check-lg" /> : j.n}</span><i className={`bi ${j.icon}`} /></span>
                    <strong>{j.title}</strong>
                    <span>{j.what}</span>
                    <em>{j.note}</em>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
