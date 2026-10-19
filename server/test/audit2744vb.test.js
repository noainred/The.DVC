// v2.744 최종 수정분 적대적 검토 — 그룹 VB(packaging/offline/release-verify-lib.sh). 반증 2인을 견딘 6건.
//   VERIFY-01 root 소유 확인 사본이 없는 옛 설치본(v2.741 이전)에서 '옛 확인 도구를 누구 권한으로 돌릴지' 를 old_js 소유자 하나로 정하고
//             stat 이 실패하면 0(root)이 됐다 — app 을 root 소유 폴더로 가는 링크로 바꾸거나 stat 직전에 old_js 를 치우면 서비스 계정이 바꾼
//             node 를 root 로 실행했다. 이제 node·js 를 찾아가는 길 전체(vp_path_controllers)로 정하고, 판정할 수 없거나 여러 계정이면 실행하지 않는다.
//   VERIFY-02 root 분기의 정책 읽기가 서비스 계정 node 를 root 로 실행했다(--skip-signature-check · 패키지 없음 경로에서도).
//   VERIFY-03 소유 계정 권한으로 확인하는 분기(runas)가 portal.env 를 root 로 grep 해 FIFO 에서 시한 없이 멈추고 링크를 따라갔다.
//   VERIFY-04 vp_root_read 가 ENOENT 밖의 열기 실패를 전부 10 으로 접어 EACCES·ENOTDIR 를 '링크·FIFO·장치' 로 안내했다.
//   VERIFY-05 vp_root_env_policy 가 root 소유이기만 하면 그룹·기타가 쓸 수 있는 portal.env 의 정책도 받았다.
//   VERIFY-06 node 없음·비정상 종료 폴백이 '확인 뒤 다시 열기' 를 시한 없이 남겼다(FIFO 로 바꾸면 root 가 매달린다).
// 바꿔치기는 bash DEBUG 트랩(set -T)으로 결정적으로 재현한다(audit2744flead2 의 SWAP 과 같은 방식 — 지우지 않고 mv 로 바꾼다).
// VP_LIB_UNDER_TEST 로 다른 판본(기준판)을 대조할 수 있다. root 로 도는 컨테이너에서 setpriv --reuid=65534 로 서비스 계정을 흉내 낸다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = process.env.VP_LIB_UNDER_TEST || path.join(ROOT, 'packaging/offline/release-verify-lib.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_SETPRIV = spawnSync('sh', ['-c', 'command -v setpriv']).status === 0;
const ROOT_ONLY = IS_ROOT && HAS_SETPRIV ? false : 'root + setpriv 가 있을 때만(소유자를 바꾸고 서비스 계정으로 권한을 내린다)';
const idOf = (args) => Number(spawnSync('id', args, { encoding: 'utf8' }).stdout.trim());
const NB = { uid: idOf(['-u', 'nobody']) || 65534, gid: idOf(['-g', 'nobody']) || 65534 };
const OTHER_UID = 4242;   // 두 번째 비-root 계정(등록부에 없어도 chown 은 숫자로 된다)
const NODE = process.execPath;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744vb-'));
fs.chmodSync(base, 0o755);
const fifos = [];
after(() => {
  // 기준판 실행이 FIFO 열기에서 매달린 채 남았으면 쓰는 쪽을 한 번 열어 풀어 준다(남은 프로세스를 두지 않는다)
  for (const f of fifos) { try { const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* 없음 */ } }
  fs.rmSync(base, { recursive: true, force: true });
});
const mkfifo = (p) => { const r = spawnSync('mkfifo', [p]); assert.equal(r.status, 0, `mkfifo ${p}`); fifos.push(p); };

// 매달릴 수 있는 실행은 timeout 으로 감싼다(프로세스 그룹째 끊는다 — 매달린 grep 이 남지 않게).
const bash = (body, args = [], { env = process.env, secs = 8 } = {}) => {
  const t0 = Date.now();
  const r = spawnSync('timeout', ['-k', '1', String(secs), 'bash', '-c', `set -euo pipefail\nsource "${LIB}"\n${body}`, '_', ...args], { encoding: 'utf8', env });
  return { ...r, ms: Date.now() - t0, hung: r.status === 124 || r.status === 137 || r.status === null };
};
const writeFile = (p, text, mode = 0o644) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); fs.chmodSync(p, mode); };
const mkdirs = (...ds) => { for (const d of ds) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, 0o755); } };
const chownR = (p, uid, gid) => spawnSync('chown', ['-R', '-h', `${uid}:${gid}`, p]);

