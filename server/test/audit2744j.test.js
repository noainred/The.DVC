/**
 * v2.744 감사 GJ(패키징) 회귀 — INJPKG-01 · LEFT-05.
 *
 *  INJPKG-01 install.sh 가 CONFIG_DIR(서비스 계정 소유 0750) 안의 파일 — rma-<인스턴스>.env · settings-owners.txt · portal.env ·
 *            이전 설정(users.json 등) · release-signing-keys.conf — 을 root 로 경로 그대로 chown·chmod·cat >·printf >·sed -i·>> 해서
 *            서비스 계정이 심은 심볼릭 링크를 따라갔다. 재현: rma-default.env → root:root 0600 파일 링크 → 설치 뒤 그 파일이
 *            서비스 계정 소유·0640(로컬 권한 상승). 이제 lstat 판정(vp_cfg_state) + root 전용 임시 폴더에서 맞춘 뒤 rename(vp_cfg_*).
 *  LEFT-05   Windows README 가 설치 폴더 ACL 을 좁히는 단계 없이 C:\ 바로 아래를 예시로 들었다 — 안내·확인 명령을 적는다(문서).
 *
 * ⚠ install.sh 는 통째로 실행하지 않는다(시스템을 바꾼다). 함수는 꺼내 실제 bash 로 부르고, 설치 단계(4·5·6-0-1)는 그 구간의 원문을
 *   그대로 꺼내 가짜 CONFIG_DIR 위에서 돌린다(systemctl 은 빈 함수로 막는다) — 기준 판본(9a2ef1c)의 구간으로 돌리면 링크 대상이
 *   바뀌어 실패한다(변이 검증). 소유자를 다른 계정으로 바꾸는 시나리오는 root 일 때만 돈다(비 root 는 건너뛴 사실을 남긴다).
 * 시각은 쓰지 않는다(Date.now() 비의존).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INSTALL = rd('packaging/offline/install.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const idOf = (flag, u) => { try { return Number(execFileSync('id', [flag, u], { encoding: 'utf8' }).trim()); } catch { return null; } };
const sh = (args) => { try { return execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim(); } catch { return ''; } };
// 서비스 계정 — install.sh 는 '<계정>:<계정>' 으로 chown 하므로 같은 이름의 그룹이 있어야 한다(daemon:daemon 이 흔하다).
const SVC = IS_ROOT ? 'daemon' : sh(['id', '-un']);
const SVC_UID = idOf('-u', SVC);
const SVC_GROUP_OK = !!sh(['getent', 'group', SVC]);
const ROOT_ONLY = !IS_ROOT || SVC_UID == null || !SVC_GROUP_OK
  ? 'root 권한과 daemon:daemon 계정이 필요한 시나리오(소유자를 다른 계정으로 바꾸기·root 소유 파일) — 이 환경에서는 건너뜀'
  : false;
const SVC_OK = SVC_UID == null || !SVC_GROUP_OK ? `'${SVC}:${SVC}' 계정·그룹이 없어 건너뜀` : false;
const ME = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744j-'));
after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ } });
let seq = 0;
/** 가짜 설치 환경: <d>/etc/cfg(= CONFIG_DIR, 부모 <d>/etc 는 root 전용 임시 폴더 자리) · <d>/outside(링크 대상) */
function mkEnv() {
  const d = path.join(BASE, `e${++seq}`);
  fs.mkdirSync(path.join(d, 'etc', 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(d, 'outside'), { recursive: true });
  return { d, cfg: path.join(d, 'etc', 'cfg'), out: path.join(d, 'outside'), etc: path.join(d, 'etc') };
}
/** 링크 대상 '비밀 파일' — root 면 root:root 0600, 아니면 내 소유 0600. 내용·소유자·권한을 기억한다. */
function secret(dir, name = 'secret') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'TOP=SECRET\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}
const snap = (f) => { const s = fs.statSync(f); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, body: fs.readFileSync(f, 'utf8') }; };
const leftovers = (env) => fs.readdirSync(env.etc).filter((n) => n.startsWith('.vmware-portal-cfg.'));

