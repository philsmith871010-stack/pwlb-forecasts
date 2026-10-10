import { useEffect, useMemo, useState } from 'react';
import { useStore, useEyebrow } from '../../state/store';
import { SimpleReview } from './SimpleReview';
import { PageHead, Panel, StepFooter, Modal, CategorySelect, CatBadge, catByIdx, Empty, Money, Seg, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { engine } from '../../worker/client';
import type { ReviewGroup, DealQueue, TxnRow } from '../../worker/types';
import { money, pct, day, int } from '../../lib/format';
import { FLAG_LABELS, F_OUTLIER, F_SINGLE } from '../../lib/categorise/engine';
import type { Category } from '../../lib/categories';
import type { DealFlag, TxnOverride } from '../../lib/model';

export function ReviewStep({ embedded }: { embedded?: boolean }) {
  const advanced = useStore((s) => s.advanced);
  if (!advanced && !embedded) return <SimpleReview />;
  return <AdvancedReview embedded={embedded} />;
}

function AdvancedReview({ embedded }: { embedded?: boolean }) {
  const { cat, sessionChanges, catBusy } = useStore();
  const tabs: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'uncat', label: 'Not yet sorted', badge: cat ? cat.uncategorisedRows + cat.lowConfRows || '✓' : '' },
    { id: 'deal', label: 'Loans & investments', badge: cat && cat.suspectedRows + cat.dealLikeOpRows ? cat.suspectedRows + cat.dealLikeOpRows : '' },
    { id: 'outliers', label: 'Unusual amounts', badge: cat?.outlierRows || '' },
    { id: 'decisions', label: 'Your decisions', badge: sessionChanges.length || '' },
  ];
  const [tab, setTab] = useStepTab('review', tabs);
  if (!cat) return <div className="page"><Empty icon="bi-ui-checks" title="Nothing to review yet">Load and categorise data first.</Empty></div>;
  const body = (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}><StepTabs tabs={tabs} value={tab} onChange={setTab} /></div>
        {catBusy && <span className="small muted row tight" style={{ marginTop: 14 }}><span className="spinner" /> updating…</span>}
      </div>
      {tab === 'overview' && <ReviewOverview go={setTab} />}
      {tab === 'uncat' && <>
        <Explain
          what="Transactions no rule recognised, grouped by their description so similar lines sit together. Biggest money first."
          why="Unsorted money can’t be forecast properly. Because lines are grouped, one click often sorts dozens or hundreds at once."
          todo={<>For each group, pick a category and click <strong>Assign</strong>. Not sure? <strong>Skip</strong> it — small amounts make little difference.</>} />
        <UncatQueue />
        <NextTab label="Next: loans & investments" onClick={() => setTab('deal')} />
      </>}
      {tab === 'deal' && <>
        <Explain
          what="Everything we think is borrowing or investment: PWLB, loans to and from other councils, money market funds, deposits — and any large lines that look similar."
          why={<>These are <strong>left out of the forecast</strong>. The forecast shows your day-to-day cash, so you can see when you’ll <em>need</em> to borrow or can invest. A loan counted as ordinary income would hide a borrowing need.</>}
          todo={<>Confirm the suspected ones (or say they’re not loans). Pay most attention to the <strong>“Large items to check”</strong> view.</>} />
        <DealQueueView />
        <NextTab label="Next: unusual amounts" onClick={() => setTab('outliers')} />
      </>}
      {tab === 'outliers' && <>
        <Explain
          what="Very large payments or receipts inside normally regular categories — e.g. a £12m one-off grant among routine £1m grants."
          why="If a one-off spike were treated as normal, the forecast would expect it to happen again every year. We’ve set these aside as one-off: kept in history, left out of the pattern."
          todo={<>Only change one if it <strong>will</strong> happen again — then click <strong>Recurring</strong>.</>} />
        <OutlierQueue />
        <NextTab label="See your decisions" onClick={() => setTab('decisions')} />
      </>}
      {tab === 'decisions' && <>
        <Explain compact what="Every confirmation you made this session. Each one became a rule or decision in your saved work." why="Next time anyone loads data, these are applied automatically." todo="Use Undo if you made a mistake. Remember to save the team file at the end." />
        <Decisions />
        {!embedded && <StepFooter nextLabel="See the historic analysis" />}
      </>}
    </>
  );
  if (embedded) return body;
  return (
    <div className="page">
      <PageHead eyebrow={useEyebrow('review')} title="Check the sorting">
        A few quick confirmations, largest money first. You’re confirming, not doing data entry.
      </PageHead>
      {body}
    </div>
  );
}

