// v3.5.0 — IP 관리 재설계 묶음 나(서버): IP 용도 · 요청자 · 할당자 · 대역 용도 · 대역별 예약/DHCP 수 · 공유 DB 열 · 관리 CSV 열.
// 설계 docs/design/ipam-redesign §5-0(컨펌 '전부 기본값' — 용도는 새 필드).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam350-'));
process.env.CONFIG_DIR = dir;

const { subnetKey, setSubnetNote, getSubnetNote, withSubnetNotes, SUBNET_PURPOSE_MAX } = await import('../src/ipam/subnetNotes.js');
const { COLUMNS, toRecord } = await import('../src/ipam/record.js');
const { MIGRATE_COLUMNS } = await import('../src/ipam/db.js');
const { setOverride, getOverride } = await import('../src/ipam/overrides.js');
const { policyCellCounts } = await import('../src/ipam/ledger.js');
const { setPolicy } = await import('../src/ipam/rangePolicies.js');
const csv = await import('../src/ipam/manageCsv.js');

test('대역 키 정규화 — 잘못된 것은 빈 값', () => {
  assert.equal(subnetKey('10.20.30'), '10.20.30');
  assert.equal(subnetKey('10.20.30.0/24'), '10.20.30');
  assert.equal(subnetKey('10.20.30.0'), '10.20.30');
  for (const bad of ['10.20', '10.20.300', '010.1.1', 'a.b.c', '10.20.30.5', '']) assert.equal(subnetKey(bad), '', bad);
});

test('대역 용도 저장 · 지우기 · 길이 초과는 자르지 않고 거부', () => {
  assert.equal(setSubnetNote('10.20.30', { purpose: '웹 서비스망', desc: '외부 서비스' }, 'op').ok, true);
  assert.equal(getSubnetNote('10.20.30.0/24').purpose, '웹 서비스망');
  const long = setSubnetNote('10.20.30', { purpose: 'x'.repeat(SUBNET_PURPOSE_MAX + 1) });
  assert.equal(long.ok, false);
  assert.equal(getSubnetNote('10.20.30').purpose, '웹 서비스망', '거부된 저장이 값을 바꾸면 안 된다');
  assert.equal(setSubnetNote('bad', { purpose: 'x' }).ok, false);
  const l = withSubnetNotes([{ base: '10.20.30', used: 1 }, { base: '10.20.31', used: 2 }]);
  assert.equal(l[0].purpose, '웹 서비스망');
  assert.equal(l[1].purpose, undefined);
  setSubnetNote('10.20.30', { purpose: '', desc: '' });
  assert.equal(getSubnetNote('10.20.30'), null, '둘 다 비면 지운다');
});

test('IP 관리상태 — 용도 · 요청자 · 할당자 저장(200자) · 셋만 있어도 레코드가 남는다', () => {
  const r = setOverride('10.9.9.9', { purpose: 'DB', requester: 'dba-team', assigner: 'net-admin' }, { username: 't' });
  assert.equal(r.ok, true);
  const o = getOverride('10.9.9.9');
  assert.deepEqual([o.purpose, o.requester, o.assigner], ['DB', 'dba-team', 'net-admin']);
  setOverride('10.9.9.9', { purpose: 'p'.repeat(300) }, { username: 't' });
  assert.equal(getOverride('10.9.9.9').purpose.length, 200);
});

test('공유 DB — 새 열은 맨 뒤 · 옛 DB 이전 목록에 있다 · toRecord 와 열 수가 같다', () => {
  assert.deepEqual(COLUMNS.slice(-3), ['purpose', 'requester', 'assigner']);
  for (const c of ['purpose', 'requester', 'assigner']) assert.ok(MIGRATE_COLUMNS.includes(c), c);
  const rec = toRecord({ ip: '1.1.1.1', ipPurpose: 'p', requester: 'r', assigner: 'a' }, 'now');
  assert.equal(rec.length, COLUMNS.length);
  assert.deepEqual(rec.slice(-3), ['p', 'r', 'a']);
  assert.equal(COLUMNS.indexOf('range_policy_spec'), COLUMNS.length - 4, '앞 열의 순서는 그대로');
});

test('대역별 예약 · DHCP 수 — 대장에 있는 주소는 세지 않는다 · 숨김 정책은 어느 쪽도 아니다', () => {
  assert.equal(setPolicy({ spec: '10.77.1.1-10.77.1.9', status: 'reserved' }, { username: 't' }).ok, true);
  assert.equal(setPolicy({ spec: '10.77.1.200-10.77.1.254', status: 'dhcp' }, { username: 't' }).ok, true);
  assert.equal(setPolicy({ spec: '10.77.1.100-10.77.1.109', status: 'ignored' }, { username: 't' }).ok, true);
  const c = policyCellCounts('10.77.1', new Set(['1', '2', '200']));
  assert.deepEqual(c, { rsv: 7, dhcp: 54 });
  assert.deepEqual(policyCellCounts('10.77.2', new Set()), { rsv: 0, dhcp: 0 });
});

