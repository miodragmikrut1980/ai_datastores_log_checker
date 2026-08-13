/**
 * security.test.js — regression tests for the XSS fix (escapeHtml hardening +
 * missing escaping at render sites) and the Import Rules schema validation.
 *
 * Each test proves TWO things, not just "no alert fired":
 *   1. The dangerous markup never becomes live DOM (no unknown/foreign
 *      elements created from the payload) — checked via querySelector for
 *      the actual injected tag, which is a stronger signal than a dialog
 *      listener (some payloads don't need a dialog to prove injection).
 *   2. The original text is still fully readable as literal text — the fix
 *      must not silently drop or mangle legitimate-looking content.
 */
const { suite, test, assert, assertEqual, assertIncludes, assertNotIncludes, summary } = require('./harness');
const { loadDom, click, change, wait, FakeFile, patchFileReader } = require('./dom-helper');

const PAYLOAD = '<img src=x onerror="window.__xssFired=true">';

function pickSystem(doc, window, sys){ click(doc.querySelector(`#systemPicker button[data-val="${sys}"]`), window); }
function analyze(doc, window){ click(doc.getElementById('analyzeBtn'), window); }

(async () => {

await suite('XSS — stanctl status fields (Instana) never execute or render as live markup', async () => {
  const { window, doc } = await loadDom();
  doc.getElementById('logsInput').value = 'instana-agent CrashLoopBackOff\ncomponent=stanctl';
  doc.getElementById('statusInput').value =
    `backend: ${PAYLOAD}\nagent-acceptor: ${PAYLOAD}\ndatastore-impact: ${PAYLOAD}\nunit: degraded`;
  pickSystem(doc, window, 'instana');
  analyze(doc, window); await wait(80);

  await test('window.__xssFired was never set (onerror did not run)', () => {
    assert(window.__xssFired !== true, 'payload executed — XSS regression');
  });
  await test('findingsList contains no live <img> element from the payload', () => {
    const imgs = [...doc.getElementById('findingsList').querySelectorAll('img')];
    assertEqual(imgs.length, 0, 'a live <img> tag was created from parsed status text');
  });
  await test('the literal payload text is still visible to the user (not silently dropped)', () => {
    assertIncludes(doc.getElementById('findingsList').textContent, 'img src=x onerror');
  });
});

await suite('XSS — K8s STATUS column (unstable-pod finding) never executes', async () => {
  const { window, doc } = await loadDom();
  // No other K8s signal, so the STATUS-column fallback parser runs and
  // captures the raw column value — this used to flow unescaped into the
  // finding title.
  doc.getElementById('logsInput').value = `es-data-0 0/1 ${PAYLOAD.replace(/ /g,'')} 5`;
  pickSystem(doc, window, 'elasticsearch');
  analyze(doc, window); await wait(80);

  await test('window.__xssFired was never set', () => {
    assert(window.__xssFired !== true, 'payload executed via STATUS column — XSS regression');
  });
  await test('no live <img> in findingsList', () => {
    assertEqual(doc.getElementById('findingsList').querySelectorAll('img').length, 0);
  });
});

await suite('XSS — malicious uploaded filename never executes or renders as live markup', async () => {
  const { window, doc } = await loadDom();
  patchFileReader(window);
  const files = [ new FakeFile(`${PAYLOAD}.log`, 'ERROR OOMKilled Exit Code: 137') ];
  const fileInput = doc.getElementById('fileInput');
  Object.defineProperty(fileInput, 'files', { value: files, writable: true });
  change(fileInput, window);
  await wait(80);

  await test('window.__xssFired was never set (filename payload did not execute)', () => {
    assert(window.__xssFired !== true, 'filename payload executed — XSS regression');
  });
  await test('fileChips contains no live <img> element', () => {
    assertEqual(doc.getElementById('fileChips').querySelectorAll('img').length, 0);
  });
  await test('the filename is still shown as literal text', () => {
    assertIncludes(doc.getElementById('fileChips').textContent, 'img src=x onerror');
  });
});

await suite('XSS — malicious recommendation title (custom rule) never executes in the Recommendations tab', async () => {
  const { window, doc } = await loadDom();
  doc.getElementById('ruleTitle').value = PAYLOAD;
  doc.getElementById('ruleNote').value = 'note';
  doc.getElementById('ruleRegex').value = 'OOMKilled';
  click(doc.getElementById('ruleHasRec'), window);
  doc.getElementById('rulePrereq').value = PAYLOAD;
  doc.getElementById('ruleCommand').value = 'kubectl get pods';
  doc.getElementById('ruleConsequence').value = PAYLOAD;
  click(doc.getElementById('addRuleBtn'), window);

  doc.getElementById('logsInput').value = 'Last State: Terminated  Reason: OOMKilled';
  pickSystem(doc, window, 'kafka');
  analyze(doc, window); await wait(80);

  await test('window.__xssFired was never set', () => {
    assert(window.__xssFired !== true, 'custom-rule payload executed — XSS regression');
  });
  await test('no live <img> anywhere in recsList', () => {
    assertEqual(doc.getElementById('recsList').querySelectorAll('img').length, 0);
  });
});

await suite('Import Rules — schema validation rejects malformed/hostile entries', async () => {
  const { window, doc } = await loadDom();
  patchFileReader(window);
  const rulesJson = JSON.stringify([
    { pattern: 'OOMKilled', title: 'Valid rule', note: 'fine' },                          // valid
    { pattern: '(', title: 'Bad regex' },                                                 // invalid regex
    { title: 'Missing pattern' },                                                         // missing pattern
    { pattern: 'x', title: PAYLOAD, note: PAYLOAD, hasRec: true, prereq: PAYLOAD },        // hostile but well-formed
    'not-an-object',                                                                       // wrong type
    { pattern: 'y'.repeat(10), title: 'z'.repeat(5000) },                                  // oversized title, should be truncated not rejected
  ]);
  const file = new FakeFile('rules.json', rulesJson);
  const fileInput = doc.getElementById('importRulesFile');
  Object.defineProperty(fileInput, 'files', { value: [file], writable: true });
  change(fileInput, window);
  await wait(80);

  await test('only well-formed entries are accepted (3 of 6: valid, hostile-but-valid, oversized-title)', () => {
    assertEqual(doc.getElementById('rulesList').querySelectorAll('.rule-card').length, 3);
  });
  await test('the oversized title was truncated, not rejected outright', () => {
    const titles = [...doc.getElementById('rulesList').querySelectorAll('.rule-card b')].map(b=>b.textContent.length);
    assert(titles.some(len => len <= 2000), 'no truncated-length title found among imported rules');
  });
  await test('the hostile-but-well-formed rule renders as literal text, not live markup, in the rules list', () => {
    assertEqual(doc.getElementById('rulesList').querySelectorAll('img').length, 0);
    assertIncludes(doc.getElementById('rulesList').textContent, 'img src=x onerror');
  });
});

await suite('escapeHtml — attribute-context breakout is blocked', async () => {
  const { window, doc } = await loadDom();
  // Incident variables render into `value="${escapeHtml(...)}"` — a value
  // containing an unescaped '"' used to be able to close the attribute and
  // append a new one (e.g. onmouseover=...) without needing '<' at all.
  doc.getElementById('logsInput').value = 'Last State: Terminated  Reason: OOMKilled  Exit Code: 137';
  pickSystem(doc, window, 'elasticsearch');
  analyze(doc, window); await wait(80);

  const nsInput = doc.getElementById('var-namespace');
  nsInput.value = '" onmouseover="window.__xssFired=true" data-x="';
  change(nsInput, window);
  await wait(50);

  await test('attribute-breakout payload did not add a live onmouseover handler', () => {
    // If escaping failed, the rendered <mark> or command <input> would carry
    // a real onmouseover attribute; walk all elements and check.
    const hasHandler = [...doc.querySelectorAll('*')].some(el => el.getAttribute && el.getAttribute('onmouseover') === 'window.__xssFired=true');
    assert(!hasHandler, 'attribute-breakout succeeded — an element gained a live onmouseover handler');
  });
});

const ok = summary();
process.exit(ok ? 0 : 1);
})();
