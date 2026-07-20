import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceCollectorToken } from '../src/agent/deploy.js';

// 토큰 강제 동기화 입력 검증 — SSH 접속 전에 걸러지는 케이스(셸 주입 차단 포함).

test('forceCollectorToken: host/username 없으면 실패', async () => {
  const r = await forceCollectorToken({}, 'abc123');
  assert.equal(r.ok, false);
  assert.match(r.reason, /host\/username/);
});

test('forceCollectorToken: 빈 토큰 거부', async () => {
  const r = await forceCollectorToken({ host: '1.2.3.4', username: 'root' }, '   ');
  assert.equal(r.ok, false);
  assert.match(r.reason, /비어/);
});

test('forceCollectorToken: 셸 특수문자 포함 토큰 거부(주입 차단)', async () => {
  for (const bad of ["abc'; rm -rf /", 'a b c', 'tok`id`', 'tok$(id)', '토큰한글']) {
    const r = await forceCollectorToken({ host: '1.2.3.4', username: 'root' }, bad);
    assert.equal(r.ok, false, `허용되면 안 됨: ${bad}`);
    assert.match(r.reason, /사용할 수 없는 문자/);
  }
});
