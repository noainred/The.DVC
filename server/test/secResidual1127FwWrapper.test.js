// 보안 잔여 11-27 M-5 — 호스트 접근 제어의 firewall-cmd sudo 권한을 root 소유 인자 검사 래퍼로 제한.
//   2026-09-12 감사 M-5 · 2026-11-08 OLD-1: install.sh 가 sudoers 에 '<계정> ALL=(root) NOPASSWD: /usr/bin/firewall-cmd'(인자 무제한)를 썼다 —
//   서비스 계정(같은 계정으로 도는 RMA 인스턴스 · NoNewPrivileges=false 포함)이 탈취되면 기본 존 바꾸기 · direct passthrough · panic ·
//   forward-port · --*-from-file 로 방화벽 전체를 바꿀 수 있었다. 사용자 결정: 래퍼로 제한.
//   ① 래퍼(packaging/offline/vmware-portal-firewall-cmd)는 **시험 사본을 실제로 실행**한다 — 운영 파일의 FWCMD 한 줄만 가짜 firewall-cmd 로 바꾼다
//      (운영 래퍼가 env 로 경로를 바꾸게 만들지 않는다).
//   ② 판정 코어는 래퍼 하나다 — 서버의 계획 사전 검사도 같은 사본을 --vp-validate-only 로 실행해 대조한다(JS 사본 없음).
//   ③ install.sh 함수는 꺼내서 실제 bash 로 돌린다(래퍼 설치는 root 일 때만 — CI 는 uid 1001 이라 건너뛴다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const WRAPPER_SRC = path.join(REPO, 'packaging/offline/vmware-portal-firewall-cmd');
const INSTALL = rd('packaging/offline/install.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const TAG = 'vmware-portal-firewall-cmd: refused:';

const TMP = [];
const tmpDir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
after(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 정리 실패는 결과가 아니다 */ } } });

process.env.CONFIG_DIR = tmpDir('fwwrap-cfg-');
process.env.PORT = '4000';
const R = await import('../src/hostaccess/render.js');
const S = await import('../src/hostaccess/service.js');
const E = await import('../src/hostaccess/exec.js');
const St = await import('../src/hostaccess/settings.js');

/* ── 래퍼 시험 사본 ─────────────────────────────────────────────────────────────────────── */
const FWCMD_LINE = 'readonly FWCMD=/usr/bin/firewall-cmd';
/**
 * 가짜 firewall-cmd 와 그것을 부르는 래퍼 사본을 만든다. 가짜는 env -i 뒤(PATH 고정)에서 돈다 — bash · 절대 경로만 쓴다.
 *   log: 호출마다 'CALL␟인자…␞' · env: 마지막 호출의 환경 · zone: --get-default-zone 출력 · dzfail 이 있으면 그 조회를 252 로 실패.
 */
function mkCopy({ zone = 'public', listAll = '' } = {}) {
  const d = tmpDir('fwwrap-');
  const fake = path.join(d, 'fake-firewall-cmd');
  fs.writeFileSync(path.join(d, 'zone'), `${zone}\n`);
  fs.writeFileSync(path.join(d, 'listall'), listAll);
  fs.writeFileSync(path.join(d, 'log'), '');
  fs.writeFileSync(fake, `#!/bin/bash
D='${d}'
{ printf 'CALL'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\036'; } >> "$D/log"
/usr/bin/env > "$D/env"
case "$1" in
  --state) printf 'running\\n' ;;
  --get-default-zone) if [[ -e "$D/dzfail" ]]; then exit 252; fi; if [[ -e "$D/dzslow" ]]; then exec /bin/sleep 15; fi; /bin/cat "$D/zone" ;;
esac
if [[ "\${2:-}" == --list-all ]]; then /bin/cat "$D/listall"; fi
exit 0
`, { mode: 0o755 });
  const src = fs.readFileSync(WRAPPER_SRC, 'utf8');
  assert.equal(src.split('\n').filter((l) => l === FWCMD_LINE).length, 1, '운영 래퍼에 FWCMD 고정 줄이 정확히 한 번');
  const copy = path.join(d, 'wrapper');
  fs.writeFileSync(copy, src.replace(FWCMD_LINE, `readonly FWCMD=${fake}`), { mode: 0o755 });
  const calls = () => fs.readFileSync(path.join(d, 'log'), 'utf8').split('\x1e').filter(Boolean).map((c) => c.split('\x1f').slice(1));
  const reset = () => fs.writeFileSync(path.join(d, 'log'), '');
  return { d, copy, fake, calls, reset };
}
function runW(c, args, env = {}) {
  c.reset();
  const r = spawnSync(c.copy, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
  return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '', calls: c.calls() };
}
const validateW = (c, args) => runW(c, ['--vp-validate-only', ...args]);

/* ── 포탈이 실제로 만드는 인자 말뭉치 ─────────────────────────────────────────────────── */
const ADMIN_RULES = [
  'rule family="ipv4" source address="10.9.9.9" service name="ssh" accept',
  'rule family="ipv4" source address="10.0.0.0/24" service name="ssh" log prefix="[SSH] " level="info" limit value="3/m" accept',
  'rule family="ipv6" source address="2001:db8::/64" service name="ssh" drop',
  'rule priority="-10" family="ipv4" source NOT address="10.0.0.0/8" port port="22" protocol="tcp" reject type="icmp-port-unreachable"',
  'rule family="ipv4" port port="443" protocol="tcp" audit limit value="1/m" accept',
  'rule family="ipv4" source ipset="mgmt" service name="ssh" nflog group="3" prefix="ssh-in" accept',
  'rule family="ipv4" source address="172.16.0.0/12" port port="8443" protocol="tcp" accept limit value="10/s" burst="20"',
  'rule family="ipv4" forward-port port="80" protocol="tcp" to-port="4000"',
  'rule family="ipv4" source-port port="22" protocol="tcp" accept',
  'rule family="ipv4" source address="1.2.3.4" service name="http" accept',
];
const listAllText = ({ services = 'ssh http https', ports = '22/tcp 80/tcp 443/tcp 4000/tcp 8080-8090/tcp', rich = ADMIN_RULES } = {}) => `public (active)
  target: default
  interfaces: ens192
  sources:
  services: ${services}
  ports: ${ports}
  forward-ports:
  rich rules:
${rich.map((r) => `\t${r}`).join('\n')}
`;
const SETTINGS = [
  { ssh: { mode: 'open' }, web: { mode: 'open', ports: ['80', '443', '8080-8090'] } },
  {
    ssh: { mode: 'allowlist', allow: ['10.0.0.0/8', '2001:db8::/32', '192.168.1.5', '::ffff:10.2.3.4'] },
    web: { mode: 'allowlist', allow: ['10.1.1.0/24', 'fd00::/8'], ports: ['443', '8443'] },
    firewall: { extra: [
      { port: '5000-5010', proto: 'udp', action: 'drop', sources: ['192.168.0.0/16'] },
      { port: '9090', proto: 'tcp', action: 'reject' },
      { port: '7000', proto: 'tcp', action: 'accept', sources: ['2001:db8:1::/48'] },
      { port: '53', proto: 'udp', action: 'accept' },
    ] },
  },
  { ssh: { mode: 'deny', stopService: true }, web: { mode: 'allowlist', allow: ['10.1.1.1'], ports: ['80', '443'] } },
  { ssh: { mode: 'allowlist', allow: ['10.1.1.1/32'] }, web: { mode: 'open', ports: ['22'] }, firewall: { extra: [{ port: '1-65535', proto: 'tcp', action: 'drop', sources: ['203.0.113.0/24'] }] } },
];
const CURS = [
  R.parseListAll(listAllText()),
  R.parseListAll(listAllText({ services: '', ports: '', rich: [] })),
  R.parseListAll(listAllText({ services: 'cockpit', ports: '4000/tcp', rich: ['rule family="ipv4" port port="4000" protocol="tcp" accept'] })),
];
function planCorpus() {
  const out = [];
  for (const raw of SETTINGS) {
    const { settings } = R.normalizeSettings(raw, { portalPorts: ['4000'] });
    for (const cur of CURS) {
      const prevRich = R.desiredRichRules(settings).slice(0, 2);
      out.push(...R.planCommands(settings, cur, { prevRich, requesterIp: '10.1.1.1' }).commands);
    }
  }
  return out;
}