test("관리 CSV — 용도 · 요청자 · 할당자 열, '용도' 별칭은 이제 label 이 아니라 용도", () => {
  const out = csv.manageToCsv([{ ip: '1.1.1.1', override: { label: 'L', purpose: '웹', requester: 'r', assigner: 'a' }, annotation: {} }]);
  const [head, row] = out.replace(/^﻿/, '').split('\r\n');
  assert.equal(head, 'ip,status,deviceType,owner,label,purpose,requester,assigner,hostname,vcenter,reservedUntil,note,memo,tags');
  assert.equal(row, '1.1.1.1,,,,L,웹,r,a,,,,,,');
  const sample = csv.manageSampleCsv(['active'], ['vm']).replace(/^﻿/, '').split('\r\n').filter(Boolean);
  for (const l of sample) assert.equal(l.split(',').length, 14, l.slice(0, 40));
});

test('엑셀 덧붙임 — 시트 고르기 · 대역 수 계산 · 조치 필요 항목', async () => {
  const { parseExportSheets, sheetCounts, issuesOfRow, buildExportExtra } = await import('../src/ipam/excelExtra.js');
  assert.deepEqual(parseExportSheets(''), { summary: true, nets: true, ledger: true, issues: true, info: true });
  assert.deepEqual(parseExportSheets('ledger,bogus'), { summary: false, nets: false, ledger: true, issues: false, info: false });
  assert.deepEqual(parseExportSheets('bogus'), parseExportSheets(''), '아는 값이 없으면 전부');
  const rows = [{ last: 0, status: 'network' }, { last: 1, status: 'empty', mgmtStatus: 'reserved' }, { last: 2, status: 'used', mgmtStatus: 'reserved' },
    { last: 3, status: 'empty', mgmtStatus: 'dhcp' }, { last: 4, status: 'duplicate' }, { last: 255, status: 'empty', mgmtStatus: 'dhcp' }];
  assert.deepEqual(sheetCounts({ used: 2, rows }), { used: 2, rsv: 1, dhcp: 1, free: 250, dup: 1 });
  assert.deepEqual(issuesOfRow({ ip: '1.1.1.1', reconcile: 'conflict', conflictVcenters: ['a', 'b'], duplicate: true, dnsFwd: 'none' }).map((x) => x.kind), ['충돌', '중복', 'DNS 불일치']);
  assert.deepEqual(issuesOfRow({ ip: '1.1.1.2' }), []);
  const x = buildExportExtra({ sheets: [{ subnet: '10.1.1.0/24', base: '10.1.1', used: 2, rows }], rows: [{ ip: '10.1.1.4', duplicate: true }], notes: { '10.1.1': { purpose: '웹' } } });
  assert.equal(x.nets[0].purpose, '웹');
  assert.equal(x.summary.cap, 254);
  assert.equal(x.summary.pctText, '1.6%'); // (2 + 1 + 1) / 254
  assert.equal(x.issues.length, 1);
});

test('엑셀 — 덧붙임 시트 순서(요약 · 대역 목록 · 조치 필요 · 대장 … · 안내) · 대장만 고르면 예전처럼 대장 시트만 · 새 열은 맨 뒤', async () => {
  const xl = await import('../src/ipam/excel.js');
  const { buildExportExtra, parseExportSheets } = await import('../src/ipam/excelExtra.js');
  const sheets = [{ subnet: '10.1.1.0/24', base: '10.1.1', used: 1, rows: [{ ip: '10.1.1.1', last: 1, status: 'used', ipPurpose: '웹', requester: 'r', assigner: 'a' }] }];
  const wb = await xl.buildWorkbook(sheets, { created: 1, extra: buildExportExtra({ sheets }) });
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', '대역 목록', '조치 필요', '10.1.1.0_24', '안내']);
  const led = wb.getWorksheet('10.1.1.0_24');
  assert.deepEqual([led.getCell('J2').value, led.getCell('K2').value, led.getCell('L2').value], ['용도', '요청자', '할당자']);
  assert.deepEqual([led.getCell('J3').value, led.getCell('K3').value, led.getCell('L3').value], ['웹', 'r', 'a']);
  assert.equal(led.getCell('I2').value, '상태', '앞 열 순서는 그대로');
  const only = await xl.buildWorkbook(sheets, { created: 1, extra: buildExportExtra({ sheets, include: parseExportSheets('ledger') }) });
  assert.deepEqual(only.worksheets.map((w) => w.name), ['10.1.1.0_24']);
  const none = await xl.buildWorkbook(sheets, { created: 1 });
  assert.deepEqual(none.worksheets.map((w) => w.name), ['10.1.1.0_24'], 'extra 가 없으면 예전 파일 그대로');
  assert.deepEqual(xl.slimSheet(sheets[0]).rows[0].requester, 'r', '워커로 보내는 칸에도 새 필드가 있다');
});

test('대역 용도 쓰기 — 범위 계정은 거부, 라우트는 저장 전에 그 판정을 거친다(쓰기 게이트 · 운영자 이상)', async () => {
  const { subnetNoteWriteDenied } = await import('../src/ipam/subnetNotes.js');
  assert.equal(subnetNoteWriteDenied(null), null);
  assert.match(subnetNoteWriteDenied(new Set(['vc1'])), /전체 범위/);
  const src = fs.readFileSync(new URL('../src/routes/api/ipamExport.js', import.meta.url), 'utf8');
  const i = src.indexOf("api.put('/tools/ipam/subnet-note'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /^api\.put\('\/tools\/ipam\/subnet-note', canWrite, requirePerm\('tools'\)/);
  assert.ok(body.indexOf('subnetNoteWriteDenied(scopedVcenterIds(req.user') < body.indexOf('setSubnetNote('), '저장보다 범위 판정이 먼저');
  assert.match(body, /if \(denied\) return res\.status\(403\)/);
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
