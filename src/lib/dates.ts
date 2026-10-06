// Integer "day numbers" (days since 1970-01-01, UTC) are used everywhere for speed:
// they fit in Int32Array, compare cheaply and avoid time-zone drift.

export type Day = number;

const MS_PER_DAY = 86_400_000;

export function dayFromYMD(y: number, m: number, d: number): Day {
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function ymdFromDay(day: Day): { y: number; m: number; d: number } {
  const dt = new Date(day * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(day: Day): number {
  return (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export function isWeekend(day: Day): boolean {
  const w = weekday(day);
  return w === 0 || w === 6;
}

export function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2100) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isoFromDay(day: Day): string {
  const { y, m, d } = ymdFromDay(day);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dayFromISO(iso: string): Day {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return dayFromYMD(y, m, d);
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = MONTHS_SHORT;

export function fmtDay(day: Day): string {
  const { y, m, d } = ymdFromDay(day);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

export function fmtMonth(monthIndex: number): string {
  const { y, m } = monthFromIndex(monthIndex);
  return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`;
}

/** Month index: y*12 + (m-1). Cheap bucket key. */
export function monthIndex(day: Day): number {
  const { y, m } = ymdFromDay(day);
  return y * 12 + (m - 1);
}

export function monthFromIndex(mi: number): { y: number; m: number } {
  return { y: Math.floor(mi / 12), m: (mi % 12) + 1 };
}

export function firstDayOfMonthIndex(mi: number): Day {
  const { y, m } = monthFromIndex(mi);
  return dayFromYMD(y, m, 1);
}

export function addMonths(day: Day, n: number): Day {
  const { y, m, d } = ymdFromDay(day);
  const mi = y * 12 + (m - 1) + n;
  const ny = Math.floor(mi / 12);
  const nm = (mi % 12) + 1;
  return dayFromYMD(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// ---------- Financial years (UK local authority: April–March by default) ----------

/** FY label year = the calendar year in which the FY starts. FY 2024 = 2024/25. */
export function fyOf(day: Day, fyStartMonth = 4): number {
  const { y, m } = ymdFromDay(day);
  return m >= fyStartMonth ? y : y - 1;
}

export function fyLabel(fy: number, fyStartMonth = 4): string {
  if (fyStartMonth === 1) return String(fy);
  return `${fy}/${String((fy + 1) % 100).padStart(2, '0')}`;
}

export function fyStart(fy: number, fyStartMonth = 4): Day {
  return dayFromYMD(fy, fyStartMonth, 1);
}

/** Position of month within the FY: 0 = first month (April). */
export function fyMonthPos(m: number, fyStartMonth = 4): number {
  return (m - fyStartMonth + 12) % 12;
}

// ---------- UK (England & Wales) bank holidays ----------

function easterSunday(y: number): Day {
  // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayFromYMD(y, month, day);
}

function firstMonday(y: number, m: number): Day {
  let d = dayFromYMD(y, m, 1);
  while (weekday(d) !== 1) d++;
  return d;
}

function lastMonday(y: number, m: number): Day {
  let d = dayFromYMD(y, m, daysInMonth(y, m));
  while (weekday(d) !== 1) d--;
  return d;
}

function bankHolidaysForYear(y: number): Day[] {
  const out: Day[] = [];
  // New Year's Day (substitute to Monday)
  let ny = dayFromYMD(y, 1, 1);
  while (isWeekend(ny)) ny++;
  out.push(ny);
  const easter = easterSunday(y);
  out.push(easter - 2, easter + 1);
  // Early May
  if (y === 2020) out.push(dayFromYMD(2020, 5, 8));
  else out.push(firstMonday(y, 5));
  // Spring bank holiday
  if (y === 2022) out.push(dayFromYMD(2022, 6, 2), dayFromYMD(2022, 6, 3));
  else if (y === 2012) out.push(dayFromYMD(2012, 6, 4), dayFromYMD(2012, 6, 5));
  else out.push(lastMonday(y, 5));
  out.push(lastMonday(y, 8));
  // Christmas & Boxing Day with substitutes
  const xmas = dayFromYMD(y, 12, 25);
  const box = xmas + 1;
  const wx = weekday(xmas);
  if (wx === 6) out.push(xmas + 2, xmas + 3); // Sat → Mon, Tue
  else if (wx === 0) out.push(xmas + 1, xmas + 2); // Sun → Mon(Boxing), Tue
  else if (wx === 5) out.push(xmas, xmas + 3); // Fri → Boxing on Mon
  else out.push(xmas, box);
  // One-offs
  if (y === 2022) out.push(dayFromYMD(2022, 9, 19)); // State funeral
  if (y === 2023) out.push(dayFromYMD(2023, 5, 8)); // Coronation
  return out;
}

const BH = new Set<Day>();
for (let y = 2010; y <= 2040; y++) for (const d of bankHolidaysForYear(y)) BH.add(d);

export function isBankHoliday(day: Day): boolean {
  return BH.has(day);
}

export function isBusinessDay(day: Day): boolean {
  return !isWeekend(day) && !BH.has(day);
}

export function prevBusinessDay(day: Day): Day {
  while (!isBusinessDay(day)) day--;
  return day;
}

export function nextBusinessDay(day: Day): Day {
  while (!isBusinessDay(day)) day++;
  return day;
}

export type RollRule = 'previous' | 'next' | 'none';

export function roll(day: Day, rule: RollRule): Day {
  if (rule === 'none') return day;
  return rule === 'previous' ? prevBusinessDay(day) : nextBusinessDay(day);
}

export function lastWorkingDayOfMonth(y: number, m: number): Day {
  return prevBusinessDay(dayFromYMD(y, m, daysInMonth(y, m)));
}

export function bankHolidayList(from: Day, to: Day): Day[] {
  return [...BH].filter((d) => d >= from && d <= to).sort((a, b) => a - b);
}
