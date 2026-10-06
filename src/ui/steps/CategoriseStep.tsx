import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, Counter, StepFooter, Progress, CatBadge, Empty } from '../components/common';
import { EChart } from '../components/EChart';
import { engine } from '../../worker/client';
import type { AccuracyReport } from '../../lib/categorise/accuracy';
import { money, pct, int, day } from '../../lib/format';
import { GROUP_LABELS, UNCATEGORISED_COLOUR } from '../../lib/categories';
import { FLAG_LABELS } from '../../lib/categorise/engine';
import { STARTER_RULES } from '../../lib/categorise/starterRules';

export function CategoriseStep() {
  const { cat, catBusy, ingest, runCategorise } = useStore();
  useEffect(() => { if (ingest && !cat && !catBusy) void runCategorise(); }, [ingest, cat, catBusy, runCategorise]);
  return (
    <div className="page">
      <PageHead eyebrow="Step 3 of 8" title="Categorise every line"
        actions={<button className="btn" disabled={!!catBusy} onClick={() => void runCategorise()}><i className="bi bi-arrow-repeat" /> Re-run</button>}>
        A transparent, rule-based pipeline: internal transfers → your team’s rules → built-in starter rules → treasury counterparties → recurring-series detection → heuristic flags. Each line records the rule that decided it.
      </PageHead>
      {catBusy && <div className="card card-pad mb"><div className="row"><span className="spinner" /><strong className="navy">{catBusy.phase}</strong></div><div className="mt"><Progress frac={catBusy.frac} /></div></div>}
      {cat ? <CatSummaryView /> : !catBusy && <Empty icon="bi-tags" title="Nothing to categorise yet">Load bank data on step 1.</Empty>}
      <StepFooter nextDisabled={!cat} nextLabel="Review the tricky lines" />
    </div>
  );
}

