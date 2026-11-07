/**
 * v2.915 — '서버 › 가상화 플랫폼' 허브(설계 docs/design/virt-platform-menu 시안 A · 컨펌 2026-11-07 '시안 A · 표준 검증').
 *  ① 호스트 확인 대상 판정이 웹 hostTriage.hostReasons 와 같다(번들 경계라 두 벌 — 같은 입력으로 대조 · hostCorp2811 ① 과 같은 방식)
 *  ② 알람 '모름' 판정이 웹 restFallbackText.alarmsUnknown 과 같다 · 순수 집계 — 모르는 법인은 null · 템플릿 · 신호 · 합계
 *  ③ 실제 라우트 /platform/summary — 범위(다른 법인 이름도 없다 · 요청 필터로 넓힐 수 없다) · 권한(inv.hosts · inv.vms 없으면 그 칸 null) · region 으로 좁히기
 *  ④ 메뉴(topMenu · sideMenu) — 항목 하나가 세 탭을 맡고 옛 저장 항목(tab:hosts · tab:vms)은 별칭으로 이어진다 · '다시 넣기' 후보가 아니다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'platformhub2915-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VA = 'vc-a'; const VB = 'vc-b'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VA, name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: VB, name: 'vc-b', host: 'vcb.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: OUT, name: 'vc-out', host: 'vco.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
// operator 는 inv.vms 가 없다(호스트 칸만) · viewer 는 둘 다 있다 · guest 는 둘 다 없다
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
  operator: ['dashboard', 'inv.hosts'], viewer: ['dashboard', 'inv.hosts', 'inv.vms'], guest: ['dashboard'], toolsDenied: { operator: [], viewer: [], guest: [] } } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const P = await import('../src/inventory/platformSummary.js');
const SIG = await import('../src/inventory/vmSignals.js');
const { store, usageReadable } = await import('../src/store.js');
const W = await import('../../web/src/views/hostTriage.js');
const RF = await import('../../web/src/views/restFallbackText.js');
const TM = await import('../../web/src/views/topMenu.js');
const SM = await import('../../web/src/views/sidebar/sideMenu.js');
const PT = await import('../../web/src/views/platform/platformText.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { registerInventory } = await import('../src/routes/api/inventory.js');

const ctx = SIG.signalContext({ snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [], notify: { enabled: false, hour: 9 } }, NOW);
const host = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'CL1', connectionState: 'CONNECTED', cpuUsagePct: 10, memUsagePct: 20, cpuCores: 32, cpuMhz: 2500, memTotalMB: 262144, ...o });
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, cpuUsagePct: 10, memUsagePct: 10, toolsVersionStatus: 'guestToolsCurrent', snapshotCount: 0, ...o });

test('① 호스트 확인 대상 — 웹 hostTriage.hostReasons 와 같은 결과(점검 · 끊김/무응답 · CPU > 90 · 끊긴 호스트의 0 은 못 읽음)', () => {
  const cases = [
    host(VA, 'ok'), host(VA, 'maint', { connectionState: 'MAINTENANCE' }), host(VA, 'down', { connectionState: 'DISCONNECTED', cpuUsagePct: 0 }),
    host(VA, 'nr', { connectionState: 'NOT_RESPONDING', cpuUsagePct: 95 }), host(VA, 'hot', { cpuUsagePct: 90.01 }), host(VA, 'edge', { cpuUsagePct: 90 }),
    host(VA, 'over', { cpuUsagePct: 150 }), host(VA, 'na', { cpuUsagePct: null }), host(VA, 'str', { cpuUsagePct: '' }), host(VA, 'maint-hot', { connectionState: 'MAINTENANCE', cpuUsagePct: 99 }),
  ];
  for (const h of cases) {
    assert.deepEqual(P.hostReasonKinds(h, usageReadable), W.hostReasons(h).map((r) => r.kind), h.name);
  }
  const s = P.platformSummaryOf({ vcenters: [{ id: VA, name: 'a', status: 'connected' }], hosts: cases, vms: [], ctx, readable: usageReadable });
  const row = s.byVc[0];
  assert.equal(row.hosts.attention, W.triageCounts(cases).attention, '확인 대상 수 = 웹 카드 숫자');
  assert.deepEqual([row.hosts.maint, row.hosts.down, row.hosts.hot], [2, 2, 3]);
  assert.equal(row.hosts.unread, 2, "연결은 됐는데 못 읽은 호스트(null · '')는 '미수집' — 끊김과 따로");
  assert.equal(row.hosts.connected, 6, 'CONNECTED 상태만(점검 2 · 끊김/무응답 2 제외)');
});

test('② 순수 집계 — 알람 모름 판정은 웹과 같다 · 모르는 법인은 null · 템플릿 · 신호 · 합계는 아는 법인만', () => {
  const sites = [
    { id: VA, name: 'a', status: 'connected', metrics: { alarmsCritical: 2, alarmsWarning: 3 }, location: { region: '유럽' } },
    { id: VB, name: 'b', status: 'connected', collectSource: 'rest', restUnknown: ['alarms'], metrics: { alarmsCritical: 0, alarmsWarning: 0 }, collectMethod: 'rest' },
    { id: 'vc-p', name: 'p', status: 'pending' },
    { id: 'vc-s', name: 's', status: 'connected', stale: true, collectSource: 'site', metrics: { alarmsCritical: 1 } },
    { id: 'vc-m', name: 'm', status: 'unreachable', authStopped: true },
  ];
  for (const s of sites) assert.equal(P.alarmsUnknownOf(s), RF.alarmsUnknown(s), s.id);
  const hosts = [host(VA, 'h1', { cpuUsagePct: 95 }), host(VA, 'h2'), host(VB, 'b1', { cluster: 'CLB' }), host('vc-s', 's1')];
  const vms = [vm(VA, 'v1', { cpuUsagePct: 99 }), vm(VA, 'v2', { powerState: 'POWERED_OFF' }), vm(VA, 't', { template: true }), vm(VB, 'b', { cpuUsagePct: null }), vm('vc-s', 's', { toolsVersionStatus: 'guestToolsNeedUpgrade' })];
  const r = P.platformSummaryOf({ vcenters: sites, hosts, vms, ctx, readable: usageReadable, staleOf: () => false });
  assert.deepEqual(r.byVc.map((x) => x.id), [VA, VB, 'vc-m', 'vc-p', 'vc-s'], '이름순');
  const a = r.byVc.find((x) => x.id === VA);
  assert.deepEqual(a.alarms, { critical: 2, warning: 3, unknown: false });
  assert.deepEqual([a.hosts.total, a.hosts.attention, a.hosts.clusters], [2, 1, 1]);
  assert.deepEqual([a.vms.total, a.vms.on, a.vms.off, a.vms.templates], [3, 2, 1, 1], '템플릿은 개수에 들고 따로 센다(/vms totals 와 같은 기준)');
  assert.equal(a.vms.attention, SIG.signalCounts(vms.filter((v) => v.vcenterId === VA), ctx).any, '조치 필요 = vmSignals 그대로');
  const b = r.byVc.find((x) => x.id === VB);
  assert.deepEqual(b.alarms, { critical: null, warning: null, unknown: true }, 'REST 폴백은 알람 0 이 아니라 모름');
  assert.equal(b.rest, true);
  assert.equal(b.vms.usageUnknown, 1);
  const p = r.byVc.find((x) => x.id === 'vc-p');
  assert.equal(p.hosts.total, null, '첫 수집 중이며 받은 항목 0 → 모름(0대 금지)');
  assert.equal(p.vms.total, null);
  const st = r.byVc.find((x) => x.id === 'vc-s');
  assert.equal(st.stale, true); assert.equal(st.collect, 'site');
  const m = r.byVc.find((x) => x.id === 'vc-m');
  assert.equal(m.authStopped, true); assert.equal(m.hosts.total, null);
  // 합계
  assert.deepEqual(r.totals.vcenters, { total: 5, connected: 3, stale: 1, unreachable: 1, pending: 1, maintenance: 0, disabled: 0, authStopped: 1, rest: 1, site: 1 });
  assert.deepEqual(r.totals.alarms, { total: 6, critical: 3, warning: 3, unknownVcs: 1 }, '모르는 vCenter 는 합에 0 으로 들어가지 않고 따로 센다');
  assert.equal(r.totals.hosts.total, 4); assert.equal(r.totals.hosts.unknownVcs, 2); assert.equal(r.totals.hosts.attention, 1);
  assert.equal(r.totals.vms.total, 5); assert.equal(r.totals.vms.unknownVcs, 2);
  // 권한 없음(hosts · vms null) → 칸 전체가 null
  const n = P.platformSummaryOf({ vcenters: sites.slice(0, 1), hosts: null, vms: null, ctx, readable: usageReadable });
  assert.equal(n.byVc[0].hosts, null); assert.equal(n.byVc[0].vms, null); assert.equal(n.totals.hosts, null); assert.equal(n.totals.vms, null);
  // staleOf(엣지 push 낡음)도 낡은 값
  const s2 = P.platformSummaryOf({ vcenters: [sites[0]], hosts: [], vms: [], ctx, readable: usageReadable, staleOf: () => true });
  assert.equal(s2.byVc[0].stale, true);
});

test('③ 실제 라우트 /platform/summary — 범위 · 권한 칸 · region 좁히기 · 캐시가 섞이지 않는다', async () => {
  const prev = store.snapshot;
  // 법인 줄은 /vcenters 와 같은 롤업 사이트(metrics 가 여기 붙는다)에서 — 등록 목록(vcenters)에는 metrics 가 없다
  const regs = [
    { id: VA, name: 'vc-a', status: 'connected', location: { region: '유럽' } },
    { id: VB, name: 'vc-b', status: 'connected', location: { region: '아시아' } },
    { id: OUT, name: 'vc-out', status: 'connected', location: { region: '북미' } },
  ];
  const metricsOf = { [VA]: { alarmsCritical: 1, alarmsWarning: 0 }, [VB]: {}, [OUT]: { alarmsCritical: 9 } };
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), datastores: [],
    hosts: [host(VA, 'h1', { cpuUsagePct: 95 }), host(VA, 'h2'), host(VB, 'b1'), host(OUT, 'x1', { connectionState: 'MAINTENANCE' })],
    vms: [vm(VA, 'v1', { cpuUsagePct: 99 }), vm(VB, 'b1'), vm(OUT, 'x1', { cpuUsagePct: 99 })],
    vcenters: regs,
    rollups: { sites: regs.map((v) => ({ ...v, metrics: metricsOf[v.id] })) } };
  let user = { username: 'adm', role: 'admin' };
  const app = express();
  app.use(queryNormalizer());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerInventory(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const url = `http://127.0.0.1:${srv.address().port}/api/platform/summary`;
  const get = async (q = '') => { const r = await fetch(url + q); return { status: r.status, j: r.status === 200 ? await r.json() : null }; };

  let { status, j } = await get();
  assert.equal(status, 200);
  assert.deepEqual(j.byVc.map((x) => x.id), [VA, VB, OUT]);
  assert.equal(j.totals.vcenters.total, 3);
  assert.equal(j.totals.hosts.attention, 2, 'CPU 95 한 대 + 점검 한 대');
  assert.equal(j.totals.vms.attention, 2);
  assert.equal(j.totals.alarms.total, 10);
  ({ j } = await get('?region=' + encodeURIComponent('유럽')));
  assert.deepEqual(j.byVc.map((x) => x.id), [VA], 'region 으로 좁힌다');
  assert.equal(j.totals.hosts.total, 2);
  // 범위 계정 — 다른 법인은 이름도 없다 · 요청 vcenterId 로 넓힐 수 없다
  user = { username: 'v', role: 'viewer', scope: { vcenters: [VA] } };
  ({ j } = await get());
  assert.deepEqual(j.byVc.map((x) => x.id), [VA]);
  assert.equal(JSON.stringify(j).includes('vc-out'), false);
  ({ j } = await get('?vcenterId=' + OUT));
  assert.deepEqual(j.byVc, [], '범위 밖 vcenterId 는 비어 있다');
  // inv.vms 없는 역할 — VM 칸은 null(호스트 칸은 있다) · 캐시가 역할 사이에 섞이지 않는다(같은 URL)
  user = { username: 'op', role: 'operator' };
  ({ j } = await get());
  assert.equal(j.byVc.find((x) => x.id === VA).vms, null);
  assert.equal(j.totals.vms, null);
  assert.equal(j.byVc.find((x) => x.id === VA).hosts.attention, 1);
  user = { username: 'g', role: 'guest' };
  ({ j } = await get());
  assert.equal(j.byVc.find((x) => x.id === VA).hosts, null);
  assert.equal(j.totals.hosts, null);
  assert.equal(j.byVc.find((x) => x.id === VA).alarms.critical, 1, '알람(vCenter metrics)은 dashboard 만으로 본다 — /vcenters 와 같은 노출');
  user = { username: 'adm', role: 'admin' };
  ({ j } = await get());
  assert.equal(j.totals.vms.total, 3, '관리자로 돌아오면 전체 — 캐시 키에 권한이 있다');
});

test('④ 메뉴 — 항목 하나가 세 탭을 맡는다 · 옛 저장 항목은 별칭으로 잇는다 · 도구 also 는 세 탭 도구 전부', () => {
  const server = TM.MENU_GROUPS.find((g) => g.id === 'server');
  const virt = server.children.find((c) => c.id === 'virt');
  assert.equal(virt.label, PT.PLATFORM_MENU_LABEL);
  assert.deepEqual(TM.tabsOf(virt), [...PT.PLATFORM_TAB_KEYS]);
  assert.deepEqual(virt.also, [...PT.PLATFORM_TOOL_KEYS]);
  for (const t of PT.PLATFORM_TAB_KEYS) assert.deepEqual(TM.locate(t, `#/${t}`), { group: 'server', child: 'virt' }, t);
  assert.deepEqual(TM.locate('tools', '#/tools/host-hygiene'), { group: 'server', child: 'virt' });
  // 권한: inv.vms 만 있으면 보이고 그 탭으로 들어간다(entryTab) · 셋 다 없으면 항목이 빠진다
  let m = TM.visibleMenu({ tabOk: (t) => t === 'vms', toolOk: () => false });
  let it = m.find((g) => g.id === 'server').children.find((c) => c.id === 'virt');
  assert.equal(TM.hashOf(it), '#/vms');
  m = TM.visibleMenu({ tabOk: (t) => ['overview', 'alarms'].includes(t), toolOk: () => false });
  assert.equal(m.find((g) => g.id === 'server').children.some((c) => c.id === 'virt'), false);
  // 저장 메뉴 별칭 — v2.914 까지의 내 메뉴(가상화 서버 · ESXi 호스트 · vCenter 세 항목)가 한 항목으로 이어지고 unknown 이 아니다
  const mine = { v: 1, groups: [{ id: 'server', children: [{ tab: 'vms' }, { tab: 'hosts' }, { tab: 'vcenters' }, { tool: 'serveranalysis', seg: 'baremetal' }] }, { id: 'old', tab: 'hosts' }] };
  const r = SM.resolveMenu({ mine, catalog: [] });
  assert.equal(r.unknown, 0);
  assert.deepEqual(r.groups[0].children.map((c) => c.id), ['virt', 'bm']);
  assert.equal(r.groups.some((g) => g.id === 'old'), false, '단독으로 저장한 옛 탭은 같은 항목이라 한 번만');
  assert.equal(SM.missingDefaults(r.groups).some((d) => d.key === 'tab:hosts' || d.key === 'tab:vms'), false, "별칭은 '다시 넣기' 후보가 아니다");
  assert.deepEqual([...SM.itemAliases().entries()], [['tab:hosts', 'tab:vcenters'], ['tab:vms', 'tab:vcenters']]);
});