// 실행된 node 를 기록하는 래퍼 — '<표지>:<uid>:<첫 인자>' (vp_root_read 는 '-e', 확인 실행은 js 경로)
const MARK = path.join(base, 'marks');
fs.writeFileSync(MARK, ''); fs.chmodSync(MARK, 0o666);
const marks = () => fs.readFileSync(MARK, 'utf8').split('\n').filter(Boolean);
const clearMarks = () => fs.writeFileSync(MARK, '');
const nodeWrapper = (file, tag) => writeFile(file, `#!/bin/sh\necho "${tag}:$(id -u):$1" >> '${MARK}'\nexec '${NODE}' "$@"\n`, 0o755);
// 가짜 확인 도구 — --policy 면 '키 미설정 warn', 아니면 받은 정책을 그대로 말한다(실제 서명 키 없이 경로·권한·정책만 본다)
const FAKE_CLI = `if (process.argv.includes('--policy')) { console.log('policy=warn source=unconfigured'); process.exit(0); }
console.log('VERIFY-OK policy=[' + (process.env.UPGRADE_SIGNATURE_POLICY || '') + ']');\n`;
const appTree = (dir) => writeFile(path.join(dir, 'app/server/src/upgrade/verifyCli.js'), FAKE_CLI);

// 새 패키지(root 가 푼 폴더) + 패키지·manifest 파일(내용은 가짜 도구가 보지 않는다)
const pkgFor = (dir) => {
  const sdir = path.join(dir, 'pkg', 'vmware-portal-offline-10.0.2-el9-x64');
  appTree(sdir);
  nodeWrapper(path.join(sdir, 'runtime/node/bin/node'), 'pkg');
  // 기본 위치(풀린 폴더 옆)에 두지 않는다 — '패키지·manifest 없음' 경로를 따로 볼 수 있게 인자로만 넘긴다
  const pkg = path.join(dir, 'dl', 'vmware-portal-offline-10.0.2-el9-x64.tar.gz');
  const man = path.join(dir, 'dl', 'vmware-portal-10.0.2.manifest.json');
  writeFile(pkg, 'pkg'); writeFile(man, '{}');
  return { sdir, pkg, man };
};
const envFor = (dir) => {
  const e = { ...process.env, VP_ROOT_TOOLS_BASE: path.join(dir, 'no-tools'), TMPDIR: path.join(dir, 'tmp'), VP_ROOT_READ_TIMEOUT: '2' };
  delete e.UPGRADE_SIGNATURE_POLICY; delete e.VP_ROOT_TRUST_COPY;
  mkdirs(e.TMPDIR);
  return e;
};
const verify = (prefix, sdir, cfg, pkg, man, skip, env, pre = '') => bash(`${pre}verify_release_package "$@"`, [prefix, sdir, cfg, '10.0.2', pkg, man, String(skip)], { env, secs: 12 });

