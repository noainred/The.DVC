// v2.765 — vCenter 이벤트 수집 지연(실서버 OC2 — 2026-10-10 에서 13일 정체 · 10분당 상한보다 빨리 생성 · 재시작 8회로 커서 유실).
//  ① 따라잡기(재검토 1-a·1-c): 밀린 vCenter 는 **한 세션·한 컬렉터**로 묶음(EVENT_BATCH_ROWS)마다 적재하며 이어 읽는다(로그인은 주기에 1회) — 350건 · 묶음 100 → 1세션 4묶음.
//  ② ended 반영: 수집기가 배열에 실은 ended('pages'·'aborted'·'budget'·'batch')를 폴러가 상한처럼 다룬다.
//  ③ 커서 영속: _readCursor·_collectOk 를 CONFIG_DIR/vcenter-logs-cursor.json 에 저장하고 모듈을 다시 읽어도(재시작) 같은 커서에서 잇는다.
//     (재검토 2-b) 다음 since 는 읽은 시각 **포함** — 같은 ms 의 나머지를 건너뛰지 않는다 · (3-b) 다른 로그 DB 의 커서는 무시 · (3-c) 지운 vCenter 항목은 정리.
//  ④ 진단: logStatus().collect 의 vCenter 별 필드 · 범위 계정은 범위 밖 vCenter 와 오류 원문이 지워진다 · lastRun.lagging · (2-c) 시한 힌트.
//  ⑤ 데드라인(재검토 2-a): abort 뒤 정리(Destroy·Logout)가 느려도 부분 결과가 유예 안에 돌아온다.
// 가짜 SOAP vCenter 는 logs2756 와 같은 패턴(beginTime 을 지킨다 — CreateCollectorForEvents 요청의 beginTime 을 기록한다).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logs2764-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';   // 묶음 100 — 350건이 4묶음이 되게(기본 2,000)
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Math.floor(Date.now() / H) * H;   // 정시 경계로 고정(규칙)
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const P = await import('../src/logs/poller.js');
const { saveLogSettings } = await import('../src/logs/settings.js');
const { getLogsDb } = await import('../src/logs/db.js');
const { scopeVcLogStatus } = await import('../src/routes/admin/backupNetSec.js');
const { collectVCenterEvents } = await import('../src/vcenter/soapClient.js');

