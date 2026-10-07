// "Build this line yourself": a short wizard for a line other departments forecast for you,
// or one our history can't know. It produces dated figures in a row of the line's grid.
import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Modal } from '../components/common';
import type { Scenario, GridOverride } from '../../lib/model';
import type { ForecastBundle } from './useForecast';
import type { CategoryExplain } from '../../lib/forecast/engine';
import { money, day as fmtDay, int } from '../../lib/format';
import {
  Day, isoFromDay, dayFromISO, dayFromYMD, ymdFromDay, daysInMonth, addMonths, isBusinessDay, nextBusinessDay, prevBusinessDay, lastWorkingDayOfMonth,
} from '../../lib/dates';
import { parseCell } from './GridEditor';
import { readTableText } from '../../lib/forecast/importSchedule';
import { parseDate } from '../../lib/ingest/parseValues';

type Upd = (fn: (s: Scenario) => Scenario) => void;
type Kind = 'regular' | 'annual' | 'dates';
type Cadence = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual';
const CADENCES: [Cadence, string][] = [['weekly', 'Every week'], ['fortnightly', 'Every two weeks'], ['four_weekly', 'Every four weeks'], ['monthly', 'Every month'], ['quarterly', 'Every quarter'], ['half_yearly', 'Twice a year'], ['annual', 'Once a year']];
const STEP_DAYS: Partial<Record<Cadence, number>> = { weekly: 7, fortnightly: 14, four_weekly: 28 };
const STEP_MONTHS: Partial<Record<Cadence, number>> = { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 };

/** Dates for a regular payment, moved off weekends and bank holidays (earlier for payments, later for receipts). */
export function regularDates(o: { cadence: Cadence; first: Day; until: Day; lastWorkingDay: boolean; inflow: boolean }): Day[] {
  const roll = (d: Day) => (isBusinessDay(d) ? d : o.inflow ? nextBusinessDay(d) : prevBusinessDay(d));
  const out: Day[] = [];
  const sd = STEP_DAYS[o.cadence];
  if (sd) { for (let d = o.first; d <= o.until; d += sd) out.push(roll(d)); return out; }
  const sm = STEP_MONTHS[o.cadence]!;
  const { y, m, d } = ymdFromDay(o.first);
  for (let k = 0; ; k += sm) {
    const mi = y * 12 + m - 1 + k, yy = Math.floor(mi / 12), mm = (mi % 12) + 1;
    const day = o.lastWorkingDay ? lastWorkingDayOfMonth(yy, mm) : roll(dayFromYMD(yy, mm, Math.min(d, daysInMonth(yy, mm))));
    if (dayFromYMD(yy, mm, 1) > o.until) break;
    if (day >= o.first - 3 && day <= o.until) out.push(day);
  }
  return out;
}

