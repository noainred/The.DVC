// v2.699 — 호스트 구성·보안(A1·A9·A11·A12) 수집·판정·드리프트·엣지 정제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServices, parseHostCfgProps, parseOptionValue, parseCertInfo, applyAdvanced, hostCfgFindings, clusterDrift,
  sanitizeHostCfg, HOST_CFG_PATHS, ADV_OPTIONS,
} from '../src/hostcfg/parse.js';
import { refreshHostCfg } from '../src/hostcfg/collect.js';
import { get, _resetHostCfgCache, put } from '../src/hostcfg/cache.js';
import { analyzeHostCfg } from '../src/hostcfg/analyze.js';
import { sanitizeInventoryList } from '../src/routes/central.js';

const NOW = 1_800_000_000_000;
const D = 86_400_000;
const SVC = '<service><key>TSM-SSH</key><label>SSH</label><running>true</running><policy>on</policy><sourcePackage><sourcePackageName>esx-base</sourcePackageName></sourcePackage></service>'
  + '<service><key>TSM</key><running>false</running><policy>off</policy></service><service><key>ntpd</key><running>true</running><policy>on</policy></service>'
  + '<service><key>vpxa</key><running>true</running><policy>on</policy></service>';

test('① 파서 — 서비스·NTP·DNS·잠금 모드·재부팅, 못 읽은 값은 null', () => {
  assert.deepEqual(parseServices(SVC), { ssh: { running: true, policy: 'on' }, shell: { running: false, policy: 'off' }, ntpd: { running: true, policy: 'on' } });
  assert.equal(parseServices(''), null);
  const h = parseHostCfgProps({
    'config.service': SVC,
    'config.dateTimeInfo': '<timeZone><key>UTC</key></timeZone><ntpConfig><server>ntp1</server><server>ntp2</server></ntpConfig>',
    'config.network.dnsConfig': '<dhcp>false</dhcp><hostName>esx1</hostName><address>10.0.0.53</address>',
    'summary.rebootRequired': 'true',
    'config.lockdownMode': 'lockdownNormal',
  }, NOW);
  assert.deepEqual(h.ntpServers, ['ntp1', 'ntp2']);
  assert.deepEqual(h.dnsServers, ['10.0.0.53']);
  assert.equal(h.lockdown, 'normal');
  assert.equal(h.rebootRequired, true);
  assert.equal(h.syslogHost, null, '고급 설정을 아직 안 읽었으면 null');
  const empty = parseHostCfgProps({ 'config.dateTimeInfo': '<timeZone/>' }, NOW);
  assert.deepEqual(empty.ntpServers, [], 'ntpConfig 가 없으면 서버 0개(읽었다)');
  assert.equal(empty.dnsServers, null, 'DNS 응답이 없으면 모름');
  assert.equal(empty.lockdown, null);
  assert.ok(HOST_CFG_PATHS.every((p) => !p.includes('lockdownMode')), 'lockdownMode(6.0+) 는 본 요청에 넣지 않는다');
});

