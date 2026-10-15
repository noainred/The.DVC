/**
 * test/audit2741c.test.js — v2.741 점검 그룹 GC(아이실론 디렉터리 사용량) 회귀.
 *
 *  · EDGE-01  isidu-data: 시계가 앞선 엣지 스캔의 재전송은 **원본 시각**으로 중복을 거른다 · 한 POST 의 잘린 스캔 둘이 서로를 지우지 않는다 ·
 *             잘라서 받은 것은 '거절(rejected)' 이 아니다 — 실제 centralRouter 로 부른다.
 *  · RECENT-03 보고서·개요 기억의 TTL 은 마지막 사용 기준이다(보고 있는 화면이 생성 10분 뒤 콜드 재계산하지 않는다).
 *  · DEV-05   오래 돈 실패(du 가 시한에 걸린 것)는 1시간 뒤가 아니라 주기만큼 쉰다 — 실제 폴러 틱(DB 에서 마지막 시도를 읽는다)으로 본다.
 *  · TIMING-02 '지금 수집' 도 ISIDU_CONCURRENCY(기본 2)를 지킨다 — 실제 runNow 와 접속을 세는 TCP 서버로 본다.
 *  · DEV-01   실패 종류 판정은 시한·출력 상한·이름 해석 실패를 인증 문구보다 먼저 본다(경로·호스트 이름 속 '-401'/'-403' 이 인증 정지를 만들지 않게).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741c-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2741c';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.ISIDU_SSH_KEY = '';
delete process.env.ISIDU_CONCURRENCY; // 기본 2

const GIB = 1024 ** 3;
const ROOT = '/ifs/data/workspace/users';
const MIN = 60_000;
const HOUR = 3_600_000;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/isidu/settings.js');
const db = await import('../src/isidu/db.js');
const R = await import('../src/isidu/report.js');
const P = await import('../src/isidu/poller.js');
const C = await import('../src/isidu/collect.js');
const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');
const reg = await import('../src/storage/registry.js');

let centralPort = 0;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  centralPort = srv.address().port;
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const dev = reg.saveDevice({ type: 'isilon', name: 'ISI-E', host: '10.20.30.41', username: 'root', password: 'pw', agent: 'edge-a', datacenterId: '' });
  const local = (id, extra = {}) => ({ id, label: id, host: '127.0.0.1', port: 1, path: ROOT, auth: 'key', username: 'admin', intervalHours: 24, ...extra });
  const r = S.saveSettings({
    targets: [
      { id: 'tgt-e', label: '엣지 대상', deviceId: dev.id, path: ROOT, auth: 'key', username: 'admin' },
      local('tgt-long'), local('tgt-short'),
      ...['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id) => local(id, { enabled: false })),
    ],
  }, { devices: reg.listDevices(), agents: ['edge-a'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
});

const cpost = (url, body, agent = 'edge-a') => fetch(`http://127.0.0.1:${centralPort}/api/central${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2741c', 'X-Agent-Name': agent }, body: JSON.stringify(body),
});
const edgeScan = (id, ts, bytes = 3 * GIB) => ({ id, targetId: 'tgt-e', ts, ok: true, path: ROOT, sizeMode: 'h', total: { bytes, res: GIB }, entries: [['u1', bytes, GIB]] });
const rowsOf = async (targetId) => (await db.scansIn('', targetId, 0, 1000)) || [];

/* ═══════════════════════════ EDGE-01 ═══════════════════════════ */

