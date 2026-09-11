'use strict';
// Phase 3b: the three non-resident Part XIII withholding rates (pension/
// RRIF/LIF flat-tax rate used in _calcTaxDetailNonResident, and the dividend/
// interest rates used in _nonregTaxSplit's isNonRes branch) are now editable on
// the Profile tab instead of hardcoded 0.25 literals. Each defaults to 25%
// when its field is left blank, so an untouched planner must reproduce
// EXACTLY the numbers it always produced (25% happens to already be the
// correct Philippines rate). This suite checks: the getters' blank/invalid/
// valid-value behavior, that a custom rate actually changes both tax
// functions' output, that the numbers for a blank rate exactly match a
// hand-computed 25% reference, UI wiring (card visibility, persistence
// across reload), and that the insight-box/table/lump-breakdown text no
// longer hardcodes "25%" but reflects whatever rate is configured.
const { openApp } = require('./lib');

(async () => {
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  const { browser, page, consoleErrors } = await openApp(process.argv[2]);

  // ---- Fresh browser: card hidden while Resident, inputs exist ----
  const fresh = await page.evaluate(() => ({
    cardHiddenWhileResident: document.getElementById('nrRatesCard')?.style.display === 'none',
    hasPensionInput: !!document.getElementById('nrPensionRate'),
    hasDividendInput: !!document.getElementById('nrDividendRate'),
    hasInterestInput: !!document.getElementById('nrInterestRate'),
    pensionPlaceholder: document.getElementById('nrPensionRate')?.placeholder,
    dividendPlaceholder: document.getElementById('nrDividendRate')?.placeholder,
    interestPlaceholder: document.getElementById('nrInterestRate')?.placeholder,
  }));
  check('fresh browser: rates card is hidden while Resident', fresh.cardHiddenWhileResident);
  check('fresh browser: all three rate inputs exist', fresh.hasPensionInput && fresh.hasDividendInput && fresh.hasInterestInput);
  check('fresh browser: all three inputs placeholder-hint the 25% default', fresh.pensionPlaceholder === '25' && fresh.dividendPlaceholder === '25' && fresh.interestPlaceholder === '25');

  // ---- Switching to expat reveals the card ----
  const toExpat = await page.evaluate(() => {
    document.getElementById('profileResidency').value = 'expat';
    onProfileResidencyChange();
    return { cardVisible: document.getElementById('nrRatesCard').style.display !== 'none' };
  });
  check('switching to Non-Resident reveals the rates card', toExpat.cardVisible);

  // ---- Getter behavior: blank / invalid / valid ----
  const getterTests = await page.evaluate(() => {
    const setAndRead = (id, val, fn) => {
      document.getElementById(id).value = val;
      return window[fn]();
    };
    return {
      blankPension: setAndRead('nrPensionRate', '', '_nrPensionRate'),
      invalidPension: setAndRead('nrPensionRate', 'abc', '_nrPensionRate'),
      validPension: setAndRead('nrPensionRate', '15', '_nrPensionRate'),
      zeroPension: setAndRead('nrPensionRate', '0', '_nrPensionRate'),
      blankDividend: setAndRead('nrDividendRate', '', '_nrDividendRate'),
      validDividend: setAndRead('nrDividendRate', '15', '_nrDividendRate'),
      blankInterest: setAndRead('nrInterestRate', '', '_nrInterestRate'),
      validInterest: setAndRead('nrInterestRate', '10', '_nrInterestRate'),
    };
  });
  check('_nrPensionRate() defaults to 0.25 when blank', getterTests.blankPension === 0.25);
  check('_nrPensionRate() defaults to 0.25 when non-numeric', getterTests.invalidPension === 0.25);
  check('_nrPensionRate() reads "15" as 0.15', getterTests.validPension === 0.15);
  check('_nrPensionRate() reads explicit "0" as 0 (not falling back to default)', getterTests.zeroPension === 0);
  check('_nrDividendRate() defaults to 0.25 when blank, reads "15" as 0.15', getterTests.blankDividend === 0.25 && getterTests.validDividend === 0.15);
  check('_nrInterestRate() defaults to 0.25 when blank, reads "10" as 0.10', getterTests.blankInterest === 0.25 && getterTests.validInterest === 0.10);

  // Reset all three back to blank for the next section.
  await page.evaluate(() => {
    ['nrPensionRate', 'nrDividendRate', 'nrInterestRate'].forEach(id => { document.getElementById(id).value = ''; });
  });

  // ---- _calcTaxDetailNonResident: blank reproduces the old hardcoded-25% numbers exactly ----
  const taxDefault = await page.evaluate(() => {
    const incomes = [20000, 50000, 90000, 150000];
    return incomes.map(inc => {
      const det = _calcTaxDetailNonResident(inc, 65);
      // Hand-computed reference using the exact old hardcoded formula.
      const otherCredits = 2200 * _idxFactor(65);
      const fedGross = _bracketTax(inc, _idxBrackets(FED_BRACKETS, 65));
      const fedBpaCredit = _fedBPA(inc, 65) * FED_BRACKETS[0].rate;
      const netBasicFed = Math.max(0, fedGross - fedBpaCredit - otherCredits);
      const electedTotal = Math.round(netBasicFed * 1.48);
      const flatTotal = Math.round(inc * 0.25);
      const useFlat = flatTotal < electedTotal;
      const total = useFlat ? flatTotal : electedTotal;
      return { inc, matches: det.total === Math.round(total) && det.method === (useFlat ? 'flat25' : 's217') };
    });
  });
  check('_calcTaxDetailNonResident with blank rate matches the old hardcoded-25% formula at every tested income', taxDefault.every(r => r.matches));

  // ---- _calcTaxDetailNonResident: a custom rate actually changes the flat-tax path ----
  const taxCustom = await page.evaluate(() => {
    document.getElementById('nrPensionRate').value = '15';
    const inc = 20000;
    const det15 = _calcTaxDetailNonResident(inc, 65);
    document.getElementById('nrPensionRate').value = '';
    const det25 = _calcTaxDetailNonResident(inc, 65);
    document.getElementById('nrPensionRate').value = '15';
    // Separately confirm the custom rate actually WINS (drives `total`, not
    // just sitting unused in `flatTax`) at an income high enough that flat
    // withholding beats the S.217 election either way.
    const incHigh = 400000;
    const detHigh = _calcTaxDetailNonResident(incHigh, 65);
    return {
      flat15: det15.flatTax, flat25: det25.flatTax,
      expected15: Math.round(inc * 0.15), expected25: Math.round(inc * 0.25),
      methodHigh: detHigh.method, totalHigh: detHigh.total, flatTaxHigh: detHigh.flatTax,
    };
  });
  check('a custom 15% pension rate changes flatTax vs the 25% default', taxCustom.flat15 === taxCustom.expected15 && taxCustom.flat25 === taxCustom.expected25 && taxCustom.flat15 !== taxCustom.flat25);
  check('at a high enough income the custom flat rate wins outright and total reflects it', taxCustom.methodHigh === 'flat25' && taxCustom.totalHigh === taxCustom.flatTaxHigh);

  await page.evaluate(() => { document.getElementById('nrPensionRate').value = ''; });

  // ---- _nonregTaxSplit: blank reproduces the old hardcoded 25%/25% split; a custom rate changes it ----
  const nonregTest = await page.evaluate(() => {
    // Give the Non-Reg mix real dividend/interest exposure -- the default
    // mix is 100% growth/0% dividend/0% interest, under which both rates
    // would be multiplied by $0 and this comparison would be a tautology.
    document.getElementById('nonregMixGrowth').value = '40';
    document.getElementById('nonregMixCanDiv').value = '30';
    document.getElementById('nonregMixForeign').value = '0';
    document.getElementById('nonregMixInterest').value = '30';
    document.getElementById('nrDividendRate').value = '';
    document.getElementById('nrInterestRate').value = '';
    const base = 200000, priorGross = 60000, age = 65;
    const splitDefault = _nonregTaxSplit(base, priorGross, age, true);
    document.getElementById('nrDividendRate').value = '10';
    document.getElementById('nrInterestRate').value = '5';
    const splitCustom = _nonregTaxSplit(base, priorGross, age, true);
    document.getElementById('nrDividendRate').value = '';
    document.getElementById('nrInterestRate').value = '';
    return {
      taxPaidDefault: splitDefault.taxPaid,
      taxPaidCustom: splitCustom.taxPaid,
      different: splitDefault.taxPaid !== splitCustom.taxPaid,
      customIsLower: splitCustom.taxPaid < splitDefault.taxPaid, // 10%/5% < 25%/25%
    };
  });
  check('_nonregTaxSplit (isNonRes) with blank dividend/interest rates differs from a lower custom rate', nonregTest.different && nonregTest.customIsLower);

  // ---- End-to-end: a full simulation run with a custom pension rate produces different (lower) lifetime tax than the 25% default ----
  const simCompare = await page.evaluate(() => {
    const port = { lif: 500000, rrsp: 250000, tfsa: 200000 };
    document.getElementById('nrPensionRate').value = '';
    const rowsDefault = simulateNonResident(65, 65, 65, port);
    document.getElementById('nrPensionRate').value = '10';
    const rowsCustom = simulateNonResident(65, 65, 65, port);
    document.getElementById('nrPensionRate').value = '';
    const taxDefaultTotal = rowsDefault.reduce((s, r) => s + (r.tax || 0), 0);
    const taxCustomTotal = rowsCustom.reduce((s, r) => s + (r.tax || 0), 0);
    return { taxDefaultTotal, taxCustomTotal, isLower: taxCustomTotal < taxDefaultTotal };
  });
  check('a full simulateNonResident() run with a 10% pension rate produces less lifetime tax than the 25% default', simCompare.isLower);

  // ---- Dynamic UI text: no more hardcoded "25%" once a custom rate is set ----
  await page.evaluate(() => {
    document.getElementById('nrUnlockFull').checked = true;
    onNrLifUnlockChange();
  });
  await page.waitForTimeout(300);
  const uiTextDefault = await page.evaluate(() => document.getElementById('insightBox').innerHTML + (document.getElementById('lumpBreakdown')?.innerHTML || ''));
  const uiTextCustom = await page.evaluate(() => {
    document.getElementById('nrPensionRate').value = '12';
    onNrRateChange();
    return null;
  });
  await page.waitForTimeout(300);
  const uiTextAfter = await page.evaluate(() => document.getElementById('insightBox').innerHTML + (document.getElementById('lumpBreakdown')?.innerHTML || ''));
  check('insight/lump-breakdown text mentions the custom 12% rate after it is set', uiTextAfter.includes('Flat 12%') && uiTextAfter.includes('flat 12%'));
  check('insight/lump-breakdown text no longer shows the actual withholding as "Flat 25%" once a custom rate is set', !uiTextAfter.includes('Flat 25%') && !uiTextAfter.includes('flat 25%'));
  check('(sanity) the default-rate text did show the actual withholding as "Flat 25%", proving this is a real behavior change, not a tautology', uiTextDefault.includes('Flat 25%') && uiTextDefault.includes('flat 25%'));

  await page.evaluate(() => { document.getElementById('nrPensionRate').value = ''; onNrRateChange(); });

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    document.getElementById('nrPensionRate').value = '18';
    document.getElementById('nrDividendRate').value = '20';
    document.getElementById('nrInterestRate').value = '22';
    onNrRateChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => ({
    pension: document.getElementById('nrPensionRate')?.value,
    dividend: document.getElementById('nrDividendRate')?.value,
    interest: document.getElementById('nrInterestRate')?.value,
    cardVisible: document.getElementById('nrRatesCard')?.style.display !== 'none',
  }));
  check('pension rate "18" survives reload', afterReload.pension === '18');
  check('dividend rate "20" survives reload', afterReload.dividend === '20');
  check('interest rate "22" survives reload', afterReload.interest === '22');
  check('rates card is still visible after reload (residency "expat" also persisted)', afterReload.cardVisible);

  // ---- Blank-field round trip: clearing a field back to '' persists as blank, not "25" ----
  await page.evaluate(() => {
    document.getElementById('nrPensionRate').value = '';
    onNrRateChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterClear = await page.evaluate(() => document.getElementById('nrPensionRate')?.value);
  check('clearing the pension-rate field back to blank stays blank across reload (shows the placeholder, not "25")', afterClear === '');

  const allConsoleErrors = consoleErrors.length;
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${allConsoleErrors}`);
  console.log(fail === 0 && allConsoleErrors === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && allConsoleErrors === 0 ? 0 : 1);
})();
