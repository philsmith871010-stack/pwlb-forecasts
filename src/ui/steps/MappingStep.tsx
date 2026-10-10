import { useMemo, useState } from 'react';
import { useStore, Source } from '../../state/store';
import { PageHead, Panel, StepFooter, Seg, Empty, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import type { ColumnMapping } from '../../lib/ingest/detect';
import { mappingIsUsable } from '../../lib/ingest/detect';
import { parseAmount, parseDate } from '../../lib/ingest/parseValues';
import { day, int, money } from '../../lib/format';

type Role = 'ignore' | 'date' | 'amount' | 'debit' | 'credit' | 'narrative' | 'reference' | 'account' | 'balance' | 'type';
const ROLE_LABEL: Record<Role, string> = {
  ignore: '— ignore —', date: 'Date', amount: 'Amount (signed)', debit: 'Debit / paid out', credit: 'Credit / paid in',
  narrative: 'Narrative', reference: 'Reference', account: 'Account', balance: 'Running balance', type: 'Type code',
};

function rolesOf(m: ColumnMapping): Role[] {
  return m.columns.map((_, j) => {
    if (j === m.date) return 'date';
    if (m.amountMode === 'signed' && j === m.amount) return 'amount';
    if (m.amountMode === 'debitCredit' && j === m.debit) return 'debit';
    if (m.amountMode === 'debitCredit' && j === m.credit) return 'credit';
    if (m.narrative.includes(j)) return 'narrative';
    if (j === m.reference) return 'reference';
    if (j === m.account) return 'account';
    if (j === m.balance) return 'balance';
    if (j === m.type) return 'type';
    return 'ignore';
  });
}

function withRole(m: ColumnMapping, j: number, role: Role): ColumnMapping {
  const n: ColumnMapping = { ...m, narrative: m.narrative.filter((x) => x !== j) };
  for (const k of ['date', 'amount', 'debit', 'credit', 'reference', 'account', 'balance', 'type'] as const) if (n[k] === j) n[k] = -1;
  if (role === 'narrative') n.narrative = [...n.narrative, j].sort((a, b) => a - b);
  else if (role !== 'ignore') {
    // single-column roles: clear previous holder
    (n[role] as number) = j;
  }
  if (role === 'debit' || role === 'credit') n.amountMode = 'debitCredit';
  if (role === 'amount') n.amountMode = 'signed';
  return n;
}

export function MappingStep() {
  const { sources, ingest, runIngest, ingestBusy } = useStore();
  const [sel, setSel] = useState(0);
  const changed = useMemo(() => sources.some((s) => JSON.stringify(s.mapping) !== JSON.stringify(s.report.mapping) && !s.profileId), [sources]);
  const tabs: TabDef[] = [
    { id: 'overview', label: 'All files' },
    { id: 'preview', label: 'Preview' },
    { id: 'layout', label: 'Dates & amounts' },
    { id: 'checks', label: 'Checks' },
    { id: 'profile', label: 'Save layout' },
  ];
  const [tab, setTab] = useStepTab('map', tabs);
  if (!sources.length) return <div className="page"><Empty icon="bi-layout-three-columns" title="No files yet">Add bank CSVs on the first step.</Empty></div>;
  const src = sources[Math.min(sel, sources.length - 1)];
  const reread = <button className="btn primary" disabled={!!ingestBusy || !sources.every((s) => mappingIsUsable(s.mapping))} onClick={() => void runIngest()}><i className="bi bi-arrow-repeat" /> Re-read with these settings</button>;
  return (
    <div className="page">
      <PageHead eyebrow="Step 2 of 8" title="Check how we read your files" actions={changed ? reread : undefined}>
        Every bank lays out its export differently. We’ve worked out each file’s layout — this step lets you confirm it.
      </PageHead>
      {changed && <div className="callout mb"><strong>You changed a setting.</strong> Click <strong>Re-read with these settings</strong> (top right) to apply it.</div>}
      <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab !== 'overview' && (
        <div className="row mb">
          <span className="small muted">File:</span>
          {sources.map((s, i) => (
            <button key={s.name} className={`chip ${i === sel ? '' : 'navy'}`} style={i === sel ? { background: 'var(--pt-orange)', color: '#fff', borderColor: 'var(--pt-orange)' } : undefined} onClick={() => setSel(i)}>
              <i className={`bi ${mappingIsUsable(s.mapping) ? 'bi-check-circle' : 'bi-exclamation-circle'}`} /> {s.name}
            </button>
          ))}
        </div>
      )}
      {tab === 'overview' && (
        <>
          <Explain
            what="One line per file: the layout we detected and whether it matched a layout your team saved before."
            why="If a column is mis-read — say, money in and money out swapped — every number after this would be wrong. It only takes a moment to check."
            todo={<>If every file shows a green tick, you can go straight on to <strong>Categorise</strong>. Otherwise open the <strong>Preview</strong> tab for that file.</>} />
          <FilesOverview onOpen={(i) => { setSel(i); setTab('preview'); }} />
          <StepFooter nextDisabled={!ingest} nextLabel="Looks right — categorise the transactions" />
        </>
      )}
      {tab !== 'overview' && <FileMapping key={src.name + tab} src={src} tab={tab} />}
      {tab !== 'overview' && <NextTab label={tab === 'profile' ? 'Back to all files' : `Next: ${tabs[tabs.findIndex((t) => t.id === tab) + 1].label}`} onClick={() => setTab(tab === 'profile' ? 'overview' : tabs[tabs.findIndex((t) => t.id === tab) + 1].id)} />}
    </div>
  );
}

