import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ECharts } from 'echarts/core';
import { useStore, useEyebrow } from '../../state/store';
import { StrategyView } from '../forecast/StrategyView';
import { RegisterCard } from '../register/RegisterCard';
import { RegisterOverview } from '../register/RegisterOverview';
import { SaveStep } from './SaveStep';
import { PageHead, Panel, Kpi, StepFooter, Seg, Modal, Explain, StepTabs, NextTab, useStepTab, TabDef, PracticeNote } from '../components/common';
import { exportChart, EChart } from '../components/EChart';
import { useForecast, type ForecastBundle } from '../forecast/useForecast';
import { isoFromDay, dayFromISO } from '../../lib/dates';
import { ForecastChart } from '../forecast/ForecastChart';
import { SetupSection, MethodsSection, AssumptionsSection, OneOffsSection, PasteSection } from '../forecast/Controls';
import { StackedView, CategoryExplorer, ForecastTable, CompareView } from '../forecast/Views';
import { SimpleStart, SimpleItems, SimpleBreakdown } from '../forecast/SimpleControls';
import { BuildView, reviewState, isReviewed, dataEndIso } from '../forecast/BuildView';
import { SnapshotForecastView } from '../forecast/SnapshotView';
import { money, day, ago } from '../../lib/format';
import { historyDays, MIN_HISTORY_DAYS } from '../../lib/history/cashHistory';
import type { Scenario } from '../../lib/model';
import { buildResultsSnapshot } from '../../lib/analysis/snapshot';

const FC_TABS: TabDef[] = [
  { id: 'lines', label: 'Check each line' },
  { id: 'growth', label: 'Methods' },
  { id: 'changes', label: 'Planned changes' },
  { id: 'oneoffs', label: 'Known one-offs' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'setup', label: 'Starting point' },
  { id: 'result', label: 'Result' },
  { id: 'options', label: 'What you could do' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'report', label: 'Report & Excel' },
  { id: 'scenarios', label: 'Scenarios' },
];

const FC_TABS_SIMPLE: TabDef[] = [
  { id: 'lines', label: 'Check each line' },
  { id: 'before', label: 'Known items and cash' },
  { id: 'result', label: 'Your forecast' },
  { id: 'options', label: 'What you could do' },
  { id: 'report', label: 'Report & Excel' },
];

/** tabs that show results: locked until the proposal has been checked */
const RESULT_TABS = ['result', 'options', 's-breakdown', 'breakdown', 'scenarios', 'report'];

