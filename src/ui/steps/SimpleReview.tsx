import { useEffect, useState } from 'react';
import { useStore, useEyebrow } from '../../state/store';
import { PageHead, StepFooter, Money } from '../components/common';
import { engine } from '../../worker/client';
import type { ReviewGroup, DealQueue, TxnRow } from '../../worker/types';
import { money, pct, day, int } from '../../lib/format';
import { F_LOAN_PAIR, F_ROUND, F_COUNCIL, F_INTEREST_LIKE, F_LARGE, F_SINGLE, F_DEAL_LIKE_OP } from '../../lib/categorise/engine';
import type { Category } from '../../lib/categories';
import { ymdFromDay, MONTH_NAMES } from '../../lib/dates';

const FRIENDLY_GROUPS: [Category['group'], string][] = [
  ['receipts_operational', 'Money coming in'],
  ['payments_operational', 'Money going out'],
  ['treasury', 'Loans & investments'],
  ['internal', 'Moving money between our own accounts'],
];

const CADENCE_WORDS: Record<string, string> = {
  daily: 'most days', weekly: 'every week', fortnightly: 'every two weeks', semi_monthly: 'twice a month', four_weekly: 'every four weeks',
  monthly: 'every month', quarterly: 'every quarter', half_yearly: 'every six months', annual: 'once a year',
};

const monthYear = (d: number) => { const { y, m } = ymdFromDay(d); return `${MONTH_NAMES[m - 1]} ${y}`; };

function FriendlySelect({ value, onChange, categories, label }: { value: string; onChange: (v: string) => void; categories: Category[]; label: string }) {
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 300 }}>
      <option value="">Choose…</option>
      {FRIENDLY_GROUPS.map(([g, l]) => (
        <optgroup key={g} label={l}>{categories.filter((c) => c.group === g).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
      ))}
    </select>
  );
}

export function useQueue<T>(fn: () => Promise<T>): T | null {
  const v = useStore((s) => s.catVersion);
  const [x, setX] = useState<T | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { let live = true; void fn().then((r) => { if (live) setX(r); }); return () => { live = false; }; }, [v]);
  return x;
}

/** Show a toast with an Undo button for the decision just made. */
function confirmWithUndo(text: string) {
  const st = useStore.getState();
  const latest = st.sessionChanges[0];
  st.toast(text, 'ok', latest ? { label: 'Undo', run: () => useStore.getState().undoChange(latest.id) } : undefined);
}

