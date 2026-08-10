/**
 * run-all.js — runs all test files as separate processes
 * (separately so one crashing doesn't take down the whole suite / to avoid port conflicts).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'incident-console.test.js',
  'companion-server.test.js'
];

let allOk = true;
for (const file of files) {
  console.log(`\n${'#'.repeat(60)}\n# ${file}\n${'#'.repeat(60)}`);
  const res = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  if (res.status !== 0) allOk = false;
}

process.exit(allOk ? 0 : 1);
