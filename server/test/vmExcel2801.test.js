/**
 * v2.801 — VM 엑셀 꾸미기 · 폴더 트리 · Veeam '여부' 항목 · 미리보기 크게 보기(승인 시안 https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h).
 *  사용자 요청(2026-10-27): "엑셀로 예쁘게, 가독성 좋게" · "디렉터리를 계층별로 — 폴더별로 나눠서" · "선택 항목에 veeam 마지막 백업 여부 /
 *  백업용 snapshot 최근 생성 여부도" · "미리보기를 전체화면으로 팝업". 결정: 폴더 트리 시트 · 시안대로 전부 · 여부 기준 기본 1일.
 *  ① 여부 판정(backupStatus — 판정 코어 하나): 모르는 것은 '아니오' 가 아니라 '모름'
 *  ② 두 카탈로그가 같은 항목을 쓴다(VM 전체 정보의 Veeam 묶음 = VM 목록 항목) · 못 읽으면 '수집 안 됨'
 *  ③ 요약 숫자 — 못 읽은 값은 0 이 아니다('' · null 은 unknown 으로 따로)
 *  ④ VM 전체 정보 엑셀 4시트 — 폴더 트리(뿌리 'vCenter / vm' · 개요 단계 · 폴더 합계 '≥' · 셈) · 데이터 서식 · 스키마 순서
 *  ⑤ Veeam 판정 통로(vmViewProvider) — 걸린 함수가 없거나 실패하면 null(칸 '수집 안 됨')
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmexcel2800-'));
process.env.CONFIG_DIR = DIR;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지)
const B = await import('../src/veeam/backupStatus.js');
const LC = await import('../src/veeam/vmListCatalog.js');
const EC = await import('../src/vcenter/vmExportCatalog.js');
const SM = await import('../src/vcenter/vmExportSummary.js');
const XS = await import('../src/vcenter/vmXlsxStyle.js');
const VX = await import('../src/vcenter/vmExportXlsx.js');
const VE = await import('../src/vcenter/vmExport.js');
const PV = await import('../src/veeam/vmViewProvider.js');
const LP = await import('../src/veeam/vmListPrefs.js');
const EP = await import('../src/vcenter/vmExportPrefs.js');
const { store } = await import('../src/store.js');
const ExcelJS = (await import('exceljs')).default;
const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');
const WP = await import('../../web/src/views/tools/exportPreviewText.js');   // 미리보기 팝업의 칸 색(웹) — 엑셀 서식(서버)과 한 쌍

const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const text = (cell) => (cell.value && typeof cell.value === 'object' && cell.value.richText ? cell.value.richText.map((x) => x.text).join('') : cell.value);

test('① 여부 판정 — 예 · 아니오 · 모름(모르는 것을 아니오로 쓰지 않는다)', () => {
  const bk = (v, o = {}) => B.recentBackupYn(v, { now: NOW, ...o });
  assert.equal(bk({ v: { lb: NOW - 3 * H } }), '예', '기본 1일 안');
  assert.equal(bk({ v: { lb: NOW - 30 * H } }), '아니오', '하루 넘음');
  assert.equal(bk({ v: { lb: NOW - 30 * H } }, { days: 2 }), '예', '2일 기준');
  assert.equal(bk({ v: null }), '아니오', '대조에 없음(확정)');
  assert.equal(bk({ v: undefined }), '모름', 'Veeam 모름(v 키 값 없음)');
  assert.equal(bk({}), '모름', 'v 키 없음');
  assert.equal(bk({ v: { lb: NOW - H } }, { linked: false }), '모름', 'Veeam 연동 없음');
  assert.equal(bk({ v: { lb: null, rp: 0 } }), '아니오', '복원 지점 0 · 시각 없음 = 한 번도 없음');
  assert.equal(bk({ v: { lb: null, rp: 5 } }), '모름', '복원 지점은 있는데 시각 모름');
  assert.equal(bk(undefined), '모름');
  assert.equal(bk({ v: { lb: NOW - H } }, { days: 5 }), '예', '모르는 기준 일수는 기본(1일)');
  const sn = (s, o = {}) => B.recentBackupSnapYn({ s }, { now: NOW, ...o });
  assert.equal(sn({ ev: { ts: NOW - 2 * H, n: 1 }, now: null }), '예');
  assert.equal(sn({ ev: { ts: NOW - 3 * DAY, n: 1 }, now: null }), '아니오');
  assert.equal(sn({ ev: { ts: NOW - 3 * DAY, n: 1 }, now: null }, { days: 7 }), '예');
  assert.equal(sn({ ev: null, now: null }), '아니오', '이벤트를 읽었는데 없음');
  assert.equal(sn({ ev: undefined, now: null }), '모름', '이벤트를 못 읽음');
  assert.equal(sn({ now: null }), '모름', 'ev 키 없음');
  assert.equal(sn({ ev: undefined, now: { n: 1, ts: NOW - H, stale: false } }), '예', '지금 있는 임시 스냅샷이 기준 안');
  assert.equal(B.recentBackupSnapYn(undefined), '모름');
  assert.deepEqual([...B.YN_DAYS], [1, 2, 3, 7]);
  assert.equal(B.YN_DEFAULT_DAYS, 1, '사용자 결정 — 기본 1일');
});

test('② VM 목록 카탈로그의 여부 두 항목 · VM 전체 정보 Veeam 묶음은 같은 항목(머리·칸)', () => {
  const cols = LC.selectedColumns(['name', 'vbkYn', 'vsnapYn'], { ynDays: 3, now: NOW });
  assert.deepEqual(cols.map((c) => c.h), ['VM', '최근 3일 Veeam 백업', '최근 3일 백업용 스냅샷 생성']);
  const r = { inv: { name: 'a' }, linked: true, view: { v: { lb: NOW - 2 * DAY }, s: { ev: null, now: null } } };
  assert.deepEqual(cols.map((c) => c.get(r)), ['a', '예', '아니오']);
  assert.deepEqual(cols.map((c) => c.get({ inv: { name: 'b' }, linked: false })), ['b', '모름', '모름'], 'Veeam 소스 없음(view 없음) = 모름');
  assert.deepEqual(LC.catalogView().ynDays, [1, 2, 3, 7]);
  assert.ok(!LC.LEGACY_KEYS.includes('vbkYn'), 'v2.792 열(예전 엑셀 기본)에는 넣지 않는다');
  // VM 전체 정보 — Veeam 묶음 = VM 목록 항목(라벨 같음) · src 'veeam' · needsOf 'veeam'
  for (const k of EC.VEEAM_KEYS) {
    const a = EC.CATALOG.find((c) => c.key === k); const b = LC.CATALOG.find((c) => c.key === k);
    assert.ok(a && b, k);
    assert.equal(a.label, b.label, `${k} 라벨이 같다`);
    assert.equal(a.src, 'veeam');
  }
  assert.ok(EC.needsOf(['vbkYn']).has('veeam'));
  assert.ok(!EC.needsOf(['name']).has('veeam'), 'Veeam 항목이 없으면 읽지 않는다(무겁다)');
  const ec = EC.selectedColumns(['vbkYn', 'vlast'], { ynDays: 2, offsetMin: 540, now: NOW });
  assert.deepEqual(ec.map((c) => c.h), ['최근 2일 Veeam 백업', 'Veeam 마지막 백업 완료 KST'], '시간대 표기는 이 카탈로그의 것(KST)');
  assert.deepEqual(ec.map((c) => c.get({ name: 'a' }, {})), [EC.MISSING, EC.MISSING], 'Veeam 판정을 못 읽음 = 수집 안 됨');
  assert.deepEqual(ec.map((c) => c.get({ name: 'a' }, { bv: null, bvLinked: true })), ['모름', ''], '그 VM 판정 없음 = 모름 · 시각 빈칸');
  assert.equal(ec[0].get({ name: 'a' }, { bv: { v: { lb: NOW - H }, s: {} }, bvLinked: true }), '예');
  assert.equal(EC.catalogView({ snapDays: 7 }).groups.find((g) => g.id === 'veeam').items.find((i) => i.key === 'vsnapN').label, '최근 7일 Veeam 스냅샷 생성 횟수');
  // 저장값 — ynDays 형식만
  assert.equal(EP.normalizeVmExportOpts({ ynDays: 7 }).value.ynDays, 7);
  assert.equal(EP.normalizeVmExportOpts({ ynDays: 4 }).ok, false);
  assert.equal(LP.normalizeValue({ cols: ['name'], ynDays: 2 }).value.ynDays, 2);
  assert.equal(LP.normalizeValue({ cols: ['name'], ynDays: '2' }).ok, false);
});

test('③ 요약 숫자 — 못 읽은 값은 0 이 아니다 · 클러스터 · OS · 확인할 것', () => {
  const vms = [
    { id: 'v:1', cluster: 'C1', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, storageGB: 100, uncommittedGB: 20, snapshotCount: 1, snapshotOldestTs: NOW - 10 * DAY, toolsStatus: 'RUNNING', guestOS: 'Win', cfg: { consolidationNeeded: true }, dev: { cdroms: [{ connected: true, file: '[ds] a.iso' }] } },
    { id: 'v:2', cluster: 'C1', powerState: 'POWERED_ON', cpuCount: '', memMB: null, storageGB: 50, uncommittedGB: null, snapshotCount: 0, toolsStatus: 'NOT_RUNNING', guestOS: 'Win' },
    { id: 'v:3', cluster: '', powerState: 'POWERED_OFF', cpuCount: 2, memMB: 2048, storageGB: 10, uncommittedGB: 0, snapshotCount: null, toolsStatus: '', guestOS: 'Linux' },
    { id: 'v:4', cluster: 'C2', powerState: 'POWERED_ON', template: true, cpuCount: 1, memMB: 1024, toolsStatus: '', guestOS: '' },
  ];
  const views = { linked: true, byId: new Map([['v:1', { v: { lb: NOW - H }, s: {} }], ['v:2', { v: null, s: {} }], ['v:3', { s: {} }]]) };
  const S = SM.vmExportSummary(vms, { views, ynDays: 1, now: NOW });
  assert.deepEqual([S.vms, S.on, S.off], [4, 3, 1]);
  assert.deepEqual(S.cpu, { sum: 7, unknown: 1 }, "cpuCount '' 은 0 이 아니라 모름");
  assert.deepEqual(S.memGB, { sum: 11, unknown: 1 });
  assert.deepEqual(S.provGB, { sum: 130, unknown: 2 }, 'committed·uncommitted 둘 다 있어야 프로비저닝');
  assert.equal(SM.sumText(S.cpu), '≥7', '부분 합은 ≥');
  assert.equal(SM.sumText({ sum: 0, unknown: 4 }, { total: 4 }), '—', '하나도 모르면 —');
  assert.deepEqual(S.snap, { vms: 1, unknown: 2, old: 1, oldUnknown: 0, oldDays: 7 });
  assert.deepEqual(S.tools, { bad: 1, unknown: 0 }, '템플릿·꺼진 VM 은 넣지 않는다');
  assert.equal(S.consolidation, 1); assert.equal(S.cdrom, 1); assert.equal(S.question, 0);
  assert.deepEqual(S.veeam, { days: 1, yes: 1, no: 1, unknown: 2 }, '판정 없는 VM 은 모름');
  assert.deepEqual(S.clusters.map((c) => [c.name, c.vms, c.on]), [['C1', 2, 2], ['', 1, 0], ['C2', 1, 1]]);
  assert.equal(S.os[0].name, 'Win'); assert.equal(S.os[0].vms, 2);
  const none = SM.vmExportSummary([{ id: 'x', powerState: 'POWERED_ON' }], {});
  assert.equal(none.consolidation, null, '구성 캐시가 없으면 0 이 아니라 null(—)');
  assert.equal(none.veeam, null);
});

test('④ VM 전체 정보 엑셀 — 4시트 · 폴더 트리 · 폴더 합계 · 데이터 서식 · 스키마 순서', async () => {
  const cols = [
    { key: 'name', h: 'VM 이름', group: 'base', src: 'snap' }, { key: 'powerState', h: '전원', group: 'base', src: 'snap' },
    { key: 'cpuCount', h: 'vCPU', group: 'cpu', src: 'snap' }, { key: 'cpuUsagePct', h: 'CPU 사용률(%)', group: 'cpu', src: 'snap' },
    { key: 'vbkYn', h: '최근 1일 Veeam 백업', group: 'veeam', src: 'veeam' }, { key: 'uuid', h: 'VM UUID', group: 'ident', src: 'live' },
  ];
  const cells = [
    ['app-1', 'POWERED_ON', 4, 95, '예', 'u-1'],
    ['app-2', 'POWERED_OFF', 2, 10, '아니오', EC.MISSING],
    ['db-1', 'POWERED_ON', '', 82, '모름', 'u-3'],
    ['top', 'POWERED_ON', 1, 5, '예', 'u-4'],
    ['deep', 'POWERED_ON', 8, 1, '예', 'u-5'],
  ];
  const rowFolder = ['A.MGMT/00.Console', 'A.MGMT/00.Console', 'A.MGMT/01.DB', '', 'L1/L2/L3/L4/L5/L6/L7/L8'];
  const rowPower = cells.map((c) => c[1]);
  const out = await VX.buildVmExportWorkbook({
    head: cols.map((c) => c.h), cells, cols: cols.map((c) => ({ ...c, item: c.key, filled: 1 })), rowFolder, rowPower,
    summary: SM.vmExportSummary([{ id: 'x', powerState: 'POWERED_ON', cpuCount: 1 }], {}),
    meta: { vcenterName: 'OC2', rows: 5, live: { state: 'off' }, at: NOW, offsetMin: 540 },
    cond: { target: '전체 VM', items: 6, groupNames: { base: '기본', cpu: 'CPU · 메모리', veeam: 'Veeam 백업', ident: '식별 · 이력' }, offsetLabel: 'KST' },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [...VX.VM_EXPORT_SHEETS]);
  assert.deepEqual([...VX.VM_EXPORT_SHEETS], ['요약', '폴더 트리', '데이터', '읽는 법']);

  // ② 폴더 트리
  const ts = wb.getWorksheet('폴더 트리');
  assert.deepEqual(ts.properties.outlineProperties, { summaryBelow: false, summaryRight: false });
  assert.deepEqual(ts.getRow(3).values.slice(1), ['폴더 / VM', '전원', 'vCPU', 'CPU 사용률(%)', '최근 1일 Veeam 백업', 'VM UUID'], '이름 열은 첫 칸이 대신한다');
  const rows = []; for (let r = 4; r <= ts.rowCount; r++) { const row = ts.getRow(r); rows.push({ lv: row.outlineLevel || 0, a: String(text(row.getCell(1))), row }); }
  const names = rows.map((x) => x.a);
  assert.equal(names[0], '📁 OC2 / vm  5 VM', '뿌리 = 화면 트리와 같은 표기');
  assert.ok(names.indexOf('📁 A.MGMT  3 VM') < names.indexOf('📁 00.Console  2 VM') && names.indexOf('📁 00.Console  2 VM') < names.indexOf('app-1'));
  assert.ok(names.indexOf('📁 01.DB  1 VM') < names.indexOf('📁 L1  1 VM'), '폴더는 코드 단위 순서(A < L)');
  assert.equal(names.at(-1), 'top', '최상위 VM 은 폴더 뒤');
  const lv = Object.fromEntries(rows.map((x) => [x.a, x.lv]));
  assert.deepEqual([lv['📁 OC2 / vm  5 VM'], lv['📁 A.MGMT  3 VM'], lv['📁 00.Console  2 VM'], lv['app-1'], lv.top], [0, 1, 2, 3, 1]);
  assert.equal(lv['📁 L7  1 VM'], 7); assert.equal(lv['📁 L8  1 VM'], 7, '깊어도 7단계에 모인다'); assert.equal(lv.deep, 7);
  const at = (n) => rows.find((x) => x.a === n).row;
  const amgmt = at('📁 A.MGMT  3 VM');
  assert.equal(text(amgmt.getCell(2)), '켜짐 2 · 꺼짐 1', '전원 셈');
  assert.equal(text(amgmt.getCell(3)), '≥6', "vCPU 를 못 읽은 VM('' — 0 이 아니다)이 있으면 ≥합");
  assert.equal(text(amgmt.getCell(4)), '', '사용률은 합하지 않는다');
  assert.equal(text(amgmt.getCell(5)), '예 1 / 2 · 모름 1', '여부 셈 — 모름은 따로');
  assert.equal(at('📁 00.Console  2 VM').getCell(3).value, 6, '모두 읽었으면 숫자 칸');
  assert.equal(at('📁 00.Console  2 VM').getCell(1).fill?.fgColor?.argb, XS.depthTint(2));
  assert.equal(at('app-1').getCell(4).fill?.fgColor?.argb, XS.PAL.redBg, '90% 이상 빨강');
  assert.equal(at('db-1').getCell(4).fill?.fgColor?.argb, XS.PAL.amberBg, '80% 이상 노랑');
  assert.equal(at('app-2').getCell(6).font?.italic, true, '수집 안 됨 흐린 기울임');

  // ③ 데이터 — 값은 그대로 · 서식만
  const ds = wb.getWorksheet('데이터');
  assert.deepEqual(ds.getRow(3).values.slice(1), cells[0], '값은 CSV 와 같다');
  assert.equal(ds.getRow(3).getCell(2).font?.color?.argb, XS.PAL.green, 'POWERED_ON 초록');
  assert.equal(ds.getRow(3).getCell(3).numFmt, '#,##0', '정수 숫자 서식');
  assert.equal(ds.getRow(4).getCell(1).fill?.fgColor?.argb, XS.PAL.zebra, '한 줄 건너 줄무늬');
  assert.equal(ds.getRow(4).getCell(5).font?.color?.argb, XS.PAL.redFg, '아니오 빨간 글자');
  assert.equal(ds.getRow(4).getCell(5).fill?.fgColor?.argb, XS.PAL.zebra, '아니오에 빨간 바탕을 칠하지 않는다(렌더 확인 — 표 전체가 빨갛게 보였다)');
  assert.equal(ds.getRow(3).getCell(1).font?.bold, true, 'VM 이름 굵게');
  // ① 요약 · ④ 읽는 법이 있다
  assert.match(String(wb.getWorksheet('요약').getRow(1).getCell(1).value), /OC2 — VM 전체 정보 요약/);

  // 스키마 순서 — Excel '복구' 대화상자(v2.799.1) 재발 방지: 트리 시트는 개요 + 폭 한 장 인쇄를 함께 쓴다
  const zip = await JSZip.loadAsync(out.buffer);
  const xml = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const a = xml.indexOf('<outlinePr'); const b = xml.indexOf('<pageSetUpPr');
  assert.ok(a > 0 && b > a, '<sheetPr> 안에서 outlinePr 가 pageSetUpPr 앞');
  for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
    const x = await zip.file(n).async('string');
    const order = ['<sheetPr', '<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<autoFilter', '<mergeCells', '<pageMargins', '<pageSetup'];
    const pos = order.map((t) => x.indexOf(t)).filter((i) => i >= 0);
    assert.deepEqual(pos, [...pos].sort((p, q) => p - q), `${n} 요소 순서`);
  }
});

test('④-2 폴더 칸 함수(순수) · 서식 종류 key 가 카탈로그에 있다', () => {
  assert.equal(VX.folderCell('cpuCount', [1, 2, 3], []), 6);
  assert.equal(VX.folderCell('cpuCount', ['', EC.MISSING], []), '', '하나도 모르면 빈칸');
  assert.equal(VX.folderCell('memGB', [1.25, 2.5], []), 3.8);
  assert.equal(VX.folderCell('powerState', [], ['POWERED_ON', 'SUSPENDED']), '켜짐 1 · 그 밖 1');
  assert.equal(VX.folderCell('vbkYn', ['모름', '모름'], []), '모름');
  assert.equal(VX.folderCell('vjudge', ['Veeam 백업', '스냅샷 흔적만(Veeam 대상 아님)', 'Veeam 백업'], []), 'Veeam 백업 2 · 스냅샷 흔적만 1');
  assert.equal(VX.folderCell('notes', ['a'], []), '');
  const keys = new Set([...EC.CATALOG.map((c) => c.key), ...LC.CATALOG.map((c) => c.key)]);
  for (const k of Object.keys(XS.KIND_BY_KEY)) assert.ok(keys.has(k), `서식 종류 key ${k} 가 카탈로그에 있다(이름이 바뀌면 서식이 조용히 빠진다)`);
  for (const k of VX.SUM_KEYS) assert.ok(keys.has(k), `합계 key ${k}`);
  assert.equal(XS.cellLook('수집 안 됨', '').font.italic, true);
  assert.equal(XS.cellLook(12.5, '').numFmt, '#,##0.0');
  assert.equal(XS.cellLook('켜짐', 'power').font.color.argb, XS.PAL.green, 'VM 목록의 한글 전원 값도');
  assert.equal(XS.cellLook('x', ''), null, '종류 없는 글자는 손대지 않는다');
});

test('⑤ Veeam 판정 통로 — 걸린 함수 · 없음 · 실패 · 표 함수가 그 값을 칸에 쓴다', async () => {
  PV.setVeeamVmViewProvider(null);
  assert.equal(await PV.veeamVmViews({}, [], {}), null, '걸린 것이 없으면 null');
  PV.setVeeamVmViewProvider(async () => { throw new Error('boom'); });
  assert.equal(await PV.veeamVmViews({}, [], {}), null, '실패하면 null');
  const VC = 'vc-x';
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: VC, name: 'OC2' }], hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'A/B', powerState: 'POWERED_ON', cpuCount: 2 },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'A', powerState: 'POWERED_OFF', cpuCount: 4 },
  ] };
  let seen = null;
  PV.setVeeamVmViewProvider(async (vc, vms) => { seen = vms.length; return { linked: true, snapDays: 7, byId: new Map([[`${VC}:vm-1`, { v: { lb: NOW - H }, s: { ev: null } }]]) }; });
  const veeamViews = (vc, vms) => PV.veeamVmViews(vc, vms, {});
  const t = await VE.buildVmExportTable(VC, { keys: ['name', 'vbkYn', 'vsnapYn'], live: false, ynDays: 1, now: NOW, veeamViews, summary: true });
  assert.equal(seen, 2, 'vCenter 전체 VM 으로 대조');
  const byName = Object.fromEntries(t.cells.map((r) => [r[0], r.slice(1)]));
  assert.deepEqual(byName.web01, ['예', '아니오']);
  assert.deepEqual(byName.db01, ['모름', '모름'], '판정이 없는 VM 은 모름');
  assert.deepEqual(t.rowFolder, ['A', 'A/B'], '행마다 폴더 경로(이름 순 — db01, web01)');
  assert.deepEqual(t.rowPower, ['POWERED_OFF', 'POWERED_ON']);
  assert.equal(t.meta.veeam, 'ok');
  assert.deepEqual(t.summary.veeam, { days: 1, yes: 1, no: 0, unknown: 1 });
  // 걸린 함수가 null 을 주면 Veeam 칸은 '수집 안 됨'
  PV.setVeeamVmViewProvider(async () => null);
  const t2 = await VE.buildVmExportTable(VC, { keys: ['name', 'vbkYn'], live: false, now: NOW, veeamViews });
  assert.deepEqual(t2.cells.map((r) => r[1]), [EC.MISSING, EC.MISSING]);
  assert.equal(t2.meta.veeam, 'unreadable');
  // Veeam 항목도 요약도 없으면 읽지 않는다
  let called = false;
  const t3 = await VE.buildVmExportTable(VC, { keys: ['name'], live: false, now: NOW, veeamViews: async () => { called = true; return null; } });
  assert.equal(called, false); assert.equal(t3.meta.veeam, null);
  PV.setVeeamVmViewProvider(null);
});

test('⑥ 웹 미리보기 칸 색 = 엑셀 서식(같은 입력으로 대조 — 두 벌이 어긋나면 화면과 파일 색이 다르다)', () => {
  assert.deepEqual(WP.KIND_BY_KEY, XS.KIND_BY_KEY, '열 key → 종류 표가 같다');
  assert.deepEqual([...WP.MISSING_TEXTS], [...XS.MISSING_TEXTS]);
  const cases = [
    ['수집 안 됨', 'uuid'], ['POWERED_ON', 'powerState'], ['POWERED_OFF', 'powerState'], ['SUSPENDED', 'powerState'], ['켜짐', 'power'],
    ['RUNNING', 'toolsStatus'], ['NOT_RUNNING', 'toolsStatus'], [95, 'cpuUsagePct'], [85, 'memUsagePct'], [10, 'cpuUsagePct'],
    ['예', 'vbkYn'], ['아니오', 'vsnapYn'], ['모름', 'vbkYn'], ['Veeam 백업', 'vjudge'], ['확인 안 됨', 'vjudge'], ['abc', 'notes'], [3, 'cpuCount'],
    ['Veeam', 'bmethod'], ['Clone', 'bmethod'], ['Config 백업', 'bmethod'], ['백업 안함', 'bmethod'], ['', 'bmethod'],
  ];
  // 서버 모양 → 같은 뜻의 이름(색 묶음)
  const sv = (v, key) => {
    const l = XS.cellLook(v, XS.kindOf(key));
    if (!l) return '';
    if (l.font?.italic) return 'missing';
    const c = l.font?.color?.argb; const bg = l.fill?.fgColor?.argb;
    if (bg === XS.PAL.redBg) return 'hot';
    if (bg === XS.PAL.amberBg && typeof v === 'number') return 'warm';
    if (c === XS.PAL.green) return XS.kindOf(key) === 'yn' ? 'yes' : 'on';
    if (c === XS.PAL.redFg) return 'no';
    if (c === XS.PAL.amber) return 'warn';
    if (c === 'FF64748B') return 'off';
    if (XS.kindOf(key) === 'method') return `m-${Object.keys(XS.METHOD_LOOK).find((k) => XS.METHOD_LOOK[k].bg === bg)}`;
    if (bg === 'FFDCFCE7') return 'v-veeam';
    if (bg === XS.PAL.amberBg) return 'v-none';
    return '';
  };
  for (const [v, key] of cases) assert.equal(WP.cellTone(v, key), sv(v, key), `${JSON.stringify(v)} @${key}`);
});
