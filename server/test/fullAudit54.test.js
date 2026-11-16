/**
 * 전체 점검 54회차(다른 세션 v3.17.2~v3.18.1 변경 검토) 회귀.
 *  F1 로그인 · OTP 잠금 시간 · 창 env 도 envPositive(음수면 잠금이 꺼지던 것) · fleet TTL · store LASTGOOD_HOLD
 *  F2 /hosts 요약은 용량 미상 호스트가 있으면 vCore · 메모리 비율을 내지 않는다(부분 합)
 *  F3 지도 상세 창 — 경보를 조회하지 않은 REST 폴백 vCenter 는 '—'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

const rd = (rel) => stripComments(fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8'));

test('54회차 F1: 잠금 시간 · 창 env 가 음수여도 MAX_FAILS 회 실패 뒤 잠긴다(자식 프로세스)', () => {
  const code = `
    const L = await import(${JSON.stringify(new URL('../src/security/loginRateLimit.js', import.meta.url).href)});
    for (let i = 0; i < 30; i++) L.recordLoginFailure('10.0.0.1', 'bob');
    process.stdout.write(JSON.stringify(L.checkLoginAllowed('10.0.0.1', 'bob')));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CONFIG_DIR: os.tmpdir(), LOGIN_LOCKOUT_MS: '-1', LOGIN_FAIL_WINDOW_MS: '-1' } });
  const j = JSON.parse(r.stdout || '{}');
  assert.equal(j.blocked, true, `음수 env 로 잠금이 꺼지면 안 된다: ${r.stdout} ${r.stderr}`);
  for (const [f, re] of [['security/loginRateLimit.js', /Number\(process\.env\.[A-Z_]+\) \|\|/], ['central/fleet.js', /Number\(process\.env\.CENTRAL_FLEET_TTL_MS\)/], ['store.js', /Number\(process\.env\.LASTGOOD_HOLD_MS\)/]]) assert.doesNotMatch(rd(f), re, f);
});

test('54회차 F2 · F3: /hosts 요약 비율은 용량 미상이면 null · 지도 경보 미조회는 —(소스 · 웹 함수)', async () => {
  const inv = rd('routes/api/inventory.js');
  assert.match(inv, /vcorePerCore: hostsCapacityUnknown \? null :/);
  assert.match(inv, /memOvercommit: hostsCapacityUnknown \? null :/);
  const wm = await import('../../web/src/components/worldMapText.js');
  assert.match(wm.alarmText({ alarmsCritical: 0, alarmsWarning: 0 }, { alarmsUnknown: true }), /경보 미조회/);
  assert.equal(wm.alarmText({ alarmsCritical: 1, alarmsWarning: 2 }, {}), '위험 1 · 경고 2');
});
