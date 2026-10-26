/**
 * test/scanResume2737.test.js — 업그레이드·재시작으로 끊긴 스캔의 기록·자동 재개(v2.737).
 *
 * 사용자 신고(2026-10-15): "프로그램이 업그레이드 되면 scan 하던게 중단되는 버그 … 자동으로 재시작".
 * 순수 헬퍼만 고정하면 v2.566(진입 함수가 첫 줄에서 죽었는데 테스트는 통과) 같은 결함을 놓친다 — 그래서 여기서는
 *   ① 실행 중 스캔 기록(util/scanJournal)을 실제 파일로 '재기동' 시켜 보고(_reloadForTest)
 *   ② 아이실론 분리 실행(isidu/detach)을 **실제 셸**(sh + PATH 의 가짜 du)로 돌려 세션이 끊긴 뒤 같은 작업에 다시 붙는지,
 *      시한에 걸리면 장비 쪽 du 를 실제로 멈추는지 본다
 *   ③ iDRAC 대역 재개가 '남은 대역만' 다시 도는지 · IP 스캔 재개가 스캔을 실제로 시작하는지
 *   ④ 자동 업그레이드가 실행 중 스캔이 끝나기를 기다리는지(상한·0 = 기다리지 않음)
 * 실제 포탈 프로세스를 SIGTERM 으로 끊고 다시 띄우는 통합 시험은 scanRestart2737.test.js 다.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scanres2737-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.IPAM_SCAN_WORKER = '0';   // 인라인 스캔(자식 프로세스 없이 빠르게)
delete process.env.SCAN_RESUME;
delete process.env.UPGRADE_SCAN_DEFER_MAX_MS;

const J = await import('../src/util/scanJournal.js');
const D = await import('../src/isidu/detach.js');
const FILE = path.join(DIR, 'scan-journal.json');
const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const waitFor = async (fn, ms = 15_000, step = 50) => {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('시간 초과'); await new Promise((r) => setTimeout(r, step)); }
};

/* 가짜 du(실제 셸) — 마지막 인자가 경로. 호출마다 카운트 파일에 한 줄 · 선택적으로 잠들고 · 끝났다는 표지를 남긴다. */
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'fakedu2737-'));
fs.writeFileSync(path.join(FAKE, 'du'), [
  '#!/bin/sh',
  'for a; do last="$a"; done',
  '[ -n "$FAKE_DU_COUNT" ] && echo run >> "$FAKE_DU_COUNT"',
  '[ -n "$FAKE_DU_SLEEP" ] && sleep "$FAKE_DU_SLEEP"',
  '[ -n "$FAKE_DU_MARK" ] && touch "$FAKE_DU_MARK"',
  'printf \'5.0G\\t%s/alpha\\n3.0G\\t%s/beta\\n8.0G\\t%s\\n\' "$last" "$last" "$last"',
  'echo "du: $last/x: Permission denied" >&2',
  'exit 1',
].join('\n') + '\n', { mode: 0o755 });

