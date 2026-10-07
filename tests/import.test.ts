// Importing schedules other departments send: columns found, names matched, figures placed.
import { describe, it, expect } from 'vitest';
import { readTableText, detectColumns, matchCategory, buildImport, categoryNames, importToOverrides, guessDateOrder, suggestReplacedRows } from '../src/lib/forecast/importSchedule';
import { DEFAULT_CATEGORIES } from '../src/lib/categories';
import { dayFromISO } from '../src/lib/dates';

const CSV = `Grants schedule 2026/27 (from Finance)
,,,
Payment date,Grant,Description,Amount (£)
07/05/2026,Housing Benefit subsidy,DWP HB May,"3,300,000"
04/06/2026,Housing Benefit subsidy,DWP HB Jun,"3,300,000"
14/07/2026,New Homes Bonus,MHCLG,"£750,000.00"
14/07/2026,Mystery stream,???,"10,000"
31/13/2026,New Homes Bonus,bad date,"1"
15/08/2026,Council tax refunds,,(25000)
`;

describe('schedule import', () => {
  const rows = readTableText(CSV);
  const cols = detectColumns(rows)!;

  it('finds the header row and the columns, under a title and a blank line', () => {
    expect(cols).not.toBeNull();
    expect(rows[cols.header][0]).toBe('Payment date');
    expect([cols.date, cols.category, cols.description, cols.amount]).toEqual([0, 1, 2, 3]);
  });

  it('matches other departments’ names to our categories', () => {
    const m = (t: string) => matchCategory(t, DEFAULT_CATEGORIES);
    expect(m('Housing Benefit subsidy')).toBe('grants_general'); // a grant in, not benefit paid out
    expect(m('Housing benefit payments')).toBe('housing_benefit');
    expect(m('New Homes Bonus')).toBe('grants_general');
    expect(m('Mystery stream')).toBe(null); // not obvious: the user chooses
    expect(m('DWP grant')).toBe('grants_general');
    expect(m('Council tax refunds')).toBe('council_tax');
    expect(m('NNDR')).toBe('business_rates');
    expect(m('Payroll')).toBe('salaries');
    expect(m('Supplier payments')).toBe('suppliers');
    expect(categoryNames(rows, cols)).toEqual(['Housing Benefit subsidy', 'New Homes Bonus', 'Mystery stream', 'Council tax refunds']);
  });

  it('builds dated lines, signs from the category, and says what it skipped', () => {
    const r = buildImport(rows, {
      columns: cols, dateOrder: 'DMY', singleCategory: null, signs: 'direction', categories: DEFAULT_CATEGORIES,
      categoryMap: { 'Housing Benefit subsidy': 'grants_general', 'New Homes Bonus': 'grants_general', 'Mystery stream': '', 'Council tax refunds': 'council_tax' },
    });
    expect(r.lines.map((l) => [l.categoryId, l.amount])).toEqual([['grants_general', 3.3e6], ['grants_general', 3.3e6], ['grants_general', 750000], ['council_tax', 25000]]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['“Mystery stream” isn’t matched to a category', '“31/13/2026” isn’t a date']);
    // signed mode keeps the file's own signs
    const s = buildImport(rows, { columns: cols, dateOrder: 'DMY', singleCategory: 'council_tax', signs: 'signed', categories: DEFAULT_CATEGORIES, categoryMap: {} });
    expect(s.lines.at(-1)!.amount).toBe(-25000);
    // a payments line takes money out
    const p = buildImport(rows, { columns: cols, dateOrder: 'DMY', singleCategory: 'suppliers', signs: 'direction', categories: DEFAULT_CATEGORIES, categoryMap: {} });
    expect(p.lines[0].amount).toBe(-3.3e6);
  });

  it('turns lines into grid figures, replacing our forecast only for the months covered', () => {
    const r = buildImport(rows, { columns: cols, dateOrder: 'DMY', singleCategory: 'grants_general', signs: 'direction', categories: DEFAULT_CATEGORIES, categoryMap: {} });
    const { overrides, outside } = importToOverrides(r.lines, 'Finance grants', 'replace_months', { grants_general: [{ row: 'pattern' }, { row: 'series:DWP HB', months: ['2026-05', '2026-06'] }] }, { from: dayFromISO('2026-04-01'), to: dayFromISO('2026-07-31') });
    expect(outside).toBe(1); // 15 Aug is after the forecast window given
    const days = overrides.filter((o) => o.date);
    expect(days.map((o) => [o.date, o.amount])).toEqual([['2026-05-07', 3.3e6], ['2026-06-04', 3.3e6], ['2026-07-14', 760000]]);
    expect(days.every((o) => o.row === 'custom:Finance grants' && o.source === 'Finance grants')).toBe(true);
    const zeroed = overrides.filter((o) => !o.date);
    expect(zeroed).toHaveLength(5); // 'pattern' in all 3 months covered; HB only in the 2 months the file has HB figures
    expect(zeroed.every((o) => o.amount === 0 && o.source === 'Finance grants')).toBe(true);
  });

  it('reads tab-separated text pasted from Excel and US-style dates', () => {
    const t = readTableText('Date\tAmount\n05/31/2026\t1,000\n06/30/2026\t2,000');
    const c = detectColumns(t)!;
    expect(c.category).toBeNull();
    expect(guessDateOrder(t.slice(1).map((r) => r[c.date]))).toBe('MDY');
  });
});