export function SimpleReview() {
  const { cat, catBusy, goto } = useStore();
  const eyebrow = useEyebrow('review');
  const unsorted = useQueue(() => engine().uncategorisedQueue(200));
  const deals = useQueue(() => engine().dealQueue(200));
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const groups = (unsorted?.groups ?? []).filter((g) => !skipped.has(`g${g.sigIdx}`));
  const questions = buildLoanQuestions(deals).filter((q) => !skipped.has(q.key));
  if (!cat) return null;
  const allDone = groups.length === 0 && questions.length === 0;
  const skip = (k: string) => setSkipped(new Set([...skipped, k]));
  return (
    <div className="page narrow">
      <PageHead eyebrow={eyebrow} title="Check the sorting">
        We’ve sorted almost everything automatically. Help us with the few items we weren’t sure about — biggest amounts first.
      </PageHead>

      <div className="progress-card">
        <div>
          <div className="pc-big">{pct(cat.valueCategorisedPct)}</div>
          <div className="pc-label">of your money is sorted</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="meter" style={{ height: 12 }}><div style={{ width: `${cat.valueCategorisedPct * 100}%`, background: 'linear-gradient(90deg,#2dd4a8,#28a745)' }} /></div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {allDone ? 'Nothing left to check — well done.' : <>{groups.length > 0 && <><strong className="navy">{groups.length}</strong> item{groups.length > 1 ? 's' : ''} to sort</>}{groups.length > 0 && questions.length > 0 && ' · '}{questions.length > 0 && <><strong className="navy">{questions.length}</strong> possible loan{questions.length > 1 ? 's' : ''} to confirm</>}. You don’t have to do them all — small amounts make little difference.</>}
          </div>
        </div>
        {catBusy && <span className="spinner" title="Updating" />}
      </div>

      {useStore.getState().advanced && <RegisterNote />}

      {allDone ? (
        <div className="card done-card fade">
          <div className="done-head"><i className="bi bi-check-circle-fill" /><div><h2>All checked</h2><p>Every transaction is sorted, and loans and investments are set aside. Your decisions are remembered for next time.</p></div></div>
          <div className="done-next"><span className="muted">Next, see how your cash has behaved over the years.</span><button className="btn primary lg" onClick={() => goto('history')}>Next: look back <i className="bi bi-arrow-right" /></button></div>
        </div>
      ) : (
        <>
          {groups.length > 0 && (
            <section className="review-sec">
              <h3>Items we couldn’t sort <span className="muted">({groups.length})</span></h3>
              <p className="small muted">Choose what each one is and click <strong>Save</strong>. Not sure? Click <strong>Skip</strong>.</p>
              <div className="stack" style={{ gap: 12 }}>{groups.slice(0, 12).map((g) => <SortCard key={g.sigIdx} g={g} onSkip={() => skip(`g${g.sigIdx}`)} />)}
                {groups.length > 12 && <div className="small muted center">Showing the 12 largest. More appear as you go.</div>}</div>
            </section>
          )}
          {questions.length > 0 && (
            <section className="review-sec">
              <h3>Possible loans or investments <span className="muted">({questions.length})</span></h3>
              <p className="small muted">Loans and investments are left out of the forecast. Is each of these one? The reason we’re asking is under each.</p>
              <div className="stack" style={{ gap: 12 }}>{questions.slice(0, 12).map((q) => <LoanCard key={q.key} q={q} onSkip={() => skip(q.key)} />)}</div>
            </section>
          )}
          <StepFooter nextLabel={allDone ? 'Next: look back' : 'Done for now — next: look back'} />
        </>
      )}
    </div>
  );
}

/** What matching to the deal register did, and anything in the register the bank didn’t show. */
function RegisterNote() {
  const m = useStore((s) => s.cat?.registerMatch);
  if (!m) return null;
  const miss = m.unmatched;
  return (
    <div className="callout navy mb small">
      <i className="bi bi-journal-check" /> <strong>{int(m.matched)} bank lines matched to your deal register</strong> ({money(m.matchedAbs)}), so these loans, investments and interest are set aside with certainty.
      {miss.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary>{miss.length} register item{miss.length > 1 ? 's' : ''} over £10k weren’t found in the bank files</summary>
          <p className="xs muted" style={{ margin: '6px 0' }}>Usually interest paid on a slightly different date or amount, a deal settled through another account, or a date to correct in the register. Nothing to do here unless the amounts are large.</p>
          <ul className="list-plain xs">{miss.slice(0, 12).map((u, i) => <li key={i} className="row tight"><span style={{ width: 90 }} className="muted">{day(u.day)}</span><span style={{ width: 90 }} className="num"><Money v={u.amount} /></span><span>{u.label}</span></li>)}</ul>
          {miss.length > 12 && <div className="xs muted">…and {miss.length - 12} more.</div>}
        </details>
      )}
    </div>
  );
}

