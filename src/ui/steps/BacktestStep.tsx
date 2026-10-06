import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, StepFooter, Seg, Empty, Money, Progress, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { engine, proxy } from '../../worker/client';
import type { BacktestResult, RollingResult } from '../../lib/forecast/backtest';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromYMD, ymdFromDay, isoFromDay, Day } from '../../lib/dates';

export function BacktestStep() {
  const { cat, ingest, team, workspace, activeScenarioId, catVersion } = useStore();
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  const fyStartMonth = +team.settings.financialYearStart.split('-')[0] || 4;
  const months = useMemo(() => {
    if (!ingest) return [] as Day[];
    const out: Day[] = [];
    const first = addMonths(ingest.minDay, 12), last = addMonths(ingest.maxDay, -3);
    for (let d = first; d <= last; d = addMonths(d, 1)) { const { y, m } = ymdFromDay(d); out.push(dayFromYMD(y, m, 1)); }
    return out;
  }, [ingest]);
  const [k, setK] = useState(() => Math.max(0, months.length - 22));
  const [horizon, setHorizon] = useState(12);
  const [withOneOffs, setWithOneOffs] = useState(false);
  const [r, setR] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const tabs: TabDef[] = [{ id: 'single', label: 'Forecast vs actual' }, { id: 'errors', label: 'Where the gaps came from' }, { id: 'rolling', label: 'Many start dates' }];
  const [tab, setTab] = useStepTab('backtest', tabs);
  const mode = tab === 'rolling' ? 'rolling' : 'single';
  const cutoff = months[Math.min(k, months.length - 1)];
  const settings = { lookbackYears: sc?.settings.lookbackYears ?? 3, recencyWeight: sc?.settings.recencyWeight ?? 0.7, methodByCategory: sc?.settings.methodByCategory ?? {} };

  useEffect(() => {
    if (!cat || cutoff === undefined || mode !== 'single') return;
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      void engine().backtest({ cutoff, horizonMonths: horizon, categories: team.categories, settings, includeActualOneOffs: withOneOffs, fyStartMonth }).then((x) => { if (live) { setR(x); setBusy(false); } });
    }, 150);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutoff, horizon, withOneOffs, catVersion, mode, JSON.stringify(settings)]);

  if (!cat || !ingest) return <div className="page"><Empty icon="bi-bullseye" title="Nothing to backtest yet">Load and categorise bank data first.</Empty></div>;
  return (
    <div className="page">
      <PageHead eyebrow={workspace ? 'Workspace' : 'Step 7 of 8'} title="Would the forecast have worked?">
        We pretend it’s an earlier date, forecast using only the data available then, and compare with what really happened.
      </PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'single' && <Explain compact
        what={<>Pick a past date with the slider. The orange dashed line is what the tool would have forecast on that date; the navy line is what actually happened. The blue dotted line is what happened <em>without</em> one-off items.</>}
        why="If the forecast tracked reality well before, you can trust it more now. It never sees data after the chosen date."
        todo="Slide to a few different dates. The gap between orange and blue is the model’s own error; the extra gap to navy is one-offs nobody could have known." />}
      {tab === 'errors' && <Explain compact what="Which categories the forecast over- or under-estimated, month by month, for the date chosen on the first tab." why="Shows where the forecast is weakest, so you know where your own judgement matters most." todo="Large errors in lumpy categories (land sales, one-off grants) are expected — add those as known one-offs when forecasting." />}
      {tab === 'rolling' && <Explain compact what="Runs the backtest from many start dates and averages how far out the forecast was, one month ahead, two months ahead and so on." why="One date can be lucky or unlucky; many dates give an honest picture of accuracy at each horizon." todo={<>Click <strong>Run</strong>. It takes a few seconds.</>} />}
      <div className="callout navy mb small"><strong>Remember:</strong> this shows how well the tool captures your regular cash rhythm; one-off items still need your judgement.</div>
      {mode === 'single' ? (
        <>
          <div className="card card-pad mb">
            <div className="row">
              <strong className="navy">Forecast as if it were</strong>
              <span className="big-number" style={{ fontSize: 22 }}>{cutoff !== undefined ? day(cutoff) : '–'}</span>
              <input type="range" min={0} max={Math.max(0, months.length - 1)} value={k} onChange={(e) => setK(+e.target.value)} style={{ flex: 1, accentColor: 'var(--pt-orange)' }} aria-label="Backtest start date" />
              <Seg value={horizon} onChange={setHorizon} options={[{ v: 6, label: '6 months' }, { v: 12, label: '12 months' }, { v: 24, label: '24 months' }]} />
              <label className="check"><input type="checkbox" checked={withOneOffs} onChange={(e) => setWithOneOffs(e.target.checked)} /> Pretend we knew the one-offs</label>
              {busy && <span className="spinner" />}
            </div>
            {r && <div className="xs muted mt">Learned only from data up to {day(r.usedDataTo)} · methods as in scenario “{sc?.name}”, without its forward-looking changes</div>}
          </div>
          {r && <SingleResult r={r} withOneOffs={withOneOffs} part={tab === 'errors' ? 'errors' : 'chart'} />}
          {tab === 'single' && <NextTab label="Next: where the gaps came from" onClick={() => setTab('errors')} />}
          {tab === 'errors' && <NextTab label="Next: many start dates" onClick={() => setTab('rolling')} />}
        </>
      ) : <Rolling horizon={horizon} setHorizon={setHorizon} settings={settings} fyStartMonth={fyStartMonth} />}
      {!workspace && <StepFooter nextLabel="Save and export" />}
    </div>
  );
}

