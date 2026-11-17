/**
 * edgeWorkerAudit85.test.js — 전체 점검 85회차(엣지 워커 server/src/agent/ 공통 골격).
 *
 *  F1 배포 대상 등록부(agent/deployRegistry.js) — 읽기 오류(EACCES · EIO · EISDIR)를 손상으로 보고 온전한 원본(SSH root 비밀번호 ·
 *     CENTRAL_TOKEN · COLLECTOR_TOKEN)을 `.corrupt.*` 로 옮긴 뒤 빈 목록으로 돌았다 — 다음 저장이 한 건만 든 파일을 썼다(재현).
 *     이제 공용 판정(util/jsonFileLoad.js): 읽기 오류는 원본을 두고 · 쓰기를 거절(registry-unreadable) · 30초 간격으로 다시 읽는다. 손상은 예전처럼 보존.
 *  F2 같은 파일 — saveTarget · removeTarget 이 캐시 객체를 고친 뒤 저장했다 — 저장이 실패하면 메모리만 새 값(v2.879 F4 가 '기존 동작' 으로 남긴 것).
 *  F3 ping · capture · bmstor · 로그 연합 조회 워커 — 중앙이 닿지 않거나(연결 실패) 거부하는(로그 조회 403) 동안 4~10초마다 같은 경고가 저널에 쌓였다.
 *     이제 같은 사유는 10분에 한 줄(형제 HTTP 실패 경로 — v2.591 PR-5 — 와 같다). 상태(_last)는 매번 갱신한다.
 *  F4 성능점검 정의 pull(agent/svcmonConfigPull.js) — 배정 대상이 상한을 넘으면 ack 만 하고 상태 · 콘솔을 남기지 않았다(직전 성공이 그대로 보였다).
 *  F5 IP 스캔 워커(agent/ipScanWorker.js) — 마지막 스캔 시각 파일의 읽기 오류도 손상으로 보고 원본을 옮겼다.
 *  F6 CVP 설정 pull(agent/cvpConfigPull.js runEndpointRequests) — 결과 push 를 기다리는 동안 들어온 'EndpointLocation 지금 조회' 요청이
 *     대기열에 붙기만 하고 처리되지 않았다(중앙은 내려보낼 때 지우므로 다시 오지 않는다 — 모듈 목으로 재현).
 *  I1 통신 점검 워커(agent/linkCheckWorker.js) — 중앙이 내린 주기를 엣지가 자르지 않았다(옛 중앙 · 손상 설정의 1초 주기가 그대로).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

// 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(tmpCleanup3188 규약 — exit 에서 한 번 더).
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('edge-audit85-');
process.env.CONFIG_DIR = DIR;
process.env.SVCMON_WORKERS = '0';
process.env.SVCMON_CONFIG_PULL_MS = '3000000000';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

const { config } = await import('../src/config.js');
const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileLoad.js');
after(() => _setJsonFileLoadClockForTest());

const realRead = fs.readFileSync;
/** 그 경로 읽기만 EACCES(root 로 도는 시험에서는 chmod 로 재현되지 않는다 — 77 · 82회차와 같은 방식). */
function denyRead(file) {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  return () => { fs.readFileSync = realRead; };
}
const corruptCopies = (name) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${name}.corrupt.`));

/** 콘솔 경고를 모은다(그 접두만). */
function captureWarn(prefix) {
  const orig = console.warn; const lines = [];
  console.warn = (...a) => { const s = a.map(String).join(' '); if (s.includes(prefix)) lines.push(s); else orig(...a); };
  return { lines, restore: () => { console.warn = orig; } };
}

async function mockCentral(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const ch = [];
    req.on('data', (c) => ch.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const hit = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: Buffer.concat(ch).toString() };
      hits.push(hit);
      const out = handler(hit) || { status: 200, body: { ok: true } };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

/* ───────── F1 · F2 배포 대상 등록부 ───────── */
const DEPLOY_FILE = path.join(DIR, 'agent-deploy-targets.json');
const R = await import('../src/agent/deployRegistry.js');

test('F1 읽기 오류: 원본을 옮기지 않고 · 저장 · 삭제 · 이름 변경을 거절하고 · 풀리면 원본 그대로 읽는다', () => {
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({ targets: [
    { id: 'a1', host: '10.0.0.1', username: 'root', password: 'pw-1', centralToken: 'ct-1' },
    { id: 'a2', host: '10.0.0.2', username: 'root', password: 'pw-2', collectorToken: 'col-2' },
  ] }));
  const before = realRead(DEPLOY_FILE, 'utf8');
  const undo = denyRead(DEPLOY_FILE);
  let t0 = Date.now();
  _setJsonFileLoadClockForTest(() => t0);
  try {
    assert.equal(R.listTargets().length, 0, '읽지 못한 동안 목록은 비어 보인다(지어내지 않는다)');
    assert.equal(R.deployTargetsLoadError()?.code, 'EACCES', '읽기 오류를 밝힌다');
    const s = R.saveTarget({ host: '10.0.0.9', username: 'root', password: 'x' });
    assert.equal(s.ok, false); assert.equal(s.code, 'registry-unreadable');
    assert.equal(R.removeTarget('a1').code, 'registry-unreadable');
    assert.equal(R.setTargetAgentName('a1', 'edge-x').code, 'registry-unreadable', "예전에는 '찾을 수 없음' 으로 말했다");
    assert.deepEqual(corruptCopies('agent-deploy-targets.json'), [], '온전한 원본을 .corrupt 로 옮기면 안 된다');
  } finally { undo(); }
  assert.equal(realRead(DEPLOY_FILE, 'utf8'), before, '원본 바이트 그대로');
  // 30초 간격 안에서는 디스크를 다시 보지 않는다(죽어 가는 디스크의 EIO 를 요청마다 기다리지 않게) — 간격이 지나면 다시 읽는다.
  assert.equal(R.listTargets().length, 0, '간격 안 — 아직 읽기 오류로 본다');
  t0 += 31_000;
  assert.equal(R.listTargets().length, 2, '풀리면 원본 두 건');
  assert.equal(R.deployTargetsLoadError(), null);
  assert.equal(R.getTargetRaw('a1').password, 'pw-1');
  assert.equal(R.saveTarget({ host: '10.0.0.3', username: 'root', password: 'pw-3' }).ok, true, '풀린 뒤에는 저장된다');
  assert.equal(JSON.parse(realRead(DEPLOY_FILE, 'utf8')).targets.length, 3, '기존 두 건 + 새 한 건');
});

test('F2 저장이 실패하면(같은 이름의 디렉터리 — rename 실패) 메모리 값도 그대로다 — saveTarget · removeTarget', () => {
  const a1 = R.getTargetRaw('a1');
  fs.rmSync(DEPLOY_FILE); fs.mkdirSync(DEPLOY_FILE);
  try {
    assert.throws(() => R.saveTarget({ id: 'a1', host: '10.9.9.9', username: 'root', agentName: 'moved' }));
    const now = R.getTargetRaw('a1');
    assert.equal(now.host, '10.0.0.1', '실패한 저장의 host 가 메모리에 남으면 안 된다');
    assert.equal(now.password, 'pw-1', '버린 비밀이 메모리에서 사라지면 안 된다(파일과 어긋난다)');
    assert.equal(now.agentName, a1.agentName);
    const n = R.listTargetsRaw().length;
    assert.throws(() => R.saveTarget({ host: '10.7.7.7', username: 'root', password: 'n' }));
    assert.equal(R.listTargetsRaw().length, n, '새 대상이 메모리에만 생기면 안 된다');
    assert.throws(() => R.removeTarget('a2'));
    assert.ok(R.getTargetRaw('a2'), '지우지 못한 대상이 메모리에서만 사라지면 안 된다');
  } finally { fs.rmSync(DEPLOY_FILE, { recursive: true, force: true }); }
  assert.equal(R.saveTarget({ id: 'a1', host: '10.0.0.1', username: 'root', agentName: 'edge-1' }).ok, true, '고친 뒤에는 저장된다');
  assert.equal(R.getTargetRaw('a1').password, 'pw-1', '같은 접속처 — 비밀 유지');
});

test('F1 손상(파싱 실패)은 예전처럼 보존본으로 옮기고 빈 목록에서 시작한다(소스 스윕 — 손상 경로가 남아 있다)', () => {
  const s = read('agent/deployRegistry.js');
  assert.match(s, /makeJsonFileReader\(\(\) => FILE,/, '공용 읽기');
  assert.match(s, /if \(r\.kind === 'corrupt'\) preserveCorrupt\(FILE/, '손상만 보존본으로');
  assert.match(s, /if \(_readErr\) throw/, 'persist 마지막 방어선');
});

/* ───────── F5 IP 스캔 워커 상태 파일 ───────── */
test('F5 마지막 스캔 시각 파일의 읽기 오류는 원본을 옮기지 않는다 · 손상은 보존한다', async () => {
  const W = await import('../src/agent/ipScanWorker.js');
  const STATE = path.join(DIR, 'ipscan-agent-state.json');
  const at = Date.now() - 60_000;
  fs.writeFileSync(STATE, JSON.stringify({ v: 1, lastScanAt: at }));
  const undo = denyRead(STATE);
  const cw = captureWarn('[ipscan-agent]');
  try { W._reloadIpScanAgentForTest(); } finally { undo(); cw.restore(); }
  assert.equal(W.ipScanAgentStatus().lastScanAt, null, '읽지 못했으면 모름');
  assert.deepEqual(corruptCopies('ipscan-agent-state.json'), [], '읽기 오류로 원본을 옮기면 안 된다');
  assert.ok(cw.lines.some((l) => /읽지 못했습니다/.test(l)), '읽기 오류를 콘솔에 남긴다');
  W._reloadIpScanAgentForTest();
  assert.equal(W.ipScanAgentStatus().lastScanAt, at, '풀리면 원본 값');
  fs.writeFileSync(STATE, '{ broken');
  W._reloadIpScanAgentForTest();
  assert.equal(W.ipScanAgentStatus().lastScanAt, null);
  assert.equal(corruptCopies('ipscan-agent-state.json').length, 1, '손상은 예전처럼 보존본');
});

/* ───────── F3 빠른 폴 워커의 반복 경고 ───────── */
test('F3 중앙이 닿지 않는 동안 ping · capture · bmstor · 로그 조회 워커는 같은 실패를 10분에 한 줄만 적는다(상태는 매번 갱신)', async () => {
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-a', name: 'A', host: 'vc-a.example', username: 'u', password: 'p' }] }));
  const saved = { ...config.agent };
  // 잘못된 URL — 네트워크에 나가지 않고 fetch 가 던진다(연결 실패와 같은 catch 경로).
  Object.assign(config.agent, { centralUrl: 'http://bad host.invalid', centralToken: 'tok', name: 'edge-85' });
  const cases = [
    ['[ping-agent]', async () => (await import('../src/agent/pingWorker.js')).runPingWorkerOnce(), async () => (await import('../src/agent/pingWorker.js')).pingWorkerStatus()],
    ['[capture-agent]', async () => (await import('../src/agent/captureWorker.js')).runCaptureWorkerOnce(), async () => (await import('../src/agent/captureWorker.js')).captureWorkerStatus()],
    ['[bmstor-agent]', async () => (await import('../src/agent/bmstorWorker.js')).runBmstorWorkerOnce(), async () => (await import('../src/agent/bmstorWorker.js')).bmstorWorkerStatus()],
    ['[logq-agent]', async () => (await import('../src/agent/logQueryWorker.js')).runLogQueryWorkerOnce(), async () => (await import('../src/agent/logQueryWorker.js')).logQueryWorkerStatus().last],
  ];
  try {
    for (const [prefix, run, status] of cases) {
      const cw = captureWarn(prefix);
      const ats = [];
      try {
        for (let i = 0; i < 4; i += 1) { await run(); ats.push((await status())?.at); }
      } finally { cw.restore(); }
      assert.equal(cw.lines.length, 1, `${prefix}: 같은 실패 4회에 경고 ${cw.lines.length}줄 — ${cw.lines.join(' | ')}`);
      const st = await status();
      assert.equal(st.ok, false, `${prefix}: 상태는 실패`);
      assert.ok(st.error, `${prefix}: 실패 사유가 상태에 남는다`);
      assert.ok(ats.every((x) => Number.isFinite(x)), `${prefix}: 매 실행 상태를 갱신`);
    }
  } finally { Object.assign(config.agent, saved); }
});

test('F3 로그 조회 워커 — 중앙이 계속 403 이어도 경고는 한 줄(상태는 매번 403)', async () => {
  const c = await mockCentral(() => ({ status: 403, body: { ok: false, reason: 'token' } }));
  const saved = { ...config.agent };
  const L = await import('../src/agent/logQueryWorker.js');
  const cw = captureWarn('[logq-agent]');
  try {
    Object.assign(config.agent, { centralUrl: c.url, centralToken: 'tok', name: 'edge-85' });
    for (let i = 0; i < 3; i += 1) await L.runLogQueryWorkerOnce();
  } finally { cw.restore(); Object.assign(config.agent, saved); await c.close(); }
  assert.equal(c.hits.length, 3, '매번 인출은 한다');
  assert.equal(cw.lines.length, 1, cw.lines.join(' | '));
  assert.equal(L.logQueryWorkerStatus().last.httpStatus, 403);
});

/* ───────── F4 성능점검 정의 pull 상한 초과 ───────── */
test('F4 배정 대상이 상한을 넘으면 상태 · 콘솔에 남기고 이전 배포분을 유지한다', async () => {
  const store = await import('../src/svcmon/store.js');
  const pull = await import('../src/agent/svcmonConfigPull.js');
  const row = (i) => ({ kind: 'infra', path: 'C.Central', name: `h${i}`, host: `10.8.${(i >> 8) & 255}.${i & 255}`, tests: [{ name: 'T', type: 'ping', intervalSec: 60 }] });
  let phase = 'a';
  const acks = [];
  const c = await mockCentral((h) => {
    if (h.path === '/api/central/svcmon-config-ack') { acks.push(JSON.parse(h.body)); return { status: 200, body: { ok: true } }; }
    if (h.path !== '/api/central/svcmon-config') return { status: 404, body: {} };
    if (phase === 'a') return { status: 200, body: { ok: true, assigned: true, sig: 'a85a', tag: 'central:a85a', targets: [row(1), row(2)] } };
    return { status: 200, body: { ok: true, assigned: true, sig: 'b85b', tag: 'central:b85b', targets: Array.from({ length: store.LIMITS.maxTargets + 1 }, (_, i) => row(i)) } };
  });
  const saved = { ...config.agent };
  const cw = captureWarn('[svcmon-pull]');
  try {
    Object.assign(config.agent, { centralUrl: c.url, centralToken: 'tok', name: 'edge-sv85' });
    pull._resetSvcmonPullForTest();
    assert.equal((await pull.pullSvcmonConfigNow()).ok, true);
    const okLast = pull.svcmonConfigPullStatus().last;
    phase = 'b';
    const r = await pull.pullSvcmonConfigNow();
    assert.equal(r.ok, false);
    const last = pull.svcmonConfigPullStatus().last;
    assert.notEqual(last, okLast, '상태가 직전 성공 그대로면 안 된다');
    assert.equal(last.sig, 'b85b'); assert.equal(last.kept, true); assert.equal(last.committed, false);
    assert.ok(last.errors.some((e) => /상한을 넘습니다/.test(e)), JSON.stringify(last.errors));
    assert.ok(cw.lines.some((l) => /상한을 넘습니다/.test(l)), '콘솔에도 남긴다');
    assert.equal(acks.at(-1).sig, 'b85b');
    assert.equal(store.batchCounts().get('central:a85a')?.targets, 2, '이전 배포분 유지');
    assert.equal(pull.svcmonConfigPullStatus().failedSig, 'b85b', '같은 sig 는 백오프 동안 다시 받지 않는다');
  } finally { cw.restore(); Object.assign(config.agent, saved); await c.close(); }
});

/* ───────── I1 통신 점검 주기 · 동시성 ───────── */
test('I1 통신 점검 워커 — 중앙이 내린 주기를 엣지가 1분~6시간으로 자른다', async () => {
  let iv = 1_000;
  const c = await mockCentral((h) => {
    if (h.path === '/api/central/link-check-config') return { status: 200, body: { ok: true, enabled: false, intervalMs: iv, links: [] } };
    return { status: 200, body: { ok: true, stored: 0 } };
  });
  const saved = { ...config.agent };
  const W = await import('../src/agent/linkCheckWorker.js');
  try {
    Object.assign(config.agent, { centralUrl: c.url, centralToken: 'tok', name: 'edge-lc85' });
    await W.runLinkCheckWorkerOnce();
    assert.equal(W.linkCheckWorkerStatus().intervalMs, W.LINK_INTERVAL_MIN_MS, '1초 주기를 그대로 쓰면 안 된다');
    iv = 10 * 86_400_000;
    await W.runLinkCheckWorkerOnce();
    assert.equal(W.linkCheckWorkerStatus().intervalMs, W.LINK_INTERVAL_MAX_MS);
    iv = 120_000;
    await W.runLinkCheckWorkerOnce();
    assert.equal(W.linkCheckWorkerStatus().intervalMs, 120_000, '범위 안이면 그대로');
  } finally { Object.assign(config.agent, saved); await c.close(); }
  assert.match(read('agent/linkCheckWorker.js'), /Math\.min\(LINK_CONCURRENCY_MAX, conc\)/, '동시성 상한');
});

/* ───────── F6 CVP EndpointLocation '지금 조회' 대기열 ───────── */
test('F6 결과 push 를 기다리는 동안 들어온 EndpointLocation 요청도 같은 실행이 처리한다(대기열에 남기지 않는다)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmpDir('edge-audit85-ep-');
  const script = `
    import { mock } from 'node:test';
    process.env.CONFIG_DIR = ${JSON.stringify(dir)};
    const SRC = ${JSON.stringify(SRC + path.sep)};
    const looked = []; let pushes = 0; let hook = null;
    mock.module(SRC + 'cvp/endpointNow.js', { namedExports: { lookupEndpointsNow: async (id) => { looked.push(id); return { ok: true }; } } });
    mock.module(SRC + 'cvp/push.js', { namedExports: { pushCvpNow: async () => { pushes++; if (hook) { const h = hook; hook = null; h(); } await new Promise((r) => setTimeout(r, 30)); return { ok: true }; } } });
    const reg = await import(SRC + 'cvp/registry.js');
    mock.module(SRC + 'cvp/registry.js', { namedExports: { ...reg, serversForThisNode: () => [{ id: 'c1' }, { id: 'c2' }] } });
    const P = await import(SRC + 'agent/cvpConfigPull.js');
    hook = () => { P.runEndpointRequests([{ cvpId: 'c2', macs: ['aabbccddeeff'] }]); };   // 첫 실행의 push 도중 다음 pull 의 요청
    await P.runEndpointRequests([{ cvpId: 'c1', macs: ['aabbccddeeff'] }]);
    await new Promise((r) => setTimeout(r, 100));
    const again = await P.runEndpointRequests([]);   // 실행이 끝났으면 새 실행이 시작돼야 한다(_epRun 이 비워졌는가)
    console.log('RESULT ' + JSON.stringify({ looked, pushes, left: P._epQueueForTest().length, again }));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `자식 실행 결과 없음: ${r.stderr}`);
  const out = JSON.parse(line.slice(7));
  assert.deepEqual(out.looked, ['c1', 'c2'], 'push 도중 들어온 c2 도 조회해야 한다');
  assert.equal(out.left, 0, '대기열에 남은 요청이 없어야 한다');
  assert.equal(out.pushes, 2, '두 번째 조회 결과도 곧바로 push');
  assert.equal(out.again, 0, '실행이 끝난 뒤 새 호출은 새 실행(빈 대기열 → 0)');
});
