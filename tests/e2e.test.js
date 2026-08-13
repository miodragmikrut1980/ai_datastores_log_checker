#!/usr/bin/env node
/**
 * e2e.test.js — real headless-Chrome checks for things jsdom cannot verify:
 * actual computed layout (getBoundingClientRect), real CSS repaint, a real
 * mobile viewport, and the browser's clipboard permission model.
 *
 * jsdom (used by tests/incident-console.test.js) never computes real layout —
 * every element's getBoundingClientRect() is {0,0,0,0}. That's exactly why
 * repositionQuickActions() (incident-console.html), which reads a real
 * getBoundingClientRect().height to stop the sticky verdict bar and the
 * quick-actions bar from overlapping, was never actually exercised by the
 * existing 212 jsdom tests — this file is the one place that runs it for
 * real.
 *
 * Requires a local Chrome/Chromium (this repo is otherwise 100% browser-only,
 * no server dependency — this test tool is the one exception, same as
 * demo/record-demo.js which already depends on puppeteer-core).
 *
 * Usage:
 *   npm i puppeteer-core                     (once — already a dependency)
 *   npm run test:e2e
 *   # or point at a specific browser:
 *   node tests/e2e.test.js /path/to/chrome
 *   CHROME_PATH=/path/to/chrome npm run test:e2e
 *
 * If no Chrome binary can be found, this prints clear setup instructions and
 * exits 1 — it is intentionally NOT wired into `npm test` / tests/run-all.js,
 * so the plain jsdom suite still runs anywhere Node runs, with no browser
 * required.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { suite, test, assert, assertEqual, summary } = require('./harness');

function findChrome() {
  const candidate = process.argv[2] || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (candidate && fs.existsSync(candidate)) return candidate;
  try {
    const found = execSync(
      `find "${process.env.HOME || '/home/claude'}/.cache/puppeteer/chrome" -name chrome -type f 2>/dev/null | head -1`
    ).toString().trim();
    if (found) return found;
  } catch (e) { /* cache dir doesn't exist yet — fall through */ }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PAGE_URL = 'file://' + path.resolve(__dirname, '..', 'incident-console.html');

