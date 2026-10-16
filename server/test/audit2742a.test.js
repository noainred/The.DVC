/**
 * v2.742 감사 GA(서명 확인·패키징 권한) 회귀 — RECENT-01 · INJPKG-01 · INJPKG-02 · INJPKG-03 · INJPKG-04 · LEFT-07.
 *
 *  RECENT-01 root 로 도는 서명 확인(install.sh·vmware-portal-verify)이 root 소유가 아닌 호스트 키 파일을 통째로 버려 그 파일의
 *            **회수** 까지 사라졌다 — 회수한 키로 서명한 패키지를 '확인됨' 으로 받았다. 이제 회수는 합치고 키 추가만 버린다.
 *  INJPKG-01 호스트 키 파일이 서비스 계정 소유 CONFIG_DIR 안에 있어 root 소유여도 지워질 수 있었다(회수 소실) · install.sh 의
 *            chown -R → chown 0:0 사이에 서비스 계정이 쓰기 핸들을 열 수 있었다. → root 소유 도구 폴더 trust/ 의 사본(회수 보존)
 *            + root 소유 원본은 chown -R 대상에서 뺀다.
 *  INJPKG-02 회수 절차·EPERMS 안내가 chmod 600/640 이라 그대로 하면 포탈(서비스 계정)이 못 읽어 온라인 업그레이드가 전부 멈췄다.
 *  INJPKG-03 install.sh 가 서비스 계정 소유 portal.env 의 RMA_SERVICE_UNITS·RMA_ALLOW_REBOOT 로 root 가 sudoers 를 넓혔다.
 *            (함께: 그 블록의 grep 파이프가 pipefail 에서 '줄 없음' 으로 설치를 조용히 끝냈다.)
 *  INJPKG-04 릴리스 tarball 항목 소유자가 빌드 runner uid 였다.
 *  LEFT-07   install.sh·uninstall.sh 의 --user 값 형식을 검사하지 않았다.
 *
 * root 권한이 필요한 시나리오(소유자 바꾸기·root 소유 파일)는 root 로 돌 때만 실행한다 — CI(비 root)는 건너뛴 사실을 남긴다.
 * ⚠ install.sh·uninstall.sh 는 통째로 실행하지 않는다(시스템을 바꾼다) — 판정 함수만 꺼내 실행한다(잘못된 인자 거부만 실제 실행).
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
  ? 'root 권한과 nobody 계정이 필요한 시나리오(소유자 바꾸기·root 소유 파일) — 이 환경에서는 건너뜀'
  : false;

const CFG0 = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-cfg-'));
process.env.CONFIG_DIR = CFG0;
delete process.env.UPGRADE_SIGNATURE_POLICY;
delete process.env.VP_ROOT_TRUST_COPY;
const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');

const cleanup = [CFG0];
after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const K1 = crypto.generateKeyPairSync('ed25519');   // 저장소 키(회수 대상)
const K3 = crypto.generateKeyPairSync('ed25519');   // 호스트 파일이 '추가' 하려는 키
const K4 = crypto.generateKeyPairSync('ed25519');   // keys[].revoked===true 로 회수된 키
const kid = (k) => core.keyIdOf(k.publicKey);
const entry = (k, extra = {}) => ({ keyId: kid(k), publicKey: core.spkiBase64Of(k.publicKey), ...extra });
const keysDoc = (keys, revoked = []) => JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys, revoked });
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
/** root 로 돌면 서비스 계정(nobody) 소유로 — 비 root 면 만든 계정 소유(uid≠0)라 그대로 '서비스 계정 파일' 이다. */
const ownNonRoot = (f) => { if (IS_ROOT) fs.chownSync(f, NOBODY.uid ?? 65534, NOBODY.gid ?? 65534); };
function mkTrust(tag, repoKeys = [entry(K1)]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `audit2742a-${tag}-`));
  cleanup.push(dir);
  const repo = path.join(dir, 'repo.json');
  fs.writeFileSync(repo, keysDoc(repoKeys));
  return { dir, repo, host: path.join(dir, 'release-signing-keys.conf') };
}
const NAME = 'vmware-portal-offline-10.0.2-el9-x64.tar.gz';
const BYTES = crypto.randomBytes(2048);
const decideWith = (trust, key = K1) => sigmod.decideSignature({ manifestText: signFor(key, '10.0.2', NAME, BYTES), bytes: BYTES, name: NAME, kind: 'installer', expectVersion: '10.0.2', where: 'offline', trust, policy: 'require' });

