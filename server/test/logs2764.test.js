// v2.764 — vCenter 이벤트 수집 지연(실서버 OC2 — 2026-10-10 에서 13일 정체 · 10분당 상한보다 빨리 생성 · 재시작 8회로 커서 유실).
//  ① 따라잡기: 한 주기에 상한에 걸린 vCenter 는 같은 주기 안에서 이어 읽는다(상한 100 · 이벤트 350 → 4회차에 전부 저장) · 저장 0(stalled)이면 반복하지 않는다.
//  ② ended 반영: 수집기가 배열에 실은 ended('pages'·'aborted')를 폴러가 상한처럼 다룬다(쪽 수 한도로 끝났는데 건수가 상한 미만이어도).
//  ③ 커서 영속: _readCursor·_collectOk 를 CONFIG_DIR/vcenter-logs-cursor.json 에 저장하고 모듈을 다시 읽어도(재시작) 같은 커서에서 잇는다.
//  ④ 진단: logStatus().collect 의 vCenter 별 필드 · 범위 계정은 범위 밖 vCenter 와 오류 원문이 지워진다 · lastRun.lagging.
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
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Math.floor(Date.now() / H) * H;   // 정시 경계로 고정(규칙)
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const P = await import('../src/logs/poller.js');
const { saveLogSettings } = await import('../src/logs/settings.js');
const { getLogsDb } = await import('../src/logs/db.js');
const { scopeVcLogStatus } = await import('../src/routes/admin/backupNetSec.js');

function fakeVcenter() {
  const state = { events: [], view: [], served: 0, begins: [], collectors: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.begins.push(begin); state.collectors++;
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
const quiet = () => { const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {}); return () => { w.mock.restore(); l.mock.restore(); }; };
const registry = (srv, id) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [{ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 }] }));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });

test('순수 — ended 반영·따라잡기 판정·예산·커서 항목 정규화', () => {
  // ② 쪽 수 한도·데드라인으로 끝났으면 건수가 상한 미만이어도 capped(V4-4 잔여 — '쪽 수 한도로 끝났는데 4만 미만')
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 1000 }));
  for (const ended of ['pages', 'aborted', 'max']) { const a = ev(5); a.ended = ended; assert.equal(P.eventsCompleteUntil(a, { startedAt: T0 + H, max: 100 }).capped, true, ended); assert.equal(P.eventsCompleteUntil(a, { startedAt: T0 + H, max: 100 }).at, T0 + 4000); }
  const e = ev(5); e.ended = 'empty';
  assert.deepEqual(P.eventsCompleteUntil(e, { startedAt: T0 + H, max: 100 }), { at: T0 + H, capped: false });
  assert.equal(P.eventsCompleteUntil(ev(100), { startedAt: T0 + H, max: 100 }).capped, true, 'ended 가 없으면(옛 수집기·mock) 건수로');
  // ① 따라잡기 판정 — capped 이고 저장이 있고 회차·예산 안일 때만
  const base = { capped: true, stored: 10, rounds: 1, elapsedMs: 1000, budgetMs: 480_000 };
  assert.equal(P.shouldContinueCatchup(base), true);
  assert.equal(P.shouldContinueCatchup({ ...base, capped: false }), false);
  assert.equal(P.shouldContinueCatchup({ ...base, stored: 0 }), false, '읽었는데 저장 0(stalled)이면 반복하지 않는다');
  assert.equal(P.shouldContinueCatchup({ ...base, rounds: P.CATCHUP_MAX_ROUNDS }), false);
  assert.equal(P.shouldContinueCatchup({ ...base, elapsedMs: 480_000 }), false);
  assert.equal(P.catchupBudgetMs(10), 480_000, '10분 주기의 80%');
  assert.equal(P.catchupBudgetMs(0), 480_000, '잘못된 주기는 기본 10분');
  assert.equal(P.catchupBudgetMs(1), 48_000);
  // ③ 커서 항목 — numOrNull 판정 · 미래 시각은 지금으로 자름 · 쓸 값이 없으면 null
  const now = T0;
  assert.deepEqual(P.normalizeCursorEntry({ readTs: now + DAY, okAt: '', capped: 'yes', events: '12', consecutiveCapped: -1 }, now), { readTs: now, okAt: null, capped: false, events: 12, consecutiveCapped: 0, ended: null });
  assert.equal(P.normalizeCursorEntry({ readTs: null, okAt: 'abc' }, now), null);
  assert.equal(P.normalizeCursorEntry([1, 2], now), null);
  assert.equal(P.normalizeCursorEntry({ readTs: 0 }, now), null, '0 은 커서가 아니다');
  assert.deepEqual(P.normalizeCursorEntry({ okAt: now - 5, capped: true, ended: 'pages' }, now), { readTs: null, okAt: now - 5, capped: true, events: 0, consecutiveCapped: 0, ended: 'pages' });
});

