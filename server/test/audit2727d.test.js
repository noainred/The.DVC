/**
 * audit2727d.test.js — v2.727 감사 그룹 4(엣지 계약 D-01~D-06 · 성능 F-01·F-04 · CLI 감사 B-05) 회귀.
 *
 *  F-01  logs DB `trackedEventsAsync`(1일 조각 + 양보)는 한 문장 `trackedEvents` 와 **같은 행·같은 순서·같은 상한**이고, 조각 판의 최장
 *        동기 구간이 한 문장 판보다 짧다(비율 — 절대 ms 금지, v2.611 규약). 화면·CSV 의 load() 가 조각 판을 쓴다.
 *  D-01  `agent-assignments.json`·`central-agent-gpu-guest.json` 손상 → pull 2경로 503 settingsUnreadable(assigned:false 금지) ·
 *        관리자 저장이 푼다 · 엣지(scanner·gpuGuestConfigPull)는 503 을 '중앙 지정 없음' 과 구분해 last.reason 에 남기고 직전 값 유지.
 *  D-02  edgelog/spec.js 에 service.mail(mailStatus) 등재 · 그룹 라벨 · 값에 비밀 없음 · 머리말·EXCLUDED 의 '중앙 전용' 거짓 사유 제거.
 *  D-03  `/api/central/sanswitch-test-result` BIG_JSON 등록 + 엣지(testDiag.makeTracer)·중앙(testRuns.sanitizeResult) 추적 상한이 같은 수.
 *  D-04  sanitizeInventoryList 가 상한으로 넘친 원소 수를 `dropped.overCount` 로 세고 라우트가 rejected 에 더한다(넘침 없으면 키 없음).
 *  D-05  INV_TEXT_KEYS 에 hostName·serviceTag·mgmtIp — mgmtIp 는 문자열이 아니면 null.
 *  D-06  pushBundleToEdge 의 성패가 outboundStats 에 남는다(`/api/upgrade/` 추적 접두).
 *  F-04  syncVcConfigCaches 가 vmcfg·contention 의 재시도 추적기(dropVcRetry)도 버린다.
 *  B-05  CLI 계정 도구가 생성·로그인 방식·OTP 등록·비밀번호·삭제를 audit.ndjson 에 남기고 비밀 문자열은 싣지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2727d-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-2727d';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 루프백 목 중앙(127.0.0.1)으로 엣지 pull 을 실제로 돌린다
delete process.env.PARTFAULT_ENABLED;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const src = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const code = (p) => stripComments(src(p));

// D-01: 배포되는 두 중앙 설정 파일을 **손상된 채로** 둔다(모듈을 불러오기 전에).
fs.writeFileSync(path.join(TMP, 'agent-assignments.json'), '{ 손상된 JSON');
fs.writeFileSync(path.join(TMP, 'central-agent-gpu-guest.json'), '{ 손상된 JSON');

const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨린 고정 시각)

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let base; let origin;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  const srv = http.createServer(app);
  servers.push(srv);
  const port = await listen(srv);
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/central`;
});
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const cget = (p) => fetch(`${base}${p}`, { headers: { 'X-Central-Token': 'ctok-2727d' } });

// ── F-01 ────────────────────────────────────────────────────────────────────
test('F-01: trackedEventsAsync 는 한 문장 trackedEvents 와 같은 결과(행·순서·상한)이고 최장 동기 구간은 비율로 짧다', async () => {
  const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');
  const { TRACKED_TYPES, MOVE_TYPES } = await import('../src/vmchanges/eventDetail.js');
  resetLogsDb();
  const db = await getLogsDb();
  assert.equal(db.kind, 'sqlite', 'node:sqlite 가 있어야 한다');
  assert.equal(typeof db.trackedEventsAsync, 'function');
  // 합성: vCenter 28 × 90일 · 추적 종류 2/3 · 결정적 의사난수(LCG) · ts 동률 행 포함 · 시계가 앞선 행 1건.
  const VCS = Array.from({ length: 28 }, (_, i) => `vc-${i}`);
  const OTHER = ['UserLoginSessionEvent', 'AlarmStatusChangedEvent', 'VmPoweredOnEvent'];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const recs = []; const ROWS = 120_000;
  for (let i = 0; i < ROWS; i++) {
    const tracked = (i % 3) !== 0;
    const type = tracked ? TRACKED_TYPES[i % TRACKED_TYPES.length] : OTHER[i % OTHER.length];
    const ts = i % 97 === 0 ? NOW - (i % 5000) * 1000 : NOW - Math.floor(rnd() * 90 * DAY);   // 97개마다 ts 동률 묶음
    recs.push({ vcenterId: VCS[i % 28], key: `k${i}`, ts, severity: 'info', type, user: 'u', entity: `vm-${i % 6000}`, message: 'm', detail: tracked ? '{"kind":"vmotion"}' : null });
  }
  recs.push({ vcenterId: 'vc-1', key: 'ahead', ts: NOW + 2 * DAY, severity: 'info', type: TRACKED_TYPES[0], user: 'u', entity: 'f', message: 'clock ahead' });
  db.insertMany(recs);
  const ALL = { vcenterIds: VCS };
  for (const days of [7, 30, 90]) {
    for (const lim of [1, 50, 2_000, 20_001]) {
      const f = { ...ALL, since: NOW - days * DAY };
      const sync = db.trackedEvents(f, lim);
      const sliced = await db.trackedEventsAsync(f, lim, { now: NOW });
      assert.deepStrictEqual(sliced, sync, `days=${days} limit=${lim}`);
    }
  }
  // 종류 필터·부분 vCenter·맨 위 조각 열림·빈 목록·entity(동기 판 위임)도 같다
  const fT = { vcenterIds: VCS.slice(0, 5), since: NOW - 30 * DAY, types: [...MOVE_TYPES] };
  assert.deepStrictEqual(await db.trackedEventsAsync(fT, 500, { now: NOW, sliceMs: 6 * H }), db.trackedEvents(fT, 500));
  assert.equal((await db.trackedEventsAsync({ ...ALL, since: NOW - 7 * DAY }, 5, { now: NOW }))[0].message, 'clock ahead', '맨 위 조각은 위가 열려 있다');
  assert.deepStrictEqual(await db.trackedEventsAsync({ vcenterIds: [], since: 0 }, 10), []);
  assert.deepStrictEqual(await db.trackedEventsAsync({ types: ['VmPoweredOnEvent'], since: 0 }, 10), []);
  const fE = { vcenterIds: ['vc-3'], since: NOW - 90 * DAY, entity: 'vm-3' };
  assert.deepStrictEqual(await db.trackedEventsAsync(fE, 100, { now: NOW }), db.trackedEvents(fE, 100));
  // 비율: 한 문장(90일·상한 20001)의 동기 소요 vs 조각 판 실행 중 setImmediate 프로브가 본 최장 간격(= 최장 동기 구간).
  const fBig = { ...ALL, since: NOW - 90 * DAY };
  let oneShot = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); db.trackedEvents(fBig, 20_001); oneShot = Math.min(oneShot, performance.now() - t0); }
  let maxGap = 0; let last = performance.now(); let probing = true;
  const probe = () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; if (probing) setImmediate(probe); };
  setImmediate(probe);
  const slicedBig = await db.trackedEventsAsync(fBig, 20_001, { now: NOW, sliceMs: 6 * H, yieldMs: 1 });
  probing = false;
  assert.equal(slicedBig.length, 20_001);
  assert.ok(oneShot >= 10, `한 문장 판이 ${oneShot.toFixed(1)}ms 뿐이다 — 합성 행 수를 늘려 비교가 뜻을 갖게 할 것`);
  assert.ok(maxGap * 2 < oneShot, `조각 판 최장 동기 구간 ${maxGap.toFixed(1)}ms 가 한 문장 ${oneShot.toFixed(1)}ms 의 절반 이상이다(조각·양보가 깨졌다)`);
  // 폴백(NDJSON)에도 같은 이름의 API 가 있다(라우트가 db.kind 를 가리지 않고 부른다)
  assert.match(code('logs/db.js'), /trackedEventsAsync: async \(f = \{\}, limit = 5000\) => api\.trackedEvents\(f, limit\)/);
  resetLogsDb();
});

// ── D-01 ────────────────────────────────────────────────────────────────────
test('D-01: 손상된 iDRAC 스캔 배정·GPU 게스트 배포 파일 → pull 503 settingsUnreadable · 관리자 저장이 푼다 · 서비스 점검 목록에 뜬다', async () => {
  const util = await import('../src/util/settingsLoadError.js');
  for (const p of ['/assignment?agent=edge-a', '/gpu-guest-config?agent=edge-a']) {
    for (let i = 0; i < 2; i++) {   // 두 번째는 원본이 .corrupt 로 옮겨져 '파일 없음 + 보존본만' — 여전히 503
      const r = await cget(p);
      const j = await r.json();
      assert.equal(r.status, 503, `${p}(${i}) 는 503 이어야 한다(수정 전: 200 + assigned:false) — ${JSON.stringify(j)}`);
      assert.equal(j.reason, 'settingsUnreadable');
      assert.ok(!('assigned' in j), 'assigned:false 를 싣지 않는다');
    }
  }
  const names = util.listSettingsLoadErrors().map((e) => e.file);
  assert.ok(names.includes('agent-assignments.json') && names.includes('central-agent-gpu-guest.json'), `서비스 점검 목록: ${names.join(',')}`);
  for (const f of ['agent-assignments.json', 'central-agent-gpu-guest.json']) {
    assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith(`${f}.corrupt.`)), `${f} 보존본`);
  }
  // 관리자 저장 → 풀린다(배정된 엣지는 200 assigned:true, 배정 없는 엣지는 200 assigned:false)
  const asg = await import('../src/central/assignments.js');
  const gpu = await import('../src/central/agentGpuGuestConfig.js');
  assert.equal(asg.addAssignment({ agent: 'edge-a', ips: '10.0.0.1', username: 'root', password: 'pw-a' }).ok, true);
  gpu.setAssignedGpuGuest('edge-a', { enabled: true });
  assert.equal(asg.assignmentsLoadError(), null); assert.equal(gpu.gpuGuestConfigLoadError(), null);
  const a = await (await cget('/assignment?agent=edge-a')).json();
  assert.equal(a.assigned, true); assert.equal(a.password, 'pw-a');
  assert.equal((await (await cget('/assignment?agent=edge-b')).json()).assigned, false);
  assert.equal((await (await cget('/gpu-guest-config?agent=edge-a')).json()).assigned, true);
  assert.equal((await (await cget('/gpu-guest-config?agent=edge-b')).json()).assigned, false);
  assert.ok(!util.listSettingsLoadErrors().map((e) => e.file).some((f) => /agent-assignments|central-agent-gpu-guest/.test(f)));
});

test('D-01: 엣지 — 503 은 last.reason=settingsUnreadable(직전 값 유지), 지정 없음은 unassigned/중앙 지정 없음 — 둘이 다르다', async () => {
  const { config } = await import('../src/config.js');
  const scanner = await import('../src/agent/scanner.js');
  const gpuPull = await import('../src/agent/gpuGuestConfigPull.js');
  const prev = { url: config.agent.centralUrl, token: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = origin; config.agent.centralToken = 'ctok-2727d'; config.agent.name = 'edge-x';
  try {
    // 중앙 쪽 파일을 다시 손상시킨다 — gpu 배포는 메모리 로드라 라우트가 보는 상태를 파일 손상으로 만들 수 없으므로 목 503 으로 대신한다.
    const express = (await import('express')).default;
    const app = express();
    const body503 = { ok: false, reason: 'settingsUnreadable', detail: '중앙 설정 파일을 읽지 못했습니다(테스트)', since: 1 };
    app.get('/api/central/assignment', (_req, res) => res.status(503).json(body503));
    app.get('/api/central/gpu-guest-config', (_req, res) => res.status(503).json(body503));
    const srv = http.createServer(app); servers.push(srv);
    const port = await listen(srv);
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    const r1 = await scanner.runAgentScan();
    assert.equal(r1.reason, 'settingsUnreadable', JSON.stringify(r1));
    assert.notEqual(r1.assigned, false, 'assigned:false(중앙 지정 없음)로 읽으면 안 된다');
    assert.match(r1.error, /읽지 못했습니다/);
    assert.equal(scanner.getAgentScanStatus().last.reason, 'settingsUnreadable');
    const g1 = await gpuPull.pullGpuGuestConfigNow();
    assert.equal(g1.ok, false); assert.equal(g1.reason, 'settingsUnreadable');
    assert.equal(gpuPull.gpuGuestConfigPullStatus().last.reason, 'settingsUnreadable');
    assert.ok(!fs.existsSync(path.join(TMP, 'gpu-guest.json')), '로컬 설정을 만들거나 덮지 않는다(직전 값 유지)');
    // 정상 중앙(실제 centralRouter) · 배정 없는 엣지 → 지정 없음 경로(사유가 다르다)
    config.agent.centralUrl = origin;
    const r2 = await scanner.runAgentScan();
    assert.equal(r2.assigned, false); assert.equal(r2.reason, 'unassigned');
    const g2 = await gpuPull.pullGpuGuestConfigNow();
    assert.deepEqual(g2, { ok: true, applied: false });
    assert.equal(gpuPull.gpuGuestConfigPullStatus().last.reason, '중앙 지정 없음');
  } finally { config.agent.centralUrl = prev.url; config.agent.centralToken = prev.token; config.agent.name = prev.name; }
});

// ── D-02 ────────────────────────────────────────────────────────────────────
test('D-02: service.mail 이 엣지 로그 표에 있고(엣지도 메일을 보낸다) 값에 비밀이 없다 · 거짓 사유(중앙 전용)는 사라졌다', async () => {
  const { STATUS_SPEC, GROUP_LABEL } = await import('../src/edgelog/spec.js');
  const ent = STATUS_SPEC.find((s) => s.key === 'service.mail');
  assert.ok(ent, 'service.mail 등재'); assert.equal(ent.group, 'service'); assert.equal(ent.fn, 'mailStatus');
  assert.ok(GROUP_LABEL.service, '그룹 라벨(화면이 서버 라벨로 그린다)');
  const mod = await import(path.join(SRC, 'mail/service.js'));
  const st = mod.mailStatus();
  const keys = []; const walk = (v) => { if (!v || typeof v !== 'object') return; for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
  walk(st);
  assert.deepEqual(keys.filter((k) => /pass|secret|token|key$/i.test(k)), [], `비밀 이름의 키가 있다: ${keys.join(',')}`);
  const { redactDeep } = await import('../src/edgelog/redact.js');
  assert.equal(redactDeep(st).masked, 0, 'redactDeep 이 가릴 것이 없다');
  // 엣지 분기 0 — alerts.js 는 엣지에서도 돈다(사유의 근거)
  assert.equal((code('alerts.js').match(/agent\.centralUrl/g) || []).length, 0);
  assert.match(code('index.js'), /startAlertEngine/);
  assert.doesNotMatch(src('edgelog/spec.js'), /중앙 전용 상태\(`mail\/service\.js`/);
  assert.doesNotMatch(code('../test/edgeSweep2574.test.js'), /\['mail\/service\.js', '중앙 전용'\]/);
});

// ── D-03 ────────────────────────────────────────────────────────────────────
test('D-03: sanswitch-test-result 는 BIG_JSON · 엣지 추적 상한(makeTracer)과 중앙 정화 상한(sanitizeResult)이 같은 수(600줄·2,000자)', () => {
  assert.match(code('index.js'), /app\.use\('\/api\/central\/sanswitch-test-result', BIG_JSON\);/);
  const diag = code('sanswitch/testDiag.js'); const runs = code('sanswitch/testRuns.js');
  assert.match(diag, /limit = 600/); assert.match(diag, /slice\(0, 2000\)/);
  assert.match(runs, /trace\.length < 600/); assert.match(runs, /trace\.slice\(0, 600\)/); assert.match(runs, /slice\(0, 2000\)/);
  // 재전송은 멱등이다(완료된 run 에 또 보내면 ok:true already) — 그래서 retries 를 0 으로 바꾸지 않았다(보고의 '404 거짓 실패' 는 틀렸다)
  assert.match(runs, /if \(r\.status === 'done'\) return \{ ok: true, already: true \};/);
});

// ── D-04 · D-05 ─────────────────────────────────────────────────────────────
test('D-04/05: sanitizeInventoryList — 상한 넘침은 overCount 로 세고 rejected 에 더한다 · mgmtIp 는 문자열만 · hostName/serviceTag 객체는 null', async () => {
  const { sanitizeInventoryList } = await import('../src/routes/central.js');
  const d = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'vc', 2, d);
  assert.equal(out.length, 2); assert.equal(d.overCount, 1, '넘친 원소 수');
  const d2 = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  sanitizeInventoryList([{ id: 'a' }], 'vc', 2, d2);
  assert.ok(!('overCount' in d2), '넘침이 없으면 키를 만들지 않는다(응답 모양 호환)');
  const d3 = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const h = sanitizeInventoryList([
    { id: 'h1', mgmtIp: { a: 1 }, hostName: { x: 1 }, serviceTag: ['T'] },
    { id: 'h2', mgmtIp: 10 }, { id: 'h3', mgmtIp: '10.0.0.5', hostName: 'esx-3', serviceTag: 'ABC1234' },
  ], 'vc', 100, d3);
  assert.equal(h[0].mgmtIp, null); assert.equal(h[0].hostName, null); assert.equal(h[0].serviceTag, null);
  assert.equal(h[1].mgmtIp, null, '수는 IP 가 아니다');
  assert.equal(h[2].mgmtIp, '10.0.0.5'); assert.equal(h[2].hostName, 'esx-3'); assert.equal(h[2].serviceTag, 'ABC1234');
  assert.equal(d3.coerced, 4);
  const s = code('routes/central.js');
  assert.match(s, /dropped\.notObject \+ dropped\.otherVcenter \+ dropped\.badId \+ \(dropped\.overCount \|\| 0\)/, '라우트의 rejected 합산에 overCount');
});

// ── D-06 ────────────────────────────────────────────────────────────────────
test('D-06: pushBundleToEdge 의 성패가 outboundStats 에 남는다(/api/upgrade/ 추적 접두 · 토큰 미기록)', async () => {
  const ob = await import('../src/util/outboundStats.js');
  assert.equal(ob.isTrackedPath('/api/upgrade/bundle'), true);
  const { pushBundleToEdge } = await import('../src/upgrade/upgrade.js');
  const app = (await import('express')).default();
  let seenAuth = '';
  app.post('/api/upgrade/bundle', (req, res) => { seenAuth = req.get('authorization') || ''; res.json({ ok: true, version: '9.9.9' }); });
  const srv = http.createServer(app); servers.push(srv);
  const port = await listen(srv);
  const bundle = path.join(TMP, 'b.tar.gz'); fs.writeFileSync(bundle, Buffer.from([0x1f, 0x8b, 0, 0]));
  ob.resetOutboundStats();
  const r = await pushBundleToEdge({ url: `http://127.0.0.1:${port}`, token: 'edge-tok-SECRET' }, bundle, { timeout: 10_000 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(seenAuth, 'Bearer edge-tok-SECRET');
  const bad = await pushBundleToEdge({ url: 'http://127.0.0.1:1', token: 't' }, bundle, { timeout: 5_000 });
  assert.equal(bad.ok, false);
  const rows = ob.outboundStats().rows.filter((x) => x.path === '/api/upgrade/bundle');
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const okRow = rows.find((x) => x.origin === `http://127.0.0.1:${port}`); const failRow = rows.find((x) => x.origin === 'http://127.0.0.1:1');
  assert.equal(okRow.okCount, 1); assert.equal(okRow.tag, 'upgrade-edge'); assert.equal(okRow.method, 'POST');
  assert.equal(failRow.failCount, 1); assert.ok(failRow.lastError);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/, '토큰을 기록하지 않는다');
});

// ── F-04 ────────────────────────────────────────────────────────────────────
test('F-04: syncVcConfigCaches 가 vmcfg·contention 재시도 추적기도 버린다(삭제 · 접속처 변경 둘 다)', async () => {
  const hcache = await import('../src/hostcfg/cache.js');
  const vm = await import('../src/vmcfg/collect.js');
  const ct = await import('../src/contention/collect.js');
  const { VM_COUNTERS, HOST_COUNTERS } = await import('../src/contention/parse.js');
  hcache._resetHostCfgCache(); vm._resetVmCfgRetry(); ct._resetContentionRetry();
  const VC = 'vc-f4';
  const timeoutClient = { retrieveManyObjectProps: async () => { throw new Error('request timed out'); } };
  const perfClient = {
    sc: { perfManager: 'PerfMgr' },
    perfCounterMap: async () => new Map([...Object.values(VM_COUNTERS), ...Object.values(HOST_COUNTERS)].map((k, i) => [k, String(100 + i)])),
    callRaw: async () => { throw new Error('timeout'); },
  };
  const fill = async () => {
    await vm.refreshVmCfg(timeoutClient, VC, ['vm-1', 'vm-2'], { now: NOW, settings: { vmCfgScan: true, vmCfgRefreshMs: 30 * 60_000, vmCfgPerCycle: 100, vmDevRefreshMs: 6 * H, vmDevPerCycle: 100 } });
    await ct.refreshContention(perfClient, VC, { vms: [{ ref: 'vm-1', numCpu: 2 }], hostRefs: ['host-1'], now: NOW, settings: { contentionScan: true, contentionRefreshMs: 15 * 60_000, contentionSamples: 15, contentionPerCycle: 400 } });
    assert.equal(vm.vmCfgRetrySummary(VC).cfg.backoffTargets, 2, '시한 실패한 VM 이 쉬는 중이어야 전제가 선다');
    assert.ok(ct.contentionRetryOf(VC, 'vm', 'vm-1') && ct.contentionRetryOf(VC, 'host', 'host-1'));
  };
  // ① 등록 뒤 삭제
  hcache.syncVcConfigCaches([{ id: VC, host: 'a.example' }]);
  await fill();
  assert.deepEqual(hcache.syncVcConfigCaches([]).dropped, [VC]);
  assert.equal(vm.vmCfgRetrySummary(VC).cfg.backoffTargets, 0); assert.equal(vm.vmCfgRetrySummary(VC).dev.backoffTargets, 0);
  assert.equal(ct.contentionRetryOf(VC, 'vm', 'vm-1'), null); assert.equal(ct.contentionRetryOf(VC, 'host', 'host-1'), null);
  // ② 같은 id 로 접속처 변경
  hcache.syncVcConfigCaches([{ id: VC, host: 'a.example' }]);
  await fill();
  assert.deepEqual(hcache.syncVcConfigCaches([{ id: VC, host: 'b.example' }]).dropped, [VC]);
  assert.equal(vm.vmCfgRetrySummary(VC).cfg.backoffTargets, 0);
  assert.equal(ct.contentionRetryOf(VC, 'vm', 'vm-1'), null);
  // ③ 소스: CACHE_DROPPERS 가 두 dropVcRetry 를 품는다(호출부 0 이던 결함)
  const s = code('hostcfg/cache.js');
  assert.match(s, /dropVmCfgRetry, dropContentionRetry/);
  assert.match(s, /from '\.\.\/vmcfg\/collect\.js'/); assert.match(s, /from '\.\.\/contention\/collect\.js'/);
});

// ── B-05 ────────────────────────────────────────────────────────────────────
test('B-05: CLI 계정 도구 — 생성·로그인 방식·OTP 등록·비밀번호·삭제가 audit.ndjson 에 남고 비밀 문자열은 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uadm-2727-'));
  const TOOL = path.join(SRC, 'tools/user-admin.js');
  // 2=생성 audit1 / 이름 기본 / 역할 1(viewer) / 비번 y / 두 번 / 방식 1(비밀번호) / 만들기 y
  // 6=OTP 등록 audit1 / 코드 Enter(확정 안 함) · 4=비밀번호 audit1 두 번 · 9=삭제 audit1 + ID 재입력 · 0=종료
  const input = '2\naudit1\n\n1\ny\nPassw0rd-audit1\nPassw0rd-audit1\n1\ny\n6\naudit1\n\n4\naudit1\nNewPassw0rd-2\nNewPassw0rd-2\n9\naudit1\naudit1\n0\n';
  const r = spawnSync(process.execPath, [TOOL], { input, encoding: 'utf8', timeout: 60_000, cwd: path.resolve(SRC, '..'),
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', LOGIN_POLICY_USERS: '', OTP_ROLE_ENFORCE: '', USER_ADMIN_CAN_RESTART: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /계정 'audit1' 을\(를\) 만들었습니다/);
  assert.match(r.stdout, /'audit1' 을\(를\) 지웠습니다/);
  const secret = (r.stdout.match(/설정 키\s*:\s*(\S+)/) || [])[1];
  assert.ok(secret && secret.length >= 16, 'OTP 키가 화면에 나와야 테스트가 그 키의 부재를 확인할 수 있다');
  const file = path.join(dir, 'audit.ndjson');
  assert.ok(fs.existsSync(file), '감사 파일이 없다 — CLI 변경이 기록되지 않았다');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => /^cli\.user\./.test(e.action));
  const actions = lines.map((e) => e.action);
  for (const a of ['cli.user.create', 'cli.user.login-policy', 'cli.user.otp-enroll', 'cli.user.password', 'cli.user.delete']) {
    assert.ok(actions.includes(a), `${a} 가 없다: ${actions.join(',')}`);
  }
  for (const e of lines) {
    assert.match(e.user, /^cli:/, JSON.stringify(e)); assert.equal(e.ip, 'console'); assert.equal(e.target, 'audit1');
  }
  assert.equal(lines.find((e) => e.action === 'cli.user.create').detail.startsWith('role=viewer · password=set'), true);
  assert.equal(lines.find((e) => e.action === 'cli.user.otp-enroll').detail.startsWith('begin'), true);
  assert.doesNotMatch(raw, /Passw0rd-audit1|NewPassw0rd-2/, '비밀번호가 감사 파일에 있다');
  assert.ok(!raw.includes(secret), 'OTP 키가 감사 파일에 있다');
  assert.ok(!raw.includes('otpauth'), 'otpauth URL 이 감사 파일에 있다');
  fs.rmSync(dir, { recursive: true, force: true });
});
