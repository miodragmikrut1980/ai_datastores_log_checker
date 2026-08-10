/**
 * companion-server.test.js — integration test: actually starts companion-server.js
 * as a child process (with PATH pointed at a mock kubectl), then sends it real HTTP requests.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { suite, test, assert, assertEqual, assertIncludes, summary } = require('./harness');

const PORT = 8799;
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SERVER_PATH = path.join(__dirname, '..', 'companion-server.js');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 5000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${FIXTURES_DIR}${path.delimiter}${process.env.PATH}` };
    const child = spawn('node', [SERVER_PATH, String(PORT)], { env });
    let output = '';
    let resolved = false;
    child.stdout.on('data', d => {
      output += d.toString();
      const m = output.match(/Token:\s+(\S+)/);
      if (m && !resolved) { resolved = true; resolve({ child, token: m[1] }); }
    });
    child.stderr.on('data', d => { if (!resolved) console.error('server stderr:', d.toString()); });
    setTimeout(() => { if (!resolved) reject(new Error('server did not print a token in time')); }, 4000);
  });
}

let child;

async function run() {
  let token;

  await suite('Companion server — integration tests (mock kubectl)', async () => {
    await test('Server starts and prints a token', async () => {
      const res = await startServer();
      child = res.child;
      token = res.token;
      assert(token && token.length > 10, 'token should exist and be long enough');
    });

    await test('/health returns 200 without needing a token', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/health`);
      assertEqual(res.status, 200);
      assertIncludes(res.body, '"ok":true');
    });

    await test('CORS is scoped to "null" (file:// origin), not wildcarded to "*"', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/health`);
      assertEqual(res.headers['access-control-allow-origin'], 'null');
    });

    await test('A request without a token returns 401', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/logs?namespace=production&pod=es-data-0`);
      assertEqual(res.status, 401);
    });

    await test('A request with the wrong token returns 401', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/logs?namespace=production&pod=es-data-0`, { 'X-Companion-Token': 'wrong-token' });
      assertEqual(res.status, 401);
    });

    await test('An invalid namespace (injection attempt) returns 400', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/logs?namespace=${encodeURIComponent('prod;rm -rf /')}&pod=es-data-0`, { 'X-Companion-Token': token });
      assertEqual(res.status, 400);
    });

    await test('/logs with valid parameters calls kubectl logs --previous and logs', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/logs?namespace=production&pod=es-data-0`, { 'X-Companion-Token': token });
      assertEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assertIncludes(data.text, '--previous');
      assertIncludes(data.text, 'es-data-0');
      assertIncludes(data.text, '-n production');
    });

    await test('/status for elasticsearch calls _cluster/health and _cat/shards via kubectl exec', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/status?namespace=production&pod=es-data-0&type=elasticsearch`, { 'X-Companion-Token': token });
      assertEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assertIncludes(data.text, '_cluster/health');
      assertIncludes(data.text, '_cat/shards');
    });

    await test('/status for clickhouse calls clickhouse-client with 3 queries', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/status?namespace=production&pod=ch-0&type=clickhouse`, { 'X-Companion-Token': token });
      const data = JSON.parse(res.body);
      assertIncludes(data.text, 'clickhouse-client');
      assertIncludes(data.text, 'detached parts');
    });

    await test('/status for kafka calls kafka-topics.sh --describe', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/status?namespace=production&pod=kafka-0&type=kafka`, { 'X-Companion-Token': token });
      const data = JSON.parse(res.body);
      assertIncludes(data.text, 'kafka-topics.sh');
      assertIncludes(data.text, '--describe');
    });

    await test('/instana collects read-only Instana/Kubernetes context', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/instana?namespace=instana-clickhouse&pod=clickhouse-0`, { 'X-Companion-Token': token });
      assertEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assertIncludes(data.text, 'stanctl status');
      assertIncludes(data.text, 'kubectl get ns');
      assertIncludes(data.text, 'statefulset,pod,pvc');
      assertIncludes(data.text, 'describe pod clickhouse-0');
    });

    await test('/instana/bundle returns structured, read-only evidence with partial-failure visibility', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/instana/bundle?namespace=instana-clickhouse&pod=clickhouse-0`, { 'X-Companion-Token': token });
      assert([200, 207].includes(res.status), 'bundle should return success or multi-status, never hide partial failure');
      const data = JSON.parse(res.body);
      assertEqual(data.schemaVersion, 'instana-evidence-bundle.v1');
      assertEqual(data.readOnly, true);
      assert(data.summary.total >= 8, 'bundle should contain the full evidence checklist');
      assert(Array.isArray(data.results), 'bundle should expose per-command results');
      assertIncludes(data.text, 'stanctl unit status');
      assertIncludes(data.text, 'previous logs');
    });

    await test('/status with an invalid type returns 400', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/status?namespace=production&pod=es-data-0&type=mongodb`, { 'X-Companion-Token': token });
      assertEqual(res.status, 400);
    });

    await test('An unknown route returns 404', async () => {
      const res = await httpGet(`http://127.0.0.1:${PORT}/no-such-route?namespace=production&pod=x`, { 'X-Companion-Token': token });
      assertEqual(res.status, 404);
    });
  });

  if (child) child.kill();
  const ok = summary();
  process.exit(ok ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL ERROR IN TEST SUITE:', err);
  if (child) try { child.kill(); } catch (e) {}
  process.exit(1);
});