/* ── RECENT-01 ───────────────────────────────────────────────────────────────────────────────────────── */
test('RECENT-01 root 판정 — root 소유가 아닌 호스트 키 파일의 회수는 합치고 키 추가만 버린다', () => {
  const { repo, host } = mkTrust('rev');
  fs.writeFileSync(host, keysDoc([entry(K3), entry(K4, { revoked: true })], [kid(K1)]), { mode: 0o644 });
  fs.chmodSync(host, 0o644);
  ownNonRoot(host);
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: null });
  assert.equal(t.fatal, null);
  assert.equal(t.sources.host.ignored, 'not-root-owned', '키 추가는 받지 않는다고 밝힌다');
  assert.equal(t.sources.host.present, true);
  assert.equal(t.byId.get(kid(K1))?.revoked, true, '저장소 키를 회수한 revoked 목록을 root 확인도 지킨다');
  assert.equal(t.byId.get(kid(K4))?.revoked, true, 'keys[].revoked===true 도 회수로 받는다');
  assert.ok(!t.byId.has(kid(K3)), '서비스 계정이 넣은 키(활성)는 믿지 않는다');
  assert.equal(t.activeCount, 0);
  assert.equal(t.sources.host.ignoredKeys, 1);
  const d = decideWith(t);
  assert.equal(d.ok, false);
  assert.equal(d.code, 'revoked-key', `회수한 키로 서명한 패키지를 받으면 안 된다: ${d.reason}`);
  assert.equal(decideWith(t, K3).code, 'no-trusted-keys', '추가하려던 키로는 확인되지 않는다');
  // 회수만 받는 파일은 권한이 넓어도(그룹·기타 쓰기) 더 엄격해질 뿐이다 — fatal 아님 · 회수 유지
  fs.chmodSync(host, 0o666);
  const wide = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: null });
  assert.equal(wide.fatal, null);
  assert.equal(wide.byId.get(kid(K1))?.revoked, true);
  // 서비스 계정 판정(포탈 프로세스)은 예전 그대로 — 권한이 넓으면 fail-closed
  assert.match(String(sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: false }).fatal), /권한이 너무 넓습니다/);
  // 손상 — 회수 목록을 알 수 없으므로 root 판정도 fail-closed
  fs.chmodSync(host, 0o644);
  fs.writeFileSync(host, '{ "keys": [ broken');
  const bad = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: null });
  assert.ok(bad.fatal, '손상은 fatal');
  assert.equal(decideWith(bad).code, 'trust-unreadable');
});

test('RECENT-01 root 판정 — 심볼릭 링크는 따라가지 않는다(읽지 않음 · fatal 아님 — 지운 것과 같고 그 경우를 사본이 막는다)', () => {
  const { dir, repo } = mkTrust('lnk');
  const real = path.join(dir, 'real.conf');
  fs.writeFileSync(real, keysDoc([entry(K3)], [kid(K1)]));
  const link = path.join(dir, 'release-signing-keys.conf');
  fs.symlinkSync(real, link);
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: link, rootOwnedOnly: true, rootCopyFile: null });
  assert.equal(t.sources.host.ignored, 'not-root-owned');
  assert.equal(t.fatal, null);
  assert.ok(!t.byId.has(kid(K3)));
});

