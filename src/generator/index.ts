import { runEngine } from './engine';
import { renderFiles, RenderedFile, TruthFile } from './render';
import { DEFAULT_CATEGORIES } from '../lib/categories';

export type VolumePreset = 'small' | 'large' | 'brutal';

export const VOLUME_PRESETS: Record<VolumePreset, { label: string; volume: number; approxRows: string }> = {
  small: { label: 'Small', volume: 0.5, approxRows: '~20k rows' },
  large: { label: 'Large', volume: 13, approxRows: '~250k rows' },
  brutal: { label: 'Brutal', volume: 44, approxRows: '~750k rows' },
};

export interface GeneratorOptions {
  seed: string;
  startFY: number;
  years: number;
  preset: VolumePreset;
  accounts: number;
  nastiness: number;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  seed: 'northbridge',
  startFY: 2021,
  years: 5,
  preset: 'small',
  accounts: 4,
  nastiness: 1,
};

export interface GeneratedDataset {
  files: { name: string; text: string }[];
  truth: TruthFile;
  /** the example council's deal register at the end of its history (register snapshot form) */
  register: unknown;
  stats: { rows: number; files: number; startISO: string; endISO: string };
}

export function generateDataset(o: GeneratorOptions): GeneratedDataset {
  const { txns, openingBalances, register } = runEngine({
    seed: o.seed,
    startFY: o.startFY,
    years: o.years,
    volume: VOLUME_PRESETS[o.preset].volume,
    accounts: o.accounts,
    nastiness: o.nastiness,
  });
  const catIds = DEFAULT_CATEGORIES.map((c) => c.id);
  const rendered: RenderedFile[] = renderFiles(txns, o.accounts, openingBalances, { nastiness: o.nastiness, seed: o.seed }, catIds);
  const truth: TruthFile = {
    kind: 'cash-flow-insight-truth',
    version: 1,
    seed: o.seed,
    generatedAt: new Date().toISOString(),
    categories: catIds,
    files: rendered.map((f) => f.truth),
  };
  const rows = rendered.reduce((s, f) => s + f.truth.line.length, 0);
  const d0 = txns[0]?.day ?? 0, d1 = txns[txns.length - 1]?.day ?? 0;
  const iso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10);
  return {
    files: rendered.map((f) => ({ name: f.name, text: f.text })),
    truth,
    register,
    stats: { rows, files: rendered.length, startISO: iso(d0), endISO: iso(d1) },
  };
}