const fakeSide = { sshdCtl: async () => ({ ok: true, stdout: '', stderr: '' }), sshdActive: async () => true, isSudoDenied: E.isSudoDenied };
/** 서비스를 기록용 가짜 실행기로 돌려 실제로 부르는 firewall-cmd 인자를 모은다(조회 · 계획 · 적용 · 확정 · 되돌림). */
async function serviceCorpus() {
  const seen = [];
  const la = listAllText();
  S._setExec({ ...fakeSide, fw: async (args) => {
    seen.push(args);
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args[1] === '--list-all') return { ok: true, code: 0, stdout: la, stderr: '' };
    return { ok: true, code: 0, stdout: '', stderr: '' };
  } });
  try {
    St._resetHostAccessCache?.();
    St.saveHostAccess({ pending: null, applied: null });
    for (const raw of SETTINGS.slice(1)) {
      const a = await S.applyHostAccess(raw, { requesterIp: '10.1.1.1', by: 't' });
      if (a.ok) { await S.confirmHostAccess({ by: 't' }); }
      const b = await S.applyHostAccess(SETTINGS[0], { requesterIp: '10.1.1.1', by: 't' });
      if (b.ok) await S.revertHostAccess({ by: 't' });
    }
  } finally { S._setExec(null); St.saveHostAccess({ pending: null, applied: null }); }
  return seen;
}
const uniqArgs = (list) => { const m = new Map(); for (const a of list) m.set(JSON.stringify(a), a); return [...m.values()]; };

let CORPUS = null;
async function corpus() {
  if (!CORPUS) CORPUS = uniqArgs([...(await serviceCorpus()), ...planCorpus()]);
  return CORPUS;
}

