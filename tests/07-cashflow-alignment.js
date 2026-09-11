'use strict';
// The Cash Flow breakdown detail row must render under the Cash Flow column
// of the Year-by-Year Withdrawal Breakdown table, not under the Tax column.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2], { viewport: { width: 1900, height: 1000 } });
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(800);

  const key = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('#mainTable td[onclick*="toggleTaxDetail"]'));
    const cf = cells.find(td => td.style.color === 'rgb(74, 222, 128)' && td.textContent.trim().startsWith('+'));
    if (!cf) return null;
    const m = cf.getAttribute('onclick').match(/toggleTaxDetail\('([^']+)'\)/);
    return m ? m[1] : null;
  });
  check('found a positive cash-flow row to expand', !!key);

  if (key) {
    await page.evaluate((k) => { toggleTaxDetail(k); }, key);
    await page.waitForTimeout(300);

    const alignInfo = await page.evaluate((k) => {
      const ths = Array.from(document.querySelectorAll('#mainTable thead th'));
      const cfHeader = ths.find(th => th.textContent.trim().startsWith('Cash Flow'));
      const detTr = document.getElementById('taxDet_' + k);
      if (!detTr || !cfHeader) return null;
      const tds = Array.from(detTr.children);
      const cfTd = tds.find(td => td.textContent.includes('Cash Flow:'));
      if (!cfTd) return null;
      const hRect = cfHeader.getBoundingClientRect();
      const cfRect = cfTd.getBoundingClientRect();
      return { headerLeft: hRect.left, headerRight: hRect.right, cfCellLeft: cfRect.left, cfCellRight: cfRect.right };
    }, key);
    check('Cash Flow detail cell aligns with the Cash Flow header column', !!alignInfo && Math.abs(alignInfo.cfCellLeft - alignInfo.headerLeft) < 3 && Math.abs(alignInfo.cfCellRight - alignInfo.headerRight) < 3);
  }

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
