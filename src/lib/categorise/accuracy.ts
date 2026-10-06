// Developer accuracy check against the generator's hidden truth file.
import type { Dataset } from '../ingest/ingest';
import type { TruthFile } from '../../generator/render';
import { CatResult, DEAL_NO } from './engine';

export interface AccuracyReport {
  matchedRows: number;
  unmatchedRows: number;
  truthRows: number;
  rejectedTruthRows: number;
  rejectedBadDates: number;
  wrongDates: number;
  overall: { rows: number; correct: number; pctRows: number; valueCorrect: number; value: number; pctValue: number };
  perCategory: { id: string; truthRows: number; correct: number; pct: number; truthValue: number; valueCorrect: number; pctValue: number; predictedRows: number; precision: number }[];
  confusion: { truth: string[]; predicted: string[]; counts: number[][] };
  deal: {
    truthDealValue: number;
    correctlyExcludedValue: number;
    pctExcluded: number;
    leakedValue: number;
    leakedRows: number;
    wronglyExcludedValue: number;
    wronglyExcludedRows: number;
    topLeaks: { narrative: string; amount: number; day: number; truthCat: string; predicted: string }[];
  };
  recurring: { rows: number; agree: number; pct: number };
  uncategorisedValue: number;
}

export function computeAccuracy(ds: Dataset, res: CatResult, truth: TruthFile): AccuracyReport {
  // Index truth by file name → line → position
  const fileIdx = new Map<string, number>();
  truth.files.forEach((f, i) => fileIdx.set(f.name, i));
  const lineMaps = truth.files.map((f) => {
    const m = new Map<number, number>();
    f.line.forEach((l, k) => m.set(l, k));
    return m;
  });
  const T = truth.categories;
  const P = res.catIds;
  const predLabels = [...P, 'uncategorised'];
  const truthLabelIdx = new Map(T.map((c, i) => [c, i]));
  const counts = T.map(() => new Array(predLabels.length).fill(0));
  const per = T.map((id) => ({ id, truthRows: 0, correct: 0, pct: 0, truthValue: 0, valueCorrect: 0, pctValue: 0, predictedRows: 0, precision: 0 }));
  let matched = 0, unmatched = 0, correct = 0, value = 0, valueCorrect = 0, wrongDates = 0;
  let truthDealValue = 0, excluded = 0, leaked = 0, leakedRows = 0, wrongEx = 0, wrongExRows = 0, recRows = 0, recAgree = 0, uncValue = 0;
  const leaks: AccuracyReport['deal']['topLeaks'] = [];
  const internalPred = P.indexOf('internal_transfer');
  const seen = truth.files.map((f) => new Uint8Array(f.line.length));
  for (let i = 0; i < ds.n; i++) {
    const fname = ds.files[ds.file[i]]?.name;
    const fi = fileIdx.get(fname);
    if (fi === undefined) { unmatched++; continue; }
    const k = lineMaps[fi].get(ds.line[i]);
    if (k === undefined) { unmatched++; continue; }
    seen[fi][k] = 1;
    matched++;
    const tf = truth.files[fi];
    const tc = tf.cat[k];
    const tName = T[tc];
    const pc = res.cat[i];
    const pName = pc >= 0 ? P[pc] : 'uncategorised';
    if (tf.day[k] !== ds.day[i]) wrongDates++;
    const a = Math.abs(ds.amount[i]);
    if (pc < 0) uncValue += a;
    const tIdx = truthLabelIdx.get(tName)!;
    counts[tIdx][pc >= 0 ? pc : predLabels.length - 1]++;
    per[tIdx].truthRows++;
    per[tIdx].truthValue += a;
    value += a;
    if (tName === pName) { correct++; valueCorrect += a; per[tIdx].correct++; per[tIdx].valueCorrect += a; }
    const pi = truthLabelIdx.get(pName);
    if (pi !== undefined) per[pi].predictedRows++;
    // deal exclusion
    const tDeal = tf.deal[k] === '1';
    const pDeal = res.deal[i] !== DEAL_NO;
    const pInternal = pc === internalPred;
    if (tDeal) {
      truthDealValue += a;
      if (pDeal) excluded += a;
      else if (!pInternal) {
        leaked += a; leakedRows++;
        if (leaks.length < 200) leaks.push({ narrative: ds.narratives[ds.narr[i]], amount: ds.amount[i], day: ds.day[i], truthCat: tName, predicted: pName });
      }
    } else if (pDeal && tName !== 'internal_transfer') { wrongEx += a; wrongExRows++; }
    if (!tDeal && tName !== 'internal_transfer' && pc >= 0) {
      recRows++;
      const tRec = tf.recurring[k] === '1';
      if (tRec === (res.oneOff[i] === 0)) recAgree++;
    }
  }
  let truthRows = 0, rejectedTruthRows = 0, rejectedBad = 0;
  truth.files.forEach((f, fi) => {
    truthRows += f.line.length;
    for (let k = 0; k < f.line.length; k++) if (!seen[fi][k]) {
      // rows the app dropped: rejected (bad dates) or removed as overlap duplicates
      if (f.dup[k] !== '1') { rejectedTruthRows++; if (f.badDate[k] === '1') rejectedBad++; }
    }
  });
  for (const p of per) {
    p.pct = p.truthRows ? p.correct / p.truthRows : 0;
    p.pctValue = p.truthValue ? p.valueCorrect / p.truthValue : 0;
    p.precision = p.predictedRows ? p.correct / p.predictedRows : 0;
  }
  leaks.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
  return {
    matchedRows: matched, unmatchedRows: unmatched, truthRows, rejectedTruthRows, rejectedBadDates: rejectedBad, wrongDates,
    overall: { rows: matched, correct, pctRows: matched ? correct / matched : 0, valueCorrect, value, pctValue: value ? valueCorrect / value : 0 },
    perCategory: per,
    confusion: { truth: T, predicted: predLabels, counts },
    deal: {
      truthDealValue, correctlyExcludedValue: excluded, pctExcluded: truthDealValue ? excluded / truthDealValue : 1,
      leakedValue: leaked, leakedRows, wronglyExcludedValue: wrongEx, wronglyExcludedRows: wrongExRows, topLeaks: leaks.slice(0, 25),
    },
    recurring: { rows: recRows, agree: recAgree, pct: recRows ? recAgree / recRows : 0 },
    uncategorisedValue: uncValue,
  };
}
