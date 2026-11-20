/**
 * 164회차 — 사용자 결정 6 '같은 판정으로 맞춰': 긴급중단(emergency stop)을 보지 않던 수집기 · 기록기.
 *  배경: 긴급중단 동안 store.refresh 는 곧바로 돌아와 스냅샷이 통째로 얼어 있다(158 N158-2 · 162 N2 가 샘플러 · /metrics 를 고침).
 *  S1 snaphist(스냅샷 이력 하루 기록) · S2 vmtrack(VM 수량 슬롯) — 얼어 있는 값을 지금 값으로 남겼다 → 샘플러와 같은 판정(snapshotFrozenByStop)으로 보류 ·
 *     푼 직후(다음 병합 전)도 보류 · 병합 뒤 재개.
 *  O1 로그 수집 · O2 실시간 성능(vmseries) · O3 게스트 디스크 · O4 Veeam 계정 이벤트 전용 수집 — 긴급중단 동안에도 vCenter 로 나갔다 → isStopped 로 멈춤.
 *  H  상태: 긴급중단으로 멈춘 폴러는 서비스 점검에서 '주의'(장애)도 '활성'(정상)도 아닌 '긴급중단으로 멈춤'.
 * 외부 호출 0 은 등록한 vCenter 주소(127.0.0.1 의 임시 TCP 서버)로 들어온 연결 수로 판정한다(풀면 연결이 생기는 것까지 본다 — 측정기가 살아 있음).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'decide164-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DB_DIR: TMP, DATA_SOURCE: 'live', SNAPHIST_DB_PATH: path.join(TMP, 'snap-history.db'), VMTRACK_DB_PATH: path.join(TMP, 'vmtrack.db') });
delete process.env.CENTRAL_URL;

// vCenter 자리 — 연결만 세고 바로 끊는다
let conns = 0;
const srv = net.createServer((c) => { conns++; c.destroy(); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
after(() => { srv.close(); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc164', name: 'VC164', host: `https://127.0.0.1:${PORT}`, username: 'u', password: 'p' },
] }));

const ES = await import('../src/security/emergencyStop.js');
const { store } = await import('../src/store.js');
const { pollerCheck } = await import('../src/health/services.js');
const S = await import('../src/metrics/sampler.js');
const P = await import('../src/snaphist/poller.js');
const sdb = await import('../src/snaphist/db.js');
const V = await import('../src/vmtrack/poller.js');
const vdb = await import('../src/vmtrack/db.js');
const L = await import('../src/logs/poller.js');
const VS = await import('../src/vmseries/poller.js');
const GD = await import('../src/guestdisk/poller.js');
const VE = await import('../src/veeam/snapCollector.js');
(await import('../src/vmseries/settings.js')).saveVmSeriesSettings({ enabled: true });   // 기본 꺼짐(opt-in) — 켠 상태에서 판정

const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계(docs/rules/common.md)
const UP = 48 * HOUR;
const stop = () => ES.setEmergencyStop(true, ['a', 'b']);
const release = () => ES.setEmergencyStop(false, ['a', 'b']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vm = (id, o = {}) => ({ id: `vc164:${id}`, vcenterId: 'vc164', name: id, powerState: 'POWERED_ON', template: false, snapshotCount: 1, snapshotSizeGB: 5,
  snapshotOldestTs: NOW - 3 * DAY, snapshotTree: [{ d: 0, name: `s-${id}`, ts: NOW - 3 * DAY }], ...o });
/** 병합이 끝난 스냅샷(만든 시각 = at). */
const setSnap = (at) => {
  store.snapshot = { source: 'live', generatedAt: new Date(at).toISOString(), vcenters: [{ id: 'vc164', name: 'VC164', status: 'connected' }],
    vms: [vm('a'), vm('b')], hosts: [], datastores: [] };
};
const isStopRow = (st) => { const r = pollerCheck(st, { uptimeMs: UP }); return r.status === 'off' && /긴급중단으로 멈춤/.test(r.detail); };

