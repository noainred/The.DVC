/**
 * v2.744 회귀 검토 RZ — GJ 수정분(INJPKG-01 install.sh 의 vp_cfg_* · LEFT-05 Windows ACL 안내)에서 찾은 3건.
 *
 *  GJ-R1 vp_cfg_set_line 이 portal.env 를 bash 문자열에 한 줄씩 덧붙였다(out+=) — 덧붙일 때마다 전체를 다시 복사해 크기의 제곱에
 *        비례했다(서비스 계정이 portal.env 를 키우면 root 설치기가 수 분~수 시간 멈춘다 — 업그레이드 DoS). 이제 awk 한 번(선형)이고
 *        값은 ENVIRON 으로 넘긴다(-v 는 역슬래시를 해석한다). 결과는 예전 구현과 바이트 단위로 같다(아래 기준 구현과 대조).
 *  GJ-R2 vp_cfg_fix·vp_cfg_set_line·vp_cfg_copy_new 의 사본 만들기가 'cp -a'(재귀)라, 확인 뒤 원본을 폴더로 바꿔치기하면 root 가
 *        서비스 계정 트리를 root 전용 임시 폴더에 통째로 복사한 뒤에야 거절했다. 이제 vp_cfg_snap — 패키지 node 로 O_NOFOLLOW|O_NONBLOCK
 *        한 번 열고 fd 를 fstat 해 일반 파일·링크 수 1·크기 상한을 확인한 뒤 그 fd 에서 읽는다(node 를 못 쓰면 lstat 확인 + 재귀 없는
 *        cp -P --preserve=all + 시한 + 사본 크기 확인). 두 경로를 다 돌린다(VP_CFG_NODE = 이 테스트의 node / 빈 값).
 *  GJ-R3 Windows README 2단계(portal.env.bat 편집)·패키지 폴더 교체·수동 실행이 1-1 의 좁힌 권한과 맞물리지 않았다 — 안내를 더했다(문서).
 *
 * ⚠ install.sh 는 통째로 실행하지 않는다(시스템을 바꾼다) — audit2744j 와 같이 함수·구간을 꺼내 임시 루트 위에서 돌린다.
 *   임시 폴더 크기는 'rm' 을 감싸 지우기 직전에 잰다(예전 cp -a 는 폴더 트리를 거기에 통째로 복사했다).
 *   속도는 절대 시간이 아니라 예전 구현과의 비율로 고정한다(v2.611 규약). 시각(Date.now())을 기준값으로 쓰지 않는다.
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
const sh = (args) => { try { return execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim(); } catch { return ''; } };
const SVC = IS_ROOT ? 'daemon' : sh(['id', '-un']);
const SVC_UID = (() => { try { return Number(execFileSync('id', ['-u', SVC], { encoding: 'utf8' }).trim()); } catch { return null; } })();
const SVC_GROUP_OK = !!sh(['getent', 'group', SVC]);
const ROOT_ONLY = !IS_ROOT || SVC_UID == null || !SVC_GROUP_OK
  ? 'root 권한과 daemon:daemon 계정이 필요한 시나리오 — 이 환경에서는 건너뜀'
  : false;
const REAL_CP = sh(['bash', '-c', 'command -v cp']) || '/usr/bin/cp';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rz-'));
after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ } });
let seq = 0;
function mkEnv() {
  const d = path.join(BASE, `e${++seq}`);
  fs.mkdirSync(path.join(d, 'etc', 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(d, 'outside'), { recursive: true });
  return { d, cfg: path.join(d, 'etc', 'cfg'), out: path.join(d, 'outside'), etc: path.join(d, 'etc') };
}
const leftovers = (env) => fs.readdirSync(env.etc).filter((n) => n.startsWith('.vmware-portal-cfg.'));
const snap = (f) => { const s = fs.statSync(f); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, body: fs.readFileSync(f, 'utf8') }; };

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

/** 기준 구현 — v2.744 GJ 판본(회귀 검토 전)의 vp_cfg_set_line 원문(bash 누적 루프 · cp -a). 출력 대조·속도 비율용. */
const OLD_SET_LINE = String.raw`old_vp_cfg_set_line() {
  local dst="$1" key="$2" val="$3" t line out="" seen=0 rc=0
  t="$(vp_cfg_tmp "$dst")" || { echo "⚠ 임시 폴더를 만들지 못해 $dst 의 $key 줄을 맞추지 않았습니다." >&2; return 1; }
  if ! cp -a -- "$dst" "$t/cur" 2>/dev/null || [[ ! -f "$t/cur" || -L "$t/cur" ]]; then
    echo "⚠ $dst 를 읽지 못해(그사이 링크·일반 파일 아님으로 바뀌었을 수 있다) $key 줄을 맞추지 않았습니다." >&2
    rm -rf -- "$t"; return 2
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then line="$key=$val"; seen=1; fi
    out+="$line"$'\n'
  done < "$t/cur"
  (( seen )) || out+="$key=$val"$'\n'
  printf '%s' "$out" > "$t/new"
  if ! cmp -s -- "$t/cur" "$t/new"; then
    if chown --reference="$t/cur" -- "$t/new" && chmod --reference="$t/cur" -- "$t/new"; then
      { command -v chcon >/dev/null 2>&1 && chcon --reference="$t/cur" -- "$t/new" 2>/dev/null; } || true
      vp_cfg_place "$t/new" "$dst" replace || rc=$?
    else
      rc=1
    fi
  fi
  rm -rf -- "$t"
  return $rc
}
`;

