import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Kpi, Money, Seg } from '../components/common';
import { useForecast } from '../forecast/useForecast';
import { ForecastChart } from '../forecast/ForecastChart';
import { engine } from '../../worker/client';
import { downloadBlob, fsAccessSupported } from '../../lib/teamfile';
import { buildHistorySummary } from '../../lib/analysis/snapshot';
import { buildWorkbook } from '../../lib/export/xlsx';
import type { BacktestResult } from '../../lib/forecast/backtest';
import { money, day, ago, pct, int } from '../../lib/format';
import { addMonths, ymdFromDay, dayFromYMD } from '../../lib/dates';
import { APP_NAME } from '../../config';

export function SaveStep() {
  const s = useStore();
  const { team, agg, cat, dirty, teamName, saveTeam, updateTeam, user, setUser } = s;
  const sc = team.forecasts.find((f) => f.id === s.activeScenarioId) ?? team.forecasts[0];
  const b = useForecast(sc);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState(false);

  const prepareSnapshot = () => {
    if (agg && team.settings.includeHistorySummary) updateTeam((t) => ({ ...t, historySummary: buildHistorySummary(agg) }));
  };
  const doSave = async (mode: 'save' | 'saveAs' | 'download') => { prepareSnapshot(); await saveTeam(mode); };
  const defaultBacktest = async (): Promise<BacktestResult | null> => {
    if (!cat || !s.ingest) return null;
    const { y, m } = ymdFromDay(addMonths(s.ingest.maxDay + 1, -24));
    return engine().backtest({ cutoff: dayFromYMD(y, m, 1), horizonMonths: 12, categories: team.categories, settings: sc.settings, includeActualOneOffs: false, fyStartMonth: +team.settings.financialYearStart.split('-')[0] || 4 });
  };

  return (
    <div className="page">
      <div className="no-print"><PageHead eyebrow={s.workspace ? 'Workspace' : 'Step 8 of 8'} title="Save and export">
        Save the team file so the next person starts where you left off, and take the results into your treasury report.
      </PageHead></div>
      <div className="grid g2 no-print">
        <Panel title="Team file" sub={dirty ? 'unsaved changes' : team.savedAt ? `saved ${ago(team.savedAt)}` : 'not saved yet'}>
          <p className="small">Contains <strong>{team.rules.length}</strong> rules, <strong>{team.aliases.length}</strong> aliases, <strong>{team.bankProfiles.length}</strong> bank profiles, <strong>{team.categories.length}</strong> categories and <strong>{team.forecasts.length}</strong> forecasts. <strong>No transaction lines.</strong></p>
          <label className="check mb"><input type="checkbox" checked={team.settings.includeHistorySummary} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, includeHistorySummary: e.target.checked } }))} />
            Include a category × month history summary (aggregates only) so colleagues can view history without the CSVs</label>
          <div className="field mb"><label>Saved by</label><input className="input" value={user} placeholder="your initials" onChange={(e) => setUser(e.target.value)} /></div>
          <div className="row">
            {fsAccessSupported() && <button className="btn primary" onClick={() => void doSave('save')}><i className="bi bi-save" /> {teamName ? `Save ${teamName}` : 'Save…'}</button>}
            {fsAccessSupported() && <button className="btn" onClick={() => void doSave('saveAs')}>Save as…</button>}
            <button className={`btn ${fsAccessSupported() ? '' : 'primary'}`} onClick={() => void doSave('download')}><i className="bi bi-download" /> Download copy</button>
          </div>
          <p className="xs muted mt">{fsAccessSupported() ? 'Saving re-reads the file first; if a colleague changed it since you opened it, you’ll be offered a merge rather than an overwrite.' : 'This browser can’t write files in place, so the team file is downloaded — copy it back to your shared drive.'}</p>
          {team.changeLog.length > 0 && (
            <details className="mt small"><summary className="muted">Change log ({team.changeLog.length})</summary>
              <ul className="list-plain">{[...team.changeLog].reverse().slice(0, 20).map((c, i) => <li key={i}><span className="muted xs">{new Date(c.at).toLocaleString('en-GB')} · {c.by}</span><br />{c.summary}</li>)}</ul></details>
          )}
        </Panel>
        <Panel title="Exports" sub="saved to this computer">
          <div className="stack" style={{ gap: 10 }}>
            <ExportRow icon="bi-file-earmark-excel" title="Excel workbook" text="History by month, year-on-year, seasonal profiles, forecast (monthly and daily), assumptions & one-offs, backtest metrics and rules." disabled={!b || !agg}
              busy={busy === 'xlsx'} onClick={async () => {
                if (!b || !agg) return;
                setBusy('xlsx');
                try { downloadBlob(await buildWorkbook({ team, agg, scenario: sc, fc: b.fc, backtest: await defaultBacktest(), appName: APP_NAME }), `cash-flow-insight-${sc.name.replace(/\W+/g, '-').toLowerCase()}.xlsx`); }
                finally { setBusy(null); }
              }} />
            <ExportRow icon="bi-filetype-csv" title="Categorised transactions (CSV)" text="Every line with its category, deal flag, classification, confidence and the rule that decided it — for your own audit trail." disabled={!cat}
              busy={busy === 'csv'} onClick={async () => { setBusy('csv'); try { downloadBlob(await engine().categorisedCsv(cat!.catIds.map((id) => team.categories.find((c) => c.id === id)?.name ?? id)), 'categorised-transactions.csv'); } finally { setBusy(null); } }} />
            <ExportRow icon="bi-printer" title="Report (print / PDF)" text="A clean summary for a treasury report or S151 briefing: low point, borrowing requirement, chart, categories, assumptions, backtest and data quality." disabled={!b}
              onClick={() => setReport(true)} />
          </div>
          <p className="xs muted mt">Charts can be saved as PNG or SVG from the buttons on each chart.</p>
        </Panel>
      </div>
      {report && b && <Report onClose={() => setReport(false)} backtest={defaultBacktest} />}
    </div>
  );
}

