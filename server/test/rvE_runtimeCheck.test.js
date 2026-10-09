// 검토 I-06 — Node 런타임 계약(engines·.nvmrc·.node-version·CI·릴리스·오프라인 번들)과 기동 시 호환성 자가 점검.
//
// 고정하는 것:
//   ① 버전 판정(문자열 여러 개 — 지원 major·하한·릴리스 일치·판독 불가). 이 컨테이너의 22.22.2 는 'supported · older'.
//   ② 계약 일치 — package.json 3개 engines · .nvmrc · .node-version · ci.yml · release.yml · build-package.sh 기본값 · 설치 문서.
//   ③ 자가 점검을 **실제 루프백 서버**로: 지원 런타임에서 통과 / 다른 major 의 전역 fetch 를 흉내 낸 호출(새 형식 핸들러로
//      패키지 undici 6 Agent 를 직접 dispatch — 그 Agent 가 실제로 'invalid onError method' 를 던진다)이면 'mismatch' /
//      둘 다 실패면 'error' / 끝나지 않으면 'timeout'.
//   ④ 실패를 주입하면 상태가 '불일치' 가 되고 /api/health 에 실린다(실제 api 라우터를 express 에 마운트 — 자식 프로세스).
//      관리자(전체 범위)만 버전·상세, viewer·범위 관리자는 state 하나.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent } from 'undici';
import {
  RUNTIME_CONTRACT, enginesRange, parseNodeVersion, judgeVersion, overallState,
  selfCheckFetchDispatcher, runRuntimeSelfCheck, runtimeStatus, runtimeForHealth, runtimeServiceRow,
  runtimeLogLine, startRuntimeCheck, _resetRuntimeCheckForTest,
} from '../src/util/runtimeCheck.js';

const SERVER = path.resolve(new URL('..', import.meta.url).pathname);
const ROOT = path.resolve(SERVER, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 다른 major(Node 24+) 의 전역 fetch 흉내: 내장 undici 7+ 는 디스패처에 **새 형식 핸들러**(onRequestStart·onResponseStart…)를 준다.
 * 패키지 undici 6 Agent 는 옛 형식(onConnect·onError·onHeaders…)을 요구하므로 Request 생성에서 던지고, catch 에서 onError 가 없어
 * 'invalid onError method'(UND_ERR_INVALID_ARG)를 던진다 — 검토 환경 Node 26.6.0 에서 본 것과 같은 오류를 **진짜 Agent 가** 낸다.
 */
const newStyleFetch = async (url, init = {}) => {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let status = 0;
    try {
      init.dispatcher.dispatch({ origin: u.origin, path: u.pathname, method: 'GET', headers: {} }, {
        onRequestStart() {},
        onResponseStart(_c, st) { status = st; },
        onResponseData(_c, ch) { chunks.push(ch); },
        onResponseEnd() { resolve(new Response(Buffer.concat(chunks), { status })); },
        onResponseError(_c, e) { reject(new TypeError('fetch failed', { cause: e })); },
      });
    } catch (e) { reject(new TypeError('fetch failed', { cause: e })); }
  });
};

