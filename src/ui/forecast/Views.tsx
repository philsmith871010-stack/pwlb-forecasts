import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import type { ForecastBundle } from './useForecast';
import { computeForecast } from './useForecast';
import { EChart, axisMoney } from '../components/EChart';
import { Money, Seg } from '../components/common';
import { periodise, sumByPeriod, lastByPeriod, Granularity } from '../../lib/forecast/engine';
import { monthlyTotals } from '../../lib/analysis/history';
import { money, pct, day } from '../../lib/format';
import { MONTH_NAMES, ymdFromDay } from '../../lib/dates';
import { UNCATEGORISED_COLOUR } from '../../lib/categories';
import { downloadText } from '../../lib/teamfile';

function useCat() {
  const categories = useStore((s) => s.team.categories);
  return (id: string) => categories.find((c) => c.id === id);
}

// ------------------------------------------------------------------ stacked by category

export function StackedView({ b }: { b: ForecastBundle; granularity?: Granularity }) {
  const cat = useCat();
  const [granularity, setGran] = useState<Granularity>('monthly');
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const { fc } = b;
  const option = useMemo(() => {
    const g: Granularity = granularity === 'daily' && fc.H > 200 ? 'weekly' : granularity;
    const p = periodise(fc.start, fc.H, g);
    const n = p.labels.length;
    const series = fc.catIds.map((id, c) => ({ id, v: sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, n) })).filter((s) => s.v.some((x) => Math.abs(x) > 1));
    const net = sumByPeriod(fc.net, 0, fc.H, p.index, n);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v), confine: true },
      legend: { type: 'scroll', bottom: 0, selected: hidden },
      grid: { left: 72, right: 16, top: 16, bottom: 64 },
      xAxis: { type: 'category', data: p.labels },
      yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
      dataZoom: n > 40 ? [{ type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false }] : undefined,
      series: [
        ...series.map((s) => ({ name: cat(s.id)?.name ?? 'Uncategorised', type: 'bar', stack: s.v.reduce((a, x) => a + x, 0) >= 0 ? 'in' : 'out', data: s.v, itemStyle: { color: cat(s.id)?.colour ?? UNCATEGORISED_COLOUR }, emphasis: { focus: 'series' } })),
        { name: 'Net', type: 'line', data: net, lineStyle: { color: '#0a2540', width: 2 }, itemStyle: { color: '#0a2540' }, symbolSize: 4, z: 10 },
      ],
    };
  }, [fc, granularity, hidden, cat]);
  return (
    <>
      <div className="row mb"><span className="small muted">Forecast receipts (up) and payments (down) by category. Click legend items to toggle categories.</span><span className="spacer" />
        <Seg value={granularity} onChange={setGran} options={[{ v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} /></div>
      <EChart option={option} height={400} onReady={(c) => c.on('legendselectchanged', (e) => setHidden((e as { selected: Record<string, boolean> }).selected))} ariaLabel="Forecast receipts and payments by category" />
    </>
  );
}

// ------------------------------------------------------------------ category explorer

export function CategoryExplorer({ b }: { b: ForecastBundle }) {
  const cat = useCat();
  const agg = useStore((s) => s.agg);
  const modelled = b.fc.explain.filter((e) => e.method !== 'exclude' || e.historyAnnual);
  const [id, setId] = useState(modelled.find((e) => e.id === 'salaries')?.id ?? modelled[0]?.id ?? '');
  const e = b.fc.explain.find((x) => x.id === id);
  const option = useMemo(() => {
    if (!agg || !e) return null;
    const ms = monthlyTotals(agg, 'op');
    const c = e.catIdx;
    const p = periodise(b.fc.start, b.fc.H, 'monthly');
    const fcm = sumByPeriod(b.fc.daily, c * b.fc.H, b.fc.H, p.index, p.labels.length);
    const labels = [...ms.labels, ...p.labels];
    const hist = [...ms.values[c], ...new Array(p.labels.length).fill(null)];
    const fut = [...new Array(ms.labels.length - 1).fill(null), ms.values[c][ms.labels.length - 1], ...fcm];
    const colour = cat(id)?.colour ?? UNCATEGORISED_COLOUR;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => (v == null ? '–' : money(v)) },
      legend: { top: 0, right: 0 },
      grid: { left: 72, right: 16, top: 30, bottom: 50 },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
      dataZoom: [{ type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false }, { type: 'slider', height: 16, bottom: 6 }],
      series: [
        { name: 'History', type: 'bar', data: hist, itemStyle: { color: colour } },
        { name: 'Forecast', type: 'bar', data: fut.map((v, k) => (k < ms.labels.length ? null : v)), itemStyle: { color: colour, opacity: 0.45, borderColor: colour, borderWidth: 1, borderType: 'dashed' } },
      ],
    };
  }, [agg, e, b, id, cat]);
  if (!e) return null;
  const yearly = (() => {
    const out = new Map<string, number>();
    for (let d = 0; d < b.fc.H; d++) {
      const { y, m } = ymdFromDay(b.fc.start + d);
      const fy = m >= 4 ? y : y - 1;
      const k = `${fy}/${String((fy + 1) % 100).padStart(2, '0')}`;
      out.set(k, (out.get(k) ?? 0) + b.fc.daily[e.catIdx * b.fc.H + d]);
    }
    return [...out.entries()];
  })();
  return (
    <div className="grid g-side">
      <div>
        <div className="row mb"><strong className="navy">Category</strong>
          <select className="select" style={{ maxWidth: 320 }} value={id} onChange={(ev) => setId(ev.target.value)}>{modelled.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        {option && <EChart option={option} height={340} />}
        <div className="row small mt">{yearly.map(([k, v]) => <span key={k} className="chip navy">{k}: <strong>{money(v)}</strong></span>)}</div>
      </div>
      <div className="card card-pad" style={{ boxShadow: 'none' }}>
        <h4>How this is forecast</h4>
        <dl className="kv">
          <dt>Method</dt><dd>{({ seasonal: 'Seasonal profile × trend', series: 'Recurring series schedule', flat: 'Flat average', manual: 'Manual only', exclude: 'Excluded' } as Record<string, string>)[e.method]}</dd>
          <dt>Growth</dt><dd>{pct(e.growthPct / 100, 1, true)} p.a. <span className="muted xs">({e.growthSource === 'assumption' ? `your assumption, ${e.growthMode === 'annual_step' ? 'stepping each April' : 'continuous'}` : e.growthSource === 'historic' ? 'historic trend' : 'none'})</span></dd>
          {e.inflationPct ? <><dt>Inflation</dt><dd>+{e.inflationPct}% overlay</dd></> : null}
          <dt>Last 12 months</dt><dd>{money(e.historyAnnual)}</dd>
          <dt>Forecast total</dt><dd>{money(e.forecastTotal)}</dd>
          <dt>Within-month timing</dt><dd>{({ day_of_month: 'historic day-of-month pattern', weekday: 'historic weekday pattern', even: 'spread over business days', series: 'each series on its own dates' } as Record<string, string>)[e.distribution]}</dd>
          <dt>Monthly variability</dt><dd>± {money(e.sigmaMonthly)} (1σ)</dd>
        </dl>
        {e.series.length > 0 && (
          <>
            <h4 className="mt">Recurring series projected</h4>
            <table className="tbl"><thead><tr><th>Series</th><th className="num">Level</th><th>Next</th></tr></thead>
              <tbody>{e.series.map((s, i) => <tr key={i} style={{ opacity: s.projected ? 1 : 0.5 }}><td className="mono xs">{s.signature}<div className="muted">{s.cadence.replace('_', '-')}{s.active ? '' : ' · stopped'}</div></td><td className="num"><Money v={s.level} /></td><td className="xs">{s.next ? day(s.next) : '—'}</td></tr>)}</tbody></table>
          </>
        )}
        {e.method !== 'series' && e.profile.some((v) => v) && (
          <>
            <h4 className="mt">Typical month (base level)</h4>
            <EChart height={120} option={{ animation: false, grid: { left: 4, right: 4, top: 6, bottom: 18 }, xAxis: { type: 'category', data: MONTH_NAMES.map((m) => m[0]), axisLabel: { fontSize: 9 } }, yAxis: { show: false, type: 'value' }, tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, series: [{ type: 'bar', data: e.profile, itemStyle: { color: cat(id)?.colour ?? '#ced4da' } }] }} />
          </>
        )}
        {e.clamps.length > 0 && <div className="callout small mt"><strong>Down-weighted months:</strong> {e.clamps.slice(0, 5).map((c) => `${MONTH_NAMES[c.month - 1]} ${c.year} (${money(c.value)} → ${money(c.clampedTo)})`).join('; ')}{e.clamps.length > 5 ? '…' : ''}</div>}
        {e.notes.map((n, i) => <div key={i} className="xs muted mt">{n}</div>)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ table

export function ForecastTable({ b, granularity }: { b: ForecastBundle; granularity: Granularity }) {
  const cat = useCat();
  const [g, setG] = useState<Granularity>(granularity === 'daily' ? 'weekly' : granularity);
  const { fc } = b;
  const p = useMemo(() => periodise(fc.start, fc.H, g), [fc, g]);
  const n = p.labels.length;
  const rows = useMemo(() => fc.catIds.map((id, c) => ({ id, v: sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, n) })).filter((r) => r.v.some((x) => Math.abs(x) > 1)), [fc, p, n]);
  const net = sumByPeriod(fc.net, 0, fc.H, p.index, n);
  const cum = lastByPeriod(fc.cumulative, fc.H, p.index, n);
  const name = (id: string) => cat(id)?.name ?? 'Uncategorised';
  const exportCsv = () => {
    const lines = [['Category', ...p.labels, 'Total'].join(',')];
    for (const r of rows) lines.push([`"${name(r.id)}"`, ...r.v.map((x) => x.toFixed(0)), r.v.reduce((s, x) => s + x, 0).toFixed(0)].join(','));
    lines.push(['Net', ...net.map((x) => x.toFixed(0)), net.reduce((s, x) => s + x, 0).toFixed(0)].join(','));
    lines.push(['Cumulative position', ...cum.map((x) => x.toFixed(0)), ''].join(','));
    downloadText(lines.join('\n'), 'forecast-table.csv', 'text/csv');
  };
  return (
    <div>
      <div className="row mb"><Seg value={g} onChange={setG} options={[{ v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} /><span className="spacer" /><button className="btn sm" onClick={exportCsv}><i className="bi bi-download" /> CSV</button></div>
      <div className="tbl-wrap tall" style={{ border: '1px solid var(--pt-line)', borderRadius: 10 }}>
        <table className="tbl">
          <thead><tr><th style={{ position: 'sticky', left: 0, zIndex: 3 }}>Category</th>{p.labels.map((l) => <th key={l} className="num">{l}</th>)}<th className="num">Total</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}><td style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }} className="nowrap"><span className="swatch" style={{ background: cat(r.id)?.colour ?? UNCATEGORISED_COLOUR, marginRight: 6 }} />{name(r.id)}</td>
                {r.v.map((x, k) => <td key={k} className="num"><Money v={x} /></td>)}<td className="num"><strong><Money v={r.v.reduce((s, x) => s + x, 0)} /></strong></td></tr>
            ))}
            <tr className="total"><td style={{ position: 'sticky', left: 0, background: 'var(--pt-line-soft)' }}>Net operational flow</td>{net.map((x, k) => <td key={k} className="num"><Money v={x} /></td>)}<td className="num"><Money v={net.reduce((s, x) => s + x, 0)} /></td></tr>
            <tr className="total"><td style={{ position: 'sticky', left: 0, background: 'var(--pt-line-soft)' }}>Cumulative position</td>{cum.map((x, k) => <td key={k} className="num" style={{ color: x < fc.buffer ? 'var(--pt-red)' : undefined }}><Money v={x} /></td>)}<td /></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ compare scenarios

