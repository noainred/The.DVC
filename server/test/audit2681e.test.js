/**
 * v2.681 — v2.680 수정이 만든 회귀(R2A) 고정.
 *  R2A-01 엣지 위임 CVP 행의 부품 신선도는 엣지 push 전량 갱신 주기만큼 넓다(touch 만 오는 동안 '낡음' 금지).
 *  R2A-02 엣지 센서 상세 export 가 넘치면 사용률(%)·온도 센서를 먼저 남긴다.
 *  R2A-03 장비 상세 장애 이력의 '생략 개수' 를 지어내지 않는다(더 있음만).
 *  R2A-04 대소문자 병합에서 변형 행이 남아도 처음 본 시각은 더 이른 쪽.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2681e-'));
const { stripComments } = await import('./_stripComments.js');

test('R2A-01 — 엣지 행은 전량 갱신 주기만큼 부품 신선도 경계가 넓다', async () => {
  const F = await import('../src/cvp/faults.js');
  const NOW = 1_800_000_000_000; const IV = 300_000;
  const age = 109 * 60_000; // cycle 10분짜리 엣지의 전량 갱신 직전 나이(감사 재현 계산)
  assert.equal(F.partsFresh({ agent: 'edge-a', partsAt: NOW - age }, { intervalMs: IV, now: NOW }), true, '엣지 행은 낡음이 아니다');
  assert.equal(F.partsFresh({ agent: '', partsAt: NOW - age }, { intervalMs: IV, now: NOW }), false, '중앙 직접 행은 예전 경계');
  assert.equal(F.partsFresh({ agent: 'edge-a', partsAt: NOW - 5 * 86_400_000 }, { intervalMs: IV, now: NOW }), false, '며칠 전 목록은 엣지 행도 낡음');
  const pushSrc = stripComments(fs.readFileSync(new URL('../src/cvp/push.js', import.meta.url), 'utf8'));
  assert.match(pushSrc, /EDGE_FULL_REFRESH_MS as FULL_REFRESH_MS/);
});

test('R2A-02 — export 상한에서 사용률·온도 센서를 먼저 남긴다', async () => {
  const src = stripComments(fs.readFileSync(new URL('../src/collector/agent.js', import.meta.url), 'utf8'));
  assert.match(src, /o\?\.k === 'percent' \? 0/);
});

test('R2A-03 — 생략 개수는 모르면 null + faultEventsMore', async () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/cvp.js', import.meta.url), 'utf8'));
  assert.match(src, /faultEventsOmitted: devFaultEv\.length > HIST_MAX \? null : 0/);
});

test('R2A-04 — 변형 행이 남아도 처음 본 시각은 더 이른 쪽', async () => {
  const cdb = await import('../src/cvp/db.js');
  const now = Date.now();
  const s = await cdb.saveDevices({ agent: 'Edge-G', cvpId: 'cvpG', devices: [{ key: 'SN1', hostname: 'sw1', ts: now, ports: [] }] });
  if (s?.unavailable) return;
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path.join(process.env.CONFIG_DIR, 'cvp.db'));
  const ins = d.prepare("INSERT INTO cvp_fault_state (agent,cvp_id,device_key,fault_key,kind,state,first_seen,last_seen) VALUES (?,'cvpG','SN1','psu:P1','psu','fault',?,?)");
  ins.run('Edge-G', now - 1000, now - 10);  // 변형: 더 최근에 봤다(남는 쪽)
  ins.run('edge-g', now - 9000, now - 500); // 저장 키: 더 일찍 봤다
  await cdb.adoptAgentVariants('edge-g', { wait: true });
  const r = d.prepare("SELECT agent, first_seen, last_seen FROM cvp_fault_state WHERE cvp_id='cvpG'").all();
  assert.equal(r.length, 1);
  assert.equal(r[0].agent, 'edge-g');
  assert.equal(Number(r[0].first_seen), now - 9000);
  assert.equal(Number(r[0].last_seen), now - 10);
  d.close();
});

test('R2E-01 — 기본 루트 import 그래프는 한 번만 만들고, 재판정은 진행 중 실행을 공유한다', async () => {
  const A = await import('../src/portalcheck/archScan.js');
  A._resetImportGraphMemo();
  const t0 = performance.now(); const g1 = A.buildImportGraph(); const first = performance.now() - t0;
  const t1 = performance.now(); const g2 = A.buildImportGraph(); const second = performance.now() - t1;
  assert.equal(g1, g2, '같은 결과 객체(기억)');
  assert.ok(second * 5 < first || second < 2, `두 번째 호출이 훨씬 빨라야 한다(${first.toFixed(1)}ms → ${second.toFixed(1)}ms)`);
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/portalCheck.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(!_archRun\) _archRun = runArchScanOnce\(\)/);
});