test('실제 폴러 — 상한에 걸린 vCenter 는 같은 주기에서 이어 읽어 전부 저장한다(상한 100 · 350건 → 4회차) · 커서 파일이 생긴다 · 진단 필드', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    registry(srv, 'oc2');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    const db = await getLogsDb();
    const t0 = T0 - 2 * DAY;
    state.events = Array.from({ length: 350 }, (_, i) => ({ key: `a${i}`, ts: t0 + i * 60_000 }));
    const r = await P.pollLogsOnce({ manual: true });
    assert.equal(r.collected, 350, `한 주기에 전부 저장(예전에는 100건 — 다음 주기까지 대기): ${JSON.stringify(r)}`);
    assert.equal(db.lastTs('oc2'), t0 + 349 * 60_000);
    assert.equal(state.collectors, 4, '회차 4번(100·100·100·50) — 마지막 회차가 상한 미만이라 멈춤');
    assert.deepEqual(state.begins.slice(1), [t0 + 99 * 60_000 + 1, t0 + 199 * 60_000 + 1, t0 + 299 * 60_000 + 1], '회차마다 읽은 커서 다음부터');
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
    assert.deepEqual({ read: c.lastPoll.read, stored: c.lastPoll.stored, rounds: c.lastPoll.rounds, deadlineMs: c.lastPoll.deadlineMs, error: c.lastPoll.error }, { read: 350, stored: 350, rounds: 4, deadlineMs: 60_000, error: null });
    assert.ok(Number.isFinite(c.lastPoll.ms) && c.lastPoll.ms >= 0);
    assert.ok(c.ratePerMin == null || c.ratePerMin >= 0);
    assert.equal(st.maxPerPollEffective, 100); assert.equal(st.collectorMaxEvents, 40_000);
    assert.deepEqual(st.catchup, { budgetMs: 480_000, maxRounds: P.CATCHUP_MAX_ROUNDS, ratio: 0.8 });
    // ③ 커서 파일(상태 파일 — 원자적 쓰기)
    assert.ok(fs.existsSync(CURSOR), '주기 뒤 커서 파일이 있다');
    const saved = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    assert.equal(saved.vcenters.oc2.readTs, t0 + 349 * 60_000);
    assert.equal(saved.vcenters.oc2.okAt, c.okAt);
    assert.equal(saved.vcenters.oc2.capped, false);
    assert.equal((fs.statSync(CURSOR).mode & 0o777), 0o600);
    const { isRuntimeStateFile } = await import('../src/backup/service.js');
    assert.equal(isRuntimeStateFile('vcenter-logs-cursor.json'), true, '상태 파일 — 주기마다 바뀌는데 설정으로 보면 change 백업이 10분마다 생긴다');
  } finally { restore(); await closeSrv(srv); }
});

