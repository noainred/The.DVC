/**
 * secResidual1127DemoLogs.test.js — 보안 잔여 11-27 G7(2026-11-08 감사 L7 · L8 · 설계 반증 must 4건).
 *
 *  L7  mock 모드 데모 계정(요청 문맥 role admin + demoGuest)이 **관리자 전용(adminOnly) 등록부 조회**에서 사람이 등록한 장비의
 *      BMC 주소 · 계정명 · 서비스태그 · 스캔 대역 · 메일 주소를 받던 것. adminOnly 라우트에는 operator 판본이 없으므로
 *      데모 판본은 '데모(mock-) 항목만'(화면 유지) 또는 READ_DENY(설정 · 자격 참조 · 실제 출력) 둘 중 하나다.
 *      반증 M-1: 절대형 요청 대상(GET http://x/api/…)과 겹친 슬래시(/api//tools/…)가 READ_DENY 를 비켜 갔다(실측) — 경로 정규화.
 *  L8  관리자 로그 뷰어(GET /api/admin/logs)가 콘솔 링버퍼를 가림 없이 내보내던 것 — 형제 출구(엣지 로그 · 로그 분석 표본)와 같은 가림.
 *
 * 일반 불변식(③-a): 실제 authMiddleware · requireEnrolled · 실제 라우터 스택의 **모든 GET** 에서
 *   · 민감 카나리(주소 · 계정명 · 서비스태그 · 비밀번호 · 메일 주소 · 설정 폴더 절대 경로): 데모 2xx ⊆ 같은 경로의 operator 응답
 *   · 이름 카나리(사람이 등록한 장비 · 엣지 · 법인 이름): 데모 2xx ⊆ operator 가 **어느 경로에서든** 받는 이름(이름은 operator 판본이 이미 싣는다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

process.env.CONFIG_DIR = tmpDir('sec1127g7-pure-');

/* ─────────────────────────── ① · ② 순수 판정 ─────────────────────────── */

const NEW_DENY = [
  '/api/admin/central/token-apply', '/api/admin/central/inventory', '/api/admin/central/ingest-stats',
  '/api/admin/ipam/scan', '/api/admin/ipam/settings', '/api/admin/ipam/changes', '/api/admin/ipam/report',
  '/api/admin/idrac/scan-result', '/api/admin/idrac/scan-agents', '/api/admin/idrac/scan-log', '/api/admin/idrac/scan-jobs', '/api/admin/idrac/scan-job-log',
  '/api/tools/server-info', '/api/tools/server-cmd',
  '/api/tools/bm-usage/ssh-keys', '/api/tools/bm-usage/accounts', '/api/tools/bm-usage/onboard/edge-rows',
  '/api/settings/ssh-access', '/api/tools/storage-usage/mail',
];

test('① L7 READ_DENY 추가분 — 데모 GET 거부(하위 경로 · 대소문자 · 끝 슬래시), 데모 판본 경로는 열림', async () => {
  const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
  for (const p of NEW_DENY) {
    for (const v of [p, `${p}/`, p.toUpperCase(), `${p}/sub/x`, `${p}?a=1`]) assert.ok(demoGuestDenial('GET', v), `GET ${v}`);
  }
  // 접두가 겹치는 이름은 막지 않는다(접두 비교는 세그먼트 경계)
  for (const p of ['/api/admin/idrac', '/api/admin/idrac/trend/table', '/api/admin/assignments', '/api/admin/room-temp', '/api/admin/idrac/scan-rangesx',
    '/api/tools/server-infox', '/api/tools/ipam', '/api/tools/bm-usage', '/api/tools/storage-usage', '/api/admin/idrac/parts-inventory'])
    assert.equal(demoGuestDenial('GET', p), null, p);
});

test('① M-1 경로 정규화 — 절대형 요청 대상 · 겹친 슬래시 · 해시가 READ_DENY · LIVE_GET_DENY 를 비켜 가지 않는다', async () => {
  const { demoGuestDenial, normApiPath } = await import('../src/auth/demoGuest.js');
  for (const u of ['http://x/api/admin/users', 'HTTP://X/API/ADMIN/USERS', 'https://u:p@evil:8/api/admin/logs', 'http:///api/admin/users',
    '/api//tools/server-info', '/api/admin//users', '//api/admin/users', '/api/admin/users#x', 'http://x/api/admin/users#/a',
    'http://x/api/tools//server-info?x=http://y/'])
    assert.ok(demoGuestDenial('GET', u), u);
  for (const u of ['http://x/api/admin/idrac/a/gpu-probe', '/api/admin//idrac/a/gpu-probe', '/api//tools/network-check', 'http://x/api/admin/idrac/a/inventory?refresh=1'])
    assert.ok(demoGuestDenial('GET', u), u);
  assert.equal(normApiPath('http://x/api/admin/idrac?a=http://y/b'), '/api/admin/idrac');
  assert.equal(normApiPath('/API//Admin///idrac/'), '/api/admin/idrac');
  // 쓰기도 같은 정규화(SAFE_ACTIONS 판정이 절대형에서 빗나가 거부되던 것은 거부 쪽이라 안전했지만 판정은 하나로)
  assert.equal(demoGuestDenial('POST', 'http://x/api/tools/storage/collect-all'), null);
  assert.ok(demoGuestDenial('POST', 'http://x/api/admin/users'));
  // 정상 경로는 그대로
  assert.equal(demoGuestDenial('GET', '/api/tools/storage'), null);
  assert.equal(demoGuestDenial('GET', 'http://x/api/tools/storage'), null);
});

