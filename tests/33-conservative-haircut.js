'use strict';
// The tax-bracket/QPP/OAS "conservative rate" haircut (CONSERVATIVE_HAIRCUT)
// was re-examined against real 2015-2025 federal/QC/ON/BC/AB indexation-vs-
// CPI history (JP: "we are too aggressive with the tax bracket increase...
// study previous years"). Finding: the original 0.4pp figure overstated the
// historical shortfall for 3 of the 4 provinces this app supports (federal/
// Ontario/BC all averaged an essentially ZERO gap over the decade; only
// Alberta showed a real, but freeze-driven rather than smooth, lag). JP's
// call once shown the numbers: shrink it. This file locks in the new value
// (0.15pp) and the mechanism it drives, so a future edit can't silently
// widen or narrow the haircut without a test noticing.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  const t1 = await page.evaluate(() => ({
    haircut: CONSERVATIVE_HAIRCUT,
    cpiDefault: _cpiRate(),
    conservativeDefault: _conservativeRate(),
  }));
  check('CONSERVATIVE_HAIRCUT is now 0.15 percentage points (0.0015), not the old 0.4pp (0.004)', Math.abs(t1.haircut - 0.0015) < 1e-9);
  check('default CPI rate is still 2.5% (this change only touches the haircut, not the base assumption)', Math.abs(t1.cpiDefault - 0.025) < 1e-9);
  check('default conservative rate is 2.35% (2.5% - 0.15pp)', Math.abs(t1.conservativeDefault - 0.0235) < 1e-9);

  // ---- _conservativeRate() floors at 0, same as before the change --------
  const t2 = await page.evaluate(() => {
    document.getElementById('cpiRate').value = '0.1'; // below the haircut itself
    const r = _conservativeRate();
    document.getElementById('cpiRate').value = '2.5'; // restore
    return r;
  });
  check('_conservativeRate() still floors at 0 when CPI is smaller than the haircut', t2 === 0);

  // ---- The smaller haircut produces a real, measurably higher (closer-to-
  // CPI) indexation factor over a multi-decade horizon than the old 0.4pp
  // would have -- confirming the shrink actually changes projected numbers,
  // not just the constant in isolation. -----------------------------------
  const t3 = await page.evaluate(() => {
    const oldHaircut = 0.004, newHaircut = CONSERVATIVE_HAIRCUT;
    const cpi = _cpiRate();
    const years = 20;
    const oldFactor = Math.pow(1 + Math.max(0, cpi - oldHaircut), years);
    const newFactor = Math.pow(1 + Math.max(0, cpi - newHaircut), years);
    const actualFactor = _idxFactor(_personAge() + years);
    return { oldFactor, newFactor, actualFactor };
  });
  check('20-year indexation factor is now higher than the old 0.4pp haircut would have produced', t3.newFactor > t3.oldFactor);
  check('_idxFactor() actually uses the new (smaller) haircut, matching the hand-computed new factor', Math.abs(t3.actualFactor - t3.newFactor) < 1e-9);

  // ---- End-to-end: OAS/QPP benefit growth and the OAS clawback threshold
  // (both driven by _conservativeRate()) reflect the new, slightly higher
  // growth rate -- these are the real user-facing numbers this change
  // touches, not just the internal helper. --------------------------------
  const t4 = await page.evaluate(() => {
    const oasStart = 65, futureAge = 85; // 20 years of indexation
    const oasAtStart = _getOAS(oasStart, oasStart);
    const oasLater = _getOAS(futureAge, oasStart);
    const threshAtStart = _oasThresh(oasStart);
    const threshLater = _oasThresh(futureAge);
    return { oasGrowthRatio: oasLater / oasAtStart, threshGrowthRatio: threshLater / threshAtStart };
  });
  const expectedRatio = Math.pow(1.0235, 20); // 2.5% CPI - 0.15pp haircut, 20 years
  check('OAS benefit growth over 20 years matches the new 2.35% conservative rate', Math.abs(t4.oasGrowthRatio - expectedRatio) / expectedRatio < 0.01);
  check('OAS clawback threshold growth over 20 years matches the new 2.35% conservative rate', Math.abs(t4.threshGrowthRatio - expectedRatio) / expectedRatio < 0.01);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
