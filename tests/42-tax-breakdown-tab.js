'use strict';
// "New tab: full tax breakdown" (JP, picked from the roadmap's Remaining
// table alongside Individual account rate). Per JP's own framing: "new tab
// with full tax breakdown, not just a summary, must include bracket range
// and all, actual % withdrawal for each account, RoR if applicable."
//
// Confirmed with JP (AskUserQuestion) before building: (1) a new top-level
// tab, not folded into Retirement Income; (2) one row per year, click to
// expand full detail; (3) Non-Resident years show the flat-withholding and
// S.217-elected computations side by side, with whichever one the
// simulation actually used highlighted.
//
// This test's central concern: the new tab's headline numbers (Fed/Prov/
// Total/Marginal/Effective) come straight from the SAME _calcTaxDetail()/
// _calcTaxDetailNonResident() calls the simulation itself uses, so they can
// never drift from the rest of the app -- but the per-bracket detail ROWS
// are a separate, presentation-only reconstruction (renderTaxBreakdown()'s
// own doc comment explains why). So the bulk of this test is a consistency
// check: for a sample of years, reconstruct the bracket breakdown exactly
// as renderTaxBreakdown() does and confirm it sums to the real headline
// total -- not just that the tab renders something.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // Land on Retirement Income first so liveData is populated with a real
  // simulation before ever visiting the new tab.
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);

  // ---- Tab exists, switches panel visibility + nav button active class. ----
  const t0 = await page.evaluate(() => {
    showTab('taxbrk');
    return {
      panelVisible: document.getElementById('panelTaxBreakdown').style.display === 'block',
      btnActive: document.getElementById('tabBtnTaxBrk').className.includes('active'),
      retBtnInactive: !document.getElementById('tabBtnRet').className.includes('active'),
      rowCount: document.querySelectorAll('#taxBrkBody > tr:not([id^="taxBrkDet_"])').length,
      dataLen: liveData.data[spendMode][`${qppStart}_${oasStart}`].length,
      scenarioNote: document.getElementById('taxBrkScenarioNote').textContent,
    };
  });
  check('Tax Breakdown panel becomes visible', t0.panelVisible);
  check('Tax Breakdown nav button becomes active', t0.btnActive);
  check('Retirement Income nav button becomes inactive', t0.retBtnInactive);
  check('one table row per simulated year (resident mode)', t0.rowCount === t0.dataLen && t0.dataLen > 5);
  check('scenario note mentions the resident province', /QC|ON|BC|AB/.test(t0.scenarioNote));

  // ---- Click-to-expand: detail row starts hidden, toggles on click, toggles
  // back off on a second click. ----
  const t1 = await page.evaluate(() => {
    const DATA = liveData.data[spendMode][`${qppStart}_${oasStart}`];
    const age = DATA[1].age;
    const detBefore = document.getElementById('taxBrkDet_'+age).style.display;
    _toggleTaxBrk(age);
    const detAfterOpen = document.getElementById('taxBrkDet_'+age).style.display;
    _toggleTaxBrk(age);
    const detAfterClose = document.getElementById('taxBrkDet_'+age).style.display;
    return { detBefore, detAfterOpen, detAfterClose, age };
  });
  check('detail row starts collapsed', t1.detBefore === 'none');
  check('clicking toggles the detail row open', t1.detAfterOpen !== 'none');
  check('clicking again toggles it back closed', t1.detAfterClose === 'none');

  // ---- Resident-mode detail box shows the "Less other credits" line (both
  // Federal and Provincial), same as the non-resident S.217 box already did
  // -- this is the actual UI-visible fix, not just the underlying numbers. ----
  const t1b = await page.evaluate(() => {
    const DATA = liveData.data[spendMode][`${qppStart}_${oasStart}`];
    const age = DATA[1].age;
    _toggleTaxBrk(age);
    const html = document.getElementById('taxBrkDet_'+age).querySelector('td').innerHTML;
    _toggleTaxBrk(age);
    return { otherCreditsMentions: (html.match(/Less other credits/g) || []).length };
  });
  check('resident-mode detail shows "Less other credits" for both Federal and Provincial', t1b.otherCreditsMentions === 2);

  // ---- Resident-mode consistency check: for several years, reconstruct the
  // federal + provincial bracket breakdown exactly as renderTaxBreakdown()
  // does, and confirm it sums to _calcTaxDetail()'s real fed/prov totals.
  // Also confirms the BPA-credited slice-by-slice bracket math matches the
  // real function's own (separately-computed) net figures.
  //
  // 2026-09-11: _calcTaxDetail() now exposes otherCreditsFed/otherCreditsProv
  // -- the same "other non-refundable credits" split that was always being
  // subtracted internally but wasn't visible anywhere, leaving a real
  // $1,700-$2,600 gap between the tab's displayed bracket math and its
  // headline Fed/Prov figures (found during a close review of this tab).
  // renderTaxBreakdown() now renders a "Less other credits" line from those
  // fields, so the reconstruction here should land within a dollar or two of
  // det.fed/det.prov (not just "in the ballpark") -- proving the tab's own
  // displayed numbers now actually add up. ----
  const t2 = await page.evaluate(() => {
    const DATA = liveData.data[spendMode][`${qppStart}_${oasStart}`];
    const provKey = _currentProvince(), pt = PROVINCE_TAX_TABLES[provKey];
    const sampleAges = [DATA[0].age, DATA[Math.floor(DATA.length/2)].age, DATA[DATA.length-1].age];
    return sampleAges.map(age => {
      const d = DATA.find(r => r.age === age);
      const inc = d.totalTaxable;
      const det = _calcTaxDetail(inc, age);
      const idxFed = _idxBrackets(FED_BRACKETS, age);
      const fedRows = _bracketBreakdown(inc, idxFed);
      const fedBracketSum = fedRows.reduce((s,r)=>s+r.tax, 0);
      const fedGrossFromBreakdown = fedBracketSum;
      const fedGrossFromBracketTax = _bracketTax(inc, idxFed);
      const fedBpaCredit = _fedBPA(inc, age) * FED_BRACKETS[0].rate;
      const reconstructedFedRaw = Math.max(0, fedGrossFromBreakdown - fedBpaCredit) * (pt.hasFederalAbatement ? 0.835 : 1);
      const reconstructedFed = reconstructedFedRaw - det.otherCreditsFed;
      const idxProv = _idxBrackets(pt.brackets, age);
      const provRows = _bracketBreakdown(inc, idxProv);
      const provBracketSum = provRows.reduce((s,r)=>s+r.tax, 0);
      const provGrossFromBracketTax = _bracketTax(inc, idxProv);
      const provBpaCredit = (pt.bpa * _idxFactor(age)) * idxProv[0].rate;
      let provBase = Math.max(0, provGrossFromBracketTax - provBpaCredit);
      let provSurtax = 0;
      if (pt.surtax) {
        for (const tier of pt.surtax.tiers) {
          provSurtax += Math.max(0, provBase - tier.threshold * _idxFactor(age)) * tier.rate;
        }
      }
      const reconstructedProv = (provBase + provSurtax) - det.otherCreditsProv;
      return {
        age, det, fedGrossFromBreakdown, fedGrossFromBracketTax, reconstructedFedRaw, reconstructedFed,
        provBracketSum, provGrossFromBracketTax, reconstructedProv,
        // Below the combined BPA+other-credits floor (rare, low-income years),
        // det.fed/det.prov clamp to 0 via Math.max(0,...) while the
        // reconstruction can legitimately go negative -- that's the same
        // pre-existing clamp _calcTaxDetail() has always applied, not a new
        // reconciliation gap, so skip the exact-match check for those rows.
        fedClamped: det.fed === 0 && reconstructedFedRaw < det.otherCreditsFed,
        provClamped: det.prov === 0 && (provBase + provSurtax) < det.otherCreditsProv,
      };
    });
  });
  t2.forEach(r => {
    check(`age ${r.age}: _bracketBreakdown's federal rows sum to the same total as _bracketTax()`,
      Math.abs(r.fedGrossFromBreakdown - r.fedGrossFromBracketTax) < 0.01);
    check(`age ${r.age}: _bracketBreakdown's provincial rows sum to the same total as _bracketTax()`,
      Math.abs(r.provBracketSum - r.provGrossFromBracketTax) < 0.01);
    // The reconstructed federal/provincial figures (gross bracket tax minus
    // BPA credit minus the now-exposed otherCredits share, times the QC
    // federal-abatement factor where applicable) should now match
    // det.fed/det.prov almost exactly -- the only remaining slack is the two
    // independent Math.round() calls (_calcTaxDetail rounds the net figure;
    // the reconstruction rounds otherCreditsFed/Prov separately), which can
    // differ by at most a dollar or two.
    if (!r.fedClamped) {
      check(`age ${r.age}: reconstructed federal figure matches _calcTaxDetail()'s real fed total`,
        Math.abs(r.reconstructedFed - r.det.fed) <= 2);
    }
    if (!r.provClamped) {
      check(`age ${r.age}: reconstructed provincial figure matches _calcTaxDetail()'s real prov total`,
        Math.abs(r.reconstructedProv - r.det.prov) <= 2);
    }
  });

  // ---- Per-account mini table: Withdrawal % matches d.<acct>÷d.<acctBal>,
  // same convention as the LIF/RRIF/TFSA hover boxes elsewhere in the app. ----
  const t3 = await page.evaluate(() => {
    const DATA = liveData.data[spendMode][`${qppStart}_${oasStart}`];
    const row = DATA.find(d => d.lif > 0) || DATA[0];
    _toggleTaxBrk(row.age); // ensure open so the mini table is in the DOM
    const detTd = document.getElementById('taxBrkDet_'+row.age).querySelector('td');
    const lifPctText = Array.from(detTd.querySelectorAll('tr')).find(tr => tr.textContent.includes('LIF'))?.children[3]?.textContent;
    _toggleTaxBrk(row.age);
    const expectedPct = row.lifBal > 0 ? (row.lif/row.lifBal*100).toFixed(1)+'%' : '—';
    return { lifPctText, expectedPct, age: row.age };
  });
  check('per-account mini table shows the correct LIF withdrawal %', t3.lifPctText === t3.expectedPct);

  // ---- Non-Resident mode: Method column instead of Prov Tax, and the
  // side-by-side flat/S.217 boxes highlight whichever det.method actually
  // won for that year. ----
  const t4 = await page.evaluate(() => {
    setMode('nonresident');
    showTab('taxbrk');
    const DATA = liveData.data[spendMode][`${qppStart}_${oasStart}`];
    const provHead = document.getElementById('taxBrkProvHead').textContent;
    const sample = DATA[Math.floor(DATA.length/2)];
    const det = _calcTaxDetailNonResident(sample.totalTaxable, sample.age);
    _toggleTaxBrk(sample.age);
    const detTd = document.getElementById('taxBrkDet_'+sample.age).querySelector('td');
    const html = detTd.innerHTML;
    _toggleTaxBrk(sample.age);
    return {
      provHead, method: det.method,
      mentionsFlat: html.includes('Flat Withholding'),
      mentionsS217: html.includes('S.217 Election'),
      checkmarkCount: (html.match(/✓/g)||[]).length,
    };
  });
  check('Non-Resident mode swaps the header to "Method"', t4.provHead === 'Method');
  check('Non-Resident detail shows both Flat Withholding and S.217 Election boxes', t4.mentionsFlat && t4.mentionsS217);
  check('exactly one method is checkmarked as the winner', t4.checkmarkCount === 1);

  // Switch back to resident mode so this test doesn't leave global state
  // (localStorage) in non-resident mode for whichever test runs next.
  await page.evaluate(() => { setMode('resident'); });

  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('Console errors:', consoleErrors.slice(0,5));

  const failed = checks.filter(c => !c.pass);
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`));
  await finish(browser, failed.length === 0, failed.length ? `${failed.length} check(s) failed` : undefined);
})();
