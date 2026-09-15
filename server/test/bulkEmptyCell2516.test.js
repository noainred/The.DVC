/**
 * v2.516 — 대량 등록에서 **빈 칸(선택 항목 생략)** 회귀.
 *
 * 사용자 신고(2026-09-15): "san switch import 할때 vfId 를 넣지 않으려면 어떻게 해야되?
 * 선택 사양인데, 빼고 넣으면 입력이 안 되. csv 로 넣을때는 어떤 값을 넣어야 하는지 알려줘."
 *
 * 확정한 결함 2건(둘 다 조용히 틀린 값을 만든다):
 *  ① **명시적 구분자(탭·`|`·쉼표)에서 중간 칸을 비우면 뒤 값이 한 칸씩 밀렸다.**
 *     `bulkText.js` 가 `splitLine(line).filter(t => t !== '')` 로 빈 토큰을 무조건 버렸다 —
 *     엑셀에서 vfId 칸을 비운 채 복사하면 vfId 에 그 다음 값(법인 'WA')이 들어가
 *     'Virtual Fabric ID 는 1~128' 오류가 났다. **경고도 없었다.**
 *     빈 칸을 표현할 수 없는 **공백 구분**에서는 계속 버린다(연속 공백은 그냥 띄어쓰기).
 *  ② **CSV 는 `-`(빈 칸 표시)를 빈 값으로 받지 않았다** — 자유텍스트는 받았다.
 *     같은 모달에서 형식만 토글하는데 규칙이 달라, 자유텍스트로 통과한 파일이 CSV 로는 실패했다.
 *
 * 이 테스트가 고정하는 것: **7가지 표기 전부가 vfId 를 비운 채 통과한다.**
 * 되돌리면 선택 항목을 비울 방법이 형식마다 달라지고, ①은 값이 조용히 밀린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCells, parseFreeRows } from '../src/util/bulkText.js';
import * as swBulk from '../src/sanswitch/bulk.js';
import { deviceInputIssue } from '../src/sanswitch/registry.js';
import { parseDevicesCsv as stCsv } from '../src/storage/csv.js';

const dc = (v) => v;
/** 파싱 → registry 검증까지 실제로 통과하는지(드라이런 통과 = 저장 성공 계약). */
const verdict = (r) => {
  assert.equal(r.error, undefined, `파싱 오류: ${r.error}`);
  assert.equal(r.rows.length, 1, `행 수 ${r.rows.length}`);
  const row = r.rows[0];
  const issue = swBulk.rowIssue(row) || deviceInputIssue(swBulk.toSaveInput(row, dc));
  return { row, issue };
};

const H = swBulk.COLUMNS.join(',');

test('splitCells — 명시적 구분자는 빈 칸을 유지하고, 공백 구분은 유지하지 않는다', () => {
  assert.deepEqual(splitCells('a\t\tb'), { cells: ['a', '', 'b'], explicit: true });
  assert.deepEqual(splitCells('a||b'), { cells: ['a', '', 'b'], explicit: true });
  assert.deepEqual(splitCells('a,,b'), { cells: ['a', '', 'b'], explicit: true });
  assert.deepEqual(splitCells('a   b'), { cells: ['a', 'b'], explicit: false });
});

test('① 탭 사이를 비우면 **밀리지 않는다** — 엑셀 붙여넣기의 실제 경로', () => {
  // COLUMNS: type name host username collectMethod sshPort httpsPort vfId datacenter agent enabled note password
  const { row, issue } = verdict(swBulk.parseDevicesText(
    'brocade\tSW-A\t10.0.0.1\tadmin\tssh\t22\t443\t\tWA\t\ttrue\t\tpw'));
  assert.equal(row.vfId, '', 'vfId 가 비어야 한다');
  assert.equal(row.datacenter, 'WA', "밀렸다면 vfId 에 'WA' 가 들어간다");
  assert.equal(issue, null, `검증 통과해야 한다 — 실제: ${issue}`);
});

test('① 줄 끝 칸들을 비워도 된다(뒤 구분자만 남은 줄)', () => {
  const { row, issue } = verdict(swBulk.parseDevicesText(
    'brocade\tSW-B\t10.0.0.2\tadmin\tssh\t22\t\t\tWA\t\ttrue\t\t'));
  assert.equal(row.vfId, '');
  assert.equal(row._hasPassword, false, '비번 칸이 비면 기존 유지로 간다');
  assert.equal(issue, null, `실제: ${issue}`);
});

