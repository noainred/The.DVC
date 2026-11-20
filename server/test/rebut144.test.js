/**
 * 새 코드 점검 144회차(반증) — 139회차(VM · 호스트 인사이트 서버) 수정과 '결함 없음' 판정을 실제 api 라우터로 다시 본다.
 *
 *  F1(낮음 · 재현 — 139 E1 확정) GET /hosts/checks 가 로그 DB 를 못 읽으면(rebootsOf 예외) 빈 Map 으로 넘겨, 기간(30일) 안에 부팅한 호스트도 boot=null —
 *     화면 bootCell(web/src/views/hostChecksText.js)이 '30일 내 없음' 으로 그렸다(5일 전 부팅 호스트에 '재부팅 없음' — 못 읽은 값을 정상으로).
 *     v3.18.13 이전부터 있던 동작이지만 /hosts/insight(139 R2)와 같은 함수 · 같은 실패다. → 이벤트 없이 같은 analyzeReboots(조각)로 판정한
 *     rebootsUnreadOf: 기간 안 부팅은 'no-events'(판정 불가), 기간 밖 부팅은 bootTime 만으로 아는 '기간 안 재부팅 없음'(행 없음) · 응답 rebootsUnreadable:true.
 *  F2(낮음 · 재현 — 139 R2 의 과잉) /hosts/insight 가 로그 DB 를 못 읽으면 rebootsUnread 를 **호스트 전부**로 셌다 — 같은 파일의 정의
 *     ('모름 = 판정하지 못한 호스트만 · 기간 밖 부팅은 정상' — v3.22.x 수정)와 어긋나 40일 전에 부팅한 호스트까지 '모름' 이었다.
 *     → 같은 rebootsUnreadOf 로 넘겨 모름은 판정이 필요한 호스트(기간 안 부팅 · 끊김 · 부팅 시각 못 읽음)만. reboots30d 는 그대로 null.
 *  확인(결함 아님): R1 조각 판정 = 상한 없는 analyzeReboots 한 번(같은 이름 두 vCenter · 다른 꼴 entity · 읽기 절단 readFrom 포함) ·
 *     가설 1(지역 · 역할 · 데모 계정 순서를 바꿔도 캐시가 새지 않는다) · R3(범위 계정 · 지역 필터에서도 점검중 줄은 stale + notCurrent).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut144-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], viewer: ['dashboard', 'inv.hosts', 'inv.vms'], toolsDenied: { operator: [], viewer: [] } },
}));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const GB = 1024;
let seq = 0;

const host = (vc, i, o = {}) => ({
  id: `${vc}:h${i}`, vcenterId: vc, name: `${vc}-esx${i}`, cluster: 'C1', clusterRef: `domain-${vc}-c1`,
  connectionState: 'CONNECTED', powerState: 'POWERED_ON', version: '8.0.2', vendor: 'Dell Inc.', model: 'R760',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsagePct: 40, cpuUsageMhz: 25600, memTotalMB: 512 * GB, memUsagePct: 50, memUsageMB: 256 * GB,
  bootTime: NOW - 5 * DAY, ...o,
});
const vm = (vc, hostName, i, o = {}) => ({
  id: `${vc}:vm-${hostName}-${i}`, vcenterId: vc, name: `${hostName}-vm${i}`, host: hostName, powerState: 'POWERED_ON', template: false,
  cpuCount: 4, memMB: 8 * GB, storageGB: 50, cpuUsagePct: 30, memUsagePct: 40, guestOS: 'Ubuntu Linux (64-bit)', toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent', ...o,
});
const vc = (id, o = {}) => ({ id, name: id.toUpperCase(), status: 'connected', location: { region: '아시아' }, ...o });

let base; let store; const closers = [];
const setSnap = (s) => { store.snapshot = { ...(store.get() || {}), source: 'live', networks: [], alarms: [], datastores: [], generatedAt: new Date(NOW + (seq++) * 1000).toISOString(), ...s }; };

before(async () => {
  ({ store } = await import('../src/store.js'));
  const prev = store.snapshot;
  closers.push(async () => { store.snapshot = prev; });
  setSnap({ vcenters: [vc('vc-a')], hosts: [host('vc-a', 1)], vms: [] });
  const express = (await import('express')).default;
  const { queryNormalizer } = await import('../src/util/queryNormalize.js');
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json()); app.use(queryNormalizer());
  app.use((req, _r, n) => {
    const role = req.get('x-role') || 'admin';
    const scope = req.get('x-scope') ? { vcenters: req.get('x-scope').split(',') } : null;
    const demo = req.get('x-demo') === '1';
    req.user = { username: demo ? 'thedvcdemp' : scope ? `${role}-scoped` : role, role, scope, ...(demo ? { demoGuest: true } : {}) };
    n();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  const rm = () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦은 flush */ } };
  rm(); process.once('exit', rm);
});

