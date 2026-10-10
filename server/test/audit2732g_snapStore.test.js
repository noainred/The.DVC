/**
 * v2.732 그룹 g — B6-02: SAN 스냅샷 파일은 장비마다가 아니라 **주기 끝 1회 + 안전 상한 타이머 + 종료 flush** 로 쓴다.
 *
 * 예전(live): `putSnapshot` 마다 전 장비를 JSON.stringify + 원자 쓰기(fsync 2회) — 한 주기 합이 O(N²)(86대 약 5초).
 * 2초 디바운스는 live 에서 장비 완료 간격이 대부분 2초보다 길어 거의 묶지 못한다(verify-B6) — 그래서 폴러가 풀이 끝난 뒤 한 번 쓴다.
 * 고정하는 것: ① 실제 폴러 한 주기(N대) = 파일 쓰기 1회 + 내용은 맵 그대로 ② put 은 표시만 · 바뀐 것이 없으면 쓰지 않는다
 * ③ 삭제는 즉시 쓴다(유령 방지) ④ 단건 수집은 끝나면 쓴다 ⑤ 종료 flush 가 대기분을 쓴다 ⑥ 쓰기 실패는 무음이 아니다(상태·콘솔·재시도)
 * ⑦ 안전 상한 타이머가 주기 끝 flush 없이도 쓴다(mock 2초 — 다음 put 이 미루지 않는다).
 * 쓰기 횟수는 atomicWrite 가 부르는 `fs.renameSync`(대상 = 스냅샷 파일)로 센다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732g-snap-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.SSH_READY_TIMEOUT_MS = '3000';

const FILE = path.join(TMP, 'sanswitch-latest.json');
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
const reg = await import('../src/sanswitch/registry.js');
const store = await import('../src/sanswitch/store.js');
const poller = await import('../src/sanswitch/poller.js');
const { runExitFlush } = await import('../src/util/exitFlush.js');

const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

const ids = [];
test.before(() => {
  // 닿지 않는 주소(.invalid — DNS 가 즉시 ENOTFOUND)로 등록한다: 실패 스냅샷도 putSnapshot 을 한 번씩 부른다.
  for (let i = 0; i < 8; i++) {
    const d = reg.saveDevice({ type: 'brocade', name: `sw${i}`, host: `sw${i}.a2732g.invalid`, username: 'u', password: 'p', collectMethod: 'ssh' });
    ids.push(d.id);
  }
});
test.after(() => { fs.renameSync = realRename; fs.rmSync(TMP, { recursive: true, force: true }); });

test('① 실제 폴러 한 주기(8대) — 파일 쓰기는 1회이고 내용은 맵과 같다', async () => {
  writes = 0;
  const r = await quiet(() => poller.pollSanSwitchOnce({ manual: true }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 8);
  assert.equal(writes, 1, `한 주기 쓰기 횟수 ${writes}(예전: 장비마다 1회 = 8회)`);
  const onDisk = readFile();
  assert.deepEqual(Object.keys(onDisk).sort(), [...ids].sort());
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(Object.fromEntries(store.localSnapshots().map((s) => [s.deviceId, s])))));
  assert.equal(store.snapshotStoreStatus().pending, false);
  assert.ok(poller.sanSwitchPollerStatus().snapshotSave, '폴러 상태가 저장 상태를 싣는다');
});

test('② put 은 표시만 한다 — flush 1회 · 바뀐 것이 없으면 다시 쓰지 않는다', () => {
  writes = 0;
  for (let i = 0; i < 5; i++) store.putSnapshot({ deviceId: ids[0], name: 'sw0', ok: true, collectedAt: 1_800_000_000_000 + i, ports: { list: [] } });
  assert.equal(writes, 0, `put 마다 쓰면 안 된다(${writes}회)`);
  assert.equal(typeof store.flushSnapshotsNow, 'function');
  assert.equal(store.snapshotStoreStatus().pending, true);
  assert.deepEqual(store.flushSnapshotsNow(), { ok: true, wrote: true });
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[0]].collectedAt, 1_800_000_000_004);
  assert.deepEqual(store.flushSnapshotsNow(), { ok: true, wrote: false });
  assert.equal(writes, 1, '변경이 없으면 쓰지 않는다');
});

test('③ 삭제는 즉시 쓴다 — 재시작 뒤 지운 장비가 유령으로 남지 않는다', () => {
  writes = 0;
  store.dropSnapshot(ids[7]);
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[7]], undefined);
  store.dropSnapshot('없는-id');
  assert.equal(writes, 1, '지운 것이 없으면 쓰지 않는다');
});

test('④ 단건 수집(collectDeviceNow)은 끝나면 바로 쓴다', async () => {
  writes = 0;
  const ok = await quiet(() => poller.collectDeviceNow(ids[1]));
  assert.equal(ok, true);
  assert.equal(writes, 1);
  assert.equal(store.snapshotStoreStatus().pending, false);
});

test('⑥ 쓰기 실패는 무음이 아니다 — 상태·콘솔에 남고 대기분을 유지해 다음에 쓴다', () => {
  writes = 0;
  store.putSnapshot({ deviceId: ids[2], name: 'sw2', ok: true, collectedAt: 1_800_000_100_000, ports: { list: [] } });
  failNext = 1;
  const warned = [];
  const w = console.warn; console.warn = (m) => warned.push(String(m));
  let r;
  try { r = store.flushSnapshotsNow(); } finally { console.warn = w; }
  assert.equal(r.ok, false);
  assert.ok(warned.some((m) => /스냅샷 저장 실패/.test(m)), warned.join('\n'));
  const st = store.snapshotStoreStatus();
  assert.equal(st.pending, true, '실패하면 대기분을 버리지 않는다');
  assert.ok(st.failures >= 1 && st.lastErrorCode === 'ENOSPC', JSON.stringify(st));
  assert.ok(!JSON.stringify(st).includes(TMP), '상태에 파일 경로를 싣지 않는다');
  assert.deepEqual(store.flushSnapshotsNow(), { ok: true, wrote: true });
  assert.equal(readFile()[ids[2]].collectedAt, 1_800_000_100_000);
});

test('⑦ 안전 상한 타이머 — 주기 끝 flush 없이도 쓴다(mock 2초 · 다음 put 이 미루지 않는다)', async () => {
  assert.ok(store.SNAPSHOT_FLUSH_MAX_MS > 0 && store.SNAPSHOT_FLUSH_MAX_MS <= 60_000, `live 상한 ${store.SNAPSHOT_FLUSH_MAX_MS}`);
  setDataSource('mock');
  try {
    writes = 0;
    store.putSnapshot({ deviceId: ids[3], name: 'sw3', ok: true, collectedAt: 1_800_000_200_000, ports: { list: [] } });
    await new Promise((r) => { setTimeout(r, 1500); });
    store.putSnapshot({ deviceId: ids[3], name: 'sw3', ok: true, collectedAt: 1_800_000_200_001, ports: { list: [] } });
    await new Promise((r) => { setTimeout(r, 900); });
    assert.equal(writes, 1, '첫 put 에서 무장한 타이머가 2초 안팎에 썼다(디바운스였다면 아직 0)');
    assert.equal(readFile()[ids[3]].collectedAt, 1_800_000_200_001);
  } finally { setDataSource('live'); }
});

test('⑤ 종료 flush 가 대기분을 쓴다(마지막)', () => {
  writes = 0;
  store.putSnapshot({ deviceId: ids[4], name: 'sw4', ok: true, collectedAt: 1_800_000_300_000, ports: { list: [] } });
  assert.equal(writes, 0);
  runExitFlush('test');
  assert.equal(writes, 1);
  assert.equal(readFile()[ids[4]].collectedAt, 1_800_000_300_000);
});
