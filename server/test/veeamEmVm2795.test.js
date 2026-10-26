/**
 * v2.795 — Enterprise Manager VM 단위 기록을 vCenter 화면의 Veeam 출처로(사용자 결정 'VM 단위까지' · 'B&R 우선, 실패 시 EM').
 *  · 정규화   : HierarchyObjRef 끝 moref 만 · 복원 지점 이름 'VM@시각' · 서버·작업 링크
 *  · 읽기     : 새것부터 페이지 → 기준보다 오래된 행에서 멈춤(날짜 필터 없음) · 시간·페이지 상한이면 미완결 · 한 유형 실패는 다른 유형 살림 · 인증 실패는 위로
 *  · 저장소   : 더 최신만 덮음 · 진행 중 무시 · 접속처 바뀌면 비움 · 완결이면 기준 전진/아니면 그대로 · 서버 모르는 행은 셈만 · 400일 정리 · 0600 · 손상 보존
 *  · 대조     : moref 는 이름까지 같아야 · moref 없으면 유일한 이름 · 작업에 든 VM 은 마지막이 실패여도 대상(결과 실패) · 마지막 백업 = 늦은 쪽
 *  · 출처 우선: 짝 B&R 이 이 vCenter 를 맡고 정상이면 EM 제외 · 실패면 EM 포함 · 법인 모르면 어디에도 안 실음 · 기록 전이면 모름(0 아님)
 *  · 라우트   : 배지·카드 수·VM 상세·백업 세부내용 · 범위 계정은 범위 밖 vCenter 404·미노출 · 캐시 키에 EM 리비전 · 설정 '반영' 칸
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamEmVm2795-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const EP = await import('../src/veeam/em/parse.js');
const EC = await import('../src/veeam/em/client.js');
const VS = await import('../src/veeam/em/vmStore.js');
const SRC = await import('../src/veeam/em/sources.js');
const { matchToVcenter } = await import('../src/veeam/parse.js');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const H = 3_600_000;
const iso = (t) => new Date(t).toISOString();
const srvLink = (n) => ({ Links: [{ Type: 'BackupServerReference', Name: n }, { Type: 'BackupJobSessionReference', Name: 'Daily-KR@2026-10-26 01:00:00' }] });

test('A 정규화 — moref 는 HierarchyObjRef 끝만 · 복원 지점 이름 · 링크', () => {
  assert.equal(EP.morefOfRef('urn:VMware:Vm:de28dc43-b8ee-4e17-8e63-3d38b6604033.vm-62228'), 'vm-62228');
  assert.equal(EP.morefOfRef('urn:VMware:Vm:abc:vm-7'), 'vm-7');
  assert.equal(EP.morefOfRef('urn:VMware:Vm:de28dc43'), '', 'vm-숫자 가 없으면 지어내지 않는다');
  assert.equal(EP.morefOfRef(null), '');
  assert.equal(EP.morefOfRef(`${'x'.repeat(100_000)}.vm-1`), 'vm-1', '긴 입력은 끝만 본다');
  const t = EP.vmTasksOf([{ VmDisplayName: 'web01', Result: 'Warning', State: 'Stopped', CreationTimeUTC: iso(NOW - 2 * H), EndTimeUTC: iso(NOW - H), ...srvLink('VBR-KR') },
    { VmDisplayName: 'db01', Result: 'None', State: 'Working', CreationTimeUTC: iso(NOW) }, { Result: 'Success' }]);
  assert.deepEqual(t.map((x) => [x.vm, x.server, x.job, x.result, x.running]), [['web01', 'VBR-KR', 'Daily-KR', 'warn', false], ['db01', '', '', 'none', true]], '이름 없는 행은 버린다');
  const p = EP.vmPointsOf([{ Name: 'app01@2026-10-25 01:00:00', CreationTimeUTC: iso(NOW - 3 * H), HierarchyObjRef: 'urn:VMware:Vm:g.vm-12', ...srvLink('VBR-KR') }, { VmName: 'x', CreationTimeUTC: 'bad' }]);
  assert.deepEqual(p, [{ vm: 'app01', server: 'VBR-KR', ts: NOW - 3 * H, moref: 'vm-12' }], '시각을 못 읽은 복원 지점은 버린다');
  assert.ok(!EC.vmQuery('VmRestorePoint', 2).includes('filter='), '날짜 필터에 기대지 않는다(문법 미확인)');
  assert.match(EC.vmQuery('VmRestorePoint', 2), /sortDesc=CreationTime/);
  assert.ok(EC.EM_SECTIONS.includes('vmBackups'));
});

test('B 읽기 — 새것부터 · 오래된 행에서 멈춤 · 상한이면 미완결 · 한 유형 실패 · 인증 실패는 위로', async () => {
  const since = NOW - 24 * H;
  const rowsOf = (type) => Array.from({ length: 2500 }, (_, i) => ({ VmDisplayName: `vm${i}`, Name: `vm${i}@x`, Result: 'Success', State: 'Stopped', CreationTimeUTC: iso(NOW - i * 30_000), EndTimeUTC: iso(NOW - i * 30_000), ...srvLink('S') }))
    .concat(Array.from({ length: 2000 }, (_, i) => ({ VmDisplayName: `old${i}`, Name: `old${i}@x`, Result: 'Success', CreationTimeUTC: iso(since - (i + 1) * 60_000), ...srvLink('S') })));
  const calls = [];
  const fake = (fail = {}) => ({
    mask: (x) => x,
    get: async (p) => {
      const q = new URLSearchParams(p.split('?')[1]); const type = q.get('type'); const page = Number(q.get('page'));
      calls.push(`${type}:${page}`);
      if (fail[type]) throw fail[type];
      const all = rowsOf(type); return { Entities: { X: { X: all.slice((page - 1) * EC.VM_PAGE, page * EC.VM_PAGE) } } };
    },
  });
  const r = await EC.readVmBackups(fake(), { since });
  assert.equal(r.complete, true);
  assert.equal(r.tasks.length, 2500, '기준 이후 행만');
  assert.equal(r.points.length, 2500);
  assert.deepEqual(calls.filter((c) => c.startsWith('BackupTaskSession')), ['BackupTaskSession:1', 'BackupTaskSession:2', 'BackupTaskSession:3'], '오래된 행이 나온 페이지에서 멈춘다');
  let tick = NOW; const clock = () => (tick += 50_000);
  const r2 = await EC.readVmBackups(fake(), { since, budgetMs: 60_000, clock });
  assert.equal(r2.complete, false, '시간 예산을 넘으면 미완결(다음 수집이 같은 기준으로 다시)');
  const e400 = Object.assign(new Error('400 bad'), { status: 400 });
  const r3 = await EC.readVmBackups(fake({ BackupTaskSession: e400 }), { since });
  assert.deepEqual([r3.complete, r3.tasks.length, r3.points.length, !!r3.errors.tasks], [false, 0, 2500, true], '한 유형 실패 — 다른 유형은 살린다');
  await assert.rejects(EC.readVmBackups(fake({ BackupTaskSession: e400, VmRestorePoint: e400 }), { since }), /모두 읽지 못했습니다/);
  const auth = Object.assign(new Error('401'), { fatal: true });
  await assert.rejects(EC.readVmBackups(fake({ VmRestorePoint: auth }), { since }), /401/, '인증 실패는 삼키지 않는다');
});

test('C 저장소 — 최신만 · 진행 중 무시 · 접속처 바뀌면 비움 · 기준 전진 · 서버 모르는 행 · 정리 · 손상 보존', () => {
  VS._resetEmVmsForTest();
  const T = (vm, result, end, extra = {}) => ({ vm, server: 'VBR-KR', job: 'J1', result, running: false, start: end - H, end, moref: '', ...extra });
  const r0 = VS.emVmRev();
  const m = VS.mergeEmVms('em1', 'tgtA', { since: NOW - 8 * 24 * H, complete: true, tasks: [T('web01', 'ok', NOW - 5 * H), T('web01', 'fail', NOW - 9 * H), T('db01', 'none', NOW - H, { running: true }), { vm: 'x', server: '', result: 'ok', end: NOW }],
    points: [{ vm: 'web01', server: 'vbr-kr', ts: NOW - 4 * H, moref: 'vm-1' }, ...Array.from({ length: 12 }, (_, i) => ({ vm: 'app01', server: 'VBR-KR', ts: NOW - (i + 1) * 24 * H, moref: 'vm-2' }))] }, { startedAt: NOW });
  assert.ok(VS.emVmRev() > r0);
  assert.deepEqual([m.unattributed, m.total], [1, 2], '서버 모르는 행은 세기만 · 진행 중 task 는 싣지 않는다');
  const e = VS.getEmVms('em1');
  const web = e.vms['vbr-kr|web01'];
  assert.deepEqual([web.lt.r, web.lt.e, web.m, web.rl], ['Success', NOW - 5 * H, 'vm-1', [NOW - 4 * H]], '늦은 결과만 · 서버 이름 대소문자 무시');
  assert.equal(e.vms['vbr-kr|app01'].rl.length, 10, '복원 지점은 최근 10개');
  assert.equal(e.since, NOW - VS.OVERLAP_MS, '완결 → 기준 = 시작 − 겹침');
  VS.mergeEmVms('em1', 'tgtA', { complete: false, tasks: [T('web01', 'fail', NOW + H)], points: [] }, { startedAt: NOW + 2 * H });
  assert.equal(VS.getEmVms('em1').vms['vbr-kr|web01'].lt.r, 'Failed', '더 늦은 실패는 덮는다');
  assert.equal(VS.emVmSince('em1', 'tgtA'), NOW - VS.OVERLAP_MS, '미완결 → 기준 그대로');
  assert.equal(VS.emVmSince('em1', 'tgtB'), null, '접속처가 다르면 첫 수집 창');
  assert.equal(fs.statSync(path.join(DIR, 'veeam-em-vms.json')).mode & 0o777, 0o600);
  VS.mergeEmVms('em1', 'tgtB', { complete: true, tasks: [], points: [{ vm: 'only', server: 'S1', ts: NOW, moref: '' }] }, { startedAt: NOW, soleServer: '' });
  assert.deepEqual(Object.keys(VS.getEmVms('em1').vms), ['s1|only'], '접속처가 바뀌면 옛 기록을 비운다');
  VS.mergeEmVms('em2', 't', { complete: true, tasks: [{ vm: 'solo', server: '', result: 'ok', end: NOW }], points: [] }, { startedAt: NOW, soleServer: 'ONLY-VBR' });
  assert.ok(VS.getEmVms('em2').vms['only-vbr|solo'], '백업 서버가 하나뿐이면 그 서버로');
  VS.mergeEmVms('em3', 't', { complete: true, tasks: [], points: [{ vm: 'ancient', server: 'S', ts: NOW - 401 * 24 * H }] }, { startedAt: NOW });
  assert.deepEqual(VS.getEmVms('em3').vms, {}, '400일 지난 기록은 정리');
  assert.equal(VS.pruneEmVmsExcept(['em1', 'em2']), 1);
  fs.writeFileSync(path.join(DIR, 'veeam-em-vms.json'), '{"ems":{"em1":');
  VS._resetEmVmsForTest();
  assert.equal(VS.getEmVms('em1'), null, '손상이면 빈 기록으로 시작');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('veeam-em-vms.json.corrupt')), '손상 파일은 보존');
  VS._resetEmVmsForTest();
});

test('D 대조 — moref 는 이름까지 · 유일한 이름 · 실패한 VM 은 대상+실패 · 마지막 백업', () => {
  const vmsMap = {
    a: { n: 'web01', s: 'VBR-KR', m: 'vm-1', j: 'J1', lt: { r: 'Success', s: NOW - 2 * H, e: NOW - H }, rl: [NOW - 30 * 60_000] },
    b: { n: 'other-name', s: 'VBR-KR', m: 'vm-2', j: 'J1', lt: { r: 'Success', s: 0, e: NOW - H }, rl: [] },
    c: { n: 'app01', s: 'vbr-kr', m: '', j: '', lt: null, rl: [NOW - 5 * H] },
    d: { n: 'dup', s: 'VBR-KR', m: '', j: '', lt: { r: 'Success', s: 0, e: NOW }, rl: [] },
    e: { n: 'fail01', s: 'VBR-KR', m: '', j: 'J2', lt: { r: 'Failed', s: 0, e: NOW }, rl: [] },
    f: { n: 'web01', s: 'OTHER', m: 'vm-1', j: '', lt: { r: 'Success', s: 0, e: NOW }, rl: [] },
  };
  const result = SRC.serverResultOf(vmsMap, 'VBR-KR', NOW);
  assert.equal(result.vms.length, 5, '그 서버의 기록만');
  assert.ok(result.vms.every((v) => v.h === '' && v.run === 0), 'vCenter 이름 없음 · 진행 중 없음');
  const inv = [{ id: 'kr:vc1:vm-1', name: 'web01' }, { id: 'kr:vc1:vm-2', name: 'db02' }, { id: 'kr:vc1:vm-3', name: 'app01' }, { id: 'kr:vc1:vm-4', name: 'dup' }, { id: 'kr:vc1:vm-5', name: 'DUP' }, { id: 'kr:vc1:vm-6', name: 'fail01' }];
  const m = matchToVcenter({ id: 'kr:vc1', host: 'vc1.corp' }, inv, [{ server: { id: 'em:x', name: 'EM · VBR-KR' }, result }]);
  assert.deepEqual(Object.keys(m.byVm).sort(), ['kr:vc1:vm-1', 'kr:vc1:vm-3', 'kr:vc1:vm-6'], 'moref 만 같고 이름이 다르면 짝짓지 않는다 · 동명은 고르지 않는다');
  assert.deepEqual([m.byVm['kr:vc1:vm-6'].lr, m.byVm['kr:vc1:vm-6'].lb], ['Failed', null], '백업 작업에 든 VM 은 마지막이 실패여도 대상(B&R 과 같은 판정) — 마지막 백업은 없음, 결과는 실패');
  assert.equal(m.ambiguous, 1);
  assert.deepEqual([m.byVm['kr:vc1:vm-1'].lb, m.byVm['kr:vc1:vm-1'].lbSrc, m.byVm['kr:vc1:vm-1'].jobs, m.byVm['kr:vc1:vm-1'].servers], [NOW - 30 * 60_000, 'rp', ['J1'], ['EM · VBR-KR']], '마지막 백업 = 늦은 쪽');
  assert.equal(m.byVm['kr:vc1:vm-3'].rp, -1, '복원 지점은 있음·수 모름');
});

test('E 출처 우선 — 짝 B&R 정상이면 EM 제외 · 실패면 포함 · 법인 모르면 안 실음 · 기록 전이면 모름', () => {
  SRC._resetEmSourcesForTest();
  const rec = { at: NOW, result: { ok: true, ts: NOW, backupServers: [{ name: 'VBR-KR' }, { name: 'AZ' }, { name: 'NOVC' }] } };
  const map = { 'em1|vbr-kr': { br: 'none', vcenterIds: ['kr:vc1'] } };
  const br = [{ id: 'vbr-az', name: 'AZ', host: 'az.corp', vcenterIds: ['us:az'] }];
  const vms = { at: NOW, vms: { a: { n: 'web01', s: 'VBR-KR', m: '', lt: { r: 'Success', e: NOW }, rl: [] }, b: { n: 'az01', s: 'AZ', m: '', lt: { r: 'Success', e: NOW }, rl: [] } } };
  const sources = SRC.emBackupSources({ ems: [{ id: 'em1', name: 'E' }], recOf: () => rec, map, brServers: br, vmsOf: () => vms });
  assert.deepEqual(sources.map((s) => [s.server, s.vcenterIds, s.brId]), [['VBR-KR', ['kr:vc1'], ''], ['AZ', ['us:az'], 'vbr-az']], '법인을 모르는 서버(NOVC)는 싣지 않는다');
  const healthy = SRC.emSourcesForVcenter('us:az', { sources, brHealthy: () => true, now: NOW });
  assert.deepEqual([healthy.results.length, healthy.views.length], [0, 0], '짝 B&R 이 정상이면 EM 은 뺀다');
  const failing = SRC.emSourcesForVcenter('us:az', { sources, brHealthy: () => false, now: NOW });
  assert.deepEqual([failing.results.length, failing.views[0].name, failing.views[0].via], [1, 'EM · AZ', 'em'], 'B&R 이 실패면 EM 으로 채운다');
  assert.equal(SRC.emSourcesForVcenter('eu:x', { sources, now: NOW }).results.length, 0, '매핑에 없는 vCenter');
  assert.equal(SRC.emLinkedVcenter('kr:vc1', sources), true);
  SRC._resetEmSourcesForTest();
  const pending = SRC.emBackupSources({ ems: [{ id: 'em1', name: 'E' }], recOf: () => rec, map, brServers: br, vmsOf: () => null });
  const pv = SRC.emSourcesForVcenter('kr:vc1', { sources: pending, now: NOW });
  assert.deepEqual([pv.results.length, pv.views.length, pv.views[0].ok], [0, 1, null], '기록 전 — 결과 없음(0대가 아니라 모름)');
  SRC._resetEmSourcesForTest();
  const ua = SRC.emBackupSources({ ems: [{ id: 'em1', name: 'E' }], recOf: () => rec, map, brServers: br, vmsOf: () => ({ at: NOW, ua: 30, vms: {} }) });
  assert.equal(SRC.emSourcesForVcenter('kr:vc1', { sources: ua, now: NOW }).results.length, 0, '서버를 가릴 수 없는 기록뿐이면 모름');
  SRC._resetEmSourcesForTest();
  assert.equal(SRC.emBackupSources({ ems: [{ id: 'em1', name: 'E', enabled: false }], recOf: () => rec, map, brServers: br, vmsOf: () => vms }).length, 0, '수집을 끈 EM 은 싣지 않는다');
  SRC._resetEmSourcesForTest();
});

test('F 라우트 — 배지·카드·상세·세부내용 · 출처 우선 · 범위 · 캐시 키 · 설정 반영 칸', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges, registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const { registerVeeamEm } = await import('../src/routes/admin/veeamEm.js');
  const ER = await import('../src/veeam/em/registry.js');
  const ES = await import('../src/veeam/em/store.js');
  const M = await import('../src/veeam/em/mapping.js');
  const BR = await import('../src/veeam/registry.js');
  const BS = await import('../src/veeam/store.js');
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: 'kr:vc1', name: 'KR' }, { id: 'us:az', name: 'AZ' }, { id: 'eu:x', name: 'X' }], hosts: [],
    vms: [{ id: 'kr:vc1:vm-1', vcenterId: 'kr:vc1', name: 'web01', powerState: 'POWERED_ON' }, { id: 'kr:vc1:vm-2', vcenterId: 'kr:vc1', name: 'db01', powerState: 'POWERED_ON' },
      { id: 'us:az:vm-1', vcenterId: 'us:az', name: 'az01', powerState: 'POWERED_ON' }, { id: 'eu:x:vm-1', vcenterId: 'eu:x', name: 'x01', powerState: 'POWERED_ON' }] };
  ER._resetEmRegistryForTest(); M._resetEmMapForTest(); VS._resetEmVmsForTest(); SRC._resetEmSourcesForTest(); BR._resetForTest(); BS._resetForTest();
  const em = ER.saveEm({ name: 'HQ', host: 'vem01.corp.local', username: 'svc', password: 'PW-1' });
  const tgt = ER.emFingerprint(ER.getEmWithSecret(em.id));
  ES.putEmResult(em.id, { ok: true, ts: Date.now(), target: tgt, sections: {}, notes: [], backupServers: [{ name: 'VBR-KR' }, { name: 'AZ' }], jobs: [], sessions: null });
  assert.equal(M.setEmMap({ emId: em.id, server: 'VBR-KR', vcenterIds: ['kr:vc1'] }, { knownVcenters: ['kr:vc1', 'us:az', 'eu:x'], knownBr: [] }).ok, true);
  const az = BR.saveServer({ name: 'AZ', host: 'az-vbr.corp.local', username: 'u', password: 'p', vcenterIds: ['us:az'] });
  VS.mergeEmVms(em.id, tgt, { complete: true, points: [],
    tasks: [{ vm: 'web01', server: 'VBR-KR', job: 'Daily-KR', result: 'ok', running: false, start: NOW - 2 * H, end: NOW - H, moref: '' },
      { vm: 'az01', server: 'AZ', job: 'Daily-AZ', result: 'warn', running: false, start: NOW - 2 * H, end: NOW - H, moref: '' }] }, { startedAt: NOW });
  let user = { username: 'adm', role: 'admin' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); registerBackupStatus(api); app.use('/api', api);
  const adm = express.Router(); registerVeeamEm(adm); app.use('/api/admin', adm);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => srv.close(() => ok())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };

  // EM 으로만 연동된 vCenter — 배지·카드 수·VM 상세
  const bd = (await get('/veeam/badges?vcenterId=kr:vc1')).body;
  assert.deepEqual([bd.configured, Object.keys(bd.byVm), bd.servers.map((s) => s.name)], [true, ['kr:vc1:vm-1'], ['EM · VBR-KR']], "B&R 등록 없이 EM 매핑만으로 '연동됨'");
  const cnt = (await get('/veeam/backup-counts')).body.byVc;
  assert.deepEqual([cnt['kr:vc1'].src, cnt['kr:vc1'].n, cnt['kr:vc1'].vmTotal], ['veeam', 1, 2]);
  assert.notEqual(cnt['eu:x'].src, 'veeam', '매핑하지 않은 vCenter 는 그대로(스냅샷 기준)');
  const det = (await get('/veeam/vm-detail?vcenterId=kr:vc1&vmId=kr:vc1:vm-1')).body;
  assert.deepEqual([det.detail.lastTask.result, det.detail.lastTask.job, det.detail.servers[0].name], ['Success', 'Daily-KR', 'EM · VBR-KR']);
  const bdet = (await get('/tools/backup-detail?vcenterId=kr:vc1&excl=0')).body;
  assert.equal(bdet.linked, true);
  assert.equal(bdet.vms.find((v) => v.id === 'kr:vc1:vm-1')?.v?.state, 'ok', '백업 세부내용에도 VM 단위로');

  // 출처 우선 — AZ: B&R 실패면 EM, 정상이면 B&R 만
  BS.putResult(az.id, { ok: false, ts: Date.now(), error: 'down', jobs: [], vms: [] });
  let azb = (await get('/veeam/badges?vcenterId=us:az')).body;
  assert.ok(azb.servers.some((s) => s.name === 'EM · AZ'), 'B&R 읽기 실패 → EM 으로 채운다');
  assert.ok(azb.byVm['us:az:vm-1']);
  BS.putResult(az.id, { ok: true, ts: Date.now() - 2 * 24 * H, jobs: [], vms: [] });
  azb = (await get('/veeam/badges?vcenterId=us:az')).body;
  assert.ok(azb.servers.some((s) => s.name === 'EM · AZ'), 'B&R 결과가 성공이어도 오래됐으면(멈춘 수집) EM 으로 채운다');
  BS.putResult(az.id, { ok: true, ts: Date.now(), jobs: [], vms: [] });
  azb = (await get('/veeam/badges?vcenterId=us:az')).body;
  assert.deepEqual(azb.servers.map((s) => s.name), ['AZ'], 'B&R 이 정상이면 EM 은 뺀다');
  const gl = (await get('/admin/veeam/em')).body;
  const rows = Object.fromEntries(gl.mapping.rows.map((r) => [r.name, r]));
  assert.deepEqual([rows['VBR-KR'].reflect, rows['VBR-KR'].vmCount, rows.AZ.reflect, rows.AZ.vmCount], ['em', 1, 'br', 1], "설정 'vCenter 반영' 칸 — 같은 우선 규칙");

  // 캐시 키 — 새 기록이 60초 캐시를 기다리지 않는다
  VS.mergeEmVms(em.id, tgt, { complete: true, points: [], tasks: [{ vm: 'db01', server: 'VBR-KR', job: 'Daily-KR', result: 'ok', running: false, start: NOW - H, end: NOW, moref: '' }] }, { startedAt: NOW + 60_000 });
  assert.equal((await get('/veeam/backup-counts')).body.byVc['kr:vc1'].n, 2, '응답 캐시 키에 EM 리비전');

  // 범위 계정 — 범위 밖 vCenter 의 EM 기록은 보이지 않는다
  user = { username: 'op', role: 'operator', scope: { vcenters: ['us:az'] } };
  assert.equal((await get('/veeam/badges?vcenterId=kr:vc1')).status, 404);
  assert.equal((await get('/veeam/vm-detail?vcenterId=kr:vc1&vmId=kr:vc1:vm-1')).status, 404);
  const sc = (await get('/veeam/backup-counts')).body.byVc;
  assert.deepEqual(Object.keys(sc), ['us:az'], '카드 수에도 범위 밖 vCenter 없음');
  const sum = (await get('/tools/backup-summary')).body;
  assert.deepEqual(sum.rows.map((r) => r.id), ['us:az']);
  user = { username: 'adm', role: 'admin' };
});

test('G 폴러 — 행은 저장소로 · 결과에서 뗀다 · 실패 결과는 합치지 않는다', async () => {
  const { absorbVmRows } = await import('../src/veeam/em/poller.js');
  VS._resetEmVmsForTest();
  const rows = { since: NOW - H, complete: true, tasks: [{ vm: 'a', server: '', result: 'ok', end: NOW }], points: [] };
  const r = absorbVmRows({ id: 'emG' }, { ok: true, target: 't', backupServers: [{ name: 'ONLY' }], vmBackups: { tasks: 1, points: 0 }, vmRows: rows }, { startedAt: NOW });
  assert.equal('vmRows' in r, false, '결과 파일을 키우지 않게 행을 뗀다');
  assert.deepEqual([r.vmBackups.stored, r.vmBackups.unattributed], [1, 0]);
  const f = absorbVmRows({ id: 'emH' }, { ok: false, target: 't', vmRows: rows });
  assert.equal('vmRows' in f, false);
  assert.equal(VS.getEmVms('emH'), null, '실패 결과는 합치지 않는다');
});

test('H 등록 — .gitignore · 포탈 DB 목록 · DB 안내', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^server\/config\/veeam-em-vms\.json$/m);
  assert.match(fs.readFileSync(path.join(root, 'server/src/insights/portalDb.js'), 'utf8'), /'veeam-em-vms\.json':/);
  const { DB_GUIDE_DATA } = await import('../src/insights/dbGuideData.js');
  assert.ok(DB_GUIDE_DATA['veeam-em-vms.json']?.sources?.includes('server/src/veeam/em/vmStore.js'));
});