async function get(p, { role = 'admin', scope = '', demo = false } = {}) {
  const headers = { 'x-role': role };
  if (scope) headers['x-scope'] = scope;
  if (demo) headers['x-demo'] = '1';
  const r = await fetch(base + p, { headers });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, text: t };
}

/** 로그 DB 의 이벤트 읽기를 잠시 바꾼다(실패 · 고정 이벤트). */
async function withOps(fn, body) {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const had = Object.hasOwn(db, 'opsEventsAsync');
  const orig = db.opsEventsAsync;
  db.opsEventsAsync = fn;
  try { return await body(db); } finally { if (had) db.opsEventsAsync = orig; else delete db.opsEventsAsync; }
}
const unreadable = async () => { throw new Error('logs db unreadable (test)'); };

/* ── F1 ─────────────────────────────────────────────────────────────────── */
test('F1 /hosts/checks — 로그 DB 를 못 읽으면 기간 안에 부팅한 호스트는 판정 불가(no-events)지 재부팅 없음(boot null)이 아니다', async () => {
  const hosts = [
    host('vc-c', 1),                                          // 5일 전 부팅 — 판정 불가여야 한다(예전: boot null → '30일 내 없음')
    host('vc-c', 2, { bootTime: NOW - 40 * DAY }),            // 40일 전 부팅 — bootTime 만으로 '기간 안 재부팅 없음'(null 그대로)
    host('vc-c', 3, { connectionState: 'DISCONNECTED', cpuUsagePct: null, memUsagePct: null }),
    host('vc-c', 4, { bootTime: null }),
  ];
  setSnap({ vcenters: [vc('vc-c')], hosts, vms: [] });
  const r = await withOps(unreadable, () => get('/api/hosts/checks'));
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.j.byId['vc-c:h1'].boot, { kind: 'no-events', bootTime: NOW - 5 * DAY }, '기간 안 부팅 = 판정 불가(예전: null — 화면이 30일 내 없음)');
  assert.equal(r.j.byId['vc-c:h2'].boot, null, '기간 밖 부팅은 로그 없이도 안다(null = 기간 안 재부팅 없음)');
  assert.equal(r.j.byId['vc-c:h3'].boot, null, '끊긴 호스트는 예전과 같다(화면이 — 로 그린다)');
  assert.equal(r.j.byId['vc-c:h4'].boot, null, '부팅 시각을 못 읽은 호스트도 예전과 같다(화면이 — 로 그린다)');
  assert.equal(r.j.rebootsUnreadable, true, '응답이 못 읽음을 밝힌다');
  assert.equal(r.j.counts.unexpected, 0);
  // 회복 — 다시 읽히면 표지가 없다(같은 세대 캐시를 피하려고 스냅샷을 다시 싣는다)
  setSnap({ vcenters: [vc('vc-c')], hosts, vms: [] });
  const ok = await withOps(async () => [], () => get('/api/hosts/checks'));
  assert.equal(ok.j.rebootsUnreadable, undefined);
  // 권한(구성 점검 도구)이 없으면 재부팅 묶음 키도 표지도 없다
  setSnap({ vcenters: [vc('vc-c')], hosts, vms: [] });
  const v = await withOps(unreadable, () => get('/api/hosts/checks', { role: 'viewer' }));
  assert.equal(v.status, 200, v.text.slice(0, 300));
  assert.ok(!('boot' in v.j.byId['vc-c:h1']), '권한 없음 = 키 없음');
  assert.equal(v.j.rebootsUnreadable, undefined, '권한이 없으면 표지도 없다');
  // 기간 안 부팅이 analyzeReboots 행 상한(500)을 넘어도 전부 판정 불가(139 R1 과 같은 조각)
  const many = Array.from({ length: 620 }, (_, i) => host('vc-c', 100 + i));
  setSnap({ vcenters: [vc('vc-c')], hosts: many, vms: [] });
  const big = await withOps(unreadable, () => get('/api/hosts/checks'));
  assert.equal(Object.values(big.j.byId).filter((c) => c.boot?.kind === 'no-events').length, 620, '상한에 잘린 호스트가 재부팅 없음(null)이 되지 않는다');
});

