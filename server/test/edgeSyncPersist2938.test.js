/**
 * edgeSyncPersist2938.test.js — 엣지 동기화의 연속 실패 수·알린 사실이 재시작을 넘긴다(v2.938 · 제안 3번).
 * 예전에는 메모리뿐이라 재시작하면 같은 장애를 다시 알렸고 백오프도 처음(10분)부터 다시 시작했다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'edgesyncpersist-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
const sync = await import('../src/upgrade/edgeSync.js');
const store = await import('../src/upgrade/statusStore.js');
const auto = await import('../src/upgrade/autoState.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');

const CUR = '99.2.0';
const NOW = Date.UTC(2026, 10, 7, 9, 40, 0); // 고정 기준 시각(정시와 떨어뜨림)
const quiet = { log() {}, warn() {} };
const mkRunner = (alerts, clock, { fail = () => true } = {}) => new sync.EdgeSyncRunner({
  settings: () => ({ enabled: true, edgeAutoUpgrade: true }), now: () => clock.now, currentVersion: () => CUR, intervalMs: 600_000, log: quiet,
  collectors: () => [{ id: 'pl', name: '폴란드', url: 'https://pl', enabled: true }], statusOf: () => ({ ok: true, version: '99.1.0' }),
  pushFn: async (b, o) => o.ids.map((id) => (fail() ? { id, name: '폴란드', ok: false, reason: 'HTTP 403' } : { id, name: '폴란드', ok: true, version: CUR })),
  resolveBundle: async () => ({ bytes: Buffer.from('x'), version: CUR, source: 'package', manifest: null, path: '/x' }),
  notifyFn: async (a) => { alerts.push(a); return ['slack:200']; },
});

test('연속 실패·알린 사실이 상태 파일을 거쳐 되살아난다 — 재시작 뒤 같은 장애를 다시 알리지 않고 백오프도 이어진다', async () => {
  const file = path.join(CFG, 'upgrade-status.json');
  const alerts = []; const clock = { now: NOW };
  const r1 = mkRunner(alerts, clock);
  for (let i = 1; i <= 7; i += 1) { await r1.run(); clock.now += sync.backoffMs(i, 600_000) + 1; }
  assert.equal(alerts.length, 1, '7번째 실패에서 한 번 알렸다');
  assert.equal(store.writeUpgradeStatus(file, { edgeSyncState: r1.persistState() }), null);
  const doc = store.readUpgradeStatus(file).doc;
  assert.deepEqual(doc.edgeSyncState.alerted, [`pl|${CUR}`]);
  assert.equal(doc.edgeSyncState.attempts[0][0], 'pl'); assert.equal(doc.edgeSyncState.attempts[0][1].attempts, 7);

  // '재시작' — 새 runner 가 상태를 되살린다
  const r2 = mkRunner(alerts, clock);
  assert.equal(r2.restoreState(doc.edgeSyncState), true);
  const st = r2.status(r2.attempts.get('pl').at + 60_000); // 마지막 실패 1분 뒤
  assert.equal(st.pending[0].state, 'backoff', '되살린 직후에는 6시간 백오프 안이다(재시작이 백오프를 지우지 않는다)');
  clock.now += sync.SYNC_BACKOFF_MAX_MS;
  await r2.run();
  assert.equal(r2.attempts.get('pl').attempts, 8, '연속 실패 수가 이어진다');
  assert.equal(alerts.length, 1, '같은 장애를 다시 알리지 않는다');
  // 해소 알림은 되살린 표지로도 나간다
  const r3 = mkRunner(alerts, clock, { fail: () => false });
  r3.restoreState(r2.persistState());
  clock.now += sync.SYNC_BACKOFF_MAX_MS + 1;
  await r3.run();
  assert.equal(alerts.length, 2); assert.match(alerts[1].key, /:close$/);
  assert.deepEqual(r3.persistState().alerted, [], '해소되면 표지를 지운다');
});

test('정제 — 모르는 모양은 버린다 · 상한 · 비어 있으면 null', () => {
  assert.equal(auto.sanitizeEdgeSyncState(null), null);
  assert.equal(auto.sanitizeEdgeSyncState({ attempts: [], alerted: [] }), null);
  const r = auto.sanitizeEdgeSyncState({
    attempts: [['a', { at: NOW, ok: false, target: 'v99.2.0', attempts: 3, reason: 'x'.repeat(500), evil: 1 }], ['b', { at: 'x', target: CUR, attempts: 1 }], ['c'], 'bad', ['d', { at: NOW, target: 'nope', attempts: 1 }]],
    alerted: ['a|99.2.0', 7, 'noBar', 'e|' + 'x'.repeat(300)],
  });
  assert.equal(r.attempts.length, 1); assert.deepEqual(Object.keys(r.attempts[0][1]).sort(), ['at', 'attempts', 'ok', 'reason', 'target']);
  assert.equal(r.attempts[0][1].target, '99.2.0'); assert.equal(r.attempts[0][1].reason.length, 300);
  assert.equal(r.alerted.length, 2); assert.equal(r.alerted[1].length, 240);
  const many = auto.sanitizeEdgeSyncState({ alerted: Array.from({ length: 900 }, (_, i) => `e${i}|1.0.0`) });
  assert.equal(many.alerted.length, 500);
});

test('매니저 — 동기화가 돌면 상태 파일에 edgeSyncState 를 쓰고, 새 매니저가 되살린다', async () => {
  const file = path.join(CFG, 'upgrade-status-mgr.json');
  const m = new UpgradeManager();
  m.enablePersistence(file);
  m.edgeSync.attempts.set('pl', { at: NOW, ok: false, target: CUR, attempts: 4, reason: 'HTTP 403' });
  m.edgeSync.alerted.add(`pl|${CUR}`);
  m.edgeSync.onRun({ at: NOW, outcome: 'idle' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.edgeSyncState.attempts[0][1].attempts, 4);
  const m2 = new UpgradeManager();
  m2.enablePersistence(file);
  assert.equal(m2.edgeSync.attempts.get('pl').attempts, 4); assert.ok(m2.edgeSync.alerted.has(`pl|${CUR}`));
});