/* ── vp_path_controllers ─────────────────────────────────────────────────────────────────────────────────── */
test('VERIFY-01 ⓪ vp_path_controllers — 길 전체(폴더·링크·링크 대상)를 lstat 으로 보고 바꿀 수 있는 비-root 계정을 말한다', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'pc'); mkdirs(path.join(d, 'r/a/b'), path.join(d, 'n'), path.join(d, 'w'));
  writeFile(path.join(d, 'r/a/b/f'), 'x');
  chownR(path.join(d, 'n'), NB.uid, NB.gid);
  fs.symlinkSync(path.join(d, 'r/a'), path.join(d, 'n/link'));          // 서비스 계정 폴더 안의 링크 → root 소유 폴더
  fs.lchownSync(path.join(d, 'n/link'), NB.uid, NB.gid);
  fs.symlinkSync(path.join(d, 'n'), path.join(d, 'r/to-n'));             // root 폴더 안의 링크 → 서비스 계정 폴더
  fs.chmodSync(path.join(d, 'w'), 0o777); writeFile(path.join(d, 'w/f'), 'x');
  fs.symlinkSync('../a/b/f', path.join(d, 'r/a/rel'));                   // root 링크(상대)
  fs.symlinkSync('loop2', path.join(d, 'r/loop1')); fs.symlinkSync('loop1', path.join(d, 'r/loop2'));
  const pc = (p) => bash('if o="$(vp_path_controllers "$1")"; then echo "OK[$o]"; else echo "NO[$o]"; fi', [p]).stdout.trim();
  assert.equal(pc(path.join(d, 'r/a/b/f')), 'OK[]', 'root 전용 길');
  assert.equal(pc(path.join(d, 'r/a/rel')), 'OK[]', 'root 폴더 안의 root 링크는 따라가 대상의 길까지 본다');
  assert.equal(pc(path.join(d, 'n/link/b/f')), `OK[${NB.uid}:${NB.gid}]`, '링크가 놓인 폴더의 소유자를 센다(readlink -f 로는 안 보인다)');
  assert.equal(pc(path.join(d, 'r/to-n/link/b/f')), `OK[${NB.uid}:${NB.gid}]`, '링크 대상의 길도 본다');
  assert.equal(pc(path.join(d, 'w/f')), `NO[writable:${path.join(d, 'w')}]`, '그룹·기타 쓰기 폴더는 판정할 수 없다');
  assert.equal(pc(path.join(d, 'missing')), `NO[stat:${path.join(d, 'missing')}]`, '확인 실패는 root 가 아니라 판정 불가(예전 || echo 0)');
  assert.match(pc(path.join(d, 'r/loop1')), /^NO\[loop:/);
  assert.equal(pc('relative/x'), 'NO[relative]');
  assert.equal(pc(os.tmpdir()), 'OK[]', 'sticky /tmp 는 남의 항목을 바꿀 수 없어 허용');
});

/* ── VERIFY-01 · 02 ──────────────────────────────────────────────────────────────────────────────────────── */
test('VERIFY-01·02 ① app 을 root 소유 폴더로 가는 링크로 바꾸고 node 를 갈아끼워도 그 node 를 root 로 실행하지 않는다(정책 읽기 포함)', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'A'); mkdirs(path.join(d, 'opt'), path.join(d, 'etc'));
  const rootApp = path.join(d, 'rootpkg');   // 남아 있는 예전 패키지 압축 해제 폴더(root 소유 — tar --owner=0)
  appTree(rootApp);
  const PREFIX = path.join(d, 'opt/vp');
  mkdirs(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');          // 서비스 계정이 갈아끼운 node
  fs.symlinkSync(path.join(rootApp, 'app'), path.join(PREFIX, 'app'));
  chownR(PREFIX, NB.uid, NB.gid);                                             // install.sh 의 chown -R 과 같은 상태
  const { sdir, pkg, man } = pkgFor(d);
  const env = envFor(d);
  const CFG = path.join(d, 'etc');
  for (const [p, m, skip, want] of [['', '', 1, 0], ['', '', 0, 0], [pkg, man, 0, 0], [pkg, man, 1, 0]]) {
    clearMarks();
    const r = verify(PREFIX, sdir, CFG, p, m, skip, env);
    assert.equal(r.hung, false, r.stdout + r.stderr);
    const root = marks().filter((x) => x.startsWith('old:0:'));
    assert.deepEqual(root, [], `서비스 계정이 바꾼 node 를 root 로 실행하면 안 된다(pkg=${!!p} skip=${skip}): ${marks()} — ${r.stdout}${r.stderr}`);
    assert.equal(r.status, want, `pkg=${!!p} skip=${skip}: ${r.stdout}${r.stderr}`);
    if (skip === 1 && !p) assert.deepEqual(marks(), [], '--skip-signature-check · 패키지 없음 — 도구를 실행하지 않는다(정책 한 줄을 읽으려고 node 를 돌리지 않는다)');
    if (p) assert.match(r.stdout, new RegExp(`소유 계정\\(uid ${NB.uid}\\)`), '바꿀 수 있는 계정(서비스 계정)으로 낮춰 확인한다');
  }
});

