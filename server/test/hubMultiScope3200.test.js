/**
 * v3.20.0 — 허브(Hypervisor · Virtual Machine · vCenter 세 탭) 바로가기 복수 선택 — 서버 계약 ?vcenterIds=a,b,…
 *   (설계 docs/design/vm-menu §6 '바로가기 복수 선택' · 사용자 확정 2026-11-18 기본값 ③ '복수 선택 · 세 탭 공용')
 *  ① 목록 2곳 → 여섯 라우트(/hosts · /hosts/checks · /hosts/corp · /vms · /vms/by-vcenter · /platform/summary)가 두 법인 데이터만
 *  ② 범위 계정 — 범위 밖 id 를 섞으면 범위 안 것만 · 범위 밖 id 만 보내면 0건(전체가 아니다) · 범위 밖 이름도 없다
 *  ③ vcenterId 와 함께 오면 vcenterId 우선(목록은 무시)
 *  ④ 해석(shared.js parseVcenterIds 하나) — 공백 · 빈 값 · 중복 · 길이 · 개수 상한(등록 수와 200 중 작은 값 · 앞에서 자른다) · 비면 0건 · scopeSlice(Set)
 *  ⑤ /platform/summary — byVc 는 고른 법인과 무관하게 (범위 ∩ 리전) 전체 줄 · totals 는 고른 법인의 합(단일 · 복수 모두)
 *  ⑥ 캐시 — 같은 사용자가 목록만 바꾸면 다른 결과 · 범위 계정과 전체 계정이 같은 목록이어도 다른 결과 · 키는 정규화한 목록
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubMultiScope3200-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VA = 'vc-a'; const VB = 'vc-b'; const VC = 'vc-c'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VA, VB, VC, OUT].map((id) => ({ id, name: id, host: `${id}.corp.local`, username: 'u', password: 'p', collectMode: 'site' })) }));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ }
  process.once('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 종료 중 */ } });
});

// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let atSeq = 0;
const nextAt = () => new Date(NOW + (atSeq++) * 60_000).toISOString();

const S = await import('../src/routes/api/shared.js');
const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { registerInventory } = await import('../src/routes/api/inventory.js');
const { registerHostCorp } = await import('../src/routes/api/hostCorp.js');
const { registerHostChecks } = await import('../src/routes/api/hostChecks.js');

const host = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'CL1', connectionState: 'CONNECTED', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, cpuCores: 32, cpuMhz: 2500, cpuTotalMhz: 80000, cpuUsageMhz: 8000, memTotalMB: 262144, memUsageMB: 50000, ...o });
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, cpuUsagePct: 10, memUsagePct: 10, toolsVersionStatus: 'guestToolsCurrent', snapshotCount: 0, ...o });
// 호스트: A 2 · B 1 · C 3 · OUT 1 / VM: A 1 · B 2 · C 1 · OUT 4 — 법인마다 수가 달라 합을 보면 어느 법인이 섞였는지 드러난다
const HOSTS = [host(VA, 'h1'), host(VA, 'h2'), host(VB, 'h1'), host(VC, 'h1'), host(VC, 'h2'), host(VC, 'h3'), host(OUT, 'h1')];
const VMS = [vm(VA, 'a1'), vm(VB, 'b1'), vm(VB, 'b2'), vm(VC, 'c1'), vm(OUT, 'o1'), vm(OUT, 'o2'), vm(OUT, 'o3'), vm(OUT, 'o4')];
const REGS = [
  { id: VA, name: VA, status: 'connected', location: { region: '유럽' } },
  { id: VB, name: VB, status: 'connected', location: { region: '유럽' } },
  { id: VC, name: VC, status: 'connected', location: { region: '아시아' } },
  { id: OUT, name: OUT, status: 'connected', location: { region: '북미' } },
];
const mkSnap = () => ({ source: 'live', generatedAt: nextAt(), datastores: [], networks: [], alarms: [], hosts: HOSTS, vms: VMS, vcenters: REGS,
  rollups: { sites: REGS.map((v) => ({ ...v, metrics: { alarmsCritical: 0, alarmsWarning: 0 } })) } });

