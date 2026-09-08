/**
 * v2.430 — HAProxy 경로 점검: 대상 생성·전이 판정·해결방안(순수) + 실제 소켓으로 SSH 배너/포탈 ping/정체/HQ 대조.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay2430-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

test('settings.normalizeSettings: 프로파일/호스트/제외 검증·기본값', async () => {
  const { normalizeSettings, DEFAULT_PROFILE } = await import('../src/relaycheck/settings.js');
  const s = normalizeSettings({});
  assert.equal(s.enabled, true); assert.equal(s.intervalMs, 300_000); assert.deepEqual(s.profile.map((p) => p.port), DEFAULT_PROFILE.map((p) => p.port));
  const t = normalizeSettings({ intervalMs: 5, profile: [{ port: 4068, kind: 'irs-portal' }, { port: 99999, kind: 'x' }], hosts: ['10.1.1.1', { host: 'bad host' }], exclude: ['10.1.1.1:4001', 'nope'] });
  assert.equal(t.intervalMs, 60_000); assert.equal(t.profile.length, 1); assert.equal(t.hosts.length, 1); assert.deepEqual(t.exclude, ['10.1.1.1:4001']);
});

test('poller.buildTargets: 수집 서버 호스트 × 프로파일, 포탈 종류에 토큰/기대 이름/중계 이름, 제외 반영', async () => {
  const { buildTargets } = await import('../src/relaycheck/poller.js');
  const { normalizeSettings } = await import('../src/relaycheck/settings.js');
  const cols = [
    { id: 'AZ', url: 'http://10.112.158.217:4000', token: 'tA', datacenter: 'AZ', enabled: true },
    { id: 'AZ-IRS', url: 'http://10.112.158.217:4068', token: 'tB', datacenter: 'AZ', enabled: true },
    { id: 'off', url: 'http://10.9.9.9:4000', token: 'x', enabled: false },
  ];
  const t = buildTargets(normalizeSettings({ exclude: ['10.112.158.217:4065'] }), cols);
  assert.equal(new Set(t.map((x) => x.host)).size, 1, '비활성 수집 서버 호스트는 제외');
  assert.equal(t.length, 5, '프로파일 6개 − 제외 1개');
  const irs = t.find((x) => x.port === 4068);
  assert.equal(irs.token, 'tB'); assert.equal(irs.expectAgent, 'AZ-IRS'); assert.equal(irs.relayAgent, 'AZ'); assert.equal(irs.site, 'AZ');
  const ssh = t.find((x) => x.port === 4067); assert.equal(ssh.kind, 'irs-ssh'); assert.equal(ssh.token, undefined);
});

test('poller.transition: 연속 N회 실패에 1회 알림, 복구 시 1회, 흔들림 무시', async () => {
  const { transition } = await import('../src/relaycheck/poller.js');
  let s = null, ev;
  ({ next: s, event: ev } = transition(s, false, 2)); assert.equal(ev, null);
  ({ next: s, event: ev } = transition(s, false, 2)); assert.equal(ev, 'fail');
  ({ next: s, event: ev } = transition(s, false, 2)); assert.equal(ev, null, '중복 알림 없음');
  ({ next: s, event: ev } = transition(s, true, 2)); assert.equal(ev, 'recover');
  ({ next: s, event: ev } = transition(s, false, 2)); assert.equal(ev, null, '1회 실패는 알림 아님');
});

test('remedy.remedyFor: 단계별 원인·조치·haproxy 예시', async () => {
  const { remedyFor } = await import('../src/relaycheck/remedy.js');
  const r1 = remedyFor({ kind: 'irs-portal', host: '10.1.1.1', port: 4068, phase: 'refused' });
  assert.match(r1.title, /리스너/); assert.match(r1.haproxy, /bind \*:4068/); assert.match(r1.haproxy, /<IRS IP>:4000/);
  const r2 = remedyFor({ kind: 'irs-portal', host: '10.1.1.1', port: 4068, phase: 'identity', expect: { agent: 'AZ-IRS', relayAgent: 'AZ' }, got: { agent: 'AZ' } });
  assert.match(r2.cause, /자신\(:4000\)으로 되돌아/);
  const r3 = remedyFor({ kind: 'irs-vcenter', host: '10.1.1.1', port: 4066, phase: 'tls' });
  assert.match(r3.cause, /backend/i);
  assert.match(remedyFor({ kind: 'hq-portal', host: 'h', port: 4001, phase: 'hq' }).steps[0], /<중앙 IP>:4000/);
  assert.match(remedyFor({ kind: 'irs-ssh', host: 'h', port: 4067, phase: 'banner' }).haproxy, /:22/);
});

let sshSrv, sshPort, edge, edgePort;
before(async () => {
  sshSrv = net.createServer((s) => { s.write('SSH-2.0-OpenSSH_8.7\r\n'); });
  await new Promise((r) => sshSrv.listen(0, r)); sshPort = sshSrv.address().port;
  const express = (await import('express')).default;
  const { instanceId } = await import('../src/instanceId.js');
  const a = express();
  a.get('/api/collector/ping', (req, res) => { if (req.get('X-Collector-Token') !== 'tA') return res.status(403).json({ ok: false }); res.json({ ok: true, agent: 'AZ', hostname: 'edge-a', version: '2.430.0' }); });
  a.get('/api/health', (req, res) => res.json({ version: '2.430.0', instance: req.query.self === '1' ? instanceId() : 'other-instance', agent: 'AZ' }));
  edge = a.listen(0); await new Promise((r) => edge.once('listening', r)); edgePort = edge.address().port;
});
after(() => { sshSrv?.close(); edge?.close(); });

test('checks.runCheck: SSH 배너 / 리스너 없음 / 포탈 정체 불일치·토큰 거부·일치 / HQ 대조', async () => {
  const { runCheck } = await import('../src/relaycheck/checks.js');
  const ssh = await runCheck({ host: '127.0.0.1', port: sshPort, kind: 'irs-ssh' }, { timeoutMs: 3000 });
  assert.equal(ssh.ok, true); assert.match(ssh.detail, /SSH-2.0/);
  const closed = net.createServer(); await new Promise((r) => closed.listen(0, r)); const cp = closed.address().port; await new Promise((r) => closed.close(r));
  const refused = await runCheck({ host: '127.0.0.1', port: cp, kind: 'irs-portal', token: 't' }, { timeoutMs: 3000 });
  assert.equal(refused.ok, false); assert.equal(refused.phase, 'refused');
  // IRS 포트가 중계 엣지(AZ) 자신으로 되돌아옴 → identity
  const loop = await runCheck({ host: '127.0.0.1', port: edgePort, kind: 'irs-portal', token: 'tA', expectAgent: 'AZ-IRS', relayAgent: 'AZ', otherIds: ['AZ', 'AZ-IRS'] }, { timeoutMs: 3000 });
  assert.equal(loop.ok, false); assert.equal(loop.phase, 'identity'); assert.equal(loop.got.agent, 'AZ');
  const auth = await runCheck({ host: '127.0.0.1', port: edgePort, kind: 'irs-portal', token: 'wrong', expectAgent: 'AZ-IRS' }, { timeoutMs: 3000 });
  assert.equal(auth.phase, 'auth');
  const okp = await runCheck({ host: '127.0.0.1', port: edgePort, kind: 'edge-portal', token: 'tA', expectAgent: 'AZ', otherIds: ['AZ', 'AZ-IRS'] }, { timeoutMs: 3000 });
  assert.equal(okp.ok, true);
  const hqBad = await runCheck({ host: '127.0.0.1', port: edgePort, kind: 'hq-portal' }, { timeoutMs: 3000 });
  assert.equal(hqBad.ok, false); assert.equal(hqBad.phase, 'hq');
});