/* ── F2 ─────────────────────────────────────────────────────────────────── */
test('F2 /hosts/insight — 로그 DB 를 못 읽어도 모름은 판정이 필요한 호스트만(기간 밖 부팅은 모름이 아니다) · reboots30d 는 null', async () => {
  const hosts = [
    host('vc-d', 1), host('vc-d', 2),                                                    // 기간 안 부팅 2 — 모름
    host('vc-d', 3, { bootTime: NOW - 40 * DAY }), host('vc-d', 4, { bootTime: NOW - 90 * DAY }),   // 기간 밖 2 — 모름 아님(예전: 모름)
    host('vc-d', 5, { connectionState: 'DISCONNECTED', cpuUsagePct: null, memUsagePct: null }),     // 끊김 — 모름
  ];
  setSnap({ vcenters: [vc('vc-d')], hosts, vms: [] });
  const r = await withOps(unreadable, () => get('/api/hosts/insight'));
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const row = r.j.rows.find((x) => x.id === 'vc-d');
  assert.equal(row.reboots30d, null, '139 R2 그대로 — 못 읽었으면 0 이 아니다');
  assert.equal(row.rebootsUnread, 3, `모름 = 기간 안 부팅 2 + 끊김 1(예전: 호스트 전부 5)`);
  assert.equal(r.j.rebootsUnreadable, true);
  // 같은 호스트를 이벤트를 읽은 상태로 — 모름은 '그 시간대 이벤트 없음' 2 + 끊김 1 로 같다(못 읽음 경로와 같은 정의)
  setSnap({ vcenters: [vc('vc-d')], hosts, vms: [] });
  const ok = await withOps(async () => [], () => get('/api/hosts/insight'));
  const row2 = ok.j.rows.find((x) => x.id === 'vc-d');
  assert.equal(row2.reboots30d, 0);
  assert.equal(row2.rebootsUnread, 3);
  // 권한이 없으면 키가 없다(못 읽음이어도)
  setSnap({ vcenters: [vc('vc-d')], hosts, vms: [] });
  const v = await withOps(unreadable, () => get('/api/hosts/insight', { role: 'viewer' }));
  const vr = v.j.rows.find((x) => x.id === 'vc-d');
  assert.ok(!('reboots30d' in vr) && !('rebootsUnread' in vr), '권한 없음 = 키 없음');
  assert.equal(v.j.rebootsUnreadable, undefined);
});

