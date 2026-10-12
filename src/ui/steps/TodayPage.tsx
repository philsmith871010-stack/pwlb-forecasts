// Today's statement: drop it in, see the day sorted, sort anything new, save. One screen.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Progress } from '../components/common';
import { DayCard, AlreadyLoaded } from '../history/HistoryCards';
import { EarlyCheck } from '../forecast/EarlyCheck';
import { SortCard, useQueue } from './SimpleReview';
import { engine } from '../../worker/client';
import { historySpan } from '../../lib/history/cashHistory';
import { day } from '../../lib/format';

export function TodayPage() {
  const s = useStore();
  const { ingest, cat, historyBase, ingestBusy, catBusy, addFiles, runIngest, space, useExampleStatement } = s;
  const busy = !!ingestBusy || (!!catBusy && !cat);
  const short = !!ingest && !!cat && ingest.maxDay - ingest.minDay <= 3;
  const long = !!ingest && !!cat && !short;
  const span = historyBase ? historySpan(historyBase) : null;
  const sortRef = useRef<HTMLDivElement>(null);
  // statements read on this page (not, say, years read under Set up and train earlier in the session)
  const [readHere, setReadHere] = useState(false);
  const read = async (files: File[]) => {
    if (!files.length) return;
    setReadHere(true);
    useStore.setState({ sources: [], ingest: null, cat: null });
    await addFiles(files);
    await runIngest();
  };
  return (
    <div className="page narrow">
      <PageHead title="Today’s statement">
        {short ? null
          : span ? <>Your saved history runs to <strong>{day(span.to)}</strong>. Drop in the statement for the days since: we’ll sort it with your team’s rules and add it to your history.</>
          : <>Drop in a bank statement for a day or a few days. We’ll sort it with your team’s rules.</>}
      </PageHead>

      {busy && (
        <div className="card card-pad"><div className="row"><span className="spinner" /><strong className="navy">{ingestBusy ? 'Reading your statement…' : 'Sorting…'}</strong></div>
          <div className="mt"><Progress frac={(ingestBusy ?? catBusy)?.frac ?? 0} /></div></div>
      )}

      {!busy && !short && <TodayDrop onFiles={read} onPick={space === 'example' ? () => void useExampleStatement() : undefined} />}

      {!busy && (short || readHere) && <div className="mb"><AlreadyLoaded /></div>}

      {!busy && long && readHere && (
        <div className="callout mt small">That covers <strong>{day(ingest!.minDay)}</strong> to <strong>{day(ingest!.maxDay)}</strong>, more than a few days, so it has gone straight into your history. To check how it was sorted, use <strong>Set up and train</strong> from the main menu.</div>
      )}

      {!busy && short && (
        <>
          <DayCard onSort={() => sortRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
          <div className="mt"><EarlyCheck from={ingest!.minDay} to={ingest!.maxDay} /></div>
          <div ref={sortRef}><TodaySorting /></div>
        </>
      )}
    </div>
  );
}

/** The drop box. `onPick` replaces the file chooser (the example picks its own statement). */
function TodayDrop({ onFiles, onPick }: { onFiles: (f: File[]) => void; onPick?: () => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choose = () => (onPick ? onPick() : input.current?.click());
  return (
    <div className={`dropzone today-drop ${over ? 'over' : ''}`} tabIndex={0} role="button" aria-label="Choose today’s statement"
      onClick={choose} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') choose(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}>
      <i className="bi bi-file-earmark-arrow-up big-icon" />
      {onPick
        ? <><h3>Click to choose the example’s statement for 31 Mar 2026</h3><p>With your own council: drop the day’s statement here, or click to choose it</p></>
        : <><h3>Drop today’s statement here</h3><p>or <span className="link">click to choose it</span>. One file per account is fine: CSV from your online banking.</p></>}
      <input ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" multiple hidden onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}

/** The day's unsorted lines, sorted on the spot (each choice teaches the tool for next time). */
function TodaySorting() {
  const q = useQueue(() => engine().uncategorisedQueue(40));
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const groups = (q?.groups ?? []).filter((g) => !skipped.has(g.sigIdx));
  useEffect(() => { setSkipped(new Set()); }, [q]);
  if (!groups.length) return null;
  return (
    <div className="today-sort mt">
      <h3 style={{ margin: '0 0 4px' }}>Sort {groups.length === 1 ? 'this line' : `these ${groups.length}`}</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>Choose what each one is. The tool remembers, so next time it’s sorted automatically.</p>
      <div className="stack" style={{ gap: 10 }}>{groups.slice(0, 8).map((g) => <SortCard key={g.sigIdx} g={g} onSkip={() => setSkipped(new Set([...skipped, g.sigIdx]))} />)}</div>
    </div>
  );
}