test('VERIFY-01 ② stat 직전에 old_js 를 치워도(확인 실패) root 로 열리지 않고 설치를 멈춘다 — --skip-signature-check 면 도구 없이 넘긴다', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'B'); mkdirs(path.join(d, 'opt'), path.join(d, 'etc'));
  const PREFIX = path.join(d, 'opt/vp');
  appTree(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');
  chownR(PREFIX, NB.uid, NB.gid);
  const js = path.join(PREFIX, 'app/server/src/upgrade/verifyCli.js');
  const { sdir, pkg, man } = pkgFor(d);
  const env = envFor(d);
  const mark = path.join(d, '.swapped');
  // 옛 판본은 'ou=$(stat -c %u -- "$old_js" … || echo 0)', 새 판본은 vp_path_controllers 직전 — 한 번만 old_js 를 다른 이름으로 옮긴다
  const pre = `set -T
trap 'if [[ ! -e "${mark}" && ( "$BASH_COMMAND" == *"stat -c %u"* || "$BASH_COMMAND" == *vp_path_controllers* ) ]]; then : > "${mark}"; mv -f -- "${js}" "${js}.away"; fi' DEBUG
`;
  for (const skip of [0, 1]) {
    if (fs.existsSync(`${js}.away`)) fs.renameSync(`${js}.away`, js);
    try { fs.unlinkSync(mark); } catch { /* 없음 */ }
    clearMarks();
    const r = verify(PREFIX, sdir, path.join(d, 'etc'), pkg, man, skip, env, pre);
    assert.ok(fs.existsSync(mark), '바꿔치기가 실제로 일어났다');
    assert.deepEqual(marks().filter((x) => x.startsWith('old:0:')), [], `확인 실패가 root 실행이 되면 안 된다: ${marks()}`);
    assert.deepEqual(marks(), [], '판정할 수 없으면 그 도구를 실행하지 않는다');
    if (skip === 0) {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /판정하지 못했습니다/);
      assert.match(r.stderr, /설치를 멈춥니다/);
    } else {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /--skip-signature-check/);
    }
  }
});

test('VERIFY-01 ③ 여러 계정이 바꿀 수 있거나(node 는 다른 계정) 길에 그룹·기타 쓰기 폴더가 있으면 실행하지 않고 멈춘다', { skip: ROOT_ONLY }, () => {
  // (a) node 만 다른 계정 소유
  const d = path.join(base, 'D'); mkdirs(path.join(d, 'opt'), path.join(d, 'etc'));
  const PREFIX = path.join(d, 'opt/vp');
  appTree(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');
  chownR(PREFIX, NB.uid, NB.gid);
  fs.chownSync(path.join(PREFIX, 'runtime/node/bin/node'), OTHER_UID, OTHER_UID);
  const { sdir, pkg, man } = pkgFor(d);
  const env = envFor(d);
  clearMarks();
  let r = verify(PREFIX, sdir, path.join(d, 'etc'), pkg, man, 0, env);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`여러 계정\\(uid ${NB.uid}·${OTHER_UID}\\)`));
  assert.deepEqual(marks(), [], `어느 계정으로도 실행하지 않는다(예전에는 js 소유자 권한으로 다른 계정의 node 를 실행했다): ${marks()}`);
  r = verify(PREFIX, sdir, path.join(d, 'etc'), pkg, man, 1, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(marks(), []);
  // (b) 길 위 폴더를 그룹·기타가 쓸 수 있다
  const e = path.join(base, 'E'); mkdirs(path.join(e, 'opt'), path.join(e, 'etc'));
  const P2 = path.join(e, 'opt/vp');
  appTree(P2);
  nodeWrapper(path.join(P2, 'runtime/node/bin/node'), 'old');
  chownR(P2, NB.uid, NB.gid);
  fs.chmodSync(path.join(e, 'opt'), 0o777);
  const p2 = pkgFor(e);
  clearMarks();
  r = verify(P2, p2.sdir, path.join(e, 'etc'), p2.pkg, p2.man, 0, envFor(e));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /그룹·기타가 쓸 수 있습니다/);
  assert.match(r.stderr, /조치/);
  assert.deepEqual(marks(), []);
});

