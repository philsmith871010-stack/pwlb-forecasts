// Built-in, LA-flavoured starter rules. Patterns run against the normalised *signature*
// (upper case, punctuation stripped, reference numbers removed). Order matters: first match wins,
// so specific treasury and statutory patterns come before generic supplier patterns.

import type { Rule } from '../model';

type R = [pattern: string, categoryId: string, opts?: Partial<Rule>];

const S: R[] = [
  // ---- Internal transfers (pair-matching confirms; this only catches the narrative) ----
  ['\\bSWEEP (TO|FROM)\\b|\\bTFR (TO|FROM)\\b|FUNDING PAYROLL|PAYROLL FUNDING|SCHOOLS AC FUNDING|INTER ?ACCOUNT|OWN ACCOUNT TRANSFER', 'internal_transfer', { confidence: 'medium' }],

  // ---- Treasury: interest first (it shares words with principal) ----
  ['(MMF|LIQ|LIQUIDITY|RESERVES).*(DIVIDEND|\\bINT\\b|INTEREST)|\\bDIVIDEND\\b', 'treasury_interest', { dealFlag: 'deal' }],
  ['DMADF INT|DMO INTEREST|^INT FD/|\\bFD INT\\b|DEPOSIT INTEREST|INTEREST ON DEPOSIT', 'treasury_interest', { dealFlag: 'deal' }],
  ['\\bPWLB\\b|P W L B|\\bP\\.?W\\.?L\\.?B\\b|PUBLIC WORKS LOAN|DMO PWLB|UK DEBT MGMT', 'pwlb', { dealFlag: 'deal' }],
  ['\\bLOBO\\b|KOMMUNALBANK', 'lobo', { dealFlag: 'deal' }],
  ['DMADF|DEBT MANAGEMENT OFFICE|\\bDMO\\b', 'dmadf', { dealFlag: 'deal' }],
  ['\\bMMF\\b|MONEY MARKET|LIQUIDITY FUND|LIQ FD|PS MMF|CASH RESERVES|GOVT LIQUIDITY|\\bLIQ\\b|\\bREDM\\b|\\bSUBSCRIPTION\\b|\\bREDEMPTION\\b', 'mmf', { dealFlag: 'deal' }],
  ['FIXED DEPOSIT|TERM DEPOSIT|(^|\\s)FD/|\\bFD (MATURITY|PLACEMENT|DEP)\\b|CALL ACCOUNT|NOTICE ACCOUNT', 'bank_deposits', { dealFlag: 'deal' }],
  ['(^|\\s)LA/#|\\bLA LOAN\\b|INTER ?AUTHORITY LOAN|(COUNCIL|\\bBC\\b|\\bMBC\\b|\\bCC\\b|\\bDC\\b).*\\bLOAN\\b|\\bLOAN (REPAYMENT|INT|INTEREST)\\b|CHAPS INT LA/', 'la_loans', { dealFlag: 'deal' }],
  ['\\bLN INT\\b', 'lobo', { dealFlag: 'deal', confidence: 'medium' }],

  // ---- Statutory / central government ----
  ['PRECEPT|POLICE (AND|&) CRIME|CRIME COMM|\\bPCC\\b|FIRE (AND|&) RESCUE|FIRE AUTH', 'precepts', { direction: 'out' }],
  ['CENTRAL SHARE|\\bBRR\\b|TARIFF|TOP ?UP|RATES RETENTION|POOL DISTRIBUTION|BUSINESS RATES POOL', 'nndr_retention'],
  ['\\bNNDR\\b|BUSINESS RATES|\\bBUS RATES\\b|\\bNDR\\b', 'business_rates', { direction: 'in' }],
  ['\\bCTAX\\b|COUNCIL TAX|\\bCT PYMT\\b|\\bCT PAYMENT\\b', 'council_tax'],
  ['PAY AWARD ARREARS|BACKDATED PAY|\\bARREARS\\b', 'salaries', { classification: 'one_off' }],
  ['SALAR|PAYROLL|NET PAY|\\bWAGES\\b', 'salaries', { direction: 'out' }],
  ['HMRC.*(PAYE|NIC|\\bNI\\b|CUMBERNAULD)|\\bPAYE\\b|HMRC CUMBERNAULD', 'hmrc_paye'],
  ['\\bVAT\\b|VAT#|VAT126', 'vat_reclaim', { direction: 'in' }],
  ['PENSION|\\bLGPS\\b|SUPERANNUATION', 'pensions'],
  ['\\bDSG\\b|DEDICATED SCHOOLS|RECOUPMENT', 'dsg'],
  ['EXCEPTIONAL FINANCIAL SUPPORT|EXCEPTIONAL SUPPORT', 'grants_general', { classification: 'one_off' }],
  ['\\bRSG\\b|REVENUE SUPPORT|SECTION 31|\\bS# GRANT|SOCIAL CARE GRANT|HB SUBSIDY|HOUSEHOLD SUPPORT|ADDITIONAL RELIEF|\\bGRANT\\b|\\bEPR\\b|PACKAGING', 'grants_general', { direction: 'in' }],
  ['^(DLUHC|MHCLG|DHSC|DWP|DFE|ESFA|DEFRA|DFT|HOMES ENGLAND|ARTS COUNCIL)\\b', 'grants_general', { direction: 'in', confidence: 'medium' }],

  // ---- Service areas ----
  ['BUDGET SHARE|PUPIL PREMIUM|TERMLY|\\bSCHOOL\\b|\\bPRIMARY\\b|\\bACADEMY\\b|\\bINFANTS\\b|\\bJUNIOR\\b|NURSERY', 'schools', { direction: 'out' }],
  ['\\bHB\\b|HOUSING BENEFIT|RENT ALLOWANCE|\\bDHP\\b|DISCRETIONARY HOUSING', 'housing_benefit', { direction: 'out' }],
  ['PARKING|\\bPCN\\b|PLANNING FEE|\\bLICEN[CS]E\\b|BUILDING CONTROL|GREEN WASTE|CARD SETTLEMENT|MERCHANT|\\bFEES?\\b', 'fees_charges', { direction: 'in' }],
  ['\\bRENT\\b|STALL RENT|SERVICE CHARGE', 'rents', { direction: 'in' }],
  ['COMPLETION|LAND SALE|SALE OF|CLIENT A ?C|CLIENT ACCOUNT', 'capital_receipts', { direction: 'in', classification: 'one_off' }],
  ['\\bCERT\\b|STAGE PAY|FINAL ACC|\\bRETENTION\\b|VALUATION #', 'capital_spend', { direction: 'out' }],
  ['\\bICB\\b|\\bNHS\\b|\\bBCF\\b|SUNDRY INCOME|INSURANCE CLAIM|\\bS# CONTRIBUTION|COURT COSTS', 'other_receipts', { direction: 'in' }],
  ['\\bLEVY\\b|RECHARGE|\\bREFUND\\b|\\bVCS\\b|CORONER|MEMBERS EXP', 'other_payments', { direction: 'out' }],

  // ---- Generic supplier payments (lower confidence) ----
  ['BACS RETURN|RETURNED PAYMENT', 'suppliers', { confidence: 'medium' }],
  ['^(BACS|FPS|CHAPS) |\\bINV\\b|ASC PROVIDER|\\b(LTD|LIMITED|PLC|LLP|CIC)\\b', 'suppliers', { direction: 'out', confidence: 'medium' }],
];