/* ── 공격 · 형식 밖 말뭉치 ─────────────────────────────────────────────────────────────── */
const Z = '--zone=public';
const ATTACKS = [
  ['--set-default-zone=trusted'],
  ['--direct', '--passthrough', 'ipv4', '-I', 'INPUT', '-j', 'ACCEPT'],
  ['--direct', '--passthrough'],
  ['--panic-on'],
  ['--lockdown-off'],
  ['--new-service-from-file=/etc/shadow'],
  [Z, '--set-target=ACCEPT'],
  ['--permanent', '--add-port=1/tcp'],
  [Z, '--add-masquerade'],
  [Z, '--add-forward-port=port=22:proto=tcp:toaddr=1.2.3.4'],
  [Z, '--add-service=telnet'],
  [Z, '--remove-service=ftp'],
  [Z, '--add-port=0/tcp'], [Z, '--add-port=65536/tcp'], [Z, '--add-port=100-90/tcp'], [Z, '--add-port=4000/udp'], [Z, '--add-port=04000/tcp'],
  [Z, '--add-port=1-99999/tcp'],
  ['--zone=pub;lic', '--list-all'], ['--zone=public x', '--list-all'], ['--zone', 'public'], ['--zone=-x', '--list-all'],
  ['--zone=public', '--list-all', '--set-default-zone=trusted'],   // 앞 둘이 유효한 3인자(셋째를 버리고 통과하면 안 된다)
  [Z, '--list-all', '--panic-on'],
  [], [''], ['--state', ''],
  [Z, '--add-port=22/tcp\n'],
  [Z, '--add-rich-rule=rule family="ipv4" forward-port port="80" protocol="tcp" to-port="22"'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" service name="ssh" log prefix="x" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" port port="22" protocol="tcp" mark set="1"'],
  [Z, '--add-rich-rule=rule family="ipv6" source address="1.2.3.4" service name="ssh" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="2001:db8::1" service name="ssh" accept'],
  [Z, '--add-rich-rule=rule family="ipv6" source address="10.0.0.0/8" port port="22" protocol="tcp" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="2001:db8::/32" port port="4000" protocol="tcp" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="300.1.1.1" service name="ssh" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/33" service name="ssh" accept'],
  [Z, '--add-rich-rule=rule family="ipv6" port port="22" protocol="tcp" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" service name="ssh" drop'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" service name="http" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" port port="70000" protocol="tcp" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" port port="22" protocol="sctp" accept'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" service name="ssh" accept\n'],
  [Z, '--add-rich-rule=rule family="ipv4" source address="1.2.3.4\\" accept" service name="ssh" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" forward-port port="80" protocol="tcp" to-port="4000"'],
  [Z, '--remove-rich-rule=rule family="ipv4" source-port port="22" protocol="tcp" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" masquerade'],
  [Z, '--remove-rich-rule=rule family="ipv4" icmp-block name="echo-request"'],
  [Z, '--remove-rich-rule=rule family="ipv4" source address="1.2.3.4" service name="http" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" port port="70000" protocol="tcp" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" service name="ssh" mark set="1"'],
  [Z, '--remove-rich-rule=rule family="ipv4" service name="ssh" log prefix="a\\b" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" service name="ssh" log prefix="a"b" accept'],
  [Z, '--remove-rich-rule=rule family="ipv4" service name="ssh" log prefix="a\tb" accept'],     // 탭 — 인쇄 가능 글자 검사
  [Z, '--remove-rich-rule=rule family="ipv4" service name="ssh" log prefix="café" accept'],   // ASCII 밖
  [Z, `--remove-rich-rule=rule family="ipv4" service name="ssh" log prefix="${'x'.repeat(1000)}" accept`],   // 1024자 넘음
];

/* ═════════════════════════════ 1 · 2 · 3 · 4 · 5 래퍼 ═════════════════════════════ */
test('★1 래퍼 사본 — 포탈이 실제로 만드는 인자는 전부 통과하고 가짜 firewall-cmd 가 같은 argv 를 받는다', async () => {
  const c = mkCopy();
  const list = await corpus();
  const flat = list.map((a) => a.join(' '));
  for (const must of ['--state', '--get-default-zone', `${Z} --list-all`, '--runtime-to-permanent', '--reload']) assert.ok(flat.includes(must), `말뭉치에 ${must}`);
  for (const pre of ['--add-rich-rule=', '--remove-rich-rule=', '--add-port=', '--remove-port=', '--add-service=ssh', '--remove-service=']) assert.ok(flat.some((x) => x.includes(` ${pre}`)), `말뭉치에 ${pre}`);
  assert.ok(flat.some((x) => x.includes('log prefix="[SSH] "')), '관리자 ssh 규칙(대괄호 log prefix) 제거가 말뭉치에 있다');
  assert.ok(list.length >= 40, `말뭉치 ${list.length}개`);
  for (const args of list) {
    const r = runW(c, args);
    assert.equal(r.code, 0, `${args.join(' ')} → ${r.stderr}`);
    assert.deepEqual(r.calls.at(-1), args, `가짜가 받은 argv: ${args.join(' ')}`);
    if (args.length === 2) assert.deepEqual(r.calls[0], ['--get-default-zone'], '존 명령은 기본 존을 먼저 확인한다');
    else assert.equal(r.calls.length, 1, '1인자 명령은 존 확인 없이');
  }
});

test('★2 래퍼 사본 — 공격 · 형식 밖 인자는 종료 64 · 가짜 미호출 · 고정 접두 · 원문 미출력', () => {
  const c = mkCopy();
  for (const args of ATTACKS) {
    const r = runW(c, args);
    const label = JSON.stringify(args).slice(0, 160);
    assert.equal(r.code, 64, `${label} → ${r.code} ${r.stderr}`);
    assert.deepEqual(r.calls, [], `${label} — firewall-cmd 를 부르지 않는다(기본 존 조회도)`);
    assert.ok(r.stderr.startsWith(TAG), `${label} → ${r.stderr}`);
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, '한 줄');
    for (const a of args) if (a.length > 12) assert.ok(!r.stderr.includes(a.slice(-12)), `${label} — 거부한 원문을 찍지 않는다`);
    assert.ok(!/sudoers|password is required|not allowed to execute/i.test(r.stderr), 'sudo 거부로 오분류될 낱말 금지');
  }
});

test('★3 래퍼 사본 — 환경 격리(BASH_ENV · 환경 함수 · PYTHONPATH · 경로 변수 · 로캘)', () => {
  const c = mkCopy();
  const mark = path.join(c.d, 'MARK');
  const evil = path.join(c.d, 'evil');
  fs.writeFileSync(evil, `#!/bin/bash\n/usr/bin/touch '${mark}'\n`, { mode: 0o755 });
  const benv = path.join(c.d, 'benv.sh');
  fs.writeFileSync(benv, `/usr/bin/touch '${mark}'\n`);
  const env = {
    BASH_ENV: benv, ENV: benv, 'BASH_FUNC_exec%%': `() { /usr/bin/touch '${mark}'; }`, 'BASH_FUNC_refuse%%': '() { :; }',
    PYTHONPATH: '/x', PYTHONSTARTUP: benv, FWCMD: evil, ENVCMD: evil, TIMEOUTCMD: evil, SAFE_PATH: path.dirname(evil), TAG: 'x',
    SHELLOPTS: 'xtrace', LC_ALL: 'tr_TR.UTF-8', IFS: '-',
  };
  for (const args of [[Z, '--list-all'], ['--state'], [Z, '--add-rich-rule=rule family="ipv4" port port="80" protocol="tcp" accept']]) {
    const r = runW(c, args, env);
    assert.equal(r.code, 0, `${args.join(' ')} → ${r.stderr}`);
    assert.equal(fs.existsSync(mark), false, 'BASH_ENV · 환경 함수 · 경로 변수로 다른 코드를 실행하지 않는다');
    assert.deepEqual(r.calls.at(-1), args);
    const seen = fs.readFileSync(path.join(c.d, 'env'), 'utf8').split('\n');
    assert.ok(seen.includes(`PATH=${SAFE_PATH}`), `PATH 고정: ${seen.join(' | ')}`);
    assert.ok(seen.includes('LANG=C') && seen.includes('LC_ALL=C'));
    for (const k of ['PYTHONPATH', 'PYTHONSTARTUP', 'BASH_ENV', 'FWCMD', 'SHELLOPTS']) assert.ok(!seen.some((l) => l.startsWith(`${k}=`)), `${k} 를 넘기지 않는다`);
  }
  // 환경 함수로 refuse 를 바꿔도 거부는 거부다
  const bad = runW(c, ['--panic-on'], env);
  assert.equal(bad.code, 64); assert.equal(fs.existsSync(mark), false);
});

test('★4 래퍼 사본 — 존 명령은 기본 존일 때만 · 기본 존 조회 실패면 거부 · 1인자 명령은 조회 없이', () => {
  const c = mkCopy({ zone: 'work' });
  const r = runW(c, [Z, '--list-all']);
  assert.equal(r.code, 64); assert.match(r.stderr, /기본 존이 아님/);
  assert.deepEqual(r.calls, [['--get-default-zone']], '본 명령을 부르지 않는다');
  assert.equal(runW(c, ['--zone=work', '--list-all']).code, 0);
  fs.writeFileSync(path.join(c.d, 'dzfail'), '');
  const f = runW(c, ['--zone=work', '--add-service=ssh']);
  assert.equal(f.code, 64); assert.match(f.stderr, /기본 존 확인 실패/);
  assert.equal(f.calls.length, 1);
  const s = runW(c, ['--state']);
  assert.equal(s.code, 0); assert.deepEqual(s.calls, [['--state']]);
  // 기본 존 조회에 시한(포탈이 실패로 보고 되돌린 뒤 늦게 적용하지 않게 — 포탈의 sudo 시한 20초보다 짧게)
  fs.rmSync(path.join(c.d, 'dzfail'));
  fs.writeFileSync(path.join(c.d, 'dzslow'), '');
  const t0 = Date.now();
  const slow = runW(c, ['--zone=work', '--add-service=ssh']);
  const ms = Date.now() - t0;
  assert.equal(slow.code, 64, slow.stderr); assert.match(slow.stderr, /기본 존 확인 실패/);
  assert.ok(ms < 10_000, `기본 존 조회가 시한 안에 끊긴다(${ms}ms)`);
  assert.deepEqual(slow.calls, [['--get-default-zone']], '본 명령은 부르지 않는다');
  // 사전 검사(--vp-validate-only)는 기본 존을 보지 않고 firewall-cmd 도 부르지 않는다
  const v = validateW(c, ['--zone=elsewhere', '--list-all']);
  assert.equal(v.code, 0); assert.deepEqual(v.calls, []);
});

test('★5 운영 래퍼 정적 — -p 머리 · readonly 고정 경로 · env -i · eval/source/백틱 없음 · 환경에서 오는 대문자 변수 없음', () => {
  const src = fs.readFileSync(WRAPPER_SRC, 'utf8');
  const st = fs.statSync(WRAPPER_SRC);
  assert.ok(st.mode & 0o100, '저장소의 원본도 실행 비트(빌드가 그대로 담는다)');
  assert.equal(src.split('\n')[0], '#!/bin/bash -p');
  for (const l of [FWCMD_LINE, 'readonly ENVCMD=/usr/bin/env', 'readonly TIMEOUTCMD=/usr/bin/timeout', `readonly SAFE_PATH=${SAFE_PATH}`, "readonly TAG='vmware-portal-firewall-cmd: refused:'"]) {
    assert.ok(src.split('\n').includes(l), l);
  }
  const code = src.split('\n').slice(1).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(/^LC_ALL=C$/m.test(code) && /^set -fu$/m.test(code));
  // 명령 자리의 eval · source · '.' (rich rule 문법 글자 안의 'source' 낱말은 명령이 아니다)
  assert.doesNotMatch(code, /(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+)(?:eval|source|\.)\s/m, 'eval · source 금지');
  assert.doesNotMatch(code, /`|\$\(\s*</, '백틱 · $(< 파일) 금지');
  const execs = code.split('\n').filter((l) => /\bexec\b/.test(l));
  assert.equal(execs.length, 2);
  for (const l of execs) assert.match(l, /exec "\$ENVCMD" -i PATH="\$SAFE_PATH" LANG=C LC_ALL=C "\$FWCMD" /);
  assert.doesNotMatch(code, /"\$@"\s*<\/dev\/null|"\$FWCMD" "\$@"/, '검증하지 않은 "$@" 를 넘기지 않는다');
  for (const m of code.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*:-/g)) assert.equal(m[1], 'BASH_REMATCH', `기본값 확장은 BASH_REMATCH 에만: ${m[0]}`);
  const assigned = new Set([...code.matchAll(/^\s*(?:readonly\s+|local\s+)?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  for (const u of used) assert.ok(assigned.has(u) || u === 'BASH_REMATCH', `스크립트가 대입하지 않은 대문자 변수 ${u}`);
});

/* ═════════════════════════════ 6 · 7 판정 코어 하나 ═════════════════════════════ */
test('★6 사전 검사(fw.validate)는 래퍼 파일 하나로 판정한다 — 말뭉치 전체에서 실제 실행과 같은 답', async () => {
  const c = mkCopy();
  const fw = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: c.copy }), runImpl: E.run });
  for (const args of await corpus()) assert.equal(await fw.validate(args), null, args.join(' '));
  for (const args of ATTACKS) {
    const why = await fw.validate(args);
    assert.equal(typeof why, 'string', JSON.stringify(args).slice(0, 120));
    assert.ok(why.length > 0 && !why.includes(TAG));
  }
  assert.deepEqual(c.calls(), [], '사전 검사는 firewall-cmd 를 부르지 않는다');
  // 래퍼를 실행하지 못하면 '받는다' 가 아니다(fail-closed)
  const gone = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: path.join(c.d, 'nope') }), runImpl: E.run });
  assert.match(await gone.validate(['--state']), /사전 검사를 하지 못했습니다/);
});

test('★7 add 문법 ⊂ remove 문법 — 포탈이 넣은 규칙은 포탈이 지울 수 있다', async () => {
  const c = mkCopy();
  const adds = (await corpus()).filter((a) => a[1]?.startsWith('--add-rich-rule=')).map((a) => a[1].slice('--add-rich-rule='.length));
  assert.ok(adds.length >= 8);
  for (const r of adds) assert.equal(validateW(c, [Z, `--remove-rich-rule=${r}`]).code, 0, r);
});

/* ═════════════════════════════ 8 · 9 · 10 install.sh ═════════════════════════════ */
function shellFn(text, name) {
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}
const bash = (script, args = []) => spawnSync('bash', ['-c', script, '_', ...args], { encoding: 'utf8' });
function visudoUsable() {
  const d = tmpDir('fwwrap-visudo-');
  const f = path.join(d, 'ok');
  fs.writeFileSync(f, 'root ALL=(ALL) ALL\n');
  const r = spawnSync('visudo', ['-cf', f], { encoding: 'utf8' });
  return r.status === 0;
}
const VISUDO = visudoUsable();
const visudoOk = (text) => {
  const d = tmpDir('fwwrap-visudo-');
  const f = path.join(d, 's');
  fs.writeFileSync(f, text);
  return spawnSync('visudo', ['-cf', f], { encoding: 'utf8' }).status === 0;
};

test('★8 install.sh vp_hostaccess_sudoers — 래퍼면 래퍼 줄만 · 실패면 옛 줄은 지금 파일에 있을 때만 · 새로 넓히지 않는다', () => {
  const fn = shellFn(INSTALL, 'vp_hostaccess_sudoers');
  assert.ok(fn, '함수가 있다');
  const d = tmpDir('fwwrap-sudo-');
  const W = '/usr/local/libexec/vmware-portal-firewall-cmd';
  const LEG = 'vmportal ALL=(root) NOPASSWD: /usr/bin/firewall-cmd';
  const SSHD = 'vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl stop sshd.service, /usr/bin/systemctl start sshd.service, /usr/bin/systemctl disable sshd.service, /usr/bin/systemctl enable sshd.service';
  const gen = (ok, cur) => {
    const out = path.join(d, `out-${Math.random().toString(36).slice(2)}`);
    const r = bash(`set -euo pipefail\n${fn}\nvp_hostaccess_sudoers "$1" "$2" "$3" "$4" > "$5"\necho "@@legacy=$VP_HA_LEGACY"`, ['vmportal', ok, W, cur, out]);
    assert.equal(r.status, 0, r.stderr);
    return { text: fs.readFileSync(out, 'utf8'), legacy: /@@legacy=1/.test(r.stdout) };
  };
  const oldFile = path.join(d, 'old');
  fs.writeFileSync(oldFile, `# old\n${LEG}\n${SSHD}\n`);
  const lines = (t) => t.split('\n').filter((l) => l && !l.startsWith('#'));
  // ① 래퍼 준비 → 래퍼 줄 + sshd 줄
  const a = gen('1', path.join(d, 'none'));
  assert.deepEqual(lines(a.text), [`vmportal ALL=(root) NOPASSWD: ${W}`, SSHD]); assert.equal(a.legacy, false);
  // ④ 래퍼 준비 + 옛 줄 있음 → 옛 줄 제거(좁히기)
  const b = gen('1', oldFile);
  assert.deepEqual(lines(b.text), [`vmportal ALL=(root) NOPASSWD: ${W}`, SSHD]); assert.equal(b.legacy, false);
  // ② 실패 + 옛 줄 있음 → 옛 줄 유지(기능 유지 · 알림)
  const c = gen('0', oldFile);
  assert.deepEqual(lines(c.text), [LEG, SSHD]); assert.equal(c.legacy, true);
  // ③ 실패 + 파일 없음 → sshd 줄만(무제한을 새로 주지 않는다)
  const e = gen('0', path.join(d, 'none'));
  assert.deepEqual(lines(e.text), [SSHD]); assert.equal(e.legacy, false);
  // ⑤ 다른 계정의 옛 줄 · 링크 파일은 승인이 아니다
  const other = path.join(d, 'other');
  fs.writeFileSync(other, 'someone ALL=(root) NOPASSWD: /usr/bin/firewall-cmd\nvmportal ALL=(root) NOPASSWD: /usr/bin/firewall-cmd --state\n');
  assert.deepEqual(lines(gen('0', other).text), [SSHD]);
  const link = path.join(d, 'link');
  fs.symlinkSync(oldFile, link);
  assert.deepEqual(lines(gen('0', link).text), [SSHD]);
  if (VISUDO) for (const t of [a.text, c.text, e.text]) assert.ok(visudoOk(t), `visudo -cf 통과:\n${t}`);
});

const LIB = path.join(REPO, 'packaging/offline/release-verify-lib.sh');
const installFw = (src, dst, { lib = true } = {}) => bash(`set -euo pipefail\n${lib ? `source '${LIB}'\n` : ''}${shellFn(INSTALL, 'vp_fw_wrapper_install')}\nvp_fw_wrapper_install "$1" "$2"`, [src, dst]);

test('★9 install.sh vp_fw_wrapper_install — 길 전체가 root 전용인 곳에 root 소유 0755 일반 파일로만(root 전용)', { skip: IS_ROOT ? false : 'root 만 소유자를 root 로 맞출 수 있다(CI uid 1001 — 변이 검증은 root 컨테이너에서)' }, () => {
  const base = tmpDir('fwwrap-inst-');
  fs.chmodSync(base, 0o755);
  const dir = path.join(base, 'libexec');
  const dst = path.join(dir, 'vmware-portal-firewall-cmd');
  // 정상
  let r = installFw(WRAPPER_SRC, dst);
  assert.equal(r.status, 0, r.stderr);
  let st = fs.lstatSync(dst);
  assert.ok(st.isFile() && !st.isSymbolicLink()); assert.equal(st.uid, 0); assert.equal(st.mode & 0o7777, 0o755);
  assert.equal(fs.readFileSync(dst, 'utf8'), fs.readFileSync(WRAPPER_SRC, 'utf8'));
  // 이미 있는 파일은 rename 으로 바꾼다(그 자리 링크를 따라가지 않는다)
  const victim = path.join(base, 'victim');
  fs.writeFileSync(victim, 'keep\n');
  fs.rmSync(dst); fs.symlinkSync(victim, dst);
  r = installFw(WRAPPER_SRC, dst);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.lstatSync(dst).isSymbolicLink(), '링크를 갈아끼웠다');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크 대상은 그대로');
  // 원본이 링크면 거부
  const srcLink = path.join(base, 'srclink');
  fs.symlinkSync(WRAPPER_SRC, srcLink);
  assert.equal(installFw(srcLink, path.join(base, 'x1', 'w')).status, 1);
  // 위 폴더를 그룹/기타가 쓸 수 있으면 거부 · 파일 안 생김
  const wdir = path.join(base, 'wide');
  fs.mkdirSync(wdir); fs.chmodSync(wdir, 0o777);
  assert.equal(installFw(WRAPPER_SRC, path.join(wdir, 'w')).status, 1);
  assert.equal(fs.existsSync(path.join(wdir, 'w')), false);
  // 서비스 계정 폴더 안의 링크가 root 전용 폴더를 가리켜도 거부(readlink -f 는 링크가 놓인 폴더를 보지 않는다 — VERIFY-01)
  const svc = path.join(base, 'svc');
  fs.mkdirSync(svc); fs.chmodSync(svc, 0o755); fs.chownSync(svc, 65534, 65534);
  const rootOnly = path.join(base, 'rootonly');
  fs.mkdirSync(rootOnly); fs.chmodSync(rootOnly, 0o755);
  fs.symlinkSync(rootOnly, path.join(svc, 'l'));
  r = installFw(WRAPPER_SRC, path.join(svc, 'l', 'w'));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(fs.existsSync(path.join(rootOnly, 'w')), false);
  // 확인 라이브러리가 없으면 두지 않는다
  r = installFw(WRAPPER_SRC, path.join(base, 'nolib', 'w'), { lib: false });
  assert.equal(r.status, 1); assert.match(r.stderr, /release-verify-lib\.sh 가 없어/, '원인을 말한다');
  assert.equal(fs.existsSync(path.join(base, 'nolib', 'w')), false);
  // 설치 경로가 폴더면 거부
  const asDir = path.join(dir, 'isdir');
  fs.mkdirSync(asDir);
  assert.equal(installFw(WRAPPER_SRC, asDir).status, 1);
  st = fs.lstatSync(dst); assert.equal(st.uid, 0);
});

test('★10 install.sh · uninstall.sh · build-package.sh 정적 대조 — 순서 · 경로 · 무조건 무제한 줄 없음', () => {
  assert.doesNotMatch(INSTALL, /printf '[^']*NOPASSWD: \/usr\/bin\/firewall-cmd\\n/, '무제한 줄을 무조건 쓰는 printf 가 없다');
  const m = /\nVP_FW_WRAPPER=(\S+)\n/.exec(INSTALL);
  assert.ok(m); assert.equal(m[1], E.FW_WRAPPER);
  const un = rd('packaging/offline/uninstall.sh');
  const iSud = un.indexOf('/etc/sudoers.d/vmware-portal-hostaccess');
  const iW = un.indexOf(`rm -f -- ${E.FW_WRAPPER}\n`);
  assert.ok(iSud > 0 && iW > iSud, 'uninstall 은 sudoers 를 지운 뒤 래퍼를 지운다');
  const a = INSTALL.indexOf('\nif command -v firewall-cmd &>/dev/null; then\n  VP_FW_OK=0');
  assert.ok(a > 0, '호스트 접근 제어 구역은 command -v firewall-cmd 안');
  const blockEnd = INSTALL.indexOf('\nfi\n', a);
  const block = INSTALL.slice(a, blockEnd);
  const pos = ['vp_fw_wrapper_install "$SCRIPT_DIR/vmware-portal-firewall-cmd" "$VP_FW_WRAPPER"', 'vp_hostaccess_sudoers "$SERVICE_USER" "$VP_FW_OK" "$VP_FW_WRAPPER" /etc/sudoers.d/vmware-portal-hostaccess > "$HA_TMP"',
    'if visudo -cf "$HA_TMP"', 'install -m 0440 "$HA_TMP" /etc/sudoers.d/vmware-portal-hostaccess'].map((s) => block.indexOf(s));
  for (const p of pos) assert.ok(p > 0, `구역 안에 순서대로: ${pos}`);
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i] > pos[i - 1], `순서 ${i}`);
  assert.ok(INSTALL.indexOf('systemctl restart "$SERVICE_NAME"') > blockEnd, '서비스 재시작은 래퍼 · sudoers 뒤');
  assert.ok(INSTALL.indexOf('\nvp_fw_wrapper_install() {') < a && INSTALL.indexOf('\nvp_hostaccess_sudoers() {') < a);
  // 래퍼 설치 길 판정은 길 전체(vp_path_controllers) — readlink -f 판정(vp_path_root_only)이 아니다
  const fn = shellFn(INSTALL, 'vp_fw_wrapper_install');
  assert.match(fn, /vp_path_controllers "\$dir"/); assert.match(fn, /vp_path_controllers "\$dst"/); assert.doesNotMatch(fn, /vp_path_root_only/);
  assert.match(fn, /mv -fT -- "\$tmp" "\$dst"/); assert.match(fn, /install -o 0 -g 0 -m 0755 -- "\$src" "\$tmp"/);
  // 패키지에 래퍼가 실린다 + 패키지 구성 문서
  const build = rd('packaging/offline/build-package.sh');
  const seg = build.slice(build.indexOf('# 4) Installer assets'), build.indexOf('# 5) Pack'));
  assert.match(seg, /cp "\$SCRIPT_DIR\/vmware-portal-firewall-cmd" "\$STAGE\/"/);
  assert.match(seg, /chmod 0755 "\$STAGE\/vmware-portal-firewall-cmd"/);
  assert.match(rd('packaging/offline/OFFLINE-INSTALL.md'), /── vmware-portal-firewall-cmd /);
  // 형제 경로: RMA 에 방화벽 유닛을 맡기면 알린다(같은 서비스 계정이 방화벽을 끌 수 있다)
  const g = /grep -qE '([^']+)' "\$SUDO_TMP"/.exec(INSTALL);
  assert.ok(g, 'RMA 방화벽 유닛 경고');
  const re = new RegExp(g[1].replace(/\\\./g, '\\.'));
  assert.ok(re.test('vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl stop firewalld.service'));
  assert.ok(!re.test('vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl restart vmware-portal.service'));
});

