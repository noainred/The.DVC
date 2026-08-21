// 무압축 대형 push 경고 승격(v2.344, 성능 점검 #12) 단위테스트 — 상태전이 추적기.
// 계약: 임계 크기 이상 무압축 push 연속 3회 → 경고 1회(래치 — 지속돼도 재발화 없음),
// 이후 gzip 관측 → 해소 1회. 소형 무압축·일시 gzip 폴백은 오탐 없이 무시/리셋.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { noteInventoryCompression, resetIngestStats, ingestPlainThresholds } from '../src/central/ingestStats.js';

const BIG = ingestPlainThresholds().bytes; // 기본 512KB
beforeEach(() => resetIngestStats());

test('대형 무압축 연속 3회에 경고 1회 — 이후 지속돼도 재발화 없음(래치)', () => {
  assert.equal(noteInventoryCompression('OC2', { gzip: false, wireBytes: BIG }), null);
  assert.equal(noteInventoryCompression('OC2', { gzip: false, wireBytes: BIG }), null);
  const ev = noteInventoryCompression('OC2', { gzip: false, wireBytes: BIG * 2 });
  assert.equal(ev?.type, 'warned');
  assert.equal(ev.agent, 'OC2');
  assert.equal(ev.streak, 3);
  for (let i = 0; i < 5; i++) assert.equal(noteInventoryCompression('OC2', { gzip: false, wireBytes: BIG }), null, '경고 후 재발화 금지');
});

test('gzip 관측 시 해소 1회 + 카운터 리셋(재악화하면 다시 3회부터)', () => {
  for (let i = 0; i < 3; i++) noteInventoryCompression('WA', { gzip: false, wireBytes: BIG });
  const ok = noteInventoryCompression('WA', { gzip: true, wireBytes: 1024 });
  assert.equal(ok?.type, 'resolved');
  assert.equal(noteInventoryCompression('WA', { gzip: true, wireBytes: 1024 }), null, '해소는 1회만');
  assert.equal(noteInventoryCompression('WA', { gzip: false, wireBytes: BIG }), null, '리셋 후 1회째 — 아직 경고 아님');
});

test('경고 전 일시 gzip(폴백 복구)은 streak 리셋 — 오탐 방지', () => {
  noteInventoryCompression('GM1', { gzip: false, wireBytes: BIG });
  noteInventoryCompression('GM1', { gzip: false, wireBytes: BIG });
  assert.equal(noteInventoryCompression('GM1', { gzip: true, wireBytes: 1024 }), null, '경고 전 gzip → 해소 이벤트도 없음');
  assert.equal(noteInventoryCompression('GM1', { gzip: false, wireBytes: BIG }), null);
  assert.equal(noteInventoryCompression('GM1', { gzip: false, wireBytes: BIG }), null);
  assert.equal(noteInventoryCompression('GM1', { gzip: false, wireBytes: BIG })?.type, 'warned', '리셋 후 다시 3연속이어야 경고');
});

test('소형 무압축은 무해 — streak 도 올리지 않는다(빈 엣지 등)', () => {
  for (let i = 0; i < 10; i++) assert.equal(noteInventoryCompression('NB', { gzip: false, wireBytes: 1024 }), null);
  // 소형이 섞여도 대형 연속 카운트는 별개로 3회 필요.
  noteInventoryCompression('NB', { gzip: false, wireBytes: BIG });
  noteInventoryCompression('NB', { gzip: false, wireBytes: 100 });
  noteInventoryCompression('NB', { gzip: false, wireBytes: BIG });
  assert.equal(noteInventoryCompression('NB', { gzip: false, wireBytes: BIG })?.type, 'warned', '소형은 카운트를 깨지 않음(유지)');
});
