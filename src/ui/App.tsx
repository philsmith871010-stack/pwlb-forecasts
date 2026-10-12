import { useEffect, useState } from 'react';
import { useStore, StepId, STREAMS, streamOf, streamSteps, type StreamId } from '../state/store';
import { Toasts, Modal } from './components/common';
import { LoadStep } from './steps/LoadStep';
import { MonitorPage } from './steps/MonitorPage';
import { PracticeBar } from './components/PracticeBar';
import { MappingStep } from './steps/MappingStep';
import { CategoriseStep } from './steps/CategoriseStep';
import { ReviewStep } from './steps/ReviewStep';
import { HistoryStep } from './steps/HistoryStep';
import { ForecastStep } from './steps/ForecastStep';
import { BacktestStep } from './steps/BacktestStep';
import { SaveStep } from './steps/SaveStep';
import { DataWorkspace } from './steps/DataWorkspace';
import { SettingsView } from './steps/SettingsView';
import { HomePage } from './steps/HomePage';
import { TodayPage } from './steps/TodayPage';
import { SpaceSwitch, SettingsMenu } from './components/HeaderMenus';
import { JobsPage } from './steps/JobsPage';

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="18" width="5" height="10" rx="1.2" fill="#0a2540" />
      <rect x="11.5" y="13" width="5" height="15" rx="1.2" fill="#143659" />
      <rect x="19" y="8" width="5" height="20" rx="1.2" fill="#1a4775" />
      <path d="M3 13.5 L12 7.5 L17 10 L28 3" stroke="#fd7e14" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23.5 3 H28 V7.5" stroke="#fd7e14" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function App() {
  const s = useStore();
  const { step, team, cat, goto, advanced, space } = s;

  // the landing page comes first, on its own; one click enters the app
  if (!s.entered) return <div className="landing-shell"><HomePage /><Toasts /></div>;

  const enabled = (id: StepId) => {
    if (id === 'load' || id === 'save' || id === 'today' || id === 'home' || id === 'settings') return true;
    if (id === 'map') return s.sources.length > 0;
    if (id === 'history' || id === 'forecast') return !!cat || !!s.basis || team.forecasts.some((f) => f.resultsSnapshot) || !!team.historySummary || id === 'forecast';
    if (id === 'backtest' || id === 'categorise' || id === 'review' || id === 'data') return !!cat;
    return true;
  };
  const current = streamOf(step);
  // where each job opens: wherever it makes sense given what's loaded
  const openStream = (id: StreamId) => {
    if (id === 'today') return goto('today');
    if (id === 'history') return goto('history');
    if (id === 'monitor') return goto('monitor');
    return goto('forecast');
  };

  return (
    <div className="shell top">
      <header className="shell-header">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); goto('home'); }} aria-label="Cash Flow Insight home">
          <Logo /><span className="brand-word">Cash Flow <span>Insight</span></span>
        </a>
        <nav className="topnav" aria-label="Main menu">
          <button className={step === 'home' ? 'on' : ''} onClick={() => goto('home')}><i className="bi bi-house" /> <span>Home</span></button>
          {STREAMS.map((st) => (
            <button key={st.id} className={current?.id === st.id ? 'on' : ''} onClick={() => openStream(st.id)} aria-current={current?.id === st.id ? 'page' : undefined}>
              <i className={`bi ${st.icon}`} /> <span>{st.label}</span>
            </button>
          ))}
        </nav>
        <div className="header-spacer" />
        <span className="privacy-dot" title="Everything happens in this browser tab. Nothing is uploaded."><i className="bi bi-shield-lock-fill" /></span>
        {step !== 'home' && <SpaceSwitch />}
        {step !== 'home' && space === 'example' && <span className="example-tag" title="You’re in the example council">Example</span>}
        <SettingsMenu />
      </header>

      <main className="main" id="main">
        <PracticeBar />
        {current && streamSteps(current, advanced).length > 1 && (
          <div className="streambar">
            {streamSteps(current, advanced).map((x, i) => (
              <button key={x.id} className={x.id === step ? 'on' : ''} disabled={!enabled(x.id)} onClick={() => goto(x.id)} aria-current={x.id === step ? 'step' : undefined}>
                <span className="sb-num">{i + 1}</span>{x.label}
              </button>
            ))}
          </div>
        )}
        {step === 'home' && <JobsPage />}
        {step === 'today' && <TodayPage />}
        {step === 'monitor' && <MonitorPage />}
        {step === 'load' && <LoadStep />}
        {step === 'map' && <MappingStep />}
        {step === 'categorise' && <CategoriseStep />}
        {step === 'review' && <ReviewStep />}
        {step === 'history' && <HistoryStep />}
        {step === 'forecast' && <ForecastStep />}
        {step === 'backtest' && <BacktestStep />}
        {step === 'save' && <SaveStep />}
        {step === 'data' && <DataWorkspace />}
        {step === 'settings' && <SettingsView />}
      </main>
      <Toasts />
      <MergeDialog />
      <ConfirmDialog />
    </div>
  );
}

