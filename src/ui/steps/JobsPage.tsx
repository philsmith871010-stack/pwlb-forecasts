// The main menu: the five areas in the order they depend on each other, each with its state, and
// the one to open next. It's the only way between areas: each is entered here and left by coming
// back. Areas that can't be used yet are locked and say what they're waiting for.
import { useStore, STREAMS } from '../../state/store';
import { usePractice } from '../components/PracticeBar';
import { useAreas, type AreaState } from '../areas';

const TONE_LABEL: Record<AreaState['tone'], string> = { done: 'Done', action: 'To do', waiting: 'Waiting', ready: 'Ready', locked: 'Locked' };
const TONE_ICON: Record<AreaState['tone'], string> = { done: 'bi-check-circle-fill', action: 'bi-arrow-right-circle-fill', waiting: 'bi-hourglass-split', ready: 'bi-circle', locked: 'bi-lock-fill' };

export function JobsPage() {
  const { goto, team, space, switchWorkspace, exampleBusy, askConfirm, forgetWorkspace } = useStore();
  const { areas, next } = useAreas();
  const pr = usePractice();
  const example = space === 'example';
  const restart = async () => {
    if (await askConfirm({ title: 'Start the practice again?', body: 'The example council goes back to the start, with no history or forecasts, so you can go through every step again. Your own council isn’t affected.', ok: 'Start again' })) { forgetWorkspace(); goto('home'); }
  };
  const open = (a: AreaState) => { if (!a.locked) goto(a.entry); };
  const nextArea = areas.find((a) => a.id === next)!;
  const nextStream = STREAMS.find((s) => s.id === next)!;
  // the example: its practice run decides what's next
  const practiceNext = example && pr.next ? pr.next : null;
  const highlight = practiceNext ? practiceNext.area : next;
  const started = areas[0].tone !== 'action' || areas[0].status !== 'Not started';

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
            {started && <button className="link-btn on-dark" onClick={() => void restart()}>Start the practice again</button>}</p>}
          {exampleBusy ? (
            <div className="jobs-busy"><span className="spinner" /> Setting up the example council: five years of statements, sorted…</div>
          ) : (
            <>
              {practiceNext ? (
                <button className="next-step" onClick={practiceNext.go}>
                  <span className="ns-label"><i className="bi bi-mortarboard" /> Practice run · {pr.n} of {pr.steps.length} · in {STREAMS.find((s) => s.id === practiceNext.area)!.label}</span>
                  <strong>{practiceNext.label}</strong>
                  <span className="ns-why">{practiceNext.hint}</span>
                  <span className="btn primary lg">Go <i className="bi bi-arrow-right" /></span>
                </button>
              ) : (
                <button className="next-step" onClick={() => open(nextArea)}>
                  <span className="ns-label">{nextArea.tone === 'action' ? 'Next' : <><i className="bi bi-check-circle-fill" /> All up to date</>}</span>
                  <strong>{nextStream.label}: {nextArea.status}</strong>
                  <span className="ns-why">{nextArea.detail}</span>
                  <span className="btn primary lg">Open {nextStream.label} <i className="bi bi-arrow-right" /></span>
                </button>
              )}
              {!example && !started && <p className="jobs-try">New here? <button className="link-btn on-dark" onClick={() => void switchWorkspace('example')}>Try the example council first</button>: about five minutes, no files needed, every step just as with your own.</p>}
              <div className="jobs five" role="list" aria-label="Areas">
                {areas.map((a, i) => {
                  const st = STREAMS.find((s) => s.id === a.id)!;
                  return (
                    <button key={a.id} role="listitem" className={`job ${a.tone} ${a.id === highlight && !a.locked ? 'next' : ''}`} disabled={!!a.locked} onClick={() => open(a)}
                      aria-label={`${st.label}: ${a.locked ? `locked. ${a.locked}` : `${a.status}. ${a.detail}`}`}>
                      <span className="job-top"><span className="job-n">{i + 1}</span><i className={`bi ${st.icon}`} /></span>
                      <strong>{st.label}</strong>
                      <span>{st.what}</span>
                      <span className={`job-state ${a.tone}`}><i className={`bi ${TONE_ICON[a.tone]}`} /> {TONE_LABEL[a.tone]}{a.locked ? '' : `: ${a.status}`}</span>
                      <em>{a.locked ?? a.detail}</em>
                    </button>
                  );
                })}
              </div>
              {example && (
                <ol className="practice-list" aria-label="Practice run">
                  {pr.steps.map((x, k) => (
                    <li key={k} className={x.done ? 'done' : x === pr.next ? 'next' : ''}>
                      <i className={`bi ${x.done ? 'bi-check-circle-fill' : x === pr.next ? 'bi-arrow-right-circle-fill' : 'bi-circle'}`} /> {x.label}
                      <span className="muted"> · {STREAMS.find((s) => s.id === x.area)!.short}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
