// A category's forecast as an Excel-like grid, by month or by day: one column/row per
// regular payment, one for everything else, and any the user adds (e.g. a grant they've been
// told about). Typing or pasting over a cell replaces our figure; emptying it brings ours back.
import { useMemo, useState } from 'react';
import type { Scenario, GridOverride, Assumption } from '../../lib/model';
import { uid } from '../../lib/model';
import type { CategoryGrid, GridRow } from '../../lib/forecast/engine';
import { MONTH_NAMES, isoFromDay, isBusinessDay, isBankHoliday, weekday } from '../../lib/dates';
import { parsePaste } from '../../lib/forecast/paste';

type Upd = (fn: (s: Scenario) => Scenario) => void;
/** one cell to set (shown = as displayed, positive in the line's own direction) or clear (null) */
export type Cell = { row: string; month: string; date?: string; shown: number | null };

const monthLabel = (m: string) => { const [y, mm] = m.split('-').map(Number); return `${MONTH_NAMES[mm - 1]} ${String(y).slice(2)}`; };
const fmt = (v: number) => (Math.abs(v) < 0.5 ? '' : Math.round(v).toLocaleString('en-GB'));
const fmtOv = (v: number) => (Math.round(v) || 0).toLocaleString('en-GB');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "1,234", "£1,234.50", "(1,234)", "-1234", "1.2m", "250k" → number; empty → null */
export function parseCell(t: string): number | null {
  const s = t.trim().replace(/[£,\s]/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-') || s.startsWith('−');
  const m = s.replace(/[()−-]/g, '').match(/^(\d*\.?\d+)([km]?)$/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1);
  return neg && v ? -v : v;
}
/** Apply a batch of cells to the overrides. Month totals replace any day figures in that month
 *  for the row; a day figure in a month that had a total keeps the month's other days as they
 *  stood (they become day figures), so nothing else moves. */
export function applyCells(overrides: GridOverride[], cells: Cell[], o: { catId: string; sign: number; grid: CategoryGrid; dayIso: string[] }): GridOverride[] {
  const { catId, sign, grid, dayIso } = o;
  let ov = overrides;
  const mine = (x: GridOverride) => x.categoryId === catId;
  for (const c of cells.filter((x) => !x.date)) ov = ov.filter((x) => !(mine(x) && x.row === c.row && x.month === c.month));
  const dayCells = cells.filter((x) => x.date);
  const dayKeys = new Set(dayCells.map((c) => `${c.row}\u0001${c.date}`));
  ov = ov.filter((x) => !(mine(x) && x.date && dayKeys.has(`${x.row}\u0001${x.date}`)));
  const extra: GridOverride[] = [];
  for (const [row, month] of [...new Set(dayCells.map((c) => `${c.row}\u0001${c.month}`))].map((k) => k.split('\u0001') as [string, string])) {
    if (!ov.some((x) => mine(x) && x.row === row && x.month === month && !x.date)) continue;
    ov = ov.filter((x) => !(mine(x) && x.row === row && x.month === month && !x.date));
    const r = grid.rows.find((x) => x.key === row);
    if (r) dayIso.forEach((iso, d) => {
      if (iso.slice(0, 7) === month && Math.abs(r.daily[d]) >= 0.005 && !dayKeys.has(`${row}\u0001${iso}`) && !r.dayOverridden[d]) extra.push({ categoryId: catId, row, month, date: iso, amount: r.daily[d] });
    });
  }
  const add: GridOverride[] = cells.filter((c) => c.shown !== null).map((c) => ({ categoryId: catId, row: c.row, month: c.month, ...(c.date ? { date: c.date } : {}), amount: sign * (c.shown as number) || 0 }));
  return [...ov, ...extra, ...add];
}

export const niceRowName = (sig: string) => sig.replace(/\S*#\S*/g, '').replace(/\s+/g, ' ').trim() || sig;
const rowName = (r: GridRow) => (r.kind === 'series' ? niceRowName(r.label) : r.label);

/** Arrow keys / Enter move between inputs in the same table, like a spreadsheet. */
function move(el: HTMLInputElement, dy: number, dx: number) {
  const td = el.closest('td'); const tr = el.closest('tr');
  if (!td || !tr) return;
  const col = Array.from(tr.children).indexOf(td);
  let target: Element | null = null;
  if (dy) { let row: Element | null = tr; do { row = dy > 0 ? row.nextElementSibling : row.previousElementSibling; } while (row && !row.children[col]?.querySelector('input')); target = row?.children[col]?.querySelector('input') ?? null; }
  if (dx) { let k = col + dx; while (tr.children[k] && !tr.children[k].querySelector('input')) k += dx; target = tr.children[k]?.querySelector('input') ?? null; }
  (target as HTMLInputElement | null)?.focus();
}
const keys = (v: () => string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
  const el = e.currentTarget;
  if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); el.blur(); move(el, 1, 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); el.blur(); move(el, -1, 0); }
  else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length) { e.preventDefault(); el.blur(); move(el, 0, 1); }
  else if (e.key === 'ArrowLeft' && el.selectionStart === 0 && el.selectionEnd === 0) { e.preventDefault(); el.blur(); move(el, 0, -1); }
  else if (e.key === 'Escape') { el.value = v(); el.blur(); }
};

