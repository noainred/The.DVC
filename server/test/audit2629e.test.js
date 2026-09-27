// v2.629 감사 그룹 E — 회귀 고정.
//   AUTHZ2629-01 deep-search·vm-finder: 검색어를 VM 마다 소문자화해 900KB 검색어 1건으로 루프가 수 초 멈췄다 →
//     루프 밖 1회 소문자화 + 길이 상한(넘으면 무엇과도 안 맞는다) + 배열 필터 Set. 결과는 옛 구현과 같아야 한다.
//   AUTHZ2629-03 · A6-02 iDRAC·서버 분석 조회: 범위 관리자에게 전 법인 BMC 주소·계정명·서비스태그를 줬고, 실시간 로그인
//     (gpu-probe · inventory?refresh=1 · sensors?live=1)을 다른 법인 iDRAC 에 일으킬 수 있었다 →
//     범위 계정은 귀속 vCenter 가 허용 집합인 서버만(+ omittedOutOfScope, 귀속 없음 미노출), 실시간 로그인은 전체 범위 전용.
// 실제 adminRouter·api 를 express 에 띄워 **상태코드·응답**으로 본다(audit2612a 하니스와 같다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2629e-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.IDRAC_ENABLED = 'false';

// 등록부: 범위 안(vc-us-east) 1대 · 범위 밖(vc-eu-west) 1대 · 귀속 없음 1대.
fs.writeFileSync(path.join(tmp, 'idrac.json'), JSON.stringify({ servers: [
  { id: 's1', name: 'srv-in', host: 'https://10.1.1.11', username: 'bmcin', password: 'x', vcenterId: 'vc-us-east', serviceTag: 'TAGIN01' },
  { id: 's2', name: 'srv-brazil-01', host: 'https://10.9.9.22', username: 'bmcadmin', password: 'x', vcenterId: 'vc-eu-west', serviceTag: 'TAGOUT2' },
  { id: 's3', name: 'srv-orphan', host: 'https://10.7.7.33', username: 'orphanadm', password: 'x', serviceTag: 'TAGNONE' },
] }), { mode: 0o600 });