/** withSsh 의 api 와 같은 모양 — 명령을 이 컨테이너의 sh 로 실제로 실행한다(가짜 du 가 PATH 맨 앞). */
function localApi(env = {}) {
  const calls = [];
  return {
    calls,
    exec(cmd, timeoutMs = 30_000) {
      calls.push(cmd);
      return new Promise((resolve) => {
        execFile('sh', ['-c', cmd], { env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, ...env }, timeout: timeoutMs, maxBuffer: 4 << 20 },
          (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }));
      });
    },
  };
}
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const jobDir = `${D.DETACH_BASE}-${uid}`;
const jobFiles = (id) => (fs.existsSync(jobDir) ? fs.readdirSync(jobDir).filter((f) => f.startsWith(`${id}.`)) : []);
const killed = [];
after(async () => {
  for (const id of killed) { try { await localApi().exec(D.killCommand(id)); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* */ }
});

const T = { id: 'tgt-det', host: '127.0.0.1', path: '/ifs/data/users', sizeMode: 'h' };

/* ═══════════════════════════ ① 실행 중 스캔 기록 ═══════════════════════════ */

test('① 시작은 동기로 파일에 남고 · 끝나면 지운다 · 재기동하면 끝나지 못한 것이 "재시작으로 중단됨" 이 된다', () => {
  J._resetForTest();
  J.scanStarted('test-a', 'k1', { label: '대상 1', trigger: 'manual', meta: { jobId: 'j-1', password: undefined } });
  assert.equal(readFile().active['test-a:k1'].label, '대상 1', '시작 즉시 파일에 남는다(곧바로 재시작이 와도)');
  assert.equal(J.runningScans().length, 1);
  J.scanStarted('test-a', 'k2', { label: '대상 2' });
  J.scanFinished('test-a', 'k2');
  assert.equal(readFile().active['test-a:k2'], undefined, '끝난 스캔은 지운다');

  J._reloadForTest(); // 새 기동 흉내 — 파일의 active 를 이어 받는다
  assert.equal(J.runningScans().length, 0, '새 프로세스는 아무것도 돌리고 있지 않다');
  assert.equal(J.isResumePending('test-a', 'k1'), true);
  const p = J.pendingResumeOf('test-a', 'k1');
  assert.equal(p.meta.jobId, 'j-1', '식별자(원격 작업 id)는 이어진다');
  assert.equal(p.state, 'pending');
  assert.ok(p.detectedAt > 0);
  assert.equal(readFile().interrupted.length, 1, '발견한 사실을 곧바로 파일에도 남긴다');
  // 비밀을 적지 않는다(meta 는 식별자만 — 호출부가 비밀을 넘겨도 JSON 왕복에서 undefined 는 빠진다)
  assert.equal(JSON.stringify(readFile()).includes('password'), false);
});

test('① 재개 — started 는 resumed 로 남고 · 재개 상한(2회) · 48시간 지난 것 · 재개 함수가 없는 종류 · busy 는 5분 뒤 다시', async () => {
  J._resetForTest();
  const seen = [];
  J.registerScanResumer('test-b', async (e) => {
    seen.push(e.key);
    // 기능은 다시 시작할 때 scanStarted(resumeOf) 를 부른다 — 그것이 대기 항목을 'resumed' 로 옮긴다.
    J.scanStarted('test-b', e.key, { label: e.label, trigger: 'resume', resumeOf: e });
    return { outcome: 'started', note: '남은 대역 2개를 다시 스캔합니다' };
  });
  J.scanStarted('test-b', 'ok', { label: '정상' });
  J.scanStarted('test-b', 'lim', { label: '상한' });
  J.scanStarted('test-z', 'nobody', { label: '재개 함수 없음' });
  const doc = readFile();
  doc.active['test-b:lim'].resumes = 2;                       // 이미 두 번 재개된 사슬
  doc.active['test-b:old'] = { kind: 'test-b', key: 'old', label: '오래됨', since: Date.now() - 49 * 3_600_000, resumes: 0, meta: {} };
  fs.writeFileSync(FILE, JSON.stringify(doc));
  J._reloadForTest();
  assert.equal(J.journalFor('test-b').interrupted.length, 3);

  await J.processScanResumes();
  assert.deepEqual(seen, ['ok'], '상한·만료 항목은 재개 함수를 부르지 않는다');
  const hist = J.scanJournalStatus().recent;
  const by = (k) => hist.find((h) => h.key === k);
  assert.equal(by('ok').outcome, 'resumed');
  assert.equal(by('ok').note, '남은 대역 2개를 다시 스캔합니다', '기능이 준 설명을 이력에 남긴다');
  assert.equal(by('lim').outcome, 'limit');
  assert.equal(by('old').outcome, 'expired');
  assert.equal(by('nobody').outcome, 'no-resumer');
  assert.equal(J.runningScans()[0].resumes, 1, '재개한 스캔은 재개 횟수를 잇는다');

  // 재개한 스캔이 또 재시작에 걸리면 — 횟수가 이어져 두 번째까지는 다시, 세 번째는 상한
  J._reloadForTest();
  assert.equal(J.pendingResumeOf('test-b', 'ok').resumes, 1);

  // busy — 5분 뒤 다시, 12번 넘게 바쁘면 그만둔다
  J._resetForTest();
  let calls = 0;
  J.registerScanResumer('test-c', async () => { calls++; return { outcome: 'busy', note: '다른 스캔 중' }; });
  J.scanStarted('test-c', 'b', {});
  J._reloadForTest();
  const t0 = Date.now();
  await J.processScanResumes({ at: t0 });
  assert.equal(calls, 1);
  assert.equal(J.journalFor('test-c').interrupted[0].tries, 1);
  assert.ok(J.journalFor('test-c').interrupted[0].nextAt >= t0 + J.BUSY_RETRY_MS);
  await J.processScanResumes({ at: t0 + 1000 });
  assert.equal(calls, 1, '다음 시각 전에는 다시 부르지 않는다');
  for (let i = 1; i <= J.BUSY_RETRY_MAX; i++) await J.processScanResumes({ at: t0 + i * J.BUSY_RETRY_MS + 1 });
  assert.equal(J.journalFor('test-c').interrupted.length, 0);
  assert.equal(J.journalFor('test-c').recent[0].outcome, 'gave-up');
  J._resetForTest();
});

test('① 대기 중인 항목을 다른 경로(주기·수동)가 먼저 시작하면 covered · coversPending:false 는 덮지 않는다 · SCAN_RESUME=0 은 기록만', async () => {
  J._resetForTest();
  J.scanStarted('test-d', 'x', { label: 'X' });
  J.scanStarted('test-e', 'cycle', { label: '사이클', coversPending: false });
  J._reloadForTest();
  J.scanStarted('test-d', 'x', { label: 'X', trigger: 'periodic' });  // 주기 스캔이 먼저 돌았다
  assert.equal(J.isResumePending('test-d', 'x'), false, '재개가 두 번째 스캔을 열지 않게 대기 항목을 지운다');
  assert.equal(J.journalFor('test-d').recent[0].outcome, 'covered');
  J.scanStarted('test-e', 'cycle', { label: '다른 범위', coversPending: false });
  assert.equal(J.isResumePending('test-e', 'cycle'), true, '같은 키로 범위가 다른 실행이 오는 기능은 대기 항목을 재개 함수가 판정한다');

  J._resetForTest();
  J.registerScanResumer('test-f', async () => { throw new Error('부르면 안 된다'); });
  J.scanStarted('test-f', 'y', {});
  J._reloadForTest();
  process.env.SCAN_RESUME = '0';
  try {
    await J.processScanResumes();
    assert.equal(J.journalFor('test-f').recent[0].outcome, 'skipped');
    assert.match(J.journalFor('test-f').recent[0].note, /SCAN_RESUME=0/);
  } finally { delete process.env.SCAN_RESUME; }
  J._resetForTest();
});

test('① 손상 파일은 보존하고 새로 시작 · meta 상한 · 재개 지연 시간(빈 값·범위)', () => {
  J._resetForTest();
  fs.writeFileSync(FILE, '{not json');
  J._reloadForTest();
  const st = J.scanJournalStatus();
  assert.match(st.load.error || '', /JSON|Unexpected|token/i);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('scan-journal.json.corrupt.')), '원본을 보존한다');
  J.scanStarted('test-g', 'm', { meta: { ids: Array.from({ length: 3000 }, (_, i) => `id-${i}`) } });
  assert.ok(readFile().active['test-g:m'].meta.metaDropped > 8192, '8KB 넘는 meta 는 버리고 그 사실을 남긴다');
  assert.equal(J.resumeDelayMs(''), 120_000, '빈 값은 기본 2분(Number("")===0 함정)');
  assert.equal(J.resumeDelayMs('1000'), 10_000, '하한 10초');
  assert.equal(J.resumeDelayMs('99999999'), 30 * 60_000, '상한 30분');
  assert.equal(J.resumeDelayMs('abc'), 120_000);
  J._resetForTest();
});

