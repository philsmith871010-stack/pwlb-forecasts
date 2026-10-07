// A category's forecast, month by month, as an Excel-like grid: one row per regular payment,
// one for everything else, and any rows the user adds (e.g. a grant they've been told about).
// Typing or pasting over a cell replaces our figure for that month; clearing it brings ours back.
import { useState } from 'react';
import type { Scenario, GridOverride, Assumption } from '../../lib/model';
import { uid } from '../../lib/model';
import type { CategoryGrid, GridRow } from '../../lib/forecast/engine';
import { MONTH_NAMES } from '../../lib/dates';

type Upd = (fn: (s: Scenario) => Scenario) => void;

const monthLabel = (m: string) => { const [y, mm] = m.split('-').map(Number); return `${MONTH_NAMES[mm - 1]} ${String(y).slice(2)}`; };
const fmt = (v: number) => (Math.abs(v) < 0.5 ? '' : Math.round(v).toLocaleString('en-GB'));
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
export const niceRowName = (sig: string) => sig.replace(/\S*#\S*/g, '').replace(/\s+/g, ' ').trim() || sig;

export function GridEditor({ sc, upd, catId, grid, inflow, start }: { sc: Scenario; upd: Upd; catId: string; grid: CategoryGrid; inflow: boolean; start: string }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [bad, setBad] = useState<string | null>(null);
  const sign = inflow ? 1 : -1;
  const editable = grid.rows.filter((r) => r.editable);

  /** set (or clear, with null) a block of cells; amounts are as shown (positive = the line's own direction) */
  const setCells = (cells: { row: string; month: string; shown: number | null }[]) => upd((s) => {
    const keys = new Set(cells.map((c) => `${c.row}|${c.month}`));
    const rest = (s.overrides ?? []).filter((o) => !(o.categoryId === catId && keys.has(`${o.row}|${o.month}`)));
    const add: GridOverride[] = cells.filter((c) => c.shown !== null).map((c) => ({ categoryId: catId, row: c.row, month: c.month, amount: sign * (c.shown as number) || 0 }));
    return { ...s, overrides: [...rest, ...add] };
  });

  const commit = (r: GridRow, k: number, text: string) => {
    const v = parseCell(text);
    if (v !== null && isNaN(v)) { setBad(`“${text}” isn’t a number. Use figures like 2,500,000 or 2.5m.`); return; }
    setBad(null);
    const shown = sign * r.values[k];
    if (v === null) { if (r.overridden[k]) setCells([{ row: r.key, month: grid.months[k], shown: null }]); return; }
    if (!r.overridden[k] && Math.abs(v - shown) < 0.5) return; // unchanged
    setCells([{ row: r.key, month: grid.months[k], shown: v }]);
  };

  const paste = (ri: number, k: number, text: string) => {
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l.length || i < a.length - 1);
    const cells: { row: string; month: string; shown: number | null }[] = [];
    let skipped = 0;
    lines.forEach((line, dy) => {
      const row = editable[ri + dy];
      if (!row) { skipped++; return; }
      line.split('\t').forEach((cell, dx) => {
        const month = grid.months[k + dx];
        if (!month) { skipped++; return; }
        const v = parseCell(cell);
        if (v !== null && isNaN(v)) { skipped++; return; }
        cells.push({ row: row.key, month, shown: v });
      });
    });
    if (cells.length) setCells(cells);
    setBad(skipped ? `${skipped} pasted cell${skipped > 1 ? 's' : ''} didn’t fit the grid or weren’t numbers, so were left out.` : null);
  };

  const removeSeries = (r: GridRow, removed: boolean) => upd((s) => {
    const sig = r.key.slice(7);
    const rest = s.assumptions.filter((a) => !(a.kind === 'stop' && a.signature === sig && a.categoryId === catId));
    return { ...s, assumptions: removed ? rest : [...rest, { id: uid('as'), kind: 'stop', categoryId: catId, signature: sig, from: start } as Assumption] };
  });
  const clearRow = (r: GridRow) => upd((s) => ({ ...s, overrides: (s.overrides ?? []).filter((o) => !(o.categoryId === catId && o.row === r.key)) }));
  const addRow = () => {
    const name = newName.trim();
    if (!name) return;
    setCells([{ row: `custom:${name}`, month: grid.months[0], shown: 0 }]);
    setAdding(false); setNewName('');
  };

  const move = (el: HTMLInputElement, dy: number, dx: number) => {
    const td = el.closest('td'); const tr = el.closest('tr');
    if (!td || !tr) return;
    const col = Array.from(tr.children).indexOf(td);
    let target: Element | null = null;
    if (dy) { let row: Element | null = tr; do { row = dy > 0 ? row.nextElementSibling : row.previousElementSibling; } while (row && !row.children[col]?.querySelector('input')); target = row?.children[col]?.querySelector('input') ?? null; }
    if (dx) target = tr.children[col + dx]?.querySelector('input') ?? null;
    (target as HTMLInputElement | null)?.focus();
    (target as HTMLInputElement | null)?.select();
  };

  const colTotals = grid.months.map((_, k) => grid.rows.reduce((t, r) => t + (r.removed ? 0 : r.values[k]), 0));
  const anyOverride = grid.rows.some((r) => r.overridden.some(Boolean));

  return (
    <div className="grid-editor">
      <div className="ge-help small">
        Amounts {inflow ? 'received' : 'paid'} each month. <strong>Type over any cell</strong>, or <strong>paste from Excel</strong> (click a cell, then Ctrl+V / ⌘V; a whole block of rows and months works).
        Your figures are used exactly as typed. Empty a cell to go back to ours.
      </div>
      {bad && <div className="callout red small mt">{bad}</div>}
      <div className="ge-scroll">
        <table className="ge-table">
          <thead>
            <tr><th className="ge-name">Row</th>{grid.months.map((m) => <th key={m}>{monthLabel(m)}</th>)}<th className="ge-tot">Total</th><th /></tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => {
              const ri = editable.indexOf(r);
              const total = r.values.reduce((t, v) => t + v, 0);
              return (
                <tr key={r.key} className={`${r.editable ? '' : 'ro'} ${r.removed ? 'removed' : ''}`}>
                  <td className="ge-name" title={r.label}>
                    {r.kind === 'series' ? niceRowName(r.label) : r.label}
                    {r.kind === 'custom' && <span className="badge soft" style={{ marginLeft: 6 }}>yours</span>}
                    {!r.editable && <span className="xs muted"> (from elsewhere)</span>}
                  </td>
                  {r.values.map((v, k) => (
                    <td key={k} className={r.overridden[k] ? 'ov' : ''}>
                      {r.editable && !r.removed ? (
                        <input key={`${r.key}|${k}|${v}|${r.overridden[k]}`} defaultValue={r.overridden[k] ? (Math.round(sign * v) || 0).toLocaleString('en-GB') : fmt(sign * v)} inputMode="decimal" aria-label={`${r.label}, ${monthLabel(grid.months[k])}`}
                          onFocus={(e) => e.target.select()}
                          onBlur={(e) => commit(r, k, e.target.value)}
                          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\t\n]/.test(t.trim())) { e.preventDefault(); paste(ri, k, t); } }}
                          onKeyDown={(e) => {
                            const el = e.currentTarget;
                            if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); el.blur(); move(el, 1, 0); }
                            else if (e.key === 'ArrowUp') { e.preventDefault(); el.blur(); move(el, -1, 0); }
                            else if (e.key === 'Escape') { el.value = fmt(sign * v); el.blur(); }
                          }} />
                      ) : <span>{fmt(sign * v)}</span>}
                    </td>
                  ))}
                  <td className="ge-tot">{fmt(sign * total)}</td>
                  <td className="ge-act">
                    {r.kind === 'series' && <button className="link-btn xs" onClick={() => removeSeries(r, !!r.removed)} title={r.removed ? 'Bring this payment back' : 'Take this payment out of the forecast'}>{r.removed ? 'Restore' : 'Remove'}</button>}
                    {r.kind !== 'custom' && r.overridden.some(Boolean) && <button className="link-btn xs" onClick={() => clearRow(r)}>Undo edits</button>}
                    {r.kind === 'custom' && <button className="link-btn xs" onClick={() => clearRow(r)}>Delete row</button>}
                  </td>
                </tr>
              );
            })}
            <tr className="ge-total"><td className="ge-name">Total</td>{colTotals.map((v, k) => <td key={k}>{fmt(sign * v)}</td>)}<td className="ge-tot">{fmt(sign * colTotals.reduce((t, v) => t + v, 0))}</td><td /></tr>
          </tbody>
        </table>
      </div>
      <div className="row mt" style={{ gap: 10 }}>
        {adding ? (
          <>
            <input className="input" autoFocus placeholder="e.g. New homes grant" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addRow(); if (e.key === 'Escape') setAdding(false); }} style={{ width: 240 }} />
            <button className="btn sm primary" disabled={!newName.trim()} onClick={addRow}>Add row</button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
          </>
        ) : <button className="btn sm" onClick={() => setAdding(true)}><i className="bi bi-plus-lg" /> Add a row</button>}
        <span className="xs muted">For money not in your history, such as a grant you’ve been told about.</span>
        <span className="spacer" />
        {anyOverride && <span className="xs muted"><span className="ge-swatch" /> = your figures ({grid.rows.reduce((t, r) => t + r.overridden.filter(Boolean).length, 0)})</span>}
      </div>
    </div>
  );
}
