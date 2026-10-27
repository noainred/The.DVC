/**
 * v2.799 — 특수 기능 'VM 전체 정보 내보내기'(사용자 요청: "버그 수정 · 추가할 수 있는 정보 · 클로드 디자인으로 멋지게 · vm list export 참고").
 *  · 결함 고정: ① NIC·디스크 수 0 지어냄 ② Thin 'N' 지어냄 ③ 메모리 0/NaN ④ UTC 시각 ⑤ 동시 1건·감사 없음 ⑥ 미리보기의 전량 실시간 조회
 *    ⑦ 엣지 위임 vCenter 의 디스크·파티션 빈칸(구성 캐시·게스트 디스크 수집 DB 로 대체)
 *  · 카탈로그(vmExportCatalog.js) — '예전 CSV 그대로' 는 v2.278 열 그대로 · 모르는 항목 400
 *  · 실제 라우트(registerVmExport): data.csv · 범위 밖 404 · 미리보기 · CSV · 엑셀(워커) · 저장값(계정 = 인증 사용자 · 데모 403 · 손상 503) · 409 · 감사
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmexport2798-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // 엣지 위임(site) — 실시간 보강 불가 → 캐시로 대체
const VD = 'apac:vc02';   // 비활성
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: VD, name: 'vc02', host: 'vc02.corp.local', username: 'u', password: 'p', enabled: false },
  { id: OUT, name: 'vc04', host: 'vc04.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const C = await import('../src/vcenter/vmExportCatalog.js');
const X = await import('../src/vcenter/vmExport.js');
const P = await import('../src/vcenter/vmExportPrefs.js');
const GD = await import('../src/guestdisk/db.js');
const { parseCsvRows } = await import('../src/util/csv.js');
const { listAudit, auditSkipped } = await import('../src/audit.js');
const EB = await import('../src/util/exportBusy.js');
const ExcelJS = (await import('exceljs')).default;
const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { registerVmExport, selOf } = await import('../src/routes/api/vmExport.js');

const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const parse = (text) => parseCsvRows(text.replace(/^﻿/, ''));
const one = (key, vm, d, o = {}) => C.selectedColumns([key], { offsetMin: 540, now: NOW, ...o })[0].get(vm, d);

const DEVICE_XML = `
<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><deviceInfo><label>Network adapter 1</label><summary>VM Network</summary></deviceInfo>
  <backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>VM Network</deviceName></backing><connectable><connected>true</connected></connectable><macAddress>00:50:56:aa:bb:01</macAddress></VirtualDevice>
<VirtualDevice xsi:type="VirtualDisk"><key>2001</key><deviceInfo><label>Hard disk 2</label></deviceInfo>
  <backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>[DS-B] vm1/vm1_1.vmdk</fileName><diskMode>persistent</diskMode><thinProvisioned>false</thinProvisioned></backing><capacityInKB>20971520</capacityInKB></VirtualDevice>
<VirtualDevice xsi:type="VirtualDisk"><key>2000</key><deviceInfo><label>Hard disk 1</label></deviceInfo>
  <backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>[DS-A] vm1/vm1.vmdk</fileName><diskMode>persistent</diskMode><thinProvisioned>true</thinProvisioned></backing><capacityInKB>104857600</capacityInKB></VirtualDevice>`;

test('① 결함 고정 — NIC·디스크 수는 실시간 속성이 없는 VM 에 0 을 쓰지 않는다 · Thin·메모리·템플릿 모름은 빈칸', () => {
  // 실시간 보강은 성공했지만 이 VM 이 응답에 없다 → d.live=false · nics=null (예전: enriched ? 0 : '')
  const noLive = X.rowContext({ id: `${VC}:vm-9`, vcenterId: VC, name: 'gone' }, { vcenterId: VC, live: new Map(), partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.equal(one('nicCount', {}, noLive), C.MISSING);
  assert.equal(one('diskCount', {}, noLive), C.MISSING, '구성 캐시도 없으면 모름');
  // 실시간 속성은 왔지만 장치 목록이 빠졌다 → 모름(0 아님)
  const noDev = X.rowContext({ id: `${VC}:vm-1`, vcenterId: VC }, { vcenterId: VC, live: new Map([['vm-1', X.compactLive({ 'config.uuid': 'u-1' })]]), partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.equal(noDev.live, true);
  assert.equal(one('nicCount', {}, noDev), C.MISSING);
  assert.equal(one('uuid', {}, noDev), 'u-1');
  // 장치 목록이 있으면 실제 수(0 도 값)
  const lv = X.compactLive({ 'config.hardware.device': DEVICE_XML, 'config.createDate': '2025-03-14T01:22:00Z', 'runtime.bootTime': new Date(NOW - 3 * 86_400_000).toISOString() });
  const d = X.rowContext({ id: `${VC}:vm-1`, vcenterId: VC, powerState: 'POWERED_ON' }, { vcenterId: VC, live: new Map([['vm-1', lv]]), partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.deepEqual([one('nicCount', {}, d), one('macs', {}, d), one('diskCount', {}, d), one('thinDiskCount', {}, d)], [1, '00:50:56:aa:bb:01', 2, 1]);
  const slots = C.selectedColumns(['diskSlots'], { disk: 'slots' });
  assert.deepEqual(slots.slice(0, 5).map((c) => c.get({}, d)), [100, 'thin', 'persistent', 'DS-A', '[DS-A] vm1/vm1.vmdk'], '라벨 자연순 — Hard disk 1 이 1번 슬롯');
  // ④ 시각은 포탈 시각 + 머리에 시간대(예전: 2025-03-14T01:22:00.000Z)
  assert.equal(C.selectedColumns(['createDate'], { offsetMin: 540 })[0].h, '생성일 KST');
  assert.equal(one('createDate', {}, d), '2025-03-14 10:22');
  assert.equal(one('uptimeDays', { powerState: 'POWERED_ON' }, d), 3);
  assert.equal(one('uptimeDays', { powerState: 'POWERED_OFF' }, d), '', '꺼진 VM 의 지난 부팅으로 가동 일수를 쓰지 않는다');
  // ② Thin(추정)은 uncommitted 를 못 읽었으면 빈칸(예전 'N') · ③ 메모리 결측은 빈칸(예전 0/NaN) · 템플릿 모름은 빈칸
  assert.equal(one('thin', { thin: false, uncommittedGB: null }), '');
  assert.equal(one('thin', { thin: true, uncommittedGB: 12 }), 'Y');
  assert.equal(one('thin', { thin: false, uncommittedGB: 0 }), 'N');
  assert.deepEqual([one('memGB', { memMB: null }), one('memGB', {}), one('memGB', { memMB: 8192 }), one('memGB', { memMB: 0 })], ['', '', 8, 0]);
  assert.deepEqual([one('template', {}), one('template', { template: true }), one('template', { template: false })], ['', 'Y', 'N']);
  assert.equal(one('snapshotCount', {}), '', '스냅샷 수를 모르면 빈칸(예전 ?? 0)');
});

test('② 엣지 위임·실시간 없음 — 구성 캐시로 대체(디스크 용량·데이터스토어·모드 · 펌웨어) · 실시간 전용은 수집 안 됨 · 미리보기는 내려받을 때 조회', () => {
  const vm = {
    id: `${VC}:vm-1`, vcenterId: VC, powerState: 'POWERED_ON',
    cfg: { firmware: 'efi', cbt: true, cpuHotAdd: false, cpuReservationMhz: 0, cpuLimitMhz: -1, guestNameTools: 'Rocky Linux 9', consolidationNeeded: true, bootTime: NOW - 86_400_000, managedBy: { extensionKey: 'com.vmware.vcHms', type: 'replica' } },
    dev: { disks: [{ label: 'Hard disk 2', capacityGB: 20, rdm: true, rdmMode: 'physicalMode', mode: 'independent_persistent', datastore: 'DS-R', sharing: 'sharingMultiWriter' }, { label: 'Hard disk 1', capacityGB: 100, rdm: false, mode: 'persistent', datastore: 'DS-A', sharing: 'sharingNone' }],
      cdroms: [{ label: 'CD/DVD 1', connected: true, iso: true, file: '[ISO] rhel9.iso' }, { label: 'CD/DVD 2', connected: false }], floppies: [], usb: 1, serial: 0, parallel: 0, omitted: 0 },
  };
  const d = X.rowContext(vm, { vcenterId: VC, live: null, partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.equal(d.diskSrc, 'cache');
  assert.deepEqual([one('diskCount', vm, d), one('diskProvisionedGB', vm, d), one('datastores', vm, d), one('rdmCount', vm, d), one('sharedDisks', vm, d)], [2, 120, 'DS-A; DS-R', 1, 1]);
  const slot = C.selectedColumns(['diskSlots'], { disk: 'slots' });
  assert.deepEqual(slot.slice(0, 5).map((c) => c.get(vm, d)), [100, C.MISSING, 'persistent', 'DS-A', C.MISSING], '캐시에는 thin·파일이 없다 — 수집 안 됨(빈칸 아님)');
  assert.equal(slot[6].get(vm, d), 'RDM', 'RDM 은 캐시에서도 안다');
  assert.equal(C.selectedColumns(['diskSlots'], { disk: 'join' })[0].get(vm, d), 'Hard disk 1 100GB persistent [DS-A]; Hard disk 2 20GB RDM independent_persistent [DS-R]');
  assert.deepEqual(C.selectedColumns(['disksOverflow'], { disk: 'join' }), [], '한 칸 모드에서는 8+ 요약을 내지 않는다');
  assert.deepEqual([one('firmware', vm, d), one('cbt', vm, d), one('cpuLimit', vm, d), one('guestOsTools', vm, d), one('consolidation', vm, d), one('uptimeDays', vm, d)],
    ['efi', 'Y', -1, 'Rocky Linux 9', 'Y', 1]);
  assert.equal(one('managedBy', vm, d), 'com.vmware.vcHms (replica)');
  assert.deepEqual([one('cdrom', vm, d), one('ports', vm, d)], ['[ISO] rhel9.iso', 'USB 1 · 직렬 0 · 병렬 0']);
  assert.deepEqual([one('uuid', vm, d), one('nicCount', vm, d), one('thinDiskCount', vm, d)], [C.MISSING, C.MISSING, C.MISSING]);
  const pv = X.rowContext(vm, { vcenterId: VC, live: null, partsDb: null, tagInv: null, liveMiss: C.LIVE_LATER });
  assert.equal(one('uuid', vm, pv), C.LIVE_LATER, '미리보기는 실시간을 부르지 않고 그 칸을 밝힌다');
  // 캐시가 상한(32개)에서 잘렸으면 수·합계는 모른다
  const many = { ...vm, dev: { ...vm.dev, disks: Array.from({ length: 32 }, (_, i) => ({ label: `Hard disk ${i + 1}`, capacityGB: 1 })), omitted: 3 } };
  const dm = X.rowContext(many, { vcenterId: VC, live: null, partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.deepEqual([one('diskCount', many, dm), one('diskProvisionedGB', many, dm)], ['', '']);
  // 구성 캐시도 없는 VM — 전부 수집 안 됨
  const bare = X.rowContext({ id: `${VC}:vm-2`, vcenterId: VC }, { vcenterId: VC, live: null, partsDb: null, tagInv: null, liveMiss: C.MISSING });
  assert.deepEqual([one('firmware', {}, bare), one('cdrom', {}, bare), one('datastores', {}, bare)], [C.MISSING, C.MISSING, C.MISSING]);
});

test('③ 카탈로그 — 예전 CSV 그대로는 v2.278 열 · 모르는 항목 거절 · 중복 제거 · 저장값의 없어진 항목은 센다', () => {
  assert.equal(X.VM_EXPORT_COLUMNS.length, 100, '예전 85+(실제 100)열');
  assert.equal(X.VM_EXPORT_COLUMNS[0].key, 'vcenter');
  assert.equal(X.VM_EXPORT_COLUMNS.at(-1).key, 'notes');
  assert.ok(X.VM_EXPORT_COLUMNS.some((c) => c.key === 'disk7File') && X.VM_EXPORT_COLUMNS.some((c) => c.key === 'disksOverflow'));
  const keys = new Set(C.CATALOG_KEYS);
  for (const p of C.PRESETS) for (const k of p.keys) assert.ok(keys.has(k), `${p.id}: ${k}`);
  assert.deepEqual(C.resolveCols(['name', 'name', 'vcenter']), { ok: true, keys: ['name', 'vcenter'] });
  assert.equal(C.resolveCols(['name', 'nope']).ok, false);
  assert.equal(C.resolveCols([]).ok, false);
  assert.equal(C.resolveCols('name').ok, false);
  assert.deepEqual(C.knownKeys(['name', 'gone', 'name', 7]), { keys: ['name'], dropped: 2 });
  const v = C.catalogView();
  assert.equal(v.groups.flatMap((g) => g.items).length, C.CATALOG.length);
  assert.ok(v.groups.find((g) => g.id === 'dev').isNew && v.groups.find((g) => g.id === 'meta').isNew);
  assert.equal(v.missingText, '수집 안 됨');
  // 태그 카테고리별 열
  const tg = { tags: [{ category: '환경', tag: '운영' }, { category: '서비스', tag: '웹' }, { category: '', tag: '임시' }], custom: [{ name: 'owner', value: 'kim' }] };
  const tc = C.selectedColumns(['tags'], { tagCols: true, tagCategories: ['환경', '서비스'] });
  assert.deepEqual(tc.map((c) => c.h), ['태그: 환경', '태그: 서비스', '태그: (카테고리 없음)']);
  assert.deepEqual(tc.map((c) => c.get({}, { tg })), ['운영', '웹', '임시']);
  assert.equal(one('tags', {}, { tg }), '환경:운영; 서비스:웹; 임시');
  assert.equal(one('tags', {}, { tg: null }), C.MISSING, '태그를 못 읽었으면 수집 안 됨');
  assert.equal(one('custom', {}, { tg }), 'owner=kim');
  // 폴더 단계
  assert.deepEqual(C.selectedColumns(['folderLevels'], { levels: 2 }).map((c) => [c.h, c.get({ folder: 'vm/Prod/Web' })]), [['폴더 1단계', 'Prod'], ['폴더 2단계', 'Web']]);
  assert.deepEqual(C.folderOptions([{ folder: 'vm/Prod/Web' }, { folder: 'vm/Prod' }, { folder: 'vm' }]), [{ path: 'Prod', depth: 1, count: 2 }, { path: 'Prod/Web', depth: 2, count: 1 }]);
  assert.equal(C.inFolder({ folder: 'vm/Prod/Web' }, 'Prod'), true);
  assert.equal(C.inFolder({ folder: 'vm/Production' }, 'Prod'), false, '이름 앞부분이 같아도 다른 폴더');
});

test('④ 저장값 — 계정별 · 칸/기본값 연결 · 고르지 않은 선택값은 싣지 않는다 · 형식 검증 · 손상은 보존하고 503', () => {
  const v = { name: '월간 자산', cols: ['name', 'uuid'], fmt: 'xlsx', disk: 'join', live: false };
  let r = P.setPref('alice', 1, v, { alsoDefault: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.prefs.slots[0], { name: '월간 자산', cols: ['name', 'uuid'], fmt: 'xlsx', disk: 'join', live: false });
  assert.equal(r.prefs.def.from, 1);
  assert.equal(P.getPrefs('bob').slots.filter(Boolean).length, 0, '다른 계정에는 없다');
  r = P.setPref('alice', 1, { name: '바꿈', cols: ['vcenter'] });
  assert.deepEqual(r.prefs.def.cols, ['vcenter'], '그 칸에서 온 기본값은 칸과 같이 바뀐다');
  assert.equal(r.prefs.slots[0].fmt, undefined, '고르지 않은 선택값은 싣지 않는다');
  assert.equal(P.setPref('alice', 6, v).status, 400);
  assert.equal(P.setPref('alice', 2, { cols: ['nope'] }).status, 400);
  assert.equal(P.setPref('alice', 2, { cols: ['name'], fmt: 'pdf' }).status, 400);
  assert.equal(P.setPref('alice', 2, { cols: ['name'], folder: 'a\nb' }).status, 400);
  assert.equal(P.setPref('', 2, { cols: ['name'] }).status, 400);
  r = P.clearPref('alice', 1);
  assert.equal(r.prefs.slots[0], null);
  assert.equal(r.prefs.def.from, undefined, '칸을 비우면 기본값 내용은 남고 연결만 끊긴다');
  const file = path.join(DIR, 'vm-export-prefs.json');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  // 손상 — 옆에 보존하고 쓰기 거부(빈 값으로 덮어 다른 계정 저장값을 잃지 않게)
  fs.writeFileSync(file, '{ broken');
  P._resetVmExportPrefsForTest();
  assert.equal(P.getPrefs('alice').unreadable, true);
  const w = P.setPref('alice', 2, { cols: ['name'] });
  assert.equal(w.status, 503);
  assert.equal(P.clearPref('alice', 2).status, 503);
  assert.equal(fs.existsSync(file), false, '손상 뒤 빈 값으로 새 파일을 쓰지 않았다');
  const bak = fs.readdirSync(DIR).filter((f) => f.startsWith('vm-export-prefs.json.corrupt.'));
  assert.equal(bak.length, 1);
  assert.equal(fs.readFileSync(path.join(DIR, bak[0]), 'utf8'), '{ broken', '손상본은 그대로 보존');
  fs.rmSync(path.join(DIR, bak[0])); P._resetVmExportPrefsForTest();
});

test('⑤ 실제 라우트 — 게이트·범위 · 카탈로그 상태 · 미리보기(실시간 없음) · CSV · 예전 GET · 엑셀 · 409 · 감사 · 저장값', async () => {
  // 게스트 파티션 수집 DB — vm-1 만 수집됐다(vm-2 는 '수집 안 됨', 0개 아님)
  await GD.commitCollection(VC, 'vc01', [{ vmId: `${VC}:vm-1`, vmName: 'web01', allocGB: 150, usedGB: 60, parts: [{ path: '/', capGB: 50, usedGB: 20, fs: 'xfs' }, { path: '/data', capGB: 100, usedGB: 40, fs: 'ext4' }] }], { ts: NOW - H });
  const prev = store.snapshot;
  const tagInv = { at: NOW, tagsAt: NOW, categories: [{ id: 'c1', name: '환경' }], tags: [{ id: 't1', name: '운영', cat: 0 }], vmTags: { 'vm-1': [0] }, fields: [{ key: '1', name: 'owner' }], vmCustom: { 'vm-1': { 1: 'kim' } } };
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: VC, name: 'vc01', tagInv }, { id: VD, name: 'vc02' }, { id: OUT, name: 'vc04' }], hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'vm/Prod/Web', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, storageGB: 60, uncommittedGB: 90, thin: true,
      cfg: { firmware: 'efi', guestNameTools: 'Rocky Linux 9' }, dev: { disks: [{ label: 'Hard disk 1', capacityGB: 150, rdm: false, mode: 'persistent', datastore: 'DS-A' }], cdroms: [], floppies: [], usb: 0, serial: 0, parallel: 0, omitted: 0 } },
    { id: `${VC}:vm-2`, vcenterId: VC, name: '=cmd|evil', folder: 'vm/Dev', powerState: 'POWERED_OFF', cpuCount: 2, memMB: null },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'tmpl-rhel9', folder: 'vm/Templates', powerState: 'POWERED_OFF', template: true },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'adm', role: 'admin', scope: { vcenters: [VC, VD] } };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVmExport(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools`;
  const json = { 'content-type': 'application/json' };
  const post = (p, vc, body) => fetch(`${base}/${p}?vcenterId=${encodeURIComponent(vc)}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

  // 카탈로그 — 출처 상태(실시간 불가 사유 · 구성 캐시 · 파티션 · 태그) + 폴더 + 내 저장값
  let r = await fetch(`${base}/vm-export/catalog?vcenterId=${encodeURIComponent(VC)}`);
  assert.equal(r.status, 200);
  const cat = await r.json();
  assert.equal(cat.status.live.state, 'blocked');
  assert.equal(cat.status.live.skipReason, 'site');
  assert.deepEqual([cat.status.vmTotal, cat.status.vmOn, cat.status.templates, cat.status.cfgVms, cat.status.devVms, cat.status.parts.vms, cat.status.tags.state, cat.status.tags.categories], [3, 1, 1, 1, 1, 1, 'ok', 1]);
  assert.deepEqual(cat.status.folders.map((f) => f.path), ['Dev', 'Prod', 'Prod/Web', 'Templates']);
  assert.ok(cat.groups.length >= 10 && cat.presets.some((p) => p.id === 'legacy'));
  assert.ok(!JSON.stringify(cat).includes('"password"'), '접속 정보가 응답에 섞이지 않는다');
  assert.equal((await fetch(`${base}/vm-export/catalog?vcenterId=${encodeURIComponent(OUT)}`)).status, 404, '범위 밖 404');
  assert.equal((await fetch(`${base}/vm-export/catalog?vcenterId=nope`)).status, 404);

  // 미리보기 — 실시간을 부르지 않는다 · 대상 수 · 실시간 칸 표지
  r = await post('vm-export/preview', VC, { cols: ['name', 'uuid', 'diskCount', 'guestPartCount', 'tags', 'fsType'], target: 'all' });
  assert.equal(r.status, 200);
  let pv = await r.json();
  assert.deepEqual(pv.head, ['VM 이름', 'VM UUID', '디스크 수', '게스트 파티션 수', 'vSphere 태그', '파일 시스템 종류(NTFS · ext4 · xfs)']);
  assert.equal(pv.rows, 3);
  assert.equal(pv.cells.length, 3);
  assert.equal(pv.live.state, 'preview');
  assert.equal(pv.live.can, false);
  assert.deepEqual(pv.cells.find((c) => c[0] === 'web01'), ['web01', C.LIVE_LATER, 1, 2, '환경:운영', 'xfs; ext4'], '파일 시스템 종류는(파티션 경로 순) 수집 DB(part_latest.fs — v2.798)에서');
  assert.deepEqual(pv.cells.find((c) => c[0] === '=cmd|evil').slice(2), [C.MISSING, C.MISSING, '', C.MISSING], '캐시도 파티션 수집도 없는 VM 은 수집 안 됨 · 태그 없는 VM 은 빈칸');
  assert.equal((await post('vm-export/preview', VC, { cols: ['nope'] })).status, 400);
  assert.equal((await post('vm-export/preview', OUT, { cols: ['name'] })).status, 404);
  assert.equal(auditSkipped('POST', '/api/tools/vm-export/preview'), true, '미리보기는 감사 줄을 남기지 않는다(쓰기 아님)');

  // CSV — 고른 순서 · 대상(켜진 VM · 템플릿 제외 · 폴더) · 수식 가드 · 실시간 불가는 수집 안 됨 · 파일 이름
  r = await post('vm-export.csv', VC, { cols: ['name', 'powerState', 'memGB', 'uuid', 'datastores', 'guestUsedGB', 'cdrom'] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('content-disposition'), /attachment; filename="vm-export-apac_vc01-all-\d{8}-\d{4}\.csv"/);
  let t = parse(await r.text());
  assert.deepEqual(t[0], ['VM 이름', '전원', '메모리(GB)', 'VM UUID', '데이터스토어 목록', '게스트 사용량(GB)', 'CD-ROM 연결(ISO 경로)']);
  assert.deepEqual(t.slice(1).map((x) => x[0]), ["'=cmd|evil", 'tmpl-rhel9', 'web01'], '이름순 · 수식 가드');
  assert.deepEqual(t[3], ['web01', 'POWERED_ON', '8', C.MISSING, 'DS-A', '60', '']);
  assert.equal(t[1][2], '', '메모리 결측은 빈칸');
  t = parse(await (await post('vm-export.csv', VC, { cols: ['name'], target: 'on' })).text());
  assert.deepEqual(t.slice(1).map((x) => x[0]), ['web01']);
  t = parse(await (await post('vm-export.csv', VC, { cols: ['name'], tmpl: false })).text());
  assert.deepEqual(t.slice(1).map((x) => x[0]), ["'=cmd|evil", 'web01']);
  r = await post('vm-export.csv', VC, { cols: ['name', 'folderLevels'], target: 'folder', folder: 'Prod' });
  assert.match(r.headers.get('content-disposition'), /-folder-\d{8}-\d{4}\.csv"/);
  t = parse(await r.text());
  assert.deepEqual(t, [['VM 이름', '폴더 1단계', '폴더 2단계'], ['web01', 'Prod', 'Web']]);
  assert.equal((await post('vm-export.csv', VC, { cols: ['name'], target: 'folder' })).status, 400, '폴더를 고르지 않은 폴더 대상');
  assert.equal((await post('vm-export.csv', VC, { cols: ['name'], disk: 'x' })).status, 400);
  assert.equal((await post('vm-export.csv', VC, { cols: [] })).status, 400);
  assert.equal((await post('vm-export.csv', OUT, { cols: ['name'] })).status, 404);

  // 예전 GET — '예전 CSV 그대로'(100열) · 이제 동시 1건·감사도 같다
  r = await fetch(`${base}/vm-export.csv?vcenterId=${encodeURIComponent(VC)}`);
  assert.equal(r.status, 200);
  t = parse(await r.text());
  assert.equal(t[0].length, 100);
  assert.deepEqual(t[0].slice(0, 3), ['vCenter', 'vCenter ID', 'VM 이름']);
  assert.ok(t[0].includes('생성일 KST') && t[0].includes('디스크7 파일'));
  assert.equal(t.length - 1, 3);
  // 예전 JSON 미리보기 — 실시간 없음
  const lj = await (await fetch(`${base}/vm-export?vcenterId=${encodeURIComponent(VC)}`)).json();
  assert.equal(lj.total, 3);
  assert.equal(lj.enriched, false);
  assert.equal(lj.columns.length, 100);

  // 동시 1건
  const lock = EB.acquireExport('vm-export.csv', { user: { username: 'other' } });
  try { assert.equal((await post('vm-export.csv', VC, { cols: ['name'] })).status, 409); } finally { lock.release(); }

  // 엑셀 — 워커 · 시트 4장(v2.801 요약·폴더 트리 추가) · 묶음 띠 + 머리 · 수집 안 됨 흐린 기울임(v2.801 — 예전 주황 칸) · 읽는 법(실시간 결과)
  r = await post('vm-export.xlsx', VC, { cols: ['name', 'uuid', 'diskCount', 'tags'], prefName: '월간' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', '폴더 트리', '데이터', '읽는 법']);
  const ws = wb.getWorksheet('데이터');
  assert.deepEqual(ws.getRow(2).values.slice(1), ['VM 이름', 'VM UUID', '디스크 수', 'vSphere 태그']);
  assert.equal(ws.getRow(1).getCell(2).value, '식별 · 이력');
  const webRow = [3, 4, 5].map((i) => ws.getRow(i)).find((row) => row.getCell(1).value === 'web01');
  assert.equal(webRow.getCell(2).value, C.MISSING);
  assert.equal(webRow.getCell(2).font?.italic, true, '수집 안 됨 = 흐린 기울임');
  assert.equal(webRow.getCell(2).fill?.fgColor?.argb === 'FFFEF3C7', false, '주황 칸은 없앴다');
  assert.equal(webRow.getCell(3).value, 1, '수는 숫자 칸');
  const evil = [3, 4, 5].map((i) => ws.getRow(i)).find((row) => String(row.getCell(1).value).includes('cmd'));
  assert.equal(evil.getCell(1).value, '=cmd|evil', '엑셀은 문자열 칸(수식이 아니다)');
  assert.equal(evil.getCell(1).formula, undefined);
  const guide = wb.getWorksheet('읽는 법');
  const gtext = [];
  guide.eachRow((row) => gtext.push(row.values.slice(1).join(' ')));
  assert.ok(gtext.some((l) => /실시간 보강 쓰지 못함 — 엣지 위임 vCenter/.test(l)), gtext.join('\n'));
  assert.ok(gtext.some((l) => /고른 항목 4개 · 4열 · 저장값 ‘월간’/.test(l)));
  assert.ok(gtext.some((l) => /^VM UUID 실시간\(내보낼 때\) 식별 · 이력 0 \/ 3$/.test(l)), '열마다 출처·채워진 수');

  // 감사 — 조건·행 수(VM 이름 없음) · 내려받기 POST 는 미들웨어 감사에서 뺐다(두 줄 방지)
  const au = listAudit({ limit: 50 });
  const rows = (Array.isArray(au) ? au : au.rows || au.items || []).filter((x) => /^vm-export\.(csv|xlsx)$/.test(x.action));
  assert.ok(rows.length >= 6);
  assert.ok(rows.some((x) => x.action === 'vm-export.csv' && x.target === VC && /^3 rows · 고른 항목 7개 · 7열 · all · 실시간 쓰지 못함/.test(x.detail)), JSON.stringify(rows.slice(0, 3)));
  assert.ok(rows.some((x) => /예전 열 · 100열/.test(x.detail)));
  assert.ok(!rows.some((x) => /web01|evil/.test(x.detail)));
  assert.equal(auditSkipped('POST', '/api/tools/vm-export.csv'), true);

  // 저장값 — 계정 = 인증 사용자(본문 이름 무시) · 데모 403 · operator 는 data.csv 가 없다
  const put = (body) => fetch(`${base}/vm-export/prefs`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  r = await put({ slot: 2, value: { name: '용량', cols: ['name', 'memGB'], fmt: 'csv' }, username: 'victim' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).prefs.slots[1].name, '용량');
  assert.equal(P.getPrefs('victim').slots[1], null, '본문의 username 은 무시한다');
  assert.equal(P.getPrefs('adm').slots[1].name, '용량');
  assert.equal((await put({ slot: 2, value: { cols: ['nope'] } })).status, 400);
  const pr = await (await fetch(`${base}/vm-export/prefs`)).json();
  assert.deepEqual(pr.prefs.slots[1].cols, ['name', 'memGB']);
  assert.equal((await fetch(`${base}/vm-export/prefs?slot=2`, { method: 'DELETE' })).status, 200);
  assert.equal(P.getPrefs('adm').slots[1], null);
  user = { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: {} };
  assert.equal((await put({ slot: 1, value: { cols: ['name'] } })).status, 403, '데모 계정은 저장하지 않는다');
  user = { username: 'op', role: 'operator', scope: {} };
  assert.equal((await put({ slot: 1, value: { cols: ['name'] } })).status, 403);
  assert.equal((await post('vm-export.csv', VC, { cols: ['name'] })).status, 403, 'CSV 는 data.csv(관리자 이상)');
  assert.equal((await fetch(`${base}/vm-export/catalog?vcenterId=${encodeURIComponent(VC)}`)).status, 403);
  user = { username: 'viewer1', role: 'viewer', scope: {} };
  assert.equal((await put({ slot: 1, value: { cols: ['name'] } })).status, 403, '역할 게이트가 먼저');
});

test('⑥ 본문 선택 해석 — 실시간 기본 켬 · 모르는 값 400 · 폴더 경로 제어 문자 거절', () => {
  assert.deepEqual(selOf({ cols: ['name'] }).sel, { keys: ['name'], live: true, disk: 'slots', tagCols: false, target: 'all', folder: '', tmpl: true, prefName: '', ynDays: 1 });
  assert.equal(selOf({ cols: ['name'], ynDays: 3 }).sel.ynDays, 3, 'v2.801 여부 기준 일수');
  assert.equal(selOf({ cols: ['name'], ynDays: 5 }).ok, false, '1·2·3·7 밖은 400');
  assert.equal(selOf({ cols: ['name'], live: false }).sel.live, false);
  assert.equal(selOf({ cols: ['name'], target: 'x' }).ok, false);
  assert.equal(selOf({ cols: ['name'], target: 'folder', folder: 'a\u0000b' }).ok, false);
  assert.equal(selOf(null).ok, false);
});
