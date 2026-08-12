/**
 * dom-helper.js — loads incident-console.html into jsdom and returns helper
 * functions for simulating clicks/input in tests.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'incident-console.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

async function loadDom(opts = {}) {
  // jsdom deliberately doesn't implement real navigation, and logs it as a
  // "jsdomError" whenever a click's bubble path passes through a real
  // <a href="http(s)..."> (e.g. this app's "Official documentation" links)
  // — harmless in tests (no real navigation should happen anyway), but
  // noisy. This is jsdom's own documented behavior/limitation, not
  // something preventDefault() can suppress (it's raised asynchronously,
  // after the dispatched event has already finished). Filter out only this
  // specific, known-harmless message; everything else (real page errors,
  // console.error from the app under test) still surfaces normally.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => {
    if (err && /not implemented: navigation/i.test(err.message || '')) return;
    console.error(err);
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:fake');
      window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      if (opts.mockFetch) window.fetch = opts.mockFetch;
    }
  });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 150));
  return { dom, window, doc: window.document };
}

// Click/change/input events MUST have bubbles:true because the code uses
// delegated listeners (addEventListener on the parent + e.target.closest).
// Click/change/input events MUST have bubbles:true because the code uses
// delegated listeners (addEventListener on the parent + e.target.closest).
function click(el, window) { el.dispatchEvent(new window.Event('click', { bubbles: true })); }
function change(el, window) { el.dispatchEvent(new window.Event('change', { bubbles: true })); }
function input(el, window) { el.dispatchEvent(new window.Event('input', { bubbles: true })); }

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Class used to simulate File objects (upload tests) — jsdom's FileReader
// doesn't work with real Blob/File constructors on Node without extra
// polyfills, so we use a lightweight mock + a FileReader patch instead.
class FakeFile {
  constructor(name, content) { this.name = name; this._content = content; }
}
function patchFileReader(window) {
  window.FileReader = class {
    readAsText(file) {
      setTimeout(() => { this.result = file._content; if (this.onload) this.onload(); }, 5);
    }
  };
}

module.exports = { loadDom, click, change, input, wait, FakeFile, patchFileReader };
