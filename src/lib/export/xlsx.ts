// Excel workbook export (SheetJS, bundled — loaded on demand).
import type { Aggregates } from '../analysis/aggregates';
import { annualTotals, yearsOf, monthlyTotals, seasonalProfile, cagr } from '../analysis/history';
import type { ForecastResult } from '../forecast/engine';
import { periodise, sumByPeriod, lastByPeriod } from '../forecast/engine';
import type { BacktestResult } from '../forecast/backtest';
import type { Scenario, TeamFile } from '../model';
import { STARTER_RULES } from '../categorise/starterRules';
import { isoFromDay, fmtDay } from '../dates';
import { STRATEGY_CAVEAT, Strategy } from '../forecast/strategy';

export async function buildWorkbook(o: {
  team: TeamFile; agg: Aggregates; scenario: Scenario; fc: ForecastResult; backtest: BacktestResult | null; appName: string;
  strategy?: Strategy; registerName?: string | null;
}): Promise<Blob> {
  const XLSX = await import('xlsx');
  const { team, agg, scenario, fc, backtest } = o;
  const fyStart = +team.settings.financialYearStart.split('-')[0] || 4;
  const ids = [...agg.catIds, 'uncategorised'];
  const name = (id: string) => team.categories.find((c) => c.id === id)?.name ?? (id === 'uncategorised' ? 'Uncategorised' : id);
  const group = (id: string) => team.categories.find((c) => c.id === id)?.group ?? '';
  const wb = XLSX.utils.book_new();
  const add = (title: string, rows: (string | number | null)[][], widths?: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  };
  const r0 = (x: number) => Math.round(x * 100) / 100;

  add('Summary', [
    [`${o.appName} — ${team.authorityName}`],
    ['Generated', new Date().toLocaleString('en-GB')],
    ['Scenario', scenario.name],
    ['Forecast period', `${fmtDay(fc.start)} to ${fmtDay(fc.start + fc.H - 1)}`],
    ['Opening position', r0(fc.opening)],
    ['Projected low point', r0(fc.low.amount), fmtDay(fc.low.day)],
    ['Projected high point', r0(fc.high.amount), fmtDay(fc.high.day)],
    ['Liquidity buffer', fc.buffer],
    ['Borrowing requirement', r0(fc.borrowingRequirement)],
    [],
    ['Summary', fc.summary],
    [],
    fc.register
      ? [`Includes the deal register (${o.registerName ?? 'deal register'}): ${r0(fc.register.liquid)} held in funds at the start, and ${fc.register.events} dated loan and investment cash flows. Interest on deals is estimated from rates and dates.`]
      : ['Operational flows only. Treasury / deal flows (PWLB, LOBO, LA loans, MMF, DMADF, deposits) are excluded from the model.'],
  ], [28, 60, 20]);

  if (o.strategy) {
    const st = o.strategy;
    add('Options to discuss', [
      ['Options to discuss'], [STRATEGY_CAVEAT], [],
      ['Borrowing needed', r0(st.shortfall), st.shortfallDay ? fmtDay(st.shortfallDay) : ''],
      ['Lasting (over a year)', r0(st.lasting)],
      ['Short term (under a year)', r0(st.shortTerm)],
      [],
      ['Could invest for at least', 'Amount'],
      ...st.ladder.map((r) => [`${r.months} months`, r0(r.amount)]),
      [],
      ['Borrowing needed by', 'Amount'],
      ...st.needBy.map((q) => [isoFromDay(q.day), r0(q.amount)]),
      [],
      ...st.options.map((x) => [x.title, x.body]),
    ], [34, 90, 16, 16, 16, 16]);
  }

  // categorised summary by month (history)
  const ms = monthlyTotals(agg, 'op');
  add('History by month', [['Category', 'Group', ...ms.labels], ...ids.map((id, c) => [name(id), group(id), ...ms.values[c].map(r0)]).filter((r) => r.slice(2).some((v) => v))], [30, 22]);

  // YoY
  const years = yearsOf(agg, 'fy', fyStart);
  const an = annualTotals(agg, years);
  add('Year on year', [
    ['Category', ...years.map((y) => y.label + (y.complete ? '' : ' (part)')), ...years.slice(1).map((y) => `YoY ${y.label} %`), 'CAGR %'],
    ...ids.map((id, c) => {
      const v = an.op[c];
      const g = cagr(v, years);
      return [name(id), ...v.map(r0), ...v.slice(1).map((x, k) => (v[k] && years[k].complete && years[k + 1].complete ? r0((x / v[k] - 1) * 100) : null)), g === null ? null : r0(g * 100)];
    }).filter((r) => (r.slice(1, 1 + years.length) as number[]).some((x) => x)),
  ], [30]);

  // Seasonal profiles
  const prof0 = seasonalProfile(agg, 0, years, 'fy', fyStart);
  add('Seasonal profiles', [['Category (typical month, recurring)', ...prof0.months], ...ids.map((id, c) => [name(id), ...seasonalProfile(agg, c, years, 'fy', fyStart).typical.map(r0)]).filter((r) => r.slice(1).some((v) => v))], [34]);

  // Forecast table
  const p = periodise(fc.start, fc.H, 'monthly');
  const n = p.labels.length;
  const fcRows = fc.catIds.map((id, c) => [name(id), ...sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, n).map(r0)]).filter((r) => r.slice(1).some((v) => v));
  add('Forecast', [
    ['Category', ...p.labels],
    ...fcRows,
    ['Net operational flow', ...sumByPeriod(fc.net, 0, fc.H, p.index, n).map(r0)],
    ['Cumulative position', ...lastByPeriod(fc.cumulative, fc.H, p.index, n).map(r0)],
    ['Lower (90%)', ...lastByPeriod(fc.lower, fc.H, p.index, n).map(r0)],
    ['Upper (90%)', ...lastByPeriod(fc.upper, fc.H, p.index, n).map(r0)],
    ...(fc.register ? [['Everyday cash only (before deal register)', ...lastByPeriod(fc.cumulativeBefore, fc.H, p.index, n).map(r0)]] : []),
    ...(fc.treasuryDaily.some((v) => v) ? [['After known treasury schedule', ...lastByPeriod(fc.cumulativeAfterTreasury, fc.H, p.index, n).map(r0)]] : []),
  ], [30]);

  // Daily forecast
  add('Forecast daily', [['Date', 'Net flow', 'Cumulative', 'Lower', 'Upper'], ...Array.from({ length: fc.H }, (_, d) => [isoFromDay(fc.start + d), r0(fc.net[d]), r0(fc.cumulative[d]), r0(fc.lower[d]), r0(fc.upper[d])])], [12, 14, 14, 14, 14]);

  // Method & assumptions
  add('Methods & assumptions', [
    ['Category', 'Method', 'Growth % p.a.', 'Source', 'Last 12 months', 'Forecast total', 'Notes'],
    ...fc.explain.map((e) => [e.name, e.method, r0(e.growthPct), e.growthSource, r0(e.historyAnnual), r0(e.forecastTotal), e.notes.join(' ')]),
    [],
    ['Assumptions'],
    ['Kind', 'Detail'],
    ...scenario.assumptions.map((a) => [a.kind, JSON.stringify(a)]),
    [],
    ['One-off items'],
    ['Date', 'Amount', 'Category', 'Description', 'Confidence', 'Probability'],
    ...scenario.oneOffs.map((x) => [x.date, x.amount, name(x.categoryId), x.description, x.confidence, x.confidence === 'possible' ? x.probability ?? 0.5 : 1]),
    [],
    ['Pasted schedules'],
    ['Name', 'Category', 'Mode', 'Payments', 'Total'],
    ...scenario.pastedSchedules.map((s) => [s.name, name(s.categoryId), s.mode, s.entries.length, r0(s.entries.reduce((t, e) => t + e.amount, 0))]),
  ], [30, 14, 14, 12, 16, 16, 60]);

  if (backtest) {
    add('Backtest', [
      ['Forecast as if it were', fmtDay(backtest.cutoff)],
      ['Data used up to', fmtDay(backtest.usedDataTo)],
      [],
      ['Months ahead', 'Error (£)', 'Core error (£)', 'Gross flow (£)'],
      ...backtest.errorAt.map((e) => [e.months, r0(e.error), r0(e.coreError), r0(e.actualAbsFlow)]),
      [],
      ['Low point', 'Forecast', fmtDay(backtest.lowForecast.day), r0(backtest.lowForecast.amount)],
      ['', 'Actual', fmtDay(backtest.lowActual.day), r0(backtest.lowActual.amount)],
      [],
      ['Category', 'Forecast', 'Actual', 'Error', 'Monthly MAPE %'],
      ...backtest.categories.map((c) => [c.name, r0(c.forecast), r0(c.actual), r0(c.error), c.mape === null ? null : r0(c.mape * 100)]),
    ], [22, 16, 16, 16, 16]);
  }

  add('Rules', [
    ['Source', 'ID', 'Type', 'Pattern', 'Category', 'Deal flag', 'Direction', 'Min', 'Max', 'Classification', 'Hits', 'Created by', 'Created at'],
    ...team.rules.map((r) => ['team', r.id, r.type, r.pattern, name(r.categoryId), r.dealFlag ?? '', r.direction ?? '', r.minAmount ?? '', r.maxAmount ?? '', r.classification ?? '', r.hits ?? 0, r.createdBy ?? '', r.createdAt ?? '']),
    ...STARTER_RULES.map((r) => ['starter', r.id, r.type, r.pattern, name(r.categoryId), r.dealFlag ?? '', r.direction ?? '', '', '', r.classification ?? '', '', '', '']),
  ], [8, 14, 8, 60, 26, 10, 10]);

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