test('① 버전 판정 — 지원 major·하한·릴리스 일치·판독 불가', () => {
  const j = (v) => judgeVersion(v);
  assert.deepEqual(RUNTIME_CONTRACT.supportedMajors, [22]);
  assert.equal(RUNTIME_CONTRACT.releaseVersion, '22.23.2');
  // 릴리스와 정확히 같다
  assert.equal(j('v22.23.2').code, 'release');
  assert.equal(j('22.23.2').code, 'release');
  assert.equal(j('v22.23.2').releaseRelation, 'same');
  // 이 개발 컨테이너의 22.22.2 — 지원 major · 하한 이상 · 릴리스보다 낮은 패치 → 계약 안(경고 아님)
  const dev = j('v22.22.2');
  assert.deepEqual([dev.supported, dev.code, dev.level, dev.releaseRelation], [true, 'supported', 'ok', 'older']);
  assert.deepEqual([j('v22.30.0').code, j('v22.30.0').releaseRelation], ['supported', 'newer']);
  // 하한 경계 — 22.5.0(node:sqlite) 이상만 지원
  assert.equal(j('v22.5.0').supported, true);
  assert.deepEqual([j('v22.4.1').supported, j('v22.4.1').code, j('v22.4.1').level], [false, 'below-minimum', 'warn']);
  // 다른 major — 검토 환경 26.6.0 포함
  for (const v of ['v20.20.2', 'v21.7.3', 'v23.0.0', 'v24.11.0', 'v26.6.0', 'v18.20.4']) {
    const r = j(v);
    assert.deepEqual([r.supported, r.code, r.level], [false, 'unsupported-major', 'warn'], v);
  }
  // 판독 불가 — '지원' 이라 말하지 않는다(null)
  for (const v of ['', 'abc', 'v22', 'v22.1', '22.x', null, undefined, 22, `v22.23.2${'0'.repeat(200)}`, 'v22.23.2 ; rm -rf /']) {
    const r = j(v);
    assert.deepEqual([r.supported, r.code, r.level], [null, 'unparsed', 'unknown'], String(v).slice(0, 30));
  }
  // 사전 배포판은 'release' 가 아니다(같은 숫자라도)
  const pre = j('v22.23.2-rc.1');
  assert.deepEqual([pre.supported, pre.code, pre.prerelease, pre.releaseRelation], [true, 'supported', true, 'same']);
  assert.equal(parseNodeVersion('v22.23.2').patch, 2);
  // 이 프로세스(node -v)도 판정된다
  assert.equal(judgeVersion(process.version).node, process.version);
});

test('① 종합 상태 — mismatch > unsupported > error > checking > unchecked > ok', () => {
  const ok = judgeVersion('v22.23.2');
  const bad = judgeVersion('v26.6.0');
  assert.equal(overallState(ok, { state: 'ok' }), 'ok');
  assert.equal(overallState(ok, { state: 'mismatch' }), 'mismatch');
  assert.equal(overallState(bad, { state: 'mismatch' }), 'mismatch', '불일치가 확인되면 버전과 무관하게 불일치');
  assert.equal(overallState(bad, { state: 'ok' }), 'unsupported', '자가 점검이 통과해도 계약 밖은 계약 밖');
  assert.equal(overallState(judgeVersion('garbage'), { state: 'ok' }), 'unsupported', '판독 불가는 지원이 아니다');
  assert.equal(overallState(ok, { state: 'error' }), 'error');
  assert.equal(overallState(ok, { state: 'timeout' }), 'error');
  assert.equal(overallState(ok, { state: 'running' }), 'checking');
  assert.equal(overallState(ok, { state: 'not-run' }), 'unchecked');
});

test('② 계약 일치 — engines 3개 · .nvmrc · .node-version · CI · 릴리스 · 오프라인 번들 · 설치 문서', () => {
  const range = enginesRange();
  assert.equal(range, '>=22.5.0 <23');
  for (const p of ['package.json', 'server/package.json', 'web/package.json']) {
    const pkg = JSON.parse(read(p));
    assert.equal(pkg.engines?.node, range, `${p} engines.node`);
  }
  assert.equal(read('.nvmrc').trim(), RUNTIME_CONTRACT.releaseVersion, '.nvmrc');
  assert.equal(read('.node-version').trim(), RUNTIME_CONTRACT.releaseVersion, '.node-version');
  // 워크플로·빌드 스크립트는 이 그룹이 고치지 않는다 — 읽기만 해서 어긋나면 실패(어느 쪽을 바꿨는지 드러나게).
  assert.match(read('.github/workflows/ci.yml'), new RegExp(`node-version: '${RUNTIME_CONTRACT.releaseVersion.replace(/\./g, '\\.')}'`), 'ci.yml node-version');
  assert.match(read('.github/workflows/release.yml'), new RegExp(`NODE_VERSION: '${RUNTIME_CONTRACT.releaseVersion.replace(/\./g, '\\.')}'`), 'release.yml NODE_VERSION');
  assert.match(read('packaging/offline/build-package.sh'), new RegExp(`NODE_VERSION="\\$\\{NODE_VERSION:-${RUNTIME_CONTRACT.releaseVersion.replace(/\./g, '\\.')}\\}"`), '오프라인 번들 기본 Node');
  // 지원 major 하나뿐인데 판정이 그 major 와 맞는다
  assert.equal(parseNodeVersion(RUNTIME_CONTRACT.releaseVersion).major, RUNTIME_CONTRACT.supportedMajors[0]);
  assert.equal(judgeVersion(RUNTIME_CONTRACT.minVersion).supported, true);
  // 손으로 쓴 설치 문서가 계약과 다른 요구 버전을 말하지 않는다(예전: 'Node 20+ 필요' · 'Node 22 LTS 이상')
  for (const p of ['docs/INSTALL.md', 'README.md', 'packaging/README.md', 'packaging/offline/OFFLINE-INSTALL.md', 'packaging/DISTRIBUTED-COLLECTION.md']) {
    const t = read(p);
    assert.doesNotMatch(t, /Node 20\+|Node\.js 22 LTS 이상|node-v22\.20\.0/, `${p} 에 옛 요구 버전`);
  }
  assert.match(read('docs/INSTALL.md'), /22\.23\.2/, 'INSTALL.md 가 릴리스 검증 버전을 말한다');
  assert.match(read('docs/INSTALL.md'), />=22\.5\.0 <23/, 'INSTALL.md 가 engines 범위를 말한다');
});