test('실제 폴러 — 읽었는데 저장 0(심각도 필터)인 vCenter 는 반복하지 않고(stalled) 지연을 밝힌다 · 재시작(모듈 재로드)해도 커서가 db.lastTs 로 되돌아가지 않는다', async () => {
  const restore = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    registry(srv, 'oc9');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'warning', pollIntervalMin: 10 }); // 정보 이벤트는 저장하지 않는다
    const t0 = T0 - 3 * DAY;
    state.events = Array.from({ length: 250 }, (_, i) => ({ key: `e${i}`, ts: t0 + i * 60_000 }));
    const r1 = await P.pollLogsOnce({ manual: true });
    assert.deepEqual((r1.stalled || []).map((x) => x.vcenterId), ['oc9']);
    assert.equal(state.collectors, 1, '저장 0 이면 같은 주기에서 반복하지 않는다(무한 루프 방지)');
    assert.equal(P.logCollectOkAt('oc9'), t0 + 99 * 60_000, '상한에 걸렸으니 마지막으로 읽은 이벤트 시각까지만 온전');
    assert.deepEqual(r1.lagging?.map((x) => x.vcenterId), ['oc9'], '온전한 시각이 3일 전 — 1일 넘는 지연을 lastRun 에 싣는다');
    assert.ok(r1.lagging[0].lagMs > DAY);
    const st1 = await P.logStatus();
    const c1 = st1.collect.find((x) => x.vcenterId === 'oc9');
    assert.equal(c1.state, 'stalled'); assert.equal(c1.capped, true); assert.equal(c1.ended, 'max'); assert.equal(c1.consecutiveCapped, 1);
    assert.equal(c1.count, null, '저장된 행이 없으니 보관 목록에 없다 — 0 이 아니라 null');
    assert.equal(c1.lastStoredTs, null);
    assert.deepEqual({ read: c1.lastPoll.read, stored: c1.lastPoll.stored, rounds: c1.lastPoll.rounds }, { read: 100, stored: 0, rounds: 1 });
    // 재시작 흉내 — 같은 파일을 새 모듈 인스턴스로(인메모리 기록이 없다). 커서 파일이 없었다면 db.lastTs(0 — 저장이 없다) → 7일 전부터 다시 읽었을 것.
    const P2 = await import('../src/logs/poller.js?reload=2764');
    assert.equal(P2.logCollectOkAt('oc9'), null, '새 인스턴스는 기록이 없다(로드는 첫 수집 전)');
    state.begins.length = 0;
    const r2 = await P2.pollLogsOnce({ manual: true });
    assert.equal(state.begins[0], t0 + 99 * 60_000 + 1, `재로드 뒤 첫 수집은 저장된 커서 다음부터(예전에는 db.lastTs → 7일 전부터): ${new Date(state.begins[0]).toISOString()}`);
    assert.equal(P2.logCollectOkAt('oc9'), t0 + 199 * 60_000);
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

test('범위 가림 — scopeVcLogStatus 가 collect 의 범위 밖 vCenter 를 지우고 오류 원문을 숨긴다 · lagging·stalled 도 범위 안만', () => {
  const st = {
    settings: { maxPerPoll: 5000 }, lastRun: { at: 1, collected: 9, lagging: [{ vcenterId: 'a', lagMs: 2 * DAY }, { vcenterId: 'b', lagMs: 3 * DAY }], stalled: [{ vcenterId: 'b', read: 1, stored: 0 }] },
    store: { vcenters: [{ vcenterId: 'a', count: 1, lastTs: 5 }, { vcenterId: 'b', count: 2, lastTs: 6 }] },
    collect: [
      { vcenterId: 'a', lastPoll: { read: 1, stored: 1, error: 'connect ECONNREFUSED 10.1.2.3:443' } },
      { vcenterId: 'b', lastPoll: { read: 0, stored: 0, error: null } },
      { vcenterId: 'c', lastPoll: null },
    ],
  };
  const out = scopeVcLogStatus(st, new Set(['a']));
  assert.deepEqual(out.collect.map((c) => c.vcenterId), ['a']);
  assert.equal(out.collect[0].lastPoll.error, null, '오류 원문(vCenter 주소)은 전체 범위 관리자만');
  assert.equal(out.collect[0].lastPoll.errorHidden, true);
  assert.equal(out.collect[0].lastPoll.read, 1);
  assert.equal(out.collectOmitted, 2);
  assert.deepEqual(out.lastRun.lagging, [{ vcenterId: 'a', lagMs: 2 * DAY }]); assert.equal(out.lastRun.laggingOmitted, 1);
  assert.deepEqual(out.lastRun.stalled, []); assert.equal(out.lastRun.stalledOmitted, 1);
  assert.equal(st.collect[0].lastPoll.error, 'connect ECONNREFUSED 10.1.2.3:443', '원본은 바꾸지 않는다');
  assert.equal(scopeVcLogStatus(st, null), st, '전체 범위는 원본 그대로');
});
