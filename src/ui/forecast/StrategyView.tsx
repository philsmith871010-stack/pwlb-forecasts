import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { Panel } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, day } from '../../lib/format';
import { STRATEGY_CAVEAT, Strategy } from '../../lib/forecast/strategy';
import type { ForecastBundle } from './useForecast';
import type { RegisterInfo } from '../../worker/types';

const TONE: Record<Strategy['options'][number]['tone'], { icon: string; cls: string }> = {
  borrow: { icon: 'bi-bank', cls: 'borrow' },
  invest: { icon: 'bi-piggy-bank', cls: 'invest' },
  info: { icon: 'bi-info-circle', cls: 'info' },
  warn: { icon: 'bi-exclamation-triangle', cls: 'warn' },
};

/** "What you could do": options to discuss, from the forecast (bottom up) and the deal register (top down). */
export function StrategyView({ b }: { b: ForecastBundle }) {
  const register = useStore((s) => s.register);
  const goto = useStore((s) => s.goto);
  const st = b.strategy;
  const longest = [...st.ladder].reverse().find((r) => r.amount >= 1e6);
  return (
    <div className="stack">
      <div className="callout navy small"><i className="bi bi-chat-square-text" /> {STRATEGY_CAVEAT}</div>

      <Panel title="Options to discuss" sub={register ? 'from your forecast and your deal register' : 'from your forecast'}>
        <div className="options">
          {st.options.map((o, i) => (
            <div key={i} className={`option ${TONE[o.tone].cls}`}>
              <i className={`bi ${TONE[o.tone].icon}`} />
              <div><div className="t">{o.title}</div><div className="b">{o.body}</div>
                {o.detail && <details className="more-detail"><summary>More</summary><div className="b muted">{o.detail}</div></details>}</div>
            </div>
          ))}
        </div>
        {!register && (
          <div className="callout mt small">
            <strong>Add your deal register for a fuller picture.</strong> With it, these options take account of your loans falling due,
            LOBO call dates, investments maturing and your liability benchmark. <button className="link-btn" onClick={() => { useStore.getState().setStepTab('forecast-simple', 'before'); useStore.getState().setStepTab('forecast', 'setup'); goto('forecast'); }}>Add it under Known items and cash</button>
          </div>
        )}
      </Panel>

      <details className="fold">
        <summary>How the borrowing need builds</summary>
        <NeedChart st={st} />
      </details>
      <details className="fold">
        <summary>Could you invest for longer?</summary>
        <Ladder st={st} />
        <p className="xs muted" style={{ margin: '8px 0 0' }}>
          {longest ? <>The forecast suggests about <strong>{money(longest.amount)}</strong> isn’t needed for at least {longest.months} months. </> : 'There’s no cash the forecast is confident you won’t need. '}
          The cautious line is the bottom of the likely range, so a bad month is already allowed for.
        </p>
      </details>
      <details className="fold">
        <summary>The long-term view: your liability benchmark</summary>
        <LongTerm b={b} register={register} />
      </details>

    </div>
  );
}

