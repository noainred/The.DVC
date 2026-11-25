/**
 * 전체 점검 109회차 — 설치 · 패키징 1차 점검 회귀.
 *  A-1 uninstall.sh 가 설치 폴더 **옆**의 '<prefix>.bak.*' 를 함께 지웠다('rm -rf "$PREFIX" "$PREFIX".bak.*').
 *      이 포탈의 백업은 설치 폴더 **안**(<prefix>/app.bak.<시각> — install.sh · 앱 내 업그레이드 applyPackage)에만 생기므로,
 *      그 글롭에 걸리는 것은 관리자가 손으로 떠 둔 사본뿐이었다 — 설치본인지 확인도 없이 지워졌다. 이제 지우지 않고 알린다.
 *  A-2 install.sh 가 런타임을 먼저 지우고(rm -rf) 복사했고, 앱은 백업으로 옮긴 뒤 복사했다 — 복사가 중간에 실패하면(디스크 부족)
 *      런타임이 없거나 앱이 반쪽인 채 set -e 로 끝났고 되돌리는 단계가 없었다. 이제 옆에 다 복사한 뒤에 바꾼다.
 *  A-3 OFFLINE-INSTALL.md(패키지의 README.md)가 vcenters.json·users.json 을 앱 폴더(app/server/config)에 쓰라고 안내했다 — install.sh 는
 *      CONFIG_DIR=/etc/vmware-portal 을 portal.env 에 넣으므로 설치본은 그 파일을 읽지 않는다. 패키지 구성 목록도 두 파일이 빠져 있었다.
 *
 * ⚠ install.sh · uninstall.sh 는 통째로 실행하지 않는다(시스템 서비스를 바꾸고 지운다) — 함수와 해당 구간만 꺼내 임시 폴더에서 실행한다
 *   (audit2741l · audit2744j 와 같은 방식).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const cleanup = [];
after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** 셸 스크립트에서 이름의 함수 정의를 꺼낸다(맨 앞 `name() {` ~ 줄 첫머리 `}`). 한 줄 함수도 받는다. 없으면 null. */
function shellFn(text, name) {
  const one = new RegExp(`\\n${name}\\(\\) \\{[^\\n]*\\}\\n`).exec(text);
  if (one) return one[0];
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}

/** uninstall.sh 의 '앱/런타임 제거' 블록(if vp_prefix_is_install … fi)을 그대로 꺼낸다. */
function removeBlock(text) {
  const a = text.indexOf('\nif vp_prefix_is_install "$PREFIX"; then\n');
  assert.ok(a >= 0, "uninstall.sh 에서 제거 블록을 찾지 못했다");
  const b = text.indexOf('\nfi\n', a);
  assert.ok(b > a);
  return text.slice(a + 1, b + 4);
}

function runRemove(prefix) {
  const un = rd('packaging/offline/uninstall.sh');
  const fns = ['vp_prefix_is_install', 'vp_note_sibling_backups'].map((n) => shellFn(un, n)).filter(Boolean).join('\n');
  const script = `set -euo pipefail\n${fns}\nPREFIX="$1"\n${removeBlock(un)}`;
  return spawnSync('bash', ['-c', script, '_', prefix], { encoding: 'utf8' });
}

const mk = (d, files) => { for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); } return d; };

test('A-1 uninstall: 설치 폴더(안의 app.bak.* 포함)만 지우고, 옆의 <prefix>.bak.* 는 남기고 알린다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg109-'));
  cleanup.push(base);
  const prefix = mk(path.join(base, 'vmware-portal'), ['app/server/src/index.js', 'runtime/node/bin/node', 'app.bak.1794000000/server/src/index.js']);
  // 관리자가 손으로 떠 둔 사본 두 가지(폴더 · 파일)와, 이름만 비슷한 다른 폴더
  const manual = mk(path.join(base, 'vmware-portal.bak.20261117'), ['app/server/src/index.js', 'only-copy.txt']);
  const manualFile = path.join(base, 'vmware-portal.bak.tgz');
  fs.writeFileSync(manualFile, 'archive');
  const other = mk(path.join(base, 'vmware-portal2'), ['keep.txt']);

  const r = runRemove(prefix);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(prefix), false, '설치 폴더는 지운다(그 안의 app.bak.* 도 함께)');
  assert.equal(fs.existsSync(path.join(manual, 'only-copy.txt')), true, '옆의 <prefix>.bak.<날짜> 폴더는 지우지 않는다');
  assert.equal(fs.existsSync(manualFile), true, '옆의 <prefix>.bak.* 파일도 지우지 않는다');
  assert.equal(fs.existsSync(path.join(other, 'keep.txt')), true);
  assert.match(r.stdout, /vmware-portal\.bak\.20261117 는 지우지 않았습니다/);
  assert.match(r.stdout, /vmware-portal\.bak\.tgz 는 지우지 않았습니다/);
});

