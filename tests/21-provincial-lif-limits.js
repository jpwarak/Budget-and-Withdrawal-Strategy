'use strict';
// Provincial LIF maximum-withdrawal rules, and the "federally regulated
// pension" override checkbox added to the DC Pension box. Covers: Quebec's
// real post-2025 rule (no maximum at all for ages 55+); Ontario/BC/Alberta's
// shared formula (computed live from the regulator-confirmed methodology —
// balance ÷ annuity-to-90 factor, discounted at the greater of the current
// bond yield or a 6% floor — checked against an independent hand
// computation of that same formula, not just re-running the app's own
// code); the override checkbox switching any province back to the federal
// table; that the override defaults to OFF (unlike every "Include this
// account" checkbox, which defaults to ON); persistence of the checkbox
// across a reload; and an end-to-end regression proving the Quebec fix
// actually changes simulated behavior the way real law says it should (a
// Quebec LIF can fully drain when the plan needs it to, where the old
// federal-table assumption would have artificially capped it).
const { openApp, finish } = require('./lib');

// Independent reimplementation of the Ontario/BC/Alberta formula (not a
// copy-paste of the app's _provLifMaxRate -- if someone breaks the formula
// inside the app, this computes the expected answer a different way and
// still catches it).
function expectedProvLifMaxRate(age) {
  const CURRENT_LONG_BOND_RATE = 0.0349;
  const FLOOR = 0.06;
  const a = Math.max(55, Math.min(Math.round(age), 90));
  if (a >= 90) return 1.0;
  const n = 90 - a;
  const r = Math.max(CURRENT_LONG_BOND_RATE, FLOOR);
  let F = 0;
  for (let t = 0; t < n; t++) F += Math.pow(1 / (1 + r), t);
  return 1 / F;
}

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  const setProvince = (p) => page.evaluate((prov) => {
    document.getElementById('profileProvince').value = prov;
    onProfileFieldChange();
  }, p);

  // ---- Quebec: no maximum at all for 55+ ----
  await setProvince('quebec');
  const qcRates = await page.evaluate(() => ({ a55: _lifMaxRate(55), a65: _lifMaxRate(65), a80: _lifMaxRate(80), a89: _lifMaxRate(89) }));
  check('Quebec LIF has no maximum at 55 (rate = 1.0, i.e. 100%)', qcRates.a55 === 1);
  check('Quebec LIF has no maximum at 65', qcRates.a65 === 1);
  check('Quebec LIF has no maximum at 80', qcRates.a80 === 1);
  check('Quebec LIF has no maximum at 89', qcRates.a89 === 1);

  // ---- Ontario/BC/Alberta: formula-based, matches an independent computation ----
  for (const prov of ['ontario', 'bc', 'alberta']) {
    await setProvince(prov);
    const rates = await page.evaluate(() => ({ a55: _lifMaxRate(55), a65: _lifMaxRate(65), a80: _lifMaxRate(80), a89: _lifMaxRate(89), a90: _lifMaxRate(90) }));
    check(`${prov}: age 55 matches independent formula computation`, Math.abs(rates.a55 - expectedProvLifMaxRate(55)) < 0.0001);
    check(`${prov}: age 65 matches independent formula computation`, Math.abs(rates.a65 - expectedProvLifMaxRate(65)) < 0.0001);
    check(`${prov}: age 80 matches independent formula computation`, Math.abs(rates.a80 - expectedProvLifMaxRate(80)) < 0.0001);
    check(`${prov}: age 89 is 100% (must pay out in full before 90)`, Math.abs(rates.a89 - 1) < 0.0001);
    check(`${prov}: age 90 is 100%`, Math.abs(rates.a90 - 1) < 0.0001);
    check(`${prov}: max rate increases monotonically with age (55 < 65 < 80)`, rates.a55 < rates.a65 && rates.a65 < rates.a80);
  }

  // ---- Federally regulated pension checkbox: overrides any province ----
  await setProvince('quebec');
  const fedOverrideResults = await page.evaluate(() => {
    const cb = document.getElementById('dcFederallyRegulated');
    cb.checked = true;
    onDcFederallyRegulatedChange();
    return { a55: _lifMaxRate(55), a65: _lifMaxRate(65), a80: _lifMaxRate(80) };
  });
  // FED_LIF_MAX published values: 55->5.2096%, 65->6.0272%, 80->11.6128%
  check('federal override on Quebec: age 55 matches the federal OSFI table, not the no-max Quebec rule', Math.abs(fedOverrideResults.a55 - 0.052096) < 0.0001);
  check('federal override on Quebec: age 65 matches the federal OSFI table', Math.abs(fedOverrideResults.a65 - 0.060272) < 0.0001);
  check('federal override on Quebec: age 80 matches the federal OSFI table', Math.abs(fedOverrideResults.a80 - 0.116128) < 0.0001);

  const fedOverrideOnOntario = await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'ontario';
    onProfileFieldChange();
    return _lifMaxRate(65); // checkbox is still checked from above
  });
  check('federal override also applies when Ontario is selected (not Quebec-specific)', Math.abs(fedOverrideOnOntario - 0.060272) < 0.0001);

  // ---- Checkbox defaults to OFF (unlike "Include this account" checkboxes) ----
  const { browser: browser2, page: page2 } = await openApp(process.argv[2], { seedLocalStorage: {} });
  const freshDefault = await page2.evaluate(() => document.getElementById('dcFederallyRegulated').checked);
  check('fresh browser: federally-regulated checkbox defaults to UNCHECKED', freshDefault === false);
  await browser2.close();

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'alberta';
    onProfileFieldChange();
    const cb = document.getElementById('dcFederallyRegulated');
    cb.checked = false;
    onDcFederallyRegulatedChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => ({
    province: document.getElementById('profileProvince').value,
    fedReg: document.getElementById('dcFederallyRegulated').checked,
  }));
  check('province selection survives reload', afterReload.province === 'alberta');
  check('federally-regulated checkbox (unchecked) survives reload', afterReload.fedReg === false);

  // ---- End-to-end regression: a Quebec LIF can now fully drain when the
  // plan needs it to (proving the fix changes real simulated behavior, not
  // just the standalone rate function) ----
  const e2e = await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'quebec';
    onProfileFieldChange();
    const cb = document.getElementById('dcFederallyRegulated');
    cb.checked = false;
    onDcFederallyRegulatedChange();
    // A small LIF, plenty of spending need (Target Income defaults, current
    // age left at its default so CPI-inflated future targets create a real
    // gap) -- with no cap, the LIF can supply its entire opening balance in
    // year 1 if the gap calls for it.
    const rows = simulateResidentFixed(65, 65, 65, { lif: 2000, rrsp: 2000, tfsa: 0, nonreg: 0 });
    return { lifDraw: rows[0].lif, lifBal: rows[0].lifBal };
  });
  check('Quebec: a small LIF can fully drain in year 1 when the spending gap calls for it (no artificial cap)', e2e.lifDraw === e2e.lifBal);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
