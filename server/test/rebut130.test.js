/**
 * rebut130.test.js — 전체 점검 130회차(126 · 127회차 수정의 반증) 확정분 회귀.
 *
 *  R1(127 · 낮음) 보기용 목록 조회가 `authStopFor` 로 물어, 정지 기록 파일을 못 읽는 창에서 **수집하지 않는 대상**(엣지 위임 · 비활성 · 점검중)이 자격 지문의 탐침을 받아 갔다
 *     — 결과가 오지 않아 직접 수집 대상이 시한(10분)씩 기다렸다(모의: 화면이 15초마다 다시 묻으면 28곳 중 직접 3곳이 250분 뒤에야 열림).
 *     → 목록(설정 › vCenter · NSX 매니저 · iDRAC 폴러 상태)은 보기만 한다(peekAuthStop) + 못 읽음 표지(unread)를 떨구던 view 사본 2곳을 공용 authStopView 로.
 *  R2(127 · 낮음) 탐침 시한이 벽시계 역행(NTP 보정 — 125회차 F2 의 형제)에 그 차만큼 늘어났다(9시간 뒤로 가면 결과 없는 탐침 하나가 9시간 10분) → 기준 시각을 지금으로 당긴다.
 *  R3(127 · 낮음 · 주석) '결과 없는 탐침의 최악 = 30분에 3회' 는 사실이 아니다 — 줄어드는 것은 대상 수(30분에 3곳)이고 시도는 그 대상의 주기마다다(실측을 고정).
 *  R4(126 · 낮음) 오버커밋 접두 보류(`ramoc:<id>:`)가 콜론이 든 다른 vCenter id(`<id>:x`)의 키까지 덮어, 그 vCenter 에서 실제로 해소된 알림이 발생 중으로 남았다 → 가장 긴 접두가 이긴다.
 *  R5(126 · 낮음) VM 내보내기: 수집이 멈춘 vCenter 의 인벤토리를 ‘마지막 N초 전’(스냅샷 시각) · 엑셀 ‘기준 <지금>’ 으로만 말했다 → 읽은 시각(모르면 null) + 사유를 상태 · 메타 · 엑셀에.
 *
 * 읽기 오류는 127회차와 같이 그 파일 이름의 fs.readFileSync 만 던지게 해 재현한다. 시계는 실제 시각에서 정시 경계로 떨어뜨려 고정(util/jsonFileRead.js nowMs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut130-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, AUTH_ENABLED: 'false', DATA_SOURCE: 'live', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'VCENTERS_EXAMPLE_FALLBACK']) delete process.env[k];
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => fs.writeFileSync(F(n), typeof v === 'string' ? v : JSON.stringify(v));
const code = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const express = createRequire(import.meta.url)('express');

const RD = await import('../src/util/jsonFileRead.js');
const HOUR = 3_600_000; const MIN = 60_000;
let NOW = Math.floor(Date.now() / HOUR) * HOUR;
RD._setJsonFileLoadClockForTest(() => NOW);

const realRead = fs.readFileSync;
const bad = new Map();   // 파일 이름 → 오류 코드
fs.readFileSync = (f, ...a) => {
  const c = bad.get(path.basename(String(f)));
  if (c) { const e = new Error(`${c}: read`); e.code = c; throw e; }
  return realRead.call(fs, f, ...a);
};
let srv = null;
const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
after(() => { fs.readFileSync = realRead; RD._setJsonFileLoadClockForTest(); try { srv?.close(); } catch { /* */ } rmTmp(); process.once('exit', rmTmp); });
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };

// 등록부는 모듈을 올리기 전에 둔다. 표시 순서의 **앞**이 이 포탈이 수집하지 않는 대상이다(엣지 위임 vCenter · 비활성 NSX 매니저).
const VCS = [
  { id: 'vc-site', name: 'SITE', host: 'https://site.corp.example', username: 'svc@vsphere.local', password: 'pw', collectMode: 'site', agent: 'edge1' },
  { id: 'vc-direct', name: 'DIRECT', host: 'https://direct.corp.example', username: 'svc@vsphere.local', password: 'pw' },
];
put('vcenters.json', { vcenters: VCS });
const NSX = [
  { id: 'nsx-off', name: 'OFF', host: 'https://nsx-off.corp.example', username: 'admin', password: 'pw', enabled: false },
  { id: 'nsx-on', name: 'ON', host: 'https://nsx-on.corp.example', username: 'admin', password: 'pw', enabled: true },
];
put('nsx.json', { managers: NSX });

