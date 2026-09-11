'use strict';
// "Individual account rate" (JP, picked from the roadmap's Remaining
// table). Per JP's own framing: the Accumulation phase used to use ONE
// global two-period glide path (Rate Period 1 for the first N years, then
// Rate Period 2 afterward -- the old accR1/accDur1/accR2 toolbar fields,
// shared by RRSP/TFSA/FHSA/DC Pension, with Non-Reg separately hardcoded to
// a flat, non-editable 2.5%) applied identically to every account. JP asked
// to remove the global rate and replace it with a per-account base rate for
// RRSP, TFSA, FHSA, DC Pension, and Non-Reg.
//
// Confirmed with JP (AskUserQuestion) before building: collapse each
// account to a SINGLE flat rate (not a per-account 2-period glide path) --
// simpler, matches "base rate" literally. So this is 5 new "Growth Rate"
// inputs (rrspRate/tfsaRate/fhsaRate/dcRate/nrRate) replacing the 3 old
// shared ones, not 15.
//
// Defaults chosen for the new fields (this session's call, not something
// JP specified a number for): RRSP/TFSA/FHSA/DC default to 6% (the old
// Period-1 rate -- the closest single-rate approximation of the old glide
// path, since collapsing to one rate necessarily changes any projection
// that used to cross into the old Period 2 partway through). Non-Reg
// defaults to 2.5%, exactly reproducing its old hardcoded flat rate byte
// for byte -- Non-Reg is the one account where "leave the new field at its
// default" really does mean "nothing changed".
const { openApp, finish } = require('./lib');

