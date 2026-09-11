'use strict';
// Broad functional smoke test: budget hover breakdown, a big-portfolio live
// sim, the no-double-shoveling invariant (income surplus deposited AND a
// draw from savings never happen in the same year), Emergency Fund as
// last-resort draw, the DB pension toggle, the Cash Flow collapsible detail,
// table structure (header/colspan counts), and chart datasets.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('bud_houseRent_amt', '1500');
    set('bud_houseMortgage_amt', '2000');
    set('bud_savEmergency_amt', '300');
  });
  await page.waitForTimeout(300);

  const hoverTest = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.budget-item-row'));
    const housingRow = rows.find(r => r.querySelector('.budget-item-label')?.textContent === 'Housing');
    return housingRow ? !!housingRow.querySelector('.budget-item-breakdown') : false;
  });
  check('Budget hover breakdown renders for Housing', hoverTest);

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);

  const bigResult = await page.evaluate(() => {
    const bigPort = { lif: 800000, rrsp: 800000, tfsa: 200000, nonreg: 200000, tfsaRoom: 50000 };
    const rows = simulateResidentFixed(62, 62, 65, bigPort);
    return rows.slice(0, 6).every(r => Object.values(r).every(v => typeof v !== 'number' || !isNaN(v)));
  });
  check('big-portfolio resident simulation runs clean, no NaN', bigResult);

  const shovelTest = await page.evaluate(() => {
    const tinyPort = { lif: 5000, rrsp: 5000, tfsa: 100000, nonreg: 100000, tfsaRoom: 50000 };
    const rows = simulateNonResident(62, 62, 65, tinyPort);
    return rows.slice(0, 4).some(r => (r.surplus > 0 || r.nonregDeposit > 0) && (r.tfsa > 0 || r.nonreg > 0));
  });
  check('no double-shoveling: never both a deposit AND a draw in the same year', !shovelTest);

  const lastResortTest = await page.evaluate(() => {
    const noPort = { lif: 0, rrsp: 0, tfsa: 0, nonreg: 0, tfsaRoom: 0 };
    const rows = simulateResidentFixed(62, 62, 65, noPort);
    return rows.slice(0, 5).every(r => Object.values(r).every(v => typeof v !== 'number' || !isNaN(v))) && rows[0].emergDeposit > 0;
  });
  check('Emergency Fund accumulates via emergDeposit even under a zero starting portfolio', lastResortTest);

  const dbTest = await page.evaluate(() => {
    const port = { lif: 100000, rrsp: 100000, tfsa: 50000, nonreg: 50000, tfsaRoom: 20000 };
    const withDB = simulateResidentFixed(62, 62, 65, port)[0].db;
    document.getElementById('useDBPension').checked = false;
    onUseDBPensionChange();
    const withoutDB = simulateResidentFixed(62, 62, 65, port)[0].db;
    document.getElementById('useDBPension').checked = true;
    onUseDBPensionChange();
    return { withDB, withoutDB };
  });
  check('DB pension toggle actually zeroes the DB figure when off', dbTest.withDB > 0 && dbTest.withoutDB === 0);

  await page.waitForTimeout(500);
  const cfTest = await page.evaluate(() => {
    const cfCells = Array.from(document.querySelectorAll('#mainTable td[onclick*="toggleTaxDetail"]'));
    const greenCf = cfCells.find(td => td.style.color === 'rgb(74, 222, 128)' && td.textContent.trim().startsWith('+'));
    if (!greenCf) return { found: false };
    const m = greenCf.getAttribute('onclick').match(/toggleTaxDetail\('([^']+)'\)/);
    toggleTaxDetail(m[1]);
    const detailTr = greenCf.closest('tr').nextElementSibling;
    return { found: true, hasCashFlowLine: detailTr ? detailTr.innerHTML.includes('Cash Flow:') : false };
  });
  check('Cash Flow collapsible detail row renders with a Cash Flow: line', cfTest.found && cfTest.hasCashFlowLine);

  const structTest = await page.evaluate(() => {
    const ths = document.querySelectorAll('#mainTable thead th');
    const phaseHeader = document.querySelector('#mainTable tbody td.phase-header');
    return { headerCount: ths.length, phaseHeaderColspan: phaseHeader?.getAttribute('colspan') };
  });
  check('table header count matches phase-header colspan', String(structTest.headerCount) === structTest.phaseHeaderColspan);

  const balChartTest = await page.evaluate(() => balanceChart ? balanceChart.data.datasets.map(d => d.label) : null);
  check('balance chart includes an Emergency Fund dataset', Array.isArray(balChartTest) && balChartTest.includes('Emergency Fund'));

  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(500);
  const colChartTest = await page.evaluate(() => ({
    datasets: _colChart ? _colChart.data.datasets.map(d => d.label) : null,
    hasItemSort: _colChart ? typeof _colChart.options.plugins.tooltip.itemSort === 'function' : false,
  }));
  check('Cost of Living chart includes Emergency Fund + a tooltip itemSort', Array.isArray(colChartTest.datasets) && colChartTest.datasets.includes('Emergency Fund') && colChartTest.hasItemSort);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