/** 임시 폴더(.vmware-portal-cfg.*)를 지우기 직전에 크기를 적는 rm — 사본으로 무엇이 복사됐는지 본다. */
const RM_WRAP = String.raw`rm() { local a; for a in "$@"; do case "$a" in *.vmware-portal-cfg.*) if [[ -e "$a" ]]; then du -sb -- "$a" >> "$RMLOG" 2>/dev/null || true; fi ;; esac; done; command rm "$@"; }`;

const MODES = [
  { name: 'node', env: { VP_CFG_NODE: process.execPath } },
  { name: 'cp 폴백', env: { VP_CFG_NODE: '' } },
];
function bash(script, args = [], env = {}, opt = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${FNS}\n${OLD_SET_LINE}\n${RM_WRAP}\n${script}`, '_', ...args], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, VP_CFG_NODE: '', VP_CFG_MAX_BYTES: '', VP_CFG_COPY_TIMEOUT: '', ...env }, ...opt,
  });
}
/** 지우기 직전 잰 임시 폴더 크기 중 가장 큰 값(바이트). 기록이 없으면 0. */
function maxTmp(log) {
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).reduce((m, l) => Math.max(m, Number(l.split(/\s/)[0]) || 0), 0);
}
/** 큰 폴더 트리(30파일 × 100KB = 약 3MB) */
function bigTree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `f${i}`), Buffer.alloc(100_000, 65 + (i % 26)));
}

/* ── GJ-R1 ① 출력 대조 — 예전 구현과 바이트 단위로 같다 ───────────────────────────────────────────────── */
const CASES = [
  ['PORT=4000\nCONFIG_DIR=/old\n# CONFIG_DIR=/주석\nCONFIG_DIR=/old2\nX=1', 'CONFIG_DIR'],
  ['', 'CONFIG_DIR'],
  ['\n', 'CONFIG_DIR'],
  ['A=1\n\n\nB=2\n', 'CONFIG_DIR'],
  ['CONFIG_DIR_X=1\nXCONFIG_DIR=2\n CONFIG_DIR=3\nCONFIG_DIR\nCONFIG_DIR=\nconfig_dir=4\n', 'CONFIG_DIR'],
  ['A=1\r\nCONFIG_DIR=/x\r\nB=2\r\n', 'CONFIG_DIR'],
  ['P=a\\nb\\\\c\n\\\nQ=\\t\n', 'CONFIG_DIR'],
  ['A=1\nCONFIG_DIR=/x', 'CONFIG_DIR'],
  ['CONFIG_DIR=/etc/vmware-portal\n', 'CONFIG_DIR'],
  [`K=값\t탭\n${'x'.repeat(100_000)}\n%s %d %%\n`, 'CONFIG_DIR'],
  ['KxY=1\nK.Y=2\nK.YZ=3\n', 'K.Y'],
  ['AB=1\nA*=2\nA*B=3\n', 'A*'],
  ['[x]=1\n[x]=2\n', '[x]'],
];
const VALUES = ['/etc/vmware-portal', 'a\\b\\nc\\', '/p&q#r|s/\\1', '$HOME`x`"y\'z', '한글 경로 값', ''];

for (const m of MODES) {
  test(`GJ-R1 ① vp_cfg_set_line(${m.name}) — 예전 구현과 결과 파일·반환값·권한이 바이트 단위로 같다(키 접두·줄바꿈·CRLF·역슬래시·특수 문자 값)`, () => {
    const env = mkEnv();
    const args = [];
    let n = 0;
    for (const [body, key] of CASES) {
      for (const val of VALUES) {
        n += 1;
        const a = path.join(env.cfg, `n${n}.env`);
        const b = path.join(env.cfg, `o${n}.env`);
        fs.writeFileSync(a, body, { mode: 0o640 });
        fs.writeFileSync(b, body, { mode: 0o640 });
        fs.chmodSync(a, 0o640); fs.chmodSync(b, 0o640);
        args.push(a, b, key, val);
      }
    }
    const rcLog = path.join(env.d, 'rc.log');
    const script = String.raw`RC="$1"; shift
while (($#)); do
  a="$1" b="$2" k="$3" v="$4"; shift 4
  r1=0; vp_cfg_set_line "$a" "$k" "$v" 2>/dev/null || r1=$?
  r2=0; old_vp_cfg_set_line "$b" "$k" "$v" 2>/dev/null || r2=$?
  echo "$r1 $r2" >> "$RC"
done`;
    const r = bash(script, [rcLog, ...args], { ...m.env, RMLOG: path.join(env.d, 'rm.log') });
    assert.equal(r.status, 0, r.stderr);
    const rcs = fs.readFileSync(rcLog, 'utf8').trim().split('\n');
    assert.equal(rcs.length, n);
    for (let i = 1; i <= n; i++) {
      const [r1, r2] = rcs[i - 1].split(' ');
      assert.equal(r1, r2, `case ${i} 반환값`);
      const a = fs.readFileSync(path.join(env.cfg, `n${i}.env`));
      const b = fs.readFileSync(path.join(env.cfg, `o${i}.env`));
      assert.ok(a.equals(b), `case ${i}: ${JSON.stringify(CASES[Math.floor((i - 1) / VALUES.length)][0].slice(0, 40))} / ${JSON.stringify(VALUES[(i - 1) % VALUES.length])}\n새: ${JSON.stringify(a.toString().slice(0, 120))}\n옛: ${JSON.stringify(b.toString().slice(0, 120))}`);
      assert.equal(fs.statSync(path.join(env.cfg, `n${i}.env`)).mode & 0o7777, fs.statSync(path.join(env.cfg, `o${i}.env`)).mode & 0o7777, `case ${i} 권한`);
    }
    assert.deepEqual(leftovers(env), []);
  });
}

/* ── GJ-R1 ② 속도 — 3MB portal.env 에서 예전 구현보다 크게 빠르다(비율) ──────────────────────────────── */
test('GJ-R1 ② vp_cfg_set_line — 3MB portal.env(64바이트 줄 약 4.9만 개)에서 예전 bash 누적보다 5배 넘게 빠르고 결과는 같다', () => {
  const env = mkEnv();
  const line = `# ${'p'.repeat(61)}\n`; // 64바이트
  const body = line.repeat(Math.ceil(3_000_000 / line.length)) + 'PORT=4000\n';
  const a = path.join(env.cfg, 'big-new.env');
  const b = path.join(env.cfg, 'big-old.env');
  fs.writeFileSync(a, body); fs.writeFileSync(b, body);
  const script = String.raw`t0=$(date +%s%N); vp_cfg_set_line "$1" CONFIG_DIR /etc/vmware-portal; t1=$(date +%s%N)
old_vp_cfg_set_line "$2" CONFIG_DIR /etc/vmware-portal; t2=$(date +%s%N)
echo "$(( (t1 - t0) / 1000000 )) $(( (t2 - t1) / 1000000 ))"`;
  const r = bash(script, [a, b], { RMLOG: path.join(env.d, 'rm.log') });
  assert.equal(r.status, 0, r.stderr);
  const [tNew, tOld] = r.stdout.trim().split(/\s+/).map(Number);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), '결과가 같다');
  assert.ok(fs.readFileSync(a, 'utf8').endsWith('PORT=4000\nCONFIG_DIR=/etc/vmware-portal\n'));
  assert.ok(tOld > 40 && tOld > tNew * 5, `예전 ${tOld}ms · 새 ${tNew}ms — 새 구현이 5배 넘게 빨라야 한다(선형)`);
});

