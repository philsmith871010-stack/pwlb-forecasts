import { ReactNode, useState } from 'react';
import { useStore } from '../../state/store';
import type { Scenario, Assumption, OneOff, GrowthMode } from '../../lib/model';
import { uid } from '../../lib/model';
import type { ForecastBundle } from './useForecast';
import { CategorySelect, Seg, InfoTip, Money } from '../components/common';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromISO, isoFromDay } from '../../lib/dates';
import type { ForecastMethod } from '../../lib/categories';
import { parsePaste, resolvePaste, Spread, PasteParse } from '../../lib/forecast/paste';

export function Section({ title, icon, children, count }: { title: string; icon: string; children: ReactNode; defaultOpen?: boolean; count?: number }) {
  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <div className="row" style={{ background: 'var(--pt-navy-grad)', color: '#fff', padding: '10px 14px' }}>
        <i className={`bi ${icon}`} style={{ color: 'var(--pt-orange)' }} /><strong style={{ color: 'var(--pt-orange)', fontWeight: 600, fontSize: 14.5 }}>{title}</strong>
        {count !== undefined && count > 0 && <span className="badge orange">{count}</span>}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </section>
  );
}

type Upd = (fn: (s: Scenario) => Scenario) => void;

// ------------------------------------------------------------------ setup

const HORIZONS = [6, 12, 24, 36, 60];

export function SetupSection({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const { team, updateTeam } = useStore();
  const st = sc.settings;
  const set = (patch: Partial<Scenario['settings']>) => upd((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  const start = dayFromISO(st.start);
  const months = Math.round((dayFromISO(st.end) - start + 1) / 30.44);
  const mode = st.openingMode ?? 'bank';
  return (
    <Section title="Starting point" icon="bi-sliders">
      <div className="stack" style={{ gap: 12 }}>
        <div className="grid g2" style={{ gap: 10 }}>
          <div className="field"><label>Forecast start</label><input className="input" type="date" value={st.start} onChange={(e) => e.target.value && set({ start: e.target.value, end: isoFromDay(addMonths(dayFromISO(e.target.value), months) - 1) })} /></div>
          <div className="field"><label>Ends</label><input className="input" type="date" value={st.end} onChange={(e) => e.target.value && set({ end: e.target.value })} /></div>
        </div>
        <div className="field"><label>Horizon</label>
          <Seg value={HORIZONS.includes(months) ? months : 0} onChange={(m) => m && set({ end: isoFromDay(addMonths(start, m) - 1) })} options={[...HORIZONS.map((h) => ({ v: h, label: `${h}m` })), { v: 0, label: '…' }]} />
        </div>
        <div className="field"><label>Opening position <InfoTip text="The cash position the forecast starts from. 'Bank balance' is the actual balance at the end of the data (all flows, including treasury). 'Operational' is the cumulative operational-only position from history." /></label>
          <Seg value={mode} onChange={(v) => set({ openingMode: v, openingPosition: v === 'manual' ? st.openingPosition ?? Math.round(b.bankEnd) : null })} options={[{ v: 'bank', label: 'Bank balance' }, { v: 'operational', label: 'Operational' }, { v: 'manual', label: 'Enter' }]} />
          {mode === 'manual' ? <input className="input" type="number" step={100000} value={st.openingPosition ?? 0} onChange={(e) => set({ openingPosition: +e.target.value })} />
            : <span className="xs muted">{mode === 'bank' ? `Bank balance at end of data: ${money(b.bankEnd)}` : `Operational position from history: ${money(b.operationalEnd)}`}</span>}
        </div>
        <div className="grid g2" style={{ gap: 10 }}>
          <div className="field"><label>Liquidity buffer <InfoTip text="Minimum cash you want to hold. Shown as a threshold line; the borrowing requirement is what keeps the position above it." /></label>
            <input className="input" type="number" step={1000000} value={team.settings.liquidityBuffer} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, liquidityBuffer: +e.target.value } }))} /></div>
          <div className="field"><label>Lookback (years)</label><select className="select" value={st.lookbackYears} onChange={(e) => set({ lookbackYears: +e.target.value })}>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
        </div>
        <div className="field"><label>Weight on recent years: {st.recencyWeight === 1 ? 'equal' : `each older year counts ${Math.round(st.recencyWeight * 100)}%`}</label>
          <input type="range" min={0.3} max={1} step={0.05} value={st.recencyWeight} onChange={(e) => set({ recencyWeight: +e.target.value })} style={{ accentColor: 'var(--pt-orange)' }} />
        </div>
        <label className="check"><input type="checkbox" checked={st.includePossible} onChange={(e) => set({ includePossible: e.target.checked })} /> Include “possible” one-offs (probability-weighted)</label>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ methods & growth

