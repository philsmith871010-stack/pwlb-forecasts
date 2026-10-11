import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { Panel } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, day } from '../../lib/format';
import { STRATEGY_CAVEAT, Strategy } from '../../lib/forecast/strategy';
import type { ForecastBundle } from './useForecast';

const TONE: Record<Strategy['options'][number]['tone'], { icon: string; cls: string }> = {
  borrow: { icon: 'bi-bank', cls: 'borrow' },
  invest: { icon: 'bi-piggy-bank', cls: 'invest' },
  info: { icon: 'bi-info-circle', cls: 'info' },
  warn: { icon: 'bi-exclamation-triangle', cls: 'warn' },
};

/** "What you could do": options to discuss, from the forecast and the deal register. */
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
            LOBO call dates and investments maturing. <button className="link-btn" onClick={() => { useStore.getState().setStepTab('forecast-simple', 'before'); useStore.getState().setStepTab('forecast', 'setup'); goto('forecast'); }}>Add it under Known items and cash</button>
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
