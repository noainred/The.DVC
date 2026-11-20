/**
 * test/staleSnapshotSweep126.test.js — 전체 점검 126회차 공통 스윕: '수집이 멈춘 vCenter 의 마지막 값을 지금 값처럼 쓰는 소비처'.
 *
 * store.js 는 수집이 멈춘 vCenter 의 **마지막으로 읽은 인벤토리**를 계속 서빙한다 — 수집 실패는 최대 LASTGOOD_HOLD_MS, 점검중(maintenance) ·
 * 위임(엣지) push 끊김은 기한 없이. 그 사실은 스냅샷의 vCenter 상태 · stale 표지에만 있다(공용 판정 metrics/unreadVcenters.js).
 * 122회차 R3 이 /metrics 한 곳을 고쳤고, 이 파일은 나머지 소비처를 고정한다.
 *
 *  F1(재현 · 알림) 오버커밋 알림(ramoc: · vcpuoc:)은 vCenter 를 못 읽는 동안 판정하지 않는다 — 예전에는 인벤토리가 비면(보존 창 초과 · 비활성 ·
 *     캐시 없는 점검중) 발생 중이던 알림이 '해소' 로 나갔고, 낡은 위임 · 점검중 · 수집 실패 이월의 마지막 인벤토리로 새로 내고 쿨다운마다 재발송했다.
 *  F2(재현 · 알림 — 결정) 경보 · 호스트 · DS 알림의 신규 억제는 stale(낡은 위임)만이 아니라 공용 판정의 세 사유 전부(점검중 · 수집 실패 이월 포함).
 *  F3(재현 · 자동 동작) Bareos 복원 검증(정기)은 수집이 멈춘 vCenter 의 옛 데이터스토어 여유 · VM 목록으로 복원을 보내지 않는다.
 *  F4(재현 · 외부 제공) 공개 API: 점검중 vCenter 행은 stale:true · collectedAt 은 스냅샷 시각(지금)이 아니라 모르면 null,
 *     용량 · 경보 · 합계 응답의 meta 가 '지금 값이 아닌 vCenter' 를 밝힌다(notCurrentVcenters · notCurrentVcenterIds).
 *  F5(재현 · 판정) 서비스 점검 ‘vCenter 수집’ 은 엣지 보고가 끊긴 위임 vCenter(status 는 connected 그대로)를 연결로 세지 않는다.
 *  스윕  스냅샷에서 사용률 · 용량 · 상태를 읽는 모듈은 아래 분류표에 있어야 한다(새 소비처는 멈춘 vCenter 를 어떻게 다루는지 먼저 답할 것).
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stale126-'));
const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0' });

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');
const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');
const RH = await import('../src/bareos/rehearsal.js');
const registry = await import('../src/bareos/registry.js');
const pub = await import('../src/routes/publicApi.js');
const keys = await import('../src/publicapi/keys.js');
const express = (await import('express')).default;
const { stripComments } = await import('./_stripComments.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분 고정
alerts._setProcessStartForTest(NOW - 2 * HOUR);

let srv = null;
after(() => { try { srv?.close(); } catch { /* */ } rmTmp(); process.once('exit', rmTmp); });

/* ── 스냅샷 조각 ─────────────────────────────────────────────────────────── */
// 수집이 멈춘 vCenter 의 세 모양(store.js 병합이 만드는 항목 그대로) + 정상
const VC = {
  ok: (id = 'vc1') => ({ id, name: id, status: 'connected' }),
  maintenance: (id = 'vc1') => ({ id, name: id, status: 'maintenance', maintenance: true }),                                  // 직전 캐시를 기한 없이
  lastGood: (id = 'vc1') => ({ id, name: id, status: 'unreachable', stale: true, staleSince: NOW - HOUR, error: 'timeout' }),   // 수집 실패 이월(최대 6시간)
  siteStale: (id = 'vc1') => ({ id, name: id, status: 'connected', collectSource: 'site', collectedBy: 'edge1', stale: true, receivedAt: NOW - 3 * HOUR }),   // 엣지 보고 끊김
  emptyDown: (id = 'vc1') => ({ id, name: id, status: 'unreachable', error: 'timeout' }),                                     // 보존 창 초과 — 인벤토리 비움
};
const host = { id: 'h1', name: 'esx1', vcenterId: 'vc1', cluster: 'cl1', connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 20000, memTotalMB: 102400 };
const hostDown = { id: 'h2', name: 'esx2', vcenterId: 'vc1', cluster: 'cl2', connectionState: 'DISCONNECTED' };
const vms = Array.from({ length: 10 }, (_, i) => ({ id: `vm${i}`, vcenterId: 'vc1', cluster: 'cl1', powerState: 'POWERED_ON', cpuCount: 8, memMB: 20480 }));   // vCPU 80/10코어 · RAM 200/100GB
const ds = (pct = 92) => ({ id: 'ds1', vcenterId: 'vc1', name: 'ds1', usagePct: pct, freeGB: 80, capacityGB: 1000, usedGB: 920 });
const alarm = { id: 'a1', name: 'HA down', severity: 'critical', vcenterId: 'vc1', entity: 'cl1' };
const INV = { hosts: [host, hostDown], vms, datastores: [ds()], alarms: [alarm] };
const EMPTY = { hosts: [], vms: [], datastores: [], alarms: [] };

