/**
 * 검토 I-03(v2.730) — OneFS(Isilon) 영역 수집이 **영역 중간에서** 멈춰도 그 영역이 초록 '정상' 이 되던 결함.
 *
 * 실제 수집 함수(storage/areasCollector.js collectAreasOnce)를 실제 카탈로그·실제 DB 저장 경로로 돌리고,
 * 장비 쪽만 가짜 클라이언트(`get` 주입)로 바꾼다. 첫 영역 'cluster' 는 카탈로그상 엔드포인트가 3개다.
 *  ① 첫째만 성공한 뒤 시한(signal abort) → cluster 는 부분 수집(1/3 · 미시도 2) · 이후 영역은 미시도
 *  ② 둘째 요청 도중 시한 → 끊긴 요청은 failed 가 아니라 미시도
 *  ③ 첫 요청 전 시한 → cluster 도 '부분' 이 아니라 미시도(예전: {ok:0, failed:0} → 초록)
 *  ④ 401 뒤 중단 → 같은 기준(부분·인증 사유) + 그 뒤로 로그인 시도 0
 *  ⑤ 연속 전송 오류 → 멈춘 영역 · 이후 영역 일관
 *  ⑥ 전부 성공 → partial 0 · 미시도 0
 *  ⑦ 중단 전 읽은 값은 DB 에 저장된다
 *  ⑧ 데모(mock) 합성이 같은 모양을 내고, 폴러가 그 필드를 스냅샷 extra 에 싣는다(실제 collectDeviceNow)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rvC-onefs-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { collectAreasOnce } = await import('../src/storage/areasCollector.js');
const cat = await import('../src/storage/onefsCatalog.js');
const db = await import('../src/storage/db.js');

const ENABLED = cat.enabledAreas();
const TOTAL_EP = ENABLED.reduce((n, a) => n + a.endpoints.length, 0);
const CLUSTER = ENABLED[0];
assert.equal(CLUSTER.key, 'cluster');
assert.equal(CLUSTER.endpoints.length, 3, '전제: cluster 영역 엔드포인트 3개');

const DEV = (id) => ({ id, host: '10.9.9.9', username: 'u', password: 'p' });
const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

/** 호출 순번(0부터)마다 동작을 정하는 가짜 클라이언트. 기본은 성공. */
function fakeGet(plan) {
  const calls = [];
  const fn = async (dev, ep, { signal } = {}) => {
    const i = calls.length; calls.push(ep);
    const act = plan(i, ep, signal);
    if (act instanceof Error) throw act;
    if (typeof act === 'function') return act();
    return { ep, n: i };
  };
  fn.calls = calls;
  return fn;
}

const byArea = (r) => Object.fromEntries(r.summary.map((a) => [a.area, a]));

test('① 첫째 엔드포인트만 성공한 뒤 시한 → cluster 는 부분 수집, 이후 영역은 미시도', async () => {
  const ac = new AbortController();
  const get = fakeGet((i) => (i === 0 ? () => { ac.abort(); return { ok: 1 }; } : abortErr()));
  const r = await collectAreasOnce(DEV('isiC1'), { signal: ac.signal, get });
  const a = byArea(r);
  assert.equal(r.stopped, 'deadline');
  assert.equal(get.calls.length, 1, '시한 뒤 요청을 더 보내지 않는다');
  assert.deepEqual(
    { ok: a.cluster.ok, failed: a.cluster.failed, expectedEndpoints: a.cluster.expectedEndpoints, attempted: a.cluster.attempted,
      notTriedEndpoints: a.cluster.notTriedEndpoints, partial: a.cluster.partial, stopReason: a.cluster.stopReason },
    { ok: 1, failed: 0, expectedEndpoints: 3, attempted: 1, notTriedEndpoints: 2, partial: true, stopReason: 'deadline' },
  );
  assert.ok(!a.cluster.notTried && !a.cluster.skipped, '시도한 영역은 미시도가 아니다');
  const rest = ENABLED.slice(1).map((x) => a[x.key]);
  assert.ok(rest.every((x) => x.notTried === true && x.skipped === true && x.attempted === 0 && x.partial === false && x.stopReason === 'deadline'));
  assert.ok(rest.every((x, k) => x.expectedEndpoints === ENABLED[k + 1].endpoints.length && x.notTriedEndpoints === x.expectedEndpoints));
  assert.equal(r.notTried, ENABLED.length - 1, 'notTried 는 예전처럼 영역 개수');
  assert.equal(r.notTriedEndpoints, TOTAL_EP - 1, '엔드포인트 단위 미시도는 새 필드');
  assert.equal(r.partialAreas, 1);
  assert.equal(r.expectedEndpoints, TOTAL_EP);
  assert.equal(r.endpoints, 1);
});

