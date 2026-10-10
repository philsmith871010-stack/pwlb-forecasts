# Decisions

Where the spec left a detail open, this is what I chose and why. Most recent last within each section.

## Architecture

- **One engine worker owns the data.** Parsing, categorisation, aggregation and backtests run in a single Web Worker (`src/worker/engine.worker.ts`, Comlink RPC). The main thread only receives summaries, compact daily × category aggregates (~1.3 MB for five years) and pages of up to 200 rows for virtualised tables. Raw rows never leave the worker except in the categorised-transactions CSV the user explicitly saves.
- **The forecast engine runs on the main thread.** It works on the aggregates only and takes 10–30 ms, so a worker round-trip would add latency without benefit. The same pure code runs inside the worker for backtests and in node for tests.
- **Shared code runs in node.** `scripts/bench.ts` runs generate → ingest → categorise → accuracy → forecast → backtest headlessly. That is how the engine was tuned, and it is the quickest way to check a change.
- **Compact storage.** Rows are typed arrays (day number, amount, account, file, line, narrative index). Narratives are de-duplicated into a string table. 775k rows use well under 100 MB in the worker; the main thread stays at ~50 MB.
- **State** lives in zustand. The team file is the only thing persisted, cached in `localStorage` as a convenience (the spec allowed IndexedDB; a ~50 KB JSON fits easily in `localStorage` with less code). Transaction data is never cached.
- **ECharts with the SVG renderer.** It is crisp, exportable as SVG directly and as PNG via a canvas, and fast enough for ~2,500-point series with LTTB sampling.

## Ingest

- **Mapping is detected first, then the files are read.** Step 1 parses straight away with the auto-detected (or bank-profile) mapping, so one click is enough when the layout is known. Step 2 shows the result and lets the user correct it and re-read.
- **Day/month order** is detected per file from unambiguous values (a first number above 12 means UK order); the default is UK. On top of that, each row gets a **sequence check**: if a date jumps more than 20 days from the previous row but the swapped reading is within 7 days, the swapped reading is used and flagged. On generated data this recovers every ambiguous US-style date (`wrong dates: 0`).
- **Debit/credit columns** are read by absolute value (debit = out, credit = in), so a stray minus sign in a debit column cannot flip a payment into a receipt.
- **Fixed-width split narratives** (an 18-character "Narrative 1" continued in "Narrative 2") are detected and joined without a space, so `B` + `UDGET SHARE` becomes `BUDGET SHARE`.
- **Overlapping exports of the same account:** rows of a later file that fall inside an earlier file's date range and match it one-for-one on (date, amount) are dropped and counted. Exact duplicates *within* a file are only flagged: banks really do double-post.
- **Files with no account column** are matched to a known account by narrative overlap (≥ 35% of their three-word narrative stems), or else keep the account label the user types.
- **Opening balance** is derived from balance columns where present. Accounts without one are assumed to open at zero.

## Categorisation

- **Rules match the narrative *signature*:** upper case, punctuation and encoding junk stripped, dates and reference numbers removed. Tokens with four or more digits are dropped, and slash references keep their letters (`FD/23/114` → `FD/#/#`). Rule matching is cached per signature, which is why 775k rows categorise in about 2 s. Rules that need specific digits are not supported; amount and direction conditions are.
- **Order:** user transaction decisions → internal-transfer pairing → team rules → starter rules → treasury counterparty dictionary and "another local authority" detector → recurrence → heuristics → uncategorised. The rule that decided each line is recorded and shown on hover.
- **Starter rules are generic.** They target real LA vocabulary: PWLB/DMO/DMADF, MMF terms, "fixed deposit", `LA/` references, council-name patterns, statutory flows. I deliberately removed patterns that only fitted my invented fund names. The demo's "ALBION CASH" fund is therefore *not* recognised out of the box; the sample team file teaches it, which is exactly what a team file is for.
- **Suspected deals are excluded by default.** That covers round sums of £1m or more in multiples of £250k, loan-and-repayment pairs (same amount back, 0–8% more, 7–400 days later) and identical amounts repeating every six or twelve months. This is the prudent choice: a missed deal distorts the borrowing need far more than a deferred decision about a grant. The Review queue shows all of them, and "Operational wrongly excluded" is reported next to "deal value left in the model".
- **Ambiguous council payments** (a council name, no loan words) are treated as recharges if the amount is under £1m or not round, and as suspected LA loans if round and £1m or more. Both are marked for review.
- **Outliers:** rows inside a regular recurring series are compared with that series' typical amount (flag at more than 3× the median, or the median + 8 MAD). Other rows are compared with their category (log-amount z-score above 4, or more than 60% of a typical month's total). The category-only test misfired on categories with several amount bands, such as monthly payroll next to weekly casual pay. Outliers default to **one-off**: kept in history, left out of the profile, and listed in Review.
- **Recurrence cadences:** daily, weekly, fortnightly, **semi-monthly** (twice a month on set dates, e.g. DSG on the 1st and 15th), four-weekly, monthly, quarterly, half-yearly and annual. Semi-monthly was added after backtests showed "fortnightly" projecting 26 payments a year instead of 24 (an 8% overstatement). A strict 14-day cycle is fortnightly; uneven 12–18-day gaps are semi-monthly.
- **Per-transaction decisions** are stored in the team file under a one-way 32-bit hash of (account, date, amount in pence, signature) — never the narrative or amount itself.

