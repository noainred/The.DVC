/**
 * v2.519 — SAN 스위치 월간 점검 판정 회귀.
 *
 * 사용자가 정리해 준 Brocade 월간 점검 체크리스트(2026-09-15)를 항목화한 기능이다.
 *
 * ⚠ 이 테스트가 고정하는 **제1 원칙**: **'확인하지 못함' 을 '이상 없음' 으로 뭉개지 않는다.**
 *   점검 보고서는 사람이 "이번 달 이상 없음" 이라고 결재하는 근거다. 명령이 없어서 못 봤는데
 *   '정상' 으로 칠하면 이 기능이 만들 수 있는 가장 위험한 거짓이다. 실제로 이 현장 스위치는
 *   `rbash: switchstatusshow: command not found` 라 체크리스트 1단계 핵심 항목을 볼 수 없다
 *   (사용자 제공 스크린샷) — 그 경우가 아래 '확인 불가' 테스트다.
 *
 * ⚠ 제2 원칙: 임계값을 지어내지 않는다. 온도·전압은 **스위치 자신의 센서 상태**를 따른다.
 * ⚠ 제3 원칙: 누적 카운터를 '지금 나쁘다' 로 읽지 않는다 — 기준선이 없으면 당월 신규를 판정하지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanhealth-'));
process.env.CONFIG_DIR = tmp;

const H = await import('../src/sanswitch/healthCheck.js');
const B = await import('../src/sanswitch/errBaseline.js');
const P = await import('../src/sanswitch/collectors/fosParse.js');

const ALL_OK_SECTIONS = { ports: 'ok', chassis: 'ok', counters: 'ok', sfp: 'ok', health: 'ok', sensors: 'ok', raslog: 'ok', bottleneck: 'ok', fabric: 'ok' };

const snapOf = (over = {}) => ({
  deviceId: 'd1', name: 'SW-A', host: '10.0.0.1', ok: true, switchState: 'Online',
  collectedAt: 1_700_000_000_000, model: 'G620', fabricOs: 'v9.2.0c3', serial: 'SYN1', domainId: 2,
  sections: { ...ALL_OK_SECTIONS, ...(over.sections || {}) },
  health: { status: 'HEALTHY', psus: { ok: 2, total: 2 }, fans: { ok: 3, total: 3 }, monitors: {}, ...(over.health || {}) },
  ports: {
    online: 2, licensed: 4, free: 2, portsOmitted: 0,
    list: [
      { index: 0, state: 'online', rxPowerDbm: -2.1, errCrc: 0, errEncOut: 0, errLossSync: 0, discC3: 0 },
      { index: 1, state: 'online', rxPowerDbm: -3.0, errCrc: 0, errEncOut: 0, errLossSync: 0, discC3: 0 },
    ],
    ...(over.ports || {}),
  },
  extra: {
    sensors: { parsed: true, list: [{ n: 1, kind: 'temperature', name: 'Left', state: 'Ok', ok: true, value: 31, unit: 'C', raw: 's1' }], counts: { total: 1, ok: 1, bad: 0, unknown: 0, absent: 0 } },
    raslog: { parsed: true, list: [], counts: { total: 0, critical: 0, error: 0, warning: 0, info: 0, unknown: 0 } },
    bottleneck: { parsed: true, enabled: true, none: true, ports: [], note: 'No bottleneck detected' },
    fabricMembers: { parsed: true, switches: [{ domain: 2, name: 'SW-A', wwn: 'x' }], count: 1, principal: 2 },
    ...(over.extra || {}),
  },
  // ⚠ 최상위 키(switchState·ok·error 등)도 반영한다 — 초판 헬퍼가 sections/health/ports/extra
  //   만 병합해 `snapOf({ switchState:'Offline' })` 가 조용히 무시됐다(테스트가 통과처럼 보였다).
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !['sections', 'health', 'ports', 'extra'].includes(k))),
});
const itemOf = (r, key) => r.items.find((i) => i.key === key);

/* ── 제1 원칙 — '확인 불가' 는 '정상' 이 아니다 ─────────────────────────────── */

