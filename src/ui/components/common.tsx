import { ReactNode, useEffect, useRef, useState } from 'react';
import { useStore, stepsFor } from '../../state/store';
import type { Category } from '../../lib/categories';
import { GROUP_LABELS, UNCATEGORISED_COLOUR } from '../../lib/categories';
import { money } from '../../lib/format';

export function PageHead({ eyebrow, title, children, actions }: { eyebrow?: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, sub, right, children, flush, className, id }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
  return (
    <section className={`panel ${className ?? ''}`} id={id}>
      <div className="panel-head">
        <h3 className="panel-title">{title}</h3>
        {sub && <span className="sub">{sub}</span>}
        {right && <div className="right">{right}</div>}
      </div>
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, light, white, title }: { label: string; value: ReactNode; sub?: ReactNode; light?: boolean; white?: boolean; title?: string }) {
  return (
    <div className={`kpi ${light ? 'light' : ''}`} title={title}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${white ? 'white' : ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, dark, ariaLabel }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void; dark?: boolean; ariaLabel?: string }) {
  return (
    <div className={`seg ${dark ? 'on-dark' : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} role="radio" aria-checked={o.v === value} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>
          <i className={`bi ${t.kind === 'err' ? 'bi-exclamation-triangle' : 'bi-check2-circle'}`} />
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.action && <button className="btn sm on-dark" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="icon-btn" style={{ color: 'rgba(255,255,255,.7)' }} onClick={() => dismiss(t.id)} aria-label="Dismiss"><i className="bi bi-x" /></button>
        </div>
      ))}
    </div>
  );
}

export function Progress({ frac, navy }: { frac: number; navy?: boolean }) {
  return <div className={`progress ${navy ? 'navy' : ''}`} role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.max(2, Math.min(100, frac * 100))}%` }} /></div>;
}