/* ═══════════════════════════ ② 아이실론 분리 실행(실제 셸) ═══════════════════════════ */

test('② 분리 실행 — 실제 셸에서 du 를 띄우고 끝나면 결과를 받고 작업 파일을 지운다', async () => {
  const api = localApi();
  let job = null;
  const r = await D.runDetached(api, T, { cmdMs: 60_000, pollMinMs: 100, onJob: (j) => { job = j.id; } });
  assert.equal(r.mode, 'detached');
  assert.equal(r.attached, false);
  assert.ok(job && r.jobId === job, '작업 id 를 알린다(실행 중 스캔 기록에 남길 수 있게)');
  assert.match(r.x.stdout, /5\.0G\t\/ifs\/data\/users\/alpha/);
  assert.equal(r.x.code, 1, 'du 의 종료코드를 그대로 전한다(권한 오류 줄이 있으면 1)');
  assert.match(r.x.stderr, /Permission denied/);
  assert.deepEqual(jobFiles(job), [], '결과를 받으면 그 작업 파일을 지운다');
  assert.ok(fs.statSync(jobDir).isDirectory());
  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700, '임시 디렉터리는 이 계정만(umask 077)');
});

test('② 세션이 끊겨도(포탈 재시작) 장비의 du 는 계속 돌고 · 다음 실행이 같은 작업에 다시 붙어 결과를 받는다(du 1번만)', async () => {
  const count = path.join(DIR, 'du-count-attach');
  const env = { FAKE_DU_SLEEP: '2', FAKE_DU_COUNT: count };
  const ac = new AbortController();
  let job = null;
  const first = D.runDetached(localApi(env), T, { cmdMs: 60_000, pollMinMs: 100, signal: ac.signal, onJob: (j) => { job = j.id; } });
  await waitFor(() => job);
  killed.push(job);
  setTimeout(() => ac.abort(new Error('포탈 종료')), 300);
  const err = await first.then(() => null, (e) => e);
  assert.ok(err, '세션 쪽은 끊겼다');
  assert.equal(err.jobId, job, '던지는 오류에 작업 id 가 붙는다(호출부가 정리·재개에 쓴다)');
  assert.ok(jobFiles(job).length > 0, '장비의 작업 파일은 남아 있다(du 가 계속 돈다)');

  const api2 = localApi(env);
  const r = await D.runDetached(api2, T, { cmdMs: 60_000, pollMinMs: 100, attachJob: job });
  assert.equal(r.attached, true, '같은 작업에 다시 붙었다');
  assert.equal(r.jobId, job);
  assert.match(r.x.stdout, /beta/);
  assert.equal(fs.readFileSync(count, 'utf8').trim().split('\n').length, 1, 'du 를 새로 돌리지 않았다(이어 받았다)');
  assert.equal(api2.calls.some((c) => /DVC-STARTED/.test(c)), false, '시작 명령을 다시 보내지 않았다');
  assert.deepEqual(jobFiles(job), []);
});

