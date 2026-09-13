/**
 * 보안 감사 2026-09-13(v2.500) 확정 지적 회귀 테스트.
 *
 * 8도메인 병렬 감사에서 확정된 항목만 고정한다. 각 테스트는 '무엇이 뚫렸었는가'를 주석으로 남겨,
 * 나중에 이 단정을 느슨하게 바꾸려는 사람이 대가를 알 수 있게 한다.
 *
 * 경로 정규화 우회(C-1)는 실제 Express 라우터로 재현한다 — 문자열 비교만으로는 잡히지 않고,
 * 기존 테스트(securityH1RegisterCollector)가 정확 경로만 검사해 통과시켰던 결함이다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-audit0913-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-0913-test-1234567890';

let server; let base; let tokA;

before(async () => {
  const tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
  tokA = tokens.issueAgentToken('edgeA').token;
});
after(() => { try { server?.close(); } catch { /* */ } });

const post = (p, token, body) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) },
  body: JSON.stringify(body),
});

/* ── C-1(critical): register-collector 바인딩의 경로 정규화 우회 ───────────────────────────── */

test('C-1: 경로 변형(후행 슬래시·대소문자·/.)으로 agent 바인딩을 건너뛸 수 없다', async () => {
  // 무엇이 뚫렸었나: 미들웨어가 `req.path === '/register-collector'` 정확 일치로만 body.name 을
  // 대조했다. Express 기본값(strict routing=false, case sensitive=false)에서는 아래 변형도
  // **핸들러에 도달**하지만 그 비교가 거짓이 되어 대조가 0건이 됐다(실측: 3변형 모두 200 등록).
  // 침해된 엣지 하나가 남의 수집 서버 URL·토큰을 덮어쓰고, 중앙이 그 주소로 iDRAC 계정·엣지
  // 비밀번호·번들을 실어 보내는 유출 피벗이었다.
  for (const p of ['/register-collector/', '/Register-Collector', '/register-collector/.']) {
    const res = await post(p, tokA, { name: 'edgeB', urlHint: 'http://10.9.9.9:4000', collectorToken: 'ATTACKER' });
    assert.equal(res.status, 403, `${p} 에서 타 엣지 이름 등록이 막히지 않았다(status=${res.status})`);
    const j = await res.json();
    assert.match(j.reason || '', /edgeA/, `${p} 응답에 바인딩 사유가 없다`);
  }
});

test('C-1: 정확 경로의 자기등록은 여전히 바인딩으로 막히지 않는다(무회귀)', async () => {
  const res = await post('/register-collector', tokA, { name: 'edgeA', urlHint: 'http://10.20.30.40:4000', collectorToken: 'own' });
  assert.notEqual(res.status, 403, '정상 자기등록이 막히면 기능이 죽는다');
});

/* ── 공용 규칙: 접속 대상이 바뀌면 저장 비밀을 승계하지 않는다 ───────────────────────────── */

test('secretCarry: accessMoved 는 부분 저장에서 기존 값을 유지로 본다', async () => {
  const { accessMoved, secretProvided, dropCarriedSecrets } = await import('../src/util/secretCarry.js');
  const prev = { host: 'edge1.corp', port: 22, username: 'root' };
  assert.equal(accessMoved(prev, { name: '이름만 변경' }, ['host', 'port', 'username']), false);
  assert.equal(accessMoved(prev, { host: 'EDGE1.CORP  ' }, ['host']), false, '대소문자·공백 차이는 이동이 아니다');
  assert.equal(accessMoved(prev, { host: 'attacker.corp' }, ['host']), true);
  assert.equal(accessMoved(prev, { port: 2222 }, ['host', 'port', 'username']), true);
  assert.equal(accessMoved(null, { host: 'x' }, ['host']), false, '신규 항목은 이동이 아니다');

  assert.equal(secretProvided(''), false);
  assert.equal(secretProvided('********'), false);
  assert.equal(secretProvided(undefined), false);
  assert.equal(secretProvided('new-pw'), true);

  const t = { password: 'old', privateKey: 'oldkey', host: 'attacker' };
  const dropped = dropCarriedSecrets(t, { password: 'given' }, ['password', 'privateKey']);
  assert.deepEqual(dropped, ['privateKey'], '요청이 새로 준 비밀은 남기고 승계분만 버린다');
  assert.equal(t.password, 'old');
  assert.equal('privateKey' in t, false, '버릴 때는 키 자체를 없애야 한다(빈 문자열은 다음 저장에서 되살아날 수 있다)');
});