const ADMIN = { username: 'adm', role: 'admin' };
const SCOPED = { username: 'sc', role: 'admin', scope: { vcenters: [VA, VB] } };
let user = ADMIN;
const prevSnap = store.snapshot;
store.snapshot = mkSnap();
closers.push(async () => { store.snapshot = prevSnap; });
const app = express();
app.use(queryNormalizer());
app.use((req, _res, next) => { req.user = user; next(); });
// /hosts/corp · /hosts/checks 를 /hosts/:id 보다 먼저(routes/api.js 순서)
const router = express.Router(); registerHostCorp(router); registerHostChecks(router); registerInventory(router); app.use('/api', router);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
closers.push(() => new Promise((r) => srv.close(() => r())));
const BASE = `http://127.0.0.1:${srv.address().port}/api`;
async function get(p, q = '') {
  const r = await fetch(`${BASE}${p}${q ? `?${q}` : ''}`);
  assert.equal(r.status, 200, `${p}?${q}`);
  return r.json();
}
const ids = (q) => `vcenterIds=${q.map(encodeURIComponent).join(',')}`;

/** 여섯 라우트가 본 법인 — 각 응답에서 vCenter id 를 모은다(정렬). summary 는 totals 의 합 · byVc 줄을 따로 돌려준다. */
async function seen(q) {
  const hosts = await get('/hosts', q);
  const checks = await get('/hosts/checks', q);
  const corp = await get('/hosts/corp', q);
  const vms = await get('/vms', q);
  const byvc = await get('/vms/by-vcenter', q);
  const sum = await get('/platform/summary', q);
  const uniq = (a) => [...new Set(a)].sort();
  return {
    hosts: uniq(hosts.items.map((h) => h.vcenterId)), hostsTotal: hosts.total,
    checks: uniq(Object.keys(checks.byId).map((k) => k.split(':')[0])), checksN: checks.hosts,
    corp: uniq(corp.corps.map((c) => c.id)),
    vms: uniq(vms.items.map((v) => v.vcenterId)), vmsTotal: vms.total,
    byvc: uniq(byvc.corps.map((c) => c.id)),
    sumRows: sum.byVc.map((r) => r.id).sort(), sumTotals: sum.totals, raw: JSON.stringify([hosts, checks, corp, vms, byvc, sum]),
  };
}

test('① 목록 2곳 → 여섯 라우트가 두 법인 데이터만', async () => {
  user = ADMIN;
  const s = await seen(ids([VA, VB]));
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(s[k], [VA, VB], k);
  assert.equal(s.hostsTotal, 3); assert.equal(s.checksN, 3); assert.equal(s.vmsTotal, 3);
  assert.equal(s.sumTotals.vcenters.total, 2); assert.equal(s.sumTotals.hosts.total, 3); assert.equal(s.sumTotals.vms.total, 3);
  // 순서를 바꿔도 · 공백 · 중복을 섞어도 같은 결과
  const s2 = await seen(`vcenterIds=${encodeURIComponent(` ${VB} ,,${VA},${VB}`)}`);
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(s2[k], [VA, VB], `정규화 ${k}`);
  // 한 곳만 목록으로 보내도 같은 규칙(웹은 1곳이면 vcenterId 를 쓰지만 서버는 둘 다 받는다)
  const s3 = await seen(ids([VC]));
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(s3[k], [VC], `한 곳 ${k}`);
  // 아무것도 고르지 않으면 전체(예전 그대로)
  const all = await seen('');
  assert.deepEqual(all.hosts, [VA, VB, VC, OUT]);
  assert.equal(all.sumTotals.vms.total, VMS.length);
});

