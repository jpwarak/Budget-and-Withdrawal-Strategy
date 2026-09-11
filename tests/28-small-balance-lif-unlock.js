'use strict';
// Alberta/BC/Ontario small-balance full-unlock provisions (the item explicitly
// deferred during the provincial-LIF-unlock phase), plus two small housekeeping
// items done alongside it: removing the dead `.mode-btn.active-nonresident-unused`
// CSS rule, and a "figures current as of" footer note.
//
// Researched directly against each regulator (2026), and confirmed with JP to
// cover all three provinces (not just AB/BC as originally scoped) once Ontario's
// own real small-balance rule turned up during research:
//   - Alberta (ATB Financial's published guide) and British Columbia (BCFSA,
//     confirmed directly): NO minimum age. Under 20% of YMPE ($14,920 for
//     2026) below age 65, under 40% of YMPE ($29,840) at 65+.
//   - Ontario (FSRA, "Pension Unlocking: Non-Hardship", Form 5): a single 40%-
//     of-YMPE threshold ($29,840), but ONLY at age 55+ -- no lower-age tier.
//   - Federal (OSFI, for the existing "Federally regulated pension" override
//     checkbox): full unlock at or under 50% of YMPE ($37,300), no age gate.
//   - Quebec: moot -- its LIF already has no cap at all (2025 reform, covered
//     in the earlier provincial-LIF-max phase), so a small-balance rule would
//     never change anything there.
// Modeled as an eligibility FACT, not an elective choice, per JP's own framing
// when this was deferred: _lifMaxRate() simply returns 100% for an eligible
// year -- no new checkbox, exactly the mechanism already proven for Quebec's
// unconditional no-cap rule. Covers: _smallBalanceUnlockAllowed() boundary
// conditions for all 4 jurisdictions; _lifMaxRate()'s integration of that
// check for AB/BC/Ontario/federal-override, including that Quebec and a
// missing/undefined lifBal argument are both unaffected (backward compatible
// with every pre-existing _lifMaxRate(age) call, e.g. test 21's own checks);
// and an end-to-end regression proving a small LIF can fully drain in year 1
// through the real simulation engine when eligible, but stays capped when it
// isn't (wrong province, wrong age, or balance too big) -- not just that the
// standalone rate function returns 1.0. No persistence coverage needed: this
// feature adds no new checkbox or saved state, it's a pure function of
// province/age/balance that are already persisted and already tested
// elsewhere (tests 20, 21, 26).
const { openApp, finish } = require('./lib');

