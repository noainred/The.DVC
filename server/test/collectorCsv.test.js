// 수집 서버 CSV(v2.338) 단위테스트 — 내보내기(토큰 제외 기본)·파싱(별칭/주석/문법)·
// 드라이런 판정(추가/덮어쓰기/오류·파일 내 중복). 사용자 요구를 고정한다:
// import 시 '문법 검증'은 실제 저장과 같은 validate 로, 'overwrite 여부 확인'은
// 기존 id 와 겹치는 행을 overwrite 로 구분 판정하는 것으로 구현된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectorsToCsv, sampleCsv, parseCollectorsCsv, analyzeCollectorsImport, CSV_COLUMNS } from '../src/collector/csv.js';

const LIST = [
  { id: 'WA-Edge', name: '바르샤바', url: 'http://10.20.0.10:4000', datacenter: 'WA', vcenterId: 'vc-wa', enabled: true, token: 'secret-1' },
  { id: 'kr-edge', name: '한국', url: 'http://10.10.0.10:4000', datacenter: '', vcenterId: '', enabled: false, token: '' },
];

test('collectorsToCsv: 기본은 토큰 제외(빈 값) — redact 계약과 동일', () => {
  const csv = collectorsToCsv(LIST);
  assert.ok(csv.includes(CSV_COLUMNS.join(',')));
  assert.ok(!csv.includes('secret-1'), '토큰이 기본 내보내기에 포함되면 안 된다');
  assert.ok(csv.includes('WA-Edge'));
  assert.ok(csv.includes('false'), 'enabled=false 직렬화');
});

test('collectorsToCsv: includeTokens 옵션일 때만 토큰 포함(호출부가 소유자 게이트 책임)', () => {
  const csv = collectorsToCsv(LIST, { includeTokens: true });
  assert.ok(csv.includes('secret-1'));
});

test('parseCollectorsCsv: 별칭 헤더·name 기본값(id)·주석/빈 행 스킵·토큰 보존', () => {
  const text = ['아이디,이름,주소,법인,vcenter,활성,토큰',
    'GM1,,http://gm1:4000,GM,vc-gm,true, tok with spaces ',
    '# 주석행,x,y,,,,',
    ',,,,,,',
    'NB,엔비,nb:4000,,,false,'].join('\n');
  const { rows, error } = parseCollectorsCsv(text);
  assert.equal(error, undefined);
  assert.equal(rows.length, 2, '주석·빈 행은 스킵');
  assert.equal(rows[0].name, 'GM1', 'name 비면 id 로 채움');
  assert.equal(rows[0].token, ' tok with spaces ', '토큰은 trim 하지 않는다');
  assert.equal(rows[0]._hasToken, true);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[1]._hasToken, false, '빈 토큰 = 기존 유지 신호');
});

test('parseCollectorsCsv: 필수 헤더(id·url) 없으면 문법 오류', () => {
  assert.ok(parseCollectorsCsv('name,datacenter\nA,B').error);
  assert.ok(parseCollectorsCsv('id,url').error, '데이터 행 0개도 오류');
});

test('sampleCsv 는 parse 를 통과하고 주석 행이 데이터로 새지 않는다', () => {
  const { rows, error } = parseCollectorsCsv(sampleCsv());
  assert.equal(error, undefined);
  assert.deepEqual(rows.map((r) => r.id), ['WA-Edge', 'KR-Edge']);
});

test('analyzeCollectorsImport: 추가/덮어쓰기/오류 판정 + 파일 내 중복(대소문자 무시)', () => {
  const { rows } = parseCollectorsCsv(['id,url,token',
    'NEW1,http://new1:4000,',
    'GM1,http://gm1:4000,tok',      // 기존 존재 → overwrite
    'bad-url,not a url,',            // validate 실패 → error
    'gm1,http://dup:4000,'].join('\n')); // 파일 내 중복(GM1) → error
  const existing = new Map([['gm1', 'GM1']]);
  const validate = (input) => (/\s/.test(input.url) ? 'URL 형식 오류' : null); // 실제 normalize 대역
  const { report, summary } = analyzeCollectorsImport(rows, {
    existingId: (id) => existing.get(String(id).toLowerCase()),
    validate,
  });
  assert.deepEqual(summary, { add: 1, overwrite: 1, error: 2, withToken: 1 });
  assert.equal(report.find((r) => r.id === 'NEW1').action, 'add');
  assert.equal(report.find((r) => r.id === 'GM1').action, 'overwrite');
  assert.equal(report.find((r) => r.id === 'bad-url').action, 'error');
  const dup = report.find((r) => r.id === 'gm1');
  assert.equal(dup.action, 'error');
  assert.match(dup.reason, /파일 내 중복/);
});

test('왕복(export→import): 내보낸 CSV 를 그대로 파싱하면 같은 필드가 나온다', () => {
  const { rows, error } = parseCollectorsCsv(collectorsToCsv(LIST, { includeTokens: true }));
  assert.equal(error, undefined);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.url, r.datacenter, r.vcenterId, r.enabled, r.token]),
    LIST.map((c) => [c.id, c.name, c.url, c.datacenter, c.vcenterId, c.enabled, c.token]),
  );
});
