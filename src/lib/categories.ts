export type CategoryGroup =
  | 'receipts_operational'
  | 'payments_operational'
  | 'treasury'
  | 'internal';

export type ForecastMethod = 'seasonal' | 'series' | 'flat' | 'manual' | 'exclude';

export interface Category {
  id: string;
  name: string;
  group: CategoryGroup;
  colour: string;
  forecastMethod: ForecastMethod;
  /** Optional free-text description shown in tooltips. */
  description?: string;
}

export const GROUP_LABELS: Record<CategoryGroup, string> = {
  receipts_operational: 'Receipts – operational',
  payments_operational: 'Payments – operational',
  treasury: 'Treasury / deal',
  internal: 'Internal / excluded',
};

export const UNCATEGORISED = 'uncategorised';

/**
 * Default category set. Colours are hand-picked so receipts sit in the blue/green
 * family, payments in warm tones, treasury in slate/navy — consistent across every chart.
 */
export const DEFAULT_CATEGORIES: Category[] = [
  // Receipts – operational
  { id: 'council_tax', name: 'Council tax', group: 'receipts_operational', colour: '#1f6fb2', forecastMethod: 'seasonal' },
  { id: 'business_rates', name: 'Business rates (NNDR)', group: 'receipts_operational', colour: '#2caffe', forecastMethod: 'seasonal' },
  { id: 'grants_general', name: 'Government grants', group: 'receipts_operational', colour: '#13a89e', forecastMethod: 'series' },
  { id: 'dsg', name: 'Dedicated Schools Grant', group: 'receipts_operational', colour: '#2dd4a8', forecastMethod: 'series' },
  { id: 'fees_charges', name: 'Fees, charges & parking', group: 'receipts_operational', colour: '#5cc8ff', forecastMethod: 'seasonal' },
  { id: 'rents', name: 'Rents', group: 'receipts_operational', colour: '#6b8abc', forecastMethod: 'seasonal' },
  { id: 'vat_reclaim', name: 'VAT reclaims', group: 'receipts_operational', colour: '#3a7d44', forecastMethod: 'series' },
  { id: 'capital_receipts', name: 'Capital receipts', group: 'receipts_operational', colour: '#7fb800', forecastMethod: 'flat' },
  { id: 'other_receipts', name: 'Other receipts', group: 'receipts_operational', colour: '#91c7c1', forecastMethod: 'flat' },
  // Payments – operational
  { id: 'salaries', name: 'Salaries (net pay)', group: 'payments_operational', colour: '#fd7e14', forecastMethod: 'series' },
  { id: 'hmrc_paye', name: 'HMRC PAYE & NI', group: 'payments_operational', colour: '#e06b00', forecastMethod: 'series' },
  { id: 'pensions', name: 'Pension contributions', group: 'payments_operational', colour: '#feb56a', forecastMethod: 'series' },
  { id: 'precepts', name: 'Precept payments', group: 'payments_operational', colour: '#b04632', forecastMethod: 'series' },
  { id: 'nndr_retention', name: 'Business rates retention', group: 'payments_operational', colour: '#d568fb', forecastMethod: 'series' },
  { id: 'suppliers', name: 'Supplier payments', group: 'payments_operational', colour: '#c0392b', forecastMethod: 'seasonal' },
  { id: 'housing_benefit', name: 'Housing benefit & welfare', group: 'payments_operational', colour: '#8e44ad', forecastMethod: 'seasonal' },
  { id: 'schools', name: 'Schools funding', group: 'payments_operational', colour: '#e8a33d', forecastMethod: 'seasonal' },
  { id: 'capital_spend', name: 'Capital expenditure', group: 'payments_operational', colour: '#7a4b2a', forecastMethod: 'flat' },
  { id: 'other_payments', name: 'Other payments & recharges', group: 'payments_operational', colour: '#d4826a', forecastMethod: 'flat' },
  // Treasury / deal — excluded from the forecast model
  { id: 'pwlb', name: 'PWLB loans', group: 'treasury', colour: '#0a2540', forecastMethod: 'exclude' },
  { id: 'lobo', name: 'LOBO loans', group: 'treasury', colour: '#143659', forecastMethod: 'exclude' },
  { id: 'la_loans', name: 'Local authority loans', group: 'treasury', colour: '#1a4775', forecastMethod: 'exclude' },
  { id: 'other_borrowing', name: 'Other borrowing', group: 'treasury', colour: '#2e4a6b', forecastMethod: 'exclude' },
  { id: 'mmf', name: 'Money market funds', group: 'treasury', colour: '#3d5a80', forecastMethod: 'exclude' },
  { id: 'dmadf', name: 'DMADF deposits', group: 'treasury', colour: '#5a6b7b', forecastMethod: 'exclude' },
  { id: 'bank_deposits', name: 'Bank & building society deposits', group: 'treasury', colour: '#7d8fa3', forecastMethod: 'exclude' },
  { id: 'treasury_interest', name: 'Treasury interest received', group: 'treasury', colour: '#9aa9b9', forecastMethod: 'exclude' },
  // Internal
  { id: 'internal_transfer', name: 'Internal transfers', group: 'internal', colour: '#adb5bd', forecastMethod: 'exclude' },
];

export const UNCATEGORISED_COLOUR = '#ced4da';

export function isTreasury(c: Category | undefined): boolean {
  return !!c && c.group === 'treasury';
}

export function isOperational(c: Category | undefined): boolean {
  return !!c && (c.group === 'receipts_operational' || c.group === 'payments_operational');
}
