import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { runForecast, ForecastResult, ForecastRequest } from '../../lib/forecast/engine';
import { positions } from '../../lib/analysis/history';
import type { Scenario } from '../../lib/model';
import type { ForecastBasis } from '../../lib/analysis/aggregates';
import type { Category } from '../../lib/categories';

export interface ForecastBundle {
  fc: ForecastResult;
  req: ForecastRequest;
  bankEnd: number;
  operationalEnd: number;
  /** history of the operational position, rebased so it ends at the forecast opening */
  hist: { startDay: number; values: Float64Array };
}

export function computeForecast(basis: ForecastBasis, sc: Scenario, categories: Category[], buffer: number, fyStartMonth: number): ForecastBundle {
  const pos = positions(basis.agg);
  const bankEnd = pos.actual[pos.actual.length - 1];
  const operationalEnd = pos.operational[pos.operational.length - 1];
  const mode = sc.settings.openingMode ?? 'bank';
  const defaultOpening = mode === 'operational' ? operationalEnd : bankEnd;
  const req: ForecastRequest = {
    basis, categories, settings: { ...sc.settings, openingPosition: mode === 'manual' ? sc.settings.openingPosition ?? bankEnd : null },
    assumptions: sc.assumptions, oneOffs: sc.oneOffs, pastedSchedules: sc.pastedSchedules, treasurySchedule: sc.treasurySchedule,
    fyStartMonth, liquidityBuffer: buffer, defaultOpening,
  };
  const fc = runForecast(req);
  const shift = fc.opening - operationalEnd;
  const values = Float64Array.from(pos.operational, (v) => v + shift);
  return { fc, req, bankEnd, operationalEnd, hist: { startDay: basis.agg.startDay, values } };
}

export function useForecast(sc: Scenario | undefined): ForecastBundle | null {
  const basis = useStore((s) => s.basis);
  const categories = useStore((s) => s.team.categories);
  const buffer = useStore((s) => s.team.settings.liquidityBuffer);
  const fyStart = useStore((s) => +s.team.settings.financialYearStart.split('-')[0] || 4);
  return useMemo(() => (basis && sc ? computeForecast(basis, sc, categories, buffer, fyStart) : null), [basis, sc, categories, buffer, fyStart]);
}
