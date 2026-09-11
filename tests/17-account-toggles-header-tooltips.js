'use strict';
// Two features, tested together since both were requested in the same
// session pass:
//
// 1. Accumulation tab "Include this account" toggles for RRSP, TFSA, FHSA,
//    DC, and Non-Reg (mirrors the existing DB Pension include/exclude
//    pattern). Unchecking an account must zero it out of runAcc()'s output
//    (lastAccRows) every year WITHOUT clearing its saved field values, and
//    must stay zero even when another still-on account's cap-overflow or
//    the FHSA rollover would otherwise route money into it. State
//    (including the checkbox itself) must persist across a reload.
//
// 2. Year-by-Year Withdrawal Breakdown header tooltips: every column header
//    that didn't already have one (Year, Age, DB, LIF, RRIF, QPP, OAS,
//    Taxable, Tax, Clawbk, TFSA, Income, Target, Cash Flow, Gap) should now
//    carry a `title` attribute, and the ones that already had one (WR%,
//    Budget, the four "Bal →" columns) must be unchanged.
const { openApp, finish } = require('./lib');

(async () => {
  const checks = [];
  const check = (name, cond) => checks.push({ name, pass: !!cond });

  // ── Part 1: account-include toggles ───────────────────────────────────
  {
    const { browser, page, consoleErrors } = await openApp(process.argv[2]);

    await page.evaluate(() => { showTab('acc'); });
    await page.waitForTimeout(300);

    // Defaults: every toggle checked, every wrap visually enabled.
    const defaults = await page.evaluate(() => {
      const pairs = [['useRRSP','rrspFieldsWrap'],['useTFSA','tfsaFieldsWrap'],['useFHSA','fhsaFieldsWrap'],
                     ['useDC','dcFieldsWrap'],['useNonreg','nrFieldsWrap']];
      return pairs.map(([cb,wrap]) => ({
        cb, checked: document.getElementById(cb)?.checked,
        opacity: document.getElementById(wrap)?.style.opacity,
      }));
    });
    check('all 5 account toggles exist and default to checked',
      defaults.every(d => d.checked === true));
    check('all 5 field wraps default to full opacity (or unset, which computes to visible)',
      defaults.every(d => d.opacity === '1' || d.opacity === ''));

    // Exclude RRSP: lastAccRows.rrsp must be 0 every year, rrspBal input
    // value must NOT be cleared, and the wrap must visually dim.
    const excludeRrsp = await page.evaluate(() => {
      const before = document.getElementById('rrspBal').value;
      document.getElementById('useRRSP').checked = false;
      _toggleAcctInclude('useRRSP','rrspFieldsWrap');
      runAcc();
      const rows = lastAccRows;
      return {
        rrspBalFieldUnchanged: document.getElementById('rrspBal').value === before,
        allYearsZero: rows.every(r => r.rrsp === 0),
        wrapDimmed: document.getElementById('rrspFieldsWrap').style.opacity === '0.4',
        wrapPointerNone: document.getElementById('rrspFieldsWrap').style.pointerEvents === 'none',
        anyContribStats: rows.some(r => (r.stats.rrsp.ann||0) > 0 || (r.stats.rrsp.bw||0) > 0),
      };
    });
    check('excluding RRSP zeroes it in every projected year', excludeRrsp.allYearsZero);
    check('excluding RRSP does not clear the saved balance input', excludeRrsp.rrspBalFieldUnchanged);
    check('excluding RRSP dims its field wrap', excludeRrsp.wrapDimmed);
    check('excluding RRSP disables pointer events on its field wrap', excludeRrsp.wrapPointerNone);
    check('excluding RRSP stops new contributions from accruing', !excludeRrsp.anyContribStats);

    // Re-check RRSP: value comes back, balances resume growing.
    const recheckRrsp = await page.evaluate(() => {
      document.getElementById('useRRSP').checked = true;
      _toggleAcctInclude('useRRSP','rrspFieldsWrap');
      runAcc();
      return {
        wrapRestored: document.getElementById('rrspFieldsWrap').style.opacity === '1',
        rrspGrowsAgain: lastAccRows.some(r => r.rrsp > 0),
      };
    });
    check('re-checking RRSP restores its field wrap', recheckRrsp.wrapRestored);
    check('re-checking RRSP resumes normal balance growth', recheckRrsp.rrspGrowsAgain);

    // Overflow-leak guard: TFSA cap reached with overflow routed to RRSP,
    // while RRSP is excluded — RRSP must still show exactly $0 every year,
    // not silently receive the routed overflow.
    const overflowLeak = await page.evaluate(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; };
      set('tfsaCap', '1000');
      set('tfsaAnnual', '20000');
      set('tfsaBiweekly', '0');
      set('tfsaOverflow', 'rrsp');
      document.getElementById('useRRSP').checked = false;
      _toggleAcctInclude('useRRSP','rrspFieldsWrap');
      runAcc();
      const leaked = lastAccRows.some(r => r.rrsp !== 0);
      const tfsaCapped = lastAccRows.some(r => (r.stats.tfsa.capRem === 0));
      return { leaked, tfsaCapped };
    });
    check('TFSA cap-overflow routed to an excluded RRSP does not leak in (stays $0)', !overflowLeak.leaked);
    check('sanity: the TFSA cap really was reached in this scenario', overflowLeak.tfsaCapped);

    // FHSA-rollover leak guard: FHSA set to roll into RRSP after 1 year,
    // while RRSP is excluded — the rollover year's RRSP balance must still
    // be exactly $0.
    const rolloverLeak = await page.evaluate(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; };
      set('fhsaBal', '10000');
      set('fhsaAnnual', '0');
      set('fhsaBiweekly', '0');
      set('fhsaRoll', 'yes');
      set('fhsaRollYrs', '1');
      // useRRSP already false from the previous block
      runAcc();
      const rolloverRow = lastAccRows.find(r => r.fhsaRolled === true);
      return {
        rolloverHappened: !!rolloverRow,
        rrspStillZero: rolloverRow ? rolloverRow.rrsp === 0 : null,
      };
    });
    check('sanity: FHSA rollover year actually occurred', rolloverLeak.rolloverHappened);
    check('FHSA rollover into an excluded RRSP does not leak in (stays $0)', rolloverLeak.rrspStillZero === true);

    // Reset RRSP back on, and confirm persistence across a reload: toggle
    // TFSA and DC off, reload, and check both checkbox state and wrap
    // dimming survive.
    await page.evaluate(() => {
      document.getElementById('useRRSP').checked = true;
      _toggleAcctInclude('useRRSP','rrspFieldsWrap');
      document.getElementById('useTFSA').checked = false;
      _toggleAcctInclude('useTFSA','tfsaFieldsWrap');
      document.getElementById('useDC').checked = false;
      _toggleAcctInclude('useDC','dcFieldsWrap');
      _saveAccState();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    const persisted = await page.evaluate(() => ({
      rrspOn: document.getElementById('useRRSP').checked,
      tfsaOn: document.getElementById('useTFSA').checked,
      dcOn: document.getElementById('useDC').checked,
      tfsaWrapDimmed: document.getElementById('tfsaFieldsWrap').style.opacity === '0.4',
      dcWrapDimmed: document.getElementById('dcFieldsWrap').style.opacity === '0.4',
      rrspWrapNotDimmed: document.getElementById('rrspFieldsWrap').style.opacity !== '0.4',
    }));
    check('account toggle state (on) survives a reload', persisted.rrspOn === true);
    check('account toggle state (off, TFSA) survives a reload', persisted.tfsaOn === false);
    check('account toggle state (off, DC) survives a reload', persisted.dcOn === false);
    check('TFSA field wrap re-dims correctly after reload', persisted.tfsaWrapDimmed);
    check('DC field wrap re-dims correctly after reload', persisted.dcWrapDimmed);
    check('RRSP field wrap stays un-dimmed after reload (it was left on)', persisted.rrspWrapNotDimmed);

    check('no console errors throughout the account-toggle scenario', consoleErrors.length === 0);
    await browser.close();
  }

  // ── Part 2: Year-by-Year header tooltips ──────────────────────────────
  {
    const { browser, page, consoleErrors } = await openApp(process.argv[2]);
    await page.evaluate(() => { showTab('ret'); });
    await page.waitForTimeout(500);

    const titles = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('#mainTable thead th'));
      const out = {};
      ths.forEach(th => {
        // Use the first line of text (before any <br>) as a stable label key.
        const label = (th.childNodes[0] && th.childNodes[0].textContent || th.textContent).trim().split('\n')[0].trim();
        out[label] = th.getAttribute('title');
      });
      return out;
    });

    const newlyTitled = ['Year','Age','DB','LIF','RRIF','QPP','OAS','Taxable','Tax','Clawbk','TFSA','Income','Target','Cash Flow','Gap'];
    newlyTitled.forEach(label => {
      const t = titles[label];
      check(`header "${label}" has a non-empty tooltip`, typeof t === 'string' && t.length > 10);
    });

    // Previously-tooltipped headers must still be present and unchanged in
    // substance (spot-check WR% and Budget, which had the most distinctive
    // existing text).
    check('WR% tooltip still present and unchanged', /Withdrawal rate/i.test(titles['WR%'] || ''));
    check('Budget tooltip still present and unchanged', /Budget tab/i.test(titles['Budget'] || ''));

    check('no console errors while checking header tooltips', consoleErrors.length === 0);
    await browser.close();
  }

  let pass = 0, fail = 0;
  checks.forEach(c => { if (c.pass) pass++; else { fail++; console.error('FAIL:', c.name); } });
  console.log(`${pass} passed, ${fail} failed`);

  const ok = fail === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
