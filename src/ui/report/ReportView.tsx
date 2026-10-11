import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { STRATEGY_CAVEAT } from '../../lib/forecast/strategy';
import { EChart, axisMoney } from '../components/EChart';
import { computeForecast, ForecastBundle } from '../forecast/useForecast';
import { periodise, sumByPeriod, lastByPeriod } from '../../lib/forecast/engine';
import { annualTotals, yearsOf, cagr } from '../../lib/analysis/history';
import type { BacktestResult } from '../../lib/forecast/backtest';
import type { Assumption } from '../../lib/model';
import { money, pct, pctDone, day, int } from '../../lib/format';
import { historySpan } from '../../lib/history/cashHistory';
import { fmtDay, dayFromISO, ymdFromDay, MONTH_NAMES } from '../../lib/dates';
import { APP_NAME, PARENT_BRAND } from '../../config';
import { UNCATEGORISED_COLOUR } from '../../lib/categories';

/**
 * Board-quality, multi-page A4 report. On screen the pages are shown as sheets; printing
 * (or "Save as PDF") produces exactly these pages.
 */
export function ReportView({ b, backtest }: { b: ForecastBundle; backtest: () => Promise<BacktestResult | null> }) {
  const s = useStore();
  const { team, agg, ingest, cat, basis, historyBase } = s;
  const m = (x: number, sign?: boolean) => money(x, { unit: 'm', sign }); // table figures: all in £m
  const sc = team.forecasts.find((f) => f.id === s.activeScenarioId) ?? team.forecasts[0];
  const fc = b.fc;
  const [bt, setBt] = useState<BacktestResult | null>(null);
  useEffect(() => { void backtest().then(setBt); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fyStart = +team.settings.financialYearStart.split('-')[0] || 4;
  const prepared = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const catName = (id: string) => team.categories.find((c) => c.id === id)?.name ?? (id === 'uncategorised' ? 'Uncategorised' : id);
  const catColour = (id: string) => team.categories.find((c) => c.id === id)?.colour ?? UNCATEGORISED_COLOUR;

  // ---------- monthly table ----------
  const monthly = useMemo(() => {
    const p = periodise(fc.start, fc.H, 'monthly');
    const n = p.labels.length;
    const inflow = new Array(n).fill(0), outflow = new Array(n).fill(0);
    fc.catIds.forEach((_, c) => {
      const v = sumByPeriod(fc.daily, c * fc.H, fc.H, p.index, n);
      v.forEach((x, k) => { if (x >= 0) inflow[k] += x; else outflow[k] += x; });
    });
    const net = sumByPeriod(fc.net, 0, fc.H, p.index, n);
    const close = lastByPeriod(fc.cumulative, fc.H, p.index, n);
    const lo = lastByPeriod(fc.lower, fc.H, p.index, n);
    const hi = lastByPeriod(fc.upper, fc.H, p.index, n);
    // month minimum (intra-month low)
    const minIn = new Array(n).fill(Infinity);
    for (let d = 0; d < fc.H; d++) minIn[p.index[d]] = Math.min(minIn[p.index[d]], fc.cumulative[d]);
    return { labels: p.labels, inflow, outflow, net, close, lo, hi, minIn };
  }, [fc]);

  // ---------- by category & FY ----------
  const fyOfDay = (d: number) => { const { y, m } = ymdFromDay(d); const f = m >= fyStart ? y : y - 1; return `${f}/${String((f + 1) % 100).padStart(2, '0')}`; };
  const fyLabels = useMemo(() => [...new Set(Array.from({ length: fc.H }, (_, d) => fyOfDay(fc.start + d)))], [fc]); // eslint-disable-line react-hooks/exhaustive-deps
  const catRows = useMemo(() => fc.explain.filter((e) => Math.abs(e.forecastTotal) > 1).map((e) => {
    const per = fyLabels.map((l) => { let t = 0; for (let d = 0; d < fc.H; d++) if (fyOfDay(fc.start + d) === l) t += fc.daily[e.catIdx * fc.H + d]; return t; });
    return { e, per };
  }).sort((a, z) => Math.abs(z.e.forecastTotal) - Math.abs(a.e.forecastTotal)), [fc, fyLabels]); // eslint-disable-line react-hooks/exhaustive-deps
  // keep the table on its page: the 18 largest categories, the rest in one line
  const shownCats = catRows.length > 19 ? catRows.slice(0, 18) : catRows;
  const restCats = catRows.slice(shownCats.length);
  const fyNet = fyLabels.map((l) => { let t = 0; for (let d = 0; d < fc.H; d++) if (fyOfDay(fc.start + d) === l) t += fc.net[d]; return t; });

  // ---------- history ----------
  const hist = useMemo(() => {
    if (!agg) return null;
    const years = yearsOf(agg, 'fy', fyStart);
    const an = annualTotals(agg, years);
    const C1 = agg.catIds.length + 1;
    const net = years.map((_, yi) => { let t = 0; for (let c = 0; c < C1; c++) t += an.op[c][yi]; return t; });
    const ids = [...agg.catIds, 'uncategorised'];
    const movers = ids.map((id, c) => ({ id, g: cagr(an.op[c], years), last: an.op[c][years.length - 1], first: an.op[c].find((_, k) => years[k].complete) ?? 0 }))
      .filter((m) => m.g !== null && Math.abs(m.last) > 5e6 && team.categories.find((c) => c.id === m.id)?.group !== 'treasury' && m.id !== 'internal_transfer')
      .sort((a, z) => Math.abs(z.last - z.first) - Math.abs(a.last - a.first)).slice(0, 8);
    return { years, net, movers };
  }, [agg, fyStart, team.categories]);

  // ---------- scenarios ----------
  const register = useStore((s) => s.register);
  const compare = useMemo(() => (basis && team.forecasts.length > 1 ? team.forecasts.slice(0, 4).map((f) => ({ f, r: computeForecast(basis, f, team.categories, team.settings.liquidityBuffer, fyStart, register) })) : []), [basis, team, fyStart, register]);

  const span = historyBase ? historySpan(historyBase) : null;
  // how wide the likely range gets further ahead
  const rangeAt = [3, 6, 12, 24].map((mo) => ({ mo, k: Math.round((mo * 365.25) / 12) - 1 })).filter((x) => x.k < fc.H)
    .map(({ mo, k }) => ({ mo, day: fc.start + k, mid: fc.cumulative[k], lo: fc.lower[k], hi: fc.upper[k] }));
  const firstBreach = fc.breaches[0];
  const horizonEnd = fc.start + fc.H - 1;
  const assumptionText = (a: Assumption): string => {
    switch (a.kind) {
      case 'growth': return `${catName(a.categoryId)}: ${a.pct >= 0 ? '+' : ''}${a.pct}% a year (${a.mode === 'annual_step' ? 'from each April' : 'steady'})`;
      case 'step': return `${catName(a.categoryId)}: ${a.pct >= 0 ? '+' : ''}${a.pct}% from ${day(dayFromISO(a.effective))}${a.backdateFrom ? `, backdated to ${day(dayFromISO(a.backdateFrom))}` : ''}`;
      case 'timing': return `${catName(a.categoryId)}${a.signature ? ` (${a.signature.replace(/\S*#\S*/g, '').trim()})` : ''}: paid on ${a.rule === 'last_working_day' ? 'the last working day' : a.rule === 'weekday' ? `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][a.weekday ?? 5]}` : `day ${a.dayOfMonth}`} from ${day(dayFromISO(a.from))}`;
      case 'stop': return `${catName(a.categoryId)}${a.signature ? `: ${a.signature.replace(/\S*#\S*/g, '').trim()} removed` : ' stops'} from ${day(dayFromISO(a.from))}`;
      case 'start': return `New ${a.cadence.replace('_', '-')} ${money(a.amount)} in ${catName(a.categoryId)} from ${day(dayFromISO(a.from))}`;
      case 'inflation': return `Inflation +${a.pct}% a year on ${a.categoryIds.length} categories`;
    }
  };
  const keyPoints: ReactNode[] = [
    <>Everyday cash is expected to reach its lowest point of <strong>{money(fc.low.amount)}</strong> on <strong>{fmtDay(fc.low.day)}</strong>.</>,
    fc.borrowingRequirement > 0
      ? <>To keep at least <strong>{money(fc.buffer)}</strong> in the bank, the council may need to borrow about <strong>{money(fc.borrowingRequirement)}</strong> by then.</>
      : <>Cash stays above the <strong>{money(fc.buffer)}</strong> minimum throughout, so no new borrowing should be needed.</>,
    firstBreach ? <>Cash first falls below that minimum on <strong>{fmtDay(firstBreach.from)}</strong>{fc.breaches.length > 1 ? `, and dips below it ${fc.breaches.length === 2 ? 'twice' : `${fc.breaches.length} times`} over the period` : ''}.</> : null,
    fc.borrowingRequirement > 0
      ? <>The highest point is <strong>{money(fc.high.amount)}</strong> on {fmtDay(fc.high.day)}, before cash falls.</>
      : <>The highest point is <strong>{money(fc.high.amount)}</strong> on {fmtDay(fc.high.day)}, the best time to invest any spare cash.</>,
    fc.drivers.length ? <>The biggest reasons for the fall are {fc.drivers.map((d) => d.name.toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1')}.</> : null,
    fc.treasuryDaily.some((v) => v) ? <>After known treasury commitments the position at {fmtDay(horizonEnd)} is <strong>{money(fc.cumulativeAfterTreasury[fc.H - 1])}</strong>.</> : null,
  ].filter(Boolean);
  const common = { total: 7, head: s.advanced ? `${team.authorityName} · ${sc.name} scenario` : team.authorityName, foot: `Prepared ${prepared}${s.user ? ` by ${s.user}` : ''}` };
  return (
    <div className="r-doc">
      {/* 1 ---------------------------------------------------------------- cover */}
      <RPage {...common} n={1} cover>
        <div className="r-cover-band">
          <div className="r-cover-brand"><span>PWLB<b>today</b></span> · {APP_NAME}</div>
          <div className="r-cover-kicker">Cash flow forecast</div>
          <h1>{team.authorityName}</h1>
          <div className="r-cover-meta">{s.advanced ? `${sc.name} scenario · ` : ''}{fmtDay(fc.start)} to {fmtDay(horizonEnd)}</div>
        </div>
        <div className="r-cover-kpis">
          <div><div className="l">Lowest point</div><div className="v">{money(fc.low.amount)}</div><div className="s">{fmtDay(fc.low.day)}</div></div>
          <div className="hl"><div className="l">May need to borrow</div><div className="v">{money(fc.borrowingRequirement)}</div><div className="s">to keep {money(fc.buffer)} in the bank</div></div>
          <div><div className="l">Highest point</div><div className="v">{money(fc.high.amount)}</div><div className="s">{fmtDay(fc.high.day)}</div></div>
          {firstBreach
            ? <div><div className="l">Below minimum from</div><div className="v">{fmtDay(firstBreach.from)}</div><div className="s">first dip below {money(fc.buffer)}</div></div>
            : <div><div className="l">Position at end</div><div className="v">{money(fc.cumulative[fc.H - 1])}</div><div className="s">{fmtDay(horizonEnd)}</div></div>}
        </div>
        <div className="r-cover-summary">
          <div className="r-label">Summary</div>
          <p>{fc.summary}</p>
        </div>
        <div className="r-cover-chart">
          <ReportChart b={b} height={250} />
        </div>
        <div className="r-cover-foot">
          <div><strong>Prepared</strong> {prepared}{s.user ? ` by ${s.user}` : ''}</div>
          <div><strong>Based on</strong> {ingest ? `${int(ingest.rows)} bank transactions, ${fmtDay(ingest.minDay)} to ${fmtDay(ingest.maxDay)}` : span ? `bank history, ${fmtDay(span.from)} to ${fmtDay(span.to)}` : 'saved history'}{register ? ' and the deal register' : ''}</div>
          <div><strong>Opening position</strong> {money(fc.opening)}</div>
        </div>
      </RPage>

      {/* 2 ---------------------------------------------------------------- executive summary */}
      <RPage {...common} n={2} title="1. Executive summary">
        {register
          ? <p className="r-intro">This forecast shows the council’s <strong>cash position</strong>: normal income and spending projected from bank history, plus the loans, investments and interest recorded in the council’s deal register, and money held in funds. It shows when the council may need to borrow and when it will have spare cash to invest.</p>
          : <p className="r-intro">This forecast shows the council’s <strong>everyday cash</strong> (normal income and spending, leaving out borrowing and investments) so you can see when the council may need to borrow and when it will have spare cash to invest.</p>}
        <div className="r-callout">
          <div className="r-label">Key points</div>
          <ul>{keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </div>
        <h3>Cash position: history and forecast</h3>
        <ReportChart b={b} height={300} showHistory />
        <p className="r-caption">Solid line: the past. Dashed line: the forecast. Shaded area: the likely range, which widens further ahead. Red dashed line: the minimum cash you want to keep.</p>
        {compare.length > 1 && (
          <>
            <h3>Scenarios compared</h3>
            <table className="r-tbl">
              <thead><tr><th>Scenario</th><th className="n">Low point</th><th>Date</th><th className="n">Borrowing requirement</th><th className="n">Position at end</th></tr></thead>
              <tbody>{compare.map(({ f, r }) => <tr key={f.id} className={f.id === sc.id ? 'hl' : ''}><td>{f.name}</td><td className="n">{money(r.fc.low.amount)}</td><td>{fmtDay(r.fc.low.day)}</td><td className="n"><strong>{money(r.fc.borrowingRequirement)}</strong></td><td className="n">{money(r.fc.cumulative[r.fc.H - 1])}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </RPage>

      {/* 3 ---------------------------------------------------------------- options to discuss */}
      <RPage {...common} n={3} title="2. Options to discuss">
        <p className="r-intro">What the forecast{register ? ' and the council’s deal register' : ''} suggest about borrowing and investing. {STRATEGY_CAVEAT}</p>
        <div className="r-cover-kpis r-kpis-inline">
          <div className="hl"><div className="l">Borrowing needed</div><div className="v">{money(b.strategy.shortfall)}</div><div className="s">{b.strategy.shortfallDay ? `by ${fmtDay(b.strategy.shortfallDay)}` : 'none'}</div></div>
          <div><div className="l">Lasting (over a year)</div><div className="v">{money(b.strategy.lasting)}</div><div className="s">does not recover in 12 months</div></div>
          <div><div className="l">Short term</div><div className="v">{money(b.strategy.shortTerm)}</div><div className="s">recovers within 12 months</div></div>
          <div><div className="l">Could invest a year</div><div className="v">{money(b.strategy.ladder.find((r) => r.months === 12)?.amount ?? 0)}</div><div className="s">on the cautious line</div></div>
        </div>
        <ol className="r-options">{b.strategy.options.map((o, i) => <li key={i} className={o.tone}><strong>{o.title}.</strong> {o.body}</li>)}</ol>
        {b.strategy.ladder.length > 0 && (
          <>
            <h3>Cash that could be invested for longer</h3>
            <table className="r-tbl r-tbl-tight"><thead><tr><th>Could be invested for</th>{b.strategy.ladder.map((r) => <th key={r.months} className="n">{r.months} month{r.months > 1 ? 's' : ''}</th>)}</tr></thead>
              <tbody><tr><td>Amount</td>{b.strategy.ladder.map((r) => <td key={r.months} className="n">{m(r.amount)}</td>)}</tr></tbody></table>
            <p className="r-caption">Cash that stays above the {money(fc.buffer)} minimum for that long, even at the bottom of the likely range.</p>
          </>
        )}
      </RPage>

      {/* 4 ---------------------------------------------------------------- monthly profile */}
      <RPage {...common} n={4} title="3. Month by month">
        <p className="r-intro">Expected money in and out each month, with the cash position at the end of the month and the lowest point during it. Months where cash dips below the {money(fc.buffer)} minimum are highlighted.</p>
        <EChart height={190} option={{
          animation: false, grid: { left: 58, right: 10, top: 10, bottom: 24 },
          xAxis: { type: 'category', data: monthly.labels, axisLabel: { fontSize: 9 } },
          yAxis: { type: 'value', axisLabel: { formatter: axisMoney, fontSize: 9 } },
          series: [{ type: 'bar', data: monthly.net.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? '#2caffe' : '#fd7e14' } })) }],
        }} />
        <table className="r-tbl r-tbl-tight">
          <thead><tr><th>Month</th><th className="n">Money in</th><th className="n">Money out</th><th className="n">Difference</th><th className="n">Cash at month end</th><th className="n">Lowest in month</th><th className="n">Likely range</th></tr></thead>
          <tbody>{monthly.labels.slice(0, 24).map((l, k) => (
            <tr key={l} className={monthly.minIn[k] < fc.buffer ? 'warn' : ''}>
              <td>{l}</td><td className="n">{m(monthly.inflow[k])}</td><td className="n">{m(monthly.outflow[k])}</td><td className="n">{m(monthly.net[k], true)}</td>
              <td className="n"><strong>{m(monthly.close[k])}</strong></td><td className="n">{m(monthly.minIn[k])}</td><td className="n r-muted">{m(monthly.lo[k])} to {m(monthly.hi[k])}</td>
            </tr>
          ))}</tbody>
        </table>
        {monthly.labels.length > 24 && <p className="r-caption">First 24 months shown; the full table is in the Excel workbook.</p>}
      </RPage>

      {/* 4 ---------------------------------------------------------------- drivers & assumptions */}
      <RPage {...common} n={5} title="4. What drives the forecast">
        <p className="r-intro">The forecast for each category by financial year (April to March), and how each is worked out. Money in is positive, money out negative.</p>
        <table className="r-tbl r-tbl-tight">
          <thead><tr><th>Category</th><th>Worked out from</th><th className="n">Growth</th>{fyLabels.map((l) => <th key={l} className="n">{l}</th>)}</tr></thead>
          <tbody>
            {shownCats.map(({ e, per }) => <tr key={e.id}><td><span className="r-sw" style={{ background: catColour(e.id) }} />{e.name}</td><td className="r-muted">{({ seasonal: 'Past monthly pattern', series: 'Regular payments', flat: 'Past average', manual: 'Your schedule', exclude: 'Left out' } as Record<string, string>)[e.method]}</td><td className="n">{pct(e.growthPct / 100, 1, true)}</td>{per.map((v, k) => <td key={k} className="n">{m(v)}</td>)}</tr>)}
            {restCats.length > 0 && <tr><td>{restCats.length} smaller categories</td><td /><td />{fyLabels.map((_, k) => <td key={k} className="n">{m(restCats.reduce((t, x) => t + x.per[k], 0))}</td>)}</tr>}
            <tr className="tot"><td>Difference (in minus out)</td><td /><td />{fyNet.map((v, k) => <td key={k} className="n">{m(v, true)}</td>)}</tr>
          </tbody>
        </table>
        <h3>Assumptions and known items</h3>
        <div className="r-two">
          <div>
            <div className="r-label">Changes and growth assumed</div>
            {sc.assumptions.length ? <ul className="r-list">{sc.assumptions.map((a) => <li key={a.id}>{assumptionText(a)}{a.note ? <span className="r-muted"> ({a.note})</span> : ''}</li>)}</ul>
              : <p className="r-muted">None: each category follows its historic trend.</p>}
          </div>
          <div>
            <div className="r-label">One-off items, schedules and figures entered</div>
            {sc.oneOffs.length + sc.pastedSchedules.length + (sc.overrides?.length ?? 0) ? <ul className="r-list">
              {[...new Set((sc.overrides ?? []).map((o) => o.categoryId))].map((id) => { const os = (sc.overrides ?? []).filter((o) => o.categoryId === id); return <li key={`ov-${id}`}>{catName(id)}: {os.length} figure{os.length > 1 ? 's' : ''} entered by hand ({os.filter((o) => o.date).length} for single days), {money(os.reduce((t, o) => t + o.amount, 0), { sign: true })} in total{os.some((o) => o.row.startsWith('custom:')) ? ` (incl. ${[...new Set(os.filter((o) => o.row.startsWith('custom:')).map((o) => o.row.slice(7)))].join(', ')})` : ''}</li>; })}
              {sc.oneOffs.map((o) => <li key={o.id}>{fmtDay(dayFromISO(o.date))}: {o.description || catName(o.categoryId)} {money(o.amount, { sign: true })} <span className="r-muted">({o.confidence}{o.confidence === 'possible' ? `, ${Math.round((o.probability ?? 0.5) * 100)}%` : ''})</span></li>)}
              {sc.pastedSchedules.map((p) => <li key={p.id}>{p.name}: {p.entries.length} payments, {money(p.entries.reduce((t, e) => t + e.amount, 0))} <span className="r-muted">({p.mode === 'replace' ? 'replaces the model' : 'on top of the model'})</span></li>)}
            </ul> : <p className="r-muted">None entered.</p>}
          </div>
        </div>
      </RPage>

      {/* 5 ---------------------------------------------------------------- history */}
      <RPage {...common} n={6} title="5. The history behind it">
        <p className="r-intro">The forecast is built from the council’s own bank history. The difference between money in and money out each year shows the trend the forecast continues.</p>
        {hist ? (
          <>
            <EChart height={230} option={{
              animation: false, grid: { left: 58, right: 10, top: 16, bottom: 24 },
              xAxis: { type: 'category', data: hist.years.map((y) => y.label + (y.complete ? '' : '*')) },
              yAxis: { type: 'value', axisLabel: { formatter: axisMoney, fontSize: 9 } },
              series: [{ type: 'bar', barWidth: '45%', data: hist.net.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? '#28a745' : '#b04632', borderRadius: [3, 3, 0, 0] } })), label: { show: true, position: 'top', formatter: (p: { value: number }) => axisMoney(p.value), fontSize: 9, color: '#243240' } }],
            }} />
            <p className="r-caption">* part year. Leaves out borrowing, investments and transfers between the council’s own accounts.</p>
            <h3>Biggest movers</h3>
            <table className="r-tbl">
              <thead><tr><th>Category</th><th className="n">First full year</th><th className="n">Latest year</th><th className="n">Average growth each year</th></tr></thead>
              <tbody>{hist.movers.map((mv) => <tr key={mv.id}><td><span className="r-sw" style={{ background: catColour(mv.id) }} />{catName(mv.id)}</td><td className="n">{m(mv.first)}</td><td className="n">{m(mv.last)}</td><td className="n">{mv.g === null ? '–' : pct(mv.g, 1, true)}</td></tr>)}</tbody>
            </table>
          </>
        ) : <p className="r-muted">Load the bank data to include the historic analysis.</p>}
      </RPage>

      {/* 6 ---------------------------------------------------------------- confidence */}
      <RPage {...common} n={7} title="6. How much confidence to place in it">
        <h3 style={{ marginTop: 0 }}>The likely range</h3>
        <p className="r-intro">The forecast is a central estimate. The likely range comes from how much each category has varied around its own pattern in the past, so it widens the further ahead you look.</p>
        <table className="r-tbl r-tbl-tight">
          <thead><tr><th>After</th><th>Date</th><th className="n">Central forecast</th><th className="n">Likely range</th><th className="n">Width</th></tr></thead>
          <tbody>{rangeAt.map((x) => <tr key={x.mo}><td>{x.mo} months</td><td>{fmtDay(x.day)}</td><td className="n"><strong>{m(x.mid)}</strong></td><td className="n">{m(x.lo)} to {m(x.hi)}</td><td className="n">{m(x.hi - x.lo)}</td></tr>)}</tbody>
        </table>
        <h3>Forecast vs actual: a year ago</h3>
        {bt ? (
          <>
            <p className="r-intro">The same forecast, produced as if it were <strong>{fmtDay(bt.cutoff)}</strong> using only the data available then, against what actually happened over the following year.</p>
            <EChart height={150} option={{
              animation: false, legend: { top: 0, right: 0, textStyle: { fontSize: 9 } }, grid: { left: 58, right: 10, top: 24, bottom: 22 },
              xAxis: { type: 'category', data: Array.from({ length: bt.H }, (_, d) => fmtDay(bt.cutoff + d)), axisLabel: { fontSize: 9, interval: Math.floor(bt.H / 6) } },
              yAxis: { type: 'value', axisLabel: { formatter: axisMoney, fontSize: 9 }, scale: true },
              series: [
                { name: 'Forecast', type: 'line', data: bt.forecastCum, showSymbol: false, lineStyle: { color: '#fd7e14', type: 'dashed', width: 2 }, itemStyle: { color: '#fd7e14' } },
                { name: 'Actual', type: 'line', data: bt.actualCum, showSymbol: false, lineStyle: { color: '#0a2540', width: 2 }, itemStyle: { color: '#0a2540' } },
                { name: 'Actual excluding one-offs', type: 'line', data: bt.actualCoreCum, showSymbol: false, lineStyle: { color: '#2caffe', type: 'dotted', width: 1.5 }, itemStyle: { color: '#2caffe' } },
              ],
            }} />
            <table className="r-tbl r-tbl-tight">
              <thead><tr><th>After</th><th className="n">Gap: forecast vs actual</th><th className="n">Gap excluding one-offs</th><th className="n">As % of cash flowing</th></tr></thead>
              <tbody>{bt.errorAt.map((e) => <tr key={e.months}><td>{e.months} months</td><td className="n">{m(e.error, true)}</td><td className="n">{m(e.coreError, true)}</td><td className="n">{pct(Math.abs(e.error) / Math.max(1, e.actualAbsFlow), 1)}</td></tr>)}</tbody>
            </table>
            <p className="r-caption">The forecast captures the regular cash rhythm; one-off items (land sales, ad hoc grants) need judgement and should be entered as known items when they are expected.</p>
          </>
        ) : <p className="r-muted">This compares the forecast the method would have made a year ago with what actually happened. It needs at least a year and a half of history: a year to learn from, and six months to compare with.</p>}
        <div className="r-two" style={{ marginTop: 10 }}>
          <div>
            <h3>Data quality</h3>
            {ingest && cat ? (
              <ul className="r-list">
                <li>{int(ingest.rows)} transactions from {ingest.files.length} file{ingest.files.length === 1 ? '' : 's'} and {ingest.accounts.length} account{ingest.accounts.length === 1 ? '' : 's'}.</li>
                <li>{pctDone(cat.valueCategorisedPct)} of all money categorised.</li>
                <li>{money(cat.treasuryAbs)} of borrowing and investment flows identified and excluded ({money(cat.suspectedAbs)} suspected rather than confirmed).</li>
                <li>{int(ingest.rejectsTotal)} lines skipped (totals rows, invalid dates); {ingest.balanceChecks.reduce((t, x) => t + x.breaks, 0)} balance check breaks.</li>
                {cat.dealLikeOpAbs > 0 && <li>{money(cat.dealLikeOpAbs)} of loan-like items remain in the operational figures and should be reviewed.</li>}
              </ul>
            ) : historyBase && span ? (
              <ul className="r-list">
                <li>Saved bank history from {fmtDay(span.from)} to {fmtDay(span.to)} ({(Math.round(((span.to - span.from + 1) / 365.25) * 10) / 10).toLocaleString('en-GB')} years) across {historyBase.accounts.length} account{historyBase.accounts.length === 1 ? '' : 's'}.</li>
                <li>{historyBase.series.length} regular payments recognised and projected on their own dates.</li>
                <li>Borrowing, investments and transfers between the council’s own accounts were set aside when the history was sorted.</li>
                {register && <li>Deal register: {register.loans.length} loans and {register.investments.length} investments{register.asAt ? `, as at ${fmtDay(register.asAt)}` : ''}.</li>}
              </ul>
            ) : <p className="r-muted">Not available.</p>}
          </div>
          <div>
            <h3>Method in brief</h3>
            <ul className="r-list">
              <li>Bank lines sorted by clear rules; each records the rule used.</li>
              <li>Borrowing and investment flows (PWLB, LOBO, council loans, funds, DMADF) left out of the pattern{register ? ' and taken from the deal register instead' : ''}.</li>
              <li>Regular payments projected on their own dates; the rest follows the seasonal pattern, with growth. One-offs set aside.</li>
              <li>Processed entirely on the preparer’s computer; nothing uploaded.</li>
            </ul>
          </div>
        </div>
      </RPage>
    </div>
  );
}

function RPage({ n, total, title, children, cover, head, foot }: { n: number; total: number; title?: string; children: ReactNode; cover?: boolean; head: string; foot: string }) {
  return (
    <section className={`r-page ${cover ? 'r-cover' : ''}`}>
      {!cover && <header className="r-head"><span className="r-brand">{PARENT_BRAND} · {APP_NAME}</span><span>{head}</span></header>}
      {title && <h2 className="r-title">{title}</h2>}
      <div className="r-body">{children}</div>
      <footer className="r-foot"><span>{foot}</span><span>Page {n} of {total}</span></footer>
    </section>
  );
}

function ReportChart({ b, height, showHistory }: { b: ForecastBundle; height: number; showHistory?: boolean }) {
  const option = useMemo(() => {
    const { fc, hist } = b;
    const from = showHistory ? Math.max(hist.startDay, fc.start - 365) : fc.start;
    const x: string[] = [], h: (number | null)[] = [], f: (number | null)[] = [], lo: (number | null)[] = [], w: (number | null)[] = [];
    for (let d = from; d < fc.start + fc.H; d += 3) {
      const { y, m, d: dd } = ymdFromDay(d);
      x.push(`${dd} ${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`);
      if (d < fc.start) { h.push(hist.values[d - hist.startDay]); f.push(null); lo.push(null); w.push(null); }
      else { const k = d - fc.start; h.push(null); f.push(fc.cumulative[k]); lo.push(fc.lower[k]); w.push(fc.upper[k] - fc.lower[k]); }
    }
    const join = h.findIndex((v) => v === null);
    if (join > 0) f[join - 1] = h[join - 1];
    return {
      animation: false,
      grid: { left: 58, right: 12, top: 12, bottom: 24 },
      xAxis: { type: 'category', data: x, axisLabel: { fontSize: 9, interval: Math.floor(x.length / 7) } },
      yAxis: { type: 'value', axisLabel: { formatter: axisMoney, fontSize: 9 }, scale: true },
      series: [
        { type: 'line', data: lo, stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true },
        { type: 'line', data: w, stack: 'b', stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, areaStyle: { color: 'rgba(253,126,20,.16)' } },
        { type: 'line', data: h, showSymbol: false, lineStyle: { color: '#0a2540', width: 2 } },
        { type: 'line', data: f, showSymbol: false, lineStyle: { color: '#fd7e14', width: 2.4, type: 'dashed' },
          markLine: { silent: true, symbol: 'none', data: [{ yAxis: fc.buffer }], lineStyle: { color: '#b04632', type: 'dashed' }, label: { formatter: 'minimum cash', fontSize: 9, color: '#b04632', position: 'insideStartTop' } },
          markPoint: { symbol: 'circle', symbolSize: 9, data: [{ coord: [x[Math.min(x.length - 1, Math.round((fc.low.day - from) / 3))], fc.low.amount], itemStyle: { color: '#b04632', borderColor: '#fff', borderWidth: 2 }, label: { show: true, formatter: `Low ${money(fc.low.amount)}`, position: (fc.low.day - fc.start) / fc.H > 0.8 ? 'left' : 'bottom', fontSize: 10, fontWeight: 700, color: '#b04632' } }] } },
      ],
    };
  }, [b, showHistory]);
  return <EChart option={option} height={height} />;
}
