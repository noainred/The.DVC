/**
 * v2.603 감사 그룹 e — 회귀 고정.
 *  RECENT2603-01 NSX 매니저 'unknown'(클러스터 상태 조회 실패)을 rollup 에서 따로 센다(managersUnknown)
 *  LEFT2603-02   IPv6 등록 주소(https://[2001:db8::10]:8443)를 ':' 로 자르지 않는다 — 인증서 감시·중계 점검·VM 콘솔
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2603e-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'false';

/* ── RECENT2603-01 ─────────────────────────────────────────────────── */

test('RECENT2603-01 scopedNsxRollup — unknown 은 up·degraded 어느 쪽도 아니고 managersUnknown 으로 센다', async () => {
  const { scopedNsxRollup } = await import('../src/nsx/scope.js');
  const r = scopedNsxRollup({ managers: [
    { id: 'a', status: 'connected' }, { id: 'b', status: 'degraded' },
    { id: 'c', status: 'unknown', listsFailed: ['clusterStatus'] }, { id: 'd', status: 'unreachable' },
  ] });
  assert.equal(r.managers, 4);
  assert.equal(r.managersUp, 1);
  assert.equal(r.managersDegraded, 1);
  assert.equal(r.managersUnknown, 1);
  // 타일 판정식(웹 consoleData.buildDomainTiles)과 같은 산수: 다운 = 전체 − 정상 − 저하 − 확인 불가 = 1(unreachable)
  assert.equal(r.managers - r.managersUp - r.managersDegraded - r.managersUnknown, 1);
});

test('RECENT2603-01 clusterHealth 실패 → unknown 이 rollup 에서 managersUnknown 1 이 된다', async () => {
  const { clusterHealth } = await import('../src/nsx/client.js');
  const { scopedNsxRollup } = await import('../src/nsx/scope.js');
  const status = clusterHealth(null);
  assert.equal(status, 'unknown');
  const r = scopedNsxRollup({ managers: [{ id: 'x', status }] });
  assert.deepEqual([r.managersUp, r.managersDegraded, r.managersUnknown], [0, 0, 1]);
});

/* ── LEFT2603-02 ───────────────────────────────────────────────────── */

test('LEFT2603-02 splitHostPort — IPv6 대괄호 형태를 접속용 host(대괄호 없음)·hostPort(대괄호)로 나눈다', async () => {
  const { splitHostPort } = await import('../src/util/hostPort.js');
  assert.deepEqual(splitHostPort('https://[2001:db8::10]:8443/'), { host: '2001:db8::10', port: 8443, hostPort: '[2001:db8::10]:8443', ipv6: true });
  assert.deepEqual(splitHostPort('https://[fd00::10]'), { host: 'fd00::10', port: 443, hostPort: '[fd00::10]:443', ipv6: true });
  assert.deepEqual(splitHostPort('[2001:db8::1]:444'), { host: '2001:db8::1', port: 444, hostPort: '[2001:db8::1]:444', ipv6: true });
  // 대괄호 없는 IPv6 리터럴 — 포트 구분 불가, 전체가 호스트
  assert.equal(splitHostPort('2001:db8::1').host, '2001:db8::1');
  // IPv4·이름은 예전 동작 그대로
  assert.deepEqual(splitHostPort('https://10.0.0.5:9443'), { host: '10.0.0.5', port: 9443, hostPort: '10.0.0.5:9443', ipv6: false });
  assert.equal(splitHostPort('vc1.example.com').port, 443);
  assert.equal(splitHostPort('https://vc1.example.com/').host, 'vc1.example.com');
  assert.equal(splitHostPort('10.0.0.1:abc').host, '10.0.0.1');
  assert.equal(splitHostPort(''), null);
  assert.equal(splitHostPort('https://[bad'), null);
});