test('VERIFY-01 ④ (회귀 방지) 길 전체가 root 전용인 옛 설치본(--user root)은 root 링크가 끼어 있어도 예전처럼 root 로 확인한다', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'C'); mkdirs(path.join(d, 'real-opt'), path.join(d, 'etc'));
  fs.symlinkSync(path.join(d, 'real-opt'), path.join(d, 'opt'));          // /opt → /data/opt 같은 root 링크
  const PREFIX = path.join(d, 'opt/vp');
  appTree(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');
  const { sdir, pkg, man } = pkgFor(d);
  const env = envFor(d);
  fs.writeFileSync(path.join(d, 'etc/portal.env'), 'UPGRADE_SIGNATURE_POLICY=warn\n'); fs.chmodSync(path.join(d, 'etc/portal.env'), 0o644);
  clearMarks();
  const r = verify(PREFIX, sdir, path.join(d, 'etc'), pkg, man, 0, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERIFY-OK policy=\[warn\]/, 'root 소유 portal.env 정책을 받는다');
  assert.ok(marks().length > 0 && marks().every((x) => x.startsWith('old:0:')), `${marks()}`);
});

test('VERIFY-02 ⑤ vp_policy_reader — 길 전체가 root 전용인 node 만 고른다(서비스 계정 소유·서비스 계정 폴더를 지나는 링크는 고르지 않는다)', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'R'); mkdirs(path.join(d, 'root'), path.join(d, 'svc'));
  nodeWrapper(path.join(d, 'root/node'), 'r');
  nodeWrapper(path.join(d, 'svc/node'), 's');
  chownR(path.join(d, 'svc'), NB.uid, NB.gid);
  fs.symlinkSync(path.join(d, 'svc/node'), path.join(d, 'root/node-link'));
  const pick = (...c) => bash('printf "[%s]" "$(vp_policy_reader "$@")"', c).stdout;
  assert.equal(pick(path.join(d, 'svc/node')), '[]');
  assert.equal(pick(path.join(d, 'root/node-link')), '[]', 'root 폴더 안의 링크라도 대상의 길이 서비스 계정 것이면 아니다');
  assert.equal(pick(path.join(d, 'svc/node'), path.join(d, 'root/node')), `[${path.join(d, 'root/node')}]`);
  assert.equal(pick(path.join(d, 'none')), '[]');
});