test("명령이 없으면 '확인 불가' 이고 종합이 정상으로 흡수되지 않는다", () => {
  // 이 현장의 실제 상황: rbash 계정이라 switchstatusshow·licenseshow 가 없다.
  const r = H.checkDevice(snapOf({ sections: { health: 'skip', sensors: 'skip', raslog: 'skip', bottleneck: 'skip', fabric: 'skip' },
    extra: { sensors: null, raslog: null, bottleneck: null, fabricMembers: null } }));
  assert.equal(itemOf(r, 'switchStatus').status, 'unknown');
  assert.match(itemOf(r, 'switchStatus').detail, /명령이 없거나 계정 권한이 없습니다/);
  assert.equal(r.uncheckedCount, 5, '확인 불가 항목을 따로 센다');
  assert.ok(r.counts.ok > 0, '나머지는 정상으로 판정된다');
  // 종합은 확인한 항목 기준이지만 uncheckedCount 가 남아 화면·PDF 가 그것을 나란히 적는다.
  assert.equal(r.overall, 'ok');
  assert.equal(r.counts.unknown, 5);
});

test('실행 실패와 명령 부재를 구분한다(조치가 다르다)', () => {
  const skip = H.checkDevice(snapOf({ sections: { health: 'skip' } }));
  const fail = H.checkDevice(snapOf({ sections: { health: 'rbash: switchstatusshow: command not found' } }));
  assert.match(itemOf(skip, 'switchStatus').detail, /명령이 없거나/);
  assert.match(itemOf(fail, 'switchStatus').detail, /실행 실패: rbash/);
});

test('수집이 실패한 스냅샷은 모든 항목이 확인 불가이고 종합도 unknown', () => {
  const r = H.checkDevice({ ...snapOf(), ok: false, error: 'Timed out while waiting for handshake' });
  assert.equal(r.overall, 'unknown');
  assert.equal(r.collectFailed, true);
  assert.equal(r.uncheckedCount, H.CHECK_ITEMS.length);
  assert.ok(r.items.every((i) => i.status === 'unknown'));
  assert.match(r.items[0].detail, /Timed out/);
});

test('판정 가능한 항목이 하나도 없으면 종합은 unknown(정상이라 말할 근거가 없다)', () => {
  const allSkip = Object.fromEntries(Object.keys(ALL_OK_SECTIONS).map((k) => [k, 'skip']));
  const r = H.checkDevice({ ...snapOf({ sections: allSkip, extra: { sensors: null, raslog: null, bottleneck: null, fabricMembers: null } }),
    switchState: '', health: { status: '', psus: null, fans: null, monitors: {} }, ports: { list: [], portsOmitted: 0 } });
  assert.equal(r.overall, 'unknown');
  assert.equal(r.counts.ok, 0);
});

test('팬·PSU 를 개수만 아는 경우는 정상이 아니라 확인 불가다', () => {
  const r = H.checkDevice(snapOf({ health: { psus: { ok: null, total: 2 }, fans: { ok: null, total: 3 } } }));
  assert.equal(itemOf(r, 'psu').status, 'unknown');
  assert.match(itemOf(r, 'psu').detail, /장착돼 있다는 것만 확인/);
  assert.equal(itemOf(r, 'fan').status, 'unknown');
});

test('bottleneckmon 이 꺼져 있으면 정상이 아니라 확인 불가다', () => {
  const r = H.checkDevice(snapOf({ extra: { bottleneck: { parsed: true, enabled: false, none: false, ports: [], note: 'not enabled' } } }));
  assert.equal(itemOf(r, 'slowDrain').status, 'unknown');
  assert.match(itemOf(r, 'slowDrain').detail, /꺼져 있어 Slow Drain 여부를 알 수 없습니다/);
});

test('출력 형식을 못 읽은 것도 확인 불가다(정상 아님)', () => {
  const r = H.checkDevice(snapOf({ extra: { sensors: { parsed: false, list: [], counts: {} } } }));
  assert.equal(itemOf(r, 'sensors').status, 'unknown');
  assert.match(itemOf(r, 'sensors').detail, /형식을 읽지 못했습니다/);
});

/* ── 제2 원칙 — 임계값을 지어내지 않는다 ───────────────────────────────────── */

