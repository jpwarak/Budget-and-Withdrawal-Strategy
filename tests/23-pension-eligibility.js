'use strict';
// Government Pension Eligibility (Profile tab): replaces the old blanket
// "Use CPP/QPP" checkbox with a real eligibility questionnaire, and adds an
// eligibility gate to OAS that never existed before. Per the official rules
// (retraitequebec.gouv.qc.ca for QPP, canada.ca for CPP and OAS): CPP/QPP
// needs at least one contribution year and has no residency requirement at
// all; OAS needs citizenship/legal residency plus 10 years of Canadian
// residency since age 18 while living in Canada, or 20 years while living
// abroad -- the 10-vs-20 threshold follows the Profile tab's existing
// resident/expat toggle rather than a separate question. Covers: default
// (fresh-browser) eligibility, each field actually gating the right
// benefit, the OAS threshold switching with residency, the status-line text,
// the Accumulation-tab CPP/QPP box dimming with an explanatory note when
// ineligible, and persistence across a reload.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Fresh browser: both benefits eligible by default ----
  const fresh = await page.evaluate(() => ({
    contributed: document.getElementById('eligContributed').checked,
    citizen: document.getElementById('eligCitizen').checked,
    years: document.getElementById('eligYearsInCanada').value,
    qpp65: _getQPP(65, 65),
    oas65: _getOAS(65, 65),
    qppWrapOpacity: document.getElementById('qppFieldsWrap').style.opacity,
    qppNoteHidden: document.getElementById('qppEligNote').style.display === 'none',
  }));
  check('fresh browser: "contributed to CPP/QPP" defaults to checked', fresh.contributed === true);
  check('fresh browser: "citizen/legal resident" defaults to checked', fresh.citizen === true);
  check('fresh browser: years-in-Canada defaults to (age-18) = 25 (default age 43)', fresh.years === '25');
  check('fresh browser: _getQPP(65,65) still 19718 (no regression)', fresh.qpp65 === 19718);
  check('fresh browser: _getOAS(65,65) still 17500 (no regression -- OAS never had a gate before)', fresh.oas65 === 17500);
  check('fresh browser: CPP/QPP accumulation box not dimmed (eligible)', fresh.qppWrapOpacity === '1' || fresh.qppWrapOpacity === '');
  check('fresh browser: CPP/QPP ineligibility note hidden', fresh.qppNoteHidden);

  // ---- Unchecking "contributed to CPP/QPP" zeroes CPP/QPP, leaves OAS alone ----
  const noContrib = await page.evaluate(() => {
    document.getElementById('eligContributed').checked = false;
    onEligibilityFieldChange();
    return {
      qpp65: _getQPP(65, 65),
      oas65: _getOAS(65, 65),
      wrapOpacity: document.getElementById('qppFieldsWrap').style.opacity,
      noteVisible: document.getElementById('qppEligNote').style.display !== 'none',
      statusText: document.getElementById('eligStatus').textContent,
    };
  });
  check('unchecking "contributed": _getQPP returns 0', noContrib.qpp65 === 0);
  check('unchecking "contributed": OAS unaffected', noContrib.oas65 === 17500);
  check('unchecking "contributed": Accumulation CPP/QPP box dims', noContrib.wrapOpacity === '0.4');
  check('unchecking "contributed": ineligibility note shows', noContrib.noteVisible);
  check('unchecking "contributed": status line says not eligible for QPP/CPP', /Not eligible for (QPP|CPP)/.test(noContrib.statusText));
  await page.evaluate(() => { document.getElementById('eligContributed').checked = true; onEligibilityFieldChange(); });

  // ---- Unchecking "citizen/legal resident" zeroes OAS, leaves CPP/QPP alone ----
  const noCitizen = await page.evaluate(() => {
    document.getElementById('eligCitizen').checked = false;
    onEligibilityFieldChange();
    return { qpp65: _getQPP(65, 65), oas65: _getOAS(65, 65), statusText: document.getElementById('eligStatus').textContent };
  });
  check('unchecking "citizen": _getOAS returns 0', noCitizen.oas65 === 0);
  check('unchecking "citizen": CPP/QPP unaffected', noCitizen.qpp65 === 19718);
  check('unchecking "citizen": status line says not eligible for OAS', /Not eligible for OAS/.test(noCitizen.statusText));
  await page.evaluate(() => { document.getElementById('eligCitizen').checked = true; onEligibilityFieldChange(); });

  // ---- Years-in-Canada threshold: 10 years while resident ----
  const residentThreshold = await page.evaluate(() => {
    document.getElementById('profileResidency').value = 'resident';
    onProfileResidencyChange();
    document.getElementById('eligYearsInCanada').value = 9;
    onEligibilityFieldChange();
    const below = _getOAS(65, 65);
    document.getElementById('eligYearsInCanada').value = 10;
    onEligibilityFieldChange();
    const atThreshold = _getOAS(65, 65);
    return { below, atThreshold };
  });
  check('resident: 9 years is not enough for OAS', residentThreshold.below === 0);
  check('resident: exactly 10 years is enough for OAS', residentThreshold.atThreshold === 17500);

  // ---- Years-in-Canada threshold: 20 years while expat (non-resident) ----
  const expatThreshold = await page.evaluate(() => {
    document.getElementById('profileResidency').value = 'expat';
    onProfileResidencyChange();
    document.getElementById('eligYearsInCanada').value = 15;
    onEligibilityFieldChange();
    const below = _getOAS(65, 65);
    document.getElementById('eligYearsInCanada').value = 20;
    onEligibilityFieldChange();
    const atThreshold = _getOAS(65, 65);
    return { below, atThreshold, requiredYears: _oasYearsRequired() };
  });
  check('expat: 15 years is not enough for OAS (needs 20, not 10)', expatThreshold.below === 0);
  check('expat: exactly 20 years is enough for OAS', expatThreshold.atThreshold === 17500);
  check('_oasYearsRequired() returns 20 for expat', expatThreshold.requiredYears === 20);

  // Restore resident + 25 years for the checks below.
  await page.evaluate(() => {
    document.getElementById('profileResidency').value = 'resident';
    onProfileResidencyChange();
    document.getElementById('eligYearsInCanada').value = 25;
    onEligibilityFieldChange();
  });

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    document.getElementById('eligContributed').checked = false;
    document.getElementById('eligCitizen').checked = false;
    document.getElementById('eligYearsInCanada').value = 7;
    onEligibilityFieldChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => ({
    contributed: document.getElementById('eligContributed').checked,
    citizen: document.getElementById('eligCitizen').checked,
    years: document.getElementById('eligYearsInCanada').value,
  }));
  check('"contributed" unchecked survives reload', afterReload.contributed === false);
  check('"citizen" unchecked survives reload', afterReload.citizen === false);
  check('years-in-Canada (7) survives reload', afterReload.years === '7');

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