/* ── GJ-R1 ③ 크기 상한 — 넘으면 고치지 않고 설치 출력에 말한다 ───────────────────────────────────────── */
for (const m of MODES) {
  test(`GJ-R1 ③ vp_cfg_set_line(${m.name}) — 상한(VP_CFG_MAX_BYTES)을 넘는 파일은 건드리지 않고 '상한' 을 알린다`, () => {
    const env = mkEnv();
    const f = path.join(env.cfg, 'portal.env');
    const body = `X=${'y'.repeat(2000)}\n`;
    fs.writeFileSync(f, body);
    const r = bash('vp_cfg_set_line "$1" CONFIG_DIR /c', [f], { ...m.env, VP_CFG_MAX_BYTES: '1000', RMLOG: path.join(env.d, 'rm.log') });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(fs.readFileSync(f, 'utf8'), body);
    assert.match(r.stderr, /상한/);
    assert.match(r.stderr, /CONFIG_DIR 줄을 맞추지 않았습니다/);
    assert.deepEqual(leftovers(env), []);
  });
}

test('GJ-R1 ③-b 설치 단계 4) — 상한을 넘는 portal.env 는 CONFIG_DIR 줄을 맞추지 않았다는 사실과 상한을 설치 출력에 말하고 설치는 이어 간다', () => {
  const env = mkEnv();
  const CFG_REGION = region('# 4) Config', '# 5) Permissions');
  const prefix = path.join(env.d, 'prefix');
  fs.mkdirSync(path.join(prefix, 'runtime', 'node', 'bin'), { recursive: true });
  const appDst = path.join(env.d, 'app');
  fs.mkdirSync(path.join(appDst, 'server', 'config'), { recursive: true });
  const penv = path.join(env.cfg, 'portal.env');
  const body = `PORT=4000\n${'#'.repeat(3000)}\n`;
  fs.writeFileSync(penv, body);
  const script = `CONFIG_DIR="$1"; SCRIPT_DIR="$2"; PREFIX="$3"; PORT=4711; BAK=""; APP_DST="$4"\n${CFG_REGION}`;
  const r = bash(script, [env.cfg, path.join(ROOT, 'packaging', 'offline'), prefix, appDst], { VP_CFG_MAX_BYTES: '1024', RMLOG: path.join(env.d, 'rm.log') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(penv, 'utf8'), body, 'portal.env 그대로');
  assert.match(r.stdout + r.stderr, /상한/);
  assert.match(r.stdout + r.stderr, /CONFIG_DIR 줄을 맞추지 못했습니다/);
});

/* ── GJ-R2 ① vp_cfg_snap — 일반 파일만 · 재귀 없음 · FIFO 에 매달리지 않음 · 하드 링크·큰 파일 거절 ────── */
for (const m of MODES) {
  test(`GJ-R2 ① vp_cfg_snap(${m.name}) — 일반 파일은 내용·소유자·권한·수정 시각을 옮기고, 링크·폴더·FIFO·하드 링크·없음·상한 초과는 복사하지 않는다(2)`, () => {
    const env = mkEnv();
    const ok = path.join(env.cfg, 'ok.env');
    fs.writeFileSync(ok, 'A=1\n', { mode: 0o604 });
    fs.chmodSync(ok, 0o604);
    if (IS_ROOT && SVC_UID != null) fs.chownSync(ok, SVC_UID, SVC_UID);
    fs.utimesSync(ok, 1_000_000, 1_000_000);
    const tgt = path.join(env.out, 'secret');
    fs.writeFileSync(tgt, 'TOP=SECRET\n', { mode: 0o600 });
    fs.symlinkSync(tgt, path.join(env.cfg, 'link.env'));
    bigTree(path.join(env.cfg, 'dir.env'));
    execFileSync('mkfifo', [path.join(env.cfg, 'fifo.env')]);
    fs.writeFileSync(path.join(env.cfg, 'h1.env'), 'H=1\n');
    fs.linkSync(path.join(env.cfg, 'h1.env'), path.join(env.cfg, 'h2.env'));
    fs.writeFileSync(path.join(env.cfg, 'big.env'), 'x'.repeat(5000));
    const out = path.join(env.d, 'copies');
    fs.mkdirSync(out);
    const names = ['ok.env', 'link.env', 'dir.env', 'fifo.env', 'h1.env', 'absent.env', 'big.env'];
    const script = String.raw`CFG="$1" OUT="$2"; shift 2
for n in "$@"; do r=0; vp_cfg_snap "$CFG/$n" "$OUT/$n" 2>>"$OUT/err.log" || r=$?; echo "$n $r"; done`;
    const r = bash(script, [env.cfg, out, ...names], { ...m.env, VP_CFG_MAX_BYTES: '4096', VP_CFG_COPY_TIMEOUT: '5', RMLOG: path.join(env.d, 'rm.log') }, { timeout: 60_000 });
    assert.equal(r.status, 0, `매달리지 않고 끝난다: ${r.stderr} ${r.error || ''}`);
    const rc = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(' ')));
    assert.equal(rc['ok.env'], '0');
    const s = fs.statSync(path.join(out, 'ok.env'));
    const o = fs.statSync(ok);
    assert.equal(fs.readFileSync(path.join(out, 'ok.env'), 'utf8'), 'A=1\n');
    assert.equal(s.mode & 0o7777, 0o604);
    assert.equal(s.uid, o.uid);
    assert.equal(s.gid, o.gid);
    assert.equal(Math.round(s.mtimeMs / 1000), 1_000_000, '수정 시각 보존(cp -a 와 같다)');
    assert.equal(fs.lstatSync(path.join(out, 'ok.env')).isSymbolicLink(), false);
    for (const n of ['link.env', 'dir.env', 'fifo.env', 'h1.env', 'absent.env', 'big.env']) {
      assert.equal(rc[n], '2', `${n} 는 건너뛴다`);
      assert.equal(fs.existsSync(path.join(out, n)) || (() => { try { fs.lstatSync(path.join(out, n)); return true; } catch { return false; } })(), false, `${n} 사본을 남기지 않는다`);
    }
    const err = fs.readFileSync(path.join(out, 'err.log'), 'utf8');
    assert.match(err, /심볼릭 링크/);
    assert.match(err, /일반 파일이 아닙니다/);
    assert.match(err, /하드 링크/);
    assert.match(err, /상한/);
    // 실제로 그 경로를 탔는지(node 의 fd 판정 문구 / cp 폴백의 lstat 문구) — node 가 조용히 실패해 폴백으로 통과하는 것을 막는다
    if (m.name === 'node') assert.match(err, /가 없어졌습니다/, 'node 경로(ENOENT 를 fd 열기에서 판정)');
    else assert.match(err, /이거나 없음/, 'cp 폴백 경로(lstat 판정)');
    assert.equal(snap(tgt).body, 'TOP=SECRET\n', '링크 대상 그대로');
    assert.equal(fs.readdirSync(path.join(env.cfg, 'dir.env')).length, 30, '폴더 그대로');
  });
}

