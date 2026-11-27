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
  const st = { passwords: {}, seen: [], cmds: [], hang: false, rc: null, rcRaw: null };
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
        // 끝 코드 표지 흉내 — 셸을 돌리지 않으므로 문장 수(명령 속 표지 printf 수)만큼 표지를 쓴다(st.rc: 문장별 끝 코드 · 없으면 0)
        const n = (info.command.match(/#DVC-RC=/g) || []).length;
        const marks = (codes) => Array.from({ length: n }, (_, i) => `\n#DVC-RC=${codes[i] ?? 0}\n`).join('');
        if (info.command.includes('pgrep')) { stream.stderr.write(marks([1])); stream.exit(0); stream.end(); return; }   // 찾지 못함 — pgrep 끝 코드 1 · 출력 없음(셸 끝 코드는 printf 의 0)
        if (info.command.includes('systemctl show')) { stream.write('Id=chronyd.service\r\n\x1b[31mActiveState=active\x1b[0m\r\nSubState=running\x07\n'); stream.stderr.write(`warn: x\n${marks([0])}`); stream.exit(0); stream.end(); return; }
        stream.write('ok\n'); stream.stderr.write(st.rcRaw ?? marks(st.rc || [])); stream.exit(0); stream.end();
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
      // 허용한 방향 바꾸기는 둘뿐 — du 의 2>/dev/null(권한 오류가 출력 상한을 채우지 않게) · 끝 코드 표지의 >&2
      const bare = cmd.replace(/ 2>\/dev\/null/g, '').replace(/ >&2/g, '');
      for (const re of FORBID_LINUX) assert.equal(re.test(bare), false, `${p.id} Linux 금지 ${re}: ${cmd}`);
      // 파일 내용을 읽는 것은 정해진 파일 하나(값이 아니다)
      for (const m of cmd.matchAll(/\b(cat|head|tail|less|more)\s+([^\s;]+)/g)) assert.ok(m[1] === 'head' ? /^-\d+$/.test(m[2]) : m[2] === '/etc/resolv.conf', `${p.id}: ${m[0]}`);
      // 문장마다 timeout · 첫 프로그램은 허용 목록 · 파이프 뒤는 거르는 프로그램(sort · head)만 · 문장마다 끝 코드 표지 하나
      const steps = p.linux.steps(c.params);
      const parts = steps;
      assert.ok(cmd.startsWith('export LC_ALL=C; '));
      for (const st of steps) {
        const [first, ...pipe] = st.split(' | ');
        assert.ok(cmd.includes(`timeout ${p.linux.timeoutS} ${first}`), `${p.id}: ${first}`);
        assert.ok(PROGRAMS.has(first.split(' ')[0]), `${p.id} 허용 목록 밖 프로그램: ${first.split(' ')[0]}`);
        if (first.startsWith('systemctl')) assert.match(first, /^systemctl (--failed|show) /, `${p.id}: systemctl 은 읽기(--failed · show)만`);
        for (const f of pipe) assert.match(f, /^(sort -rh|head -\d+)$/, `${p.id} 파이프: ${f}`);
      }
      assert.equal(cmd.split(P.RC_MARK).length - 1, steps.length, `${p.id}: 끝 코드 표지는 문장마다 하나`);
      assert.equal(P.linuxStatements(p, c.params), steps.length);
      // 로그인 + 명령 < 서버 한 대 시한(세션 예산 < 장비 시한)
      assert.ok(RS.READ_LOGIN_TIMEOUT_MS + plan.linux.timeoutMs < RS.READ_DEADLINE_MS, `${p.id}: ${plan.linux.timeoutMs}`);
      assert.ok(plan.linux.timeoutMs >= (p.linux.timeoutS * parts.length + P.LINUX_SLACK_S) * 1000, `${p.id} 안쪽 시한 합 + 여유 ≤ exec 시한`);
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
  // 길이는 정규식보다 먼저(긴 입력에 정규식을 돌리지 않는다 · 사유도 길이로)
  assert.equal(P.checkRequest('svc-state', { unit: 'a'.repeat(81) }).reason, '서비스 이름: 80자까지입니다.');
  assert.equal(P.checkRequest('du-top', { path: `/${'a'.repeat(5000)}` }).reason, '폴더 경로: 200자까지입니다.');
  assert.equal(P.checkRequest('du-top', { path: '/a/..b/c' }).ok, true, '.. 조각이 아닌 이름은 통과');
  // 모르는 값 이름 · 빠진 값 · 모르는 프리셋
  assert.equal(P.checkRequest('uptime', { command: 'id' }).code, 'bad-param');
  assert.equal(P.checkRequest('svc-state', {}).code, 'bad-param');
  assert.equal(P.checkRequest('nope', {}).code, 'bad-preset');
  assert.equal(P.checkRequest('__proto__', {}).code, 'bad-preset');
  assert.equal(P.checkRequest('constructor', {}).code, 'bad-preset');
  // 반증 F1: 본문 JSON 의 __proto__ 칸 · 바뀐 프로토타입 — 값 이름 검사를 비켜 가지 못한다(프로토타입에서 값을 읽지 않는다)
  assert.equal(P.checkRequest('du-top', JSON.parse('{"__proto__":{"path":"/etc"}}')).code, 'bad-param');
  assert.equal(P.checkRequest('du-top', Object.create({ path: '/etc' })).code, 'bad-param');
  const np = Object.create(null); np.path = '/var/log';
  assert.equal(P.checkRequest('du-top', np).ok, true, '프로토타입 없는 객체는 받는다(라우트가 만드는 모양)');
  // 반증 F8: autofs /net 자리(보는 것만으로 마운트)
  for (const v of ['/net', '/net/10.0.0.5', '/net/host/export']) assert.equal(P.checkRequest('du-top', { path: v }).ok, false, v);
  assert.equal(P.checkRequest('du-top', { path: '/network' }).ok, true);
  // 점검 1회차 U2: 커널이 /net 으로 푸는 꼴(빈 조각 · . 조각)도 거절 · 끝의 / 하나와 이름 속 점은 그대로
  for (const v of ['//net', '//net/10.0.0.5', '/./net/h', '/var//log', '/var/./log', '/.']) assert.equal(P.checkRequest('du-top', { path: v }).ok, false, v);
  for (const v of ['/var/log/', '/etc/.hidden', '/a.b/c..d']) assert.equal(P.checkRequest('du-top', { path: v }).ok, true, v);
  // 점검 2회차 D1: /proc/self/root · /proc/<pid>/root 로 /net 거절을 비켜 가지 못한다(/proc 통째로)
  for (const v of ['/proc', '/proc/self/root/net/10.0.0.5', '/proc/thread-self/root/net/h', '/proc/1/root/net/x']) assert.equal(P.checkRequest('du-top', { path: v }).ok, false, v);
  assert.equal(P.checkRequest('du-top', { path: '/process' }).ok, true);
  // 통과한 값은 명령에 꼭 한 번 · 작은따옴표 · -- 뒤(journalctl 은 -u 값)
  const one = (id, params) => P.planOf(P.presetById(id), P.checkRequest(id, params).params).linux.command;
  assert.match(one('svc-state', { unit: 'chronyd.service' }), / -- 'chronyd\.service'; printf /);
  assert.match(one('pgrep', { name: 'java' }), /pgrep -l -- 'java'; printf /);
  assert.match(one('du-top', { path: '/var/log' }), /\{ timeout 20 du -xh --max-depth=1 -- '\/var\/log' 2>\/dev\/null; printf .+ >&2; \} \| sort -rh \| head -20$/);
  assert.match(one('svc-log', { unit: 'sshd' }), /journalctl --no-pager -n 100 -u 'sshd'; printf /);
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
  // 반증 F6: 끝나지 않은 OSC 는 줄바꿈에서 멈춘다 · ESC ( B 의 B 를 남기지 않는다 · ESC 뒤 줄바꿈은 그대로 · 양방향 제어 글자는 버린다
  assert.equal(P.cleanOutput('a\x1b]0;never-ends\nline2\nline3').text, 'a\nline2\nline3');
  assert.equal(P.cleanOutput('Active\x1b(B: yes').text, 'Active: yes');
  assert.equal(P.cleanOutput('x\x1b\ny').text, 'x\ny');
  assert.equal(P.cleanOutput('ab\u202Edc\u2066e').text, 'abdce');
  const many = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n');
  const c = P.cleanOutput(many, { maxLines: 10 });
  assert.equal(c.lines, 10); assert.equal(c.cut, true);
  assert.equal(P.cleanOutput('x'.repeat(100), { maxLineChars: 10 }).text, 'x'.repeat(10));
  // 선형(비율) — 같은 꼴을 8배로 늘려도 시간이 8배 남짓(제곱이면 64배). 전량 실행 부하에서 1ms 짜리 측정이 흔들려 15배가 나온 적이 있다(간헐) —
  //   크기를 키우고(수십 ms) 다섯 번 중 가장 빠른 값으로 비교한다.
  const once = (n) => { const s = '\x1b['.repeat(n) + '\n'.repeat(n) + 'z'; const t0 = process.hrtime.bigint(); P.cleanOutput(s, { maxLines: 1e9 }); return Number(process.hrtime.bigint() - t0); };
  const best = (n) => Math.min(...Array.from({ length: 5 }, () => once(n)));
  best(4000);
  const a = best(8000); const b = best(64000);
  assert.ok(b / a < 24, `선형이어야 — ${a} → ${b} (${(b / a).toFixed(1)}배 · 8배 늘림)`);
});

