// v2.620 그룹 D — 큰 본문 게이트(util/bigJsonGate.js)·재시도 대기(util/resilientFetch.js) 회귀.
//   RECENT2620-02 이름 없는 엣지 push 가 출발 IP 한 칸을 공유 · 03(SEC2620-06) 저권한 세션의 세션 풀 점유 ·
//   04 게이트 503 이 거부 기록에 안 남음 · 05 Retry-After 대기가 호출자 abort 를 무시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

test('RECENT2620-02: 같은 출발 IP 의 서로 다른 엣지 5곳은 이름 헤더가 있으면 각자 칸을 쓴다 · 이름이 없어도 IP 한 칸으로 묶지 않는다', async () => {
  const { bigJsonGate } = await import('../src/util/bigJsonGate.js');
  const app = express();
  const gate = bigJsonGate(express.json({ limit: '16mb' }), {
    central: (req) => ({ ok: true, agent: String(req.get('X-Agent-Name') || req.query?.agent || '').slice(0, 64) }),
  }, { maxConcurrent: 6, perWho: 2 });
  app.use('/api/central/inventory', gate);
  app.post('/api/central/inventory', async (_req, res) => { await new Promise((r) => setTimeout(r, 400)); res.json({ ok: true }); });
  const srv = await listen(app);
  const url = `http://127.0.0.1:${srv.address().port}/api/central/inventory`;
  const post = (headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"vms":[]}' }).then((r) => r.status);
  try {
    // ① 이름 헤더(v2.620 push) — 5곳 전부 200
    const named = await Promise.all(['e1', 'e2', 'e3', 'e4', 'e5'].map((n) => post({ 'X-Agent-Name': n })));
    assert.deepEqual(named, [200, 200, 200, 200, 200]);
    // ② 이름 없는 구버전 엣지 5곳(같은 IP) — 예전엔 200,200,503,503,503. 이제 풀 상한(6)만 적용된다
    const anon = await Promise.all([1, 2, 3, 4, 5].map(() => post({})));
    assert.deepEqual(anon, [200, 200, 200, 200, 200], `이름 없는 요청을 IP 한 칸으로 묶었다: ${anon}`);
    // ③ 요청자별 상한은 이름이 같을 때 그대로 — 같은 엣지 3건이면 세 번째는 503
    const same = await Promise.all([1, 2, 3].map(() => post({ 'X-Agent-Name': 'dup' })));
    assert.equal(same.filter((s) => s === 503).length, 1, `요청자 상한이 사라졌다: ${same}`);
    // ④ 이름이 없고 X-Agent-Hostname 이 같으면 그 호스트 한 칸(요청자 상한 유지)
    const host = await Promise.all([1, 2, 3].map(() => post({ 'X-Agent-Hostname': 'edge-host-1' })));
    assert.equal(host.filter((s) => s === 503).length, 1, `호스트명 칸이 동작하지 않는다: ${host}`);
  } finally { srv.close(); }
});

test('RECENT2620-02: 큰 본문 push 들이 X-Agent-Name 헤더를 싣는다 · 헤더로 쓸 수 없는 이름은 싣지 않는다', async () => {
  const { agentNameHeader } = await import('../src/util/agentNameHeader.js');
  assert.deepEqual(agentNameHeader('edge-seoul-01'), { 'X-Agent-Name': 'edge-seoul-01' });
  assert.deepEqual(agentNameHeader('서울엣지'), {}, '한글은 ByteString 이 아니라 fetch 가 던진다 — 싣지 않는다');
  assert.deepEqual(agentNameHeader(' edge '), {}, '앞뒤 공백 — 본문과 다른 값이 될 수 있다');
  assert.deepEqual(agentNameHeader('x'.repeat(65)), {});
  assert.deepEqual(agentNameHeader(''), {});
  assert.deepEqual(agentNameHeader(undefined), {});
  assert.deepEqual(agentNameHeader('a\r\nX-Evil: 1'), {});
  for (const f of ['agent/inventoryPush.js', 'agent/guestDiskPush.js', 'agent/fleetPush.js', 'agent/gpuGuestPush.js', 'storage/push.js', 'pdu/push.js',
    'agent/edgeLogWorker.js', 'agent/logQueryWorker.js', 'agent/ipScanWorker.js', 'agent/idracScanWorker.js']) {
    assert.match(stripComments(read(f)), /\.\.\.agentNameHeader\(config\.agent\.name\)/, `${f} 가 이름 헤더를 싣지 않는다`);
  }
  // storage/push.js 는 상태 전용 push 까지 두 곳
  assert.equal((stripComments(read('storage/push.js')).match(/agentNameHeader\(config\.agent\.name\)/g) || []).length, 2);
});