test('② 둘째 요청 도중 시한 → 끊긴 요청은 failed 가 아니라 미시도', async () => {
  const ac = new AbortController();
  const get = fakeGet((i) => (i === 0 ? { ok: 1 } : (ac.abort(), abortErr())));
  const r = await collectAreasOnce(DEV('isiC2'), { signal: ac.signal, get });
  const c = byArea(r).cluster;
  assert.equal(r.stopped, 'deadline');
  assert.equal(c.failed, 0, '우리가 끊은 요청을 장비 실패로 세지 않는다');
  assert.equal(c.attempted, 1);
  assert.equal(c.notTriedEndpoints, 2);
  assert.equal(c.partial, true);
  assert.equal(c.error, undefined, '장비 오류가 없었으므로 error 문구를 지어내지 않는다');
});

test('③ 첫 요청 전 시한 → cluster 도 미시도(예전: {ok:0, failed:0} 초록)', async () => {
  const ac = new AbortController(); ac.abort();
  const get = fakeGet(() => ({ ok: 1 }));
  const r = await collectAreasOnce(DEV('isiC3'), { signal: ac.signal, get });
  const c = byArea(r).cluster;
  assert.equal(get.calls.length, 0);
  assert.equal(r.stopped, 'deadline');
  assert.equal(c.notTried, true);
  assert.equal(c.attempted, 0);
  assert.equal(c.notTriedEndpoints, 3);
  assert.equal(c.partial, false);
  assert.equal(r.notTried, ENABLED.length, '모든 영역이 미시도(영역 개수)');
  assert.equal(r.notTriedEndpoints, TOTAL_EP);
  assert.equal(r.partialAreas, 0);
  assert.equal(r.endpoints, 0);
});

test('④ 401 뒤 중단 → 부분 수집 · 인증 사유 · 그 뒤 로그인 시도 0', async () => {
  const get = fakeGet((i) => (i === 0 ? { ok: 1 } : new Error('인증 실패(401) — 계정/비밀번호 확인')));
  const r = await collectAreasOnce(DEV('isiC4'), { get });
  const a = byArea(r);
  assert.equal(r.stopped, 'auth');
  assert.equal(r.authDead, true);
  assert.equal(get.calls.length, 2, '401 뒤로 같은 계정 요청을 보내지 않는다');
  assert.equal(a.cluster.ok, 1); assert.equal(a.cluster.failed, 1);
  assert.equal(a.cluster.attempted, 2); assert.equal(a.cluster.notTriedEndpoints, 1);
  assert.equal(a.cluster.partial, true); assert.equal(a.cluster.stopReason, 'auth');
  assert.match(a.cluster.error, /401/);
  assert.equal(a.node.notTried, true); assert.equal(a.node.stopReason, 'auth');
  assert.equal(r.notTried, ENABLED.length - 1);
  assert.equal(r.notTriedEndpoints, TOTAL_EP - 2);
});

