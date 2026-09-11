'use strict';
// WR% column (Year-by-Year table) and the "Portfolio WR" summary stat both
// went through a scope change: originally LIF+RRIF draws only over the
// starting total portfolio (which already included TFSA+Non-Reg in its
// denominator -- an inconsistency), now LIF+RRIF+TFSA+Non-Reg draws over
// the same denominator, so the metric reflects everything actually drawn
// down to fund spending, not just the two registered accounts. DB/QPP/OAS
// stay excluded throughout (guaranteed income, not portfolio being spent).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // High budget + realistic portfolio so TFSA/Non-Reg actually get drawn in
  // some years -- otherwise the old and new formulas would coincidentally
  // agree (both 0 contribution) and this test wouldn't prove anything.
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 8000);
    fill('bud_houseMortgage_amt', 4000);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('.age-btn.active')?.click(); });
  await page.waitForTimeout(300);

  const t1 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    // renderAll() always seeds a live simulation now (see
    // _syncLiveDataForAge()), so liveData.ra===currentAge is guaranteed here
    // -- no more static-table fallback to read instead.
    const DATA = liveData.data[spendMode][comboKey];
    const port = liveData.rawPort;
    const totalPort = port.lif + port.rrsp + port.tfsa + (port.nonreg || 0);

    // At least one year must actually draw from TFSA or Non-Reg for this
    // scenario to meaningfully exercise the new numerator.
    const hasTfsaOrNonregDraw = DATA.some(d => (d.tfsa || 0) > 0 || (d.nonreg || 0) > 0);

    // Recompute what the app SHOULD show (new formula) and what the OLD
    // formula would have shown, for every row, and compare against the
    // actual rendered WR% cell text (3rd column) via the app's own render
    // path -- not a copy of the formula, read straight from renderAll's
    // own totalPort/DATA the same way the app computes it, then compared
    // to the live DOM text.
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => tr.children.length > 2);
    const mismatches = [];
    let anyDiffersFromOldFormula = false;
    DATA.forEach((d, i) => {
      const newWR = totalPort > 0 ? (((d.lif + d.rrif + d.tfsa + d.nonreg) / totalPort) * 100).toFixed(1) + '%' : '—';
      const oldWR = totalPort > 0 ? (((d.lif + d.rrif) / totalPort) * 100).toFixed(1) + '%' : '—';
      if (newWR !== oldWR) anyDiffersFromOldFormula = true;
      const row = rows.find(tr => parseInt(tr.children[1]?.textContent) === d.age);
      const cellText = row?.children[2]?.textContent;
      if (cellText !== newWR) mismatches.push({ age: d.age, expected: newWR, got: cellText, lif: d.lif, rrif: d.rrif, tfsa: d.tfsa, nonreg: d.nonreg });
    });

    // Summary stat cross-check.
    const initPortDraw = DATA[0].lif + DATA[0].rrif + DATA[0].tfsa + DATA[0].nonreg;
    const expectedInitWR = totalPort > 0 ? (initPortDraw / totalPort * 100).toFixed(1) : 'N/A';
    const summaryText = document.getElementById('ageSummary')?.textContent || '';

    return { hasTfsaOrNonregDraw, anyDiffersFromOldFormula, mismatches, expectedInitWR, summaryHasExpectedInit: summaryText.includes(expectedInitWR + '%') };
  });

  check('scenario actually draws from TFSA and/or Non-Reg in at least one year (test is meaningful)', t1.hasTfsaOrNonregDraw);
  check('new WR% formula differs from the old LIF+RRIF-only formula in at least one row (change has a real effect)', t1.anyDiffersFromOldFormula);
  check('every rendered WR% cell matches LIF+RRIF+TFSA+Non-Reg ÷ starting total portfolio', t1.mismatches.length === 0);
  if (t1.mismatches.length) console.log('Mismatches:', t1.mismatches.slice(0, 5));
  check('"Portfolio WR" summary stat (Init) reflects the same updated formula', t1.summaryHasExpectedInit);

  // Sanity: an all-registered scenario (no TFSA/Non-Reg draws at all, e.g.
  // a fully-funded-by-DB/QPP/OAS+LIF/RRIF plan) should be unaffected by the
  // formula change -- old and new formulas agree exactly when tfsa=nonreg=0
  // every year, confirming this isn't a blanket shift for everyone.
  const t2 = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 65; renderAll(65);
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const port = liveData.rawPort;
    const totalPort = port.lif + port.rrsp + port.tfsa + (port.nonreg || 0);
    const allZero = DATA.every(d => (d.tfsa || 0) === 0 && (d.nonreg || 0) === 0);
    if (!allZero) return { skipped: true };
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => tr.children.length > 2);
    const mismatches = [];
    DATA.forEach(d => {
      const expected = totalPort > 0 ? (((d.lif + d.rrif) / totalPort) * 100).toFixed(1) + '%' : '—';
      const row = rows.find(tr => parseInt(tr.children[1]?.textContent) === d.age);
      if (row?.children[2]?.textContent !== expected) mismatches.push({ age: d.age, expected, got: row?.children[2]?.textContent });
    });
    return { skipped: false, mismatches };
  });
  if (!t2.skipped) {
    check('preset-estimate scenario with zero TFSA/Non-Reg draws: WR% unaffected by the formula change', t2.mismatches.length === 0);
  }

  // --- Per-account WR% breakdown (collapsible detail row) ------------------
  // Re-enter the high-budget/realistic-portfolio scenario from t1 so there's
  // a year that draws from every account, then click a WR% cell and check
  // the breakdown it reveals against the same numbers used in t1.
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 8000);
    fill('bud_houseMortgage_amt', 4000);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 62; renderAll(62);
  });
  await page.waitForTimeout(200);

  const t3 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const port = liveData.rawPort;
    const totalPort = port.lif + port.rrsp + port.tfsa + (port.nonreg || 0);
    // Find a row that draws from all four accounts (or as many as this
    // scenario produces) so the breakdown has real content to check.
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => {
      const ageText = tr.children[1]?.textContent;
      return ageText && /^\d+$/.test(ageText);
    });
    const target = DATA.find(d => (d.lif||0) > 0 && (d.rrif||0) > 0 && ((d.tfsa||0) > 0 || (d.nonreg||0) > 0));
    if (!target) return { found: false };
    const row = rows.find(tr => parseInt(tr.children[1]?.textContent) === target.age);
    const wrCell = row?.children[2];
    wrCell.click();
    const detailTr = row.nextElementSibling;
    const breakdownText = detailTr.children[1]?.textContent || '';
    wrCell.click(); // toggle back off, leave the table as we found it
    const expectedTotal = totalPort > 0 ? (((target.lif+target.rrif+target.tfsa+target.nonreg)/totalPort)*100).toFixed(1)+'%' : '—';
    return {
      found: true,
      age: target.age,
      breakdownText,
      hasLif: target.lif>0 ? breakdownText.includes('LIF') : true,
      hasRrif: target.rrif>0 ? breakdownText.includes('RRIF') : true,
      hasTfsa: target.tfsa>0 ? breakdownText.includes('TFSA') : true,
      hasNonreg: target.nonreg>0 ? breakdownText.includes('Non-Reg') : true,
      hasExpectedTotal: breakdownText.includes(expectedTotal),
    };
  });
  check('found a year that draws from multiple accounts to test the breakdown against', t3.found);
  if (t3.found) {
    check('per-account breakdown mentions LIF when LIF was drawn', t3.hasLif);
    check('per-account breakdown mentions RRIF when RRIF was drawn', t3.hasRrif);
    check('per-account breakdown mentions TFSA when TFSA was drawn', t3.hasTfsa);
    check('per-account breakdown mentions Non-Reg when Non-Reg was drawn', t3.hasNonreg);
    check('per-account breakdown\'s total matches the WR% cell\'s own total', t3.hasExpectedTotal);
  }

  // A surplus year (nothing drawn from the portfolio at all) should show the
  // "no portfolio withdrawal" note rather than an empty or misleading line.
  const t4 = await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 65; renderAll(65);
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const surplus = DATA.find(d => (d.tfsa||0) === 0 && (d.nonreg||0) === 0 && (d.lif||0) === 0 && (d.rrif||0) === 0);
    if (!surplus) return { found: false };
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => {
      const ageText = tr.children[1]?.textContent;
      return ageText && /^\d+$/.test(ageText);
    });
    const row = rows.find(tr => parseInt(tr.children[1]?.textContent) === surplus.age);
    const wrCell = row?.children[2];
    wrCell.click();
    const detailTr = row.nextElementSibling;
    const breakdownText = detailTr.children[1]?.textContent || '';
    wrCell.click();
    return { found: true, breakdownText };
  });
  if (t4.found) {
    check('a year with zero portfolio withdrawal shows the "no withdrawal" note, not a misleading blank/zero line', t4.breakdownText.toLowerCase().includes('no portfolio withdrawal'));
  }

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