function ReviewOverview({ go }: { go: (t: string) => void }) {
  const { cat } = useStore();
  if (!cat) return null;
  const items = [
    { id: 'uncat', icon: 'bi-question-circle', title: 'Not yet sorted', n: cat.uncategorisedRows + cat.lowConfRows, money: cat.uncategorisedAbs + cat.lowConfAbs, text: 'Lines no rule recognised, or recognised only weakly.', doneText: 'Everything is sorted.' },
    { id: 'deal', icon: 'bi-bank', title: 'Loans & investments to confirm', n: cat.suspectedRows + cat.dealLikeOpRows, money: cat.suspectedAbs + cat.dealLikeOpAbs, text: 'Suspected borrowing/investment flows, and large lines that might be.', doneText: 'All loans and investments confirmed.' },
    { id: 'outliers', icon: 'bi-exclamation-diamond', title: 'Unusual amounts', n: cat.outlierRows, money: 0, text: 'Large one-offs set aside from the regular pattern — just check you agree.', doneText: 'No unusual amounts.' },
  ];
  return (
    <>
      <Explain
        what="Three short lists of things we’d like a human to confirm. Everything else has already been sorted with confidence."
        why="This is the step that makes the forecast trustworthy — especially making sure no loans or investments are counted as everyday cash."
        todo="Work through the three lists in order. Each shows the biggest money first, so you can stop when what’s left is small." />
      <div className="card card-pad mb">
        <div className="row"><strong className="navy">{pct(cat.valueCategorisedPct)} of all money is sorted</strong><span className="spacer" /><span className="small muted">{money(cat.treasuryAbs)} identified as loans & investments</span></div>
        <div className="meter mt"><div style={{ width: `${cat.valueCategorisedPct * 100}%`, background: 'linear-gradient(90deg,#2dd4a8,#28a745)' }} /></div>
      </div>
      <div className="stack">
        {items.map((it, i) => (
          <div key={it.id} className={`queue-card ${it.n ? '' : 'done'}`}>
            <div className="qi"><i className={`bi ${it.n ? it.icon : 'bi-check-lg'}`} /></div>
            <div style={{ flex: 1 }}>
              <strong className="navy">{i + 1}. {it.title}</strong>
              <div className="small muted">{it.n ? it.text : it.doneText}</div>
            </div>
            {it.n > 0 && <div className="num"><div className="big-number" style={{ fontSize: 22 }}>{int(it.n)}</div><div className="xs muted">lines{it.money ? ` · ${money(it.money)}` : ''}</div></div>}
            <button className={`btn ${it.n ? 'primary' : ''}`} onClick={() => go(it.id)}>{it.n ? 'Start' : 'View'} <i className="bi bi-arrow-right" /></button>
          </div>
        ))}
      </div>
    </>
  );
}

