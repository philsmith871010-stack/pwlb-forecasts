import { useEffect, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { engine } from '../../worker/client';
import type { TxnFilter, TxnRow } from '../../worker/types';
import { useStore } from '../../state/store';
import { CatBadge, catByIdx } from './common';
import { day, money } from '../../lib/format';
import { FLAG_LABELS } from '../../lib/categorise/engine';

const EMPTY: string[] = [];

const PAGE = 200;
const COLS = '96px 120px minmax(220px, 2fr) 170px 120px 92px 90px';

/**
 * Virtualised transaction table: rows are fetched from the worker in pages as you scroll,
 * so even 750k rows only ever put a few dozen DOM rows on screen.
 */
export function TxnTable({ filter, height = 460, onRow, selectable, selected, onSelect }: {
  filter: TxnFilter; height?: number; onRow?: (r: TxnRow) => void;
  selectable?: boolean; selected?: Set<string>; onSelect?: (r: TxnRow, on: boolean) => void;
}) {
  const catVersion = useStore((s) => s.catVersion);
  const categories = useStore((s) => s.team.categories);
  const catIds = useStore((s) => s.cat?.catIds ?? EMPTY);
  const [total, setTotal] = useState(0);
  const [sums, setSums] = useState({ sumIn: 0, sumOut: 0 });
  const pages = useRef(new Map<number, TxnRow[]>());
  const [, force] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(filter) + catVersion;

  const load = useCallback(async (p: number) => {
    if (pages.current.has(p)) return;
    pages.current.set(p, []);
    const r = await engine().queryTxns(filter, p * PAGE, PAGE);
    pages.current.set(p, r.rows);
    setTotal(r.total);
    setSums({ sumIn: r.sumIn, sumOut: r.sumOut });
    force((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    pages.current = new Map();
    setTotal(0);
    void load(0);
  }, [key, load]);

  const v = useVirtualizer({ count: total, getScrollElement: () => parentRef.current, estimateSize: () => 34, overscan: 12 });
  const items = v.getVirtualItems();
  useEffect(() => {
    if (!items.length) return;
    const p0 = Math.floor(items[0].index / PAGE), p1 = Math.floor(items[items.length - 1].index / PAGE);
    for (let p = p0; p <= p1; p++) void load(p);
  }, [items, load]);

  const get = (i: number) => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE];
  const cols = selectable ? `32px ${COLS}` : COLS;

  return (
    <div className="vt">
      <div className="row xs muted" style={{ padding: '6px 10px' }}>
        <span><strong className="navy">{total.toLocaleString('en-GB')}</strong> transactions</span>
        <span>in <strong className="pos">{money(sums.sumIn)}</strong></span>
        <span>out <strong className="neg">{money(sums.sumOut)}</strong></span>
      </div>
      <div className="vt-head" style={{ gridTemplateColumns: cols }}>
        {selectable && <div />}
        <div>Date</div><div>Account</div><div>Narrative</div><div>Category</div><div className="num">Amount</div><div>Status</div><div>Flags</div>
      </div>
      <div ref={parentRef} className="vt-scroll" style={{ height }}>
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {items.map((it) => {
            const r = get(it.index);
            return (
              <div key={it.key} className="vt-row" style={{ gridTemplateColumns: cols, position: 'absolute', top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)`, cursor: onRow ? 'pointer' : undefined }}
                onClick={() => r && onRow?.(r)}>
                {!r ? <div style={{ gridColumn: '1 / -1' }} className="muted xs">Loading…</div> : (
                  <>
                    {selectable && <div onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select transaction" checked={selected?.has(r.key) ?? false} onChange={(e) => onSelect?.(r, e.target.checked)} /></div>}
                    <div className="mono xs">{day(r.day)}</div>
                    <div className="xs muted" title={r.account}>{r.account}</div>
                    <div title={`${r.narrative}\nSignature: ${r.signature}\nRule: ${r.rule}\nSource: ${r.file} line ${r.line}`}>{r.narrative}</div>
                    <div><CatBadge cat={catByIdx(categories, catIds, r.catIdx)} uncategorised={r.catIdx < 0} /></div>
                    <div className={`num ${r.amount < 0 ? 'neg' : ''}`}>{money(r.amount)}</div>
                    <div>{r.deal === 1 ? <span className="badge navy">Deal</span> : r.deal === 2 ? <span className="badge amber">Suspected</span> : r.oneOff ? <span className="badge soft">One-off</span> : <span className="badge grey">Recurring</span>}</div>
                    <div className="xs muted" title={FLAG_LABELS.filter(([f]) => r.flags & f).map(([, l]) => l).join(', ')}>{FLAG_LABELS.filter(([f]) => r.flags & f).length ? <i className="bi bi-flag-fill orange" /> : ''} {FLAG_LABELS.filter(([f]) => r.flags & f).length || ''}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {total === 0 && <div className="empty small">No transactions match.</div>}
      </div>
    </div>
  );
}
