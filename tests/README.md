# Regression tests for withdrawal_strategy_JP.html

A Playwright-based test suite that loads the real `withdrawal_strategy_JP.html`
file in a real (headless) Chromium browser and exercises it exactly like a
person would — clicking buttons, filling in form fields, reading back
whatever the app actually renders. Nothing here re-implements or copies the
app's logic; every test calls the app's own functions and reads its own DOM,
so it can never silently drift out of sync with the real file the way a
hand-extracted source snippet could.

## First-time setup

From this `tests/` folder:

```
npm install
npx playwright install chromium
```

(`npm install` pulls in Playwright and a local copy of Chart.js — the app
loads Chart.js from a CDN, and these tests serve a local copy of it instead
so they run fast and don't need network access. `playwright install chromium`
downloads Playwright's own managed browser build.)

## Running the tests

```
node run-all.js
```

This runs every numbered test file (`01-...js`, `02-...js`, etc.) against
`../withdrawal_strategy_JP.html` and prints a PASS/FAIL summary. It exits
with a non-zero code if anything failed.

To point the whole suite at a different copy of the file (e.g. a work-in-
progress version somewhere else):

```
node run-all.js "/path/to/some/other/withdrawal_strategy_JP.html"
```

You can also run one test file on its own the same way, which is faster
while iterating on a single feature:

```
node 04-age55-toggles.js
```

## What's covered

- `01-qpp-oas-formula.js` — the QPP/OAS deferral math (+0.7%/month, +7.2%/year).
- `02-budget-core.js` / `03-budget-toggles.js` — Budget tab core logic: the
  Target-column income lookup, CPI escalation, income/bonus capture,
  computeBudgetTotals/computeDisplayTotals (including the debt-group
  exclude-by-default behavior), save/load, bracket resolution, and the
  savings/debt-group toggle pattern.
- `04-age55-toggles.js` / `05-age55-insurance-medical.js` — Age 55 support
  across all 3 simulation models and the Budget tab, plus the "only apply /
  include at future ages" toggles (gifts, insurance, medical, smoking
  supplies).
- `06-expense-breakdown-yearly.js` — the Expense Breakdown hover (escalated,
  not today's-$, sub-item amounts) and the Yearly Expense Summary sub-tab.
- `07-cashflow-alignment.js` / `08-colspan-structure.js` — the Year-by-Year
  table's Cash Flow detail row aligns with the right column and the table's
  colspans stay structurally sound.
- `09-functional-smoke.js` — a broad sweep: budget hover, a big-portfolio
  live sim, the no-double-shoveling invariant, Emergency Fund as last
  resort, the DB pension toggle, and chart datasets.
- `10-rerun-retirement-coldstart.js` — the Tier 1b fix: CPI-rate and
  growth-rate edits take effect even when no live simulation exists yet
  (previously a silent no-op), while default display and the already-live
  path stay provably unchanged.
- `11-tier2-datasource-sanity.js` — the "Live simulation" vs "Reference
  data" badge, and the simulation sanity-check warning banner (fires when
  it should, stays silent under normal use).
