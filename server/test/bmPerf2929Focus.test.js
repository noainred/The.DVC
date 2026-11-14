/**
 * v2.929(리눅스 성능 5단계) — 집중 모니터링(10분 × 1분 · 설계 PROFILES §13). 고정하는 규약(security-api.md · idrac-server.md v2.929):
 *   ① 사유 필수(수동) · 서버당 동시 1세션(409) · 경로 없음 409 ② 법인당 동시 상한 → 대기열(순번) · 끝나면 다음 세션 시작 · 동시 요청도 예약으로 막는다
 *   ③ 인증 거부(SSH · Redfish)는 즉시 중단 + 주기 수집과 같은 가드 · 같은 식별자에 기록(계정 잠금 방지) · 자동 집중은 정지된 계정이면 시작 안 함
 *   ④ 결측은 비운다(0 금지) · OS / iDRAC 따로 센다 ⑤ 30일 정리(청크 · 진행 중 제외) · 재시작 때 남은 세션은 interrupted
 *   ⑥ 실제 api 라우터: viewer 403 · 범위 밖 404 · 조회 무제한+쓰기 제한 403 · 사유 400 · 감사 bm-perf.focus · 실행자는 관리자만 · 엣지 collector 대행 · 중앙 정제
 *   ⑦ 전역 동시성 풀(슬롯) — 집중은 앞자리 · 대기 상한이면 그 분은 결측 pool-busy.
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2929fo-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
process.env.COLLECTOR_TOKEN = 'tok-2929-test';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 구버전 엣지 흉내(127.0.0.1) 등록용
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const F = await import('../src/bmusage/focus/run.js');
const SLOTS = await import('../src/bmusage/slots.js');

/** 수동으로 굴리는 타이머 · 시계 · 가짜 수집기. */
function harness({ rules = { focus: { intervalS: 60, durationMin: 3, corpMax: 2 } }, osSeq = [], idracSeq = [], osStop = null, idracStop = null } = {}) {
  const timers = []; let clock = NOW; const calls = { os: 0, idrac: 0, osAuth: [], idracAuth: [] };
  const H = {
    timers, calls,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    async fireAll() { while (timers.length) { const t = timers.shift(); clock = Math.max(clock, t.at); await t.fn(); await new Promise((r) => setImmediate(r)); } },
    deps: {
      now: () => clock,
      loadRules: async () => rules,
      loadSettings: async () => ({ perf: {}, store: { peakWindowS: 10, deviceMax: 32 } }),
      collectOs: async () => { const r = osSeq[Math.min(calls.os, osSeq.length - 1)] || { ok: true }; calls.os += 1; return typeof r === 'function' ? r() : r; },
      idracJob: async () => { const r = idracSeq[Math.min(calls.idrac, idracSeq.length - 1)] || { ok: true, cpuPct: 40 }; calls.idrac += 1; return r; },
      prevFor: async () => null,
      osAuthStop: async () => osStop, idracAuthStop: async () => idracStop,
      recordOsAuth: async (_t, o) => { calls.osAuth.push(o); }, recordIdracAuth: async (_t, o) => { calls.idracAuth.push(o); },
      buildUsage: async ({ os: o, idrac: i }) => ({ row: o ? { cpu_pct: 70, cpu_pct_peak: 95, disk_await_ms: 18, disk_await_ms_peak: 208, mem_pct: 71 } : { cpu_pct: i?.cpuPct ?? null }, next: { at: clock } }),
      buildEntry: async ({ row }) => ({ verdict: row.disk_await_ms != null ? 'saturated' : 'unknown', perResource: { disk: 'saturated', cpu: 'ok' } }),
      hwReader: async () => () => ({ power: { watts: 418 }, inletC: 24 }),
      rawBefore: async () => ({ rows: [{ cpu_pct: 40 }, { cpu_pct: 50 }, { cpu_pct: null }] }),
      setTimer: (fn, ms) => { const h = { fn, at: clock + Math.max(0, ms) }; timers.push(h); timers.sort((a, b) => a.at - b.at); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    },
  };
  return H;
}
const tgt = (k, vc = 'vcA', extra = {}) => ({ key: k, name: k.toLowerCase(), vcenterId: vc, paths: ['os', 'idrac'], osHost: { host: '127.0.0.1', port: 9, username: 'mon', password: 'pw' }, idrac: { host: 'https://10.0.0.9', regId: `r-${k}`, username: 'root', password: 'x' }, ...extra });
const SNAP_TXT = "##PSCPU\n  4242 postgres  58.0  1024 postgres\n  77 root 3.0 10 pg_dump\n##PIDS\n120\n##IO\nreadable=120\nspan=2\nio 77 400000000 0 pg_dump\nio 4242 1000 2000 postgres\n##SS\nTCP:   12 (estab 8, closed 1, orphaned 0, timewait 1)\n##END\n";

test('① 사유 · 경로 · 서버당 1세션 · 자동 집중은 정지 계정이면 시작 안 함', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness(); F._setFocusDepsForTest(h.deps);
  assert.equal((await F.startFocusLocal({ target: tgt('A1'), reason: ' ', by: 'op' })).code, 'bad-reason');
  assert.equal((await F.startFocusLocal({ target: { key: 'NP', paths: [] }, reason: '경로 없음', by: 'op' })).code, 'no-path');
  const r = await F.startFocusLocal({ target: tgt('A1'), reason: '디스크 포화 확인', by: 'op' });
  assert.equal(r.code, 'ok'); assert.equal(r.status, 'running'); assert.equal(r.count, 3);
  assert.equal((await F.startFocusLocal({ target: tgt('A1'), reason: '두 번째', by: 'op' })).code, 'busy');
  F._resetFocusForTest();
  const h2 = harness({ osStop: { since: NOW, attempts: 2 } }); F._setFocusDepsForTest(h2.deps);
  assert.equal((await F.startFocusLocal({ target: tgt('A9'), trigger: 'auto', reason: 'rule' })).code, 'auth-stopped', '자동은 정지된 계정으로 시작하지 않는다');
  // 반증 F11: 수동도 정지된 계정이면 거부하고 이유를 말한다(누를 때마다 로그인 1회 → 계정 잠금 경로였다)
  const man = await F.startFocusLocal({ target: tgt('A9'), reason: '수동도 거부', by: 'op' });
  assert.equal(man.code, 'auth-stopped'); assert.equal(man.authStopped, 'os'); assert.match(man.reason, /정지/);
  F._resetFocusForTest();
  const h3 = harness({ idracStop: { since: NOW } }); F._setFocusDepsForTest(h3.deps);
  assert.equal((await F.startFocusLocal({ target: tgt('A8', 'vcA', { paths: ['idrac'], osHost: null }), reason: 'iDRAC 만', by: 'op' })).code, 'auth-stopped', 'iDRAC 만 있는 서버는 iDRAC 정지면 거부');
  assert.equal((await F.startFocusLocal({ target: tgt('A7'), reason: 'OS 정상 · iDRAC 정지', by: 'op' })).code, 'ok', 'OS 경로가 정상이면 시작(iDRAC 분은 auth-stopped 결측)');
  F._resetFocusForTest();
});

