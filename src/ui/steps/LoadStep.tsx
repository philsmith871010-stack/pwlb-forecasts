import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, Progress, Counter, StepFooter, Kpi, Explain, StepTabs, NextTab, useStepTab, TabDef } from '../components/common';
import { openWithPicker, fsAccessSupported, downloadBlob } from '../../lib/teamfile';
import { bytes, day, ago, int } from '../../lib/format';
import { VOLUME_PRESETS, VolumePreset, DEFAULT_GENERATOR_OPTIONS, GeneratorOptions } from '../../generator';
import { engine } from '../../worker/client';

export function LoadStep() {
  const s = useStore();
  const tabs: TabDef[] = [
    { id: 'team', label: 'Team file', badge: s.teamName || s.team.savedAt ? '✓' : '' },
    { id: 'files', label: 'Bank files', badge: s.sources.filter((x) => !x.demo).length || '' },
    { id: 'read', label: 'What we read', disabled: !s.ingest && !s.ingestBusy && !s.ingestError, badge: s.ingest ? s.ingest.rows.toLocaleString('en-GB') : '' },
    { id: 'demo', label: 'Try demo data', badge: s.demo ? '✓' : '' },
  ];
  const [tab, setTab] = useStepTab('load', tabs);
  // jump to the results as soon as reading starts
  const busyRef = useRef(false);
  useEffect(() => {
    if (s.ingestBusy && !busyRef.current) setTab('read');
    busyRef.current = !!s.ingestBusy;
  }, [s.ingestBusy, setTab]);
  return (
    <div className="page">
      <PageHead eyebrow="Step 1 of 8" title="Load your data">
        Bring in your team’s shared file and your bank statements. Nothing leaves this computer.
      </PageHead>
      <StepTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'team' && (
        <>
          <Explain
            what={<>Your team’s shared <strong>team file</strong> — one JSON file on your shared drive holding the rules, bank layouts and forecasts your colleagues have built up.</>}
            why="It means you don’t start from scratch: lines your team has already categorised are recognised automatically, and saved forecasts open straight away."
            todo={<>Click <strong>Open team file</strong>. First time? Type your council’s name and click <strong>Start fresh</strong> — you’ll save a team file at the end.</>} />
          <div className="grid g2"><TeamFileCard /><WhoCard /></div>
          <NextTab label="Next: add bank files" onClick={() => setTab('files')} />
        </>
      )}
      {tab === 'files' && (
        <>
          <Explain
            what="The bank transaction exports (CSV files) for the accounts you want to forecast — ideally three to five years of history."
            why="The forecast learns your council’s cash rhythm — when council tax arrives, when payroll goes out — from this history. More years means a better picture of the seasons."
            todo={<>Drag all your CSV files in at once (several accounts or years is fine), then click <strong>Read files</strong>. No files to hand? Use the <strong>Try demo data</strong> tab.</>} />
          <UploadCard />
          <NextTab label="Or try the demo data" onClick={() => setTab('demo')} text="Haven’t got exports yet?" />
        </>
      )}
      {tab === 'read' && (
        <>
          <Explain
            what="A check of what we found in your files: how many transactions, which dates and accounts, and any lines we couldn’t read."
            why="It’s worth a ten-second sanity check before going further — if the date range or account count looks wrong, a file may be missing or mis-read."
            todo={<>If it looks right, continue to <strong>Map columns</strong>. If some rows were rejected, download the log to see why (usually footer totals or blank dates — that’s fine).</>} />
          <IngestResult />
          {s.ingest && !s.ingestBusy && <StepFooter nextLabel="Check how we read the columns" />}
        </>
      )}
      {tab === 'demo' && (
        <>
          <Explain
            what="Realistic made-up bank history for a fictional council, deliberately messy — different bank formats, odd dates, loans hidden among ordinary payments."
            why="Lets you try every step without real data, and lets us measure how accurately the tool sorts transactions (we know the right answers for this data)."
            todo={<>Leave the settings as they are and click <strong>Generate demo data</strong>. It takes a few seconds.</>} />
          <DemoCard />
        </>
      )}
    </div>
  );
}

