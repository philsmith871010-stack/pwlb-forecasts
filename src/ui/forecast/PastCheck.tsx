// Forecast vs actual: the forecast this method would have made a while ago, from the history
// up to then, against what actually happened. Works from the saved history alone.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Kpi, Panel, Seg } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromYMD, ymdFromDay, MONTH_NAMES } from '../../lib/dates';
import { backtestFromHistory, type BacktestResult } from '../../lib/forecast/backtest';
import { historySpan, type CashHistory } from '../../lib/history/cashHistory';
import type { Category } from '../../lib/categories';
import type { Scenario } from '../../lib/model';

/** A forecast needs a year of history behind it to learn from. */
const LEARN_DAYS = 365;

/** The first of the month `months` before the history ends, if there's a year of history before it. */
export function pastCutoff(h: CashHistory | null, months: number): number | null {
  const span = h ? historySpan(h) : null;
  if (!span) return null;
  const { y, m } = ymdFromDay(addMonths(span.to + 1, -months));
  const cutoff = dayFromYMD(y, m, 1);
  return cutoff - span.from >= LEARN_DAYS && cutoff <= span.to ? cutoff : null;
}

/** The past forecast `months` back, run on the saved history. */
export function pastForecast(h: CashHistory | null, months: number, categories: Category[], sc: Scenario, fyStartMonth: number): BacktestResult | null {
  const cutoff = pastCutoff(h, months);
  if (!h || cutoff == null) return null;
  return backtestFromHistory(h, { cutoff, horizonMonths: months, categories, settings: sc.settings, includeActualOneOffs: false, fyStartMonth });
}

const CHOICES = [{ v: 6, label: '6 months ago' }, { v: 12, label: 'A year ago' }, { v: 24, label: '2 years ago' }];

export function PastCheck({ sc }: { sc: Scenario }) {
  const { team, historyBase } = useStore();
  const h = team.cashHistory ?? historyBase;
  const fy = +team.settings.financialYearStart.split('-')[0] || 4;
  const choices = CHOICES.filter((c) => pastCutoff(h, c.v) != null);
  const [months, setMonths] = useState(12);
  const m = choices.some((c) => c.v === months) ? months : choices[choices.length - 1]?.v ?? 12;
  const [r, setR] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(true);
  // a few hundred milliseconds of work: let the spinner paint first
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => { setR(pastForecast(h, m, team.categories, sc, fy)); setBusy(false); }, 30);
    return () => clearTimeout(t);
  }, [h, m, team.categories, sc.settings, fy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!choices.length) return <div className="callout navy small">This needs at least a year and a half of history: a year to learn from, and six months to compare with.</div>;
  return (
    <div className="stack">
      <div className="row">
        <span className="small muted">What the forecast would have said</span>
        <Seg value={m} onChange={setMonths} options={choices} ariaLabel="When the forecast was made" />
        {busy && <span className="spinner sm" />}
      </div>
      {r && <PastResult r={r} months={m} />}
    </div>
  );
}

