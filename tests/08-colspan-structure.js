'use strict';
// The Year-by-Year table's expanded detail row must have colspans that sum
// to exactly the header column count -- a broken table structure was the
// root cause behind the Cash-Flow-alignment bug this checks don't regress.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);

  const info = await page.evaluate(() => {
    const taxTd = document.querySelector('#mainTable td.col-tax[onclick]');
    const onclickAttr = taxTd.getAttribute('onclick');
    const key = onclickAttr.match(/toggleTaxDetail\('([^']+)'\)/)[1];
    toggleTaxDetail(key);
    const parentTr = taxTd.closest('tr');
    const detailTr = parentTr.nextElementSibling;
    const tds = Array.from(detailTr.querySelectorAll('td'));
    const totalColspan = tds.reduce((s, td) => s + parseInt(td.getAttribute('colspan') || '1', 10), 0);
    const headerCount = document.querySelectorAll('#mainTable thead th').length;
    return { totalColspan, headerCount };
  });
  console.log(JSON.stringify(info));

  const ok = info.totalColspan === info.headerCount && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