function WhoCard() {
  const { user, setUser } = useStore();
  return (
    <Panel title="Who are you?">
      <p className="small muted">Your initials are recorded against rules you create and when you save, so colleagues can see who changed what.</p>
      <div className="field"><label htmlFor="who">Your initials or name</label><input id="who" className="input" value={user} placeholder="e.g. PS" onChange={(e) => setUser(e.target.value)} /></div>
      <p className="xs muted mt">Stored in this browser only.</p>
    </Panel>
  );
}

function TeamFileCard() {
  const { team, teamName, loadTeamText, startFresh, toast } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [authority, setAuthority] = useState('');
  const open = async () => {
    if (fsAccessSupported()) {
      try {
        const r = await openWithPicker();
        if (!r) return;
        const res = loadTeamText(r.text, r.name, r.handle);
        toast(res.ok ? `Loaded ${r.name}${res.message ? ` — ${res.message}` : ''}` : res.message, res.ok ? 'ok' : 'err');
      } catch (e) { if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'err'); }
    } else input.current?.click();
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const res = loadTeamText(await f.text(), f.name, null);
    toast(res.ok ? `Loaded ${f.name}` : res.message, res.ok ? 'ok' : 'err');
  };
  const teamRules = team.rules.length;
  return (
    <Panel title="Team file" sub="shared rules, profiles & forecasts">
      <p className="small muted">One JSON file your team keeps on a shared drive. It holds rules, bank profiles, categories and saved forecasts — <strong>never transaction lines</strong>.</p>
      <div className="row mb">
        <button className="btn primary" onClick={() => void open()}><i className="bi bi-folder2-open" /> Open team file</button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {teamName || team.savedAt ? (
        <div className="card card-pad fade" style={{ boxShadow: 'none' }}>
          <div className="row"><i className="bi bi-file-earmark-check orange" style={{ fontSize: 22 }} /><div><strong className="navy">{team.authorityName}</strong><div className="xs muted">{teamName ?? 'from this browser’s last session'}</div></div></div>
          <dl className="kv mt">
            <dt>Rules</dt><dd>{teamRules}</dd>
            <dt>Aliases</dt><dd>{team.aliases.length}</dd>
            <dt>Categories</dt><dd>{team.categories.length}</dd>
            <dt>Bank profiles</dt><dd>{team.bankProfiles.length}</dd>
            <dt>Saved forecasts</dt><dd>{team.forecasts.length}</dd>
            <dt>Last saved</dt><dd>{team.savedAt ? `${ago(team.savedAt)} by ${team.savedBy || '—'}` : 'not yet'}</dd>
          </dl>
          {team.forecasts.some((f) => f.resultsSnapshot) && <div className="callout navy mt small"><i className="bi bi-eye" /> Saved forecasts can be viewed straight away under <strong>Forecast</strong>, even before you load any CSVs.</div>}
        </div>
      ) : (
        <div className="callout navy small">No team file loaded. You can start fresh — the built-in starter rules already recognise common council flows — and save a team file at the end.</div>
      )}
      <div className="mt">
        <div className="field"><label htmlFor="auth">Authority name (for a fresh start)</label>
          <div className="row tight"><input id="auth" className="input" placeholder="e.g. Northbridge Council" value={authority} onChange={(e) => setAuthority(e.target.value)} />
            <button className="btn" onClick={() => { startFresh(authority || 'My Council'); toast('Started a fresh team file.'); }}>Start fresh</button></div>
        </div>
      </div>
    </Panel>
  );
}

