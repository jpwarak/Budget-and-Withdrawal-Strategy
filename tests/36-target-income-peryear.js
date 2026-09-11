'use strict';
// Item 7 of the 2026-09-11 batch: replaced the 5 fixed Target Income age-
// bands (tgt60/65/70/75/80) with a per-year click-to-edit table
// (TARGET_INCOME, ages 55-110). Click a year's "Target" cell in the
// Year-by-Year Withdrawal Breakdown table to open a small popover: edit
// that year's value, and optionally check "Copy until age" to bulk-fill the
// same value forward through a chosen end age. Confirmed design (JP):
// editing happens inline in the existing Year-by-Year table (no separate
// widget), the table covers one fixed range (55-110) independent of
// retirement age/horizon, and "copy until age" is a checkbox inside the
// same popover that opens when you click a cell.
//
// The core invariant, same as every prior phase: anyone who never touches
// the new editor sees the exact same numbers as before -- the old bands'
// hardcoded boundaries/fallbacks (60-64:$82K, 65-69:$75K, 70-74:$68K,
// 75-79:$60K, 80+:$55K) are reproduced exactly by _defaultTargetForAge(),
// and a fresh browser's TARGET_INCOME is seeded from that function.
const { openApp } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Fresh browser: TARGET_INCOME reproduces the old bands' exact numbers ----
  const t1 = await page.evaluate(() => ({
    age60: TARGET_INCOME[60], age64: TARGET_INCOME[64], age65: TARGET_INCOME[65],
    age69: TARGET_INCOME[69], age70: TARGET_INCOME[70], age74: TARGET_INCOME[74],
    age75: TARGET_INCOME[75], age79: TARGET_INCOME[79], age80: TARGET_INCOME[80],
    age110: TARGET_INCOME[110],
    getSpendReal60: _getSpendReal(60), getSpendReal65: _getSpendReal(65),
  }));
  check('fresh browser: ages 60-64 default to the old tgt60 band value ($82K)', t1.age60 === 82000 && t1.age64 === 82000);
  check('fresh browser: ages 65-69 default to the old tgt65 band value ($75K)', t1.age65 === 75000 && t1.age69 === 75000);
  check('fresh browser: ages 70-74 default to the old tgt70 band value ($68K)', t1.age70 === 68000 && t1.age74 === 68000);
  check('fresh browser: ages 75-79 default to the old tgt75 band value ($60K)', t1.age75 === 60000 && t1.age79 === 60000);
  check('fresh browser: age 80 and up (incl. 110) default to the old tgt80 band value ($55K)', t1.age80 === 55000 && t1.age110 === 55000);
  check('_getSpendReal() reads straight from TARGET_INCOME', t1.getSpendReal60 === 82000 && t1.getSpendReal65 === 75000);

  // ---- _getSpendReal() clamps ages outside the fixed 55-110 range ----
  const t2 = await page.evaluate(() => ({ below: _getSpendReal(40), above: _getSpendReal(150) }));
  check('_getSpendReal() clamps an age below 55 up to age 55\'s value', t2.below === 82000);
  check('_getSpendReal() clamps an age above 110 down to age 110\'s value', t2.above === 55000);

  // ---- Old bands no longer exist as DOM elements ----
  const t3 = await page.evaluate(() => ({
    tgt60: document.getElementById('tgt60'),
    tgt65: document.getElementById('tgt65'),
    tgt70: document.getElementById('tgt70'),
    tgt75: document.getElementById('tgt75'),
    tgt80: document.getElementById('tgt80'),
  }));
  check('the old tgt60-80 fixed-band inputs are gone from the DOM', !t3.tgt60 && !t3.tgt65 && !t3.tgt70 && !t3.tgt75 && !t3.tgt80);

  // ---- Click-to-edit: clicking a Target cell opens the popover pre-filled
  // with that year's current value, at the correct age ----
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  const t4 = await page.evaluate(() => {
    const cell = document.querySelector('#tableBody td.col-target');
    if (!cell) return { found: false };
    cell.click();
    const pop = document.getElementById('targetEditPopover');
    return {
      found: true,
      visible: pop.style.display !== 'none',
      ageLabel: document.getElementById('targetEditAgeLabel').textContent,
      value: document.getElementById('targetEditValue').value,
    };
  });
  check('a Target cell exists in the Year-by-Year table', t4.found);
  check('clicking a Target cell opens the popover', t4.visible);
  check('the popover pre-fills with the correct age', t4.ageLabel !== '' && !isNaN(parseInt(t4.ageLabel)));

  // ---- Editing a single year (no copy) only changes that one year ----
  const t5 = await page.evaluate(() => {
    document.querySelector('#tableBody td.col-target').click();
    const age = parseInt(document.getElementById('targetEditAgeLabel').textContent);
    const before = { ...TARGET_INCOME };
    document.getElementById('targetEditValue').value = '77777';
    document.getElementById('targetEditCopyCheck').checked = false;
    _saveTargetEditor();
    return { age, changedAge: TARGET_INCOME[age], neighborUnchanged: TARGET_INCOME[age + 1] === before[age + 1] };
  });
  check('editing a single year (copy unchecked) updates only that year', t5.changedAge === 77777);
  check('editing a single year (copy unchecked) leaves the next year untouched', t5.neighborUnchanged);
  check('the popover closes after saving', await page.evaluate(() => document.getElementById('targetEditPopover').style.display === 'none'));

  // ---- "Copy until age" bulk-fills forward through the chosen end age ----
  const t6 = await page.evaluate(() => {
    document.querySelector('#tableBody td.col-target').click();
    const age = parseInt(document.getElementById('targetEditAgeLabel').textContent);
    const beyondEndBefore = TARGET_INCOME[age + 6];
    document.getElementById('targetEditValue').value = '50000';
    document.getElementById('targetEditCopyCheck').checked = true;
    _onTargetCopyCheckChange();
    document.getElementById('targetEditCopyAge').value = String(age + 5);
    _saveTargetEditor();
    const filled = [];
    for (let a = age; a <= age + 5; a++) filled.push(TARGET_INCOME[a]);
    return { filled, beyondEndBefore, beyondEndAfter: TARGET_INCOME[age + 6] };
  });
  check('"Copy until age" fills every year from the edited year through the end age (inclusive)', t6.filled.every(v => v === 50000));
  check('"Copy until age" does not touch the year right after the end age', t6.beyondEndAfter === t6.beyondEndBefore);

  // ---- Copy-until-age clamps to the fixed max (110), and to the edited
  // year itself if a smaller/invalid end age is given ----
  const t7 = await page.evaluate(() => {
    document.querySelector('#tableBody td.col-target').click();
    const age = parseInt(document.getElementById('targetEditAgeLabel').textContent);
    document.getElementById('targetEditValue').value = '99000';
    document.getElementById('targetEditCopyCheck').checked = true;
    _onTargetCopyCheckChange();
    document.getElementById('targetEditCopyAge').value = '99999'; // absurdly high
    _saveTargetEditor();
    return { age110: TARGET_INCOME[110] };
  });
  check('an absurdly high "copy until age" clamps to the fixed max (110), not beyond', t7.age110 === 99000);

  // ---- Cancel discards the edit ----
  const t8 = await page.evaluate(() => {
    document.querySelector('#tableBody td.col-target').click();
    const age = parseInt(document.getElementById('targetEditAgeLabel').textContent);
    const before = TARGET_INCOME[age];
    document.getElementById('targetEditValue').value = '1234';
    _closeTargetEditor();
    return { unchanged: TARGET_INCOME[age] === before, hidden: document.getElementById('targetEditPopover').style.display === 'none' };
  });
  check('Cancel (closing without saving) leaves the value unchanged', t8.unchanged);
  check('Cancel hides the popover', t8.hidden);

  // ---- Editing takes effect live in the rendered numbers (same fix as the
  // DB bridge follow-ups: rerunRetirement(), not a plain renderAll()) ----
  const t9 = await page.evaluate(() => {
    document.querySelector('.age-btn[data-age="60"]').click();
    return new Promise(resolve => {
      setTimeout(() => {
        const cell = document.querySelector('#tableBody td.col-target');
        const before = document.getElementById('ageSummary').innerHTML;
        cell.click();
        document.getElementById('targetEditValue').value = '123456';
        document.getElementById('targetEditCopyCheck').checked = false;
        _saveTargetEditor();
        setTimeout(() => resolve({ changed: before !== document.getElementById('tableBody').innerHTML }), 100);
      }, 300);
    });
  });
  check('saving a target-income edit re-renders the table immediately (no age click or reload needed)', t9.changed);

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    TARGET_INCOME[66] = 111111;
    _saveTargetIncome();
  });
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(1200);
  const t10 = await page.evaluate(() => TARGET_INCOME[66]);
  check('an edited year\'s value survives a reload', t10 === 111111);

  // ---- Legacy migration: an old saved plan (tgt60-80 bands only, no
  // targetIncomeByAge key yet) migrates into TARGET_INCOME correctly and
  // exactly once ----
  await browser.close();
  const seed = {
    plannerState: JSON.stringify({
      v: 1,
      ret: { tgt60: '90000', tgt65: '81000', tgt70: '72000', tgt75: '63000', tgt80: '54000', age: '65', qppStart: '65', oasStart: '65' },
      acc: {}, budget: {}, nav: {},
    }),
  };
  const { browser: b2, page: p2, consoleErrors: ce2 } = await openApp(process.argv[2], { seedLocalStorage: seed });
  const t11 = await p2.evaluate(() => ({
    age60: TARGET_INCOME[60], age65: TARGET_INCOME[65], age70: TARGET_INCOME[70],
    age75: TARGET_INCOME[75], age80: TARGET_INCOME[80],
    persisted: !!JSON.parse(localStorage.getItem('plannerState')).ret.targetIncomeByAge,
  }));
  check('legacy migration: saved tgt60 (90000) lands on ages 60-64', t11.age60 === 90000);
  check('legacy migration: saved tgt65 (81000) lands on ages 65-69', t11.age65 === 81000);
  check('legacy migration: saved tgt70 (72000) lands on ages 70-74', t11.age70 === 72000);
  check('legacy migration: saved tgt75 (63000) lands on ages 75-79', t11.age75 === 63000);
  check('legacy migration: saved tgt80 (54000) lands on age 80+', t11.age80 === 54000);
  check('the migration persists targetIncomeByAge immediately so it only ever runs once', t11.persisted);
  await b2.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${consoleErrors.length + ce2.length}`);
  console.log(fail === 0 && consoleErrors.length === 0 && ce2.length === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && consoleErrors.length === 0 && ce2.length === 0 ? 0 : 1);
})();
