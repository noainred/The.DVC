/**
 * 전체 점검 48회차(보안 · 인증 2차) 회귀 — F1 은 test/rvH_remoteSession.test.js(실제 RDP 처리기)에 있다.
 *  F1 RDP 화면 크기는 정수 · 범위만(guacd 인자로 그대로 간다)
 *  F3 전역 레이트리밋 skip 은 경로를 소문자로 본다(express 라우팅은 대소문자를 가리지 않는다 — '/API/...' 우회)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_stripComments.js';

test('48회차 F1: rdpDim — 100~8192 정수만', async () => {
  const { rdpDim } = await import('../src/proxy/guacdTunnel.js');
  assert.equal(rdpDim('1920', '1024'), '1920');
  for (const bad of ['1024;7.connect', '-5', '99', '99999', '1e3', '', null, '12.5']) assert.equal(rdpDim(bad, '1024'), '1024', String(bad));
});

test('48회차 F3: 레이트리밋 skip 은 소문자 경로로 판정한다(소스)', () => {
  const s = stripComments(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  const m = /app\.use\(rateLimit\(\{ skip: \(req\) => \{([\s\S]{0,400}?)\} \}\)\);/.exec(s);
  assert.ok(m, '레이트리밋 skip 블록');
  assert.match(m[1], /String\(req\.path \|\| ''\)\.toLowerCase\(\)/);
});