test('EDGE-01 시계가 앞선 엣지 스캔을 다시 받으면 중복이다(새 행을 만들지 않는다) · 잘라서 받은 것은 거절이 아니다', async () => {
  const fut = Date.now() + 3 * HOUR;
  const r1 = await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', scans: [edgeScan(101, fut)] });
  const b1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(b1));
  assert.equal(b1.saved.inserted, 1);
  assert.equal(b1.rejected, undefined, `잘라서 받은 것은 거절이 아니다: ${JSON.stringify(b1)}`);
  assert.equal(b1.clamped, 1, '시각을 잘랐다는 사실은 따로 밝힌다');
  assert.ok(!b1.dropped || b1.dropped.futureClamped == null, 'dropped(뺀 개수)에 넣지 않는다');
  await new Promise((r) => setTimeout(r, 15)); // 다음 수신의 '지금' 이 달라지게
  // 엣지 재전송(503·커서 저장 실패·DB 재생성) — 같은 스캔을 다시 보낸다
  const r2 = await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', scans: [edgeScan(101, fut)] });
  const b2 = await r2.json();
  assert.equal(r2.status, 200, JSON.stringify(b2));
  assert.equal(b2.saved.duplicates, 1, `재전송은 중복이다: ${JSON.stringify(b2)}`);
  assert.equal(b2.saved.inserted, 0);
  const rows = await rowsOf('tgt-e');
  assert.equal(rows.length, 1, `같은 스캔은 한 행이다(실제 ${rows.length}행)`);
  assert.ok(rows[0].ts <= Date.now(), '표시·기준선은 잘라 둔 시각이다');
});

test('EDGE-01 한 POST 의 서로 다른 미래 스캔 둘은 둘 다 적재되고, 원본이 더 새 것이 최신이다', async () => {
  const fut = Date.now() + 5 * HOUR;
  const body = { agent: 'edge-a', scans: [edgeScan(201, fut, 4 * GIB), edgeScan(202, fut + MIN, 5 * GIB)] };
  const r = await cpost('/isidu-data?agent=edge-a', body);
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.saved.inserted, 2, `둘째 스캔이 '중복' 으로 사라지면 안 된다: ${JSON.stringify(b)}`);
  assert.equal(b.clamped, 2);
  const rows = await rowsOf('tgt-e');
  assert.equal(rows.length, 3);
  const lat = await db.latestOf('', 'tgt-e');
  assert.equal(lat.okScan.edgeScanId, 202, '원본 시각이 더 새 스캔이 최신이다(잘라 둔 시각이 순서를 뒤집지 않는다)');
  assert.equal(lat.okScan.total.bytes, 5 * GIB);
  await new Promise((rr) => setTimeout(rr, 15));
  const again = await (await cpost('/isidu-data?agent=edge-a', body)).json();
  assert.equal(again.saved.duplicates, 2, `둘 다 재전송 중복이다: ${JSON.stringify(again)}`);
  assert.equal((await rowsOf('tgt-e')).length, 3);
});