- `12-monte-carlo.js` — Tier 3 sequence-of-returns risk: the Monte Carlo
  engine (zero-stdev reproduces the deterministic path exactly, percentile
  bands stay ordered p10≤p50≤p90, success rate responds to a stressed
  scenario, no side effects on liveData/currentAge) and the opt-in UI panel
  on the Retirement Income tab (off by default, running it doesn't touch the
  deterministic chart/table, re-running doesn't leak chart instances).
- `13-withdrawal-rate.js` — the WR% column and "Portfolio WR" summary stat's
  formula: numerator is LIF+RRIF+TFSA+Non-Reg draws (was LIF+RRIF only),
  same starting-total-portfolio denominator, DB/QPP/OAS still excluded.
  Confirms the new formula actually changes the displayed number when TFSA/
  Non-Reg get drawn, matches every rendered cell exactly, and leaves an
  all-registered scenario (no TFSA/Non-Reg draws) unaffected. Also covers
  the collapsible per-account WR% breakdown (click a row's WR% cell): each
  account's own contribution shows up only when it was actually drawn that
  year, sums back to the cell's own total, and a surplus year (nothing
  drawn) shows a plain "no portfolio withdrawal" note instead of a
  misleading blank line.
- `14-nonreg-tax-realism.js` — Tier 3 "Realistic tax modeling (beta)" for the
  Non-Registered account (Accumulation tab, opt-in, off by default).
  Confirms `_nonregMix()` normalizes composition inputs to fractions summing
  to 1 no matter what the raw % inputs add up to; confirms the toggle being
  OFF fully insulates the simulation from the new mix/pretax-return/start-
  gain inputs (changing them has zero effect until the box is checked);
  confirms a 100%-growth composition has zero annual tax drag in both resident
  and PH modes (deferred gains are never taxed annually); confirms resident
  mode taxes Canadian eligible dividends and interest annually,
  with dividends taxed less than interest (real gross-up/DTC mechanics) at
  both a low and a high stacking income; confirms PH (non-resident) mode
  taxes dividends/interest at a flat 25% and leaves foreign income/growth at
  $0 Canadian tax; confirms the ACB-based capital-gains-on-withdrawal tax
  only fires in resident mode, only when the toggle is on, and only when there's
  a real embedded gain (0% starting gain -> $0 extra tax); confirms that tax
  bill gets paid from TFSA (then Emergency Fund) the same way any other
  spending need would be, so a real cap-gains tax doesn't register as a
  phantom shortfall while those accounts still have room — and confirms it
  still becomes a genuine shortfall when there's truly no TFSA/Emergency
  Fund buffer left to cover it; confirms `computeEstate()`'s death-tax is a
  real marginal-rate-based number in resident mode and always $0 in PH mode; and
  confirms the UI (checkbox reveals the composition panel, the
  composition-sum warning fires/clears, and the toggle plus composition
  values persist across a reload).
- `15-storage-consolidation.js` — the localStorage namespacing/consolidation:
  ~41 scattered `localStorage` call sites across ~20 top-level keys were
  folded into one `plannerState` key (an in-memory-cached
  `{v, ret, acc, budget, nav}` object, accessed everywhere through
  `_stateGet`/`_stateSet`/`_stateSetMany`), with a one-time
  `_migrateLegacyStorageIfNeeded()` that runs old scattered keys into the
  new shape on first load. Confirms a browser with real old-scheme data
  (every old top-level key, including the two already-consolidated
  `accState`/`budgetData` JSON blobs) migrates correctly into the unified
  key and restores identically — spend mode, QPP/OAS start ages, retirement
  age, growth/CPI rates, target-income bands, DB pension and realistic-tax
  toggles, the Accumulation-tab fields, the active tab, the Budget sub-tab,
  the income-age selector, budget line items, and which budget groups are
  collapsed; confirms the ~20 old top-level keys are removed afterward,
  while even-older legacy fallback tiers those keys themselves used to fall
  back to (`accEndMonth`/`accEndYear`-style per-field ACC_PERSIST_IDS keys,
  `budgetData_pre`/`_post`, `budgetCollapsed_pre`) are left completely
  untouched, since other functions still read those directly as their own
  separate, already-working fallback tier; confirms a completely fresh
  browser (no keys at all) loads without error and that the migration's
  "nothing to migrate" guard doesn't write a premature empty `plannerState`
  blob; and confirms `_stateGet`/`_stateSet`/`_stateSetMany` round-trip
  correctly and survive a full page reload.
- `16-historical-bootstrap.js` — the deferred half of the sequence-of-
  returns-risk item: a second Monte Carlo return model that resamples a
  real S&P 500 annual-return series (1926-2025, 100 years, includes
  dividends) in 5-year consecutive blocks instead of drawing from a Normal
  distribution, so simulated paths inherit real fat tails, autocorrelation,
  and crash/recovery timing. Confirms the dataset itself (exactly 100
  years, known crash/recovery years match the real S&P 500 record, the
  computed historical mean/stdev are plausible long-run equity figures);
  `_mean`/`_stdevSample` against a known textbook example; `_blockBootstrapShocks`'s
  exact block mechanics under a mocked `Math.random` (consecutive real
  years starting at the sampled index, and wraparound to the start of the
  series instead of running off the end); `runMonteCarloSim`'s new
  `returnModel` option (defaults to `'normal'`, byte-for-byte unchanged from
  before this feature existed; `'historical'` is echoed back and reports
  the real dataset mean/stdev for reference; a zero-stdev historical run
  reproduces the deterministic totals exactly, the same invariant the
  Normal model already satisfied; a real-variance run keeps percentile
  bands correctly ordered and produces a plausible success rate; no side
  effects on `liveData`/`currentAge`); and the UI (return-model dropdown
  defaults to Normal, selecting Historical reveals a reference note showing
  the dataset's real mean/stdev without touching the mean/stdev inputs
  themselves, the success-rate readout labels which model actually ran,
  running it doesn't alter the deterministic Year-by-Year table, and
  switching back to Normal drops the historical label again).

- `17-account-toggles-header-tooltips.js` — two features from the same pass:
  (1) Accumulation-tab "Include this account" toggles for RRSP, TFSA, FHSA,
  DC and Non-Reg, mirroring the existing DB Pension include/exclude
  checkbox. Confirms every toggle defaults to checked; unchecking one zeroes
  it out of every year in `lastAccRows` while leaving its saved field values
  untouched and visually dimming its card; re-checking restores normal
  growth; excluding an account still shows exactly $0 even when another
  account's contribution-cap overflow or the FHSA→RRSP rollover would
  otherwise route money into it (the `runAcc()` force-zero safety net); and
  the toggle state (including the visual dim) survives a page reload.
  (2) Year-by-Year Withdrawal Breakdown header tooltips: every column
  header that previously had no `title` (Year, Age, DB, LIF, RRIF, QPP,
  OAS, Taxable, Tax, Clawbk, TFSA, Income, Target, Cash Flow, Gap) now has
  one, and the headers that already had tooltips (WR%, Budget, the Bal→
  columns) are confirmed unchanged.
- `18-tab-switch-live-refresh.js` — bug fix: editing the Budget tab, or
  toggling an Accumulation account, while the Retirement Income tab was
  hidden updated the underlying data but never re-rendered that tab, and
  simply switching back to it (as opposed to clicking an age or spend-mode
  button, which call `renderAll()` explicitly) left it showing stale
  numbers — `showTab('ret')` previously only rendered the very first time
  it was shown per page load (`if (t==='ret' && !incomeChart)`). Fixed by
  having `showTab('ret')` always tear down and re-render. Confirms, with NO
  intervening age/mode click: a Budget-tab rent edit changes the Year-by-
  Year table's Budget column immediately on switching to the Retirement tab;
  and excluding a (real, non-zero-balance) Non-Reg account via its "Include
  this account" checkbox — clicked, not scripted, so the real debounced
  auto-save/`runAcc()` wiring actually fires — removes it from the Starting
  Portfolio card immediately on switching tabs, with no other action needed.

## Adding a new test

Copy the pattern in any existing file: `require('./lib')`, call
`openApp(process.argv[2])` to get `{ browser, page, consoleErrors }`, drive
the page with `page.evaluate(...)` the same way a person would (dispatch
real `input`/`change` events rather than poking internal state directly,
where practical), collect `check(name, condition)` results, and finish with
`finish(browser, ok)`. Give the file the next available two-digit prefix so
`run-all.js` picks it up and runs it in a sensible order.

One gotcha worth knowing: if you ever see `ReferenceError: <something> is
not defined` for a variable you can plainly see declared with `let` at the
top level of the app's script, the actual cause is almost always that
Chart.js failed to load (network blocked, or `node_modules/chart.js` missing
here) — the app's own script throws partway through its startup IIFE when
`Chart` is undefined, which silently aborts the rest of that `<script>`
tag's execution, so every `let`/`const`/`function` declared later in the
file never actually runs. Run `npm install` in this folder first if you hit
this.

## Keeping this suite alive

This suite exists so that "does this still work" is a 30-second run instead
of rebuilding a Playwright harness from scratch every session. When you add
a feature or fix a bug, add or update a test for it here in the same pass —
that's the whole point.