test('③-2 끝 코드 표지 — 문장 수와 같을 때만 믿는다 · 124 는 시한 · 141(뒤 head 가 닫음)은 0 · 흉내 낸 표지로 수가 어긋나면 모름', () => {
  assert.deepEqual(P.rcOf('du: cannot read\n\n#DVC-RC=1\n', 1), { known: true, codes: [1], exit: 1, timedOut: false, stderr: 'du: cannot read' });
  assert.equal(P.rcOf('\n#DVC-RC=0\n\n#DVC-RC=124\n', 2).timedOut, true);
  assert.equal(P.rcOf('\n#DVC-RC=0\n\n#DVC-RC=124\n', 2).exit, 124);
  assert.equal(P.rcOf('\n#DVC-RC=141\n', 1).exit, 0);
  assert.equal(P.rcOf('', 1).known, false);
  assert.equal(P.rcOf('#DVC-RC=0\n\n#DVC-RC=0\n', 1).known, false, '프로그램이 흉내 낸 표지 — 수가 어긋나면 모름');
  assert.equal(P.rcOf('x#DVC-RC=0\n', 1).known, false, '줄 머리가 아니면 표지가 아니다');
  assert.equal(P.rcOf('\n#DVC-RC=0000\n', 1).known, false);
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

test('④-2 설정 화면 기능 목록 — 직접 켜야 하는 기능을 서버가 표시한다(화면의 ‘예전 방식’ 문구가 그것을 뺀다)', async () => {
  const v = await SA.buildView();
  const f = v.features.find((x) => x.id === 'server-cmd');
  assert.equal(f.explicit, true);
  // 점검 2회차 W2-2: 키로만 · 직접 켠 키만 쓰는 설치 · 준비 기능(KEY_EXPLICIT_FEATURES)도 ‘직접 켜야’ 로 싣는다
  assert.equal(v.features.filter((x) => x.explicit).map((x) => x.id).sort().join(), [...PL.EXPLICIT_FEATURES, ...PL.KEY_EXPLICIT_FEATURES].sort().join());
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
  // 반증 F3: 문장이 timeout 에 끊기면(124) 셸 끝 코드가 0 이어도 ‘시한 — 받은 만큼’ · 표지가 없으면 끝 코드 모름(null — 셸의 0 을 믿지 않는다)
  SSHD.st.rc = [124];
  await SVC.runMany({ preset: 'df', params: {}, ids: [own.id] }, { by: 'own' });
  let tr = SVC.buildView().last.rows[0];
  assert.equal(tr.code, 'exec-timeout'); assert.equal(tr.partial, true); assert.equal(tr.ran, true); assert.match(tr.reason, /시한\(10초\)/);
  SSHD.st.rc = null; SSHD.st.rcRaw = '\n#DVC-RC=0\n\n#DVC-RC=0\n';   // 문장은 하나인데 표지 둘(흉내) → 모름
  await SVC.runMany({ preset: 'df', params: {}, ids: [own.id] }, { by: 'own' });
  tr = SVC.buildView().last.rows[0];
  assert.equal(tr.code, 'ok'); assert.equal(tr.exit, null);
  SSHD.st.rc = null; SSHD.st.rcRaw = null;
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
  assert.equal(d.partial, 1); assert.equal(d.failed, 0); assert.equal(d.ran, 0, '실행됨 · 시한 · 실행 못 함은 겹치지 않는다');
  const row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'exec-timeout'); assert.equal(row.ran, true); assert.equal(row.partial, true); assert.equal(row.first, 'partial line');
  assert.equal(SVC.buildView().job, null);
  // 끝나고 30분 — 지운다(화면 · 출력 모두)
  SVC._resetServerCmdForTest({ finishedAgoMs: SVC.RESULT_TTL_MS - 1000 });
  assert.ok(SVC.buildView().last);
  SVC._resetServerCmdForTest({ finishedAgoMs: SVC.RESULT_TTL_MS });
  assert.equal(SVC.buildView().last, null); assert.deepEqual(SVC.outputs().rows, []);
  // 반증 F2: 지운 뒤 한 대를 지정한 조회는 404(빈 200 이 아니다 — 화면이 ‘펼침’ 만 바뀌고 아무것도 안 보였다)
  const gone = SVC.outputs(own.id);
  assert.equal(gone.ok, false); assert.equal(gone.status, 404); assert.equal(gone.code, 'gone');
  // 일괄 문 — 같은 계정명 · 틀린 비밀번호로 등록한 3대를 한 번에 돌려도 틀린 비밀번호는 한 번만 닿는다(계정 잠금 방지)
  const dup = [1, 2, 3].map((i) => srv({ name: `dup-${i}`, vcenterId: 'vcA', os: 'linux', username: 'dupu', password: 'Dup-Wrong-1' }));
  const dr = await SVC.runMany({ preset: 'uptime', params: {}, ids: dup.map((x) => x.id) }, { by: 'own' });
  assert.equal(SSHD.st.seen.filter((x) => x === 'Dup-Wrong-1').length, 1, `탐침 하나 — ${JSON.stringify(dr.results?.map((x) => x.code))}`);
  assert.deepEqual(dr.results.map((x) => x.code).sort(), ['auth-rejected', 'same-cred-rejected', 'same-cred-rejected']);
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
  assert.equal(pv.s, 200); assert.match(pv.j.linux, /-- 'chronyd'; printf /);
  // 값 검사 결과는 답(200 + ok:false · 사유 — 화면이 칠 때마다 묻는다 · 콘솔 오류를 만들지 않게) · 명령 글자는 싣지 않는다
  const bad = await call('own', 'GET', '/tools/server-cmd/preview?preset=svc-state&unit=a%3Bid');
  assert.equal(bad.s, 200); assert.equal(bad.j.ok, false); assert.equal(bad.j.code, 'bad-param'); assert.equal(bad.j.linux, undefined);
  assert.equal((await call('own', 'GET', '/tools/server-cmd/preview?preset=nope')).j.code, 'bad-preset');
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
  // 반증 F2: 화면이 본 실행(runKey)과 다르면 409 — 지난 표 아래에 다른 실행의 출력을 붙이지 않는다
  const rk = g2.j.last.runKey;
  assert.ok(rk);
  assert.equal((await call('own', 'GET', `/tools/server-cmd/output?id=${encodeURIComponent(own.id)}&run=${encodeURIComponent(rk)}`)).s, 200);
  assert.equal((await call('own', 'GET', `/tools/server-cmd/output?run=old-1`)).s, 409);
  // 반증 F1: 본문 원문의 params.__proto__ — 프로토타입을 바꿔 값 이름 검사를 비켜 가지 못한다(400 · 접속 0)
  const n1 = SSHD.st.cmds.length;
  const raw = await fetch(`http://127.0.0.1:${hs.address().port}/api/tools/server-cmd/run`, { method: 'POST', headers: { 'x-u': 'own', 'content-type': 'application/json' },
    body: `{"preset":"du-top","params":{"__proto__":{"path":"/etc"}},"ids":[${JSON.stringify(own.id)}]}` });
  assert.equal(raw.status, 400, await raw.text());
  assert.equal(SSHD.st.cmds.length, n1, '접속하지 않았다');
  await new Promise((r) => setTimeout(r, 100));
  const auditTxt = fs.readdirSync(DIR).filter((f) => f.startsWith('audit')).map((f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return ''; } }).join('\n');
  assert.match(auditTxt, /server-cmd\.run/); assert.match(auditTxt, /unit=chronyd/); assert.match(auditTxt, /server-cmd\.run\.done/);
  assert.equal(auditTxt.includes('Own-1'), false); assert.equal(auditTxt.includes('ActiveState'), false, '감사에 출력 없음');
});