test('LEFT2603-02 인증서 감시 — IPv6 vCenter 의 host 가 [2001 로 잘리지 않고, 차단 사유가 실제 대역을 말한다', async () => {
  // ULA(fd00::/7)는 SSRF 가드가 막는 대역이라 네트워크 왕복 없이 결정적으로 확인된다.
  fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'v6', name: 'v6', host: 'https://[fd00::10]:8443', username: 'u', password: 'p', enabled: false },
  ] }));
  const { refreshCerts } = await import('../src/security/certMonitor.js');
  const res = await refreshCerts();
  const it = (res.items || []).find((x) => x.id === 'v6');
  assert.ok(it, '대상이 만들어져야 한다');
  assert.equal(it.host, 'fd00::10');
  assert.equal(it.port, 8443);
  assert.equal(it.status, 'blocked');
  assert.match(it.error, /ULA/);            // 예전: host '[fd00' → 'URL 형식이 올바르지 않습니다.'
});

test('LEFT2603-02 중계 점검 probe — IPv6 host·port 를 제대로 나눈다', async () => {
  const { probeRelayPath } = await import('../src/vcenter/relayProbe.js');
  const r = await probeRelayPath('https://[fd00::20]:9443', { timeoutMs: 500 });
  assert.equal(r.host, 'fd00::20');         // 예전: '[fd00'
  assert.equal(r.port, 9443);               // 예전: 443(split(':')[1] 이 빈 문자열)
  assert.equal(r.blocked, true);
  assert.match(r.reason, /ULA/);
});

test('LEFT2603-02 소스 — 세 호출부가 공용 파서를 쓰고 ":" split 으로 호스트를 자르지 않는다', () => {
  for (const f of ['security/certMonitor.js', 'vcenter/relayProbe.js', 'vcenter/soapClient.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.match(s, /splitHostPort\(/, f);
    assert.doesNotMatch(s, /(?:clean|hostNoScheme)\.split\(':'\)/, f);
  }
});

/* ── LEFT2603-02 후속: NSX 프록시 매핑 · HAProxy 설정 줄 ────────────── */

test('LEFT2603-02 nsx/proxy parseHostPort — IPv6 는 대괄호 없이(SAFE_TARGET_HOST 통과), IPv4·이름은 예전 그대로', async () => {
  const { parseHostPort } = await import('../src/nsx/proxy.js');
  assert.deepEqual(parseHostPort('https://[2001:db8::10]:8443/api'), { hostname: '2001:db8::10', port: 8443 });
  assert.deepEqual(parseHostPort('https://nsx.corp.local'), { hostname: 'nsx.corp.local', port: 443 });
  assert.deepEqual(parseHostPort('10.1.2.3:444'), { hostname: '10.1.2.3', port: 444 });
  // 매핑 저장 형식 검사(proxy/registry.js SAFE_TARGET_HOST 와 같은 정규식)를 통과해야 한다 — 예전 '[2001:db8::10]' 은 거부됐다.
  assert.match(parseHostPort('https://[2001:db8::10]').hostname, /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/);
});

test('LEFT2603-02 HAProxy 설정 줄 — IPv6 대상은 ipv6@<주소>:<포트>(포트 = 마지막 콜론 뒤), IPv4 는 예전 그대로', async () => {
  const { buildConfigBlock } = await import('../src/proxy/deploy.js');
  const { haproxyAddress } = await import('../src/util/hostPort.js');
  const block = buildConfigBlock([
    { id: 'a', name: 'NSX v6', protocol: 'nsx', publicPort: 20001, targetHost: '2001:db8::10', targetPort: 443 },
    { id: 'b', name: 'NSX v4', protocol: 'nsx', publicPort: 20002, targetHost: '10.1.2.3', targetPort: 443 },
  ]);
  assert.match(block, /^ {4}server target ipv6@2001:db8::10:443$/m);
  assert.match(block, /^ {4}server target 10\.1\.2\.3:443$/m);
  assert.doesNotMatch(block, /server target 2001:db8/);   // 접두 없는 IPv6(모호한 표기) 금지
  assert.equal(haproxyAddress('[fd00::1]', 8443), 'ipv6@fd00::1:8443');
  assert.equal(haproxyAddress('proxy.corp', 22), 'proxy.corp:22');
});