test('A-1 uninstall: 옆에 사본이 없으면 안내도 없고, 설치본이 아닌 폴더는 종전대로 지우지 않는다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg109-'));
  cleanup.push(base);
  const prefix = mk(path.join(base, 'vp'), ['app/server/src/index.js']);
  const r = runRemove(prefix);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(prefix), false);
  assert.doesNotMatch(r.stdout, /지우지 않았습니다/);

  const notInst = mk(path.join(base, 'www'), ['index.html']);
  const sib = mk(path.join(base, 'www.bak.1'), ['x.txt']);
  const r2 = runRemove(notInst);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.existsSync(path.join(notInst, 'index.html')), true, '설치본이 아니면 지우지 않는다');
  assert.equal(fs.existsSync(path.join(sib, 'x.txt')), true);
});

test('A-1 uninstall.sh · install.sh 는 bash 문법이 맞고, rm 대상에 설치 폴더 밖 글롭이 없다', () => {
  for (const f of ['packaging/offline/uninstall.sh', 'packaging/offline/install.sh']) {
    const r = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const code = rd('packaging/offline/uninstall.sh').replace(/^\s*#.*$/gm, '');
  for (const line of code.split('\n').filter((l) => /\brm\b/.test(l))) {
    assert.doesNotMatch(line, /"\$PREFIX"\.\w|"\$PREFIX"\*|\$\{?PREFIX\}?\.bak/, `rm 이 설치 폴더 옆을 지운다: ${line.trim()}`);
  }
  // 이 포탈의 백업 위치 전제 — 설치 폴더 안(app.bak.<시각>). 이것이 바뀌면 uninstall 의 정리 범위도 다시 볼 것.
  assert.match(rd('packaging/offline/install.sh'), /BAK="\$APP_DST\.bak\.\$\(date \+%s\)"/);
  assert.match(rd('packaging/offline/install.sh'), /APP_DST="\$PREFIX\/app"/);
});

/* ── A-2 install.sh 2)·3) — 런타임·앱 교체 ─────────────────────────────────────────────────────────── */
const INSTALL = rd('packaging/offline/install.sh');
function region(from, to) {
  const a = INSTALL.indexOf(`\n${from}`);
  const b = INSTALL.indexOf(`\n${to}`, a + 1);
  assert.ok(a >= 0 && b > a, `install.sh 구간을 찾지 못했다: ${from} ~ ${to}`);
  return INSTALL.slice(a + 1, b + 1);
}
const SWAP_REGION = region('# 2) Runtime', '# 4) Config');

/** 구간을 실제로 실행한다. failOn 이 있으면 그 글자가 든 cp 는 **반쯤 복사한 뒤 실패**한다(디스크 부족 흉내). */
function runSwap({ withOld = true, failOn = '' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg109-swap-'));
  cleanup.push(d);
  const pkg = mk(path.join(d, 'pkg'), ['runtime/node/bin/node', 'runtime/node/lib/x.js', 'app/server/src/index.js', 'app/web/dist/index.html', 'app/package.json']);
  fs.writeFileSync(path.join(pkg, 'runtime/node/bin/node'), 'NEW-NODE');
  fs.writeFileSync(path.join(pkg, 'app/package.json'), 'NEW-APP');
  const prefix = path.join(d, 'prefix');
  fs.mkdirSync(prefix);
  if (withOld) {
    mk(prefix, ['runtime/node/bin/node', 'app/server/src/index.js', 'app/package.json', 'app/server/config/users.json']);
    fs.writeFileSync(path.join(prefix, 'runtime/node/bin/node'), 'OLD-NODE');
    fs.writeFileSync(path.join(prefix, 'app/package.json'), 'OLD-APP');
  }
  const shim = `cp() { if [[ -n "\${FAIL_ON:-}" && "$*" == *"$FAIL_ON"* ]]; then command cp "$@" 2>/dev/null || true; local dst="\${@: -1}"; rm -rf -- "$dst/server" "$dst/bin"; echo "cp: 쓰기 오류: 장치에 남은 공간이 없음" >&2; return 1; fi; command cp "$@"; }`;
  const script = `set -euo pipefail\n${shim}\nSCRIPT_DIR="$1"; PREFIX="$2"\n${SWAP_REGION}\necho "BAK=$BAK"`;
  const r = spawnSync('bash', ['-c', script, '_', pkg, prefix], { encoding: 'utf8', env: { ...process.env, FAIL_ON: failOn } });
  const read = (rel) => { try { return fs.readFileSync(path.join(prefix, rel), 'utf8'); } catch { return null; } };
  const ls = (rel) => { try { return fs.readdirSync(path.join(prefix, rel)).sort(); } catch { return []; } };
  return { r, prefix, read, ls };
}

test('A-2 install: 정상 교체 — 새 런타임·앱이 놓이고 기존 앱은 app.bak.<시각> 에 남으며 임시 폴더가 남지 않는다', () => {
  const { r, read, ls } = runSwap();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read('runtime/node/bin/node'), 'NEW-NODE');
  assert.equal(read('app/package.json'), 'NEW-APP');
  assert.equal(read('app/web/dist/index.html'), 'x');
  const baks = ls('.').filter((n) => n.startsWith('app.bak.'));
  assert.equal(baks.length, 1, ls('.').join(','));
  assert.equal(read(`${baks[0]}/package.json`), 'OLD-APP');
  assert.equal(read(`${baks[0]}/server/config/users.json`), 'x', '설정 이전(4)이 읽을 기존 앱 내부 설정이 백업에 있다');
  assert.match(r.stdout, new RegExp(`BAK=.*${baks[0].replace(/\./g, '\\.')}`), '4) 가 쓰는 BAK 변수');
  assert.deepEqual(ls('.').filter((n) => n.includes('.new')), [], '앱 임시 폴더가 남지 않는다');
  assert.deepEqual(ls('runtime'), ['node'], '런타임 임시 폴더가 남지 않는다');
});

test('A-2 install: 첫 설치(기존 앱·런타임 없음)도 같은 구간으로 된다', () => {
  const { r, read, ls } = runSwap({ withOld: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read('runtime/node/bin/node'), 'NEW-NODE');
  assert.equal(read('app/package.json'), 'NEW-APP');
  assert.match(r.stdout, /BAK=\n?$/, '백업 없음');
  assert.deepEqual(ls('.').sort(), ['app', 'runtime']);
});

for (const [what, failOn] of [['앱', '/app'], ['런타임', '/runtime/node']]) {
  test(`A-2 install: ${what} 복사가 중간에 실패하면 멈추고, 기존 런타임·앱은 그대로다(반쪽 설치·백업으로 옮겨진 앱 없음)`, () => {
    const { r, read, ls } = runSwap({ failOn });
    assert.notEqual(r.status, 0, '실패는 실패로 끝난다');
    assert.match(r.stderr, /복사에 실패했습니다/);
    assert.match(r.stderr, /기존 런타임·앱은 바꾸지 않았고/);
    assert.equal(read('runtime/node/bin/node'), 'OLD-NODE', '기존 런타임 그대로');
    assert.equal(read('app/package.json'), 'OLD-APP', '기존 앱이 제자리에 그대로');
    assert.equal(read('app/server/src/index.js'), 'x');
    assert.deepEqual(ls('.').sort(), ['app', 'runtime'], '백업으로 옮기지도, 임시 폴더를 남기지도 않는다');
    assert.deepEqual(ls('runtime'), ['node']);
    assert.doesNotMatch(r.stdout, /BAK=/, '구간 끝까지 가지 않는다');
  });
}

test('A-2 install: 지난 실행이 남긴 임시 폴더(node.new · app.new.install)는 다음 실행이 치운다', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg109-swap-'));
  cleanup.push(d);
  const fn = shellFn(INSTALL, 'vp_stage_tree');
  assert.ok(fn, 'install.sh vp_stage_tree');
  const src = mk(path.join(d, 'src'), ['a.txt']);
  const dst = mk(path.join(d, 'dst.new'), ['stale/old.txt']);
  const r = spawnSync('bash', ['-c', `set -euo pipefail\nPREFIX="$3"\n${fn}\nvp_stage_tree "$1" "$2" 테스트`, '_', src, dst, d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(dst), ['a.txt'], '찌꺼기 위에 겹쳐 복사하지 않는다(원본 폴더가 그 안에 들어가지 않는다)');
  // 구간의 순서 — 두 복사가 모두 끝난 뒤에야 기존 것을 치운다
  const code = SWAP_REGION.replace(/^\s*#.*$/gm, '');
  const iStageApp = code.indexOf('vp_stage_tree "$SCRIPT_DIR/app"');
  assert.ok(iStageApp > 0 && code.indexOf('vp_stage_tree "$SCRIPT_DIR/runtime/node"') < iStageApp);
  assert.ok(iStageApp < code.indexOf('rm -rf "$PREFIX/runtime/node"'), '런타임을 지우는 것은 두 복사 뒤');
  assert.ok(iStageApp < code.indexOf('mv "$APP_DST" "$BAK"'), '앱을 백업으로 옮기는 것은 두 복사 뒤');
  assert.doesNotMatch(code, /cp -a "\$SCRIPT_DIR\/(app|runtime\/node)" "\$(APP_DST|PREFIX\/runtime\/node)"/, '제자리에 직접 복사하지 않는다');
});

/* ── A-3 설치 문서 ↔ 스크립트 ───────────────────────────────────────────────────────────────────────── */
test('A-3 OFFLINE-INSTALL.md: 설정 파일 위치는 install.sh 가 정한 CONFIG_DIR 이고, 패키지 구성 목록은 빌드가 담는 파일과 같다', () => {
  const doc = rd('packaging/offline/OFFLINE-INSTALL.md');
  // install.sh 가 portal.env 에 CONFIG_DIR 을 넣는다는 전제(이것이 바뀌면 문서도 다시 볼 것)
  assert.match(INSTALL, /\nCONFIG_DIR="\/etc\/vmware-portal"\n/);
  assert.match(INSTALL, /vp_cfg_set_line "\$PENV" CONFIG_DIR "\$CONFIG_DIR"/);
  for (const f of ['vcenters.json', 'users.json']) {
    assert.doesNotMatch(doc, new RegExp(`app/server/config/${f.replace('.', '\\.')}\`? *(을|를)? *작성`), `${f} 를 앱 폴더에 쓰라고 안내하지 않는다`);
    assert.match(doc, new RegExp(`/etc/vmware-portal/${f.replace('.', '\\.')}`), `${f} 의 실제 위치`);
  }
  assert.match(doc, /sudo vmware-portal-users/, '계정 관리는 콘솔 메뉴(root 로 node 를 직접 돌리게 안내하지 않는다)');
  assert.doesNotMatch(doc, /hashPassword\(/, '비밀번호 해시를 손으로 만들어 users.json 을 쓰게 하지 않는다');
  // 빌드가 패키지 최상위에 담는 파일 = 문서의 구성 목록
  const build = rd('packaging/offline/build-package.sh');
  const a = build.indexOf('# 4) Installer assets');
  const b = build.indexOf('# 5) Pack', a);
  assert.ok(a > 0 && b > a);
  const names = new Set();
  for (const line of build.slice(a, b).split('\n')) {
    const m = /^cp (.+) "\$STAGE\/(README\.md)?"/.exec(line.trim());
    if (!m) continue;
    if (m[2]) { names.add(m[2]); continue; }
    for (const src of m[1].match(/"\$SCRIPT_DIR\/[^"]+"/g) || []) names.add(src.slice('"$SCRIPT_DIR/'.length, -1));
  }
  for (const must of ['install.sh', 'uninstall.sh', 'release-verify-lib.sh', 'vmware-portal.service', 'vmware-portal-rma@.service', 'portal.env.example', 'README.md']) {
    assert.ok(names.has(must), `build-package.sh 가 담는 파일을 읽지 못했다: ${must} (${[...names].join(',')})`);
  }
  const tree = doc.slice(doc.indexOf('## 패키지 구성'), doc.indexOf('## 패키지 만들기'));
  for (const n of names) assert.ok(tree.includes(`── ${n}`), `패키지 구성 목록에 ${n} 가 없다`);
});

// ── C-1(메인 반영 — 109회차 보고 전용 확정): scripts/release.sh 가 jq 실패를 삼켰다 ─────────────────────────────
//   'jq … > f.tmp && mv f.tmp f' 는 '&&' 목록의 마지막이 아닌 명령(jq)의 실패를 set -e 가 잡지 않는다 — 깨진 JSON 하나가 있어도
//   나머지 파일만 버전이 오른 채 '✅ 준비 완료' · exit 0 이었다. 이제 전부 .tmp 로 만든 뒤 한꺼번에 바꾼다(실패하면 무변경).
function releaseSandbox({ brokenWeb = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel109-'));
  cleanup.push(dir);
  for (const d of ['scripts', 'server/src', 'web', 'pyportal']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/release.sh'), path.join(dir, 'scripts/release.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"r","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'server/package.json'), '{"name":"s","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'web/package.json'), brokenWeb ? '{"name":"w","version":"1.0.0",,}\n' : '{"name":"w","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'server/src/release-notes.json'), '{"notes":[{"version":"1.0.0","date":"2026-01-01","title":"t","notes":["n"]}]}\n');
  fs.writeFileSync(path.join(dir, 'pyportal/ver.txt'), '1.0.0 (2026-01-01) 처음\n');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const hasJq = spawnSync('jq', ['--version']).status === 0;
const runRelease = (dir, args) => spawnSync('bash', ['scripts/release.sh', ...args], { cwd: dir, encoding: 'utf8' });
const tmpLeft = (dir) => ['package.json.tmp', 'server/package.json.tmp', 'web/package.json.tmp', 'server/src/release-notes.json.tmp', 'pyportal/ver.txt.tmp']
  .filter((f) => fs.existsSync(path.join(dir, f)));
const verOf = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).version;

test('C-1 release.sh — jq 가 한 파일에서 실패하면 0 이 아니고 어떤 파일도 바뀌지 않는다(.tmp 도 남지 않는다)', { skip: !hasJq && 'jq 없음' }, () => {
  const dir = releaseSandbox({ brokenWeb: true });
  const before = fs.readFileSync(path.join(dir, 'server/src/release-notes.json'), 'utf8');
  const r = runRelease(dir, ['9.9.9', '제목']);
  assert.notEqual(r.status, 0, `깨진 web/package.json 인데 성공으로 끝났다: ${r.stdout}`);
  assert.ok(!/준비 완료/.test(r.stdout), '실패했는데 준비 완료를 찍었다');
  assert.equal(verOf(dir, 'package.json'), '1.0.0', '루트 package.json 만 버전이 올랐다(일부만 바뀜)');
  assert.equal(verOf(dir, 'server/package.json'), '1.0.0');
  assert.equal(fs.readFileSync(path.join(dir, 'server/src/release-notes.json'), 'utf8'), before, '릴리스 노트가 바뀌었다');
  assert.deepEqual(tmpLeft(dir), [], '.tmp 가 남았다');
});

test('C-1 release.sh — 정상이면 세 파일 버전 · 릴리스 노트 맨 앞 · ver.txt 맨 위가 함께 바뀐다', { skip: !hasJq && 'jq 없음' }, () => {
  const dir = releaseSandbox();
  const r = runRelease(dir, ['9.9.9', '제목', '세부 1', '--pyportal', '허브 요약']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['package.json', 'server/package.json', 'web/package.json']) assert.equal(verOf(dir, f), '9.9.9', f);
  const rn = JSON.parse(fs.readFileSync(path.join(dir, 'server/src/release-notes.json'), 'utf8'));
  assert.equal(rn.notes[0].version, '9.9.9');
  assert.deepEqual(rn.notes[0].notes, ['세부 1']);
  assert.equal(rn.notes[1].version, '1.0.0', '옛 항목이 사라졌다');
  const ver = fs.readFileSync(path.join(dir, 'pyportal/ver.txt'), 'utf8').split('\n');
  assert.match(ver[0], /^9\.9\.9 \(\d{4}-\d{2}-\d{2}\) 허브 요약$/);
  assert.equal(ver[1], '1.0.0 (2026-01-01) 처음');
  assert.deepEqual(tmpLeft(dir), []);
});

test('C-1 release.sh — --pyportal 뒤에 값이 없으면 이유를 말하고 끝난다(파일 무변경)', { skip: !hasJq && 'jq 없음' }, () => {
  const dir = releaseSandbox();
  const r = runRelease(dir, ['9.9.9', '제목', '--pyportal']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--pyportal 뒤에 요약 문구가 필요합니다/);
  assert.equal(verOf(dir, 'package.json'), '1.0.0');
});