test('② 법인당 동시 상한 → 대기열(순번) · 끝나면 다음 세션 · 동시 요청도 예약으로 상한을 넘지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness({ rules: { focus: { intervalS: 60, durationMin: 1, corpMax: 2 } }, osSeq: [{ ok: true, extra: { snap: { stdout: SNAP_TXT } } }] });
  F._setFocusDepsForTest(h.deps);
  const rs = await Promise.all(['B1', 'B2', 'B3', 'B4'].map((k) => F.startFocusLocal({ target: tgt(k), reason: '동시 요청', by: 'op' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), ['queued', 'queued', 'running', 'running'], '동시 요청 4 · 상한 2(먼저 닿은 순서)');
  assert.deepEqual(rs.filter((r) => r.status === 'queued').map((r) => r.queuePos).sort(), [1, 2], '대기 순번');
  assert.equal(F.focusActiveCount(), 2); assert.equal(F.focusQueuedCount(), 2);
  const other = await F.startFocusLocal({ target: tgt('C1', 'vcB'), reason: '다른 법인은 따로', by: 'op' });
  assert.equal(other.status, 'running');
  await h.fireAll();   // 1분 × 1회 세션 — 끝나면 대기열이 이어서 돈다
  assert.equal(F.focusActiveCount(), 0); assert.equal(F.focusQueuedCount(), 0);
  const O = await import('../src/bmusage/opsDb.js');
  for (const r of rs) assert.equal((await O.focusGet(r.id)).status, 'done', `${r.id} 끝까지 돌았다`);
  F._resetFocusForTest();
});

test('③ 인증 거부는 즉시 중단 — 다음 분을 예약하지 않고 가드에 기록(OS · iDRAC 각각) · ④ 결측은 비우고 따로 센다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const O = await import('../src/bmusage/opsDb.js');
  // ④ 1분째 OS 시한 초과(결측) · iDRAC 정상 → 2분째 정상 → 3분째 정상
  F._resetFocusForTest();
  const h = harness({ osSeq: [{ ok: false, error: 'OS 수집 시한 초과' }, { ok: true, extra: { snap: { stdout: SNAP_TXT } }, perf: { dmesg: { value: { err: 2 } } } }] });
  F._setFocusDepsForTest(h.deps);
  const r = await F.startFocusLocal({ target: tgt('D1'), reason: '결측 확인', by: 'op' });
  await h.fireAll();
  const g = await F.getFocusLocal({ key: 'D1', id: r.id });
  assert.equal(g.session.status, 'done'); assert.equal(g.session.missOs, 1); assert.equal(g.session.missIdrac, 0, '두 경로는 따로 센다');
  const s0 = g.samples[0];
  assert.equal(s0.missOs, 'timeout'); assert.equal(s0.osOk, false); assert.equal(s0.idracOk, true);
  assert.equal(s0.vals.cpu_pct, undefined, '결측 분의 OS 지표는 비운다(0 으로 채우지 않는다)');
  assert.equal(s0.vals.power_w.avg, 418, 'iDRAC 쪽(전력)은 남는다');
  assert.deepEqual(g.samples[1].vals.disk_await_ms, { avg: 18, peak: 208 }, '평균 · 피크');
  assert.equal(g.samples[1].snap.ioTop[0].name, 'pg_dump', '경량 스냅샷 I/O 1위');
  assert.equal(g.session.summary.candidates[0].name, 'pg_dump', '원인 후보(상관)');
  assert.equal(g.session.summary.missOs, 1);
  // ③ OS 인증 거부 → 즉시 중단(2분째 예약 없음)
  F._resetFocusForTest();
  const h2 = harness({ osSeq: [{ ok: false, error: 'All configured authentication methods failed' }] });
  F._setFocusDepsForTest(h2.deps);
  const r2 = await F.startFocusLocal({ target: tgt('D2'), reason: '인증', by: 'op' });
  await h2.fireAll();
  assert.equal(h2.calls.os, 1, '한 번만 로그인을 시도했다');
  assert.equal((await O.focusGet(r2.id)).status, 'auth');
  assert.equal(h2.calls.osAuth[0].ok, false); assert.match(h2.calls.osAuth[0].errorText, /authentication/);
  // iDRAC 401 → 즉시 중단 + kind auth 기록
  F._resetFocusForTest();
  const h3 = harness({ idracSeq: [{ ok: false, kind: 'auth', error: 'HTTP 401' }], osSeq: [{ ok: true }] });
  F._setFocusDepsForTest(h3.deps);
  const r3 = await F.startFocusLocal({ target: tgt('D3'), reason: 'redfish 인증', by: 'op' });
  await h3.fireAll();
  assert.equal((await O.focusGet(r3.id)).status, 'auth'); assert.equal(h3.calls.idrac, 1);
  assert.deepEqual(h3.calls.idracAuth[0], { ok: false, kind: 'auth', errorText: 'HTTP 401' });
  // iDRAC 경로가 이미 정지(주 폴러 포함)면 Redfish 를 시도하지 않고 그 분은 auth-stopped 결측
  F._resetFocusForTest();
  const h4 = harness({ idracStop: { since: NOW, attempts: 3 }, rules: { focus: { intervalS: 60, durationMin: 1, corpMax: 2 } } });
  F._setFocusDepsForTest(h4.deps);
  const r4 = await F.startFocusLocal({ target: tgt('D4'), reason: '정지 중', by: 'op' });
  await h4.fireAll();
  assert.equal(h4.calls.idrac, 0, 'Redfish 0회');
  assert.equal((await F.getFocusLocal({ key: 'D4', id: r4.id })).samples[0].missIdrac, 'auth-stopped');
  F._resetFocusForTest();
});

