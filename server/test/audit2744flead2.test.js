// v2.744 최종 검토 — 리드 통합분 ②: FH(RZ-REV-03)가 담당 밖이라 남긴 형제 경로 2곳(packaging/offline/release-verify-lib.sh).
//   vp_root_env_policy · vp_stage_trust_copy 는 root 로 돌면서 서비스 계정이 쓸 수 있는 CONFIG_DIR 의 파일(portal.env · 호스트 신뢰 키 파일)을
//   `[[ -f && ! -L ]]` 로 확인한 뒤 bash 로 **다시** 열었다 — 그 사이에 이름을 FIFO 로 바꾸면 열기가 막혀 root 가 무기한 매달리고
//   (install.sh · vmware-portal-verify), 링크로 바꾸면 따라간다. 이제 vp_root_read(node 가 O_NOFOLLOW·O_NONBLOCK·O_NOCTTY 로 한 번 열고
//   그 fd 로 일반 파일·하드 링크 없음·크기 상한을 본 뒤 그 fd 에서 읽는다)로 한 번만 연다.
// 바꿔치기는 우연에 맡기지 않는다 — bash DEBUG 트랩(set -T)으로 '확인 뒤, 열기 직전' 에 이름을 FIFO 로 바꿔 결정적으로 재현한다.
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
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744flead2-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const bash = (body, args = []) => {
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', `set -uo pipefail\nsource "${LIB}"\n${body}`, '_', ...args], { encoding: 'utf8', timeout: 8000, env: { ...process.env, VP_NODE: process.execPath } });
  return { ...r, ms: Date.now() - t0, hung: r.status === null };
};
// '확인 뒤, 열기 직전' 바꿔치기 — 예전 코드는 `exec {fd}<"$f"`, 새 코드는 node 실행 직전이다. 한 번만 바꾼다(표지 파일).
const SWAP = (file, mark) => `set -T
trap 'if [[ ! -e "${mark}" && ( "$BASH_COMMAND" == exec\\ \\{fd\\}* || "$BASH_COMMAND" == *"\\$node\\" -e"* ) ]]; then : > "${mark}"; rm -f -- "${file}"; mkfifo -- "${file}"; fi' DEBUG
`;

test('① vp_root_read — 일반 파일만 읽고 링크·FIFO·하드 링크·없는 파일은 열지 않는다(매달리지 않는다)', () => {
  const d = path.join(base, 'rr'); fs.mkdirSync(d);
  const f = path.join(d, 'portal.env');
  fs.writeFileSync(f, 'A=1\nUPGRADE_SIGNATURE_POLICY=warn\n');
  let r = bash('vp_root_read "$1" "$VP_NODE"; echo "rc=$?"', [f]);
  assert.match(r.stdout, /^\d+ [0-7]+\nA=1\nUPGRADE_SIGNATURE_POLICY=warn\nrc=0\n$/, r.stdout + r.stderr);
  const link = path.join(d, 'link.env'); fs.symlinkSync(f, link);
  r = bash('vp_root_read "$1" "$VP_NODE"; echo "rc=$?"', [link]);
  assert.match(r.stdout, /rc=10\n?$/, '링크는 따라가지 않는다');
  const fifo = path.join(d, 'fifo.env');
  spawnSync('mkfifo', [fifo]);
  r = bash('vp_root_read "$1" "$VP_NODE"; echo "rc=$?"', [fifo]);
  assert.equal(r.hung, false, 'FIFO 에서 매달리지 않는다');
  assert.match(r.stdout, /rc=10\n?$/);
  const hard = path.join(d, 'hard.env'); fs.linkSync(f, hard);
  r = bash('vp_root_read "$1" "$VP_NODE"; echo "rc=$?"', [hard]);
  assert.match(r.stdout, /rc=10\n?$/, '하드 링크(nlink 2)는 읽지 않는다');
  fs.rmSync(hard);
  r = bash('vp_root_read "$1" "$VP_NODE"; echo "rc=$?"', [path.join(d, 'none.env')]);
  assert.match(r.stdout, /rc=11\n?$/);
  r = bash('vp_root_read "$1" ""; echo "rc=$?"', [f]);
  assert.match(r.stdout, /rc=3\n?$/, 'node 가 없으면 3(호출부가 예전 경로로)');
  // 사본 경로를 주면 내용은 그 파일에, stdout 은 첫 줄만
  const out = path.join(d, 'copy.part');
  r = bash('vp_root_read "$1" "$VP_NODE" "$2"; echo "rc=$?"', [f, out]);
  assert.match(r.stdout, /^\d+ [0-7]+\nrc=0\n$/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'A=1\nUPGRADE_SIGNATURE_POLICY=warn\n');
  // 크기 상한
  r = spawnSync('bash', ['-c', `source "${LIB}"\nVP_ROOT_READ_MAX_BYTES=4 vp_root_read "$1" "$2"; echo "rc=$?"`, '_', f, process.execPath], { encoding: 'utf8', timeout: 8000 });
  assert.match(r.stdout, /rc=10\n?$/);
});

