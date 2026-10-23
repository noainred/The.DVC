// v2.766(점검 R1 — 수정 그룹 G2 vCenter 로그 수집기) — 실제 로그 폴러 + 가짜 SOAP vCenter(logs2764 와 같은 패턴 — beginTime 을 지킨다).
//  A2-02: 저장 수는 실제로 들어간 행 수(INSERT OR IGNORE 가 버린 중복 제외) — 새 이벤트 0 인 주기가 'N건 장기 보관' 으로, 중복만 읽은 상한 주기가 stalled 로.
//  A2-03: 마지막 묶음까지 적재한 뒤 정리(DestroyCollector·Logout)가 늦어 데드라인을 넘겨도 수집 실패로 치지 않는다(아무것도 못 읽은 시한 초과는 그대로 실패).
//  A2-01: 실행 중 저장 경로(storagePath)를 바꾸면 인메모리 커서·완결 시각을 비운다 — 새 DB 가 첫 7일을 채우고, 커서 파일이 새 DB 키로 굳어도 재시작 뒤 그대로다.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2766b-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Math.floor(Date.now() / H) * H;   // 정시 경계로 고정(규칙)
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const P = await import('../src/logs/poller.js');
const { saveLogSettings } = await import('../src/logs/settings.js');
const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');

/** 가짜 vCenter. readDelay — ReadNextEvents 응답 지연 · cleanupDelay — DestroyCollector·Logout 응답 지연. */
function fakeVcenter({ readDelay = 0, cleanupDelay = 0 } = {}) {
  const state = { events: [], view: [], served: 0, begins: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { if (!res.writableEnded) { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); } };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.begins.push(begin);
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts || String(x.key).localeCompare(String(y.key)));
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><fullFormattedMessage>m ${e.key}</fullFormattedMessage></returnval>`).join('');
        const body = `<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`;
        return readDelay ? setTimeout(() => send(body), readDelay) : send(body);
      }
      if (op === 'DestroyCollector' || op === 'Logout') return cleanupDelay ? setTimeout(() => send('<Response></Response>'), cleanupDelay) : send('<Response></Response>');
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const quiet = () => { const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {}); return () => { w.mock.restore(); l.mock.restore(); }; };
const registry = (srv, ids) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [].concat(ids).map((id) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 })) }));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const countOf = async (vc) => (await getLogsDb()).count({ vcenterId: vc });

saveLogSettings({ enabled: true });

test('A2-02 — SQLite insertMany/insertManyAsync 는 실제로 들어간 행 수를 돌려준다(중복 제외 · 기존 chunks 유지)', async () => {
  const db = await getLogsDb();
  const rows = (vc, n, off = 0) => Array.from({ length: n }, (_, i) => ({ vcenterId: vc, key: `k${i + off}@${T0 - DAY + (i + off) * 1000}`, ts: T0 - DAY + (i + off) * 1000, severity: 'info', type: 'TaskEvent', user: 'u', entity: 'e', message: 'm' }));
  assert.equal(db.insertMany(rows('ins', 5)), 5);
  assert.equal(db.insertMany(rows('ins', 5)), 0, '같은 키 5건 — 전부 중복');
  const r = await db.insertManyAsync(rows('ins', 8), { chunkRows: 3 });
  assert.equal(r.inserted, 3, '앞 5건 중복 · 뒤 3건만 새로');
  assert.ok(Number.isInteger(r.chunks) && r.chunks >= 1, '기존 반환 필드(chunks) 유지');
  assert.equal(await countOf('ins'), 8);
});

test('A2-02 — 새 이벤트가 없는 주기는 0건 저장 · 중복만 읽은 상한(예산) 주기는 stalled', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter({ readDelay: 5 });
  await listen(srv);
  try {
    registry(srv, 'dup');
    state.events = Array.from({ length: 50 }, (_, i) => ({ key: `e${i}`, ts: T0 - 10 * H + i * 60_000 }));
    const r1 = await P.pollLogsOnce({ manual: true });
    assert.equal(r1.collected, 50);
    assert.equal(await countOf('dup'), 50);
    // 다음 주기 — 시작점이 '읽은 시각 포함'(2-b)이라 마지막 1건을 다시 읽지만 새로 들어간 것은 없다
    const r2 = await P.pollLogsOnce({ manual: true });
    assert.equal(r2.collected, 0, '중복으로 버려진 행을 저장으로 세지 않는다(예전: 1)');
    const lp = P.logCollectDiag([]).find((d) => d.vcenterId === 'dup').lastPoll;
    assert.equal(lp.read, 1); assert.equal(lp.stored, 0);
    assert.equal(P.collectStateOf('dup'), 'ok', '끝까지 읽었다 — 저장 0 이어도 정상');
    // 예산 1ms — 첫 쪽(중복 1건)만 읽고 'budget' 으로 끝난다 → 읽었는데 저장 0 인 상한 주기
    const r3 = await P.pollLogsOnce({ manual: true, budgetMs: 1 });
    assert.equal(r3.collected, 0);
    assert.deepEqual(r3.stalled, [{ vcenterId: 'dup', read: 1, stored: 0 }], '예전에는 저장 1 로 세어 stalled 가 비었다');
    assert.equal(P.collectStateOf('dup'), 'stalled', "예전: 'catching-up'");
  } finally { await closeSrv(srv); restore(); }
});

test('A2-03 — 끝까지 적재한 뒤 정리(Destroy·Logout)가 늦어 데드라인을 넘겨도 실패가 아니다', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter({ cleanupDelay: 600 });
  await listen(srv);
  try {
    registry(srv, 'slowclean');
    state.events = Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, ts: T0 - 5 * H + i * 60_000 }));
    const r = await P.pollLogsOnce({ manual: true, deadlineMs: 200 });
    assert.equal(r.collected, 10);
    assert.equal(r.failed, undefined, '수집 실패 목록에 싣지 않는다');
    const d = P.logCollectDiag([]).find((x) => x.vcenterId === 'slowclean');
    assert.equal(d.lastPoll.error, null);
    assert.equal(P.collectStateOf('slowclean'), 'ok');
    assert.equal(d.capped, false, '끝까지 읽은 수집 — 완결 시각은 수집 시작 시각');
    assert.equal(await countOf('slowclean'), 10);
  } finally { await closeSrv(srv); restore(); }
});

test('A2-03 대조 — 하나도 못 읽고 시한에 걸린 수집은 그대로 실패(시한 힌트 포함)', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter({ readDelay: 2_000 });
  await listen(srv);
  try {
    registry(srv, 'slowread');
    state.events = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, ts: T0 - 5 * H + i * 60_000 }));
    const r = await P.pollLogsOnce({ manual: true, deadlineMs: 200 });
    assert.equal(r.collected, 0);
    assert.equal(r.failed?.[0]?.vcenterId, 'slowread');
    assert.equal(P.collectStateOf('slowread'), 'failed');
    assert.equal(P.logCollectDiag([]).find((x) => x.vcenterId === 'slowread').lastPoll.hint, 'timeout');
  } finally { await closeSrv(srv); restore(); }
});

test('A2-01 — 실행 중 저장 경로 변경: 새 DB 가 첫 7일을 채우고 커서 파일은 새 DB 키로(재시작 뒤에도 그대로)', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    registry(srv, 'mv');
    const now = Date.now();
    state.events = Array.from({ length: 6 * 24 }, (_, i) => ({ key: `m${i}`, ts: now - 6 * DAY + i * H }));   // 최근 6일, 1시간 1건
    await P.pollLogsOnce({ manual: true });
    assert.equal(await countOf('mv'), 144);
    const oldPath = (await getLogsDb()).path;
    // 관리자 설정 › Log 의 저장 경로 변경 — 라우트(backupNetSec PUT /vclogs/settings)와 같은 순서
    const newDir = path.join(TMP, 'newlogs');
    const s = saveLogSettings({ storagePath: newDir });
    assert.equal(s._pathChanged, true);
    resetLogsDb();
    await P.pollLogsOnce({ manual: true });
    const db2 = await getLogsDb();
    assert.notEqual(db2.path, oldPath);
    assert.equal(path.dirname(db2.path), newDir);
    assert.ok(state.begins.at(-1) <= now - 6 * DAY, `새 DB 는 최근 7일부터 읽는다(예전: 옛 DB 의 커서 ${new Date(state.begins.at(-1)).toISOString()})`);
    assert.equal(await countOf('mv'), 144, '새 DB 에 6일치 전부(예전: 1건)');
    const cur = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.equal(cur.db.path, db2.path, '커서 파일은 새 DB 키로 저장');
    // 재시작 흉내 — 파일을 다시 읽어도 새 DB 의 커서다(같은 DB 라 무시되지 않는다)
    P._resetCursorsForTest();
    await P.pollLogsOnce({ manual: true });
    assert.equal(await countOf('mv'), 144);
    assert.ok(state.begins.at(-1) >= now - H, '재시작 뒤에는 새 DB 의 커서에서 잇는다');
    // 같은 DB 에서는 비우지 않는다(순수 판정)
    const k = P.logsDbKey(db2);
    assert.equal(P.syncCursorDbKey(k), false);
    assert.ok(P.logCollectOkAt('mv') != null, '같은 DB — 완결 시각 유지');
  } finally {
    saveLogSettings({ storagePath: '' }); resetLogsDb();
    await closeSrv(srv); restore();
  }
});
