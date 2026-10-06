import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, HeatmapChart, ScatterChart, CustomChart, PieChart } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, MarkPointComponent,
  MarkAreaComponent, VisualMapComponent, TitleComponent, ToolboxComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  LineChart, BarChart, HeatmapChart, ScatterChart, CustomChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
  MarkLineComponent, MarkPointComponent, MarkAreaComponent, VisualMapComponent, TitleComponent, ToolboxComponent, SVGRenderer,
]);

// Chart styling lifted from pwlbtoday.org's charts: light grid, muted 10–12px axis labels,
// navy tooltips, Inter.
echarts.registerTheme('pwlb', {
  color: ['#0a2540', '#fd7e14', '#2caffe', '#2dd4a8', '#544fc5', '#b04632', '#6b8abc', '#feb56a'],
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif', color: '#243240' },
  categoryAxis: {
    axisLine: { lineStyle: { color: '#ced4da' } }, axisTick: { show: false },
    axisLabel: { color: '#6c757d', fontSize: 11 }, splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: '#6c757d', fontSize: 11 }, splitLine: { lineStyle: { color: '#e9ecef' } },
  },
  timeAxis: {
    axisLine: { lineStyle: { color: '#ced4da' } }, axisTick: { show: false },
    axisLabel: { color: '#6c757d', fontSize: 11 }, splitLine: { show: false },
  },
  legend: { textStyle: { color: '#5a6b7b', fontSize: 12 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
  tooltip: {
    backgroundColor: 'rgba(10,37,64,0.96)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 10px 28px rgba(10,37,64,.25);padding:8px 12px;',
  },
});

export interface EChartProps {
  option: EChartsCoreOption;
  height?: number | string;
  onClick?: (p: { name?: string; seriesName?: string; dataIndex?: number; value?: unknown; data?: unknown }) => void;
  onReady?: (chart: echarts.ECharts) => void;
  className?: string;
  notMerge?: boolean;
  ariaLabel?: string;
}

export function EChart({ option, height = 320, onClick, onReady, className, notMerge = true, ariaLabel }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, 'pwlb', { renderer: 'svg' });
    chart.current = c;
    c.on('click', (p) => clickRef.current?.(p as never));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    onReady?.(c);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOption({ animationDuration: 450, animationEasing: 'cubicOut', ...option } as EChartsCoreOption, { notMerge });
  }, [option, notMerge]);

  return <div ref={ref} className={className} style={{ height, width: '100%' }} role="img" aria-label={ariaLabel} />;
}

/** Export a chart instance as SVG or PNG. */
export async function exportChart(c: echarts.ECharts, name: string, kind: 'svg' | 'png') {
  const svgUrl = c.getDataURL({ type: 'svg' } as never);
  if (kind === 'svg') {
    const a = document.createElement('a');
    a.href = svgUrl; a.download = `${name}.svg`; a.click();
    return;
  }
  const img = new Image();
  img.src = svgUrl;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = img.width * scale; canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png'); a.download = `${name}.png`; a.click();
}

export const axisMoney = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `£${(a / 1e9).toFixed(1)}bn` : a >= 1e6 ? `£${(a / 1e6).toFixed(a >= 1e8 ? 0 : 0)}m` : a >= 1e3 ? `£${(a / 1e3).toFixed(0)}k` : `£${a}`;
  return v < 0 ? `−${s}` : s;
};
