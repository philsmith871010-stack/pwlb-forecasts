// Loading statements that are already loaded: nothing is ever counted twice, a part export never
// quietly replaces full days, and the same account under another name is recognised.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest, type Dataset } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { fromSession, addToHistory, type CashHistory } from '../src/lib/history/cashHistory';
import { isoFromDay, dayFromISO } from '../src/lib/dates';

const cfg = { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };
const net = (h: CashHistory) => h.cells.reduce((t, c) => { for (let k = 0; k < c.length; k += 4) t += c[k + 3]; return t; }, 0) / 100;

describe('loading what is already loaded', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'dups', years: 3, nastiness: 0 });
  const ds = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  /** a plain bank export of some days: with the account number column, or without it (one account) */
  const csv = (d: Dataset, from: string, to: string, opts: { account?: string; noAccount?: boolean; every?: number } = {}) => {
    const lines = [opts.noAccount ? 'Date,Description,Amount' : 'Date,Account Number,Description,Amount'];
    let n = 0;
    for (let i = 0; i < d.n; i++) {
      const day = d.day[i];
      if (day < dayFromISO(from) || day > dayFromISO(to)) continue;
      const acct = d.accounts[d.account[i]];
      if (opts.account && acct !== opts.account) continue;
      if (opts.every && n++ % opts.every) continue;
      const iso = isoFromDay(day);
      const date = `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
      lines.push((opts.noAccount ? [date, q(d.narratives[d.narr[i]]), d.amount[i].toFixed(2)] : [date, acct, q(d.narratives[d.narr[i]]), d.amount[i].toFixed(2)]).join(','));
    }
    return lines.join('\n') + '\n';
  };
  const read = async (name: string, text: string, base?: CashHistory) => {
    const s = await ingest([{ name, data: text, size: text.length, mapping: detectMapping(text.slice(0, 96000), name).mapping }]);
    return fromSession(s, categorise(s, cfg), base?.series.map(({ sig, cat, dir }) => ({ sig, cat, dir })) ?? []);
  };
  const lastYear = isoFromDay(ds.maxDay).slice(0, 4);
  const y = Number(lastYear) - 1;
  const histTo = `${y}-09-30`, octFrom = `${y}-10-01`, octTo = `${y}-10-31`;
  const hist = await read('history.csv', csv(ds, isoFromDay(ds.minDay), histTo));
  const oct = csv(ds, octFrom, octTo);
  const withOct = addToHistory(hist, await read('oct.csv', oct)).history;
  const account = ds.accounts[0];

  it('the same statement again, under any name, changes nothing and says so', async () => {
    for (const name of ['oct.csv', 'oct (1).csv']) {
      const r = addToHistory(withOct, await read(name, oct, withOct));
      expect(net(r.history)).toBeCloseTo(net(withOct), 2);
      expect(r.overlap.fresh).toBe(0);
      expect(r.overlap.changed).toHaveLength(0);
      expect(r.overlap.same).toBeGreaterThan(20);
    }
  });

  it('a part export of days already loaded keeps the saved figures, unless asked', async () => {
    const part = await read('part.csv', csv(ds, octFrom, octTo, { every: 2 }), withOct);
    const r = addToHistory(withOct, part);
    expect(r.kept).toBeGreaterThan(10);
    expect(r.overlap.changed.every((c) => c.less)).toBe(true);
    expect(net(r.history)).toBeCloseTo(net(withOct), 2);
    // the user says to use the file anyway
    const forced = addToHistory(withOct, part, true);
    expect(forced.kept).toBe(0);
    expect(Math.abs(net(forced.history) - net(withOct))).toBeGreaterThan(1000);
  });

  it('a fuller statement for days already loaded replaces them (a part day, then the whole day)', async () => {
    // the busiest day in November
    const count = new Map<number, number>();
    for (let i = 0; i < ds.n; i++) if (isoFromDay(ds.day[i]).startsWith(`${y}-11`)) count.set(ds.day[i], (count.get(ds.day[i]) ?? 0) + 1);
    const day = isoFromDay([...count].sort((a, z) => z[1] - a[1])[0][0]);
    const partDay = addToHistory(withOct, await read('am.csv', csv(ds, day, day, { every: 2 }), withOct)).history;
    const r = addToHistory(partDay, await read('day.csv', csv(ds, day, day), partDay));
    expect(r.kept).toBe(0);
    expect(r.overlap.changed.length).toBeGreaterThan(0);
    expect(r.overlap.changed.every((c) => !c.less)).toBe(true);
    const whole = addToHistory(withOct, await read('day.csv', csv(ds, day, day), withOct)).history;
    expect(net(r.history)).toBeCloseTo(net(whole), 2);
  });

  it('a file with no account number is matched to the account it is, not counted again', async () => {
    const one = csv(ds, octFrom, octTo, { account, noAccount: true });
    for (const name of ['current-account.csv', 'export (2).csv']) {
      const r = addToHistory(withOct, await read(name, one, withOct));
      expect(r.history.accounts.map((a) => a.key).sort()).toEqual(withOct.accounts.map((a) => a.key).sort());
      expect(r.matched[0]?.to).toBe(account);
      expect(net(r.history)).toBeCloseTo(net(withOct), 2);
    }
  });

  it('…and its next month too, with no days in common, by its regular payments', async () => {
    const nov = csv(ds, `${y}-11-01`, `${y}-11-30`, { account, noAccount: true });
    const r = addToHistory(withOct, await read('export (3).csv', nov, withOct));
    expect(r.matched[0]?.to).toBe(account);
    expect(r.history.accounts).toHaveLength(withOct.accounts.length);
  });

  it('a file spanning old and new days adds only the new ones', async () => {
    const both = csv(ds, octFrom, `${y}-11-30`);
    const r = addToHistory(withOct, await read('oct-nov.csv', both, withOct));
    const once = addToHistory(withOct, await read('nov.csv', csv(ds, `${y}-11-01`, `${y}-11-30`), withOct)).history;
    expect(r.overlap.same).toBeGreaterThan(20);
    expect(r.overlap.fresh).toBeGreaterThan(20);
    expect(net(r.history)).toBeCloseTo(net(once), 2);
  });

  it('a history saved before lines were counted still recognises the same statement', async () => {
    const old: CashHistory = { ...withOct, lines: undefined };
    const r = addToHistory(old, await read('oct (2).csv', oct, old));
    expect(r.overlap.changed).toHaveLength(0);
    expect(r.overlap.same).toBeGreaterThan(20);
    expect(net(r.history)).toBeCloseTo(net(withOct), 2);
  });
});
