/**
 * v2.410 회귀 테스트 — SAN 스위치(Brocade Fabric OS) 모니터링.
 *
 * 실장비가 없으므로 **검증 가능한 것만** 고정한다: CLI 출력 파싱, 포트 요약 규칙, 중앙 push
 * 축약, 등록부 보안 불변조건. 아래 CLI 샘플은 공개 문서의 출력 형식을 옮긴 것이며 실장비로
 * 검증하지 않았다 — 현장 출력으로 교정할 때 무엇이 깨지는지 드러나도록 여기 고정해 둔다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sansw-'));

// ── 픽스드 스위치(6510 류) switchshow 샘플 ────────────────────────────────────
const SWITCHSHOW_FIXED = `switchName:\tSAN_A_01
switchType:\t109.1
switchState:\tOnline
switchMode:\tNative
switchRole:\tPrincipal
switchDomain:\t1
switchId:\tfffc01
switchWwn:\t10:00:00:05:1e:aa:bb:cc
zoning:\t\tON (PROD_CFG)
switchBeacon:\tOFF

Index Port Address Media Speed State     Proto
==============================================
  0   0   010000   id    N16\t  Online      FC  F-Port  50:06:0b:00:00:11:22:33
  1   1   010100   id    N8\t  Online      FC  F-Port  21:00:00:24:ff:aa:bb:cc
  2   2   010200   --    N32\t  No_Module   FC
  3   3   010300   id    --\t  Disabled    FC
  4   4   010400   id    N16\t  Online      FC  E-Port  10:00:00:05:1e:99:88:77
 12  12   010c00   --    --      No_License  FC
`;

// 디렉터(X6/DCX 류) — Slot 열이 하나 더 있다.
const SWITCHSHOW_DIRECTOR = `switchName:\tDIR_01
switchState:\tOnline
switchDomain:\t5

Index Slot Port Address Media Speed State     Proto
===================================================
  16   1  0   020000   id    N32\t  Online      FC  E-Port  10:00:00:05:1e:99:88:77
  17   1  1   020100   id    N16\t  No_Light    FC
 272   4  0   100000   id    N32\t  Online      FC  F-Port  50:06:0b:00:00:aa:bb:cc
`;

test('parseSwitchShow: 픽스드 스위치의 헤더와 포트를 읽는다', async () => {
  const { parseSwitchShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const r = parseSwitchShow(SWITCHSHOW_FIXED);
  assert.equal(r.hasSlot, false);
  assert.equal(r.header.switchName, 'SAN_A_01');
  assert.equal(r.header.switchDomain, '1');
  assert.equal(r.ports.length, 6);
  assert.deepEqual(r.ports[0], {
    index: 0, slot: null, port: 0, slotPort: '0', address: '010000', media: 'id',
    speed: '16G', state: 'online', stateRaw: 'Online', portType: 'F-Port',
    attached: ['50:06:0b:00:00:11:22:33'], comment: '',
  });
  assert.equal(r.ports[4].portType, 'E-Port');   // ISL
});

test('parseSwitchShow: 디렉터의 Slot 열을 인식한다(하드코딩하면 전 포트가 한 칸씩 밀린다)', async () => {
  const { parseSwitchShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const r = parseSwitchShow(SWITCHSHOW_DIRECTOR);
  assert.equal(r.hasSlot, true);
  assert.equal(r.ports[0].slotPort, '1/0');
  assert.equal(r.ports[0].state, 'online');
  assert.equal(r.ports[0].speed, '32G');
  assert.equal(r.ports[2].slotPort, '4/0');
  assert.equal(r.ports[1].state, 'offline');     // No_Light = 비어 있음
});

test('normalizePortState: No_License 를 별도 상태로 분류한다(여유 포트 계산의 근거)', async () => {
  const { normalizePortState } = await import('../src/sanswitch/collectors/fosParse.js');
  assert.equal(normalizePortState('Online'), 'online');
  assert.equal(normalizePortState('No_License'), 'noLicense');
  assert.equal(normalizePortState('No_Light'), 'offline');
  assert.equal(normalizePortState('No_Module'), 'offline');
  assert.equal(normalizePortState('Disabled'), 'disabled');
  assert.equal(normalizePortState('Laser_Flt'), 'faulty');
  assert.equal(normalizePortState('Port_Flt'), 'faulty');
});

test('summarizePorts: 라이선스 없는 포트를 분모와 여유에서 뺀다', async () => {
  const { parseSwitchShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const { summarizePorts } = await import('../src/sanswitch/types.js');
  const s = summarizePorts(parseSwitchShow(SWITCHSHOW_FIXED).ports);
  assert.equal(s.total, 6);
  assert.equal(s.noLicense, 1);
  assert.equal(s.licensed, 5);          // 6 - 1
  assert.equal(s.online, 3);
  assert.equal(s.disabled, 1);
  assert.equal(s.offline, 1);           // No_Module
  assert.equal(s.free, 2);              // 5 - 3  ← 살 수 없는 12번 포트는 여유가 아니다
  assert.equal(s.usedPct, 60);
  assert.deepEqual(s.bySpeed, { '16G': 2, '8G': 1 });
});

test('parsePortErrShow: k/m/g 접미 카운터를 숫자로 읽고 포트별로 매핑', async () => {
  const { parsePortErrShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const txt = `          frames      enc    crc    crc    too   too    bad   enc   disc   link   loss   loss   frjt   fbsy
       tx     rx      in    err    g_eof  shrt  long   eof   out    c3    fail   sync   sig
  0:   1.2g   3.4g    0      0      0      0     0      0     0      0     0      0      0      0     0
  1:   500k   12m     0      7      7      0     0      0     3      0     2      1      0      0     0
`;
  const r = parsePortErrShow(txt);
  assert.equal(r[0].frames_tx, 1_200_000_000);
  assert.equal(r[0].frames_rx, 3_400_000_000);
  assert.equal(r[0].crc_err, 0);
  assert.equal(r[1].frames_tx, 500_000);
  assert.equal(r[1].crc_err, 7);
  assert.equal(r[1].enc_out, 3);
  assert.equal(r[1].link_fail, 2);
  assert.equal(r[1].loss_sync, 1);
});

test('parseSfpShow: 포트별 광레벨·온도·벤더를 읽는다', async () => {
  const { parseSfpShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const txt = `Port  0:
Identifier:  3    SFP
Vendor Name: BROCADE
Vendor PN:   57-1000012-01
Serial No:   HAA114000001
Wavelength:  850  (units nm)
Temperature: 42     Centigrade
Current:     8.164  mAmps
Voltage:     3305.6 mVolts
RX Power:    -3.2  dBm (479.2uW)
TX Power:    -2.9  dBm (511.4 uW)

Port  1:
Temperature: 39     Centigrade
RX Power:    -11.8 dBm (66.1 uW)
TX Power:    -2.7  dBm
`;
  const r = parseSfpShow(txt);
  assert.equal(r[0].tempC, 42);
  assert.equal(r[0].rxPowerDbm, -3.2);
  assert.equal(r[0].txPowerDbm, -2.9);
  assert.equal(r[0].vendor, 'BROCADE');
  assert.equal(r[0].serial, 'HAA114000001');
  assert.equal(r[1].rxPowerDbm, -11.8);
});

test('parseChassisShow: Chassis Family 가 있는 변형 — 모델명과 (CHASSIS 블록이 없으면) 블레이드 시리얼 폴백', async () => {
  const { parseChassisShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const r = parseChassisShow(`Chassis Family: 6510
Chassis Backplane Revision: 1
SW  BLADE Slot: 1
Factory Part Num: 40-1000616-05
Factory Serial Num: BRC0123456
`);
  assert.equal(r.model, '6510');
  assert.equal(r.serial, 'BRC0123456');
  assert.equal(r.partNumber, '40-1000616-05');
});

test('parseFirmwareShow / parseLicenseShow', async () => {
  const P = await import('../src/sanswitch/collectors/fosParse.js');
  assert.equal(P.parseFirmwareShow('Appl     Primary/Secondary Versions\n------\nFOS      v8.2.3d\n         v8.2.3d\n'), 'v8.2.3d');
  const lic = P.parseLicenseShow(`bzeQbccdcSedTfSU:
    Fabric license
eQeQcQRcSTdRdfSU:
    Ports on Demand license - additional 12 port upgrade license
`);
  assert.equal(lic.length, 2);
  assert.equal(lic[1].pod, true);
  assert.equal(lic[0].pod, false);
});

test('buildSnapshot(SSH): switchshow 만 있어도 포트 현황을 만들고 미수집 섹션을 정직하게 표시', async () => {
  const { buildSnapshot } = await import('../src/sanswitch/collectors/fosSsh.js');
  const dev = { id: 'sw-t1', type: 'brocade', name: '등록명', host: '10.0.0.1' };
  const snap = buildSnapshot(dev, { switchshow: SWITCHSHOW_FIXED }, { sfpshow: '권한 없음' });
  assert.equal(snap.ok, true);
  assert.equal(snap.name, 'SAN_A_01');           // 장비 보고 이름이 등록명을 이긴다
  assert.equal(snap.domainId, 1);
  assert.equal(snap.ports.online, 3);
  assert.equal(snap.ports.free, 2);
  assert.equal(snap.sections.ports, 'ok');
  assert.equal(snap.sections.sfp, '권한 없음');   // 부분 실패를 숨기지 않는다
  assert.equal(snap.sections.chassis, 'skip');
  assert.equal(snap.extra.rateUnit, 'fps');      // SSH 는 옥텟 카운터가 없다
});

// ── REST 수집기 ───────────────────────────────────────────────────────────────
test('REST: 광 파워 µW→dBm 변환(단위를 섞으면 임계 판정이 무의미해진다)', async () => {
  const { toDbm } = await import('../src/sanswitch/collectors/fosRest.js');
  assert.equal(toDbm(479.2), -3.2);   // sfpshow 가 같은 값을 -3.2 dBm 으로 찍는다
  assert.equal(toDbm(1000), 0);
  assert.equal(toDbm(-3.2), -3.2);    // 이미 dBm 이면 그대로
  assert.equal(toDbm(null), null);
});

test('REST: 항목이 1개면 배열이 아니라 객체로 오는 경우를 견딘다', async () => {
  const { asArray, buildSnapshot, restPortState, speedLabel } = await import('../src/sanswitch/collectors/fosRest.js');
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray(null), []);
  assert.equal(speedLabel(32_000_000_000), '32G');
  assert.equal(speedLabel(0), '');
  assert.equal(restPortState({ 'operational-status': 2 }), 'online');
  assert.equal(restPortState({ 'operational-status': 3, 'physical-state': 'no_license' }), 'noLicense');
  assert.equal(restPortState({ 'operational-status': 3, 'is-enabled-state': false }), 'disabled');

  const snap = buildSnapshot({ id: 'sw-r1', type: 'brocade' }, {
    switch: { 'fibrechannel-switch': { 'user-friendly-name': 'REST_SW', 'domain-id': 3, 'firmware-version': 'v9.1.1' } },
    chassis: { chassis: { 'product-name': 'G620', 'serial-number': 'ABC123' } },
    ports: { fibrechannel: [
      { name: '0', speed: 32e9, 'operational-status': 2, neighbor: { wwn: ['50:06:0b:00:00:11:22:33'] } },
      { name: '1', 'operational-status': 3, 'physical-state': 'no_license' },
    ] },
    media: { 'media-rdp': { name: '0', temperature: 40, 'rx-power': 479.2, 'tx-power': 511.4 } },
  });
  assert.equal(snap.name, 'REST_SW');
  assert.equal(snap.model, 'G620');
  assert.equal(snap.ports.licensed, 1);
  assert.equal(snap.ports.online, 1);
  assert.equal(snap.ports.noLicense, 1);
  assert.equal(snap.ports.list[0].rxPowerDbm, -3.2);
  assert.equal(snap.extra.rateUnit, 'bps');
});

// ── 속도(델타) 계산 ───────────────────────────────────────────────────────────
test('applyRates: 첫 수집은 null, 두 번째부터 계산, 카운터 리셋은 null', async () => {
  const { applyRates, _resetForTest } = await import('../src/sanswitch/rates.js');
  _resetForTest();
  const t0 = 1_000_000;
  const p1 = [{ index: 0, inFrames: 1000, outFrames: 500, inBytes: 1e6, outBytes: 5e5 }];
  assert.equal(applyRates('d1', p1, t0).computed, false);
  assert.equal(p1[0].inBps, null, '첫 수집을 0 으로 채우면 트래픽이 없는 것으로 오해된다');

  const p2 = [{ index: 0, inFrames: 2000, outFrames: 1000, inBytes: 1e6 + 1.25e7, outBytes: 5e5 }];
  const r = applyRates('d1', p2, t0 + 10_000);   // 10초 뒤
  assert.equal(r.computed, true);
  assert.equal(p2[0].inFps, 100);                // (2000-1000)/10
  assert.equal(p2[0].inBps, 1.25e7 / 10 * 8);    // 10 Mbps
  assert.equal(p2[0].outBps, 0);

  const p3 = [{ index: 0, inFrames: 5, outFrames: 1, inBytes: 10, outBytes: 1 }]; // 재부팅으로 카운터 리셋
  applyRates('d1', p3, t0 + 20_000);
  assert.equal(p3[0].inFps, null, '음수 델타를 큰 양수로 착각해 말도 안 되는 속도를 보고하면 안 된다');
  assert.equal(p3[0].inBps, null);
  _resetForTest();
});

// ── 중앙 push 축약 ────────────────────────────────────────────────────────────
test('slimSnapshot: 정상 포트를 빼고 문제 포트만 올린다 + 뺀 수를 표시', async () => {
  const { slimSnapshot } = await import('../src/sanswitch/push.js');
  const list = [
    { index: 0, state: 'online', errCrc: 0, rxPowerDbm: -3 },
    { index: 1, state: 'online', errCrc: 0, rxPowerDbm: -3 },
    { index: 2, state: 'faulty', errCrc: 0 },
    { index: 3, state: 'online', errCrc: 12, rxPowerDbm: -3 },
    { index: 4, state: 'online', errCrc: 0, rxPowerDbm: -13 },
  ];
  const slim = slimSnapshot({ ports: { total: 5, online: 4, list } });
  assert.equal(slim.ports.list.length, 3);
  assert.deepEqual(slim.ports.list.map((p) => p.index), [2, 3, 4]);
  assert.equal(slim.ports.portsOmitted, 2);
  assert.equal(slim.ports.total, 5, '요약 수치는 전체 기준이 유지되어야 한다(화면 KPI 가 이걸 쓴다)');
});

// ── 등록부 보안 불변조건 ──────────────────────────────────────────────────────
test('등록부: SSRF·형식 검증과 미구현 타입 거부', async () => {
  const { deviceInputIssue } = await import('../src/sanswitch/registry.js');
  const base = { type: 'brocade', name: 'SW1', host: '10.1.1.1', username: 'admin' };
  assert.equal(deviceInputIssue(base), null);
  assert.match(deviceInputIssue({ ...base, host: '127.0.0.1' }) || '', /차단/);
  assert.match(deviceInputIssue({ ...base, host: '169.254.1.1' }) || '', /차단/);
  assert.match(deviceInputIssue({ ...base, host: '-bad' }) || '', /형식 오류/);
  assert.match(deviceInputIssue({ ...base, username: '' }) || '', /계정/);
  assert.match(deviceInputIssue({ ...base, type: 'cisco-mds' }) || '', /미구현/);
  // 제어문자 비밀번호는 값 미포함 오류로 거부(오류 메시지로 새는 경로 차단)
  const issue = deviceInputIssue({ ...base, password: 'pw\nnext' });
  assert.match(issue || '', /제어문자/);
  assert.ok(!String(issue).includes('next'), '오류 메시지에 비밀번호 값이 들어가면 안 된다');
});

test('등록부: host 를 바꾸면 저장된 비밀번호를 이월하지 않는다(uagmon M3)', async () => {
  const { saveDevice, getDeviceWithSecret, _resetForTest } = await import('../src/sanswitch/registry.js');
  _resetForTest();
  const d = saveDevice({ type: 'brocade', name: 'SW1', host: '10.1.1.10', username: 'admin', password: 'secret' });
  assert.equal(getDeviceWithSecret(d.id).password, 'secret');
  saveDevice({ id: d.id, type: 'brocade', name: 'SW1', host: '10.1.1.99', username: 'admin' }); // host 변경·비번 미입력
  assert.equal(getDeviceWithSecret(d.id).password, undefined, 'host 를 바꿔치기해 저장 비번을 남의 서버로 보내는 경로');
  // 같은 host 로 비번 없이 저장하면 유지된다(정상 편집이 비번을 지우면 안 된다)
  saveDevice({ id: d.id, type: 'brocade', name: 'SW1x', host: '10.1.1.99', username: 'admin', password: 'newpw' });
  saveDevice({ id: d.id, type: 'brocade', name: 'SW1y', host: '10.1.1.99', username: 'admin' });
  assert.equal(getDeviceWithSecret(d.id).password, 'newpw');
  _resetForTest();
});

test('등록부: listDevices 는 비밀번호를 반환하지 않는다', async () => {
  const { saveDevice, listDevices, _resetForTest } = await import('../src/sanswitch/registry.js');
  _resetForTest();
  saveDevice({ type: 'brocade', name: 'SW2', host: '10.2.2.2', username: 'admin', password: 'topsecret' });
  const l = listDevices();
  assert.equal(l[0].password, undefined);
  assert.equal(l[0].hasPassword, true);
  assert.ok(!JSON.stringify(l).includes('topsecret'));
  _resetForTest();
});

test('등록부: devicesForThisNode 는 중앙/엣지를 centralUrl 로 가른다', async () => {
  const { devicesForThisNode } = await import('../src/sanswitch/registry.js');
  const devices = [
    { id: 'a', agent: '', enabled: true },
    { id: 'b', agent: 'agent-MI', enabled: true },
    { id: 'c', agent: 'agent-MI', enabled: false },
  ];
  assert.deepEqual(devicesForThisNode({ devices, isEdge: false }).map((d) => d.id), ['a']);
  assert.deepEqual(devicesForThisNode({ devices, agentName: 'AGENT-mi', isEdge: true }).map((d) => d.id), ['b']);
});

// ── 폴러 규약(회귀 고정) ──────────────────────────────────────────────────────
test('폴러/푸셔가 주기를 모듈 로드 시 상수로 굳히지 않는다', () => {
  for (const f of ['src/sanswitch/poller.js', 'src/sanswitch/push.js', 'src/agent/sanSwitchConfigPull.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/const\s+INTERVAL_MS\s*=/.test(src), `${f}: 주기 상수는 재시작 전까지 변경이 안 먹는다`);
    assert.ok(src.includes('startAdaptiveTimer'), `${f}: 적응형 타이머를 써야 한다`);
  }
});

test('폴러: 재진입 가드 — 이전 수집이 진행 중이면 이번 틱을 건너뛴다', async () => {
  const { pollSanSwitchOnce } = await import('../src/sanswitch/poller.js');
  const [a, b] = await Promise.all([pollSanSwitchOnce(), pollSanSwitchOnce()]);
  const skipped = [a, b].filter((r) => !r.ok && /진행 중/.test(r.reason || ''));
  assert.equal(skipped.length, 1, '동시에 두 번 호출하면 하나는 겹침 방지로 스킵되어야 한다');
});

// ── v2.411: 실장비 출력으로 교정한 파서 + 포트 사용량 수집 ──────────────────────
const REAL_CHASSISSHOW = `FAN  Unit: 1
Fan Direction:          Non-portside Intake
Time Awake:             579 days

FAN  Unit: 2
Time Awake:             579 days

FAN  Unit: 3
Time Awake:             579 days

POWER SUPPLY  Unit: 1
Power Source:           AC
PS Voltage input:       218.00 V
Power Usage:            -240W
Factory Part Num:       23-1000082-02
Factory Serial Num:     34R0E7

POWER SUPPLY  Unit: 2
Power Source:           AC
PS Voltage input:       219.00 V
Power Usage:            -264W
Factory Serial Num:     34R0DE

CHASSIS/WWN  Unit: 1
Header Version:         2
Factory Part Num:       40-1001320-06
Factory Serial Num:     FPL1944R00C
Time Alive:             1363 days
Time Awake:             579 days
ID:                     EMC0000CA
Part Num:               CONTRX0000663
Serial Num:             BRCFPL1944R00C
`;

test('parseChassisShow: 실장비(FOS 9.0.1d) 출력 — Chassis Family 가 없어도 식별 정보를 읽는다', async () => {
  const { parseChassisShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const r = parseChassisShow(REAL_CHASSISSHOW);
  assert.equal(r.model, '');                       // 이 출력에는 모델명 줄이 없다(추측하지 않는다)
  assert.equal(r.serial, 'BRCFPL1944R00C');        // CHASSIS 블록의 'Serial Num' 우선
  assert.equal(r.partNumber, '40-1001320-06');     // PSU 의 부품번호(23-…)를 집으면 안 된다
  assert.equal(r.chassisId, 'EMC0000CA');
  assert.equal(r.fans, 3);
  assert.equal(r.psus.length, 2);
  assert.deepEqual(r.psus[0], { unit: 1, source: 'AC', voltageV: 218, powerW: 240, partNumber: '23-1000082-02', serial: '34R0E7' });
  assert.equal(r.powerWatts, 504);                 // -240W + -264W → 절댓값 합
  assert.equal(r.awakeDays, 579);
  assert.equal(r.aliveDays, 1363);
});

test('parsePortPerfShow: 실장비 출력 형식(16열 블록 + Total)을 읽는다', async () => {
  const { parsePortPerfShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const txt = [
    '      16       17       18       19       20       21       22       23',
    '========================================================================',
    '  86.40k 130.63k   1.05m 836.85k       0   23.72k 505.31k  17.37m',
    '     120     121     122     123     124     125     126     127    Total',
    '========================================================================',
    '   2.21m   1.17m   1.32m   1.11m 571.69k   2.38m 960.74k   2.01m 155.36m',
  ].join('\n');
  const r = parsePortPerfShow(txt);
  assert.equal(r.ports[16], 86_400);
  assert.equal(r.ports[20], 0);
  assert.equal(r.ports[23], 17_370_000);
  assert.equal(r.ports[127], 2_010_000);
  assert.equal(r.total, 155_360_000);
  assert.equal(Object.keys(r.ports).length, 16);
});

test('parsePortPerfShow: 갱신형 명령이라 여러 벌이 섞여 있으면 마지막 것만 쓴다', async () => {
  const { parsePortPerfShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const block = (v) => ['       0        1', '=================', `   ${v}   ${v}`].join('\n');
  const r = parsePortPerfShow(`${block('1.00m')}\n${block('2.00m')}\n${block('3.00m')}`);
  assert.equal(r.samples, 3);
  assert.equal(r.ports[0], 3_000_000, '여러 벌을 합치면 시점이 뒤섞인다 — 가장 최근 것만');
});

test('perfSettings: 하한/상한 clamp, 기본은 꺼짐', async () => {
  const { normalizePerfSettings, LIMITS } = await import('../src/sanswitch/perfSettings.js');
  assert.equal(normalizePerfSettings({}).enabled, false, '운영 스위치에 주기 접속을 임의로 만들지 않는다');
  assert.equal(normalizePerfSettings({ intervalMs: 1 }).intervalMs, LIMITS.intervalMs.min);
  assert.equal(normalizePerfSettings({ intervalMs: 9e9 }).intervalMs, LIMITS.intervalMs.max);
  assert.equal(normalizePerfSettings({ sampleSeconds: 999 }).sampleSeconds, LIMITS.sampleSeconds.max);
  assert.equal(normalizePerfSettings({ retentionDays: 0 }).retentionDays, LIMITS.retentionDays.def);
  assert.equal(normalizePerfSettings({ enabled: 'yes' }).enabled, false, 'true 아닌 값으로 켜지지 않는다');
});

test('storageKey: 어레이 식별은 앞 두 세그먼트(디렉터 포트가 달라도 같은 장비로 묶여야 한다)', async () => {
  const { storageKey } = await import('../src/sanswitch/perfDb.js');
  const a = storageKey('SYMMETRIX::000497700230::SAF-1d 4::FC::5978_0714+::EMUL x');
  const b = storageKey('SYMMETRIX::000497700230::SAF-3d 6::FC::5978_0714+::EMUL y');
  assert.equal(a, 'SYMMETRIX::000497700230');
  assert.equal(a, b, '같은 어레이의 다른 디렉터 포트는 하나로 합산되어야 한다');
  assert.equal(storageKey(''), '(미확인)');
});

test('perfDb: 저장→조회 왕복과 스토리지 합산', async () => {
  const { savePerfSample, portSeries, storageSeries, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return; // node:sqlite 미지원 환경은 건너뛴다(폴백 설계대로)
  _resetForTest();
  const now = Date.now();
  const meta = [
    { port: 0, attachedName: 'SYMMETRIX::00049::SAF-1d 4', speed: '16G' },
    { port: 1, attachedName: 'SYMMETRIX::00049::SAF-3d 6', speed: '16G' },
    { port: 2, attachedName: 'Emulex PPN-10:00', speed: '16G' },
  ];
  await savePerfSample('dev-t', now - 60_000, { 0: 1000, 1: 2000, 2: 500 }, meta);
  await savePerfSample('dev-t', now, { 0: 3000, 1: 4000, 2: 700 }, meta);
  const ps = await portSeries('dev-t', { hours: 1 });
  assert.equal(ps.series.length, 3);
  assert.equal(ps.series[0].port, 0);
  assert.equal(ps.series[0].speed, '16G');
  const ss = await storageSeries('dev-t', { hours: 1 });
  const sym = ss.series.find((s) => s.key.startsWith('SYMMETRIX'));
  assert.ok(sym, '어레이 그룹이 있어야 한다');
  assert.deepEqual(sym.ports, [0, 1], '같은 어레이의 두 포트가 하나로 묶여야 한다');
  _resetForTest();
});

// ── v2.412: 법인 단위(여러 스위치) 스토리지 사용량 합산 ────────────────────────
test('arraySerialOf: 어레이 시리얼처럼 보이는 조각만 뽑는다(억지 매칭 금지)', async () => {
  const { arraySerialOf } = await import('../src/sanswitch/perfDb.js');
  assert.equal(arraySerialOf('SYMMETRIX::000497700230'), '000497700230');
  assert.equal(arraySerialOf('PowerStore::PS-GLOBAL-0A1B'), 'PS-GLOBAL-0A1B');
  assert.equal(arraySerialOf('X::SAF-1d 4'), '', '공백이 든 포트 표기는 시리얼이 아니다');
  assert.equal(arraySerialOf('Emulex PPN-10:00'), '', ':: 가 없으면 시리얼을 뽑지 않는다');
  assert.equal(arraySerialOf('A::bc'), '', '너무 짧은 조각은 시리얼로 보지 않는다');
});

test('endpointKind: 어레이/호스트 구분 — 법인 합산에서 HBA 가 표를 덮지 않게', async () => {
  const { endpointKind } = await import('../src/sanswitch/perfDb.js');
  assert.equal(endpointKind('SYMMETRIX::000497700230'), 'array');
  assert.equal(endpointKind('PowerStore::PS-GLOBAL-0A1B'), 'array');
  assert.equal(endpointKind('Emulex PPN-10:00:00:10:9b:c1:74:87'), 'host');
  assert.equal(endpointKind('QLE2692 FW:v9.15.01 DVR:v5.4.84.0'), 'host');
  assert.equal(endpointKind('(미확인)'), 'unknown');
  // 등록 스토리지 시리얼과 일치하면 이름 형식과 무관하게 어레이(확정 근거 우선)
  assert.equal(endpointKind('FLAT-ARRAY-NAME', { matched: true }), 'array');
});

test('storageSeriesMulti: 여러 스위치에 나뉜 어레이를 하나로 합산한다(팹 A/B)', async () => {
  const { savePerfSample, storageSeriesMulti, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  _resetForTest();
  const now = Date.now();
  const NAME = 'SYMMETRIX::000497700230::SAF-1d 4::FC';
  // 같은 어레이가 팹 A(sw-a)와 팹 B(sw-b)에 각각 2포트씩 물려 있다.
  for (const dev of ['sw-a', 'sw-b']) {
    const meta = [{ port: 0, attachedName: NAME, speed: '16G' }, { port: 1, attachedName: NAME, speed: '16G' },
      { port: 2, attachedName: 'Emulex PPN-10:00', speed: '16G' }];
    await savePerfSample(dev, now - 60_000, { 0: 1000, 1: 1000, 2: 50 }, meta);
    await savePerfSample(dev, now, { 0: 1000, 1: 1000, 2: 50 }, meta);
  }
  const one = await storageSeriesMulti(['sw-a'], { hours: 1 });
  const both = await storageSeriesMulti(['sw-a', 'sw-b'], { hours: 1 });
  const symOne = one.series.find((s) => s.key.startsWith('SYMMETRIX'));
  const symBoth = both.series.find((s) => s.key.startsWith('SYMMETRIX'));
  assert.equal(symOne.ports.length, 2);
  assert.equal(symBoth.ports.length, 4, '두 스위치의 포트가 하나의 어레이로 합쳐져야 한다');
  assert.deepEqual(symBoth.deviceIds.sort(), ['sw-a', 'sw-b']);
  assert.ok(symBoth.avgTotal > symOne.avgTotal,
    '스위치 한 대만 보면 그 어레이 트래픽의 절반만 보인다 — 합산이 더 커야 한다');
  assert.equal(Math.round(symBoth.avgTotal), Math.round(symOne.avgTotal * 2));
  _resetForTest();
});

test('storageSeriesMulti: 대상이 없으면 빈 결과(전체 스캔으로 흐르지 않는다)', async () => {
  const { storageSeriesMulti } = await import('../src/sanswitch/perfDb.js');
  const r = await storageSeriesMulti([], { hours: 1 });
  assert.deepEqual(r.series, []);
  assert.deepEqual(r.buckets, []);
});