/** 셸 스크립트에서 이름의 함수 정의를 꺼낸다(맨 앞 `name() {` ~ 줄 첫머리 `}`). 없으면 null. */
function shellFn(text, name) {
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}
/** 맨 앞 열의 함수 정의 전부(판본마다 있는 함수가 다르다 — 기준 판본으로 되돌려도 구간이 돌게). */
function allFns(text) {
  const names = [...text.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{$/gm)].map((m) => m[1]);
  return names.map((n) => shellFn(text, n)).filter(Boolean).join('\n');
}
/** install.sh 의 설치 단계 원문(시작 표지 줄 ~ 끝 표지 줄 앞). */
function region(start, end) {
  const a = INSTALL.indexOf(start);
  const b = INSTALL.indexOf(end, a + 1);
  assert.ok(a > 0 && b > a, `install.sh 구간을 찾지 못했다: ${start} ~ ${end}`);
  return INSTALL.slice(INSTALL.lastIndexOf('\n', a) + 1, b);
}
const FNS = allFns(INSTALL);
// v2.744 회귀 검토 GJ-R2: 사본 만들기(cp -a — 재귀)를 vp_cfg_snap 하나로 바꿨다(audit2744rz.test.js 가 그 동작을 고정한다).
const CFG_FNS = ['vp_cfg_state', 'vp_cfg_tmp', 'vp_cfg_snap', 'vp_cfg_place', 'vp_cfg_create', 'vp_cfg_copy_new', 'vp_cfg_fix', 'vp_cfg_set_line', 'vp_rma_env_file', 'vp_cfg_settings_owners'];
const bash = (script, args = [], opt = {}) => spawnSync('bash', ['-c', `set -euo pipefail\n${FNS}\n${script}`, '_', ...args], { encoding: 'utf8', ...opt });
const rc = (r) => r.status;