test('H1: 배포 대상의 host 를 바꾸면 저장된 SSH 비밀·중앙/수집 토큰이 승계되지 않는다', async () => {
  // 무엇이 뚫렸었나: `{id:<기존>, host:'attacker', password:''}` 저장 → 상태확인/배포만 부르면
  // 저장된 root 비밀번호가 공격자 sshd 로 전송되고 CENTRAL_TOKEN·COLLECTOR_TOKEN 이 그 호스트의
  // portal.env 에 기록됐다. relaytopo·uagmon 에만 있던 규칙이 이 스토어에 없었다.
  const reg = await import('../src/agent/deployRegistry.js');
  const created = reg.saveTarget({
    host: 'edge-real.corp', port: 22, username: 'root', password: 'real-pw',
    privateKey: 'PEM', centralToken: 'CT', collectorToken: 'COL', agentName: 'edgeReal',
  });
  const id = created.target.id;
  assert.equal(created.target.hasPassword, true);

  // 이름만 바꾸는 정상 편집: 비밀 유지
  const renamed = reg.saveTarget({ id, host: 'edge-real.corp', agentName: 'edgeReal2', password: '' });
  assert.equal(renamed.target.hasPassword, true, '접속처가 같으면 기존 비밀을 유지해야 한다(편집 UX)');
  assert.deepEqual(renamed.droppedSecrets, []);

  // host 만 바꿔치기: 비밀 전부 폐기
  const moved = reg.saveTarget({ id, host: 'attacker.corp', password: '' });
  assert.equal(moved.target.hasPassword, false);
  assert.equal(moved.target.hasPrivateKey, false);
  assert.equal(moved.target.hasCentralToken, false);
  assert.equal(moved.target.hasCollectorToken, false);
  assert.deepEqual(moved.droppedSecrets.sort(), ['centralToken', 'collectorToken', 'password', 'privateKey']);
  reg.removeTarget(id);
});

test('H2: 프록시 Data Plane URL·SSH host 를 바꾸면 저장 비밀이 승계되지 않는다', async () => {
  // 무엇이 뚫렸었나: v2.488(H-2)은 `/remote/test`·`/deploy/test` 만 고쳤다. 저장 라우트로
  // `{dataplane:{url:'http://attacker:5555', password:'********'}}` 를 넣은 뒤 `/proxies/:id/health`
  // 를 부르면 저장된 Data Plane 비밀번호가 Basic 으로 공격자 URL 에 전송됐다.
  const reg = await import('../src/proxy/registry.js');
  reg.saveConfig({ dataplane: { url: 'http://proxy.corp:5555', username: 'admin', password: 'dp-pw' } });
  let c = reg.getConfigSafe();
  assert.equal(c.dataplane.password, '********', '저장 확인');

  reg.saveConfig({ dataplane: { url: 'http://proxy.corp:5555', username: 'admin2', password: '********' } });
  c = reg.getConfigSafe();
  assert.equal(c.dataplane.password, '********', 'URL 이 같으면 비밀 유지(편집 UX)');

  reg.saveConfig({ dataplane: { url: 'http://attacker:5555', password: '********' } });
  c = reg.getConfigSafe();
  assert.equal(c.dataplane.password, '', 'URL 이 바뀌면 저장 비밀을 버려야 한다');

  reg.saveConfig({ deploy: { host: 'proxy.corp', port: 22, username: 'root', password: 'ssh-pw', privateKey: 'PEM' } });
  reg.saveConfig({ deploy: { host: 'attacker.corp', password: '********', privateKey: '********' } });
  c = reg.getConfigSafe();
  assert.equal(c.deploy.password, '');
  assert.equal(c.deploy.privateKey, '');
});

