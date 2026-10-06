import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ECharts } from 'echarts/core';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, StepFooter, Seg, Empty, Modal, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { exportChart, EChart } from '../components/EChart';
import { useForecast } from '../forecast/useForecast';
import { ForecastChart } from '../forecast/ForecastChart';
import { SetupSection, MethodsSection, AssumptionsSection, OneOffsSection, PasteSection } from '../forecast/Controls';
import { StackedView, CategoryExplorer, ForecastTable, CompareView } from '../forecast/Views';
import { SnapshotForecastView } from '../forecast/SnapshotView';
import { money, day, ago } from '../../lib/format';
import type { Scenario } from '../../lib/model';
import { buildResultsSnapshot } from '../../lib/analysis/snapshot';

const FC_TABS: TabDef[] = [
  { id: 'result', label: 'Result' },
  { id: 'setup', label: 'Starting point' },
  { id: 'growth', label: 'Growth' },
  { id: 'changes', label: 'Planned changes' },
  { id: 'oneoffs', label: 'Known one-offs' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'scenarios', label: 'Scenarios' },
];

const FC_HELP: Record<string, { what: React.ReactNode; why?: React.ReactNode; todo?: React.ReactNode }> = {
  result: { what: <>Your everyday cash position projected forward: the solid line is history, the dashed line the forecast, the shaded band the likely range. The <strong>low point</strong> is the key number.</>, why: 'The low point, and when it happens, tells you how much you may need to borrow and by when. The red dashed line is your minimum cash buffer.', todo: <>Read the summary. Then use the tabs to the right to add what you know about the future — pay awards, grants ending, land sales.</> },
  setup: { what: 'When the forecast starts, how far ahead it looks, what cash you start with, and how much past history it learns from.', why: 'The starting cash shifts the whole line up or down; the buffer decides when you’d need to borrow.', todo: 'Check the start date and opening cash. The defaults are usually right.' },
  growth: { what: <>How fast each category is expected to grow each year, and how it’s projected: <strong>Seasonal</strong> repeats last years’ monthly pattern; <strong>Schedule</strong> projects regular payments on their own dates; <strong>Flat</strong> uses an average.</>, why: 'Growth compounds — a couple of percent on payroll moves the low point by millions over two years.', todo: <>The grey number is the historic trend. Type your own figure where you know better, e.g. <strong>Salaries 2</strong> for a 2% pay award.</> },
  changes: { what: 'Specific changes you know about: a pay award from a date (with backdated arrears), a payment day moving, a grant stopping, a new regular payment starting, or general inflation.', why: 'History can’t know about decisions that haven’t happened yet — you can.', todo: 'Pick the type of change, fill in the boxes, click Add. It appears on the chart as an orange diamond.' },
  oneoffs: { what: 'Single known items: a land sale, a capital grant, a big contract payment.', why: <>One-offs don’t repeat, so history can’t predict them. Mark how sure you are — <strong>possible</strong> items count at their probability.</>, todo: 'Add each item with its date, amount and confidence.' },
  schedules: { what: 'Paste a table straight from Excel — e.g. a grant payment schedule, monthly amounts, or an annual total to spread.', why: 'When you have the actual schedule, it beats any pattern from history. You can also paste known loan maturities and interest as a separate treasury layer.', todo: 'Copy the cells in Excel (date or month in the first column, amount in the last), paste below, choose the category, click Apply.' },
  breakdown: { what: 'The forecast split by category: a chart, the detail for one category (with exactly how it was worked out), and a full table.', why: 'Every number traces back to history, an assumption or an item you entered — nothing is a black box.', todo: 'Use the switch to move between the three views. Download the table if you need it in Excel.' },
  scenarios: { what: 'Different versions of the forecast — e.g. Base, Prudent, Optimistic — each with its own assumptions.', why: 'Comparing scenarios shows how sensitive the borrowing need is to what you assume.', todo: 'Create or copy a scenario with the buttons at the top of the page, then tick up to three here to compare.' },
};

