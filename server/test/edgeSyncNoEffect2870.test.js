/**
 * test/edgeSyncNoEffect2870.test.js — v2.870 감사 A2-01: 엣지 동기화 '받았다고(성공) 답했는데 버전이 그대로' 의 무한 재push.
 *   예전(재현): push 가 성공하면 attempts 를 0 으로 돌리고, settle(30분)이 지나도 엣지가 옛 버전을 보고하면 매번 'behind' 로 다시 밀었다
 *   → 30~40분마다 번들 전송(WAN) + 엣지 재시작이 영구 반복 · 알림 없음(엣지의 설치 경로가 실행 경로와 다르거나 재시작 뒤 롤백일 때).
 *   이제: 같은 대상 버전으로 성공을 거듭 답하면 noEffect 를 세고 settle × 2^n(상한 6시간)까지 기다린다('no-effect' 상태) ·
 *   상한에 닿으면 한 번 알린다(key …:noeffect) · 엣지가 대상 버전을 보고하면 해소를 한 번.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'edgesync2869-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
for (const k of ['UPGRADE_EDGE_AUTO', 'UPGRADE_EDGE_SYNC_INTERVAL_MS', 'UPGRADE_EDGES']) delete process.env[k];
const sync = await import('../src/upgrade/edgeSync.js');

const CUR = '99.1.0';
const OLD = '99.0.2';
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 3, 3);
const quiet = { log() {}, warn() {} };

test('planEdgeSync — 효과 없는 성공 n 회면 settle × 2^n 까지 no-effect(밀지 않음) · 지나면 behind', () => {
  const base = { collectors: [{ id: 'pl', name: '폴란드', url: 'https://pl', enabled: true }], statusOf: () => ({ ok: true, version: OLD }), currentVersion: CUR, intervalMs: 10 * MIN };
  // 첫 성공 뒤(noEffect 없음) — settle 동안 waiting, 지나면 한 번은 다시 민다(재시작이 늦었을 수 있다 — 예전 그대로)
  const a0 = { at: NOW - 31 * MIN, ok: true, target: CUR, attempts: 0 };
  assert.deepEqual(sync.planEdgeSync({ ...base, attemptsOf: () => a0, now: NOW }).push, ['pl']);
  // 효과 없음 2회 — 2시간(30분 × 4)까지 no-effect
  const a2 = { at: NOW - 31 * MIN, ok: true, target: CUR, attempts: 0, noEffect: 2 };
  const p = sync.planEdgeSync({ ...base, attemptsOf: () => a2, now: NOW });
  assert.deepEqual(p.push, []);
  assert.equal(p.edges[0].state, 'no-effect');
  assert.equal(p.edges[0].nextAt, a2.at + 120 * MIN);
  assert.match(p.edges[0].reason, /3번 답했지만 30분 뒤에도 v99\.0\.2/);
  assert.equal(p.counts['no-effect'], 1);
  assert.deepEqual(sync.planEdgeSync({ ...base, attemptsOf: () => a2, now: a2.at + 120 * MIN }).push, ['pl']);
  // 다른 대상 버전의 기록은 보지 않는다(중앙이 새 버전으로 올라갔으면 처음부터)
  assert.deepEqual(sync.planEdgeSync({ ...base, attemptsOf: () => ({ ...a2, target: '99.0.9' }), now: NOW }).push, ['pl']);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => sync.noEffectWaitMs(n) / MIN), [60, 120, 240, 360, 360]);
});

test('Runner — 늘 성공이라 답하고 버전이 그대로면 48시간 push 가 지수로 줄고 알림 1회 · 대상 버전 보고 뒤 해소 1회', async () => {
  const alerts = []; let pushes = 0; let now = NOW; let ver = OLD;
  const runner = new sync.EdgeSyncRunner({
    settings: () => ({ enabled: true, edgeAutoUpgrade: true, edges: [] }), now: () => now, currentVersion: () => CUR, intervalMs: 10 * MIN, log: quiet,
    collectors: () => [{ id: 'pl', name: '폴란드', url: 'https://pl', enabled: true }], statusOf: () => ({ ok: true, version: ver }),
    pushFn: async (bytes, o) => { pushes += o.ids.length; return o.ids.map((id) => ({ id, name: '폴란드', ok: true, version: CUR })); },
    resolveBundle: async () => ({ bytes: Buffer.from('x'), version: CUR, source: 'package', manifest: null, path: null }),
    notifyFn: async (a) => { alerts.push(a); return ['slack:200']; },
  });
  const end = NOW + 48 * 3_600_000;
  for (; now < end; now += 10 * MIN) await runner.run();
  // 예전: 30분 settle + 10분 주기 → 약 40분마다 = 48시간에 72회. 이제: 0 · 40분 · 1시간 40분 · 3시간 40분 · 7시간 40분 · 그 뒤 6시간마다 ≈ 12회
  assert.ok(pushes <= 14, `push ${pushes}회 — 효과 없는 성공을 30~40분마다 거듭 밀면 안 된다`);
  assert.ok(pushes >= 5, `push ${pushes}회 — 간격을 늘려도 아예 멈추지는 않는다`);
  assert.ok(runner.attempts.get('pl').noEffect >= 4);
  const ne = alerts.filter((a) => a.key === `edgesync:pl|${CUR}:noeffect`);
  assert.equal(ne.length, 1, '상한에 닿으면 한 번만 알린다');
  assert.equal(ne[0].severity, 'warning');
  assert.match(ne[0].title, /효과 없음 반복 — 폴란드 v99\.1\.0/);
  assert.match(ne[0].detail, /UPGRADE_INSTALL_DIR/);
  assert.match(ne[0].detail, /v99\.0\.2/);
  assert.ok(!/[`]|\*\*/.test(ne[0].title + ne[0].detail), '알림 본문에 백틱·별표 없음');
  assert.equal(alerts.length, 1, '실패 알림 · 해소 알림은 섞이지 않는다');
  // 화면 판정 — 다음 시도까지 'no-effect'
  assert.equal(runner.status(now).pending[0]?.state, 'no-effect');
  // 엣지가 대상 버전을 보고 → 해소 한 번, 그 뒤에는 아무것도
  ver = CUR;
  const r = await runner.run();
  assert.equal(r.outcome, 'idle');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].key, `edgesync:pl|${CUR}:noeffect:close`);
  assert.equal(alerts[1].severity, 'info');
  now += 10 * MIN; await runner.run();
  assert.equal(alerts.length, 2);
});

test('실패 뒤 첫 성공은 효과 없음으로 세지 않는다(실패 백오프와 섞이지 않음)', async () => {
  let ok = false; let now = NOW;
  const runner = new sync.EdgeSyncRunner({
    settings: () => ({ enabled: true, edgeAutoUpgrade: true }), now: () => now, currentVersion: () => CUR, intervalMs: 10 * MIN, log: quiet,
    collectors: () => [{ id: 'x', name: 'x', url: 'https://x', enabled: true }], statusOf: () => ({ ok: true, version: OLD }),
    pushFn: async (b, o) => o.ids.map((id) => ({ id, ok, reason: ok ? undefined : 'HTTP 403' })),
    resolveBundle: async () => ({ bytes: Buffer.from('x'), version: CUR, source: 'package', manifest: null, path: null }), notifyFn: async () => [],
  });
  await runner.run();
  assert.equal(runner.attempts.get('x').attempts, 1);
  ok = true; now += 11 * MIN;
  await runner.run();
  assert.equal(runner.attempts.get('x').noEffect, undefined);
  assert.equal(runner.status(now).pending[0].state, 'waiting');
});