test('③ 실제 poller 가드 — 집중의 인증 실패가 주기 수집을 멈추고(같은 식별자) 성공이 푼다', async () => {
  const poller = await import('../src/bmusage/poller.js');
  const tg = tgt('G1');
  poller.recordOsAuthOutcome(tg, { ok: false, errorText: 'Permission denied (publickey,password)' });
  assert.ok(poller.osAuthStopFor(tg), 'OS 정지');
  poller.recordOsAuthOutcome(tg, { ok: true });
  assert.equal(poller.osAuthStopFor(tg), null);
  poller.recordIdracAuthOutcome(tg, { ok: false, kind: 'timeout', errorText: '시한' });
  assert.equal(poller.idracAuthStopFor(tg), null, '시한은 인증 실패가 아니다');
  poller.recordIdracAuthOutcome(tg, { ok: false, kind: 'auth', errorText: 'HTTP 401' });
  assert.ok(poller.idracAuthStopFor(tg), 'iDRAC 정지(주기 수집과 같은 식별자)');
  poller.recordIdracAuthOutcome(tg, { ok: true });
  assert.equal(poller.idracAuthStopFor(tg), null);
});

test('⑤ 보관 정리(진행 중 제외 · 표본까지) · 재시작 때 남은 진행 중 · 대기 세션은 interrupted', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const O = await import('../src/bmusage/opsDb.js');
  const { config } = await import('../src/config.js');
  const AG = config.agent?.name || '';
  const old = NOW - 40 * 86_400_000;
  await O.focusInsert({ id: '00000000-0000-4000-8000-000000000001', agent: AG, key: 'OLD', vcenterId: 'vcA', trigger: 'manual', by: 'op', reason: 'r', created: old, start: old, intervalS: 60, count: 10, status: 'done' });
  await O.focusSampleInsert({ sessionId: '00000000-0000-4000-8000-000000000001', idx: 0, minuteTs: old, osOk: true, vals: { cpu_pct: { avg: 1 } } });
  await O.focusInsert({ id: '00000000-0000-4000-8000-000000000002', agent: AG, key: 'RUN', vcenterId: 'vcA', trigger: 'manual', by: 'op', reason: 'r', created: old, start: old, intervalS: 60, count: 10, status: 'running' });
  const p = await O.focusPrune({ before: NOW - 30 * 86_400_000 });
  assert.equal(p.sessions, 1); assert.equal(p.samples, 1);
  assert.ok(await O.focusGet('00000000-0000-4000-8000-000000000002'), '진행 중은 지우지 않는다');
  F._resetFocusForTest();
  F._setFocusDepsForTest(harness().deps);
  await F.listFocusLocal({ key: 'RUN' });   // 첫 사용 — 재시작 뒤 남은 세션을 닫는다
  assert.equal((await O.focusGet('00000000-0000-4000-8000-000000000002')).status, 'interrupted');
  F._resetFocusForTest();
});

