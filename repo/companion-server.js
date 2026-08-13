#!/usr/bin/env node
/**
 * companion-server.js — Local "auto-fetch" companion for Incident Console
 *
 * PURPOSE:
 *   Incident Console (incident-console.html) is a static page and, for security
 *   reasons, cannot call kubectl / your cluster on its own. This small local server
 *   bridges that gap: it listens ONLY on 127.0.0.1 (localhost), receives requests
 *   from the page, runs READ-ONLY kubectl commands, and returns the text result
 *   which the page automatically fills into the logs/status fields.
 *
 * SECURITY (read before running):
 *   - The server listens EXCLUSIVELY on 127.0.0.1 — unreachable from the network/other machines.
 *   - Every request must include the exact token (printed on startup) in the
 *     X-Companion-Token header — this prevents some other page open in the browser
 *     from silently calling this server without your knowledge.
 *   - CORS is scoped to Origin "null" (what a local file:// page sends), not "*" —
 *     a page loaded from a real website cannot read this server's responses.
 *   - ONLY predefined, read-only commands are executed (logs, describe,
 *     health queries). No deletion, restart, or arbitrary commands from the page.
 *   - namespace/pod/topic parameters are strictly validated with a regex before use
 *     and passed as separate arguments (execFile, not exec) — no shell injection risk.
 *
 * RUNNING:
 *   node companion-server.js [port]
 *   (default port is 8787)
 *
 * REQUIREMENTS:
 *   - Node.js 16+ (built-in modules only, no npm install)
 *   - kubectl installed and configured (kubectl config current-context) with cluster access
 *   - For ClickHouse/Kafka: clickhouse-client / kafka-topics.sh must be available
 *     INSIDE the pod (kubectl exec calls them in the container, not locally)
 *
 * USING IT FROM THE INCIDENT CONSOLE PAGE:
 *   1. Start this server, wait for it to print a token.
 *   2. In Incident Console, open the "Companion server" panel in the left sidebar.
 *   3. Enter the namespace, pod, and token (copied from the terminal), select the system type.
 *   4. Click "Fetch automatically" — the logs/status fields will fill themselves in.
 */

const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.argv[2]) || 8787;
const TOKEN = process.env.COMPANION_TOKEN || crypto.randomBytes(16).toString('hex');

const NAME_RE = /^[a-zA-Z0-9._-]{1,253}$/; // valid name for namespace/pod/topic
const VALID_TYPES = new Set(['elasticsearch', 'clickhouse', 'kafka', 'instana']);

// Constant-time token check. A plain `!==` leaks timing information
// proportional to how many leading bytes match, which in principle lets a
// remote-enough attacker recover the token byte-by-byte faster than brute
// force. The server only binds to 127.0.0.1, so the real-world exploitability
// here is low — but the fix is free, and "only matters for a local server"
// isn't something worth relying on once the code has to also justify itself
// in a security review.
function tokenMatches(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(TOKEN), Buffer.from(TOKEN));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
const MAX_BUNDLE_CONCURRENCY = 4;

function validateName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function runKubectl(args) {
  return new Promise((resolve) => {
    execFile('kubectl', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve(`[ERROR running: kubectl ${args.join(' ')}]\n${stderr || err.message}\n`);
      } else {
        resolve(stdout || '');
      }
    });
  });
}

function runOptionalResult(cmd, args, label) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(cmd, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        label, command: `${cmd} ${args.join(' ')}`, ok: !err,
        durationMs: Date.now() - startedAt,
        text: err ? (stderr || err.message || 'command failed') : (stdout || ''),
        error: err ? (stderr || err.message || 'command failed') : null,
      });
    });
  });
}

