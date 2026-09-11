'use strict';
// The localStorage consolidation: ~41 scattered call sites across ~20
// top-level keys were folded into a single 'plannerState' key (an
// in-memory-cached {v, ret, acc, budget, nav} object, accessed everywhere
// through _stateGet/_stateSet/_stateSetMany), with a one-time
// _migrateLegacyStorageIfNeeded() that runs old scattered keys into the new
// shape on first load and then removes only the keys it actually consumed.
//
// This suite doesn't re-run the general Budget/Accumulation/Retirement
// feature checks (those live in 01-14 and run against whatever storage
// mechanism is live under the hood) — it specifically targets the migration
// and the new helpers: a browser with real old-scheme data migrates
// correctly and loses nothing; the even-older per-field/legacy fallback
// tiers those old-scheme keys themselves used to fall back to are left
// alone; a completely fresh browser doesn't error or write a premature
// empty blob; and the _stateGet/_stateSet/_stateSetMany helpers round-trip
// and survive a reload.
const { openApp, finish } = require('./lib');

(async () => {
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ── Scenario A: real old-scheme data migrates correctly ──────────────────
  // Seeds every old top-level key the migration consumes, PLUS a few
  // even-older legacy-fallback-tier keys ('accEndMonth'/'accEndYear' as
  // stood-alone per-field ACC_PERSIST_IDS entries, 'budgetData_pre',
  // 'budgetCollapsed_pre') that must survive the migration untouched, since
  // other functions still read those directly as their own separate,
  // already-working fallback tier.
  {
    const seed = {
      retSpendMode: 'resident',
      retQppStart: '70',
      retOasStart: '70',
      retAge: '60',
      retGrowthRate: '4.0',
      retHalfUnlock: '1',
      retPhUnlockMode: 'full',
      retCpiRate: '2.0',
      ret_tgt60: '70000', ret_tgt65: '75000', ret_tgt70: '80000', ret_tgt75: '85000', ret_tgt80: '90000',
      useDBPension: '0',
      nonregRealisticTax: '1',
      // A full, realistic accState blob (every ACC_PERSIST_IDS field a real
      // save would include) EXCEPT accEndMonth/accEndYear, deliberately
      // omitted so _loadAccState()'s own per-field legacy fallback
      // (untouched by this migration) is what supplies them below.
      accState: JSON.stringify({
        accCurAge: '50', accStartMonth: '9', accStartYear: '2026',
        accR1: '6', accDur1: '15', accR2: '3.5',
        rrspBal: '123456', rrspAnnual: '0', rrspBiweekly: '270', rrspCap: '0', rrspOverflow: 'tfsa',
        tfsaBal: '55555', tfsaAnnual: '5000', tfsaBiweekly: '270', tfsaCap: '95000', tfsaOverflow: 'nr',
        fhsaBal: '3793', fhsaAnnual: '8000', fhsaBiweekly: '0', fhsaCap: '40000', fhsaOverflow: 'rrsp', fhsaRoll: 'yes', fhsaRollYrs: '15',
        dcBal: '235757', dcAnnual: '0', dcBiweekly: '0',
        nrBal: '0', nrAnnual: '0', nrBiweekly: '0',
        nonregMixGrowth: '100', nonregMixCanDiv: '0', nonregMixForeign: '0', nonregMixInterest: '0',
        nonregPretaxReturn: '6', nonregStartGainPct: '0',
        dbAge55: '20889', dbAge60: '40169', dbAge61: '45032', dbAge62: '50267', dbAge63: '53669', dbAge64: '57334', dbAge65: '61049',
        dbCola: '1.0', dbFreezeAge: '75',
      }),
      accEndMonth: '3',
      accEndYear: '2050',
      budgetData: JSON.stringify({
        _income: { amt: 6000, freq: 'monthly' },
        _bonus: { amt: 500, freq: 'annual' },
        houseRent: { amt: 1800, freq: 'monthly' },
        debtCC: { amt: 200, freq: 'monthly', bal: 3000, rate: 19.99 },
      }),
      budgetData_pre: JSON.stringify({ incEmp: { amt: 999, freq: 'monthly' } }), // even-older tier — must survive
      budgetIncomeAge: '65-69',
      budgetCollapsed: JSON.stringify(['debt', 'housing']),
      budgetCollapsed_pre: JSON.stringify(['legacyGroup']), // even-older tier — must survive
      activeTab: 'budget',
      budgetSubTab: 'yearly',
    };

    const { browser, page, consoleErrors } = await openApp(process.argv[2], { seedLocalStorage: seed });

    const result = await page.evaluate(() => ({
      plannerStateExists: localStorage.getItem('plannerState') != null,
      oldKeysGone: [
        'retSpendMode','retQppStart','retOasStart','retAge','retGrowthRate','retHalfUnlock',
        'retPhUnlockMode','retCpiRate','ret_tgt60','ret_tgt65','ret_tgt70','ret_tgt75','ret_tgt80',
        'useDBPension','nonregRealisticTax','accState','budgetData','budgetIncomeAge',
        'budgetCollapsed','activeTab','budgetSubTab',
      ].every(k => localStorage.getItem(k) === null),
      legacyTierSurvives:
        localStorage.getItem('accEndMonth') === '3' &&
        localStorage.getItem('accEndYear') === '2050' &&
        localStorage.getItem('budgetData_pre') != null &&
        localStorage.getItem('budgetCollapsed_pre') != null,
      spendMode, qppStart, oasStart, currentAge, halfUnlock, nrLifUnlock, useDBPension, nonregRealisticTax,
      // tgt65 itself no longer has a DOM input (replaced 2026-09-11 by the
      // per-year TARGET_INCOME click-to-edit table) -- what matters here is
      // that the ancient flat ret_tgt65 key still migrates into the nested
      // 'ret'/'tgt65' shape (moveStr, unchanged by this), and THAT value is
      // what the newer TARGET_INCOME one-time migration then picks up.
      targetAge65: TARGET_INCOME[65],
      cpiRate: document.getElementById('cpiRate')?.value,
      growthRate: document.getElementById('retGrowthRate')?.value,
      rrspBal: document.getElementById('rrspBal')?.value,
      tfsaBal: document.getElementById('tfsaBal')?.value,
      accEndMonthField: document.getElementById('accEndMonth')?.value,
      accEndYearField: document.getElementById('accEndYear')?.value,
      activeTabPanel: document.getElementById('panelBudget')?.style.display,
      budgetSubYearlyShown: document.getElementById('budgetSubYearly')?.style.display,
      incomeAge: _budgetIncomeAgeValue(),
      houseRentAmt: document.getElementById('bud_houseRent_amt')?.value,
      debtCCBal: document.getElementById('bud_debtCC_bal')?.value,
      debtBodyCollapsed: document.getElementById('bud_debt_body')?.style.display,
      housingBodyCollapsed: document.getElementById('bud_housing_body')?.style.display,
      savingsBodyNotCollapsed: document.getElementById('bud_savings_body')?.style.display,
    }));

    check('migration created the unified plannerState key', result.plannerStateExists);
    check('all ~20 old top-level scattered keys were removed', result.oldKeysGone);
    check('even-older legacy fallback tiers (accEndMonth/Year, budgetData_pre, budgetCollapsed_pre) survive untouched', result.legacyTierSurvives);
    check('spendMode restored', result.spendMode === 'resident');
    check('qppStart restored as a number', result.qppStart === 70);
    check('oasStart restored as a number', result.oasStart === 70);
    check('currentAge restored', result.currentAge === 60);
    // The migration itself correctly lifts the legacy retHalfUnlock='1' value
    // into the new halfUnlock flag -- but this seed has no legacy province
    // key (province didn't exist yet when this migration was written), so
    // _currentProvince() defaults to Quebec, and Quebec has no one-time
    // unlocking provision (see _halfUnlockAllowed(), added later). The newer
    // gating logic correctly corrects the just-migrated flag back to false
    // on this same load, which is the real, legal outcome here, not a
    // migration bug -- see 26-provincial-lif-unlock.js for the gating logic
    // itself, including the equivalent "stale pre-gating save" scenario.
    check('halfUnlock migrates from the legacy key, then correctly clears itself (Quebec, the default province, has no such provision)', result.halfUnlock === false);
    check('nrLifUnlock restored', result.nrLifUnlock === 'full');
    check('useDBPension restored to false', result.useDBPension === false);
    check('nonregRealisticTax restored to true', result.nonregRealisticTax === true);
    check('the legacy ret_tgt65 value (75000) flows through into TARGET_INCOME for age 65', result.targetAge65 === 75000);
    check('cpiRate restored into the DOM', result.cpiRate === '2.0');
    check('growthRate restored into the DOM', result.growthRate === '4.0');
    check('accState blob restored rrspBal', result.rrspBal === '123456');
    check('accState blob restored tfsaBal', result.tfsaBal === '55555');
    check('accEndMonth fell back to the untouched legacy per-field key (not present in the accState blob)', result.accEndMonthField === '3');
    check('accEndYear fell back to the untouched legacy per-field key (not present in the accState blob)', result.accEndYearField === '2050');
    check('active tab (budget) restored', result.activeTabPanel === 'block');
    check('budget sub-tab (yearly) restored', result.budgetSubYearlyShown === '');
    check('budgetIncomeAge restored', result.incomeAge === '65-69');
    check('budgetData blob restored a regular item into the DOM', result.houseRentAmt === '1800');
    check('budgetData blob restored a debt balance into the DOM', result.debtCCBal === '3000');
    check('budgetCollapsed restored: debt group collapsed', result.debtBodyCollapsed === 'none');
    check('budgetCollapsed restored: housing group collapsed', result.housingBodyCollapsed === 'none');
    check('budgetCollapsed restored: an uncollapsed group (savings) stays open', result.savingsBodyNotCollapsed !== 'none');
    check('no console errors during migrated load', consoleErrors.length === 0);

    await browser.close();
  }

  // ── Scenario B: fresh browser, nothing saved anywhere ────────────────────
  // No old keys, no plannerState key. Confirms the app doesn't error and
  // doesn't blow up _stateGet/_loadAccState/loadBudget when everything
  // falls through to defaults. Also confirms _migrateLegacyStorageIfNeeded's
  // "nothing to migrate" guard doesn't write a premature empty blob: calling
  // it directly (after clearing whatever normal use already wrote during
  // this same page's load) with genuinely nothing old present must leave
  // 'plannerState' absent, since _stateSet will create the real key on the
  // first actual save instead.
  {
    const { browser, page, consoleErrors } = await openApp(process.argv[2], { seedLocalStorage: {} });

    const freshLoadOk = await page.evaluate(() => ({
      currentAge, spendMode,
      rrspBalDefault: document.getElementById('rrspBal') != null,
    }));
    check('fresh browser: page loads with sane defaults (no thrown error during restore)', typeof freshLoadOk.currentAge === 'number');
    check('fresh browser: no console errors', consoleErrors.length === 0);

    const noopGuard = await page.evaluate(() => {
      localStorage.clear();
      _appState = null;
      _migrateLegacyStorageIfNeeded();
      return localStorage.getItem('plannerState');
    });
    check("migration's no-op guard: nothing old to migrate -> plannerState stays absent (no premature empty blob)", noopGuard === null);

    await browser.close();
  }

  // ── Scenario C: _stateGet/_stateSet/_stateSetMany round-trip + reload ────
  {
    const { browser, page, consoleErrors } = await openApp(process.argv[2], { seedLocalStorage: {} });

    const roundTrip1 = await page.evaluate(() => {
      _stateSet('ret', '__testKey', 'testValue');
      _stateSetMany('acc', { __a: 1, __b: 2 });
      return {
        single: _stateGet('ret', '__testKey', null),
        bulkA: _stateGet('acc', '__a', null),
        bulkB: _stateGet('acc', '__b', null),
        fallback: _stateGet('ret', '__neverSet', 'fallbackVal'),
      };
    });
    check('_stateSet/_stateGet single round-trip', roundTrip1.single === 'testValue');
    check('_stateSetMany bulk write, key 1', roundTrip1.bulkA === 1);
    check('_stateSetMany bulk write, key 2', roundTrip1.bulkB === 2);
    check('_stateGet returns the fallback for an unset key', roundTrip1.fallback === 'fallbackVal');

    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    const roundTrip2 = await page.evaluate(() => ({
      single: _stateGet('ret', '__testKey', null),
      bulkA: _stateGet('acc', '__a', null),
      bulkB: _stateGet('acc', '__b', null),
    }));
    check('values written via _stateSet survive a full page reload (single)', roundTrip2.single === 'testValue');
    check('values written via _stateSetMany survive a full page reload (bulk)', roundTrip2.bulkA === 1 && roundTrip2.bulkB === 2);
    check('no console errors across the reload', consoleErrors.length === 0);

    await browser.close();
  }

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
