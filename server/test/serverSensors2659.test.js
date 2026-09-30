/**
 * v2.659 — 서버 온도 › 센서 상세(iDRAC 전 센서 · 임계값 · 역할 · 전산실 흡기 · CPU/GPU 온도 · CPU 사용률 재사용).
 * 사용자 요청: "iDRAC 에서 수집하는 모든 센서 · inlet 으로 전산실 온도 · CPU 사용량을 온도와 CPU performance 로 ·
 * GPU 사용량을 GPU 온도로". 선택: Sensors 컬렉션 전부 · CPU 사용률은 베어메탈 사용률 재사용.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sensors2659-'));
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 Redfish(127.0.0.1) — 이 테스트 전용
const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const D = await import('../src/idrac/sensorDetail.js');

test('① 상태 판정 순서 — 빈 슬롯 → 장비 Health → 장비 임계값 → 판정 불가(임계를 지어내지 않는다)', () => {
  assert.equal(D.sensorState({ absent: true, health: 'Critical', reading: 99 }), 'absent', '빈 슬롯은 Health 보다 먼저');
  assert.equal(D.sensorState({ health: 'Warning', reading: 10, thresholds: { critMax: 5 } }), 'warn', '장비 Health 가 임계보다 먼저');
  assert.equal(D.sensorState({ reading: 43, thresholds: { warnMax: 38, critMax: 42 } }), 'crit');
  assert.equal(D.sensorState({ reading: 39, thresholds: { warnMax: 38, critMax: 42 } }), 'warn');
  assert.equal(D.sensorState({ reading: 20, thresholds: { warnMax: 38 } }), 'ok');
  assert.equal(D.sensorState({ reading: 20, thresholds: {} }), 'unknown', '임계도 Health 도 없으면 정상이라 하지 않는다');
  assert.equal(D.sensorState({ reading: null, thresholds: { critMax: 42 } }), 'unknown', '못 읽은 값은 0 이 아니다');
  assert.equal(D.sensorState({ reading: '', thresholds: { critMin: 3 } }), 'unknown', "Number('') === 0 함정");
});

test('② Thermal 온도 — 캡처의 임계값 열(N/A 포함)을 그대로 살린다', () => {
  const inlet = D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: 20, Status: { Health: 'OK', State: 'Enabled' },
    LowerThresholdNonCritical: 3, UpperThresholdNonCritical: 38, LowerThresholdCritical: -7, UpperThresholdCritical: 42 });
  assert.deepEqual(inlet.thresholds, { warnMin: 3, warnMax: 38, critMin: -7, critMax: 42 });
  assert.equal(inlet.role, 'inlet'); assert.equal(inlet.state, 'ok'); assert.equal(inlet.kind, 'temperature');
  const gpu = D.parseThermalTemp({ Name: 'GPU2 Temp', ReadingCelsius: 44, Status: { Health: 'OK' } });
  assert.deepEqual(gpu.thresholds, {}, 'N/A 는 빈 칸 — 0 으로 채우지 않는다');
  assert.equal(gpu.role, 'gpu');
  assert.equal(D.parseThermalTemp({ Name: 'CPU1 Temp', ReadingCelsius: null }).reading, null);
  const fan = D.parseThermalFan({ Name: 'Fan 1', Reading: 23, ReadingUnits: 'Percent', Status: { Health: 'OK' } });
  assert.equal(fan.unit, '%', 'HPE Percent 는 RPM 으로 읽지 않는다');
});

test('③ 역할 — 전원공급장치를 흡기로 읽지 않는다(HPE 32-P/S 1 Inlet)', () => {
  const cases = { 'Inlet Temp': 'inlet', '01-Inlet Ambient': 'inlet', '32-P/S 1 Inlet': 'psu', 'PSU1 Temp': 'psu',
    'System Board Exhaust Temp': 'exhaust', 'CPU0 Temp': 'cpu', 'GPU7 Temp': 'gpu', 'Max DIMM Temperature': 'dimm', 'System Board Fan1': 'other' };
  for (const [n, r] of Object.entries(cases)) assert.equal(D.roleOf({ name: n }), r, n);
  assert.equal(D.roleOf({ name: 'Board', context: 'Intake' }), 'inlet');
});

test('④ Sensors 컬렉션 — Thresholds 객체·ReadingType 을 읽고, 병합은 중복 없이 빈 임계만 채운다', () => {
  const v = D.parseRedfishSensor({ Id: 'PS1V', Name: 'PS1 Voltage 1', ReadingType: 'Voltage', ReadingUnits: 'V', Reading: 230,
    Thresholds: { LowerCritical: { Reading: 180 }, UpperCritical: { Reading: 264 } }, Status: { Health: 'OK' } });
  assert.equal(v.kind, 'voltage'); assert.deepEqual(v.thresholds, { critMin: 180, critMax: 264 });
  const coll = [D.parseRedfishSensor({ Name: 'Inlet Temp', ReadingType: 'Temperature', ReadingUnits: 'Cel', Reading: 21 })];
  const th = [D.parseThermalTemp({ Name: 'inlet temp', ReadingCelsius: 20, UpperThresholdCritical: 42 }), D.parseThermalTemp({ Name: 'CPU0 Temp', ReadingCelsius: 49 })];
  const { list } = D.mergeSensors(coll, th);
  assert.equal(list.length, 2, '같은 센서(종류+이름, 대소문자 무시)는 한 번');
  const inlet = list.find((s) => s.role === 'inlet');
  assert.equal(inlet.reading, 21, '컬렉션 값이 먼저');
  assert.equal(inlet.thresholds.critMax, 42, '빈 임계는 Thermal 로 채운다');
  assert.equal(inlet.state, 'ok');
  assert.equal(inlet.source, 'both');
});

test('⑤ 요약 — 흡기는 최고값, GPU·CPU 온도, CPU 사용률 센서(퍼센트)만 사용률로', () => {
  const list = [
    D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: 20 }), D.parseThermalTemp({ Name: 'Inlet Temp 2', ReadingCelsius: 23 }),
    D.parseThermalTemp({ Name: 'CPU0 Temp', ReadingCelsius: 49.3 }), D.parseThermalTemp({ Name: 'CPU1 Temp', ReadingCelsius: 51.2 }),
    D.parseThermalTemp({ Name: 'GPU2 Temp', ReadingCelsius: 44 }), D.parseThermalTemp({ Name: 'GPU7 Temp', ReadingCelsius: 48 }),
    D.parseRedfishSensor({ Name: 'CPU Usage', ReadingType: 'Percent', Reading: 15, PhysicalContext: 'CPU' }),
    D.parseRedfishSensor({ Name: 'CPU Power', ReadingType: 'Power', Reading: 150 }),
  ];
  const s = D.summarizeSensors(list);
  assert.equal(s.inletC, 23); assert.equal(s.inletCount, 2);
  assert.equal(s.cpuTempMaxC, 51.2); assert.equal(s.gpuTempMaxC, 48); assert.equal(s.gpuTempCount, 2);
  assert.equal(s.sensorCpuUsagePct, 15, '퍼센트 CPU 센서만 — CPU Power(W) 는 사용률이 아니다');
  assert.equal(D.summarizeSensors([D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: null })]).inletC, null);
});

test('⑥ 엣지 콤팩트 왕복 — 중앙은 엣지가 보낸 상태를 믿지 않고 다시 판정한다', async () => {
  const s = D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: 45, UpperThresholdCritical: 42 });
  const c = D.compactSensor(s);
  const back = D.expandCompact({ ...c, state: 'ok' });
  assert.equal(back.state, 'crit');
  const { sanitizeRemoteSensorDetail, REMOTE_SENSOR_DETAIL_MAX } = await import('../src/collector/remoteInventory.js');
  const many = Array.from({ length: REMOTE_SENSOR_DETAIL_MAX + 5 }, (_, i) => ({ n: `T${i}`, k: 'temperature', v: 30 }));
  const r = sanitizeRemoteSensorDetail({ list: [...many, null, 'x', { n: { toString: 1 } }], omitted: 2, at: 5 });
  assert.equal(r.list.length, REMOTE_SENSOR_DETAIL_MAX);
  assert.equal(r.omitted, 2 + 5 + 3, '버린 원소는 개수로 밝힌다');
  assert.equal(sanitizeRemoteSensorDetail({ list: 'x' }), null);
});

/* ── 가짜 Redfish: 확장 지원 섀시 + 확장 미지원 섀시 + Sensors 없는 섀시 ── */
async function fakeRedfish({ deny = false } = {}) {
  const st = { gets: [] };
  const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = http.createServer((req, res) => {
    st.gets.push(req.url);
    if (deny) return J(res, 401, { error: { message: 'bad' } });
    const u = decodeURIComponent(req.url);
    if (u === '/redfish/v1/Chassis') return J(res, 200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/A' }, { '@odata.id': '/redfish/v1/Chassis/B' }, { '@odata.id': '/redfish/v1/Chassis/C' }] });
    if (u === '/redfish/v1/Chassis/A/Sensors?$expand=*($levels=1)') return J(res, 200, { Members: [
      { Id: 'SystemBoardCPUUsage', Name: 'System Board CPU Usage', ReadingType: 'Percent', Reading: 15, PhysicalContext: 'CPU', Status: { Health: 'OK' } },
      { Id: 'InletTemp', Name: 'Inlet Temp', ReadingType: 'Temperature', ReadingUnits: 'Cel', Reading: 20, Thresholds: { UpperCritical: { Reading: 42 } } },
    ] });
    if (u.startsWith('/redfish/v1/Chassis/B/Sensors?')) return J(res, 400, { error: { message: 'Query parameter $expand is not supported' } });
    if (u === '/redfish/v1/Chassis/B/Sensors') return J(res, 200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/B/Sensors/V1' }, { '@odata.id': '/redfish/v1/Chassis/B/Sensors/V2' }] });
    if (u === '/redfish/v1/Chassis/B/Sensors/V1') return J(res, 200, { Id: 'V1', Name: 'PS1 Voltage 1', ReadingType: 'Voltage', Reading: 230 });
    if (u === '/redfish/v1/Chassis/B/Sensors/V2') return J(res, 500, { error: { message: 'boom' } });
    return J(res, 404, { error: { message: 'not found' } });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}` };
}

test('⑦ fetchSensorCollection — $expand · 멤버 순회 · 404 는 없음 · 못 읽은 멤버는 개수로', async () => {
  const { fetchSensorCollection } = await import('../src/idrac/redfish.js');
  const f = await fakeRedfish();
  const r = await fetchSensorCollection({ host: f.host, username: 'u', password: 'p' });
  assert.equal(r.chassis, 3); assert.equal(r.expanded, 1); assert.equal(r.absent, 1, 'Sensors 없는 섀시(C)는 실패가 아니다');
  assert.equal(r.notRead, 1, '500 난 멤버는 notRead');
  const names = r.sensors.map((s) => s.name).sort();
  assert.deepEqual(names, ['Inlet Temp', 'PS1 Voltage 1', 'System Board CPU Usage']);
  assert.ok(r.ok);
  const d = await fakeRedfish({ deny: true });
  const err = await fetchSensorCollection({ host: d.host, username: 'u', password: 'bad' }).then(() => null, (e) => e);
  assert.ok(err?.authFailed, '자격증명 거부는 삼키지 않고 던진다(계정 잠금 — v2.535)');
});

test('⑧ 캐시 — 실패는 직전 목록을 지우지 않고, 서버 삭제 시 지운다', async () => {
  const C = await import('../src/idrac/sensorDetailCache.js');
  C._resetSensorDetailForTest();
  C.setThermalDetail('s1', [D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: 20 })], 1000);
  C.setSensorCollection('s1', { ok: true, sensors: [D.parseRedfishSensor({ Name: 'PS1 Voltage 1', ReadingType: 'Voltage', Reading: 230 })] }, 2000);
  C.setSensorCollection('s1', { ok: false, sensors: [], error: 'timeout' }, 3000);
  const d = C.localSensorDetail('s1');
  assert.equal(d.list.length, 2);
  assert.equal(d.collection.ok, false); assert.equal(d.collection.error, 'timeout'); assert.equal(d.collection.sensorsAt, 2000);
  assert.ok(C.exportSensorDetail('s1').list.length === 2);
  C.removeSensorDetail('s1');
  assert.equal(C.localSensorDetail('s1'), null);
});

test('⑨ 목록 — 낡은 상세·상세 없음을 요약에서 빼고, CPU 사용률은 bmusage → 텔레메트리 → 센서 순으로 출처를 밝힌다', async () => {
  const { buildSensorRows, cpuIndexOf, cpuOf } = await import('../src/tools/serverSensors.js');
  const now = 10_000_000;
  const mk = (inlet, gpu) => ({ list: [D.parseThermalTemp({ Name: 'Inlet Temp', ReadingCelsius: inlet }), ...(gpu ? [D.parseThermalTemp({ Name: 'GPU1 Temp', ReadingCelsius: gpu })] : [])], omitted: 0 });
  const det = { a: { ...mk(20, 50), at: now - 1000 }, b: { ...mk(35), at: now - 3_600_000 }, c: null };
  const idx = cpuIndexOf([{ key: 'TAGA', ts: now - 60_000, cpu_pct: 42.2, src: 'idrac' }, { key: 'taga', ts: now - 999_999, cpu_pct: 1 }]);
  const rep = buildSensorRows({
    servers: [{ id: 'a', serviceTag: 'tagA', datacenterId: 'DC1' }, { id: 'b', datacenterId: 'DC1' }, { id: 'c', datacenterId: 'DC2' }],
    detailOf: (s) => det[s.id], maxAgeOf: () => 15 * 60_000, now,
    cpuFor: (s, sum) => cpuOf(s, { cpuIndex: idx, sensorPct: sum?.sensorCpuUsagePct ?? null, now, bmEnabled: false }),
  });
  assert.deepEqual(rep.rows.map((r) => r.detailState), ['ok', 'stale', 'none']);
  assert.equal(rep.summary.inletMaxC, 20, '낡은 서버(35℃)는 전산실 온도에 넣지 않는다');
  assert.equal(rep.summary.stale, 1); assert.equal(rep.summary.none, 1); assert.equal(rep.summary.gpuServers, 1);
  const a = rep.rows.find((r) => r.id === 'a');
  assert.equal(a.cpu.src, 'bmusage'); assert.equal(a.cpu.pct, 42.2, '같은 키(대소문자 무시)는 최신 행'); assert.equal(a.cpu.state, 'ok');
  assert.equal(rep.rows.find((r) => r.id === 'c').cpu.state, 'off', '베어메탈 사용률이 꺼져 있으면 그렇게 말한다');
  const dc1 = rep.byDatacenter.find((g) => g.datacenterId === 'DC1');
  assert.equal(dc1.inletCount, 1); assert.equal(dc1.noInlet, 1);
  assert.equal(cpuOf({ id: 'z' }, { cpuIndex: new Map(), telemetryOf: () => ({ pct: 12, at: 1, fresh: true }) }).src, 'telemetry');
  assert.equal(cpuOf({ id: 'z' }, { cpuIndex: new Map(), sensorPct: 9 }).src, 'sensor');
});
