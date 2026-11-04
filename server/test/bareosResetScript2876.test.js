/**
 * test/bareosResetScript2876.test.js — packaging/bareos-bundle/bareos-reset.sh(서버에서 root 로 돌리는 Bareos 완전 초기화)를 **실제 bash 로** 돌린다.
 *   가짜 루트(RESET_ROOT) + 명령 대역(PATH — rpm · dnf · systemctl · su · bconsole · id · hostname · timeout). 장비에 닿지 않는다.
 *   사용자 요청(2026-11-04 '기존 백업 카탈로그와 볼륨 삭제 — 완전히 초기화 · 프로그램으로') · 규칙은 설치 러너 0단계(runner.sh step0)와 같다:
 *    ① --dry-run 은 아무것도 바꾸지 않는다 · ② root 가 아니면 멈춘다 · ③ 실행 중 작업이 있거나 확인 못 하면 멈춘다(못 읽음 ≠ 0)
 *    ④ 확인 입력(서버 이름)이 다르면 멈춘다 · ⑤ 볼륨은 Archive Device 경로만 · 시스템 경로 · 심링크는 지우지 않는다
 *    ⑥ 완전 초기화(카탈로그 · 볼륨 · 패키지 · 설정) · 남길 옵션 · 다시 실행하면 '지울 것 없음'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../packaging/bareos-bundle/bareos-reset.sh');

const STUBS = {
  rpm: '#!/bin/bash\ncat "$FAKE/rpmdb" 2>/dev/null; exit 0',
  dnf: '#!/bin/bash\nfor a in "$@"; do case "$a" in (-*|remove) ;; (*) grep -vx "$a" "$FAKE/rpmdb" > "$FAKE/rpmdb.t"; mv "$FAKE/rpmdb.t" "$FAKE/rpmdb";; esac; done\necho "$*" >> "$FAKE/dnf.log"; exit 0',
  systemctl: `#!/bin/bash
cmd="$1"; for a in "$@"; do u="$a"; done
case "$cmd" in
  is-active) if [ -f "$FAKE/dir_active" ] && [ "$u" = bareos-dir ]; then echo active; exit 0; fi; echo inactive; exit 3 ;;
  disable) echo "disable $*" >> "$FAKE/svc.log"; rm -f "$FAKE/dir_active"; exit 0 ;;
esac
exit 0`,
  su: `#!/bin/bash
c="\${@: -1}"
case "$c" in
  *"datname='bareos'"*) [ -f "$FAKE/pgdb" ] && echo 1; exit 0 ;;
  *"count(*) FROM job"*) echo 5; exit 0 ;;
  *"dropdb bareos"*) rm -f "$FAKE/pgdb"; echo dropped >> "$FAKE/pg.log"; exit 0 ;;
  *"DROP ROLE"*) echo role >> "$FAKE/pg.log"; exit 0 ;;
esac
exit 0`,
  bconsole: '#!/bin/bash\ncat > /dev/null; cat "$FAKE/bconsole_out" 2>/dev/null; exit "$(cat "$FAKE/bconsole_rc" 2>/dev/null || echo 0)"',
  id: '#!/bin/bash\nif [ "$1" = -u ] && [ -z "${2:-}" ]; then cat "$FAKE/uid" 2>/dev/null || echo 0; exit 0; fi\nexec /usr/bin/id "$@"',
  hostname: '#!/bin/bash\ncase "${1:-}" in (-s) echo edge01;; (-f) echo edge01.corp;; (*) echo edge01;; esac',
  timeout: '#!/bin/bash\nshift; exec "$@"',
};

function env0({ device = '/var/lib/bareos/storage' } = {}) {
  const P = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bareos-reset-')));
  const BIN = path.join(P, '_bin'); const FAKE = path.join(P, '_fake');
  fs.mkdirSync(BIN); fs.mkdirSync(FAKE);
  for (const [n, body] of Object.entries(STUBS)) { fs.writeFileSync(path.join(BIN, n), `${body}\n`); fs.chmodSync(path.join(BIN, n), 0o755); }
  fs.writeFileSync(path.join(FAKE, 'rpmdb'), 'bareos\nbareos-common\nbareos-director\nbareos-database-postgresql\npython3-bareos\nhttpd\nopenssl\n');
  fs.writeFileSync(path.join(FAKE, 'pgdb'), '');
  fs.mkdirSync(path.join(P, 'etc/bareos/bareos-sd.d/device'), { recursive: true });
  fs.writeFileSync(path.join(P, 'etc/bareos/bareos-sd.d/device/FileStorage.conf'), `Device {\n  Name = FileStorage\n  Archive Device = ${device}\n}\n`);
  fs.writeFileSync(path.join(P, 'etc/bareos/bareos-dir.conf'), 'x\n');
  fs.mkdirSync(path.join(P, 'etc/bareos-webui'), { recursive: true });
  fs.mkdirSync(path.join(P, 'var/lib/bareos/storage'), { recursive: true });
  fs.writeFileSync(path.join(P, 'var/lib/bareos/storage/Full-0001'), 'vol');
  fs.writeFileSync(path.join(P, 'var/lib/bareos/storage/Incr-0002'), 'vol');
  fs.mkdirSync(path.join(P, 'var/log/bareos'), { recursive: true });
  fs.mkdirSync(path.join(P, 'var/lib/pgsql/data'), { recursive: true });
  fs.writeFileSync(path.join(P, 'var/lib/pgsql/data/PG_VERSION'), '13\n');
  return { P, BIN, FAKE };
}
function run(e, args = [], { input = '' } = {}) {
  const env = { ...process.env, PATH: `${e.BIN}:${process.env.PATH}`, RESET_ROOT: e.P, FAKE: e.FAKE };
  delete env.PGDATA;
  return spawnSync('bash', [SCRIPT, ...args], { env, input, encoding: 'utf8', timeout: 30_000 });
}
const has = (e, p) => fs.existsSync(path.join(e.P, p));
const pkgs = (e) => fs.readFileSync(path.join(e.FAKE, 'rpmdb'), 'utf8').trim().split('\n').filter(Boolean);
const untouched = (e) => {
  assert.ok(has(e, 'etc/bareos/bareos-dir.conf'), '/etc/bareos 그대로');
  assert.ok(has(e, 'var/lib/bareos/storage/Full-0001'), '볼륨 그대로');
  assert.ok(fs.existsSync(path.join(e.FAKE, 'pgdb')), '카탈로그 DB 그대로');
  assert.ok(pkgs(e).includes('bareos-director'), '패키지 그대로');
};

test('① --dry-run — 지울 것을 보여 주고 아무것도 바꾸지 않는다', () => {
  const e = env0();
  const r = run(e, ['--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /패키지: bareos bareos-common bareos-database-postgresql bareos-director python3-bareos/);
  assert.doesNotMatch(r.stdout, /httpd|openssl/, 'Bareos 가 아닌 패키지는 목록에 없다');
  assert.match(r.stdout, /카탈로그 DB\(bareos\): 있음\(카탈로그 실행 기록 5건\)/);
  assert.match(r.stdout, /볼륨 경로 \/var\/lib\/bareos\/storage: 2개 항목/);
  assert.match(r.stdout, /--dry-run: 아무것도 바꾸지 않았습니다/);
  untouched(e);
});

test('② root 가 아니면 멈춘다 · 모르는 옵션은 거부', () => {
  const e = env0();
  fs.writeFileSync(path.join(e.FAKE, 'uid'), '1000');
  const r = run(e, ['--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /root 로 실행하세요/);
  untouched(e);
  assert.equal(run(env0(), ['--force']).status, 2);
});

test('③ 실행 중 작업 — 있으면 멈춤 · 확인 못 하면(못 읽음 ≠ 0) 멈춤 · --ignore-running 이면 진행', () => {
  const e = env0();
  fs.writeFileSync(path.join(e.FAKE, 'dir_active'), '');
  fs.writeFileSync(path.join(e.FAKE, 'bconsole_out'), 'Connecting to Director localhost:9101\n  jobid: 31\n  jobid: 32\n');
  let r = run(e, ['--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /실행 중인 작업이 2개 있습니다/);
  untouched(e);
  fs.writeFileSync(path.join(e.FAKE, 'bconsole_out'), 'Authorization failed.\n');
  r = run(e, ['--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /실행 중 작업을 확인하지 못했습니다/);
  untouched(e);
  fs.writeFileSync(path.join(e.FAKE, 'bconsole_out'), 'Connecting to Director localhost:9101\nNo results to list.\n');
  r = run(e, ['--dry-run']);
  assert.match(r.stdout, /실행 중 작업: 0개\(bconsole 접속 확인\)/);
  fs.writeFileSync(path.join(e.FAKE, 'bconsole_out'), 'Authorization failed.\n');
  r = run(e, ['--yes', '--ignore-running']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('④ 확인 입력 — 서버 이름이 다르면 아무것도 지우지 않는다 · 맞으면 진행', () => {
  const e = env0();
  let r = run(e, [], { input: 'edge02\n' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /확인 입력이 다릅니다/);
  untouched(e);
  r = run(e, [], { input: 'edge01\n' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!has(e, 'etc/bareos'));
});

test('⑤ 볼륨 — 시스템 경로 · 심링크 경로는 지우지 않는다(디렉터리 안 파일만 · Archive Device 경로만)', () => {
  const e = env0({ device: '/var/lib' });
  fs.writeFileSync(path.join(e.P, 'var/lib/keep-me'), 'x');
  let r = run(e, ['--yes', '--keep-catalog']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /볼륨 경로 \/var\/lib 는 지우지 않음/);
  assert.ok(has(e, 'var/lib/keep-me'), '시스템 경로 안의 파일은 그대로');
  assert.ok(has(e, 'var/lib/pgsql/data/PG_VERSION'), 'PostgreSQL 데이터는 건드리지 않는다');
  // 부모가 심링크인 경로(/srv/link → 실제 볼륨 밖) — 지우지 않는다
  const e2 = env0({ device: '/srv/link/vols' });
  fs.mkdirSync(path.join(e2.P, 'outside/vols'), { recursive: true });
  fs.writeFileSync(path.join(e2.P, 'outside/vols/precious'), 'x');
  fs.mkdirSync(path.join(e2.P, 'srv'), { recursive: true });
  fs.symlinkSync(path.join(e2.P, 'outside'), path.join(e2.P, 'srv/link'));
  r = run(e2, ['--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(has(e2, 'outside/vols/precious'), '심링크 너머는 지우지 않는다');
});

test('⑥ 완전 초기화 — 카탈로그 · 볼륨 · 패키지 · 설정 · 로그 · 로그 파일 · 다시 실행하면 지울 것 없음', () => {
  const e = env0();
  const r = run(e, ['--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(e.FAKE, 'pgdb')), '카탈로그 DB 삭제');
  assert.match(fs.readFileSync(path.join(e.FAKE, 'pg.log'), 'utf8'), /dropped[\s\S]*role/);
  assert.ok(!has(e, 'var/lib/bareos/storage/Full-0001'), '볼륨 삭제');
  for (const p of ['etc/bareos', 'etc/bareos-webui', 'var/log/bareos', 'var/lib/bareos']) assert.ok(!has(e, p), `${p} 삭제`);
  assert.deepEqual(pkgs(e), ['httpd', 'openssl'], 'Bareos 패키지만 지운다');
  assert.match(fs.readFileSync(path.join(e.FAKE, 'dnf.log'), 'utf8'), /--disablerepo=\* --noautoremove remove/);
  assert.match(fs.readFileSync(path.join(e.FAKE, 'svc.log'), 'utf8'), /disable --now bareos-dir/);
  assert.ok(fs.readdirSync(path.join(e.P, 'var/log')).some((f) => /^bareos-reset-\d{8}-\d{6}\.log$/.test(f)), '실행 로그 파일');
  assert.match(r.stdout, /완료 — 포탈 '법인 Bareos 완전 설치' 화면에서 '다시 점검'/);
  const again = run(e, ['--yes']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /지울 Bareos 가 없습니다/);
});

test('⑥ 남길 옵션 — --keep-catalog · --keep-volumes', () => {
  const e = env0();
  const r = run(e, ['--yes', '--keep-catalog', '--keep-volumes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(e.FAKE, 'pgdb')), '카탈로그 남김');
  assert.ok(has(e, 'var/lib/bareos/storage/Full-0001'), '볼륨 남김');
  assert.ok(!has(e, 'etc/bareos'), '설정은 지운다(사전 점검이 /etc/bareos 유무를 본다)');
  assert.ok(!pkgs(e).includes('bareos'), '패키지는 지운다');
});
