// Forecast vs actual: the forecast this method would have made a while ago, from the history
// up to then, against what actually happened. Works from the saved history alone.
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Kpi, Panel, Seg } from '../components/common';
import { EChart, axisMoney } from '../components/EChart';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromYMD, dayFromISO, ymdFromDay, firstDayOfMonthIndex, monthIndex, MONTH_NAMES } from '../../lib/dates';
import { compareSigned, reforecastSigned, withdrawals, type SignedForecast, fullMonthsLabel, monthEndIndex, firstFairMonthEnd, MIN_COMPARE_DAYS } from '../../lib/forecast/signoff';

const monthName = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };
import { useTracking, useActiveSignOffs, useArrivals } from './useTracking';
import { timingAt, heldAsOneOff, type Arrival } from '../../lib/forecast/early';
import { backtestFromHistory, type BacktestResult } from '../../lib/forecast/backtest';
import { historySpan, type CashHistory } from '../../lib/history/cashHistory';
import type { Category } from '../../lib/categories';
import type { Scenario } from '../../lib/model';

/** A forecast needs a year of history behind it to learn from. */
const LEARN_DAYS = 365;

/** The first of the month `months` before the month after the history ends, if there's a year of history before it. */
export function pastCutoff(h: CashHistory | null, months: number): number | null {
  const span = h ? historySpan(h) : null;
  if (!span) return null;
  // counted back from the start of the month after the history ends (30 Mar → 1 Apr)
  const { y: ey, m: em } = ymdFromDay(span.to);
  const cutoff = addMonths(addMonths(dayFromYMD(ey, em, 1), 1), -months);
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
  const signed = useActiveSignOffs();
  // with every sign-off withdrawn there's still somewhere to restore them
  const any = useStore((s) => (s.team.signedOff ?? []).length > 0);
  const [view, setView] = useState<'signed' | 'method'>('signed');
  const v = any ? view : 'method';
  return (
    <div className="stack">
      {any && <Seg value={v} onChange={setView} options={[{ v: 'signed', label: `Signed-off forecasts (${signed.length})` }, { v: 'method', label: 'Test the method' }]} ariaLabel="What to compare" />}
      {v === 'signed' ? <SignedView sc={sc} /> : <MethodCheck sc={sc} />}
      {!any && <p className="xs muted" style={{ margin: 0 }}>When you sign off a forecast (under <strong>Forecast</strong>, on <strong>Your forecast</strong>), it’s kept exactly as it stands and compared here with what actually happens as new statements come in. Until then, test the method below.</p>}
    </div>
  );
}

/** Your signed-off forecasts, newest first, each against what has happened since. */
/** Which sign-off the main menu and Today's statement report on: this one, or (the default) the newest with a month of statements. */
function HomeChoice({ id, tracked }: { id: string; tracked: boolean }) {
  const chosen = useStore((s) => s.team.settings.trackedSignOff);
  const updateTeam = useStore((s) => s.updateTeam);
  const set = (v: string | undefined) => updateTeam((t) => ({ ...t, settings: { ...t.settings, trackedSignOff: v } }));
  return (
    <div className="xs">
      {chosen === id
        ? <><i className="bi bi-grid-3x3-gap-fill" /> The main menu and Daily report on this one, as your team chose. <button className="link-btn" onClick={() => set(undefined)}>Go back to the newest</button></>
        : tracked
          ? <><i className="bi bi-grid-3x3-gap" /> The main menu and Daily report on this one: the newest with a month of statements. <button className="link-btn" onClick={() => set(id)}>Keep reporting on it</button></>
          : <button className="link-btn" onClick={() => set(id)}>Report on this one on the main menu</button>}
    </div>
  );
}

/** Withdraw a sign-off made by mistake: it stays in the team file, marked withdrawn, and can be restored. */
function WithdrawButton({ rec }: { rec: SignedForecast }) {
  const { askConfirm, changeSignOff, toast } = useStore();
  const go = async () => {
    let reason = '';
    const yes = await askConfirm({
      title: `Withdraw “${rec.scenarioName}”, signed off ${day(dayFromISO(rec.signedAt.slice(0, 10)))}?`,
      body: 'It’s no longer compared with what happens, or reported on the main menu. Nothing is deleted: it stays in the team file, marked withdrawn by you, and you can restore it under Withdrawn.',
      ok: 'Withdraw', danger: true,
      note: { label: 'Why', placeholder: 'e.g. signed off by mistake; replaced by the mid-year review', onValue: (v) => { reason = v; } },
    });
    if (!yes) return;
    changeSignOff(rec.id, 'withdraw', reason);
    toast('Withdrawn. You can restore it under Withdrawn on this page.');
  };
  return <div className="xs"><button className="link-btn muted" onClick={() => void go()}>Withdraw this sign-off</button></div>;
}