test('세션 요약(순수) — 판정 변화 · 지표 최고값 · 원인 후보(상관 횟수) · 결측 · 조치 code · 앞 1시간 통계는 null 을 세지 않는다', () => {
  const s = F.summarizeFocus([
    { minuteTs: 1, verdict: 'saturated', vals: { disk_await_ms: { avg: 24, peak: 96 }, _res: { disk: 'saturated' } }, snap: { ioTop: [{ name: 'pg_dump' }], cpuTop: [{ name: 'postgres' }] } },
    { minuteTs: 2, verdict: null, missOs: 'timeout', vals: {}, snap: null },
    { minuteTs: 3, verdict: 'ok', vals: { disk_await_ms: { avg: 3, peak: 4 } }, snap: { ioTop: [{ name: 'pg_dump' }], cpuTop: [{ name: 'postgres' }] } },
  ], { hasOs: true, hasIdrac: false });
  assert.equal(s.verdictFrom, 'saturated'); assert.equal(s.verdictTo, 'ok'); assert.equal(s.worst, 'saturated');
  assert.deepEqual(s.maxBy.disk_await_ms, { value: 96, at: 1 });
  assert.equal(s.candidates.length, 2); assert.equal(s.candidates[0].of, 2, '스냅샷이 있는 분 수가 분모');
  assert.equal(s.missOs, 1); assert.equal(s.missIdrac, null, 'iDRAC 경로가 없으면 null(0 이 아니다)');
  assert.ok(s.actions.includes('check-batch') && s.actions.includes('tuning-dirty'));
  assert.deepEqual(F.beforeStats([{ cpu_pct: 40 }, { cpu_pct: null }, { cpu_pct: 50 }]).cpu_pct, { avg: 45, max: 50, n: 2 });
  assert.deepEqual(F.sessionPlan({ focus: { intervalS: 10, durationMin: 999 } }), { intervalS: 30, durationMin: 60, count: 120, corpMax: 5, nodeMax: 10 }, '간격 하한 30초 · 길이 상한 60분 · 노드 상한 기본 10');
});

test('⑦ 전역 동시성 풀 — 집중은 앞자리 대기 · 상한을 넘기면 얻지 못함(그 분 결측)', async () => {
  SLOTS._resetSlotsForTest();
  const cap = SLOTS.slotCapacity();
  for (let i = 0; i < cap; i++) assert.equal(await SLOTS.acquireSlot(), true);
  const order = [];
  const normal = SLOTS.acquireSlot().then((ok) => order.push(['normal', ok]));
  const prio = SLOTS.acquireSlot({ priority: true }).then((ok) => order.push(['focus', ok]));
  const timedOut = await SLOTS.acquireSlot({ priority: true, waitMs: 20 });
  assert.equal(timedOut, false, '대기 상한 → 얻지 못함');
  SLOTS.releaseSlot(); await prio;
  assert.deepEqual(order, [['focus', true]], '집중이 먼저');
  SLOTS.releaseSlot(); await normal;
  assert.deepEqual(order.map((x) => x[0]), ['focus', 'normal']);
  const busy = await SLOTS.withSlot(async () => 'ran', { waitMs: 10, onBusy: () => 'busy' });
  assert.equal(busy, 'busy');
  SLOTS._resetSlotsForTest();
});