export const STARTER_RULES: Rule[] = S.map(([pattern, categoryId, opts], i) => ({
  id: `starter_${String(i + 1).padStart(3, '0')}`,
  type: 'regex',
  pattern,
  categoryId,
  dealFlag: 'not_deal',
  confidence: 'high',
  source: 'starter',
  ...opts,
}));

// ---------------------------------------------------------------- counterparty dictionary

/** Treasury counterparties. Real institution names are plain keyword patterns, used only for matching. */
export const TREASURY_COUNTERPARTIES: { pattern: RegExp; categoryId: string; label: string }[] = [
  { pattern: /\b(CCLA|FEDERATED|HERMES|ABERDEEN|ABRDN|INSIGHT|INVESCO|BLACKROCK|LGIM|LEGAL AND GENERAL|MORGAN STANLEY|GOLDMAN|DEUTSCHE|JP ?MORGAN|HSBC GLOBAL|STATE STREET|FIDELITY|NORTHERN TRUST)\b.*\b(FUND|LIQ|MMF|CASH|RESERVES|STERLING|GBP)\b/, categoryId: 'mmf', label: 'Money market fund' },
  { pattern: /\b(BANK|BANCO|BANQUE)\b.*\b(PLC|AG|SA|NV|LTD|LIMITED|INTERNATIONAL)\b|BUILDING SOC|\bBUILDING SOCIETY\b|SAVINGS BANK|\b(BARCLAYS|LLOYDS|NATWEST|SANTANDER|NATIONWIDE|CLOSE BROTHERS|HANDELSBANKEN|STANDARD CHARTERED|COVENTRY BS|SKIPTON|YORKSHIRE BS|LEEDS BS)\b/, categoryId: 'bank_deposits', label: 'Bank / building society' },
  { pattern: /\bDEBT MANAGEMENT\b|\bDMO\b/, categoryId: 'dmadf', label: 'Debt Management Office' },
];

/** Another local authority, by name pattern. */
export const LA_PATTERN = /\b(CITY|BOROUGH|DISTRICT|COUNTY|METROPOLITAN|MET|LONDON BOROUGH|COMBINED) (COUNCIL|BC|CC|DC|MBC|AUTHORITY|AUTH)\b|\b(BC|MBC|CC|DC)\b(?! RECHARGE)|COUNCIL\b/;
