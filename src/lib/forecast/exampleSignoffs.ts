// The example council's signed-off forecasts: two made from its own history as it stood a year and
// six months before its data ends, so "Forecast vs actual" has something real to show at once.
import type { Category } from '../categories';
import type { Scenario } from '../model';
import { runForecast } from './engine';
import { signForecast, knownItemsOf, type SignedForecast } from './signoff';
import { basisFromHistory, historyBefore, historySpan, type CashHistory } from '../history/cashHistory';
import { positions } from '../analysis/history';
import { addMonths, dayFromYMD, isoFromDay, ymdFromDay } from '../dates';

export function exampleSignOffs(h: CashHistory, categories: Category[], buffer: number): SignedForecast[] {
  const span = historySpan(h);
  if (!span) return [];
  const catIds = categories.map((c) => c.id);
  const full = basisFromHistory(h, catIds);
  if (!full) return [];
  // counted back from the start of the month after the history ends, so the dates don't move as
  // the last few days' statements are added
  const { y: ey, m: em } = ymdFromDay(span.to);
  const anchor = addMonths(dayFromYMD(ey, em, 1), 1);
  const firstOf = (months: number) => addMonths(anchor, -months);
  const plans = [
    { cutoff: firstOf(12), name: 'Budget forecast', note: 'Agreed with the section 151 officer at budget setting. Includes the depot sale, agreed in March.', withSale: true },
    { cutoff: firstOf(6), name: 'Mid-year review', note: 'Refreshed for the mid-year treasury report.', withSale: false },
  ];
  const out: SignedForecast[] = [];
  for (const p of plans) {
    const basis = basisFromHistory(historyBefore(h, p.cutoff), catIds);
    if (!basis || p.cutoff - span.from < 365) continue;
    // a known item the treasury team would have had: the year's largest capital receipt
    const oneOffs: Scenario['oneOffs'] = [];
    const cr = full.agg.catIds.indexOf('capital_receipts');
    if (p.withSale && cr >= 0) {
      let best = 0, bestDay = 0;
      for (let d = p.cutoff; d < Math.min(addMonths(p.cutoff, 12), span.to + 1); d++) {
        const v = full.agg.opOneOff[cr * full.agg.D + d - full.agg.startDay];
        if (v > best) { best = v; bestDay = d; }
      }
      if (best >= 1e6) oneOffs.push({ id: 'oo_example_depot', date: isoFromDay(bestDay), amount: Math.round(best / 1e5) * 1e5, categoryId: 'capital_receipts', description: 'Sale of the old depot', confidence: 'firm' });
    }
    // the agreed pay award, not the last few years' higher ones: what a treasury team would set
    const assumptions: Scenario['assumptions'] = ['salaries', 'hmrc_paye', 'pensions'].filter((id) => catIds.includes(id))
      .map((id) => ({ id: `as_example_${id}`, kind: 'growth' as const, categoryId: id, pct: 3, mode: 'annual_step' as const, note: 'Agreed pay award' }));
    const sc: Scenario = {
      id: `fc_example_${isoFromDay(p.cutoff)}`, name: p.name, updatedAt: isoFromDay(p.cutoff),
      settings: { start: isoFromDay(p.cutoff), end: isoFromDay(addMonths(p.cutoff, 24) - 1), granularity: 'monthly', openingPosition: null, lookbackYears: 3, recencyWeight: 0.7, methodByCategory: {}, includePossible: true, bandZ: 1.645 },
      assumptions, oneOffs, pastedSchedules: [], treasurySchedule: [],
    };
    const bank = positions(basis.agg).actual;
    const fc = runForecast({ basis, categories, settings: sc.settings, assumptions, oneOffs, pastedSchedules: [], treasurySchedule: [], fyStartMonth: 4, liquidityBuffer: buffer, defaultOpening: bank[bank.length - 1] });
    out.push(signForecast(fc, sc, {
      id: `so_example_${isoFromDay(p.cutoff)}`, signedAt: `${isoFromDay(p.cutoff + 1)}T10:30:00.000Z`, signedBy: 'Treasury team (example)',
      note: p.note, knownItems: knownItemsOf(sc, categories),
    }));
  }
  return out;
}
