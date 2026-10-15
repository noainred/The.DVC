/**
 * v2.741 감사 GK(패키징·설치 권한) 회귀 — INJPKG-01 · INJPKG-03 · INJPKG-05.
 *
 *  INJPKG-01 root 로 실행되는 래퍼·오프라인 서명 확인의 신뢰 기준을 서비스 계정(vmportal)이 쓸 수 있었다.
 *    ① root 소유 래퍼(release-verify-lib.sh vp_install_root_tools)는 앱 트리를 읽기 전에 서비스 계정으로 권한을 내린다
 *    ② 오프라인 서명 확인은 root 소유 사본만 신뢰 기준으로 쓰고, 사본이 없는 옛 설치본의 도구는 그 소유 계정 권한으로 돈다
 *    ③ root 로 읽는 호스트 신뢰 키 파일은 uid 0 소유일 때만 받는다(signature.js loadTrust)
 *  INJPKG-03 install.sh/uninstall.sh 의 --prefix 가 /usr·/etc·/var/lib·// 를 통과시켰다(chown -R · rm -rf).
 *  INJPKG-05 패키지 빌드의 config 정리가 거부 목록이라 나열하지 않은 파일이 배포물에 섞였다 → 허용 목록.
 *
 * root 권한이 필요한 시나리오(권한 내림·소유자 판정)는 root 로 돌 때만 실행한다 — CI(비 root)는 건너뛴 사실을 남긴다.
 * ⚠ uninstall.sh 는 통째로 실행하지 않는다(시스템 서비스를 끄고 지운다) — 판정 함수만 꺼내 실행한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const idOf = (flag, u) => { try { return Number(execFileSync('id', [flag, u], { encoding: 'utf8' }).trim()); } catch { return null; } };
const NOBODY = { uid: idOf('-u', 'nobody'), gid: idOf('-g', 'nobody') };
const ROOT_ONLY = !IS_ROOT || NOBODY.uid == null
  ? 'root 권한과 nobody 계정이 필요한 시나리오(권한 내림·소유자 판정) — 이 환경에서는 건너뜀'
  : false;

const CFG0 = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741l-cfg-'));
process.env.CONFIG_DIR = CFG0;
delete process.env.UPGRADE_SIGNATURE_POLICY;
const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');

const cleanup = [CFG0];
after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const K1 = crypto.generateKeyPairSync('ed25519');
const K3 = crypto.generateKeyPairSync('ed25519');
const kid = (k) => core.keyIdOf(k.publicKey);
const keysDoc = (keys) => JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: keys.map((k) => ({ keyId: kid(k), publicKey: core.spkiBase64Of(k.publicKey) })), revoked: [] });
function signFor(key, version, name, bytes) {
  const m = core.buildManifest({ version, keyId: kid(key), files: [{ name, kind: 'installer', platform: 'any', size: bytes.length, sha256: core.sha256Hex(bytes) }] });
  return core.serializeEnvelope(core.signManifest(m, key.privateKey));
}

/** 셸 스크립트에서 이름의 함수 정의를 꺼낸다(맨 앞 `name() {` ~ 줄 첫머리 `}`). 없으면 null. */
function shellFn(text, name) {
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}
const bash = (script, args = [], opt = {}) => spawnSync('bash', ['-c', script, '_', ...args], { encoding: 'utf8', ...opt });

/* ── INJPKG-03 ─────────────────────────────────────────────────────────────────────────────────────────── */
const BAD_PREFIXES = ['/', '//', '/usr', '/usr/', '/etc', '/etc/vmware-portal', '/var/lib', '/var', '/usr/local', '//usr//local//', '/opt',
  '/home/admin', '/root', '/root/vp', '/home', '/bin/vp', '/lib64/x', '/opt/./x', '/opt/../etc', '/opt/a b', 'opt/vp'];
