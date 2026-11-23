/**
 * v3.34.2 — 작업 로그 묶음 쓰기의 간격은 쓰기가 **끝난** 시각부터 잰다(v3.34.1 릴리스 실행 실패의 원인).
 *
 *  · 예전 판은 마지막 쓰기 시각을 쓰기를 **시작할 때** 찍었다. 쓰기(직렬화 + fsync 2회 + rename)가 간격보다 오래 걸리면 같은 동기 루프의
 *    다음 기록이 ‘간격이 지났다’ 로 보고 곧바로 또 썼다 — 느린 디스크에서 기록마다 전량을 다시 쓴다(묶음 쓰기가 꺼지는 꼴).
 *    릴리스 러너에서 `audit2621d LIFE-03`(간격 30ms)이 이 경로로 ‘쓰기 2회’ 가 돼 떨어졌다(PR CI 는 통과 — 디스크 속도에 달렸다).
 *  · 여기서는 느린 디스크를 **주입**한다: 대상 파일로의 rename 을 간격보다 오래 붙잡는다(Atomics.wait — 동기). 시계에 기대지 않는 판정:
 *    ‘같은 동기 루프의 기록 N건 → 쓰기 1번’ 은 쓰기가 간격보다 오래 걸려도 성립해야 한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('actlog-slow-');   // config.configDir 는 import 시점에 굳는다

const blockMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** 대상 파일로의 rename 을 세고, 그때마다 holdMs 만큼 붙잡는다(느린 디스크 주입). */
function slowRenames(file, holdMs) {
  const orig = fs.renameSync;
  let n = 0;
  fs.renameSync = function patched(a, b) { if (b === file) { n += 1; blockMs(holdMs); } return orig.apply(this, arguments); };
  return { get n() { return n; }, restore() { fs.renameSync = orig; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('쓰기가 간격보다 오래 걸려도 같은 동기 루프의 기록은 한 번만 곧바로 쓴다(나머지는 간격 끝에 한 번)', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const GAP = 30;
  const log = createActivityLog({ fileName: 'slow-write-activity.json', writeGapMs: GAP });
  const spy = slowRenames(log.FILE, GAP + 20);   // 쓰기 한 번이 간격(30ms)보다 오래(50ms) 걸린다
  try {
    for (let i = 0; i < 5; i++) log.recordActivity({ deviceId: `d-${i}`, ok: true, at: 1_790_000_000_000 + i });
    assert.equal(spy.n, 1, `쓰기가 느리면 같은 묶음의 기록마다 다시 썼다(쓰기 ${spy.n}회) — 간격은 쓰기가 끝난 시각부터 재야 한다`);
    await sleep(GAP * 2 + 80);   // 뒤 경계 타이머(≤ 간격) + 느린 쓰기 한 번
    assert.equal(spy.n, 2, `간격 끝의 묶음 쓰기는 한 번이어야 한다(실제 ${spy.n}회)`);
    const onDisk = JSON.parse(fs.readFileSync(log.FILE, 'utf8'));
    assert.deepEqual(onDisk.map((e) => e.deviceId), ['d-0', 'd-1', 'd-2', 'd-3', 'd-4'], '간격 끝 쓰기가 마지막 기록까지 담는다');
  } finally { spy.restore(); log._resetForTest(); }
});

test('쓰기가 끝난 뒤로 간격이 지나면 다음 기록은 다시 곧바로 쓴다(따로 떨어진 기록 — 앞 경계 그대로)', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const GAP = 30;
  const log = createActivityLog({ fileName: 'slow-write-activity2.json', writeGapMs: GAP });
  const spy = slowRenames(log.FILE, GAP + 20);
  try {
    log.recordActivity({ deviceId: 'a', ok: true, at: 1_790_000_000_000 });
    assert.equal(spy.n, 1);
    await sleep(GAP + 15);       // 쓰기가 끝난 시각부터 간격을 넘겼다
    log.recordActivity({ deviceId: 'b', ok: true, at: 1_790_000_000_001 });
    assert.equal(spy.n, 2, '간격이 지난 뒤의 따로 떨어진 기록은 곧바로 쓴다');
    assert.equal(JSON.parse(fs.readFileSync(log.FILE, 'utf8')).at(-1).deviceId, 'b');
  } finally { spy.restore(); log._resetForTest(); }
});
