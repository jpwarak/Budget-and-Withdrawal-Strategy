'use strict';
// Tier 3: "Realistic tax modeling (beta)" for the Non-Registered account.
// Opt-in, off by default (Accumulation tab, Non-Reg card). Covers:
//  - _nonregMix() normalizes composition inputs to fractions summing to 1
//    regardless of what the raw % inputs add up to.
//  - Toggle OFF fully insulates the simulation from the new inputs (mix,
//    pre-tax return) -- proving this is truly additive, not just "usually
//    the same by coincidence".
//  - Toggle ON: a 100%-growth composition has zero annual tax drag in BOTH
//    modes (deferred gains are never taxed annually); Canadian dividends and
//    interest do get taxed annually in resident mode, with dividends
//    taxed lower than interest (real DTC mechanics); Non-Resident mode
//    taxes dividends/interest at a flat 25% and foreign income/growth at $0.
//  - The ACB-based capital-gains-on-withdrawal tax: only fires in resident mode,
//    only when useRealisticNonreg is on, and only when there's an actual
//    embedded gain (0% starting gain -> $0 extra tax, proving it's wired to
//    the real ACB math and not just a flat penalty).
//  - computeEstate()'s death-tax: real marginal-rate-based tax in resident mode,
//    always $0 for Non-Resident (public-securities exemption).
//  - UI: checkbox reveals the composition panel, the composition-sum warning
//    fires/clears correctly, and the toggle's state persists across reload.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);

  // --- _nonregMix() normalization ------------------------------------------
  const tMix = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    fill('nonregMixGrowth', 50); fill('nonregMixCanDiv', 30); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const m1 = _nonregMix();
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const m2 = _nonregMix();
    return { m1, m2 };
  });
  check('_nonregMix() normalizes a non-100 sum (50/30) to fractions summing to 1', Math.abs((tMix.m1.growth+tMix.m1.canDiv+tMix.m1.foreign+tMix.m1.interest)-1) < 1e-9);
  check('_nonregMix() normalized growth fraction matches 50/(50+30)', Math.abs(tMix.m1.growth-0.625) < 1e-9);
  check('_nonregMix() falls back to 100% growth when every input is 0', tMix.m2.growth===1 && tMix.m2.canDiv===0);

  // --- Toggle OFF fully insulates the sim from the new inputs --------------
  const tOff = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    nonregRealisticTax = false;
    const port = { lif:300000, rrsp:200000, tfsa:100000, nonreg:150000 };
    fill('nonregMixGrowth', 100); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    fill('nonregPretaxReturn', 1); fill('nonregStartGainPct', 0);
    const rowsA = simulateResidentFixed(65, 65, 65, port);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 100);
    fill('nonregPretaxReturn', 50); fill('nonregStartGainPct', 100);
    const rowsB = simulateResidentFixed(65, 65, 65, port);
    const identical = rowsA.every((r,i) => r.nonregBal===rowsB[i].nonregBal && r.nonregInt===rowsB[i].nonregInt && r.totalSpend===rowsB[i].totalSpend);
    return { identical };
  });
  check('toggle OFF: wildly different mix/pretax-return/start-gain inputs have zero effect on the simulation (fully gated)', tOff.identical);

  // --- Toggle ON: growth-only bucket has zero annual tax drag, both modes --
  const tGrowthOnly = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    nonregRealisticTax = true;
    fill('nonregMixGrowth', 100); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    fill('nonregPretaxReturn', 6); fill('nonregStartGainPct', 0);
    const port = { lif:300000, rrsp:200000, tfsa:100000, nonreg:150000 };
    const rowsResident = simulateResidentFixed(65, 65, 65, port);
    const rowsNonRes  = simulateNonResident(65, 65, 65, port);
    const check1 = rows => rows.slice(0, -1).every(r => {
      const base = r.nonregBal - r.nonreg + r.nonregDeposit;
      const expected = Math.round(base * 0.06);
      return Math.abs(r.nonregInt - expected) <= 2;
    });
    return { residentOk: check1(rowsResident), nonResOk: check1(rowsNonRes) };
  });
  check('toggle ON, 100% growth composition: resident nonregInt matches base*pretaxReturn exactly (no annual tax on deferred gains)', tGrowthOnly.residentOk);
  check('toggle ON, 100% growth composition: Non-Resident nonregInt matches base*pretaxReturn exactly (never taxed for a non-resident)', tGrowthOnly.nonResOk);

  // --- Resident: dividends taxed less than interest at the same pretax amount ---
  const tResidentDivVsInt = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    fill('nonregPretaxReturn', 6);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 100); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const div = _nonregTaxSplit(100000, 80000, 65, false);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 100);
    const int = _nonregTaxSplit(100000, 80000, 65, false);
    return { divTax: div.taxPaid, intTax: int.taxPaid, divInt: div.nonregInt, intInt: int.nonregInt };
  });
  check('Resident: both Canadian dividends and interest incur some annual tax on the same pretax amount', tResidentDivVsInt.divTax>0 && tResidentDivVsInt.intTax>0);
  check('Resident: Canadian eligible dividends are taxed less than interest (dividend tax credit effect)', tResidentDivVsInt.divTax < tResidentDivVsInt.intTax);
  check('Resident: lower dividend tax means more after-tax income retained than interest', tResidentDivVsInt.divInt > tResidentDivVsInt.intInt);

  // The DTC is a real credit, not a magic $0 switch: it should still leave
  // SOME tax owed on dividends stacked at a high income (catches the earlier
  // bug where 6/11 was mistakenly applied to the FULL grossed-up amount
  // instead of just the 38% gross-up portion, which over-credited by ~3x and
  // made divTax always $0 no matter how high the stacking income was).
  const tResidentDivHighIncome = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    fill('nonregPretaxReturn', 6);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 100); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const divHigh = _nonregTaxSplit(100000, 300000, 65, false);
    return { taxPaid: divHigh.taxPaid };
  });
  check('Resident: Canadian dividends stacked at a high income (top bracket) still owe real tax, not $0', tResidentDivHighIncome.taxPaid > 0);

  // --- Non-Resident: flat 25% on dividends/interest, $0 on foreign and growth --------
  const tNonResSplit = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    fill('nonregPretaxReturn', 6);
    fill('nonregMixGrowth', 100); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const growth = _nonregTaxSplit(100000, 80000, 65, true);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 100); fill('nonregMixInterest', 0);
    const foreign = _nonregTaxSplit(100000, 80000, 65, true);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 100); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const div = _nonregTaxSplit(100000, 80000, 65, true);
    fill('nonregMixGrowth', 0); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 100);
    const int = _nonregTaxSplit(100000, 80000, 65, true);
    const pretaxTotal = 100000 * 0.06;
    return {
      growthTax: growth.taxPaid, foreignTax: foreign.taxPaid,
      divTax: div.taxPaid, intTax: int.taxPaid,
      divExpected: Math.round(pretaxTotal*0.25*100)/100, intExpected: Math.round(pretaxTotal*0.25*100)/100,
    };
  });
  check('Non-Resident: 100% growth composition owes $0 annual Canadian tax', tNonResSplit.growthTax===0);
  check('Non-Resident: 100% foreign-income composition owes $0 Canadian tax (not Canadian-source)', tNonResSplit.foreignTax===0);
  check('Non-Resident: Canadian dividends taxed at flat 25% Part XIII withholding', Math.abs(tNonResSplit.divTax-tNonResSplit.divExpected)<1);
  check('Non-Resident: interest taxed at the same flat 25% (conservative choice)', Math.abs(tNonResSplit.intTax-tNonResSplit.intExpected)<1);

  // --- ACB-based capital-gains-on-withdrawal tax: wired to the real gain ---
  const tCapGains = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    fill('nonregMixGrowth', 100); fill('nonregMixCanDiv', 0); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    fill('nonregPretaxReturn', 6);
    // A small registered pool + a big Non-Reg balance and a high budget force
    // an immediate Non-Reg draw in year 1 (registered accounts alone can't
    // cover it), so this test isn't dependent on multi-year compounding.
    // $2,000 (not $20,000) deliberately: since the province-selector phase
    // gave Quebec LIFs no maximum at all (real law, effective 2025), a LIF
    // balance alone no longer bounds how much of it can be withdrawn in one
    // year -- only the balance itself does. $2,000 keeps "registered
    // accounts alone can't cover it" true regardless of which province's (or
    // no) LIF cap applies, instead of relying on a jurisdiction-specific cap
    // to keep the scenario meaningful.
    document.querySelectorAll('[id^="bud_"][id$="_amt"]').forEach(el => { el.value = 0; });
    const fillBud = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; } };
    fillBud('bud_houseRent_amt', 5000);

    // Scenario A: TFSA has plenty of room to absorb the tax bill. The
    // withdrawal decision (nonreg draw) happens before the tax is known --
    // that part must stay identical toggle on/off -- but the tax itself
    // should now come out of TFSA rather than out of actualSpend, so the
    // plan still delivers full budgeted spending.
    const portTfsaRoom = { lif:2000, rrsp:2000, tfsa:500000, nonreg:200000 };
    nonregRealisticTax = false;
    fill('nonregStartGainPct', 0);
    const rowsOff = simulateResidentFixed(65, 65, 65, portTfsaRoom);

    nonregRealisticTax = true;
    fill('nonregStartGainPct', 100); // ACB=0 -> 100% embedded gain
    const rowsOnFullGain = simulateResidentFixed(65, 65, 65, portTfsaRoom);

    fill('nonregStartGainPct', 0); // ACB=full balance -> 0% embedded gain
    const rowsOnZeroGain = simulateResidentFixed(65, 65, 65, portTfsaRoom);

    // Scenario B: TFSA and Emergency Fund both start empty, so there is
    // nothing to cover the tax bill with -- this should still show up as a
    // genuine (smaller) shortfall, proving the fix doesn't just make every
    // shortfall vanish, only the ones a real account could actually cover.
    const portNoBuffer = { lif:2000, rrsp:2000, tfsa:0, nonreg:200000 };
    nonregRealisticTax = false;
    fill('nonregStartGainPct', 0);
    const rowsNoBufOff = simulateResidentFixed(65, 65, 65, portNoBuffer);
    nonregRealisticTax = true;
    fill('nonregStartGainPct', 100);
    const rowsNoBufOn = simulateResidentFixed(65, 65, 65, portNoBuffer);

    return {
      draw0: rowsOff[0].nonreg,
      drawFullGain: rowsOnFullGain[0].nonreg,
      drawZeroGain: rowsOnZeroGain[0].nonreg,
      spendOff: rowsOff[0].totalSpend,
      spendFullGain: rowsOnFullGain[0].totalSpend,
      spendZeroGain: rowsOnZeroGain[0].totalSpend,
      tfsaDrawOff: rowsOff[0].tfsa,
      tfsaDrawFullGain: rowsOnFullGain[0].tfsa,
      shortfallFullGain: rowsOnFullGain[0].shortfall,
      noBufSpendOff: rowsNoBufOff[0].totalSpend,
      noBufSpendOn: rowsNoBufOn[0].totalSpend,
      noBufShortfallOn: rowsNoBufOn[0].shortfall,
      noBufTfsaOn: rowsNoBufOn[0].tfsa,
    };
  });
  check('capital-gains test scenario actually draws from Non-Reg in year 1 (test is meaningful)', tCapGains.draw0 > 0);
  check('the withdrawal decision itself (draw amount) is unaffected by the realistic-tax toggle', tCapGains.draw0===tCapGains.drawFullGain && tCapGains.draw0===tCapGains.drawZeroGain);
  check('with TFSA room available: realistic mode with a real embedded gain still delivers full budgeted spending (tax comes from TFSA, not from a phantom shortfall)', tCapGains.spendFullGain === tCapGains.spendOff);
  check('with TFSA room available: the cap-gains tax bill shows up as an extra TFSA draw, not as reduced spending', tCapGains.tfsaDrawFullGain > tCapGains.tfsaDrawOff);
  check('with TFSA room available: shortfall is $0 even though a real cap-gains tax was owed', tCapGains.shortfallFullGain === 0);
  check('realistic mode with 0% embedded gain (all cost basis) spends the same as the flat/default mode ($0 gain = $0 extra tax)', tCapGains.spendZeroGain === tCapGains.spendOff);
  check('with NO TFSA/Emergency buffer: a real cap-gains tax still produces a genuine (uncovered) shortfall', tCapGains.noBufSpendOn < tCapGains.noBufSpendOff && tCapGains.noBufShortfallOn > 0);
  check('with NO TFSA/Emergency buffer: no phantom TFSA draw is invented to cover the tax (there is nothing to draw)', tCapGains.noBufTfsaOn === 0);

  // --- computeEstate(): death-tax on Non-Reg -------------------------------
  const tEstate = await page.evaluate(() => {
    const fakeRow = {
      age: 85, lifBal: 0, lif: 0, rrspBal: 0, rrif: 0,
      tfsaBal: 50000, tfsa: 0, surplus: 0,
      nonregBal: 200000, nonreg: 0, nonregDeposit: 0, nonregACB: 80000,
      emergBal: 0, emerg: 0, emergDeposit: 0,
      totalTaxable: 60000,
    };
    spendMode = 'resident';
    const estResident = computeEstate([fakeRow]);
    spendMode = 'nonresident';
    const estNonRes = computeEstate([fakeRow]);
    const gnr = 0.025; // _SIM_GNREG
    const estNonregGross = 200000 * (1+gnr);
    const gain = Math.max(0, estNonregGross - 80000);
    const marginal = _calcTaxDetail(60000, 85).marginal;
    const expectedDeathTax = Math.round(gain*0.5*marginal);
    return { estResident, estNonRes, expectedDeathTax, estNonregGross };
  });
  check('Resident mode: computeEstate() applies a real, non-zero cap-gains-at-death tax on Non-Reg', tEstate.estResident.nonregDeathTax > 0);
  check('Resident mode: the death-tax amount matches 50% inclusion x marginal rate on the actual unrealized gain', Math.abs(tEstate.estResident.nonregDeathTax - tEstate.expectedDeathTax) <= 1);
  check('Resident mode: Net Estate reflects the Non-Reg figure AFTER the death tax, not the gross figure', tEstate.estResident.net < (tEstate.estResident.tfsa + tEstate.estResident.nonreg + tEstate.estResident.emerg + 1));
  check('Non-Resident mode: computeEstate() applies $0 death tax on Non-Reg (public-securities exemption for non-residents)', tEstate.estNonRes.nonregDeathTax === 0);
  check('Resident vs Non-Resident: gross Non-Reg estate figures differ (each mode applies its own flat post-mortem growth rate)', tEstate.estResident.nonreg !== tEstate.estNonRes.nonreg);

  // --- UI: checkbox reveals panel, sum-warning fires/clears -----------------
  const tUI1 = await page.evaluate(() => {
    const cb = document.getElementById('nonregRealisticTax');
    const wrap = document.getElementById('nonregMixWrap');
    const before = { checked: cb.checked, wrapHidden: getComputedStyle(wrap).display==='none' };
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const after = { wrapVisible: getComputedStyle(wrap).display!=='none' };
    return { before, after };
  });
  check('composition panel starts hidden (checkbox unchecked on a fresh load)', tUI1.before.wrapHidden);
  check('checking the "Realistic tax modeling" box reveals the composition panel', tUI1.after.wrapVisible);

  const tUI2 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('change')); } };
    fill('nonregMixGrowth', 100); fill('nonregMixCanDiv', 50); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
    const warnEl = document.getElementById('nonregMixSumWarn');
    const shownAt150 = warnEl.style.display!=='none' && warnEl.textContent.includes('150');
    fill('nonregMixCanDiv', 0); // back to 100 total
    const hiddenAt100 = warnEl.style.display==='none';
    return { shownAt150, hiddenAt100 };
  });
  check('composition inputs summing to 150% show the sum-mismatch warning naming the actual total', tUI2.shownAt150);
  check('composition inputs summing back to 100% clear the warning', tUI2.hiddenAt100);

  // --- UI: toggle state (checked + composition) persists across reload -----
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('change')); } };
    fill('nonregMixGrowth', 40); fill('nonregMixCanDiv', 60); fill('nonregMixForeign', 0); fill('nonregMixInterest', 0);
  });
  // The composition fields save via a 300ms-debounced _saveAccState() (same
  // mechanism as every other Accumulation-tab field), so the change needs a
  // moment to actually land in localStorage before reloading picks it up.
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  const tPersist = await page.evaluate(() => {
    const cb = document.getElementById('nonregRealisticTax');
    const wrap = document.getElementById('nonregMixWrap');
    return {
      globalRestored: nonregRealisticTax === true,
      checkboxRestored: cb && cb.checked,
      wrapVisibleAfterReload: wrap && getComputedStyle(wrap).display!=='none',
      mixGrowthRestored: document.getElementById('nonregMixGrowth')?.value === '40',
    };
  });
  check('the realistic-tax toggle state persists across a page reload (localStorage)', tPersist.globalRestored && tPersist.checkboxRestored);
  check('the composition panel stays visible after reload when the toggle was left on', tPersist.wrapVisibleAfterReload);
  check('composition input values persist across reload alongside the toggle', tPersist.mixGrowthRestored);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
