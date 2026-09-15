/**
 * v2.513 — SAN 스위치 대량 등록(CSV·자유텍스트) 회귀.
 *
 * 사용자 요청(2026-09-15): "san switch 도 같은 메뉴" — 스토리지의 대량 등록을 스위치에도.
 *
 * 여기서 고정하는 핵심:
 *  · **식별 키는 `host` 단독**(스토리지는 host+type) — `registry.saveDevice` 가 host 중복을
 *    거부하므로, host+type 으로 판정하면 '드라이런 통과 → 저장 예외' 가 된다.
 *  · CSV 와 자유텍스트가 **같은 행 형태**를 만든다(뒤 파이프라인 공유 — 판정이 갈라지지 않게).
 *  · 내보내기에 **비밀번호가 없다**.
 *  · 샘플은 **그대로 가져와도 오류 행이 생기지 않는다**(세 표기가 한 파일에 있다).
 *  · `toSaveInput` 은 검증과 저장이 **같은 객체**를 쓰게 하는 단일 지점이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, ALIASES, rowIssue, devicesToCsv, devicesToText, sampleCsv, sampleText,
  parseDevicesCsv, parseDevicesText, analyzeImport, toSaveInput,
} from '../src/sanswitch/bulk.js';
import { deviceInputIssue } from '../src/sanswitch/registry.js';

const DEV = (o = {}) => ({
  type: 'brocade', name: 'WA-SAN-01', host: '10.30.0.11', username: 'admin',
  collectMethod: 'ssh', sshPort: 22, httpsPort: 443, vfId: null,
  datacenterId: 'dc-wa', agent: 'agent-WA', enabled: true, note: '팹 A', ...o,
});
const dcName = (id) => ({ 'dc-wa': 'WA' }[id] || id);

/* ────────────────── 내보내기 ────────────────── */

test('CSV 내보내기 — 열 순서 고정 · 법인은 사람이 읽는 이름 · **비밀번호 없음**', () => {
  const csv = devicesToCsv([DEV({ password: 'S3cret!' })], dcName);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.deepEqual(lines[0].split(','), COLUMNS);
  assert.ok(lines[1].includes('WA'), 'datacenterId 가 아니라 표시명을 쓴다');
  assert.ok(!csv.includes('S3cret!'), '비밀번호는 절대 내보내지 않는다');
  assert.ok(csv.startsWith('﻿'), '엑셀 한글 깨짐 방지 BOM');
});

test('자유텍스트 내보내기 — 비밀번호 없음 · 안내 주석 · 빈칸 표시', () => {
  const txt = devicesToText([DEV({ password: 'S3cret!', vfId: null })], dcName);
  assert.ok(!txt.includes('S3cret!'));
  assert.ok(txt.includes('#'), '사용법 주석을 함께 내보낸다');
  assert.ok(/(^|\s)-(\s|$)/m.test(txt), '빈칸은 표시로 채워 열이 밀리지 않게 한다');
});

test('내보내기 → 가져오기 왕복이 값을 보존한다(공백 포함 이름·VF 포함)', () => {
  const txt = devicesToText([DEV({ name: 'WA SAN 01', vfId: 128 })], dcName);
  const { rows, error } = parseDevicesText(txt);
  assert.equal(error, undefined);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'WA SAN 01');
  assert.equal(rows[0].host, '10.30.0.11');
  assert.equal(rows[0].vfId, '128');
  assert.equal(rows[0]._hasPassword, false, '내보낸 파일에는 비번이 없으니 기존 유지로 간다');
});

/* ────────────────── 샘플 ────────────────── */

test('샘플 CSV·자유텍스트는 **그대로 가져와도 오류 행이 없다**', () => {
  const c = parseDevicesCsv(sampleCsv());
  assert.equal(c.error, undefined);
  assert.equal(c.rows.length, 2, '주석 행은 데이터로 세지 않는다');
  assert.ok(c.rows.every((r) => !rowIssue(r)), `샘플 CSV 행에 오류가 없어야 한다`);

  const t = parseDevicesText(sampleText());
  assert.equal(t.error, undefined);
  assert.ok(t.rows.length >= 4, `세 표기 예시가 모두 읽혀야 한다 — 실제 ${t.rows.length}행`);
  const bad = t.rows.filter((r) => rowIssue(r));
  assert.deepEqual(bad.map((r) => `${r._line}:${r.type}`), [],
    '중간 헤더가 데이터 행으로 파싱되면 여기서 잡힌다(초판의 실제 결함)');
});

/* ────────────────── 파싱 ────────────────── */

test('CSV — 별칭 헤더(한글 포함)를 받고, name·host 가 없으면 사유와 함께 거절', () => {
  const ok = parseDevicesCsv(['타입,표시명,ip,계정,비밀번호', 'brocade,A,10.0.0.1,admin,pw'].join('\n'));
  assert.equal(ok.error, undefined);
  assert.equal(ok.rows[0].type, 'brocade');
  assert.equal(ok.rows[0].username, 'admin');
  assert.equal(ok.rows[0]._hasPassword, true);

  const bad = parseDevicesCsv(['type,username', 'brocade,admin'].join('\n'));
  assert.match(bad.error, /필수 헤더/);
  assert.match(bad.error, /name/);
});

