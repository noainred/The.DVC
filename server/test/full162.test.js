/**
 * 전체 점검 162회차 — 최종 반증(157 ~ 160회차가 넣은 수정을 실행으로 깨 본 것) 확정분 회귀.
 *  R1 (157 B1) 단일 세션: 업그레이드 전 이름 키(`kim`)로 등록된 AD 세션이 새 판의 다른 표기(`CORP\kim` · `kim@도메인`) 로그인에 끊긴 뒤, 그 새 세션이 로그아웃하면 되살아났다.
 *  D1 (157 B1) 접는 범위: `DOMAIN\` 를 어느 도메인이든 떼어 `CORP\kim` 과 `OTHER\kim` 이 서로를 끊었다 → 설정한 도메인(전체 이름 · 첫 마디)일 때만 접는다(@ 꼴과 같은 규칙).
 *  P3 (157 B5 의 남은 것) `/remote/deploy/test`: 기본 · 공유 중계 서버를 바꿀 수 없는 범위 계정이 저장 비밀로 임의 경로를 `test -r` 해 파일 존재 · 읽기 여부를 알아냈다.
 *  N2 (158 N158-2) 긴급중단을 **푼 직후**(다음 병합 전)의 샘플이 중단 전 값을 지금 값으로 적재했다 · Prometheus `/metrics` 는 긴급중단 동안에도 얼어 있는 값을 냈다.
 *  L1 · L2 (159) 정리 건너뜀이 그 정리 틱의 last 에만 실렸다(통신 점검 — 다음 주기에 사라짐) · 콘솔뿐이었다(전송 속도) → 폴러 상태에 계속 싣는다.
 *  S1 (160) 활성 조닝 별칭 되찾기: 묶음 별칭이 앞에 있으면 끝점마다 따로 있는 별칭을 덮었다(순서에 따라 답이 달랐다) → WWN 수가 가장 적은 별칭.
 *  N3 (158 N158-3 의 남은 같은 꼴 3파일) · A1 (160 I1 의 뿌리 — 에이전트 이름 규칙이 ‘__proto__’ · ‘constructor’ 를 받는다).
 *  X  (159) 값 전용 엑셀 로더: exceljs 의 parseWorkbook 이 없어지면 닫히는가(159 가 확인하지 못한 가드) · 동시 로드 — 결함 0(고정만).
 * 원칙: 실제 함수 · 실제 라우터 · 실제 DB 를 불러 값으로 판정한다(소스 grep 은 호출부 한 줄 확인에만). 모듈 상태 · env 가 갈리는 것은 자식 프로세스.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'full162-'));
Object.assign(process.env, { CONFIG_DIR: DIR, AUTH_ENABLED: 'true', AUTH_SECRET: 'full162-secret-0123456789abcdefghijklmnop', AUTH_TOKEN_TTL: '8h', DATA_SOURCE: 'live', OTP_ROLE_ENFORCE: 'false', SSRF_ALLOW_LOOPBACK: 'true', SSH_HOSTKEY_POLICY: 'observe' });
delete process.env.CENTRAL_URL;
const closers = [];
test.after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  fs.rmSync(DIR, { recursive: true, force: true });
});
const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
/** 자식 프로세스에서 스크립트를 돌려 `RES <json>` 한 줄을 받는다(env · 모듈 상태 격리). */
function child(script, env = {}, { timeout = 120_000, args = [] } = {}) {
  const cfg = fs.mkdtempSync(path.join(DIR, 'c-'));
  const r = spawnSync(process.execPath, [...args, '--input-type=module', '-e', script], { timeout, encoding: 'utf8',
    env: { ...process.env, CONFIG_DIR: cfg, DB_DIR: cfg, TEMP_DB_PATH: path.join(cfg, 'host-temp.db'), CENTRAL_URL: '', ...env } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  assert.ok(line, `자식이 결과를 내야 한다(signal ${r.signal} · status ${r.status}): ${String(r.stderr || '').slice(-600)}`);
  return JSON.parse(line.slice(4));
}

// AD 가 켜진 설정(접속은 하지 않는다 — 토큰 · 등록부 판정만) · 단일 세션 강제
const writeAd = (domain) => fs.writeFileSync(path.join(DIR, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: 'ldap://127.0.0.1:1', domain, baseDN: 'dc=corp,dc=local', defaultRole: 'viewer', timeoutMs: 1000 } }));
writeAd('corp.local');
const A = await import('../src/auth/auth.js');
const AD = await import('../src/auth/ad.js');
const SESS = await import('../src/auth/sessions.js');
const SEC = await import('../src/security/securitySettings.js');
const { onSessionRevoked } = await import('../src/auth/sessionRevocation.js');
SEC.saveSessionSecurity({ idleLogoutEnabled: false, singleSession: true, sessionMaxHours: 0 });
const setDomain = (domain) => { writeAd(domain); AD._resetAdConfigReadForTest(); AD.invalidateAdPolicyCache(); };
const adTok = (sub, sid) => A.signToken({ sub, role: 'viewer', name: sub, src: 'ad', ep: AD.adEpochOf(AD.loadAdConfig()), sid });
const alive = (t) => !!A.resolveTokenUser(t);
/** 로그인 라우트가 하는 등록 그대로(routes/auth.js — 같은 인자) */
const adLogin = (name) => { const sid = SESS.newSessionId(); SESS.setActiveSession(name, sid, { key: A.activeSessionKeyOf(name, false), legacyKeyOf: A.legacySessionKeyOf }); return { name, sid, t: adTok(name, sid) }; };
const adLogout = (s) => SESS.clearActiveSessionIf(s.name, s.sid, { key: A.activeSessionKeyOf(s.name, false) });

