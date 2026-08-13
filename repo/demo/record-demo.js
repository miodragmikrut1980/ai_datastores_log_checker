#!/usr/bin/env node
/*
 * record-demo.js — records a real demo video of incident-console.html.
 *
 * Drives the actual UI in headless Chrome (puppeteer-core), overlays a fake
 * cursor + caption bar, captures frames, and assembles an mp4 with ffmpeg.
 *
 * Usage:
 *   npm i puppeteer-core            (once)
 *   node demo/record-demo.js [path-to-chrome]
 *
 * Output: demo/incident-console-demo.mp4
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const CHROME = process.argv[2] ||
  execSync(`find "${process.env.HOME || '/home/claude'}/.cache/puppeteer/chrome" -name chrome -type f 2>/dev/null | head -1`).toString().trim();
if (!CHROME) { console.error('Chrome binary not found — pass its path: node demo/record-demo.js /path/to/chrome'); process.exit(1); }
const FRAMES = path.join(__dirname, 'frames');
const OUT = path.join(__dirname, 'incident-console-demo.mp4');
const FPS = 8;

// ---- English narration (Piper TTS) -----------------------------------------
// If the `piper` binary and a voice model are available, every caption is
// spoken and each scene is padded so the video never cuts the voice off.
// Without piper the script still produces the silent, caption-only video.
// Voice model: set PIPER_MODEL, default ./tts/en-us-ryan-high.onnx
const PIPER_MODEL = process.env.PIPER_MODEL || path.join(__dirname, 'tts', 'en-us-ryan-high.onnx');
let NARRATE = false;
try { execSync('which piper', { stdio: 'ignore' }); NARRATE = fs.existsSync(PIPER_MODEL); } catch (e) {}
const AUDIO_DIR = path.join(__dirname, 'audio');
const sceneAudio = []; // { startFrame, wav, dur }
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

async function caption(page, text) {
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
        'background:rgba(10,13,17,.92);color:#e8f0e8;font:600 17px/1.4 system-ui;' +
        'padding:14px 24px;border-top:2px solid #4ade80;text-align:center;';
      document.body.appendChild(c);
    }
    c.textContent = t;
  }, text);
}

// Hold the current scene on screen until its narration has finished
// (plus a small breath), so the voice is never cut off by the next scene.
async function padScene(page) {
  if (!NARRATE) return;
  const need = Math.ceil((sceneDur + 0.5) * FPS) - (n - sceneStartFrame);
  if (need > 0) await snap(page, need);
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
    return { x: parseFloat(c.style.left), y: parseFloat(c.style.top) };
  });
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const e = t * t * (3 - 2 * t); // ease
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
  await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    c.style.background = 'rgba(255,255,255,.95)';
  });
  await snap(page);
  await page.mouse.click(box.x, box.y);
  await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    c.style.background = 'rgba(74,222,128,.85)';
  });
}

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  if (NARRATE) { fs.rmSync(AUDIO_DIR, { recursive: true, force: true }); fs.mkdirSync(AUDIO_DIR, { recursive: true }); }
  console.log(NARRATE ? 'Narration: ON (piper, ' + path.basename(PIPER_MODEL) + ')' : 'Narration: OFF (piper or voice model not found — silent video)');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, '..', 'incident-console.html'));
  await new Promise(r => setTimeout(r, 400));
  await ensureCursor(page);

  // ---- Scene 1: the situation -------------------------------------------
  await caption(page, 'Instana backend is down — a datastore pod stopped. Every minute counts.');
  await snap(page, 18);

  await padScene(page);
  await caption(page, 'Step 1 — don\u2019t know what\u2019s broken yet? One click gets the "ask for everything" message.');
  await clickWithCursor(page, '#firstContactBtn');
  await snap(page, 20);
  await clickWithCursor(page, '#modalClose'); // close the modal before moving on
  await snap(page, 2);

  // ---- Scene 2: paste data (sample) -------------------------------------
  await padScene(page);
  await caption(page, 'Step 2 — paste the customer\u2019s logs + status. (Here: built-in Elasticsearch sample.)');
  await clickWithCursor(page, '#sampleLinks button[data-s="elasticsearch"]');
  await snap(page, 14);

  // ---- Scene 3: analyze ---------------------------------------------------
  await padScene(page);
  await caption(page, 'Step 3 — Analyze. The sidebar collapses: the results get the whole screen.');
  await clickWithCursor(page, '#analyzeBtn');
  await new Promise(r => setTimeout(r, 500));
  await ensureCursor(page);
  await padScene(page);
  await caption(page, 'Verdict on top. Pod-layer causes (OOMKilled, probes, volumes) are checked before datastore internals.');
  await snap(page, 22);

  await padScene(page);
  await caption(page, 'Every finding quotes the exact log line that proves it — no guessing.');
  await page.evaluate(() => { const f = document.getElementById('findingsList'); if (f) f.scrollIntoView({ block: 'start' }); });
  await snap(page, 16);

  // ---- Scene 4: recommendations ------------------------------------------
  await padScene(page);
  await caption(page, 'Recommendations: risk label, prerequisites, command, and the consequences of running it.');
  await clickWithCursor(page, '.tab[data-tab="preporuke"]');
  await snap(page, 20);

  await padScene(page);
  await caption(page, 'The gray "CHECK FIRST" block is the read-only prerequisite — visually distinct from the green fix command.');
  await page.evaluate(() => { const p = document.querySelector('#recsList pre.cmd-prereq'); if (p) p.scrollIntoView({ block: 'center' }); });
  await snap(page, 20);

  // ---- Scene 5: destructive gate -----------------------------------------
  const hasGate = await page.evaluate(() => !!document.querySelector('.cmd-gate-input'));
  if (hasGate) {
    await padScene(page);
    await caption(page, 'A PERMANENT LOSS command is never one click away — it stays locked until you type CONFIRM.');
    await page.evaluate(() => document.querySelector('.cmd-gate-input').scrollIntoView({ block: 'center' }));
    await snap(page, 16);
    await moveCursorTo(page, '.cmd-gate-input');
    await page.evaluate(() => document.querySelector('.cmd-gate-input').focus());
    await page.keyboard.type('CONFIRM', { delay: 60 });
    await page.evaluate(() => document.querySelector('.cmd-gate-input')
      .dispatchEvent(new Event('input', { bubbles: true })));
    await snap(page, 6);
    await clickWithCursor(page, '.cmd-gate-btn');
    await snap(page, 14);
  }

  // ---- Scene 6: teamwork --------------------------------------------------
  await padScene(page);
  await caption(page, 'Working the ticket with a colleague? Click the incident ID and give it the shared ticket number.');
  await clickWithCursor(page, '#incidentId');
  const hasIdInput = await page.evaluate(() => !!document.querySelector('#incidentId input'));
  if (hasIdInput) {
    await page.evaluate(() => { document.querySelector('#incidentId input').value = ''; });
    await page.type('#incidentId input', 'TICKET-4711', { delay: 50 });
    await snap(page, 4);
    await page.keyboard.press('Enter');
    await snap(page, 12);
  }

  await padScene(page);
  await caption(page, 'Checklist per recommendation: mark Done, assign a name — progress is visible to everyone.');
  const hasCheck = await page.evaluate(() => !!document.querySelector('#recsList .rec-done'));
  if (hasCheck) {
    await clickWithCursor(page, '#recsList .rec-done');
    await snap(page, 8);
    const hasAssignee = await page.evaluate(() => !!document.querySelector('#recsList .rec-assignee'));
    if (hasAssignee) {
      await moveCursorTo(page, '#recsList .rec-assignee');
      await page.evaluate(() => document.querySelector('#recsList .rec-assignee').focus());
      await page.keyboard.type('Miodrag', { delay: 50 });
      await page.evaluate(() => document.querySelector('#recsList .rec-assignee')
        .dispatchEvent(new Event('input', { bubbles: true })));
    }
    await snap(page, 14);
  }

  // ---- Scene 7: customer message + outro ---------------------------------
  await padScene(page);
  await caption(page, 'Each step has a ready-to-send customer message — and a ticket summary at the end.');
  const hasMsg = await page.evaluate(() => {
    const d = document.querySelector('#recsList details.help-panel');
    if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); return true; }
    return false;
  });
  if (hasMsg) await snap(page, 18);

  await padScene(page);
  await caption(page, 'Read-only diagnostics. Consequences on every command. 127 automated tests. That\u2019s the whole idea.');
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap(page, 22);

  await padScene(page); // let the last narration finish
  await browser.close();

  if (NARRATE && sceneAudio.length) {
    // Mix all narration wavs at their scene offsets into one track, then mux.
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
  console.log('\nDemo video written to: ' + OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