/** Number that ticks up to its value — used on summary cards after processing. */
export function Counter({ value, format = (v: number) => Math.round(v).toLocaleString('en-GB'), duration = 900 }: { value: number; format?: (v: number) => string; duration?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{format(shown)}</>;
}

export function Money({ v, sign, className, full }: { v: number; sign?: boolean; className?: string; full?: boolean }) {
  return <span className={`num ${v < 0 ? 'neg' : ''} ${className ?? ''}`} title={full ? undefined : `£${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`}>{full ? `${v < 0 ? '−' : ''}£${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : money(v, { sign })}</span>;
}

export function CatBadge({ cat, uncategorised }: { cat?: Category; uncategorised?: boolean }) {
  if (!cat || uncategorised) return <span className="legend-dot"><span className="swatch" style={{ background: UNCATEGORISED_COLOUR }} /><span className="muted">Uncategorised</span></span>;
  return <span className="legend-dot" title={GROUP_LABELS[cat.group]}><span className="swatch" style={{ background: cat.colour }} /><span style={{ color: 'var(--pt-text)' }}>{cat.name}</span></span>;
}

export function CategorySelect({ value, onChange, categories, allowNone, small, id, groups }: { value: string; onChange: (v: string) => void; categories: Category[]; allowNone?: string; small?: boolean; id?: string; groups?: Category['group'][] }) {
  const gs = (groups ?? (['receipts_operational', 'payments_operational', 'treasury', 'internal'] as const)) as Category['group'][];
  return (
    <select id={id} className={`select ${small ? 'sm' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {gs.map((g) => (
        <optgroup key={g} label={GROUP_LABELS[g]}>
          {categories.filter((c) => c.group === g).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function InfoTip({ text }: { text: string }) {
  return <i className="bi bi-info-circle muted" title={text} aria-label={text} style={{ cursor: 'help', fontSize: 13 }} />;
}

export function StepFooter({ nextLabel, onNext, nextDisabled, extra }: { backLabel?: string; nextLabel?: string; onNext?: () => void; nextDisabled?: boolean; extra?: ReactNode }) {
  const step = useStore((s) => s.step);
  const next = useStore((s) => s.next);
  const STEPS = stepsFor(useStore((s) => s.advanced));
  const i = STEPS.findIndex((s) => s.id === step);
  if (i < 0) return null;
  return (
    <div className="step-footer no-print">
      <div />
      <div className="row">{extra}{i < STEPS.length - 1 && <button className="btn primary lg" disabled={nextDisabled} onClick={onNext ?? next}>{nextLabel ?? `Continue to ${STEPS[i + 1].label.toLowerCase()}`} <i className="bi bi-arrow-right" /></button>}</div>
    </div>
  );
}

export function Empty({ icon = 'bi-inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><i className={`bi ${icon}`} /><h3>{title}</h3>{children && <div>{children}</div>}</div>;
}

export function useCategories() {
  return useStore((s) => s.team.categories);
}

export function catByIdx(categories: Category[], catIds: string[], idx: number): Category | undefined {
  if (idx < 0 || idx >= catIds.length) return undefined;
  return categories.find((c) => c.id === catIds[idx]);
}

// ------------------------------------------------------------------ guidance pattern used on every tab

/** Plain-English explainer: what you're looking at, why it matters, what to do. */
export function Explain({ what, why, todo, compact }: { what: ReactNode; why?: ReactNode; todo?: ReactNode; compact?: boolean }) {
  const show = useStore((s) => s.showTips);
  const setShow = useStore((s) => s.setShowTips);
  const [open, setOpen] = useState(false);
  if (!show && !open) return <button className="howto" onClick={() => setOpen(true)}><i className="bi bi-question-circle" /> How this works</button>;
  return (
    <div className={`explain ${compact ? 'compact' : ''}`} role="note">
      <div className="explain-col"><div className="explain-h"><i className="bi bi-eye" /> What this is</div><div>{what}</div></div>
      {why && <div className="explain-col"><div className="explain-h"><i className="bi bi-lightbulb" /> Why it matters</div><div>{why}</div></div>}
      {todo && <div className="explain-col todo"><div className="explain-h"><i className="bi bi-hand-index" /> What to do</div><div>{todo}</div></div>}
      <button className="icon-btn explain-x" title="Hide" aria-label="Hide" onClick={() => { setOpen(false); setShow(false); }}><i className="bi bi-x" /></button>
    </div>
  );
}

export interface TabDef { id: string; label: string; icon?: string; badge?: ReactNode; disabled?: boolean; hint?: string }

/** Numbered sub-tabs for a step. The active tab is remembered per step. */
export function useStepTab(step: string, tabs: TabDef[], initial?: string): [string, (t: string) => void] {
  const cur = useStore((s) => s.stepTab[step]);
  const set = useStore((s) => s.setStepTab);
  const valid = tabs.find((t) => t.id === cur && !t.disabled) ? cur! : initial ?? tabs[0].id;
  return [valid, (t: string) => set(step, t)];
}

export function StepTabs({ tabs, value, onChange, numbered = true }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; numbered?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // on a phone the tabs scroll sideways: keep the current one in view
  useEffect(() => { const el = ref.current, on = el?.querySelector<HTMLElement>('.on'); if (el && on && el.scrollWidth > el.clientWidth) el.scrollTo({ left: el.scrollLeft + on.getBoundingClientRect().left - el.getBoundingClientRect().left - 24, behavior: 'smooth' }); }, [value]);
  return (
    <div className="step-tabs" role="tablist" ref={ref}>
      {tabs.map((t, i) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} title={t.hint} className={value === t.id ? 'on' : ''} disabled={t.disabled} onClick={() => onChange(t.id)}>
          {numbered ? <span className="st-num">{i + 1}</span> : t.icon ? <i className={`bi ${t.icon}`} /> : null}
          <span>{t.label}</span>
          {t.badge !== undefined && t.badge !== null && t.badge !== '' && <span className="st-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** Footer inside a tab pointing to the next tab (or a custom action). */
export function NextTab({ label, onClick, text }: { label: string; onClick: () => void; text?: ReactNode }) {
  return (
    <div className="next-tab no-print">
      <span className="muted small">{text}</span>
      <button className="btn navy" onClick={onClick}>{label} <i className="bi bi-arrow-right" /></button>
    </div>
  );
}

/** In the example council: what the next click does instead of opening your computer's files. */
export function PracticeNote({ children }: { children: ReactNode }) {
  return <div className="practice-note"><i className="bi bi-mortarboard" /><span><strong>Practice run.</strong> {children}</span></div>;
}
