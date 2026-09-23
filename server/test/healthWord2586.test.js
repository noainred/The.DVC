/**
 * v2.586 — 스토리지 노드 상태 판정(서버 healthWord ↔ 웹 nodeHealthKind 같은 규칙).
 * 예전 수집기 3곳의 앵커 없는 부분 일치가 'disconnected'·'unhealthy'·'broken' 을 **정상**으로 셌다(장애 은닉).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { healthWord } from '../src/storage/healthWord.js';
const { nodeHealthKind } = await import('../../web/src/views/tools/storageNodeText.js');
import { stripComments } from './_stripComments.js';

const CASES = [
  ['OK', 'ok'], ['ok (5)', 'ok'], ['Healthy', 'ok'], ['normal', 'ok'], ['up', 'ok'], ['green', 'ok'], ['online', 'ok'],
  ['connected', 'ok'], ['attention_none', 'ok'],
  ['disconnected', 'bad'], ['unhealthy', 'bad'], ['not ok', 'bad'], ['NOT_OK', 'bad'], ['broken', 'bad'], ['offline', 'bad'],
  ['down', 'bad'], ['degraded', 'bad'], ['failed', 'bad'], ['major-failure', 'bad'], ['smartfailed', 'bad'], ['ATTN', 'bad'],
  ['backup', 'bad'], ['lockout', 'bad'],
  ['', 'unknown'], [null, 'unknown'], ['unknown', 'unknown'], ['N/A', 'unknown'], ['-', 'unknown'],
];

test('healthWord — 정상어는 단어로만, 부정·이상어가 먼저', () => {
  for (const [v, want] of CASES) assert.equal(healthWord(v), want, JSON.stringify(v));
});

test('웹 nodeHealthKind 와 서버 healthWord 가 같은 입력에 같은 답', () => {
  for (const [v] of CASES) assert.equal(nodeHealthKind(v), healthWord(v), JSON.stringify(v));
});

test('수집기 3곳에 앵커 없는 정상 판정 정규식이 남아 있지 않다', () => {
  for (const f of ['isilon.js', 'vplexSsh.js', 'xtremioSsh.js']) {
    const src = stripComments(fs.readFileSync(new URL(`../src/storage/collectors/${f}`, import.meta.url), 'utf8'));
    assert.ok(!/\/ok\|healthy/.test(src), `${f}: /ok|healthy…/ 부분 일치가 남아 있다`);
    assert.ok(/healthWord\(/.test(src), `${f}: healthWord 를 쓰지 않는다`);
  }
});

test('파트 장애 healthStringState — 정상어 접두 뒤에 단어가 이어지면 정상이 아니다', async () => {
  const { healthStringState } = await import('../src/partfault/classify.js');
  assert.equal(healthStringState('OK').state, 'ok');
  assert.equal(healthStringState('OK (5)').state, 'ok');
  assert.equal(healthStringState('Up').state, 'ok');
  assert.notEqual(healthStringState('UPGRADE_FAILED').state, 'ok');
  assert.notEqual(healthStringState('Okfail').state, 'ok');
});
