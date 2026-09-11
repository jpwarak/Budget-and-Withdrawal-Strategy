'use strict';
// Two small, purely-layout housekeeping changes JP asked for, batched
// together since neither touches any calculation logic:
//   1. The Profile tab's province dropdown is alphabetized (Alberta, BC,
//      Ontario, Quebec) instead of the old ad-hoc Quebec/Ontario/BC/Alberta
//      order. (The default-selected province is unaffected either way --
//      _loadProfileState() always sets it explicitly via _stateGet(...,
//      'quebec') rather than relying on option order -- see check below.)
//   2. On the Retirement Income tab, the Monte Carlo ("Sequence-of-Returns
//      Risk") box and the Year-by-Year Withdrawal Breakdown table now
//      render ABOVE the "Annual Gross Income by Source" stacked chart and
//      its sibling Account-Balances/After-Tax charts, instead of below.
// 2026-09-11 update: the Estate summary's own position, called out above as
// unchanged at the time, WAS later moved (a separate JP request) to sit
// directly below the Year-by-Year table -- i.e. now BEFORE the income
// chart, not after it as this file originally asserted. See
// tests/48-estate-box-reorder.js for that move's own dedicated coverage;
// the ordering checks below are updated to match instead of re-asserting
// the old (now-superseded) position.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ---- Province dropdown is alphabetized ----
  const provinceOrder = await page.evaluate(() => {
    const sel = document.getElementById('profileProvince');
    return Array.from(sel.options).filter(o => !o.disabled).map(o => o.value);
  });
  check('province dropdown options are alphabetized (alberta, bc, ontario, quebec)',
    JSON.stringify(provinceOrder) === JSON.stringify(['alberta', 'bc', 'ontario', 'quebec']));

  const placeholderLast = await page.evaluate(() => {
    const sel = document.getElementById('profileProvince');
    const last = sel.options[sel.options.length - 1];
    return last.disabled === true;
  });
  check('the disabled "More provinces coming soon" placeholder stays last', placeholderLast);

  // ---- Default selected province is untouched by the reorder (still set
  // explicitly by _loadProfileState(), not by which <option> comes first) --
  const defaultProvince = await page.evaluate(() => {
    localStorage.clear();
    _loadProfileState();
    return document.getElementById('profileProvince').value;
  });
  check('default province is still quebec after the dropdown reorder', defaultProvince === 'quebec');

  // ---- Retirement Income tab: Monte Carlo + Year-by-Year now render above
  // Annual Gross Income by Source (and its sibling balance/tax charts) -----
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);

  const order = await page.evaluate(() => {
    const panel = document.getElementById('panelRet') || document.querySelector('#ret, [id*="ret"]');
    const mc = document.getElementById('monteCarloBox');
    const table = document.getElementById('mainTable');
    const incomeChart = document.getElementById('incomeChart');
    const balanceChart = document.getElementById('balanceChart');
    const estateGrid = document.getElementById('estateGrid');
    if (!mc || !table || !incomeChart || !balanceChart || !estateGrid) {
      return { error: 'missing element', found: { mc: !!mc, table: !!table, incomeChart: !!incomeChart, balanceChart: !!balanceChart, estateGrid: !!estateGrid } };
    }
    // Node A is "before" Node B if A's position bitmask includes
    // DOCUMENT_POSITION_FOLLOWING (4) on B relative to A.
    const isBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      mcBeforeIncomeChart: isBefore(mc, incomeChart),
      mcBeforeTable: isBefore(mc, table),
      tableBeforeIncomeChart: isBefore(table, incomeChart),
      incomeChartBeforeBalanceChart: isBefore(incomeChart, balanceChart),
      tableBeforeEstateGrid: isBefore(table, estateGrid),
      estateGridBeforeIncomeChart: isBefore(estateGrid, incomeChart),
    };
  });
  check('Monte Carlo box renders before the Annual Gross Income by Source chart', order.mcBeforeIncomeChart);
  check('Monte Carlo box renders before the Year-by-Year table', order.mcBeforeTable);
  check('Year-by-Year table renders before the Annual Gross Income by Source chart', order.tableBeforeIncomeChart);
  check('Annual Gross Income by Source chart still precedes the Account Balances/After-Tax charts', order.incomeChartBeforeBalanceChart);
  check('Year-by-Year table still precedes the Estate summary', order.tableBeforeEstateGrid);
  // 2026-09-11: Estate summary was moved to sit right after the table, so it
  // now precedes the income chart (previously it followed it) -- see
  // tests/48-estate-box-reorder.js for the dedicated test of this move.
  check('Estate summary now precedes the Annual Gross Income by Source chart', order.estateGridBeforeIncomeChart);

  // ---- The reorder is purely visual: Monte Carlo still works, and the
  // deterministic table/charts still render with real content. -----------
  const t1 = await page.evaluate(() => {
    document.getElementById('mcEnabled').checked = true;
    toggleMonteCarloPanel();
    document.getElementById('mcIterations').value = '300';
  });
  await page.evaluate(() => { runMonteCarloUI(); });
  await page.waitForFunction(() => {
    const el = document.getElementById('mcResults');
    return el && el.style.display !== 'none';
  }, { timeout: 10000 });
  const t2 = await page.evaluate(() => ({
    successText: document.getElementById('mcSuccessRate')?.textContent || '',
    tableRows: document.getElementById('tableBody')?.children.length || 0,
  }));
  check('Monte Carlo still runs correctly after the move', /% of 300 simulated retirements/.test(t2.successText));
  check('Year-by-Year table still populates rows after the move', t2.tableRows > 0);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  if (order.error) console.error('order eval error:', JSON.stringify(order));

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
