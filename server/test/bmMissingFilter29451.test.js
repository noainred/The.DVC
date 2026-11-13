/**
 * v2.945.1 — 누락 점검 행에 화면 필터용 칸(osHost · corp)을 싣는다. 판정(칸 · 사유)은 그대로다.
 * 화면 필터 · 쪽 나누기 자체는 web/src/views/tools/bmMissingView.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { missingCheck } from '../src/bmusage/onboard/missing.js';

test('등록부에만 있는 OS 행은 osHost 를 싣고, 모든 행은 법인 이름(corp)을 vcName 으로 싣는다', () => {
  const m = missingCheck({
    targets: [{ key: 't1', name: 'srv1', vcenterId: 'vc-a', paths: ['idrac'] }],
    skipped: [{ key: 's1', name: 'srv2', vcenterId: '', reason: 'unassigned' }, { key: 's2', name: 'srv3', vcenterId: 'vc-b', reason: 'edge-delegated', agent: 'OC2' }],
    osRegistry: [{ id: 'o1', name: '192.168.21.239', host: '192.168.21.239', vcenterId: '' }],
    vcName: (v) => ({ 'vc-a': '법인A', 'vc-b': '법인B' }[v] || ''),
  });
  const by = Object.fromEntries(m.rows.map((r) => [r.key, r]));
  assert.equal(by['os:o1'].osHost, '192.168.21.239');
  assert.equal(by['os:o1'].bucket, 'untracked');
  assert.equal(by.t1.corp, '법인A');
  assert.equal(by.s2.corp, '법인B');
  assert.equal(by.s2.agent, 'OC2');
  assert.equal(by.s1.corp, '');            // 미귀속은 빈 값(화면이 '미귀속' 으로 쓴다)
  assert.equal(by.t1.bucket, 'unknown');   // 판정은 그대로(수집 기록 없음 = 모름)
});

test('vcName 이 이름을 못 주면 id 를 쓴다(빈 법인으로 보이지 않게)', () => {
  const m = missingCheck({ targets: [{ key: 't1', name: 'srv1', vcenterId: 'vc-z' }], vcName: () => '' });
  assert.equal(m.rows[0].corp, 'vc-z');
});

test('라우트는 비관리자 판본에서 osHost 도 가린다(idracHost 와 같이)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/api/bmOnboard.js', import.meta.url), 'utf8');
  assert.match(src, /idracHost: r\.idracHost \? '\(가림\)' : '', osHost: r\.osHost \? '\(가림\)' : ''/);
});