// Independent reimplementation of the Ontario/BC/Alberta annuity formula
// (same one test 21 uses), needed here to compute the expected CAPPED rate
// for the "not eligible" comparison cases below.
function expectedProvLifMaxRate(age) {
  const CURRENT_LONG_BOND_RATE = 0.0349;
  const FLOOR = 0.06;
  const a = Math.max(55, Math.min(Math.round(age), 90));
  if (a >= 90) return 1.0;
  const n = 90 - a;
  const r = Math.max(CURRENT_LONG_BOND_RATE, FLOOR);
  let F = 0;
  for (let t = 0; t < n; t++) F += Math.pow(1 / (1 + r), t);
  return 1 / F;
}

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

  // ---- _smallBalanceUnlockAllowed(): Alberta/BC, no age minimum ----
  for (const j of ['alberta', 'bc']) {
    const results = await page.evaluate((jur) => ([
      _smallBalanceUnlockAllowed(jur, 30, 14000),   // young, under $14,920 -> eligible
      _smallBalanceUnlockAllowed(jur, 30, 14920),   // exactly at threshold -> NOT eligible ("less than")
      _smallBalanceUnlockAllowed(jur, 30, 14919),   // just under -> eligible
      _smallBalanceUnlockAllowed(jur, 64, 14919),   // still under-65 tier at 64
      _smallBalanceUnlockAllowed(jur, 65, 25000),   // 65+, under $29,840 -> eligible
      _smallBalanceUnlockAllowed(jur, 65, 29840),   // exactly at 65+ threshold -> NOT eligible
      _smallBalanceUnlockAllowed(jur, 65, 29839),   // just under -> eligible
      _smallBalanceUnlockAllowed(jur, 90, 100000),  // large balance -> never eligible
      _smallBalanceUnlockAllowed(jur, 20, 5000),    // no age minimum at all -> eligible even at 20
    ]), j);
    check(`${j}: under-65, $14,000 -> eligible`, results[0] === true);
    check(`${j}: under-65, exactly $14,920 -> NOT eligible (boundary is "less than")`, results[1] === false);
    check(`${j}: under-65, $14,919 -> eligible`, results[2] === true);
    check(`${j}: age 64 still uses the under-65 tier`, results[3] === true);
    check(`${j}: 65+, $25,000 -> eligible`, results[4] === true);
    check(`${j}: 65+, exactly $29,840 -> NOT eligible`, results[5] === false);
    check(`${j}: 65+, $29,839 -> eligible`, results[6] === true);
    check(`${j}: large balance -> never eligible regardless of age`, results[7] === false);
    check(`${j}: no age minimum -- eligible even at age 20`, results[8] === true);
  }

  // ---- _smallBalanceUnlockAllowed(): Ontario, single 40% tier, 55+ gate ----
  const ontarioResults = await page.evaluate(() => ([
    _smallBalanceUnlockAllowed('ontario', 40, 5000),    // well under threshold but under 55 -> NOT eligible
    _smallBalanceUnlockAllowed('ontario', 54, 5000),    // one year short -> NOT eligible
    _smallBalanceUnlockAllowed('ontario', 55, 29000),   // 55+, under threshold -> eligible
    _smallBalanceUnlockAllowed('ontario', 55, 29840),   // exactly at threshold -> NOT eligible
    _smallBalanceUnlockAllowed('ontario', 55, 29839),   // just under -> eligible
    _smallBalanceUnlockAllowed('ontario', 80, 29839),   // well past 55 -> eligible
  ]));
  check('Ontario: under 55, tiny balance -> NOT eligible (age gate blocks it)', ontarioResults[0] === false);
  check('Ontario: age 54 -> NOT eligible', ontarioResults[1] === false);
  check('Ontario: age 55, under $29,840 -> eligible', ontarioResults[2] === true);
  check('Ontario: age 55, exactly $29,840 -> NOT eligible', ontarioResults[3] === false);
  check('Ontario: age 55, $29,839 -> eligible', ontarioResults[4] === true);
  check('Ontario: age 80, eligible balance -> eligible', ontarioResults[5] === true);

  // ---- _smallBalanceUnlockAllowed(): federal (OSFI), 50% tier, no age gate ----
  const fedResults = await page.evaluate(() => ([
    _smallBalanceUnlockAllowed('federal', 20, 37300),  // exactly at 50% -> eligible ("at or under")
    _smallBalanceUnlockAllowed('federal', 20, 37301),  // just over -> NOT eligible
    _smallBalanceUnlockAllowed('federal', 90, 37300),  // no age gate -- still eligible at 90
  ]));
  check('federal: exactly $37,300 (50% YMPE) -> eligible (rule is "at or under")', fedResults[0] === true);
  check('federal: $37,301 -> NOT eligible', fedResults[1] === false);
  check('federal: no age requirement -- eligible at 90 too', fedResults[2] === true);

  // ---- Quebec and zero/negative balances: never eligible via this function
  // (Quebec's case is moot -- _lifMaxRate short-circuits to 1.0 before ever
  // calling this, since Quebec's LIF already has no cap at all) ----
  const edgeResults = await page.evaluate(() => ([
    _smallBalanceUnlockAllowed('quebec', 65, 100),
    _smallBalanceUnlockAllowed('alberta', 65, 0),
    _smallBalanceUnlockAllowed('alberta', 65, -500),
  ]));
  check('quebec jurisdiction key: always false (handled separately in _lifMaxRate)', edgeResults[0] === false);
  check('zero balance: never eligible', edgeResults[1] === false);
  check('negative balance: never eligible', edgeResults[2] === false);

  // ---- _lifMaxRate(age, lifBal) integration: Alberta/BC/Ontario ----
  await setFederalOverride(false);
  for (const prov of ['alberta', 'bc']) {
    await setProvince(prov);
    const rates = await page.evaluate(() => ({
      eligibleUnder65: _lifMaxRate(40, 10000),   // under $14,920, under 65 -> unlocked
      notEligibleUnder65: _lifMaxRate(40, 20000),// over threshold -> normal formula
      eligible65plus: _lifMaxRate(70, 25000),    // under $29,840, 65+ -> unlocked
      notEligible65plus: _lifMaxRate(70, 40000), // over threshold -> normal formula
    }));
    check(`${prov}: eligible small balance under 65 -> _lifMaxRate returns 100%`, rates.eligibleUnder65 === 1);
    check(`${prov}: ineligible balance under 65 -> matches normal formula (not 100%)`, Math.abs(rates.notEligibleUnder65 - expectedProvLifMaxRate(40)) < 0.0001);
    check(`${prov}: eligible small balance 65+ -> _lifMaxRate returns 100%`, rates.eligible65plus === 1);
    check(`${prov}: ineligible balance 65+ -> matches normal formula`, Math.abs(rates.notEligible65plus - expectedProvLifMaxRate(70)) < 0.0001);
  }

  await setProvince('ontario');
  const ontarioRates = await page.evaluate(() => ({
    tooYoungEligibleBalance: _lifMaxRate(40, 10000),  // under threshold but under 55 -> normal formula
    eligible: _lifMaxRate(55, 25000),                 // 55+, under threshold -> unlocked
    notEligible: _lifMaxRate(55, 40000),              // 55+, over threshold -> normal formula
  }));
  check('Ontario: small balance but under 55 -> normal formula, NOT unlocked', Math.abs(ontarioRates.tooYoungEligibleBalance - expectedProvLifMaxRate(40)) < 0.0001);
  check('Ontario: 55+ and under threshold -> _lifMaxRate returns 100%', ontarioRates.eligible === 1);
  check('Ontario: 55+ but over threshold -> normal formula', Math.abs(ontarioRates.notEligible - expectedProvLifMaxRate(55)) < 0.0001);

  // ---- Quebec unaffected regardless of balance (already 100% either way) ----
  await setProvince('quebec');
  const qcRates = await page.evaluate(() => ({
    tinyBalance: _lifMaxRate(65, 100),
    hugeBalance: _lifMaxRate(65, 5000000),
  }));
  check('Quebec: tiny balance still just returns 100% (already uncapped, not via small-balance path)', qcRates.tinyBalance === 1);
  check('Quebec: huge balance also 100% (unaffected either way)', qcRates.hugeBalance === 1);

  // ---- Federal override integration ----
  await setProvince('quebec'); // province shouldn't matter once override is on
  await setFederalOverride(true);
  const fedRates = await page.evaluate(() => ({
    eligible: _lifMaxRate(40, 30000),     // under $37,300, no age gate -> unlocked
    notEligible: _lifMaxRate(65, 60000),  // over threshold -> normal FED_LIF_MAX table
  }));
  check('federal override: under $37,300 at any age -> _lifMaxRate returns 100%', fedRates.eligible === 1);
  check('federal override: over $37,300 -> normal FED_LIF_MAX table (age 65 = 6.0272%)', Math.abs(fedRates.notEligible - 0.060272) < 0.0001);
  await setFederalOverride(false);

  // ---- Backward compatibility: calling _lifMaxRate(age) with NO second
  // argument (every pre-existing call site/test, e.g. test 21) behaves
  // exactly as before -- undefined lifBal can never satisfy the small-balance
  // check, so nothing is spuriously unlocked. ----
  await setProvince('ontario');
  const noBalArg = await page.evaluate(() => _lifMaxRate(55));
  check('_lifMaxRate(age) with no balance argument: unaffected, matches normal formula', Math.abs(noBalArg - expectedProvLifMaxRate(55)) < 0.0001);

  // ---- End-to-end regression: a small LIF actually drains further through
  // the real simulation when eligible, and stays capped when it isn't --
  // proving this changes real simulated behavior, not just the standalone
  // rate function (same style of proof as test 21's Quebec e2e check). ----
  await setProvince('alberta');
  const albertaE2e = await page.evaluate(() => ({
    eligible: simulateResidentFixed(70, 65, 65, { lif: 20000, rrsp: 2000, tfsa: 0, nonreg: 0 })[0],
    notEligible: simulateResidentFixed(70, 65, 65, { lif: 40000, rrsp: 2000, tfsa: 0, nonreg: 0 })[0],
  }));
  check('Alberta e2e: eligible small LIF ($20,000, 65+, under $29,840) fully drains in year 1', albertaE2e.eligible.lif === albertaE2e.eligible.lifBal);
  check('Alberta e2e: ineligible larger LIF ($40,000) stays capped below full balance in year 1', albertaE2e.notEligible.lif < albertaE2e.notEligible.lifBal);

  await setProvince('ontario');
  const ontarioE2e = await page.evaluate(() => ({
    tooYoung: simulateResidentFixed(40, 65, 65, { lif: 10000, rrsp: 2000, tfsa: 0, nonreg: 0 })[0],
    eligible: simulateResidentFixed(55, 65, 65, { lif: 10000, rrsp: 2000, tfsa: 0, nonreg: 0 })[0],
  }));
  check('Ontario e2e: same small LIF at age 40 (under 55) stays capped -- age gate enforced in real simulation', ontarioE2e.tooYoung.lif < ontarioE2e.tooYoung.lifBal);
  check('Ontario e2e: same small LIF at age 55+ fully drains -- age gate satisfied', ontarioE2e.eligible.lif === ontarioE2e.eligible.lifBal);
  await setProvince('quebec');

  // ---- Housekeeping: dead CSS rule removed ----
  const html = await page.content();
  check('dead .mode-btn.active-nonresident-unused CSS rule has been removed from the page', !html.includes('active-nonresident-unused'));

  // ---- Housekeeping: "figures current as of" footer note ----
  const footerText = await page.evaluate(() => document.getElementById('footerNote').innerText || document.getElementById('footerNote').textContent);
  check('footer note mentions 2026 figures', /2026/.test(footerText));
  check('footer note tells the reader to check for updates each January', /January/i.test(footerText));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