test('R1 단일 세션 — 업그레이드 전 이름 키의 AD 세션은 다른 표기의 새 로그인에 끊긴 뒤, 그 새 세션이 로그아웃해도 되살아나지 않는다 · 걷은 세션마다 폐기를 알린다 · 로컬 계정의 기록은 걷지 않는다', () => {
  const events = [];
  const off = onSessionRevoked((e) => events.push(e));
  try {
    for (const [legacyName, newName] of [['kim', 'CORP\\kim'], ['Lee@corp.local', 'lee'], ['corp.local\\choi', 'CHOI@CORP']]) {
      const sid0 = SESS.newSessionId();
      SESS.setActiveSession(legacyName, sid0);                       // 예전 판의 등록(이름 = 키)
      const t0 = adTok(legacyName, sid0);
      assert.equal(alive(t0), true, `${legacyName}: 업그레이드 직후 예전 세션은 그대로 유효(전원 재로그인 없음)`);
      const s1 = adLogin(newName);
      assert.equal(alive(s1.t), true);
      assert.equal(alive(t0), false, `${legacyName} → ${newName}: 새 로그인이 예전 세션을 끊는다`);
      assert.ok(events.some((e) => e.sid === sid0 && e.reason === 'single-session-replaced'), `${legacyName}: 걷은 예전 세션의 폐기를 알린다(열린 SSH · RDP 연결)`);
      assert.equal(adLogout(s1), true);
      assert.equal(alive(s1.t), false);
      assert.equal(alive(t0), false, `${legacyName} → ${newName}: 새 세션이 로그아웃한 뒤 끊긴 예전 토큰이 되살아났다(수정 전: true)`);
      assert.equal(SESS.listActiveSessions().some((x) => x.username === legacyName), false, '예전 이름 기록은 걷혔다');
    }
    // 같은 사람의 예전 기록이 둘(표기 둘로 따로 로그인해 둔 것) — 둘 다 걷고 둘 다 알린다
    const a = SESS.newSessionId(); const b = SESS.newSessionId();
    SESS.setActiveSession('han', a); SESS.setActiveSession('CORP\\han', b);
    const s = adLogin('han@corp.local');
    assert.equal(alive(adTok('han', a)), false); assert.equal(alive(adTok('CORP\\han', b)), false);
    assert.ok(events.some((e) => e.sid === a) && events.some((e) => e.sid === b));
    adLogout(s);
    assert.equal(alive(adTok('han', a)), false); assert.equal(alive(adTok('CORP\\han', b)), false);

    // 로컬 계정 park 의 세션 기록(이름 키)은 AD `CORP\park` 로그인이 걷지 않는다(다른 계정 — 로컬 이름이 있으면 그 이름의 AD 세션은 없다)
    assert.equal(A.createUser({ username: 'park', role: 'viewer', password: 'Local#Pass12345' }, { trusted: true }).ok, true);
    const lu = A.getUser('park'); const lsid = SESS.newSessionId();
    SESS.setActiveSession('park', lsid);
    const lt = A.signToken({ sub: 'park', role: 'viewer', name: 'park', src: 'local', tv: lu.tokenVersion || 0, sid: lsid });
    assert.equal(alive(lt), true);
    assert.equal(A.legacySessionKeyOf('park'), '', '로컬 계정 이름의 예전 기록은 로컬 세션이다(키 없음)');
    const adp = adLogin('CORP\\park');
    assert.equal(alive(lt), true, 'AD 로그인이 같은 이름 로컬 계정의 세션을 끊었다');
    assert.equal(alive(adp.t), true);
    adLogout(adp);
    assert.equal(alive(lt), true);
    // 다른 사람(다른 도메인)의 예전 기록도 걷지 않는다
    const o = SESS.newSessionId(); SESS.setActiveSession('OTHER\\kim', o);
    const k = adLogin('kim');
    assert.equal(alive(adTok('OTHER\\kim', o)), true, '다른 도메인의 같은 이름 세션을 끊었다');
    adLogout(k); SESS.clearActiveSession('OTHER\\kim');
    // 재기동(파일에서 다시 읽음) 뒤에도 같은 판정
    const r1 = adLogin('Yoon'); SESS._resetSessions();
    assert.equal(alive(r1.t), true); adLogout(r1);
  } finally { off?.(); }
  // 호출부 한 줄 확인 — 로그인 라우트가 같은 인자를 준다
  const src = fs.readFileSync(path.join(SRC, 'routes/auth.js'), 'utf8');
  assert.match(src, /setActiveSession\(user\.username, sid, \{[^}]*legacyKeyOf: legacySessionKeyOf[^}]*\}\)/);
});