/* ═════════════════════════════ 11 · 12 exec.js ═════════════════════════════ */
function fakeIo(entries) {
  const mk = (e) => ({ uid: e.uid ?? 0, mode: e.mode ?? 0o755, isSymbolicLink: () => e.type === 'link', isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir' });
  return {
    lstatSync: (p) => {
      const e = entries[p];
      if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
      if (e.err) { const err = new Error(e.err); err.code = e.err; throw err; }
      return mk(e);
    },
    readlinkSync: (p) => { const e = entries[p]; if (!e || e.type !== 'link') { const err = new Error('EINVAL'); err.code = 'EINVAL'; throw err; } return e.target; },
  };
}
const W = '/usr/local/libexec/vmware-portal-firewall-cmd';
const baseTree = () => ({
  '/': { type: 'dir', mode: 0o755 }, '/usr': { type: 'dir' }, '/usr/local': { type: 'dir' }, '/usr/local/libexec': { type: 'dir' },
  [W]: { type: 'file', mode: 0o755 },
});
test('★11 exec.wrapperState — ENOENT 만 옛 직접 호출 · 그 밖의 이상은 unsafe(fail-closed) · 길은 문자 그대로 한 단계씩', () => {
  const st = (patch) => { const t = baseTree(); for (const [k, v] of Object.entries(patch)) { if (v === null) delete t[k]; else t[k] = { ...t[k], ...v }; } return E.wrapperState(W, fakeIo(t)); };
  assert.equal(E.FW_WRAPPER, W);
  assert.deepEqual(st({}), { mode: 'wrapper', cmd: W });
  assert.deepEqual(st({ [W]: null }), { mode: 'direct', cmd: E.FIREWALL_CMD });
  assert.equal(st({ '/usr/local/libexec': null, [W]: null }).mode, 'direct', '폴더가 없어도 없음');
  const bad = {
    symlink: { [W]: { type: 'link', target: '/tmp/x' } },
    'not-file': { [W]: { type: 'dir' } },
    'not-root': { [W]: { uid: 1000 } },
    writable: { [W]: { mode: 0o775 } },
    'writable-o': { [W]: { mode: 0o757 } },
    'not-exec': { [W]: { mode: 0o644 } },
    'parent-not-root': { '/usr/local/libexec': { uid: 1000 } },
    'parent-writable': { '/usr/local/libexec': { mode: 0o777 } },
    'root-writable': { '/': { mode: 0o777 } },
    eacces: { [W]: { err: 'EACCES' } },
    enotdir: { '/usr/local': { err: 'ENOTDIR' } },
    eloop: { [W]: { err: 'ELOOP' } },
    'parent-link-not-root': { '/usr/local': { type: 'link', uid: 1000, target: '/opt/local' } },
  };
  for (const [k, p] of Object.entries(bad)) {
    const r = st(p);
    assert.equal(r.mode, 'unsafe', `${k} → ${JSON.stringify(r)}`);
    assert.equal(r.cmd, W); assert.ok(r.detail && !/`|\*\*/.test(r.detail));
  }
  assert.equal(st({ '/usr/local/libexec': { mode: 0o1777 } }).mode, 'wrapper', 'sticky 폴더는 남이 root 항목을 바꾸지 못한다');
  // 길의 root 소유 링크는 대상 길을 이어서 본다
  const t = baseTree();
  t['/usr/local'] = { type: 'link', target: '/opt/loc' };
  t['/opt'] = { type: 'dir' }; t['/opt/loc'] = { type: 'dir' }; t['/opt/loc/libexec'] = { type: 'dir' }; t['/opt/loc/libexec/vmware-portal-firewall-cmd'] = { type: 'file' };
  assert.equal(E.wrapperState(W, fakeIo(t)).mode, 'wrapper');
  t['/opt/loc'] = { type: 'dir', uid: 1000 };
  assert.equal(E.wrapperState(W, fakeIo(t)).mode, 'unsafe', '링크 대상 길의 비root 폴더');
  t['/opt/loc'] = { type: 'dir' }; t['/opt/loc/libexec/vmware-portal-firewall-cmd'] = { type: 'file', uid: 1000 };
  assert.equal(E.wrapperState(W, fakeIo(t)).mode, 'unsafe', '링크 너머의 파일 소유자');
  t['/usr/local'] = { type: 'link', target: '/usr/local' };
  assert.equal(E.wrapperState(W, fakeIo(t)).why, 'loop');
});

test('★12 exec.makeFw — wrapper 는 sudo -n 래퍼 · direct 는 옛 argv 그대로 · unsafe 는 실행하지 않는다', async () => {
  const calls = [];
  const runImpl = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, code: 0, stdout: '', stderr: '' }; };
  const wfw = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: W }), runImpl });
  await wfw([Z, '--list-all']);
  assert.deepEqual(calls.pop(), ['sudo', '-n', W, Z, '--list-all']);
  const dfw = E.makeFw({ runner: () => ({ mode: 'direct', cmd: E.FIREWALL_CMD }), runImpl });
  await dfw(['--set-default-zone=trusted']);
  assert.deepEqual(calls.pop(), ['sudo', '-n', '/usr/bin/firewall-cmd', '--set-default-zone=trusted'], '옛 설치본은 옛 sudoers 와 1:1(동작 보존)');
  assert.equal(await dfw.validate(['--panic-on']), null, 'direct 모드는 사전 검사 없음(옛 동작)');
  const ufw = E.makeFw({ runner: () => ({ mode: 'unsafe', cmd: W, why: 'not-root', detail: 'root 소유가 아닙니다(/x)' }), runImpl });
  const u = await ufw(['--state']);
  assert.equal(u.ok, false); assert.equal(u.wrapperUnsafe, true); assert.equal(calls.length, 0, 'unsafe 는 spawn 하지 않는다');
  assert.match(await ufw.validate(['--state']), /root 소유가 아닙니다/);
  assert.equal(typeof E.fw.runner, 'function', '실제 실행기에 runner 가 붙어 있다');
  assert.equal(typeof E.fw.validate, 'function');
  // 래퍼 거부(종료 64 + 접두) → 사유만 · 그 밖의 실패 → 실행하지 못함(fail-closed)
  const v64 = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: W }), runImpl: async () => ({ ok: false, code: 64, stderr: `${TAG} 허용하지 않는 명령\n` }) });
  assert.equal(await v64.validate(['--panic-on']), '허용하지 않는 명령');
  const v1 = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: W }), runImpl: async () => ({ ok: false, code: 1, stderr: 'boom' }) });
  assert.match(await v1.validate(['--state']), /사전 검사를 하지 못했습니다\(exit 1\)/);
});

/* ═════════════════════════════ 13 · 14 service.js ═════════════════════════════ */
const sudoDenied = async () => ({ ok: false, code: 1, stdout: '', stderr: 'sudo: a password is required\n' });
test('★13 service.readEngine — 래퍼가 안전하지 않으면 wrapper-unsafe(옛 경로로 내려가지 않음) · NNP 확인 명령은 실행 방식을 따른다', async () => {
  let spawned = 0;
  const unsafe = E.makeFw({ runner: () => ({ mode: 'unsafe', cmd: W, why: 'not-root', detail: 'root 소유가 아닙니다(/usr/local/libexec/vmware-portal-firewall-cmd)' }), runImpl: async () => { spawned++; return { ok: true, code: 0, stdout: 'running', stderr: '' }; } });
  S._setExec({ ...fakeSide, fw: unsafe });
  try {
    const eng = await S.readEngine();
    assert.equal(eng.ok, false); assert.equal(eng.reason, 'wrapper-unsafe');
    assert.ok(eng.detail.includes(W) && eng.detail.includes('바꿔치기') && eng.detail.includes('install.sh'), eng.detail);
    assert.ok(!/`|\*\*/.test(eng.detail), '화면 문구에 백틱 · 별표 금지');
    assert.equal(spawned, 0);
    const p = await S.planHostAccess({ ssh: { mode: 'open' } }, { requesterIp: '10.1.1.1' });
    assert.equal(p.ok, false);
  } finally { S._setExec(null); }
  S._setExec({ ...fakeSide, fw: E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: W }), runImpl: sudoDenied }) });
  try {
    const eng = await S.readEngine();
    assert.equal(eng.reason, 'sudo-denied');
    assert.ok(eng.detail.includes(`sudo -n ${W} --state`), eng.detail);
    assert.equal(eng.hint, S.SUDOERS_HINT(process.env.USER || 'vmportal'));
  } finally { S._setExec(null); }
  S._setExec({ ...fakeSide, fw: E.makeFw({ runner: () => ({ mode: 'direct', cmd: E.FIREWALL_CMD }), runImpl: sudoDenied }) });
  try {
    const eng = await S.readEngine();
    assert.ok(eng.detail.includes(S.NNP_NOTE), '옛 설치본은 기존 안내 그대로');
  } finally { S._setExec(null); }
  assert.equal(S.nnpNoteFor(E.FIREWALL_CMD), S.NNP_NOTE);
  assert.equal(S.NNP_NOTE, '본체 유닛에 NoNewPrivileges=true 가 있으면 sudoers 가 맞아도 거부됩니다 — 실서버에서 sudo -n /usr/bin/firewall-cmd --state 로 확인하세요.');
});

