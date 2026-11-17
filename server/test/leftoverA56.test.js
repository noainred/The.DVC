/**
 * 남긴 결정 5건(사용자 '권장 사항으로 진행' — 2026-11-17) 회귀.
 *  F2  guacd 평문 경고 판정 — 서버(guacdFlags)와 웹(proxyGuacdText)이 같은 입력에 같은 답(터널 동작은 rvH_remoteSession '48회차 F2')
 *  #3  중앙이 민 번들(재시작 요청)은 진행 중 작업을 같은 상한까지 기다린다 — 설치 자체를 미룬다 · 중앙은 그 동안 다시 밀지 않는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'la56-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.COLLECTOR_TOKEN = 'tok-la56-0123456789abcdef';
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 17, 1, 23); // 정시 경계에서 떨어진 고정 시각

test('F2: guacd 평문 원격 판정 — 서버 · 웹 같은 입력에 같은 답', async () => {
  const srv = await import('../src/proxy/guacdFlags.js');
  const web = await import('../../web/src/views/proxyGuacdText.js');
  const cases = [
    [{ host: '' }, false], [{ host: '127.0.0.1' }, false], [{ host: 'localhost' }, false], [{ host: '[::1]' }, false],
    [{ host: '10.1.2.3' }, true], [{ host: 'guacd.corp', tls: false }, true], [{ host: 'guacd.corp', tls: 'true' }, false],
    [{ host: 'guacd.corp', tls: 'yes' }, true], [{ host: '127.0.0.300' }, false], [{ host: '128.0.0.1' }, true], [null, false],
  ];
  for (const [g, want] of cases) {
    assert.equal(srv.guacdPlaintextRemote(g), want, `server ${JSON.stringify(g)}`);
    assert.equal(web.guacdPlaintextRemote(g), want, `web ${JSON.stringify(g)}`);
  }
  assert.equal(srv.rdpIgnoreCertArg({ verifyRdpCert: 'true' }), 'false');
  assert.equal(srv.rdpIgnoreCertArg({}), 'true', '기본은 예전처럼 검증 끔');
});

test('#3: 진행 중 작업이 있으면 설치하지 않고 들고 있다가 끝나면 설치 · 재시작 · 같은 버전 재전송은 상한을 늘리지 않는다', async () => {
  const H = await import('../src/upgrade/pushHold.js');
  let now = NOW; let blockers = [{ kind: 'focusmon', label: '디스크 점검 srv-1' }];
  const installs = []; const restarts = []; const records = [];
  H._setPushHoldDepsForTest({
    blockers: () => blockers, maxMs: () => 2 * HOUR, now: () => now,
    preverify: (b) => (String(b) === 'bad' ? { ok: false, reason: 'signature: manifest missing' } : { ok: true, version: String(b), from: '3.18.5' }),
    checkpoint: async () => { installs.push('checkpoint'); },
    install: (b) => { installs.push(String(b)); return { ok: true, version: String(b) }; },
    restart: () => restarts.push(now), applying: () => false, record: (r) => records.push(r),
  });
  try {
    const r = H.holdPushIfBusy({ bytes: Buffer.from('3.18.6'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(r.ok, true); assert.equal(r.deferred, true);
    assert.equal(r.waitMs, 2 * HOUR);
    assert.match(r.reason, /디스크 점검 srv-1/);
    assert.equal(installs.length, 0, '기다리는 동안 설치하지 않는다(옛 프로세스가 새 파일을 읽지 않게)');
    now += 30 * 60_000;
    assert.equal((await H.tickPushHold()).outcome, 'waiting');
    const again = H.holdPushIfBusy({ bytes: Buffer.from('3.18.6'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(again.waitMs, 90 * 60_000, '같은 버전 재전송은 상한을 늘리지 않는다(보류에는 시한)');
    blockers = [];
    const t = (await H.tickPushHold());
    assert.equal(t.outcome, 'installed');
    assert.deepEqual(installs, ['checkpoint', '3.18.6'], '반증 A1: 설치 직전 SQLite 체크포인트');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(restarts.length, 1, '설치 뒤 재시작');
    assert.equal(H.pushHoldStatus(), null);
    assert.equal(records.at(-1).heldMs, 30 * 60_000);
    // 거부할 번들은 들고 있지 않는다
    blockers = [{ kind: 'veeam', label: 'Veeam 작업' }];
    const bad = H.holdPushIfBusy({ bytes: Buffer.from('bad'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(bad.ok, false); assert.equal(H.pushHoldStatus(), null);
    // 상한에 닿으면 기다리던 작업이 남아도 설치한다 — 반증 A3: 판이 바뀌어도 상한은 처음 보류 시각부터 · A4: 낮은 판으로 바꾸지 않는다
    const h1 = H.holdPushIfBusy({ bytes: Buffer.from('3.18.7'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(h1.waitMs, 2 * HOUR);
    now += 90 * 60_000;
    const h2 = H.holdPushIfBusy({ bytes: Buffer.from('3.18.9'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(h2.waitMs, 30 * 60_000, '새 판이 와도 상한을 늘리지 않는다');
    const h3 = H.holdPushIfBusy({ bytes: Buffer.from('3.18.8'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    assert.equal(h3.version, '3.18.9', '들고 있는 판보다 낮은 판으로 바꾸지 않는다');
    now += 30 * 60_000;
    const f = (await H.tickPushHold());
    assert.equal(f.outcome, 'installed'); assert.equal(f.forced, true);
    assert.match(records.at(-1).note, /상한/);
    await new Promise((res) => setTimeout(res, 300));   // 재시작 타이머(250ms)가 가짜 함수로 끝난 뒤에 주입을 되돌린다
    assert.equal(restarts.length, 2);
    assert.equal(installs.at(-1), '3.18.9');
    // 반증 A7: 수동 · 자동 적용이 성공하면 보류를 지운다
    H.holdPushIfBusy({ bytes: Buffer.from('3.19.0'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    const { upgradeManager } = await import('../src/upgrade/manager.js');
    upgradeManager.onApplied();
    assert.equal(H.pushHoldStatus(), null);
    // 기다릴 작업이 없으면 보류하지 않는다(호출자가 지금 설치) · 남은 보류는 지운다
    H.holdPushIfBusy({ bytes: Buffer.from('3.18.8'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' });
    blockers = [];
    assert.equal(H.holdPushIfBusy({ bytes: Buffer.from('3.18.9'), installDir: '/x', pkgName: 'p', where: 'push-edge', source: 'edge-push' }), null);
    assert.equal(H.pushHoldStatus(), null);
  } finally { H._setPushHoldDepsForTest(null); }
});

test('#3: 실제 수집기 라우트 — 진행 중 작업이 있으면 중앙 push 가 deferred 를 받고(설치 안 함) 중앙 동기화는 그 동안 다시 밀지 않는다', async () => {
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const H = await import('../src/upgrade/pushHold.js');
  const { pushBundleToCollector } = await import('../src/collector/upgradePush.js');
  const { planEdgeSync } = await import('../src/upgrade/edgeSync.js');
  const installs = [];
  H._setPushHoldDepsForTest({
    blockers: () => [{ kind: 'bareos', label: 'Bareos 등록' }], maxMs: () => HOUR, now: () => Date.now(),
    preverify: () => ({ ok: true, version: '9.9.9', from: '3.18.5' }),
    install: () => { installs.push(1); return { ok: true }; }, restart: () => {}, applying: () => false, record: () => {},
  });
  const app = express();
  app.use('/api/collector', collectorRouter);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const bytes = crypto.randomBytes(64);
    const r = await pushBundleToCollector({ id: 'c1', name: 'c1', url, token: process.env.COLLECTOR_TOKEN }, bytes, { timeout: 10_000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.deferred, true, '중앙이 보류 응답을 읽는다');
    assert.ok(r.waitMs > 0 && r.waitMs <= HOUR);
    assert.match(r.reason, /Bareos 등록/);
    assert.equal(installs.length, 0, '라우트가 설치를 미뤘다');
    assert.ok(H.pushHoldStatus(), '번들을 들고 있다');
    // 중앙 동기화: 보류 성공은 '효과 없음' 이 아니고, 남은 대기 + settle 동안 다시 밀지 않는다
    const now = Date.now();
    const plan = planEdgeSync({
      collectors: [{ id: 'c1', name: 'c1', url, enabled: true }], currentVersion: '9.9.9', now: now + 40 * 60_000,
      statusOf: () => ({ ok: true, version: '3.18.5' }),
      attemptsOf: () => ({ at: now, ok: true, target: '9.9.9', attempts: 0, holdUntil: now + r.waitMs }),
    });
    assert.equal(plan.edges[0].state, 'waiting', `settle(30분)을 넘겨도 보류 상한 안이면 다시 밀지 않는다: ${plan.edges[0].state}`);
    assert.deepEqual(plan.push, []);
  } finally { srv.close(); H._setPushHoldDepsForTest(null); }
});

test('#3: 엣지 보류 응답 읽기 — 아는 필드만 · 상한 12시간', async () => {
  const { deferredOf } = await import('../src/upgrade/pushDeferred.js');
  assert.deepEqual(deferredOf({ deferred: 'true', waitMs: 5 }), {});
  assert.deepEqual(deferredOf({ deferred: true, waitMs: 1e12, reason: 'x'.repeat(400) }), { deferred: true, waitMs: 12 * HOUR, reason: 'x'.repeat(300) });
  assert.deepEqual(deferredOf({ deferred: true, waitMs: '60000' }), { deferred: true }, '문자열 수는 받지 않는다 — 남은 시간을 모르면 settle 만');
});

test('반증 A5: 보류 응답을 받은 엣지는 효과 없음(noEffect) 판정보다 보류 상한을 먼저 본다 — 다시 밀지 않는다', async () => {
  const { planEdgeSync } = await import('../src/upgrade/edgeSync.js');
  const at = NOW - 61 * 60_000;
  const plan = planEdgeSync({
    collectors: [{ id: 'c1', name: 'c1', url: 'https://c1', enabled: true }], currentVersion: '9.9.9', now: NOW,
    statusOf: () => ({ ok: true, version: '3.18.5' }),
    attemptsOf: () => ({ at, ok: true, target: '9.9.9', attempts: 0, okSeen: 2, noEffect: 1, holdUntil: at + 2 * HOUR }),
  });
  assert.equal(plan.edges[0].state, 'waiting', plan.edges[0].state);
  assert.deepEqual(plan.push, []);
});

test('반증 K1: 호스트 용량 0 은 못 읽음 — 서버 · 웹 같은 판정(예전 판 엣지가 올리는 0)', async () => {
  const { hostCapacityKnown } = await import('../src/store.js');
  const web = await import('../../web/src/hostCapacity.js');
  for (const h of [{ cpuCores: 0, cpuTotalMhz: 48000, memTotalMB: 512000 }, { cpuCores: 16, cpuTotalMhz: 0, memTotalMB: 512000 }, { cpuCores: 16, cpuTotalMhz: 48000, memTotalMB: -1 }]) {
    assert.equal(hostCapacityKnown(h), false, JSON.stringify(h));
    assert.equal(web.hostCapacityKnown(h), false, JSON.stringify(h));
  }
  assert.equal(hostCapacityKnown({ cpuCores: 16, cpuTotalMhz: 48000, memTotalMB: 512000 }), true);
});

test('반증 K2: 클러스터 N+1 — 용량을 못 읽은 호스트는 용량 · 사용량 둘 다 빼고 판정하지 않는다(사용률 부풀림 없음)', async () => {
  const { n1Groups } = await import('../src/clustercfg/n1.js');
  const h = (name, mhz, mem, used) => ({ name, vcenterId: 'vc', cluster: 'C1', connectionState: 'CONNECTED', cpuTotalMhz: mhz, memTotalMB: mem, cpuUsageMhz: used, memUsageMB: used });
  const rows = n1Groups([h('a', 40000, 400000, 20000), h('b', 40000, 400000, 20000), h('c', 0, 0, 30000)], () => true);
  const r = rows[0].row;
  assert.equal(r.hostsCapacityUnknown, 1);
  assert.equal(r.n1Ok, null, '부분 합으로 장애 후 여유를 판정하지 않는다');
  assert.equal(r.cpuUsagePct, 50, `읽은 호스트만으로 사용률(c 의 사용량 30000 을 더하지 않는다): ${r.cpuUsagePct}`);
});

test('반증 A2: 보류 응답은 성공(적용)으로 보이지 않는다 — 엣지 기록 · 엣지 화면 · 중앙 수집 서버 표', async () => {
  const { sanitizeResult } = await import('../src/upgrade/autoState.js');
  const r = sanitizeResult({ at: NOW, source: 'collector-push', ok: true, deferred: true, version: '3.18.6', from: '3.18.5', waitMs: 3_600_000, reason: '진행 중 작업 1건(Bareos 등록)이 끝나면 …' });
  assert.equal(r.deferred, true); assert.equal(r.waitMs, 3_600_000);
  const auto = await import('../../web/src/views/upgradeAutoText.js');
  const s = auto.resultSummary(r);
  assert.match(s.text, /설치 대기/); assert.equal(s.tone, 'warn');
  const col = await import('../../web/src/views/collectorUpgradeText.js');
  const c = col.upgradeCell({ at: NOW, ok: true, deferred: true, version: '3.18.6', reason: '진행 중 작업 …' });
  assert.match(c.text, /설치 대기/); assert.doesNotMatch(c.text, /적용/); assert.match(c.reason, /진행 중 작업/);
});