const AG = await import('../src/util/authGuard.js');
const CFG = await import('../src/config.js');
await CFG.secretsReady;
const { store } = await import('../src/store.js');
const TTL = AG.UNREAD_PROBE_TTL_MS;
function unreadGuard(name, opts = {}) {
  const g = AG.createAuthGuard({ file: name, ...opts });
  g._resetForTest(); put(name, {}); bad.set(name, 'EACCES');
  return g;
}
const U = { username: 'adm', role: 'admin', scope: null };
const base = async () => {
  if (!srv) {
    const { adminRouter } = await import('../src/routes/admin.js');
    const app = express(); app.use(express.json());
    app.use((req, _r, next) => { req.user = U; next(); });
    app.use('/api/admin', adminRouter);
    srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  }
  return `http://127.0.0.1:${srv.address().port}`;
};
const get = async (p) => { const r = await fetch(`${await base()}/api/admin${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };

/* ── R1 ─────────────────────────────────────────────────────────────────── */
test('R1 설정 › vCenter 목록(실제 라우트)은 못 읽는 창에서 탐침을 받아 가지 않는다 — 직접 수집 vCenter 가 그 지문의 탐침을 받는다 · 못 읽음 표지를 떨구지 않는다', () => quiet(async () => {
  const RC = await import('../src/vcenter/restClient.js');
  const name = 'vcenter-auth-stops.json';
  RC.vcAuthGuard._resetForTest(); put(name, {}); bad.set(name, 'EACCES');
  try {
    const full = new Map(CFG.loadVcenterConfig().vcenters.map((v) => [v.id, v]));
    assert.equal(full.size, 2, '픽스처 — 등록부를 읽었다');
    const r = await get('/vcenters');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.vcenters.map((v) => v.id), ['vc-site', 'vc-direct'], '픽스처 — 수집하지 않는 vCenter 가 표시 순서의 앞');
    for (const v of r.body.vcenters) {
      assert.equal(v.authStopped?.unread, true, `${v.id}: 아직 확인 전이라고 말한다(표지 unread — 예전 view 사본은 표지를 떨궜다)`);
      assert.equal(v.authStopped.attempts, 0);
    }
    // 목록을 몇 번을 열어도 탐침은 남아 있다 — 주 폴러가 처음 묻는 직접 수집 vCenter 가 받는다(예전: 목록이 엣지 위임 vCenter 에 줘 버려 직접 수집이 시한까지 기다렸다)
    for (let i = 0; i < 3; i += 1) await get('/vcenters');
    assert.equal(RC.vcAuthGuard.authStopFor(full.get('vc-direct')), null, '직접 수집 vCenter 가 탐침');
    assert.equal(RC.vcAuthGuard.peekAuthStop(full.get('vc-site'))?.unread, true, '엣지 위임 vCenter 는 판정을 기다린다');
    // 탐침 시한이 지난 뒤의 목록 조회도 탐침을 옮기지 않는다
    NOW += TTL + MIN;
    await get('/vcenters');
    assert.equal(RC.vcAuthGuard.authStopFor(full.get('vc-direct')), null, '시한 뒤에도 목록이 탐침을 가져가지 않았다');
    // 실제 정지의 응답 꼴은 예전 그대로(unread 없음)
    RC.vcAuthGuard.markAuthStopped('vc-direct', full.get('vc-direct'), 'HTTP 401 Unauthorized');
    const after = (await get('/vcenters')).body.vcenters.find((v) => v.id === 'vc-direct');
    assert.deepEqual(Object.keys(after.authStopped).sort(), ['at', 'attempts', 'reason', 'since']);
    assert.equal(after.authStopped.attempts, 1);
  } finally { RC.vcAuthGuard._resetForTest(); bad.delete(name); }
}));

test('R1 NSX 매니저 목록(실제 라우트) · iDRAC 폴러 상태(idracAuthStops)도 보기만 한다', () => quiet(async () => {
  const NS = await import('../src/nsx/store.js');
  const NR = await import('../src/nsx/registry.js');
  const name = 'nsx-auth-stops.json';
  NS.nsxAuthGuard._resetForTest(); put(name, {}); bad.set(name, 'EACCES');
  try {
    const full = new Map(NR.loadRegistry().map((m) => [m.id, m]));
    assert.equal(full.size, 2, '픽스처 — NSX 등록부를 읽었다');
    const r = await get('/nsx/managers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.managers.map((m) => [m.id, m.authStopped?.unread]), [['nsx-off', true], ['nsx-on', true]]);
    assert.equal(NS.nsxAuthGuard.authStopFor(full.get('nsx-on')), null, '수집하는 매니저가 탐침(예전: 목록이 비활성 매니저에 줬다)');
  } finally { NS.nsxAuthGuard._resetForTest(); bad.delete(name); }

  const IP = await import('../src/idrac/poller.js');
  const iname = 'idrac-auth-stops.json';
  IP._resetIdracAuthForTest(); put(iname, {}); bad.set(iname, 'EACCES');
  try {
    const reg = [{ id: 'i1', name: 'i1', host: '10.0.0.1', username: 'root', password: 'calvin' }, { id: 'i2', name: 'i2', host: '10.0.0.2', username: 'root', password: 'calvin' }];
    const stops = IP.idracAuthStops(reg);
    assert.deepEqual([...stops.keys()].sort(), ['i1', 'i2']);
    assert.equal(stops.get('i1').unread, true);
    assert.equal(IP.idracAuthStopFor(reg[0])?.unread, true, '상태 조회가 첫 서버를 탐침으로 세우지 않았다(예전: authStopFor 라 i1 이 탐침 = 정지 아님)');
  } finally { IP._resetIdracAuthForTest(); bad.delete(iname); }

  // 소스 표지 — 세 곳 모두 보기용 조회는 peek, 주기 수집의 문은 authStopFor 그대로
  assert.match(code('routes/admin/vcenters.js'), /vcAuthGuard\.peekAuthStop\(full\.get\(v\.id\)\)/);
  assert.doesNotMatch(code('routes/admin/vcenters.js'), /authStopFor\(/);
  assert.match(code('routes/admin/nsxImport.js'), /nsxAuthGuard\.peekAuthStop\(full\.get\(m\.id\)\)/);
  assert.doesNotMatch(code('routes/admin/nsxImport.js'), /authStopFor\(/);
  const idrac = code('idrac/poller.js');
  assert.equal((idrac.match(/authGuard\.authStopFor\(/g) || []).length, 1, 'iDRAC — authStopFor 는 주기 수집의 문 하나');
  for (const rel of ['routes/admin/vcenters.js', 'routes/admin/nsxImport.js']) assert.doesNotMatch(code(rel), /attempts: rec\.attempts, reason: rec\.reason \}/, `${rel} — 못 읽음 표지를 떨구는 view 사본`);
}));

/* ── R2 ─────────────────────────────────────────────────────────────────── */
test('R2 벽시계가 뒤로 가도 결과 없는 탐침은 시한(10분) 뒤 다른 대상으로 넘어간다 — 역행한 만큼 붙잡지 않고, 더 빨리 넘기지도 않는다', () => quiet(async () => {
  const name = 'r2-auth-stops.json';
  const g = unreadGuard(name);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => ({ id, username: 'svc', password: 'pw' }));
  const start = NOW;
  try {
    assert.equal(g.authStopFor(a), null);            // a 가 탐침
    assert.equal(g.authStopFor(b)?.unread, true);     // b 는 기다린다
    NOW = start - 9 * HOUR;                           // NTP 보정 — 9시간 뒤로
    assert.equal(g.authStopFor(a), null);
    assert.equal(g.authStopFor(b)?.unread, true, '역행 직후 — 더 빨리 넘기지 않는다');
    NOW += TTL - MIN;
    assert.equal(g.authStopFor(b)?.unread, true, '시한 전');
    NOW += 2 * MIN;
    assert.equal(g.authStopFor(b), null, '역행한 시각에서 시한이 지나면 넘어간다(예전: 9시간 10분 동안 a 가 붙잡았다)');
    assert.equal(g.authStopFor(a)?.unread, true);
    // 넘겨받은 뒤 다시 역행해도 같다
    NOW -= 5 * HOUR;
    assert.equal(g.authStopFor(c)?.unread, true);
    NOW += TTL + MIN;
    assert.equal(g.authStopFor(c), null, '다음 대상으로');
    // 보기만 하는 조회는 여전히 탐침을 옮기지 않는다
    NOW -= 3 * HOUR;
    assert.equal(g.peekAuthStop(a)?.unread, true);
    NOW += TTL + MIN;
    assert.equal(g.peekAuthStop(a)?.unread, true, 'peek 는 넘겨받지 않는다');
    assert.equal(g.peekAuthStop(b)?.unread, true, 'peek 가 탐침을 다른 대상으로 옮기지도 않았다');
  } finally { g._resetForTest(); bad.delete(name); NOW = start + 24 * HOUR; }
  // 빈 자리(두 대상 모두 결과 없이 시한을 넘겼다)에서 역행 — 빈 자리 시각(vacantAt)도 당긴다. 예전: 역행한 만큼 아무도 탐침을 받지 못했다.
  const name2 = 'r2b-auth-stops.json';
  const g2 = unreadGuard(name2);
  const [x, y] = ['x', 'y'].map((id) => ({ id, username: 'svc', password: 'pw' }));
  const start2 = NOW;
  try {
    assert.equal(g2.authStopFor(x), null); assert.equal(g2.authStopFor(y)?.unread, true);
    NOW += TTL + MIN;
    assert.equal(g2.authStopFor(y), null); assert.equal(g2.authStopFor(x)?.unread, true);
    NOW += TTL + MIN;
    assert.equal(g2.authStopFor(x)?.unread, true, '방금 결과 없이 끝난 대상 — 다른 대상이 먼저');
    assert.equal(g2.authStopFor(y)?.unread, true, '둘 다 한 번씩 결과 없이 끝났다 — 빈 자리');
    NOW -= 9 * HOUR;
    assert.equal(g2.authStopFor(x)?.unread, true, '역행 직후 — 시한을 지금부터 다시 센다');
    NOW += TTL + MIN;
    assert.equal(g2.authStopFor(x), null, '한 바퀴 — 처음부터 다시(예전: 역행한 9시간 동안 빈 자리로 남았다)');
  } finally { g2._resetForTest(); bad.delete(name2); NOW = start2 + 24 * HOUR; }
}));

/* ── R3 ─────────────────────────────────────────────────────────────────── */
test('R3 거부를 분류하지 못하는 수집기(결과 없음)의 산수 — 30분에 새 대상은 3곳이지만 시도는 주기마다다(주석의 "30분에 3회" 정정을 실측으로 고정)', () => quiet(async () => {
  for (const [cycle, wantLogins] of [[30_000, 60], [MIN, 30], [5 * MIN, 6]]) {
    const name = `r3-${cycle}-auth-stops.json`;
    const g = unreadGuard(name);
    const list = Array.from({ length: 28 }, (_, i) => ({ id: `t${i}`, username: 'svc@corp', password: 'wrong' }));
    const start = NOW; const logins = [];
    for (let t = 0; t < 30 * MIN; t += cycle) { NOW = start + t; for (const d of list) if (!g.authStopFor(d)) logins.push(d.id); }   // 결과를 기록하지 않는다
    assert.equal(new Set(logins).size, 3, `${cycle / 1000}초 주기: 새 대상은 시한마다 하나 — 30분에 3곳(파일이 읽히는 평소에는 28곳 전부)`);
    assert.equal(logins.length, wantLogins, `${cycle / 1000}초 주기: 시도는 탐침 대상의 주기마다 한 번(3회가 아니다)`);
    g._resetForTest(); bad.delete(name); NOW = start + 24 * HOUR;
  }
  // 거부를 분류하는 수집기는 창 전체에서 지문당 1회
  const name = 'r3-ok-auth-stops.json';
  const g = unreadGuard(name);
  const list = Array.from({ length: 28 }, (_, i) => ({ id: `t${i}`, username: 'svc@corp', password: 'wrong' }));
  let n = 0;
  for (let t = 0; t < 30; t += 1) { NOW += MIN; for (const d of list) if (!g.authStopFor(d)) { n += 1; g.markAuthStopped(d.id, d, 'HTTP 401 Unauthorized'); } }
  assert.equal(n, 1);
  g._resetForTest(); bad.delete(name);
}));

/* ── R4 ─────────────────────────────────────────────────────────────────── */
const alerts = await import('../src/alerts.js');
const hostOf = (vc) => ({ id: `${vc}-h1`, name: 'esx1', vcenterId: vc, cluster: 'cl1', connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 20000, memTotalMB: 102400 });
const vmsOf = (vc, n = 10) => Array.from({ length: n }, (_, i) => ({ id: `${vc}-vm${i}`, vcenterId: vc, cluster: 'cl1', powerState: 'POWERED_ON', cpuCount: 8, memMB: 20480 }));
const A_CFG = { cooldownMin: 60, channels: {}, rules: { ramOvercommitPct: { enabled: true, threshold: 120 }, vcpuPerCore: { enabled: true, threshold: 5 } } };
async function runAlerts(snap) {
  const orig = store.get; store.get = () => snap;
  try { await alerts._refreshStateForTest(A_CFG, false); } finally { store.get = orig; }
  return alerts.alertStatus();
}
test('R4 오버커밋 접두 보류는 가장 긴 접두가 정한다 — 못 읽은 vCenter ‘a’ 가 읽힌 vCenter ‘a:b’ 의 해소를 붙잡지 않는다', async () => {
  const ok = (id) => ({ id, name: id, status: 'connected' });
  const down = (id) => ({ id, name: id, status: 'unreachable', error: 'timeout' });
  const out = alerts.evaluate({ vcenters: [down('a'), ok('a:b'), ok('ab'), down('a:b:c')], hosts: [], vms: [], datastores: [], alarms: [] }, A_CFG);
  assert.deepEqual([...out.heldPrefixes].sort(), ['ramoc:a:', 'ramoc:a:b:c:', 'vcpuoc:a:', 'vcpuoc:a:b:c:']);
  assert.deepEqual([...out.heldPrefixExempt].sort(), ['ramoc:a:b:', 'vcpuoc:a:b:'], '읽힌 vCenter 가운데 못 읽은 id 를 콜론 접두로 갖는 것만(‘ab’ 는 원래 겹치지 않는다)');
  assert.equal(alerts.evaluate({ vcenters: [ok('a'), ok('a:b')], hosts: [], vms: [], datastores: [], alarms: [] }, A_CFG).heldPrefixExempt.size, 0, '정상 스냅샷에는 없다');

  alerts._resetAlertStateForTest();
  const both = { vcenters: [ok('a'), ok('a:b')], hosts: [hostOf('a'), hostOf('a:b')], vms: [...vmsOf('a'), ...vmsOf('a:b')], datastores: [], alarms: [] };
  let st = await runAlerts(both);
  const KEYS = ['ramoc:a:b:cl1', 'ramoc:a:cl1', 'vcpuoc:a:b:cl1', 'vcpuoc:a:cl1'];
  assert.deepEqual(st.firing.map((f) => f.key).sort(), KEYS, '픽스처 — 두 vCenter 모두 오버커밋 발생 중');
  const resolvedOf = (s, p) => s.recent.filter((r) => r.severity === 'resolved' && r.key.startsWith(p)).length;
  const before = [resolvedOf(st, 'ramoc:a:b:'), resolvedOf(st, 'ramoc:a:cl1')];
  // 'a' 가 멈추고(인벤토리 비움) 'a:b' 는 다시 읽었더니 임계 아래다
  st = await runAlerts({ vcenters: [down('a'), ok('a:b')], hosts: [hostOf('a:b')], vms: vmsOf('a:b', 1), datastores: [], alarms: [] });
  assert.deepEqual(st.firing.map((f) => f.key).sort(), ['ramoc:a:cl1', 'vcpuoc:a:cl1'], "'a' 의 알림만 보류로 남는다(예전: 'a:b' 의 두 건도 발생 중으로 남았다)");
  assert.equal(resolvedOf(st, 'ramoc:a:b:'), before[0] + 1, "'a:b' 는 실제로 해소됐다 — 해소로 기록한다");
  assert.equal(resolvedOf(st, 'ramoc:a:cl1'), before[1], "'a' 는 모름 — 해소로 기록하지 않는다(126 F1 그대로)");
  // 더 긴 id 도 못 읽으면 그 접두가 다시 이긴다
  alerts._resetAlertStateForTest();
  await runAlerts({ vcenters: [ok('a'), ok('a:b'), ok('a:b:c')], hosts: [hostOf('a:b:c')], vms: vmsOf('a:b:c'), datastores: [], alarms: [] });
  st = await runAlerts({ vcenters: [down('a'), ok('a:b'), down('a:b:c')], hosts: [], vms: [], datastores: [], alarms: [] });
  assert.deepEqual(st.firing.map((f) => f.key).sort(), ['ramoc:a:b:c:cl1', 'vcpuoc:a:b:c:cl1'], "'a:b:c' 를 못 읽는 동안은 보류");
  alerts._resetAlertStateForTest();
});

/* ── R5 ─────────────────────────────────────────────────────────────────── */
test('R5 VM 내보내기 — 수집이 멈춘 vCenter 의 인벤토리를 ‘방금 읽은 값’ 이라 말하지 않는다(상태 · 메타 · 엑셀 기준 줄)', async () => {
  const VE = await import('../src/vcenter/vmExport.js');
  const VX = await import('../src/vcenter/vmExportXlsx.js');
  const T = await import('../src/publicapi/time.js');
  const PUB = await import('../src/routes/publicApi.js');
  assert.equal(PUB.vcCollectedAtOf, T.vcCollectedAtOf, '읽은 시각 판정은 한 함수(공개 API 와 VM 내보내기가 같이 쓴다 — 사본 금지)');
  const at = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
  const gen = new Date(at).toISOString();
  const vms = [{ id: 'vc1:vm-1', name: 'app01', vcenterId: 'vc1', powerState: 'POWERED_ON', folder: 'prod' }, { id: 'vc1:vm-2', name: 'app02', vcenterId: 'vc1', powerState: 'POWERED_OFF', folder: 'prod' }];
  const SHAPES = {
    normal: [{ id: 'vc1', name: 'VC1', status: 'connected' }, null, at],
    lastGood: [{ id: 'vc1', name: 'VC1', status: 'unreachable', stale: true, staleSince: at - 3 * HOUR, error: 'timeout' }, 'unreachable', at - 3 * HOUR],
    siteStale: [{ id: 'vc1', name: 'VC1', status: 'connected', collectSource: 'site', stale: true, receivedAt: at - 5 * HOUR }, 'stale', at - 5 * HOUR],
    maintenance: [{ id: 'vc1', name: 'VC1', status: 'maintenance', maintenance: true }, 'maintenance', null],   // 직전 캐시 — 읽은 시각을 모른다
  };
  const orig = store.get;
  try {
    for (const [label, [vc, reason, wantAt]] of Object.entries(SHAPES)) {
      const snap = { generatedAt: gen, source: 'live', vcenters: [vc], vms, hosts: [], datastores: [], alarms: [] };
      store.get = () => snap;
      const nc = VE.inventoryNotCurrent(vc, snap);
      assert.equal(nc?.reason ?? null, reason, label);
      const st = await VE.vmExportStatus('vc1');
      assert.equal(st.vmTotal, 2, `${label}: 행은 그대로 둔다(지우면 없음이 된다)`);
      if (!reason) {
        assert.equal(st.invAt, gen, '정상이면 예전 그대로(스냅샷 시각)');
        assert.equal('invNotCurrent' in st, false);
      } else {
        assert.equal(st.invAt, wantAt, `${label}: 스냅샷 시각(지금)이 아니라 그 값을 읽은 시각 — 모르면 null`);
        assert.equal(st.invNotCurrent.reason, reason);
        assert.ok(st.invNotCurrent.why && st.invNotCurrent.why !== '읽지 못함', `${label}: 사유 한글 — ${st.invNotCurrent.why}`);
      }
      const t = await VE.buildVmExportTable('vc1', { keys: [], target: 'all', tmpl: true, live: false, now: at });
      assert.equal(t.meta.rows, 2);
      assert.equal(t.meta.invNotCurrent?.reason ?? null, reason, `${label}: 내보내기 메타`);
      const line = VX.invNotCurrentText(t.meta);
      if (!reason) assert.equal(line, '');
      else {
        assert.match(line, /수집이 멈춰 있어\(.+\) 인벤토리 값\(전원 · 사양 · 용량\)은 마지막으로 읽은 값입니다/);
        assert.match(line, wantAt == null ? /읽은 시각 모름$/ : /에 읽은 값$/);
      }
    }
  } finally { store.get = orig; }
  // 엑셀 세 곳(요약 · 폴더 트리의 ‘기준’ 줄 + 읽는 법)이 그 문장을 싣는다
  const x = code('vcenter/vmExportXlsx.js');
  assert.equal((x.match(/\$\{invTail\(meta\)\}/g) || []).length, 2);
  assert.match(x, /\['인벤토리', invNotCurrentText\(p\.meta\)\]/);
});
