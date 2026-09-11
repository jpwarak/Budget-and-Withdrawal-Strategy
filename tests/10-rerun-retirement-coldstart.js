'use strict';
// Tier 1b, updated 2026-09-11: the precomputed static reference tables
// (RESIDENT_DATA/NONRESIDENT_DATA) were removed entirely -- the Retirement
// Income tab now always runs a real live simulation. "Cold start" (no
// Accumulation-tab row matching the viewed age) used to mean liveData stayed
// null and the static table was shown instead; now it means renderAll()
// seeds a live sim from the preset starting-portfolio estimate (PORTFOLIOS)
// right away, tagged liveData.fromAcc=false. Only an age with NEITHER an
// Accumulation-tab row NOR a preset PORTFOLIOS entry has truly nothing to
// show -- that's covered by 37-always-live-no-static-tables.js.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);

  // ---- cold start (no Accumulation match, no prior liveData): renderAll()
  // now seeds a live sim immediately from the preset-estimate portfolio ----
  const before = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 62;
    document.querySelectorAll('.age-btn').forEach(b => { b.className = 'age-btn' + (parseInt(b.dataset.age) === 62 ? ' active' : ''); });
    renderAll(62);
    const comboKey = `${qppStart}_${oasStart}`;
    const row = liveData ? liveData.data[spendMode][comboKey][15] : null;
    return { liveDataRa: liveData ? liveData.ra : null, fromAcc: liveData ? liveData.fromAcc : null, totalTaxableYr15: row ? row.totalTaxable : null };
  });
  check('cold start no longer leaves liveData null -- it seeds a live sim from the preset estimate right away', before.liveDataRa === 62);
  check('that seeded sim is tagged fromAcc=false (preset estimate, not a real Accumulation-tab projection)', before.fromAcc === false);

  // ---- CPI-rate edit still takes effect (re-simulates the already-live data) ----
  const after = await page.evaluate(() => {
    const el = document.getElementById('cpiRate');
    el.value = (parseFloat(el.value) + 1.5).toString();
    el.dispatchEvent(new Event('change'));
    const comboKey = `${qppStart}_${oasStart}`;
    const liveRow = liveData ? liveData.data[spendMode][comboKey][15] : null;
    return { liveDataRa: liveData ? liveData.ra : null, fromAccStillFalse: liveData ? liveData.fromAcc === false : null, totalTaxableYr15: liveRow ? liveRow.totalTaxable : null };
  });
  check('CPI-rate edit under (now-live) cold start keeps liveData pointed at the same age', after.liveDataRa === 62);
  check('CPI-rate edit under cold start actually changes the displayed numbers', after.totalTaxableYr15 !== before.totalTaxableYr15);
  check('CPI-rate edit does not flip fromAcc from false to true (still a preset-estimate sim, just re-run)', after.fromAccStillFalse);

  // ---- growth-rate input triggers the same re-run path ----
  const growthTest = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 60; renderAll(60);
    const seededRa = liveData ? liveData.ra : null;
    const el = document.getElementById('retGrowthRate');
    el.value = (parseFloat(el.value) + 1.0).toString();
    el.dispatchEvent(new Event('change'));
    return { seededRa, afterRa: liveData ? liveData.ra : null };
  });
  check('growth-rate edit under cold start: renderAll(60) already seeded a live sim for age 60', growthTest.seededRa === 60);
  check('growth-rate edit keeps liveData pointed at that same age after re-running', growthTest.afterRa === 60);

  // ---- default display (no rate change) with no matching Accumulation row:
  // now shows a live preset-estimate sim, not a static/reference table ----
  const defaultDisplayTest = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 55;
    document.querySelector('.age-btn[data-age="55"]').click();
    return { liveDataRa: liveData ? liveData.ra : null, fromAcc: liveData ? liveData.fromAcc : null };
  });
  check('age-button click with no matching Accumulation row now seeds a live preset-estimate sim (age matches)', defaultDisplayTest.liveDataRa === 55);
  check('...tagged as an estimate, not a real accumulation projection', defaultDisplayTest.fromAcc === false);

  // ---- the real-Accumulation-data path is untouched by any of this ----
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);
  const normalPath = await page.evaluate(() => {
    if (!liveData) return { skipped: true };
    const wasFromAcc = liveData.fromAcc;
    const rawPortBefore = JSON.stringify(liveData.rawPort);
    const el = document.getElementById('cpiRate');
    el.value = (parseFloat(el.value) + 1.0).toString();
    el.dispatchEvent(new Event('change'));
    return { skipped: false, wasFromAcc, stillFromAcc: liveData.fromAcc, rawPortUnchanged: rawPortBefore === JSON.stringify(liveData.rawPort) };
  });
  check('real-Accumulation-data path re-simulates from the same rawPort, untouched by this change', normalPath.skipped || normalPath.rawPortUnchanged);
  check('real-Accumulation-data path keeps fromAcc=true across a rate-change re-run', normalPath.skipped || (normalPath.wasFromAcc === true && normalPath.stillFromAcc === true));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
