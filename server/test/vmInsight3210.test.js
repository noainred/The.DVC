/**
 * v3.21.0 — VM 탭 '분석' 보기 집계 GET /api/vms/insight(설계 docs/design/vm-insight · 집계 inventory/vmInsight.js). 실제 라우터를 불러 호출한다.
 *  ① 법인별 줄의 합 = /vms totals(수 · 구동 · vCPU · 메모리 · 디스크 · 사용률 못 읽음 · 평균) · 조치 필요 = /vms signalCounts
 *  ② 템플릿 — total 에는 들고 Tools · 꺼진 VM(회수 후보) · CPU 상위에서는 빠진다
 *  ③ 못 읽은 사용률은 히스토그램 · 평균에서 빠지고 usageUnknown 으로(0 칸에 넣지 않는다)
 *  ④ 범위 계정 — 범위 밖 법인 줄 · 상위 목록이 없다 · vcenterIds 를 보내도 줄은 범위 전체(받지 않는다)
 *  ⑤ region 필터 — 그 리전 법인 줄만
 *  ⑥ 상위 N — CPU 큰 순 · 스냅샷 지난 일수 큰 순 · 크기 큰 순 · 법인마다 N(=5)
 *  ⑦ 캐시 키에 범위 — 같은 URL 이어도 범위 계정과 전체 계정이 다른 결과
 *  ⑧ 개수를 모르는 법인(연결 실패 · VM 0)은 수가 null(0대 아님) · 스냅샷 구간 · OS · 크기 칸
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmInsight3210-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VA = 'vc-a'; const VB = 'vc-b'; const VC = 'vc-c'; const DOWN = 'vc-down';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
// viewer 는 inv.vms 없음 — 403 게이트 확인용(admin 은 매트릭스와 무관하게 전 권한)
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard'], viewer: ['dashboard'], toolsDenied: { operator: [], viewer: [] } } }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VA, VB, VC, DOWN].map((id) => ({ id, name: id, host: `${id}.corp.local`, username: 'u', password: 'p', collectMode: 'site' })) }));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ }
  process.once('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 종료 중 */ } });
});

// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let atSeq = 0;
const nextAt = () => new Date(NOW + (atSeq++) * 60_000).toISOString();

const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { registerInventory } = await import('../src/routes/api/inventory.js');
const { vmInsightOf, oldestSnapshotName } = await import('../src/inventory/vmInsight.js');
const { signalContext } = await import('../src/inventory/vmSignals.js');

const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
// 스냅샷 생성일 — 기준 시각에서 d일 + 1시간 전(floor 경계에 걸리지 않게). 실제 판정은 요청 시각(Date.now())으로 하므로 1시간 여유를 둔다.
const ago = (d) => Date.now() - d * DAY - HOUR;
const VMS = [
  // A — 5대 + 템플릿 1 · 사용률 못 읽음 1 · 90%↑ 1 · 오래된 스냅샷 2
  vm(VA, 'a1', { cpuUsagePct: 95, memUsagePct: 50, cpuCount: 8, memMB: 16384 }),
  vm(VA, 'a2', { cpuUsagePct: null, memUsagePct: null }),                       // 사용률 못 읽음(구동)
  vm(VA, 'a3', { cpuUsagePct: 40, guestOS: 'Microsoft Windows Server 2019 (64-bit)', toolsVersionStatus: 'guestToolsNeedUpgrade' }),
  vm(VA, 'a4', { powerState: 'POWERED_OFF', cpuUsagePct: 0, memUsagePct: 0, storageGB: 300, snapshotCount: 2, snapshotSizeGB: 40, snapshotOldestTs: ago(100),
    snapshotTree: [{ d: 0, name: 'root-old', ts: ago(100) }, { d: 1, name: 'child', ts: ago(50) }] }),
  vm(VA, 'a5', { cpuUsagePct: 70, snapshotCount: 1, snapshotSizeGB: 90, snapshotOldestTs: ago(10) }),
  vm(VA, 'tpl', { template: true, powerState: 'POWERED_OFF', cpuUsagePct: 0, memUsagePct: 0, toolsVersionStatus: 'guestToolsNeedUpgrade', storageGB: 50 }),
  // B — 3대 · 고아 1 · 디스크 못 읽음 1
  vm(VB, 'b1', { cpuUsagePct: 60, connectionState: 'orphaned' }),
  vm(VB, 'b2', { cpuUsagePct: 5, storageGB: null }),
  vm(VB, 'b3', { cpuUsagePct: 80, guestOS: 'unknown', hwVersion: '' }),
  // C — 8대(상위 N=5 를 넘는다) · CPU 10 ~ 80
  ...[10, 20, 30, 40, 50, 60, 70, 80].map((c, i) => vm(VC, `c${i + 1}`, { cpuUsagePct: c, snapshotCount: 1, snapshotSizeGB: 10 * (i + 1), snapshotOldestTs: ago(8 + i * 5) })),
];
const REGS = [
  { id: VA, name: VA, status: 'connected', location: { region: '유럽', city: 'Warsaw', country: 'PL' } },
  { id: VB, name: VB, status: 'connected', location: { region: '유럽', city: 'Berlin', country: 'DE' } },
  { id: VC, name: VC, status: 'connected', location: { region: '아시아', city: 'Seoul', country: 'KR' } },
  { id: DOWN, name: DOWN, status: 'unreachable', location: { region: '북미' } },
];
const mkSnap = () => ({ source: 'live', generatedAt: nextAt(), datastores: [], networks: [], alarms: [], hosts: [], vms: VMS, vcenters: REGS });