/* ── GJ-R2 ② 확인 뒤 폴더로 바꿔치기 — 세 함수가 트리를 복사하지 않는다 ─────────────────────────────── */
for (const m of MODES) {
  test(`GJ-R2 ② (${m.name}) vp_cfg_fix·vp_cfg_set_line·vp_cfg_copy_new — 원본이 큰 폴더(약 3MB)면 그 트리를 임시 폴더로 복사하지 않고 거절한다`, () => {
    const env = mkEnv();
    for (const n of ['fix.env', 'line.env', 'src.env']) bigTree(path.join(env.cfg, n));
    const rmlog = path.join(env.d, 'rm.log');
    const script = String.raw`C="$1"
r1=0; vp_cfg_fix "$C/fix.env" "$2" 0640 2>/dev/null || r1=$?
r2=0; vp_cfg_set_line "$C/line.env" CONFIG_DIR /c 2>/dev/null || r2=$?
r3=0; vp_cfg_copy_new "$C/src.env" "$C/new.env" 2>/dev/null || r3=$?
echo "$r1 $r2 $r3"`;
    const r = bash(script, [env.cfg, `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`], { ...m.env, RMLOG: rmlog });
    assert.equal(r.status, 0, r.stderr);
    const [r1, r2, r3] = r.stdout.trim().split(' ').map(Number);
    assert.equal(r1, 2, 'vp_cfg_fix 거절');
    assert.equal(r2, 2, 'vp_cfg_set_line 거절');
    assert.notEqual(r3, 0, 'vp_cfg_copy_new 거절');
    assert.equal(fs.existsSync(path.join(env.cfg, 'new.env')), false);
    const big = maxTmp(rmlog);
    assert.ok(big < 64 * 1024, `임시 폴더에 트리를 복사하지 않는다(지우기 직전 최대 ${big}바이트 — 예전 cp -a 는 약 3MB)`);
    for (const n of ['fix.env', 'line.env', 'src.env']) assert.equal(fs.readdirSync(path.join(env.cfg, n)).length, 30, `${n} 폴더 그대로`);
    assert.deepEqual(leftovers(env), []);
  });
}