test('M1: 네트워크 모니터의 캡처 호스트를 바꾸면 저장 SSH 비밀이 승계되지 않는다', async () => {
  // 무엇이 뚫렸었나: merge() 가 host 는 요청값, 비밀은 기존값 폴백이었다. host 만 공격자 주소로
  // 바꿔 저장하고 `POST /net/monitors/:id/run` 을 부르면 저장된 캡처 호스트 SSH 비밀번호·개인키가
  // 그 주소로 전송되고, 60초 스케줄러가 계속 재시도한다.
  // 목록 API 는 비밀을 가리므로(redact) **저장 파일을 직접 읽어** 확인한다.
  const mon = await import('../src/net/monitor.js');
  const file = path.join(CFG, 'capture-monitors.json');
  const readRaw = (id) => {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j) ? j : (j.monitors || []);
    return list.find((m) => m.id === id) || null;
  };
  const saved = mon.saveMonitor({ name: 'cap', hostA: { host: '10.1.1.1', username: 'root', password: 'pw', privateKey: 'PEM' } });
  const id = saved.id;
  assert.equal(readRaw(id).hostA.password, 'pw', '저장 확인');

  mon.saveMonitor({ id, name: 'cap2', hostA: { host: '10.1.1.1' } });
  assert.equal(readRaw(id).hostA.password, 'pw', '같은 호스트면 유지(편집 UX)');

  mon.saveMonitor({ id, hostA: { host: '10.9.9.9' } });
  const moved = readRaw(id);
  assert.equal(moved.hostA.password, undefined, 'host 가 바뀌면 비밀번호를 버려야 한다');
  assert.equal(moved.hostA.privateKey, undefined, 'host 가 바뀌면 개인키도 버려야 한다');
  mon.removeMonitor(id);
});

/* ── B/M-1: 알람 음소거는 상태변경이다 ───────────────────────────────────────────────────── */

test('B/M-1: 범위 제한 계정은 전 vCenter 음소거를 만들 수 없다', async () => {
  // 무엇이 뚫렸었나: 게이트가 `requirePerm('inv.alarms')` 뿐이었고 그 권한은 **viewer 기본**이다.
  // requirePerm 은 역할을 보지 않으므로 viewer 토큰으로 `{scope:'all'}` 음소거를 만들 수 있었다
  // (전 사이트 장애 은폐). 라우트에는 requireRole('admin','operator') 를 추가했고, 여기서는
  // 범위 판정(순수)을 고정한다.
  const { muteCreateIssue, muteDeleteIssue, visibleMutes } = await import('../src/alarm-mutes.js');
  const allowed = new Set(['vc-kr']);

  assert.equal(muteCreateIssue({ scope: 'all' }, null), null, '전체 범위 계정은 기존대로 전 vCenter 음소거 가능');
  assert.match(muteCreateIssue({ scope: 'all' }, allowed) || '', /전체 범위/);
  assert.match(muteCreateIssue({ scope: 'vcenter', vcenterId: 'vc-us' }, allowed) || '', /범위 밖/);
  assert.equal(muteCreateIssue({ scope: 'vcenter', vcenterId: 'vc-kr' }, allowed), null);

  assert.equal(muteDeleteIssue({ vcenterId: '' }, null), null);
  assert.match(muteDeleteIssue({ vcenterId: '' }, allowed) || '', /전체 범위/);
  assert.equal(muteDeleteIssue({ vcenterId: 'vc-kr' }, allowed), null);

  const mutes = [{ id: 'a', vcenterId: '' }, { id: 'b', vcenterId: 'vc-kr' }, { id: 'c', vcenterId: 'vc-us' }];
  assert.deepEqual(visibleMutes(mutes, allowed).map((m) => m.id), ['a', 'b'],
    '전 vCenter 규칙은 그 사용자 화면에도 실제로 적용되므로 숨기지 않는다');
  assert.equal(visibleMutes(mutes, null).length, 3);
});

/* ── D/M1: HAProxy 경로 점검 응답의 역할별 축약 ─────────────────────────────────────────── */