test('② vp_root_env_policy — 확인 뒤 FIFO 로 바꿔치기해도 root 가 매달리지 않는다(예전 코드는 열기에서 무기한 대기)', () => {
  const cdir = path.join(base, 'pol'); fs.mkdirSync(cdir);
  const f = path.join(cdir, 'portal.env');
  fs.writeFileSync(f, 'UPGRADE_SIGNATURE_POLICY=warn\n');
  const mark = path.join(cdir, '.swapped');
  const r = bash(`${SWAP(f, mark)}v="$(vp_root_env_policy "$1" "$VP_NODE")"; echo "v=[$v]"`, [cdir]);
  assert.equal(r.hung, false, `매달리지 않는다(${r.ms}ms) — ${r.stderr}`);
  assert.ok(fs.existsSync(mark), '바꿔치기가 실제로 일어났다');
  assert.match(r.stdout, /v=\[\]/, 'FIFO 의 값은 쓰지 않는다');
  assert.match(r.stderr, /일반 파일이 아니거나/);
});

test('② -b vp_root_env_policy — 링크·서비스 계정 소유 파일의 정책은 쓰지 않고, root 소유 일반 파일만 쓴다', { skip: IS_ROOT ? false : 'root 소유 파일을 만들 수 없다(비 root)' }, () => {
  const cdir = path.join(base, 'pol2'); fs.mkdirSync(cdir);
  const f = path.join(cdir, 'portal.env');
  fs.writeFileSync(f, 'X=1\nUPGRADE_SIGNATURE_POLICY=require\n');
  let r = bash('v="$(vp_root_env_policy "$1" "$VP_NODE")"; echo "v=[$v]"', [cdir]);
  assert.match(r.stdout, /v=\[require\]/, r.stderr);
  // 서비스 계정 소유(여기서는 nobody 로 바꾼다)
  const nobody = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim();
  if (nobody) {
    fs.chownSync(f, Number(nobody), Number(nobody));
    r = bash('v="$(vp_root_env_policy "$1" "$VP_NODE")"; echo "v=[$v]"', [cdir]);
    assert.match(r.stdout, /v=\[\]/);
    assert.match(r.stderr, /root 소유가 아니라/);
  }
  // root 소유 파일을 가리키는 링크 — 따라가지 않는다
  const target = path.join(base, 'root-target.env');
  fs.writeFileSync(target, 'UPGRADE_SIGNATURE_POLICY=warn\n');
  fs.rmSync(f); fs.symlinkSync(target, f);
  r = bash('v="$(vp_root_env_policy "$1" "$VP_NODE")"; echo "v=[$v]"', [cdir]);
  assert.match(r.stdout, /v=\[\]/, '링크 너머 root 파일의 값을 쓰지 않는다');
});

test('③ vp_stage_trust_copy — 확인 뒤 FIFO 로 바꿔치기해도 매달리지 않고 지난 사본(회수)을 그대로 둔다', () => {
  const b = path.join(base, 'st'); const cdir = path.join(b, 'etc'); const cur = path.join(b, 'tools'); const nxt = path.join(b, 'tools.new');
  for (const d of [cdir, path.join(cur, 'trust'), nxt]) fs.mkdirSync(d, { recursive: true });
  const prev = JSON.stringify({ revoked: ['ed25519:0011223344556677'] });
  fs.writeFileSync(path.join(cur, 'trust', 'release-signing-keys.conf'), prev);
  const src = path.join(cdir, 'release-signing-keys.conf');
  fs.writeFileSync(src, JSON.stringify({ keys: [] }));
  const mark = path.join(b, '.swapped');
  const r = bash(`${SWAP(src, mark)}vp_stage_trust_copy "$@"; echo "rc=$?"`, [cdir, cur, nxt, process.execPath]);
  assert.equal(r.hung, false, `매달리지 않는다(${r.ms}ms) — ${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(mark), '바꿔치기가 실제로 일어났다');
  assert.match(r.stdout, /rc=0\n?$/);
  assert.equal(fs.readFileSync(path.join(nxt, 'trust', 'release-signing-keys.conf'), 'utf8'), prev, '지난 사본(회수)이 그대로다');
  assert.ok(!fs.existsSync(path.join(nxt, 'trust', 'release-signing-keys.conf.part')), '조각 파일을 남기지 않는다');
});

test('④ 생성되는 root 래퍼(vmware-portal-verify)도 vp_root_read 를 싣고 root 소유 확인 node 로 정책을 읽는다', () => {
  const out = path.join(base, 'launcher');
  const r = spawnSync('bash', ['-c', `source "${LIB}"\nvp_write_launcher "$1" verify /opt/vp vmportal vmware-portal /etc/vmware-portal /usr/local/libexec/vmware-portal/opt/vp`, '_', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const txt = fs.readFileSync(out, 'utf8');
  assert.match(txt, /^vp_root_read \(\)/m, '래퍼에 단일 열기 함수가 있다');
  assert.match(txt, /vp_root_env_policy "\$CONFIG_DIR" "\$TOOLS\/verify\/node"/, '정책을 root 소유 확인 node 로 읽는다');
  assert.equal(spawnSync('bash', ['-n', out]).status, 0, '래퍼 문법');
});