/* ── R1 확인 ────────────────────────────────────────────────────────────── */
test('R1 확인 — 250대 조각 판정은 상한 없는 analyzeReboots 한 번과 같다(같은 이름 두 vCenter · 다른 꼴 entity · 읽기 절단 readFrom)', async () => {
  const { rebootsOf } = await import('../src/routes/api/hostChecks.js');
  const { BOOT_DAYS } = await import('../src/routes/api/hostExport.js');
  // 기준: hostcfg/reboots.js 에서 행 상한(500)만 뺀 사본(그 파일은 import 가 없다)
  const src = fs.readFileSync(fileURLToPath(new URL('../src/hostcfg/reboots.js', import.meta.url)), 'utf8');
  const unlimited = src.replace('rows: rows.slice(0, 500), omitted: Math.max(0, rows.length - 500)', 'rows, omitted: 0');
  assert.notEqual(unlimited, src, '기준 사본을 만들지 못했다(상한 식이 바뀌었으면 이 시험을 고칠 것)');
  const ref = await import(`data:text/javascript,${encodeURIComponent(unlimited)}`);
  let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const TYPES = ['EnteringMaintenanceModeEvent', 'HostShutdownEvent', 'HostConnectionLostEvent', 'HostReconnectionFailedEvent'];
  const hosts = Array.from({ length: 640 }, (_, i) => {
    const v = `vc${i % 3}`;
    return { id: `${v}:host-${i}`, vcenterId: v, name: i < 30 ? `dup${i % 10}` : i % 2 ? `ESX${i}.corp` : `esx${i}`, connectionState: i % 41 === 0 ? 'DISCONNECTED' : 'CONNECTED',
      bootTime: i % 53 === 0 ? undefined : NOW - Math.floor(rnd() * (i % 7 === 0 ? 50 : 29) * DAY) };
  });
  const evOf = (n, spread) => Array.from({ length: n }, (_, j) => {
    const h = hosts[Math.floor(rnd() * hosts.length)]; const r = rnd();
    const entity = r < 0.6 ? h.name : r < 0.7 ? String(h.name).toLowerCase() : r < 0.8 ? String(h.name).split('.')[0] : r < 0.9 ? `host-${j}` : null;
    const b = Number.isFinite(h.bootTime) ? h.bootTime : NOW - 10 * DAY;
    return { vcenterId: r > 0.95 ? 'vc9' : h.vcenterId, entity, type: TYPES[Math.floor(rnd() * TYPES.length)], ts: b - Math.floor(rnd() * spread * HOUR) + Math.floor(rnd() * 3 * HOUR) };
  }).sort((a, b) => b.ts - a.ts);   // DB 는 최신부터
  const vcIds = ['vc0', 'vc1', 'vc2'];
  const snap = { vcenters: vcIds.map((id) => ({ id, name: id })) };
  const READ_MAX = 20_000;   // hostChecks.js 와 같은 읽기 상한
  for (const events of [evOf(2600, 30), evOf(READ_MAX + 8_000, 30)]) {
    const got = await withOps(async (_q, limit) => events.slice(0, limit), async (db) => {
      const o = { firstTs: db.firstTs, lastTs: db.lastTs };
      db.firstTs = () => NOW - 60 * DAY; db.lastTs = () => NOW;
      try { return await rebootsOf(snap, hosts, vcIds, NOW); } finally { db.firstTs = o.firstTs; db.lastTs = o.lastTs; }
    });
    const cut = events.length > READ_MAX;
    const evs = cut ? events.slice(0, READ_MAX) : events;
    const readFrom = cut ? evs[evs.length - 1].ts : null;
    const want = new Map(ref.analyzeReboots(hosts, evs, { now: NOW, days: BOOT_DAYS, vcName: new Map(vcIds.map((id) => [id, id])),
      coverageOf: () => ({ firstTs: NOW - 60 * DAY, lastTs: NOW, why: null }), readFrom }).rows.map((x) => [x.id, x]));
    assert.ok(want.size > 500, `기준 행이 상한(500)을 넘어야 이 시험이 뜻이 있다 — ${want.size}`);
    assert.equal(got.size, want.size, `절단 ${cut}`);
    for (const [id, x] of want) assert.deepEqual(got.get(id), x, `절단 ${cut} ${id}`);
    if (cut) assert.ok([...want.values()].some((x) => x.readCut), '읽기 절단 판정(readCut)이 실제로 걸렸다');
    const kinds = new Set([...want.values()].map((x) => x.kind));
    assert.ok(kinds.size >= 3, `판정 종류가 고루 나와야 한다 — ${[...kinds]}`);
  }
});

