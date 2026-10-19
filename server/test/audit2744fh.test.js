/**
 * v2.744 최종 검토 FH(패키징 셸) — install.sh 의 vp_cfg_snap·vp_rma_env_request·6-0-1 에서 찾은 3건.
 *
 *  RZ-REV-01 vp_cfg_snap — 패키지 node 가 실행은 되지만 0·10·11 이 아닌 코드(1·9·126·127·신호)로 끝나면 cp 폴백으로 넘어가는데 node 의
 *            종료 코드(r)를 되돌리지 않아 cp 가 성공해도 언제나 '복사하지 못했습니다(그사이 링크…)' + 2 였다(폴백이 죽어 있었고 원인을
 *            서비스 계정의 바꿔치기로 잘못 지목했다). 이제 r=0 으로 되돌리고 실제 원인(node 비정상 종료)을 한 번 알린다.
 *  RZ-REV-02 vp_cfg_snap 의 node 경로가 POSIX ACL(system.posix_acl_access)·확장 속성(xattr)을 옮기지 않았다(cp 폴백은 옮겼다 — 경로마다
 *            결과가 달랐다). 이제 node 가 연 fd 를 /dev/fd/3 으로 넘겨 'cp --attributes-only --preserve=all' 로 옮긴다(경로를 다시 찾지
 *            않는다). vp_cfg_set_line 이 새로 쓰는 파일도 원본 사본의 ACL·xattr 을 받는다(vp_cfg_attrs — 예전 'sed -i' 는 지켰다).
 *            옮기지 못하면 사본은 쓰되 한 줄 알린다 · cp 가 크기를 바꾸면(내용을 건드리면) 쓰지 않는다.
 *  RZ-REV-03 '[[ -f && ! -L ]] 확인 → 그 경로를 다시 열기' — 그 사이 FIFO 로 바꾸면 root 설치기가 열기에서 시한 없이 멈췄고 링크면 따라갔다.
 *            install.sh 의 두 곳(vp_rma_env_request · 6-0-1 의 grep)을 vp_cfg_snap 사본에서 읽게 고쳤다. release-verify-lib.sh 의 두 곳
 *            (vp_root_env_policy · vp_stage_trust_copy)은 이 그룹 담당 밖이라 고치지 않았다(리드 보고).
 *
 * ⚠ install.sh 는 통째로 실행하지 않는다(시스템을 바꾼다) — audit2744j·rz 와 같이 함수·구간을 꺼내 실제 bash 로 임시 폴더 위에서 돌린다.
 *   '확인 뒤 바꿔치기' 는 우연에 맡기지 않고 bash DEBUG 트랩으로 **정해진 명령 직전에** 이름을 FIFO·링크로 바꿔 결정적으로 만든다
 *   (기준 판본은 그 자리에서 열기에 매달려 시한에 걸린다 — 변이 검증). ACL·xattr 은 python3 os.setxattr 로 단다(setfacl·setfattr 가 없는
 *   환경에서도 돈다 — 둘 다 없거나 파일 시스템이 거부하면 그 사실을 남기고 건너뛴다). 시각(Date.now())을 기준값으로 쓰지 않는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_PATH = path.join(ROOT, 'packaging', 'offline', 'install.sh');
const INSTALL = fs.readFileSync(INSTALL_PATH, 'utf8');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const ME = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
const sh = (args) => { try { return execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim(); } catch { return ''; } };
const REAL_CP = sh(['bash', '-c', 'command -v cp']) || '/usr/bin/cp';
const PY = sh(['bash', '-c', 'command -v python3']);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fh-'));
after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ } });
let seq = 0;
/** 가짜 설치 환경: <d>/etc/cfg(= CONFIG_DIR — 부모 <d>/etc 가 root 전용 임시 폴더 자리) · <d>/outside(링크 대상) */
function mkEnv() {
  const d = path.join(BASE, `e${++seq}`);
  fs.mkdirSync(path.join(d, 'etc', 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(d, 'outside'), { recursive: true });
  return { d, cfg: path.join(d, 'etc', 'cfg'), out: path.join(d, 'outside'), etc: path.join(d, 'etc') };
}
const leftovers = (env) => fs.readdirSync(env.etc).filter((n) => n.startsWith('.vmware-portal-cfg.'));
const snap = (f) => { const s = fs.statSync(f); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, body: fs.readFileSync(f, 'utf8'), mtime: Math.round(s.mtimeMs) }; };

