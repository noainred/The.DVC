/**
 * v2.923(리눅스 성능 4단계) — 진단 스냅샷(원격 명령 실행 경로). 보안 규약을 하나씩 고정한다(security-api.md v2.923):
 *   ① 상수 명령(입력 · 설정 · 이름 삽입 0) ② 읽기 전용 · sudo/su/pkexec 0 · 프로세스 인자 · 환경 0(소스 스윕) ③ 출력 상한(명령 · sshExec · 파서)
 *   ④ 권한: viewer 403 · 범위 밖 404 · 쓰기 범위 밖 403 · 사유 없음 400 ⑤ 서버당 동시 1건 409 ⑥ 법인당 24시간 상한 429 · 보관 DB 없으면 503(실행 안 함)
 *   ⑦ 7일 보관 prune ⑧ 인증 실패 → 주기 수집 가드 기록 · 성공 → 해제 · 호스트키 거부는 인증 실패가 아니다 ⑨ 감사 로그 ⑩ 엣지 대행 계약 · 정제 · 다른 서버 id 로 못 읽음.
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2923sn-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
process.env.COLLECTOR_TOKEN = 'tok-2923-test';
// viewer 에게도 tools 권한을 준다 — 그래야 ‘viewer 403’ 이 tools 권한이 아니라 실행 역할(operator 이상) 때문임을 가린다(변이 검증에서 잡은 빈틈).
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = path.join(import.meta.dirname, '../src');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const CMD = await import('../src/bmusage/snapshot/command.js');
const RUN = await import('../src/bmusage/snapshot/run.js');
const { EXEC_MAX_OUTPUT } = await import('../src/proxy/sshExec.js');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* 없으면 DB 의존 테스트 skip */ }

/* ── 가짜 의존(SSH · 보관 DB · 가드) ─────────────────────────────── */
const SAMPLE = [
  '##PSCPU', '  4321 postgres  51.0 123456789 postgres', '   12 root      0.8      0 khugepaged',
  '##PSMEM', '  4321 postgres  51.0 123456789 postgres',
  '##PIDS', '300', '##IO', 'readable=120', 'span=2.00', 'io 4321 4000000 800000 postgres',
  '##SS', 'Total: 1240', 'TCP:   1240 (estab 802, closed 100, orphaned 0, timewait 318)',
  '##DMESG', 'd:[Fri Nov  6 13:02:00 2026] nvme nvme1: I/O 1024 QID 7 timeout, completion polled 10.1.2.3', '##END', '',
].join('\n');
function fakeDb({ count = 0, available = true } = {}) {
  const rows = []; const calls = { prune: [], count: [] };
  return {
    calls, rows,
    db: async () => ({
      snapshotStoreAvailable: async () => available,
      snapshotCountSince: async (o) => { calls.count.push(o); return available ? count + rows.length : null; },
      snapshotPrune: async (o) => { calls.prune.push(o); return 0; },
      snapshotInsert: async (r) => { rows.push(r); return { ok: true }; },
    }),
  };
}
function fakeSsh({ stdout = SAMPLE, fail = null, gate = null } = {}) {
  const seen = [];
  return {
    seen,
    withSsh: async (creds, fn) => {
      seen.push({ creds });
      if (gate) await gate;
      if (fail) throw new Error(fail);
      return fn({ exec: async (cmd, ms) => { seen.at(-1).cmd = cmd; seen.at(-1).ms = ms; return { stdout, stderr: '', code: 0 }; } });
    },
    withDeadline: async (ms, fn) => fn(new AbortController().signal),
  };
}
const target = (o = {}) => ({ key: 'TAGA', name: 'bm-a', vcenterId: 'vcA', osHost: { host: '10.0.0.1', port: 22, username: 'mon', password: 'pw' }, ...o });
const settings = { snapshot: { dailyCorpMax: 3, topN: 10, dmesgLines: 50 } };

/* ① 상수 명령 */
test('① 명령은 상수 — 서버 이름 · 키 · 주소 · 사유 · 실행자 · 설정값이 무엇이든 SSH 에 가는 명령은 SNAPSHOT_COMMAND 그대로', async () => {
  assert.equal(typeof CMD.SNAPSHOT_COMMAND, 'string');
  const evil = '$(reboot); `rm -rf /` | nc x 1 && sudo -i';
  const variants = [
    { t: target(), reason: '디스크 포화 확인' },
    { t: target({ key: evil, name: evil, osHost: { host: '10.0.0.2', username: evil, password: evil } }), reason: evil },
    { t: target(), reason: '다른 사유', s: { snapshot: { dailyCorpMax: 3, topN: 3, dmesgLines: 10 } } },
  ];
  for (const v of variants) {
    const ssh = fakeSsh(); const D = fakeDb();
    const r = await RUN.runSnapshotLocal({ target: v.t, reason: v.reason, by: evil, settings: v.s || settings }, { ...ssh, db: D.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null });
    assert.equal(r.code, 'ok');
    assert.equal(ssh.seen[0].cmd, CMD.SNAPSHOT_COMMAND, '상수 명령');
    for (const s of ['reboot', 'rm -rf', 'nc x', 'sudo', v.reason]) assert.ok(!ssh.seen[0].cmd.includes(s), `명령에 ${s} 없음`);
  }
});

