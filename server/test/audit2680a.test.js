// v2.680 감사 그룹 A — iDRAC 센서 상세·통합 추이 회귀.
//  A-01 낡은 Sensors 컬렉션 값이 신선한 Thermal 값·상태를 덮던 것(Critical 흡기가 OK 로 보였다)
//  A-02 센서 상세 CPU 칸의 컬렉션 CPU 센서가 나이와 무관하게 'ok' 였던 것
//  A-03 낡은 bmusage 행이 신선한 텔레메트리를 가리던 것
//  E-01 통합 추이 샘플러가 서버마다 센서 150개 전량을 펼치던 것(CPU 판정엔 퍼센트 센서만 필요)
//  E-03 센서 상세 캐시 18MB 를 10초마다 동기 저장하던 것(디바운스 60초 + 종료 flush)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2680a-'));
process.env.CONFIG_DIR = tmp;

const D = await import('../src/idrac/sensorDetail.js');
const { cpuOf, cpuIndexOf, buildSensorRows } = await import('../src/tools/serverSensors.js');
const T = await import('../src/idrac/serverTrendSeries.js');
const C = await import('../src/idrac/sensorDetailCache.js');

const DAY = 86_400_000;

test('A-01 신선한 Thermal(41℃ Critical) 이 3일 전 컬렉션(20℃ OK) 을 이긴다', () => {
  const now = 50 * DAY;
  const coll = [D.parseRedfishSensor({ Id: 'x', Name: 'System Board Inlet Temp', ReadingType: 'Temperature', ReadingUnits: 'Cel', Reading: 20, Status: { Health: 'OK', State: 'Enabled' }, Thresholds: { LowerCaution: { Reading: 3 } } })];
  const th = [D.parseThermalTemp({ Name: 'System Board Inlet Temp', ReadingCelsius: 41, Status: { Health: 'Critical', State: 'Enabled' }, UpperThresholdCritical: 42 })];
  const { list } = D.mergeSensors(coll, th, { collAt: now - 3 * DAY, now });
  const inlet = list.filter((s) => s.role === 'inlet');
  assert.equal(inlet.length, 1);
  assert.equal(inlet[0].reading, 41);
  assert.equal(inlet[0].state, 'crit');
  assert.equal(inlet[0].source, 'both');
  assert.equal(inlet[0].thresholds.warnMin, 3, '컬렉션은 빈 임계만 채운다');
  assert.ok(!inlet[0].stale, 'Thermal 이 함께 보고한 센서는 stale 대상이 아니다');
  const sum = D.summarizeSensors(list);
  assert.equal(sum.inletC, 41);
  assert.equal(sum.counts.crit, 1);
  // 화면 행까지
  const rep = buildSensorRows({ servers: [{ id: 's1' }], detailOf: () => ({ list, omitted: 0, at: now - 60_000 }),
    cpuFor: () => null, maxAgeOf: () => 15 * 60_000, now });
  assert.equal(rep.summary.inletMaxC, 41);
  assert.equal(rep.summary.serversCrit, 1);
});

test('A-01 낡은 컬렉션 전용 센서는 stale 로 표시되고 요약(흡기·경고 개수)에서 빠진다 — 값은 지우지 않는다', () => {
  const now = 50 * DAY;
  const coll = [
    D.parseRedfishSensor({ Name: 'Room Inlet Temp', ReadingType: 'Temperature', Reading: 39, Status: { Health: 'Warning' } }),
    D.parseRedfishSensor({ Name: 'PS1 Voltage 1', ReadingType: 'Voltage', Reading: 230, Status: { Health: 'OK' } }),
  ];
  const old = D.mergeSensors(coll, [], { collAt: now - 3 * DAY, now }).list;
  assert.ok(old.every((s) => s.stale === true && s.state === 'unknown'));
  assert.equal(old.find((s) => s.kind === 'voltage').reading, 230, '값은 남긴다');
  assert.equal(old.find((s) => s.kind === 'temperature').staleState, 'warn');
  const so = D.summarizeSensors(old);
  assert.equal(so.inletC, null, '낡은 흡기를 전산실 온도로 쓰지 않는다(0 도 아니다)');
  assert.equal(so.counts.warn, 0); assert.equal(so.stale, 2);
  const fresh = D.mergeSensors(coll, [], { collAt: now - 10 * 60_000, now }).list;
  assert.ok(fresh.every((s) => !s.stale));
  assert.equal(D.summarizeSensors(fresh).inletC, 39);
  // 캐시 경로도 같은 규칙
  C._resetSensorDetailForTest();
  C.setSensorCollection('c1', { ok: true, sensors: coll }, Date.now() - 3 * DAY);
  C.setThermalDetail('c1', [D.parseThermalTemp({ Name: 'CPU0 Temp', ReadingCelsius: 50 })]);
  const d = C.localSensorDetail('c1');
  assert.equal(d.list.filter((s) => s.stale).length, 2);
  assert.equal(D.summarizeSensors(d.list).inletC, null);
  C._resetSensorDetailForTest();
});

