// v2.771 — 6회차 점검 G2(호스트 접근·NSX) 회귀 고정.
//  R6-F5-2: IPv4-mapped 요청자 IP('::ffff:a.b.c.d')를 IPv4 로 정규화(라우트·상태·계획·parseCidr/ipInCidr). 전역 clientIp 는 그대로.
//  R6-F5-3: 추가 규칙의 포트 '범위' drop/reject 가 포탈 포트를 덮으면 자기 잠금 오류(포함 판정 a≤p≤b, 소스 지정 검사도 같은 판정).
//  R6-F5-4: NSX 범위 판정에서 'Unknown'(지역 미지정 표식)을 빈 지역과 같이 취급 — 무귀속 매니저가 범위 계정에 새지 않게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771b-'));
process.env.CONFIG_DIR = tmp;
process.env.PORT = '4000';
const R = await import('../src/hostaccess/render.js');
const S = await import('../src/hostaccess/service.js');
const { registerHostAccess } = await import('../src/routes/admin/hostAccess.js');
const { clientIp } = await import('../src/util/rateLimit.js');
const { visibleNsxManagers, managerInScope, allowedRegions } = await import('../src/nsx/scope.js');

const CUR = { zone: 'public', target: 'default', interfaces: ['eth0'], sources: [], services: ['ssh'], ports: ['4000/tcp'], richRules: [] };
const LIST_ALL = `public (active)
  target: default
  interfaces: ens192
  sources:
  services: ssh
  ports: 4000/tcp
  rich rules:
`;
function fakeExec() {
  const calls = [];
  const fw = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: LIST_ALL, stderr: '' };
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
  return { calls, fw, sshdCtl: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), sshdActive: async () => true, isSudoDenied: () => false };
}

// ── R6-F5-2 ──
test('R6-F5-2 normalizeRequesterIp·ipInCidr — ::ffff:a.b.c.d 는 IPv4 로 판정', () => {
  assert.equal(R.normalizeRequesterIp('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(R.normalizeRequesterIp('::FFFF:10.0.0.5'), '10.0.0.5');
  assert.equal(R.normalizeRequesterIp('10.0.0.5'), '10.0.0.5');
  assert.equal(R.normalizeRequesterIp('2001:db8::1'), '2001:db8::1', '진짜 IPv6 는 원문');
  assert.equal(R.normalizeRequesterIp('::ffff:999.1.1.1'), '::ffff:999.1.1.1', '유효하지 않은 IPv4 는 바꾸지 않는다');
  assert.equal(R.ipInCidr('::ffff:127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(R.ipInCidr('::ffff:10.0.0.5', '10.0.0.0/24'), true);
  assert.equal(R.ipInCidr('::ffff:10.0.1.5', '10.0.0.0/24'), false);
  assert.equal(R.ipInCidr('10.1.2.3', '2001:db8::/32'), false, '패밀리 불일치는 그대로 false');
});

test('R6-F5-2 parseCidr — IPv4-mapped 입력은 IPv4 규칙으로(family="ipv6" 규칙을 만들지 않는다)', () => {
  assert.deepEqual(R.parseCidr('::ffff:10.0.0.5'), { family: 'ipv4', ip: '10.0.0.5', bits: 32, text: '10.0.0.5' });
  assert.equal(R.parseCidr('::ffff:10.0.0.0/120').text, '10.0.0.0/24');
  assert.equal(R.parseCidr('::ffff:10.0.0.5/128').text, '10.0.0.5');
  assert.equal(R.parseCidr('::ffff:10.0.0.0/64'), null, 'IPv4 범위를 넘는 접두(96 미만)는 거부');
  assert.equal(R.parseCidr('2001:db8::/32').family, 'ipv6', '진짜 IPv6 는 그대로');
  // '내 IP 추가' 가 옛 원문을 넣어도 정규화가 IPv4 rich rule 을 만든다.
  const { settings, errors } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['::ffff:10.0.0.5'] } }, { portalPorts: ['4000'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.web.allow, ['10.0.0.5']);
  const p = R.planCommands(settings, CUR, { requesterIp: '::ffff:10.0.0.5' });
  assert.deepEqual(p.errors, []);
  assert.ok(p.desiredRich.every((r) => !/family="ipv6"/.test(r)), JSON.stringify(p.desiredRich));
  assert.ok(p.desiredRich.includes('rule family="ipv4" source address="10.0.0.5" port port="4000" protocol="tcp" accept'));
});

test('R6-F5-2 planCommands — 허용목록 안의 ::ffff: 요청자를 거부하지 않고, 밖이면 IPv4 표기로 거부', () => {
  const { settings } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['10.0.0.0/24'] } }, { portalPorts: ['4000'] });
  assert.deepEqual(R.planCommands(settings, CUR, { requesterIp: '::ffff:10.0.0.5' }).errors, []);
  const out = R.planCommands(settings, CUR, { requesterIp: '::ffff:10.9.0.5' }).errors;
  assert.equal(out.length, 1);
  assert.match(out[0], /요청자 IP 10\.9\.0\.5 가 웹 허용목록에 없습니다/);
  // 추가 규칙 소스 지정 drop 도 정규화된 IP 로 판정.
  const s2 = R.normalizeSettings({ firewall: { extra: [{ port: '4000', proto: 'tcp', action: 'drop', sources: ['10.0.0.0/24'] }] } }, { portalPorts: ['4000'] }).settings;
  assert.ok(R.planCommands(s2, CUR, { requesterIp: '::ffff:10.0.0.5' }).errors.some((e) => /요청자 IP 10\.0\.0\.5 의 포탈 포트 4000\/tcp/.test(e)));
});