/** 가짜 vCenter. readDelay — ReadNextEvents 응답 지연(ms) · cleanupDelay — DestroyCollector·Logout 응답 지연 · hang — 그 op 는 응답하지 않는다. */
function fakeVcenter({ readDelay = 0, cleanupDelay = 0, hang = null } = {}) {
  const state = { events: [], view: [], served: 0, begins: [], collectors: 0, ops: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      state.ops.push([op, Date.now()]);
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === hang) return;   // 응답하지 않는다(건별 시한이 끊는다)
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.begins.push(begin); state.collectors++;
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts || String(x.key).localeCompare(String(y.key)));
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>VSPHERE.LOCAL\\Administrator</userName><vm><name>vm-${e.key}</name></vm><fullFormattedMessage>Task: Create virtual machine snapshot</fullFormattedMessage></returnval>`).join('');
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
const registry = (srv, ids, extra = {}) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [].concat(ids).map((id) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000, ...extra })) }));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

test('순수 — ended 반영·예산·since 포함·커서 항목 정규화·DB 키 비교', () => {
  // ② 쪽 수 한도·데드라인·예산·중간 묶음으로 끝났으면 건수가 상한 미만이어도 capped(V4-4 잔여 — '쪽 수 한도로 끝났는데 4만 미만')
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 1000 }));
  for (const ended of ['pages', 'aborted', 'max', 'budget', 'batch']) { const a = ev(5); a.ended = ended; assert.equal(P.eventsCompleteUntil(a, { startedAt: T0 + H, max: 100 }).capped, true, ended); assert.equal(P.eventsCompleteUntil(a, { startedAt: T0 + H, max: 100 }).at, T0 + 4000); }
  const e = ev(5); e.ended = 'empty';
  assert.deepEqual(P.eventsCompleteUntil(e, { startedAt: T0 + H, max: 100 }), { at: T0 + H, capped: false });
  assert.equal(P.eventsCompleteUntil(ev(100), { startedAt: T0 + H, max: 100 }).capped, true, 'ended 가 없으면(옛 수집기·mock) 건수로');
  // ① 예산(재검토 1-b) — vCenter 자기 시작 시각 기준 80%, 주기 끝(꼬리 30초 제외)을 넘지 않게, 바닥은 최소 예산
  assert.equal(P.catchupBudgetMs(10), 480_000, '10분 주기의 80%');
  assert.equal(P.catchupBudgetMs(0), 480_000, '잘못된 주기는 기본 10분');
  assert.equal(P.catchupBudgetMs(1), 48_000);
  assert.equal(P.vcCatchupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 }), 480_000, '첫 순번 — 자기 80%');
  assert.equal(P.vcCatchupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 + 480_000 }), 90_000, '뒤 순번 — 주기 끝 − 꼬리(30초) − 지금');
  assert.equal(P.vcCatchupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 + 590_000 }), P.CATCHUP_MIN_BUDGET_MS, '주기가 거의 끝났어도 최소 예산(굶지 않는다)');
  assert.equal(P.vcCatchupBudgetMs({ everyMs: 60_000, cycleStart: T0, now: T0 }), 30_000, '1분 주기 — 자기 80%(48초)보다 주기 끝(30초)이 먼저');
  assert.equal(P.EVENT_BATCH_ROWS, 100, '환경 변수 VCLOGS_BATCH_ROWS');
  // ③ since 는 포함(재검토 2-b) · 커서 항목 — numOrNull 판정 · 미래 시각은 지금으로 자름 · 쓸 값이 없으면 null
  assert.equal(P.nextSinceTs(100, 250), 250);
  assert.equal(P.nextSinceTs(300, 250), 300);
  const now = T0;
  assert.deepEqual(P.normalizeCursorEntry({ readTs: now + DAY, okAt: '', capped: 'yes', events: '12', consecutiveCapped: -1 }, now), { readTs: now, okAt: null, capped: false, events: 12, consecutiveCapped: 0, ended: null });
  assert.equal(P.normalizeCursorEntry({ readTs: null, okAt: 'abc' }, now), null);
  assert.equal(P.normalizeCursorEntry([1, 2], now), null);
  assert.equal(P.normalizeCursorEntry({ readTs: 0 }, now), null, '0 은 커서가 아니다');
  assert.deepEqual(P.normalizeCursorEntry({ okAt: now - 5, capped: true, ended: 'budget' }, now), { readTs: null, okAt: now - 5, capped: true, events: 0, consecutiveCapped: 0, ended: 'budget' });
  // ③ DB 키(3-b) — 종류·경로가 다르면 다른 DB · inode 는 둘 다 있을 때만 · 한쪽이 없으면 비교하지 않는다(옛 파일)
  assert.equal(P.sameLogsDb({ kind: 'sqlite', path: '/a/x.db', ino: '1' }, { kind: 'sqlite', path: '/a/x.db', ino: '1' }), true);
  assert.equal(P.sameLogsDb({ kind: 'sqlite', path: '/a/x.db', ino: '1' }, { kind: 'sqlite', path: '/a/x.db', ino: '2' }), false, '같은 경로의 새 파일');
  assert.equal(P.sameLogsDb({ kind: 'sqlite', path: '/a/x.db', ino: '' }, { kind: 'sqlite', path: '/a/x.db', ino: '2' }), true, 'inode 를 모르면 경로만');
  assert.equal(P.sameLogsDb({ kind: 'sqlite', path: '/a/x.db' }, { kind: 'sqlite', path: '/b/x.db' }), false);
  assert.equal(P.sameLogsDb(null, { kind: 'sqlite', path: '/b/x.db' }), true);
});

test('실제 폴러 — 밀린 vCenter 는 한 세션으로 묶음마다 적재하며 이어 읽어 전부 저장한다(350건 · 묶음 100 → 1세션 4묶음) · 커서 파일(DB 키) · 진단 필드', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    registry(srv, 'oc2');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    const db = await getLogsDb();
    const t0 = T0 - 2 * DAY;
    state.events = Array.from({ length: 350 }, (_, i) => ({ key: `a${i}`, ts: t0 + i * 60_000 }));
    const r = await P.pollLogsOnce({ manual: true });
    assert.equal(r.collected, 350, `한 주기에 전부 저장(예전에는 100건 — 다음 주기까지 대기): ${JSON.stringify(r)}`);
    assert.equal(db.lastTs('oc2'), t0 + 349 * 60_000);
    assert.equal(state.collectors, 1, '한 세션·한 컬렉터(예전 판: 묶음마다 로그인 — 4회)');
    assert.equal(state.ops.filter(([op]) => op === 'Login').length, 1, '로그인은 vCenter 당 주기에 1회');
    assert.equal(state.begins.length, 1);
    assert.equal(r.stalled, undefined);
    assert.equal(r.lagging, undefined, '2일 전 이벤트까지 읽었지만 끝까지 읽었으니 온전한 시각은 수집 시작 시각 — 지연 아님');
    // ④ 진단
    const st = await P.logStatus();
    const c = st.collect.find((x) => x.vcenterId === 'oc2');
    assert.ok(c, JSON.stringify(st.collect));
    assert.equal(c.count, 350); assert.equal(c.lastStoredTs, t0 + 349 * 60_000); assert.equal(c.cursorTs, t0 + 349 * 60_000);
    assert.equal(c.capped, false); assert.equal(c.ended, 'empty'); assert.equal(c.state, 'ok'); assert.equal(c.consecutiveCapped, 0);
    assert.ok(c.okAt >= r.at - 5000 && c.okAt <= Date.now(), '끝까지 읽었으면 수집 시작 시각까지 온전');
    assert.ok(c.lagMs != null && c.lagMs < 60_000);
    assert.deepEqual({ read: c.lastPoll.read, stored: c.lastPoll.stored, rounds: c.lastPoll.rounds, deadlineMs: c.lastPoll.deadlineMs, budgetMs: c.lastPoll.budgetMs, error: c.lastPoll.error, hint: c.lastPoll.hint },
      { read: 350, stored: 350, rounds: 4, deadlineMs: 540_000, budgetMs: 480_000, error: null, hint: null }, '묶음 4개 · 데드라인 = 예산(480초) + 시한(60초)');
    assert.ok(Number.isFinite(c.lastPoll.ms) && c.lastPoll.ms >= 0);
    assert.ok(c.ratePerMin == null || c.ratePerMin >= 0);
    assert.equal(st.maxPerPollEffective, 100); assert.equal(st.collectorMaxEvents, 40_000);
    assert.deepEqual(st.catchup, { budgetMs: 480_000, ratio: 0.8, batchRows: 100, minBudgetMs: 30_000, streaming: true });
    assert.equal(st.busySkips, 0);
    // ③ 커서 파일(상태 파일 — 원자적 쓰기) + 어느 DB 의 것인지
    assert.ok(fs.existsSync(CURSOR), '주기 뒤 커서 파일이 있다');
    const saved = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.equal(saved.vcenters.oc2.readTs, t0 + 349 * 60_000);
    assert.equal(saved.vcenters.oc2.okAt, c.okAt);
    assert.equal(saved.vcenters.oc2.capped, false);
    assert.deepEqual(saved.db, P.logsDbKey(db), '커서가 어느 로그 DB 의 것인지(종류·경로·inode)');
    assert.equal(saved.db.kind, 'sqlite'); assert.equal(saved.db.path, db.path); assert.ok(saved.db.ino);
    assert.equal((fs.statSync(CURSOR).mode & 0o777), 0o600);
    const { isRuntimeStateFile } = await import('../src/backup/service.js');
    assert.equal(isRuntimeStateFile('vcenter-logs-cursor.json'), true, '상태 파일 — 주기마다 바뀌는데 설정으로 보면 change 백업이 10분마다 생긴다');
  } finally { restore(); await closeSrv(srv); }
});

test('실제 폴러 — 예산에 걸려 끝까지 못 읽고 저장 0(심각도 필터)인 vCenter 는 stalled·지연을 밝힌다 · 재시작(모듈 재로드)해도 커서(포함)에서 잇는다', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    registry(srv, 'oc9');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'warning', pollIntervalMin: 10 }); // 정보 이벤트는 저장하지 않는다
    const t0 = T0 - 3 * DAY;
    state.events = Array.from({ length: 250 }, (_, i) => ({ key: `e${i}`, ts: t0 + i * 60_000 }));
    // 예산 1ms — 첫 묶음(100) 뒤 멈춘다(수집기는 첫 쪽을 읽은 뒤부터 예산을 본다 — 느린 vCenter 도 주기마다 나아간다)
    const r1 = await P.pollLogsOnce({ manual: true, budgetMs: 1 });
    assert.deepEqual((r1.stalled || []).map((x) => x.vcenterId), ['oc9']);
    assert.equal(state.collectors, 1);
    assert.equal(P.logCollectOkAt('oc9'), t0 + 99 * 60_000, '끝까지 못 읽었으니 마지막으로 읽은 이벤트 시각까지만 온전');
    assert.deepEqual(r1.lagging?.map((x) => x.vcenterId), ['oc9'], '온전한 시각이 3일 전 — 1일 넘는 지연을 lastRun 에 싣는다');
    assert.ok(r1.lagging[0].lagMs > DAY);
    const st1 = await P.logStatus();
    const c1 = st1.collect.find((x) => x.vcenterId === 'oc9');
    assert.equal(c1.state, 'stalled'); assert.equal(c1.capped, true); assert.equal(c1.ended, 'budget'); assert.equal(c1.consecutiveCapped, 1);
    assert.equal(c1.count, null, '저장된 행이 없으니 보관 목록에 없다 — 0 이 아니라 null');
    assert.equal(c1.lastStoredTs, null);
    assert.deepEqual({ read: c1.lastPoll.read, stored: c1.lastPoll.stored, rounds: c1.lastPoll.rounds, budgetMs: c1.lastPoll.budgetMs }, { read: 100, stored: 0, rounds: 1, budgetMs: 1 }, '마지막 빈 묶음은 세지 않는다');
    // 재시작 흉내 — 같은 파일을 새 모듈 인스턴스로(인메모리 기록이 없다). 커서 파일이 없었다면 db.lastTs(0 — 저장이 없다) → 7일 전부터 다시 읽었을 것.
    const P2 = await import('../src/logs/poller.js?reload=2764');
    assert.equal(P2.logCollectOkAt('oc9'), null, '새 인스턴스는 기록이 없다(로드는 첫 수집 전)');
    state.begins.length = 0;
    const r2 = await P2.pollLogsOnce({ manual: true, budgetMs: 1 });
    assert.equal(state.begins[0], t0 + 99 * 60_000, `재로드 뒤 첫 수집은 저장된 커서(포함)부터(예전 판: +1ms · 그 전: db.lastTs → 7일 전부터): ${new Date(state.begins[0]).toISOString()}`);
    assert.equal(P2.logCollectOkAt('oc9'), t0 + 198 * 60_000, '#99(중복 — 키가 거른다)부터 100건');
    assert.deepEqual((r2.stalled || []).map((x) => x.vcenterId), ['oc9']);
    const c2 = (await P2.logStatus()).collect.find((x) => x.vcenterId === 'oc9');
    assert.equal(c2.consecutiveCapped, 2, '연속 상한 수도 파일에서 잇는다');
    // 손상 파일 — 보존하고 빈 기록으로 시작(다음 저장이 덮어쓰지 않게)
    fs.writeFileSync(CURSOR, '{"vcenters": [');
    const errs = mock.method(console, 'error', () => {});
    try {
      const P3 = await import('../src/logs/poller.js?reload=2764b');
      P3.loadCursorFile({ force: true });
      assert.equal(P3.logCollectOkAt('oc9'), null);
      assert.ok(fs.readdirSync(TMP).some((f) => f.startsWith('vcenter-logs-cursor.json.corrupt.')), '손상본 보존');
      assert.equal(fs.existsSync(CURSOR), false);
    } finally { errs.mock.restore(); }
  } finally { restore(); await closeSrv(srv); }
});

test('실제 폴러(재검토 2-b) — 같은 ms 의 이벤트 사이에서 주기가 끊겨도 다음 주기가 그 시각(포함)부터 읽어 하나도 잃지 않는다(150건 · #98~#101 같은 ms)', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    registry(srv, 'oc5');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    const db = await getLogsDb();
    const t0 = T0 - 2 * DAY;
    // #98·#99·#100·#101 이 같은 ms(t0+98초). 첫 주기는 예산 1ms 라 첫 묶음(100 = #0..#99)에서 끊긴다 → 커서 = t0+98초.
    state.events = Array.from({ length: 150 }, (_, i) => ({ key: `k${String(i).padStart(3, '0')}`, ts: t0 + Math.min(i, 98) * 1000 + Math.max(0, i - 101) * 1000 }));
    const r1 = await P.pollLogsOnce({ manual: true, budgetMs: 1 });
    assert.equal(r1.collected, 100);
    assert.equal(P.logCollectOkAt('oc5'), t0 + 98_000);
    const r2 = await P.pollLogsOnce({ manual: true });
    assert.equal(state.begins[1], t0 + 98_000, `두 번째 주기 beginTime 은 읽은 시각 포함(예전 +1ms 는 #100·#101 을 영영 건너뛰었다): ${state.begins.map((b) => b - t0)}`);
    // v2.766(점검 R1-A2-02): collected 는 실제로 들어간 행 수다 — #98·#99 는 다시 읽지만(read 52) 중복이라 세지 않는다(예전: 시도 수 52).
    assert.equal(r2.collected, 50, '#98·#99 를 다시 읽지만 중복 — 새로 들어간 #100~#149 만 센다');
    assert.equal(P.logCollectDiag([]).find((d) => d.vcenterId === 'oc5').lastPoll.read, 52, '#98·#99 를 다시 읽었다');
    assert.equal(db.countCapped({ vcenterId: 'oc5' }, 1000).total, 150, '#98·#99 는 번호@시각 키가 거르고 #100~#149 만 새로 — 유실 0(예전 재현: 148)');
  } finally { restore(); await closeSrv(srv); }
});

