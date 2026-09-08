import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdu-'));
process.env.CONFIG_DIR = tmp;

let parse, reg, csv, types, iv, creq;
before(async () => {
  parse = await import('../src/pdu/parse.js');
  reg = await import('../src/pdu/registry.js');
  csv = await import('../src/pdu/csv.js');
  types = await import('../src/pdu/types.js');
  iv = await import('../src/pdu/intervals.js');
  creq = await import('../src/pdu/collectRequests.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// ── 파서 — 실장비(AP8853, AOS 6.8.2 / rpdu2g 6.8.0) 출력 기준 ────────────────
test('parseReading: 온도/습도/전력 실출력', () => {
  assert.deepEqual(parse.parseReading('E000: Success\n22.9 C'), { value: 22.9, unit: 'C', code: 'E000', ok: true });
  assert.deepEqual(parse.parseReading('E000: Success\n34 %RH'), { value: 34, unit: '%RH', code: 'E000', ok: true });
  assert.deepEqual(parse.parseReading('E000: Success\n1.98 kW'), { value: 1.98, unit: 'kW', code: 'E000', ok: true });
});

test('parseReading: E102(해당 없음)는 오류가 아니라 value=null — 자동 탐지 종료 신호', () => {
  const r = parse.parseReading('E102: Parameter Error\nUsage: tempReading -- Display the temperature reading from the sensor.');
  assert.equal(r.ok, false);
  assert.equal(r.value, null, '0 으로 채우면 측정값 0 과 구분이 사라진다');
  assert.equal(r.code, 'E102');
});

test('parseReading: 값 줄이 없으면 null(다음 프롬프트에서 멈춘다)', () => {
  assert.equal(parse.parseReading('E000: Success\napc>').value, null);
});

test('toCelsius: 화씨 응답을 섭씨로 정규화(DB 단위 혼재 방지)', () => {
  assert.equal(parse.toCelsius(73.4, 'F'), 23);
  assert.equal(parse.toCelsius(22.9, 'C'), 22.9);
  assert.equal(parse.toCelsius(null, 'C'), null);
});

test('toWatts: kW→W 정규화, energy 는 별도 취급', () => {
  assert.equal(parse.toWatts(1.98, 'kW'), 1980);
  assert.equal(parse.toWatts(500, 'W'), 500);
  assert.equal(parse.toWatts(null, 'kW'), null);
});

test('cmd: 명령별 인자 문법이 실측과 일치(humReading 은 단위를 붙이면 E102)', () => {
  assert.equal(parse.cmd.temp(1), 'tempReading 1:C');
  assert.equal(parse.cmd.hum(1), 'humReading 1:');
  assert.equal(parse.cmd.dev(1, 'power'), 'devReading 1:power');
  assert.equal(parse.cmd.bank(2, 'current'), 'bkReading 2:current');
});

test('cmd: 인덱스/항목 화이트리스트 — CLI 인젝션 차단', () => {
  assert.throws(() => parse.cmd.temp('1; reboot'), /인덱스/);
  assert.throws(() => parse.cmd.temp(0), /인덱스/);
  assert.throws(() => parse.cmd.dev(1, 'power; ls'), /지원하지 않는/);
});

test('parseAbout: 본체 모델/시리얼(첫 Model Number)을 뽑는다', () => {
  const out = parse.parseAbout([
    'Hardware Factory', 'Model Number:  AP8853', 'Serial Number: 5A2037E07352',
    'Network Management Card', 'Model Number:  AP9538', 'Serial Number: 5A2037E01834',
    'Application Module', 'Name: rpdu2g', 'Version: v6.8.0',
    'APC OS(AOS)', 'Name: aos', 'Version: v6.8.2',
  ].join('\n'));
  assert.equal(out.model, 'AP8853');
  assert.equal(out.serial, '5A2037E07352');
  assert.equal(out.nmcModel, 'AP9538');
});

// ── 레지스트리 ────────────────────────────────────────────────────────────────
test('saveDevice: 등록 + 비밀번호 마스킹', () => {
  const r = reg.saveDevice({ name: 'PDU-1', host: '10.94.10.11', username: 'apc', password: 'secret' });
  assert.equal(r.ok, true);
  assert.equal(r.device.password, undefined, '응답에 비밀번호가 있으면 안 된다');
  assert.equal(r.device.hasPassword, true);
});

test('saveDevice: SSRF 가드 — 루프백/링크로컬 거부', () => {
  assert.match(reg.saveDevice({ name: 'x', host: '127.0.0.1', username: 'apc', password: 'p' }).reason, /host 거부/);
  assert.match(reg.saveDevice({ name: 'y', host: '169.254.169.254', username: 'apc', password: 'p' }).reason, /host 거부/);
});

test('saveDevice: 같은 host 중복 등록 거부', () => {
  assert.match(reg.saveDevice({ name: 'dup', host: '10.94.10.11', username: 'apc', password: 'p' }).reason, /이미 등록된 host/);
});

test('saveDevice: 빈 비밀번호는 기존 값 유지', () => {
  const id = reg.listDevices()[0].id;
  const r = reg.saveDevice({ id, name: 'PDU-1b', host: '10.94.10.11', username: 'apc', password: '' });
  assert.equal(r.ok, true);
  assert.equal(r.device.hasPassword, true);
});

test('저장 파일은 0600 권한', () => {
  assert.equal(fs.statSync(path.join(tmp, 'pdu-devices.json')).mode & 0o777, 0o600);
});

test('devicesForThisNode: 중앙은 미위임분만, 엣지는 자기 몫만', () => {
  reg.saveDevice({ name: 'edge-pdu', host: '10.93.20.31', username: 'apc', password: 'p', agent: '엣지 WA' });
  const all = reg.listDevicesWithSecrets();
  const central = reg.devicesForThisNode({ devices: all, agentName: 'central', isEdge: false });
  assert.ok(central.every((d) => !d.agent), '중앙은 위임 장비를 수집하지 않는다');
  const edge = reg.devicesForThisNode({ devices: all, agentName: '엣지 WA', isEdge: true });
  assert.equal(edge.length, 1);
  assert.equal(edge[0].host, '10.93.20.31');
});

// ── CSV ──────────────────────────────────────────────────────────────────────
test('devicesToCsv: 비밀번호를 기본적으로 내보내지 않는다', () => {
  const out = csv.devicesToCsv([{ name: 'a', host: '10.0.0.1', username: 'apc', password: 'TOPSECRET', sshPort: 22, enabled: true }]);
  assert.ok(!out.includes('TOPSECRET'), '평문 비밀번호가 CSV 에 들어가면 안 된다');
  assert.ok(out.includes('10.0.0.1'));
});

test('csvToDevices: 헤더 파싱 + 기본값', () => {
  const { rows, errors } = csv.csvToDevices('name,host,username,sshPort,datacenter,agent,enabled,note,password\nP1,10.0.0.9,apc,22,OC2,,true,메모,\n');
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, '10.0.0.9');
  assert.equal(rows[0].sshPort, 22);
  assert.equal(rows[0].enabled, true);
});

test('csvToDevices: host 없는 행은 오류로 수집(무시하지 않음)', () => {
  const { rows, errors } = csv.csvToDevices('name,host\nOnlyName,\n');
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /host/);
});

// ── 주기 배포 계약 ────────────────────────────────────────────────────────────
test('saveIntervals: 빈 값·0 은 하한으로 승격하지 않고 미지정으로 버린다', () => {
  iv.saveIntervals({ pollMs: 300_000 });
  assert.equal(iv.intervalsForEdge().pollMs, 300_000);
  iv.saveIntervals({ pollMs: '' });
  assert.equal('pollMs' in iv.intervalsForEdge(), false, '미입력이 최소주기로 둔갑하면 안 된다');
  iv.saveIntervals({ pollMs: 0 });
  assert.equal('pollMs' in iv.intervalsForEdge(), false);
});

test('saveIntervals: 하한 미만은 하한으로 올린다', () => {
  iv.saveIntervals({ pollMs: 1000 });
  assert.equal(iv.intervalsForEdge().pollMs, 60_000);
});

test('runtimeIntervals: 지정 없으면 기본값', () => {
  const r = iv.runtimeIntervals();
  assert.ok(r.pollMs >= 60_000 && r.pushMs >= 60_000 && r.configPullMs >= 60_000);
});

// ── 수집 요청 큐 ──────────────────────────────────────────────────────────────
test('collectRequests: one-shot(인출 후 제거) + agent 별 분리', () => {
  creq._resetForTest();
  creq.requestCollect('d1', '엣지 WA');
  creq.requestCollect('d2', '엣지 OC2');
  assert.equal(creq.hasPendingRequest('d1'), true);
  assert.deepEqual(creq.takeRequestsForAgent('엣지 WA'), ['d1']);
  assert.deepEqual(creq.takeRequestsForAgent('엣지 WA'), [], '한 번 서빙하면 사라진다');
  assert.deepEqual(creq.takeRequestsForAgent('엣지 OC2'), ['d2'], '다른 엣지 요청은 남아 있어야 한다');
});

// ── 요약 ─────────────────────────────────────────────────────────────────────
test('summarize: 값 없으면 null 유지(0 으로 채우지 않음)', () => {
  const s = types.summarize({ units: [{ powerW: null }], sensors: [] });
  assert.equal(s.powerW, null);
  assert.equal(s.tempMaxC, null);
  const s2 = types.summarize({ units: [{ powerW: 1000 }, { powerW: 500 }], sensors: [{ tempC: 22.9 }, { tempC: 25.1 }] });
  assert.equal(s2.powerW, 1500);
  assert.equal(s2.tempMaxC, 25.1);
  assert.equal(s2.units, 2);
});
