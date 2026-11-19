/**
 * v3.30 서버 명령 실행(프리셋) — 설계 docs/design/server-cmd(② 프리셋 · ① 값이 들어가는 길 여섯 겹 · D6 출력 보관 · D7 권한 · D8 직접 켠 계정 · 키만).
 * 프리셋 목록 전체 쓸기(읽기 전용 · sudo · 인자 노출 · 탐침 없음 · timeout · cmd 한도 · 시한 산수) · 값 검사(주입 시도) · 출력 다듬기(선형) ·
 * 허용 기능 판정(직접 켠 것만) · 실제 등록부 · 실제 keyStore · 가짜 sshd(보낸 명령 · 시도 수를 센다) · 실제 라우터(권한 · 감사 · 출력은 응답 · 감사에 따로).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'srvcmd330-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const P = await import('../src/servercmd/presets.js');
const SVC = await import('../src/servercmd/service.js');
const PL = await import('../src/bmusage/onboard/placement.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const RS = await import('../src/sshaccess/readServer.js');
const SA = await import('../src/sshaccess/service.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };

/* ── 가짜 sshd — 비밀번호 로그인 · 명령마다 정한 출력 · 보낸 명령 · 시도 수 ── */
async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { passwords: {}, seen: [], cmds: [], hang: false };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') { st.seen.push(ctx.password); if (st.passwords[ctx.username] === ctx.password) return ctx.accept(); }
      return ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        st.cmds.push(info.command); const stream = acc();
        if (st.hang) { stream.write('partial line\n'); return; }   // 끝내지 않는다
        if (info.command.includes('pgrep')) { stream.exit(1); stream.end(); return; }   // 찾지 못함 — 끝 코드 1 · 출력 없음
        if (info.command.includes('systemctl show')) { stream.write('Id=chronyd.service\r\n\x1b[31mActiveState=active\x1b[0m\r\nSubState=running\x07\n'); stream.stderr.write('warn: x\n'); stream.exit(0); stream.end(); return; }
        stream.write('ok\n'); stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());
const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const addrOf = (s) => `${String(s.host).toLowerCase()}:${Number(s.port) || 22}|${String(s.username || 'root').toLowerCase()}`;
/** 값 종류마다 가장 긴 값(시한 · 명령 길이 산수의 최악). */
const longest = (p) => Object.fromEntries(p.params.map((d) => [d.name, d.kind === 'path' ? `/${'a'.repeat(P.PARAM_KINDS.path.max - 1)}` : `a${'b'.repeat(P.PARAM_KINDS.name.max - 1)}`]));

