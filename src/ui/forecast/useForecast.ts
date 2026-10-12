import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { runForecast, ForecastResult, ForecastRequest } from '../../lib/forecast/engine';
import { positions } from '../../lib/analysis/history';
import type { Scenario } from '../../lib/model';
import type { ForecastBasis } from '../../lib/analysis/aggregates';
import type { Category } from '../../lib/categories';
import type { RegisterInfo } from '../../worker/types';
import { buildStrategy, Strategy, StrategyRegister } from '../../lib/forecast/strategy';
import { rollForward } from '../../lib/forecast/signoff';

export interface ForecastBundle {
  fc: ForecastResult;
  req: ForecastRequest;
  bankEnd: number;
  operationalEnd: number;
  /** history of the operational position, rebased so it ends at the forecast opening */
  hist: { startDay: number; values: Float64Array };
  /** options to discuss, from the forecast and (when loaded) the deal register */
  strategy: Strategy;
}

export function strategyRegister(r: RegisterInfo | null): StrategyRegister | null {
  if (!r) return null;
  return {
    repayments: r.events.filter((e) => e.kind === 'loan_repayment'),
    loboCalls: r.loboCalls, liquid: r.liquid.total, debt: r.stats.debt,
  };
}

export function computeForecast(basis: ForecastBasis, sc: Scenario, categories: Category[], buffer: number, fyStartMonth: number, register: RegisterInfo | null = null): ForecastBundle {
  const pos = positions(basis.agg);
  const bankEnd = pos.actual[pos.actual.length - 1];
  const operationalEnd = pos.operational[pos.operational.length - 1];
  const mode = sc.settings.openingMode ?? 'bank';
  const defaultOpening = mode === 'operational' ? operationalEnd : bankEnd;
  const req: ForecastRequest = {
    basis, categories, settings: { ...rollForward(sc.settings, basis.dataEnd), openingPosition: mode === 'manual' ? sc.settings.openingPosition ?? bankEnd : null },
    assumptions: sc.assumptions, oneOffs: sc.oneOffs, pastedSchedules: sc.pastedSchedules, treasurySchedule: sc.treasurySchedule,
    fyStartMonth, liquidityBuffer: buffer, defaultOpening,
    register: register ? { liquid: register.liquid.total, events: register.events } : null,
    overrides: sc.overrides ?? [], arrivals: sc.arrivals ?? [],
  };
  const fc = runForecast(req);
  const shift = fc.opening - operationalEnd;
  const values = Float64Array.from(pos.operational, (v) => v + shift);
  return { fc, req, bankEnd, operationalEnd, hist: { startDay: basis.agg.startDay, values }, strategy: buildStrategy(fc, strategyRegister(register)) };
}

export function useForecast(sc: Scenario | undefined): ForecastBundle | null {
  const basis = useStore((s) => s.basis);
  const categories = useStore((s) => s.team.categories);
  const buffer = useStore((s) => s.team.settings.liquidityBuffer);
  const fyStart = useStore((s) => +s.team.settings.financialYearStart.split('-')[0] || 4);
  const register = useStore((s) => s.register);
  return useMemo(() => (basis && sc ? computeForecast(basis, sc, categories, buffer, fyStart, register) : null), [basis, sc, categories, buffer, fyStart, register]);
}
