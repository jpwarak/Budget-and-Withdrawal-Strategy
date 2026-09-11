'use strict';
// Provincial one-time 50% LIF-to-RRSP/RRIF unlock (Canada Resident's existing
// "50% LIF->RRIF" checkbox, newly gated by each jurisdiction's REAL rule,
// researched directly against each regulator, 2026):
//   - Federally regulated pension override (checkbox): OSFI RLIF rule, age
//     55+, applies regardless of which province is selected.
//   - Ontario: FSRA Schedule 1.1 / Form 5.2 -- no age requirement, always
//     available.
//   - Alberta: exercised before LIRA->LIF conversion, requires age 50+.
//   - Quebec, British Columbia: confirmed against Retraite Quebec / BCFSA --
//     NEITHER has any one-time percentage-based unlocking provision at all.
// Covers: _halfUnlockAllowed()/_halfUnlockUnavailableReason() across all 4
// provinces x relevant ages x federal-override on/off; the checkbox's
// disabled/checked/opacity/title reflecting that; that a mid-session
// province/age/federal-override change that makes the transfer newly illegal
// clears the underlying halfUnlock flag BEFORE (not just alongside) the next
// live simulation run -- proven by checking simulated LIF/RRSP balances
// directly, not just DOM/checkbox state; persistence across reload; and that
// a pre-existing saved plan from before this gating existed (Quebec +
// halfUnlock=1, illegal under the real rule) gets silently corrected on load
// rather than staying wrong. Deliberately does NOT test the Alberta/BC
// small-balance auto-unlock mechanism -- JP chose to defer that to a later,
// separate phase.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  const setProvince = (p) => page.evaluate((prov) => {
    document.getElementById('profileProvince').value = prov;
    onProfileFieldChange();
  }, p);
  const setFederalOverride = (on) => page.evaluate((val) => {
    const cb = document.getElementById('dcFederallyRegulated');
    cb.checked = val;
    onDcFederallyRegulatedChange();
  }, on);

  // ---- _halfUnlockAllowed() / _halfUnlockUnavailableReason(): the 4
  // provinces, no federal override ----
  await setFederalOverride(false);

  await setProvince('ontario');
  const ontario = await page.evaluate(() => [40, 50, 55, 65].map(a => _halfUnlockAllowed(a)));
  check('Ontario: allowed at 40 (no age requirement at all)', ontario[0] === true);
  check('Ontario: allowed at 50', ontario[1] === true);
  check('Ontario: allowed at 55', ontario[2] === true);
  check('Ontario: allowed at 65', ontario[3] === true);

  await setProvince('alberta');
  const alberta = await page.evaluate(() => [40, 49, 50, 65].map(a => _halfUnlockAllowed(a)));
  check('Alberta: NOT allowed at 40 (under 50)', alberta[0] === false);
  check('Alberta: NOT allowed at 49 (under 50)', alberta[1] === false);
  check('Alberta: allowed at exactly 50', alberta[2] === true);
  check('Alberta: allowed at 65', alberta[3] === true);
  const albertaReason = await page.evaluate(() => _halfUnlockUnavailableReason(49));
  check('Alberta reason at 49 mentions age 50', /50/.test(albertaReason));

  await setProvince('quebec');
  const quebec = await page.evaluate(() => [40, 55, 65, 90].map(a => _halfUnlockAllowed(a)));
  check('Quebec: never allowed at 40', quebec[0] === false);
  check('Quebec: never allowed at 55', quebec[1] === false);
  check('Quebec: never allowed at 65', quebec[2] === false);
  check('Quebec: never allowed at 90 (no such provision exists at any age)', quebec[3] === false);
  const quebecReason = await page.evaluate(() => _halfUnlockUnavailableReason(65));
  check('Quebec reason explains no provision exists (not phrased as an age gate)', /no one-time unlocking provision/i.test(quebecReason));

  await setProvince('bc');
  const bc = await page.evaluate(() => [40, 55, 65, 90].map(a => _halfUnlockAllowed(a)));
  check('BC: never allowed at 40', bc[0] === false);
  check('BC: never allowed at 55', bc[1] === false);
  check('BC: never allowed at 65', bc[2] === false);
  check('BC: never allowed at 90', bc[3] === false);
  const bcReason = await page.evaluate(() => _halfUnlockUnavailableReason(65));
  check('BC reason explains no provision exists', /no one-time unlocking provision/i.test(bcReason));

  // ---- Federal override supersedes every province's own rule ----
  await setFederalOverride(true);
  for (const prov of ['quebec', 'ontario', 'alberta', 'bc']) {
    await setProvince(prov);
    const results = await page.evaluate(() => [54, 55, 65].map(a => _halfUnlockAllowed(a)));
    check(`federal override on ${prov}: NOT allowed at 54 (under 55)`, results[0] === false);
    check(`federal override on ${prov}: allowed at exactly 55`, results[1] === true);
    check(`federal override on ${prov}: allowed at 65`, results[2] === true);
  }
  const fedReason = await page.evaluate(() => _halfUnlockUnavailableReason(54));
  check('federal-override reason mentions age 55', /55/.test(fedReason));
  await setFederalOverride(false);

  // ---- Checkbox reflects gating: disabled/checked/opacity/title ----
  await page.evaluate(() => { setMode('resident'); });
  await setProvince('quebec');
  const quebecCheckbox = await page.evaluate(() => {
    const el = document.getElementById('halfUnlock');
    const lbl = document.getElementById('lblHalfUnlock');
    return { disabled: el.disabled, checked: el.checked, opacity: lbl.style.opacity, title: lbl.title };
  });
  check('Quebec (resident mode): checkbox disabled', quebecCheckbox.disabled === true);
  check('Quebec (resident mode): checkbox unchecked', quebecCheckbox.checked === false);
  check('Quebec (resident mode): label dimmed (opacity < 1)', parseFloat(quebecCheckbox.opacity) < 1);
  check('Quebec (resident mode): title explains why, not the generic description', /Not available/i.test(quebecCheckbox.title));

  await setProvince('ontario');
  const ontarioCheckbox = await page.evaluate(() => {
    const el = document.getElementById('halfUnlock');
    const lbl = document.getElementById('lblHalfUnlock');
    return { disabled: el.disabled, opacity: lbl.style.opacity, title: lbl.title };
  });
  check('Ontario (resident mode): checkbox enabled', ontarioCheckbox.disabled === false);
  check('Ontario (resident mode): label full opacity', parseFloat(ontarioCheckbox.opacity) === 1);
  check('Ontario (resident mode): title is the plain description, not an unavailability reason', !/Not available/i.test(ontarioCheckbox.title));

  // Non-Resident mode: checkbox must stay disabled even where the province
  // would otherwise allow it (Resident-only feature; Non-Resident has its
  // own separate nrLifUnlock choice).
  await page.evaluate(() => { setMode('nonresident'); });
  const ontarioNonResCheckbox = await page.evaluate(() => document.getElementById('halfUnlock').disabled);
  check('Ontario, but Non-Resident mode: checkbox still disabled (Resident-only feature)', ontarioNonResCheckbox === true);
  await page.evaluate(() => { setMode('resident'); });

  // ---- Core regression: a province/age/federal-override change that makes
  // the transfer newly illegal corrects the underlying simulation BEFORE the
  // next run, not just the checkbox's visual state ----
  await setProvince('ontario');
  const beforeSwitch = await page.evaluate(() => {
    runLiveSim(65, 100000, 50000, 20000, 0);
    const cb = document.getElementById('halfUnlock');
    cb.checked = true;
    onHalfUnlockChange();
    return { halfUnlock, liveLif: liveData.port.lif, rawLif: liveData.rawPort.lif };
  });
  check('Ontario: checking the box actually sets halfUnlock=true', beforeSwitch.halfUnlock === true);
  check('Ontario: live sim reflects the 50% transfer (port.lif < rawPort.lif)', beforeSwitch.liveLif < beforeSwitch.rawLif);
  // _forceHalfSplit() defines the moved amount as Math.round(rawLif*0.5) and
  // leaves the REMAINDER (rawLif - moved) as the new lif balance -- so for
  // an ODD rawLif, the remaining lif is exactly 1 less than Math.round(rawLif
  // * 0.5) itself (Math.round rounds x.5 up, so the moved half absorbs the
  // odd cent, not the remainder). A strict `liveLif === Math.round(rawLif*
  // 0.5)` check only happens to hold for an EVEN rawLif -- it isn't a real
  // requirement of "moved exactly half" and shouldn't be pinned to whichever
  // parity this test's live-synced Accumulation-tab balance happens to land
  // on (e.g. it flipped once the Individual Account Rate feature changed the
  // projected dollar figures). Check the actual invariant instead: moved +
  // remaining reconstructs the original balance exactly, and the split is
  // within a single rounding cent of an even half either way.
  check('Ontario: transfer moved exactly half the LIF (within the inherent 1-cent rounding remainder)',
    Math.abs(beforeSwitch.liveLif - Math.round(beforeSwitch.rawLif * 0.5)) <= 1 &&
    beforeSwitch.liveLif + Math.round(beforeSwitch.rawLif * 0.5) === beforeSwitch.rawLif);

  const afterSwitch = await setProvinceAndInspect('quebec');
  check('switching to Quebec: halfUnlock flag is cleared', afterSwitch.halfUnlock === false);
  check('switching to Quebec: checkbox unchecked', afterSwitch.checkboxChecked === false);
  check('switching to Quebec: checkbox disabled', afterSwitch.checkboxDisabled === true);
  check('switching to Quebec: the live sim that just ran (inside rerunRetirement) is NOT split -- corrected before simulating, not after', afterSwitch.liveLif === afterSwitch.rawLif);

  async function setProvinceAndInspect(prov) {
    return page.evaluate((p) => {
      document.getElementById('profileProvince').value = p;
      onProfileFieldChange(); // internally: _updateHalfUnlockAvailability() THEN rerunRetirement()
      return {
        halfUnlock,
        checkboxChecked: document.getElementById('halfUnlock').checked,
        checkboxDisabled: document.getElementById('halfUnlock').disabled,
        liveLif: liveData.port.lif,
        rawLif: liveData.rawPort.lif,
      };
    }, prov);
  }

  // Same regression, via the federal-override toggle instead of a province
  // change (a second, independent call site -- onDcFederallyRegulatedChange).
  await setProvince('ontario');
  await page.evaluate(() => {
    runLiveSim(65, 100000, 50000, 20000, 0);
    const cb = document.getElementById('halfUnlock');
    cb.checked = true;
    onHalfUnlockChange();
  });
  const afterFedOverrideAtLowAge = await page.evaluate(() => {
    // Federal override at an age (65 is already set) still passes (65>=55),
    // so first prove the override alone doesn't spuriously clear it...
    const cb = document.getElementById('dcFederallyRegulated');
    cb.checked = true;
    onDcFederallyRegulatedChange();
    return { halfUnlock, liveLif: liveData.port.lif, rawLif: liveData.rawPort.lif };
  });
  check('federal override at age 65 (still >=55): half-unlock survives (not spuriously cleared)', afterFedOverrideAtLowAge.halfUnlock === true && afterFedOverrideAtLowAge.liveLif < afterFedOverrideAtLowAge.rawLif);
  // ...then re-run the SAME live sim at a synthetic sub-55 age directly
  // through the exact two calls the age-button click handler makes, in the
  // same order, to prove the ordering guard actually holds for that call
  // site too (none of the real age buttons cross the 50/55 thresholds, since
  // the youngest is 55, so this drives the same two functions the way the
  // click handler does instead of relying on a button that can't reach a
  // sub-55 age).
  const afterSimulatedAgeBtnClick = await page.evaluate(() => {
    lastAccRows = (lastAccRows || []).concat([{ age: 48, dc: 100000, rrsp: 50000, tfsa: 20000, nr: 0 }]);
    // Exact sequence from the .age-btn click handler:
    _updateHalfUnlockAvailability(48);
    _syncLiveDataForAge(48);
    return { halfUnlock, liveLif: liveData.port.lif, rawLif: liveData.rawPort.lif };
  });
  check('federal override, synthetic age 48 (<55): halfUnlock cleared before the age-button-handler-style live sim ran', afterSimulatedAgeBtnClick.halfUnlock === false);
  check('federal override, synthetic age 48: that live sim is NOT split', afterSimulatedAgeBtnClick.liveLif === afterSimulatedAgeBtnClick.rawLif);
  await setFederalOverride(false);

  // ---- Persistence across reload: Ontario + checked survives ----
  await setProvince('ontario');
  await page.evaluate(() => {
    document.querySelector('.age-btn[data-age="65"]').click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const cb = document.getElementById('halfUnlock');
    cb.checked = true;
    onHalfUnlockChange();
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const afterReloadOntario = await page.evaluate(() => ({
    province: document.getElementById('profileProvince').value,
    halfUnlock,
    checkboxChecked: document.getElementById('halfUnlock').checked,
  }));
  check('Ontario + checked: province survives reload', afterReloadOntario.province === 'ontario');
  check('Ontario + checked: halfUnlock=true survives reload (still legal there)', afterReloadOntario.halfUnlock === true);
  check('Ontario + checked: checkbox still checked after reload', afterReloadOntario.checkboxChecked === true);

  // ---- Backward-compatibility: a plan saved BEFORE this gating existed,
  // with a combination that's illegal under the real rule (Quebec +
  // halfUnlock=1 -- impossible to produce today via the UI, but exactly what
  // an old localStorage blob from before this feature could contain), gets
  // silently corrected on load rather than staying wrong. ----
  const staleState = {
    v: 1,
    ret: { tab: 'ret', age: '65', spendMode: 'resident', qppStart: '65', oasStart: '65', halfUnlock: '1', nrLifUnlock: 'none' },
    profile: { province: 'quebec' },
    acc: {},
    budget: {},
    nav: {},
  };
  const { browser: browser2, page: page2 } = await openApp(process.argv[2], {
    seedLocalStorage: { plannerState: JSON.stringify(staleState) },
  });
  const staleLoadResult = await page2.evaluate(() => ({
    province: document.getElementById('profileProvince').value,
    halfUnlock,
    checkboxChecked: document.getElementById('halfUnlock').checked,
    checkboxDisabled: document.getElementById('halfUnlock').disabled,
  }));
  check('stale pre-gating save (Quebec + halfUnlock=1) restores province correctly', staleLoadResult.province === 'quebec');
  check('stale pre-gating save: halfUnlock flag corrected to false on load (Quebec never allows this)', staleLoadResult.halfUnlock === false);
  check('stale pre-gating save: checkbox shows unchecked, not the stale saved "checked"', staleLoadResult.checkboxChecked === false);
  check('stale pre-gating save: checkbox shows disabled', staleLoadResult.checkboxDisabled === true);
  await browser2.close();

  // ---- Non-Resident's OWN LIF choice (nrLifUnlock) is untouched by any of
  // this -- it remains available regardless of province, unlike Resident's
  // checkbox (different legal mechanism, out of scope for this gating) ----
  await setProvince('quebec');
  await page.evaluate(() => { setMode('nonresident'); });
  const nonResStillWorks = await page.evaluate(() => {
    const radio = document.querySelector('input[name="nrLifUnlock"][value="half"]');
    radio.checked = true;
    onNrLifUnlockChange();
    return { nrLifUnlock, rows: simulateNonResident(65, 65, 65, { lif: 2000, rrsp: 2000, tfsa: 0, nonreg: 0 }) };
  });
  check('Non-Resident LIF choice (nrLifUnlock) still works in Quebec -- ungated, separate federal mechanism', nonResStillWorks.nrLifUnlock === 'half' && Array.isArray(nonResStillWorks.rows) && nonResStillWorks.rows.length > 0);
  await page.evaluate(() => { setMode('resident'); });

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