test('② L7 demoRegistryView — 데모 + /api/admin 만(데모 판정 isDemoGuest · 경로 정규화 공유)', async () => {
  const { demoRegistryView, isAdminApiPath } = await import('../src/auth/demoGuest.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const adm = { username: 'a', role: 'admin' };
  const op = { username: 'o', role: 'operator' };
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/api/admin/idrac' }), true);
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/API/admin/idrac/trend/table?hours=24' }), true);
  assert.equal(demoRegistryView({ user: demo, originalUrl: 'http://x/api/admin/idrac' }), true, '절대형도 데모 판본(fail-open 금지)');
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/api//admin/idrac' }), true);
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/api/overview/cards' }), false, 'non-admin 라우트는 operator 판본 그대로');
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/api/tools/disk-bad' }), false);
  assert.equal(demoRegistryView({ user: demo, originalUrl: '/api/adminx' }), false);
  assert.equal(demoRegistryView({ user: adm, originalUrl: '/api/admin/idrac' }), false, '전체 관리자');
  assert.equal(demoRegistryView({ user: op, originalUrl: '/api/admin/idrac' }), false, 'operator 는 데모 판본이 아니다(S-1)');
  assert.equal(demoRegistryView({ user: { role: 'viewer' }, originalUrl: '/api/admin/usage' }), false);
  assert.equal(demoRegistryView({ originalUrl: '/api/admin/idrac' }), false, 'user 없음');
  assert.equal(demoRegistryView({ user: demo }), false, 'originalUrl 없음(라우터 밖 직접 호출)');
  assert.equal(demoRegistryView(null), false);
  assert.equal(demoRegistryView({ user: { username: 'anonymous', role: 'admin' }, originalUrl: '/api/admin/idrac' }), false, '인증 꺼짐 익명(role admin)');
  assert.equal(isAdminApiPath('/api/admin'), true);
  assert.equal(isAdminApiPath('/api/administrator'), false);
});

test('② L7 isDemoIdracServer — 로컬은 id, 원격은 보고한 엣지(collectorId)가 데모여야 한다(판정 실패 = 데모 아님)', async () => {
  const { isDemoIdracServer } = await import('../src/routes/admin/idracCore.js');
  assert.equal(isDemoIdracServer({ id: 'mock-demo-1' }), true);
  assert.equal(isDemoIdracServer({ id: 'MOCK-x' }), true);
  assert.equal(isDemoIdracServer({ id: 'idrac-real' }), false);
  assert.equal(isDemoIdracServer({ id: 'mock-evil', remote: true, collectorId: 'edge-real' }), false, '사람 엣지가 mock- id 를 보고해도 데모가 아니다');
  assert.equal(isDemoIdracServer({ id: 'r-1', remote: true, collectorId: 'mock-Edge-Seoul' }), false, '데모 엣지라도 id 가 데모가 아니면 아니다');
  assert.equal(isDemoIdracServer({ id: 'mock-edgeidrac-1', remote: true, collectorId: 'mock-Edge-Seoul' }), true);
  for (const bad of [null, undefined, 'mock-x', 3, { get id() { throw new Error('x'); } }]) assert.equal(isDemoIdracServer(bad), false);
});

test('② L7 idracInScope · 판본 표지 — 데모 판본은 데모 서버만, 범위가 지정된 데모 계정은 범위도 함께(반증 S-2) · 판본 서명은 서로 다르다', async () => {
  const { idracInScope, idracScopedAccount, scopeFieldsOf } = await import('../src/routes/admin/idracCore.js');
  const full = { demoOnly: true, scoped: null, allowed: new Set(['vc-a', 'vc-b']), tagMap: new Map(), index: null };
  assert.equal(idracInScope(full, { id: 'mock-1' }), true, '귀속 없는 데모 서버도 전체 범위 데모에게 보인다');
  assert.equal(idracInScope(full, { id: 'real-1', vcenterId: 'vc-a' }), false, '귀속된 사람 서버라도 데모 판본에서는 뺀다');
  const scoped = { demoOnly: true, scoped: new Set(['vc-a']), allowed: new Set(['vc-a']), tagMap: new Map(), index: null };
  assert.equal(idracInScope(scoped, { id: 'mock-1', vcenterId: 'vc-a' }), true);
  assert.equal(idracInScope(scoped, { id: 'mock-2', vcenterId: 'vc-b' }), false, '범위 밖 데모 서버');
  assert.equal(idracInScope(scoped, { id: 'mock-3' }), false, '범위 데모 계정 — 귀속 없음 미노출');
  assert.equal(idracInScope(scoped, { id: 'real', vcenterId: 'vc-a' }), false);
  assert.equal(idracScopedAccount(null), false);
  assert.equal(idracScopedAccount(full), false, '전체 범위 데모는 범위 계정이 아니다(반증 M-3)');
  assert.equal(idracScopedAccount(scoped), true);
  assert.equal(idracScopedAccount({ allowed: new Set(['vc-a']) }), true);
  assert.deepEqual(scopeFieldsOf(full, 0), {});
  assert.deepEqual(scopeFieldsOf(full, 2), { scoped: true, demoOnly: true, omittedOutOfScope: 2 });
  assert.deepEqual(scopeFieldsOf(scoped, 0), { scoped: true, omittedOutOfScope: 0, demoOnly: true });
  assert.deepEqual(scopeFieldsOf({ allowed: new Set() }, 0), { scoped: true, omittedOutOfScope: 0 });
  assert.deepEqual(scopeFieldsOf(null, 5), {});
  const { idracViewSig } = await import('../src/routes/admin/idracCore.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const sigDemo = idracViewSig({ user: demo, originalUrl: '/api/admin/idrac/parts-inventory' });
  const sigAdm = idracViewSig({ user: { username: 'a', role: 'admin' }, originalUrl: '/api/admin/idrac/parts-inventory' });
  const sigDemoNonAdmin = idracViewSig({ user: demo, originalUrl: '/api/overview/cards' });
  assert.match(sigDemo, /^demo\|/);
  assert.notEqual(sigDemo, sigAdm, '데모 판본과 관리자 판본은 다른 캐시 열쇠');
  assert.equal(sigDemoNonAdmin, sigAdm, 'non-admin 경로의 데모는 operator 판본(범위 판정 무변경)');
});

/* ─────────────────────────── ③ 실 라우터 하네스 ─────────────────────────── */

const SENS_SRC = String.raw`10\.66\.\d{1,3}\.\d{1,3}|\b[a-z]{2,9}userq\d?\b|\bqtag\d{3}\b|pw-[a-z]{2}-qq|qmail\d@corpq\.example`;
const NAME_SRC = String.raw`\b[a-z0-9]{2,12}-realq\b`;

function harnessScript(phase) {
  return `
    const fs = await import('node:fs');
    const net = await import('node:net');
    // 데모 베어메탈 스토리지 서버(mock- id — 등록 API 는 id 를 만든다) — 등록부 모듈이 읽기 전에 파일로 둔다
    fs.writeFileSync(process.env.CONFIG_DIR + '/bm-storage.json', JSON.stringify({ servers: [{ id: 'mock-bm-t1', name: 'mockbm-01', host: '192.0.2.66', port: 22, username: 'root', password: 'mock', os: 'linux', mounts: ['/data'], enabled: true }], settings: {} }));
    // 반증 3회차 후속: 데모 스토리지 장비(mock- id — saveDevice 는 id 를 만든다) — 노드 클라이언트 등 데모 전용 단건(demoGuard)을 데모가 열 수 있게
    fs.writeFileSync(process.env.CONFIG_DIR + '/storage-devices.json', JSON.stringify({ version: 1, devices: [{ id: 'mock-st-t1', type: 'unity480', name: 'mockst-01', host: '192.0.2.67', username: 'admin', password: 'mock', agent: '', datacenterId: '', collectMethod: 'api', enabled: true, note: '데모(mock) 장비' }] }));
    const express = (await import('express')).default;
    const auth = await import(${J('auth/auth.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh();
    const snap = store.get();
    const vcs = (snap.vcenters || []).map((v) => String(v.id));
    const host0 = (snap.hosts || []).find((h) => h.serviceTag && h.vcenterId) || null;
    const seeds = {};
    const seedIds = {};   // 반증 1회차 S-1: 단건 GET(:id)을 시드한 항목 id 로도 부른다
    const tryi = async (k, f) => { try { const r = await f(); seeds[k] = r && r.ok === false ? 'FAIL ' + JSON.stringify(r).slice(0, 200) : 'ok';
      const id = [r && r.id, r && r.device && r.device.id, r && r.server && r.server.id, r && r.target && r.target.id, r && r.director && r.director.id].find((x) => typeof x === 'string' && x);
      if (id && !seedIds[k]) seedIds[k] = id; } catch (e) { seeds[k] = 'ERR ' + e.message; } };
    // ── 데모 항목(mock-) — 두 단계 공통
    const DS = await import(${J('datacenter/store.js')});
    await tryi('dDcA', async () => DS.addDatacenter({ id: 'dc-mocka', name: 'mocka' }));
    await tryi('dDcAssign', async () => DS.setVcenterDatacenter(vcs[0], 'dc-mocka'));
    await tryi('dDcSolo', async () => DS.addDatacenter({ id: 'dc-mocksolo', name: 'mocksolo' }));   // vCenter · 서버가 없는 법인(선택 목록 대조용)
    await tryi('dIdrac', async () => (await import(${J('idrac/registry.js')})).addServer({ id: 'mock-demo-1', name: 'mockdemo-01', host: 'mock-demo-1.demo.invalid', username: 'root', password: 'mock', serviceTag: host0 ? host0.serviceTag : 'MOCKD01', vcenterId: host0 ? host0.vcenterId : (vcs[0] || '') }));
    await tryi('dIdracApp', async () => (await import(${J('idrac/registry.js')})).addServer({ id: 'mock-demo-app', name: 'mockdemo-app', host: 'mock-demo-app.demo.invalid', username: 'root', password: 'mock', serviceTag: 'MOCKAPP1' }));
    const RI = await import(${J('collector/remoteInventory.js')});
    const remoteDemo = [{ id: 'mock-rdemo-1', name: 'mockrdemo-01', host: 'https://mock-rdemo.demo.invalid', serviceTag: 'MOCKRD01', type: 'idrac', vendor: 'dell', vcenterId: '', datacenterId: '' }];
    await tryi('dRemote', async () => RI.setCollectorServers('mock-Edge-Seoul', 'Seoul', remoteDemo));
    await tryi('dColStatus', async () => (await import(${J('collector/state.js')})).setCollectorStatus('mock-Edge-Seoul', { ok: false, error: 'mock pull 실패(데모)', fails: 1 }));
    const AS = await import(${J('central/assignments.js')});
    await tryi('dAssign', async () => AS.addAssignment({ agent: 'mock-Edge-Seoul', ips: '192.0.2.0/24', username: 'root', password: 'mock', enabled: true }));
    await tryi('dAssignRes', async () => AS.setResult('mock-Edge-Seoul', { scanned: 254, foundCount: 1, found: [{ ip: '192.0.2.20', serviceTag: 'MOCK100001', model: 'PowerEdge R750' }] }));
    const US = await import(${J('central/unsupportedServers.js')});
    await tryi('dUnsup', async () => US.saveUnsupportedServers({ agent: '', datacenterId: '', service: 'scan-demo', trigger: 'demo' }, [{ ip: '192.0.2.77', vendor: 'hpe', vendorLabel: 'HPE', manufacturer: 'HPE', product: 'iLO 5', model: 'DL380' }]));
    const PG = await import(${J('gpu/physicalRegistry.js')});
    await tryi('dGpu', async () => PG.addPhysical({ id: 'mock-pgpu-1', name: 'mockpgpu-01', host: '192.0.2.88', username: 'root', password: 'mock', vcenterId: vcs[0] || '', gpuModels: ['NVIDIA A100'] }));
    // 반증 3회차 후속: 리소스 적정성(capacity — adminOnly) — 포탈 자신(local) · 데모 엣지(mock-Edge-Seoul). 두 단계 공통(사람 엣지가 없으면 관리자와 같은 응답 — M-3)
    const CAPM = (await import(${J('capacity/collectors.js')})).collectorMeta().slice(0, 3).map((m) => m.key);
    const capRows = CAPM.map((metric, i) => ({ metric, v: 10 + i }));
    const CD = await (await import(${J('capacity/db.js')})).getCapacityDb();
    await tryi('dCapacity', async () => { const ts = Date.now() - 60_000;
      CD.insertSnapshot('local', capRows, ts, { hostname: 'mockportal', platform: 'linux', cores: 8, totalMemMB: 16384, role: 'central' });
      CD.insertSnapshot('mock-Edge-Seoul', capRows, ts, { hostname: 'mockedge-seoul', platform: 'linux', cores: 4, totalMemMB: 8192, role: 'edge' }); return { ok: true }; });
    ${phase === 'full' ? `
    // ── 사람이 등록한 항목(카나리) — full 단계만
    const IR = await import(${J('idrac/registry.js')});
    await tryi('idrac', async () => IR.addServer({ id: 'idrac-realq', name: 'idrac-realq', host: '10.66.1.11', username: 'idracuserQ', password: 'pw-ID-qq', serviceTag: 'QTAG001', vcenterId: vcs[0] || '' }));
    await tryi('idracIp', async () => IR.addServer({ id: '10.66.1.12', name: 'idrac2-realq', host: '10.66.1.12', username: 'idracuserQ2', password: 'pw-ID-qq', serviceTag: 'QTAG003' }));
    await tryi('assign', async () => AS.addAssignment({ agent: 'edge-realq', ips: '10.66.2.0/24', username: 'asguserQ', password: 'pw-AS-qq' }));
    await tryi('assignRes', async () => AS.setResult('edge-realq', { scanned: 254, foundCount: 1, found: [{ ip: '10.66.2.21', serviceTag: 'QTAG004', model: 'PowerEdge R750' }] }));
    await tryi('collector', async () => (await import(${J('collector/registry.js')})).addCollector({ id: 'edge-realq', name: 'edge-realq', url: 'https://10.66.3.33:4000', token: 'tokQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ' }, { managed: true }));
    // 데모(mock-) id 인데 이름은 사람이 붙인 수집 서버 — 데모 판본의 에이전트 이름 목록에 사람 이름이 실리지 않아야 한다
    await tryi('rogueCollector', async () => (await import(${J('collector/registry.js')})).addCollector({ id: 'mock-rogue', name: 'rogue-realq', url: 'https://mock-rogue.demo.invalid:4000', token: 'tokRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR' }, { managed: true }));
    await tryi('remote', async () => RI.setCollectorServers('edge-realq', 'dc-realq', [{ id: 'mock-evil', name: 'rmt-realq', host: 'https://10.66.20.20', serviceTag: 'QTAG002', type: 'idrac', vendor: 'dell', vcenterId: vcs[0] || '', datacenterId: '' }]));
    await tryi('inventory', async () => (await import(${J('central/inventory.js')})).setInventory('vc-realq', { vcenter: { id: 'vc-realq', name: 'vc-realq', host: '10.66.9.99' }, hosts: [], vms: [] }, 'edge-realq', null));
    await tryi('scanRange', async () => (await import(${J('idrac/scanRanges.js')})).saveScanRanges({ datacenterId: 'dc-realq', ranges: ['10.66.4.0/24'], username: 'scanuserQ', password: 'pw-SC-qq', agent: 'edge-realq' }));
    await tryi('ipamScan', async () => (await import(${J('ipam/scanStore.js')})).saveScanSettings('edge-realq', { ranges: ['10.66.5.0/24'], enabled: true }));
    await tryi('gpuPhys', async () => PG.addPhysical({ id: 'pgpu-realq', name: 'pgpu-realq', host: '10.66.6.66', username: 'gpuuserQ', password: 'pw-GP-qq', vcenterId: vcs[0] || '', gpuModels: ['NVIDIA H100'] }));
    await tryi('unsup', async () => US.saveUnsupportedServers({ agent: 'edge-realq', datacenterId: '', service: 'scan-realq', trigger: 'manual' }, [{ ip: '10.66.21.21', vendor: 'hpe', vendorLabel: 'HPE', manufacturer: 'HPE', product: 'iLO 6', model: 'DL360' }]));
    await tryi('pdu', async () => (await import(${J('pdu/registry.js')})).saveDevice({ name: 'pdu-realq', host: '10.66.7.77', username: 'pduuserQ', password: 'pw-PD-qq', type: 'apc' }));
    await tryi('horizon', async () => (await import(${J('horizon/horizon.js')})).upsertHorizon({ id: 'hz-realq', name: 'hz-realq', host: '10.66.8.88', username: 'hzuserQ', password: 'pw-HZ-qq', domain: 'corpq' }));
    await tryi('storage', async () => (await import(${J('storage/registry.js')})).saveDevice({ type: 'unity480', name: 'st-realq', host: '10.66.10.11', username: 'stuserQ', password: 'pw-ST-qq', collectMethod: 'ssh' }));
    await tryi('san', async () => (await import(${J('sanswitch/registry.js')})).saveDevice({ type: 'brocade', name: 'san-realq', host: '10.66.11.22', username: 'sanuserQ', password: 'pw-SA-qq' }));
    await tryi('cvp', async () => (await import(${J('cvp/registry.js')})).saveServer({ name: 'cvp-realq', host: '10.66.12.44', username: 'cvpuserQ', password: 'pw-CV-qq', authMode: 'password' }));
    await tryi('bmstor', async () => (await import(${J('bmstor/registry.js')})).saveBmServer({ name: 'bm-realq', host: '10.66.13.66', username: 'bmuserQ', password: 'pw-BM-qq', os: 'linux', mounts: ['/data'] }));
    await tryi('focus', async () => (await import(${J('focusmon/registry.js')})).addTarget({ name: 'fm-realq', host: '10.66.14.14', username: 'fmuserQ', password: 'pw-FM-qq', os: 'linux' }, { agents: [], by: 'x', corps: [] }));
    await tryi('bareos', async () => (await import(${J('bareos/settings.js')})).addDirector({ name: 'bd-realq', host: '10.66.16.16', consoleName: 'bdconsoleuserQ', password: 'pw-BD-qq' }));
    await tryi('ping', async () => (await import(${J('ping/store.js')})).addTarget({ name: 'pg-realq', host: '10.66.18.18' }));
    // 반증 3회차 must 2: SMTP 보내는 주소(smtp.from)도 시드 — 예전에는 받는 사람만 시드해 /tools/guest-partition/mail 의 from 을 놓쳤다.
    await tryi('mail', async () => (await import(${J('mail/settings.js')})).save({ defaultTo: ['qmail1@corpq.example'], smtp: { host: '10.66.50.50', port: 25, from: 'qmail3@corpq.example' } }));
    await tryi('bmHist', async () => {
      const BR = await import(${J('bmstor/registry.js')});
      const human = BR.listBmServers().find((x) => x.name === 'bm-realq');
      const H = await import(${J('bmstor/history.js')});
      const slot = H.slotOf(Date.now()) - 1;
      const row = (kind, key, name) => ({ kind, key, name, totalBytes: 1e12, usedBytes: 5e11, availBytes: 5e11, servers: 1, read: 1 });
      return (await import(${J('bmstor/historyDb.js')})).commitBmHistory({ slot, ts: Date.now() - 3600e3, rows: [row('server', human.id, 'bm-realq'), row('server', 'mock-bm-t1', 'mockbm-01'), row('group', 'grp-realq', 'grp-realq'), row('total', '', '전체 합계')] });
    });
    await tryi('usageMail', async () => (await import(${J('storage/usageMail.js')})).saveUsageMailSettings({ enabled: false, to: ['qmail2@corpq.example'] }));
    // 반증 1회차 M-1 · S-1: 예전 하네스가 시드하지 않던 등록부 — Veeam B&R(+ 실행 기록 · 포탈 백업 VM 기록, 요청한 포탈 계정 runuserq) ·
    //   Monitoring(svcmon) 대상 · Bareos 상태 설정(저장한 포탈 계정 savuserq — S-2). 계정 이름은 민감 카나리 꼴(…userq)이라 ⊆ 불변식이 잡는다.
    await tryi('veeam', async () => { const d = (await import(${J('veeam/registry.js')})).saveServer({ name: 'vbr-realq', host: '10.66.30.30', username: 'vbruserQ', password: 'pw-VB-qq', agent: 'edge-realq', vcenterIds: [vcs[0]] }); seedIds.veeam = d.id; return d; });
    await tryi('veeamRun', async () => {
      const RR = await import(${J('veeam/run/runs.js')});
      const vm0 = (snap.vms || []).find((v) => v.vcenterId === vcs[0] && v.template !== true && !/^vcls/i.test(String(v.name || '')));
      const sid = seedIds.veeam;
      const plan = { groups: [{ serverId: sid, serverName: 'vbr-realq', kind: 'quick', vcenterId: '', refs: [{ name: vm0.name, objectId: 'vm-q1' }] }],
        vms: [{ vmId: vm0.id, name: vm0.name, vcenterId: vcs[0], objectId: 'vm-q1', hostName: '', serverId: sid, serverName: 'vbr-realq', how: 'quick' }] };
      const run = RR.startRun(plan, { user: 'runuserq' });
      seedIds.veeamRun = run.id; seedIds.veeamVm = vm0.id;
      const ok = (await import(${J('veeam/run/portalVms.js')})).notePortalRun(RR.getRun(run.id));
      return ok ? { ok: true } : { ok: false, why: 'notePortalRun false' };
    });
    await tryi('svcmon', async () => {
      const SM = await import(${J('svcmon/store.js')});
      const t = SM.addTarget({ name: 'svc-realq', kind: 'infra', path: 'Q', host: '10.66.31.31' });
      seedIds.svcmon = t.id;
      SM.addTest(t.id, { type: 'tcp', name: 'tcp-q', port: 443 });
      SM.flushStore();
    });
    await tryi('bareosHealth', async () => (await import(${J('bareos/health.js')})).saveHealthCfg({}, { by: 'savuserq' }));
    // S-2: 관리자 전용 도구의 실행 · 작업 기록에 남는 포탈 계정(사람 관리자가 데모 VM · 데모 그룹으로 돌린 것) — 데모 계정에 싣지 않는다
    await tryi('vmcloneOp', async () => (await import(${J('vmclone/store.js')})).recordOp({ kind: 'run', jobId: 'job-q', vcenterId: vcs[0], vmName: 'x', by: 'opuserq', ok: true, at: Date.now() }));
    await tryi('bareosGroup', async () => {
      const vm1 = (snap.vms || []).find((v) => v.vcenterId === vcs[0] && v.template !== true);
      return (await import(${J('bareos/groups.js')})).addGroup({ name: 'grp-q', vcenterId: vcs[0], vmIds: [vm1.id], schedule: { enabled: false, time: '02:00' } }, { by: 'grpuserq' });
    });
    // 반증 2회차: 하네스가 시드하지 않던 등록부 8개(반증 하네스 그대로) — 시드가 없는 등록부는 ③-a 에서 통과로 보인다(S-1 교훈).
    //   M-1 프로비저닝 저장 작업(작성 계정 prvuserq · 정적 IP 계획) · S-1 Bareos 백업 대상(사람 Director — client · createdBy, 데모 대상 — createdBy).
    await tryi('xEm', async () => (await import(${J('veeam/em/registry.js')})).saveEm({ name: 'em-realq', host: '10.66.40.40', username: 'emuserQ', password: 'pw-EM-qq' }));
    await tryi('xNsx', async () => (await import(${J('nsx/registry.js')})).addManager({ id: 'nsx-realq', name: 'nsx-realq', host: 'https://10.66.41.41', username: 'nsxuserQ', password: 'pw-NS-qq', vcenterId: vcs[0] || '' }));
    await tryi('xIsidu', async () => { const FC = await import(${J('cvp/formChoices.js')}); const IS = await import(${J('isidu/settings.js')});
      return IS.saveSettings({ targets: [{ id: 'tisiq', label: 'isi-realq', path: '/ifs/data/q', host: '10.66.42.42', username: 'isiuserQ', agent: '', datacenterId: '' }] }, { devices: [], agents: [], dcs: [], pickAgent: FC.pickAgent, pickDatacenter: FC.pickDatacenter, ssrfBlockReason: () => null }); });
    await tryi('xRelay', async () => { (await import(${J('relaytopo/store.js')})).saveTopology({ main: { name: 'Main', privateIp: '10.66.43.1' }, sites: [{ dc: 'dc-realq', edge: { privateIp: '10.66.43.2', ssh: { username: 'rlyuserQ', password: 'pw-RL-qq' } }, irs: { privateIp: '10.66.43.3' }, note: 'n 10.66.43.9' }] }); return { ok: true }; });
    await tryi('xDeploy', async () => (await import(${J('agent/deployRegistry.js')})).saveTarget({ host: '10.66.44.44', username: 'dpluserQ', password: 'pw-DP-qq', name: 'dpl-realq' }));
    await tryi('xProv', async () => { const vmx = (snap.vms || []).find((v) => v.vcenterId === vcs[0]); return (await import(${J('provision/saved.js')})).addSaved({ spec: { vcenterId: vcs[0], namePattern: 'prv-realq-{n}', count: 1, guest: { ipMode: 'static', ipList: ['10.66.45.45'], gateway: '10.66.45.1', domain: 'corpq.example', dnsServers: ['10.66.45.2'] } }, source: { id: vmx && vmx.id, name: vmx && vmx.name, vcenterId: vcs[0] }, user: { username: 'prvuserq' }, memo: '' }); });
    await tryi('xBareosJob', async () => { const ST = await import(${J('bareos/settings.js')}); const d = ST.loadSettings().directors.find((x) => x.name === 'bd-realq'); const vmz = (snap.vms || []).filter((v) => v.vcenterId === vcs[0])[2];
      ST.saveSettings({ sites: [{ vcenterId: vcs[0], directorId: d.id, client: 'cl-realq-fd', storage: 'File', pool: 'Full' }] });   // 법인 매핑(진행 현황은 매핑된 법인마다 행을 만든다)
      const BR = await import(${J('bareos/registry.js')});
      const j = BR.addJob({ vcenterId: vcs[0], vmId: vmz.id, vmName: vmz.name, dc: '', folder: '', directorId: d.id, bareosJob: 'bj-realq', client: 'cl-realq-fd', storage: 'File', pool: 'Full', schedule: 'Daily', level: 'Incremental', createdBy: 'bjbyuserq', demo: false });
      BR.markPending(j.id, { jobid: 777, level: 'I', by: 'pendbyuserq' });   // 진행 현황(live)의 실행 행에 실리게(Client · Pool · Storage)
      return j; });
    await tryi('xBareosDemoJob', async () => { const vmz = (snap.vms || []).filter((v) => v.vcenterId === vcs[0])[3];
      const j = (await import(${J('bareos/registry.js')})).addJob({ vcenterId: vcs[0], vmId: vmz.id, vmName: vmz.name, dc: '', folder: '', directorId: 'mock-bareos-dir', bareosJob: 'bj-mockdemo', client: 'mockdemo-fd', storage: 'File', pool: 'Full', schedule: 'Daily', level: 'Incremental', createdBy: 'bjdemouserq', demo: true });
      seedIds.bareosDemoJob = j.id; return j; });
    await tryi('xFocusBy', async () => (await import(${J('focusmon/registry.js')})).addTarget({ name: 'fm2-realq', host: '10.66.46.46', username: 'fm2userQ', password: 'pw-FN-qq', os: 'linux' }, { agents: [], by: 'fmbyuserq', corps: [] }));
    // 반증 3회차 후속(필수 질의 표): 표가 실제 키로 부를 수 있게 시드 — 사람 항목은 카나리 꼴(…-realq · …userq · 10.66.x · qmail@corpq).
    //   리소스 적정성(capacity) — 사람 엣지(edge-realq, 보고한 호스트 이름 edgehost-realq · 엣지 push 와 같은 적재 경로)
    await tryi('xCapacity', async () => { CD.insertSnapshot('edge-realq', capRows, Date.now() - 60_000, { hostname: 'edgehost-realq', platform: 'linux', cores: 4, totalMemMB: 8192, role: 'edge' }); return { ok: true }; });
    //   iDRAC 인벤토리 — 데모 서버와 사람 서버가 같은 CPU 모델(부품 드릴다운 key 하나에 둘 다 걸린다)
    await tryi('xInv', async () => { const IC = await import(${J('idrac/invCache.js')}); const inv = (host) => ({ collectedAt: Date.now(), cpus: [{ model: 'Intel Xeon Gold 6338', cores: 32, maxSpeedMHz: 2000 }], memoryDimms: [{ manufacturer: 'Samsung', sizeGB: 64, type: 'DDR4', speedMHz: 3200, partNumber: 'M393A8G40AB2' }], system: { hostName: host } });
      if (!IC.getInventory('mock-demo-1')) IC.setInventory('mock-demo-1', inv('mockdemo-01')); IC.setInventory('idrac-realq', inv('idrachost-realq')); return { ok: true }; });
    //   SAN 포트 표본(사람 스위치 — 어레이 별칭) — 사람 스위치가 섞이면 데모 수식 경로가 꺼진다(isDemoPerfQuery) · 실제 적재 경로로 넣는다
    await tryi('xSanPerf', async () => { const P = await import(${J('sanswitch/perfDb.js')}); const ts = Date.now() - 10 * 60_000;
      return P.savePerfSample(seedIds.san, ts, { 1: 1e8, 2: 2e8 }, [{ port: 1, attachedName: 'SYMMETRIX::000197900111', attachedWwn: '50:00:09:73:00:00:00:01', speed: '32G', portType: 'F-Port' }, { port: 2, attachedName: 'SYMMETRIX::000197900111', speed: '32G', portType: 'F-Port' }]); });
    //   vCenter 로그 연합 조회 바인딩 — 데모 자기 조회(2xx) · 관리자 조회(데모는 남의 조회라 404)
    await tryi('xLogQ', async () => { const LQ = await import(${J('central/logQueries.js')}); seedIds.lqDemo = LQ.enqueueLogQuery(vcs[0], {}, auth.DEMO_USERNAME); seedIds.lqAdm = LQ.enqueueLogQuery(vcs[0], {}, 'fadm'); return { ok: true }; });
    //   정기 점검 보고 — 지금 만들기(사람 관리자 prtuserq) + 메일 전달 실패 기록(받는 사람 주소)
    await tryi('xPeriodic', async () => { const SV = await import(${J('periodic/service.js')}); const r = await SV.generateRun({ kind: 'daily', manual: true, by: 'prtuserq', deliver: false });
      if (!r.ok) return r; seedIds.prRun = r.id;
      await (await import(${J('periodic/db.js')})).addDelivery({ runId: r.id, kind: 'daily', channel: 'mail', target: 'qmail4@corpq.example', state: 'failed', reason: '550 <qmail4@corpq.example> rejected', recipients: 1 }); return { ok: true }; });
    //   CVP 스냅샷(저장한 계정 snpuserq)
    await tryi('xCvpSnap', async () => { const r = await (await import(${J('cvp/db.js')})).createSnap({ by: 'snpuserq', label: 'snp-realq', bodies: [] }); seedIds.cvpSnap = r.id; return { ok: true }; });
    ` : ''}
    const mk = (u) => auth.createUser(u, { trusted: true });
    mk({ username: 'fadm', role: 'admin', password: 'Passw0rd!long1' });
    mk({ username: 'oper', role: 'operator', password: 'Passw0rd!long1' });
    const tok = (name) => { const u = auth.getUser(name); const sid = 'sid-' + name; const exp = Math.floor(Date.now() / 1000) + 3600;
      const t = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
      auth.noteIssuedSession({ sub: name, sid, exp }); return t; };
    const TOK = { demo: tok(auth.DEMO_USERNAME), fadm: tok('fadm'), oper: tok('oper') };
    const R = ${JSON.stringify(path.join(SRC, 'routes') + '/')};
    const mods = [['/api/admin', 'admin.js', 'adminRouter'], ['/api/ping', 'ping.js', 'pingRouter'], ['/api/svcmon', 'svcmon.js', 'svcmonRouter'],
      ['/api/capacity', 'capacity.js', 'capacityRouter'], ['/api/insights', 'insights.js', 'insightsRouter'], ['/api', 'api.js', 'api']];
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use('/api/auth', (await import(R + 'auth.js')).authRouter);
    const gets = []; const posts = [];
    const walk = (stack, pre) => { for (const l of stack) {
      if (l.route) { if (l.route.methods.get) gets.push(pre + l.route.path); if (l.route.methods.post) posts.push(pre + l.route.path); }
      else if (l.handle && l.handle.stack) { const m = (l.regexp && l.regexp.source || '').match(/^\\^\\\\\\/(.*?)\\\\\\/\\?\\(\\?=/); walk(l.handle.stack, pre + (m ? '/' + m[1].replace(/\\\\\\//g, '/') : '')); } } };
    for (const [pre, f, n] of mods) { const m = await import(R + f); walk(m[n].stack, pre); app.use(pre, auth.authMiddleware, auth.requireEnrolled, m[n]); }
    app.use((err, req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const base = 'http://127.0.0.1:' + port;
    // 반증 3회차 후속: 429(계정당 시작 한도 — cvp/heavyGate START_BURST · START_REFILL_MS)는 기다렸다 다시 부른다. 예전에는 스윕이 CVP 조회를
    //   연달아 불러 데모 · operator 응답이 429 로 빠졌다(데모 429 는 불변식에서 빠지고, operator 429 는 '' 로 대조돼 거짓 실패가 된다).
    const call = async (who, p, tries = 0) => {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
      let res0 = null;
      try { const r = await fetch(base + p, { headers: { authorization: 'Bearer ' + TOK[who] }, signal: ac.signal }); res0 = { st: r.status, txt: await r.text(), ra: Number(r.headers.get('retry-after')) || 0 }; }
      catch (e) { return { st: -1, txt: String(e.message) }; } finally { clearTimeout(t); }
      if (res0.st === 429 && tries < 8) { await new Promise((r) => setTimeout(r, Math.min(6000, Math.max(1600, res0.ra * 1000)))); return call(who, p, tries + 1); }
      return { st: res0.st, txt: res0.txt };
    };
    const callPost = async (who, p) => {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
      try { const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + TOK[who], 'content-type': 'application/json' }, body: '{}', signal: ac.signal }); return { st: r.status, txt: await r.text() }; }
      catch (e) { return { st: -1, txt: String(e.message) }; } finally { clearTimeout(t); }
    };
    const raw = (who, target) => new Promise((res) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET ' + target + ' HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer ' + TOK[who] + '\\r\\nConnection: close\\r\\n\\r\\n'));
      let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => { const i = b.indexOf('\\r\\n\\r\\n'); res({ st: Number((b.split(' ')[1]) || 0), txt: i >= 0 ? b.slice(i + 4) : b }); });
      s.on('error', (e) => res({ st: -1, txt: String(e.message) }));
    });
    const out = { seeds, phase: ${JSON.stringify(phase)}, configDir: process.env.CONFIG_DIR, host0: !!host0 };
    const J2 = (r) => { try { return JSON.parse(r.txt); } catch { return null; } };
    const pick = async (who, p) => { const r = await call(who, p); return { st: r.st, body: J2(r), txt: r.txt }; };
    const IDRAC_VIEWS = ['/api/admin/idrac', '/api/admin/idrac?parts=1', '/api/admin/idrac/trend/servers', '/api/admin/idrac/trend/table?hours=24', '/api/admin/idrac/parts-inventory?cat=cpu',
      '/api/admin/idrac/gpu-inventory', '/api/admin/idrac/unsupported', '/api/admin/idrac/temps', '/api/admin/idrac/firmware-inventory', '/api/admin/room-temp',
      '/api/admin/room-temp/history?group=', '/api/admin/idrac/mock-demo-1/vcenter-host', '/api/admin/idrac/mock-demo-1/inventory', '/api/admin/idrac/mock-demo-1/trend',
      '/api/admin/assignments', '/api/tools/bm-storage', '/api/tools/bm-storage/history', '/api/tools/bm-storage/compare'];
    if (host0) IDRAC_VIEWS.push('/api/admin/idrac/trend/resolve-host?hostId=' + encodeURIComponent(host0.id));
    IDRAC_VIEWS.push('/api/admin/idrac/mock-rdemo-1/trend', '/api/admin/idrac/nic-speed', '/api/admin/idrac/hardware-servers?dim=model&key=x');
    out.resolvePath = host0 ? '/api/admin/idrac/trend/resolve-host?hostId=' + encodeURIComponent(host0.id) : null;
    // 반증 1회차 M-1: 백업 실행 도구(adminOnly — operator 판본 없음). 설정 탭은 READ_DENY, 나머지는 데모 판본(데모 Veeam 서버만).
    const vm0id = ((snap.vms || []).find((v) => v.vcenterId === vcs[0] && v.template !== true) || {}).id || 'x';
    const BACKUP_VIEWS = ['/api/tools/backup-run/vms', '/api/tools/backup-run/vms?vcenterId=' + encodeURIComponent(vcs[0] || ''), '/api/tools/backup-run/runs',
      '/api/tools/backup-run/portal-vms', '/api/tools/backup-run/vm/' + encodeURIComponent(seedIds.veeamVm || vm0id)];
    out.backupViews = BACKUP_VIEWS;
    const CAP_VIEWS = ['/api/capacity/summary', '/api/capacity/host?k=local', '/api/capacity/host?k=mock-Edge-Seoul', '/api/capacity/history?k=mock-Edge-Seoul&metric=' + encodeURIComponent(CAPM[0]) + '&window=day'];
    out.capViews = CAP_VIEWS; out.capMetric = CAPM[0];
    if (${JSON.stringify(phase)} === 'base') {
      out.views = {};
      for (const p of [...IDRAC_VIEWS, ...BACKUP_VIEWS, ...CAP_VIEWS]) out.views[p] = { demo: await pick('demo', p), fadm: await pick('fadm', p) };
    } else {
      // ③-d 캐시 순서(관리자 → 데모 → 관리자 · 데모 → 관리자)
      out.cache = [];
      for (const [p, order] of [['/api/admin/idrac/trend/table?hours=24', ['fadm', 'demo', 'fadm']], ['/api/admin/idrac/trend/table?hours=25', ['demo', 'fadm']],
        ['/api/admin/idrac/parts-inventory?cat=cpu', ['fadm', 'demo', 'fadm']], ['/api/admin/idrac/parts-inventory?cat=gpu', ['demo', 'fadm']]])
        for (const who of order) { const r = await call(who, p); out.cache.push({ p, who, st: r.st, txt: r.txt }); }
      out.views = {};
      for (const p of [...IDRAC_VIEWS, '/api/admin/idrac/idrac-realq/inventory', '/api/admin/idrac/idrac-realq/sensors', '/api/admin/idrac/idrac-realq/temp-history',
        '/api/admin/idrac/idrac-realq/vcenter-host', '/api/admin/idrac/idrac-realq/trend', '/api/admin/idrac/idrac-realq/trend/hourly', '/api/admin/idrac/mock-evil/inventory',
        '/api/overview/cards', '/api/tools/disk-bad', '/api/tools/server-info', '/api/tools/server-cmd/output?id=x', '/api/admin/ipam/scan/ranges',
        '/api/admin/central/token-apply/jobs', '/api/tools/bm-usage/ssh-keys', '/api/tools/storage-usage/mail', '/api/admin/idrac/trend/export.csv',
        ...BACKUP_VIEWS, '/api/tools/backup-run/settings', '/api/tools/backup-run/runs/' + encodeURIComponent(seedIds.veeamRun || 'x'), '/api/tools/bareos-backup/health/settings',
        '/api/tools/vm-clone', '/api/tools/bareos-backup/groups/tree?vcenterId=' + encodeURIComponent(vcs[0] || ''),
        '/api/provision/saved', '/api/provision/saved/' + encodeURIComponent(seedIds.xProv || 'x'), '/api/tools/bareos-backup', '/api/tools/bareos-backup/restore-folders',
        '/api/tools/bareos-backup/live', '/api/admin/ipam/vc-ranges/suggest?kind=idrac&vcenterId=' + encodeURIComponent(vcs[0] || '') + '&datacenterId=dc-realq',
        '/api/admin/ipam/vc-ranges/suggest?kind=vm&vcenterId=' + encodeURIComponent(vcs[0] || ''), '/api/tools/guest-partition/mail',
        ...CAP_VIEWS, '/api/capacity/host?k=edge-realq', '/api/capacity/history?k=edge-realq&metric=' + encodeURIComponent(CAPM[0]) + '&window=day'])
        out.views[p] = { demo: await pick('demo', p), fadm: await pick('fadm', p), oper: await pick('oper', p) };
      // M-1 절대형 · 겹친 슬래시(원시 소켓 — fetch 는 대상을 정규화한다)
      out.raw = {};
      for (const t of ['http://x/api/admin/logs', 'HTTP://X/API/ADMIN/USERS', '/api//tools/server-info', '/api/admin//users', 'http://x/api/admin/idrac', '/api/admin//idrac'])
        out.raw[t] = await raw('demo', t);
      // ③-a 일반 불변식 — 모든 GET
      //   반증 1회차 S-1: 단건 GET(:id)은 'x' 만이 아니라 **시드한 항목 id 마다** 부르고, 매개변수 없는 GET 은 vCenter 질의(?vcenterId=)로도 부른다 —
      //   예전에는 'x' 로만 불러 단건 · 질의가 있어야 값이 나오는 GET 이 비어 있었다(백업 실행 /vms · /runs/:id 실례).
      //   읽기성 POST(감사 생략 — 데모 계정이 통과하는 POST)도 빈 본문으로 같은 불변식을 본다.
      const { auditSkipped } = await import(${J('audit.js')});
      //   반증 3회차 후속: 스냅샷의 실제 id(호스트 · VM · 데이터스토어 · vCenter)와 파일로 둔 데모 항목 id 도 — 예전 후보는 시드 등록부 id 뿐이라
      //   /hosts/:id · /datastores/:id … 가 404 로만 답해 불변식에서 빠졌다(실측: 데모 2xx 1,081 → 1,144건).
      const snapIds = [host0 && host0.id, ((snap.vms || []).find((v) => v.vcenterId === vcs[0] && v.template !== true) || {}).id, ((snap.datastores || []).find((d) => d.vcenterId === vcs[0]) || {}).id, vcs[0], 'mock-st-t1', 'mock-bm-t1', 'mock-Edge-Seoul'].filter(Boolean);
      const idCands = [...new Set(['x', 'idrac-realq', 'hz-realq', 'pgpu-realq', 'edge-realq', 'vc-realq', ...Object.values(seedIds), ...snapIds])].map(encodeURIComponent);
      const uniq = [...new Set(gets)];
      const urlsOf = (g) => {
        if (/:[A-Za-z_]/.test(g)) return idCands.map((id) => g.replace(/:[A-Za-z_]\\w*/g, id));
        return [g, g + '?vcenterId=' + encodeURIComponent(vcs[0] || '')];
      };
      const sweep = [];
      out.demoStatus = {};
      const sweepOne = async (route, u, method) => {
        const d = method === 'POST' ? await callPost('demo', u) : await call('demo', u);
        out.demoStatus[d.st] = (out.demoStatus[d.st] || 0) + 1;
        if (!(d.st >= 200 && d.st < 300)) return d.st;
        const o = method === 'POST' ? await callPost('oper', u) : await call('oper', u);
        sweep.push({ route: (method === 'POST' ? 'POST ' : '') + route, url: u, demo: d.txt, oper: o.st >= 200 && o.st < 300 ? o.txt : '', operSt: o.st });
        return d.st;
      };
      // 반증 3회차 should(시험 사각지대 — 재현): 필수 질의(kind · dim · key · cat · jobid …)가 있는 GET 은 매개변수 없이 부르면 데모에게 400 이라
      //   불변식에서 빠졌다(데모 400 125건 — vc-ranges/suggest?kind=idrac 가 그 틈으로 샜다). 데모가 400 이면 **필수 질의를 채운 판본들로 다시** 부르고,
      //   그래도 2xx 를 못 받은 라우트는 still400 으로 내보낸다(아래 시험이 '알려진 목록 밖' 을 실패로 본다 — 새 필수 질의 라우트가 조용히 빠지지 않게).
      const VC0 = encodeURIComponent(vcs[0] || ''); const H0 = encodeURIComponent((host0 && host0.id) || 'x'); const VM0 = encodeURIComponent(((snap.vms || []).find((v) => v.vcenterId === vcs[0]) || {}).id || 'x');
      const FILL_BASE = 'vcenterId=' + VC0 + '&datacenterId=dc-realq&hostId=' + H0 + '&vmId=' + VM0 + '&key=x&k=x&id=x&name=x&q=x&jobid=1&target=digest&hours=24&days=7&group=x&path=%2Fdata&from=0&to=' + Date.now();
      const FILLS = ['kind=idrac&dim=model&cat=cpu&type=cpu&metric=cpu', 'kind=vm&dim=vendor&cat=gpu&type=disk&metric=mem', 'kind=host&dim=serviceTag&cat=memory&type=host&metric=disk']
        .map((f) => FILL_BASE + '&' + f);
      // 반증 3회차 후속 — **라우트별 유효 질의 표**(ROUTE_QUERIES): FILLS 는 같은 값(x · 1 · cpu …)을 모든 라우트에 넣어 '필수 질의가 있는' 26개 경로가
      //   여전히 400 · 404 였다(실측). 경로마다 그 라우트 소스가 요구하는 질의를 **실제 키**(시드 · 목 스냅샷 · 다른 응답)로 채운다.
      //   표의 URL 은 데모가 2xx 를 받든 말든 모두 스윕에 넣고(③-a 불변식), 표로도 2xx 를 못 받은 라우트는 tableMiss 로 내보낸다 —
      //   아래 시험이 tableMiss · still400 ⊆ STILL400_KNOWN(사유 주석)을 요구한다. 새 필수 질의 라우트는 여기에 줄을 더할 것.
      const E = encodeURIComponent;
      const jget = async (who, p) => { const r = await call(who, p); try { return JSON.parse(r.txt); } catch { return null; } };
      const valsOf = (o, prop, out2 = [], d = 0) => {   // JSON 안에서 이름이 prop 인 글자 · 수 값(깊이 · 개수 상한)
        if (!o || typeof o !== 'object' || d > 10 || out2.length >= 200) return out2;
        if (Array.isArray(o)) { for (const x of o) valsOf(x, prop, out2, d + 1); return out2; }
        for (const [k, v] of Object.entries(o)) { if (k === prop && (typeof v === 'string' || typeof v === 'number')) out2.push(v); else valsOf(v, prop, out2, d + 1); }
        return out2;
      };
      const uniqTake = (arr, n) => [...new Set(arr.map(String).filter(Boolean))].slice(0, n);
      const vmA = (snap.vms || []).find((v) => v.vcenterId === vcs[0] && v.template !== true && (v.ipAddress || (v.ipAddresses || []).length)) || (snap.vms || [])[0] || {};
      const vmIp = String(vmA.ipAddress || (vmA.ipAddresses || [])[0] || '');
      const hostC = (snap.hosts || []).find((h) => h.vcenterId === vcs[0] && h.cluster) || {};
      const dnsIps = uniqTake((snap.vms || []).flatMap((v) => [...(Array.isArray(v.dnsServers) ? v.dnsServers : []), ...(Array.isArray(v.guest?.dnsServers) ? v.guest.dnsServers : []), ...(Array.isArray(v.dns) ? v.dns : [])]), 3);
      const ROUTE_QUERIES = {
        // idracCore.js parts-servers: key = '<카테고리>|<라벨>'(partsInventory.serversWithPart) — 부품 집계(관리자 · 데모) 버킷의 key 그대로
        '/api/admin/idrac/parts-servers': async () => {
          const ks = []; for (const who of ['fadm', 'demo']) for (const c of ['cpu', 'dimm']) ks.push(...valsOf(await jget(who, '/api/admin/idrac/parts-inventory?cat=' + c), 'key').filter((k) => String(k).includes('|')));
          return uniqTake(ks, 4).map((k) => '/api/admin/idrac/parts-servers?key=' + E(k));
        },
        // collectorsDc.js resolveVmTarget: 스냅샷 VM id(mock 모드에서는 400 — STILL400_KNOWN)
        '/api/admin/vm/:id/hardware': async () => [vmA.id, seedIds.veeamVm].filter(Boolean).map((id) => '/api/admin/vm/' + E(id) + '/hardware'),
        // ping.js /series: id = 대상 id(목록 /targets · 시드 pg-realq)
        '/api/ping/series': async () => uniqTake([...valsOf(await jget('demo', '/api/ping/targets'), 'id'), seedIds.ping], 3).map((id) => '/api/ping/series?id=' + E(id) + '&range=6h'),
        // capacity.js /host: k = 요약의 호스트 키(local · 엣지 agent 이름 — 시드)
        '/api/capacity/host': async () => uniqTake(valsOf(await jget('fadm', '/api/capacity/summary'), 'k'), 4).map((k) => '/api/capacity/host?k=' + E(k)),
        // capacity.js /history: k + metric(collectorMeta key) + window
        '/api/capacity/history': async () => { const s = await jget('fadm', '/api/capacity/summary'); const ms = uniqTake(valsOf(s && s.collectors, 'key'), 2);
          return uniqTake(valsOf(s && s.hosts, 'k'), 4).flatMap((k) => ms.map((m) => '/api/capacity/history?k=' + E(k) + '&metric=' + E(m) + '&window=day')); },
        // overviewNsx.js group-members: groupId '<managerId>:<rawId>'(스냅샷 보안그룹 — mock 이면 합성 멤버)
        '/api/nsx/group-members': async () => uniqTake([...valsOf((await jget('demo', '/api/nsx') || {}).securityGroups, 'id'), 'mock-nsx-1:grp-demo'], 2).map((g) => '/api/nsx/group-members?groupId=' + E(g)),
        // searchNotes.js /release-notes/since: from = a.b.c
        '/api/release-notes/since': async () => ['/api/release-notes/since?from=1.0.0'],
        // hardwareGpu.js /tools/ip-ping: vcenterId + ips(그 vCenter VM 의 IP)
        '/api/tools/ip-ping': async () => [vmA.vcenterId && vmIp ? '/api/tools/ip-ping?vcenterId=' + E(vmA.vcenterId) + '&ips=' + E(vmIp) : null].filter(Boolean),
        // checksLogs.js /tools/vclogs/federate: reqId = 큐잉한 조회(시드 — 데모 자기 것 · 관리자 것)
        '/api/tools/vclogs/federate': async () => [seedIds.lqDemo, seedIds.lqAdm].filter(Boolean).map((id) => '/api/tools/vclogs/federate?reqId=' + E(id)),
        // veeam.js /stale: n(1~999) · unit · vc(backupSummaryAgg.staleQueryOf)
        '/api/tools/backup-summary/stale': async () => ['/api/tools/backup-summary/stale?n=7&unit=d', '/api/tools/backup-summary/stale?n=1&unit=h&vc=' + VC0],
        // bareosBackup.js jobs/:id/log: 대상 id + jobid(정수 > 0 — 시드 실행 777 · 데모 대상)
        '/api/tools/bareos-backup/jobs/:id/log': async () => [seedIds.bareosDemoJob, seedIds.xBareosJob].filter(Boolean).flatMap((id) => [1, 777].map((j) => '/api/tools/bareos-backup/jobs/' + E(id) + '/log?jobid=' + j)),
        // storageMon.js node-clients: 장비 id(데모는 mock- 만 — demoGuard) + node(정수 ≥ 0)
        '/api/tools/storage/devices/:id/node-clients': async () => uniqTake([...valsOf((await jget('demo', '/api/tools/storage') || {}).devices, 'id'), seedIds.storage], 3).map((id) => '/api/tools/storage/devices/' + E(id) + '/node-clients?node=0&range=24h'),
        // periodicReport.js runs/:id: RUN_ID_RE 형식의 회차(시드 — 지금 만들기 회차)
        '/api/tools/periodic-report/runs/:id': async () => uniqTake([seedIds.prRun, ...valsOf((await jget('fadm', '/api/tools/periodic-report/runs?days=400') || {}).runs, 'id')], 2).map((id) => '/api/tools/periodic-report/runs/' + E(id)),
        '/api/tools/periodic-report/runs/:id/report.html': async () => [seedIds.prRun].filter(Boolean).map((id) => '/api/tools/periodic-report/runs/' + E(id) + '/report.html'),
        // sanStorage.js /array: key = 어레이 키(목록 rows[].key · 시드 포트 별칭)
        '/api/tools/san-storage/array': async () => uniqTake([...valsOf((await jget('demo', '/api/tools/san-storage') || {}).rows, 'key'), 'SYMMETRIX::000197900111'], 3).map((k) => '/api/tools/san-storage/array?key=' + E(k) + '&hours=24'),
        // cvpNet.js /locate: q = MAC · IP · 이름(2자 이상 — cvp/locate.parseQuery)
        '/api/tools/cvp/locate': async () => [vmA.name, vmIp].filter(Boolean).map((q) => '/api/tools/cvp/locate?q=' + E(q)),
        // cvpNet.js /compare: a = 스냅샷 id(시드) · b = now
        '/api/tools/cvp/compare': async () => uniqTake([seedIds.cvpSnap, ...valsOf((await jget('demo', '/api/tools/cvp/snapshots') || {}).snapshots, 'id')], 2).map((a) => '/api/tools/cvp/compare?a=' + E(a) + '&b=now'),
        // bmUsage.js /history · bmMaint.js /occurrences: key = 대상 키(목록 targets[].key — 비관리자는 토큰일 수 있다) · bmCompare.js: keys = 쉼표 목록
        '/api/tools/bm-usage/history': async () => uniqTake(valsOf((await jget('demo', '/api/tools/bm-usage') || {}).targets, 'key'), 3).map((k) => '/api/tools/bm-usage/history?key=' + E(k)),
        '/api/tools/bm-usage/compare': async () => { const ks = uniqTake(valsOf((await jget('demo', '/api/tools/bm-usage') || {}).targets, 'key'), 3); return ks.length ? ['/api/tools/bm-usage/compare?keys=' + E(ks.join(',')) + '&range=24h'] : []; },
        '/api/tools/bm-usage/maintenance/occurrences': async () => uniqTake(valsOf((await jget('demo', '/api/tools/bm-usage') || {}).targets, 'key'), 3).map((k) => '/api/tools/bm-usage/maintenance/occurrences?key=' + E(k)),
        // vmtrack.js /changes · /ds-changes: slot(YYYY-MM-DDTHH — 추적 점 points[].slot) 또는 snapId · /ds-series: dsId(로스터 · 스냅샷 DS id)
        '/api/tools/vm-track/changes': async () => uniqTake(valsOf((await jget('demo', '/api/tools/vm-track?days=30') || {}).points, 'slot'), 200).slice(-2).map((s) => '/api/tools/vm-track/changes?slot=' + E(s)),
        '/api/tools/vm-track/ds-changes': async () => uniqTake(valsOf((await jget('demo', '/api/tools/vm-track?days=30') || {}).points, 'slot'), 200).slice(-2).map((s) => '/api/tools/vm-track/ds-changes?slot=' + E(s)),
        '/api/tools/vm-track/ds-series': async () => uniqTake([...valsOf((await jget('demo', '/api/tools/vm-track/ds-list') || {}).items, 'dsId'), ...(snap.datastores || []).filter((d) => d.vcenterId === vcs[0]).map((d) => d.id)], 2).map((id) => '/api/tools/vm-track/ds-series?dsId=' + E(id) + '&days=30'),
        // clusterCheck.js /of: vcenterId + cluster(스냅샷 호스트의 클러스터)
        '/api/tools/cluster-check/of': async () => [hostC.cluster ? '/api/tools/cluster-check/of?vcenterId=' + E(hostC.vcenterId) + '&cluster=' + E(hostC.cluster) + (hostC.id ? '&hostId=' + E(hostC.id) : '') : null].filter(Boolean),
        // vmDns.js /server: ip = VM 이 DNS 서버로 쓰는 주소 · /vm: id = VM id
        '/api/tools/vm-dns/server': async () => uniqTake([...dnsIps, ...valsOf(await jget('demo', '/api/tools/vm-dns'), 'ip')], 3).map((ip) => '/api/tools/vm-dns/server?ip=' + E(ip)),
        '/api/tools/vm-dns/vm': async () => [vmA.id, seedIds.veeamVm].filter(Boolean).map((id) => '/api/tools/vm-dns/vm?id=' + E(id)),
      };
      const still400 = []; const tableMiss = {}; out.routeTable = {};
      for (const g of uniq) {
        let got400 = false; let gotOk = false;
        for (const u of urlsOf(g)) { const st = await sweepOne(g, u, 'GET'); if (st === 400) got400 = true; else if (st >= 200 && st < 300) gotOk = true; }
        if (ROUTE_QUERIES[g]) {
          let us = []; try { us = await ROUTE_QUERIES[g](); } catch (e) { us = []; tableMiss[g] = 'table-throw ' + e.message; }
          const tried = [];
          for (const u of us) { const st = await sweepOne(g, u, 'GET'); tried.push(st + ' ' + u); if (st >= 200 && st < 300) gotOk = true; else if (st === 400) got400 = true; }
          out.routeTable[g] = tried;
          if (!tried.some((x) => /^2\\d\\d /.test(x)) && !tableMiss[g]) {
            const u = us[0]; const r = u ? await call('demo', u) : { st: 0, txt: '표가 URL 을 만들지 못함(키 없음)' };
            tableMiss[g] = r.st + ' ' + String(r.txt).slice(0, 200);
          }
        }
        if (!got400 || gotOk) continue;
        let filledOk = false;
        for (const u of urlsOf(g)) for (const f of FILLS) { const st = await sweepOne(g, u + (u.includes('?') ? '&' : '?') + f, 'GET'); if (st >= 200 && st < 300) filledOk = true; }
        if (!filledOk) { still400.push(g); const u = urlsOf(g)[0]; const r = await call('demo', u + (u.includes('?') ? '&' : '?') + FILLS[0]); (out.still400Why ||= {})[g] = r.st + ' ' + r.txt.slice(0, 220); }
      }
      out.still400 = still400; out.tableMiss = tableMiss; out.routeTableKeys = Object.keys(ROUTE_QUERIES); out.routeTableDead = Object.keys(ROUTE_QUERIES).filter((k) => !uniq.includes(k));
      const readPosts = [...new Set(posts)].filter((p) => auditSkipped('POST', p));
      for (const p of readPosts) await sweepOne(p, p, 'POST');
      out.sweep = sweep; out.totalGets = uniq.length; out.readPosts = readPosts; out.seedIds = seedIds;
      out.sweepUrls = sweep.map((x) => x.url);
      // L8 — 관리자 로그 뷰어
      const L = await import(${J('logbuffer.js')});
      const before = L.getLogs({}).lastId;
      const long = 'x'.repeat(7980) + ' password=tailZZ9';
      const lines = ['password=hunter2zz', '{"centralToken":"tokZZ123","tokenFp":"ab12"}', 'CENTRAL_URL=https://u:SuperPwZZ@c.example', 'Authorization: Bearer brZZ999',
        "PROXY_SSH_PASS='a b zz'", 'pass=3 deviceKey=dk-1 tokenFp=ab12', long];
      for (const l of lines) console.log(l);
      console.warn('warn line password=warnZZ7');
      const l1 = await pick('fadm', '/api/admin/logs?since=' + before);
      console.log('after secret=afterZZ5');
      const l2 = await pick('fadm', '/api/admin/logs?since=' + l1.body.lastId);
      const l3 = await pick('fadm', '/api/admin/logs?since=' + before + '&level=warn');
      const { collectEdgeLog } = await import(${J('edgelog/collect.js')});
      const edge = await collectEdgeLog({ since: before, withStatus: false, limit: 1000 });
      const { redactLogLine } = await import(${J('edgelog/redact.js')});
      out.logs = { lines, l1: l1.body, l2: l2.body, l3: l3.body, edge: edge.logs.items, expected: lines.map((x) => redactLogLine(x)) };
    }
    srv.close();
    fs.writeFileSync(process.env.CONFIG_DIR + '/harness-out.json', JSON.stringify(out));
    console.log('@@done');
    process.exit(0);`;
}

function runHarness(phase) {
  const dir = tmpDir(`sec1127g7-${phase}-`);
  const r = spawnSync(process.execPath, ['--input-type=module', '--experimental-sqlite', '-e', harnessScript(phase)], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40), OTP_ROLE_ENFORCE: 'false', SETTINGS_OWNERS: 'fadm' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-3000));
  assert.ok(r.stdout.includes('@@done'), r.stdout.slice(-600) + (r.stderr || '').slice(-600));
  return JSON.parse(fs.readFileSync(path.join(dir, 'harness-out.json'), 'utf8'));
}
const H = {};
const harness = (phase) => (H[phase] ||= runHarness(phase));