/* ── INJPKG-01 — root 소유 사본(회수 보존) ────────────────────────────────────────────────────────────── */
test('INJPKG-01 root 판정 — 호스트 키 root 소유 사본(VP_ROOT_TRUST_COPY)의 회수를 합친다 · 원본이 지워져도 회수가 남는다', () => {
  const { dir, repo, host } = mkTrust('copy');
  fs.mkdirSync(path.join(dir, 'trust'));
  const copy = path.join(dir, 'trust', 'release-signing-keys.conf');
  fs.writeFileSync(copy, keysDoc([entry(K3)], [kid(K1)]), { mode: 0o644 });
  // 원본(host)은 없다 — 서비스 계정이 CONFIG_DIR 의 파일을 지운 상태
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: copy });
  assert.equal(t.fatal, null);
  assert.equal(t.sources.rootCopy?.present, true);
  assert.equal(t.sources.rootCopy?.revoked, 1);
  assert.equal(t.byId.get(kid(K1))?.revoked, true, '원본을 지워도 사본의 회수가 남는다');
  assert.ok(!t.byId.has(kid(K3)), '사본에서는 키를 받지 않는다(회수만 — 키 추가는 원본에서만)');
  assert.equal(decideWith(t).code, 'revoked-key');
  // env 기본값 — root 래퍼·install.sh 는 env 로 넘긴다
  process.env.VP_ROOT_TRUST_COPY = copy;
  try {
    assert.equal(sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true }).byId.get(kid(K1))?.revoked, true);
    // 서비스 계정 판정(포탈 프로세스)은 사본을 보지 않는다 — 기존 동작 그대로
    const svc = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: false });
    assert.equal(svc.sources.rootCopy, undefined);
    assert.ok(!svc.byId.get(kid(K1))?.revoked);
  } finally { delete process.env.VP_ROOT_TRUST_COPY; }
  // 정책 — 사본이 있으면(원본이 없어도) '키 미설정' 으로 약해지지 않는다(저장소 키 0개라도 require)
  const e = mkTrust('copy-empty', []);
  const copyKeysOnly = path.join(e.dir, 'copy.conf');
  fs.writeFileSync(copyKeysOnly, keysDoc([entry(K3)]));
  const tu = sigmod.loadTrust({ repoFile: e.repo, hostFile: e.host, rootOwnedOnly: true, rootCopyFile: copyKeysOnly });
  assert.equal(sigmod.signaturePolicy({}, tu).policy, 'require');
  assert.equal(sigmod.signaturePolicy({}, sigmod.loadTrust({ repoFile: e.repo, hostFile: e.host, rootOwnedOnly: true, rootCopyFile: null })).policy, 'warn', '사본도 원본도 없으면 예전처럼 키 미설정');
  // 없는 사본 — 없음(fatal 아님) · 손상 사본 — fatal(fail-closed)
  const none = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: path.join(dir, 'trust', 'none.conf') });
  assert.equal(none.fatal, null);
  assert.equal(none.sources.rootCopy.present, false);
  fs.writeFileSync(copy, 'not json');
  const broken = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: true, rootCopyFile: copy });
  assert.ok(broken.fatal);
  assert.equal(decideWith(broken).code, 'trust-unreadable');
});

const LIB = path.join(ROOT, 'packaging/offline/release-verify-lib.sh');
const lib = (body, args = [], env = process.env) => bash(`set -euo pipefail\nsource "${LIB}"\n${body}`, args, { env });

test('INJPKG-01 vp_stage_trust_copy — 원본이 없거나 root 소유가 아니면 지난 사본(회수)을 그대로 둔다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-stage-'));
  cleanup.push(base);
  const cdir = path.join(base, 'etc'); const cur = path.join(base, 'tools'); const nxt = path.join(base, 'tools.new');
  for (const d of [cdir, path.join(cur, 'trust'), nxt]) fs.mkdirSync(d, { recursive: true });
  const prev = keysDoc([], [kid(K1)]);
  fs.writeFileSync(path.join(cur, 'trust', 'release-signing-keys.conf'), prev);
  const stage = () => lib('vp_stage_trust_copy "$@"', [cdir, cur, nxt, process.execPath]);
  const out = () => fs.readFileSync(path.join(nxt, 'trust', 'release-signing-keys.conf'), 'utf8');
  // ① 원본 없음(서비스 계정이 지웠다) → 지난 사본 유지
  let r = stage();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(out(), prev, '원본을 지우는 것만으로 회수가 풀리면 안 된다');
  assert.match(r.stdout, /지난 root 소유 사본/);
  // ② 원본이 root 소유가 아님(서비스 계정이 바꿔치기) → 지난 사본 유지(그 내용을 사본에 쓰지 않는다)
  fs.rmSync(path.join(nxt, 'trust'), { recursive: true });
  const src = path.join(cdir, 'release-signing-keys.conf');
  fs.writeFileSync(src, keysDoc([entry(K3)]));
  ownNonRoot(src);
  r = stage();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(out(), prev);
  assert.match(r.stdout, /root 소유가 아니거나/);
  // ③ 지난 사본도 없으면 만들지 않는다(없는 회수를 지어내지 않는다)
  fs.rmSync(path.join(nxt, 'trust'), { recursive: true });
  fs.rmSync(path.join(cur, 'trust'), { recursive: true });
  r = stage();
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(nxt, 'trust', 'release-signing-keys.conf')));
});

