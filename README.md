# Incident Toolkit — Instana / ES / ClickHouse / Kafka

## Version 1.3.4 — large-bundle and secret-redaction hardening

- Browser uploads are bounded to 25 MB per file and 50 MB per selection, with
  an actionable message to trim logs to the incident window instead of risking
  an unresponsive on-call UI.
- Export redaction now also covers bearer tokens, JWTs, and passwords embedded
  in URLs.
- Release archives are clean source distributions: no `node_modules`, macOS
  metadata, or already-applied patch files.

## Version 1.3.3 — JSON-first Elasticsearch and companion hardening

- The companion server now requests structured Elasticsearch cluster/shard
  JSON, and the UI safely parses the labelled combined response.
- Companion auto-fetch aborts after 50 seconds instead of leaving the incident
  UI indefinitely disabled when kubectl or the local server hangs.
- Local incident-evidence responses use `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.

## Version 1.3.2 — urgent ClickHouse severity corrections

- An active ClickHouse readonly replica is now critical because writes may be
  affected; the verdict no longer says `Stable — you have time`.
- A probe failure becomes critical only when container-kill/restart evidence
  proves an active datastore recovery loop. An isolated probe warning remains
  a warning, avoiding unnecessary escalation.

## Version 1.3.1 — release hardening and real-browser verification

This release removes the duplicated repository copy, runs the real-browser E2E
suite in GitHub Actions, and documents the complete verification gate.

## Version 1.3.0 — security & accessibility hardening, structured ClickHouse parsing

Follow-up to the 1.2.0 → `4e0e70b` "Security & accessibility hardening" audit
(244/244 tests, 0 `npm audit` vulnerabilities). Addresses the review's
remaining findings:

- **ClickHouse status is now parsed structurally, not just heuristically.**
  The companion server requests `FORMAT JSON` (was `FORMAT PrettyCompact`)
  for the parts/detached-parts/replicas queries; `incident-console.html`
  parses the real `data` rows (exact `database.table`, part name, and a real
  `is_readonly` boolean) instead of guessing from ASCII box-drawing text.
  Manually pasted `FORMAT PrettyCompact` output still works — the old parser
  is kept as a fallback. Fixed a related bug this uncovered: the previous
  `/readonly/i` text match could false-positive on the JSON key name
  `is_readonly` even when its value was `0`.
- **Real headless-Chrome E2E tests added** (`tests/e2e.test.js`,
  `npm run test:e2e`) covering things jsdom cannot: actual computed layout
  for the sticky verdict/quick-actions bars (no overlap), a real mobile
  viewport (390×844) for the modal, real CSS repaint on theme toggle, browser
  clipboard-API behavior, and a 5000-line log paste. Kept separate from
  `npm test` since it needs a local Chrome/Chromium — see the file header for
  setup.
- **`package.json` scripts split out** per test file
  (`test:security`, `test:accessibility`, `test:unit`, `test:companion-server`,
  `test:e2e`) alongside the existing combined `test`.
- Kafka status parsing remains heuristic (`kafka-topics.sh --describe` has no
  built-in JSON output) — tracked as a known limitation below.

## Version 1.2.0 — semantic evidence model, structural gaps closed

Found and fixed via a series of live simulated incidents (not code review —
actually running the tool end-to-end against realistic, messy scenarios):

- **Safety-gate evidence checks are now negation-aware**, not bare keyword
  presence. The replica/shard, backup/snapshot, and Instana version checks
  previously matched on any mention of the relevant word — "no backup
  exists" or "Version: unknown" could satisfy them purely by containing
  "backup"/"version". They now distinguish CONFIRMED (a positive-health word
  actually co-occurs, with no negation between them), NOT-APPLICABLE (an
  explicit "single-node"/"not configured" statement), UNHEALTHY (a
  negative-health word — still opens the gate for human review, but visibly
  flagged, not silently identical to "confirmed"), and UNCLEAR (stays
  blocked — this is where the old exploit lived).
- **A raw `kubectl get pods` line is now parsed for READY/RESTARTS**, not
  just matched against known phrases like "CrashLoopBackOff". A pod showing
  `0/1` ready with double-digit restarts previously produced a "✓ Stable —
  no critical findings" verdict if STATUS happened to read "Running" in the
  gap between crash-loop restarts.
- **A pasted status field that is actually a failed command's error output**
  (auth/RBAC/network/wrong-container-name) is now called out explicitly,
  distinct from "no evidence pasted" — previously both looked identical.
- Evidence-highlight formatting characters no longer leak into Markdown/
  HTML/postmortem exports (they're still preserved in JSON/Handover, which
  need them to re-render highlighting after import).
- `recommend-agent.sh` no longer produces a `dir//file.txt`-style double
  slash when its report-directory argument has a trailing slash (as
  tab-completion always adds).

