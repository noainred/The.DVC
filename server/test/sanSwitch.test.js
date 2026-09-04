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

test('parseChassisShow: Chassis Family 가 모델이다(6603 이든 무엇이든 장비 보고값을 그대로)', async () => {
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
