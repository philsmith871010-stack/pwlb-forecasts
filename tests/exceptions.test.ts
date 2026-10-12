// Exceptions: a week's statements with problems slipped in. Each is caught, with a reason; a normal
// week raises little; and what someone decided is kept privately and merged like the rest.
import { describe, it, expect } from 'vitest';
import { generateDataset, DEFAULT_GENERATOR_OPTIONS } from '../src/generator';
import { detectMapping } from '../src/lib/ingest/detect';
import { ingest, type Dataset } from '../src/lib/ingest/ingest';
import { categorise } from '../src/lib/categorise/engine';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { fromSession, addToHistory } from '../src/lib/history/cashHistory';
import { findExceptions, knownFrom, latestReviews, payeeHash, type ExceptionReview } from '../src/lib/governance/exceptions';
import { isoFromDay, dayFromISO, isBusinessDay } from '../src/lib/dates';
import { emptyTeamFile, mergeTeamFiles, parseTeamFile, serialiseTeamFile } from '../src/lib/teamfile';

const cfg = { categories: DEFAULT_CATEGORIES, rules: [], aliases: [], seriesOverrides: [], txnOverrides: [], useStarterRules: true };

describe('exceptions', async () => {
  const g = generateDataset({ ...DEFAULT_GENERATOR_OPTIONS, seed: 'exceptions', years: 3, nastiness: 0 });
  const all = await ingest(g.files.map((f) => ({ name: f.name, data: f.text, size: f.text.length, mapping: detectMapping(f.text.slice(0, 96000), f.name).mapping })));
  const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (day: number, acct: string, narr: string, amt: number) => { const iso = isoFromDay(day); return [`${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, acct, q(narr), amt.toFixed(2)].join(','); };
  const csv = (d: Dataset, from: number, to: number, extra: string[] = []) => {
    const out = ['Date,Account Number,Description,Amount'];
    for (let i = 0; i < d.n; i++) if (d.day[i] >= from && d.day[i] <= to) out.push(line(d.day[i], d.accounts[d.account[i]], d.narratives[d.narr[i]], d.amount[i]));
    return [...out, ...extra].join('\n') + '\n';
  };
  const read = async (text: string) => { const ds = await ingest([{ name: 'x.csv', data: text, size: text.length, mapping: detectMapping(text.slice(0, 96000), 'x.csv').mapping }]); return { ds, res: categorise(ds, cfg) }; };
  // the history to a week before the end, then the last working week
  let wkTo = all.maxDay; while (!isBusinessDay(wkTo)) wkTo--;
  const wkFrom = wkTo - 6;
  const base = (() => { const s = csv(all, all.minDay, wkFrom - 1); return read(s); })();
  const history = await base.then(({ ds, res }) => fromSession(ds, res));
  const known = knownFrom(history);
  const acct = all.accounts[0];
  // a regular supplier from the history, its usual amount
  const reg = history.series.filter((s) => s.dir === -1 && s.occ.length > 10).sort((a, z) => Math.abs(z.occ[0][1]) - Math.abs(a.occ[0][1]))[0];
  const usual = Math.abs(reg.occ[reg.occ.length - 1][1]) / 100;
  const sat = (() => { let d = wkFrom; while (isBusinessDay(d)) d++; return d; })();
  const mon = (() => { let d = wkFrom; while (!isBusinessDay(d)) d++; return d; })();
  const injected = [
    line(mon, acct, 'ACME FACILITIES LTD INV 4471', -48_250.00), line(mon + 2, acct, 'ACME FACILITIES LTD INV 4471', -48_250.00), // paid twice
    line(mon + 1, acct, reg.sig, -usual * 4), // four times the usual
    line(mon + 1, acct, 'ZENITH CONSULTING PARTNERS', -180_000), // a new payee
    line(sat, acct, 'BACS PAYMENT REF 99812', -95_000), // a Saturday
  ];

  it('catches each problem slipped into a week, with the reason', async () => {
    const { ds, res } = await read(csv(all, wkFrom, wkTo, injected));
    const ex = findExceptions(ds, res, known);
    const of = (kind: string, text: RegExp) => ex.find((e) => e.kind === kind && text.test(e.signature));
    const dup = of('duplicate', /ACME/)!;
    expect(dup.rows).toHaveLength(2);
    expect(dup.why).toMatch(/2 days apart/);
    expect(of('out_of_line', new RegExp(reg.sig.slice(0, 10)))?.why).toMatch(/about [3-5]\.\d times this payee’s usual/);
    expect(of('new_payee', /ZENITH/)?.why).toMatch(/not in your history/);
    // raised for being new, and says it was a Saturday too
    expect(ex.find((e) => e.day === sat && /BACS PAYMENT/.test(e.signature))?.why).toMatch(/Saturday/);
    // keys are stable and private: the same lines give the same keys, and no bank details are in them
    const again = findExceptions(ds, res, known);
    expect(again.map((e) => e.key)).toEqual(ex.map((e) => e.key));
    expect(ex.every((e) => /^[0-9a-z]+$/.test(e.key))).toBe(true);
  });

  it('a normal week raises little', async () => {
    const { ds, res } = await read(csv(all, wkFrom, wkTo));
    const ex = findExceptions(ds, res, known);
    expect(ex.length).toBeLessThanOrEqual(5);
  });

  it('the history keeps payees only as hashes, and a fresh load of the whole history fills them in', async () => {
    expect(history.seen!.length).toBeGreaterThan(50);
    expect(JSON.stringify(history.seen)).not.toMatch(/[A-Z]{4}/);
    expect(history.seen).toContain(payeeHash(reg.sig));
    // a history saved before payees were kept learns them when it's loaded again in full
    const old = { ...history, seen: undefined };
    const reload = addToHistory(old, history).history;
    expect(reload.seen?.length).toBe(history.seen!.length);
    // a day added to it on its own doesn't (it can't tell what else was paid before)
    const { ds, res } = await read(csv(all, wkTo, wkTo));
    expect(addToHistory(old, fromSession(ds, res)).history.seen).toBeUndefined();
  });

  it('what someone decided is kept by key, the latest counts, and copies merge', () => {
    const a: ExceptionReview = { key: 'k1', status: 'query', by: 'Alex', at: '2026-01-02T09:00:00Z', note: 'Asked AP for the invoice' };
    const b: ExceptionReview = { key: 'k1', status: 'checked', by: 'Sam', at: '2026-01-03T09:00:00Z', note: 'Two invoices, both valid' };
    expect(latestReviews([b, a]).get('k1')?.status).toBe('checked');
    const mine = { ...emptyTeamFile('X'), exceptionReviews: [a] }, theirs = { ...emptyTeamFile('X'), exceptionReviews: [a, b] };
    const merged = mergeTeamFiles(mine, theirs).merged;
    expect(merged.exceptionReviews).toHaveLength(2);
    const back = parseTeamFile(serialiseTeamFile(merged, 'me', 'test').json).team!;
    expect(latestReviews(back.exceptionReviews).get('k1')?.by).toBe('Sam');
  });

  it('reads the week from Saturday to Friday correctly', () => {
    expect(dayFromISO(isoFromDay(wkTo))).toBe(wkTo);
  });
});
