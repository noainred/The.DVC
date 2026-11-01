/**
 * test/bareosInstallRunner2844.test.js — v2.844 Bareos 완전 설치 러너(install/runner.sh)를 **실제 bash 로** 돌린다.
 * 가짜 루트(PORTAL_TEST_ROOT) + 명령 대역(dnf·rpm·systemctl·su·python3·bconsole …)으로 root·패키지 없이 판정만 본다.
 *  ① 새 설치 1~3단계 성공 — 표지 파일 · SD 비밀번호는 Director 스토리지 파일에만(로그에 없음) · pyVmomi 고른 판 · 볼륨 디렉터리 · WebUI
 *  ② 2단계 dnf 실패 → **그 단계만** 되돌림(이 단계가 넣은 패키지 제거 · 1단계 결과는 남음) · err.2 의 원인 = dnf-conflict
 *  ③ pyVmomi 사본(플러그인 경로) → pyvmomi-shadow 실패 · 'PYVMOMI_FIX=1'(포탈에서 고치기)로 다시 하면 사본을 옮기고 성공(지우지 않음)
 *  ④ 초기화(0단계): /etc/bareos tar 보관 · bareos 패키지 제거 · 카탈로그 DB 삭제 · 확인받은 볼륨만 비움(시스템 경로·설정에 없는 경로 거부)
 *  ⑤ 남의 파일이 자리에 있으면 3단계가 멈추고 그 파일은 그대로
 *  ⑥ 전부 되돌리기(rollback-all): 새로 넣은 패키지·/etc/bareos(설치 전 없었음)·로컬 저장소·초기화한 PG 데이터 제거
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '../src/bareos/install/runner.sh');
const { parseErrFile, classifyFailure } = await import('../src/bareos/install/causes.js');
const MARKER = '# managed-by: vmware-portal bareos auto-setup (rewritten on re-run)';
const BV = '25.20261101.4';

const SHIMS = {
  dnf: `#!/bin/bash
op=""; pk=()
for a in "$@"; do case "$a" in (install|remove) op="$a";; (-*) ;; (*) pk+=("$a");; esac; done
if [ "$op" = install ]; then
  for p in "\${pk[@]}"; do grep -qx "$p" "$FAKE/rpmdb" 2>/dev/null || echo "$p" >> "$FAKE/rpmdb"; done
  mkdir -p "$P/etc/bareos/bareos-sd.d/director" "$P/etc/bareos/bareos-sd.d/device" "$P/etc/bareos/bareos-dir.d/storage" "$P/etc/bareos/bareos-dir.d/director" "$P/etc/bareos/bareos-fd.d/client"
  [ -f "$P/etc/bareos/bareos-sd.d/director/bareos-dir.conf" ] || printf 'Director {\\n  Name = bareos-dir\\n  Password = "sd-secret-pw"\\n}\\n' > "$P/etc/bareos/bareos-sd.d/director/bareos-dir.conf"
  printf 'Director {\\n  Name = bareos-dir\\n}\\n' > "$P/etc/bareos/bareos-dir.d/director/bareos-dir.conf"
  touch "$FAKE/bareos_user"
  if [ -n "\${FAKE_DNF_FAIL:-}" ]; then echo " Problem: conflicting requests"; echo "  - nothing provides libfoo"; exit 1; fi
  echo Complete!; exit 0
fi
if [ "$op" = remove ]; then
  for p in "\${pk[@]}"; do grep -vx "$p" "$FAKE/rpmdb" > "$FAKE/rpmdb.t" 2>/dev/null; mv "$FAKE/rpmdb.t" "$FAKE/rpmdb"; done
  echo removed; exit 0
fi
exit 0`,
  rpm: '#!/bin/bash\ncat "$FAKE/rpmdb" 2>/dev/null; exit 0',
  systemctl: `#!/bin/bash
q=0; args=()
for a in "$@"; do case "$a" in (-q|--quiet|--now) [ "$a" = --now ] && now=1 || q=1;; (*) args+=("$a");; esac; done
cmd="\${args[0]}"; u="\${args[1]:-}"; u="\${u%.service}"; d="$FAKE/svc"; mkdir -p "$d"
case "$cmd" in
  is-enabled) [ -f "$d/$u.en" ] ;;
  is-active) if [ -f "$d/$u.act" ]; then [ $q = 1 ] || echo active; exit 0; else [ $q = 1 ] || echo inactive; exit 3; fi ;;
  enable) touch "$d/$u.en"; [ "\${now:-0}" = 1 ] && touch "$d/$u.act"; exit 0 ;;
  disable) rm -f "$d/$u.en"; [ "\${now:-0}" = 1 ] && rm -f "$d/$u.act"; exit 0 ;;
  start|restart|reload) touch "$d/$u.act"; exit 0 ;;
  stop) rm -f "$d/$u.act"; exit 0 ;;
  list-unit-files) exit 0 ;;
esac
exit 0`,
  su: `#!/bin/bash
c="\${@: -1}"
case "$c" in
  *"datname='bareos'"*) [ -f "$FAKE/pgdb" ] && echo 1; exit 0 ;;
  *create_bareos_database*) touch "$FAKE/pgdb"; exit 0 ;;
  *"dropdb"*) rm -f "$FAKE/pgdb"; exit 0 ;;
  *) exit 0 ;;
esac`,
  'postgresql-setup': '#!/bin/bash\nmkdir -p "$P/var/lib/pgsql/data"; echo 13 > "$P/var/lib/pgsql/data/PG_VERSION"; exit 0',
  runuser: '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  id: '#!/bin/bash\nif [ "$1" = -u ] && [ "${2:-}" = bareos ]; then [ -f "$FAKE/bareos_user" ] && { echo 990; exit 0; }; exit 1; fi\nexec /usr/bin/id "$@"',
  install: '#!/bin/bash\na=(); while [ $# -gt 0 ]; do case "$1" in (-o|-g) shift 2;; (*) a+=("$1"); shift;; esac; done\nexec /usr/bin/install "${a[@]}"',
  python3: `#!/bin/bash
all="$*"
case "$all" in
  *platlibdir*) echo /usr/lib64/bareos/plugins; exit 0 ;;
  *"-m pip install"*) v="\${all##*pyvmomi==}"; echo "$v" > "$FAKE/pyvmomi"; echo "Successfully installed pyvmomi-$v"; exit 0 ;;
  *"-m pip uninstall"*) rm -f "$FAKE/pyvmomi"; exit 0 ;;
  *"import pyVmomi"*) if [ -n "\${PYTHONPATH:-}" ] && [ -d "$PYTHONPATH/pyVmomi" ]; then echo "9.1.1"; else cat "$FAKE/pyvmomi" 2>/dev/null || { echo "ModuleNotFoundError"; exit 1; }; fi; exit 0 ;;
  *'version("pyvmomi")'*) [ -f "$FAKE/pyvmomi" ] && cat "$FAKE/pyvmomi" && exit 0; exit 1 ;;
esac
exit 0`,
  'bareos-sd': '#!/bin/bash\nexit 0', 'bareos-dir': '#!/bin/bash\nexit 0', 'bareos-fd': '#!/bin/bash\nexit 0',
  ss: '#!/bin/bash\nprintf "State Recv-Q Send-Q Local Peer\\nLISTEN 0 50 *:9101 *:*\\nLISTEN 0 50 *:9102 *:*\\nLISTEN 0 50 *:9103 *:*\\nLISTEN 0 50 *:80 *:*\\n"',
  bconsole: '#!/bin/bash\ncat >/dev/null; echo "bareos-dir Version: 25.1.2~pre73 (01 Nov 2026)"; exit 0',
  getenforce: '#!/bin/bash\necho Disabled', curl: '#!/bin/bash\necho -n 200', 'firewall-cmd': '#!/bin/bash\nexit 0',
  semanage: '#!/bin/bash\nexit 0', restorecon: '#!/bin/bash\nexit 0', setsebool: '#!/bin/bash\nexit 0', getsebool: '#!/bin/bash\necho "httpd_can_network_connect --> off"',
};

function env(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2844-'));
  const P = path.join(base, 'root'); const FAKE = path.join(base, 'fake'); const BIN = path.join(base, 'bin');
  for (const d of [P, FAKE, BIN]) fs.mkdirSync(d, { recursive: true });
  for (const [n, s] of Object.entries(SHIMS)) { fs.writeFileSync(path.join(BIN, n), s, { mode: 0o755 }); }
  fs.writeFileSync(path.join(FAKE, 'rpmdb'), (opts.rpmdb || ['glibc', 'python3']).join('\n') + '\n');
  // 번들(진짜 tar)
  const W = path.join(P, 'var/lib/portal-bareos-install');
  const src = path.join(base, 'bsrc/bareos-bundle');
  for (const d of ['rpms/repodata', 'wheels', 'keys']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'keys/RPM-GPG-KEY-bareos-x'), 'key');
  fs.writeFileSync(path.join(src, 'wheels/pyvmomi-8.0.3.0.1-py3-none-any.whl'), 'w');
  fs.mkdirSync(path.join(W, 'bundles'), { recursive: true }); fs.mkdirSync(path.join(W, 'run'), { recursive: true });
  const tarP = path.join(W, 'bundles', `bareos-bundle-${BV}.tar.gz`);
  const t = spawnSync('tar', ['czf', tarP, '-C', path.dirname(src), 'bareos-bundle']);
  assert.equal(t.status, 0, String(t.stderr));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tarP)).digest('hex');
  return { base, P, FAKE, BIN, W, R: path.join(W, 'run'), sha };
}
function planEnv(e, o = {}) {
  const v = { JOB_ID: 'bi_test01', RUN_MODE: 'install', START_STEP: '1', BV, TAR_SHA256: e.sha, INSTALL_PKGS: 'bareos bareos-webui postgresql-server', PYVMOMI: '8.0.3.0.1', PYVMOMI_FIX: '0',
    VOLUME_DIR: '/var/lib/bareos/storage', HOST_ADDR: '10.20.0.14', SD_DEVICE: 'PortalFileStorage', SD_MEDIA: 'PortalFile', DIR_STORAGE: 'PortalFile', WEBUI: '1',
    RESET: '0', RESET_DB: '0', RESET_VOLUMES: '0', RESET_VOLUME_DIRS: '', ...o };
  fs.writeFileSync(path.join(e.R, 'plan.env'), Object.entries(v).map(([k, x]) => `${k}='${x}'`).join('\n') + '\n');
}
function run(e, extra = {}) {
  const r = spawnSync('bash', [RUNNER], { env: { ...process.env, PATH: `${e.BIN}:${process.env.PATH}`, PORTAL_TEST_ROOT: e.P, P: e.P, FAKE: e.FAKE, WAIT_PORT_SEC: '2', ...extra }, encoding: 'utf8', timeout: 60_000 });
  const state = fs.existsSync(path.join(e.R, 'state')) ? fs.readFileSync(path.join(e.R, 'state'), 'utf8') : '';
  const log = fs.existsSync(path.join(e.R, 'run.log')) ? fs.readFileSync(path.join(e.R, 'run.log'), 'utf8') : '';
  return { ...r, state, log };
}
const has = (st, n, s) => new RegExp(`^${n} ${s} `, 'm').test(st);
const rpmdb = (e) => fs.readFileSync(path.join(e.FAKE, 'rpmdb'), 'utf8').split('\n').filter(Boolean);

test('① 새 설치 1~3단계 성공 — 표지 파일 · SD 비밀번호는 파일에만 · pyVmomi · 볼륨 · WebUI', () => {
  const e = env(); planEnv(e);
  const r = run(e);
  assert.equal(r.status, 0, r.stderr + r.log);
  for (const n of [1, 2, 3]) assert.ok(has(r.state, n, 'ok'), `${n}단계 ok\n${r.state}\n${r.log}`);
  assert.ok(/^all done /m.test(r.state));
  const dev = fs.readFileSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device/PortalFileStorage.conf'), 'utf8');
  assert.equal(dev.split('\n')[0], MARKER);
  assert.match(dev, /Archive Device = \/var\/lib\/bareos\/storage/);
  const st = fs.readFileSync(path.join(e.P, 'etc/bareos/bareos-dir.d/storage/PortalFile.conf'), 'utf8');
  assert.match(st, /Password = "sd-secret-pw"/); assert.match(st, /Address = 10\.20\.0\.14/);
  assert.ok(!r.log.includes('sd-secret-pw'), '로그에 SD 비밀번호가 없어야 한다');
  assert.equal(fs.readFileSync(path.join(e.FAKE, 'pyvmomi'), 'utf8').trim(), '8.0.3.0.1');
  assert.ok(fs.statSync(path.join(e.P, 'var/lib/bareos/storage')).isDirectory());
  const repo = fs.readFileSync(path.join(e.P, 'etc/yum.repos.d/portal-bareos-local.repo'), 'utf8');
  assert.equal(repo.split('\n')[0], MARKER); assert.match(repo, /enabled=0/); assert.match(repo, /gpgcheck=1/);
  for (const u of ['bareos-dir', 'bareos-sd', 'bareos-fd', 'postgresql', 'httpd', 'php-fpm']) assert.ok(fs.existsSync(path.join(e.FAKE, 'svc', `${u}.act`)), `${u} 켜짐`);
  assert.match(r.log, /WebUI 응답 HTTP 200/);
});

test('② 2단계 dnf 실패 → 그 단계만 되돌림(넣은 패키지 제거 · 1단계 결과 유지) · 원인 dnf-conflict', () => {
  const e = env(); planEnv(e);
  const r = run(e, { FAKE_DNF_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.ok(has(r.state, 1, 'ok')); assert.ok(has(r.state, 2, 'fail')); assert.ok(has(r.state, 2, 'rolledback'), r.state + r.log);
  assert.ok(!has(r.state, 3, 'start'), '3단계는 시작하지 않는다');
  const db = rpmdb(e);
  for (const p of ['bareos', 'bareos-webui', 'postgresql-server']) assert.ok(!db.includes(p), `${p} 제거됨`);
  assert.ok(db.includes('glibc'), '원래 있던 패키지는 그대로');
  assert.ok(!fs.existsSync(path.join(e.P, 'etc/bareos')), '설치 전 없던 /etc/bareos 는 되돌림에서 지운다');
  assert.ok(fs.existsSync(path.join(e.P, 'etc/yum.repos.d/portal-bareos-local.repo')), '1단계 결과는 남는다');
  const err = parseErrFile(fs.readFileSync(path.join(e.R, 'err.2'), 'utf8'));
  assert.match(err.cmd, /dnf install/);
  assert.equal(classifyFailure({ step: 2, ...err }).key, 'dnf-conflict');
});

test('③ pyVmomi 사본 → pyvmomi-shadow · 포탈에서 고치기(PYVMOMI_FIX=1)로 다시 하면 옮기고 성공', () => {
  const e = env(); planEnv(e);
  const bpp = path.join(e.P, 'usr/lib64/bareos/plugins/pyVmomi');
  fs.mkdirSync(bpp, { recursive: true }); fs.writeFileSync(path.join(bpp, '__init__.py'), '# 9.1.1');
  const r = run(e);
  assert.ok(has(r.state, 2, 'fail') && has(r.state, 2, 'rolledback'), r.state + r.log);
  const err = parseErrFile(fs.readFileSync(path.join(e.R, 'err.2'), 'utf8'));
  assert.equal(err.cause, 'pyvmomi-shadow');
  assert.equal(classifyFailure({ step: 2, ...err }).key, 'pyvmomi-shadow');
  assert.ok(!fs.existsSync(path.join(e.FAKE, 'pyvmomi')), '이 단계가 깐 pyVmomi 는 되돌림에서 지운다(pip-new)');
  // 다시 — 2단계부터 · 고치기
  planEnv(e, { START_STEP: '2', PYVMOMI_FIX: '1' });
  const r2 = run(e);
  assert.equal(r2.status, 0, r2.log);
  assert.ok(/^all done /m.test(r2.state));
  assert.ok(!fs.existsSync(bpp), '플러그인 경로의 사본은 옮겨졌다');
  const moved = fs.readdirSync(path.join(e.W, 'moved'));
  assert.equal(moved.length, 1);
  assert.ok(fs.existsSync(path.join(e.W, 'moved', moved[0], 'pyVmomi', '__init__.py')), '지우지 않고 옮긴다');
});

test('④ 초기화(0단계): 보관 tar · bareos 패키지 제거 · DB 삭제 · 확인받고 설정에 있는 볼륨만 비움', () => {
  const e = env({ rpmdb: ['glibc', 'bareos-director', 'bareos-storage', 'postgresql-server'] });
  const vol = path.join(e.P, 'srv/bk/vol'); const other = path.join(e.P, 'srv/keep');
  fs.mkdirSync(vol, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(vol, 'Full-0001'), 'x'); fs.writeFileSync(path.join(other, 'data'), 'y');
  fs.mkdirSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device'), { recursive: true });
  fs.writeFileSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device/FileStorage.conf'), 'Device {\n  Name = FileStorage\n  Archive Device = /srv/bk/vol\n}\n');
  fs.mkdirSync(path.join(e.P, 'var/lib/pgsql/data'), { recursive: true }); fs.writeFileSync(path.join(e.P, 'var/lib/pgsql/data/PG_VERSION'), '13');
  fs.writeFileSync(path.join(e.FAKE, 'pgdb'), '');
  planEnv(e, { START_STEP: '0', RESET: '1', RESET_DB: '1', RESET_VOLUMES: '1', RESET_VOLUME_DIRS: '/srv/bk/vol /srv/keep /etc' });
  const r = run(e);
  assert.equal(r.status, 0, r.log);
  assert.ok(has(r.state, 0, 'ok'));
  assert.ok(!rpmdb(e).some((p) => p.startsWith('bareos-director')) || rpmdb(e).includes('bareos'), '옛 bareos 패키지 제거(새 설치가 다시 넣음)');
  assert.ok(rpmdb(e).includes('glibc') && rpmdb(e).includes('postgresql-server'), 'bareos 가 아닌 패키지는 그대로');
  assert.deepEqual(fs.readdirSync(vol), [], '설정에 있고 확인받은 볼륨은 비움');
  assert.ok(fs.existsSync(path.join(other, 'data')), '설정에 없는 경로는 확인 목록에 있어도 지우지 않는다');
  const resetDir = path.join(e.W, 'reset');
  assert.ok(fs.readdirSync(resetDir).some((f) => /^etc-bareos-.*\.tar\.gz$/.test(f)), '/etc/bareos 를 지우기 전에 엣지 안에 보관');
  assert.ok(fs.existsSync(path.join(e.FAKE, 'pgdb')), '새 설치가 DB 를 다시 만든다(지웠다가 2단계에서 생성)');
  assert.match(r.log, /create_bareos_database/);
});

test('④-c 설정이 시스템 경로(/var)를 볼륨으로 가리켜도 지우지 않는다(safe_voldir)', () => {
  const e = env({ rpmdb: ['bareos-director'] });
  fs.mkdirSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device'), { recursive: true });
  fs.writeFileSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device/Bad.conf'), 'Device {\n  Archive Device = /var\n}\n');
  fs.writeFileSync(path.join(e.P, 'var/keep-me'), 'z');
  planEnv(e, { START_STEP: '0', RESET: '1', RESET_DB: '0', RESET_VOLUMES: '1', RESET_VOLUME_DIRS: '/var' });
  const r = run(e);
  assert.equal(r.status, 0, r.log);
  assert.ok(fs.existsSync(path.join(e.P, 'var/keep-me')), '/var 안의 파일이 남아야 한다');
  assert.match(r.log, /볼륨 경로 .*\/var 는 지우지 않음/);
});

test('④-b 볼륨 보존(기본) — RESET_VOLUMES=0 이면 파일을 건드리지 않는다', () => {
  const e = env({ rpmdb: ['bareos-director'] });
  const vol = path.join(e.P, 'srv/bk/vol'); fs.mkdirSync(vol, { recursive: true }); fs.writeFileSync(path.join(vol, 'Full-0001'), 'x');
  fs.mkdirSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device'), { recursive: true });
  fs.writeFileSync(path.join(e.P, 'etc/bareos/bareos-sd.d/device/FileStorage.conf'), 'Device {\n  Archive Device = /srv/bk/vol\n}\n');
  planEnv(e, { START_STEP: '0', RESET: '1', RESET_DB: '0', RESET_VOLUMES: '0', RESET_VOLUME_DIRS: '' });
  const r = run(e);
  assert.equal(r.status, 0, r.log);
  assert.ok(fs.existsSync(path.join(vol, 'Full-0001')));
});

test('⑤ 남의 파일이 자리에 있으면 3단계가 멈추고 그 파일은 그대로', () => {
  const e = env(); planEnv(e);
  const dev = path.join(e.P, 'etc/bareos/bareos-sd.d/device/PortalFileStorage.conf');
  fs.mkdirSync(path.dirname(dev), { recursive: true }); fs.writeFileSync(dev, 'Device { Name = mine }\n');
  const r = run(e);
  assert.ok(has(r.state, 3, 'fail'), r.state + r.log);
  assert.equal(fs.readFileSync(dev, 'utf8'), 'Device { Name = mine }\n');
  const err = parseErrFile(fs.readFileSync(path.join(e.R, 'err.3'), 'utf8'));
  assert.equal(classifyFailure({ step: 3, ...err }).key, 'conflict');
});

test('⑥ 전부 되돌리기 — 새 패키지 · /etc/bareos(설치 전 없음) · 로컬 저장소 · 초기화한 PG 데이터', () => {
  const e = env(); planEnv(e);
  assert.equal(run(e).status, 0);
  planEnv(e, { RUN_MODE: 'rollback-all' });
  const r = run(e);
  assert.equal(r.status, 0, r.log);
  assert.ok(/^all rolledback /m.test(r.state), r.state);
  assert.deepEqual(rpmdb(e).sort(), ['glibc', 'python3']);
  assert.ok(!fs.existsSync(path.join(e.P, 'etc/bareos')));
  assert.ok(!fs.existsSync(path.join(e.P, 'etc/yum.repos.d/portal-bareos-local.repo')));
  assert.ok(!fs.existsSync(path.join(e.P, 'var/lib/pgsql/data')));
  assert.ok(!fs.existsSync(path.join(e.W, 'bundles')), '올린 번들도 지운다');
  assert.ok(!fs.existsSync(path.join(e.FAKE, 'pyvmomi')));
});

test('⑦ 번들 sha 가 다르면 1단계가 멈춘다(bundle-hash)', () => {
  const e = env(); planEnv(e, { TAR_SHA256: 'f'.repeat(64) });
  const r = run(e);
  assert.ok(has(r.state, 1, 'fail'));
  const err = parseErrFile(fs.readFileSync(path.join(e.R, 'err.1'), 'utf8'));
  assert.equal(classifyFailure({ step: 1, ...err }).key, 'bundle-hash');
});

test('⑧ 중단 파일이 있으면 그 단계 앞에서 멈춘다', () => {
  const e = env(); planEnv(e);
  fs.writeFileSync(path.join(e.R, 'stop'), '');
  const r = run(e);
  assert.equal(r.status, 0);
  assert.ok(has(r.state, 1, 'stopped'));
  assert.ok(!fs.existsSync(path.join(e.P, 'etc/yum.repos.d/portal-bareos-local.repo')));
});
