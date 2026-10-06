import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, StepFooter, Seg, Empty, CatBadge, Money, Kpi } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { TxnTable } from '../components/TxnTable';
import { annualTotals, yearsOf, positions, cagr, seasonalProfile, dayOfMonthProfile, detectBreaks, monthlyTotals, extremes, YearMode } from '../../lib/analysis/history';
import { money, pct, day, int, iso } from '../../lib/format';
import { fmtDay, isoFromDay, Day, ymdFromDay } from '../../lib/dates';
import { UNCATEGORISED_COLOUR, Category, GROUP_LABELS } from '../../lib/categories';
import { engine } from '../../worker/client';
import type { CategoryDetail } from '../../worker/types';
import { downloadText } from '../../lib/teamfile';
import { HistorySnapshotView } from './HistorySnapshot';

type Tab = 'overview' | 'yoy' | 'season' | 'category' | 'recurring' | 'quality';

export function useHistoryData(mode: YearMode) {
  const agg = useStore((s) => s.agg);
  const team = useStore((s) => s.team);
  const fyStartMonth = +team.settings.financialYearStart.split('-')[0] || 4;
  return useMemo(() => {
    if (!agg) return null;
    const years = yearsOf(agg, mode, fyStartMonth);
    const annual = annualTotals(agg, years);
    const pos = positions(agg);
    const C = agg.catIds.length;
    const cats: (Category | undefined)[] = [...agg.catIds.map((id) => team.categories.find((c) => c.id === id)), undefined];
    const colour = (c: number) => cats[c]?.colour ?? UNCATEGORISED_COLOUR;
    const name = (c: number) => (c === C ? 'Uncategorised' : cats[c]?.name ?? agg.catIds[c]);
    const opCats = cats.map((c, i) => ({ c, i })).filter(({ c, i }) => (c ? c.group === 'receipts_operational' || c.group === 'payments_operational' : i === C) && annual.op[i].some((v) => v));
    return { agg, years, annual, pos, C, cats, colour, name, opCats, fyStartMonth };
  }, [agg, mode, fyStartMonth, team.categories]);
}

export function HistoryStep() {
  const agg = useStore((s) => s.agg);
  const hasSummary = useStore((s) => !!s.team.historySummary);
  const workspace = useStore((s) => s.workspace);
  const [tab, setTab] = useState<Tab>('overview');
  const [mode, setMode] = useState<YearMode>('fy');
  const h = useHistoryData(mode);
  if (!agg) {
    return <div className="page">{hasSummary ? <HistorySnapshotView /> : <Empty icon="bi-bar-chart-line" title="No history yet">Load and categorise bank data first.</Empty>}</div>;
  }
  return (
    <div className="page">
      <PageHead eyebrow={workspace ? 'Workspace' : 'Step 5 of 8'} title="How your cash has behaved"
        actions={<Seg value={mode} onChange={setMode} options={[{ v: 'fy', label: 'Financial year' }, { v: 'calendar', label: 'Calendar year' }]} />}>
        Operational flows only, unless stated — treasury deals are shown as their own layer so you can compare operational cash with the actual position.
      </PageHead>
      <div className="tabs" role="tablist">
        {([['overview', 'Overview', 'bi-speedometer2'], ['yoy', 'Year on year', 'bi-calendar3'], ['season', 'Seasonality', 'bi-water'], ['category', 'Category deep dive', 'bi-search'], ['recurring', 'Recurring vs one-off', 'bi-arrow-repeat'], ['quality', 'Data quality', 'bi-clipboard-check']] as [Tab, string, string][]).map(([k, l, i]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><i className={`bi ${i}`} /> {l}</button>
        ))}
      </div>
      {h && tab === 'overview' && <Overview h={h} />}
      {h && tab === 'yoy' && <YoY h={h} />}
      {h && tab === 'season' && <Seasonality h={h} mode={mode} />}
      {h && tab === 'category' && <CategoryDeepDive h={h} />}
      {h && tab === 'recurring' && <RecurringView h={h} />}
      {h && tab === 'quality' && <DataQuality />}
      {!workspace && <StepFooter nextLabel="Build the forecast" />}
    </div>
  );
}

type H = NonNullable<ReturnType<typeof useHistoryData>>;

// ------------------------------------------------------------------ overview