/** Sign-offs withdrawn, with who withdrew them, when and why; each can be restored. */
function Withdrawn() {
  const { team, changeSignOff, toast } = useStore();
  const w = withdrawals(team.signOffChanges);
  const list = (team.signedOff ?? []).filter((x) => w.has(x.id)).sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  if (!list.length) return null;
  return (
    <details className="fold">
      <summary>Withdrawn ({list.length})</summary>
      <table className="tbl simple-tbl">
        <thead><tr><th>Forecast</th><th>Signed off</th><th>Withdrawn</th><th /></tr></thead>
        <tbody>{list.map((x) => {
          const c = w.get(x.id)!;
          return (
            <tr key={x.id}>
              <td><strong>{x.scenarioName}</strong> <span className="xs muted">from {day(dayFromISO(x.start))}{x.note ? ` · “${x.note}”` : ''}</span></td>
              <td className="small">{day(dayFromISO(x.signedAt.slice(0, 10)))} · {x.signedBy}</td>
              <td className="small">{day(dayFromISO(c.at.slice(0, 10)))} · {c.by}{c.reason ? <span className="muted"> · “{c.reason}”</span> : null}</td>
              <td><button className="btn sm ghost" onClick={() => { changeSignOff(x.id, 'restore'); toast('Restored: it’s monitored again.'); }}>Restore</button></td>
            </tr>
          );
        })}</tbody>
      </table>
    </details>
  );
}

/** How many sign-offs to list before "Show all". */
const SHOW_SIGNED = 6;

