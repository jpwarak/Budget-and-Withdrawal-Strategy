'use strict';
// Full Profile setup (the deferred fast-follow from the original Profile-tab
// pivot): a Name field, and a full account inventory on the Profile tab
// covering DB Pension, DC Pension, RRSP, TFSA, FHSA, Non-Registered, and
// Emergency Fund.
//
// Design, confirmed with JP via AskUserQuestion before writing any code:
//   - The 6 accounts that already had an "Include this account" checkbox on
//     the Accumulation tab (DB/DC/RRSP/TFSA/FHSA/Non-Reg) get a MIRROR
//     checkbox on the new Profile "Accounts" card, wired to the same
//     underlying flag/checkbox — toggling either copy updates both
//     immediately, and nothing is removed from the Accumulation tab.
//   - Emergency Fund, which had no on/off checkbox at all (purely driven by
//     the Budget tab's dollar amount), gets a real new checkbox on the
//     Profile tab. Unchecking it zeroes its effect everywhere that dollar
//     amount is read (the Budget tab's own totals, and the retirement
//     simulation's dedicated annual contribution) and dims its Budget-tab
//     row, without clearing the typed amount.
//   - The Name field replaces the hardcoded "JP" in every tab header and the
//     browser tab title, defaulting to "JP" when blank.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ── Name field: defaults, live sync, clearing reverts ──────────────────
  const nameDefaults = await page.evaluate(() => ({
    title: document.title,
    budgetH1: document.getElementById('budgetH1')?.textContent,
    accH1: document.getElementById('accH1')?.textContent,
    retH1: document.getElementById('retH1')?.textContent,
    fieldValue: document.getElementById('profileName')?.value,
  }));
  check('fresh browser: Name field starts blank', nameDefaults.fieldValue === '');
  check('fresh browser: browser tab title defaults to "— JP"', nameDefaults.title === 'Optimized Withdrawal Strategy — JP');
  check('fresh browser: Budget header defaults to "— JP"', nameDefaults.budgetH1 === '💰 Budget — JP');
  check('fresh browser: Accumulation header defaults to "— JP"', nameDefaults.accH1 === '📈 Accumulation Phase — JP');
  check('fresh browser: Retirement Income header defaults to "— JP"', nameDefaults.retH1 === '🍁 Optimized Withdrawal Strategy — JP');

  const afterNameSet = await page.evaluate(() => {
    const el = document.getElementById('profileName');
    el.value = 'Alex';
    onProfileNameChange();
    return {
      title: document.title,
      budgetH1: document.getElementById('budgetH1').textContent,
      accH1: document.getElementById('accH1').textContent,
      retH1: document.getElementById('retH1').textContent,
    };
  });
  check('setting Name updates the browser tab title', afterNameSet.title === 'Optimized Withdrawal Strategy — Alex');
  check('setting Name updates the Budget header', afterNameSet.budgetH1 === '💰 Budget — Alex');
  check('setting Name updates the Accumulation header', afterNameSet.accH1 === '📈 Accumulation Phase — Alex');
  check('setting Name updates the Retirement Income header', afterNameSet.retH1 === '🍁 Optimized Withdrawal Strategy — Alex');

  const afterNameCleared = await page.evaluate(() => {
    const el = document.getElementById('profileName');
    el.value = '';
    onProfileNameChange();
    return { title: document.title, budgetH1: document.getElementById('budgetH1').textContent };
  });
  check('clearing Name reverts the title to "— JP"', afterNameCleared.title === 'Optimized Withdrawal Strategy — JP');
  check('clearing Name reverts the Budget header to "— JP"', afterNameCleared.budgetH1 === '💰 Budget — JP');

  await page.evaluate(() => {
    const el = document.getElementById('profileName');
    el.value = 'Jean-Pierre';
    onProfileNameChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReloadName = await page.evaluate(() => ({
    fieldValue: document.getElementById('profileName').value,
    title: document.title,
    retH1: document.getElementById('retH1').textContent,
  }));
  check('Name persists across reload (field)', afterReloadName.fieldValue === 'Jean-Pierre');
  check('Name persists across reload (title)', afterReloadName.title === 'Optimized Withdrawal Strategy — Jean-Pierre');
  check('Name persists across reload (Retirement header)', afterReloadName.retH1 === '🍁 Optimized Withdrawal Strategy — Jean-Pierre');
  // Reset for the rest of the suite, which assumes the default "JP" headers.
  await page.evaluate(() => { document.getElementById('profileName').value = ''; onProfileNameChange(); });

  // ── Account inventory: fresh-browser defaults, all 7 checked ───────────
  const fresh = await page.evaluate(() => ({
    pUseDBPension: document.getElementById('pUseDBPension').checked,
    pUseDC: document.getElementById('pUseDC').checked,
    pUseRRSP: document.getElementById('pUseRRSP').checked,
    pUseTFSA: document.getElementById('pUseTFSA').checked,
    pUseFHSA: document.getElementById('pUseFHSA').checked,
    pUseNonreg: document.getElementById('pUseNonreg').checked,
    pUseEmergencyFund: document.getElementById('pUseEmergencyFund').checked,
  }));
  Object.entries(fresh).forEach(([id, val]) => check(`fresh browser: ${id} starts checked`, val === true));

  // ── Mirror sync: Accumulation tab -> Profile tab ───────────────────────
  const ACCOUNTS = [
    { src: 'useRRSP', mirror: 'pUseRRSP', wrap: 'rrspFieldsWrap' },
    { src: 'useTFSA', mirror: 'pUseTFSA', wrap: 'tfsaFieldsWrap' },
    { src: 'useFHSA', mirror: 'pUseFHSA', wrap: 'fhsaFieldsWrap' },
    { src: 'useDC', mirror: 'pUseDC', wrap: 'dcFieldsWrap' },
    { src: 'useNonreg', mirror: 'pUseNonreg', wrap: 'nrFieldsWrap' },
  ];
  for (const { src, mirror, wrap } of ACCOUNTS) {
    const result = await page.evaluate(({ src, mirror, wrap }) => {
      const srcEl = document.getElementById(src);
      srcEl.checked = false;
      srcEl.dispatchEvent(new Event('change'));
      return {
        mirrorChecked: document.getElementById(mirror).checked,
        wrapOpacity: document.getElementById(wrap).style.opacity,
      };
    }, { src, mirror, wrap });
    check(`unchecking ${src} on the Accumulation tab unchecks its Profile mirror (${mirror})`, result.mirrorChecked === false);
    check(`unchecking ${src} dims its Accumulation-tab fields wrap`, result.wrapOpacity === '0.4');
    // Restore for the next iteration / later checks.
    await page.evaluate((src) => {
      const el = document.getElementById(src);
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    }, src);
  }

  // ── Mirror sync: Profile tab -> Accumulation tab, both directions, plus
  // the real zero-enforcement in runAcc() (not just DOM/visual state) ────
  const rrspMirrorResult = await page.evaluate(() => {
    document.getElementById('pUseRRSP').checked = false;
    onAcctMirrorChange('useRRSP');
    runAcc();
    return {
      srcChecked: document.getElementById('useRRSP').checked,
      wrapOpacity: document.getElementById('rrspFieldsWrap').style.opacity,
      firstRowRrsp: lastAccRows[0].rrsp,
    };
  });
  check('unchecking the Profile mirror (pUseRRSP) unchecks the real Accumulation-tab checkbox', rrspMirrorResult.srcChecked === false);
  check('unchecking the Profile mirror dims the Accumulation-tab fields wrap', rrspMirrorResult.wrapOpacity === '0.4');
  check('unchecking the Profile mirror actually zeroes RRSP in the real simulation (not just a visual change)', rrspMirrorResult.firstRowRrsp === 0);
  // Restore.
  await page.evaluate(() => {
    document.getElementById('pUseRRSP').checked = true;
    onAcctMirrorChange('useRRSP');
    runAcc();
  });

  // ── DB Pension: same two-way sync, using its own (different) real handler ──
  const dbFromAcc = await page.evaluate(() => {
    document.getElementById('useDBPension').checked = false;
    onUseDBPensionChange();
    return { mirrorChecked: document.getElementById('pUseDBPension').checked, useDBPension };
  });
  check('unchecking the real DB Pension checkbox unchecks its Profile mirror', dbFromAcc.mirrorChecked === false);
  check('unchecking the real DB Pension checkbox clears the useDBPension flag', dbFromAcc.useDBPension === false);

  const dbFromProfile = await page.evaluate(() => {
    document.getElementById('pUseDBPension').checked = true;
    onAcctMirrorChange('useDBPension');
    return { srcChecked: document.getElementById('useDBPension').checked, useDBPension };
  });
  check('re-checking the Profile mirror re-checks the real DB Pension checkbox', dbFromProfile.srcChecked === true);
  check('re-checking the Profile mirror restores the useDBPension flag', dbFromProfile.useDBPension === true);

  // ── Persistence across reload: a couple of accounts excluded ───────────
  await page.evaluate(() => {
    document.getElementById('pUseTFSA').checked = false;
    onAcctMirrorChange('useTFSA');
    document.getElementById('useFHSA').checked = false;
    document.getElementById('useFHSA').dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReloadAccts = await page.evaluate(() => ({
    useTFSA: document.getElementById('useTFSA').checked,
    pUseTFSA: document.getElementById('pUseTFSA').checked,
    useFHSA: document.getElementById('useFHSA').checked,
    pUseFHSA: document.getElementById('pUseFHSA').checked,
    otherStillChecked: document.getElementById('pUseRRSP').checked && document.getElementById('pUseDC').checked,
  }));
  check('TFSA exclusion survives reload (real checkbox)', afterReloadAccts.useTFSA === false);
  check('TFSA exclusion survives reload (Profile mirror)', afterReloadAccts.pUseTFSA === false);
  check('FHSA exclusion survives reload (real checkbox)', afterReloadAccts.useFHSA === false);
  check('FHSA exclusion survives reload (Profile mirror)', afterReloadAccts.pUseFHSA === false);
  check('accounts NOT excluded stay checked after reload', afterReloadAccts.otherStillChecked === true);
  // Restore for the rest of the suite.
  await page.evaluate(() => {
    document.getElementById('pUseTFSA').checked = true;
    onAcctMirrorChange('useTFSA');
    document.getElementById('useFHSA').checked = true;
    document.getElementById('useFHSA').dispatchEvent(new Event('change'));
  });

  // ── Emergency Fund: real checkbox, effect-zeroing, dimming ─────────────
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(500);

  const efBaseline = await page.evaluate(() => {
    const amt = document.getElementById('bud_savEmergency_amt');
    const freq = document.getElementById('bud_savEmergency_freq');
    amt.value = '300';
    amt.dispatchEvent(new Event('input'));
    freq.value = 'monthly';
    freq.dispatchEvent(new Event('change'));
    return {
      monthly: _budgetItemMonthly(BUDGET_SAVINGS.find(s => s.id === 'savEmergency')),
      annualNom: _emergencyFundAnnualNom(65),
      disabled: amt.disabled,
    };
  });
  check('Emergency Fund included by default: contributes its typed monthly amount', efBaseline.monthly === 300);
  check('Emergency Fund included by default: _emergencyFundAnnualNom is non-zero', efBaseline.annualNom > 0);
  check('Emergency Fund included by default: amount field not disabled', efBaseline.disabled === false);

  const efExcluded = await page.evaluate(() => {
    document.getElementById('pUseEmergencyFund').checked = false;
    onUseEmergencyFundChange();
    return {
      monthly: _budgetItemMonthly(BUDGET_SAVINGS.find(s => s.id === 'savEmergency')),
      annualNom: _emergencyFundAnnualNom(65),
      amtValue: document.getElementById('bud_savEmergency_amt').value,
      amtDisabled: document.getElementById('bud_savEmergency_amt').disabled,
      amtOpacity: document.getElementById('bud_savEmergency_amt').style.opacity,
      savingsTotalExcludesIt: (() => {
        const withIt = BUDGET_SAVINGS.filter(s => s.id !== 'savEmergency').reduce((s, it) => s + _budgetItemMonthly(it), 0);
        const total = BUDGET_SAVINGS.reduce((s, it) => s + _budgetItemMonthly(it), 0);
        return total === withIt; // savEmergency contributed exactly 0
      })(),
    };
  });
  check('unchecking Emergency Fund zeroes its Budget-tab contribution', efExcluded.monthly === 0);
  check('unchecking Emergency Fund zeroes the retirement simulation\'s dedicated annual contribution', efExcluded.annualNom === 0);
  check('unchecking Emergency Fund does NOT clear the typed amount (still 300)', efExcluded.amtValue === '300');
  check('unchecking Emergency Fund disables the Budget-tab amount field', efExcluded.amtDisabled === true);
  check('unchecking Emergency Fund dims the Budget-tab amount field', parseFloat(efExcluded.amtOpacity) < 1);
  check('unchecking Emergency Fund removes it from the Budget tab\'s overall savings total', efExcluded.savingsTotalExcludesIt);

  // Dimming survives a full Budget-form rebuild (e.g. switching retirement
  // age), not just the initial toggle. Mimics the app's own rebuild sequence
  // (renderBudgetForm + loadBudget + _budgetRefreshIncomeRow — see
  // initBudget()/_budgetSyncRetAge()), not just renderBudgetForm() alone,
  // since loadBudget() is what restores the real $300 value onto the fresh
  // post-rebuild element and _budgetRefreshIncomeRow() is what actually
  // calls _budgetRefreshSavingsToggles() (and so _updateEmergencyFundDimming()).
  const efDimAfterRebuild = await page.evaluate(() => {
    renderBudgetForm();
    loadBudget();
    _budgetRefreshIncomeRow();
    return {
      disabled: document.getElementById('bud_savEmergency_amt').disabled,
      opacity: document.getElementById('bud_savEmergency_amt').style.opacity,
      amtValue: document.getElementById('bud_savEmergency_amt').value,
    };
  });
  check('Emergency Fund dim state re-applies after the Budget form is rebuilt', efDimAfterRebuild.disabled === true && parseFloat(efDimAfterRebuild.opacity) < 1);
  check('the $300 value survives the rebuild too (loadBudget restores it)', efDimAfterRebuild.amtValue === '300');

  const efRestored = await page.evaluate(() => {
    document.getElementById('pUseEmergencyFund').checked = true;
    onUseEmergencyFundChange();
    return {
      monthly: _budgetItemMonthly(BUDGET_SAVINGS.find(s => s.id === 'savEmergency')),
      amtValue: document.getElementById('bud_savEmergency_amt').value,
      amtDisabled: document.getElementById('bud_savEmergency_amt').disabled,
    };
  });
  check('re-checking Emergency Fund restores its contribution using the SAME typed amount (no re-entry needed)', efRestored.monthly === 300);
  check('re-checking Emergency Fund restores the same $300 value', efRestored.amtValue === '300');
  check('re-checking Emergency Fund re-enables the amount field', efRestored.amtDisabled === false);

  // ── Persistence: exclude Emergency Fund, reload, still excluded ───────
  await page.evaluate(() => {
    document.getElementById('pUseEmergencyFund').checked = false;
    onUseEmergencyFundChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const efAfterReload = await page.evaluate(() => document.getElementById('pUseEmergencyFund').checked);
  check('Emergency Fund exclusion survives reload', efAfterReload === false);

  // ── Backward compatibility: a plan saved before this feature existed
  // (plannerState with no profile.useEmergencyFund key at all) defaults to
  // included, matching every other account's checkbox default. ──────────
  const staleState = {
    v: 1,
    ret: { tab: 'ret', age: '65', spendMode: 'resident' },
    profile: { province: 'ontario' }, // no useEmergencyFund key
    acc: {},
    budget: {},
    nav: {},
  };
  const { browser: browser2, page: page2 } = await openApp(process.argv[2], {
    seedLocalStorage: { plannerState: JSON.stringify(staleState) },
  });
  const staleResult = await page2.evaluate(() => ({
    useEmergencyFund,
    checkboxChecked: document.getElementById('pUseEmergencyFund').checked,
  }));
  check('a pre-existing plan with no saved Emergency Fund preference defaults to included', staleResult.useEmergencyFund === true);
  check('a pre-existing plan with no saved Emergency Fund preference shows the checkbox checked', staleResult.checkboxChecked === true);
  await browser2.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
