import { useEffect } from 'react';
import { useStore, StepId, STREAMS, streamOf, streamSteps, type StreamId } from '../state/store';
import { Toasts, Modal } from './components/common';
import { LoadStep } from './steps/LoadStep';
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
import { TeamFileMenu, SettingsMenu } from './components/HeaderMenus';

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
  const { step, team, cat, goto, advanced } = s;

  // Warn before closing with unsaved team-file changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (useStore.getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

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
    if (id === 'history') return goto(cat || s.historyOnly ? 'history' : 'load');
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
        <TeamFileMenu />
        <SettingsMenu />
      </header>

      <main className="main" id="main">
        {current && streamSteps(current, advanced).length > 1 && (
          <div className="streambar">
            {streamSteps(current, advanced).map((x, i) => (
              <button key={x.id} className={x.id === step ? 'on' : ''} disabled={!enabled(x.id)} onClick={() => goto(x.id)} aria-current={x.id === step ? 'step' : undefined}>
                <span className="sb-num">{i + 1}</span>{x.label}
              </button>
            ))}
          </div>
        )}
        {step === 'home' && <HomePage />}
        {step === 'today' && <TodayPage />}
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
    </div>
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
