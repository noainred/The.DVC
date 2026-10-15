/**
 * v2.741 점검 그룹 GF — CVP 트래픽·전력 · iDRAC 센서 상세 캐시(감사 LEFT-04 · LEFT-05 · DEV-03 · LEFT-08).
 *
 *  LEFT-04 CVP Overview 법인 트래픽 — 한 방향(수신·송신)을 측정 장비 전부에서 못 읽었으면 그 방향 합은 null 이다.
 *          예전에는 초기값 0 에 아무것도 더하지 않아 '수신 0 bps'(트래픽 없음이라는 거짓)가 나갔다. 일부만 못 읽었으면 읽은 장비의
 *          합을 그대로 두고 inUnread/outUnread 로 센다(화면이 부분 합이라 말한다 — web audit2741g).
 *  LEFT-05 CVP 장비 소비전력 계산은 parse.devicePower 한 벌 — 전체 소비 전력(power/total.js)이 같은 함수를 쓰고 반올림은 표시 단계에서만.
 *          예전에는 장비마다 Math.round 한 값을 더해 CVP 전력 탭(반올림 없이 합산)과 같은 장비 집합의 합계가 달랐다.
 *  DEV-03 슬롯 전원(ecb › Linecard·Fabric·Supervisor — v2.648 이 kind psu 그대로 두고 role 'slot-power' 만 붙였다)은 PSU 로 세지 않는다.
 *          예전에는 모듈형 섀시가 정상 PSU 를 다 읽어도 늘 '일부만 읽음' 이었고, 슬롯 항목에 power 값이 있으면 이중 계수였다.
 *  LEFT-08 iDRAC 센서 상세 캐시의 디바운스 저장은 조각 직렬화 + 비동기 tmp→fsync→rename — 예전에는 60초마다 전 서버 컬렉션을
 *          동기 JSON.stringify + 동기 원자 쓰기(서버 1,000대 × 센서 150개면 회당 약 0.2초 정지). 종료 flush 는 여전히 동기다.
 *
 * ⚠ CONFIG_DIR 은 config.js 가 import 시점에 굳히므로 맨 위에서 고정하고 src 는 동적 import 한다.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741g-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
delete process.env.CVP_PARTS_EVERY_MS;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const H = 3_600_000;
const MIN = 60_000;
const nextTurn = () => new Promise((r) => setImmediate(r));

/* ── LEFT-04 ───────────────────────────────────────────────────────────── */
test('LEFT-04 법인 트래픽 — 한 방향을 측정 장비 전부에서 못 읽으면 그 방향 합은 0 이 아니라 null', async () => {
  const { buildCvpOverview } = await import('../src/cvp/overview.js');
  const ov = buildCvpOverview({
    devices: [], servers: [{ id: 'c1', name: 'CVP', datacenterId: 'dc1' }, { id: 'c2', name: 'CVP2', datacenterId: 'dc2' }],
    datacenters: [{ id: 'dc1', name: 'Seoul' }, { id: 'dc2', name: 'Busan' }], intervalMs: 300_000,
    traffic: [
      { agent: '', cvpId: 'c1', key: 'SN1', inBps: null, outBps: 5e9, measured: 10, unmeasured: 0 },
      { agent: '', cvpId: 'c1', key: 'SN2', inBps: null, outBps: 3e9, measured: 8, unmeasured: 0 },
      { agent: '', cvpId: 'c2', key: 'SN3', inBps: 1e9, outBps: null, measured: 4, unmeasured: 0 },   // dc2: 송신 일부만 못 읽음
      { agent: '', cvpId: 'c2', key: 'SN4', inBps: 2e9, outBps: 7e8, measured: 4, unmeasured: 0 },
    ],
  });
  const seoul = ov.corps.find((c) => c.corpId === 'dc1').traffic;
  assert.equal(seoul.inBps, null, '수신을 한 대도 못 읽었으면 0 bps(트래픽 없음)가 아니라 모름');
  assert.equal(seoul.outBps, 8e9);
  assert.equal(seoul.inUnread, 2);
  assert.equal(seoul.devicesMeasured, 2);
  const busan = ov.corps.find((c) => c.corpId === 'dc2').traffic;
  assert.equal(busan.inBps, 3e9);
  assert.equal(busan.outBps, 7e8, '일부만 못 읽었으면 읽은 장비의 합(부분 합 — outUnread 로 밝힌다)');
  assert.equal(busan.outUnread, 1);
  // 전체 합: 수신은 dc2 두 대가 읽었다 · 송신은 셋이 읽었다 — 어느 방향도 '전부 못 읽음' 이 아니다.
  assert.equal(ov.traffic.inBps, 3e9);
  assert.equal(ov.traffic.outBps, 8e9 + 7e8);
  assert.equal(ov.traffic.inUnread, 2); assert.equal(ov.traffic.outUnread, 1);
  // 전체에서도 한 방향을 전부 못 읽었으면 null
  const ov2 = buildCvpOverview({ devices: [], servers: [{ id: 'c1', name: 'CVP' }], datacenters: [], intervalMs: 300_000,
    traffic: [{ agent: '', cvpId: 'c1', key: 'A', inBps: null, outBps: 1e6, measured: 2, unmeasured: 0 }] });
  assert.equal(ov2.traffic.inBps, null);
  assert.equal(ov2.traffic.outBps, 1e6);
  // 측정 포트가 없는 법인은 예전 그대로(0 · 화면은 portsMeasured 로 '—')
  const ov3 = buildCvpOverview({ devices: [], servers: [{ id: 'c1', name: 'CVP' }], datacenters: [], intervalMs: 300_000,
    traffic: [{ agent: '', cvpId: 'c1', key: 'A', inBps: null, outBps: null, measured: 0, unmeasured: 4 }] });
  assert.equal(ov3.corps[0].traffic.devicesMeasured, 0);
  assert.equal(ov3.corps[0].traffic.inBps, 0);
});