test('데드라인(재검토 2-a) — abort 뒤 정리(Destroy·Logout)가 2초씩 늦어도 읽은 부분 결과가 유예 안에 돌아온다 · 정리 시한을 짧게 주면 정리를 기다리지 않는다', async () => {
  const { srv, state } = fakeVcenter({ readDelay: 400, cleanupDelay: 2000 });
  await listen(srv);
  try {
    state.events = Array.from({ length: 5000 }, (_, i) => ({ key: `d${i}`, ts: T0 - H + i * 100 }));
    const vc = { id: 'dl', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 10_000 };
    // ① 기본(정리 시한 5초 × 2 < 유예 15초): 2초 지연 정리를 기다리고도 부분 결과를 받는다 — 예전(건별 시한 30초 그대로)에는 유예를 넘겨 거부됐다
    let t0 = Date.now();
    const ev = await P.vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs: T0 - 2 * H, max: 40_000, pageSize: 5, signal }), 1500);
    let ms = Date.now() - t0;
    assert.equal(ev.ended, 'aborted'); assert.ok(ev.length >= 5 && ev.length <= 25, `읽은 만큼(${ev.length})`);
    assert.ok(ms >= 1500 && ms < 1500 + 4000 + 1500, `정리 2건(2초씩) 뒤 반환 ${ms}ms`);
    assert.ok(state.ops.some(([op]) => op === 'DestroyCollector') && state.ops.some(([op]) => op === 'Logout'), '정리는 보낸다');
    // ② 정리 시한을 300ms 로(2건 = 600ms) — 유예 1초 안에 돌아온다(정리 응답 2초는 기다리지 않는다 · 호출은 보낸다). 시한이 없었다면 4초 → 거부.
    state.ops.length = 0;
    t0 = Date.now();
    const ev2 = await P.vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs: T0 - 2 * H, max: 40_000, pageSize: 5, signal, cleanupTimeoutMs: 300 }), 1500, { graceMs: 1000 });
    ms = Date.now() - t0;
    assert.equal(ev2.ended, 'aborted'); assert.ok(ev2.length >= 5);
    assert.ok(ms < 1500 + 1000 + 200, `유예 안 반환 ${ms}ms`);
    assert.ok(state.ops.some(([op]) => op === 'DestroyCollector') && state.ops.some(([op]) => op === 'Logout'), '정리 호출은 보낸다(응답을 기다리지 않을 뿐)');
    await new Promise((r) => setTimeout(r, 2300));   // 늦게 오는 정리 응답이 아무 일도 하지 않는지(예외 없음)
  } finally { await closeSrv(srv); }
});

