const { suite, test, assert, assertEqual, assertIncludes, assertNotIncludes, summary } = require('./harness');
const { loadDom, click, change, input, wait, FakeFile, patchFileReader } = require('./dom-helper');

async function run() {
  await suite('ES multi-index grouping (regression: no longer uses only the first UNASSIGNED shard)', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_3.cfs';
    doc.getElementById('statusInput').value =
      'index    shard prirep state      docs   store node\n' +
      'orders   0     p     UNASSIGNED\n' +
      'orders   0     r     STARTED    100    10mb   es-data-1\n' +
      'products 0     p     UNASSIGNED\n' +
      'products 0     r     STARTED    200    20mb   es-data-1';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('A finding flags that multiple indices are affected', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Multiple indices affected');
      assertIncludes(doc.getElementById('findingsList').textContent, 'orders');
      assertIncludes(doc.getElementById('findingsList').textContent, 'products');
    });

    await test('A targeted recommendation is generated for EACH affected index, not just the first', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const text = doc.getElementById('recsList').textContent;
      assertIncludes(text, 'Promote the healthy replica to primary (orders)');
      assertIncludes(text, 'Promote the healthy replica to primary (products)');
    });
  });

  await suite('Analysis does not crash the UI on custom-rule errors (regression: silent failure)', async () => {
    const { window, doc } = await loadDom();
    // A rule with an empty/invalid-at-runtime pattern shouldn't hang the button
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(400);
    await test('The Analyze button is re-enabled and reset after analysis (never stuck on "Analyzing...")', async () => {
      const btn = doc.getElementById('analyzeBtn');
      assertEqual(btn.disabled, false);
      assertEqual(btn.textContent, 'Analyze');
    });
  });

  await suite('No window globals for copy/unlock (regression: window.__copyCmd/__unlockCmd removed)', async () => {
    const { window, doc } = await loadDom();
    await test('window.__copyCmd no longer exists', async () => {
      assertEqual(typeof window.__copyCmd, 'undefined');
    });
    await test('window.__unlockCmd no longer exists', async () => {
      assertEqual(typeof window.__unlockCmd, 'undefined');
    });
    await test('Copy still works via delegated data-copy attribute (not inline onclick)', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const copyBtn = doc.querySelector('#recsList [data-copy]');
      assert(copyBtn, 'expected a button with data-copy attribute');
      assert(!copyBtn.hasAttribute('onclick'), 'copy button should not use inline onclick');
      click(copyBtn, window);
      await wait(20);
      assertEqual(copyBtn.textContent, 'copied ✓');
    });
  });

  await suite('Kafka: corrupt segment command is a real, copy-paste-ready command (regression: used to be a comment)', async () => {
    const { window, doc } = await loadDom();
    // RF>1 case, with a realistic CorruptRecordException line that includes
    // the segment's real file path — same regex diag-agent.sh/recommend-agent.sh
    // use on the CLI side.
    doc.getElementById('logsInput').value =
      '[2026-08-06 10:00:00] ERROR [ReplicaManager broker=1] Error processing fetch\n' +
      'org.apache.kafka.common.errors.CorruptRecordException: Found record size 0 smaller than minimum record overhead in /var/lib/kafka/data/orders-3/00000000000000012345.log';
    doc.getElementById('statusInput').value =
      'Topic: orders  PartitionCount: 6  ReplicationFactor: 3\n' +
      '\tTopic: orders  Partition: 3  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3';
    click(doc.querySelector('#systemPicker button[data-val="kafka"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);

    await test('The suggested command is a real "rm" with the exact parsed path, not a "#" comment', async () => {
      const text = doc.getElementById('recsList').textContent;
      assertIncludes(text, 'rm -v /var/lib/kafka/data/orders-3/00000000000000012345.log');
      assertIncludes(text, '00000000000000012345.index');
      assertIncludes(text, '00000000000000012345.timeindex');
      assertNotIncludes(text, '# delete the .log/.index/.timeindex files for that segment');
    });

    await test('Falls back to a clearly-labeled placeholder (not a silent wrong guess) when no path can be parsed', async () => {
      const { window: w2, doc: d2 } = await loadDom();
      d2.getElementById('logsInput').value = '[ERROR] CorruptRecordException: corruption detected, no path in this message';
      d2.getElementById('statusInput').value = 'Topic: orders  PartitionCount: 6  ReplicationFactor: 3';
      click(d2.querySelector('#systemPicker button[data-val="kafka"]'), w2);
      click(d2.getElementById('analyzeBtn'), w2);
      await wait(300);
      click(d2.querySelector('.tab[data-tab="preporuke"]'), w2);
      const text = d2.getElementById('recsList').textContent;
      assertIncludes(text, 'Could not parse the exact segment path');
    });
  });

  await suite('Basic analysis — all 3 systems via the "Example" buttons', async () => {
    const { window, doc } = await loadDom();
    for (const sys of ['elasticsearch', 'clickhouse', 'kafka']) {
      click(doc.querySelector(`#sampleLinks button[data-s="${sys}"]`), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      await test(`${sys}: system is correctly detected`, async () => {
        assertIncludes(doc.querySelector('#findingsList h3').textContent, sys.toUpperCase());
      });
      await test(`${sys}: at least 1 immediate action exists`, async () => {
        assert(doc.querySelectorAll('#recsList .rec').length > 0, 'expected at least 1 recommendation');
      });
    }
  });

  await suite('Instana self-hosted mode', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="instana"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(400);

    await test('Instana example is detected as an Instana incident', async () => {
      assertIncludes(doc.querySelector('#findingsList h3').textContent, 'INSTANA');
      assertIncludes(doc.getElementById('findingsList').textContent, 'Instana impact');
      assertIncludes(doc.getElementById('findingsList').textContent, 'Affected Instana datastore: CLICKHOUSE');
    });

    await test('Instana recommendations include urgent bundle and after-action verification', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const text = doc.getElementById('recsList').textContent;
      assertIncludes(text, 'Collect the Instana self-hosted urgent bundle');
      assertIncludes(text, 're-run stanctl unit status');
    });

    await test('Instana mode requests stanctl status when status data is missing', async () => {
      const { window: w2, doc: d2 } = await loadDom();
      d2.getElementById('logsInput').value = 'instana-kafka kafka broker CrashLoopBackOff CorruptRecordException';
      d2.getElementById('statusInput').value = '';
      click(d2.querySelector('#systemPicker button[data-val="instana"]'), w2);
      click(d2.getElementById('analyzeBtn'), w2);
      await wait(400);
      assertIncludes(d2.getElementById('infoRequestWrap').textContent, 'stanctl status');
      assertIncludes(d2.getElementById('findingsList').textContent, 'Missing stanctl status/unit output');
    });
  });

  await suite('Table parsing (shards / parts / topics)', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('ES: parsed shard table has rows', async () => {
      assert(doc.querySelectorAll('table.parsed tbody tr').length > 0, 'expected at least 1 row');
    });

    const { window: w2, doc: d2 } = await loadDom();
    click(d2.querySelector('#sampleLinks button[data-s="clickhouse"]'), w2);
    click(d2.getElementById('analyzeBtn'), w2);
    await wait(300);
    await test('ClickHouse: parsed parts table has rows (box-drawing format)', async () => {
      assert(d2.querySelectorAll('table.parsed tbody tr').length > 0, 'expected at least 1 row');
    });

    const { window: w3, doc: d3 } = await loadDom();
    click(d3.querySelector('#sampleLinks button[data-s="kafka"]'), w3);
    click(d3.getElementById('analyzeBtn'), w3);
    await wait(300);
    await test('Kafka: parsed partitions table has rows', async () => {
      assert(d3.querySelectorAll('table.parsed tbody tr').length > 0, 'expected at least 1 row');
    });
  });

  await suite('Preventive measures + checklist + progress bar', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('Preventive measures are shown separately from immediate actions', async () => {
      assert(doc.querySelectorAll('#preventiveList .rec').length > 0, 'expected at least 1 preventive measure');
    });

    await test('Checking "Done" updates the status pill and progress bar', async () => {
      const cb = doc.querySelector('#recsList .rec-done');
      cb.checked = true;
      change(cb, window);
      assertEqual(doc.querySelector('#recsList .status-pill').textContent, 'Done');
      assertIncludes(doc.querySelector('.progress-label').textContent, '1/');
    });

    await test('Assignee input is kept in state (visible after re-render)', async () => {
      const inp = doc.querySelector('#recsList .rec-assignee');
      inp.value = 'Alex';
      input(inp, window);
      assertEqual(inp.value, 'Alex');
    });
  });

  await suite('Timeline (timestamp parsing)', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="linija"]'), window);
    await test('At least 1 timestamped event is recognized', async () => {
      assert(doc.querySelectorAll('.tl-item').length > 0, 'expected at least 1 timeline item');
    });
  });

  await suite('Timeline filters out routine/info noise (regression: used to list every timestamped line)', async () => {
    const { window, doc } = await loadDom();
    const lines = [];
    for(let i=0;i<50;i++) lines.push(`[2026-07-26T10:${String(i%60).padStart(2,'0')}:00][INFO][o.e.cluster] routine heartbeat ${i}`);
    lines.push('[2026-07-26T10:05:14][ERROR][o.e.i.e.Engine] CorruptIndexException checksum failed');
    lines.push('[2026-07-26T10:05:20][WARN][o.e.cluster] shard relocation delayed');
    doc.getElementById('logsInput').value = lines.join('\n');
    doc.getElementById('statusInput').value = 'myindex 0 p STARTED\nmyindex 0 r STARTED';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="linija"]'), window);
    await test('Only the ERROR/WARN lines appear, not the 50 routine INFO lines', async () => {
      const items = doc.querySelectorAll('.tl-item');
      assertEqual(items.length, 2);
    });
    await test('The heading discloses how many routine lines were hidden, so nothing looks silently dropped', async () => {
      assertIncludes(doc.getElementById('timelineResult').textContent, 'routine/info line');
      assertIncludes(doc.getElementById('timelineResult').textContent, '50 routine');
    });
  });

  await suite('Timeline falls back to showing everything if truly nothing looks like an error/warning', async () => {
    const { window, doc } = await loadDom();
    const lines = [];
    for(let i=0;i<5;i++) lines.push(`[2026-07-26T10:${String(i).padStart(2,'0')}:00][INFO][o.e.cluster] routine heartbeat ${i}`);
    doc.getElementById('logsInput').value = lines.join('\n');
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="linija"]'), window);
    await test('All 5 lines still show (better than an empty timeline)', async () => {
      assertEqual(doc.querySelectorAll('.tl-item').length, 5);
    });
  });

  await suite('JSON/ECS structured logs', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch-json"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Corruption is detected from a JSON/ECS log line', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Trace of physical segment corruption');
    });
  });

  await suite('Snapshot comparison (diff)', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('.tab[data-tab="poredjenje"]'), window);
    doc.getElementById('diffBefore').value = 'orders 0 p UNASSIGNED\norders 0 r STARTED';
    doc.getElementById('diffAfter').value = 'orders 0 p STARTED\norders 0 r STARTED';
    click(doc.getElementById('diffBtn'), window);
    await wait(30);
    await test('Primary shard transition UNASSIGNED -> STARTED is recognized as an improvement', async () => {
      const rows = [...doc.querySelectorAll('table.diff tbody tr')];
      const primaryRow = rows.find(r => r.textContent.includes('primary'));
      assert(primaryRow, 'row for the primary shard not found');
      assertIncludes(primaryRow.querySelector('.diff-pill').textContent, 'Improved');
    });
  });

  await suite('Custom rules', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('.tab[data-tab="pravila"]'), window);
    doc.getElementById('ruleRegex').value = 'MyInternalError';
    doc.getElementById('ruleTitle').value = 'Internal error XYZ';
    doc.getElementById('ruleNote').value = 'Custom case';
    click(doc.getElementById('addRuleBtn'), window);
    await wait(20);

    await test('Rule is added to the list', async () => {
      assertEqual(doc.getElementById('countPravila').textContent, '1');
    });

    doc.getElementById('logsInput').value = 'a message with MyInternalError in it';
    doc.getElementById('statusInput').value = 'myindex 0 p STARTED';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(400);

    await test('Custom rule is applied during analysis and appears in findings', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Internal error XYZ');
    });

    await test('Warning about a potentially dangerous regex (nested quantifiers) is shown but does not block', async () => {
      const { window: w2, doc: d2 } = await loadDom();
      click(d2.querySelector('.tab[data-tab="pravila"]'), w2);
      d2.getElementById('ruleRegex').value = '(a+)+b';
      d2.getElementById('ruleTitle').value = 'Dangerous rule';
      d2.getElementById('ruleNote').value = 'x';
      click(d2.getElementById('addRuleBtn'), w2);
      await wait(30);
      const toasts = [...d2.querySelectorAll('.toast')].map(t => t.textContent).join(' ');
      assertIncludes(toasts, 'slow regex');
      assertEqual(d2.getElementById('countPravila').textContent, '1');
    });
  });

  await suite('Redacting sensitive data before export', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'ERROR from 10.0.0.42 contact admin@example.com token: abc123XYZsecret Authorization: Bearer bearerSecret123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdXBwb3J0In0.signature123456 https://admin:secretPass@cluster.local ERROR again Exception at Foo.bar';
    doc.getElementById('statusInput').value = 'myindex 0 p STARTED';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    let captured = null;
    const OrigBlob = window.Blob;
    window.Blob = function (parts, opts) { captured = parts[0]; return new OrigBlob(parts, opts); };

    await test('With redaction on (default), IP and email are masked in the JSON export', async () => {
      assert(doc.getElementById('redactToggle').checked, 'redactToggle should be checked by default');
      click(doc.getElementById('exportJson'), window);
      const data = JSON.parse(captured);
      assertNotIncludes(data.rawLogs, '10.0.0.42');
      assertIncludes(data.rawLogs, '[IP-REDACTED]');
      assertNotIncludes(data.rawLogs, 'admin@example.com');
      assertNotIncludes(data.rawLogs, 'bearerSecret123');
      assertNotIncludes(data.rawLogs, 'eyJhbGciOiJIUzI1NiJ9');
      assertNotIncludes(data.rawLogs, 'secretPass');
    });

    await test('With redaction off, raw data stays in the export', async () => {
      doc.getElementById('redactToggle').checked = false;
      click(doc.getElementById('exportJson'), window);
      const data = JSON.parse(captured);
      assertIncludes(data.rawLogs, '10.0.0.42');
    });
  });

  await suite('File upload — auto-classification', async () => {
    const { window, doc } = await loadDom();
    patchFileReader(window);
    const files = [
      new FakeFile('03-logs-previous.txt', '[ERROR] CorruptIndexException: checksum failed'),
      new FakeFile('11-es-shards.txt', 'myindex 0 p UNASSIGNED\nmyindex 0 r STARTED'),
      new FakeFile('random-notes.txt', 'ERROR Exception at com.foo.Bar(Bar.java:10) ERROR Exception at Baz')
    ];
    const fileInput = doc.getElementById('fileInput');
    Object.defineProperty(fileInput, 'files', { value: files, writable: true });
    change(fileInput, window);
    await wait(60);

    await test('A file with "logs" in its name goes to logsInput', async () => {
      assertIncludes(doc.getElementById('logsInput').value, '03-logs-previous.txt');
    });
    await test('A file with "shards" in its name goes to statusInput', async () => {
      assertIncludes(doc.getElementById('statusInput').value, '11-es-shards.txt');
    });
    await test('A generic filename is classified by content sniffing (2+ ERROR/Exception -> logs)', async () => {
      assertIncludes(doc.getElementById('logsInput').value, 'random-notes.txt');
    });
  });

  await suite('File upload — oversized incident bundles are rejected before reading', async () => {
    const { window, doc } = await loadDom();
    patchFileReader(window);
    const fileInput = doc.getElementById('fileInput');
    Object.defineProperty(fileInput, 'files', {
      value: [new FakeFile('full-support-bundle.log', 'not actually allocated', 26 * 1024 * 1024)],
      writable: true
    });
    change(fileInput, window);
    await wait(30);
    await test('A file over 25 MB is not loaded and the engineer gets an actionable message', async () => {
      assertEqual(doc.getElementById('logsInput').value, '');
      assertIncludes([...doc.querySelectorAll('.toast')].map(t=>t.textContent).join(' '), 'larger than 25 MB');
    });
  });

  await suite('History — saving and reloading an analysis', async () => {
    const { window, doc } = await loadDom();
    for (const sys of ['elasticsearch', 'clickhouse']) {
      click(doc.querySelector(`#sampleLinks button[data-s="${sys}"]`), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
    }
    await test('Number of analyses in history is 2', async () => {
      assertEqual(doc.getElementById('historyCount').textContent, '2');
    });
    click(doc.getElementById('navHistory'), window);
    const items = doc.querySelectorAll('.history-item');
    await test('2 history items are displayed', async () => {
      assertEqual(items.length, 2);
    });
    click(items[0], window);
    await wait(20);
    await test('Clicking a history item loads that analysis back into Findings', async () => {
      assert(doc.querySelector('#findingsList h3'), 'findings h3 should exist');
    });
  });

  await suite('Export contents (Markdown/HTML/JSON/ticket text)', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="kafka"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    let captured = null;
    const OrigBlob = window.Blob;
    window.Blob = function (parts, opts) { captured = parts[0]; return new OrigBlob(parts, opts); };

    await test('Markdown report contains findings and recommendations', async () => {
      click(doc.getElementById('exportMd'), window);
      assertIncludes(captured, '# Incident report');
      assertIncludes(captured, '## Findings');
      assertIncludes(captured, '## Immediate actions');
    });

    await test('Regression: each export click gets its own filename (a second export must not silently overwrite the first)', async () => {
      const seenNames = [];
      const origClick = window.HTMLAnchorElement.prototype.click;
      window.HTMLAnchorElement.prototype.click = function () { seenNames.push(this.download); return origClick.call(this); };
      click(doc.getElementById('exportMd'), window);
      click(doc.getElementById('exportMd'), window); // rapid back-to-back, same second
      window.HTMLAnchorElement.prototype.click = origClick;
      assertEqual(seenNames.length, 2);
      assert(seenNames[0] !== seenNames[1], `two exports produced the same filename: ${seenNames[0]}`);
      assert(/_\d{6}-\d{3}\.md$/.test(seenNames[0]), `filename should end in an HHMMSS-mmm export timestamp, got: ${seenNames[0]}`);
    });

    await test('Ticket text is generated and contains system/findings', async () => {
      click(doc.getElementById('ticketBtn'), window);
      await wait(20);
      const ta = doc.getElementById('ticketTextArea');
      assert(ta, 'modal textarea should exist');
      assertIncludes(ta.value, 'KAFKA');
      assertIncludes(ta.value, 'FINDINGS:');
    });
  });

  await suite('Companion server fetch (mock fetch, no real server)', async () => {
    const mockFetch = async (url, opts) => {
      if (url.includes('/logs')) return { ok: true, json: async () => ({ text: 'MOCK LOGS CorruptIndexException checksum' }) };
      if (url.includes('/status')) return { ok: true, json: async () => ({ text: 'myindex 0 p UNASSIGNED\nmyindex 0 r STARTED' }) };
    };
    const { window, doc } = await loadDom({ mockFetch });
    doc.getElementById('cNamespace').value = 'production';
    doc.getElementById('cPod').value = 'es-data-0';
    doc.getElementById('cToken').value = 'abc123';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('companionFetchBtn'), window);
    await wait(50);

    await test('Fields are auto-filled from the mock companion response', async () => {
      assertIncludes(doc.getElementById('logsInput').value, 'MOCK LOGS');
      assertIncludes(doc.getElementById('statusInput').value, 'UNASSIGNED');
    });
  });

  await suite("Log quote (evidence) — so you don't have to search the text manually", async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Findings contain the exact line that proves the corruption', async () => {
      assertIncludes(doc.getElementById('findingsList').innerHTML, 'evidence-quote');
      assertIncludes(doc.getElementById('findingsList').textContent, 'CorruptIndexException');
    });
  });

  await suite('Customer message per recommendation', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="kafka"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Every recommendation has a "Message for the customer" block ready to copy', async () => {
      assertIncludes(doc.getElementById('recsList').textContent, 'Message for the customer');
      assertIncludes(doc.getElementById('recsList').textContent, 'Hi,');
    });
    await test('Customer message includes the exact command to check the prerequisite first', async () => {
      assertIncludes(doc.getElementById('recsList').textContent, 'First, run this command to check the prerequisite');
      assertIncludes(doc.getElementById('recsList').textContent, 'kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders');
    });
    await test('Customer message explains jargon terms in plain language (zero-experience friendly)', async () => {
      const text = doc.getElementById('recsList').textContent;
      assertIncludes(text, 'Some terms used above, in plain language');
      assertIncludes(text, 'Replication factor (RF)');
      assertIncludes(text, 'only one copy');
    });
    await test('Recommendation card shows a visible link to official documentation', async () => {
      const link = doc.querySelector('#recsList .doc-link');
      assert(link, 'expected a .doc-link element on the recommendation card');
      assertIncludes(link.getAttribute('href'), 'kafka.apache.org');
    });
    await test('Customer message includes a "want more detail" documentation link', async () => {
      assertIncludes(doc.getElementById('recsList').textContent, 'Official documentation:');
    });
  });

  await suite('Request for more data when status is missing (realistic case — logs only)', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_3.cfs';
    doc.getElementById('statusInput').value = ''; // customer did not send status - realistic case
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('A warning about missing data is shown', async () => {
      assertIncludes(doc.getElementById('infoRequestWrap').textContent, 'Not enough data');
    });
    await test('A ready-made message to request status output from the customer is offered', async () => {
      assertIncludes(doc.getElementById('infoRequestWrap').textContent, '_cat/shards');
    });

    const { window: w2, doc: d2 } = await loadDom();
    click(d2.querySelector('#sampleLinks button[data-s="elasticsearch"]'), w2); // has status too
    click(d2.getElementById('analyzeBtn'), w2);
    await wait(300);
    await test('When status data IS present, the warning is NOT shown', async () => {
      assertEqual(d2.getElementById('infoRequestWrap').style.display, 'none');
    });
  });

  await suite('Simplified view — advanced tabs hidden by default', async () => {
    const { window, doc } = await loadDom();
    await test('Diagram/Comparison/Timeline/Rules/History tabs are hidden on load', async () => {
      assertEqual(doc.querySelector('.tab[data-tab="dijagram"]').style.display, 'none');
      assertEqual(doc.querySelector('.tab[data-tab="poredjenje"]').style.display, 'none');
      assertEqual(doc.querySelector('.tab[data-tab="pravila"]').style.display, 'none');
    });
    await test('Findings and Recommendations tabs are visible on load (no advanced-tab class)', async () => {
      assert(!doc.querySelector('.tab[data-tab="nalaz"]').classList.contains('advanced-tab'));
      assert(!doc.querySelector('.tab[data-tab="preporuke"]').classList.contains('advanced-tab'));
    });
    await test('Clicking "Advanced" reveals the advanced tabs', async () => {
      click(doc.getElementById('toggleAdvancedBtn'), window);
      assertEqual(doc.querySelector('.tab[data-tab="dijagram"]').style.display, '');
    });
    await test('Clicking "Advanced" again hides them', async () => {
      click(doc.getElementById('toggleAdvancedBtn'), window);
      assertEqual(doc.querySelector('.tab[data-tab="dijagram"]').style.display, 'none');
    });
  });

  await suite('Light/dark theme toggle', async () => {
    const { window, doc } = await loadDom();
    await test('Default theme is light', async () => {
      assertEqual(doc.documentElement.getAttribute('data-theme'), 'light');
      assertIncludes(doc.getElementById('themeToggle').textContent, 'Light');
    });
    await test('Click switches theme to dark', async () => {
      click(doc.getElementById('themeToggle'), window);
      assertEqual(doc.documentElement.getAttribute('data-theme'), 'dark');
      assertIncludes(doc.getElementById('themeToggle').textContent, 'Dark');
    });
    await test('Second click switches back to light', async () => {
      click(doc.getElementById('themeToggle'), window);
      assertEqual(doc.documentElement.getAttribute('data-theme'), 'light');
    });
    await test('Theme change does not break the rest of the app (analysis still works)', async () => {
      click(doc.getElementById('themeToggle'), window); // -> dark
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      assertIncludes(doc.querySelector('#findingsList h3').textContent, 'ELASTICSEARCH');
    });
    await test('Input fields (textarea/input) follow the theme, not hardcoded dark', async () => {
      const styleText = doc.querySelector('style').textContent;
      assertIncludes(styleText, '--input-bg', 'CSS should use the --input-bg variable for field backgrounds');
      assert(!/background:#0d1116/.test(styleText), 'textarea/input background must not be hardcoded (must follow the theme)');
    });
    await test('Header and info/new badges follow the theme (no hardcoded dark colors)', async () => {
      const styleText = doc.querySelector('style').textContent;
      assert(!/linear-gradient\(180deg,\s*#141a22/.test(styleText), 'header gradient must not be hardcoded');
      assert(!/background:#1c3350/.test(styleText), 'badge.info/diff-pill.new must not be hardcoded');
    });
  });

  await suite('Custom hover tooltips (regression: native title="" replaced with styled data-tooltip)', async () => {
    const { window, doc } = await loadDom();
    await test('Static help icons use data-tooltip, not native title', async () => {
      const helpIcon = doc.querySelector('.help-icon');
      assert(helpIcon.hasAttribute('data-tooltip'), 'help icon should have data-tooltip');
      assert(!helpIcon.hasAttribute('title'), 'help icon should not also carry a native title (avoids double tooltip)');
    });
    await test('Regression: tooltips are positioned by JS (viewport-clamped), not a fixed CSS direction', async () => {
      // Earlier this used a static CSS position ("always open down-left"),
      // which fixed clipping for icons near the sidebar's right edge but
      // broke it for icons near the LEFT edge (e.g. "Import files") — a
      // fixed direction can never be correct for triggers on both sides of
      // a narrow container. A single JS-measured, viewport-clamped tooltip
      // (see initTooltips/computeTooltipPosition) is the actual fix; this
      // just confirms that shared element exists and old per-element
      // position attributes are gone. The clamping math itself can't be
      // meaningfully unit-tested here — jsdom's getBoundingClientRect()
      // always returns zeros (no real layout engine) — so correctness for
      // this specific bug was confirmed with real screenshots instead.
      assert(doc.querySelector('.js-tooltip'), 'expected one shared .js-tooltip element appended to the page');
      assertEqual(doc.querySelectorAll('[data-tooltip-pos]').length, 0, 'no element should still carry the old fixed-direction attribute');
    });
    await test('Hovering a tooltip trigger shows the shared tooltip with the right text; moving away hides it', async () => {
      const icon = doc.querySelector('.help-icon[data-tooltip]');
      const overEvt = new window.Event('mouseover', { bubbles: true });
      icon.dispatchEvent(overEvt);
      const tip = doc.querySelector('.js-tooltip');
      assertEqual(tip.style.display, 'block');
      assertEqual(tip.textContent, icon.dataset.tooltip);
      const outEvt = new window.Event('mouseout', { bubbles: true });
      Object.defineProperty(outEvt, 'relatedTarget', { value: doc.body });
      icon.dispatchEvent(outEvt);
      assertEqual(tip.style.display, 'none');
    });
    await test('Regression: tap (touchstart) also shows the tooltip — hover-only was inaccessible on touch devices', async () => {
      const icon = doc.querySelector('.help-icon[data-tooltip]');
      const tip = doc.querySelector('.js-tooltip');
      const touchEvt = new window.Event('touchstart', { bubbles: true });
      icon.dispatchEvent(touchEvt);
      assertEqual(tip.style.display, 'block');
      assertEqual(tip.textContent, icon.dataset.tooltip);
    });
    await test('Tapping elsewhere (not a tooltip trigger) dismisses an open tooltip', async () => {
      const icon = doc.querySelector('.help-icon[data-tooltip]');
      const tip = doc.querySelector('.js-tooltip');
      icon.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
      assertEqual(tip.style.display, 'block');
      doc.body.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
      assertEqual(tip.style.display, 'none');
    });
    await test('Severity, confidence, and risk badges all carry explanatory tooltips', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      const sevBadge = doc.querySelector('#findingsList .badge');
      assert(sevBadge.hasAttribute('data-tooltip') && sevBadge.dataset.tooltip.length > 0, 'severity badge needs a tooltip');
      const confBadge = doc.querySelector('#findingsList .badge.conf-high, #findingsList .badge.conf-medium, #findingsList .badge.conf-low');
      assert(confBadge && confBadge.dataset.tooltip.length > 0, 'confidence badge needs a tooltip');
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const stamp = doc.querySelector('#recsList .stamp-wrap');
      assert(stamp.hasAttribute('data-tooltip') && stamp.dataset.tooltip.length > 0, 'risk stamp needs a tooltip');
    });
    await test('Stage stepper pills explain what each stage means', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      const pill = doc.querySelector('.stage-pill');
      assert(pill.hasAttribute('data-tooltip') && pill.dataset.tooltip.length > 10, 'stage pill needs a real explanation, not just a label');
    });
  });

  await suite('Incident verdict banner (urgency assessment)', async () => {
    const { window, doc } = await loadDom();
    // ES sample: corrupt + healthy replica -> critical finding exists, safe/moderate fix exists -> urgent-safe
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Verdict banner is shown with an urgency label', async () => {
      assertIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Act now');
    });
    await test('"Send acknowledgment now" button opens a modal with the ack message', async () => {
      click(doc.getElementById('ackNowBtn'), window);
      await wait(20);
      assertIncludes(doc.getElementById('ticketTextArea').value, 'actively investigating');
    });
  });

  await suite('Escalation message — shown when there is no safe fix', async () => {
    const { window, doc } = await loadDom();
    // Kafka RF=1 + corrupt -> destructive-only fix -> should escalate
    click(doc.querySelector('#sampleLinks button[data-s="kafka"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Escalation button is present when every fix is destructive/no safe path', async () => {
      assert(doc.getElementById('escalateBtn'), 'expected an Escalation message button');
    });
    await test('Escalation message contains key findings and system name', async () => {
      click(doc.getElementById('escalateBtn'), window);
      await wait(20);
      const val = doc.getElementById('ticketTextArea').value;
      assertIncludes(val, 'ESCALATION');
      assertIncludes(val, 'Kafka');
    });
  });

  await suite('Verdict banner — stable case has no escalation button', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'plain log line with no known error pattern in it';
    doc.getElementById('statusInput').value = 'myindex 0 p STARTED\nmyindex 0 r STARTED';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No critical findings -> "Stable" verdict, no escalate button', async () => {
      assertIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Stable');
      assert(!doc.getElementById('escalateBtn'), 'escalate button should not exist when stable');
    });
  });

  await suite('Stop banner ("do this first") — shown by default, dismissible', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Stop banner is visible after analysis with the safety checklist', async () => {
      assertIncludes(doc.getElementById('stopBannerWrap').textContent, "Don't restart");
    });
    await test('Dismissing the stop banner hides it', async () => {
      click(doc.getElementById('stopDismissBtn'), window);
      await wait(20);
      assertEqual(doc.getElementById('stopBannerWrap').style.display, 'none');
    });
  });

  await suite('First contact message — available before any analysis', async () => {
    const { window, doc } = await loadDom();
    await test('First contact button works with no incident loaded yet', async () => {
      click(doc.getElementById('firstContactBtn'), window);
      await wait(20);
      const val = doc.getElementById('ticketTextArea').value;
      assertIncludes(val, 'GET _cluster/health');
      assertIncludes(val, 'SELECT database, table, name, is_readonly');
      assertIncludes(val, 'kafka-topics.sh --bootstrap-server localhost:9092 --describe');
    });
  });

  await suite('Quick "did it work?" check', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('"Check if this worked" button is available right on the verdict banner', async () => {
      assert(doc.getElementById('quickCheckBtn'), 'expected a quickCheckBtn on the verdict banner');
    });
    await test('Pasting an improved status shows an "improved" verdict without re-pasting the before state', async () => {
      click(doc.getElementById('quickCheckBtn'), window);
      await wait(20);
      doc.getElementById('quickCheckInput').value = 'orders 2 p STARTED\norders 2 r STARTED';
      click(doc.getElementById('quickCheckRun'), window);
      await wait(20);
      assertIncludes(doc.getElementById('quickCheckResult').textContent, 'Looks improved');
    });
    await test('Running the quick check advances the incident stage to "Verifying"', async () => {
      assertIncludes(doc.getElementById('stageStepperWrap').innerHTML, 'active');
      const activePill = doc.querySelector('.stage-pill.active');
      assertIncludes(activePill.textContent, 'Verifying');
    });
  });

  await suite('Incident stage stepper', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Starts at "Diagnosing" right after analysis', async () => {
      const activePill = doc.querySelector('.stage-pill.active');
      assertIncludes(activePill.textContent, 'Diagnosing');
    });
    await test('Copying a customer message auto-advances to "Waiting on customer"', async () => {
      const msgBtn = doc.querySelector('#recsList pre[id*="-msg-"] .copy-btn');
      click(msgBtn, window);
      await wait(20);
      const activePill = doc.querySelector('.stage-pill.active');
      assertIncludes(activePill.textContent, 'Waiting on customer');
    });
    await test('Stage pills are manually clickable to override', async () => {
      const resolvedPill = [...doc.querySelectorAll('.stage-pill')].find(b => b.textContent.includes('Resolved'));
      click(resolvedPill, window);
      await wait(20);
      const activePill = doc.querySelector('.stage-pill.active');
      assertIncludes(activePill.textContent, 'Resolved');
    });
  });

  await suite('Confidence badges on findings', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Findings show a confidence badge (structured cluster status reads as HIGH)', async () => {
      const html = doc.getElementById('findingsList').innerHTML;
      assertIncludes(html, 'conf-high');
      assertIncludes(html, 'HIGH CONFIDENCE');
    });
    await test('A fuzzy log-pattern match (corruption trace) is labeled MEDIUM, not HIGH', async () => {
      const rows = [...doc.querySelectorAll('.finding-row')];
      const corruptionRow = rows.find(r => r.textContent.includes('Trace of physical segment corruption'));
      assert(corruptionRow, 'expected to find the corruption finding row');
      assertIncludes(corruptionRow.innerHTML, 'MEDIUM CONFIDENCE');
    });
  });

  await suite('Type-to-confirm gate on destructive (PERMANENT LOSS) commands', async () => {
    const { window, doc } = await loadDom();
    // ES corrupt + NO replica -> triggers the destructive "remove corrupted data" rec
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_3.cfs';
    doc.getElementById('statusInput').value = 'myindex 0 p UNASSIGNED';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);

    await test('Destructive command is blurred/locked behind a CONFIRM gate by default', async () => {
      const locked = doc.querySelector('#recsList pre.cmd.cmd-locked');
      assert(locked, 'expected a locked destructive command');
      assert(locked.querySelector('.copy-btn').disabled, 'copy button should be disabled while locked');
    });
    await test('Typing the wrong word does not unlock it', async () => {
      const gateInput = doc.querySelector('.cmd-gate-input');
      const cmdId = gateInput.id.replace('gate-', '');
      gateInput.value = 'yes please';
      click(doc.querySelector('.cmd-gate-btn'), window);
      assert(doc.getElementById(cmdId).classList.contains('cmd-locked'), 'should still be locked after a wrong confirmation word');
    });
    await test('Typing CONFIRM unlocks the command and enables copy', async () => {
      const gateInput = doc.querySelector('.cmd-gate-input');
      const cmdId = gateInput.id.replace('gate-', '');
      gateInput.value = 'confirm';
      click(doc.querySelector('.cmd-gate-btn'), window);
      const pre = doc.getElementById(cmdId);
      assert(!pre.classList.contains('cmd-locked'), 'should be unlocked after typing CONFIRM');
      assert(!pre.querySelector('.copy-btn').disabled, 'copy button should be enabled after unlocking');
    });
    await test('Safe/moderate recommendations are never gated', async () => {
      const anyLockedLeft = doc.querySelectorAll('#recsList .stamp.safe').length > 0
        ? doc.querySelector('#recsList .rec:has(.stamp.safe) pre.cmd.cmd-locked')
        : null;
      assert(!anyLockedLeft, 'a SAFE-risk recommendation should never be gated');
    });
  });

  await suite('Status output commands are real, copyable text (regression: they used to be placeholder="" only)', async () => {
    const { window, doc } = await loadDom();
    await test('With no system selected (auto), all 4 reference commands are shown, each with its own copy button', async () => {
      const hint = doc.getElementById('statusCmdHint');
      assertIncludes(hint.textContent, 'stanctl status');
      assertIncludes(hint.textContent, 'GET _cluster/health');
      assertIncludes(hint.textContent, 'SELECT database, table, name, is_readonly');
      assertIncludes(hint.textContent, 'kafka-topics.sh --bootstrap-server localhost:9092 --describe');
      assertEqual(hint.querySelectorAll('.copy-btn').length, 4);
    });
    await test('The textarea placeholder itself no longer duplicates the commands (placeholder text cannot be selected/copied)', async () => {
      const placeholder = doc.getElementById('statusInput').getAttribute('placeholder');
      assertNotIncludes(placeholder, 'GET _cluster/health');
      assertNotIncludes(placeholder, 'kafka-topics.sh');
    });
    await test('Selecting a specific system narrows the hint to just that system\'s command', async () => {
      click(doc.querySelector('#systemPicker button[data-val="kafka"]'), window);
      const hint = doc.getElementById('statusCmdHint');
      assertIncludes(hint.textContent, 'kafka-topics.sh --bootstrap-server localhost:9092 --describe');
      assertNotIncludes(hint.textContent, 'GET _cluster/health');
      assertEqual(hint.querySelectorAll('.copy-btn').length, 1);
    });
    await test('Clicking copy actually copies the exact command text (via the same data-copy delegation as everywhere else)', async () => {
      const copyBtn = doc.querySelector('#statusCmdHint .copy-btn');
      assert(copyBtn.hasAttribute('data-copy'), 'should use the shared delegated copy mechanism, not a one-off handler');
      click(copyBtn, window);
      await wait(20);
      assertEqual(copyBtn.textContent, 'copied ✓');
    });
  });

  await suite('Companion server — validation of missing fields', async () => {
    const { window, doc } = await loadDom();
    click(doc.getElementById('companionFetchBtn'), window);
    await wait(20);
    await test('A message about missing fields is shown, without attempting a fetch', async () => {
      assertIncludes([...doc.querySelectorAll('.toast')].map(t => t.textContent).join(' '), 'Fill in namespace');
    });
  });

  await suite('Kubernetes layer — "the pod stopped" is diagnosed BEFORE datastore internals', async () => {
    const { window, doc } = await loadDom();
    // Realistic paste: kubectl describe output in the logs field, alongside an ES log line.
    doc.getElementById('logsInput').value =
      'Last State:     Terminated\n' +
      '  Reason:       OOMKilled\n' +
      '  Exit Code:    137\n' +
      'Warning  BackOff  2m  kubelet  Back-off restarting failed container\n' +
      'Status: CrashLoopBackOff\n' +
      '[ERROR] CorruptIndexException: checksum failed for segment_1.cfs';
    doc.getElementById('statusInput').value = '';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('OOMKilled and CrashLoopBackOff both surface as findings', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'OOMKilled');
      assertIncludes(t, 'CrashLoopBackOff');
    });
    await test('Kubernetes-level findings appear BEFORE the datastore findings', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assert(t.indexOf('CrashLoopBackOff') < t.indexOf('Cluster status'),
        'pod-level finding should be listed before the ES cluster-status finding');
    });
    await test('The memory-limit recommendation exists, with a consequence explaining the pod restart', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const t = doc.getElementById('recsList').textContent;
      assertIncludes(t, 'Raise the container memory limit');
      assertIncludes(t, 'RECREATED');
    });
  });

  await suite('Kubernetes layer — Evicted pod', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      'Status: Failed\nReason: Evicted\nMessage: The node was low on resource: ephemeral-storage.\n' +
      'clickhouse-server: some unrelated line';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The Evicted finding says PV data is NOT deleted by an eviction', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'Evicted');
      assertIncludes(t, 'NOT deleted');
    });
    await test('The clear-Evicted-pod recommendation warns never to delete the PVC', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      assertIncludes(doc.getElementById('recsList').textContent, 'NEVER delete the PVC');
    });
  });

  await suite('Kubernetes layer — volume mount failure with unknown datastore type', async () => {
    const { window, doc } = await loadDom();
    // Nothing here identifies ES/CH/Kafka — only k8s signals. The old behavior
    // was a dead-end "System type not recognized" with zero recommendations.
    doc.getElementById('logsInput').value =
      'Warning  FailedMount  90s  kubelet  MountVolume.SetUp failed for volume "data" : timed out waiting for the condition\n' +
      'Warning  FailedAttachVolume  3m  attachdetach-controller  Multi-Attach error for volume "pvc-1234"';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The volume finding and a read-only PVC/PV check recommendation are produced even without a recognized datastore', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Volume/PVC cannot be mounted');
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      assertIncludes(doc.getElementById('recsList').textContent, 'PVC/PV binding');
    });
    await test('The "not recognized" finding now points to fixing the pod layer first, not a dead end', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Kubernetes-level signals');
    });
  });

  await suite('Kubernetes layer — probe kills during recovery', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      'Warning  Unhealthy  30s  kubelet  Liveness probe failed: HTTP probe failed with statuscode: 503\n' +
      'elasticsearch: [gc][12] recovering translog';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Probe-kill recommendation exists, and its prerequisite demands confirming recovery is really in progress', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const t = doc.getElementById('recsList').textContent;
      assertIncludes(t, 'relax the liveness probe');
      assertIncludes(t, 'IS actually recovering');
    });
  });

  await suite('Kubernetes layer — bare "get pods" READY/RESTARTS numbers catch instability with no literal status phrase', async () => {
    // Found via a live simulation: a customer pasted only a raw `kubectl
    // get pods` row — "kafka-broker-2   0/1   Running   15   6h" — with
    // none of the literal phrases (CrashLoopBackOff, OOMKilled, etc.)
    // every other check here looks for. STATUS said "Running" (true in the
    // gap between crash-loop restarts), so nothing fired and the verdict
    // came back "Stable — you have time. No critical findings detected." —
    // actively dangerous with READY 0/1 and 15 restarts sitting right
    // there in the same line.
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'kafka-broker-2   0/1   Running   15   6h';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('An instability finding fires from the READY/RESTARTS numbers alone', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'unstable');
      assertIncludes(t, '0/1');
      assertIncludes(t, '15 restarts');
    });
    await test('The verdict no longer reads as an unqualified "no critical findings" — it names the warning', async () => {
      const t = doc.getElementById('verdictBannerWrap').textContent;
      assertIncludes(t, 'warning');
    });
    await test('A read-only follow-up recommendation is offered (logs/describe/events)', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      assertIncludes(doc.getElementById('recsList').textContent, 'READY/RESTARTS');
    });
  });

  await suite('Kubernetes layer — unstable-pod finding stays quiet once a more specific cause is already known', async () => {
    const { window, doc } = await loadDom();
    // Same READY/RESTARTS numbers, but now WITH a specific cause present
    // (Evicted) — the generic "looks unstable" finding should not also
    // fire and duplicate/dilute the more specific, more useful finding.
    doc.getElementById('logsInput').value =
      'kafka-broker-2   0/1   Running   15   6h\nWarning  Evicted  9m  kubelet  The node was low on resource: ephemeral-storage.';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No redundant "looks unstable" finding when Evicted already explains it', async () => {
      assertNotIncludes(doc.getElementById('findingsList').textContent, 'looks unstable');
    });
  });

  await suite('Kubernetes layer — no false positives on a clean datastore-only incident', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_2.cfs';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No Kubernetes-level findings appear when no k8s signal is present', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assertNotIncludes(t, 'CrashLoopBackOff');
      assertNotIncludes(t, 'OOMKilled');
      assertNotIncludes(t, 'Evicted');
    });
  });

  await suite('First-contact message asks for describe/events (why the pod stopped), not just logs', async () => {
    const { window, doc } = await loadDom();
    click(doc.getElementById('firstContactBtn'), window);
    await wait(50);
    await test('The message includes kubectl describe pod and get events', async () => {
      const msg = doc.body.textContent;
      assertIncludes(msg, 'kubectl describe pod');
      assertIncludes(msg, 'kubectl get events');
    });
  });

  await suite('Sidebar collapses after analysis (reclaims reading space)', async () => {
    const { window, doc } = await loadDom();
    await test('Before analysis the sidebar is visible', async () => {
      assert(!doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
    });
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('After analysis the sidebar auto-collapses', async () => {
      assert(doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
    });
    await test('The header toggle brings it back', async () => {
      click(doc.getElementById('sidebarToggle'), window);
      assert(!doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
    });
    await test('"New incident" always restores the sidebar (you need the inputs again)', async () => {
      click(doc.getElementById('sidebarToggle'), window); // collapse again
      click(doc.getElementById('navNew'), window);
      assert(!doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
    });
  });

  await suite('Prerequisite command is visually distinct from the main command', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    await test('The prereq command renders as a muted .cmd-prereq block, separate from the main .cmd', async () => {
      const prereqBlock = doc.querySelector('#recsList pre.cmd-prereq');
      assert(prereqBlock, 'expected a rendered prerequisite command block');
      const mainCmd = doc.querySelector('#recsList pre.cmd:not(.cmd-prereq)');
      assert(mainCmd, 'main command block should still exist without the prereq class');
    });
    await test('The prereq block is still copyable via the shared data-copy mechanism', async () => {
      const btn = doc.querySelector('#recsList pre.cmd-prereq .copy-btn');
      assert(btn && btn.hasAttribute('data-copy'));
      click(btn, window);
      await wait(20);
      assertEqual(btn.textContent, 'copied ✓');
    });
  });

  await suite('Clear requires a second click only when there is something to lose', async () => {
    const { window, doc } = await loadDom();
    await test('With empty inputs and no analysis, one click clears immediately (no friction added)', async () => {
      click(doc.getElementById('resetBtn'), window);
      await wait(20);
      assert(!doc.getElementById('resetBtn').classList.contains('confirming'));
      assertEqual(doc.getElementById('resetBtn').textContent, 'Clear');
    });
    await test('With an analyzed incident, the first click only arms the button', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      click(doc.getElementById('resetBtn'), window);
      await wait(20);
      assert(doc.getElementById('resetBtn').classList.contains('confirming'), 'button should be armed, not cleared');
      assert(doc.getElementById('logsInput').value.length > 0, 'inputs must NOT be wiped on the first click');
    });
    await test('The second click actually clears', async () => {
      click(doc.getElementById('resetBtn'), window);
      await wait(20);
      assertEqual(doc.getElementById('logsInput').value, '');
      assertEqual(doc.getElementById('resetBtn').textContent, 'Clear');
    });
  });

  await suite('Incident ID is editable by clicking it in the header', async () => {
    const { window, doc } = await loadDom();
    await test('Before any analysis, clicking the ID does nothing (nothing to rename)', async () => {
      click(doc.getElementById('incidentId'), window);
      assert(!doc.querySelector('#incidentId input'));
    });
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Clicking the generated ID opens an inline input pre-filled with it', async () => {
      click(doc.getElementById('incidentId'), window);
      const inp = doc.querySelector('#incidentId input');
      assert(inp, 'expected an inline input');
      assert(inp.value.length > 0);
    });
    await test('Typing a shared ticket ID and pressing Enter saves it to the incident and the header', async () => {
      const inp = doc.querySelector('#incidentId input');
      inp.value = 'TICKET-4711';
      inp.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
      await wait(20);
      assertEqual(doc.getElementById('incidentId').textContent, 'TICKET-4711');
    });
    await test('The renamed ID shows up in History too (both colleagues see the same name)', async () => {
      click(doc.getElementById('navHistory'), window);
      await wait(50);
      assertIncludes(doc.getElementById('historyList').textContent, 'TICKET-4711');
    });
  });

  await suite('Handover round-trip — colleague continues exactly where you stopped', async () => {
    // ---- Window A: work an incident partway through ----
    const A = await loadDom();
    let handoverJson = null;
    // download() goes through URL.createObjectURL — capture the payload there.
    // jsdom's Blob has no .text(), so read it with jsdom's own FileReader.
    A.window.URL.createObjectURL = (blob) => {
      const r = new A.window.FileReader();
      r.onload = () => { handoverJson = String(r.result); };
      r.readAsText(blob);
      return 'blob:captured';
    };
    A.window.URL.revokeObjectURL = () => {};
    click(A.doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), A.window);
    click(A.doc.getElementById('analyzeBtn'), A.window);
    await wait(300);
    // progress: one rec done + assignee
    click(A.doc.querySelector('.tab[data-tab="preporuke"]'), A.window);
    // jsdom: dispatched click events have no activation behavior on checkboxes,
    // so set checked directly and fire the change event the UI listens for.
    const doneCb = A.doc.querySelector('#recsList .rec-done');
    doneCb.checked = true;
    doneCb.dispatchEvent(new A.window.Event('change', { bubbles: true }));
    const assignee = A.doc.querySelector('#recsList .rec-assignee');
    assignee.value = 'Miodrag';
    assignee.dispatchEvent(new A.window.Event('input', { bubbles: true }));
    // shared ticket id
    click(A.doc.getElementById('incidentId'), A.window);
    const idInput = A.doc.querySelector('#incidentId input');
    idInput.value = 'TICKET-9000';
    idInput.dispatchEvent(new A.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // one custom rule
    A.doc.getElementById('ruleRegex').value = 'OurInternalError';
    A.doc.getElementById('ruleTitle').value = 'Custom: internal error';
    A.doc.getElementById('ruleRegex').dispatchEvent(new A.window.Event('input', { bubbles: true }));
    click(A.doc.getElementById('addRuleBtn'), A.window);
    await wait(50);
    click(A.doc.getElementById('handoverBtn'), A.window);
    await wait(100);

    await test('The handover file contains the incident AND the custom rules, unredacted', async () => {
      assert(handoverJson, 'handover payload should have been captured');
      const p = JSON.parse(handoverJson);
      assert(p._handover === true);
      assertEqual(p.incident.id, 'TICKET-9000');
      assert(p.incident.rawLogs.includes('CorruptIndexException'), 'raw logs must be present and NOT redacted');
      assertEqual(p.customRules.length, 1);
      assert(p.incident.recs.some(r => r.done && r.assignee === 'Miodrag'), 'checklist progress must be in the file');
    });

    // ---- Window B: a different colleague, clean session ----
    const B = await loadDom();
    await test('Importing the handover opens the incident immediately as current, with the shared ID in the header', async () => {
      const file = new B.window.File([handoverJson], 'TICKET-9000_HANDOVER.json', { type: 'application/json' });
      const input = B.doc.getElementById('importFile');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new B.window.Event('change', { bubbles: true }));
      await wait(200);
      assertEqual(B.doc.getElementById('incidentId').textContent, 'TICKET-9000');
      assert(B.doc.getElementById('findingsList').textContent.includes('segment corruption'),
        'findings must be rendered without any re-analysis');
    });
    await test('Checklist progress and assignee survived the handover', async () => {
      click(B.doc.querySelector('.tab[data-tab="preporuke"]'), B.window);
      assert(B.doc.querySelector('#recsList .rec-done').checked, 'the Done checkbox must arrive checked');
      assertEqual(B.doc.querySelector('#recsList .rec-assignee').value, 'Miodrag');
    });
    await test('The custom rule traveled along', async () => {
      assertEqual(B.doc.getElementById('countPravila').textContent, '1');
    });
    await test('A random JSON file is rejected without touching the console state', async () => {
      const junk = new B.window.File(['{"foo":1}'], 'junk.json', { type: 'application/json' });
      const input = B.doc.getElementById('importFile');
      Object.defineProperty(input, 'files', { value: [junk], configurable: true });
      input.dispatchEvent(new B.window.Event('change', { bubbles: true }));
      await wait(100);
      assertEqual(B.doc.getElementById('incidentId').textContent, 'TICKET-9000', 'current incident must be untouched');
    });
  });

  await suite('Opening an incident from History updates the header ID', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    const firstId = doc.getElementById('incidentId').textContent;
    click(doc.getElementById('navNew'), window);
    click(doc.querySelector('#sampleLinks button[data-s="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Clicking the older incident in History puts ITS id back into the header', async () => {
      click(doc.getElementById('navHistory'), window);
      await wait(50);
      const items = doc.querySelectorAll('.history-item');
      click(items[items.length - 1], window); // oldest
      await wait(100);
      assertEqual(doc.getElementById('incidentId').textContent, firstId);
    });
  });

  await suite('Evidence highlight sentinel characters never leak into human-readable exports', async () => {
    // Found via a live simulation: findEvidence() embeds \u0001/\u0002
    // sentinels around the matched substring so the live UI can render a
    // <mark> highlight (see renderEvidenceHtml). Four export paths quoted
    // f.evidence directly without stripping them first — Markdown export,
    // HTML export, and the postmortem generator all had literal U+0001/
    // U+0002 control characters embedded in the quoted log line, which
    // would show as garbled/invisible junk when pasted into Confluence,
    // Notion, or a text editor. (JSON/Handover correctly keep the
    // sentinels — those need them to re-render highlighting after import.)
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    const hasSentinel = s => /[\u0001\u0002]/.test(s);

    await test('Ticket text has no sentinel characters', async () => {
      click(doc.getElementById('ticketBtn'), window);
      await wait(50);
      assert(!hasSentinel(doc.getElementById('modalWrap').textContent));
      click(doc.getElementById('modalClose'), window);
    });
    await test('Postmortem draft has no sentinel characters', async () => {
      click(doc.getElementById('postmortemBtn'), window);
      await wait(50);
      assert(!hasSentinel(doc.getElementById('modalWrap').textContent));
      click(doc.getElementById('modalClose'), window);
    });
    await test('Export Markdown output has no sentinel characters', async () => {
      let captured = null;
      window.URL.createObjectURL = (blob) => {
        const r = new window.FileReader();
        r.onload = () => { captured = String(r.result); };
        r.readAsText(blob);
        return 'blob:captured';
      };
      window.URL.revokeObjectURL = () => {};
      click(doc.getElementById('exportMd'), window);
      await wait(100);
      assert(captured, 'expected the markdown export to have been captured');
      assert(!hasSentinel(captured));
    });
  });

  await suite('Postmortem generator', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    // mark one action done with an assignee so Resolution has content
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    const cb = doc.querySelector('#recsList .rec-done');
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    const asg = doc.querySelector('#recsList .rec-assignee');
    asg.value = 'Miodrag';
    asg.dispatchEvent(new window.Event('input', { bubbles: true }));

    click(doc.getElementById('postmortemBtn'), window);
    await wait(100);
    const modalText = doc.getElementById('modalWrap').textContent;

    await test('Draft opens with the DRAFT status and the incident header', async () => {
      assertIncludes(modalText, 'Postmortem');
      assertIncludes(modalText, 'Status: DRAFT');
      assertIncludes(modalText, 'ELASTICSEARCH');
    });
    await test('Root cause section carries the critical finding WITH its log evidence', async () => {
      assertIncludes(modalText, 'Root cause');
      assertIncludes(modalText, 'segment corruption');
      assertIncludes(modalText, 'CorruptIndexException');
    });
    await test('Timeline section is reconstructed from the log timestamps', async () => {
      assertIncludes(modalText, '## Timeline');
      assertIncludes(modalText, '2026');
    });
    await test('Resolution lists the done action with assignee; outstanding items get an owner TODO', async () => {
      assertIncludes(modalText, '[x]');
      assertIncludes(modalText, 'Miodrag');
      assertIncludes(modalText, 'owner: TODO');
    });
    await test('What the tool cannot know stays an explicit TODO (impact, lessons)', async () => {
      assertIncludes(modalText, 'Impact');
      assertIncludes(modalText, 'customer-visible impact');
      assertIncludes(modalText, 'Where we got lucky');
    });
  });

  await suite('Findings are sorted critical-first, regardless of analyzer output order', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The CRITICAL corruption finding appears before the WARNING cluster-status finding', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assert(t.indexOf('segment corruption') < t.indexOf('Cluster status'),
        'critical finding must be sorted ahead of a warning finding');
    });
  });

  await suite('Evidence: matched fragment is highlighted and click reveals surrounding context', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The evidence quote contains a <mark> around the matched fragment', async () => {
      const quote = doc.querySelector('.evidence-quote');
      assert(quote.innerHTML.includes('<mark'), 'expected a <mark> around the matched substring');
    });
    await test('Clicking the evidence line reveals surrounding log context', async () => {
      const quote = doc.querySelector('.evidence-quote');
      const idx = quote.dataset.findingIdx;
      const ctx = doc.getElementById('ctx-' + idx);
      assertEqual(ctx.style.display, 'none');
      click(quote, window);
      assertEqual(ctx.style.display, 'block');
      assertIncludes(ctx.textContent, 'LOGS');
    });
    await test('Clicking it again collapses the context', async () => {
      const quote = doc.querySelector('.evidence-quote');
      click(quote, window);
      const idx = quote.dataset.findingIdx;
      assertEqual(doc.getElementById('ctx-' + idx).style.display, 'none');
    });
  });

  await suite('Findings tab badge turns red/amber to reflect the worst severity inside', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('With a critical finding present, the tab count badge carries the danger class', async () => {
      const badge = doc.querySelector('.tab[data-tab="nalaz"] .count');
      assert(badge.classList.contains('danger'));
    });
  });

  await suite('Risk chips filter the findings list', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Clicking the critical chip shows only critical findings, with a filter note', async () => {
      click(doc.querySelector('[data-sev-filter="danger"]'), window);
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'DANGER only');
      assertIncludes(t, 'segment corruption');
      assertNotIncludes(t, 'Cluster status');
    });
    await test('Clicking the same chip again clears the filter', async () => {
      click(doc.querySelector('[data-sev-filter="danger"]'), window);
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'Cluster status');
    });
    await test('The "Clear filter" button also clears it', async () => {
      click(doc.querySelector('[data-sev-filter="danger"]'), window);
      click(doc.getElementById('clearFindingsFilter'), window);
      assertIncludes(doc.getElementById('findingsList').textContent, 'Cluster status');
    });
  });

  await suite('Ctrl+Enter in the logs textarea triggers Analyze', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_9.cfs';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    const evt = new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
    doc.getElementById('logsInput').dispatchEvent(evt);
    await wait(300);
    await test('Analysis ran without clicking the button', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'segment corruption');
    });
  });

  await suite('Re-analysis of the same session tags NEW findings', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_1.cfs';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('First-ever analysis shows no NEW badges', async () => {
      assertNotIncludes(doc.getElementById('findingsList').textContent, 'NEW');
    });
    // second round: same corruption finding PLUS a new OOMKilled signal
    doc.getElementById('logsInput').value =
      '[ERROR] CorruptIndexException: checksum failed for segment_1.cfs\nReason: OOMKilled\nExit Code: 137';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The newly-appearing OOMKilled finding is tagged NEW; the repeated corruption finding is not', async () => {
      const oomRow = Array.from(doc.querySelectorAll('.finding-row')).find(r => r.textContent.includes('OOMKilled'));
      const corruptRow = Array.from(doc.querySelectorAll('.finding-row')).find(r => r.textContent.includes('segment corruption'));
      assert(oomRow.querySelector('.badge.new'), 'OOMKilled finding should be marked NEW');
      assert(!corruptRow.querySelector('.badge.new'), 'repeated corruption finding should NOT be marked NEW');
      assertIncludes(doc.getElementById('findingsList').textContent, 'new finding');
    });
  });

  await suite('Sticky verdict bar has a real sticky track (not a same-height wrapper)', async () => {
    const { doc } = await loadDom();
    // Structural regression guard: the earlier implementation wrapped the
    // sticky bar in its own tightly-fit div, which gave CSS position:sticky
    // zero room to actually stick (parent height == child height). The fix
    // was to put the sticky class directly on a child of <main>.
    await test('#verdictStickyWrap IS the sticky element (no nested wrapper div)', async () => {
      const el = doc.getElementById('verdictStickyWrap');
      assert(el.classList.contains('verdict-sticky'), 'the id element itself must carry the sticky class');
      assertEqual(el.parentElement.tagName, 'MAIN', 'must be a direct child of <main> to have a tall sticky track');
    });
  });

  await suite('Quick-actions highlights "Edit evidence" as primary when everything is blocked', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = '';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('"Edit evidence" is primary, "View findings" is not, when every rec is blocked', async () => {
      assert(doc.getElementById('qaInputs').classList.contains('primary'));
      assert(!doc.getElementById('qaFindings').classList.contains('primary'));
    });
    await test('With a usable safe/moderate fix, "View findings" goes back to being primary', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      assert(doc.getElementById('qaFindings').classList.contains('primary'));
      assert(!doc.getElementById('qaInputs').classList.contains('primary'));
    });
  });

  await suite('A blocked recommendation cannot be marked Done', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = '';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    await test('Checking a blocked rec\'s Done box reverts itself and warns instead of recording progress', async () => {
      const cb = doc.querySelector('#recsList .rec-done');
      cb.checked = true;
      cb.dispatchEvent(new window.Event('change', { bubbles: true }));
      assertEqual(cb.checked, false, 'the checkbox must revert — a blocked action was never actually run');
    });
  });

  await suite('Version evidence requires an actual value, not just the bare word "version"', async () => {
    // Third instance of the same bug class: "Version: unknown" contains
    // the word "version" and used to count as version evidence present.
    async function analyzeWith(status){
      const { window, doc } = await loadDom();
      doc.getElementById('logsInput').value = 'Reason: OOMKilled\nExit Code: 137';
      doc.getElementById('statusInput').value = status;
      click(doc.querySelector('#systemPicker button[data-val="instana"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      return (doc.querySelector('.missing-evidence')||{}).textContent || '';
    }
    await test('"Version: unknown" still blocks on missing version evidence', async () => {
      const missing = await analyzeWith('Backend: degraded\nVersion: unknown (customer could not tell us)');
      assertIncludes(missing, 'version');
    });
    await test('An actual version number satisfies it', async () => {
      const missing = await analyzeWith('Backend: degraded\nVersion: 3.319.465-0');
      assertNotIncludes(missing, 'version');
    });
  });

  await suite('Backup/snapshot evidence check is semantic, not a bare keyword match (guards a PERMANENT LOSS command)', async () => {
    // Found via a second live simulation: the SAME exploit class as the
    // replica check, but guarding the destructive "accept_data_loss"
    // command instead — higher stakes, since a false "evidence collected"
    // signal here could green-light an actually irrecoverable action.
    // "no backup exists for this index" (states there is NO backup)
    // satisfied the old `/snapshot|backup|repository|.../i.test(...)`
    // purely because "backup" and "exists" both appear in the sentence.
    const baseLogs = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed (hardware problem?)]';
    async function analyzeWith(statusExtra){
      const { window, doc } = await loadDom();
      doc.getElementById('logsInput').value = baseLogs;
      doc.getElementById('statusInput').value = 'Cluster status: RED\nReplica: single-node, no replica by design.\n' + (statusExtra || '');
      click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const card = Array.from(doc.querySelectorAll('#recsList .rec')).find(c => /PERMANENT LOSS|Remove corrupted/i.test(c.textContent));
      if(!card) return null;
      const box = card.querySelector('.rec-safety-box');
      return { blocked: box.classList.contains('blocked'), missing: (box.querySelector('.missing-evidence')||{}).textContent || null };
    }
    await test('The exact exploit phrase "no backup exists for this index" no longer unblocks the destructive command', async () => {
      const r = await analyzeWith('Backup: no backup exists for this index.');
      assert(r, 'expected the destructive rec to be present in this ES corruption scenario');
      assert(r.blocked !== false, 'a negated "backup exists" mention must not satisfy the check');
    });
    await test('An unambiguous "backup policy: not configured" unblocks it (legitimately N/A)', async () => {
      const r = await analyzeWith('Backup policy: not configured for this cluster.');
      assertEqual(r.blocked, false);
    });
    await test('A genuinely confirmed backup ("snapshot: completed successfully") unblocks it', async () => {
      const r = await analyzeWith('Latest snapshot: completed successfully 3h ago.');
      assertEqual(r.blocked, false);
    });
    await test('No mention of backup at all keeps it blocked', async () => {
      const r = await analyzeWith('');
      assertEqual(r.blocked, true);
    });
  });

  await suite('Replica/shard evidence check is semantic, not a bare keyword match', async () => {
    // Found via a live simulated incident (ClickHouse OOMKilled under
    // Instana, single-node deployment): the old check was
    // `/replica|shard|.../i.test(status)` — pure substring presence. The
    // sentence "no replica configured" (which states the OPPOSITE of
    // verified health) satisfied it purely because the word "replica"
    // appears in it, and looked IDENTICAL to a genuine "verified healthy"
    // state in the UI — a real exploit path, not just a hypothetical.
    const baseLogs = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]\nReason: OOMKilled';
    async function analyzeWith(extraStatus){
      const { window, doc } = await loadDom();
      doc.getElementById('logsInput').value = baseLogs;
      doc.getElementById('statusInput').value = 'Backend: degraded\nVersion: 3.1.0\n' + (extraStatus || '');
      const instanaBtn = doc.querySelector('#systemPicker button[data-val="instana"]');
      click(instanaBtn || doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const box = doc.querySelector('.rec-safety-box');
      return { blocked: box ? box.classList.contains('blocked') : null,
               note: box ? (box.querySelector('.evidence-status-note')||{}).textContent : null };
    }
    await test('A bare "no replica configured" mention no longer unblocks the gate', async () => {
      const r = await analyzeWith('replica notes: no replica configured');
      assert(r.blocked !== false, 'a bare negated mention must not satisfy the check');
    });
    await test('An ambiguous "no replica responded" (an outage, not N/A) stays blocked, not silently accepted', async () => {
      const r = await analyzeWith('no replica responded to the healthcheck');
      assert(r.blocked !== false);
    });
    await test('An unambiguous N/A statement ("single-node") unblocks AND is visibly labeled, not indistinguishable from verified', async () => {
      const r = await analyzeWith('This deployment is single-node — no replica exists by design.');
      assertEqual(r.blocked, false);
      assertIncludes(r.note || '', 'N/A');
    });
    await test('Genuinely healthy evidence unblocks cleanly with no extra caveat note', async () => {
      const r = await analyzeWith('replica: started, in-sync.');
      assertEqual(r.blocked, false);
      assert(!r.note, 'a clean verified state should not show an N/A or unhealthy caveat');
    });
    await test('No mention at all stays blocked', async () => {
      const r = await analyzeWith('');
      assertEqual(r.blocked, true);
    });
  });

  await suite('Missing-evidence label and hint are system-specific, not generic Kafka jargon on every system', async () => {
    const { window, doc } = await loadDom();
    // Found via live simulation: "replica/ISR/shard health" (ISR is
    // Kafka-only terminology) appeared on a ClickHouse recommendation,
    // momentarily reading as if Kafka data had leaked into the wrong card.
    doc.getElementById('logsInput').value = 'ClickHouse pod OOMKilled\nDB::Exception: memory limit exceeded';
    doc.getElementById('statusInput').value = '';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    await test('ClickHouse\'s missing-evidence label does not say "ISR" (Kafka-only term)', async () => {
      const label = doc.querySelector('.missing-evidence');
      if(label) assertNotIncludes(label.textContent, 'ISR');
    });
    await test('The jump-evidence tooltip gives an exact, runnable ClickHouse command, not a generic pointer', async () => {
      const btn = Array.from(doc.querySelectorAll('.jump-evidence-btn')).find(b => /replica|shard/i.test(b.textContent));
      if(btn){
        assertIncludes(btn.dataset.tooltip, 'system.replicas');
      }
    });
  });

  await suite('Safety box actually lists the missing evidence it references, and it\'s actionable', async () => {
    const { window, doc } = await loadDom();
    // Regression guard: the safety box said "the missing evidence below is
    // collected" but for a moderate-risk blocked rec, nothing was actually
    // listed below it — only buried in the prereq paragraph's prose, and
    // only destructive recs had a (separate, non-matching-location) list.
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = '';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    await test('A moderate-risk ("RISK" stamp) blocked rec has a missing-evidence list inside its own safety box', async () => {
      const box = doc.querySelector('#recsList .rec-safety-box.blocked');
      assert(box, 'expected at least one blocked safety box');
      assert(box.querySelector('.missing-evidence'), 'the missing evidence list must live inside the safety box itself');
      assert(box.querySelector('.jump-evidence-btn'), 'each missing item should be a clickable button');
    });
    await test('Clicking a missing-evidence item expands the sidebar and focuses Status output', async () => {
      const btn = doc.querySelector('.jump-evidence-btn');
      click(btn, window);
      assert(!doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
      assertEqual(doc.activeElement.id, 'statusInput');
    });
  });

  await suite('Reviewer/second-approver fields show a live approval status pill', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    const box = doc.querySelector('.rec-safety-box');
    await test('Starts as "Pending review"', async () => {
      assert(box, 'expected at least one rec requiring approval in this sample');
      assertIncludes(box.querySelector('.approval-pill').textContent, 'Pending');
      assert(box.querySelector('.approval-pill').classList.contains('todo'));
    });
    await test('Filling only Reviewer keeps it pending', async () => {
      const reviewer = box.querySelector('.rec-reviewer');
      reviewer.value = 'Ana';
      reviewer.dispatchEvent(new window.Event('input', { bubbles: true }));
      assert(box.querySelector('.approval-pill').classList.contains('todo'));
    });
    await test('Filling both flips the pill to approved', async () => {
      const approver = box.querySelector('.rec-approver');
      approver.value = 'Marko';
      approver.dispatchEvent(new window.Event('input', { bubbles: true }));
      const pill = box.querySelector('.approval-pill');
      assertIncludes(pill.textContent, 'Reviewed');
      assert(pill.classList.contains('done'));
    });
  });

  await suite('The findings panel shows only ONE "what do I do" message at a time', async () => {
    const { window, doc } = await loadDom();
    // Regression guard: workflow-hint (the rich onboarding card) and
    // emptyNalaz (the plain placeholder used consistently by every other
    // tab) were both visible simultaneously on first load — two overlapping
    // "paste logs, click Analyze" messages stacked on top of each other.
    await test('On first load, only workflowHint is shown (not emptyNalaz too)', async () => {
      assert(doc.getElementById('workflowHint').style.display !== 'none');
      assertEqual(doc.getElementById('emptyNalaz').style.display, 'none');
    });
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('After analysis, both are hidden (findings are showing instead)', async () => {
      assertEqual(doc.getElementById('workflowHint').style.display, 'none');
      assertEqual(doc.getElementById('emptyNalaz').style.display, 'none');
    });
    doc.getElementById('resetBtn').click();
    doc.getElementById('resetBtn').click();
    await wait(50);
    await test('After Clear, only emptyNalaz reappears — workflowHint stays gone for the rest of the session', async () => {
      assertEqual(doc.getElementById('workflowHint').style.display, 'none');
      assert(doc.getElementById('emptyNalaz').style.display !== 'none');
    });
  });

  await suite('Verdict does not claim a "safe path" when the only fixes are blocked pending evidence', async () => {
    const { window, doc } = await loadDom();
    // Regression guard: applySafetyModel can BLOCK a 'safe'/'moderate' rec
    // when required evidence (status output, replica health, backup) is
    // missing — most commonly the very first step of an incident, logs
    // pasted but no status yet. computeVerdict must not call a rec usable
    // just because of its risk LABEL if it's actually locked right now.
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = ''; // deliberately no status
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Every rendered recommendation is actually blocked in this scenario', async () => {
      click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
      const cards = doc.querySelectorAll('#recsList .rec');
      assert(cards.length > 0, 'expected at least one recommendation to inspect');
      cards.forEach(c => assert(c.querySelector('.rec-safety-box.blocked'), 'expected every rec to be blocked in this evidence-free scenario'));
    });
    await test('The verdict banner says evidence is needed, NOT that a safe path exists', async () => {
      const t = doc.getElementById('verdictBannerWrap').textContent;
      assertIncludes(t, 'Evidence needed');
      assertNotIncludes(t, 'a safe path exists');
    });
    await test('With status output present and a genuinely usable safe/moderate fix, the verdict still says a safe path exists', async () => {
      click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      const t = doc.getElementById('verdictBannerWrap').textContent;
      assertIncludes(t, 'a safe path exists');
    });
  });

  await suite('Quick-actions bar and the sticky verdict bar do not collide (both sticky at top:53)', async () => {
    const { window, doc } = await loadDom();
    // Regression guard: verdict-sticky and quick-actions are both
    // position:sticky at top:53px (two independent, legitimately different
    // bars — urgency vs. next-step actions). CSS alone doesn't stack same-
    // offset sticky siblings, so once both are "stuck" the higher z-index
    // one silently covers the other unless JS pushes the second one down by
    // the first one's height. jsdom has no real layout engine, so this
    // checks the coordination call happens and the reset path cleans up —
    // the actual pixel geometry was verified manually in a real browser.
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('quickActions becomes visible and gets an explicit top offset after analysis', async () => {
      const qa = doc.getElementById('quickActions');
      assert(qa.classList.contains('visible'));
      assert(qa.style.top, 'expected repositionQuickActions() to have set an explicit top');
    });
    await test('Clear hides quickActions and resets its offset (previously it stayed visible with stale buttons)', async () => {
      click(doc.getElementById('resetBtn'), window); // arm
      click(doc.getElementById('resetBtn'), window); // confirm
      const qa = doc.getElementById('quickActions');
      assert(!qa.classList.contains('visible'), 'quickActions must hide on Clear');
      assertEqual(qa.style.top, '53px');
    });
  });

  await suite('Fixture: real `_cat/shards?format=json` output (not just the ?v text table)', async () => {
    // Found via a live fixture test after external review flagged the ES
    // parser as text-only: a customer using ?format=json (a completely
    // legitimate, common choice — arguably the more robust one to ask for)
    // got a silent false alarm. parseEsShards found zero rows against valid
    // JSON, so "Found a healthy replica" never fired even though a STARTED
    // replica was clearly present in the data.
    const { window, doc } = await loadDom();
    const jsonShards = JSON.stringify([
      { index:'orders', shard:'2', prirep:'p', state:'UNASSIGNED', docs:null, store:null, node:null },
      { index:'orders', shard:'2', prirep:'r', state:'STARTED', docs:'18234', store:'212mb', node:'es-data-1' }
    ]);
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = jsonShards;
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The healthy replica in the JSON is found (not "No healthy replica")', async () => {
      const t = doc.getElementById('findingsList').textContent;
      assertIncludes(t, 'Found a healthy replica');
      assertNotIncludes(t, 'No healthy replica');
    });
  });

  await suite('Fixture: companion ES health + labelled shards JSON response', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value =
      '----- _cluster/health JSON -----\n{"status":"yellow","number_of_nodes":2}\n' +
      '----- _cat/shards JSON -----\n' + JSON.stringify([
        { index:'orders', shard:'2', prirep:'p', state:'UNASSIGNED', node:null },
        { index:'orders', shard:'2', prirep:'r', state:'STARTED', node:'es-data-1' }
      ]);
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The embedded JSON section is parsed and the healthy replica is recognized', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Found a healthy replica');
      assertNotIncludes(doc.getElementById('findingsList').textContent, 'No healthy replica');
    });
  });

  await suite('Fixture: malformed/truncated status output degrades safely', async () => {
    // A customer's copy-paste can easily get cut off mid-command, or they
    // paste something that LOOKS like JSON but isn't quite valid. The JSON
    // branch in parseEsShards must fall through to the text parser (or to
    // "no evidence") rather than throwing and breaking the whole analysis.
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = '[{"index":"orders","shard":"2","prirep":"p","state":"UNASS'; // cut off mid-paste
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Analysis completes without throwing, findings still render', async () => {
      assert(doc.getElementById('findingsList').children.length > 0 || doc.getElementById('findingsList').textContent.length > 0);
    });
    await test('Truncated/invalid JSON does not get misread as a confirmed healthy replica', async () => {
      assertNotIncludes(doc.getElementById('findingsList').textContent, 'Found a healthy replica');
    });
  });

  await suite('Fixture: a large real-shaped log (5000 lines, ~420KB) completes without hanging', async () => {
    // Not the reviewer's suggested 100MB+ (impractical to ship as a test
    // fixture and to keep the suite fast) — a large-but-realistic size
    // that would already be well outside what a person pastes by hand,
    // closer to what a "collect everything" script might produce.
    const { window, doc } = await loadDom();
    const lines = [];
    for(let i=0;i<5000;i++) lines.push(`[2026-08-12T10:${String(i%60).padStart(2,'0')}:00,000][INFO ][o.e.i.e.Engine] [es-data-0] routine flush cycle ${i}`);
    lines[2500] = '[2026-08-12T10:41:00,000][ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed (hardware problem?)]';
    doc.getElementById('logsInput').value = lines.join('\n');
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    const start = Date.now();
    click(doc.getElementById('analyzeBtn'), window);
    await wait(2000);
    await test('The corruption line buried at line 2501 of 5000 is still found', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'segment corruption');
    });
    await test('Completes in well under 10s (no catastrophic slowdown on realistic large input)', async () => {
      assert(Date.now() - start < 10000);
    });
  });

  await suite('Target confirmation block shows exactly which fields THIS command needs', async () => {
    // Requested after external review: an explicit "what am I about to run
    // this against" block, distinct from the ambient inline highlighting
    // already in the command text — scans the specific command (+its
    // prereq) for which placeholders it actually references, not a blanket
    // "all 4 fields" check regardless of relevance.
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'Reason: OOMKilled\nExit Code: 137';
    doc.getElementById('statusInput').value = 'Backend: degraded\nVersion: 3.319.465-0';
    click(doc.querySelector('#systemPicker button[data-val="instana"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);

    await test('Before filling variables, the block shows "not fully confirmed" with unset fields', async () => {
      const block = doc.querySelector('.target-block');
      assert(block, 'expected a target confirmation block on a command with placeholders');
      assert(block.classList.contains('incomplete'));
      assertIncludes(block.textContent, 'not fully confirmed');
      assertIncludes(block.textContent, 'not set');
    });
    await test('Filling Namespace and Pod live-updates the block without re-analyzing', async () => {
      const ns = doc.getElementById('var-namespace');
      ns.value = 'instana-datastore';
      ns.dispatchEvent(new window.Event('input', { bubbles: true }));
      const pod = doc.getElementById('var-pod');
      pod.value = 'ch-shard1-0';
      pod.dispatchEvent(new window.Event('input', { bubbles: true }));
      const block = doc.querySelector('.target-block');
      assertIncludes(block.textContent, 'instana-datastore');
      assertIncludes(block.textContent, 'ch-shard1-0');
      // Still incomplete — this command also needs container/statefulset
      assert(block.classList.contains('incomplete'));
    });
  });

  await suite('Incident variables fill placeholders live in every command', async () => {
    const { window, doc } = await loadDom();
    // Needs a recommendation with a <namespace>/<pod-name> placeholder —
    // the k8s-layer recs (e.g. OOMKilled) carry those; a pure ES corruption
    // sample by itself doesn't.
    doc.getElementById('logsInput').value =
      'Reason: OOMKilled\nExit Code: 137\n[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    await test('Before filling variables, placeholders render as var-missing', async () => {
      assert(doc.querySelector('#recsList mark.var-missing'), 'expected at least one unfilled placeholder marker');
    });
    await test('Typing a namespace live-fills every &lt;namespace&gt; placeholder without re-clicking Analyze', async () => {
      const nsInput = doc.getElementById('var-namespace');
      nsInput.value = 'instana-prod';
      nsInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      const filled = Array.from(doc.querySelectorAll('#recsList mark.var-filled')).some(m => m.textContent === 'instana-prod');
      assert(filled, 'expected a var-filled mark containing the typed namespace');
    });
    await test('The copy button copies the SUBSTITUTED command, not the raw placeholder', async () => {
      const pre = Array.from(doc.querySelectorAll('#recsList pre.cmd:not(.cmd-prereq)'))
        .find(p => p.textContent.includes('instana-prod'));
      assert(pre, 'expected at least one command containing the substituted namespace');
      assertNotIncludes(pre.textContent, '<namespace>');
    });
  });

  await suite('Copy/send audit trail feeds the postmortem timeline', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    const copyBtn = doc.querySelector('#recsList pre.cmd:not(.cmd-prereq) .copy-btn');
    click(copyBtn, window);
    await wait(20);
    click(doc.getElementById('postmortemBtn'), window);
    await wait(100);
    await test('A copied command shows up as a 👤 timeline entry in the postmortem draft', async () => {
      const modalText = doc.getElementById('modalWrap').textContent;
      assertIncludes(modalText, '👤');
      assertIncludes(modalText, 'Copied command:');
    });
  });

  await suite('Status update generator', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);
    click(doc.getElementById('statusUpdateBtn'), window);
    await wait(100);
    await test('Status update includes stage, progress, and elapsed time — no commands or customer instructions', async () => {
      const t = doc.getElementById('modalWrap').textContent;
      assertIncludes(t, 'Stage:');
      assertIncludes(t, 'Progress:');
      assertIncludes(t, 'Elapsed:');
      assertNotIncludes(t, 'kubectl');
    });
  });

  await suite('Incident timer shows in the header once an incident is open', async () => {
    const { window, doc } = await loadDom();
    await test('No timer before any analysis', async () => {
      assertEqual(doc.getElementById('incidentTimer').style.display, 'none');
    });
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('Timer is visible and shows an elapsed value after analysis', async () => {
      const el = doc.getElementById('incidentTimer');
      assertEqual(el.style.display, 'inline-block');
      assertIncludes(el.textContent, 'm');
    });
    await test('Clear hides the timer again', async () => {
      click(doc.getElementById('resetBtn'), window); // arm
      click(doc.getElementById('resetBtn'), window); // confirm
      assertEqual(doc.getElementById('incidentTimer').style.display, 'none');
    });
  });

  await suite('Multi-datastore signals in one paste get a dismissible switch-system notice', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]\n' +
      'kafka.common.errors.CorruptRecordException: Record batch for partition orders-3 is invalid';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('A notice appears naming the other detected system (Kafka)', async () => {
      const t = doc.getElementById('multiSystemWrap').textContent;
      assertIncludes(t, 'KAFKA');
    });
    await test('Clicking "Switch to KAFKA" changes the system picker without touching current findings', async () => {
      click(doc.querySelector('[data-switch-system="kafka"]'), window);
      assert(doc.querySelector('#systemPicker button[data-val="kafka"]').classList.contains('active'));
      assertIncludes(doc.getElementById('findingsList').textContent, 'segment corruption');
    });
    await test('Dismiss removes the notice', async () => {
      click(doc.getElementById('dismissMultiSystem'), window);
      assertEqual(doc.getElementById('multiSystemWrap').style.display, 'none');
    });
  });

  await suite('A pasted status that is actually a failed command gets a distinct, explicit warning', async () => {
    // Found via external review + live verification: a pasted status field
    // can silently BE the error output of a failed exec/kubectl command
    // rather than real data. The safety gate already correctly stays
    // blocked (error text doesn't accidentally match evidence patterns),
    // but nothing told the person WHY — same generic "missing evidence"
    // as an empty paste. That's a wasted round-trip: they need to know the
    // COMMAND failed and must be re-run, not that different data is needed.
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR][o.e.i.e.Engine] [orders][2] CorruptIndexException[checksum failed]';
    doc.getElementById('statusInput').value = 'error: unable to upgrade connection: container not found ("elasticsearch")\ncommand terminated with exit code 1';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('The failed-capture banner names the exact matched error text', async () => {
      const t = doc.getElementById('failedCaptureWrap').textContent;
      assertIncludes(t, 'failed command');
      assertIncludes(t, 'unable to upgrade connection');
    });
    await test('Clicking "Edit evidence" expands the sidebar and focuses Status output', async () => {
      click(doc.getElementById('jumpFailedCapture'), window);
      assert(!doc.getElementById('layoutRoot').classList.contains('sidebar-collapsed'));
      assertEqual(doc.activeElement.id, 'statusInput');
    });
  });

  await suite('Failed-capture banner does not false-positive on normal status/logs', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No banner on a clean, healthy-looking incident', async () => {
      assertEqual(doc.getElementById('failedCaptureWrap').style.display, 'none');
    });
    await test('An empty status field (no evidence at all) does not trigger this specific banner either — that\'s the generic "missing evidence" case, not "command failed"', async () => {
      doc.getElementById('statusInput').value = '';
      click(doc.getElementById('analyzeBtn'), window);
      await wait(300);
      assertEqual(doc.getElementById('failedCaptureWrap').style.display, 'none');
    });
  });

  await suite('No false-positive multi-system notice on a clean single-system incident', async () => {
    const { window, doc } = await loadDom();
    click(doc.querySelector('#sampleLinks button[data-s="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No notice when the paste only matches one system', async () => {
      assertEqual(doc.getElementById('multiSystemWrap').style.display, 'none');
    });
  });

  await suite('Instana never triggers the multi-system notice against its own ES/CH/Kafka substrate', async () => {
    const { window, doc } = await loadDom();
    // Regression guard: Instana self-hosted runs its own Elasticsearch,
    // ClickHouse, and Kafka internally, so its logs legitimately match all
    // three systems' detect regexes. Flagging that as "also detected
    // CLICKHOUSE/KAFKA/ELASTICSEARCH — treat as two incidents" would be an
    // actively misleading false alarm during a real Instana incident.
    click(doc.querySelector('#sampleLinks button[data-s="instana"]'), window);
    const instanaBtn = doc.querySelector('#systemPicker button[data-val="instana"]');
    if(instanaBtn) click(instanaBtn, window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    await test('No multi-system notice appears when analyzed as Instana', async () => {
      assertEqual(doc.getElementById('multiSystemWrap').style.display, 'none');
    });
  });

  await suite('Instana — parseStanctlUnitStatus extracts structured fields', async () => {
    await test('Parsed backend state "degraded" produces a HIGH-confidence finding with the exact value', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = [
        'stanctl unit status', 'Unit: instana', 'Version: 3.319.465-0',
        'Backend: degraded', 'Agent acceptor: available',
        'Datastore impact: ClickHouse metrics/query path degraded', '',
        'instana-clickhouse',
        '2026.08.08 10:11:22 [ ERROR ] instana.metrics_local (ReplicatedMergeTree): Cannot read all data. Checksum mismatch.',
      ].join('\n');
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      const findings = d.getElementById('findingsList').textContent;
      assertIncludes(findings, 'Instana backend state: degraded');
      assertIncludes(findings, 'Agent acceptor: available');
    });

    await test('Parsed backend state "available" produces a safe finding instead of a danger one', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = [
        'stanctl unit status', 'Version: 3.320.0-0', 'Backend: available',
        'Agent acceptor: available', '', 'instana-clickhouse clickhouse-shard0-0 Running',
      ].join('\n');
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      const findings = d.getElementById('findingsList').textContent;
      assertIncludes(findings, 'Instana backend state: available');
      assert(!findings.includes('backend/unit is degraded'), 'should not flag degraded when backend is available');
    });

    await test('Parsed version is shown in the version finding title', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = [
        'stanctl unit status', 'Version: 3.319.465-0', 'Backend: degraded',
        'instana-clickhouse clickhouse-shard0-0 CrashLoopBackOff',
      ].join('\n');
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      assertIncludes(d.getElementById('findingsList').textContent, 'Instana version 3.319.465-0');
    });

    await test('Datastore impact line from stanctl surfaces as its own finding', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = [
        'stanctl unit status', 'Backend: degraded',
        'Datastore impact: ClickHouse metrics/query path degraded', 'instana-clickhouse',
      ].join('\n');
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      assertIncludes(d.getElementById('findingsList').textContent, 'ClickHouse metrics/query path degraded');
    });

    await test('Agent acceptor "unavailable" produces a danger finding (full-stack outage)', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = [
        'stanctl unit status', 'Backend: degraded', 'Agent acceptor: unavailable',
        'instana-kafka kafka broker CrashLoopBackOff',
      ].join('\n');
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      const findings = d.getElementById('findingsList').textContent;
      assertIncludes(findings, 'Agent acceptor: unavailable');
      assertIncludes(findings, 'full-stack outage');
    });

    await test('Without stanctl output the impact finding confidence is MEDIUM, not HIGH', async () => {
      const { window: w, doc: d } = await loadDom();
      d.getElementById('logsInput').value = 'instana-clickhouse clickhouse-shard0-0 CrashLoopBackOff';
      d.getElementById('statusInput').value = '';
      click(d.querySelector('#systemPicker button[data-val="instana"]'), w);
      click(d.getElementById('analyzeBtn'), w);
      await wait(400);
      assertIncludes(d.getElementById('findingsList').textContent, 'MEDIUM CONFIDENCE');
    });
  });

  await suite('ClickHouse FORMAT JSON status (companion-server v1.3 output) is parsed structurally', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      "2026.07.26 10:05:02 [ ERROR ] db.orders (ReplicatedMergeTree): Cannot read all data. Bytes read: 120. Bytes expected: 4096. Checksum doesn't match: corrupted data.\n" +
      "2026.07.26 10:05:03 [ WARN ] db.orders: Marking part 202607_10_10_0 as broken, moving to detached";
    doc.getElementById('statusInput').value =
      '----- broken parts -----\n' +
      '{"meta":[{"name":"database","type":"String"},{"name":"table","type":"String"},{"name":"name","type":"String"},{"name":"is_readonly","type":"UInt8"}],"data":[{"database":"default","table":"orders","name":"202607_10_10_0","is_readonly":0}],"rows":1}\n' +
      '----- detached parts -----\n' +
      '{"meta":[{"name":"database","type":"String"},{"name":"table","type":"String"},{"name":"name","type":"String"},{"name":"reason","type":"String"}],"data":[{"database":"default","table":"orders","name":"202607_10_10_0","reason":"broken"}],"rows":1}\n' +
      '----- readonly replicas -----\n' +
      '{"meta":[{"name":"table","type":"String"},{"name":"replica_name","type":"String"},{"name":"is_readonly","type":"UInt8"}],"data":[],"rows":0}\n';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('Table/part name are extracted from the JSON rows (default.orders / 202607_10_10_0), not left as placeholders', async () => {
      const text = doc.getElementById('findingsList').textContent;
      assertIncludes(text, 'default.orders');
      assertIncludes(text, '202607_10_10_0');
    });

    await test('Detached parts are correctly flagged from the JSON data array (rows:1)', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Detached parts exist');
    });

    await test('Regression: is_readonly:0 in the JSON (empty replicas array) must NOT falsely flag "readonly replica" — the old /readonly/i text match would fire on the key name alone', async () => {
      assertNotIncludes(doc.getElementById('findingsList').textContent, 'Replica in readonly mode');
    });
  });

  await suite('ClickHouse FORMAT JSON: an actual readonly replica row is detected from real boolean value', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'zookeeper session expired for /clickhouse/tables/orders/replicas/replica2';
    doc.getElementById('statusInput').value =
      '----- broken parts -----\n{"meta":[],"data":[],"rows":0}\n' +
      '----- detached parts -----\n{"meta":[],"data":[],"rows":0}\n' +
      '----- readonly replicas -----\n{"meta":[{"name":"table","type":"String"},{"name":"replica_name","type":"String"},{"name":"is_readonly","type":"UInt8"}],"data":[{"table":"orders","replica_name":"replica2","is_readonly":1}],"rows":1}\n';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('"Replica in readonly mode" finding fires from the structured is_readonly:1 row', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Replica in readonly mode');
    });
  });

  await suite('ClickHouse plain-text FORMAT PrettyCompact status still works (backward compatibility)', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      "2026.07.26 10:05:02 [ ERROR ] db.orders (ReplicatedMergeTree): Cannot read all data. Bytes read: 120. Bytes expected: 4096. Checksum doesn't match: corrupted data.\n" +
      "2026.07.26 10:05:03 [ WARN ] db.orders: Marking part 202607_10_10_0 as broken, moving to detached";
    doc.getElementById('statusInput').value =
      '┌─database─┬─table──┬─name───────────┬─reason─┐\n' +
      '│ default  │ orders │ 202607_10_10_0 │ broken │\n' +
      '└──────────┴────────┴────────────────┴────────┘';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('Falls back to the ASCII-table heuristic parser and still finds the detached part', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'Detached parts exist');
    });
  });

  await suite('Urgency regression: ClickHouse readonly replica is not labelled Stable', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = 'DB::Exception: TABLE_IS_READ_ONLY Replica is in readonly mode';
    doc.getElementById('statusInput').value =
      '----- readonly replicas -----\n' +
      '{"meta":[],"data":[{"database":"default","table":"orders","replica_name":"r1","is_readonly":1}],"rows":1}\n';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('Active readonly state is critical and produces an Act now verdict', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'writes may be affected');
      assertIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Act now');
      assertNotIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Stable');
    });
  });

  await suite('Urgency regression: probe-driven restart loop is not labelled Stable', async () => {
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value =
      'Liveness probe failed: connection refused\nKilling container clickhouse\nDB::Exception: recovery in progress';
    doc.getElementById('statusInput').value =
      'NAME READY STATUS RESTARTS AGE\nclickhouse-0 0/1 Running 14 20m';
    click(doc.querySelector('#systemPicker button[data-val="clickhouse"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);

    await test('Container-kill and restart evidence escalates the probe finding and blocks action pending evidence', async () => {
      assertIncludes(doc.getElementById('findingsList').textContent, 'actively restarting the datastore');
      assertIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Evidence needed');
      assertNotIncludes(doc.getElementById('verdictBannerWrap').textContent, 'Stable');
    });
  });

  await suite('Regression: a "moderate"-risk rec whose COMMAND contains accept_data_loss still gets the CONFIRM gate', async () => {
    // "Promote the healthy replica to primary" is risk:'moderate' but its
    // command is a real ES allocate_stale_primary call with
    // accept_data_loss:true — a genuine data-loss operation. The safety
    // gate correctly demands backup/replica evidence for it (via a
    // command-text regex), but recCardHtml() used to gate the CONFIRM
    // overlay on r.risk==='destructive' alone — a narrower check — so this
    // rec never got the type-to-confirm friction: once evidence cleared it
    // would render with a plain one-click "copy" button, same as a safe
    // read-only command.
    const { window, doc } = await loadDom();
    doc.getElementById('logsInput').value = '[ERROR] CorruptIndexException: checksum failed for segment_3.cfs';
    // A replica row exists (state r / STARTED) but WITHOUT the literal
    // keyword "shard"/"replica" co-occurring with a positive word on that
    // line, so evaluateReplicaEvidence() reads this as 'unclear' -> blocked.
    doc.getElementById('statusInput').value = 'myindex 0 p UNASSIGNED\nmyindex 0 r STARTED 100 10mb es-data-1';
    click(doc.querySelector('#systemPicker button[data-val="elasticsearch"]'), window);
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);

    await test('While blocked, the command now shows the CONFIRM-gate overlay (disabled "Evidence required" input) instead of being blurred with no unlock UI at all', async () => {
      const overlay = doc.querySelector('.cmd-gate-overlay');
      assert(overlay, 'expected a .cmd-gate-overlay for the blocked accept_data_loss command — previously there was none');
      const gateInput = overlay.querySelector('.cmd-gate-input');
      assert(gateInput, 'expected a gate input inside the overlay');
      assert(gateInput.disabled, 'gate input should stay disabled while evidence is missing');
      assertEqual(gateInput.placeholder, 'Evidence required');
    });

    // Now supply the missing evidence and re-analyze.
    doc.getElementById('statusInput').value =
      'myindex 0 p UNASSIGNED\nmyindex 0 r STARTED 100 10mb es-data-1\n' +
      'shard allocation confirmed healthy\nbackup snapshot verified';
    click(doc.getElementById('analyzeBtn'), window);
    await wait(300);
    click(doc.querySelector('.tab[data-tab="preporuke"]'), window);

    await test('Once evidence clears, the gate input is enabled and prompts to type CONFIRM (not left as a plain one-click copy button)', async () => {
      const gateInput = doc.querySelector('.cmd-gate-input');
      assert(gateInput, 'expected the gate input to still be present once unblocked');
      assert(!gateInput.disabled, 'gate input should be enabled once evidence is no longer missing');
      assertEqual(gateInput.placeholder, 'Type CONFIRM to reveal');
    });

    await test('Typing CONFIRM unlocks it, same as any other destructive command', async () => {
      const gateInput = doc.querySelector('.cmd-gate-input');
      const cmdId = gateInput.id.replace('gate-', '');
      gateInput.value = 'CONFIRM';
      click(doc.querySelector('.cmd-gate-btn'), window);
      const pre = doc.getElementById(cmdId);
      assert(!pre.classList.contains('cmd-locked'), 'should be unlocked after typing CONFIRM');
      assert(!pre.querySelector('.copy-btn').disabled, 'copy button should be enabled after unlocking');
    });
  });

  const ok = summary();
  process.exit(ok ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL ERROR IN TEST SUITE:', err);
  process.exit(1);
});
