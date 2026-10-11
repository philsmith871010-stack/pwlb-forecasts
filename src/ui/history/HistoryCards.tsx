// Step 1 with a saved cash history: what's held, what a new upload added, and — for a day or
// two of bank data — the sorted day itself.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { engine } from '../../worker/client';
import type { TxnRow } from '../../worker/types';
import { historySpan, historyBytes, type CashHistory } from '../../lib/history/cashHistory';
import { money, day, int } from '../../lib/format';
import { Money, CatBadge } from '../components/common';
import { isBusinessDay, dayFromISO } from '../../lib/dates';
import { useTracking, aheadWords, asOfWords } from '../forecast/useTracking';
import { computeForecast } from '../forecast/useForecast';
import { AddMoreFiles } from '../components/AddMoreFiles';
import { basisFromHistory } from '../../lib/history/cashHistory';

const workingDays = (from: number, to: number) => { let n = 0; for (let d = from; d <= to; d++) if (isBusinessDay(d)) n++; return n; };

/** One line on what loading these files did to the saved history. */
export function HistoryAddedNote({ gapsOnly }: { gapsOnly?: boolean } = {}) {
  const { historyReport: r, team, historyBase } = useStore();
  const h = team.cashHistory;
  if (!r || !h || !historyBase) return null;
  const span = historySpan(h);
  const from = Math.min(...r.added.map((x) => x.from)), to = Math.max(...r.added.map((x) => x.to));
  const replaced = r.added.reduce((t, x) => t + x.replacedDays, 0);
  const n = workingDays(from, to);
  return (
    <>
      {!gapsOnly && <li><i className="bi bi-clock-history" /> Added {n <= 1 ? <strong>{day(from)}</strong> : <><strong>{day(from)}</strong> to <strong>{day(to)}</strong> ({int(n)} working days)</>} to your saved history{span ? <>, which now runs {day(span.from)} to {day(span.to)}</> : ''}.
        {replaced > 0 && <span className="muted"> {int(replaced)} day{replaced > 1 ? 's' : ''} you’d loaded before {replaced > 1 ? 'were' : 'was'} replaced by these files, so nothing is counted twice.</span>}</li>}
      {r.gaps.map((g, i) => (
        <li key={i} className="warn"><i className="bi bi-exclamation-triangle" /> Nothing has been loaded for account <strong>{g.account}</strong> between {day(g.from)} and {day(g.to)} ({int(workingDays(g.from, g.to))} working days). If money moved then, add that statement too.</li>
      ))}
    </>
  );
}