## Forecasting

- **Seasonal × trend** builds a profile per calendar month from recurring operational flows over the lookback window (3 years by default). Each year's value is deflated to the data end date by the growth rate, older years get a recency weight (70% per year back by default), and months beyond median ± 3 MAD are clamped. Clamped months are listed in the Category explorer.
- **Weekly-run categories** (supplier BACS on Tuesdays) are profiled per unit of run-day capacity, so a month with five Tuesdays gets five runs. This came out of backtesting.
- **Default growth** is a log-linear trend through *every* rolling 12-month total in the full history, capped at ±20%. Comparing two end points proved too noisy (it gave 8% for suppliers against a true 4%). User growth assumptions replace it and can step each April (the default for new assumptions, matching council tax and pay awards) or apply continuously.
- **Recurring series schedule** projects each *active* series on its own dates, using its recent level × growth. A series is active if seen within 1.6 cadences of the data end. Stable series use their last few payments; volatile ones (CV above 10%) use a 4× longer, growth-adjusted median. Everything in the category that is not an active series is forecast by seasonal profile. Series that stopped (Covid relief, renamed government departments) are therefore not projected, which handles structural breaks without user action.
- **Uncategorised flows are excluded** from the forecast by default, with a clear switch to "flat". On real data they are mostly unknown treasury flows, and including them made backtests worse. The Review queue is the fix.
- **Opening position** defaults to the **bank balance at the end of the data** (all flows, including treasury). The historical operational line is *rebased* so it ends at that opening, so the chart reads continuously from history into the forecast. "Operational position" and "enter a figure" are alternatives.
- **Borrowing requirement** = max(0, buffer − projected low point), where the buffer is the team's liquidity buffer.
- **Uncertainty band:** each category's robust monthly variability (1.4826 × MAD of deflated monthly totals around the profile) is combined assuming independence and accumulated as a random walk over the months, giving cumulative ± 1.645σ (90%). It is simple, explainable and stated on screen. It ignores growth-rate uncertainty and one-offs.
- **Step changes with backdating:** the new level applies from the "paid from" date. Arrears = the % × the modelled flows between "backdated to" and "paid from", paid as a lump on the arrears date.
- **Timing changes** move a category's whole monthly total to the chosen day. That is right for single-run flows like payroll, and stated in the UI.
- **Pasted schedules in "instead of model" mode** replace the model only for the months the schedule covers. My first version replaced the whole horizon, which surprised in testing: a one-year grant schedule zeroed the following year.
- **"Possible" one-offs** are weighted by their probability (default 50%) and can be switched off. "Likely" and "firm" count in full.
- **Results snapshots** (monthly totals, cumulative position, band, low/high, summary text) are written to each scenario automatically, 600 ms after the last change, so a saved forecast can be viewed without the CSVs.

## Backtesting

- **Strictly no look-ahead:** series detection, outlier tests and one-off classification are *re-run* on data before the cut-off (`buildBasisAsOf`). Categories come from the current rule set. That reflects the user's knowledge of what a counterparty *is*, not future cash, so it is not treated as leakage. A test asserts the basis contains nothing on or after the cut-off.
- **Comparisons are like-for-like:** categories the forecast excludes (by default only "uncategorised") are left out of the actuals too and listed as "not modelled".
- **The predictable core** compares the forecast with recurring actuals only. "Include the actual one-offs as if known" adds the real one-off flows to the forecast to isolate model error.
- **Rolling mode** uses up to about 16 start dates, evenly spaced, from 12 months after the data start.

## Team file

- **Merge on save:** the file is re-read before writing. If its hash differs from the one loaded, rules, aliases, bank profiles, categories, forecasts, overrides and change-log entries are unioned by id. Items with the same id but different content are shown as conflicts with a mine/theirs choice (default mine). Hit counts and snapshots are ignored when comparing.
- **Saving** uses the File System Access API (save in place) where available, otherwise a download.
- **The history summary** (category × month operational totals plus a monthly treasury net) is included by default and can be switched off. It is aggregates only.
- Starter rules are code, not team-file content, so improving them reaches every team on upgrade.

