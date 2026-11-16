/**
 * 전체 점검 48회차(보안 · 인증 2차) 회귀 — F1 은 test/rvH_remoteSession.test.js(실제 RDP 처리기)에 있다.
 *  F1 RDP 화면 크기는 정수 · 범위만(guacd 인자로 그대로 간다)
 *  F3 전역 레이트리밋 skip 은 경로를 소문자로 본다(express 라우팅은 대소문자를 가리지 않는다 — '/API/...' 우회)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

test('48회차 F1 · 49회차 F49-3: rdpDim — 정수만(아니면 기본값) · 범위 밖은 100~8192 로 자른다', async () => {
  const { rdpDim } = await import('../src/proxy/guacdTunnel.js');
  assert.equal(rdpDim('1920', '1024'), '1920');
  assert.equal(rdpDim('99999', '1024'), '8192', '넓은 창은 상한으로(기본값으로 떨어지면 비율이 깨진다)');
  assert.equal(rdpDim('99', '768'), '100');
  for (const bad of ['1024;7.connect', '-5', '1e3', '', null, '12.5', '1234567']) assert.equal(rdpDim(bad, '1024'), '1024', String(bad));
});

test('49회차 F49-1: Guacamole 명령 파서는 음수 · 숫자 아닌 길이를 받지 않는다(무한 루프 · 이벤트 루프 정지)', () => {
  // 회귀하면 동기 무한 루프라 test-timeout 이 끊지 못한다 — 자식 프로세스에 시한을 걸어 CI 가 멈추지 않게 한다.
  const code = `
    const { _parseInstructionForTest: parse } = await import(${JSON.stringify(new URL('../src/proxy/guacdTunnel.js', import.meta.url).href)});
    const bad = ['9.dvc-token,-4.', '9.dvc-token,+4.abcd;', '9.dvc-token, 4.abcd;', '-1.;', '4.size,0x4.abcd;', '99999999999.x;'];
    const out = bad.map((b) => parse(b, 0));
    process.stdout.write(JSON.stringify({ nulls: out.every((x) => x === null), ok: parse('4.size,4.1024,3.768;', 0) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, CONFIG_DIR: os.tmpdir() } });
  assert.notEqual(r.signal, 'SIGTERM', '파서가 끝나지 않는다(무한 루프)');
  const j = JSON.parse(r.stdout || '{}');
  assert.equal(j.nulls, true, r.stderr);
  assert.deepEqual(j.ok, { opcode: 'size', args: ['1024', '768'], end: 20 });
});

test('49회차 F49-2: SSH 게이트웨이 data 는 글자만 stream 에 쓴다(소스)', () => {
  const s = stripComments(fs.readFileSync(new URL('../src/proxy/sshGateway.js', import.meta.url), 'utf8'));
  assert.match(s, /msg\.type === 'data' && stream\) \{\s*if \(typeof msg\.data !== 'string'\) return;/);
});

test('48회차 F3: 레이트리밋 skip 은 소문자 경로로 판정한다(소스)', () => {
  const s = stripComments(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  const m = /app\.use\(rateLimit\(\{ skip: \(req\) => \{([\s\S]{0,400}?)\} \}\)\);/.exec(s);
  assert.ok(m, '레이트리밋 skip 블록');
  assert.match(m[1], /String\(req\.path \|\| ''\)\.toLowerCase\(\)/);
});