export function SortCard({ g, onSkip }: { g: ReviewGroup; onSkip: () => void }) {
  const { team, addRule } = useStore();
  const guess = g.catIdx >= 0 ? useStore.getState().cat?.catIds[g.catIdx] ?? '' : '';
  const [catId, setCatId] = useState(guess);
  const save = () => {
    const c = team.categories.find((x) => x.id === catId);
    if (!c) return;
    addRule({ type: 'alias', pattern: g.signature, categoryId: c.id, dealFlag: c.group === 'treasury' ? 'deal' : 'not_deal', confidence: 'high' }, `“${g.signature}” → ${c.name} (${g.count} lines)`);
    confirmWithUndo(`Saved: ${g.count} transaction${g.count > 1 ? 's' : ''} → ${c.name}`);
  };
  const dir = g.direction === 'in' ? 'coming in' : g.direction === 'out' ? 'going out' : 'in and out';
  return (
    <div className="sort-card tick-in">
      <div className="sc-main">
        <div className="sc-desc">{g.samples[0]}</div>
        <div className="sc-meta">
          {int(g.count)} transaction{g.count > 1 ? 's' : ''} {dir}
          {g.cadence && CADENCE_WORDS[g.cadence] ? `, ${CADENCE_WORDS[g.cadence]}` : ''} · {monthYear(g.firstDay)}{g.lastDay !== g.firstDay ? ` to ${monthYear(g.lastDay)}` : ''}
        </div>
      </div>
      <div className="sc-amount"><Money v={g.total} /><div className="xs muted">in total</div></div>
      <div className="sc-actions">
        <span className="sc-q">What is this?</span>
        <FriendlySelect value={catId} onChange={setCatId} categories={team.categories} label={`Category for ${g.samples[0]}`} />
        {guess && catId === guess && <span className="badge soft" title="Picked by the tool — change it if it’s wrong">our best guess</span>}
        <button className="btn primary" disabled={!catId} onClick={save}>Save</button>
        <button className="btn ghost" onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ loan questions

interface LoanQ { key: string; signature: string; title: string; rows: TxnRow[]; count: number; amount: number; why: string; catId: string; isGroup: boolean }

function whyRow(r: TxnRow): string {
  if (r.flags & F_LOAN_PAIR) return 'The same amount came back (or went out again) later, plus a little extra — the way loans and deposits look.';
  if (r.flags & F_INTEREST_LIKE) return 'The exact same amount is paid every six months, which is typical of interest on a loan.';
  if ((r.flags & F_COUNCIL) && (r.flags & F_ROUND)) return 'Large round sums to or from another council — councils often lend to each other.';
  if (r.flags & F_COUNCIL) return 'Large amounts to or from another council — it could be a loan or a recharge.';
  if (r.flags & F_ROUND) return 'Large, round amounts, which is typical of loans and deposits.';
  if (r.flags & (F_LARGE | F_SINGLE)) return 'An unusually large amount that only happened once.';
  return 'The pattern looks like borrowing or an investment.';
}

/** One question per description, so a set of similar transactions is answered in one go. */
function buildLoanQuestions(d: DealQueue | null): LoanQ[] {
  if (!d) return [];
  const bySig = new Map<string, LoanQ>();
  const add = (sig: string, title: string, rows: TxnRow[], amount: number, why: string, catId: string) => {
    const q = bySig.get(sig);
    if (q) { q.rows.push(...rows); q.count += rows.length; q.amount += amount; return; }
    bySig.set(sig, { key: `s${sig}`, signature: sig, title, rows: [...rows], count: rows.length, amount, why, catId, isGroup: false });
  };
  // Only ask about lines that aren't already confidently identified
  const unsure = (r: TxnRow) => r.deal === 2 || (r.deal === 0 && ((r.flags & F_DEAL_LIKE_OP) || r.conf === 0));
  for (const p of d.pairs) {
    const legs = [p.first, p.second].filter(unsure);
    if (!legs.length) continue;
    add(legs[0].signature, legs[0].narrative, legs, Math.abs(legs[0].amount), whyRow(legs[0]), p.first.amount > 0 ? 'la_loans' : 'bank_deposits');
  }
  for (const r of d.dealLike) if (unsure(r)) add(r.signature, r.narrative, [r], Math.abs(r.amount), whyRow(r), r.amount > 0 ? 'la_loans' : 'bank_deposits');
  for (const g of d.groups) {
    if (g.deal !== 2) continue; // only suspected groups need a human
    const q = bySig.get(g.signature);
    if (q) { q.isGroup = true; q.count = Math.max(q.count, g.count); q.amount = Math.max(q.amount, g.abs); continue; }
    bySig.set(g.signature, { key: `s${g.signature}`, signature: g.signature, title: g.samples[0], rows: [], count: g.count, amount: g.abs, isGroup: true,
      why: g.flags & F_LOAN_PAIR ? whyRow({ flags: F_LOAN_PAIR } as TxnRow) : g.flags & F_ROUND ? whyRow({ flags: F_ROUND } as TxnRow) : g.flags & F_INTEREST_LIKE ? whyRow({ flags: F_INTEREST_LIKE } as TxnRow) : 'The pattern looks like borrowing or an investment.',
      catId: useStore.getState().cat?.catIds[g.catIdx] ?? 'la_loans' });
  }
  return [...bySig.values()].sort((a, b) => b.amount - a.amount);
}

function LoanCard({ q, onSkip }: { q: LoanQ; onSkip: () => void }) {
  const { addTxnOverrides, addRule, team } = useStore();
  const [no, setNo] = useState(false);
  const [catId, setCatId] = useState('');
  // A specific description (not a generic "TRF REF") can safely become a permanent rule.
  const specific = /[A-Z]{4,}/.test(q.signature.replace(/\b(TRF|REF|CHAPS|BACS|FPS|INT|PAYMENT)\b/g, ''));
  const yes = () => {
    if (specific || q.isGroup) addRule({ type: 'alias', pattern: q.signature, categoryId: q.catId, dealFlag: 'deal', confidence: 'high' }, `“${q.signature}” is a loan/investment`);
    else addTxnOverrides(q.rows.map((r) => ({ key: r.key, categoryId: q.catId, dealFlag: 'deal' as const })), `${q.count} × “${q.signature}” confirmed as loan/investment`);
    confirmWithUndo('Confirmed as a loan or investment — kept out of the forecast.');
  };
  const notLoan = () => {
    const c = team.categories.find((x) => x.id === catId);
    if (!c) return;
    if (specific || q.isGroup) addRule({ type: 'alias', pattern: q.signature, categoryId: c.id, dealFlag: 'not_deal', confidence: 'high' }, `“${q.signature}” → ${c.name}`);
    else addTxnOverrides(q.rows.map((r) => ({ key: r.key, categoryId: c.id, dealFlag: 'not_deal' as const })), `${q.count} × “${q.signature}” → ${c.name}`);
    confirmWithUndo(`Saved as ${c.name} — included in the forecast.`);
  };
  return (
    <div className="sort-card loan tick-in">
      <div className="sc-main">
        <div className="sc-desc">{q.title}</div>
        <div className="sc-meta">{q.count > 1 ? `${int(q.count)} similar transactions` : q.rows[0] ? day(q.rows[0].day) : ''}</div>
        <div className="sc-why"><i className="bi bi-question-circle" /> {q.why}</div>
      </div>
      <div className="sc-amount"><div className="num" style={{ fontWeight: 700, fontSize: 18, color: 'var(--pt-navy)' }}>{money(q.amount)}</div><div className="xs muted">{q.count > 1 ? 'in total' : ''}</div></div>
      <div className="sc-actions">
        {!no ? (
          <>
            <span className="sc-q">Is this a loan or investment?</span>
            <button className="btn navy" onClick={yes}>Yes</button>
            <button className="btn" onClick={() => setNo(true)}>No, it’s everyday money</button>
            <button className="btn ghost" onClick={onSkip}>Not sure</button>
          </>
        ) : (
          <>
            <span className="sc-q">What is it then?</span>
            <FriendlySelect value={catId} onChange={setCatId} categories={team.categories.filter((c) => c.group !== 'treasury')} label="Category" />
            <button className="btn primary" disabled={!catId} onClick={notLoan}>Save</button>
            <button className="btn ghost" onClick={() => setNo(false)}>Back</button>
          </>
        )}
      </div>
    </div>
  );
}
