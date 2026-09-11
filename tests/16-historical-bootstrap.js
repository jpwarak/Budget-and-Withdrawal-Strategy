'use strict';
// Historical bootstrap: the deferred half of the sequence-of-returns-risk
// item (12-monte-carlo.js covers the Normal-distribution model shipped
// first). Adds a second return model to the same runMonteCarloSim engine --
// a real S&P 500 annual-return series (1926-2025), resampled in 5-year
// consecutive blocks instead of drawn from a Normal distribution, so
// simulated paths inherit real fat tails, autocorrelation, and crash/
// recovery timing (2008-2009, the early-1930s slide, etc.) instead of a
// random independent shuffle of years. JP's calls, when asked: use the
// S&P 500 series (100 years, includes dividends -- the Canadian S&P/TSX
// Composite alternative was only 37 years and excluded dividends) and keep
// it "standardized" (the user's own mean/stdev inputs still set the
// simulation; history only supplies the shape/sequencing of the shocks).
//
// Covers: the dataset itself (length, known years, plausible mean/stdev);
// _mean/_stdevSample on a known small array; _blockBootstrapShocks' exact
// block mechanics under a mocked Math.random (including wraparound at the
// end of the series); runMonteCarloSim's returnModel plumbing (defaults to
// 'normal' -- byte-for-byte unchanged from before this feature existed --
// 'historical' reproduces the deterministic path at zero stdev exactly like
// the Normal model does, and produces plausible ordered percentile bands
// under real variance without touching liveData/currentAge); and the UI
// (return-model dropdown, the reference note showing the dataset's real
// mean/stdev, the success-rate readout labeling which model ran, and the
// deterministic Year-by-Year table staying untouched).
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ── Dataset integrity ─────────────────────────────────────────────────
  const ds = await page.evaluate(() => ({
    length: SP500_ANNUAL_RETURNS.length,
    startYear: SP500_ANNUAL_RETURNS_START_YEAR,
    y2008: SP500_ANNUAL_RETURNS[2008 - SP500_ANNUAL_RETURNS_START_YEAR],
    y1933: SP500_ANNUAL_RETURNS[1933 - SP500_ANNUAL_RETURNS_START_YEAR],
    y1926: SP500_ANNUAL_RETURNS[1926 - SP500_ANNUAL_RETURNS_START_YEAR],
    y2025: SP500_ANNUAL_RETURNS[2025 - SP500_ANNUAL_RETURNS_START_YEAR],
    histMeanPct: _SP500_HIST_MEAN * 100,
    histStdevPct: _SP500_HIST_STDEV * 100,
    standardizedLen: _SP500_STANDARDIZED.length,
    standardizedMeanNearZero: Math.abs(_mean(_SP500_STANDARDIZED)) < 1e-9,
  }));
  check('dataset has exactly 100 years (1926-2025)', ds.length === 100);
  check('start year is 1926', ds.startYear === 1926);
  check('2008 crash year matches the real S&P 500 total return (-37.00%)', Math.abs(ds.y2008 - -0.37) < 1e-9);
  check('1933 recovery year matches (+53.99%)', Math.abs(ds.y1933 - 0.5399) < 1e-9);
  check('first year (1926) matches (+11.62%)', Math.abs(ds.y1926 - 0.1162) < 1e-9);
  check('last year (2025) matches (+17.88%)', Math.abs(ds.y2025 - 0.1788) < 1e-9);
  check('historical mean is a plausible long-run equity figure (10%-14%)', ds.histMeanPct > 10 && ds.histMeanPct < 14);
  check('historical stdev is a plausible long-run equity figure (15%-25%)', ds.histStdevPct > 15 && ds.histStdevPct < 25);
  check('standardized series is the same length as the raw series', ds.standardizedLen === 100);
  check('standardized series has ~zero mean (it is (r-mean)/stdev of itself)', ds.standardizedMeanNearZero);

  // ── _mean / _stdevSample on a known small array ──────────────────────
  const stats = await page.evaluate(() => {
    const arr = [2, 4, 4, 4, 5, 5, 7, 9]; // classic textbook example: mean=5, population stdev=2, sample (n-1) stdev=sqrt(32/7)
    return { mean: _mean(arr), stdev: _stdevSample(arr) };
  });
  check('_mean matches a known example', Math.abs(stats.mean - 5) < 1e-9);
  check('_stdevSample matches a known example (sample stdev, n-1)', Math.abs(stats.stdev - Math.sqrt(32 / 7)) < 1e-9);

  // ── _blockBootstrapShocks: exact mechanics under a mocked Math.random ──
  const blocks = await page.evaluate(() => {
    const origRandom = Math.random;
    try {
      // Math.random() always returns 0 -> start index floor(0*100)=0 every
      // time a new block begins. blockLen=5, requested length=12 -> two full
      // blocks [0..4] then a third block truncated to its first 2 entries.
      Math.random = () => 0;
      const out1 = _blockBootstrapShocks(12, 5);
      const expected1 = [0,1,2,3,4,0,1,2,3,4,0,1].map(i => _SP500_STANDARDIZED[i]);

      // Math.random() always returns 0.98 -> start index floor(0.98*100)=98,
      // two years short of the end of the (100-year) series -- the block
      // must wrap around to index 0 instead of running off the end.
      Math.random = () => 0.98;
      const out2 = _blockBootstrapShocks(5, 5);
      const expected2 = [98, 99, 0, 1, 2].map(i => _SP500_STANDARDIZED[i]);

      return {
        matchesNoWrap: JSON.stringify(out1) === JSON.stringify(expected1),
        matchesWrap: JSON.stringify(out2) === JSON.stringify(expected2),
        lenMatchesRequest: _blockBootstrapShocks(23, 5).length === 23,
      };
    } finally {
      Math.random = origRandom;
    }
  });
  check('block bootstrap draws consecutive real years starting at the sampled index', blocks.matchesNoWrap);
  check('block bootstrap wraps around to the start of the series instead of running off the end', blocks.matchesWrap);
  check('block bootstrap output length always matches the requested horizon, including a truncated final block', blocks.lenMatchesRequest);

  // ── runMonteCarloSim: returnModel plumbing ────────────────────────────
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);

  const t1 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const mcDefault = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5 });
    const mcNormalExplicit = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'normal' });
    const mcHist = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 10, iterations: 5, returnModel: 'historical' });
    return {
      defaultModel: mcDefault.returnModel,
      normalExplicitModel: mcNormalExplicit.returnModel,
      histModel: mcHist.returnModel,
      histMeanPct: mcHist.histMeanPct,
      histStdevPct: mcHist.histStdevPct,
      defaultHistMeanPct: mcDefault.histMeanPct,
    };
  });
  check('omitting returnModel defaults to "normal"', t1.defaultModel === 'normal');
  check('explicit returnModel:"normal" behaves the same as omitting it', t1.normalExplicitModel === 'normal');
  check('returnModel:"historical" is echoed back', t1.histModel === 'historical');
  check('histMeanPct/histStdevPct are always returned (informational), even for the Normal model', t1.defaultHistMeanPct > 10 && t1.defaultHistMeanPct < 14);
  check('historical run reports the real dataset mean (10%-14%)', t1.histMeanPct > 10 && t1.histMeanPct < 14);
  check('historical run reports the real dataset stdev (15%-25%)', t1.histStdevPct > 15 && t1.histStdevPct < 25);

  // ── Engine: historical model at zero stdev also reproduces the
  // deterministic path exactly (stdev=0 means z's value can't matter,
  // whichever model supplied it) ------------------------------------------
  const t2 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const deterministic = _runSim('resident', ra, qpp, oas, rawPort);
    const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 0, iterations: 5, returnModel: 'historical' });
    const mismatches = [];
    for (let i = 0; i < deterministic.length; i++) {
      const d = deterministic[i];
      const detTotal = Math.round((d.lifBal||0)+(d.rrspBal||0)+(d.tfsaBal||0)+(d.nonregBal||0)+(d.emergBal||0));
      const band = mc.bands[i];
      if (!band || Math.abs(band.p50-detTotal) > 5) mismatches.push(`age ${d.age}`);
    }
    return { mismatches };
  });
  check('zero-stdev historical bootstrap reproduces the deterministic totals exactly, same as the Normal model does', t2.mismatches.length === 0);

  // ── Engine: statistical sanity under real variance, historical model ───
  const t3 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: _simG()*100, stdevPct: 12, iterations: 400, returnModel: 'historical' });
    const orderedOk = mc.bands.every(b => b.p10 <= b.p50 + 1 && b.p50 <= b.p90 + 1);
    return { successRate: mc.successRate, orderedOk };
  });
  check('historical bootstrap variance run: p10 <= p50 <= p90 across all age bands', t3.orderedOk);
  check('historical bootstrap variance run: success rate is a plausible fraction (0 < rate <= 1)', t3.successRate > 0 && t3.successRate <= 1);

  // ── Engine: no side effects on global rendering state --------------------
  const t4 = await page.evaluate(() => {
    const before = { liveData, currentAge };
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    runMonteCarloSim({ mode: 'resident', ra, qppStart: 65, oasStart: 65, rawPort, meanPct: 5, stdevPct: 10, iterations: 50, returnModel: 'historical' });
    return { liveDataUnchanged: liveData === before.liveData, currentAgeUnchanged: currentAge === before.currentAge };
  });
  check('historical bootstrap does not mutate liveData', t4.liveDataUnchanged);
  check('historical bootstrap does not mutate currentAge', t4.currentAgeUnchanged);

  // ── UI: return-model dropdown, reference note, and labeled results ─────
  await page.evaluate(() => {
    document.getElementById('mcEnabled').checked = true;
    toggleMonteCarloPanel();
  });
  const t5 = await page.evaluate(() => {
    const sel = document.getElementById('mcReturnModel');
    return { defaultsToNormal: sel && sel.value === 'normal', refHidden: getComputedStyle(document.getElementById('mcHistRef')).display === 'none' };
  });
  check('Return model dropdown defaults to Normal distribution', t5.defaultsToNormal);
  check('historical reference note starts hidden (Normal is selected by default)', t5.refHidden);

  const t6 = await page.evaluate(() => {
    const sel = document.getElementById('mcReturnModel');
    sel.value = 'historical';
    toggleMcReturnModel();
    const refShown = getComputedStyle(document.getElementById('mcHistRef')).display !== 'none';
    const figsText = document.getElementById('mcHistRefFigs')?.textContent || '';
    return { refShown, figsText };
  });
  check('selecting Historical bootstrap reveals the reference note', t6.refShown);
  check('reference note shows the real dataset mean/stdev', /1[0-3]\.\d% mean/.test(t6.figsText) && /std\. dev\./.test(t6.figsText));

  const t7 = await page.evaluate(() => {
    document.getElementById('mcReturnModel').value = 'normal';
    toggleMcReturnModel();
    return getComputedStyle(document.getElementById('mcHistRef')).display === 'none';
  });
  check('switching back to Normal hides the reference note again', t7);

  // Running with Historical selected: labeled success text, chart renders,
  // and the deterministic Year-by-Year table is untouched.
  const beforeTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  await page.evaluate(() => {
    document.getElementById('mcReturnModel').value = 'historical';
    toggleMcReturnModel();
    document.getElementById('mcMean').value = '3.5';
    document.getElementById('mcStdev').value = '12';
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
      mentionsHistoricalModel: /historical bootstrap \(S&P 500, 1926–2025\)/.test(successText),
      chartExists: !!(canvas && mcChart),
    };
  });
  check('running with Historical bootstrap selected shows a success-rate readout', t8.successTextLooksRight);
  check('success-rate readout labels which return model ran', t8.mentionsHistoricalModel);
  check('running with Historical bootstrap selected renders a percentile-band chart', t8.chartExists);

  const afterTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  check('running historical bootstrap does not alter the deterministic Year-by-Year table', beforeTable === afterTable);

  // Running with Normal selected (the default/pre-existing path) must NOT
  // carry the historical label -- confirms the two modes stay distinct.
  await page.evaluate(() => {
    document.getElementById('mcReturnModel').value = 'normal';
    toggleMcReturnModel();
  });
  await page.evaluate(() => { runMonteCarloUI(); });
  await page.waitForFunction(() => {
    const el = document.getElementById('mcResults');
    return el && el.style.display !== 'none';
  }, { timeout: 10000 });
  const t9 = await page.evaluate(() => document.getElementById('mcSuccessRate')?.textContent || '');
  check('running with Normal selected does not carry the historical-bootstrap label', !/historical bootstrap/.test(t9));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
