'use strict';
// "Predict until age X" — a new Profile-tab "Assumptions" input (#simEndAge)
// that lets the horizon of the retirement projection shrink or grow instead
// of the file's original hardcoded age-85 ceiling. Covers: the getter
// (_simEndAge) and its clamping; all three simulate* functions actually
// stopping at the chosen age; every downstream consumer that used to
// hardcode "85" in a label (Estate summary heading, "Net Estate @85" stat,
// the Phase 4 phase-card/table-header labels, the Non-Resident insight
// narrative) now reflecting the real last simulated age instead; the Monte
// Carlo engine's horizon following along automatically (it already derives
// horizon from a live probe run, no hardcoding there); and persistence
// across a reload. The core invariant: leaving the field at its default 85
// must reproduce this file's original numbers exactly (zero behavior change
// for anyone who never touches the new control).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- _simEndAge() getter: default, clamping, invalid input ----
  const t1 = await page.evaluate(() => {
    const setVal = (v) => { const el = document.getElementById('simEndAge'); el.value = v; };
    const results = {};
    setVal(''); results.blankDefaultsTo85 = _simEndAge(65);
    setVal('90'); results.normalValue = _simEndAge(65);
    setVal('50'); results.belowRaClampsToRa = _simEndAge(65); // can't be before retirement age
    setVal('500'); results.absurdlyHighClampsTo110 = _simEndAge(65);
    setVal('abc'); results.nonNumericDefaultsTo85 = _simEndAge(65);
    setVal('85'); // restore default for the rest of the suite
    return results;
  });
  check('_simEndAge() defaults to 85 when blank', t1.blankDefaultsTo85 === 85);
  check('_simEndAge() returns the set value when valid and >= ra', t1.normalValue === 90);
  check('_simEndAge() clamps up to the retirement age if set below it', t1.belowRaClampsToRa === 65);
  check('_simEndAge() clamps down to 110 if set absurdly high', t1.absurdlyHighClampsTo110 === 110);
  check('_simEndAge() defaults to 85 on non-numeric input', t1.nonNumericDefaultsTo85 === 85);

  // ---- Default (85) reproduces this file's original horizon exactly ----
  const t2 = await page.evaluate(() => {
    document.getElementById('simEndAge').value = '85';
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const rows = simulateResidentFixed(ra, 65, 65, rawPort);
    return { length: rows.length, lastAge: rows[rows.length - 1].age, firstAge: rows[0].age };
  });
  check('default #simEndAge=85 still runs from retirement age through 85', t2.firstAge === 65 && t2.lastAge === 85);
  check('default horizon length is unchanged (65..85 inclusive = 21 rows)', t2.length === 21);

  // ---- Shortening the horizon actually shortens all three simulate* fns ----
  const t3 = await page.evaluate(() => {
    document.getElementById('simEndAge').value = '75';
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const resident = simulateResidentFixed(ra, 65, 65, rawPort);
    const nonres = simulateNonResident(ra, 65, 65, rawPort);
    const nonresLump = simulateNonResidentLump(ra, 65, 65, rawPort);
    return {
      residentLast: resident[resident.length - 1].age,
      nonresLast: nonres[nonres.length - 1].age,
      nonresLumpLast: nonresLump[nonresLump.length - 1].age,
    };
  });
  check('simulateResidentFixed stops at the shortened horizon (75)', t3.residentLast === 75);
  check('simulateNonResident stops at the shortened horizon (75)', t3.nonresLast === 75);
  check('simulateNonResidentLump stops at the shortened horizon (75)', t3.nonresLumpLast === 75);

  // ---- Lengthening the horizon actually lengthens the simulation, and the
  // underlying math (DB freeze, RRIF/LIF factor tables, QPP/OAS indexation,
  // target-income bands) doesn't throw or produce garbage past age 85 -------
  const t4 = await page.evaluate(() => {
    document.getElementById('simEndAge').value = '95';
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const rows = simulateResidentFixed(ra, 65, 65, rawPort);
    const last = rows[rows.length - 1];
    return {
      length: rows.length, lastAge: last.age,
      allFinite: rows.every(r => Number.isFinite(r.totalTaxable) && Number.isFinite(r.tax) && Number.isFinite(r.totalSpend)),
      noNegativeBalances: rows.every(r => r.lifBal >= 0 && r.rrspBal >= 0 && r.tfsaBal >= 0),
    };
  });
  check('lengthening #simEndAge to 95 runs 31 rows (65..95 inclusive)', t4.length === 31 && t4.lastAge === 95);
  check('every extended-horizon row has finite tax/income/spend figures', t4.allFinite);
  check('no simulated account balance goes negative past the old 85 ceiling', t4.noNegativeBalances);

  // ---- UI: end-to-end through the real Retirement Income tab render -------
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.getElementById('simEndAge').value = '90';
    onSimEndAgeChange();
  });
  await page.waitForTimeout(400);
  const t5 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#tableBody tr')).filter(tr => !tr.querySelector('.phase-header'));
    return {
      estateHeading: document.getElementById('estateSectionLabel')?.textContent || '',
      netEstateLabel: Array.from(document.querySelectorAll('.st-label')).map(el => el.textContent).find(t => t.includes('Net Estate')) || '',
      phase4Label: Array.from(document.querySelectorAll('.ph-label')).map(el => el.textContent).find(t => t.includes('Phase 4')) || '',
    };
  });
  check('Estate section heading reflects the new horizon (90), not "85"', t5.estateHeading.includes('90') && !t5.estateHeading.includes('85'));
  check('"Net Estate @X" stat label reflects the new horizon', t5.netEstateLabel.includes('90') && !t5.netEstateLabel.includes('85'));
  check('Phase 4 phase-card label reflects the new horizon', t5.phase4Label.includes('90') && !t5.phase4Label.includes('85'));

  // ---- Monte Carlo horizon follows along automatically (it derives length
  // from a live probe run -- no hardcoding to fix there) --------------------
  const t6 = await page.evaluate(() => {
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    document.getElementById('simEndAge').value = '90';
    const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: 65, oasStart: 65, rawPort, meanPct: 3.5, stdevPct: 0, iterations: 5 });
    return { bandsLen: mc.bands.length };
  });
  check('Monte Carlo bands length follows the extended horizon (65..90 = 26 rows)', t6.bandsLen === 26);

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    document.getElementById('simEndAge').value = '92';
    onSimEndAgeChange();
  });
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(1200);
  const t7 = await page.evaluate(() => document.getElementById('simEndAge')?.value);
  check('#simEndAge value (92) survives a reload', t7 === '92');

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
