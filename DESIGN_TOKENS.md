# Design tokens — matched to pwlbtoday.org

Extracted on 6 October 2026 by reading the live site directly. I took computed styles and declared CSS custom properties from the home page, the SONIA forward-curve page (`/sonia-fwd-curve`) and the council benchmarking page (`/la-metrics`). I also looked at the sidebar links into the Academy. The values below are implemented once in [`src/theme/tokens.css`](src/theme/tokens.css) and used everywhere through `var(--…)`.

PWLBtoday has **no dark mode**, so neither does this tool.

## Colour

| Token | Value | Where PWLBtoday uses it |
|---|---|---|
| `--pt-navy` | `#0a2540` | Primary brand, table headers, ink for headings |
| `--pt-navy-mid` | `#143659` | Gradient middle stop |
| `--pt-navy-light` | `#1a4775` | Gradient end, links |
| `--pt-navy-grad` | `linear-gradient(120deg, #0a2540 0%, #143659 60%, #1a4775 100%)` | KPI cards, panel headers |
| `--pt-navy-grad-v` | same stops, vertical | Left sidebar |
| `--pt-orange` | `#fd7e14` | Accent: KPI values, panel titles, table header text, primary buttons |
| `--pt-orange-hover` | `#e06b00` | Primary button hover |
| `--pt-orange-soft` | `#fff5e9` | "Academy" call-out strips, selected rows |
| `--pt-text` | `#243240` | Body text |
| `--pt-muted` | `#6c757d` | Secondary text |
| `--pt-muted-2` | `#5a6b7b` | Landing-page muted text |
| `--pt-line` / `--pt-line-soft` | `#e9ecef` / `#f1f3f5` | Card borders, row dividers |
| `--pt-bg` | `#f7f8fa` | Page background |
| `--pt-green` | `#28a745` | Positive |
| `--pt-red` | `#b04632` | Negative (PWLBtoday's muted brick red, not pure red) |
| `--pt-mint` / `--pt-sky` | `#2dd4a8` / `#5cc8ff` | Landing-page highlights (used for completed steps) |

Amber (`#b7791f` on `#fff7e0`) is the one addition. It marks "suspected" and warning states, which PWLBtoday's palette has no equivalent for.

## Typography

- **Inter**, weights 400–800, bundled locally via `@fontsource/inter` (PWLBtoday loads it from Google Fonts; we bundle it so the tool makes no external requests). The fallback stack matches theirs: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`.
- Mono: `"IBM Plex Mono", ui-monospace, …`. It is used for narratives and signatures.
- Scale (`--fs-*`): h1 1.75rem / 800 / −0.025em; h2 1.4rem; h3 1.15rem; body 0.95rem; small 0.82rem; xs 0.74rem.
- KPI values: 32–36px, weight 700, orange, tabular figures. KPI labels: 12.5px, 600, uppercase, letter-spacing 0.5px, white at 72%.
- Table headers: 11.5–12px, 700, uppercase, letter-spacing 0.96px, orange on navy.
- Sidebar group labels: 12px, 700, uppercase, letter-spacing 1.92px, white at 42%.

## Shape and spacing

- Spacing scale `--sp-1…8`: 4, 8, 12, 16, 20, 24, 32px.
- Radii: cards 12px (`--radius-card`), sm 6, md 10, lg 14, landing 18; buttons, chips and segmented controls are pills (999px).
- Shadows: `--pt-shadow-navy` `0 6px 18px rgba(10,37,64,.10)` on every card and panel; `--pt-shadow-navy-strong` for hover and toasts.

## Components (as on PWLBtoday)

- **Shell:** 60px white header with the PWLBtoday wordmark ("PWLB" navy + "today" orange). The product name follows their "PWLB**benchmark**" pattern: navy plus an orange suffix, so here it is "Cash Flow **Insight**". There is a left sidebar on a vertical navy gradient with uppercase group labels. The active item has a lighter fill and an orange inset left border.
- **Panels:** white card with a navy-gradient header bar and an orange 14.7px semibold title (the SONIA page's "Implied MPC path" panel).
- **KPI cards:** navy gradient, uppercase label, big orange number, muted sub-line (the SONIA "Near-term implied / Trough" cards).
- **Buttons:** pills, 13px semibold. Primary is solid orange; secondary is an outline with a `rgba(10,37,64,.2)` border.
- **Chips:** white pill, orange text, `rgba(253,126,20,.35)` border (the Academy topic chips).
- **Segmented controls:** pill group, 12px semibold, navy fill when selected (the "1w ago / 1m ago" comparator).
- **Call-outs:** orange left border on orange-soft (the "PWLBacademy — New to SONIA?" strip).
- **Tables:** navy header row with orange uppercase labels, 12–12.5px body rows, light dividers.

## Charts

PWLBtoday uses Highcharts; this spec asked for ECharts, so ECharts is themed to match (`registerTheme('pwlb')` in [`EChart.tsx`](src/ui/components/EChart.tsx)):

- light grid lines `#e9ecef`, no axis ticks, 11px muted axis labels (`#6c757d`);
- navy tooltip (`rgba(10,37,64,.96)`), white text, 10px radius;
- Inter throughout;
- history drawn solid navy, forecast dashed orange, uncertainty a translucent orange band, buffer a dashed brick-red line;
- one fixed colour per category, defined once in [`categories.ts`](src/lib/categories.ts) and stored in the team file. Receipts use the blue/teal family, payments warm tones, treasury navy/slate.