## Synthetic data

- **The authority is fictional.** "Northbridge Council" and every company, council, fund and bank are invented. Only the public bodies councils really deal with appear by name (PWLB/DMO, HMRC, DfE/ESFA, DLUHC/MHCLG, DWP, DHSC).
- **The treasury flows come from a simulated cash manager.** It keeps the general account between £0.5m and £3m: surpluses go to MMFs and DMADF or bank deposits, shortfalls are met by MMF redemptions and then LA-to-LA loans, and a PWLB refinancing happens each October. Deal flows are therefore *caused* by the operational flows, as in real life.
- **Narrative styles change once per flow, not row by row,** because that is what real bank and system changes look like. Random per-row style flipping made series undetectable in an unrealistic way.
- **Volume presets:** small (multiplier 0.5, ≈22k rows), large (13, ≈245k) and brutal (44, ≈775k).

## Exports

- **Excel** is SheetJS 0.20.3 from the official SheetJS CDN tarball (the npm `xlsx` package is abandoned and has open advisories). It is loaded on demand so it doesn't weigh down the first page load.
- **The print report** is an in-app page with a print stylesheet (A4, chrome hidden, page breaks before tables). "Save as PDF" uses the browser's print dialog, as the spec allowed for v1.

## Deal register (PWLBtoday)

