import { useState } from 'react';
import { useStore } from '../../state/store';
import type { Scenario, Assumption, OneOff } from '../../lib/model';
import { uid } from '../../lib/model';
import type { ForecastBundle } from './useForecast';
import { Seg, Money, Panel } from '../components/common';
import { money, pct, day } from '../../lib/format';
import { addMonths, dayFromISO, isoFromDay, ymdFromDay } from '../../lib/dates';
import type { Category } from '../../lib/categories';

type Upd = (fn: (s: Scenario) => Scenario) => void;

function MoneyInput({ value, onChange, label, id }: { value: number; onChange: (v: number) => void; label: string; id: string }) {
  const [text, setText] = useState(value ? Math.round(value).toLocaleString('en-GB') : '');
  return (
    <div className="money-input">
      <span>£</span>
      <input id={id} className="input" inputMode="decimal" aria-label={label} value={text}
        onChange={(e) => { setText(e.target.value); onChange(parseFloat(e.target.value.replace(/[£,\s]/g, '')) || 0); }}
        onBlur={() => { const v = parseFloat(text.replace(/[£,\s]/g, '')) || 0; setText(v ? Math.round(v).toLocaleString('en-GB') : ''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </div>
  );
}

// ------------------------------------------------------------------ starting cash

export function SimpleStart({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const { team, updateTeam } = useStore();
  const st = sc.settings;
  const set = (patch: Partial<Scenario['settings']>) => upd((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  const start = dayFromISO(st.start);
  const months = Math.round((dayFromISO(st.end) - start + 1) / 30.44);
  const manual = st.openingMode === 'manual';
  return (
    <div className="qa-list">
      <div className="qa">
        <div className="qa-n">1</div>
        <div className="qa-body">
          <h3>How much cash does the council have at the start?</h3>
          <p>We’ve used the bank balance at the end of your files. If you know today’s figure, type it instead.{b.fc.register ? '' : ' Include money in instant-access investments.'}</p>
          <Seg value={manual ? 'manual' : 'bank'} onChange={(v) => set(v === 'manual' ? { openingMode: 'manual', openingPosition: Math.round(b.bankEnd) } : { openingMode: 'bank', openingPosition: null })}
            options={[{ v: 'bank', label: `Use the balance from my files (${money(b.bankEnd)})` }, { v: 'manual', label: 'Type a figure' }]} />
          {manual && <div className="mt" style={{ maxWidth: 260 }}><MoneyInput id="opening" label={b.fc.register ? 'Bank balance' : 'Starting cash'} value={st.openingPosition ?? 0} onChange={(v) => set({ openingPosition: v })} /></div>}
          {b.fc.register && (
            <div className="callout green mt small">
              <strong>Plus {money(b.fc.register.liquid)} from your deal register</strong>, held in money market funds and call accounts, so the forecast starts from <strong>{money(b.fc.opening)}</strong>.
              Fixed-term investments come back as they mature, and loans are repaid on their dates.
            </div>
          )}
        </div>
      </div>
      <div className="qa">
        <div className="qa-n">2</div>
        <div className="qa-body">
          <h3>What’s the least cash you want to hold at any time?</h3>
          <p>Your safety margin, sometimes called a <em>liquidity buffer</em>. If the forecast dips below it, that’s when you’d need to borrow. Many councils use £5m–£20m.</p>
          <div style={{ maxWidth: 260 }}><MoneyInput id="buffer" label="Minimum cash" value={team.settings.liquidityBuffer} onChange={(v) => updateTeam((t) => ({ ...t, settings: { ...t.settings, liquidityBuffer: v } }))} /></div>
        </div>
      </div>
      <div className="qa">
        <div className="qa-n">3</div>
        <div className="qa-body">
          <h3>How far ahead should we look?</h3>
          <p>Starting {day(start)}. Two years is a good default; further ahead is less certain.</p>
          <Seg value={[12, 24, 36].includes(months) ? months : 24} onChange={(m) => set({ end: isoFromDay(addMonths(start, m) - 1) })} options={[{ v: 12, label: '1 year' }, { v: 24, label: '2 years' }, { v: 36, label: '3 years' }]} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ growth

export function SimpleGrowth({ sc, upd, b }: { sc: Scenario; upd: Upd; b: ForecastBundle }) {
  const categories = useStore((s) => s.team.categories);
  const growthFor = (id: string) => sc.assumptions.find((a) => a.kind === 'growth' && a.categoryId === id) as Extract<Assumption, { kind: 'growth' }> | undefined;
  const setGrowth = (id: string, v: string) => upd((s) => {
    const rest = s.assumptions.filter((a) => !(a.kind === 'growth' && a.categoryId === id));
    if (v.trim() === '' || isNaN(+v)) return { ...s, assumptions: rest };
    return { ...s, assumptions: [...rest, { id: uid('as'), kind: 'growth', categoryId: id, pct: +v, mode: 'annual_step' }] };
  });
  const rows = b.fc.explain.filter((e) => e.method !== 'exclude' && Math.abs(e.historyAnnual) > 2e6).sort((a, z) => Math.abs(z.historyAnnual) - Math.abs(a.historyAnnual));
  return (
    <Panel title="Expected growth each year" flush>
      <table className="tbl simple-tbl">
        <thead><tr><th>Category</th><th className="num">Last 12 months</th><th className="num">Past growth</th><th className="num">Your figure (leave empty to keep the past growth)</th></tr></thead>
        <tbody>{rows.map((e) => {
          const g = growthFor(e.id);
          const cat = categories.find((c) => c.id === e.id);
          return (
            <tr key={e.id}>
              <td><span className="swatch" style={{ background: cat?.colour ?? '#ced4da', marginRight: 8 }} />{e.name} <span className="xs muted">{e.historyAnnual >= 0 ? 'in' : 'out'}</span></td>
              <td className="num"><Money v={Math.abs(e.historyAnnual)} /></td>
              <td className="num muted">{pct(e.historicCagr / 100, 1, true)} a year</td>
              <td className="num">
                <div className="pct-input">
                  <input className={`input ${g ? 'set' : ''}`} placeholder="same" title={`Leave empty to keep the past trend (${e.historicCagr.toFixed(1)}%)`} defaultValue={g ? String(g.pct) : ''} key={g ? g.id : 'none'}
                    aria-label={`Your growth for ${e.name}`} onBlur={(ev) => setGrowth(e.id, ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} />
                  <span>% a year</span>
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ known future items

type ItemKind = 'oneoff' | 'stop' | 'change';

export function SimpleItems({ sc, upd }: { sc: Scenario; upd: Upd }) {
  const categories = useStore((s) => s.team.categories);
  const opCats = categories.filter((c) => c.group === 'receipts_operational' || c.group === 'payments_operational');
  const [kind, setKind] = useState<ItemKind | null>(null);
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  const items: { id: string; date: string; text: string; amount?: number; kind: string; remove: () => void }[] = [
    ...sc.oneOffs.map((o) => ({ id: o.id, date: o.date, kind: 'One-off', amount: o.amount, text: `${o.description || name(o.categoryId)}${o.confidence !== 'firm' ? ` (${o.confidence === 'likely' ? 'likely' : `possible, counted at ${Math.round((o.probability ?? 0.5) * 100)}%`})` : ''}`, remove: () => upd((s) => ({ ...s, oneOffs: s.oneOffs.filter((x) => x.id !== o.id) })) })),
    ...sc.assumptions.filter((a) => a.kind === 'stop' || a.kind === 'step').map((a) => ({
      id: a.id, date: a.kind === 'stop' ? a.from : (a as Extract<Assumption, { kind: 'step' }>).effective, kind: a.kind === 'stop' ? 'Stops' : 'Change',
      text: a.kind === 'stop' ? `${name(a.categoryId)} stops${a.note ? ` — ${a.note}` : ''}` : `${name(a.categoryId)} ${(a as Extract<Assumption, { kind: 'step' }>).pct >= 0 ? '+' : ''}${(a as Extract<Assumption, { kind: 'step' }>).pct}%${a.note ? ` — ${a.note}` : ''}`,
      remove: () => upd((s) => ({ ...s, assumptions: s.assumptions.filter((x) => x.id !== a.id) })),
    })),
  ].sort((x, y) => x.date.localeCompare(y.date));
  return (
    <div className="stack">
      {items.length > 0 && (
        <Panel title="Items you’ve added" sub={`${items.length}`} flush>
          <table className="tbl simple-tbl">
            <tbody>{items.map((it) => (
              <tr key={it.id}><td style={{ width: 110 }}>{day(dayFromISO(it.date))}</td><td><span className="badge navy" style={{ marginRight: 8 }}>{it.kind}</span>{it.text}</td>
                <td className="num">{it.amount !== undefined ? <Money v={it.amount} sign /> : ''}</td>
                <td style={{ width: 40 }}><button className="icon-btn" aria-label="Remove" title="Remove" onClick={it.remove}><i className="bi bi-trash" /></button></td></tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>Add something you know about</h3>
        <div className="big-choice">
          <button className={`choice-card ${kind === 'oneoff' ? 'on' : ''}`} onClick={() => setKind('oneoff')}><i className="bi bi-pin-map" /><strong>A one-off amount</strong><span>e.g. a land sale, a capital grant, a big contract payment</span></button>
          <button className={`choice-card ${kind === 'stop' ? 'on' : ''}`} onClick={() => setKind('stop')}><i className="bi bi-stop-circle" /><strong>Something will stop</strong><span>e.g. a grant ends, a contract finishes</span></button>
          <button className={`choice-card ${kind === 'change' ? 'on' : ''}`} onClick={() => setKind('change')}><i className="bi bi-percent" /><strong>A rise or cut from a date</strong><span>e.g. a pay award, a council tax rise, a price increase</span></button>
        </div>
        {kind === 'oneoff' && <OneOffForm opCats={opCats} start={sc.settings.start} onAdd={(o) => { upd((s) => ({ ...s, oneOffs: [...s.oneOffs, o] })); setKind(null); }} />}
        {kind === 'stop' && <StopForm opCats={opCats} start={sc.settings.start} onAdd={(a) => { upd((s) => ({ ...s, assumptions: [...s.assumptions, a] })); setKind(null); }} />}
        {kind === 'change' && <ChangeForm opCats={opCats} start={sc.settings.start} onAdd={(a) => { upd((s) => ({ ...s, assumptions: [...s.assumptions, a] })); setKind(null); }} />}
      </div>
    </div>
  );
}

function CatPick({ value, onChange, cats }: { value: string; onChange: (v: string) => void; cats: Category[] }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="Money coming in">{cats.filter((c) => c.group === 'receipts_operational').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
      <optgroup label="Money going out">{cats.filter((c) => c.group === 'payments_operational').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
    </select>
  );
}

function OneOffForm({ opCats, start, onAdd }: { opCats: Category[]; start: string; onAdd: (o: OneOff) => void }) {
  const [date, setDate] = useState(isoFromDay(addMonths(dayFromISO(start), 6)));
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState(0);
  const [what, setWhat] = useState('');
  const [catId, setCatId] = useState('capital_receipts');
  const [conf, setConf] = useState<OneOff['confidence']>('firm');
  return (
    <div className="form-grid fade">
      <div className="field"><label>When?</label><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="field"><label>Money in or out?</label><Seg value={dir} onChange={(v) => { setDir(v); setCatId(v === 'in' ? 'capital_receipts' : 'capital_spend'); }} options={[{ v: 'in', label: 'Coming in' }, { v: 'out', label: 'Going out' }]} /></div>
      <div className="field"><label>How much?</label><MoneyInput id="oo-amt" label="Amount" value={amount} onChange={setAmount} /></div>
      <div className="field"><label>What is it?</label><input className="input" placeholder="e.g. Sale of the old depot" value={what} onChange={(e) => setWhat(e.target.value)} /></div>
      <div className="field"><label>Which category?</label><CatPick value={catId} onChange={setCatId} cats={opCats} /></div>
      <div className="field"><label>How sure are you?</label><Seg value={conf} onChange={setConf} options={[{ v: 'firm', label: 'Definite' }, { v: 'likely', label: 'Likely' }, { v: 'possible', label: 'Maybe (50%)' }]} /></div>
      <div className="form-actions"><button className="btn primary lg" disabled={!amount} onClick={() => onAdd({ id: uid('oo'), date, amount: Math.abs(amount) * (dir === 'in' ? 1 : -1), categoryId: catId, description: what, confidence: conf, probability: 0.5 })}><i className="bi bi-plus-lg" /> Add to forecast</button></div>
    </div>
  );
}

function StopForm({ opCats, start, onAdd }: { opCats: Category[]; start: string; onAdd: (a: Assumption) => void }) {
  const [catId, setCatId] = useState('grants_general');
  const [from, setFrom] = useState(isoFromDay(addMonths(dayFromISO(start), 12)));
  const [note, setNote] = useState('');
  return (
    <div className="form-grid fade">
      <div className="field"><label>What stops?</label><CatPick value={catId} onChange={setCatId} cats={opCats} /></div>
      <div className="field"><label>From when?</label><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      <div className="field" style={{ gridColumn: 'span 2' }}><label>Note (optional)</label><input className="input" placeholder="e.g. Household Support Fund ends" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="callout small" style={{ gridColumn: '1 / -1' }}>This stops the <strong>whole</strong> category from that date. To stop just part of it, use “A rise or cut from a date” with a negative percentage instead.</div>
      <div className="form-actions"><button className="btn primary lg" onClick={() => onAdd({ id: uid('as'), kind: 'stop', categoryId: catId, from, note })}><i className="bi bi-plus-lg" /> Add to forecast</button></div>
    </div>
  );
}

function ChangeForm({ opCats, start, onAdd }: { opCats: Category[]; start: string; onAdd: (a: Assumption) => void }) {
  const { y } = ymdFromDay(dayFromISO(start));
  const [catId, setCatId] = useState('salaries');
  const [p, setP] = useState('3');
  const [from, setFrom] = useState(`${y + (dayFromISO(start) > dayFromISO(`${y}-04-01`) ? 1 : 0)}-04-01`);
  const [note, setNote] = useState('');
  return (
    <div className="form-grid fade">
      <div className="field"><label>What changes?</label><CatPick value={catId} onChange={setCatId} cats={opCats} /></div>
      <div className="field"><label>By how much?</label><div className="pct-input"><input className="input" type="number" step={0.5} value={p} onChange={(e) => setP(e.target.value)} /><span>% (use − for a cut)</span></div></div>
      <div className="field"><label>From when?</label><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      <div className="field"><label>Note (optional)</label><input className="input" placeholder="e.g. 2027 pay award" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="callout small" style={{ gridColumn: '1 / -1' }}>This is on top of the normal yearly growth set on the <strong>Growth</strong> tab.</div>
      <div className="form-actions"><button className="btn primary lg" disabled={!p || isNaN(+p)} onClick={() => onAdd({ id: uid('as'), kind: 'step', categoryId: catId, pct: +p, effective: from, note })}><i className="bi bi-plus-lg" /> Add to forecast</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ what's in it

export function SimpleBreakdown({ b }: { b: ForecastBundle }) {
  const categories = useStore((s) => s.team.categories);
  const fc = b.fc;
  const fy = (d: number) => { const { y, m } = ymdFromDay(d); const f = m >= 4 ? y : y - 1; return `${f}/${String((f + 1) % 100).padStart(2, '0')}`; };
  const labels = [...new Set(Array.from({ length: fc.H }, (_, d) => fy(fc.start + d)))];
  const rows = fc.explain.filter((e) => Math.abs(e.forecastTotal) > 1).map((e) => {
    const per = labels.map((l) => { let t = 0; for (let d = 0; d < fc.H; d++) if (fy(fc.start + d) === l) t += fc.daily[e.catIdx * fc.H + d]; return t; });
    return { e, per };
  }).sort((a, z) => Math.abs(z.e.historyAnnual) - Math.abs(a.e.historyAnnual));
  const inRows = rows.filter((r) => r.e.historyAnnual >= 0), outRows = rows.filter((r) => r.e.historyAnnual < 0);
  const total = (rs: typeof rows, k: number) => rs.reduce((s, r) => s + r.per[k], 0);
  const sec = (title: string, rs: typeof rows, sign = 1) => (
    <>
      <tr className="sec"><td colSpan={2 + labels.length}>{title}</td></tr>
      {rs.map(({ e, per }) => (
        <tr key={e.id}><td><span className="swatch" style={{ background: categories.find((c) => c.id === e.id)?.colour ?? '#ced4da', marginRight: 8 }} />{e.name}</td>
          <td className="num muted"><Money v={e.historyAnnual * sign} /></td>{per.map((v, k) => <td key={k} className="num"><Money v={v * sign} /></td>)}</tr>
      ))}
      <tr className="total"><td>Total {title.toLowerCase()}</td><td className="num"><Money v={rs.reduce((s, r) => s + r.e.historyAnnual, 0) * sign} /></td>{labels.map((_, k) => <td key={k} className="num"><Money v={total(rs, k) * sign} /></td>)}</tr>
    </>
  );
  return (
    <Panel title="Forecast by category" sub="years run April to March; part years at the start or end are partial" flush>
      <div className="tbl-wrap tall">
        <table className="tbl simple-tbl">
          <thead><tr><th>Category</th><th className="num">Last 12 months</th>{labels.map((l) => <th key={l} className="num">{l}</th>)}</tr></thead>
          <tbody>
            {sec('Money in', inRows)}
            {sec('Money out', outRows, -1)}
            <tr className="total grand"><td>Difference (money in minus money out)</td><td className="num"><Money v={rows.reduce((s, r) => s + r.e.historyAnnual, 0)} /></td>{labels.map((_, k) => <td key={k} className="num"><Money v={total(rows, k)} /></td>)}</tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