/* ── GJ-R2 ③ 하드 링크 · 상한 초과 — vp_cfg_fix 도 거절한다 ─────────────────────────────────────────────── */
for (const m of MODES) {
  test(`GJ-R2 ③ (${m.name}) vp_cfg_fix — 하드 링크(링크 수 2)로 바뀐 파일은 권한을 맞추지 않는다 · 정상 파일은 예전처럼 맞춘다`, () => {
    const env = mkEnv();
    const f = path.join(env.cfg, 'h.env');
    fs.writeFileSync(f, 'K=1\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    fs.linkSync(f, path.join(env.cfg, 'h-other'));
    const plain = path.join(env.cfg, 'p.env');
    fs.writeFileSync(plain, 'P=1\n', { mode: 0o644 });
    fs.chmodSync(plain, 0o644);
    const me = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const r = bash('r1=0; vp_cfg_fix "$1" "$3" 0640 || r1=$?; r2=0; vp_cfg_fix "$2" "$3" 0640 || r2=$?; echo "$r1 $r2"', [f, plain, me], { ...m.env, RMLOG: path.join(env.d, 'rm.log') });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '2 0');
    assert.equal(fs.statSync(f).mode & 0o7777, 0o644, '하드 링크 파일 권한 그대로');
    assert.match(r.stderr, /하드 링크/);
    assert.equal(snap(plain).mode, 0o640);
    assert.equal(snap(plain).body, 'P=1\n');
    assert.deepEqual(leftovers(env), []);
  });
}

