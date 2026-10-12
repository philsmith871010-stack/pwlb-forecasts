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

## Forecast vs actual read at month ends

- **Headline comparisons read at the latest month end inside the period** (`monthEndIndex`), not the latest day. A payday or grant landing a day off forecast swung the daily figure by £10m or more (in the example: £21.5m ahead on 30 Mar, £11.2m on 31 Mar). Home, Today's statement and Monitor's sentence and figures all use the month end and say so ("at the end of Mar 2026"). Monitor's chart still shows every day, so timing is visible but doesn't drive the headline.
- **Before the first month end of a period**, the latest day is used and labelled "so far".
- "Inside the likely range" still counts every day: it's about the range, not the headline.

## Sixth simplification pass

- **Forecast before any history** says in one line that a forecast learns from your bank history. The deal register is offered as "Meanwhile: your deal register", with a two-line description and no "recommended" badge (it read as a contradiction under "Or start with…").
- **Check each line:** the "money in / money out" badge is gone; the line already says "£211.8m in over the next 12 months". Growth uses a proper minus sign (−2.3%).
- **What you could do:** the row of figures repeating the first option ("Borrowing needed", plus "Could invest for 12 months: £0") is gone. The options lead.
- **Monitor:**
  - "Signed off on … by …" is said once, on the forecast's card.
  - The box under it gives what the forecast said at the time.
  - The sentence is just what it said and what happened.
  - The difference has its own figure, replacing "inside the likely range: 29% of the days", which was hard to read (the chart still shows the range).

## The example council is a practice run

- **The example starts empty and is set up step by step, exactly as your own council would be.** It's no longer generated, connected and accepted for you. Wherever you'd choose a file, the same box or button picks the example's file instead, and nothing is uploaded:
  - History: clicking the drop box lists the example's five statement files, just as chosen files are listed. You click Read my files, check the sorting, and look back.
  - The deal register: "Choose register (.xlsx)" picks the example's register, in Check the sorting or under Known items and cash.
  - Today's statement: clicking the drop box reads the example's statement for 31 Mar 2026.
