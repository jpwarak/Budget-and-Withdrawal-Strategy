'use strict';
// Expense Breakdown hover shows escalated ($, not today's-$) sub-item
// amounts that sum to the group total, and the Yearly Expense Summary
// sub-tab (age 55-85, independent of retirement age, nominal-vs-real toggle).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); };
    set('bud_houseRent_amt', 1500);
    set('bud_houseMortgage_amt', 800);
    set('bud_housePropTax_amt', 300);
    const ageSel = document.getElementById('bud_incMain_age');
    ageSel.value = '65-69'; ageSel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);

  const escTest = await page.evaluate(() => {
    const t = computeDisplayTotals();
    const groupTotal = t.groupTotals['housing'];
    const factor = t.factor;
    const g = BUDGET_EXPENSE_GROUPS.find(x => x.id === 'housing');
    const isFuture = _budgetActiveAge() != null;
    const sum = g.items.reduce((s, it) => {
      let v = _budgetItemMonthly(it);
      if (isFuture && it.toggle && !_budgetSavingsEnabled[it.id]) v = 0;
      v *= factor;
      return s + v;
    }, 0);
    return { groupTotal, subItemSum: sum, diff: Math.abs(groupTotal - sum) };
  });
  check('hover breakdown sub-items sum to the (already-escalated) group total', escTest.diff < 1e-6);

  const domCheck = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.budget-item-row'));
    const housingRow = rows.find(r => r.querySelector('.budget-item-label')?.textContent === 'Housing');
    if (!housingRow) return null;
    const subRows = Array.from(housingRow.querySelectorAll('.budget-item-breakdown-row')).map(r => r.textContent);
    return { subRows };
  });
  check('rendered Housing hover breakdown shows Rent/Mortgage/Property taxes sub-rows', !!domCheck && domCheck.subRows.length === 3);

  const subtabInfo = await page.evaluate(() => ({
    ovDisplay: document.getElementById('budgetSubOverview').style.display,
    yrDisplay: document.getElementById('budgetSubYearly').style.display,
  }));
  check('Overview sub-tab is the default view', subtabInfo.yrDisplay === 'none');

  await page.evaluate(() => { showBudgetSubTab('yearly'); });
  await page.waitForTimeout(300);
  const afterSwitch = await page.evaluate(() => {
    const table = document.querySelector('#budgetYearlyTable table');
    const rows = table ? table.querySelectorAll('tbody tr').length : 0;
    const firstRowAge = table ? table.querySelector('tbody tr td')?.textContent : null;
    const lastRowAge = table ? Array.from(table.querySelectorAll('tbody tr')).pop()?.querySelector('td')?.textContent : null;
    return { rows, firstRowAge, lastRowAge };
  });
  check('Yearly Expense Summary shows 31 rows (age 55-85)', afterSwitch.rows === 31);
  check('Yearly Expense Summary starts at age 55', afterSwitch.firstRowAge === '55');
  check('Yearly Expense Summary ends at age 85', afterSwitch.lastRowAge === '85');

  await page.evaluate(() => { document.querySelector('.age-btn[data-age="65"]').click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { showTab('budget'); showBudgetSubTab('yearly'); });
  await page.waitForTimeout(300);
  const yearlyAfterRaChange = await page.evaluate(() => {
    const table = document.querySelector('#budgetYearlyTable table');
    return { rows: table.querySelectorAll('tbody tr').length, firstRowAge: table.querySelector('tbody tr td')?.textContent };
  });
  check('Yearly Expense Summary unaffected by retirement-age change (still 31 rows, starts at 55)', yearlyAfterRaChange.rows === 31 && yearlyAfterRaChange.firstRowAge === '55');

  await page.evaluate(() => {
    document.getElementById('bud_debtCC_amt').value = 100;
    document.getElementById('bud_debtCC_amt').dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  const debtTest = await page.evaluate(() => {
    const table = document.querySelector('#budgetYearlyTable table');
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent);
    const debtColIdx = headers.indexOf('Debt repayment');
    const trs = Array.from(table.querySelectorAll('tbody tr'));
    return { firstDebt: trs[0].querySelectorAll('td')[debtColIdx].textContent, lastDebt: trs[trs.length - 1].querySelectorAll('td')[debtColIdx].textContent };
  });
  check('debt repayment does not escalate across years', debtTest.firstDebt === debtTest.lastDebt);

  const realToggleTest = await page.evaluate(() => {
    const chk = document.getElementById('budgetYearlyRealToggle');
    const table = () => document.querySelector('#budgetYearlyTable table');
    const headers = Array.from(table().querySelectorAll('thead th')).map(th => th.textContent);
    const houseIdx = headers.indexOf('Housing');
    const nominalAge85 = table().querySelectorAll('tbody tr')[30].querySelectorAll('td')[houseIdx].textContent;
    chk.checked = true; chk.dispatchEvent(new Event('change'));
    const realAge85 = table().querySelectorAll('tbody tr')[30].querySelectorAll('td')[houseIdx].textContent;
    const parseAmt = s => parseFloat(s.replace(/[^0-9.]/g, ''));
    return { nominalAge85, realAge85, nominalBigger: parseAmt(nominalAge85) > parseAmt(realAge85) };
  });
  check('nominal-$ at age 85 is bigger than real-$ (CPI compounding), real toggle works', realToggleTest.nominalBigger);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