/* ── VERIFY-03 ───────────────────────────────────────────────────────────────────────────────────────────── */
test('VERIFY-03 ⑥ 소유 계정 권한으로 확인하는 분기 — portal.env 가 FIFO 여도 매달리지 않고, 링크면 따라가지 않으며, 일반 파일은 예전처럼 따른다', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'G'); mkdirs(path.join(d, 'opt'), path.join(d, 'etc'));
  const PREFIX = path.join(d, 'opt/vp');
  appTree(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');
  chownR(PREFIX, NB.uid, NB.gid);
  const CFG = path.join(d, 'etc');
  const env = envFor(d);
  const { sdir, pkg, man } = pkgFor(d);
  const pe = path.join(CFG, 'portal.env');
  clearMarks();
  // FIFO — 예전 root grep 은 열기에서 시한 없이 멈췄다
  mkfifo(pe);
  let r = verify(PREFIX, sdir, CFG, '', '', 1, env);
  assert.equal(r.hung, false, `FIFO 에서 매달리면 안 된다(${r.ms}ms): ${r.stdout}${r.stderr}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.unlinkSync(pe);
  // 링크 → root 소유 파일(정책 warn) — 따라가 그 정책을 쓰지 않는다
  const target = path.join(d, 'root-policy.env');
  writeFile(target, 'UPGRADE_SIGNATURE_POLICY=warn\n');
  fs.symlinkSync(target, pe); fs.lchownSync(pe, NB.uid, NB.gid);
  r = verify(PREFIX, sdir, CFG, pkg, man, 0, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERIFY-OK policy=\[\]/, `링크 너머 정책을 쓰지 않는다: ${r.stdout}`);
  assert.match(r.stderr, /심볼릭 링크/);
  fs.unlinkSync(pe);
  // 서비스 계정 소유 일반 파일 — 이 분기는 예전처럼 portal.env 정책을 따른다(그 도구 자체가 그 계정의 신뢰 수준)
  writeFile(pe, 'UPGRADE_SIGNATURE_POLICY=warn\n', 0o640); fs.chownSync(pe, NB.uid, NB.gid);
  r = verify(PREFIX, sdir, CFG, pkg, man, 0, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERIFY-OK policy=\[warn\]/);
  assert.ok(marks().every((x) => !x.startsWith('old:0:')), `${marks()}`);
});

/* ── VERIFY-04 ───────────────────────────────────────────────────────────────────────────────────────────── */
test('VERIFY-04 ⑦ 열기 실패를 원인대로 나눈다 — ENOTDIR·EACCES 는 12 와 실제 원인, 링크·FIFO 는 10, 없음은 11', () => {
  const d = path.join(base, 'H'); mkdirs(d);
  writeFile(path.join(d, 'notadir'), 'x');
  let r = bash('vp_root_read "$1" "$2" || echo " rc=$?"', [path.join(d, 'notadir/portal.env'), NODE]);
  assert.match(r.stdout, /open:ENOTDIR rc=12/, r.stdout);
  r = bash('v="$(vp_root_env_policy "$1" "$2")"; echo "v=[$v]"', [path.join(d, 'notadir'), NODE]);
  assert.match(r.stdout, /v=\[\]/);
  assert.match(r.stderr, /폴더가 아니라/);
  assert.doesNotMatch(r.stderr, /일반 파일이 아니거나/, `틀린 원인(링크·FIFO·장치)을 말하지 않는다: ${r.stderr}`);
  // 예전 판정은 그대로
  fs.mkdirSync(path.join(d, 'ok'));
  writeFile(path.join(d, 'ok/portal.env'), 'X=1\n');
  fs.symlinkSync(path.join(d, 'ok/portal.env'), path.join(d, 'ok/link.env'));
  r = bash('vp_root_read "$1" "$2" || echo " rc=$?"', [path.join(d, 'ok/link.env'), NODE]);
  assert.match(r.stdout, /link rc=10/);
  r = bash('vp_root_read "$1" "$2" || echo " rc=$?"', [path.join(d, 'ok/none.env'), NODE]);
  assert.match(r.stdout, /absent rc=11/);
  // vp_stage_trust_copy 도 같은 원인 문구
  const cur = path.join(d, 'tools'); const nxt = path.join(d, 'tools.new');
  mkdirs(path.join(cur, 'trust'), nxt);
  writeFile(path.join(cur, 'trust/release-signing-keys.conf'), '{"revoked":["ed25519:0011223344556677"]}');
  r = bash('vp_stage_trust_copy "$@"; echo "rc=$?"', [path.join(d, 'notadir'), cur, nxt, NODE]);
  assert.match(r.stdout, /ENOTDIR/, r.stdout);
  assert.doesNotMatch(r.stdout, /일반 파일이 아니거나/);
  assert.equal(fs.readFileSync(path.join(nxt, 'trust/release-signing-keys.conf'), 'utf8'), '{"revoked":["ed25519:0011223344556677"]}', '지난 사본 유지');
});

test('VERIFY-04 ⑧ root 가 아닌 계정이 0750 CONFIG_DIR 를 읽으면 EACCES 라고 말한다(생성된 래퍼를 sudo 없이 실행한 경우)', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'H2'); mkdirs(d);
  const cfg = path.join(d, 'cfg'); fs.mkdirSync(cfg); fs.chmodSync(cfg, 0o750);
  writeFile(path.join(cfg, 'portal.env'), 'UPGRADE_SIGNATURE_POLICY=warn\n');
  const r = spawnSync('timeout', ['-k', '1', '8', 'setpriv', `--reuid=${NB.uid}`, `--regid=${NB.gid}`, '--clear-groups', '--', 'bash', '-c',
    `source "${LIB}"; o="$(vp_root_read "$1/portal.env" "$2")"; echo "rc=$? [$o]"; v="$(vp_root_env_policy "$1" "$2")"; echo "v=[$v]"`, '_', cfg, NODE], { encoding: 'utf8', cwd: '/' });
  assert.match(r.stdout, /rc=12 \[open:EACCES\]/, r.stdout + r.stderr);
  assert.match(r.stdout, /v=\[\]/);
  assert.match(r.stderr, /권한이 없습니다\(EACCES/);
  assert.doesNotMatch(r.stderr, /일반 파일이 아니거나/);
});

/* ── VERIFY-05 ───────────────────────────────────────────────────────────────────────────────────────────── */
test('VERIFY-05 ⑨ root 소유라도 그룹·기타가 쓸 수 있는 portal.env 의 정책은 root 확인이 받지 않는다(node·폴백 경로 둘 다)', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'I'); mkdirs(d);
  const pe = path.join(d, 'portal.env');
  for (const [mode, want] of [[0o644, 'warn'], [0o640, 'warn'], [0o664, ''], [0o666, ''], [0o646, '']]) {
    writeFile(pe, 'UPGRADE_SIGNATURE_POLICY=warn\n', mode); fs.chownSync(pe, 0, NB.gid);
    for (const node of [NODE, '']) {
      const r = bash('v="$(vp_root_env_policy "$1" "$2")"; echo "v=[$v]"', [d, node]);
      assert.match(r.stdout, new RegExp(`v=\\[${want}\\]`), `mode ${mode.toString(8)} node=${node ? 'O' : 'X'}: ${r.stdout}${r.stderr}`);
      if (!want) assert.match(r.stderr, /그룹·기타가 쓸 수 있어/);
    }
  }
});

test('VERIFY-05 ⑩ 생성된 root 래퍼(vmware-portal-verify) — 그룹 쓰기 root portal.env 의 warn 을 확인 도구에 넘기지 않는다(래퍼가 새 함수를 싣는다)', { skip: ROOT_ONLY }, () => {
  const d = path.join(base, 'L'); mkdirs(d);
  const TOOLS = path.join(d, 'tools');
  writeFile(path.join(TOOLS, 'verify/node'), `#!/bin/sh\nexec '${NODE}' "$@"\n`, 0o755);
  writeFile(path.join(TOOLS, 'verify/server/src/upgrade/verifyCli.js'), "console.log('POLICY=[' + (process.env.UPGRADE_SIGNATURE_POLICY || '') + ']');\n");
  const CFG = path.join(d, 'etc'); mkdirs(CFG);
  const out = path.join(TOOLS, 'vmware-portal-verify');
  let r = bash('vp_write_launcher "$@"', [out, 'verify', '/opt/vp', 'nobody', 'vp-svc', CFG, TOOLS]);
  assert.equal(r.status, 0, r.stderr);
  const txt = fs.readFileSync(out, 'utf8');
  for (const fn of ['vp_root_read', 'vp_safe_read', 'vp_root_read_text', 'vp_root_env_policy']) assert.match(txt, new RegExp(`^${fn} \\(\\)`, 'm'), `래퍼에 ${fn}`);
  assert.equal(spawnSync('bash', ['-n', out]).status, 0);
  const env = { ...process.env }; delete env.UPGRADE_SIGNATURE_POLICY;
  const pe = path.join(CFG, 'portal.env');
  writeFile(pe, 'UPGRADE_SIGNATURE_POLICY=warn\n', 0o664); fs.chownSync(pe, 0, NB.gid);
  r = spawnSync('timeout', ['8', out], { encoding: 'utf8', env });
  assert.match(r.stdout, /POLICY=\[\]/, r.stdout + r.stderr);
  assert.match(r.stderr, /그룹·기타가 쓸 수 있어/);
  fs.chmodSync(pe, 0o644);
  r = spawnSync('timeout', ['8', out], { encoding: 'utf8', env });
  assert.match(r.stdout, /POLICY=\[warn\]/, r.stdout + r.stderr);
});

