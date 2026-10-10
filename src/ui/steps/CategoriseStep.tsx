import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, Counter, StepFooter, Progress, CatBadge, Empty, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { EChart } from '../components/EChart';
import { engine } from '../../worker/client';
import type { AccuracyReport } from '../../lib/categorise/accuracy';
import { money, pct, int, day } from '../../lib/format';
import { GROUP_LABELS, UNCATEGORISED_COLOUR } from '../../lib/categories';
import { FLAG_LABELS } from '../../lib/categorise/engine';
import { STARTER_RULES } from '../../lib/categorise/starterRules';

export function CategoriseStep() {
  const { cat, catBusy, ingest, runCategorise, hasTruth } = useStore();
  useEffect(() => { if (ingest && !cat && !catBusy) void runCategorise(); }, [ingest, cat, catBusy, runCategorise]);
  const tabs: TabDef[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'categories', label: 'By category', disabled: !cat },
    { id: 'how', label: 'How it decided', disabled: !cat },
    { id: 'rules', label: 'Rules', disabled: !cat },
    ...(hasTruth ? [{ id: 'accuracy', label: 'Accuracy (demo data)', disabled: !cat }] : []),
  ];
  const [tab, setTab] = useStepTab('categorise', tabs);
  return (
    <div className="page">
      <PageHead eyebrow="Step 3 of 8" title="Sort every transaction into a category"
        actions={<button className="btn" disabled={!!catBusy} onClick={() => void runCategorise()}><i className="bi bi-arrow-repeat" /> Run again</button>}>
        We’ve sorted each bank line — council tax, payroll, suppliers, loans and so on — using clear rules, never guesswork you can’t see.
      </PageHead>
      {catBusy && <div className="card card-pad mb"><div className="row"><span className="spinner" /><strong className="navy">{catBusy.phase}</strong></div><div className="mt"><Progress frac={catBusy.frac} /></div></div>}
      {!cat ? (!catBusy && <Empty icon="bi-tags" title="Nothing to categorise yet">Load bank statements first, under History.</Empty>) : (
        <>
          <StepTabs tabs={tabs} value={tab} onChange={setTab} />
          {tab === 'summary' && <>
            <Explain
              what="The headline result: how much of your money we could categorise, how much is borrowing and investment (treasury), and how much needs your eye."
              why="Treasury flows — loans, deposits, money market funds — are kept out of the forecast, because the forecast exists to tell you when you’ll need them. So they must be spotted reliably."
              todo={<>Glance at the numbers, then go to <strong>Review</strong> to confirm anything we weren’t sure about. Most councils only need a few clicks.</>} />
            <CatHeadline />
            <StepFooter nextLabel="Review the lines we weren’t sure about" />
          </>}
          {tab === 'categories' && <>
            <Explain compact what="Every category with its number of lines, money in, money out, and how much was treated as one-off." todo="Look for anything surprising — e.g. a category much larger or smaller than you’d expect. Categories can be renamed or merged in Settings." />
            <CategoryTable />
            <NextTab label="Next: how it decided" onClick={() => setTab('how')} />
          </>}
          {tab === 'how' && <>
            <Explain compact what="The order in which lines are sorted, and how many each stage handled. Every line records the exact rule that sorted it — hover any transaction to see it." why="So you can always explain to an auditor why a payment landed where it did." />
            <HowDecided />
            <NextTab label="Next: rules" onClick={() => setTab('rules')} />
          </>}
          {tab === 'rules' && <>
            <Explain compact what={<><strong>Team rules</strong> are ones your team has taught (from the Review step). <strong>Starter rules</strong> come built in and recognise common council flows.</>} why="Team rules always win, and they’re saved in the team file — so the tool gets better every time someone reviews." todo="Nothing to do here — rules are created for you when you confirm things in Review. Edit or delete them in Settings." />
            <RulesPanel />
          </>}
          {tab === 'accuracy' && <>
            <Explain compact what="For the demo data only: we know the right answer for every line, so we can score the engine." why="It’s how we measure and improve the sorting — especially how much loan and investment money we correctly keep out of the forecast." />
            <AccuracyPanel />
          </>}
        </>
      )}
    </div>
  );
}

function useCatRows() {
  const { cat, team } = useStore();
  const categories = team.categories;
  if (!cat) return null;
  const C = cat.catIds.length;
  const rows = cat.byCategory.map((b, i) => ({ ...b, i, c: i < C ? categories.find((x) => x.id === cat.catIds[i]) : undefined })).filter((r) => r.rows);
  return { cat, rows };
}