function Decisions() {
  const { sessionChanges, undoChange } = useStore();
  if (!sessionChanges.length) return <div className="card card-pad small muted">No decisions yet this session.</div>;
  return (
    <Panel title="Decisions this session" sub={`${sessionChanges.length}`}>
      <ul className="list-plain small">
        {sessionChanges.map((c) => (
          <li key={c.id} className="row tight tick-in">
            <i className={`bi ${c.kind === 'rule' ? 'bi-signpost' : c.kind === 'alias' ? 'bi-link-45deg' : 'bi-check2-square'} orange`} />
            <span style={{ flex: 1 }}>{c.label}</span>
            <span className="xs muted">{new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            <button className="btn sm ghost" onClick={() => undoChange(c.id)}><i className="bi bi-arrow-counterclockwise" /> Undo</button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ uncategorised

function useQueue<T>(fn: () => Promise<T>): T | null {
  const catVersion = useStore((s) => s.catVersion);
  const [v, setV] = useState<T | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { let live = true; void fn().then((x) => { if (live) setV(x); }); return () => { live = false; }; }, [catVersion]);
  return v;
}

function UncatQueue() {
  const data = useQueue(() => engine().uncategorisedQueue(400));
  const cat = useStore((s) => s.cat);
  const [shown, setShown] = useState(25);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  if (!data || !cat) return <div className="card card-pad"><span className="spinner" /> Loading queue…</div>;
  const groups = data.groups.filter((g) => !hidden.has(g.sigIdx));
  const pctDone = cat.valueCategorisedPct;
  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="row"><strong className="navy">{pct(pctDone)} of all money is sorted</strong><span className="muted small">· {groups.length} groups left, largest first</span></div>
        <div className="meter mt"><div style={{ width: `${pctDone * 100}%`, background: 'linear-gradient(90deg,#2dd4a8,#28a745)' }} /></div>
      </div>
      {groups.length === 0 && <div className="callout green"><strong>All clear.</strong> Every line is categorised with at least medium confidence.</div>}
      {groups.slice(0, shown).map((g) => <GroupCard key={g.sigIdx} g={g} onIgnore={() => setHidden(new Set([...hidden, g.sigIdx]))} />)}
      {groups.length > shown && <button className="btn" onClick={() => setShown(shown + 25)}>Show 25 more ({groups.length - shown} remaining)</button>}
    </div>
  );
}

function GroupCard({ g, onIgnore, dealMode }: { g: ReviewGroup; onIgnore?: () => void; dealMode?: boolean }) {
  const { team, addRule, cat } = useStore();
  const categories = team.categories;
  const current = catByIdx(categories, cat?.catIds ?? [], g.catIdx);
  const [catId, setCatId] = useState(current?.id ?? '');
  const [ruleOpen, setRuleOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const assign = (cid: string, deal?: DealFlag) => {
    const c = categories.find((x) => x.id === cid);
    if (!c) return;
    addRule({ type: 'alias', pattern: g.signature, categoryId: cid, dealFlag: deal ?? (c.group === 'treasury' ? 'deal' : 'not_deal'), confidence: 'high' },
      `“${g.signature}” → ${c.name}${deal === 'deal' || c.group === 'treasury' ? ' (deal)' : ''} · ${g.count} lines`);
  };
  return (
    <div className="group-card tick-in">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row tight">
            <span className="sig">{g.signature}</span>
            {g.cadence && <span className="badge green"><i className="bi bi-arrow-repeat" /> {g.cadence.replace('_', '-')}</span>}
            {g.deal === 2 && <span className="badge amber">suspected deal</span>}
            {g.deal === 1 && <span className="badge navy">deal</span>}
            {FLAG_LABELS.filter(([f]) => g.flags & f).slice(0, 3).map(([f, l]) => <span key={f} className="badge grey">{l}</span>)}
          </div>
          <div className="sample mt" style={{ marginTop: 4 }}>{g.samples.slice(0, 3).join('  ·  ')}</div>
          <div className="xs muted" style={{ marginTop: 4 }}>{int(g.count)} lines · {day(g.firstDay)} – {day(g.lastDay)} · money {g.direction} · {current ? <>currently <strong>{current.name}</strong> ({g.rule})</> : 'no rule matched'}</div>
        </div>
        <div className="num" style={{ minWidth: 110 }}><div className="big-number" style={{ fontSize: 20 }}><Money v={g.total} /></div><div className="xs muted">{money(g.abs)} gross</div></div>
      </div>
      <div className="row mt" style={{ marginTop: 10 }}>
        <div style={{ width: 240 }}><CategorySelect small value={catId} onChange={setCatId} categories={categories} allowNone="Choose a category…" /></div>
        {dealMode ? (
          <>
            <button className="btn sm navy" disabled={!catId} onClick={() => assign(catId, 'deal')}><i className="bi bi-check2" /> Yes, loan/investment</button>
            <button className="btn sm" disabled={!catId || categories.find((c) => c.id === catId)?.group === 'treasury'} onClick={() => assign(catId, 'not_deal')} title="Choose an everyday category first">No — everyday cash</button>
          </>
        ) : (
          <button className="btn sm primary" disabled={!catId} onClick={() => assign(catId)}><i className="bi bi-check2" /> Assign all {g.count}</button>
        )}
        <button className="btn sm" onClick={() => setRuleOpen(true)}><i className="bi bi-signpost" /> Make a rule…</button>
        <button className="btn sm ghost" onClick={() => setSplitOpen(true)}><i className="bi bi-scissors" /> Different categories…</button>
        {onIgnore && <button className="btn sm ghost" onClick={onIgnore} title="Hide this group for now; it stays uncategorised">Skip</button>}
      </div>
      {ruleOpen && <RuleModal g={g} onClose={() => setRuleOpen(false)} initialCat={catId} />}
      {splitOpen && <SplitModal g={g} onClose={() => setSplitOpen(false)} />}
    </div>
  );
}

function RuleModal({ g, onClose, initialCat }: { g: ReviewGroup; onClose: () => void; initialCat: string }) {
  const { team, addRule } = useStore();
  const words = g.signature.split(' ').filter((w) => /[A-Z]{3,}/.test(w) && !['BACS', 'CHAPS', 'FPS', 'TRF', 'REF', 'PAYMENT'].includes(w));
  const [pattern, setPattern] = useState(words.slice(0, 2).join(' ') || g.signature);
  const [catId, setCatId] = useState(initialCat);
  const [direction, setDirection] = useState<'any' | 'in' | 'out'>(g.direction === 'mixed' ? 'any' : g.direction);
  const [minAmount, setMin] = useState('');
  const [oneOff, setOneOff] = useState(false);
  const c = team.categories.find((x) => x.id === catId);
  const valid = pattern.trim().length >= 2 && !!c;
  return (
    <Modal title="Create a rule" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!valid} onClick={() => { addRule({ type: 'contains', pattern: pattern.trim().toUpperCase(), categoryId: catId, direction, minAmount: minAmount ? +minAmount : undefined, dealFlag: c!.group === 'treasury' ? 'deal' : 'not_deal', classification: oneOff ? 'one_off' : undefined }, `anything containing “${pattern.trim().toUpperCase()}” → ${c!.name}`); onClose(); }}>Create rule</button></>}>
      <p className="small muted">Rules match the cleaned narrative (upper case, reference numbers removed). Your team’s rules always win over the starter rules.</p>
      <div className="grid g2">
        <div className="field"><label>Anything containing</label><input className="input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} /></div>
        <div className="field"><label>Goes to</label><CategorySelect value={catId} onChange={setCatId} categories={team.categories} allowNone="Choose…" /></div>
        <div className="field"><label>Only when money is</label><select className="select" value={direction} onChange={(e) => setDirection(e.target.value as 'any')}><option value="any">in or out</option><option value="in">in</option><option value="out">out</option></select></div>
        <div className="field"><label>Minimum amount (optional, £)</label><input className="input" type="number" value={minAmount} onChange={(e) => setMin(e.target.value)} /></div>
      </div>
      <label className="check mt"><input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} /> Treat matches as one-off (history only, not the seasonal profile)</label>
      <div className="callout navy mt small">Example match: <span className="mono">{g.signature}</span></div>
    </Modal>
  );
}

function SplitModal({ g, onClose }: { g: ReviewGroup; onClose: () => void }) {
  const { team, addTxnOverrides, cat } = useStore();
  const [rows, setRows] = useState<TxnRow[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  useEffect(() => { void engine().rowsForSignature(g.sigIdx, 500).then(setRows); }, [g.sigIdx]);
  const n = Object.values(choice).filter(Boolean).length;
  return (
    <Modal wide title={`Split “${g.signature}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!n} onClick={() => {
        addTxnOverrides(Object.entries(choice).filter(([, v]) => v).map(([key, categoryId]) => ({ key, categoryId, dealFlag: team.categories.find((c) => c.id === categoryId)?.group === 'treasury' ? 'deal' : 'not_deal' })), `Split “${g.signature}”: ${n} lines assigned`);
        onClose();
      }}>Apply to {n} line{n === 1 ? '' : 's'}</button></>}>
      {!rows ? <span className="spinner" /> : (
        <div className="tbl-wrap" style={{ maxHeight: 520 }}>
          <table className="tbl">
            <thead><tr><th>Date</th><th>Narrative</th><th className="num">Amount</th><th>Now</th><th>Assign to</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}><td className="xs">{day(r.day)}</td><td className="mono xs">{r.narrative}</td><td className="num"><Money v={r.amount} /></td>
                <td><CatBadge cat={catByIdx(team.categories, cat?.catIds ?? [], r.catIdx)} uncategorised={r.catIdx < 0} /></td>
                <td style={{ width: 220 }}><CategorySelect small value={choice[r.key] ?? ''} onChange={(v) => setChoice({ ...choice, [r.key]: v })} categories={team.categories} allowNone="(leave)" /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ treasury

function DealQueueView() {
  const data = useQueue<DealQueue>(() => engine().dealQueue(300));
  const [shown, setShown] = useState(20);
  const [view, setView] = useState<'check' | 'pairs' | 'groups'>('check');
  if (!data) return <div className="card card-pad"><span className="spinner" /> Loading…</div>;
  return (
    <div className="stack">
      <div className="row">
        <Seg value={view} onChange={setView} options={[
          { v: 'check', label: `Large items to check (${data.dealLike.length})` },
          { v: 'pairs', label: `Loan patterns (${data.pairs.length})` },
          { v: 'groups', label: `All loans & investments (${data.groups.length})` },
        ]} />
        <span className="spacer" />
        <span className="small muted">Kept out of the forecast: <strong className="navy">{money(data.excludedAbs)}</strong>, of which <strong className="navy">{money(data.suspectedAbs)}</strong> only suspected</span>
      </div>
      {view === 'check' && <>
        <p className="small muted" style={{ margin: 0 }}>Large or irregular lines currently counted as everyday cash. If any is really a loan, deposit or investment, choose its type and click <strong>Loan/investment</strong>; otherwise click <strong>Everyday cash</strong>.</p>
        {data.dealLike.length ? <DealLike rows={data.dealLike} /> : <div className="callout green">Nothing large and loan-like is left in the everyday figures.</div>}
      </>}
      {view === 'pairs' && <>
        <p className="small muted" style={{ margin: 0 }}>Money that arrived and went back out later (or the reverse) for the same amount plus a little interest — the classic shape of a loan or deposit. Tick and confirm them in bulk.</p>
        {data.pairs.length ? <LoanPairs pairs={data.pairs} /> : <div className="callout green">No unconfirmed loan patterns.</div>}
      </>}
      {view === 'groups' && <>
        <p className="small muted" style={{ margin: 0 }}>Everything currently kept out of the forecast, grouped by description. Confirm a group to make it a permanent rule, or mark it as not a loan.</p>
        {data.groups.slice(0, shown).map((g) => <GroupCard key={g.sigIdx} g={g} dealMode />)}
        {data.groups.length > shown && <button className="btn" onClick={() => setShown(shown + 20)}>Show more ({data.groups.length - shown})</button>}
      </>}
    </div>
  );
}

function LoanPairs({ pairs }: { pairs: DealQueue['pairs'] }) {
  const { addTxnOverrides, team } = useStore();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const name = (r: TxnRow) => r.narrative;
  const confirm = (idx: number[], deal: boolean) => {
    const os = idx.flatMap((k): TxnOverride[] => {
      const p = pairs[k];
      const cid = p.first.amount > 0 ? 'la_loans' : 'bank_deposits';
      return deal ? [p.first, p.second].map((r) => ({ key: r.key, categoryId: team.categories.some((c) => c.id === cid) ? cid : undefined, dealFlag: 'deal' as const }))
        : [p.first, p.second].map((r) => ({ key: r.key, dealFlag: 'not_deal' as const }));
    });
    addTxnOverrides(os, `${deal ? 'Confirmed' : 'Rejected'} ${idx.length} loan pattern${idx.length > 1 ? 's' : ''}`);
    setSel(new Set());
  };
  return (
    <Panel title="Suspected loan pairs" sub="money in, the same (plus interest) out again later — or the reverse"
      right={<><button className="btn sm on-dark" disabled={!sel.size} onClick={() => confirm([...sel], true)}>Confirm {sel.size || ''} as deals</button></>} flush>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th><input type="checkbox" aria-label="Select all" checked={sel.size === pairs.length} onChange={(e) => setSel(e.target.checked ? new Set(pairs.map((_, i) => i)) : new Set())} /></th><th>First leg</th><th className="num">Amount</th><th>Second leg</th><th className="num">Amount</th><th className="num">Days</th><th className="num">Implied rate</th><th /></tr></thead>
          <tbody>{pairs.map((p, i) => (
            <tr key={i} className={sel.has(i) ? 'sel' : ''}>
              <td><input type="checkbox" aria-label="Select pair" checked={sel.has(i)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(i); else s.delete(i); setSel(s); }} /></td>
              <td><div className="mono xs">{name(p.first)}</div><div className="xs muted">{day(p.first.day)}</div></td><td className="num"><Money v={p.first.amount} /></td>
              <td><div className="mono xs">{name(p.second)}</div><div className="xs muted">{day(p.second.day)}</div></td><td className="num"><Money v={p.second.amount} /></td>
              <td className="num">{p.days}</td><td className="num">{pct(p.impliedRate, 2)}</td>
              <td className="nowrap"><button className="btn sm" onClick={() => confirm([i], true)}>Deal</button> <button className="btn sm ghost" onClick={() => confirm([i], false)}>Not a loan</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function DealLike({ rows }: { rows: TxnRow[] }) {
  const { addTxnOverrides, team, cat } = useStore();
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (!rows.length) return null;
  return (
    <Panel title="Large items counted as everyday cash" sub="are any of these really loans or investments?" flush>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Narrative</th><th>Category</th><th className="num">Amount</th><th>Why</th><th>Decision</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key}>
              <td className="xs">{day(r.day)}</td><td className="mono xs">{r.narrative}</td>
              <td><CatBadge cat={catByIdx(team.categories, cat?.catIds ?? [], r.catIdx)} uncategorised={r.catIdx < 0} /></td>
              <td className="num"><Money v={r.amount} /></td>
              <td className="xs muted">{FLAG_LABELS.filter(([f]) => r.flags & f).map(([, l]) => l).join(', ')}</td>
              <td className="nowrap">
                <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                  <div style={{ width: 170 }}><CategorySelect small value={choice[r.key] ?? ''} onChange={(v) => setChoice({ ...choice, [r.key]: v })} categories={team.categories} groups={['treasury']} allowNone="Which type?" /></div>
                  <button className="btn sm navy" disabled={!choice[r.key]} onClick={() => addTxnOverrides([{ key: r.key, categoryId: choice[r.key], dealFlag: 'deal' }], `${r.narrative.slice(0, 30)} → deal`)}>Loan/investment</button>
                  <button className="btn sm" onClick={() => addTxnOverrides([{ key: r.key, dealFlag: 'not_deal' }], `${r.narrative.slice(0, 30)} confirmed as everyday cash`)}>Everyday cash</button>
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ outliers

function OutlierQueue() {
  const rows = useQueue(() => engine().outlierQueue(300));
  const { addTxnOverrides, team, cat } = useStore();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const categories = team.categories;
  const catOf = useMemo(() => (r: TxnRow): Category | undefined => catByIdx(categories, cat?.catIds ?? [], r.catIdx), [categories, cat]);
  if (!rows) return <div className="card card-pad"><span className="spinner" /> Loading…</div>;
  if (!rows.length) return <div className="callout green">No outliers flagged inside the operational categories.</div>;
  return (
    <div className="stack">
      <div className="callout navy small">Large one-offs sitting inside regular categories would distort the seasonal profile. By default they’re treated as <strong>one-off</strong>: kept in history, left out of the profile. Change that here if they really are part of the normal rhythm.</div>
      <Panel title="Flagged outliers" sub={`${rows.length} items, largest first`} flush>
        <div className="tbl-wrap tall">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Narrative</th><th>Category</th><th className="num">Amount</th><th>Why</th><th>Treated as</th><th>Decision</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}>
                <td className="xs">{day(r.day)}</td><td className="mono xs">{r.narrative}</td>
                <td><CatBadge cat={catOf(r)} /></td><td className="num"><Money v={r.amount} /></td>
                <td className="xs muted">{r.flags & F_OUTLIER ? 'Far outside its normal range' : r.flags & F_SINGLE ? 'Single large occurrence' : 'One-off by rule'}</td>
                <td>{r.oneOff ? <span className="badge soft">One-off</span> : <span className="badge grey">Recurring</span>}</td>
                <td className="nowrap"><div className="row tight" style={{ flexWrap: 'nowrap' }}>
                  <button className={`btn sm ${r.oneOff ? '' : 'navy'}`} onClick={() => addTxnOverrides([{ key: r.key, classification: 'one_off' }], `${r.narrative.slice(0, 28)} → one-off`)}>One-off</button>
                  <button className={`btn sm ${!r.oneOff ? '' : ''}`} onClick={() => addTxnOverrides([{ key: r.key, classification: 'recurring' }], `${r.narrative.slice(0, 28)} → recurring`)}>Recurring</button>
                  <div style={{ width: 160 }}><CategorySelect small value={choice[r.key] ?? ''} onChange={(v) => { setChoice({ ...choice, [r.key]: v }); if (v) addTxnOverrides([{ key: r.key, categoryId: v }], `${r.narrative.slice(0, 28)} → ${categories.find((c) => c.id === v)?.name}`); }} categories={categories} allowNone="Recategorise…" /></div>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