test('A-02 센서 상세 CPU 칸 — 컬렉션 CPU 센서는 컬렉션 시각으로 신선도를 본다(통합 추이와 같은 판정)', () => {
  const now = 50 * DAY;
  const old = cpuOf({ id: 'z' }, { cpuIndex: new Map(), sensorPct: 5, sensorAt: now - 3 * DAY, now });
  assert.equal(old.src, 'sensor'); assert.equal(old.state, 'stale'); assert.equal(old.at, now - 3 * DAY);
  const fresh = cpuOf({ id: 'z' }, { cpuIndex: new Map(), sensorPct: 5, sensorAt: now - 10 * 60_000, now });
  assert.equal(fresh.state, 'ok');
  assert.equal(cpuOf({ id: 'z' }, { cpuIndex: new Map(), sensorPct: 5, now }).state, 'stale', '시각을 모르면 지금 값이라 하지 않는다');
  // 한 판정: 통합 추이 sensorCpuOf 와 같은 경계
  for (const age of [60_000, D.SENSOR_COLLECTION_FRESH_MS - 1, D.SENSOR_COLLECTION_FRESH_MS + 1, 3 * DAY]) {
    const list = [D.parseRedfishSensor({ Name: 'CPU Usage', ReadingType: 'Percent', Reading: 5, PhysicalContext: 'CPU' })];
    const t = T.sensorCpuOf({ id: 'z' }, { now, detailOf: () => ({ list, collAt: now - age }) });
    const c = cpuOf({ id: 'z' }, { cpuIndex: new Map(), sensorPct: 5, sensorAt: now - age, now });
    assert.equal(t.stale, c.state === 'stale', `age ${age}`);
  }
  assert.equal(T.SENSOR_CPU_FRESH_MS, D.SENSOR_COLLECTION_FRESH_MS);
});

test('A-03 낡은 bmusage 행은 신선한 텔레메트리·센서가 없을 때만 쓴다', () => {
  const now = 50 * DAY;
  const idx = cpuIndexOf([{ key: 'TAG1', ts: now - 5 * DAY, cpu_pct: 3, src: 'os' }]);
  const a = cpuOf({ serviceTag: 'TAG1', id: 's1' }, { cpuIndex: idx, telemetryOf: () => ({ pct: 88, at: now, fresh: true }), now });
  assert.equal(a.src, 'telemetry'); assert.equal(a.pct, 88); assert.equal(a.state, 'ok');
  const b = cpuOf({ serviceTag: 'TAG1', id: 's1' }, { cpuIndex: idx, sensorPct: 40, sensorAt: now - 60_000, now });
  assert.equal(b.src, 'sensor'); assert.equal(b.state, 'ok');
  const c = cpuOf({ serviceTag: 'TAG1', id: 's1' }, { cpuIndex: idx, now });
  assert.equal(c.src, 'bmusage'); assert.equal(c.state, 'stale'); assert.equal(c.pct, 3, '낡은 값도 마지막 수단으로는 싣는다');
  const fresh = cpuIndexOf([{ key: 'TAG1', ts: now - 60_000, cpu_pct: 7, src: 'idrac' }]);
  assert.equal(cpuOf({ serviceTag: 'TAG1' }, { cpuIndex: fresh, telemetryOf: () => ({ pct: 88, fresh: true }), now }).src, 'bmusage', '신선한 bmusage 가 먼저(순서 불변)');
  assert.equal(cpuOf({ id: 'q' }, { cpuIndex: new Map(), now, bmEnabled: false }).state, 'off');
});

