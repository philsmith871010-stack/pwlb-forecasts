import { useEffect } from 'react';
import { useStore, STEPS, StepId } from '../state/store';
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

const WORKSPACE: { id: StepId; label: string; icon: string }[] = [
  { id: 'data', label: 'Data', icon: 'bi-database' },
  { id: 'history', label: 'History', icon: 'bi-bar-chart-line' },
  { id: 'forecast', label: 'Forecast', icon: 'bi-graph-up-arrow' },
  { id: 'backtest', label: 'Backtest', icon: 'bi-bullseye' },
  { id: 'save', label: 'Save & export', icon: 'bi-box-arrow-down' },
  { id: 'settings', label: 'Settings', icon: 'bi-sliders' },
];

export function App() {
  const s = useStore();
  const { step, reached, workspace, team, dirty, teamName, cat, ingest, goto } = s;

  // Warn before closing with unsaved team-file changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (useStore.getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const stepIndex = STEPS.findIndex((x) => x.id === step);
  const enabled = (i: number) => {
    const id = STEPS[i].id;
    if (id === 'load') return true;
    if (id === 'map') return s.sources.length > 0;
    if (id === 'save') return true;
    if (['history', 'forecast'].includes(id) && !cat) return team.forecasts.some((f) => f.resultsSnapshot) || !!team.historySummary;
    return !!cat || (id === 'categorise' && !!ingest);
  };

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
        <span className="privacy-badge" title="All parsing, categorisation and forecasting runs in this browser tab. Nothing is uploaded."><i className="bi bi-shield-lock-fill" /> Your bank data stays on this computer</span>
        <div className="team-status">
          <span><span className={`dot ${dirty ? 'warn' : 'ok'}`} /><strong>{team.authorityName}</strong></span>
          <span className="muted">{teamName ?? 'Unsaved team file'} · {dirty ? 'unsaved changes' : team.savedAt ? `saved ${ago(team.savedAt)}` : 'not saved yet'}</span>
        </div>
        <button className="btn ghost" onClick={() => s.setShowTips(!s.showTips)} title="Show or hide the plain-English guidance on every tab"><i className={`bi ${s.showTips ? 'bi-lightbulb-fill orange' : 'bi-lightbulb'}`} /> {s.showTips ? 'Tips on' : 'Tips off'}</button>
        <button className={`btn ${dirty ? 'primary' : ''}`} onClick={() => void s.saveTeam()} title="Save the shared team file (rules, profiles, forecasts — never transactions)">
          <i className="bi bi-save" /> Save
        </button>
      </header>

      <nav className="sidebar" aria-label="Steps">
        {workspace ? (
          <>
            <button className={`nav-item ${step === 'home' ? 'active' : ''}`} onClick={() => goto('home')}><i className="bi bi-house" /> About this tool</button>
            <div className="nav-label">Workspace</div>
            {WORKSPACE.map((w) => (
              <button key={w.id} className={`nav-item ${step === w.id || (w.id === 'data' && ['load', 'map', 'categorise', 'review'].includes(step)) ? 'active' : ''}`} onClick={() => goto(w.id)}>
                <i className={`bi ${w.icon}`} /> {w.label}
              </button>
            ))}
            <div className="nav-label">Guided steps</div>
            <button className="nav-item" onClick={() => { useStore.setState({ workspace: false }); goto('load'); }}><i className="bi bi-signpost-split" /> Re-run the wizard</button>
          </>
        ) : (
          <>
            <button className={`nav-item ${step === 'home' ? 'active' : ''}`} onClick={() => goto('home')} style={{ marginTop: 6 }}><i className="bi bi-house" /> About this tool</button>
            <div className="nav-label">Guided steps</div>
            {STEPS.map((x, i) => (
              <button key={x.id} className={`nav-item ${x.id === step ? 'active' : ''} ${i < stepIndex || i <= reached && x.id !== step && i < reached ? 'done' : ''}`} disabled={!enabled(i)} onClick={() => goto(x.id)} aria-current={x.id === step ? 'step' : undefined}>
                <span className="step-num">{i < reached && x.id !== step ? <i className="bi bi-check-lg" style={{ fontSize: 12, color: 'inherit', width: 'auto' }} /> : i + 1}</span>
                <span>{x.label}<span className="step-sub">{x.sub}</span></span>
              </button>
            ))}
            {cat && <>
              <div className="nav-label">Shortcuts</div>
              <button className="nav-item" onClick={() => { useStore.setState({ workspace: true }); goto('forecast'); }}><i className="bi bi-grid-1x2" /> Open workspace</button>
            </>}
          </>
        )}
        <div className="sidebar-foot">
          <i className="bi bi-lock" /> <strong>Private by design.</strong> Bank files are read inside this tab by a background worker. No server, no uploads, no tracking.
          {ingest && <div style={{ marginTop: 8 }}>{ingest.rows.toLocaleString('en-GB')} transactions in memory</div>}
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
