// "Came in early?": money in the statements that looks like a payment the forecast still expects
// later. Confirming takes the due payment out of the forecast. "Running late?": a regular payment
// due with nothing in; still coming keeps it in the forecast. Each answer is kept, so it's asked once.
import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { useForecast } from './useForecast';
import { findEarly, answerEarly, findLate, answerLate, type EarlyCandidate, type LateCandidate } from '../../lib/forecast/early';
import { money, day } from '../../lib/format';
import { MONTH_NAMES, ymdFromDay, isoFromDay, dayFromISO } from '../../lib/dates';

const monthOf = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };

/** Money early or late in the statements between `from` and `to`, against the forecast you're working on. */
export function EarlyCheck({ from, to }: { from: number; to: number }) {
  return <><EarlyList from={from} to={to} /><LateList from={from - 14} to={to} /></>;
}

function EarlyList({ from, to }: { from: number; to: number }) {
  const { team, activeScenarioId, basis, updateScenario, user, toast } = useStore();
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  const b = useForecast(sc);
  const list = useMemo(() => (b && basis && sc ? findEarly(basis, b.fc, sc, from, to) : []), [b, basis, sc, from, to]);
  if (!sc || !list.length) return null;
  const catName = (id: string) => team.categories.find((c) => c.id === id)?.name ?? id;
  const answer = (c: EarlyCandidate, a: 'early' | 'extra') => {
    updateScenario(sc.id, (s) => ({ ...s, arrivals: [...(s.arrivals ?? []), answerEarly(c, a, user || 'Not named')] }));
    toast(a === 'early' ? `Taken out of ${monthOf(c.due)} in “${sc.name}”, so it isn’t counted twice.` : 'Left in the forecast.');
  };
  return (
    <div className="card card-pad early-check">
      <h3><i className="bi bi-alarm" /> Came in early?</h3>
      <p className="small muted">This money is already in your statements, but your forecast “{sc.name}” still expects it later, so it would be counted twice.</p>
      <ul className="list-plain">
        {list.map((c) => (
          <li key={c.key} className="early-item">
            <div>
              <strong>{c.label}</strong> <span className="muted small">· {catName(c.categoryId)}</span>
              <div className="small"><strong>{money(Math.abs(c.amount))}</strong> {c.amount < 0 ? 'went out' : 'came in'} on {day(c.day)}. {c.kind === 'oneoff' ? 'You added' : 'The forecast has'} about {money(Math.abs(c.expected))} on <strong>{day(c.due)}</strong>{c.kind === 'series' ? ', as usual' : ''}.</div>
            </div>
            <div className="row tight">
              <button className="btn sm navy" onClick={() => answer(c, 'early')}>Yes, it’s early: take it out of {monthOf(c.due)}</button>
              <button className="btn sm ghost" onClick={() => answer(c, 'extra')}>No, it’s extra</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Regular payments whose due date has passed with nothing in: still coming, or not? */
function LateList({ from, to }: { from: number; to: number }) {
  const { team, activeScenarioId, basis, updateScenario, user, toast } = useStore();
  const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
  const b = useForecast(sc);
  const list = useMemo(() => (b && basis && sc ? findLate(basis, b.fc, sc, from, to) : []), [b, basis, sc, from, to]);
  const [when, setWhen] = useState<Record<string, string>>({});
  if (!sc || !list.length) return null;
  const catName = (id: string) => team.categories.find((c) => c.id === id)?.name ?? id;
  const answer = (c: LateCandidate, a: 'late' | 'missed') => {
    const on = dayFromISO(when[c.key] ?? isoFromDay(c.expectOn));
    updateScenario(sc.id, (s) => ({ ...s, arrivals: [...(s.arrivals ?? []), answerLate(c, a, on, user || 'Not named')] }));
    toast(a === 'late' ? `Kept in “${sc.name}”, expected on ${day(on)}.` : `Left out of “${sc.name}”.`);
  };
  return (
    <div className="card card-pad early-check mt">
      <h3><i className="bi bi-hourglass-split" /> Running late?</h3>
      <p className="small muted">These were due but haven’t come through in your statements. Left alone, your forecast “{sc.name}” stops expecting them. Is each still coming?</p>
      <ul className="list-plain">
        {list.map((c) => (
          <li key={c.key} className="early-item">
            <div>
              <strong>{c.label}</strong> <span className="muted small">· {catName(c.categoryId)}</span>
              <div className="small">About <strong>{money(Math.abs(c.amount))}</strong> was due {c.amount < 0 ? 'out' : 'in'} on <strong>{day(c.due)}</strong>, and nothing has come through since.</div>
            </div>
            <div className="row tight">
              <label className="small muted" htmlFor={`late-${c.key}`}>Expect it on</label>
              <input id={`late-${c.key}`} type="date" className="input sm" value={when[c.key] ?? isoFromDay(c.expectOn)} min={isoFromDay(c.expectOn)} onChange={(e) => setWhen({ ...when, [c.key]: e.target.value })} />
              <button className="btn sm navy" onClick={() => answer(c, 'late')}>Still coming</button>
              <button className="btn sm ghost" onClick={() => answer(c, 'missed')}>Not coming</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