test('D/M1: 비-admin 응답에 중계 엣지 host·port 가 어떤 경로로도 남지 않는다', async () => {
  // 무엇이 뚫렸었나: v2.478 이 targets[].host/port 만 가렸는데 라우트가 relayCheckStatus() 를
  // `...st` 로 펼쳐 settings.hosts 와 results[].target.host/port 가 그대로 나갔고, key 가
  // "host:port" 라 가린 값을 복원할 수 있었다. operator 는 tools 권한을 기본 보유한다.
  const { relayCheckView, opaqueKey } = await import('../src/relaycheck/view.js');
  const st = {
    last: { at: 1, total: 2, ok: 1, fail: 1 },
    busy: false,
    settings: { enabled: true, intervalMs: 60_000, hosts: [['10.1.2.3', '한국'], ['10.9.8.7', '폴란드']], profile: [{ port: 4000, kind: 'edge-portal' }] },
    results: [{
      state: 'fail', fails: 3, ok: false, phase: 'connect', ms: 20, at: 5,
      target: { key: '10.9.8.7:4067', host: '10.9.8.7', port: 4067, kind: 'irs-portal', label: 'IRS', site: '폴란드', collectorId: 'edgePL' },
      error: 'connect ECONNREFUSED 10.9.8.7:4067',
      remedy: { title: 'IRS 포워딩 확인', cause: '10.9.8.7:4067 에 연결되지 않습니다', steps: ['ssh 10.9.8.7'] },
    }],
    kinds: {},
  };
  const targets = [{ key: '10.1.2.3:4000', host: '10.1.2.3', port: 4000, kind: 'edge-portal', label: 'Edge', site: '한국' }];

  const view = relayCheckView(st, targets, false);
  const json = JSON.stringify(view);
  for (const leak of ['10.1.2.3', '10.9.8.7', '4067']) {
    assert.equal(json.includes(leak), false, `비-admin 응답에 ${leak} 가 남아 있다`);
  }
  assert.equal(view.redacted, true, '가린 사실을 밝혀야 한다(화면이 이유를 설명할 수 있게)');
  assert.equal(view.settings.hostCount, 2, '개수는 알려준다');
  assert.equal(view.settings.hosts, undefined);
  assert.equal(view.results[0].state, 'fail', '상태 판정은 남는다(무엇이 문제인지는 알아야 한다)');
  assert.equal(view.targets[0].key, opaqueKey('10.1.2.3:4000'), '상관키는 해시로 유지');
  assert.notEqual(view.targets[0].key, '10.1.2.3:4000');

  const adminView = relayCheckView(st, targets, true);
  assert.equal(adminView.redacted, false);
  assert.equal(adminView.settings.hosts.length, 2, 'admin 은 기존대로 전량');
  assert.equal(adminView.results[0].target.host, '10.9.8.7');
});

/* ── H/L-1: zipMany 경로 탈출 ───────────────────────────────────────────────────────────── */

test('H/L-1: zipMany 는 상위 경로·드라이브 문자 항목을 거부한다', async () => {
  const { zipMany, zipSingle } = await import('../src/util/zip.js');
  assert.throws(() => zipMany([{ name: '../evil.html', data: 'x' }]), /상위 경로/);
  assert.throws(() => zipMany([{ name: 'a/../../evil', data: 'x' }]), /상위 경로/);
  assert.throws(() => zipMany([{ name: 'C:/evil', data: 'x' }]), /드라이브 문자/);
  // 정상 항목·기존 형식은 그대로 동작해야 한다.
  assert.ok(zipMany([{ name: 'reports/a-1234abcd.html', data: '<p>ok</p>' }]).length > 0);
  assert.ok(zipSingle('a.txt', 'hello').length > 0);
  // '..' 를 포함하지만 세그먼트가 아닌 이름은 허용한다(VM 이름에 점이 흔하다).
  assert.ok(zipMany([{ name: 'reports/vm..name-1234abcd.html', data: 'x' }]).length > 0);
});

/* ── H/M-1: hang 로그 보존일은 조회에서도 적용된다 ──────────────────────────────────────── */

test('H/M-1: 보존일이 지난 hang 기록은 조회 결과에서 빠지고, 가린 건수를 밝힌다', async () => {
  const HL = await import('../src/perf/hangLog.js');
  HL.clearHangs();
  HL.setHangRetentionProvider(() => 14);
  const now = Date.now();
  const old = now - 40 * 86_400_000;
  fs.writeFileSync(HL.hangLogFile(), [
    JSON.stringify({ kind: 'loop', at: old, maxMs: 900, user: 'kim', ip: '10.0.0.1' }),
    JSON.stringify({ kind: 'loop', at: now, maxMs: 1200 }),
    JSON.stringify({ kind: 'loop', maxMs: 50 }),            // at 없음 — 나이를 모르므로 남긴다
    '',
  ].join('\n'));
  const r = HL.readHangs({ limit: 50 });
  assert.equal(r.rows.length, 2, '보존일 밖 1건이 빠져야 한다');
  assert.equal(r.staleHidden, 1);
  assert.equal(r.retentionDays, 14);
  assert.equal(JSON.stringify(r.rows).includes('kim'), false, '사용자명이 보존일을 넘겨 남으면 안 된다');
  // 보존일 0(미설정)이면 기존 동작(전량)
  HL.setHangRetentionProvider(() => 0);
  assert.equal(HL.readHangs({ limit: 50 }).rows.length, 3);
  HL.clearHangs();
});