test('② 고급 설정·인증서 — 빈 값은 "설정 없음"(\'\'), 없는 이름은 null', () => {
  const xml = '<returnval><key>Syslog.global.logHost</key><value xsi:type="xsd:string"></value></returnval>';
  assert.equal(parseOptionValue(xml, 'Syslog.global.logHost'), '');
  assert.equal(parseOptionValue('<returnval><key>X</key><value xsi:type="xsd:long">5</value></returnval>', 'X'), '5');
  assert.equal(parseOptionValue('', 'X'), null);
  const h = { syslogHost: null, lockFailures: null, shellTimeout: null, mob: null };
  applyAdvanced(h, 'Syslog.global.logHost', '');
  applyAdvanced(h, 'Security.AccountLockFailures', '0');
  applyAdvanced(h, 'UserVars.ESXiShellTimeOut', '900');
  applyAdvanced(h, 'Config.HostAgent.plugins.solo.enableMob', 'True');
  assert.deepEqual(h, { syslogHost: '', lockFailures: 0, shellTimeout: 900, mob: true });
  const c = parseCertInfo('<issuer>CN=ca</issuer><notAfter>2027-01-01T00:00:00Z</notAfter><subject>CN=esx1</subject><status>good</status>');
  assert.equal(c.notAfter, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(parseCertInfo('<subject>x</subject>').notAfter, null);
});

test('③ 판정 — 끊긴 호스트·미수집은 판정하지 않고, 0·빈 값과 null 을 구분한다', () => {
  const base = { id: 'vc1:host-1', connectionState: 'CONNECTED' };
  assert.deepEqual(hostCfgFindings({ ...base }, NOW), []);
  assert.deepEqual(hostCfgFindings({ ...base, connectionState: 'DISCONNECTED', hcfg: { rebootRequired: true } }, NOW), []);
  const codes = (hcfg) => hostCfgFindings({ ...base, hcfg }, NOW).map((f) => f.code);
  assert.deepEqual(codes({ certNotAfter: NOW - D }), ['cert-expired']);
  assert.deepEqual(codes({ certNotAfter: NOW + 30 * D }), ['cert-expiring']);
  assert.deepEqual(codes({ certNotAfter: NOW + 31 * D }), []);
  assert.deepEqual(codes({ ntpServers: null, syslogHost: null, lockFailures: null }), [], '모르는 값은 판정하지 않는다');
  assert.deepEqual(codes({ ntpServers: ['a'], services: { ntpd: { running: false } } }), ['ntp-none']);
  assert.deepEqual(codes({ ntpServers: [] }), ['ntp-none']);
  assert.deepEqual(codes({ syslogHost: '', lockFailures: 0, shellTimeout: 0, mob: true, acceptance: 'community', lockdown: 'disabled' }).sort(),
    ['acceptance-community', 'lock' + 'down-off', 'lockout-off', 'mob-enabled', 'shell-timeout-off', 'syslog-none'].sort());
});

test('④ 드리프트 — 다수값과 다른 호스트만, 동률이면 다수값 없음, 모르는 값·단독 호스트·standalone 은 비교 밖', () => {
  const mk = (id, cluster, build, ntp, extra = {}) => ({ id, vcenterId: 'vc1', cluster, build, connectionState: 'CONNECTED', hcfg: { ntpServers: ntp, ...extra } });
  const hosts = [
    mk('a', 'CL1', '100', ['n1'], { dnsServers: ['1'] }), mk('b', 'CL1', '100', ['n1'], { dnsServers: ['1'] }), mk('c', 'CL1', '200', ['N1'], { dnsServers: ['1'] }), mk('d', 'CL1', '100', null),
    mk('d2', 'CL1', '100', ['n1'], { dnsServers: ['2'] }),
    mk('e', 'CL2', '100', ['x']), mk('f', 'CL2', '200', ['y']),
    mk('g', 'standalone', '1', ['z']), mk('h', 'standalone', '2', ['w']),
    mk('i', 'CL3', '9', ['q']),
  ];
  const { perHost, clusters } = clusterDrift(hosts);
  assert.deepEqual(perHost.get('c'), [{ field: 'build', value: '200', majority: '100' }], 'NTP 는 대소문자를 무시해 같다');
  assert.equal(perHost.has('d'), false, '값을 모르는 호스트는 드리프트가 아니다');
  assert.deepEqual(perHost.get('d2'), [{ field: 'dns', value: '2', majority: '1' }]);
  const cl2 = clusters.find((c) => c.cluster === 'CL2');
  assert.equal(cl2.fields.build.majority, null);
  assert.equal(perHost.get('e').length, 2, '동률이면 양쪽 모두 표시(어느 쪽이 옳은지 모른다)');
  assert.ok(!clusters.some((c) => c.cluster === 'standalone' || c.cluster === 'CL3'));
});

test('⑤ refreshHostCfg — 상한·예산·없는 설정 이름(InvalidName)·lockdownMode 미지원·인증서', async () => {
  _resetHostCfgCache();
  const calls = [];
  const c = {
    async retrieveManyObjectProps(type, refs, paths) {
      calls.push([type, paths.join(',')]);
      if (type === 'HostSystem' && paths[0] === 'config.lockdownMode') throw new Error('InvalidProperty: config.lockdownMode');
      if (type === 'HostSystem') return refs.map((ref) => ({ ref, props: { 'config.service': SVC, 'summary.rebootRequired': 'false', 'configManager.certificateManager': `cm-${ref}`, 'configManager.advancedOption': `opt-${ref}`, 'configManager.imageConfigManager': `img-${ref}` } }));
      if (type === 'HostCertificateManager') return refs.map((ref) => ({ ref, props: { certificateInfo: `<notAfter>${new Date(NOW + 5 * D).toISOString()}</notAfter>` } }));
      return [];
    },
    async callRaw(body) {
      calls.push(['call', body.slice(1, 30)]);
      if (body.includes('UserVars.ESXiShellTimeOut')) throw new Error('InvalidName: UserVars.ESXiShellTimeOut');
      if (body.includes('Syslog.global.logHost')) return '<returnval><key>Syslog.global.logHost</key><value xsi:type="xsd:string">udp://s:514</value></returnval>';
      if (body.includes('Security.AccountLockFailures')) return '<returnval><key>Security.AccountLockFailures</key><value xsi:type="xsd:long">5</value></returnval>';
      if (body.includes('QueryHostAcceptanceLevel')) return '<returnval>partner</returnval>';
      return '';
    },
  };
  const settings = { hostCfgScan: true, hostCfgRefreshMs: 6 * 3_600_000, hostCfgPerCycle: 2 };
  const r = await refreshHostCfg(c, 'vc1', ['host-1', 'host-2', 'host-3'], { now: NOW, settings });
  assert.equal(r.due, 2, '주기당 상한');
  const h = get('vc1', 'host-1');
  assert.equal(h.syslogHost, 'udp://s:514');
  assert.equal(h.lockFailures, 5);
  assert.equal(h.shellTimeout, null, '그 버전에 없는 설정은 그 값만 모름');
  assert.equal(h.acceptance, 'partner');
  assert.equal(h.certNotAfter, NOW + 5 * D);
  assert.equal(h.lockdown, null);
  // 다음 주기 — lockdownMode 요청을 다시 하지 않고, 남은 호스트만 읽는다
  calls.length = 0;
  const r2 = await refreshHostCfg(c, 'vc1', ['host-1', 'host-2', 'host-3'], { now: NOW + 1000, settings });
  assert.equal(r2.due, 1);
  assert.ok(!calls.some(([t, p]) => t === 'HostSystem' && p === 'config.lockdownMode'), '미지원 경로는 다시 묻지 않는다');
  // 예산 0 → 시작하지 않은 호스트는 cut 으로 센다
  _resetHostCfgCache();
  const r3 = await refreshHostCfg(c, 'vc1', ['host-1'], { now: NOW, settings, budgetMs: -1 });
  assert.equal(r3.cut, 1);
  assert.equal(get('vc1', 'host-1'), null);
  // prune 은 allRefs 기준 — 연결 끊긴 호스트(이번 읽기 대상 밖)의 직전 값은 남는다
  put('vc1', 'host-9', { at: NOW });
  await refreshHostCfg(c, 'vc1', [], { now: NOW, settings, allRefs: ['host-9'] });
  assert.ok(get('vc1', 'host-9'));
  await refreshHostCfg(c, 'vc1', [], { now: NOW, settings, allRefs: [] });
  assert.equal(get('vc1', 'host-9'), null);
});

test('⑥ 분석 — 커버리지(미수집·끊김 분리)·코드별 개수·드리프트 행', () => {
  const hosts = [
    { id: 'a', vcenterId: 'vc1', name: 'a', cluster: 'CL', build: '1', connectionState: 'CONNECTED', hcfg: { rebootRequired: true, ntpServers: ['n'] } },
    { id: 'b', vcenterId: 'vc1', name: 'b', cluster: 'CL', build: '1', connectionState: 'CONNECTED', hcfg: { ntpServers: ['n'] } },
    { id: 'c', vcenterId: 'vc1', name: 'c', cluster: 'CL', build: '2', connectionState: 'CONNECTED', hcfg: { ntpServers: ['n'] } },
    { id: 'd', vcenterId: 'vc1', name: 'd', cluster: 'CL', build: '1', connectionState: 'CONNECTED' },
    { id: 'e', vcenterId: 'vc1', name: 'e', cluster: 'CL', build: '1', connectionState: 'DISCONNECTED', hcfg: { rebootRequired: true } },
  ];
  const r = analyzeHostCfg(hosts, { now: NOW });
  assert.deepEqual(r.coverage, { hosts: 5, cfg: 3, notCollected: 1, disconnected: 1 });
  assert.equal(r.byCode['reboot-required'].hosts, 1);
  assert.equal(r.byCode.drift.hosts, 1);
  assert.deepEqual(r.rows.map((x) => x.name), ['a', 'c']);
  assert.equal(r.vcenters[0].withFindings, 2);
});

test('⑦ 엣지 정제 — 아는 필드만, 모양이 아니면 null', () => {
  const v = sanitizeHostCfg({ at: NOW, lockdown: 'evil', services: { ssh: { running: 'yes', policy: 'on' } }, ntpServers: ['a', 5, null], syslogHost: '  ', certNotAfter: '1', extra: 1 });
  assert.equal(v.lockdown, null);
  assert.deepEqual(v.services.ssh, { running: null, policy: 'on' });
  assert.deepEqual(v.ntpServers, ['a']);
  assert.equal(v.syslogHost, '');
  assert.equal(v.certNotAfter, null);
  assert.equal(Object.hasOwn(v, 'extra'), false);
  const dropped = { coerced: 0 };
  const out = sanitizeInventoryList([{ id: 'vc1:host-1', name: 'h', hcfg: 'junk' }], 'vc1', 10, dropped);
  assert.equal(out[0].hcfg, null);
  assert.ok(ADV_OPTIONS.length >= 4);
});
