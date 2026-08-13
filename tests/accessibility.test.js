/**
 * accessibility.test.js — regression tests for ARIA roles/states added to
 * the system picker, tabs, toast region, help icons, verdict banner, and
 * modal dialogs. Keeps these as explicit, separately-named checks (rather
 * than folding them into security.test.js or incident-console.test.js) so a
 * future accessibility regression is reported under an unambiguous heading.
 */
const { suite, test, assert, assertEqual, summary } = require('./harness');
const { loadDom, click, wait } = require('./dom-helper');

function pickSystem(doc, window, sys){ click(doc.querySelector(`#systemPicker button[data-val="${sys}"]`), window); }
function analyze(doc, window){ click(doc.getElementById('analyzeBtn'), window); }

(async () => {

await suite('systemPicker exposes a proper radiogroup', async () => {
  const { window, doc } = await loadDom();

  await test('role=radiogroup with exactly one checked radio, matching the active system', () => {
    const group = doc.getElementById('systemPicker');
    assertEqual(group.getAttribute('role'), 'radiogroup');
    const radios = [...group.querySelectorAll('[role="radio"]')];
    assertEqual(radios.length, 5);
    const checked = radios.filter(r => r.getAttribute('aria-checked') === 'true');
    assertEqual(checked.length, 1, 'exactly one radio should be aria-checked=true');
    assertEqual(checked[0].dataset.val, 'auto');
  });

  await test('switching system updates aria-checked, not just the visual .active class', () => {
    click(doc.querySelector('#systemPicker button[data-val="kafka"]'), window);
    const kafkaBtn = doc.querySelector('#systemPicker button[data-val="kafka"]');
    const autoBtn = doc.querySelector('#systemPicker button[data-val="auto"]');
    assertEqual(kafkaBtn.getAttribute('aria-checked'), 'true');
    assertEqual(autoBtn.getAttribute('aria-checked'), 'false');
    assert(kafkaBtn.classList.contains('active'), 'visual .active class should stay in sync too');
  });
});

await suite('Tabs follow the standard tablist/tab/tabpanel pattern', async () => {
  const { window, doc } = await loadDom();

  await test('tablist role present, aria-selected in sync on click', () => {
    const tablist = doc.querySelector('.tabs');
    assertEqual(tablist.getAttribute('role'), 'tablist');
    const findingsTab = doc.getElementById('tab-nalaz');
    const recsTab = doc.getElementById('tab-preporuke');
    assertEqual(findingsTab.getAttribute('aria-selected'), 'true');
    assertEqual(recsTab.getAttribute('aria-selected'), 'false');
    click(recsTab, window);
    assertEqual(findingsTab.getAttribute('aria-selected'), 'false');
    assertEqual(recsTab.getAttribute('aria-selected'), 'true');
  });

  await test('each panel is role=tabpanel and labelled by its tab', () => {
    const panel = doc.getElementById('panel-nalaz');
    assertEqual(panel.getAttribute('role'), 'tabpanel');
    assertEqual(panel.getAttribute('aria-labelledby'), 'tab-nalaz');
  });
});

await suite('Toast notifications use a polite live region', async () => {
  const { doc } = await loadDom();
  await test('toastWrap has role=status and aria-live=polite', () => {
    const wrap = doc.getElementById('toastWrap');
    assertEqual(wrap.getAttribute('role'), 'status');
    assertEqual(wrap.getAttribute('aria-live'), 'polite');
  });
});

await suite('Help ("?") icons are keyboard-reachable, not mouse-only', async () => {
  const { doc } = await loadDom();
  await test('every .help-icon is in the tab order with a real aria-label', () => {
    const icons = [...doc.querySelectorAll('.help-icon')];
    assert(icons.length > 0, 'no help-icon elements found — selector may be stale');
    icons.forEach(el => {
      assertEqual(el.getAttribute('tabindex'), '0');
      assert((el.getAttribute('aria-label')||'').startsWith('Help:'), 'help-icon missing a real aria-label');
    });
  });
});

await suite('Verdict banner urgency maps to the correct live-region role', async () => {
  const { window, doc } = await loadDom();
  await test('a blocked/urgent verdict uses role=alert (interrupts screen readers)', async () => {
    doc.getElementById('logsInput').value = 'Last State: Terminated  Reason: OOMKilled  Exit Code: 137';
    pickSystem(doc, window, 'elasticsearch');
    analyze(doc, window);
    await wait(80);
    const banner = doc.querySelector('.verdict-banner');
    assertEqual(banner.getAttribute('role'), 'alert');
  });
});

await suite('Modal dialogs are announced and focus-managed', async () => {
  const { window, doc } = await loadDom();
  doc.getElementById('logsInput').value = 'Last State: Terminated  Reason: OOMKilled  Exit Code: 137';
  pickSystem(doc, window, 'elasticsearch');
  analyze(doc, window); await wait(60);

  await test('opening a modal sets role=dialog + aria-modal and moves focus to Close', () => {
    click(doc.getElementById('ackNowBtn'), window);
    const box = doc.querySelector('.modal-box');
    assertEqual(box.getAttribute('role'), 'dialog');
    assertEqual(box.getAttribute('aria-modal'), 'true');
    assertEqual(doc.activeElement.id, 'modalClose');
  });

  await test('Escape closes the modal', () => {
    const evt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    doc.dispatchEvent(evt);
    assertEqual(doc.getElementById('modalWrap').innerHTML.trim(), '');
  });
});

const ok = summary();
process.exit(ok ? 0 : 1);
})();