test('온도 판정은 스위치 센서 상태를 따른다(포탈이 숫자를 정하지 않는다)', () => {
  // 80℃ 라도 장비가 Ok 라고 하면 정상이다 — 모델마다 임계가 다르다.
  const hot = H.checkDevice(snapOf({ extra: { sensors: { parsed: true, counts: { total: 1, ok: 1, bad: 0, unknown: 0, absent: 0 },
    list: [{ n: 1, kind: 'temperature', name: 'L', state: 'Ok', ok: true, value: 80, unit: 'C', raw: 'r' }] } } }));
  assert.equal(itemOf(hot, 'sensors').status, 'ok');
  assert.match(itemOf(hot, 'sensors').detail, /최고 온도 80℃/, '측정값은 정보로 싣는다');
  // 장비가 Faulty 라고 하면 값이 낮아도 이상이다.
  const bad = H.checkDevice(snapOf({ extra: { sensors: { parsed: true, counts: { total: 1, ok: 0, bad: 1, unknown: 0, absent: 0 },
    list: [{ n: 1, kind: 'fan', name: 'Fan 1', state: 'Faulty', ok: false, value: 0, unit: 'RPM', raw: 'sensor 1: (Fan) Fan 1 is Faulty' }] } } }));
  assert.equal(itemOf(bad, 'sensors').status, 'bad');
  assert.deepEqual(itemOf(bad, 'sensors').evidence, ['sensor 1: (Fan) Fan 1 is Faulty']);
});

test('광량은 화면과 같은 기준(-9 주의 / -12 이상)을 쓴다', () => {
  assert.equal(H.RX_WARN_DBM, -9);
  assert.equal(H.RX_BAD_DBM, -12);
  const warn = H.checkDevice(snapOf({ ports: { list: [{ index: 0, state: 'online', rxPowerDbm: -10.5 }] } }));
  assert.equal(itemOf(warn, 'optical').status, 'warn');
  const bad = H.checkDevice(snapOf({ ports: { list: [{ index: 0, state: 'online', rxPowerDbm: -13.4, attachedName: 'ARRAY::SPA0' }] } }));
  assert.equal(itemOf(bad, 'optical').status, 'bad');
  assert.match(itemOf(bad, 'optical').evidence[0], /포트 0: Rx -13\.4 dBm \(ARRAY::SPA0\)/);
});

/* ── 제3 원칙 — 누적 카운터와 당월 신규를 구분한다 ─────────────────────────── */

test('기준선이 없으면 당월 신규를 판정하지 않고 그 사실을 말한다', () => {
  const r = H.checkDevice(snapOf({ ports: { list: [{ index: 0, state: 'online', errCrc: 40000, errEncOut: 0, errLossSync: 0, discC3: 0 }] } }));
  const it = itemOf(r, 'portErrors');
  assert.equal(it.status, 'warn', '누적이 있으면 주의까지만 — 이상이라 단정하지 않는다');
  assert.equal(it.needBaseline, true);
  assert.match(it.detail, /기준선이 없어 '당월 신규' 를 판정할 수 없습니다/);
});

test('기준선이 있으면 그 이후 신규분으로 판정한다', () => {
  const ports = { list: [{ index: 0, state: 'online', errCrc: 40010, errEncOut: 0, errLossSync: 0, discC3: 0 }] };
  const baseline = { at: 1, ports: { 0: { errCrc: 40000, errEncOut: 0, errLossSync: 0, discC3: 0 } } };
  const r = H.checkDevice(snapOf({ ports }), { baseline });
  const it = itemOf(r, 'portErrors');
  assert.equal(it.status, 'warn', '신규 10건 → 주의');
  assert.match(it.detail, /기준선 이후 신규 에러가 있는 포트 1개/);
  assert.match(it.evidence[0], /신규 10/);
  // 100건 이상은 이상으로 올린다.
  const heavy = H.checkDevice(snapOf({ ports: { list: [{ index: 0, state: 'online', errCrc: 40200, errEncOut: 0, errLossSync: 0, discC3: 0 }] } }), { baseline });
  assert.equal(itemOf(heavy, 'portErrors').status, 'bad');
});

test('기준선 이후 변화가 없으면 정상 — 몇 년치 누적에 매달 경고하지 않는다', () => {
  const baseline = { at: 1, ports: { 0: { errCrc: 40000 } } };
  const r = H.checkDevice(snapOf({ ports: { list: [{ index: 0, state: 'online', errCrc: 40000, errEncOut: 0, errLossSync: 0, discC3: 0 }] } }), { baseline });
  assert.equal(itemOf(r, 'portErrors').status, 'ok');
  assert.match(itemOf(r, 'portErrors').detail, /새로 발생한 에러가 없습니다/);
});