test('CSV 와 자유텍스트가 같은 행 형태를 만든다(뒤 파이프라인 공유)', () => {
  const c = parseDevicesCsv([COLUMNS.join(','), 'brocade,A,10.0.0.1,admin,ssh,22,,,WA,,true,메모,pw'].join('\n'));
  const t = parseDevicesText('brocade\tA\t10.0.0.1\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t메모\tpw');
  const strip = (r) => { const { _line, ...rest } = r; return rest; };
  assert.deepEqual(strip(t.rows[0]), strip(c.rows[0]), 'CSV·텍스트 결과가 필드 단위로 같아야 한다');
});

test('vfId·포트는 문자열로 넘기고 정규화는 registry 가 한다(셸 조립 불변조건)', () => {
  const { rows } = parseDevicesText('type=brocade name=A host=10.0.0.1 계정=admin vfId=128 sshPort=2222');
  assert.equal(rows[0].vfId, '128');
  assert.equal(rows[0].sshPort, '2222');
});

/* ────────────────── 드라이런 판정 ────────────────── */

const analyze = (rows, existing = []) => analyzeImport(rows, {
  existingHost: (h) => existing.find((x) => x.host === h),
  resolveDc: (v) => (v === 'WA' ? 'dc-wa' : v),
  validate: deviceInputIssue,
});

test('식별 키는 host 단독 — 같은 host 를 다른 type 으로 적어도 update 로 본다', () => {
  // ⚠ 스토리지처럼 host+type 으로 판정하면 여기서 'add' 가 되고, 저장에서
  //   '같은 host 의 스위치가 이미 등록되어 있습니다' 예외로 떨어진다(계약 위반).
  const { rows } = parseDevicesText('cisco-mds\tA\t10.30.0.11\tadmin\t-\t-\t-\t-\tWA\t-\ttrue\t-\tpw');
  const r = analyze(rows, [{ host: '10.30.0.11', type: 'brocade' }]);
  assert.notEqual(r.report[0].action, 'add', 'host 가 이미 있으면 add 가 아니다');
});

test('정상 행은 add, 이미 있는 host 는 update', () => {
  const { rows } = parseDevicesText([
    'brocade\tA\t10.30.0.11\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t-\tpw1',
    'brocade\tB\t10.30.0.12\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t-\tpw2',
  ].join('\n'));
  const r = analyze(rows, [{ host: '10.30.0.11' }]);
  assert.equal(r.report[0].action, 'update');
  assert.equal(r.report[1].action, 'add');
  assert.deepEqual(r.summary, { add: 1, update: 1, error: 0, withPassword: 2 });
});

test('파일 내 중복은 뒤 행을 오류로 — 어느 행이 이기는지 모호한 채 덮어쓰지 않는다', () => {
  const { rows } = parseDevicesText([
    'brocade\tA\t10.30.0.11\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t-\tpw',
    'brocade\tA2\t10.30.0.11\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t-\tpw',
  ].join('\n'));
  const r = analyze(rows);
  assert.equal(r.report[0].action, 'add');
  assert.equal(r.report[1].action, 'error');
  assert.match(r.report[1].reason, /파일 내 중복/);
  assert.match(r.report[1].reason, /host/);
});

test('registry 검증을 그대로 쓴다 — 미구현 타입·형식 오류·SSRF 차단이 드라이런에서 잡힌다', () => {
  const { rows } = parseDevicesText([
    'nosuch\tA\t10.0.0.1\tadmin\t-\t-\t-\t-\t-\t-\ttrue\t-\tpw',      // 알 수 없는 타입
    'brocade\tB\t127.0.0.1\tadmin\t-\t-\t-\t-\t-\t-\ttrue\t-\tpw',    // 루프백 — SSRF 가드
    'brocade\tC\t10.0.0.3\t-\t-\t-\t-\t-\t-\t-\ttrue\t-\tpw',         // 계정 누락
    'brocade\tD\t10.0.0.4\tadmin\t-\t-\t-\t999\t-\t-\ttrue\t-\tpw',   // vfId 범위 초과
  ].join('\n'));
  const r = analyze(rows);
  assert.equal(r.summary.error, 4, `4건 모두 오류여야 한다 — 실제 ${JSON.stringify(r.report.map((x) => x.reason))}`);
  assert.match(r.report[0].reason, /타입/);
  assert.match(r.report[1].reason, /차단|host/);
  assert.match(r.report[2].reason, /계정/);
  assert.match(r.report[3].reason, /Virtual Fabric|vfId/i);
});

test('toSaveInput — 비번이 비면 빈 문자열(기존 유지) · 법인은 해석된 ID', () => {
  const { rows } = parseDevicesText('brocade\tA\t10.0.0.1\tadmin\tssh\t22\t-\t-\tWA\t-\ttrue\t-\t-');
  const input = toSaveInput(rows[0], (v) => (v === 'WA' ? 'dc-wa' : v));
  assert.equal(input.password, '', '비면 빈 문자열 — saveDevice 가 기존 비번을 유지한다');
  assert.equal(input.datacenterId, 'dc-wa');
  assert.equal(deviceInputIssue(input), null, '검증과 저장이 같은 객체를 쓴다(통과해야 한다)');
});

test('별칭 표는 스토리지와 같은 어휘를 쓴다(두 화면을 번갈아 쓰는 사용자)', () => {
  for (const k of ['타입', '표시명', 'ip', '계정', '비밀번호', '법인', '엣지', '활성', '메모']) {
    assert.ok(ALIASES[k], `별칭 '${k}' 가 있어야 한다`);
  }
});