let srv, base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  sop: { username: 'sop', role: 'operator', scope: null },
};
before(async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  await store.refresh().catch(() => {});
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

const OUT_MARKS = ['10.9.9.22', 'bmcadmin', 'srv-brazil-01', 'TAGOUT2', '10.7.7.33', 'orphanadm', 'srv-orphan', 'TAGNONE'];
const noOutOfScope = (t, where) => { for (const m of OUT_MARKS) assert.ok(!t.includes(m), `${where}: 범위 밖·귀속 없는 서버 값(${m})이 응답에 있다`); };

test('AUTHZ2629-03: GET /admin/idrac — 범위 admin 은 귀속 서버만 + omittedOutOfScope, 전체 범위는 예전 그대로', async () => {
  const f = await call('full', 'GET', '/admin/idrac');
  assert.equal(f.s, 200);
  assert.deepEqual(f.j.servers.map((x) => x.id).sort(), ['s1', 's2', 's3']);
  assert.equal(f.j.scoped, undefined, '전체 범위 응답에는 범위 필드를 싣지 않는다(예전 모양 그대로)');
  assert.equal(typeof f.j.poller.servers, 'number');
  const s = await call('sadm', 'GET', '/admin/idrac');
  assert.equal(s.s, 200);
  assert.deepEqual(s.j.servers.map((x) => x.id), ['s1']);
  assert.equal(s.j.scoped, true); assert.equal(s.j.omittedOutOfScope, 2);
  assert.equal(s.j.poller.servers, 1, '폴러 모양은 유지하되 범위 안 대수');
  assert.equal(s.j.poller.lastRun, null);
  assert.ok(Array.isArray(s.j.poller.authStops));
  noOutOfScope(s.t, '/admin/idrac');
});

test('AUTHZ2629-03: 서버 분석 조회 계열 — 범위 admin 은 귀속 서버만, 전체 범위는 범위 필드 없음', async () => {
  const paths = ['/admin/idrac/temps', '/admin/idrac/firmware-inventory', '/admin/idrac/gpu-inventory', '/admin/idrac/parts-inventory',
    '/admin/idrac/parts-servers?key=cpu%7Cx', '/admin/idrac/hardware-summary', '/admin/idrac/nic-speed', '/admin/idrac/nic-models',
    '/admin/idrac/hardware-servers?dim=model&key=x', '/admin/room-temp'];
  for (const p of paths) {
    const f = await call('full', 'GET', p);
    assert.equal(f.s, 200, `${p} full ${f.s} ${f.t.slice(0, 100)}`);
    assert.equal(f.j.scoped, undefined, `${p}: 전체 범위 응답은 예전 모양`);
    const s = await call('sadm', 'GET', p);
    assert.equal(s.s, 200, `${p} sadm ${s.s} ${s.t.slice(0, 100)}`);
    assert.equal(s.j.scoped, true, `${p}: 범위 절단 사실을 밝힌다`);
    assert.ok(s.j.omittedOutOfScope >= 2, `${p}: 뺀 개수(${s.j.omittedOutOfScope})`);
    noOutOfScope(s.t, p);
  }
  // 서버 수 대조: 전체 범위 3대 · 범위 계정 1대.
  assert.equal((await call('full', 'GET', '/admin/idrac/temps')).j.totalServers, 3);
  assert.equal((await call('sadm', 'GET', '/admin/idrac/temps')).j.totalServers, 1);
  assert.equal((await call('sadm', 'GET', '/admin/idrac/hardware-summary')).j.totalServers, 1);
  assert.equal((await call('sadm', 'GET', '/admin/room-temp')).j.totals.servers, 1);
  // parts 캐시: 범위 계정 판본이 전체 범위 응답을 오염시키지 않는다(같은 URL 연속 조회).
  const fp = await call('full', 'GET', '/admin/idrac/parts-inventory');
  assert.equal(fp.j.scoped, undefined);
});

test('AUTHZ2629-03: 스캔 발견 미지원 서버(귀속 없음)는 범위 계정에 싣지 않는다', async () => {
  const s = await call('sadm', 'GET', '/admin/idrac/unsupported');
  assert.equal(s.s, 200); assert.deepEqual(s.j.rows, []); assert.equal(s.j.scoped, true);
  assert.equal(typeof s.j.omittedOutOfScope, 'number');
  const f = await call('full', 'GET', '/admin/idrac/unsupported');
  assert.equal(f.j.scoped, undefined);
});

test('AUTHZ2629-03: 서버별 상세 — 범위 밖·귀속 없음은 404(존재 은닉), 범위 안은 그대로', async () => {
  for (const id of ['s2', 's3']) {
    for (const p of [`/admin/idrac/${id}/inventory`, `/admin/idrac/${id}/vcenter-host`, `/admin/idrac/${id}/sensors`, `/admin/idrac/${id}/temp-history`]) {
      const s = await call('sadm', 'GET', p);
      assert.equal(s.s, 404, `${p} 범위 admin 은 404 (받은 ${s.s})`);
      noOutOfScope(s.t, p);
      const f = await call('full', 'GET', p);
      assert.equal(f.s, 200, `${p} 전체 범위는 200 (받은 ${f.s})`);
    }
  }
  assert.equal((await call('sadm', 'GET', '/admin/idrac/s1/vcenter-host')).s, 200);
  assert.equal((await call('sadm', 'GET', '/admin/idrac/s1/inventory')).s, 200);
  assert.equal((await call('sadm', 'GET', '/admin/idrac/s1/temp-history')).s, 200);
});

test('A6-02: 실시간 iDRAC 로그인(gpu-probe · inventory?refresh=1 · sensors?live=1)은 범위 admin 403, 전체 범위는 통과', async () => {
  for (const p of ['/admin/idrac/s1/gpu-probe', '/admin/idrac/s1/inventory?refresh=1', '/admin/idrac/s1/sensors?live=1']) {
    const s = await call('sadm', 'GET', p);
    assert.equal(s.s, 403, `${p} 범위 admin 은 403 (받은 ${s.s})`);
    assert.equal(s.j?.error, 'forbidden');
  }
  // 전체 범위는 게이트를 지난다(없는 서버라 404 — 장비 접속 없이 게이트만 본다).
  assert.equal((await call('full', 'GET', '/admin/idrac/none/gpu-probe')).s, 404);
  assert.equal((await call('full', 'GET', '/admin/idrac/none/inventory?refresh=1')).s, 404);
});

test('AUTHZ2629-03: 전산실 온도 시계열 — 전 법인 합계·범위 밖 그룹은 범위 admin 에 불허, 뺀 개수는 밝힌다', async () => {
  const s0 = await call('sadm', 'GET', '/admin/room-temp/history?group=');
  assert.equal(s0.s, 403);
  const s1 = await call('sadm', 'GET', '/admin/room-temp/history?group=vc-eu-west');
  assert.equal(s1.s, 403);
  const s2 = await call('sadm', 'GET', '/admin/room-temp/history?group=vc-us-east');
  assert.equal(s2.s, 200);
  const sp = await call('sadm', 'GET', '/admin/room-temp/spark?groups=,vc-eu-west,vc-us-east,__unassigned__');
  assert.equal(sp.s, 200);
  assert.deepEqual(Object.keys(sp.j.groups), ['vc-us-east']);
  assert.equal(sp.j.omittedOutOfScope, 3); assert.equal(sp.j.scoped, true);
  const fp = await call('full', 'GET', '/admin/room-temp/spark?groups=,vc-eu-west,vc-us-east');
  assert.deepEqual(Object.keys(fp.j.groups).sort(), ['', 'vc-eu-west', 'vc-us-east']);
  assert.equal(fp.j.scoped, undefined);
  assert.equal((await call('full', 'GET', '/admin/room-temp/history?group=')).s, 200);
});

/* ── AUTHZ2629-01 ─────────────────────────────────────────────────────────────── */

// 옛 구현(감사 기준 커밋 9bd4f5d) — 결과 동일성 대조용 사본.
const oldHas = (s, q) => String(s || '').toLowerCase().includes(String(q).toLowerCase());
function oldTextFilter(vms, f) {
  if (f.q) vms = vms.filter((v) => oldHas(v.name, f.q) || oldHas(v.guestOS, f.q) || (v.ipAddresses || []).some((ip) => ip.includes(f.q)) || oldHas(v.host, f.q));
  if (f.guestOS) vms = vms.filter((v) => oldHas(v.guestOS, f.guestOS));
  if (f.cluster) vms = vms.filter((v) => oldHas(v.cluster, f.cluster));
  if (f.host) vms = vms.filter((v) => oldHas(v.host, f.host));
  if (f.notes) vms = vms.filter((v) => oldHas(v.notes, f.notes));
  return vms;
}
// 결정적 합성 VM(Date.now()·난수 없음).
function synthVms(n) {
  const oses = ['Microsoft Windows Server 2019', 'Red Hat Enterprise Linux 8', 'Ubuntu Linux (64-bit)', 'CentOS 7'];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `vc-a:vm-${i}`, name: `App-${i % 37}-Node${i}`, vcenterId: i % 3 ? 'vc-a' : 'vc-b', guestOS: oses[i % 4],
      host: `ESX${i % 11}.Corp.Local`, cluster: `CL-${i % 5}`, notes: i % 4 ? `Owner TEAM${i % 7} 비고` : '',
      ipAddresses: [`10.${i % 7}.${i % 13}.${i % 250}`], powerState: 'POWERED_ON' });
  }
  return out;
}

