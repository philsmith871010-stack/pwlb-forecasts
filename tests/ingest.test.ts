import { describe, it, expect } from 'vitest';
import { parseAmount, parseDate } from '../src/lib/ingest/parseValues';
import { detectMapping } from '../src/lib/ingest/detect';
import { generateDataset } from '../src/generator';
import { isoFromDay } from '../src/lib/dates';

describe('parseAmount', () => {
  it.each([
    ['1,234.56', 1234.56], ['£1,234.56', 1234.56], ['(1,234.56)', -1234.56], ['1,234.56 CR', 1234.56],
    ['1,234.56DR', -1234.56], ['-£14,984.63', -14984.63], ['Â£12.00', 12], ['-Â£12.00', -12], ['"5,000,000.00"', 5e6],
    ['  42 ', 42], ['12.5-', -12.5], ['GBP 10.00', 10],
  ])('%s → %d', (s, v) => expect(parseAmount(s)?.value).toBe(v));
  it.each(['', 'abc', 'TOTALS', '1.2.3'])('rejects %s', (s) => expect(parseAmount(s)).toBeNull());
});

describe('parseDate', () => {
  const iso = (s: string, o: 'DMY' | 'MDY' = 'DMY') => { const r = parseDate(s, o); return r ? isoFromDay(r.day) : null; };
  it('handles the usual suspects', () => {
    expect(iso('03/04/2023')).toBe('2023-04-03');
    expect(iso('03/04/2023', 'MDY')).toBe('2023-03-04');
    expect(iso('2023-04-03')).toBe('2023-04-03');
    expect(iso('03-Apr-23')).toBe('2023-04-03');
    expect(iso('03 Apr 2023')).toBe('2023-04-03');
    expect(iso('45017')).toBe('2023-04-01');
    expect(iso('31/02/2023')).toBeNull();
    expect(iso('TBC')).toBeNull();
  });
  it('swaps when only the other order is valid', () => {
    const r = parseDate('04/25/2023', 'DMY');
    expect(r && isoFromDay(r.day)).toBe('2023-04-25');
    expect(r?.swapped).toBe(true);
  });
});

describe('detectMapping on every generated dialect', () => {
  const ds = generateDataset({ seed: 't', startFY: 2021, years: 1, preset: 'small', accounts: 4, nastiness: 1 });
  for (const f of ds.files) {
    it(f.name, () => {
      const rep = detectMapping(f.text.slice(0, 64000), f.name);
      const m = rep.mapping;
      expect(rep.confidence).not.toBe('low');
      expect(m.date).toBeGreaterThanOrEqual(0);
      expect(m.narrative.length).toBeGreaterThan(0);
      if (m.amountMode === 'signed') expect(m.amount).toBeGreaterThanOrEqual(0);
      else { expect(m.debit).toBeGreaterThanOrEqual(0); expect(m.credit).toBeGreaterThanOrEqual(0); }
      expect(m.dateOrder).toBe('DMY');
    });
  }
});