test('⑤ 연속 전송 오류 → 멈춘 영역(filesystem 1/2 시도)과 이후 영역이 일관된다', async () => {
  // cluster·node·hardware 성공, capacity 1 성공 + 2 실패(전송), filesystem 1 실패(전송) → 연속 3회 → 멈춤
  const order = ENABLED.flatMap((x) => x.endpoints.map((ep) => ({ area: x.key, ep })));
  const capIdx = order.findIndex((o) => o.area === 'capacity');
  const fsIdx = order.findIndex((o) => o.area === 'filesystem');
  assert.equal(fsIdx - capIdx, 3, '전제: capacity 엔드포인트 3개');
  const transport = () => new Error('연결 거부 — 10.9.9.9:8080 에 연결할 수 없습니다');
  const get = fakeGet((i) => (i < capIdx + 1 ? { ok: 1 } : transport()));
  const r = await collectAreasOnce(DEV('isiC5'), { get });
  const a = byArea(r);
  assert.equal(r.stopped, 'transport');
  assert.equal(get.calls.length, capIdx + 4);
  assert.deepEqual({ ok: a.capacity.ok, failed: a.capacity.failed, left: a.capacity.notTriedEndpoints, partial: a.capacity.partial, sr: a.capacity.stopReason },
    { ok: 1, failed: 2, left: 0, partial: false, sr: undefined }, '끝까지 시도한 영역은 부분이 아니다');
  assert.deepEqual({ ok: a.filesystem.ok, failed: a.filesystem.failed, attempted: a.filesystem.attempted, left: a.filesystem.notTriedEndpoints, partial: a.filesystem.partial, sr: a.filesystem.stopReason },
    { ok: 0, failed: 1, attempted: 1, left: 1, partial: true, sr: 'transport' });
  assert.equal(a.quota.notTried, true); assert.equal(a.quota.stopReason, 'transport');
  assert.equal(a.cluster.partial, false); assert.equal(a.cluster.notTriedEndpoints, 0);
});

test('⑥ 전부 성공 → 멈춤 없음 · 부분 0 · 미시도 0', async () => {
  const get = fakeGet(() => ({ ok: 1 }));
  const r = await collectAreasOnce(DEV('isiC6'), { get });
  assert.equal(r.stopped, null);
  assert.equal(r.partialAreas, 0); assert.equal(r.notTried, 0); assert.equal(r.notTriedEndpoints, 0);
  assert.equal(r.endpoints, TOTAL_EP); assert.equal(r.expectedEndpoints, TOTAL_EP);
  for (const x of r.summary.filter((s) => !s.skipped)) {
    assert.equal(x.partial, false); assert.equal(x.attempted, x.expectedEndpoints); assert.equal(x.failed, 0);
  }
  const off = r.summary.filter((s) => s.skipped);
  assert.ok(off.length > 0 && off.every((s) => !s.notTried && s.error), '비활성 영역은 사유와 함께(미시도와 구분)');
});

test('⑦ 중단 전 읽은 값은 DB 에 저장된다(원문 보기) — 판정 근거와는 별개', async () => {
  const row = await db.areaJson('isiC1', CLUSTER.endpoints[0]);
  assert.ok(row, '첫 엔드포인트 원문이 저장돼 있어야 한다');
  assert.equal(row.ok, 1);
  assert.equal(await db.areaJson('isiC1', CLUSTER.endpoints[1]), null, '시도하지 않은 엔드포인트는 행이 없다');
});

