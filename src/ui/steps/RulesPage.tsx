// Set up and train → Your sorting rules: every rule the team has taught the tool, to find, change,
// delete or add, with the lines each one sorts. And the bank file layouts it has learned.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Modal, CategorySelect, CatBadge, Money, StepTabs, useStepTab, TabDef, StepFooter } from '../components/common';
import { engine } from '../../worker/client';
import type { Rule, RuleType } from '../../lib/model';
import { uid } from '../../lib/model';
import type { TxnRow } from '../../worker/types';
import { STARTER_RULES } from '../../lib/categorise/starterRules';
import { ruleProblem } from '../../lib/categorise/engine';
import { money, day, int, ago } from '../../lib/format';

const MATCH: Record<RuleType, string> = { alias: 'is exactly', contains: 'contains', counterparty: 'contains', regex: 'matches the pattern' };

/** "Description contains “DWP HB”, money in, over £1m" */
export function ruleWords(r: Rule): string {
  const cond = [r.direction === 'in' ? 'money in' : r.direction === 'out' ? 'money out' : '', r.minAmount != null ? `at least ${money(r.minAmount)}` : '', r.maxAmount != null ? `at most ${money(r.maxAmount)}` : ''].filter(Boolean);
  return `Description ${MATCH[r.type]} “${r.pattern}”${cond.length ? `, ${cond.join(', ')}` : ''}`;
}

export function RulesPage() {
  const { team, cat } = useStore();
  const tabs: TabDef[] = [
    { id: 'rules', label: 'Sorting rules', icon: 'bi-signpost', badge: team.rules.length || '' },
    { id: 'starter', label: 'Built-in rules', icon: 'bi-box', badge: STARTER_RULES.length },
    { id: 'banks', label: 'Bank file layouts', icon: 'bi-bookmark', badge: team.bankProfiles.length || '' },
  ];
  const [tab, setTab] = useStepTab('rules', tabs);
  const [editing, setEditing] = useState<{ rule: Rule; isNew: boolean } | null>(null);
  const blank = (): Rule => ({ id: uid('rule'), type: 'contains', pattern: '', categoryId: team.categories[0]?.id ?? '', direction: 'any', source: 'team' });
  return (
    <div className="page">
      <PageHead title="Your sorting rules">
        Each time you sort a line, the tool saves a rule, so lines like it are sorted the same way next time. Find any rule here to change or delete it, or add your own.
      </PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} numbered={false} />
      {!cat && <div className="callout navy small mb">Your rules are shown below. To see which lines each one sorts, load statements on <strong>Load statements</strong>: the saved history keeps totals, not the lines.</div>}
      {tab === 'rules' && <TeamRules onEdit={(r) => setEditing({ rule: r, isNew: false })} onAdd={() => setEditing({ rule: blank(), isNew: true })} />}
      {tab === 'starter' && <StarterRules onCopy={(r) => setEditing({ rule: { ...r, id: uid('rule'), source: 'team', hits: undefined }, isNew: true })} />}
      {tab === 'banks' && <BankLayouts />}
      {editing && <RuleEditor rule={editing.rule} isNew={editing.isNew} onClose={() => setEditing(null)} />}
      <StepFooter />
    </div>
  );
}

