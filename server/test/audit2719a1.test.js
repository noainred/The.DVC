// v2.719 감사 그룹 A1 — 데모 표지 항목은 live 모드에서 실제로 점검·실행·선택하지 않는다.
//  R1-01·R2-02: svcmon 데모 대상(배치 mock-demo)을 live 에서 실제 점검하던 것
//  R1-07: vmclone 데모 잡이 live 스케줄에서 실행되던 것 · 볼트 데모 계정이 live 에서 선택되던 것
//  R2-05: 데모 RMA 5초 타이머가 live 전환 뒤에도 합성 결과를 적재하던 것
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719a1-'));
process.env.CONFIG_DIR = dir;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 데모 대상 host 로 닫힌 루프백 포트를 쓴다(예전 코드면 실제로 두드려 결과가 남는다)

const rs = await import('../src/runtime-settings.js');
// 경계에서 떨어뜨린 고정 기준 시각(정시 −30분)
const HOUR = 3_600_000;
const NOW = Math.floor(1_790_000_000_000 / HOUR) * HOUR - 30 * 60_000;

test('R1-01 · svcmon: live 모드의 데모 배치 대상은 점검하지 않고 건너뛴 개수를 상태에 남긴다(실제 sweep)', async () => {
  rs.setDataSource('live');
  const store = await import('../src/svcmon/store.js');
  const r = store.bulkAddTargets([
    { kind: 'infra', path: 'vCenter\\demo', name: 'demo-host', host: '127.0.0.1', tests: [{ name: 'tcp1', type: 'tcp', port: 1, intervalSec: 60 }] },
  ], { atomic: false, batch: 'mock-demo' });
  assert.equal(r.added, 1, JSON.stringify(r));
  const poller = await import('../src/svcmon/poller.js');
  assert.equal(await poller.runNow(), true);
  // 데모 대상은 runBatch 로 가지 않으므로 결과가 없다(예전에는 127.0.0.1:1 을 실제로 두드려 'bad' 결과가 남았다).
  assert.equal(poller.getResults().size, 0, 'live 모드에서 데모 대상을 실제로 점검했다');
  const st = poller.pollerStats().demoSkipped;
  assert.ok(st && st.lastCount >= 1, JSON.stringify(st));
  assert.match(st.reason, /live/);
});

test('R1-01 · svcmon: 판정 분리(순수) — 사람이 등록한 대상은 모드 무관 실점검, 데모는 mock 에서만 합성', async () => {
  const m = await import('../src/mock/demo/svcmon.js');
  const human = { target: { batch: '' } }, demoT = { target: { batch: 'mock-demo' } };
  assert.equal(m.isSvcmonDemoBatch(demoT.target), true);
  const live = m.splitSvcmonDue([human, demoT], { mock: false });
  assert.deepEqual([live.live.length, live.demo.length, live.skipped.length], [1, 0, 1]);
  const mock = m.splitSvcmonDue([human, demoT], { mock: true });
  assert.deepEqual([mock.live.length, mock.demo.length, mock.skipped.length], [1, 1, 0]);
});

test('R1-07 · vmclone: 데모 잡은 live 스케줄에서 건너뛰고(상태 표시), mock 에서는 실행한다', async () => {
  const sch = await import('../src/vmclone/scheduler.js');
  const base = { enabled: true, schedule: { mode: 'interval', hours: 12 }, lastRun: null, clones: [] };
  const human = { ...base, id: 'h' };
  const demo = { ...base, id: 'd', demo: true };
  const legacy = { ...base, id: 'l', clones: [{ ref: 'mock-demo-x-1', at: NOW - HOUR }] };   // 표지 이전 시드
  const live = sch.dueJobsOf([human, demo, legacy], NOW, { mock: false });
  assert.deepEqual(live.run.map((j) => j.id), ['h']);
  assert.deepEqual(live.skipped.map((j) => j.id).sort(), ['d', 'l']);
  const mock = sch.dueJobsOf([human, demo, legacy], NOW, { mock: true });
  assert.equal(mock.run.length, 3);
});

