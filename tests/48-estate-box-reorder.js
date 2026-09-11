'use strict';
// JP: "Move Estate-at-85 box below Year-by-Year table + compact the stat
// row." Two changes to the Retirement Income tab, bundled together since
// they're both about the same block:
//   1. The "Estate at Age 85 (if death at 85)" section (label + the 6-card
//      grid) moves from after all three charts (income/balance/tax) to
//      directly below the Year-by-Year Withdrawal Breakdown table -- a pure
//      DOM-position move; everything inside is still populated via
//      getElementById, unaffected by where its container sits.
//   2. The estate grid's CSS was `grid-template-columns: repeat(5,1fr)`
//      while the JS has always rendered 6 cards (LIF, RRIF, TFSA, Non-Reg,
//      Emergency Fund, Net Estate) -- a real pre-existing mismatch that
//      forced the 6th card onto its own row regardless of page position.
//      Fixed by switching to the same auto-fit/minmax(140px,1fr) pattern
//      already used by .age-summary, so all 6 sit on one line at normal
//      widths and wrap gracefully (never overflow) at phone width.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2], { viewport: { width: 1400, height: 1000 } });
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);

  // ==== Position: Estate summary now sits directly after the Year-by-Year
  // table, before the income/balance/tax charts (previously the reverse). ====
  const order = await page.evaluate(() => {
    const table = document.getElementById('mainTable');
    const estateLabel = document.getElementById('estateSectionLabel');
    const estateGrid = document.getElementById('estateGrid');
    const incomeChart = document.getElementById('incomeChart');
    const balanceChart = document.getElementById('balanceChart');
    const isBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      tableBeforeEstateLabel: isBefore(table, estateLabel),
      tableBeforeEstateGrid: isBefore(table, estateGrid),
      estateLabelBeforeGrid: isBefore(estateLabel, estateGrid),
      estateGridBeforeIncomeChart: isBefore(estateGrid, incomeChart),
      estateGridBeforeBalanceChart: isBefore(estateGrid, balanceChart),
    };
  });
  check('Year-by-Year table precedes the Estate section label', order.tableBeforeEstateLabel);
  check('Year-by-Year table precedes the Estate grid', order.tableBeforeEstateGrid);
  check('Estate section label precedes the Estate grid (label above cards)', order.estateLabelBeforeGrid);
  check('Estate summary now precedes the Annual Gross Income by Source chart (was after it)', order.estateGridBeforeIncomeChart);
  check('Estate summary now precedes the Account Balances chart too', order.estateGridBeforeBalanceChart);

  // ==== Content: the move is purely visual -- the estate cards still
  // populate with real data after an age is selected. ====
  await page.evaluate(() => { document.querySelector('.age-btn[data-age="65"]')?.click(); });
  await page.waitForTimeout(400);
  const content = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#estateGrid .est-card')];
    return {
      count: cards.length,
      labels: cards.map(c => c.querySelector('h4')?.textContent),
      allHaveValues: cards.every(c => /\S/.test(c.querySelector('.ev')?.textContent || '')),
      sectionLabelText: document.getElementById('estateSectionLabel').textContent,
    };
  });
  check('all 6 estate cards are present after the move (LIF, RRIF, TFSA, Non-Reg, Emergency Fund, Net Estate)', content.count === 6);
  check('every estate card still has a populated dollar value', content.allHaveValues);
  check('the "Estate at Age X" label still updates with the simulated final age', /Estate at Age \d+/.test(content.sectionLabelText));

  // ==== Layout: all 6 cards fit on one visual row at a normal desktop
  // width (the actual "compact the stat row" fix) ====
  const geoWide = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#estateGrid .est-card')];
    const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
    return { uniqueRows: new Set(tops).size };
  });
  check('at 1400px width, all 6 estate cards sit on a single row (previously 5-col grid forced a 2nd row)', geoWide.uniqueRows === 1);

  // ==== Responsive: at phone width, cards wrap to multiple rows instead of
  // overflowing or being cut off ====
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(200);
  const geoNarrow = await page.evaluate(() => {
    const grid = document.getElementById('estateGrid');
    const gridRect = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll('.est-card')];
    return {
      noHorizontalOverflow: cards.every(c => c.getBoundingClientRect().right <= gridRect.right + 1),
      wrapsToMultipleRows: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size > 1,
    };
  });
  check('at phone width (400px), estate cards wrap to multiple rows instead of overflowing', geoNarrow.wrapsToMultipleRows);
  check('at phone width, no card overflows the grid container horizontally', geoNarrow.noHorizontalOverflow);

  // ==== Report tab is unaffected -- it clones and assembles elements in
  // its own independent order regardless of the live tab's DOM position ====
  await page.setViewportSize({ width: 1400, height: 1000 });
  const reportOrder = await page.evaluate(async () => {
    showTab('report');
    await new Promise(r => setTimeout(r, 800));
    const content = document.getElementById('reportContent') || document.querySelector('[id*="report"]');
    return { hasContent: !!(content && content.innerHTML.length > 100) };
  });
  check('Report tab still generates content after the estate-box move', reportOrder.hasContent);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