(async () => {
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });
  let anyConsoleErrors = false;

  const { browser, page, consoleErrors } = await openApp(process.argv[2]);

  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);

  // ---- Old shared glide-path fields are gone; new per-account fields
  // exist with the documented defaults. ----
  const t0 = await page.evaluate(() => ({
    oldR1: document.getElementById('accR1'),
    oldDur1: document.getElementById('accDur1'),
    oldR2: document.getElementById('accR2'),
    rrspRate: document.getElementById('rrspRate')?.value,
    tfsaRate: document.getElementById('tfsaRate')?.value,
    fhsaRate: document.getElementById('fhsaRate')?.value,
    dcRate: document.getElementById('dcRate')?.value,
    nrRate: document.getElementById('nrRate')?.value,
  }));
  check('old shared accR1 field is gone', t0.oldR1 === null);
  check('old shared accDur1 field is gone', t0.oldDur1 === null);
  check('old shared accR2 field is gone', t0.oldR2 === null);
  check('RRSP Growth Rate defaults to 6%', t0.rrspRate === '6');
  check('TFSA Growth Rate defaults to 6%', t0.tfsaRate === '6');
  check('FHSA Growth Rate defaults to 6%', t0.fhsaRate === '6');
  check('DC Pension Growth Rate defaults to 6%', t0.dcRate === '6');
  check('Non-Reg Growth Rate defaults to 2.5% (byte-identical to the old hardcoded flat rate)', t0.nrRate === '2.5');

  // ---- Each account's rate is genuinely independent: setting 5 different
  // values and re-running the projection reflects all 5, every year (no
  // more period-1/period-2 split -- a single flat rate applies uniformly
  // across the whole horizon). ----
  const t1 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    fill('rrspRate', 10);
    fill('tfsaRate', 8);
    fill('fhsaRate', 4);
    fill('dcRate', 2);
    fill('nrRate', 1);
    runAcc();
    return lastAccRows.map(r => ({
      age: r.age,
      rrsp: r.stats.rrsp.rate, tfsa: r.stats.tfsa.rate, fhsa: r.stats.fhsa.rate,
      dc: r.stats.dc.rate, nr: r.stats.nr.rate,
    }));
  });
  check('lastAccRows has multiple years to check (test is meaningful)', t1.length > 5);
  check('RRSP reflects its own entered rate (10%) every year', t1.every(r => Math.abs(r.rrsp - 0.10) < 1e-9));
  check('TFSA reflects its own entered rate (8%) every year', t1.every(r => Math.abs(r.tfsa - 0.08) < 1e-9));
  check('FHSA reflects its own entered rate (4%) every year', t1.every(r => Math.abs(r.fhsa - 0.04) < 1e-9));
  check('DC Pension reflects its own entered rate (2%) every year', t1.every(r => Math.abs(r.dc - 0.02) < 1e-9));
  check('Non-Reg reflects its own entered rate (1%) every year -- genuinely editable now, not hardcoded', t1.every(r => Math.abs(r.nr - 0.01) < 1e-9));
  check('rates never change partway through the horizon (no leftover period-1/period-2 split)',
    new Set(t1.map(r=>r.rrsp)).size === 1 && new Set(t1.map(r=>r.nr)).size === 1);

  // ---- Non-Reg's rate actually drives its balance growth now (it used to
  // be a hardcoded internal constant with no input at all). ----
  const t2 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    fill('nrBal', 10000);
    fill('nrAnnual', 0);
    fill('nrBiweekly', 0);
    fill('nrRate', 0);
    runAcc();
    const flatRow = lastAccRows[1]; // one year in, no contributions, 0% rate -> balance unchanged
    fill('nrRate', 20);
    runAcc();
    const grownRow = lastAccRows[1];
    return { flatBal: flatRow.nr, grownBal: grownRow.nr };
  });
  check('Non-Reg balance stays flat at 0% growth with no contributions', t2.flatBal === 10000);
  check('Non-Reg balance actually grows when its rate is raised (proves nrRate really drives the math)', t2.grownBal > t2.flatBal);

  // ---- Persistence across a reload. ----
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    fill('rrspRate', 7.25);
    fill('tfsaRate', 5.5);
    fill('fhsaRate', 4.25);
    fill('dcRate', 3.75);
    fill('nrRate', 1.5);
  });
  await page.waitForTimeout(500); // let the 300ms debounced _saveAccState() fire
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);
  const t3 = await page.evaluate(() => ({
    rrspRate: document.getElementById('rrspRate')?.value,
    tfsaRate: document.getElementById('tfsaRate')?.value,
    fhsaRate: document.getElementById('fhsaRate')?.value,
    dcRate: document.getElementById('dcRate')?.value,
    nrRate: document.getElementById('nrRate')?.value,
  }));
  check('RRSP rate survives a reload', t3.rrspRate === '7.25');
  check('TFSA rate survives a reload', t3.tfsaRate === '5.5');
  check('FHSA rate survives a reload', t3.fhsaRate === '4.25');
  check('DC Pension rate survives a reload', t3.dcRate === '3.75');
  check('Non-Reg rate survives a reload', t3.nrRate === '1.5');

  check('no console errors (part 1)', consoleErrors.length === 0);
  if (consoleErrors.length) { anyConsoleErrors = true; console.log('Console errors (part 1):', consoleErrors.slice(0,5)); }
  await browser.close();

  // ---- Part 2: a plan saved before this feature existed (an old accState
  // blob with only the legacy accR1/accDur1/accR2 keys, no per-account rate
  // keys at all) falls back cleanly to the new fields' HTML defaults on a
  // FRESH page load, not NaN/blank -- the old keys are simply ignored now
  // (harmless leftover data), matching this app's usual backward-
  // compatibility convention. Needs its own fresh browser: the fallback
  // only shows up on the DOM's untouched HTML-default value, which part 1
  // already overwrote. ----
  const legacyAccData = {
    accCurAge: '50', accStartMonth: '9', accStartYear: '2026',
    accEndMonth: '6', accEndYear: '2043',
    accR1: '6', accDur1: '15', accR2: '3.5', // legacy leftover keys, now unused
    rrspBal: '12310', rrspAnnual: '0', rrspBiweekly: '270', rrspCap: '0', rrspOverflow: 'tfsa',
    tfsaBal: '3795', tfsaAnnual: '5000', tfsaBiweekly: '270', tfsaCap: '95000', tfsaOverflow: 'nr',
    fhsaBal: '3793', fhsaAnnual: '8000', fhsaBiweekly: '0', fhsaCap: '40000', fhsaOverflow: 'rrsp', fhsaRoll: 'yes', fhsaRollYrs: '15',
    dcBal: '235757', dcAnnual: '0', dcBiweekly: '0',
    nrBal: '0', nrAnnual: '0', nrBiweekly: '0',
  };
  const seeded = await openApp(process.argv[2], {
    seedLocalStorage: { plannerState: JSON.stringify({ v: 1, ret: {}, budget: {}, nav: {}, acc: { data: legacyAccData } }) },
  });
  await seeded.page.evaluate(() => { showTab('acc'); });
  await seeded.page.waitForTimeout(300);
  const t4 = await seeded.page.evaluate(() => ({
    rrspRate: document.getElementById('rrspRate').value,
    tfsaRate: document.getElementById('tfsaRate').value,
    fhsaRate: document.getElementById('fhsaRate').value,
    dcRate: document.getElementById('dcRate').value,
    nrRate: document.getElementById('nrRate').value,
    rrspBal: document.getElementById('rrspBal').value, // sanity: the legacy blob's own fields DID restore
  }));
  check("a pre-feature saved plan (no rate keys) falls back to RRSP's 6% HTML default", t4.rrspRate === '6');
  check("a pre-feature saved plan (no rate keys) falls back to TFSA's 6% HTML default", t4.tfsaRate === '6');
  check("a pre-feature saved plan (no rate keys) falls back to FHSA's 6% HTML default", t4.fhsaRate === '6');
  check("a pre-feature saved plan (no rate keys) falls back to DC Pension's 6% HTML default", t4.dcRate === '6');
  check("a pre-feature saved plan (no rate keys) falls back to Non-Reg's 2.5% HTML default", t4.nrRate === '2.5');
  check('sanity: the rest of the legacy blob really did restore (proves this is a real load, not an empty one)', t4.rrspBal === '12310');

  check('no console errors (part 2)', seeded.consoleErrors.length === 0);
  if (seeded.consoleErrors.length) { anyConsoleErrors = true; console.log('Console errors (part 2):', seeded.consoleErrors.slice(0,5)); }
  await seeded.browser.close();

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  const ok = failed.length === 0 && !anyConsoleErrors;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