test('① 공백 구분은 예전처럼 빈 토큰을 버린다(연속 공백은 띄어쓰기일 뿐)', () => {
  const { row, issue } = verdict(swBulk.parseDevicesText('brocade   SW-C   10.0.0.3   admin'));
  assert.equal(row.name, 'SW-C', '공백 구분에서 열이 밀리면 안 된다');
  assert.equal(row.host, '10.0.0.3');
  assert.equal(issue, null, `실제: ${issue}`);
});

test('① 헤더형·키=값형은 빈 칸이 섞여도 계속 인식된다(판정은 값 있는 칸만 본다)', () => {
  const hdr = parseFreeRows('host\t\tname\n10.0.0.9\t\tSW-H', { fields: ['host', 'name'], aliases: {} });
  assert.deepEqual(hdr.headerUsed, ['host', 'name'], '빈 칸 때문에 헤더 인식이 깨지면 안 된다');
  const kv = swBulk.parseDevicesText('type=brocade\t\tname=SW-K host=10.0.0.10 username=admin password=pw');
  assert.equal(kv.rows[0].name, 'SW-K');
});

test('② CSV 도 `-` 를 빈 칸으로 받는다 — 자유텍스트와 같은 규칙', () => {
  const dash = verdict(swBulk.parseDevicesCsv([H, 'brocade,SW-D,10.0.0.4,admin,ssh,22,443,-,WA,,true,,pw'].join('\n')));
  assert.equal(dash.row.vfId, '');
  assert.equal(dash.issue, null, `실제: ${dash.issue}`);

  const blank = verdict(swBulk.parseDevicesCsv([H, 'brocade,SW-E,10.0.0.5,admin,ssh,22,443,,WA,,true,,pw'].join('\n')));
  assert.equal(blank.row.vfId, '');
  assert.equal(blank.issue, null, `실제: ${blank.issue}`);
});

test('② vfId 열 자체를 생략한 CSV 도 통과한다(선택 항목이므로)', () => {
  const { row, issue } = verdict(swBulk.parseDevicesCsv(
    ['type,name,host,username,password', 'brocade,SW-F,10.0.0.6,admin,pw'].join('\n')));
  assert.equal(row.vfId, '');
  assert.equal(issue, null, `실제: ${issue}`);
});

test('② 스토리지 CSV 도 같은 규칙(두 화면이 같은 모달을 쓴다)', () => {
  const r = stCsv(['type,name,host,username,agent,note', 'isilon,WA-ISI,10.1.0.1,root,-,-'].join('\n'));
  assert.equal(r.error, undefined);
  assert.equal(r.rows[0].agent, '', "'-' 는 '비움' 이지 엣지 이름이 아니다");
  assert.equal(r.rows[0].note, '');
});

test('값이 있는 vfId 는 그대로 살아 있다(빈 칸 처리가 정상 값을 삼키지 않는다)', () => {
  const { row, issue } = verdict(swBulk.parseDevicesText(
    'brocade\tSW-G\t10.0.0.7\tadmin\tssh\t22\t443\t128\tWA\t\ttrue\t\tpw'));
  assert.equal(row.vfId, '128');
  assert.equal(issue, null, `실제: ${issue}`);
  assert.equal(swBulk.toSaveInput(row, dc).vfId, '128');
});

test('0 과 129 는 여전히 거절한다 — 범위 검증을 약화시키지 않았다', () => {
  for (const bad of ['0', '129', '-1', 'abc']) {
    const r = swBulk.parseDevicesText(`brocade\tSW-X\t10.0.0.8\tadmin\tssh\t22\t443\t${bad}\tWA\t\ttrue\t\tpw`);
    const issue = swBulk.rowIssue(r.rows[0]) || deviceInputIssue(swBulk.toSaveInput(r.rows[0], dc));
    assert.match(String(issue), /Virtual Fabric/, `'${bad}' 는 거절되어야 한다`);
  }
});

test('조언 문구가 **비우는 방법을 형식별로** 말한다(사용자가 실제로 물어본 것)', async () => {
  const { expectationFor } = await import('../src/util/bulkAdvice.js');
  const hint = expectationFor('vfId', {}).hint;
  assert.match(hint, /선택/, '선택 항목임을 밝힌다');
  assert.match(hint, /CSV/, 'CSV 에서 비우는 방법');
  assert.match(hint, /자유텍스트/, '자유텍스트에서 비우는 방법');
  assert.match(hint, /1~128/, '쓸 때의 범위');
});