function shellFn(text, name) {
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}
function allFns(text) {
  const names = [...text.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{$/gm)].map((m) => m[1]);
  return names.map((n) => shellFn(text, n)).filter(Boolean).join('\n');
}
function region(start, end) {
  const a = INSTALL.indexOf(start);
  const b = INSTALL.indexOf(end, a + 1);
  assert.ok(a > 0 && b > a, `install.sh 구간을 찾지 못했다: ${start} ~ ${end}`);
  return INSTALL.slice(INSTALL.lastIndexOf('\n', a) + 1, b);
}
const FNS = allFns(INSTALL);
const MODES = [
  { name: 'node', env: { VP_CFG_NODE: process.execPath } },
  { name: 'cp 폴백', env: { VP_CFG_NODE: '' } },
];
/** install.sh 의 함수 전부를 올린 bash(set -euo pipefail). 기본 시한 30초 — 기준 판본이 열기에 매달리면 여기서 끊긴다. */
function bash(script, args = [], env = {}, opt = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${FNS}\n${script}`, '_', ...args], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, VP_CFG_NODE: '', VP_CFG_MAX_BYTES: '', VP_CFG_COPY_TIMEOUT: '', VP_CFG_NODE_WARNED: '', NODE_OPTIONS: '', ...env },
    ...opt,
  });
}
const done = (r) => assert.equal(r.error, undefined, `시한 안에 끝나야 한다(열기에 매달리지 않는다): ${r.error} ${r.stderr}`);

/** 가짜 실행 파일 */
function fakeBin(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(f, 0o755);
  return f;
}

/* ── xattr 도우미(python3) ─────────────────────────────────────────────────────────────────────────────── */
/** POSIX ACL v2(user::rw- user:<id>:rw- group::r-- mask::rw- other::---) + user.tag 를 단다. 못 달면 사유 문자열. */
const PY_SET = String.raw`import os, struct, sys
def e(tag, perm, uid=0xFFFFFFFF): return struct.pack('<HHI', tag, perm, uid)
p = sys.argv[1]; who = int(sys.argv[2])
v = struct.pack('<I', 2) + e(1, 6) + e(2, 6, who) + e(4, 4) + e(0x10, 6) + e(0x20, 0)
os.setxattr(p, 'system.posix_acl_access', v)
os.setxattr(p, 'user.tag', b'fh-2744')
`;
const PY_DUMP = String.raw`import os, sys, json
out = {}
for n in sorted(os.listxattr(sys.argv[1])):
    if n == 'security.selinux': continue
    out[n] = os.getxattr(sys.argv[1], n).hex()
print(json.dumps(out))
`;
function setAcl(f) {
  if (!PY) return 'python3 없음';
  const r = spawnSync(PY, ['-I', '-c', PY_SET, f, String(IS_ROOT ? 65534 : (process.getuid?.() ?? 0) + 1)], { encoding: 'utf8' });
  return r.status === 0 ? null : `setxattr 실패: ${(r.stderr || '').trim().split('\n').pop()}`;
}
function xattrs(f) {
  const r = spawnSync(PY, ['-I', '-c', PY_DUMP, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
/** 이 환경에서 ACL·user xattr 을 달 수 있는가(못 달면 그 사유로 건너뛴다 — 조용히 통과시키지 않는다). */
const XATTR_SKIP = (() => {
  const d = fs.mkdtempSync(path.join(BASE, 'probe-'));
  const f = path.join(d, 'p');
  fs.writeFileSync(f, 'p');
  const why = setAcl(f);
  if (why) return `ACL·xattr 을 달 수 없어 건너뜀(${why})`;
  const x = xattrs(f);
  return x['system.posix_acl_access'] && x['user.tag'] ? false : 'ACL·xattr 을 읽어 오지 못해 건너뜀';
})();

/* ── 문법 ─────────────────────────────────────────────────────────────────────────────────────────────── */
test('FH ⓪ install.sh bash 문법이 맞다 · 고친 함수가 있다', () => {
  const r = spawnSync('bash', ['-n', INSTALL_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['vp_cfg_snap', 'vp_cfg_attrs', 'vp_cfg_set_line', 'vp_rma_env_request']) assert.ok(shellFn(INSTALL, n), n);
});

/* ── RZ-REV-01 ─────────────────────────────────────────────────────────────────────────────────────────── */
test('RZ-REV-01 ① vp_cfg_snap — node 가 1·9·126·127·신호로 끝나면 cp 폴백이 실제로 사본을 만든다(반환 0) · 원인은 node 비정상 종료라고 한 번만 알린다', () => {
  const env = mkEnv();
  const src = path.join(env.cfg, 'src.env');
  fs.writeFileSync(src, 'A=1\nB=2\n', { mode: 0o604 });
  fs.chmodSync(src, 0o604);
  fs.utimesSync(src, 1_000_000, 1_000_000);
  const bin = path.join(env.d, 'bin');
  const fakes = {
    1: fakeBin(bin, 'n1', 'exit 1'),
    9: fakeBin(bin, 'n9', 'exit 9'),
    126: fakeBin(bin, 'n126', 'exit 126'),
    127: fakeBin(bin, 'n127', 'exit 127'),
    137: fakeBin(bin, 'nkill', 'kill -KILL $$'),
  };
  const out = path.join(env.etc, 'copies');
  fs.mkdirSync(out);
  // 같은 셸에서 차례로 부른다 — 알림은 한 번(VP_CFG_NODE_WARNED)
  const script = String.raw`OUT="$1" SRC="$2"; shift 2
for n in "$@"; do r=0; VP_CFG_NODE="$n" vp_cfg_snap "$SRC" "$OUT/$(basename "$n")" 2>>"$OUT/err.log" || r=$?; echo "$(basename "$n") $r"; done`;
  const r = bash(script, [out, src, ...Object.values(fakes)]);
  done(r);
  assert.equal(r.status, 0, r.stderr);
  const rc = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(' ')));
  for (const [code, f] of Object.entries(fakes)) {
    const n = path.basename(f);
    assert.equal(rc[n], '0', `node 종료 코드 ${code} → 반환 0(예전 2)`);
    const c = snap(path.join(out, n));
    assert.equal(c.body, 'A=1\nB=2\n', `${code}: 내용`);
    assert.equal(c.mode, 0o604, `${code}: 권한`);
    assert.equal(c.mtime, 1_000_000_000, `${code}: 수정 시각`);
  }
  const err = fs.readFileSync(path.join(out, 'err.log'), 'utf8');
  assert.equal((err.match(/정상 종료하지 않아/g) || []).length, 1, '원인 알림은 한 번');
  assert.match(err, /종료 코드 1\)/);
  assert.doesNotMatch(err, /그사이 링크/, '바꿔치기를 원인으로 지목하지 않는다');
  assert.doesNotMatch(err, /복사하지 못했습니다/);
});

test('RZ-REV-01 ② 실제 node + 잘못된 NODE_OPTIONS(node 가 9 로 끝남) — 사본을 만든다 · 0·10·11 판정은 그대로(10 = 건너뜀 2 · 11 = 실패 1)', () => {
  const env = mkEnv();
  const src = path.join(env.cfg, 'p.env');
  fs.writeFileSync(src, 'P=1\n');
  const bin = path.join(env.d, 'bin');
  const n10 = fakeBin(bin, 'n10', 'printf link; exit 10');
  const n11 = fakeBin(bin, 'n11', 'printf "io:EIO"; exit 11');
  const script = String.raw`S="$1" E="$2"
r=0; NODE_OPTIONS=--fh-bogus-flag VP_CFG_NODE="$3" vp_cfg_snap "$S" "$E/a" || r=$?; echo "bogus $r"
r=0; VP_CFG_NODE="$4" vp_cfg_snap "$S" "$E/b" || r=$?; echo "ten $r"
r=0; VP_CFG_NODE="$5" vp_cfg_snap "$S" "$E/c" || r=$?; echo "eleven $r"`;
  const r = bash(script, [src, env.etc, process.execPath, n10, n11]);
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^bogus 0$/m);
  assert.equal(fs.readFileSync(path.join(env.etc, 'a'), 'utf8'), 'P=1\n');
  assert.match(r.stdout, /^ten 2$/m);
  assert.match(r.stderr, /심볼릭 링크/);
  assert.match(r.stdout, /^eleven 1$/m);
  assert.match(r.stderr, /io:EIO/);
  assert.equal(fs.existsSync(path.join(env.etc, 'b')) || fs.existsSync(path.join(env.etc, 'c')), false, '건너뜀·실패는 사본을 남기지 않는다');
});

test('RZ-REV-01 ③ 호출자 — node 가 비정상 종료해도 vp_cfg_fix·vp_cfg_set_line·vp_cfg_copy_new 가 할 일을 한다(예전에는 전부 건너뜀)', () => {
  const env = mkEnv();
  const fix = path.join(env.cfg, 'fix.env');
  fs.writeFileSync(fix, 'F=1\n', { mode: 0o644 });
  fs.chmodSync(fix, 0o644);
  const line = path.join(env.cfg, 'portal.env');
  fs.writeFileSync(line, 'PORT=4000\nCONFIG_DIR=/old\n');
  const mig = path.join(env.out, 'users.json');
  fs.writeFileSync(mig, '{"u":1}\n');
  const n1 = fakeBin(path.join(env.d, 'bin'), 'n1', 'exit 1');
  const script = String.raw`r1=0; vp_cfg_fix "$1" "$4" 0640 || r1=$?
r2=0; vp_cfg_set_line "$2" CONFIG_DIR /etc/vmware-portal || r2=$?
r3=0; vp_cfg_copy_new "$3" "$5" || r3=$?
echo "$r1 $r2 $r3"`;
  const r = bash(script, [fix, line, mig, ME, path.join(env.cfg, 'users.json')], { VP_CFG_NODE: n1 });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '0 0 0');
  assert.equal(snap(fix).mode, 0o640);
  assert.equal(fs.readFileSync(line, 'utf8'), 'PORT=4000\nCONFIG_DIR=/etc/vmware-portal\n');
  assert.equal(fs.readFileSync(path.join(env.cfg, 'users.json'), 'utf8'), '{"u":1}\n');
  assert.deepEqual(leftovers(env), []);
});

/* ── RZ-REV-02 ─────────────────────────────────────────────────────────────────────────────────────────── */
for (const m of MODES) {
  test(`RZ-REV-02 ① (${m.name}) vp_cfg_snap·vp_cfg_copy_new — 사본이 원본의 POSIX ACL·user xattr 을 그대로 가진다(경로마다 결과가 같다)`, { skip: XATTR_SKIP }, () => {
    const env = mkEnv();
    const src = path.join(env.cfg, 'a.env');
    fs.writeFileSync(src, 'A=1\n', { mode: 0o640 });
    fs.chmodSync(src, 0o640);
    assert.equal(setAcl(src), null);
    const want = xattrs(src);
    const dst = path.join(env.etc, 'copy');
    const mig = path.join(env.cfg, 'users.json');
    const r = bash('vp_cfg_snap "$1" "$2"; vp_cfg_copy_new "$1" "$3"', [src, dst, mig], m.env);
    done(r);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /옮기지 못했습니다/);
    for (const f of [dst, mig]) {
      assert.deepEqual(xattrs(f), want, `${path.basename(f)}: ACL·xattr 그대로`);
      assert.equal(snap(f).body, 'A=1\n');
      assert.equal(snap(f).mode, snap(src).mode, '권한(그룹 비트 = ACL mask)');
    }
    assert.deepEqual(leftovers(env), []);
  });

  test(`RZ-REV-02 ② (${m.name}) vp_cfg_fix — ACL 항목을 남기고 mask 만 줄인다(예전 제자리 chmod 와 같은 결과) · vp_cfg_set_line — 새 파일이 ACL·xattr 을 받는다(예전 sed -i 와 같다)`, { skip: XATTR_SKIP }, () => {
    const env = mkEnv();
    const fix = path.join(env.cfg, 'rma-default.env');
    const twin = path.join(env.out, 'twin.env');
    for (const f of [fix, twin]) { fs.writeFileSync(f, 'R=1\n', { mode: 0o640 }); fs.chmodSync(f, 0o640); assert.equal(setAcl(f), null); }
    // 예전(v2.743) 동작 — 제자리 chown + chmod 0640
    execFileSync('chown', [ME, twin]); execFileSync('chmod', ['0640', twin]);
    const line = path.join(env.cfg, 'portal.env');
    fs.writeFileSync(line, 'PORT=4000\n', { mode: 0o640 });
    fs.chmodSync(line, 0o640);
    assert.equal(setAcl(line), null);
    const lineWant = xattrs(line);
    const r = bash('vp_cfg_fix "$1" "$3" 0640; vp_cfg_set_line "$2" CONFIG_DIR /etc/vmware-portal', [fix, line, ME], m.env);
    done(r);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /옮기지 못했습니다/);
    assert.equal(snap(fix).mode, 0o640);
    assert.deepEqual(xattrs(fix), xattrs(twin), 'vp_cfg_fix 결과의 ACL = 예전 제자리 chmod 0640 결과(이름 지정 사용자 항목 유지 · mask r--)');
    assert.ok(xattrs(fix)['user.tag'], 'user xattr 유지');
    assert.equal(fs.readFileSync(line, 'utf8'), 'PORT=4000\nCONFIG_DIR=/etc/vmware-portal\n');
    assert.deepEqual(xattrs(line), lineWant, 'vp_cfg_set_line 결과도 원본의 ACL·xattr 그대로');
    assert.deepEqual(leftovers(env), []);
  });
}

test('RZ-REV-02 ③ (node) cp 가 속성을 옮기지 못하면 — 사본은 쓰고(반환 0) 그 사실을 한 줄 알린다 · cp 가 사본 크기를 바꾸면 사본을 버린다(반환 1)', () => {
  const env = mkEnv();
  const src = path.join(env.cfg, 'k.env');
  fs.writeFileSync(src, 'K=1\n', { mode: 0o640 });
  fs.chmodSync(src, 0o640);
  const fail = path.join(env.d, 'fail');
  fakeBin(fail, 'cp', `for a in "$@"; do if [[ "$a" == --attributes-only ]]; then echo "cp: setting attributes for 'x': Operation not supported" >&2; exit 1; fi; done\nexec ${REAL_CP} "$@"`);
  const trunc = path.join(env.d, 'trunc');
  fakeBin(trunc, 'cp', `for a in "$@"; do if [[ "$a" == --attributes-only ]]; then : > "\${@: -1}"; exit 0; fi; done\nexec ${REAL_CP} "$@"`);
  const r1 = bash('vp_cfg_snap "$1" "$2"', [src, path.join(env.etc, 'a')], { VP_CFG_NODE: process.execPath, PATH: `${fail}:${process.env.PATH}` });
  done(r1);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /ACL·확장 속성을 사본에 옮기지 못했습니다\(cp: setting attributes/);
  assert.equal(fs.readFileSync(path.join(env.etc, 'a'), 'utf8'), 'K=1\n');
  assert.equal(snap(path.join(env.etc, 'a')).mode, 0o640);
  const r2 = bash('r=0; vp_cfg_snap "$1" "$2" || r=$?; echo "rc=$r"', [src, path.join(env.etc, 'b')], { VP_CFG_NODE: process.execPath, PATH: `${trunc}:${process.env.PATH}` });
  done(r2);
  assert.match(r2.stdout, /rc=1/);
  assert.match(r2.stderr, /io:attrs-size/);
  assert.equal(fs.existsSync(path.join(env.etc, 'b')), false, '내용이 바뀐 사본을 남기지 않는다');
});

test('RZ-REV-02 ④ (cp 폴백) cp --preserve=all 이 속성을 못 옮겼다고 stderr 에만 말하면 — 버리지 않고 알린다 · vp_cfg_set_line 은 cp 가 새 파일 크기를 바꾸면 쓰지 않는다', () => {
  const env = mkEnv();
  const src = path.join(env.cfg, 'k.env');
  fs.writeFileSync(src, 'K=1\n');
  const warn = path.join(env.d, 'warn');
  fakeBin(warn, 'cp', `${REAL_CP} "$@" || exit $?\necho "cp: preserving permissions for 'x': Operation not supported" >&2\nexit 0`);
  const r1 = bash('vp_cfg_snap "$1" "$2"', [src, path.join(env.etc, 'a')], { VP_CFG_NODE: '', PATH: `${warn}:${process.env.PATH}` });
  done(r1);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /속성 일부\(ACL·확장 속성 등\)를 사본에 옮기지 못했습니다\(cp: preserving permissions/);
  assert.equal(fs.readFileSync(path.join(env.etc, 'a'), 'utf8'), 'K=1\n');
  // vp_cfg_attrs 의 안전망 — attributes-only 호출에서만 내용을 지우는 cp
  const line = path.join(env.cfg, 'portal.env');
  fs.writeFileSync(line, 'PORT=4000\n');
  const trunc = path.join(env.d, 'trunc');
  fakeBin(trunc, 'cp', `for a in "$@"; do if [[ "$a" == --attributes-only ]]; then : > "\${@: -1}"; exit 0; fi; done\nexec ${REAL_CP} "$@"`);
  const r2 = bash('r=0; vp_cfg_set_line "$1" CONFIG_DIR /c || r=$?; echo "rc=$r"', [line], { VP_CFG_NODE: '', PATH: `${trunc}:${process.env.PATH}` });
  done(r2);
  assert.match(r2.stdout, /rc=1/);
  assert.match(r2.stderr, /크기가 바뀌었습니다/);
  assert.equal(fs.readFileSync(line, 'utf8'), 'PORT=4000\n', 'portal.env 그대로');
  assert.deepEqual(leftovers(env), []);
});

/* ── RZ-REV-03 ─────────────────────────────────────────────────────────────────────────────────────────── */
/**
 * DEBUG 트랩 — 명령 문자열이 PAT(들) 중 하나를 담는 첫 명령 직전에 대상 이름을 FIFO(또는 링크)로 바꾼다(한 번만).
 * set -T 로 함수 안까지 따라간다. 결정적이라 우연에 기대지 않는다.
 */
function swapTrap(kind) {
  const act = kind === 'fifo'
    ? 'command mv -f -- "$SWAP_F" "$SWAP_F.was"; command mkfifo -- "$SWAP_F"'
    : 'command mv -f -- "$SWAP_F" "$SWAP_F.was"; command ln -s -- "$SWAP_TO" "$SWAP_F"';
  return `set -T
trap 'if [[ -z \${SWAPPED:-} ]]; then for p in "\${SWAP_PATS[@]}"; do if [[ $BASH_COMMAND == *"$p"* ]]; then SWAPPED=1; ${act}; break; fi; done; fi' DEBUG`;
}
const RMA_READ = 'vp_rma_env_request "$1"; trap - DEBUG; echo "root=$VP_RMA_ENV_ROOT units=$VP_RMA_UNITS reboot=$VP_RMA_REBOOT"';

for (const m of MODES) {
  test(`RZ-REV-03 ① (${m.name}) vp_rma_env_request — 확인 뒤 portal.env 를 FIFO 로 바꿔치기해도 열기에서 멈추지 않는다(예전: 시한 없이 멈춤)`, () => {
    for (const pats of [['vp_cfg_snap "', 'exec {fd}'], ['exec {fd}']]) {
      const env = mkEnv();
      const f = path.join(env.cfg, 'portal.env');
      fs.writeFileSync(f, 'RMA_SERVICE_UNITS=nginx\n', { mode: 0o644 });
      fs.chmodSync(f, 0o644);
      const script = `SWAP_F="$1"; SWAP_PATS=(${pats.map((p) => `'${p}'`).join(' ')})\n${swapTrap('fifo')}\n${RMA_READ}`;
      const r = bash(script, [f], { ...m.env, VP_CFG_COPY_TIMEOUT: '5' });
      done(r);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.lstatSync(f).isFIFO(), true, '트랩이 실제로 바꿔치기했다');
      if (pats.length === 2) {
        // 사본을 만들기 직전에 바뀜 → 사본을 만들지 않고(FIFO) 요청을 읽지 않는다 · 사유를 알린다
        assert.match(r.stdout, /units= reboot=0/);
        assert.match(r.stderr, /안전하게 읽지 못해/);
        assert.match(r.stderr, /일반 파일이 아닙니다/);
      } else {
        // 사본을 만든 뒤 바뀜 → 사본(그때의 내용)을 읽는다
        assert.match(r.stdout, /units=nginx reboot=0/);
      }
      assert.deepEqual(leftovers(env), [], '임시 폴더를 남기지 않는다');
    }
  });

  test(`RZ-REV-03 ② (${m.name}) vp_rma_env_request — 확인 뒤 링크로 바꿔치기해도 따라 읽지 않는다(링크 대상의 RMA 요청 값을 쓰지 않는다)`, () => {
    const env = mkEnv();
    const f = path.join(env.cfg, 'portal.env');
    fs.writeFileSync(f, 'PORT=4000\n', { mode: 0o644 });
    const evil = path.join(env.out, 'root-owned.conf');
    fs.writeFileSync(evil, 'RMA_SERVICE_UNITS=debug-shell\nRMA_ALLOW_REBOOT=true\n', { mode: 0o644 });
    fs.chmodSync(evil, 0o644);
    const script = `SWAP_F="$1"; SWAP_TO="$2"; SWAP_PATS=('vp_cfg_snap "' 'exec {fd}')\n${swapTrap('link')}\n${RMA_READ}`;
    const r = bash(script, [f, evil], { ...m.env, VP_CFG_COPY_TIMEOUT: '5' });
    done(r);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.lstatSync(f).isSymbolicLink(), true, '트랩이 실제로 링크로 바꿨다');
    assert.match(r.stdout, /root=0 units= reboot=0/, '예전에는 링크를 따라가 root 소유 파일이면 그 값으로 sudoers 를 넓혔다');
    assert.match(r.stderr, /심볼릭 링크/);
  });

  test(`RZ-REV-03 ③ (${m.name}) vp_rma_env_request — 바꿔치기가 없으면 사본으로 읽은 결과가 직접 읽은 결과와 같다(소유자·권한 판정 · 쉼표·마지막 줄)`, () => {
    const env = mkEnv();
    const cases = [
      ['a', 'RMA_SERVICE_UNITS=nginx, app@x\nRMA_ALLOW_REBOOT=true\n', 0o644],
      ['b', 'RMA_SERVICE_UNITS=one\nRMA_SERVICE_UNITS=two,three', 0o664],
      ['c', 'PORT=4000\n', 0o600],
      ['d', '', 0o640],
    ];
    const files = cases.map(([n, body, mode]) => { const f = path.join(env.cfg, `${n}.env`); fs.writeFileSync(f, body, { mode }); fs.chmodSync(f, mode); return f; });
    const script = String.raw`for f in "$@"; do vp_rma_env_request "$f"; echo "S $VP_RMA_ENV_ROOT|$VP_RMA_UNITS|$VP_RMA_REBOOT"; done
unset -f vp_cfg_snap
for f in "$@"; do vp_rma_env_request "$f"; echo "D $VP_RMA_ENV_ROOT|$VP_RMA_UNITS|$VP_RMA_REBOOT"; done`;
    const r = bash(script, files, m.env);
    done(r);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    const S = lines.filter((l) => l.startsWith('S ')).map((l) => l.slice(2));
    const D = lines.filter((l) => l.startsWith('D ')).map((l) => l.slice(2));
    assert.equal(S.length, 4);
    assert.deepEqual(S, D, '사본 경로 = 직접 읽기(같은 판정)');
    assert.equal(S[0], `${IS_ROOT ? 1 : 0}|nginx  app@x|1`);
    assert.equal(S[1], '0|two three|0', '그룹 쓰기면 믿지 않는다 · 마지막 줄(줄바꿈 없음)');
    assert.equal(r.stderr, '', '정상 파일에는 아무것도 알리지 않는다');
    assert.deepEqual(leftovers(env), []);
  });
}

test('RZ-REV-03 ④ vp_rma_env_request — 사본 상한(VP_CFG_MAX_BYTES)을 넘는 portal.env 는 요청 값을 읽지 않고 그 사실을 알린다(넓히지 않는 쪽)', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'portal.env');
  fs.writeFileSync(f, `RMA_SERVICE_UNITS=nginx\n#${'x'.repeat(200)}\n`, { mode: 0o644 });
  const r = bash(RMA_READ, [f], { VP_CFG_NODE: process.execPath, VP_CFG_MAX_BYTES: '64' });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /root=0 units= reboot=0/);
  assert.match(r.stderr, /상한/);
  assert.match(r.stderr, /RMA sudoers 요청 값.*읽지 않았습니다/);
  assert.deepEqual(leftovers(env), []);
});

