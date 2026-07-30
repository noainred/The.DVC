import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 저장소 server/config를 오염시키지 않도록 import 전에 CONFIG_DIR을 임시 디렉터리로 고정.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf-guard-'));
process.env.CONFIG_DIR = tmp;

let reg, relay, upg;
before(async () => {
  reg = await import('../src/collector/registry.js');
  relay = await import('../src/vcenter/relayProbe.js');
  upg = await import('../src/routes/upgrade.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('ssrfBlockReason: 우회 표기(IPv4-mapped/10진수/16진수/8진수)로도 링크로컬 차단', () => {
  const { ssrfBlockReason } = reg;
  assert.ok(ssrfBlockReason('http://[::ffff:169.254.169.254]/'), 'IPv4-mapped IPv6 차단');
  assert.ok(ssrfBlockReason('http://[::ffff:a9fe:a9fe]/'), 'IPv4-mapped(16진수 표기) 차단');
  assert.ok(ssrfBlockReason('http://2852039166/'), '10진수 IPv4 표기 차단');
  assert.ok(ssrfBlockReason('http://0xA9FEA9FE/'), '16진수 IPv4 표기 차단');
  assert.ok(ssrfBlockReason('http://[64:ff9b::a9fe:a9fe]/'), 'NAT64 임베디드 링크로컬 차단');
  assert.ok(ssrfBlockReason('::ffff:169.254.169.254'), '스킴/괄호 없는 IPv6도 통과시키지 않음');
  // 사유 문구도 링크로컬로 식별되어야 한다(화면 안내용).
  assert.match(ssrfBlockReason('http://[::ffff:169.254.169.254]/'), /링크로컬|메타데이터/);
  assert.match(ssrfBlockReason('http://2852039166/'), /링크로컬|메타데이터/);
});

test('ssrfBlockReason: 루프백/미지정 차단', () => {
  const { ssrfBlockReason } = reg;
  assert.ok(ssrfBlockReason('http://127.0.0.1'), '127.0.0.1 차단');
  assert.ok(ssrfBlockReason('http://127.1'), '축약 루프백 차단');
  assert.ok(ssrfBlockReason('http://0177.0.0.1'), '8진수 루프백 차단');
  assert.ok(ssrfBlockReason('http://0.0.0.0'), '0.0.0.0 차단');
  assert.ok(ssrfBlockReason('http://0/'), '0(=0.0.0.0) 차단');
  assert.ok(ssrfBlockReason('http://[::1]'), '::1 차단');
  assert.ok(ssrfBlockReason('http://[::]'), ':: 차단');
  assert.ok(ssrfBlockReason('http://localhost:4000'), 'localhost 이름 차단');
});

test('ssrfBlockReason: 사내망(RFC1918)·GitHub 등 정상 URL은 통과', () => {
  const { ssrfBlockReason } = reg;
  assert.equal(ssrfBlockReason('https://github.com/noainred/The.DVC/releases/download/downloads'), null);
  assert.equal(ssrfBlockReason('http://10.0.0.5:4000'), null, '사내 10.x 허용');
  assert.equal(ssrfBlockReason('http://192.168.40.221:4000'), null, '사내 192.168.x 허용');
  assert.equal(ssrfBlockReason('http://172.16.5.9:4000'), null, '사내 172.16.x 허용');
  assert.equal(ssrfBlockReason('https://vcenter.corp.example/sdk'), null, 'FQDN 허용');
  // 기존 계약 유지 — 스킴/형식 오류는 계속 거부.
  assert.ok(ssrfBlockReason('ftp://10.0.0.1'));
  assert.ok(ssrfBlockReason('not a url'));
});

test('SSRF_ALLOW_LOOPBACK=true 면 루프백만 opt-out(링크로컬은 그대로 차단)', () => {
  const { ssrfBlockReason } = reg;
  const prev = process.env.SSRF_ALLOW_LOOPBACK;
  process.env.SSRF_ALLOW_LOOPBACK = 'true';
  try {
    assert.equal(ssrfBlockReason('http://127.0.0.1:4000'), null, '랩 구성(같은 서버) 허용');
    assert.equal(ssrfBlockReason('http://localhost:4000'), null);
    assert.ok(ssrfBlockReason('http://169.254.169.254/'), '링크로컬은 opt-out 대상이 아님');
  } finally {
    if (prev === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = prev;
  }
});

test('ssrfBlockReasonResolved: DNS 해석 결과까지 검사(해석 실패는 차단 아님)', async () => {
  const { ssrfBlockReasonResolved, ipBlockReason } = reg;
  // localhost는 루프백으로 해석된다 → 차단.
  assert.ok(await ssrfBlockReasonResolved('http://localhost:4000'));
  // IP 리터럴은 동기 규칙과 동일.
  assert.ok(await ssrfBlockReasonResolved('http://[::ffff:169.254.169.254]/'));
  assert.equal(await ssrfBlockReasonResolved('http://10.0.0.5:4000'), null, '사내 IP 통과');
  // 해석 불가(.invalid)로 정상 저장/등록을 막지 않는다.
  assert.equal(await ssrfBlockReasonResolved('http://no-such-host.invalid:4000'), null);
  // 해석 결과 IP 검사에 쓰이는 규칙 자체 확인.
  assert.ok(ipBlockReason('127.0.0.1'));
  assert.ok(ipBlockReason('169.254.169.254'));
  assert.ok(ipBlockReason('::ffff:169.254.169.254'));
  assert.equal(ipBlockReason('10.1.2.3'), null);
});

test('수집 서버 등록(normalize)도 우회 표기·루프백을 거부하고 사내 IP는 허용', () => {
  const r1 = reg.addCollector({ id: 'meta', name: 'meta', url: 'http://2852039166:4000' });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /링크로컬|메타데이터/);
  const r2 = reg.addCollector({ id: 'lo', name: 'lo', url: 'http://[::1]:4000' });
  assert.equal(r2.ok, false);
  const r3 = reg.addCollector({ id: 'ok1', name: 'ok1', url: 'http://192.168.40.221:4000', token: 't' });
  assert.equal(r3.ok, true, '사내 수집 서버는 정상 등록');
});

test('relayProbe: 링크로컬/루프백은 네트워크 호출 없이 즉시 거부', async () => {
  const t0 = Date.now();
  const r = await relay.probeRelayPath('169.254.169.254:443', { timeoutMs: 6000 });
  assert.equal(r.blocked, true);
  assert.equal(r.verdict.state, 'blocked');
  assert.match(r.verdict.text, /링크로컬|메타데이터/);
  assert.equal(r.steps.tcp, null, 'TCP 프로브를 수행하지 않음');
  assert.ok(Date.now() - t0 < 1000, '즉시 반환(포트스캔 오라클 차단)');

  const r2 = await relay.probeRelayPath('http://[::1]:443', { timeoutMs: 6000 });
  assert.equal(r2.blocked, true);
  const r3 = await relay.probeRelayPath('127.0.0.1:1', { timeoutMs: 6000 });
  assert.equal(r3.blocked, true);
  // 등록된 사내 vCenter host 형태는 가드를 통과해야 한다(닫힌 포트로 즉시 실패해도 blocked는 아님).
  const r4 = await relay.probeRelayPath('192.0.2.1:9', { timeoutMs: 300 });
  assert.notEqual(r4.blocked, true);
  assert.equal(r4.host, '192.0.2.1');
  assert.equal(r4.port, 9);
});

test('Horizon 등록/연결테스트: 링크로컬·루프백 거부, 사내 FQDN 허용', async () => {
  const hz = await import('../src/horizon/horizon.js');
  const bad = hz.upsertHorizon({ id: 'h1', host: 'https://169.254.169.254', username: 'u', password: 'p', domain: 'CORP' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /링크로컬|메타데이터/);
  const lo = hz.upsertHorizon({ id: 'h2', host: 'https://127.0.0.1', username: 'u', password: 'p', domain: 'CORP' });
  assert.equal(lo.ok, false);
  const good = hz.upsertHorizon({ id: 'h3', host: 'https://horizon.corp.example', username: 'u', password: 'p', domain: 'CORP' });
  assert.equal(good.ok, true, '사내 FQDN은 정상 등록');
  // 연결 테스트도 같은 가드 — 네트워크 호출 전에 거부(즉시 반환).
  const t = await hz.testHorizon({ host: 'https://[::ffff:169.254.169.254]', username: 'u', password: 'p', domain: 'CORP' });
  assert.equal(t.ok, false);
  assert.match(t.reason, /링크로컬|메타데이터/);
});

test('업그레이드 설정 검증: 실제 기본값은 통과, 경로 이탈·내부 URL은 거부', async () => {
  const { validateUpgradeSettings } = upg;
  const { config } = await import('../src/config.js');
  // 정상값(운영 기본값) — 하나라도 거부되면 정상 배포가 막힌다.
  assert.equal(validateUpgradeSettings({ installDir: '/opt/vmware-portal/app' }), null);
  assert.equal(validateUpgradeSettings({ installDir: config.appRoot }), null);
  assert.equal(validateUpgradeSettings({ watchDir: '/etc/vmware-portal/packages' }), null);
  assert.equal(validateUpgradeSettings({ watchDir: path.join(config.configDir, 'packages') }), null);
  assert.equal(validateUpgradeSettings({ remoteBase: config.upgrade.remoteBase }), null, 'GitHub 기본 remoteBase');
  assert.equal(validateUpgradeSettings({ remoteBase: config.packages.baseUrl }), null, 'packages.baseUrl');
  assert.equal(validateUpgradeSettings({ remoteBase: 'http://10.20.30.40:4000/dl' }), null, '사내 미러');
  assert.equal(validateUpgradeSettings({ installDir: '', watchDir: '', remoteBase: '' }), null, '빈 값=미설정');
  assert.equal(validateUpgradeSettings({ enabled: true, pollIntervalMs: 3600000, autoApply: false }), null);
  assert.equal(validateUpgradeSettings({ edges: [{ url: 'http://10.1.1.5:4000' }] }), null);

  // 거부 대상.
  assert.ok(validateUpgradeSettings({ installDir: '/etc' }), '허용 베이스 밖');
  assert.ok(validateUpgradeSettings({ installDir: '/' }));
  assert.ok(validateUpgradeSettings({ installDir: 'relative/dir' }), '절대경로 강제');
  assert.ok(validateUpgradeSettings({ watchDir: '/opt/../etc' }), '.. 금지');
  assert.ok(validateUpgradeSettings({ installDir: 5 }), '문자열만');
  assert.ok(validateUpgradeSettings({ remoteBase: 'file:///etc/passwd' }), 'http/https만');
  assert.ok(validateUpgradeSettings({ remoteBase: 'http://169.254.169.254/dl' }), '메타데이터 차단');
  assert.ok(validateUpgradeSettings({ edges: [{ url: 'http://[::1]:4000' }] }), '루프백 엣지 차단');
  assert.ok(validateUpgradeSettings({ edges: 'not-array' }));
});
