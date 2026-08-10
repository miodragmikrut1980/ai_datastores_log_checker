/**
 * harness.js — minimal test runner, no dependencies (aside from jsdom used by the tests).
 * Intentionally avoids mocha/jest so the whole test suite stays simple to run: `npm test`.
 */
let currentSuite = '';
let passCount = 0;
let failCount = 0;
const failures = [];

function suite(name, fn) {
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  return fn();
}

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ suite: currentSuite, name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}
function assertIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${msg || 'string does not contain the expected substring'}\n    looking for: ${JSON.stringify(needle)}\n    in: ${String(haystack).slice(0, 200)}...`);
  }
}
function assertNotIncludes(haystack, needle, msg) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${msg || 'string contains something it should not'}\n    should not have found: ${JSON.stringify(needle)}`);
  }
}

function summary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total: ${passCount + failCount}   \x1b[32mPassed: ${passCount}\x1b[0m   \x1b[31mFailed: ${failCount}\x1b[0m`);
  if (failures.length) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - [${f.suite}] ${f.name}`));
  }
  console.log('='.repeat(60));
  return failCount === 0;
}

module.exports = { suite, test, assert, assertEqual, assertIncludes, assertNotIncludes, summary };