test('RECENT2620-03(SEC2620-06): 세션 풀은 그 라우트를 통과할 사용자만 잡는다(순수 판정)', async () => {
  const { sessionBigBodyAllowed } = await import('../src/util/bigJsonGate.js');
  const perms = { operator: new Set(['svcmon', 'tools']), viewer: new Set(['svcmon']) };
  const deps = { permsOf: (r) => perms[r] || new Set(), scoped: (u) => !!u.scoped };
  const LA = '/api/admin/log-analysis/paste', SV = '/api/svcmon/targets/import';
  assert.equal(sessionBigBodyAllowed({ role: 'admin' }, LA, deps), true);
  assert.equal(sessionBigBodyAllowed({ role: 'admin', scoped: true }, LA, deps), false, '범위 관리자는 fullScopeOnly 로 403');
  assert.equal(sessionBigBodyAllowed({ role: 'operator' }, LA, deps), false);
  assert.equal(sessionBigBodyAllowed({ role: 'viewer' }, LA, deps), false);
  assert.equal(sessionBigBodyAllowed({ role: 'admin' }, SV, deps), true);
  assert.equal(sessionBigBodyAllowed({ role: 'operator' }, SV, deps), true);
  assert.equal(sessionBigBodyAllowed({ role: 'viewer' }, SV, deps), false, 'viewer 는 canEdit 에서 403 — svcmon 권한이 있어도');
  assert.equal(sessionBigBodyAllowed({ role: 'operator' }, SV, { ...deps, permsOf: () => new Set() }), false, 'svcmon 권한 없음');
  assert.equal(sessionBigBodyAllowed({ role: 'admin', mustEnrollOtp: true }, LA, deps), false);
  assert.equal(sessionBigBodyAllowed({ role: 'admin' }, '/api/other', deps), false);
  assert.equal(sessionBigBodyAllowed({ role: 'admin' }, LA, { scoped: () => { throw new Error('x'); } }), false, '판정 실패는 파싱 안 함');
  assert.equal(sessionBigBodyAllowed(null, LA, deps), false);
  // 라우트 게이트와 대조 — 표를 바꾸지 않고 라우트만 바꾸면 여기서 드러난다
  assert.match(stripComments(read('routes/admin/logAnalysis.js')), /adminRouter\.post\('\/log-analysis\/paste', adminOnly, fullScopeOnly,/);
  assert.match(stripComments(read('routes/svcmon/transfer.js')), /svcmonRouter\.post\('\/targets\/import', canEdit, fullScopeOnly,/);
  assert.match(stripComments(read('routes/svcmon/shared.js')), /export const canEdit = requireRole\('admin', 'operator'\);/);
  const idx = stripComments(read('index.js'));
  assert.match(idx, /sessionAllowed: \(_req, u, full\) => sessionBigBodyAllowed\(u, full, \{ permsOf: rolePermissionSet, scoped: /);
  assert.match(idx, /app\.use\('\/api\/svcmon', authMiddleware, requireEnrolled, requirePerm\('svcmon'\), svcmonRouter\)/);
});

test('RECENT2620-03: viewer 두 명이 느린 본문을 흘려도 관리자의 로그 분석 붙여넣기는 들어간다(실제 HTTP)', async () => {
  const { bigJsonGate, sessionBigBodyAllowed } = await import('../src/util/bigJsonGate.js');
  const users = { tv1: { username: 'viewer1', role: 'viewer' }, tv2: { username: 'viewer2', role: 'viewer' }, tadm: { username: 'admin', role: 'admin' } };
  const app = express();
  const gate = bigJsonGate(express.json({ limit: '16mb' }), {
    session: (req) => users[(req.get('Authorization') || '').replace(/^Bearer\s+/i, '')] || false,
    sessionAllowed: (_req, u, full) => sessionBigBodyAllowed(u, full, { permsOf: () => new Set(['svcmon']), scoped: () => false }),
  });
  app.use('/api/svcmon/targets/import', gate); app.use('/api/admin/log-analysis/paste', gate);
  app.post('/api/svcmon/targets/import', (_req, res) => res.status(403).json({ error: 'forbidden' }));
  app.post('/api/admin/log-analysis/paste', (_req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  const port = srv.address().port;
  const slow = (tok) => { const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/svcmon/targets/import', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'content-length': 1_000_000 } }); r.on('error', () => {}); r.write('{"a":"'); return r; };
  const a = slow('tv1'); const b = slow('tv2');
  try {
    await new Promise((r) => setTimeout(r, 300));
    const st = await fetch(`http://127.0.0.1:${port}/api/admin/log-analysis/paste`, { method: 'POST', headers: { Authorization: 'Bearer tadm', 'content-type': 'application/json' }, body: '{"text":"x"}' }).then((r) => r.status);
    assert.equal(st, 200, `viewer 가 세션 풀을 점유했다(${st})`);
  } finally { a.destroy(); b.destroy(); srv.close(); }
});

test('RECENT2620-03: 세션 계열 본문 읽기 시한은 기본 120초이고 엣지 계열 시한을 넘지 않는다', () => {
  const src = stripComments(read('util/bigJsonGate.js'));
  assert.match(src, /const sessionReadDeadlineMs = Math\.min\(readDeadlineMs, num\(opts\.sessionReadDeadlineMs \?\? process\.env\.BIG_JSON_SESSION_READ_DEADLINE_MS, 120_000\)\);/);
  assert.match(src, /\}, deadlineOf\(cls\)\);/);
});

test('RECENT2620-03: 세션 계열 느린 본문은 짧은 시한에 끊기고 엣지 계열은 그대로 기다린다(동작)', async () => {
  const { bigJsonGate, bigJsonStats } = await import('../src/util/bigJsonGate.js');
  const { EventEmitter } = await import('node:events');
  const gate = bigJsonGate((_q, _s, next) => next(), {
    central: (r) => ({ ok: true, agent: r.who }), session: (r) => ({ username: r.who }),
  }, { readDeadlineMs: 5000, sessionReadDeadlineMs: 100 });
  const mkReq = (base, who) => { const q = new EventEmitter(); Object.assign(q, { baseUrl: base, path: '/', who, complete: false, get: (h) => (h === 'content-length' ? '10' : '') }); q.destroy = () => { q.destroyed = true; }; return q; };
  const mkRes = () => { const r = new EventEmitter(); r.set = () => r; r.status = () => r; r.json = () => r; return r; };
  const cut0 = bigJsonStats('session').deadlineCut;
  const qs = mkReq('/api/admin/log-analysis/paste', 'd-admin'); const rs = mkRes(); gate(qs, rs, () => {});
  const qc = mkReq('/api/central/inventory', 'd-edge'); const rc = mkRes(); gate(qc, rc, () => {});
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(qs.destroyed, true, '세션 계열 느린 본문이 짧은 시한에 끊기지 않았다');
  assert.notEqual(qc.destroyed, true, '엣지 계열까지 짧은 시한을 썼다');
  assert.ok(bigJsonStats('session').deadlineCut > cut0);
  rc.emit('close'); rs.emit('close');
});

test('RECENT2620-04: 게이트 503 은 onReject 로 엣지별 거부 기록(busy)에 남는다 · index.js 는 엣지 계열만 기록한다', async () => {
  const { bigJsonGate } = await import('../src/util/bigJsonGate.js');
  const { recordReject, rejectStats, resetRejects, REJECT_KIND } = await import('../src/central/ingestReject.js');
  const { EventEmitter } = await import('node:events');
  assert.equal(REJECT_KIND.BUSY, 'busy');
  resetRejects?.();
  const calls = [];
  const gate = bigJsonGate((_q, _s, next) => next(), {
    central: (r) => ({ ok: true, agent: r.who }),
    session: (r) => ({ username: r.who }),
  }, {
    maxConcurrent: 1, perWho: 1, sessionMaxConcurrent: 1,
    onReject: (req, info) => { calls.push(info); if (info.cls === 'central') recordReject(info.who || '(unknown)', '/inventory', { status: info.status, kind: REJECT_KIND.BUSY, reason: info.reason, wireBytes: info.len }); },
  });
  const mkReq = (base, who) => { const q = new EventEmitter(); Object.assign(q, { baseUrl: base, path: '/', who, complete: false, get: (h) => (h === 'content-length' ? '2048' : '') }); q.destroy = () => {}; return q; };
  const mkRes = () => { const r = new EventEmitter(); r.set = () => r; r.status = (c) => { r.code = c; return r; }; r.json = () => r; return r; };
  const r1 = mkRes(); gate(mkReq('/api/central/inventory', 'edgeX'), r1, () => {});
  const r2 = mkRes(); gate(mkReq('/api/central/inventory', 'edgeY'), r2, () => {});
  assert.equal(r2.code, 503);
  const s1 = mkRes(); gate(mkReq('/api/svcmon/targets/import', 'admin'), s1, () => {});
  const s2 = mkRes(); gate(mkReq('/api/svcmon/targets/import', 'admin2'), s2, () => {});
  assert.equal(s2.code, 503);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cls, 'central'); assert.equal(calls[0].who, 'edgeY'); assert.equal(calls[0].status, 503); assert.equal(calls[0].len, 2048);
  const row = rejectStats().rows.find((x) => x.agent === 'edgeY');
  assert.ok(row, '거부 기록에 엣지가 없다');
  assert.equal(row.lastKind, 'busy');
  assert.equal(rejectStats().unverified, true);
  for (const r of [r1, s1]) r.emit('close');
  // index.js 연결 — 엣지 계열만 기록하고 종류는 BUSY
  const idx = stripComments(read('index.js'));
  assert.match(idx, /onReject: \(req, \{ cls, who, status, len, reason \}\) => \{\s*if \(cls !== 'central'\) return;\s*recordReject\(who \|\| '\(unknown\)'/);
  assert.match(idx, /kind: REJECT_KIND\.BUSY/);
  resetRejects?.();
});

test('RECENT2620-05: Retry-After 대기 중 호출자가 끊으면 즉시 끝나고 재시도하지 않는다', async () => {
  const { resilientFetch, abortableSleep } = await import('../src/util/resilientFetch.js');
  let hits = 0;
  const srv = http.createServer((_q, s) => { hits++; s.writeHead(503, { 'Retry-After': '120' }); s.end('busy'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    await assert.rejects(resilientFetch(`http://127.0.0.1:${srv.address().port}/api/x`, { signal: ac.signal, timeoutMs: 2000, retries: 2 }));
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `호출자 abort 뒤에도 ${ms}ms 대기했다`);
    assert.equal(hits, 1, `abort 뒤에 재시도했다(${hits}회)`);
    // 대기 함수 자체
    const ac2 = new AbortController(); const t1 = Date.now(); setTimeout(() => ac2.abort(), 50);
    await assert.rejects(abortableSleep(10_000, ac2.signal));
    assert.ok(Date.now() - t1 < 2000);
    const ac3 = new AbortController(); ac3.abort();
    await assert.rejects(abortableSleep(10_000, ac3.signal));
    await abortableSleep(5); // signal 없음 → 그냥 잔다
  } finally { srv.close(); }
});

test('RECENT2620-05: 진행 중 요청도 호출자 abort 로 끊긴다(건별 시한과 합친다)', async () => {
  const { resilientFetch } = await import('../src/util/resilientFetch.js');
  let hits = 0;
  const socks = new Set();
  const srv = http.createServer((_q, _s) => { hits++; /* 응답하지 않는다 */ });
  srv.on('connection', (c) => { socks.add(c); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    let retried = 0;
    await assert.rejects(resilientFetch(`http://127.0.0.1:${srv.address().port}/api/y`, { signal: ac.signal, timeoutMs: 5000, retries: 2, onRetry: () => { retried++; } }));
    assert.equal(retried, 0, '호출자 취소를 일시 오류로 보고 재시도를 알렸다');
    assert.ok(Date.now() - t0 < 2500, `진행 중 요청이 호출자 abort 로 끊기지 않았다(${Date.now() - t0}ms)`);
    assert.equal(hits, 1, `abort 를 일시 오류로 보고 재시도했다(${hits}회)`);
  } finally { for (const c of socks) c.destroy(); srv.close(); }
});
