/**
 * v2.611 감사 그룹 B — 권한·범위(scope). 하니스는 audit2607a 와 같다(실제 adminRouter 를 express 에 마운트하고
 * 요청자를 헤더로 주입 — 'full' = 전체 범위 admin, 'sadm' = vc-us-east 로 범위가 제한된 admin). **상태코드·파일 상태**로 본다.
 *   AUTHZ2611-01 iDRAC 등록부 쓰기·스캔 실행(재귀속 → 삭제로 범위 밖 서버 제거)
 *   AUTHZ2611-02 전 법인 등록부(vCenter 가져오기 replace · 수집 서버 · DataCenter · Horizon · 배정 · 물리 GPU · 엣지 배포 ·
 *                LLM · NFS · 폴더 사용량) — v2.607 fleetWideOnly 의 형제
 *   AUTHZ2611-03 서버 로그·/status·relay-test
 *   AUTHZ2611-04 연동 키 발급·수정
 *   AUTHZ2611-05 site vCenter 병합에서 location.region 은 등록부 값 우선(엣지가 지역 범위를 바꾸지 못한다)
 *   LEFT2611-02·04·07 IPAM 설정 범위 병합 · 대역 CSV dryRun 존재 은닉 · 스캔 설정/상태 게이트
 *   LEFT2611-03 GPU 게스트 설정 범위 + 계정명 변경 시 비밀번호 비승계
 *   LEFT2611-05 FinOps 숫자 칸 빈 값 = 미지정 · 명시적 0 = 값
 *   LEFT2611-06 수집 서버 URL 끝 '/' 제거 선형 + 길이 상한
 *   LEFT2611-08 중앙→엣지 호출에 수집 서버 id 태그
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611b-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    auth.createUser({ username: 'boss', role: 'admin', name: 'B' }, { trusted: true });
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'sub', role: 'viewer', name: 'U', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'operator', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true });
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter); app.use('/api/remote', remoteRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const userRec = (n) => auth.listUsers().find((x) => x.username === n) || null;
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}


const writeVcReg = (dir) => fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-us-east', name: 'vcenter-us-east.corp.local', host: 'https://10.0.0.1', username: 'u', password: 'p', maintenance: true },
  { id: 'vc-eu-west', name: 'vcenter-eu-west.corp.local', host: 'https://10.0.0.2', username: 'u', password: 'p', maintenance: true },
] }));

test('AUTHZ2611-02: 전 법인 등록부는 범위 admin 403 — vCenter 가져오기 replace(v2.607 우회로)가 막힌다', () => {
  const o = runChild(`
    out.impS = (await call('sadm', 'POST', '/admin/vcenters/import', { mode: 'replace', vcenters: [{ id: 'vc-y', name: 'Y', host: 'https://10.9.9.9', username: 'a', password: 'b' }] })).s;
    out.impFileS = (await call('sadm', 'POST', '/admin/vcenters/import-file', { path: '/etc/vmware-portal/x.json', mode: 'replace' })).s;
    out.nsxPostS = (await call('sadm', 'POST', '/admin/nsx/managers', {})).s;
    out.nsxPostF = (await call('full', 'POST', '/admin/nsx/managers', {})).s;
    out.colGetS = (await call('sadm', 'GET', '/admin/collectors')).s;
    out.colGetF = (await call('full', 'GET', '/admin/collectors')).s;
    out.colPostS = (await call('sadm', 'POST', '/admin/collectors', { id: 'e1', name: 'E1', url: 'http://10.1.1.1:4000' })).s;
    out.colDelS = (await call('sadm', 'DELETE', '/admin/collectors/e1')).s;
    out.dcPostS = (await call('sadm', 'POST', '/admin/datacenters', { name: 'DCX' })).s;
    out.dcGetS = (await call('sadm', 'GET', '/admin/datacenters')).s;
    out.hzGetS = (await call('sadm', 'GET', '/admin/horizon')).s;
    out.hzGetF = (await call('full', 'GET', '/admin/horizon')).s;
    out.hzDelS = (await call('sadm', 'DELETE', '/admin/horizon/hz-b')).s;
    out.asgGetS = (await call('sadm', 'GET', '/admin/assignments')).s;
    out.asgPostS = (await call('sadm', 'POST', '/admin/assignments', { agent: 'x' })).s;
    out.physPostS = (await call('sadm', 'POST', '/admin/gpu-physical', { host: '10.2.2.2', username: 'r' })).s;
    out.edgeUserS = (await call('sadm', 'POST', '/admin/edge-users/x', { username: 'a' })).s;
    out.deployPutS = (await call('sadm', 'PUT', '/admin/gpu-guest/deploy/x', {})).s;
    out.collectUtilS = (await call('sadm', 'POST', '/admin/gpu/collect-util')).s;
    out.adTargetsS = (await call('sadm', 'GET', '/admin/agent-deploy/targets')).s;
    out.adTargetsF = (await call('full', 'GET', '/admin/agent-deploy/targets')).s;
    out.llmPutS = (await call('sadm', 'PUT', '/admin/llm-config', { provider: 'x' })).s;
    out.llmGetS = (await call('sadm', 'GET', '/admin/llm-config')).s;
    out.relNotesS = (await call('sadm', 'POST', '/admin/release-notes', {})).s;
    out.nfsS = (await call('sadm', 'GET', '/admin/nfs-mounts')).s;
    out.nfsF = (await call('full', 'GET', '/admin/nfs-mounts')).s;
    out.duPutS = (await call('sadm', 'PUT', '/admin/dir-usage', {})).s;
    out.duRunS = (await call('sadm', 'POST', '/admin/dir-usage/run', {})).s;
    out.duGetS = (await call('sadm', 'GET', '/admin/dir-usage')).s;
    out.metricsBefore = (await call('full', 'GET', '/admin/metrics/settings')).j.settings.retentionDays;
    const mp = await call('sadm', 'PUT', '/admin/metrics/settings', { retentionDays: 1 });
    out.metricsS = mp.s; out.metricsIgnored = mp.j.ignoredGlobal;
    out.metricsAfter = (await call('full', 'GET', '/admin/metrics/settings')).j.settings.retentionDays;
    out.vcCount = (readJson('vcenters.json')?.vcenters || []).length;
  `, { setup: writeVcReg });
  assert.equal(o.impS, 403, '수정 전: 200 added:1 — 등록 vCenter 전체를 교체했다');
  assert.equal(o.impFileS, 403);
  assert.equal(o.vcCount, 2, 'replace 가 막혀 등록부가 그대로');
  assert.equal(o.nsxPostS, 403); assert.notEqual(o.nsxPostF, 403);
  assert.equal(o.colGetS, 403); assert.equal(o.colGetF, 200);
  assert.equal(o.colPostS, 403); assert.equal(o.colDelS, 403);
  assert.equal(o.dcPostS, 403); assert.equal(o.dcGetS, 200, 'DataCenter 이름 목록은 그대로');
  assert.equal(o.hzGetS, 403, 'Horizon 등록부 조회도 403 — 형제 /tools/horizon-sessions 와 같은 기준'); assert.equal(o.hzGetF, 200);
  assert.equal(o.hzDelS, 403);
  assert.equal(o.asgGetS, 403); assert.equal(o.asgPostS, 403);
  assert.equal(o.physPostS, 403); assert.equal(o.edgeUserS, 403); assert.equal(o.deployPutS, 403);
  assert.equal(o.collectUtilS, 403);
  assert.equal(o.adTargetsS, 403); assert.equal(o.adTargetsF, 200);
  assert.equal(o.llmPutS, 403); assert.equal(o.llmGetS, 200);
  assert.equal(o.relNotesS, 403);
  assert.equal(o.nfsS, 403); assert.equal(o.nfsF, 200);
  assert.equal(o.duPutS, 403); assert.equal(o.duRunS, 403);
  // v2.621(감사 SEC-03): 조회도 403 — 응답이 RMA 엣지 IP·호스트명·fileRoots·마운트 경로를 싣는다(형제 /tools/rma 403 우회였다).
  assert.equal(o.duGetS, 403);
  assert.equal(o.metricsS, 200);
  assert.deepEqual(o.metricsIgnored, ['retentionDays'], '전역 스칼라는 적용하지 않고 밝힌다');
  assert.equal(o.metricsAfter, o.metricsBefore);
});

test('AUTHZ2611-01: iDRAC 재귀속·삭제·등록·스캔 실행은 범위 admin 403, 조회는 그대로', () => {
  const o = runChild(`
    out.addF = (await call('full', 'POST', '/admin/idrac', { id: 'b1', name: 'B1', host: 'https://10.3.3.1', username: 'root', password: 'x', vcenterId: 'vc-eu-west' })).s;
    out.assignS = (await call('sadm', 'POST', '/admin/idrac/assign-vcenter', { all: true, vcenterId: 'vc-us-east' })).s;
    out.deleteS = (await call('sadm', 'POST', '/admin/idrac/delete', { vcenterId: 'vc-us-east' })).s;
    out.putS = (await call('sadm', 'PUT', '/admin/idrac/b1', { vcenterId: 'vc-us-east' })).s;
    out.delOneS = (await call('sadm', 'DELETE', '/admin/idrac/b1')).s;
    out.addS = (await call('sadm', 'POST', '/admin/idrac', { id: 'b2', name: 'B2', host: 'https://10.3.3.2', username: 'root', password: 'x' })).s;
    out.pollS = (await call('sadm', 'POST', '/admin/idrac/poll')).s;
    out.rangesPutS = (await call('sadm', 'PUT', '/admin/idrac/scan-ranges', { datacenter: 'x', ranges: '10.0.0.0/30' })).s;
    out.rangesScanS = (await call('sadm', 'POST', '/admin/idrac/scan-ranges/scan', {})).s;
    out.powerPutS = (await call('sadm', 'PUT', '/admin/idrac/power-settings', {})).s;
    out.listS = (await call('sadm', 'GET', '/admin/idrac')).s;
    out.rangesGetS = (await call('sadm', 'GET', '/admin/idrac/scan-ranges')).s;
    const reg = readJson('idrac.json');
    out.regCount = Array.isArray(reg) ? reg.length : (reg?.servers || []).length;
  `);
  assert.equal(o.addF, 201, `전체 범위 admin 은 그대로 등록(${o.addF})`);
  assert.equal(o.assignS, 403, '수정 전: 200 updated — 범위 밖 서버를 자기 vCenter 로 재귀속');
  assert.equal(o.deleteS, 403, '수정 전: 200 removed — 재귀속 뒤 전량 삭제');
  assert.equal(o.putS, 403); assert.equal(o.delOneS, 403); assert.equal(o.addS, 403);
  assert.equal(o.pollS, 403); assert.equal(o.rangesPutS, 403); assert.equal(o.rangesScanS, 403); assert.equal(o.powerPutS, 403);
  assert.equal(o.listS, 200, 'GET 은 v2.604 정책 그대로(서버 분석 계열은 범위 미적용)');
  // v2.620(SEC2620-05): 스캔 대역 조회도 fleetOnly — 전 법인 IP 대역·iDRAC/iLO 계정명이 범위 관리자에게 열려 있었다(의도된 변경).
  assert.equal(o.rangesGetS, 403);
  assert.equal(o.regCount, 1, '범위 admin 의 요청은 등록부를 바꾸지 못했다');
});

test('AUTHZ2611-03: /logs 403 · /status 는 허용 vCenter 로 거른다 · relay-test 는 host 직접 지정 403 · 범위 밖 404', () => {
  const o = runChild(`
    out.logsS = (await call('sadm', 'GET', '/admin/logs')).s;
    out.logsF = (await call('full', 'GET', '/admin/logs')).s;
    const st = await call('sadm', 'GET', '/admin/status');
    out.stS = st.s; out.stVc = st.j.vcenters; out.stScoped = st.j.scoped;
    out.stF = (await call('full', 'GET', '/admin/status')).j.vcenters;
    out.relayHostS = (await call('sadm', 'GET', '/admin/vcenter/relay-test?host=10.9.9.9')).s;
    out.relayOutS = (await call('sadm', 'GET', '/admin/vcenter/relay-test?vcenterId=vc-eu-west')).s;
    out.codexS = (await call('sadm', 'POST', '/admin/codex-check/write')).s;
  `, { setup: writeVcReg });
  assert.equal(o.logsS, 403, '수정 전: 200 — 형제 로그 분석은 403 인데 원문은 열렸다'); assert.equal(o.logsF, 200);
  assert.equal(o.stS, 200); assert.equal(o.stScoped, true);
  assert.equal(o.stVc, 1, '수정 전: 전 함대 vCenter 수');
  assert.ok(o.stF > 1);
  assert.equal(o.relayHostS, 403); assert.equal(o.relayOutS, 404);
  assert.equal(o.codexS, 403);
});

test('AUTHZ2611-04: 연동 키 발급·수정·폐기는 전체 범위 계정만', () => {
  const o = runChild(`
    out.issueS = (await call('sadm', 'POST', '/admin/api-keys', { name: 'k1', groups: ['inventory'], vcenters: [] })).s;
    const f = await call('full', 'POST', '/admin/api-keys', { name: 'k2', groups: ['inventory'], vcenters: [] });
    out.issueF = f.s; const id = f.j?.key?.id;
    out.patchS = (await call('sadm', 'PATCH', '/admin/api-keys/' + id, { vcenters: [] })).s;
    out.revokeS = (await call('sadm', 'POST', '/admin/api-keys/' + id + '/revoke')).s;
    out.listS = (await call('sadm', 'GET', '/admin/api-keys')).s;
  `);
  assert.equal(o.issueS, 403, '수정 전: 범위 admin(설정 소유자) 이 vcenters:[](= 전체) 키를 발급했다');
  assert.equal(o.issueF, 200);
  assert.equal(o.patchS, 403); assert.equal(o.revokeS, 403);
  assert.equal(o.listS, 200);
});

test('LEFT2611-02·04·07: IPAM 설정은 범위 밖 키를 보존하고 전역 목록을 바꾸지 못한다 · dryRun 은 범위 밖 vCenter 를 드러내지 않는다', () => {
  const o = runChild(`
    await call('full', 'PUT', '/admin/ipam/settings', { global: ['1.1.1.1'], publicRanges: [], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.1'], 'vc-eu-west': ['10.9.9.9'] } });
    const g = await call('sadm', 'GET', '/admin/ipam/settings');
    out.getKeys = Object.keys(g.j.settings.vcenters); out.getOmitted = g.j.omittedOutOfScope;
    const p = await call('sadm', 'PUT', '/admin/ipam/settings', { global: ['0.0.0.0/0'], publicRanges: ['0.0.0.0/0'], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.2'] } });
    out.putS = p.s; out.putIgnored = p.j.ignoredGlobal;
    out.file = readJson('ipam-settings.json');
    // 왕복(GET 이 준 값을 그대로 PUT) 은 무시 사유를 만들지 않는다
    const g2 = (await call('sadm', 'GET', '/admin/ipam/settings')).j.settings;
    out.roundtripIgnored = (await call('sadm', 'PUT', '/admin/ipam/settings', g2)).j.ignoredGlobal || null;
    out.scanSetS = (await call('sadm', 'GET', '/admin/ipam/scan/settings')).s;
    out.scanStatS = (await call('sadm', 'GET', '/admin/ipam/scan/status')).s;
    out.scanSetF = (await call('full', 'GET', '/admin/ipam/scan/settings')).s;
    const csv = 'vcenter,ranges,enabled\\nvcenter-eu-west.corp.local,10.8.0.0/30,true\\nno-such-vc,10.7.0.0/30,true\\n';
    const d = await call('sadm', 'POST', '/admin/ipam/vc-ranges/import', { csv, dryRun: true });
    out.dry = d.j.report.map((r) => ({ action: r.action, vcId: r.vcId || null, reason: r.reason || '' }));
    out.dryOos = d.j.outOfScope ?? null;
  `, { setup: writeVcReg });
  assert.deepEqual(o.getKeys, ['vc-us-east']); assert.equal(o.getOmitted, 1);
  assert.equal(o.putS, 200);
  assert.deepEqual(o.file.vcenters['vc-eu-west'], ['10.9.9.9'], '수정 전: 범위 밖 키가 지워졌다');
  assert.deepEqual(o.file.vcenters['vc-us-east'], ['10.0.0.2']);
  assert.deepEqual(o.file.global, ['1.1.1.1']); assert.deepEqual(o.file.publicRanges, [], '수정 전: publicRanges 0.0.0.0/0 저장');
  assert.deepEqual([...o.putIgnored].sort(), ['global', 'publicRanges']);
  assert.equal(o.roundtripIgnored, null);
  assert.equal(o.scanSetS, 403); assert.equal(o.scanStatS, 403); assert.equal(o.scanSetF, 200);
  assert.equal(o.dry[0].action, 'error', '범위 밖 vCenter 는 알 수 없는 vCenter 와 같다');
  assert.equal(o.dry[0].vcId, null);
  assert.equal(o.dry[0].reason.replace('vcenter-eu-west.corp.local', 'X'), o.dry[1].reason.replace('no-such-vc', 'X'), '범위 밖과 없는 vCenter 의 사유가 같다(존재 은닉)');
  assert.equal(o.dryOos, null);
});

test('LEFT2611-03: GPU 게스트 설정 범위 병합 + 계정명이 바뀌면 비밀번호를 승계하지 않는다', () => {
  const o = runChild(`
    await call('full', 'PUT', '/admin/gpu-guest/settings', { enabled: false, vcenters: {
      'vc-us-east': { enabled: true, username: 'us-svc', password: 'P1', winUsername: 'w', winPassword: 'W1', vms: { 'vm-1': { username: 'vmu', password: 'V1' } } },
      'vc-eu-west': { enabled: true, username: 'poland-svc', password: 'P2' } } });
    const g = await call('sadm', 'GET', '/admin/gpu-guest/settings');
    out.getKeys = Object.keys(g.j.settings.vcenters); out.getOmitted = g.j.omittedOutOfScope;
    const p = await call('sadm', 'PUT', '/admin/gpu-guest/settings', { enabled: true, vcenters: { 'vc-us-east': { enabled: true }, 'vc-eu-west': { enabled: false, username: 'hack' } } });
    out.putS = p.s; out.putIgnoredGlobal = p.j.ignoredGlobal; out.putIgnoredOos = p.j.ignoredOutOfScope;
    const f = (await call('full', 'GET', '/admin/gpu-guest/settings')).j.settings;
    out.enabled = f.enabled; out.eu = f.vcenters['vc-eu-west'];
    out.vmsOutS = (await call('sadm', 'GET', '/admin/gpu-guest/vms?vcenterId=vc-eu-west')).s;
    out.testOutS = (await call('sadm', 'POST', '/admin/gpu-guest/test', { vcenterId: 'vc-eu-west', items: [{ vmId: 'x' }] })).s;
    // 계정명만 바꾸고 비밀번호를 비우면 승계하지 않는다(전체 범위도 같은 규칙)
    const c = await call('full', 'PUT', '/admin/gpu-guest/settings', { vcenters: { 'vc-us-east': { username: 'other', winUsername: 'w', vms: { 'vm-1': { username: 'vmu2' } } } } });
    out.dropped = c.j.droppedSecrets;
    const us = c.j.settings.vcenters['vc-us-east'];
    out.us = { hasPassword: us.hasPassword, hasWinPassword: us.hasWinPassword, vm: us.vms['vm-1'] };
    // 같은 계정명 + 빈 비밀번호는 예전대로 유지
    const k = await call('full', 'PUT', '/admin/gpu-guest/settings', { vcenters: { 'vc-eu-west': { username: 'poland-svc', password: '' } } });
    out.keep = k.j.settings.vcenters['vc-eu-west'].hasPassword; out.keepDropped = k.j.droppedSecrets ?? null;
  `);
  assert.deepEqual(o.getKeys, ['vc-us-east'], '수정 전: 범위 밖 계정명 poland-svc·hasPassword 가 보였다'); assert.equal(o.getOmitted, 1);
  assert.equal(o.putS, 200); assert.deepEqual(o.putIgnoredGlobal, ['enabled']); assert.equal(o.putIgnoredOos, 1);
  assert.equal(o.enabled, false, '수정 전: 범위 admin 이 전역 enabled 를 바꿨다');
  assert.equal(o.eu.username, 'poland-svc'); assert.equal(o.eu.enabled, true); assert.equal(o.eu.hasPassword, true);
  assert.equal(o.vmsOutS, 404); assert.equal(o.testOutS, 404);
  assert.deepEqual([...o.dropped].sort(), ['password']);
  assert.equal(o.us.hasPassword, false, '수정 전: 새 계정명에 이전 비밀번호가 붙었다');
  assert.equal(o.us.hasWinPassword, true, '계정명이 같은 Windows 계정은 유지');
  assert.equal(o.us.vm.hasPassword, false);
  assert.equal(o.keep, true); assert.equal(o.keepDropped, null);
});

test('LEFT2611-05: FinOps 숫자 칸 — 빈 값은 이전 값, 명시적 0 은 값', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611b-fin-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveFinopsConfig } = await import(${JSON.stringify(SRC + '/insights/finops.js')});
    const out = {};
    saveFinopsConfig({ tariffPerKwh: 100, co2KgPerKwh: 0.5, pue: 1.4 });
    out.blank = saveFinopsConfig({ tariffPerKwh: '', co2KgPerKwh: '', pue: '' });
    out.nul = saveFinopsConfig({ tariffPerKwh: null, co2KgPerKwh: null, pue: null });
    out.zero = saveFinopsConfig({ tariffPerKwh: 0, co2KgPerKwh: 0, pue: 0 });
    out.neg = saveFinopsConfig({ tariffPerKwh: -5, co2KgPerKwh: -1 });
    console.log('@@' + JSON.stringify(out));
  `], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual([o.blank.tariffPerKwh, o.blank.co2KgPerKwh, o.blank.pue], [100, 0.5, 1.4], '수정 전: CO2 빈 칸이 0 으로 저장됐다');
  assert.deepEqual([o.nul.tariffPerKwh, o.nul.co2KgPerKwh, o.nul.pue], [100, 0.5, 1.4]);
  assert.deepEqual([o.zero.tariffPerKwh, o.zero.co2KgPerKwh, o.zero.pue], [0, 0, 1], '수정 전: 요금 0 을 저장할 수 없었다(PUE 는 하한 1)');
  assert.deepEqual([o.neg.tariffPerKwh, o.neg.co2KgPerKwh], [0, 0]);
});

test('LEFT2611-06: 수집 서버 URL 끝 슬래시 제거는 선형 + 길이 상한 · 세 곳이 한 헬퍼', async () => {
  const { collectorInputIssue } = await import('../src/collector/registry.js');
  const long = `http://10.1.1.1:4000${'/'.repeat(100_000)}x`;   // v2.613 TESTDOC2613-02: 절대 상한은 1초(회귀와 확실히 갈리는 값 — v2.603) · 입력은 옛 O(n²) 구현이 수 초가 되는 크기
  const t0 = performance.now();
  const iss = collectorInputIssue({ id: 'e', name: 'E', url: long });
  assert.ok(performance.now() - t0 < 1000, '수정 전: 4만 자 620ms(O(n²)) — 10만 자면 약 4초');
  assert.match(String(iss), /너무 깁니다/, '수정 전: 검증 통과(null) → 저장');
  const { trimTrailingSlashes } = await import('../src/util/trimSlashes.js');
  const t1 = performance.now(); trimTrailingSlashes(`${'/'.repeat(200_000)}x`); trimTrailingSlashes(`x${'/'.repeat(200_000)}`);
  assert.ok(performance.now() - t1 < 1000);
  assert.equal(trimTrailingSlashes('http://a:1///'), 'http://a:1');
  const strip = (f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));   // v2.613 TESTDOC2613-08
  assert.equal((strip('collector/registry.js').match(/\/\\\/\+\$\//g) || []).length, 0, '정규식 끝-슬래시 치환이 남아 있다');
  for (const f of ['routes/central.js', 'auth/toolAccess.js', 'collector/registry.js']) {
    assert.match(strip(f), /from '\.\.\/util\/trimSlashes\.js'/, `${f} 는 공용 헬퍼를 쓴다`);
    assert.doesNotMatch(strip(f), /const trimTrailingSlashes\s*=/, `${f} 에 사본이 남아 있다`);
  }
});

test('LEFT2611-08: 중앙→엣지 호출은 수집 서버 id 태그로 감싼다', () => {
  const strip = (f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const f of ['routes/admin/collectorsDc.js', 'routes/admin/deployLlm.js']) {
    const s = strip(f);
    const calls = s.match(/resilientFetch\(`[^`]*\/api\/collector\//g) || [];
    const tagged = s.match(/withOutboundTag\([^,]+,\s*\(\)\s*=>\s*resilientFetch\(`[^`]*\/api\/collector\//g) || [];
    assert.ok(calls.length > 0, f);
    assert.equal(tagged.length, calls.length, `${f}: 태그 없는 중앙→엣지 호출 ${calls.length - tagged.length}건`);
  }
});

test('AUTHZ2611-05: site vCenter 의 location.region 은 등록부 값이 이긴다(도시·좌표는 엣지 값)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611b-reg-'));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-pl', name: 'PL', host: 'https://10.0.0.1', collectMode: 'site', location: { city: 'Warsaw', region: 'EMEA', lat: 52, lon: 21 } },
    { id: 'vc-kr', name: 'KR', host: 'https://10.0.0.2', collectMode: 'site', location: { city: 'Seoul', region: 'APAC', lat: 37, lon: 127 } },
  ] }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const SRC = ${JSON.stringify(SRC + '/')};
    const { setInventory } = await import(SRC + 'central/inventory.js');
    const { store } = await import(SRC + 'store.js');
    const { scopedVcenterIds } = await import(SRC + 'auth/scope.js');
    const slice = (id, loc) => ({ vcenter: { id, name: id, status: 'ok', location: loc }, hosts: [{ id: id + ':h1', name: 'h1', vcenterId: id }], vms: [], datastores: [], networks: [], alarms: [] });
    setInventory('vc-pl', slice('vc-pl', { city: 'Krakow', region: 'APAC', lat: 50, lon: 20 }), 'edge-pl', Date.now());
    setInventory('vc-kr', slice('vc-kr', { city: 'Busan', region: 'APAC', lat: 35, lon: 129 }), 'edge-kr', Date.now());
    await store.refresh({ force: true, collectAll: true });
    const snap = store.get();
    const pl = snap.vcenters.find((v) => v.id === 'vc-pl');
    const apac = scopedVcenterIds({ scope: { regions: ['APAC'] } }, snap);
    console.log('@@' + JSON.stringify({ region: pl?.location?.region, city: pl?.location?.city, apac: [...apac].sort() }));
    process.exit(0);
  `], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'vcenter', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${(r.stderr || '').slice(-1500)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.region, 'EMEA', '수정 전: 엣지가 보낸 APAC');
  assert.equal(o.city, 'Krakow', '도시는 엣지 값 유지(v2.600 RECENT2600-01)');
  assert.deepEqual(o.apac, ['vc-kr'], '수정 전: APAC 범위 계정에 vc-pl 이 보였다');
});
