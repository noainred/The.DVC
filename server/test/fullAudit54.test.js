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

/* ── 55회차(53 · 54회차 수정 반증 · 마지막 회차) ── */
test('55회차 #1 · #7: 법인 칸은 resultsKnown 으로 · 볼륨을 전부 모르면 Summary 오류 볼륨도 null', async () => {
  const v = await import('../../web/src/views/tools/bareosViewText.js');
  assert.notEqual(v.corpBucket({ director: { state: 'error', resultsKnown: true }, counts: { fail: 0, missing: 0, old: 0, never: 0 } }), 'unknown', '잘렸지만 결과를 아는 법인');
  assert.equal(v.corpBucket({ director: { state: 'error', resultsKnown: false } }), 'unknown');
  const P = await import('../src/bareos/policy.js');
  const acc = P.newPoolKpi(); P.addPoolKpi(acc, { full: null, pct: null, vol: null }); P.addPoolKpi(acc, { full: null, pct: null, vol: null });
  assert.equal(P.poolErrorVols(acc), null);
});

test('55회차 #2 · #4 · #10: Veeam 대행은 받은 작업을 버리지 않는다 · 같은 env 는 같은 판정 · 서버 시한 env 도 양수만(소스)', () => {
  assert.match(rd('agent/veeamRunWorker.js'), /typeof o\.kind === 'string'\)\.slice\(0, 10\)/);
  for (const f of ['central/inventory.js', 'agent/inventoryPush.js', 'store.js']) assert.match(rd(f), /envPositive\(process\.env\.LASTGOOD_HOLD_MS, 21_600_000\)/, f);
  assert.match(rd('proxy/expiry.js'), /envPositive\(process\.env\.REMOTE_MAPPING_TTL_MS/);
  const idx = rd('index.js');
  for (const k of ['SERVER_KEEPALIVE_MS', 'SERVER_HEADERS_TIMEOUT_MS', 'SERVER_REQUEST_TIMEOUT_MS']) assert.match(idx, new RegExp(`envPositive\\(process\\.env\\.${k},`), k);
});

test('55회차 #5 · #6: 호스트 KPI 막대 · 지도 마커(경보 미조회는 초록이 아니다)(소스)', () => {
  const web = (rel) => stripComments(fs.readFileSync(new URL(`../../web/src/${rel}`, import.meta.url), 'utf8'));
  assert.match(web('views/hostChecksText.js'), /bar: !s\.hostsCapacityUnknown && cores > 0/);
  assert.match(web('components/WorldMap.jsx'), /if \(alarmsUnknown\(site\)\) return \{ fill: '#94a3b8'/);
});