function UploadCard() {
  const { addFiles, sources, removeSource, runIngest, ingestBusy } = useStore();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const realSources = sources.filter((x) => !x.demo);
  return (
    <Panel title="Bank transaction history" sub="one or more CSV exports — accounts and years are merged">
      <div className={`dropzone ${over ? 'over' : ''}`} tabIndex={0} role="button" aria-label="Add bank CSV files"
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles([...e.dataTransfer.files]); }}>
        <i className="bi bi-filetype-csv big-icon" />
        <h3 style={{ marginTop: 8 }}>Drop bank CSVs here</h3>
        <div className="muted small">or click to choose files · several accounts or years at once is fine</div>
        <div className="mt small"><span className="privacy-badge"><i className="bi bi-shield-lock-fill" /> Read locally. Nothing is uploaded.</span></div>
        <input ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      {realSources.length > 0 && (
        <div className="mt">
          <table className="tbl">
            <thead><tr><th>File</th><th className="num">Size</th><th>Detected</th><th>Profile</th><th /></tr></thead>
            <tbody>
              {realSources.map((src) => (
                <tr key={src.name}>
                  <td><i className="bi bi-file-earmark-spreadsheet muted" /> {src.name}</td>
                  <td className="num">{bytes(src.size)}</td>
                  <td><span className={`badge ${src.report.confidence === 'high' ? 'green' : src.report.confidence === 'medium' ? 'amber' : 'red'}`}>{src.report.confidence}</span> <span className="xs muted">{src.mapping.amountMode === 'debitCredit' ? 'Debit/Credit' : 'Signed amount'} · {src.report.dateFormatLabel}</span></td>
                  <td className="small">{src.profileName ? <span className="chip navy"><i className="bi bi-bookmark-check" /> {src.profileName}</span> : <span className="muted xs">new layout</span>}</td>
                  <td><button className="icon-btn" aria-label={`Remove ${src.name}`} onClick={() => removeSource(src.name)}><i className="bi bi-x-lg" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row mt"><div className="spacer" /><button className="btn primary" disabled={!!ingestBusy} onClick={() => void runIngest()}><i className="bi bi-lightning-charge" /> Read {realSources.length} file{realSources.length > 1 ? 's' : ''}</button></div>
        </div>
      )}
    </Panel>
  );
}

function IngestResult() {
  const { ingestBusy, ingest, ingestError, catBusy, cat } = useStore();
  if (ingestError) return <div className="callout red"><strong>Could not read the files.</strong> {ingestError}</div>;
  if (ingestBusy || (catBusy && !cat)) {
    const b = ingestBusy ?? catBusy!;
    return (
      <div className="card card-pad fade">
        <div className="row"><span className="spinner" /><strong className="navy">{b.phase}</strong><div className="spacer" />{b.rows != null && <span className="muted small"><Counter value={b.rows} duration={300} /> rows</span>}</div>
        <div className="mt"><Progress frac={b.frac} /></div>
      </div>
    );
  }
  if (!ingest) return null;
  const rejected = ingest.rejectsTotal;
  return (
    <div className="stack fade">
      <div className="grid g4">
        <Kpi label="Rows read" value={<Counter value={ingest.rows} />} sub={`in ${(ingest.ms / 1000).toFixed(1)}s`} />
        <Kpi label="Date range" value={<span style={{ fontSize: 20 }}>{day(ingest.minDay)}</span>} sub={`to ${day(ingest.maxDay)}`} />
        <Kpi label="Accounts" value={<Counter value={ingest.accounts.length} />} sub={ingest.accounts.slice(0, 3).join(', ')} />
        <Kpi label="Rows rejected" value={<Counter value={rejected} />} sub={rejected ? 'with reasons — see log' : 'none'} />
      </div>
      <div className="card card-pad">
        <div className="row">
          <i className="bi bi-check-circle-fill pos" style={{ fontSize: 20 }} />
          <div style={{ flex: 1 }}>
            <strong className="navy">{int(ingest.rows)} transactions from {ingest.files.length} file{ingest.files.length > 1 ? 's' : ''}.</strong>
            <div className="small muted">
              {ingest.overlapRemoved > 0 && <>{int(ingest.overlapRemoved)} rows appeared in two overlapping exports and were counted once. </>}
              {ingest.swappedDates > 0 && <>{int(ingest.swappedDates)} dates only made sense with day and month swapped and were flagged. </>}
              {ingest.dupCandidates > 0 && <>{int(ingest.dupCandidates)} possible duplicate lines flagged for review. </>}
              {ingest.balanceChecks.length > 0 && <>Balance continuity: {ingest.balanceChecks.map((b) => `${b.breaks} break${b.breaks === 1 ? '' : 's'} in ${int(b.checked)} checks`).join('; ')}.</>}
            </div>
          </div>
          {rejected > 0 && <button className="btn sm" onClick={async () => downloadBlob(await engine().rejectLogBlob(), 'rejected-rows.csv')}><i className="bi bi-download" /> Reject log</button>}
        </div>
        {rejected > 0 && (
          <details className="mt small"><summary className="muted">Why rows were rejected</summary>
            <table className="tbl mt"><thead><tr><th>File</th><th className="num">Line</th><th>Reason</th><th>Raw</th></tr></thead>
              <tbody>{ingest.rejectSample.slice(0, 12).map((r, i) => <tr key={i}><td className="xs">{r.file}</td><td className="num">{r.line}</td><td>{r.reason}</td><td className="mono xs ellipsis" style={{ maxWidth: 280 }}>{r.raw}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>
    </div>
  );
}

function DemoCard() {
  const { generateDemo, ingestBusy, demo, sources } = useStore();
  const [o, setO] = useState<GeneratorOptions>({ ...DEFAULT_GENERATOR_OPTIONS });
  const open = true;
  void sources;
  return (
    <Panel title="Demo data" sub="a fictional council, five years, deliberately messy">
      {open ? (
        <>
          <p className="small muted">A synthetic mid-sized unitary council: council tax, NNDR, payroll, grants, suppliers, schools — plus PWLB, LOBO, LA-to-LA loans, MMFs and DMADF deals hidden among them. Five bank “dialects”, mixed date and amount formats, reversals, duplicates, outliers and structural breaks. A hidden truth file lets the Accuracy panel score the engine.</p>
          <div className="grid g4">
            <div className="field"><label>Volume</label>
              <select className="select" value={o.preset} onChange={(e) => setO({ ...o, preset: e.target.value as VolumePreset })}>
                {(Object.keys(VOLUME_PRESETS) as VolumePreset[]).map((k) => <option key={k} value={k}>{VOLUME_PRESETS[k].label} ({VOLUME_PRESETS[k].approxRows})</option>)}
              </select></div>
            <div className="field"><label>Years</label><input className="input" type="number" min={2} max={8} value={o.years} onChange={(e) => setO({ ...o, years: Math.max(2, Math.min(8, +e.target.value || 5)) })} /></div>
            <div className="field"><label>First financial year</label><input className="input" type="number" min={2015} max={2030} value={o.startFY} onChange={(e) => setO({ ...o, startFY: +e.target.value || 2021 })} /></div>
            <div className="field"><label>Accounts</label><select className="select" value={o.accounts} onChange={(e) => setO({ ...o, accounts: +e.target.value })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></div>
            <div className="field"><label>Seed</label><input className="input" value={o.seed} onChange={(e) => setO({ ...o, seed: e.target.value })} /></div>
            <div className="field"><label>Nastiness</label><select className="select" value={o.nastiness} onChange={(e) => setO({ ...o, nastiness: +e.target.value })}><option value={0}>None</option><option value={0.5}>Mild</option><option value={1}>Full</option><option value={2}>Brutal</option></select></div>
          </div>
          <div className="row mt">
            <button className="btn primary lg" disabled={!!ingestBusy} onClick={() => void generateDemo(o)}><i className="bi bi-magic" /> Generate demo data</button>
            {demo && <span className="small muted">Loaded {int(demo.rows)} generated rows ({demo.options.preset}).</span>}
            <div className="spacer" />
            {demo && <DemoDownloads />}
          </div>
        </>
      ) : <div className="small muted">Generate synthetic data with ground truth for testing.</div>}
    </Panel>
  );
}

function DemoDownloads() {
  const all = useStore((s) => s.sources);
  const sources = all.filter((x) => x.demo);
  return (
    <details className="small">
      <summary className="muted" style={{ cursor: 'pointer' }}>Save generated files</summary>
      <div className="stack mt" style={{ gap: 4 }}>
        {sources.map((s) => <button key={s.name} className="btn sm ghost" onClick={async () => { const b = await engine().demoFileBlob(s.name); if (b) downloadBlob(b, s.name); }}><i className="bi bi-download" /> {s.name}</button>)}
        <button className="btn sm ghost" onClick={async () => { const b = await engine().truthBlob(); if (b) downloadBlob(b, 'truth.json'); }}><i className="bi bi-download" /> truth.json</button>
      </div>
    </details>
  );
}