const GOOD_PREFIXES = [['/opt/vmware-portal', '/opt/vmware-portal'], ['/opt/vmware-portal/', '/opt/vmware-portal'],
  ['//opt//vmware-portal//', '/opt/vmware-portal'], ['/usr/local/vmware-portal', '/usr/local/vmware-portal'],
  ['/var/lib/vmware-portal', '/var/lib/vmware-portal'], ['/data/vmware-portal', '/data/vmware-portal'], ['/srv/vp', '/srv/vp'],
  ['/home/admin/portal', '/home/admin/portal'], ['/vmware-portal', '/vmware-portal']];

test('INJPKG-03 ① install.sh·uninstall.sh 의 --prefix 판정 함수는 글자 그대로 같고, 시스템 경로를 거부한다', () => {
  const fi = shellFn(rd('packaging/offline/install.sh'), 'vp_check_prefix');
  const fu = shellFn(rd('packaging/offline/uninstall.sh'), 'vp_check_prefix');
  assert.ok(fi && fu, '두 스크립트에 vp_check_prefix 가 있어야 한다');
  assert.equal(fu, fi, '같은 규칙 — 한쪽만 고치면 설치와 제거의 판정이 갈라진다');
  const run = (p) => bash(`${fu}\nVP_PREFIX=''\nvp_check_prefix "$1" && echo "OK:$VP_PREFIX"`, [p]);
  for (const p of BAD_PREFIXES) {
    const r = run(p);
    assert.notEqual(r.status, 0, `거부해야 한다: '${p}' → ${r.stdout}`);
    assert.match(r.stderr, /--prefix/, `거부 사유를 말한다: '${p}'`);
  }
  for (const [p, norm] of GOOD_PREFIXES) {
    const r = run(p);
    assert.equal(r.status, 0, `받아야 한다: '${p}' (${r.stderr})`);
    assert.equal(r.stdout.trim(), `OK:${norm}`, `정규화: '${p}'`);
  }
});

test('INJPKG-03 ② install.sh 는 시스템 경로 --prefix 를 무엇도 건드리기 전에 거부한다(실제 스크립트)', () => {
  // 이 저장소 폴더에는 runtime/·app/ 이 없어 통과한 값은 '패키지 구조' 검사에서 멈춘다(설치를 하지 않는다).
  const inst = path.join(ROOT, 'packaging/offline/install.sh');
  for (const p of ['/usr', '/etc', '/var/lib', '//', '/usr/local']) {
    const r = spawnSync('bash', [inst, '--prefix', p], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--prefix/, `'${p}' 는 prefix 단계에서 거부돼야 한다: ${r.stderr.slice(0, 200)}`);
  }
  const ok = spawnSync('bash', [inst, '--prefix', '/opt/vmware-portal-audit2741l-none/'], { encoding: 'utf8' });
  assert.equal(ok.status, 1);
  assert.doesNotMatch(ok.stderr, /--prefix/, '정상 값은 prefix 단계를 지난다');
});