/** Your signed-off forecasts, newest first, each against what has happened since. */
function SignedView({ sc }: { sc: Scenario }) {
  const { team, historyBase, monitorPick } = useStore();
  const h = team.cashHistory ?? historyBase;
  const list = [...useActiveSignOffs()].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  const arrivals = useArrivals();
  // open on the one you came here from, else the one Home and Today's statement report on
  const tracked = useTracking();
  const [id, setId] = useState(monitorPick ?? tracked?.rec.id ?? list[0]?.id);
  useEffect(() => { if (monitorPick) { setId(monitorPick); useStore.setState({ monitorPick: null }); } }, [monitorPick]);
  const [all, setAll] = useState(false);
  const rec = list.find((x) => x.id === id) ?? list[0];
  const r = useMemo(() => (rec && h ? compareSigned(rec, h, team.categories) : null), [rec, h, team.categories]);
  // the rest of its period as it looks now: a fresh forecast from the latest statement, with the
  // forecast it was signed off from if it's still here, else the one you're working on
  const freshSc = team.forecasts.find((f) => f.id === rec?.scenarioId) ?? sc;
  const fy = +team.settings.financialYearStart.split('-')[0] || 4;
  const fresh = useMemo(() => (rec && h && r ? reforecastSigned(rec, h, freshSc, team.categories, team.settings.liquidityBuffer, fy) : null),
    [rec, h, r, freshSc, team.categories, team.settings.liquidityBuffer, fy]);
  const early = useMemo(() => (rec && (!r || r.H < MIN_COMPARE_DAYS) ? pathOption({
    cutoff: dayFromISO(rec.start), actual: r ? r.actualCum : [], signed: rec.everyday, signedName: 'Signed-off forecast', fresh: null,
  }) : null), [rec, r]);
  if (!rec) return <><div className="callout navy small">No signed-off forecast is being monitored: {(team.signedOff ?? []).length === 1 ? 'the one there was has' : 'all of them have'} been withdrawn. Sign off a forecast under <strong>Forecast</strong>, or restore one below.</div><Withdrawn /></>;
  const outlook: Outlook | undefined = r ? { signed: rec.everyday, fresh, freshName: freshSc.name, sameScenario: freshSc.id === rec.scenarioId } : undefined;
  // several sign-offs on one day are told apart by the time
  const sameDay = (x: typeof rec) => list.filter((y) => y.signedAt.slice(0, 10) === x.signedAt.slice(0, 10)).length > 1;
  const signedWhen = (x: typeof rec) => `${day(dayFromISO(x.signedAt.slice(0, 10)))}${sameDay(x) ? `, ${new Date(x.signedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  const shown = all || list.length <= SHOW_SIGNED ? list : [...list.slice(0, SHOW_SIGNED - 1), ...(list.slice(0, SHOW_SIGNED - 1).includes(rec) ? [] : [rec])];
  const firstJudged = monthName(firstFairMonthEnd(dayFromISO(rec.start)));
  return (
    <>
      <div className="signed-head">
      <div className="signed-list" role="radiogroup" aria-label="Signed-off forecast">
        {shown.map((x) => (
          <button key={x.id} role="radio" aria-checked={x.id === rec.id} className={x.id === rec.id ? 'on' : ''} onClick={() => setId(x.id)}>
            <strong>{x.scenarioName}{x.id === tracked?.rec.id && list.length > 1 && <i className="bi bi-grid-3x3-gap xs muted" title="The one the main menu reports on" style={{ marginLeft: 6 }} />}</strong>
            <span>From {day(dayFromISO(x.start))} · borrow {money(x.borrowingNeed)}</span>
            <span>Signed off {signedWhen(x)} · {x.signedBy}</span>
            {x.note && <span className="signed-note" title={x.note}>“{x.note}”</span>}
          </button>
        ))}
        {list.length > SHOW_SIGNED && <button className="signed-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
      </div>
      <div className="signed-meta small">
        <div><i className="bi bi-patch-check-fill" /> When signed off it said: may need to borrow <strong>{money(rec.borrowingNeed)}</strong>, lowest point {money(rec.low)} on {day(dayFromISO(rec.lowDay))}. It runs {day(dayFromISO(rec.start))} to {day(dayFromISO(rec.end))}.</div>
        {rec.note && <div className="muted">“{rec.note}”</div>}
        {rec.knownItems.length > 0 && <div className="muted">Added by hand: {rec.knownItems.join('; ')}.</div>}
        {list.length > 1 && <HomeChoice id={rec.id} tracked={tracked?.rec.id === rec.id} />}
        <WithdrawButton rec={rec} />
      </div>
      </div>
      {r && r.H >= MIN_COMPARE_DAYS ? <PastResult r={r} outlook={outlook} timingFrom={{ arrivals, end: dayFromISO(rec.end), history: h! }} intro={<>It said</>} handAdded={rec.knownItems.length > 0}
        chartNote="Exactly as signed off, including anything added by hand. Everyday cash only: loans, investments and transfers between your own accounts are left out."
        catsLabel={fullMonthsLabel(r) ? `over the complete months so far, ${fullMonthsLabel(r)}` : ''} />
        : <>
          <div className="callout navy small">{r
            ? <>Too early to tell: {r.H === 1 ? 'one day' : `${r.H} days`} of statements since it started. It’s judged at month ends, from the end of {firstJudged}.</>
            : <>Nothing to compare yet: no statements from {day(dayFromISO(rec.start))} onwards have come in. As each one arrives it’s compared with this forecast, which is first judged at the end of {firstJudged}.</>}</div>
          {early && <Panel title="What it will be measured against" sub={`change in everyday cash from ${day(dayFromISO(rec.start))}, as signed off`}>
            <EChart option={early} height={300} ariaLabel="The signed-off forecast of everyday cash" />
          </Panel>}
        </>}
      <Withdrawn />
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

/**
 * The chart: what actually happened, a forecast with its likely range and, when given, a fresh
 * forecast picking up from the latest actual figure with its own range. Change since `cutoff`.
 */
function pathOption({ cutoff, actual, signed, signedName, fresh }: {
  cutoff: number; actual: number[]; signedName: string;
  signed: { cum: number[]; lower: number[]; upper: number[] };
  fresh: { start: number; cum: number[]; lower: number[]; upper: number[] } | null;
}) {
  const N = Math.max(signed.cum.length, actual.length);
  const last = actual.length ? actual[actual.length - 1] : 0;
  const x: string[] = [], f: (number | string)[] = [], a: (number | string)[] = [], lo: (number | string)[] = [], w: (number | string)[] = [];
  const nf: (number | string)[] = [], nlo: (number | string)[] = [], nw: (number | string)[] = [];
  const off = fresh ? fresh.start - cutoff : N; // index of the fresh forecast's first day
  // every other day, always including the latest actual day so the fresh forecast joins it
  const idx = new Set<number>();
  for (let d = 0; d < N; d += 2) idx.add(d);
  if (actual.length) idx.add(actual.length - 1);
  idx.add(N - 1);
  for (const d of [...idx].sort((p, q) => p - q)) {
    const { y, m, d: dd } = ymdFromDay(cutoff + d);
    x.push(`${dd} ${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`);
    const ok = d < signed.cum.length;
    f.push(ok ? signed.cum[d] : '-'); lo.push(ok ? signed.lower[d] : '-'); w.push(ok ? signed.upper[d] - signed.lower[d] : '-');
    a.push(d < actual.length ? actual[d] : '-');
    const k = d - off;
    if (fresh && k >= -1 && k < fresh.cum.length) {
      // the fresh forecast starts from the latest actual figure, with no spread on day one
      nf.push(k < 0 ? last : last + fresh.cum[k]);
      nlo.push(k < 0 ? last : last + fresh.lower[k]); nw.push(k < 0 ? 0 : fresh.upper[k] - fresh.lower[k]);
    } else { nf.push('-'); nlo.push('-'); nw.push('-'); }
  }
  const narrow = window.innerWidth < 640;
  const band = (name: string, lower: (number | string)[], width: (number | string)[], stack: string, rgb: string) => [
    { name: `_lo${stack}`, type: 'line', data: lower, stack, stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
    { name, type: 'line', data: width, stack, stackStrategy: 'all', lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false }, areaStyle: { color: `rgba(${rgb},.16)` }, itemStyle: { color: `rgba(${rgb},.4)` } },
  ];
  const legend = [...(actual.length ? ['What actually happened'] : []), signedName, 'Likely range', ...(fresh ? ['Fresh forecast from today', 'Fresh likely range'] : [])];
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => (typeof v === 'number' ? money(v) : '–') },
    legend: { ...(narrow ? { bottom: 0, left: 0 } : { top: 0, right: 0 }), data: legend },
    grid: narrow ? { left: 52, right: 12, top: 16, bottom: fresh ? 96 : 70 } : { left: 64, right: 20, top: 34, bottom: 28 },
    xAxis: { type: 'category', data: x, axisLabel: { interval: Math.floor(x.length / 6) } },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney }, scale: true },
    series: [
      ...band('Likely range', lo, w, 'b', '253,126,20'),
      ...(fresh ? band('Fresh likely range', nlo, nw, 'n', '13,110,253') : []),
      { name: signedName, type: 'line', data: f, showSymbol: false, lineStyle: { color: '#fd7e14', width: 2.4, type: 'dashed' }, itemStyle: { color: '#fd7e14' } },
      ...(fresh ? [{ name: 'Fresh forecast from today', type: 'line', data: nf, showSymbol: false, lineStyle: { color: '#0d6efd', width: 2, type: 'dashed' }, itemStyle: { color: '#0d6efd' } }] : []),
      ...(actual.length ? [{ name: 'What actually happened', type: 'line', data: a, showSymbol: false, lineStyle: { color: '#0a2540', width: 2 }, itemStyle: { color: '#0a2540' } }] : []),
    ],
  };
}

/** A signed-off forecast's whole period: as signed off, and the rest of it forecast afresh from today. */
interface Outlook {
  signed: { cum: number[]; lower: number[]; upper: number[] };
  fresh: { start: number; cum: number[]; lower: number[]; upper: number[] } | null;
  freshName: string;
  sameScenario: boolean;
}

function PastResult({ r, intro, chartNote, catsLabel, handAdded, outlook, timingFrom }: { r: BacktestResult; intro: ReactNode; chartNote: string; catsLabel?: string; handAdded?: boolean; outlook?: Outlook;
  /** money confirmed as early, and the signed-off forecast's last day: for the timing part of the gap */
  timingFrom?: { arrivals: Arrival[]; end: number; history: CashHistory } }) {
  const categories = useStore((s) => s.team.categories);
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
  const oneOffs = r.actualCum[end] - r.actualCoreCum[end];
  // judged on what it could have known: one-offs (a land sale, an unexpected grant) are set aside
  // when that's closer, and the sentence says so
  const coreGap = r.actualCoreCum[end] - fc;
  // timing: money confirmed as early that the forecast expected after this date (it should even out)
  const timing = timingFrom ? timingAt(timingFrom.arrivals, r.cutoff, at, timingFrom.end, timingFrom.history) : { items: [], total: 0 };
  const t = Math.abs(timing.total) >= 0.1e6 ? timing.total : 0;
  // an early payment the history holds as a one-off is timing, not a one-off: counted once
  const tOO = t && timingFrom ? timing.items.reduce((s, a) => s + (a.answer === 'early' ? heldAsOneOff(timingFrom.history, a) : 0), 0) : 0;
  const realOneOffs = oneOffs - tOO;
  // with timing and one-offs both set aside
  const bothAside = gap - t - realOneOffs;
  const judged = Math.min(Math.abs(gap), Math.abs(coreGap), Math.abs(gap - t), Math.abs(bothAside));
  const judgedShare = gross ? judged / gross : 0;
  const verdict = judgedShare < 0.015 ? { word: 'Very close', cls: 'green' } : judgedShare < 0.035 ? { word: 'Close', cls: 'green' } : { word: 'Some way out', cls: 'soft' };
  const vsWords = (v: number) => (Math.abs(v) < 0.05e6 ? 'in line with' : `${money(Math.abs(v))} ${v > 0 ? 'ahead of' : 'behind'}`);
  const move = (v: number, past = false) => (v < 0 ? `${past ? 'fell' : 'fall'} by ${money(-v)}` : `${past ? 'rose' : 'rise'} by ${money(v)}`);
  const months = Math.max(1, Math.round((end + 1) / 30.44));

  // with an outlook, the chart runs to the end of the signed-off period: what happened so far, then
  // a fresh forecast from today, against the forecast as signed off
  const fresh = outlook?.fresh ?? null;
  const last = r.actualCum[r.H - 1];
  const N = outlook ? outlook.signed.cum.length : r.H;
  const endFresh = fresh ? last + fresh.cum[fresh.cum.length - 1] : null;
  const endSigned = outlook ? outlook.signed.cum[N - 1] : null;
  const option = useMemo(() => pathOption({
    cutoff: r.cutoff, actual: r.actualCum.slice(0, r.H), fresh,
    signed: outlook?.signed ?? { cum: r.forecastCum, lower: r.lowerCum, upper: r.upperCum },
    signedName: outlook ? 'Signed-off forecast' : 'Forecast made then',
  }), [r, outlook, fresh]);

  const rows = r.categories.filter((c) => !c.excluded && Math.abs(c.error) >= 0.5e6).slice(0, 6);
  // timing within the complete months the table covers, by category
  const catTiming = new Map<string, number>();
  if (timingFrom && r.monthly.labels.length) {
    const fullEnd = firstDayOfMonthIndex(monthIndex(r.cutoff) + r.monthly.labels.length) - 1;
    for (const a of timingAt(timingFrom.arrivals, r.cutoff, fullEnd, timingFrom.end, timingFrom.history).items) catTiming.set(a.categoryId, (catTiming.get(a.categoryId) ?? 0) + (a.answer === "late" ? -a.amount : a.amount));
  }
  return (
    <>
      <div className="past-top">
      <div className="summary-box">
        <div className="eyebrow">In a sentence <span className={`badge ${verdict.cls}`} style={{ marginLeft: 8 }}>{verdict.word}</span></div>
        {intro} everyday cash would <strong>{move(fc)}</strong> by {day(at)}{atWords}. It actually <strong>{move(act, true)}</strong>{Math.abs(gap) < 0.05e6 ? ', almost exactly as forecast' : ''}.
        {t !== 0 && (() => {
          const name = (a: Arrival) => a.signature?.replace(/\S*#\S*/g, '').trim() || (categories.find((c) => c.id === a.categoryId)?.name ?? a.categoryId);
          const shown = timing.items.slice(0, 2);
          return <> <strong>{money(Math.abs(t))}</strong> of the difference is timing: {shown.map((a, i) => <span key={a.key}>{i ? '; ' : ''}{a.answer === 'late'
            ? <>{name(a)}, due {day(dayFromISO(a.due))}, hadn’t {a.amount < 0 ? 'gone out' : 'come in'} by then (late: expected {day(dayFromISO(a.day))})</>
            : <>{name(a)} {a.amount < 0 ? 'went out' : 'came in'} early on {day(dayFromISO(a.day))}, due {day(dayFromISO(a.due))}</>}</span>)}{timing.items.length > 2 ? ` and ${timing.items.length - 2} more` : ''}. It should even out {timing.items.every((a) => a.answer === 'late') ? (timing.items.length > 1 ? 'when they come in' : 'when it comes in') : timing.items.every((a) => a.answer === 'early') ? (timing.items.length > 1 ? 'as those dates pass' : 'as that date passes') : 'as these payments land'}; leaving it aside, everyday cash was <strong>{vsWords(gap - t)}</strong> the forecast.</>;
        })()}
        {Math.abs(realOneOffs) >= 1e6 && (handAdded
          ? <> One-off items account for {money(realOneOffs, { sign: true })} of what happened; only those added by hand were in the forecast.</>
          : <> One-off items, which no forecast from history can see, account for {money(realOneOffs, { sign: true })} of what happened.</>)}
        {Math.abs(realOneOffs) >= 1e6 && (t
          // with timing set aside too, say which way the rest went, even when it's further out
          ? <> Leaving those aside too, everyday cash was <strong>{vsWords(bothAside)}</strong> the forecast.</>
          : Math.abs(bothAside) < Math.abs(gap) && <> Leaving those aside, it was out by <strong>{money(Math.abs(bothAside))}</strong>.</>)}
        {fresh && endFresh !== null && endSigned !== null && <> With what’s happened so far and a fresh forecast for the rest, everyday cash is now expected to <strong>{move(endFresh)}</strong> by {day(r.cutoff + N - 1)}, against {move(endSigned)} as signed off{Math.abs(endFresh - endSigned) >= 0.5e6 ? <>: <strong>{money(Math.abs(endFresh - endSigned))} {endFresh > endSigned ? 'better' : 'worse'}</strong></> : ', much the same'}.</>}
      </div>

        <Kpi label="Forecast made then" value={money(fc, { sign: true })} sub={`change in everyday cash to ${day(at)}`} />
        <Kpi light label="What actually happened" value={money(act, { sign: true })} sub={`over the same ${months === 1 ? 'month' : `${months} months`}`} />
        <Kpi light label="Difference" value={money(gap, { sign: true })} sub={`${pct(share)} of the cash that flowed${t ? `; ${money(t, { sign: true })} of it timing` : ''}`} />
      </div>

      <Panel title={fresh ? 'What happened, then a fresh forecast, against the signed-off forecast' : 'Forecast made then, against what happened'} sub={`change in everyday cash since ${day(r.cutoff)}`}>
        <EChart option={option} height={340} ariaLabel="A past forecast against what actually happened" />
        <p className="xs muted" style={{ margin: '6px 0 0' }}>{chartNote}</p>
        {fresh && outlook && <p className="xs muted" style={{ margin: '4px 0 0' }}>The blue dashed line picks up from the latest statement ({day(fresh.start - 1)}): a forecast made today from all your history, with {outlook.sameScenario ? <>“{outlook.freshName}” as it stands now</> : <>your current forecast, “{outlook.freshName}” (the one signed off isn’t among your forecasts)</>}. Its range starts narrow and widens with time.</p>}
      </Panel>

      {rows.length > 0 && (
        <details className="fold">
          <summary>Where it was out{catsLabel ? <span className="muted" style={{ fontWeight: 400 }}> · {catsLabel}</span> : null}</summary>
          <table className="tbl simple-tbl">
            <thead><tr><th>Category</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Difference</th><th /></tr></thead>
            <tbody>{rows.map((c) => {
              const oo = c.actual - c.actualCore;
              const ct = catTiming.get(c.id) ?? 0;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{money(c.forecast)}</td>
                  <td className="num">{money(c.actual)}</td>
                  <td className="num"><strong>{money(c.actual - c.forecast, { sign: true })}</strong></td>
                  <td className="xs muted">{[Math.abs(oo) >= 0.5e6 ? `includes ${money(oo, { sign: true })} of one-offs` : '', Math.abs(ct) >= 0.1e6 ? `${money(ct, { sign: true })} timing (early or late payments)` : ''].filter(Boolean).join('; ')}</td>
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
