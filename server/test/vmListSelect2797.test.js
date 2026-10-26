/**
 * v2.797 — VM 목록 내보내기 '필요한 항목만 고르기' + 계정 저장값(기본값 · 5칸) + 게스트 파티션 파일 시스템 종류.
 *  · 카탈로그 : key 고유 · v2.792 열과 머리·칸 같음(cols 없이 보내면 예전 그대로) · 모르는 key 400 · 순서 = 고른 순서
 *  · 값 규칙  : 못 모은 소스는 '수집 안 됨'(태그 수집 전 · 파티션 미수집 VM · 구성 캐시 미도달) · 모르는 값은 빈칸(0 아님)
 *  · 여러 값  : 파티션 한 줄 반복 · 태그 카테고리별 열 · Veeam 열이 없으면 Veeam 대조를 하지 않는다
 *  · 저장값   : 본인 것만(인증 계정 키 · 본문 이름 무시) · 칸 1~5·기본값 · 고른 내용만 저장 · 손상 503 · viewer·데모 거부 · 사라진 항목은 빼고 알림
 *  · 파일 시스템: filesystemType 파싱 · 형식 밖 값 버림 · 엣지 정제 화이트리스트 · DB 열
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmListSelect2797-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const CAT = await import('../src/veeam/vmListCatalog.js');
const L = await import('../src/veeam/vmListCsv.js');
const P = await import('../src/veeam/vmListPrefs.js');
const { parseGuestDisks } = await import('../src/vcenter/soapParse.js');
const { sanitizeGuestDiskVms } = await import('../src/guestdisk/analyze.js');
const GD = await import('../src/guestdisk/db.js');
const { parseCsvRows } = await import('../src/util/csv.js');
const { store } = await import('../src/store.js');
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;
const VC = 'kr:vc1'; const OUT = 'eu:vc9';

test('A 카탈로그 — key 고유 · 조합은 아는 key · v2.792 열과 같은 머리·칸', () => {
  assert.equal(new Set(CAT.CATALOG_KEYS).size, CAT.CATALOG_KEYS.length);
  for (const p of CAT.PRESETS) for (const k of p.keys) assert.ok(CAT.CATALOG_KEYS.includes(k), `${p.id}:${k}`);
  for (const k of CAT.LEGACY_KEYS) assert.ok(CAT.CATALOG_KEYS.includes(k), k);
  const inv = { id: `${VC}:vm-1`, name: 'web01', folder: 'DC/vm/A/B', powerState: 'POWERED_ON', template: false, cluster: 'C1', host: 'h1', guestOS: 'Win', cpuCount: 4, memMB: 8192,
    storageGB: 100.04, ipAddress: '10.0.0.1', snapshotCount: 1, snapshotSizeGB: 2.25, snapshotNewestTs: NOW - H, snapshotNames: ['a', 'b'] };
  const view = { name: 'web01', folder: 'DC/vm/A/B', power: 'POWERED_ON', v: { state: 'ok', jobs: ['J'], rp: 3, lb: NOW - 2 * H, lr: 'Success' }, s: { ev: { n: 2, ts: NOW - 3 * H } } };
  const old = L.vmListColumns({ snapDays: 7, levels: 2 });
  const neu = CAT.selectedColumns(CAT.LEGACY_KEYS, { levels: 2, snapDays: 7 });
  assert.deepEqual(neu.map((c) => c.h), old.map((c) => c.h), '머리가 같다(파일 소비자가 깨지지 않게)');
  const r = { inv, view, vc: 'vc1', linked: true };
  assert.deepEqual(neu.map((c) => c.get(r)), old.map((c) => c.get(r)), '칸 값도 같다');
  assert.equal(CAT.resolveCols(null).keys.length, CAT.LEGACY_KEYS.length, 'cols 없으면 예전 열');
  assert.match(CAT.resolveCols(['name', 'nope']).reason, /모르는 항목/);
  assert.match(CAT.resolveCols(['name', 'name']).reason, /두 번/);
  assert.match(CAT.resolveCols([]).reason, /하나 이상/);
  assert.deepEqual(CAT.resolveCols(['notes', 'name']).keys, ['notes', 'name'], '고른 순서 그대로');
});

test('B 값 규칙 — 수집 안 됨 vs 빈칸 · 태그 카테고리 열 · 파티션 반복 · 구성 캐시', () => {
  const cols = (keys, o = {}) => CAT.selectedColumns(keys, { levels: 1, ...o });
  const base = { vc: 'vc1', linked: false, inv: { name: 'a', folder: 'vm', notes: '  결제 API \n', cfg: { firmware: 'efi', cpuHotAdd: true, memHotAdd: null, cbt: false, bootTime: NOW - 49 * H }, dev: { disks: [{ capacityGB: 100, datastore: 'DS1', mode: 'persistent' }, { capacityGB: 50, datastore: 'DS1', mode: 'persistent', rdm: true, rdmMode: 'physicalMode' }], cdroms: [{ connected: true, file: '[DS1] iso/u.iso' }] } } };
  const parts = [{ path: 'C:\\', capGB: 100, usedGB: 60, fs: 'NTFS' }, { path: 'D:\\', capGB: 200, usedGB: null, unknown: true, fs: '' }];
  const row = { ...base, tg: { tags: [{ category: '환경', tag: '운영' }, { category: '서비스', tag: '결제' }], custom: [{ name: 'Owner', value: 'ops' }] }, parts };
  const c = cols(['notes', 'tags', 'custom', 'partN', 'partSum', 'fsType', 'partOs', 'fw', 'hot', 'cbt', 'vdisk', 'rdm', 'cd', 'boot']);
  const v = Object.fromEntries(c.map((x, i) => [CAT.selectedColumns([], {}).length + i, x.get(row)]));
  assert.deepEqual(Object.values(v).slice(0, 7), ['결제 API', '환경:운영 | 서비스:결제', 'Owner=ops', 2, '100 / 60 / 40 (모름 1개 제외)', 'NTFS', 'Windows']);
  assert.deepEqual(Object.values(v).slice(7, 10), ['EFI', 'CPU 켜짐 · 메모리 모름', '꺼짐']);
  assert.match(String(Object.values(v)[10]), /^2개 · 100\+50GB · DS1 · persistent$/);
  assert.equal(Object.values(v)[11], '1개(physicalMode)');
  assert.equal(Object.values(v)[12], '[DS1] iso/u.iso');
  assert.match(String(Object.values(v)[13]), /\(2일\)$/);
  // 못 모은 소스는 '수집 안 됨' — 0·없음이 아니다
  const none = { vc: 'vc1', linked: false, inv: { name: 'b', folder: 'vm' }, tg: undefined, parts: undefined };
  const cn = cols(['tags', 'custom', 'partN', 'fsType', 'fw', 'vdisk', 'notes', 'cpu']);
  assert.deepEqual(cn.map((x) => x.get(none)), [CAT.MISSING, CAT.MISSING, CAT.MISSING, CAT.MISSING, CAT.MISSING, CAT.MISSING, '', '']);
  // 태그 카테고리별 열(이름 순)
  const tc = CAT.selectedColumns(['name', 'tags'], { tagCols: true, tagCategories: ['환경', '서비스'] });
  assert.deepEqual(tc.map((x) => x.h), ['VM', '태그: 서비스', '태그: 환경']);
  assert.deepEqual(tc.map((x) => x.get(row)), ['a', '결제', '운영']);
  // 파티션 한 줄 반복 — 파티션 열을 고른 때만
  const ex = CAT.expandPartRows([row, none], ['name', 'partDetail', 'fsType'], 'partRows');
  assert.equal(ex.length, 3);
  assert.deepEqual(cols(['partDetail', 'fsType']).map((x) => x.get(ex[0])), ['C:\\ 100GB 여유 40 (NTFS)', 'NTFS']);
  assert.equal(CAT.expandPartRows([row], ['name', 'partN'], 'partRows').length, 1, '파티션 상세·FS 를 안 고르면 반복하지 않는다');
  assert.deepEqual([...CAT.needsOf(['name', 'tags', 'vstate', 'partN', 'bmark'])].sort(), ['marks', 'parts', 'tags', 'veeam']);
});

test('C 파일 시스템 종류 — 파싱 · 형식 밖 값 버림 · 엣지 정제 · DB 열', async () => {
  const gb = 1024 ** 3;
  const xml = `<GuestDiskInfo><diskPath>/</diskPath><capacity>${10 * gb}</capacity><freeSpace>${4 * gb}</freeSpace><filesystemType>xfs</filesystemType></GuestDiskInfo>`
    + `<GuestDiskInfo><diskPath>/data</diskPath><capacity>${10 * gb}</capacity><freeSpace>${gb}</freeSpace><filesystemType>&lt;script&gt;</filesystemType></GuestDiskInfo>`;
  const p = parseGuestDisks(xml);
  assert.deepEqual(p.map((x) => x.fs), ['xfs', undefined], '형식 밖 값(꺾쇠)은 버린다 — 모름');
  const s = sanitizeGuestDiskVms([{ vmId: `${VC}:vm-1`, vmName: 'web01', allocGB: 20, usedGB: 15, parts: [{ path: '/', capGB: 10, usedGB: 6, fs: 'xfs' }, { path: '/x', capGB: 10, usedGB: 9, fs: 'a b;c' }] }]);
  assert.deepEqual(s[0].parts.map((x) => x.fs), ['xfs', undefined], '엣지가 보낸 값도 같은 형식만');
  const c = await GD.commitCollection(VC, 'vc1', s, { ts: NOW });
  assert.equal(c.ok, true);
  const pf = await GD.partsForVcenter(VC);
  assert.deepEqual([pf.collected.has(`${VC}:vm-1`), pf.byVm.get(`${VC}:vm-1`).map((x) => x.fs)], [true, ['xfs', '']]);
  assert.equal((await GD.vmPartLatest(`${VC}:vm-1`)).parts[0].fs, 'xfs');
});

test('D 저장값 — 칸·기본값 · 고른 내용만 · 사라진 항목 · 손상 503', () => {
  P._resetVmListPrefsForTest();
  assert.equal(P.setPref('kim', 6, { cols: ['name'] }).status, 400, '칸은 1~5');
  assert.match(P.setPref('kim', 1, { cols: ['nope'] }).reason, /모르는 항목/);
  assert.equal(P.setPref('kim', 1, { cols: ['name'], fmt: 'pdf' }).status, 400);
  const r = P.setPref('kim', 2, { name: '  월말\u0007점검 ', cols: ['name', 'notes'], fmt: 'xlsx' }, { alsoDefault: true });
  assert.equal(r.ok, true);
  assert.deepEqual([r.prefs.slots[1].name, r.prefs.slots[1].cols, r.prefs.slots[1].fmt, 'multi' in r.prefs.slots[1], r.prefs.def.from], ['월말 점검', ['name', 'notes'], 'xlsx', false, 2], '고르지 않은 내용(multi)은 싣지 않는다');
  assert.equal(P.setPref('kim', 3, { cols: ['name'] }).prefs.slots[2].name, '이름3', '이름이 비면 이름N');
  P.setPref('kim', 2, { name: '바뀜', cols: ['name'] });
  assert.deepEqual([P.getPrefs('kim').def.name, P.getPrefs('kim').def.from], ['바뀜', 2], '그 칸에서 온 기본값은 칸과 같이 바뀐다');
  assert.equal(P.getPrefs('lee').slots.every((s) => s === null), true, '다른 계정은 보이지 않는다');
  assert.equal(P.clearPref('kim', 'default').prefs.def, null);
  assert.equal(fs.statSync(path.join(DIR, 'vm-list-prefs.json')).mode & 0o777, 0o600);
  // 사라진 항목은 빼고 알린다
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'vm-list-prefs.json'), 'utf8'));
  raw.users['u:kim'].slots[0] = { name: 'x', cols: ['name', 'gone-key'] };
  fs.writeFileSync(path.join(DIR, 'vm-list-prefs.json'), JSON.stringify(raw));
  P._resetVmListPrefsForTest();
  assert.deepEqual([P.getPrefs('kim').slots[0].cols, P.getPrefs('kim').slots[0].droppedCols], [['name'], 1]);
  // 손상 → 보존 · 쓰기 거부
  fs.writeFileSync(path.join(DIR, 'vm-list-prefs.json'), '{"users":');
  P._resetVmListPrefsForTest();
  const w = P.setPref('kim', 1, { cols: ['name'] });
  assert.deepEqual([w.ok, w.status, w.code], [false, 503, 'prefsUnreadable']);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('vm-list-prefs.json.corrupt')));
  fs.rmSync(path.join(DIR, 'vm-list-prefs.json'), { force: true });
  P._resetVmListPrefsForTest();
  // '__proto__' 계정도 객체 키가 되지 않는다
  assert.equal(P.setPref('__proto__', 1, { cols: ['name'] }).ok, true);
  assert.equal(P.getPrefs('__proto__').slots[0].cols[0], 'name');
  assert.equal({}.slots, undefined);
});

test('E 라우트 — 고른 열 CSV · 수집 안 됨 · Veeam 미선택이면 대조 안 함 · 범위 404 · 저장값 본인·역할 · 카탈로그·미리보기', async () => {
  const express = (await import('express')).default;
  const api0 = await import('../src/routes/api/veeam.js');
  P._resetVmListPrefsForTest();
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, hosts: [],
    vcenters: [{ id: VC, name: 'vc1', tagInv: { tags: [{ id: 't1', name: '운영', cat: 0 }], categories: [{ id: 'c1', name: '환경' }], vmTags: { 'vm-1': [0] }, fields: [{ key: 1, name: 'Owner' }], vmCustom: { 'vm-1': { 1: 'ops' } } } },
      { id: OUT, name: 'vc9' }],
    vms: [
      { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON', notes: '결제 API', cfg: { firmware: 'efi' } },
      { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC/vm/A/B', powerState: 'POWERED_ON' },
      { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', folder: 'DC/vm', powerState: 'POWERED_ON' },
    ] };
  try {
    let user = { username: 'adm', role: 'admin' };
    const app = express(); app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => { req.user = user; next(); });
    const api = express.Router(); api0.registerVeeamBadges(api); app.use('/api', api);
    const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    closers.push(() => new Promise((ok) => srv.close(() => ok())));
    const base = `http://127.0.0.1:${srv.address().port}/api`;
    const post = (p, body, vc = VC) => fetch(`${base}${p}?vcenterId=${encodeURIComponent(vc)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const send = (method, body, q = '') => fetch(`${base}/veeam/vm-list/prefs${q}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

    const r = await post('/veeam/vm-list.csv', { cols: ['name', 'notes', 'tags', 'custom', 'fsType', 'fw', 'folder'] });
    assert.equal(r.status, 200, await r.clone().text());
    const t = parseCsvRows((await r.text()).replace(/^\uFEFF/, ''));
    assert.deepEqual(t[0], ['VM', '메모(vCenter 주석)', 'vSphere 태그(카테고리:태그)', '사용자 지정 속성', '파일 시스템 종류(NTFS·ext4·xfs)', '펌웨어(BIOS/EFI)', '폴더 경로'], '고른 순서대로');
    const byName = Object.fromEntries(t.slice(1).map((x) => [x[0], x]));
    assert.deepEqual(byName.web01.slice(1), ['결제 API', '환경:운영', 'Owner=ops', 'xfs', 'EFI', 'DC/A']);
    assert.deepEqual(byName.db01.slice(1, 6), ['', '', '', CAT.MISSING, CAT.MISSING], '태그 연결 없음은 빈칸 · 파티션 미수집·구성 캐시 미도달은 수집 안 됨');
    assert.equal((await post('/veeam/vm-list.csv', { cols: ['name', 'zzz'] })).status, 400);
    // 태그를 아직 못 읽은 vCenter — 빈칸이 아니라 '수집 안 됨'
    const o = parseCsvRows((await (await post('/veeam/vm-list.csv', { cols: ['name', 'tags', 'custom'] }, OUT)).text()).replace(/^\uFEFF/, ''));
    assert.deepEqual(o[1], ['o1', CAT.MISSING, CAT.MISSING]);
    assert.equal((await post('/veeam/vm-list.csv', { cols: ['name'] }, 'nope:vc')).status, 404);
    // 범위 계정 — 범위 밖 vCenter 404
    user = { username: 'scoped', role: 'admin', scope: { vcenters: [OUT] } };
    assert.equal((await post('/veeam/vm-list.csv', { cols: ['name', 'notes'] })).status, 404);
    assert.equal((await fetch(`${base}/veeam/vm-list/catalog?vcenterId=${encodeURIComponent(VC)}`)).status, 404);
    user = { username: 'adm', role: 'admin' };
    // 카탈로그 · 미리보기
    const cat = await (await fetch(`${base}/veeam/vm-list/catalog?vcenterId=${encodeURIComponent(VC)}`)).json();
    assert.deepEqual([cat.status.tags, cat.status.vmTotal, cat.status.cfgVms, cat.groups.length > 5, !!cat.prefs], ['ok', 2, 1, true, true]);
    const pv = await (await post('/veeam/vm-list/preview', { cols: ['name', 'tags'], ids: [`${VC}:vm-1`, `${OUT}:vm-1`] })).json();
    assert.deepEqual([pv.head, pv.cells], [['VM', 'vSphere 태그(카테고리:태그)'], [['web01', '환경:운영']]], '남의 vCenter id 는 빠진다');
    // 저장값 — 본인 것만(본문 username 무시) · 역할 · 데모
    let w = await (await send('PUT', { slot: 1, username: 'victim', value: { name: '내 조합', cols: ['name', 'tags'] } })).json();
    assert.equal(w.ok, true);
    assert.equal(P.getPrefs('adm').slots[0].name, '내 조합');
    assert.equal(P.getPrefs('victim').slots[0], null, '본문의 계정 이름을 믿지 않는다');
    w = await (await send('PUT', { slot: 'default', value: { cols: ['name'] } })).json();
    assert.deepEqual(w.prefs.def.cols, ['name']);
    assert.equal((await send('DELETE', null, '?slot=1')).status, 200);
    assert.equal(P.getPrefs('adm').slots[0], null);
    user = { username: 'viewer1', role: 'viewer' };
    assert.equal((await send('PUT', { slot: 1, value: { cols: ['name'] } })).status, 403);
    user = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
    assert.equal((await send('PUT', { slot: 1, value: { cols: ['name'] } })).status, 403, '데모 계정은 저장 불가');
  } finally { store.snapshot = prev; }
});

test('F Veeam 열이 없으면 Veeam 대조(vcBackup)를 부르지 않는다 — 소스 · 화면 연결', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /const needVeeam = !sel \|\| kind === 'xlsx' \|\| needsOf\(sel\.keys\)\.has\('veeam'\);\s*\n\s*const b = needVeeam \? await vcBackup/);
  assert.match(src, /api\.put\('\/veeam\/vm-list\/prefs', requirePerm\('data\.csv'\), requireRole\('admin', 'operator'\)/);
  assert.match(src, /setPref\(req\.user\?\.username,/);
  const web = fs.readFileSync(new URL('../../web/src/views/VCenterDetail.jsx', import.meta.url), 'utf8');
  assert.match(web, /<VmListExportDialog /);
});