// 반증 3회차 후속: 라우트별 유효 질의 표(하네스 ROUTE_QUERIES — 실제 키 · 시드)로도 데모가 2xx 를 **받을 수 없는** GET. 경로마다 근거(소스 줄)를 적는다 —
//   '질의를 못 찾음' 은 사유가 아니다(표를 고칠 것). 항목이 still400 · tableMiss 어디에도 없게 되면(이제 2xx) 아래 시험이 '낡은 항목' 으로 실패한다.
//   3회차 첫 실행의 26개 중 나머지 24개는 표로 2xx 를 받아 ③-a 불변식 스윕에 들어간다(R3_FIRST_RUN_26 · 시험 '③-r3 should').
const STILL400_KNOWN = [
  // routes/admin/collectorsDc.js resolveVmTarget(74행): `if (snap.source === 'mock') return { error: '데모(mock) 모드에서는 사양 변경을 사용할 수 없습니다.', code: 400 }` —
  //   mock 스냅샷이면 VM 이 있어도 **모든 계정**이 400(관리자도 — 실제 vCenter SOAP 조회 경로라 합성 판본이 없다). 데모 계정은 mock 모드에서만 존재하므로 2xx 가 없다.
  '/api/admin/vm/:id/hardware',
  // routes/api/bareosBackup.js jobs/:id/log(1083행) → readDirector({ demoOnly: isDemoGuest }) → bareos/service.js onDirector(196행):
  //   `if (demoOnly && !isDemoActive()) throw fail('demo-only')` · isDemoActive = mock ∧ 사람 Director 0개(62행). full 단계는 사람 Director(bd-realq)를 시드하므로
  //   데모 계정은 **어느 대상**(데모 대상 포함)의 작업 로그도 403 이다(사람이 등록한 Director 에 접속하지 않는 규칙 — demoGuest.js 머리말). 표는 데모 대상 ·
  //   사람 대상 × jobid 1 · 777 로 부른다(전부 403 실측). 사람 Director 가 없는 설치본에서는 데모 Director 로그가 열린다(이 스윕은 full 단계만).
  '/api/tools/bareos-backup/jobs/:id/log',
];
// 반증 3회차 첫 실행(6d137260)에서 FILLS 로도 2xx 를 못 받은 26개 — 모두 질의 표에 있어야 한다(줄이 빠지면 FILLS 로 되돌아가 조용히 빠진다).
const R3_FIRST_RUN_26 = ['/api/admin/idrac/parts-servers', '/api/admin/vm/:id/hardware', '/api/ping/series', '/api/capacity/host', '/api/capacity/history',
  '/api/nsx/group-members', '/api/release-notes/since', '/api/tools/ip-ping', '/api/tools/vclogs/federate', '/api/tools/backup-summary/stale',
  '/api/tools/bareos-backup/jobs/:id/log', '/api/tools/storage/devices/:id/node-clients', '/api/tools/periodic-report/runs/:id', '/api/tools/periodic-report/runs/:id/report.html',
  '/api/tools/san-storage/array', '/api/tools/cvp/locate', '/api/tools/cvp/compare', '/api/tools/bm-usage/history', '/api/tools/bm-usage/compare',
  '/api/tools/bm-usage/maintenance/occurrences', '/api/tools/vm-track/changes', '/api/tools/vm-track/ds-changes', '/api/tools/vm-track/ds-series',
  '/api/tools/cluster-check/of', '/api/tools/vm-dns/server', '/api/tools/vm-dns/vm'];