/* ── VERIFY-06 ───────────────────────────────────────────────────────────────────────────────────────────── */
// 예전 판본의 폴백은 'exec {fd}<"$f"', 새 판본은 시한 있는 한 번 열기('exec timeout …') 직전 — 한 번만 바꾼다(mv 로 갈아끼운다)
const SWAP = (file, spare, mark) => `set -T
trap 'if [[ ! -e "${mark}" && ( "$BASH_COMMAND" == exec\\ \\{fd\\}* || "$BASH_COMMAND" == exec\\ timeout* ) ]]; then : > "${mark}"; mv -f -- "${spare}" "${file}"; fi' DEBUG
`;

test('VERIFY-06 ⑪ vp_stage_trust_copy — node 를 실행할 수 없으면 원본을 열지 않는다(확인 뒤 FIFO 로 바꿔도 매달리지 않고 지난 사본 유지)', () => {
  for (const [label, node] of [['실행 불가 node', 'noexec'], ['node 없음', '']]) {
    const d = path.join(base, `J-${label.length}-${node || 'none'}`); const cdir = path.join(d, 'etc'); const cur = path.join(d, 'tools'); const nxt = path.join(d, 'tools.new');
    mkdirs(cdir, path.join(cur, 'trust'), nxt);
    const prev = '{"revoked":["ed25519:0011223344556677"]}';
    writeFile(path.join(cur, 'trust/release-signing-keys.conf'), prev);
    const src = path.join(cdir, 'release-signing-keys.conf');
    writeFile(src, '{"keys":[]}');
    const spare = path.join(d, 'spare.fifo'); mkfifo(spare);
    const mark = path.join(d, '.swapped');
    let n = '';
    if (node === 'noexec') { n = path.join(d, 'node'); writeFile(n, `#!/bin/sh\nexec '${NODE}' "$@"\n`, 0o644); }
    const r = bash(`${SWAP(src, spare, mark)}vp_stage_trust_copy "$@"; echo "rc=$?"`, [cdir, cur, nxt, n]);
    assert.equal(r.hung, false, `${label}: 매달리면 안 된다(${r.ms}ms) — ${r.stdout}${r.stderr}`);
    assert.ok(!fs.existsSync(mark), `${label}: 원본을 다시 열려고 하지 않는다(바꿔치기 지점에 오지 않는다)`);
    assert.match(r.stdout, /rc=0\n?$/);
    assert.match(r.stdout, /검사용 node/);
    assert.equal(fs.readFileSync(path.join(nxt, 'trust/release-signing-keys.conf'), 'utf8'), prev, `${label}: 지난 사본(회수)이 그대로다`);
    assert.ok(!fs.existsSync(path.join(nxt, 'trust/release-signing-keys.conf.part')));
  }
});