test('D1 adAccountKey — DOMAIN\\ 와 @도메인 은 설정한 도메인(전체 이름 · 첫 마디)일 때만 접는다: 다른 도메인의 같은 이름은 서로를 끊지 않는다 · 같은 계정의 표기 변형은 한 자리', () => {
  try {
    setDomain('Corp.Local');
    for (const n of ['kim', 'KIM', ' Kim ', 'CORP\\kim', 'corp\\KIM', 'corp.local\\kim', 'kim@corp.local', 'KIM@CORP.LOCAL', 'kim@corp']) assert.equal(AD.adAccountKey(n), 'ad:kim', n);
    assert.equal(AD.adAccountKey('OTHER\\kim'), 'ad:other\\kim');
    assert.equal(AD.adAccountKey('kim@other.local'), 'ad:kim@other.local');
    assert.equal(AD.adAccountKey('other.local\\kim'), 'ad:other.local\\kim');
    assert.equal(AD.adAccountKey('\\kim'), 'ad:\\kim', '도메인 부분이 빈 값은 접지 않는다');
    assert.equal(AD.adAccountKey('corp\\'), 'ad:corp\\', '이름이 빈 값은 원문 그대로');
    // 다른 도메인의 같은 이름 — 두 세션이 함께 산다(수정 전: 뒤 로그인이 앞 세션을 끊었다)
    const a = adLogin('CORP\\kim'); const b = adLogin('OTHER\\kim');
    assert.equal(alive(a.t), true, 'OTHER\\kim 의 로그인이 CORP\\kim 의 세션을 끊었다'); assert.equal(alive(b.t), true);
    // 같은 계정의 표기 변형은 여전히 한 자리(157 B1 은 그대로)
    const c = adLogin('kim@corp.local');
    assert.equal(alive(a.t), false); assert.equal(alive(c.t), true); assert.equal(alive(b.t), true);
    adLogout(b); adLogout(c);
    // 도메인을 설정하지 않은 구성 — 어느 도메인인지 모른다: DOMAIN\ · @도메인 모두 그대로(대소문자만 접는다)
    setDomain('');
    assert.equal(AD.adAccountKey('CORP\\Kim'), 'ad:corp\\kim');
    assert.equal(AD.adAccountKey('corp\\KIM'), 'ad:corp\\kim');
    assert.equal(AD.adAccountKey('OTHER\\kim'), 'ad:other\\kim');
    assert.equal(AD.adAccountKey('kim@corp.local'), 'ad:kim@corp.local');
    assert.equal(AD.adAccountKey('Kim'), 'ad:kim');
    // 길고 이상한 입력도 선형
    const t0 = Date.now(); AD.adAccountKey(`${'\\'.repeat(20000)}x`); AD.adAccountKey(`${'@'.repeat(20000)}x`); assert.ok(Date.now() - t0 < 500);
  } finally { setDomain('corp.local'); }
});