const lower = (s) => String(s || '').toLowerCase();
const sens = (txt, configDir) => {
  const set = new Set((lower(txt).match(new RegExp(SENS_SRC, 'g')) || []));
  if (configDir && String(txt || '').includes(configDir)) set.add('<config-dir>');
  return set;
};
const names = (txt) => new Set(lower(txt).match(new RegExp(NAME_SRC, 'g')) || []);
const body = (v) => v.body || {};

test('③ 시드 — 하네스가 넣은 사람 · 데모 항목이 모두 들어갔다(시드 실패를 시험 통과로 오인하지 않게)', () => {
  for (const phase of ['base', 'full']) {
    const h = harness(phase);
    for (const [k, v] of Object.entries(h.seeds)) assert.equal(v, 'ok', `${phase} ${k}: ${v}`);
  }
});

test('③-a L7 일반 불변식 — 모든 GET: 데모 민감 카나리 ⊆ 같은 경로 operator · 데모 이름 ⊆ operator 가 어디서든 받는 이름', () => {
  const h = harness('full');
  assert.ok(h.sweep.length > 1000, `데모 2xx GET ${h.sweep.length}/${h.totalGets} · 데모 상태 분포 ${JSON.stringify(h.demoStatus)}`);   // 반증 3회차 후속 실측 1,144(질의 표 · 스냅샷 id 후보 · 429 재시도) — 크게 줄면 시드 · 표가 깨진 것
  const operNames = new Set();
  for (const s of h.sweep) for (const n of names(s.oper)) operNames.add(n);
  const bad = [];
  for (const s of h.sweep) {
    const d = sens(s.demo, h.configDir); const o = sens(s.oper, h.configDir);
    const extra = [...d].filter((x) => !o.has(x));
    if (extra.length) bad.push(`${s.route} 민감 ${extra.join(',')} (operator ${s.operSt})`);
    const nExtra = [...names(s.demo)].filter((x) => !operNames.has(x));
    if (nExtra.length) bad.push(`${s.route} 이름 ${nExtra.join(',')} (operator ${s.operSt})`);
  }
  assert.deepEqual(bad, []);
});

