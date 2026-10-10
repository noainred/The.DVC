/**
 * v2.733 그룹 g — C4-03: 스토리지 스냅샷 파일은 장비마다가 아니라 **주기 끝 1회 + 안전 상한 타이머 + 종료 flush** 로 쓰고,
 * 쓰기 실패(ENOSPC·EROFS·EIO)는 **수집 주기를 멈추지 않는다**(v2.732 B6-02 의 SAN 판과 같은 구조).
 *
 * 예전: `putSnapshot` 마다 전 장비 JSON.stringify + 원자 쓰기(fsync 2회) — 한 주기 O(N²). 그리고 쓰기가 실패하면 putSnapshot 이
 *   던져 그 장비의 용량 적재·작업 로그가 건너뛰어지고, `poolRun` 이 주기 전체를 거부해 `_last` 가 갱신되지 않았으며,
 *   `util/adaptiveTimer.js` 의 빈 catch 가 그 오류를 **로그 없이** 삼켰다(재현: ENOSPC 주입 → 17대 중 3대만 시도 · 작업 로그 0건 ·
 *   상태 at:0 · 콘솔 0줄).
 * 고정하는 것: ① 실제 폴러 한 주기(N대) = 파일 쓰기 1회 + 내용은 맵 그대로 + 상태에 저장 상태 ② put 은 표시만 · 바뀐 것이 없으면
 *   쓰지 않는다 ③ 삭제는 즉시 쓴다 ④ 단건 수집은 끝나면 쓴다 ⑤ 쓰기 실패 → 전 장비 수집·작업 로그·상태 갱신은 계속 + 상태·콘솔 기록 ·
 *   대기분 유지 후 재시도 ⑥ 장비 하나의 예상치 못한 예외도 주기를 끊지 않는다 ⑦ 삭제 쓰기 실패도 던지지 않는다
 *   ⑧ 안전 상한 타이머(mock 2초) ⑨ 종료 flush(마지막).
 * 쓰기 횟수는 atomicWrite 가 부르는 `fs.renameSync`(대상 = 스냅샷 파일)로 센다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2733g-st-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'live';

const FILE = path.join(TMP, 'storage-latest.json');
let writes = 0;
let failNext = 0;
const realRename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (path.resolve(String(to)) === path.resolve(FILE)) {
    if (failNext > 0) { failNext--; const e = new Error('ENOSPC: no space left on device (테스트)'); e.code = 'ENOSPC'; throw e; }
    writes++;
  }
  return realRename.apply(this, arguments);
};

const { setDataSource } = await import('../src/runtime-settings.js');
setDataSource('live');
const reg = await import('../src/storage/registry.js');
const store = await import('../src/storage/store.js');
const poller = await import('../src/storage/poller.js');
const act = await import('../src/storage/activityLog.js');
const { runExitFlush } = await import('../src/util/exitFlush.js');

const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const capture = async (fn) => {
  const w = console.warn; const l = console.log; const lines = [];
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return { r: await fn(), lines }; } finally { console.warn = w; console.log = l; }
};
const eventsSince = (t) => (act.listActivity?.() || []).filter((e) => Number(e.at) >= t);

const TYPES = ['unity480', 'powerstore', 'xtremio', 'vmax', 'vplex', 'unity480', 'powerstore', 'xtremio', 'vmax'];
const ids = [];
test.before(() => {
  // 닿지 않는 주소(.invalid — 이름 해석이 즉시 실패)로 등록한다: 실패 스냅샷도 putSnapshot 을 한 번씩 부른다.
  TYPES.forEach((type, i) => {
    const d = reg.saveDevice({ type, name: `st${i}`, host: `st${i}.a2733g.invalid`, username: 'u', password: 'p', collectMethod: 'api' });
    ids.push(d.id);
  });
});
test.after(() => { fs.renameSync = realRename; fs.rmSync(TMP, { recursive: true, force: true }); });

test('① 실제 폴러 한 주기(9대) — 파일 쓰기는 1회이고 내용은 맵과 같다 · 상태가 저장 상태를 싣는다', async () => {
  writes = 0;
  const { r } = await capture(() => poller.pollStorageOnce());
  assert.equal(r.ok + r.fail, ids.length, JSON.stringify(r));
  assert.equal(writes, 1, `한 주기 쓰기 횟수 ${writes}(예전: 장비마다 1회 = ${ids.length}회 이상)`);
  const onDisk = readFile();
  assert.deepEqual(Object.keys(onDisk).sort(), [...ids].sort());
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(Object.fromEntries(store.localSnapshots().map((s) => [s.deviceId, s])))));
  assert.equal(store.snapshotStoreStatus().pending, false);
  const st = poller.storagePollerStatus();
  assert.ok(st.snapshotSave && st.snapshotSave.pending === false && st.snapshotSave.writes >= 1, JSON.stringify(st.snapshotSave));
});

test('② put 은 표시만 한다 — flush 1회 · 바뀐 것이 없으면 다시 쓰지 않는다', () => {
  writes = 0;
  for (let i = 0; i < 5; i++) store.putSnapshot({ deviceId: ids[0], name: 'st0', ok: true, collectedAt: 1_800_000_000_000 + i });
  assert.equal(writes, 0, `put 마다 쓰면 안 된다(${writes}회)`);
  assert.equal(store.snapshotStoreStatus().pending, true);
  assert.deepEqual(store.flushSnapshotsNow(), { ok: true, wrote: true });
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[0]].collectedAt, 1_800_000_000_004);
  assert.deepEqual(store.flushSnapshotsNow(), { ok: true, wrote: false });
  assert.equal(writes, 1, '변경이 없으면 쓰지 않는다');
});

test('③ 삭제는 즉시 쓴다 — 재시작 뒤 지운 장비가 유령으로 남지 않는다', () => {
  writes = 0;
  store.dropSnapshot(ids[8]);
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[8]], undefined);
  store.dropSnapshot('없는-id');
  assert.equal(writes, 1, '지운 것이 없으면 쓰지 않는다');
});

test('④ 단건 수집(collectDeviceNow)은 끝나면 바로 쓴다', async () => {
  writes = 0;
  const { r: ok } = await capture(() => poller.collectDeviceNow(ids[1]));
  assert.equal(ok, true);
  assert.equal(writes, 1);
  assert.equal(store.snapshotStoreStatus().pending, false);
});

test('⑤ 쓰기 실패(ENOSPC)는 주기를 멈추지 않는다 — 전 장비 시도·작업 로그·상태 갱신 + 콘솔·상태 기록 · 대기분은 다음에 쓴다', async () => {
  writes = 0;
  failNext = 1;
  const t0 = Date.now();
  const { r, lines } = await capture(() => poller.pollStorageOnce());
  assert.ok(r && !r.skipped, `주기가 끝까지 돌아 결과를 돌려준다(예전: ENOSPC 로 거부) ${JSON.stringify(r)}`);
  assert.equal(r.ok + r.fail, ids.length, `등록 ${ids.length}대 전부 시도(예전: 동시성 3대만) ${JSON.stringify(r)}`);
  const st = poller.storagePollerStatus();
  assert.ok(st.at >= t0, `상태 at 갱신(예전: 직전 값 그대로) ${st.at}`);
  assert.equal(st.collected + st.failed, ids.length);
  assert.equal(eventsSince(t0).length, ids.length, '작업 로그가 장비마다 남는다(예전: 0건)');
  assert.ok(lines.some((m) => /스냅샷 저장 실패/.test(m) && /ENOSPC/.test(m)), `콘솔에 남는다:\n${lines.join('\n')}`);
  const ss = st.snapshotSave;
  assert.equal(ss.pending, true, '실패하면 대기분을 버리지 않는다');
  assert.ok(ss.failures >= 1 && ss.lastErrorCode === 'ENOSPC', JSON.stringify(ss));
  assert.ok(!JSON.stringify(st).includes(TMP), '상태에 파일 경로를 싣지 않는다');
  // 다음 기회(다음 flush)에 다시 쓴다 — 복구 사실도 콘솔에 남긴다.
  const { r: f2, lines: l2 } = await capture(() => store.flushSnapshotsNow());
  assert.deepEqual(f2, { ok: true, wrote: true });
  assert.equal(writes, 1);
  assert.ok(l2.some((m) => /스냅샷 저장 복구/.test(m)), l2.join('\n'));
  assert.equal(store.snapshotStoreStatus().pending, false);
});

test('⑤-b 같은 사유의 반복 실패는 콘솔을 덮지 않는다(첫 1줄) — 상태 카운터는 매번 센다', async () => {
  failNext = 3;
  store.putSnapshot({ deviceId: ids[0], name: 'st0', ok: true, collectedAt: 1_800_000_050_000 });
  const before = store.snapshotStoreStatus().failures;
  const { lines } = await capture(() => { store.flushSnapshotsNow(); store.flushSnapshotsNow(); store.flushSnapshotsNow(); });
  assert.equal(store.snapshotStoreStatus().failures - before, 3);
  assert.equal(lines.filter((m) => /스냅샷 저장 실패/.test(m)).length, 1, lines.join('\n'));
  failNext = 0;
  await capture(() => store.flushSnapshotsNow());
  assert.equal(store.snapshotStoreStatus().pending, false);
});

test('⑥ 장비 하나의 예상치 못한 예외도 주기를 끊지 않는다 — 그 장비만 실패로 세고 콘솔에 남긴다', async () => {
  const victim = reg.getDeviceWithSecret(ids[2]);
  const realType = victim.type;
  Object.defineProperty(victim, 'type', { configurable: true, enumerable: true, get() { throw new Error('주입된 예외(테스트)'); } });
  const t0 = Date.now();
  let out;
  try { out = await capture(() => poller.pollStorageOnce()); }
  finally { Object.defineProperty(victim, 'type', { configurable: true, enumerable: true, writable: true, value: realType }); }
  const { r, lines } = out;
  assert.ok(r && !r.skipped, `주기가 끝까지 돌아 결과를 돌려준다 ${JSON.stringify(r)}`);
  assert.equal(r.ok + r.fail, ids.length, JSON.stringify(r));
  assert.equal(eventsSince(t0).length, ids.length - 1, '예외 난 1대를 뺀 나머지는 작업 로그가 남는다');
  const st = poller.storagePollerStatus();
  assert.equal(st.deviceErrors, 1, JSON.stringify(st));
  assert.ok(st.at >= t0);
  assert.equal(st.busy, false);
  assert.ok(lines.some((m) => /주입된 예외/.test(m)), lines.join('\n'));
});

test('⑦ 삭제 쓰기 실패도 던지지 않는다(삭제 라우트가 500 이 되지 않게) — 상태에 남고 다음에 쓴다', async () => {
  writes = 0;
  failNext = 1;
  const { lines } = await capture(() => assert.doesNotThrow(() => store.dropSnapshot(ids[7])));
  assert.equal(store.snapshotStoreStatus().pending, true);
  assert.ok(store.localSnapshots().every((s) => s.deviceId !== ids[7]), '메모리에서는 지워졌다');
  assert.ok(lines.some((m) => /스냅샷 저장 실패/.test(m)), lines.join('\n'));
  await capture(() => store.flushSnapshotsNow());
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[7]], undefined);
});

test('⑧ 안전 상한 타이머 — 주기 끝 flush 없이도 쓴다(mock 2초 · 다음 put 이 미루지 않는다)', async () => {
  assert.ok(store.SNAPSHOT_FLUSH_MAX_MS > 0 && store.SNAPSHOT_FLUSH_MAX_MS <= 60_000, `live 상한 ${store.SNAPSHOT_FLUSH_MAX_MS}`);
  setDataSource('mock');
  try {
    writes = 0;
    store.putSnapshot({ deviceId: ids[3], name: 'st3', ok: true, collectedAt: 1_800_000_200_000 });
    await new Promise((r) => { setTimeout(r, 1500); });
    store.putSnapshot({ deviceId: ids[3], name: 'st3', ok: true, collectedAt: 1_800_000_200_001 });
    await new Promise((r) => { setTimeout(r, 900); });
    assert.equal(writes, 1, '첫 put 에서 무장한 타이머가 2초 안팎에 썼다(디바운스였다면 아직 0)');
    assert.equal(readFile()[ids[3]].collectedAt, 1_800_000_200_001);
  } finally { setDataSource('live'); }
});

test('⑨ 종료 flush 가 대기분을 쓴다(마지막)', () => {
  writes = 0;
  store.putSnapshot({ deviceId: ids[4], name: 'st4', ok: true, collectedAt: 1_800_000_300_000 });
  assert.equal(writes, 0);
  runExitFlush('test');
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[4]].collectedAt, 1_800_000_300_000);
});