test('② 범위 계정 — 범위 밖 id 는 섞이지 않는다 · 범위 밖 id 만 보내면 0건(전체가 아니다)', async () => {
  user = SCOPED;
  const mixed = await seen(ids([VA, OUT]));
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(mixed[k], [VA], `섞음 ${k}`);
  assert.equal(mixed.sumTotals.vcenters.total, 1); assert.equal(mixed.sumTotals.hosts.total, 2); assert.equal(mixed.sumTotals.vms.total, 1);
  assert.equal(mixed.raw.includes(OUT), false, '범위 밖 법인은 이름도 없다');
  const only = await seen(ids([OUT]));
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(only[k], [], `범위 밖만 ${k} — 0건`);
  assert.equal(only.hostsTotal, 0); assert.equal(only.vmsTotal, 0); assert.equal(only.checksN, 0);
  assert.equal(only.sumTotals.vcenters.total, 0, 'summary 합도 0건');
  assert.equal(only.sumTotals.hosts.total, 0); assert.equal(only.sumTotals.vms.total, 0);
  assert.deepEqual(only.sumRows, [VA, VB], 'byVc 는 범위 안 전체 줄(칩 숫자) — 범위 밖 줄은 없다');
  assert.equal(only.raw.includes(OUT), false);
  // 전부 버려지는 목록(쉼표 · 공백뿐)도 0건 — '필터 없음' 이 아니다
  const empty = await seen(`vcenterIds=${encodeURIComponent(' , ,')}`);
  assert.equal(empty.hostsTotal, 0); assert.equal(empty.vmsTotal, 0); assert.deepEqual(empty.corp, []); assert.equal(empty.sumTotals.vcenters.total, 0);
  user = ADMIN;
  const emptyAdmin = await seen('vcenterIds=,,');
  assert.equal(emptyAdmin.hostsTotal, 0, '전체 계정도 빈 목록은 0건');
  assert.equal(emptyAdmin.sumTotals.vms.total, 0);
  assert.deepEqual(emptyAdmin.sumRows, [VA, VB, OUT, VC].sort());
  // 등록되지 않은 id 만 → 0건
  const ghost = await seen(ids(['vc-none']));
  assert.equal(ghost.hostsTotal, 0); assert.deepEqual(ghost.byvc, []);
});

test('③ vcenterId 와 함께 오면 vcenterId 우선 — 목록은 무시', async () => {
  user = ADMIN;
  const s = await seen(`vcenterId=${VC}&${ids([VA, VB])}`);
  for (const k of ['hosts', 'checks', 'corp', 'vms', 'byvc']) assert.deepEqual(s[k], [VC], k);
  assert.equal(s.sumTotals.vcenters.total, 1); assert.equal(s.sumTotals.hosts.total, 3);
  // 범위 계정 — 범위 밖 vcenterId 는 목록이 범위 안이어도 0건(목록으로 되살아나지 않는다)
  user = SCOPED;
  const o = await seen(`vcenterId=${OUT}&${ids([VA])}`);
  assert.equal(o.hostsTotal, 0); assert.equal(o.vmsTotal, 0); assert.deepEqual(o.corp, []); assert.equal(o.sumTotals.vcenters.total, 0);
  assert.equal(o.raw.includes(OUT), false);
  user = ADMIN;
});

