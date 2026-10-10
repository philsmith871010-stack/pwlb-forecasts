// Forecast vs actual: the forecast this method would have made a while ago, from the history
// up to then, against what actually happened. Works from the saved history alone.
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Kpi, Panel, Seg } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromYMD, dayFromISO, ymdFromDay, MONTH_NAMES } from '../../lib/dates';
import { compareSigned, fullMonthsLabel, monthEndIndex } from '../../lib/forecast/signoff';
import { useTracking } from './useTracking';
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

/** "Forecast vs actual": your signed-off forecasts against what happened, or a test of the method. */
export function PastCheck({ sc }: { sc: Scenario }) {
  const signed = useStore((s) => s.team.signedOff ?? []);
  const [view, setView] = useState<'signed' | 'method'>('signed');
  const v = signed.length ? view : 'method';
  return (
    <div className="stack">
      {signed.length > 0 && <Seg value={v} onChange={setView} options={[{ v: 'signed', label: `Signed-off forecasts (${signed.length})` }, { v: 'method', label: 'Test the method' }]} ariaLabel="What to compare" />}
      {v === 'signed' ? <SignedView /> : <MethodCheck sc={sc} />}
      {!signed.length && <p className="xs muted" style={{ margin: 0 }}>When you sign off a forecast (under <strong>Forecast</strong>, on <strong>Your forecast</strong>), it’s kept exactly as it stands and compared here with what actually happens as new statements come in. Until then, test the method below.</p>}
    </div>
  );
}

/** Your signed-off forecasts, newest first, each against what has happened since. */
function SignedView() {
  const { team, historyBase } = useStore();
  const h = team.cashHistory ?? historyBase;
  const list = [...(team.signedOff ?? [])].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  // open on the one Home and Today's statement report on
  const tracked = useTracking();
  const [id, setId] = useState(tracked?.rec.id ?? list[0]?.id);
  const rec = list.find((x) => x.id === id) ?? list[0];
  const r = useMemo(() => (rec && h ? compareSigned(rec, h, team.categories) : null), [rec, h, team.categories]);
  if (!rec) return null;
  const signedOn = day(dayFromISO(rec.signedAt.slice(0, 10)));
  return (
    <>
      <div className="signed-list" role="radiogroup" aria-label="Signed-off forecast">
        {list.map((x) => (
          <button key={x.id} role="radio" aria-checked={x.id === rec.id} className={x.id === rec.id ? 'on' : ''} onClick={() => setId(x.id)}>
            <strong>{x.scenarioName}</strong>
            <span>Signed off {day(dayFromISO(x.signedAt.slice(0, 10)))} · {x.signedBy}</span>
          </button>
        ))}
      </div>
      <div className="signed-meta small">
        <div><i className="bi bi-patch-check-fill" /> Signed off on <strong>{signedOn}</strong> by <strong>{rec.signedBy}</strong>. At the time: may need to borrow <strong>{money(rec.borrowingNeed)}</strong>, lowest point {money(rec.low)} on {day(dayFromISO(rec.lowDay))}.</div>
        {rec.note && <div className="muted">“{rec.note}”</div>}
        {rec.knownItems.length > 0 && <div className="muted">Added by hand: {rec.knownItems.join('; ')}.</div>}
      </div>
      {r ? <PastResult r={r} intro={<>Signed off on {signedOn}, the forecast said</>} handAdded={rec.knownItems.length > 0}
        chartNote="Exactly as signed off, including anything added by hand. Everyday cash only: loans, investments and transfers between your own accounts are left out."
        catsLabel={fullMonthsLabel(r) ? `over the complete months so far, ${fullMonthsLabel(r)}` : ''} />
        : <div className="callout navy small">Nothing to compare yet: no statements from {day(dayFromISO(rec.start))} onwards have come in. As each new statement arrives, it’s compared with this forecast.</div>}
    </>
  );
}

