import { useEffect, useState, type ReactNode } from 'react';
import { useStore, useEyebrow } from '../../state/store';
import { PageHead, StepFooter, Money, ToMenu } from '../components/common';
import { engine } from '../../worker/client';
import type { ReviewGroup, DealQueue, TxnRow } from '../../worker/types';
import { money, pctDone, day, int } from '../../lib/format';
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

function FriendlySelect({ value, onChange, categories, label, guess }: { value: string; onChange: (v: string) => void; categories: Category[]; label: string; guess?: boolean }) {
  return (
    <select className={`select sm${guess ? ' guess' : ''}`} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} title={guess ? 'Our best guess: change it if it’s wrong' : undefined}>
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
  const { cat, catBusy, team, askConfirm, sortMany } = useStore();
  const eyebrow = useEyebrow('review');
  const unsorted = useQueue(() => engine().uncategorisedQueue(200));
  const deals = useQueue(() => engine().dealQueue(200));
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const questions = buildLoanQuestions(deals).filter((q) => !skipped.has(q.key));
  // a line asked about as a possible loan isn't asked about twice
  const asLoan = new Set(questions.map((q) => q.signature));
  const groups = (unsorted?.groups ?? []).filter((g) => !skipped.has(`g${g.sigIdx}`) && !asLoan.has(g.signature));
  if (!cat) return null;
  const allDone = groups.length === 0 && questions.length === 0;
  const skip = (k: string) => setSkipped(new Set([...skipped, k]));
  const catIds = cat?.catIds ?? [];
  // the shortcuts: every item with a best guess saved as guessed, every possible loan confirmed
  const guessed = groups.filter((g) => g.catIdx >= 0 && team.categories.some((c) => c.id === catIds[g.catIdx]));
  const acceptGuesses = async () => {
    const ok = await askConfirm({ title: guessed.length === 1 ? 'Accept our best guess?' : `Accept all ${guessed.length} best guesses?`, body: `${guessed.length === 1 ? 'It’s' : 'Each is'} saved as the category we guessed, and remembered for next time. You can undo it straight away, or change ${guessed.length === 1 ? 'it' : 'any of them'} later.`, ok: guessed.length === 1 ? 'Accept' : 'Accept all' });
    if (!ok) return;
    sortMany(guessed.map((g) => { const c = team.categories.find((x) => x.id === catIds[g.catIdx])!; return { type: 'alias' as const, pattern: g.signature, categoryId: c.id, dealFlag: c.group === 'treasury' ? 'deal' as const : 'not_deal' as const, confidence: 'high' as const }; }), [], `${guessed.length} best guesses accepted`);
    confirmWithUndo(`Saved ${guessed.length} item${guessed.length === 1 ? '' : 's'} as guessed.`);
  };
  const allLoans = async () => {
    const ok = await askConfirm({ title: questions.length === 1 ? 'Confirm it as a loan or investment?' : `Confirm all ${questions.length} as loans or investments?`, body: 'They’re kept out of the everyday forecast, and remembered for next time. You can undo it straight away. If any is everyday money, answer that one first.', ok: 'Confirm all' });
    if (!ok) return;
    const rules = questions.filter(loanAsRule).map((q) => ({ type: 'alias' as const, pattern: q.signature, categoryId: q.catId, dealFlag: 'deal' as const, confidence: 'high' as const }));
    const overrides = questions.filter((q) => !loanAsRule(q)).flatMap((q) => q.rows.map((r) => ({ key: r.key, categoryId: q.catId, dealFlag: 'deal' as const })));
    sortMany(rules, overrides, `${questions.length} confirmed as loans or investments`);
    confirmWithUndo(`Confirmed ${questions.length} as loans or investments: kept out of the forecast.`);
  };
  return (
    <div className="page narrow">
      <PageHead eyebrow={eyebrow} title="Check the sorting">
        Almost everything is sorted. Check the few we weren’t sure about, biggest first.
      </PageHead>

      <div className="progress-card">
        <div>
          <div className="pc-big">{pctDone(cat.valueCategorisedPct)}</div>
          <div className="pc-label">of your money is sorted</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="meter" style={{ height: 12 }}><div style={{ width: `${cat.valueCategorisedPct * 100}%`, background: 'linear-gradient(90deg,#2dd4a8,#28a745)' }} /></div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {allDone ? 'Nothing left to check. Well done.' : <>{groups.length > 0 && <><strong className="navy">{groups.length}</strong> item{groups.length > 1 ? 's' : ''} to check</>}{groups.length > 0 && questions.length > 0 && ' · '}{questions.length > 0 && <><strong className="navy">{questions.length}</strong> possible loan{questions.length > 1 ? 's' : ''} to confirm</>}. Small amounts make little difference.</>}
          </div>
        </div>
        {catBusy && <span className="spinner" title="Updating" />}
      </div>

      {useStore.getState().advanced && <RegisterNote />}

      {allDone ? (
        <div className="card done-card fade">
          <div className="done-head"><i className="bi bi-check-circle-fill" /><div><h2>All checked</h2><p>Every transaction is sorted, and loans and investments are set aside. Your decisions are remembered for next time.</p></div></div>
          <div className="done-next"><span className="muted">Set up is done. From the main menu you can look back over your history, build a forecast or add the day’s statement.</span><ToMenu label="Done: back to main menu" primary lg /></div>
        </div>
      ) : (
        <>
          {groups.length > 0 && (
            <section className="review-sec">
              <div className="sec-head">
                <div><h3>Items we weren’t sure about <span className="muted">({groups.length})</span></h3>
                  <p className="small muted">Choose what it is, then <strong>Save</strong>. Not sure? <strong>Skip</strong>.</p></div>
                {guessed.length > 0 && <button className="btn sm navy" onClick={() => void acceptGuesses()}><i className="bi bi-check2-all" /> {guessed.length > 1 ? `Accept all ${guessed.length} best guesses` : 'Accept our best guess'}</button>}
              </div>
              <SortTable ask="What is it?">{groups.slice(0, 25).map((g) => <SortCard key={g.sigIdx} g={g} onSkip={() => skip(`g${g.sigIdx}`)} />)}</SortTable>
              {groups.length > 25 && <div className="small muted center mt">Showing the 25 largest. More appear as you go.</div>}
            </section>
          )}
          {questions.length > 0 && (
            <section className="review-sec">
              <div className="sec-head">
                <div><h3>Possible loans or investments <span className="muted">({questions.length})</span></h3>
                  <p className="small muted">They’re left out of the everyday forecast, so it matters which these are. Each says why we’re asking.</p></div>
                <button className="btn sm navy" onClick={() => void allLoans()}><i className="bi bi-check2-all" /> {questions.length > 1 ? `Yes to all ${questions.length}` : 'Yes, it is'}</button>
              </div>
              <SortTable ask="Loan or investment?">{questions.slice(0, 25).map((q) => <LoanCard key={q.key} q={q} onSkip={() => skip(q.key)} />)}</SortTable>
              {questions.length > 25 && <div className="small muted center mt">Showing the 25 largest. More appear as you go.</div>}
            </section>
          )}
          <StepFooter />
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

/** The compact table the items and loan questions sit in: one row each. */
export function SortTable({ ask, children }: { ask: string; children: ReactNode }) {
  return (
    <div className="sort-table" role="table">
      <div className="st-row st-head" role="row"><span role="columnheader">Description</span><span role="columnheader" className="num">Amount</span><span role="columnheader">{ask}</span><span /></div>
      {children}
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
  const dir = g.direction === 'in' ? 'in' : g.direction === 'out' ? 'out' : 'in and out';
  return (
    <div className="st-row tick-in" role="row">
      <div className="st-desc" role="cell">
        <div className="sc-desc" title={g.samples[0]}>{g.samples[0]}</div>
        <div className="sc-meta">{int(g.count)} {dir}{g.cadence && CADENCE_WORDS[g.cadence] ? `, ${CADENCE_WORDS[g.cadence]}` : ''} · {monthYear(g.firstDay)}{g.lastDay !== g.firstDay ? ` to ${monthYear(g.lastDay)}` : ''}</div>
      </div>
      <div className="st-amt num" role="cell"><Money v={g.total} /></div>
      <div className="st-ask" role="cell">
        {guess && catId === guess && <span className="st-guess" title="Our best guess: change it if it’s wrong">guess</span>}
        <FriendlySelect value={catId} onChange={setCatId} categories={team.categories} label={`Category for ${g.samples[0]}`} guess={!!guess && catId === guess} />
      </div>
      <div className="st-act" role="cell">
        <button className="btn sm primary" disabled={!catId} onClick={save}>Save</button>
        <button className="btn sm ghost" onClick={onSkip}>Skip</button>
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

/** A specific description (not a generic "TRF REF") can safely become a permanent rule; else just these lines. */
const loanAsRule = (q: LoanQ) => q.isGroup || /[A-Z]{4,}/.test(q.signature.replace(/\b(TRF|REF|CHAPS|BACS|FPS|INT|PAYMENT)\b/g, ''));

function LoanCard({ q, onSkip }: { q: LoanQ; onSkip: () => void }) {
  const { addTxnOverrides, addRule, team } = useStore();
  const [no, setNo] = useState(false);
  const [catId, setCatId] = useState('');
  const specific = loanAsRule(q);
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
    <div className="st-row loan tick-in" role="row">
      <div className="st-desc" role="cell">
        <div className="sc-desc" title={q.title}>{q.title}</div>
        <div className="sc-meta">{q.count > 1 ? `${int(q.count)} similar · ` : q.rows[0] ? `${day(q.rows[0].day)} · ` : ''}<i className="bi bi-question-circle st-why" title={q.why} /> <span className="st-why-text">{q.why}</span></div>
      </div>
      <div className="st-amt num" role="cell">{money(q.amount)}</div>
      {!no ? (
        <div className="st-ask st-wide" role="cell">
          <button className="btn sm navy" onClick={yes}>Yes</button>
          <button className="btn sm" onClick={() => setNo(true)}>No, everyday money</button>
          <button className="btn sm ghost" onClick={onSkip}>Not sure</button>
        </div>
      ) : (
        <>
          <div className="st-ask" role="cell"><FriendlySelect value={catId} onChange={setCatId} categories={team.categories.filter((c) => c.group !== 'treasury')} label="What is it then?" /></div>
          <div className="st-act" role="cell">
            <button className="btn sm primary" disabled={!catId} onClick={notLoan}>Save</button>
            <button className="btn sm ghost" onClick={() => setNo(false)}>Back</button>
          </div>
        </>
      )}
    </div>
  );
}
