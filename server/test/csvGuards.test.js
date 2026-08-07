/**
 * util/csv.js — 행/셀 상한, BOM 제거, 수식가드 왕복.
 * 대량 CSV 가져오기가 붙기 전에 파서 자체의 방어를 고정한다(1MB 개행 본문이
 * heap +205MB·76ms 동기 블로킹이었다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRows, guardCell, unguardCell, csvLine, CSV_BOM } from '../src/util/csv.js';

test('행 상한을 스캔 중에 검사한다(전량 파싱 후 slice 는 늦다)', () => {
  const many = Array.from({ length: 50 }, (_, i) => `a${i},b${i}`).join('\n');
  assert.throws(() => parseCsvRows(many, { maxRows: 10 }), /최대 10행/);
  assert.equal(parseCsvRows(many, { maxRows: 50 }).length, 50);
  // 상한 미지정이면 기존 호출부와 동일하게 무제한
  assert.equal(parseCsvRows(many).length, 50);
});

test('개행만 있는 대용량 본문도 상한 안에서 즉시 끝난다', () => {
  const bomb = '\n'.repeat(200000);
  // 빈 행은 결과에서 제외되지만 스캔 단계에서 카운트되므로 상한에 걸려야 한다
  assert.throws(() => parseCsvRows(bomb, { maxRows: 2000 }), /최대 2000행/);
});

test('셀 상한 — 한 셀이 과도하게 길면 거부', () => {
  const row = `a,${'x'.repeat(5000)}`;
  assert.throws(() => parseCsvRows(row, { maxCell: 4000 }), /최대 4000자/);
  assert.equal(parseCsvRows(row, { maxCell: 8000 })[0][1].length, 5000);
  // 인용 필드 안에서도 같이 걸린다
  assert.throws(() => parseCsvRows(`a,"${'y'.repeat(5000)}"`, { maxCell: 4000 }), /최대 4000자/);
});

test('BOM 을 제거한다 — 남으면 첫 헤더 셀 매칭이 조용히 실패한다', () => {
  const rows = parseCsvRows(`${CSV_BOM}kind,path,name\ninfra,A,srv1`);
  assert.equal(rows[0][0], 'kind');
  assert.equal(rows[1][0], 'infra');
});

test('수식가드/역가드는 쌍이다 — 왕복해도 값이 자라지 않는다', () => {
  for (const v of ['=cmd|calc', '+1', '-2', '@SUM(A1)', '\tx']) {
    const g = guardCell(v);
    assert.equal(g[0], "'");
    assert.equal(unguardCell(g), v);
    assert.equal(unguardCell(guardCell(unguardCell(g))), v, '반복 왕복에서 따옴표가 쌓이지 않는다');
  }
  assert.equal(guardCell('정상값'), '정상값');
  assert.equal(unguardCell('정상값'), '정상값');
  // 원래 작은따옴표로 시작하는 정상 값은 건드리지 않는다
  assert.equal(unguardCell("'quoted"), "'quoted");
});

test('csvLine: 쉼표·따옴표·개행·단독 CR 을 인용하고 파서로 되읽을 수 있다', () => {
  const cells = ['a,b', 'say "hi"', 'line1\nline2', 'cr\rhere', '=danger'];
  const line = csvLine(cells);
  const [back] = parseCsvRows(line);
  assert.equal(back[0], 'a,b');
  assert.equal(back[1], 'say "hi"');
  assert.equal(back[2], 'line1\nline2');
  assert.equal(unguardCell(back[4]), '=danger');
});
