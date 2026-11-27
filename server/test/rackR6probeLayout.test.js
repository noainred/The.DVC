// [탐침 · 테스트 공백 축 r6 — 2026-11-27 저장소에 옮김] layout.js 순수 판정의 경계 — foldWidth 범위(U+FF01 · U+FF5E · U+3000) · serialAddressLike(버전 꼴 · MAC · 부분 고치기).
//   (2026-11-27 저장소에 옮김 — 처음에는 점검 사본에서만 돌렸다)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../src/rack/layout.js');

test('foldWidth 경계: U+FF01(！) · U+FF5E(～) · U+3000 은 접고, 바로 바깥(U+FF00 · U+FF5F · U+3001)은 그대로', () => {
  assert.equal(L.foldWidth('！'), '!');
  assert.equal(L.foldWidth('～'), '~');
  assert.equal(L.foldWidth('\u3000'), ' ');
  assert.equal(L.foldWidth('\uff00\uff5f\u3001'), '\uff00\uff5f\u3001');
  assert.equal(L.foldWidth('ａ！～Ｚ'), 'a!~Z');
  assert.equal(L.foldWidth(null), null); assert.equal(L.foldWidth(''), '');
});

// 2026-11-27(6회차 보안 4 · 반증 R6): 입력 거절과 응답 비우기를 **같은 판정 하나**로 맞췄다 — 1~3자리 숫자 묶음이 4개 이상 이어지면(앞뒤에 무엇이 붙든) 주소다.
//   예전 탐침은 'FW1.2.3.4.5' · 'v10.20.30.40.' · '.10.20.30.40' 을 입력에서 받는다고 고정했는데, 응답(hasIpv4)은 같은 값을 비웠다(저장은 되고 보이지 않는 칸).
//   시리얼에 점으로 이은 숫자 네 묶음이 들어가는 형식은 드물어 '거절' 쪽으로 맞췄다(대가: 그런 시리얼은 메모에).
test('serialAddressLike: 입력 · 출력 공용 — 숫자 묶음 4개 이상이 이어지면 주소 · MAC · 콜론 둘 미만 · 숫자 묶음 3개는 아니다', () => {
  assert.equal(L.serialAddressLike('FW1.2.3.4.5'), true, '마디가 4개 넘게 이어져도 주소 꼴(응답의 hasIpv4 와 같다)');
  assert.equal(L.serialAddressLike('v10.20.30.40.'), true);
  assert.equal(L.serialAddressLike('.10.20.30.40'), true);
  assert.equal(L.serialAddressLike('FW1.2.3'), false, '세 묶음은 아니다');
  assert.equal(L.serialAddressLike('SN-1234.5678'), false, '네 자리 묶음은 아니다');
  assert.equal(L.serialAddressLike('SN 10.20.30.40'), true);
  assert.equal(L.serialAddressLike('00:1a:2b:3c:4d:5e'), false, 'MAC 은 저장 때 거절하지 않는다(응답 쪽이 비관리자에게 비운다)');
  assert.equal(L.serialAddressLike('AB:CD'), false);
  assert.equal(L.serialAddressLike('x fe80::1 y'), true);
  assert.equal(L.serialAddressLike('svc://x'), true);
});

test('cleanPlaceInput: 부분 고치기에서 시리얼 칸을 보내지 않으면 주소 검사를 하지 않는다 · 보낸 칸만 본다', () => {
  assert.ok(!L.cleanPlaceInput({ label: 'x' }, { partial: true }).error);
  assert.match(String(L.cleanPlaceInput({ extraSerials: ['ok1', '10.1.1.1'] }, { partial: true }).error), /시리얼 칸에는 주소/);
  assert.match(String(L.cleanPlaceInput({ serial: '10.1.1.1' }, { partial: true }).error), /시리얼 칸에는 주소/);
  assert.match(String(L.cleanPlaceInput({ serial: '１０.１.１.１' }, { partial: true }).error), /시리얼 칸에는 주소/, '전각으로 적은 IP 도 접은 뒤 거절');
});