const CFG = {
  cooldownMin: 60,
  rules: { criticalAlarms: { enabled: true }, vcenterDown: { enabled: true }, hostDisconnected: { enabled: true }, datastorePct: { enabled: true, threshold: 90 },
    ramOvercommitPct: { enabled: true, threshold: 120 }, vcpuPerCore: { enabled: true, threshold: 5 } },
};
const keysOf = (snap, cfg = CFG) => alerts.evaluate(snap, cfg).map((a) => a.key).sort();
async function runWith(snap, cfg = CFG) {
  const orig = store.get;
  store.get = () => snap;
  try { await alerts._refreshStateForTest(cfg, false); } finally { store.get = orig; }
  return alerts.alertStatus();
}
const firingKeys = (st) => st.firing.map((f) => f.key).sort();
const resolvedKeys = (st) => [...new Set(st.recent.filter((r) => r.severity === 'resolved').map((r) => r.key))].sort();
const ALL5 = ['alarm:a1', 'ds:ds1', 'host:h2', 'ramoc:vc1:cl1', 'vcpuoc:vc1:cl1'];

/* ── F1 · F2 알림 ────────────────────────────────────────────────────────── */
test('F1 · F2 ① 수집이 멈춘 vCenter 의 마지막 값으로 경보 · 호스트 · DS · 오버커밋 알림을 새로 내지 않는다(세 사유 전부)', () => {
  assert.deepEqual(keysOf({ vcenters: [VC.ok()], ...INV }), ALL5, '정상 수집이면 다섯 알림이 모두 난다(픽스처 확인)');
  // 점검중: 직전 캐시가 기한 없이 실린다 — 예전에는 다섯 알림이 그대로 목록에 남아 쿨다운마다 재발송됐다
  assert.deepEqual(keysOf({ vcenters: [VC.maintenance()], ...INV }), []);
  // 수집 실패 이월(LASTGOOD): vc:(수집 실패)만 — 그 vCenter 의 옛 값 알림은 내지 않는다
  assert.deepEqual(keysOf({ vcenters: [VC.lastGood()], ...INV }), ['vc:vc1']);
  // 낡은 위임: v2.768 이 alarm/host/ds 는 막았지만 오버커밋(ramoc · vcpuoc)은 그대로 났다
  assert.deepEqual(keysOf({ vcenters: [VC.siteStale()], ...INV }), ['vcstale:vc1']);
  // 다른 vCenter 의 알림은 그대로다(한 곳이 멈췄다고 전체를 막지 않는다)
  const other = { ...host, id: 'h9', vcenterId: 'vc2' };
  const otherVms = vms.map((v) => ({ ...v, id: `o-${v.id}`, vcenterId: 'vc2' }));
  const mixed = keysOf({ vcenters: [VC.maintenance(), VC.ok('vc2')], hosts: [host, other], vms: [...vms, ...otherVms], datastores: [ds(), { ...ds(95), id: 'ds2', vcenterId: 'vc2' }], alarms: [alarm] });
  assert.deepEqual(mixed, ['ds:ds2', 'ramoc:vc2:cl1', 'vcpuoc:vc2:cl1']);
});

test('F1 ② 인벤토리가 비어 클러스터가 사라져도 오버커밋 알림을 해소로 기록하지 않는다(모름 ≠ 복구) · 다시 읽히면 그때 판정', async () => {
  for (const down of [VC.emptyDown(), { id: 'vc1', name: 'vc1', status: 'disabled' }, { id: 'vc1', name: 'vc1', status: 'maintenance', maintenance: true }, { id: 'vc1', name: 'vc1', status: 'pending' }]) {
    alerts._resetAlertStateForTest();
    let st = await runWith({ vcenters: [VC.ok()], ...INV });
    assert.deepEqual(firingKeys(st), ALL5);
    const before = resolvedKeys(st).length;
    st = await runWith({ vcenters: [down], ...EMPTY });
    assert.equal(resolvedKeys(st).length, before, `${down.status}: 못 읽은 vCenter 의 알림을 해소로 기록하면 안 된다 — ${resolvedKeys(st).join(', ')}`);
    for (const k of ['ramoc:vc1:cl1', 'vcpuoc:vc1:cl1']) assert.ok(firingKeys(st).includes(k), `${down.status}: ${k} 는 발생 상태 유지(보류)`);
  }
  // 실제로 복구됐다(다시 읽었고 임계 아래) — 그때 해소한다
  alerts._resetAlertStateForTest();
  await runWith({ vcenters: [VC.ok()], ...INV });
  await runWith({ vcenters: [VC.emptyDown()], ...EMPTY });
  const st = await runWith({ vcenters: [VC.ok()], hosts: [host], vms: vms.slice(0, 2), datastores: [ds(50)], alarms: [] });
  for (const k of ALL5) assert.ok(resolvedKeys(st).includes(k), `${k} 는 다시 읽은 뒤 해소`);
  assert.equal(st.firing.length, 0);
});