test('VERIFY-06 ⑫ vp_root_env_policy 의 node 없는 폴백 — 확인 뒤 FIFO 로 바꾸면 시한에서 끊고, 링크로 바꾸면 그 대상의 정책을 쓰지 않는다', { skip: ROOT_ONLY }, () => {
  // FIFO
  let d = path.join(base, 'K1'); mkdirs(d);
  writeFile(path.join(d, 'portal.env'), 'UPGRADE_SIGNATURE_POLICY=warn\n');
  let spare = path.join(d, 'spare.fifo'); mkfifo(spare);
  let mark = path.join(d, '.swapped');
  let r = bash(`${SWAP(path.join(d, 'portal.env'), spare, mark)}v="$(vp_root_env_policy "$1" "")"; echo "v=[$v]"`, [d], { env: { ...process.env, VP_ROOT_READ_TIMEOUT: '2' } });
  assert.equal(r.hung, false, `매달리면 안 된다(${r.ms}ms) — ${r.stderr}`);
  assert.ok(fs.existsSync(mark), '바꿔치기가 실제로 일어났다');
  assert.match(r.stdout, /v=\[\]/);
  assert.match(r.stderr, /시한\(2초\)/);
  // 링크 → root 소유 파일(정책 warn)
  d = path.join(base, 'K2'); mkdirs(d);
  writeFile(path.join(d, 'portal.env'), 'UPGRADE_SIGNATURE_POLICY=require\n');
  const target = path.join(base, 'K2-target.env');
  writeFile(target, 'UPGRADE_SIGNATURE_POLICY=warn\n');
  spare = path.join(d, 'spare.link'); fs.symlinkSync(target, spare);
  mark = path.join(d, '.swapped');
  r = bash(`${SWAP(path.join(d, 'portal.env'), spare, mark)}v="$(vp_root_env_policy "$1" "")"; echo "v=[$v]"`, [d], { env: { ...process.env, VP_ROOT_READ_TIMEOUT: '2' } });
  assert.ok(fs.existsSync(mark), '바꿔치기가 실제로 일어났다');
  assert.match(r.stdout, /v=\[\]/, `링크 대상의 정책을 쓰지 않는다: ${r.stdout}${r.stderr}`);
  // 바꿔치기가 없으면 폴백도 예전처럼 읽는다
  d = path.join(base, 'K3'); mkdirs(d);
  writeFile(path.join(d, 'portal.env'), 'A=1\nUPGRADE_SIGNATURE_POLICY=warn\n');
  r = bash('v="$(vp_root_env_policy "$1" "")"; echo "v=[$v]"', [d]);
  assert.match(r.stdout, /v=\[warn\]/, r.stderr);
});