test('R6-F5-2 라우트 — 상태·계획이 정규화된 requesterIp 를 쓰고, 전역 clientIp 는 원문 그대로', async () => {
  S._setExec(fakeExec());
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  registerHostAccess({ get: reg('GET'), put: reg('PUT'), post: reg('POST') });
  const req = { socket: { remoteAddress: '::ffff:10.0.0.5' }, headers: {}, app: { get: () => false }, body: { settings: { web: { mode: 'allowlist', allow: ['10.0.0.0/24'] } } }, user: { username: 'admin' } };
  const call = (k) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
    routes[k](req, res);
  });
  assert.equal(clientIp(req), '::ffff:10.0.0.5', '전역 clientIp(레이트리밋·로그인 잠금 키) 형식은 바꾸지 않는다');
  const st = await call('GET /host-access');
  assert.equal(st.body.requesterIp, '10.0.0.5', '화면 "내 IP"·"내 IP 추가" 가 쓰는 값');
  const pl = await call('POST /host-access/plan');
  assert.deepEqual(pl.body.errors, [], JSON.stringify(pl.body.errors));
  assert.equal(pl.body.ok, true);
  // 서비스 직접 호출(원문)도 상태 응답은 정규화(이중 방어).
  assert.equal((await S.hostAccessStatus({ requesterIp: '::ffff:192.168.1.7' })).requesterIp, '192.168.1.7');
  S._setExec(null);
});

// ── R6-F5-3 ──
test('R6-F5-3 portCovers — 단일·범위 포함 판정(a≤p≤b)', () => {
  assert.equal(R.portCovers('1-65535', '4000'), true);
  assert.equal(R.portCovers('3999-4001', '4000'), true);
  assert.equal(R.portCovers('4000-4000', '4000'), true);
  assert.equal(R.portCovers('4000', '4000'), true);
  assert.equal(R.portCovers('4001-5000', '4000'), false);
  assert.equal(R.portCovers('1-3999', '4000'), false);
  assert.equal(R.portCovers('x', '4000'), false);
});