const ADMIN = { username: 'adm', role: 'admin' };
const SCOPED = { username: 'sc', role: 'admin', scope: { vcenters: [VA, VB] } };
let user = ADMIN;
const prevSnap = store.snapshot;
store.snapshot = mkSnap();
closers.push(async () => { store.snapshot = prevSnap; });
const app = express();
app.use(queryNormalizer());
app.use((req, _res, next) => { req.user = user; next(); });
const router = express.Router(); registerInventory(router); app.use('/api', router);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
closers.push(() => new Promise((r) => srv.close(() => r())));
const BASE = `http://127.0.0.1:${srv.address().port}/api`;
async function get(p, q = '') {
  const r = await fetch(`${BASE}${p}${q ? `?${q}` : ''}`);
  assert.equal(r.status, 200, `${p}?${q}`);
  return r.json();
}
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
const rowOf = (j, id) => j.rows.find((r) => r.id === id);

test('① 법인별 줄의 합 = /vms totals · 조치 필요 = signalCounts', async () => {
  user = ADMIN;
  const ins = await get('/vms/insight');
  const all = await get('/vms', 'limit=5000&signals=1');
  const rows = ins.rows.filter((r) => !r.unknown);
  const t = all.totals;
  assert.equal(sum(rows, (r) => r.total), t.count);
  assert.equal(sum(rows, (r) => r.on), t.poweredOn);
  assert.equal(sum(rows, (r) => r.off), t.poweredOff);
  assert.equal(sum(rows, (r) => r.vcpu), t.vcpu);
  assert.equal(Math.round(sum(rows, (r) => r.memMB) / 1024), t.ramGB);
  assert.equal(sum(rows, (r) => r.diskGB), t.diskGB);
  assert.equal(sum(rows, (r) => r.diskUnknown), t.storageUnknown);
  assert.equal(sum(rows, (r) => r.usageUnknown.cpu), t.usageUnknown.cpu);
  assert.equal(sum(rows, (r) => r.usageUnknown.mem), t.usageUnknown.mem);
  const cpuS = sum(rows, (r) => r.cpuAvg.sum); const cpuN = sum(rows, (r) => r.cpuAvg.n);
  assert.equal(Math.round((cpuS / cpuN) * 10) / 10, t.avgCpuUsagePct, '합친 평균(합 ÷ 수) = /vms 평균 — 법인 평균의 평균이 아니다');
  for (const k of ['overload', 'usageUnknown', 'toolsOld', 'snapOld', 'any']) assert.equal(sum(rows, (r) => r.signals[k]), all.signalCounts[k], k);
  assert.equal(sum(rows, (r) => r.attention), all.signalCounts.any);
  assert.equal(ins.thresholds.snapAgeDays, all.signalCounts.snapAgeDays);
  assert.equal(ins.thresholds.topN, 5);
  assert.ok(ins.generatedAt);
});

test('② 템플릿 — total 에는 들고 Tools · 꺼진 VM · CPU 상위에서는 빠진다', async () => {
  user = ADMIN;
  const a = rowOf(await get('/vms/insight'), VA);
  assert.equal(a.total, 6); assert.equal(a.templates, 1); assert.equal(a.on, 4); assert.equal(a.off, 2);
  // Tools: 템플릿 제외 5대 — 업그레이드 필요는 a3 하나(템플릿의 NeedUpgrade 는 세지 않는다 · toolsOld 신호와 같다)
  const tv = a.tools.version;
  assert.equal(tv.current + tv.needUpgrade + tv.notInstalled + tv.unmanaged + tv.other + tv.unread, 5);
  assert.equal(tv.needUpgrade, 1);
  assert.equal(a.signals.toolsOld, 1);
  // 꺼진 VM(회수 후보) = a4 하나(템플릿 제외) · 디스크 300
  assert.equal(a.reclaim.offCount, 1);
  assert.equal(a.reclaim.offDiskGB, 300);
  // 크기 칸 합 = total(템플릿 포함)
  assert.equal(Object.values(a.vcpuSize).reduce((s, n) => s + n, 0), a.total);
  assert.equal(a.vcpuSize['8'], 1);
  assert.equal(a.memSize['16'], 1);
});