test('카운터 리셋(음수 델타)은 0 이 아니라 null — 새 에러 없음으로 둔갑시키지 않는다', () => {
  assert.equal(H.errorDelta(5, 10), null, '리셋');
  assert.equal(H.errorDelta(10, 5), 5);
  assert.equal(H.errorDelta(10, null), null, '기준선 없음 = 모름');
  assert.equal(H.errorDelta(null, 5), null, '현재값 없음 = 모름');
  assert.equal(H.errorDelta(10, 10), 0, '변화 없음은 0 이다(모름과 다르다)');
});

test('기준선은 카운터를 못 읽은 포트를 넣지 않는다(다음 점검이 누적을 신규로 오판하지 않게)', () => {
  const b = B.baselineFromSnapshot({ collectedAt: 5, ports: { portsOmitted: 0, list: [{ index: 0, errCrc: 3 }, { index: 1 }] } });
  assert.deepEqual(Object.keys(b.ports), ['0']);
  assert.equal(b.portCount, 1);
  assert.equal(b.portsComplete, true);
  // 엣지가 문제 포트만 올린 스냅샷으로 만든 기준선임을 기록한다.
  const partial = B.baselineFromSnapshot({ collectedAt: 5, ports: { portsOmitted: 120, list: [{ index: 3, errCrc: 1 }] } });
  assert.equal(partial.portsComplete, false);
});

/* ── 포트 목록이 불완전할 때 단정하지 않는다 ───────────────────────────────── */

test('엣지가 문제 포트만 올린 스냅샷은 포트 판정을 단정하지 않는다', () => {
  const r = H.checkDevice(snapOf({ ports: { portsOmitted: 125, list: [{ index: 3, state: 'online', rxPowerDbm: -2 }] } }));
  const it = itemOf(r, 'ports');
  assert.equal(it.status, 'warn', '장애가 없어도 목록이 불완전하면 정상이라 단정하지 않는다');
  assert.match(it.detail, /일부 포트만 올라와 있어\(125개 누락\)/);
});

/* ── 종합·요약 ────────────────────────────────────────────────────────────── */

test('이상이 하나라도 있으면 종합은 이상', () => {
  const r = H.checkDevice(snapOf({ switchState: 'Offline' }));
  assert.equal(itemOf(r, 'switchState').status, 'bad');
  assert.equal(r.overall, 'bad');
});

test('RASLog 는 심각도별로 등급을 나누고 보관 범위를 단정하지 않는다', () => {
  const crit = H.checkDevice(snapOf({ extra: { raslog: { parsed: true, counts: { total: 3, critical: 1, error: 0, warning: 0, info: 2, unknown: 0 },
    list: [{ id: 'HIL-1507', at: '2026/09/15-11:05:00', severity: 'critical', text: 'fan failure' }] } } }));
  assert.equal(itemOf(crit, 'raslog').status, 'bad');
  // '최근 1개월' 이라 말하지 않는다 — errdump 는 보관 범위를 스스로 밝히지 않는다.
  assert.match(itemOf(crit, 'raslog').detail, /보관된 로그/);
  assert.ok(!/최근 1개월|한 달/.test(itemOf(crit, 'raslog').detail));
});

test('summarizeAll — 이상·주의·확인불가를 각각 센다', () => {
  const ok = H.checkDevice(snapOf());
  const bad = H.checkDevice(snapOf({ switchState: 'Offline' }));
  const unk = H.checkDevice({ ...snapOf(), ok: false, error: 'x' });
  const s = H.summarizeAll([ok, bad, unk]);
  assert.equal(s.devices, 3);
  assert.equal(s.byOverall.ok, 1);
  assert.equal(s.byOverall.bad, 1);
  assert.equal(s.byOverall.unknown, 1);
  assert.ok(s.uncheckedItems >= H.CHECK_ITEMS.length);
});

test('항목 정의는 체크리스트 4단계를 모두 덮는다', () => {
  const stages = new Set(H.CHECK_ITEMS.map((i) => i.stage));
  assert.deepEqual([...stages].sort(), [1, 2, 3, 4]);
  // 사용자 체크리스트의 명령이 전부 항목으로 들어가 있는지.
  const cmds = H.CHECK_ITEMS.map((i) => i.cmd).join(' ');
  for (const c of ['switchstatusshow', 'psshow', 'fanshow', 'sensorshow', 'switchshow', 'sfpshow', 'porterrshow', 'bottleneckmon', 'errdump', 'fabricshow']) {
    assert.match(cmds, new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `체크리스트 명령 누락: ${c}`);
  }
});

