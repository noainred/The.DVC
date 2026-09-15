/**
 * v2.517 — `portperfshow` **줄바꿈 출력** 파싱 회귀(확정 결함).
 *
 * 경위(2026-09-15): 사용자가 "데이터 수집이 안되" 라고 신고한 뒤, 실장비에서 명령이 도는지 직접
 * 확인해 캡처를 보내 줬다("명령어 실행되는거 확인했어"). 그 캡처가 결함을 드러냈다 —
 * `portperfshow` 는 한 블록(16포트)을 **터미널 폭에 맞춰 여러 줄로 쪼개** 찍는다(그 환경은 14 + 2).
 *
 * v2.516 까지 파서는 헤더 **바로 다음 줄을 값 줄로 단정**했다. 그래서 이어지는 헤더 조각(`46  47`)을
 * 값으로 읽었고, 실측 결과 128포트 중 **3개만** 남았으며 값도 엉뚱했다:
 *   `{ port 0: 49, port 62: 5790, port 63: 4030000 }`
 * 0건이 아니라 **틀린 값이 저장**되므로 화면은 '수집되고 있다' 고 보이면서 숫자가 거짓이 된다.
 * (`collectOne` 은 포트 수 > 0 이면 저장하므로 실패로도 잡히지 않았다.)
 *
 * ⚠ 이 테스트가 고정하는 것:
 *   ① 줄바꿈 출력에서 **128포트 전부** 와 `Total` 을 읽는다
 *   ② 줄바꿈 없는(한 줄) 표준 출력 동작이 **바뀌지 않는다**
 *   ③ 구분선이 없는 변형에서 값 줄(전부 숫자)을 헤더로 삼키지 않는다 — 이어붙임 판정이
 *      '직전 포트 + 1' 연속성을 요구하는 이유다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePortPerfShow } from '../src/sanswitch/collectors/fosParse.js';

const wrapped = fs.readFileSync(new URL('./fixtures/portperfshow-wrapped.txt', import.meta.url), 'utf8');

test('줄바꿈된 실장비 출력 — 128포트 전부 + Total 을 읽는다', () => {
  const r = parsePortPerfShow(wrapped);
  const ports = Object.keys(r.ports).map(Number).sort((a, b) => a - b);
  assert.equal(ports.length, 128, `줄바꿈 출력에서 포트를 ${ports.length}개만 읽었다(예전 파서는 3개였다)`);
  assert.equal(ports[0], 0);
  assert.equal(ports[127], 127);
  assert.equal(r.total, 2.17 * 1e9, 'Total 열(g 접미)을 읽어야 한다');
  assert.equal(r.samples, 1);
});

test('값이 올바른 포트에 붙는다(열 밀림 없음)', () => {
  const r = parsePortPerfShow(wrapped);
  // 블록 경계(줄바꿈 직전/직후)를 집어 확인한다 — 밀림은 여기서 먼저 드러난다.
  assert.equal(r.ports[35], 127_600);
  assert.equal(r.ports[45], 0);
  assert.equal(r.ports[46], 0);      // 줄바꿈 뒤 첫 포트
  assert.equal(r.ports[48], 5_790);  // 다음 블록 첫 포트
  assert.equal(r.ports[63], 223_100);
  assert.equal(r.ports[77], 502_530_000);
  assert.equal(r.ports[79], 494_790_000);
  assert.equal(r.ports[80], 250_840_000);
  // 예전 결함의 지문 — 포트 0 에 '49'(다음 헤더 조각)가 들어가던 값
  assert.notEqual(r.ports[0], 49);
});

test('한 줄(줄바꿈 없는) 표준 출력 동작은 그대로', () => {
  const flat = [
    '  32     33     34     35     36     37     38     39     40     41     42     43     44     45     46     47',
    '='.repeat(110),
    '   0      0      0  127.60k 108.71k 640.29k  25.78k  13.61m   4.71m  25.61m  18.34m  26.52k   0      0      0      0',
  ].join('\n');
  const r = parsePortPerfShow(flat);
  assert.equal(Object.keys(r.ports).length, 16);
  assert.equal(r.ports[35], 127_600);
  assert.equal(r.ports[47], 0);
});

test('구분선이 없는 변형: 값 줄을 헤더로 삼키지 않는다', () => {
  // 전부 숫자인 값 줄(`0 0 0 …`)은 isHeader 가 참이다 — 연속성 검사('직전 포트 + 1')가 없으면
  // 헤더에 이어붙여져 열이 통째로 밀린다.
  const noSep = ['  0   1   2   3', '  7   9  11  13'].join('\n');
  const r = parsePortPerfShow(noSep);
  assert.deepEqual(r.ports, { 0: 7, 1: 9, 2: 11, 3: 13 });
});

test('여러 샘플: 마지막(가장 최근) 것을 쓰고, 절단된 마지막은 버린다', () => {
  const blk = (vals) => ['  0   1   2   3', '='.repeat(20), `  ${vals.join('   ')}`].join('\n');
  const two = `${blk([1, 2, 3, 4])}\n\n${blk([5, 6, 7, 8])}`;
  assert.deepEqual(parsePortPerfShow(two).ports, { 0: 5, 1: 6, 2: 7, 3: 8 });
  // 마지막 샘플이 중간에서 끊기면(포트 2개) 직전 완전 샘플을 쓴다 — 절단 토큰을 '최신' 으로
  // 저장하면 차트가 급락으로 보인다.
  const cut = `${blk([1, 2, 3, 4])}\n\n  0   1   2   3\n${'='.repeat(20)}\n  9   9`;
  const r = parsePortPerfShow(cut);
  assert.deepEqual(r.ports, { 0: 1, 1: 2, 2: 3, 3: 4 });
  assert.equal(r.partialDropped, true);
});

test('픽스처에 실제 운영 식별자를 넣지 않는다(공개 저장소)', () => {
  // v2.513 규칙 — 실장비 캡처는 형식만 옮기고 값·프롬프트는 합성한다.
  assert.ok(!/FID\d+:admin>/.test(wrapped), '실장비 프롬프트(호스트명 포함)를 커밋하지 말 것');
  assert.ok(!/[0-9a-f]{2}(:[0-9a-f]{2}){7}/i.test(wrapped), 'WWN 을 커밋하지 말 것');
});