/* ── RZ-REV-03 6-0-1 구간 ──────────────────────────────────────────────────────────────────────────────── */
const RMA_REGION = region('# 6-0-1) RMA 인스턴스 기동', '# 6-1)');
function runRmaRegion(env, body, { trap = null, pats = [], to = '', extraEnv = {} } = {}) {
  const penv = path.join(env.cfg, 'portal.env');
  fs.writeFileSync(penv, body, { mode: 0o640 });
  const log = path.join(env.d, 'systemctl.log');
  fs.writeFileSync(log, '');
  assert.ok(pats.every((p) => !p.includes("'")), '패턴은 홑따옴표 배열에 들어간다 — 홑따옴표를 쓰면 글자가 빠져 트랩이 걸리지 않는다');
  const pre = trap ? `SWAP_F="$PENV"; SWAP_TO="$4"; SWAP_PATS=(${pats.map((p) => `'${p}'`).join(' ')})\n${swapTrap(trap)}\n` : '';
  const script = `systemctl() { echo "systemctl $*" >> "$LOG"; }\nCONFIG_DIR="$1"; SERVICE_USER="$2"; PENV="$CONFIG_DIR/portal.env"; PENV_ST=0; LOG="$3"\n${pre}${RMA_REGION}`;
  const r = bash(script, [env.cfg, 'nobody', log, to], { VP_CFG_COPY_TIMEOUT: '5', ...extraEnv });
  return { ...r, calls: fs.readFileSync(log, 'utf8'), penv };
}

