'use strict';
// Bug report (JP): "live calculation between the tabs is not working. when
// modifying the budget, we need to select a different age or model on the
// Retirement Income tab to update it. same thing if we toggle an account
// off, an action in the retirement tab is required before it takes effect."
//
// Root cause: showTab('ret') only called renderAll(currentAge) the FIRST
// time the Retirement Income tab was shown in a session (`if (t==='ret' &&
// !incomeChart) renderAll(...)`), even though renderAll() itself always
// reads fresh data (Budget-tab DOM fields via _budgetTotalsAtAge, the
// Accumulation-tab's lastAccRows/liveData, etc.). Editing the Budget tab or
// toggling an Accumulation account while the Retirement Income tab was
// hidden updated the underlying data but never forced a re-render, and
// simply switching back to that tab (as opposed to clicking an age button
// or a spend-mode button — which DO call renderAll explicitly) left it
// showing stale numbers.
//
// Fix: showTab('ret') now always tears down and re-renders, every time you
// switch to it. This suite drives the exact repro steps from the bug
// report — edit Budget, switch tabs, confirm fresh; toggle an account,
// switch tabs, confirm fresh — with NO intervening age/mode click.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // Land on the Retirement Income tab once first (so incomeChart gets
  // created) — this is what makes the old `!incomeChart` guard start
  // silently no-op-ing on every subsequent switch, which is exactly the
  // failure mode being tested.
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);

  const beforeBudget = await page.evaluate(() => {
    // Row 0 is a "Phase 1: Bridge..." colspan header row, not a data row —
    // grab the first real data-row Budget cell instead.
    const cell = document.querySelector('#mainTable tbody td.col-budget');
    return cell ? cell.textContent.trim() : null;
  });
  check('sanity: Year-by-Year table has rendered rows before the edit', !!beforeBudget);

  // ── Repro 1: edit the Budget tab while NOT on the Retirement tab, then
  // switch back without touching any age/mode control. ────────────────────
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  const budgetEdit = await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    // Push housing rent way up — this must move the Budget/Target columns
    // on the Year-by-Year table once it's visible again.
    return set('bud_houseRent_amt', '9999');
  });
  check('sanity: Budget rent field edit was applied', budgetEdit);
  await page.waitForTimeout(300);

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  const afterBudget = await page.evaluate(() => {
    const cell = document.querySelector('#mainTable tbody td.col-budget');
    return cell ? cell.textContent.trim() : null;
  });
  check('Budget-tab edit is reflected on the Year-by-Year table immediately after switching tabs (no age/mode click needed)',
    afterBudget !== beforeBudget);

  // ── Repro 2: toggle an Accumulation account off while NOT on the
  // Retirement tab, then switch back without touching any age/mode
  // control. Give Non-Reg a real balance first so excluding it is an
  // actual, checkable change (its default opening balance is $0).────────
  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('nrBal', '50000');
    set('nrAnnual', '0');
    set('nrBiweekly', '0');
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  const beforeToggle = await page.evaluate(() => {
    const startCard = document.querySelector('.age-stat[style*="span 2"]');
    return {
      hasNonregNow: !!(lastAccRows && lastAccRows.find(r => r.age === currentAge)?.nr > 0),
      startCardText: startCard ? startCard.textContent : '',
    };
  });
  check('sanity: Non-Reg now has a real balance in lastAccRows for the current age', beforeToggle.hasNonregNow);
  check('sanity: starting-portfolio card shows Non-Reg before excluding it', beforeToggle.startCardText.includes('Non-Reg'));

  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);
  // A real Playwright click (not a scripted `.checked = false` assignment,
  // which doesn't dispatch input/change events) — this is what actually
  // fires the debounced ACC_PERSIST_IDS auto-save/runAcc wiring a real
  // user's click would trigger.
  await page.click('#useNonreg');
  // Let the debounced auto-save/runAcc wiring (300ms) actually fire, same
  // as a real user would experience.
  await page.waitForTimeout(600);

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  const afterToggle = await page.evaluate(() => {
    const startCard = document.querySelector('.age-stat[style*="span 2"]');
    return {
      nrZeroNow: !!(lastAccRows && lastAccRows.find(r => r.age === currentAge)?.nr === 0),
      startCardText: startCard ? startCard.textContent : '',
    };
  });
  check('sanity: excluding Non-Reg actually zeroed it in lastAccRows', afterToggle.nrZeroNow);
  check('excluding a Non-Reg account is reflected on the Retirement Income tab immediately after switching tabs (no age/mode click needed)',
    !afterToggle.startCardText.includes('Non-Reg'));

  check('no console errors across the tab-switch live-refresh scenario', consoleErrors.length === 0);

  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  const ok = fail === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