test('S1 snaphist — 긴급중단 중 · 푼 뒤 다음 병합 전에는 하루 기록을 남기지 않고(상태: 긴급중단으로 멈춤) · 병합 뒤 같은 날 기록한다', async () => {
  const d = new Date(NOW); d.setHours(4, 0, 0, 0);
  const T = d.getTime() - 30 * DAY;
  const day = (await import('../src/snaphist/record.js')).dayKeyOf(T);
  setSnap(Date.now() - 60_000);
  stop();
  const r1 = await P.runSnapHistOnce({ now: T });
  assert.equal(r1.idle, 'emergency-stop', JSON.stringify(r1));
  assert.equal((await sdb.okVcentersOfDay(day)).size, 0, '얼어 있는 값을 오늘 기록으로 남기지 않는다');
  assert.ok(isStopRow(P.snapHistPollerStatus()), JSON.stringify(pollerCheck(P.snapHistPollerStatus(), { uptimeMs: UP })));
  const r1f = await P.runSnapHistOnce({ now: T, force: true });
  assert.equal(r1f.idle, 'emergency-stop', '수동(force)도 같다');
  await wait(5);
  release();
  const r2 = await P.runSnapHistOnce({ now: T + 60_000 });
  assert.equal(r2.idle, 'emergency-stop', '푼 직후 — 다음 병합 전 스냅샷은 여전히 얼어 있다(162 N2 와 같은 판정)');
  assert.equal((await sdb.okVcentersOfDay(day)).size, 0);
  setSnap(Date.now() + 5_000);   // 해제 뒤 병합
  const r3 = await P.runSnapHistOnce({ now: T + 120_000 });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.ok((await sdb.okVcentersOfDay(day)).has('vc164'), '병합 뒤 같은 날 기록');
  assert.equal(P.snapHistPollerStatus().emergencyStop, undefined, '재개하면 표지가 지워진다');
});

test('S2 vmtrack — 긴급중단 중 · 푼 뒤 다음 병합 전에는 슬롯을 기록하지 않고(실패 경고 아님) · 병합 뒤 그 슬롯을 채운다', async () => {
  setSnap(Date.now() - 60_000);
  stop();
  const r = await V.runVmtrackNow('manual');
  assert.equal(r.ok, false); assert.equal(r.emergencyStop, true); assert.match(r.reason, /긴급중단/);
  await V.vmtrackTick();
  assert.equal(await vdb.lastSnapshotSlot(), null, '얼어 있는 VM 수를 슬롯 값으로 남기지 않는다');
  const st = V.vmtrackPollerStatus();
  assert.notEqual(st.warn, true, '의도한 정지는 실패(주의)가 아니다');
  assert.ok(isStopRow(st), JSON.stringify(pollerCheck(st, { uptimeMs: UP })));
  await wait(5);
  release();
  await V.vmtrackTick();
  assert.equal(await vdb.lastSnapshotSlot(), null, '푼 직후(다음 병합 전)도 기록하지 않는다');
  setSnap(Date.now() + 5_000);
  await V.vmtrackTick();
  assert.ok(await vdb.lastSnapshotSlot(), '병합 뒤 슬롯을 채운다');
  assert.ok(V.vmtrackPollerStatus().lastResult, '최근 스냅샷이 생겼다');
  assert.equal(V.vmtrackPollerStatus().emergencyStop, undefined);
});

