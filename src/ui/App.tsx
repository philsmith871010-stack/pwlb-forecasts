import { useEffect } from 'react';
import { useStore, stepsFor, SIMPLE_STEPS, StepId } from '../state/store';
import { APP_NAME_PARTS, APP_TAGLINE } from '../config';
import { Toasts, Modal } from './components/common';
import { ago } from '../lib/format';
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
  const { step, reached, team, dirty, cat, ingest, goto, advanced } = s;
  const steps = stepsFor(advanced);

  // Warn before closing with unsaved team-file changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (useStore.getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const stepIndex = steps.findIndex((x) => x.id === step);
  const enabled = (id: StepId) => {
    if (id === 'load') return true;
    if (id === 'map') return s.sources.length > 0;
    if (id === 'save') return true;
    if ((id === 'history' || id === 'forecast') && !cat) return team.forecasts.some((f) => f.resultsSnapshot) || !!team.historySummary;
    return !!cat || (id === 'categorise' && !!ingest);
  };
  const doneStep = (i: number) => i < reached && i !== stepIndex && enabled(steps[i].id);

  return (
    <div className="shell">
      <header className="shell-header">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); goto('home'); }} aria-label="Cash Flow Insight home">
          <Logo /><span className="brand-word">PWLB<span>today</span></span>
        </a>
        <div className="product">
          <span className="product-name">{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></span>
          <span className="product-tag">{APP_TAGLINE}</span>
        </div>
        <div className="header-spacer" />
        <span className="privacy-badge" title="All processing happens in this browser tab. Nothing is uploaded."><i className="bi bi-shield-lock-fill" /> Your data stays on this computer</span>
        {(ingest || dirty || team.savedAt) && <>
          <span className="save-state" title={team.savedAt ? `Last saved ${ago(team.savedAt)}` : 'Not saved yet'}>
            <span className={`dot ${dirty ? 'warn' : 'ok'}`} />{dirty ? 'Unsaved changes' : team.savedAt ? 'All changes saved' : 'Not saved yet'}
          </span>
          <button className={`btn ${dirty ? 'primary' : ''}`} onClick={() => goto('save')} title="Save your work so you (and colleagues) can pick up where you left off">
            <i className="bi bi-save" /> Save my work
          </button>
        </>}
      </header>

      <nav className="sidebar" aria-label="Steps">
        <button className={`nav-item ${step === 'home' ? 'active' : ''}`} onClick={() => goto('home')} style={{ marginTop: 6 }}><i className="bi bi-house" /> Start here</button>
        <div className="nav-label">Your steps</div>
        {steps.map((x, i) => (
          <button key={x.id} className={`nav-item ${x.id === step ? 'active' : ''} ${doneStep(i) ? 'done' : ''}`} disabled={!enabled(x.id)} onClick={() => goto(x.id)} aria-current={x.id === step ? 'step' : undefined}>
            <span className="step-num">{doneStep(i) ? <i className="bi bi-check-lg" style={{ fontSize: 12, color: 'inherit', width: 'auto' }} /> : i + 1}</span>
            <span>{x.label}<span className="step-sub">{x.sub}</span></span>
          </button>
        ))}
        {advanced && <>
          <div className="nav-label">Advanced tools</div>
          <button className={`nav-item ${step === 'data' ? 'active' : ''}`} disabled={!cat} onClick={() => goto('data')}><i className="bi bi-list-ul" /> All transactions</button>
          <button className={`nav-item ${step === 'settings' ? 'active' : ''}`} onClick={() => goto('settings')}><i className="bi bi-sliders" /> Settings</button>
        </>}
        <div className="sidebar-foot">
          <label className="side-switch"><input type="checkbox" checked={s.showTips} onChange={(e) => s.setShowTips(e.target.checked)} /><span className="sw" /> Show tips</label>
          <label className="side-switch" title="Extra screens for experienced users: column mapping, rules, backtesting, scenarios, schedules"><input type="checkbox" checked={advanced} onChange={(e) => { s.setAdvanced(e.target.checked); if (!e.target.checked && !SIMPLE_STEPS.some((x) => x.id === step) && step !== 'home') goto(cat ? 'forecast' : 'load'); }} /><span className="sw" /> Advanced tools</label>
          <div style={{ marginTop: 12 }}><i className="bi bi-lock" /> <strong>Private by design.</strong> Your bank files are read inside this browser tab. Nothing is uploaded.</div>
        </div>
      </nav>

      <main className="main" id="main">
        {step === 'home' && <HomePage />}
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
