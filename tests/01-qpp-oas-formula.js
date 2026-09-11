'use strict';
// _getQPP() computes the QPP deferral live (+0.7%/month), the same way
// _getOAS() already computes its 7.2%/year OAS deferral, instead of
// switching between two hardcoded dollar figures. This just checks the
// live formula still lands on the exact numbers the old hardcoded pair
// used to produce (19,718 at 65, 28,000 at 70) so nothing on screen moved
// when that refactor shipped.
const { openApp, finish } = require('./lib');

(async () => {
  const { browser, page, consoleErrors } = await openApp(process.argv[2]);

  const spread = await page.evaluate(() => {
    const rows = [];
    [60, 62, 65, 66, 70, 71, 75].forEach(age => {
      [65, 70].forEach(qppStart => {
        rows.push({ age, qppStart, qpp: _getQPP(age, qppStart) });
      });
    });
    return rows;
  });
  console.log('QPP spread:', JSON.stringify(spread));

  const base = await page.evaluate(() => ({
    base65: _getQPP(65, 65),
    base70: _getQPP(70, 70),
  }));
  console.log('Base at qppStart==age (no indexation drift):', JSON.stringify(base));

  const matchesOld = base.base65 === 19718 && base.base70 === 28000;
  console.log('Matches old hardcoded constants (19718 / 28000):', matchesOld);

  const ok = matchesOld && consoleErrors.length === 0;
  await finish(browser, ok, `Console errors: ${consoleErrors.length}`);
})();
