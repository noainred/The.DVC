// v2.781(점검 G1) — vCenter 이벤트 로그 수집 폴러.
//  D-B1  이벤트 1건의 시각이 미래(vCenter 시계가 잠깐 앞섰다가 NTP 로 되돌아옴)면 다음 수집 시작점이 미래에 고정돼 그 사이 이벤트를 영영 못 읽고,
//        온전한 시각(okAt)도 미래라 상태가 '정상·지연 0' 이었다. 재시작해도 db.lastTs(MAX(ts))가 커서 파일 클램프를 이겨 회복되지 않았다.
//        이제 ⓐ 읽은 커서·온전한 시각은 기록할 때 포탈 지금으로 자르고 ⓑ 시작점이 지금 + 여유(10분)를 넘으면 그 후보를 버린다(남은 후보 — 없으면 지금)
//        ⓒ 시계 앞섬 경고는 vCenter 마다 시간당 1줄. 여유 안(조금 앞선 vCenter)은 예전 그대로다 — 매 주기 같은 구간을 다시 읽지 않게.
//  D-I2  수집 커서를 주기 끝에만 저장해 따라잡는 도중 재시작(자동 업그레이드)하면 그 주기 진척을 잃었다 — 묶음 적재 뒤 최대 60초에 1번 중간 저장
//        (이번 주기 DB 키를 싣고, 등록부에 없는 vCenter 정리는 주기 끝 1회만).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2781a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';
process.env.VCLOGS_CONCURRENCY = '1';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Math.floor(Date.now() / H) * H;   // 정시 경계로 고정(규칙 — 순수 판정용)
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const P = await import('../src/logs/poller.js');
const D = await import('../src/logs/db.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter — beginTime 을 지키고, ReadNextEvents 를 받을 때마다 커서 파일을 그 순간 그대로 찍어 둔다(중간 저장 관찰). */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0, begins: [], snaps: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.begins.push({ begin, at: Date.now() });
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts || String(x.key).localeCompare(String(y.key)));
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        let snap = null;
        try { snap = JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch { /* 아직 없다 */ }
        state.snaps.push(snap);
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="VmPoweredOffEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><vm><name>vm-${e.key}</name></vm><fullFormattedMessage>off ${e.key}</fullFormattedMessage></returnval>`).join('');
        return send(`<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeRegistry = (list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list }));
const vcEntry = (id, srv) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 });
/** 테스트마다 새 로그 DB(저장 경로) + 빈 커서(메모리·파일). */
const freshDb = async (name) => {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, storagePath: dir });
  D.resetLogsDb();
  try { fs.rmSync(CURSOR, { force: true }); } catch { /* */ }
  P._resetCursorsForTest();
  return D.getLogsDb();
};
const clockWarns = (w) => w.mock.calls.map((c) => String(c.arguments[0])).filter((s) => /시계/.test(s));

/* ── 순수 ─────────────────────────────────────────────────────────────────────────────────────── */

test('D-B1 순수 — nextSinceTs: 지금 + 여유를 넘는 후보는 버린다(남은 후보 · 없으면 지금) · 여유 안·과거는 예전 그대로(포함)', () => {
  const now = T0;
  assert.equal(P.FUTURE_CLOCK_TOLERANCE_MS, 10 * MIN);
  // 예전 의미 그대로(logs2756·logs2764 와 같은 값)
  assert.equal(P.nextSinceTs(100, 250, { now }), 250);
  assert.equal(P.nextSinceTs(300, 250, { now }), 300);
  assert.equal(P.nextSinceTs(0, 0, { now, firstDays: 7 }), now - 7 * DAY);
  assert.equal(P.nextSinceTs(null, undefined, { now, firstDays: 7 }), now - 7 * DAY, '둘 다 없으면 첫 수집 창');
  // 조금 앞선 vCenter(여유 안) — 자르지 않는다(매 주기 같은 구간을 다시 읽어 거짓 '정체' 가 되지 않게)
  assert.equal(P.nextSinceTs(now + 5 * MIN, now - MIN, { now }), now + 5 * MIN);
  assert.equal(P.nextSinceTs(now + 10 * MIN, null, { now }), now + 10 * MIN, '경계(= 여유)는 그대로');
  // 미래에 고정된 저장 시각 — 읽은 커서(지금 이하)로 잇는다
  assert.equal(P.nextSinceTs(now + 3 * H, now - 2 * MIN, { now }), now - 2 * MIN);
  // 읽은 커서도 없거나 둘 다 미래 — 지금
  assert.equal(P.nextSinceTs(now + 3 * H, null, { now }), now);
  assert.equal(P.nextSinceTs(now + 3 * H, now + 2 * H, { now }), now);
  // 어떤 입력이든 결과는 지금 + 여유를 넘지 않는다
  for (const s of [0, now - DAY, now, now + 9 * MIN, now + 11 * MIN, now + 30 * DAY]) {
    for (const r of [null, 0, now - H, now, now + 20 * MIN]) {
      assert.ok(P.nextSinceTs(s, r, { now }) <= now + P.FUTURE_CLOCK_TOLERANCE_MS, `stored=${s - now} read=${r == null ? r : r - now}`);
    }
  }
});

test('D-I2 순수 — cursorSaveDue: 바뀐 것이 있고 마지막 저장 뒤 간격이 지났을 때만', () => {
  assert.equal(P.CURSOR_MIDCYCLE_SAVE_MS, 60_000);
  assert.equal(P.cursorSaveDue({ dirty: false, lastAt: 0, now: T0 }), false, '바뀐 것 없음');
  assert.equal(P.cursorSaveDue({ dirty: true, lastAt: 0, now: T0 }), true, '아직 저장한 적 없음');
  assert.equal(P.cursorSaveDue({ dirty: true, lastAt: T0 - 59_999, now: T0 }), false);
  assert.equal(P.cursorSaveDue({ dirty: true, lastAt: T0 - 60_000, now: T0 }), true);
  assert.equal(P.cursorSaveDue({ dirty: true, lastAt: T0, now: T0, everyMs: 0 }), true, '간격 0(테스트 주입) — 묶음마다');
  assert.equal(P.cursorSaveDue({ dirty: true, lastAt: T0 + H, now: T0 }), true, '시계가 뒤로 갔으면(마지막 저장이 미래) 저장한다 — 영영 미루지 않게');
});

/* ── 실제 pollLogsOnce + 가짜 SOAP vCenter ───────────────────────────────────────────────────────── */

test('D-B1 — 미래 시각 이벤트 1건 뒤 정상 시각 이벤트를 다음 주기가 읽는다 · 온전한 시각은 지금 이하 · 재시작 뒤에도 시작점이 지금 이하 · 경고 시간당 1줄', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('b1');
    writeRegistry([vcEntry('pl', srv)]);
    const now = Date.now();
    // 주기 1: 정상 10건 + vCenter 시계가 3시간 앞선 순간의 이벤트 1건(NTP 보정 전)
    state.events = Array.from({ length: 10 }, (_, i) => ({ key: i + 1, ts: now - H + i * MIN }));
    state.events.push({ key: 11, ts: now + 3 * H });
    const r1 = await P.pollLogsOnce({ manual: true });
    assert.equal(r1.collected, 11);
    const c1End = Date.now();
    assert.ok(P.logCollectOkAt('pl') <= c1End, `주기 1 온전한 시각이 미래면 안 된다(+${((P.logCollectOkAt('pl') - c1End) / H).toFixed(2)}h)`);
    // 시계 보정 뒤: vCenter 가 정상 시각(주기 1 이 끝난 뒤 · 주기 2 시작 전)의 이벤트 20건을 만든다
    await sleep(40);
    for (let i = 0; i < 20; i++) state.events.push({ key: 100 + i, ts: c1End + 1 + i });
    await sleep(10);
    const r2 = await P.pollLogsOnce({ manual: true });
    const b2 = state.begins[1];
    assert.ok(b2.begin <= b2.at, `주기 2 beginTime 이 미래(+${((b2.begin - b2.at) / H).toFixed(2)}h)`);
    assert.equal(r2.collected, 20, '보정 뒤 정상 시각 이벤트를 읽어 저장한다');
    assert.equal(db.query({ vcenterId: 'pl' }, 1000, 0).length, 31);
    const st = await P.logStatus();
    const c = st.collect.find((x) => x.vcenterId === 'pl');
    assert.ok(c.okAt <= Date.now(), '온전한 시각이 미래면 지연 0·정상 으로 거짓 표시된다');
    assert.ok(c.cursorTs <= Date.now(), '읽은 커서도 지금 이하');
    assert.equal(clockWarns(w).length, 1, `시계 앞섬 경고는 vCenter 마다 시간당 1줄: ${JSON.stringify(clockWarns(w))}`);
    assert.match(clockWarns(w)[0], /pl/);
    // 주기 3(경고 반복 없음 · 다시 같은 구간을 통째로 읽지 않는다)
    await P.pollLogsOnce({ manual: true });
    assert.equal(clockWarns(w).length, 1, '같은 시간 안에는 다시 찍지 않는다');
    // 재시작 흉내 — 커서 파일에서 읽어도 시작점은 지금 이하(DB 의 미래 MAX(ts) 가 이기지 않는다)
    P._resetCursorsForTest();
    P.loadCursorFile({ force: true, dbKey: P.logsDbKey(db) });
    const t = Date.now();
    assert.ok(P.nextSinceTs(db.lastTs('pl'), P.logCollectDiag([], { now: t }).find((x) => x.vcenterId === 'pl')?.cursorTs ?? null, { now: t }) <= t);
    assert.ok(db.lastTs('pl') > t + H, '전제: DB 에는 미래 MAX(ts) 가 남아 있다');
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

// v2.783(점검 Q3 L-B2): 이 단언은 '시작점 = 마지막 저장 시각(vCenter 시각)' 을 고정했는데, 그 시작점은 앞서던 vCenter 를 NTP 로 맞춘 뒤 실제 시각보다
//   앞에 있어 [보정 뒤, 옛 시작점) 의 이벤트를 영영 건너뛰었다(유실). 이제 시작점은 지난 읽기의 **포탈** 시각 이하 — 앞선 폭의 재읽기는 의도된 비용이다.
test('D-B1 — 조금(여유 안) 앞선 vCenter 의 시작점은 지난 읽기의 포탈 시각 이하(v2.783 L-B2 — 보정 뒤 유실 방지) · 경고 없음', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    await freshDb('b1-slight');
    writeRegistry([vcEntry('us', srv)]);
    const now = Date.now();
    state.events = Array.from({ length: 5 }, (_, i) => ({ key: i + 1, ts: now + MIN + i * 1000 }));   // vCenter 시계 1분 앞섬
    await P.pollLogsOnce({ manual: true });
    await P.pollLogsOnce({ manual: true });
    const c = P.logCollectDiag([]).find((x) => x.vcenterId === 'us');
    assert.ok(state.begins[1].begin <= c.cursorReadAt && state.begins[1].begin >= now, `시작점 = 지난 읽기의 포탈 시각 이하(+${state.begins[1].begin - now}ms)`);
    assert.equal(clockWarns(w).length, 0);
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

test('D-I2 — 따라잡는 도중 묶음 적재 뒤 커서를 중간 저장한다(이번 주기 DB 키 · 등록부 정리는 주기 끝에만) · 기본 간격은 60초 스로틀', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('i2');
    writeRegistry([vcEntry('oc2', srv)]);
    const base = Date.now() - 2 * H;
    state.events = Array.from({ length: 350 }, (_, i) => ({ key: i + 1, ts: base + i * 1000 }));
    // 등록부에 없는 vCenter 의 옛 커서 — 중간 저장은 지우지 않고 주기 끝 저장만 지운다
    fs.writeFileSync(CURSOR, JSON.stringify({ savedAt: Date.now(), db: P.logsDbKey(db), vcenters: { gone: { readTs: base, okAt: base } } }));
    await P.pollLogsOnce({ manual: true, cursorSaveEveryMs: 0 });
    // ReadNextEvents 는 100건 쪽 4번 + 빈 쪽 1번 — k 번째 요청 직전 파일에는 (k-1) 번째 묶음까지의 커서가 있어야 한다
    const readTsAt = (k) => state.snaps[k]?.vcenters?.oc2?.readTs ?? null;
    assert.equal(readTsAt(0), null, '첫 쪽 전에는 아직 저장하지 않았다(직접 쓴 옛 파일 그대로)');
    assert.ok(state.snaps[0]?.vcenters?.gone);
    assert.equal(readTsAt(1), base + 99_000, '첫 묶음(100건) 적재 뒤 중간 저장');
    assert.equal(readTsAt(2), base + 199_000);
    assert.equal(readTsAt(3), base + 299_000);
    for (const k of [1, 2, 3]) {
      assert.equal(state.snaps[k].db?.path, db.path, '중간 저장도 이번 주기 DB 키를 싣는다');
      assert.ok(state.snaps[k].vcenters.gone, '중간 저장은 등록부 정리를 하지 않는다');
    }
    const end = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.equal(end.vcenters.oc2.readTs, base + 349_000);
    assert.equal(end.vcenters.gone, undefined, '주기 끝 저장은 등록부에 없는 vCenter 를 지운다');

    // 기본 간격(60초): 같은 주기 안에서는 첫 묶음 뒤 1번만 쓴다
    await freshDb('i2-throttle');
    state.snaps = [];
    state.events = Array.from({ length: 350 }, (_, i) => ({ key: 1000 + i, ts: base + i * 1000 }));
    await P.pollLogsOnce({ manual: true });
    assert.equal(readTsAt(1), base + 99_000, '첫 묶음 뒤 저장(마지막 저장이 60초보다 오래전)');
    assert.equal(readTsAt(2), base + 99_000, '60초 안에는 다시 쓰지 않는다');
    assert.equal(readTsAt(3), base + 99_000);
    assert.equal(JSON.parse(fs.readFileSync(CURSOR, 'utf8')).vcenters.oc2.readTs, base + 349_000, '주기 끝 저장은 스로틀과 무관');
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});