test('③ 자가 점검 — 지원 런타임의 실제 전역 fetch + undici Agent 는 루프백 서버에서 통과한다', async () => {
  const r = await selfCheckFetchDispatcher({ timeoutMs: 5000 });
  assert.equal(r.state, 'ok', JSON.stringify(r));
  assert.equal(r.globalFetch, 'ok');
  assert.equal(r.undiciFetch, 'not-tried', '전역 fetch 가 되면 비교 호출을 하지 않는다');
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
});

test('③ 자가 점검 — 다른 major 의 전역 fetch(새 형식 핸들러) → 진짜 undici 6 Agent 가 던지고 undici.fetch 는 통과 → mismatch', async () => {
  const r = await selfCheckFetchDispatcher({ timeoutMs: 5000, fetchImpl: newStyleFetch });
  assert.equal(r.state, 'mismatch', JSON.stringify(r));
  assert.equal(r.code, 'UND_ERR_INVALID_ARG');
  assert.match(r.detail, /invalid onError method/);
  assert.equal(r.undiciFetch, 'ok', '같은 Agent + 패키지 undici.fetch 는 200 — 그래서 런타임 계약 불일치로 확정');
});

test('③ 자가 점검 — 둘 다 실패면 error(루프백 자체가 막힘 — 런타임 탓이라 단정하지 않는다) · 끝나지 않으면 timeout', async () => {
  const fail = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };
  const r = await selfCheckFetchDispatcher({ timeoutMs: 1000, fetchImpl: fail, loadUndici: async () => ({ Agent, fetch: fail }) });
  assert.equal(r.state, 'error', JSON.stringify(r));
  assert.equal(r.code, 'ECONNREFUSED');
  assert.equal(r.undiciFetch, 'failed');
  // undici 모듈을 못 불러오면 error
  const r2 = await selfCheckFetchDispatcher({ timeoutMs: 1000, loadUndici: async () => { throw new Error('Cannot find package undici'); } });
  assert.equal(r2.state, 'error');
  // 응답하지 않는 fetch(시그널도 무시) — 전체 시한(요청 시한 × 3) 안에 timeout 으로 끝난다
  const t0 = Date.now();
  const r3 = await selfCheckFetchDispatcher({ timeoutMs: 200, fetchImpl: () => new Promise(() => {}) });
  assert.equal(r3.state, 'timeout');
  assert.ok(Date.now() - t0 < 3000, `기동을 붙잡지 않는다(${Date.now() - t0}ms)`);
  // fetchImpl 이 함수가 아니면 전역 fetch 를 쓴다
  const r4 = await selfCheckFetchDispatcher({ timeoutMs: 5000, fetchImpl: 'not-a-function' });
  assert.equal(r4.state, 'ok');
  // 전역 fetch 가 없는 런타임(--no-experimental-fetch 등) — 서버 통신 전부가 전역 fetch 라 불일치다
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const r5 = await selfCheckFetchDispatcher({ timeoutMs: 1000 });
    assert.deepEqual([r5.state, r5.code, r5.globalFetch], ['mismatch', 'no-global-fetch', 'missing']);
  } finally { globalThis.fetch = saved; }
});

