// The header's two menus: the team file (open or save, from anywhere) and settings.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../state/store';
import { openWithPicker, fsAccessSupported } from '../../lib/teamfile';
import { buildHistorySummary } from '../../lib/analysis/snapshot';
import { ago } from '../../lib/format';
import { HistoryChoice } from '../steps/SaveStep';

function Popover({ button, children, align = 'right' }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      {button(open, () => setOpen(!open))}
      {open && <div className={`popover ${align}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Open a team file: the file picker where the browser has one, otherwise a plain file input. */
export function useOpenTeamFile() {
  const { loadTeamText, toast } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const res = loadTeamText(await f.text(), f.name, null);
    toast(res.ok ? `Opened ${f.name}` : res.message, res.ok ? 'ok' : 'err');
  };
  const open = async () => {
    if (fsAccessSupported()) {
      try {
        const r = await openWithPicker();
        if (!r) return;
        const res = loadTeamText(r.text, r.name, r.handle);
        toast(res.ok ? `Opened ${r.name}` : res.message, res.ok ? 'ok' : 'err');
      } catch (e) { if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'err'); }
    } else input.current?.click();
  };
  const el = <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />;
  return { open, el };
}

/** Save the team file (in place where possible), with the history summary refreshed. */
export function useSaveTeamFile() {
  const { agg, team, teamName, updateTeam, saveTeam } = useStore();
  return async (as?: 'saveAs' | 'download') => {
    if (agg && team.settings.includeHistorySummary) updateTeam((t) => ({ ...t, historySummary: buildHistorySummary(agg) }));
    await saveTeam(as ?? (fsAccessSupported() && teamName ? 'save' : fsAccessSupported() ? 'saveAs' : 'download'));
  };
}

export function TeamFileMenu() {
  const { team, teamName, dirty, user, setUser, updateTeam } = useStore();
  const { open, el } = useOpenTeamFile();
  const save = useSaveTeamFile();
  const loaded = !!(teamName || team.savedAt);
  return (
    <>
      {el}
      <Popover button={(o, toggle) => (
        <button className={`btn team-btn ${dirty ? 'primary' : ''}`} aria-expanded={o} onClick={toggle} title={dirty ? 'You have changes to save' : 'Open or save your team file'}>
          <i className="bi bi-folder2" /> <span className="team-name">{teamName ?? (loaded ? team.authorityName : 'Team file')}</span>
          {dirty && <span className="dot warn" style={{ margin: '0 0 0 2px' }} />}
          <i className="bi bi-chevron-down xs" />
        </button>
      )}>
        {(close) => (
          <div className="menu">
            <div className="menu-head">
              <strong>{team.authorityName}</strong>
              <span className="xs muted">{dirty ? 'Unsaved changes' : team.savedAt ? `Saved ${ago(team.savedAt)}${team.savedBy ? ` by ${team.savedBy}` : ''}` : 'Not saved yet'}</span>
            </div>
            <button className="menu-item" onClick={() => { close(); void save(); }}><i className="bi bi-save" /> Save{teamName ? '' : ' team file…'}</button>
            {fsAccessSupported() && <button className="menu-item" onClick={() => { close(); void save('saveAs'); }}><i className="bi bi-files" /> Save as…</button>}
            <button className="menu-item" onClick={() => { close(); void open(); }}><i className="bi bi-folder2-open" /> Open a team file…</button>
            <div className="menu-fields">
              <label className="xs muted" htmlFor="tf-who">Saved by</label>
              <input id="tf-who" className="input sm" value={user} placeholder="your name or initials" onChange={(e) => setUser(e.target.value)} />
              <label className="xs muted" htmlFor="tf-auth">Council</label>
              <input id="tf-auth" className="input sm" value={team.authorityName} onChange={(e) => updateTeam((t) => ({ ...t, authorityName: e.target.value }))} />
              <HistoryChoice />
            </div>
            <div className="menu-note xs muted">Your team’s rules, saved history and forecasts. Keep it on a shared drive. It never holds bank lines.</div>
          </div>
        )}
      </Popover>
    </>
  );
}

export function SettingsMenu() {
  const { showTips, setShowTips, advanced, setAdvanced, goto, cat, step, space, forgetWorkspace, exactAmounts, setExactAmounts } = useStore();
  const { open, el } = useOpenTeamFile();
  const save = useSaveTeamFile();
  return (
    <Popover button={(o, toggle) => (
      <button className="icon-btn header-icon" aria-label="Settings" aria-expanded={o} onClick={toggle} title="Settings"><i className="bi bi-gear" /></button>
    )}>
      {(close) => (
        <div className="menu">
          <label className="menu-item check"><input type="checkbox" checked={showTips} onChange={(e) => setShowTips(e.target.checked)} /> Show explanations on every page</label>
          <label className="menu-item check" title="Every figure in pounds and pence, instead of £m and £k"><input type="checkbox" checked={exactAmounts} onChange={(e) => setExactAmounts(e.target.checked)} /> Show exact amounts (£ and pence)</label>
          <label className="menu-item check" title="Column mapping, sorting rules, all transactions, backtesting, scenarios">
            <input type="checkbox" checked={advanced} onChange={(e) => { setAdvanced(e.target.checked); if (!e.target.checked && ['map', 'categorise', 'backtest', 'data', 'settings'].includes(step)) goto('home'); }} /> Advanced tools
          </label>
          {advanced && <>
            <button className="menu-item" disabled={!cat} onClick={() => { close(); goto('data'); }}><i className="bi bi-list-ul" /> All transactions</button>
            <button className="menu-item" onClick={() => { close(); goto('settings'); }}><i className="bi bi-sliders" /> Rules and settings</button>
          </>}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { close(); void save('download'); }}><i className="bi bi-download" /> Download a copy of your work</button>
          <button className="menu-item" onClick={() => { close(); void open(); }}><i className="bi bi-upload" /> Load a copy…</button>
          <button className="menu-item danger" onClick={() => { close(); void useStore.getState().askConfirm({ title: `Clear ${space === 'example' ? 'the example council’s' : 'your council’s'} saved work?`, body: 'Rules, saved history and forecasts will be removed from this browser. Download a copy first if you might want them.', ok: 'Clear saved work', danger: true }).then((yes) => { if (yes) forgetWorkspace(); }); }}><i className="bi bi-trash" /> Clear saved work…</button>
          <div className="menu-note xs muted"><i className="bi bi-shield-lock" /> Your work is saved in this browser as you go: rules, a cash history (daily totals, never bank lines) and forecasts. Nothing is uploaded.</div>
          {el}
        </div>
      )}
    </Popover>
  );
}

/** Whose cash: your council's, or the example council's. Each is kept separately in this browser. */
export function SpaceSwitch() {
  const { space, switchWorkspace, exampleBusy } = useStore();
  return (
    <div className="space-switch" role="tablist" aria-label="Whose cash">
      <button role="tab" aria-selected={space === 'mine'} className={space === 'mine' ? 'on' : ''} onClick={() => void switchWorkspace('mine')}><span className="ss-long">Your council</span><span className="ss-short">Yours</span></button>
      <button role="tab" aria-selected={space === 'example'} className={space === 'example' ? 'on' : ''} onClick={() => void switchWorkspace('example')}>{exampleBusy ? <span className="spinner sm" /> : <i className="bi bi-stars" />} Example</button>
    </div>
  );
}
