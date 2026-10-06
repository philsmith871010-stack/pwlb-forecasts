import { useMemo } from 'react';
import { EChart, axisMoney } from '../components/EChart';
import type { ForecastBundle } from './useForecast';
import { money } from '../../lib/format';
import { isoFromDay, fmtDay, weekday, ymdFromDay, Day } from '../../lib/dates';
import type { ECharts } from 'echarts/core';

export function ForecastChart({ b, granularity, historyMonths = 24, height = 420, onReady, showTreasury = true }: {
  b: ForecastBundle; granularity: 'daily' | 'weekly' | 'monthly'; historyMonths?: number; height?: number; onReady?: (c: ECharts) => void; showTreasury?: boolean;
}) {
  const option = useMemo(() => {
    const { fc, hist } = b;
    const histFrom = Math.max(hist.startDay, fc.start - Math.round(historyMonths * 30.44));
    // build a unified day axis, then thin to period ends
    const days: Day[] = [];
    for (let d = histFrom; d < fc.start + fc.H; d++) days.push(d);
    const keep = (d: Day, i: number) => {
      if (granularity === 'daily') return true;
      const next = days[i + 1];
      if (next === undefined) return true;
      if (granularity === 'weekly') return weekday(d) === 0 || next === fc.start;
      return ymdFromDay(next).m !== ymdFromDay(d).m || next === fc.start;
    };
    const idx = days.map((d, i) => (keep(d, i) ? i : -1)).filter((i) => i >= 0);
    const x = idx.map((i) => isoFromDay(days[i]));
    const histVals = idx.map((i) => { const d = days[i]; return d < fc.start ? hist.values[d - hist.startDay] : null; });
    // join the lines at the boundary
    const lastHistIdx = histVals.reduce((a: number, v, k) => (v !== null ? k : a), -1);
    const fcAt = (d: Day, arr: Float64Array) => (d >= fc.start ? arr[d - fc.start] : null);
    const fcVals = idx.map((i, k) => (k === lastHistIdx ? histVals[k] : fcAt(days[i], fc.cumulative)));
    const lo = idx.map((i, k) => (k === lastHistIdx ? histVals[k] : fcAt(days[i], fc.lower)));
    const width = idx.map((i, k) => { const l = lo[k]; const u = k === lastHistIdx ? histVals[k] : fcAt(days[i], fc.upper); return l === null || u === null ? null : (u as number) - (l as number); });
    const tr = fc.treasuryDaily.some((v) => v) && showTreasury ? idx.map((i, k) => (k === lastHistIdx ? histVals[k] : fcAt(days[i], fc.cumulativeAfterTreasury))) : null;
    const nearest = (d: Day) => { const s = isoFromDay(d); let best = x[0]; for (const v of x) { if (v <= s) best = v; else break; } return best; };
    const breaches = fc.breaches.map((br) => [{ xAxis: nearest(br.from), itemStyle: { color: 'rgba(176,70,50,.08)' } }, { xAxis: nearest(br.to) }]);
    const markers = fc.markers.filter((m) => m.day >= fc.start && m.day < fc.start + fc.H);
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (ps: { seriesName: string; value: number | null; axisValue: string; marker: string }[]) => {
          const head = fmtDay(Math.floor(Date.parse(ps[0].axisValue) / 864e5));
          const rows = ps.filter((p) => p.value != null && !p.seriesName.startsWith('_')).map((p) => `${p.marker}${p.seriesName}: <b>${money(p.value as number)}</b>`);
          const ms = markers.filter((m) => isoFromDay(m.day) === ps[0].axisValue || (granularity !== 'daily' && nearest(m.day) === ps[0].axisValue)).map((m) => `<span style="color:#fd7e14">◆</span> ${m.label}`);
          return [head, ...rows, ...ms].join('<br/>');
        },
      },
      legend: { top: 0, right: 0, data: ['History (operational)', 'Forecast', '90% range', ...(tr ? ['After known treasury schedule'] : [])] },
      grid: { left: 72, right: 24, top: 36, bottom: 64 },
      xAxis: { type: 'category', data: x, axisLabel: { formatter: (v: string) => { const { y, m } = ymdFromDay(Math.floor(Date.parse(v) / 864e5)); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${String(y).slice(2)}`; } } },
      yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 12, borderColor: 'transparent', fillerColor: 'rgba(253,126,20,.15)' }],
      series: [
        { name: '_lo', type: 'line', data: lo, stack: 'band', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
        { name: '90% range', type: 'line', data: width, stack: 'band', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(253,126,20,.14)' }, showSymbol: false, silent: true, itemStyle: { color: 'rgba(253,126,20,.4)' } },
        {
          name: 'History (operational)', type: 'line', data: histVals, showSymbol: false, connectNulls: false, lineStyle: { width: 2.2, color: '#0a2540' }, itemStyle: { color: '#0a2540' }, sampling: 'lttb',
          markLine: { silent: true, symbol: 'none', data: [{ xAxis: nearest(fc.start - 1), lineStyle: { color: '#adb5bd', type: 'solid' }, label: { formatter: 'today', color: '#6c757d', fontSize: 10 } }] },
        },
        {
          name: 'Forecast', type: 'line', data: fcVals, showSymbol: false, lineStyle: { width: 2.6, color: '#fd7e14', type: 'dashed' }, itemStyle: { color: '#fd7e14' }, sampling: 'lttb',
          markLine: { silent: true, symbol: 'none', data: [{ yAxis: fc.buffer, lineStyle: { color: '#b04632', type: 'dashed', width: 1.5 }, label: { formatter: `buffer ${money(fc.buffer)}`, position: 'insideStartTop', color: '#b04632', fontSize: 10.5 } }] },
          markPoint: {
            symbol: 'circle', symbolSize: 10,
            data: [
              { name: 'Low', coord: [nearest(fc.low.day), fc.low.amount], value: fc.low.amount, itemStyle: { color: '#b04632', borderColor: '#fff', borderWidth: 2 }, label: { show: true, position: (fc.low.day - fc.start) / fc.H > 0.85 ? 'left' : 'bottom', formatter: `Low ${money(fc.low.amount)}\n${fmtDay(fc.low.day)}`, color: '#b04632', fontWeight: 700, fontSize: 11, lineHeight: 14 } },
              { name: 'High', coord: [nearest(fc.high.day), fc.high.amount], value: fc.high.amount, itemStyle: { color: '#28a745', borderColor: '#fff', borderWidth: 2 }, label: { show: true, position: (fc.high.day - fc.start) / fc.H > 0.85 ? 'left' : 'top', formatter: `High ${money(fc.high.amount)}`, color: '#1e7b34', fontWeight: 700, fontSize: 11 } },
            ],
          },
          markArea: breaches.length ? { silent: true, data: breaches } : undefined,
        },
        ...(tr ? [{ name: 'After known treasury schedule', type: 'line', data: tr, showSymbol: false, lineStyle: { width: 1.6, color: '#544fc5', type: 'dotted' }, itemStyle: { color: '#544fc5' } }] : []),
        {
          name: '_markers', type: 'scatter', symbol: 'diamond', symbolSize: 9, itemStyle: { color: '#fd7e14', borderColor: '#fff', borderWidth: 1 }, z: 5,
          data: markers.map((m) => { const k = x.indexOf(nearest(m.day)); return k >= 0 ? [x[k], fcVals[k]] : null; }).filter(Boolean),
          tooltip: { show: false },
        },
      ],
    };
  }, [b, granularity, historyMonths, showTreasury]);
  return <EChart option={option} height={height} onReady={onReady} ariaLabel="Cumulative operational cash position: history and forecast" />;
}
