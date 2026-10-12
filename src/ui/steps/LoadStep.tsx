import { useRef, useState } from 'react';
import { useStore, useEyebrow } from '../../state/store';
import { PageHead, Progress, Counter, Explain } from '../components/common';
import { downloadBlob } from '../../lib/teamfile';
import { bytes, day, int, pctDone } from '../../lib/format';
import { VOLUME_PRESETS, VolumePreset, DEFAULT_GENERATOR_OPTIONS, GeneratorOptions } from '../../generator';
import { engine } from '../../worker/client';
import { HistoryAddedNote, AlreadyLoaded } from '../history/HistoryCards';
import { AddMoreFiles } from '../components/AddMoreFiles';

export function LoadStep() {
  const s = useStore();
  const eyebrow = useEyebrow('load');
  const busy = !!s.ingestBusy || (!!s.catBusy && !s.cat);
  const done = !!s.ingest && !!s.cat && !busy;
  const saved = s.historyBase;
  // a day or two of bank data added to a saved history: show the day itself
  const daily = done && !!saved && !s.demo && s.ingest!.maxDay - s.ingest!.minDay <= 3;
  return (
    <div className="page narrow">
      <PageHead eyebrow={eyebrow} title={saved ? 'Add to your history' : 'Load your bank history'}>
        {saved
          ? <>Add the latest month, quarter or year. It joins your saved history; nothing is counted twice.</>
          : <>Three to five years of bank statements. The more history, the better the forecast.</>}
      </PageHead>

      {s.ingestError && <div className="callout red mb"><strong>We couldn’t read those files.</strong> {s.ingestError}</div>}
      {busy && <ReadingCard />}
      {done && !daily && <DoneCard />}


      {!busy && !done && (
        <>
          <Explain
            what={saved
              ? <>Bank statement exports (<strong>CSV files</strong>) for the days since your history ends, or any period you want to load again. One day is fine.</>
              : <>Bank statement exports — the <strong>CSV files</strong> you can download from your online banking. Three to five years is ideal.</>}
            todo="Drag your files into the box below. Several files (different accounts or years) is fine." />
          {s.space === 'example' && s.advanced && !s.sources.length && <DemoCard />}
          {!(s.space === 'example' && s.sources.length) && <UploadCard />}
          {s.sources.length > 0 && <FileList />}
        </>
      )}
    </div>
  );
}