/** For a day (or a few) of bank data: the sorted day, by category, with every line a click away. */
export function DayCard({ onSort }: { onSort?: () => void } = {}) {
  const { ingest, cat, team, goto, setStepTab, historyBase, activeScenarioId } = useStore();
  const tr = useTracking();
  const [rows, setRows] = useState<TxnRow[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // on a wide screen the chosen category's lines fill the space beside the summary
  const wide = useWide(1100);
  const catVersion = useStore((s) => s.catVersion);
  useEffect(() => {
    if (!ingest) return;
    let live = true;
    void engine().queryTxns({ from: ingest.minDay, to: ingest.maxDay, sort: 'abs_desc' }, 0, 2000).then((r) => { if (live) setRows(r.rows); });
    return () => { live = false; };
  }, [ingest, catVersion]);

  // what the forecast (made before this day was added) expected of everyday cash on these days
  const expected = useMemo(() => {
    if (!historyBase || !ingest || !cat) return null;
    const sc = team.forecasts.find((f) => f.id === activeScenarioId) ?? team.forecasts[0];
    const basis = basisFromHistory(historyBase, cat.catIds);
    if (!sc || !basis) return null;
    const b = computeForecast(basis, { ...sc, settings: { ...sc.settings, start: new Date((basis.dataEnd + 1) * 864e5).toISOString().slice(0, 10) } }, team.categories, team.settings.liquidityBuffer, 4, null);
    if (!sc.reviewDone) return null; // only once someone has checked the forecast
    let net = 0, any = false;
    for (let d = ingest.minDay; d <= ingest.maxDay; d++) { const k = d - b.fc.start; if (k >= 0 && k < b.fc.H) { net += b.fc.net[k]; any = true; } }
    return any ? net : null;
  }, [historyBase, ingest, cat, team.forecasts, team.categories, team.settings.liquidityBuffer, activeScenarioId]);

  if (!ingest || !cat || !rows) return null;
  const catName = (idx: number) => (idx >= 0 ? team.categories.find((c) => c.id === cat.catIds[idx])?.name ?? cat.catIds[idx] : 'Not sorted yet');
  const groupOf = (idx: number) => (idx >= 0 ? team.categories.find((c) => c.id === cat.catIds[idx])?.group : undefined);
  const byCat = new Map<number, { n: number; inn: number; out: number; rows: TxnRow[] }>();
  for (const r of rows) {
    const g = byCat.get(r.catIdx) ?? { n: 0, inn: 0, out: 0, rows: [] };
    g.n++; if (r.amount >= 0) g.inn += r.amount; else g.out += r.amount; g.rows.push(r);
    byCat.set(r.catIdx, g);
  }
  const order = (idx: number) => { const g = groupOf(idx); return idx < 0 ? 0 : g === 'receipts_operational' ? 1 : g === 'payments_operational' ? 2 : g === 'treasury' ? 3 : 4; };
  const list = [...byCat.entries()].sort((a, z) => order(a[0]) - order(z[0]) || Math.abs(z[1].inn + z[1].out) - Math.abs(a[1].inn + a[1].out));
  const everyday = list.filter(([i]) => order(i) === 1 || order(i) === 2).reduce((t, [, g]) => t + g.inn + g.out, 0);
  const unsorted = byCat.get(-1)?.n ?? 0;
  const one = ingest.minDay === ingest.maxDay;
  const head = (i: number) => ({ 0: null, 1: 'Money in', 2: 'Money out', 3: 'Loans and investments', 4: 'Between your own accounts' } as Record<number, string | null>)[order(i)];
  let lastHead: string | null | undefined;
  const linesTable = (rs: TxnRow[]) => (
    <table className="tbl tbl-sm"><tbody>{rs.slice(0, 200).map((r) => (
      <tr key={r.i}>{!one && <td className="xs muted nowrap" style={{ width: 96 }}>{day(r.day)}</td>}<td className="xs">{r.narrative}</td>{ingest.accounts.length > 1 && <td className="xs muted nowrap" title="Bank account">{r.account}</td>}<td className="num xs nowrap"><Money v={r.amount} full /></td></tr>
    ))}</tbody></table>
  );

  return (
    <div className="card done-card fade day-card">
      <div className="done-head">
        <i className="bi bi-calendar-check" />
        <div>
          <h2>{one ? <>Your day: {day(ingest.minDay)}</> : <>Your days: {day(ingest.minDay)} to {day(ingest.maxDay)}</>}</h2>
          <p>{int(ingest.rows)} bank lines across {ingest.accounts.length} account{ingest.accounts.length > 1 ? 's' : ''}. {wide ? 'Choose a category to see its lines.' : 'Click a category to see its lines.'}</p>
        </div>
      </div>
      {unsorted > 0 && (
        <div className="callout small mb"><strong>{unsorted} line{unsorted > 1 ? 's' : ''} we couldn’t sort.</strong> Sorting {unsorted > 1 ? 'them' : 'it'} once teaches the tool for next time.{' '}
          <button className="link-btn" onClick={() => { if (onSort) onSort(); else { setStepTab('review-simple', 'unsorted'); goto('review'); } }}>Sort {unsorted > 1 ? 'them' : 'it'} now</button></div>
      )}
      <div className={wide ? 'day-split' : ''}>
      <table className="tbl day-tbl">
        <thead><tr><th>Category</th><th className="num">In</th><th className="num">Out</th><th /></tr></thead>
        <tbody>
          {list.map(([idx, g]) => {
            const h = head(idx);
            const showHead = h && h !== lastHead; lastHead = h;
            return [
              showHead ? <tr key={`h${idx}`} className="grp"><td colSpan={4}>{h}</td></tr> : null,
              <tr key={idx} className={`clickable ${idx < 0 ? 'warn' : ''} ${(wide ? (open ?? list[0]?.[0]) : open) === idx ? 'open' : ''}`} onClick={() => setOpen(wide ? idx : open === idx ? null : idx)} title="Show the lines">
                <td>{idx >= 0 ? <CatBadge cat={team.categories.find((c) => c.id === cat.catIds[idx])} /> : <strong>{catName(idx)}</strong>} <span className="xs muted">· {int(g.n)} line{g.n > 1 ? 's' : ''}</span></td>
                <td className="num">{g.inn ? <Money v={g.inn} /> : ''}</td>
                <td className="num">{g.out ? <Money v={g.out} /> : ''}</td>
                <td className="chev"><i className={`bi ${wide ? 'bi-chevron-right' : open === idx ? 'bi-chevron-up' : 'bi-chevron-down'}`} /></td>
              </tr>,
              !wide && open === idx ? (
                <tr key={`l${idx}`} className="lines"><td colSpan={4}>{linesTable(g.rows)}</td></tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
      {wide && (() => {
        const sel = open !== null && byCat.has(open) ? open : list[0]?.[0];
        const g = sel !== undefined ? byCat.get(sel) : undefined;
        return g ? (
          <div className="day-lines">
            <div className="day-lines-head"><strong>{catName(sel!)}</strong> <span className="muted">· {int(g.n)} line{g.n > 1 ? 's' : ''}, largest first</span></div>
            {linesTable(g.rows)}
          </div>
        ) : null;
      })()}
      </div>
      <div className="day-foot small">
        <span>Everyday cash {one ? 'on the day' : 'over these days'}: <strong>{money(everyday, { sign: true })}</strong>{expected !== null && <span className="muted"> · your forecast expected about {money(expected, { sign: true })}</span>}.</span>
        {tr?.r && (
          <span className="day-track"><i className="bi bi-patch-check-fill" /> Against the signed-off “{tr.rec.scenarioName}” (from {day(dayFromISO(tr.rec.start))}), everyday cash was <strong>{aheadWords(tr.gap, money)}</strong> it {asOfWords(tr)}.{' '}
            <button className="link-btn" onClick={() => goto('monitor')}>See how</button></span>
        )}
      </div>
      <div className="done-next">
        <span className="muted"><i className="bi bi-check2-circle green" /> {one ? 'This day is' : 'These days are'} now in your cash history, saved in this browser.</span>
        <AddMoreFiles label="Add another statement" />
      </div>
    </div>
  );
}

export const historySize = (h: CashHistory) => historyBytes(h);

/** True while the window is at least `px` wide. */
function useWide(px: number): boolean {
  const q = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return wide;
}
