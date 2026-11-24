/**
 * 7a단계 로그 분석 — **실제 셸로 돌려 보는** 로그 읽기 명령(bmusage/logs/command.js) + 파서(parse.js).
 *
 * 러너에는 journald · /var/log/secure · 커널 로그가 없거나 다르다(CI 환경 의존 금지 — 앞 단계 반증 교훈): 가짜 journalctl · dmesg(PATH 앞 임시 폴더)와 임시 파일
 *   (명령의 _paths — **테스트 전용** 인자, 소스 스윕이 설정 · 라우트 경로에서 넘기지 않음을 고정)로 dash(/bin/sh)에서 돌린다.
 *   표본(test/fixtures/bmlogs/*)은 업스트림 형식 기준으로 만든 합성 줄이다(실장비 출력 아님 — dmesg -x 줄 머리만 이 컨테이너 실측 형식).
 * 가짜 journalctl 은 `-o json` 처럼 한 줄 = 한 항목에 __CURSOR · __MONOTONIC_TIMESTAMP · _BOOT_ID 를 붙이고(i= 가 항목 번호), **-q 가 없을 때만** 권한 힌트를 낸다
 *   (systemd v239 · v252 journal_access_check_and_warn 원문 — 반증 F2: 예전 가짜는 -q 를 무시하고 힌트를 찍어 결함을 덮었다).
 * 고정하는 것: 증분(커서 · offset+inode) · 로테이트 · copytruncate · 줄 상한과 ‘잘림 n줄’ · 출처 바이트 상한(반증 F4 — 영구 정지 없음) · 시한(rc 124 — 본 데까지 커서 · F5) ·
 *   dmesg 첫 읽기(가동 마지막 60분 · F6) · 끝 줄 미완성(다음 주기로 · F14) · 0700 상위 폴더 = 권한 없음(F3) · 숫자 화이트리스트(선행 0 · 19자리 · F13) ·
 *   권한 없음(dmesg · 저널 힌트 · 저널 하나도 못 엶) · 구획 위조 · 명령 조립 값 화이트리스트.
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
test.after(() => { try { execFileSync('chmod', ['-R', 'u+rwx', DIR]); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
// 가짜 journalctl: SYSLOG_IDENTIFIER= 인자가 있으면 JQFILE(보안 읽기), 없으면 JFILE. --after-cursor 의 i=(16진 = 이미 본 항목 수) 뒤만.
//   JRC = 그 코드로 실패 · JHINT = 힌트(-q 가 없을 때만) · JNONE = 저널 하나도 못 엶(rc 1) · JNOFILES = 저널 파일 없음 · JSTALL=N = N 항목 뒤 rc 124(timeout 이 죽인 것과 같은 종료 코드).
fs.writeFileSync(path.join(BIN, 'journalctl'), `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const quiet = argv.includes('-q') || argv.includes('--quiet');
const sec = argv.some((x) => x.startsWith('SYSLOG_IDENTIFIER='));
if (process.env.JRC) { process.stderr.write('Failed to seek to cursor: Invalid argument\\n'); process.exit(Number(process.env.JRC)); }
if (process.env.JNONE) { process.stderr.write('No journal files were opened due to insufficient permissions.\\n'); process.exit(1); }
if (process.env.JNOFILES) { if (!quiet) process.stderr.write('No journal files were found.\\n'); process.exit(0); }
const a = argv.find((x) => x.startsWith('--after-cursor='));
const seen = a ? parseInt((/;i=([0-9a-f]+);/.exec(a) || [])[1] || '0', 16) : 0;
const file = sec ? process.env.JQFILE : process.env.JFILE;
const lines = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean) : [];
const stall = process.env.JSTALL ? Number(process.env.JSTALL) : Infinity;
let k = 0;
const out = [];
for (let i = seen; i < lines.length; i += 1) {
  if (k >= stall) break;
  const cur = 's=' + 'a'.repeat(32) + ';i=' + (i + 1).toString(16) + ';b=' + 'b'.repeat(32) + ';m=1f;t=5f2a;x=2e';
  out.push('{"__CURSOR":"' + cur + '","__MONOTONIC_TIMESTAMP":"123456","_BOOT_ID":"' + 'c'.repeat(32) + '",' + lines[i].slice(1));
  k += 1;
}
process.stdout.write(out.length ? out.join('\\n') + '\\n' : '');
if (process.env.JHINT && !quiet) process.stderr.write('Hint: You are currently not seeing messages from other users and the system.\\n      Users in groups \\'adm\\', \\'systemd-journal\\', \\'wheel\\' can see all messages.\\n      Pass -q to turn off this notice.\\n');
if (k >= stall) process.exit(124);
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'dmesg'), `#!/usr/bin/env node
if (process.env.DPERM) { process.stderr.write('dmesg: read kernel buffer failed: Operation not permitted\\n'); process.exit(1); }
process.stdout.write(require('fs').readFileSync(process.env.DFILE, 'utf8'));
`, { mode: 0o755 });
const SEC = path.join(DIR, 'log', 'secure');
const AUD = path.join(DIR, 'log', 'audit', 'audit.log');
const GPD = path.join(DIR, 'gp', 'pg_log');
const AFD = path.join(DIR, 'af', 'latest');
const BOOTF = path.join(DIR, 'boot_id'); const UPF = path.join(DIR, 'uptime');
const BOOT = '3818fa4e-dde8-4491-a53a-a696101a21ab';
fs.writeFileSync(BOOTF, `${BOOT}\n`); fs.writeFileSync(UPF, '5200.00 1000.00\n');
fs.mkdirSync(path.dirname(AUD), { recursive: true }); fs.mkdirSync(GPD, { recursive: true }); fs.mkdirSync(AFD, { recursive: true });
const JFILE = path.join(DIR, 'journal.jsonl'); const JQFILE = path.join(DIR, 'jsec.jsonl'); const DFILE = path.join(DIR, 'dmesg.txt');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');

const C = await import('../src/bmusage/logs/command.js');
const P = await import('../src/bmusage/logs/parse.js');
const { MAX_SECTION_LINES } = await import('../src/bmusage/parse/linuxProc.js');
const paths = (extra = {}) => ({ secure: SEC, audit: AUD, bootId: BOOTF, uptime: UPF, apps: C.APP_LOGS.map((a) => ({ ...a, dirs: [path.join(DIR, 'none'), a.id === 'gpdb' ? GPD : AFD] })), ...extra });
function run(state, { lineCap = 100, env = {}, _paths = null, wrap = null } = {}) {
  const cmd = C.logCommand(state, { lineCap, _paths: _paths || paths() });
  const [bin, args] = wrap ? [wrap[0], [...wrap.slice(1), '/bin/sh', '-c', cmd]] : ['/bin/sh', ['-c', cmd]];
  return execFileSync(bin, args, { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, JFILE, JQFILE, DFILE, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
const jline = (i, msg, ident = 'app') => JSON.stringify({ __REALTIME_TIMESTAMP: String((Date.now() - 600_000 + i) * 1000), PRIORITY: '4', SYSLOG_IDENTIFIER: ident, _PID: '1', _COMM: ident, MESSAGE: msg });

// 표본 시각(2026-11-06 15:00 기준)을 ‘지금’ 의 정시 경계로 옮긴다(common.md — 고정 epoch 는 30일 뒤 ‘오래된 줄’ 이 되어 깨진다 · Date.now() 직접도 경계에서 흔들린다).
const HOUR = 3_600_000;
const FX_BASE = Date.parse('2026-11-06T15:00:00+09:00');
const BASE = Math.floor(Date.now() / HOUR) * HOUR;
const shiftJ = (text) => text.split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); o.__REALTIME_TIMESTAMP = String(Number(o.__REALTIME_TIMESTAMP) + (BASE - FX_BASE) * 1000); return JSON.stringify(o); }).join('\n');

test('첫 읽기 → 증분 → 로테이트 → copytruncate — 출처별 상태 · 줄 수 · 다음 위치 · 보안 출처 하나(secure)', () => {
  fs.writeFileSync(JFILE, shiftJ(fx('journal.jsonl'))); fs.writeFileSync(JQFILE, shiftJ(fx('jsec.jsonl')));
  fs.writeFileSync(DFILE, fx('dmesg.txt'));
  fs.writeFileSync(SEC, fx('secure.txt'));
  fs.writeFileSync(AUD, fx('audit.txt'));
  fs.writeFileSync(path.join(GPD, 'gpdb-2026-11-06_000000.csv'), fx('gpdb.csv'));
  fs.writeFileSync(path.join(AFD, 'etl_daily.py.log'), fx('airflow.txt'));
  const out1 = run({});
  for (const s of C.LOG_SECTIONS) assert.ok(out1.includes(`\n##${s}\n`) || out1.startsWith(`##${s}\n`), `표지 ${s}`);
  assert.ok(!out1.includes('__CURSOR') && !out1.includes('_BOOT_ID'), '커서 · boot_id 는 내보내는 줄에서 뺀다(바이트 상한 안에 줄을 더)');
  const p1 = P.parseLogOutput(out1, { prev: {}, now: Date.now() });
  assert.equal(p1.ended, true);
  assert.equal(p1.sources.journal.status, 'ok'); assert.equal(p1.sources.journal.n, 7);
  assert.equal(p1.sources.journal.authSkipped, 1, '주 저널의 sshd 줄은 JSEC 가 센다(두 번 세지 않게)');
  assert.equal(p1.sources.journal.first, true);
  assert.ok(Number.isInteger(p1.sources.journal.uid), '수집 계정 uid(권한 안내용)');
  assert.ok(C.CURSOR_RE.test(p1.next.journal.cursor) && p1.next.journal.cursor.includes(';i=7;'));
  const nm = p1.items.find((x) => x.unit === 'NetworkManager');
  assert.ok(nm.msg.includes('request timed out') && nm.msg.includes('이어진 줄'), '여러 줄 메시지는 한 항목(줄바꿈은 공백)');
  assert.ok(p1.items.find((x) => x.unit === 'app' && x.msg.includes('No space left on device')), '바이트 배열 MESSAGE 도 글자로');
  assert.equal(nm.ts, Date.parse('2026-11-06T13:43:10+09:00') + (BASE - FX_BASE), '__REALTIME_TIMESTAMP(µs) → ms');
  assert.equal(p1.sources.jsec.status, 'ok'); assert.equal(p1.sources.jsec.n, 11);
  assert.equal(p1.authSrc, 'secure', 'secure 를 읽었으면 보안 줄은 secure 하나만');
  assert.equal(p1.sources.jsec.dup, 11); assert.equal(p1.sources.jsec.dupOf, 'secure');
  assert.equal(p1.items.filter((x) => x.src === 'jsec').length, 0);
  assert.equal(p1.sources.kernel.status, 'ok'); assert.equal(p1.sources.kernel.n, 6); assert.equal(p1.sources.kernel.first, true); assert.equal(p1.sources.kernel.older, 0);
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
  assert.equal(p2.sources.journal.first, undefined, '커서가 있으면 첫 읽기 아님');
  assert.equal(p2.sources.kernel.n, 0, '같은 boot · 마지막 초 이전은 다시 읽지 않는다'); assert.equal(p2.next.kernel.last, p1.next.kernel.last); assert.equal(p2.sources.kernel.first, undefined);
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

test('secure 를 못 읽으면 journald 보안(JSEC)이 보안 출처 — 같은 기록을 두 번 세지 않는다 · rsyslog 가 멈췄으면 JSEC', () => {
  fs.writeFileSync(JFILE, fx('journal.jsonl')); fs.writeFileSync(JQFILE, fx('jsec.jsonl')); fs.writeFileSync(DFILE, fx('dmesg.txt'));
  const p = P.parseLogOutput(run({}, { _paths: paths({ secure: path.join(DIR, 'nope', 'secure') }) }));
  assert.equal(p.sources.secure.status, 'absent');
  assert.equal(p.authSrc, 'jsec'); assert.equal(p.items.filter((x) => x.src === 'jsec').length, 11); assert.equal(p.sources.jsec.dup, undefined);
  assert.equal(P.pickAuthSource({ secure: { status: 'ok', svc: 'inactive' }, jsec: { status: 'ok' } }), 'jsec', 'rsyslog 가 멈춘 secure 는 새 줄이 안 쌓인다');
  assert.equal(P.pickAuthSource({ secure: { status: 'ok', svc: null }, jsec: { status: 'ok' } }), 'secure', 'rsyslog 상태를 모르면 secure');
  assert.equal(P.pickAuthSource({ secure: { status: 'perm' }, jsec: { status: 'perm', scope: 'own' }, audit: { status: 'ok' } }), 'audit');
  assert.equal(P.pickAuthSource({ secure: { status: 'perm' }, jsec: { status: 'perm' }, audit: { status: 'perm' } }), null);
});

test('줄 상한 · 잘림 n줄(커서는 본 데까지) · 저널 커서 재시작 · dmesg 권한 없음 · 저널 권한(힌트 · 하나도 못 엶 · 파일 없음) — -q 를 쓰지 않는다(반증 F2)', () => {
  fs.writeFileSync(JFILE, Array.from({ length: 150 }, (_, i) => jline(i, `line ${i}`)).join('\n'));
  fs.writeFileSync(JQFILE, '');
  fs.writeFileSync(DFILE, fx('dmesg.txt'));
  const p = P.parseLogOutput(run({}, { lineCap: 100 }));
  assert.equal(p.sources.journal.n, 150); assert.equal(p.sources.journal.emitted, 100); assert.equal(p.sources.journal.truncated, 50);
  assert.ok(p.next.journal.cursor.includes(';i=96;'), '커서는 본 마지막 항목(150 = 0x96)까지 — 잘린 줄은 다시 읽지 않는다');
  // 커서 재시작: journalctl 이 실패(rc ≠ 0 · 항목 없음) → 커서를 비운다(다음 주기는 최근 60분부터 다시 잡는다)
  const f = P.parseLogOutput(run(p.next, { env: { JRC: '1' } }), { prev: p.next });
  assert.equal(f.sources.journal.status, 'failed'); assert.equal(f.sources.journal.cursorReset, true); assert.equal(f.next.journal, null);
  assert.equal(f.sources.journal.n, null, '실패는 0 줄이 아니다');
  assert.ok(C.logCommand(f.next).includes('--since=-60min'));
  // dmesg 권한 없음(dmesg_restrict) → perm · 위치 유지 · 개수 null
  const d = P.parseLogOutput(run(p.next, { env: { DPERM: '1' } }), { prev: p.next });
  assert.equal(d.sources.kernel.status, 'perm'); assert.equal(d.sources.kernel.n, null); assert.deepEqual(d.next.kernel, p.next.kernel);
  // -q 를 쓰지 않는다 — 가짜 journalctl 은 -q 면 힌트를 끈다(원문 동작). 힌트 → 자기 저널만(perm/own · 세지 않음)
  const cmd = C.logCommand({});
  assert.ok(!/journalctl[^\n|]* -q\b/.test(cmd) && !cmd.includes('--quiet'), 'journalctl 에 -q 를 붙이지 않는다(힌트가 꺼진다)');
  const h = P.parseLogOutput(run({}, { env: { JHINT: '1' } }));
  assert.equal(h.sources.journal.status, 'perm'); assert.equal(h.sources.journal.scope, 'own'); assert.equal(h.sources.journal.n, null);
  assert.equal(h.items.filter((x) => x.src === 'journal').length, 0, '자기 저널 줄은 세지 않는다');
  assert.ok(C.CURSOR_RE.test(h.next.journal.cursor), '자기 저널만이어도 위치는 넘긴다');
  const none = P.parseLogOutput(run({}, { env: { JNONE: '1' } }));
  assert.equal(none.sources.journal.status, 'perm'); assert.equal(none.sources.journal.scope, 'none'); assert.equal(none.sources.jsec.scope, 'none');
  const nf = P.parseLogOutput(run({}, { env: { JNOFILES: '1' } }));
  assert.equal(nf.sources.journal.status, 'absent'); assert.equal(nf.sources.journal.nofiles, true);
});

test('반증 F5 — journalctl 시한(rc 124): 본 항목까지 커서가 넘어가 다음 주기에 같은 줄을 다시 세지 않는다', () => {
  fs.writeFileSync(JFILE, Array.from({ length: 80 }, (_, i) => jline(i, `stall ${i}`)).join('\n'));
  fs.writeFileSync(JQFILE, '');
  const a = P.parseLogOutput(run({}, { env: { JSTALL: '50' } }));
  assert.equal(a.sources.journal.status, 'ok'); assert.equal(a.sources.journal.partial, 'timeout'); assert.equal(a.sources.journal.n, 50);
  assert.ok(a.next.journal.cursor.includes(';i=32;'), '본 50번째(0x32) 항목의 커서');
  const b = P.parseLogOutput(run(a.next, { env: { JSTALL: '50' } }), { prev: a.next });
  assert.equal(b.sources.journal.n, 30, '남은 30 항목만');
  const seen = [...a.items, ...b.items].filter((x) => x.src === 'journal').map((x) => x.msg);
  assert.equal(new Set(seen).size, seen.length, '같은 줄을 두 번 세지 않는다');
  assert.equal(seen.length, 80);
  // 시한인데 본 항목이 없다 → 실패 · 커서 유지(비우지 않는다 — 다음 주기에 같은 곳부터)
  const c = P.parseLogOutput(run(b.next, { env: { JSTALL: '0' } }), { prev: b.next });
  assert.equal(c.sources.journal.status, 'failed'); assert.equal(c.sources.journal.reason, 'timeout'); assert.deepEqual(c.next.journal, b.next.journal);
});

test('반증 F4 — 출처 바이트 상한: 상한을 범위 끝까지 올리고 큰 저널 백로그여도 출력이 상한 안 · 모든 구획 도착 · 커서 전진(영구 정지 없음)', () => {
  // 산수 고정: 출처 수 × 출처 바이트 + 메타 여유 ≤ 전체 상한 < sshExec 상한(4MB) · 한 구획 줄 수(앱 두 개가 한 구획) < splitSections 구획 줄 상한
  assert.ok(C.LOG_SOURCE_COUNT * C.SRC_BYTES + C.META_RESERVE <= C.OUTPUT_MAX);
  assert.ok(C.OUTPUT_MAX < 4 * 1024 * 1024);
  assert.ok(2 * C.LINE_CAP_RANGE[1] + 64 < MAX_SECTION_LINES, `APPLOG 구획 2 × ${C.LINE_CAP_RANGE[1]} + 메타 < ${MAX_SECTION_LINES}`);
  assert.ok(C.LINE_CAP_RANGE[1] + 64 < MAX_SECTION_LINES);
  const big = 'x'.repeat(600);
  fs.writeFileSync(JFILE, Array.from({ length: 12_000 }, (_, i) => jline(i, `${i} ${big}`)).join('\n'));
  fs.writeFileSync(JQFILE, ''); fs.writeFileSync(DFILE, fx('dmesg.txt')); fs.writeFileSync(SEC, fx('secure.txt'));
  const out = run({}, { lineCap: C.LINE_CAP_RANGE[1] });
  assert.ok(Buffer.byteLength(out) <= C.OUTPUT_MAX, `출력 ${Buffer.byteLength(out)}B ≤ ${C.OUTPUT_MAX}`);
  const jBytes = out.split('\n').filter((l) => l.startsWith('J|')).reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
  assert.ok(jBytes <= C.SRC_BYTES + 4096, `저널 내용 ${jBytes}B ≤ 출처 상한 ${C.SRC_BYTES}`);
  const p = P.parseLogOutput(out);
  assert.equal(p.ended, true, '##END 도착');
  for (const s of ['kernel', 'secure', 'audit', 'gpdb', 'airflow']) assert.notEqual(p.sources[s].status, 'missing', `${s} 구획이 밀려나지 않는다`);
  assert.equal(p.sources.journal.n, 12_000); assert.ok(p.sources.journal.truncated > 0, '넘친 줄은 잘림으로 센다');
  assert.ok(p.next.journal.cursor.includes(`;i=${(12_000).toString(16)};`), '커서는 본 끝까지 — 다음 주기는 새 줄만');
  const p2 = P.parseLogOutput(run(p.next, { lineCap: C.LINE_CAP_RANGE[1] }), { prev: p.next });
  assert.equal(p2.sources.journal.n, 0, '같은 백로그를 다시 읽지 않는다(회복)');
});

test('반증 F6 — dmesg 첫 읽기는 가동 마지막 60분만(옛 부팅 줄을 ‘지금’ 사건으로 세지 않는다) · 그 다음은 증분', () => {
  const up = 200 * 86_400;
  fs.writeFileSync(UPF, `${up}.00 1.00\n`);
  fs.writeFileSync(DFILE, [
    'kern  :err   : [   12.000001] EDAC MC0: 1 CE memory read error on CPU_SrcID#0_Ha#0_Chan#2_DIMM#1 (channel:2 slot:1 page:0x0 offset:0x0 grain:32 syndrome:0x0)',
    'kern  :warn  : [   15.000002] pcieport 0000:00:03.0: AER: Corrected error received: 0000:3b:00.0',
    `kern  :warn  : [${(up - 60).toFixed(6)}] nvme nvme1: I/O 1024 QID 7 timeout, completion polled`,
  ].join('\n') + '\n');
  fs.writeFileSync(JFILE, ''); fs.writeFileSync(JQFILE, '');
  try {
    const a = P.parseLogOutput(run({}));
    assert.equal(a.sources.kernel.n, 1); assert.equal(a.sources.kernel.first, true); assert.equal(a.sources.kernel.older, 2, '앞 2줄은 세지 않음(위치만)');
    assert.deepEqual(a.items.filter((x) => x.src === 'kernel').map((x) => x.msg), ['nvme nvme1: I/O 1024 QID 7 timeout, completion polled']);
    assert.equal(a.next.kernel.boot, BOOT); assert.equal(a.next.kernel.last, `${up - 60}.000000`);
    fs.appendFileSync(DFILE, `kern  :err   : [${(up - 1).toFixed(6)}] mce: [Hardware Error]: Machine check events logged\n`);
    const b = P.parseLogOutput(run(a.next), { prev: a.next });
    assert.equal(b.sources.kernel.n, 1); assert.equal(b.sources.kernel.first, undefined);
    // uptime 을 모르면 첫 읽기는 위치만 잡는다(지난 줄을 세지 않는다)
    fs.writeFileSync(UPF, '');
    const c = P.parseLogOutput(run({}));
    assert.equal(c.sources.kernel.n, 0); assert.equal(c.sources.kernel.older, 4);
  } finally { fs.writeFileSync(UPF, '5200.00 1000.00\n'); }
});

test('반증 F14 — 파일 끝 줄이 미완성이면 그 조각은 다음 주기로(사건을 두 조각으로 나눠 놓치지 않는다)', () => {
  fs.writeFileSync(JFILE, ''); fs.writeFileSync(JQFILE, ''); fs.writeFileSync(DFILE, fx('dmesg.txt'));
  fs.writeFileSync(SEC, 'Nov  6 10:00:00 h sshd[1]: Accepted publickey for gpadmin from 10.20.1.5 port 5 ssh2: RSA SHA256:x\n');
  const a = P.parseLogOutput(run({}));
  fs.appendFileSync(SEC, 'Nov  6 10:00:01 h sshd[1]: Failed passw');
  const b = P.parseLogOutput(run(a.next), { prev: a.next });
  assert.equal(b.sources.secure.n, 0, '미완성 조각은 이번에 세지 않는다'); assert.equal(b.sources.secure.partial, Buffer.byteLength('Nov  6 10:00:01 h sshd[1]: Failed passw'));
  assert.equal(b.next.secure.off, a.next.secure.off, '위치는 조각 앞(마지막 개행 뒤)');
  fs.appendFileSync(SEC, 'ord for root from 203.0.113.45 port 2 ssh2\n');
  const c = P.parseLogOutput(run(b.next), { prev: b.next });
  assert.equal(c.sources.secure.n, 1);
  assert.equal(c.items.find((x) => x.src === 'secure').msg, 'Failed password for root from 203.0.113.45 port 2 ssh2', '온전한 한 줄로 한 번');
});

test('큰 파일 첫 읽기는 끝 FIRST_FILE_BYTES 안만(처음부터 두 번 읽지 않는다 — 반증 의심) · 창 첫 줄(조각)은 버린다', () => {
  fs.writeFileSync(JFILE, ''); fs.writeFileSync(JQFILE, ''); fs.writeFileSync(DFILE, fx('dmesg.txt'));
  const line = (i) => `Nov  6 10:00:00 h sshd[1]: Accepted publickey for gpadmin from 10.20.1.5 port ${i} ssh2: ${'x'.repeat(1990)}\n`;
  fs.writeFileSync(SEC, Array.from({ length: 150 }, (_, i) => line(i)).join(''));
  const size = fs.statSync(SEC).size;
  assert.ok(size > C.FIRST_FILE_BYTES && 150 < C.FIRST_FILE_LINES);
  const p = P.parseLogOutput(run({}));
  assert.equal(p.sources.secure.mode, 'first');
  assert.ok(p.sources.secure.n < 150 && p.sources.secure.n >= Math.floor(C.FIRST_FILE_BYTES / Buffer.byteLength(line(100))) - 1, `끝 창 안 줄만: ${p.sources.secure.n}`);
  assert.equal(p.next.secure.off, String(size), '위치는 파일 끝');
});

test('반증 F3 — 0700 상위 폴더 안 로그는 ‘없음’ 이 아니라 ‘권한 없음’(auditd · 용도 로그) · 공용 상위(/root 등)가 막힌 것은 ‘없음’', (t) => {
  const isRoot = process.getuid?.() === 0;
  const hasSetpriv = (() => { try { execFileSync('setpriv', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (isRoot && !hasSetpriv) { t.skip('root 인데 setpriv 가 없다(권한 우회를 끌 수 없음)'); return; }
  const wrap = isRoot ? ['setpriv', '--bounding-set=-all', '--inh-caps=-all'] : null;
  const AD = path.join(DIR, 'lock', 'audit'); const LG = path.join(DIR, 'lock', 'gp-root');
  fs.mkdirSync(AD, { recursive: true }); fs.writeFileSync(path.join(AD, 'audit.log'), fx('audit.txt'));
  fs.mkdirSync(path.join(LG, 'master', 'gpseg-1', 'pg_log'), { recursive: true }); fs.writeFileSync(path.join(LG, 'master', 'gpseg-1', 'pg_log', 'gpdb-1.csv'), fx('gpdb.csv'));
  const PUB = path.join(DIR, 'lock', 'pubroot'); fs.mkdirSync(PUB, { recursive: true });
  fs.chmodSync(AD, 0o000); fs.chmodSync(LG, 0o000); fs.chmodSync(PUB, 0o000);
  fs.writeFileSync(JFILE, ''); fs.writeFileSync(JQFILE, '');
  try {
    const apps = C.APP_LOGS.map((a) => (a.id === 'gpdb'
      ? { ...a, dirs: [{ anchor: LG, path: path.join(LG, 'master', 'gpseg-1', 'pg_log') }] }
      : { ...a, dirs: [{ anchor: path.join(PUB, 'airflow'), path: path.join(PUB, 'airflow', 'logs', 'scheduler', 'latest') }] }));
    const p = P.parseLogOutput(run({}, { _paths: paths({ audit: path.join(AD, 'audit.log'), apps }), wrap }));
    assert.equal(p.sources.audit.status, 'perm'); assert.equal(p.sources.audit.scope, 'dir');
    assert.equal(p.sources.gpdb.status, 'perm'); assert.equal(p.sources.gpdb.scope, 'dir');
    assert.equal(p.sources.airflow.status, 'absent', '뿌리보다 위(공용 상위)가 막힌 것은 그 앱의 권한 문제가 아니다');
    // 대조: 파일 자체만 못 읽으면 perm/file
    fs.chmodSync(AD, 0o755); fs.chmodSync(path.join(AD, 'audit.log'), 0o000);
    const q = P.parseLogOutput(run({}, { _paths: paths({ audit: path.join(AD, 'audit.log'), apps }), wrap }));
    assert.equal(q.sources.audit.status, 'perm'); assert.equal(q.sources.audit.scope, 'file');
  } finally { fs.chmodSync(AD, 0o755); fs.chmodSync(LG, 0o755); fs.chmodSync(PUB, 0o755); }
});

test('구획 위조 — 로그 줄 ‘##END’ · ‘##SECURE’ · ‘J#cur=’ 가 구획 · 커서를 바꾸지 못한다(고정 접두)', () => {
  fs.writeFileSync(JFILE, [jline(1, '##END'), jline(2, '##SECURE'), jline(3, `J#cur=s=${'f'.repeat(32)};i=ff;b=${'f'.repeat(32)};m=1;t=1;x=1`), jline(4, '"__CURSOR":"s=ffff"')].join('\n'));
  fs.writeFileSync(JQFILE, '');
  fs.writeFileSync(DFILE, 'kern  :warn  : [ 4999.000001] ##END\nkern  :warn  : [ 4999.000002] S#perm\n');
  fs.writeFileSync(SEC, fx('secure.txt'));
  const out = run({});
  const p = P.parseLogOutput(out);
  assert.equal(p.ended, true);
  assert.equal(p.sources.secure.status, 'ok', 'dmesg 줄 ‘S#perm’ 이 secure 를 권한 없음으로 만들지 못한다');
  assert.equal(p.sources.secure.n, 9);
  assert.ok(!String(p.next.journal?.cursor || '').includes('ffff'), '내용 줄의 커서 꼴이 다음 커서가 되지 않는다');
  assert.ok(p.next.journal.cursor.includes(';i=4;'), '커서는 journalctl 의 __CURSOR 필드(MESSAGE 안 글자가 아님)');
  assert.ok(p.items.some((x) => x.src === 'journal' && x.msg === '##END'), '저널 줄 ‘##END’ 는 내용이다');
  assert.ok(p.items.some((x) => x.src === 'kernel' && x.msg === '##END'), '커널 줄 ‘##END’ 는 내용이다');
});

test('명령 조립 값 화이트리스트 — 위조한 상태는 명령에 들어가지 않는다 · 숫자는 선행 0 · 19자리 불가(반증 F13) · 구획 순서 = LOG_SECTIONS · _paths 는 테스트 전용', () => {
  const evil = { journal: { cursor: "s=1';touch /tmp/pwned;'" }, jsec: { cursor: '$(id)' }, kernel: { boot: '$(reboot)', last: '1;id' }, secure: { ino: '12;rm -rf /', off: '`id`' }, audit: { ino: '1', off: '$(id)' }, apps: { gpdb: { ino: '1 2', off: '3' } } };
  const cmd = C.logCommand(evil);
  for (const bad of ['pwned', 'reboot', ';id', 'rm -rf', '`id`', '$(id)', "'1 2'"]) assert.ok(!cmd.includes(bad), `명령에 ${bad} 가 없다`);
  assert.ok(cmd.includes('--since=-60min'), '커서가 화이트리스트를 못 지나면 처음 읽기');
  for (const v of ['0777', '0999', '00', '9999999999999999999', '1234567890123456789']) assert.equal(C.DIGITS_RE.test(v), false, `${v} 는 위치 값이 아니다(dash 산술이 8진수 · 넘침으로 읽는다)`);
  for (const v of ['0', '7', '123456789012345678']) assert.equal(C.DIGITS_RE.test(v), true, v);
  for (const v of ['01.5', '00', '1.', '.5']) assert.equal(C.SECS_RE.test(v), false, v);
  const c2 = C.logCommand({ secure: { ino: '0777', off: '0999' } });
  assert.ok(!c2.includes("'0777'") && !c2.includes("'0999'"), '선행 0 값은 명령에 들어가지 않는다(첫 읽기 꼴)');
  // JSEC = 보안 식별자 · 우선순위 info 이상(sshd 성공 · 실패는 info — 반증 F1) · 주 저널은 warning 이상
  assert.match(cmd, /journalctl --no-pager -o json [^\n]*-p info SYSLOG_IDENTIFIER=sshd SYSLOG_IDENTIFIER=sshd-session SYSLOG_IDENTIFIER=sudo /);
  assert.match(cmd, /journalctl --no-pager -o json [^\n]*-p warning _TRANSPORT=journal/);
  const order = [...cmd.matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, [...C.LOG_SECTIONS]);
  // 사용자 입력 경로 금지 — _paths 는 command.js 밖 src 어디에서도 넘기지 않는다
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('_paths')) hits.push(path.relative(src, p)); } };
  walk(src);
  assert.deepEqual(hits, ['bmusage/logs/command.js']);
  // 상한: lineCap 은 LINE_CAP_RANGE 로 자른다(설정 범위와 같은 상수 — perfRules LIMITS.logs.lineCap)
  assert.ok(C.logCommand({}, { lineCap: 1e9 }).includes(`cap=${C.LINE_CAP_RANGE[1]}`));
  assert.ok(C.logCommand({}, { lineCap: 'x' }).includes(`cap=${C.LINE_CAP_DEFAULT}`));
});

test('8b 반증 후속 — systemctl 한 번에 rsyslog · auditd(유닛 순서대로 한 줄씩) · systemctl 이 멈추면 시한 하나 뒤 둘 다 모름 · 시한 상수가 명령에 있다', (t) => {
  const SB = path.join(DIR, 'svcbin');
  fs.mkdirSync(SB, { recursive: true });
  const env = { PATH: `${SB}:${BIN}:${process.env.PATH}` };
  fs.writeFileSync(path.join(SB, 'systemctl'), '#!/bin/sh\n[ "$*" = "is-active rsyslog auditd" ] && { printf \'active\\ninactive\\n\'; exit 3; }\nexit 4\n', { mode: 0o755 });
  const a = P.parseLogOutput(run({}, { env }), { prev: {}, now: Date.now() });
  assert.equal(a.sources.secure.svc, 'active', 'rsyslog = 첫 줄'); assert.equal(a.sources.audit.svc, 'inactive', 'auditd = 둘째 줄');
  // D-Bus 가 멈춘 것처럼 — 시한(SVC_TIMEOUT_S) 하나 뒤 둘 다 모름(예전: 3초 시한 두 번)
  fs.writeFileSync(path.join(SB, 'systemctl'), '#!/bin/sh\nexec sleep 100\n', { mode: 0o755 });
  const t0 = Date.now();
  const b = P.parseLogOutput(run({}, { env }), { prev: {}, now: Date.now() });
  const ms = Date.now() - t0;
  assert.equal(b.sources.secure.svc ?? null, null); assert.equal(b.sources.audit.svc ?? null, null);
  assert.ok(ms < (C.SVC_TIMEOUT_S + 3) * 1000, `systemctl 시한 한 번(${ms}ms)`);
  assert.equal(b.sources.secure.status, 'ok', '활성 여부를 몰라도 파일 읽기는 그대로');
  const cmd = C.logCommand({}, {});
  assert.match(cmd, new RegExp(`timeout ${C.JOURNAL_TIMEOUT_S} journalctl`)); assert.match(cmd, new RegExp(`timeout ${C.DMESG_TIMEOUT_S} dmesg`));
  assert.match(cmd, new RegExp(`timeout ${C.ROT_FIND_TIMEOUT_S} find`)); assert.equal((cmd.match(/systemctl/g) || []).length, 1, 'systemctl 은 한 번');
});