test('③-b /api/admin/idrac 데모 판본 — 데모 항목만 + 뺀 개수 · 관리자 무변경', () => {
  const v = harness('full').views['/api/admin/idrac'];
  assert.equal(v.demo.st, 200);
  const d = body(v.demo);
  assert.equal(d.scoped, true); assert.equal(d.demoOnly, true);
  assert.ok(d.omittedOutOfScope >= 3, `omitted ${d.omittedOutOfScope}`);
  const ids = d.servers.map((s) => s.id).sort();
  assert.deepEqual(ids, ['mock-demo-1', 'mock-demo-app', 'mock-rdemo-1']);
  assert.equal(sens(v.demo.txt).size, 0, [...sens(v.demo.txt)].join(','));
  assert.equal(d.poller.lastRun, null, '사람 장비가 섞인 함대의 폴러 결과는 데모에게 주지 않는다');
  const f = body(v.fadm);
  assert.ok(sens(v.fadm.txt).has('10.66.1.11'));
  assert.ok(f.servers.some((s) => s.id === 'mock-evil'), '대조: 관리자는 사람 엣지의 행도 본다');
  assert.equal('scoped' in f, false); assert.equal('demoOnly' in f, false);
});

test('③-b2 전체 범위 데모의 법인 선택 목록은 관리자와 같다(법인 이름은 operator 판본도 싣는다) · 데모 서버 수집 오류 원문은 보인다', () => {
  const V = harness('full').views;
  const HS = V['/api/admin/idrac/nic-speed'];
  assert.equal(HS.demo.st, 200);
  assert.deepEqual(body(HS.demo).datacenters, body(HS.fadm).datacenters);
  assert.ok((body(HS.fadm).datacenters || []).some((d) => d.id === 'dc-mocksolo'), JSON.stringify(body(HS.fadm).datacenters));
});

test('③-c 데모의 사람 서버 단건 조회는 404(존재 은닉) · 데모 서버는 열림 · 관리자 200', () => {
  const V = harness('full').views;
  for (const p of ['/api/admin/idrac/idrac-realq/inventory', '/api/admin/idrac/idrac-realq/sensors', '/api/admin/idrac/idrac-realq/temp-history',
    '/api/admin/idrac/idrac-realq/vcenter-host', '/api/admin/idrac/idrac-realq/trend', '/api/admin/idrac/idrac-realq/trend/hourly', '/api/admin/idrac/mock-evil/inventory']) {
    assert.equal(V[p].demo.st, 404, `${p} ${V[p].demo.txt.slice(0, 120)}`);
    assert.notEqual(V[p].fadm.st, 404, `${p} 관리자 대조 ${V[p].fadm.st}`);
  }
  for (const p of ['/api/admin/idrac/mock-demo-1/vcenter-host', '/api/admin/idrac/mock-demo-1/trend'])
    assert.equal(V[p].demo.st, 200, `${p} ${V[p].demo.txt.slice(0, 160)}`);
});

test('③-d 캐시 순서 — 추이 표 · 부품 집계: 관리자 판본과 데모 판본이 캐시로 섞이지 않는다', () => {
  const h = harness('full');
  for (const c of h.cache) {
    assert.equal(c.st, 200, `${c.p} ${c.who}`);
    const s = sens(c.txt);
    if (c.who === 'demo') assert.equal(s.size, 0, `${c.p} 데모에 ${[...s].join(',')}`);
    else assert.ok(s.size > 0, `${c.p} 관리자 판본이 데모 판본으로 바뀌었다`);
  }
});

test('③-e gpu-inventory — 데모에게 사람이 등록한 GPU 물리 서버 0 · 데모 물리 서버는 남는다', () => {
  const v = harness('full').views['/api/admin/idrac/gpu-inventory'];
  assert.equal(v.demo.st, 200);
  assert.equal(v.demo.txt.includes('10.66.6.66'), false);
  assert.equal(v.demo.txt.includes('pgpu-realq'), false);
  assert.ok(body(v.demo).servers.some((s) => s.id === 'mock-pgpu-1'), v.demo.txt.slice(0, 300));
  assert.ok(v.fadm.txt.includes('10.66.6.66'));
});

test('③-f /idrac/unsupported — 데모는 trigger demo 그룹만(1개 이상) · 관리자는 두 그룹', () => {
  const v = harness('full').views['/api/admin/idrac/unsupported'];
  const d = body(v.demo);
  assert.ok(d.rows.length >= 1, '데모 그룹을 빈 목록으로 떨어뜨리지 않는다');
  assert.ok(d.rows.every((r) => r.ip === '192.0.2.77'), JSON.stringify(d.rows).slice(0, 200));
  assert.ok(d.groups.every((g) => g.trigger === 'demo'));
  assert.equal(d.omittedOutOfScope, 1);
  assert.equal(v.demo.txt.includes('10.66.21.21'), false);
  const f = body(v.fadm);
  assert.ok(f.rows.some((r) => r.ip === '10.66.21.21') && f.rows.some((r) => r.ip === '192.0.2.77'));
});

test('③-g /admin/assignments — 데모는 mock- 에이전트만 + demoMasked · 관리자는 전부', () => {
  const v = harness('full').views['/api/admin/assignments'];
  assert.equal(v.demo.st, 200);
  const d = body(v.demo);
  assert.ok(d.assignments.length >= 1 && d.assignments.every((a) => /^mock-/i.test(a.agent)), JSON.stringify(d.assignments).slice(0, 200));
  assert.ok(Object.keys(d.results).every((k) => /^mock-/i.test(k)));
  assert.ok(d.knownAgents.every((a) => /^mock-/i.test(a.name)), JSON.stringify(d.knownAgents));
  assert.ok(d.demoMasked.assignments >= 1 && d.demoMasked.results >= 1, JSON.stringify(d.demoMasked));
  assert.equal(sens(v.demo.txt).size, 0); assert.equal(names(v.demo.txt).size, 0);
  const f = body(v.fadm);
  assert.ok(f.assignments.some((a) => a.agent === 'edge-realq'));
  assert.equal('demoMasked' in f, false);
});

test('③-k 베어메탈 스토리지(adminOnly) — 데모는 데모 서버 · 데모 서버 이력만(그룹 · 합계는 사람 서버가 섞이면 뺀다) · DB 경로 없음', () => {
  const h = harness('full');
  const V = h.views;
  const L = V['/api/tools/bm-storage'];
  assert.equal(L.demo.st, 200);
  assert.deepEqual(body(L.demo).servers.map((x) => x.id), ['mock-bm-t1']);
  assert.ok(body(L.fadm).servers.some((x) => x.name === 'bm-realq'));
  const Hd = body(V['/api/tools/bm-storage/history'].demo);
  assert.deepEqual(Hd.series.map((x) => `${x.kind}|${x.key}`), ['server|mock-bm-t1']);
  assert.equal(Hd.demoMasked, 3);
  const Hf = body(V['/api/tools/bm-storage/history'].fadm);
  assert.equal(Hf.series.length, 4);
  assert.equal('demoMasked' in Hf, false);
  const C = V['/api/tools/bm-storage/compare'];
  assert.equal(C.demo.txt.includes(h.configDir), false);
  assert.equal(body(C.demo).io.pathHidden, true);
  assert.ok(C.fadm.txt.includes(h.configDir), '대조: 관리자는 DB 경로를 본다');
});

