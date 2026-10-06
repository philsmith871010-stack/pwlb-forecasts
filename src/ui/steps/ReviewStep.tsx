import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, StepFooter, Modal, CategorySelect, CatBadge, catByIdx, Kpi, Empty, Money } from '../components/common';
import { engine } from '../../worker/client';
import type { ReviewGroup, DealQueue, TxnRow } from '../../worker/types';
import { money, pct, day, int } from '../../lib/format';
import { FLAG_LABELS, F_OUTLIER, F_SINGLE } from '../../lib/categorise/engine';
import type { Category } from '../../lib/categories';
import type { DealFlag, TxnOverride } from '../../lib/model';

type Tab = 'uncat' | 'deal' | 'outliers';

export function ReviewStep({ embedded }: { embedded?: boolean }) {
  const { cat, sessionChanges, undoChange, catBusy } = useStore();
  const [tab, setTab] = useState<Tab>('uncat');
  if (!cat) return <div className="page"><Empty icon="bi-ui-checks" title="Nothing to review yet">Load and categorise data first.</Empty></div>;
  const body = (
    <>
      <div className="grid g4 mb">
        <Kpi label="Value categorised" value={pct(cat.valueCategorisedPct)} sub={`${int(cat.uncategorisedRows)} lines to go`} />
        <Kpi label="Treasury excluded" value={money(cat.treasuryAbs)} sub={`${money(cat.suspectedAbs)} suspected, not yet confirmed`} />
        <Kpi label="Deal-like but operational" value={money(cat.dealLikeOpAbs)} sub={`${cat.dealLikeOpRows} lines to check`} />
        <Kpi label="Outliers down-weighted" value={int(cat.outlierRows)} sub="kept in history, out of the profile" />
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'uncat'} className={tab === 'uncat' ? 'on' : ''} onClick={() => setTab('uncat')}><i className="bi bi-question-circle" /> Uncategorised & low confidence</button>
        <button role="tab" aria-selected={tab === 'deal'} className={tab === 'deal' ? 'on' : ''} onClick={() => setTab('deal')}><i className="bi bi-bank" /> Treasury / deal flows</button>
        <button role="tab" aria-selected={tab === 'outliers'} className={tab === 'outliers' ? 'on' : ''} onClick={() => setTab('outliers')}><i className="bi bi-exclamation-diamond" /> Outliers</button>
        <div className="spacer" />
        {catBusy && <span className="small muted row tight"><span className="spinner" /> updating…</span>}
      </div>
      <div className="grid g-side">
        <div>
          {tab === 'uncat' && <UncatQueue />}
          {tab === 'deal' && <DealQueueView />}
          {tab === 'outliers' && <OutlierQueue />}
        </div>
        <Panel title="Decisions this session" sub={`${sessionChanges.length}`}>
          {sessionChanges.length === 0 ? <p className="small muted">Every confirmation becomes a rule or decision in your team file, so the next upload is quicker. They’ll appear here with an undo.</p> : (
            <ul className="list-plain small">
              {sessionChanges.map((c) => (
                <li key={c.id} className="row tight tick-in">
                  <i className={`bi ${c.kind === 'rule' ? 'bi-signpost' : c.kind === 'alias' ? 'bi-link-45deg' : 'bi-check2-square'} orange`} />
                  <span style={{ flex: 1 }}>{c.label}</span>
                  <button className="btn sm ghost" onClick={() => undoChange(c.id)}><i className="bi bi-arrow-counterclockwise" /> Undo</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
  if (embedded) return body;
  return (
    <div className="page">
      <PageHead eyebrow="Step 4 of 8" title="Review — confirm, don’t labour">
        Three short queues, biggest value first, so one click can settle hundreds of lines. The treasury queue matters most: those flows are what we’re forecasting a <em>need</em> for, so they must not leak into the operational model.
      </PageHead>
      {body}
      <StepFooter nextLabel="See the historic analysis" />
    </div>
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
        <div className="row"><strong className="navy">{pct(pctDone)} of value categorised</strong><span className="muted small">· {groups.length} groups to look at, largest first</span></div>
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
            <button className="btn sm navy" disabled={!catId} onClick={() => assign(catId, 'deal')}><i className="bi bi-check2" /> Confirm deal</button>
            <button className="btn sm" disabled={!catId || categories.find((c) => c.id === catId)?.group === 'treasury'} onClick={() => assign(catId, 'not_deal')} title="Choose an operational category first">Not a deal</button>
          </>
        ) : (
          <button className="btn sm primary" disabled={!catId} onClick={() => assign(catId)}><i className="bi bi-check2" /> Assign all {g.count}</button>
        )}
        <button className="btn sm" onClick={() => setRuleOpen(true)}><i className="bi bi-signpost" /> Create rule…</button>
        <button className="btn sm ghost" onClick={() => setSplitOpen(true)}><i className="bi bi-scissors" /> Split</button>
        {onIgnore && <button className="btn sm ghost" onClick={onIgnore}>Ignore</button>}
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
  if (!data) return <div className="card card-pad"><span className="spinner" /> Loading…</div>;
  return (
    <div className="stack">
      <div className="callout navy">
        <strong>These are your borrowing and investment flows.</strong> PWLB, LOBO and council-to-council loans, money market funds, DMADF and bank deposits — principal and interest. They are excluded from the forecast because they are not repeatable operating cash; the forecast exists to show when you’ll need them. Currently excluded: <strong>{money(data.excludedAbs)}</strong> gross, of which <strong>{money(data.suspectedAbs)}</strong> is only suspected.
      </div>
      {data.pairs.length > 0 && <LoanPairs pairs={data.pairs} />}
      <h3 className="mt">Grouped deal lines</h3>
      {data.groups.slice(0, shown).map((g) => <GroupCard key={g.sigIdx} g={g} dealMode />)}
      {data.groups.length > shown && <button className="btn" onClick={() => setShown(shown + 20)}>Show more ({data.groups.length - shown})</button>}
      <DealLike rows={data.dealLike} />
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
    <Panel title="Large or irregular items still in the operational model" sub="check none of these are really deals" flush>
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
                  <div style={{ width: 170 }}><CategorySelect small value={choice[r.key] ?? ''} onChange={(v) => setChoice({ ...choice, [r.key]: v })} categories={team.categories} groups={['treasury']} allowNone="Treasury category…" /></div>
                  <button className="btn sm navy" disabled={!choice[r.key]} onClick={() => addTxnOverrides([{ key: r.key, categoryId: choice[r.key], dealFlag: 'deal' }], `${r.narrative.slice(0, 30)} → deal`)}>Deal</button>
                  <button className="btn sm" onClick={() => addTxnOverrides([{ key: r.key, dealFlag: 'not_deal' }], `${r.narrative.slice(0, 30)} confirmed operational`)}>Operational</button>
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