async function collectInstanaBundle(namespace, pod) {
  // All commands in this bundle are explicitly read-only. Keep the command
  // list visible and structured so a partial failure never looks like a
  // successful diagnosis, and the bundle can be attached to a case/audit log.
  const commands = [
    ['stanctl', ['status'], 'stanctl status'],
    ['stanctl', ['unit', 'status'], 'stanctl unit status'],
    ['kubectl', ['config', 'current-context'], 'kubectl current-context'],
    ['kubectl', ['get', 'nodes', '-o', 'wide'], 'kubectl get nodes'],
    ['kubectl', ['get', 'ns'], 'kubectl get namespaces'],
    ['kubectl', ['-n', namespace, 'get', 'statefulset,pod,pvc', '-o', 'wide'], 'datastore resources'],
    ['kubectl', ['-n', namespace, 'describe', 'pod', pod], 'pod describe'],
    ['kubectl', ['-n', namespace, 'get', 'events', '--sort-by=.lastTimestamp'], 'namespace events'],
    ['kubectl', ['-n', namespace, 'logs', pod, '--previous', '--tail=500'], 'previous logs'],
    ['kubectl', ['-n', namespace, 'logs', pod, '--tail=500'], 'current logs'],
  ];
  const results = [];
  for (let i = 0; i < commands.length; i += MAX_BUNDLE_CONCURRENCY) {
    const batch = commands.slice(i, i + MAX_BUNDLE_CONCURRENCY);
    results.push(...await Promise.all(batch.map(c => runOptionalResult(c[0], c[1], c[2]))));
  }
  const failed = results.filter(r => !r.ok);
  const text = results.map(r => `----- ${r.label} (${r.ok ? 'OK' : 'FAILED'}, ${r.durationMs}ms) -----\n${r.text}`).join('\n');
  return {
    schemaVersion: 'instana-evidence-bundle.v1',
    collectedAt: new Date().toISOString(),
    readOnly: true,
    namespace, pod,
    complete: failed.length === 0,
    summary: { total: results.length, succeeded: results.length - failed.length, failed: failed.length },
    results,
    text,
  };
}

async function fetchLogs(namespace, pod) {
  const [prev, curr] = await Promise.all([
    runKubectl(['logs', pod, '-n', namespace, '--previous', '--tail=500']),
    runKubectl(['logs', pod, '-n', namespace, '--tail=200']),
  ]);
  return `----- kubectl logs --previous -----\n${prev}\n----- kubectl logs (current) -----\n${curr}`;
}

async function fetchStatus(namespace, pod, type) {
  if (type === 'instana') {
    return fetchInstanaContext(namespace, pod);
  }
  if (type === 'elasticsearch') {
    const [health, shards] = await Promise.all([
      runKubectl(['exec', pod, '-n', namespace, '--', 'curl', '-s', 'localhost:9200/_cluster/health?pretty']),
      runKubectl(['exec', pod, '-n', namespace, '--', 'curl', '-s', 'localhost:9200/_cat/shards?v']),
    ]);
    return `----- _cluster/health -----\n${health}\n----- _cat/shards?v -----\n${shards}`;
  }
  if (type === 'clickhouse') {
    // FORMAT JSON (not PrettyCompact) so the frontend can parse structured
    // rows instead of guessing table/part names from ASCII box-drawing text.
    // See parseChParts()/parseChJsonSection() in incident-console.html.
    const q1 = "SELECT database, table, name, is_readonly FROM system.parts WHERE is_readonly OR bytes_on_disk = 0 FORMAT JSON";
    const q2 = "SELECT * FROM system.detached_parts FORMAT JSON";
    const q3 = "SELECT table, replica_name, is_readonly FROM system.replicas WHERE is_readonly FORMAT JSON";
    const [parts, detached, replicas] = await Promise.all([
      runKubectl(['exec', pod, '-n', namespace, '--', 'clickhouse-client', '-q', q1]),
      runKubectl(['exec', pod, '-n', namespace, '--', 'clickhouse-client', '-q', q2]),
      runKubectl(['exec', pod, '-n', namespace, '--', 'clickhouse-client', '-q', q3]),
    ]);
    return `----- broken parts -----\n${parts}\n----- detached parts -----\n${detached}\n----- readonly replicas -----\n${replicas}`;
  }
  if (type === 'kafka') {
    // kafka-topics.sh --describe has no built-in JSON output (unlike ES/CH),
    // so this stays text-based. Known heuristic-parsing limitation — see
    // README "Known limitations".
    const describe = await runKubectl(['exec', pod, '-n', namespace, '--', 'kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--describe']);
    return `----- kafka-topics.sh --describe -----\n${describe}`;
  }
  return '';
}

