'use strict';
// Budget tab core logic: the Target-column income lookup, the CPI
// escalation factor, income/bonus field capture, computeBudgetTotals /
// computeDisplayTotals (including the debt-group exclude-by-default
// behavior), the save/load round trip, legacy pre/post migration, and
// _budgetColAges. Runs against the REAL page and REAL DOM/localStorage
// (via page.evaluate) rather than a hand-rolled fake-DOM sandbox, so it can
// never drift out of sync with the actual file the way an extracted source
// snippet could.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);

  const results = await page.evaluate(() => {
    const out = [];
    const check = (name, cond) => out.push({ name, pass: !!cond });
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input')); } };

    // ── Test 1: Target-column formula ──────────────────────────────────
    (function () {
      currentAge = 62;
      const expected65 = Math.round(75000 * Math.pow(1 + _cpiRate(), 65 - _personAge()));
      check('matches Target-column formula for age65 (tgt65 band x CPI factor)', _budgetIncomeForAge(65) === expected65);
      check('age below ra returns null', _budgetIncomeForAge(60) === null);
    })();

    // ── Test 2: live-editable — reflects whatever TARGET_INCOME (the
    // 2026-09-11 per-year click-to-edit table, replacing the old tgt60-80
    // DOM bands) says for that age ──
    (function () {
      const orig = TARGET_INCOME[65];
      TARGET_INCOME[65] = 91000;
      const expected = Math.round(91000 * Math.pow(1 + _cpiRate(), 65 - _personAge()));
      check('picks up a live edit to age 65\'s target, not a stale cached figure', _budgetIncomeForAge(65) === expected);
      TARGET_INCOME[65] = orig;
    })();

    // ── Test 3: escalation factor math ─────────────────────────────────
    (function () {
      check('factor=1 when age is null (current mode)', _budgetEscalationFactor(null) === 1);
      const f = _budgetEscalationFactor(65);
      const expected = Math.pow(1 + _cpiRate(), 65 - _personAge());
      check('factor matches Math.pow(1+cpi, years)', Math.abs(f - expected) < 1e-9);
    })();

    // ── Test 4: income field input guarded by mode ─────────────────────
    (function () {
      _stateSet('budget', 'incomeAge', 'current');
      setVal('bud_incMain_amt', '5000');
      const freqEl = document.getElementById('bud_incMain_freq'); if (freqEl) { freqEl.value = 'monthly'; freqEl.dispatchEvent(new Event('change')); }
      setVal('bud_incBonus_amt', '1000');
      const bfreqEl = document.getElementById('bud_incBonus_freq'); if (bfreqEl) { bfreqEl.value = 'annual'; bfreqEl.dispatchEvent(new Event('change')); }
      onBudgetIncomeFieldInput();
      onBudgetBonusFieldInput();
      check('income data captured while mode=current', _budgetIncomeData.amt === 5000 && _budgetIncomeData.freq === 'monthly');
      check('bonus data captured while mode=current', _budgetBonusData.amt === 1000 && _budgetBonusData.freq === 'annual');

      _stateSet('budget', 'incomeAge', '65-69');
      setVal('bud_incMain_amt', '999999');
      onBudgetIncomeFieldInput();
      check('income data NOT overwritten when mode is a future age', _budgetIncomeData.amt === 5000);
      _stateSet('budget', 'incomeAge', 'current');
    })();

    // ── Test 5: computeBudgetTotals / computeDisplayTotals + debt exclusion ──
    (function () {
      const savedEnabled = JSON.parse(JSON.stringify(_budgetSavingsEnabled));
      _budgetSavingsEnabled.savRetirement = false; _budgetSavingsEnabled.savEducation = false; _budgetSavingsEnabled.debt = false;
      _stateSet('budget', 'incomeAge', 'current');
      _budgetIncomeData = { amt: 6000, freq: 'monthly' };
      _budgetBonusData = { amt: 0, freq: 'monthly' };
      setVal('bud_houseRent_amt', '1500');
      setVal('bud_debtCC_amt', '300');

      const raw = computeBudgetTotals();
      check('raw income = 6000 (current mode)', raw.incomeTotal === 6000);
      check('raw debt group = 300', raw.groupTotals.debt === 300);

      let disp = computeDisplayTotals();
      check('display factor=1 in current mode', disp.factor === 1);
      check('debt included (unescalated) in current mode', disp.groupTotals.debt === 300);

      _stateSet('budget', 'incomeAge', '65-69');
      disp = computeDisplayTotals();
      const expectedFactor = _budgetEscalationFactor(65);
      check('display factor matches escalation for age 65', Math.abs(disp.factor - expectedFactor) < 1e-9);
      check('housing escalates by factor', Math.abs(disp.groupTotals.housing - 1500 * expectedFactor) < 1e-6);
      check('debt group excluded by default at a future age (toggle unchecked)', disp.groupTotals.debt === 0);
      check("income uses projected value (not today's manual entry)", disp.incomeTotal !== 6000);

      _budgetSavingsEnabled.debt = true;
      disp = computeDisplayTotals();
      check('debt group included but stays flat (unescalated) once its toggle is checked', disp.groupTotals.debt === 300);

      Object.assign(_budgetSavingsEnabled, savedEnabled);
      _stateSet('budget', 'incomeAge', 'current');
    })();

    // ── Test 6: save/load round trip ───────────────────────────────────
    (function () {
      _budgetIncomeData = { amt: 7777, freq: 'monthly' };
      _budgetBonusData = { amt: 222, freq: 'annual' };
      setVal('bud_houseRent_amt', '1500');
      setVal('bud_debtCC_amt', '300');
      setVal('bud_debtCC_bal', '4000');
      setVal('bud_debtCC_rate', '19.99');
      saveBudget();
      const raw = _stateGet('budget', 'data', null);
      check('saveBudget persisted income data', raw._income.amt === 7777);
      check('saveBudget persisted a regular item', raw.houseRent.amt === 1500);
      check('saveBudget persisted debt balance/rate', raw.debtCC.bal === 4000 && raw.debtCC.rate === 19.99);

      loadBudget();
      check('loadBudget restored income data', _budgetIncomeData.amt === 7777);
      check('loadBudget restored bonus data', _budgetBonusData.amt === 222 && _budgetBonusData.freq === 'annual');
      check('loadBudget restored regular item into DOM', document.getElementById('bud_houseRent_amt').value === '1500');
      check('loadBudget restored debt balance into DOM', document.getElementById('bud_debtCC_bal').value === '4000');
    })();

    // ── Test 7: _budgetColAges start-at-retirement-age behavior ────────
    (function () {
      // ra=55 includes 55 itself (added with the Age 55 retirement feature) —
      // matches pw_age55_toggles.js's own "_budgetColAges(55)" assertion.
      check('ra=55 -> includes 55 itself, then full milestones', JSON.stringify(_budgetColAges(55)) === JSON.stringify([55, 60, 65, 70, 75, 80, 85]));
      check('ra=63 -> unshifts 63 then remaining milestones >=63', JSON.stringify(_budgetColAges(63)) === JSON.stringify([63, 65, 70, 75, 80, 85]));
      check('ra=68 -> unshifts 68 then remaining milestones >=68', JSON.stringify(_budgetColAges(68)) === JSON.stringify([68, 70, 75, 80, 85]));
      check('ra=85 -> just [85]', JSON.stringify(_budgetColAges(85)) === JSON.stringify([85]));
    })();

    // ── Test 8: _budgetRefreshIncomeRow DOM sync ───────────────────────
    (function () {
      currentAge = 62;
      _budgetIncomeData = { amt: 4321, freq: 'monthly' };
      _budgetBonusData = { amt: 0, freq: 'monthly' };
      _stateSet('budget', 'incomeAge', 'current');
      _budgetRefreshIncomeRow();
      check('current mode: income field editable + shows manual value', document.getElementById('bud_incMain_amt').value === '4321' && document.getElementById('bud_incMain_amt').readOnly === false);

      _stateSet('budget', 'incomeAge', '65-69');
      _budgetRefreshIncomeRow();
      const expected65 = Math.round(75000 * Math.pow(1 + _cpiRate(), 65 - _personAge()));
      check('future age mode: income field readonly', document.getElementById('bud_incMain_amt').readOnly === true);
      check('future age mode: income field shows Target-column projected value (tgt65 band x CPI)', document.getElementById('bud_incMain_amt').value === String(expected65));
      check('future age mode: bonus forced to 0 and readonly', document.getElementById('bud_incBonus_amt').value === '0' && document.getElementById('bud_incBonus_amt').readOnly === true);
      _stateSet('budget', 'incomeAge', 'current');
      _budgetRefreshIncomeRow();
    })();

    return out;
  });

  let pass = 0, fail = 0;
  results.forEach(r => { if (r.pass) pass++; else { fail++; console.error('FAIL:', r.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
