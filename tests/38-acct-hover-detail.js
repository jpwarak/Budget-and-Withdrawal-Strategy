'use strict';
// LIF/RRIF/TFSA hover detail box (Retirement Income tab, Year-by-Year table)
// -- JP's request: "mousehoever over" the LIF/RRIF/TFSA cells to see per-row
// detail. LIF: Year, Age, Min Withdrawal, Max Withdrawal, Withdrawal Rate,
// Tax Paid. RRIF: Year, Age, Min Withdrawal, Withdrawal Rate, Tax Paid,
// Contribution Room (no Max -- RRIFs have no legal maximum). TFSA:
// Contribution Room, Withdrawal Rate.
//
// This required exposing lifMin/lifMax/rrifMin/tfsaRoom on each simulated
// row -- previously these were internal loop variables in the three
// simulate*() functions (simulateResidentFixed, simulateNonResident,
// simulateNonResidentLump), computed but never attached to the row objects
// the UI reads.
//
// 2026-09-11 update: RRIF's Contribution Room line was originally dropped
// (RRSP room wasn't tracked during retirement at all) -- now that the "RRSP
// contribution room tracking" roadmap item carries a real (frozen) rrspRoom
// number across the Accumulation-to-retirement boundary, the line is back;
// see t3 below and the app's own doc comment above _showAcctHover().
//
// JP later corrected two things (same day): "Tax Paid" should be that
// ACCOUNT's portion of the year's tax, not the whole year's tax bill; and
// each box should also show that account's own Withdrawal Rate % (not the
// table's overall WR% column). Confirmed via AskUserQuestion: Tax Paid is
// allocated proportionally (that account's gross income this year ÷ total
// taxable income this year × the year's real total tax -- so every
// account's share sums exactly to the real total, unlike a marginal-rate
// or stacking-order allocation); Withdrawal Rate divides by that account's
// OWN opening balance this year (same convention the Min/Max rates
// themselves already use), not the table's starting-portfolio convention.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('.age-btn.active')?.click(); });
  await page.waitForTimeout(300);

  // ---- Every row carries the new fields, and they're computed correctly ----
  const t1 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const mismatches = [];
    DATA.forEach(d => {
      const expLifMin = Math.round(d.lifBal * _lifMinRate(d.age));
      const expLifMax = Math.round(d.lifBal * _lifMaxRate(d.age, d.lifBal));
      const expRrifMin = Math.round(d.rrspBal * _rrifMinRate(d.age));
      if (d.lifMin !== expLifMin || d.lifMax !== expLifMax || d.rrifMin !== expRrifMin) {
        mismatches.push({ age: d.age, got: { lifMin: d.lifMin, lifMax: d.lifMax, rrifMin: d.rrifMin }, exp: { expLifMin, expLifMax, expRrifMin } });
      }
    });
    return {
      allHaveFields: DATA.every(d => d.lifMin != null && d.lifMax != null && d.rrifMin != null && d.tfsaRoom != null && d.rrspRoom != null),
      mismatches,
      maxAtLeastMin: DATA.every(d => d.lifMax >= d.lifMin),
    };
  });
  check('every row carries lifMin, lifMax, rrifMin, tfsaRoom, rrspRoom (not just internal loop variables anymore)', t1.allHaveFields);
  check('lifMin/lifMax/rrifMin match the same rate formulas applied to that row\'s opening balance', t1.mismatches.length === 0);
  if (t1.mismatches.length) console.log('Mismatches:', t1.mismatches.slice(0, 5));
  check('LIF max is never less than LIF min for any row', t1.maxAtLeastMin);

  // High budget + realistic portfolio so LIF/RRIF/TFSA all actually get
  // drawn from in some year with a real balance behind them -- otherwise
  // the withdrawal-rate/tax-share checks below could trivially pass on an
  // all-zero row without proving anything.
  await page.evaluate(() => { showTab('budget'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const fill = (id, val) => { const el = document.getElementById(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
    fill('bud_houseRent_amt', 8000);
    fill('bud_houseMortgage_amt', 4000);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { showTab('ret'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    lastAccRows = null; liveData = null; portfolioOverride = null;
    currentAge = 62; renderAll(62);
  });
  await page.waitForTimeout(200);

  // ---- Hovering the LIF cell shows Year/Age/Min/Max/Withdrawal Rate/Tax ----
  const t2 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const target = DATA.find(d => d.lif > 0 && d.lifBal > 0) || DATA[1];
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => /^\d+$/.test(tr.children[1]?.textContent || ''));
    const row = rows.find(tr => parseInt(tr.children[1].textContent) === target.age);
    const lifCell = row.children[4]; // Year,Age,WR%,DB,LIF -> index 4
    lifCell.dispatchEvent(new Event('mouseenter', { bubbles: true }));
    const box = document.getElementById('acctHoverBox');
    const text = box.textContent;
    const visible = box.style.display !== 'none';
    lifCell.dispatchEvent(new Event('mouseleave', { bubbles: true }));
    const hiddenAfterLeave = document.getElementById('acctHoverBox').style.display === 'none';
    const fmt = v => '$' + Math.round(v || 0).toLocaleString();
    const expWR = target.lifBal > 0 ? (target.lif / target.lifBal * 100).toFixed(1) + '%' : '—';
    const expTaxShare = target.totalTaxable > 0 ? Math.round(target.tax * (target.lif / target.totalTaxable)) : 0;
    return {
      visible, hiddenAfterLeave, text,
      hasAge: text.includes(String(target.age)),
      hasMin: text.includes('Min Withdrawal') && text.includes(fmt(target.lifMin)),
      hasMax: text.includes('Max Withdrawal') && text.includes(fmt(target.lifMax)),
      hasWR: text.includes('Withdrawal Rate') && text.includes(expWR),
      hasTaxShare: text.includes('Tax Paid') && text.includes(fmt(expTaxShare)),
      notFullYearTax: expTaxShare !== target.tax || target.tax === 0, // proves this is a real allocation, not just the whole year's tax, whenever there's other taxable income
    };
  });
  check('hovering a LIF cell shows the detail box', t2.visible);
  check('LIF box shows this row\'s age', t2.hasAge);
  check('LIF box shows Min Withdrawal matching lifMin', t2.hasMin);
  check('LIF box shows Max Withdrawal matching lifMax', t2.hasMax);
  check('LIF box shows its OWN Withdrawal Rate (lif ÷ lifBal), not the table\'s overall WR% column', t2.hasWR);
  check('LIF box shows Tax Paid as this account\'s proportional share, matching (lif÷totalTaxable)×tax', t2.hasTaxShare);
  check('LIF\'s tax share is a real allocation, not silently just the whole year\'s tax bill', t2.notFullYearTax);
  check('moving the mouse away hides the box again', t2.hiddenAfterLeave);

  // ---- Hovering the RRIF cell shows Min + Withdrawal Rate + Tax share +
  // Contribution Room (added 2026-09-11, once RRSP room tracking carried a
  // real number through to retirement -- see the roadmap), but NOT Max. ----
  const t3 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const target = DATA.find(d => d.rrif > 0 && d.rrspBal > 0) || DATA[1];
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => /^\d+$/.test(tr.children[1]?.textContent || ''));
    const row = rows.find(tr => parseInt(tr.children[1].textContent) === target.age);
    const rrifCell = row.children[5]; // ...DB,LIF,RRIF -> index 5
    rrifCell.dispatchEvent(new Event('mouseenter', { bubbles: true }));
    const text = document.getElementById('acctHoverBox').textContent;
    rrifCell.dispatchEvent(new Event('mouseleave', { bubbles: true }));
    const fmt = v => '$' + Math.round(v || 0).toLocaleString();
    const expWR = target.rrspBal > 0 ? (target.rrif / target.rrspBal * 100).toFixed(1) + '%' : '—';
    const expTaxShare = target.totalTaxable > 0 ? Math.round(target.tax * (target.rrif / target.totalTaxable)) : 0;
    return {
      hasMin: text.includes('Min Withdrawal') && text.includes(fmt(target.rrifMin)),
      hasWR: text.includes('Withdrawal Rate') && text.includes(expWR),
      hasTaxShare: text.includes('Tax Paid') && text.includes(fmt(expTaxShare)),
      noMax: !text.includes('Max'),
      hasRoom: text.includes('Contribution Room') && text.includes(fmt(target.rrspRoom)),
    };
  });
  check('RRIF box shows Min Withdrawal matching rrifMin', t3.hasMin);
  check('RRIF box shows its OWN Withdrawal Rate (rrif ÷ rrspBal), not the table\'s overall WR% column', t3.hasWR);
  check('RRIF box shows Tax Paid as this account\'s proportional share, matching (rrif÷totalTaxable)×tax', t3.hasTaxShare);
  check('RRIF box does NOT show a Max Withdrawal line (RRIFs have no legal maximum)', t3.noMax);
  check('RRIF box shows Contribution Room matching the frozen rrspRoom carried from the Accumulation tab', t3.hasRoom);

  // ---- The LIF and RRIF tax shares actually sum to the row's real total tax
  // (the whole point of the proportional-allocation method JP chose) ----
  const t6 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const target = DATA.find(d => d.lif > 0 && d.rrif > 0 && d.totalTaxable > 0);
    if (!target) return { found: false };
    const shares = ['db', 'lif', 'rrif', 'qpp', 'oas'].map(k => Math.round(target.tax * ((target[k] || 0) / target.totalTaxable)));
    const sum = shares.reduce((a, b) => a + b, 0);
    return { found: true, sum, tax: target.tax, closeEnough: Math.abs(sum - target.tax) <= 5 }; // rounding on each share can drift by a few dollars
  });
  if (t6.found) {
    check('every taxable source\'s proportional tax share sums back to the row\'s real total tax (rounding aside)', t6.closeEnough);
  }

  // ---- Hovering the TFSA cell shows contribution room + its own Withdrawal Rate ----
  const t4 = await page.evaluate(() => {
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    const target = DATA.find(d => d.tfsa > 0 && d.tfsaBal > 0) || DATA[1];
    const rows = Array.from(document.querySelectorAll('#mainTable tbody tr')).filter(tr => /^\d+$/.test(tr.children[1]?.textContent || ''));
    const row = rows.find(tr => parseInt(tr.children[1].textContent) === target.age);
    const tfsaCell = row.querySelector('.col-tfsa');
    tfsaCell.dispatchEvent(new Event('mouseenter', { bubbles: true }));
    const text = document.getElementById('acctHoverBox').textContent;
    tfsaCell.dispatchEvent(new Event('mouseleave', { bubbles: true }));
    const fmt = v => '$' + Math.round(v || 0).toLocaleString();
    const expWR = target.tfsaBal > 0 ? (target.tfsa / target.tfsaBal * 100).toFixed(1) + '%' : '—';
    return {
      hasRoom: text.includes('Contribution Room') && text.includes(fmt(target.tfsaRoom)),
      hasWR: text.includes('Withdrawal Rate') && text.includes(expWR),
      noTax: !text.includes('Tax Paid'), // TFSA withdrawals are tax-free
    };
  });
  check('TFSA box shows Contribution Room matching tfsaRoom', t4.hasRoom);
  check('TFSA box shows its OWN Withdrawal Rate (tfsa ÷ tfsaBal)', t4.hasWR);
  check('TFSA box does NOT show a Tax Paid line (TFSA withdrawals are tax-free)', t4.noTax);

  // ---- Non-Resident mode: same fields exist and hover still works ----
  const t5 = await page.evaluate(() => {
    setMode('nonresident');
    if (spendMode !== 'nonresident') return { skipped: true };
    showTab('ret');
    lastAccRows = null; liveData = null; portfolioOverride = null;
    renderAll(currentAge || 65);
    const comboKey = qppStart + '_' + oasStart;
    const DATA = liveData.data[spendMode][comboKey];
    return { skipped: false, allHaveFields: DATA.every(d => d.lifMin != null && d.lifMax != null && d.rrifMin != null && d.tfsaRoom != null && d.rrspRoom != null) };
  });
  if (!t5.skipped) {
    check('Non-Resident mode rows also carry lifMin/lifMax/rrifMin/tfsaRoom/rrspRoom', t5.allHaveFields);
  }

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0 && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
