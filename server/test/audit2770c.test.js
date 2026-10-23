/**
 * v2.770 5회차 점검 — 수정 그룹 G3(원격 접속·Horizon) 회귀.
 *
 *  E5-1  범위 계정의 원격 대상은 (vcenterId, targetHost) **쌍**이다. 예전에는 IP 문자열이 허용 인벤토리 어딘가에 있으면 통과했고,
 *        vcenterId 를 비우면 기본 프록시(범위 밖 법인 망)로 같은 IP 에 터널·probe 가 열렸다. WS(mappingAccessIssue)·/rdp/:id 도 IP 만 봤다.
 *        vcenterId 가 비면 일치 객체에서 유일하게 유도한다(웹 IpamCore ipRemoteItem 이 '' 를 보낼 수 있다 — 'vcenterId 필수' 금지).
 *  E5-2  quick-connect 재사용은 같은 중계(proxyId)·같은 vCenter 의 매핑만 · 소유자 없는 매핑은 admin 에게만.
 *  E5-3  Horizon 세션 0건(빈 배열) 서버는 접속 0 으로 확정 — stateBlind 로 전체 합계·추이를 NULL 로 만들지 않는다(비배열은 그대로 모름).
 *  E5-4  매핑 포트는 정수 1~65535 만 · 대상의 ':' 는 IPv6 만 · 깨진 예전 매핑은 HAProxy 블록에서 건너뛰고 error 로 표시.
 *  E5-5  재사용 매핑이 active·manual 이 아니면 재프로비저닝(중계마다 간격) · manual 은 재시도하지 않는다.
 *  E5-6  인증 off(AUTH_ENABLED=false)의 WS SSH·RDP 도 HTTP 와 같은 합성 사용자(AUTH_DISABLED_ROLE)로 판정 — viewer 면 거부.
 *
 * 라우트·게이트웨이는 CONFIG_DIR 을 임시 폴더로 둔 자식 프로세스에서 실제 라우터·업그레이드 핸들러로 확인한다(127.0.0.1 바인딩 필요).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src') + '/';

const { resolveScopedTarget, mappingTargetScopeIssue } = await import('../src/proxy/targetHostScope.js');
const { normalizeSessions, combineServers, seriesRow } = await import('../src/horizon/sessions.js');

const SCOPE = /범위 내 vCenter/;
const AMBIG = /vCenter 를 지정하지 않으면/;

/** 자식 프로세스에서 script 를 돌리고 '@@' 줄의 JSON 을 돌려준다. */
function runChild(body, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2770c-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
  const script = `
    const SRC = ${JSON.stringify(SRC)};
    const express = (await import('express')).default;
    const out = {};
    try {
      ${body}
    } catch (e) { out.__error = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.__error, undefined, o.__error);
  return o;
}

/* ───────────────────────── E5-1 순수 판정 ───────────────────────── */

// 폴란드(vc-A, 범위 밖)와 미국(vc-B, 범위 안)에 같은 10.0.0.5 가 있다(RFC1918 겹침). vc-C 도 범위 안.
const SNAP = {
  vms: [
    { id: 'vm-a', name: 'pl-db', vcenterId: 'vc-A', ipAddresses: ['10.0.0.5'] },
    { id: 'vm-b', name: 'us-web', vcenterId: 'vc-B', ipAddresses: ['10.0.0.5'] },
    { id: 'vm-b2', name: 'us-app', vcenterId: 'vc-B', ipAddresses: ['10.0.0.7'] },
    { id: 'vm-c', name: 'us-app2', vcenterId: 'vc-C', ipAddresses: ['10.0.0.8'] },
    { id: 'vm-b3', name: 'dup', vcenterId: 'vc-B', ipAddresses: ['10.0.0.9'] },
    { id: 'vm-c3', name: 'dup2', vcenterId: 'vc-C', ipAddresses: ['10.0.0.9'] },
  ],
  hosts: [
    { id: 'vc-B:h1', vcenterId: 'vc-B', name: 'esx01.us.local', mgmtIp: '10.20.0.11' },
  ],
};
const BC = new Set(['vc-B', 'vc-C']);
const PROXY = { 'vc-B': 'us', 'vc-C': 'us', 'vc-A': 'default', '': 'default' };
const proxyIdOf = (vc) => PROXY[vc] || 'default';

test('E5-1 순수: vcenterId 를 비우면 유일하게 유도 · 범위 밖에 같은 IP 가 있거나 범위 안 여러 곳이면 거부', () => {
  // 수정 전에는 이 판정 자체가 없었다(targetHostScopeIssue 만 — 10.0.0.5 는 vc-B 에 있으니 통과, 프록시는 기본).
  assert.match(resolveScopedTarget(SNAP, BC, '10.0.0.5', '', { proxyIdOf }).issue, AMBIG, '범위 밖 vc-A 에도 같은 IP');
  assert.match(resolveScopedTarget(SNAP, BC, '10.0.0.9', '', { proxyIdOf }).issue, AMBIG, '범위 안 vc-B·vc-C 둘 다');
  const d = resolveScopedTarget(SNAP, BC, '10.0.0.7', '', { proxyIdOf });
  assert.deepEqual([d.issue, d.vcenterId, d.derived], [null, 'vc-B', true], '유일하면 그 vCenter 를 유도(IP 대장 원격 버튼 — vcenterId "")');
  assert.equal(resolveScopedTarget(SNAP, BC, 'esx01.us.local', undefined, { proxyIdOf }).vcenterId, 'vc-B', '호스트 이름');
  assert.equal(resolveScopedTarget(SNAP, BC, '10.20.0.11', '', { proxyIdOf }).vcenterId, 'vc-B', '원장 관리 IP(v2.744 RF-R1) 도 유도');
  assert.match(resolveScopedTarget(SNAP, BC, '10.99.0.1', '', { proxyIdOf }).issue, SCOPE, '인벤토리에 없는 IP(그대로 거부)');
});

test('E5-1 순수: vcenterId 를 주면 그 vCenter 의 인벤토리여야 하고, 같은 중계 경로의 범위 밖 충돌은 거부', () => {
  assert.equal(resolveScopedTarget(SNAP, BC, '10.0.0.5', 'vc-B', { proxyIdOf }).issue, null, 'vc-B 는 별도 중계(us) — 폴란드 10.0.0.5 와 다른 망');
  assert.match(resolveScopedTarget(SNAP, BC, '10.0.0.8', 'vc-B', { proxyIdOf }).issue, SCOPE, '다른 범위 안 vCenter(vc-C)의 IP 를 vc-B 로 — 그 중계 망의 같은 IP 는 다른 장비일 수 있다');
  assert.equal(resolveScopedTarget(SNAP, BC, '10.0.0.9', 'vc-C', { proxyIdOf }).issue, null, '모호한 IP 는 vCenter 를 지정하면 된다');
  // 같은 중계(기본)를 쓰는 범위 밖 vCenter 에 같은 IP → 어느 장비인지 알 수 없다.
  const allDefault = () => 'default';
  assert.match(resolveScopedTarget(SNAP, BC, '10.0.0.5', 'vc-B', { proxyIdOf: allDefault }).issue, SCOPE);
  // 전체 범위 계정은 예전 그대로(요청 vcenterId 그대로 — 비면 '').
  assert.deepEqual(resolveScopedTarget(SNAP, null, '10.0.0.5', '', { proxyIdOf }), { vcenterId: '', issue: null });
  assert.deepEqual(resolveScopedTarget(SNAP, null, '10.0.0.5', 'vc-A', { proxyIdOf }), { vcenterId: 'vc-A', issue: null });
  // 기존 규칙(비정규 IPv4 표기)은 먼저 그대로 적용된다.
  assert.match(resolveScopedTarget(SNAP, BC, '010.0.0.7', '', { proxyIdOf }).issue, SCOPE);
});

test('E5-1 순수: 저장된 매핑 재검사 — 예전 매핑(vcenterId "", 기본 중계)·중계가 바뀐 매핑은 거부', () => {
  assert.match(mappingTargetScopeIssue(SNAP, BC, { targetHost: '10.0.0.5', vcenterId: '', proxyId: 'default' }, { proxyIdOf }), AMBIG);
  assert.equal(mappingTargetScopeIssue(SNAP, BC, { targetHost: '10.0.0.5', vcenterId: 'vc-B', proxyId: 'us' }, { proxyIdOf }), null);
  assert.match(mappingTargetScopeIssue(SNAP, BC, { targetHost: '10.0.0.5', vcenterId: 'vc-B', proxyId: 'default' }, { proxyIdOf }), SCOPE, '매핑의 중계가 그 vCenter 의 중계가 아니다');
  assert.equal(mappingTargetScopeIssue(SNAP, BC, { targetHost: '10.0.0.7', vcenterId: '', proxyId: 'us' }, { proxyIdOf }), null, '예전 매핑도 유일하게 유도되고 중계가 맞으면 통과');
  assert.equal(mappingTargetScopeIssue(SNAP, null, { targetHost: '1.2.3.4', vcenterId: '', proxyId: 'x' }, { proxyIdOf }), null, '전체 범위는 그대로');
});

/* ───────────────────────── E5-1·E5-2 실제 라우터 ───────────────────────── */

const ROUTER_SETUP = `
  const { store } = await import(SRC + 'store.js');
  const reg = await import(SRC + 'proxy/registry.js');
  reg.saveConfig({ proxyHost: 'pl-proxy.example' });                                  // 기본 프록시 = 폴란드(vc-A 는 배정 없음)
  reg.saveProxy({ name: 'US-East', vcenterIds: ['vc-B'], proxyHost: 'us-proxy.example' });
  store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-A' }, { id: 'vc-B' }], hosts: [], datastores: [], networks: [], alarms: [],
    vms: [{ id: 'vm-a', name: 'pl-db', vcenterId: 'vc-A', ipAddresses: ['10.0.0.5'] },
          { id: 'vm-b', name: 'us-web', vcenterId: 'vc-B', ipAddresses: ['10.0.0.5'] },
          { id: 'vm-b2', name: 'us-app', vcenterId: 'vc-B', ipAddresses: ['10.0.0.7'] }] };
  const { remoteRouter } = await import(SRC + 'routes/remote.js');
  const { mappingAccessIssue } = await import(SRC + 'proxy/sshGateway.js');
  const USERS = {
    op: { username: 'op-us', role: 'operator', scope: { vcenters: ['vc-B'] } },
    sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-B'] } },
    full: { username: 'full', role: 'operator', scope: {} },
    admin: { username: 'root', role: 'admin', scope: {} },
  };
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = USERS[req.headers['x-u'] || 'full']; n(); });
  app.use('/api/remote', remoteRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/remote';
  const call = async (u, method, p, b) => {
    const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { s: r.status, j };
  };
`;

test('E5-1 라우터: 범위 계정이 vcenterId 를 비우면 범위 밖 중계로 터널을 만들지 못한다 · 유일하면 유도해 그 중계로 · WS·/rdp 도 쌍으로', () => {
  const o = runChild(`${ROUTER_SETUP}
    try {
      out.qcOutVc = (await call('op', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', vcenterId: 'vc-A' })).s;
      const empty = await call('op', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5' });
      out.qcEmpty = empty.s; out.qcEmptyProxy = empty.j && empty.j.proxyHost;
      out.probeEmpty = (await call('op', 'POST', '/probe', { targetHost: '10.0.0.5', targetPort: 22 })).s;
      const inVc = await call('op', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', vcenterId: 'vc-B' });
      out.qcIn = inVc.s; out.qcInProxy = inVc.j.proxyHost; out.qcInVc = inVc.j.mapping && inVc.j.mapping.vcenterId;
      out.wsIn = mappingAccessIssue(USERS.op, reg.getMapping(inVc.j.mapping.id));
      const derived = await call('op', 'POST', '/quick-connect', { protocol: 'rdp', targetHost: '10.0.0.7', vcenterId: '' });
      out.qcDerived = derived.s; out.qcDerivedVc = derived.j.mapping && derived.j.mapping.vcenterId; out.qcDerivedProxy = derived.j.proxyHost;
      // 수정 전에 만들어진 매핑(vcenterId '' · 기본 중계 = 폴란드)
      const legacy = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.5', owner: 'op-us', ephemeral: true }).mapping;
      const legacyRdp = reg.addMapping({ protocol: 'rdp', targetHost: '10.0.0.5', owner: 'op-us', ephemeral: true }).mapping;
      out.legacyProxy = legacy.proxyId;
      out.wsLegacy = mappingAccessIssue(USERS.op, legacy);
      out.wsLegacySadm = mappingAccessIssue(USERS.sadm, legacy);
      out.rdpLegacy = (await call('op', 'GET', '/rdp/' + legacyRdp.id)).s;
      out.rdpDerived = (await call('op', 'GET', '/rdp/' + derived.j.mapping.id)).s;
      // 범위 admin 의 상시 매핑 — 비우면 유도 · 중계 직접 지정 금지 · 모호하면 거부
      const sm = await call('sadm', 'POST', '/mappings', { name: 'x', protocol: 'ssh', targetHost: '10.0.0.7', targetPort: 22 });
      out.sadmMap = sm.s; out.sadmMapVc = sm.j.mapping && sm.j.mapping.vcenterId; out.sadmMapProxy = sm.j.mapping && sm.j.mapping.proxyId;
      out.sadmMapAmbig = (await call('sadm', 'POST', '/mappings', { name: 'y', protocol: 'ssh', targetHost: '10.0.0.5', targetPort: 22 })).s;
      out.sadmMapProxyPick = (await call('sadm', 'POST', '/mappings', { name: 'z', protocol: 'ssh', targetHost: '10.0.0.5', targetPort: 22, vcenterId: 'vc-B', proxyId: 'default' })).s;
      out.sadmList = ((await call('sadm', 'GET', '/mappings')).j.mappings || []).map((m) => m.id);
      out.legacyId = legacy.id;
      // 전체 범위 계정은 예전 그대로(vcenterId 생략 → 기본 프록시)
      const full = await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5' });
      out.fullQc = full.s; out.fullProxy = full.j.proxyHost; out.fullVc = full.j.mapping && full.j.mapping.vcenterId;
      out.fullProbe = (await call('full', 'POST', '/probe', { targetHost: '10.99.0.1', targetPort: 22 })).s;
    } finally { srv.close(); }
  `);
  assert.equal(o.qcOutVc, 404, '범위 밖 vcenterId 는 그대로 404');
  assert.equal(o.qcEmpty, 403, `수정 전: 200 + 기본 프록시(${o.qcEmptyProxy}) — 범위 밖 법인 망의 같은 IP 로 터널`);
  assert.equal(o.probeEmpty, 403, '수정 전: 기본 프록시 망으로 ping·포트 점검');
  assert.equal(o.qcIn, 200);
  assert.equal(o.qcInProxy, 'us-proxy.example');
  assert.equal(o.qcInVc, 'vc-B');
  assert.equal(o.wsIn, null, 'WS 재검사 — 쌍이 맞으면 통과');
  assert.equal(o.qcDerived, 200, 'IP 대장 원격 버튼(vcenterId "")은 유일하면 그대로 동작');
  assert.equal(o.qcDerivedVc, 'vc-B', '유도한 vCenter 를 매핑에 저장');
  assert.equal(o.qcDerivedProxy, 'us-proxy.example', '유도한 vCenter 의 중계로');
  assert.equal(o.legacyProxy, 'default');
  assert.ok(o.wsLegacy, '수정 전: null — IP 만 봐서 기본 중계(범위 밖 망) 매핑에 WS 가 붙었다');
  assert.ok(o.wsLegacySadm, '범위 admin 도 같은 판정');
  assert.equal(o.rdpLegacy, 404, '수정 전: 200 — .rdp 발급');
  assert.equal(o.rdpDerived, 200);
  assert.equal(o.sadmMap, 200);
  assert.equal(o.sadmMapVc, 'vc-B');
  assert.notEqual(o.sadmMapProxy, 'default');
  assert.equal(o.sadmMapAmbig, 403);
  assert.equal(o.sadmMapProxyPick, 403, '범위 admin 은 중계를 직접 골라 다른 법인 망으로 돌릴 수 없다');
  assert.equal(o.sadmList.includes(o.legacyId), false, '범위 admin 목록에서도 예전 기본 중계 매핑은 범위 밖');
  assert.equal(o.fullQc, 200, '전체 범위 계정 동작 불변');
  assert.equal(o.fullProxy, 'pl-proxy.example');
  assert.equal(o.fullVc, '');
  assert.equal(o.fullProbe, 200, '전체 범위 계정은 임의 대상 probe(기존 신뢰 모델)');
});

test('E5-2 라우터: 재사용은 같은 중계·같은 vCenter 의 매핑만 · 소유자 없는 매핑은 admin 에게만', () => {
  const o = runChild(`${ROUTER_SETUP}
    try {
      const a = await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', vcenterId: 'vc-A' });
      const b = await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', vcenterId: 'vc-B' });
      const a2 = await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', vcenterId: 'vc-A' });
      out.aId = a.j.mapping.id; out.bId = b.j.mapping.id; out.a2Id = a2.j.mapping.id;
      out.aProxy = a.j.proxyHost; out.bProxy = b.j.proxyHost;
      const orphan = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.6', owner: '' }).mapping;
      const op = await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.6' });
      const ad = await call('admin', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.6' });
      out.orphanId = orphan.id; out.opGot = op.j.mapping.id; out.opOwner = op.j.mapping.owner; out.adminGot = ad.j.mapping.id;
    } finally { srv.close(); }
  `);
  assert.notEqual(o.bId, o.aId, '수정 전: 같은 매핑 id — 미국 VM 접속이 폴란드 매핑으로 가고 비밀번호도 그쪽으로');
  assert.equal(o.aProxy, 'pl-proxy.example');
  assert.equal(o.bProxy, 'us-proxy.example');
  assert.equal(o.a2Id, o.aId, '같은 중계·vCenter 면 예전처럼 재사용');
  assert.notEqual(o.opGot, o.orphanId, '수정 전: 비-admin 에게 소유자 없는 매핑을 돌려줘 WS 가 항상 mapping-denied');
  assert.equal(o.opOwner, 'full');
  assert.equal(o.adminGot, o.orphanId, 'admin 은 소유자 없는 매핑 재사용(예전 그대로)');
});

/* ───────────────────────── E5-3 Horizon ───────────────────────── */

test('E5-3: 세션 0건(빈 배열) 서버는 접속 0 — 다중 팟 합계·추이가 NULL 이 되지 않는다 · 비배열은 그대로 모름', () => {
  const empty = normalizeSessions([]);
  assert.equal(empty.connected, 0, '수정 전: null');
  assert.equal(empty.usersConnected, 0, '수정 전: null');
  assert.equal(empty.disconnected, 0);
  const bad = normalizeSessions(null);
  assert.equal(bad.connected, null, '비배열(형식 미인식)은 모름 그대로');
  assert.equal(normalizeSessions({ sessions: [] }).usersConnected, null);
  const rec = (sid, raw) => ({ ok: true, serverId: sid, ...normalizeSessions(raw) });
  const comb = combineServers([rec('a', []), rec('b', [{ user_name: 'CORP\\kim', session_state: 'CONNECTED' }])]);
  assert.equal(comb.stateBlind, false, '수정 전: true(유휴 팟 하나로 전체가 "모름")');
  assert.equal(comb.connected, 1);
  assert.equal(comb.usersConnected, 1);
  assert.equal(seriesRow(comb).connected, 1, '추이에도 접속 1 이 적재된다(수정 전: NULL)');
  // 상태 필드가 없는 세션이 있는 서버는 여전히 모름(규칙 불변)
  const blind = combineServers([rec('a', []), rec('c', [{ user_name: 'CORP\\lee' }])]);
  assert.equal(blind.stateBlind, true);
  assert.equal(blind.connected, null);
});

/* ───────────────────────── E5-4 포트·대상 형식 ───────────────────────── */

test('E5-4: 매핑 포트는 정수 1~65535 · 대상의 ":" 는 IPv6 만 · 깨진 예전 매핑은 HAProxy 블록에서 건너뛰고 error', () => {
  const o = runChild(`${ROUTER_SETUP}
    try {
      const add = (x) => { const r = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.5', ...x }); return r.ok ? 'ok' : 'bad'; };
      out.tp = ['70000', -1, '1.5', 0, '22abc', true].map((v) => add({ targetPort: v }));
      out.pp = ['-3', 65536, '2.5'].map((v) => add({ publicPort: v }));
      out.okDefault = add({ targetPort: '' });
      out.okNum = add({ targetPort: '2222', publicPort: 21000 });
      out.colon = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.5:2222' }).ok;
      out.v6 = reg.addMapping({ protocol: 'nsx', targetHost: '2001:db8::10', targetPort: 443 }).ok;
      out.qc = (await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', targetPort: '70000' })).s;
      out.qcNeg = (await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5', targetPort: -1 })).s;
      out.post = (await call('admin', 'POST', '/mappings', { name: 'p', protocol: 'ssh', targetHost: '10.0.0.5', targetPort: 22, publicPort: '-3' })).s;
      const { buildConfigBlock } = await import(SRC + 'proxy/deploy.js');
      const block = buildConfigBlock([
        { id: 'good1', name: 'g', protocol: 'ssh', publicPort: 20001, targetHost: '10.0.0.5', targetPort: 22 },
        { id: 'bad1', name: 'b', protocol: 'ssh', publicPort: 20002, targetHost: '10.0.0.6', targetPort: 70000 },
        { id: 'bad2', name: 'c', protocol: 'ssh', publicPort: -3, targetHost: '10.0.0.7', targetPort: 22 },
        { id: 'bad3', name: 'd', protocol: 'ssh', publicPort: 20004, targetHost: '10.0.0.8:2222', targetPort: 22 },
        { id: 'v6', name: 'e', protocol: 'nsx', publicPort: 20005, targetHost: '2001:db8::10', targetPort: 443 },
      ]);
      out.block = block;
      // 저장소에 이미 들어간 깨진 매핑(수정 전 생성) — 배포 성공 표시에서 active 로 둔갑하지 않는다.
      const good = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.5', targetPort: 22 }).mapping;
      const legacyBad = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.6', targetPort: 22 }).mapping;
      legacyBad.targetPort = 70000;   // 수정 전 저장분 흉내
      const { markDeployed } = await import(SRC + 'proxy/provision.js');
      markDeployed([reg.getMapping(good.id), reg.getMapping(legacyBad.id)]);
      out.goodSt = reg.getMapping(good.id).status; out.badSt = reg.getMapping(legacyBad.id).status;
    } finally { srv.close(); }
  `);
  assert.deepEqual(o.tp, ['bad', 'bad', 'bad', 'bad', 'bad', 'bad'], '수정 전: 70000·-1·1.5 가 그대로 저장');
  assert.deepEqual(o.pp, ['bad', 'bad', 'bad']);
  assert.equal(o.okDefault, 'ok', '빈 값은 기본 포트');
  assert.equal(o.okNum, 'ok');
  assert.equal(o.colon, false, '수정 전: true → ipv6@10.0.0.5:2222:22');
  assert.equal(o.v6, true, 'IPv6 대상(v2.603 haproxyAddress)은 그대로');
  assert.equal(o.qc, 400);
  assert.equal(o.qcNeg, 400);
  assert.equal(o.post, 400);
  assert.match(o.block, /server target 10\.0\.0\.5:22$/m);
  assert.match(o.block, /server target ipv6@2001:db8::10:443$/m);
  assert.doesNotMatch(o.block, /70000|bind \*:-3|10\.0\.0\.8:2222/, '깨진 줄이 블록에 들어가면 haproxy -c 가 블록 전체를 거부한다');
  assert.match(o.block, /# skipped ra_bad1/);
  assert.equal(o.goodSt, 'active');
  assert.equal(o.badSt, 'error');
});

/* ───────────────────────── E5-5 재사용 매핑 재프로비저닝 ───────────────────────── */

test('E5-5: 재사용 매핑이 error 면 간격을 두고 다시 프로비저닝 · manual 은 재시도하지 않는다', () => {
  const o = runChild(`${ROUTER_SETUP}
    const remote = await import(SRC + 'routes/remote.js');
    try {
      // 일시 장애: Data Plane 이 응답하지 않는 주소(캐시 직접 조작 — 재현 편의)
      const c = reg.getConfig(); c.dataplane = { ...c.dataplane, enabled: true, url: 'http://127.0.0.1:1' };
      const qc = async () => (await call('full', 'POST', '/quick-connect', { protocol: 'ssh', targetHost: '10.0.0.5' })).j.mapping;
      const a = await qc(); out.st1 = a.status;
      c.dataplane.enabled = false;                       // 장애 복구(여기서는 수동 구성으로 바뀐 것으로 관찰한다)
      const b = await qc(); out.st2 = b.status; out.same2 = a.id === b.id;   // 간격 안 — 재시도하지 않는다(reload 폭주 방지)
      remote._resetProvisionRetryForTest();
      const d = await qc(); out.st3 = d.status; out.same3 = a.id === d.id;   // 간격 지남 — 다시 프로비저닝
      c.dataplane.enabled = true;                         // 다시 장애. manual 매핑은 재시도하지 않아야 그대로 manual
      remote._resetProvisionRetryForTest();
      const e = await qc(); out.st4 = e.status;
      out.retryMs = remote.REPROVISION_RETRY_MS;
    } finally { srv.close(); }
  `);
  assert.equal(o.st1, 'error');
  assert.equal(o.st2, 'error', '재시도 간격 안');
  assert.equal(o.same2, true);
  assert.equal(o.st3, 'manual', '수정 전: error 그대로(재프로비저닝 없음)');
  assert.equal(o.same3, true, '같은 매핑을 고쳐 쓴다');
  assert.equal(o.st4, 'manual', 'manual 은 재시도하지 않는다');
  assert.ok(o.retryMs >= 10_000, '재시도 간격이 있어야 한다(HAProxy reload 폭주 방지)');
});

/* ───────────────────────── E5-6 인증 off WS ───────────────────────── */

const WS_SETUP = `
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const reg = await import(SRC + 'proxy/registry.js');
  const gw = await import(SRC + 'proxy/sshGateway.js');
  const rdp = await import(SRC + 'proxy/guacdTunnel.js');
  const server = http.createServer((_q, s) => s.end('ok'));
  gw.attachSshGateway(server); rdp.attachRdpGateway(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const open = (p, onOpen) => new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + p);
    const res = { status: null, close: null, reason: '' };
    ws.on('unexpected-response', (_q, r) => { res.status = r.statusCode; resolve(res); });
    ws.on('open', () => { res.status = 101; onOpen && onOpen(ws); });
    ws.on('close', (code, reason) => { res.close = code; res.reason = String(reason); resolve(res); });
    ws.on('error', () => resolve(res));
    setTimeout(() => { try { ws.terminate(); } catch {} resolve(res); }, 8000).unref();
  });
  const sshM = reg.addMapping({ protocol: 'ssh', targetHost: '10.0.0.5', targetPort: 22, owner: 'anonymous' }).mapping;
  const rdpM = reg.addMapping({ protocol: 'rdp', targetHost: '10.0.0.6', targetPort: 3389, owner: 'anonymous' }).mapping;
  const sshTry = () => open('/api/remote/ssh', (ws) => ws.send(JSON.stringify({ type: 'auth', mappingId: sshM.id, username: 'root', password: '' })));
  const rdpTry = () => open('/api/remote/rdp?mappingId=' + rdpM.id + '&ticket=x');
`;

test('E5-6: 인증 off(operator) — 웹 SSH·RDP 가 HTTP 와 같은 익명 사용자로 매핑 판정을 통과한다', () => {
  const o = runChild(`${WS_SETUP}
    try {
      out.user = gw.authDisabledRemoteUser();
      out.ssh = await sshTry();
      out.rdp = await rdpTry();
    } finally { server.close(); }
  `, { AUTH_ENABLED: 'false', AUTH_DISABLED_ROLE: 'operator' });
  assert.deepEqual(o.user, { username: 'anonymous', role: 'operator', name: 'Anonymous' }, 'HTTP authMiddleware 의 req.user 와 같은 모양');
  assert.equal(o.ssh.status, 101);
  // 빈 비밀번호 거부(4400)는 매핑 판정 **다음** 단계다 — 여기까지 왔으면 매핑 판정을 통과했다(대상에는 접속하지 않는다).
  assert.equal(o.ssh.close, 4400, `수정 전: 4403 mapping-denied — ${JSON.stringify(o.ssh)}`);
  assert.equal(o.rdp.status, 101);
  assert.notEqual(o.rdp.reason, 'mapping-denied', '수정 전: 1011 mapping-denied');
  assert.match(o.rdp.reason, /guacd not configured/, '매핑 판정 다음 단계(guacd 미설정)에서 멈춘다');
});

test('E5-6: 인증 off 라도 AUTH_DISABLED_ROLE=viewer 면 WS SSH·RDP 업그레이드를 거부한다(HTTP requirePerm 과 일치)', () => {
  const o = runChild(`${WS_SETUP}
    try {
      out.ssh = await sshTry();
      out.rdp = await rdpTry();
    } finally { server.close(); }
  `, { AUTH_ENABLED: 'false', AUTH_DISABLED_ROLE: 'viewer' });
  assert.equal(o.ssh.status, 403, `수정 전: 101(이후 mapping-denied) — ${JSON.stringify(o.ssh)}`);
  assert.equal(o.rdp.status, 403);
});
