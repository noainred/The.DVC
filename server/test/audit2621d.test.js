/**
 * v2.621 감사 그룹 D — RECENT-04 · LIFE-02 · LIFE-03 회귀.
 *
 *  · RECENT-04: v2.620 이 수집 서버 pull 실패 문구를 `pull 실패(2 · 재시도 없이 1회): …` 로 바꿨는데 로그 분석 규칙
 *    `collector-pull-fail` 은 숫자 바로 뒤의 ')' 만 받아, 이 규칙이 겨냥한 '연속 실패' 줄이 전부 '미분류' 가 됐다.
 *    probe('pull 실패(')는 그대로라 logAnalysis2583 가 못 잡았다 → 여기서는 **puller.js 의 실제 템플릿**을 꺼내
 *    n=1·2·3 문장을 만들어 실제 분석 엔진에 넣는다(문구가 또 바뀌면 이 테스트가 먼저 깨진다).
 *  · LIFE-02: Enterprise 대체 경로의 Redfish 센서 조회가 단계 시한 뒤에도 BMC 로 GET 을 계속 보냈다(signal 미전달).
 *    가짜 Redfish(응답마다 지연)로 '반환 뒤 새 요청 0건' 과 '진행 중 요청이 끊긴다' 를 본다.
 *  · LIFE-03: 작업 로그가 기록 1건마다 전량 직렬화 + 동기 원자 쓰기(fsync)를 해, push 수신 루프의 장비 N대가 N번 썼다.
 *    같은 틱의 기록을 묶어 쓰기 2번(첫 기록 + 틱 끝)이 되는지를 **실제 rename 호출 수**로 센다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621d-'));
process.env.CONFIG_DIR = dir; // config.configDir 는 import 시점에 굳는다 — 모듈을 동적으로 불러오기 전에 둔다

const SRC = new URL('../src/', import.meta.url);

/* ── RECENT-04 ───────────────────────────────────────────────────────────── */
test('RECENT-04 — puller.js 가 실제로 찍는 pull 실패 문장(1·2·3회차)이 전부 collector-pull-fail 로 분류된다', async () => {
  const src = fs.readFileSync(new URL('collector/puller.js', SRC), 'utf8');
  const m = /console\.warn\(`(\[collector\] \$\{c\.id\} pull 실패\([^`]*)`\)/.exec(src);
  assert.ok(m, 'puller.js 에서 pull 실패 문구 템플릿을 찾지 못했다 — 문구 형태가 바뀌었다면 규칙과 이 테스트를 함께 볼 것');
  // eslint-disable-next-line no-new-func
  const render = new Function('c', 'n', 'd', `return \`${m[1]}\`;`);
  const { analyzeBuffer } = await import('../src/loganalysis/index.js');
  const T = 1_790_000_000_000; // 고정 시각(Date.now() 금지 — v2.517 규약)
  for (const n of [1, 2, 3]) {
    const msg = render({ id: 'edge-a' }, n, { message: 'fetch failed (ECONNREFUSED)' });
    const r = await analyzeBuffer([{ time: T, level: 'warn', msg }]);
    const hit = (r.findings || []).find((f) => f.id === 'collector-pull-fail');
    assert.ok(hit, `${n}회차 문장이 규칙에 맞지 않는다(미분류): ${msg}`);
    assert.deepEqual(hit.entities.map((e) => e.name), ['edge-a'], `${n}회차: 대상(수집 서버 id)을 잡아야 한다`);
  }
});

test('RECENT-04 — 규칙 표본은 이 규칙이 겨냥한 2회차 이후 문구이고, 괄호가 닫히지 않은 줄은 받지 않는다', async () => {
  const { CORE_RULES } = await import('../src/loganalysis/rules.js');
  const r = CORE_RULES.find((x) => x.id === 'collector-pull-fail');
  assert.ok(r);
  assert.match(r.sample, /pull 실패\(2 · 재시도 없이 1회\): /, '표본이 예전 문구(2)이면 새 문구가 깨져도 표본 검사가 통과한다');
  assert.ok(r.re.test('[collector] edge-b pull 실패(1): x'), '1회차(부가 문구 없음)');
  assert.ok(!r.re.test('[collector] edge-b pull 실패(2 재시도'), '괄호가 닫히지 않은 줄');
  assert.ok(!r.re.test('[collector] edge-b pull 실패(): x'), '횟수가 없는 줄');
});