/* ── INJPKG-01 ① 함수가 있다 · 문법 ───────────────────────────────────────────────────────────────────── */
test('INJPKG-01 ① install.sh 에 CONFIG_DIR 안전 쓰기 함수가 있고 bash 문법이 맞다(uninstall.sh 도)', () => {
  for (const n of CFG_FNS) assert.ok(shellFn(INSTALL, n), `install.sh ${n}`);
  for (const f of ['packaging/offline/install.sh', 'packaging/offline/uninstall.sh']) {
    const r = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

/* ── ② vp_cfg_state — lstat 판정 ──────────────────────────────────────────────────────────────────────── */
test('INJPKG-01 ② vp_cfg_state — 일반 파일 0 · 없음 1 · 링크(매달린 링크 포함)·폴더·하드 링크 2(알린다)', () => {
  const env = mkEnv();
  const t = secret(env.out);
  fs.writeFileSync(path.join(env.cfg, 'plain'), 'x');
  fs.symlinkSync(t, path.join(env.cfg, 'link'));
  fs.symlinkSync(path.join(env.out, 'nope'), path.join(env.cfg, 'dangling'));
  fs.mkdirSync(path.join(env.cfg, 'dir'));
  fs.writeFileSync(path.join(env.cfg, 'h1'), 'x');
  fs.linkSync(path.join(env.cfg, 'h1'), path.join(env.cfg, 'h2'));
  const st = (n) => bash('vp_cfg_state "$1"', [path.join(env.cfg, n)]);
  assert.equal(rc(st('plain')), 0);
  assert.equal(rc(st('absent')), 1);
  for (const n of ['link', 'dangling', 'dir', 'h1']) {
    const r = st(n);
    assert.equal(rc(r), 2, n);
    assert.match(r.stderr, /⚠/, `${n} 는 알린다`);
  }
  assert.match(st('link').stderr, /심볼릭 링크/);
  assert.match(st('h1').stderr, /하드 링크/);
});

/* ── ③ vp_cfg_create — 링크를 따라 만들지 않는다 ─────────────────────────────────────────────────────── */
test('INJPKG-01 ③ vp_cfg_create — 없으면 내용·소유자·권한을 맞춰 만들고, 그 자리에 링크가 있으면(그사이 생긴 것 포함) 따라가지 않는다', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'new.env');
  const ok = bash('printf "A=1\\n" | vp_cfg_create "$1" "$2" 0640', [f, ME]);
  assert.equal(rc(ok), 0, ok.stderr);
  const s = snap(f);
  assert.equal(s.body, 'A=1\n');
  assert.equal(s.mode, 0o640);
  assert.equal(fs.lstatSync(f).isSymbolicLink(), false);
  assert.deepEqual(leftovers(env), [], '임시 폴더를 남기지 않는다');
  // 매달린 링크 — 예전 'cat >'·'printf >' 는 링크 대상 경로에 root 소유 파일을 새로 만들었다
  const dangling = path.join(env.out, 'planted');
  fs.symlinkSync(dangling, path.join(env.cfg, 'd.env'));
  const r1 = bash('printf "B=2\\n" | vp_cfg_create "$1" "$2" 0640', [path.join(env.cfg, 'd.env'), ME]);
  assert.equal(rc(r1), 2, r1.stderr);
  assert.equal(fs.existsSync(dangling), false, '링크 대상 경로에 파일을 만들지 않는다');
  assert.equal(fs.lstatSync(path.join(env.cfg, 'd.env')).isSymbolicLink(), true, '링크는 그대로(지우지도 따라가지도 않는다)');
  // 있는 파일을 가리키는 링크 — 대상 내용·권한 그대로
  const t = secret(env.out);
  const before = snap(t);
  fs.symlinkSync(t, path.join(env.cfg, 'e.env'));
  const r2 = bash('printf "C=3\\n" | vp_cfg_create "$1" "$2" 0640', [path.join(env.cfg, 'e.env'), ME]);
  assert.equal(rc(r2), 2);
  assert.deepEqual(snap(t), before);
  assert.deepEqual(leftovers(env), []);
});

/* ── ④ vp_cfg_fix — 경로에 chown·chmod 하지 않는다 ──────────────────────────────────────────────────── */
test('INJPKG-01 ④ vp_cfg_fix — 일반 파일은 소유자·권한을 맞추고(이미 맞으면 그대로), 링크면 대상을 건드리지 않는다', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'r.env');
  fs.writeFileSync(f, 'RMA_PASSWORD=x\n', { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  const r = bash('vp_cfg_fix "$1" "$2" 0640', [f, ME]);
  assert.equal(rc(r), 0, r.stderr);
  assert.equal(snap(f).mode, 0o640);
  assert.equal(snap(f).body, 'RMA_PASSWORD=x\n', '내용은 그대로');
  const ino = fs.statSync(f).ino;
  assert.equal(rc(bash('vp_cfg_fix "$1" "$2" 0640', [f, ME])), 0);
  assert.equal(fs.statSync(f).ino, ino, '이미 맞으면 다시 쓰지 않는다');
  // 링크 — 예전 'chmod 0640 <경로>' 는 링크를 따라가 대상 권한을 바꿨다
  const t = secret(env.out);
  const before = snap(t);
  fs.symlinkSync(t, path.join(env.cfg, 'l.env'));
  const rl = bash('vp_cfg_fix "$1" "$2" 0640', [path.join(env.cfg, 'l.env'), ME]);
  assert.equal(rc(rl), 2, rl.stderr);
  assert.deepEqual(snap(t), before, '링크 대상의 소유자·권한·내용 그대로');
  // 원래 소유 uid 조건 — 다른 소유자면 맞추지 않는다(호스트 키 파일: root 소유일 때만)
  const other = path.join(env.cfg, 'o.conf');
  fs.writeFileSync(other, 'k', { mode: 0o600 });
  const ro = bash('vp_cfg_fix "$1" 0:0 go-w,o+r 4242424', [other]);
  assert.equal(rc(ro), 2);
  assert.equal(snap(other).mode, 0o600);
  assert.deepEqual(leftovers(env), []);
});

/* ── ⑤ vp_cfg_set_line — portal.env 의 CONFIG_DIR 줄 ─────────────────────────────────────────────────── */
test('INJPKG-01 ⑤ vp_cfg_set_line — 예전 grep||echo>>·sed -i 와 같은 결과 · 바뀐 것 없으면 쓰지 않는다 · 링크면 대상 그대로', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'portal.env');
  fs.writeFileSync(f, 'PORT=4000\nCONFIG_DIR=/old\n# CONFIG_DIR=/주석\nCONFIG_DIR=/old2\nX=1', { mode: 0o640 });
  fs.chmodSync(f, 0o640);
  const r = bash('vp_cfg_set_line "$1" CONFIG_DIR /etc/vmware-portal', [f]);
  assert.equal(rc(r), 0, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), 'PORT=4000\nCONFIG_DIR=/etc/vmware-portal\n# CONFIG_DIR=/주석\nCONFIG_DIR=/etc/vmware-portal\nX=1\n');
  assert.equal(snap(f).mode, 0o640, '권한은 원본 그대로');
  const ino = fs.statSync(f).ino;
  assert.equal(rc(bash('vp_cfg_set_line "$1" CONFIG_DIR /etc/vmware-portal', [f])), 0);
  assert.equal(fs.statSync(f).ino, ino, '이미 맞으면 다시 쓰지 않는다');
  // 줄이 없으면 끝에 붙인다 — 마지막 줄에 줄바꿈이 없어도 이어 붙이지 않는다(예전 'echo >>' 는 'X=1CONFIG_DIR=' 가 됐다)
  const g = path.join(env.cfg, 'b.env');
  fs.writeFileSync(g, 'PORT=1\nX=1');
  assert.equal(rc(bash('vp_cfg_set_line "$1" CONFIG_DIR /c', [g])), 0);
  assert.equal(fs.readFileSync(g, 'utf8'), 'PORT=1\nX=1\nCONFIG_DIR=/c\n');
  // 링크
  const t = secret(env.out);
  const before = snap(t);
  fs.symlinkSync(t, path.join(env.cfg, 'l.env'));
  assert.equal(rc(bash('vp_cfg_set_line "$1" CONFIG_DIR /c', [path.join(env.cfg, 'l.env')])), 2);
  assert.deepEqual(snap(t), before);
  assert.equal(fs.lstatSync(path.join(env.cfg, 'l.env')).isSymbolicLink(), true);
  assert.deepEqual(leftovers(env), []);
});