function UploadCard() {
  const { addFiles, space, pickExampleFiles, exampleBusy } = useStore();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // the example: the same box and the same click, but it picks the example council's files
  const choose = () => (space === 'example' ? void pickExampleFiles() : input.current?.click());
  if (exampleBusy) return <div className="dropzone big"><span className="spinner" /><h3>Choosing the example files…</h3></div>;
  return (
    <div className={`dropzone big ${over ? 'over' : ''}`} tabIndex={0} role="button" aria-label="Choose bank statement files"
      onClick={choose} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') choose(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles([...e.dataTransfer.files]); }}>
      <i className="bi bi-file-earmark-arrow-up big-icon" />
      {space === 'example'
        ? <><h3>Click to choose the example council’s files</h3><p>With your own council: drag your bank’s CSV files here, or click to choose them</p></>
        : <><h3>Use my bank files</h3><p>Drag CSV files here, or <span className="link">click to choose them</span></p></>}
      <input ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}

function FileList() {
  const { sources, removeSource, runIngest, ingestBusy } = useStore();
  const real = sources;
  return (
    <div className="card card-pad mt fade">
      <h3 style={{ marginTop: 0 }}>{real.length} file{real.length > 1 ? 's' : ''} ready to read</h3>
      <ul className="list-plain">
        {real.map((src) => (
          <li key={src.name} className="row tight">
            <i className="bi bi-file-earmark-spreadsheet orange" />
            <span style={{ flex: 1 }}>{src.name} <span className="xs muted">· {bytes(src.size)}</span></span>
            {src.profileName && <span className="badge green" title="Your team has read this kind of file before">known layout</span>}
            <button className="icon-btn" aria-label={`Remove ${src.name}`} onClick={() => removeSource(src.name)}><i className="bi bi-x-lg" /></button>
          </li>
        ))}
      </ul>
      <div className="row mt">{!real.some((x) => x.demo) && <span className="small muted">You can still add more files.</span>}<span className="spacer" />
        <button className="btn primary lg" disabled={!!ingestBusy} onClick={() => void runIngest()}>Read my files <i className="bi bi-arrow-right" /></button></div>
    </div>
  );
}

function DemoCard() {
  const { generateDemo, ingestBusy, advanced } = useStore();
  const [o, setO] = useState<GeneratorOptions>({ ...DEFAULT_GENERATOR_OPTIONS });
  return (
    <div className="choice-panel">
      <i className="bi bi-stars big-icon" />
      <h3>Explore with example data</h3>
      <p>A made-up council with five years of realistic bank history. Nothing to prepare — ideal for a first look.</p>
      {advanced && (
        <div className="grid g2 mb" style={{ textAlign: 'left' }}>
          <div className="field"><label>Size</label>
            <select className="select" value={o.preset} onChange={(e) => setO({ ...o, preset: e.target.value as VolumePreset })}>
              {(Object.keys(VOLUME_PRESETS) as VolumePreset[]).map((k) => <option key={k} value={k}>{VOLUME_PRESETS[k].label} ({VOLUME_PRESETS[k].approxRows})</option>)}
            </select></div>
          <div className="field"><label>Messiness</label><select className="select" value={o.nastiness} onChange={(e) => setO({ ...o, nastiness: +e.target.value })}><option value={0}>Clean</option><option value={1}>Realistic</option><option value={2}>Very messy</option></select></div>
          <div className="field"><label>Years</label><input className="input" type="number" min={2} max={8} value={o.years} onChange={(e) => setO({ ...o, years: Math.max(2, Math.min(8, +e.target.value || 5)) })} /></div>
          <div className="field"><label>Accounts</label><select className="select" value={o.accounts} onChange={(e) => setO({ ...o, accounts: +e.target.value })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></div>
        </div>
      )}
      <button className="btn navy lg" disabled={!!ingestBusy} onClick={() => void generateDemo(o)}><i className="bi bi-play-fill" /> Use example data</button>
    </div>
  );
}

function ReadingCard() {
  const { ingestBusy, catBusy } = useStore();
  const b = ingestBusy ?? catBusy;
  if (!b) return null;
  const phase = ingestBusy ? 'Reading your files' : 'Sorting the transactions';
  return (
    <div className="card card-pad fade reading">
      <div className="row"><span className="spinner" /><strong className="navy" style={{ fontSize: 17 }}>{phase}…</strong><div className="spacer" />{b.rows != null && <span className="muted"><Counter value={b.rows} duration={300} /> transactions</span>}</div>
      <div className="mt"><Progress frac={b.frac} /></div>
      <p className="small muted mt" style={{ marginBottom: 0 }}>This usually takes a few seconds. It all happens on this computer.</p>
    </div>
  );
}

function DoneCard() {
  const { ingest, cat, sources, goto, setStepTab, demo, advanced } = useStore();
  if (!ingest || !cat) return null;
  const needCheck = sources.filter((s) => s.report.confidence === 'low');
  const toCheck = cat.uncategorisedRows + cat.suspectedRows + cat.dealLikeOpRows;
  return (
    <div className="card done-card fade">
      <div className="done-head">
        <i className="bi bi-check-circle-fill" />
        <div>
          <h2>We read <Counter value={ingest.rows} /> transactions</h2>
          <p>{demo ? 'Example data for a made-up council' : `From ${ingest.files.length} file${ingest.files.length > 1 ? 's' : ''}`}, covering <strong>{day(ingest.minDay)}</strong> to <strong>{day(ingest.maxDay)}</strong>, across {ingest.accounts.length} bank account{ingest.accounts.length > 1 ? 's' : ''}.</p>
        </div>
      </div>
      <ul className="done-list">
        <li><i className="bi bi-check2" /> {pctDone(cat.valueCategorisedPct)} of the money is sorted, with loans and investments set aside, and it’s saved to your history.</li>
        <HistoryAddedNote gapsOnly />
        {advanced && ingest.rejectsTotal > 0 && <li className="muted"><i className="bi bi-info-circle" /> {int(ingest.rejectsTotal)} lines were skipped, such as totals rows or lines without a date. <button className="link-btn" onClick={async () => downloadBlob(await engine().rejectLogBlob(), 'skipped-lines.csv')}>See which</button></li>}
        {needCheck.length > 0 && <li className="warn"><i className="bi bi-exclamation-triangle" /> {needCheck.length} file{needCheck.length > 1 ? 's have' : ' has'} an unusual layout. <button className="link-btn" onClick={() => goto('map')}>Check {needCheck.length > 1 ? 'them' : 'it'}</button></li>}
      </ul>
      <AlreadyLoaded />
      <div className="done-next">
        <span className="muted">{toCheck > 0 ? '' : 'Everything was sorted confidently.'}</span>
        <button className="btn primary lg" onClick={() => { setStepTab('review', 'overview'); goto('review'); }}>Next: check the sorting <i className="bi bi-arrow-right" /></button>
      </div>
      {!demo && <div className="xs muted row" style={{ marginTop: 12, gap: 10 }}><AddMoreFiles /> <span>or use different files: <button className="link-btn" onClick={() => useStore.setState({ ingest: null, cat: null, agg: null, basis: null, sources: [], demo: null })}>Start again</button></span></div>}
    </div>
  );
}