test('② 포탈 쪽 시한에 걸리면 장비의 du 를 실제로 멈춘다(끝 표지가 생기지 않는다) · 작업 파일도 지운다', async () => {
  const mark = path.join(DIR, 'du-finished-mark');
  const env = { FAKE_DU_SLEEP: '3', FAKE_DU_MARK: mark };
  let job = null;
  const err = await D.runDetached(localApi(env), T, { cmdMs: 10_000, started: Date.now() - 9_400, pollMinMs: 100, onJob: (j) => { job = j.id; } })
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, /시한 초과.*장비의 du 작업을 멈췄습니다/);
  assert.equal(err.jobId, job);
  assert.deepEqual(jobFiles(job), [], '멈출 때 작업 파일을 지운다');
  await new Promise((r) => setTimeout(r, 3_800));
  assert.equal(fs.existsSync(mark), false, 'du 가 끝까지 돌지 않았다(멈췄다)');
});

test('② 붙을 작업이 없으면(재부팅·정리) 새로 시작 · 분리 실행을 못 하면 예전처럼 세션에 묶어 실행하고 사유를 남긴다', async () => {
  const r = await D.runDetached(localApi(), T, { cmdMs: 60_000, pollMinMs: 100, attachJob: 'tgt-det-zzz-000000' });
  assert.equal(r.attached, false, '작업 파일이 없다(DVC-NONE) — 새로 띄웠다');
  assert.equal(r.mode, 'detached');
  assert.notEqual(r.jobId, 'tgt-det-zzz-000000');

  const calls = [];
  const stub = (startOut) => ({ async exec(cmd) { calls.push(cmd); if (cmd.includes('DVC-STARTED')) return { stdout: startOut, stderr: 'sh: nohup: not found', code: startOut ? 4 : 127 }; return { stdout: '1G\t/ifs/data/users/a\n', stderr: '', code: 0 }; } });
  const f1 = await D.runDetached(stub(''), T, { cmdMs: 60_000 });
  assert.equal(f1.mode, 'attached-fallback');
  assert.match(f1.detachFallback, /nohup: not found/);
  assert.match(calls[calls.length - 1], /^du -A -h -d 1 '\/ifs\/data\/users'$/, '같은 du 를 세션에 묶어 실행했다');
  const f2 = await D.runDetached(stub('DVC-NODIR\n'), T, { cmdMs: 60_000 });
  assert.match(f2.detachFallback, /임시 디렉터리/, '다른 계정이 만든 경로에 쓰지 않는다 — 사유를 말한다');
});