async function runOptional(cmd, args, label) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(`----- ${label} -----\n[ERROR running: ${cmd} ${args.join(' ')}]\n${stderr || err.message}\n`);
      else resolve(`----- ${label} -----\n${stdout || ''}\n`);
    });
  });
}

async function fetchInstanaContext(namespace, pod) {
  const sections = await Promise.all([
    runOptional('stanctl', ['status'], 'stanctl status'),
    runOptional('stanctl', ['unit', 'status'], 'stanctl unit status'),
    runKubectl(['get', 'ns']),
    runKubectl(['-n', namespace, 'get', 'statefulset,pod,pvc', '-o', 'wide']),
    runKubectl(['-n', namespace, 'describe', 'pod', pod]),
    runKubectl(['-n', namespace, 'get', 'events', '--sort-by=.lastTimestamp']),
  ]);
  return [
    sections[0],
    sections[1],
    `----- kubectl get ns -----\n${sections[2]}`,
    `----- kubectl -n ${namespace} get statefulset,pod,pvc -o wide -----\n${sections[3]}`,
    `----- kubectl -n ${namespace} describe pod ${pod} -----\n${sections[4]}`,
    `----- kubectl -n ${namespace} get events --sort-by=.lastTimestamp -----\n${sections[5]}`,
  ].join('\n');
}

function setCors(res) {
  // incident-console.html is opened as a local file, so the browser sends
  // Origin: null on every fetch() — responding with that exact value (not "*")
  // means a page loaded from a real http(s) site cannot successfully read this
  // server's responses even if it guesses the port, since its Origin header
  // will never match. The token check below is still the primary defense;
  // this narrows the blast radius as a second layer, as it should.
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Companion-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') { sendJson(res, 200, { ok: true }); return; }

  if (!tokenMatches(req.headers['x-companion-token'])) {
    sendJson(res, 401, { error: 'Invalid or missing token (X-Companion-Token header).' });
    return;
  }

  const namespace = url.searchParams.get('namespace') || '';
  const pod = url.searchParams.get('pod') || '';
  if (!validateName(namespace) || !validateName(pod)) {
    sendJson(res, 400, { error: 'Invalid namespace or pod name (allowed: letters, numbers, dot, dash, underscore).' });
    return;
  }

  try {
    if (url.pathname === '/logs') {
      const text = await fetchLogs(namespace, pod);
      sendJson(res, 200, { text });
      return;
    }
    if (url.pathname === '/status') {
      const type = url.searchParams.get('type') || '';
      if (!VALID_TYPES.has(type)) {
        sendJson(res, 400, { error: 'type must be one of: elasticsearch, clickhouse, kafka, instana' });
        return;
      }
      const text = await fetchStatus(namespace, pod, type);
      sendJson(res, 200, { text });
      return;
    }
  if (url.pathname === '/instana') {
      const text = await fetchInstanaContext(namespace, pod);
      sendJson(res, 200, { text });
      return;
    }
    if (url.pathname === '/instana/bundle') {
      const bundle = await collectInstanaBundle(namespace, pod);
      sendJson(res, bundle.complete ? 200 : 207, bundle);
      return;
    }
    sendJson(res, 404, { error: 'Unknown route. Available: /health, /logs, /status, /instana, /instana/bundle' });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==================================================================');
  console.log(' Incident Console — companion server');
  console.log('==================================================================');
  console.log(` Listening on: http://127.0.0.1:${PORT}  (local only, not exposed externally)`);
  console.log(` Token:        ${TOKEN}`);
  console.log('');
  console.log(' Paste this token into the Incident Console UI (Companion server panel).');
  console.log(' Requires kubectl in PATH with active cluster access.');
  console.log(' Press Ctrl+C to stop the server.');
  console.log('==================================================================');
});
