'use strict';
// "Better highlight shortfall years" (JP, picked from the roadmap's
// Remaining table). The app already had two different things that could be
// called a "shortfall": the Gap column (target income vs. mandatory income,
// BEFORE drawing on TFSA/Non-Reg -- usually successfully covered and not a
// real problem) and a true funding shortfall (d.shortfall>0: even TFSA +
// Non-Reg + Emergency Fund withdrawals can't fully cover the budget need).
// JP confirmed (AskUserQuestion) he means the second one -- previously this
// had NO per-row marker in the Year-by-Year table at all, only the single
// aggregate "⚠️ $XXK shortfall" badge at the top of the page.
//
// Added: a `tr-shortfall` row class (a stronger red tint than the existing
// subtle .tr-phase* backgrounds, via the tr+class CSS form so it reliably
// wins regardless of which phase the row also falls in) plus a ⚠️ warning
// icon (with a tooltip naming the shortfall amount) in the Year column.
// Deliberately NOT the Age column -- test 38 filters "real" data rows by
// requiring the Age cell's textContent to be pure digits (/^\d+$/), which
// an appended icon there would have broken.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('.age-btn.active')?.click(); });
  await page.waitForTimeout(300);

  // ---- Negative control: JP's real (comfortable) default portfolio, no
  // budget filled in at all -- should have zero true-shortfall rows. ----
  const neg = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const anyShortfall = DATA.some(d => (d.shortfall||0) > 0);
    const flaggedRows = document.querySelectorAll('#mainTable tbody tr.tr-shortfall').length;
    return { anyShortfall, flaggedRows, rowCount: DATA.length };
  });
  check('sanity: default/comfortable portfolio scenario has rows to check', neg.rowCount > 0);
  check('negative control: comfortable default portfolio has no real shortfall in the simulation data', !neg.anyShortfall);
  check('negative control: no row is flagged tr-shortfall when there is no real shortfall', neg.flaggedRows === 0);

  // ---- Positive scenario: force a real, uncovered shortfall -- a tiny
  // synthetic portfolio (via portfolioOverride, the same injection point
  // the app itself uses to seed a live sim) plus a huge monthly rent that
  // no plausible income/withdrawal here could cover. ----
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 20000);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    lastAccRows = null; liveData = null;
    portfolioOverride = { lif: 1000, rrsp: 1000, tfsa: 0 };
    currentAge = 62; renderAll(62);
  });
  await page.waitForTimeout(200);

  const pos = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const shortfallRows = DATA.filter(d => (d.shortfall||0) > 0);
    const cleanRows = DATA.filter(d => (d.shortfall||0) === 0);
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => /^\d+$/.test(tr.children[1]?.textContent || ''));
    const mk = d => {
      const row = rows.find(tr => parseInt(tr.children[1].textContent) === d.age);
      return {
        age: d.age,
        found: !!row,
        hasClass: row ? row.classList.contains('tr-shortfall') : false,
        yearCellHtml: row ? row.children[0].innerHTML : '',
        ageColIsDigits: row ? /^\d+$/.test(row.children[1]?.textContent || '') : null,
      };
    };
    return {
      shortfallCount: shortfallRows.length,
      results: shortfallRows.map(mk),
      cleanResults: cleanRows.map(mk),
    };
  });
  check('positive scenario actually produces at least one real shortfall row (test is meaningful)', pos.shortfallCount > 0);
  check('every real-shortfall row is found in the rendered table', pos.results.every(r => r.found));
  check('every real-shortfall row carries the tr-shortfall class', pos.results.every(r => r.hasClass));
  check("every real-shortfall row's Year cell shows the warning icon", pos.results.every(r => r.yearCellHtml.includes('⚠')));
  check("a shortfall row's Age column is still pure digits (doesn't break the /^\\d+$/ row filter test 38 relies on)", pos.results.every(r => r.ageColIsDigits === true));
  check('no shortfall-free row in the same scenario is flagged tr-shortfall', pos.cleanResults.every(r => !r.hasClass));
  check("no shortfall-free row's Year cell shows the warning icon", pos.cleanResults.every(r => !r.yearCellHtml.includes('⚠')));

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0,5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