test('AUTHZ2629-01: snapshotFilter 텍스트 조건 결과는 옛 구현과 같다(대소문자·IP·빈 결과·긴 검색어)', async () => {
  const { snapshotFilter, SEARCH_TERM_MAX } = await import('../src/search/deepSearch.js');
  const vms = synthVms(600);
  const snap = { vms };
  const cases = [{ q: 'app-3' }, { q: 'NODE1' }, { q: '10.3.' }, { q: 'windows' }, { q: 'esx4.corp' }, { guestOS: 'LINUX' },
    { cluster: 'cl-2' }, { host: 'ESX1' }, { notes: 'team3' }, { q: 'app', guestOS: 'red hat', cluster: 'CL-1' }, { q: 'zzz' },
    { q: 'x'.repeat(SEARCH_TERM_MAX + 1) }, { notes: 'y'.repeat(5000) }, { q: 7 }];
  for (const f of cases) {
    const a = snapshotFilter(snap, { f }).map((v) => v.id);
    const b = oldTextFilter(vms.filter((v) => !v.template), f).map((v) => v.id);
    assert.deepEqual(a, b, `조건 ${JSON.stringify(f).slice(0, 60)} 결과가 옛 구현과 다르다`);
  }
});

test('AUTHZ2629-01: 900KB 급 검색어가 VM 수만큼 소문자화되지 않는다(옛 구현 대비 비율)', async () => {
  const { snapshotFilter } = await import('../src/search/deepSearch.js');
  const vms = synthVms(800);
  const f = { q: 'z'.repeat(300_000) };
  let t = process.hrtime.bigint();
  const oldR = oldTextFilter(vms, f);
  const tOld = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  const newR = snapshotFilter({ vms }, { f });
  const tNew = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(newR.length, oldR.length);
  assert.ok(tNew < 1000, `새 구현 ${tNew.toFixed(1)}ms`);
  assert.ok(tOld > 20 && tOld > tNew * 5, `옛 ${tOld.toFixed(1)}ms 대비 새 ${tNew.toFixed(1)}ms — 비율이 회귀와 갈리지 않는다`);
});