function MethodCheck({ sc }: { sc: Scenario }) {
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
    <>
      <div className="row">
        <span className="small muted">What the forecast would have said</span>
        <Seg value={m} onChange={setMonths} options={choices} ariaLabel="When the forecast was made" />
        {busy && <span className="spinner sm" />}
      </div>
      {r && <PastResult r={r} intro={<>{m === 12 ? 'A year ago' : `${m === 6 ? 'Six months' : 'Two years'} ago`}, on {day(r.cutoff)}, using only the history up to then, the forecast said</>}
        chartNote="Everyday cash only: loans, investments and transfers between your own accounts are left out, as in the forecast. The forecast used the method you’d use today, with nothing added by hand." />}
    </>
  );
}

function PastResult({ r, intro, chartNote, catsLabel, handAdded }: { r: BacktestResult; intro: ReactNode; chartNote: string; catsLabel?: string; handAdded?: boolean }) {
  // read at the latest month end, so payment timing doesn't swing the figures (the chart shows every day)
  const me = monthEndIndex(r);
  const end = me ?? r.H - 1;
  const at = r.cutoff + end;
  const atWords = me === null ? ' (so far: the first month end isn’t in yet)' : at < r.end ? ' (the latest month end)' : '';
  const fc = r.forecastCum[end], act = r.actualCum[end], gap = act - fc;
  // the cash that flowed in and out over the period, for scale
  let gross = 0;
  for (let d = 0; d <= end; d++) gross += Math.abs(r.actualCum[d] - (d ? r.actualCum[d - 1] : 0));
  const share = gross ? Math.abs(gap) / gross : 0;
  let inside = 0;
  for (let d = 0; d < r.H; d++) if (r.actualCum[d] >= r.lowerCum[d] && r.actualCum[d] <= r.upperCum[d]) inside++;
  const oneOffs = r.actualCum[end] - r.actualCoreCum[end];
  const verdict = share < 0.02 ? { word: 'Very close', cls: 'green' } : share < 0.05 ? { word: 'Close', cls: 'green' } : { word: 'Some way out', cls: 'soft' };
  const move = (v: number, past = false) => (v < 0 ? `${past ? 'fell' : 'fall'} by ${money(-v)}` : `${past ? 'rose' : 'rise'} by ${money(v)}`);
  const months = Math.max(1, Math.round((end + 1) / 30.44));

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
        {intro} everyday cash would <strong>{move(fc)}</strong> by {day(at)}{atWords}. It actually <strong>{move(act, true)}</strong>: {Math.abs(gap) < 0.05e6 ? 'almost exactly as forecast' : <>a difference of <strong>{money(Math.abs(gap))}</strong>, {pct(share)} of the {money(gross)} that flowed in and out</>}.
        {Math.abs(oneOffs) >= 1e6 && (handAdded
          ? <> One-off items account for {money(oneOffs, { sign: true })} of what happened; only those added by hand were in the forecast.</>
          : <> One-off items, which no forecast from history can see, account for {money(oneOffs, { sign: true })} of what happened.</>)}
      </div>

      <div className="grid g3">
        <Kpi label="Forecast made then" value={money(fc, { sign: true })} sub={`change in everyday cash to ${day(at)}`} />
        <Kpi light label="What actually happened" value={money(act, { sign: true })} sub={`over the same ${months === 1 ? 'month' : `${months} months`}`} />
        <Kpi light label="Inside the likely range" value={pct(inside / r.H, 0)} sub="of the days" />
      </div>

      <Panel title="Forecast made then, against what happened" sub={`change in everyday cash since ${day(r.cutoff)}`}>
        <EChart option={option} height={340} ariaLabel="A past forecast against what actually happened" />
        <p className="xs muted" style={{ margin: '6px 0 0' }}>{chartNote}</p>
      </Panel>

      {rows.length > 0 && (
        <details className="fold">
          <summary>Where it was out{catsLabel ? <span className="muted" style={{ fontWeight: 400 }}> · {catsLabel}</span> : null}</summary>
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