test('F1 ③ 오버커밋 보류는 그 vCenter 의 키에만 걸리고 규칙이 꺼져 있으면 걸지 않는다 · 보류에는 시한(HELD_MAX_MS)', async () => {
  const out = alerts.evaluate({ vcenters: [VC.maintenance(), VC.ok('vc2')], ...INV }, CFG);
  assert.deepEqual([...out.heldPrefixes].sort(), ['ramoc:vc1:', 'vcpuoc:vc1:']);
  const off = alerts.evaluate({ vcenters: [VC.maintenance()], ...INV }, { ...CFG, rules: { ...CFG.rules, vcpuPerCore: { enabled: false } } });
  assert.deepEqual([...off.heldPrefixes], ['ramoc:vc1:'], '꺼진 규칙의 알림은 보류하지 않는다(끄면 정리된다)');
  // 정상 스냅샷에는 접두 보류가 없다
  assert.equal(alerts.evaluate({ vcenters: [VC.ok()], ...INV }, CFG).heldPrefixes.size, 0);
  // 시한: 6시간 넘게 못 읽으면 해소 알림 없이 끊는다(v2.598 규약 그대로)
  alerts._resetAlertStateForTest();
  await runWith({ vcenters: [VC.ok()], ...INV });
  const realNow = Date.now;
  // 최근 통지 목록은 앞 시험의 기록을 이어 갖는다 — 해소 기록 '수' 로 비교한다
  const ocResolved = (st) => st.recent.filter((r) => r.severity === 'resolved' && /^(ramoc|vcpuoc):/.test(r.key)).length;
  try {
    const before = ocResolved(await runWith({ vcenters: [VC.emptyDown()], ...EMPTY }));
    Date.now = () => realNow() + alerts.HELD_MAX_MS + 60_000;
    const st = await runWith({ vcenters: [VC.emptyDown()], ...EMPTY });
    assert.ok(!firingKeys(st).some((k) => /^(ramoc|vcpuoc):/.test(k)), '시한을 넘긴 보류는 끊는다');
    assert.equal(ocResolved(st), before, '끊을 때도 해소로 기록하지 않는다');
  } finally { Date.now = realNow; }
});

test('F2 ② 발생 중이던 경보 · 호스트 · DS 알림은 점검중 · 수집 실패 이월 동안 재발송도 해소도 하지 않고, 다시 읽히면 그때 판정한다', async () => {
  for (const frozen of [VC.maintenance(), VC.lastGood()]) {
    alerts._resetAlertStateForTest();
    let st = await runWith({ vcenters: [VC.ok()], ...INV });
    assert.deepEqual(firingKeys(st), ALL5);
    const before = resolvedKeys(st).length;
    // 수집이 멈췄다 — store 는 마지막 인벤토리를 그대로 싣는다
    st = await runWith({ vcenters: [frozen], ...INV });
    assert.equal(resolvedKeys(st).length, before, `${frozen.status}: 모름을 복구로 기록하면 안 된다`);
    for (const k of ALL5) assert.ok(firingKeys(st).includes(k), `${frozen.status}: ${k} 는 발생 상태 유지`);
    // 발송 루프는 평가 목록을 돈다 — 목록에 없으면 쿨다운이 지나도 재발송하지 않는다
    assert.ok(!alerts.evaluate({ vcenters: [frozen], ...INV }, CFG).some((a) => /^(alarm|host|ds|ramoc|vcpuoc):/.test(a.key)), `${frozen.status}: 옛 값 알림이 평가 목록에 남으면 쿨다운마다 재발송된다`);
    // 다시 읽었고 실제로 복구됐다
    st = await runWith({ vcenters: [VC.ok()], hosts: [host], vms: vms.slice(0, 2), datastores: [ds(50)], alarms: [] });
    for (const k of ALL5) assert.ok(resolvedKeys(st).includes(k), `${frozen.status}: ${k} 는 다시 읽은 뒤 해소`);
  }
});

