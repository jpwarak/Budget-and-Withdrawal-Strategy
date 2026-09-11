'use strict';
// Quebec's government retirement pension is QPP; every other province
// participates in CPP instead -- same benefit, different name depending on
// which province governs it. Previously the whole app said "QPP"
// unconditionally regardless of province. Covers: every user-facing "QPP"
// label (Retirement Income tab's start-age slider inline label, the income
// chart's legend and dataset, the Year-by-Year table header + its tooltips,
// the phase-summary cards, the footer note, and the new Accumulation-tab
// CPP/QPP box) switching to "CPP" for Ontario/BC/Alberta and staying "QPP"
// for Quebec; and the editable "Amount at 65" input actually driving
// _getQPP()'s output, including its persistence across a reload. Whether
// CPP/QPP is payable at all is a separate concern, covered by
// tests/23-pension-eligibility.js (there is no "Use CPP/QPP" on/off
// checkbox any more -- see that file for why).
//
// Note (2026-09-11): the old dedicated "QPP 65"/"QPP 70" toggle buttons
// (whose textContent this test used to check directly) were replaced by a
// continuous start-age slider -- see tests/45-qpp-oas-start-slider.js. The
// slider has no per-value text of its own, so this test now checks the
// inline "QPP:"/"CPP:" label only.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  const setProvince = (p) => page.evaluate((prov) => {
    document.getElementById('profileProvince').value = prov;
    onProfileFieldChange();
  }, p);

  // ---- Fresh browser defaults to Quebec, so every label should say "QPP" ----
  const qcLabels = await page.evaluate(() => ({
    inline: document.getElementById('qppInlineLabel').textContent,
    legend: document.getElementById('legQppLabel').textContent,
    thText: document.getElementById('thQpp').textContent,
    thTitle: document.getElementById('thQpp').title,
    accHeader: document.getElementById('cppQppHeader').textContent,
    accAmountLabel: document.getElementById('qppAmountLabel').textContent,
  }));
  check('fresh browser (Quebec default): inline label is "QPP:"', qcLabels.inline === 'QPP:');
  check('fresh browser: legend says "QPP"', qcLabels.legend === 'QPP');
  check('fresh browser: table header says "QPP"', qcLabels.thText === 'QPP');
  check('fresh browser: table header tooltip mentions QPP', /QPP/.test(qcLabels.thTitle));
  check('fresh browser: Accumulation-tab box header says "QPP"', qcLabels.accHeader === 'QPP');
  check('fresh browser: Accumulation-tab amount label says "QPP Amount at 65 ($)"', qcLabels.accAmountLabel === 'QPP Amount at 65 ($)');

  // ---- Selecting Ontario/BC/Alberta switches every label to "CPP" ----
  for (const prov of ['ontario', 'bc', 'alberta']) {
    await setProvince(prov);
    const labels = await page.evaluate(() => ({
      inline: document.getElementById('qppInlineLabel').textContent,
      legend: document.getElementById('legQppLabel').textContent,
      thText: document.getElementById('thQpp').textContent,
      thTitle: document.getElementById('thQpp').title,
      wrTitle: document.getElementById('thWrPct').title,
      taxableTitle: document.getElementById('thTaxable').title,
      accHeader: document.getElementById('cppQppHeader').textContent,
      accAmountLabel: document.getElementById('qppAmountLabel').textContent,
    }));
    check(`${prov}: inline label is "CPP:"`, labels.inline === 'CPP:');
    check(`${prov}: legend says "CPP"`, labels.legend === 'CPP');
    check(`${prov}: table header says "CPP"`, labels.thText === 'CPP');
    check(`${prov}: table header tooltip mentions CPP (not QPP)`, /CPP/.test(labels.thTitle) && !/QPP/.test(labels.thTitle));
    check(`${prov}: WR% tooltip mentions CPP (not QPP)`, /CPP/.test(labels.wrTitle) && !/QPP/.test(labels.wrTitle));
    check(`${prov}: Taxable tooltip mentions CPP (not QPP)`, /CPP/.test(labels.taxableTitle) && !/QPP/.test(labels.taxableTitle));
    check(`${prov}: Accumulation-tab box header says "CPP"`, labels.accHeader === 'CPP');
    check(`${prov}: Accumulation-tab amount label says "CPP Amount at 65 ($)"`, labels.accAmountLabel === 'CPP Amount at 65 ($)');
  }

  // ---- Switching back to Quebec reverts every label to "QPP" ----
  await setProvince('quebec');
  const backToQc = await page.evaluate(() => ({
    inline: document.getElementById('qppInlineLabel').textContent,
    accHeader: document.getElementById('cppQppHeader').textContent,
  }));
  check('back to Quebec: inline label reverts to "QPP:"', backToQc.inline === 'QPP:');
  check('back to Quebec: Accumulation-tab header reverts to "QPP"', backToQc.accHeader === 'QPP');

  // ---- The chart's income dataset also relabels (checked without a real Chart.js) ----
  const chartLabelProv = await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'ontario';
    onProfileFieldChange();
    return _cppQppLabel();
  });
  check('_cppQppLabel() returns "CPP" for Ontario (drives the chart dataset label)', chartLabelProv === 'CPP');
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'quebec'; onProfileFieldChange(); });

  // ---- Editable "Amount at 65" input actually drives _getQPP() ----
  const amountDrive = await page.evaluate(() => {
    document.getElementById('qppBase65').value = 25000;
    return {
      at65: _getQPP(65, 65),
      at70: _getQPP(70, 70), // 25000 * (1 + 0.007*60) = 35500
    };
  });
  check('_getQPP(65,65) reflects the edited $25,000 base', amountDrive.at65 === 25000);
  check('_getQPP(70,70) applies the statutory deferral to the edited base (35,500)', amountDrive.at70 === 35500);

  // ---- Regression: test 01's exact old hardcoded numbers still come out
  // of the untouched default ($19,718) ----
  const stillMatchesOld = await page.evaluate(() => {
    document.getElementById('qppBase65').value = 19718;
    return { base65: _getQPP(65, 65), base70: _getQPP(70, 70) };
  });
  check('default $19,718 base still reproduces the old hardcoded 19,718 at 65', stillMatchesOld.base65 === 19718);
  check('default $19,718 base still reproduces the old hardcoded 28,000 at 70', stillMatchesOld.base70 === 28000);

  // ---- Persistence across reload: province and amount ----
  await page.evaluate(() => {
    document.getElementById('profileProvince').value = 'alberta';
    onProfileFieldChange();
    document.getElementById('qppBase65').value = 22000;
    _saveAccState();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => ({
    province: document.getElementById('profileProvince').value,
    amount: document.getElementById('qppBase65').value,
    header: document.getElementById('cppQppHeader').textContent,
  }));
  check('province (alberta) survives reload', afterReload.province === 'alberta');
  check('edited CPP/QPP amount (22000) survives reload', afterReload.amount === '22000');
  check('Accumulation-tab header still says "CPP" after reload (alberta)', afterReload.header === 'CPP');

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
