'use strict';
// "Long-form currency values by default, with a short-form toggle" (JP,
// named alongside "CPP/QPP & OAS start-age slider" and "CPP/QPP box: show %
// of maximum @ age 65" as the next three roadmap items). Origin (from the
// backlog table): "Stop abbreviating dollar values (e.g. '30K'). Add a
// Profile option to enable the short form; by default, show the long form
// ($30,000, not $30K). Needs finding every abbreviated spot and threading a
// toggle through; readability win everywhere."
//
// Investigation before building found the abbreviation lived in 4 named
// formatter functions (fK, fKint, fKacc, and a local fK1 const) plus ~15
// scattered inline `(v/1000).toFixed()+'K'`/`/1e6...M` spots with no shared
// helper at all -- and, separately, that a few spots (fBud, fInt, fmt) were
// ALREADY long-form (comma-separated, never abbreviated), meaning the app
// had two inconsistent dollar-formatting behaviors depending on which tab
// you were looking at.
//
// Confirmed with JP (AskUserQuestion) before building:
//  1. Scope: the new toggle applies APP-WIDE, not just to the spots that
//     used to abbreviate -- flipping to short-form also compacts the
//     Budget/Tax Breakdown tabs' formerly-always-long-form displays, so the
//     whole app has one consistent formatting behavior either way.
//  2. Short-form style: keep one decimal and introduce 'M' for millions
//     ($30.0K, $1.2M) rather than the old inconsistent mix (some spots were
//     whole-number-only, one spot used 2-decimal millions).
//
// Built: a single `_fmtMoney(v)` function is now the ONLY place currency
// formatting logic lives. Every named formatter (fK/fKint/fKacc/fBud, and
// the local fInt/fmt/fK1 consts) was reduced to a thin wrapper delegating to
// it (preserving each one's own special-casing, e.g. fK's "—" for non-
// positive values), and every one of the ~15 raw inline patterns was
// replaced with a direct `_fmtMoney()` call -- removing the duplication as
// a bonus, not just fixing the abbreviation-by-default problem. A real,
// separate pre-existing bug was also found and fixed along the way: one
// spot in the age-summary card's Portfolio line had a literal "$" placed
// directly in front of a call to fKint() (which itself already returns a
// leading "$"), producing a visible "$$500K"-style double dollar sign --
// harmless-looking short-form output hid it, but it would have been glaring
// once that value started rendering in long form.
//
// Chart TOOLTIPS (which behave like a data readout, e.g. hovering a bar to
// see its exact value) were wired to the toggle too, for consistency with
// "apply everywhere." Chart AXIS TICK labels were deliberately left ALWAYS
// abbreviated regardless of the toggle -- an axis is space-constrained and
// every mainstream charting convention (Excel, Sheets, etc.) abbreviates
// axis labels regardless of how the surrounding dashboard formats numbers
// elsewhere; this was a judgment call, flagged to JP rather than silently
// assumed away.
//
// This test's central concerns: (1) _fmtMoney() itself is correct for long
// form (commas, no decimals, negative sign), short form (one decimal,
// K under $1M / M at $1M+), and zero; (2) every wrapper function still
// carries its own historical special-casing (fK's dash-for-non-positive)
// while now being toggle-aware; (3) the Profile-tab checkbox exists,
// defaults unchecked (long-form default), and toggling it flips live
// output immediately for already-rendered content (the Retirement Income
// summary card) as well as tabs that don't auto-refresh on tab-switch
// (Accumulation, Budget); (4) chart tooltip callbacks respect the toggle
// while axis tick callbacks never do; (5) the choice persists across a
// reload; and (6) the specific "$$" double-dollar-sign bug found during
// this work is actually fixed.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Default state: long-form, checkbox unchecked. ----
  const t0 = await page.evaluate(() => ({
    checked: document.getElementById('currencyShortForm')?.checked,
    isShort: typeof _isCurrencyShortForm === 'function' ? _isCurrencyShortForm() : null,
  }));
  check('Currency format checkbox exists on the Profile tab', t0.checked !== undefined);
  check('Long-form is the default (checkbox starts unchecked)', t0.checked === false);
  check('_isCurrencyShortForm() agrees the default is long-form', t0.isShort === false);

  // ---- _fmtMoney(): long-form correctness. ----
  const t1 = await page.evaluate(() => ({
    thousands: _fmtMoney(30000),
    millions: _fmtMoney(1234567),
    negative: _fmtMoney(-4500),
    zero: _fmtMoney(0),
    small: _fmtMoney(500),
  }));
  check('_fmtMoney: long-form thousands has commas, no decimals ($30,000)', t1.thousands === '$30,000');
  check('_fmtMoney: long-form millions has commas, no decimals ($1,234,567)', t1.millions === '$1,234,567');
  check('_fmtMoney: long-form negative gets a leading minus before the $ (-$4,500)', t1.negative === '-$4,500');
  check('_fmtMoney: zero renders as $0, not blank or NaN', t1.zero === '$0');
  check('_fmtMoney: small values under $1,000 still get the $ prefix ($500)', t1.small === '$500');

  // ---- _fmtMoney(): short-form correctness (one decimal, K under $1M, M at
  // $1M+ -- JP's confirmed style). ----
  const t2 = await page.evaluate(() => {
    document.getElementById('currencyShortForm').checked = true;
    onCurrencyFormatChange();
    return {
      thousands: _fmtMoney(30000),
      millions: _fmtMoney(1234567),
      negative: _fmtMoney(-4500),
      small: _fmtMoney(500),
      exactlyOneMillion: _fmtMoney(1000000),
    };
  });
  check('_fmtMoney: short-form thousands keeps one decimal ($30.0K)', t2.thousands === '$30.0K');
  check('_fmtMoney: short-form millions uses M with one decimal ($1.2M)', t2.millions === '$1.2M');
  check('_fmtMoney: short-form negative still gets a leading minus (-$4.5K)', t2.negative === '-$4.5K');
  check('_fmtMoney: short-form sub-$1,000 values still show K, not a bare number ($0.5K)', t2.small === '$0.5K');
  check('_fmtMoney: exactly $1,000,000 crosses over to M, not K ($1.0M)', t2.exactlyOneMillion === '$1.0M');

  // ---- Named wrapper functions: toggle-aware, but each keeps its own
  // historical special-casing. ----
  const t3 = await page.evaluate(() => ({
    fK_short: fK(500),
    fK_zero: fK(0),      // fK's own special case: non-positive -> em dash
    fK_negative: fK(-50),
    fKint_short: fKint(123456),
    fKacc_short: fKacc(123456),
    fBud_short: fBud(-2500),
  }));
  check('fK(): non-positive still renders as an em dash, even in short-form mode (unchanged special case)', t3.fK_zero === '—' && t3.fK_negative === '—');
  check('fK(): a positive value is toggle-aware short-form ($0.5K)', t3.fK_short === '$0.5K');
  check('fKint() is toggle-aware ($123.5K in short-form)', t3.fKint_short === '$123.5K');
  check('fKacc() is toggle-aware and matches fKint() (same underlying formatter)', t3.fKacc_short === t3.fKint_short);
  check('fBud() is toggle-aware and keeps its negative-sign handling (-$2.5K)', t3.fBud_short === '-$2.5K');

  // Back to long-form for the rest of the test.
  const t4 = await page.evaluate(() => {
    document.getElementById('currencyShortForm').checked = false;
    onCurrencyFormatChange();
    return {
      fK: fK(500),
      fKint: fKint(123456),
      fBud: fBud(-2500),
    };
  });
  check('fK() reverts to long-form ($500)', t4.fK === '$500');
  check('fKint() reverts to long-form ($123,456)', t4.fKint === '$123,456');
  check('fBud() reverts to long-form (-$2,500)', t4.fBud === '-$2,500');

  // ---- Toggling immediately updates an ALREADY-rendered Retirement Income
  // summary card (proves the toggle doesn't require a manual re-render or
  // tab switch to take visible effect where the app can refresh eagerly). ----
  await page.evaluate(() => { showTab('ret'); document.querySelector('.age-btn[data-age="62"]').click(); renderAll(62); });
  const beforeToggle = await page.evaluate(() => document.getElementById('ageSummary').innerText);
  const t5 = await page.evaluate(() => {
    document.getElementById('currencyShortForm').checked = true;
    onCurrencyFormatChange();
    return document.getElementById('ageSummary').innerText;
  });
  check('Retirement Income summary card was showing long-form dollar amounts before the toggle', /\$[\d,]{4,}/.test(beforeToggle));
  check('flipping the toggle changes the already-rendered summary card text', beforeToggle !== t5);
  check('the summary card now shows short-form (K-suffixed) dollar amounts', /\$[\d.]+K/.test(t5));

  // ---- Accumulation and Budget tabs (which do NOT auto-refresh on every
  // tab-switch the way Retirement/Tax Breakdown/Report do) also pick up a
  // toggle flip immediately, via the explicit refresh in
  // onCurrencyFormatChange(), rather than showing stale formatting until an
  // unrelated input happens to re-render them. ----
  const t6 = await page.evaluate(() => {
    document.getElementById('currencyShortForm').checked = false;
    onCurrencyFormatChange();
    showTab('acc');
    runAcc(); // ensure lastAccRows exists so the toggle handler has something to refresh
    const accBefore = document.getElementById('accResults')?.innerHTML || document.getElementById('panelAcc').innerText;
    showTab('budget');
    const budgetBefore = document.getElementById('panelBudget').innerText;
    document.getElementById('currencyShortForm').checked = true;
    onCurrencyFormatChange();
    const accAfter = document.getElementById('accResults')?.innerHTML || document.getElementById('panelAcc').innerText;
    const budgetAfter = document.getElementById('panelBudget').innerText;
    return { accBefore, accAfter, budgetBefore, budgetAfter };
  });
  check('Accumulation tab content changes format immediately on toggle (no re-render needed manually)', t6.accBefore !== t6.accAfter);
  check('Budget tab content changes format immediately on toggle (no re-render needed manually)', t6.budgetBefore !== t6.budgetAfter);

  // Reset to long-form before the remaining checks.
  await page.evaluate(() => { document.getElementById('currencyShortForm').checked = false; onCurrencyFormatChange(); });

  // ---- Chart tooltips respect the toggle; chart axis ticks never do
  // (deliberate -- axis labels stay compact regardless, a judgment call
  // flagged to JP rather than assumed silently). ----
  await page.evaluate(() => { showTab('ret'); renderAll(62); });
  const t7 = await page.evaluate(() => {
    const longTooltip = incomeChart.options.plugins.tooltip.callbacks.label({ dataset: { label: 'DB' }, parsed: { y: 12345 } });
    const longAxis = incomeChart.options.scales.y.ticks.callback(12345);
    document.getElementById('currencyShortForm').checked = true;
    onCurrencyFormatChange();
    showTab('ret');
    renderAll(62);
    const shortTooltip = incomeChart.options.plugins.tooltip.callbacks.label({ dataset: { label: 'DB' }, parsed: { y: 12345 } });
    const shortAxis = incomeChart.options.scales.y.ticks.callback(12345);
    return { longTooltip, longAxis, shortTooltip, shortAxis };
  });
  check('income chart tooltip is long-form when the toggle is off', t7.longTooltip.includes('$12,345'));
  check('income chart tooltip switches to short-form when the toggle is on', t7.shortTooltip.includes('$12.3K'));
  check('income chart Y-axis tick stays abbreviated with the toggle OFF (axis labels are always compact)', t7.longAxis === '$12K');
  check('income chart Y-axis tick stays abbreviated with the toggle ON too (unchanged either way)', t7.shortAxis === '$12K');
  check('the axis tick format is identical regardless of the toggle (by design)', t7.longAxis === t7.shortAxis);

  // Reset to long-form.
  await page.evaluate(() => { document.getElementById('currencyShortForm').checked = false; onCurrencyFormatChange(); });

  // ---- The "$$" double-dollar-sign bug found and fixed along the way: the
  // age-summary card's Portfolio line used to read literal `$${fKint(...)}`
  // -- a hardcoded $ immediately followed by fKint()'s own already-$-
  // prefixed output. ----
  const t8 = await page.evaluate(() => {
    showTab('ret');
    renderAll(62);
    return document.getElementById('ageSummary').innerHTML;
  });
  check('no double dollar sign ($$) anywhere in the Retirement Income summary card (the bug this work fixed)', !t8.includes('$$'));

  // ---- Persistence across a reload. ----
  await page.evaluate(() => { document.getElementById('currencyShortForm').checked = true; onCurrencyFormatChange(); });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const t9 = await page.evaluate(() => ({
    checked: document.getElementById('currencyShortForm')?.checked,
    isShort: _isCurrencyShortForm(),
    sample: _fmtMoney(30000),
  }));
  check('short-form choice survives a reload (checkbox)', t9.checked === true);
  check('short-form choice survives a reload (actual formatting behavior)', t9.isShort === true && t9.sample === '$30.0K');

  // Leave the app in its default state for whichever test runs next.
  await page.evaluate(() => { document.getElementById('currencyShortForm').checked = false; onCurrencyFormatChange(); });

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0, 5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
