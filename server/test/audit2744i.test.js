/**
 * test/audit2744i.test.js — v2.744 점검 GI 그룹 회귀(서버 쪽).
 *
 *  · TIMING-02  아이실론 '지금 수집' 대기에 합쳐진 중앙 요청 표지(central)가 메모리에만 있고 실행 중 스캔 기록(scan-journal queued)에는
 *               남지 않았다 — 엣지가 재시작한 뒤 그 대기를 시한 초과·대상 없음으로 버려도 중앙에 알리지 않았다(중앙은 결과 시한까지 기다렸다).
 *               실제 runNow · 접속을 붙잡는 TCP 서버 · 기록 파일 · 실제 재기동(모듈 새 인스턴스 + scanJournal 다시 읽기)으로 본다.
 *  · LEFT-09    postNo503Retry 본체가 엣지 로그 워커 파일에 있어 cvp·sanswitch·isidu push 가 워커 모듈을 끌어왔다 — util/ 로 옮기고 워커는
 *               재수출만 한다. 행동(503 은 한 번만 · 그 밖의 일시 상태는 재시도)은 그대로다.
 *  · LEFT-08①  GPU 게스트 배포 목록 응답이 대소문자 중복 합침 사실(행의 folded · foldReport)을 화면까지 옮기는지 — 실제 라우터로 본다.
 *
 * 실행: node --test server/test/audit2744i.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

// v2.744(회귀 검토 GI-R3): 임시 폴더는 os.tmpdir() 아래 — 예전에는 세션 스크래치 경로를 박고, 없으면 cwd/../.. 에 만들었다
//   (저장소 루트에서 실행하면 /home 에 mkdtemp → EACCES, server/ 에서 실행하면 저장소 밖에 쓰기). after 에서 지운다.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744i-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSH_READY_TIMEOUT_MS = '20000';   // 붙잡은 접속이 첫 단계 안에 시한으로 끝나지 않게(release 로 끊는다)
process.env.ISIDU_SSH_KEY = '';
process.env.ISIDU_CONCURRENCY = '1';          // 첫 인스턴스: 1개 돌리고 나머지는 대기열 — 재기동 인스턴스는 아래에서 3으로 읽는다
delete process.env.SCAN_RESUME;
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

// LEFT-08①: 모듈 로드 **전에** 대소문자 중복 사본이 든 배포 파일을 둔다(로드가 합친다).
fs.writeFileSync(path.join(DIR, 'central-agent-gpu-guest.json'), JSON.stringify({
  'edge-x': { enabled: true, pollIntervalMs: 300_000, vcenters: { vc1: { enabled: true, username: 'root', password: 'pw-keep-2744', vms: {}, vmIps: {} }, vc2: { enabled: true, username: 'g', password: 'pw2-2744', vms: {}, vmIps: {} } }, _updatedAt: 1000 },
  'Edge-X': { enabled: false, vcenters: { vc1: { vms: { 'vc1:vm-9': { username: 'u9', password: 'p9-2744' } }, vmIps: {} } }, _updatedAt: 2000 },
}));

const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const SRC = new URL('../src/', import.meta.url);
const srcOf = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20_000, step = 20) => {
  const until = performance.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (performance.now() > until) throw new Error('시간 초과'); await sleep(step); }
};
const journalFile = () => JSON.parse(fs.readFileSync(path.join(DIR, 'scan-journal.json'), 'utf8'));

/* ═══════════════ TIMING-02 — 합쳐진 중앙 요청 표지가 재시작을 넘는다 ═══════════════ */

let hold = false; const socks = new Set(); let port = 0;
function release() { hold = false; for (const s of socks) { try { s.destroy(); } catch { /* */ } } }

const J = await import('../src/util/scanJournal.js');
const S = await import('../src/isidu/settings.js');
const P = await import('../src/isidu/poller.js');
const reg = await import('../src/storage/registry.js');
const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');