/* ── DEV-03 ────────────────────────────────────────────────────────────── */
test('DEV-03 슬롯 전원(ecb › Linecard N)은 PSU 로 세지 않는다 — partial 이 굳지 않고 이중 계수도 없다', async () => {
  const P = await import('../src/cvp/parse.js');
  const { cvpDevicePower } = await import('../src/power/total.js');
  const base = () => [
    { kind: 'psu', name: 'PowerSupply1', state: 'ok', power: { inW: 600, outW: 550, capW: 3000 } },
    { kind: 'psu', name: 'PowerSupply2', state: 'ok', power: { inW: 610, outW: 560, capW: 3000 } },
    { kind: 'psu', name: 'ecb › Linecard3', state: 'ok' },
    { kind: 'psu', name: 'ecb › Linecard4', state: 'ok' },
  ];
  // 수집 경로(judgeSlotPower 가 role 을 붙인다)
  const judged = P.judgeSlotPower(base(), {});
  assert.ok(judged.filter((p) => p.role === 'slot-power').length === 2);
  const a = P.devicePower(judged);
  assert.equal(a.partial, false, '정상 PSU 2대를 다 읽었다 — 슬롯 항목 때문에 일부만 읽음이 되지 않는다');
  assert.equal(a.psus, 2); assert.equal(a.read, 2); assert.equal(a.watts, 1210);
  assert.equal(a.capW, 6000, '정격도 PSU 만');
  assert.equal(a.slotEntries, 2, '뺀 슬롯 항목 수를 밝힌다');
  // role 이 없는 옛 저장값(v2.648 이전 수집)도 이름으로 가른다
  const old = P.devicePower(base());
  assert.equal(old.partial, false); assert.equal(old.psus, 2);
  // 슬롯 항목에 power 값이 있어도 PSU 입력 합에 더하지 않는다(이중 계수 금지)
  const withPw = base(); withPw[2].power = { inW: null, outW: 220, capW: null }; withPw[2].role = 'slot-power';
  const b = P.devicePower(withPw);
  assert.equal(b.watts, 1210); assert.equal(b.basis, 'input'); assert.equal(b.read, 2);
  // 전체 소비 전력도 같은 판정
  const c = cvpDevicePower({ partsList: withPw });
  assert.equal(c.watts, 1210); assert.equal(c.psus, 2); assert.equal(c.partial, undefined, '온전하면 partial 필드를 싣지 않는다(예전 모양)');
  // 전력에 셀 PSU 목록(화면의 '못 읽음' 사유 분류용)
  assert.deepEqual(P.powerSupplies(withPw).map((p) => p.name), ['PowerSupply1', 'PowerSupply2']);
  // 슬롯 항목만 있으면 PSU 가 없다(값이 있어도 PSU 전력이 아니다)
  assert.equal(P.devicePower([withPw[2], withPw[3]]), null);
  // 진짜 PSU 하나를 못 읽었으면 여전히 partial(슬롯 제외가 진짜 부분 합을 숨기지 않는다)
  const half = base(); delete half[1].power;
  const h = P.devicePower(half);
  assert.equal(h.partial, true); assert.equal(h.psus, 2); assert.equal(h.read, 1);
});