- **The register reader is copied, not re-written.** `scripts/sync-register.mjs` vendors `register/src/xlsx.js` and `model.js` from the PWLBtoday TMS repo into `src/lib/register/vendor/` (source sha in the header) and the blank template into `public/templates/`. `tests/register.test.ts` checks parity on the shipped template: schedules (maturity, EIP, annuity, LOBO at next call), outstanding balances, liquidity and the liability benchmark identities. Re-run the script when the register changes; the tests say whether anything moved.
- **Session only.** The register is read in the worker and kept for the session. It is not written to the team file, because it is the council's own deal record and the team file is shared.
- **Bottom up and top down are kept separate.** The cash forecast (bottom up, from bank history) answers *when* and *how much* over the next year or two. The liability benchmark (top down, CFR − other balance sheet items + liquidity allowance, from the register's Projections sheet, GF + HRA added) answers *how much long-term borrowing* and *for how long*. The strategy screen compares them; it never blends them.
- **Matching to bank lines comes first.** Past register cash flows (drawdowns, repayments, interest, placements, maturities) are matched to bank lines before any rule: same sign, within 4 days, exact to the penny for principal. Interest may be within 1% (or £1), but an inexact match needs the narrative to agree: the counterparty's name, a treasury counterparty, or "INT"/"interest". A repayment may match a line combining principal and interest. Every match also needs the narrative to look like a deal (the counterparty's name, a known treasury counterparty, a council, or words such as LOAN, DEP, FD, DMADF, MMF, REF, TRF), so a round-sum grant can't be taken for a loan. Call accounts and MMFs named in the register mark every line with that name as treasury. If under 30% of the register's cash flows are found, the card says the register and the bank files may not belong together. On the example: 100% of deal value excluded, £0 leaked, £0 wrongly excluded (without the register: 98.0%, £131m leaked).
- **Interest is estimated, and says so.** The register records rates and dates, not interest payments. Loans pay on a cycle ending at maturity (half-yearly unless Frequency says otherwise) with a front stub, actual/365. Loans of a year or less pay at maturity. LOBOs are assumed called at the next call date. Deposits pay at maturity, and discount instruments through face value. Variable rates are held at the current rate, and MMF/call income is not projected. The register card shows a self-check against bank history (estimated interest payments found, how many within £1, and totals).
- **In the forecast**, with a register loaded, the headline line is everyday cash + money in MMFs and call accounts at the start + every dated register cash flow after the bank data ends (not after the register's as-at date: a register dated later than the bank files would otherwise lose the months in between). Low, breaches, borrowing need and the summary use that line. The "everyday cash only" line is still drawn. Without a register nothing changes.
- **Options to discuss, not advice.** `src/lib/forecast/strategy.ts`:
  - **Shortfall** is the deepest gap below the minimum.
  - **Lasting need** is the largest gap that the best point in the following 12 months still doesn't close. A gap not closed before the forecast ends counts as lasting, and is flagged.
  - **Short term** is the rest.
  - **Benchmark comparison** uses the benchmark for the financial year in which the low point falls.
  - **Maturities** are shaped by the running minimum of later years' room under the benchmark; slivers under 5% are folded into the next shorter tranche.
  - **The term-out ladder** is the running minimum of the lower band above the minimum cash, at 1/3/6/12/24 months.
  - Counterparty limits, rates and the TMSS are not checked, and every screen says so.
- **The example council carries a register** (built by the generator from the same deals that made its bank lines, so the two agree). Its projections size the capital programme from its own operational deficit, so bottom up and top down are of the same order. Two generator fixes came out of this: the first month's schools funding was being dropped, which left the schools account £11m overdrawn; and the cash manager now keeps about £10m in MMFs as a liquidity reserve, borrowing rather than running it down.

## Building the forecast before showing it

- **The forecast is proposed, checked, then shown.** Look ahead opens on *Check each line*. Every income and spending line that makes up at least 1% of gross flows (or £2m) gets a card showing:
  - what history says, in plain English: regular payments with their amount, how often and on what day; or the seasonal pattern (highest and lowest months); or the flat average;
  - past months next to the proposed next 12;
  - three edits: growth each year, bigger or smaller by a %, and "it stops".
- **Every line is opened and confirmed on its own**, smaller ones included (listed after the main lines). There is no bulk "accept as proposed", so every figure in the forecast is one somebody has looked at.
- **Locked until checked.** The result, options and breakdown tabs, the results strip, the saved results snapshot, the report and the Excel export stay locked until every line is checked and the user clicks *See my forecast*.
- **When it is paid, per series.** A timing assumption may name one series (`signature`). The engine then projects that series on the chosen day, leaving the category's other payments alone:
  - monthly, quarterly, half-yearly and annual payments: the last working day or the Nth;
  - weekly, fortnightly and four-weekly payments: a weekday (Monday to Friday), re-anchored on the nearest such weekday to the last payment, so the rhythm is kept. Timing without a signature still moves the whole category, as before.
- **Checks belong to the data they were made on** (`reviewFor` = the data end date). Loading newer bank data asks for the lines to be checked again, because the proposal has changed.
- **Removing a regular payment.** A stop assumption may also name one series (`signature`): that payment is taken out from the date, and the rest of the category stays. It can be restored.
- **The grid, by month or by day.** Each line can be opened as a grid:
  - **Rows:** one per regular payment, "Everything else (usual pattern)", and rows the user adds (`custom:<name>`, e.g. a grant they've been told about).
  - **Read-only rows** (greyed) show money from Known future items, pasted schedules and one-offs, so the grid adds up to the forecast line.
  - **Entry:** type over a cell, or paste a block from Excel (rows × months, from the cell clicked). £, commas, k/m and (brackets) are understood.
  - **Final figures.** Overrides (`Scenario.overrides`: category, row, month, signed amount) are applied after everything else in the model. Growth, size changes and stops are not applied on top of a typed figure.
  - **Days are kept.** A typed month keeps the row's usual payment days (spread in proportion to the model's amounts that month). A row with no payments that month puts the figure on the 15th, rolled to a working day.
  - **Getting back:** emptying a cell restores our figure, "Undo edits" clears a row, and an added row can be deleted.
  - The engine keeps each payment's projection separately (`seriesRows`) and tracks how changes scale the model day by day (`mult`), so rows always add up to the line. Tests check this, and that typed figures are final.
- **By day.** The grid also has a day view: dates down the page, one month at a time; payments across; weekends and bank holidays greyed.
  - **Day overrides** (`GridOverride.date`) set a row's amount on that day exactly. They are applied after month totals.
  - **Day and month edits together:**
    - a new month total clears that row's day figures for the month;
    - a day figure in a month that had a total turns the month's other days into day figures at their current values (`applyCells`), so nothing else moves.
  - **Pasting:** a block runs down the days (carrying on into later months) and across the columns. A list whose first column is dates (or months) goes into the clicked row or column on its own dates, and anything outside the forecast is reported.

## Replacing a line: clear it, build it, or import it

- **Clear our forecast** for a line sets its method to `manual`. Only the user's own figures count (grid rows, known future items), and "Bring our forecast back" undoes it.
- **Build it yourself** (`LineWizard`) makes a row of dated figures in the line's grid from:
  - **a regular amount:** weekly to annual, on a date or the last working day, moved off weekends and bank holidays (earlier for payments, later for receipts);
  - **an annual total spread across the months:** evenly or by the line's past pattern;
  - **a list of dates and amounts:** typed or pasted.
  - Optionally it clears our forecast for the line.
- **Import a schedule** (`ImportWizard`, `lib/forecast/importSchedule.ts`) reads a table other departments send: .xlsx/.xls (first sheet with data), CSV/TSV, or pasted text.
  - **Finding the columns.** It finds the header row (below any title lines) and the date, amount, category and description columns, and guesses the date order (a part over 12 settles it, otherwise UK order).
  - **Matching names.** It matches the file's category names to ours (exact names, then synonyms, then partial), and the user confirms or chooses for anything it can't place. Grants come first in the synonyms, so "Housing Benefit subsidy" (a grant, money in) isn't taken for housing benefit paid out.
  - **Signs.** Amounts are either all positive, with the direction taken from the category, or already signed.
  - **Three ways to use it:**
    - replace some of our rows for the months covered;
    - replace the lines entirely;
    - add on top.
  - **Which rows it replaces** is suggested per line from shared words between the file's names and our payments. Paying departments (DWP, MHCLG…) and month words don't count as a match. If it can't tell, nothing is ticked and the user decides. A replaced row is cleared only in the months where the file has figures for that payment (or all months the file covers for the line, if the file doesn't name it).
  - **Provenance.** Imported figures are tagged with their source (`GridOverride.source`). Importing again under the same name replaces the whole earlier import, and deleting the imported row in the grid removes everything it did, including what it replaced.