/* ── GJ-R2 ④ cp 폴백 — 확인 뒤 FIFO 로 바꿔치기해도 시한 안에 끝난다 ────────────────────────────────── */
test('GJ-R2 ④ (cp 폴백) — lstat 확인과 cp 열기 사이에 FIFO 로 바뀌면 cp 가 열기에서 매달린다 → 시한(VP_CFG_COPY_TIMEOUT)으로 끊고 거절한다', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'r.env');
  fs.writeFileSync(f, 'R=1\n');
  const fake = path.join(env.d, 'fakebin');
  fs.mkdirSync(fake);
  // 확인 뒤 바꿔치기 흉내 — 원본을 FIFO 로 바꾼 뒤 진짜 cp 를 부른다(재귀 없는 cp 는 FIFO 를 열어 읽으려다 멈춘다)
  fs.writeFileSync(path.join(fake, 'cp'), `#!/bin/bash\nsrc="\${@: -2:1}"\n/bin/rm -f -- "$src"\nmkfifo -- "$src"\nexec ${REAL_CP} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(path.join(fake, 'cp'), 0o755);
  const me = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  const r = bash('r=0; vp_cfg_fix "$1" "$2" 0640 || r=$?; echo "rc=$r"', [f, me],
    { VP_CFG_NODE: '', VP_CFG_COPY_TIMEOUT: '1', PATH: `${fake}:${process.env.PATH}`, RMLOG: path.join(env.d, 'rm.log') }, { timeout: 30_000 });
  assert.equal(r.error, undefined, '테스트 시한(30초) 안에 끝난다');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rc=2/);
  assert.match(r.stderr, /시한/);
  assert.deepEqual(leftovers(env), []);
});

for (const m of MODES) {
  test(`GJ-R2 ④-b (${m.name}) — 상한을 넘는 큰 일반 파일(3MB)도 임시 폴더에 복사하지 않고 거절한다(상한은 복사 전에 본다)`, () => {
    const env = mkEnv();
    const f = path.join(env.cfg, 'k.conf');
    fs.writeFileSync(f, Buffer.alloc(3_000_000, 66));
    const rmlog = path.join(env.d, 'rm.log');
    const me = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const r = bash('r=0; vp_cfg_fix "$1" "$2" 0640 || r=$?; echo "rc=$r"', [f, me], { ...m.env, VP_CFG_MAX_BYTES: '4096', RMLOG: rmlog });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=2/);
    assert.match(r.stderr, /상한 4096바이트/);
    const sz = maxTmp(rmlog);
    assert.ok(sz < 64 * 1024, `큰 파일을 임시 폴더에 복사하지 않는다(최대 ${sz}바이트)`);
    assert.deepEqual(leftovers(env), []);
  });
}

test('GJ-R2 ④-c (cp 폴백) — lstat 확인 뒤 상한을 넘는 큰 파일로 바뀌면 사본 크기 확인이 거절한다(제자리에 놓지 않는다)', () => {
  const env = mkEnv();
  const f = path.join(env.cfg, 'r.env');
  fs.writeFileSync(f, 'R=1\n', { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  const fake = path.join(env.d, 'fakebin');
  fs.mkdirSync(fake);
  // 확인 뒤 바꿔치기 흉내 — 원본을 상한보다 큰 일반 파일로 바꾼 뒤 진짜 cp 를 부른다
  fs.writeFileSync(path.join(fake, 'cp'), `#!/bin/bash\nsrc="\${@: -2:1}"\n/bin/rm -f -- "$src"\nprintf '%9000s' '' > "$src"\nexec ${REAL_CP} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(path.join(fake, 'cp'), 0o755);
  const me = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  const r = bash('r=0; vp_cfg_fix "$1" "$2" 0640 || r=$?; echo "rc=$r"', [f, me],
    { VP_CFG_NODE: '', VP_CFG_MAX_BYTES: '4096', PATH: `${fake}:${process.env.PATH}`, RMLOG: path.join(env.d, 'rm.log') }, { timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rc=2/);
  assert.match(r.stderr, /사본이 일반 파일이 아니거나 상한/);
  assert.equal(fs.statSync(f).mode & 0o7777, 0o644, '바꿔치기한 큰 파일을 제자리에 다시 놓지 않았다(권한 그대로)');
  assert.deepEqual(leftovers(env), []);
});

