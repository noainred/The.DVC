/**
 * bareosFullAudit1.test.js — 전체 소스 점검 1회차(백업 · Bareos 서버) 확정분.
 *  ① B-1: 엣지가 시한 안에 '결과 모름'(필수 값 없음 · unknown:true)으로 회신한 작업은 늦은 회신 대기(_late)에 올리지 않는다
 *     — 그 회신이 마지막이라 15분 동안 자동 업그레이드(inflight.runningBareosWork)만 붙잡았다. 시한(abort)으로 닫은 작업은 그대로 올린다.
 *  ② B-2: 끝난 실행 목록(finishedRuns)에 덜 자세한 행(바이트 빈 칸)으로 먼저 들어간 실행은 뒤에 온 자세한 행으로 빈 칸만 채운다
 *     — 아는 값은 바꾸지 않는다 · 같은 행을 다시 받으면 쓰지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosfullaudit1-'));
process.env.DATA_SOURCE = 'mock';
const E = await import('../src/bareos/edgeOps.js');
const R = await import('../src/bareos/registry.js');
const { runningBareosWork } = await import('../src/bareos/inflight.js');
const { prevSameLevel } = await import('../src/routes/api/bareosLive.js');

const lateCount = () => runningBareosWork().filter((w) => w.key.startsWith('late:')).length;

test('① B-1 — 시한 안의 결과 모름 회신은 늦은 회신 대기에 남지 않는다 · 시한으로 닫은 작업은 남는다', async () => {
  E._resetForTest();
  const got = [];
  // (가) 엣지가 시한 안에 jobid 없이 성공을 회신 → 정제가 unknown 으로 바꾼다
  const p1 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'runJob', { job: 'pv-pl-vm-1', level: 'Full' }, { onLate: (lr) => got.push(lr) });
  const t1 = E.takeEdgeOps('edge-pl', 5);
  assert.equal(t1.length, 1);
  assert.deepEqual(E.completeEdgeOp(t1[0].id, 'edge-pl', { ok: true, value: null }), { ok: true });
  const r1 = await p1;
  assert.equal(r1.unknown, true, '정제 결과는 결과 모름');
  assert.equal(E.lateView().length, 0, '회신을 받은 작업은 늦은 회신을 기다리지 않는다');
  assert.equal(lateCount(), 0, '자동 업그레이드를 붙잡지 않는다');
  // (나) 엣지가 시한 안에 unknown:true 로 직접 회신
  const p2 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'restore', { jobid: 5, name: 'pv-pl-vm-1' }, { onLate: (lr) => got.push(lr) });
  const t2 = E.takeEdgeOps('edge-pl', 5);
  E.completeEdgeOp(t2[0].id, 'edge-pl', { ok: false, code: 'unknown', unknown: true, reason: 'Director 응답이 끊겼습니다' });
  assert.equal((await p2).unknown, true);
  assert.equal(E.lateView().length, 0);
  // 같은 id 로 다시 와도 늦은 회신으로 처리하지 않는다(모르는 id)
  assert.deepEqual(E.completeEdgeOp(t2[0].id, 'edge-pl', { ok: true, value: 9 }), { ok: true, stale: true });
  assert.equal(got.length, 0, 'onLate 는 불리지 않는다');
  // (다) 대조 — 부른 쪽 시한(abort)으로 닫은 가져간 작업은 늦은 회신을 기다린다(v2.824 P1 · v2.938 그대로)
  const ac = new AbortController();
  const p3 = E.enqueueEdgeOp({ id: 'dir_pl', agent: 'edge-pl', connSig: 's' }, 'runJob', { job: 'pv-pl-vm-2', level: 'Full' }, { signal: ac.signal, onLate: (lr) => got.push(lr) });
  E.takeEdgeOps('edge-pl', 5);
  ac.abort();
  assert.equal((await p3).unknown, true);
  assert.equal(E.lateView().length, 1, '시한으로 닫은 작업만 늦은 회신 대기');
  assert.equal(lateCount(), 1);
  E._resetForTest();
});

test('② B-2 — finishedRuns 의 빈 칸은 뒤에 온 자세한 행으로 채운다 · 아는 값은 그대로', () => {
  const id = R.addJob({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-9', vmName: 'web-9', directorId: 'dir_pl', bareosJob: 'pv-pl-vm-9', client: 'pl-fd', storage: 'File', pool: 'Full', dc: 'DC-PL', folder: '/web', createdBy: 't' }).id;
  const t0 = Date.parse('2026-11-01T01:00:00');
  // 대조용 list jobs 행 — 바이트 · 파일 수가 비어 온다(Bareos 스케줄이 돌린 실행)
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: null, files: null, errors: 0 });
  // 다음 실행이 시작돼 lastRun 이 그 실행으로 바뀐다
  R.applyRunRow(id, { jobid: 101, status: 'R', level: 'I', startedAt: t0 + 86_400_000, endedAt: null, bytes: null, files: null, errors: null });
  // 사람이 지난 실행(100)의 로그를 열어 자세한 행이 들어온다
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: 5_000_000, files: 12, errors: 0 });
  const j = R.getJob(id);
  const f = j.finishedRuns.find((x) => x.jobid === 100);
  assert.equal(f.bytes, 5_000_000, '빈 바이트를 채운다');
  assert.equal(j.lastRun.jobid, 101, 'lastRun 은 더 새 실행 그대로');
  const prev = prevSameLevel({ lastRun: j.lastRun, recentRuns: j.finishedRuns }, 'Incremental', 101);
  assert.ok(prev, '지난 같은 레벨 기준이 생긴다');
  assert.equal(prev.jobid, 100); assert.equal(prev.bytes, 5_000_000);
  // 아는 값은 덜 자세한 행 · 다른 값으로 바꾸지 않는다
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: null, files: null, errors: null });
  R.applyRunRow(id, { jobid: 100, status: 'T', level: 'I', startedAt: t0, endedAt: t0 + 600_000, bytes: 7, files: 1, errors: 3 });
  const f2 = R.getJob(id).finishedRuns.find((x) => x.jobid === 100);
  assert.equal(f2.bytes, 5_000_000); assert.equal(f2.errors, 0);
  assert.equal(R.getJob(id).finishedRuns.filter((x) => x.jobid === 100).length, 1, '중복 행을 만들지 않는다');
});

// ── 전체 점검 3회차(B-3) — 단건 '지금 실행' 이 명령을 보낸 뒤 끊기면 결과 모름(그룹 실행 · 복원과 같은 표) · 시한부 재요청 막기 ──
test('③ B-3 — ops.runJob: 보낸 뒤 끊김(timeout · closed · protocol)은 unknown · 보내기 전 오류는 그대로', async () => {
  const { OPS } = await import('../src/bareos/ops.js');
  for (const code of ['timeout', 'closed', 'protocol', 'aborted', 'too-large']) {
    const s = { call: async () => { throw Object.assign(new Error('끊김'), { code }); } };
    await assert.rejects(OPS.runJob(s, { job: 'pv-pl-vm-1', level: 'Full' }), (e) => e.code === 'unknown' && e.unknown === true, code);
  }
  // jobid 없는 응답(명령은 이미 Director 에 갔다) — director.jobIdOf 의 protocol 도 결과 모름
  await assert.rejects(OPS.runJob({ call: async () => ({}) }, { job: 'pv-pl-vm-1', level: 'Full' }), (e) => e.code === 'unknown');
  // Director 가 거부(jsonrpc) · 접속 실패(connect)는 확정 실패 그대로
  for (const code of ['jsonrpc', 'connect', 'auth']) {
    const s = { call: async () => { throw Object.assign(new Error('거부'), { code }); } };
    await assert.rejects(OPS.runJob(s, { job: 'pv-pl-vm-1', level: 'Full' }), (e) => e.code === code, code);
  }
  // 성공은 jobid 그대로
  assert.equal(await OPS.runJob({ call: async () => ({ jobid: '812' }) }, { job: 'pv-pl-vm-1', level: 'Full' }), 812);
});

test('③ B-3 — runUnknownHeld: 결과 모름 뒤 10분 동안 막고 · 그 뒤 시작한 실행이 원장에 보이면 먼저 풀린다', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const le = { at: now - 60_000, message: 'x', unknown: true };
  assert.equal(R.runUnknownHeld({ lastError: le }, now), true);
  assert.equal(R.runUnknownHeld({ lastError: le }, now - 60_000 + R.RUN_UNKNOWN_HOLD_MS), false, '시한이 지나면 풀린다');
  assert.equal(R.runUnknownHeld({ lastError: { ...le, unknown: undefined } }, now), false, '확정 실패는 막지 않는다');
  assert.equal(R.runUnknownHeld({ lastError: le, lastRun: { jobid: 9, startedAt: now - 30_000 } }, now), false, '그 뒤 시작한 실행이 보이면 풀린다');
  assert.equal(R.runUnknownHeld({ lastError: le, lastRun: { jobid: 8, startedAt: now - 3_600_000 } }, now), true, '더 오래된 실행은 풀지 않는다');
  assert.equal(R.runUnknownHeld({ lastError: le, lastRun: { jobid: 8, startedAt: null } }, now), true, '시각을 모르면 풀지 않는다');
});

test('③ B-3 — 라우트 소스: 결과 모름은 표지 · 감사 결과 모름 · 504 · 다시 누르면 409', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/routes/api/bareosBackup.js'), 'utf8');
  const i = src.indexOf('async function runRoute(req, res, job) {');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /if \(runUnknownHeld\(job\)\) return res\.status\(409\)/);
  assert.match(body, /lastError: \{ at: Date\.now\(\), message: [^\n]*\.\.\.\(unknown \? \{ unknown: true \} : \{\}\) \}/);
  assert.match(body, /\$\{unknown \? '결과 모름' : '실패'\}/);
  assert.ok(body.indexOf('runUnknownHeld(job)') < body.indexOf("onDirector(jobDir(job), 'runJob'"), '보내기 전에 막는다');
});

// ── 전체 점검 5회차(R-1) — 결과 모름 막기는 단건 · 그룹 실행이 서로 본다 ──
test('⑤ R-1 — markRunUnknown(쓰기 한 번) → runUnknownHeld · 그룹 실행이 결과 모름 대상을 보내지 않고 덩어리 결과 모름도 표지를 남긴다', () => {
  const a = R.addJob({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-31', vmName: 'web-31', directorId: 'dir_pl', bareosJob: 'pv-pl-vm-31', client: 'pl-fd', storage: 'File', pool: 'Full', dc: 'DC-PL', folder: '/web', createdBy: 't' }).id;
  const b = R.addJob({ vcenterId: 'vc-pl', vmId: 'vc-pl:vm-32', vmName: 'web-32', directorId: 'dir_pl', bareosJob: 'pv-pl-vm-32', client: 'pl-fd', storage: 'File', pool: 'Full', dc: 'DC-PL', folder: '/web', createdBy: 't' }).id;
  R.markRunUnknown([a, b], '그룹 ‘g1’ 실행 결과 모름 — timeout');
  for (const id of [a, b]) { const j = R.getJob(id); assert.equal(j.lastError.unknown, true); assert.equal(R.runUnknownHeld(j), true); }
  // 늦은 회신 · 새 실행(markPending)은 표지를 지운다
  R.markPending(a, { jobid: 900, level: 'Full', by: 't' });
  assert.equal(R.runUnknownHeld(R.getJob(a)), false);
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bareos/groupRunner.js'), 'utf8');
  const iHeld = src.indexOf('if (runUnknownHeld(j)) {'); const iLock = src.indexOf('if (!tryLockJob(j.id)) {');
  assert.ok(iHeld > 0 && iHeld < iLock, '보낼 대상을 고를 때 본다(잠금 전)');
  assert.match(src, /if \(st === 'unknown'\) markRunUnknown\(chunk\.map\(\(s\) => s\.job\.id\),/, '덩어리째 결과 모름');
  assert.match(src, /\} else if \(st === 'unknown'\) \{\n\s*patchJob\(s\.job\.id, \{ lastError: \{[^\n]*unknown: true \} \}\);/, '항목 결과 모름');
});

// ── 전체 점검 10회차(B-20 · B-21 · B-22) — 완전 설치 ──
test('⑩ B-20 — 중앙 단계 4 · 7 · 전부 되돌리기의 포탈 정리는 Bareos 설정을 못 읽으면 저장하지 않는다', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bareos/install/job.js'), 'utf8');
  const step = (n) => { const i = src.indexOf(`  if (n === ${n}) {`, src.indexOf('async function centralStep(')); return src.slice(i, i + 200); };
  assert.match(step(4), /^ {2}if \(n === 4\) \{\n {4}requireSettingsReadable\('[^']+'\);\n {4}const cur = loadSettings\(\);/);
  assert.match(step(7), /^ {2}if \(n === 7\) \{\n {4}requireSettingsReadable\('[^']+'\);\n {4}const cur = loadSettings\(\);/);
  assert.match(src, /if \(registryLoadError\(\)\) throw fail\('unavailable', '백업 대상 원장을 읽지 못해 포탈 쪽 등록 · 매핑을 남겼습니다'\);\n\s*requireSettingsReadable\(/);
  assert.match(src, /function requireSettingsReadable\(what\) \{\n\s*if \(settingsLoadError\(\)\) throw fail\('unavailable'/);
});

test('⑩ B-21 — 실패 기록의 rolledBack 기본값은 모름(null) · 중앙 단계 4 · 5 의 autoSetup 실패만 되돌림으로', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bareos/install/job.js'), 'utf8');
  assert.match(src, /rolledBack: e\.rolledBack \?\? null, rollbackFailed/);
  assert.doesNotMatch(src, /rolledBack: e\.rolledBack \?\? \(step === 4 \|\| step === 5 \? true : null\)/);
});

test('⑩ B-22 — runner.sh SELinux 규칙 확인은 첫 칸이 정확히 그 경로인 줄만(부분 문자열 아님)', async () => {
  const { execFileSync } = await import('node:child_process');
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bareos/install/runner.sh'), 'utf8');
  const m = /semanage fcontext -l -C 2>\/dev\/null \| (awk -v d="\$VOLUME_DIR" '[^']+')/.exec(src);
  assert.ok(m, 'awk 정확 일치');
  const has = (listing, dir) => { try { execFileSync('bash', ['-c', `printf '%s\\n' "$L" | ${m[1]}`], { env: { ...process.env, L: listing, VOLUME_DIR: dir } }); return true; } catch { return false; } };
  assert.equal(has('/data/bareos-old = /var/lib/bareos/storage', '/data/bareos'), false, '접두가 같은 다른 경로는 이미 있음이 아니다');
  assert.equal(has('/data/bareos = /var/lib/bareos/storage', '/data/bareos'), true);
  assert.equal(has('', '/data/bareos'), false);
});