const viaCopy = (c) => async (cmd, args, opts) => (cmd === 'sudo' ? E.run(args[1], args.slice(2), opts) : E.run(cmd, args, opts));
test('★14 service.plan/apply — 래퍼 모드는 래퍼 사전 검사(하나라도 거부면 적용 0건) · 옛 설치본은 경고 · 가짜 실행기는 예전 그대로', async () => {
  const BAD = 'rule family="ipv4" source address="10.0.0.0/24" service name="ssh" mark set="0x1"';
  const c = mkCopy({ listAll: listAllText({ rich: [...ADMIN_RULES, BAD] }) });
  const fw = E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: c.copy }), runImpl: viaCopy(c) });
  St.saveHostAccess({ pending: null, applied: null });
  S._setExec({ ...fakeSide, fw });
  try {
    c.reset();
    const a = await S.applyHostAccess({ ssh: { mode: 'open' }, web: { mode: 'open' } }, { requesterIp: '10.1.1.1', by: 't' });
    assert.equal(a.ok, false);
    assert.ok(a.errors.some((e) => e.startsWith('방화벽 래퍼가 받지 않는 명령이라 적용하지 않습니다') && e.includes('root 로 직접 정리')), a.errors.join('\n'));
    const ops = c.calls().map((x) => x.join(' '));
    for (const o of ops) assert.ok(['--state', '--get-default-zone', `${Z} --list-all`].includes(o), `조회 밖 실행: ${o}`);
    assert.equal(St.loadHostAccess().pending, null);
  } finally { S._setExec(null); }
  // 문법 안이면 래퍼를 거쳐 실제로 적용 · 옛 방식 경고 없음
  const ok = mkCopy({ listAll: listAllText() });
  S._setExec({ ...fakeSide, fw: E.makeFw({ runner: () => ({ mode: 'wrapper', cmd: ok.copy }), runImpl: viaCopy(ok) }) });
  try {
    ok.reset();
    const a = await S.applyHostAccess(SETTINGS[1], { requesterIp: '10.1.1.1', by: 't' });
    assert.equal(a.ok, true, (a.errors || []).join('\n'));
    assert.ok(a.commands.length >= 5);
    const ops = ok.calls().map((x) => JSON.stringify(x));
    for (const cmd of a.commands) assert.ok(ops.includes(JSON.stringify(cmd)), `적용됨: ${cmd.join(' ')}`);
    assert.ok(!a.warnings.includes(S.LEGACY_SUDO_NOTE) && !a.warnings.includes(S.LEGACY_ROOT_NOTE));
    const s = await S.hostAccessStatus({ requesterIp: '10.1.1.1' });
    assert.deepEqual(s.fwRunner, { mode: 'wrapper', path: W }); assert.equal(s.legacySudo, false);
    await S.revertHostAccess({ by: 't' });
  } finally { S._setExec(null); St.saveHostAccess({ pending: null, applied: null }); }
  // 옛 설치본(direct · 엔진 ok) → 경고(조용히 통과시키지 않는다) · 사전 검사 없음
  const okFake = async (args) => ({ ok: true, code: 0, stdout: args[1] === '--list-all' ? listAllText() : (args[0] === '--get-default-zone' ? 'public\n' : ''), stderr: '' });
  const direct = E.makeFw({ runner: () => ({ mode: 'direct', cmd: E.FIREWALL_CMD }), runImpl: async (cmd, args) => okFake(args.slice(2)) });
  S._setExec({ ...fakeSide, fw: direct });
  try {
    const p = await S.planHostAccess({ ssh: { mode: 'open' } }, { requesterIp: '10.1.1.1' });
    assert.equal(p.ok, true, p.errors.join('\n'));
    assert.ok(p.warnings.includes(IS_ROOT ? S.LEGACY_ROOT_NOTE : S.LEGACY_SUDO_NOTE), p.warnings.join('\n'));
    const s = await S.hostAccessStatus({ requesterIp: '10.1.1.1' });
    assert.deepEqual(s.fwRunner, { mode: 'direct', path: E.FIREWALL_CMD }); assert.equal(s.legacySudo, !IS_ROOT);
  } finally { S._setExec(null); }
  // 가짜 실행기(runner 없음 — 기존 시험) → 경고 · 사전 검사 없음
  S._setExec({ ...fakeSide, fw: okFake });
  try {
    const p = await S.planHostAccess({ ssh: { mode: 'open' } }, { requesterIp: '10.1.1.1' });
    assert.ok(!p.warnings.includes(S.LEGACY_SUDO_NOTE) && !p.warnings.includes(S.LEGACY_ROOT_NOTE));
    assert.equal((await S.hostAccessStatus({})).fwRunner, null);
  } finally { S._setExec(null); }
  for (const t of [S.LEGACY_SUDO_NOTE, S.LEGACY_ROOT_NOTE]) assert.ok(!/`|\*\*/.test(t));
});

/* ═════════════════════════════ 15 · 16 render · 안내 ═════════════════════════════ */
test('★15 render.isManagedRich — forward-port · source-port 규칙을 포트 요소로 오인해 지우지 않는다(형제 결함)', () => {
  const { settings } = R.normalizeSettings({ web: { mode: 'open', ports: ['80'] } }, { portalPorts: ['4000'] });
  const fwd = 'rule family="ipv4" forward-port port="80" protocol="tcp" to-port="4000"';
  const sp = 'rule family="ipv4" source-port port="22" protocol="tcp" accept';
  const plain = 'rule family="ipv4" port port="80" protocol="tcp" accept';
  const p22 = 'rule family="ipv4" source address="1.1.1.1" port port="22" protocol="tcp" accept';
  assert.equal(R.isManagedRich(fwd, settings), false);
  assert.equal(R.isManagedRich(sp, settings), false);
  assert.equal(R.isManagedRich(plain, settings), true);
  assert.equal(R.isManagedRich(p22, settings), true);
  const cur = R.parseListAll(listAllText({ rich: [fwd, sp, plain] }));
  const cmds = R.planCommands(settings, cur, { requesterIp: '10.1.1.1' }).commands.map((c) => c.join(' '));
  assert.ok(!cmds.some((c) => c.includes('forward-port') || c.includes('source-port')), cmds.join('\n'));
  assert.ok(cmds.includes(`${Z} --remove-rich-rule=${plain}`));
});

test('★16 SUDOERS_HINT — 주석 + 래퍼 줄 + sshd 줄 · 인자 무제한 줄 없음 · visudo 통과', () => {
  const h = S.SUDOERS_HINT('vmportal');
  const lines = h.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('# ') && lines[0].includes('install.sh') && lines[0].includes(W));
  assert.equal(lines[1], `vmportal ALL=(root) NOPASSWD: ${W}`);
  assert.match(lines[2], /^vmportal ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl stop sshd\.service, /);
  assert.ok(!lines.some((l) => /NOPASSWD: \/usr\/bin\/firewall-cmd\s*$/.test(l)), '무제한 줄을 안내하지 않는다');
  assert.ok(!/`|\*\*/.test(h));
  if (VISUDO) assert.ok(visudoOk(`${h}\n`));
});