test('⑥ 실제 api 라우터 · 엣지 collector 대행 · 중앙 정제', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness({ rules: { focus: { intervalS: 60, durationMin: 1, corpMax: 5 } } });
  F._setFocusDepsForTest(h.deps);
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b', name: 'bm-b', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a', name: 'bm-a', serviceTag: 'TAGA', vcenterId: 'vcA' },
    { serverId: 's-b', name: 'bm-b', serviceTag: 'TAGB', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { collectorRouter } = await import('../src/routes/collector.js');
  const audit = await import('../src/audit.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
  };
  const app = express();
  app.use('/api/collector', collectorRouter);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); F._resetFocusForTest(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (u, key, body) => fetch(`${base}/api/tools/bm-usage/perf/${key}/focus`, { method: 'POST', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('viewer', 'TAGA', { reason: '보기 전용' })).status, 403, 'viewer 403(operator 이상)');
  assert.equal((await post('opA', 'TAGB', { reason: '다른 법인' })).status, 404, '범위 밖 404(존재 은닉)');
  assert.equal((await post('rw', 'TAGB', { reason: '쓰기 밖' })).status, 403, '조회 무제한 + 쓰기 vcA 만 → vcB 403');
  assert.equal((await post('opA', 'TAGA', {})).status, 400, '사유 없음 400');
  assert.equal((await post('opA', 'TAGB', {})).status, 400, '사유 검사가 먼저(존재를 흘리지 않는다)');
  const r1 = await post('opA', 'TAGA', { reason: '디스크 포화 판정 13:35 · 10.1.2.3' });
  const b1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(b1)); assert.equal(b1.status, 'running');
  assert.equal((await post('opA', 'TAGA', { reason: '또 한 번' })).status, 409, '서버당 1세션');
  const acts = audit.auditEntriesWithAction('bm-perf.focus');
  assert.ok(acts.some((a) => a.user === 'opa' && /디스크 포화/.test(a.detail || '')), '감사 로그');
  const lo = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGA/focus`, { headers: { 'x-u': 'opA' } })).json();
  assert.equal(lo.sessions[0].by, undefined, '실행자는 관리자만'); assert.ok(!/10\.1\.2\.3/.test(lo.sessions[0].reason), '비관리자 사유의 IPv4 가림');
  assert.equal(lo.writable, true); assert.equal(lo.plan.intervalS, 60);
  const la = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGA/focus`, { headers: { 'x-u': 'adm' } })).json();
  assert.equal(la.sessions[0].by, 'opa');
  const wl = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGB/focus`, { headers: { 'x-u': 'rw' } })).json();
  assert.equal(wl.writable, false, '쓰기 범위 밖 → 화면이 시작 칸을 잠근다');
  assert.equal((await fetch(`${base}/api/tools/bm-usage/perf/TAGB/focus/${b1.id}`, { headers: { 'x-u': 'adm' } })).status, 404, '다른 서버 키로는 그 세션을 못 읽는다');
  const fleet = await (await fetch(`${base}/api/tools/bm-usage/focus`, { headers: { 'x-u': 'opA' } })).json();
  assert.equal(fleet.running, 1); assert.ok(fleet.sessions.every((s) => s.vcenterId === 'vcA'), '함대 칩도 범위 안만');
  const stop = await fetch(`${base}/api/tools/bm-usage/perf/TAGA/focus/${b1.id}/stop`, { method: 'POST', headers: { 'x-u': 'opA', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(stop.status, 200); assert.equal((await stop.json()).status, 'stopped');
  assert.ok(audit.auditEntriesWithAction('bm-perf.focus.stop').length >= 1);
  // 엣지 collector 대행 — 토큰 · 대상 밖 · 사유 · 감사
  const col = (p, init = {}) => fetch(`${base}/api/collector${p}`, { ...init, headers: { 'X-Collector-Token': 'tok-2929-test', 'Content-Type': 'application/json', ...(init.headers || {}) } });
  assert.equal((await fetch(`${base}/api/collector/bm-usage/focus`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, '토큰 없음');
  assert.equal((await (await col('/bm-usage/focus', { method: 'POST', body: JSON.stringify({ key: 'NOPE', reason: '대행' }) })).json()).code, 'not-found');
  assert.equal((await (await col('/bm-usage/focus', { method: 'POST', body: JSON.stringify({ key: 'TAGB', reason: '' }) })).json()).code, 'bad-reason');
  const e1 = await (await col('/bm-usage/focus', { method: 'POST', body: JSON.stringify({ key: 'TAGB', reason: '중앙 대행', by: 'adm;rm' }) })).json();
  assert.equal(e1.code, 'ok');
  const el = await (await col('/bm-usage/focus?key=TAGB')).json();
  assert.equal(el.sessions[0].by, 'central-portal:admrm', '실행자 표기는 글자 제한');
  assert.equal((await (await col(`/bm-usage/focus?key=TAGA&id=${e1.id}`)).json()).code, 'not-found', '다른 서버 키로 id 거부');
  assert.ok(audit.auditEntriesWithAction('중앙 대행 집중 모니터링').length >= 1, '엣지 감사');
  // 중앙 정제 — 아는 필드만 · enum 밖 차단 · 엣지 미래 시각은 수신 시각으로 · 지표 이름 화이트리스트
  const P = await import('../src/central/bmPerfOpsPull.js');
  const rcv = NOW;
  const sb = P.sanitizeFocusBody({ ok: true, code: 'ok', evil: 1, session: { id: e1.id, key: 'TAGB', status: 'pwned', created: NOW + 9e9, by: 'x', summary: { verdictTo: 'hacked', maxBy: { cpu_pct: { value: 1, at: NOW + 9e9 }, '__proto__': { value: 2 } } } },
    samples: [{ idx: 0, minuteTs: NOW + 9e9, vals: { cpu_pct: { avg: '7' }, evil: { avg: 1 } }, missOs: 'rm -rf', verdict: 'x' }] }, rcv);
  assert.equal(sb.evil, undefined); assert.equal(sb.session.status, 'failed'); assert.equal(sb.session.created, rcv); assert.equal(sb.session.summary.verdictTo, 'unknown');
  assert.equal(sb.session.summary.maxBy.cpu_pct.at, rcv); assert.equal(Object.keys(sb.session.summary.maxBy).length, 1);
  assert.deepEqual(sb.samples[0].vals, { cpu_pct: { avg: 7 } }); assert.equal(sb.samples[0].missOs, 'error'); assert.equal(sb.samples[0].minuteTs, rcv);
  const sum = P.sanitizeFocusSummary([{ id: 'x', key: 'k', status: 'running', created: NOW + 1e9 }, { id: '', key: 'k' }], rcv);
  assert.equal(sum.length, 1); assert.equal(sum[0].created, rcv);
});

test('구버전 엣지(경로 없음 — 401 · 404) — 집중 · 변경 · 띠 · 비교 대행은 old-version 이고 문구의 최소 버전은 릴리스 노트에서(perfOpsMinEdgeVersion)', async (t) => {
  const http = await import('node:http');
  // 구버전 엣지 흉내: collector 라우터에 경로가 없으면 사용자 인증 미들웨어로 떨어져 401(POST · GET 모두) · 다른 하나는 404(본문 사유 없음).
  const mk = (status) => new Promise((r) => { const s = http.createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'x' })); }); s.listen(0, '127.0.0.1', () => r(s)); });
  const s401 = await mk(401); const s404 = await mk(404);
  t.after(() => { s401.close(); s404.close(); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'edge-old401', name: 'edge-old401', url: `http://127.0.0.1:${s401.address().port}`, token: 'tok-old' }).ok, true);
  assert.equal(reg.addCollector({ id: 'edge-old404', name: 'edge-old404', url: `http://127.0.0.1:${s404.address().port}`, token: 'tok-old' }).ok, true);
  const P = await import('../src/central/bmPerfOpsPull.js');
  const V = P.perfOpsMinEdgeVersion();   // 반증 F15: 릴리스 노트에서 읽는다(손으로 맞추는 상수 없음 — 대조는 bmPerfMinEdgeVersion2929.test.js)
  assert.match(V, /^\d+\.\d+\.\d+$/);
  for (const agent of ['edge-old401', 'edge-old404']) {
    const st = await P.runEdgeFocus(agent, { key: 'K', reason: '구버전', by: 'adm' });
    assert.equal(st.code, 'edge'); assert.equal(st.kind, 'old-version', `${agent} 시작`);
    assert.ok(st.reason.includes(`v${V} 이상`), '문구의 버전 = 상수');
    assert.equal((await P.stopEdgeFocus(agent, { key: 'K', id: 'x' })).kind, 'old-version');
    assert.equal((await P.pullEdgeFocus(agent, { key: 'K' })).kind, 'old-version');
    for (const mode of ['changes', 'baseline', 'compare']) {
      const r = await P.pullEdgePerfOps(agent, mode, { key: 'K', query: {} });
      assert.equal(r.kind, 'old-version', `${agent} ${mode}`); assert.ok(r.reason.includes(`v${V}`));
    }
  }
  // 버전 숫자를 코드에 박지 않는다(소스 스윕 — 손으로 맞추는 상수 금지: 다른 세션의 릴리스로 번호가 밀리면 거짓 안내가 됐다 · 반증 F15)
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.join(import.meta.dirname, '../src/central/bmPerfOpsPull.js'), 'utf8'));
  assert.doesNotMatch(src, /MIN_EDGE_VERSION\s*=\s*'\d/, '상수로 박은 최소 버전 없음');
});

