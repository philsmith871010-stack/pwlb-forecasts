import { useEffect, useState } from 'react';
import { useStore, StepId, streamOf, streamSteps } from '../state/store';
import { useAreas } from './areas';
import { historyDays, MIN_HISTORY_DAYS } from '../lib/history/cashHistory';
import { PastDayPage } from './history/PastDay';
import { RulesPage } from './steps/RulesPage';
import { ExceptionsPage } from './steps/ExceptionsPage';
import { APP_NAME, APP_NAME_PARTS } from '../config';
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
import { SettingsMenu } from './components/HeaderMenus';
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
  const { areas } = useAreas();
  const current = streamOf(step);
  const area = current ? areas.find((a) => a.id === current.id) : undefined;

  // the browser's back button goes back to the main menu from inside an area
  useEffect(() => {
    if (!s.entered || step === 'home') return;
    if (!window.history.state?.area) window.history.pushState({ area: true }, '');
    const back = () => { if (useStore.getState().step !== 'home') useStore.getState().goto('home'); };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [s.entered, step]);
  useEffect(() => { if (step === 'home' && window.history.state?.area) window.history.back(); }, [step]);

  // the landing page comes first, on its own; one click enters the app
  if (!s.entered) return <div className="landing-shell"><HomePage /><Toasts /></div>;

  const h = team.cashHistory ?? s.historyBase;
  const enabled = (id: StepId) => {
    if (id === 'load' || id === 'save' || id === 'today' || id === 'home' || id === 'settings' || id === 'pastday' || id === 'rules' || id === 'exceptions') return true;
    if (id === 'map') return s.sources.length > 0;
    if (id === 'history') return !!cat || !!s.basis || historyDays(h) >= MIN_HISTORY_DAYS || !!team.historySummary;
    if (id === 'forecast') return true;
    if (id === 'backtest' || id === 'categorise' || id === 'review' || id === 'data') return !!cat;
    return true;
  };

  // why a step in this area can't be opened yet
  const why = (id: StepId): string => {
    if (id === 'map') return 'Opens when you’ve chosen statement files on Load statements.';
    if (id === 'history') return 'Needs at least six months of bank history.';
    return 'Needs bank statement files read in this session: your saved history keeps daily totals, not the lines. Load them under Load statements.';
  };

  return (
    <div className="shell top">
      <header className="shell-header">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); goto('home'); }} aria-label={`${APP_NAME}: main menu`}>
          <Logo /><span className="brand-word">{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></span>
        </a>
        {current && (
          <div className="area-head">
            <button className="menu-back" onClick={() => goto('home')}><i className="bi bi-grid-3x3-gap" /> Main menu</button>
            <span className="area-name"><i className={`bi ${current.icon}`} /> {current.label}</span>
            {area && !area.locked && <span className={`area-status ${area.tone}`} title={area.detail}>{area.status}</span>}
          </div>
        )}
        <div className="header-spacer" />
        <span className="privacy-dot" title="Everything happens in this browser tab. Nothing is uploaded."><i className="bi bi-shield-lock-fill" /></span>
        {step !== 'home' && space === 'example' && <span className="example-tag" title="You’re in the example council">Example</span>}
        <SettingsMenu />
      </header>

      <main className="main" id="main">
        <PracticeBar />
        {area?.locked ? <LockedArea label={current!.label} reason={area.locked} /> : <>
        {current && streamSteps(current, advanced).length > 1 && (
          <div className="streambar">
            {streamSteps(current, advanced).map((x, i) => (
              <button key={x.id} className={x.id === step ? 'on' : ''} disabled={!enabled(x.id)} onClick={() => goto(x.id)} aria-current={x.id === step ? 'step' : undefined}
                title={enabled(x.id) ? undefined : why(x.id)} aria-label={enabled(x.id) ? undefined : `${x.label}: locked. ${why(x.id)}`}>
                <span className="sb-num">{enabled(x.id) ? i + 1 : <i className="bi bi-lock-fill" />}</span>{x.label}
              </button>
            ))}
          </div>
        )}
        {step === 'home' && <JobsPage />}
        {step === 'today' && <TodayPage />}
        {step === 'pastday' && <PastDayPage />}
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
        {step === 'rules' && <RulesPage />}
        {step === 'exceptions' && <ExceptionsPage />}
        </>}
      </main>
      <Toasts />
      <MergeDialog />
      <ConfirmDialog />
    </div>
  );
}

/** An area that isn't open yet: what it's waiting for, and the way back. */
function LockedArea({ label, reason }: { label: string; reason: string }) {
  const goto = useStore((s) => s.goto);
  return (
    <div className="page narrow">
      <div className="locked-panel">
        <i className="bi bi-lock" />
        <h3>{label} isn’t open yet</h3>
        <p>{reason}</p>
        <button className="btn primary lg" onClick={() => goto('home')}><i className="bi bi-grid-3x3-gap" /> Back to main menu</button>
      </div>
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