test('⑧ 점검 1회차 W3 · W2 — 긴 오류 출력 뒤의 끝 코드 표지도 읽는다 · 실행 못 한 서버는 출력 목록에 없다', async () => {
  const own = BM.listBmServersRaw().find((s) => s.name === 'own');
  SSHD.st.passwords.root = 'Own-1';
  // W3: 경고 3,000자 뒤에 시한 표지(124) — 예전에는 코어가 stderr 를 앞 2,000자로 잘라 표지를 잃고 ‘실행됨’(끝 코드 모름)이었다
  SSHD.st.rc = null; SSHD.st.rcRaw = `${'w'.repeat(60)}\n`.repeat(50) + '\n#DVC-RC=124\n';
  await SVC.runMany({ preset: 'df', params: {}, ids: [own.id] }, { by: 'own' });
  let row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'exec-timeout', `긴 오류 출력 뒤 표지 — ${row.code}`); assert.equal(row.partial, true);
  SSHD.st.rcRaw = `${'w'.repeat(60)}\n`.repeat(50) + '\n#DVC-RC=2\n';
  await SVC.runMany({ preset: 'df', params: {}, ids: [own.id] }, { by: 'own' });
  row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'ok'); assert.equal(row.exit, 2, '끝 코드를 잃지 않는다');
  assert.ok(SVC.outputs(own.id).rows[0].err.split('\n').length <= 40, '보관하는 오류 출력은 여전히 줄 상한');
  SSHD.st.rcRaw = null;
  // W2: 접속 실패 서버와 함께 돌리면 출력 목록(전체 복사 · 모두 펼치기)에는 실행된 서버만
  const dead = srv({ name: 'dead', vcenterId: 'vcA', os: 'linux', port: 1, password: 'x' });
  await SVC.runMany({ preset: 'uptime', params: {}, ids: [own.id, dead.id] }, { by: 'own' });
  const rows = SVC.buildView().last.rows;
  assert.equal(rows.find((x) => x.id === dead.id)?.ran, false, '죽은 서버는 실행 못 함');
  assert.deepEqual(SVC.outputs().rows.map((x) => x.id), [own.id], '출력 목록에 실행 못 한 서버를 섞지 않는다');
  assert.equal(SVC.outputs(dead.id).status, 404);
}, { timeout: 60_000 });