/* ── LIFE-02 ─────────────────────────────────────────────────────────────── */
/**
 * 가짜 Redfish — 응답마다 delayMs 지연. 요청 도착 시각과 '클라이언트가 먼저 끊은' 요청 수를 기록한다.
 * session:true 면 Basic 을 거부하고(Digest 챌린지 없음) 세션 토큰만 받는다(POST 는 postDelayMs 뒤 응답).
 */
async function fakeRedfish({ delayMs, session = false, postDelayMs = 0 }) {
  const t0 = Date.now();
  const st = { arrivals: [], aborted: [], timers: new Set(), delayMs };
  const srv = http.createServer((req, res) => {
    st.arrivals.push({ at: Date.now() - t0, url: req.url, method: req.method });
    const url = req.url;
    res.on('close', () => { if (!res.writableEnded) st.aborted.push(url); });
    const send = (code, o, headers = {}, d = st.delayMs) => {
      const tm = setTimeout(() => {
        st.timers.delete(tm);
        if (res.destroyed) return;
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(o));
      }, d);
      st.timers.add(tm);
    };
    if (session) {
      if (req.method === 'POST' && url === '/redfish/v1/SessionService/Sessions') {
        return send(201, {}, { 'X-Auth-Token': 'tok-1', Location: '/redfish/v1/SessionService/Sessions/1' }, postDelayMs);
      }
      if (req.method === 'DELETE') return send(204, {}, {}, 0);
      if (req.headers['x-auth-token'] !== 'tok-1') return send(401, { error: 'no' }, {}, 0);
    }
    if (url === '/redfish/v1/Chassis') return send(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] });
    if (url === '/redfish/v1/Chassis/1/Sensors') return send(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/Sensors/CPUUsage' }] });
    if (url === '/redfish/v1/Chassis/1/Sensors/CPUUsage') return send(200, { Reading: 42 });
    return send(404, {}, {}, 0);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.base = `http://127.0.0.1:${srv.address().port}`;
  st.t0 = t0;
  st.close = async () => {
    for (const tm of st.timers) clearTimeout(tm);
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  };
  return st;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('LIFE-02 — 단계 시한이 지나면 센서 조회를 실제로 끊는다(반환 뒤 BMC 로 새 요청 0건 · 진행 중 요청 절단) + 탐색 진척은 남는다', async () => {
  const rf = await import('../src/idrac/redfish.js');
  const { collectEnterpriseUsage } = await import('../src/bmusage/collectors/idracEnterprise.js');
  rf._resetSensorPathsForTest();
  // 요청마다 2초: Chassis 0→2s · Sensors 2→4s · 값 4→6s. 단계 시한은 budgetMs(3.1초)로 잘린다(API_SLICE_MS 하한 5초보다 작다).
  const bmc = await fakeRedfish({ delayMs: 2_000 });
  try {
    const entry = { host: bmc.base, username: 'u', password: 'p' };
    const r = await collectEnterpriseUsage(entry, { mode: 'api', budgetMs: 3_100 });
    const returnedAt = Date.now() - bmc.t0;
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /단계 시한 초과/);
    // 예전 코드는 여기서 Sensors 응답(4초)을 받은 뒤 값 GET 을 **반환 뒤에** 새로 보냈다(4초 무렵 도착).
    await sleep(Math.max(0, 5_000 - returnedAt));
    const late = bmc.arrivals.filter((a) => a.at > returnedAt + 150);
    assert.deepEqual(late, [], `수집기가 반환한 뒤에도 BMC 로 새 요청이 나갔다: ${JSON.stringify(late)}`);
    assert.ok(bmc.aborted.includes('/redfish/v1/Chassis/1/Sensors'), `진행 중이던 Sensors 요청이 끊겨야 한다(끊긴 요청: ${JSON.stringify(bmc.aborted)})`);

    // 진척 보존 — 다음 주기는 Chassis 를 다시 묻지 않고 Sensors 부터 잇는다(느린 BMC 가 매 주기 처음부터 하다 영영 못 끝내지 않게).
    bmc.delayMs = 50;
    const before = bmc.arrivals.length;
    const r2 = await collectEnterpriseUsage(entry, { mode: 'api', budgetMs: 10_000 });
    const urls = bmc.arrivals.slice(before).map((a) => a.url);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.cpuPct, 42);
    assert.ok(!urls.includes('/redfish/v1/Chassis'), `섀시 목록을 다시 물었다: ${urls.join(', ')}`);
  } finally { await bmc.close(); rf._resetSensorPathsForTest(); }
});