test('③ 못 읽은 사용률은 히스토그램 · 평균에서 빠지고 usageUnknown 으로', async () => {
  user = ADMIN;
  const a = rowOf(await get('/vms/insight'), VA);
  assert.deepEqual(a.usageUnknown, { cpu: 1, mem: 1 });
  assert.equal(a.cpuHist.length, 10);
  // 구동 4대 중 읽은 3대만 칸에 — 0 칸에 못 읽은 VM 을 넣지 않는다
  assert.equal(a.cpuHist.reduce((s, n) => s + n, 0), 3);
  assert.equal(a.cpuHist[0], 0);
  assert.equal(a.cpuHist[9], 1);           // 95%
  assert.equal(a.over90.cpu, 1);
  assert.equal(a.cpuAvg.n, 3);
  assert.equal(a.cpuAvg.value, Math.round(((95 + 40 + 70) / 3) * 10) / 10);
  assert.equal(a.signals.usageUnknown, 1);
  // 디스크 못 읽음은 합에서 빼고 센다
  const b = rowOf(await get('/vms/insight'), VB);
  assert.equal(b.diskUnknown, 1); assert.equal(b.diskGB, 200);
  assert.equal(b.connection.orphaned, 1); assert.equal(b.reclaim.orphan, 1);
  assert.equal(b.os.family.unknown, 1, "'unknown' OS 는 모름 — '기타' 가 아니다");
  assert.equal(b.hw.unread, 1);
});

test('④ 범위 계정 — 범위 밖 법인 줄 · 상위 목록이 없다 · vcenterIds 는 받지 않는다', async () => {
  user = SCOPED;
  const j = await get('/vms/insight');
  assert.deepEqual(j.rows.map((r) => r.id).sort(), [VA, VB]);
  assert.deepEqual(j.top.map((r) => r.id).sort(), [VA, VB]);
  for (const t of j.top) for (const k of ['cpuTop', 'snapOldest', 'snapBiggest']) for (const it of t[k]) assert.ok([VA, VB].includes(it.vcenterId));
  // 범위 밖 id 를 보내도 섞이지 않고 · 범위 안 하나를 골라도 줄은 범위 전체(화면이 더한다)
  const j2 = await get('/vms/insight', `vcenterIds=${VA},${VC}`);
  assert.deepEqual(j2.rows.map((r) => r.id).sort(), [VA, VB]);
  const j3 = await get('/vms/insight', `vcenterId=${VC}`);
  assert.deepEqual(j3.rows.map((r) => r.id).sort(), [VA, VB]);
  user = ADMIN;
});

test('⑤ region 필터 — 그 리전 법인 줄만', async () => {
  user = ADMIN;
  const j = await get('/vms/insight', `region=${encodeURIComponent('유럽')}`);
  assert.deepEqual(j.rows.map((r) => r.id).sort(), [VA, VB]);
  assert.equal(j.region, '유럽');
  const a = rowOf(j, VA);
  assert.equal(a.region, '유럽'); assert.equal(a.city, 'Warsaw'); assert.equal(a.country, 'PL');
  user = SCOPED;
  const k = await get('/vms/insight', `region=${encodeURIComponent('아시아')}`);
  assert.deepEqual(k.rows, [], '범위 밖 리전은 0곳(전체로 넓히지 않는다)');
  user = ADMIN;
});

test('⑥ 상위 N — CPU · 지난 일수 · 크기 큰 순 · 법인마다 5', async () => {
  user = ADMIN;
  const j = await get('/vms/insight');
  const c = j.top.find((t) => t.id === VC);
  assert.deepEqual(c.cpuTop.map((x) => x.cpu), [80, 70, 60, 50, 40]);
  assert.equal(c.cpuTop[0].name, 'c8');
  assert.equal(c.cpuTop[0].os, 'linux');
  assert.equal(c.cpuTop[0].vcpu, 2);
  // 스냅샷: c1 ~ c8 의 지난 일수 8 · 13 · … · 43 — 기준(7일)을 모두 넘는다
  assert.deepEqual(c.snapOldest.map((x) => x.days), [43, 38, 33, 28, 23]);
  assert.deepEqual(c.snapBiggest.map((x) => x.snapGB), [80, 70, 60, 50, 40]);
  const cr = rowOf(j, VC);
  assert.equal(cr.reclaim.snapOld, 8);
  assert.deepEqual(cr.reclaim.snapAge, { d7_30: 5, d30_90: 3, d90p: 0 });
  assert.equal(cr.reclaim.snapOldSnaps, 8);
  assert.equal(cr.reclaim.snapOldGB, 360);
  const a = j.top.find((t) => t.id === VA);
  assert.deepEqual(a.cpuTop.map((x) => x.name), ['a1', 'a5', 'a3'], '못 읽은 VM · 꺼진 VM · 템플릿은 CPU 상위에 없다');
  assert.equal(a.snapOldest[0].name, 'a4');
  assert.equal(a.snapOldest[0].oldestName, 'root-old');
  assert.equal(a.snapOldest[0].power, 'off');
  assert.equal(a.snapOldest[0].snapCount, 2);
  // 여러 법인을 고른 화면: 법인별 상위 5 를 합쳐 다시 5 를 고르면 전체 상위 5 와 같다
  const merged = j.top.flatMap((t) => t.cpuTop).sort((x, y) => y.cpu - x.cpu).slice(0, 5).map((x) => x.cpu);
  const direct = VMS.filter((v) => v.powerState === 'POWERED_ON' && !v.template && v.cpuUsagePct != null).map((v) => v.cpuUsagePct).sort((x, y) => y - x).slice(0, 5);
  assert.deepEqual(merged, direct);
});

