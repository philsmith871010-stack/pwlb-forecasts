import { useEffect, useRef, useState } from 'react';
import type { ECharts } from 'echarts/core';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, StepFooter, Seg, Empty, Modal } from '../components/common';
import { exportChart } from '../components/EChart';
import { useForecast } from '../forecast/useForecast';
import { ForecastChart } from '../forecast/ForecastChart';
import { SetupSection, MethodsSection, AssumptionsSection, OneOffsSection, PasteSection } from '../forecast/Controls';
import { StackedView, CategoryExplorer, ForecastTable, CompareView } from '../forecast/Views';
import { SnapshotForecastView } from '../forecast/SnapshotView';
import { money, day, ago } from '../../lib/format';
import type { Scenario } from '../../lib/model';
import { buildResultsSnapshot } from '../../lib/analysis/snapshot';

type Lower = 'stacked' | 'explorer' | 'table' | 'compare';

export function ForecastStep() {
  const { team, basis, activeScenarioId, setActiveScenario, newScenario, workspace, updateScenario } = useStore();
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  useEffect(() => { if (basis && !team.forecasts.length) newScenario('Base'); }, [basis, team.forecasts.length, newScenario]);
  useEffect(() => { if (sc && sc.id !== activeScenarioId) setActiveScenario(sc.id); }, [sc, activeScenarioId, setActiveScenario]);
  const b = useForecast(sc);
  const [gran, setGran] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [histMonths, setHistMonths] = useState(24);
  const [lower, setLower] = useState<Lower>('stacked');
  const chartRef = useRef<ECharts | null>(null);

  // keep a results snapshot on the scenario so it can be viewed without the CSV (debounced)
  useEffect(() => {
    if (!b || !sc) return;
    const t = setTimeout(() => {
      const snap = buildResultsSnapshot(b.fc);
      if (JSON.stringify(snap.cumulative) !== JSON.stringify(sc.resultsSnapshot?.cumulative) || snap.summary !== sc.resultsSnapshot?.summary) {
        useStore.setState((s) => ({ team: { ...s.team, forecasts: s.team.forecasts.map((f) => (f.id === sc.id ? { ...f, resultsSnapshot: snap } : f)) } }));
      }
    }, 600);
    return () => clearTimeout(t);
  }, [b, sc]);

  if (!basis) {
    const snaps = team.forecasts.filter((f) => f.resultsSnapshot);
    return <div className="page">{snaps.length ? <SnapshotForecastView /> : <Empty icon="bi-graph-up-arrow" title="No forecast yet">Load and categorise bank data, then come back here.</Empty>}</div>;
  }
  if (!sc || !b) return <div className="page"><span className="spinner" /></div>;
  const upd = (fn: (s: Scenario) => Scenario) => updateScenario(sc.id, fn);
  const fc = b.fc;
  const endPos = fc.cumulative[fc.H - 1];
  return (
    <div className="page">
      <PageHead eyebrow={workspace ? 'Workspace' : 'Step 6 of 8'} title="Forecast the operational cash position" actions={<ScenarioBar />}>
        Your regular cash rhythm projected forward from history, adjusted by your assumptions. The low point is your borrowing question.
      </PageHead>
      <div className="grid" style={{ gridTemplateColumns: '410px minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="stack" style={{ gap: 12 }}>
          <SetupSection sc={sc} upd={upd} b={b} />
          <MethodsSection sc={sc} upd={upd} b={b} />
          <AssumptionsSection sc={sc} upd={upd} />
          <OneOffsSection sc={sc} upd={upd} />
          <PasteSection sc={sc} upd={upd} b={b} />
        </div>
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="grid g4">
            <Kpi label="Projected low point" value={money(fc.low.amount)} sub={day(fc.low.day)} />
            <Kpi label="Borrowing requirement" value={money(fc.borrowingRequirement)} sub={`to stay above ${money(fc.buffer)} buffer`} />
            <Kpi label="Projected high point" value={money(fc.high.amount)} sub={day(fc.high.day)} />
            <Kpi label={`Position at ${day(fc.start + fc.H - 1)}`} value={money(endPos)} sub={fc.treasuryDaily.some((v) => v) ? `after known treasury: ${money(fc.cumulativeAfterTreasury[fc.H - 1])}` : `opening ${money(fc.opening)}`} />
          </div>
          <div className="summary-box" aria-live="polite">
            <div className="eyebrow">In plain English · {sc.name}</div>
            <SummaryText text={fc.summary} />
          </div>
          <Panel title="Cumulative operational cash position" sub={`history rebased to the ${money(fc.opening)} opening · recomputed in ${fc.ms.toFixed(0)} ms`}
            right={<>
              <Seg dark value={histMonths} onChange={setHistMonths} options={[{ v: 12, label: '1y' }, { v: 24, label: '2y' }, { v: 60, label: 'all' }]} ariaLabel="History shown" />
              <Seg dark value={gran} onChange={setGran} options={[{ v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} ariaLabel="Granularity" />
              <button className="btn sm on-dark" title="Download chart as PNG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'png')}><i className="bi bi-image" /></button>
              <button className="btn sm on-dark" title="Download chart as SVG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'svg')}>SVG</button>
            </>}>
            <ForecastChart b={b} granularity={gran} historyMonths={histMonths} height={440} onReady={(c) => { chartRef.current = c; }} />
            <div className="row xs muted">
              <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(253,126,20,.3)' }} />90% range from each category’s historic month-to-month variability, accumulating over time</span>
              <span className="legend-dot"><span style={{ color: 'var(--pt-orange)' }}>◆</span> assumption or one-off</span>
              {fc.breaches.length > 0 && <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(176,70,50,.25)' }} />below buffer</span>}
            </div>
          </Panel>
          <div className="tabs" role="tablist">
            {([['stacked', 'By category', 'bi-bar-chart-steps'], ['explorer', 'Category explorer', 'bi-zoom-in'], ['table', 'Forecast table', 'bi-table'], ['compare', 'Compare scenarios', 'bi-layers']] as [Lower, string, string][]).map(([k, l, i]) => (
              <button key={k} role="tab" aria-selected={lower === k} className={lower === k ? 'on' : ''} onClick={() => setLower(k)}><i className={`bi ${i}`} /> {l}</button>
            ))}
          </div>
          <div className="card card-pad">
            {lower === 'stacked' && <StackedView b={b} granularity={gran} />}
            {lower === 'explorer' && <CategoryExplorer b={b} />}
            {lower === 'table' && <ForecastTable b={b} granularity={gran} />}
            {lower === 'compare' && <CompareView />}
          </div>
          {fc.markers.length > 0 && (
            <Panel title="Everything shaping this forecast" sub="assumptions, one-offs and schedules on the timeline">
              <ul className="list-plain small">{fc.markers.map((m, i) => <li key={i} className="row tight"><span className={`badge ${m.kind === 'oneoff' ? 'soft' : m.kind === 'schedule' ? 'green' : 'navy'}`}>{m.kind === 'oneoff' ? 'one-off' : m.kind}</span><span className="xs muted" style={{ width: 90 }}>{day(m.day)}</span><span>{m.label}</span></li>)}</ul>
            </Panel>
          )}
        </div>
      </div>
      {!workspace && <StepFooter nextLabel="Backtest the model" />}
    </div>
  );
}

function SummaryText({ text }: { text: string }) {
  // emphasise money amounts and dates
  const parts = text.split(/(−?£[\d.,]+(?:bn|m|k)?|\d{1,2} [A-Z][a-z]{2} \d{4})/g);
  return <p style={{ margin: 0 }}>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}</p>;
}

function ScenarioBar() {
  const { team, activeScenarioId, setActiveScenario, newScenario, deleteScenario, updateScenario } = useStore();
  const [dlg, setDlg] = useState<null | 'new' | 'rename'>(null);
  const [name, setName] = useState('');
  const sc = team.forecasts.find((f) => f.id === activeScenarioId);
  const presets: { name: string; tweak?: (s: Scenario) => Scenario }[] = [
    { name: 'Prudent', tweak: (s) => ({ ...s, settings: { ...s.settings, includePossible: false } }) },
    { name: 'Optimistic' },
  ];
  return (
    <div className="row tight">
      <span className="small muted">Scenario</span>
      <select className="select" style={{ width: 200 }} value={activeScenarioId ?? ''} onChange={(e) => setActiveScenario(e.target.value)} aria-label="Scenario">
        {team.forecasts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      {sc && <span className="xs muted" title={sc.updatedAt}>edited {ago(sc.updatedAt)}{sc.createdBy ? ` · ${sc.createdBy}` : ''}</span>}
      <button className="btn sm" onClick={() => { setName(''); setDlg('new'); }}><i className="bi bi-plus-lg" /> New</button>
      {sc && <button className="btn sm" onClick={() => newScenario(`${sc.name} (copy)`, sc)}><i className="bi bi-copy" /> Duplicate</button>}
      {sc && <button className="btn sm ghost" onClick={() => { setName(sc.name); setDlg('rename'); }}><i className="bi bi-pencil" /></button>}
      {sc && team.forecasts.length > 1 && <button className="btn sm ghost" aria-label="Delete scenario" onClick={() => { if (confirm(`Delete scenario “${sc.name}”?`)) deleteScenario(sc.id); }}><i className="bi bi-trash" /></button>}
      {dlg && (
        <Modal title={dlg === 'new' ? 'New scenario' : 'Rename scenario'} onClose={() => setDlg(null)} footer={<><button className="btn" onClick={() => setDlg(null)}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => {
            if (dlg === 'rename' && sc) updateScenario(sc.id, (s) => ({ ...s, name: name.trim() }));
            else {
              const p = presets.find((x) => x.name === name.trim());
              const id = newScenario(name.trim(), sc);
              if (p?.tweak) updateScenario(id, p.tweak);
            }
            setDlg(null);
          }}>{dlg === 'new' ? 'Create' : 'Rename'}</button></>}>
          <div className="field"><label>Name</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) (e.currentTarget.closest('.modal')?.querySelector('.btn.primary') as HTMLButtonElement)?.click(); }} /></div>
          {dlg === 'new' && <div className="row mt tight">{['Base', 'Prudent', 'Optimistic'].map((n) => <button key={n} className="chip" onClick={() => setName(n)}>{n}</button>)}<span className="xs muted">A new scenario starts as a copy of the current one.</span></div>}
        </Modal>
      )}
    </div>
  );
}