/* ── ⑥ 설치 단계 6-0-1(RMA 인스턴스) — 재현 시나리오 그대로 ─────────────────────────────────────────── */
const RMA_REGION = region('# 6-0-1) RMA 인스턴스 기동', '# 6-1)');
function runRma(env, { instances = 'default' } = {}) {
  fs.writeFileSync(path.join(env.cfg, 'portal.env'), `RMA_ENABLED=true\nRMA_INSTANCES=${instances}\n`);
  const script = `systemctl() { echo "systemctl $*" >> "$LOG"; }\nCONFIG_DIR="$1"; SERVICE_USER="$2"; PENV="$CONFIG_DIR/portal.env"; PENV_ST=0; LOG="$3"\n${RMA_REGION}`;
  const log = path.join(env.d, 'systemctl.log');
  fs.writeFileSync(log, '');
  const r = bash(script, [env.cfg, SVC, log]);
  return { ...r, calls: fs.readFileSync(log, 'utf8') };
}

test('INJPKG-01 ⑥ 6-0-1 — rma-<인스턴스>.env 가 남의 파일을 가리키는 링크면 그 파일의 소유자·권한을 바꾸지 않고 인스턴스도 기동하지 않는다', () => {
  const env = mkEnv();
  const t = secret(env.out);
  const before = snap(t);
  fs.symlinkSync(t, path.join(env.cfg, 'rma-default.env'));
  const r = runRma(env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(t), before, '링크 대상(root 소유 0600 파일)의 소유자·권한·내용 그대로 — 예전에는 서비스 계정 소유·0640 이 됐다');
  assert.equal(fs.lstatSync(path.join(env.cfg, 'rma-default.env')).isSymbolicLink(), true);
  assert.doesNotMatch(r.calls, /vmware-portal-rma@default/, '링크를 env 로 읽게 될 인스턴스를 기동하지 않는다');
  assert.match(r.stdout + r.stderr, /심볼릭 링크/);
});