test('INJPKG-01 vp_stage_trust_copy — root 소유 원본이면 그 내용으로 바꾸고, JSON 이 아니면 지난 사본을 둔다', { skip: ROOT_ONLY }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-stage-root-'));
  cleanup.push(base);
  const cdir = path.join(base, 'etc'); const cur = path.join(base, 'tools'); const nxt = path.join(base, 'tools.new');
  for (const d of [cdir, path.join(cur, 'trust'), nxt]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cur, 'trust', 'release-signing-keys.conf'), keysDoc([], [kid(K4)]));
  const src = path.join(cdir, 'release-signing-keys.conf');
  const fresh = keysDoc([entry(K3)], [kid(K1)]);
  fs.writeFileSync(src, fresh, { mode: 0o644 }); fs.chmodSync(src, 0o644); fs.chownSync(src, 0, 0);
  const stage = () => lib('vp_stage_trust_copy "$@"', [cdir, cur, nxt, process.execPath]);
  let r = stage();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(nxt, 'trust', 'release-signing-keys.conf'), 'utf8'), fresh);
  // 그룹·기타가 쓸 수 있는 root 파일은 믿지 않는다 · 손상된 root 파일로 사본을 덮지 않는다(다음 확인이 막히는 교착 방지)
  for (const [mode, text] of [[0o666, fresh], [0o644, '{ broken']]) {
    fs.rmSync(path.join(nxt, 'trust'), { recursive: true });
    fs.writeFileSync(src, text); fs.chmodSync(src, mode);
    r = stage();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(nxt, 'trust', 'release-signing-keys.conf'), 'utf8'), keysDoc([], [kid(K4)]), `mode ${mode.toString(8)} · ${text.slice(0, 8)}`);
  }
});