test('AUTHZ2629-01: vm-finder — 긴 검색어·OS 는 빈 결과, 배열 필터는 예전 의미 그대로(Set)', async () => {
  const base0 = await call('full', 'POST', '/tools/vm-finder', {});
  assert.equal(base0.s, 200);
  assert.ok(base0.j.total > 0, '목 스냅샷이 비어 있다');
  const folder = base0.j.facets.folders[0];
  const cluster = base0.j.facets.clusters[0];
  const byArr = await call('full', 'POST', '/tools/vm-finder', { folders: [folder, 'no-such'], clusters: [cluster] });
  const expect = base0.j.items.filter((x) => x.folder === folder && x.cluster === cluster).map((x) => x.id);
  assert.deepEqual(byArr.j.items.map((x) => x.id), expect);
  const os0 = base0.j.items[0].guestOS;
  const byOs = await call('full', 'POST', '/tools/vm-finder', { os: String(os0).toUpperCase() });
  assert.deepEqual(byOs.j.items.map((x) => x.id), base0.j.items.filter((x) => String(x.guestOS || '').toLowerCase().includes(String(os0).toLowerCase())).map((x) => x.id));
  const long = await call('full', 'POST', '/tools/vm-finder', { os: 'z'.repeat(200_000), q: 'z'.repeat(200_000) });
  assert.equal(long.s, 200); assert.equal(long.j.total, 0);
  // 소스: VM 루프 안에서 검색어를 소문자화하지 않는다.
  const src = fs.readFileSync(new URL('../src/routes/api/toolsCapacity.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("api.post('/tools/vm-finder'"), src.indexOf("api.post('/tools/vm-finder'") + 4000);
  assert.ok(!/String\(b\.os\)\.toLowerCase\(\)/.test(body), 'b.os 를 VM 마다 소문자화하면 안 된다');
  assert.ok(!/const inList = /.test(body) && /new Set\(arr\)/.test(body), '배열 필터는 Set 으로 본다(arr.includes 로 VM 마다 훑지 않는다)');
});