test('R1-07 · vmclone store: 새 잡은 demo 표지를 저장하고 수정은 표지를 유지한다', async () => {
  const st = await import('../src/vmclone/store.js');
  const j = st.saveJob({ vcenterId: 'vc-x', vmId: 'vm-1', vmName: 'db-1', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 12 }, demo: true });
  assert.equal(j.demo, true);
  const j2 = st.saveJob({ id: j.id, vcenterId: 'vc-x', vmId: 'vm-1', vmName: 'db-1', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 6 } });
  assert.equal(j2.demo, true);
  const h = st.saveJob({ vcenterId: 'vc-x', vmId: 'vm-2', vmName: 'db-2', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 12 } });
  assert.equal(h.demo, undefined);
});

test('R1-07 · 볼트: 데모 계정은 live 에서 브로커·사전 검사가 거부하고, 사람이 고쳐 저장하면 쓸 수 있다', async () => {
  const cs = await import('../src/security/credentialStore.js');
  const v = cs.saveCredential({ name: 'mock-linux-admin', kind: 'password', username: 'svc_portal', password: 'mock', hosts: '10.0.0.0/8', agents: '*' }, { actor: 'mock-demo' });
  assert.equal(v.demo, true);
  rs.setDataSource('live');
  assert.equal(cs.brokerFetch(v.id, { agent: 'Edge-A', host: '10.1.2.3' }).ok, false);
  assert.match(cs.credentialUsable(v.id, { agent: 'Edge-A', host: '10.1.2.3' }).reason, /데모/);
  rs.setDataSource('mock');
  assert.equal(cs.credentialUsable(v.id, { agent: 'Edge-A', host: '10.1.2.3' }).ok, true);
  rs.setDataSource('live');
  const edited = cs.saveCredential({ id: v.id, name: 'linux-admin', kind: 'password', username: 'svc_portal', password: 'real', hosts: '10.0.0.0/8', agents: '*' }, { actor: 'admin' });
  assert.equal(edited.demo, undefined);
  assert.equal(cs.brokerFetch(v.id, { agent: 'Edge-A', host: '10.1.2.3' }).ok, true);
});

test('R2-05 · 데모 RMA 타이머: live 면 스스로 멈춘다(mock 이면 계속)', async () => {
  const es = await import('../src/mock/demo/edgeSeed.js');
  rs.setDataSource('mock');
  assert.equal(es.stopRmaTimerIfLive(), false);
  rs.setDataSource('live');
  assert.equal(es.stopRmaTimerIfLive(), true);
  assert.equal(es._rmaTimerActiveForTest(), false);
});

test('R1-07 후속 · vmclone runner: live 에서는 데모 잡을 수동 실행으로도 돌리지 않고 사유를 남긴다', async () => {
  rs.setDataSource('live');
  const store = await import('../src/vmclone/store.js');
  const runner = await import('../src/vmclone/runner.js');
  const j = store.saveJob({ vcenterId: 'vc-none', vmId: 'vm-1', vmName: 'demo-vm', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 12 }, keep: 2, enabled: true, demo: true });
  assert.equal(runner.enqueueRun(j.id).queued, true);
  for (let i = 0; i < 50 && !store.getJob(j.id).lastRun; i++) await new Promise((r) => setTimeout(r, 20));
  const lr = store.getJob(j.id).lastRun;
  assert.equal(lr?.skipped, 'demo-job', JSON.stringify(lr));
});

test('B1-04 후속 · 엣지 태그 보고 정제가 partialTags·retryAt 을 싣는다(없으면 싣지 않는다)', async () => {
  const { sanitizeTagInv } = await import('../src/tags/parse.js');
  assert.equal(sanitizeTagInv({ at: 1, partialTags: true, retryAt: 5 }).value.partialTags, true);
  assert.equal(sanitizeTagInv({ at: 1, partialTags: true, retryAt: 5 }).value.retryAt, 5);
  assert.equal('partialTags' in sanitizeTagInv({ at: 1 }).value, false, '구버전 엣지는 analyze 가 잘림 개수로 판정');
});
