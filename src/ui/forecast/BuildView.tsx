// "Check each line": the forecast is proposed from history, one line at a time, and the
// user confirms or tailors each (size, growth, when it is paid) before any result is shown.
import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import type { Scenario, Assumption } from '../../lib/model';
import { uid } from '../../lib/model';
import type { ForecastBundle } from './useForecast';
import type { CategoryExplain } from '../../lib/forecast/engine';
import { periodise, sumByPeriod } from '../../lib/forecast/engine';
import { monthlyTotals } from '../../lib/analysis/history';
import { EChart, axisMoney } from '../components/EChart';
import { GridEditor } from './GridEditor';
import { ImportWizard } from './ImportWizard';
import { LineWizard } from './LineWizard';
import { money, day } from '../../lib/format';
import { MONTH_NAMES, weekday, dayFromISO, isoFromDay } from '../../lib/dates';

type Upd = (fn: (s: Scenario) => Scenario) => void;
type SeriesX = CategoryExplain['series'][number];

const HOW_OFTEN: Record<string, string> = {
  weekly: 'every week', fortnightly: 'every two weeks', semi_monthly: 'twice a month', four_weekly: 'every four weeks',
  monthly: 'every month', quarterly: 'every quarter', half_yearly: 'twice a year', annual: 'once a year',
};
const PER_YEAR: Record<string, number> = { weekly: 52, fortnightly: 26, semi_monthly: 24, four_weekly: 13, monthly: 12, quarterly: 4, half_yearly: 2, annual: 1 };
const DAY_SET = ['monthly', 'quarterly', 'half_yearly', 'annual'];
const WEEK_SET = ['weekly', 'fortnightly', 'four_weekly'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; // weekday(): 0 = Sunday
/** a signature for people: digit placeholders and stray markers removed */
const niceName = (sig: string) => sig.replace(/\S*#\S*/g, '').replace(/\s+/g, ' ').trim() || sig;
/** marks the size change made on this screen (shown as such in Known future items) */
export const LEVEL_NOTE = 'size set when checking the line';
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function whenWords(s: SeriesX): string {
  if (s.cadence === 'weekly' || s.cadence === 'fortnightly' || s.cadence === 'four_weekly') return `on ${WEEKDAYS[weekday(s.lastDay)]}s`;
  if (s.cadence === 'semi_monthly') return 'mid-month and month-end';
  if (s.lastWorkingDay) return 'on the last working day of the month';
  return `on or near the ${ord(s.dayOfMonth)}`;
}

/** Which lines to check: everything that is forecast, biggest first; small ones listed after (each still checked). */
export function linesToCheck(b: ForecastBundle) {
  const all = b.fc.explain.filter((e) => e.method !== 'exclude' && e.id !== 'uncategorised' && (Math.abs(e.historyAnnual) > 0 || Math.abs(e.forecastTotal) > 0))
    .sort((a, z) => Math.abs(z.historyAnnual) - Math.abs(a.historyAnnual));
  const gross = all.reduce((s, e) => s + Math.abs(e.historyAnnual), 0) || 1;
  const main = all.filter((e) => Math.abs(e.historyAnnual) >= Math.max(2e6, gross * 0.01));
  const small = all.filter((e) => !main.includes(e));
  return { main, small, gross };
}

/** the checks only count for the data they were made on */
export const dataEndIso = (b: ForecastBundle) => isoFromDay(b.req.basis.dataEnd);
export const isReviewed = (sc: Scenario, b: ForecastBundle) => !!sc.reviewDone && sc.reviewFor === dataEndIso(b);

export function reviewState(sc: Scenario, b: ForecastBundle) {
  const { main, small } = linesToCheck(b);
  const done = new Set(sc.reviewFor === dataEndIso(b) ? sc.reviewed ?? [] : []);
  const left = [...main, ...small].filter((e) => !done.has(e.id));
  return { main, small, done, left, allChecked: left.length === 0 };
}

export function BuildView({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const agg = useStore((s) => s.agg);
  const categories = useStore((s) => s.team.categories);
  const { main, small, gross, } = useMemo(() => linesToCheck(b), [b]);
  const done = reviewState(sc, b).done;
  const all = [...main, ...small];
  const firstOpen = all.find((e) => !done.has(e.id))?.id ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);
  const [importing, setImporting] = useState(false);
  const hist = useMemo(() => (agg ? monthlyTotals(agg, 'op') : null), [agg]);
  const per = useMemo(() => periodise(b.fc.start, b.fc.H, 'monthly'), [b.fc.start, b.fc.H]);

  const mark = (ids: string[], ok = true) => upd((s) => {
    const forNow = s.reviewFor === dataEndIso(b);
    const set = new Set(forNow ? s.reviewed ?? [] : []);
    ids.forEach((id) => (ok ? set.add(id) : set.delete(id)));
    return { ...s, reviewed: [...set], reviewFor: dataEndIso(b), reviewDone: forNow ? s.reviewDone : false };
  });
  const confirm = (id: string) => {
    mark([id]);
    const k = all.findIndex((e) => e.id === id);
    const next = [...all.slice(k + 1), ...all.slice(0, k)].find((e) => !done.has(e.id));
    setOpen(next?.id ?? null);
    // bring the next line into view
    if (next) setTimeout(() => document.getElementById(`line-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const checked = all.filter((e) => done.has(e.id));
  const covered = checked.reduce((t, e) => t + Math.abs(e.historyAnnual), 0);
  const card = (e: CategoryExplain) => (
    <LineCard key={e.id} e={e} sc={sc} upd={upd} b={b} checked={done.has(e.id)} open={open === e.id}
      onOpen={() => setOpen(open === e.id ? null : e.id)} onConfirm={() => confirm(e.id)}
      colour={categories.find((c) => c.id === e.id)?.colour ?? '#ced4da'}
      hist={hist ? { labels: hist.labels.slice(-24), values: hist.values[e.catIdx]?.slice(-24) ?? [] } : null}
      proposal={{ labels: per.labels.slice(0, 12), values: sumByPeriod(b.fc.daily, e.catIdx * b.fc.H, b.fc.H, per.index, per.labels.length).slice(0, 12) }} />
  );

  return (
    <div className="stack build">
      <div className="build-progress">
        <div>
          <div className="bp-big">{checked.length} <span>of {all.length}</span></div>
          <div className="bp-label">lines checked</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="meter" style={{ height: 10 }}><div style={{ width: `${Math.min(100, (covered / gross) * 100)}%`, background: 'linear-gradient(90deg,#2dd4a8,#28a745)' }} /></div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {checked.length === all.length
              ? <><strong className="navy">Every line is checked.</strong> Next: anything you know is coming, and your starting cash.</>
              : null}
          </div>
          {checked.length < all.length && (
            <button className="link-btn small accept-all" onClick={() => {
              const left = all.filter((e) => !done.has(e.id));
              void useStore.getState().askConfirm({ title: `Accept all ${left.length} remaining line${left.length > 1 ? 's' : ''}?`, body: `They’ll be marked as checked without being opened. You can still open and change any line afterwards.`, ok: 'Accept all' }).then((yes) => { if (yes) { mark(left.map((e) => e.id)); setOpen(null); } });
            }}>Accept all {all.length - checked.length} remaining as proposed</button>
          )}
          <button className="link-btn small accept-all" style={{ marginLeft: 16 }} onClick={() => setImporting(true)} title="Excel or CSV with dates, categories and amounts, e.g. from Finance or HR"><i className="bi bi-file-earmark-arrow-up" /> Import a schedule from another department</button>
        </div>
      </div>

      {importing && <ImportWizard b={b} upd={upd} onClose={() => setImporting(false)} />}

      {main.map(card)}
      {small.length > 0 && (
        <>
          <div className="build-sub"><strong>Smaller lines</strong> <span className="small muted">· {money(small.reduce((t, e) => t + Math.abs(e.historyAnnual), 0))} a year between them. Quicker to check, but still worth a look.</span></div>
          {small.map(card)}
        </>
      )}
    </div>
  );
}

function LineCard({ e, sc, upd, b, checked, open, onOpen, onConfirm, colour, hist, proposal }: {
  e: CategoryExplain; sc: Scenario; upd: Upd; b: ForecastBundle; checked: boolean; open: boolean; onOpen: () => void; onConfirm: () => void; colour: string;
  hist: { labels: string[]; values: number[] } | null; proposal: { labels: string[]; values: number[] };
}) {
  const inflow = e.historyAnnual >= 0;
  const next12 = proposal.values.reduce((s, v) => s + v, 0);
  const growthA = sc.assumptions.find((a) => a.kind === 'growth' && a.categoryId === e.id) as Extract<Assumption, { kind: 'growth' }> | undefined;
  const levelA = sc.assumptions.find((a) => a.kind === 'step' && a.categoryId === e.id && a.note === LEVEL_NOTE) as Extract<Assumption, { kind: 'step' }> | undefined;
  const stopA = sc.assumptions.find((a) => a.kind === 'stop' && a.categoryId === e.id && !a.signature) as Extract<Assumption, { kind: 'stop' }> | undefined;
  const overridesHere = (sc.overrides ?? []).filter((o) => o.categoryId === e.id);
  const removedSigs = new Set(sc.assumptions.filter((a) => a.kind === 'stop' && a.categoryId === e.id && a.signature).map((a) => (a as Extract<Assumption, { kind: 'stop' }>).signature!));
  const changed = !!(e.method === 'manual' || growthA || levelA || stopA || overridesHere.length || removedSigs.size || e.series.some((s) => s.timing === 'user'));
  const [showGrid, setShowGrid] = useState(overridesHere.length > 0);
  const [editing, setEditing] = useState(overridesHere.length > 0);
  const [wizard, setWizard] = useState<null | 'build' | 'import'>(null);
  const manual = e.method === 'manual';
  const setManual = (on: boolean) => upd((s) => {
    const m = { ...s.settings.methodByCategory };
    if (on) m[e.id] = 'manual'; else delete m[e.id];
    return { ...s, settings: { ...s.settings, methodByCategory: m } };
  });
  const grid = b.fc.grid[e.id];
  const active = e.series.filter((s) => s.active && (s.projected !== 0 || removedSigs.has(s.signature))).sort((a, z) => Math.abs(z.level) * (PER_YEAR[z.cadence] ?? 1) - Math.abs(a.level) * (PER_YEAR[a.cadence] ?? 1));
  const seriesTotal = active.reduce((s, x) => s + Math.abs(x.level) * (PER_YEAR[x.cadence] ?? 1), 0);

  const setAssumption = (match: (a: Assumption) => boolean, make: (() => Assumption) | null) => upd((s) => {
    const rest = s.assumptions.filter((a) => !match(a));
    return { ...s, assumptions: make ? [...rest, make()] : rest };
  });
  const setGrowth = (v: string) => setAssumption((a) => a.kind === 'growth' && a.categoryId === e.id,
    v.trim() === '' || isNaN(+v) ? null : () => ({ id: uid('as'), kind: 'growth', categoryId: e.id, pct: +v, mode: 'annual_step' }));
  const setLevel = (v: string) => setAssumption((a) => a.kind === 'step' && a.categoryId === e.id && a.note === LEVEL_NOTE,
    v.trim() === '' || isNaN(+v) || +v === 0 ? null : () => ({ id: uid('as'), kind: 'step', categoryId: e.id, pct: +v, effective: sc.settings.start, note: LEVEL_NOTE }));
  const setTiming = (sig: string, v: string) => setAssumption((a) => a.kind === 'timing' && a.signature === sig,
    v === 'history' ? null : () => (v.startsWith('w')
      ? { id: uid('as'), kind: 'timing', categoryId: e.id, signature: sig, from: sc.settings.start, rule: 'weekday', weekday: +v.slice(1) }
      : { id: uid('as'), kind: 'timing', categoryId: e.id, signature: sig, from: sc.settings.start, rule: v === 'lwd' ? 'last_working_day' : 'day_of_month', dayOfMonth: v === 'lwd' ? undefined : +v }));
  const toggleSeries = (sig: string) => setAssumption((a) => a.kind === 'stop' && a.categoryId === e.id && a.signature === sig,
    removedSigs.has(sig) ? null : () => ({ id: uid('as'), kind: 'stop', categoryId: e.id, signature: sig, from: sc.settings.start }));
  const setStop = (date: string | null) => setAssumption((a) => a.kind === 'stop' && a.categoryId === e.id && !a.signature,
    date ? () => ({ id: uid('as'), kind: 'stop', categoryId: e.id, from: date }) : null);

  // what we found, in plain English
  const found = (() => {
    if (e.method === 'series' && active.length) {
      return <>Made up of <strong>regular payments</strong>{active.length > 1 ? ` (${active.length})` : ''}, each projected on its own dates{seriesTotal < Math.abs(e.historyAnnual) * 0.9 ? ', plus smaller amounts that follow the usual monthly pattern' : ''}.</>;
    }
    if (e.method === 'seasonal') {
      const p = e.profile.map((v, i) => ({ v: Math.abs(v), i }));
      const hi = [...p].sort((a, z) => z.v - a.v).slice(0, 2).map((x) => MONTH_NAMES[x.i]).join(' and ');
      const lo = [...p].sort((a, z) => a.v - z.v)[0];
      return <>Follows the <strong>pattern of past years</strong>: highest in {hi}, lowest in {MONTH_NAMES[lo.i]}. The same months are expected to be high and low again.</>;
    }
    if (e.method === 'flat') return <>Has <strong>no regular pattern</strong>, so we’ve spread the past average evenly: about {money(Math.abs(e.historyAnnual) / 12)} a month.</>;
    return <>You’ve <strong>cleared our forecast</strong> for this line, so only your own figures count: the rows in the grid below, and any known future items.</>;
  })();

  const chart = useMemo(() => hist && open ? {
    animation: false, grid: { left: 52, right: 8, top: 10, bottom: 22 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
    xAxis: { type: 'category', data: [...hist.labels, ...proposal.labels], axisLabel: { fontSize: 9.5, interval: 5 } },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney, fontSize: 9.5 } },
    series: [
      { name: 'Past', type: 'bar', stack: 'x', data: [...hist.values.map(Math.abs), ...proposal.values.map(() => null)], itemStyle: { color: '#0a2540' }, barMaxWidth: 12 },
      { name: 'Proposed', type: 'bar', stack: 'x', data: [...hist.values.map(() => null), ...proposal.values.map(Math.abs)], itemStyle: { color: '#fd7e14' }, barMaxWidth: 12 },
    ],
  } : null, [hist, proposal, open]);

  const summary = `${money(Math.abs(next12))} ${inflow ? 'in' : 'out'} over the next 12 months · ${e.method === 'manual' ? 'your figures only' : `${e.growthPct >= 0 ? '+' : ''}${e.growthPct.toFixed(1)}% a year${changed ? ' · changed by you' : ''}`}`;

  return (
    <div id={`line-${e.id}`} className={`card line-card ${checked ? 'checked' : ''} ${open ? 'open' : ''}`}>
      <button className="lc-head" onClick={onOpen} aria-expanded={open}>
        <i className={`bi ${checked ? 'bi-check-circle-fill green' : 'bi-circle'} lc-icon`} />
        <span className="swatch" style={{ background: colour }} />
        <span className="lc-title">{e.name}</span>
        <span className={`badge ${inflow ? 'green' : 'soft'}`}>{inflow ? 'money in' : 'money out'}</span>
        <span className="lc-sum small muted">{summary}</span>
        <i className={`bi ${open ? 'bi-chevron-up' : 'bi-chevron-down'} muted`} />
      </button>
      {open && (
        <div className="lc-body fade">
          {manual && <div className="callout navy small mt"><i className="bi bi-eraser" /> <strong>Our forecast for this line is cleared.</strong> Only your own figures count. <button className="link-btn" onClick={() => setManual(false)}>Bring ours back</button></div>}
          <div className="grid g2">
            <div>
              <div className="lc-label">What we found in your history</div>
              <p className="small" style={{ marginTop: 2 }}>Last 12 months: <strong>{money(Math.abs(e.historyAnnual))}</strong> {inflow ? 'received' : 'paid'}. {found}</p>
              {active.length > 0 && (
                <table className="tbl tbl-sm lc-series">
                  <thead><tr><th>Payment</th><th className="num">Each time</th><th>How often</th><th>When</th><th /></tr></thead>
                  <tbody>{active.slice(0, 5).map((s) => (
                    <tr key={s.signature} className={removedSigs.has(s.signature) ? 'removed' : ''}>
                      <td title={s.signature} className="lc-name">{niceName(s.signature)}</td>
                      <td className="num">{money(Math.abs(s.level))}</td>
                      <td>{HOW_OFTEN[s.cadence] ?? s.cadence}</td>
                      <td>{!(editing || changed) ? <span className="small">{whenShown(sc, e.id, s)}</span> : DAY_SET.includes(s.cadence) ? (
                        <select className="select sm" aria-label={`When ${s.signature} is paid`} value={timingValue(sc, e.id, s)} onChange={(ev) => setTiming(s.signature, ev.target.value)}>
                          <option value="history">As before ({s.lastWorkingDay ? 'last working day' : `the ${ord(s.dayOfMonth)}`})</option>
                          <option value="lwd">Last working day</option>
                          {Array.from({ length: 28 }, (_, k) => <option key={k} value={k + 1}>On the {ord(k + 1)}</option>)}
                        </select>
                      ) : WEEK_SET.includes(s.cadence) ? (
                        <select className="select sm" aria-label={`Which day ${s.signature} is paid`} value={timingValue(sc, e.id, s)} onChange={(ev) => setTiming(s.signature, ev.target.value)}>
                          <option value="history">As before ({WEEKDAYS[weekday(s.lastDay)]}s)</option>
                          {[1, 2, 3, 4, 5].map((w) => <option key={w} value={`w${w}`}>{WEEKDAYS[w]}s</option>)}
                        </select>
                      ) : <span className="small">{whenWords(s)}</span>}</td>
                      <td>{(editing || changed) && <button className="icon-btn" title={removedSigs.has(s.signature) ? 'Bring this payment back' : 'Take this payment out of the forecast'} aria-label={removedSigs.has(s.signature) ? `Restore ${s.signature}` : `Remove ${s.signature}`} onClick={() => toggleSeries(s.signature)}>
                        <i className={`bi ${removedSigs.has(s.signature) ? 'bi-arrow-counterclockwise' : 'bi-trash'}`} /></button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {active.length > 5 && <div className="xs muted">…and {active.length - 5} more regular payments.</div>}
            </div>
            <div>
              <div className="lc-label">Our proposal for the next 12 months</div>
              <div className="lc-big">{money(Math.abs(next12))} <span className="small muted">{inflow ? 'in' : 'out'}</span></div>
              {chart && <EChart option={chart} height={150} ariaLabel={`${e.name}: past months and proposal`} />}
              <div className="xs muted"><span className="swatch" style={{ background: '#0a2540' }} /> past months <span className="swatch" style={{ background: '#fd7e14', marginLeft: 10 }} /> proposed</div>
            </div>
          </div>

          {(editing || changed) && <>
          <div className="lc-edit">
            <div className="lc-label">Change anything you know better</div>
            <div className="lc-fields">
              <label className="lc-field">
                <span>Growth each year</span>
                <span className="pct-input"><input className={`input ${growthA ? 'set' : ''}`} key={growthA?.id ?? 'g'} defaultValue={growthA ? String(growthA.pct) : ''} placeholder={e.historicCagr.toFixed(1)}
                  onBlur={(ev) => setGrowth(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} aria-label={`Growth each year for ${e.name}`} /><span>%</span></span>
                <small>Past trend {e.historicCagr >= 0 ? '+' : ''}{e.historicCagr.toFixed(1)}%</small>
              </label>
              <label className="lc-field">
                <span>Make it bigger or smaller</span>
                <span className="pct-input"><input className={`input ${levelA ? 'set' : ''}`} key={levelA?.id ?? 'l'} defaultValue={levelA ? String(levelA.pct) : ''} placeholder="0"
                  onBlur={(ev) => setLevel(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} aria-label={`Change in size for ${e.name}`} /><span>%</span></span>
                <small>e.g. −10 for a cut</small>
              </label>
              <label className="lc-field">
                <span>It stops</span>
                <span className="row tight">
                  <input type="checkbox" checked={!!stopA} onChange={(ev) => setStop(ev.target.checked ? addDaysIso(sc.settings.start, 90) : null)} aria-label={`${e.name} stops`} />
                  {stopA ? <input className="input" type="date" value={stopA.from} onChange={(ev) => ev.target.value && setStop(ev.target.value)} style={{ width: 150 }} /> : <span className="small muted">only if this ends</span>}
                </span>
                {stopA && <small>Nothing after {day(dayFromISO(stopA.from))}</small>}
              </label>
              <div className="lc-field">
                <span>Every figure</span>
                <button className="btn sm" onClick={() => setShowGrid(!showGrid)} aria-expanded={showGrid}>
                  <i className="bi bi-grid-3x3" /> {showGrid ? 'Hide the grid' : 'Edit by month or by day'}
                </button>
                {overridesHere.length > 0 && <small>{overridesHere.length} figure{overridesHere.length > 1 ? 's are' : ' is'} yours</small>}
              </div>
            </div>
          </div>

          {showGrid && grid && <GridEditor sc={sc} upd={upd} catId={e.id} grid={grid} inflow={inflow} start={sc.settings.start} />}

          <div className="lc-replace">
            <span className="xs muted">Replace this line entirely:</span>
            {manual
              ? <button className="link-btn small" onClick={() => setManual(false)}><i className="bi bi-arrow-counterclockwise" /> Bring our forecast back</button>
              : <button className="link-btn small" onClick={() => { void useStore.getState().askConfirm({ title: `Clear our forecast for ${e.name}?`, body: 'Only figures you add yourself will count for this line. You can bring our forecast back at any time.', ok: 'Clear it', danger: true }).then((yes) => { if (yes) setManual(true); }); }}>Clear our forecast</button>}
            <span className="muted">·</span>
            <button className="link-btn small" onClick={() => setWizard('build')}>Build it yourself</button>
            <span className="muted">·</span>
            <button className="link-btn small" onClick={() => setWizard('import')}>Import a schedule</button>
          </div>
          {wizard === 'build' && <LineWizard e={e} b={b} upd={upd} inflow={inflow} onClose={() => { setWizard(null); setShowGrid(true); }} />}
          {wizard === 'import' && <ImportWizard b={b} upd={upd} lockCategory={e.id} onClose={() => { setWizard(null); setShowGrid(true); }} />}

          </>}
          <div className="lc-foot">
            {changed && <span className="small muted"><i className="bi bi-pencil" /> Your changes are already in the proposal above.</span>}
            <span className="spacer" />
            {!editing && !changed && <button className="btn" onClick={() => setEditing(true)}><i className="bi bi-pencil" /> Change something</button>}
            <button className="btn primary" onClick={onConfirm}><i className="bi bi-check-lg" /> {checked ? 'Done' : 'Looks right'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** When a payment is made, in words: as history shows, or as the user set it. */
function whenShown(sc: Scenario, catId: string, s: SeriesX): string {
  const v = timingValue(sc, catId, s);
  if (v === 'history') return whenWords(s);
  if (v === 'lwd') return 'on the last working day';
  if (v.startsWith('w')) return `on ${WEEKDAYS[+v.slice(1)]}s`;
  return `on the ${ord(+v)}`;
}

function timingValue(sc: Scenario, catId: string, s: SeriesX): string {
  const a = [...sc.assumptions].reverse().find((x) => x.kind === 'timing' && x.signature === s.signature && x.categoryId === catId) as Extract<Assumption, { kind: 'timing' }> | undefined;
  if (!a) return 'history';
  if (a.rule === 'weekday') return `w${a.weekday}`;
  return a.rule === 'last_working_day' ? 'lwd' : String(a.dayOfMonth ?? s.dayOfMonth);
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