// ⚠ 시험은 모듈 맨 위의 await(가짜 sshd)가 다 끝난 뒤에 등록한다(serverInfo325 반증 F17 — 먼저 끝난 시험이 설정 폴더를 지우지 않게).
test('① 프리셋 목록 전체 — 읽기 전용 · sudo 없음 · 인자 · 환경 · 파일 내용 · 탐침 없음 · 문장마다 timeout · 시한 산수 · cmd 한도', () => {
  assert.equal(P.PRESETS.length, 22);
  assert.equal(P.PRESETS.filter((p) => p.windows).length, 16);
  assert.equal(new Set(P.PRESETS.map((p) => p.id)).size, P.PRESETS.length, 'id 겹침 없음');
  for (const p of P.PRESETS) assert.ok(P.GROUPS.includes(p.group), p.id);
  // 프로그램은 허용 목록만(문장의 첫 프로그램) — 재부팅 · 종료 · 지우기 같은 것은 목록에 없다(‘last -x reboot’ 의 reboot 는 읽는 기록 종류라 인자)
  const PROGRAMS = new Set(['uptime', 'timedatectl', 'chronyc', 'free', 'df', 'findmnt', 'du', 'ls', 'ps', 'pgrep', 'ip', 'ss', 'cat', 'systemctl', 'journalctl', 'who', 'last']);
  const FORBID_LINUX = [/\bsudo\b/, /\bsu\b/, /[^-]>/, /\brm\b/, /systemctl\s+(start|stop|restart|reload|enable|disable|mask|kill|status|reboot|poweroff|halt)\b/,
    /\bps\s+[^|]*\baux?\b/, /\bargs\b/, /\/proc\/[^ ]*\/(environ|cmdline)/, /\b(ping|curl|wget|nc|ncat|telnet|ssh|scp|traceroute|dig|nslookup)\b/, /\bdd\b/, /\btee\b/, /\bchmod\b/, /\bchown\b/,
    /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/, /\bcrontab\b/, /\$\(/, /`/];
  const FORBID_WIN = [/\b(Stop|Restart|Start|Set|Remove|New|Clear|Disable|Enable|Invoke|Suspend|Resume)-/i, /Test-NetConnection|Test-Connection|Invoke-WebRequest|Invoke-Expression|\biex\b/i,
    /Get-Content/i, /CommandLine/i, /\bshutdown\b/i, /Out-File/i, /\s>\s/];
  for (const p of P.PRESETS) {
    const params = longest(p);
    const c = P.checkRequest(p.id, params);
    assert.equal(c.ok, true, `${p.id}: ${c.reason}`);
    const plan = P.planOf(p, c.params);
    if (p.linux) {
      const cmd = plan.linux.command;
      for (const re of FORBID_LINUX) assert.equal(re.test(cmd.replace(/2>&1/g, '')), false, `${p.id} Linux 금지 ${re}: ${cmd}`);
      // 파일 내용을 읽는 것은 정해진 파일 하나(값이 아니다)
      for (const m of cmd.matchAll(/\b(cat|head|tail|less|more)\s+(\S+)/g)) assert.ok(m[1] === 'head' ? /^-\d+$/.test(m[2]) : m[2] === '/etc/resolv.conf', `${p.id}: ${m[0]}`);
      // 문장마다 timeout · 파이프 뒤는 거르는 프로그램(sort · head)만
      const parts = cmd.split('; ');
      assert.equal(parts[0], 'export LC_ALL=C');
      for (const s of parts.slice(1)) {
        assert.match(s, new RegExp(`^timeout ${p.linux.timeoutS} [a-z]`), `${p.id}: ${s}`);
        assert.ok(PROGRAMS.has(s.split(' ')[2]), `${p.id} 허용 목록 밖 프로그램: ${s.split(' ')[2]}`);
        if (s.split(' ')[2] === 'systemctl') assert.match(s, /^timeout \d+ systemctl (--failed|show) /, `${p.id}: systemctl 은 읽기(--failed · show)만`);
        for (const f of s.split(' | ').slice(1)) assert.match(f, /^(sort -rh|head -\d+)$/, `${p.id} 파이프: ${f}`);
      }
      // 로그인 + 명령 < 서버 한 대 시한(세션 예산 < 장비 시한)
      assert.ok(RS.READ_LOGIN_TIMEOUT_MS + plan.linux.timeoutMs < RS.READ_DEADLINE_MS, `${p.id}: ${plan.linux.timeoutMs}`);
      assert.ok(plan.linux.timeoutMs >= (p.linux.timeoutS * parts.slice(1).length + P.LINUX_SLACK_S) * 1000, `${p.id} 안쪽 시한 합 + 여유 ≤ exec 시한`);
      assert.equal(plan.linux.maxBytes, P.MAX_BYTES);
    }
    if (p.windows) {
      const script = P.windowsScript(p, c.params);
      for (const re of FORBID_WIN) assert.equal(re.test(script), false, `${p.id} Windows 금지 ${re}`);
      assert.ok(plan.windows.command.length <= P.CMD_LINE_MAX, `${p.id}: ${plan.windows.command.length}자`);
      assert.equal(Buffer.from(plan.windows.command.split(' ').pop(), 'base64').toString('utf16le'), script, 'Base64 는 스크립트 그대로');
      assert.deepEqual(plan.windows.winrm.args.at(-1), plan.windows.command.split(' ').pop(), 'WinRM 도 같은 스크립트');
      assert.ok(RS.READ_LOGIN_TIMEOUT_MS + plan.windows.timeoutMs < RS.READ_DEADLINE_MS, p.id);
      assert.equal(/\bsudo\b|runas/i.test(script), false);
    }
  }
  // 화면용 목록에는 함수 · 명령 글자가 없다
  const cat = JSON.stringify(P.catalog());
  assert.equal(/timeout \d/.test(cat), false); assert.equal(cat.includes('Select-Object'), false); assert.equal(cat.includes('systemctl'), false);
});

test('② 값 검사 — 주입 시도는 모두 거절(접속 전) · 통과한 값은 작은따옴표 + -- 뒤에 그대로 한 번', () => {
  const bad = ["a;rm -rf /", '$(id)', '`id`', 'a b', '-rf', "x'y", 'a\nb', 'a|b', 'a&b', '*', 'a\\b', '', 'ａ', 'a'.repeat(81), 'é', 'a\0'];
  for (const v of bad) assert.equal(P.checkRequest('svc-state', { unit: v }).ok, false, JSON.stringify(v));
  for (const v of [123, ['a'], { a: 1 }, null, undefined, true]) assert.equal(P.checkRequest('svc-state', { unit: v }).ok, false, String(v));
  const badPath = ['var/log', '/var/../etc', '/..', '/a/../../b', '/a b', "/a'b", '/a;b', '/$(id)', `/${'a'.repeat(200)}`, '/a\nb', '/*'];
  for (const v of badPath) assert.equal(P.checkRequest('du-top', { path: v }).ok, false, JSON.stringify(v));
  assert.equal(P.checkRequest('du-top', { path: '/var/log' }).ok, true);
  assert.equal(P.checkRequest('du-top', { path: '/a/..b/c' }).ok, true, '.. 조각이 아닌 이름은 통과');
  // 모르는 값 이름 · 빠진 값 · 모르는 프리셋
  assert.equal(P.checkRequest('uptime', { command: 'id' }).code, 'bad-param');
  assert.equal(P.checkRequest('svc-state', {}).code, 'bad-param');
  assert.equal(P.checkRequest('nope', {}).code, 'bad-preset');
  assert.equal(P.checkRequest('__proto__', {}).code, 'bad-preset');
  assert.equal(P.checkRequest('constructor', {}).code, 'bad-preset');
  // 통과한 값은 명령에 꼭 한 번 · 작은따옴표 · -- 뒤(journalctl 은 -u 값)
  const one = (id, params) => P.planOf(P.presetById(id), P.checkRequest(id, params).params).linux.command;
  assert.match(one('svc-state', { unit: 'chronyd.service' }), / -- 'chronyd\.service'$/);
  assert.match(one('pgrep', { name: 'java' }), /pgrep -l -- 'java'$/);
  assert.match(one('du-top', { path: '/var/log' }), /du -xh --max-depth=1 -- '\/var\/log' \| sort -rh \| head -20$/);
  assert.match(one('svc-log', { unit: 'sshd' }), /journalctl --no-pager -n 100 -u 'sshd'$/);
  // 미리 보기는 실행될 글 그대로
  const pv = P.previewOf('svc-state', { unit: 'chronyd' });
  assert.equal(pv.linux, one('svc-state', { unit: 'chronyd' }));
  assert.match(pv.windows, /Get-Service -Name 'chronyd'/);
});

test('③ 출력 다듬기 — 터미널 제어 순서 · 제어문자 · CR 을 걷고 줄 · 글자 상한 · 선형 시간', () => {
  assert.deepEqual(P.cleanOutput('a\x1b[31mred\x1b[0m\r\nb\x07\x1b]0;title\x07c\n\n'), { text: 'ared\nbc', lines: 2, cut: false });
  assert.equal(P.cleanOutput('x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y').text, 'xlinky');
  assert.equal(P.cleanOutput('a\u009bb\x00c\x7fd').text, 'abcd');
  assert.equal(P.cleanOutput(null).text, '');
  const many = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n');
  const c = P.cleanOutput(many, { maxLines: 10 });
  assert.equal(c.lines, 10); assert.equal(c.cut, true);
  assert.equal(P.cleanOutput('x'.repeat(100), { maxLineChars: 10 }).text, 'x'.repeat(10));
  // 선형(비율) — 같은 꼴을 4배로 늘려도 시간이 4배 남짓(제곱이면 16배)
  const time = (n) => { const s = '\x1b['.repeat(n) + '\n'.repeat(n) + 'z'; const t0 = process.hrtime.bigint(); for (let i = 0; i < 3; i += 1) P.cleanOutput(s, { maxLines: 1e9 }); return Number(process.hrtime.bigint() - t0); };
  time(2000);
  const a = time(8000); const b = time(32000);
  assert.ok(b / a < 10, `선형이어야 — ${a} → ${b} (${(b / a).toFixed(1)}배)`);
});

test('④ 허용 기능 — 서버 명령은 직접 켠 키 · 계정만(목록 없는 예전 항목은 막힘) · 다른 기능은 예전 그대로', () => {
  assert.equal(PL.featureBlocked(null, 'server-cmd'), true);
  assert.equal(PL.featureBlocked(undefined, 'server-cmd'), true);
  assert.equal(PL.featureBlocked(['server-info'], 'server-cmd'), true);
  assert.equal(PL.featureBlocked(['server-cmd'], 'server-cmd'), false);
  assert.equal(PL.featureBlocked(null, 'server-info'), false, '예전 항목은 다른 기능에 그대로');
  assert.equal(PL.featureBlocked(['bm-usage'], 'server-info'), true);
  assert.equal(PL.featureBlocked(['bm-usage'], ''), true, '빈 기능은 목록이 있는 항목을 못 쓴다(예전 그대로)');
  assert.equal(PL.featureBlocked(null, ''), false);
  assert.equal(PL.featureBlocked(['bm-usage'], 'conn-test'), false, '연결 시험은 기능과 무관(예전 그대로)');
  assert.equal(PL.keyPlacementIssue({ features: null }, {}, 'server-cmd'), 'key-feature');
  assert.equal(PL.keyPlacementIssue({ features: ['server-cmd'] }, {}, 'server-cmd'), null);
  assert.equal(PL.keyPlacementIssue({ features: null }, {}, 'bm-usage'), null);
  // 세 목록이 같은 id 를 안다
  assert.ok(KS.KEY_FEATURES.includes('server-cmd'));
  assert.deepEqual(SA.FEATURE_CATALOG.map((f) => f.id), [...KS.KEY_FEATURES]);
  assert.equal(PL.FEATURE_LABEL['server-cmd'], '서버 명령 실행');
  assert.equal(KS.normFeatures(['server-cmd', 'nope']).join(), 'server-cmd');
});

test('⑤ 코어로 실행 — 보낸 명령은 계획 그대로 · 끝 코드 · 다듬은 출력 · 계정 판정(직접 켠 계정만 · 접속 0회) · OS 에 없는 프리셋 · 엣지 · 값 오류는 접속 전', async () => {
  SSHD.st.passwords.root = 'Own-1';
  const own = srv({ name: 'own', vcenterId: 'vcA', os: 'linux', password: 'Own-1' });
  const r = await SVC.runMany({ preset: 'svc-state', params: { unit: 'chronyd' }, ids: [own.id] }, { by: 'own' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.ran, 1); assert.equal(r.nonZero, 0);
  assert.equal(SSHD.st.cmds.at(-1), P.previewOf('svc-state', { unit: 'chronyd' }).linux, '보낸 명령은 미리 보기와 같은 한 줄');
  const v = SVC.buildView();
  const row = v.last.rows.find((x) => x.id === own.id);
  assert.equal(row.code, 'ok'); assert.equal(row.exit, 0); assert.equal(row.first, 'Id=chronyd.service'); assert.equal(row.lines, 3);
  assert.equal(row.out, undefined, '화면 목록에는 출력 원문이 없다(펼칠 때 따로)');
  const out = SVC.outputs(own.id);
  assert.equal(out.rows[0].out, 'Id=chronyd.service\nActiveState=active\nSubState=running'); assert.equal(out.rows[0].err, 'warn: x');
  assert.equal(JSON.stringify(v).includes('Own-1'), false); assert.equal(JSON.stringify(out).includes('Own-1'), false);
  // 끝 코드가 0 이 아니어도 실행됨(실패로 치지 않는다)
  const r2 = await SVC.runMany({ preset: 'pgrep', params: { name: 'nothere' }, ids: [own.id] }, { by: 'own' });
  assert.equal(r2.ran, 1); assert.equal(r2.nonZero, 1);
  const row2 = SVC.buildView().last.rows[0];
  assert.equal(row2.ok, true); assert.equal(row2.exit, 1); assert.equal(row2.lines, 0);
  assert.equal(SVC.buildView().last.preset, 'pgrep', '마지막 한 건만 — 앞 실행은 지웠다');
  // 값 오류 · 모르는 프리셋 — 접속하지 않는다
  const n0 = SSHD.st.seen.length;
  assert.equal(SVC.startRun({ preset: 'svc-state', params: { unit: 'a;id' }, ids: [own.id] }).status, 400);
  assert.equal(SVC.startRun({ preset: 'rm', params: {}, ids: [own.id] }).code, 'bad-preset');
  assert.equal(SSHD.st.seen.length, n0);
  // Windows 서버에 Linux 전용 프리셋 — 코어 no-plan(접속 0회)
  const win = srv({ name: 'win', vcenterId: 'vcA', os: 'windows', username: 'adm', password: 'Win-1' });
  await SVC.runMany({ preset: 'df-inode', params: {}, ids: [win.id] }, { by: 'own' });
  assert.equal(SVC.buildView().last.rows[0].code, 'no-plan'); assert.equal(SSHD.st.seen.length, n0);
  // 엣지 서버 — 중앙은 붙지 않는다
  const edge = srv({ name: 'edge', vcenterId: 'vcA', os: 'linux', agent: 'edge-kr', password: 'x' });
  await SVC.runMany({ preset: 'uptime', params: {}, ids: [edge.id] }, { by: 'own' });
  assert.equal(SVC.buildView().last.rows[0].code, 'edge-delegated'); assert.equal(SSHD.st.seen.length, n0);
  // 물려받은 공통 계정 — 기능 목록이 없는 예전 계정 · 다른 기능만 켠 계정은 막힌다(접속 0회) · 직접 켜면 실행
  const legacy = KS.saveAccount({ name: 'kr-old', kind: 'os', corp: 'vcB', os: 'linux', username: 'svc', password: 'Svc-1' }, { by: 't' });
  assert.equal(legacy.ok, true, legacy.reason);
  assert.equal(KS.accountById(legacy.account.id).features ?? null, null, '기능 목록 없는 예전 계정');
  ST.setAssign('vcB', 'linux', { account: legacy.account.id, auth: '' }, { by: 't' });
  const inh = srv({ name: 'inh', vcenterId: 'vcB', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(inh.id, { on: true, expectAddr: addrOf(inh), expectKey: BM.inheritKeyOf(inh), by: 't' }).ok, true);
  SSHD.st.passwords.svc = 'Svc-1';
  const n1 = SSHD.st.seen.length;
  await SVC.runMany({ preset: 'uptime', params: {}, ids: [inh.id] }, { by: 'own' });
  let lr = SVC.buildView().last.rows[0];
  assert.equal(lr.code, 'cred'); assert.equal(lr.credCode, 'account-feature'); assert.equal(SSHD.st.seen.length, n1, '접속 0회');
  // 같은 계정으로 서버 정보는 예전처럼 읽힌다(다른 기능은 그대로)
  assert.equal((await RS.readServer(inh.id, { feature: 'server-info', plan: { linux: { command: 'true', timeoutMs: 5000 } } })).ok, true);
  assert.equal(KS.saveAccount({ id: legacy.account.id, features: ['server-info'] }, { by: 't' }).ok, true);
  await SVC.runMany({ preset: 'uptime', params: {}, ids: [inh.id] }, { by: 'own' });
  assert.equal(SVC.buildView().last.rows[0].credCode, 'account-feature');
  assert.equal(KS.saveAccount({ id: legacy.account.id, features: ['server-info', 'server-cmd'] }, { by: 't' }).ok, true);
  await SVC.runMany({ preset: 'uptime', params: {}, ids: [inh.id] }, { by: 'own' });
  lr = SVC.buildView().last.rows[0];
  assert.equal(lr.code, 'ok', lr.reason); assert.equal(lr.auth.account, 'kr-old'); assert.equal(lr.auth.source, 'os');
});

test('⑥ 일괄 · 보관 — 진행 중 429 · 시한이면 받은 만큼 · 끝나고 30분 뒤 지움 · 한 번에 상한', async () => {
  const own = BM.listBmServersRaw().find((s) => s.name === 'own');
  SSHD.st.passwords.root = 'Own-1';
  SSHD.st.hang = true;
  const j1 = SVC.startRun({ preset: 'uptime', params: {}, ids: [own.id] }, { by: 'own' });
  assert.equal(j1.ok, true);
  const j2 = SVC.startRun({ preset: 'uptime', params: {}, ids: [own.id] }, { by: 'own' });
  assert.equal(j2.code, 'busy'); assert.equal(j2.status, 429);
  assert.equal(SVC.buildView().job.meta.preset, 'uptime');
  const d = await j1.done;
  SSHD.st.hang = false;
  assert.equal(d.failed, 1);
  const row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'exec-timeout'); assert.equal(row.ran, true); assert.equal(row.partial, true); assert.equal(row.first, 'partial line');
  assert.equal(SVC.buildView().job, null);
  // 끝나고 30분 — 지운다(화면 · 출력 모두)
  SVC._resetServerCmdForTest({ finishedAgoMs: SVC.RESULT_TTL_MS - 1000 });
  assert.ok(SVC.buildView().last);
  SVC._resetServerCmdForTest({ finishedAgoMs: SVC.RESULT_TTL_MS });
  assert.equal(SVC.buildView().last, null); assert.deepEqual(SVC.outputs().rows, []);
  assert.equal(SVC.outputs(own.id).ok, true, '출력이 없으면 빈 목록(지운 뒤)');
  assert.equal((await SVC.runMany({ preset: 'uptime', params: {}, ids: Array.from({ length: SVC.RUN_BATCH_MAX + 1 }, (_, i) => `x${i}`) })).code, 'too-many');
  assert.equal((await SVC.runMany({ preset: 'uptime', params: {}, ids: [] })).code, 'no-servers');
  assert.equal((await SVC.runMany({ preset: 'uptime', params: {}, ids: ['nope'] })).code, 'not-found');
}, { timeout: 120_000 });

test('⑦ 라우트 — 관리자 + 전체 범위만 · 프리셋 · 값 · id 만 받는다 · 202 · 출력은 따로 · 감사에 출력 · 비밀 없음', async (t) => {
  const express = (await import('express')).default;
  const { api: router } = await import('../src/routes/api.js');
  const USERS = { own: { username: 'own', role: 'admin', scope: null }, sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, op: { username: 'op', role: 'operator', scope: null }, v: { username: 'v', role: 'viewer', scope: null } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', router);
  const hs = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => hs.close());
  const call = async (u, method, p, body) => { const r = await fetch(`http://127.0.0.1:${hs.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ } return { s: r.status, j, txt }; };
  for (const u of ['sown', 'op', 'v']) {
    assert.equal((await call(u, 'GET', '/tools/server-cmd')).s, 403, u);
    assert.equal((await call(u, 'POST', '/tools/server-cmd/run', { preset: 'uptime', ids: ['x'] })).s, 403, u);
    assert.equal((await call(u, 'GET', '/tools/server-cmd/output')).s, 403, u);
    assert.equal((await call(u, 'GET', '/tools/server-cmd/preview?preset=uptime')).s, 403, u);
  }
  const g = await call('own', 'GET', '/tools/server-cmd');
  assert.equal(g.s, 200); assert.equal(g.j.presets.length, 22); assert.ok(g.j.servers.some((s) => s.name === 'own'));
  for (const secret of ['Own-1', 'Svc-1', 'Win-1']) assert.equal(g.txt.includes(secret), false);
  const pv = await call('own', 'GET', '/tools/server-cmd/preview?preset=svc-state&unit=chronyd');
  assert.equal(pv.s, 200); assert.match(pv.j.linux, /-- 'chronyd'$/);
  assert.equal((await call('own', 'GET', '/tools/server-cmd/preview?preset=svc-state&unit=a%3Bid')).s, 400);
  const own = g.j.servers.find((s) => s.name === 'own');
  SSHD.st.passwords.root = 'Own-1';
  // 명령 글자 칸 · 모르는 값은 받지 않는다(400 — 접속 전)
  const n0 = SSHD.st.cmds.length;
  assert.equal((await call('own', 'POST', '/tools/server-cmd/run', { preset: 'uptime', params: { command: 'id' }, ids: [own.id] })).s, 400);
  assert.equal((await call('own', 'POST', '/tools/server-cmd/run', { preset: 'uptime', command: 'id', ids: [own.id] })).s, 202, '본문의 다른 칸은 명령에 닿지 않는다');
  for (let i = 0; i < 200 && SVC.buildView().job; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(SSHD.st.cmds.length, n0 + 1); assert.equal(SSHD.st.cmds.at(-1), P.previewOf('uptime', {}).linux);
  const p = await call('own', 'POST', '/tools/server-cmd/run', { preset: 'svc-state', params: { unit: 'chronyd' }, ids: [own.id] });
  assert.equal(p.s, 202, p.txt); assert.equal(p.j.started, true); assert.equal(p.j.total, 1);
  for (let i = 0; i < 200 && SVC.buildView().job; i += 1) await new Promise((r) => setTimeout(r, 50));
  const g2 = await call('own', 'GET', '/tools/server-cmd');
  assert.equal(g2.j.job, null); assert.equal(g2.j.last.rows[0].code, 'ok');
  assert.equal(g2.txt.includes('ActiveState=active'), false, '목록 응답에는 출력 원문이 없다');
  const o = await call('own', 'GET', `/tools/server-cmd/output?id=${encodeURIComponent(own.id)}`);
  assert.equal(o.s, 200); assert.match(o.j.rows[0].out, /ActiveState=active/);
  assert.equal((await call('own', 'GET', '/tools/server-cmd/output?id=nope')).s, 404);
  await new Promise((r) => setTimeout(r, 100));
  const auditTxt = fs.readdirSync(DIR).filter((f) => f.startsWith('audit')).map((f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return ''; } }).join('\n');
  assert.match(auditTxt, /server-cmd\.run/); assert.match(auditTxt, /unit=chronyd/); assert.match(auditTxt, /server-cmd\.run\.done/);
  assert.equal(auditTxt.includes('Own-1'), false); assert.equal(auditTxt.includes('ActiveState'), false, '감사에 출력 없음');
});