test('스트림 수집기 — onBatch 가 던지면 수집을 멈추고(정리는 하고) 그대로 올린다 · 묶음 ended 는 중간 batch · 마지막 실제 사유 · 반환에 read 가 실린다', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    state.events = Array.from({ length: 250 }, (_, i) => ({ key: `s${i}`, ts: T0 - H + i * 1000 }));
    const vc = { id: 'st', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 };
    const got = [];
    const out = await collectVCenterEvents(vc, { sinceTs: T0 - 2 * H, batchSize: 100, onBatch: async (events, info) => { got.push([events.length, events.ended, info.final, info.batches]); } });
    assert.deepEqual(got, [[100, 'batch', false, 1], [100, 'batch', false, 2], [50, 'empty', true, 3]]);
    assert.equal(out.length, 0); assert.equal(out.read, 250); assert.equal(out.batches, 3); assert.equal(out.ended, 'empty');
    assert.equal(state.collectors, 1, '한 컬렉터');
    // 던지는 콜백 — 두 번째 묶음에서
    state.ops.length = 0;
    let n = 0;
    await assert.rejects(collectVCenterEvents(vc, { sinceTs: T0 - 2 * H, batchSize: 100, onBatch: async () => { if (++n === 2) throw new Error('적재 실패 흉내'); } }), /적재 실패 흉내/);
    assert.equal(n, 2, '던진 뒤 더 읽지 않는다');
    assert.ok(state.ops.some(([op]) => op === 'DestroyCollector') && state.ops.some(([op]) => op === 'Logout'), '정리는 한다');
    // 예산 — 첫 쪽은 읽는다
    const got2 = [];
    const out2 = await collectVCenterEvents(vc, { sinceTs: T0 - 2 * H, batchSize: 100, budgetMs: 1, onBatch: async (events, info) => { got2.push([events.length, events.ended, info.final]); } });
    assert.deepEqual(got2, [[100, 'batch', false], [0, 'budget', true]], '첫 묶음 뒤 예산 소진 — 마지막(빈) 묶음이 사유를 전한다');
    assert.equal(out2.read, 100);
  } finally { await closeSrv(srv); }
});