export function LineWizard({ e, b, upd, onClose, inflow }: { e: CategoryExplain; b: ForecastBundle; upd: Upd; onClose: () => void; inflow: boolean }) {
  const toast = useStore((s) => s.toast);
  const start = b.fc.start, end = b.fc.start + b.fc.H - 1;
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('regular');
  // regular
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [first, setFirst] = useState(isoFromDay(start));
  const [until, setUntil] = useState(isoFromDay(end));
  const [lwd, setLwd] = useState(false);
  // annual
  const [yearly, setYearly] = useState('');
  const [spread, setSpread] = useState<'even' | 'pattern'>('even');
  const [dom, setDom] = useState(15);
  const [annualLwd, setAnnualLwd] = useState(false);
  // dates
  const [list, setList] = useState<{ date: string; amount: string }[]>([{ date: '', amount: '' }, { date: '', amount: '' }, { date: '', amount: '' }]);
  const [replace, setReplace] = useState(e.method === 'manual');

  const sign = inflow ? 1 : -1;
  const entries = useMemo((): { day: Day; amount: number }[] => {
    if (kind === 'regular') {
      const a = parseCell(amount);
      if (!a || isNaN(a)) return [];
      return regularDates({ cadence, first: dayFromISO(first), until: Math.min(end, dayFromISO(until)), lastWorkingDay: lwd && !!STEP_MONTHS[cadence], inflow })
        .filter((d) => d >= start && d <= end).map((d) => ({ day: d, amount: sign * a }));
    }
    if (kind === 'annual') {
      const a = parseCell(yearly);
      if (!a || isNaN(a)) return [];
      const prof = e.profile.map((v) => Math.abs(v));
      const pt = prof.reduce((t, v) => t + v, 0);
      const out: { day: Day; amount: number }[] = [];
      for (let mk = 0; ; mk++) {
        const ms = addMonths(dayFromYMD(ymdFromDay(start).y, ymdFromDay(start).m, 1), mk);
        if (ms > end) break;
        const { y, m } = ymdFromDay(ms);
        const share = spread === 'pattern' && pt > 0 ? prof[m - 1] / pt : 1 / 12;
        const d = annualLwd ? lastWorkingDayOfMonth(y, m) : (() => { const x = dayFromYMD(y, m, Math.min(dom, daysInMonth(y, m))); return isBusinessDay(x) ? x : inflow ? nextBusinessDay(x) : prevBusinessDay(x); })();
        if (d >= start && d <= end) out.push({ day: d, amount: sign * a * share });
      }
      return out;
    }
    return list.map((r) => ({ d: parseDate(r.date, 'DMY') ?? (r.date ? { day: dayFromISO(r.date) } : null), a: parseCell(r.amount) }))
      .filter((r) => r.d && r.a !== null && !isNaN(r.a as number) && !isNaN(r.d.day)).map((r) => ({ day: r.d!.day, amount: sign * (r.a as number) }))
      .filter((r) => r.day >= start && r.day <= end).sort((x, y) => x.day - y.day);
  }, [kind, amount, cadence, first, until, lwd, yearly, spread, dom, annualLwd, list, e.profile, start, end, sign, inflow]);

  const pasteList = (text: string) => {
    const rows = readTableText(text).filter((r) => r.length >= 2 && parseDate(r[0], 'DMY'));
    if (!rows.length) return false;
    setList(rows.map((r) => ({ date: r[0], amount: r[r.length - 1] })));
    return true;
  };

  const add = () => {
    const row = `custom:${name.trim() || 'Your figures'}`;
    const ovs: GridOverride[] = [];
    const byDay = new Map<Day, number>();
    for (const x of entries) byDay.set(x.day, (byDay.get(x.day) ?? 0) + x.amount);
    for (const [d, a] of byDay) ovs.push({ categoryId: e.id, row, month: isoFromDay(d).slice(0, 7), date: isoFromDay(d), amount: Math.round(a * 100) / 100 });
    upd((s) => ({
      ...s,
      overrides: [...(s.overrides ?? []).filter((o) => !(o.categoryId === e.id && o.row === row)), ...ovs],
      settings: replace ? { ...s.settings, methodByCategory: { ...s.settings.methodByCategory, [e.id]: 'manual' } } : s.settings,
    }));
    toast(`Added ${entries.length} payments to ${e.name}`, 'ok');
    onClose();
  };

  const total = entries.reduce((t, x) => t + x.amount, 0);
  const ready = step === 0 ? !!name.trim() : entries.length > 0;
  return (
    <Modal wide title={<>Build {e.name.toLowerCase()} yourself <span className="muted small" style={{ fontWeight: 500 }}>· step {step + 1} of 3</span></>} onClose={onClose}
      footer={<>
        {step > 0 ? <button className="btn" onClick={() => setStep(step - 1)}><i className="bi bi-arrow-left" /> Back</button> : <button className="btn" onClick={onClose}>Cancel</button>}
        <span className="spacer" />
        {step < 2 ? <button className="btn primary" disabled={!ready} onClick={() => setStep(step + 1)}>Next <i className="bi bi-arrow-right" /></button>
          : <button className="btn primary" disabled={!entries.length} onClick={add}><i className="bi bi-check-lg" /> Add to the forecast</button>}
      </>}>
      {step === 0 && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="field" style={{ maxWidth: 380 }}><label>What is it?</label>
            <input className="input" autoFocus value={name} onChange={(ev) => setName(ev.target.value)} placeholder={inflow ? 'e.g. New homes bonus, from Finance' : 'e.g. Agency staff, from HR'} />
            <small className="muted">This name appears as a row in the line’s grid.</small></div>
          <div className="field"><label>How is it {inflow ? 'received' : 'paid'}?</label>
            <div className="imp-modes">
              {([['regular', 'The same amount at regular intervals', 'e.g. £250,000 every month on the 15th'], ['annual', 'A total for the year, spread across the months', 'e.g. £3m a year, paid monthly'], ['dates', 'On particular dates', 'Type or paste the dates and amounts you’ve been given']] as [Kind, string, string][]).map(([v, t, d]) => (
                <label key={v} className={`imp-mode ${kind === v ? 'on' : ''}`}><input type="radio" name="kind" checked={kind === v} onChange={() => setKind(v)} /><span><strong>{t}</strong><small>{d}</small></span></label>
              ))}
            </div></div>
        </div>
      )}

      {step === 1 && kind === 'regular' && (
        <div className="imp-cols">
          <div className="field"><label>Amount each time (£)</label><input className="input" inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="250,000" /></div>
          <div className="field"><label>How often</label><select className="select" value={cadence} onChange={(ev) => setCadence(ev.target.value as Cadence)}>{CADENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label>First payment</label><input className="input" type="date" value={first} onChange={(ev) => ev.target.value && setFirst(ev.target.value)} /></div>
          <div className="field"><label>Last payment no later than</label><input className="input" type="date" value={until} onChange={(ev) => ev.target.value && setUntil(ev.target.value)} /></div>
          {STEP_MONTHS[cadence] && <label className="row tight small" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={lwd} onChange={(ev) => setLwd(ev.target.checked)} /> Always on the last working day of the month (instead of the same date)</label>}
          <p className="xs muted" style={{ gridColumn: '1 / -1', margin: 0 }}>Dates on a weekend or bank holiday move to the {inflow ? 'next' : 'previous'} working day.</p>
        </div>
      )}
      {step === 1 && kind === 'annual' && (
        <div className="imp-cols">
          <div className="field"><label>Total a year (£)</label><input className="input" inputMode="decimal" value={yearly} onChange={(ev) => setYearly(ev.target.value)} placeholder="3,000,000" /></div>
          <div className="field"><label>Spread</label><select className="select" value={spread} onChange={(ev) => setSpread(ev.target.value as 'even' | 'pattern')}>
            <option value="even">Evenly: a twelfth each month</option><option value="pattern">Like this line’s past monthly pattern</option></select></div>
          <div className="field"><label>Paid on</label><select className="select" value={annualLwd ? 'lwd' : String(dom)} onChange={(ev) => { if (ev.target.value === 'lwd') setAnnualLwd(true); else { setAnnualLwd(false); setDom(+ev.target.value); } }}>
            <option value="lwd">The last working day</option>{Array.from({ length: 28 }, (_, k) => <option key={k} value={k + 1}>Day {k + 1} of the month</option>)}</select></div>
          <p className="xs muted" style={{ gridColumn: '1 / -1', margin: 0 }}>Applied to every month of the forecast ({fmtDay(start)} to {fmtDay(end)}).</p>
        </div>
      )}
      {step === 1 && kind === 'dates' && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small" style={{ margin: 0 }}>Type the dates and amounts, or <strong>paste two columns from Excel</strong> (date, amount) into the first box.</p>
          <table className="tbl tbl-sm" style={{ maxWidth: 460 }}>
            <thead><tr><th>Date</th><th className="num">Amount (£)</th><th /></tr></thead>
            <tbody>{list.map((r, i) => (
              <tr key={i}>
                <td><input className="input" placeholder="07/05/2026" value={r.date} onChange={(ev) => setList(list.map((x, j) => (j === i ? { ...x, date: ev.target.value } : x)))}
                  onPaste={(ev) => { const t = ev.clipboardData.getData('text'); if (/[\t\n]/.test(t.trim()) && pasteList(t)) ev.preventDefault(); }} /></td>
                <td><input className="input" inputMode="decimal" style={{ textAlign: 'right' }} placeholder="1,500,000" value={r.amount} onChange={(ev) => setList(list.map((x, j) => (j === i ? { ...x, amount: ev.target.value } : x)))} /></td>
                <td><button className="icon-btn" aria-label="Remove" onClick={() => setList(list.filter((_, j) => j !== i))}><i className="bi bi-x" /></button></td>
              </tr>
            ))}</tbody>
          </table>
          <div><button className="btn sm" onClick={() => setList([...list, { date: '', amount: '' }])}><i className="bi bi-plus-lg" /> Another date</button></div>
        </div>
      )}

      {step === 2 && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="small" style={{ margin: 0 }}><strong>{int(entries.length)}</strong> payment{entries.length === 1 ? '' : 's'} of “{name}”, <strong>{money(Math.abs(total))}</strong> {inflow ? 'received' : 'paid'} in total over the forecast.</p>
          <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
            <table className="tbl tbl-sm"><tbody>{entries.slice(0, 60).map((x) => <tr key={x.day}><td>{fmtDay(x.day)}</td><td className="num">{money(Math.abs(x.amount))}</td></tr>)}</tbody></table>
            {entries.length > 60 && <div className="xs muted" style={{ padding: 6 }}>…and {entries.length - 60} more.</div>}
          </div>
          <label className="imp-mode on" style={{ maxWidth: 620 }}>
            <input type="checkbox" checked={replace} onChange={(ev) => setReplace(ev.target.checked)} />
            <span><strong>Use only these figures for {e.name.toLowerCase()}</strong><small>Clears our forecast for this line. Leave unticked to add these on top of it.</small></span>
          </label>
        </div>
      )}
    </Modal>
  );
}
