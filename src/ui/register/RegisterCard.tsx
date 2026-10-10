import { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { money, day, int } from '../../lib/format';
import { PracticeNote } from '../components/common';

const TEMPLATE_URL = `${import.meta.env.BASE_URL}templates/pwlb-register.xlsx`;

/** Step 1: add the council's deal register (the PWLBtoday workbook), optional but recommended. */
/** `quiet`: no practice note of its own (the page has one); `hint`: what the register does here. */
export function RegisterCard({ quiet, hint }: { quiet?: boolean; hint?: string } = {}) {
  const { register, registerBusy, registerError, loadRegisterFile, clearRegister, cat, ingest, space, useExampleRegister } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = (f: File | undefined) => { if (f) void loadRegisterFile(f); };

  if (register) {
    const m = cat?.registerMatch;
    return (
      <div className="card card-pad mt fade register-card on">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <i className="bi bi-journal-check reg-icon" />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>Deal register added {register.example && <span className="badge navy">example</span>}</h3>
            <p className="small" style={{ margin: '4px 0 0' }}>
              <strong>{money(register.stats.debt)}</strong> of loans, <strong>{money(register.investments.reduce((s, t) => s + t.principal, 0))}</strong> in fixed-term investments and <strong>{money(register.liquid.total)}</strong> in funds, as at {register.asAt ? day(register.asAt) : 'its date'}. Repayments, interest and maturities are in the forecast.
            </p>
            {m && m.events >= 10 && m.matched / m.events < 0.3 && <div className="callout red mt small"><strong>Few of the register’s deals were found in these bank files</strong> ({int(m.matched)} of {int(m.events)} cash flows). Check that the register and the bank files are for the same council and cover the same period.</div>}
            <details className="more-detail">
              <summary>More detail</summary>
              <p className="small muted" style={{ margin: '6px 0 0' }}>{register.name}. {int(register.loans.length)} loans, {int(register.investments.length)} investments{register.lb ? `, balance sheet projections to ${register.lb[register.lb.length - 1].fy}` : ''}.{m && m.matched > 0 ? ` ${int(m.matched)} bank lines matched to its deals.` : ''}</p>
              {m && m.interest.estimated > 0 && <InterestCheck i={m.interest} />}
            <RegisterDetail />
            {ingest && register.asAt && Math.abs(register.asAt - ingest.maxDay) > 31 && (
              <p className="xs muted" style={{ margin: '6px 0 0' }}><i className="bi bi-calendar-event" /> The register is as at {day(register.asAt)} and your bank files end on {day(ingest.maxDay)}. The forecast uses every register cash flow after {day(ingest.maxDay)}, and fund balances as at {day(register.asAt)}.</p>
            )}
            {register.issues.length > 0 && <p className="xs muted" style={{ margin: '6px 0 0' }}><i className="bi bi-info-circle" /> The register notes {register.issues.length} thing{register.issues.length > 1 ? 's' : ''} to tidy up (for example a missing date). It was still read.</p>}
            </details>
          </div>
          <div className="col-actions">
            {space !== 'example' && <button className="btn sm" disabled={registerBusy} onClick={() => input.current?.click()}><i className="bi bi-arrow-repeat" /> Replace</button>}
            <button className="btn sm ghost" disabled={registerBusy} onClick={() => void clearRegister()}>Remove</button>
          </div>
        </div>
        <input ref={input} type="file" accept=".xlsx" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    );
  }

  return (
    <div className={`card card-pad mt register-card ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <i className="bi bi-journal-text reg-icon" />
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>Add your deal register</h3>
          <p className="small" style={{ margin: '4px 0 0' }}>
            {hint ?? <>The spreadsheet of your loans and investments (the one used for PWLBtoday reports). With it, repayments, maturities and
            interest are in the forecast, and the options say how much to borrow and for how long.</>}
          </p>
          {space === 'example' && !quiet && <div className="mt"><PracticeNote>With your own council you’d choose your deal register spreadsheet. Here, <strong>Choose register</strong> picks the example council’s: nothing is uploaded.</PracticeNote></div>}
          {registerError && <div className="callout red mt"><strong>We couldn’t read that register.</strong> {registerError}</div>}
          <div className="row mt" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn navy" disabled={registerBusy} onClick={() => (space === 'example' ? void useExampleRegister() : input.current?.click())}>
              {registerBusy ? <><span className="spinner sm" /> Reading…</> : <><i className="bi bi-file-earmark-excel" /> Choose register (.xlsx)</>}
            </button>
            <a className="btn ghost" href={TEMPLATE_URL} download="pwlb-register.xlsx"><i className="bi bi-download" /> Blank template</a>
            <span className="xs muted">Read on this computer only.</span>
          </div>
        </div>
      </div>
      <input ref={input} type="file" accept=".xlsx" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

/** Interest is estimated from the register's rates and dates; this shows how well that worked on past bank lines. */
function InterestCheck({ i }: { i: { estimated: number; found: number; within1: number; estimatedAbs: number; actualAbs: number } }) {
  const foundPct = i.found / i.estimated;
  const diff = i.actualAbs - i.estimatedAbs;
  const good = foundPct >= 0.9 && Math.abs(diff) <= Math.max(1000, i.actualAbs * 0.02);
  return (
    <div className={`callout ${good ? 'green' : ''} mt small`}>
      <strong>Interest is estimated</strong> from each deal’s rate and dates (the register doesn’t record interest payments).
      Checked against your bank history, we found <strong>{int(i.found)} of {int(i.estimated)}</strong> of the interest payments we estimated
      {i.found > 0 && <>, totalling {money(i.actualAbs)} against {money(i.estimatedAbs)} estimated</>}.
      {!good && ' Some interest is paid on different dates or amounts than assumed, so treat future interest as approximate.'}
    </div>
  );
}

/** What was read from the register, so it can be checked against the workbook. */
function RegisterDetail() {
  const r = useStore((s) => s.register)!;
  const pctRate = (x: number | null) => (x == null ? '–' : `${(x * 100).toFixed(2)}%`);
  return (
    <details className="reg-detail mt">
      <summary className="small">See what was read</summary>
      <div className="table-wrap mt">
        <table className="tbl tbl-sm">
          <thead><tr><th>Loan</th><th>Lender</th><th className="num">Principal</th><th className="num">Rate</th><th>Matures</th><th>Repaid</th></tr></thead>
          <tbody>{r.loans.map((l) => <tr key={l.ref}><td>{l.type}</td><td>{l.lender}</td><td className="num">{money(l.principal)}</td><td className="num">{pctRate(l.rate)}</td><td>{l.maturity ? day(l.maturity) : '–'}{l.nextCall ? <span className="xs muted"> (call {day(l.nextCall)})</span> : null}</td><td>{l.profile === 'EIP' ? 'Equal instalments' : l.profile === 'Annuity' ? 'Annuity' : 'At maturity'}</td></tr>)}</tbody>
        </table>
        {r.investments.length > 0 && (
          <table className="tbl tbl-sm mt">
            <thead><tr><th>Investment</th><th>With</th><th className="num">Principal</th><th className="num">Rate</th><th>Matures</th></tr></thead>
            <tbody>{r.investments.map((t) => <tr key={t.ref}><td>{t.type}</td><td>{t.counterparty}</td><td className="num">{money(t.principal)}</td><td className="num">{pctRate(t.rate)}</td><td>{t.maturity ? day(t.maturity) : '–'}</td></tr>)}</tbody>
          </table>
        )}
        {r.liquid.rows.length > 0 && (
          <table className="tbl tbl-sm mt">
            <thead><tr><th>Fund or account</th><th className="num">Balance</th><th>Notice</th></tr></thead>
            <tbody>{r.liquid.rows.map((c, i) => <tr key={i}><td>{c.name}</td><td className="num">{money(c.amount)}</td><td>{c.notice ? `${c.notice} days` : 'instant'}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </details>
  );
}
