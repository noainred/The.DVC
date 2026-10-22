// v2.756 — vCenter 이벤트 수집이 한 지점에서 영원히 멈추던 결함(실서버: OC2 vCenter 가 2026-10-10 04:32 에서 12일째).
// 수집 시작점이 '로그 DB 에 마지막으로 저장된 시각'뿐이라, 읽은 이벤트가 하나도 저장되지 않으면(① vCenter 이벤트 번호가 다시 매겨져
// 보관 중인 옛 번호와 겹침 — 중복 키가 번호 하나였다 ② 최소 심각도로 전부 걸러짐) 다음 주기가 같은 구간을 다시 읽고 다시 버렸다.
// 실제 로그 폴러 + 가짜 SOAP vCenter(beginTime 을 지킨다)로 재현한다.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logs2756-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const H = 3_600_000;
const P = await import('../src/logs/poller.js');

test('순수 — 중복 키는 번호@시각 · 시작점은 저장·읽은 시각 중 늦은 것', () => {
  assert.equal(P.eventRowKey({ key: '1001', ts: 5 }), '1001@5');
  assert.equal(P.eventRowKey({ key: '', ts: 5 }), null);
  assert.equal(P.eventRowKey({ ts: 5 }), null);
  assert.equal(P.nextSinceTs(100, 250), 251);
  assert.equal(P.nextSinceTs(300, 250), 301);
  assert.equal(P.nextSinceTs(0, 0, { now: 10 * 24 * H, firstDays: 7 }), 3 * 24 * H);
});

/** beginTime 이후 이벤트만 오래된 것부터 내주는 가짜 vCenter. */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts);
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>VSPHERE.LOCAL\\Administrator</userName><vm><name>vm-${e.key}</name></vm><fullFormattedMessage>Task: Create virtual machine snapshot</fullFormattedMessage></returnval>`).join('');
        return send(`<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}

test('실제 폴러 — vCenter 이벤트 번호가 다시 매겨져도(옛 번호와 겹침) 새 이벤트를 저장하고 앞으로 나아간다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'oc2', name: 'OC2', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 }] }));
    const { saveLogSettings } = await import('../src/logs/settings.js');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info' });
    const { getLogsDb } = await import('../src/logs/db.js');
    const db = await getLogsDb();
    const t0 = Date.now() - 48 * H;
    // 재배포 전 vCenter — 번호 1..100
    state.events = Array.from({ length: 100 }, (_, i) => ({ key: String(i + 1), ts: t0 + i * 60_000 }));
    await P.pollLogsOnce({ manual: true });
    const last1 = db.lastTs('oc2');
    assert.equal(last1, t0 + 99 * 60_000);
    // 재배포 뒤 — 번호가 1 부터 다시(150건, 상한 100)
    const t1 = t0 + 24 * H;
    state.events = [...state.events, ...Array.from({ length: 150 }, (_, i) => ({ key: String(i + 1), ts: t1 + i * 60_000 }))];
    await P.pollLogsOnce({ manual: true });
    const last2 = db.lastTs('oc2');
    assert.equal(last2, t1 + 99 * 60_000, `겹친 번호의 새 이벤트도 저장돼 앞으로 나아가야 한다(예전에는 ${new Date(last1).toISOString()} 에 멈췄다)`);
    await P.pollLogsOnce({ manual: true });
    assert.equal(db.lastTs('oc2'), t1 + 149 * 60_000, '다음 주기에 나머지를 읽는다');
    assert.equal(db.countCapped({ vcenterId: 'oc2' }, 1000).total, 250, '옛 100건 + 새 150건(중복 없이)');
    // 같은 이벤트를 다시 읽어도(같은 번호·같은 시각) 두 번 저장하지 않는다
    const again = state.events.slice(-1).map((e) => ({ vcenterId: 'oc2', key: P.eventRowKey(e), ts: e.ts, severity: 'info', type: 'TaskEvent', user: '', entity: '', message: 'dup' }));
    await db.insertManyAsync(again);
    assert.equal(db.countCapped({ vcenterId: 'oc2' }, 1000).total, 250);
  } finally { warn.mock.restore(); log.mock.restore(); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('실제 폴러 — 상한만큼 읽은 것이 전부 걸러져도(최소 심각도) 다음 주기는 읽은 시각부터 · 멈춘 사실을 결과에 남긴다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'oc9', name: 'OC9', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 }] }));
    const { saveLogSettings } = await import('../src/logs/settings.js');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'warning' }); // 정보 이벤트는 저장하지 않는다
    const t0 = Date.now() - 10 * H;
    state.events = Array.from({ length: 250 }, (_, i) => ({ key: `e${i}`, ts: t0 + i * 60_000 }));
    const r1 = await P.pollLogsOnce({ manual: true });
    assert.deepEqual((r1.stalled || []).map((x) => x.vcenterId), ['oc9'], `읽었는데 저장되지 않은 상한 주기를 밝힌다: ${JSON.stringify(r1)}`);
    await P.pollLogsOnce({ manual: true });
    assert.equal(P.logCollectOkAt('oc9'), t0 + 199 * 60_000, '두 번째 주기는 101번째 이벤트부터 읽는다(예전에는 매번 처음 100건)');
  } finally { warn.mock.restore(); log.mock.restore(); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});