test('④ 해석 — 공백 · 빈 값 · 중복 · 길이 · 개수 상한 · 비면 0건 · 단일 우선 · scopeSlice(Set)', () => {
  const snap4 = { vcenters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.equal(S.parseVcenterIds({}, snap4), null, '키 없음 = 필터 없음');
  assert.equal(S.parseVcenterIds({ vcenterIds: '' }, snap4), null, '빈 글자 = 필터 없음(웹은 0곳이면 보내지 않는다)');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: ' a , ,b,a,, b ' }, snap4), ['a', 'b'], '공백 · 빈 값 · 중복 제거 · 순서 유지');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: ',, ,' }, snap4), [], '다 버려지면 [] = 0건');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: ['a', 'b'] }, snap4), [], '글자가 아니면 [] = 0건(넓어지지 않는다)');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: { a: 1 } }, snap4), []);
  assert.equal(S.parseVcenterIds({ vcenterId: 'c', vcenterIds: 'a,b' }, snap4), null, '단일이 있으면 목록은 무시');
  assert.deepEqual([...S.vcenterPickOf({ vcenterId: 'c', vcenterIds: 'a,b' }, snap4)], ['c']);
  const long = 'x'.repeat(S.VCENTER_ID_LEN_MAX + 1);
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: `${long},a,${'y'.repeat(S.VCENTER_ID_LEN_MAX)}` }, snap4), ['a', 'y'.repeat(S.VCENTER_ID_LEN_MAX)], 'id 하나 200자 초과는 버린다');
  // 개수 상한 = min(등록 vCenter 수, 200) — 넘으면 앞에서 자른다(중복 제거 뒤에 센다)
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: 'a,a,b,c,d,e' }, snap4), ['a', 'b', 'c'], '등록 3곳 → 앞의 3개');
  const many = { vcenters: Array.from({ length: 300 }, (_, i) => ({ id: `v${i}` })) };
  const r = S.parseVcenterIds({ vcenterIds: Array.from({ length: 260 }, (_, i) => `v${i}`).join(',') }, many);
  assert.equal(r.length, S.VCENTER_IDS_MAX); assert.equal(S.VCENTER_IDS_MAX, 200); assert.equal(r[0], 'v0'); assert.equal(r[199], 'v199');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: 'a' }, { vcenters: [] }), [], '등록 0곳이면 0건');
  // 캐시 키 — 정규화(중복 제거 · 정렬) · 고르지 않음('-')과 빈 목록('v')은 다르다
  assert.equal(S.vcenterPickKey({ vcenterIds: 'b,a,b' }, snap4), S.vcenterPickKey({ vcenterIds: 'a,b' }, snap4));
  assert.equal(S.vcenterPickKey({}, snap4), '-');
  assert.equal(S.vcenterPickKey({ vcenterIds: ',' }, snap4), 'v');
  assert.notEqual(S.vcenterPickKey({ vcenterIds: 'a' }, snap4), S.vcenterPickKey({ vcenterIds: 'a,b' }, snap4));
  // scopeSlice — 글자(예전 그대로) · Set(고른 법인 — 빈 Set 은 0건) · 범위가 먼저
  const snapS = { vcenters: REGS, hosts: HOSTS, vms: VMS, datastores: [], alarms: [] };
  assert.deepEqual([...new Set(S.scopeSlice(snapS, SCOPED, new Set([VA, OUT])).hosts.map((h) => h.vcenterId))], [VA]);
  assert.deepEqual(S.scopeSlice(snapS, SCOPED, new Set([VA, OUT])).vcenters.map((v) => v.id), [VA]);
  assert.equal(S.scopeSlice(snapS, ADMIN, new Set()).vms.length, 0, '빈 Set = 0건');
  assert.equal(S.scopeSlice(snapS, ADMIN, VC).hosts.length, 3, '글자는 예전 그대로');
  assert.equal(S.scopeSlice(snapS, ADMIN, undefined).hosts.length, HOSTS.length);
  // applyFilters — 범위 교집합이 먼저
  assert.deepEqual([...new Set(S.applyFilters(VMS, { vcenterIds: `${OUT},${VB}` }, snapS, ['name'], SCOPED).map((v) => v.vcenterId))], [VB]);
  assert.equal(S.applyFilters(VMS, { vcenterIds: OUT }, snapS, ['name'], SCOPED).length, 0);
});

test('⑤ /platform/summary — byVc 는 (범위 ∩ 리전) 전체 줄 · totals 는 고른 법인의 합(단일 · 복수)', async () => {
  user = ADMIN;
  const all = await get('/platform/summary');
  const rowsAll = all.byVc.map((r) => r.id).sort();
  const one = await get('/platform/summary', `vcenterId=${VB}`);
  assert.deepEqual(one.byVc.map((r) => r.id).sort(), rowsAll, '단일 vcenterId 도 byVc 는 전체 — 다른 칩 숫자가 사라지지 않는다');
  assert.deepEqual(one.byVc, all.byVc, '줄 내용도 고르지 않았을 때와 같다');
  assert.equal(one.totals.vcenters.total, 1); assert.equal(one.totals.hosts.total, 1); assert.equal(one.totals.vms.total, 2);
  const two = await get('/platform/summary', ids([VA, VC]));
  assert.deepEqual(two.byVc, all.byVc);
  assert.equal(two.totals.vcenters.total, 2); assert.equal(two.totals.hosts.total, 5); assert.equal(two.totals.vms.total, 2);
  assert.equal(all.totals.vcenters.total, 4); assert.equal(all.totals.vms.total, VMS.length);
  // 리전은 byVc 도 좁힌다 — 리전 밖 선택은 합에 들지 않는다
  const eu = await get('/platform/summary', `region=${encodeURIComponent('유럽')}&${ids([VA, VC])}`);
  assert.deepEqual(eu.byVc.map((r) => r.id).sort(), [VA, VB]);
  assert.equal(eu.totals.vcenters.total, 1, '리전 밖 VC 는 합에 없다'); assert.equal(eu.totals.hosts.total, 2);
  // 범위 계정 — byVc 는 범위 안 전체 · 범위 밖 단일은 0건
  user = SCOPED;
  const sc = await get('/platform/summary', `vcenterId=${VA}`);
  assert.deepEqual(sc.byVc.map((r) => r.id).sort(), [VA, VB]);
  assert.equal(sc.totals.vcenters.total, 1); assert.equal(sc.totals.vms.total, 1);
  user = ADMIN;
});

