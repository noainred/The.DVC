/**
 * 새 코드 점검 139회차 — VM · 호스트 인사이트의 서버 쪽(/vms/insight · /hosts/insight · 도구 요약)과 같은 기간의 작은 서버 변경.
 * **실제 api 라우터**(requirePerm · 범위 · memoJson)를 띄워 재현한다.
 *
 *  R1(중간 · 재현) 재부팅 판정 rebootsOf(/hosts/checks · /hosts/insight 한 벌)가 analyzeReboots 의 **화면 목록 상한(500행)** 으로 자른 행으로
 *     호스트별 Map 을 만들어, 30일 안에 부팅한 호스트가 500대를 넘으면(658대 · 월 패치 주기) 잘린 호스트가 boot=null —
 *     분석 칸에서 '재부팅 없음(정상)' 으로 셈됐다(모름 · 예기치 않은 재부팅이 줄었다). → 호스트를 상한보다 작은 조각으로 나눠 판정하고 합친다.
 *  R2(낮음 · 재현) /hosts/insight 가 로그 DB 를 읽지 못하면(rebootsOf 예외) 빈 Map 으로 넘겨 '예기치 않은 재부팅 0 · 모름 0' 이 됐다(못 읽은 값을 0 으로).
 *     → 그 법인 줄의 reboots30d 는 null(모름) · rebootsUnread = 호스트 수 · 응답 rebootsUnreadable:true.
 *  R3(중간 · 결정 → 권장안 구현) 점검중(maintenance) vCenter 는 store 가 직전 캐시를 **기한 없이** 서빙하고 stale 표지를 붙이지 않는다 —
 *     /vms/insight · /hosts/insight 줄의 stale 은 vc.stale 만 봐서 false 였고, 화면(insightCore.pickRows)은 stale 줄만 합에서 빼므로
 *     점검중 법인의 옛 사용률 · 수를 '지금 값' 으로 더했다. → 공용 판정(metrics/unreadVcenters.js)으로 지금 값이 아닌 법인 줄에 notCurrent(사유) +
 *     stale:true(모름 줄은 unknown 이 먼저라 stale 을 세우지 않는다).
 *  가설 1(확인 — 결함 아님): 관리자가 먼저 요청해 캐시를 채운 뒤 범위 계정이 같은 URL 을 요청해도 범위 밖 법인 줄이 없다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'newcode139-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], viewer: ['dashboard'], toolsDenied: { operator: [], viewer: [] } },
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
    req.user = { username: scope ? `${role}-scoped` : role, role, scope };
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

async function get(p, { role = 'admin', scope = '' } = {}) {
  const headers = { 'x-role': role };
  if (scope) headers['x-scope'] = scope;
  const r = await fetch(base + p, { headers });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, text: t };
}

/* ── R1 ─────────────────────────────────────────────────────────────────── */
test('R1 30일 안에 부팅한 호스트가 500대를 넘어도 호스트마다 재부팅 판정이 있다(잘린 호스트를 정상으로 세지 않는다)', async () => {
  const N = 620;
  const hosts = Array.from({ length: N }, (_, i) => host('vc-r', i));
  setSnap({ vcenters: [vc('vc-r')], hosts, vms: [] });
  // 로그 DB 에는 호스트 하나(뒤쪽 — 첫 조각 밖)의 연결 끊김 이벤트만 — 그 호스트는 예기치 않은 재부팅, 나머지는 그 시간대 이벤트를 받지 못했다(no-events = 모름)
  const LOST = hosts[N - 3];
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const had = Object.hasOwn(db, 'opsEventsAsync');
  const orig = db.opsEventsAsync;
  db.opsEventsAsync = async () => [{ vcenterId: 'vc-r', entity: LOST.name, type: 'HostConnectionLostEvent', ts: LOST.bootTime - 10 * 60_000 }];
  let ins; let ck;
  try {
    ins = await get('/api/hosts/insight');
    ck = await get('/api/hosts/checks');
  } finally {
    if (had) db.opsEventsAsync = orig; else delete db.opsEventsAsync;
  }
  assert.equal(ins.status, 200, ins.text.slice(0, 300));
  const row = ins.j.rows.find((r) => r.id === 'vc-r');
  assert.equal(row.hosts.total, N);
  assert.equal(row.reboots30d, 1, '뒤쪽 호스트의 예기치 않은 재부팅도 센다(그 호스트의 이벤트가 그 조각에 간다)');
  assert.equal(row.rebootsUnread, N - 1, `모름은 ${N - 1}대(예전: 499 — 상한에서 잘린 ${N - 500}대가 '재부팅 없음' 으로 셈됐다)`);
  // /hosts/checks(같은 rebootsOf) — 호스트마다 boot 가 있다
  assert.equal(ck.status, 200, ck.text.slice(0, 300));
  const boots = Object.values(ck.j.byId).map((c) => c.boot?.kind ?? null);
  assert.equal(boots.length, N);
  assert.equal(boots.filter((k) => k === 'no-events').length, N - 1, '잘린 호스트도 판정 행이 있다');
  assert.equal(ck.j.byId[LOST.id].boot.kind, 'unexpected');
});

