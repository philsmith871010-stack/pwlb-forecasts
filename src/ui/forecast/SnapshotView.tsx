import { useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, day, ago } from '../../lib/format';
import { UNCATEGORISED_COLOUR } from '../../lib/categories';

/** Saved forecasts from the team file, viewable without any CSV loaded. */
export function SnapshotForecastView() {
  const { team, goto } = useStore();
  const snaps = team.forecasts.filter((f) => f.resultsSnapshot);
  const [id, setId] = useState(snaps[0]?.id);
  const sc = snaps.find((s) => s.id === id) ?? snaps[0];
  const r = sc.resultsSnapshot!;
  const labels = r.periods.map((p) => p.slice(0, 7));
  const cat = (cid: string) => team.categories.find((c) => c.id === cid);
  const lowDay = Math.floor(Date.parse(r.low.date) / 864e5);
  return (
    <>
      <PageHead eyebrow="Saved in the team file" title={`Forecast: ${sc.name}`} actions={<>
        <select className="select" value={sc.id} onChange={(e) => setId(e.target.value)}>{snaps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button className="btn primary" onClick={() => goto('load')}><i className="bi bi-upload" /> Load CSVs to re-run</button></>}>
        Saved {ago(sc.updatedAt)}{sc.createdBy ? ` by ${sc.createdBy}` : ''}. This is the stored result — monthly totals only. Load the bank data to change assumptions and re-run.
      </PageHead>
      <div className="stack">
        <div className="grid g3">
          <Kpi label="Projected low point" value={money(r.low.amount)} sub={day(lowDay)} />
          <Kpi label="Projected high point" value={money(r.high.amount)} sub={day(Math.floor(Date.parse(r.high.date) / 864e5))} />
          <Kpi label="Assumptions & items" value={String(sc.assumptions.length + sc.oneOffs.length + sc.pastedSchedules.length)} sub={`${sc.settings.start} → ${sc.settings.end}`} />
        </div>
        <div className="summary-box"><div className="eyebrow">In plain English</div>{r.summary}</div>
        <Panel title="Cumulative operational position (month end)">
          <EChart height={360} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
            grid: { left: 72, right: 16, top: 16, bottom: 30 },
            xAxis: { type: 'category', data: labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
            series: [
              { type: 'line', data: r.lower, stack: 'b', lineStyle: { opacity: 0 }, showSymbol: false, silent: true },
              { type: 'line', data: r.upper.map((u, k) => u - r.lower[k]), stack: 'b', lineStyle: { opacity: 0 }, showSymbol: false, areaStyle: { color: 'rgba(253,126,20,.14)' }, silent: true },
              { name: 'Forecast', type: 'line', data: r.cumulative, lineStyle: { color: '#fd7e14', width: 2.5, type: 'dashed' }, itemStyle: { color: '#fd7e14' } },
            ],
          }} />
        </Panel>
        <Panel title="Monthly flows by category">
          <EChart height={380} option={{
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) },
            legend: { type: 'scroll', bottom: 0 },
            grid: { left: 72, right: 16, top: 16, bottom: 60 },
            xAxis: { type: 'category', data: labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            series: Object.entries(r.byCategory).map(([cid, v]) => ({ name: cat(cid)?.name ?? 'Uncategorised', type: 'bar', stack: v.reduce((s, x) => s + x, 0) >= 0 ? 'in' : 'out', data: v, itemStyle: { color: cat(cid)?.colour ?? UNCATEGORISED_COLOUR } })),
          }} />
        </Panel>
        {sc.assumptions.length > 0 && <Panel title="Assumptions"><ul className="list-plain small">{sc.assumptions.map((a) => <li key={a.id}><span className="badge navy">{a.kind}</span> {JSON.stringify({ ...a, id: undefined, kind: undefined }).replace(/[{}"]/g, '').replace(/,/g, ', ')}</li>)}</ul></Panel>}
      </div>
    </>
  );
}