/* ── LEFT-05 ───────────────────────────────────────────────────────────── */
test('LEFT-05 장비 전력 계산은 한 벌 — 전체 소비 전력 합 = CVP 전력 탭 합(parse.devicePower, 반올림은 표시 단계에서만)', async () => {
  const P = await import('../src/cvp/parse.js');
  const { buildPowerTotal, cvpDevicePower } = await import('../src/power/total.js');
  const now = Math.floor(Date.now() / H) * H - 30 * MIN;
  const rows = [];
  for (let i = 0; i < 173; i++) {
    rows.push({ cvpId: 'c1', key: `sw${i}`, hostname: `sw${i}`, model: 'X', agent: '', streaming: true, telemetry: 'ok', collectedAt: now - MIN, partsAt: now - 10 * MIN,
      corp: { corpId: i % 2 ? 'HG' : 'NJ' },
      partsList: [{ kind: 'psu', state: 'ok', power: { inW: 123.4 + (i % 7) * 0.1 } }, { kind: 'psu', state: 'ok', power: { outW: 98.45 } }] });
  }
  const r = buildPowerTotal({ now, network: rows, cvpOpts: { intervalMs: 5 * MIN } });
  // CVP 전력 탭(routes/api/cvp.js)은 parse.devicePower 의 watts 를 반올림 없이 더한다.
  const tab = rows.reduce((s, d) => s + P.devicePower(d.partsList).watts, 0);
  assert.equal(r.network.measured, 173);
  assert.equal(r.network.watts, Math.round(tab), `두 화면의 합계가 같아야 한다(탭 ${tab.toFixed(1)} W · 전체 소비 전력 ${r.network.watts} W)`);
  const corpSum = r.byCorp.reduce((s, c) => s + c.network, 0);
  assert.ok(Math.abs(corpSum - tab) <= r.byCorp.length, '법인별 합도 같은 값(법인마다 표시 반올림만)');
  // 장비 행의 watts 는 표시용으로 반올림한다(서버·스토리지 행과 같은 규칙)
  assert.ok(r.network.items.every((x) => Number.isInteger(x.watts)));
  // 범위 밖 값은 두 경로 모두 못 읽음(같은 함수)
  const bad = [{ kind: 'psu', state: 'ok', power: { inW: -5 } }, { kind: 'psu', state: 'ok', power: { inW: 2e6 } }];
  assert.equal(P.devicePower(bad), null, '음수·비현실 값은 PSU 값이 아니다');
  assert.equal(cvpDevicePower({ partsList: bad }).watts, null);
  // cvpDevicePower 는 parse.devicePower 의 표시용 사본이다(같은 판정 · watts 만 반올림)
  for (const d of rows.slice(0, 10)) {
    const a = P.devicePower(d.partsList); const b = cvpDevicePower(d);
    assert.equal(b.watts, Math.round(a.watts)); assert.equal(b.psus, a.psus); assert.equal(b.read, a.read); assert.equal(b.basis, a.basis);
  }
});

/* ── LEFT-08 ───────────────────────────────────────────────────────────── */
const SERVERS = 1000;
const SENSORS = 150;
const mkSensors = (s) => {
  const list = [];
  for (let i = 0; i < SENSORS; i++) {
    list.push({ name: `System Board Temp Sensor ${i}`, kind: i % 10 === 0 ? 'percent' : 'temperature', reading: 25 + ((s + i) % 30), unit: 'Cel',
      health: 'OK', context: 'SystemBoard', thresholds: { warnMin: 8, warnMax: 80, critMin: 3, critMax: 90 } });
  }
  return list;
};