- **The practice files stop on 30 Mar 2026** (`exampleHistoryFiles` removes the last day's lines from each file), so today's statement really is the next day.
- **Nothing is done for you:** forecast lines are checked as for real (Accept all is there), and you sign off the forecast yourself.
- **A "Practice run" note at each step** says what you'd do with your own council and what the click does here.
- **The example's treasury team signed off two forecasts in the past year.** They're added once the history has been read, so Monitor has something to compare straight away.
- **"Start the practice again"** on the example's Home resets it. Earlier ready-made examples saved in a browser are discarded (new storage key), so everyone starts the practice from the beginning.
- **Check the sorting offers the deal register** when it has five or more loan questions and no register: it recognises most of them (the example drops from 20 questions to 2).

## Fixes found by the practice run

- **The day's statement replaced the history when both happened in one session.** The saved history the new files join was captured only when a workspace opened, so loading years of statements and then today's statement, without a reload, kept only the day. Each read now starts from the history as saved at that moment.
- **A forecast is judged only after a month of actuals** (`MIN_COMPARE_DAYS`). Home and Today's statement feature the newest sign-off with at least that much. A newer one says "too early to tell" and gives the first month end it'll be judged at, instead of a one-day verdict.

## A first-time evaluator's ten minutes

Walked through as someone deciding in ten minutes whether to buy. Changes:
- **Landing:** the outcome first ("Know when your council will need to borrow, and how much, straight from its bank statements"). The main button is "Try it with an example council", noted as about five minutes with no files; "Start with my council's data" is the other.
- **A practice guide bar** (`PracticeBar`) under the header throughout the example. It shows eight steps as dots, "n of 8", what to do on this screen, and a Go button when you're elsewhere. For a step that's just a look, it has the way on ("On to the forecast", "See the board report", "On to today's statement"). It ends with what was done, the board report, and "Start with my council". The steps:
  1. load the history;
  2. check the sorting;
  3. look back;
  4. check the forecast;
  5. see it and sign it off;
  6. what you could do, and the board report;
  7. today's statement;
  8. forecast vs actual.

  Progress comes from the data where it can (history loaded, lines checked, your sign-off, statement added) and otherwise from screens visited, kept in this browser and reset with "Start the practice again". The example's Home takes its next step from the same guide, and its job cards' ticks follow it, so they never disagree. The page-level practice notes that only repeated the bar are gone. The ones that add something stay: the register card, Known items, Monitor.
- **The example's file boxes say what the click does** ("Click to choose the example council's files", with "With your own council: drag your bank's CSV files here" underneath). "Add more files" isn't offered in the example.
- **Check the sorting:**
  - the deal register is offered at the top when there are five or more loan questions;
  - "Done for now" is also in the progress bar, so nobody scrolls past every card to move on;
  - adding a register confirms it ("Deal register added: 17 loans and 4 investments").
- **Signing off in the example** is pre-filled "You (practice)", which isn't kept as your name.
- **The deal register is now kept in this browser**, per workspace (the file itself, or a marker for the example's), and read again when the workspace opens. Before, a reload silently dropped it: the forecast changed (£278.2m became £192.8m) and the options asked for the register again. It's removed with Remove and with "Clear saved work". Like the cash history it stays on this computer.

## A milder example council

- **The example's numbers tell a believable story.** History runs roughly in balance (a £23.8m surplus in 2021/22, then between £17.8m short and £9.6m over). The forecast says "may need to borrow about £97m by March 2028", with cash first dipping below the £10m minimum at the end of March 2026. Before, it said £278m, from a deficit of about £40m a year that kept widening. Changes to the generator:
  - pay awards of 4.5%, 4% and 3.5% (were 6.5%, 6% and 4.5%), with less drift;
  - capital spend of £36m a year growing 3% (was £42m growing 6%), and smaller one-off capital payments;
  - adult social care providers growing 5% (was 7%);
  - the new packaging (EPR) grant starts in Nov 2024, so it's established as a regular payment rather than paid only twice.

  The deal register's loans are sized from that shortfall, so they're smaller too (13 loan questions before adding the register, 1 after).
- **The example's treasury team set the agreed pay award (+3%)** in its two signed-off forecasts, as a real team would. It shows under "Added by hand".
- **Forecast vs actual judges what a forecast could have known.** The verdict uses the closer of the gap including one-offs and the gap excluding them, and the sentence says so ("Leaving those aside, it was out by £9.1m"). Bands: very close under 1.5% of the cash that flowed, close under 3.5%, otherwise some way out (were 2% and 5%, too generous once one-offs are set aside). In the example the Budget forecast was cautious (some way out) and the Mid-year review came close.
- **"Test the method" counts back from the month after the history ends**, so a year back from 30 Mar 2026 is 1 Apr 2025, not 1 Mar.

## Fix found by the new example

- **An inexact amount to another council was taken as a loan's interest.** Estimated interest matches within 1%, and any line naming a council counted as plausible, so a £417,832 recharge to Bramford Borough Council was taken as interest on a loan from Bramford County Council. As the code's own comment intended, an inexact amount now needs the counterparty's name, a treasury counterparty, or the word interest. An exact amount still only needs to look like a deal. The accuracy report now lists everyday lines taken for deals (`wrongExclusions`), so a failure says which.

## The example's opening cash, and a simpler landing page

- **The example council holds £30m in money market funds** from the start, and keeps that as its liquidity reserve, borrowing short-term rather than running it down (was £10m, starting from nothing). Its starting cash is about £56m (£9m in the bank plus £47m in funds), not about £12m, which sat right at the £10m minimum. The forecast now first dips below the minimum on 2 Apr 2027, a year in, and may need about £50m by March 2028.
- **The landing page is the name, one sentence, Enter and the preview.** The two path buttons, the four job cards and the trust line are gone: you choose your path inside. Enter opens the workspace you used last. For a new user, your council's Home has "New here? Try the example council first" under the next step.

## Seventh simplification pass

- **Payday that has moved:** a monthly payment whose latest four payments were all on the last working day is projected there, whatever came before. A payment due in the last five days before the forecast starts, but not in the statements yet, is counted on the first forecast day instead of dropped. Together these restore the March payday the example's forecast was missing: on 31 Mar the forecast now expects −£11.6m against −£11.7m actual (it expected −£2.0m). Real councils whose payday has moved would have seen the same gap.
- **Look back's sentence:** how many full years ran short, then the latest full year in plain words ("In 2024/25, £0.9m more came in than went out"). Year cards are all in £m.
- **Check the sorting:** shorter instructions (the subtitle, the progress text and the section subtitle each said much the same).
- **The forecast page keeps one title**, "Your cash forecast", rather than "Build your forecast" until lines are checked.
- **The register card lists only what the register holds** ("£223.1m of loans and £46.6m in funds", no "£0 in fixed-term investments").
- **Today's statement no longer shows "That covers … gone into your history"** for years read earlier under History; only for statements read on that page.
- **Home:** the closing paragraph about how the jobs depend on each other is gone (the numbered cards say it). The example's intro and Monitor's practice note are shorter.

## Density pass: full width, more on screen

- **Every page uses the full width** (it was capped at 1480px, or 1040px for "narrow" pages), with tighter spacing throughout: page padding, headings, cards, panels, figure tiles, tables, tabs, the practice bar and the notes. The board report's A4 pages are unchanged.
- **"How this works"** sits at the top right of the page, not on a line of its own.
- **Your forecast:** the two headline figures, the "biggest calls on cash" line and the sign-off share one row, so the whole chart fits on a laptop screen.
- **Check each line:** progress is one slim row (count, bar, Accept all, Import a schedule). The lines are a continuous list rather than spaced-out cards.
- **Known items and cash:** two columns, known items and the deal register beside the starting point, so the tab fits on one screen.
- **What you could do:** options sit side by side (three across on a wide screen). The broken link to add a register (it pointed at a tab that no longer exists) now opens Known items and cash.
- **Look back:** the year cards and "your everyday cash over time" are on one view; "Through the year" is the other tab.
- **Forecast vs actual:** the forecasts to pick from sit beside what the chosen one said when signed off; the sentence and the three figures share a row.
- **Home:** full width, with a smaller title.
- **Line checks survive daily statements.** They stay valid while the history has grown by no more than a month since they were made. Before, any new day meant re-checking all 18 lines. A new quarter or year, or older data, still means checking again.

## No liability benchmark; the day's lines beside the summary

- **The liability benchmark is removed** as too complex for this tool. It's gone from:
  - "What you could do": the "could be long-term borrowing", "more than your benchmark allows" and "above the benchmark" options, and the "long-term view" fold;
  - the register-only view's chart;
  - the register card;
  - the board report's options page;
  - the Excel workbook;
  - the strategy and worker code (`lib/register/benchmark.ts` and its tests deleted).

  The options are now the borrowing need (lasting or short term), loans falling due, LOBO call dates and cash that could be locked away. "Use it instead of new borrowing" now depends on borrowing being needed later in the forecast. The example register still carries a projections sheet, as the real template does; it's ignored.
- **Today's statement, wide screens:** the category summary sits on the left and the chosen category's bank lines fill the right (largest first, to the penny). The largest category is shown until you choose another. Below 1100px the lines expand in place, as before.
- **The report's options page figure matches the options.** "Could invest a year" (often £0) is now "Could lock away": the longest spell with at least £1m to spare on the cautious line, the same rule as the "Lock away" option (e.g. £28.2m for 6 months).

## Eighth simplification pass

- **Report & Excel shows the report itself**, with one bar above it: the council name, Download Excel, and Print or save as PDF. There's no card to click through first. Printing from here prints only the report's A4 pages; the header, tabs and practice bar are left out.
- **Fewer repeated words:**
  - the done card's "Next, you'll confirm a few items…" beside the "Next: check the sorting" button;
  - the forecast's subtitle (now one short line, and only until the lines are checked);
  - "Meanwhile: your deal register" no longer has a second line saying what the card already says;
  - the Known items practice note only asks for the register when it isn't added;
  - the report and Excel descriptions and the Today tip are shorter.
- The register card no longer says the options cover "for how long" (a benchmark leftover).

## Published on GitHub Pages

- **The site is published on GitHub Pages** from this repo (now public) by `.github/workflows/pages.yml`: on every push to `main` it installs, runs the tests, builds and deploys `dist`. A failing test stops the deploy.
- **The build uses relative paths** (`base: './'` in `vite.config.ts`), so the same build works at a site's root or under `/pwlb-forecasts/`. It was checked from a sub-path with the production security policy: the worker, the example files, the register template, the forecast and the report all work.
- **Nothing changes about the data:** the site is static files. Bank data is still read in the visitor's browser and kept there; the page's security policy still only lets it talk to its own origin.

## A past day, and a fresh forecast in Forecast vs actual

- **Today's statement has "A past day"** beside it once there's a saved history. Pick any date the history holds (or step to the previous or next day with money moving) and see that day by category, grouped as on today's card, with one-offs marked, the regular payments that day, everyday cash and, when every account's opening balance is known, the balance at the end of the day. The history keeps daily totals by category, not bank lines, so each figure is the day's net for that category and there are no lines to open; the card says how to see them (load that day's statement).
- **Forecast vs actual runs to the end of the signed-off period.** After what actually happened, a blue dashed line carries on from the latest statement: a fresh forecast made today from the whole history, with its own likely range, which starts at nothing and widens. It's drawn against the forecast as signed off, with its range, and the sentence says where the period is now heading against what was signed off. The fresh forecast uses the scenario that was signed off as it stands now, or your current forecast when that scenario isn't among your forecasts (as with the example's sign-offs), and says which. Like the comparison, it's everyday cash only, so the opening balance and deal register don't come into it. Once the period is over there's nothing left to forecast and the chart is as before.

## Signing off and monitoring, tested as a team would use it

A browser run went through a council's routine: load history, check the lines, sign off, add a month of statements, sign off again, sign off a second scenario, add another month, reload, save a copy and open it in a fresh browser. It found these, now fixed:

- **A saved forecast now moves on as statements arrive.** It used to keep its first start date. After a month of new statements it forecast that month again from the balance at its end, which counted the month twice. A sign-off made then would also have been backdated. Now a forecast starts the day after the latest statement and keeps its length (`rollForward`), both when it's worked out and on the saved forecast.
- **"Load a copy…" works in every browser.** In browsers without a file picker API (Firefox, Safari) it did nothing: its file input was inside the settings menu, which closes as the file chooser opens. The input now sits outside the menu.
- **A month ending on a weekend or bank holiday counts as complete** once the last working day's statement is in (`completeTo`). November 2024, ending on a Saturday, was otherwise never judged.
- **In advanced mode, "How this works" no longer covers** the scenario bar's Duplicate and rename buttons.

Improvements to choosing what's monitored:

- **Signing off asks what it's for** (optional): "Budget 2024/25", "Refreshed after October". The note shows wherever the sign-off is listed.
- **The Forecast page says why it's no longer the signed-off version.** Either new statements have moved it on (the earlier sign-off is still monitored, so sign off again to monitor this one too), or it was changed. Each message links straight to that sign-off.
- **Monitor opens on the sign-off you came from**, or just made. Each sign-off in the list shows its start, its headline and who signed it, with the time when several were signed on one day. It also shows the note. Past six, the older ones fold away behind "Show all".
- **Before there's anything to compare,** Monitor shows the signed-off forecast and its range ("What it will be measured against") and when it's first judged. It no longer shows only a line of text.
- **The team can choose which sign-off Home reports on** (`settings.trackedSignOff`, kept in the team file), such as the budget forecast rather than the latest refresh. Until they choose, it's the newest with a month of statements, as before (`trackSignOffs`), and a house mark shows which one it is.
- `tests/signoff.test.ts` covers rolling forward, month ends, which sign-off is reported on (chosen, newest, too early, a choice that's gone) and each sign-off judged over its own period.
- **A sign-off made by mistake can be withdrawn** under Monitor, with an optional reason. Nothing is deleted. The sign-off stays in the team file and is no longer compared or reported on Home. It's listed under "Withdrawn" with who withdrew it, when and why, and can be restored. Withdrawals and restores are a log (`signOffChanges`) that is only added to, and the latest entry for a sign-off decides. A merge combines both copies' logs, so a sign-off withdrawn in one copy doesn't come back from a colleague's older copy, and a later restore wins over an earlier withdrawal. If the team chose a sign-off for Home and it's withdrawn, Home goes back to the newest; restoring it brings the choice back.

## Money that comes in early

- **The problem:** once money is in the statements it's part of the cash so far. If the forecast still expects it on its due date, it's counted twice. A test reproduces it: a £3.5m housing benefit subsidy due on 7 May arrives on 20 April, and the forecast still had it on 7 May. Items added by hand had the same problem: a one-off stays in the forecast until its date, even after the money has arrived.
- **What's matched (`findEarly`):**
  - **A regular payment** (monthly or less often) seen twice in one period (the latest within 0.6 of its interval after the one before), at least 5 days before its next due date, and of about its usual size (0.75 to 1.33 times).
  - **An item added by hand,** still dated ahead, of £100k or more, whose amount (within 10%, the same way) has already arrived in its category.
  - **Not seasonal lines** (council tax, business rates). They're forecast as a monthly pattern, not as individual payments, so a match can't be trusted. Their grid is the way to change them.
- **Asked, not assumed:** "Came in early?" shows on Today's statement for the day's lines, and on the Forecast page for the last month of statements. "Yes, it's early" takes the due payment (or the one-off) out of the forecast. "No, it's extra" leaves it in. Either answer is kept on the scenario (`arrivals`), so it's asked once. Confirmed ones are listed under Known items as "Came early", with an undo.
- **Signed-off forecasts don't change.** The fresh forecast on Monitor uses the scenario, so it's corrected there.
- **Monitor splits the gap into timing and the rest (`timingAt`).** Timing is money confirmed as early that arrived between the signed-off forecast's start and the date it's read at, for a payment it expected after that date (and before it ends). It's already in the actuals and should even out once the due date passes. An arrival confirmed on a duplicated forecast counts once. Answers of "extra" don't count, and nor do ones whose due date has already passed.
  - **The sentence** names each early payment with its date and due date, then gives the difference with timing set aside, as "ahead of" or "behind". Where one-offs are set aside too, it says which way everyday cash really went, even when that's further out than the headline (in the test run, £7.4m ahead overall was £6.6m behind underneath).
  - **No double counting:** an early payment the history also holds as a one-off (a second payment in a month can be flagged as an outlier) is counted as timing only (`heldAsOneOff`).
  - **Elsewhere:** the Difference figure, the "Where it was out" rows, Home and Today's statement say how much is timing.

## A main menu and five areas

Users could get lost: the header listed every job, and 31 links on pages jumped between them. Now:

- **The main menu is the only way between areas.** The five areas are Set up and train, Review history, Daily, Forecast and Monitor. Each is entered from its card and left with "Main menu" in the header (or the browser's back button). Inside an area the header shows only "Main menu", the area's name, its state and its own steps. There's no list of other areas.
- **Every link across areas was replaced**, by one of three things:
  - the action done in place;
  - "Back to main menu" at the end of a job: after the last step in an area the footer reads "Done: back to main menu";
  - a sentence naming the area to go to.
  "A past day" moved from Today's statement to Review history. All transactions and Rules and settings moved from the gear menu into Review history and Set up and train as advanced steps. Loading a day's statement under Set up no longer jumps to Daily.
- **Locks say why** (`lib/areas.ts`, `computeAreas`):
  - Review history needs any history, and opens on A past day until there are six months.
  - Daily, Forecast and Monitor need six months.
  - Monitor also needs a signed-off forecast.
  A locked card is greyed with its reason. Opening a locked area shows the reason and the way back. A step that can't be used yet inside an area shows a lock and its reason, such as All transactions needing statement files read in this session.
- **Each card's state** is one of done, to do, waiting, ready or locked, with a short status and a detail line:
  - Set up: years of history, or how far behind.
  - Review: what's there.
  - Daily: up to date, or from which day statements are needed.
  - Forecast: not built, checked but not signed off, signed off, or lines to check again.
  - Monitor: ahead of or behind the sign-off with any timing, or when it's first judged.
  The same answer shows in the area's header. "Next" is the first of Set up, Forecast and Daily that has something to do, otherwise Monitor.
- **The practice run goes through the menu.** Each step knows its area. Inside an area, the bar says when the next step is elsewhere and offers "Back to main menu". Leaving an area finishes the steps that are only a look (Check the sorting, Look back, What you could do), so the run can't loop. The menu lists all eight steps with ticks.
