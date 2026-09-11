'use strict';
// Merges the two former non-resident modes ("PH S.217 Realistic" and "PH +
// LIF Unlock") into a single "Non-Resident" mode, per JP's request: one
// model, with the LIF-transfer choice becoming a 3-way, mutually-exclusive
// AND OPTIONAL control (none / 50%->RRIF / 100%->Non-Reg) instead of a
// separate mode you had to pick. This is a UI/dispatch merge only -- the
// underlying tax/spending math (S.217 election, the $75K->$55K taper, the
// LIF-transfer mechanics themselves) is untouched, so this suite checks the
// merge is behaviorally transparent: 'none' reproduces the old PH S.217
// Realistic numbers exactly, 'half' reproduces old "PH + LIF Unlock: box 1",
// 'full' reproduces old "box 2" -- plus the new UI (single button, 3-way
// radio group) and migration of anyone's already-saved old-style choice.
const { openApp } = require('./lib');

(async () => {
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });
  let allConsoleErrors = 0;

  // ── Main session: fresh-browser UI, dispatch equivalence, persistence ──
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);

  // ---- Fresh browser: one button, no leftover old elements ----
  const freshDom = await page.evaluate(() => ({
    hasNonResidentBtn: !!document.getElementById('btnNonResident'),
    oldPh217Btn: document.getElementById('btnPh217Real'),
    oldPhLumpBtn: document.getElementById('btnPhLump'),
    oldFullUnlock: document.getElementById('fullUnlock'),
    groupHiddenWhileResident: document.getElementById('nrLifUnlockGroup')?.style.display === 'none',
    residentHalfUnlockVisible: document.getElementById('lblHalfUnlock')?.style.display !== 'none',
  }));
  check('fresh browser: single "Non-Resident" button exists', freshDom.hasNonResidentBtn);
  check('fresh browser: old "PH S.217 Realistic" button is gone', freshDom.oldPh217Btn === null);
  check('fresh browser: old "PH + LIF Unlock" button is gone', freshDom.oldPhLumpBtn === null);
  check('fresh browser: old "fullUnlock" checkbox is gone', freshDom.oldFullUnlock === null);
  check('fresh browser: the Non-Resident LIF-choice group is hidden while Resident', freshDom.groupHiddenWhileResident);
  check('fresh browser: Resident\'s own "50% LIF→RRIF" checkbox is visible while Resident', freshDom.residentHalfUnlockVisible);

  // ---- Switching to expat selects Non-Resident, defaulting to "no transfer" ----
  const toExpat = await page.evaluate(() => {
    document.getElementById('profileResidency').value = 'expat';
    onProfileResidencyChange();
    return {
      spendMode,
      nrLifUnlock,
      groupVisible: document.getElementById('nrLifUnlockGroup').style.display !== 'none',
      noneChecked: document.getElementById('nrUnlockNone').checked,
      halfChecked: document.getElementById('nrUnlockHalf').checked,
      fullChecked: document.getElementById('nrUnlockFull').checked,
      badgeText: document.getElementById('insightBox').innerHTML,
      residentHalfUnlockHidden: document.getElementById('lblHalfUnlock').style.display === 'none',
    };
  });
  check('picking "expat" selects the merged "nonresident" mode', toExpat.spendMode === 'nonresident');
  check('picking "expat" for the first time defaults nrLifUnlock to "none"', toExpat.nrLifUnlock === 'none');
  check('the LIF-choice group becomes visible in Non-Resident mode', toExpat.groupVisible);
  check('"No LIF transfer" radio is checked by default, the other two are not', toExpat.noneChecked && !toExpat.halfChecked && !toExpat.fullChecked);
  check('insight box now reads "Non-Resident" (not the old PH-specific names)', toExpat.badgeText.includes('Non-Resident') && !toExpat.badgeText.includes('PH S.217 Realistic') && !toExpat.badgeText.includes('PH + LIF Unlock'));
  check('Resident\'s own "50% LIF→RRIF" checkbox+label is hidden in Non-Resident mode (not just disabled)', toExpat.residentHalfUnlockHidden);

  // ---- Regression: 'none' reproduces the old ph217real numbers exactly ----
  const noneMatch = await page.evaluate(() => {
    const port = { lif: 500000, rrsp: 250000, tfsa: 200000 };
    const viaDispatch = _runSim('nonresident', 65, 65, 65, port);
    const direct = simulateNonResident(65, 65, 65, port);
    return JSON.stringify(viaDispatch) === JSON.stringify(direct);
  });
  check("'none': _runSim('nonresident',...) is byte-identical to the old simulateNonResident() call (no unlock)", noneMatch);

  // ---- Selecting "50% LIF->RRIF" reproduces the old "box 1" numbers exactly ----
  const halfMatch = await page.evaluate(() => {
    document.getElementById('nrUnlockHalf').checked = true;
    onNrLifUnlockChange();
    const port = { lif: 500000, rrsp: 250000, tfsa: 200000 };
    const viaDispatch = _runSim('nonresident', 65, 65, 65, port);
    const direct = simulateNonResident(65, 65, 65, _forceHalfSplit(port));
    return {
      nrLifUnlock,
      noneChecked: document.getElementById('nrUnlockNone').checked,
      fullChecked: document.getElementById('nrUnlockFull').checked,
      matches: JSON.stringify(viaDispatch) === JSON.stringify(direct),
    };
  });
  check('choosing "50% LIF→RRIF" sets nrLifUnlock to "half"', halfMatch.nrLifUnlock === 'half');
  check('choosing "half" unchecks the other two radios (mutually exclusive)', !halfMatch.noneChecked && !halfMatch.fullChecked);
  check("'half': _runSim('nonresident',...) is byte-identical to the old \"box 1\" call (simulateNonResident on a force-half-split port)", halfMatch.matches);

  // ---- Selecting "100% LIF->Non-Reg" reproduces the old "box 2" numbers exactly ----
  const fullMatch = await page.evaluate(() => {
    document.getElementById('nrUnlockFull').checked = true;
    onNrLifUnlockChange();
    const port = { lif: 500000, rrsp: 250000, tfsa: 200000 };
    const viaDispatch = _runSim('nonresident', 65, 65, 65, port);
    const direct = simulateNonResidentLump(65, 65, 65, port);
    return {
      nrLifUnlock,
      noneChecked: document.getElementById('nrUnlockNone').checked,
      halfChecked: document.getElementById('nrUnlockHalf').checked,
      matches: JSON.stringify(viaDispatch) === JSON.stringify(direct),
    };
  });
  check('choosing "100% LIF→Non-Reg" sets nrLifUnlock to "full"', fullMatch.nrLifUnlock === 'full');
  check('choosing "full" unchecks the other two radios (mutually exclusive)', !fullMatch.noneChecked && !fullMatch.halfChecked);
  check("'full': _runSim('nonresident',...) is byte-identical to the old \"box 2\" call (simulateNonResidentLump)", fullMatch.matches);

  // ---- Flipping to Resident and back to Non-Resident preserves the choice ----
  // (only the FIRST-ever pick of "expat" defaults to 'none' -- re-entering
  // afterward, including via the plain mode buttons, leaves it alone.)
  const roundTrip = await page.evaluate(() => {
    setMode('resident');
    const residentCheckboxVisibleWhileResident = document.getElementById('lblHalfUnlock').style.display !== 'none';
    setMode('nonresident');
    return {
      nrLifUnlock,
      fullChecked: document.getElementById('nrUnlockFull').checked,
      residentCheckboxVisibleWhileResident,
      residentCheckboxHiddenAgain: document.getElementById('lblHalfUnlock').style.display === 'none',
    };
  });
  check('switching Resident -> Non-Resident and back does not reset an already-made LIF choice', roundTrip.nrLifUnlock === 'full' && roundTrip.fullChecked);
  check('flipping to Resident re-shows Resident\'s own checkbox+label', roundTrip.residentCheckboxVisibleWhileResident);
  check('flipping back to Non-Resident re-hides Resident\'s own checkbox+label', roundTrip.residentCheckboxHiddenAgain);

  // ---- Persistence across reload ----
  await page.evaluate(() => {
    document.getElementById('nrUnlockHalf').checked = true;
    onNrLifUnlockChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => ({
    spendMode,
    nrLifUnlock,
    halfChecked: document.getElementById('nrUnlockHalf')?.checked,
    groupVisible: document.getElementById('nrLifUnlockGroup')?.style.display !== 'none',
  }));
  check('spendMode "nonresident" survives reload', afterReload.spendMode === 'nonresident');
  check('nrLifUnlock "half" survives reload', afterReload.nrLifUnlock === 'half');
  check('the "half" radio is re-checked on reload', afterReload.halfChecked === true);
  check('the LIF-choice group is visible again on reload', afterReload.groupVisible);

  allConsoleErrors += consoleErrors.length;
  await browser.close();

  // ── Three more sessions: the 'ph217real'/'phLump' -> 'nonresident' merge
  // migration was deliberately REMOVED 2026-09-11 (JP: "lets clean the code.
  // its not needed") -- this is a single-user personal file, and by this
  // point JP's own saved data has long since passed through a real mode-
  // button click, which unconditionally re-saves the current 'resident'/
  // 'nonresident' strings, so the old pre-merge values are already gone from
  // his actual data. What's left to guarantee is the documented, empirically-
  // verified fallback for a hypothetical leftover legacy string: it now falls
  // through as an unrecognized spendMode (broken Retirement Income tab,
  // console error, residency silently defaulting to "resident") until any
  // mode button is clicked, at which point it fully self-heals.
  //
  // Also updated 2026-09-11 (separately, for the static-reference-table
  // removal): renderAll() now always seeds and reads a live simulation keyed
  // by spendMode (there's no more RESIDENT_DATA fallback that happened to
  // tolerate an unrecognized mode string on the very first render). That
  // means the same documented crash now fires from all three page-load
  // render call sites instead of just one (setMode() inside the restore
  // IIFE, the restore IIFE's own renderAll(), and DOMContentLoaded's
  // _syncLiveDataForAge()+renderAll()) -- three caught-and-logged errors
  // instead of one, all caught (no raw uncaught PAGEERROR), same self-heal.
  const seedFor = (spendMode, phUnlockMode) => ({
    plannerState: JSON.stringify({
      v: 1,
      ret: { spendMode, phUnlockMode, age: '65', qppStart: '65', oasStart: '65' },
      acc: {}, budget: {}, nav: {},
    }),
  });

  const { browser: b1, page: p1, consoleErrors: ce1 } = await openApp(process.argv[2], { seedLocalStorage: seedFor('ph217real', undefined) });
  const r1 = await p1.evaluate(() => ({ spendMode, residency: document.getElementById('profileResidency')?.value }));
  check('no migration: saved "ph217real" is left as-is (not silently translated)', r1.spendMode === 'ph217real');
  check('no migration: an unrecognized legacy spendMode falls back to "resident" residency', r1.residency === 'resident');
  check('no migration: the unrecognized spendMode produces the expected (documented) render error, caught at every page-load render call site (no raw uncaught error)', ce1.length === 3 && ce1.every(e => /Live retirement sync failed/.test(e)));
  const healed1 = await p1.evaluate(() => { setMode('resident'); return spendMode; });
  check('no migration: clicking a mode button fully self-heals "ph217real" to "resident"', healed1 === 'resident');
  await b1.close();

  const { browser: b2, page: p2, consoleErrors: ce2 } = await openApp(process.argv[2], { seedLocalStorage: seedFor('phLump', 'half') });
  const r2 = await p2.evaluate(() => ({ spendMode, residency: document.getElementById('profileResidency')?.value }));
  check('no migration: saved "phLump"+half is left as-is (not silently translated)', r2.spendMode === 'phLump');
  check('no migration: "phLump" also falls back to "resident" residency', r2.residency === 'resident');
  const healed2 = await p2.evaluate(() => { setMode('nonresident'); return { spendMode, nrLifUnlock }; });
  check('no migration: clicking Non-Resident fully self-heals "phLump" to "nonresident" (fresh default LIF choice)', healed2.spendMode === 'nonresident');
  await b2.close();

  const { browser: b3, page: p3, consoleErrors: ce3 } = await openApp(process.argv[2], { seedLocalStorage: seedFor('phLump', 'full') });
  const r3 = await p3.evaluate(() => ({ spendMode, residency: document.getElementById('profileResidency')?.value }));
  check('no migration: saved "phLump"+full is also left as-is', r3.spendMode === 'phLump');
  await b3.close();

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${allConsoleErrors}`);
  console.log(fail === 0 && allConsoleErrors === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && allConsoleErrors === 0 ? 0 : 1);
})();