test('④ 상태 · 서비스 점검 행 · 기동 로그 — 불일치를 주입하면 warn 과 경고 로그', async () => {
  _resetRuntimeCheckForTest('v22.23.2');
  assert.equal(runtimeStatus().state, 'unchecked');
  assert.equal(runtimeServiceRow().status, 'warn', '자가 점검을 안 돌렸으면 정상이라 말하지 않는다');
  const lines = { log: [], warn: [] };
  const log = { log: (s) => lines.log.push(s), warn: (s) => lines.warn.push(s) };
  const s = await startRuntimeCheck({ log, fetchImpl: newStyleFetch, timeoutMs: 5000 });
  assert.equal(s.state, 'mismatch');
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /^\[runtime\] Node v22\.23\.2 — .*자가 점검 실패\(UND_ERR_INVALID_ARG\).*장비 장애가 아닐 수 있습니다/);
  const row = runtimeServiceRow({ isAdmin: true });
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /런타임 불일치/);
  assert.match(row.detail, /UND_ERR_INVALID_ARG/);
  const rowOp = runtimeServiceRow({ isAdmin: false });
  assert.doesNotMatch(rowOp.detail, /v22\.23\.2|UND_ERR/, '버전·코드는 관리자에게만');
  // 비관리자 /health 모양은 state 하나
  assert.deepEqual(runtimeForHealth(false), { state: 'mismatch' });
  assert.equal(runtimeForHealth(true).selfCheck.code, 'UND_ERR_INVALID_ARG');
  // 실제 전역 fetch 로 다시 — 지원 런타임이면 ok, 로그는 console.log 쪽
  const s2 = await startRuntimeCheck({ log, timeoutMs: 5000 });
  assert.equal(s2.state, 'ok');
  assert.equal(lines.log.length, 1);
  assert.match(lines.log[0], /릴리스 검증 버전\(22\.23\.2\)과 같음 · 전역 fetch \+ undici Agent 자가 점검 통과/);
  assert.equal(runtimeServiceRow().status, 'ok');
  // 이 컨테이너 버전(22.22.2)처럼 패치가 다르면 — ok 이고 그 사실을 말한다
  _resetRuntimeCheckForTest('v22.22.2');
  await runRuntimeSelfCheck({ timeoutMs: 5000 });
  assert.equal(runtimeStatus().state, 'ok');
  assert.match(runtimeLogLine(), /릴리스 검증 버전\(22\.23\.2\)보다 낮은 버전 — 계약 안/);
  // 비지원 major 는 자가 점검이 통과해도 unsupported(warn)
  _resetRuntimeCheckForTest('v26.6.0');
  await runRuntimeSelfCheck({ timeoutMs: 5000 });
  assert.equal(runtimeStatus().state, 'unsupported');
  assert.equal(runtimeServiceRow().status, 'warn');
  // 진행 중 합류 — 두 번 불러도 한 번 돈다
  _resetRuntimeCheckForTest();
  let calls = 0;
  const counting = async (u, i) => { calls++; return fetch(u, i); };
  const [a, b] = await Promise.all([runRuntimeSelfCheck({ fetchImpl: counting }), runRuntimeSelfCheck({ fetchImpl: counting })]);
  assert.equal(calls, 1);
  assert.equal(a.state, b.state);
  _resetRuntimeCheckForTest();
});

test('④ 판정 불가(error)는 기동 직후 부하일 수 있어 다시 본다 — 불일치는 다시 보지 않는다(결정적)', async () => {
  _resetRuntimeCheckForTest('v22.23.2');
  let n = 0;
  const flaky = async (u, i) => { n++; if (n === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }); return fetch(u, i); };
  const flakyUndici = async () => { const m = await import('undici'); return { Agent: m.Agent, fetch: async (u, i) => { if (n <= 1) throw new Error('loopback down'); return m.fetch(u, i); } }; };
  const lines = [];
  const log = { log: (x) => lines.push(['log', x]), warn: (x) => lines.push(['warn', x]) };
  const s = await startRuntimeCheck({ log, fetchImpl: flaky, loadUndici: flakyUndici, retryDelaysMs: [10], timeoutMs: 5000 });
  assert.equal(s.state, 'ok', '두 번째 시도에서 통과');
  assert.deepEqual(lines.map((l) => l[0]), ['warn', 'log'], '판정 불가 경고 1줄 + 통과 1줄');
  assert.match(lines[0][1], /자가 점검 판정 불가\(ECONNRESET\)/);
  // 불일치는 다시 보지 않는다
  _resetRuntimeCheckForTest('v22.23.2');
  let calls = 0;
  const mm = async (u, i) => { calls++; return newStyleFetch(u, i); };
  const s2 = await startRuntimeCheck({ log, fetchImpl: mm, retryDelaysMs: [5, 5], timeoutMs: 5000 });
  assert.equal(s2.state, 'mismatch');
  assert.equal(calls, 1);
  // 재시도 상한 — 계속 판정 불가면 delays 개수 + 1 번만 시도하고 끝난다(무한 루프 금지)
  _resetRuntimeCheckForTest('v22.23.2');
  let tries = 0;
  const down = async () => { tries++; throw new Error('down'); };
  const s3 = await startRuntimeCheck({ log, fetchImpl: down, loadUndici: async () => ({ Agent, fetch: down }), retryDelaysMs: [1, 1], timeoutMs: 1000 });
  assert.equal(s3.state, 'error');
  assert.equal(tries, 6, '시도 3번 × (전역 + undici.fetch)');
  _resetRuntimeCheckForTest();
});