## Cash history: day-to-day and periodic use without re-loading everything

- **What the team file keeps** (`TeamFile.cashHistory`, `lib/history/cashHistory.ts`). It never keeps bank lines. It does keep:
  - for each bank account: the days held, its opening and closing balances where statements show them, and daily totals by category (recurring, one-off, treasury, internal) in pence;
  - for each regular payment: its payee name, category, direction and every occurrence (day, amount, account). The user chose this level so forecasts from the file alone are as good as from the statements, timing included.
  - It's about 340 KB for five years and four accounts on the example. It's written on single lines, so the rest of the team file stays readable, and can be switched off when saving ("Keep your cash history").
- **Merging.** Each session's files become a history of the same shape (`fromSession`, in the worker). It's laid over the saved one account by account, and the days a new file covers replace what was held for those days of that account. So:
  - re-loading a statement never counts it twice (a test checks totals are unchanged);
  - a part-day file can be loaded again later;
  - a full reload re-sorts everything with today's rules.
  - Gaps of more than 4 days between what was held and what's added are reported.
- **Regular payments in a short session.** Payments the saved history already knows are carried as occurrences even when one day of data is too short to show them repeating. Their cadence, day of month, trend and "still going" are re-worked from all occurrences with the same `describeDays` that detects series in bank files. A test checks that history built from a full upload forecasts exactly as the files do. Four years saved plus a year added comes within 0.5% of all five loaded together (against gross flows); the difference is a grant whose payments straddle the join.
- **Example data never mixes with a council's.** An example history only takes more of its own example accounts, and a real history never takes example data.
- **Step 1 with a saved history:**
  - a card shows what's held, with "Go straight to your analysis" (Look back and Look ahead from the history alone; sorting needs files);
  - a load of up to three days shows **Your day**: the day's lines sorted by category, each line a click away, anything unsorted, and one quiet line comparing everyday cash with what the forecast expected. Not a treasury management system: no variance analysis or re-forecasting;
  - longer loads say what was added, what was replaced, and any gaps.
- Rule changes apply to files loaded from then on; re-sorting older history means loading those files again.
- **Fix found on the way:** progress messages from the worker could arrive after its result (for tiny files), leaving "Reading your files…" on screen. They are now ignored once a step is done.

## One menu, three jobs

- The tool kept growing step by step until every screen was dense. It's now organised around what people come to do:
  - **Today's statement:** day-to-day, one screen;
  - **History:** a periodic deep look;
  - **Forecast:** the borrowing question.
