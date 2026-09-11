'use strict';
// The Profile tab: date-of-birth-driven age, province stub, and the
// resident/expat toggle that replaced the old 3-way mode-button row.
// Covers: tab is reachable; DOB computes accCurAge and makes it read-only;
// clearing DOB hands manual control back; switching to "expat" hides the
// resident button and reveals the two PH mode buttons (and vice versa);
// residency persists across a reload; and the "never touched Profile"
// regression case (a fresh browser with no saved profile data at all)
// behaves exactly as it did before this feature existed.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Tab exists and is reachable ----
  const tabInfo = await page.evaluate(() => {
    const btn = document.getElementById('tabBtnProfile');
    const panel = document.getElementById('panelProfile');
    return { btnExists: !!btn, panelExists: !!panel, panelHiddenInitially: panel && panel.style.display === 'none' };
  });
  check('Profile tab nav button exists', tabInfo.btnExists);
  check('Profile panel exists and starts hidden', tabInfo.panelExists && tabInfo.panelHiddenInitially);

  await page.evaluate(() => { showTab('profile'); });
  await page.waitForTimeout(300);
  const afterShow = await page.evaluate(() => ({
    panelVisible: document.getElementById('panelProfile').style.display === 'block',
    btnActive: document.getElementById('tabBtnProfile').className.includes('active'),
  }));
  check('showTab("profile") reveals the panel', afterShow.panelVisible);
  check('showTab("profile") marks the nav button active', afterShow.btnActive);

  // ---- Fresh-browser regression: no saved profile data at all ----
  const freshDefaults = await page.evaluate(() => ({
    age: document.getElementById('accCurAge').value,
    ageReadOnly: document.getElementById('accCurAge').readOnly,
    dob: document.getElementById('profileDob').value,
    province: document.getElementById('profileProvince').value,
    residency: document.getElementById('profileResidency').value,
    residentBtnVisible: document.getElementById('btnResident').style.display !== 'none',
    expatWrapVisible: document.getElementById('expatModeButtons').style.display !== 'none',
  }));
  check('fresh browser: no DOB set, age stays manually editable', freshDefaults.dob === '' && freshDefaults.ageReadOnly === false);
  check('fresh browser: age defaults to 43 (unaffected by Profile feature)', freshDefaults.age === '43');
  check('fresh browser: province defaults to quebec', freshDefaults.province === 'quebec');
  check('fresh browser: residency defaults to resident (inferred, no saved mode)', freshDefaults.residency === 'resident');
  check('fresh browser: resident button visible, expat buttons hidden', freshDefaults.residentBtnVisible && !freshDefaults.expatWrapVisible);

  // ---- DOB drives accCurAge (computed independently, whole-years logic) ----
  const dobResult = await page.evaluate(() => {
    // Pick a DOB 30 years and a few months back, so the "hasn't had this
    // year's birthday yet" branch of the age math gets exercised too.
    const d = new Date();
    d.setFullYear(d.getFullYear() - 30);
    d.setMonth(d.getMonth() + 2); // birthday later this year than "today"
    const dobStr = d.toISOString().slice(0, 10);
    const dobEl = document.getElementById('profileDob');
    dobEl.value = dobStr;
    dobEl.dispatchEvent(new Event('change'));
    return {
      dobStr,
      age: document.getElementById('accCurAge').value,
      readOnly: document.getElementById('accCurAge').readOnly,
    };
  });
  // Independently compute the expected age the same way a person would.
  const expectedAge = (() => {
    const dob = new Date(dobResult.dobStr + 'T00:00:00');
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const hadBirthday = (today.getMonth() > dob.getMonth()) ||
      (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
    if (!hadBirthday) age--;
    return age;
  })();
  check('setting DOB computes the correct age into accCurAge', Number(dobResult.age) === expectedAge);
  check('setting DOB makes accCurAge read-only', dobResult.readOnly === true);

  // ---- Clearing DOB hands manual control back ----
  const clearedResult = await page.evaluate(() => {
    const dobEl = document.getElementById('profileDob');
    dobEl.value = '';
    dobEl.dispatchEvent(new Event('change'));
    return { readOnly: document.getElementById('accCurAge').readOnly };
  });
  check('clearing DOB makes accCurAge editable again', clearedResult.readOnly === false);

  // ---- Residency toggle: resident -> expat ----
  const toExpat = await page.evaluate(() => {
    const sel = document.getElementById('profileResidency');
    sel.value = 'expat';
    sel.dispatchEvent(new Event('change'));
    return {
      residentBtnVisible: document.getElementById('btnResident').style.display !== 'none',
      expatWrapVisible: document.getElementById('expatModeButtons').style.display !== 'none',
      spendMode: spendMode,
    };
  });
  check('switching to expat hides the resident button', !toExpat.residentBtnVisible);
  check('switching to expat shows the expat mode buttons', toExpat.expatWrapVisible);
  check('switching to expat moves spendMode off "resident" (defaults to nonresident)', toExpat.spendMode === 'nonresident');

  // ---- Residency toggle: expat -> resident ----
  const toResident = await page.evaluate(() => {
    const sel = document.getElementById('profileResidency');
    sel.value = 'resident';
    sel.dispatchEvent(new Event('change'));
    return {
      residentBtnVisible: document.getElementById('btnResident').style.display !== 'none',
      expatWrapVisible: document.getElementById('expatModeButtons').style.display !== 'none',
      spendMode: spendMode,
    };
  });
  check('switching back to resident shows the resident button', toResident.residentBtnVisible);
  check('switching back to resident hides the expat mode buttons', !toResident.expatWrapVisible);
  check('switching back to resident sets spendMode to "resident"', toResident.spendMode === 'resident');

  // ---- CPI / growth-rate inputs now live inside the Profile panel ----
  const assumptionsLocation = await page.evaluate(() => {
    const panel = document.getElementById('panelProfile');
    const cpi = document.getElementById('cpiRate');
    const growth = document.getElementById('retGrowthRate');
    return {
      cpiInsideProfile: !!(cpi && panel.contains(cpi)),
      growthInsideProfile: !!(growth && panel.contains(growth)),
      cpiCount: document.querySelectorAll('#cpiRate').length,
      growthCount: document.querySelectorAll('#retGrowthRate').length,
    };
  });
  check('CPI rate input lives inside the Profile panel (single instance)', assumptionsLocation.cpiInsideProfile && assumptionsLocation.cpiCount === 1);
  check('Growth rate input lives inside the Profile panel (single instance)', assumptionsLocation.growthInsideProfile && assumptionsLocation.growthCount === 1);

  // ---- Persistence round trip: DOB, province, residency survive a reload ----
  const dobToPersist = dobResult.dobStr;
  await page.evaluate((dobStr) => {
    const dobEl = document.getElementById('profileDob');
    dobEl.value = dobStr;
    dobEl.dispatchEvent(new Event('change'));
    const sel = document.getElementById('profileResidency');
    sel.value = 'expat';
    sel.dispatchEvent(new Event('change'));
  }, dobToPersist);
  await page.waitForTimeout(300);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { showTab('profile'); });
  await page.waitForTimeout(300);
  const afterReload = await page.evaluate(() => ({
    dob: document.getElementById('profileDob').value,
    province: document.getElementById('profileProvince').value,
    residency: document.getElementById('profileResidency').value,
    ageReadOnly: document.getElementById('accCurAge').readOnly,
    residentBtnVisible: document.getElementById('btnResident').style.display !== 'none',
    expatWrapVisible: document.getElementById('expatModeButtons').style.display !== 'none',
  }));
  check('DOB persists across reload', afterReload.dob === dobToPersist);
  check('province persists across reload', afterReload.province === 'quebec');
  check('residency persists across reload', afterReload.residency === 'expat');
  check('after reload, restored DOB re-applies read-only age', afterReload.ageReadOnly === true);
  check('after reload, restored expat residency shows the right buttons', !afterReload.residentBtnVisible && afterReload.expatWrapVisible);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
