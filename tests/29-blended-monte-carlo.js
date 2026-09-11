'use strict';
// "Blended" Monte Carlo return model: a third option alongside Normal and
// Historical bootstrap (12-monte-carlo.js / 16-historical-bootstrap.js),
// added after a design discussion about the Historical bootstrap's own
// limitation -- it resamples 100%-US-equity history, which overstates the
// tail-risk shape of a real Canadian retiree's blended stock/bond portfolio,
// even once the user dials the mean/volatility sliders down to match their
// own allocation (the SHAPE, not just the level, still comes from pure
// equity history).
//
// What was actually buildable, researched directly before writing any code:
// real year-by-year Canadian bond TOTAL RETURN history isn't published as a
// clean series anywhere (taxtips.ca -- the same source already used
// elsewhere in this file for tax figures -- only publishes multi-period
// compound averages, not individual years), so unlike the S&P 500 series
// there's no real bond sequence to resample. JP's confirmed design (three
// questions, all answered before coding):
//   1. Hybrid approach: keep resampling REAL S&P 500 history for the equity
//      sleeve's shape exactly as Historical bootstrap does, and add an
//      INDEPENDENTLY-drawn (not resampled/sequenced) Normal-distribution
//      bond sleeve on top -- rather than not building this at all.
//   2. Equity/bond split is a user-adjustable "Equity weight %" input
//      (default 60%), not a single fixed preset.
//   3. Bond sleeve mean is the long-run historical average (~6.1%/yr,
//      taxtips.ca's Canada long-bond series -- stable across the 46/50/76-
//      year windows it publishes), paired with PWL Capital's published
//      volatility estimate (5.36% -- the only credible stdev figure found).
//
// Covers: CANADA_BOND_MEAN/CANADA_BOND_STDEV sanity; runMonteCarloSim's
// 'blended' plumbing (echoed back, equityWeightPct defaults to 60 and
// clamps to [0,100], 'normal'/'historical' unaffected by the new param);
// the EXACT blending formula under a pinned Math.random (both the real
// block-bootstrap equity shock and the independently-drawn bond value
// hand-computed and compared against a direct _runSim call with the same
// manually-built yearlyReturns array -- not just a statistical sanity
// check); the two limiting cases (100% equity behaves like pure equity
// regardless of the bond assumption, 0% equity is driven only by the bond
// assumption regardless of the user's own mean/stdev sliders); no side
// effects on liveData/currentAge; and the UI (new dropdown option, the
// equity-weight input's show/hide, the reference note's figures, and the
// success-rate readout labeling the weights that ran).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ── Bond assumption sanity ────────────────────────────────────────────
  const bondConsts = await page.evaluate(() => ({ mean: CANADA_BOND_MEAN, stdev: CANADA_BOND_STDEV }));
  check('CANADA_BOND_MEAN is a plausible long-run Canadian bond figure (4%-8%)', bondConsts.mean > 0.04 && bondConsts.mean < 0.08);
  check('CANADA_BOND_STDEV is a plausible long-run Canadian bond figure (2%-10%)', bondConsts.stdev > 0.02 && bondConsts.stdev < 0.10);
  check('CANADA_BOND_MEAN matches the researched 6.1% figure', Math.abs(bondConsts.mean - 0.061) < 1e-9);
  check('CANADA_BOND_STDEV matches the researched 5.36% figure', Math.abs(bondConsts.stdev - 0.0536) < 1e-9);

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);

  // ── runMonteCarloSim: 'blended' plumbing ──────────────────────────────
  const t1 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const mcBlendedDefault = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'blended' });
    const mcBlendedCustom = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'blended', equityWeightPct: 75 });
    const mcBlendedOver100 = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'blended', equityWeightPct: 150 });
    const mcBlendedNegative = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'blended', equityWeightPct: -20 });
    const mcNormalUnaffected = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'normal', equityWeightPct: 10 });
    return {
      blendedDefaultModel: mcBlendedDefault.returnModel,
      blendedDefaultWeight: mcBlendedDefault.equityWeightPct,
      blendedCustomWeight: mcBlendedCustom.equityWeightPct,
      blendedOver100Weight: mcBlendedOver100.equityWeightPct,
      blendedNegativeWeight: mcBlendedNegative.equityWeightPct,
      normalModel: mcNormalUnaffected.returnModel,
    };
  });
  check('returnModel:"blended" is echoed back', t1.blendedDefaultModel === 'blended');
  check('equityWeightPct defaults to 60 when omitted', t1.blendedDefaultWeight === 60);
  check('equityWeightPct is echoed back when supplied', t1.blendedCustomWeight === 75);
  check('equityWeightPct above 100 clamps to 100', t1.blendedOver100Weight === 100);
  check('equityWeightPct below 0 clamps to 0', t1.blendedNegativeWeight === 0);
  check('"normal" model is unaffected by an incidental equityWeightPct', t1.normalModel === 'normal');

  // ── Exact blending formula, under a pinned Math.random ────────────────
  // With Math.random pinned to a single constant c: _blockBootstrapShocks'
  // block-start index is floor(c*100) every time a new block begins (same
  // index every block, since c never changes), and _randNormal's Box-Muller
  // transform (u1=u2=c) produces the exact same z, and therefore the exact
  // same bond return, on every single call. Both are hand-computable, so
  // the blended yearlyReturns array for the whole horizon can be built
  // independently and fed straight into _runSim -- if runMonteCarloSim's
  // (1-iteration, so no variance) bands don't match that reference exactly,
  // the blending formula itself is wrong, not just "off by noise".
  const exact = await page.evaluate(() => {
    const origRandom = Math.random;
    try {
      const c = 0.37;
      const ra = 65, qpp = 65, oas = 65;
      const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
      const meanPct = 5, stdevPct = 14, equityWeightPct = 65;
      const meanReg = meanPct / 100, stdevReg = stdevPct / 100;
      const nonregFlat = _SIM_GNREG; // mode 'resident'
      const nonregOffset = _simG() - nonregFlat;
      const meanNonreg = meanReg - nonregOffset, stdevNonreg = stdevReg;
      const equityWeight = equityWeightPct / 100;

      const probe = _runSim('resident', ra, qpp, oas, rawPort);
      const horizon = probe.length;

      // Hand-reconstruct what Math.random()=c always produces:
      const startIdx = Math.floor(c * 100); // block-bootstrap's block start
      const bondZ = Math.sqrt(-2 * Math.log(c)) * Math.cos(2 * Math.PI * c); // Box-Muller with u1=u2=c
      const bondFixed = CANADA_BOND_MEAN + CANADA_BOND_STDEV * bondZ;

      const yearlyReturns = new Array(horizon);
      for (let y = 0; y < horizon; y++) {
        const z = _SP500_STANDARDIZED[(startIdx + (y % 5)) % _SP500_STANDARDIZED.length];
        const equityReg = meanReg + stdevReg * z, equityNonreg = meanNonreg + stdevNonreg * z;
        yearlyReturns[y] = {
          reg: equityWeight * equityReg + (1 - equityWeight) * bondFixed,
          nonreg: equityWeight * equityNonreg + (1 - equityWeight) * bondFixed,
        };
      }
      const expectedRows = _runSim('resident', ra, qpp, oas, rawPort, yearlyReturns);
      const expectedTotals = expectedRows.map(r => Math.round((r.lifBal||0)+(r.rrspBal||0)+(r.tfsaBal||0)+(r.nonregBal||0)+(r.emergBal||0)));

      Math.random = () => c;
      const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct, stdevPct, iterations: 1, returnModel: 'blended', equityWeightPct });

      const mismatches = [];
      for (let y = 0; y < expectedTotals.length; y++) {
        const band = mc.bands[y];
        if (!band || Math.abs(band.p50 - expectedTotals[y]) > 2) mismatches.push(`age ${probe[y].age}: expected=${expectedTotals[y]} got p50=${band && band.p50}`);
      }
      return { mismatches, horizon, bandsLen: mc.bands.length };
    } finally {
      Math.random = origRandom;
    }
  });
  check('blended bands length matches the simulation horizon', exact.bandsLen === exact.horizon);
  check('blended formula exactly matches an independently hand-computed equity+bond blend, year by year', exact.mismatches.length === 0);

  // ── Limiting case: 100% equity weight behaves exactly like pure equity,
  // regardless of the bond assumption (bond's own random value never
  // reaches the result once its weight is zero) -- zero-stdev reproduces
  // the deterministic path exactly, same invariant test 16 uses for
  // Historical bootstrap. ------------------------------------------------
  const t100 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const deterministic = _runSim('resident', ra, qpp, oas, rawPort);
    const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 0, iterations: 5, returnModel: 'blended', equityWeightPct: 100 });
    const mismatches = [];
    for (let i = 0; i < deterministic.length; i++) {
      const d = deterministic[i];
      const detTotal = Math.round((d.lifBal||0)+(d.rrspBal||0)+(d.tfsaBal||0)+(d.nonregBal||0)+(d.emergBal||0));
      const band = mc.bands[i];
      if (!band || Math.abs(band.p50-detTotal) > 5) mismatches.push(`age ${d.age}`);
    }
    return { mismatches };
  });
  check('100% equity weight, zero stdev: reproduces the deterministic path exactly (bond weight is zero, so its randomness cannot leak in)', t100.mismatches.length === 0);

  // ── Limiting case: 0% equity weight ignores the user's own mean/stdev
  // sliders entirely -- two runs with wildly different meanPct/stdevPct but
  // equityWeightPct:0 should land on statistically indistinguishable
  // outcomes, since only the fixed bond assumption drives the result. -----
  const t0 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const mcLowSlider = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: 1, stdevPct: 2, iterations: 500, returnModel: 'blended', equityWeightPct: 0 });
    const mcHighSlider = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: 20, stdevPct: 30, iterations: 500, returnModel: 'blended', equityWeightPct: 0 });
    // Compare median end-of-horizon balance -- should be close since neither
    // run's equity slider can matter at 0% equity weight.
    const lastLow = mcLowSlider.bands[mcLowSlider.bands.length - 1].p50;
    const lastHigh = mcHighSlider.bands[mcHighSlider.bands.length - 1].p50;
    return { lastLow, lastHigh, ratio: lastHigh > 0 ? lastLow / lastHigh : null };
  });
  check('0% equity weight: wildly different mean/stdev sliders produce statistically similar outcomes (within 20%) since only the bond assumption applies', t0.ratio !== null && t0.ratio > 0.8 && t0.ratio < 1.25);

  // ── Engine: no side effects on global rendering state -------------------
  const t4 = await page.evaluate(() => {
    const before = { liveData, currentAge };
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    runMonteCarloSim({ mode: 'resident', ra, qppStart: 65, oasStart: 65, rawPort, meanPct: 5, stdevPct: 10, iterations: 50, returnModel: 'blended' });
    return { liveDataUnchanged: liveData === before.liveData, currentAgeUnchanged: currentAge === before.currentAge };
  });
  check('blended model does not mutate liveData', t4.liveDataUnchanged);
  check('blended model does not mutate currentAge', t4.currentAgeUnchanged);

  // ── UI: dropdown option, equity-weight input show/hide, reference note ─
  await page.evaluate(() => {
    document.getElementById('mcEnabled').checked = true;
    toggleMonteCarloPanel();
  });
  const t5 = await page.evaluate(() => {
    const sel = document.getElementById('mcReturnModel');
    const opts = Array.from(sel.options).map(o => o.value);
    return {
      hasBlendedOption: opts.includes('blended'),
      weightHiddenByDefault: getComputedStyle(document.getElementById('mcEquityWeightWrap')).display === 'none',
      blendedRefHiddenByDefault: getComputedStyle(document.getElementById('mcBlendedRef')).display === 'none',
      defaultWeightValue: document.getElementById('mcEquityWeight')?.value,
    };
  });
  check('Return model dropdown offers a "blended" option', t5.hasBlendedOption);
  check('equity-weight input starts hidden (Normal is selected by default)', t5.weightHiddenByDefault);
  check('blended reference note starts hidden', t5.blendedRefHiddenByDefault);
  check('equity-weight input defaults to 60', t5.defaultWeightValue === '60');

  const t6 = await page.evaluate(() => {
    const sel = document.getElementById('mcReturnModel');
    sel.value = 'blended';
    toggleMcReturnModel();
    const weightShown = getComputedStyle(document.getElementById('mcEquityWeightWrap')).display !== 'none';
    const refShown = getComputedStyle(document.getElementById('mcBlendedRef')).display !== 'none';
    const figsText = document.getElementById('mcBlendedRefFigs')?.textContent || '';
    // Historical bootstrap's own note must stay hidden while Blended is selected.
    const histRefHidden = getComputedStyle(document.getElementById('mcHistRef')).display === 'none';
    return { weightShown, refShown, figsText, histRefHidden };
  });
  check('selecting Blended reveals the equity-weight input', t6.weightShown);
  check('selecting Blended reveals its own reference note', t6.refShown);
  check('Blended reference note shows the bond mean/stdev figures', /6\.1% mean/.test(t6.figsText) && /std\. dev\./.test(t6.figsText));
  check('selecting Blended keeps the Historical-only note hidden', t6.histRefHidden);

  const t7 = await page.evaluate(() => {
    document.getElementById('mcReturnModel').value = 'historical';
    toggleMcReturnModel();
    const weightHidden = getComputedStyle(document.getElementById('mcEquityWeightWrap')).display === 'none';
    const blendedRefHidden = getComputedStyle(document.getElementById('mcBlendedRef')).display === 'none';
    return { weightHidden, blendedRefHidden };
  });
  check('switching to Historical hides the equity-weight input again', t7.weightHidden);
  check('switching to Historical hides the Blended reference note again', t7.blendedRefHidden);

  // ── Running with Blended selected: labeled success text, chart renders,
  // deterministic table untouched. -----------------------------------------
  const beforeTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  await page.evaluate(() => {
    document.getElementById('mcReturnModel').value = 'blended';
    toggleMcReturnModel();
    document.getElementById('mcEquityWeight').value = '70';
    document.getElementById('mcMean').value = '5';
    document.getElementById('mcStdev').value = '14';
    document.getElementById('mcIterations').value = '300';
  });
  await page.evaluate(() => { runMonteCarloUI(); });
  await page.waitForFunction(() => {
    const el = document.getElementById('mcResults');
    return el && el.style.display !== 'none';
  }, { timeout: 10000 });
  const t8 = await page.evaluate(() => {
    const successText = document.getElementById('mcSuccessRate')?.textContent || '';
    const canvas = document.getElementById('mcBandChart');
    return {
      successTextLooksRight: /% of 300 simulated retirements/.test(successText),
      mentionsWeights: /70% equity \/ 30% Canadian bonds/.test(successText),
      chartExists: !!(canvas && mcChart),
    };
  });
  check('running with Blended selected shows a success-rate readout', t8.successTextLooksRight);
  check('success-rate readout labels the actual equity/bond weights used', t8.mentionsWeights);
  check('running with Blended selected renders a percentile-band chart', t8.chartExists);

  const afterTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  check('running Blended does not alter the deterministic Year-by-Year table', beforeTable === afterTable);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