const METHODS: { v: ForecastMethod; label: string }[] = [
  { v: 'seasonal', label: 'Seasonal' }, { v: 'series', label: 'Schedule' }, { v: 'flat', label: 'Flat' }, { v: 'manual', label: 'Manual' }, { v: 'exclude', label: 'Exclude' },
];

export function MethodsSection({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const categories = useStore((s) => s.team.categories);
  const growthFor = (id: string) => sc.assumptions.find((a) => a.kind === 'growth' && a.categoryId === id) as Extract<Assumption, { kind: 'growth' }> | undefined;
  const setGrowth = (id: string, v: string, mode: GrowthMode) => upd((s) => {
    const rest = s.assumptions.filter((a) => !(a.kind === 'growth' && a.categoryId === id));
    if (v === '' || isNaN(+v)) return { ...s, assumptions: rest };
    return { ...s, assumptions: [...rest, { id: uid('as'), kind: 'growth', categoryId: id, pct: +v, mode }] };
  });
  const rows = b.fc.explain.filter((e) => e.historyAnnual || e.forecastTotal || e.method !== 'exclude' || e.id === 'uncategorised');
  return (
    <Section title="Growth and method for each category" icon="bi-diagram-3" count={sc.assumptions.filter((a) => a.kind === 'growth').length}>
      <p className="small muted" style={{ marginTop: 0 }}>Leave a box empty to use the historic trend (shown in grey). Type a number to set your own growth, e.g. <strong>2</strong> for 2% a year. The small icon next to your figure switches between “jumps each April” and “grows steadily”.</p>
      <div className="tbl-wrap" style={{ maxHeight: 640 }}>
        <table className="tbl">
          <thead><tr><th>Category</th><th>How it’s projected</th><th className="num">Past trend</th><th className="num">Your growth % a year</th></tr></thead>
          <tbody>{rows.map((e) => {
            const g = growthFor(e.id);
            const cat = categories.find((c) => c.id === e.id);
            return (
              <tr key={e.id}>
                <td className="xs"><span className="swatch" style={{ background: cat?.colour ?? '#ced4da', marginRight: 6 }} />{e.name}</td>
                <td><select className="select sm" style={{ width: 96 }} title="Seasonal × trend · Recurring series schedule · Flat average · Manual (pasted schedules only) · Exclude" value={sc.settings.methodByCategory[e.id] ?? e.method} aria-label={`Method for ${e.name}`}
                  onChange={(ev) => upd((s) => ({ ...s, settings: { ...s.settings, methodByCategory: { ...s.settings.methodByCategory, [e.id]: ev.target.value as ForecastMethod } } }))}>
                  {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select></td>
                <td className="num xs muted">{e.historicCagr ? pct(e.historicCagr / 100, 1, true) : '–'}</td>
                <td className="num" style={{ width: 110 }}>
                  <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                    <input className="input sm" style={{ width: 62, textAlign: 'right', borderColor: g ? 'var(--pt-orange)' : undefined }} placeholder={e.historicCagr.toFixed(1)} defaultValue={g ? String(g.pct) : ''} key={g ? g.id : 'none'}
                      aria-label={`Growth for ${e.name}`} onBlur={(ev) => setGrowth(e.id, ev.target.value, g?.mode ?? 'annual_step')} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} />
                    {g && <button className="icon-btn" title={g.mode === 'annual_step' ? 'Applied as a step each April — click for continuous' : 'Continuous — click for annual April steps'} onClick={() => setGrowth(e.id, String(g.pct), g.mode === 'annual_step' ? 'continuous' : 'annual_step')}><i className={`bi ${g.mode === 'annual_step' ? 'bi-bar-chart-steps' : 'bi-graph-up'}`} /></button>}
                  </div>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ assumptions

type Kind = 'step' | 'timing' | 'stop' | 'start' | 'inflation';

export function AssumptionsSection({ sc, upd }: { sc: Scenario; upd: Upd }) {
  const categories = useStore((s) => s.team.categories);
  const opCats = categories.filter((c) => c.group === 'receipts_operational' || c.group === 'payments_operational');
  const [kind, setKind] = useState<Kind>('step');
  const [f, setF] = useState<Record<string, string>>({ categoryId: 'salaries', pct: '3.5', effective: '', backdateFrom: '', arrearsPaidOn: '', from: '', until: '', amount: '', cadence: 'monthly', dayOfMonth: '', rule: 'last_working_day', note: '' });
  const [infCats, setInfCats] = useState<string[]>(['suppliers', 'capital_spend']);
  const s = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  const add = () => {
    let a: Assumption | null = null;
    const id = uid('as');
    if (kind === 'step' && f.effective) a = { id, kind, categoryId: f.categoryId, pct: +f.pct, effective: f.effective, backdateFrom: f.backdateFrom || undefined, arrearsPaidOn: f.arrearsPaidOn || (f.backdateFrom ? f.effective : undefined), note: f.note };
    if (kind === 'timing' && f.from) a = { id, kind, categoryId: f.categoryId, from: f.from, rule: f.rule as 'last_working_day', dayOfMonth: f.dayOfMonth ? +f.dayOfMonth : undefined, note: f.note };
    if (kind === 'stop' && f.from) a = { id, kind, categoryId: f.categoryId, from: f.from, note: f.note };
    if (kind === 'start' && f.from && f.amount) a = { id, kind, categoryId: f.categoryId, from: f.from, until: f.until || undefined, amount: +f.amount, cadence: f.cadence as 'monthly', dayOfMonth: f.dayOfMonth ? +f.dayOfMonth : undefined, note: f.note };
    if (kind === 'inflation' && f.pct) a = { id, kind, pct: +f.pct, categoryIds: infCats, note: f.note };
    if (a) upd((x) => ({ ...x, assumptions: [...x.assumptions, a!] }));
  };
  const describe = (a: Assumption): string => {
    switch (a.kind) {
      case 'growth': return `${name(a.categoryId)} ${a.pct >= 0 ? '+' : ''}${a.pct}% p.a. (${a.mode === 'annual_step' ? 'from each April' : 'continuous'})`;
      case 'step': return `${name(a.categoryId)} ${a.pct >= 0 ? '+' : ''}${a.pct}% from ${day(dayFromISO(a.effective))}${a.backdateFrom ? `, backdated to ${day(dayFromISO(a.backdateFrom))}, arrears paid ${day(dayFromISO(a.arrearsPaidOn ?? a.effective))}` : ''}`;
      case 'timing': return `${name(a.categoryId)}${a.signature ? ` (${a.signature.replace(/\S*#\S*/g, '').trim()})` : ''} paid on ${a.rule === 'last_working_day' ? 'the last working day' : a.rule === 'weekday' ? `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][a.weekday ?? 5]}` : `day ${a.dayOfMonth}`} from ${day(dayFromISO(a.from))}`;
      case 'stop': return `${name(a.categoryId)}${a.signature ? `: ${a.signature.replace(/\S*#\S*/g, '').trim()} removed` : ' stops'} from ${day(dayFromISO(a.from))}`;
      case 'start': return `New ${a.cadence.replace('_', '-')} ${money(a.amount)} in ${name(a.categoryId)} from ${day(dayFromISO(a.from))}${a.until ? ` to ${day(dayFromISO(a.until))}` : ''}`;
      case 'inflation': return `Inflation +${a.pct}% p.a. on ${a.categoryIds.map(name).join(', ')}`;
    }
  };
  return (
    <Section title="Planned changes" icon="bi-lightbulb" count={sc.assumptions.length}>
      {sc.assumptions.length > 0 && (
        <ul className="list-plain small mb">{sc.assumptions.map((a) => (
          <li key={a.id} className="row tight"><span className="badge navy">{a.kind}</span><span style={{ flex: 1 }}>{describe(a)}{a.note ? <span className="muted"> — {a.note}</span> : ''}</span>
            <button className="icon-btn" aria-label="Remove assumption" onClick={() => upd((x) => ({ ...x, assumptions: x.assumptions.filter((y) => y.id !== a.id) }))}><i className="bi bi-trash" /></button></li>
        ))}</ul>
      )}
      <div className="field"><label>What kind of change?</label>
        <Seg value={kind} onChange={setKind} options={[{ v: 'step', label: 'Change from a date' }, { v: 'timing', label: 'Payment day moves' }, { v: 'stop', label: 'Something stops' }, { v: 'start', label: 'Something new starts' }, { v: 'inflation', label: 'Inflation' }]} />
      </div>
      <div className="stack mt" style={{ gap: 8 }}>
        {kind !== 'inflation' && <div className="field"><label>Category</label><CategorySelect value={f.categoryId} onChange={(v) => setF({ ...f, categoryId: v })} categories={categories} groups={['receipts_operational', 'payments_operational']} /></div>}
        {kind === 'step' && <>
          <div className="grid g2" style={{ gap: 8 }}>
            <div className="field"><label>Change %</label><input className="input" type="number" step={0.1} value={f.pct} onChange={s('pct')} /></div>
            <div className="field"><label>New level paid from</label><input className="input" type="date" value={f.effective} onChange={s('effective')} /></div>
            <div className="field"><label>Backdated to (optional)</label><input className="input" type="date" value={f.backdateFrom} onChange={s('backdateFrom')} /></div>
            <div className="field"><label>Arrears paid on</label><input className="input" type="date" value={f.arrearsPaidOn} onChange={s('arrearsPaidOn')} /></div>
          </div>
          <span className="xs muted">e.g. pay award 3.5%, paid from 1 Sep 2027, backdated to 1 Apr 2027 with arrears in the September payroll.</span>
        </>}
        {kind === 'timing' && <div className="grid g2" style={{ gap: 8 }}>
          <div className="field"><label>From</label><input className="input" type="date" value={f.from} onChange={s('from')} /></div>
          <div className="field"><label>Paid on</label><select className="select" value={f.rule} onChange={s('rule')}><option value="last_working_day">Last working day</option><option value="day_of_month">A fixed day</option></select></div>
          {f.rule === 'day_of_month' && <div className="field"><label>Day of month</label><input className="input" type="number" min={1} max={31} value={f.dayOfMonth} onChange={s('dayOfMonth')} /></div>}
        </div>}
        {kind === 'stop' && <div className="field"><label>Stops from</label><input className="input" type="date" value={f.from} onChange={s('from')} /></div>}
        {kind === 'start' && <div className="grid g2" style={{ gap: 8 }}>
          <div className="field"><label>Amount each time (− for out)</label><input className="input" type="number" value={f.amount} onChange={s('amount')} /></div>
          <div className="field"><label>How often</label><select className="select" value={f.cadence} onChange={s('cadence')}>{['weekly', 'fortnightly', 'monthly', 'quarterly', 'half_yearly', 'annual'].map((c) => <option key={c} value={c}>{c.replace('_', '-')}</option>)}</select></div>
          <div className="field"><label>From</label><input className="input" type="date" value={f.from} onChange={s('from')} /></div>
          <div className="field"><label>Until (optional)</label><input className="input" type="date" value={f.until} onChange={s('until')} /></div>
        </div>}
        {kind === 'inflation' && <>
          <div className="field"><label>Inflation % p.a. (on top of each category’s growth)</label><input className="input" type="number" step={0.1} value={f.pct} onChange={s('pct')} /></div>
          <div className="field"><label>Applies to</label>
            <div className="row tight" style={{ maxHeight: 120, overflow: 'auto' }}>{opCats.map((c) => <label key={c.id} className="check xs" style={{ width: '48%' }}><input type="checkbox" checked={infCats.includes(c.id)} onChange={(e) => setInfCats(e.target.checked ? [...infCats, c.id] : infCats.filter((x) => x !== c.id))} />{c.name}</label>)}</div>
          </div>
        </>}
        <div className="field"><label>Note (optional)</label><input className="input" value={f.note} onChange={s('note')} placeholder="why — shown on the chart and report" /></div>
        <div className="row"><span className="spacer" /><button className="btn primary sm" onClick={add}><i className="bi bi-plus-lg" /> Add this change</button></div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ one-offs

export function OneOffsSection({ sc, upd }: { sc: Scenario; upd: Upd }) {
  const categories = useStore((s) => s.team.categories);
  const [f, setF] = useState<OneOff>({ id: '', date: sc.settings.start, amount: 0, categoryId: 'capital_receipts', description: '', confidence: 'firm', probability: 0.5 });
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const add = () => {
    if (!f.amount) return;
    upd((s) => ({ ...s, oneOffs: [...s.oneOffs, { ...f, id: uid('oo'), amount: Math.abs(f.amount) * (dir === 'in' ? 1 : -1) }].sort((a, b) => a.date.localeCompare(b.date)) }));
    setF({ ...f, amount: 0, description: '' });
  };
  return (
    <Section title="Known one-off items" icon="bi-pin-map" count={sc.oneOffs.length} defaultOpen={false}>
      {sc.oneOffs.length > 0 && (
        <table className="tbl mb"><thead><tr><th>Date</th><th>What</th><th className="num">Amount</th><th>Conf.</th><th /></tr></thead>
          <tbody>{sc.oneOffs.map((o) => (
            <tr key={o.id}><td className="xs">{day(dayFromISO(o.date))}</td><td className="xs">{o.description || categories.find((c) => c.id === o.categoryId)?.name}</td><td className="num"><Money v={o.amount} /></td>
              <td><span className={`badge ${o.confidence === 'firm' ? 'green' : o.confidence === 'likely' ? 'navy' : 'amber'}`}>{o.confidence}{o.confidence === 'possible' ? ` ${Math.round((o.probability ?? 0.5) * 100)}%` : ''}</span></td>
              <td><button className="icon-btn" aria-label="Remove" onClick={() => upd((s) => ({ ...s, oneOffs: s.oneOffs.filter((x) => x.id !== o.id) }))}><i className="bi bi-trash" /></button></td></tr>
          ))}</tbody></table>
      )}
      <div className="grid g2" style={{ gap: 8 }}>
        <div className="field"><label>Date</label><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div className="field"><label>Amount (£)</label><div className="row tight" style={{ flexWrap: 'nowrap' }}><Seg value={dir} onChange={setDir} options={[{ v: 'in', label: 'In' }, { v: 'out', label: 'Out' }]} /><input className="input" type="number" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: +e.target.value })} /></div></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label><input className="input" value={f.description} placeholder="e.g. Land sale at Mill Lane" onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="field"><label>Category</label><CategorySelect value={f.categoryId} onChange={(v) => setF({ ...f, categoryId: v })} categories={categories} groups={['receipts_operational', 'payments_operational']} /></div>
        <div className="field"><label>Confidence</label><select className="select" value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value as OneOff['confidence'] })}><option value="firm">Firm</option><option value="likely">Likely</option><option value="possible">Possible</option></select></div>
        {f.confidence === 'possible' && <div className="field"><label>Probability</label><input className="input" type="number" min={0} max={100} value={Math.round((f.probability ?? 0.5) * 100)} onChange={(e) => setF({ ...f, probability: Math.max(0, Math.min(100, +e.target.value)) / 100 })} /></div>}
      </div>
      <div className="row mt"><span className="spacer" /><button className="btn primary sm" disabled={!f.amount} onClick={add}><i className="bi bi-plus-lg" /> Add one-off</button></div>
    </Section>
  );
}

// ------------------------------------------------------------------ paste schedules

export function PasteSection({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const categories = useStore((s) => s.team.categories);
  const fyStart = useStore((s) => +s.team.settings.financialYearStart.split('-')[0] || 4);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string>('grants_general');
  const [mode, setMode] = useState<'replace' | 'add'>('replace');
  const [spread, setSpread] = useState<Spread>('day_of_month');
  const [dom, setDom] = useState(15);
  const [negate, setNegate] = useState(false);
  const [name, setName] = useState('');
  const parsed: PasteParse | null = text.trim() ? parsePaste(text) : null;
  const profile = b.fc.explain.find((e) => e.id === target)?.profile;
  const entries = parsed?.kind ? resolvePaste(parsed, { spread, dayOfMonth: dom, profile, negate, fyStartMonth: fyStart }) : [];
  const isTreasury = target === '__treasury__';
  const apply = () => {
    if (!entries.length) return;
    if (isTreasury) upd((s) => ({ ...s, treasurySchedule: [...s.treasurySchedule, ...entries.map((e) => ({ id: uid('tr'), date: e.date, amount: e.amount, description: name || 'Known treasury flow' }))] }));
    else upd((s) => ({ ...s, pastedSchedules: [...s.pastedSchedules, { id: uid('ps'), name: name || `${categories.find((c) => c.id === target)?.name} schedule`, categoryId: target, mode, entries, sourceText: text.slice(0, 5000) }] }));
    setText(''); setName('');
  };
  return (
    <Section title="Paste a schedule from Excel" icon="bi-clipboard-data" count={sc.pastedSchedules.length + (sc.treasurySchedule.length ? 1 : 0)} defaultOpen={false}>
      {sc.pastedSchedules.length > 0 && (
        <ul className="list-plain small mb">{sc.pastedSchedules.map((p) => (
          <li key={p.id} className="row tight"><span className="badge navy">{p.mode}</span><span style={{ flex: 1 }}>{p.name} · {p.entries.length} payments · {money(p.entries.reduce((s, e) => s + e.amount, 0))}</span>
            <button className="icon-btn" aria-label="Remove schedule" onClick={() => upd((s) => ({ ...s, pastedSchedules: s.pastedSchedules.filter((x) => x.id !== p.id) }))}><i className="bi bi-trash" /></button></li>
        ))}</ul>
      )}
      {sc.treasurySchedule.length > 0 && (
        <div className="callout navy small mb row tight"><span style={{ flex: 1 }}>Known treasury schedule: {sc.treasurySchedule.length} flows, net {money(sc.treasurySchedule.reduce((s, t) => s + t.amount, 0))}</span>
          <button className="btn sm ghost" onClick={() => upd((s) => ({ ...s, treasurySchedule: [] }))}>Clear</button></div>
      )}
      <textarea className="input" placeholder={'Paste from Excel, e.g.\n15/04/2027\t2,400,000\n15/07/2027\t2,400,000\nor\nApr-27\t1,000,000\nor\n2027/28\t12,000,000'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Pasted schedule" />
      {parsed && (
        <div className="mt small">
          {parsed.kind ? <div className="callout green">Read <strong>{parsed.rows.length}</strong> {parsed.kind === 'dates' ? 'dated amounts' : parsed.kind === 'months' ? 'monthly amounts' : 'annual totals'}{parsed.skipped.length ? `; skipped ${parsed.skipped.length} line(s) (${parsed.skipped[0].reason})` : ''}.</div>
            : <div className="callout red">Couldn’t find dates, months or financial years with amounts. {parsed.skipped[0]?.reason}</div>}
        </div>
      )}
      <div className="grid g2 mt" style={{ gap: 8 }}>
        <div className="field"><label>Applies to</label>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="__treasury__">Known treasury schedule (separate layer)</option>
            {categories.filter((c) => c.group === 'receipts_operational' || c.group === 'payments_operational').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {!isTreasury && <div className="field"><label>Use it</label><Seg value={mode} onChange={setMode} options={[{ v: 'replace', label: 'Instead of model' }, { v: 'add', label: 'On top' }]} /></div>}
        {parsed?.kind && parsed.kind !== 'dates' && <div className="field"><label>Spread</label>
          <select className="select" value={spread} onChange={(e) => setSpread(e.target.value as Spread)}>
            <option value="day_of_month">On a day each month</option>
            <option value="even_business_days">Evenly over business days</option>
            {parsed.kind === 'years' && <option value="profile">To the category’s seasonal profile</option>}
          </select></div>}
        {parsed?.kind && parsed.kind !== 'dates' && spread === 'day_of_month' && <div className="field"><label>Day</label><input className="input" type="number" min={1} max={31} value={dom} onChange={(e) => setDom(+e.target.value)} /></div>}
        <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DSG 2027/28 allocation" /></div>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={negate} onChange={(e) => setNegate(e.target.checked)} /> These are payments (money out)</label>
      </div>
      {entries.length > 0 && (
        <div className="tbl-wrap mt" style={{ maxHeight: 180 }}>
          <table className="tbl"><thead><tr><th>Date</th><th className="num">Amount</th></tr></thead>
            <tbody>{entries.slice(0, 60).map((e, i) => <tr key={i}><td className="xs">{day(dayFromISO(e.date))}</td><td className="num"><Money v={e.amount} /></td></tr>)}</tbody></table>
        </div>
      )}
      <div className="row mt"><span className="xs muted">{entries.length ? `${entries.length} payments, total ${money(entries.reduce((s, e) => s + e.amount, 0))}` : ''}</span><span className="spacer" /><button className="btn primary sm" disabled={!entries.length} onClick={apply}><i className="bi bi-check2" /> Apply</button></div>
    </Section>
  );
}
