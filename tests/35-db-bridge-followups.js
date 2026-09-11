'use strict';
// Three follow-up fixes JP reported right after using the new DB bridge
// benefit (item 6, tests/34-db-bridge.js):
//   1. The DB Pension summary at the top of the Retirement Income tab
//      didn't reflect an active bridge at all -- it always showed the plain
//      per-age DB_BASE amount.
//   2. Editing the bridge amount/end-age fields had no visible effect until
//      an age button was clicked or the page reloaded -- root cause: the
//      DB-fields debounce handler called a plain renderAll(), which only
//      reflects DB_BASE/bridge changes when a live sim already exists for
//      the current age; it needed rerunRetirement() (same fix already used
//      for CPI rate/growth rate/simEndAge) to force a live run from a cold
//      start too. This bug pre-dated the bridge feature and affected every
//      DB field (dbAge*, dbCola, dbFreezeAge), not just the new bridge ones
//      -- it was just never noticed until the bridge made it obvious.
//   3. Reloading the Retirement Income tab (even after closing and
//      reopening the browser) restored the WRONG retirement age -- one
//      click behind whatever was actually last selected. Root cause: the
//      age-button click handler called _saveRetState() (which persists the
//      global `currentAge`) BEFORE renderAll(ra) (which is what actually
//      updates that global to the new age), so every reload restored the
//      age active before the last click, not the one just picked.
const { openApp } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ==== Fix 3: age-button click persists the NEWLY clicked age, not the
  // previous one. Reproduce JP's exact scenario: click through a sequence of
  // ages ending on 65, then reload. ====
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(400);
  for (const age of [55, 60, 61, 62, 63, 64, 65]) {
    await page.evaluate((a) => { document.querySelector(`.age-btn[data-age="${a}"]`).click(); }, age);
    await page.waitForTimeout(150);
  }
  const beforeReload = await page.evaluate(() => ({
    currentAge,
    savedAge: JSON.parse(localStorage.getItem('plannerState') || '{}').ret?.age,
  }));
  check('clicking age 65 last updates currentAge to 65 immediately', beforeReload.currentAge === 65);
  check('clicking age 65 last persists 65 (not the previous age, 64) to storage', String(beforeReload.savedAge) === '65');
  await page.reload();
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => ({
    currentAge,
    activeBtn: document.querySelector('.age-btn.active')?.dataset.age,
  }));
  check('reloading restores the actual last-clicked age (65), not one click behind', afterReload.currentAge === 65);
  check('the age-65 button (not 64) shows as active after reload', afterReload.activeBtn === '65');

  // ==== Fix 2: editing the bridge amount takes effect immediately, without
  // needing an age-button click or a reload first. ====
  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);
  const t2 = await page.evaluate(async () => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    showTab('ret');
    document.querySelector('.age-btn[data-age="60"]').click();
    await new Promise(r => setTimeout(r, 200));
    const before = document.getElementById('ageSummary').innerHTML;
    showTab('acc');
    setVal('dbBridgeAmount', '15000');
    setVal('dbBridgeEndAge', '65');
    await new Promise(r => setTimeout(r, 500)); // let the 300ms debounce fire
    showTab('ret');
    const after = document.getElementById('ageSummary').innerHTML;
    return { before, after, liveDataRa: (typeof liveData !== 'undefined' && liveData) ? liveData.ra : null };
  });
  check('editing the bridge amount (debounced) changes the rendered DB Pension summary without any age click or reload', t2.before !== t2.after);
  // Long-form by default since 2026-09-11 (was "15.0K/yr bridge" when
  // dollar values were always abbreviated) -- see tests/46-currency-format-toggle.js.
  check('the DB Pension summary now shows the bridge amount reflected ($15,000/yr line)', /\$15,000\/yr bridge/.test(t2.after));

  // ==== Fix 1: the DB Pension summary at the top of the Retirement Income
  // tab reflects an active bridge (amount + label + "to age X" note), and
  // correctly does NOT show it once the viewed retirement age is past the
  // bridge-end age. ====
  const t3 = await page.evaluate(async () => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    showTab('acc');
    setVal('dbBridgeAmount', '9000');
    setVal('dbBridgeEndAge', '63');
    await new Promise(r => setTimeout(r, 500));
    showTab('ret');
    document.querySelector('.age-btn[data-age="60"]').click();
    await new Promise(r => setTimeout(r, 300));
    const activeSummary = document.getElementById('ageSummary').innerHTML;
    document.querySelector('.age-btn[data-age="65"]').click();
    await new Promise(r => setTimeout(r, 300));
    const pastEndSummary = document.getElementById('ageSummary').innerHTML;
    return { activeSummary, pastEndSummary };
  });
  check('at age 60 (bridge active, ends at 63), the summary label shows "DB Pension + Bridge"', t3.activeSummary.includes('DB Pension + Bridge'));
  check('at age 60, the summary shows the "to age 63" bridge note', /to age 63/.test(t3.activeSummary));
  check('at age 65 (past the bridge-end age of 63), the summary reverts to the plain "DB Pension" label', t3.pastEndSummary.includes('>DB Pension<'));
  check('at age 65, the bridge note is gone from the summary', !/bridge to age/.test(t3.pastEndSummary));

  // ==== No behavior change when no bridge is configured at all ====
  const t4 = await page.evaluate(async () => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    showTab('acc');
    setVal('dbBridgeAmount', '');
    setVal('dbBridgeEndAge', '');
    await new Promise(r => setTimeout(r, 500));
    showTab('ret');
    document.querySelector('.age-btn[data-age="60"]').click();
    await new Promise(r => setTimeout(r, 300));
    return document.getElementById('ageSummary').innerHTML;
  });
  check('with no bridge configured, the summary label stays plain "DB Pension" (no "+ Bridge")', t4.includes('>DB Pension<') && !t4.includes('+ Bridge'));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${consoleErrors.length}`);
  console.log(fail === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && consoleErrors.length === 0 ? 0 : 1);
})();
