'use strict';
// "RRSP contribution room tracking" (JP, picked from the roadmap's
// Remaining table alongside Export report feature). Origin: the Accumulation
// tab already tracked a "Contribution Room ($)" cap for RRSP/TFSA, but RRSP
// used the same flat "+$8,000/yr" approximation every capped account uses,
// and the number never carried across into the Retirement Income tab (see
// 38-acct-hover-detail.js's history -- the RRIF hover box's Contribution
// Room line got dropped there for lack of a real number).
//
// Confirmed with JP (AskUserQuestion) before building:
//  1. RRSP room freezes at the retirement boundary (RRSP fully converts to
//     RRIF there -- rrsp is always 0 from that point on in this model, so
//     there's no ongoing accrual to model in retirement) and is carried
//     forward purely for display in the RRIF hover box.
//  2. A manual/preset starting portfolio (no Accumulation-tab run) falls
//     back to a hardcoded default (_RRSP_ROOM0), same pattern as TFSA's
//     _TFSA_ROOM0.
//  3. Shown in the RRIF hover box only (not a new table column).
//
// JP's own follow-up on the Accumulation-phase calculation itself: replace
// the flat "+$8,000/yr" approximation with the real CRA rule -- 18% of the
// PRIOR year's earned income, capped at that year's RRSP dollar limit. The
// only earned-income figure anywhere in the app is the Budget tab's Income
// field (+ its Pay raise %/yr) -- confirmed (AskUserQuestion) to reuse that
// rather than add a second income input, and confirmed to model the real
// CRA dollar-limit ceiling rather than skip it.
//
// This test's central concerns: (1) the accrual math itself --
// _rrspEarnedIncomeAt/_rrspDollarLimit/_rrspNewRoomForYear -- matches the
// documented formula, including the fallback to the old flat $8,000/yr when
// the Budget tab's Income has never been filled in (protects anyone using
// only the Accumulation tab from silently getting zero room growth forever);
// (2) the Accumulation table's real per-year capRem reflects the cumulative
// running total, not a linear roomGrowth*yr; (3) the final Accumulation-tab
// room number carries forward into the Retirement Income tab as a FROZEN
// per-row rrspRoom field (same value every year, unlike tfsaRoom); and (4)
// the manual/preset-portfolio path (no Accumulation run) falls back to
// _RRSP_ROOM0.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Helper-function math, in isolation (no Budget income set yet --
  // fresh page load, so _budgetIncomeData.amt is still 0). ----
  const t0 = await page.evaluate(() => {
    const limit2026 = _rrspDollarLimit(2026);
    const limit2027 = _rrspDollarLimit(2027);
    const fallbackYr1 = _rrspNewRoomForYear(1, 2026);
    const fallbackYr0 = _rrspNewRoomForYear(0, 2026); // never actually added (yr=0 skipped in runAcc), but should still compute cleanly
    return { limit2026, limit2027, fallbackYr1, fallbackYr0 };
  });
  check('_rrspDollarLimit(2026) matches the CRA 2026 base figure ($33,810)', t0.limit2026 === 33810);
  check('_rrspDollarLimit grows year over year (conservative indexation)', t0.limit2027 > t0.limit2026);
  check('with no Budget-tab income entered, new room falls back to the old flat $8,000/yr (no silent zero-growth regression)', t0.fallbackYr1 === 8000);
  check('the fallback is well-defined even for yr=0', t0.fallbackYr0 === 8000);

  // ---- Set a real Budget-tab income and confirm the earned-income helper
  // compounds it correctly (raisePct baked in), and that new room correctly
  // switches from the flat fallback to the real 18%-of-income formula. ----
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  const t1 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (!el) return false; el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); return true; };
    const gotAmt = fill('bud_incMain_amt', 5000); // $5,000/mo = $60,000/yr
    document.getElementById('bud_incMain_freq').value = 'monthly';
    document.getElementById('bud_incMain_freq').dispatchEvent(new Event('change'));
    const gotRaise = fill('bud_incRaise_pct', 0);
    onBudgetIncomeFieldInput();
    const income0 = _rrspEarnedIncomeAt(0);
    const income3 = _rrspEarnedIncomeAt(3); // raisePct=0, so should be flat
    const startYr = parseInt(document.getElementById('accStartYear')?.value) || new Date().getFullYear();
    const expectedNewRoomYr1 = Math.min(60000 * 0.18, _rrspDollarLimit(startYr + 1));
    const actualNewRoomYr1 = _rrspNewRoomForYear(1, startYr);
    return { gotAmt, gotRaise, income0, income3, expectedNewRoomYr1, actualNewRoomYr1, startYr };
  });
  check('Budget tab Income field exists and accepted the test value', t1.gotAmt && t1.gotRaise);
  check('_rrspEarnedIncomeAt(0) reflects the Budget tab Income ($60,000/yr)', Math.abs(t1.income0 - 60000) < 1);
  check('with 0% pay raise, earned income stays flat across years', Math.abs(t1.income3 - 60000) < 1);
  check('new room switches to 18%-of-income once real income is entered (no longer the $8,000 fallback)', Math.abs(t1.actualNewRoomYr1 - t1.expectedNewRoomYr1) < 1 && t1.actualNewRoomYr1 !== 8000);

  // ---- Dollar-limit ceiling actually binds for a very high income. ----
  const t2 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    fill('bud_incMain_amt', 500000); // $500,000/mo = $6,000,000/yr -- 18% of that dwarfs any real dollar limit
    onBudgetIncomeFieldInput();
    const startYr = parseInt(document.getElementById('accStartYear')?.value) || new Date().getFullYear();
    const newRoom = _rrspNewRoomForYear(1, startYr);
    const limit = _rrspDollarLimit(startYr + 1);
    // Restore a modest income for the rest of the test.
    fill('bud_incMain_amt', 5000);
    onBudgetIncomeFieldInput();
    return { newRoom, limit };
  });
  check('new room is capped at the dollar limit for a very high income, not 18% of it', Math.abs(t2.newRoom - t2.limit) < 1);

  // ---- Full Accumulation-tab run: real per-year capRem reflects the
  // cumulative running total (not a linear roomGrowth*yr), and matches an
  // independently-reconstructed cumulative sum. Contribution kept low so it
  // never actually hits the cap -- keeps cumContrib pure arithmetic. ----
  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(200);
  const t3 = await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    fill('accCurAge', 43);
    fill('rrspCap', 10000);       // starting room already accumulated
    fill('rrspBal', 0);
    fill('rrspAnnual', 0);
    fill('rrspBiweekly', 50);     // small, deliberately well under any plausible cap
    fill('rrspRate', 0);          // isolate room math from balance growth/rounding
    // Zero out FHSA entirely -- its default settings (a lifetime cap that a
    // real default contribution would eventually hit, defaulting to
    // overflow into RRSP, plus a default rollover into RRSP after 15 years)
    // are a real, intentional feature ("FHSA rolls in tax-free (no room
    // used)"), but they're a DIFFERENT feature's cross-account interaction
    // -- isolating it here keeps this test purely about RRSP's own accrual.
    fill('fhsaAnnual', 0);
    fill('fhsaBiweekly', 0);
    fill('fhsaBal', 0);
    runAcc();
    const startYr = parseInt(document.getElementById('accStartYear')?.value) || new Date().getFullYear();
    let expectedAccrued = 0;
    const rows = lastAccRows.map(r => {
      const yr = r.age - 43;
      if (yr > 0) expectedAccrued += _rrspNewRoomForYear(yr, startYr);
      // With FHSA zeroed out, r.rrsp (this row's ending RRSP balance) IS
      // cumContrib exactly -- rrspRate is 0, so no growth is mixed in, and
      // nothing else deposits into RRSP in this fixture.
      const expectedCapRem = (10000 + expectedAccrued) - r.rrsp;
      return { age: r.age, yr, capRem: r.stats.rrsp.capRem, expectedCapRem };
    });
    return { rows, startYr };
  });
  check('Accumulation run produced enough years to check (test is meaningful)', t3.rows.length > 10);
  const allMatch = t3.rows.every(r => Math.abs(r.capRem - r.expectedCapRem) < 1);
  if (!allMatch) console.log('capRem mismatches:', t3.rows.filter(r => Math.abs(r.capRem - r.expectedCapRem) >= 1).slice(0, 5));
  check('Accumulation table\'s real per-year capRem for RRSP exactly matches the independently-reconstructed cumulative 18%-of-income accrual, every year', allMatch);

  // ---- Carries forward into the Retirement Income tab as a FROZEN per-row
  // field -- every simulated year shows the SAME rrspRoom, unlike tfsaRoom
  // which grows. ----
  const t4 = await page.evaluate(() => {
    const retAge = 62; // within the 43-65 accumulation horizon
    lastAccRows = lastAccRows; // (already populated by t3's runAcc())
    const accRow = lastAccRows.find(r => r.age === retAge);
    document.querySelector(`.age-btn[data-age="${retAge}"]`)?.click();
    showTab('ret');
    renderAll(retAge);
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const rrspRoomValues = [...new Set(DATA.map(d => d.rrspRoom))];
    return {
      accRowCapRem: accRow ? accRow.stats.rrsp.capRem : null,
      liveRowsHaveRrspRoom: DATA.every(d => d.rrspRoom != null),
      isFrozen: rrspRoomValues.length === 1,
      seededValue: rrspRoomValues[0],
    };
  });
  check('every retirement-sim row carries a non-null rrspRoom', t4.liveRowsHaveRrspRoom);
  check('rrspRoom is frozen -- identical across every simulated year (RRSP is fully converted to RRIF by then)', t4.isFrozen);
  if (t4.accRowCapRem != null) {
    check('the frozen retirement rrspRoom matches the real Accumulation-tab capRem at the selected retirement age', Math.abs(t4.seededValue - t4.accRowCapRem) < 1);
  }

  // ---- Manual/preset-portfolio path (no Accumulation-tab run at all)
  // falls back to _RRSP_ROOM0, same pattern as TFSA's _TFSA_ROOM0. ----
  const t5 = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    const presetAge = 55; // a PORTFOLIOS key with no accumulation data behind it
    renderAll(presetAge);
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData && liveData.data[spendMode][comboKey];
    return {
      hasData: !!DATA,
      allMatchFallback: DATA ? DATA.every(d => d.rrspRoom === _RRSP_ROOM0) : false,
      rrspRoom0: typeof _RRSP_ROOM0,
    };
  });
  check('preset-portfolio path (no Accumulation run) still produces data', t5.hasData);
  check('preset-portfolio path falls back to the _RRSP_ROOM0 constant for every row', t5.allMatchFallback);

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0, 5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