test('INJPKG-01 ⑥-b 6-0-1 — 매달린 링크면 링크 대상 경로에 파일을 만들지 않는다', () => {
  const env = mkEnv();
  const planted = path.join(env.out, 'cron-like');
  fs.symlinkSync(planted, path.join(env.cfg, 'rma-default.env'));
  const r = runRma(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(planted), false, '예전 printf > 는 링크 대상에 root 가 파일을 만들고 서비스 계정에 넘겼다');
  assert.deepEqual(leftovers(env), []);
});

test('INJPKG-01 ⑥-c 6-0-1 — 정상 경로: 없으면 서비스 계정 소유·0640 으로 만들고 기동 · 있으면 권한만 맞추고 기동', { skip: SVC_OK }, () => {
  const env = mkEnv();
  fs.writeFileSync(path.join(env.cfg, 'rma-b.env'), 'RMA_INSTANCE=b\nRMA_PASSWORD=p\n', { mode: 0o644 });
  fs.chmodSync(path.join(env.cfg, 'rma-b.env'), 0o644);
  const r = runRma(env, { instances: 'a b' });
  assert.equal(r.status, 0, r.stderr);
  const a = snap(path.join(env.cfg, 'rma-a.env'));
  assert.equal(a.body, 'RMA_INSTANCE=a\nRMA_PRIORITY=100\n');
  assert.equal(a.mode, 0o640);
  assert.equal(a.uid, SVC_UID);
  const b = snap(path.join(env.cfg, 'rma-b.env'));
  assert.equal(b.mode, 0o640, '기존 파일 권한을 0640 으로');
  assert.equal(b.body, 'RMA_INSTANCE=b\nRMA_PASSWORD=p\n', '내용은 그대로');
  assert.equal(b.uid, SVC_UID);
  assert.match(r.calls, /restart vmware-portal-rma@a/);
  assert.match(r.calls, /restart vmware-portal-rma@b/);
  assert.deepEqual(leftovers(env), []);
});

