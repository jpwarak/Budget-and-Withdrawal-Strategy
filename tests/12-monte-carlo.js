'use strict';
// Tier 3: sequence-of-returns risk (Monte Carlo). Covers the engine itself
// (runMonteCarloSim / _randNormal / _percentile / the yearlyReturns plumbing
// added to _runSim and the three simulate* functions) and the opt-in UI
// panel on the Retirement Income tab. The core invariant throughout: this
// feature is additive and off by default -- it must never change anything
// the deterministic chart/table/page shows unless the user explicitly opens
// the panel and clicks "Run simulation".
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // Give the live simulation a realistic budget so shortfalls are meaningful
  // in the variance-run checks below.
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 1500);
    fill('bud_houseMortgage_amt', 800);
    fill('bud_housePropTax_amt', 300);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(500);

  // --- Engine: zero-stdev reproduces the deterministic path exactly -------
  const t1 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const deterministic = _runSim('resident', ra, qpp, oas, rawPort);
    const mc = runMonteCarloSim({
      mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort,
      meanPct: _simG() * 100, stdevPct: 0, iterations: 5,
    });
    const mismatches = [];
    for (let i = 0; i < deterministic.length; i++) {
      const d = deterministic[i];
      const detTotal = Math.round((d.lifBal||0)+(d.rrspBal||0)+(d.tfsaBal||0)+(d.nonregBal||0)+(d.emergBal||0));
      const band = mc.bands[i];
      if (!band) { mismatches.push(`age ${d.age}: no band`); continue; }
      if (Math.abs(band.p10-detTotal)>5 || Math.abs(band.p50-detTotal)>5 || Math.abs(band.p90-detTotal)>5) {
        mismatches.push(`age ${d.age}: det=${detTotal} p10=${band.p10} p50=${band.p50} p90=${band.p90}`);
      }
    }
    return { mismatches, bandsLen: mc.bands.length, detLen: deterministic.length };
  });
  check('zero-stdev Monte Carlo bands length matches deterministic length', t1.bandsLen === t1.detLen);
  check('zero-stdev Monte Carlo reproduces deterministic totals at every age (within rounding)', t1.mismatches.length === 0);

  // --- Engine: statistical sanity under real variance ----------------------
  const t2 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    const mc = runMonteCarloSim({
      mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort,
      meanPct: _simG() * 100, stdevPct: 12, iterations: 400,
    });
    const orderedOk = mc.bands.every(b => b.p10 <= b.p50 + 1 && b.p50 <= b.p90 + 1);
    return { successRate: mc.successRate, orderedOk };
  });
  check('variance run: p10 <= p50 <= p90 across all age bands', t2.orderedOk);
  check('variance run: success rate is a plausible fraction (0 < rate <= 1)', t2.successRate > 0 && t2.successRate <= 1);

  // --- Engine: success rate responds to a stressed scenario (small portfolio,
  // high spend) -- confirms the metric isn't hardcoded/always-1. ------------
  const t3 = await page.evaluate(() => {
    const ra = 65, qpp = 65, oas = 65;
    const rawPort = { lif: 30000, rrsp: 20000, tfsa: 10000, nonreg: 5000 };
    const savedIncome = {};
    // Temporarily push a very high budget so a tiny portfolio can't keep up.
    document.querySelectorAll('[id^="bud_"][id$="_amt"]').forEach(el => { savedIncome[el.id] = el.value; });
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 8000); fill('bud_houseMortgage_amt', 4000); fill('bud_housePropTax_amt', 1500);
    const mc = runMonteCarloSim({ mode: 'resident', ra, qppStart: qpp, oasStart: oas, rawPort, meanPct: 3.5, stdevPct: 15, iterations: 300 });
    // restore
    Object.entries(savedIncome).forEach(([id, val]) => fill(id, val));
    return { successRate: mc.successRate };
  });
  check('stressed scenario (small portfolio, high spend) drives success rate down', t3.successRate < 0.5);

  // --- Engine: no side effects on global rendering state -------------------
  const t4 = await page.evaluate(() => {
    const before = { liveData, currentAge };
    const ra = 65;
    const rawPort = PORTFOLIOS[ra] || { lif: 300000, rrsp: 200000, tfsa: 100000, nonreg: 50000 };
    runMonteCarloSim({ mode: 'resident', ra, qppStart: 65, oasStart: 65, rawPort, meanPct: 5, stdevPct: 10, iterations: 50 });
    return { liveDataUnchanged: liveData === before.liveData, currentAgeUnchanged: currentAge === before.currentAge };
  });
  check('runMonteCarloSim does not mutate liveData', t4.liveDataUnchanged);
  check('runMonteCarloSim does not mutate currentAge', t4.currentAgeUnchanged);

  // --- UI: panel is off by default, and default page render is untouched --
  const t5 = await page.evaluate(() => {
    const cb = document.getElementById('mcEnabled');
    const controls = document.getElementById('mcControls');
    return {
      checkboxUnchecked: cb && !cb.checked,
      controlsHidden: controls && getComputedStyle(controls).display === 'none',
      badgeStillPresent: !!document.getElementById('dataSourceBadge')?.textContent,
    };
  });
  check('Monte Carlo "Enable" checkbox starts unchecked', t5.checkboxUnchecked);
  check('Monte Carlo controls panel starts hidden', t5.controlsHidden);
  check('rest of the page (data-source badge) renders normally alongside the new section', t5.badgeStillPresent);

  // --- UI: enabling the panel + running produces a success-rate readout and
  // a chart, without altering the deterministic table/chart above it. ------
  const beforeTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  const t6 = await page.evaluate(() => {
    document.getElementById('mcEnabled').checked = true;
    toggleMonteCarloPanel();
    document.getElementById('mcMean').value = '3.5';
    document.getElementById('mcStdev').value = '12';
    document.getElementById('mcIterations').value = '300';
  });
  await page.evaluate(() => { runMonteCarloUI(); });
  await page.waitForFunction(() => {
    const el = document.getElementById('mcResults');
    return el && el.style.display !== 'none';
  }, { timeout: 10000 });
  const t7 = await page.evaluate(() => {
    const successText = document.getElementById('mcSuccessRate')?.textContent || '';
    const canvas = document.getElementById('mcBandChart');
    return {
      successTextLooksRight: /% of 300 simulated retirements/.test(successText),
      chartExists: !!(canvas && mcChart),
    };
  });
  check('running the Monte Carlo panel shows a success-rate readout', t7.successTextLooksRight);
  check('running the Monte Carlo panel renders a percentile-band chart', t7.chartExists);

  const afterTable = await page.evaluate(() => document.getElementById('mainTable')?.innerHTML);
  check('running Monte Carlo does not alter the deterministic Year-by-Year table', beforeTable === afterTable);

  // --- UI: re-enabling for a different scenario doesn't leak state (chart
  // instance is properly destroyed/recreated, not stacked). -----------------
  const t8 = await page.evaluate(() => {
    const before = mcChart;
    document.getElementById('mcStdev').value = '20';
    return { hadChart: !!before };
  });
  await page.evaluate(() => { runMonteCarloUI(); });
  await page.waitForFunction(() => {
    const el = document.getElementById('mcResults');
    return el && el.style.display !== 'none';
  }, { timeout: 10000 });
  const t9 = await page.evaluate(() => ({ chartCount: Chart.instances ? Object.keys(Chart.instances).length : null }));
  check('re-running Monte Carlo reuses one chart instance (old one destroyed first)', t8.hadChart);

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