/* ── R2 ─────────────────────────────────────────────────────────────────── */
test('R2 로그 DB 를 읽지 못하면 재부팅 칸은 0 이 아니라 모름(reboots30d null · rebootsUnread = 호스트 수)', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const had = Object.hasOwn(db, 'opsEventsAsync');
  const orig = db.opsEventsAsync;
  db.opsEventsAsync = async () => { throw new Error('logs db unreadable (test)'); };
  try {
    const hosts = [host('vc-x', 1), host('vc-x', 2), host('vc-x', 3, { connectionState: 'DISCONNECTED', cpuUsagePct: null, memUsagePct: null })];
    setSnap({ vcenters: [vc('vc-x')], hosts, vms: [] });
    const ins = await get('/api/hosts/insight');
    assert.equal(ins.status, 200, ins.text.slice(0, 300));
    const row = ins.j.rows.find((r) => r.id === 'vc-x');
    assert.ok('reboots30d' in row, '권한이 있으므로 키는 있다(권한 없음과 구분)');
    assert.equal(row.reboots30d, null, '못 읽었으면 0 이 아니라 모름(예전: 0)');
    assert.equal(row.rebootsUnread, 3, '판정하지 못한 호스트 = 전부(예전: 끊긴 1대만)');
    assert.equal(ins.j.rebootsUnreadable, true);
  } finally {
    if (had) db.opsEventsAsync = orig; else delete db.opsEventsAsync;
  }
  // 회복 — 다시 읽히면 표지가 사라진다
  setSnap({ vcenters: [vc('vc-x')], hosts: [host('vc-x', 1)], vms: [] });
  const ok = await get('/api/hosts/insight');
  const row = ok.j.rows.find((r) => r.id === 'vc-x');
  assert.equal(row.reboots30d, 0);
  assert.equal(ok.j.rebootsUnreadable, undefined);
});

/* ── R3 ─────────────────────────────────────────────────────────────────── */
test('R3 점검중 vCenter(직전 캐시를 기한 없이 서빙 · stale 표지 없음)의 분석 줄은 지금 값이 아니다 — notCurrent + stale', async () => {
  const hosts = [host('vc-a', 1), host('vc-m', 1, { cpuUsagePct: 95 }), host('vc-m', 2)];
  const vms = [vm('vc-a', 'vc-a-esx1', 1), vm('vc-m', 'vc-m-esx1', 1, { cpuUsagePct: 99 }), vm('vc-m', 'vc-m-esx2', 2)];
  setSnap({
    vcenters: [vc('vc-a'), vc('vc-m', { status: 'maintenance', maintenance: true }), vc('vc-lg', { status: 'unreachable', stale: true, staleSince: NOW - HOUR }), vc('vc-p', { status: 'pending' }),
      vc('vc-u', { status: 'unreachable', error: 'timeout' })],
    hosts: [...hosts, host('vc-lg', 1)], vms: [...vms, vm('vc-lg', 'vc-lg-esx1', 1)],
  });
  for (const p of ['/api/vms/insight', '/api/hosts/insight']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} ${r.text.slice(0, 200)}`);
    const by = Object.fromEntries(r.j.rows.map((x) => [x.id, x]));
    assert.equal(by['vc-m'].unknown, false, `${p} 점검중 법인은 값이 있다(모름 아님)`);
    assert.equal(by['vc-m'].stale, true, `${p} 점검중 법인 줄은 stale — 화면이 합에서 빼고 따로 센다(예전: false)`);
    assert.equal(by['vc-m'].notCurrent, 'maintenance', p);
    assert.equal(by['vc-m'].status, 'maintenance', p);
    assert.equal(by['vc-lg'].stale, true, `${p} 수집 실패 이월은 예전부터 stale`);
    assert.equal(by['vc-lg'].notCurrent, 'unreachable', p);
    assert.equal(by['vc-a'].stale, false, `${p} 정상 법인은 그대로`);
    assert.equal(by['vc-a'].notCurrent, undefined, p);
    assert.equal(by['vc-p'].unknown, true, `${p} 첫 수집 중(VM 0)은 모름`);
    assert.equal(by['vc-p'].stale, false, p);
    assert.equal(by['vc-u'].unknown, true, `${p} 연결 실패 · 인벤토리 없음은 모름`);
    assert.equal(by['vc-u'].notCurrent, 'unreachable', p);
    assert.equal(by['vc-u'].stale, false, `${p} 모름 줄에는 stale 을 세우지 않는다(unknown 이 먼저 — 값이 없다)`);
  }
});

/* ── 가설 1(확인) ───────────────────────────────────────────────────────── */
test('가설 1 — 관리자가 먼저 캐시를 채워도 범위 계정에는 범위 밖 법인 줄 · 상위 목록이 없다(같은 URL · 같은 스냅샷)', async () => {
  setSnap({
    vcenters: [vc('vc-a'), vc('vc-b')],
    hosts: [host('vc-a', 1), host('vc-b', 1)],
    vms: [vm('vc-a', 'vc-a-esx1', 1), vm('vc-b', 'vc-b-esx1', 1)],
  });
  for (const p of ['/api/vms/insight', '/api/hosts/insight', '/api/hosts/insight?region=%EC%95%84%EC%8B%9C%EC%95%84']) {
    const a = await get(p);
    assert.deepEqual(a.j.rows.map((r) => r.id).sort(), ['vc-a', 'vc-b'], p);
    const s = await get(p, { role: 'admin', scope: 'vc-a' });
    assert.deepEqual(s.j.rows.map((r) => r.id), ['vc-a'], `${p} 범위 계정(관리자 다음 요청)`);
    assert.ok(!JSON.stringify(s.j.top).includes('vc-b'), `${p} 상위 목록에도 범위 밖이 없다`);
    const o = await get(p, { role: 'operator', scope: 'vc-b' });
    assert.deepEqual(o.j.rows.map((r) => r.id), ['vc-b'], `${p} 다른 범위 · 다른 역할`);
  }
});
