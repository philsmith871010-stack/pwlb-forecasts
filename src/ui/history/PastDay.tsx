// A past day from the saved cash history: what the statement came to, by category. The history
// keeps daily totals by category (and regular payments), not bank lines, so this is the summary
// of the day, not its lines.
import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { historySpan, daysWithFlows, pastDaySummary, K_INTERNAL, K_ONEOFF, K_TREASURY, type CashHistory, type PastDaySummary } from '../../lib/history/cashHistory';
import { money, day, int } from '../../lib/format';
import { Money, CatBadge, PageHead } from '../components/common';
import { dayFromISO, isoFromDay, weekday } from '../../lib/dates';
import type { Category } from '../../lib/categories';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const HEADS = ['Not sorted', 'Money in', 'Money out', 'Loans and investments', 'Between your own accounts'];
function sectionOf(r: { cat: string; kind: number }, cats: Category[]): number {
  if (r.kind === K_INTERNAL) return 4;
  if (r.kind === K_TREASURY) return 3;
  const g = cats.find((c) => c.id === r.cat)?.group;
  if (!g || r.cat === 'uncategorised') return 0;
  return g === 'receipts_operational' ? 1 : g === 'payments_operational' ? 2 : g === 'treasury' ? 3 : 4;
}

/** Review history → A past day. */
export function PastDayPage() {
  const h = useStore((s) => s.team.cashHistory ?? s.historyBase);
  return (
    <div className="page narrow">
      <PageHead title="A past day">Choose any day in your saved history to see it like a bank statement: each account’s opening and closing balance, and the day’s money by category.</PageHead>
      {h && <PastDayCard h={h} />}
    </div>
  );
}

