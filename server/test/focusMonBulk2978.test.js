/**
 * test/focusMonBulk2978.test.js — v2.978 서버 집중 모니터링 ‘CSV 대량 등록 · 엣지 연결 강화’ (사용자 요청 2026-11-12).
 *  ① CSV 계획: 머리글 열 찾기(순서 무관) · 탭 · 따옴표 · BOM · 수식 가드 되돌림 · 새로/갱신/그대로/오류 · 같은 파일 중복 · 모호한 갱신 · 상한
 *  ② CSV 적용: 맞는 줄만 / 모두 맞을 때만 · 갱신 끄기 · 한 번의 쓰기 · 접속처가 바뀐 id · 인증 정지는 지우지 않는다(접속처가 같으면 그대로 멈춤)
 *  ③ 내보내기 → 다시 가져오기 = 모두 ‘그대로’ · 양식 · 예전 importCsv 호환(errors · 전부 아니면 없음)
 *  ④ 노드 옮기기 · ⑤ 라우트 권한 · 일괄 시험(동시 1건 · 시험 문턱) · 엣지 깨우기(등록된 이름만 · 10초 문턱 · 결과 기록)
 *  ⑥ 엣지 진단 정제(아는 칸만 · 음수/글자 → null · 상한 · 시각은 나이로) · 쉬는 주기(idleMs) · 업그레이드 판정 · 워커 주기(순수) · 워커 syncOnce 실호출
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonbulk2978-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-bulk-2978';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-bulk-2978-xxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { centralRouter } = await import('../src/routes/central.js');
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const svc = await import('../src/focusmon/service.js');
const registry = await import('../src/focusmon/registry.js');
const store = await import('../src/focusmon/store.js');
const edge = await import('../src/central/focusMonEdge.js');
const bulk = await import('../src/focusmon/bulkTest.js');
const { focusAuthGuard, authDevOf } = await import('../src/focusmon/collector.js');
const { edgeUpgradeNeed } = await import('../src/routes/api/focusMon.js');
const worker = await import('../src/agent/focusMonWorker.js');
const { config } = await import('../src/config.js');

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
  operator: { username: 'o', role: 'operator', scope: null },
  wscoped: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-x'] } },
  demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
};
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { worker.stopFocusMonWorker(); svc.stopFocusMon(); srv.close(); });

async function call(method, p, { who = 'admin', body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}
const AG = ['edge-pl', 'edge-us'];
const reset = () => { fs.rmSync(path.join(DIR, 'focusmon-targets.json'), { force: true }); registry._resetForTest(); };

test('① CSV 계획 — 머리글 순서 무관 · 탭 · 따옴표 · BOM · 수식 가드 되돌림 · 줄마다 처리', () => {
  reset();
  registry.addTarget({ name: 'old-1', host: '10.1.0.1', port: 22, username: 'root', agent: '' }, { agents: AG });
  registry.addTarget({ name: 'same-1', host: '10.1.0.2', port: 22, username: 'dvcmon', agent: 'edge-pl' }, { agents: AG });
  // 같은 IP · 포트에 계정이 다른 등록 둘 → 어느 것을 바꿀지 모른다
  registry.addTarget({ name: 'amb-a', host: '10.1.0.3', port: 22, username: 'a', agent: '' }, { agents: AG });
  registry.addTarget({ name: 'amb-b', host: '10.1.0.3', port: 22, username: 'b', agent: '' }, { agents: AG });
  const text = '﻿계정\tIP\t이름\t담당 노드\t포트\n'
    + 'dvcmon\t10.1.0.1\told-1\t중앙\t22\n'        // 계정 root → dvcmon (갱신)
    + 'dvcmon\t10.1.0.2\tsame-1\tEDGE-PL\t22\n'    // 노드 이름 대소문자만 다름 → 그대로
    + 'dvcmon\t10.1.0.9\t"new 9"\t\t\n'             // 새로 · 포트 빈 칸 = 22 · 노드 빈 칸 = 중앙
    + "dvcmon\t10.1.0.10\t'=cmd\t\t22\n"             // 내보내기 가드가 되돌려져 '=cmd' → 이름 규칙 위반
    + 'dvcmon\t10.1.0.9\tdup\t\t22\n'               // 같은 파일 안 같은 IP · 포트
    + 'x\t10.1.0.3\tamb\t\t22\n'                    // 모호
    + 'dvcmon\t127.0.0.1\tlo\t\t22\n'               // SSRF 가드
    + 'dvcmon\t10.1.0.11\tbad-node\tno-such\t22\n';
  const p = registry.planCsv(text, { agents: AG });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.header, true);
  const act = p.rows.map((r) => `${r.line}:${r.action}${r.code ? `/${r.code}` : ''}`);
  assert.deepEqual(act, ['2:update', '3:same', '4:add', '5:error/bad-name', '6:error/dup-in-file', '7:error/ambiguous', '8:error/blocked-host', '9:error/bad-agent']);
  assert.deepEqual(p.rows[0].changes, ['username']);
  assert.equal(p.rows[2].value.port, 22);
  assert.equal(p.rows[2].value.name, 'new 9');
  assert.deepEqual(p.counts, { add: 1, update: 1, same: 1, error: 5 });
  assert.equal(registry.listTargets().length, 4, '계획은 아무것도 쓰지 않는다');
  // 계정은 대소문자가 다르면 다른 계정이다(리눅스)
  const p2 = registry.planCsv('이름,IP,포트,계정\nold-1,10.1.0.1,22,ROOT', { agents: AG });
  assert.equal(p2.rows[0].action, 'update');
  // 머리글 없음 = 기본 순서 · 상한 · 빈 본문 · 깨진 따옴표
  assert.equal(registry.planCsv('a,10.1.0.20,22,u,', { agents: AG }).rows[0].action, 'add');
  assert.deepEqual(registry.planCsv('이름,IP\n\nb1,10.1.0.21\n', { agents: AG }).rows.map((r) => r.line), [3], '줄 번호는 엑셀 행 번호(빈 줄도 센다)');
  assert.equal(registry.planCsv('', { agents: AG }).code, 'empty');
  assert.equal(registry.planCsv('이름,IP\n', { agents: AG }).code, 'empty');
  const many = Array.from({ length: registry.CSV_MAX_ROWS + 1 }, (_, i) => `s${i},10.2.${i >> 8}.${i & 255},22,u,`).join('\n');
  assert.equal(registry.planCsv(many, { agents: AG }).code, 'too-many');
  assert.equal(registry.planCsv('x'.repeat(registry.CSV_MAX_BYTES + 1), { agents: AG }).code, 'too-big');
  const uq = registry.planCsv('a,"10.1.0.1,22', { agents: AG });
  assert.equal(uq.rows[0].action, 'error', '닫히지 않은 따옴표는 끝까지 한 칸 — 주소 오류로 걸린다');
});

test('② CSV 적용 — 맞는 줄만 / 모두 맞을 때만 · 갱신 끄기 · 접속처가 바뀐 id · 인증 정지를 지우지 않는다', () => {
  reset();
  const a = registry.addTarget({ name: 'keep', host: '10.3.0.1', port: 22, username: 'dvcmon' }, { agents: AG }).target;
  const b = registry.addTarget({ name: 'chg', host: '10.3.0.2', port: 22, username: 'root' }, { agents: AG }).target;
  // 두 대 모두 인증 정지(중앙 키 지문 'fp')
  focusAuthGuard.markAuthStopped(`fm|${a.id}`, authDevOf(a, 'fp'), '거부');
  focusAuthGuard.markAuthStopped(`fm|${b.id}`, authDevOf(b, 'fp'), '거부');
  const text = '이름,IP,포트,계정\nkeep-renamed,10.3.0.1,22,dvcmon\nchg,10.3.0.2,22,dvcmon\nnew,10.3.0.3,22,dvcmon\nbad,10.3.0.300,22,dvcmon';
  const all = registry.applyCsv(text, { agents: AG, mode: 'all', update: true });
  assert.equal(all.ok, false); assert.equal(all.code, 'invalid-rows'); assert.equal(all.errors[0].line, 5);
  assert.equal(registry.listTargets().length, 2, '모두 맞을 때만 — 하나도 넣지 않았다');
  const noUpd = registry.applyCsv(text, { agents: AG, mode: 'valid', update: false });
  assert.equal(noUpd.added, 1); assert.equal(noUpd.updated, 0); assert.equal(noUpd.skipped, 1 + 2, '오류 1줄 + 갱신 끈 2줄');
  assert.equal(registry.getTarget(b.id).username, 'root');
  const r = registry.applyCsv(text, { agents: AG, mode: 'valid', update: true });
  assert.equal(r.ok, true);
  assert.equal(r.added, 0, '새 줄은 앞에서 넣어 이제 그대로'); assert.equal(r.updated, 2); assert.equal(r.same, 1);
  assert.deepEqual(r.moved, [b.id], '계정이 바뀐 대상만 접속처가 바뀌었다');
  assert.equal(registry.getTarget(a.id).name, 'keep-renamed');
  // 접속처가 같은 대상은 정지가 그대로(자동 재시도 금지) · 바뀐 대상은 새 자격(계정)이라 정지 기록이 맞지 않는다
  assert.ok(focusAuthGuard.peekAuthStop(authDevOf(registry.getTarget(a.id), 'fp')), '이름만 바꾼 대상은 계속 멈춤');
  assert.equal(focusAuthGuard.peekAuthStop(authDevOf(registry.getTarget(b.id), 'fp')), null, '계정을 바꾼 대상은 새 자격 — 한 번 시도할 수 있다');
  // 상한
  const cap = Array.from({ length: registry.MAX_TARGETS }, (_, i) => `n${i},10.4.${i >> 8}.${i & 255},22,u`).join('\n');
  const over = registry.applyCsv(`이름,IP,포트,계정\n${cap}`, { agents: AG, mode: 'valid', update: true });
  assert.equal(over.ok, false); assert.equal(over.code, 'too-many');
  // 예전 importCsv(라우트 기본) — 추가만 · 전부 아니면 없음
  const legacy = registry.importCsv('이름,IP,포트,계정,담당\nz1,10.5.0.1,22,u,중앙\nz2,10.5.0.300,22,u,', { agents: AG });
  assert.equal(legacy.ok, false); assert.equal(legacy.errors[0].line, 3);
});

test('③ 내보내기 → 다시 가져오기는 모두 그대로 · 양식', async () => {
  reset();
  assert.equal(registry.addTarget({ name: 'dash name.1', host: '10.6.0.1', port: 2222, username: 'svc.mon', agent: 'edge-pl' }, { agents: AG }).ok, true);
  registry.addTarget({ name: 'plain', host: '10.6.0.2', port: 22, username: 'dvcmon' }, { agents: AG });
  const { csvLine } = await import('../src/util/csv.js');
  const text = registry.exportRows().map((r) => csvLine(r)).join('\n');
  const p = registry.planCsv(text, { agents: AG });
  assert.deepEqual(p.counts, { add: 0, update: 0, same: 2, error: 0 }, JSON.stringify(p.rows));
  assert.deepEqual(registry.csvTemplateRows()[0], [...registry.CSV_HEADER]);
});

test('④ 노드 옮기기 — 중앙 → 엣지 · 겹치면 건너뜀 · 모르는 노드 · 같은 노드', () => {
  reset();
  const x = registry.addTarget({ name: 'm1', host: '10.7.0.1', port: 22, username: 'u' }, { agents: AG }).target;
  registry.addTarget({ name: 'm2', host: '10.7.0.2', port: 22, username: 'u' }, { agents: AG });
  registry.addTarget({ name: 'm2-pl', host: '10.7.0.2', port: 22, username: 'u', agent: 'edge-pl' }, { agents: AG });
  assert.equal(registry.moveTargets({ from: '', to: 'nope' }, { agents: AG }).code, 'bad-agent');
  assert.equal(registry.moveTargets({ from: 'edge-pl', to: 'EDGE-PL' }, { agents: AG }).code, 'same-node');
  const r = registry.moveTargets({ from: '', to: 'EDGE-PL' }, { agents: AG });
  assert.equal(r.ok, true); assert.deepEqual(r.moved, [x.id]); assert.equal(r.skipped, 1);
  assert.equal(registry.getTarget(x.id).agent, 'edge-pl', '정식 이름으로');
  const back = registry.moveTargets({ from: 'edge-pl', to: '', ids: [x.id] }, { agents: AG });
  assert.deepEqual(back.moved, [x.id]);
});

test('⑤ 라우트 — 미리보기 · 적용 권한 · 감사 · 내보내기 · 양식', async () => {
  reset();
  const text = '이름,IP,포트,계정\nr1,10.8.0.1,22,dvcmon\nr2,10.8.0.2,22,dvcmon';
  for (const who of ['operator', 'wscoped', 'demo']) assert.equal((await call('POST', '/api/tools/focus-mon/targets/import/preview', { who, body: { text } })).status, 403, who);
  const pv = await call('POST', '/api/tools/focus-mon/targets/import/preview', { body: { text } });
  assert.equal(pv.status, 200, pv.text); assert.equal(pv.body.counts.add, 2);
  assert.equal(registry.listTargets().length, 0, '미리보기는 쓰지 않는다');
  const ap = await call('POST', '/api/tools/focus-mon/targets/import', { body: { text, mode: 'valid', update: true } });
  assert.equal(ap.status, 200, ap.text); assert.equal(ap.body.added, 2); assert.equal(ap.body.ids.length, 2);
  const ex = await call('GET', '/api/tools/focus-mon/targets/export.csv');
  assert.equal(ex.status, 200);
  const raw = Buffer.from(await (await fetch(`${base}/api/tools/focus-mon/targets/export.csv`, { headers: { 'x-test-user': 'admin' } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM(엑셀 한글)');
  assert.ok(ex.text.replace(/^\uFEFF/, '').startsWith('이름,IP,포트,계정,담당 노드'), ex.text.slice(0, 40));
  assert.match(ex.text, /r1,10\.8\.0\.1,22,dvcmon,중앙/);
  assert.ok(!/demo|password|privateKey/i.test(ex.text), '데모 대상 · 비밀 칸 없음');
  const tp = await call('GET', '/api/tools/focus-mon/targets/export.csv?template=1');
  assert.match(tp.text, /192\.0\.2\.11/);
  assert.equal((await call('GET', '/api/tools/focus-mon/targets/export.csv', { who: 'operator' })).status, 403);
  const { listAudit } = await import('../src/audit.js').catch(() => ({}));
  if (typeof listAudit === 'function') {
    const acts = (await listAudit({ limit: 50 }))?.items?.map?.((x) => x.action) || [];
    if (acts.length) assert.ok(acts.includes('focus-mon.target.import') && acts.includes('focus-mon.target.export'));
  }
});

test('⑤ 일괄 시험 — 진행률 · 동시 1건 · 시험 문턱(10초 안 시험은 건너뜀) · 데모 계정 403', async () => {
  bulk._resetBulkForTest();
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  const demo = main.targets.filter((t) => t.demo).map((t) => t.id).slice(0, 6);
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/test-bulk', { who: 'demo', body: { ids: demo } })).status, 403);
  // 한 대는 방금 따로 시험 → 일괄에서 건너뛴다
  assert.equal((await call('POST', `/api/tools/focus-mon/targets/${demo[0]}/test`, { body: {} })).status, 200);
  const r = await call('POST', '/api/tools/focus-mon/targets/test-bulk', { body: { ids: [...demo, 'fm-0000000000'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.job.total, 6, '없는 id 는 뺀다'); assert.equal(r.body.job.skipped, 1);
  let p = null;
  for (let i = 0; i < 50; i++) { p = (await call('GET', '/api/tools/focus-mon')).body.bulkTest; if (p?.finished) break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(p.finished, true, JSON.stringify({ p, demo, job: r.body })); assert.equal(p.done, 5); assert.equal(p.ok, 5); assert.equal(p.skipped, 1);
  assert.equal((await call('GET', '/api/tools/focus-mon', { who: 'demo' })).body.bulkTest, undefined, '데모 계정 판본에 작업 없음');
  // 진행 중이면 409 — 중앙 몫이 끝나지 않은 작업을 흉내(앞 작업은 비운다 — 흉내 testOf 가 null 이라 앞 작업이 '답 기다림' 으로 보인다)
  bulk._resetBulkForTest();
  const slow = bulk.startBulk({ targets: [{ id: 'fm-a1', agent: '' }], by: 't', gate: () => true, release: () => {}, testLocal: () => new Promise(() => {}), putResult: () => {}, queueEdge: () => {}, wake: () => {}, testOf: () => null });
  assert.equal(slow.ok, true);
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/test-bulk', { body: { ids: demo.slice(1) } })).status, 409);
  bulk._resetBulkForTest();
});

test('⑤ 일괄 시험 순수 — 엣지 몫은 대기열 · 엣지마다 한 번 깨움 · 답이 없으면 시한 뒤 ‘답 없음’', () => {
  bulk._resetBulkForTest();
  const queued = []; const woke = [];
  const t0 = 1_000_000;
  const r = bulk.startBulk({
    targets: [{ id: 'e1', agent: 'edge-pl' }, { id: 'e2', agent: 'EDGE-PL' }, { id: 'e3', agent: 'edge-us' }], by: 't', now: t0,
    gate: () => true, release: () => {}, testLocal: async () => ({ ok: true }), putResult: () => {},
    queueEdge: (t) => queued.push(t.id), wake: (a) => woke.push(a), testOf: () => null,
  });
  assert.equal(r.ok, true); assert.deepEqual(queued, ['e1', 'e2', 'e3']); assert.equal(woke.length, 2, '엣지마다 한 번');
  const res = { e1: { result: { ok: true, kind: 'ok' }, at: t0 + 5 }, e2: { result: { ok: false, kind: 'auth' }, at: t0 + 6 }, e3: { result: null, at: 0 } };
  const mid = bulk.bulkProgress(bulk.bulkJob(), (id) => res[id], t0 + 10);
  assert.equal(mid.finished, false); assert.equal(mid.waiting, 1); assert.deepEqual(mid.kinds, { ok: 1, auth: 1 });
  const late = bulk.bulkProgress(bulk.bulkJob(), (id) => res[id], t0 + bulk.BULK_TTL_MS + 1);
  assert.equal(late.finished, true); assert.equal(late.noAnswer, 1);
  // 작업 시작 전 결과는 세지 않는다
  const old = bulk.bulkProgress(bulk.bulkJob(), () => ({ result: { ok: true, kind: 'ok' }, at: t0 - 1 }), t0 + 10);
  assert.equal(old.done, 0);
  bulk._resetBulkForTest();
});

test('⑤ 노드 옮기기 · 엣지 깨우기 라우트 — 등록된 이름만 · 10초 문턱 · 결과는 노드 카드에', async () => {
  reset();
  issueAgentToken('edge-pl');
  registry.addTarget({ name: 'w1', host: '10.9.0.1', port: 22, username: 'u' }, { agents: ['edge-pl'] });
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/move', { who: 'wscoped', body: { from: '', to: 'edge-pl' } })).status, 403);
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/move', { body: { from: '', to: 'nope' } })).status, 400);
  const mv = await call('POST', '/api/tools/focus-mon/targets/move', { body: { from: '', to: 'edge-pl' } });
  assert.equal(mv.status, 200, mv.text); assert.equal(mv.body.moved.length, 1);
  assert.equal((await call('POST', '/api/tools/focus-mon/edges/no-such-edge/wake', { body: {} })).status, 404);
  assert.equal((await call('POST', '/api/tools/focus-mon/edges/edge-pl/wake', { who: 'demo', body: {} })).status, 403);
  const w = await call('POST', '/api/tools/focus-mon/edges/EDGE-PL/wake', { body: {} });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.wake.ok, false);
  assert.equal(w.body.wake.kind, 'not-registered', '수집 서버 등록부에 없으면 접속하지 않는다');
  assert.equal(w.body.wake.by, 'manual');
  assert.equal((await call('POST', '/api/tools/focus-mon/edges/edge-pl/wake', { body: {} })).status, 429);
  const node = (await call('GET', '/api/tools/focus-mon')).body.nodes.find((x) => x.agent === 'edge-pl');
  assert.equal(node.wake.kind, 'not-registered'); assert.equal(node.targets, 1);
  assert.equal(node.idleMs, registry.getSettings().edgeIdleSec * 1000);
  assert.equal((await call('GET', '/api/tools/focus-mon', { who: 'demo' })).body.nodes.some((x) => x.kind === 'edge'), false, '데모 판본에 엣지 없음');
});

test('⑥ 엣지 진단 정제 · 쉬는 주기 · 업그레이드 판정', async () => {
  const now = 10_000_000_000;
  const d = edge.cleanDiag({ rttMs: -5, fails: '3', buffered: 1e9, dropped: 'x', collectors: 2, testsBusy: null, idleMs: 10_000, lastError: 'HTTP 503\n— 중앙\u0000', lastErrorAgoMs: 99 * 86_400_000, evil: { a: 1 }, __proto__: { polluted: 1 } }, now);
  assert.deepEqual(Object.keys(d).sort(), ['buffered', 'collectors', 'dropped', 'fails', 'idleMs', 'lastError', 'lastErrorAt', 'rttMs', 'testsBusy']);
  assert.equal(d.rttMs, null, '음수는 null'); assert.equal(d.fails, 3, '숫자 글자는 수로'); assert.equal(d.buffered, 100_000, '상한');
  assert.equal(d.dropped, null); assert.equal(d.testsBusy, null);
  assert.ok(!/[\x00-\x1f]/.test(d.lastError), '제어 문자 제거');
  assert.equal(d.lastErrorAt, now - 7 * 86_400_000, '나이는 7일로 자른다(엣지 시계를 쓰지 않는다)');
  assert.equal(edge.cleanDiag('x', now), null); assert.equal(edge.cleanDiag(null, now), null);
  assert.equal(edge.cleanDiag({ lastErrorAgoMs: 5 }, now).lastErrorAt, null, '오류 글이 없으면 시각도 없다');
  // 동기화 — 맡은 서버가 있으면 idleMs · 진단 저장 · 없으면 idleMs 를 싣지 않는다
  reset();
  issueAgentToken('edge-us');
  const none = edge.handleEdgeSync('edge-us', { sentAt: now, diag: { rttMs: 40 } }, now);
  assert.equal('idleMs' in none, false);
  assert.equal(store.edgeStateOf('edge-us').diag.rttMs, 40);
  registry.addTarget({ name: 'u1', host: '10.10.0.1', port: 22, username: 'u', agent: 'edge-us' }, { agents: ['edge-us'] });
  registry.saveSettings({ ...registry.getSettings(), edgeIdleSec: 3 });
  assert.equal(registry.getSettings().edgeIdleSec, registry.SETTING_RANGES.edgeIdleSec[0], '설정 하한으로 자른다');
  const has = edge.handleEdgeSync('edge-us', { sentAt: now }, now);
  assert.equal(has.idleMs, registry.SETTING_RANGES.edgeIdleSec[0] * 1000);
  assert.equal(store.edgeStateOf('edge-us').diag, null, '진단을 안 보낸 동기화(옛 판)는 지난 진단을 남기지 않는다');
  // 업그레이드 판정
  assert.equal(edgeUpgradeNeed({ synced: false, wakeKind: 'old-version' }, { diagMin: '2.978.0' }), 'feature');
  assert.equal(edgeUpgradeNeed({ synced: false, wakeKind: 'unreachable' }, { diagMin: '2.978.0' }), null, '닿지 않은 것은 옛 판으로 단정하지 않는다');
  assert.equal(edgeUpgradeNeed({ synced: true, version: '2.977.9' }, { diagMin: '2.978.0' }), 'diag');
  assert.equal(edgeUpgradeNeed({ synced: true, version: '2.978.0' }, { diagMin: '2.978.0' }), null);
  assert.equal(edgeUpgradeNeed({ synced: true, version: '' }, { diagMin: '2.978.0' }), null, '판을 모르면 단정하지 않는다');
  assert.match(edge.focusEdgeMinVersion(), /^\d+\.\d+\.\d+$/);
});

test('⑥ 워커 주기(순수) — 수집 중 2초 · 중앙이 준 쉬는 주기를 [5초, 60초]로 · 없으면 30초', () => {
  assert.equal(worker.nextDelayMs({ active: true, idleHintMs: 60_000 }), 2_000);
  assert.equal(worker.nextDelayMs({ active: false }), 30_000);
  assert.equal(worker.nextDelayMs({ active: false, idleHintMs: 10_000 }), 10_000);
  assert.equal(worker.nextDelayMs({ active: false, idleHintMs: 1 }), worker.IDLE_MIN_MS);
  assert.equal(worker.nextDelayMs({ active: false, idleHintMs: 1e12 }), worker.IDLE_MAX_MS);
  assert.equal(worker.nextDelayMs({ active: false, idleHintMs: Number.NaN }), 30_000);
  assert.equal(worker.nextDelayMs({ active: false, idleHintMs: -1 }), 30_000);
});

test('⑥ 워커 syncOnce 실호출 — 진단을 싣고(비밀 없음) · 중앙이 준 쉬는 주기를 따른다 · 실패하면 30초로', async () => {
  reset();
  const tok = issueAgentToken('edge-pl').token;
  registry.addTarget({ name: 'p1', host: '10.11.0.1', port: 22, username: 'u', agent: 'edge-pl' }, { agents: ['edge-pl'] });
  registry.saveSettings({ ...registry.getSettings(), edgeIdleSec: 12 });
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = base; config.agent.centralToken = tok; config.agent.name = 'edge-pl';
  try {
    worker._resetForTest();
    const body = worker.diagBody();
    assert.ok(!/token|password|privateKey|10\.11/i.test(JSON.stringify(body)), '진단에 비밀 · 주소 없음');
    const r = await worker.syncOnce();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(worker.focusMonWorkerStatus().idleMs, 12_000, '중앙이 준 쉬는 주기');
    const d = store.edgeStateOf('edge-pl').diag;
    assert.ok(d && d.fails === 0 && d.collectors === 0, JSON.stringify(d));
    // 중앙이 끊기면 쉬는 주기 힌트를 버리고 30초 · 다음 진단에 마지막 오류가 실린다
    config.agent.centralUrl = 'http://127.0.0.1:9';
    const f = await worker.syncOnce();
    assert.equal(f.ok, false);
    assert.equal(worker.focusMonWorkerStatus().idleMs, 30_000);
    assert.equal(worker.diagBody().fails, 1); assert.ok(worker.diagBody().lastError);
  } finally {
    worker.stopFocusMonWorker(); worker._resetForTest();
    config.agent.centralUrl = saved.url; config.agent.centralToken = saved.tok; config.agent.name = saved.name;
  }
});

test('⑦ 사용자 보고(2026-11-12) — 시험만 한 엣지 서버의 다시 연결: 중앙이 접속 정보를 싣고 · 엣지가 정지를 푼다 · 한 번 시험을 같이 보낸다', async () => {
  reset();
  const tok = issueAgentToken('edge-nj').token;
  const t = registry.addTarget({ name: 'LESASBPDPNB27', host: '10.52.0.145', port: 22, username: 'sbpadmin', agent: 'edge-nj' }, { agents: ['edge-nj'] }).target;
  // 엣지 쪽 인증 정지(키 로그인 거부 — 같은 노드 키 지문)
  const { focusKeys } = svc;
  focusKeys.ensureKey();
  const fp = focusKeys.keyInfo({ fresh: true }).fingerprint;
  focusAuthGuard.markAuthStopped(`fm|${t.id}`, authDevOf(t, fp), '키 로그인 거부(연결 시험)');
  assert.ok(focusAuthGuard.peekAuthStop(authDevOf(t, fp)));
  // 라우트: 다시 연결 = 엣지 대기열에 다시 연결 + 시험 한 번
  const r = await call('POST', `/api/tools/focus-mon/targets/${t.id}/retry`, { body: {} });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.via, 'edge'); assert.equal(r.body.test, true);
  // 중앙 동기화 응답: retries(옛 판) + retryTargets(접속 정보 — 그 엣지 몫만)
  const sy = edge.handleEdgeSync('edge-nj', { sentAt: Date.now() });
  assert.deepEqual(sy.retries, [t.id]);
  assert.deepEqual(sy.retryTargets, [{ id: t.id, host: '10.52.0.145', port: 22, username: 'sbpadmin' }]);
  assert.deepEqual(sy.tests.map((x) => x.id), [t.id], '정지를 푼 뒤 한 번 시험');
  assert.ok(!/password|privateKey/i.test(JSON.stringify(sy)));
  // 다른 엣지에는 싣지 않는다
  store.requestEdgeRetry(t.id, 'edge-nj');
  issueAgentToken('edge-other');
  const other = edge.handleEdgeSync('edge-other', { sentAt: Date.now() });
  assert.deepEqual(other.retryTargets, []);
  // 엣지 워커 실호출: 수집 중이 아닌 대상인데도 retryTargets 로 정지를 푼다(예전: byId 에 없어 not-running — 정지 그대로)
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = base; config.agent.centralToken = tok; config.agent.name = 'edge-nj';
  try {
    worker._resetForTest();
    store.requestEdgeRetry(t.id, 'edge-nj');
    // 같은 프로세스라 시험이 실제 접속을 시도하지 않게 대기열의 시험은 비운다(이 검사는 '정지가 풀리는가' 만 본다)
    store.pendingTestsFor('edge-nj');
    const out = await worker.syncOnce();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(focusAuthGuard.peekAuthStop(authDevOf(t, fp)), null, '엣지가 수집 목록 밖 대상의 정지를 풀었다');
  } finally {
    worker.stopFocusMonWorker(); worker._resetForTest();
    config.agent.centralUrl = saved.url; config.agent.centralToken = saved.tok; config.agent.name = saved.name;
  }
  // 60초 안에 다시 누르면 엣지 러너가 거절한다(정지를 다시 걸고 시험)
  focusAuthGuard.markAuthStopped(`fm|${t.id}`, authDevOf(t, fp), '키 로그인 거부(연결 시험)');
  assert.equal(worker._runnerForTest.retry(t.id, t).code, 'too-soon');
  assert.ok(focusAuthGuard.peekAuthStop(authDevOf(t, fp)), '60초 안 두 번째는 정지를 풀지 않는다');
});

test('⑧ 반증 반영 — 엣지 시험 동시 상한 · 등록부에서 빠진 엣지의 서버 옮기기 · 머리글 별칭 · 중앙 몫은 시작할 때 문턱 · 시한', async () => {
  // 1) 엣지가 보고한 진행 중 시험 수만큼 덜 배달(옛 판 = null → 예전처럼 20)
  reset();
  issueAgentToken('edge-cap');
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push(registry.addTarget({ name: `c${i}`, host: `10.60.0.${i + 1}`, port: 22, username: 'u', agent: 'edge-cap' }, { agents: ['edge-cap'] }).target.id);
  for (const id of ids) store.requestEdgeTest(id, 'edge-cap');
  const now = Date.now();
  assert.equal(edge.handleEdgeSync('edge-cap', { sentAt: now, diag: { testsBusy: store.EDGE_TEST_CONCURRENCY - 3 } }, now).tests.length, 3, '상한까지 남은 자리만');
  assert.equal(edge.handleEdgeSync('edge-cap', { sentAt: now, diag: { testsBusy: 99 } }, now).tests.length, 0, '가득 차면 0');
  assert.equal(edge.handleEdgeSync('edge-cap', { sentAt: now }, now).tests.length, 20, '옛 판(진단 없음)은 예전처럼 최대 20');
  assert.ok(store.EDGE_TEST_TTL_MS >= 15 * 60_000 && bulk.BULK_TTL_MS > store.EDGE_TEST_TTL_MS, '일괄 시험 시한이 엣지 대기열 수명보다 길다');
  // 엣지 워커가 동기화당 보내는 결과 수 = 중앙이 받는 상한(넘는 것은 다음 동기화에)
  const wsrc = fs.readFileSync(new URL('../src/agent/focusMonWorker.js', import.meta.url), 'utf8');
  const csrc = fs.readFileSync(new URL('../src/central/focusMonEdge.js', import.meta.url), 'utf8');
  assert.equal(Number(/TEST_RESULTS_PER_SYNC = (\d+)/.exec(wsrc)?.[1]), Number(/arr\(b\.tests, (\d+)\)/.exec(csrc)?.[1]));
  assert.match(wsrc, /testsInFlight\.size >= EDGE_TEST_CONCURRENCY/);
  // 2) 등록부에서 빠진 엣지(from)의 서버도 옮긴다 — 받는 쪽만 검사
  reset();
  registry.addTarget({ name: 'gone-1', host: '10.61.0.1', port: 22, username: 'u', agent: 'old-edge' }, { agents: ['old-edge'] });
  const mv = registry.moveTargets({ from: 'old-edge', to: '' }, { agents: [] });
  assert.equal(mv.ok, true, JSON.stringify(mv)); assert.equal(mv.moved.length, 1);
  assert.equal(registry.moveTargets({ from: '', to: 'old-edge' }, { agents: [] }).code, 'bad-agent', '받는 쪽은 등록된 이름만');
  // 4) 머리글 별칭 · 못 찾은 선택 열 · 읽지 않은 열
  const p = registry.planCsv('Server Name,IP Address,SSH Port,계정,담당 엣지,비고\na1,10.62.0.1,2222,u,EDGE-PL,메모', { agents: AG });
  assert.equal(p.rows[0].value.port, 2222); assert.equal(p.rows[0].value.agent, 'edge-pl');
  assert.deepEqual(p.ignored, ['비고']); assert.deepEqual(p.missing, []);
  const q = registry.planCsv('이름,IP,계정\na2,10.62.0.2,u', { agents: AG });
  assert.deepEqual(q.missing, ['port', 'agent'], '머리글에 없는 선택 열은 알린다(조용한 기본값 금지)');
  // 6) 중앙 몫 — 문턱은 시작할 때 잡고, 시한이 지나면 새 대상을 시작하지 않는다
  bulk._resetBulkForTest();
  const taken = []; const tested = [];
  const r = bulk.startBulk({
    targets: [{ id: 'z1', agent: '' }, { id: 'z2', agent: '' }], by: 't', now: Date.now() - bulk.BULK_CENTRAL_MAX_MS - 1_000,
    peek: () => true, gate: (id) => { taken.push(id); return true; }, release: () => {}, testLocal: async (t) => { tested.push(t.id); return { ok: true }; },
    putResult: () => {}, queueEdge: () => {}, wake: () => {}, testOf: () => null,
  });
  assert.equal(r.ok, true); assert.deepEqual(taken, [], '접수할 때는 문턱을 잡지 않는다');
  for (let i = 0; i < 20 && bulk.bulkJob().centralRunning; i++) await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(tested, [], '시한이 지나 시작하지 않았다');
  const pr = bulk.bulkProgress(bulk.bulkJob(), () => null, Date.now());
  assert.equal(pr.skipped, 2); assert.equal(pr.finished, true);
  bulk._resetBulkForTest();
});
