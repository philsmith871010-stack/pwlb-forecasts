// The deal register on its own, before any bank history is loaded: what's owed and invested,
// and the cash it brings in and takes out over the next two years.
import { useMemo } from 'react';
import { Kpi, Panel } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, day } from '../../lib/format';
import { ymdFromDay, addMonths, MONTH_NAMES } from '../../lib/dates';
import type { RegisterInfo } from '../../worker/types';

type Ev = RegisterInfo['events'][number];
const isLoan = (e: Ev) => e.kind.startsWith('loan');

export function RegisterOverview({ r }: { r: RegisterInfo }) {
  const from = (r.asAt ?? Math.floor(Date.now() / 864e5)) + 1;
  const to = addMonths(from, 24) - 1;
  const coming = useMemo(() => r.events.filter((e) => e.day >= from && e.day <= to), [r, from, to]);
  const next12 = coming.filter((e) => e.day < addMonths(from, 12));
  const sum = (xs: Ev[], f: (e: Ev) => boolean) => xs.filter(f).reduce((t, e) => t + e.amount, 0);
  const invested = r.investments.reduce((t, x) => t + x.principal, 0);

  const months = useMemo(() => {
    const out: { label: string; repaid: number; interest: number; maturing: number; other: number }[] = [];
    const { y, m } = ymdFromDay(from);
    for (let k = 0; k < 24; k++) { const mi = y * 12 + m - 1 + k; out.push({ label: `${MONTH_NAMES[mi % 12]} ${String(Math.floor(mi / 12)).slice(2)}`, repaid: 0, interest: 0, maturing: 0, other: 0 }); }
    for (const e of coming) {
      const d = ymdFromDay(e.day), k = (d.y * 12 + d.m - 1) - (y * 12 + m - 1);
      const b = out[k]; if (!b) continue;
      if (e.kind === 'loan_repayment') b.repaid += e.amount;
      else if (e.kind === 'loan_interest' || e.kind === 'inv_interest') b.interest += e.amount;
      else if (e.kind === 'inv_maturity') b.maturing += e.amount;
      else b.other += e.amount;
    }
    return out;
  }, [coming, from]);

  const option = useMemo(() => ({
    grid: { left: 64, right: 12, top: 36, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
    legend: { top: 0, right: 0 },
    xAxis: { type: 'category', data: months.map((x) => x.label), axisLabel: { fontSize: 10.5, interval: 2 } },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
    series: [
      { name: 'Loans repaid', type: 'bar', stack: 'x', data: months.map((x) => x.repaid), itemStyle: { color: '#0a2540' }, barMaxWidth: 16 },
      { name: 'Interest (net)', type: 'bar', stack: 'x', data: months.map((x) => x.interest), itemStyle: { color: '#8a96a3' }, barMaxWidth: 16 },
      { name: 'Investments maturing', type: 'bar', stack: 'x', data: months.map((x) => x.maturing), itemStyle: { color: '#28a745' }, barMaxWidth: 16 },
      { name: 'New deals already agreed', type: 'bar', stack: 'x', data: months.map((x) => x.other), itemStyle: { color: '#fd7e14' }, barMaxWidth: 16 },
    ],
  }), [months]);

  const biggest = [...next12].filter((e) => !e.kind.endsWith('interest')).sort((a, z) => Math.abs(z.amount) - Math.abs(a.amount)).slice(0, 8).sort((a, z) => a.day - z.day);

  return (
    <div className="stack register-only">
      <div className="grid g4">
        <Kpi label="Loans outstanding" value={money(r.stats.debt)} sub={`${r.loans.length} loans`} />
        <Kpi light label="Fixed-term investments" value={money(invested)} sub={`${r.investments.length} deals`} />
        <Kpi light label="Cash in funds" value={money(r.liquid.total)} sub="money market funds and call accounts" />
        <Kpi light label="Next 12 months, net" value={money(sum(next12, () => true), { sign: true })} sub={`${money(-sum(next12, isLoan))} to lenders`} />
      </div>

      <Panel title="What the register brings in and takes out" sub={`next 24 months from ${day(from)}`}>
        {coming.length ? <EChart option={option} height={280} ariaLabel="Deal register cash flows by month" /> : <p className="small muted">Nothing falls due in the next two years.</p>}
      </Panel>

      {biggest.length > 0 && (
        <Panel title="Largest items in the next 12 months" flush>
          <table className="tbl simple-tbl">
            <tbody>{biggest.map((e, i) => (
              <tr key={i}><td style={{ width: 110 }}>{day(e.day)}</td><td>{e.label}</td><td className="num"><strong>{money(e.amount, { sign: true })}</strong></td></tr>
            ))}</tbody>
          </table>
        </Panel>
      )}

      {r.loboCalls.length > 0 && (
        <div className="callout small"><strong>LOBO call dates:</strong> {r.loboCalls.map((l) => `${day(l.day)} (${l.label.replace(/^LOBO · /, '')}, ${money(l.amount)})`).join('; ')}. Repayment is assumed at the call date, the cautious view.</div>
      )}


      <div className="callout navy small">
        <strong>This is the register on its own.</strong> To see when your cash would run short, and how much to borrow, load your bank statements under <strong>Set up and train</strong> (from the main menu): the forecast then combines your everyday cash with everything above.
      </div>
    </div>
  );
}