/** Pick any day the saved history holds and see what it came to, by category. */
export function PastDayCard({ h }: { h: CashHistory }) {
  const categories = useStore((s) => s.team.categories);
  const span = historySpan(h);
  const days = useMemo(() => daysWithFlows(h), [h]);
  const [sel, setSel] = useState<number | null>(null);
  const d = sel ?? days[days.length - 1] ?? span?.to ?? 0;
  const sum = useMemo(() => pastDaySummary(h, d), [h, d]);
  if (!span) return null;

  // step to the previous or next day with money moving
  const prev = [...days].reverse().find((x) => x < d), next = days.find((x) => x > d);
  const rows = (sum?.rows ?? []).map((r) => ({ ...r, sec: sectionOf(r, categories) }))
    .sort((a, z) => a.sec - z.sec || Math.abs(z.net) - Math.abs(a.net));
  const everyday = rows.filter((r) => r.sec === 1 || r.sec === 2).reduce((t, r) => t + r.net, 0);
  const catOf = (id: string) => categories.find((c) => c.id === id);
  let lastSec = -1;

  return (
    <div className="card done-card fade day-card">
      <div className="done-head">
        <i className="bi bi-calendar3" />
        <div>
          <h2>A past day: {WEEKDAYS[weekday(d)] ?? ''} {day(d)}</h2>
          <p>Any day from {day(span.from)} to {day(span.to)}, from your saved history: balances and totals for the day, not the individual bank lines.</p>
        </div>
      </div>
      <div className="row mb">
        <button className="btn sm ghost" disabled={prev === undefined} onClick={() => prev !== undefined && setSel(prev)} aria-label="Previous day with money moving"><i className="bi bi-chevron-left" /> Previous</button>
        <input type="date" value={isoFromDay(d)} min={isoFromDay(span.from)} max={isoFromDay(span.to)} aria-label="Day to look up"
          onChange={(e) => { if (e.target.value) setSel(Math.min(span.to, Math.max(span.from, dayFromISO(e.target.value)))); }} />
        <button className="btn sm ghost" disabled={next === undefined} onClick={() => next !== undefined && setSel(next)} aria-label="Next day with money moving">Next <i className="bi bi-chevron-right" /></button>
        <button className="link-btn small" onClick={() => setSel(null)}>Latest</button>
      </div>

      {sum && <DayStatement s={sum.statement} />}

      {!sum ? <div className="callout navy small">No statement for {day(d)} is in your saved history. Load it under Set up and train to add it.</div>
        : !rows.length ? <div className="callout navy small">No money moved on {day(d)}.</div>
        : (
          <>
            <table className="tbl day-tbl">
              <thead><tr><th>Category</th><th className="num">In</th><th className="num">Out</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const head = r.sec !== lastSec ? HEADS[r.sec] : null; lastSec = r.sec;
                  return [
                    head ? <tr key={`h${r.sec}`} className="grp"><td colSpan={3}>{head}</td></tr> : null,
                    <tr key={`${r.cat}|${r.kind}`} className={r.sec === 0 ? 'warn' : ''}>
                      <td>{r.sec === 0 ? <strong>Not sorted</strong> : <CatBadge cat={catOf(r.cat)} />}{r.kind === K_ONEOFF && <span className="xs muted"> · one-off</span>}</td>
                      <td className="num">{r.net > 0 ? <Money v={r.net} /> : ''}</td>
                      <td className="num">{r.net < 0 ? <Money v={r.net} /> : ''}</td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
            {sum.regular.length > 0 && (
              <details className="fold mt">
                <summary>Regular payments that day ({int(sum.regular.length)})</summary>
                <table className="tbl tbl-sm"><tbody>{sum.regular.slice(0, 50).map((x, i) => (
                  <tr key={i}><td className="xs">{x.sig}</td><td className="xs muted">{catOf(x.cat)?.name ?? x.cat}</td><td className="num xs nowrap"><Money v={x.amount} /></td></tr>
                ))}</tbody></table>
              </details>
            )}
            <div className="day-foot small">
              <span>Everyday cash on the day: <strong>{money(everyday, { sign: true })}</strong>{sum.accounts < h.accounts.length && <span className="muted"> · only {sum.accounts} of your {h.accounts.length} accounts have a statement for this day</span>}.</span>
              <span className="muted">Each figure is the day’s net for that category. To see the lines, load that day’s statement under Set up and train.</span>
            </div>
          </>
        )}
    </div>
  );
}

/** The day as a bank statement: each account's balance at the start and end of the day, and money in and out. */
function DayStatement({ s }: { s: PastDaySummary['statement'] }) {
  if (!s.length) return null;
  const known = s.every((a) => a.opening !== null && a.closing !== null);
  const tot = s.reduce((t, a) => ({ opening: t.opening + (a.opening ?? 0), closing: t.closing + (a.closing ?? 0), in: t.in + a.in, out: t.out + a.out }), { opening: 0, closing: 0, in: 0, out: 0 });
  const bal = (v: number | null) => (v === null ? <span className="muted">not shown</span> : <Money v={v} full />);
  return (
    <div className="day-statement mb">
      <table className="tbl">
        <thead><tr><th>Account</th><th className="num">Opening balance</th><th className="num">Money in</th><th className="num">Money out</th><th className="num">Closing balance</th></tr></thead>
        <tbody>
          {s.map((a) => (
            <tr key={a.key}><td className="mono">{a.key}</td><td className="num">{bal(a.opening)}</td><td className="num">{a.in ? <Money v={a.in} full /> : '–'}</td><td className="num">{a.out ? <Money v={a.out} full /> : '–'}</td><td className="num strong">{bal(a.closing)}</td></tr>
          ))}
          {s.length > 1 && (
            <tr className="tot"><td>All {s.length} accounts</td><td className="num">{known ? <Money v={tot.opening} full /> : ''}</td><td className="num"><Money v={tot.in} full /></td><td className="num"><Money v={tot.out} full /></td><td className="num">{known ? <Money v={tot.closing} full /> : ''}</td></tr>
          )}
        </tbody>
      </table>
      <div className="xs muted mt">{known ? 'Balances worked out from the balances in your statement files and the money moving each day.' : 'A balance shows when the statement files for that account included one.'}</div>
    </div>
  );
}
