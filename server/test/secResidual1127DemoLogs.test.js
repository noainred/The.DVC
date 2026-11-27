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
    const express = (await import('express')).default;
    const auth = await import(${J('auth/auth.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh();
    const snap = store.get();
    const vcs = (snap.vcenters || []).map((v) => String(v.id));
    const host0 = (snap.hosts || []).find((h) => h.serviceTag && h.vcenterId) || null;
    const seeds = {};
    const tryi = async (k, f) => { try { const r = await f(); seeds[k] = r && r.ok === false ? 'FAIL ' + JSON.stringify(r).slice(0, 200) : 'ok'; } catch (e) { seeds[k] = 'ERR ' + e.message; } };
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
    await tryi('mail', async () => (await import(${J('mail/settings.js')})).save({ defaultTo: ['qmail1@corpq.example'] }));
    await tryi('bmHist', async () => {
      const BR = await import(${J('bmstor/registry.js')});
      const human = BR.listBmServers().find((x) => x.name === 'bm-realq');
      const H = await import(${J('bmstor/history.js')});
      const slot = H.slotOf(Date.now()) - 1;
      const row = (kind, key, name) => ({ kind, key, name, totalBytes: 1e12, usedBytes: 5e11, availBytes: 5e11, servers: 1, read: 1 });
      return (await import(${J('bmstor/historyDb.js')})).commitBmHistory({ slot, ts: Date.now() - 3600e3, rows: [row('server', human.id, 'bm-realq'), row('server', 'mock-bm-t1', 'mockbm-01'), row('group', 'grp-realq', 'grp-realq'), row('total', '', '전체 합계')] });
    });
    await tryi('usageMail', async () => (await import(${J('storage/usageMail.js')})).saveUsageMailSettings({ enabled: false, to: ['qmail2@corpq.example'] }));
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
    const gets = [];
    const walk = (stack, pre) => { for (const l of stack) {
      if (l.route) { if (l.route.methods.get) gets.push(pre + l.route.path); }
      else if (l.handle && l.handle.stack) { const m = (l.regexp && l.regexp.source || '').match(/^\\^\\\\\\/(.*?)\\\\\\/\\?\\(\\?=/); walk(l.handle.stack, pre + (m ? '/' + m[1].replace(/\\\\\\//g, '/') : '')); } } };
    for (const [pre, f, n] of mods) { const m = await import(R + f); walk(m[n].stack, pre); app.use(pre, auth.authMiddleware, auth.requireEnrolled, m[n]); }
    app.use((err, req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const base = 'http://127.0.0.1:' + port;
    const call = async (who, p) => {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
      try { const r = await fetch(base + p, { headers: { authorization: 'Bearer ' + TOK[who] }, signal: ac.signal }); return { st: r.status, txt: await r.text() }; }
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
    if (${JSON.stringify(phase)} === 'base') {
      out.views = {};
      for (const p of IDRAC_VIEWS) out.views[p] = { demo: await pick('demo', p), fadm: await pick('fadm', p) };
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
        '/api/admin/central/token-apply/jobs', '/api/tools/bm-usage/ssh-keys', '/api/tools/storage-usage/mail', '/api/admin/idrac/trend/export.csv'])
        out.views[p] = { demo: await pick('demo', p), fadm: await pick('fadm', p), oper: await pick('oper', p) };
      // M-1 절대형 · 겹친 슬래시(원시 소켓 — fetch 는 대상을 정규화한다)
      out.raw = {};
      for (const t of ['http://x/api/admin/logs', 'HTTP://X/API/ADMIN/USERS', '/api//tools/server-info', '/api/admin//users', 'http://x/api/admin/idrac', '/api/admin//idrac'])
        out.raw[t] = await raw('demo', t);
      // ③-a 일반 불변식 — 모든 GET
      const uniq = [...new Set(gets)];
      const sweep = [];
      for (const g of uniq) {
        const u = g.replace(/\\/idrac\\/:id/g, '/idrac/idrac-realq').replace(/:[A-Za-z_]\\w*/g, 'x');
        const d = await call('demo', u);
        if (!(d.st >= 200 && d.st < 300)) continue;
        const o = await call('oper', u);
        sweep.push({ route: g, url: u, demo: d.txt, oper: o.st >= 200 && o.st < 300 ? o.txt : '', operSt: o.st });
      }
      out.sweep = sweep; out.totalGets = uniq.length;
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
  assert.ok(h.sweep.length > 300, `데모 2xx GET ${h.sweep.length}/${h.totalGets}`);
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
});

/* ─────────────────────────── ④ 소스 스윕 ─────────────────────────── */

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