export function CompareView() {
  const { team, basis, compareIds, setCompare } = useStore();
  const fyStart = +team.settings.financialYearStart.split('-')[0] || 4;
  const register = useStore((s) => s.register);
  const results = useMemo(() => (basis ? compareIds.map((id) => team.forecasts.find((f) => f.id === id)).filter(Boolean).map((sc) => ({ sc: sc!, b: computeForecast(basis, sc!, team.categories, team.settings.liquidityBuffer, fyStart, register) })) : []), [basis, compareIds, team, fyStart, register]);
  const colours = ['#0a2540', '#fd7e14', '#2caffe'];
  return (
    <div className="stack">
      <div className="row"><strong className="navy">Compare up to three scenarios:</strong>
        {team.forecasts.map((f) => (
          <label key={f.id} className="check"><input type="checkbox" checked={compareIds.includes(f.id)} disabled={!compareIds.includes(f.id) && compareIds.length >= 3} onChange={(e) => setCompare(e.target.checked ? [...compareIds, f.id] : compareIds.filter((x) => x !== f.id))} /> {f.name}</label>
        ))}
      </div>
      {results.length === 0 ? <p className="muted small">Tick scenarios above to compare them.</p> : (
        <>
          <EChart height={380} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
            legend: { top: 0, right: 0 },
            grid: { left: 72, right: 16, top: 30, bottom: 40 },
            xAxis: { type: 'time' },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
            series: results.map((r, i) => ({ name: r.sc.name, type: 'line', showSymbol: false, sampling: 'lttb', lineStyle: { width: 2.2, color: colours[i], type: i === 0 ? 'solid' : i === 1 ? 'dashed' : 'dotted' }, itemStyle: { color: colours[i] },
              data: Array.from(r.b.fc.cumulative, (v, d) => [(r.b.fc.start + d) * 864e5, v]) })),
          }} />
          <table className="tbl">
            <thead><tr><th>Scenario</th><th className="num">Low point</th><th>Date</th><th className="num">Borrowing requirement</th><th className="num">High point</th><th className="num">Position at horizon</th><th className="num">Assumptions</th></tr></thead>
            <tbody>{results.map((r, i) => (
              <tr key={r.sc.id}><td><span className="swatch" style={{ background: colours[i], marginRight: 6 }} />{r.sc.name}</td>
                <td className="num"><Money v={r.b.fc.low.amount} /></td><td className="xs">{day(r.b.fc.low.day)}</td><td className="num"><strong>{money(r.b.fc.borrowingRequirement)}</strong></td>
                <td className="num"><Money v={r.b.fc.high.amount} /></td><td className="num"><Money v={r.b.fc.cumulative[r.b.fc.H - 1]} /></td><td className="num">{r.sc.assumptions.length + r.sc.oneOffs.length + r.sc.pastedSchedules.length}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