function mkServers(n) {
  const names = ['CPU1 Temp', 'CPU2 Temp', 'System Board Inlet Temp', 'System Board Exhaust Temp', 'GPU1 Temp', 'DIMM A1', 'Fan1', 'PS1 Voltage', 'System Board CPU Usage'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const list = [];
    for (let j = 0; j < 150; j++) list.push({ n: `${names[j % names.length]} ${j}`, k: j % 9 === 8 ? 'percent' : (j % 3 ? 'temperature' : 'fan'), v: (i + j) % 100, u: 'Cel', h: 'OK', c: j % 5 ? 'CPU' : 'Intake', wh: 80, ch: 90 });
    out.push({ id: `srv${i}`, remote: true, sensors: null, sensorDetail: { list, collAt: i % 3 === 0 ? 0 : 50 * DAY - 60_000 } });
  }
  return out;
}

test('E-01 샘플러 CPU 판정은 퍼센트 센서만 펼친다 — 결과는 전량 경로와 같고 더 빠르다', () => {
  const now = 50 * DAY;
  const servers = mkServers(300);
  const opt = { now, latestOf: () => null, cpuIndex: null };
  const full = T.buildServerTrendRows(servers, { ...opt, detailOf: T.sensorDetailOf });
  const light = T.buildServerTrendRows(servers, opt);
  assert.ok(full.length > 0);
  assert.deepEqual(light, full);
  for (const s of servers.slice(0, 30)) {
    assert.deepEqual(T.cpuFallbackDiag(s, { now }), T.cpuFallbackDiag(s, { now, detailOf: T.sensorDetailOf }));
  }
  // 로컬 경로도 같은 결과
  C._resetSensorDetailForTest();
  C.setSensorCollection('L1', { ok: true, sensors: [
    D.parseRedfishSensor({ Name: 'CPU Usage', ReadingType: 'Percent', Reading: 33, PhysicalContext: 'CPU' }),
    D.parseRedfishSensor({ Name: 'PS1 Voltage 1', ReadingType: 'Voltage', Reading: 230 }),
  ] }, Date.now() - 60_000);
  C.setThermalDetail('L1', [D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: 20 })]);
  const a = T.sensorCpuOf({ id: 'L1' });
  const b = T.sensorCpuOf({ id: 'L1' }, { detailOf: T.sensorDetailOf });
  assert.equal(a.v, 33); assert.deepEqual(a, b);
  assert.equal(C.localCpuSensorDetail('L1').list.length, 1);
  C._resetSensorDetailForTest();
  // 시간 — 절대값이 아니라 비율(CPU 에 따라 다르다)
  const time = (fn) => { let best = Infinity; for (let r = 0; r < 3; r++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); } return best; };
  const big = mkServers(1000);
  const tFull = time(() => T.buildServerTrendRows(big, { ...opt, detailOf: T.sensorDetailOf }));
  const tLight = time(() => T.buildServerTrendRows(big, opt));
  assert.ok(tLight * 2 < tFull, `퍼센트만 펼치면 2배 이상 빨라야 한다(full ${tFull.toFixed(1)}ms, light ${tLight.toFixed(1)}ms)`);
});

test('E-03 캐시 저장 디바운스는 60초 이상이고 종료 flush 가 동기로 즉시 쓴다', async () => {
  assert.ok(C.PERSIST_DEBOUNCE_MS >= 60_000);
  const file = path.join(tmp, 'idrac-sensor-cache.json');
  C._resetSensorDetailForTest();
  try { fs.rmSync(file); } catch { /* 없음 */ }
  C.setSensorCollection('X1', { ok: true, sensors: [D.parseRedfishSensor({ Name: 'PS1 Voltage 1', ReadingType: 'Voltage', Reading: 230 })] }, 1000);
  assert.equal(fs.existsSync(file), false, '디바운스 동안은 쓰지 않는다');
  const { runExitFlush } = await import('../src/util/exitFlush.js');
  runExitFlush('test');
  assert.equal(fs.existsSync(file), true, 'exit flush 가 즉시 동기로 쓴다');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(obj.X1.sensors[0].v, 230);
  const { isRuntimeStateFile } = await import('../src/backup/service.js').catch(() => ({}));
  if (typeof isRuntimeStateFile === 'function') assert.equal(isRuntimeStateFile('idrac-sensor-cache.json'), true, '상태 파일 등록 유지');
  C._resetSensorDetailForTest();
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