See `git log` for full commit-by-commit detail — each fix above was found by
actually role-playing a specific incident scenario through the real UI/CLI,
not by reading the source.

## Version 1.1.0 — structured Instana evidence bundle

The companion server now exposes `/instana/bundle`. It runs a fixed,
read-only Instana/Kubernetes checklist and returns each check separately with
its duration, result, collection timestamp, schema version, and a `complete`
flag. Partial evidence is returned as HTTP `207`, so missing permissions or
unavailable tools cannot be mistaken for healthy output.

The bundle collects `stanctl status`, `stanctl unit status`, current context,
nodes, namespaces, datastore resources, pod description, events, previous logs,
and current logs. It never executes restart, delete, scale, `kubectl exec`, or
other mutation commands. Recovery commands remain recommendations subject to
human review and the existing safety gates.

## Safety model

Recommendations are not guarantees. Mutating actions are marked as
review-required; actions with missing status, replica/ISR, backup or version
evidence are blocked in the console. Risky actions show a rollback plan and
require a reviewer plus a second approver. Destructive actions remain behind
the `CONFIRM` gate. The toolkit never executes recovery commands itself:
collect evidence, preview the procedure, verify the exact target and version,
preserve a rollback point, then execute manually and run the after-action checks
(`stanctl unit status`, pod readiness, datastore health and a customer-visible
smoke check).

A toolkit for investigating and recovering from an Instana self-hosted backend incident
where an Elasticsearch, ClickHouse, or Kafka datastore pod is down or corrupted. Built iteratively through conversation — from
bash scripts to a web UI with a companion server. This README explains how the pieces
fit together and in what order to use them during a real incident.

## Who this is for

Built for a team that **has no direct access to the customer's cluster** — you only
get the logs a self-hosted customer sends when their Instana datastore pod
(Elasticsearch/ClickHouse/Kafka) crashes and takes the whole backend down or degrades
ingest/query paths. You know
Kubernetes, but you're not experts in the internals of these datastore systems. The
tool is focused on the two questions that actually matter at that moment: **what
broke**, and **what am I now allowed to tell the customer to do without making it worse**.

That's why the default view is reduced to two tabs — **Findings** and
**Recommendations**. Everything else (diagrams, snapshot comparison, timeline, custom
rules, history) is behind the **"Advanced"** button in the tab bar — useful when you
need it, but it doesn't clutter the default view.

### Core workflow when you get a ticket

0. **Don't know yet what's broken?** Click **"📋 Just starting? Get the 'ask for
   everything' message"** at the top of the sidebar — before any analysis. It asks
   the customer for logs *and* status output for all three systems in one message,
   so you're not going back and forth once you find out which one applies. This is
   the single biggest time-saver: every round-trip with the customer costs minutes
   to hours during a real incident, not seconds.
1. For Instana self-hosted cases, choose **Instana** mode if you have `stanctl`,
   namespace, pod, PVC, or unit-status context. The tool maps the incident to the
   underlying datastore and adds Instana-specific impact, escalation, and after-action
   verification gates on top of the generic datastore analysis.