function TeamRules({ onEdit, onAdd }: { onEdit: (r: Rule) => void; onAdd: () => void }) {
  const { team, updateTeam, askConfirm, toast } = useStore();
  const [q, setQ] = useState('');
  const [catId, setCatId] = useState('');
  const catOf = (id: string) => team.categories.find((c) => c.id === id);
  const list = team.rules.filter((r) => (!catId || r.categoryId === catId) && (!q.trim() || `${r.pattern} ${catOf(r.categoryId)?.name ?? ''} ${r.createdBy ?? ''} ${r.note ?? ''}`.toUpperCase().includes(q.trim().toUpperCase())));
  const remove = async (r: Rule) => {
    const yes = await askConfirm({ title: 'Delete this rule?', body: `${ruleWords(r)} → ${catOf(r.categoryId)?.name ?? r.categoryId}. Lines it sorted will be sorted again without it.`, ok: 'Delete', danger: true });
    if (!yes) return;
    const at = team.rules.findIndex((x) => x.id === r.id);
    updateTeam((t) => ({ ...t, rules: t.rules.filter((x) => x.id !== r.id) }), { recategorise: true });
    toast('Rule deleted.', 'ok', { label: 'Undo', run: () => updateTeam((t) => ({ ...t, rules: [...t.rules.slice(0, at), r, ...t.rules.slice(at)] }), { recategorise: true }) });
  };
  return (
    <Panel title="Your team’s rules" sub={`${int(team.rules.length)} rule${team.rules.length === 1 ? '' : 's'}${list.length !== team.rules.length ? `, ${int(list.length)} shown` : ''}`}
      right={<button className="btn sm on-dark" onClick={onAdd}><i className="bi bi-plus-lg" /> Add a rule</button>} flush>
      <div className="row card-pad" style={{ paddingBottom: 8 }}>
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search rules: words, category or who made it" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rules" />
        <select className="select" value={catId} onChange={(e) => setCatId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {team.categories.filter((c) => team.rules.some((r) => r.categoryId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {!team.rules.length ? <div className="card-pad small muted">No rules yet. Every line you sort on <strong>Check the sorting</strong> becomes a rule here, or add one yourself.</div>
        : !list.length ? <div className="card-pad small muted">No rules match.</div> : (
        <div className="tbl-wrap">
          <table className="tbl rules-tbl">
            <thead><tr><th>Lines where…</th><th>Sorted as</th><th>Made</th><th className="num" title="Lines it sorted when statements were last loaded">Lines sorted</th><th /></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id}>
                <td>{ruleWords(r)}{r.dealFlag === 'deal' && <span className="badge navy" style={{ marginLeft: 6 }}>loan or investment</span>}{r.note && <div className="xs muted">{r.note}</div>}</td>
                <td><CatBadge cat={catOf(r.categoryId)} /></td>
                <td className="xs muted">{[r.createdBy, r.createdAt ? ago(r.createdAt) : ''].filter(Boolean).join(', ') || '—'}{r.editedAt ? <div>changed {r.editedBy ? `by ${r.editedBy}, ` : ''}{ago(r.editedAt)}</div> : null}</td>
                <td className="num">{r.hits != null ? int(r.hits) : '–'}</td>
                <td className="nowrap">
                  <button className="btn sm ghost" onClick={() => onEdit(r)}><i className="bi bi-pencil" /> Change</button>
                  <button className="icon-btn" aria-label={`Delete rule ${r.pattern}`} title="Delete" onClick={() => void remove(r)}><i className="bi bi-trash" /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StarterRules({ onCopy }: { onCopy: (r: Rule) => void }) {
  const { team } = useStore();
  const [q, setQ] = useState('');
  const catOf = (id: string) => team.categories.find((c) => c.id === id);
  const list = STARTER_RULES.filter((r) => !q.trim() || `${r.pattern} ${catOf(r.categoryId)?.name ?? ''}`.toUpperCase().includes(q.trim().toUpperCase()));
  return (
    <Panel title="Built-in rules" sub="common UK council payments, recognised out of the box" flush>
      <div className="card-pad small muted" style={{ paddingBottom: 6 }}>These come with the tool and can’t be changed or deleted. To sort a payment differently, use <strong>Override</strong>: it makes a rule of your own, which always comes first.</div>
      <div className="row card-pad" style={{ paddingTop: 0, paddingBottom: 8 }}><input className="input" style={{ flex: 1 }} placeholder="Search built-in rules" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search built-in rules" /></div>
      <div className="tbl-wrap tall">
        <table className="tbl rules-tbl">
          <thead><tr><th>Lines where…</th><th>Sorted as</th><th /></tr></thead>
          <tbody>{list.map((r) => (
            <tr key={r.id}><td className="small">{ruleWords(r)}</td><td><CatBadge cat={catOf(r.categoryId)} /></td>
              <td><button className="btn sm ghost" onClick={() => onCopy(r)}><i className="bi bi-arrow-repeat" /> Override</button></td></tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Add or change a rule, seeing the lines it would sort before saving. */
function RuleEditor({ rule, isNew, onClose }: { rule: Rule; isNew: boolean; onClose: () => void }) {
  const { team, cat, updateTeam, user, toast, catVersion } = useStore();
  const [r, setR] = useState<Rule>(rule);
  const [min, setMin] = useState(rule.minAmount != null ? String(rule.minAmount) : '');
  const [max, setMax] = useState(rule.maxAmount != null ? String(rule.maxAmount) : '');
  const draft: Rule = { ...r, minAmount: min.trim() ? +min : undefined, maxAmount: max.trim() ? +max : undefined };
  const problem = ruleProblem(draft) ?? (min.trim() && isNaN(+min) ? 'The smallest amount should be a number.' : max.trim() && isNaN(+max) ? 'The largest amount should be a number.' : null);
  const [preview, setPreview] = useState<{ matches: number; changes: number; total: number; examples: TxnRow[] } | null>(null);
  const key = JSON.stringify(draft);
  useEffect(() => {
    if (!cat || problem) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => { void engine().testRule(draft, 8).then((p) => { if (live) setPreview(p); }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key, cat, catVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const catName = (idx: number) => (idx >= 0 && cat ? team.categories.find((c) => c.id === cat.catIds[idx])?.name ?? cat.catIds[idx] : 'Not sorted');
  const target = team.categories.find((c) => c.id === r.categoryId)?.name ?? r.categoryId;
  const save = () => {
    const out: Rule = { ...draft, pattern: draft.pattern.trim(), source: 'team', ...(isNew ? { createdAt: new Date().toISOString(), createdBy: user || undefined } : { editedAt: new Date().toISOString(), editedBy: user || undefined }) };
    // a new rule goes first, so it wins over older ones and the built-in rules
    updateTeam((t) => ({ ...t, rules: isNew ? [out, ...t.rules] : t.rules.map((x) => (x.id === out.id ? out : x)) }), { recategorise: true });
    toast(isNew ? 'Rule added. Matching lines are sorted with it now.' : 'Rule changed. Lines are sorted with it now.');
    onClose();
  };
  return (
    <Modal title={isNew ? 'Add a rule' : 'Change this rule'} onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!problem} onClick={save}>{isNew ? 'Add rule' : 'Save changes'}</button></>}>
      <div className="form-grid rule-form">
        <div className="field"><label htmlFor="rule-type">Lines where the description</label>
          <select id="rule-type" className="select" value={r.type === 'counterparty' ? 'contains' : r.type} onChange={(e) => setR({ ...r, type: e.target.value as RuleType })}>
            <option value="contains">contains</option><option value="alias">is exactly</option><option value="regex">matches a pattern (advanced)</option>
          </select></div>
        <div className="field"><label htmlFor="rule-pattern">these words</label>
          <input id="rule-pattern" className="input" autoFocus value={r.pattern} placeholder="e.g. DWP HB SUBSIDY" onChange={(e) => setR({ ...r, pattern: e.target.value })} /></div>
        <div className="field"><label htmlFor="rule-cat">are sorted as</label>
          <CategorySelect id="rule-cat" value={r.categoryId} onChange={(v) => setR({ ...r, categoryId: v })} categories={team.categories} /></div>
        <div className="field"><label htmlFor="rule-dir">Only for</label>
          <select id="rule-dir" className="select" value={r.direction ?? 'any'} onChange={(e) => setR({ ...r, direction: e.target.value as Rule['direction'] })}>
            <option value="any">money in or out</option><option value="in">money in</option><option value="out">money out</option>
          </select></div>
        <div className="field"><label htmlFor="rule-min">Smallest amount (£, optional)</label><input id="rule-min" className="input" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} /></div>
        <div className="field"><label htmlFor="rule-max">Largest amount (£, optional)</label><input id="rule-max" className="input" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="rule-note">Note (optional)</label><input id="rule-note" className="input" value={r.note ?? ''} onChange={(e) => setR({ ...r, note: e.target.value || undefined })} placeholder="why this rule exists" /></div>
      </div>
      {problem ? <div className="callout small mt">{problem}</div>
        : !cat ? <div className="callout navy small mt">Load statements to see which lines this rule would sort.</div>
        : preview && (
          <div className="mt">
            <div className={`callout small ${preview.matches ? 'navy' : ''}`}>
              {preview.matches
                ? <>Matches <strong>{int(preview.matches)}</strong> line{preview.matches === 1 ? '' : 's'} in the statements loaded ({money(preview.total)}).{' '}
                  {preview.changes ? <><strong>{int(preview.changes)}</strong> of them will move to <strong>{target}</strong>.</> : <>All are already sorted as {target}.</>}</>
                : <>Matches no lines in the statements loaded. Check the words: they’re matched against the description, ignoring case.</>}
            </div>
            {preview.examples.length > 0 && (
              <table className="tbl tbl-sm mt"><thead><tr><th>Date</th><th>Description</th><th>Now sorted as</th><th className="num">Amount</th></tr></thead>
                <tbody>{preview.examples.map((x) => (
                  <tr key={x.i}><td className="xs nowrap">{day(x.day)}</td><td className="xs">{x.narrative}</td><td className="xs">{catName(x.catIdx)}</td><td className="num xs"><Money v={x.amount} /></td></tr>
                ))}</tbody></table>
            )}
          </div>
        )}
    </Modal>
  );
}

/** The bank file layouts learned so far: what each reads, to rename or delete. */
function BankLayouts() {
  const { team, updateTeam, askConfirm } = useStore();
  const col = (cols: string[], i: number) => (i >= 0 ? `“${cols[i] ?? `column ${i + 1}`}”` : '—');
  const remove = async (id: string, name: string) => {
    if (await askConfirm({ title: `Delete the layout “${name}”?`, body: 'Files from this bank will be checked again the next time they’re loaded, as for a new bank.', ok: 'Delete', danger: true }))
      updateTeam((t) => ({ ...t, bankProfiles: t.bankProfiles.filter((x) => x.id !== id) }));
  };
  const rows = useMemo(() => team.bankProfiles, [team.bankProfiles]);
  return (
    <Panel title="Bank file layouts" sub="how each bank’s files are read" flush>
      <div className="card-pad small muted" style={{ paddingBottom: 6 }}>Saved when you confirm how a bank’s file is read. A file with the same column headings is then read the same way with nothing to check. To change how a layout reads its columns, load a file from that bank and adjust it on <strong>Check the files</strong> (an advanced step), then save it again.</div>
      {!rows.length ? <div className="card-pad small muted">No layouts saved yet.</div> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Date</th><th>Description</th><th>Amount</th><th>Account</th><th>Saved</th><th /></tr></thead>
            <tbody>{rows.map((p) => {
              const m = p.mapping, c = m.columns;
              return (
                <tr key={p.id}>
                  <td><input className="input sm" value={p.name} aria-label="Layout name" onChange={(e) => updateTeam((t) => ({ ...t, bankProfiles: t.bankProfiles.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)) }))} /></td>
                  <td className="xs">{col(c, m.date)}</td>
                  <td className="xs">{m.narrative.map((i) => col(c, i)).join(' + ') || '—'}</td>
                  <td className="xs">{m.amountMode === 'signed' ? col(c, m.amount) : `${col(c, m.debit)} out, ${col(c, m.credit)} in`}</td>
                  <td className="xs">{m.account >= 0 ? col(c, m.account) : m.defaultAccount || 'from the file name'}</td>
                  <td className="xs muted">{p.createdAt ? ago(p.createdAt) : '—'}</td>
                  <td><button className="icon-btn" aria-label={`Delete layout ${p.name}`} onClick={() => void remove(p.id, p.name)}><i className="bi bi-trash" /></button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