/* ── 가설 1 · R3 확인 ───────────────────────────────────────────────────── */
test('가설 1 확인 — 순서(지역 · 역할 · 데모 계정)를 바꿔도 캐시가 범위 · 권한 밖 칸을 주지 않는다 · R3 점검중 줄은 범위 · 지역에서도 stale', async () => {
  setSnap({
    vcenters: [vc('vc-a'), vc('vc-b', { location: { region: '유럽' } }), vc('vc-m', { status: 'maintenance', maintenance: true })],
    hosts: [host('vc-a', 1), host('vc-b', 1), host('vc-m', 1)],
    vms: [vm('vc-a', 'vc-a-esx1', 1), vm('vc-b', 'vc-b-esx1', 1), vm('vc-m', 'vc-m-esx1', 1)],
  });
  const asia = encodeURIComponent('아시아');
  for (const p of ['/api/vms/insight', '/api/hosts/insight']) {
    // ① 범위 계정이 지역으로 먼저 → 관리자 같은 URL → 다른 범위
    const s1 = await get(`${p}?region=${asia}`, { role: 'operator', scope: 'vc-m' });
    assert.deepEqual(s1.j.rows.map((r) => r.id), ['vc-m'], `${p} 범위 + 지역`);
    assert.equal(s1.j.rows[0].stale, true, `${p} 범위 계정에도 점검중 줄은 stale`);
    assert.equal(s1.j.rows[0].notCurrent, 'maintenance');
    const a1 = await get(`${p}?region=${asia}`);
    assert.deepEqual(a1.j.rows.map((r) => r.id).sort(), ['vc-a', 'vc-m'], `${p} 관리자(지역) — 범위 계정 캐시를 받지 않는다`);
    const s2 = await get(`${p}?region=${asia}`, { role: 'operator', scope: 'vc-a' });
    assert.deepEqual(s2.j.rows.map((r) => r.id), ['vc-a'], `${p} 다른 범위`);
    // ② 데모 계정(역할 admin · 관리자 판본 아님)이 먼저 → 관리자 → 데모: 관리자 판본 칸(hw)이 데모에 새지 않는다
    const d1 = await get(p, { demo: true });
    const a2 = await get(p);
    const d2 = await get(p, { demo: true });
    if (p === '/api/hosts/insight') {
      assert.equal(d1.j.access.hw, false, '데모 계정은 관리자 판본(iDRAC)이 아니다');
      assert.equal(a2.j.access.hw, true, '관리자는 데모 캐시를 받지 않는다');
      assert.equal(d2.j.access.hw, false, '관리자 다음 데모 — 관리자 캐시를 받지 않는다');
      assert.ok(d2.j.rows.every((r) => !('hw' in r)), '데모 줄에 하드웨어 칸이 없다');
      // ③ 도구 권한 없는 계정(viewer) 다음 · 앞 — 재부팅 칸 키 유무가 섞이지 않는다
      const v = await get(p, { role: 'viewer' });
      assert.ok(v.j.rows.every((r) => !('reboots30d' in r)), 'viewer 는 재부팅 칸이 없다');
      const o = await get(p, { role: 'operator' });
      assert.ok(o.j.rows.filter((r) => !r.unknown).every((r) => 'reboots30d' in r), 'operator(도구 권한)는 재부팅 칸이 있다');
    } else {
      assert.deepEqual(d1.j.rows.map((r) => r.id).sort(), a2.j.rows.map((r) => r.id).sort());
    }
  }
});