/* ② 읽기 전용 · sudo 없음 · 인자 없음(소스 스윕) */
test('② 소스 스윕 — 스냅샷 모듈 · 대행 라우트에 sudo · su - · pkexec · doas 없음 · 명령에 cmdline · environ · ps args · 파일 쓰기(> /dev/null 외) · tee 없음', () => {
  const files = [...fs.readdirSync(path.join(SRC, 'bmusage/snapshot')).map((f) => path.join(SRC, 'bmusage/snapshot', f))];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const re of [/\bsudo\b/, /\bsu\s+-/, /\bpkexec\b/, /\bdoas\b/]) assert.ok(!re.test(src), `${path.basename(f)} ${re}`);
  }
  const c = CMD.SNAPSHOT_COMMAND;
  for (const re of [/cmdline/, /environ/, /-o\s+[^ ]*args/, /\bargs=/, />>?\s*\/(?!dev\/null)/, /\btee\b/, /\bsudo\b/, /\brm\b/, /\bkill\b/, /\becho\s+[^']*>\s*\/proc/]) assert.ok(!re.test(c), `명령 ${re}`);
  assert.ok(/ps -e -o pid=,user=,pcpu=,rss=,comm=/.test(c), 'ps 는 comm(이름)만');
  assert.ok(c.includes('/proc/" best "/comm'), '이름은 /proc/<pid>/comm');
  // 실행 경로는 상수 하나만 넘긴다(run.js 의 exec 호출 인자 스윕)
  const runSrc = stripComments(fs.readFileSync(path.join(SRC, 'bmusage/snapshot/run.js'), 'utf8'));
  const execs = [...runSrc.matchAll(/exec\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(execs, ['SNAPSHOT_COMMAND']);
});

/* ③ 출력 상한 */
test('③ 출력 상한 — 명령 끝 head -c · 상한 < sshExec 상한 · 파서가 줄 수 · 길이 · 설정 상위 N 으로 자른다', () => {
  assert.ok(CMD.SNAPSHOT_COMMAND.endsWith(`| head -c ${CMD.SNAPSHOT_OUTPUT_MAX}`));
  assert.ok(CMD.SNAPSHOT_OUTPUT_MAX * 4 <= EXEC_MAX_OUTPUT, '넉넉히 작다');
  const caps = (CMD.SNAPSHOT_PS_MAX * 2 * 161) + (CMD.SNAPSHOT_IO_MAX + 2) * 121 + CMD.SNAPSHOT_SS_MAX * 201 + CMD.SNAPSHOT_DMESG_MAX * 303 + 1024;
  assert.ok(caps < CMD.SNAPSHOT_OUTPUT_MAX, `구획 상한 합 ${caps} < 전체 상한`);
  const huge = ['##PSCPU', ...Array.from({ length: 5000 }, (_, i) => ` ${i} root 1.0 100 p${i}`), '##DMESG', ...Array.from({ length: 5000 }, () => `d:${'x'.repeat(5000)}`), '##END'].join('\n');
  const r = CMD.parseSnapshot(huge, { topN: 7, dmesgLines: 12 });
  assert.equal(r.cpuTop.length, 7);
  assert.equal(r.dmesg.length, 12);
  assert.ok(r.dmesg.every((l) => l.length <= 300));
});

test('③ 파서 — 권한 부족(/proc/pid/io 0 · 일부) · dmesg 권한 실패 · 잘림(END 없음) · ss 요약 · I/O 초당 값', () => {
  const r = CMD.parseSnapshot(SAMPLE);
  assert.equal(r.states.io, 'ok'.replace('ok', r.ioReadable < r.pids * 0.9 ? 'partial' : 'ok'));
  assert.equal(r.states.io, 'partial', '300 중 120 만 읽힘 — 일부 권한 부족');
  assert.deepEqual(r.ioTop[0], { pid: 4321, name: 'postgres', readBps: 2_000_000, writeBps: 400_000 });
  assert.deepEqual(r.ssTcp, { total: 1240, estab: 802, timewait: 318, orphaned: 0 });
  assert.equal(r.cpuTop[0].name, 'postgres');
  assert.equal(CMD.parseSnapshot(SAMPLE.replace('readable=120', 'readable=0')).states.io, 'perm');
  const dm = CMD.parseSnapshot(SAMPLE.replace(/##DMESG\n[^\n]+\n/, '##DMESG\nd:dmesg: read kernel buffer failed: Operation not permitted\n'));
  assert.equal(dm.states.dmesg, 'perm'); assert.deepEqual(dm.dmesg, []);
  // 반증 R5: 커널 메시지 안의 ‘Permission denied’ · ‘Operation not permitted’ 는 실제 오류다 — dmesg 자신의 오류 줄(dmesg:)만 권한 판정.
  const real = CMD.parseSnapshot(SAMPLE.replace(/##DMESG\n[^\n]+\n/, '##DMESG\nd:[Sat Nov  7 01:00:00 2026] XFS (dm-3): writeback error on inode 1234: Permission denied\nd:[Sat Nov  7 01:00:01 2026] nfs: server nas01 Operation not permitted\n'));
  assert.equal(real.states.dmesg, 'ok'); assert.equal(real.dmesg.length, 2); assert.equal(real.dmesgTotal, 2);
  const other = CMD.parseSnapshot(SAMPLE.replace(/##DMESG\n[^\n]+\n/, "##DMESG\nd:dmesg: unrecognized option '--level=err,warn'\n"));
  assert.equal(other.states.dmesg, 'missing', 'dmesg 자체 오류(권한 아님) — 커널 로그로 보이지 않고 받지 못함'); assert.deepEqual(other.dmesg, []);
  // 반증 R6: 표지 재개방 · trim · 접두 없는 줄 — 커널 로그 이어진 줄이 ‘##IO’ 여도 앞 구획을 덮지 않는다.
  const forged = CMD.parseSnapshot(SAMPLE.replace('##END', '  ##IO\n##IO\nreadable=99999\nd:##END\n##PSCPU\n 1 root 99.0 1 evil\n##END'));
  assert.equal(forged.ioReadable, 120, 'IO 구획을 다시 열지 않는다'); assert.equal(forged.states.io, 'partial');
  assert.equal(forged.cpuTop.length, 2, 'PSCPU 를 다시 열지 않는다'); assert.equal(forged.truncated, false);
  assert.equal(CMD.parseSnapshot(SAMPLE.replace('##END', 'd:##END')).truncated, true, '접두 붙은 ##END 는 표지가 아니다');
  const indented = CMD.parseSnapshot(SAMPLE.replace('io 4321', '  ##SS\nio 4321'));
  assert.equal(indented.ioTop.length, 1, '들여쓴 앞쪽 표지(  ##SS)는 표지가 아니다 — trim 하지 않는다'); assert.equal(indented.ssTcp?.total, 1240);
  const cut = CMD.parseSnapshot(SAMPLE.split('##SS')[0]);
  assert.equal(cut.truncated, true); assert.equal(cut.states.ss, 'missing'); assert.equal(cut.states.dmesg, 'missing');
});

/* ⑤ 동시 1건 · ⑥ 상한 · ⑦ 보관 */
test('⑤ 서버당 동시 1건 — 진행 중인 같은 서버는 busy(SSH 를 열지 않는다) · 다른 서버는 돈다 · 끝나면 다시 된다', async () => {
  RUN._resetSnapshotForTest();
  let release; const gate = new Promise((r) => { release = r; });
  const ssh = fakeSsh({ gate }); const D = fakeDb();
  const deps = { ...ssh, db: D.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null };
  const p1 = RUN.runSnapshotLocal({ target: target(), reason: '첫 번째', settings }, deps);
  const p2 = await RUN.runSnapshotLocal({ target: target(), reason: '두 번째', settings }, deps);
  assert.equal(p2.code, 'busy');
  const other = RUN.runSnapshotLocal({ target: target({ key: 'TAGB' }), reason: '다른 서버', settings }, deps);
  release();
  assert.equal((await p1).code, 'ok'); assert.equal((await other).code, 'ok');
  assert.equal(ssh.seen.length, 2, 'busy 는 SSH 를 열지 않았다');
  assert.equal((await RUN.runSnapshotLocal({ target: target(), reason: '세 번째', settings }, deps)).code, 'ok');
});

test('⑥ 법인당 24시간 상한 — 상한이면 daily-cap(SSH 없음) · 세는 창은 24시간 · 보관 DB 를 못 열면 store-unavailable(실행 안 함) · ⑦ 실행 때 7일 밖 정리', async () => {
  RUN._resetSnapshotForTest();
  const ssh = fakeSsh();
  const full = fakeDb({ count: 3 });
  const r = await RUN.runSnapshotLocal({ target: target(), reason: '상한 확인', settings, now: NOW }, { ...ssh, db: full.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null });
  assert.equal(r.code, 'daily-cap'); assert.equal(r.max, 3); assert.equal(ssh.seen.length, 0);
  assert.equal(full.calls.count[0].since, NOW - 86_400_000); assert.equal(full.calls.count[0].vcenterId, 'vcA');
  const off = fakeDb({ available: false });
  const r2 = await RUN.runSnapshotLocal({ target: target(), reason: 'DB 없음', settings }, { ...ssh, db: off.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null });
  assert.equal(r2.code, 'store-unavailable'); assert.equal(ssh.seen.length, 0);
  // 보관 DB 를 못 연다고 말하면 실행 수를 세어 줘도 실행하지 않는다(두 겹 — 첫 겹만 지워도 잡힌다)
  const half = fakeDb({ available: false }); const halfDb = await half.db();
  const r3 = await RUN.runSnapshotLocal({ target: target(), reason: 'DB 반쪽', settings }, { ...ssh, db: async () => ({ ...halfDb, snapshotCountSince: async () => 0 }), authOutcome: async () => null, authStop: async () => null, idrac: async () => null });
  assert.equal(r3.code, 'store-unavailable'); assert.equal(ssh.seen.length, 0);
  const okDb = fakeDb({ count: 0 });
  await RUN.runSnapshotLocal({ target: target(), reason: '정리 확인', settings, now: NOW }, { ...ssh, db: okDb.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null });
  assert.equal(okDb.calls.prune[0].before, NOW - 7 * 86_400_000);
  assert.equal(okDb.rows[0].reason, '정리 확인'); assert.equal(okDb.rows[0].vcenterId, 'vcA');
  assert.ok(!JSON.stringify(okDb.rows[0]).includes('"pw"'), '보관 행에 비밀번호 없음');
});

test('사유 · 경로 — 사유 2자 미만/제어 문자만 → bad-reason · OS 경로 없음 → no-os-path · 둘 다 SSH 없음', async () => {
  const ssh = fakeSsh(); const D = fakeDb();
  const deps = { ...ssh, db: D.db, authOutcome: async () => null, authStop: async () => null, idrac: async () => null };
  assert.equal((await RUN.runSnapshotLocal({ target: target(), reason: ' ', settings }, deps)).code, 'bad-reason');
  assert.equal((await RUN.runSnapshotLocal({ target: target(), reason: 'a', settings }, deps)).code, 'bad-reason', '1자 사유는 사유가 아니다');
  assert.equal(RUN.cleanReason('ab'), 'ab');
  assert.equal((await RUN.runSnapshotLocal({ target: target(), reason: '\u0001\u0002', settings }, deps)).code, 'bad-reason');
  assert.equal((await RUN.runSnapshotLocal({ target: target({ osHost: null }), reason: '경로 없음', settings }, deps)).code, 'no-os-path');
  assert.equal(ssh.seen.length, 0);
  assert.equal(RUN.cleanReason('a\nb\tc  d'), 'a b c d');
});

/* ⑧ 인증 가드 */
test('⑧ 인증 실패 → code auth + 주기 수집 가드에 기록(실제 poller 가드) · 성공 → 해제 · 호스트키 거부는 auth 가 아니다(가드 기록 없음)', async () => {
  RUN._resetSnapshotForTest();
  const poller = await import('../src/bmusage/poller.js');
  const tg = target({ key: 'TAG-AUTH' });
  const D = fakeDb();
  const settings = { snapshot: { dailyCorpMax: 20, topN: 10, dmesgLines: 50 } };
  const real = { db: D.db, authOutcome: async (t, o) => poller.recordOsAuthOutcome(t, o), authStop: async (t) => poller.osAuthStopFor(t), idrac: async () => null };
  const bad = await RUN.runSnapshotLocal({ target: tg, reason: '인증 실패 확인', settings }, { ...fakeSsh({ fail: 'All configured authentication methods failed' }), ...real });
  assert.equal(bad.code, 'auth');
  const st = poller.osAuthStopFor(tg);
  assert.ok(st && st.attempts === 1, '주기 수집이 멈춘다(같은 계정으로 다시 로그인하지 않게)');
  const again = await RUN.runSnapshotLocal({ target: tg, reason: '수동은 막지 않는다', settings }, { ...fakeSsh(), ...real });
  assert.equal(again.code, 'ok', '수동 실행은 막지 않는다(규칙 3)');
  assert.ok(again.result.authStoppedBefore, '정지 상태였다는 사실을 결과가 말한다');
  assert.equal(poller.osAuthStopFor(tg), null, '성공 → 해제');
  const hk = await RUN.runSnapshotLocal({ target: tg, reason: '호스트키', settings }, { ...fakeSsh({ fail: 'SSH 호스트키 확인 거부 — … 403 … [SSH_HOSTKEY_UNTRUSTED]' }), ...real });
  assert.equal(hk.code, 'host-key');
  assert.equal(poller.osAuthStopFor(tg), null, '호스트키 거부는 인증 정지가 아니다');
  const to = await RUN.runSnapshotLocal({ target: tg, reason: '시한', settings }, { ...fakeSsh({ fail: '진단 스냅샷 시한 초과(50초)' }), ...real });
  assert.equal(to.code, 'timeout');
});

test('시한 산수 — 연결 + 명령 시한 < 세션 시한(withDeadline 이 세션을 끊는다) < 중앙 대행 시한', async () => {
  const E = await import('../src/central/bmUsageEdgePull.js');
  assert.ok(RUN.SNAPSHOT_READY_MS + RUN.SNAPSHOT_CMD_MS < RUN.SNAPSHOT_DEADLINE_MS);
  assert.ok(RUN.SNAPSHOT_DEADLINE_MS < E.SNAPSHOT_PULL_TIMEOUT_MS);
  assert.ok(CMD.SNAPSHOT_IO_GAP_S * 1000 < RUN.SNAPSHOT_CMD_MS);
});

/* ⑩ 엣지 대행 정제 */
test('⑩ 중앙 정제 — 엣지 스냅샷 본문은 아는 필드만 · 상한 · enum 밖 code/상태는 막는다', async () => {
  const E = await import('../src/central/bmUsageEdgePull.js');
  const b = E.sanitizeSnapshotBody({ ok: true, code: 'ok', id: 'x'.repeat(100), evil: 1, result: { cpuTop: Array.from({ length: 50 }, () => ({ pid: '1', name: 'p', extra: 1 })), dmesg: Array.from({ length: 500 }, () => 'y'.repeat(900)), states: { io: 'weird', cpu: 'ok' }, password: 'x' } });
  assert.equal(b.evil, undefined); assert.equal(b.id.length, 40);
  assert.equal(b.result.cpuTop.length, 30); assert.equal(b.result.cpuTop[0].pid, 1); assert.equal(b.result.cpuTop[0].extra, undefined);
  assert.equal(b.result.dmesg.length, 200); assert.ok(b.result.dmesg.every((l) => l.length <= 300));
  assert.equal(b.result.states.io, 'missing'); assert.equal(b.result.password, undefined);
  assert.equal(E.sanitizeSnapshotBody({ ok: false, code: 'rm -rf' }).code, 'ssh-error');
});

/* ── 반증 R2 · R3 · R4 — 실제 run.js + 실제 db.js(SSH 만 가짜) ───────────────────────────── */
test('⑥ 법인 상한 경쟁(반증 R2 재현) — 상한 2 · 같은 법인 서로 다른 서버 6대 동시 → ok 2 · daily-cap 4 · 보관 행 2 · 다른 법인은 영향 없음', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  RUN._resetSnapshotForTest();
  const DB = await import('../src/bmusage/db.js');
  let release; const gate = new Promise((r) => { release = r; });
  const ssh = fakeSsh({ gate });
  const deps = { ...ssh, authOutcome: async () => null, authStop: async () => null, idrac: async () => null };
  const st2 = { snapshot: { dailyCorpMax: 2, topN: 10, dmesgLines: 50 } };
  const ps = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((k) => RUN.runSnapshotLocal({ target: target({ key: k, vcenterId: 'vcRace' }), reason: '동시 실행', settings: st2 }, deps));
  const otherCorp = RUN.runSnapshotLocal({ target: target({ key: 'Q1', vcenterId: 'vcRaceB' }), reason: '다른 법인', settings: st2 }, deps);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(RUN.snapshotCorpRunning('vcRace'), 2, '실행 중 예약 2건');
  release();
  const codes = (await Promise.all(ps)).map((r) => r.code).sort();
  assert.deepEqual(codes, ['daily-cap', 'daily-cap', 'daily-cap', 'daily-cap', 'ok', 'ok']);
  assert.equal((await otherCorp).code, 'ok');
  assert.equal(await DB.snapshotCountSince({ vcenterId: 'vcRace', since: Date.now() - 86_400_000 }), 2, '보관 행 2');
  assert.equal(RUN.snapshotCorpRunning('vcRace'), 0, '끝나면 예약 해제');
  assert.equal((await RUN.runSnapshotLocal({ target: target({ key: 'R7', vcenterId: 'vcRace' }), reason: '끝난 뒤', settings: st2 }, deps)).code, 'daily-cap', '끝난 뒤에는 보관 행으로 센다');
  assert.equal(ssh.seen.length, 3, 'SSH 는 예약된 3건만(상한 2 + 다른 법인 1)');
});

test('⑦ 7일 보관(반증 R3) — 실행이 없어도 7일 넘은 행은 목록 · 조회에 나오지 않고 폴러 주기 정리가 지운다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const DB = await import('../src/bmusage/db.js');
  const { config } = await import('../src/config.js');
  const old = { id: '11111111-1111-4111-8111-111111111111', agent: config.agent?.name || '', key: 'OLDK', vcenterId: 'vcOld', at: Date.now() - 30 * 86_400_000, by: 'x', reason: 'old', ok: true, code: 'ok', ms: 1, result: { dmesg: ['old kernel line'] } };
  const fresh = { ...old, id: '22222222-2222-4222-8222-222222222222', at: Date.now() - 86_400_000 };
  await DB.snapshotInsert(old); await DB.snapshotInsert(fresh);
  const l = await RUN.listSnapshotsLocal({ key: 'OLDK' });
  assert.deepEqual(l.snapshots.map((x) => x.id), [fresh.id], '30일 전 행은 목록에 없다');
  assert.equal((await RUN.getSnapshotLocal({ key: 'OLDK', id: old.id })).ok, false, '조회도 not-found');
  assert.equal((await RUN.getSnapshotLocal({ key: 'OLDK', id: fresh.id })).ok, true);
  const poller = await import('../src/bmusage/poller.js');
  const r = await poller.pruneTick({ every: 1 });
  assert.ok(r.snapshotsPruned >= 1, JSON.stringify(r));
  assert.equal(await DB.snapshotGet(old.id), null, '주기 정리가 지웠다');
  assert.ok(await DB.snapshotGet(fresh.id), '7일 안 행은 남는다');
});

test('보관 상한(반증 R4) — 설정 상한(topN 30 · dmesgLines 200 · 긴 커널 줄)에서도 결과를 통째로 버리지 않는다 · 오래된 커널 줄부터 덜고 밝힌다 · 즉시 응답 = 보관본', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  RUN._resetSnapshotForTest();
  const ps = (i) => `  ${1000 + i} someuser  1.0 123456 proc-name-${i}`;
  const longDm = ['##PSCPU', ...Array.from({ length: 30 }, (_, i) => ps(i)), '##PSMEM', ...Array.from({ length: 30 }, (_, i) => ps(i)), '##PIDS', '300', '##IO', 'readable=300', 'span=2.00',
    '##SS', 'TCP:   1 (estab 1, closed 0, orphaned 0, timewait 0)', '##DMESG', ...Array.from({ length: 200 }, (_, i) => `d:[Sat Nov  7 10:00:${String(i % 60).padStart(2, '0')} 2026] #${i} ${'x'.repeat(300)}`), '##END', ''].join('\n');
  const parsed = CMD.parseSnapshot(longDm, { topN: 30, dmesgLines: 200 });
  assert.ok(JSON.stringify(parsed).length > CMD.SNAPSHOT_RESULT_MAX, '재현 조건 — 설정 상한 안에서 64KB 를 넘는다');
  const idrac = { events: Array.from({ length: 5 }, (_, i) => ({ severity: 'Warning', at: '2026-11-07T00:00:00Z', message: 'm'.repeat(200) + i })), temps: null, cpuPct: null, powerW: null };
  const rc = await RUN.runSnapshotLocal({ target: target({ key: 'BIG', vcenterId: 'vcBig' }), reason: '긴 dmesg', settings: { snapshot: { dailyCorpMax: 20, topN: 30, dmesgLines: 200 } } },
    { ...fakeSsh({ stdout: longDm }), authOutcome: async () => null, authStop: async () => null, idrac: async () => idrac });
  assert.equal(rc.code, 'ok');
  assert.ok(JSON.stringify(rc.result).length <= CMD.SNAPSHOT_RESULT_MAX);
  assert.deepEqual(rc.result.trimmed, ['dmesg']); assert.ok(rc.result.dmesgDropped > 0);
  assert.match(rc.result.dmesg.at(-1), /#199 /, '최근 줄은 남는다'); assert.equal(rc.result.cpuTop.length, 30);
  const back = await RUN.getSnapshotLocal({ key: 'BIG', id: rc.id });
  assert.equal(back.snapshot.result.truncated, false, '보관본이 {truncated} 로 바뀌지 않는다');
  assert.deepEqual(back.snapshot.result, rc.result, '즉시 응답 = 보관본(다시 열어도 같은 칸)');
  // 중앙 정제도 덜어 낸 사실을 보존한다(아는 칸 이름만).
  const { sanitizeSnapshotResult } = await import('../src/central/bmUsageEdgePull.js');
  const sr = sanitizeSnapshotResult({ ...rc.result, trimmed: ['dmesg', 'evil'] });
  assert.deepEqual(sr.trimmed, ['dmesg']); assert.equal(sr.dmesgDropped, rc.result.dmesgDropped);
  // 산수 — 명령 상한 끝까지 찬 최악의 결과(모든 칸 최대 폭)도 상한 안으로 들어온다.
  const worst = { ...parsed, ss: Array.from({ length: 20 }, () => 's'.repeat(200)), idrac, error: 'e'.repeat(300) };
  assert.ok(JSON.stringify(CMD.fitSnapshotResult(worst)).length <= CMD.SNAPSHOT_RESULT_MAX);
});

test('사유 정제(반증) — 양방향 제어(U+202A~202E · U+2066~2069) · C1 제어 · 폭 없는 문자를 뺀다', () => {
  assert.equal(RUN.cleanReason('디스크‮ 확인'), '디스크 확인');
  assert.equal(RUN.cleanReason('a\u0085b⁦c​d﻿e'), 'a b c d e');
  assert.equal(RUN.cleanReason('‮⁩'), '', '제어 문자만이면 사유 없음');
});

test('실제 셸 실행(dash · bash) — 커널 로그 접두(d:)가 벗겨지고 표지 · 상태가 온다(이 개발 컨테이너)', async (t) => {
  const { execFileSync } = await import('node:child_process');
  for (const sh of ['/bin/sh', '/bin/bash']) {
    if (!fs.existsSync(sh)) continue;
    let out = '';
    try { out = execFileSync(sh, ['-c', CMD.SNAPSHOT_COMMAND], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 << 20 }); } catch (e) { return t.skip(`셸 실행 불가: ${e.message}`); }
    const r = CMD.parseSnapshot(out, { topN: 5, dmesgLines: 5 });
    assert.equal(r.truncated, false, sh); assert.equal(r.states.cpu, 'ok', sh);
    assert.ok(['ok', 'perm', 'absent', 'missing'].includes(r.states.dmesg), `${sh} ${r.states.dmesg}`);
    assert.ok(!r.dmesg.some((l) => l.startsWith('d:')), '접두는 벗겨진다');
    const raw = out.split('##DMESG\n')[1].split('\n##END')[0].split('\n').filter(Boolean);
    assert.ok(raw.every((l) => l.startsWith('d:')), 'DMESG 줄은 전부 d: 접두(표지 모양 줄이 생길 수 없다)');
    assert.equal(r.dmesgTotal + (r.states.dmesg === 'perm' || r.states.dmesg === 'missing' ? raw.length : 0), raw.length, '접두 줄을 모두 읽었다');
  }
});

/* ④ ⑤ ⑥ ⑨ 실제 라우터 · ⑩ 엣지 collector 라우트 */
test('④⑥⑨ 실제 api 라우터 — viewer 403 · 범위 밖 404 · 조회 무제한+쓰기 제한 403 · 사유 없음 400 · 실행(연결 거부 → 보관 · 200 ok:false) · 하루 상한 429 · 감사 · 목록 by 는 관리자만 · ⑩ 엣지 대행 라우트', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b', name: 'bm-b', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false, snapshot: { dailyCorpMax: 1 } }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a', name: 'bm-a', serviceTag: 'TAGA', vcenterId: 'vcA' },
    { serverId: 's-b', name: 'bm-b', serviceTag: 'TAGB', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  const settingsMod = await import('../src/bmusage/settings.js');
  settingsMod._resetForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { collectorRouter } = await import('../src/routes/collector.js');
  const audit = await import('../src/audit.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
  };
  const app = express();
  app.use('/api/collector', collectorRouter);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (u, key, body) => fetch(`${base}/api/tools/bm-usage/perf/${key}/snapshot`, { method: 'POST', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('viewer', 'TAGA', { reason: '보기 전용' })).status, 403, 'viewer 403(operator 이상)');
  assert.equal((await post('opA', 'TAGB', { reason: '다른 법인' })).status, 404, '범위 밖 404(존재 은닉)');
  assert.equal((await post('rw', 'TAGB', { reason: '쓰기 밖' })).status, 403, '조회 무제한 + 쓰기 vcA 만 → vcB 403');
  assert.equal((await post('opA', 'TAGA', {})).status, 400, '사유 없음 400');
  assert.equal((await post('opA', 'TAGB', {})).status, 400, '사유 검사가 먼저 — 범위 밖 키도 사유가 없으면 400(존재를 흘리지 않는다)');
  const vl = await fetch(`${base}/api/tools/bm-usage/perf/TAGA/snapshots`, { headers: { 'x-u': 'viewer' } });
  assert.equal(vl.status, 200, 'viewer(tools 있음)는 보관분을 본다 — 실행만 막힌다');
  assert.equal((await post('opA', 'NOPE', { reason: '없는 서버' })).status, 404);
  const r1 = await post('opA', 'TAGA', { reason: '디스크 포화 원인 확인' });
  const b1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(b1)); assert.equal(b1.ok, false); assert.equal(b1.code, 'ssh-error', '연결 거부 — 시도는 보관된다');
  assert.ok(b1.id, '보관 id');
  const r2 = await post('opA', 'TAGA', { reason: '한 번 더' });
  assert.equal(r2.status, 429, '법인당 24시간 상한(설정 1)');
  assert.equal((await r2.json()).code, 'daily-cap');
  const acts = audit.auditEntriesWithAction('bm-usage.snapshot');
  assert.ok(acts.length >= 2, `감사 로그 ${acts.length}`);
  assert.ok(acts.some((a) => /디스크 포화 원인 확인/.test(a.detail || '') && a.user === 'opa'));
  const la = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGA/snapshots`, { headers: { 'x-u': 'adm' } })).json();
  assert.equal(la.snapshots.length, 1); assert.equal(la.snapshots[0].by, 'opa');
  const lo = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGA/snapshots`, { headers: { 'x-u': 'opA' } })).json();
  assert.equal(lo.snapshots[0].by, undefined, '실행자는 관리자만');
  // 반증 W4: 목록에 writable — 쓰기 범위 밖이면 화면이 실행 칸을 잠근다(서버도 403).
  assert.equal(lo.writable, true);
  const wl = await (await fetch(`${base}/api/tools/bm-usage/perf/TAGB/snapshots`, { headers: { 'x-u': 'rw' } })).json();
  assert.equal(wl.writable, false, '조회 무제한 + 쓰기 vcA 만 → vcB 서버는 실행 칸 잠금');
  const one = await fetch(`${base}/api/tools/bm-usage/perf/TAGA/snapshots/${b1.id}`, { headers: { 'x-u': 'opA' } });
  assert.equal(one.status, 200); assert.equal((await one.json()).snapshot.code, 'ssh-error');
  assert.equal((await fetch(`${base}/api/tools/bm-usage/perf/TAGB/snapshots/${b1.id}`, { headers: { 'x-u': 'adm' } })).status, 404, '다른 서버 키로는 그 id 를 못 읽는다');
  assert.equal((await fetch(`${base}/api/tools/bm-usage/perf/TAGB/snapshots`, { headers: { 'x-u': 'opA' } })).status, 404, '범위 밖 목록 404');
  // ⑩ 엣지 collector 대행 — 토큰 · 대상 밖 not-found · 사유 · 상한(같은 보관 표) · 다른 키 id 거부
  const col = (p, init = {}) => fetch(`${base}/api/collector${p}`, { ...init, headers: { 'X-Collector-Token': 'tok-2923-test', 'Content-Type': 'application/json', ...(init.headers || {}) } });
  assert.equal((await fetch(`${base}/api/collector/bm-usage/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, '토큰 없음');
  assert.equal((await (await col('/bm-usage/snapshot', { method: 'POST', body: JSON.stringify({ key: 'NOPE', reason: '대행' }) })).json()).code, 'not-found');
  assert.equal((await (await col('/bm-usage/snapshot', { method: 'POST', body: JSON.stringify({ key: 'TAGB', reason: '' }) })).json()).code, 'bad-reason');
  const e1 = await (await col('/bm-usage/snapshot', { method: 'POST', body: JSON.stringify({ key: 'TAGB', reason: '중앙 대행', by: 'adm;rm' }) })).json();
  assert.equal(e1.code, 'ssh-error');
  const e2 = await (await col('/bm-usage/snapshot', { method: 'POST', body: JSON.stringify({ key: 'TAGB', reason: '중앙 대행 2' }) })).json();
  assert.equal(e2.code, 'daily-cap', '엣지도 같은 법인 상한');
  const el = await (await col('/bm-usage/snapshots?key=TAGB')).json();
  assert.equal(el.snapshots.length, 1); assert.equal(el.snapshots[0].by, 'central-portal:admrm', '실행자 표기는 글자 제한');
  assert.equal((await (await col(`/bm-usage/snapshot?key=TAGA&id=${e1.id}`)).json()).code, 'not-found', '다른 서버 키로 id 거부');
  assert.ok(audit.auditEntriesWithAction('중앙 대행 진단 스냅샷').length >= 1, '엣지 감사');
  poller._setFleetForTest(null);
});
