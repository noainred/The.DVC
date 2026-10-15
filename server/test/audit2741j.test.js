/**
 * v2.741 그룹 GI — WEB-02 서버·pyportal 쪽: CSV 수식 가드가 유한 음수·순수 숫자 문자열에도 작은따옴표를 붙였다.
 *
 * 엑셀·Calc 는 `'-12.5` 를 텍스트로 읽어 정렬·합계에서 뺀다(idrac 추이 변화량·라이선스 남은 일수 같은 음수 열이 실제로 있다).
 * 순수 숫자(부호·소수·지수만)는 수식으로 실행되지 않으므로 가드하지 않는다. `=`·`@`·`-2+3` 처럼 수식 모양은 그대로 가드한다.
 * 규칙은 세 벌(웹 web/src/util/csv.js · 서버 server/src/util/csv.js · pyportal hub/csvio.py)이 같아야 한다 — 같은 입력으로 대조한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardCell, unguardCell, csvLine, parseCsvRows } from '../src/util/csv.js';
import * as webCsv from '../../web/src/util/csv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('WEB-02 유한 숫자·순수 숫자 문자열은 가드하지 않는다', () => {
  assert.equal(guardCell(-12.5), '-12.5');
  assert.equal(guardCell(-7), '-7');
  assert.equal(guardCell('-12.5'), '-12.5');
  assert.equal(guardCell('+3'), "'+3", "'+' 로 시작하는 숫자열은 가드한다(+82… 전화번호가 숫자로 바뀌지 않게)");
  assert.equal(guardCell('+821012345678'), "'+821012345678");
  assert.equal(guardCell('-1e-3'), '-1e-3');
  assert.equal(guardCell(0), '0');
  assert.equal(csvLine(['a', -7.5, '-3', 12]), 'a,-7.5,-3,12');
});

test('WEB-02 수식 모양은 계속 가드한다', () => {
  for (const v of ['=cmd|calc', '-2+3', '+1+1', '@SUM(A1)', '\tx', '\rx', '-.5', '-1,2', '- 3', '-12\n', '-cmd|x']) {
    assert.equal(guardCell(v)[0], "'", `가드가 빠졌다: ${JSON.stringify(v)}`);
  }
  assert.equal(guardCell(-Infinity), "'-Infinity", '유한 숫자만 통과한다');
});

test('WEB-02 역함수 쌍 — 옛 파일의 가드도 되돌리고 새 파일은 그대로 · 왕복해도 자라지 않는다', () => {
  assert.equal(unguardCell("'-12.5"), '-12.5', '옛 내보내기 파일');
  for (const v of ['-12.5', '+3', '=cmd|calc', '-2+3', '@SUM(A1)', '\tx', '정상값']) {
    const g = guardCell(v);
    assert.equal(unguardCell(g), v);
    assert.equal(unguardCell(guardCell(unguardCell(g))), v);
  }
  const [back] = parseCsvRows(csvLine([-4.25, '=danger', '-2+3']));
  assert.equal(back[0], '-4.25');
  assert.equal(unguardCell(back[1]), '=danger');
  assert.equal(unguardCell(back[2]), '-2+3');
});

// 세 벌 대조용 입력(문자열만 — pyportal 은 문자열·None 을 내보낸다). 숫자 형식은 JS·파이썬 표기가 달라 문자열로만 대조한다.
const STR_INPUTS = ['', '0', '12', '-12.5', '+3', '1E5', '-1e+5', '1e21', '-', '+', '--1', '-0x1A', '0x1A', '1.', '.5', '-.5',
  '１２', '-１２', '=1+1', '-2+3', '+1+1', '@x', '\tx', '\rx', 'web-01', '서울-DC', "'-2", '-12\n', ' -3', '-3 '];

test('WEB-02 웹 사본과 같은 입력에 같은 결과', () => {
  for (const v of [...STR_INPUTS, null, undefined, -0, 12, -12.5, 1e21, -1e-7, NaN, Infinity, -Infinity]) {
    assert.equal(webCsv.guardCell(v), guardCell(v), JSON.stringify(v));
  }
});

test('WEB-02 pyportal hub/csvio.py _guard 도 같은 규칙', (t) => {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'pyportal'))})`,
    'from hub.csvio import _guard, _unguard',
    'xs = json.loads(sys.stdin.read())',
    'print(json.dumps({"g": [_guard(x) for x in xs], "u": [_unguard(_guard(x)) for x in xs],',
    '  "nums": [_guard(-12.5), _guard(-7), _guard(0), _guard(True), _guard(float("-inf"))]}))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', code], { input: JSON.stringify(STR_INPUTS), encoding: 'utf8', timeout: 20_000 });
  if (r.error && r.error.code === 'ENOENT') { t.skip('python3 없음 — pyportal 대조를 건너뜀(pyportal CI 가 따로 돈다)'); return; }
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  STR_INPUTS.forEach((v, i) => assert.equal(out.g[i], guardCell(v), `pyportal 과 다르다: ${JSON.stringify(v)}`));
  // _unguard 는 앞뒤 공백을 지운다(가져오기 정규화) — 공백 없는 값만 왕복을 대조한다. 원래 작은따옴표로 시작하는 값("'-2")은
  //   가드가 붙은 것과 구분할 수 없는 기존 모호함이라(이 변경 전에도 같다) 왕복 대조에서 뺀다.
  STR_INPUTS.forEach((v, i) => { if (v === v.trim() && !v.startsWith("'")) assert.equal(out.u[i], v, `왕복: ${JSON.stringify(v)}`); });
  assert.deepEqual(out.nums, ['-12.5', '-7', '0', 'True', "'-inf"]);
});