/* ── GJ-R2 ⑤ 설치 단계 5) — 호스트 키 파일을 확인 뒤 큰 폴더로 바꿔치기(리뷰 재현 그대로) ────────────── */
const PERM_REGION = region('# 5) Permissions', '# SELinux 라벨 처리');
for (const m of MODES) {
  test(`GJ-R2 ⑤ (${m.name}) 5) — chown -R 동안 호스트 키 파일이 서비스 계정의 큰 폴더로 바뀌어도 root 가 그 트리를 복사하지 않고 알린다`, { skip: ROOT_ONLY }, () => {
    const env = mkEnv();
    const hk = path.join(env.cfg, 'release-signing-keys.conf');
    fs.writeFileSync(hk, '{"keys":[]}', { mode: 0o644 });
    fs.writeFileSync(path.join(env.cfg, 'portal.env'), 'X=1\n');
    const big = path.join(env.out, 'tree');
    bigTree(big);
    const prefix = path.join(env.d, 'prefix');
    fs.mkdirSync(prefix, { recursive: true });
    const swap = 'eval "orig_$(declare -f vp_chown_tree_except)"\nvp_chown_tree_except() { orig_vp_chown_tree_except "$@"; command rm -f -- "$CONFIG_DIR/release-signing-keys.conf"; cp -a -- "$BIG" "$CONFIG_DIR/release-signing-keys.conf"; chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/release-signing-keys.conf"; }';
    const script = `CONFIG_DIR="$1"; SERVICE_USER="$2"; PREFIX="$3"; BIG="$4"\n${swap}\n${PERM_REGION}`;
    const rmlog = path.join(env.d, 'rm.log');
    const r = bash(script, [env.cfg, SVC, prefix, big], { ...m.env, RMLOG: rmlog });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /맞추지 않았습니다/);
    const sz = maxTmp(rmlog);
    assert.ok(sz < 64 * 1024, `root 전용 임시 폴더에 서비스 계정 트리를 복사하지 않는다(최대 ${sz}바이트)`);
    assert.equal(fs.readdirSync(hk).length, 30, '바꿔치기한 폴더는 그대로');
    assert.deepEqual(leftovers(env), []);
  });
}