test('② 상태 확인 도중 작업이 끝나도(rc 확인 → 생존 확인 사이) GONE 이 아니라 DONE 이다 — v2.787.1 CI 간헐 실패', async () => {
  // CI 에서 '결과 없이 끝났습니다' 로 간헐 실패한 원인: 첫 rc 확인과 kill -0 사이에 작업이 rc 를 쓰고 끝났다. 이 컨테이너처럼 고아를 늦게 거두는
  // 환경에서는 좀비가 kill -0 을 통과시켜 드러나지 않으므로, 그 사이를 셸에서 그대로 만든다 — kill 은 내장이라 바꿀 수 없어 외부 명령 cat 을 가로챈다:
  // .pid 를 읽는 순간 .rc 를 만들고(작업이 방금 끝남) 이미 거둔 pid 를 내준다.
  const realCat = process.env.PATH.split(':').map((d) => path.join(d, 'cat')).find((p) => fs.existsSync(p));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecat2737-'));
  fs.writeFileSync(path.join(bin, 'cat'), `#!/bin/sh\ncase "$1" in *.pid) printf '0\\n' > "\${1%.pid}.rc";; esac\nexec '${realCat}' "$@"\n`, { mode: 0o755 });
  const id = D.newJobId('race');
  const dead = await new Promise((r) => { const c = execFile('sh', ['-c', 'exit 0'], () => r(c.pid)); });
  try {
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(jobDir, `${id}.pid`), `${dead}\n`);
    const st = await localApi({ PATH: `${bin}:${process.env.PATH}` }).exec(D.statusCommand(id));
    assert.ok(fs.existsSync(path.join(jobDir, `${id}.rc`)), '가짜 cat 이 경합을 만들었다(전제 확인)');
    assert.deepEqual(D.parseStatus(st.stdout), { state: 'done', rc: 0 }, '프로세스가 없다고 본 뒤 rc 를 다시 본다');
    // rc 없이 프로세스만 사라진 경우는 여전히 GONE
    fs.rmSync(path.join(jobDir, `${id}.rc`));
    assert.equal(D.parseStatus((await localApi().exec(D.statusCommand(id))).stdout).state, 'gone');
  } finally {
    await localApi().exec(D.cleanupCommand(id));
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('② 명령 조립 — 작업 id 형식 · 작은따옴표 인용(셸 실제 왕복) · 상태 해석', async () => {
  assert.throws(() => D.statusCommand('a;rm -rf /'), /형식/);
  assert.throws(() => D.killCommand("x'y"), /형식/);
  const id = D.newJobId('tgt/../x y');
  assert.match(id, D.JOB_RE, '대상 id 의 이상한 글자를 지운다');
  for (const s of ["a'b", "'", "a'\"'\"'b", 'a b $x `y`']) {
    const out = await localApi().exec(`printf %s ${D.shq(s)}`);
    assert.equal(out.stdout, s, `셸이 ${JSON.stringify(s)} 를 그대로 받는다`);
  }
  assert.deepEqual(D.parseStatus('DVC-DONE 0\n'), { state: 'done', rc: 0 });
  assert.deepEqual(D.parseStatus('noise\nDVC-RUNNING\n'), { state: 'running' });
  assert.equal(D.parseStatus('DVC-GONE').state, 'gone');
  assert.equal(D.parseStatus('DVC-NONE').state, 'none');
  assert.equal(D.parseStatus('???').state, 'unknown');
  assert.match(D.startCommand(T, 'tgt-det-a-b'), /^sh -c '/, '로그인 셸이 무엇이든 POSIX sh 로 감싼다');
});

/* ═══════════════════════════ ③ iDRAC 대역 · IP 스캔 재개 ═══════════════════════════ */

test('③ iDRAC — 재시작 전 사이클의 남은 대역만 다시 스캔한다(중단 전에 끝낸 대역은 건너뜀)', async () => {
  J._resetForTest();
  const SR = await import('../src/idrac/scanRanges.js');
  const SP = await import('../src/idrac/scanPoller.js');
  // 루프백은 SSRF 차단 대역이라 실제로 찌르지 않고 곧바로 끝난다(차단 개수만 센다) — 사이클 흐름만 본다.
  const mk = (dc) => SR.saveScanRanges({ datacenterId: dc, ranges: ['127.0.0.1'], username: 'root', password: 'pw-2737' });
  const a = mk('DC-A'); const b = mk('DC-B'); const c = mk('DC-C');
  assert.ok(a.ok && b.ok && c.ok);
  J.scanStarted('idrac-scan', 'cycle', { label: '전체 3개 대역', trigger: 'periodic', coversPending: false, meta: { ids: [a.id, b.id, c.id], manual: false } });
  await new Promise((r) => setTimeout(r, 5));
  SR.recordScanRangeRun(a.id, { found: 0 });                 // A 는 재시작 전에 끝났다
  const aAt = SR.getScanRangeRaw(a.id).lastRun.at;
  J._reloadForTest();
  assert.equal(J.isResumePending('idrac-scan', 'cycle'), true);

  await J.processScanResumes();
  const h = J.journalFor('idrac-scan').recent[0];
  assert.equal(h.outcome, 'resumed');
  assert.match(h.note, /남은 대역 2개\(전체 3개 중\)/);
  await waitFor(() => !SP.idracScanStatus().running);
  assert.equal(SR.getScanRangeRaw(a.id).lastRun.at, aAt, '끝낸 대역은 다시 돌지 않았다');
  assert.ok(SR.getScanRangeRaw(b.id).lastRun.at > aAt && SR.getScanRangeRaw(c.id).lastRun.at > aAt, '남은 대역은 다시 돌았다');
  assert.equal(SP.idracScanStatus().lastRun.datacenters, 2);
  assert.equal(J.runningScans().length, 0, '끝나면 기록을 지운다');

  // 남은 대역이 없으면 covered — 다시 돌리지 않는다
  J.scanStarted('idrac-scan', 'cycle', { coversPending: false, meta: { ids: [b.id] } });
  await new Promise((r) => setTimeout(r, 5));
  SR.recordScanRangeRun(b.id, { found: 0 });
  J._reloadForTest();
  await J.processScanResumes();
  assert.equal(J.journalFor('idrac-scan').recent[0].outcome, 'covered');
  J._resetForTest();
});

test('③ IP 스캔 — 수동 스캔이 끊기면 재개가 스캔을 다시 시작하고 실행 로그에 "중단됨·재개" 를 남긴다 · 대역이 없으면 gone', async () => {
  J._resetForTest();
  const ST = await import('../src/ipam/scanStore.js');
  const SP = await import('../src/ipam/scanPoller.js');
  const LOG = await import('../src/ipam/scanLog.js');
  ST.saveScanSettings(ST.LOCAL, { enabled: false, ranges: [], ports: [9] });
  J.scanStarted('ipscan', 'local', { label: 'IP 스캔', trigger: 'manual', meta: { manual: true } });
  J._reloadForTest();
  assert.equal((await SP.resumeIpScan(J.pendingResumeOf('ipscan', 'local'))).outcome, 'gone', '스캔할 대역이 없다');

  ST.saveScanSettings(ST.LOCAL, { ranges: ['127.0.0.1'], ports: [9], timeoutMs: 200 });
  J._resetForTest();
  J.registerScanResumer('ipscan', SP.resumeIpScan); // _resetForTest 는 등록된 재개 함수도 지운다(모듈은 import 때 한 번 등록한다)
  J.scanStarted('ipscan', 'local', { label: 'IP 스캔', trigger: 'manual', meta: { manual: true } });
  J._reloadForTest();
  await J.processScanResumes();
  assert.equal(J.journalFor('ipscan').recent[0].outcome, 'resumed');
  await waitFor(() => !SP.scanStatus().running && SP.scanStatus().lastRun);
  assert.ok(!SP.scanStatus().lastRun.skipped, '실제로 스캔했다(주기가 꺼져 있어도 수동 스캔의 재개는 돈다)');
  const ev = LOG.listScanLog({ limit: 20 }).entries.map((x) => x.event);
  assert.ok(ev.includes('resume'), '실행 로그가 재개를 말한다');
  // 스캔을 시작하면 그 순간 기록에 남고(곧바로 재시작이 와도 남게) 끝나면 지운다
  J._resetForTest();
  J.registerScanResumer('ipscan', SP.resumeIpScan);
  SP.startScan({ manual: true });
  assert.equal(readFile().active['ipscan:local']?.trigger, 'manual', '시작과 같은 틱에 파일에 남는다');
  await waitFor(() => !SP.scanStatus().running);
  assert.equal(readFile().active['ipscan:local'], undefined, '끝나면 지운다');
  // 주기 스캔이 꺼져 있고 주기 스캔이 끊긴 것이면 다시 돌리지 않는다
  J.scanStarted('ipscan', 'local', { trigger: 'periodic', meta: { manual: false } });
  J._reloadForTest();
  const r = await SP.resumeIpScan({ ...J.pendingResumeOf('ipscan', 'local'), detectedAt: Date.now() + 60_000 });
  assert.equal(r.outcome, 'skipped');
  J._resetForTest();
});

/* ═══════════════════════════ ④ 자동 업그레이드가 실행 중 스캔을 기다린다 ═══════════════════════════ */

test('④ 자동 적용은 실행 중 스캔이 끝나기를 기다린다 — 기다리는 동안 1분마다 다시 보고 끝나면 곧바로 적용', async () => {
  J._resetForTest();
  const { UpgradeManager, scanDeferMaxMs } = await import('../src/upgrade/manager.js');
  assert.equal(scanDeferMaxMs(''), 7_200_000, '빈 값은 기본 2시간');
  assert.equal(scanDeferMaxMs('0'), 0, '0 = 기다리지 않는다');
  assert.equal(scanDeferMaxMs('999999999999'), 12 * 3_600_000, '상한 12시간');
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const m = new UpgradeManager();
    m.settings = { ...m.settings, enabled: true, autoApply: true, installDir: '/opt/x', remoteBase: 'https://example.invalid', pollIntervalMs: 3_600_000 };
    let applied = 0;
    m.check = async () => ({ remote: { ok: true, latest: '9.9.9', available: true } });
    m.apply = async () => { applied++; return { ok: true, version: '9.9.9' }; };
    J.scanStarted('isidu', 't1', { label: '아이실론 조사', trigger: 'manual' });
    await m.tick();
    assert.equal(applied, 0, '스캔 중에는 적용하지 않는다');
    assert.equal(m.lastTick.outcome, 'deferred');
    const st = m.status();
    assert.equal(st.runningScans.length, 1);
    assert.equal(st.deferral.scans[0].label, '아이실론 조사');
    assert.ok(st.auto.issues.some((x) => x.code === 'deferred-scans' && x.scans === 1), '화면이 무엇을 기다리는지 말한다');
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(applied, 0, '아직 스캔 중');
    J.scanFinished('isidu', 't1');
    mock.timers.tick(60_000);
    await waitFor(() => applied === 1, 2_000, 5);
    assert.equal(m.lastTick.outcome, 'applied');
    assert.match(m.lastTick.reason, /실행 중이던 스캔이 끝나 적용합니다/);
    assert.equal(m.status().deferral, null);
  } finally { mock.timers.reset(); }
});

test('④ 대기 상한을 넘기면 적용한다 · 0 이면 기다리지 않는다', async () => {
  J._resetForTest();
  const { UpgradeManager } = await import('../src/upgrade/manager.js');
  const mk = () => {
    const m = new UpgradeManager();
    m.settings = { ...m.settings, enabled: true, autoApply: true, installDir: '/opt/x', remoteBase: 'https://example.invalid', pollIntervalMs: 3_600_000 };
    m.check = async () => ({ remote: { ok: true, latest: '9.9.9', available: true } });
    m.applied = 0; m.apply = async () => { m.applied++; return { ok: true, version: '9.9.9' }; };
    return m;
  };
  J.scanStarted('ipscan', 'local', { label: '긴 스캔' });
  process.env.UPGRADE_SCAN_DEFER_MAX_MS = '1';
  try {
    const m = mk();
    await m.tick();
    assert.equal(m.applied, 0);
    await new Promise((r) => setTimeout(r, 5));
    await m.tick();
    assert.equal(m.applied, 1, '상한(여기서는 1ms)을 넘기면 끝나지 않는 스캔이 업그레이드를 막지 않는다');
    process.env.UPGRADE_SCAN_DEFER_MAX_MS = '0';
    const m0 = mk();
    await m0.tick();
    assert.equal(m0.applied, 1, '0 이면 기다리지 않는다');
  } finally { delete process.env.UPGRADE_SCAN_DEFER_MAX_MS; J._resetForTest(); }
});