test('⑦ 캐시 키에 범위 — 같은 URL 이어도 범위 계정과 전체 계정이 다른 결과', async () => {
  user = ADMIN;
  const x = await get('/vms/insight', 'probe=1');
  user = SCOPED;
  const y = await get('/vms/insight', 'probe=1');
  user = ADMIN;
  const z = await get('/vms/insight', 'probe=1');
  assert.ok(x.rows.some((r) => r.id === VC));
  assert.ok(!y.rows.some((r) => r.id === VC), '범위 계정이 전체 계정의 캐시를 받지 않는다');
  assert.deepEqual(z.rows.map((r) => r.id), x.rows.map((r) => r.id));
});

test('⑧ 개수를 모르는 법인은 null · OS 종류 · 권한', async () => {
  user = ADMIN;
  const j = await get('/vms/insight');
  const d = rowOf(j, DOWN);
  assert.equal(d.unknown, true);
  assert.equal(d.total, null); assert.equal(d.attention, null); assert.equal(d.cpuHist, null);
  assert.deepEqual(j.top.find((t) => t.id === DOWN).cpuTop, []);
  const a = rowOf(j, VA);
  assert.equal(a.unknown, false);
  assert.deepEqual(a.os.family, { linux: 5, windows: 1, other: 0, unknown: 0 });
  assert.deepEqual(a.os.kinds[0], { name: 'Ubuntu Linux (64-bit)', family: 'linux', count: 5 });
  assert.equal(a.os.kindsRest, 0);
  assert.equal(a.hw.versions['vmx-19'], 6);
  // 권한 — inv.vms 가 없으면 403(/vms 와 같은 게이트)
  user = { username: 'v', role: 'viewer', scope: null };
  const r = await fetch(`${BASE}/vms/insight`);
  const r2 = await fetch(`${BASE}/vms`);
  user = ADMIN;
  assert.equal(r.status, 403);
  assert.equal(r2.status, 403, '대조 — /vms 도 같은 권한으로 막힌다');
});

test('순수 — 기준 설정이 없으면 오래된 스냅샷을 판정하지 않는다 · 트리 없는 이름은 null · 같은 VM 목록 다른 순서도 같은 결과', async () => {
  const vms = VMS.filter((v) => v.vcenterId === VC);
  const none = await vmInsightOf({ vcenters: [REGS[2]], vms, ctx: signalContext(null, Date.now()) });
  assert.equal(none.rows[0].reclaim.snapOld, 0);
  assert.equal(none.thresholds.snapAgeDays, null);
  assert.deepEqual(none.top[0].snapOldest, []);
  assert.equal(oldestSnapshotName({ snapshotNames: ['x'] }), null);
  const ctx = signalContext({ snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [] }, Date.now());
  const r1 = await vmInsightOf({ vcenters: [REGS[2]], vms, ctx });
  const r2 = await vmInsightOf({ vcenters: [REGS[2]], vms: [...vms].reverse(), ctx });
  assert.deepEqual(r1.top, r2.top);
  assert.deepEqual(r1.rows[0].cpuHist, r2.rows[0].cpuHist);
  // 목록에 없는 vCenter 의 VM 은 그 id 줄(unlisted)로 — 합이 /vms 와 맞게
  const r3 = await vmInsightOf({ vcenters: [], vms, ctx });
  assert.equal(r3.rows.length, 1); assert.equal(r3.rows[0].unlisted, true); assert.equal(r3.rows[0].total, 8);
  const r4 = await vmInsightOf({ vcenters: [], vms, ctx, unlisted: false });
  assert.equal(r4.rows.length, 0);
});