describe('build-it-yourself dates', async () => {
  const { regularDates } = await import('../src/ui/forecast/LineWizard');
  const { isoFromDay } = await import('../src/lib/dates');
  it('monthly on the 15th, off weekends (receipts later, payments earlier), until a date', () => {
    const r = regularDates({ cadence: 'monthly', first: dayFromISO('2026-04-15'), until: dayFromISO('2026-08-31'), lastWorkingDay: false, inflow: true }).map(isoFromDay);
    expect(r).toEqual(['2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15', '2026-08-17']); // 15 Aug 2026 is a Saturday
    const p = regularDates({ cadence: 'monthly', first: dayFromISO('2026-08-15'), until: dayFromISO('2026-08-31'), lastWorkingDay: false, inflow: false }).map(isoFromDay);
    expect(p).toEqual(['2026-08-14']);
  });
  it('quarterly on the last working day, and weekly', () => {
    expect(regularDates({ cadence: 'quarterly', first: dayFromISO('2026-04-01'), until: dayFromISO('2027-03-31'), lastWorkingDay: true, inflow: false }).map(isoFromDay))
      .toEqual(['2026-04-30', '2026-07-31', '2026-10-30', '2027-01-29']);
    expect(regularDates({ cadence: 'weekly', first: dayFromISO('2026-12-18'), until: dayFromISO('2027-01-08'), lastWorkingDay: false, inflow: false }).map(isoFromDay))
      .toEqual(['2026-12-18', '2026-12-24', '2026-12-31', '2027-01-08']); // Christmas Day and New Year's Day move a day earlier
  });
});

describe('which of our rows a schedule replaces', () => {
  const grants = [{ key: 'series:DWP HB SUBSIDY', label: 'DWP HB SUBSIDY' }, { key: 'series:MHCLG REVENUE SUPPORT GRANT', label: 'MHCLG REVENUE SUPPORT GRANT' }, { key: 'series:DHSC SOCIAL CARE GRANT', label: 'DHSC SOCIAL CARE GRANT' }, { key: 'pattern', label: 'Everything else' }];
  it('ticks only the rows the file names', () => {
    expect(suggestReplacedRows(['Housing Benefit subsidy'], grants)).toEqual(['series:DWP HB SUBSIDY']);
    expect(suggestReplacedRows(['Revenue Support Grant 2026/27'], grants)).toEqual(['series:MHCLG REVENUE SUPPORT GRANT']);
    // a description naming only the paying department (or a month) isn't a match
    expect(suggestReplacedRows(['New Homes Bonus', 'MHCLG', 'DWP HB May'], grants)).toEqual(['series:DWP HB SUBSIDY']);
  });
  it('asks when it can’t tell, unless the line is a single pattern', () => {
    expect(suggestReplacedRows(['New Homes Bonus'], grants)).toEqual([]);
    expect(suggestReplacedRows(['Schools'], [{ key: 'series:ESFA DSG', label: 'ESFA DSG' }, { key: 'pattern', label: 'Everything else' }])).toEqual(['series:ESFA DSG', 'pattern']);
    expect(suggestReplacedRows(['DSG'], [{ key: 'series:ESFA DSG', label: 'ESFA DSG' }, { key: 'pattern', label: 'Everything else' }])).toEqual(['series:ESFA DSG']);
  });
});