/* ── 스윕 ③(126 스윕 확장) ──────────────────────────────────────────────── */
// 126회차 스윕(staleSnapshotSweep126 — 스냅샷 접근 + 사용률 필드가 **같은 파일**)은 vCenter 목록을 매개변수로 받는 순수 집계 모듈을 잡지 못한다
//   (139 R3 의 vmInsight · hostInsight 가 그 예 — 라우트가 스냅샷을 읽고 이 모듈이 사용률을 더한다). 그런 모듈을 따로 찾아 분류를 강제한다.
//   분류의 뜻은 126 표와 같다(shared · own · display · left · unverified). 새 모듈이 여기 없으면 실패 — '그 vCenter 의 수집이 멈추면 이 줄은 무엇이 되는가' 를 먼저 답할 것.
const PURE_TABLE = {
  'corpusage/build.js': ['own', '호출자(routes/api/svcInventory.js — 126 표 shared)가 unreadVcenterReasons 결과를 넘기고 judgeServer 가 그 vCenter 호스트 값을 stale 로 둔다'],
  'inventory/platformSummary.js': ['display', 'vCenter 상태(점검중 · 수집 실패 · 낡은 위임)를 줄과 합계(tv)에 싣는다 — 화면이 상태로 그린다'],
  'inventory/vmByVcenter.js': ['display', '법인별 줄은 신원 · 상태(corpIdentityOf)를 싣고 화면(corpSiteStatus)이 점검중을 ‘마지막으로 수집한 인벤토리’ 로 표시하며 합에 넣는다(countable) — 분석 보기(합에서 뺌)와 다른 것은 화면 설계(144 결정 메모)'],
  'inventory/vmInsight.js': ['shared', '139 R3 — notCurrentOf(unreadVcenterReasons)'],
  'vcenter/hostCorp.js': ['display', 'vmByVcenter 와 같다(corpIdentityOf 의 원본)'],
  'vcenter/hostInsight.js': ['shared', '139 R3 — vmInsight.notCurrentOf 를 같이 쓴다'],
};
test('스윕 ③ vCenter 목록을 받아 사용률 · 용량을 더하는 순수 집계 모듈은 분류표에 있다(126 스윕이 못 잡는 꼴)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
  const SNAP_RE = /\bstore\.get\(\)|\bstore\.snapshot\b|\bgetSnapshot\(|\bsnap(?:shot)?\??\.(?:hosts|datastores|vms|alarms)\b/;   // 126 과 같은 식(그쪽이 잡는 파일은 뺀다)
  const FIELD_RE = /\b(?:cpuUsagePct|memUsagePct|cpuUsageMhz|memUsageMB|usagePct|freeGB|capacityGB|usedGB|powerWatts|tempC|gpuUtilPct|overallStatus)\b/;
  const PURE_RE = /\{\s*vcenters\s*(?:=\s*\[\])?\s*,/;   // ({ vcenters = [], … }) 매개변수 — 법인(vCenter)마다 줄을 만드는 집계
  const SHARED_RE = /\b(?:unreadVcenterReasons|unreadVcenterIds|notReadVcentersOf|notCurrentOf)\b/;
  const found = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['vendor', 'mock', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(p, 'utf8'));
      if (!SNAP_RE.test(src) && FIELD_RE.test(src) && PURE_RE.test(src)) found.set(path.relative(SRC_DIR, p).split(path.sep).join('/'), src);
    }
  })(SRC_DIR);
  assert.ok(found.has('inventory/vmInsight.js') && found.has('vcenter/hostInsight.js'), `탐지가 깨졌다 — ${[...found.keys()].join(', ')}`);
  const missing = [...found.keys()].filter((f) => !Object.hasOwn(PURE_TABLE, f));
  assert.deepEqual(missing, [], `분류표에 없는 순수 집계 — 멈춘 vCenter(점검중 · 수집 실패 이월 · 엣지 보고 끊김)의 줄이 무엇이 되는지 답하고 PURE_TABLE 에 넣을 것: ${missing.join(', ')}`);
  const gone = Object.keys(PURE_TABLE).filter((f) => !found.has(f));
  assert.deepEqual(gone, [], `분류표에만 남은 항목 — 지울 것: ${gone.join(', ')}`);
  for (const [f, [cls, why]] of Object.entries(PURE_TABLE)) {
    assert.ok(['shared', 'own', 'display', 'left', 'unverified'].includes(cls), `${f}: 모르는 분류 ${cls}`);
    assert.ok(why, `${f}: 사유를 적는다`);
    if (cls === 'shared') assert.match(found.get(f), SHARED_RE, `${f}: shared 인데 공용 판정을 부르지 않는다`);
  }
});
