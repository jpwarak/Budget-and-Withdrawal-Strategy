'use strict';
// DB Pension bridge benefit (item 6 of the 2026-09-11 batch): an optional
// extra amount some DB plans pay from retirement until a set age (typically
// 65, when CPP/QPP/OAS start), then it stops. Confirmed design: a new,
// SEPARATE "Bridge amount ($)" + "Bridge ends at age" pair of inputs, added
// on top of whatever the existing per-age DB_BASE table already produces
// before the bridge-end age, then dropped from that age onward -- not a
// reinterpretation of any of the 7 existing dbAge{N} fields. Both fields are
// blank by default (same "blank means default" convention as
// _nrPensionRate() etc.): blank amount = no bridge (0), blank end age = 65.
// The core invariant: leaving both fields blank must reproduce this file's
// original _getDB() numbers exactly -- zero behavior change out of the box.
const { openApp } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('acc'); });
  await page.waitForTimeout(300);

  // ---- Getter defaults: blank fields ----
  const t1 = await page.evaluate(() => ({
    amount: _dbBridgeAmount(),
    endAge: _dbBridgeEndAge(),
  }));
  check('_dbBridgeAmount() defaults to 0 when blank', t1.amount === 0);
  check('_dbBridgeEndAge() defaults to 65 when blank', t1.endAge === 65);

  // ---- Out-of-the-box invariant: blank bridge fields don't change _getDB() ----
  // (test 32 already locks in the pre-65 base-amount and post-65 COLA-formula
  // behavior in full; this just confirms adding the bridge feature didn't
  // disturb the simplest pre-65 case, which needs no COLA/freeze math at all.)
  const t2 = await page.evaluate(() => ({ at60: _getDB(60, 60) }));
  check('default (no bridge): _getDB() at 60 unchanged', t2.at60 === 40169);

  // ---- Setting a bridge amount adds it on top, before the bridge-end age ----
  const t3 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbBridgeAmount', '10000');
    setVal('dbBridgeEndAge', '65');
    return {
      at60: _getDB(60, 60), // retire at 60, simulated age 60 -> bridge active (60 < 65)
      at64: _getDB(60, 64), // still bridge age
      at65: _getDB(60, 65), // bridge ends AT 65 -> dropped
      at70: _getDB(60, 70),
    };
  });
  check('bridge adds $10,000 on top at age 60 (below bridge-end 65)', t3.at60 === 40169 + 10000);
  check('bridge still applies at age 64 (below bridge-end 65)', t3.at64 !== undefined && t3.at64 > 0);
  check('bridge drops off exactly at the bridge-end age (65)', t3.at65 < t3.at64);
  check('bridge stays dropped well past the bridge-end age (70)', t3.at70 < t3.at64);

  // ---- Bridge stacks correctly on top of the COLA-escalated range, and its
  // own end age is independent of the fixed 65 COLA-start boundary ----
  const t4 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbBridgeAmount', '');
    setVal('dbBridgeEndAge', '68');
    const noBridge66 = _getDB(65, 66);
    const noBridge67 = _getDB(65, 67);
    const noBridge68 = _getDB(65, 68);
    setVal('dbBridgeAmount', '5000');
    return {
      noBridge66, noBridge67, noBridge68,
      withBridge66: _getDB(65, 66), // within COLA range (65<=age<freeze), bridge active (66<68)
      withBridge67: _getDB(65, 67), // still active (67<68)
      withBridge68: _getDB(65, 68), // bridge ends here (68<68 is false)
    };
  });
  check('bridge (COLA range, age 66) is exactly the no-bridge COLA amount plus $5,000', Math.abs(t4.withBridge66 - t4.noBridge66 - 5000) < 1);
  check('bridge (COLA range, age 67) is exactly the no-bridge COLA amount plus $5,000', Math.abs(t4.withBridge67 - t4.noBridge67 - 5000) < 1);
  check('bridge drops off at its own end age (68), even though that is past the fixed 65 COLA-start boundary', Math.abs(t4.withBridge68 - t4.noBridge68) < 1);
  check('bridge drops off at 68: the DB amount is lower there than the (still-bridged) age 67', t4.withBridge68 < t4.withBridge67);

  // ---- Explicit "0" bridge amount is a real, honored zero (not "unset") ----
  const t5 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbBridgeAmount', '0');
    setVal('dbBridgeEndAge', '65');
    return { amount: _dbBridgeAmount(), dbAt60: _getDB(60, 60) };
  });
  check('an explicitly-typed "0" bridge amount is honored as a real $0 (not treated as blank)', t5.amount === 0);
  check('an explicit $0 bridge produces the same result as no bridge at all', t5.dbAt60 === 40169);

  // ---- useDBPension=false zeroes everything, bridge included ----
  const t6 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbBridgeAmount', '10000');
    setVal('dbBridgeEndAge', '65');
    const before = useDBPension;
    useDBPension = false;
    const withDbOff = _getDB(60, 60);
    useDBPension = before;
    return { withDbOff };
  });
  check('useDBPension=false zeroes the bridge along with the base DB pension', t6.withDbOff === 0);

  // ---- End-to-end: a real simulation run reflects the bridge in its "db" field ----
  const t7 = await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; };
    setVal('dbBridgeAmount', '8000');
    setVal('dbBridgeEndAge', '65');
    const ra = 60;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const rows = simulateResidentFixed(ra, 65, 65, rawPort);
    const row60 = rows.find(r => r.age === 60);
    const row65 = rows.find(r => r.age === 65);
    return { db60: row60 && row60.db, db65: row65 && row65.db };
  });
  check('a real simulateResidentFixed() run includes the bridge amount in "db" before the bridge-end age', t7.db60 === 40169 + 8000);
  check('a real simulateResidentFixed() run drops the bridge from "db" at the bridge-end age', t7.db65 < t7.db60);

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    setVal('dbBridgeAmount', '12345');
    setVal('dbBridgeEndAge', '63');
  });
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(1200);
  const t8 = await page.evaluate(() => ({
    amount: document.getElementById('dbBridgeAmount')?.value,
    endAge: document.getElementById('dbBridgeEndAge')?.value,
  }));
  check('bridge amount (12345) survives a reload', t8.amount === '12345');
  check('bridge end age (63) survives a reload', t8.endAge === '63');

  // ---- A fresh browser (never touched) still has both fields blank ----
  await browser.close();
  const { browser: b2, page: p2, consoleErrors: ce2 } = await openApp(process.argv[2]);
  const t9 = await p2.evaluate(() => ({
    amountVal: document.getElementById('dbBridgeAmount')?.value,
    endAgeVal: document.getElementById('dbBridgeEndAge')?.value,
  }));
  check('a fresh browser has both bridge fields blank by default', t9.amountVal === '' && t9.endAgeVal === '');
  await b2.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${consoleErrors.length + ce2.length}`);
  console.log(fail === 0 && consoleErrors.length === 0 && ce2.length === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && consoleErrors.length === 0 && ce2.length === 0 ? 0 : 1);
})();
