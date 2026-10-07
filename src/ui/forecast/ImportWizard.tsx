// "Import a schedule": a table another department sent (Excel, CSV or pasted), read in the
// browser, checked in four short steps, and added to the forecast as rows of the grid.
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { Modal } from '../components/common';
import type { Scenario } from '../../lib/model';
import type { ForecastBundle } from './useForecast';
import {
  readTableFile, readTableText, detectColumns, guessDateOrder, matchCategory, categoryNames, buildImport, importToOverrides, suggestReplacedRows, namesMatch, type ReplacedRows,
  type ImportColumns, type ImportMode,
} from '../../lib/forecast/importSchedule';
import { money, day as fmtDay, int } from '../../lib/format';
import type { DateOrder } from '../../lib/ingest/parseValues';
import { isoFromDay } from '../../lib/dates';

type Upd = (fn: (s: Scenario) => Scenario) => void;
const STEPS = ['Choose the file', 'Check the columns', 'Match the categories', 'Add to the forecast'];

export function ImportWizard({ b, upd, onClose, lockCategory }: { b: ForecastBundle; upd: Upd; onClose: () => void; lockCategory?: string }) {
  const categories = useStore((s) => s.team.categories);
  const toast = useStore((s) => s.toast);
  const ops = categories.filter((c) => c.group === 'receipts_operational' || c.group === 'payments_operational');
  const [step, setStep] = useState(0);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [source, setSource] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [cols, setCols] = useState<ImportColumns | null>(null);
  const [order, setOrder] = useState<DateOrder>('DMY');
  const [single, setSingle] = useState<string | null>(lockCategory ?? null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [signs, setSigns] = useState<'direction' | 'signed'>('direction');
  const [mode, setMode] = useState<ImportMode>('replace_months');
  const [name, setName] = useState('');
  const [paste, setPaste] = useState('');
  /** the user's ticks for which of our rows the file replaces (cat → row → on); untouched rows follow our suggestion */
  const [ticks, setTicks] = useState<Record<string, Record<string, boolean>>>({});
  const input = useRef<HTMLInputElement>(null);

  const load = (r: string[][], src: string) => {
    const c = detectColumns(r);
    if (!c) { setErr('We couldn’t find a date column and an amount column in that table. Check it has a row of headings, then dates and amounts.'); return; }
    setErr(null); setRows(r); setSource(src); setCols(c);
    setOrder(guessDateOrder(r.slice(c.header + 1).map((x) => x[c.date] ?? '')));
    setSigns(r.slice(c.header + 1).some((x) => /^\s*[-(−]/.test(x[c.amount] ?? '')) ? 'signed' : 'direction');
    if (!lockCategory) setSingle(c.category === null ? '' : null);
    const names = categoryNames(r, c);
    setMap(Object.fromEntries(names.map((n) => [n, matchCategory(n, categories) ?? ''])));
    setName(src.replace(/\.(xlsx|xlsm|xls|csv|txt|tsv)$/i, '').slice(0, 40) || 'Imported schedule');
    setStep(1);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try { load(await readTableFile(f), f.name); } catch (e) { setErr(`We couldn’t read ${f.name}: ${(e as Error).message}`); }
  };

  const names = rows && cols ? categoryNames(rows, cols) : [];
  const useCatColumn = single === null && cols?.category !== null;
  const result = useMemo(() => (rows && cols ? buildImport(rows, { columns: cols, dateOrder: order, singleCategory: useCatColumn ? null : single || null, categoryMap: map, signs, categories }) : null), [rows, cols, order, single, map, signs, categories, useCatColumn]);
  const range = { from: b.fc.start, to: b.fc.start + b.fc.H - 1 };
  const summary = useMemo(() => {
    if (!result) return [];
    const by = new Map<string, { n: number; total: number; first: number; last: number; outside: number }>();
    for (const l of result.lines) {
      const s = by.get(l.categoryId) ?? { n: 0, total: 0, first: Infinity, last: -Infinity, outside: 0 };
      if (l.day < range.from || l.day > range.to) s.outside++;
      else { s.n++; s.total += l.amount; s.first = Math.min(s.first, l.day); s.last = Math.max(s.last, l.day); }
      by.set(l.categoryId, s);
    }
    return [...by.entries()].map(([id, s]) => ({ id, name: categories.find((c) => c.id === id)?.name ?? id, ...s }));
  }, [result, categories, range.from, range.to]);

  // our rows in each line, and which the file replaces
  const ourRowsOf = (cat: string) => (b.fc.grid[cat]?.rows ?? []).filter((r) => r.editable && r.kind !== 'custom' && !r.removed).map((r) => ({ key: r.key, label: r.kind === 'series' ? r.label.replace(/\S*#\S*/g, '').trim() : r.label }));
  const suggested = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!result) return out;
    for (const s of summary) {
      const names = [...new Set(result.lines.filter((l) => l.categoryId === s.id).flatMap((l) => [l.source, l.description]).filter(Boolean))];
      out[s.id] = suggestReplacedRows(names, ourRowsOf(s.id));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, summary]);
  const replaced = (cat: string) => ourRowsOf(cat).map((r) => r.key).filter((k) => ticks[cat]?.[k] ?? suggested[cat]?.includes(k));

  const steps = useCatColumn ? STEPS : STEPS.filter((_, i) => i !== 2);
  const label = useCatColumn ? STEPS[step] : STEPS[step];
  const go = (d: number) => { let n = step + d; if (!useCatColumn && n === 2) n += d; setStep(n); };

  const apply = () => {
    if (!result) return;
    const rowName = name.trim() || 'Imported schedule';
    // each replaced row is cleared only in the months the file has figures for that payment
    // (or, if the file doesn't name it, every month the file covers for the line)
    const ourRows: ReplacedRows = {};
    for (const s of summary) {
      if (mode !== 'replace_months') continue;
      const labels = new Map(ourRowsOf(s.id).map((r) => [r.key, r.label]));
      const catLines = result.lines.filter((l) => l.categoryId === s.id && l.day >= range.from && l.day <= range.to);
      ourRows[s.id] = replaced(s.id).map((row) => {
        const named = catLines.filter((l) => namesMatch([l.source, l.description], labels.get(row) ?? ''));
        return named.length ? { row, months: [...new Set(named.map((l) => isoFromDay(l.day).slice(0, 7)))] } : { row };
      });
    }
    const { overrides } = importToOverrides(result.lines, rowName, mode, ourRows, range);
    const cats = new Set(summary.map((s) => s.id));
    // the replaced rows' months: any earlier edits there give way to the file
    const cleared = new Set(overrides.filter((o) => !o.date && o.amount === 0).map((o) => `${o.categoryId}|${o.row}|${o.month}`));
    upd((s) => ({
      ...s,
      // importing again under the same name replaces the earlier import
      overrides: [...(s.overrides ?? []).filter((o) => !(cats.has(o.categoryId) && (o.row === `custom:${rowName}` || o.source === rowName)) && !cleared.has(`${o.categoryId}|${o.row}|${o.month}`)), ...overrides],
      settings: mode === 'replace_all' ? { ...s.settings, methodByCategory: { ...s.settings.methodByCategory, ...Object.fromEntries([...cats].map((id) => [id, 'manual' as const])) } } : s.settings,
    }));
    toast(`Imported ${int(summary.reduce((t, x) => t + x.n, 0))} figures into ${summary.length} line${summary.length > 1 ? 's' : ''}`, 'ok');
    onClose();
  };

  const unmatched = names.filter((n) => map[n] === undefined || map[n] === '').length;
  const canNext = step === 1 ? (!!cols && (useCatColumn || !!single)) : step === 2 ? true : true;

  return (
    <Modal wide title={<>Import a schedule <span className="muted small" style={{ fontWeight: 500 }}>· step {steps.indexOf(label) + 1} of {steps.length}: {label}</span></>} onClose={onClose}
      footer={step === 0 ? <button className="btn" onClick={onClose}>Cancel</button> : <>
        <button className="btn" onClick={() => go(-1)}><i className="bi bi-arrow-left" /> Back</button>
        <span className="spacer" />
        {step < 3 ? <button className="btn primary" disabled={!canNext} onClick={() => go(1)}>Next <i className="bi bi-arrow-right" /></button>
          : <button className="btn primary" disabled={!summary.some((s) => s.n)} onClick={apply}><i className="bi bi-check-lg" /> Add to the forecast</button>}
      </>}>
      {step === 0 && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="small" style={{ margin: 0 }}>A table with a <strong>date</strong>, an <strong>amount</strong> and (ideally) a <strong>category</strong> on each row, such as a grant schedule from Finance or a payroll forecast from HR. Other columns are fine. It’s read on this computer only.</p>
          <div className="dropzone" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files?.[0]); }}>
            <i className="bi bi-file-earmark-spreadsheet big-icon" />
            <div><strong>Choose an Excel or CSV file</strong>, or drag it here</div>
            <div className="xs muted">.xlsx, .xls, .csv or .txt. The first sheet with data is used.</div>
          </div>
          <input ref={input} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="field"><label>…or paste the table here (copy the cells in Excel, including the headings)</label>
            <textarea className="input" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Date\tCategory\tAmount\n07/05/2026\tHousing benefit subsidy\t3,300,000'} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} /></div>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={!paste.trim()} onClick={() => load(readTableText(paste), 'Pasted schedule')}>Use the pasted table <i className="bi bi-arrow-right" /></button></div>
          {err && <div className="callout red small">{err}</div>}
        </div>
      )}

      {step === 1 && rows && cols && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="small" style={{ margin: 0 }}>We’ve read <strong>{source}</strong> ({int(rows.length - cols.header - 1)} rows) and picked out the columns below. Change any that are wrong.</p>
          <div className="imp-cols">
            <ColPick label="Date" value={cols.date} rows={rows} cols={cols} onChange={(v) => setCols({ ...cols, date: v })} />
            <ColPick label="Amount" value={cols.amount} rows={rows} cols={cols} onChange={(v) => setCols({ ...cols, amount: v })} />
            <div className="field"><label>Category</label>
              <select className="select" value={single !== null ? 'one' : String(cols.category ?? -1)} disabled={!!lockCategory}
                onChange={(e) => { if (e.target.value === 'one') setSingle(''); else { setSingle(null); setCols({ ...cols, category: +e.target.value }); } }}>
                {rows[cols.header >= 0 ? cols.header : 0].map((h, j) => <option key={j} value={j}>{cols.header >= 0 ? h || `Column ${j + 1}` : `Column ${j + 1}`}</option>)}
                <option value="one">Every row is the same category…</option>
              </select>
              {single !== null && (
                <select className="select mt" value={single} disabled={!!lockCategory} onChange={(e) => setSingle(e.target.value)}>
                  <option value="">Choose the category…</option>
                  {ops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </div>
            <div className="field"><label>Dates are written</label>
              <select className="select" value={order} onChange={(e) => setOrder(e.target.value as DateOrder)}>
                <option value="DMY">Day first (07/05/2026 = 7 May)</option><option value="MDY">Month first (05/07/2026 = 7 May)</option>
              </select></div>
            <div className="field"><label>Amounts are</label>
              <select className="select" value={signs} onChange={(e) => setSigns(e.target.value as 'direction' | 'signed')}>
                <option value="direction">All positive: money in or out depends on the category</option>
                <option value="signed">Signed: positive is money in, negative is money out</option>
              </select></div>
          </div>
          <Preview rows={rows} cols={cols} />
        </div>
      )}

      {step === 2 && (
        <div className="stack" style={{ gap: 10 }}>
          <p className="small" style={{ margin: 0 }}>Tell us which of our categories each of theirs belongs to. We’ve matched what we could{unmatched ? <>; <strong>{unmatched}</strong> need{unmatched === 1 ? 's' : ''} you</> : ''}.</p>
          <table className="tbl tbl-sm">
            <thead><tr><th>In their file</th><th className="num">Rows</th><th>Our category</th></tr></thead>
            <tbody>{names.map((n) => (
              <tr key={n} className={map[n] ? '' : 'warn'}>
                <td>{n}</td>
                <td className="num">{int(rows!.slice(cols!.header + 1).filter((r) => (r[cols!.category!] ?? '').trim() === n).length)}</td>
                <td><select className="select sm" value={map[n] ?? ''} onChange={(e) => setMap({ ...map, [n]: e.target.value })} style={{ width: 260 }}>
                  <option value="">Leave these rows out</option>
                  {ops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {step === 3 && result && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="field" style={{ maxWidth: 360 }}><label>Call these figures</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            <small className="muted">They appear as a row of this name in each line’s grid, so you can always see where they came from.</small></div>
          <table className="tbl tbl-sm">
            <thead><tr><th>Line</th><th className="num">Figures</th><th className="num">Total</th><th>From</th><th>To</th><th className="num">Outside the forecast</th></tr></thead>
            <tbody>{summary.map((s) => (
              <tr key={s.id}><td><strong>{s.name}</strong></td><td className="num">{int(s.n)}</td><td className="num">{money(s.total, { sign: true })}</td>
                <td>{s.n ? fmtDay(s.first) : '–'}</td><td>{s.n ? fmtDay(s.last) : '–'}</td><td className="num">{s.outside ? int(s.outside) : ''}</td></tr>
            ))}</tbody>
          </table>
          {result.skipped.length > 0 && (
            <details className="small"><summary>{result.skipped.length} row{result.skipped.length > 1 ? 's' : ''} left out</summary>
              <ul className="list-plain xs">{result.skipped.slice(0, 30).map((s) => <li key={s.row}>Row {s.row}: {s.reason}</li>)}</ul></details>
          )}
          <div className="field"><label>How should they be used?</label>
            <div className="imp-modes">
              {([
                ['replace_months', 'Replace some of our figures for the months the file covers', 'Tick below which of our rows the file replaces. Everything else in those lines stays.'],
                ['replace_all', 'Replace our forecast for these lines entirely', 'Only the file’s figures count for these lines, for the whole forecast.'],
                ['add', 'Add on top of our forecast', 'For extra money our forecast doesn’t know about, such as a new grant.'],
              ] as [ImportMode, string, string][]).map(([v, t, d]) => (
                <label key={v} className={`imp-mode ${mode === v ? 'on' : ''}`}><input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} /><span><strong>{t}</strong><small>{d}</small></span></label>
              ))}
            </div>
          </div>
          {mode === 'replace_months' && (
            <div className="stack" style={{ gap: 8 }}>
              {summary.filter((x) => x.n).map((x) => {
                const rows = ourRowsOf(x.id);
                const on = replaced(x.id);
                return (
                  <div key={x.id} className="imp-replace">
                    <div className="small"><strong>{x.name}</strong>: the file replaces{on.length ? '' : <span className="warn-text"> nothing yet. We couldn’t tell which of ours it covers, so its figures will be added on top unless you tick a row.</span>}</div>
                    <div className="imp-ticks">{rows.map((r) => (
                      <label key={r.key} className={`chip ${on.includes(r.key) ? 'on' : ''}`}>
                        <input type="checkbox" checked={on.includes(r.key)} onChange={(ev) => setTicks({ ...ticks, [x.id]: { ...(ticks[x.id] ?? {}), [r.key]: ev.target.checked } })} /> {r.label}
                      </label>
                    ))}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ColPick({ label, value, rows, cols, onChange }: { label: string; value: number; rows: string[][]; cols: ImportColumns; onChange: (v: number) => void }) {
  const head = rows[cols.header >= 0 ? cols.header : 0];
  return (
    <div className="field"><label>{label}</label>
      <select className="select" value={value} onChange={(e) => onChange(+e.target.value)}>
        {head.map((h, j) => <option key={j} value={j}>{cols.header >= 0 ? h || `Column ${j + 1}` : `Column ${j + 1}`}</option>)}
      </select></div>
  );
}

function Preview({ rows, cols }: { rows: string[][]; cols: ImportColumns }) {
  const head = cols.header >= 0 ? rows[cols.header] : rows[0].map((_, j) => `Column ${j + 1}`);
  const tag = (j: number) => (j === cols.date ? 'date' : j === cols.amount ? 'amount' : j === cols.category ? 'category' : j === cols.description ? 'description' : '');
  return (
    <div className="table-wrap imp-preview">
      <table className="tbl tbl-sm">
        <thead><tr>{head.map((h, j) => <th key={j}>{h}{tag(j) && <span className="badge soft" style={{ marginLeft: 6 }}>{tag(j)}</span>}</th>)}</tr></thead>
        <tbody>{rows.slice(cols.header + 1, cols.header + 7).map((r, i) => <tr key={i}>{head.map((_, j) => <td key={j} className={tag(j) ? 'hl' : 'muted'}>{r[j]}</td>)}</tr>)}</tbody>
      </table>
      <div className="xs muted" style={{ padding: '4px 8px' }}>The first rows of the file. Highlighted columns are the ones we’ll use.</div>
    </div>
  );
}