test('O1~O4 — 긴급중단 동안 로그 · 실시간 성능 · 게스트 디스크 · Veeam 전용 수집은 vCenter 로 나가지 않고 상태에 사유를 싣는다 · 풀면 다시 나간다', async () => {
  setSnap(Date.now() + 10_000);
  stop();
  conns = 0;
  const lr = await L.pollLogsOnce();
  assert.equal(lr.emergencyStop, true, JSON.stringify(lr)); assert.equal(lr.collected, 0);
  const lr2 = await L.pollLogsOnce({ manual: true });
  assert.equal(lr2.emergencyStop, true, '수동도 같다(주 폴러의 지금 수집도 멈춘다)');
  const vr = await VS.runVmSeriesNow('manual');
  assert.equal(vr.emergencyStop, true, JSON.stringify(vr));
  const gr = await GD.runGuestDiskNow('manual');
  assert.equal(gr.emergencyStop, true, JSON.stringify(gr));
  const er = await VE.pollVeeamSnapOnce();
  assert.equal(er.emergencyStop, true, JSON.stringify(er));
  await wait(200);
  assert.equal(conns, 0, '긴급중단 동안 vCenter 연결 0');
  for (const [name, st] of [['logs', await L.logStatus()], ['vmseries', VS.vmSeriesPollerStatus()], ['guestdisk', GD.guestDiskPollerStatus()], ['veeam', VE.veeamSnapCollectorStatus()]]) {
    assert.ok(isStopRow(st), `${name}: ${JSON.stringify(pollerCheck(st, { uptimeMs: UP }))}`);
  }
  release();
  const lr3 = await L.pollLogsOnce({ manual: true });
  assert.notEqual(lr3.emergencyStop, true, JSON.stringify(lr3).slice(0, 300));
  const vr3 = await VS.runVmSeriesNow('manual');
  assert.notEqual(vr3.emergencyStop, true);
  assert.equal(VS.vmSeriesPollerStatus().emergencyStop, undefined, '다시 돌면 표지가 지워진다');
  const gr3 = await GD.runGuestDiskNow('manual');
  assert.notEqual(gr3.emergencyStop, true);
  assert.equal(GD.guestDiskPollerStatus().emergencyStop, undefined);
  await wait(300);
  assert.ok(conns > 0, `풀면 다시 vCenter 로 나간다(측정기가 살아 있음) — 연결 ${conns}`);
});

test('H — 서비스 점검 판정: 긴급중단 표지가 있으면 off + 의도한 정지 문구 · 없으면 예전 그대로', () => {
  const now = NOW;
  assert.equal(pollerCheck({ lastRun: { at: now - 1000 }, intervalMs: 60_000 }, { now, uptimeMs: UP }).status, 'ok');
  assert.equal(pollerCheck({ lastRun: { at: now - 3 * HOUR }, intervalMs: 60_000 }, { now, uptimeMs: UP }).status, 'warn');
  for (const st of [{ emergencyStop: true }, { lastRun: { at: now - 3 * HOUR, emergencyStop: true } }, { lastResult: { at: now, emergencyStop: true } }]) {
    const r = pollerCheck(st, { now, uptimeMs: UP });
    assert.equal(r.status, 'off', JSON.stringify(st));
    assert.match(r.detail, /긴급중단으로 멈춤 — 의도한 정지/);
  }
  assert.equal(pollerCheck({ enabled: false, emergencyStop: true }, { now, uptimeMs: UP }).detail, '비활성(설정에서 꺼짐)', '꺼짐이 먼저');
});

test('공용 판정 — snapshotFrozenByStop 은 samplingUnreadReasons 와 같은 답(사본 없음)', () => {
  const snap = { generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'x', status: 'connected' }, { id: 'y', status: 'maintenance' }] };
  for (const o of [{ stopped: true }, { stopped: false, frozenBefore: NOW + 1 }, { stopped: false, frozenBefore: NOW - 1 }, { stopped: false, frozenBefore: 0 }]) {
    const want = [...S.samplingUnreadReasons(snap, o).values()].includes('stopped');
    assert.equal(want, o.stopped === true || o.frozenBefore === NOW + 1);
  }
  const src = fs.readFileSync(new URL('../src/metrics/sampler.js', import.meta.url), 'utf8');
  assert.match(src, /export function snapshotFrozenByStop\(snap\) \{\n\s*for \(const r of samplingUnreadReasons\(snap\)\.values\(\)\)/, '판정은 samplingUnreadReasons 하나');
  for (const f of ['snaphist/poller.js', 'vmtrack/poller.js']) {
    assert.match(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /from '\.\.\/metrics\/sampler\.js'/, f);
  }
});
