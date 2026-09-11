'use strict';
// Shared browser-launch helper for every test in this suite. Keeps the
// sandbox-specific bits (a fixed Chromium path, a locally-served copy of
// Chart.js) isolated to one place, and falls back to the normal, portable
// path — Playwright's own managed browser, a real network fetch of Chart.js
// from cdnjs — whenever the sandbox-specific option isn't available. That
// makes the same test files runnable both by Claude (in the cloud sandbox
// used to develop this app) and by a person running `npm install` locally.
const fs = require('fs');
const path = require('path');

function resolvePlaywright() {
  // Prefer a real npm-installed Playwright next to this suite (the normal
  // path — see package.json/README). Fall back to the development sandbox's
  // pre-installed copy, used when Claude runs these tests in its own cloud
  // environment without a local `npm install` having been run.
  try { return require('playwright'); } catch (e) { /* try sandbox copy */ }
  try { return require('/opt/node-tools/node_modules/playwright'); } catch (e) { /* fall through */ }
  throw new Error(
    'Could not load Playwright. Run `npm install` in this tests/ folder first ' +
    '(see README.md), or run this from the Claude Code sandbox where it is preinstalled.'
  );
}

function resolveChromiumExecutable() {
  // A locally-installed Playwright (after `npx playwright install chromium`)
  // manages its own browser and needs no override — return undefined so
  // chromium.launch() uses its default. Only the sandbox path below needs an
  // explicit executablePath, since that Chromium build lives outside
  // Playwright's normal browser cache.
  const sandboxPaths = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ];
  for (const p of sandboxPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function resolveChartJs() {
  // Serve Chart.js from a local copy so tests are fast and don't depend on
  // network access to cdnjs. Looked up in this tests/ folder's own
  // node_modules (installed via `npm install` — see package.json). If it
  // isn't there, return null and let the real cdnjs request through instead
  // (needs network access, and Chart.js's real CDN build).
  const p = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

function resolveTargetFile(argFile) {
  if (argFile) return path.resolve(argFile);
  // Default: the app file lives one directory up from this tests/ folder.
  return path.resolve(__dirname, '..', 'withdrawal_strategy_JP.html');
}

// Opens the app in a fresh browser context and returns everything a test
// typically needs. `argFile`, if given, overrides which HTML file to open
// (defaults to ../withdrawal_strategy_JP.html relative to this folder) —
// every test script also accepts this as `process.argv[2]` so you can point
// the whole suite at a different copy of the file without editing anything.
async function openApp(argFile, opts) {
  opts = opts || {};
  const { chromium } = resolvePlaywright();
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage(opts.viewport ? { viewport: opts.viewport } : {});
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

  const chartJs = resolveChartJs();
  if (chartJs) {
    await page.route('https://cdnjs.cloudflare.com/**', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: chartJs });
    });
  } // else: let the real cdnjs request through — needs network access.

  // Optional: pre-seed localStorage with specific key/value string pairs
  // BEFORE the app's own <script> runs, by installing them via an init
  // script that Playwright runs at document-start on every navigation in
  // this page. Used by tests that need to simulate a browser with old,
  // pre-migration localStorage state already present (or, with an empty
  // object, a completely fresh browser with nothing at all — the default
  // when this option is omitted).
  if (opts.seedLocalStorage) {
    await page.addInitScript((seed) => {
      Object.keys(seed).forEach(k => localStorage.setItem(k, seed[k]));
    }, opts.seedLocalStorage);
  }

  const FILE = resolveTargetFile(argFile);
  if (!fs.existsSync(FILE)) {
    throw new Error(
      `App file not found: ${FILE}\n` +
      `Pass its path as the first argument, e.g.:\n` +
      `  node tests/${path.basename(process.argv[1] || 'some_test.js')} "path/to/withdrawal_strategy_JP.html"`
    );
  }
  await page.goto('file://' + FILE, { waitUntil: 'load' });
  await page.waitForTimeout(opts.skipInitialWait ? 0 : 1000);

  return { browser, page, consoleErrors, FILE };
}

// Small helper every test uses at the end: print PASS/FAIL, close the
// browser, and exit with the matching code so run-all.js (and CI, if this
// ever gets wired into one) can tell success from failure.
async function finish(browser, ok, extra) {
  if (extra) console.log(extra);
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
}

module.exports = { openApp, finish };