const FC_HELP: Record<string, { what: React.ReactNode; why?: React.ReactNode; todo?: React.ReactNode }> = {
  before: { what: 'Three short things before you see the result: anything coming up (a land sale, a grant ending, a pay award), your starting cash and minimum, and, if you have it, your deal register.', todo: 'Add anything you know about and check the starting cash. Your forecast updates as you go.' },
  lines: { what: 'Our proposal for each kind of income and spending, worked out from your history: how big it is, how it is growing, and when it is paid.', why: 'A forecast is only as good as its parts. Checking each line takes a few minutes and means every figure is one you have agreed.', todo: <>Open each line, check what we found, change anything you know better (e.g. salaries <strong>+3%</strong> for a pay award, or paid on the <strong>last working day</strong>), then click <strong>Looks right</strong>.</> },
  report: { what: 'Take the forecast away: a ready-made report (print or save as PDF) and an Excel workbook with every number.', todo: 'Click View and download for the report, or Download Excel.' },
  options: { what: 'Borrowing and investing options worked out from your forecast and, if you added it, your deal register.', why: 'The forecast shows when cash runs short or sits idle. These options turn that into figures to take to your treasury meeting.', todo: 'Read the options, then check them against your treasury management strategy. Change the forecast and they update.' },
  's-start': { what: 'Three simple settings that frame the forecast: the cash you start with, the minimum you want to keep, and how far ahead to look.', todo: 'Check each one. The figures we’ve filled in are a sensible starting point.' },
  's-items': { what: 'Things you know are coming that past years can’t predict: a land sale, a grant that ends, a pay award.', why: 'These often decide whether the low point is £10m or £30m.', todo: 'Pick the kind of item, fill in the short form and click Add. Each will show on your forecast chart as an orange diamond. For figures that belong to one line (a grant’s payment dates, say), use that line’s grid or Import a schedule instead.' },
  's-breakdown': { what: 'The forecast split into categories, year by year, next to the last 12 months for comparison.', why: 'Lets you sense-check it: does each line look about right?', todo: 'Look for anything that seems too high or too low, and change it on Check each line.' },
  result: { what: <>Your everyday cash, day by day. The <strong>navy line</strong> is the past, the <strong>orange dashed line</strong> is the forecast. The red dashed line is the minimum cash you want to keep.</>, why: 'Where the orange line drops below the red line, you would need to borrow to stay safe. Its lowest point tells you how much and when.', todo: <>Read the summary below. To change anything, go back to <strong>Check each line</strong> or <strong>Known future items</strong>: the forecast updates as you go.</> },
  setup: { what: 'When the forecast starts, how far ahead it looks, what cash you start with, and how much past history it learns from.', why: 'The starting cash shifts the whole line up or down; the buffer decides when you’d need to borrow.', todo: 'Check the start date and opening cash. The defaults are usually right.' },
  growth: { what: <>How fast each category is expected to grow each year, and how it’s projected: <strong>Seasonal</strong> repeats last years’ monthly pattern; <strong>Schedule</strong> projects regular payments on their own dates; <strong>Flat</strong> uses an average.</>, why: 'Growth compounds — a couple of percent on payroll moves the low point by millions over two years.', todo: <>The grey number is the historic trend. Type your own figure where you know better, e.g. <strong>Salaries 2</strong> for a 2% pay award.</> },
  changes: { what: 'Specific changes you know about: a pay award from a date (with backdated arrears), a payment day moving, a grant stopping, a new regular payment starting, or general inflation.', why: 'History can’t know about decisions that haven’t happened yet — you can.', todo: 'Pick the type of change, fill in the boxes, click Add. It appears on the chart as an orange diamond.' },
  oneoffs: { what: 'Single known items: a land sale, a capital grant, a big contract payment.', why: <>One-offs don’t repeat, so history can’t predict them. Mark how sure you are — <strong>possible</strong> items count at their probability.</>, todo: 'Add each item with its date, amount and confidence.' },
  schedules: { what: 'Paste a table straight from Excel — e.g. a grant payment schedule, monthly amounts, or an annual total to spread.', why: 'When you have the actual schedule, it beats any pattern from history. You can also paste known loan maturities and interest as a separate treasury layer.', todo: 'Copy the cells in Excel (date or month in the first column, amount in the last), paste below, choose the category, click Apply.' },
  breakdown: { what: 'The forecast split by category: a chart, the detail for one category (with exactly how it was worked out), and a full table.', why: 'Every number traces back to history, an assumption or an item you entered — nothing is a black box.', todo: 'Use the switch to move between the three views. Download the table if you need it in Excel.' },
  scenarios: { what: 'Different versions of the forecast — e.g. Base, Prudent, Optimistic — each with its own assumptions.', why: 'Comparing scenarios shows how sensitive the borrowing need is to what you assume.', todo: 'Create or copy a scenario with the buttons at the top of the page, then tick up to three here to compare.' },
};

