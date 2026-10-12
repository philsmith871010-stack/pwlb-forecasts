import { useState } from 'react';
import { useStore, useEyebrow } from '../../state/store';
import { PageHead, Panel, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { isReviewed } from '../forecast/BuildView';
import { historySpan, historyBytes } from '../../lib/history/cashHistory';
import { useForecast } from '../forecast/useForecast';
import { engine } from '../../worker/client';
import { downloadBlob, fsAccessSupported } from '../../lib/teamfile';
import { buildHistorySummary } from '../../lib/analysis/snapshot';
import { buildWorkbook } from '../../lib/export/xlsx';
import { ReportView } from '../report/ReportView';
import type { BacktestResult } from '../../lib/forecast/backtest';
import { pastForecast } from '../forecast/PastCheck';
import { ago, money, day } from '../../lib/format';
import { APP_NAME } from '../../config';

export function SaveStep({ embedded }: { embedded?: boolean } = {}) {
  const advanced = useStore((st) => st.advanced);
  return advanced && !embedded ? <AdvancedSave /> : <SimpleSave embedded={embedded} />;
}

function SimpleSave({ embedded }: { embedded?: boolean }) {
  const s = useStore();
  const { team, agg, dirty, teamName, saveTeam, updateTeam, user, setUser } = s;
  const sc = team.forecasts.find((f) => f.id === s.activeScenarioId) ?? team.forecasts[0];
  const b0 = useForecast(sc);
  // nothing is shared until the forecast has been checked line by line
  const b = sc && b0 && isReviewed(sc, b0) ? b0 : null;
  const eyebrow = useEyebrow('save');
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'cards' | 'report'>('cards');
  // the same check as "Forecast vs actual": the forecast a year ago against what happened
  const defaultBacktest = async (): Promise<BacktestResult | null> =>
    sc ? pastForecast(team.cashHistory ?? s.historyBase, 12, team.categories, sc, +team.settings.financialYearStart.split('-')[0] || 4) : null;
  const save = async () => {
    if (agg && team.settings.includeHistorySummary) updateTeam((t) => ({ ...t, historySummary: buildHistorySummary(agg) }));
    await saveTeam(fsAccessSupported() && teamName ? 'save' : fsAccessSupported() ? 'saveAs' : 'download');
  };
  if (view === 'report' && b) {
    return (
      <div className="page">
        <div className="row no-print mb">
          <button className="btn" onClick={() => setView('cards')}><i className="bi bi-arrow-left" /> Back</button>
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><label htmlFor="rep-name" style={{ whiteSpace: 'nowrap' }}>Council name</label><input id="rep-name" className="input" style={{ width: 220 }} value={team.authorityName} onChange={(e) => updateTeam((t) => ({ ...t, authorityName: e.target.value }))} /></div>
          <span className="small muted">To keep it as a PDF, click the orange button and choose <strong>Save as PDF</strong>.</span>
          <span className="spacer" />
          <button className="btn primary lg" onClick={() => window.print()}><i className="bi bi-file-earmark-pdf" /> Print or save as PDF</button>
        </div>
        <ReportView b={b} backtest={defaultBacktest} />
      </div>
    );
  }
  const reportCard = (
    <div className="save-card primary">
          <i className="bi bi-file-earmark-richtext" />
          <h3>The report</h3>
          <p>Seven pages for your manager or section 151 officer: the low point, the borrowing need, options, charts and assumptions.</p>
          <button className="btn primary lg" disabled={!b} onClick={() => setView('report')}><i className="bi bi-eye" /> View and download</button>
        </div>
  );
  const excelCard = (
    <div className="save-card">
          <i className="bi bi-file-earmark-excel" />
          <h3>Excel spreadsheet</h3>
          <p>Every number, month by month and by category, for your own spreadsheets.</p>
          <button className="btn lg" disabled={!b || !agg || busy === 'xlsx'} onClick={() => void downloadExcel()}>{busy === 'xlsx' ? <span className="spinner" /> : <i className="bi bi-download" />} Download Excel</button>
        </div>
  );
  const downloadExcel = async () => {
    if (!b || !agg) return;
    setBusy('xlsx');
    try { downloadBlob(await buildWorkbook({ team, agg, scenario: sc, fc: b.fc, backtest: await defaultBacktest(), appName: APP_NAME, strategy: b.strategy, registerName: useStore.getState().register?.name }), `cash-flow-forecast-${team.authorityName.replace(/\W+/g, '-').toLowerCase()}.xlsx`); }
    finally { setBusy(null); }
  };
  // inside the forecast: the report itself, with the two ways to take it away
  if (embedded && b) return (
    <>
      <div className="report-bar no-print">
        <div className="field inline"><label htmlFor="rep-name">Council name</label><input id="rep-name" className="input" style={{ width: 220 }} value={team.authorityName} onChange={(e) => updateTeam((t) => ({ ...t, authorityName: e.target.value }))} /></div>
        <span className="spacer" />
        <button className="btn" disabled={!agg || busy === 'xlsx'} onClick={() => void downloadExcel()}>{busy === 'xlsx' ? <span className="spinner sm" /> : <i className="bi bi-file-earmark-excel" />} Download Excel</button>
        <button className="btn primary" onClick={() => window.print()} title="Choose Save as PDF in the print dialog to keep a PDF"><i className="bi bi-file-earmark-pdf" /> Print or save as PDF</button>
      </div>
      <ReportView b={b} backtest={defaultBacktest} />
    </>
  );
  return (
    <div className="page narrow">
      <PageHead eyebrow={eyebrow} title="Save & share">
        Take your forecast away as a report or spreadsheet, and save your work so you can pick it up next time.
      </PageHead>
      {!b && b0 && (
        <div className="callout mb"><strong>Your forecast isn’t ready to share yet.</strong> Check each line on the Build the forecast step first. The report and Excel file become available once you’ve seen your forecast.
          {' '}<button className="link-btn" onClick={() => { s.setStepTab('forecast-simple', 'lines'); s.setStepTab('forecast', 'lines'); s.goto('forecast'); }}>Go to Build the forecast</button></div>
      )}
      {b && <div className="summary-box mb"><div className="eyebrow">Your forecast in one line</div>
        Lowest point <strong>{money(b.fc.low.amount)}</strong> on <strong>{day(b.fc.low.day)}</strong>{b.fc.borrowingRequirement > 0 ? <> — you may need to borrow about <strong>{money(b.fc.borrowingRequirement)}</strong> to keep {money(b.fc.buffer)} in the bank.</> : <> — no borrowing needed to keep {money(b.fc.buffer)} in the bank.</>}
      </div>}
      <div className="save-cards">
        {reportCard}
        {excelCard}
        <div className="save-card">
          <i className="bi bi-floppy" />
          <h3>Save your work</h3>
          <p>Saves the sorting decisions, forecast settings and any figures you typed or imported today in a <strong>team file</strong> (no bank transactions). Next time, open it from the Team file menu and everything is remembered.</p>
          <HistoryChoice />
          <div className="field"><label htmlFor="who-s">Your name or initials</label><input id="who-s" className="input" value={user} placeholder="e.g. Sam Patel" onChange={(e) => setUser(e.target.value)} /></div>
          <div className="field"><label htmlFor="auth-s">Council name</label><input id="auth-s" className="input" value={team.authorityName} onChange={(e) => updateTeam((t) => ({ ...t, authorityName: e.target.value }))} /></div>
          <button className={`btn lg ${dirty ? 'navy' : ''}`} onClick={() => void save()}><i className="bi bi-save" /> {dirty ? 'Save team file' : team.savedAt ? `Saved ${ago(team.savedAt)}` : 'Save team file'}</button>
          <span className="xs muted">Keep it somewhere your team can reach, such as a shared drive.</span>
        </div>
      </div>
    </div>
  );
}

/** Whether the team file keeps the cash history, and what that means. */
export function HistoryChoice() {
  const { team, updateTeam } = useStore();
  const h = team.cashHistory;
  if (!h || h.example) return null;
  const span = historySpan(h);
  const kb = Math.round(historyBytes(h) / 1024);
  const on = team.settings.keepCashHistory !== false;
  return (
    <label className="check history-choice">
      <input type="checkbox" checked={on} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, keepCashHistory: e.target.checked } }))} />
      <span>
        <strong>Keep your cash history</strong>{span ? <> ({day(span.from)} to {day(span.to)}, about {kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`})</> : ''}, so next time you only add new bank files.
        <small>It holds daily totals by category for each bank account, and the dates and amounts of regular payments with their payee names (e.g. payroll, grants). No individual bank lines.</small>
      </span>
    </label>
  );
}

function AdvancedSave() {
  const s = useStore();
  const { team, agg, cat, dirty, teamName, saveTeam, updateTeam, user, setUser } = s;
  const sc = team.forecasts.find((f) => f.id === s.activeScenarioId) ?? team.forecasts[0];
  const b0 = useForecast(sc);
  // nothing is shared until the forecast has been checked line by line
  const b = sc && b0 && isReviewed(sc, b0) ? b0 : null;
  const [busy, setBusy] = useState<string | null>(null);
  const eyebrow = useEyebrow('save');
  const tabs: TabDef[] = [{ id: 'team', label: 'Save team file', badge: dirty ? 'unsaved' : '' }, { id: 'exports', label: 'Excel & CSV' }, { id: 'report', label: 'Report / PDF', disabled: !b }];
  const [tab, setTab] = useStepTab('save', tabs);

  const prepareSnapshot = () => {
    if (agg && team.settings.includeHistorySummary) updateTeam((t) => ({ ...t, historySummary: buildHistorySummary(agg) }));
  };
  const doSave = async (mode: 'save' | 'saveAs' | 'download') => { prepareSnapshot(); await saveTeam(mode); };
  // the same check as "Forecast vs actual": the forecast a year ago against what happened
  const defaultBacktest = async (): Promise<BacktestResult | null> =>
    sc ? pastForecast(team.cashHistory ?? s.historyBase, 12, team.categories, sc, +team.settings.financialYearStart.split('-')[0] || 4) : null;

  return (
    <div className="page">
      <div className="no-print">
        <PageHead eyebrow={eyebrow} title="Save and share">
          Save your team’s knowledge for next time, and take the results into your treasury report.
        </PageHead>
        <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      </div>
      {tab === 'team' && <div className="no-print">
        <Explain
          what="Saves the team file: your rules, bank layouts, categories and forecasts. It never contains any bank transactions."
          why="Next time — or when a colleague opens it — everything taught today is applied automatically, and saved forecasts can be viewed straight away."
          todo={<>Click <strong>Save</strong>. If a colleague changed the file since you opened it, you’ll see both versions and nothing is lost.</>} />
        <div style={{ maxWidth: 760 }}>
        <Panel title="Team file" sub={dirty ? 'unsaved changes' : team.savedAt ? `saved ${ago(team.savedAt)}` : 'not saved yet'}>
          <p className="small">Contains <strong>{team.rules.length}</strong> rules, <strong>{team.aliases.length}</strong> aliases, <strong>{team.bankProfiles.length}</strong> bank profiles, <strong>{team.categories.length}</strong> categories and <strong>{team.forecasts.length}</strong> forecasts. <strong>No transaction lines.</strong></p>
          <label className="check mb"><input type="checkbox" checked={team.settings.includeHistorySummary} onChange={(e) => updateTeam((t) => ({ ...t, settings: { ...t.settings, includeHistorySummary: e.target.checked } }))} />
            Include a category × month history summary (aggregates only) so colleagues can view history without the CSVs</label>
          <HistoryChoice />
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
        </div>
        <NextTab label="Next: Excel & CSV" onClick={() => setTab('exports')} />
      </div>}
      {tab === 'exports' && <div className="no-print">
        <Explain compact what="Downloads created here on your computer — nothing is sent anywhere." todo="Pick what you need. The Excel workbook has everything: history, growth, the forecast table and the assumptions." />
        <div style={{ maxWidth: 860 }}>
        <Panel title="Exports" sub="saved to this computer">
          <div className="stack" style={{ gap: 10 }}>
            <ExportRow icon="bi-file-earmark-excel" title="Excel workbook" text="History by month, year-on-year, seasonal profiles, forecast (monthly and daily), assumptions & one-offs, backtest metrics and rules." disabled={!b || !agg}
              busy={busy === 'xlsx'} onClick={async () => {
                if (!b || !agg) return;
                setBusy('xlsx');
                try { downloadBlob(await buildWorkbook({ team, agg, scenario: sc, fc: b.fc, backtest: await defaultBacktest(), appName: APP_NAME, strategy: b.strategy, registerName: useStore.getState().register?.name }), `cash-flow-insight-${sc.name.replace(/\W+/g, '-').toLowerCase()}.xlsx`); }
                finally { setBusy(null); }
              }} />
            <ExportRow icon="bi-filetype-csv" title="Categorised transactions (CSV)" text="Every line with its category, deal flag, classification, confidence and the rule that decided it — for your own audit trail." disabled={!cat}
              busy={busy === 'csv'} onClick={async () => { setBusy('csv'); try { downloadBlob(await engine().categorisedCsv(cat!.catIds.map((id) => team.categories.find((c) => c.id === id)?.name ?? id)), 'categorised-transactions.csv'); } finally { setBusy(null); } }} />
            <ExportRow icon="bi-printer" title="Report (print / PDF)" text="A clean summary for a treasury report or S151 briefing: low point, borrowing requirement, chart, categories, assumptions, backtest and data quality." disabled={!b}
              onClick={() => setTab('report')} />
          </div>
          <p className="xs muted mt">Charts can be saved as PNG or SVG from the buttons on each chart.</p>
        </Panel>
        </div>
        <NextTab label="Next: report" onClick={() => setTab('report')} />
      </div>}
      {tab === 'report' && b && <>
        <div className="no-print"><Explain compact what="A ready-made summary for a treasury report or section 151 briefing: low point, borrowing need, chart, categories, assumptions, backtest and data quality." todo={<>Click <strong>Print / save as PDF</strong>, then choose “Save as PDF” in the print dialog.</>} /></div>
        <div className="row no-print mb"><span className="small muted">Six A4 pages: cover, executive summary, month by month, drivers & assumptions, history, and confidence.</span><span className="spacer" /><button className="btn primary lg" onClick={() => window.print()}><i className="bi bi-printer" /> Print / save as PDF</button></div>
        <ReportView b={b} backtest={defaultBacktest} />
      </>}
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
