'use strict';
// Age 55 retirement-age support (all 3 simulation models + the Budget tab's
// income-age selector) and the "only apply at future ages" / "include at
// future ages" toggle groups (gifts, insurance, medical, smoking supplies).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Age 55 button exists and all 3 models simulate cleanly from it ----
  const age55Info = await page.evaluate(() => {
    const btn = document.querySelector('.age-btn[data-age="55"]');
    return { exists: !!btn };
  });
  check('Age 55 button exists', age55Info.exists);

  await page.evaluate(() => { document.querySelector('.age-btn[data-age="55"]').click(); });
  await page.waitForTimeout(500);
  const afterClick55 = await page.evaluate(() => ({
    currentAge, activeAge: document.querySelector('.age-btn.active')?.dataset.age,
  }));
  check('clicking Age 55 sets currentAge=55', afterClick55.currentAge === 55);
  check('Age 55 button becomes active', afterClick55.activeAge === '55');

  const modelTest = await page.evaluate(() => {
    const results = {};
    ['simulateResidentFixed', 'simulateNonResident', 'simulateNonResidentLump'].forEach(fn => {
      try {
        const rows = window[fn](55, 65, 65);
        results[fn] = {
          rowCount: rows.length, firstAge: rows[0]?.age, lastAge: rows[rows.length - 1]?.age,
          noNaN: !rows.some(r => Object.values(r).some(v => typeof v === 'number' && isNaN(v))),
        };
      } catch (e) { results[fn] = { error: e.message }; }
    });
    return results;
  });
  ['simulateResidentFixed', 'simulateNonResident', 'simulateNonResidentLump'].forEach(fn => {
    const r = modelTest[fn];
    check(`${fn}(55,...) runs without error, age 55-85, no NaN`, !r.error && r.firstAge === 55 && r.lastAge === 85 && r.noNaN);
  });

  // ---- Budget tab: Age dropdown includes a 55-59 bracket when ra=55 ----
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(500);
  const bracketTest = await page.evaluate(() => {
    const sel = document.getElementById('bud_incMain_age');
    return sel ? Array.from(sel.options).map(o => o.value) : [];
  });
  check('Budget income-age dropdown includes 55-59 bracket when ra=55', bracketTest.includes('55-59'));

  // ---- Smoking supplies "Include at future ages" toggle ----
  const smokeToggle = await page.evaluate(() => {
    const chk = document.getElementById('bud_recSmoking_enabled');
    const wrap = document.getElementById('bud_recSmoking_togglewrap');
    return { chkExists: !!chk, wrapExists: !!wrap };
  });
  check('Smoking supplies toggle checkbox + wrap exist', smokeToggle.chkExists && smokeToggle.wrapExists);

  await page.evaluate(() => {
    const amtEl = document.getElementById('bud_recSmoking_amt');
    amtEl.value = 100; amtEl.dispatchEvent(new Event('input'));
    const ageSel = document.getElementById('bud_incMain_age');
    ageSel.value = '60-64'; ageSel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const smokeExcluded = await page.evaluate(() => computeDisplayTotals().groupTotals['recreation']);

  await page.evaluate(() => {
    const chk = document.getElementById('bud_recSmoking_enabled');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const smokeIncluded = await page.evaluate(() => computeDisplayTotals().groupTotals['recreation']);
  check('smoking supplies excluded by default at a future age, included once toggled (delta ~100 x escalation)', smokeIncluded - smokeExcluded > 50);

  // ---- Gifts/Insurance/Medical "only apply at future ages" (excl-current) ----
  await page.evaluate(() => {
    const ageSel = document.getElementById('bud_incMain_age');
    ageSel.value = 'current'; ageSel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const exclCurExists = await page.evaluate(() => ['gifts', 'insurance', 'medical'].every(id => !!document.getElementById(`bud_${id}_exclcur`)));
  check('exclude-current toggles exist for gifts/insurance/medical', exclCurExists);

  await page.evaluate(() => {
    const amtEl = document.getElementById('bud_giftGifts_amt');
    amtEl.value = 50; amtEl.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  const giftsBefore = await page.evaluate(() => computeDisplayTotals().groupTotals['gifts']);
  check('gifts included at Current by default', giftsBefore === 50);

  await page.evaluate(() => {
    const chk = document.getElementById('bud_gifts_exclcur');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const giftsAfter = await page.evaluate(() => computeDisplayTotals().groupTotals['gifts']);
  check('gifts excluded at Current once "only apply at future ages" is checked', giftsAfter === 0);

  await page.evaluate(() => {
    const ageSel = document.getElementById('bud_incMain_age');
    ageSel.value = '60-64'; ageSel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const giftsFuture = await page.evaluate(() => computeDisplayTotals().groupTotals['gifts']);
  check('gifts still fully included at a future age regardless of the toggle', giftsFuture > 0);

  // ---- Persistence round trip ----
  const persistTest = await page.evaluate(() => {
    saveBudget();
    const parsed = _stateGet('budget', 'data', null);
    return { hasExcludeCurrent: !!parsed._excludeCurrentEnabled, giftsEnabled: parsed._excludeCurrentEnabled?.gifts, hasSmokingInSavingsEnabled: 'recSmoking' in (parsed._savingsEnabled || {}) };
  });
  check('persists _excludeCurrentEnabled', persistTest.hasExcludeCurrent && persistTest.giftsEnabled === true);
  check('persists recSmoking under _savingsEnabled', persistTest.hasSmokingInSavingsEnabled);

  // ---- _budgetColAges regression across ages ----
  const colAges = await page.evaluate(() => ({ a55: _budgetColAges(55), a60: _budgetColAges(60), a62: _budgetColAges(62) }));
  check('_budgetColAges(55) includes 55 itself', JSON.stringify(colAges.a55) === JSON.stringify([55, 60, 65, 70, 75, 80, 85]));
  check('_budgetColAges(60) unaffected (regression)', JSON.stringify(colAges.a60) === JSON.stringify([60, 65, 70, 75, 80, 85]));
  check('_budgetColAges(62) unaffected (regression)', JSON.stringify(colAges.a62) === JSON.stringify([62, 65, 70, 75, 80, 85]));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