/* ── 신규 파서 4종 ───────────────────────────────────────────────────────── */

test('parseSensorShow — 종류·상태·측정값을 뽑고 Absent 를 장애로 세지 않는다', () => {
  const r = P.parseSensorShow([
    'sensor  1: (Temperature) Left is Ok, value is 31 C',
    'sensor  4: (Fan         ) Fan 1 is Ok, speed is 6960 RPM',
    'sensor  7: (Power Supply) Power Supply 1 is Ok',
    'sensor  8: (Power Supply) Power Supply 2 is Absent',
  ].join('\n'));
  assert.equal(r.parsed, true);
  assert.equal(r.counts.total, 4);
  assert.equal(r.counts.ok, 3);
  assert.equal(r.counts.absent, 1);
  assert.equal(r.counts.bad, 0, '미장착은 장애가 아니다');
  assert.equal(r.list[0].value, 31);
  assert.equal(r.list[1].unit, 'RPM');
});

test('parseSensorShow — 형식을 못 읽으면 parsed:false(정상으로 넘기지 않는다)', () => {
  assert.equal(P.parseSensorShow('rbash: sensorshow: command not found').parsed, false);
  assert.equal(P.parseSensorShow('').parsed, false);
});

test('parseErrDump — 심각도 정규화와 상한', () => {
  const r = P.parseErrDump([
    '2026/09/15-10:23:45, [SEC-3020], 1, FID 128, INFO, SW01, Login',
    '2026/09/15-11:00:01, [FW-1424], 2, FID 128, WARNING, SW01, temp',
    '2026/09/15-11:05:00, [HIL-1507], 3, FID 128, CRITICAL, SW01, fan',
    '헤더나 잡음 줄은 무시된다',
  ].join('\n'));
  assert.equal(r.parsed, true);
  assert.deepEqual([r.counts.info, r.counts.warning, r.counts.critical], [1, 1, 1]);
  assert.equal(r.list.length, 3);
  const many = P.parseErrDump(Array.from({ length: 500 }, (_, i) => `2026/01/01-00:00:00, [X-${i % 90}], ${i}, FID 128, INFO, S, m`).join('\n'), 50);
  assert.equal(many.list.length, 50, '상한을 넘기지 않는다');
  assert.equal(many.counts.total, 500, '개수는 전체 기준을 유지한다');
});

test('parseBottleneckMon — 꺼짐/감지없음/감지를 구분한다', () => {
  assert.equal(P.parseBottleneckMon('Bottleneck detection is not enabled').enabled, false);
  const none = P.parseBottleneckMon('Bottleneck detection - Enabled\nNo bottleneck detected');
  assert.equal(none.enabled, true); assert.equal(none.none, true); assert.equal(none.ports.length, 0);
  assert.equal(P.parseBottleneckMon('').parsed, false);
});

test('parseFabricShow — 도메인·principal 을 읽는다', () => {
  const r = P.parseFabricShow([
    ' Switch ID   Worldwide Name           Enet IP Addr    FC IP Addr         Name',
    '   1: fffc01 10:00:00:05:1e:aa:bb:cc 10.1.1.1        0.0.0.0            "SW-A"',
    '>  2: fffc02 10:00:00:05:1e:aa:bb:dd 10.1.1.2        0.0.0.0            "SW-B"',
  ].join('\n'));
  assert.equal(r.parsed, true);
  assert.equal(r.count, 2);
  assert.equal(r.principal, 2);
  assert.equal(r.switches[0].name, 'SW-A');
});

test('수집 명령 목록에 새 4종이 들어가고 errshow 는 주 명령이 아니다', () => {
  const src = fs.readFileSync(new URL('../src/sanswitch/collectors/fosSsh.js', import.meta.url), 'utf8');
  for (const k of ['sensorshow', 'errdump', 'bottleneckmon', 'fabricshow']) assert.match(src, new RegExp(`key: '${k}'`));
  // ⚠ FOS 의 `errshow` 는 대화형(페이저)이라 폴러가 부르면 캡처가 시한까지 매달린다.
  assert.match(src, /bin: 'errdump'/, 'errdump 가 주 명령이어야 한다');
  const spec = src.slice(src.indexOf("key: 'errdump'"), src.indexOf("key: 'bottleneckmon'"));
  assert.ok(spec.indexOf("c('errdump')") < spec.indexOf("c('errshow')"), 'errdump 를 먼저 시도해야 한다');
});
