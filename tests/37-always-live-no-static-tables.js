'use strict';
// 2026-09-11: removed the precomputed static reference tables
// (RESIDENT_DATA/NONRESIDENT_DATA) entirely, at JP's request -- "remove any
// reference to static tables ... always rely on live data. if live data is
// unavailable ... provide a message to inform the user to fill in the
// missing data." The Retirement Income tab now always runs a real live
// simulation, seeded from the Accumulation tab's actual projection when one
// exists for the viewed age, or from the preset starting-portfolio estimate
// (PORTFOLIOS) otherwise (liveData.fromAcc distinguishes the two). Only when
// NEITHER exists does it show a banner asking for the missing data instead
// of guessing at numbers.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- The static tables are really gone, not just unused ----
  const t1 = await page.evaluate(() => ({
    residentDataUndefined: typeof RESIDENT_DATA === 'undefined',
    nonresidentDataUndefined: typeof NONRESIDENT_DATA === 'undefined',
  }));
  check('RESIDENT_DATA no longer exists as a global', t1.residentDataUndefined);
  check('NONRESIDENT_DATA no longer exists as a global', t1.nonresidentDataUndefined);

  // ---- Every default age button seeds a live simulation, none left null ----
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  const t2 = await page.evaluate(() => {
    return [55, 60, 61, 62, 63, 64, 65].map(ra => {
      lastAccRows = null; liveData = null; portfolioOverride = null;
      renderAll(ra);
      return { ra, seeded: !!(liveData && liveData.ra === ra), fromAcc: liveData ? liveData.fromAcc : null };
    });
  });
  check('every default age button (55, 60-65) seeds a live sim -- none fall back to "no data"', t2.every(r => r.seeded));
  check('all seeded from the preset estimate (no Accumulation-tab data forced out in this test)', t2.every(r => r.fromAcc === false));

  // ---- Missing-portfolio banner: an age with neither an Accumulation row
  // nor a preset PORTFOLIOS entry shows a clear message instead of numbers ----
  const t3 = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    renderAll(58); // no age-58 button, no PORTFOLIOS[58] entry
    const banner = document.getElementById('missingPortfolioBanner');
    const lower = document.getElementById('retLowerContent');
    return {
      liveDataStillMissing: !(liveData && liveData.ra === 58),
      bannerVisible: banner && banner.style.display !== 'none',
      bannerMentionsAge: (banner?.textContent || '').includes('58'),
      bannerMentionsAccumulation: (banner?.textContent || '').toLowerCase().includes('accumulation'),
      lowerContentHidden: lower && lower.style.display === 'none',
      ageSummaryEmpty: (document.getElementById('ageSummary')?.innerHTML || '') === '',
      warnHidden: document.getElementById('simSanityWarning')?.style.display === 'none',
    };
  });
  check('an age with no portfolio data at all leaves liveData not pointing at it', t3.liveDataStillMissing);
  check('the missing-portfolio banner becomes visible', t3.bannerVisible);
  check('the banner names the specific age that has no data', t3.bannerMentionsAge);
  check('the banner tells the user what to do (run an Accumulation projection)', t3.bannerMentionsAccumulation);
  check('the numbers/charts/table area is hidden while the banner is showing', t3.lowerContentHidden);
  check('the age summary stats are cleared, not left showing stale numbers', t3.ageSummaryEmpty);
  check('the sanity-check warning is hidden (nothing to validate) while the banner is showing', t3.warnHidden);

  // ---- Returning to a valid age clears the banner and restores content ----
  const t4 = await page.evaluate(() => {
    document.querySelector('.age-btn[data-age="62"]').click();
    const banner = document.getElementById('missingPortfolioBanner');
    const lower = document.getElementById('retLowerContent');
    return {
      liveDataRa: liveData ? liveData.ra : null,
      bannerHidden: banner && banner.style.display === 'none',
      lowerContentVisible: lower && lower.style.display !== 'none',
      ageSummaryHasContent: (document.getElementById('ageSummary')?.innerHTML || '').length > 100,
    };
  });
  check('clicking a normal age button re-seeds live data for it', t4.liveDataRa === 62);
  check('the missing-portfolio banner hides again', t4.bannerHidden);
  check('the numbers/charts/table area reappears', t4.lowerContentVisible);
  check('the age summary is repopulated with real content', t4.ageSummaryHasContent);

  // ---- The data-source badge collapses to one state, but its tooltip still
  // distinguishes a real Accumulation projection from a preset estimate ----
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 1500);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(200);
  const t5 = await page.evaluate(() => {
    // t2/t3/t4 above nulled lastAccRows without restoring it -- repopulate a
    // real Accumulation-tab projection first so "real projection" here is
    // actually real, not another preset-estimate fallback in disguise.
    runAcc();
    document.querySelector('.age-btn.active')?.click();
    const realBadge = { text: document.getElementById('dataSourceBadge')?.textContent, title: document.getElementById('dataSourceBadge')?.title, fromAcc: liveData.fromAcc };
    lastAccRows = null; liveData = null; portfolioOverride = null;
    renderAll(currentAge);
    const estBadge = { text: document.getElementById('dataSourceBadge')?.textContent, title: document.getElementById('dataSourceBadge')?.title, fromAcc: liveData.fromAcc };
    return { realBadge, estBadge };
  });
  check('badge text is identical either way (single "Live simulation" state)', t5.realBadge.text === '● Live simulation' && t5.estBadge.text === '● Live simulation');
  check('real-projection tooltip mentions the Accumulation-tab projection', t5.realBadge.fromAcc === true && t5.realBadge.title.includes('Accumulation-tab projection'));
  check('preset-estimate tooltip mentions the preset estimate instead', t5.estBadge.fromAcc === false && t5.estBadge.title.includes('preset starting-portfolio estimate'));

  // ---- rerunRetirement() (CPI/growth-rate edits) preserves fromAcc across
  // a re-run instead of losing it (runLiveSim replaces liveData wholesale) ----
  const t6 = await page.evaluate(() => {
    runAcc(); // repopulate lastAccRows (see t5's comment above)
    document.querySelector('.age-btn.active')?.click(); // real accumulation data for currentAge
    const before = liveData.fromAcc;
    const el = document.getElementById('cpiRate');
    el.value = (parseFloat(el.value) + 0.5).toString();
    el.dispatchEvent(new Event('change'));
    return { before, after: liveData.fromAcc };
  });
  check('fromAcc survives a rerunRetirement() re-run (CPI-rate edit) unchanged', t6.before === true && t6.after === true);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
