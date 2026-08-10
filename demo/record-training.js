#!/usr/bin/env node
/*
 * record-training.js — records the full TRAINING video for incident-console.html.
 *
 * Longer than the demo: Part 1 walks the exact urgent-incident flow step by
 * step; Part 2 tours every available option (Advanced tabs, custom rules,
 * comparison, timeline, diagrams, history, exports, theme).
 *
 * Deliberately self-contained (helpers duplicated from record-demo.js) so the
 * already-shipped demo script stays untouched.
 *
 * Usage:  node demo/record-training.js [path-to-chrome]
 * Output: demo/incident-console-training.mp4
 * Narration: same Piper setup as record-demo.js (demo/tts/*.onnx), optional.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const CHROME = process.argv[2] ||
  execSync(`find "${process.env.HOME || '/home/claude'}/.cache/puppeteer/chrome" -name chrome -type f 2>/dev/null | head -1`).toString().trim();
if (!CHROME) { console.error('Chrome binary not found — pass its path as an argument.'); process.exit(1); }

const FRAMES = path.join(__dirname, 'frames-training');
const OUT = path.join(__dirname, 'incident-console-training.mp4');
const FPS = 8;

const PIPER_MODEL = process.env.PIPER_MODEL || path.join(__dirname, 'tts', 'en-us-ryan-high.onnx');
let NARRATE = false;
try { execSync('which piper', { stdio: 'ignore' }); NARRATE = fs.existsSync(PIPER_MODEL); } catch (e) {}
const AUDIO_DIR = path.join(__dirname, 'audio-training');
const sceneAudio = [];
let sceneStartFrame = 0, sceneDur = 0;

function synth(text, idx) {
  const wav = path.join(AUDIO_DIR, `s${String(idx).padStart(2, '0')}.wav`);
  execSync(`piper --model "${PIPER_MODEL}" --output_file "${wav}"`, { input: text });
  const dur = parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${wav}"`).toString());
  return { wav, dur };
}

let n = 0;
async function snap(page, holdFrames = 1) {
  for (let i = 0; i < holdFrames; i++) {
    await page.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(5, '0')}.png`) });
  }
}

async function padScene(page) {
  if (!NARRATE) return;
  const need = Math.ceil((sceneDur + 0.5) * FPS) - (n - sceneStartFrame);
  if (need > 0) await snap(page, need);
}

async function say(page, text) { // caption + narration + scene bookkeeping
  await padScene(page);
  if (NARRATE) {
    const a = synth(text, sceneAudio.length);
    sceneAudio.push({ startFrame: n, wav: a.wav, dur: a.dur });
    sceneStartFrame = n; sceneDur = a.dur;
  }
  await page.evaluate(t => {
    let c = document.getElementById('demo-caption');
    if (!c) {
      c = document.createElement('div');
      c.id = 'demo-caption';
      c.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
        'background:rgba(10,13,17,.92);color:#e8f0e8;font:600 16px/1.4 system-ui;' +
        'padding:12px 24px;border-top:2px solid #4ade80;text-align:center;';
      document.body.appendChild(c);
    }
    c.textContent = t;
  }, text);
}

async function ensureCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;z-index:100000;width:18px;height:18px;' +
      'border-radius:50%;background:rgba(74,222,128,.85);border:2px solid #fff;' +
      'box-shadow:0 0 10px rgba(74,222,128,.8);pointer-events:none;left:640px;top:400px;' +
      'transform:translate(-50%,-50%);';
    document.body.appendChild(c);
  });
}

async function moveCursorTo(page, selector, frames = 4) {
  const box = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) throw new Error('not found: ' + selector);
  const from = await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    return { x: parseFloat(c.style.left) || 640, y: parseFloat(c.style.top) || 400 };
  });
  for (let i = 1; i <= frames; i++) {
    const t = i / frames, e = t * t * (3 - 2 * t);
    await page.evaluate((x, y) => {
      const c = document.getElementById('demo-cursor');
      c.style.left = x + 'px'; c.style.top = y + 'px';
    }, from.x + (box.x - from.x) * e, from.y + (box.y - from.y) * e);
    await snap(page);
  }
  return box;
}

async function clickWithCursor(page, selector) {
  const box = await moveCursorTo(page, selector);
  await page.evaluate(() => { document.getElementById('demo-cursor').style.background = 'rgba(255,255,255,.95)'; });
  await snap(page);
  await page.mouse.click(box.x, box.y);
  await page.evaluate(() => { document.getElementById('demo-cursor').style.background = 'rgba(74,222,128,.85)'; });
}

async function closeAnyModal(page) {
  await page.evaluate(() => { const w = document.getElementById('modalWrap'); if (w) w.innerHTML = ''; });
  await snap(page, 2);
}

async function setValue(page, selector, value) { // for long text — instant, with input event
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
}

const GREEN_STATUS = `{"cluster_name":"es","status":"green","number_of_nodes":3,"unassigned_shards":0}
index  shard prirep state      docs   store node
orders 2     p      STARTED    18234  212mb es-data-0
orders 2     r      STARTED    18234  212mb es-data-1`;

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  if (NARRATE) { fs.rmSync(AUDIO_DIR, { recursive: true, force: true }); fs.mkdirSync(AUDIO_DIR, { recursive: true }); }
  console.log(NARRATE ? 'Narration: ON' : 'Narration: OFF (silent captioned video)');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, '..', 'incident-console.html'));
  await new Promise(r => setTimeout(r, 400));
  await ensureCursor(page);

  // ======================= PART 1 — THE URGENT FLOW ========================
  await say(page, 'Incident Console training. Part one: the exact flow when the Instana backend is down because a datastore pod stopped.');
  await snap(page, 4);

  await say(page, 'Everything runs locally in your browser and everything it suggests is read-only until you decide otherwise. It never executes anything for you.');
  await snap(page, 4);

  await say(page, 'Minute zero: you don\u2019t know yet which datastore is broken. Click the first-contact button to get one message that asks the customer for logs, describe and status for all three systems at once.');
  await clickWithCursor(page, '#firstContactBtn');
  await snap(page, 6);
  await say(page, 'One copy-paste instead of three round-trips. It also asks for kubectl describe and events — the reason a pod stopped usually lives there, not in the logs.');
  await snap(page, 4);
  await closeAnyModal(page);

  await say(page, 'The left panel is where data comes in. Pick the system manually, or leave it on Auto — pasted data is type-detected. The help panel lists the exact commands to request for each system.');
  await clickWithCursor(page, '#helpPanel summary');
  await snap(page, 8);
  await clickWithCursor(page, '#helpPanel summary');

  await say(page, 'If you can reach the cluster yourself, the companion server can fetch logs and status automatically — no copy-paste at all. Start it locally with node companion server, then click Fetch.');
  await clickWithCursor(page, '#companionPanel summary');
  await snap(page, 8);
  await clickWithCursor(page, '#companionPanel summary');

  await say(page, 'For this training we load the built-in Elasticsearch example — a pod that crashed with segment corruption.');
  await clickWithCursor(page, '#sampleLinks button[data-s="elasticsearch"]');
  await snap(page, 6);

  await say(page, 'Click Analyze. The input panel collapses automatically so the results get the whole screen — the Inputs button in the header brings it back at any time.');
  await clickWithCursor(page, '#analyzeBtn');
  await new Promise(r => setTimeout(r, 500));
  await ensureCursor(page);
  await snap(page, 6);

  await say(page, 'Read top-down. The verdict banner tells you how urgent this is and whether a safe path exists. The stage stepper tracks where you are: diagnosing, waiting on the customer, verifying, resolved.');
  await snap(page, 6);

  await say(page, 'Send acknowledgment now gives you a ready message so the customer immediately knows you\u2019re on it — buying you quiet time to actually diagnose.');
  await clickWithCursor(page, '#ackNowBtn') .catch(()=>{});
  await snap(page, 6);
  await closeAnyModal(page);

  await say(page, 'The STOP banner is there for the panic minute: don\u2019t restart the pod yet, don\u2019t delete anything, capture the current state first. Restarting too early destroys the evidence you need.');
  await page.evaluate(() => { const b = document.getElementById('stopBannerWrap'); if (b) b.scrollIntoView({ block: 'start' }); });
  await snap(page, 6);

  await say(page, 'Findings. Each one has a severity, a confidence level, and — most importantly — the exact log line that proves it. You never have to trust the tool blindly.');
  await page.evaluate(() => { const f = document.getElementById('findingsList'); if (f) f.scrollIntoView({ block: 'start' }); });
  await snap(page, 8);

  await say(page, 'Now the Recommendations tab — the heart of the tool in an urgent situation.');
  await clickWithCursor(page, '.tab[data-tab="preporuke"]');
  await snap(page, 6);

  await say(page, 'Every recommendation has four parts: a risk stamp — safe, risk, or permanent loss. Prerequisites to check before running anything. The command itself. And the possible consequences of running it, in plain language.');
  await snap(page, 6);

  await say(page, 'Notice the two blocks. The gray dashed one labeled check first is the read-only prerequisite check. The green one is the actual fix. They look different on purpose, so under pressure you can\u2019t copy the wrong one.');
  await page.evaluate(() => { const p = document.querySelector('#recsList pre.cmd-prereq'); if (p) p.scrollIntoView({ block: 'center' }); });
  await snap(page, 8);

  const hasGate = await page.evaluate(() => !!document.querySelector('.cmd-gate-input'));
  if (hasGate) {
    await say(page, 'Commands that can permanently destroy data are locked. You must type CONFIRM to even see them — a deliberate speed bump exactly where speed is dangerous.');
    await page.evaluate(() => document.querySelector('.cmd-gate-input').scrollIntoView({ block: 'center' }));
    await snap(page, 4);
    await moveCursorTo(page, '.cmd-gate-input');
    await page.evaluate(() => document.querySelector('.cmd-gate-input').focus());
    await page.keyboard.type('CONFIRM', { delay: 60 });
    await page.evaluate(() => document.querySelector('.cmd-gate-input').dispatchEvent(new Event('input', { bubbles: true })));
    await snap(page, 3);
    await clickWithCursor(page, '.cmd-gate-btn');
    await snap(page, 8);
  }

  await say(page, 'Under every recommendation there\u2019s a ready-to-send customer message with the command and what to send back — and a checklist row: mark it done, type who\u2019s on it, and the progress bar updates for the whole incident.');
  const hasCheck = await page.evaluate(() => !!document.querySelector('#recsList .rec-done'));
  if (hasCheck) {
    await clickWithCursor(page, '#recsList .rec-done');
    await moveCursorTo(page, '#recsList .rec-assignee');
    await page.evaluate(() => document.querySelector('#recsList .rec-assignee').focus());
    await page.keyboard.type('Miodrag', { delay: 50 });
    await snap(page, 8);
  }

  await say(page, 'Working the same ticket as a colleague? Click the incident ID in the header and type the shared ticket number — it propagates to history, so which incident are you in stops being a question.');
  await clickWithCursor(page, '#incidentId');
  const hasIdInput = await page.evaluate(() => !!document.querySelector('#incidentId input'));
  if (hasIdInput) {
    await page.evaluate(() => { document.querySelector('#incidentId input').value = ''; });
    await page.keyboard.type('TICKET-4711', { delay: 50 });
    await page.keyboard.press('Enter');
    await snap(page, 6);
  }

  await say(page, 'The customer replied with new status output? Click Check if this worked, paste it, and the tool compares against where you started.');
  const hasQuick = await page.evaluate(() => !!document.getElementById('quickCheckBtn'));
  if (hasQuick) {
    await clickWithCursor(page, '#quickCheckBtn');
    await snap(page, 4);
    await setValue(page, '#quickCheckInput', GREEN_STATUS);
    await snap(page, 3);
    await clickWithCursor(page, '#quickCheckRun');
    await snap(page, 10);
    await say(page, 'Green, shards started — the fix worked, and the stage moves to verifying. If it hadn\u2019t improved, you\u2019d see exactly what\u2019s still wrong.');
    await snap(page, 6);
    await closeAnyModal(page);
  }

  await say(page, 'When it\u2019s over: Generate ticket text builds the whole write-up for your ticketing system, and the export buttons save the incident as Markdown, HTML or JSON. Redact sensitive data stays on by default — hostnames and IPs are masked in exports.');
  await clickWithCursor(page, '#ticketBtn').catch(()=>{});
  await snap(page, 8);
  await closeAnyModal(page);
  await moveCursorTo(page, '#exportMd');
  await snap(page, 4);

  // ======================= PART 2 — ALL THE OPTIONS ========================
  await say(page, 'Part two: everything else the tool can do. Click Advanced to reveal the remaining tabs: Diagram, Comparison, Timeline, Rules, and History.');
  await clickWithCursor(page, '#toggleAdvancedBtn');
  await snap(page, 6);

  await say(page, 'Diagram draws the cluster topology from the status output, plus a decision-path diagram of how the tool reached its recommendation.');
  await clickWithCursor(page, '.tab[data-tab="dijagram"]');
  await snap(page, 12);

  await say(page, 'Timeline reconstructs the order of events from every timestamp found in the logs — useful for the post-mortem question: what happened first.');
  await clickWithCursor(page, '.tab[data-tab="linija"]');
  await snap(page, 10);

  await say(page, 'Comparison diffs two status outputs — before and after a fix — and highlights what changed.');
  await clickWithCursor(page, '.tab[data-tab="poredjenje"]');
  await snap(page, 3);
  await setValue(page, '#diffBefore', `index  shard prirep state      docs   store node
orders 2     p      UNASSIGNED
orders 2     r      STARTED    18234  212mb es-data-1`);
  await setValue(page, '#diffAfter', GREEN_STATUS);
  await snap(page, 2);
  await clickWithCursor(page, '#diffBtn');
  await snap(page, 10);

  await say(page, 'Rules let you teach the tool patterns specific to your environment: a regex, a severity, a title — and optionally your own suggested fix with its own risk label. Rules can be exported and shared with the team as JSON.');
  await clickWithCursor(page, '.tab[data-tab="pravila"]');
  await snap(page, 3);
  await setValue(page, '#ruleRegex', 'CorruptIndexException');
  await setValue(page, '#ruleTitle', 'Custom: our known segment corruption pattern');
  await setValue(page, '#ruleNote', 'Matches the corruption signature we see on this cluster');
  await snap(page, 3);
  await clickWithCursor(page, '#addRuleBtn');
  await snap(page, 8);

  await say(page, 'From now on, every analysis also applies your rules — matches show up as findings with a custom rule badge. Regexes run in a sandboxed worker with a timeout, so a bad pattern can\u2019t hang the tool.');
  await snap(page, 4);

  await say(page, 'History keeps every analyzed incident for the current session — reopen any of them, or export and import the whole history as JSON to hand an incident over to a colleague.');
  await clickWithCursor(page, '#navHistory');
  await snap(page, 10);

  await say(page, 'And the header: light or dark theme, the Inputs toggle for the sidebar, and New incident to start clean. Clear asks for a second click only when there\u2019s actually something to lose.');
  await clickWithCursor(page, '#themeToggle');
  await snap(page, 6);
  await clickWithCursor(page, '#themeToggle');
  await snap(page, 4);

  await say(page, 'For terminal people, the same logic exists as scripts: diag agent collects everything read-only, recommend agent prints the same findings with prerequisites and consequences — pod layer first. See the readme.');
  await snap(page, 6);

  await say(page, 'That\u2019s the whole tool. Read-only by default, consequences on every command, and a speed bump exactly where speed is dangerous. Good luck out there.');
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap(page, 8);

  await padScene(page);
  await browser.close();

  if (NARRATE && sceneAudio.length) {
    const inputs = sceneAudio.map(a => `-i "${a.wav}"`).join(' ');
    const delays = sceneAudio.map((a, i) =>
      `[${i}:a]adelay=${Math.round(a.startFrame / FPS * 1000)}|${Math.round(a.startFrame / FPS * 1000)}[a${i}]`).join(';');
    const mixIn = sceneAudio.map((_, i) => `[a${i}]`).join('');
    execSync(`ffmpeg -y ${inputs} -filter_complex "${delays};${mixIn}amix=inputs=${sceneAudio.length}:normalize=0[mix]" -map "[mix]" "${AUDIO_DIR}/narration.wav"`, { stdio: 'pipe' });
    execSync(`ffmpeg -y -framerate ${FPS} -i ${FRAMES}/f%05d.png -i "${AUDIO_DIR}/narration.wav" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset medium -c:a aac -b:a 128k -shortest "${OUT}"`, { stdio: 'inherit' });
  } else {
    execSync(`ffmpeg -y -framerate ${FPS} -i ${FRAMES}/f%05d.png -c:v libx264 -pix_fmt yuv420p -crf 23 -preset medium "${OUT}"`, { stdio: 'inherit' });
  }
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  console.log('\nTraining video written to: ' + OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