function PastResult({ r, months }: { r: BacktestResult; months: number }) {
  const end = r.H - 1;
  const fc = r.forecastCum[end], act = r.actualCum[end], gap = act - fc;
  const gross = r.errorAt.find((e) => e.months === months)?.actualAbsFlow ?? r.monthly.actualNet.reduce((t, v) => t + Math.abs(v), 0);
  const share = gross ? Math.abs(gap) / gross : 0;
  let inside = 0;
  for (let d = 0; d < r.H; d++) if (r.actualCum[d] >= r.lowerCum[d] && r.actualCum[d] <= r.upperCum[d]) inside++;
  const oneOffs = r.actualCum[end] - r.actualCoreCum[end];
  const verdict = share < 0.02 ? { word: 'Very close', cls: 'green' } : share < 0.05 ? { word: 'Close', cls: 'green' } : { word: 'Some way out', cls: 'soft' };
  const move = (v: number, past = false) => (v < 0 ? `${past ? 'fell' : 'fall'} by ${money(-v)}` : `${past ? 'rose' : 'rise'} by ${money(v)}`);
  const ago = months === 12 ? 'A year ago' : `${months === 6 ? 'Six months' : 'Two years'} ago`;

  const option = useMemo(() => {
    const x: string[] = [], f: number[] = [], a: number[] = [], lo: number[] = [], w: number[] = [];
    for (let d = 0; d < r.H; d += 2) {
      const { y, m, d: dd } = ymdFromDay(r.cutoff + d);
      x.push(`${dd} ${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`);
      f.push(r.forecastCum[d]); a.push(r.actualCum[d]); lo.push(r.lowerCum[d]); w.push(r.upperCum[d] - r.lowerCum[d]);
    }
    const narrow = window.innerWidth < 640;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
      legend: { ...(narrow ? { bottom: 0, left: 0 } : { top: 0, right: 0 }), data: ['What actually happened', 'Forecast made then', 'Likely range'] },
      grid: narrow ? { left: 52, right: 12, top: 16, bottom: 70 } : { left: 64, right: 20, top: 34, bottom: 28 },
      xAxis: { type: 'category', data: x, axisLabel: { interval: Math.floor(x.length / 6) } },
      yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
      series: [
        { name: '_lo', type: 'line', data: lo, stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
        { name: 'Likely range', type: 'line', data: w, stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false }, areaStyle: { color: 'rgba(253,126,20,.16)' }, itemStyle: { color: 'rgba(253,126,20,.4)' } },
        { name: 'Forecast made then', type: 'line', data: f, showSymbol: false, lineStyle: { color: '#fd7e14', width: 2.4, type: 'dashed' }, itemStyle: { color: '#fd7e14' } },
        { name: 'What actually happened', type: 'line', data: a, showSymbol: false, lineStyle: { color: '#0a2540', width: 2 }, itemStyle: { color: '#0a2540' } },
      ],
    };
  }, [r]);

  const rows = r.categories.filter((c) => !c.excluded && Math.abs(c.error) >= 0.5e6).slice(0, 6);
  return (
    <>
      <div className="summary-box">
        <div className="eyebrow">In a sentence <span className={`badge ${verdict.cls}`} style={{ marginLeft: 8 }}>{verdict.word}</span></div>
        {ago}, on {day(r.cutoff)}, using only the history up to then, the forecast said everyday cash would <strong>{move(fc)}</strong> by {day(r.end)}. It actually <strong>{move(act, true)}</strong>: {Math.abs(gap) < 0.05e6 ? 'almost exactly as forecast' : <>a difference of <strong>{money(Math.abs(gap))}</strong>, {pct(share)} of the {money(gross)} that flowed in and out</>}.
        {Math.abs(oneOffs) >= 1e6 && <> One-off items, which no forecast from history can see, account for {money(oneOffs, { sign: true })} of what happened.</>}
      </div>

      <div className="grid g3">
        <Kpi label="Forecast made then" value={money(fc, { sign: true })} sub={`change in everyday cash to ${day(r.end)}`} />
        <Kpi light label="What actually happened" value={money(act, { sign: true })} sub={`over the same ${months} months`} />
        <Kpi light label="Inside the likely range" value={pct(inside / r.H, 0)} sub="of the days" />
      </div>

      <Panel title="Forecast made then, against what happened" sub={`change in everyday cash since ${day(r.cutoff)}`}>
        <EChart option={option} height={340} ariaLabel="A past forecast against what actually happened" />
        <p className="xs muted" style={{ margin: '6px 0 0' }}>Everyday cash only: loans, investments and transfers between your own accounts are left out, as in the forecast. The forecast used the method you’d use today, with nothing added by hand.</p>
      </Panel>

      {rows.length > 0 && (
        <details className="fold">
          <summary>Where it was out</summary>
          <table className="tbl simple-tbl">
            <thead><tr><th>Category</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Difference</th><th /></tr></thead>
            <tbody>{rows.map((c) => {
              const oo = c.actual - c.actualCore;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{money(c.forecast)}</td>
                  <td className="num">{money(c.actual)}</td>
                  <td className="num"><strong>{money(c.actual - c.forecast, { sign: true })}</strong></td>
                  <td className="xs muted">{Math.abs(oo) >= 0.5e6 ? `includes ${money(oo, { sign: true })} of one-offs` : ''}</td>
                </tr>
              );
            })}</tbody>
          </table>
          <p className="xs muted" style={{ margin: '8px 0 0' }}>When you know about something like this in advance, add it under <strong>Known items and cash</strong>, or change that line on <strong>Check each line</strong>.</p>
        </details>
      )}
    </>
  );
}