- One top menu (Home · Today's statement · History · Forecast) replaces the sidebar. History has a short step strip (load, check the sorting, look back). Forecast is one path of tabs, ending in Report & Excel. "What's in it" folds into the result as "See it by category".
- **Home asks "What would you like to do?"** Each job's card says where you are (history saved to…, lines loaded, forecast checked). The explainer content is below, as "About this tool".
- **The team file lives in the header** (open, save, save as, your name, keep cash history), so saving isn't a step. The deal register moved to Forecast → Cash and investments, where it's used.
- **Less on every page:**
  - the "What this is / Why / What to do" boxes are off by default, behind a "How this works" link;
  - step-number labels are gone, because the menu and strip already show where you are;
  - line cards show what we found and the proposal, with the edit tools behind "Change something";
  - lists under the result are folded.

## Landing first; saved in the browser; the example as its own workspace

- The landing page stands alone, with **Enter** or **Explore the example council**. The app's Home is the three jobs.
- **No team files to manage.** Work is saved in the browser as it changes (`cfi.teamCache`), until the team file moves to the cloud. The settings menu keeps "Download a copy", "Load a copy" and "Clear saved work".
- **The example council is a workspace of its own** (`cfi.teamCache.example`), switched from Home or the header, so it can never touch a real council's work.
  - On first use it loads the example's five years and keeps its history up to the day before its last statement.
  - Each job then has a ready-made main action in place of a file drop: the example's statement, its five years, its deal register.

## Second simplification pass

- **Check the sorting** is one list: items to sort, then possible loans or investments. The tabs are gone, and the deal-register banner shows only with advanced tools.
- **The load results card** says one thing ("…% sorted, loans and investments set aside, saved to your history"), plus anything that needs attention (gaps, unusual files).
- **Forecast has five tabs:** check each line, known items and cash (one page: items, starting cash and minimum, deal register), your forecast, what you could do, report and Excel.
  - The result and "what you could do" each lead with two figures, not four.
  - The options page folds its three charts.
  - The live strip shows only on the editing tabs.
- **The loaded deal register** is one line, with the rest under "More detail".
- **A built-in rule** reads "…NND" at the end of a narrative (NNDR cut at 30 characters) as business rates. On the example, uncategorised money fell from £28m to £0.

## Deal register on its own; accepting every line at once

- **Forecast's starting screen** (no history yet) offers the deal register on its own (`RegisterOverview`):
  - totals: loans, fixed-term investments, funds, and the next 12 months net;
  - the next 24 months of repayments, interest, maturities and agreed new deals, by month;
  - the largest items, LOBO call dates, and the liability benchmark (shared chart with "What you could do");
  - a pointer to load statements, since only those show when cash runs short.
- **"Accept all N remaining as proposed"** returns to Check each line at the user's request, behind a confirmation that says the lines haven't been opened. This reverses the earlier "every line opened individually" decision. Any line can still be opened and changed afterwards.
- **The example council's deal register is always connected:** it loads on entering or switching to the example (including after a reload), and its card says "connected", with no upload, replace or remove.

## Third simplification pass

- **Today's statement:**
  - "sorted and added to your history" is said once, not three times;
  - categories are clickable rows (with line counts) instead of a Lines column and "See lines" links;
  - "Load a different statement" is gone.
- **Look back:** the year cards stay and the duplicate bar chart below them goes. View tabs are unnumbered, so they don't read as steps under the History strip.
- **Check each line:** the progress card is the count, "Accept all", and "Import a schedule from another department"; the separate import banner is gone.
- **Your forecast:** the two figures and one "why" sentence (biggest calls on cash, first dip below the minimum) replace the plain-English paragraph, which repeated the figures. The paragraph remains with advanced tools and in the report. No subtitle once unlocked, and the chart's extra key line shows only with advanced tools.

## Options in one line; a one-screen landing page; how amounts are shown

- **Each option** is a headline plus one line, with the reasoning behind "More" (`Strategy.options[].detail`). The report and Excel use the headline and line.
- **The landing page is one screen:** name, one sentence, Enter or Explore the example council, the three jobs, three reassurances. The longer explanation sections are gone.
- **Amounts:**
  - summaries are rounded to £m / £k, since pennies on a two-year forecast imply false precision;
  - individual bank lines (Today's statement) are always shown to the penny, for reconciling, and Excel is exact;
  - a setting, "Show exact amounts (£ and pence)", switches every on-screen figure to pounds and pence. Chart axes and the "about £…" option headlines stay rounded.

## Fourth simplification pass

- **With a saved history there's nothing to choose:** History opens on Look back and Forecast on its build tabs, straight from the saved history. "Load statements" is just the upload, for adding more. The saved-history card (with its three competing actions) is gone; "Clear saved work" in settings covers forgetting it.
- **The starting cash, minimum and horizon** are one compact form (a row each) instead of three numbered cards with paragraphs.
- **Small fixes:** a stale "save & share" link removed; "(optional)" hidden once a register is in; the section is "Your starting point".

## Fifth simplification pass

- **"Anything coming up"** is one row of three small buttons (one-off, something stops, a rise or cut), not three large tiles.
- **On a line card,** payment days read as text ("on or near the 28th") until "Change something". Dropdowns and remove buttons appear only then. Field hints are a few words each.
- **The forecast chart's zoom slider** shows only with advanced tools; scroll-to-zoom still works.
- **Step footers only go forward.** The strip and tabs handle going back, and the old back button could point across jobs or at a step that wasn't available.
- **Confirmations use the app's own dialog** (`askConfirm`), never the browser's `confirm()`, which some embedded browsers block (it returns "cancel" without showing). This affects accept all, clear our forecast, clear saved work and delete scenario.
- **The forecast unlocks as soon as every line is checked**, with no separate "See my forecast" step.
- **The example council's lines come already accepted** (again after its history changes), so its forecast opens on the result with nothing locked.

## Report check (A4 pages)

- **Every page is measured to fit:** content stays inside the 15mm side margins and above the footer, including the busiest case (full statements loaded, so the backtest shows).
- **Tables are all in £m** (`money(x, { unit: 'm' })`), so a column never mixes −£92k with £9.7m. Anything that rounds to £0.0m loses its sign.
- **Benchmark table headers are short** (CFR, Benchmark, Over benchmark), with a key underneath. The long headers had pushed the table past the right margin.
- **The cover's fourth figure is the date cash first drops below the minimum.** "Position at end" repeated the low point whenever cash falls to the end. Position at end still shows when there's no dip.
- **The confidence page always has substance:** the likely range at 3, 6, 12 and 24 months. A saved history reports its own span, accounts and regular payments, in place of "not available".
- **Drivers table** shows at most 18 categories, with the rest on one line, so it can't spill off its page.
- Wording: "1 month", "dips below it twice", no nested brackets around the register's name, plurals in data quality.

## Full run-through (every job, desktop and phone)

- **Switching to the example while on Forecast or History** now waits for the example to set up, shows a message meanwhile, then opens the same job on its history. Before, it stopped on the start screen offering "Use your saved history: nothing to load".
- **A forecast needs at least six months of history** (`MIN_HISTORY_DAYS`). One saved day (from a first Today's statement) used to produce an empty "0 of 0 lines checked" forecast. Now Forecast says how much history there is and what it needs, and History opens on loading statements.
- **Home shows the saved history including today's additions**, as years and months ("5 years saved, Apr 2021 to Mar 2026"), not the lines in this session. A first-time user's History card says **Start here**, and jobs that can't run yet are muted.
- **Landing page:** a small illustration of a forecast (past, forecast, likely range, minimum cash, borrowing need) sits beside the headline. It's hidden on narrow screens.
- **Charts no longer capture the scroll wheel:** zoom with Ctrl + scroll (or the slider in advanced tools), so the page scrolls normally over a chart. The forecast chart's divider reads "forecast starts", not "today": the forecast starts where the data ends, which may not be today.
- **Phones:** the app shell no longer runs wider than the screen (it was 551px on a 375px phone). The header fits on one row (the switch reads "Yours | Example", and the privacy shield moves out). Step tabs and job strips scroll sideways on one row with the current tab in view. The chart legend moves under the chart. Year cards wrap.
- **Today's statement:**
  - Lines in a single day no longer repeat the date.
  - The account column shows only when there are several accounts.
  - A new user is pointed to History afterwards.
- **Check the sorting:**
  - "% sorted" rounds down (`pctDone`).
  - The fallback items are "items we weren't sure about" (they do have a best-guess category), not "couldn't sort".
  - A line asked about as a possible loan isn't also listed as an item to sort.
- **History's "over these N years"** uses the span actually held (it said 4 for nearly 5).
- **Wording:** the "not advice" note no longer repeats "Options to discuss"; "section 151" is lower case; a few dashes became plain punctuation.

## Forecast vs actual

- **A new Forecast tab, "Forecast vs actual".** It shows what the method would have forecast 6 months, a year or 2 years ago (default a year), using only the history up to then, against what actually happened. The page has:
  - one sentence with a plain verdict ("very close" under 2% of the cash that flowed, "close" under 5%, otherwise "some way out");
  - one chart (the forecast then with its likely range, and the actual line);
  - three figures;
  - "Where it was out" (the categories that differed most, with one-offs named, since no method can foresee them).
- **It works from the saved history alone** (`backtestFromHistory`): the history before the cut-off is what the forecast learns from, the history after it is what happened. The original backtest needed the bank lines loaded this session, so day-to-day users never saw it. A test checks the two agree: actuals to the penny, the forecast within 1% of the year's flow.
- **Everyday cash only, with nothing added by hand.** It uses the method you'd use today (your lookback and methods), without your known items, which you couldn't have known then. Loans and investments are left out, as in the forecast.
- **It needs a year and a half of history:** a year to learn from, six months to compare with. Below that, the tab says so.
- **The report and Excel use the same check** (a year ago), so the report's "Backtest not available" is gone.
- **The comparison exposed a weakness, now fixed: payments that change name.** A regular payment whose bank reference changes looked like it had stopped, and its replacement hadn't paid often enough to be recognised. Real examples are a department renamed (DLUHC to MHCLG in 2024) or "VAT REPAYMENT" becoming "VAT REFUND". In the example, a year back, about £14m a year of grants and the whole of VAT reclaims (forecast £0) dropped out of the forecast. Now a "stopped" payment is kept going when amounts in its recent range keep arriving in the same category on the same rhythm, right up to the end of the data. This applies to monthly or less frequent payments only, where such amounts stand out. The line's notes say so. A payment that really stops is still treated as stopped, the cautious default. In the example a year back, the gap fell from £40.2m to £26.1m, and six months back from £22.6m to £11.2m. The current forecast is unchanged.

## Signed-off forecasts

- **"Sign off this forecast"** on Your forecast freezes the forecast exactly as it stands. It asks for a name (remembered), and the row then shows "Signed off on … by …". If the forecast changes afterwards, it says so and offers to sign off again; the signed-off version never changes.
- **Forecast vs actual** opens on the signed-off forecasts, newest first. Each shows who signed it, when, their note, the headline at the time and anything added by hand, then the same sentence, chart, figures and "Where it was out" as the method test. It's compared up to the latest statement; until a statement from its first day arrives, it says there's nothing to compare yet. "Test the method" is the second view.
- **Like for like:** everyday cash only. The record holds the forecast categories (modelled ones only, kept even when forecast at nothing, so what arrives in them still counts), and the actuals are summed over the same categories from the saved history. Categories are compared over complete months only. A test checks that a signed-off forecast compared from the history agrees with the method test for the same date.
- **The example has two sign-offs** made from its own history: a "Budget forecast" a year back, including a depot sale added by hand as a known item, and a "Mid-year review" six months back. Workspaces cached before this get them when opened.
- **Ready for a shared database.** A sign-off is one self-contained, immutable record (`SignedForecast`, `lib/forecast/signoff.ts`): its own id, who signed it and when, an optional note, the period and headline, the known items, the everyday-cash line with its likely range (one figure a day, whole pounds), and each category by month. About 30KB.
  - **Today:** records live in `TeamFile.signedOff`. They're added and never edited, and merging team files keeps everyone's (union by id), so two people's sign-offs never conflict.
  - **Later:** one table, e.g. `forecast_signoffs (id, council_id, scenario_id, signed_by_user_id, signed_at, note, start, end, payload jsonb)`, insert-only, readable by everyone in the council.
  - **Comparison:** `compareSigned(record, history)` is a pure function of the record and the cash history, so it can run in the browser or on a server, and needs no change when storage moves. The dialog's free-text name becomes the signed-in user.

## Tracking on Home and Today's statement

- **One answer everywhere** (`useTracking`): the newest signed-off forecast with statements to compare against, or else the newest one still waiting. Home, Today's statement and Forecast vs actual all use it, so they always name the same forecast and the same figure.
- **Home:** the Forecast card reads like "Everyday cash £11.2m ahead of the signed-off 'Mid-year review', to 31 Mar 2026", and opens straight on Forecast vs actual. A sign-off with no statements after it yet reads "signed off: waiting for statements".
- **Today's statement:** under the day's totals, "Since the signed-off 'Mid-year review' began (1 Oct 2025), everyday cash is £11.2m ahead of it", with a link. It shows only when the comparison includes the day just loaded.
- **Wording:** "ahead of" means more cash than the signed-off forecast expected, "behind" less, and "in line with" within £0.5m.

## Scope: a bank tool with monitoring, not a treasury management system

What this tool does: sorts bank statements, forecasts everyday cash, and checks forecasts against what happened. It reads the deal register, and it has no way to write to it. It deliberately doesn't:
- record, price, confirm or settle deals;
- hold the book of record for loans and investments (the deal register stays the source);
- monitor counterparty or treasury management strategy limits;
- make or approve payments;
- produce accounting entries.

New features should stay on this side of the line. Signing off and monitoring a cash forecast is forecasting governance, not dealing.

## Four distinct jobs, and a next step on Home

- **Four jobs, in the order they depend on each other:** History (learn from years of statements, topped up when behind), Forecast (build, check, sign off), Today's statement (daily), Monitor (signed-off forecasts against actuals, whenever you like). They appear in this order in the menu, on Home and on the landing page.
- **Monitor is its own job** (the `monitor` step, `MonitorPage`), no longer a tab inside Forecast. It works from the saved history and the sign-offs alone, without building a forecast first. "See it against what happens" on a sign-off, Home's Monitor card and the link on Today's statement all go there.
- **Home shows one next step**, worked out from where you are:
  1. not enough history (six months): load your bank history;
  2. history more than 14 days behind: catch up under History, so a forecast doesn't start from old data;
  3. nothing signed off: build your forecast and sign it off;
  4. no statement yet up to the expected day: add today's statement;
  5. otherwise "You're up to date", with the latest signed-off forecast against actuals, opening Monitor.

  Below it, the four jobs each show done (tick), next (orange), to do, or waiting (greyed: it needs an earlier job first), with a one-line status.
- **The expected statement day** is the last working day before today, or for the example council its last day (31 Mar 2026), so the example has a daily job to do until its statement is added.
- **The example's sign-offs** are dated from the month after its history ends (1 Apr and 1 Oct 2025), so they don't move when the last day's statement is added.
- **Phones:** five menu items need the header's room, so the Yours | Example switch is hidden there (Home has the big one) and an "Example" tag shows when you're in the example.