/** The app's own "are you sure?" (browser pop-ups can be blocked, e.g. in embedded browsers). */
function ConfirmDialog() {
  const box = useStore((s) => s.confirmBox);
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setV(box?.input?.value ?? ''); setNote(''); }, [box]);
  if (!box) return null;
  const ok = () => { if (box.input) box.input.onValue(v.trim()); if (box.note) box.note.onValue(note.trim()); box.resolve(true); };
  return (
    <Modal title={box.title} onClose={() => box.resolve(false)}
      footer={<><button className="btn" onClick={() => box.resolve(false)}>Cancel</button>
        <button className={`btn ${box.danger ? 'danger' : 'primary'}`} autoFocus={!box.input} disabled={!!box.input && !v.trim()} onClick={ok}>{box.ok}</button></>}>
      <p style={{ margin: 0 }}>{box.body}</p>
      {box.input && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="confirm-input">{box.input.label}</label>
          <input id="confirm-input" className="input" autoFocus value={v} placeholder={box.input.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) ok(); }} />
        </div>
      )}
      {box.note && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="confirm-note">{box.note.label} <span className="muted">(optional)</span></label>
          <input id="confirm-note" className="input" value={note} placeholder={box.note.placeholder} maxLength={200} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (!box.input || v.trim())) ok(); }} />
        </div>
      )}
    </Modal>
  );
}

function MergeDialog() {
  const ms = useStore((s) => s.mergeState);
  const resolve = useStore((s) => s.resolveMerge);
  const choose = useStore((s) => s.setMergeChoice);
  if (!ms) return null;
  return (
    <Modal title="The team file changed since you opened it" onClose={() => void resolve(false)} wide
      footer={<><button className="btn" onClick={() => void resolve(false)}>Cancel</button><button className="btn primary" onClick={() => void resolve(true)}><i className="bi bi-intersect" /> Merge and save</button></>}>
      <p>Someone else saved <strong>{ms.theirs.savedBy || 'a colleague'}</strong>’s version at {new Date(ms.theirs.savedAt).toLocaleString('en-GB')}. Rather than overwrite it, we’ll combine both: rules, aliases, bank profiles and forecasts from both copies are kept.</p>
      {ms.summary.length > 0 && <div className="callout green mb">{ms.summary.join('; ')}.</div>}
      {ms.conflicts.length === 0 ? <div className="callout navy">No conflicts — nothing was edited in both copies.</div> : (
        <>
          <h4>{ms.conflicts.length} item{ms.conflicts.length > 1 ? 's were' : ' was'} edited in both copies — choose which to keep</h4>
          <table className="tbl">
            <thead><tr><th>Type</th><th>Item</th><th>Keep</th></tr></thead>
            <tbody>
              {ms.conflicts.map((c) => {
                const k = `${c.kind}:${c.id}`;
                return (
                  <tr key={k}>
                    <td>{c.kind}</td><td>{c.label}</td>
                    <td><div className="seg">
                      <button className={ms.resolve[k] === 'mine' ? 'on' : ''} onClick={() => choose(k, 'mine')}>Mine</button>
                      <button className={ms.resolve[k] === 'theirs' ? 'on' : ''} onClick={() => choose(k, 'theirs')}>Theirs</button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
