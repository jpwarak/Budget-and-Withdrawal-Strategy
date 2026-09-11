'use strict';
// DB Pension: a blank per-age field now carries forward the last EXPLICITLY
// filled younger age's amount instead of silently becoming $0 (JP's own
// example: fill only Age 55 and Age 60, leave 61-65 blank -> every
// retirement age 61-65 should use Age 60's amount). Covers:
//   - _updateDBTables()'s carry-forward logic itself, including that an
//     explicitly-typed "0" is honored as a real $0 (not treated as blank).
//   - A pre-existing, unrelated bug found while building this: _updateDBTables()
//     was previously called ONLY from the live debounced onchange handler,
//     never on page load, so a saved custom DB amount displayed correctly in
//     the input but silently kept using the OLD hardcoded default in every
//     simulation until the user touched a DB field again. Fixed by calling
//     _updateDBTables() right after _loadAccState() restores the DOM.
//   - _loadAccState()'s matching restore-guard exception: a deliberately-
//     cleared dbAge field must actually restore as blank (not silently
//     revert to its hardcoded HTML default), specifically for the 7 dbAge*
//     ids -- every other Accumulation-tab field keeps its prior "blank
//     falls through to a computed/legacy default" behavior unchanged.
// The core invariant: nobody who has never touched a DB field sees any
// change at all -- the 7 fields' hardcoded HTML defaults are all non-blank,
// so carry-forward and the restore-guard exception are both no-ops for the
// out-of-the-box case.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);

  // ---- Default (nobody touches anything): DB_BASE matches the original
  // hardcoded literals exactly -- zero behavior change out of the box. -----
  const t1 = await page.evaluate(() => ({ ...DB_BASE }));
  check('default DB_BASE unchanged (age 55)', t1[55] === 20889);
  check('default DB_BASE unchanged (age 60)', t1[60] === 40169);
  check('default DB_BASE unchanged (age 65)', t1[65] === 61049);

  // ---- Core carry-forward scenario: JP's own example -- fill 55 & 60,
  // blank out 61-65, confirm 61-65 all pick up age 60's amount. -----------
  const t2 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbAge55', '20889');
    setVal('dbAge60', '40169');
    ['dbAge61', 'dbAge62', 'dbAge63', 'dbAge64', 'dbAge65'].forEach(id => setVal(id, ''));
    _updateDBTables();
    return { ...DB_BASE };
  });
  check('blank 61 carries forward from 60', t2[61] === 40169);
  check('blank 62 carries forward from 60', t2[62] === 40169);
  check('blank 63 carries forward from 60', t2[63] === 40169);
  check('blank 64 carries forward from 60', t2[64] === 40169);
  check('blank 65 carries forward from 60', t2[65] === 40169);
  check('filled ages (55, 60) are untouched by carry-forward', t2[55] === 20889 && t2[60] === 40169);

  // ---- Carry-forward chains through multiple consecutive blanks correctly,
  // and resumes from a NEWLY filled age partway through the sequence -------
  const t3 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbAge55', ''); // blank at the very start -> carries forward from the implicit 0 starting point
    setVal('dbAge60', '40169');
    setVal('dbAge61', ''); // carries from 60
    setVal('dbAge62', '50267'); // explicitly re-filled -> becomes the new carry-forward source
    setVal('dbAge63', ''); // carries from 62, not 60
    setVal('dbAge64', '');
    setVal('dbAge65', '61049'); // explicitly filled again
    _updateDBTables();
    return { ...DB_BASE };
  });
  check('a blank leading field (age 55) carries forward from $0, not a stale value', t3[55] === 0);
  check('age 61 (blank) carries forward from age 60', t3[61] === 40169);
  check('age 62 (explicitly filled) is its own value', t3[62] === 50267);
  check('age 63 (blank) carries forward from the NEWLY filled age 62, not age 60', t3[63] === 50267);
  check('age 64 (blank) also carries forward from age 62', t3[64] === 50267);
  check('age 65 (explicitly filled) is its own value, unaffected by the carry chain', t3[65] === 61049);

  // ---- An explicit "0" is honored as a real $0 DB amount, not treated as
  // blank/carry-forward -- same explicit-zero convention as elsewhere. -----
  const t4 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbAge55', '20889');
    setVal('dbAge60', '0'); // explicit zero -- e.g. no DB entitlement kicks in until later
    setVal('dbAge61', ''); // should carry forward the explicit 0, not skip back to age 55's value
    _updateDBTables();
    return { age60: DB_BASE[60], age61: DB_BASE[61] };
  });
  check('an explicitly-typed "0" is honored as a real $0 (not treated as blank)', t4.age60 === 0);
  check('a blank field after an explicit "0" carries forward the 0, not an earlier nonzero value', t4.age61 === 0);

  // ---- End-to-end: the carried-forward DB amount actually feeds a real
  // simulation via _getDB(), not just the standalone DB_BASE object. -------
  const t5 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbAge55', '20889'); setVal('dbAge60', '40169');
    ['dbAge61','dbAge62','dbAge63','dbAge64','dbAge65'].forEach(id => setVal(id, ''));
    _updateDBTables();
    return { dbAt63: _getDB(63, 63), dbAt60: _getDB(60, 60) };
  });
  check('_getDB() at a carried-forward retirement age (63) reflects age 60\'s amount', Math.abs(t5.dbAt63 - 40169) < 1);
  check('_getDB() at the source age (60) is unaffected', Math.abs(t5.dbAt60 - 40169) < 1);

  // ---- Reload persistence: a deliberately-cleared field survives a reload
  // as blank (the _loadAccState() restore-guard fix), and DB_BASE is synced
  // from the restored DOM on load (the _updateDBTables()-on-load fix) -----
  await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    setVal('dbAge55', '20889');
    setVal('dbAge60', '40169');
    setVal('dbAge65', '99999'); // also prove a plain (non-blank) custom value survives the reload-sync fix
    ['dbAge61','dbAge62','dbAge63','dbAge64'].forEach(id => setVal(id, ''));
  });
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(1200);
  const t6 = await page.evaluate(() => {
    const val = id => document.getElementById(id)?.value;
    return {
      inputsAfterReload: { 61: val('dbAge61'), 62: val('dbAge62'), 63: val('dbAge63'), 64: val('dbAge64'), 65: val('dbAge65') },
      dbBaseAfterReload: { ...DB_BASE },
    };
  });
  check('a cleared field (age 61) stays blank in the DOM after reload', t6.inputsAfterReload[61] === '');
  check('a cleared field (age 64) stays blank in the DOM after reload', t6.inputsAfterReload[64] === '');
  check('a customized non-blank field (age 65 = 99999) survives the reload', t6.inputsAfterReload[65] === '99999');
  check('DB_BASE is synced from the DOM on load, not stuck on old hardcoded defaults (age 65)', t6.dbBaseAfterReload[65] === 99999);
  check('DB_BASE correctly carries forward on load too (age 61 from age 60)', t6.dbBaseAfterReload[61] === 40169);
  check('DB_BASE correctly carries forward on load too (age 64 from age 60)', t6.dbBaseAfterReload[64] === 40169);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
