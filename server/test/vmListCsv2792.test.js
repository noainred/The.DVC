/**
 * v2.792 — vCenter › VM 및 폴더 'VM 목록 CSV'(사용자 요청: "vm list export 할때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부").
 *  · 한 칸 판단(backupStatus.backupVerdict)은 세부내용 '보기' 분류(viewClass)를 그대로 옮긴다 — 모르면 '모름', 둘 다 확인했는데 흔적이 없으면 '확인 안 됨'
 *  · CSV 열(veeam/vmListCsv.js): Veeam 상태(연동 없음·없음·모름 구분) · 지금 Veeam 임시 스냅샷(잔존 따로) · 이벤트 기준 · 전체 스냅샷 · 수식 가드
 *  · 실제 라우트(POST /veeam/vm-list.csv): data.csv(관리자) · 조회 범위 밖 404 · 화면 id ∩ 그 vCenter 인벤토리 · noOff · 상한 400 · 동시 1건 409 · 감사
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmlist2792-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC, SN, OUT].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지 — storageUsage2789 머리말)
const BS = await import('../src/veeam/backupStatus.js');
const L = await import('../src/veeam/vmListCsv.js');
const { parseCsvRows } = await import('../src/util/csv.js');
const R = await import('../src/veeam/registry.js');
const VS = await import('../src/veeam/store.js');
const { listAudit } = await import('../src/audit.js');
const EB = await import('../src/util/exportBusy.js');
const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { registerVeeamBadges, VM_LIST_MAX_IDS } = await import('../src/routes/api/veeam.js');

const H = 3_600_000;
const parse = (text) => parseCsvRows(text.replace(/^﻿/, ''));

test('① 한 칸 판단 — Veeam · 스냅샷만 · 연동 없음 · Veeam 모름 · 확인 안 됨 · 모름 · 잔존은 흔적이 아니다', () => {
  const now = Date.now();
  const vm = (v, ev, snapNow) => ({ id: 'x', v, s: { ...(ev === 'unknown' ? {} : { ev }), now: snapNow || null } });
  const veeam = { state: 'ok', jobs: [], rp: 2, lb: now - H };
  assert.equal(BS.backupVerdict(vm(veeam, null)).code, 'veeam');
  assert.equal(BS.backupVerdict(vm(null, { ts: now - H, n: 1 })).code, 'snap', 'Veeam 대상 아님이 확인됐고 이벤트 흔적');
  assert.equal(BS.backupVerdict(vm(null, null, { n: 1, ts: now - H, stale: false })).code, 'snap', '지금 임시 스냅샷');
  assert.equal(BS.backupVerdict(vm(null, { ts: now - H, n: 1 }), { linked: false }).code, 'snap-unlinked');
  const vUnknown = { id: 'x', s: { ev: { ts: now - H, n: 2 }, now: null } };   // v 키 없음 = Veeam 모름
  assert.equal(BS.backupVerdict(vUnknown).code, 'snap-vunknown');
  assert.equal(BS.backupVerdict(vm(null, null)).code, 'none', '둘 다 확인했고 흔적 없음');
  assert.equal(BS.backupVerdict(vm(null, 'unknown')).code, 'unknown', '스냅샷 기준을 모르면 판단하지 않는다');
  assert.equal(BS.backupVerdict({ id: 'x', s: { now: null } }).code, 'unknown');
  assert.equal(BS.backupVerdict(vm(null, null, { n: 1, ts: now - 30 * H, stale: true })).code, 'none', '하루 넘은 잔존은 백업 흔적으로 치지 않는다(viewClass 와 같다)');
  for (const c of Object.keys(BS.VERDICT_TEXT)) assert.ok(BS.VERDICT_TEXT[c]);
});

test('② CSV 열 — 상태 글자 · 모름/없음/연동 없음 · 포탈 시각 · 전체 스냅샷 · 수식 가드', () => {
  const ts = Date.UTC(2026, 9, 26, 1, 30);   // KST 10:30
  const rows = [
    { inv: { name: '=HYPERLINK("x")', cluster: 'C1', host: 'esx1', cpuCount: 4, memMB: 8192, storageGB: 120.44, ipAddress: '10.0.0.5', snapshotCount: 2, snapshotSizeGB: 3.25, snapshotNewestTs: ts, snapshotNames: ['before-patch', 'VEEAM BACKUP TEMPORARY SNAPSHOT'] },
      view: { id: 'a', name: '=HYPERLINK("x")', folder: 'DC/vm/A', power: 'POWERED_ON', v: { state: 'run', pg: 42, jobs: ['J1', 'J2'], rp: 5, lb: ts, lastResult: 'Success' }, s: { ev: { ts, n: 3 }, now: { n: 1, ts, stale: false } } } },
    { inv: { name: 'b', template: true }, view: { id: 'b', name: 'b', folder: 'DC/vm', power: 'POWERED_OFF', v: null, s: { now: null } } },
  ];
  const csv = L.vmListCsv({ vcName: 'vc01', rows, linked: true, snapDays: 7, offsetMin: 540 });
  assert.ok(csv.startsWith('﻿'), 'BOM — 엑셀 한글');
  const t = parse(csv);
  const head = t[0];
  const col = (r, h) => t[r][head.indexOf(h)];
  assert.deepEqual(head.slice(0, 6), ['vCenter', '폴더 1단계', '폴더 2단계', '폴더 경로', 'VM', '전원'], '폴더는 단계 열(가장 깊은 VM 에 맞춤) + 경로');
  assert.deepEqual([col(1, '폴더 1단계'), col(1, '폴더 2단계'), col(1, '폴더 경로'), col(2, '폴더 2단계'), col(2, '폴더 경로')], ['DC', 'A', 'DC/A', '', 'DC'], "숨은 'vm' 폴더는 뺀다(화면 트리와 같은 규칙)");
  assert.deepEqual([L.folderParts('vm'), L.folderParts('Production/Web'), L.folderParts(''), L.folderLevels([])], [[], ['Production', 'Web'], [], 1]);
  assert.ok(head.includes('Veeam 마지막 백업 완료 (UTC+09:00)'));
  assert.ok(head.includes('최근 7일 Veeam 스냅샷 생성 횟수'));
  assert.equal(col(1, 'VM'), '\'=HYPERLINK("x")', '수식 가드');
  assert.deepEqual([col(1, '전원'), col(1, '메모리(GB)'), col(1, '스토리지 사용(GB)')], ['켜짐', '8', '120.4']);
  assert.deepEqual([col(1, '백업 판단'), col(1, 'Veeam 백업'), col(1, 'Veeam 진행률(%)'), col(1, 'Veeam 작업'), col(1, 'Veeam 복원 지점')], ['Veeam 백업', '백업 중', '42', 'J1 | J2', '5']);
  assert.equal(col(1, 'Veeam 마지막 백업 완료 (UTC+09:00)'), '2026-10-26 10:30', '포탈 시각(프로세스 TZ 아님)');
  assert.deepEqual([col(1, 'Veeam 임시 스냅샷(지금)'), col(1, 'Veeam 임시 스냅샷 잔존(하루+)'), col(1, '최근 7일 Veeam 스냅샷 생성 횟수')], ['1', '', '3']);
  assert.deepEqual([col(1, '스냅샷 수(전체)'), col(1, '스냅샷 크기(GB)'), col(1, '스냅샷 이름')], ['2', '3.3', 'before-patch | VEEAM BACKUP TEMPORARY SNAPSHOT']);
  assert.deepEqual([col(2, '전원'), col(2, '템플릿'), col(2, 'Veeam 백업'), col(2, '최근 7일 Veeam 스냅샷 생성 횟수'), col(2, '백업 판단')], ['꺼짐', '예', '없음', '모름', '모름'],
    '이벤트를 모르면 0 이 아니라 모름 · 판단도 모름');
  assert.equal(col(2, 'vCPU'), '', '모르는 수는 빈칸(0 아님)');
  const un = parse(L.vmListCsv({ vcName: 'vc02', rows: [rows[1]], linked: false }));
  assert.equal(un[1][un[0].indexOf('Veeam 백업')], '연동 없음');
  assert.equal(L.veeamStateText(undefined, true), '모름');
});

test('③ 실제 라우트 — data.csv · 범위 404 · 화면 id ∩ 인벤토리 · noOff · 상한 · 409 · 감사', async () => {
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'Daily', type: 'Backup', lastResult: 'Success' }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 },
  ] });
  const prev = store.snapshot;
  const NOW = Math.floor(Date.now() / H) * H;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, SN, OUT].map((id) => ({ id, name: id })), hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON', snapshotCount: 0 },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC/vm/A', powerState: 'POWERED_ON', snapshotCount: 1, veeamSnaps: 1, veeamSnapTs: NOW - H },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'old01', folder: 'DC/vm/B', powerState: 'POWERED_OFF' },
    { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01', folder: 'DC2/vm', powerState: 'POWERED_ON', veeamSnaps: 1, veeamSnapTs: NOW - H },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'adm', role: 'admin', scope: { vcenters: [VC, SN] } };
  const app = express();
  app.use(express.json({ limit: '1mb' }));   // 운영 /api 본문 상한(index.js)과 같게 — 상한 2만 개가 그 안에 든다
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (vc, body) => fetch(`${base}/veeam/vm-list.csv?vcenterId=${encodeURIComponent(vc)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // 화면 id 목록 — 다른 vCenter 의 id 는 교집합에서 빠진다
    let r = await post(VC, { ids: [`${VC}:vm-1`, `${VC}:vm-2`, `${OUT}:vm-1`] });
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="vm-list-apac_vc01-all-\d{8}-\d{4}\.csv"/, '화면 조건이 파일 이름에(검증 지적 — 세 조건의 파일 이름이 같았다)');
    let t = parse(await r.text());
    const head = t[0]; const col = (row, h) => row[head.indexOf(h)];
    assert.deepEqual(t.slice(1).map((x) => col(x, 'VM')), ['db01', 'web01'], '폴더 → 이름 순 · 남의 vCenter VM 없음');
    const web = t.find((x) => col(x, 'VM') === 'web01'); const db = t.find((x) => col(x, 'VM') === 'db01');
    assert.deepEqual([col(web, '백업 판단'), col(web, 'Veeam 백업'), col(web, 'Veeam 작업'), col(web, 'Veeam 복원 지점')], ['Veeam 백업', '백업 대상', 'Daily', '3']);
    assert.deepEqual([col(db, '백업 판단'), col(db, 'Veeam 백업'), col(db, 'Veeam 임시 스냅샷(지금)')], ['스냅샷 흔적만(Veeam 대상 아님)', '없음', '1']);

    // id 를 보내지 않으면 전체 · noOff 면 꺼진 VM 제외(화면 visibleVms 와 같은 조건)
    t = parse(await (await post(VC, {})).text());
    assert.equal(t.length - 1, 3);
    r = await post(VC, { power: 'noOff' });
    assert.match(r.headers.get('content-disposition'), /-poweredon-\d{8}-\d{4}\.csv"/);
    t = parse(await r.text());
    assert.deepEqual(t.slice(1).map((x) => col(x, 'VM')).sort(), ['db01', 'web01']);
    // view 는 이름표일 뿐 — 대상은 ids 로 고른다(모르는 값은 무시)
    r = await post(VC, { ids: [`${VC}:vm-3`], view: 'search' });
    assert.match(r.headers.get('content-disposition'), /-search-\d{8}-\d{4}\.csv"/);
    assert.deepEqual(parse(await r.text()).slice(1).map((x) => col(x, 'VM')), ['old01']);
    assert.match((await post(VC, { view: '../x' })).headers.get('content-disposition'), /-all-\d{8}/);

    // 연동 없는 vCenter — Veeam 은 '연동 없음', 스냅샷 흔적은 'Veeam 연동 없음' 판단
    t = parse(await (await post(SN, {})).text());
    const colSn = (row, h) => row[t[0].indexOf(h)];   // 폴더 단계 열 수가 파일마다 다르다(가장 깊은 VM 기준) — 그 파일의 머리로 찾는다
    assert.deepEqual([colSn(t[1], 'Veeam 백업'), colSn(t[1], '백업 판단')], ['연동 없음', '스냅샷 흔적(Veeam 연동 없음)']);

    // 범위 밖·없는 vCenter 404 · 형식 오류·상한 400 · 동시 1건 409
    assert.equal((await post(OUT, {})).status, 404);
    assert.equal((await post('nope', {})).status, 404);
    assert.equal((await post(VC, { ids: 'x' })).status, 400);
    assert.equal((await post(VC, { ids: Array.from({ length: VM_LIST_MAX_IDS + 1 }, (_, i) => `i${i}`) })).status, 400);
    const real = Array.from({ length: VM_LIST_MAX_IDS }, (_, i) => `${VC}:vm-${100000 + i}`);   // 실제 모양의 id 2만 개도 1MB 안
    assert.ok(JSON.stringify({ ids: real }).length < 1024 * 1024);
    assert.equal((await post(VC, { ids: real })).status, 200);
    const lock = EB.acquireExport('vm-list.csv', { user: { username: 'other' } });
    try { assert.equal((await post(VC, {})).status, 409); } finally { lock.release(); }

    // 감사 — 대수만(VM 이름 없음)
    const au = listAudit({ limit: 50 });
    const rows = (Array.isArray(au) ? au : au.rows || au.items || []).filter((x) => x.action === 'vm-list.csv');
    assert.ok(rows.length >= 4);
    assert.ok(rows.some((x) => x.target === VC && /^2 rows · all · 화면 목록$/.test(x.detail)), JSON.stringify(rows.slice(0, 3)));

    // CSV 권한 — operator 는 data.csv 가 없다(관리자 전용 권한) · 권한이 꺼진 관리자도 403
    user = { username: 'op', role: 'operator', scope: {} };
    assert.equal((await post(VC, {})).status, 403);
    // 관리자의 CSV 끄기는 역할 매트릭스(userHasPermission)가 판정한다 — 이 라우트가 그 게이트(data.csv)를 쓰는지 소스로 고정
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'api', 'veeam.js'), 'utf8');
    assert.match(src, /api\.post\('\/veeam\/vm-list\.csv', requirePerm\('data\.csv'\),/);
    assert.match(src, /api\.post\('\/veeam\/vm-list\.xlsx', requirePerm\('data\.csv'\),/);
    // 비밀이 실리지 않는다
    user = { username: 'adm', role: 'admin', scope: {} };
    assert.ok(!(await (await post(VC, {})).text()).includes('PW-secret-1'));
  } finally { store.snapshot = prev; }
});