test('INJPKG-01 install 이 만든 사본으로 root 확인이 회수를 지킨다 — 원본을 지워도 vmware-portal-verify·install 확인이 거부(실제 bash · 실제 verifyCli)', { skip: ROOT_ONLY }, () => {
  const BASE = fs.mkdtempSync('/tmp/audit2742a-e2e-');
  cleanup.push(BASE);
  fs.chmodSync(BASE, 0o755);
  const TOOLS_BASE = path.join(BASE, 'libexec');
  const CFG = path.join(BASE, 'etc');
  fs.mkdirSync(CFG); fs.chmodSync(CFG, 0o755);
  const appTree = (dir) => {
    fs.mkdirSync(path.join(dir, 'app/server'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'server/src'), path.join(dir, 'app/server/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/server/src/upgrade/release-signing-keys.json'), keysDoc([entry(K1)]));
    fs.copyFileSync(path.join(ROOT, 'server/package.json'), path.join(dir, 'app/server/package.json'));
    fs.writeFileSync(path.join(dir, 'app/package.json'), JSON.stringify({ version: '10.0.2' }));
    fs.mkdirSync(path.join(dir, 'runtime/node/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime/node/bin/node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    fs.chmodSync(path.join(dir, 'runtime/node/bin/node'), 0o755);
  };
  const PREFIX = path.join(BASE, 'opt/vp');
  appTree(PREFIX);
  const PKGDIR = path.join(BASE, 'pkg');
  const SDIR = path.join(PKGDIR, 'vmware-portal-offline-10.0.2-el9-x64');
  appTree(SDIR);
  const pkg = path.join(PKGDIR, NAME);
  const man = path.join(PKGDIR, 'vmware-portal-10.0.2.manifest.json');
  fs.writeFileSync(pkg, BYTES);
  fs.writeFileSync(man, signFor(K1, '10.0.2', NAME, BYTES));
  const env = { ...process.env, VP_ROOT_TOOLS_BASE: TOOLS_BASE };
  delete env.UPGRADE_SIGNATURE_POLICY; delete env.VP_ROOT_TRUST_COPY;
  const verifyPkg = () => lib('verify_release_package "$@"', [PREFIX, SDIR, CFG, '10.0.2', pkg, man, '0'], env);
  // 관리자가 root 소유 호스트 키 파일로 K1 을 회수했다 → install 이 root 소유 사본을 만든다
  const hk = path.join(CFG, 'release-signing-keys.conf');
  fs.writeFileSync(hk, keysDoc([], [kid(K1)]), { mode: 0o644 }); fs.chmodSync(hk, 0o644); fs.chownSync(hk, 0, 0);
  const inst = lib('vp_install_root_tools "$@"', [PREFIX, SDIR, 'nobody', 'vp-audit2742a-svc', CFG], env);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const TOOLS = path.join(TOOLS_BASE, PREFIX);
  const copy = path.join(TOOLS, 'trust/release-signing-keys.conf');
  assert.equal(fs.statSync(copy).uid, 0, '사본은 root 소유');
  assert.equal(fs.statSync(copy).mode & 0o022, 0);
  assert.equal(fs.readFileSync(copy, 'utf8'), keysDoc([], [kid(K1)]));
  // 서비스 계정이 원본을 지웠다(CONFIG_DIR 는 서비스 계정이 쓸 수 있다)
  fs.rmSync(hk);
  const vw = spawnSync(path.join(TOOLS, 'vmware-portal-verify'), ['--file', pkg, '--manifest', man], { encoding: 'utf8', env });
  assert.equal(vw.status, 1, `회수한 키의 서명을 root 확인이 받으면 안 된다: ${vw.stdout}${vw.stderr}`);
  assert.match(vw.stdout, /회수/);
  const v = verifyPkg();
  assert.equal(v.status, 1, `install.sh 의 확인도 거부: ${v.stdout}${v.stderr}`);
  // 다음 install 도 원본이 없으면 지난 사본을 그대로 둔다(지우는 것만으로 풀리지 않는다)
  const again = lib('vp_install_root_tools "$@"', [PREFIX, SDIR, 'nobody', 'vp-audit2742a-svc', CFG], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(fs.readFileSync(copy, 'utf8'), keysDoc([], [kid(K1)]));
  assert.equal(spawnSync(path.join(TOOLS, 'vmware-portal-verify'), ['--file', pkg, '--manifest', man], { encoding: 'utf8', env }).status, 1);
  // 회수가 없는 상태(사본 지움 — root 의 명시적 조치)면 저장소 키로 확인된다(대조 — 위 거부가 회수 때문임을 확인)
  fs.rmSync(copy);
  const ok = spawnSync(path.join(TOOLS, 'vmware-portal-verify'), ['--file', pkg, '--manifest', man], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('INJPKG-01 install.sh — root 소유 호스트 키 파일은 chown -R 대상에서 뺀다(넘겼다 되돌리는 창 없음)', { skip: ROOT_ONLY }, () => {
  const fn = shellFn(rd('packaging/offline/install.sh'), 'vp_chown_tree_except');
  assert.ok(fn, 'install.sh vp_chown_tree_except');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-chown-'));
  cleanup.push(base);
  const dir = path.join(base, 'etc');
  fs.mkdirSync(path.join(dir, 'vmperf'), { recursive: true });
  for (const f of ['portal.env', 'release-signing-keys.conf', 'vmperf/a.db']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.symlinkSync('/etc/hostname', path.join(dir, 'link'));
  const r = bash(`${fn}\nvp_chown_tree_except "$@"`, [dir, `${NOBODY.uid}:${NOBODY.gid}`, path.join(dir, 'release-signing-keys.conf')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(path.join(dir, 'release-signing-keys.conf')).uid, 0, 'root 소유 호스트 키 파일은 그대로 root');
  for (const f of ['', 'portal.env', 'vmperf', 'vmperf/a.db']) assert.equal(fs.statSync(path.join(dir, f)).uid, NOBODY.uid, `${f || '(폴더)'} 는 서비스 계정 소유`);
  assert.equal(fs.lstatSync(path.join(dir, 'link')).uid, NOBODY.uid, '링크 자체만 바꾼다');
  assert.equal(fs.statSync('/etc/hostname').uid, 0, '링크를 따라가지 않는다');
});

test('INJPKG-01 install.sh — 순서·분기: root 소유면 제외 chown, 아니면 예전 chown -R · 래퍼·확인이 사본 경로를 넘긴다', () => {
  const s = rd('packaging/offline/install.sh').replace(/^\s*#.*$/gm, '');
  const a = s.search(/if \[\[ \$HOSTKEYS_ROOT -eq 1 \]\]; then\s+vp_chown_tree_except "\$CONFIG_DIR" "\$SERVICE_USER:\$SERVICE_USER" "\$HOSTKEYS"\s+else\s+chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$CONFIG_DIR"/);
  assert.ok(a > 0, 'root 소유 호스트 키 파일이면 제외 chown, 아니면 예전 chown -R');
  assert.ok(s.indexOf('HOSTKEYS_ROOT=1') < a);
  const l = rd('packaging/offline/release-verify-lib.sh').replace(/^\s*#.*$/gm, '');
  assert.match(l, /VP_ROOT_TRUST_COPY="\$TOOLS\/trust\/release-signing-keys\.conf"/, 'verify 래퍼가 사본 경로를 넘긴다');
  assert.match(l, /VP_ROOT_TRUST_COPY="\$tools\/trust\/\$VP_HOST_KEYS_NAME" "\$node" "\$js"/, 'install 확인이 사본 경로를 넘긴다');
  assert.match(l, /vp_stage_trust_copy "\$cdir" "\$tools" "\$tmp"/, 'install 이 사본을 만든다');
  assert.equal(sigmod.ROOT_TRUST_COPY_ENV, 'VP_ROOT_TRUST_COPY', '셸과 같은 env 이름');
  assert.match(rd('packaging/offline/release-verify.sh'), /VP_ROOT_TRUST_COPY=/);
});

/* ── INJPKG-02 ───────────────────────────────────────────────────────────────────────────────────────── */
test('INJPKG-02 권한 안내는 포탈(서비스 계정)이 읽을 수 있는 권한(root:root · 644)을 말한다 — 600/640 안내 금지', () => {
  const { repo, host } = mkTrust('perm');
  fs.writeFileSync(host, keysDoc([], [kid(K1)]));
  fs.chmodSync(host, 0o664);
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: false });
  assert.match(String(t.fatal), /chmod 644/);
  assert.doesNotMatch(String(t.fatal), /600|640/);
  const doc = rd('docs/RELEASE-SIGNING.md');
  const s8 = doc.slice(doc.indexOf('## 8.'), doc.indexOf('## 9.'));
  assert.ok(s8.length > 50, '8절');
  assert.doesNotMatch(s8, /chmod 600/, '8절 절차대로 하면 포탈이 못 읽는다');
  assert.match(s8, /644/);
  const s3 = doc.slice(doc.indexOf('## 3.'), doc.indexOf('## 4.'));
  assert.doesNotMatch(s3, /600\/640/);
  const sig = rd('server/src/upgrade/signature.js');
  assert.doesNotMatch(sig, /chmod 600 또는 640/);
});

test('INJPKG-02 포탈이 호스트 키 파일을 못 읽으면(EACCES) 고칠 권한을 함께 말한다', { skip: IS_ROOT ? 'root 는 권한 검사를 받지 않아 EACCES 를 만들 수 없다(비 root 로 실행)' : false }, () => {
  const { repo, host } = mkTrust('eacces');
  fs.writeFileSync(host, keysDoc([], [kid(K1)]));
  fs.chmodSync(host, 0o000);
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: host, rootOwnedOnly: false });
  assert.ok(t.fatal);
  assert.match(String(t.fatal), /EACCES/);
  assert.match(String(t.fatal), /root:root 소유 · chmod 644/);
  fs.chmodSync(host, 0o644);
});

/* ── INJPKG-03 ───────────────────────────────────────────────────────────────────────────────────────── */
const INSTALL = rd('packaging/offline/install.sh');
const RMA_FNS = `${shellFn(INSTALL, 'vp_rma_env_request')}\n${shellFn(INSTALL, 'vp_rma_sudoers')}`;
function rma(penvText, { root = false, mode = 0o640, sudoers = null, user = 'vmportal', cwdFiles = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-rma-'));
  cleanup.push(base);
  const penv = path.join(base, 'portal.env');
  fs.writeFileSync(penv, penvText); fs.chmodSync(penv, mode);
  if (root) fs.chownSync(penv, 0, 0); else ownNonRoot(penv);
  const cur = path.join(base, 'sudoers');
  if (sudoers != null) fs.writeFileSync(cur, sudoers);
  for (const f of cwdFiles) fs.writeFileSync(path.join(base, f), '');
  const r = bash(`set -euo pipefail\n${RMA_FNS}\nvp_rma_env_request "$1"\nvp_rma_sudoers "$2" "$VP_RMA_ENV_ROOT" "$VP_RMA_UNITS" "$VP_RMA_REBOOT" "$3"\necho "@@root=$VP_RMA_ENV_ROOT ignored=$VP_RMA_IGNORED"`, [penv, user, cur], { cwd: base });
  const [body, meta = ''] = r.stdout.split('@@');
  return { ...r, body, meta };
}
const baseLine = 'vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl restart vmware-portal.service';
const unitLines = (u) => ['start', 'stop', 'restart'].map((v) => `vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl ${v} ${u}.service`);
const REBOOT = 'vmportal ALL=(root) NOPASSWD: /usr/bin/systemctl reboot';

test('INJPKG-03 서비스 계정 소유 portal.env 의 RMA 값은 sudoers 를 넓히지 않는다 — 이미 설치된 줄만 남긴다', () => {
  const env = 'PORT=4000\nRMA_SERVICE_UNITS=nginx,debug-shell\nRMA_ALLOW_REBOOT=true\n';
  const fresh = rma(env);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.meta, /root=0/);
  assert.ok(fresh.body.includes(baseLine), '기본 줄(포탈 재시작)은 언제나');
  assert.doesNotMatch(fresh.body, /debug-shell|nginx|reboot/, '설치된 sudoers 가 없으면 아무것도 넓히지 않는다');
  assert.match(fresh.meta, /ignored=nginx debug-shell reboot/, '무시한 항목을 밝힌다');
  // 지금 sudoers(root 가 만든 것 — 원격 RMA 배포·예전 설치)에 있던 줄은 남는다 · 없던 유닛은 넓히지 않는다
  const curSudo = ['# x', baseLine, ...unitLines('nginx'), REBOOT, ''].join('\n');
  const kept = rma(env, { sudoers: curSudo });
  assert.equal(kept.status, 0, kept.stderr);
  for (const l of [...unitLines('nginx'), REBOOT]) assert.ok(kept.body.includes(l), `유지: ${l}`);
  assert.doesNotMatch(kept.body, /debug-shell/);
  assert.match(kept.meta, /ignored=debug-shell$/m);
  // 요청에서 빠진 유닛은 지운다(줄이는 것은 서비스 계정 값으로도 된다)
  const narrowed = rma('RMA_SERVICE_UNITS=\n', { sudoers: curSudo });
  assert.doesNotMatch(narrowed.body, /nginx|reboot/);
  // 세 동사가 다 있어야 승인으로 본다 · 다른 계정의 줄은 승인이 아니다
  const partial = rma(env, { sudoers: [baseLine, unitLines('nginx')[2], ''].join('\n') });
  assert.doesNotMatch(partial.body, /nginx/);
  const other = rma(env, { sudoers: [...unitLines('nginx').map((l) => l.replace(/^vmportal/, 'someone')), ''].join('\n') });
  assert.doesNotMatch(other.body, /nginx/);
});

test('INJPKG-03 유닛 값은 글롭으로 펼치지 않는다 · RMA 줄이 없는 portal.env 에서 설치가 끝나지 않는다(pipefail)', () => {
  const glob = rma('RMA_SERVICE_UNITS=*\n', { sudoers: [...unitLines('evil'), ''].join('\n'), cwdFiles: ['evil'] });
  assert.equal(glob.status, 0, glob.stderr);
  assert.doesNotMatch(glob.body, /evil/, '작업 폴더의 파일 이름이 유닛이 되면 안 된다');
  const none = rma('PORT=4000\n# RMA_SERVICE_UNITS=\n');
  assert.equal(none.status, 0, `set -euo pipefail 에서 RMA 줄이 없어도 계속한다: ${none.stderr}`);
  assert.equal(none.body.trim().split('\n').length, 2, '머리 주석 + 기본 줄');
  // install.sh 의 순서 — chown -R 전에 읽는다 · 예전 grep 파이프가 남아 있지 않다
  const s = INSTALL.replace(/^\s*#.*$/gm, '');
  assert.ok(s.indexOf('vp_rma_env_request "$CONFIG_DIR/portal.env"') > 0);
  assert.ok(s.indexOf('vp_rma_env_request "$CONFIG_DIR/portal.env"') < s.indexOf('chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"'), 'chown -R 전에 소유자를 본다');
  assert.doesNotMatch(s, /grep -E '\^RMA_SERVICE_UNITS='/);
  assert.match(s, /vp_rma_sudoers "\$SERVICE_USER" "\$VP_RMA_ENV_ROOT" "\$VP_RMA_UNITS" "\$VP_RMA_REBOOT" \/etc\/sudoers\.d\/vmware-portal-rma > "\$SUDO_TMP"/);
  assert.match(s, /RMA_INSTANCES="\$\(grep -E '\^RMA_INSTANCES='[^\n]*\|\| true\)"/, 'RMA_INSTANCES 줄이 없어도 계속한다');
});

test('INJPKG-03 root 소유 portal.env 는 예전처럼 요청 그대로 · 그룹/기타 쓰기가 있으면 믿지 않는다', { skip: ROOT_ONLY }, () => {
  const env = 'RMA_SERVICE_UNITS=nginx, app@x\nRMA_ALLOW_REBOOT=true\n';
  const t = rma(env, { root: true });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.meta, /root=1 ignored=$/m);
  for (const l of [...unitLines('nginx'), ...unitLines('app@x'), REBOOT]) assert.ok(t.body.includes(l), l);
  const w = rma(env, { root: true, mode: 0o664 });
  assert.match(w.meta, /root=0/);
  assert.doesNotMatch(w.body, /nginx/);
  if (spawnSync('visudo', ['--version'], { encoding: 'utf8' }).status === 0) {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-visudo-')), 's');
    cleanup.push(path.dirname(f));
    fs.writeFileSync(f, t.body, { mode: 0o440 });
    assert.equal(spawnSync('visudo', ['-cf', f], { encoding: 'utf8' }).status, 0, '생성된 sudoers 는 visudo 를 통과한다');
  }
});

/* ── INJPKG-04 ───────────────────────────────────────────────────────────────────────────────────────── */
test('INJPKG-04 build-package.sh 의 tar 산출물은 항목 소유자를 root(0)로 고정한다', () => {
  const s = rd('packaging/offline/build-package.sh').replace(/^\s*#.*$/gm, '');
  const tars = s.split('\n').filter((l) => /\btar\b[^\n]*\s-czf\s/.test(l));
  assert.equal(tars.length, 2, `설치 패키지·업그레이드 번들 두 줄: ${tars.join(' | ')}`);
  for (const l of tars) assert.match(l, /tar --owner=0 --group=0 --numeric-owner -czf /, l);
  // 이 플래그가 실제로 소유자 0 으로 담는지(GNU tar) — 비 root 로도 확인된다
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-tar-'));
  cleanup.push(d);
  fs.mkdirSync(path.join(d, 'stage'));
  fs.writeFileSync(path.join(d, 'stage', 'install.sh'), 'x');
  if (IS_ROOT) fs.chownSync(path.join(d, 'stage', 'install.sh'), NOBODY.uid, NOBODY.gid);
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', path.join(d, 'p.tgz'), '-C', d, 'stage']);
  const list = execFileSync('tar', ['--numeric-owner', '-tvzf', path.join(d, 'p.tgz')], { encoding: 'utf8' });
  for (const line of list.trim().split('\n')) assert.match(line, /^\S+\s+0\/0\s/, line);
});

/* ── LEFT-07 ─────────────────────────────────────────────────────────────────────────────────────────── */
test('LEFT-07 install.sh·uninstall.sh 의 --user 형식 검사는 같은 함수이고 root 는 받는다', () => {
  const fi = shellFn(INSTALL, 'vp_check_user');
  const fu = shellFn(rd('packaging/offline/uninstall.sh'), 'vp_check_user');
  assert.ok(fi && fu, '두 스크립트에 vp_check_user');
  assert.equal(fu, fi, '같은 규칙');
  const ok = (u) => bash(`${fi}\nvp_check_user "$1"`, [u]);
  for (const u of ['vmportal', 'root', '_svc', 'a-b_c', 'a'.repeat(32), 'portal2']) assert.equal(ok(u).status, 0, `받아야 한다: ${u}`);
  for (const u of ['', 'Root', 'ops.admin', '1abc', 'a b', 'a;b', '-x', 'x$', 'a'.repeat(33), 'vm/portal', "a'b", '\nroot']) {
    const r = ok(u);
    assert.notEqual(r.status, 0, `거부해야 한다: ${JSON.stringify(u)}`);
    assert.match(r.stderr, /--user/);
  }
  // 실제 install.sh — 잘못된 --user 는 무엇도 건드리기 전에 거부(root 확인보다 먼저)
  const inst = spawnSync('bash', [path.join(ROOT, 'packaging/offline/install.sh'), '--prefix', '/opt/vmware-portal-audit2742a-none', '--user', 'ops.admin'], { encoding: 'utf8' });
  assert.equal(inst.status, 1);
  assert.match(inst.stderr, /--user/, inst.stderr.slice(0, 300));
  const s = INSTALL.replace(/^\s*#.*$/gm, '');
  assert.ok(s.indexOf('vp_check_user "$SERVICE_USER" || exit 1') < s.indexOf('[[ $EUID -eq 0 ]]'), 'root 확인보다 먼저');
  const u = rd('packaging/offline/uninstall.sh').replace(/^\s*#.*$/gm, '');
  assert.match(u, /--user\) SERVICE_USER="\$2"; shift 2 ;;/);
  assert.ok(u.indexOf('vp_check_user "$SERVICE_USER" || exit 1') < u.indexOf('[[ $EUID -eq 0 ]]'));
});

test('LEFT-07 uninstall --purge 는 uid 0 계정을 지우지 않는다', () => {
  const fn = shellFn(rd('packaging/offline/uninstall.sh'), 'vp_purge_user');
  assert.ok(fn, 'uninstall.sh vp_purge_user');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742a-userdel-'));
  cleanup.push(d);
  const log = path.join(d, 'calls');
  fs.writeFileSync(path.join(d, 'userdel'), `#!/bin/sh\necho "$*" >> '${log}'\n`);
  fs.chmodSync(path.join(d, 'userdel'), 0o755);
  const run = (u) => bash(`${fn}\nvp_purge_user "$1"`, [u], { env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
  const r = run('root');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /uid 0/);
  assert.ok(!fs.existsSync(log), 'root 에는 userdel 을 부르지 않는다');
  run('nobody');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'nobody', '그 밖의 계정은 예전처럼 지운다');
  run('no-such-user-audit2742a');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'nobody', '없는 계정은 부르지 않는다');
});