for (const m of MODES) {
  test(`RZ-REV-03 ⑤ (${m.name}) 6-0-1 — portal.env 를 확인 뒤 FIFO 로 바꿔치기해도 설치가 멈추지 않는다 · RMA 를 기동하지 않고 알린다`, () => {
    const env = mkEnv();
    const r = runRmaRegion(env, 'RMA_ENABLED=true\nRMA_INSTANCES=x1\n', { trap: 'fifo', pats: ['vp_cfg_snap "', '^RMA_ENABLED=true'], extraEnv: m.env });
    done(r);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.lstatSync(r.penv).isFIFO(), true, '트랩이 실제로 바꿔치기했다');
    assert.equal(r.calls, '', 'RMA 인스턴스를 기동하지 않는다');
    assert.match(r.stdout + r.stderr, /안전하게 읽지 못해\(위 안내\) RMA 설정/);
    assert.deepEqual(leftovers(env), []);
  });

  test(`RZ-REV-03 ⑥ (${m.name}) 6-0-1 — 링크로 바꿔치기해도 링크 대상의 RMA_ENABLED·RMA_INSTANCES 를 쓰지 않는다 · 바꿔치기가 없으면 사본을 읽어 예전처럼 판정한다`, () => {
    const env = mkEnv();
    const evil = path.join(env.out, 'other.conf');
    fs.writeFileSync(evil, 'RMA_ENABLED=true\nRMA_INSTANCES=evil\n');
    const r = runRmaRegion(env, 'PORT=4000\n', { trap: 'link', pats: ['vp_cfg_snap "', '^RMA_ENABLED=true'], to: evil, extraEnv: m.env });
    done(r);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.lstatSync(r.penv).isSymbolicLink(), true);
    assert.equal(r.calls, '');
    assert.doesNotMatch(r.stdout, /evil/);
    assert.equal(fs.existsSync(path.join(env.cfg, 'rma-evil.env')), false);
    // 바꿔치기 없음 — 사본에서 읽은 값으로 예전과 같이 판정(형식이 틀린 이름은 건너뛴다 · RMA_ENABLED 가 없으면 아무 일도 없다)
    const env2 = mkEnv();
    const r2 = runRmaRegion(env2, 'RMA_ENABLED=true\nRMA_INSTANCES=-bad\n', { extraEnv: m.env });
    done(r2);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /RMA_INSTANCES 항목 '-bad' 은 이름 형식/);
    assert.deepEqual(leftovers(env2), []);
    const env3 = mkEnv();
    const r3 = runRmaRegion(env3, 'PORT=4000\n', { extraEnv: m.env });
    done(r3);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(r3.stdout + r3.stderr, '', '평소(RMA 꺼짐)에는 아무것도 출력하지 않는다');
    assert.deepEqual(leftovers(env3), []);
  });
}

