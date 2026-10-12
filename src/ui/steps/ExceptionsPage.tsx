// Daily → Exceptions: lines in the statements read that deserve a second look. Each is marked as
// checked, or a query is raised, with who, when and why: kept in the team file under a hash of the
// line, never the bank details, so the record is private and survives merges.
import { useMemo, useState } from 'react';
import { useStore, type ExceptionView } from '../../state/store';
import { PageHead, Panel, Money, StepFooter } from '../components/common';
import { EXCEPTION_KINDS, DEFAULT_EXCEPTION_SETTINGS, latestReviews, type ExceptionKind, type ExceptionReview, type ExceptionSettings } from '../../lib/governance/exceptions';
import { money, day, int, ago } from '../../lib/format';
import { downloadText } from '../../lib/teamfile';

const LABEL = Object.fromEntries(EXCEPTION_KINDS.map((k) => [k.kind, k.label])) as Record<ExceptionKind, string>;

export function ExceptionsPage() {
  const { exceptions, ingest, team, updateTeam, user, setUser, space } = useStore();
  // the practice run checks as "You (practice)", as it signs off, without keeping it as your name
  const who = user.trim() || (space === 'example' ? 'You (practice)' : '');
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [kind, setKind] = useState<ExceptionKind | ''>('');
  const reviews = useMemo(() => latestReviews(team.exceptionReviews), [team.exceptionReviews]);
  const list = exceptions ?? [];
  const open = list.filter((e) => !reviews.get(e.key));
  const shown = (show === 'open' ? open : list).filter((e) => !kind || e.kind === kind);
  const review = (e: ExceptionView, status: ExceptionReview['status'], note?: string) =>
    updateTeam((t) => ({ ...t, exceptionReviews: [...(t.exceptionReviews ?? []), { key: e.key, status, by: who, at: new Date().toISOString(), note: note || undefined }] }));
  const exportLog = () => {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [['Type', 'Date', 'Payee', 'Amount', 'Account', 'Why', 'Status', 'By', 'When', 'Note'].join(',')];
    for (const e of list) {
      const r = reviews.get(e.key);
      rows.push([LABEL[e.kind], day(e.day), e.lines[0]?.narrative ?? e.signature, e.amount.toFixed(2), e.lines[0]?.account ?? '', e.why, r ? (r.status === 'checked' ? 'Checked' : 'Query raised') : 'Open', r?.by ?? '', r ? new Date(r.at).toLocaleString('en-GB') : '', r?.note ?? ''].map((x) => q(String(x))).join(','));
    }
    downloadText(rows.join('\n') + '\n', `exceptions-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  };
  return (
    <div className="page">
      <PageHead title="Exceptions">
        Lines in your statements that deserve a second look. Mark each as checked, or raise a query. Who did it, when and why is kept with your work, without the bank details. This is a check on the money that actually moved, alongside your payment controls, not instead of them.
      </PageHead>
      {!ingest || exceptions === null ? (
        <div className="callout navy small">Exceptions are found in statements as they’re added to your history: read the day’s statement on <strong>Today’s statement</strong> first. (The history you first loaded isn’t checked.)</div>
      ) : (
        <>
          <div className="exc-top">
            <div className="small">From the statements read: <strong>{day(ingest.minDay)}</strong>{ingest.maxDay > ingest.minDay && <> to <strong>{day(ingest.maxDay)}</strong></>}, {int(ingest.rows)} lines. <strong>{int(open.length)}</strong> to check{list.length > open.length && <>, {int(list.length - open.length)} done</>}.</div>
            {list.length > 0 && <div className="row tight">
              <div className="seg" role="radiogroup" aria-label="Show">
                <button role="radio" aria-checked={show === 'open'} className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>To check ({open.length})</button>
                <button role="radio" aria-checked={show === 'all'} className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All ({list.length})</button>
              </div>
              <select className="select sm" value={kind} onChange={(e) => setKind(e.target.value as ExceptionKind | '')} aria-label="Type">
                <option value="">Every type</option>
                {EXCEPTION_KINDS.map((k) => { const n = list.filter((e) => e.kind === k.kind).length; return n ? <option key={k.kind} value={k.kind}>{k.label} ({n})</option> : null; })}
              </select>
              <button className="btn sm ghost" onClick={exportLog} disabled={!list.length}><i className="bi bi-download" /> Download the log</button>
            </div>}
          </div>
          {list.length > 0 && !who && (
            <div className="callout small mb"><label htmlFor="exc-who"><strong>Your name</strong>, recorded on each check and query:</label>{' '}
              <input id="exc-who" className="input sm" style={{ width: 220 }} value={user} onChange={(e) => setUser(e.target.value)} placeholder="Name or initials" /></div>
          )}
          {!list.length ? <div className="callout green small"><i className="bi bi-check2-circle" /> Nothing unusual in these statements.</div>
            : !shown.length ? <div className="callout green small"><i className="bi bi-check2-circle" /> Every exception {kind ? 'of this type ' : ''}has been looked at.</div>
            : <div className="stack" style={{ gap: 10 }}>{shown.map((e) => <ExceptionCard key={e.key} e={e} r={reviews.get(e.key)} named={!!who} onReview={(s, n) => review(e, s, n)} />)}</div>}
          <Thresholds />
        </>
      )}
      <StepFooter />
    </div>
  );
}

function ExceptionCard({ e, r, named, onReview }: { e: ExceptionView; r?: ExceptionReview; named: boolean; onReview: (s: ExceptionReview['status'], note?: string) => void }) {
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  return (
    <div className={`card card-pad exc-card ${r ? r.status : 'open'}`}>
      <div className="exc-head">
        <span className={`badge ${e.kind === 'duplicate' || e.kind === 'out_of_line' ? 'red' : e.kind === 'new_payee' || e.kind === 'large_one_off' ? 'amber' : 'navy'}`}>{LABEL[e.kind]}</span>
        <strong>{e.lines[0]?.narrative ?? e.signature}</strong>
        <span className="num"><Money v={e.amount} full /></span>
      </div>
      <div className="small">{e.why}</div>
      <table className="tbl tbl-sm mt"><tbody>{e.lines.map((x) => (
        <tr key={x.i}><td className="xs nowrap">{day(x.day)}</td><td className="xs">{x.narrative}</td><td className="xs muted nowrap">{x.account}</td><td className="num xs nowrap"><Money v={x.amount} full /></td></tr>
      ))}</tbody></table>
      {r ? (
        <div className={`exc-status ${r.status}`}>
          <i className={`bi ${r.status === 'checked' ? 'bi-check-circle-fill' : 'bi-question-circle-fill'}`} /> {r.status === 'checked' ? 'Checked' : 'Query raised'} by <strong>{r.by}</strong>, {ago(r.at)}{r.note ? <>: “{r.note}”</> : '.'}
          {' '}<button className="link-btn" disabled={!named} onClick={() => onReview(r.status === 'checked' ? 'query' : 'checked')}>{r.status === 'checked' ? 'Raise a query instead' : 'Mark as checked'}</button>
        </div>
      ) : (
        <div className="row tight mt">
          <input className="input sm" style={{ flex: 1, minWidth: 220 }} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={asking ? 'What’s the query? (needed)' : 'Note (optional): e.g. two invoices, both approved'} aria-label="Note" />
          {asking
            ? <><button className="btn sm navy" disabled={!note.trim() || !named} onClick={() => onReview('query', note.trim())}>Raise the query</button><button className="btn sm ghost" onClick={() => setAsking(false)}>Cancel</button></>
            : <><button className="btn sm navy" disabled={!named} title={named ? undefined : 'Add your name first'} onClick={() => onReview('checked', note.trim())}><i className="bi bi-check2" /> Checked</button><button className="btn sm ghost" disabled={!named} onClick={() => setAsking(true)}><i className="bi bi-question-circle" /> Raise a query</button></>}
        </div>
      )}
    </div>
  );
}

/** The council's own thresholds for exceptions. */
function Thresholds() {
  const { team, updateTeam, refreshExceptions } = useStore();
  const st: ExceptionSettings = { ...DEFAULT_EXCEPTION_SETTINGS, ...team.settings.exceptions };
  const [draft, setDraft] = useState({ minAmount: String(st.minAmount), factor: String(st.factor), dupDays: String(st.dupDays) });
  const valid = +draft.minAmount > 0 && +draft.factor > 1 && +draft.dupDays >= 0;
  const apply = () => {
    updateTeam((t) => ({ ...t, settings: { ...t.settings, exceptions: { minAmount: +draft.minAmount, factor: +draft.factor, dupDays: Math.round(+draft.dupDays) } } }));
    void refreshExceptions();
  };
  return (
    <details className="fold mt">
      <summary>Your thresholds <span className="muted" style={{ fontWeight: 400 }}>· lines from {money(st.minAmount)} ({money(st.minAmount / 10)} for duplicates and unsorted lines), {st.factor}× a payee’s usual, duplicates within {st.dupDays} days</span></summary>
      <Panel title="Thresholds" sub="kept in your team file">
        <div className="form-grid rule-form">
          <div className="field"><label htmlFor="exc-min">Raise lines from (£)</label><input id="exc-min" className="input" inputMode="decimal" value={draft.minAmount} onChange={(e) => setDraft({ ...draft, minAmount: e.target.value })} /></div>
          <div className="field"><label htmlFor="exc-factor">Out of line at (times the usual)</label><input id="exc-factor" className="input" inputMode="decimal" value={draft.factor} onChange={(e) => setDraft({ ...draft, factor: e.target.value })} /></div>
          <div className="field"><label htmlFor="exc-dup">Duplicates within (days)</label><input id="exc-dup" className="input" inputMode="numeric" value={draft.dupDays} onChange={(e) => setDraft({ ...draft, dupDays: e.target.value })} /></div>
        </div>
        <div className="row mt"><button className="btn sm primary" disabled={!valid} onClick={apply}>Apply</button>{!valid && <span className="xs muted">Amounts above £0, out of line above 1 times, days 0 or more.</span>}</div>
      </Panel>
    </details>
  );
}