function CatSummaryView() {
  const { cat, team, hasTruth, catVersion } = useStore();
  const categories = team.categories;
  if (!cat) return null;
  const C = cat.catIds.length;
  const rows = cat.byCategory.map((b, i) => ({ ...b, i, c: i < C ? categories.find((x) => x.id === cat.catIds[i]) : undefined })).filter((r) => r.rows);
  const groups = (['receipts_operational', 'payments_operational', 'treasury', 'internal'] as const).map((g) => ({
    g, abs: rows.filter((r) => r.c?.group === g).reduce((s, r) => s + r.abs, 0),
  }));
  const total = groups.reduce((s, g) => s + g.abs, 0) + cat.uncategorisedAbs;
  const meter = [
    { label: 'Operational receipts', v: groups[0].abs, colour: '#2caffe' },
    { label: 'Operational payments', v: groups[1].abs, colour: '#fd7e14' },
    { label: 'Treasury / deal (excluded)', v: groups[2].abs, colour: '#0a2540' },
    { label: 'Internal transfers', v: groups[3].abs, colour: '#adb5bd' },
    { label: 'Uncategorised', v: cat.uncategorisedAbs, colour: UNCATEGORISED_COLOUR },
  ];
  return (
    <div className="stack fade" key={catVersion}>
      <div className="grid g4">
        <Kpi label="Value categorised" value={<Counter value={cat.valueCategorisedPct * 100} format={(v) => `${v.toFixed(1)}%`} />} sub={`${int(cat.uncategorisedRows)} lines (${money(cat.uncategorisedAbs)}) still uncategorised`} />
        <Kpi label="Treasury excluded" value={<Counter value={cat.treasuryAbs} format={(v) => money(v)} />} sub={`${money(cat.suspectedAbs)} of it only suspected — confirm in Review`} />
        <Kpi label="Recurring series found" value={<Counter value={cat.seriesCount} />} sub={`${cat.recurringUnknown} still unnamed`} />
        <Kpi label="Flagged for a look" value={<Counter value={cat.outlierRows + cat.dealLikeOpRows} />} sub={`${cat.outlierRows} outliers · ${cat.dealLikeOpRows} deal-like`} />
      </div>
      {cat.dealLikeOpAbs > 0 && <div className="callout"><strong>Warning:</strong> {money(cat.dealLikeOpAbs)} across {cat.dealLikeOpRows} lines is still in the operational model but looks deal-like (round sums, loan-and-repayment patterns or council counterparties). Check the Treasury queue in Review.</div>}
      <Panel title="Where the money went" sub={`${money(total)} gross flow across ${int(cat.rows)} lines · categorised in ${(cat.ms / 1000).toFixed(1)}s`}>
        <div className="meter" style={{ height: 16 }}>{meter.map((m) => <div key={m.label} title={`${m.label}: ${money(m.v)}`} style={{ width: `${(m.v / total) * 100}%`, background: m.colour }} />)}</div>
        <div className="row mt">{meter.map((m) => <span key={m.label} className="legend-dot"><span className="swatch" style={{ background: m.colour }} />{m.label} <strong className="navy">{pct(m.v / total)}</strong></span>)}</div>
      </Panel>
      <div className="grid g-side">
        <Panel title="By category" flush>
          <div className="tbl-wrap tall">
            <table className="tbl">
              <thead><tr><th>Category</th><th>Group</th><th className="num">Lines</th><th className="num">In</th><th className="num">Out</th><th className="num">One-off</th></tr></thead>
              <tbody>
                {rows.sort((a, b) => b.abs - a.abs).map((r) => (
                  <tr key={r.i} className="tick-in">
                    <td><CatBadge cat={r.c} uncategorised={!r.c} /></td>
                    <td className="xs muted">{r.c ? GROUP_LABELS[r.c.group] : '—'}</td>
                    <td className="num">{int(r.rows)}</td>
                    <td className="num pos">{money(r.valueIn)}</td>
                    <td className="num neg">{money(r.valueOut)}</td>
                    <td className="num muted">{r.oneOff ? money(r.oneOff) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="stack">
          <Panel title="How lines were decided">
            <EChart height={220} option={{
              tooltip: { trigger: 'item', valueFormatter: (v: number) => money(v) },
              series: [{ type: 'pie', radius: ['48%', '78%'], avoidLabelOverlap: true, label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 2 },
                data: cat.bySource.map((b, i) => ({ name: b.label, value: b.abs, itemStyle: { color: ['#0a2540', '#fd7e14', '#2caffe', '#2dd4a8', '#6b8abc', '#b04632', '#ced4da', '#feb56a', '#544fc5'][i % 9] } })) }],
            }} />
            <table className="tbl"><tbody>{cat.bySource.map((b) => <tr key={b.label}><td>{b.label}</td><td className="num">{int(b.rows)}</td><td className="num">{money(b.abs)}</td></tr>)}</tbody></table>
          </Panel>
          <Panel title="Flags raised">
            <table className="tbl"><tbody>{FLAG_LABELS.filter(([f]) => cat.flagCounts[f]).map(([f, l]) => <tr key={f}><td>{l}</td><td className="num">{int(cat.flagCounts[f])}</td></tr>)}</tbody></table>
          </Panel>
        </div>
      </div>
      <RulesPanel />
      {hasTruth && <AccuracyPanel />}
    </div>
  );
}

export function RulesPanel() {
  const { team, cat } = useStore();
  const [showStarter, setShowStarter] = useState(false);
  const hits = useMemo(() => new Map(cat?.ruleHits.map((h) => [h.id, h.hits]) ?? []), [cat]);
  const catName = (id: string) => team.categories.find((c) => c.id === id)?.name ?? id;
  const list = showStarter ? STARTER_RULES : team.rules;
  return (
    <Panel title="Rules" sub={`${team.rules.length} team rules · ${STARTER_RULES.length} starter rules · ${cat?.rulesUsed ?? 0} used`}
      right={<div className="seg on-dark"><button className={!showStarter ? 'on' : ''} onClick={() => setShowStarter(false)}>Team</button><button className={showStarter ? 'on' : ''} onClick={() => setShowStarter(true)}>Starter</button></div>} flush>
      {list.length === 0 ? <div className="card-pad small muted">No team rules yet. Every confirmation in Review becomes a rule here, so next time is quicker.</div> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Rule</th><th>Type</th><th>Pattern</th><th>Category</th><th>Deal</th><th>Conditions</th><th className="num">Hits</th></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id}>
                <td className="xs mono">{r.id}</td><td>{r.type}</td><td className="mono xs" style={{ maxWidth: 380, wordBreak: 'break-all' }}>{r.pattern}</td>
                <td>{catName(r.categoryId)}</td><td>{r.dealFlag === 'deal' ? <span className="badge navy">deal</span> : r.dealFlag === 'suspected' ? <span className="badge amber">suspected</span> : ''}</td>
                <td className="xs muted">{[r.direction && r.direction !== 'any' ? `money ${r.direction}` : '', r.minAmount != null ? `≥ ${money(r.minAmount)}` : '', r.maxAmount != null ? `≤ ${money(r.maxAmount)}` : '', r.classification === 'one_off' ? 'one-off' : ''].filter(Boolean).join(' · ')}</td>
                <td className="num">{int(hits.get(r.id) ?? 0)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function AccuracyPanel() {
  const catVersion = useStore((s) => s.catVersion);
  const categories = useStore((s) => s.team.categories);
  const [acc, setAcc] = useState<AccuracyReport | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);
  useEffect(() => { void engine().accuracy().then(setAcc); }, [catVersion]);
  if (!acc) return null;
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  const maxCell = Math.max(1, ...acc.confusion.counts.flatMap((r, i) => r.filter((_, j) => acc.confusion.truth[i] !== acc.confusion.predicted[j])));
  return (
    <Panel title="Accuracy (developer)" sub="generated data scored against its hidden truth file" right={<span className="badge orange">dev</span>}>
      <div className="grid g5">
        <Kpi light label="Rows correct" value={pct(acc.overall.pctRows)} sub={`${int(acc.overall.correct)} of ${int(acc.overall.rows)}`} />
        <Kpi light label="Value correct" value={pct(acc.overall.pctValue)} sub={money(acc.overall.value) + ' gross'} />
        <Kpi light label="Deal value excluded" value={pct(acc.deal.pctExcluded)} sub={`of ${money(acc.deal.truthDealValue)}`} />
        <Kpi light label="Deal value left in model" value={money(acc.deal.leakedValue)} sub={`${acc.deal.leakedRows} lines — lower is better`} />
        <Kpi light label="Operational wrongly excluded" value={money(acc.deal.wronglyExcludedValue)} sub={`${acc.deal.wronglyExcludedRows} lines`} />
      </div>
      <div className="row mt small muted">
        <span>Recurring/one-off agreement {pct(acc.recurring.pct)}</span>·
        <span>{int(acc.rejectedTruthRows)} true rows not loaded ({acc.rejectedBadDates} deliberately invalid dates)</span>·
        <span>{int(acc.wrongDates)} rows with a different date (ambiguous US-style)</span>
      </div>
      <div className="grid g2 mt">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>True category</th><th className="num">Lines</th><th className="num">Recall</th><th className="num">Value</th><th className="num">Precision</th></tr></thead>
            <tbody>{acc.perCategory.filter((p) => p.truthRows).map((p) => (
              <tr key={p.id}><td>{name(p.id)}</td><td className="num">{int(p.truthRows)}</td>
                <td className="num" style={{ color: p.pct < 0.9 ? 'var(--pt-red)' : undefined }}>{pct(p.pct)}</td><td className="num">{pct(p.pctValue)}</td><td className="num">{pct(p.precision)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div>
          <h4>Largest deal flows left in the operational model</h4>
          {acc.deal.topLeaks.length === 0 ? <div className="callout green">None — every deal flow was excluded.</div> : (
            <table className="tbl"><thead><tr><th>Date</th><th>Narrative</th><th>Truly</th><th>Read as</th><th className="num">Amount</th></tr></thead>
              <tbody>{acc.deal.topLeaks.slice(0, 10).map((l, i) => <tr key={i}><td className="xs">{day(l.day)}</td><td className="mono xs">{l.narrative}</td><td className="xs">{name(l.truthCat)}</td><td className="xs">{name(l.predicted)}</td><td className="num">{money(l.amount)}</td></tr>)}</tbody></table>
          )}
          <button className="btn sm mt" onClick={() => setShowMatrix(!showMatrix)}>{showMatrix ? 'Hide' : 'Show'} confusion matrix</button>
        </div>
      </div>
      {showMatrix && (
        <div className="tbl-wrap mt" style={{ maxHeight: 640 }}>
          <table className="tbl heat">
            <thead><tr><th>True ↓ / read as →</th>{acc.confusion.predicted.map((p) => <th key={p} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 10 }}>{name(p)}</th>)}</tr></thead>
            <tbody>{acc.confusion.counts.map((r, i) => r.some(Boolean) && (
              <tr key={i}><td className="xs nowrap" style={{ textAlign: 'left' }}>{name(acc.confusion.truth[i])}</td>
                {r.map((v, j) => {
                  const diag = acc.confusion.truth[i] === acc.confusion.predicted[j];
                  const a = diag ? 0 : Math.min(1, Math.sqrt(v / maxCell));
                  return <td key={j} style={{ background: v ? (diag ? 'rgba(40,167,69,.15)' : `rgba(176,70,50,${0.1 + a * 0.6})`) : undefined, color: !diag && a > 0.5 ? '#fff' : undefined }}>{v || ''}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