/* ── A/M-1: 사용자명 로테이션으로 잠금을 피할 수 없다 ──────────────────────────────────── */

test('A/M-1: 한 출발지에서 사용자명을 바꿔가며 실패하면 결국 그 출발지가 잠긴다', async () => {
  // 무엇이 뚫렸었나: 잠금 키가 `<ip>|<user>` 와 `acct:<user>` 뿐이라 사용자명을 매번 바꾸면
  // 어느 카운터도 차지 않았다. 로그인은 요청마다 동기 scrypt(실측 ~48ms)를 태우므로 단일
  // 출발지로 이벤트 루프를 포화시킬 수 있었고, 사용자명 사전 열거도 제한 없이 가능했다.
  const rl = await import('../src/security/loginRateLimit.js');
  const ip = '203.0.113.77';
  let blockedAt = 0;
  for (let i = 1; i <= 60; i++) {
    if (rl.checkLoginAllowed(ip, `user${i}`).blocked) { blockedAt = i; break; }
    rl.recordLoginFailure(ip, `user${i}`);
  }
  assert.ok(blockedAt > 0, '사용자명을 바꿔가며 시도하면 어느 시점에는 막혀야 한다');
  assert.ok(blockedAt <= 60, `너무 늦게 막힌다(${blockedAt}회)`);
  // 다른 출발지는 영향 없음(한 IP 의 실패가 전 사용자를 잠그지 않는다).
  assert.equal(rl.checkLoginAllowed('198.51.100.9', 'user1').blocked, false);
});

/* ── C/M4·H/M-2: 비밀·런타임 파일은 .gitignore 로 차단된다 ────────────────────────────── */

test('C/M4: SECRET_FILES 전부가 .gitignore 에 있다(등록만 하고 차단을 잊는 사고 방지)', async () => {
  const { SECRET_FILES } = await import('../src/security/secretVault.js');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const missing = SECRET_FILES.filter((f) => !ignore.includes(`server/config/${f}`));
  assert.deepEqual(missing, [], `.gitignore 에 없는 비밀 파일: ${missing.join(', ')}`);
});

test('H/M-2: v2.49x 런타임 파일(성능·미지원 서버)도 차단 목록에 있다', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const f of ['perf-hangs.ndjson', 'perf-monitor.json', 'central-unsupported-servers.json']) {
    assert.ok(ignore.includes(`server/config/${f}`) || ignore.includes('server/config/*.ndjson'),
      `${f} 가 .gitignore 에 없다 — 사용자명·IP·BMC 주소가 커밋될 수 있다`);
  }
});

/* ── H/L-5: 엣지가 보고한 문자열은 모두 절단된다 ───────────────────────────────────────── */

test('H/L-5: 미지원 서버 보고의 vendor·vendorLabel 도 길이 상한을 받는다', async () => {
  // 형제 필드(evidence·product·model·manufacturer)는 모두 절단되는데 이 둘만 무제한이었다 —
  // 침해된 엣지가 긴 문자열로 중앙 파일을 부풀릴 수 있었다.
  const mod = await import('../src/central/unsupportedServers.js');
  mod._resetUnsupportedForTest();
  const long = 'v'.repeat(500);
  mod.saveUnsupportedServers({ agent: 'edgeA', datacenterId: 'dcA', service: 'idrac' },
    [{ ip: '10.1.1.9', vendor: long, vendorLabel: long }]);
  const found = mod.listUnsupportedServers({}).rows.filter((r) => r.ip === '10.1.1.9');
  assert.ok(found.length > 0, '저장한 항목을 다시 읽지 못했다 — 테스트 전제가 깨졌다');
  for (const r of found) {
    assert.ok(String(r.vendor || '').length <= 60, `vendor 가 절단되지 않았다(${String(r.vendor || '').length}자)`);
    assert.ok(String(r.vendorLabel || '').length <= 60);
  }
});

/* ── 보안 자가진단(신규 기능)의 판정은 사실만 말한다 ───────────────────────────────────── */

