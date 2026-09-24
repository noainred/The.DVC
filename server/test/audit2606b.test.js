/**
 * v2.606 감사 그룹 b — 인가·범위.
 *   AUTHZ2606-01 통합 서버 인벤토리 변경 4라우트 — 범위 제한 admin 403(GET /fleet 과 같은 판단)
 *   AUTHZ2606-02 Ping 대상 쓰기 범위(범위 밖 404) + 전 vCenter 일괄 작업 403
 *   AUTHZ2606-03 원격 매핑 — 범위 제한 admin 에만 대상 범위(전체 범위 admin 은 예전 그대로)
 *   AUTHZ2606-04 DELETE /tools/vmseries/data 범위 가드
 *   AUTHZ2606-05 vmseries/run · curuser/collect denyScopedRun
 *   AUTHZ2606-06 os-scan PUT 응답 = GET 과 같은 함수 + 범위 계정 설정 변경 403
 *   AUTHZ2606-07 / LEFT2606-03 anomaly perVcenter 범위 필터·병합, 전역 값은 범위 계정이 못 바꾼다
 *   WEB2606-03 이상동작 전역 임계 빈 칸 = 이전 값
 *   RECENT2606-04 mergeScopedIds — 전체([]) 모드를 고정 목록으로 바꾸지 않고 사유를 밝힌다
 *   TIM2606-04 sshGateway readyTimeout 은 sshExec 와 같은 reqTimeoutMs
 *   DB2606-04 vmseries topInWindow·spikesInWindow t0 하한(idx_spikes_t0)
 *
 * ⚠ AUTHZ 는 v2.536·v2.605 하니스와 같다 — **실제 라우터를 express 에 마운트하고 상태코드·파일 상태로** 본다.
 *   자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606b-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const { insightsRouter } = await import(SRC + 'routes/insights.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    const { pingRouter } = await import(SRC + 'routes/ping.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    const SADM = { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'], regions: [], writeVcenters: [] } };
    const USERS = { full: { username: 'full', role: 'admin', scope: null }, sadm: SADM };
    app.use((req, _r, n) => { req.user = USERS[req.headers['x-u'] || 'full']; n(); });
    app.use('/api/insights', insightsRouter); app.use('/api/admin', adminRouter);
    app.use('/api/remote', remoteRouter); app.use('/api/ping', pingRouter);
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const out = {};
    try { ${body} } finally { srv.close(); }
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
  return JSON.parse(line.slice(2));
}

test('AUTHZ2606-01: 범위 제한 admin 의 통합 서버 인벤토리 변경 4라우트는 403, 파일은 그대로 · 전체 범위 admin 은 200', () => {
  const o = runChild(`
    out.get = (await call('sadm', 'GET', '/insights/fleet')).s;
    out.assign = (await call('sadm', 'PUT', '/insights/fleet/assign', { key: 'SVCTAG-OTHER1', vcenterId: 'vc-us-east' })).s;
    out.fileAfterSadm = readJson('fleet-assign.json');
    const tag = await call('sadm', 'PUT', '/insights/fleet/tag', { key: 'SVCTAG-OTHER1', tag: 'exclude' });
    out.tag = tag.s; out.tagHasMap = !!(tag.j && tag.j.tags);
    out.tagFile = readJson('fleet-tags.json');
    out.bulk = (await call('sadm', 'PUT', '/insights/fleet/assign-bulk', { items: [{ key: 'X1' }], vcenterId: 'vc-us-east' })).s;
    out.prune = (await call('sadm', 'POST', '/insights/fleet/prune', { dryRun: true })).s;
    out.fullAssign = await call('full', 'PUT', '/insights/fleet/assign', { key: 'SVCTAG-OTHER1', vcenterId: 'vc-us-east' });
    out.fullTag = (await call('full', 'PUT', '/insights/fleet/tag', { key: 'SVCTAG-OTHER1', tag: 'exclude' })).s;
    out.fullPrune = (await call('full', 'POST', '/insights/fleet/prune', { dryRun: true })).s;
    out.fileAfterFull = readJson('fleet-assign.json');
  `);
  assert.equal(o.get, 403);
  assert.equal(o.assign, 403, '수정 전: 200 이고 fleet-assign.json 에 저장됐다');
  assert.equal(o.fileAfterSadm?.assign?.['svctag-other1'], undefined);
  assert.equal(o.tag, 403);
  assert.equal(o.tagHasMap, false, '전 함대 태그 맵을 응답으로 주지 않는다');
  assert.equal(o.bulk, 403);
  assert.equal(o.prune, 403);
  assert.equal(o.fullAssign.s, 200, JSON.stringify(o.fullAssign.j));
  assert.equal(o.fullTag, 200);
  assert.equal(o.fullPrune, 200);
  assert.equal(o.fileAfterFull?.assign?.['svctag-other1'], 'vc-us-east');
});

test('AUTHZ2606-02: 범위 밖 Ping 대상 수정·삭제는 404(대상·이력 그대로) · 일괄 작업 403 · 전체 범위 admin 은 예전 그대로', () => {
  const o = runChild(`
    out.add = (await call('full', 'POST', '/ping/targets', { id: 'eu-core', name: 'EU', host: '10.53.0.1', vcenterId: 'vc-eu-west', source: 'vcenter' })).s;
    out.put = (await call('sadm', 'PUT', '/ping/targets/eu-core', { vcenterId: 'vc-us-east' })).s;
    out.putHost = (await call('sadm', 'PUT', '/ping/targets/eu-core', { host: '10.9.9.9' })).s;
    out.del = (await call('sadm', 'DELETE', '/ping/targets/eu-core')).s;
    out.after = readJson('ping-targets.json')?.targets?.find((t) => t.id === 'eu-core') || null;
    out.sadmVisible = (await call('sadm', 'GET', '/ping/targets')).j.targets.map((t) => t.id);
    out.postOut = (await call('sadm', 'POST', '/ping/targets', { host: '10.1.1.1', vcenterId: 'vc-eu-west' })).s;
    out.postVcId = (await call('sadm', 'POST', '/ping/targets', { id: 'vc_vc-eu-west', host: '10.1.1.2' })).s;
    out.postDupOut = (await call('sadm', 'POST', '/ping/targets', { id: 'eu-core', host: '10.1.1.3', vcenterId: 'vc-us-east' })).s;
    out.postEdge = (await call('sadm', 'POST', '/ping/targets', { host: '10.1.1.4', source: 'edge' })).s;
    const own = await call('sadm', 'POST', '/ping/targets', { id: 'us-core', host: '10.2.0.1', vcenterId: 'vc-us-east', source: 'vcenter' });
    out.postIn = own.s;
    out.putIn = (await call('sadm', 'PUT', '/ping/targets/us-core', { host: '10.2.0.2' })).s;
    out.putInToOut = (await call('sadm', 'PUT', '/ping/targets/us-core', { vcenterId: 'vc-eu-west' })).s;
    out.manual = (await call('sadm', 'POST', '/ping/targets', { id: 'm1', host: '10.3.0.1' })).s;
    out.delIn = (await call('sadm', 'DELETE', '/ping/targets/us-core')).s;
    out.seed = (await call('sadm', 'POST', '/ping/seed-vcenters')).s;
    out.poll = (await call('sadm', 'POST', '/ping/poll-now')).s;
    out.vcports = (await call('sadm', 'PUT', '/ping/vcport/ports', { ports: [443] })).s;
    out.vcsync = (await call('sadm', 'POST', '/ping/vcport/sync')).s;
    out.fullPut = (await call('full', 'PUT', '/ping/targets/eu-core', { name: 'EU2' })).s;
    out.fullSeed = (await call('full', 'POST', '/ping/seed-vcenters')).s;
    out.fullDel = (await call('full', 'DELETE', '/ping/targets/eu-core')).s;
  `);
  assert.equal(o.add, 200);
  assert.equal(o.put, 404, '수정 전: 200 — vcenterId 를 바꿔 범위 안으로 끌어왔다');
  assert.equal(o.putHost, 404);
  assert.equal(o.del, 404, '수정 전: 200 + 이력 삭제');
  assert.equal(o.after?.vcenterId, 'vc-eu-west');
  assert.equal(o.after?.host, '10.53.0.1');
  assert.deepEqual(o.sadmVisible.includes('eu-core'), false);
  assert.equal(o.postOut, 404);
  assert.equal(o.postVcId, 404);
  assert.equal(o.postDupOut, 404, '범위 밖 기존 id 의 존재를 알리지 않는다');
  assert.equal(o.postEdge, 404);
  assert.equal(o.postIn, 200);
  assert.equal(o.putIn, 200);
  assert.equal(o.putInToOut, 404);
  assert.equal(o.manual, 200, 'vCenter 귀속 없는 수동 대상은 예전처럼 허용');
  assert.equal(o.delIn, 200);
  for (const k of ['seed', 'poll', 'vcports', 'vcsync']) assert.equal(o[k], 403, k);
  assert.equal(o.fullPut, 200);
  assert.equal(o.fullSeed, 200);
  assert.equal(o.fullDel, 200);
});

test('AUTHZ2606-03: 범위 제한 admin 은 범위 밖 VM 으로 상시 매핑을 만들 수 없다 · WS·목록·/proxies/full 도 범위 · 전체 범위 admin 은 그대로', () => {
  const o = runChild(`
    const snap = store.get();
    const vm = (snap.vms || []).find((v) => v.vcenterId === 'vc-eu-west' && (v.ipAddress || v.ipAddresses?.length));
    const ip = vm.ipAddress || vm.ipAddresses[0];
    const vmIn = (snap.vms || []).find((v) => v.vcenterId === 'vc-us-east' && (v.ipAddress || v.ipAddresses?.length));
    const ipIn = vmIn.ipAddress || vmIn.ipAddresses[0];
    out.quick = (await call('sadm', 'POST', '/remote/quick-connect', { protocol: 'ssh', targetHost: ip })).s;
    out.sadmMap = (await call('sadm', 'POST', '/remote/mappings', { name: 'x', protocol: 'ssh', targetHost: ip, targetPort: 22 })).s;
    out.sadmMapVc = (await call('sadm', 'POST', '/remote/mappings', { name: 'y', protocol: 'ssh', targetHost: ipIn, targetPort: 22, vcenterId: 'vc-eu-west' })).s;
    const fm = await call('full', 'POST', '/remote/mappings', { name: 'z', protocol: 'ssh', targetHost: ip, targetPort: 22 });
    out.fullMap = fm.s;
    const inm = await call('sadm', 'POST', '/remote/mappings', { name: 'w', protocol: 'ssh', targetHost: ipIn, targetPort: 22 });
    out.sadmMapIn = inm.s;
    const { mappingAccessIssue } = await import(SRC + 'proxy/sshGateway.js');
    const reg = await import(SRC + 'proxy/registry.js');
    const mm = reg.getMapping(fm.j.mapping?.id);
    out.wsSadm = mappingAccessIssue(USERS.sadm, mm);
    out.wsFull = mappingAccessIssue(USERS.full, mm);
    out.wsSadmIn = mappingAccessIssue(USERS.sadm, reg.getMapping(inm.j.mapping?.id));
    const ls = await call('sadm', 'GET', '/remote/mappings');
    out.sadmList = (ls.j.mappings || []).map((m) => m.targetHost);
    out.sadmOmitted = ls.j.omittedOutOfScope;
    out.fullList = ((await call('full', 'GET', '/remote/mappings')).j.mappings || []).map((m) => m.targetHost);
    out.sadmDel = (await call('sadm', 'DELETE', '/remote/mappings/' + fm.j.mapping?.id)).s;
    out.stillThere = !!reg.getMapping(fm.j.mapping?.id);
    const pf = await call('sadm', 'GET', '/remote/proxies/full');
    out.pfScoped = pf.j.scoped === true; out.pfS = pf.s;
    out.pfFullScoped = (await call('full', 'GET', '/remote/proxies/full')).j.scoped;
    out.ip = ip; out.ipIn = ipIn;
  `);
  assert.equal(o.quick, 403);
  assert.equal(o.sadmMap, 403, '수정 전: 200 — quick-connect 가 403 인 대상에 상시 매핑');
  assert.equal(o.sadmMapVc, 404);
  assert.equal(o.fullMap, 200);
  assert.equal(o.sadmMapIn, 200);
  assert.ok(o.wsSadm, '수정 전: null(role===admin 면제)');
  assert.equal(o.wsFull, null);
  assert.equal(o.wsSadmIn, null);
  assert.equal(o.sadmList.includes(o.ip), false);
  assert.ok(o.sadmList.includes(o.ipIn));
  assert.ok(o.sadmOmitted >= 1);
  assert.ok(o.fullList.includes(o.ip) && o.fullList.includes(o.ipIn));
  assert.equal(o.sadmDel, 404);
  assert.equal(o.stillThere, true);
  assert.equal(o.pfS, 200);
  assert.equal(o.pfScoped, true);
  assert.equal(o.pfFullScoped, undefined, '전체 범위 admin 응답 모양은 그대로');
});

test('AUTHZ2606-04·05: vmseries 데이터 삭제 범위 가드 · 수동 실행 2종 denyScopedRun', () => {
  const o = runChild(`
    const db = await import(SRC + 'vmseries/db.js');
    for (const id of ['vc-us-east', 'vc-eu-west']) await db.getVmSeriesDb(id);
    const dir = path.join(CFG, 'vmseries');
    const files = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
    out.before = files();
    out.delOut = (await call('sadm', 'DELETE', '/tools/vmseries/data?vcenterId=vc-eu-west')).s;
    out.afterOut = files();
    out.delIn = (await call('sadm', 'DELETE', '/tools/vmseries/data?vcenterId=vc-us-east')).s;
    out.afterIn = files();
    out.fullDel = (await call('full', 'DELETE', '/tools/vmseries/data?vcenterId=vc-eu-west')).s;
    out.afterFull = files();
    out.vsRun = (await call('sadm', 'POST', '/tools/vmseries/run')).s;
    out.cuRun = (await call('sadm', 'POST', '/tools/curuser/collect')).s;
    out.vsRunFull = (await call('full', 'POST', '/tools/vmseries/run')).s;
    out.cuRunFull = (await call('full', 'POST', '/tools/curuser/collect')).s;
  `);
  assert.equal(o.before.length, 2);
  assert.equal(o.delOut, 403, '수정 전: 200 filesRemoved 1');
  assert.equal(o.afterOut.length, 2);
  assert.equal(o.delIn, 200);
  assert.equal(o.afterIn.length, 1);
  assert.equal(o.fullDel, 200);
  assert.equal(o.afterFull.length, 0);
  assert.equal(o.vsRun, 403);
  assert.equal(o.cuRun, 403);
  assert.equal(o.vsRunFull, 200);
  assert.equal(o.cuRunFull, 200);
});

test('AUTHZ2606-06: os-scan 설정 PUT — 범위 계정 403(파일 그대로), 전체 범위 admin 은 200 + 예전 응답', () => {
  const o = runChild(`
    const f = path.join(CFG, 'os-scan.json');
    fs.writeFileSync(f, JSON.stringify({ enabled: false, intervalMin: 720, scope: 'all', maxVms: 200, rescanDays: 30, concurrency: 4,
      lastRun: 1, lastFound: 777, lastErr: 'vc-eu-west: 10.9.9.9 게스트 로그온 실패', lastAuth: { at: 1, vcStopped: ['vc-eu-west'], vmStopped: 3 } }));
    const g = await call('sadm', 'GET', '/admin/os-scan');
    out.get = { lastErr: g.j.lastErr, scoped: g.j.scoped };
    const p = await call('sadm', 'PUT', '/admin/os-scan/settings', { enabled: true, scope: 'all' });
    out.put = { s: p.s, lastErr: p.j.lastErr ?? null, lastFound: p.j.lastFound ?? null };
    out.fileEnabled = JSON.parse(fs.readFileSync(f, 'utf8')).enabled;
    const fp = await call('full', 'PUT', '/admin/os-scan/settings', { enabled: true });
    out.full = { s: fp.s, lastErr: fp.j.lastErr, lastFound: fp.j.lastFound, enabled: fp.j.settings?.enabled };
  `);
  assert.equal(o.get.lastErr, null);
  assert.equal(o.put.s, 403, '수정 전: 200 이고 lastErr 원문이 나갔다');
  assert.equal(o.put.lastErr, null);
  assert.equal(o.put.lastFound, null);
  assert.equal(o.fileEnabled, false);
  assert.equal(o.full.s, 200);
  assert.equal(o.full.lastFound, 777);
  assert.match(String(o.full.lastErr), /10\.9\.9\.9/);
  assert.equal(o.full.enabled, true);
});

test('AUTHZ2606-07 · LEFT2606-03 · WEB2606-03: 이상동작 perVcenter 범위 필터·병합, 전역 값은 범위 계정이 못 바꾸고 빈 임계는 이전 값', () => {
  const o = runChild(`
    await call('full', 'PUT', '/admin/anomaly', { enabled: true, threshold: 50, perVcenter: { 'vc-eu-west': 50, 'vc-us-east': 20 } });
    out.sadmGet = (await call('sadm', 'GET', '/admin/anomaly')).j.perVcenter;
    const p = await call('sadm', 'PUT', '/admin/anomaly', { enabled: false, threshold: 3, perVcenter: { 'vc-us-east': 5, 'vc-eu-west': 1 } });
    out.sadmPut = { s: p.s, per: p.j.settings?.perVcenter, ignoredGlobal: p.j.ignoredGlobal, ignoredOutOfScope: p.j.ignoredOutOfScope };
    const f1 = (await call('full', 'GET', '/admin/anomaly')).j;
    out.fullAfter = { per: f1.perVcenter, threshold: f1.threshold, enabled: f1.enabled };
    // WEB2606-03: 빈 칸 · 누락 · 숫자 아님은 이전 값, 명시 숫자는 하한 2
    out.blank = (await call('full', 'PUT', '/admin/anomaly', { enabled: true, threshold: '', perVcenter: {} })).j.settings?.threshold;
    out.missing = (await call('full', 'PUT', '/admin/anomaly', { enabled: true, perVcenter: {} })).j.settings?.threshold;
    out.junk = (await call('full', 'PUT', '/admin/anomaly', { enabled: true, threshold: 'abc', perVcenter: {} })).j.settings?.threshold;
    out.low = (await call('full', 'PUT', '/admin/anomaly', { enabled: true, threshold: 1, perVcenter: {} })).j.settings?.threshold;
    out.fullPer = (await call('full', 'GET', '/admin/anomaly')).j.perVcenter;
  `);
  assert.deepEqual(o.sadmGet, { 'vc-us-east': 20 }, '수정 전: 범위 밖 vc-eu-west 도 노출');
  assert.equal(o.sadmPut.s, 200);
  assert.deepEqual(o.sadmPut.per, { 'vc-us-east': 5 });
  assert.deepEqual(o.sadmPut.ignoredGlobal?.sort(), ['enabled', 'threshold']);
  assert.equal(o.sadmPut.ignoredOutOfScope, 1);
  assert.deepEqual(o.fullAfter.per, { 'vc-eu-west': 50, 'vc-us-east': 5 }, '수정 전: {vc-us-east:5} — 범위 밖 임계 소실');
  assert.equal(o.fullAfter.threshold, 50);
  assert.equal(o.fullAfter.enabled, true);
  assert.equal(o.blank, 50, '수정 전: 10');
  assert.equal(o.missing, 50);
  assert.equal(o.junk, 50);
  assert.equal(o.low, 2);
  assert.deepEqual(o.fullPer, {}, '전체 범위 admin 의 perVcenter 는 예전처럼 통째로 교체');
});

test('RECENT2606-04: mergeScopedIds — 전체([]) 모드를 범위 계정이 고정 목록으로 바꾸지 않고 사유를 싣는다', async () => {
  const { mergeScopedIds } = await import('../src/auth/scopeMerge.js');
  const A = new Set(['vcA', 'vcB']);
  const all = ['vcA', 'vcB', 'vcC', 'vcD'];
  const r1 = mergeScopedIds([], ['vcA'], A, all);
  assert.deepEqual(r1.merged, [], "수정 전: ['vcC','vcD','vcA']");
  assert.equal(r1.unapplied, 'all-mode');
  assert.ok(r1.unappliedReason);
  // 되돌려 보낸 [] 는 변경 없음 · 사유 없음(v2.605 규약 유지)
  const r2 = mergeScopedIds([], [], A, all);
  assert.deepEqual(r2.merged, []);
  assert.equal(r2.unapplied, undefined);
  // 범위 안을 전부 빼는 [] 는 적용하지 않고 사유를 싣는다
  const r3 = mergeScopedIds(['vcA', 'vcC'], [], A, all);
  assert.deepEqual(r3.merged, ['vcA', 'vcC']);
  assert.equal(r3.unapplied, 'empty-in-scope');
  // 고정 목록에서는 예전처럼 병합
  assert.deepEqual(mergeScopedIds(['vcA', 'vcC'], ['vcB'], A, all).merged.sort(), ['vcB', 'vcC']);
  // 전체 범위(null)는 요청 그대로
  assert.deepEqual(mergeScopedIds([], ['vcA'], null, all).merged, ['vcA']);
});

test('TIM2606-04: sshGateway 의 readyTimeout 은 sshExec 와 같은 reqTimeoutMs 로 좁힌다(2^31 초과 → 1ms 가 아니다)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(SRC + '/proxy/sshGateway.js')});
    const { reqTimeoutMs } = await import(${JSON.stringify(SRC + '/agent/envTimeout.js')});
    console.log('@@' + JSON.stringify({ v: m.SSH_GATEWAY_READY_TIMEOUT_MS, want: reqTimeoutMs('3000000000', 60000) }));
    process.exit(0);
  `], { env: { ...process.env, SSH_READY_TIMEOUT_MS: '3000000000', CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606b-t-')), DATA_SOURCE: 'mock' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(o.v, o.want);
  assert.ok(o.v <= 2 ** 31 - 1 && o.v >= 1000);
  const src = fs.readFileSync(path.join(SRC, 'proxy/sshGateway.js'), 'utf8');
  assert.equal(/Number\(process\.env\.SSH_READY_TIMEOUT_MS\)/.test(src), false);
});

test('DB2606-04: vmseries topInWindow·spikesInWindow 는 t0 하한으로 idx_spikes_t0 를 타고 결과는 같다', () => {
  const o = runChild(`
    const db = await import(SRC + 'vmseries/db.js');
    const T0 = 1_780_000_000_000; const H = 3_600_000;
    const spikes = [];
    for (let i = 0; i < 400; i++) {
      const t0 = T0 - i * H;
      spikes.push({ kind: 'vm', ref: 'vm-' + (i % 7), t0, t1: t0 + 50 * 60_000, n: 3, cols: ['a'], buf: Buffer.alloc(8), mxcpu: i, mxmem: 1 });
    }
    await db.commitVmSeries('vc-us-east', { spikes, cover: [], cursors: [] });
    const x = await db.getVmSeriesDb('vc-us-east', { create: false });
    const plan = (st) => x.db.prepare('EXPLAIN QUERY PLAN ' + st.sourceSQL).all(...st.sourceSQL.split('?').slice(1).map(() => 0)).map((r) => r.detail).join(' | ');
    out.topPlan = plan(x.st.topInWindow);
    out.winPlan = plan(x.st.spikesInWindow);
    const from = T0 - 24 * H - 30 * 60_000; const to = T0 + H;
    out.top = await db.topInWindow('vc-us-east', from, to, 100);
    out.topOld = x.db.prepare('SELECT kind, ref, COUNT(*) AS rows, SUM(n) AS moments FROM spikes WHERE t1>=? AND t0<=? GROUP BY kind, ref ORDER BY moments DESC, ref').all(from, to).map((r) => ({ ref: r.ref, rows: Number(r.rows) }));
    out.win = (await db.spikeRowsInWindow('vc-us-east', from, to)).length;
    out.winOld = x.db.prepare('SELECT COUNT(*) AS c FROM spikes WHERE t1>=? AND t0<=?').get(from, to).c;
  `);
  assert.match(o.topPlan, /idx_spikes_t0/, `수정 전: SCAN … autoindex — ${o.topPlan}`);
  assert.match(o.winPlan, /idx_spikes_t0/, o.winPlan);
  const got = o.top.map((r) => ({ ref: r.ref, rows: r.rows })).sort((a, b) => a.ref.localeCompare(b.ref));
  assert.deepEqual(got, [...o.topOld].sort((a, b) => a.ref.localeCompare(b.ref)));
  assert.equal(o.win, Number(o.winOld));
  assert.ok(o.win > 0);
});