test('③-h non-admin 라우트는 v2.743 operator 판본 그대로(데모 판본이 새지 않는다)', () => {
  const V = harness('full').views;
  const dc = body(V['/api/overview/cards'].demo); const oc = body(V['/api/overview/cards'].oper); const fc = body(V['/api/overview/cards'].fadm);
  assert.equal(V['/api/overview/cards'].demo.st, 200);
  assert.equal(JSON.stringify(dc.physical ?? null), JSON.stringify(oc.physical ?? null));
  // 데모와 operator 는 이 라우트의 캐시 열쇠가 같다(범위 · 역할 user) — 그래서 대조는 열쇠가 다른 관리자 계산과도 한다(물리 서버 수는 판본과 무관한 값).
  //   데모 판본이 이 경로에 새면(경로 조건 제거) 데모가 먼저 계산한 '데모 서버만' 의 수가 operator 에게도 캐시로 간다.
  assert.equal(dc.physical?.count, fc.physical?.count);
  assert.ok(Number(fc.physical?.count) >= 5, `물리 서버 ${fc.physical?.count}`);
  const db = V['/api/tools/disk-bad'];
  assert.deepEqual([...sens(db.demo.txt)].sort(), [...sens(db.oper.txt)].sort());
});

test('③-i 데모 403 + demoGuest 표지(관리자 대조 200) · ③-j 내보내기 403(data.csv)', () => {
  const V = harness('full').views;
  for (const p of ['/api/tools/server-info', '/api/tools/server-cmd/output?id=x', '/api/admin/ipam/scan/ranges', '/api/admin/central/token-apply/jobs',
    '/api/tools/bm-usage/ssh-keys', '/api/tools/storage-usage/mail']) {
    assert.equal(V[p].demo.st, 403, `${p} ${V[p].demo.txt.slice(0, 120)}`);
    assert.equal(body(V[p].demo).demoGuest, true, p);
    assert.notEqual(V[p].fadm.st, 403, `${p} 관리자 대조 ${V[p].fadm.st}`);
  }
  assert.equal(V['/api/admin/idrac/trend/export.csv'].demo.st, 403);
});

test('③ M-1 원시 요청 대상 — 절대형 · 겹친 슬래시도 데모에게 거부 · 절대형 데모 판본도 데모 항목만', () => {
  const h = harness('full');
  for (const t of ['http://x/api/admin/logs', 'HTTP://X/API/ADMIN/USERS', '/api//tools/server-info', '/api/admin//users']) {
    assert.equal(h.raw[t].st, 403, `${t} ${h.raw[t].txt.slice(0, 120)}`);
  }
  for (const t of ['http://x/api/admin/idrac', '/api/admin//idrac']) {
    if (h.raw[t].st >= 200 && h.raw[t].st < 300) assert.equal(sens(h.raw[t].txt).size, 0, `${t} ${[...sens(h.raw[t].txt)].join(',')}`);
  }
});

test('③ M-3 사람 장비가 없는 데모 설치본 — iDRAC 화면 응답이 관리자와 같다(범위 표지 · 파트 장애 링크 · 폴러 · 종류 · 호스트 매칭)', () => {
  const h = harness('base');
  assert.equal(h.host0, true, '스냅샷에 서비스태그가 있는 ESXi 호스트가 있어야 종류 대조가 성립한다');
  for (const [p, v] of Object.entries(h.views)) {
    assert.equal(v.demo.st, v.fadm.st, `${p} ${v.demo.txt.slice(0, 160)}`);
    const d = body(v.demo);
    for (const k of ['scoped', 'demoOnly', 'omittedOutOfScope', 'demoMasked']) assert.equal(k in d, false, `${p} ${k}`);
  }
  const L = h.views['/api/admin/idrac'];
  assert.deepEqual(body(L.demo).servers.map((s) => s.id).sort(), body(L.fadm).servers.map((s) => s.id).sort());
  assert.equal(JSON.stringify(body(L.demo).poller.lastRun), JSON.stringify(body(L.fadm).poller.lastRun));
  assert.equal(body(L.demo).poller.servers, body(L.fadm).poller.servers);
  assert.deepEqual(Object.keys(body(L.demo).poller).sort(), Object.keys(body(L.fadm).poller).sort(), '폴러 상태 모양도 관리자와 같다(범위 판본 아님)');
  const RT = h.views['/api/admin/idrac/mock-rdemo-1/trend'];
  assert.equal(RT.demo.st, 200, RT.demo.txt.slice(0, 160));
  const col = (b) => ({ error: b.idracState?.collector?.error, hidden: b.idracState?.collector?.errorHidden });
  assert.deepEqual(col(body(RT.demo)), col(body(RT.fadm)));
  assert.equal(col(body(RT.demo)).error, 'mock pull 실패(데모)', '데모 서버의 수집 오류 원문은 데모에게도 보인다(범위 계정이 아니다)');
  const RH = h.views[h.resolvePath];
  assert.equal(RH.demo.st, RH.fadm.st);
  const HS = h.views['/api/admin/idrac/nic-speed'];
  assert.deepEqual(body(HS.demo).datacenters, body(HS.fadm).datacenters, '법인 선택 목록도 관리자와 같다');
  const inv = h.views['/api/admin/idrac/mock-demo-1/inventory'];
  assert.equal(inv.demo.st, 200, inv.demo.txt.slice(0, 160));
  assert.ok(body(inv.demo).partFault && typeof body(inv.demo).partFault === 'object', '파트 장애 정보가 실린다');
  assert.equal(!!body(inv.demo).partFault.scoped, false, '전체 범위 데모 계정에 파트 장애 링크를 잠그지 않는다(반증 M-3)');
  assert.equal(JSON.stringify(body(inv.demo).partFault), JSON.stringify(body(inv.fadm).partFault));
  const T = h.views['/api/admin/idrac/trend/servers'];
  const row = (b) => (b.servers || b.rows || []).filter((s) => String(s.id).startsWith('mock-')).map((s) => `${s.id}|${s.kind}|${s.hostId}`).sort();
  assert.deepEqual(row(body(T.demo)), row(body(T.fadm)));
  assert.ok(row(body(T.demo)).some((x) => x.startsWith('mock-demo-1|esxi|')), row(body(T.demo)).join(' '));
  assert.equal(h.views['/api/admin/room-temp/history?group='].demo.st, 200, '전 법인 합계 — 사람 장비가 없으면 데모에게도 연다');
  const U = h.views['/api/admin/idrac/unsupported'];
  assert.equal(body(U.demo).rows.length, body(U.fadm).rows.length);
  const A = h.views['/api/admin/assignments'];
  assert.equal(body(A.demo).assignments.length, body(A.fadm).assignments.length);
  // 반증 3회차 후속: 사람 엣지가 없으면 리소스 적정성도 관리자와 같은 응답(포탈 자신 · 데모 엣지 — 표지 없음)
  const CS = h.views['/api/capacity/summary'];
  assert.deepEqual(body(CS.demo).hosts.map((x) => x.k).sort(), ['local', 'mock-Edge-Seoul'], CS.demo.txt.slice(0, 200));
  assert.deepEqual(body(CS.demo).hosts, body(CS.fadm).hosts); assert.deepEqual(body(CS.demo).push, body(CS.fadm).push);
  for (const p of h.capViews.slice(1)) assert.deepEqual(body(h.views[p].demo), body(h.views[p].fadm), p);
  // 반증 1회차 M-1: 사람 Veeam 서버가 없으면 백업 실행 화면도 관리자와 같은 응답(표지 없음)
  for (const p of h.backupViews) {
    assert.equal(h.views[p].demo.st, 200, `${p} ${h.views[p].demo.txt.slice(0, 160)}`);
    assert.deepEqual(body(h.views[p].demo), body(h.views[p].fadm), p);
  }
});

test('③-l 반증 1회차 M-1 백업 실행(adminOnly) — 설정 탭 403 · VM 목록 · 실행 기록 · 포탈 백업 VM 은 데모(mock-) Veeam 서버만 + 뺀 개수 · 관리자 무변경', () => {
  const h = harness('full');
  const V = h.views;
  const S = V['/api/tools/backup-run/settings'];
  assert.equal(S.demo.st, 403); assert.equal(body(S.demo).demoGuest, true);
  assert.equal(S.fadm.st, 200); assert.ok(S.fadm.txt.includes('10.66.30.30') && S.fadm.txt.includes('edge-realq'), '대조: 관리자는 주소 · 담당 엣지를 본다');
  const [vList, vDetail, runs, pvms, vm] = h.backupViews;
  for (const p of h.backupViews) {
    assert.equal(V[p].demo.st, 200, `${p} ${V[p].demo.txt.slice(0, 160)}`);
    for (const c of ['vbr-realq', 'edge-realq', '10.66.30.30', 'runuserq', 'vbr_']) assert.equal(V[p].demo.txt.includes(c), false, `${p} 데모에 ${c}`);
  }
  const L = body(V[vList].demo);
  assert.ok(L.vcenters.length > 0 && L.vcenters.every((v) => v.linked === false), '데모에게 사람 서버가 맡은 vCenter 를 연결됨으로 말하지 않는다');
  assert.equal(L.demoOnly, true); assert.deepEqual(L.demoMasked, { servers: 1 });
  assert.ok(body(V[vList].fadm).vcenters.some((v) => v.linked === true));
  const D = body(V[vDetail].demo);
  assert.deepEqual(D.servers, []); assert.deepEqual(D.demoMasked, { servers: 1 });
  assert.ok(D.rows.length > 0 && D.rows.every((r) => r.run.status === 'unmapped'), '사람 서버로 판정한 상태(서버 이름)를 싣지 않는다');
  assert.ok(body(V[vDetail].fadm).servers.some((x) => x.name === 'vbr-realq'));
  assert.deepEqual(body(V[runs].demo).runs, []); assert.deepEqual(body(V[runs].demo).demoMasked, { runs: 1 });
  assert.ok(V[runs].fadm.txt.includes('runuserq'));
  assert.equal('demoMasked' in body(V[runs].fadm), false);
  const R1 = V[`/api/tools/backup-run/runs/${encodeURIComponent(h.seedIds.veeamRun)}`];
  assert.equal(R1.demo.st, 404); assert.equal(R1.fadm.st, 200);
  assert.deepEqual(body(V[pvms].demo).vms, []); assert.deepEqual(body(V[pvms].demo).demoMasked, { vms: 1 });
  assert.ok(body(V[pvms].fadm).vms.some((x) => x.serverName === 'vbr-realq'));
  const M = body(V[vm].demo);
  assert.equal(M.record, null); assert.deepEqual(M.servers, []); assert.deepEqual(M.runs, []);
  assert.ok(body(V[vm].fadm).record && body(V[vm].fadm).runs.length === 1);
});

test('③-m 반증 1회차 S-2 — 관리자 전용 도구의 실행 · 작업 기록에 남은 포탈 계정 이름은 데모 계정에 싣지 않는다(키는 남긴다)', () => {
  const V = harness('full').views;
  const cases = [['/api/tools/vm-clone', 'opuserq'], [`/api/tools/bareos-backup/groups/tree?vcenterId=${encodeURIComponent('vc-us-east')}`, 'grpuserq'], ['/api/tools/bareos-backup/health/settings', 'savuserq']];
  for (const [p0, c] of cases) {
    const p = Object.keys(V).find((k) => k.split('?')[0] === p0.split('?')[0]);
    assert.ok(p, p0);
    assert.equal(V[p].demo.st, 200, `${p} ${V[p].demo.txt.slice(0, 160)}`);
    assert.equal(V[p].demo.txt.includes(c), false, `${p} 데모에 ${c}`);
    assert.ok(V[p].fadm.txt.includes(c), `${p} 대조: 관리자는 ${c} 를 본다`);
  }
  const ops = body(V['/api/tools/vm-clone'].demo).ops;
  assert.ok(ops.some((o) => o.jobId === 'job-q' && o.by === ''), '작업 행은 남고 by 만 비운다');
  const gp = Object.keys(V).find((k) => k.startsWith('/api/tools/bareos-backup/groups/tree'));
  const g = (body(V[gp].demo).groups || []).find((x) => x.name === 'grp-q');
  assert.ok(g && g.createdBy === '' && g.updatedBy === '', JSON.stringify(g).slice(0, 200));
});

test('③-l 순수 판정 — 데모 Veeam 서버 · 실행 기록(모든 그룹 · VM 이 데모 서버일 때만) · 포탈 기록', async () => {
  const { isDemoVeeamServerId, runShownTo, portalRecordShownTo } = await import('../src/routes/api/backupRun.js');
  const demo = { user: { role: 'admin', demoGuest: true } };
  const adm = { user: { role: 'admin' } };
  assert.equal(isDemoVeeamServerId('mock-vbr-1'), true);
  assert.equal(isDemoVeeamServerId('MOCK-x'), false, '반증 2회차 nit: 폴러(collectOne)와 같은 규칙 — 대소문자 구분(MOCK- 는 폴러가 실제로 수집한다)');
  for (const bad of ['vbr-abc', '', null, undefined, 'xmock-1']) assert.equal(isDemoVeeamServerId(bad), false, String(bad));
  const run = (g, v) => ({ groups: g.map((serverId) => ({ serverId })), vms: v.map((serverId) => ({ serverId, vcenterId: 'vc-a' })) });
  assert.equal(runShownTo(demo, run(['mock-1'], ['mock-1']), null), true);
  assert.equal(runShownTo(demo, run(['mock-1', 'vbr-x'], ['mock-1']), null), false, '그룹 하나라도 사람 서버면 뺀다');
  assert.equal(runShownTo(demo, run(['mock-1'], ['mock-1', 'vbr-x']), null), false, 'VM 하나라도 사람 서버면 뺀다');
  assert.equal(runShownTo(demo, run([], []), null), false, '서버가 없는 기록은 데모 기록이 아니다');
  assert.equal(runShownTo(adm, run(['vbr-x'], ['vbr-x']), null), true);
  assert.equal(runShownTo(adm, run(['vbr-x'], ['vbr-x']), new Set(['vc-b'])), false, '범위 판정(runVisible)은 그대로');
  assert.equal(runShownTo(demo, run(['mock-1'], ['mock-1']), new Set(['vc-b'])), false);
  assert.equal(portalRecordShownTo(demo, { serverId: 'mock-1' }), true);
  assert.equal(portalRecordShownTo(demo, { serverId: 'vbr-x' }), false);
  assert.equal(portalRecordShownTo(adm, { serverId: 'vbr-x' }), true);
  assert.equal(portalRecordShownTo(adm, null), false);
});

test('③-m demoAccountView — 데모만 · 일반 객체와 배열만 내려간다 · 원본 무변경 · 문자열만 비운다', async () => {
  const { demoAccountView, ACCOUNT_KEYS } = await import('../src/auth/demoGuest.js');
  const demo = { role: 'admin', demoGuest: true };
  const d = new Date(0);
  const src = { by: 'a', user: 'u', n: { createdBy: 'c', by: 3, list: [{ updatedBy: 'x', deletedBy: 'y', savedBy: 'z' }] }, when: d, other: 'keep', byKey: 'keep' };
  const out = demoAccountView(demo, src);
  assert.deepEqual(out, { by: '', user: '', n: { createdBy: '', by: 3, list: [{ updatedBy: '', deletedBy: '', savedBy: '' }] }, when: d, other: 'keep', byKey: 'keep' });
  assert.equal(out.when, d, 'Date 는 그대로(직렬화 모양 무변경)');
  assert.equal(src.by, 'a'); assert.equal(src.n.list[0].updatedBy, 'x');
  assert.equal(demoAccountView({ role: 'admin' }, src), src, '관리자 · operator 는 원본 그대로(같은 객체)');
  assert.equal(demoAccountView({ role: 'operator' }, src), src);
  assert.deepEqual(demoAccountView(demo, { by: 'a', user: 'u' }, ['by']), { by: '', user: 'u' }, '키 목록을 받으면 그 키만');
  assert.deepEqual([...ACCOUNT_KEYS].sort(), ['by', 'createdBy', 'deletedBy', 'savedBy', 'updatedBy', 'user']);
  assert.equal(demoAccountView(demo, null), null);
  assert.deepEqual(demoAccountView(demo, [{ by: 'q' }]), [{ by: '' }]);
});

