'use strict';
// Tier 2, updated 2026-09-11 for the removal of the precomputed static
// reference tables: the "Live simulation" vs "Reference data" badge is gone
// (everything is a live simulation now) -- the data-source badge always
// reads "● Live simulation", and its tooltip carries the remaining
// meaningful distinction instead: a real Accumulation-tab projection
// (liveData.fromAcc=true) vs the preset starting-portfolio estimate
// (fromAcc=false). The simulation sanity-check warning banner (must fire
// when the live sim's spend is unset despite a real portfolio, must NOT
// fire under normal filled-in-budget conditions) is unaffected in spirit,
// but now applies unconditionally (no more isLive gate) since every render
// is live.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // A fresh browser context has no localStorage, so fill in a realistic
  // budget first -- otherwise this test's own "normal" baseline would be an
  // artificially empty one that JP's real (already-filled-in) browser
  // never actually shows.
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 1500);
    fill('bud_houseMortgage_amt', 800);
    fill('bud_housePropTax_amt', 300);
    fill('bud_debtCC_amt', 100);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);
  // Editing the Budget tab doesn't auto-refresh an already-rendered
  // Retirement Income tab -- click the active age button again, same as a
  // real user would, to pick up the just-edited budget into the live sim.
  await page.evaluate(() => { document.querySelector('.age-btn.active')?.click(); });
  await page.waitForTimeout(300);

  const t1 = await page.evaluate(() => {
    const badge = document.getElementById('dataSourceBadge');
    const warn = document.getElementById('simSanityWarning');
    return { badgeText: badge?.textContent, badgeTitle: badge?.title, warnHidden: warn?.style.display === 'none', fromAcc: liveData ? liveData.fromAcc : null };
  });
  check('normal load (realistic budget, real Accumulation projection) shows the Live simulation badge', t1.badgeText === '● Live simulation');
  check('...with a real Accumulation-tab projection behind it', t1.fromAcc === true);
  check('...and the tooltip says so', t1.badgeTitle.includes('actual Accumulation-tab projection'));
  check('normal load (realistic budget): sanity warning stays hidden', t1.warnHidden);

  const t2 = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 63; renderAll(63);
    const badge = document.getElementById('dataSourceBadge');
    const warn = document.getElementById('simSanityWarning');
    return { badgeText: badge?.textContent, badgeTitle: badge?.title, warnHidden: warn?.style.display === 'none', fromAcc: liveData ? liveData.fromAcc : null };
  });
  check('cold-start (preset-estimate) mode still shows the Live simulation badge -- everything is live now', t2.badgeText === '● Live simulation');
  check('...but tagged as a preset estimate, not a real Accumulation-tab projection', t2.fromAcc === false);
  check('...and the tooltip says so', t2.badgeTitle.includes('preset starting-portfolio estimate'));
  check('cold-start (preset-estimate) mode: sanity warning stays hidden when the Budget tab is already filled in', t2.warnHidden);

  const t3 = await page.evaluate(() => {
    // Force the exact scenario that broke the first draft of the Tier 1b
    // fix: a live sim seeded from a portfolio while the Budget tab is
    // unfilled ($0 spend). The sanity banner should now catch this.
    document.querySelectorAll('[id^="bud_"][id$="_amt"]').forEach(el => { el.value = 0; el.dispatchEvent(new Event('input')); });
    const seed = PORTFOLIOS[62];
    runLiveSim(62, seed.lif, seed.rrsp, seed.tfsa, seed.nonreg || 0, seed.tfsaRoom ?? null);
    currentAge = 62; renderAll(62);
    const badge = document.getElementById('dataSourceBadge');
    const warn = document.getElementById('simSanityWarning');
    return { badgeText: badge?.textContent, warnDisplay: warn?.style.display, warnText: warn?.textContent };
  });
  check('forced unfilled-budget live sim shows the Live badge', t3.badgeText === '● Live simulation');
  check('forced unfilled-budget live sim triggers the sanity warning banner', t3.warnDisplay !== 'none' && t3.warnText.includes('Budget tab'));

  // ---- Across every age button, a freshly-seeded preset-estimate live sim
  // (with the Budget tab already filled back in) produces zero sanity
  // issues -- no false positives, replacing the old check against the
  // static reference table (now removed) with the same check against the
  // new live-seeded equivalent. ----
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 1500);
    fill('bud_houseMortgage_amt', 800);
    fill('bud_housePropTax_amt', 300);
    fill('bud_debtCC_amt', 100);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(200);
  const t4 = await page.evaluate(() => {
    return [55, 60, 61, 62, 63, 64, 65].map(ra => {
      lastAccRows = null; liveData = null; portfolioOverride = null;
      renderAll(ra);
      const comboKey = `${qppStart}_${oasStart}`;
      const DATA = liveData.data[spendMode][comboKey];
      return { ra, fromAcc: liveData.fromAcc, issueCount: _validateSimRows(DATA).length };
    });
  });
  check('every age button has a preset PORTFOLIOS entry, so all 7 seed successfully (fromAcc=false)', t4.every(r => r.fromAcc === false));
  check('preset-estimate data across every age (with a real budget filled in) produces zero sanity issues (no false positives)', t4.every(r => r.issueCount === 0));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