test('LIFE-02 — 폴러의 장비 signal 도 센서 GET 까지 전달되고, 세션 경로에서 취소를 401(인증 실패)로 바꾸지 않는다', async () => {
  const rf = await import('../src/idrac/redfish.js');
  rf._resetSensorPathsForTest();
  // Basic 401(챌린지 없음) → 세션 POST(즉시) → 토큰 GET 이 3초 걸린다. 300ms 에 취소한다.
  const bmc = await fakeRedfish({ delayMs: 3_000, session: true });
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('장비 시한 초과(테스트)')), 300);
    const t0 = Date.now();
    const r = await rf.fetchUsageSensors({ host: bmc.base, username: 'u2', password: 'p2' }, { signal: ac.signal });
    clearTimeout(t);
    const took = Date.now() - t0;
    assert.ok(took < 2_000, `취소 뒤에도 토큰 GET(3초)을 기다렸다: ${took}ms`);
    assert.notEqual(r.kind, 'auth', `취소가 '인증 실패' 로 둔갑했다 — authGuard 가 멀쩡한 서버의 주기 수집을 멈춘다: ${JSON.stringify(r)}`);
    assert.equal(r.kind, 'unreachable');
    assert.match(String(r.error || ''), /장비 시한 초과/);
  } finally { await bmc.close(); rf._resetSensorPathsForTest(); }
});

test('LIFE-02 — 한 호출자의 취소가 공유 세션 생성을 끊어 다른 호출자에게 거짓 401 로 번지지 않는다', async () => {
  const rf = await import('../src/idrac/redfish.js');
  rf._resetSensorPathsForTest();
  // 세션 POST 가 600ms 걸린다. A(200ms 에 취소)와 B(signal 없음)가 같은 키로 동시에 세션 생성을 기다린다(SESSION_INFLIGHT 공유).
  const bmc = await fakeRedfish({ delayMs: 20, session: true, postDelayMs: 600 });
  try {
    const entry = { host: bmc.base, username: 'u3', password: 'p3' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('A 의 장비 시한(테스트)')), 200);
    const [a, b] = await Promise.all([
      rf.fetchUsageSensors(entry, { signal: ac.signal }),
      rf.fetchUsageSensors(entry, {}),
    ]);
    clearTimeout(t);
    assert.notEqual(a.kind, 'auth', `A 의 취소가 인증 실패로 둔갑했다: ${JSON.stringify(a)}`);
    assert.notEqual(b.kind, 'auth', `A 의 취소가 공유 세션 생성을 끊어 B 가 거짓 401 을 받았다 — authGuard 가 멀쩡한 서버를 멈춘다: ${JSON.stringify(b)}`);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.cpuPct, 42);
  } finally { await bmc.close(); rf._resetSensorPathsForTest(); }
});

/* ── LIFE-03 ─────────────────────────────────────────────────────────────── */
function countRenames(file) {
  const orig = fs.renameSync;
  let n = 0;
  fs.renameSync = function patched(a, b) { if (b === file) n += 1; return orig.apply(this, arguments); };
  return { get n() { return n; }, reset() { n = 0; }, restore() { fs.renameSync = orig; } };
}