function SingleResult({ r, withOneOffs, part }: { r: BacktestResult; withOneOffs: boolean; part: 'chart' | 'errors' }) {
  const x = Array.from({ length: r.H }, (_, d) => isoFromDay(r.cutoff + d));
  const e12 = r.errorAt[r.errorAt.length - 1];
  return (
    <div className="stack">
      {part === 'chart' && <div className="grid g4">
        {r.errorAt.map((e) => <Kpi key={e.months} label={`Gap after ${e.months} months`} value={money(e.error, { sign: true })} sub={`${pct(Math.abs(e.error) / Math.max(1, e.actualAbsFlow), 1)} of ${money(e.actualAbsFlow)} gross flow · core ${money(e.coreError, { sign: true })}`} />)}
        <Kpi label="Low point gap" value={money(r.lowForecast.amount - r.lowActual.amount, { sign: true })} sub={`forecast ${money(r.lowForecast.amount)} on ${day(r.lowForecast.day)} · actual ${money(r.lowActual.amount)} on ${day(r.lowActual.day)}`} />
      </div>}
      {part === 'chart' && <Panel title="Forecast vs what actually happened" sub="change in everyday cash position from the chosen date">
        <EChart height={400} option={{
          tooltip: { trigger: 'axis', valueFormatter: (v: number) => (v == null ? '–' : money(v)) },
          legend: { top: 0, right: 0, data: ['Forecast', 'Actual', 'Actual — predictable core', '90% range'] },
          grid: { left: 72, right: 16, top: 36, bottom: 40 },
          xAxis: { type: 'category', data: x, axisLabel: { formatter: (v: string) => v.slice(0, 7) } },
          yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
          series: [
            { name: '_lo', type: 'line', data: r.lowerCum, stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
            { name: '90% range', type: 'line', data: r.upperCum.map((u, k) => u - r.lowerCum[k]), stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(253,126,20,.14)' }, showSymbol: false, silent: true, itemStyle: { color: 'rgba(253,126,20,.4)' } },
            { name: 'Forecast', type: 'line', data: r.forecastCum, showSymbol: false, lineStyle: { color: '#fd7e14', width: 2.5, type: 'dashed' }, itemStyle: { color: '#fd7e14' } },
            { name: 'Actual', type: 'line', data: r.actualCum, showSymbol: false, lineStyle: { color: '#0a2540', width: 2.2 }, itemStyle: { color: '#0a2540' } },
            { name: 'Actual — predictable core', type: 'line', data: r.actualCoreCum, showSymbol: false, lineStyle: { color: '#2caffe', width: 1.5, type: 'dotted' }, itemStyle: { color: '#2caffe' } },
          ],
        }} />
        <div className="small muted">
          The gap between <strong>Actual</strong> and the <strong>predictable core</strong> is one-off items ({money(r.surpriseOneOffs)} net over the period){withOneOffs ? ' — included in the forecast here as if they had been known.' : '. Tick “include the actual one-offs” to isolate model error from surprise error.'}
          {e12 && <> At {e12.months} months the core error is {money(e12.coreError, { sign: true })}.</>}
        </div>
      </Panel>}
      {part === 'errors' && <div className="grid g2">
        <Panel title="Monthly net flow" sub="forecast vs actual">
          <EChart height={300} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
            legend: { top: 0, right: 0 },
            grid: { left: 72, right: 16, top: 30, bottom: 30 },
            xAxis: { type: 'category', data: r.monthly.labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            series: [
              { name: 'Forecast', type: 'bar', data: r.monthly.forecastNet, itemStyle: { color: '#fd7e14' } },
              { name: 'Actual', type: 'bar', data: r.monthly.actualNet, itemStyle: { color: '#0a2540' } },
            ],
          }} />
        </Panel>
        <Panel title="Which categories drove the error" flush>
          <div className="tbl-wrap" style={{ maxHeight: 340 }}>
            <table className="tbl">
              <thead><tr><th>Category</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Error</th><th className="num">Monthly MAPE</th></tr></thead>
              <tbody>{r.categories.map((c) => (
                <tr key={c.id} style={{ opacity: c.excluded ? 0.55 : 1 }}>
                  <td>{c.name}{c.excluded && <span className="badge grey" style={{ marginLeft: 6 }}>not modelled</span>}</td>
                  <td className="num"><Money v={c.forecast} /></td><td className="num"><Money v={c.actual} /></td>
                  <td className="num"><strong><Money v={c.error} /></strong></td><td className="num">{c.mape === null ? '–' : pct(c.mape, 0)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>
      </div>}
    </div>
  );
}

function Rolling({ horizon, setHorizon, settings, fyStartMonth }: { horizon: number; setHorizon: (h: number) => void; settings: { lookbackYears: number; recencyWeight: number; methodByCategory: Record<string, never> | Record<string, string> }; fyStartMonth: number }) {
  const { team } = useStore();
  const [res, setRes] = useState<RollingResult | null>(null);
  const [prog, setProg] = useState<number | null>(null);
  const run = async () => {
    setProg(0); setRes(null);
    const r = await engine().rolling({ horizonMonths: horizon, categories: team.categories, settings: settings as never, includeActualOneOffs: false, fyStartMonth }, proxy((k: number, n: number) => setProg(k / n)));
    setRes(r); setProg(null);
  };
  return (
    <div className="stack">
      <div className="card card-pad row">
        <strong className="navy">Run from many start dates and average the error by months ahead</strong>
        <Seg value={horizon} onChange={setHorizon} options={[{ v: 6, label: '6 months' }, { v: 12, label: '12 months' }, { v: 24, label: '24 months' }]} />
        <button className="btn primary" disabled={prog !== null} onClick={() => void run()}><i className="bi bi-play-fill" /> Run rolling backtest</button>
        {prog !== null && <div style={{ flex: 1 }}><Progress frac={prog} /></div>}
      </div>
      {res && (
        <>
          <div className="grid g3">
            <Kpi label="Start dates tested" value={String(res.cutoffs.length)} sub={`${day(res.cutoffs[0])} to ${day(res.cutoffs[res.cutoffs.length - 1])}`} />
            <Kpi label="Average error at 3 months" value={money(res.maeByMonth[2] ?? 0)} sub={`core ${money(res.coreMaeByMonth[2] ?? 0)}`} />
            <Kpi label={`Average error at ${horizon} months`} value={money(res.maeByMonth[horizon - 1] ?? 0)} sub={`core ${money(res.coreMaeByMonth[horizon - 1] ?? 0)} · typical monthly net swing ${money(res.avgMonthlyGross)}`} />
          </div>
          <Panel title="Accuracy as a function of horizon" sub="mean absolute error in the cumulative position">
            <EChart height={340} option={{
              tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
              legend: { top: 0, right: 0 },
              grid: { left: 72, right: 16, top: 30, bottom: 36 },
              xAxis: { type: 'category', data: res.maeByMonth.map((_, i) => `${i + 1}m`), name: 'months ahead', nameLocation: 'middle', nameGap: 24 },
              yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
              series: [
                { name: 'All operational flows', type: 'line', data: res.maeByMonth, lineStyle: { color: '#0a2540', width: 2.5 }, itemStyle: { color: '#0a2540' } },
                { name: 'Predictable core', type: 'line', data: res.coreMaeByMonth, lineStyle: { color: '#fd7e14', width: 2.5, type: 'dashed' }, itemStyle: { color: '#fd7e14' } },
              ],
            }} />
          </Panel>
          <Panel title="Each run" flush>
            <table className="tbl"><thead><tr><th>Start</th><th className="num">Error at 12m</th><th className="num">Low-point error</th></tr></thead>
              <tbody>{res.perRun.map((p) => <tr key={p.cutoff}><td>{day(p.cutoff)}</td><td className="num">{p.errorAt12 === null ? '–' : <Money v={p.errorAt12} />}</td><td className="num"><Money v={p.lowErr} /></td></tr>)}</tbody></table>
          </Panel>
        </>
      )}
    </div>
  );
}