test('자가진단: 확인하지 못한 것은 unknown 이고, 점수를 만들지 않는다', async () => {
  const sc = await import('../src/security/selfCheck.js');
  assert.equal(sc.fileModeStatus(null).status, 'unknown', '못 읽은 파일을 ok/risk 로 단정하지 않는다');
  assert.equal(sc.fileModeStatus(0o100600).status, 'ok');
  assert.equal(sc.fileModeStatus(0o100640).status, 'risk', '그룹 읽기 가능은 실질 유출');
  assert.equal(sc.fileModeStatus(0o100604).status, 'risk');
  assert.equal(sc.permText(0o600), '0600');
  assert.equal(sc.permText(null), '—');

  assert.equal(sc.loginPolicyStatus(null), 'ok', '기본(레거시)은 엄격한 쪽이다');
  assert.equal(sc.loginPolicyStatus('otp_only'), 'ok');
  assert.equal(sc.loginPolicyStatus('otp_or_password'), 'warn');
  assert.equal(sc.loginPolicyStatus('password_only'), 'risk');
  assert.equal(sc.loginPolicyStatus('무엇인가'), 'unknown');

  assert.equal(sc.secretsModeStatus('encrypted'), 'ok');
  assert.equal(sc.secretsModeStatus('plain'), 'warn', '기본값이므로 위험이 아니라 보호 미적용');

  assert.equal(sc.otpCoverageStatus({ privileged: 0, enrolled: 0 }), 'unknown');
  assert.equal(sc.otpCoverageStatus({ privileged: 3, enrolled: 0 }), 'risk');
  assert.equal(sc.otpCoverageStatus({ privileged: 3, enrolled: 2 }), 'warn');
  assert.equal(sc.otpCoverageStatus({ privileged: 3, enrolled: 3 }), 'ok');

  assert.equal(sc.worstStatus(['ok', 'unknown', 'warn']), 'warn');
  assert.equal(sc.worstStatus(['ok', 'risk', 'warn']), 'risk');
  assert.equal(sc.worstStatus(['ok', 'unknown']), 'unknown');
  assert.deepEqual(sc.summarize([{ status: 'ok' }, { status: 'risk' }, { status: 'risk' }]),
    { ok: 1, warn: 0, risk: 2, unknown: 0, total: 3 });

  // 완화 스위치 목록에서 항목을 빼면 '켜 둔 줄 몰랐다'가 반복된다 — 최소 구성을 고정한다.
  const names = sc.RELAX_SWITCHES.map((x) => x.env);
  for (const must of ['AUTH_ENABLED', 'WAN_TLS_INSECURE', 'UPGRADE_ALLOW_UNVERIFIED', 'OTP_ROLE_ENFORCE', 'RMA_ALLOW_CUSTOM']) {
    assert.ok(names.includes(must), `${must} 가 완화 스위치 목록에 없다`);
  }
});

test('자가진단: 실제 조회가 사실만 담고 비밀을 싣지 않는다', async () => {
  const sc = await import('../src/security/selfCheck.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), '{}', { mode: 0o644 });   // 일부러 잘못된 권한
  fs.writeFileSync(path.join(dir, 'initial-admin-password.txt'), 'secret-pw');
  fs.writeFileSync(path.join(dir, 'users.json.corrupt.123'), 'x');
  const { checks, summary } = sc.collectSelfCheck({
    users: [{ username: 'a', role: 'admin', totpEnabled: false }, { username: 'b', role: 'operator', totpEnabled: true }],
    env: { WAN_TLS_INSECURE: 'true' },
    dir,
  });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by['secret-file-modes'].status, 'risk', '0644 비밀 파일은 risk');
  assert.match(by['secret-file-modes'].howto, /chmod 600/);
  assert.equal(by['initial-admin-password'].status, 'risk');
  assert.equal(by['corrupt-files'].status, 'warn');
  assert.equal(by['otp-coverage'].status, 'warn', 'admin 1개 미등록 · operator 1개 등록 → warn');
  assert.equal(by['relax-switches'].status, 'risk');
  assert.match(by['relax-switches'].detail, /WAN_TLS_INSECURE/);
  assert.equal(summary.total, checks.length);
  // 비밀 값이 응답에 실리지 않는다(파일 내용을 읽지 않는다).
  assert.equal(JSON.stringify(checks).includes('secret-pw'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