test('진단(재검토 2-c) — 첫 묶음도 못 받고 요청 시한에 걸린 vCenter 는 failed + hint timeout(화면: timeoutMs 를 올리세요)', async () => {
  const restore = quiet();
  const { srv } = fakeVcenter({ hang: 'CreateCollectorForEvents' });
  await listen(srv);
  try {
    registry(srv, 'oc7', { timeoutMs: 1000 });   // 건별 시한 하한 1초
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    const r = await P.pollLogsOnce({ manual: true });
    assert.deepEqual(r.failed?.map((f) => f.vcenterId), ['oc7']);
    const c = (await P.logStatus()).collect.find((x) => x.vcenterId === 'oc7');
    assert.equal(c.state, 'failed');
    assert.equal(c.lastPoll.hint, 'timeout', `시한 힌트: ${JSON.stringify(c.lastPoll)}`);
    assert.equal(c.lastPoll.read, 0);
    assert.ok(/timeout|abort|데드라인/i.test(c.lastPoll.error));
    const { vcLogHintText } = await import('../../web/src/views/vcLogCollect.js');
    assert.match(vcLogHintText({ hint: 'timeout' }), /timeoutMs/);
  } finally { restore(); await closeSrv(srv); }
});

test('커서 정리(재검토 3-c) — 등록부에서 지운 vCenter 의 커서 항목은 다음 저장에서 지운다 · 등록부가 비면 지우지 않는다', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    registry(srv, ['ka', 'kb']);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    state.events = Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, ts: T0 - DAY + i * 60_000 }));
    await P.pollLogsOnce({ manual: true });
    let saved = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.ok(saved.vcenters.ka && saved.vcenters.kb);
    registry(srv, ['ka']);   // kb 삭제
    await P.pollLogsOnce({ manual: true });
    saved = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.ok(saved.vcenters.ka, '남은 vCenter 는 그대로');
    assert.equal(saved.vcenters.kb, undefined, '지운 vCenter 의 커서 항목은 사라진다(예전: 영구히 남아 지연이 자랐다)');
    assert.equal(P.logCollectOkAt('kb'), null, '인메모리 기록도 지운다');
    const kb = (await P.logStatus()).collect.find((x) => x.vcenterId === 'kb');   // 보관 건수 목록(metaAsync)은 기억(캐시)될 수 있어 행 유무는 단언하지 않는다
    if (kb) assert.ok(kb.cursorTs == null && kb.okAt == null && kb.state == null, `보관 행은 남아도 수집 기록은 없다: ${JSON.stringify(kb)}`);
    // 등록부가 비면(못 읽음) 지우지 않는다
    assert.equal(P.saveCursorFile({ knownIds: new Set(), force: true }), true);
    assert.ok(JSON.parse(fs.readFileSync(CURSOR, 'utf8')).vcenters.ka);
  } finally { restore(); await closeSrv(srv); }
});