test('F2 ③ 신규 억제 판정은 공용 판정 한 벌이다(상태 목록 사본 없음)', () => {
  const src = stripComments(fs.readFileSync(fileURLToPath(new URL('../src/alerts.js', import.meta.url)), 'utf8'));
  assert.match(src, /const fresh = \(x\) => !reasons\.has\(/, 'fresh 는 unreadVcenterReasons 결과(reasons)로 판정한다');
  assert.match(src, /const reasons = unreadVcenterReasons\(snap\)/);
  const r = unreadVcenterReasons({ vcenters: [VC.ok('a'), VC.maintenance('b'), VC.lastGood('c'), VC.siteStale('d'), VC.emptyDown('e'), { id: 'f', status: 'pending' }] });
  assert.deepEqual(Object.fromEntries(r), { b: 'maintenance', c: 'unreachable', d: 'stale', e: 'unreachable' });
});

/* ── F3 Bareos 복원 검증 ─────────────────────────────────────────────────── */
const J = (id, vc, vm, name, dir) => ({ id, vcenterId: vc, vmId: `${vc}:${vm}`, vmName: name, dc: 'DC', folder: '/', directorId: dir, bareosJob: `pv-${id}`, enabled: true, lastRun: { jobid: 10, state: 'ok' }, restores: [] });
const seedJobs = (jobs) => { fs.writeFileSync(path.join(TMP, registry.FILE_NAME), JSON.stringify({ version: 1, jobs, retired: [] })); registry._resetForTest(); };
const BVM = (vc, vm, name, gb, dsName) => ({ id: `${vc}:${vm}`, vcenterId: vc, name, storageGB: gb, vcDcPath: 'DC', folderPath: '/', dev: { disks: [{ datastore: dsName }] } });

test('F3 복원 검증(정기)은 수집이 멈춘 vCenter 의 옛 여유 · VM 목록으로 복원을 보내지 않는다 · 정상 vCenter 는 그대로', async () => {
  const snapOf = (vc) => ({ generatedAt: Date.now(), vcenters: [vc], hosts: [],
    datastores: [{ vcenterId: 'vc-a', name: 'roomy', freeGB: 5000, capacityGB: 8000 }], vms: [BVM('vc-a', 'vm-2', 'bbb-ok', 20, 'roomy')] });
  let dirN = 0;
  const run = async (vc) => {
    const dir = `DS${dirN += 1}`;
    RH._resetRehearsalForTest();
    RH.savePolicy({ enabled: false, weekday: 6, time: '03:17', perCorp: 1 }, { by: 't' });
    store.snapshot = snapOf(vc);
    seedJobs([J(`b${dirN}`, 'vc-a', 'vm-2', 'bbb-ok', dir)]);
    const r = await RH.runRehearsal(dir);
    return { r, item: r.items.find((x) => x.jobId === `b${dirN}`), job: registry.getJob(`b${dirN}`) };
  };
  // 정상: 판정을 지나 보내기 단계까지 간다(데모 Director 는 이 가짜 jobid 를 모른다 — 고르기 결과만 본다)
  const ok = await run({ id: 'vc-a', name: 'A', status: 'connected' });
  assert.doesNotMatch(ok.item?.reason || '', /건너뛰었습니다/, '정상 vCenter 는 예전과 같다');
  // 수집이 멈춘 세 모양 — 여유 5,000GB 는 마지막으로 읽은 값이다
  const cases = [
    [{ id: 'vc-a', name: 'A', status: 'unreachable', stale: true, staleSince: NOW - HOUR }, /연결 실패/],
    [{ id: 'vc-a', name: 'A', status: 'connected', collectSource: 'site', stale: true, receivedAt: NOW - 72 * HOUR }, /보고 낡음/],
    [{ id: 'vc-a', name: 'A', status: 'maintenance', maintenance: true }, /점검중/],
  ];
  for (const [vc, why] of cases) {
    const x = await run(vc);
    assert.equal(x.r.started, 0, `${vc.status}: 보내지 않는다`);
    assert.match(x.item.reason, /수집이 멈춰/, `${vc.status}: 사유를 밝힌다 — ${x.item.reason}`);
    assert.match(x.item.reason, why);
    assert.equal(x.job.restores.length, 0, `${vc.status}: Director 에 보내지 않았다(원장에 복원 없음)`);
  }
});

/* ── F4 공개 API ─────────────────────────────────────────────────────────── */
test('F4 ① 점검중 vCenter 의 collectedAt 은 스냅샷 시각(지금)이 아니다 — 모르면 null · 이월 중 점검중이면 그 정상 수집 시각', () => {
  const snap = { generatedAt: new Date(NOW).toISOString() };
  assert.equal(pub.vcCollectedAtOf({ id: 'm', status: 'maintenance', maintenance: true }, snap), null, '직전 캐시의 수집 시각은 스냅샷에 없다 — 지어내지 않는다');
  assert.equal(pub.vcCollectedAtOf({ id: 'm', status: 'maintenance', maintenance: true, stale: true, staleSince: NOW - 2 * HOUR }, snap), NOW - 2 * HOUR);
  // 엣지가 점검중으로 보낸 위임 vCenter: 받은 시각이 새로워도 값은 얼어 있다
  assert.equal(pub.vcCollectedAtOf({ id: 'm', status: 'maintenance', maintenance: true, collectSource: 'site', receivedAt: NOW }, snap), null);
  assert.equal(pub.vcCollectedAtOf({ id: 'm', status: 'maintenance', maintenance: true, collectSource: 'site', receivedAt: NOW - 3 * HOUR, staleSince: NOW - HOUR }, snap), NOW - 3 * HOUR, '엣지 시각은 수신 시각을 넘지 못한다');
  // 예전 동작 유지: 정상 = 스냅샷 시각 · 직접 수집 이월 = staleSince · 위임 = 받은 시각
  assert.equal(pub.vcCollectedAtOf({ id: 'o', status: 'connected' }, snap), NOW);
  assert.equal(pub.vcCollectedAtOf({ id: 'l', status: 'unreachable', stale: true, staleSince: NOW - HOUR }, snap), NOW - HOUR);
  assert.equal(pub.vcCollectedAtOf({ id: 's', status: 'connected', collectSource: 'site', receivedAt: NOW - 5 * HOUR, stale: true }, snap), NOW - 5 * HOUR);
});

test('F4 ② 용량 · 경보 · 합계 · vCenter 목록 응답이 지금 값이 아닌 vCenter 를 밝힌다(실제 요청 · 범위 키는 자기 범위만)', async () => {
  const dsRow = (vc, n, used) => ({ id: `${vc}:ds${n}`, vcenterId: vc, name: `ds${n}`, type: 'VMFS', capacityGB: 100, usedGB: used, freeGB: 100 - used, usagePct: used });
  const al = (vc) => ({ id: `${vc}:a1`, vcenterId: vc, entity: 'h1', entityType: 'host', severity: 'critical' });
  store.snapshot = {
    generatedAt: new Date(NOW).toISOString(), source: 'live',
    vcenters: [VC.ok('vc-ok'), VC.maintenance('vc-mt'), VC.lastGood('vc-lg'), VC.siteStale('vc-st'), VC.emptyDown('vc-gone')],
    hosts: [], vms: [], networks: [],
    datastores: [dsRow('vc-ok', 1, 10), dsRow('vc-mt', 1, 95), dsRow('vc-lg', 1, 50), dsRow('vc-st', 1, 60)],
    alarms: [al('vc-ok'), al('vc-mt')],
  };
  const app = express();
  app.use('/api/v1', pub.default);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const full = keys.issueApiKey({ name: 'all', groups: ['inventory', 'capacity', 'faults'] }).plaintext;
  const scoped = keys.issueApiKey({ name: 'one', groups: ['inventory', 'capacity', 'faults'], vcenters: ['vc-ok', 'vc-mt'] }).plaintext;
  const call = async (p, k = full) => (await fetch(`${base}${p}`, { headers: { 'X-Api-Key': k } })).json();
  const NOT_NOW = ['vc-gone', 'vc-lg', 'vc-mt', 'vc-st'];

  for (const p of ['/capacity/datastores', '/faults/alarms', '/inventory/summary']) {
    const r = await call(p);
    assert.equal(r.ok, true, `${p}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(r.meta.notCurrentVcenters, 4, `${p}: 지금 값이 아닌 vCenter 수`);
    assert.deepEqual([...r.meta.notCurrentVcenterIds].sort(), NOT_NOW, `${p}: 어느 vCenter 인지`);
    assert.match(r.meta.note, /지금 값이 아닙니다/, `${p}: 문장으로도 밝힌다`);
  }
  // 값은 그대로 싣는다(행을 지우지 않는다 — 표지만)
  const d = await call('/capacity/datastores');
  assert.equal(d.data.length, 4);
  assert.equal(d.data.find((x) => x.vcenterId === 'vc-mt').usedPct, 95);
  // 범위 키: 자기 범위의 vCenter 만(범위 밖 id 를 흘리지 않는다)
  const s = await call('/capacity/datastores', scoped);
  assert.equal(s.ok, true, JSON.stringify(s).slice(0, 200));
  assert.equal(s.meta.scopedToVcenters, 2, '범위 키로 만들어졌다(픽스처 확인)');
  assert.deepEqual(s.meta.notCurrentVcenterIds, ['vc-mt'], '범위 밖 vCenter id 를 싣지 않는다');
  assert.equal(s.meta.notCurrentVcenters, 1);
  // vCenter 목록: 점검중 행은 stale:true · collectedAt null
  const v = await call('/inventory/vcenters');
  const row = Object.fromEntries(v.data.map((x) => [x.id, x]));
  assert.equal(row['vc-mt'].stale, true, '점검중 행의 값은 직전 캐시다');
  assert.equal(row['vc-mt'].collectedAt, null);
  assert.equal(row['vc-ok'].stale, false);
  assert.equal(row['vc-ok'].collectedAt, NOW);
  assert.equal(v.meta.staleCount, 3, '점검중 · 수집 실패 이월 · 낡은 위임');
  // 전부 정상이면 표지는 0 · 문장 없음
  store.snapshot = { ...store.snapshot, vcenters: [VC.ok('vc-ok')], datastores: [dsRow('vc-ok', 1, 10)], alarms: [] };
  const clean = await call('/capacity/datastores');
  assert.equal(clean.meta.notCurrentVcenters, 0);
  assert.deepEqual(clean.meta.notCurrentVcenterIds, []);
  assert.equal(clean.meta.note, undefined);
});

/* ── F5 서비스 점검 ──────────────────────────────────────────────────────── */
test('F5 서비스 점검 ‘vCenter 수집’ 은 엣지 보고가 끊긴 위임 vCenter 를 연결로 세지 않는다', async () => {
  const { getServiceCheck } = await import('../src/health/services.js');
  const rowOf = () => {
    const r = getServiceCheck({ isAdmin: true });
    const list = Array.isArray(r) ? r : (r.checks || r.items || r.rows || []);
    const row = list.find((x) => x && (x.key === 'vcenter' || x.id === 'vcenter'));
    assert.ok(row, `vcenter 행을 찾지 못했다 — ${JSON.stringify(Array.isArray(r) ? r.slice(0, 2) : Object.keys(r)).slice(0, 200)}`);
    return row;
  };
  const gen = new Date().toISOString();
  // 위임 3곳 중 2곳의 엣지가 보고를 멈췄다 — status 는 엣지가 마지막으로 보낸 connected 그대로다(store 병합)
  store.snapshot = { generatedAt: gen, vcenters: [VC.ok('a'), VC.siteStale('b'), VC.siteStale('c')], hosts: [], vms: [], datastores: [], alarms: [], rollups: {} };
  let row = rowOf();
  assert.equal(row.status, 'warn', `예전에는 3/3 연결 · 정상이었다 — ${row.detail}`);
  assert.match(row.detail, /^1\/3 연결/);
  assert.match(row.detail, /엣지 보고 끊김 2/);
  // 전부 끊겼다 — 접속 실패(down)는 아니고 확인 불가(주의)다
  store.snapshot = { ...store.snapshot, vcenters: [VC.siteStale('b'), VC.siteStale('c')] };
  row = rowOf();
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /^0\/2 연결 · 엣지 보고 끊김 2/);
  // 예전 동작 유지: 전부 정상 = ok(문구 그대로) · 전부 접속 실패 = down
  store.snapshot = { ...store.snapshot, vcenters: [VC.ok('a'), { ...VC.siteStale('b'), stale: false }] };
  row = rowOf();
  assert.equal(row.status, 'ok');
  assert.match(row.detail, /^2\/2 연결 · /);
  assert.doesNotMatch(row.detail, /보고 끊김/);
  store.snapshot = { ...store.snapshot, vcenters: [VC.emptyDown('a')] };
  assert.equal(rowOf().status, 'down');
});

/* ── 스윕: 스냅샷의 사용률 · 용량 · 상태를 읽는 모듈 분류표 ───────────────── */
/*
 * 분류(멈춘 vCenter 를 어떻게 다루는가):
 *   shared  공용 판정(metrics/unreadVcenters.js — 또는 그것을 감싼 unreadVcenterIds · notReadVcentersOf)을 이 파일이 직접 쓴다
 *   own     자체 판정 또는 호출자가 판정한다(사유를 적는다)
 *   display 화면 표시 · 사람이 고르는 목록(값을 판정 · 적재 · 발송에 쓰지 않는다 — 상태 표지는 화면 몫)
 *   left    남김(알고 둔 것 — 사유)
 *   unverified 126회차가 깊이 보지 못함(다음 점검의 첫 후보)
 * 새 모듈이 여기 없으면 실패한다 — 먼저 '그 vCenter 의 수집이 멈추면 이 값은 무엇이 되는가' 를 답하고 표에 넣을 것.
 */
const TABLE = {
  'alerts.js': ['shared', '126 F1 · F2 — 세 사유 전부 신규 억제 + 해소 보류'],
  'backup/vmwareExport.js': ['unverified', 'vCenter 구성 내보내기(DS 용량 칸) — 126회차 범위 밖(backup/**)'],
  'bareos/drPlan.js': ['own', '재해 복구 사전 점검 — unreachable · maintenance · pending 은 ✕(보내지 않음) · stale 은 경고'],
  'bareos/rehearsal.js': ['shared', '126 F3 — 정기 복원 검증은 멈춘 vCenter 를 건너뛴다'],
  'bareos/restore.js': ['left', '대화형 복원 판정(사람이 확인하고 OTP 로 보낸다) — 여유가 옛 값이라는 표지는 없다(126 남긴 것)'],
  'snaphist/view.js': ['own', 'v3.26.0 스냅샷 화면 — 값이 낡은 vCenter(vc.stale — 카드와 같은 기준)의 VM 은 stale 표지를 달고 화면 요약에서 뺀다(따로 센다) · 이력 기록(snaphist/record.js)은 unreadVcenterReasons · pending · disabled · REST 폴백 vCenter 를 행 없이 사유로만 남긴다'],
  'dscfg/summary.js': ['own', 'v3.22.0 도구 요약 — 경로는 analyzePaths 그대로(수집 안 된 호스트는 notCollected 로 따로) · 용량 예측은 라우트가 만든 items(원본 도구와 같은 판정) 그대로 법인별로 센다'],
  'contention/analyze.js': ['own', '표본 시각 기준 stale(staleAfterMs) — 오래된 표본은 측정에서 뺀다'],
  'corelicense/analyze.js': ['shared', 'notReadVcentersOf — 인벤토리가 빈 못 읽은 vCenter 를 밝힌다(값이 남은 vCenter 는 합계에 든다 — 구성 리포트)'],
  'gpu/allocTree.js': ['own', '계층 계산만 — 호출자(alerts · healthReport · gpu/allocHistory)가 못 읽은 법인을 거른다'],
  'gpu/poller.js': ['own', 'inventoryUnreadReason(v2.606) — 상태가 connected 가 아니거나 호스트 0 이면 unread(빈 결과를 push 하지 않는다)'],
  'guestdisk/service.js': ['own', '게스트 수집 시각 기준 stale 행 표지'],
  'guestpart/notify.js': ['own', '게스트 파티션은 별도 수집(guestpart DB) — 스냅샷은 vCenter 이름 · 모드만'],
  'guestpart/report.js': ['own', '130 확인 — 파티션 표본 시각(lastTs) 기준 stale 을 vCenter · VM 행에 싣는다(수집이 멈추면 표본이 낡아 표지가 선다) · 스냅샷은 분모(게스트 수 · 전원)'],
  'insights/fleetInventory.js': ['shared', ''],
  'insights/forecast.js': ['display', '추이는 지표 샘플러(공용 판정으로 결측) — 현재 용량 · 사용은 스냅샷 값 그대로(화면)'],
  'insights/graph.js': ['display', '끊긴 호스트는 usageReadable — vCenter 단위 표지는 화면 몫'],
  'insights/topology.js': ['shared', ''],
  'llm/chatops.js': ['left', 'LLM 문맥에 멈춘 vCenter 의 마지막 사용률이 지금 값으로 들어간다 — 126회차 범위 밖(llm/**) · 보고서에 적음'],
  'llm/nlSearch.js': ['display', '검색 결과(인벤토리 행)'],
  'metrics/sampler.js': ['shared', '판정의 첫 소비처(v2.620)'],
  'provision/placement.js': ['display', '배치 선택 칸(사람이 고른다 · 생성은 vCenter 에 직접)'],
  'reports/healthReport.js': ['own', '낡은 위임 · 점검중 · 첫 수집 중을 확인 불가로 센다(종합은 ✅ 가 아니다) — 절별 항목에는 표지 없음(126 남긴 것)'],
  'reports/vmStats.js': ['own', '호출자(지표 샘플러)가 공용 판정으로 거른 VM 만 넘긴다'],
  'routes/admin/collectorsDc.js': ['display', 'VM 사양 변경 화면의 DS 목록'],
  'routes/admin/idracScan.js': ['display', ''],
  'routes/api/hardwareGpu.js': ['display', ''],
  'routes/api/inventory.js': ['display', '인벤토리 · 요약 화면 — vcentersStale · stale 표지를 함께 싣는다'],
  'routes/api/overviewNsx.js': ['display', ''],
  'routes/api/reports.js': ['own', '130 확인 — 위임 라우트: 용량 예측은 insights/forecast(추이는 샘플러가 공용 판정으로 결측) · 변경 이력은 notCollected 표지 · 이 파일은 스냅샷을 범위 · 이름으로만 읽는다'],
  'routes/api/storagePaths.js': ['unverified', '데이터스토어 경로 점검 CSV — 126회차가 깊이 보지 못함'],
  'routes/api/svcInventory.js': ['shared', ''],
  'routes/api/toolsAnalytics.js': ['unverified', 'N+1 · 낭비 · 위협 분석 화면 — 멈춘 vCenter 표지 유무를 보지 못했다'],
  'routes/api/toolsCapacity.js': ['shared', ''],
  'routes/api/vmClone.js': ['display', 'NFS 데이터스토어 표시 — 실행(runner · vsOps)은 vCenter 에서 여유를 직접 읽는다'],
  'routes/api/vmMetrics.js': ['display', ''],
  'routes/metricsExport.js': ['shared', '122 R3'],
  'routes/publicApi.js': ['shared', '126 F4 — meta.notCurrentVcenters · 점검중 행 stale'],
  'search/deepSearch.js': ['display', ''],
  'search/inventoryIndex.js': ['display', ''],
  'store.js': ['shared', '롤업 · 전력 적재(vcSkip)'],
  'vcenter/vmExport.js': ['shared', '130 R5 — inventoryNotCurrent: 상태 invAt(읽은 시각 · 모르면 null) · invNotCurrent · 내보내기 메타'],
  'vcenter/vmExportXlsx.js': ['own', '130 R5 — 메타 invNotCurrent 를 요약 · 폴더 트리의 ‘기준’ 줄과 읽는 법 시트에 적는다(CSV 는 머리말이 없어 화면 타일이 말한다)'],
  'vmtrack/service.js': ['own', 'inventoryUnreadReason(v2.743) — 값이 남은 vCenter 는 변화 0 으로 diff, 빈 vCenter 는 건너뜀'],
};
const SHARED_RE = /\b(?:unreadVcenterReasons|unreadVcenterIds|notReadVcentersOf)\b/;
const SNAP_RE = /\bstore\.get\(\)|\bstore\.snapshot\b|\bgetSnapshot\(|\bsnap(?:shot)?\??\.(?:hosts|datastores|vms|alarms)\b/;
const FIELD_RE = /\b(?:cpuUsagePct|memUsagePct|cpuUsageMhz|memUsageMB|usagePct|freeGB|capacityGB|usedGB|powerWatts|tempC|gpuUtilPct|overallStatus)\b/;
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function consumers() {
  const out = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['vendor', 'mock', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(p, 'utf8'));
      if (SNAP_RE.test(src) && FIELD_RE.test(src)) out.set(path.relative(SRC_DIR, p).split(path.sep).join('/'), src);
    }
  })(SRC_DIR);
  return out;
}

test('스윕 ① 스냅샷의 사용률 · 용량 · 상태를 읽는 모듈은 전부 분류표에 있다(새 소비처 · 사라진 항목 둘 다 잡는다)', () => {
  const found = consumers();
  assert.ok(found.size >= 30, `탐지가 깨졌다 — ${found.size}개만 잡혔다`);
  const missing = [...found.keys()].filter((f) => !Object.hasOwn(TABLE, f));
  assert.deepEqual(missing, [], `분류표에 없는 소비처 — 그 vCenter 의 수집이 멈추면(점검중 · 수집 실패 이월 · 엣지 보고 끊김) 이 값이 무엇이 되는지 답하고 TABLE 에 넣을 것: ${missing.join(', ')}`);
  const gone = Object.keys(TABLE).filter((f) => !found.has(f));
  assert.deepEqual(gone, [], `분류표에만 남은 항목(파일이 없어졌거나 더는 읽지 않는다) — 표에서 지울 것: ${gone.join(', ')}`);
  for (const [f, [cls, why]] of Object.entries(TABLE)) {
    assert.ok(['shared', 'own', 'display', 'left', 'unverified'].includes(cls), `${f}: 모르는 분류 ${cls}`);
    if (cls !== 'shared' && cls !== 'display') assert.ok(why, `${f}: ${cls} 는 사유를 적는다`);
  }
});

test('스윕 ② shared 로 적은 모듈은 실제로 공용 판정을 쓴다 · 판정 본체는 한 곳이다', () => {
  const found = consumers();
  for (const [f, [cls]] of Object.entries(TABLE)) {
    if (cls !== 'shared') continue;
    const src = found.get(f) || '';
    assert.ok(SHARED_RE.test(src) || f === 'metrics/sampler.js', `${f}: shared 인데 공용 판정을 부르지 않는다`);
  }
  // 판정 본체(상태 → 사유)는 metrics/unreadVcenters.js 하나 — 다른 파일이 같은 삼항 사슬을 다시 쓰면 실패한다
  const body = /status === 'maintenance' \|\| \w+\.maintenance === true\) \? 'maintenance'\s*:\s*\w+\.status === 'unreachable' \? 'unreachable'/;
  const copies = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['vendor', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (e.name.endsWith('.js') && body.test(stripComments(fs.readFileSync(p, 'utf8')))) copies.push(path.relative(SRC_DIR, p).split(path.sep).join('/'));
    }
  })(SRC_DIR);
  assert.deepEqual(copies, ['metrics/unreadVcenters.js']);
});
