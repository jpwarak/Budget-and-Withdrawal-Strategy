'use strict';
// "Pay-raise % option in the Income section" (JP, picked from the
// roadmap's Remaining table). Per JP's confirmed choice (AskUserQuestion):
// display-only preview -- a "Pay raise %/yr" input next to Current Income
// that compounds forward and shows what Income would grow to by the
// selected retirement age. It must NOT feed any other calculation (Budget
// totals, savings rate, computeBudgetTotals, etc. are all unaffected) --
// see _budgetUpdateRaisePreview()'s own doc comment.
//
// Only shown/relevant when the Income row's Age selector is "Current" --
// a future-age bracket is already a full projection from the Retirement
// Income tab, not a raise layered on top of today's salary.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);

  // ---- Default state: Current mode, raise row visible, 0% raise, no
  // preview text yet (0% => nothing to show). ----
  const t0 = await page.evaluate(() => {
    const wrap = document.getElementById('bud_incRaiseWrap');
    const input = document.getElementById('bud_incRaise_pct');
    const note = document.getElementById('bud_incRaiseNote');
    return {
      mode: _budgetIncomeAgeValue(),
      wrapVisible: wrap && wrap.style.display !== 'none',
      inputVal: input ? input.value : null,
      noteEmpty: note ? note.textContent.trim() === '' : null,
    };
  });
  check('Income Age defaults to Current', t0.mode === 'current');
  check('Pay-raise row is visible by default (Current mode)', t0.wrapVisible);
  check('Pay-raise % defaults to 0', Number(t0.inputVal) === 0);
  check('no preview shown at 0% raise', t0.noteEmpty);

  // ---- Set an income + a raise %, check the preview computes the right
  // compounded figure by the currently-selected retirement age. ----
  const t1 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); };
    fill('bud_incMain_amt', 6000); // $6,000/mo, default freq
    fill('bud_incRaise_pct', 3);
    const note = document.getElementById('bud_incRaiseNote').textContent;
    const ra = currentAge;
    const personAge = _personAge();
    const years = Math.max(0, ra - personAge);
    const expected = Math.round(6000 * 12 * Math.pow(1.03, years));
    return { note, ra, years, expected, raisePct: _budgetIncomeData.raisePct, dataAmt: _budgetIncomeData.amt };
  });
  check('_budgetIncomeData.raisePct captures the entered value', t1.raisePct === 3);
  check('_budgetIncomeData.amt is unaffected by the raise field (still the base income)', t1.dataAmt === 6000);
  const noteNum = (t1.note.match(/\$([\d,]+)/) || [])[1]?.replace(/,/g, '') || '';
  check('preview note mentions the selected retirement age', t1.note.includes(String(t1.ra)));
  check('preview note is a "preview only" disclaimer, not a real projection', /preview/i.test(t1.note));
  check(
    `preview note's dollar figure matches the compounded calculation (expected ≈ $${t1.expected.toLocaleString()})`,
    t1.years === 0 || Math.abs(parseInt(noteNum, 10) - t1.expected) <= 1
  );

  // ---- The raise % must NOT leak into any real calculation: Budget
  // totals / income-for-budget stay driven purely by amt+freq. ----
  const t2 = await page.evaluate(() => {
    const rawWithRaise = _budgetIncomeMonthlyRaw();
    const savedRaise = _budgetIncomeData.raisePct;
    _budgetIncomeData.raisePct = 0;
    const rawNoRaise = _budgetIncomeMonthlyRaw();
    _budgetIncomeData.raisePct = savedRaise;
    return { rawWithRaise, rawNoRaise };
  });
  check('the raise %% has zero effect on _budgetIncomeMonthlyRaw() (display-only, not a real calculation input)', t2.rawWithRaise === t2.rawNoRaise);

  // ---- Switching to a future-age bracket hides the raise row and clears
  // the preview; switching back to Current restores both. ----
  const t3 = await page.evaluate(() => {
    const ageSel = document.getElementById('bud_incMain_age');
    const futureOpt = Array.from(ageSel.options).find(o => o.value !== 'current');
    if (!futureOpt) return { skipped: true };
    ageSel.value = futureOpt.value;
    onBudgetIncomeAgeChange();
    const wrapFuture = document.getElementById('bud_incRaiseWrap');
    // Capture the boolean NOW -- wrapFuture is a live DOM node reference,
    // and switching back to Current a few lines below mutates this same
    // node's style.display in place, so reading wrapFuture.style.display
    // later (after the switch-back) would silently observe the CURRENT
    // state instead of the future-bracket state.
    const wrapHiddenAtFuture = wrapFuture.style.display === 'none';
    const noteFuture = document.getElementById('bud_incRaiseNote').textContent;
    ageSel.value = 'current';
    onBudgetIncomeAgeChange();
    const wrapCurrent = document.getElementById('bud_incRaiseWrap');
    const inputCurrent = document.getElementById('bud_incRaise_pct');
    const noteCurrent = document.getElementById('bud_incRaiseNote').textContent;
    return {
      skipped: false,
      wrapHiddenAtFuture,
      noteEmptyAtFuture: noteFuture.trim() === '',
      wrapVisibleBackAtCurrent: wrapCurrent.style.display !== 'none',
      raisePctPreserved: Number(inputCurrent.value) === 3,
      noteRestoredAtCurrent: noteCurrent.trim() !== '',
    };
  });
  if (!t3.skipped) {
    check('raise row hides when a future age bracket is selected', t3.wrapHiddenAtFuture);
    check('preview note clears when a future age bracket is selected', t3.noteEmptyAtFuture);
    check('raise row reappears when switching back to Current', t3.wrapVisibleBackAtCurrent);
    check('the entered raise %% is preserved when switching back to Current', t3.raisePctPreserved);
    check('preview note recomputes when switching back to Current', t3.noteRestoredAtCurrent);
  }

  // ---- Persists across a reload. ----
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  const t4 = await page.evaluate(() => {
    const input = document.getElementById('bud_incRaise_pct');
    const note = document.getElementById('bud_incRaiseNote').textContent;
    return { val: input ? Number(input.value) : null, raisePct: _budgetIncomeData.raisePct, noteNonEmpty: note.trim() !== '' };
  });
  check('pay-raise %% survives a full page reload', t4.val === 3 && t4.raisePct === 3);
  check('preview note is recomputed after reload', t4.noteNonEmpty);

  // ---- A plan saved before this feature existed (no raisePct key at all)
  // defaults cleanly to 0%, not undefined/NaN. ----
  const t5 = await page.evaluate(() => {
    const data = _stateGet('budget', 'data', null) || {};
    if (data._income) delete data._income.raisePct;
    _stateSet('budget', 'data', data);
    loadBudget();
    _budgetRefreshIncomeRow();
    const input = document.getElementById('bud_incRaise_pct');
    return { val: input ? Number(input.value) : null, raisePct: _budgetIncomeData.raisePct };
  });
  check('a pre-existing saved plan with no raisePct key defaults to 0, not NaN/undefined', t5.val === 0 && t5.raisePct === 0);

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0,5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