export function GridEditor({ upd, catId, grid, inflow, start }: { sc: Scenario; upd: Upd; catId: string; grid: CategoryGrid; inflow: boolean; start: string }) {
  const [view, setView] = useState<'month' | 'day'>('month');
  const [monthIdx, setMonthIdx] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const sign = inflow ? 1 : -1;
  const editable = grid.rows.filter((r) => r.editable && !r.removed);
  const H = grid.rows[0]?.daily.length ?? 0;
  const dayIso = useMemo(() => Array.from({ length: H }, (_, d) => isoFromDay(grid.start + d)), [H, grid.start]);

  /** Apply a batch of cells. Month totals replace any day figures in that month for the row;
   *  a day figure in a month that had a total keeps the month's other days as they stood. */
  const setCells = (cells: Cell[]) => upd((s) => ({ ...s, overrides: applyCells(s.overrides ?? [], cells, { catId, sign, grid, dayIso }) }));

  const check = (text: string) => {
    const v = parseCell(text);
    if (v !== null && isNaN(v)) { setMsg({ bad: true, text: `“${text}” isn’t a number. Use figures like 2,500,000 or 2.5m.` }); return undefined; }
    setMsg(null);
    return v;
  };

  /** A pasted dated or monthly list (label in the first column, amount in the last) goes into one row by date. */
  const pasteList = (row: GridRow, text: string): boolean => {
    const p = parsePaste(text);
    if (!p.kind || p.kind === 'years' || p.rows.length < 1) return false;
    const cells: Cell[] = [];
    let outside = 0;
    for (const r of p.rows) {
      if (p.kind === 'dates') {
        const iso = isoFromDay(r.day!);
        if (!dayIso.includes(iso)) { outside++; continue; }
        cells.push({ row: row.key, month: iso.slice(0, 7), date: iso, shown: r.amount });
      } else {
        const m = `${r.month!.y}-${String(r.month!.m).padStart(2, '0')}`;
        if (!grid.months.includes(m)) { outside++; continue; }
        cells.push({ row: row.key, month: m, shown: r.amount });
      }
    }
    if (!cells.length) { setMsg({ bad: true, text: 'None of the pasted dates fall inside the forecast period.' }); return true; }
    setCells(cells);
    setMsg({ text: `${cells.length} ${p.kind === 'dates' ? 'dated' : 'monthly'} figure${cells.length > 1 ? 's' : ''} placed in “${rowName(row)}”${outside ? `; ${outside} outside the forecast period left out` : ''}${p.skipped.length ? `; ${p.skipped.length} line${p.skipped.length > 1 ? 's' : ''} skipped (a heading, or no amount)` : ''}.` });
    return true;
  };

  /** A pasted block: rows of the clipboard go down, columns go across, from the cell clicked. */
  const pasteBlock = (text: string, at: (dy: number, dx: number) => Cell | null) => {
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const cells: Cell[] = [];
    let skipped = 0;
    lines.forEach((line, dy) => line.split('\t').forEach((v, dx) => {
      const c = at(dy, dx);
      const n = parseCell(v);
      if (!c || (n !== null && isNaN(n))) { skipped++; return; }
      cells.push({ ...c, shown: n });
    }));
    if (cells.length) setCells(cells);
    setMsg(skipped ? { bad: true, text: `${skipped} pasted cell${skipped > 1 ? 's' : ''} didn’t fit the grid or weren’t numbers, so were left out.` } : { text: `${cells.length} cell${cells.length > 1 ? 's' : ''} pasted.` });
  };

  const onPaste = (row: GridRow, block: (text: string) => void) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(t.trim())) return; // a single value: let the browser paste it into the cell
    e.preventDefault();
    const first = t.trim().split('\n')[0].split('\t');
    if (first.length >= 2 && isNaN(parseCell(first[0]) as number) && pasteList(row, t)) return;
    block(t);
  };

  const removeSeries = (r: GridRow, removed: boolean) => upd((s) => {
    const sig = r.key.slice(7);
    const rest = s.assumptions.filter((a) => !(a.kind === 'stop' && a.signature === sig && a.categoryId === catId));
    return { ...s, assumptions: removed ? rest : [...rest, { id: uid('as'), kind: 'stop', categoryId: catId, signature: sig, from: start } as Assumption] };
  });
  // deleting an imported row also removes what that import replaced
  const clearRow = (r: GridRow) => upd((s) => ({ ...s, overrides: (s.overrides ?? []).filter((o) => !(o.categoryId === catId && (o.row === r.key || (r.kind === 'custom' && o.source === r.key.slice(7))))) }));
  const addRow = () => {
    const name = newName.trim();
    if (!name) return;
    setCells([{ row: `custom:${name}`, month: grid.months[0], shown: 0 }]);
    setAdding(false); setNewName('');
  };
  const nYours = grid.rows.reduce((t, r) => t + r.overridden.filter(Boolean).length, 0);

  return (
    <div className="grid-editor">
      <div className="row ge-top">
        <div className="seg" role="tablist" aria-label="Grid view">
          <button className={view === 'month' ? 'on' : ''} onClick={() => setView('month')}>By month</button>
          <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}>By day</button>
        </div>
        <span className="ge-help small">
          Amounts {inflow ? 'received' : 'paid'}. <strong>Type over any cell</strong> or <strong>paste from Excel</strong>: click a cell, then Ctrl+V / ⌘V.
          A block fills across and down; a list of <em>dates and amounts</em> goes into that {view === 'day' ? 'column' : 'row'} on its dates. Empty a cell to go back to our figure.
        </span>
      </div>
      {msg && <div className={`callout ${msg.bad ? 'red' : 'green'} small mt`}>{msg.text}</div>}

      {view === 'month' ? (
        <div className="ge-scroll">
          <table className="ge-table">
            <thead><tr><th className="ge-name">Row</th>{grid.months.map((m) => <th key={m}>{monthLabel(m)}</th>)}<th className="ge-tot">Total</th><th /></tr></thead>
            <tbody>
              {grid.rows.map((r) => {
                const ri = editable.indexOf(r);
                const total = r.values.reduce((t, v) => t + v, 0);
                return (
                  <tr key={r.key} className={`${r.editable ? '' : 'ro'} ${r.removed ? 'removed' : ''}`}>
                    <td className="ge-name" title={r.label}>{rowName(r)}{r.kind === 'custom' && <span className="badge soft" style={{ marginLeft: 6 }}>yours</span>}{!r.editable && <span className="xs muted"> (from elsewhere)</span>}</td>
                    {r.values.map((v, k) => (
                      <td key={k} className={`${r.overridden[k] ? 'ov' : ''} ${r.byDay[k] ? 'byday' : ''}`} title={r.byDay[k] ? 'Includes figures typed for single days: see By day' : undefined}>
                        {r.editable && !r.removed ? (
                          <input key={`${r.key}|${k}|${v}|${r.overridden[k]}`} defaultValue={r.overridden[k] ? fmtOv(sign * v) : fmt(sign * v)} inputMode="decimal" aria-label={`${rowName(r)}, ${monthLabel(grid.months[k])}`}
                            onFocus={(e) => e.target.select()}
                            onBlur={(e) => {
                              const n = check(e.target.value); if (n === undefined) return;
                              if (n === null) { if (r.overridden[k] && !r.byDay[k]) setCells([{ row: r.key, month: grid.months[k], shown: null }]); return; }
                              if (!r.overridden[k] && Math.abs(n - sign * v) < 0.5) return;
                              if (r.overridden[k] && Math.abs(n - sign * v) < 0.5) return;
                              setCells([{ row: r.key, month: grid.months[k], shown: n }]);
                            }}
                            onPaste={onPaste(r, (t) => pasteBlock(t, (dy, dx) => { const row = editable[ri + dy]; const m = grid.months[k + dx]; return row && m ? { row: row.key, month: m, shown: null } : null; }))}
                            onKeyDown={keys(() => (r.overridden[k] ? fmtOv(sign * v) : fmt(sign * v)))} />
                        ) : <span>{fmt(sign * v)}</span>}
                      </td>
                    ))}
                    <td className="ge-tot">{fmt(sign * total)}</td>
                    <td className="ge-act">
                      {r.kind === 'series' && <button className="link-btn xs" onClick={() => removeSeries(r, !!r.removed)}>{r.removed ? 'Restore' : 'Remove'}</button>}
                      {r.kind !== 'custom' && r.overridden.some(Boolean) && <button className="link-btn xs" onClick={() => clearRow(r)}>Undo edits</button>}
                      {r.kind === 'custom' && <button className="link-btn xs" onClick={() => clearRow(r)}>Delete row</button>}
                    </td>
                  </tr>
                );
              })}
              <tr className="ge-total"><td className="ge-name">Total</td>{grid.months.map((_, k) => <td key={k}>{fmt(sign * grid.rows.reduce((t, r) => t + (r.removed ? 0 : r.values[k]), 0))}</td>)}
                <td className="ge-tot">{fmt(sign * grid.rows.reduce((t, r) => t + (r.removed ? 0 : r.values.reduce((a, b) => a + b, 0)), 0))}</td><td /></tr>
            </tbody>
          </table>
        </div>
      ) : (
        <DayView grid={grid} sign={sign} dayIso={dayIso} monthIdx={monthIdx} setMonthIdx={setMonthIdx} editable={editable}
          setCells={setCells} check={check} onPaste={onPaste} pasteBlock={pasteBlock} />
      )}

      <div className="row mt" style={{ gap: 10 }}>
        {adding ? (
          <>
            <input className="input" autoFocus placeholder="e.g. New homes grant" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addRow(); if (e.key === 'Escape') setAdding(false); }} style={{ width: 240 }} />
            <button className="btn sm primary" disabled={!newName.trim()} onClick={addRow}>Add {view === 'day' ? 'column' : 'row'}</button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
          </>
        ) : <button className="btn sm" onClick={() => setAdding(true)}><i className="bi bi-plus-lg" /> Add a {view === 'day' ? 'column' : 'row'}</button>}
        <span className="xs muted">For money not in your history, such as a grant you’ve been told about.</span>
        <span className="spacer" />
        {nYours > 0 && <span className="xs muted"><span className="ge-swatch" /> your figure{view === 'month' ? <> · <span className="ge-mark" /> includes figures for single days (see By day)</> : ''} · 0 = set to zero by you</span>}
      </div>
    </div>
  );
}