/* ── 반증 review-s5 반영 ─────────────────────────────────────────────── */
test('F4 법인 상한 경쟁 — 세션이 끝나는 동안(끝 구독자 대기 중) 새 시작은 대기열을 앞지르지 못하고 상한을 넘지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness({ rules: { focus: { intervalS: 60, durationMin: 1, corpMax: 1 } } }); F._setFocusDepsForTest(h.deps);
  let release; const gate = new Promise((r) => { release = r; });
  F.onFocusEnd(async () => { await gate; });   // 집중 결론 알림 발송(메일 · 웹훅 수 초) 흉내
  const a = await F.startFocusLocal({ target: tgt('FA'), reason: '첫 번째', by: 'op' });
  const b = await F.startFocusLocal({ target: tgt('FB'), reason: '두 번째', by: 'op' });
  assert.equal(a.status, 'running'); assert.equal(b.status, 'queued');
  const tm = h.timers.shift(); const pTick = tm.fn();
  await new Promise((r) => setImmediate(r));
  // A 가 끝나는 중 — 같은 동기 구간에서 대기열 맨 앞(B)이 시작됐다
  assert.equal(F.focusActiveCount(), 1); assert.equal(F.focusQueuedCount(), 0);
  const c = await F.startFocusLocal({ target: tgt('FC'), reason: '세 번째', by: 'op' });
  assert.equal(c.status, 'queued', '새 시작은 대기열 뒤로(앞지르기 없음)');
  release(); await pTick; await new Promise((r) => setImmediate(r));
  assert.equal(F.focusActiveCount(), 1, '법인 상한 1 을 넘지 않는다');
  const O = await import('../src/bmusage/opsDb.js');
  assert.equal((await O.focusGet(b.id)).status, 'running', '대기열 순서대로 B');
  F._resetFocusForTest();
  // 법인 상한을 올린 뒤의 새 요청 — 대기열 앞(D)이 먼저 시작하고 새 요청(E)은 그 뒤(앞지르기 없음)
  const rules2 = { focus: { intervalS: 60, durationMin: 1, corpMax: 1 } };
  const h2 = harness({ rules: rules2 }); F._setFocusDepsForTest(h2.deps);
  const x1 = await F.startFocusLocal({ target: tgt('FX1'), reason: '첫 번째', by: 'op' });
  const d = await F.startFocusLocal({ target: tgt('FD'), reason: '대기', by: 'op' });
  assert.equal(x1.status, 'running'); assert.equal(d.status, 'queued');
  rules2.focus.corpMax = 2;
  const e = await F.startFocusLocal({ target: tgt('FE'), reason: '상한을 올린 뒤', by: 'op' });
  assert.equal(e.status, 'queued', '새 요청은 대기열 뒤');
  assert.equal((await O.focusGet(d.id)).status, 'running', '대기열 앞이 먼저(올린 상한으로)');
  F._resetFocusForTest();
});

