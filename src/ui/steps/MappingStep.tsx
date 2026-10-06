import { useMemo, useState } from 'react';
import { useStore, Source } from '../../state/store';
import { PageHead, Panel, StepFooter, Seg, Empty } from '../components/common';
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
  const src = sources[Math.min(sel, sources.length - 1)];
  const changed = useMemo(() => sources.some((s) => JSON.stringify(s.mapping) !== JSON.stringify(s.report.mapping) && !s.profileId), [sources]);
  if (!sources.length) return <div className="page"><Empty icon="bi-layout-three-columns" title="No files yet">Add bank CSVs on the first step.</Empty></div>;
  return (
    <div className="page">
      <PageHead eyebrow="Step 2 of 8" title="Confirm the column mapping"
        actions={<button className="btn primary" disabled={!!ingestBusy || !sources.every((s) => mappingIsUsable(s.mapping))} onClick={() => void runIngest()}><i className="bi bi-arrow-repeat" /> Re-read with this mapping</button>}>
        We detected each file’s layout automatically. Check the preview — dates, amounts and narratives should look right — and correct anything with the dropdowns. Save a layout as a bank profile and it will map itself next time.
      </PageHead>
      {changed && <div className="callout mb"><strong>Mapping changed.</strong> Re-read the files to apply it.</div>}
      <div className="tabs">
        {sources.map((s, i) => (
          <button key={s.name} className={i === sel ? 'on' : ''} onClick={() => setSel(i)}>
            <i className={`bi ${mappingIsUsable(s.mapping) ? 'bi-check-circle' : 'bi-exclamation-circle'}`} /> {s.name}
          </button>
        ))}
      </div>
      {src && <FileMapping key={src.name} src={src} />}
      <StepFooter nextDisabled={!ingest} nextLabel="Categorise the transactions" />
    </div>
  );
}

function FileMapping({ src }: { src: Source }) {
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
      <div className="grid g-side">
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
        <div className="stack">
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
          <Panel title="Bank profile">
            <div className="field"><label>Profile name</label><input className="input" value={profileName} onChange={(e) => setProfileName(e.target.value)} /></div>
            <div className="row mt"><button className="btn" onClick={() => saveProfile(src.name, profileName)}><i className="bi bi-bookmark-plus" /> {src.profileId ? 'Update profile' : 'Save as bank profile'}</button>
              {src.profileName && <span className="chip navy"><i className="bi bi-bookmark-check" /> matched “{src.profileName}”</span>}</div>
          </Panel>
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
        </div>
      </div>
    </div>
  );
}
