'use strict';
// Companion to 04-age55-toggles.js: the default (ra=62) budget dropdown must
// NOT show the 55-59 bracket, and the Insurance/Medical "only apply at
// future ages" toggles behave the same way the Gifts one does.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(400);
  const defaultOptions = await page.evaluate(() => {
    const sel = document.getElementById('bud_incMain_age');
    return Array.from(sel.options).map(o => o.value);
  });
  check('default (ra=62) bracket options do NOT include 55-59', !defaultOptions.includes('55-59'));

  await page.evaluate(() => {
    document.getElementById('bud_insLife_amt').value = 40;
    document.getElementById('bud_insLife_amt').dispatchEvent(new Event('input'));
    document.getElementById('bud_medDoctor_amt').value = 30;
    document.getElementById('bud_medDoctor_amt').dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(200);
  const beforeToggle = await page.evaluate(() => {
    const t = computeDisplayTotals();
    return { insurance: t.groupTotals['insurance'], medical: t.groupTotals['medical'] };
  });
  check('insurance included at Current by default', beforeToggle.insurance === 40);
  check('medical included at Current by default', beforeToggle.medical === 30);

  await page.evaluate(() => {
    document.getElementById('bud_insurance_exclcur').checked = true;
    document.getElementById('bud_insurance_exclcur').dispatchEvent(new Event('change'));
    document.getElementById('bud_medical_exclcur').checked = true;
    document.getElementById('bud_medical_exclcur').dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);
  const afterToggle = await page.evaluate(() => {
    const t = computeDisplayTotals();
    return { insurance: t.groupTotals['insurance'], medical: t.groupTotals['medical'] };
  });
  check('insurance excluded at Current once "only apply at future ages" is checked', afterToggle.insurance === 0);
  check('medical excluded at Current once "only apply at future ages" is checked', afterToggle.medical === 0);

  await page.evaluate(() => {
    const ageSel = document.getElementById('bud_incMain_age');
    ageSel.value = '65-69'; ageSel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);
  const atFuture = await page.evaluate(() => {
    const chk = document.getElementById('bud_insurance_exclcur');
    const t = computeDisplayTotals();
    return { checkedStillTrue: chk.checked, visible: getComputedStyle(chk.closest('.budget-debt-row')).display !== 'none', insuranceTotal: t.groupTotals['insurance'] };
  });
  check('insurance toggle stays checked at a future age', atFuture.checkedStillTrue);
  check('insurance toggle stays visible at a future age', atFuture.visible);
  check('insurance total > 0 at future age regardless of the toggle', atFuture.insuranceTotal > 0);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