test('LEFT-08 디바운스 저장이 이벤트 루프를 오래 막지 않는다(조각 직렬화 + 비동기 쓰기) · 결과는 전량 JSON 과 같다', async (t) => {
  const C = await import('../src/idrac/sensorDetailCache.js');
  const { compactSensor } = await import('../src/idrac/sensorDetail.js');
  const file = path.join(DIR, 'idrac-sensor-cache.json');
  C._resetSensorDetailForTest();
  try { fs.rmSync(file); } catch { /* 없음 */ }
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let s = 0; s < SERVERS; s++) C.setSensorCollection(`srv-${s}`, { ok: true, sensors: mkSensors(s) }, 1_000_000 + s);
    assert.equal(fs.existsSync(file), false, '디바운스 동안은 쓰지 않는다');
    // 기준 — 같은 모양(콤팩트 센서)의 데이터를 한 번에 직렬화하는 데 드는 시간(이 기계에서). 동기 저장은 이것 + 동기 쓰기만큼 루프를 막는다.
    const same = {};
    for (let s = 0; s < SERVERS; s++) same[`srv-${s}`] = { at: 1_000_000 + s, ok: true, sensors: mkSensors(s).map(compactSensor), sensorsAt: 1_000_000 + s, chassis: null, absent: 0, failed: 0, expanded: 0, notRead: 0 };
    const t0 = performance.now();
    const probe = JSON.stringify(same);
    const tFull = performance.now() - t0;
    assert.ok(probe.length > 5e6, `합성 캐시가 충분히 커야 한다(${probe.length}자)`);

    // 디바운스 타이머를 실제 경로로 울린다(60초). 동기 저장이면 tick 안에서 전량 직렬화·쓰기가 끝난다.
    const tk0 = performance.now();
    mock.timers.tick(C.PERSIST_DEBOUNCE_MS);
    let maxStall = performance.now() - tk0;
    // 쓰기가 끝날 때까지 루프 한 바퀴씩 돌며 가장 긴 정지를 잰다(setImmediate 는 가짜 타이머가 아니다).
    const deadline = performance.now() + 60_000;
    let last = performance.now();
    while (performance.now() < deadline) {
      await nextTurn();
      const t = performance.now(); maxStall = Math.max(maxStall, t - last); last = t;
      const st = C.sensorDetailWriteStatus?.();
      if (fs.existsSync(file) && (!st || (!st.writing && !st.dirty))) break;
    }
    const limit = Math.max(50, tFull * 0.5);
    t.diagnostic(`최장 정지 ${maxStall.toFixed(1)}ms · 한계 ${limit.toFixed(1)}ms · 전량 직렬화 ${tFull.toFixed(1)}ms · ${(probe.length / 1e6).toFixed(1)}M자`);
    assert.ok(maxStall < limit, `저장 중 최장 정지 ${maxStall.toFixed(1)}ms 는 ${limit.toFixed(1)}ms 미만이어야 한다(전량 직렬화 ${tFull.toFixed(1)}ms)`);
    const txt = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(txt);
    assert.equal(Object.keys(obj).length, SERVERS);
    assert.equal(obj['srv-7'].sensors.length, SENSORS);
    assert.equal(obj['srv-7'].sensors[0].v, 25 + 7);
    // 재시작 뒤 읽기 — 같은 내용
    C._resetSensorDetailForTest();
    const d = C.localSensorDetail('srv-999');
    assert.ok(d && d.collection && d.collection.count === SENSORS, '저장한 파일을 다시 읽는다');
    assert.equal((fs.statSync(file).mode & 0o777), 0o600, '0600');
    assert.deepEqual(fs.readdirSync(DIR).filter((n) => n.includes('.atmp-')), [], '임시 파일을 남기지 않는다');
  } finally {
    mock.timers.reset();
    C._resetSensorDetailForTest();
  }
});

