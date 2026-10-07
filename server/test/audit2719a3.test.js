// v2.719 감사 그룹 A3 — 데모(mock) 결과가 실제 알림·실제 장비로 새지 않게.
//   R1-04  PDU: 데모(mock-) 장비의 임계 경보는 상태만 남기고 notify 하지 않는다(splitDemoAlerts).
//   R1-05  HAProxy 경로 점검: 저장 설정이 꺼진 mock 실행은 데모 호스트만 점검 · 데모 호스트 전이는 알리지 않는다.
//   R1-06  데모 계정 수동 실행(demoOnly)·꺼진 설정의 데모 주기는 사람 등록 CVP·PDU 에 접속하지 않는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719a3-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

let pduPoller, pduReg, relayPoller, relaySettings, cvpPoller, cvpReg, cvpStore, cvpSettings;

before(async () => {
  pduPoller = await import('../src/pdu/poller.js');
  pduReg = await import('../src/pdu/registry.js');
  relayPoller = await import('../src/relaycheck/poller.js');
  relaySettings = await import('../src/relaycheck/settings.js');
  cvpPoller = await import('../src/cvp/poller.js');
  cvpReg = await import('../src/cvp/registry.js');
  cvpStore = await import('../src/cvp/store.js');
  cvpSettings = await import('../src/cvp/settings.js');
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ } });

test('R1-04 PDU 데모 장비 경보는 보낼 목록에서 빠지고 개수만 센다', () => {
  const alerts = [
    { key: 'pdu.temp.mock-pdu-c2-3.1', severity: 'warning' },
    { key: 'pdu.bank.mock-pdu-c2-3.1.2', severity: 'critical' },
    { key: 'pdu.temp.pdu-real-1.1', severity: 'warning' },
    { key: 'pdu.hum.high.pdu-real-1.1', severity: 'warning' },
  ];
  const { send, suppressed } = pduPoller.splitDemoAlerts(alerts);
  assert.equal(suppressed, 2);
  assert.deepEqual(send.map((a) => a.key), ['pdu.temp.pdu-real-1.1', 'pdu.hum.high.pdu-real-1.1']);
});

test('R1-06 PDU demoOnly 는 사람 등록 장비에 접속하지 않는다(pollOnce·collectDeviceNow)', async () => {
  const seeded = pduReg.seedDemoDevices([
    { id: 'mock-pdu-a3', name: '데모 PDU', host: 'mock-pdu-a3.demo.invalid', username: 'apc', password: 'x', sshPort: 22 },
    { id: 'pdu-human-a3', name: '사람 PDU', host: '127.0.0.1', username: 'apc', password: 'x', sshPort: 1 },
  ]);
  assert.equal(seeded.ok, true);
  const one = await pduPoller.collectDeviceNow('pdu-human-a3', { demoOnly: true });
  assert.equal(one.skipped, true);
  assert.equal(one.demoOnly, true);
  assert.equal(pduPoller.getLocalSnapshot('pdu-human-a3'), null, '사람 장비 스냅샷이 생기면 접속을 시도한 것이다');
  const r = await pduPoller.pollOnce({ manual: true, demoOnly: true });
  assert.equal(r.ok, true);
  assert.equal(r.devices, 1);
  assert.equal(r.skippedNonDemo, 1);
  assert.equal(pduPoller.getLocalSnapshot('pdu-human-a3'), null);
  assert.ok(pduPoller.getLocalSnapshot('mock-pdu-a3'), '데모 장비는 합성 수집된다');
});

test('R1-05 HAProxy 경로 점검: 꺼진 설정의 mock 실행은 데모 호스트만, 데모 전이는 알리지 않는다', async () => {
  relaySettings._resetForTest();
  relaySettings.saveSettings({
    enabled: false, autoHosts: false, topologyHosts: false, failStreak: 1, alerts: true,
    profile: [{ port: 4066, kind: 'irs-vcenter' }],
    hosts: [{ host: '127.0.0.1' }, { host: 'edge-shanghai.demo.invalid' }],
  });
  relayPoller._resetForTest();
  const r = await relayPoller.runRelayChecks({ force: true });
  // 반환의 ok 는 정상 대상 개수다(`{ ok: true, ..._last }` — _last.ok 가 덮는다). total·fail 로 본다.
  assert.equal(r.fail, 1);
  assert.equal(r.total, 1, '사람이 넣은 127.0.0.1 은 점검 대상이 아니어야 한다');
  assert.equal(r.demoOnly, true);
  assert.equal(r.skippedNonDemo, 1);
  const keys = relayPoller.relayCheckStatus().results.map((x) => x.target.key);
  assert.deepEqual(keys, ['edge-shanghai.demo.invalid:4066']);
  assert.equal(r.demoAlertsSuppressed, 1, '데모 장애 전이는 실제 채널로 보내지 않고 센다');
});

test('R1-05 저장 설정이 켜져 있으면 사람 호스트도 예전처럼 점검한다', async () => {
  relaySettings.saveSettings({
    enabled: true, autoHosts: false, topologyHosts: false, failStreak: 1, alerts: false, timeoutMs: 2000,
    profile: [{ port: 4066, kind: 'irs-vcenter' }],
    hosts: [{ host: '127.0.0.1' }, { host: 'edge-shanghai.demo.invalid' }],
  });
  relayPoller._resetForTest();
  const r = await relayPoller.runRelayChecks({ force: true });
  assert.equal(r.total, 2);
  assert.equal(r.demoOnly, undefined);
});

test('R1-06 CVP: 꺼진 설정의 데모 주기·demoOnly 수동 실행은 사람 등록 CVP 를 수집하지 않는다', async () => {
  cvpSettings._resetForTest();
  cvpSettings.saveSettings({ enabled: false });
  const seeded = cvpReg.seedDemoServers([
    { id: 'mock-cvp-a3', name: '데모 CVP', host: 'https://mock-cvp-a3.demo.invalid', authMode: 'token', token: 't', enabled: true, agent: '' },
    { id: 'cvp-human-a3', name: '사람 CVP', host: 'https://127.0.0.1:1', authMode: 'token', token: 't', enabled: true, agent: '' },
  ]);
  assert.equal(seeded.ok, true);
  const r = await cvpPoller.pollCvpOnce({ trigger: 'demo' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.skippedNonDemo, 1);
  assert.equal(cvpStore.getStatus('cvp-human-a3'), null, '사람 CVP 상태가 생기면 접속을 시도한 것이다');
  const m = await cvpPoller.pollCvpOnce({ manual: true, demoOnly: true });
  assert.equal(m.total, 1);
  assert.equal(m.skippedNonDemo, 1);
  assert.equal(cvpStore.getStatus('cvp-human-a3'), null);
});

test('v2.719 R1-06 배선 — PDU·CVP 수동 수집 라우트가 데모 계정에 demoOnly 를 넘긴다(소스)', () => {
  const pdu = fs.readFileSync(new URL('../src/routes/api/pdu.js', import.meta.url), 'utf8');
  const cvp = fs.readFileSync(new URL('../src/routes/api/cvp.js', import.meta.url), 'utf8');
  assert.match(pdu, /collectDeviceNow\(dev\.id, \{ demoOnly: isDemoGuest\(req\.user\) \}\)/);
  assert.match(pdu, /pollOnce\(\{ manual: true, demoOnly: isDemoGuest\(req\.user\) \}\)/);
  assert.match(cvp, /demoOnly: isDemoGuest\(req\.user\)/);
});