/* ── GJ-R2 ⑥ 소스 규약 ──────────────────────────────────────────────────────────────────────────────────── */
test('GJ-R2 ⑥ install.sh — 사본은 vp_cfg_snap 하나로 만들고(cp -a 없음), 그 node 는 패키지의 것(5) chown -R 뒤의 $PREFIX node 가 아니다) · set_line 은 awk(ENVIRON) 한 번', () => {
  const strip = (s) => s.replace(/^\s*#.*$/gm, '');
  for (const n of ['vp_cfg_fix', 'vp_cfg_set_line', 'vp_cfg_copy_new']) {
    const body = strip(shellFn(INSTALL, n) || '');
    assert.ok(body, n);
    assert.doesNotMatch(body, /\bcp -a\b/, `${n} 에 재귀 복사(cp -a)가 없다`);
    assert.match(body, /vp_cfg_snap "\$(dst|src)" "\$t\/(cur|new)"/, `${n} 는 vp_cfg_snap 으로 사본을 만든다`);
  }
  const snapFn = strip(shellFn(INSTALL, 'vp_cfg_snap') || '');
  assert.ok(snapFn, 'vp_cfg_snap');
  assert.match(snapFn, /O_NOFOLLOW/);
  assert.match(snapFn, /O_NONBLOCK/);
  assert.match(snapFn, /fstatSync\(fd\)/, '연 fd 를 fstat 한다(경로를 다시 보지 않는다)');
  assert.match(snapFn, /cp -P --preserve=all -- "\$src" "\$dst"/, '폴백은 재귀 없는 cp');
  assert.doesNotMatch(snapFn, /cp -[a-zA-Z]*[aRr]/, '폴백에도 재귀(-a·-R·-r) 없음');
  assert.match(snapFn, /timeout/, '폴백 cp 는 시한 안에서');
  const line = strip(shellFn(INSTALL, 'vp_cfg_set_line'));
  assert.doesNotMatch(line, /out\+=/, 'bash 누적 없음');
  assert.match(line, /ENVIRON\["VP_K"\]/);
  assert.doesNotMatch(line, /awk[^\n]*\s-v\s/, 'awk -v(역슬래시 해석) 금지');
  // node 는 패키지(SCRIPT_DIR)의 것 — 본문(함수 밖)에서 정한다
  const top = strip(INSTALL).split('\n').filter((l) => /^VP_CFG_NODE=/.test(l));
  assert.deepEqual(top, ['VP_CFG_NODE="$SCRIPT_DIR/runtime/node/bin/node"']);
  assert.ok(INSTALL.indexOf('VP_CFG_NODE="$SCRIPT_DIR') < INSTALL.indexOf('# 4) Config'), '4) 전에 정한다');
});

/* ── GJ-R3 Windows README ──────────────────────────────────────────────────────────────────────────────── */
test('GJ-R3 Windows README — 2단계는 관리자 권한 메모장으로 편집(탐색기 "계속" 은 계정 권한을 영구로 더한다) · 패키지 폴더를 바꾸면 1-1 다시 · 수동 실행은 관리자 권한 창', () => {
  const doc = rd('packaging/windows/README-WINDOWS.md');
  const sec = (start, end) => { const a = doc.indexOf(start); const b = doc.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, `${start} 절`); return doc.slice(a, b); };
  const step2 = sec('2. `portal.env.bat` 편집', '\n3. ');
  assert.match(step2, /관리자 권한/);
  assert.ok(step2.includes('notepad C:\\vmware-portal\\portal.env.bat'), '관리자 권한 명령 프롬프트에서 여는 예시');
  assert.match(step2, /계속/);
  assert.match(step2, /영구/);
  assert.match(step2, /새 폴더[^\n]*1-1[^\n]*다시 실행/, '패키지 폴더를 바꾸면 새 폴더에 1-1 을 다시 실행');
  const manual = sec('## 수동 실행 / 점검', '\n## ');
  assert.match(manual, /관리자 권한/);
  assert.match(doc, /실기로 확인하지 못했습니다/);
});
