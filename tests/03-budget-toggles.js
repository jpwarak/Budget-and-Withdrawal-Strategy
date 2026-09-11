'use strict';
// Budget tab bracket resolution and the "exclude by default at a future
// age, include once its toggle is checked" pattern -- for both a single
// savings item (savRetirement) and a whole expense group (debt). Runs
// against the real page/DOM, same rationale as 02-budget-core.js.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  // Warm-up: a real input event, so the Budget tab's dynamically-generated
  // form fields exist before the test touches them directly.
  await page.evaluate(() => {
    const el = document.getElementById('bud_houseRent_amt');
    if (el) { el.value = 1000; el.dispatchEvent(new Event('input')); }
  });
  await page.waitForTimeout(200);

  const results = await page.evaluate(() => {
    const out = [];
    const check = (name, cond) => out.push({ name, pass: !!cond });
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input')); } };

    // ── Bracket resolution ─────────────────────────────────────────────
    (function () {
      currentAge = 62;
      const brackets = _budgetIncomeBrackets(62);
      check('brackets exclude 60-64 when ra=62 (bracket ends before ra? no, 60-64 end=64>=ra kept)', brackets.map(b => b.id).join(',') === '60-64,65-69,70-74,75-79,80+');
      check('first bracket (60-64) lookupAge clamps to ra=62', brackets[0].lookupAge === 62);
      check('later brackets keep their own start age', brackets[1].lookupAge === 65);

      currentAge = 68;
      const b2 = _budgetIncomeBrackets(68);
      check('ra=68 drops only 60-64 (65-69 still applies, ra falls inside it)', b2.map(b => b.id).join(',') === '65-69,70-74,75-79,80+');
      check('first remaining bracket (65-69) clamps to ra=68', b2[0].lookupAge === 68);
      check('later bracket (70-74) keeps its own start age', b2[1].lookupAge === 70);

      currentAge = 62;
      _stateSet('budget', 'incomeAge', '65-69');
      check('_budgetActiveAge resolves bracket id to numeric age', _budgetActiveAge() === 65);
      _stateSet('budget', 'incomeAge', '80+');
      check('_budgetActiveAge resolves 80+ bracket', _budgetActiveAge() === 80);
      _stateSet('budget', 'incomeAge', 'current');
      check('_budgetActiveAge returns null for current', _budgetActiveAge() === null);
    })();

    // ── Income lookup matches the Retirement Income tab's Target-column formula ─
    (function () {
      currentAge = 62;
      const expected65 = Math.round(75000 * Math.pow(1 + _cpiRate(), 65 - _personAge()));
      check('age65 matches age 65\'s TARGET_INCOME entry x CPI factor (Target-column formula)', _budgetIncomeForAge(65) === expected65);
      // TARGET_INCOME (the 2026-09-11 per-year click-to-edit table) replaced
      // the old tgt60-80 DOM bands -- a "live override" is now a direct
      // write to that table, same as clicking a Target cell and saving would do.
      const orig70 = TARGET_INCOME[70];
      TARGET_INCOME[70] = 68091;
      const expected70 = Math.round(68091 * Math.pow(1 + _cpiRate(), 70 - _personAge()));
      check('reflects a live override of age 70\'s target', _budgetIncomeForAge(70) === expected70);
      TARGET_INCOME[70] = orig70;
    })();

    // ── Savings toggle: excluded by default at future ages, included once checked ─
    (function () {
      const savedEnabled = JSON.parse(JSON.stringify(_budgetSavingsEnabled));
      currentAge = 62;
      _stateSet('budget', 'incomeAge', 'current');
      _budgetIncomeData = { amt: 6000, freq: 'monthly' };
      _budgetBonusData = { amt: 0, freq: 'monthly' };
      _budgetSavingsEnabled.savRetirement = false; _budgetSavingsEnabled.savEducation = false;
      setVal('bud_savRetirement_amt', '500');
      setVal('bud_savEducation_amt', '200');
      setVal('bud_savEmergency_amt', '100');

      let disp = computeDisplayTotals();
      check('current mode: toggleable savings fully included', disp.savingsTotal === 800);

      _stateSet('budget', 'incomeAge', '65-69');
      disp = computeDisplayTotals();
      check('future age, unchecked: toggleable savings excluded (only emergency=100 counts, scaled by factor)', Math.abs(disp.savingsTotal - 100 * _budgetEscalationFactor(65)) < 1e-6);

      const chk = document.getElementById('bud_savRetirement_enabled');
      if (chk) chk.checked = true;
      onBudgetSavingsToggle('savRetirement');
      check('toggle persisted to _budgetSavingsEnabled', _budgetSavingsEnabled.savRetirement === true);
      disp = computeDisplayTotals();
      const expected = (100 + 500) * _budgetEscalationFactor(65);
      check('future age, savRetirement checked: included again', Math.abs(disp.savingsTotal - expected) < 1e-6);

      Object.assign(_budgetSavingsEnabled, savedEnabled);
      _stateSet('budget', 'incomeAge', 'current');
    })();

    // ── Debt-repayment GROUP toggle: same pattern, for a whole group ────
    (function () {
      const savedEnabled = JSON.parse(JSON.stringify(_budgetSavingsEnabled));
      currentAge = 62;
      _stateSet('budget', 'incomeAge', 'current');
      _budgetIncomeData = { amt: 6000, freq: 'monthly' };
      _budgetBonusData = { amt: 0, freq: 'monthly' };
      _budgetSavingsEnabled.debt = false;
      setVal('bud_debtCC_amt', '300');
      setVal('bud_houseRent_amt', '1000');

      let disp = computeDisplayTotals();
      check('current mode: debt group fully included', disp.groupTotals.debt === 300);

      _stateSet('budget', 'incomeAge', '65-69');
      disp = computeDisplayTotals();
      check('future age, unchecked: debt group excluded entirely', disp.groupTotals.debt === 0);
      check('future age, unchecked: other groups unaffected by the debt toggle', Math.abs(disp.groupTotals.housing - 1000 * _budgetEscalationFactor(65)) < 1e-6);

      const chk = document.getElementById('bud_debt_enabled');
      if (chk) chk.checked = true;
      onBudgetSavingsToggle('debt');
      check('toggle persisted to _budgetSavingsEnabled under the group id', _budgetSavingsEnabled.debt === true);
      disp = computeDisplayTotals();
      check('future age, checked: debt group included and still unescalated', disp.groupTotals.debt === 300);

      _stateSet('budget', 'incomeAge', 'current');
      _budgetRefreshSavingsToggles();
      const wrap = document.getElementById('bud_debt_togglewrap');
      check('wrap hidden in current mode', wrap ? wrap.style.display === 'none' : true);
      _stateSet('budget', 'incomeAge', '65-69');
      _budgetRefreshSavingsToggles();
      check('wrap shown at a future age', wrap ? wrap.style.display === '' : true);
      check('checkbox reflects _budgetSavingsEnabled.debt', document.getElementById('bud_debt_enabled').checked === true);

      Object.assign(_budgetSavingsEnabled, savedEnabled);
      _stateSet('budget', 'incomeAge', 'current');
      _budgetRefreshSavingsToggles();
    })();

    // ── Cost-of-living chart totals respect the same toggles ───────────
    (function () {
      const savedEnabled = JSON.parse(JSON.stringify(_budgetSavingsEnabled));
      currentAge = 62;
      _budgetSavingsEnabled.savRetirement = false; _budgetSavingsEnabled.debt = false;
      setVal('bud_savRetirement_amt', '500');
      setVal('bud_savEmergency_amt', '100');
      setVal('bud_houseRent_amt', '1000');
      setVal('bud_debtCC_amt', '300');
      const r = _budgetTotalsAtAge(65);
      const factor = _budgetEscalationFactor(65);
      check('_budgetTotalsAtAge excludes unchecked toggleable savings AND the unchecked debt group', Math.abs(r.expenseTotal - 1000 * factor) < 1e-6);

      _budgetSavingsEnabled.debt = true;
      const r2 = _budgetTotalsAtAge(65);
      check('_budgetTotalsAtAge includes debt (unescalated) once its toggle is checked', Math.abs(r2.expenseTotal - (1000 * factor + 300)) < 1e-6);

      Object.assign(_budgetSavingsEnabled, savedEnabled);
    })();

    // ── _budgetColAges unaffected by bracket changes ───────────────────
    (function () {
      check('ra=62 col ages', JSON.stringify(_budgetColAges(62)) === JSON.stringify([62, 65, 70, 75, 80, 85]));
    })();

    return out;
  });

  let pass = 0, fail = 0;
  results.forEach(r => { if (r.pass) pass++; else { fail++; console.error('FAIL:', r.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