test('⑥ 캐시 — 목록만 바꿔도 다른 결과 · 범위 계정과 전체 계정은 같은 목록이어도 다른 결과(번갈아 불러도 섞이지 않는다)', async () => {
  store.snapshot = mkSnap();   // 같은 스냅샷 안에서(캐시 창) 번갈아 부른다
  user = ADMIN;
  const q1 = ids([VA, VB]); const q2 = ids([VA, VC]);
  for (let round = 0; round < 2; round++) {
    const a = await seen(q1); const b = await seen(q2);
    assert.equal(a.hostsTotal, 3); assert.equal(b.hostsTotal, 5);
    assert.deepEqual(a.byvc, [VA, VB]); assert.deepEqual(b.byvc, [VA, VC]);
    assert.equal(a.sumTotals.hosts.total, 3); assert.equal(b.sumTotals.hosts.total, 5);
  }
  const qx = ids([VA, OUT]);
  for (let round = 0; round < 2; round++) {
    user = ADMIN;
    const ad = await seen(qx);
    user = SCOPED;
    const sc = await seen(qx);
    assert.deepEqual(ad.hosts, [VA, OUT], `전체 계정 ${round}`); assert.equal(ad.vmsTotal, 5); assert.equal(ad.sumTotals.vcenters.total, 2);
    assert.deepEqual(sc.hosts, [VA], `범위 계정 ${round}`); assert.equal(sc.vmsTotal, 1); assert.equal(sc.sumTotals.vcenters.total, 1);
    assert.equal(sc.raw.includes(OUT), false, '전체 계정의 캐시가 범위 계정에 새지 않는다');
  }
  // 커서 지문 — 목록이 다르면 다른 목록이다(vmPaging VM_FILTER_KEYS)
  const { VM_FILTER_KEYS, vmFilterString } = await import('../src/inventory/vmPaging.js');
  assert.ok(VM_FILTER_KEYS.includes('vcenterIds'));
  assert.notEqual(vmFilterString({ vcenterIds: q1 }), vmFilterString({ vcenterIds: q2 }));
  assert.equal(vmFilterString({}), vmFilterString({ vcenterIds: '' }), '없으면 예전 지문 그대로');
  user = ADMIN;
});

test('⑦ 캐시 키 소스 계약 — 여섯 라우트의 memoJson extraKey 에 정규화한 고른 법인 목록(vcenterPickKey)이 들어 있다', async () => {
  // 지금은 memoJson 키에 URL 이 함께 들어가 목록을 빼도 결과는 같다(동치 변이 — 반증 검토 v3.20.0). 그래서 동작 대신 소스로 고정한다:
  //   URL 을 키에서 빼는 리팩터가 와도 '범위 · 고른 법인' 이 키에 남아 있어야 한다.
  const { stripComments } = await import('./_stripComments.js');
  const src = (f) => stripComments(fs.readFileSync(new URL(`../src/routes/api/${f}`, import.meta.url), 'utf8'));
  const n = (f) => (src(f).match(/extraKey: `\$\{scopeKey\(req\.user, store\.get\(\)\)\}\|\$\{vcenterPickKey\(req\.query, store\.get\(\)\)\}/g) || []).length;
  assert.equal(n('inventory.js'), 4, '/hosts · /vms · /vms/by-vcenter · /platform/summary');
  assert.equal(n('hostCorp.js'), 1, '/hosts/corp');
  assert.equal(n('hostChecks.js'), 1, '/hosts/checks');
});