test('범위 가림 — scopeVcLogStatus 가 collect 의 범위 밖 vCenter 를 지우고 오류 원문을 숨긴다 · lagging·stalled 도 범위 안만', () => {
  const st = {
    settings: { maxPerPoll: 5000 }, lastRun: { at: 1, collected: 9, lagging: [{ vcenterId: 'a', lagMs: 2 * DAY }, { vcenterId: 'b', lagMs: 3 * DAY }], stalled: [{ vcenterId: 'b', read: 1, stored: 0 }] },
    store: { vcenters: [{ vcenterId: 'a', count: 1, lastTs: 5 }, { vcenterId: 'b', count: 2, lastTs: 6 }] },
    collect: [
      { vcenterId: 'a', lastPoll: { read: 1, stored: 1, error: 'connect ECONNREFUSED 10.1.2.3:443', hint: 'timeout' } },
      { vcenterId: 'b', lastPoll: { read: 0, stored: 0, error: null } },
      { vcenterId: 'c', lastPoll: null },
    ],
  };
  const out = scopeVcLogStatus(st, new Set(['a']));
  assert.deepEqual(out.collect.map((c) => c.vcenterId), ['a']);
  assert.equal(out.collect[0].lastPoll.error, null, '오류 원문(vCenter 주소)은 전체 범위 관리자만');
  assert.equal(out.collect[0].lastPoll.errorHidden, true);
  assert.equal(out.collect[0].lastPoll.read, 1);
  assert.equal(out.collect[0].lastPoll.hint, 'timeout', '힌트는 주소가 없으니 남긴다');
  assert.equal(out.collectOmitted, 2);
  assert.deepEqual(out.lastRun.lagging, [{ vcenterId: 'a', lagMs: 2 * DAY }]); assert.equal(out.lastRun.laggingOmitted, 1);
  assert.deepEqual(out.lastRun.stalled, []); assert.equal(out.lastRun.stalledOmitted, 1);
  assert.equal(st.collect[0].lastPoll.error, 'connect ECONNREFUSED 10.1.2.3:443', '원본은 바꾸지 않는다');
  assert.equal(scopeVcLogStatus(st, null), st, '전체 범위는 원본 그대로');
});