test('③-n 반증 2회차 M-1 — 프로비저닝 저장 작업: 데모 계정은 자기가 만든 것만(뺀 개수 · 탭도 보이는 것만) · 단건 404 · 관리자 무변경', () => {
  const h = harness('full');
  const V = h.views;
  const L = V['/api/provision/saved'];
  assert.equal(L.oper.st, 403, 'operator 는 vm.provision 이 없어 403 — operator 판본이 없다(구현 1회차 근거 정정)');
  assert.equal(L.demo.st, 200, L.demo.txt.slice(0, 200));
  const d = body(L.demo);
  assert.deepEqual(d.items, []); assert.equal(d.total, 0); assert.deepEqual(d.vcenters, [], '뺀 작업의 vCenter 를 탭으로 흘리지 않는다');
  assert.equal(d.demoOnly, true); assert.ok(Number.isInteger(d.demoMasked?.saved) && d.demoMasked.saved >= 1, JSON.stringify(d.demoMasked));
  assert.equal('excluded' in d, false, '내부 개수 칸은 싣지 않는다');
  for (const c of ['prvuserq', '10.66.45.45', '10.66.45.1', '10.66.45.2', 'prv-realq']) assert.equal(L.demo.txt.includes(c), false, `데모에 ${c}`);
  const f = body(L.fadm);
  assert.ok(f.items.some((e) => e.createdBy === 'prvuserq' && e.name === 'prv-realq-{n}'), '대조: 관리자는 전부 본다');
  assert.equal('demoOnly' in f, false); assert.equal('demoMasked' in f, false); assert.equal('excluded' in f, false);
  const one = V[`/api/provision/saved/${encodeURIComponent(h.seedIds.xProv)}`];
  assert.ok(one, '단건 경로'); assert.equal(one.demo.st, 404); assert.equal(one.fadm.st, 200); assert.equal(one.oper.st, 403);
  assert.equal(one.demo.txt.includes('prvuserq'), false);
});

test('③-n 반증 2회차 S-1 — Bareos 백업 대상: 데모 계정은 데모 대상만(뺀 개수) · 데모 대상의 만든 계정은 비운다 · 관리자 무변경 · 캐시 판본 분리', () => {
  const h = harness('full');
  const V = h.views;
  const B = V['/api/tools/bareos-backup'];
  assert.equal(B.oper.st, 403);
  assert.equal(B.demo.st, 200, B.demo.txt.slice(0, 200));
  const d = body(B.demo);
  assert.deepEqual(d.jobs.map((j) => j.bareosJob), ['bj-mockdemo']);
  assert.equal(d.jobs[0].createdBy, '', '데모 대상이어도 만든 포탈 계정은 비운다(키는 남긴다)');
  assert.equal(d.demoOnly, true); assert.deepEqual(d.demoMasked, { jobs: 1 });
  for (const c of ['bjbyuserq', 'cl-realq', 'bj-realq', 'bjdemouserq']) assert.equal(B.demo.txt.includes(c), false, `데모에 ${c}`);
  assert.ok(d.directors.every((x) => x.jobs === 0 || x.id === 'mock-bareos-dir'), '법인별 대상 수도 보이는 대상만');
  const f = body(B.fadm);
  assert.deepEqual(f.jobs.map((j) => j.bareosJob).sort(), ['bj-mockdemo', 'bj-realq']);
  assert.ok(f.jobs.some((j) => j.createdBy === 'bjbyuserq') && f.jobs.some((j) => j.createdBy === 'bjdemouserq'));
  assert.equal('demoOnly' in f, false); assert.equal('demoMasked' in f, false);
  // 같은 경로 · 형제 경로(진행 현황 · 복원 폴더)도 사람 Director 의 대상을 싣지 않는다
  assert.ok(V['/api/tools/bareos-backup/live'].fadm.txt.includes('cl-realq'), '대조: 관리자 진행 현황에는 사람 Director 대상의 실행 행이 있다(시드가 실행 중)');
  for (const p of ['/api/tools/bareos-backup/live', '/api/tools/bareos-backup/restore-folders']) {
    assert.equal(V[p].demo.st, 200, `${p} ${V[p].demo.txt.slice(0, 160)}`);
    for (const c of ['bjbyuserq', 'cl-realq', 'bj-realq', 'bjdemouserq', 'pendbyuserq']) assert.equal(V[p].demo.txt.includes(c), false, `${p} 데모에 ${c}`);
  }
  // 복원 폴더는 '대상이 있는 vCenter' 의 인벤토리 폴더 수 — 두 대상이 같은 vCenter 라 판본이 같다(대상 판정 연결은 ④-d 소스 스윕이 고정)
  assert.deepEqual(body(V['/api/tools/bareos-backup/restore-folders'].demo).folders, body(V['/api/tools/bareos-backup/restore-folders'].fadm).folders);
  // ③-a 스윕은 관리자 응답이 캐시된 뒤 데모로 다시 부른다 — 그 응답도 데모 판본이어야 한다(dg 열쇠)
  const sw = h.sweep.find((x) => x.url === '/api/tools/bareos-backup');
  assert.ok(sw && !sw.demo.includes('bjbyuserq') && !sw.demo.includes('cl-realq'), '관리자 → 데모 순서에서도 데모 판본');
});