export function ForecastStep() {
  const { team, basis, activeScenarioId, setActiveScenario, newScenario, workspace, updateScenario } = useStore();
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  useEffect(() => { if (basis && !team.forecasts.length) newScenario('Base'); }, [basis, team.forecasts.length, newScenario]);
  useEffect(() => { if (sc && sc.id !== activeScenarioId) setActiveScenario(sc.id); }, [sc, activeScenarioId, setActiveScenario]);
  const b = useForecast(sc);
  const [gran, setGran] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [histMonths, setHistMonths] = useState(24);
  const [lower, setLower] = useState<'stacked' | 'explorer' | 'table'>('stacked');
  const [tab, setTab] = useStepTab('forecast', FC_TABS);
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
  const help = FC_HELP[tab];
  const idx = FC_TABS.findIndex((t) => t.id === tab);
  const tabs = FC_TABS.map((t) => ({ ...t, badge:
    t.id === 'changes' ? sc.assumptions.filter((a) => a.kind !== 'growth').length || '' :
    t.id === 'growth' ? sc.assumptions.filter((a) => a.kind === 'growth').length || '' :
    t.id === 'oneoffs' ? sc.oneOffs.length || '' :
    t.id === 'schedules' ? sc.pastedSchedules.length + (sc.treasurySchedule.length ? 1 : 0) || '' :
    t.id === 'scenarios' ? team.forecasts.length : '' }));
  return (
    <div className="page">
      <PageHead eyebrow={workspace ? 'Workspace' : 'Step 6 of 8'} title="Forecast your cash position" actions={<ScenarioBar />}>
        Your regular cash rhythm projected forward, plus what you know is coming. The low point answers “how much might we need to borrow, and when?”
      </PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab !== 'result' && <ResultsStrip b={b} onOpen={() => setTab('result')} />}
      <Explain compact what={help.what} why={help.why} todo={help.todo} />

      {tab === 'result' && (
        <div className="stack">
          <div className="grid g4">
            <Kpi label="Lowest point" value={money(fc.low.amount)} sub={day(fc.low.day)} />
            <Kpi label="Borrowing need" value={money(fc.borrowingRequirement)} sub={`to stay above your ${money(fc.buffer)} buffer`} />
            <Kpi label="Highest point" value={money(fc.high.amount)} sub={day(fc.high.day)} />
            <Kpi label={`Position at ${day(fc.start + fc.H - 1)}`} value={money(endPos)} sub={fc.treasuryDaily.some((v) => v) ? `after known loan repayments: ${money(fc.cumulativeAfterTreasury[fc.H - 1])}` : `starting from ${money(fc.opening)}`} />
          </div>
          <div className="summary-box" aria-live="polite">
            <div className="eyebrow">In plain English · {sc.name}</div>
            <SummaryText text={fc.summary} />
          </div>
          <Panel title="Everyday cash position: history and forecast" sub={`recalculated in ${fc.ms.toFixed(0)} ms`}
            right={<>
              <Seg dark value={histMonths} onChange={setHistMonths} options={[{ v: 12, label: '1y' }, { v: 24, label: '2y' }, { v: 60, label: 'all' }]} ariaLabel="History shown" />
              <Seg dark value={gran} onChange={setGran} options={[{ v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} ariaLabel="Granularity" />
              <button className="btn sm on-dark" title="Download chart as PNG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'png')}><i className="bi bi-image" /></button>
              <button className="btn sm on-dark" title="Download chart as SVG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'svg')}>SVG</button>
            </>}>
            <ForecastChart b={b} granularity={gran} historyMonths={histMonths} height={460} onReady={(c) => { chartRef.current = c; }} />
            <div className="row xs muted">
              <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(253,126,20,.3)' }} />likely range (90%) — widens further out, based on how much each category has varied month to month</span>
              <span className="legend-dot"><span style={{ color: 'var(--pt-orange)' }}>◆</span> a change or one-off you added</span>
              {fc.breaches.length > 0 && <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(176,70,50,.25)' }} />below your buffer</span>}
            </div>
          </Panel>
          {fc.markers.length > 0 && (
            <Panel title="What you’ve added to this forecast" sub="changes, one-offs and schedules on the timeline">
              <ul className="list-plain small">{fc.markers.map((m, i) => <li key={i} className="row tight"><span className={`badge ${m.kind === 'oneoff' ? 'soft' : m.kind === 'schedule' ? 'green' : 'navy'}`}>{m.kind === 'oneoff' ? 'one-off' : m.kind === 'assumption' ? 'change' : m.kind}</span><span className="xs muted" style={{ width: 90 }}>{day(m.day)}</span><span>{m.label}</span></li>)}</ul>
            </Panel>
          )}
        </div>
      )}
      {tab === 'setup' && <div style={{ maxWidth: 640 }}><SetupSection sc={sc} upd={upd} b={b} /></div>}
      {tab === 'growth' && <MethodsSection sc={sc} upd={upd} b={b} />}
      {tab === 'changes' && <div style={{ maxWidth: 860 }}><AssumptionsSection sc={sc} upd={upd} /></div>}
      {tab === 'oneoffs' && <div style={{ maxWidth: 860 }}><OneOffsSection sc={sc} upd={upd} /></div>}
      {tab === 'schedules' && <div style={{ maxWidth: 980 }}><PasteSection sc={sc} upd={upd} b={b} /></div>}
      {tab === 'breakdown' && (
        <div className="card card-pad">
          <div className="row mb"><Seg value={lower} onChange={setLower} options={[{ v: 'stacked', label: 'Chart by category' }, { v: 'explorer', label: 'One category in detail' }, { v: 'table', label: 'Full table' }]} /></div>
          {lower === 'stacked' && <StackedView b={b} granularity={gran} />}
          {lower === 'explorer' && <CategoryExplorer b={b} />}
          {lower === 'table' && <ForecastTable b={b} granularity={gran} />}
        </div>
      )}
      {tab === 'scenarios' && <div className="card card-pad"><CompareView /></div>}

      {idx < FC_TABS.length - 1 ? <NextTab label={`Next: ${FC_TABS[idx + 1].label.toLowerCase()}`} onClick={() => setTab(FC_TABS[idx + 1].id)} text={tab === 'result' ? 'Add what you know about the future:' : undefined} />
        : !workspace && <StepFooter nextLabel="Check it against history (backtest)" />}
      {!workspace && idx < FC_TABS.length - 1 && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn ghost sm" onClick={() => useStore.getState().goto('backtest')}>Skip to the backtest <i className="bi bi-skip-forward" /></button></div>}
    </div>
  );
}

/** Compact live results shown above every editing tab, so changes are visible instantly. */
function ResultsStrip({ b, onOpen }: { b: NonNullable<ReturnType<typeof useForecast>>; onOpen: () => void }) {
  const fc = b.fc;
  const spark = useMemo(() => {
    const step = Math.max(1, Math.floor(fc.H / 120));
    const pts: [number, number][] = [];
    for (let d = 0; d < fc.H; d += step) pts.push([d, fc.cumulative[d]]);
    return pts;
  }, [fc]);
  return (
    <div className="results-strip">
      <div className="mini-kpis">
        <div className="mini-kpi"><div className="l">Lowest point</div><div className="v">{money(fc.low.amount)}</div><div className="s">{day(fc.low.day)}</div></div>
        <div className="mini-kpi"><div className="l">Borrowing need</div><div className="v">{money(fc.borrowingRequirement)}</div><div className="s">above {money(fc.buffer)} buffer</div></div>
        <div className="mini-kpi"><div className="l">Highest point</div><div className="v">{money(fc.high.amount)}</div><div className="s">{day(fc.high.day)}</div></div>
        <div className="mini-kpi"><div className="l">At the end</div><div className="v">{money(fc.cumulative[fc.H - 1])}</div><div className="s">{day(fc.start + fc.H - 1)}</div></div>
        <button className="mini-chart" onClick={onOpen} title="Open the full chart" style={{ cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
          <EChart height={58} option={{
            animation: false, grid: { left: 2, right: 2, top: 4, bottom: 2 },
            xAxis: { type: 'value', show: false, min: 0, max: fc.H }, yAxis: { type: 'value', show: false, scale: true },
            series: [
              { type: 'line', data: spark, showSymbol: false, lineStyle: { color: '#fd7e14', width: 2 }, areaStyle: { color: 'rgba(253,126,20,.08)' },
                markLine: { silent: true, symbol: 'none', data: [{ yAxis: fc.buffer }], lineStyle: { color: '#b04632', type: 'dashed', width: 1 }, label: { show: false } } },
            ],
          }} />
        </button>
      </div>
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