test('로그 설정 PUT 라우트(4-f)는 Veeam 전용 수집기 주기도 재무장한다(동적 import + 함수 존재 확인)', () => {
  const src = fs.readFileSync(new URL('../src/routes/admin/backupNetSec.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("adminRouter.put('/vclogs/settings'"), src.indexOf("adminRouter.post('/vclogs/collect'"));
  assert.match(route, /rescheduleLogPoller\(\);/);
  assert.match(route, /import\('\.\.\/\.\.\/veeam\/snapCollector\.js'\)/);
  assert.match(route, /typeof m\.rescheduleVeeamSnapCollector === 'function'/);
});

test('커서 파일(재검토 3-b) — 다른 로그 DB(경로·파일)의 커서는 무시하고 경고 1줄 · 같은 DB 면 읽는다', async () => {
  const db = await getLogsDb();
  const key = P.logsDbKey(db);
  assert.ok(key && key.kind === 'sqlite' && key.path === db.path && key.ino, JSON.stringify(key));
  P._resetCursorsForTest();
  const warns = [];
  const w = mock.method(console, 'warn', (m) => warns.push(String(m)));
  try {
    fs.writeFileSync(CURSOR, JSON.stringify({ savedAt: T0, db: { ...key, ino: String(Number(key.ino) + 1) }, vcenters: { zz: { readTs: T0 - DAY, okAt: T0 - DAY } } }));
    P.loadCursorFile({ force: true, dbKey: key });
    assert.equal(P.logCollectOkAt('zz'), null, '다른 파일(inode)의 커서는 무시 — 새 DB 가 첫 7일을 채운다');
    assert.equal(warns.filter((m) => /다른 로그 DB/.test(m)).length, 1);
    fs.writeFileSync(CURSOR, JSON.stringify({ savedAt: T0, db: key, vcenters: { zz: { readTs: T0 - DAY, okAt: T0 - DAY } } }));
    P.loadCursorFile({ force: true, dbKey: key });
    assert.equal(P.logCollectOkAt('zz'), T0 - DAY, '같은 DB 면 읽는다');
    fs.writeFileSync(CURSOR, JSON.stringify({ savedAt: T0, vcenters: { yy: { readTs: T0 - DAY, okAt: T0 - DAY } } }));
    P.loadCursorFile({ force: true, dbKey: key });
    assert.equal(P.logCollectOkAt('yy'), T0 - DAY, '옛 파일(DB 키 없음)은 그대로 읽는다');
  } finally { w.mock.restore(); P._resetCursorsForTest(); }
});