test('INJPKG-03 ③ 이미 있는 폴더는 포탈 설치본이거나 비어 있을 때만 받고, uninstall 은 설치본일 때만 지운다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741l-pfx-'));
  cleanup.push(base);
  const dirOk = shellFn(rd('packaging/offline/install.sh'), 'vp_prefix_dir_ok');
  assert.ok(dirOk);
  const check = (d) => bash(`${dirOk}\nvp_prefix_dir_ok "$1"`, [d]).status;
  const mk = (name, files = []) => { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); } return d; };
  assert.equal(check(path.join(base, 'none')), 0, '없는 폴더');
  assert.equal(check(mk('empty')), 0, '빈 폴더');
  assert.equal(check(mk('mount', ['lost+found/x'])), 0, 'lost+found 만 있는 마운트 지점');
  assert.equal(check(mk('inst', ['app/server/src/index.js', 'notes.txt'])), 0, '포탈 설치본');
  assert.notEqual(check(mk('other', ['www/index.html'])), 0, '다른 프로그램의 폴더 — chown -R 하지 않는다');
  assert.notEqual(check(mk('dot', ['.bashrc'])), 0, '점 파일만 있어도 빈 폴더가 아니다');
  fs.symlinkSync(mk('real'), path.join(base, 'link'));
  assert.notEqual(check(path.join(base, 'link')), 0, '심볼릭 링크 prefix');
  const un = rd('packaging/offline/uninstall.sh');
  const isInst = /\nvp_prefix_is_install\(\) \{[^\n]*\}\n/.exec(un)?.[0];
  assert.ok(isInst, 'uninstall.sh vp_prefix_is_install');
  const isI = (d) => bash(`${isInst}\nvp_prefix_is_install "$1"`, [d]).status;
  assert.equal(isI(path.join(base, 'inst')), 0);
  assert.notEqual(isI(path.join(base, 'other')), 0, '설치본이 아니면 rm -rf 하지 않는다');
  const unCode = un.replace(/^\s*#.*$/gm, '');
  assert.ok(unCode.indexOf('rm -rf "$PREFIX"') > 0);
  assert.ok(unCode.indexOf('if vp_prefix_is_install "$PREFIX"; then') < unCode.indexOf('rm -rf "$PREFIX"'), 'rm -rf 는 설치본 확인 뒤');
});

/* ── INJPKG-05 ─────────────────────────────────────────────────────────────────────────────────────────── */
test('INJPKG-05 패키지 빌드의 config 정리는 예제(*.example.json)만 남긴다 — offline·Windows 두 빌드 모두', () => {
  const tracked = execFileSync('git', ['ls-files', 'server/config'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(tracked.length > 0);
  for (const f of tracked) assert.match(f, /\.example\.json$/, `저장소에 추적되는 server/config 파일은 예제뿐이어야 한다: ${f}`);
  for (const script of ['packaging/offline/build-package.sh', 'packaging/windows/build-collector-win.sh']) {
    const m = /\nfind "\$APP\/server\/config"[^\n]*\\\n[^\n]*\n/.exec(rd(script));
    assert.ok(m, `${script}: config 정리 find`);
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741l-cfgclean-'));
    cleanup.push(app);
    const cfg = path.join(app, 'server/config');
    fs.mkdirSync(path.join(cfg, 'vmseries'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sub'), { recursive: true });
    for (const f of ['vcenters.example.json', 'users.example.json', 'users.json', '.users.json.tmp-123-456', 'ipam-vcenter-ranges.json.pre-v2.691-1.bak',
      'release-signing-keys.conf', 'rma-default.env', 'vmware-portal-release', 'auth-secret', 'secrets-key', 'portal.env', 'x.db', 'x.db-wal',
      'audit.ndjson', 'initial-admin-password.txt', 'ping-targets.json.corrupt.1', '.hidden', 'vmseries/a.db', 'sub/b.example.json']) {
      fs.writeFileSync(path.join(cfg, f), 'x');
    }
    const r = bash(`APP="$1"\n${m[0]}`, [app]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(cfg).sort(), ['users.example.json', 'vcenters.example.json'], `${script}: 예제만 남는다`);
  }
});

/* ── INJPKG-01 ③ signature.js — root 로 읽는 호스트 키 파일은 uid 0 소유일 때만 ───────────────────────── */
test('INJPKG-01 ③ loadTrust: root 판정이면 root 소유가 아닌 호스트 키 파일은 무시하고 알린다(정책은 약해지지 않는다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741l-trust-'));
  cleanup.push(dir);
  const repo = path.join(dir, 'repo.json');
  fs.writeFileSync(repo, keysDoc([K1]));
  const host = path.join(dir, 'release-signing-keys.conf');
  fs.writeFileSync(host, keysDoc([K3]), { mode: 0o600 });
  fs.chmodSync(host, 0o600);
  // 서비스(비 root) 판정 — 예전 그대로 읽는다(같은 신뢰 수준의 파일이다)
  const svc = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: false });
  assert.equal(svc.sources.host.count, 1);
  assert.ok(svc.byId.has(kid(K3)));
  // root 판정 + uid 0 이 아닌 파일 → 무시(키를 받지 않는다) · fatal 아님 · 파일이 있다는 사실은 남긴다
  if (IS_ROOT) fs.chownSync(host, NOBODY.uid ?? 65534, NOBODY.gid ?? 65534);
  if (IS_ROOT || process.getuid?.() !== 0) {
    const t = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true });
    assert.equal(t.sources.host.ignored, 'not-root-owned');
    assert.equal(t.sources.host.present, true);
    assert.equal(t.fatal, null);
    assert.ok(!t.byId.has(kid(K3)), '서비스 계정이 넣은 키를 root 확인이 믿으면 안 된다');
    assert.ok(t.byId.has(kid(K1)), '저장소(root 소유 사본) 키는 그대로');
    assert.equal(sigmod.signaturePolicy({}, t).policy, 'require', '무시한 호스트 파일이 정책을 키 미설정(warn)으로 낮추지 않는다');
    // 기본값: root 프로세스면 자동으로 root 판정
    if (IS_ROOT) assert.equal(sigmod.loadTrust({ repoFile: repo, hostFile: host }).sources.host.ignored, 'not-root-owned');
  }
  if (IS_ROOT) {
    // root 소유면 받는다 · 심볼릭 링크는 받지 않는다(링크 대상을 바꿔치기할 수 있다)
    fs.chownSync(host, 0, 0);
    assert.ok(sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true }).byId.has(kid(K3)));
    const link = path.join(dir, 'link.conf');
    fs.symlinkSync(host, link);
    const tl = sigmod.loadTrust({ repoFile: repo, hostFile: link, rootOwnedOnly: true });
    assert.equal(tl.sources.host.ignored, 'not-root-owned');
    assert.ok(!tl.byId.has(kid(K3)));
  }
});