function FilesOverview({ onOpen }: { onOpen: (i: number) => void }) {
  const { sources, ingest } = useStore();
  return (
    <Panel title="Your files" flush>
      <table className="tbl">
        <thead><tr><th>File</th><th>Status</th><th>Layout</th><th>Dates</th><th className="num">Rows read</th><th>Saved layout</th><th /></tr></thead>
        <tbody>{sources.map((s, i) => {
          const f = ingest?.files.find((x) => x.name === s.name);
          const bal = ingest?.balanceChecks.find((b) => b.file === s.name);
          const ok = mappingIsUsable(s.mapping) && s.report.confidence !== 'low';
          return (
            <tr key={s.name}>
              <td><i className="bi bi-file-earmark-spreadsheet muted" /> {s.name}</td>
              <td>{ok ? <span className="badge green"><i className="bi bi-check-lg" /> looks right</span> : <span className="badge amber">please check</span>}{bal && bal.breaks === 0 && <span className="badge green" style={{ marginLeft: 4 }} title="Opening balance + transactions = closing balance on every row">balances tie</span>}</td>
              <td className="xs">{s.mapping.amountMode === 'debitCredit' ? 'Separate money in / out columns' : 'One amount column (+ in, − out)'}</td>
              <td className="xs">{s.report.dateFormatLabel}{s.mapping.dateOrder === 'MDY' ? ' (US order)' : ''}</td>
              <td className="num">{f ? int(f.rowsAccepted) : '–'}{f && f.rowsRejected ? <span className="xs muted"> ({f.rowsRejected} skipped)</span> : ''}</td>
              <td className="xs">{s.profileName ? <span className="chip navy"><i className="bi bi-bookmark-check" /> {s.profileName}</span> : <span className="muted">new layout</span>}</td>
              <td><button className="btn sm" onClick={() => onOpen(i)}>Check <i className="bi bi-chevron-right" /></button></td>
            </tr>
          );
        })}</tbody>
      </table>
    </Panel>
  );
}

