# Cash Flow Insight

A PWLBtoday prototype that turns a council's raw bank history into a transparent, auditable **cash flow forecast**. The forecast answers a treasury team's real question: *when will we need to borrow, how much, and when will we have cash to invest?*

The tool runs entirely in the browser. It categorises several years of bank CSV lines and keeps treasury deal flows out of the model. It then analyses how operational cash has behaved and projects the operational position forward. The officer adjusts the projection with assumptions, one-offs and pasted schedules, and can backtest it against history.

> **Your bank data stays on this computer.** There is no server, no upload, no analytics and no AI. See [Verifying that no data leaves the browser](#verifying-that-no-data-leaves-the-browser).

## Quick start

Requires Node 20+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. On step 1, click **Generate demo data** to load a synthetic five-year history (Small, Large or Brutal volume), or drop in your own bank CSVs. To start with learned rules, bank profiles and a saved forecast, open [`data/sample-team-file.json`](data/sample-team-file.json) with **Open team file**.

To build a static bundle, which can be hosted on any web server or intranet:

```bash
npm run build
```

The output in `dist/` is plain static files with no backend.

## Synthetic data

The generator models a fictional unitary council, "Northbridge". It produces council tax, NNDR, payroll with pay-award arrears and a payday change, grants that start and stop, suppliers, schools and capital. It also simulates a treasury desk (PWLB, LOBO, LA-to-LA loans, MMFs, DMADF and fixed deposits) reacting to the cash position. The output is written in five deliberately messy bank "dialects": debit/credit or signed amounts; UK, ISO, text-month, Excel-serial and some US dates; `£`, brackets, `CR`/`DR` and mis-encoded characters; truncated narratives, cryptic references, title and footer rows, overlapping exports, reversals, duplicates and invalid dates.

To write CSVs and a hidden `truth.json` to disk:

```bash
npm run generate -- --preset large --out data/large
```

Options: `--preset small|large|brutal`, `--seed`, `--years`, `--start` (first financial year), `--accounts 1-4`, `--nastiness 0-2`. Ready-made sets are in [`data/small`](data/small) (≈22k rows) and [`data/large`](data/large) (≈245k rows).

When generated data is loaded, step 3 shows a developer **Accuracy** panel that scores the engine against the truth file: per-category recall and precision, a confusion matrix, % of deal value excluded, and deal value wrongly left in the model.

## Headless bench and tests

```bash
npm run bench -- --preset large --forecast
```

This generates data, ingests, categorises, scores accuracy, forecasts and backtests (single date and rolling), printing timings and accuracy. Add `--team data/sample-team-file.json` to include the sample team's rules.

```bash
npm test
```

Unit and end-to-end tests cover parsing, dialect detection, paste-in, series projection, team-file round-trip and merge, YoY totals against the truth file, and the no-look-ahead guarantee for backtests.

Reference numbers on a 2024-era laptop, from the bench:

| Preset | Rows | Parse | Categorise | Rows correct | Deal value excluded | Operational wrongly excluded |
|---|---|---|---|---|---|---|
| Large | 245k | 1.1 s | 0.8 s | 99.9% | 98.5% (99.9% with sample team file) | £0 |
| Brutal | 775k | 3.5 s | 2.2 s | 99.9% | 99.9% (with team file) | ~£1k |

A forecast recomputes in 10–30 ms; changing an assumption updates the chart and summary in under 100 ms.

## How it works — one menu, three jobs

- **Today's statement:** drop in a day's bank statement. It's sorted with the team's rules; sort anything new on the same screen; the day joins the saved history. Or pick **A past day**: any date the saved history holds, as totals by category (and the regular payments that day).
- **History:** load statements (years the first time, the latest period after that), check the sorting, look back at how cash behaves.
- **Forecast:** start from the saved history, statements or the example. Then: check each line, known future items, cash and investments (including the deal register), your forecast, what you could do, report and Excel.

The team file opens and saves from the header from anywhere. Settings (the gear) holds explanations on every page and the advanced tools: column mapping, sorting results, all transactions, backtesting, scenarios.

## Day to day, or a periodic review

The team file can keep a **cash history**: daily totals by category for each bank account, and the dates and amounts of regular payments (never individual bank lines). With it:

- **Day to day:** open the team file and add today's statement. You see the day sorted by category, sort anything new, and the day joins the history.
- **Forecast vs actual (Monitor):** each signed-off forecast against what happened so far, then a fresh forecast with its likely range from the latest statement to the end of the signed-off period, so you can see where the period is now heading against what was signed off.
- **Periodic review:** add the latest month, quarter or year (nothing is counted twice; gaps are pointed out), or go straight to Look back and Look ahead from the saved history without loading any files.

## Deal register (optional, recommended)

On step 1 you can add your PWLBtoday **deal register** (the Excel workbook of loans and investments). The example data comes with one. With it:

- bank lines are matched to your deals exactly, so loans and investments are set aside with certainty;
- the forecast includes loan repayments, interest (estimated, and checked against your bank history), maturing investments and the money held in funds;
- **Look ahead → What you could do** sets out options to discuss: how much to borrow and when, how much is lasting versus short term, how that compares with your liability benchmark (and so how long loans could run), refinancing and LOBO call dates in the period, and how much cash could be invested for longer.

The register is read in the browser and kept for the session only. It is not saved in the team file. To refresh the vendored reader from the TMS repo, run `node scripts/sync-register.mjs <path-to-pwlbtoday-tms>`.

## The team file

One JSON file kept on the team's shared drive holds the authority name and settings, categories, rules, aliases, bank profiles, series and transaction decisions, scenarios and a change log.

Scenarios include their assumptions, one-offs, schedules and a results snapshot. An optional category × month history summary is included too. A colleague can therefore open the file and see the latest forecasts without the CSVs.

It contains **no transaction lines**. Per-transaction review decisions are stored under one-way hashes, not narratives or amounts.

If two people edit copies, saving merges them: rules and forecasts from both are kept, and items genuinely edited by both are offered as a mine/theirs choice.

## Verifying that no data leaves the browser

A council IT team can check this in a few minutes:

1. **Network panel.** Open the browser's developer tools (F12), **Network** tab, tick *Preserve log*, then load a CSV and work through every step. After the initial page load you should see **no requests at all**: no XHR, fetch or WebSocket. Opening files, categorising, forecasting and exporting make no network calls. Exports are created in the page and saved by your browser.
2. **Content Security Policy.** The built `index.html` carries a CSP of `default-src 'self'; connect-src 'self' …; form-action 'none'`. The page is technically *unable* to send data to any other host, and the browser blocks and logs any attempt. Check it under DevTools, Elements, `<head>`.
3. **No third-party code at runtime.** Fonts (Inter), icons, charting (ECharts), CSV parsing (PapaParse) and Excel (SheetJS) are bundled into `dist/`. Nothing is loaded from a CDN. To confirm, search `dist/` for `http`: you'll find only XML namespace identifiers (used inside the Excel and SVG writers), library homepages and React error-reference links. None of them is ever requested, and the CSP would block it if it were.
4. **Offline test.** Build the app, serve `dist/` locally, then disconnect from the network. Everything keeps working.
5. **Storage.** Only the team file, which contains no transactions, and your initials are cached in this browser's `localStorage`. Bank data lives only in memory and disappears when the tab closes.

## Project layout

```
src/
  generator/      synthetic council cash engine + messy CSV renderer + truth file
  lib/ingest/     date/amount parsing, dialect detection, streaming ingest
  lib/categorise/ normaliser, starter rules, categorisation engine, accuracy scoring
  lib/analysis/   aggregates, history analytics, snapshots
  lib/forecast/   forecast engine, backtesting, paste-in parser
  lib/export/     Excel workbook
  worker/         the engine Web Worker (owns the dataset)
  state/          app store
  ui/             shell, steps, forecast controls and views
  theme/          PWLBtoday design tokens and base styles
scripts/          generate, bench, sample team file
tests/            vitest suites
data/             sample datasets, truth files, sample team file
```

See [`DESIGN_TOKENS.md`](DESIGN_TOKENS.md) for how the look was matched to pwlbtoday.org, and [`DECISIONS.md`](DECISIONS.md) for the choices made where the spec was open.

The product name lives in [`src/config.ts`](src/config.ts).
