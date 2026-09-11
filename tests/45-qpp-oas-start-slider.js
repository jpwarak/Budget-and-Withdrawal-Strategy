'use strict';
// "CPP/QPP & OAS start-age slider" (JP, named alongside "Long-form currency
// values by default" and "CPP/QPP box: show % of maximum @ age 65" as the
// next three roadmap items). Replaces the old QPP 65/70 and OAS 65/70
// toggle-button pairs with continuous sliders.
//
// Confirmed with JP (AskUserQuestion) before building:
//  1. Ranges/granularity: whole-year steps, QPP up to 72 for Quebec / CPP
//     up to 70 everywhere else, OAS 65-70 -- the real statutory deferral
//     ceilings (confirmed via Retraite Québec and canada.ca: QPP -- Quebec
//     only -- defers at +0.7%/month up to age 72, max +58.8%; CPP, the same
//     benefit under its non-Quebec name, defers at the same +0.7%/month but
//     stops at 70, max +42%, same ceiling as OAS's +0.6%/month/+36%) --
//     matching the app's existing annual-resolution simulation engine (no
//     month-level granularity anywhere else).
//  2. Performance: precompute the full grid up front in runLiveSim() (8 QPP
//     ages x 6 OAS ages x 2 residency modes = 96 _runSim() calls for
//     Quebec/QPP; 6 x 6 x 2 = 72 for CPP provinces, since CPP has 2 fewer
//     selectable start ages), same shape as the old 4-combo grid, so every
//     slider position is an instant lookup with no drag lag.
//  3. Phase narrative: the Retirement Income tab's 3-phase story (Bridge /
//     65-69 / Age 70 / 71+) is kept, but the QPP/OAS commentary inside each
//     phase card (and the Year-by-Year table's phase-header rows) is now
//     derived from wherever the sliders actually land, instead of only
//     recognizing exactly 65 or 70.
//
// Two real, pre-existing/newly-introduced bugs were found and fixed as part
// of this work (neither a separate roadmap item, just necessary fixes):
//  - _getOAS(age, oasStart) used to be hardcoded `oasStart===70 ? <special
//    case> : 17500`, silently treating any start age that wasn't exactly 65
//    or 70 (66-69) as if it were 65 with zero deferral bonus -- harmless
//    while only two buttons existed, wrong the instant a slider could land
//    in between. It's now a continuous formula (same shape as _getQPP()'s),
//    verified to reproduce the old hardcoded numbers exactly at 65 and 70.
//  - JP caught a second bug in this feature's own first cut: the slider's
//    max was hardcoded to 72 unconditionally, which is only correct for
//    Quebec's QPP -- every other province's CPP maxes out at 70, same as
//    OAS (canada.ca: "there's no benefit to wait after age 70"). Fixed via
//    _qppMaxStart() (72 for Quebec, 70 otherwise), which now drives both the
//    slider's max attribute (kept in sync on every province change, with an
//    existing >70 QPP selection clamped down if it survives a switch away
//    from Quebec) and the combo grid's upper bound.
//
// This test's central concerns: (1) _getOAS's continuous formula is
// monotonic and correct across the whole 65-70 range and matches the old
// hardcoded values exactly at the two old fixed points; (2) _getQPP still
// works correctly out to its new real ceiling of 72 (it already used a
// continuous formula, so this is a no-regression check, not a fix); (3)
// the old toggle buttons are gone and replaced by real range inputs with
// the correct min/max/step, wired to setQpp/setOas; (4) the precomputed
// combo grid actually covers all 48 QPP x OAS combinations, not just the
// old 4; (5) the phase cards and Year-by-Year table headers produce
// sensible, non-misleading text for start ages that fall strictly inside a
// phase window (66-69, or 71-72 for QPP) -- particularly that a QPP start
// deferred to 71 or 72 is never shown as "$0 (running)" the way the old
// two-branch (===70 / else) logic would have shown it; and (6) both
// sliders' positions persist across a reload for a genuinely non-65/70
// value.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);

  // ---- Old toggle buttons are gone. ----
  const t0 = await page.evaluate(() => ({
    btnQpp65: document.getElementById('btnQpp65'),
    btnQpp70: document.getElementById('btnQpp70'),
    btnOas65: document.getElementById('btnOas65'),
    btnOas70: document.getElementById('btnOas70'),
  }));
  check('old QPP 65/70 toggle buttons are gone', t0.btnQpp65 === null && t0.btnQpp70 === null);
  check('old OAS 65/70 toggle buttons are gone', t0.btnOas65 === null && t0.btnOas70 === null);

  // ---- New sliders exist with the confirmed ranges, defaulting to 65. ----
  const t1 = await page.evaluate(() => {
    const qpp = document.getElementById('qppSlider');
    const oas = document.getElementById('oasSlider');
    return {
      qppExists: !!qpp, qppMin: qpp?.min, qppMax: qpp?.max, qppStep: qpp?.step, qppVal: qpp?.value,
      oasExists: !!oas, oasMin: oas?.min, oasMax: oas?.max, oasStep: oas?.step, oasVal: oas?.value,
      qppValLabel: document.getElementById('qppSliderVal')?.textContent,
      oasValLabel: document.getElementById('oasSliderVal')?.textContent,
    };
  });
  check('QPP slider exists', t1.qppExists);
  check('QPP slider range is 65-72 (real statutory deferral ceiling)', t1.qppMin === '65' && t1.qppMax === '72');
  check('QPP slider steps by whole years', t1.qppStep === '1');
  check('QPP slider defaults to 65', t1.qppVal === '65' && t1.qppValLabel === '65');
  check('OAS slider exists', t1.oasExists);
  check('OAS slider range is 65-70 (real statutory deferral ceiling, 2 years short of QPP\'s)', t1.oasMin === '65' && t1.oasMax === '70');
  check('OAS slider steps by whole years', t1.oasStep === '1');
  check('OAS slider defaults to 65', t1.oasVal === '65' && t1.oasValLabel === '65');

  // ---- Dragging a slider (oninput) actually calls setQpp/setOas, which
  // updates the global start age AND both the slider's own position and its
  // adjacent value label (refreshQppOasSliders()). ----
  const t2 = await page.evaluate(() => {
    const qppEl = document.getElementById('qppSlider');
    qppEl.value = 68;
    qppEl.dispatchEvent(new Event('input'));
    const oasEl = document.getElementById('oasSlider');
    oasEl.value = 67;
    oasEl.dispatchEvent(new Event('input'));
    return {
      qppStartGlobal: qppStart,
      oasStartGlobal: oasStart,
      qppSliderVal: qppEl.value,
      oasSliderVal: oasEl.value,
      qppLabel: document.getElementById('qppSliderVal').textContent,
      oasLabel: document.getElementById('oasSliderVal').textContent,
    };
  });
  check('dragging the QPP slider to 68 updates the global qppStart', t2.qppStartGlobal === 68);
  check('dragging the OAS slider to 67 updates the global oasStart', t2.oasStartGlobal === 67);
  check('QPP slider value label reflects the new position', t2.qppLabel === '68');
  check('OAS slider value label reflects the new position', t2.oasLabel === '67');

  // ---- _getOAS() bug fix: continuous, monotonic across 65-70, and
  // reproduces the OLD hardcoded numbers exactly at the two old fixed
  // points (nothing on screen should have moved for existing 65/70 users). ----
  const t3 = await page.evaluate(() => {
    const oldOas65 = 17500;
    const oldOas70 = Math.round(17500 * 1.36 * Math.pow(1 + _conservativeRate(), 5));
    const spread = [];
    for (let oasStart = 65; oasStart <= 70; oasStart++) {
      spread.push({ oasStart, atStart: _getOAS(oasStart, oasStart) });
    }
    return { oldOas65, oldOas70, spread };
  });
  check('_getOAS(65,65) still matches the old hardcoded $17,500 base', t3.spread[0].atStart === t3.oldOas65);
  check('_getOAS(70,70) still matches the old hardcoded 65->70 deferral formula exactly', t3.spread[5].atStart === t3.oldOas70);
  const oasMonotonic = t3.spread.every((r, i) => i === 0 || r.atStart > t3.spread[i - 1].atStart);
  check('_getOAS is strictly increasing across every intermediate start age 65-70 (no more flat "treated as 65" bug for 66-69)', oasMonotonic);
  check('_getOAS produces a genuinely different (correct) number at an intermediate age like 67, not the old age-65 fallback', t3.spread[2].atStart !== t3.oldOas65);

  // ---- _getQPP() already worked continuously -- confirm it still does, out
  // to its real new ceiling of 72 (no regression, this function wasn't
  // touched). ----
  const t4 = await page.evaluate(() => {
    const spread = [];
    for (let qppStart = 65; qppStart <= 72; qppStart++) {
      spread.push({ qppStart, atStart: _getQPP(qppStart, qppStart) });
    }
    return spread;
  });
  const qppMonotonic = t4.every((r, i) => i === 0 || r.atStart > t4[i - 1].atStart);
  check('_getQPP is strictly increasing across the full 65-72 range', qppMonotonic);
  check('_getQPP(72,72) reflects the full +58.8% max deferral bonus (19718 base * 1.588 = 31,312)', t4[7].atStart === Math.round(19718 * 1.588));

  // ---- Combo grid: runLiveSim() now precomputes all 48 QPP x OAS
  // combinations (8 x 6), not just the old 4, for both residency modes. ----
  const t5 = await page.evaluate(() => {
    runLiveSim(62, 400000, 300000, 150000, 0);
    const residentKeys = Object.keys(liveData.data.resident);
    const nonresidentKeys = Object.keys(liveData.data.nonresident);
    return {
      residentCount: residentKeys.length,
      nonresidentCount: nonresidentKeys.length,
      hasIntermediateCombo: residentKeys.includes('68_67'),
      hasExtremeCombo: residentKeys.includes('72_70'),
      hasOldDefaultCombo: residentKeys.includes('65_65'),
    };
  });
  check('resident combo grid has all 48 QPP(8) x OAS(6) combinations', t5.residentCount === 48);
  check('non-resident combo grid has all 48 combinations too', t5.nonresidentCount === 48);
  check('an intermediate combo (QPP 68 / OAS 67) is precomputed', t5.hasIntermediateCombo);
  check('the extreme combo (QPP 72 / OAS 70) is precomputed', t5.hasExtremeCombo);
  check('the old default combo (65/65) is still precomputed', t5.hasOldDefaultCombo);

  // ---- Province-dependent QPP ceiling (the bug JP caught in this feature's
  // first cut): only Quebec's QPP can defer to 72 -- every other province's
  // CPP maxes out at 70, same as OAS. The slider's max, an existing
  // out-of-range selection, and the combo grid's own upper bound all need
  // to track the selected province, not a single hardcoded 72. ----
  const t5b = await page.evaluate(() => {
    const setProvince = (p) => { document.getElementById('profileProvince').value = p; onProfileFieldChange(); };
    const quebecMax = document.getElementById('qppSlider').max; // still Quebec from earlier in this test
    setProvince('ontario');
    const ontarioMax = document.getElementById('qppSlider').max;
    runLiveSim(62, 400000, 300000, 150000, 0);
    const ontarioCombos = Object.keys(liveData.data.resident);
    // Push QPP to Quebec's 72 ceiling, then switch to a CPP province and
    // confirm the now-impossible selection is clamped down, not left as-is.
    setProvince('quebec');
    const qppEl = document.getElementById('qppSlider');
    qppEl.value = 72; qppEl.dispatchEvent(new Event('input'));
    const qppStartBeforeSwitch = qppStart;
    setProvince('bc');
    return {
      quebecMax, ontarioMax,
      ontarioComboCount: ontarioCombos.length,
      ontarioHas71: ontarioCombos.some(k => k.startsWith('71_')),
      ontarioHas72: ontarioCombos.some(k => k.startsWith('72_')),
      qppStartBeforeSwitch,
      qppStartAfterSwitch: qppStart,
      qppSliderValAfterSwitch: document.getElementById('qppSlider').value,
      qppSliderMaxAfterSwitch: document.getElementById('qppSlider').max,
    };
  });
  check('Quebec: QPP slider max is 72 (its real statutory ceiling)', t5b.quebecMax === '72');
  check('Ontario (CPP): QPP slider max is 70, not 72 -- the bug this fix addresses', t5b.ontarioMax === '70');
  check('Ontario\'s combo grid is 36 (6 CPP ages x 6 OAS ages), not 48', t5b.ontarioComboCount === 36);
  check('Ontario\'s combo grid has no 71-start or 72-start entries at all (not real selectable CPP start ages)', !t5b.ontarioHas71 && !t5b.ontarioHas72);
  check('QPP could genuinely be set to 72 while on Quebec (sanity check)', t5b.qppStartBeforeSwitch === 72);
  check('switching from Quebec (QPP@72) to a CPP province clamps the now-impossible selection down to 70', t5b.qppStartAfterSwitch === 70);
  check('the slider itself visually reflects the clamp, not just the underlying variable', t5b.qppSliderValAfterSwitch === '70' && t5b.qppSliderMaxAfterSwitch === '70');

  // Restore Quebec before the remaining checks, which assume QPP's own
  // 65-72 range (e.g. deferring to 72).
  await page.evaluate(() => { document.getElementById('profileProvince').value = 'quebec'; onProfileFieldChange(); });

  // ---- Phase cards + Year-by-Year table headers: no misleading text for a
  // QPP start deferred into Phase 4 (71 or 72) -- the old 2-branch ternary
  // (===70 / else "running") would have shown "$0 (running)" here, since
  // age 70's row genuinely has qpp=0 when qppStart is 71 or 72. ----
  const t6 = await page.evaluate(() => {
    qppStart = 72; oasStart = 65;
    document.querySelector('.age-btn[data-age="62"]').click();
    renderAll(62);
    const phaseText = document.getElementById('phaseCards').innerText;
    return {
      noZeroRunning: !phaseText.includes('$0.0K (running)') && !/\$0\s*\(running\)/.test(phaseText),
      mentionsPendingAt70: phaseText.includes('QPP Pending') || phaseText.includes('deferred to 72'),
      mentionsStartAt72: phaseText.includes('starts 72') || phaseText.includes('72'),
    };
  });
  check('a QPP start deferred to age 72 never shows a misleading "$0 (running)" in Phase 3\'s card', t6.noZeroRunning);
  check('Phase 3\'s heading/text correctly shows QPP as still pending (not "Unlocked" or "Running") when deferred to 72', t6.mentionsPendingAt70);
  check('the phase narrative names the real deferred-to age (72), not a hardcoded "70"', t6.mentionsStartAt72);

  // ---- Year-by-Year table: a start age landing strictly inside a phase's
  // own window (not on one of the 65/70/71 boundary rows) gets its own
  // marker row rather than going unmentioned. ----
  const t7 = await page.evaluate(() => {
    qppStart = 68; oasStart = 67;
    renderAll(62);
    const headerRows = Array.from(document.querySelectorAll('#tableBody .phase-header')).map(el => el.textContent);
    return { headerRows };
  });
  check('Year-by-Year table gets a standalone marker row for OAS starting mid-phase at 67', t7.headerRows.some(h => h.includes('OAS starts') && h.includes('67')));
  check('Year-by-Year table gets a standalone marker row for QPP starting mid-phase at 68', t7.headerRows.some(h => h.includes('QPP starts') && h.includes('68')));

  // ---- Regression: the exact old 65/65, 65/70, 70/65, 70/70 combos still
  // render without throwing and still show their historically-correct
  // phase text (spot-checking the two most distinctive old labels). ----
  const t8 = await page.evaluate(() => {
    qppStart = 70; oasStart = 70;
    renderAll(62);
    const text = document.getElementById('phaseCards').innerText;
    return {
      qppUnlocked: text.includes('QPP Unlocked') || text.includes('CPP Unlocked'),
      oasUnlocked: text.includes('OAS Unlocked'),
    };
  });
  check('the old QPP-70/OAS-70 combo still shows "...Unlocked" headings exactly as before (no regression)', t8.qppUnlocked && t8.oasUnlocked);

  // ---- Persistence: both slider positions survive a reload for a
  // genuinely non-65/70 combination. ----
  await page.evaluate(() => {
    const qppEl = document.getElementById('qppSlider');
    qppEl.value = 69; qppEl.dispatchEvent(new Event('input'));
    const oasEl = document.getElementById('oasSlider');
    oasEl.value = 68; oasEl.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const t9 = await page.evaluate(() => ({
    qppStartGlobal: qppStart,
    oasStartGlobal: oasStart,
    qppSliderVal: document.getElementById('qppSlider')?.value,
    oasSliderVal: document.getElementById('oasSlider')?.value,
  }));
  check('QPP start age (69) survives a reload', t9.qppStartGlobal === 69);
  check('OAS start age (68) survives a reload', t9.oasStartGlobal === 68);
  check('QPP slider visually restores to the saved position', t9.qppSliderVal === '69');
  check('OAS slider visually restores to the saved position', t9.oasSliderVal === '68');

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0, 5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