test('P3 /remote/deploy/test — 이 중계 서버 설정을 바꿀 수 없는 범위 계정(기본 · 공유)은 저장 비밀로 다른 경로를 시험하지 못한다 · 전체 범위 계정 · 자기 범위만 배정된 중계 서버 · 비밀번호를 직접 넣은 시험은 그대로', async () => {
  const ssh2 = (await import('ssh2')).default;
  const express = (await import('express')).default;
  const reg = await import('../src/proxy/registry.js');
  const { store } = await import('../src/store.js');
  const { remoteRouter } = await import('../src/routes/remote.js');
  const { authRouter } = await import('../src/routes/auth.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }], vms: [], hosts: [] };
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const cmds = []; let conns = 0;
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    conns += 1;
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'Stored-Root-Pw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => { const s = accept(); s.on('exec', (acc, _rej, info) => { cmds.push(info.command); const st = acc(); st.write('OK\n'); st.exit(0); st.end(); }); }));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => sshd.close(() => r())));
  const port = sshd.address().port;
  const depBase = { enabled: true, host: '127.0.0.1', port, username: 'root', password: 'Stored-Root-Pw' };
  reg.saveConfig({ deploy: { ...depBase } });                                                             // 기본 중계 서버(전 법인 공용) — 경로는 기본값
  const shared = reg.saveProxy({ name: 'shared162', proxyHost: '10.9.9.1', vcenterIds: ['vc-a', 'vc-b'], deploy: { ...depBase, haproxyConfigPath: '/opt/haproxy/shared.cfg' } });
  const mine = reg.saveProxy({ name: 'mine162', proxyHost: '10.9.9.2', vcenterIds: ['vc-a'], deploy: { ...depBase } });
  assert.equal(shared.ok, true, JSON.stringify(shared)); assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal(A.createUser({ username: 'sadm162', role: 'admin', password: 'Scoped#Pass12345', scope: { vcenters: ['vc-a'] } }, { trusted: true }).ok, true);
  assert.equal(A.createUser({ username: 'fadm162', role: 'admin', password: 'Full#Pass1234567' }, { trusted: true }).ok, true);
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter); app.use('/api/remote', A.authMiddleware, A.requireEnrolled, remoteRouter);
  const web = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => web.close(() => r())));
  const base = `http://127.0.0.1:${web.address().port}/api`;
  const login = async (username, password) => {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const b = await r.json(); assert.equal(r.status, 200, `${username}: ${JSON.stringify(b)}`); return b.token;
  };
  const scoped = await login('sadm162', 'Scoped#Pass12345');
  const full = await login('fadm162', 'Full#Pass1234567');
  const testAs = async (tok, proxyId, deploy) => {
    const n0 = cmds.length; const c0 = conns;
    const r = await fetch(`${base}/remote/deploy/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ proxyId, deploy }) });
    return { status: r.status, body: await r.json().catch(() => null), sent: cmds.slice(n0), connected: conns - c0 };
  };
  const OTHER = '/etc/shadow';   // 유효한 글자의 임의 경로 — 화이트리스트는 통과한다(157 B5)
  // ① 범위 계정 × 기본 중계 서버 — 저장 비밀로 다른 경로: 거절(접속 · 명령 없음). 수정 전: `test -r /etc/shadow` 가 돌고 configReadable 로 답했다
  for (const [id, saved] of [['default', '/etc/haproxy/haproxy.cfg'], [shared.proxy.id, '/opt/haproxy/shared.cfg']]) {
    const r = await testAs(scoped, id, { haproxyConfigPath: OTHER });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false, `${id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.method, 'carry-refused');
    assert.equal(r.body.configReadable, undefined, '읽기 여부를 답하지 않는다');
    assert.equal(r.connected, 0, `${id}: 접속하지 않는다`); assert.deepEqual(r.sent, []);
    assert.doesNotMatch(String(r.body.reason), /`/, '화면 문구에 백틱 없음');
    // 저장된 경로(같은 값) · 경로 칸 없음은 예전 그대로 시험한다
    const same = await testAs(scoped, id, { haproxyConfigPath: saved });
    assert.equal(same.body.ok, true, JSON.stringify(same.body));
    assert.equal(same.sent[same.sent.length - 1], `test -r ${saved} && echo OK || echo MISSING`);
    const none = await testAs(scoped, id, {});
    assert.equal(none.body.ok, true, JSON.stringify(none.body));
    assert.equal(none.sent[none.sent.length - 1], `test -r ${saved} && echo OK || echo MISSING`);
  }
  // 빈 칸은 기본 경로다 — 저장값이 기본이 아닌 공유 중계 서버에서는 '다른 경로' 다
  assert.equal((await testAs(scoped, shared.proxy.id, { haproxyConfigPath: '' })).body.method, 'carry-refused');
  assert.equal((await testAs(scoped, 'default', { haproxyConfigPath: '' })).body.ok, true);
  // 글자가 아닌 값은 500 이 아니라 경로 사유로 거절(강제 변환 함정을 글자로 바꾸지 않는다)
  for (const bad of [{ toString: 1 }, 5, ['/etc/shadow']]) {
    const r = await testAs(scoped, 'default', { haproxyConfigPath: bad });
    assert.equal(r.status, 200, JSON.stringify(bad)); assert.equal(r.body.ok, false); assert.match(String(r.body.reason), /경로/); assert.equal(r.connected, 0);
  }
  // ② 자기 범위만 배정된 중계 서버 — 그 계정이 설정을 바꿀 수 있다: 다른 경로 시험도 예전 그대로
  const own = await testAs(scoped, mine.proxy.id, { haproxyConfigPath: '/etc/haproxy/conf.d/portal_1.cfg' });
  assert.equal(own.body.ok, true, JSON.stringify(own.body));
  assert.equal(own.sent[own.sent.length - 1], 'test -r /etc/haproxy/conf.d/portal_1.cfg && echo OK || echo MISSING');
  // ③ 전체 범위 계정 — 기본 중계 서버에서도 예전 그대로
  const fa = await testAs(full, 'default', { haproxyConfigPath: '/etc/haproxy/conf.d/portal_1.cfg' });
  assert.equal(fa.body.ok, true, JSON.stringify(fa.body));
  assert.equal(fa.sent[fa.sent.length - 1], 'test -r /etc/haproxy/conf.d/portal_1.cfg && echo OK || echo MISSING');
  // ④ 범위 계정이 비밀번호를 직접 넣은 시험(저장 비밀을 쓰지 않는다)은 경로를 묶지 않는다
  const typed = await testAs(scoped, 'default', { host: '127.0.0.1', port, username: 'root', password: 'Stored-Root-Pw', privateKey: '', haproxyConfigPath: '/etc/haproxy/conf.d/portal_2.cfg' });
  assert.equal(typed.body.ok, true, JSON.stringify(typed.body));
  // 157 B5 는 그대로 — 셸 문장은 어느 계정이든 접속 전에 거절
  for (const tok of [scoped, full]) {
    const r = await testAs(tok, 'default', { haproxyConfigPath: '/etc/hosts; id #' });
    assert.equal(r.body.ok, false); assert.equal(r.connected, 0);
  }
});

test('N2 긴급중단을 푼 직후 — 다음 병합 전의 스냅샷은 여전히 얼어 있다: 샘플러가 지금 값으로 적재하지 않고 /metrics 도 내지 않는다(긴급중단 동안도) · 병합 뒤에는 다시 적재한다', () => {
  const r = child(`
    import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
    const { store } = await import(${u('store.js')});
    const S = await import(${u('metrics/sampler.js')});
    const ES = await import(${u('security/emergencyStop.js')});
    const { getMetricsDb } = await import(${u('metrics/db.js')});
    const express = (await import('express')).default;
    const { metricsExportRouter } = await import(${u('routes/metricsExport.js')});
    const app = express(); app.use('/metrics', metricsExportRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const scrape = async () => { const t = await (await fetch('http://127.0.0.1:' + srv.address().port + '/metrics')).text(); return { cpu: (t.match(/^vmware_host_cpu_percent\\{/gm) || []).length, ds: (t.match(/^vmware_datastore_usage_percent\\{/gm) || []).length, up: (t.match(/^vmware_host_up\\{/gm) || []).length }; };
    const stopFile = path.join(process.env.CONFIG_DIR, 'emergency-stop.json');
    const setStop = (o) => { fs.writeFileSync(stopFile, JSON.stringify(o)); ES._resetEmergencyStopForTest(); };
    const out = {};
    await store.refresh();
    const snap0 = store.get();
    const db = await getMetricsDb();
    const host = snap0.hosts.find((h) => h.tempC != null);
    const points = () => db.history('temp_host', host.id, Date.now() - 3_600_000, 0, 1000).length;
    out.vcs = snap0.vcenters.length;
    out.base = await scrape();
    // 긴급중단 동안
    setStop({ active: true, by: ['a', 'b'], at: Date.now() });
    await S._sampleOnceForTest();
    out.stopped = { temp: S.metricsSamplerStatus().lastRun.hostsWithTemp, points: points(), scrape: await scrape() };
    await new Promise((r) => setTimeout(r, 5));
    // 푼 직후 — 병합 전(스냅샷은 그대로)
    setStop({ active: false, by: [], at: Date.now() });
    out.sameSnap = store.get() === snap0;
    await S._sampleOnceForTest();
    const lr = S.metricsSamplerStatus().lastRun;
    out.released = { temp: lr.hostsWithTemp, points: points(), byReason: lr.staleSkipped?.byReason || null, scrape: await scrape() };
    // 이 프로세스가 긴급중단을 본 적이 없어도(재시작 직후 등) 상태 파일의 해제 시각으로 안다
    S._resetStoppedSeenForTest();
    await S._sampleOnceForTest();
    out.releasedByFile = { temp: S.metricsSamplerStatus().lastRun.hostsWithTemp, points: points() };
    // 병합 뒤
    await new Promise((r) => setTimeout(r, 5));
    await store.refresh();
    out.newSnap = store.get() !== snap0;
    await S._sampleOnceForTest();
    const lr2 = S.metricsSamplerStatus().lastRun;
    out.merged = { temp: lr2.hostsWithTemp > 0, points: points(), skipped: lr2.staleSkipped ?? null, scrape: await scrape() };
    // 순수 판정
    const gen = Date.parse(snap0.generatedAt);
    const size = (o) => S.samplingUnreadReasons(snap0, o).size;
    out.pure = { stopped: size({ stopped: true }), frozenAfterGen: size({ stopped: false, frozenBefore: gen + 1 }), frozenAtGen: size({ stopped: false, frozenBefore: gen }), frozenBeforeGen: size({ stopped: false, frozenBefore: gen - 1 }), none: size({ stopped: false, frozenBefore: 0 }),
      noGen: S.samplingUnreadReasons({ ...snap0, generatedAt: undefined }, { stopped: false, frozenBefore: gen + 1 }).size, plain: S.unreadVcenterReasons(snap0).size };
    console.log('RES ' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0', METRICS_ALLOW_ANON: 'true', METRICS_EXPORT_TOKEN: '' });
  assert.ok(r.vcs > 0 && r.base.cpu > 0 && r.base.ds > 0, `목 스냅샷 전제: ${JSON.stringify(r.base)}`);
  // 긴급중단 동안 — 샘플러(158)와 /metrics(이번)가 얼어 있는 값을 내지 않는다. 연결 상태(up)는 그대로 낸다
  assert.deepEqual({ temp: r.stopped.temp, points: r.stopped.points, cpu: r.stopped.scrape.cpu, ds: r.stopped.scrape.ds }, { temp: 0, points: 0, cpu: 0, ds: 0 }, `긴급중단 동안: ${JSON.stringify(r.stopped)}`);
  assert.equal(r.stopped.scrape.up, r.base.up, '호스트 연결 상태 줄은 예전 그대로');
  // 푼 직후(병합 전) — 수정 전: 중단 전 값을 지금 값으로 적재(points 1) · /metrics 도 냈다
  assert.equal(r.sameSnap, true, '전제: 푼 직후의 스냅샷은 중단 전 것 그대로');
  assert.deepEqual({ temp: r.released.temp, points: r.released.points, cpu: r.released.scrape.cpu, ds: r.released.scrape.ds }, { temp: 0, points: 0, cpu: 0, ds: 0 }, `푼 직후: ${JSON.stringify(r.released)}`);
  assert.deepEqual(r.released.byReason, { stopped: r.vcs }, '뺀 사유를 밝힌다(조용한 제외 금지)');
  assert.deepEqual(r.releasedByFile, { temp: 0, points: 0 }, '이 프로세스가 중단을 본 적이 없어도 해제 시각(상태 파일)으로 판정한다');
  // 병합 뒤 — 다시 적재
  assert.equal(r.newSnap, true);
  assert.deepEqual({ temp: r.merged.temp, points: r.merged.points, skipped: r.merged.skipped }, { temp: true, points: 1, skipped: null }, `병합 뒤: ${JSON.stringify(r.merged)}`);
  assert.ok(r.merged.scrape.cpu > 0 && r.merged.scrape.ds > 0, `병합 뒤 /metrics 는 다시 낸다(목 스냅샷은 병합마다 값이 달라 개수는 대조하지 않는다): ${JSON.stringify(r.merged.scrape)}`);
  // 순수 판정 — 만든 시각이 기준 시각 뒤일 때만 지금 값이다 · 기준이 없거나 만든 시각을 모르면 예전 그대로
  assert.deepEqual(r.pure, { stopped: r.vcs, frozenAfterGen: r.vcs, frozenAtGen: r.vcs, frozenBeforeGen: r.pure.plain, none: r.pure.plain, noGen: r.pure.plain, plain: r.pure.plain });
});

test('L1 통신 점검 — 정리 건너뜀을 폴러 상태에 계속 싣는다(정리 틱의 last 에만 있지 않다) · 콘솔에 한 번 · 설정이 확정되면 내린다', () => {
  const r = child(`
    import fs from 'node:fs'; import path from 'node:path';
    const S = await import(${u('linkcheck/settings.js')}); const P = await import(${u('linkcheck/poller.js')});
    const file = path.join(process.env.CONFIG_DIR, 'linkcheck-settings.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, settingsCheck: false, sampleRetentionDays: 365 }));
    S.loadLinkCheckSettings();
    const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
    const out = { before: P.linkCheckPollerStatus().pruneSkipped ?? null };
    fs.writeFileSync(file, '{broken');
    for (let i = 0; i < 12; i += 1) await P.pollOnce({ trigger: 'manual' });
    out.atTick = { top: P.linkCheckPollerStatus().pruneSkipped ?? null, last: P.linkCheckPollerStatus().last?.pruneSkipped ?? null };
    await P.pollOnce({ trigger: 'manual' });   // 정리 틱이 아닌 다음 주기
    out.next = { top: P.linkCheckPollerStatus().pruneSkipped ?? null, last: P.linkCheckPollerStatus().last?.pruneSkipped ?? null };
    for (let i = 0; i < 11; i += 1) await P.pollOnce({ trigger: 'manual' });   // 둘째 정리 틱(24번째)
    out.warned = warns.filter((w) => /linkcheck\\].*보존 정리를 건너뜁니다/.test(w)).length;
    S.saveLinkCheckSettings({});               // 관리자 저장 = 기본값 확정(손상 표지 해제)
    out.confirmed = { err: !!S.linkCheckSettingsLoadError(), top: P.linkCheckPollerStatus().pruneSkipped ?? null };
    console.warn = ow;
    console.log('RES ' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'live', LINKCHECK_ENABLED: 'true' });
  assert.equal(r.before, null);
  assert.deepEqual(r.atTick, { top: 'settings-unreadable', last: 'settings-unreadable' });
  assert.deepEqual(r.next, { top: 'settings-unreadable', last: null }, `다음 주기에도 상태에 남아야 한다(수정 전: 어디에도 없음): ${JSON.stringify(r.next)}`);
  assert.equal(r.warned, 1, '콘솔에는 한 번만 남긴다');
  assert.deepEqual(r.confirmed, { err: false, top: null }, '설정이 확정되면 곧바로 내린다');
});

test('L2 전송 속도 — 정리 건너뜀을 폴러 상태에 싣는다 · 설정이 확정되면 내린다', () => {
  const r = child(`
    import fs from 'node:fs'; import path from 'node:path';
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'xfer-speed-settings.json'), '{broken');
    const S = await import(${u('xferspeed/settings.js')}); const P = await import(${u('xferspeed/poller.js')});
    const now = Date.now(); const ow = console.warn; console.warn = () => {};
    const out = {};
    await P.tickXferSchedule({ now });
    out.first = P.xferSpeedStatus(now).pruneSkipped ?? null;
    await P.tickXferSchedule({ now: now + P.PRUNE_EVERY_MS + 1 });
    out.skipped = P.xferSpeedStatus(now + P.PRUNE_EVERY_MS + 1).pruneSkipped ?? null;
    S.saveXferSpeedSettings({});
    out.confirmed = { err: !!S.xferSettingsLoadError(), top: P.xferSpeedStatus(now + P.PRUNE_EVERY_MS + 2).pruneSkipped ?? null };
    await P.tickXferSchedule({ now: now + P.PRUNE_EVERY_MS + 60_000 });
    await new Promise((r) => setTimeout(r, 200));
    out.afterPrune = P.xferSpeedStatus(now + P.PRUNE_EVERY_MS + 60_001).pruneSkipped ?? null;
    console.warn = ow;
    console.log('RES ' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'live' });
  assert.deepEqual(r, { first: null, skipped: 'settings-unreadable', confirmed: { err: false, top: null }, afterPrune: null }, JSON.stringify(r));
});

test('S1 활성 조닝 별칭 되찾기 — WWN 수가 가장 적은 별칭이 이긴다(묶음 별칭이 끝점 별칭을 덮지 않는다 · 순서에 기대지 않는다) · zone 행의 aliasOf 가 먼저 · 이상한 값은 건너뛴다', async () => {
  const Z = await import('../src/sanswitch/zoning.js');
  const w = (n) => `10:00:00:00:c9:00:00:${String(n).padStart(2, '0')}`;
  const zones = [{ name: 'z1', members: [w(1), w(2), w(3), w(4)] }];
  const want = [`${w(1)}=esx01_hba0`, `${w(2)}=esx02_hba0`, `${w(3)}=array_fa`, `${w(4)}=array_fa`];
  const orders = [
    { all_esx: [w(1), w(2)], esx01_hba0: [w(1)], esx02_hba0: [w(2)], array_fa: [w(3), w(4)] },   // 묶음 별칭이 앞(수정 전: 두 호스트 모두 all_esx)
    { esx01_hba0: [w(1)], all_esx: [w(1), w(2)], esx02_hba0: [w(2)], array_fa: [w(3), w(4)] },   // 수정 전: w2 만 all_esx
    { array_fa: [w(4), w(3)], esx02_hba0: [w(2)], all_esx: [w(2), w(1)], esx01_hba0: [w(1).toUpperCase(), w(1)] },   // 같은 WWN 을 두 번 적은 별칭은 한 개로 센다(목록 길이가 아니라 WWN 수)
  ];
  for (const aliases of orders) {
    const got = Z.zonesFromCompact({ available: true, zones, aliases })[0].members.map((m) => `${m.wwn}=${m.alias}`);
    assert.deepEqual(got, want, JSON.stringify(aliases));
  }
  // WWN 수가 같으면 먼저 나온 이름(매번 같은 답)
  assert.equal(Z.aliasByWwn({ b_name: [w(1)], a_name: [w(1)] }).get(w(1)), 'b_name');
  // zone 행이 가진 aliasOf(그 zone 이 실제로 쓴 이름)가 먼저
  assert.equal(Z.zonesFromCompact({ zones: [{ name: 'z', members: [w(1)], aliasOf: { [w(1)]: 'used' } }], aliases: { other: [w(1)] } })[0].members[0].alias, 'used');
  // 엣지에서 온 이상한 꼴 — 던지지 않고 건너뛴다 · 전역 원형을 건드리지 않는다
  for (const bad of [null, 5, 'x', [['a']], { a: 'not-array' }, { a: [null, 5, {}, ['x'], 'zz'] }]) assert.equal(Z.aliasByWwn(bad).size, 0, JSON.stringify(bad));
  const odd = Z.aliasByWwn(JSON.parse(`{"__proto__":["${w(1)}"],"constructor":["${w(2)}"]}`));
  assert.equal(odd.get(w(1)), '__proto__'); assert.equal(odd.get(w(2)), 'constructor'); assert.equal(({}).x, undefined);
  // 별칭 1만 개(상한 8,000 위) — 요청 경로에서 부담이 되지 않는다(선형)
  const big = {}; for (let i = 0; i < 10_000; i += 1) big[`alias_${i}`] = [`10:00:00:00:${(i >> 16 & 255).toString(16).padStart(2, '0')}:${(i >> 8 & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:01`, `20:00:00:00:${(i >> 16 & 255).toString(16).padStart(2, '0')}:${(i >> 8 & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:01`];
  const t0 = Date.now(); const m = Z.aliasByWwn(big); const ms = Date.now() - t0;
  assert.equal(m.size, 20_000); assert.ok(ms < 1500, `별칭 1만 개에 ${ms}ms`);
});

test('N3 요청 값으로 여는 고정 표(158 N158-3 의 남은 같은 꼴 3파일) — 상속 키는 모르는 값과 같은 답(기본값)', async () => {
  const NL = await import('../src/storage/nodeLoad.js');
  const MC = await import('../src/bmusage/multiCompare.js');
  const RT = await import('../src/idrac/roomTempSeries.js');
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 기준 시각 — 정시 경계(docs/rules/common.md)
  const fakeDb = () => { const calls = []; return { calls, db: new Proxy({}, { get: (_t, p) => (...a) => { calls.push([String(p), a.filter((x) => typeof x !== 'object').map(String).join(',')]); return p === 'history' || p === 'historyStep' ? [] : { firstTs: null, lastTs: null }; } }) }; };
  const base = {
    nodeLoad: JSON.stringify(NL.nodeLoadWindow({ range: 'zz', now: NOW })),
    cmpWin: JSON.stringify(MC.compareWindow({ range: 'zz', now: NOW })),
    cmpGroup: JSON.stringify(MC.parseCompareMetrics('', { group: 'zz' })),
  };
  const rtBase = await RT.roomTempHistory(fakeDb().db, { range: 'zz' });
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const w = NL.nodeLoadWindow({ range: k, now: NOW });
    assert.equal(JSON.stringify(w), base.nodeLoad, `nodeLoadWindow ${k}`);
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.spanMs), `nodeLoadWindow ${k}: 창이 수가 아니다(수정 전: spanMs 없음 · start null)`);
    assert.equal(JSON.stringify(MC.compareWindow({ range: k, now: NOW })), base.cmpWin, `compareWindow ${k}`);
    assert.equal(JSON.stringify(MC.parseCompareMetrics('', { group: k })), base.cmpGroup, `parseCompareMetrics ${k}(수정 전: fromGroup is not iterable — 500)`);
    const f = fakeDb();
    const r = await RT.roomTempHistory(f.db, { range: k });
    assert.equal(r.range, rtBase.range, `roomTempHistory ${k}`); assert.equal(r.bucketMs, rtBase.bucketMs);
    assert.ok(f.calls.length > 0 && f.calls.every(([, a]) => !/NaN|undefined/.test(a)), `roomTempHistory ${k}: DB 조회 인자에 NaN · undefined(${JSON.stringify(f.calls[0])})`);
  }
  // 대조군 — 정상 값은 그대로
  assert.equal(NL.nodeLoadWindow({ range: '7d', now: NOW }).range, '7d');
  assert.equal(MC.compareWindow({ range: '1h', now: NOW }).from, NOW - 3_600_000);
  assert.deepEqual(MC.parseCompareMetrics('', { group: 'util6' }), [...MC.COMPARE_GROUPS.util6]);
  assert.equal((await RT.roomTempHistory(fakeDb().db, { range: '30d' })).range, '30d');
});

test('A1 에이전트 이름 — Object.prototype 의 이름(원문 · 소문자로 바꾼 값)은 개별 토큰을 발급하지 않는다(160 I1 의 뿌리) · 다른 이름은 그대로', async () => {
  const T = await import('../src/central/agentTokens.js');
  for (const bad of ['__proto__', '__PROTO__', '__Proto__', 'constructor', 'Constructor', 'CONSTRUCTOR', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
    assert.equal(T.reservedAgentName(bad), true, bad);
    const r = T.issueAgentToken(bad);
    assert.equal(r.ok, false, `${bad}: 발급됐다`); assert.equal(r.token, undefined);
    assert.match(String(r.reason), /쓸 수 없습니다/); assert.doesNotMatch(String(r.reason), /`/);
  }
  assert.equal(T.listAgentTokens().length, 0, '거절한 이름은 목록에 없다');
  for (const ok of ['edge-kr-01', 'EDGE.PL_02', 'proto', 'tostring2', 'x']) {
    assert.equal(T.reservedAgentName(ok), false, ok);
    const r = T.issueAgentToken(ok);
    assert.equal(r.ok, true, `${ok}: ${JSON.stringify(r)}`);
    assert.equal(T.resolveAgentByToken(r.token), ok);
  }
});

test('X 값 전용 엑셀 로더(159) — exceljs 의 parseWorkbook 이 없어지거나 함수가 아니면 읽지 않는다(조용히 이름 정의를 전개하지 않는다) · 동시 로드가 서로 섞이지 않고 다른 Workbook 의 로더를 바꾸지 않는다', () => {
  const pkg = JSON.stringify(path.resolve(HERE, '../package.json'));
  const r = child(`
    import { createRequire } from 'node:module';
    const require = createRequire(${pkg});
    const ExcelJS = require('exceljs');
    const F = await import(${u('svcmon/formats.js')});
    const mk = async (rows, name) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s'); for (const x of rows) ws.addRow(x); if (name) wb.definedNames.add('s!$A$1:$B$2', name); return Buffer.from(await wb.xlsx.writeBuffer()); };
    const a = await mk([['a', 1], ['b', 2]], 'nmA'); const b = await mk([['x', new Date(Date.UTC(2026, 10, 20))], ['y', { formula: 'A1', result: 'x' }]], 'nmB'); const c = await mk([['only']]);
    const dump = (wb) => JSON.stringify(wb.worksheets[0].getSheetValues());
    const solo = [dump(await F.loadXlsxValues(a)), dump(await F.loadXlsxValues(b)), dump(await F.loadXlsxValues(c))];
    const many = await Promise.all([a, b, c, a, b, c, a, b, c].map((x) => F.loadXlsxValues(x)));
    const out = {};
    out.mixed = many.filter((wb, i) => dump(wb) !== solo[i % 3]).length;
    out.namesLeft = many.filter((wb) => (wb.definedNames.model || []).length > 0).length;
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx);
    const plain = new ExcelJS.Workbook(); await plain.xlsx.load(a);
    out.protoUntouched = proto.parseWorkbook?.name === 'parseWorkbook' && plain.definedNames.model.length === 1;
    const orig = proto.parseWorkbook;
    delete proto.parseWorkbook;
    try { await F.loadXlsxValues(a); out.deleted = 'LOADED'; } catch (e) { out.deleted = /parseWorkbook/.test(e.message) ? 'REFUSED' : 'OTHER ' + e.message; }
    proto.parseWorkbook = 'x';
    try { await F.loadXlsxValues(a); out.notFn = 'LOADED'; } catch (e) { out.notFn = /parseWorkbook/.test(e.message) ? 'REFUSED' : 'OTHER ' + e.message; }
    proto.parseWorkbook = orig;
    out.again = dump(await F.loadXlsxValues(a)) === solo[0];
    console.log('RES ' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'live' }, { timeout: 60_000 });
  assert.deepEqual(r, { mixed: 0, namesLeft: 0, protoUntouched: true, deleted: 'REFUSED', notFn: 'REFUSED', again: true }, JSON.stringify(r));
});