/* ── ⑦ 설치 단계 4(Config) — portal.env · settings-owners.txt · 설정 이전 ───────────────────────────── */
const CFG_REGION = region('# 4) Config', '# 5) Permissions');
function runConfig(env, { bak = '' } = {}) {
  const prefix = path.join(env.d, 'prefix');
  fs.mkdirSync(path.join(prefix, 'runtime', 'node', 'bin'), { recursive: true });
  const node = path.join(prefix, 'runtime', 'node', 'bin', 'node');
  fs.writeFileSync(node, '#!/bin/sh\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o755 });
  fs.chmodSync(node, 0o755);
  const appDst = path.join(env.d, 'app');
  fs.mkdirSync(path.join(appDst, 'server', 'config'), { recursive: true });
  const script = `CONFIG_DIR="$1"; SCRIPT_DIR="$2"; PREFIX="$3"; PORT=4711; BAK="$4"; APP_DST="$5"\n${CFG_REGION}`;
  return bash(script, [env.cfg, path.join(ROOT, 'packaging', 'offline'), prefix, bak, appDst]);
}

test('INJPKG-01 ⑦ 4) — portal.env 가 링크면 대상에 덧붙이거나(>>) 그 내용을 CONFIG_DIR 로 옮기지(sed -i) 않는다 · settings-owners.txt 매달린 링크로 파일을 만들지 않는다', () => {
  const env = mkEnv();
  const t = secret(env.out, 'other.env');
  const before = snap(t);
  fs.symlinkSync(t, path.join(env.cfg, 'portal.env'));
  const planted = path.join(env.out, 'owners-planted');
  fs.symlinkSync(planted, path.join(env.cfg, 'settings-owners.txt'));
  const r = runConfig(env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(t), before, '링크 대상에 CONFIG_DIR= 줄을 덧붙이지 않는다');
  assert.equal(fs.lstatSync(path.join(env.cfg, 'portal.env')).isSymbolicLink(), true, 'sed -i 처럼 링크 자리에 대상 내용을 담은 새 파일을 만들지 않는다');
  assert.equal(fs.existsSync(planted), false, '링크 대상 경로에 settings-owners 를 만들지 않는다');
  assert.match(r.stdout + r.stderr, /심볼릭 링크/);
  assert.deepEqual(leftovers(env), []);
});

test('INJPKG-01 ⑦-b 4) — 설정 이전: CONFIG_DIR 쪽이 매달린 링크면 cp 로 따라 쓰지 않고(설치를 멈추지도 않는다) 건너뛴다', () => {
  const env = mkEnv();
  const bak = path.join(env.d, 'bak');
  fs.mkdirSync(path.join(bak, 'server', 'config'), { recursive: true });
  fs.writeFileSync(path.join(bak, 'server', 'config', 'users.json'), '{"users":[]}');
  fs.writeFileSync(path.join(env.cfg, 'portal.env'), 'CONFIG_DIR=/x\n');
  const planted = path.join(env.out, 'users-planted');
  fs.symlinkSync(planted, path.join(env.cfg, 'users.json'));
  const r = runConfig(env, { bak });
  assert.equal(r.status, 0, `설치 단계가 끝까지 돈다: ${r.stderr}`);
  assert.equal(fs.existsSync(planted), false);
  assert.equal(fs.lstatSync(path.join(env.cfg, 'users.json')).isSymbolicLink(), true);
});

test('INJPKG-01 ⑦-c 4) — 정상 경로: 새 portal.env(AUTH_SECRET·PORT·CONFIG_DIR · root 0640) · settings-owners(0600) · 설정 이전', { skip: IS_ROOT ? false : 'root 소유(0:0)로 만드는 경로 — 비 root 는 chown 0 을 할 수 없어 건너뜀' }, () => {
  const env = mkEnv();
  const bak = path.join(env.d, 'bak');
  fs.mkdirSync(path.join(bak, 'server', 'config'), { recursive: true });
  fs.writeFileSync(path.join(bak, 'server', 'config', 'vcenters.json'), '[1]');
  const r = runConfig(env, { bak });
  assert.equal(r.status, 0, r.stderr);
  const p = snap(path.join(env.cfg, 'portal.env'));
  assert.match(p.body, /^AUTH_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef$/m);
  assert.match(p.body, /^PORT=4711$/m);
  assert.match(p.body, new RegExp(`^CONFIG_DIR=${env.cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(p.mode, 0o640);
  assert.equal(p.uid, 0);
  const o = snap(path.join(env.cfg, 'settings-owners.txt'));
  assert.equal(o.mode, 0o600);
  assert.match(o.body, /noainred/);
  assert.equal(fs.readFileSync(path.join(env.cfg, 'vcenters.json'), 'utf8'), '[1]');
  assert.deepEqual(leftovers(env), []);
  // 두 번째 실행(업그레이드) — 이미 맞는 파일은 다시 쓰지 않는다
  const ino = fs.statSync(path.join(env.cfg, 'portal.env')).ino;
  const r2 = runConfig(env, { bak });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.statSync(path.join(env.cfg, 'portal.env')).ino, ino);
  assert.match(r2.stdout, /기존 환경설정 유지/);
});

/* ── ⑧ 설치 단계 5(Permissions) — 호스트 키 파일: 확인 뒤 chown -R 동안 링크로 바뀌어도 따라가지 않는다 ─ */
const PERM_REGION = region('# 5) Permissions', '# SELinux 라벨 처리');
function runPerm(env, { swapTo = null } = {}) {
  const prefix = path.join(env.d, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });
  // 서비스 계정이 chown -R 이 도는 사이(큰 트리면 수 초) 호스트 키 파일을 링크로 바꾸는 것을 흉내 낸다
  const swap = swapTo
    ? `eval "orig_$(declare -f vp_chown_tree_except)"\nvp_chown_tree_except() { orig_vp_chown_tree_except "$@"; rm -f -- "$CONFIG_DIR/release-signing-keys.conf"; ln -s "$SWAP" "$CONFIG_DIR/release-signing-keys.conf"; }`
    : '';
  const script = `CONFIG_DIR="$1"; SERVICE_USER="$2"; PREFIX="$3"; SWAP="$4"\n${swap}\n${PERM_REGION}`;
  return bash(script, [env.cfg, SVC, prefix, swapTo || '']);
}

test('INJPKG-01 ⑧ 5) — root 소유 호스트 키 파일: 정상이면 go-w,o+r 로 맞추고 root 소유 유지(예전과 같은 결과)', { skip: ROOT_ONLY }, () => {
  const env = mkEnv();
  const hk = path.join(env.cfg, 'release-signing-keys.conf');
  fs.writeFileSync(hk, '{"keys":[]}', { mode: 0o620 });
  fs.chmodSync(hk, 0o620);
  fs.writeFileSync(path.join(env.cfg, 'portal.env'), 'X=1\n');
  const r = runPerm(env);
  assert.equal(r.status, 0, r.stderr);
  const s = snap(hk);
  assert.equal(s.uid, 0);
  assert.equal(s.gid, 0);
  assert.equal(s.mode, 0o604, '0620 → go-w → 0600 → o+r → 0604');
  assert.equal(s.body, '{"keys":[]}');
  assert.equal(fs.statSync(path.join(env.cfg, 'portal.env')).uid, SVC_UID, '나머지는 서비스 계정 소유');
  assert.deepEqual(leftovers(env), []);
});

test('INJPKG-01 ⑧-b 5) — 확인과 권한 맞추기 사이에 호스트 키 파일이 /etc/shadow 같은 파일 링크로 바뀌어도 그 파일을 모두가 읽게 만들지 않는다', { skip: ROOT_ONLY }, () => {
  const env = mkEnv();
  const hk = path.join(env.cfg, 'release-signing-keys.conf');
  fs.writeFileSync(hk, '{"keys":[]}', { mode: 0o644 });
  fs.writeFileSync(path.join(env.cfg, 'portal.env'), 'X=1\n');
  const t = secret(env.out, 'shadow-like');
  const before = snap(t);
  const r = runPerm(env, { swapTo: t });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(t), before, "예전 'chown 0:0 · chmod go-w · chmod o+r' 은 링크를 따라가 0600 → 0604(모두 읽기)로 만들었다");
  assert.match(r.stdout + r.stderr, /맞추지 않았습니다/);
});

/* ── ⑨ 소스 규약 — CONFIG_DIR 파일에 경로 그대로 쓰는 명령이 남아 있지 않다 ─────────────────────────── */
test('INJPKG-01 ⑨ install.sh 본문(함수 정의 밖)에 CONFIG_DIR 파일 경로 그대로의 chown·chmod·>·>>·sed -i·cp·install 이 없다', () => {
  const body = INSTALL.replace(/^\s*#.*$/gm, '');
  const outside = CFG_FNS.reduce((s, n) => { const f = shellFn(s, n); assert.ok(f, `본문에서 ${n} 정의를 찾지 못했다`); return s.replace(f, ''); }, body);
  for (const n of CFG_FNS) assert.equal(shellFn(outside, n), null, `${n} 정의를 뺐다`);
  const bad = [
    /chmod [^\n]*"\$CONFIG_DIR\/[^"\n]+"/, /chown [^\n]*"\$CONFIG_DIR\/[^"\n]+"/,
    />>? *"\$CONFIG_DIR\/[^"\n]+"/, /sed -i[^\n]*"\$CONFIG_DIR\//, /cp -a "\$src" "\$CONFIG_DIR/, /install -m [0-7]+ [^\n]*"\$CONFIG_DIR\//,
    /chmod (go-w|o\+r) -- "\$HOSTKEYS"/,
  ];
  for (const re of bad) assert.doesNotMatch(outside, re, `경로 그대로의 쓰기: ${re}`);
  // 쓰는 곳은 전부 함수를 거친다
  assert.match(outside, /vp_rma_env_file "\$CONFIG_DIR" "\$inst" "\$SERVICE_USER"/);
  assert.match(outside, /vp_cfg_settings_owners "\$CONFIG_DIR"/);
  assert.match(outside, /vp_cfg_set_line "\$PENV" CONFIG_DIR "\$CONFIG_DIR"/);
  assert.match(outside, /vp_cfg_fix "\$HOSTKEYS" 0:0 go-w,o\+r 0/);
});

/* ── LEFT-05 ─────────────────────────────────────────────────────────────────────────────────────────── */
test('LEFT-05 Windows README — 설치·설정 폴더 권한을 좁히는 안내(icacls 상속 해제 · SYSTEM·Administrators 만)와 확인 명령 · 공백 없는 예시 경로 · 미확인 고지', () => {
  const doc = rd('packaging/windows/README-WINDOWS.md');
  for (const dir of ['C:\\vmware-portal', 'C:\\ProgramData\\vmware-portal']) {
    const grant = doc.split('\n').find((l) => l.includes(`icacls ${dir} /inheritance:r`));
    assert.ok(grant, `${dir} 상속 해제`);
    assert.match(grant, /\/grant:r "\*S-1-5-18:\(OI\)\(CI\)F"/, 'SYSTEM 전체 권한(따옴표 — PowerShell 이 괄호를 식으로 읽지 않게)');
    assert.match(grant, /"\*S-1-5-32-544:\(OI\)\(CI\)F"/, 'Administrators 전체 권한');
    assert.doesNotMatch(grant, /S-1-5-32-545|S-1-5-11|S-1-1-0/, '일반 사용자·Authenticated Users·Everyone 에게 주지 않는다(토큰이 든다)');
    assert.ok(doc.includes(`icacls ${dir}\\* /reset /T /C`), `${dir} 안 파일을 새 권한으로 맞춘다`);
    assert.match(doc, new RegExp(`^\\s*icacls ${dir.replace(/\\/g, '\\\\')}\\s*$`, 'm'), `${dir} 확인 명령`);
  }
  assert.match(doc, /경로에 공백을 넣지 마세요/, '예시 경로에 공백을 넣지 않는 이유');
  assert.match(doc, /실기로 확인하지 못했습니다/, 'Windows 실기로 확인하지 못했다는 사실');
  // v2.744 회귀 검토 GJ-R3: 좁힌 권한과 맞물리는 편집 방법(관리자 권한 메모장) — 상세는 audit2744rz.test.js
  assert.ok(doc.includes('notepad C:\\vmware-portal\\portal.env.bat'), '2단계 편집은 관리자 권한 명령 프롬프트의 메모장으로');
  // 명령 블록 안의 경로에는 공백이 없다(.bat 인용 회귀 위험)
  let blocks = 0;
  for (const blk of doc.matchAll(/```(?:bat|powershell)?\n([\s\S]*?)```/g)) {
    blocks += 1;
    assert.doesNotMatch(blk[1], /Program Files|C:\\[^\s\\"]+ [^\s\\"]+\\/, `명령 블록 속 경로에 공백: ${blk[1]}`);
  }
  assert.ok(blocks >= 3, '명령 블록을 찾았다');
  // 스크립트는 바꾸지 않는다(Windows 실기가 없다 — 이 릴리스는 안내만)
  assert.doesNotMatch(rd('packaging/windows/install-service.ps1'), /icacls|Set-Acl/);
});