function CatHeadline() {
  const d = useCatRows();
  const catVersion = useStore((s) => s.catVersion);
  if (!d) return null;
  const { cat, rows } = d;
  const groups = (['receipts_operational', 'payments_operational', 'treasury', 'internal'] as const).map((g) => ({ g, abs: rows.filter((r) => r.c?.group === g).reduce((s, r) => s + r.abs, 0) }));
  const total = groups.reduce((s, g) => s + g.abs, 0) + cat.uncategorisedAbs;
  const meter = [
    { label: 'Money in (operational)', v: groups[0].abs, colour: '#2caffe', note: 'feeds the forecast' },
    { label: 'Money out (operational)', v: groups[1].abs, colour: '#fd7e14', note: 'feeds the forecast' },
    { label: 'Loans & investments', v: groups[2].abs, colour: '#0a2540', note: 'kept out of the forecast' },
    { label: 'Transfers between your accounts', v: groups[3].abs, colour: '#adb5bd', note: 'cancel out' },
    { label: 'Not yet categorised', v: cat.uncategorisedAbs, colour: UNCATEGORISED_COLOUR, note: 'see Review' },
  ];
  return (
    <div className="stack fade" key={catVersion}>
      <div className="grid g4">
        <Kpi label="Money categorised" value={<Counter value={cat.valueCategorisedPct * 100} format={(v) => `${(Math.floor(v * 10) / 10).toFixed(1)}%`} />} sub={`${int(cat.uncategorisedRows)} lines (${money(cat.uncategorisedAbs)}) still to sort`} />
        <Kpi label="Loans & investments found" value={<Counter value={cat.treasuryAbs} format={(v) => money(v)} />} sub={`${money(cat.suspectedAbs)} of it to confirm in Review`} />
        <Kpi label="Regular payments found" value={<Counter value={cat.seriesCount} />} sub="e.g. payroll, precepts, grant instalments" />
        <Kpi label="Worth a quick look" value={<Counter value={cat.outlierRows + cat.dealLikeOpRows} />} sub={`${cat.outlierRows} unusually large · ${cat.dealLikeOpRows} loan-like`} />
      </div>
      {cat.dealLikeOpAbs > 0 && <div className="callout"><strong>Please check:</strong> {money(cat.dealLikeOpAbs)} across {cat.dealLikeOpRows} lines looks like it could be loans or deposits (round sums, money that comes back later, or payments to other councils) but is currently counted as normal cash. The <strong>Review → Loans & investments</strong> tab lists them.</div>}
      <Panel title="Where the money went" sub={`${money(total)} of transactions across ${int(cat.rows)} lines, sorted in ${(cat.ms / 1000).toFixed(1)} seconds`}>
        <div className="meter" style={{ height: 18 }}>{meter.map((m) => <div key={m.label} title={`${m.label}: ${money(m.v)}`} style={{ width: `${(m.v / total) * 100}%`, background: m.colour }} />)}</div>
        <div className="grid g5 mt">{meter.map((m) => (
          <div key={m.label} className="small"><span className="legend-dot"><span className="swatch" style={{ background: m.colour }} /><strong className="navy">{pct(m.v / total)}</strong></span><div>{m.label}</div><div className="xs muted">{money(m.v)} · {m.note}</div></div>
        ))}</div>
      </Panel>
    </div>
  );
}

function CategoryTable() {
  const d = useCatRows();
  if (!d) return null;
  return (
    <Panel title="By category" flush>
      <div className="tbl-wrap tall">
        <table className="tbl">
          <thead><tr><th>Category</th><th>Type</th><th className="num">Lines</th><th className="num">Money in</th><th className="num">Money out</th><th className="num">One-off</th></tr></thead>
          <tbody>
            {d.rows.sort((a, b) => b.abs - a.abs).map((r) => (
              <tr key={r.i}>
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
  );
}

const PIPELINE: { label: string; match: string; text: string }[] = [
  { label: 'Your decisions', match: 'Your decision on this transaction', text: 'Lines you individually confirmed in Review.' },
  { label: 'Transfers between your accounts', match: 'Internal transfer', text: 'Money moving between your own accounts — equal and opposite, same day. These cancel out and are ignored.' },
  { label: 'Team rules', match: 'Team rules', text: 'Rules your team taught (saved with your work). These always win.' },
  { label: 'Starter rules', match: 'Starter rules', text: 'Built-in patterns for council tax, NNDR, payroll, HMRC, PWLB, money market funds and so on.' },
  { label: 'Treasury dictionary', match: 'Treasury counterparty dictionary', text: 'Known banks, building societies and money market funds.' },
  { label: 'Other councils', match: 'Another local authority + round sum', text: 'Payments to or from other councils — round sums are likely loans; odd amounts likely recharges.' },
  { label: 'Pattern spotting', match: 'Heuristic', text: 'Loan-like patterns: money in and back out with interest, large round sums, identical amounts every six months.' },
  { label: 'Not yet categorised', match: 'Uncategorised', text: 'Lines nothing recognised — these appear in Review.' },
];

function HowDecided() {
  const { cat } = useStore();
  if (!cat) return null;
  const by = (m: string) => cat.bySource.filter((b) => b.label.startsWith(m)).reduce((s, b) => ({ rows: s.rows + b.rows, abs: s.abs + b.abs }), { rows: 0, abs: 0 });
  return (
    <div className="grid g-side">
      <Panel title="The sorting order" sub="first match wins" flush>
        <table className="tbl">
          <thead><tr><th>#</th><th>Stage</th><th>What it does</th><th className="num">Lines</th><th className="num">Value</th></tr></thead>
          <tbody>{PIPELINE.map((p, i) => { const v = by(p.match); return (
            <tr key={p.label}><td className="num">{i + 1}</td><td><strong className="navy">{p.label}</strong></td><td className="small">{p.text}</td><td className="num">{int(v.rows)}</td><td className="num">{money(v.abs)}</td></tr>
          ); })}</tbody>
        </table>
      </Panel>
      <div className="stack">
        <Panel title="Share of value by stage">
          <EChart height={220} option={{
            tooltip: { trigger: 'item', valueFormatter: (v: number) => money(v) },
            series: [{ type: 'pie', radius: ['48%', '78%'], label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 2 },
              data: cat.bySource.map((b, i) => ({ name: b.label, value: b.abs, itemStyle: { color: ['#0a2540', '#fd7e14', '#2caffe', '#2dd4a8', '#6b8abc', '#b04632', '#ced4da', '#feb56a', '#544fc5'][i % 9] } })) }],
          }} />
        </Panel>
        <Panel title="Things we flagged" sub="flags don’t change a category — they mark lines worth a look">
          <table className="tbl"><tbody>{FLAG_LABELS.filter(([f]) => cat.flagCounts[f]).map(([f, l]) => <tr key={f}><td>{l}</td><td className="num">{int(cat.flagCounts[f])}</td></tr>)}</tbody></table>
        </Panel>
      </div>
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
