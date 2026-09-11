'use strict';
// Runs every numbered test file in this folder against the app file (one
// directory up by default, or pass a path as the first argument) and prints
// a pass/fail summary table. Exits non-zero if anything failed, so this can
// be wired into a pre-commit hook or CI later if that's ever worth doing.
//
// Usage:
//   node run-all.js                                   (uses ../withdrawal_strategy_JP.html)
//   node run-all.js "/path/to/withdrawal_strategy_JP.html"
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const targetFile = process.argv[2]; // optional override, forwarded to every test

const testFiles = fs.readdirSync(__dirname)
  .filter(f => /^\d+-.*\.js$/.test(f))
  .sort();

if (testFiles.length === 0) {
  console.error('No test files found (expected files named like "01-something.js").');
  process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s)...\n`);

const results = [];
for (const file of testFiles) {
  const args = targetFile ? [path.join(__dirname, file), targetFile] : [path.join(__dirname, file)];
  const start = Date.now();
  let output = '', ok = false;
  try {
    output = execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' });
    ok = true;
  } catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
    ok = false;
  }
  const ms = Date.now() - start;
  results.push({ file, ok, ms, output });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${ms}ms)`);
  if (!ok) {
    // Show the tail of the failing test's output -- usually the FAIL: lines
    // and the error -- without flooding the console for the whole run.
    console.log(output.trim().split('\n').slice(-15).map(l => '    ' + l).join('\n'));
  }
}

const passCount = results.filter(r => r.ok).length;
const failCount = results.length - passCount;
console.log(`\n${passCount}/${results.length} test files passed.`);
if (failCount > 0) {
  console.log(`Failed: ${results.filter(r => !r.ok).map(r => r.file).join(', ')}`);
}
process.exit(failCount > 0 ? 1 : 0);