test('EDGE-01 시계가 정상인 재전송 · 원본 시각 기록이 없는 옛 행도 중복으로 거른다', async () => {
  const ts = Date.now() - 2 * HOUR;
  // 옛 행(2.741 이전 — edge_ts 없음)
  const old = await db.insertScan({ agent: '', targetId: 'tgt-e', ts, ok: true, path: ROOT, sizeMode: 'h', total: { bytes: GIB, res: 1 }, entries: [{ name: 'u1', bytes: GIB, res: 1 }], node: 'edge-a' });
  assert.equal(old.ok, true);
  const n0 = (await rowsOf('tgt-e')).length;
  const b = await (await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', scans: [edgeScan(301, ts, GIB)] })).json();
  assert.equal(b.saved.duplicates, 1, JSON.stringify(b));
  assert.equal((await rowsOf('tgt-e')).length, n0);
});

/* ═══════════════════════════ RECENT-03 ═══════════════════════════ */

test('RECENT-03 보고서·개요 기억은 쓰는 동안 유지된다(TTL = 마지막 사용 기준)', async () => {
  const now = Date.now();
  const mk = (ts, gib) => db.insertScan({ agent: '', targetId: 'tgt-r', ts, ok: true, path: ROOT, sizeMode: 'h', total: { bytes: gib * GIB, res: GIB }, entries: [{ name: 'a', bytes: gib * GIB, res: GIB }, { name: 'b', bytes: GIB, res: GIB }] });
  await mk(now - 8 * 86_400_000, 10);
  await mk(now - HOUR, 12);
  R._resetForTest();
  const realNow = Date.now;
  try {
    const a = (await R.allRows('tgt-r')).rows;
    const ov1 = (await R.buildOverview(['tgt-r']))[0];
    assert.equal(ov1.state, 'ok');
    Date.now = () => realNow() + R.CACHE_TTL_MS - MIN;          // 9분 뒤 — 적중
    assert.equal((await R.allRows('tgt-r')).rows, a, '9분 뒤는 기억 적중');
    assert.equal((await R.buildOverview(['tgt-r']))[0], ov1);
    Date.now = () => realNow() + 2 * R.CACHE_TTL_MS - 2 * MIN;  // 생성 18분 뒤 · 마지막 사용 9분 뒤
    assert.equal((await R.allRows('tgt-r')).rows, a, '마지막 사용 10분 안이면 다시 계산하지 않는다(생성 시각 기준이면 여기서 콜드 재계산)');
    assert.equal((await R.buildOverview(['tgt-r']))[0], ov1, '개요 기억도 같은 규칙');
    Date.now = () => realNow() + 4 * R.CACHE_TTL_MS;            // 그 뒤로 쓰지 않으면 버린다
    await R.listUsers('none-target', { spark: false });
    assert.equal(R._cacheSizes().report, 0, '쓰지 않은 기억은 여전히 시간이 지나면 버린다');
  } finally { Date.now = realNow; }
});

/* ═══════════════════════════ DEV-05 ═══════════════════════════ */

test('DEV-05 isDue — 오래 돈 실패는 주기만큼 쉬고, 빨리 끝난 실패는 1시간 뒤 · 소요를 모르면 예전 규칙', () => {
  const t = { id: 'x', intervalHours: 24 };
  const now = Date.now();
  const longFail = { ts: now - 2 * HOUR, ok: false, durationMs: 2 * HOUR };
  assert.equal(P.isDue(t, longFail, now), false, '2시간 du 가 시한에 걸렸으면 1시간 뒤 다시 돌리지 않는다');
  assert.equal(P.isDue(t, longFail, now - 2 * HOUR + 24 * HOUR), true, '주기가 지나면 다시 돈다');
  assert.equal(P.isDue(t, { ts: now - 2 * HOUR, ok: false, durationMs: 3_000 }, now), true, '빨리 끝난 실패(연결 거부)는 1시간 뒤');
  assert.equal(P.isDue(t, { ts: now - 2 * HOUR, ok: false }, now), true, '소요를 모르면 예전 규칙');
  assert.equal(P.isDue(t, { ts: now - 2 * HOUR, ok: false, durationMs: P.LONG_FAIL_MS - 1 }, now), true);
  assert.equal(P.isDue({ ...t, intervalHours: 1 }, longFail, now), true, '주기가 1시간이면 그대로 1시간');
});

test('DEV-05 실제 틱 — DB 에서 읽은 마지막 시도가 오래 돈 실패면 시작하지 않는다(빨리 끝난 실패는 시작한다)', async () => {
  const now = Date.now();
  await db.insertScan({ agent: '', targetId: 'tgt-long', ts: now - 90 * MIN, ok: false, kind: 'timeout', error: 'du 시한 초과(120분) — 장비의 du 작업을 멈췄습니다', durationMs: 2 * HOUR });
  await db.insertScan({ agent: '', targetId: 'tgt-short', ts: now - 90 * MIN, ok: false, kind: 'unreachable', error: 'connect ECONNREFUSED', durationMs: 2_000 });
  await P.waitIdle();
  P._resetForTest();
  await P._tickForTest();
  await P.waitIdle();
  const lng = await db.latestOf('', 'tgt-long');
  const sht = await db.latestOf('', 'tgt-short');
  assert.equal(lng.lastTry.ts, now - 90 * MIN, `오래 돈 실패 대상은 다시 시작하지 않았다(마지막 시도 ${new Date(lng.lastTry.ts).toISOString()})`);
  assert.ok(sht.lastTry.ts > now - 90 * MIN, '빨리 끝난 실패 대상은 1시간이 지나 다시 시도했다');
});

/* ═══════════════════════════ TIMING-02 ═══════════════════════════ */

test("TIMING-02 '지금 수집' 은 동시 실행 상한(2)까지만 시작하고 나머지는 대기열에서 차례로 시작한다", async () => {
  // 접속을 받아 잠시 붙잡았다가 끊는 TCP 서버 — 동시에 몇 개가 붙는지 센다(장비 접속은 이것이 전부다).
  let active = 0; let maxActive = 0; let total = 0;
  const srv = net.createServer((sock) => {
    active++; total++; maxActive = Math.max(maxActive, active);
    sock.on('error', () => {});
    sock.on('close', () => { active--; });
    setTimeout(() => sock.destroy(), 150);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const port = srv.address().port;
  const cur = S.loadSettings();
  const r = S.saveSettings({ targets: cur.targets.map((t) => (/^q\d$/.test(t.id) ? { ...t, port } : t)) },
    { devices: reg.listDevices(), agents: ['edge-a'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
  await P.waitIdle();
  P._resetForTest();
  const ids = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const res = await P.runNow(ids, { trigger: 'manual' });
  assert.equal(res.started.length, 2, `동시 실행 상한까지만 바로 시작한다: ${JSON.stringify(res)}`);
  assert.deepEqual([...res.queued].sort(), ids.filter((id) => !res.started.includes(id)).sort(), '나머지는 대기열(조용히 빼지 않는다)');
  assert.equal(res.concurrency, 2);
  const st = P.isiduPollerStatus();
  assert.ok(st.running.length <= 2, `진행 중 ${st.running.length}`);
  assert.equal(st.queued.length, 4, '상태가 대기열을 말한다');
  const again = await P.runNow(['q6'], { trigger: 'manual' });
  assert.deepEqual(again.queued, ['q6'], '대기 중인 대상을 다시 눌러도 두 번 넣지 않는다');
  assert.equal(again.started.length, 0);
  await P.waitIdle();
  assert.equal(total, 6, `여섯 대상 모두 차례로 접속했다(실제 ${total})`);
  assert.ok(maxActive <= 2, `장비에 동시에 붙은 접속은 상한(2) 이하(실제 최대 ${maxActive})`);
  assert.equal(P.isiduPollerStatus().queued.length, 0);
  for (const id of ids) assert.ok((await db.latestOf('', id)).lastTry, `${id} 시도 기록`);
});

/* ═══════════════════════════ DEV-01(isidu) ═══════════════════════════ */

test('DEV-01 실패 종류 — 시한·출력 상한·이름 해석 실패를 인증 문구보다 먼저 본다 · 진짜 인증 거부는 그대로 auth', () => {
  const k = C.classifyCollectError;
  assert.equal(k(new Error("SSH exec 타임아웃(7200s): du -A -h -d 1 '/ifs/data/proj-403'")), 'timeout', '경로 속 -403 은 인증이 아니다');
  assert.equal(k(new Error("SSH exec 타임아웃(30s): ls -d '/ifs/data/HTTP 401 logs'")), 'timeout', '경로 이름에 인증 문맥 낱말이 있어도 시한이다');
  assert.equal(k(new Error("SSH exec 출력 상한(4096KB) 초과: du -A -h -d 1 '/ifs/data/x-401'")), 'output-cap');
  assert.equal(k(new Error('getaddrinfo ENOTFOUND isilon-401.corp')), 'unreachable', '호스트 이름 속 -401 은 인증이 아니다(로그인 시도가 장비에 닿지 않았다)');
  assert.equal(k(new Error('connect ECONNREFUSED 10.0.0.1:22')), 'unreachable');
  const authErr = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  assert.equal(k(authErr), 'auth', '구조 표지(err.level)가 있는 인증 거부는 auth');
  // 시한 낱말이 함께 있어도 구조 표지가 먼저다(인증 거부를 시한으로 바꿔 주기 수집을 계속 돌리면 계정이 잠긴다)
  assert.equal(k(Object.assign(new Error('authentication timeout'), { level: 'client-authentication' })), 'auth');
  assert.equal(k(new Error('All configured authentication methods failed')), 'auth', '문구만 있는 ssh2 인증 거부도 auth');
  assert.equal(k(new Error('SSH 인증 실패: 계정·비밀번호를 확인하세요')), 'auth');
});

test('DEV-01 실제 연결 시험 — 이름에 -401 이 든 호스트의 DNS 실패는 unreachable(인증 실패가 아니다)', async () => {
  const r = await C.testTargetPath({ id: 'tgt-dns', host: 'isilon-401.invalid', port: 22, path: ROOT, auth: 'key', username: 'admin', sizeMode: 'h' });
  assert.equal(r.ok, false);
  assert.notEqual(r.kind, 'auth', `DNS 실패를 인증 실패로 읽지 않는다: ${r.kind} — ${r.reason}`);
});