test('LEFT-08 종료 flush(동기)가 진행 중인 비동기 쓰기를 대체한다 — 늦게 끝난 옛 본문이 새 본문을 덮지 않는다', async () => {
  const C = await import('../src/idrac/sensorDetailCache.js');
  assert.equal(typeof C.flushSensorDetailNow, 'function', '종료 flush 와 같은 동기 저장을 내보낸다');
  const file = path.join(DIR, 'idrac-sensor-cache.json');
  C._resetSensorDetailForTest();
  try { fs.rmSync(file); } catch { /* 없음 */ }
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let s = 0; s < 600; s++) C.setSensorCollection(`old-${s}`, { ok: true, sensors: mkSensors(s) }, 1000);
    mock.timers.tick(C.PERSIST_DEBOUNCE_MS);           // 비동기 쓰기 시작(옛 본문)
    // 비동기 쓰기가 첫 조각을 임시 파일에 쓸 때까지 기다린다 — 그 시점에 쓸 키 목록이 정해졌다(그 뒤 추가된 키는 이 쓰기에 없다).
    const t0 = performance.now(); let started = false;
    while (!started && performance.now() - t0 < 30_000) {
      await nextTurn();
      started = fs.readdirSync(DIR).some((n) => n.includes('.atmp-') && fs.statSync(path.join(DIR, n)).size > 0);
    }
    assert.ok(started, '비동기 쓰기가 조각을 쓰기 시작했다(이 시험의 전제)');
    assert.equal(C.sensorDetailWriteStatus().writing, true, '비동기 쓰기가 진행 중일 때 대체한다(이 시험의 전제)');
    C.setSensorCollection('new-1', { ok: true, sensors: mkSensors(1).slice(0, 3) }, 2000); // 쓰는 동안 바뀐다
    C.flushSensorDetailNow();                          // 종료 flush — 동기로 지금 값을 쓴다
    const st = C.sensorDetailWriteStatus();
    // 옛 비동기 쓰기가 끝날 때까지 기다린다
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) { await nextTurn(); if (!C.sensorDetailWriteStatus().writing) break; }
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(obj['new-1'], '동기 flush 가 쓴 새 본문이 남는다(늦게 끝난 비동기 쓰기가 덮지 않는다)');
    assert.equal(Object.keys(obj).length, 601);
    assert.equal(typeof st.writes, 'number');
    assert.deepEqual(fs.readdirSync(DIR).filter((n) => n.includes('.atmp-')), [], '대체된 비동기 쓰기의 임시 파일을 남기지 않는다');
  } finally {
    mock.timers.reset();
    C._resetSensorDetailForTest();
  }
});

test('LEFT-08 쓰기 실패는 조용히 버리지 않는다 — 다음 변경·종료 flush 가 다시 쓴다(dirty 유지) · 원문 경로는 상태에 싣지 않는다', async () => {
  const C = await import('../src/idrac/sensorDetailCache.js');
  C._resetSensorDetailForTest();
  const file = path.join(DIR, 'idrac-sensor-cache.json');
  try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* 없음 */ }
  fs.mkdirSync(file); // 같은 이름의 디렉터리 — rename 이 실패한다
  const warn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    C.setSensorCollection('f-1', { ok: true, sensors: mkSensors(1).slice(0, 2) }, 1000);
    mock.timers.tick(C.PERSIST_DEBOUNCE_MS);
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) { await nextTurn(); if (!C.sensorDetailWriteStatus().writing) break; }
    const st = C.sensorDetailWriteStatus();
    assert.equal(st.dirty, true, '실패한 변경은 다음 쓰기 대상으로 남는다');
    assert.equal(st.failures, 1);
    assert.ok(st.lastError && typeof st.lastError.code === 'string');
    assert.ok(!JSON.stringify(st).includes(DIR), '임시 파일 절대 경로를 상태에 싣지 않는다');
    assert.ok(warned.some((w) => w.includes('센서 상세 캐시')), '콘솔에 남긴다(무음 실패 금지)');
    assert.deepEqual(fs.readdirSync(DIR).filter((n) => n.includes('.atmp-')), [], '실패한 쓰기의 임시 파일을 지운다');
  } finally {
    console.warn = warn;
    mock.timers.reset();
    fs.rmSync(file, { recursive: true, force: true });
    C._resetSensorDetailForTest();
  }
});