function FileMapping({ src, tab }: { src: Source; tab: string }) {
  const { setMapping, saveProfile, ingest } = useStore();
  const m = src.mapping;
  const roles = rolesOf(m);
  const [profileName, setProfileName] = useState(src.profileName ?? src.name.replace(/\.(csv|txt)$/i, '').replace(/[_-]+/g, ' '));
  const fileSummary = ingest?.files.find((f) => f.name === src.name);
  const bal = ingest?.balanceChecks.find((b) => b.file === src.name);
  const preview = src.report.preview;

  const check = (row: string[]) => {
    const d = m.date >= 0 ? parseDate(row[m.date] ?? '', m.dateOrder) : null;
    let a: number | null = null;
    if (m.amountMode === 'signed' && m.amount >= 0) { const p = parseAmount(row[m.amount] ?? ''); a = p ? (m.positiveIsIn ? p.value : -p.value) : null; }
    if (m.amountMode === 'debitCredit') {
      const dd = (row[m.debit] ?? '').trim() ? parseAmount(row[m.debit]) : { value: 0 };
      const cc = (row[m.credit] ?? '').trim() ? parseAmount(row[m.credit]) : { value: 0 };
      a = dd && cc ? Math.abs(cc.value) - Math.abs(dd.value) : null;
    }
    const narr = m.narrative.map((j) => row[j] ?? '').join(m.narrativeJoin === 'concat' ? '' : ' ').trim();
    return { d, a, narr };
  };

  return (
    <div className="stack">
      {tab === 'preview' && <>
        <Explain
          what={<>The first rows of <strong>{src.name}</strong> exactly as they appear in the file. Above each column is what we think it holds; the orange column on the right shows the date and amount we read.</>}
          why="If the orange column shows the right dates and the right signs (money in positive, money out negative), the file is being read correctly."
          todo="Check a few rows against your bank statement. If a column is wrong, change its dropdown, then click Re-read at the top." />
        <Panel title="Preview" sub={`first ${preview.length} data rows · how we read them on the right`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>{m.columns.map((c, j) => (
                  <th key={j} style={{ background: roles[j] === 'ignore' ? '#5a6b7b' : undefined, minWidth: 110 }}>
                    <div className="xs" style={{ color: '#fff', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>{c || `Column ${j + 1}`}</div>
                    <select className="select sm" aria-label={`Role of column ${c}`} value={roles[j]} onChange={(e) => setMapping(src.name, withRole(m, j, e.target.value as Role))}>
                      {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </th>
                ))}
                  <th style={{ background: 'var(--pt-orange)', color: '#fff' }}>Read as</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => {
                  const c = check(row);
                  return (
                    <tr key={i}>
                      {m.columns.map((_, j) => <td key={j} className={`xs ${roles[j] === 'ignore' ? 'muted' : ''}`} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row[j]}</td>)}
                      <td className="xs nowrap" style={{ background: 'var(--pt-orange-soft)' }}>
                        {c.d ? day(c.d.day) : <span className="neg">no date</span>} · {c.a !== null ? <span className={c.a < 0 ? 'neg' : 'pos'}>{money(c.a)}</span> : <span className="neg">no amount</span>}
                        {c.d?.swapped && <span className="badge amber" title="Only valid with day and month swapped">swapped</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </>}
      {tab === 'layout' && <>
        <Explain
          what="The settings that decide how dates and amounts are read — e.g. is 03/04/2023 the 3rd of April (UK) or March 4th (US)?"
          why="Get these wrong and payments turn into receipts or land in the wrong month."
          todo="Usually nothing — these are detected for you. Only change them if the Preview tab looks wrong." />
        <div className="grid g2">
          <Panel title="Layout" sub={src.report.confidence === 'high' ? 'detected with confidence' : 'please check'}>
            <div className="stack" style={{ gap: 12 }}>
              <div className="field"><label>Date order (for dates like 03/04/2023)</label>
                <Seg value={m.dateOrder} onChange={(v) => setMapping(src.name, { ...m, dateOrder: v })} options={[{ v: 'DMY', label: 'Day/Month (UK)' }, { v: 'MDY', label: 'Month/Day (US)' }]} />
                <span className="xs muted">Evidence: {src.report.dateEvidence.dmy} UK-only, {src.report.dateEvidence.mdy} US-only, {src.report.dateEvidence.ambiguous} ambiguous · {src.report.dateFormatLabel}</span>
              </div>
              <div className="field"><label>Amounts</label>
                <Seg value={m.amountMode} onChange={(v) => setMapping(src.name, { ...m, amountMode: v })} options={[{ v: 'signed', label: 'One signed column' }, { v: 'debitCredit', label: 'Debit + Credit columns' }]} />
              </div>
              {m.amountMode === 'signed' && (
                <div className="field"><label>Which sign means money in?</label>
                  <Seg value={m.positiveIsIn ? 'in' : 'out'} onChange={(v) => setMapping(src.name, { ...m, positiveIsIn: v === 'in' })} options={[{ v: 'in', label: 'Positive = money in' }, { v: 'out', label: 'Positive = money out' }]} />
                </div>
              )}
              {m.narrative.length > 1 && (
                <div className="field"><label>Join narrative columns</label>
                  <Seg value={m.narrativeJoin} onChange={(v) => setMapping(src.name, { ...m, narrativeJoin: v })} options={[{ v: 'space', label: 'With a space' }, { v: 'concat', label: 'Directly (split text)' }]} />
                </div>
              )}
              {m.account < 0 && (
                <div className="field"><label>Account for this file (no account column)</label>
                  <input className="input" value={m.defaultAccount} onChange={(e) => setMapping(src.name, { ...m, defaultAccount: e.target.value })} />
                  <span className="xs muted">If left as the file name, we’ll match it to a known account by its narratives.</span>
                </div>
              )}
              <div className="xs muted">Delimiter <code>{m.delimiter === '\t' ? 'tab' : m.delimiter}</code> · header on line {m.headerRow + 1}</div>
            </div>
          </Panel>
          {src.report.notes.length > 0 && <div className="callout navy small"><ul style={{ margin: 0, paddingLeft: 18 }}>{src.report.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>}
        </div>
      </>}
      {tab === 'checks' && <>
        <Explain
          what="What we actually read from this file, plus a balance check: where the file has a running balance, we confirm opening balance + transactions = closing balance on every row."
          why="A balance that ties all the way through is strong proof nothing was missed or double-counted."
          todo="Nothing, unless you see breaks or lots of rejected rows — then look at that part of the file." />
          {fileSummary && (
            <Panel title="What we read">
              <dl className="kv">
                <dt>Rows accepted</dt><dd>{int(fileSummary.rowsAccepted)}</dd>
                <dt>Rows rejected</dt><dd>{int(fileSummary.rowsRejected)}</dd>
                <dt>Blank lines</dt><dd>{int(fileSummary.blankLines)}</dd>
                <dt>Dates</dt><dd>{day(fileSummary.firstDay)} – {day(fileSummary.lastDay)}</dd>
                <dt>Account(s)</dt><dd>{fileSummary.accounts.join(', ')}{(fileSummary as { accountMatchedBy?: string }).accountMatchedBy ? ` (matched by ${(fileSummary as { accountMatchedBy?: string }).accountMatchedBy})` : ''}</dd>
                {fileSummary.overlapDuplicatesRemoved > 0 && <><dt>Overlap removed</dt><dd>{int(fileSummary.overlapDuplicatesRemoved)} rows already in another file</dd></>}
              </dl>
              {bal && (
                <div className={`callout ${bal.breaks ? 'red' : 'green'} mt small`}>
                  <strong>Balance continuity:</strong> {bal.breaks === 0 ? `opening balance + flows = closing balance on all ${int(bal.checked)} rows. Excellent.` : `${bal.breaks} break(s) in ${int(bal.checked)} checks — usually a rejected or missing row nearby (first at line ${bal.firstBreaks[0]?.line}).`}
                  {bal.openingBalance !== null && <> Opening balance {money(bal.openingBalance)}.</>}
                </div>
              )}
            </Panel>
          )}
      </>}
      {tab === 'profile' && <>
        <Explain
          what="Saves this file’s layout as a named bank profile, so next time it’s read automatically."
          why="Next time anyone loads an export with the same columns, it’s read correctly with no checking needed."
          todo="Give it a recognisable name (e.g. “Lloyds main account”) and click Save." />
        <div className="grid g2">
          <Panel title="Bank profile">
            <div className="field"><label>Profile name</label><input className="input" value={profileName} onChange={(e) => setProfileName(e.target.value)} /></div>
            <div className="row mt"><button className="btn" onClick={() => saveProfile(src.name, profileName)}><i className="bi bi-bookmark-plus" /> {src.profileId ? 'Update profile' : 'Save as bank profile'}</button>
              {src.profileName && <span className="chip navy"><i className="bi bi-bookmark-check" /> matched “{src.profileName}”</span>}</div>
          </Panel>
        </div>
      </>}
    </div>
  );
}