function Overview({ h }: { h: H }) {
  const [overlay, setOverlay] = useState(true);
  const { agg, years, annual, pos, opCats, colour, name } = h;
  const dates = useMemo(() => Array.from({ length: agg.D }, (_, d) => isoFromDay(agg.startDay + d)), [agg]);
  const cards = years.map((y, yi) => {
    let rec = 0, pay = 0, tr = 0;
    for (const { c, i } of opCats) { const v = annual.op[i][yi]; if (c?.group === 'receipts_operational' || (!c && v > 0)) rec += v; else pay += v; }
    for (let c = 0; c < annual.treasury.length; c++) tr += Math.abs(annual.treasury[c][yi]);
    const ex = extremes(pos.operational, agg.startDay, Math.max(y.start, agg.startDay), Math.min(y.end, agg.startDay + agg.D - 1));
    return { y, rec, pay, net: rec + pay, tr, ex };
  });
  // gross treasury volume per year needs abs of daily flows, not net totals
  const trVol = years.map((y) => { let s = 0; for (let c = 0; c <= h.C; c++) for (let d = Math.max(0, y.start - agg.startDay); d <= Math.min(agg.D - 1, y.end - agg.startDay); d++) s += Math.abs(agg.treasury[c * agg.D + d]); return s; });
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(cards.length, 6)}, minmax(0,1fr))` }}>
        {cards.map((k, i) => (
          <div key={k.y.key} className="kpi" style={{ minHeight: 0 }}>
            <div className="kpi-label">{k.y.label}{!k.y.complete && <span className="badge soft" style={{ marginLeft: 6 }}>part</span>}</div>
            <div className={`kpi-value ${k.net >= 0 ? '' : ''}`} style={{ fontSize: 24 }}>{money(k.net, { sign: true })}</div>
            <div className="kpi-sub">net operational flow</div>
            <dl className="kv mt" style={{ fontSize: 12, gridTemplateColumns: 'auto 1fr', color: 'rgba(255,255,255,.85)' }}>
              <dt style={{ color: 'rgba(255,255,255,.6)' }}>Receipts</dt><dd style={{ color: '#fff' }}>{money(k.rec)}</dd>
              <dt style={{ color: 'rgba(255,255,255,.6)' }}>Payments</dt><dd style={{ color: '#fff' }}>{money(k.pay)}</dd>
              <dt style={{ color: 'rgba(255,255,255,.6)' }}>Treasury</dt><dd style={{ color: '#fff' }}>{money(trVol[i])} traded</dd>
              <dt style={{ color: 'rgba(255,255,255,.6)' }}>Low</dt><dd style={{ color: '#fff' }}>{money(k.ex.min)} <span style={{ color: 'rgba(255,255,255,.6)', fontWeight: 400 }}>{fmtDay(k.ex.minDay)}</span></dd>
              <dt style={{ color: 'rgba(255,255,255,.6)' }}>High</dt><dd style={{ color: '#fff' }}>{money(k.ex.max)} <span style={{ color: 'rgba(255,255,255,.6)', fontWeight: 400 }}>{fmtDay(k.ex.maxDay)}</span></dd>
            </dl>
          </div>
        ))}
      </div>
      <Panel title="Cumulative operational cash position" sub={`from an opening balance of ${money(agg.openingBalance)}${agg.openingKnown ? ' (from balance columns)' : ' (assumed)'}`}
        right={<label className="check" style={{ color: '#fff', fontSize: 12.5 }}><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> show actual position incl. treasury</label>}>
        <EChart height={360} ariaLabel="Cumulative operational cash position over the full history" option={{
          tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
          legend: { top: 0, right: 0 },
          grid: { left: 70, right: 20, top: 36, bottom: 60 },
          xAxis: { type: 'category', data: dates, axisLabel: { formatter: (v: string) => v.slice(0, 7) } },
          yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
          dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 10, borderColor: 'transparent', fillerColor: 'rgba(253,126,20,.15)' }],
          series: [
            { name: 'Operational position', type: 'line', data: Array.from(pos.operational), showSymbol: false, lineStyle: { width: 2, color: '#0a2540' }, areaStyle: { color: 'rgba(10,37,64,.06)' }, sampling: 'lttb',
              markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#adb5bd', type: 'dashed' }, label: { show: false } } },
            ...(overlay ? [{ name: 'Actual position incl. treasury', type: 'line', data: Array.from(pos.actual), showSymbol: false, lineStyle: { width: 1.5, color: '#fd7e14' }, sampling: 'lttb' }] : []),
          ],
        }} />
        <div className="small muted">The gap between the lines is cumulative net treasury activity: borrowing taken (raises actual cash) less investments placed and loans repaid.</div>
      </Panel>
      <Panel title="Annual receipts and payments by category" sub="operational, stacked">
        <EChart height={400} option={{
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) },
          legend: { type: 'scroll', bottom: 0 },
          grid: { left: 70, right: 20, top: 16, bottom: 60 },
          xAxis: { type: 'category', data: years.map((y) => y.label + (y.complete ? '' : '*')) },
          yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
          series: opCats.map(({ i }) => ({ name: name(i), type: 'bar', stack: annual.op[i].reduce((s, v) => s + v, 0) >= 0 ? 'in' : 'out', data: annual.op[i], itemStyle: { color: colour(i) }, emphasis: { focus: 'series' } })),
        }} />
        <div className="xs muted">* part year</div>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ YoY

function YoY({ h }: { h: H }) {
  const { years, annual, opCats, colour, name, cats } = h;
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: 'abs', dir: -1 });
  const [filter, setFilter] = useState('');
  const [wf, setWf] = useState<[number, number]>([Math.max(0, years.findIndex((y) => y.complete)), years.length - 1 - (years[years.length - 1].complete ? 0 : 1)]);
  const rows = opCats.map(({ c, i }) => {
    const vals = annual.op[i];
    const g = cagr(vals, years);
    return { i, c, vals, g, abs: vals.reduce((s, v) => s + Math.abs(v), 0), last: vals[vals.length - 1] };
  }).filter((r) => !filter || name(r.i).toLowerCase().includes(filter.toLowerCase()) || (r.c && GROUP_LABELS[r.c.group].toLowerCase().includes(filter.toLowerCase())));
  rows.sort((a, b) => {
    const va = sort.k === 'abs' ? a.abs : sort.k === 'cagr' ? a.g ?? -9 : sort.k === 'name' ? 0 : a.vals[+sort.k];
    const vb = sort.k === 'abs' ? b.abs : sort.k === 'cagr' ? b.g ?? -9 : sort.k === 'name' ? 0 : b.vals[+sort.k];
    if (sort.k === 'name') return name(a.i).localeCompare(name(b.i)) * sort.dir;
    return (va - vb) * sort.dir;
  });
  const th = (k: string, label: string) => <th className={`num sortable`} onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : -1 })}>{label}{sort.k === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  const tint = (x: number | null, flowSign: number) => {
    if (x === null || !isFinite(x)) return undefined;
    // growth in a payment line is "bad" for cash: colour by effect on cash
    const good = x * flowSign > 0;
    const a = Math.min(0.35, Math.abs(x) * 1.5);
    return good ? `rgba(40,167,69,${a})` : `rgba(176,70,50,${a})`;
  };
  const exportCsv = () => {
    const head = ['Category', ...years.map((y) => y.label), ...years.slice(1).map((y) => `YoY ${y.label} £`), ...years.slice(1).map((y) => `YoY ${y.label} %`), 'CAGR'];
    const lines = [head.join(',')];
    for (const r of rows) lines.push([`"${name(r.i)}"`, ...r.vals.map((v) => v.toFixed(2)), ...r.vals.slice(1).map((v, k) => (v - r.vals[k]).toFixed(2)), ...r.vals.slice(1).map((v, k) => (r.vals[k] ? ((v / r.vals[k] - 1) * 100).toFixed(1) : '')), r.g === null ? '' : (r.g * 100).toFixed(2)].join(','));
    downloadText(lines.join('\n'), 'year-on-year.csv', 'text/csv');
  };
  // waterfall
  const [ya, yb] = wf;
  const deltas = opCats.map(({ i }) => ({ i, d: annual.op[i][yb] - annual.op[i][ya] })).filter((x) => Math.abs(x.d) > 1).sort((a, b) => b.d - a.d);
  const netA = opCats.reduce((s, { i }) => s + annual.op[i][ya], 0), netB = opCats.reduce((s, { i }) => s + annual.op[i][yb], 0);
  let run = netA;
  const wfBase: number[] = [0], wfUp: (number | string)[] = [netA], wfDown: (number | string)[] = ['-'], wfLabels = [`Net ${years[ya].label}`];
  for (const x of deltas) {
    wfLabels.push(name(x.i));
    if (x.d >= 0) { wfBase.push(run); wfUp.push(x.d); wfDown.push('-'); run += x.d; }
    else { run += x.d; wfBase.push(run); wfUp.push('-'); wfDown.push(-x.d); }
  }
  wfLabels.push(`Net ${years[yb].label}`); wfBase.push(0); wfUp.push(netB); wfDown.push('-');
  return (
    <div className="stack">
      <Panel title="Every category, every year" sub="£ totals, change and compound annual growth" right={<><input className="input sm" style={{ width: 180 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} /><button className="btn sm on-dark" onClick={exportCsv}><i className="bi bi-download" /> CSV</button></>} flush>
        <div className="tbl-wrap tall">
          <table className="tbl">
            <thead><tr><th className="sortable" onClick={() => setSort({ k: 'name', dir: sort.k === 'name' ? (-sort.dir as 1 | -1) : 1 })}>Category</th>
              {years.map((y, k) => th(String(k), y.label + (y.complete ? '' : '*')))}
              {years.slice(1).map((y) => <th key={y.key} className="num">Δ {y.label}</th>)}
              {th('cagr', 'CAGR')}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const sign = r.last >= 0 ? 1 : -1;
                return (
                  <tr key={r.i}>
                    <td><CatBadge cat={cats[r.i]} uncategorised={!cats[r.i]} /></td>
                    {r.vals.map((v, k) => <td key={k} className="num"><Money v={v} /></td>)}
                    {r.vals.slice(1).map((v, k) => {
                      const prev = r.vals[k];
                      const g = prev && years[k].complete && years[k + 1].complete ? v / prev - 1 : null;
                      return <td key={k} className="num" style={{ background: tint(g, sign) }} title={`${money(v - prev, { sign: true })}`}>{g === null ? <span className="muted">{money(v - prev, { sign: true })}</span> : <>{pct(g, 1, true)}<div className="xs muted">{money(v - prev, { sign: true })}</div></>}</td>;
                    })}
                    <td className="num" style={{ background: tint(r.g, sign), fontWeight: 700 }}>{r.g === null ? '–' : pct(r.g, 1, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="xs muted card-pad" style={{ paddingTop: 8 }}>Colour shows the effect on cash: green where receipts grow or payments shrink, red the reverse. Changes for part years are shown in £ only. CAGR uses complete years.</div>
      </Panel>
      <Panel title="Small multiples" sub="each category’s annual total — what is growing, shrinking or volatile">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {opCats.map(({ i }) => {
            const g = cagr(annual.op[i], years);
            return (
              <div key={i} className="card" style={{ padding: '8px 10px', boxShadow: 'none' }}>
                <div className="row tight xs"><span className="swatch" style={{ background: colour(i) }} /><strong className="navy ellipsis" style={{ maxWidth: 140 }}>{name(i)}</strong><span className="spacer" />{g !== null && <span className={g * Math.sign(annual.op[i][annual.op[i].length - 1] || 1) >= 0 ? 'pos' : 'neg'}>{pct(g, 1, true)}</span>}</div>
                <EChart height={70} option={{ animation: false, grid: { left: 2, right: 2, top: 6, bottom: 2 }, xAxis: { type: 'category', show: false, data: years.map((y) => y.label) }, yAxis: { type: 'value', show: false, min: (v: { min: number }) => Math.min(0, v.min) }, tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, series: [{ type: 'bar', data: annual.op[i].map((v, k) => ({ value: v, itemStyle: { color: colour(i), opacity: years[k].complete ? 1 : 0.4 } })), barWidth: '60%' }] }} />
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel title="What drove the change in net operational flow" right={<div className="row tight">
        <select className="select sm" value={ya} onChange={(e) => setWf([+e.target.value, yb])}>{years.map((y, k) => <option key={k} value={k}>{y.label}</option>)}</select>
        <span style={{ color: '#fff' }}>→</span>
        <select className="select sm" value={yb} onChange={(e) => setWf([ya, +e.target.value])}>{years.map((y, k) => <option key={k} value={k}>{y.label}</option>)}</select></div>}>
        <EChart height={380} option={{
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: { name: string; seriesName: string; value: number | string }[]) => { const p = ps.find((x) => x.seriesName !== 'base' && x.value !== '-'); return p ? `${p.name}<br/><b>${money(p.seriesName === 'down' ? -(p.value as number) : (p.value as number), { sign: p.seriesName !== 'up' || p.name.startsWith('Net') ? false : true })}</b>` : ''; } },
          grid: { left: 70, right: 20, top: 20, bottom: 90 },
          xAxis: { type: 'category', data: wfLabels, axisLabel: { rotate: 35, fontSize: 10.5, interval: 0 } },
          yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
          series: [
            { name: 'base', type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, data: wfBase, emphasis: { disabled: true } },
            { name: 'up', type: 'bar', stack: 'w', data: wfUp.map((v, k) => ({ value: v, itemStyle: { color: k === 0 || k === wfUp.length - 1 ? '#0a2540' : '#28a745' } })) },
            { name: 'down', type: 'bar', stack: 'w', data: wfDown, itemStyle: { color: '#b04632' } },
          ],
        }} />
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ seasonality

function CategoryPicker({ h, value, onChange }: { h: H; value: number; onChange: (c: number) => void }) {
  return (
    <select className="select" style={{ maxWidth: 320 }} value={value} onChange={(e) => onChange(+e.target.value)} aria-label="Category">
      {h.opCats.map(({ i }) => <option key={i} value={i}>{h.name(i)}</option>)}
    </select>
  );
}

function useSeries() {
  const catVersion = useStore((s) => s.catVersion);
  const [s, setS] = useState<Awaited<ReturnType<ReturnType<typeof engine>['seriesInfo']>> | null>(null);
  useEffect(() => { void engine().seriesInfo().then(setS); }, [catVersion]);
  return s;
}

function Seasonality({ h, mode }: { h: H; mode: YearMode }) {
  const [c, setC] = useState(h.opCats.find(({ c }) => c?.id === 'council_tax')?.i ?? h.opCats[0]?.i ?? 0);
  const series = useSeries();
  const prof = useMemo(() => seasonalProfile(h.agg, c, h.years, mode, h.fyStartMonth), [h, c, mode]);
  const dom = useMemo(() => dayOfMonthProfile(h.agg, c), [h, c]);
  const breaks = useMemo(() => (series ? detectBreaks(h.agg, c, series) : []), [h, c, series]);
  const ms = useMemo(() => monthlyTotals(h.agg, 'recurring'), [h]);
  const colour = h.colour(c);
  const sign = prof.typical.reduce((s, v) => s + v, 0) >= 0 ? 1 : -1;
  return (
    <div className="stack">
      <div className="row"><strong className="navy">Category</strong><CategoryPicker h={h} value={c} onChange={setC} /><span className="small muted">Recurring flows only — one-offs and treasury are left out so the shape is clear.</span></div>
      <div className="grid g2">
        <Panel title="Monthly seasonal profile" sub="each year faint · typical (median) bold · range shaded">
          <EChart height={340} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => (v == null ? '–' : money(v)) },
            legend: { bottom: 0, type: 'scroll', data: [...prof.byYear.map((y) => y.label), 'Typical'] },
            grid: { left: 70, right: 16, top: 16, bottom: 50 },
            xAxis: { type: 'category', data: prof.months, boundaryGap: false },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            series: [
              { name: 'range-lo', type: 'line', data: prof.lo, stack: 'band', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
              { name: 'Range', type: 'line', data: prof.hi.map((v, k) => v - prof.lo[k]), stack: 'band', lineStyle: { opacity: 0 }, areaStyle: { color: colour, opacity: 0.12 }, showSymbol: false, silent: true, tooltip: { show: false } },
              ...prof.byYear.map((y) => ({ name: y.label, type: 'line', data: y.values, showSymbol: false, lineStyle: { width: 1, opacity: 0.35, color: '#5a6b7b' }, itemStyle: { color: '#5a6b7b' } })),
              { name: 'Typical', type: 'line', data: prof.typical, lineStyle: { width: 3.5, color: colour }, itemStyle: { color: colour }, symbolSize: 6 },
            ],
          }} />
        </Panel>
        <Panel title="Day-of-month profile" sub={dom.peakDays.length ? `peaks on the ${dom.peakDays.join(', ')}` : 'spread through the month'}>
          <EChart height={340} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => pct(v) },
            grid: { left: 50, right: 16, top: 16, bottom: 30 },
            xAxis: { type: 'category', data: Array.from({ length: 31 }, (_, k) => k + 1) },
            yAxis: { type: 'value', axisLabel: { formatter: (v: number) => pct(v, 0) } },
            series: [{ type: 'bar', data: dom.share, itemStyle: { color: colour, borderRadius: [3, 3, 0, 0] } }],
          }} />
        </Panel>
      </div>
      <Panel title="Heatmap — month × year" sub="spot pattern shifts at a glance">
        <EChart height={60 + prof.byYear.length * 34} option={{
          tooltip: { formatter: (p: { value: [number, number, number | null] }) => `${prof.byYear[p.value[1]].label} ${prof.months[p.value[0]]}: <b>${p.value[2] == null ? 'no data' : money(p.value[2])}</b>` },
          grid: { left: 70, right: 70, top: 10, bottom: 30 },
          xAxis: { type: 'category', data: prof.months, splitArea: { show: false } },
          yAxis: { type: 'category', data: prof.byYear.map((y) => y.label), inverse: true },
          visualMap: { min: Math.min(...prof.lo) * (sign > 0 ? 1 : 1), max: Math.max(...prof.hi), calculable: false, orient: 'vertical', right: 0, top: 'center', itemHeight: 120, text: ['high', 'low'], textStyle: { fontSize: 10, color: '#6c757d' }, inRange: { color: sign > 0 ? ['#f1f3f5', '#9cc9f0', '#1f6fb2', '#0a2540'] : ['#0a2540', '#b04632', '#feb56a', '#fff5e9'] } },
          series: [{ type: 'heatmap', data: prof.byYear.flatMap((y, yi) => y.values.map((v, k) => [k, yi, v])), label: { show: true, fontSize: 10, fontWeight: 600, formatter: (p: { value: [number, number, number | null] }) => (p.value[2] == null ? '' : axisMoney(p.value[2])), color: '#fff', textBorderColor: 'rgba(10,37,64,.75)', textBorderWidth: 2 }, itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 } }],
        }} />
      </Panel>
      <Panel title="Structural breaks" sub="changes the model should know about">
        {breaks.length === 0 ? <p className="small muted">No date changes, starts/stops or step changes detected for this category.</p> : (
          <>
            <ul className="list-plain small">{breaks.map((b, i) => <li key={i}><span className={`badge ${b.kind === 'stop' ? 'red' : b.kind === 'start' ? 'green' : 'amber'}`}>{b.kind}</span> {b.text}</li>)}</ul>
            <EChart height={240} option={{
              tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
              grid: { left: 70, right: 16, top: 16, bottom: 30 },
              xAxis: { type: 'category', data: ms.labels },
              yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
              series: [{ type: 'bar', data: ms.values[c], itemStyle: { color: colour },
                markLine: { symbol: 'none', label: { formatter: (p: { name: string }) => p.name, fontSize: 10, color: '#b04632' }, lineStyle: { color: '#b04632', type: 'dashed' }, data: breaks.map((b) => { const { y, m } = ymdFromDay(b.day); return { name: b.kind, xAxis: ms.labels[ms.keys.indexOf(y * 12 + m - 1)] }; }).filter((x) => x.xAxis) } }],
            }} />
          </>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ category deep dive

function CategoryDeepDive({ h }: { h: H }) {
  const [c, setC] = useState(h.opCats[0]?.i ?? 0);
  const [gran, setGran] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [detail, setDetail] = useState<CategoryDetail | null>(null);
  const [sigFilter, setSigFilter] = useState<number | undefined>();
  const catVersion = useStore((s) => s.catVersion);
  useEffect(() => { setDetail(null); setSigFilter(undefined); void engine().categoryDetail(c === h.C ? -1 : c).then(setDetail); }, [c, catVersion, h.C]);
  const data = useMemo(() => {
    const { agg } = h;
    const base = c * agg.D;
    const keyOf = (d: number) => {
      const day = agg.startDay + d;
      if (gran === 'daily') return day;
      if (gran === 'weekly') return day - ((new Date(day * 864e5).getUTCDay() + 6) % 7);
      const dt = new Date(day * 864e5); return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / 864e5;
    };
    const m = new Map<number, [number, number]>();
    for (let d = 0; d < agg.D; d++) { const k = keyOf(d); const v = m.get(k) ?? [0, 0]; v[0] += agg.op[base + d]; v[1] += agg.opOneOff[base + d]; m.set(k, v); }
    const keys = [...m.keys()].sort((a, b) => a - b);
    return { labels: keys.map((k) => iso(k)), rec: keys.map((k) => m.get(k)![0]), one: keys.map((k) => m.get(k)![1]) };
  }, [h, c, gran]);
  return (
    <div className="grid g-side-l" style={{ gridTemplateColumns: '260px minmax(0,1fr)' }}>
      <Panel title="Categories" flush>
        <div style={{ maxHeight: 900, overflow: 'auto' }}>
          {h.opCats.map(({ i }) => (
            <button key={i} className={`nav-item`} style={{ color: 'var(--pt-text)', borderRadius: 0, borderBottom: '1px solid var(--pt-line-soft)', background: i === c ? 'var(--pt-orange-soft)' : undefined, boxShadow: i === c ? 'inset 3px 0 0 var(--pt-orange)' : undefined }} onClick={() => setC(i)}>
              <span className="swatch" style={{ background: h.colour(i) }} /><span style={{ flex: 1 }}>{h.name(i)}</span><span className="xs muted">{money(h.annual.op[i].reduce((s, v) => s + v, 0))}</span>
            </button>
          ))}
        </div>
      </Panel>
      <div className="stack">
        <Panel title={h.name(c)} sub="recurring and one-off flows" right={<Seg dark value={gran} onChange={setGran} options={[{ v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }]} />}>
          <EChart height={320} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
            legend: { top: 0, right: 0 },
            grid: { left: 70, right: 16, top: 30, bottom: 60 },
            xAxis: { type: 'category', data: data.labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
            series: [
              { name: 'Recurring', type: 'bar', stack: 'a', data: data.rec, itemStyle: { color: h.colour(c) }, large: true },
              { name: 'One-off', type: 'bar', stack: 'a', data: data.one, itemStyle: { color: '#fd7e14' }, large: true },
            ],
          }} />
        </Panel>
        {!detail ? <div className="card card-pad"><span className="spinner" /></div> : (
          <>
            <div className="grid g2">
              <Panel title="Recurring series inside" sub={`${detail.series.length} found`} flush>
                <div className="tbl-wrap" style={{ maxHeight: 340 }}>
                  <table className="tbl">
                    <thead><tr><th>Series</th><th>Cadence</th><th className="num">Typical</th><th className="num">Trend</th><th>Seen</th></tr></thead>
                    <tbody>{detail.series.map((s) => (
                      <tr key={s.id}>
                        <td className="mono xs" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{s.signature}</td>
                        <td className="xs">{s.cadence.replace('_', '-')}{s.cadence === 'monthly' ? (s.lastWorkingDay ? ', last working day' : `, ~${s.dayOfMonth}th`) : ''}</td>
                        <td className="num"><Money v={s.typicalAmount} /></td>
                        <td className="num">{s.trendPct ? pct(s.trendPct, 1, true) + ' p.a.' : '–'}</td>
                        <td className="xs">{day(s.firstDay)} – {s.active ? <span className="badge green">active</span> : day(s.lastDay)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="Top counterparties / narratives" flush>
                <div className="tbl-wrap" style={{ maxHeight: 340 }}>
                  <table className="tbl"><thead><tr><th>Narrative signature</th><th className="num">Lines</th><th className="num">Total</th></tr></thead>
                    <tbody>{detail.topSignatures.map((s) => <tr key={s.sigIdx} className={sigFilter === s.sigIdx ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={() => setSigFilter(sigFilter === s.sigIdx ? undefined : s.sigIdx)}><td className="mono xs">{s.signature}</td><td className="num">{int(s.count)}</td><td className="num"><Money v={s.total} /></td></tr>)}</tbody></table>
                </div>
              </Panel>
            </div>
            {detail.oneOffs.length > 0 && (
              <Panel title="One-off items" sub="in history, not in the seasonal profile" flush>
                <div className="tbl-wrap" style={{ maxHeight: 260 }}>
                  <table className="tbl"><thead><tr><th>Date</th><th>Narrative</th><th className="num">Amount</th></tr></thead>
                    <tbody>{detail.oneOffs.map((r) => <tr key={r.key}><td className="xs">{day(r.day)}</td><td className="mono xs">{r.narrative}</td><td className="num"><Money v={r.amount} /></td></tr>)}</tbody></table>
                </div>
              </Panel>
            )}
            {detail.excludedAsDeal > 0 && <div className="callout small">{money(detail.excludedAsDeal)} of lines in this category are treated as deal flows and excluded from the operational figures.</div>}
            <Panel title="Transactions" sub={sigFilter !== undefined ? 'filtered to the selected narrative — click it again to clear' : 'every line in this category'} flush>
              <TxnTable filter={{ catIdx: c === h.C ? null : c, uncategorised: c === h.C, sigIdx: sigFilter, deal: 'operational', sort: 'day_desc' }} height={420} />
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ recurring vs one-off

function RecurringView({ h }: { h: H }) {
  const series = useSeries();
  const { setSeriesOverride } = useStore();
  const [filter, setFilter] = useState('');
  const list = (series ?? []).filter((s) => s.categoryIdx >= 0 && h.cats[s.categoryIdx] && h.cats[s.categoryIdx]!.group !== 'treasury' && h.cats[s.categoryIdx]!.group !== 'internal')
    .filter((s) => !filter || s.signature.includes(filter.toUpperCase()) || h.name(s.categoryIdx).toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return (
    <div className="stack">
      <Panel title="Recurring vs one-off by category" sub="recurring feeds the forecast; one-off stays in history">
        <EChart height={Math.max(220, h.opCats.length * 22)} option={{
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) },
          legend: { top: 0, right: 0 },
          grid: { left: 190, right: 20, top: 28, bottom: 20 },
          yAxis: { type: 'category', data: h.opCats.map(({ i }) => h.name(i)), inverse: true },
          xAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
          series: [
            { name: 'Recurring', type: 'bar', stack: 'a', data: h.opCats.map(({ i }) => h.annual.recurring[i].reduce((s, v) => s + Math.abs(v), 0)), itemStyle: { color: '#0a2540' } },
            { name: 'One-off', type: 'bar', stack: 'a', data: h.opCats.map(({ i }) => h.annual.oneOff[i].reduce((s, v) => s + Math.abs(v), 0)), itemStyle: { color: '#fd7e14' } },
          ],
        }} />
      </Panel>
      <Panel title="Detected series" sub="change a classification and it carries straight into the forecast" right={<input className="input sm" style={{ width: 200 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />} flush>
        <div className="tbl-wrap tall">
          <table className="tbl">
            <thead><tr><th>Series</th><th>Category</th><th>Cadence</th><th className="num">Occurrences</th><th className="num">Typical</th><th>Seen</th><th>Treat as</th></tr></thead>
            <tbody>{list.map((s) => (
              <tr key={s.id}>
                <td className="mono xs">{s.signature}</td>
                <td><CatBadge cat={h.cats[s.categoryIdx]} /></td>
                <td className="xs">{s.cadence.replace('_', '-')}{s.cadence === 'monthly' ? (s.lastWorkingDay ? ' (last working day)' : ` (~${s.dayOfMonth})`) : ''}</td>
                <td className="num">{s.occurrences}</td>
                <td className="num"><Money v={s.typicalAmount} /></td>
                <td className="xs">{day(s.firstDay)} – {s.active ? 'now' : day(s.lastDay)}</td>
                <td><Seg value={s.classification as 'recurring' | 'one_off'} onChange={(v) => setSeriesOverride({ signature: s.signature, classification: v }, `“${s.signature}” → ${v === 'one_off' ? 'one-off' : 'recurring'}`)} options={[{ v: 'recurring', label: 'Recurring' }, { v: 'one_off', label: 'One-off' }]} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ data quality

export function DataQuality() {
  const { ingest, cat } = useStore();
  if (!ingest || !cat) return null;
  const breaks = ingest.balanceChecks.reduce((s, b) => s + b.breaks, 0);
  return (
    <div className="stack">
      <div className="grid g5">
        <Kpi light label="Value categorised" value={pct(cat.valueCategorisedPct)} sub={`${int(cat.uncategorisedRows)} lines uncategorised`} />
        <Kpi light label="Rejected rows" value={int(ingest.rejectsTotal)} sub="see reject log on step 1" />
        <Kpi light label="Balance breaks" value={int(breaks)} sub={`${ingest.balanceChecks.length} file(s) with balances`} />
        <Kpi light label="Possible duplicates" value={int(ingest.dupCandidates)} sub={`${int(ingest.overlapRemoved)} overlap rows removed`} />
        <Kpi light label="Rules used" value={int(cat.rulesUsed)} sub={`${cat.seriesCount} recurring series`} />
      </div>
      <div className="grid g2">
        <Panel title="Coverage gaps" sub="5+ business days with no transactions at all">
          {ingest.coverageGaps.length === 0 ? <p className="small muted">No gaps — every stretch of business days has activity.</p> : <ul className="list-plain small">{ingest.coverageGaps.map((g, i) => <li key={i}>{day(g.from)} – {day(g.to)} · {g.businessDays} business days</li>)}</ul>}
        </Panel>
        <Panel title="Balance continuity" sub="opening balance + flows = closing balance">
          {ingest.balanceChecks.length === 0 ? <p className="small muted">None of the files had a running balance column.</p> : (
            <table className="tbl"><thead><tr><th>File</th><th className="num">Checked</th><th className="num">Breaks</th><th>First break</th></tr></thead>
              <tbody>{ingest.balanceChecks.map((b) => <tr key={b.file}><td className="xs">{b.file}</td><td className="num">{int(b.checked)}</td><td className="num">{b.breaks ? <span className="neg">{b.breaks}</span> : <span className="pos">0</span>}</td><td className="xs">{b.firstBreaks[0] ? `line ${b.firstBreaks[0].line}: expected ${money(b.firstBreaks[0].expected)}, file says ${money(b.firstBreaks[0].actual)}` : '—'}</td></tr>)}</tbody></table>
          )}
        </Panel>
      </div>
      <Panel title="Files" flush>
        <table className="tbl"><thead><tr><th>File</th><th className="num">Accepted</th><th className="num">Rejected</th><th className="num">Swapped dates</th><th className="num">Overlap removed</th><th>Dates</th><th>Accounts</th></tr></thead>
          <tbody>{ingest.files.map((f) => <tr key={f.name}><td className="xs">{f.name}</td><td className="num">{int(f.rowsAccepted)}</td><td className="num">{int(f.rowsRejected)}</td><td className="num">{int(f.swappedDates)}</td><td className="num">{int(f.overlapDuplicatesRemoved)}</td><td className="xs">{day(f.firstDay)} – {day(f.lastDay)}</td><td className="xs">{f.accounts.join(', ')}</td></tr>)}</tbody></table>
      </Panel>
    </div>
  );
}

export type { Day };
