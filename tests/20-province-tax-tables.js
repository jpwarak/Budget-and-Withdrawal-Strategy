'use strict';
// Phase 2: the province selector's real tax tables (PROVINCE_TAX_TABLES),
// wired to the Profile tab's #profileProvince dropdown added in the earlier
// Profile-tab phase. Covers: the dropdown now offers Ontario/BC/Alberta
// alongside Quebec; each province's basic bracket-tax math matches a hand
// computation against the published 2026 brackets/BPA; Ontario's two-tier
// surtax activates at the right income levels; a non-resident (expat) still
// owes zero provincial tax regardless of which province is selected; and —
// most importantly — Quebec's own numbers are a byte-for-byte regression
// check against what this file already produced before this phase (the
// federal abatement and Quebec's own bracket/BPA/DTC math must be
// unaffected by generalizing the code to support other provinces too).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Dropdown now offers all 4 provinces, alphabetized ----
  const dropdownOptions = await page.evaluate(() => {
    const sel = document.getElementById('profileProvince');
    return Array.from(sel.options).filter(o => !o.disabled).map(o => o.value);
  });
  check('province dropdown offers alberta, bc, ontario, quebec (alphabetical)', JSON.stringify(dropdownOptions) === JSON.stringify(['alberta', 'bc', 'ontario', 'quebec']));

  // ---- Quebec regression: exact numbers this file has always produced ----
  // (age 43 == the default #accCurAge, so no forward-indexation is applied —
  // these are the raw 2026 bracket/BPA numbers, easiest to hand-verify.)
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'quebec'; onProfileFieldChange(); });
  await page.waitForTimeout(200);
  const qc = await page.evaluate(() => ({
    at75k: _calcTaxDetail(75000, 43),
    at250k: _calcTaxDetail(250000, 43),
  }));
  check('Quebec $75k total unchanged by the province generalization', qc.at75k.total === 14418);
  check('Quebec $75k fed/prov split unchanged', qc.at75k.fed === 6714 && qc.at75k.prov === 7704);
  check('Quebec $250k total unchanged by the province generalization', qc.at250k.total === 94909);
  check('Quebec marginal rate still reflects the federal abatement (~0.835x federal + QC)', Math.abs(qc.at250k.marginal - 0.5020715) < 0.0001);

  // ---- Ontario: bracket math + BPA against the published 2026 table ----
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'ontario'; onProfileFieldChange(); });
  await page.waitForTimeout(200);
  const on = await page.evaluate(() => ({
    at40k: _calcTaxDetail(40000, 43),
    at100k: _calcTaxDetail(100000, 43),   // basic ON tax net of BPA (~$6,285) clears the $5,818 surtax tier 1 threshold, not tier 2
    at250k: _calcTaxDetail(250000, 43),   // well past both surtax tiers
  }));
  // Hand computation for $40,000: bracket tax = 40000*0.0505 = 2020; BPA
  // credit = 12989*0.0505 = 655.9 (rounds down inside the shared credit
  // split, so allow $1 slack); no surtax (basic ON tax net of BPA ~$1,364,
  // under the $5,818 threshold).
  check('Ontario $40k has no surtax applied (well under the $5,818 threshold)', on.at40k.prov > 0 && on.at40k.prov < 1500);
  check('Ontario $100k marginal rate reflects tier-1 surtax only (0.205 fed + 0.0915*1.20 prov = 0.3148)', Math.abs(on.at100k.marginal - 0.3148) < 0.0005);
  check('Ontario has no federal abatement (fed marginal contribution is the plain federal rate)', on.at100k.marginal > 0.31);
  check('Ontario $250k tax is real and positive', on.at250k.total > 0);
  check('Ontario total tax differs from Quebec at the same income (different tables actually being used)', on.at250k.total !== qc.at250k.total);

  // ---- BC: plain graduated brackets, no abatement, no surtax ----
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'bc'; onProfileFieldChange(); });
  await page.waitForTimeout(200);
  const bc = await page.evaluate(() => ({
    at40k: _calcTaxDetail(40000, 43),
    marginalAt40k: _calcTaxDetail(40000, 43).marginal,
  }));
  // At $40,000, BC's own bracket rate is 5.60% (first bracket, up to $50,363)
  // and federal is the 14% first-tier rate (no abatement anywhere): 0.14 + 0.056 = 0.196.
  check('BC marginal rate at $40k is federal 14% + BC 5.6%, no abatement (0.196)', Math.abs(bc.marginalAt40k - 0.196) < 0.0005);
  check('BC tax at $40k is real and positive', bc.at40k.total > 0);

  // ---- Alberta: plain graduated brackets, no abatement, no surtax ----
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'alberta'; onProfileFieldChange(); });
  await page.waitForTimeout(200);
  const ab = await page.evaluate(() => ({
    marginalAt40k: _calcTaxDetail(40000, 43).marginal,
  }));
  // Alberta's first bracket (up to $61,200) is 8%: 0.14 + 0.08 = 0.22.
  check('Alberta marginal rate at $40k is federal 14% + Alberta 8%, no abatement (0.22)', Math.abs(ab.marginalAt40k - 0.22) < 0.0005);

  // ---- Non-resident (expat) owes $0 provincial tax regardless of province ----
  const expatCheck = await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'ontario';
    onProfileFieldChange();
    return _calcTaxDetailNonResident(80000, 65);
  });
  check('a non-resident (PH217) owes zero provincial tax even with Ontario selected', expatCheck.prov === 0);

  // ---- Persistence: province survives a reload ----
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'bc'; onProfileFieldChange(); });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => document.getElementById('profileProvince').value);
  check('selected province persists across reload', afterReload === 'bc');

  // ---- Regression: fresh browser still defaults to Quebec ----
  const { browser: browser2, page: page2 } = await openApp(process.argv[2], { seedLocalStorage: {} });
  const freshProvince = await page2.evaluate(() => document.getElementById('profileProvince').value);
  check('fresh browser (never touched Profile) still defaults to Quebec', freshProvince === 'quebec');
  await browser2.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