test('L11 노드 전체 상한 · F11 수동 하루 상한(daily-cap 실제 사용 · 동시 요청도 예약) · L8 벽시계 상한', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness({ rules: { focus: { intervalS: 60, durationMin: 5, corpMax: 5, nodeMax: 2 }, daily: { manualFocus: 2 } } }); F._setFocusDepsForTest(h.deps);
  const rs = await Promise.all([['N1', 'vcN1'], ['N2', 'vcN2'], ['N3', 'vcN3']].map(([k, vc]) => F.startFocusLocal({ target: tgt(k, vc), reason: '노드 상한', by: 'op' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), ['queued', 'running', 'running'], '법인이 달라도 노드 전체 2');
  const many = await Promise.all(['M1', 'M2'].map((k) => F.startFocusLocal({ target: tgt(k, 'vcN1'), reason: '수동 상한', by: 'op' })));
  assert.deepEqual(many.map((r) => r.code).sort(), ['daily-cap', 'queued'], '법인 vcN1 오늘 수동 2회째까지(N1 · 하나) · 3회째는 daily-cap(동시 요청도 한 번만 통과 · 노드가 차서 대기)');
  assert.match(many.find((r) => r.code === 'daily-cap').reason, /상한/);
  assert.equal(F.FOCUS_CODE_STATUS['daily-cap'], 429);
  F._resetFocusForTest();
  // L8 — 한 분 수집이 간격보다 길어도 벽시계로 길이 상한에서 끝난다
  const h2 = harness({ rules: { focus: { intervalS: 30, durationMin: 2, corpMax: 5 } }, osSeq: [() => { h2.advance(90_000); return { ok: true }; }] }); F._setFocusDepsForTest(h2.deps);
  const w = await F.startFocusLocal({ target: tgt('W1'), reason: '벽시계', by: 'op' });
  await h2.fireAll();
  const O = await import('../src/bmusage/opsDb.js');
  const done = await O.focusGet(w.id);
  assert.equal(done.status, 'done'); assert.equal(done.summary.wallCapped, true); assert.equal(done.count, 4); assert.ok(done.done < 4, '횟수(4)를 다 채우기 전에 벽시계(2분)로 끝');
  F._resetFocusForTest();
});

test('F13 재시작 직후 봉투 요약은 죽은 세션을 진행 중으로 싣지 않는다(초기화 먼저) · F14 iDRAC 만 있는 서버의 분은 결측이 아니다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const O = await import('../src/bmusage/opsDb.js');
  const { config } = await import('../src/config.js');
  F._resetFocusForTest();
  const h = harness(); F._setFocusDepsForTest(h.deps);
  await O.focusInsert({ id: '00000000-0000-4000-8000-0000000000ab', agent: config.agent?.name || '', key: 'RK1', vcenterId: 'vcA', trigger: 'manual', by: 'op', reason: 'r', created: NOW - 120_000, start: NOW - 120_000, intervalS: 60, count: 10, status: 'running' });
  F._resetFocusForTest(); F._setFocusDepsForTest(h.deps);   // = 재시작
  const env = await F.focusEnvelopeSummary({ now: NOW });
  assert.equal(env.find((x) => x.key === 'RK1')?.status, 'interrupted', '아무도 집중 API 를 부르지 않아도');
  // F14
  F._resetFocusForTest();
  const h2 = harness({ rules: { focus: { intervalS: 60, durationMin: 2, corpMax: 5 } } }); F._setFocusDepsForTest(h2.deps);
  const r = await F.startFocusLocal({ target: tgt('IO1', 'vcA', { paths: ['idrac'], osHost: null }), reason: 'iDRAC 만', by: 'op' });
  const lst = await F.listFocusLocal({ key: 'IO1' });
  assert.deepEqual([lst.sessions[0].hasOs, lst.sessions[0].hasIdrac], [false, true], '진행 중 세션은 경로를 싣는다(요약 전 — 화면이 ‘경로 없음’ 을 가린다)');
  await h2.fireAll();
  const g = await F.getFocusLocal({ key: 'IO1', id: r.id });
  assert.ok(g.samples.length >= 1);
  assert.ok(g.samples.every((x) => x.missOs == null), '경로 없음은 표본 결측이 아니다(no-path 를 적지 않는다)');
  assert.equal(g.session.summary.missOs, null, '요약도 null(경로 없음)');
  F._resetFocusForTest();
});


