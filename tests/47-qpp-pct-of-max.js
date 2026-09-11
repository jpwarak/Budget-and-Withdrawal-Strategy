'use strict';
// Third and final item from JP's "next three" batch (alongside the QPP/OAS
// slider and long-form currency toggle): "CPP/QPP box: show % of maximum @
// age 65". Adds a small computed line under the Accumulation tab's
// "QPP/CPP Amount at 65 ($)" input showing how the entered amount compares
// to the government-published maximum retirement pension for someone
// starting at exactly 65, in 2026 dollars:
//   CPP (every province except Quebec): $1,507.65/mo, canada.ca "Canada
//     Pension Plan: Pensions and benefits monthly amounts".
//   QPP (Quebec only): $1,508/mo, Retraite Québec's own "Calculation of
//     your retirement pension" table.
// This is a simple point-in-time sanity check (not a projection), and is
// deliberately independent of the QPP/OAS start-age slider on the
// Retirement Income tab -- it always compares against the age-65 maximum,
// since the input itself is defined as the amount AT 65 before any
// deferral bonus is applied.
//
// Worth noting for JP: the app's own long-standing default value for this
// field ($19,718/yr = $1,643.17/mo) is already *above* both of today's
// published maximums, so a fresh page load shows the "above the published
// max" note out of the box. That's not a bug in this feature -- it's
// accurately reporting that the app's default figure exceeds today's
// formulaic max (real Service Canada/Retraite Québec personal estimates
// can legitimately run higher than the formulaic max for reasons specific
// to an individual's own contribution history and estimate methodology,
// but it's worth a second look if that default was meant to be a plain
// max-contributor example).
const { openApp } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ==== Renders on a fresh load with no interaction needed ====
  await page.waitForTimeout(400);
  const t0 = await page.evaluate(() => document.getElementById('qppPctOfMax')?.textContent || '');
  check('the "% of max" line exists and is populated on a fresh page load (no tab switch or input needed)', /% of the (QPP|CPP) maximum at 65/.test(t0));
  check('default province is Quebec, so the line labels it QPP', /QPP maximum/.test(t0));

  // ==== Exact-percentage math, using a known round-number input ====
  const t1 = await page.evaluate(async () => {
    showTab('acc');
    const el = document.getElementById('qppBase65');
    el.value = 9048; // exactly half of QPP's $18,096/yr 2026 max
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('qppPctOfMax').textContent;
  });
  check('half of the QPP max at 65 computes to ~50%', /≈\s*50%/.test(t1));
  check('shows the QPP annual max in dollars ($18,096/yr)', /\$18,096\/yr/.test(t1));
  check('no "above the max" warning at 50%', !t1.includes('double-check'));

  // ==== Exactly at the max (should not falsely warn due to rounding) ====
  const t2 = await page.evaluate(async () => {
    const el = document.getElementById('qppBase65');
    el.value = 18096;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('qppPctOfMax').textContent;
  });
  check('entering exactly the published QPP max shows ~100%', /≈\s*100%/.test(t2));
  check('entering exactly the max does not trigger the over-max warning', !t2.includes('double-check'));

  // ==== Above the max triggers the warning ====
  const t3 = await page.evaluate(async () => {
    const el = document.getElementById('qppBase65');
    el.value = 25000;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    return { text: document.getElementById('qppPctOfMax').textContent, color: document.getElementById('qppPctOfMax').style.color };
  });
  check('an amount well above the max shows >100%', /≈\s*13[0-9]%/.test(t3.text));
  check('an amount above the max triggers the "double-check this input" note', t3.text.includes('double-check this input'));
  check('the line is styled with a warning color when over the max', t3.color === 'rgb(245, 158, 11)' || t3.color === '#f59e0b');

  // ==== Switching province from Quebec (QPP) to a CPP province updates
  // both the label and the comparison max, for the SAME entered amount ====
  const t4 = await page.evaluate(async () => {
    showTab('profile');
    const sel = document.getElementById('profileProvince');
    sel.value = 'ontario';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    showTab('acc');
    return document.getElementById('qppPctOfMax').textContent;
  });
  check('switching to a CPP province relabels the line to "CPP maximum"', /CPP maximum/.test(t4));
  check('switching to a CPP province uses CPP\'s own max ($18,092/yr), not QPP\'s', /\$18,092\/yr/.test(t4));

  // ==== Switching back to Quebec restores the QPP label/max ====
  const t5 = await page.evaluate(async () => {
    showTab('profile');
    const sel = document.getElementById('profileProvince');
    sel.value = 'quebec';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    showTab('acc');
    return document.getElementById('qppPctOfMax').textContent;
  });
  check('switching back to Quebec restores the QPP label and max', /QPP maximum/.test(t5) && /\$18,096\/yr/.test(t5));

  // ==== Independent of the QPP/OAS start-age slider -- this line always
  // compares against the age-65 max, regardless of the selected start age ====
  const t6 = await page.evaluate(async () => {
    showTab('ret');
    document.querySelector('.age-btn[data-age="65"]')?.click();
    await new Promise(r => setTimeout(r, 200));
    const qppSlider = document.getElementById('qppSlider');
    if (qppSlider) { qppSlider.value = 70; qppSlider.dispatchEvent(new Event('input')); }
    await new Promise(r => setTimeout(r, 300));
    showTab('acc');
    return document.getElementById('qppPctOfMax').textContent;
  });
  check('deferring the QPP/OAS start-age slider to 70 does not change the age-65 "% of max" comparison', /QPP maximum at 65/.test(t6) && /\$18,096\/yr/.test(t6));

  // ==== Persists correctly across a reload (the underlying input value is
  // already persisted via ACC_PERSIST_IDS; this just confirms the derived
  // line is correctly recomputed from it on load, not left stale/blank) ====
  const t7 = await page.evaluate(async () => {
    const el = document.getElementById('qppBase65');
    el.value = 12000;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('qppBase65').value;
  });
  check('qppBase65 value of 12000 took before reload', t7 === '12000');
  await page.reload();
  await page.waitForTimeout(1200);
  const t8 = await page.evaluate(() => document.getElementById('qppPctOfMax').textContent);
  check('after reload, the "% of max" line reflects the persisted qppBase65 value (~67% of QPP\'s $18,096 max)', /≈\s*(66|67)%/.test(t8));

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Console errors: ${consoleErrors.length}`);
  console.log(fail === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL');
  process.exit(fail === 0 && consoleErrors.length === 0 ? 0 : 1);
})();