test('⑧ 데모 합성은 같은 모양이고, 폴러가 extra 에 새 필드를 싣는다(실제 collectDeviceNow)', async () => {
  const demo = await import('../src/mock/demo/storage.js');
  const reg = await import('../src/storage/registry.js');
  const store = await import('../src/storage/store.js');
  const poller = await import('../src/storage/poller.js');
  const off = cat.ONEFS_AREAS.filter((a) => a.enabled === false);
  // 완료 장비: 모든 영역이 예정 = 시도
  const full = demo.demoIsilonAreas({ id: 'mock-st-ps-sel-01', type: 'isilon' }, ENABLED, off);
  assert.equal(full.stopped ?? null, null);
  for (const s of full.summary.filter((x) => !x.skipped)) {
    assert.equal(s.attempted, s.ok + s.failed); assert.equal(s.expectedEndpoints, s.attempted); assert.equal(s.partial, false);
  }
  // 부분 장비(데모 사양 areasStop): 실제 수집기와 같은 규칙으로 멈춘다
  const part = demo.demoIsilonAreas({ id: 'mock-st-ps-ash-01', type: 'isilon' }, ENABLED, off);
  assert.equal(part.stopped, 'deadline');
  assert.equal(part.partialAreas, 1);
  const pa = part.summary.find((x) => x.partial);
  assert.ok(pa && pa.ok > 0 && pa.notTriedEndpoints > 0 && pa.stopReason === 'deadline');
  assert.ok(part.summary.filter((x) => x.notTried).length === part.notTried && part.notTried > 0);
  assert.equal(part.results.length, part.endpoints);
  // 폴러 배선: 등록 → 즉시 수집 → 스냅샷 extra
  reg.seedDevicesIfEmpty(demo.demoStorageDevices().filter((d) => /ps-(ash|sel)-01$/.test(d.id)));
  assert.equal(await poller.collectDeviceNow('mock-st-ps-ash-01'), true);
  assert.equal(await poller.collectDeviceNow('mock-st-ps-sel-01'), true);
  const snaps = Object.fromEntries(store.localSnapshots().map((s) => [s.deviceId || s.id, s]));
  const ex = snaps['mock-st-ps-ash-01']?.extra;
  assert.ok(ex?.areas, '영역 요약이 실렸다');
  assert.equal(ex.areasStopped, 'deadline');
  assert.equal(ex.areasPartial, 1);
  assert.equal(ex.areasNotTriedEndpoints, part.notTriedEndpoints);
  assert.equal(ex.areasExpectedEndpoints, TOTAL_EP);
  assert.equal(ex.areasNotTried, part.notTried, '영역 개수 단위 그대로');
  const ex2 = snaps['mock-st-ps-sel-01']?.extra;
  assert.equal(ex2.areasStopped, undefined);
  assert.equal(ex2.areasExpectedEndpoints, TOTAL_EP);
  assert.equal(ex2.areasEndpoints, TOTAL_EP);
});

test('⑨ 서버가 낸 요약을 화면 판정에 넣으면 — 전체 성공만 초록, 부분·미시도는 초록이 아니다(웹 onefsAreaState 와 짝)', async () => {
  const web = await import('../../web/src/views/tools/onefsAreaState.js');
  const { AREA_STOP_REASONS } = await import('../src/storage/onefsAreaSummary.js');
  assert.deepEqual(Object.keys(web.STOP_CAUSE).sort(), [...AREA_STOP_REASONS].sort(), '멈춘 사유 코드 ↔ 화면 문구 1:1');
  const { areasExtraFields } = await import('../src/storage/onefsAreaSummary.js');
  // 첫째만 성공 뒤 시한
  let ac = new AbortController();
  let r = await collectAreasOnce(DEV('isiC9a'), { signal: ac.signal, get: fakeGet((i) => (i === 0 ? () => { ac.abort(); return {}; } : abortErr())) });
  let st = web.areaStates(areasExtraFields(r));
  assert.equal(st[0].kind, web.AREA_KIND.PARTIAL);
  assert.equal(st[0].tone, 'amber');
  assert.ok(st.every((s) => s.tone !== 'green'), '멈춘 수집에서 초록 영역이 없다(이 경우 첫 영역에서 멈췄다)');
  // 첫 요청 전 시한
  ac = new AbortController(); ac.abort();
  r = await collectAreasOnce(DEV('isiC9b'), { signal: ac.signal, get: fakeGet(() => ({})) });
  st = web.areaStates(areasExtraFields(r));
  assert.ok(st.filter((s) => s.kind !== web.AREA_KIND.DISABLED).every((s) => s.kind === web.AREA_KIND.NOT_TRIED));
  // 전부 성공
  r = await collectAreasOnce(DEV('isiC9c'), { get: fakeGet(() => ({})) });
  st = web.areaStates(areasExtraFields(r));
  assert.ok(st.filter((s) => s.kind !== web.AREA_KIND.DISABLED).every((s) => s.tone === 'green'));
  assert.equal(web.areasStopNoteFull(areasExtraFields(r)), null);
});