/* ── 소스 규약 ─────────────────────────────────────────────────────────────────────────────────────────── */
test('FH ⑦ install.sh — 6-0-1 이 portal.env 경로를 grep 으로 다시 열지 않는다 · vp_rma_env_request 는 chown -R 전에 그대로 불린다', () => {
  const body = INSTALL.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(RMA_REGION.replace(/^\s*#.*$/gm, ''), /grep[^\n]*"\$PENV"/, '6-0-1 에서 원본 경로를 grep 하지 않는다');
  assert.ok(body.indexOf('vp_rma_env_request "$CONFIG_DIR/portal.env"') > 0);
  assert.ok(body.indexOf('vp_rma_env_request "$CONFIG_DIR/portal.env"') < body.indexOf('chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"'));
  const snapFn = shellFn(INSTALL, 'vp_cfg_snap');
  assert.match(snapFn, /"--attributes-only","--preserve=all","--","\/dev\/fd\/3"/, 'node 경로는 연 fd(/dev/fd/3)에서 속성을 옮긴다 — 경로를 다시 찾지 않는다');
  assert.match(snapFn, /O_NOFOLLOW\|C\.O_NONBLOCK/, '단일 열기(O_NOFOLLOW|O_NONBLOCK)는 그대로');
  assert.doesNotMatch(snapFn, /cp -P --preserve=all -- "\$src" "\$dst" 2>\/dev\/null/, 'cp 폴백이 속성 실패 문구를 버리지 않는다');
});
