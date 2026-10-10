import { useRef } from 'react';
import { useStore } from '../../state/store';

/** Add more statements to what's loaded (another account, or another day), then read everything again. */
export function AddMoreFiles({ label = 'Add more files' }: { label?: string }) {
  const { addFiles, runIngest, ingestBusy } = useStore();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="btn sm" disabled={!!ingestBusy} onClick={() => input.current?.click()}><i className="bi bi-plus-lg" /> {label}</button>
      <input ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" multiple hidden onChange={async (e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (!fs.length) return; await addFiles(fs); await runIngest(); }} />
    </>
  );
}