2. Paste the logs the customer sent you (status output is **optional** — you'll
   rarely have it, and that's fine).
3. Analyze. At the very top you get an **incident stage stepper** (Diagnosing →
   Waiting on customer → Verifying → Resolved) so you don't lose track of where you
   are after an interruption — it advances on its own when you copy a customer
   message, and you can always click a stage to override it manually.
4. Right below that, an **incident verdict** — Stable / Act now / Urgent — telling
   you at a glance whether this needs action right now or can wait, plus a one-click
   **"Send acknowledgment now"** message so the customer isn't left hanging while you
   investigate, an **"✅ Check if this worked"** button once there's a fix to verify,
   and an **"Escalation message"** button when the situation is beyond what the tool
   can safely guide you through alone.
5. Right below that, a **"STOP — before you touch anything"** checklist (don't
   restart the pod, don't delete anything, capture current state first) —
   dismissible, shown once per incident.
6. **Kubernetes layer first**: every analysis starts with a cross-cutting pass
   over the pasted data for pod-level signals — `CrashLoopBackOff`, `OOMKilled`
   (exit 137), `Evicted`, `ImagePullBackOff`, `FailedMount`/`FailedAttachVolume`,
   liveness-probe kills, node pressure. Those findings and their recommendations
   are listed **before** the datastore-internal ones, because "why won't the pod
   even run" has to be answered before "what's wrong inside the datastore". This
   is why the first-contact message asks for `kubectl describe pod` and
   `kubectl get events` alongside the logs — the *reason* a pod stopped usually
   lives there, not in the datastore's own log. A classic trap this catches: a
   liveness probe killing a datastore *mid-recovery*, creating a restart loop
   that looks like corruption but is self-inflicted.
7. **Findings** will quote the exact log line that proves each finding — you
   don't have to manually scroll through the whole log looking for what it refers to.
8. If you don't have status output, you'll get a yellow warning at the top of
   **Recommendations** with a ready-made message asking the customer for exactly that
   data (e.g. `_cat/shards?v` for ES) — without it, the next step can't be suggested
   with confidence.
9. Once you have both pieces of data, every recommendation has a
   **"📋 Message for the customer"** button — an already-written message
   (prerequisites + command + explanation of consequences) ready to copy-paste into a
   ticket/chat, since the *customer* runs the command, not you. The message is written
   for someone with **zero prior experience** with the database: any jargon term used
   (shard, replica, ISR, partition...) is automatically explained in plain language,
   and a link to the official documentation is included for anyone who wants more detail.
10. The risk of each recommendation is clearly labeled (SAFE / RISK / PERMANENT LOSS)
   — that answers "when am I allowed to use this". Every finding also carries a
   **confidence badge** (HIGH / MEDIUM / LOW) — a direct read from structured status
   data or an unambiguous error signature is HIGH, a broader text-pattern match is
   MEDIUM, and an absence check ("no trace found") is LOW, since a heuristic tool not
   finding a pattern is not proof the problem isn't there.
11. A **PERMANENT LOSS** command is never one click away from being copied — it's
   blurred behind a "type CONFIRM to reveal" gate. Small deliberate friction, placed
   exactly where a rushed on-call engineer is most likely to copy the wrong thing.
12. After the customer replies, click **"✅ Check if this worked"** in the verdict
    banner and paste just the *new* status output — the tool already has what you
    started with, so you don't need to re-paste it. You get a plain verdict (Looks
    improved / Looks worse / Mixed / No change) plus the detail table, and the stage
    stepper advances to "Verifying" automatically.

Note on accuracy: none of these shortcuts skip a check to save time — they reduce
*round-trips*, not verification. The tool never recommends a fix without the data
it needs; if that data is missing, it tells you what to ask for instead of guessing.

## What's what

```
incident-toolkit/
├── incident-console.html      # Main tool: web UI for analysis, recommendations, diagrams
├── companion-server.js        # Local server for auto-fetch (no copy-paste)
├── scripts/
│   ├── diag-agent.sh          # CLI: collects diagnostics via kubectl (read-only)
│   ├── recommend-agent.sh     # CLI: generates suggested fixes from a diag-agent report
│   ├── db-incident.sh         # CLI: orchestrator that chains the two above into one call
│   └── db-incident-command.md # Claude Code slash command (/db-incident) using the orchestrator
├── tests/                     # Test suite (jsdom + integration tests)
├── package.json
└── README.md
```

## Two ways to work — CLI or Web UI

Both paths work independently; use whichever suits you.

### Path A — CLI (terminal, Claude Code)

```bash
chmod +x scripts/*.sh
./scripts/db-incident.sh <namespace> <pod-name> <elasticsearch|clickhouse|kafka|auto>
```

For Instana self-hosted cases you can pass `instana`; the collector gathers
`stanctl status`, `stanctl unit status`, Instana namespaces, StatefulSet/Pod/PVC
state, pod describe, events, and logs, then auto-detects the underlying datastore:

```bash
./scripts/db-incident.sh <instana-datastore-namespace> <pod-name> instana
```

This runs `diag-agent.sh` (collects logs/status via kubectl, all read-only), then
`recommend-agent.sh` (generates suggested fixes with prerequisites and consequences),
and leaves a report in `diag-report-<pod>-<timestamp>/`. `recommend-agent.sh`
starts with a **step 0 pod-layer check** (same signals as the web UI: OOMKilled,
Evicted, FailedMount, ImagePullBackOff, probe kills) over the describe/events
files, printed before any datastore-internal findings — resolve those first.

Both scripts explicitly detect when `kubectl exec` fails (pod unreachable /
CrashLoopBackOff — the exact situation you're usually running this in) and say so in
plain text, instead of silently treating an error message as "no problems found."
`recommend-agent.sh` also refuses to trust a data file that looks like a raw kubectl
error rather than real query output, marking that signal `unknown` instead of guessing.

For Claude Code: copy `scripts/db-incident-command.md` to
`~/.claude/commands/db-incident.md` and invoke `/db-incident <namespace> <pod>`
directly from the conversation.

### Path B — Web UI (`incident-console.html`)

Open the file in a browser (double-click, no server needed). You can feed it data
in 3 ways:

1. **Manual paste** — paste command output into the two textarea fields
2. **Upload/drag & drop** — drag in files (recognizes filenames from the
   `diag-agent.sh` convention, e.g. `03-logs-previous.txt`, `11-es-shards.txt`, or
   sniffs the content if the name is generic)
3. **Companion server (least manual work)** — see below

The UI then gives you: findings with parsed tables, immediate + preventive
recommendations with a checklist, topology diagrams, snapshot comparison
(before/after recovery), an event timeline, and the ability to add your own
detection rules.

After an analysis the **sidebar auto-collapses** so findings/recommendations get
the full width — the **⇤/⇥ Inputs** header button or "New incident" brings it
back. The **incident ID in the header is click-to-edit**: when two people work
the same ticket, click it and type the shared ticket number so "which incident
are you in?" stops being a question. **Clear** asks for a second click only when
there's an analysis or typed input to lose — an empty console clears instantly.

The ☀/☾ button in the header switches between light/dark theme (defaults to **light**).
The theme choice is memory-only for the current session, not remembered between page loads.
Hovering over badges, risk stamps, stage-stepper steps, and the header signal dot shows a
plain-language explanation of what that piece means — no digging through this README needed
mid-incident. Tooltips are positioned by JS and clamped to the viewport (not a fixed CSS
direction), so they stay fully on-screen regardless of where the trigger sits — including
inside the scrollable sidebar, where a static "always open this way" tooltip would get
clipped for triggers near one edge or the other.

Everything is processed **locally in the browser** — nothing is sent to a server
(unless you explicitly use the companion server, which itself only runs on `localhost`).

### Companion server — a third, "no copy-paste" option

**Why you have to start this yourself:** `incident-console.html` is just a web page —
browsers deliberately block any web page's JavaScript from launching programs on your
machine (imagine if any website you opened could run arbitrary software; that's exactly
what this restriction prevents). So the companion server is a genuinely separate process
you start once, on purpose, before it can talk to the page. There's no way around this
that doesn't involve turning off a core browser security feature.

Three ways to start it — pick whichever fits your workflow:

```bash
node companion-server.js        # default port 8787
# or:
npm start                       # same thing, if you prefer npm scripts
```

Or double-click a launcher for your OS (does the same `node companion-server.js` for you):
- **macOS:** `start-companion-server.command` (first run: right-click → Open, since
  macOS blocks unsigned scripts on a plain double-click the first time)
- **Windows:** `start-companion-server.bat`
- **Linux:** `start-companion-server.sh` (most file managers require running this from
  a terminal rather than double-clicking, for the same security-sandboxing reason as above)

Whichever way you start it, leave the terminal/window open while you use the tool —
closing it stops the server. It prints a token on startup. In the Incident Console UI,
open the "Companion server" panel, enter namespace/pod/token, click "Fetch automatically" —
the logs/status fields fill themselves in via `kubectl` calls. In **Instana** mode,
the companion also calls the read-only `/instana` collector, which includes `stanctl`
status/unit status when `stanctl` is available locally.

**Security notes:**
- The server listens exclusively on `127.0.0.1` — not reachable from the network.
- Every request requires the exact token (`X-Companion-Token` header).
- Only predefined, read-only commands are run (`kubectl logs`,
  `kubectl exec ... curl/clickhouse-client/kafka-topics.sh`), never arbitrary ones.
- namespace/pod parameters are strictly validated with a regex and passed as
  separate arguments (`execFile`), not through a shell — no command injection risk.

## Order of operations during a real incident

1. Pod crashed → run `diag-agent.sh` (or the companion server + UI) to collect
   logs/status **before** touching anything manually.
2. Review **Findings** — what was detected (corruption, disk full, OOM, RF=1...).
3. Review **Recommendations** — immediate actions first, always check the
   prerequisites before running any command. Nothing runs automatically — everything
   is copy-paste for manual execution.
4. Use the **checklist** to mark what's done and who's responsible.
5. After a recovery step, use the **Comparison** tab to compare status before/after
   and confirm the state was actually fixed.
6. Finally, export a **Markdown/HTML report** or **ticket text** for the post-mortem.
7. If the cause is something that could recur, flag **preventive measures** and track them.

## Limitations (be aware of these)

- **Heuristic analysis, not structured parsing** — patterns are regex-based on
  common ES/CH/Kafka log messages, not a real log parser. If a version starts
  logging a corruption message in a new format, or the log format is
  non-standard, the tool can miss it — you'd see "No trace of corruption"
  with a **LOW confidence** badge, which is honest about the uncertainty but
  doesn't eliminate it. Add your own pattern in the "Rules" tab when you hit
  this. This ceiling is a deliberate trade-off, not an oversight: the
  alternative would be either a real parser toolchain (a build step) or
  sending logs to an external service for analysis — both break the "single
  file, double-click, works fully offline" property that's the actual point
  of the tool. A tool that sends your logs somewhere for smarter analysis
  would score higher on accuracy and lower on "safe to use on customer data
  you can't move."
- **Single HTML file, not a modular codebase** — everything lives in one
  ~2,500-line file. `SYSTEM_REGISTRY` keeps adding a new datastore to one
  bounded spot instead of four scattered ones, but the code itself still
  can't be split into separate modules, tested in isolation, or reused
  elsewhere. This isn't for lack of trying: native ES modules
  (`<script type="module">` + `import`) would be the obvious no-build-step
  way to split the file, but **browsers block module `fetch` over the
  `file://` protocol** — a page opened by double-clicking couldn't load its
  own imports. Splitting the file would mean requiring a local static server
  just to open the tool, which defeats the same goal the companion server was
  built to avoid for the main UI. A bundler (webpack/esbuild/rollup) sidesteps
  that, but pulls in `node_modules` and a build step for what's meant to be a
  zero-install tool. Both limitations above are the direct, unavoidable cost
  of the offline/zero-install design goal — not gaps to eventually close.
- **Not a substitute for human judgment** — every suggested command has a clearly
  labeled risk (SAFE / RISK / PERMANENT LOSS) and prerequisites; always check them
  before running.
- **JSON/ECS support is partial** — it recognizes common fields (`@timestamp`,
  `log.level`, `error.type`/`message`), but unusual custom log formats may slip through.
- **History is session-only** — Incident Console does not use persistent browser
  storage (intentionally, due to constraints of the environment it runs in); export
  JSON if you want to save an analysis and import it back later.
- **Kafka status parsing is still heuristic** — `kafka-topics.sh --describe`
  has no built-in JSON output (unlike ES's `_cat/shards?format=json` and
  ClickHouse's `FORMAT JSON`, both of which the tool now prefers), so
  `parseKafkaTopics()` stays regex-based on the plain-text describe output.

### Troubleshooting

- **`npm install` prints a warning about an unknown `http-proxy`
  configuration.** This is not from this repo — there's no `.npmrc` here and
  the only `http-proxy`-named package in `package-lock.json` is
  `http-proxy-agent`, a normal transitive dependency of `puppeteer-core` used
  for actual HTTP proxying to Chrome's DevTools protocol, not an npm config
  key. The warning comes from a local/global `.npmrc` (often a leftover
  `http-proxy=` entry — newer npm expects `proxy=` instead). Check
  `npm config get http-proxy` and your global `~/.npmrc`; it's safe to ignore
  otherwise.

## Testing

```bash
npm install            # installs jsdom + puppeteer-core (dev dependencies)
npm test                     # runs the jsdom suite (unit + companion-server + security + accessibility)
npm run test:unit            # incident-console.test.js only
npm run test:companion-server
npm run test:security
npm run test:accessibility
npm run test:e2e             # real headless-Chrome checks — needs a local Chrome/Chromium, see tests/e2e.test.js
```

As of v1.3.4 the automated verification gate contains 264 tests total:
255 jsdom/integration tests (216 UI + 16 companion-server + 14 security + 9
accessibility) and 9 real-browser E2E tests. GitHub Actions installs Chrome and
runs both `npm test` and `npm run test:e2e` on every push and pull request.

The test suite covers (`tests/`):
- `incident-console.test.js` — 216 tests against `incident-console.html` via jsdom:
  analysis for all 3 systems, table parsing, checklist/progress, timeline,
  JSON/ECS logs, diff comparison, custom rules (including the ReDoS warning),
  redacting sensitive data, upload/auto-classification of files, history, export,
  companion fetch (mock), light/dark theme toggle, log quotes (evidence), customer
  message per recommendation, requesting more data when status is missing,
  hiding/revealing the advanced tabs, the incident verdict banner (urgency +
  escalation), the "stop before you touch anything" safety checklist, the glossary
  and documentation links in customer messages, the "first contact" message, the
  "did it work?" quick check, and the incident stage stepper (including
  auto-advance on copying a customer message), the auto-collapsing sidebar
  (analysis collapses it, "New incident" restores it), the muted prerequisite
  command block (visually distinct from the main command so the wrong one
  can't be copied in a rush), the two-click Clear confirmation (armed only
  when there's actually something to lose), the click-to-edit incident ID
  (shared ticket name propagates to History), confidence badges on findings,
  the type-to-confirm gate on PERMANENT LOSS commands, ES multi-index grouping
  (a corrupt/unassigned incident spanning several indices gets a targeted
  recommendation per index, not just the first one), that analysis errors
  surface as a visible finding instead of failing silently, that copy/unlock
  buttons work via delegated `data-copy`/`data-unlock` attributes with no
  `window.*` globals involved, JS-positioned/viewport-clamped tooltips (including
  touch/tap support, not hover-only), that the status-output reference commands
  are real selectable/copyable text next to the field (not trapped inside a
  `placeholder=""` that looks the same but can't be copied), that each export
  click gets a unique filename (a second export no longer silently overwrites
  the first), the Timeline filters out routine/info log noise — falling back
  to showing everything only if literally nothing looks like an error or
  warning — the Kafka "remove corrupt segment" recommendation is a
  real, copy-paste-ready `rm` command with the exact path parsed from the
  pasted logs (with a clearly-labeled fallback, not a silent wrong guess,
  when no path can be parsed), and structured ClickHouse `FORMAT JSON` parsing
  (exact table/part names, real `is_readonly` booleans, with a fallback to the
  old ASCII-table heuristic for manually pasted `FORMAT PrettyCompact` output).
- `companion-server.test.js` — 15 integration tests: a **real HTTP server** started
  as a child process with a mock `kubectl` (`tests/fixtures/mock-kubectl`), checking
  auth (401/400), injection protection, CORS scoping (`null`, not `*`), and the
  exact commands for all 4 system types (including that ClickHouse now requests
  `FORMAT JSON`).
- `security.test.js` — 14 XSS/injection tests across Instana, Kubernetes, uploaded
  filenames, and custom rules.
- `accessibility.test.js` — 9 tests: ARIA roles/live-regions, tab order, and modal
  focus management.
- `e2e.test.js` — real headless-Chrome checks: sticky verdict/quick-actions bars
  don't overlap in real computed layout, the modal fits and gets real focus on a
  390×844 mobile viewport, theme toggle actually repaints computed CSS, the
  clipboard API completes under real browser permissions, and a 5000-line log
  paste doesn't overflow the layout.

Whenever you change `incident-console.html` or `companion-server.js`, run `npm test`
before considering the change done — this is the "safety net" that keeps a silent
regression from slipping through.

## Contributing / extending

- New detection regex pattern → add it to the `analyzeElasticsearch`/`analyzeClickHouse`/
  `analyzeKafka` functions in `incident-console.html`, or use the UI's "Rules" tab
  to add one quickly without touching code (exportable/importable as JSON, shareable
  with the team).
- **New system type** (e.g. MongoDB, Cassandra) → write an `analyzeX(logs, status)`
  function that returns `{ findings, recs, preventive, table, flags }`, then add one
  entry to `SYSTEM_REGISTRY` in `incident-console.html` (detection regex + the
  function + the status-request command). That single array is deliberately the
  only place you need to touch — detection, the analyze dispatch, and the
  "ask for everything" / info-request messages all read from it. A topology
  diagram and a companion server endpoint for the new system are still separate,
  smaller follow-ups, not prerequisites.
  This is a single-file, offline-first tool by design (no build step, no dynamic
  code loading) — a true plugin loader would mean either a build pipeline or
  `eval`-ing pasted code, both of which work against that goal. The registry is
  the pragmatic middle ground: one clearly-bounded edit instead of four scattered
  ones.
- Every change must pass `npm test` before shipping.