test('③-o 반증 2회차 순수 판정 — savedShownTo(데모 = 자기 것만, 빈 이름 금지) · bareosJobShownTo(데모 = demo:true 만)', async () => {
  const { savedShownTo } = await import('../src/routes/api/provision.js');
  const { bareosJobShownTo } = await import('../src/routes/api/bareosBackup.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const adm = { username: 'a', role: 'admin' };
  const op = { username: 'o', role: 'operator' };
  assert.equal(savedShownTo(demo, { createdBy: 'thedvcdemp' }), true);
  assert.equal(savedShownTo(demo, { createdBy: 'prvuserq' }), false);
  assert.equal(savedShownTo(demo, { createdBy: 'unknown' }), false);
  assert.equal(savedShownTo({ role: 'admin', demoGuest: true, username: '' }, { createdBy: '' }), false, '빈 이름끼리 같다고 보지 않는다');
  assert.equal(savedShownTo(demo, null), false);
  assert.equal(savedShownTo(adm, { createdBy: 'prvuserq' }), true); assert.equal(savedShownTo(op, { createdBy: 'prvuserq' }), true, '다른 역할은 바꾸지 않는다');
  assert.equal(bareosJobShownTo(demo, { demo: true }), true);
  for (const j of [{ demo: false }, {}, { demo: 'true' }, { demo: 1 }, null]) assert.equal(bareosJobShownTo(demo, j), false, JSON.stringify(j));
  assert.equal(bareosJobShownTo(adm, { demo: false }), true); assert.equal(bareosJobShownTo(op, {}), true);
  // listSaved include — 범위 안에서 뺀 수(범위 밖과 따로) · 탭(vcenters)도 보이는 것만 · include 없으면 칸 없음
  const SV = await import('../src/provision/saved.js');
  SV.addSaved({ spec: { vcenterId: 'vc-a', namePattern: 'pa' }, source: { vcenterId: 'vc-a' }, user: { username: 'thedvcdemp' } });
  SV.addSaved({ spec: { vcenterId: 'vc-b', namePattern: 'pb' }, source: { vcenterId: 'vc-b' }, user: { username: 'other' } });
  SV.addSaved({ spec: { vcenterId: 'vc-c', namePattern: 'pc' }, source: { vcenterId: 'vc-c' }, user: { username: 'other' } });
  const inc = (e) => savedShownTo(demo, e);
  const r1 = SV.listSaved({ include: inc });
  assert.deepEqual(r1.items.map((e) => e.name), ['pa']); assert.equal(r1.total, 1); assert.equal(r1.excluded, 2); assert.deepEqual(r1.vcenters, ['vc-a']);
  const r2 = SV.listSaved({ include: inc, allowed: new Set(['vc-a', 'vc-b']) });
  assert.equal(r2.excluded, 1, '범위 밖(vc-c)은 뺀 수에 넣지 않는다');
  const r3 = SV.listSaved({ include: inc, vcenterId: 'vc-b' });
  assert.equal(r3.total, 0); assert.equal(r3.excluded, 2, '뺀 수는 vCenter 필터 전 기준');
  const r4 = SV.listSaved({});
  assert.equal('excluded' in r4, false); assert.deepEqual(r4.vcenters, ['vc-a', 'vc-b', 'vc-c']);
});

/* ─────────────────────────── ④ 소스 스윕 ─────────────────────────── */

test('④-b 반증 1회차 M-1 소스 — 백업 실행 · 관리 라우트의 Veeam 서버 · 실행 기록 · 포탈 기록은 데모 판정 함수를 거친다', () => {
  const run = read('routes/api/backupRun.js');
  const man = read('routes/api/backupManage.js');
  const lineOf = (s, i) => s.slice(s.lastIndexOf('\n', i) + 1, s.indexOf('\n', i)).trim();
  // serversForVcenter 직접 호출은 serversFor 본문 · 뺀 개수 계산(demoMaskedOf)만
  const sv = [...run.matchAll(/\bserversForVcenter\(/g)].map((m) => lineOf(run, m.index));
  assert.equal(sv.length, 2, sv.join('\n'));
  assert.ok(sv.some((l) => /const all = serversForVcenter\(vcenterId\)/.test(l)) && sv.some((l) => /isDemoVeeamServerId\(d\.id\)/.test(l)), sv.join('\n'));
  assert.equal(/\bserversForVcenter\b/.test(man), false, 'backupManage 는 serversFor 를 쓴다');
  // 실행 기록 노출 판정은 runShownTo — runVisible 은 그 안에서만
  const rv = [...run.matchAll(/\brunVisible\(/g)].map((m) => lineOf(run, m.index));
  assert.ok(rv.every((l) => /if \(!runVisible\(run, allowed\)\) return false;|inScope = all\.filter\(\(r\) => runVisible\(r, allowed\)\)/.test(l)), rv.join('\n'));
  assert.equal(/\brunVisible\b/.test(man), false);
  for (const s of [run, man]) for (const m of s.matchAll(/\bapi\.get\('\/tools\/backup-run\/(runs\/:id|vm\/:vmId)'/g)) assert.ok(/runShownTo\(req,/.test(s.slice(m.index, s.indexOf('\n});', m.index))), m[1]);
  // 포탈 기록: 단건(getPortalVm)은 portalRecordShownTo 를 거친 값만 · 목록은 거른 뒤
  assert.ok(/const record = portalRecordShownTo\(req, rec0\) \? rec0 : null;/.test(man));
  assert.equal([...man.matchAll(/\bgetPortalVm\(/g)].length, 1);
  assert.ok(/inScope\.filter\(\(r\) => portalRecordShownTo\(req, r\)\)/.test(man));
  // 설정 탭은 READ_DENY
  assert.ok(read('auth/demoGuest.js').includes("'/api/tools/backup-run/settings'"));
});

test('④-c 반증 1회차 S-2 소스 — 계정 이름 가림을 건 라우트(데모 계정 · operator 403 · 사람 관리자의 기록이 실린다)', () => {
  const need = [
    ['routes/api/bareosLive.js', /demoAccountView\(req\.user, sites\.map\(/, /\|g\$\{isDemoGuest\(req\.user\) \? 1 : 0\}/],
    ['routes/api/bareosBackup.js', /runs: demoAccountView\(req\.user, list, \['by'\]\)/],
    ['routes/api/bareosGroups.js', /return demoAccountView\(req\.user, \{ \.\.\.groupView\(g, now\)/],
    ['routes/api/vmClone.js', /ops: demoAccountView\(req\.user, listOpsView\(\{ allowed \}\), \['by'\]\)/],
    ['routes/api/sanFlow.js', /json\(demoAccountView\(req\.user, \{ ok: true, devices, flows: out/, /job: demoAccountView\(req\.user, maskJob\(/],
    ['routes/api/focusMonAudit.js', /res\.json\(demoAccountView\(req\.user, \{\s*\n?\s*ok: true, now: Date\.now\(\), mock:/, /jobs: demoAccountView\(req\.user, jobs, \['by'\]\)/, /runs: demoAccountView\(req\.user, runs\.map\(/, /run: demoAccountView\(req\.user, \{ \.\.\.lastView\(row\)/],
  ];
  for (const [f, ...res] of need) { const s = read(f); for (const re of res) assert.ok(re.test(s), `${f} ${re}`); }
});

test('④-d 반증 2회차 소스 — 저장 작업 · Bareos 대상 · 데모 Veeam 판정의 사용처', () => {
  const pv = read('routes/api/provision.js');
  assert.ok(/listSaved\(\{[^}]*\ballowed: scopeOf\(req\), include \}\)/.test(pv), 'listSaved 는 include(데모 판정)와 함께');
  assert.equal([...pv.matchAll(/\blistSaved\(/g)].length, 1);
  assert.ok(/getSaved\(req\.params\.id\)[\s\S]*?if \(!savedShownTo\(req\.user, item\)\) return res\.status\(404\)/.test(pv), '단건도 같은 판정');
  const bb = read('routes/api/bareosBackup.js');
  assert.ok(/const jobs = inScopeJobs\.filter\(\(j\) => bareosJobShownTo\(req\.user, j\)\)/.test(bb));
  assert.ok(/const views = demoAccountView\(req\.user, jobs\.map\(/.test(bb));
  assert.ok(/`dg=\$\{isDemoGuest\(req\.user\) \? 1 : 0\}`/.test(bb), '목록 캐시 열쇠에 데모 계정 축');
  assert.ok(/const jobs = scopedJobs\(req\.user\)\.jobs\.filter\(\(j\) => bareosJobShownTo\(req\.user, j\)\)/.test(bb), '복원 폴더');
  assert.ok(/\|dg=\$\{isDemoGuest\(req\.user\) \? 1 : 0\}` \}\)\)/.test(bb), '복원 폴더 캐시 열쇠');
  assert.equal([...bb.matchAll(/\bscopedJobs\(req\.user\)/g)].length, 2, '목록 · 복원 폴더 둘 다 판정을 거친다(새 사용처는 여기에 더할 것)');
  assert.ok(/jobDigests\(\)\.filter\(\(j\) => allow\.has\(j\.vcenterId\) && bareosJobShownTo\(req\.user, j\)\)/.test(read('routes/api/bareosLive.js')), '진행 현황');
  // 데모 Veeam 판정 코어 하나 — 폴러와 백업 실행이 같은 함수
  assert.ok(/if \(isDemoVeeamServerId\(full\.id\)\) return null;/.test(read('veeam/poller.js')));
  assert.equal(/startsWith\('mock-'\)/.test(read('veeam/poller.js')), false);
  assert.ok(/export const isDemoVeeamServerId = \(id\) => String\(id \?\? ''\)\.startsWith\('mock-'\);/.test(read('veeam/registry.js')));
  assert.equal(/\/\^mock-\/i/.test(read('routes/api/backupRun.js')), false, '백업 실행에 사본 판정이 없다');
});

test('④ L7 소스 — iDRAC 조회 캐시 열쇠는 idracViewSig · sc.allowed 직접 사용처 허용 목록 · /assignments GET 이 demoRegistryView', () => {
  for (const f of ['routes/admin/idracCore.js', 'routes/admin/idracTrend.js']) {
    const s = read(f);
    for (const m of s.matchAll(/snapMemo\(\s*'idrac-(?:parts|trend-table)'\s*,\s*key/g)) {
      const head = s.slice(Math.max(0, m.index - 900), m.index);
      assert.ok(/const key = [^\n]*idracViewSig\(req\)/.test(head), `${f} 캐시 열쇠에 idracViewSig 없음`);
    }
  }
  const core = read('routes/admin/idracCore.js');
  const uses = [...core.matchAll(/\bsc\.allowed\b/g)].map((m) => core.slice(core.lastIndexOf('\n', m.index) + 1, core.indexOf('\n', m.index)).trim());
  for (const u of uses) assert.ok(/for \(const vc of r\.sc\.allowed\)|demoOnly|return !!vc && sc\.allowed\.has\(vc\)|vcOk|return scopeSig\(sc \? sc\.allowed : null\)/.test(u), `허용 목록 밖 sc.allowed 사용: ${u}`);
  const ha = read('routes/admin/horizonAssign.js');
  const i = ha.indexOf("adminRouter.get('/assignments'");
  assert.ok(i > 0 && /demoRegistryView\(req\)/.test(ha.slice(i, ha.indexOf('});', i))));
});

/* ─────────────────────────── ⑤ ~ ⑧ L8 ─────────────────────────── */

test('⑤ L8 /api/admin/logs — 비밀 원문 0 · 가린 줄 표지 · 개수 · 가리면 안 되는 줄 그대로 · 길이 유지 · 증분 · 수준 필터', () => {
  const { logs } = harness('full');
  const { l1, l2, l3, lines, expected } = logs;
  const all = JSON.stringify(l1);
  for (const secret of ['hunter2zz', 'tokZZ123', 'SuperPwZZ', 'brZZ999', 'a b zz', 'tailZZ9', 'warnZZ7']) assert.equal(all.includes(secret), false, secret);
  assert.equal(l1.redacted, true);
  const masked = l1.items.filter((x) => x.masked === true);
  assert.equal(l1.maskedLines, masked.length);
  assert.equal(masked.length, 7, '비밀이 든 줄 6 + warn 1');
  assert.equal(l1.count, l1.items.length);
  const keep = l1.items.find((x) => x.msg === 'pass=3 deviceKey=dk-1 tokenFp=ab12');
  assert.ok(keep, '가리면 안 되는 식별자 줄은 원문 그대로');
  assert.equal('masked' in keep, false);
  const longOut = l1.items.find((x) => x.msg.startsWith('xxxx'));
  assert.equal(longOut.msg, expected[lines.length - 1], '로컬 뷰어는 2,000자로 자르지 않는다');
  assert.ok(longOut.msg.length > 7990);
  for (let k = 0; k < lines.length; k += 1) assert.ok(l1.items.some((x) => x.msg === expected[k]), `줄 ${k}`);
  assert.deepEqual(l2.items.map((x) => x.msg), ['after secret=[가림]']);
  assert.equal(l2.maskedLines, 1);
  assert.ok(l3.items.length >= 1 && l3.items.every((x) => x.level === 'warn'));
  assert.equal(JSON.stringify(l3).includes('warnZZ7'), false);
});

test('⑥ L8 형제 동일성 — 같은 줄에 대해 /api/admin/logs = collectEdgeLog = redactLogLine(가린 뒤 2,000자 이하 줄)', () => {
  const { logs } = harness('full');
  const edgeById = new Map(logs.edge.map((x) => [x.id, x.msg]));
  let n = 0;
  for (const it of logs.l1.items) {
    if (!edgeById.has(it.id) || it.msg.length > 2000) continue;
    assert.equal(it.msg, edgeById.get(it.id), `id ${it.id}`);
    n += 1;
  }
  assert.ok(n >= 7, `대조한 줄 ${n}`);
});

test('⑦ L8 redactLogEntries — 가림 함수가 던지면 그 줄은 원문 없이 표지(fail-closed) · 나머지 줄은 그대로', async () => {
  const { redactLogEntries } = await import('../src/edgelog/redactEntries.js');
  const boom = () => { throw new Error('x'); };
  const r = redactLogEntries([{ id: 1, time: 1, level: 'info', msg: 'password=zz1' }], { redact: boom });
  assert.equal(r.items[0].masked, true);
  assert.equal(r.items[0].msg.includes('zz1'), false);
  assert.match(r.items[0].msg, /가림 실패/);
  assert.equal(r.masked, 1);
  const ok = redactLogEntries([{ id: 2, time: 1, level: 'info', msg: 'hello' }, { id: 3, time: 1, level: 'warn', msg: 'token=abc' }, null]);
  assert.deepEqual(ok.items.map((x) => x.msg), ['hello', 'token=[가림]', '']);
  assert.equal(ok.masked, 1);
  assert.equal(ok.items[1].masked, true);
  assert.equal('masked' in ok.items[0], false);
  // lineMax 는 가린 **뒤** 자른다(18회차 A-1 순서)
  const cut = redactLogEntries([{ id: 4, time: 1, level: 'info', msg: `${'y'.repeat(10)} https://u:longsecretZZ@h/x` }], { lineMax: 20 });
  assert.equal(cut.items[0].msg.includes('longsecret'), false);
  assert.equal(cut.items[0].msg.length, 20);
});

test('⑧ L8 소스 — 콘솔 링버퍼(getLogs) 호출처 허용 목록 · 응답 출구는 redactLogEntries · /logs 가 원문을 직접 내보내지 않는다', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(SRC);
  const callers = files.filter((p) => /\bgetLogs\(/.test(stripComments(fs.readFileSync(p, 'utf8'))) && !p.endsWith(`${path.sep}logbuffer.js`)).map((p) => path.relative(SRC, p).split(path.sep).join('/')).sort();
  assert.deepEqual(callers, ['edgelog/collect.js', 'loganalysis/live.js', 'routes/admin/logAnalysis.js', 'routes/admin/statusTools.js']);
  for (const f of ['edgelog/collect.js', 'routes/admin/statusTools.js']) assert.ok(/\bredactLogEntries\(/.test(read(f)), f);
  const st = read('routes/admin/statusTools.js');
  const i = st.indexOf("adminRouter.get('/logs'");
  assert.ok(i > 0);
  assert.equal(/res\.json\(\s*getLogs\(/.test(st.slice(i, st.indexOf('});', i))), false);
});

// ── 반증 3회차(must 2 · should 1) ─────────────────────────────────────────────────────────────────────────────
test('③-r3 must 1: vCenter 스캔 대역 /24 가져오기(kind=idrac) — 데모는 403(등록부 원문 없음) · 관리자는 원문 · kind=vm 은 데모도 200', () => {
  const h = harness('full');
  const vc = encodeURIComponent(h.seedIds ? '' : '');
  void vc;
  const key = Object.keys(h.views).find((p) => p.startsWith('/api/admin/ipam/vc-ranges/suggest?kind=idrac'));
  const v = h.views[key];
  assert.equal(v.demo.st, 403, v.demo.txt);
  assert.equal(body(v.demo).demoGuest, true);
  assert.ok(!v.demo.txt.includes('10.66.4.'), '데모에 iDRAC 스캔 대역 원문');
  assert.equal(v.fadm.st, 200, v.fadm.txt);
  assert.ok(v.fadm.txt.includes('10.66.4.0/24'), '관리자 판본이 바뀌었다(대역 원문이 있어야 한다)');
  assert.equal(v.oper.st, 403, 'operator 는 adminOnly 403 그대로');
  const vm = h.views[Object.keys(h.views).find((p) => p.startsWith('/api/admin/ipam/vc-ranges/suggest?kind=vm'))];
  assert.equal(vm.demo.st, 200, 'VM 대역 가져오기(mock VM 서브넷)는 데모도 쓴다: ' + vm.demo.txt.slice(0, 200));
});

test('③-r3 must 2: 게스트 파티션 메일 상태 — 데모 판본에 SMTP 보내는 주소 없음 · 관리자 판본은 그대로', () => {
  const v = harness('full').views['/api/tools/guest-partition/mail'];
  assert.equal(v.demo.st, 200, v.demo.txt);
  assert.ok(!lower(v.demo.txt).includes('qmail3@corpq.example'), '데모에 보내는 주소: ' + v.demo.txt.slice(0, 300));
  assert.equal(body(v.demo).server.from, undefined);
  assert.equal(body(v.demo).server.configured, true, '설정 여부는 그대로');
  assert.equal(v.fadm.st, 200);
  assert.equal(body(v.fadm).server.from, 'qmail3@corpq.example', '관리자 판본이 바뀌었다');
});

test('③-r3 데모 판본 메일 상태 — 실패 사유 · 마지막 오류의 메일 주소를 가리고 원본은 바꾸지 않는다', async () => {
  const { demoMailStatusView } = await import(path.join(SRC, 'routes/api/toolsGuestPart.js'));
  const st = { history: [{ at: 1, kind: 'digest', ok: false, reason: '550 5.1.1 <qmail9@corpq.example> recipient rejected' }, { at: 2, ok: true, note: 'to qmail8@corpq.example' }, null],
    lastError: { at: 3, message: 'RCPT qmail7@corpq.example refused' }, edge: false };
  const v = demoMailStatusView(st);
  assert.ok(!JSON.stringify(v).includes('@corpq.example'), JSON.stringify(v));
  assert.match(v.history[0].reason, /^550 5\.1\.1 </);
  assert.equal(v.history[2], null);
  assert.equal(v.lastError.at, 3);
  assert.equal(st.history[0].reason.includes('qmail9@corpq.example'), true, '원본을 바꿨다');
  assert.equal(demoMailStatusView(null), null);
  assert.deepEqual(demoMailStatusView({ history: [], lastError: null }), { history: [], lastError: null });
});

test('③-r3 should: 필수 질의를 채워도 데모가 2xx 를 못 받는 GET 은 알려진 목록 안에만(새 필수 질의 라우트가 스윕에서 조용히 빠지지 않게)', () => {
  const h = harness('full');
  assert.ok(Array.isArray(h.still400) && h.tableMiss && typeof h.tableMiss === 'object' && Array.isArray(h.routeTableKeys), '하네스가 still400 · tableMiss 를 내보내지 않았다');
  const why = h.still400Why || {};
  const extra = h.still400.filter((r) => !STILL400_KNOWN.includes(r)).map((r) => `${r} — ${why[r] || ''}`);
  assert.deepEqual(extra, [], '필수 질의 표에 없는 데모 400 GET — 하네스 ROUTE_QUERIES 에 그 라우트의 실제 질의를 더하거나(스윕 대상) STILL400_KNOWN 에 근거와 함께 적을 것');
  const miss = Object.entries(h.tableMiss).filter(([r]) => !STILL400_KNOWN.includes(r)).map(([r, w]) => `${r} — ${w}`);
  assert.deepEqual(miss, [], '질의 표가 데모 2xx 를 만들지 못한 라우트 — 표의 키 · 시드를 고칠 것(마지막 응답이 사유)');
  const stale = STILL400_KNOWN.filter((r) => !h.still400.includes(r) && !Object.hasOwn(h.tableMiss, r));
  assert.deepEqual(stale, [], '이제 데모가 2xx 를 받는 항목 — STILL400_KNOWN 에서 지울 것');
  for (const r of R3_FIRST_RUN_26) assert.ok(h.routeTableKeys.includes(r), `질의 표에 ${r} 가 없다`);
  assert.deepEqual(h.routeTableDead, [], '라우터 스택에 없는 표 항목(라우트 이름이 바뀌었다 — 표를 고칠 것)');
  const swept = new Set(h.sweep.map((x) => x.route));
  const notSwept = h.routeTableKeys.filter((r) => !STILL400_KNOWN.includes(r) && !swept.has(r));
  assert.deepEqual(notSwept, [], '표로 2xx 를 받았다는 라우트가 ③-a 스윕에 없다');
});

test('③-r3f 반증 3회차 후속(표가 드러냄) — 리소스 적정성(capacity · adminOnly): 데모는 포탈 자신 + 데모 엣지만(뺀 개수) · 사람 엣지 단건 404 · 관리자 무변경', () => {
  const h = harness('full');
  const V = h.views;
  const S = V['/api/capacity/summary'];
  assert.equal(S.demo.st, 200, S.demo.txt.slice(0, 200));
  assert.equal(S.oper.st, 403, 'operator 는 adminOnly 403 — operator 판본이 없다');
  const d = body(S.demo);
  assert.deepEqual(d.hosts.map((x) => x.k).sort(), ['local', 'mock-Edge-Seoul']);
  assert.equal(d.demoOnly, true); assert.deepEqual(d.demoMasked, { hosts: 1 });
  for (const c of ['edgehost-realq', 'edge-realq']) assert.equal(S.demo.txt.includes(c), false, `데모 요약에 ${c}`);
  const f = body(S.fadm);
  assert.deepEqual(f.hosts.map((x) => x.k).sort(), ['edge-realq', 'local', 'mock-Edge-Seoul'], '관리자 판본이 바뀌었다');
  assert.ok(S.fadm.txt.includes('edgehost-realq'));
  assert.equal('demoOnly' in f, false); assert.equal('demoMasked' in f, false);
  for (const p of ['/api/capacity/host?k=edge-realq', `/api/capacity/history?k=edge-realq&metric=${encodeURIComponent(h.capMetric)}&window=day`]) {
    assert.equal(V[p].demo.st, 404, `${p} ${V[p].demo.txt.slice(0, 160)}`);
    assert.equal(V[p].demo.txt.includes('edgehost-realq'), false);
    assert.equal(V[p].fadm.st, 200, `${p} 관리자 대조 ${V[p].fadm.st}`);
  }
  assert.ok(V['/api/capacity/host?k=edge-realq'].fadm.txt.includes('edgehost-realq'), '대조: 관리자는 사람 엣지 호스트 이름을 본다');
  assert.ok(body(V[`/api/capacity/history?k=edge-realq&metric=${encodeURIComponent(h.capMetric)}&window=day`].fadm).points.length >= 1, '대조: 관리자는 사람 엣지 추이를 본다(시드가 들어갔다)');
  for (const p of ['/api/capacity/host?k=local', '/api/capacity/host?k=mock-Edge-Seoul']) {
    assert.equal(V[p].demo.st, 200, `${p} ${V[p].demo.txt.slice(0, 160)}`);
    assert.deepEqual(body(V[p].demo).meta, body(V[p].fadm).meta, `${p} 데모 · 포탈 자신 행은 관리자와 같다`);
  }
});

test('③-r3f 순수 판정 — capacityHostShownTo(데모 = local · mock- 만, 판정이 던지면 제외) · capacityPushView(데모 판본만 중앙 URL · 실패 사유를 비운다)', async () => {
  const { capacityHostShownTo, capacityPushView } = await import('../src/routes/capacity.js');
  const demo = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
  const adm = { username: 'a', role: 'admin' };
  for (const k of ['local', 'mock-Edge-Seoul', 'MOCK-x']) assert.equal(capacityHostShownTo(demo, k), true, k);
  for (const k of ['edge-realq', 'Local', '', 'xmock-1', null, undefined, { toString() { throw new Error('x'); } }]) assert.equal(capacityHostShownTo(demo, k), false, String(typeof k));
  for (const k of ['edge-realq', 'local', '']) { assert.equal(capacityHostShownTo(adm, k), true); assert.equal(capacityHostShownTo({ role: 'operator' }, k), true); }
  const edgePush = { enabled: true, centralUrl: 'https://10.66.60.60:4000', agent: 'edge-a', intervalMs: 60000, unsupportedUntil: null, last: { at: 1, ok: false, status: 0, rows: 0, reason: 'connect ECONNREFUSED 10.66.60.60:4000' } };
  const v = capacityPushView(demo, edgePush);
  assert.equal(JSON.stringify(v).includes('10.66.60.60'), false, JSON.stringify(v));
  assert.equal(v.addressHidden, true); assert.equal(v.enabled, true); assert.equal(v.last.at, 1);
  assert.equal(edgePush.centralUrl, 'https://10.66.60.60:4000', '원본을 바꿨다');
  assert.equal(capacityPushView(adm, edgePush), edgePush, '관리자 판본은 원본 그대로');
  const central = { enabled: false, centralUrl: '', agent: '', intervalMs: 60000, unsupportedUntil: null, last: null };
  assert.equal(capacityPushView(demo, central), central, '중앙(push 꺼짐)은 관리자와 같은 모양');
  assert.equal(capacityPushView(demo, null), null);
});
