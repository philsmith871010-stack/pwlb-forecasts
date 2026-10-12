import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, ToMenu } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, ago } from '../../lib/format';
import { MONTH_NAMES } from '../../lib/dates';
import { UNCATEGORISED_COLOUR } from '../../lib/categories';

/** History from the team file's category × month summary — works without any CSV loaded. */
export function HistorySnapshotView() {
  const team = useStore((s) => s.team);
  const hs = team.historySummary!;
  const d = useMemo(() => {
    const labels = hs.months.map((m) => { const [y, mo] = m.split('-').map(Number); return `${MONTH_NAMES[mo - 1]} ${String(y).slice(2)}`; });
    const ids = Object.keys(hs.byCategory).filter((k) => !k.startsWith('__'));
    const net = hs.months.map((_, k) => ids.reduce((s, id) => s + hs.byCategory[id][k], 0));
    let run = hs.openingPosition;
    const cum = net.map((v) => (run += v));
    return { labels, ids, net, cum };
  }, [hs]);
  const cat = (id: string) => team.categories.find((c) => c.id === id);
  return (
    <>
      <PageHead eyebrow="From the team file" title="Historic summary" actions={<ToMenu />}>
        This view uses the category × month totals saved in the team file {ago(hs.generatedAt)} — no transaction data. Load the bank CSVs under Set up and train to unlock seasonality, drill-down and backtesting.
      </PageHead>
      <div className="stack">
        <Panel title="Cumulative operational position (monthly)">
          <EChart height={320} option={{
            tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
            grid: { left: 70, right: 16, top: 16, bottom: 30 },
            xAxis: { type: 'category', data: d.labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            series: [{ type: 'line', data: d.cum, showSymbol: false, lineStyle: { width: 2.5, color: '#0a2540' }, areaStyle: { color: 'rgba(10,37,64,.06)' } }],
          }} />
        </Panel>
        <Panel title="Monthly operational flows by category">
          <EChart height={380} option={{
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) },
            legend: { type: 'scroll', bottom: 0 },
            grid: { left: 70, right: 16, top: 16, bottom: 60 },
            xAxis: { type: 'category', data: d.labels },
            yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
            series: d.ids.map((id) => ({ name: cat(id)?.name ?? 'Uncategorised', type: 'bar', stack: hs.byCategory[id].reduce((s, v) => s + v, 0) >= 0 ? 'in' : 'out', data: hs.byCategory[id], itemStyle: { color: cat(id)?.colour ?? UNCATEGORISED_COLOUR } })),
          }} />
        </Panel>
      </div>
    </>
  );
}