test('V12 · V13 비관리자 응답 — 변경 이벤트 · 구간 비교의 변경 목록 · 항목의 IPv4 를 가린다(관리자는 그대로) · V7 엣지 소모품 since 는 수신 시각으로 자른다', async () => {
  const B = await import('../src/routes/api/bmPerfOps.js');
  const deps = {
    currentTargets: async () => ({ targets: [tgt('V1')] }), bmAddressHosts: async () => [], listEdgeBmUsage: async () => [],
    local: async (mode) => (mode === 'changes'
      ? { ok: true, events: [{ kind: 'sysctl', item: 'route 10.1.2.3', before: '10.0.0.1', after: '192.168.0.9' }] }
      : { ok: true, changes: [{ kind: 'cron', item: 'job 10.7.7.7', before: 'host 10.9.9.9', after: null }] }),
  };
  const req = (role) => ({ user: { username: 'u', role, scope: null }, params: { key: 'V1' }, query: {} });
  const ip = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
  for (const mode of ['changes', 'compare']) {
    const viewer = await B.bmPerfOpsRead(req('viewer'), {}, mode, deps);
    assert.ok(!viewer.__status, JSON.stringify(viewer));
    assert.doesNotMatch(JSON.stringify(viewer.events || viewer.changes), ip, `${mode}: 비관리자 IPv4 가림`);
    assert.equal(viewer.addressHidden, true);
    const admin = await B.bmPerfOpsRead(req('admin'), {}, mode, deps);
    assert.match(JSON.stringify(admin.events || admin.changes), ip, `${mode}: 관리자는 그대로`);
  }
  const PS = await import('../src/central/bmPerfSanitize.js');
  const rcv = Date.now();
  const h = PS.healthOf({ cells: { chrony: { code: 'warn' } }, since: { chrony: rcv + 30 * 86_400_000 } }, rcv);
  assert.equal(h.since.chrony, rcv, '엣지 since(미래)는 수신 시각으로(상세)');
  assert.equal(PS.healthOf({ cells: { chrony: { code: 'warn' } }, since: { chrony: rcv + 30 * 86_400_000 } }, rcv, { full: false }).cells.chrony.since, rcv, '봉투 요약도');
});

test('v3.9.0 SSH 공용 접속(점검 B-2) — 집중 모니터링은 분마다 자격을 다시 해석하고 그 결과로 접속한다(세션 시작 때 푼 키를 끝까지 쓰지 않는다) · 해석이 막으면 그 분은 cred-config 결측', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  F._resetFocusForTest();
  const h = harness();
  const seen = []; let n = 0;
  h.deps.refreshOsHost = async (o) => { n += 1; return n === 2 ? { ...o, password: '', authError: '법인 키 사용 중지', authErrorCode: 'corp-stopped' } : { ...o, tick: n }; };
  h.deps.collectOs = async (o) => { seen.push(o); if (o.authError) return { ok: false, error: o.authError, authErrorCode: o.authErrorCode }; return { ok: true }; };
  const rec = [];
  h.deps.recordOsAuth = async (tg, o) => { rec.push([tg.osHost?.tick, o.ok]); };
  F._setFocusDepsForTest(h.deps);
  const r = await F.startFocusLocal({ target: tgt('R1', 'vcR'), reason: '재해석 확인', by: 'op' });
  assert.equal(r.code, 'ok', JSON.stringify(r));
  await h.fireAll();
  assert.equal(n, 3, '분마다 한 번');
  assert.deepEqual(seen.map((o) => o.tick ?? o.authErrorCode), [1, 'corp-stopped', 3], '수집기는 다시 해석한 대상을 받는다');
  const g = await F.getFocusLocal({ key: 'R1', id: r.id });
  assert.equal(g.samples[1].missOs, 'cred-config', '자격 해석이 막은 분은 SSH 오류가 아니라 cred-config');
  assert.deepEqual(rec, [[1, true], [3, true]], '인증 결과는 그 분에 쓴 자격으로 · 해석이 막아 로그인하지 않은 분은 적지 않는다(반증 D9)');
});