function ExportRow({ icon, title, text, onClick, disabled, busy }: { icon: string; title: string; text: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="group-card row" style={{ alignItems: 'flex-start' }}>
      <i className={`bi ${icon} orange`} style={{ fontSize: 26 }} />
      <div style={{ flex: 1 }}><strong className="navy">{title}</strong><div className="small muted">{text}</div></div>
      <button className="btn" disabled={disabled || busy} onClick={onClick}>{busy ? <span className="spinner" /> : <i className="bi bi-download" />} {title.startsWith('Report') ? 'Open' : 'Export'}</button>
    </div>
  );
}

function Report({ onClose, backtest }: { onClose: () => void; backtest: () => Promise<BacktestResult | null> }) {
  const s = useStore();
  const { team, ingest, cat } = s;
  const sc = team.forecasts.find((f) => f.id === s.activeScenarioId) ?? team.forecasts[0];
  const b = useForecast(sc)!;
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [gran, setGran] = useState<'weekly' | 'monthly'>('monthly');
  useEffect(() => { void backtest().then(setBt); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fc = b.fc;
  const fy = (d: number) => { const { y, m } = ymdFromDay(d); const f = m >= 4 ? y : y - 1; return `${f}/${String((f + 1) % 100).padStart(2, '0')}`; };
  const fyLabels = [...new Set(Array.from({ length: fc.H }, (_, d) => fy(fc.start + d)))];
  const rows = fc.explain.filter((e) => Math.abs(e.forecastTotal) > 1).map((e) => {
    const per = fyLabels.map((l) => { let t = 0; for (let d = 0; d < fc.H; d++) if (fy(fc.start + d) === l) t += fc.daily[e.catIdx * fc.H + d]; return t; });
    return { e, per };
  }).sort((a, b2) => Math.abs(b2.e.forecastTotal) - Math.abs(a.e.forecastTotal));
  return (
    <div className="mt-lg">
      <div className="row no-print mb">
        <h2 style={{ margin: 0 }}>Report preview</h2><span className="spacer" />
        <Seg value={gran} onChange={setGran} options={[{ v: 'weekly', label: 'Weekly chart' }, { v: 'monthly', label: 'Monthly chart' }]} />
        <button className="btn primary" onClick={() => window.print()}><i className="bi bi-printer" /> Print / save as PDF</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="card card-pad report">
        <div className="row" style={{ borderBottom: '3px solid var(--pt-orange)', paddingBottom: 10, marginBottom: 14 }}>
          <div><div className="xs muted" style={{ letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700 }}>PWLBtoday · {APP_NAME}</div><h1 style={{ margin: 0 }}>{team.authorityName}: cash flow forecast</h1>
            <div className="small muted">Scenario “{sc.name}” · {day(fc.start)} to {day(fc.start + fc.H - 1)} · prepared {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}{s.user ? ` by ${s.user}` : ''}</div></div>
        </div>
        <div className="grid g4">
          <Kpi label="Projected low point" value={money(fc.low.amount)} sub={day(fc.low.day)} />
          <Kpi label="Borrowing requirement" value={money(fc.borrowingRequirement)} sub={`above a ${money(fc.buffer)} buffer`} />
          <Kpi label="Projected high point" value={money(fc.high.amount)} sub={day(fc.high.day)} />
          <Kpi label="Opening position" value={money(fc.opening)} sub={(sc.settings.openingMode ?? 'bank') === 'bank' ? 'bank balance at end of data' : (sc.settings.openingMode === 'operational' ? 'operational position' : 'entered')} />
        </div>
        <div className="summary-box mt">{fc.summary}</div>
        <h3 className="mt-lg">Cumulative operational cash position</h3>
        <ForecastChart b={b} granularity={gran} historyMonths={18} height={340} />
        <p className="xs muted">Operational flows only — borrowing and investment flows are excluded because they are what this forecast is used to plan. Shaded band: 90% range from historic month-to-month variability.</p>
        <h3 className="mt-lg page-break">Forecast by category</h3>
        <table className="tbl">
          <thead><tr><th>Category</th><th>Method</th><th className="num">Growth</th>{fyLabels.map((l) => <th key={l} className="num">{l}</th>)}</tr></thead>
          <tbody>{rows.map(({ e, per }) => <tr key={e.id}><td>{e.name}</td><td className="xs">{e.method}</td><td className="num">{pct(e.growthPct / 100, 1, true)}</td>{per.map((v, k) => <td key={k} className="num"><Money v={v} /></td>)}</tr>)}
            <tr className="total"><td>Net operational flow</td><td /><td />{fyLabels.map((l) => { let t = 0; for (let d = 0; d < fc.H; d++) if (fy(fc.start + d) === l) t += fc.net[d]; return <td key={l} className="num"><Money v={t} /></td>; })}</tr></tbody>
        </table>
        <h3 className="mt-lg">Assumptions and known items</h3>
        {fc.markers.length === 0 ? <p className="small">No adjustments: the forecast is the historic pattern projected forward with each category’s historic trend.</p> : (
          <ul className="small">{fc.markers.map((m, i) => <li key={i}>{day(m.day)} — {m.label}</li>)}</ul>
        )}
        <h3 className="mt-lg">Backtest</h3>
        {!bt ? <p className="small muted">Running…</p> : (
          <p className="small">Forecasting from {day(bt.cutoff)} using only data before that date, the model’s cumulative position was {bt.errorAt.map((e) => `${money(e.error, { sign: true })} out after ${e.months} months (core ${money(e.coreError, { sign: true })})`).join('; ')}. The forecast low point was {money(bt.lowForecast.amount)} on {day(bt.lowForecast.day)} against an actual {money(bt.lowActual.amount)} on {day(bt.lowActual.day)}. One-off items nobody could have known contributed {money(bt.surpriseOneOffs)}.</p>
        )}
        <h3 className="mt-lg">Data quality</h3>
        {ingest && cat && (
          <ul className="small">
            <li>{int(ingest.rows)} bank transactions from {ingest.files.length} file(s), {day(ingest.minDay)} to {day(ingest.maxDay)}, {ingest.accounts.length} account(s).</li>
            <li>{pct(cat.valueCategorisedPct)} of value categorised; {money(cat.treasuryAbs)} of treasury flows excluded ({money(cat.suspectedAbs)} suspected rather than confirmed).</li>
            <li>{int(ingest.rejectsTotal)} rows rejected with reasons; {ingest.balanceChecks.reduce((t, x) => t + x.breaks, 0)} balance continuity breaks; {int(ingest.dupCandidates)} possible duplicates.</li>
            {cat.dealLikeOpAbs > 0 && <li>{money(cat.dealLikeOpAbs)} of deal-like items remain in the operational model and should be reviewed.</li>}
          </ul>
        )}
        <p className="xs muted mt-lg">Produced with {APP_NAME}. Bank data was processed entirely on the preparer’s computer; no transaction data was uploaded.</p>
      </div>
    </div>
  );
}