test('④ /api/health 에 runtime 이 실린다 — 불일치 주입 → admin 은 상세, viewer·범위 관리자는 state 만(실제 api 라우터)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvE-rt-'));
  const apiPath = path.join(SERVER, 'src/routes/api.js');
  const rtPath = path.join(SERVER, 'src/util/runtimeCheck.js');
  const storePath = path.join(SERVER, 'src/store.js');
  const script = `
    const express = (await import('express')).default;
    const rt = await import(${JSON.stringify(rtPath)});
    const { store } = await import(${JSON.stringify(storePath)});
    try { await store.refresh(); } catch {}
    const { api } = await import(${JSON.stringify(apiPath)});
    const vc = store.get().vcenters[0]?.id || 'vc-x';
    const app = express();
    app.use((req, _res, next) => {
      const who = req.get('x-who');
      req.user = who === 'viewer' ? { username: 'v', role: 'viewer', scope: null }
        : who === 'scoped' ? { username: 's', role: 'admin', scope: { vcenters: [vc] } }
        : who === 'demo' ? { username: 'd', role: 'admin', demoGuest: true, scope: null }
        : { username: 'a', role: 'admin', scope: null };
      next();
    });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (who) => (await fetch(base + '/api/health', { headers: { 'x-who': who } })).json();
    const before = (await get('admin')).runtime;
    ${'/* 다른 major 의 전역 fetch 흉내(위 테스트와 같은 함수) */'}
    const newStyleFetch = ${newStyleFetch.toString()};
    await rt.runRuntimeSelfCheck({ fetchImpl: newStyleFetch, timeoutMs: 5000 });
    const admin = (await get('admin')).runtime;
    const viewer = (await get('viewer')).runtime;
    const scoped = (await get('scoped')).runtime;
    const demo = (await get('demo')).runtime;
    rt._resetRuntimeCheckForTest();
    await rt.runRuntimeSelfCheck({ timeoutMs: 5000 });
    const after = (await get('admin')).runtime;
    const h = await get('admin');
    srv.close();
    console.log('@@' + JSON.stringify({ before, admin, viewer, scoped, demo, after, status: h.status, version: h.version }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: SERVER, timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(r.stdout.split('@@')[1]);
  assert.equal(o.before.state, 'unchecked', '기동 진입점이 안 돌렸으면 unchecked');
  assert.equal(o.admin.state, 'mismatch');
  assert.equal(o.admin.node, process.version);
  assert.equal(o.admin.selfCheck.code, 'UND_ERR_INVALID_ARG');
  assert.equal(o.admin.contract.engines, '>=22.5.0 <23');
  assert.deepEqual(o.viewer, { state: 'mismatch' }, 'viewer 는 state 만 — 버전·상세 없음');
  assert.deepEqual(o.scoped, { state: 'mismatch' }, '범위 관리자도 state 만');
  assert.deepEqual(o.demo, { state: 'mismatch' }, 'mock 모드 데모 계정(요청 문맥 admin)도 state 만');
  assert.equal(o.after.state, 'ok', `지원 런타임(${process.version})의 실제 전역 fetch 는 통과`);
  assert.equal(o.status, 'ok', '/health 의 기존 필드는 그대로');
  // 경로·비밀이 없다
  const flat = JSON.stringify(o.admin);
  assert.doesNotMatch(flat, new RegExp(SERVER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), '설치 경로 없음');
  assert.doesNotMatch(flat, /password|token|secret/i);
});