async function loadAndAnalyze(page, { viewport } = {}) {
  if (viewport) await page.setViewport(viewport);
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.click('#sampleLinks button[data-s="elasticsearch"]');
  await page.click('#analyzeBtn');
  await page.waitForSelector('#verdictBannerWrap .verdict-banner', { timeout: 5000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
}

async function run() {
  const CHROME = findChrome();
  if (!CHROME) {
    console.error(
      '\nNo Chrome/Chromium binary found — real-browser E2E tests were skipped, not passed.\n' +
      'Install one and re-run, e.g.:\n' +
      '  npx puppeteer browsers install chrome\n' +
      '  node tests/e2e.test.js "$(find ~/.cache/puppeteer/chrome -name chrome -type f | head -1)"\n' +
      'or set CHROME_PATH / PUPPETEER_EXECUTABLE_PATH.\n'
    );
    process.exit(1);
  }

  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (e) {
    console.error('puppeteer-core is not installed. Run: npm install');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await suite('Sticky verdict bar + quick-actions bar do not visually overlap (real layout)', async () => {
      const page = await browser.newPage();
      await loadAndAnalyze(page, { viewport: { width: 1280, height: 700 } });

      // Scroll the compact/sticky verdict copy into its stuck state.
      await page.evaluate(() => window.scrollBy(0, 900));
      await new Promise(r => setTimeout(r, 250));

      const rects = await page.evaluate(() => {
        const vs = document.getElementById('verdictStickyWrap');
        const qa = document.getElementById('quickActions');
        // Puppeteer's page.evaluate() serializes the return value over CDP;
        // DOMRect's width/height/top/etc. are prototype accessors, not own
        // enumerable properties, so a raw DOMRect returned inside a plain
        // object can silently lose fields in transit. Destructure into a
        // plain object explicitly so every field survives serialization.
        const plainRect = el => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        };
        return {
          vsVisible: vs ? vs.classList.contains('vs-visible') : false,
          vs: plainRect(vs),
          qa: plainRect(qa),
          qaTop: qa ? qa.style.top : null,
        };
      });

      await test('verdictStickyWrap reaches its stuck (vs-visible) state on scroll', async () => {
        assert(rects.vsVisible, 'expected #verdictStickyWrap to gain .vs-visible after scrolling past it');
      });

      await test('repositionQuickActions() pushed quick-actions below a real, non-zero verdict-bar height (not the jsdom-invisible 53px default)', async () => {
        assert(rects.qaTop && rects.qaTop !== '53px', `expected quickActions top offset to be pushed past 53px, got ${rects.qaTop}`);
      });

      await test('The two sticky bars do not overlap in real computed layout', async () => {
        assert(rects.vs && rects.qa, 'expected both bars to have bounding rects');
        const overlap = rects.vs.bottom > rects.qa.top && rects.qa.bottom > rects.vs.top;
        assert(!overlap, `sticky verdict bar (bottom=${rects.vs.bottom}) overlaps quick-actions bar (top=${rects.qa.top})`);
      });

      await page.close();
    });

    await suite('Modal dialog on a real mobile viewport (390x844, iPhone-sized)', async () => {
      const page = await browser.newPage();
      // A plain narrow viewport (not full isMobile/hasTouch emulation) —
      // that combination has historically produced inconsistent
      // window.innerWidth across Chrome versions/platforms; a fixed-size
      // viewport with deviceScaleFactor:1 gives a deterministic 390px
      // layout viewport, which is what this test actually needs to check.
      await loadAndAnalyze(page, { viewport: { width: 390, height: 844, deviceScaleFactor: 1 } });

      await page.click('#ackNowBtn');
      await page.waitForSelector('#modalBackdrop', { timeout: 3000 });

      const box = await page.evaluate(() => {
        const el = document.querySelector('.modal-box');
        const r = el ? el.getBoundingClientRect() : null;
        // See the plainRect() comment in the sticky-bar test above — same
        // DOMRect-through-evaluate serialization pitfall applies here.
        const rect = r ? { width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom } : null;
        return { rect, viewportW: window.innerWidth, focused: document.activeElement && document.activeElement.id };
      });

      await test('Modal box fits within the mobile viewport width (no horizontal overflow)', async () => {
        assert(box.rect, 'expected .modal-box to exist and be measurable');
        assert(box.rect.width <= box.viewportW + 1, `modal width ${box.rect.width} exceeds viewport width ${box.viewportW}`);
      });

      await test('Focus actually lands on the Close button in a real browser (not just jsdom .focus())', async () => {
        assertEqual(box.focused, 'modalClose');
      });

      await page.keyboard.press('Escape').catch(() => {});
      await page.close();
    });

    await suite('Dark/light theme actually repaints computed styles (real CSS, not just the data-theme attribute)', async () => {
      const page = await browser.newPage();
      await loadAndAnalyze(page, { viewport: { width: 1280, height: 700 } });

      const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.click('#themeToggle');
      await new Promise(r => setTimeout(r, 150));
      const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await test('Toggling theme changes the real computed background color', async () => {
        assert(light !== dark, `expected a different computed background-color after toggling theme, got the same value (${light}) both times`);
      });

      await page.close();
    });

    await suite('Clipboard write works under real browser clipboard permissions', async () => {
      const context = browser.defaultBrowserContext ? browser.defaultBrowserContext() : null;
      const page = await browser.newPage();
      if (context && context.overridePermissions) {
        try { await context.overridePermissions('file://', ['clipboard-write', 'clipboard-read']); } catch (e) { /* some Chrome builds reject file:// origin permissions — clipboard call below still exercises the real API path */ }
      }
      await loadAndAnalyze(page, { viewport: { width: 1280, height: 700 } });
      await page.click('#ackNowBtn');
      await page.waitForSelector('#modalCopy', { timeout: 3000 });
      await page.click('#modalCopy');
      await new Promise(r => setTimeout(r, 150));

      const toastShown = await page.evaluate(() => {
        const t = document.getElementById('toastWrap');
        return !!(t && t.textContent && t.textContent.trim().length);
      });

      await test('Copy button completes without throwing across the real clipboard API (navigator.clipboard.writeText), and confirms via toast', async () => {
        assert(toastShown, 'expected a toast confirming the copy, got none — navigator.clipboard.writeText() likely rejected/threw');
      });

      await page.close();
    });

    await suite('Long log input renders without breaking layout (real browser, thousands of lines)', async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 700 });
      await page.goto(PAGE_URL, { waitUntil: 'load' });

      const longLog = Array.from({ length: 5000 }, (_, i) =>
        `[2026-08-13T10:00:${String(i % 60).padStart(2, '0')}Z][INFO] es-data-0 shard ${i} routine health check ok`
      ).join('\n') + '\n[2026-08-13T10:00:00Z][ERROR] CorruptIndexException: checksum failed for segment_3.cfs';

      await page.evaluate((text) => { document.getElementById('logsInput').value = text; }, longLog);
      await page.click('#systemPicker button[data-val="elasticsearch"]');
      await page.click('#analyzeBtn');
      await page.waitForSelector('#findingsList', { timeout: 8000 });
      await new Promise(r => setTimeout(r, 400));

      const state = await page.evaluate(() => {
        const doc = document.documentElement;
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          findingsHasText: (document.getElementById('findingsList').textContent || '').length > 0,
        };
      });

      await test('A 5000-line log does not cause horizontal page overflow', async () => {
        assert(state.scrollWidth <= state.clientWidth + 4, `document overflowed horizontally: scrollWidth=${state.scrollWidth} clientWidth=${state.clientWidth}`);
      });

      await test('Analysis still completes and renders findings for a large paste', async () => {
        assert(state.findingsHasText, 'expected non-empty findingsList after analyzing a 5000-line log');
      });

      await page.close();
    });
  } finally {
    await browser.close();
  }

  const ok = summary();
  process.exit(ok ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL ERROR IN E2E SUITE:', err);
  process.exit(1);
});