test('LIFE-03 — 한 틱에 장비 60대를 기록해도 파일 쓰기는 2번(첫 기록 + 틱 끝)이고, 조회는 즉시 전부 보인다', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const log = createActivityLog({ fileName: 'burst-activity.json', numFields: ['portsOnline'] });
  // 운영 상태처럼 링버퍼를 상한까지 채운다(여러 틱에 걸쳐 — 채우는 동안의 쓰기는 세지 않는다).
  for (let i = 0; i < log.MAX; i++) {
    log.recordActivity({ deviceId: `old-${i}`, ok: true, at: 1_790_000_000_000 + i, portsOnline: 1 });
    if (i % 100 === 99) await null;
  }
  await null;
  const spy = countRenames(log.FILE);
  try {
    for (let i = 0; i < 60; i++) {
      log.recordActivity({ deviceId: `sw-${i}`, name: `SAN-SW-${i}`, host: `10.2.0.${i}`, source: 'edge-pl1', ok: true, durationMs: 900, portsOnline: 40, at: 1_790_000_100_000 + i });
    }
    assert.equal(spy.n, 1, `같은 틱의 기록마다 전량을 다시 썼다(쓰기 ${spy.n}회) — 첫 기록만 곧바로 쓰고 나머지는 틱 끝에서 한 번이어야 한다`);
    await null; // 틱 끝(마이크로태스크) — 대기분 1회
    assert.equal(spy.n, 2, `틱 끝의 묶음 쓰기가 한 번이어야 한다(실제 ${spy.n}회)`);
    const onDisk = JSON.parse(fs.readFileSync(log.FILE, 'utf8'));
    assert.equal(onDisk.length, log.MAX, '상한(MAX)을 지킨다');
    assert.equal(onDisk.at(-1).deviceId, 'sw-59', '틱 끝 쓰기가 마지막 기록까지 담는다');
  } finally { spy.restore(); }
  assert.equal(log.listActivity(1)[0].deviceId, 'sw-59');
});

test('LIFE-03 — 같은 틱의 대기분도 조회에는 즉시 보이고, 조회·초기화·종료 flush 가 대기분을 파일에 쓴다', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const { exitFlushNames, runExitFlush } = await import('../src/util/exitFlush.js');
  const log = createActivityLog({ fileName: 'pending-activity.json', max: 60 });
  assert.ok(exitFlushNames().includes('activity/pending-activity.json'), '종료 flush 에 등록돼야 한다(같은 틱에 process.exit 이 와도 대기분을 쓴다)');
  const read = () => JSON.parse(fs.readFileSync(log.FILE, 'utf8')).map((e) => e.deviceId);

  // ① 조회: 대기분이 메모리에서 즉시 보이고, 조회가 먼저 파일에 반영한다
  log.recordActivity({ deviceId: 'a', ok: true, at: 1 });
  log.recordActivity({ deviceId: 'b', ok: false, error: 'x', at: 2 });
  assert.deepEqual(log.listActivity(5).map((e) => e.deviceId), ['b', 'a'], '방금 기록이 즉시 보인다');
  assert.deepEqual(read(), ['a', 'b'], '조회가 대기분을 파일에 먼저 쓴다(메모리와 파일이 다른 시점을 말하지 않게)');
  await null;

  // ② 초기화(_resetForTest): 대기분을 버리지 않는다 — 다음 load() 가 파일에서 다시 읽는다
  log.recordActivity({ deviceId: 'c', ok: true, at: 3 });
  log.recordActivity({ deviceId: 'd', ok: true, at: 4 });
  log._resetForTest();
  assert.deepEqual(log.listActivity(5).map((e) => e.deviceId), ['d', 'c', 'b', 'a']);
  await null;

  // ③ 종료 flush: 같은 틱에 exit 훅이 돌면 대기분을 동기로 쓴다
  log.recordActivity({ deviceId: 'e', ok: true, at: 5 });
  log.recordActivity({ deviceId: 'f', ok: true, at: 6 });
  runExitFlush('test');
  assert.deepEqual(read().slice(-2), ['e', 'f'], '종료 flush 가 대기분(f)을 파일에 써야 한다');
});

test('LIFE-03 — 따로 떨어진 기록(폴러의 장비별 완료)은 예전처럼 곧바로 파일에 쓴다', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const log = createActivityLog({ fileName: 'single-activity.json' });
  log.recordActivity({ deviceId: 'one', ok: true, at: 10 });
  assert.ok(fs.existsSync(log.FILE), '첫 기록은 곧바로 쓴다');
  assert.equal((fs.statSync(log.FILE).mode & 0o777), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(log.FILE, 'utf8')).map((e) => e.deviceId), ['one']);
});