test('R6-F5-3 planCommands — 포탈 포트를 덮는 범위 drop/reject 는 오류(전체·요청자 소스), 덮지 않으면 통과', () => {
  const mk = (extra) => R.normalizeSettings({ firewall: { extra } }, { portalPorts: ['4000', '4443'] }).settings;
  const e1 = R.planCommands(mk([{ port: '1-65535', proto: 'tcp', action: 'drop' }]), CUR, { requesterIp: '10.0.0.5' }).errors;
  assert.ok(e1.some((e) => /포탈이 잠깁니다/.test(e) && /1-65535/.test(e)), JSON.stringify(e1));
  const e2 = R.planCommands(mk([{ port: '4440-4450', proto: 'tcp', action: 'reject' }]), CUR, { requesterIp: '10.0.0.5' }).errors;
  assert.ok(e2.some((e) => /포탈 포트 4443\/tcp/.test(e)), 'TLS 포탈 포트도 범위로 덮이면 오류');
  const e3 = R.planCommands(mk([{ port: '3999-4001', proto: 'tcp', action: 'drop', sources: ['10.0.0.0/24'] }]), CUR, { requesterIp: '10.0.0.5' }).errors;
  assert.ok(e3.some((e) => /요청자 IP 10\.0\.0\.5/.test(e)), '소스 지정 범위 drop 도 같은 판정');
  // 덮지 않는 범위·udp·accept·요청자 밖 소스는 그대로 통과.
  assert.deepEqual(R.planCommands(mk([{ port: '5000-6000', proto: 'tcp', action: 'drop' }]), CUR, { requesterIp: '10.0.0.5' }).errors, []);
  assert.deepEqual(R.planCommands(mk([{ port: '1-65535', proto: 'udp', action: 'drop' }]), CUR, { requesterIp: '10.0.0.5' }).errors, []);
  assert.deepEqual(R.planCommands(mk([{ port: '1-65535', proto: 'tcp', action: 'accept' }]), CUR, { requesterIp: '10.0.0.5' }).errors, []);
  assert.deepEqual(R.planCommands(mk([{ port: '1-65535', proto: 'tcp', action: 'drop', sources: ['192.168.0.0/16'] }]), CUR, { requesterIp: '10.0.0.5' }).errors, []);
});

// ── R6-F5-4 ──
test('R6-F5-4 NSX 범위 — Unknown 지역끼리 매칭으로 무귀속 매니저가 보이지 않는다', () => {
  const vcs = [{ id: 'vc-a', location: { region: 'Unknown' } }, { id: 'vc-b', location: { region: '유럽' } }, { id: 'vc-k', location: { region: 'KR' } }];
  const allowed = new Set(['vc-a']);
  const orphan = { id: 'nsx-corpB', region: 'Unknown', vcenterId: '' };
  assert.deepEqual(visibleNsxManagers([orphan], vcs, allowed).map((m) => m.id), []);
  assert.equal(managerInScope({ id: 'nsx-corpB', location: { region: 'Unknown' } }, vcs, allowed), false, '레지스트리 형태(location.region)');
  assert.equal(managerInScope({ id: 'nsx-corpB', location: { region: 'unknown' } }, vcs, allowed), false, '대소문자 무관');
  assert.deepEqual([...allowedRegions(vcs, new Set(['vc-a', 'vc-k']))], ['KR'], "'Unknown' 은 허용 지역 집합에 넣지 않는다");
  // vCenter 직접 귀속·실제 지역 귀속은 그대로.
  assert.equal(managerInScope({ id: 'x', vcenterId: 'vc-a', location: { region: 'Unknown' } }, vcs, allowed), true);
  assert.deepEqual(visibleNsxManagers([{ id: 'm-kr', region: 'KR' }, orphan], vcs, new Set(['vc-k'])).map((m) => m.id), ['m-kr']);
  // 전체 범위는 전부(기존 동작).
  assert.equal(visibleNsxManagers([orphan], vcs, null).length, 1);
  assert.equal(managerInScope(orphan, vcs, null), true);
});

test('R6-F5-4 실제 등록부 — 지역 미지정 저장값(Unknown)으로도 범위 계정에 숨김', async () => {
  process.env.DATA_SOURCE = 'live';
  const nreg = await import('../src/nsx/registry.js');
  const vreg = await import('../src/vcenter/registry.js');
  nreg.addManager({ id: 'nsx-corpB', name: 'B NSX', host: 'https://10.20.0.10', username: 'admin', password: 'pw' });
  const mgr = nreg.loadRegistry().find((m) => m.id === 'nsx-corpB');
  assert.ok(mgr, '등록됨');
  const r = vreg.addVcenter({ id: 'vc-a', name: 'A', host: 'https://10.10.0.5', username: 'u', password: 'p' });
  const vcRegion = r?.vcenter?.location?.region ?? 'Unknown';
  const vcs = [{ id: 'vc-a', location: { region: vcRegion } }];
  const allowed = new Set(['vc-a']);
  assert.equal(managerInScope(mgr, vcs, allowed), false);
  assert.deepEqual(visibleNsxManagers([{ id: mgr.id, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '' }], vcs, allowed), []);
});
