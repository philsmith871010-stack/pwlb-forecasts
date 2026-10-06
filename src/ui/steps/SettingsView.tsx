import { useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Modal, Explain, StepTabs, useStepTab, TabDef } from '../components/common';
import { RulesPanel } from './CategoriseStep';
import { GROUP_LABELS, CategoryGroup, ForecastMethod, Category } from '../../lib/categories';
import { uid } from '../../lib/model';
import { ago } from '../../lib/format';

const METHODS: ForecastMethod[] = ['seasonal', 'series', 'flat', 'manual', 'exclude'];

export function SettingsView() {
  const { team, updateTeam, user, setUser } = useStore();
  const [merge, setMerge] = useState<Category | null>(null);
  const [into, setInto] = useState('');
  const setCat = (id: string, patch: Partial<Category>) => updateTeam((t) => ({ ...t, categories: t.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), { recategorise: 'group' in patch });
  const fyStart = team.settings.financialYearStart.split('-')[0];
  const tabs: TabDef[] = [
    { id: 'general', label: 'General', icon: 'bi-building' },
    { id: 'categories', label: 'Categories', icon: 'bi-tags', badge: team.categories.length },
    { id: 'rules', label: 'Rules', icon: 'bi-signpost', badge: team.rules.length || '' },
    { id: 'aliases', label: 'Aliases', icon: 'bi-link-45deg', badge: team.aliases.length || '' },
    { id: 'banks', label: 'Bank layouts', icon: 'bi-bookmark', badge: team.bankProfiles.length || '' },
  ];
  const [tab, setTab] = useStepTab('settings', tabs);
  return (
    <div className="page">
      <PageHead eyebrow="Advanced tools" title="Settings">Everything here is saved in the team file and shared with your colleagues.</PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} numbered={false} />
      {tab === 'general' && <>
        <Explain compact what="Your council’s name, when its financial year starts, and the minimum cash buffer you want to keep." why="The buffer is the red line on the forecast: falling below it is what creates a borrowing need." />
        <div className="grid g2">
        <Panel title="Your council">
          <div className="field mb"><label>Name</label><input className="input" value={team.authorityName} onChange={(e) => updateTeam((t) => ({ ...t, authorityName: e.target.value }))} /></div>
          <div className="field mb"><label>Financial year starts</label>
            <select className="select" value={fyStart} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, financialYearStart: `${e.target.value}-01` } }))}>
              {['01', '04', '07', '10'].map((m) => <option key={m} value={m}>{['January', 'April', 'July', 'October'][['01', '04', '07', '10'].indexOf(m)]}</option>)}
            </select></div>
          <div className="field"><label>Liquidity buffer (£)</label><input className="input" type="number" step={1000000} value={team.settings.liquidityBuffer} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, liquidityBuffer: +e.target.value } }))} /></div>
        </Panel>
        <Panel title="You">
          <div className="field"><label>Initials or name (recorded on rules and saves)</label><input className="input" value={user} onChange={(e) => setUser(e.target.value)} /></div>
          <p className="xs muted mt">Stored in this browser only.</p>
        </Panel>
        </div>
      </>}
      {tab === 'categories' && <>
        <Explain compact what="The categories transactions are sorted into, with their colour, type and default forecasting method." why={<>The <strong>type</strong> matters most: anything marked “Treasury / deal” is kept out of the forecast.</>} todo="Rename, recolour or merge to suit how your council reports. Changes apply everywhere at once." />
      <Panel title="Categories" sub="rename, recolour, regroup, merge — consistent on every chart" right={<button className="btn sm on-dark" onClick={() => updateTeam((t) => ({ ...t, categories: [...t.categories, { id: uid('cat'), name: 'New category', group: 'payments_operational', colour: '#6b8abc', forecastMethod: 'seasonal' }] }))}><i className="bi bi-plus-lg" /> Add</button>} flush>
        <div className="tbl-wrap tall">
          <table className="tbl">
            <thead><tr><th>Colour</th><th>Name</th><th>Group</th><th>Default method</th><th>ID</th><th /></tr></thead>
            <tbody>{team.categories.map((c) => (
              <tr key={c.id}>
                <td><input type="color" value={c.colour} onChange={(e) => setCat(c.id, { colour: e.target.value })} aria-label={`Colour for ${c.name}`} style={{ width: 34, height: 26, border: 0, background: 'none' }} /></td>
                <td><input className="input sm" value={c.name} onChange={(e) => setCat(c.id, { name: e.target.value })} /></td>
                <td><select className="select sm" value={c.group} onChange={(e) => setCat(c.id, { group: e.target.value as CategoryGroup })}>{(Object.keys(GROUP_LABELS) as CategoryGroup[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}</select></td>
                <td><select className="select sm" value={c.forecastMethod} onChange={(e) => setCat(c.id, { forecastMethod: e.target.value as ForecastMethod })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></td>
                <td className="mono xs muted">{c.id}</td>
                <td><button className="btn sm ghost" onClick={() => { setMerge(c); setInto(''); }}><i className="bi bi-sign-merge-left" /> Merge…</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
      </>}
      {tab === 'rules' && <>
        <Explain compact what="Rules your team created in Review, and the built-in starter rules." why="Rules are how the tool remembers your decisions — each one sorts matching lines automatically next time." todo="Change a rule’s category or delete it if it’s wrong." />
        <RulesEditor />
        <div className="mt"><RulesPanel /></div>
      </>}
      {tab === 'aliases' && <>
        <Explain compact what="Different spellings of the same counterparty, e.g. “P.W.L.B” and “PUBLIC WORKS LOAN” both meaning PWLB." why="Spellings are made the same before rules run, so one rule covers them all." />
        <AliasesPanel />
      </>}
      {tab === 'banks' && <>
        <Explain compact what="Saved bank file layouts. A file whose column headings match is read with no checking needed." todo="Delete a layout if your bank changed its export format." />
        <div style={{ maxWidth: 760 }}>
        <Panel title="Saved bank layouts" sub={`${team.bankProfiles.length}`}>
          {team.bankProfiles.length === 0 ? <p className="small muted">Save one from the Mapping step.</p> : (
            <ul className="list-plain small">{team.bankProfiles.map((p) => (
              <li key={p.id} className="row tight"><i className="bi bi-bookmark orange" /><span style={{ flex: 1 }}>{p.name}<div className="xs muted mono ellipsis" style={{ maxWidth: 260 }} title={p.headerSignature}>{p.headerSignature}</div></span>
                <button className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => updateTeam((t) => ({ ...t, bankProfiles: t.bankProfiles.filter((x) => x.id !== p.id) }))}><i className="bi bi-trash" /></button></li>
            ))}</ul>
          )}
        </Panel>
        </div>
      </>}
      {merge && (
        <Modal title={`Merge “${merge.name}” into…`} onClose={() => setMerge(null)} footer={<><button className="btn" onClick={() => setMerge(null)}>Cancel</button>
          <button className="btn primary" disabled={!into} onClick={() => {
            updateTeam((t) => ({ ...t, categories: t.categories.filter((c) => c.id !== merge.id), rules: t.rules.map((r) => (r.categoryId === merge.id ? { ...r, categoryId: into } : r)), txnOverrides: t.txnOverrides.map((o) => (o.categoryId === merge.id ? { ...o, categoryId: into } : o)) }), { recategorise: true });
            setMerge(null);
          }}>Merge</button></>}>
          <p className="small">Rules and decisions pointing at “{merge.name}” will point at the chosen category. Starter rules for the merged category stop applying.</p>
          <select className="select" value={into} onChange={(e) => setInto(e.target.value)}><option value="">Choose…</option>{team.categories.filter((c) => c.id !== merge.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </Modal>
      )}
    </div>
  );
}

function RulesEditor() {
  const { team, updateTeam } = useStore();
  if (!team.rules.length) return null;
  return (
    <Panel title="Edit team rules" sub="delete or change what a rule does" flush>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Pattern</th><th>Type</th><th>Category</th><th>Created</th><th className="num">Hits</th><th /></tr></thead>
          <tbody>{team.rules.map((r) => (
            <tr key={r.id}>
              <td className="mono xs">{r.pattern}</td><td className="xs">{r.type}</td>
              <td><select className="select sm" value={r.categoryId} onChange={(e) => updateTeam((t) => ({ ...t, rules: t.rules.map((x) => (x.id === r.id ? { ...x, categoryId: e.target.value } : x)) }), { recategorise: true })}>{team.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
              <td className="xs muted">{r.createdBy ?? '—'} · {r.createdAt ? ago(r.createdAt) : ''}</td>
              <td className="num">{r.hits ?? 0}</td>
              <td><button className="icon-btn" aria-label="Delete rule" onClick={() => updateTeam((t) => ({ ...t, rules: t.rules.filter((x) => x.id !== r.id) }), { recategorise: true })}><i className="bi bi-trash" /></button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function AliasesPanel() {
  const { team, addAlias, updateTeam } = useStore();
  const [canon, setCanon] = useState('');
  const [vars, setVars] = useState('');
  return (
    <Panel title="Aliases" sub="spellings that mean the same counterparty — applied before rules">
      {team.aliases.length > 0 && (
        <table className="tbl mb"><thead><tr><th>Canonical</th><th>Variants</th><th /></tr></thead>
          <tbody>{team.aliases.map((a) => <tr key={a.canonical}><td className="mono">{a.canonical}</td><td className="mono xs">{a.variants.join(' · ')}</td><td><button className="icon-btn" aria-label="Delete alias" onClick={() => updateTeam((t) => ({ ...t, aliases: t.aliases.filter((x) => x.canonical !== a.canonical) }), { recategorise: true })}><i className="bi bi-trash" /></button></td></tr>)}</tbody></table>
      )}
      <div className="row">
        <input className="input" style={{ width: 220 }} placeholder="Canonical, e.g. PWLB" value={canon} onChange={(e) => setCanon(e.target.value)} />
        <input className="input" style={{ flex: 1 }} placeholder="Variants, comma separated, e.g. P.W.L.B, PUBLIC WORKS LOAN" value={vars} onChange={(e) => setVars(e.target.value)} />
        <button className="btn primary" disabled={!canon || !vars} onClick={() => { addAlias({ canonical: canon.trim().toUpperCase(), variants: vars.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean) }, `Alias ${canon.toUpperCase()}`); setCanon(''); setVars(''); }}>Add alias</button>
      </div>
    </Panel>
  );
}