export function ForecastStep() {
  const { team, basis, activeScenarioId, setActiveScenario, newScenario, updateScenario } = useStore();
  const workspace = false;
  const eyebrow = useEyebrow('forecast');
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  useEffect(() => { if (basis && !team.forecasts.length) newScenario('Base'); }, [basis, team.forecasts.length, newScenario]);
  useEffect(() => { if (sc && sc.id !== activeScenarioId) setActiveScenario(sc.id); }, [sc, activeScenarioId, setActiveScenario]);
  const b = useForecast(sc);
  // the forecast unlocks as soon as every line is checked: no extra step (the example too: it's a practice run)
  const space = useStore((st) => st.space);
  useEffect(() => {
    if (!sc || !b || isReviewed(sc, b)) return;
    if (reviewState(sc, b).allChecked) updateScenario(sc.id, (x) => ({ ...x, reviewDone: true, reviewFor: dataEndIso(b) }));
  }, [sc, b]); // eslint-disable-line react-hooks/exhaustive-deps
  const [gran, setGran] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [histMonths, setHistMonths] = useState(24);
  const [lower, setLower] = useState<'stacked' | 'explorer' | 'table'>('stacked');
  const advanced = useStore((st) => st.advanced);
  const TABS = advanced ? FC_TABS : FC_TABS_SIMPLE;
  const [tab, setTab] = useStepTab(advanced ? 'forecast' : 'forecast-simple', TABS);
  const chartRef = useRef<ECharts | null>(null);
  // the practice run notes which forecast screens have been seen
  const markSeen = useStore((st) => st.markSeen);
  useEffect(() => { markSeen(`fc:${tab}`); }, [tab, markSeen]);

  // keep a results snapshot on the scenario so it can be viewed without the CSV (debounced)
  useEffect(() => {
    if (!b || !sc || !isReviewed(sc, b)) return;
    const t = setTimeout(() => {
      const snap = buildResultsSnapshot(b.fc);
      if (JSON.stringify(snap.cumulative) !== JSON.stringify(sc.resultsSnapshot?.cumulative) || snap.summary !== sc.resultsSnapshot?.summary) {
        useStore.setState((s) => ({ team: { ...s.team, forecasts: s.team.forecasts.map((f) => (f.id === sc.id ? { ...f, resultsSnapshot: snap } : f)) } }));
      }
    }, 600);
    return () => clearTimeout(t);
  }, [b, sc]);

  if (!basis || basis.agg.D < MIN_HISTORY_DAYS) {
    const snaps = team.forecasts.filter((f) => f.resultsSnapshot);
    return <div className="page">{snaps.length && !useStore.getState().historyBase ? <SnapshotForecastView /> : <ForecastStart />}</div>;
  }
  if (!sc || !b) return <div className="page"><span className="spinner" /></div>;
  const upd = (fn: (s: Scenario) => Scenario) => updateScenario(sc.id, fn);
  const fc = b.fc;
  const help = tab === 'result' && fc.register ? { ...FC_HELP.result, what: <>Your cash, day by day, <strong>including your loans and investments</strong> from the deal register. The <strong>navy line</strong> is the past, the <strong>orange dashed line</strong> the forecast, and the grey dotted line is your everyday cash without the deals. The red dashed line is the minimum cash you want to keep.</> } : FC_HELP[tab];
  const rv = reviewState(sc, b);
  const locked = !(isReviewed(sc, b) || rv.allChecked);
  const idx = TABS.findIndex((t) => t.id === tab);
  const tabs = TABS.map((t) => ({ ...t, hint: locked && RESULT_TABS.includes(t.id) ? 'Appears once every line is checked' : undefined, badge: locked && RESULT_TABS.includes(t.id) ? <i className="bi bi-lock-fill" aria-label="locked" /> :
    t.id === 'lines' ? (rv.left.length ? `${rv.left.length} to check` : '✓') :
    t.id === 's-items' || t.id === 'before' ? sc.oneOffs.length + sc.assumptions.filter((a) => a.kind === 'stop' || a.kind === 'step').length || '' :
    t.id === 'changes' ? sc.assumptions.filter((a) => a.kind !== 'growth').length || '' :
    t.id === 'oneoffs' ? sc.oneOffs.length || '' :
    t.id === 'schedules' ? sc.pastedSchedules.length + (sc.treasurySchedule.length ? 1 : 0) || '' :
    t.id === 'scenarios' ? team.forecasts.length : '' }));
  const firstResult = TABS.findIndex((t) => t.id === 'result');
  const seeForecast = () => { upd((s) => ({ ...s, reviewDone: true, reviewFor: dataEndIso(b) })); setTab('result'); };
  return (
    <div className="page">
      <PageHead eyebrow={eyebrow} title="Your cash forecast" actions={advanced ? <ScenarioBar /> : undefined}>
        {locked ? <>We’ve drafted it from your history. Check each line, add what you know is coming, then see the result.</> : null}
      </PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      {locked && tab !== 'lines' && !RESULT_TABS.includes(tab) && rv.left.length > 0 && (
        <div className="callout mb small lock-note"><i className="bi bi-lock" /> <strong>{rv.left.length} line{rv.left.length > 1 ? 's' : ''} still to check</strong> before your forecast appears. <button className="link-btn" onClick={() => setTab('lines')}>Check {rv.left.length > 1 ? 'them' : 'it'}</button></div>
      )}
      {locked && RESULT_TABS.includes(tab) && (
        <div className="locked-panel">
          <i className="bi bi-lock" />
          {rv.allChecked
            ? <><h3>Every line is checked</h3><p>Your forecast is ready to see.</p><button className="btn primary lg" onClick={seeForecast}>See my forecast <i className="bi bi-arrow-right" /></button></>
            : <><h3>Your forecast appears once every line is checked</h3><p><strong>{rv.left.length}</strong> of {rv.main.length + rv.small.length} still to check. It takes a few minutes: open each line and click <strong>Looks right</strong>, or change it first.</p><button className="btn primary lg" onClick={() => setTab('lines')}>Check the lines <i className="bi bi-arrow-right" /></button></>}
        </div>
      )}
      {!locked && !RESULT_TABS.includes(tab) && <ResultsStrip b={b} onOpen={() => setTab('result')} />}
      {!(locked && RESULT_TABS.includes(tab)) && <Explain compact what={help.what} why={help.why} todo={help.todo} />}

      {tab === 'result' && !locked && (
        <div className="stack">
          <div className="result-top">
            <Kpi label="You may need to borrow" value={money(fc.borrowingRequirement)} sub={fc.borrowingRequirement > 0 ? `by ${day(fc.low.day)}, to keep at least ${money(fc.buffer)} in the bank` : `you stay above ${money(fc.buffer)} throughout`} />
            <Kpi light label="Lowest point" value={money(fc.low.amount)} sub={`on ${day(fc.low.day)}`} />
            <div className="result-aside">
              {!advanced && <p className="why-line" aria-live="polite">
                {fc.drivers.length > 0 && <>Biggest calls on cash: <strong>{fc.drivers.map((d) => d.name.replace(/ \(.*\)$/, '').toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1')}</strong>. </>}
                {fc.breaches.length > 0 ? <>Cash first drops below {money(fc.buffer)} on <strong>{day(fc.breaches[0].from)}</strong>.</> : <>Cash stays above {money(fc.buffer)} throughout.</>}
              </p>}
              <SignOffRow b={b} sc={sc} onSee={() => useStore.getState().goto('monitor')} />
            </div>
          </div>
          {advanced && (
            <div className="summary-box" aria-live="polite">
              <div className="eyebrow">In plain English · {sc.name}</div>
              <SummaryText text={fc.summary} />
            </div>
          )}
          <Panel title={fc.register ? 'Your cash, with your loans and investments: past and forecast' : 'Your everyday cash: past and forecast'} sub={advanced ? `recalculated in ${fc.ms.toFixed(0)} ms` : undefined}
            right={advanced ? <>
              <Seg dark value={histMonths} onChange={setHistMonths} options={[{ v: 12, label: '1y' }, { v: 24, label: '2y' }, { v: 60, label: 'all' }]} ariaLabel="History shown" />
              <Seg dark value={gran} onChange={setGran} options={[{ v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} ariaLabel="Granularity" />
              <button className="btn sm on-dark" title="Download chart as PNG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'png')}><i className="bi bi-image" /></button>
              <button className="btn sm on-dark" title="Download chart as SVG" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'svg')}>SVG</button>
            </> : <button className="btn sm on-dark" title="Download this chart as a picture" onClick={() => chartRef.current && void exportChart(chartRef.current, `forecast-${sc.name}`, 'png')}><i className="bi bi-image" /> Save picture</button>}>
            <ForecastChart b={b} granularity={gran} historyMonths={histMonths} height={460} onReady={(c) => { chartRef.current = c; }} />
            {advanced && <div className="row xs muted">
              <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(253,126,20,.3)' }} />shaded: the likely range — it widens because the further ahead, the less certain</span>
              <span className="legend-dot"><span style={{ color: 'var(--pt-orange)' }}>◆</span> a change or one-off you added</span>
              {fc.breaches.length > 0 && <span className="legend-dot"><span className="swatch" style={{ background: 'rgba(176,70,50,.25)' }} />below your minimum cash</span>}
            </div>}
          </Panel>
          <details className="fold">
            <summary>See it by category</summary>
            <SimpleBreakdown b={b} />
          </details>
          {fc.markers.some((m) => m.kind !== 'treasury') && (
            <details className="fold">
              <summary>What you’ve added ({fc.markers.filter((m) => m.kind !== 'treasury').length})</summary>
              <ul className="list-plain small">{fc.markers.filter((m) => m.kind !== 'treasury').map((m, i) => <li key={i} className="row tight"><span className={`badge ${m.kind === 'oneoff' ? 'soft' : m.kind === 'schedule' ? 'green' : 'navy'}`}>{m.kind === 'oneoff' ? 'one-off' : m.kind === 'assumption' ? 'change' : m.kind}</span><span className="xs muted" style={{ width: 90 }}>{day(m.day)}</span><span>{m.label}</span></li>)}</ul>
            </details>
          )}
          {fc.register && fc.markers.some((m) => m.kind === 'treasury') && (
            <details className="fold">
              <summary>Coming up from your deal register ({fc.markers.filter((m) => m.kind === 'treasury').length})</summary>
              <ul className="list-plain small">{fc.markers.filter((m) => m.kind === 'treasury').map((m, i) => <li key={i} className="row tight"><span className={`badge ${(m.amount ?? 0) < 0 ? 'navy' : 'green'}`}>{(m.amount ?? 0) < 0 ? 'out' : 'in'}</span><span className="xs muted" style={{ width: 90 }}>{day(m.day)}</span><span>{m.label}</span></li>)}</ul>
            </details>
          )}
        </div>
      )}
      {tab === 'options' && !locked && <StrategyView b={b} />}
      {tab === 'report' && !locked && <SaveStep embedded />}
      {tab === 's-start' && <><RegisterCard /><SimpleStart sc={sc} upd={upd} b={b} /></>}
      {tab === 'before' && space === 'example' && <PracticeNote>Add what you know that history can’t: try <strong>A one-off amount</strong>, say a £5m land sale in September, and watch the borrowing figure above change. Then check the starting cash, and add the deal register under <strong>Loans and investments</strong>.</PracticeNote>}
      {tab === 'before' && (
        <div className="before-tab">
          <div className="before-col">
            <section><SimpleItems sc={sc} upd={upd} /></section>
            <section><h3>Loans and investments {!useStore.getState().register && <span className="muted small">(optional)</span>}</h3><RegisterCard /></section>
          </div>
          <section><h3>Your starting point</h3><SimpleStart sc={sc} upd={upd} b={b} /></section>
        </div>
      )}
      {tab === 'lines' && <BuildView sc={sc} upd={upd} b={b} />}
      {tab === 's-items' && <SimpleItems sc={sc} upd={upd} />}
      {tab === 's-breakdown' && !locked && <SimpleBreakdown b={b} />}
      {tab === 'setup' && <div style={{ maxWidth: 640 }}><SetupSection sc={sc} upd={upd} b={b} /></div>}
      {tab === 'growth' && <MethodsSection sc={sc} upd={upd} b={b} />}
      {tab === 'changes' && <div style={{ maxWidth: 860 }}><AssumptionsSection sc={sc} upd={upd} /></div>}
      {tab === 'oneoffs' && <div style={{ maxWidth: 860 }}><OneOffsSection sc={sc} upd={upd} /></div>}
      {tab === 'schedules' && <div style={{ maxWidth: 980 }}><PasteSection sc={sc} upd={upd} b={b} /></div>}
      {tab === 'breakdown' && !locked && (
        <div className="card card-pad">
          <div className="row mb"><Seg value={lower} onChange={setLower} options={[{ v: 'stacked', label: 'Chart by category' }, { v: 'explorer', label: 'One category in detail' }, { v: 'table', label: 'Full table' }]} /></div>
          {lower === 'stacked' && <StackedView b={b} granularity={gran} />}
          {lower === 'explorer' && <CategoryExplorer b={b} />}
          {lower === 'table' && <ForecastTable b={b} granularity={gran} />}
        </div>
      )}
      {tab === 'scenarios' && !locked && <div className="card card-pad"><CompareView /></div>}

      {locked && RESULT_TABS.includes(tab) ? null : locked && idx === firstResult - 1 ? (
        rv.allChecked
          ? <NextTab label="See my forecast" onClick={seeForecast} text="Every line is checked. Your forecast is ready." />
          : <NextTab label="Back to checking lines" onClick={() => setTab('lines')} text={`${rv.left.length || 'Some'} line${rv.left.length === 1 ? '' : 's'} still to check before the forecast can be shown.`} />
      ) : tab === 'lines' && locked && !rv.allChecked ? (
        <NextTab label={`Next: ${TABS[idx + 1].label.toLowerCase()}`} onClick={() => setTab(TABS[idx + 1].id)} text={`${rv.left.length} still to check. You can come back to them.`} />
      ) : idx < TABS.length - 1 ? <NextTab label={`Next: ${TABS[idx + 1].label.toLowerCase()}`} onClick={() => setTab(TABS[idx + 1].id)} text={tab === 'result' ? 'See what the forecast means for borrowing and investing.' : !locked && advanced ? <button className="link-btn" onClick={() => useStore.getState().goto('backtest')}>or go to the backtest</button> : undefined} />
        : !workspace && advanced && <StepFooter nextLabel="Next: test the forecast" />}
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
        <div className="mini-kpi"><div className="l">May need to borrow</div><div className="v">{money(fc.borrowingRequirement)}</div><div className="s">to keep {money(fc.buffer)}</div></div>
        <div className="mini-kpi"><div className="l">Lowest point</div><div className="v">{money(fc.low.amount)}</div><div className="s">{day(fc.low.day)}</div></div>
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
      {sc && team.forecasts.length > 1 && <button className="btn sm ghost" aria-label="Delete scenario" onClick={() => { void useStore.getState().askConfirm({ title: `Delete scenario “${sc.name}”?`, body: 'Its assumptions and figures will be removed.', ok: 'Delete', danger: true }).then((yes) => { if (yes) deleteScenario(sc.id); }); }}><i className="bi bi-trash" /></button>}
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

/** The forecast needs a history first: the saved one, or statements loaded under History. */
function ForecastStart() {
  const { historyBase, basis, useSavedHistory, goto, space, switchWorkspace, register, exampleBusy } = useStore();
  const days = basis ? basis.agg.D : historyDays(historyBase);
  const short = days > 0 && days < MIN_HISTORY_DAYS;
  if (exampleBusy) return <div className="page narrow"><div className="jobs-busy light"><span className="spinner" /> Setting up the example council: five years of statements, sorted…</div></div>;
  return (
    <div className={`page ${register ? '' : 'narrow'}`}>
      <PageHead title="Forecast">{short ? <>Your bank history covers {days === 1 ? 'one day' : `${days} days`}. A forecast needs at least six months to see a pattern; three to five years is ideal.</> : historyBase ? 'Built from your saved history.' : 'A forecast learns from your bank history, so load that first.'}</PageHead>
      <div className="start-choices">
        {historyBase && !short && <button className="start-choice primary" onClick={() => useSavedHistory()}><i className="bi bi-clock-history" /><strong>Use your saved history</strong><span>Pick up where you left off.</span></button>}
        <button className={`start-choice ${historyBase && !short ? '' : 'primary'}`} onClick={() => goto('load')}><i className="bi bi-file-earmark-arrow-up" /><strong>Load bank statements</strong><span>Three to five years is ideal.</span></button>
        {space === 'mine' && <button className="start-choice" onClick={() => void switchWorkspace('example')}><i className="bi bi-stars" /><strong>Practise on the example council</strong><span>Every step, with the files provided.</span></button>}
      </div>
      <section className="register-start">
        <h3>{register ? 'Your deal register on its own' : 'Meanwhile: your deal register'}</h3>
        {!register && <p className="small muted" style={{ marginTop: 0 }}>On its own it shows what you owe and hold, what falls due, and your liability benchmark.</p>}
        <RegisterCard />
        {register && <RegisterOverview r={register} />}
      </section>
    </div>
  );
}

/** Sign off the forecast as it stands, or show that this version already has been. */
function SignOffRow({ b, sc, onSee }: { b: ForecastBundle; sc: Scenario; onSee: () => void }) {
  const { team, user, setUser, askConfirm, signOff, toast, space } = useStore();
  const fc = b.fc;
  const mine = (team.signedOff ?? []).filter((x) => x.scenarioId === sc.id).sort((a, z) => a.signedAt.localeCompare(z.signedAt));
  const latest = mine[mine.length - 1];
  // the same forecast as the last sign-off: same period and the same headline
  const current = latest && latest.start === isoFromDay(fc.start) && latest.end === isoFromDay(fc.start + fc.H - 1) && latest.borrowingNeed === Math.round(fc.borrowingRequirement) && latest.low === Math.round(fc.low.amount);
  const sign = async () => {
    let name = user;
    const yes = await askConfirm({
      title: 'Sign off this forecast?',
      body: `It’s kept exactly as it stands (may need to borrow ${money(fc.borrowingRequirement)} by ${day(fc.low.day)}), and compared with what actually happens as new statements come in. You can still change the forecast afterwards; the signed-off version stays as it was.`,
      ok: 'Sign off',
      // the practice run signs as "You (practice)", and doesn't keep it as your name
      input: { label: 'Signed off by', value: space === 'example' ? user || 'You (practice)' : user, placeholder: 'Your name', onValue: (v) => { name = v; } },
    });
    if (!yes) return;
    if (name !== user && space !== 'example') setUser(name);
    signOff(fc, sc, undefined, name);
    toast(`Signed off. See it against what happens under Forecast vs actual.`);
  };
  return current ? (
    <div className="signoff-row on">
      <i className="bi bi-patch-check-fill" /> <span>Signed off on <strong>{day(dayFromISO(latest.signedAt.slice(0, 10)))}</strong> by <strong>{latest.signedBy}</strong>.</span>
      <button className="link-btn" onClick={onSee}>See it against what happens</button>
    </div>
  ) : (
    <div className="signoff-row">
      <span className="muted">{latest ? <>Changed since it was signed off on {day(dayFromISO(latest.signedAt.slice(0, 10)))}.</> : <>Happy with it? Sign it off to track it against what happens.</>}</span>
      <button className="btn sm navy" onClick={() => void sign()}><i className="bi bi-patch-check" /> Sign off this forecast</button>
    </div>
  );
}
