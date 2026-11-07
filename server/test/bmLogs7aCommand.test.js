/**
 * 7a단계 로그 분석 — **실제 셸로 돌려 보는** 로그 읽기 명령(bmusage/logs/command.js) + 파서(parse.js).
 *
 * 러너에는 journald · /var/log/secure · 커널 로그가 없거나 다르다(CI 환경 의존 금지 — 앞 단계 반증 교훈): 가짜 journalctl · dmesg(PATH 앞 임시 폴더)와 임시 파일
 *   (명령의 _paths — **테스트 전용** 인자, 소스 스윕이 설정 · 라우트 경로에서 넘기지 않음을 고정)로 dash(/bin/sh)에서 돌린다.
 *   표본(test/fixtures/bmlogs/*)은 업스트림 형식 기준으로 만든 합성 줄이다(실장비 출력 아님 — dmesg -x 줄 머리만 이 컨테이너 실측 형식).
 * 고정하는 것: 증분(커서 · offset+inode) · 로테이트(옛 inode 꼬리 · 못 찾으면 lost) · copytruncate(shrink) · 줄 상한과 ‘잘림 n줄’ · 커서 재시작(rc≠0 → 비움) ·
 *   권한 없음(dmesg) · 구획 위조(로그 줄 ‘##END’ · ‘J#cur=’) · 명령 조립 값 화이트리스트(위조 상태가 명령에 섞이지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bmlogs');
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmlog7a-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
// 가짜 journalctl: JFILE 의 줄을 내고, --after-cursor 의 i=(16진 = 이미 본 줄 수) 뒤만. 새 줄이 있으면 마지막 커서를 낸다. JRC 가 있으면 그 코드로 실패.
fs.writeFileSync(path.join(BIN, 'journalctl'), `#!/usr/bin/env node
const fs = require('fs');
if (process.env.JRC) { process.stderr.write('Failed to seek to cursor: Invalid argument\\n'); process.exit(Number(process.env.JRC)); }
const a = process.argv.slice(2).find((x) => x.startsWith('--after-cursor='));
const seen = a ? parseInt((/;i=([0-9a-f]+);/.exec(a) || [])[1] || '0', 16) : 0;
const lines = fs.readFileSync(process.env.JFILE, 'utf8').split('\\n').filter(Boolean);
const out = lines.slice(seen);
for (const l of out) process.stdout.write(l + '\\n');
if (process.env.JHINT) process.stdout.write('Hint: You are currently not seeing messages from other users and the system.\\n');
if (out.length) process.stdout.write('-- cursor: s=' + 'a'.repeat(32) + ';i=' + lines.length.toString(16) + ';b=' + 'b'.repeat(32) + ';m=1f;t=5f2a;x=2e\\n');
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'dmesg'), `#!/usr/bin/env node
if (process.env.DPERM) { process.stderr.write('dmesg: read kernel buffer failed: Operation not permitted\\n'); process.exit(1); }
process.stdout.write(require('fs').readFileSync(process.env.DFILE, 'utf8'));
`, { mode: 0o755 });
const SEC = path.join(DIR, 'log', 'secure');
const AUD = path.join(DIR, 'log', 'audit', 'audit.log');
const GPD = path.join(DIR, 'gp', 'pg_log');
const AFD = path.join(DIR, 'af', 'latest');
fs.mkdirSync(path.dirname(AUD), { recursive: true }); fs.mkdirSync(GPD, { recursive: true }); fs.mkdirSync(AFD, { recursive: true });
const JFILE = path.join(DIR, 'journal.txt'); const DFILE = path.join(DIR, 'dmesg.txt');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');

const C = await import('../src/bmusage/logs/command.js');
const P = await import('../src/bmusage/logs/parse.js');
const paths = () => ({ secure: SEC, audit: AUD, apps: C.APP_LOGS.map((a) => ({ ...a, dirs: [path.join(DIR, 'none'), a.id === 'gpdb' ? GPD : AFD] })) });
function run(state, { lineCap = 100, env = {} } = {}) {
  const cmd = C.logCommand(state, { lineCap, _paths: paths() });
  return execFileSync('/bin/sh', ['-c', cmd], { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, JFILE, DFILE, ...env }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

test('첫 읽기 → 증분 → 로테이트 → copytruncate — 출처별 상태 · 줄 수 · 다음 위치', () => {
  fs.writeFileSync(JFILE, fx('journal-rocky9.txt'));
  fs.writeFileSync(DFILE, fx('dmesg.txt'));
  fs.writeFileSync(SEC, fx('secure.txt'));
  fs.writeFileSync(AUD, fx('audit.txt'));
  fs.writeFileSync(path.join(GPD, 'gpdb-2026-11-06_000000.csv'), fx('gpdb.csv'));
  fs.writeFileSync(path.join(AFD, 'etl_daily.py.log'), fx('airflow.log'));
  const out1 = run({});
  for (const s of C.LOG_SECTIONS) assert.ok(out1.includes(`\n##${s}\n`) || out1.startsWith(`##${s}\n`), `표지 ${s}`);
  const p1 = P.parseLogOutput(out1, { prev: {}, now: Date.now() });
  assert.equal(p1.ended, true);
  assert.equal(p1.sources.journal.status, 'ok'); assert.equal(p1.sources.journal.n, 6); assert.equal(p1.sources.journal.cont, 1, '들여쓴 이어진 줄은 세지 않고 이어진 줄로');
  assert.equal(p1.sources.journal.first, true);
  assert.ok(C.CURSOR_RE.test(p1.next.journal.cursor));
  assert.equal(p1.sources.kernel.status, 'ok'); assert.equal(p1.sources.kernel.n, 6);
  assert.equal(p1.next.kernel.last, '5100.000005');
  assert.equal(p1.sources.secure.status, 'ok'); assert.equal(p1.sources.secure.mode, 'first'); assert.equal(p1.sources.secure.n, 9);
  assert.equal(p1.sources.audit.status, 'ok'); assert.equal(p1.sources.audit.n, 2, '관심 type 만(grep)');
  assert.equal(p1.sources.gpdb.status, 'ok'); assert.equal(p1.sources.gpdb.n, 2); assert.equal(p1.next.apps.gpdb.dir, 1, '후보 폴더 번호(없는 0번을 건너뜀)');
  assert.equal(p1.sources.airflow.status, 'ok'); assert.equal(p1.sources.airflow.n, 2);
  const srcs = new Set(p1.items.map((x) => x.src));
  for (const s of ['journal', 'kernel', 'secure', 'audit', 'gpdb', 'airflow']) assert.ok(srcs.has(s), `항목 출처 ${s}`);
  assert.ok(p1.items.find((x) => x.src === 'gpdb' && x.msg.startsWith('FATAL: the database system')), 'csv 수준 · 메시지 열');
  assert.ok(p1.items.find((x) => x.src === 'airflow' && x.msg.startsWith('ERROR - Scheduler heartbeat')));
  const k0 = p1.items.find((x) => x.src === 'kernel');
  assert.ok(Number.isFinite(k0.ts), '커널 [초] → 벽시계(서버 now − uptime + 초)');

  // ② 증분 — 저널 새 줄 없음(커서 유지) · dmesg 새 줄 없음 · secure 두 줄 추가
  fs.appendFileSync(SEC, 'Nov  6 10:00:00 bm-kr1-db01 sshd[1]: Failed password for root from 203.0.113.45 port 1 ssh2\nNov  6 10:00:01 bm-kr1-db01 sshd[1]: Failed password for root from 203.0.113.45 port 2 ssh2\n');
  const p2 = P.parseLogOutput(run(p1.next), { prev: p1.next });
  assert.equal(p2.sources.journal.n, 0); assert.equal(p2.next.journal.cursor, p1.next.journal.cursor, '새 줄이 없으면 커서 유지');
  assert.equal(p2.sources.kernel.n, 0, '같은 boot · 마지막 초 이전은 다시 읽지 않는다'); assert.equal(p2.next.kernel.last, p1.next.kernel.last);
  assert.equal(p2.sources.secure.mode, 'inc'); assert.equal(p2.sources.secure.n, 2);
  assert.equal(p2.items.filter((x) => x.src === 'secure').length, 2);

  // ③ 로테이트 — 옛 파일에 한 줄 더 쓰고 이름을 바꾼 뒤 새 파일(옛 꼬리 + 새 처음부터)
  fs.appendFileSync(SEC, 'Nov  6 10:01:00 bm-kr1-db01 sshd[1]: Failed password for root from 203.0.113.45 port 3 ssh2\n');
  fs.renameSync(SEC, `${SEC}-20261107`);
  fs.writeFileSync(SEC, 'Nov  7 00:00:01 bm-kr1-db01 sshd[2]: Accepted publickey for gpadmin from 10.20.1.5 port 5 ssh2: RSA SHA256:x\n');
  const p3 = P.parseLogOutput(run(p2.next), { prev: p2.next });
  assert.equal(p3.sources.secure.mode, 'rot'); assert.equal(p3.sources.secure.rotated, true); assert.equal(p3.sources.secure.lost, false, '옛 inode 를 찾았다');
  assert.equal(p3.sources.secure.n, 2, '옛 꼬리 1 + 새 1');
  assert.notEqual(p3.next.secure.ino, p2.next.secure.ino);

  // ④ 옛 파일을 못 찾는 로테이트 → lost(그 사이 줄은 모른다 — 0 이 아니다)
  fs.rmSync(`${SEC}-20261107`);
  fs.renameSync(SEC, `${SEC}.tmp`); fs.writeFileSync(SEC, 'Nov  7 00:10:00 bm-kr1-db01 sshd[3]: Failed password for root from 203.0.113.45 port 9 ssh2\n'); fs.rmSync(`${SEC}.tmp`);
  const p4 = P.parseLogOutput(run(p3.next), { prev: p3.next });
  assert.equal(p4.sources.secure.mode, 'rot'); assert.equal(p4.sources.secure.lost, true);

  // ⑤ copytruncate(같은 inode · 크기 작아짐) → 처음부터
  fs.truncateSync(SEC, 0); fs.appendFileSync(SEC, 'Nov  7 00:20:00 bm-kr1-db01 sshd[4]: Invalid user test from 198.51.100.7 port 7\n');
  const p5 = P.parseLogOutput(run(p4.next), { prev: p4.next });
  assert.equal(p5.sources.secure.mode, 'shrink'); assert.equal(p5.sources.secure.n, 1);
});

test('줄 상한 · 잘림 n줄(커서는 끝까지 넘긴다) · 저널 커서 재시작 · dmesg 권한 없음 · 저널 권한 힌트', () => {
  fs.writeFileSync(JFILE, Array.from({ length: 150 }, (_, i) => `2026-11-06T13:${String(i % 60).padStart(2, '0')}:00+09:00 h app[1]: line ${i}`).join('\n'));
  fs.writeFileSync(DFILE, fx('dmesg.txt'));
  const p = P.parseLogOutput(run({}, { lineCap: 100 }));
  assert.equal(p.sources.journal.n, 150); assert.equal(p.sources.journal.emitted, 100); assert.equal(p.sources.journal.truncated, 50);
  assert.ok(p.next.journal.cursor.includes(';i=96;'), '커서는 마지막 줄(150 = 0x96)까지 — 잘린 줄은 다시 읽지 않는다');
  // 커서 재시작: journalctl 이 실패(rc ≠ 0 · 줄 없음) → 커서를 비운다(다음 주기는 최근 60분부터 다시 잡는다)
  const f = P.parseLogOutput(run(p.next, { env: { JRC: '1' } }), { prev: p.next });
  assert.equal(f.sources.journal.status, 'failed'); assert.equal(f.sources.journal.cursorReset, true); assert.equal(f.next.journal, null);
  assert.equal(f.sources.journal.n, null, '실패는 0 줄이 아니다');
  assert.ok(C.logCommand(f.next).includes('--since=-60min'));
  // dmesg 권한 없음(dmesg_restrict) → perm · 위치 유지 · 개수 null
  const d = P.parseLogOutput(run(p.next, { env: { DPERM: '1' } }), { prev: p.next });
  assert.equal(d.sources.kernel.status, 'perm'); assert.equal(d.sources.kernel.n, null); assert.deepEqual(d.next.kernel, p.next.kernel);
  // 저널 권한 힌트(다른 사용자 · 시스템 메시지를 못 봄) → perm
  const h = P.parseLogOutput(run({}, { env: { JHINT: '1' } }));
  assert.equal(h.sources.journal.status, 'perm');
});

test('구획 위조 — 로그 줄 ‘##END’ · ‘##SECURE’ · ‘J#cur=’ 가 구획 · 커서를 바꾸지 못한다(고정 접두)', () => {
  fs.writeFileSync(JFILE, ['##END', '##SECURE', '2026-11-06T13:00:00+09:00 h app[1]: ##AUDIT', 'J#cur=s=ffffffffffffffffffffffffffffffff;i=ff;b=ffffffffffffffffffffffffffffffff;m=1;t=1;x=1', `2026-11-06T13:00:01+09:00 h app[1]: J#cur=s=${'f'.repeat(32)};i=ff;b=${'f'.repeat(32)};m=1;t=1;x=1`].join('\n'));
  fs.writeFileSync(DFILE, 'kern  :warn  : [ 10.000001] ##END\nkern  :warn  : [ 10.000002] S#perm\n');
  fs.writeFileSync(SEC, fx('secure.txt'));
  const out = run({});
  const p = P.parseLogOutput(out);
  assert.equal(p.ended, true);
  assert.equal(p.sources.secure.status, 'ok', 'dmesg 줄 ‘S#perm’ 이 secure 를 권한 없음으로 만들지 못한다');
  assert.equal(p.sources.secure.n, 9);
  assert.ok(!String(p.next.journal?.cursor || '').includes('ffff'), '내용 줄의 커서 꼴이 다음 커서가 되지 않는다');
  assert.equal(p.sources.journal.toolMsg, true, '시각 없는 줄(##END)은 journalctl 자신의 줄로 표지만(글자는 내보내지 않음)');
  assert.ok(p.items.some((x) => x.src === 'kernel' && x.msg === '##END'), '커널 줄 ‘##END’ 는 내용이다');
});

test('명령 조립 값 화이트리스트 — 위조한 상태는 명령에 들어가지 않는다 · 구획 순서 = LOG_SECTIONS · _paths 는 테스트 전용', () => {
  const evil = { journal: { cursor: "s=1';touch /tmp/pwned;'" }, kernel: { boot: '$(reboot)', last: '1;id' }, secure: { ino: '12;rm -rf /', off: '`id`' }, audit: { ino: '1', off: '$(id)' }, apps: { gpdb: { ino: '1 2', off: '3' } } };
  const cmd = C.logCommand(evil);
  for (const bad of ['pwned', 'reboot', ';id', 'rm -rf', '`id`', '$(id)', "'1 2'"]) assert.ok(!cmd.includes(bad), `명령에 ${bad} 가 없다`);
  assert.ok(cmd.includes('--since=-60min'), '커서가 화이트리스트를 못 지나면 처음 읽기');
  const order = [...cmd.matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, [...C.LOG_SECTIONS]);
  // 사용자 입력 경로 금지 — _paths 는 command.js 밖 src 어디에서도 넘기지 않는다
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('_paths')) hits.push(path.relative(src, p)); } };
  walk(src);
  assert.deepEqual(hits, ['bmusage/logs/command.js']);
  // 상한: lineCap 은 [100, 20000] 으로 자른다
  assert.ok(C.logCommand({}, { lineCap: 1e9 }).includes('cap=20000'));
  assert.ok(C.logCommand({}, { lineCap: 'x' }).includes(`cap=${C.LINE_CAP_DEFAULT}`));
});