function DayView({ grid, sign, dayIso, monthIdx, setMonthIdx, editable, setCells, check, onPaste, pasteBlock }: {
  grid: CategoryGrid; sign: number; dayIso: string[]; monthIdx: number; setMonthIdx: (k: number) => void; editable: GridRow[];
  setCells: (c: Cell[]) => void; check: (t: string) => number | null | undefined;
  onPaste: (row: GridRow, block: (text: string) => void) => (e: React.ClipboardEvent<HTMLInputElement>) => void;
  pasteBlock: (text: string, at: (dy: number, dx: number) => Cell | null) => void;
}) {
  const month = grid.months[monthIdx];
  const days = dayIso.map((iso, d) => ({ iso, d })).filter((x) => x.iso.slice(0, 7) === month);
  const ro = grid.rows.filter((r) => !r.editable);
  const cols = [...editable, ...ro];
  const monthTotal = cols.reduce((t, r) => t + days.reduce((a, x) => a + r.daily[x.d], 0), 0);
  return (
    <>
      <div className="row ge-monthbar">
        <button className="icon-btn" aria-label="Previous month" disabled={monthIdx === 0} onClick={() => setMonthIdx(monthIdx - 1)}><i className="bi bi-chevron-left" /></button>
        <select className="select sm" value={monthIdx} onChange={(e) => setMonthIdx(+e.target.value)} aria-label="Month">
          {grid.months.map((m, k) => <option key={m} value={k}>{monthLabel(m)}</option>)}
        </select>
        <button className="icon-btn" aria-label="Next month" disabled={monthIdx === grid.months.length - 1} onClick={() => setMonthIdx(monthIdx + 1)}><i className="bi bi-chevron-right" /></button>
        <span className="small muted">{monthLabel(month)}: {fmt(sign * monthTotal) || '0'} in total. Weekends and bank holidays are greyed. A long paste carries on into the following months. <span className="ge-swatch" /> your figure for the day; <span className="ge-swatch light" /> from a month total you typed.</span>
      </div>
      <div className="ge-scroll ge-days">
        <table className="ge-table">
          <thead><tr><th className="ge-name">Day</th>{cols.map((r) => <th key={r.key} title={r.label} className={r.editable ? '' : 'ro'}>{rowName(r)}</th>)}<th className="ge-tot">Total</th></tr></thead>
          <tbody>
            {days.map(({ iso, d }) => {
              const dayNum = grid.start + d;
              const off = !isBusinessDay(dayNum);
              const tot = cols.reduce((t, r) => t + r.daily[d], 0);
              return (
                <tr key={iso} className={off ? 'off' : ''}>
                  <td className="ge-name">{DOW[weekday(dayNum)]} {iso.slice(8)} {monthLabel(month).slice(0, 3)}{isBankHoliday(dayNum) && <span className="xs muted"> · bank holiday</span>}</td>
                  {cols.map((r, ci) => {
                    const v = r.daily[d];
                    const ov = !!r.dayOverridden[d];
                    const fromTotal = !ov && r.overridden[monthIdx] && !r.byDay[monthIdx] && Math.abs(v) >= 0.5;
                    return (
                      <td key={r.key} className={ov ? 'ov' : fromTotal ? 'ovm' : ''} title={fromTotal ? 'From the month total you typed' : undefined}>
                        {r.editable ? (
                          <input key={`${r.key}|${d}|${v}|${ov}`} defaultValue={ov ? fmtOv(sign * v) : fmt(sign * v)} inputMode="decimal" aria-label={`${rowName(r)}, ${iso}`}
                            onFocus={(e) => e.target.select()}
                            onBlur={(e) => {
                              const n = check(e.target.value); if (n === undefined) return;
                              if (n === null) { if (ov) setCells([{ row: r.key, month, date: iso, shown: null }]); else if (Math.abs(v) >= 0.5) setCells([{ row: r.key, month, date: iso, shown: 0 }]); return; }
                              if (Math.abs(n - sign * v) < 0.5) return;
                              setCells([{ row: r.key, month, date: iso, shown: n }]);
                            }}
                            onPaste={onPaste(r, (t) => pasteBlock(t, (dy, dx) => {
                              const dd = d + dy, col = editable[ci + dx];
                              if (dd >= dayIso.length || !col) return null;
                              return { row: col.key, month: dayIso[dd].slice(0, 7), date: dayIso[dd], shown: null };
                            }))}
                            onKeyDown={keys(() => (ov ? fmtOv(sign * v) : fmt(sign * v)))} />
                        ) : <span>{fmt(sign * v)}</span>}
                      </td>
                    );
                  })}
                  <td className="ge-tot">{fmt(sign * tot)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