function NeedChart({ st }: { st: Strategy }) {
  const option = useMemo(() => ({
    grid: { left: 64, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
    xAxis: { type: 'category', data: st.needBy.map((q) => day(q.day)), axisLabel: { fontSize: 10.5 } },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
    series: [{ name: 'Borrowing needed', type: 'bar', data: st.needBy.map((q) => q.amount), itemStyle: { color: '#0a2540', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 }],
  }), [st]);
  if (!st.needBy.some((q) => q.amount > 0)) return <p className="small muted">No borrowing is needed at any quarter end in this forecast.</p>;
  return <EChart option={option} height={220} ariaLabel="Borrowing needed by quarter end" />;
}

function Ladder({ st }: { st: Strategy }) {
  const max = Math.max(1, ...st.ladder.map((r) => r.amount));
  if (!st.ladder.length) return <p className="small muted">The forecast is too short to judge.</p>;
  return (
    <table className="ladder">
      <tbody>
        {st.ladder.map((r) => (
          <tr key={r.months}>
            <td className="lbl">{r.months < 12 ? `${r.months} month${r.months > 1 ? 's' : ''}` : `${r.months / 12} year${r.months > 12 ? 's' : ''}`}</td>
            <td className="bar"><span style={{ width: `${(r.amount / max) * 100}%` }} /></td>
            <td className="num">{money(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Existing loans against the liability benchmark, year by year (£m in, £ out). */
export function benchmarkChartOption(lb: NonNullable<RegisterInfo['lb']>) {
  const rows = lb.filter((r) => !r.actual).slice(0, 12);
  return {
    grid: { left: 64, right: 12, top: 36, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
    legend: { top: 0, right: 0 },
    xAxis: { type: 'category', data: rows.map((r) => r.fy) },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
    series: [
      { name: 'Existing loans', type: 'bar', stack: 'd', data: rows.map((r) => r.existingLoans * 1e6), itemStyle: { color: '#0a2540' }, barMaxWidth: 34 },
      { name: 'Room to borrow (benchmark)', type: 'bar', stack: 'd', data: rows.map((r) => r.need * 1e6), itemStyle: { color: 'rgba(253,126,20,.35)' }, barMaxWidth: 34 },
      { name: 'Liability benchmark', type: 'line', data: rows.map((r) => r.lb * 1e6), lineStyle: { color: '#fd7e14', width: 2.5 }, itemStyle: { color: '#fd7e14' }, symbolSize: 6 },
      { name: 'Capital financing requirement', type: 'line', data: rows.map((r) => r.cfr * 1e6), lineStyle: { color: '#544fc5', type: 'dashed', width: 1.5 }, itemStyle: { color: '#544fc5' }, showSymbol: false },
    ],
  };
}

function LongTerm({ b, register }: { b: ForecastBundle; register: RegisterInfo | null }) {
  const st = b.strategy;
  const lb = register?.lb ?? null;
  const option = useMemo(() => (lb ? benchmarkChartOption(lb) : null), [lb]);
  return (
    <Panel title="The long-term view" sub="two ways of looking at the same question">
      <div className="grid g2 views-explain">
        <div>
          <div className="eyebrow">Bottom up: this forecast</div>
          <p className="small">Built from your bank history, day by day, for the next year or two. It shows <strong>when</strong> cash runs short and by how much, which is what you need for day-to-day cash management and timing borrowing.</p>
        </div>
        <div>
          <div className="eyebrow">Top down: the liability benchmark</div>
          <p className="small">Built from your balance sheet projections (capital financing requirement less reserves and balances), year by year, for decades. It shows <strong>how much</strong> long-term borrowing the council needs, and so how long new loans should run.</p>
        </div>
      </div>
      {lb && option ? (
        <>
          <EChart option={option} height={300} ariaLabel="Liability benchmark against existing loans" />
          {st.benchmark && (
            <p className="small" style={{ marginBottom: 0 }}>
              In {st.benchmark.fy} the benchmark is <strong>{money(st.benchmark.lb)}</strong> and existing loans are <strong>{money(st.benchmark.loans)}</strong>,
              so {st.benchmark.room > 0 ? <>there is room for about <strong>{money(st.benchmark.room)}</strong> of new long-term borrowing</> : <>there is no room for new long-term borrowing</>}.
              {' '}This forecast’s lasting need is <strong>{money(st.lasting)}</strong>.
              {st.benchmark.tranches.length > 0 && <> The benchmark would support {st.benchmark.lastingAboveRoom > 0 ? <><strong>{money(st.benchmark.lastingWithinRoom)}</strong> of it</> : 'it'} as long-term borrowing, maturing: {st.benchmark.tranches.map((t, i) => <span key={i}>{i ? ', ' : ''}<strong>{money(t.amount)}</strong> to {t.untilFy}</span>)}.</>}
            </p>
          )}
        </>
      ) : (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {register ? 'Your deal register has no Projections sheet filled in, so the liability benchmark can’t be shown. Fill in the capital financing requirement and balances there to see it.' : 'Add your deal register (with its Projections sheet) to compare this forecast with your liability benchmark.'}
        </p>
      )}
    </Panel>
  );
}