/* ── INJPKG-01 ①② root 소유 도구·서명 확인 신뢰 기준(실제 bash · 실제 verifyCli) ─────────────────────── */
test('INJPKG-01 ①② 옛 설치본 도구는 소유 계정 권한으로 · install 이 만든 root 소유 사본은 root 로 · 래퍼는 앱 트리를 서비스 계정으로 실행', { skip: ROOT_ONLY }, () => {
  const BASE = fs.mkdtempSync('/tmp/audit2741l-');
  cleanup.push(BASE);
  fs.chmodSync(BASE, 0o755);
  const NB = NOBODY;
  const LIB = path.join(ROOT, 'packaging/offline/release-verify-lib.sh');
  const TOOLS_BASE = path.join(BASE, 'libexec');
  const CFG = path.join(BASE, 'etc');
  const TMP = path.join(BASE, 'tmp');
  for (const d of [CFG, TMP]) { fs.mkdirSync(d); fs.chmodSync(d, 0o755); }
  const MARK = path.join(BASE, 'node-uids');
  fs.writeFileSync(MARK, ''); fs.chmodSync(MARK, 0o666);
  // node 대신 쓰는 작은 래퍼 — 어느 사본(old = 옛 설치본 · pkg = 패키지에서 만든 root 소유 사본)이 어떤 uid 로 돌았는지 남긴다.
  const nodeWrapper = (file, tag) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho "${tag}:$(id -u)" >> '${MARK}'\nexec '${process.execPath}' "$@"\n`);
    fs.chmodSync(file, 0o755);
  };
  const appTree = (dir) => {
    fs.mkdirSync(path.join(dir, 'app/server'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'server/src'), path.join(dir, 'app/server/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/server/src/upgrade/release-signing-keys.json'), keysDoc([K1]));
    fs.copyFileSync(path.join(ROOT, 'server/package.json'), path.join(dir, 'app/server/package.json'));
    fs.writeFileSync(path.join(dir, 'app/package.json'), JSON.stringify({ version: '10.0.1' }));
  };
  // 옛 설치본(서비스 계정 = nobody 소유 — install.sh 의 chown -R 과 같은 상태)
  const PREFIX = path.join(BASE, 'opt/vp');
  appTree(PREFIX);
  nodeWrapper(path.join(PREFIX, 'runtime/node/bin/node'), 'old');
  fs.writeFileSync(path.join(PREFIX, 'app/otp-enroll.sh'), 'echo "uid=$(id -u) launcher=${VP_LAUNCHER:-} cfg=$CONFIG_DIR hint=${VP_LAUNCHER_CMD:-}"\n');
  fs.writeFileSync(path.join(PREFIX, 'app/user-admin.sh'), 'echo "uid=$(id -u)"\nexit 10\n');
  fs.copyFileSync(path.join(ROOT, 'packaging/offline/release-verify.sh'), path.join(PREFIX, 'app/release-verify.sh'));
  for (const f of ['app/otp-enroll.sh', 'app/user-admin.sh', 'app/release-verify.sh']) fs.chmodSync(path.join(PREFIX, f), 0o755);
  fs.chmodSync(path.join(BASE, 'opt'), 0o755);
  execFileSync('chown', ['-R', `${NB.uid}:${NB.gid}`, PREFIX]);
  // 새 패키지(root 가 푼 폴더 — 신뢰 사본의 원천)
  const PKGDIR = path.join(BASE, 'pkg');
  const name = 'vmware-portal-offline-10.0.2-el9-x64';
  const SDIR = path.join(PKGDIR, name);
  appTree(SDIR);
  nodeWrapper(path.join(SDIR, 'runtime/node/bin/node'), 'pkg');
  fs.chmodSync(PKGDIR, 0o700);   // 서비스 계정은 패키지 폴더를 못 읽는다(/root 아래 푼 경우와 같다)
  const pkgBytes = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(PKGDIR, `${name}.tar.gz`), pkgBytes);
  fs.writeFileSync(path.join(PKGDIR, 'vmware-portal-10.0.2.manifest.json'), signFor(K1, '10.0.2', `${name}.tar.gz`, pkgBytes));
  const evilDir = path.join(BASE, 'evil');
  fs.mkdirSync(evilDir);
  const evilBytes = crypto.randomBytes(4096);
  const evilPkg = path.join(evilDir, `${name}.tar.gz`);
  const evilMan = path.join(evilDir, 'vmware-portal-10.0.2.manifest.json');
  fs.writeFileSync(evilPkg, evilBytes);
  fs.writeFileSync(evilMan, signFor(K3, '10.0.2', `${name}.tar.gz`, evilBytes));

  const env = { ...process.env, VP_ROOT_TOOLS_BASE: TOOLS_BASE, TMPDIR: TMP };
  delete env.UPGRADE_SIGNATURE_POLICY;
  const lib = (body, args = []) => bash(`set -euo pipefail\nsource "${LIB}"\n${body}`, args, { env });
  const marks = () => fs.readFileSync(MARK, 'utf8').split('\n').filter(Boolean);
  const verify = (pkg = '', man = '') => lib('verify_release_package "$@"', [PREFIX, SDIR, CFG, '10.0.2', pkg, man, '0']);

  // ② 옛 설치본(root 소유 사본 없음) — 도구를 그 소유 계정(nobody) 권한으로 실행한다. root 로 실행하면 안 된다.
  const legacy = verify();
  assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
  assert.match(legacy.stdout, new RegExp(`소유 계정\\(uid ${NB.uid}\\)`));
  assert.ok(marks().length > 0, '옛 도구를 실행했다');
  assert.ok(marks().every((u) => u === `old:${NB.uid}`), `옛 설치본의 node 는 root 로 돌면 안 된다: ${marks()}`);
  assert.deepEqual(fs.readdirSync(TMP), [], '확인용 임시 사본을 지운다');
  const legacyEvil = verify(evilPkg, evilMan);
  assert.equal(legacyEvil.status, 1, '신뢰 목록에 없는 키로 서명한 패키지는 옛 도구도 거부한다');

  // ① install.sh 가 방금 확인한 패키지로 root 소유 사본·래퍼를 만든다
  const inst = lib('vp_install_root_tools "$@"', [PREFIX, SDIR, 'nobody', 'vp-audit2741l-svc', CFG]);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const TOOLS = path.join(TOOLS_BASE, PREFIX);
  for (const f of ['vmware-portal-otp', 'vmware-portal-users', 'vmware-portal-verify', 'verify/node', 'verify/server/src/upgrade/verifyCli.js']) {
    const st = fs.statSync(path.join(TOOLS, f));
    assert.equal(st.uid, 0, `${f} 는 root 소유`);
    assert.equal(st.mode & 0o022, 0, `${f} 는 그룹·기타 쓰기 불가`);
  }
  assert.equal(lib('vp_anchor_ok "$1"', [TOOLS]).status, 0, '신뢰 사본 판정');
  for (const f of ['vmware-portal-otp', 'vmware-portal-users']) {
    const t = fs.readFileSync(path.join(TOOLS, f), 'utf8');
    assert.doesNotMatch(t, /\n\s*(source|\.)\s+"\$(PREFIX|APP_TOOL)/, '래퍼가 앱 트리를 root 셸로 읽지 않는다');
  }

  // ② 이제 확인은 root 소유 사본으로 — 옛 설치본(서비스 계정 소유)의 node 를 실행하지 않는다
  fs.writeFileSync(MARK, '');
  const anchored = verify();
  assert.equal(anchored.status, 0, anchored.stdout + anchored.stderr);
  assert.match(anchored.stdout, /root 소유 확인 도구/);
  assert.ok(marks().length > 0 && marks().every((u) => u === 'pkg:0'), `root 소유 사본만 실행(옛 설치본 node 0회): ${marks()}`);
  assert.equal(verify(evilPkg, evilMan).status, 1);

  // ③ 서비스 계정 소유 호스트 키 파일로 키를 더해도 root 확인은 믿지 않는다 · root 소유면 받는다
  const hostKeys = path.join(CFG, 'release-signing-keys.conf');
  fs.writeFileSync(hostKeys, keysDoc([K3]), { mode: 0o600 });
  fs.chownSync(hostKeys, NB.uid, NB.gid);
  const injected = verify(evilPkg, evilMan);
  assert.notEqual(injected.status, 0, `서비스 계정이 넣은 키로 서명 확인을 통과하면 안 된다: ${injected.stdout}${injected.stderr}`);
  fs.chownSync(hostKeys, 0, 0);
  const rooted = verify(evilPkg, evilMan);
  assert.equal(rooted.status, 0, `root 가 둔 호스트 키는 받는다: ${rooted.stdout}${rooted.stderr}`);
  fs.rmSync(hostKeys);
  // portal.env 정책도 root 소유일 때만 — 서비스 계정 소유 portal.env 의 warn 으로 manifest 없는 패키지를 통과시키지 못한다
  fs.writeFileSync(path.join(CFG, 'portal.env'), 'UPGRADE_SIGNATURE_POLICY=warn\n');
  fs.chownSync(path.join(CFG, 'portal.env'), NB.uid, NB.gid);
  const noMan = verify('', path.join(BASE, 'none.json'));
  assert.equal(noMan.status, 1, `서비스 계정 소유 portal.env 정책을 root 확인이 따르면 안 된다: ${noMan.stdout}`);
  fs.rmSync(path.join(CFG, 'portal.env'));

  // ① 래퍼 — root 로 불러도 앱 트리는 서비스 계정(nobody)으로 돈다
  const otp = spawnSync(path.join(TOOLS, 'vmware-portal-otp'), ['admin'], { encoding: 'utf8', env, cwd: PKGDIR });
  assert.equal(otp.status, 0, otp.stderr);
  assert.match(otp.stdout, new RegExp(`uid=${NB.uid} launcher=1 cfg=${CFG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), otp.stdout);
  assert.match(otp.stdout, /hint=sudo /);
  // users — 앱 트리는 nobody 로 돌고, '지금 재시작'(종료코드 10)은 root 래퍼가 systemctl 로 한다
  const fakeBin = path.join(BASE, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\necho "systemctl-uid=$(id -u) args=$*"\n`);
  fs.chmodSync(path.join(fakeBin, 'systemctl'), 0o755);
  const users = spawnSync(path.join(TOOLS, 'vmware-portal-users'), [], { encoding: 'utf8', env: { ...env, PATH: `${fakeBin}:${process.env.PATH}` } });
  assert.match(users.stdout, new RegExp(`uid=${NB.uid}\\n`), users.stdout);
  assert.match(users.stdout, /systemctl-uid=0 args=restart vp-audit2741l-svc/);
  assert.equal(users.status, 0, users.stderr);
  // verify 래퍼 — root 소유 사본으로 확인한다(옛 설치본 node 실행 0)
  fs.writeFileSync(MARK, '');
  const vw = spawnSync(path.join(TOOLS, 'vmware-portal-verify'), ['--file', path.join(PKGDIR, `${name}.tar.gz`), '--manifest', path.join(PKGDIR, 'vmware-portal-10.0.2.manifest.json')], { encoding: 'utf8', env });
  assert.equal(vw.status, 0, vw.stdout + vw.stderr);
  assert.ok(marks().length > 0 && marks().every((u) => u === 'pkg:0'), `${marks()}`);
  // 앱 트리의 release-verify.sh 를 root 로 불러도(변조되지 않았다면) root 소유 래퍼로 넘긴다
  fs.writeFileSync(MARK, '');
  const appVerify = spawnSync(path.join(PREFIX, 'app/release-verify.sh'), ['--file', path.join(PKGDIR, `${name}.tar.gz`), '--manifest', path.join(PKGDIR, 'vmware-portal-10.0.2.manifest.json')], { encoding: 'utf8', env });
  assert.equal(appVerify.status, 0, appVerify.stdout + appVerify.stderr);
  assert.ok(marks().length > 0 && marks().every((u) => u === 'pkg:0'), `앱 트리 런타임(서비스 계정 소유)을 root 로 실행하지 않는다: ${marks()}`);
  // 신뢰 사본이 변조 가능해지면(소유자 바뀜) 래퍼는 확인을 거부한다
  fs.chownSync(path.join(TOOLS, 'verify/server/src/upgrade/signature.js'), NB.uid, NB.gid);
  const tampered = spawnSync(path.join(TOOLS, 'vmware-portal-verify'), ['--policy'], { encoding: 'utf8', env });
  assert.equal(tampered.status, 2, tampered.stdout + tampered.stderr);
  assert.notEqual(lib('vp_anchor_ok "$1"', [TOOLS]).status, 0);
});

test('INJPKG-01 user-admin.sh — root 래퍼가 낮춰 부르면(VP_LAUNCHER=1) 재시작 요청(10)을 그대로 돌려준다', { skip: ROOT_ONLY }, () => {
  const BASE = fs.mkdtempSync('/tmp/audit2741l-ua-');
  cleanup.push(BASE);
  fs.chmodSync(BASE, 0o755);
  const app = path.join(BASE, 'app');
  fs.mkdirSync(path.join(app, 'server/src/tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'user-admin.sh'), path.join(app, 'user-admin.sh'));
  fs.copyFileSync(path.join(ROOT, 'otp-enroll.sh'), path.join(app, 'otp-enroll.sh'));
  fs.writeFileSync(path.join(app, 'server/src/tools/user-admin.js'), 'console.log("restart-offer=" + process.env.USER_ADMIN_CAN_RESTART); process.exit(10);\n');
  fs.writeFileSync(path.join(app, 'server/src/tools/otp-enroll.js'), 'console.log("hint=" + process.env.OTP_ENROLL_CMD);\n');
  fs.mkdirSync(path.join(BASE, 'cfg'));
  execFileSync('chown', ['-R', `${NOBODY.uid}:${NOBODY.gid}`, BASE]);
  const run = (script, extraEnv) => spawnSync('runuser', ['-u', 'nobody', '--', 'env', `CONFIG_DIR=${path.join(BASE, 'cfg')}`, ...extraEnv, '/bin/bash', path.join(app, script)], { encoding: 'utf8', cwd: '/' });
  const viaLauncher = run('user-admin.sh', ['VP_LAUNCHER=1']);
  assert.equal(viaLauncher.status, 10, viaLauncher.stdout + viaLauncher.stderr);
  assert.match(viaLauncher.stdout, /restart-offer=1/, '래퍼가 재시작할 수 있으니 도구가 재시작을 제안한다');
  const direct = run('user-admin.sh', []);
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /재시작은 root 로 하세요/);
  // otp-enroll.sh — 링크로 불러도 실제 위치에서 도구를 찾고, 래퍼의 호출 형태를 안내에 쓴다
  fs.symlinkSync(path.join(app, 'otp-enroll.sh'), path.join(BASE, 'otp-link'));
  const o = spawnSync('runuser', ['-u', 'nobody', '--', 'env', `CONFIG_DIR=${path.join(BASE, 'cfg')}`, 'VP_LAUNCHER=1', 'VP_LAUNCHER_CMD=sudo /usr/local/bin/vmware-portal-otp', '/bin/bash', path.join(BASE, 'otp-link')], { encoding: 'utf8', cwd: '/' });
  assert.equal(o.status, 0, o.stderr);
  assert.match(o.stdout, /hint=sudo \/usr\/local\/bin\/vmware-portal-otp/);
});

test('INJPKG-01 install.sh 는 앱 트리를 가리키는 /usr/local/bin 링크를 더 만들지 않는다 · 호스트 키 파일 소유자를 지킨다', () => {
  const s = rd('packaging/offline/install.sh').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(s, /ln -sf[n]? "\$APP_DST\//, '앱 트리(서비스 계정이 쓸 수 있다)를 가리키는 root 용 링크 금지');
  assert.match(s, /vp_install_root_tools "\$PREFIX" "\$SCRIPT_DIR"/, '방금 확인한 패키지 폴더에서 root 소유 사본을 만든다');
  assert.ok(s.indexOf('HOSTKEYS_ROOT=1') < s.indexOf('chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"'), 'chown -R 전에 root 소유였는지 기억한다');
  assert.match(s, /chown 0:0 -- "\$HOSTKEYS"/);
  const lib = rd('packaging/offline/release-verify-lib.sh').replace(/^\s*#.*$/gm, '');
  assert.ok(lib.indexOf('vp_anchor_ok "$tools"') < lib.indexOf('node="$old_node"'), 'root 소유 사본을 옛 앱 트리 도구보다 먼저 고른다');
});

test('INJPKG-01 ④ 권한 내림은 root 로 실행할 때만 — root 가 아니면 넘을 경계가 없고 setpriv 가 실패한다(v2.741 CI)', () => {
  const src = rd('packaging/offline/release-verify-lib.sh');
  const fn = src.slice(src.indexOf('verify_release_package() {'));
  assert.ok(fn.length > 100, 'verify_release_package 본문을 찾지 못했다');
  // 옛 설치본 도구를 소유 계정으로 낮추는 판정은 root 일 때만 — 아니면 runas_uid 가 비어 그 도구를 지금 계정으로 바로 실행한다.
  assert.match(fn, /if \[\[ "\$\(id -u\)" == 0 && "\$ou" != 0 \]\]; then\s*\n\s*runas_uid="\$ou"/);
  // root 가 아닌 실행은 portal.env 정책을 그대로 읽는다(root 소유 파일만 받는 규칙은 root 확인에만).
  assert.match(fn, /if \[\[ -n "\$runas_uid" \|\| "\$\(id -u\)" != 0 \]\]; then/);
});