const ROOT = '/ifs/data/workspace/users';
const local = (id) => ({ id, label: `대상 ${id}`, host: '127.0.0.1', port, path: ROOT, auth: 'key', username: 'admin', intervalHours: 24, enabled: false });
const saveTargets = (ids) => {
  const r = S.saveSettings({ targets: ids.map(local) }, { devices: reg.listDevices(), agents: [], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
};

before(async () => {
  const srv = net.createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => { socks.delete(sock); });
    if (!hold) setTimeout(() => sock.destroy(), 30);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  closers.push(() => new Promise((r) => { release(); srv.close(() => r()); }));
});

/**
 * 재시작 직전 상태를 만든다: ia 진행 중(붙잡은 접속) · ic 는 사람이 누른 대기 → (merge 면) 같은 ic 에 중앙 요청이 합쳐진다.
 * 그 순간의 기록 파일을 그대로 돌려준다(재시작 = 그 파일을 다음 기동이 읽는다). 첫 인스턴스는 정리해 둔다(늦은 꺼내기가 끼어들지 않게).
 */
async function crashState({ merge }) {
  J._resetForTest(); P._resetForTest();
  saveTargets(['ia', 'ib', 'ic']);
  hold = true;
  const a = await P.runNow(['ia', 'ic'], { trigger: 'manual' });
  assert.deepEqual(a.started, ['ia']);
  assert.deepEqual(a.queued, ['ic']);
  const before1 = journalFile().queued.find((q) => q.key === 'ic');
  assert.equal(before1.trigger, 'manual');
  if (merge) {
    const b = await P.runNow(['ic'], { trigger: 'central' });
    assert.deepEqual(b.queued, ['ic'], '이미 기다리던 대상 — 중앙 요청이 그 대기에 합쳐진다');
  }
  const doc = journalFile();
  const rec = doc.queued.find((q) => q.key === 'ic');
  assert.ok(rec, '대기 기록이 남아 있어야 한다');
  assert.equal(rec.since, before1.since, '합류가 대기 시각(since)을 바꾸지 않는다 — 대기 시한이 합류로 늘지 않게');
  assert.equal(rec.until, before1.until);
  // 첫 인스턴스 정리: 대기열·진행 항목을 비우고 붙잡은 접속을 끊는다.
  P._resetForTest();
  release();
  await waitFor(() => J.runningScans().length === 0);
  await sleep(30);
  return { doc, rec };
}

/** 재기동: 그 순간의 기록 파일 → scanJournal 다시 읽기 → poller 새 인스턴스(기동 때 restoreQueue). */
async function reboot(doc, tag, env = {}) {
  fs.writeFileSync(path.join(DIR, 'scan-journal.json'), JSON.stringify(doc));
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try {
    J._reloadForTest();
    return await import(`../src/isidu/poller.js?boot=${tag}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('TIMING-02 ① 합쳐진 중앙 요청 표지가 대기 기록에 남는다(trigger central · 원래 trigger 보존 · since 그대로)', async () => {
  const { rec } = await crashState({ merge: true });
  assert.equal(rec.trigger, 'central', `기록의 trigger 가 중앙 요청 표지다(재시작 뒤 takeQueuedBootDrops 가 돌려주는 유일한 근거): ${JSON.stringify(rec)}`);
  assert.equal(rec.meta?.central, true);
  assert.equal(rec.meta?.origTrigger, 'manual', '원래 trigger 는 meta 에 보존한다(재시작 여부로 조사 기록의 trig 가 바뀌지 않게)');
  J._resetForTest(); P._resetForTest();
});

test('TIMING-02 ② 재시작 뒤 대상이 사라져 대기를 버리면 중앙에 알린다(target-gone) · 원래 trigger 로 되살린다 · 합류가 없던 대기는 알리지 않는다', async () => {
  // 합류 있음
  const { doc } = await crashState({ merge: true });
  saveTargets(['ia', 'ib']);   // 기다리는 동안 ic 가 이 노드 목록에서 빠졌다
  const P2 = await reboot(doc, 'merge', { ISIDU_CONCURRENCY: '3' });
  const q = P2.isiduPollerStatus().queued.find((x) => x.targetId === 'ic');
  assert.ok(q && q.restored, `재시작 전 대기가 대기열로 돌아온다: ${JSON.stringify(P2.isiduPollerStatus().queued)}`);
  assert.equal(q.trigger, 'manual', '원래 trigger(사람이 누른 것)로 되살린다');
  assert.deepEqual(P2.runDropsForPush().list, [], '아직 버린 것이 없다');
  await P2._tickForTest();
  assert.deepEqual(P2.runDropsForPush().list.map((d) => [d.id, d.reason]), [['ic', 'target-gone']],
    `재시작 전에 합쳐진 중앙 요청을 버렸으니 중앙에 알린다 — 수정 전에는 빈 목록(중앙은 결과 시한까지 기다렸다): ${JSON.stringify(P2.runDropsForPush().list)}`);
  P2._resetForTest(); J._resetForTest();

  // 대조: 합류 없음(엣지 화면에서 사람이 누른 대기뿐) — 버려도 중앙 요청이 아니다
  const c = await crashState({ merge: false });
  saveTargets(['ia', 'ib']);
  const P3 = await reboot(c.doc, 'nomerge', { ISIDU_CONCURRENCY: '3' });
  await P3._tickForTest();
  assert.deepEqual(P3.runDropsForPush().list, [], '중앙 요청이 합쳐지지 않은 대기는 알리지 않는다(예전 동작 그대로)');
  P3._resetForTest(); J._resetForTest();
});

test('TIMING-02 ③ SCAN_RESUME=0 으로 재시작해 대기를 다시 넣지 않을 때도 합쳐진 중앙 요청은 알린다(not-restored)', async () => {
  const { doc } = await crashState({ merge: true });
  const P4 = await reboot(doc, 'noresume', { SCAN_RESUME: '0', ISIDU_CONCURRENCY: '3' });
  assert.deepEqual(P4.isiduPollerStatus().queued, [], 'SCAN_RESUME=0 — 대기열에 다시 넣지 않는다');
  assert.deepEqual(P4.runDropsForPush().list.map((d) => [d.id, d.reason]), [['ic', 'not-restored']],
    `기동 때 다시 넣지 않은 대기 중 합쳐진 중앙 요청을 알린다: ${JSON.stringify(P4.runDropsForPush().list)}`);
  P4._resetForTest(); J._resetForTest();
  // 대조: 합류 없음 — 알리지 않는다
  const c = await crashState({ merge: false });
  const P5 = await reboot(c.doc, 'noresume2', { SCAN_RESUME: '0', ISIDU_CONCURRENCY: '3' });
  assert.deepEqual(P5.runDropsForPush().list, []);
  P5._resetForTest(); J._resetForTest();
});

/* ═══════════════ LEFT-09 — postNo503Retry 는 util/ 에 있고 행동은 그대로다 ═══════════════ */

/** import 지정자 목록(정적 from · 동적 import · 재수출 from) — 주석을 먼저 지운다(v2.535 규약). */
function importsOf(rel) {
  const src = stripComments(srcOf(rel));
  const out = [];
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

test('LEFT-09 ① cvp·sanswitch·isidu push 는 엣지 로그 워커 모듈을 import 하지 않는다 · util/postNo503Retry.js 는 util·node 내장만 import 한다', () => {
  for (const rel of ['cvp/push.js', 'sanswitch/perfPush.js', 'isidu/push.js']) {
    const imps = importsOf(rel);
    assert.ok(!imps.some((x) => /agent\/edgeLogWorker\.js$/.test(x)), `${rel} 가 엣지 워커 파일을 끌어온다: ${imps.join(', ')}`);
    assert.ok(imps.includes('../util/postNo503Retry.js'), `${rel} 는 util/postNo503Retry.js 에서 가져온다`);
  }
  const imps = importsOf('util/postNo503Retry.js');
  assert.ok(imps.length > 0);
  for (const x of imps) assert.ok(x.startsWith('./') || x.startsWith('node:'), `util/ 모듈이 바깥을 향한다(arch2579 ②): ${x}`);
});

test('LEFT-09 ② 엣지 로그 워커는 같은 함수를 재수출한다(복제 금지) · 행동은 그대로 — 503 은 한 번만 · 502 는 호출 안에서 재시도', async () => {
  const u = await import('../src/util/postNo503Retry.js');
  const w = await import('../src/agent/edgeLogWorker.js');
  assert.equal(typeof u.postNo503Retry, 'function');
  assert.equal(w.postNo503Retry, u.postNo503Retry, '워커의 export 는 util 의 같은 함수여야 한다(두 벌이면 규칙 수정이 한쪽에만 들어간다)');
  const posts = { p503: 0, p502: 0 };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const k = req.url.slice(1);
      posts[k] = (posts[k] || 0) + 1;
      res.writeHead(k === 'p503' ? 503 : 502, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const FAKE = `http://127.0.0.1:${srv.address().port}`;
  const r1 = await u.postNo503Retry(`${FAKE}/p503`, { method: 'POST', body: 'x', timeoutMs: 5000, retries: 5 }, { backoffMs: 5 });
  assert.equal(r1.status, 503);
  assert.equal(posts.p503, 1, '503 은 호출 안에서 다시 보내지 않는다(init.retries 도 무시)');
  const r2 = await u.postNo503Retry(`${FAKE}/p502`, { method: 'POST', body: 'x', timeoutMs: 5000 }, { backoffMs: 5 });
  assert.equal(r2.status, 502);
  assert.equal(posts.p502, 3, '그 밖의 일시 상태는 예전처럼 재시도(기본 2회 → 3번)');
});

/* ═══════════════ LEFT-08① — GPU 게스트 배포 목록이 합친 사실을 화면까지 옮긴다 ═══════════════ */

test('LEFT-08① GET /gpu-guest/deploy/agents — 합친 행은 folded(개수)를, 응답은 foldReport(경로 이름 · 상한 + 전체 개수)를 싣는다 · 비밀번호 값은 없다', async () => {
  const express = (await import('express')).default;
  const { registerGpuGuest } = await import('../src/routes/admin/gpuGuest.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
  const r = express.Router();
  registerGpuGuest(r);
  app.use('/api/admin', r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/gpu-guest/deploy/agents`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.agents.find((a) => a.agent.toLowerCase() === 'edge-x');
  assert.ok(row && row.assigned, JSON.stringify(body.agents));
  assert.deepEqual(row.folded?.from, [row.agent === 'edge-x' ? 'Edge-X' : 'edge-x'], `행이 합친 사실을 싣는다: ${JSON.stringify(row)}`);
  assert.ok(row.folded.keptOlder >= 1, '옛 값을 유지한 항목 개수');
  assert.ok(body.foldReport && Array.isArray(body.foldReport.groups), `foldReport 가 응답에 있어야 한다(gpuGuestFoldStatus — 예전에는 아무도 부르지 않았다): ${JSON.stringify(Object.keys(body))}`);
  const g = body.foldReport.groups.find((x) => x.kept === row.agent);
  assert.ok(g, JSON.stringify(body.foldReport));
  assert.ok(g.keptOlder.includes('enabled'), `옛 값을 유지한 항목 경로: ${JSON.stringify(g.keptOlder)}`);
  assert.equal(g.keptOlderTotal, row.folded.keptOlder, '전체 개수는 행의 개수와 같다');
  assert.ok(g.keptOlder.length <= 20, '경로 목록은 상한(조용히 자르지 않고 전체 개수를 함께 준다)');
  assert.deepEqual(g.vcentersFromOlder, ['vc2']);
  const txt = JSON.stringify(body);
  for (const secret of ['pw-keep-2744', 'pw2-2744', 'p9-2744']) assert.ok(!txt.includes(secret), `비밀번호 값을 싣지 않는다: ${secret}`);
});
