/**
 * test/bareosMailCause2885.test.js — v2.885 Bareos 실패 메일 '원인' 칸(2026-11-04 사용자 선택 '③ 실패 메일에 원인 한 줄').
 *  ① 해석 표는 하나: 서버 사본(bareos/issueHints.js)과 웹(bareosText.js)의 정규식 원문 · 플래그 · 문구가 글자까지 같다
 *  ② attachCauses(순수 + 읽기 대역): Director 마다 묶어 한 번 · 복원 행은 읽지 않음 · 기록에 있으면 다시 읽지 않음 · 던지면 '못 읽음' ·
 *     회신에 없는 행 · 오류 줄 없음(null) · Director 마다 LOGS_MAX · 한 통 CAUSE_MAX · 기록 상한
 *  ③ 본문: 원인 칸(첫 오류 줄 + → 해석) · 이스케이프 · 글 본문에도
 *  ④ tick(자식 프로세스 — 메일 · 설정 · store 대체): 원인 칸이 실린 메일 · 읽기 실패여도 보낸다 · 읽기는 trigger 'timer' · 다시 보낼 때 다시 읽지 않는다
 *  ⑤ 일일 요약: 실패 메일이 읽어 둔 원인을 쓴다(Director 에 묻지 않는다) · 없으면 예전 오류 문구
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const J = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2885m-'));
process.env.CONFIG_DIR = tmp;
const N = await import('../src/bareos/notify.js');
const H = await import('../src/bareos/issueHints.js');
const W = await import('../../web/src/views/tools/bareosText.js');
const DG = await import('../src/bareos/digest.js');
const { LOGS_MAX } = await import('../src/bareos/ops.js');

const SSL = 'LESANXMPNJ01-fd JobId 32: Fatal error: python3-fd-mod: Could not fetch SSL Cert from 192.168.52.221: [Errno 111] Connection refused';

test('① 해석 표는 하나 — 서버 사본과 웹이 글자까지 같다', () => {
  const shape = (t) => t.map(([re, h]) => [re.source, re.flags, h]);
  assert.ok(Array.isArray(W.ISSUE_HINTS) && W.ISSUE_HINTS.length >= 10, '웹 표를 내보낸다');
  assert.deepEqual(shape(H.ISSUE_HINTS), shape(W.ISSUE_HINTS));
  for (const line of [SSL, 'x: Fatal error: ... requested, but job is already cancelled.', 'Permission denied', 'nothing', '', null]) {
    assert.equal(H.issueHint(line), W.issueHint(line));
  }
});

const row = (o = {}) => ({ kind: 'backup', state: 'error', status: 'f', jobid: 32, at: 1, level: 'Full', jobName: 'pv-a-vm-1', vmName: 'web01', vcenterId: 'vcA', directorId: 'D1', client: 'kr-fd', ...o });

test('② attachCauses — Director 마다 한 번 · 복원 제외 · 기록 재사용 · 실패 · 회신 없음 · 오류 줄 없음', async () => {
  const calls = [];
  const read = async (dir, items) => {
    calls.push([dir, items.map((x) => [x.jobid, x.name])]);
    if (dir === 'D2') throw new Error('인증 실패로 주기 조회를 멈췄습니다');
    return items.filter((x) => x.jobid !== 34).map((x) => (x.jobid === 38 ? { key: x.key, ok: false, code: 'invalid', message: '이 대상의 실행이 아닙니다.' } : { key: x.key, ok: true, firstError: x.jobid === 33 ? null : SSL }));
  };
  const rows = [row(), row({ jobid: 33 }), row({ jobid: 34 }), row({ jobid: 35, directorId: 'D2' }), row({ kind: 'restore', jobid: 36 }), row({ jobid: 37, directorId: 'D3' }), row({ jobid: 38 })];
  const causes = { 'D3:0:37': { line: '기록된 줄', job: 'pv-a-vm-1', at: 1 } };
  const stat = await N.attachCauses(rows, (r) => r.directorId, { causes, read, now: 5 });
  assert.deepEqual(calls.sort(), [['D1', [[32, 'pv-a-vm-1'], [33, 'pv-a-vm-1'], [34, 'pv-a-vm-1'], [38, 'pv-a-vm-1']]], ['D2', [[35, 'pv-a-vm-1']]]], 'Director 마다 한 번 · 복원 · 기록된 것은 묻지 않는다');
  assert.equal(rows[6].cause, undefined); assert.match(rows[6].causeMiss, /이 대상의 실행이 아닙니다/, '회신이 ok:false 면 \'오류 줄 없음\' 이 아니라 못 읽음');
  assert.deepEqual(rows[0].cause, { line: SSL });
  assert.deepEqual(rows[1].cause, { line: null }, '읽었는데 오류 줄이 없다(0 이 아니라 없음)');
  assert.match(rows[2].causeMiss, /회신에 이 실행이 없습니다/);
  assert.match(rows[3].causeMiss, /인증 실패/);
  assert.equal(rows[4].cause, undefined); assert.equal(rows[4].causeMiss, undefined, '복원 행은 읽지 않는다');
  assert.deepEqual(rows[5].cause, { line: '기록된 줄' });
  assert.deepEqual(causes['D1:0:32'], { line: SSL, job: 'pv-a-vm-1', at: 5 }); assert.deepEqual(causes['D1:0:33'], { line: null, job: 'pv-a-vm-1', at: 5 });
  assert.equal(causes['D1:0:34'], undefined, '못 읽은 것은 원인으로 기록하지 않는다');
  assert.deepEqual(stat, { asked: 5, read: 2, failed: 3 });
  // 상한: Director 마다 LOGS_MAX · 한 통 CAUSE_MAX
  const many = Array.from({ length: LOGS_MAX + 3 }, (_, i) => row({ jobid: 100 + i }));
  const spread = Array.from({ length: N.CAUSE_MAX }, (_, i) => row({ jobid: 500 + i, directorId: `X${i % 4}` }));
  const asked = [];
  await N.attachCauses([...many, ...spread], (r) => r.directorId, { causes: {}, read: async (d, items) => { asked.push(...items); return items.map((x) => ({ key: x.key, ok: true, firstError: 'E' })); } });
  assert.equal(asked.length, N.CAUSE_MAX, '한 통 상한');
  assert.equal(many.filter((r) => r.cause).length, LOGS_MAX, 'Director 마다 상한');
  assert.match(many.at(-1).causeMiss, /상한 밖/);
  // 기록 상한 · 기한
  const T = Date.now();
  const big = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`D9:0:${i + 1}`, { line: 'x', job: 'j', at: T }]));
  big['D8:0:1'] = { line: 'old', job: 'j', at: T - N.CAUSE_TTL_MS - 1 };
  await N.attachCauses([row({ jobid: 9999 })], () => 'D1', { causes: big, now: T, read: async (d, items) => items.map((x) => ({ key: x.key, ok: true, firstError: 'E' })) });
  assert.ok(Object.keys(big).length <= 400 && big['D1:0:9999'], '넘치면 오래된 것부터 지운다');
  assert.equal(big['D8:0:1'], undefined, '기한이 지난 기록은 지운다');
});

test('② -b 반증 M1 · M2 · L1 — 재설치 세대 · 잡 이름 · 못 읽음 기억 · 한 줄로', async () => {
  const n = [];
  const read = async (d, items) => { n.push(...items.map((x) => x.jobid)); return items.map((x) => ({ key: x.key, ok: true, firstError: 'NEW' })); };
  // M1: 재설치(세대가 바뀜)로 같은 jobid 5 를 받은 다른 VM — 옛 기록을 쓰지 않는다
  const causes = { 'D1:0:5': { line: 'OLD quiesce', job: 'pv-old-vm', at: Date.now() } };
  const r1 = row({ jobid: 5, jobName: 'pv-new-vm', epoch: 1700000000000 });
  const r2 = row({ jobid: 5, jobName: 'pv-new-vm', epoch: 0 });   // 세대 표지가 없어도 잡 이름이 다르면 쓰지 않는다
  await N.attachCauses([r1, r2], () => 'D1', { causes, read });
  assert.deepEqual([r1.cause, r2.cause], [{ line: 'NEW' }, { line: 'NEW' }]);
  assert.deepEqual(n, [5, 5]);
  // 같은 VM 을 다시 등록해 잡 이름이 같아도 세대가 다르면 다른 실행이다
  const same = { 'D1:0:6': { line: 'OLD', job: 'pv-same', at: Date.now() } };
  const r4 = row({ jobid: 6, jobName: 'pv-same', epoch: 1700000000000 });
  await N.attachCauses([r4], () => 'D1', { causes: same, read });
  assert.deepEqual(r4.cause, { line: 'NEW' }, '세대가 키에 들어간다');
  assert.equal(N.cachedCause('D1', 5, { epoch: 0, jobName: 'pv-new-vm' }), null, '요약도 상태 파일 기록만 본다(이 시험의 causes 는 따로)');
  // M2: 못 읽은 행은 MISS_TTL_MS 안에 다시 묻지 않는다
  const misses = new Map(); let calls = 0;
  const fail = async () => { calls += 1; throw new Error('연결 거부'); };
  const t0 = Date.now();
  await N.attachCauses([row({ jobid: 70 })], () => 'D1', { causes: {}, misses, read: fail, now: t0 });
  const again = row({ jobid: 70 });
  await N.attachCauses([again], () => 'D1', { causes: {}, misses, read: fail, now: t0 + 60_000 });
  assert.equal(calls, 1, '1분 뒤 틱은 다시 묻지 않는다');
  assert.match(again.causeMiss, /연결 거부/);
  await N.attachCauses([row({ jobid: 70 })], () => 'D1', { causes: {}, misses, read: fail, now: t0 + N.MISS_TTL_MS + 1 });
  assert.equal(calls, 2, '기한이 지나면 다시 묻는다');
  // L1: 엣지 회신 줄의 줄바꿈 · 양방향 제어 문자는 공백으로
  const r3 = row({ jobid: 71 });
  await N.attachCauses([r3], () => 'D1', { causes: {}, read: async (d, items) => items.map((x) => ({ key: x.key, ok: true, firstError: 'a\nFAKE ROW\u202Eb' })) });
  assert.equal(r3.cause.line, 'a FAKE ROW b');
});

test('② -c 반증 L3 — 첫 오류 줄은 자르기 전 전체 로그에서', async () => {
  const { jobLog } = await import('../src/bareos/director.js');
  const { firstErrorLine } = await import('../src/bareos/logFirstError.js');
  const rows = [{ time: '2026-11-04 10:00:00', logtext: 'x-fd JobId 9: Fatal error: python3-fd-mod: Could not fetch SSL Cert from vc: [Errno 111] Connection refused' }];
  for (let i = 0; i < 3000; i++) rows.push({ time: '2026-11-04 10:00:01', logtext: `bareos-dir JobId 9: Error: chain ${i}` });
  const s = { call: async () => ({ joblog: rows }) };
  const log = await jobLog(s, 9, { maxBytes: 128 * 1024, maxLines: 2000, firstErrorOf: firstErrorLine });
  assert.equal(log.truncated, true);
  assert.match(log.firstError, /Could not fetch SSL Cert/, '뒤쪽만 남긴 줄이 아니라 전체에서 고른다');
  assert.match(firstErrorLine(log.lines), /chain/, '(예전 방식이면 연쇄 줄을 골랐다)');
  const plain = await jobLog(s, 9, { maxLines: 10 });
  assert.equal('firstError' in plain, false, '부르지 않으면 칸이 없다(낱건 로그 응답 모양 그대로)');
});

test('③ 본문 — 원인 칸(첫 오류 줄 + → 해석) · 이스케이프 · 글 본문', () => {
  const rows = [row({ cause: { line: SSL } }), row({ jobid: 33, vmName: 'db01', cause: { line: null } }), row({ jobid: 34, vmName: 'app', causeMiss: '<b>x</b>' }), row({ kind: 'restore', jobid: 35, vmName: 'r' })];
  const m = N.renderBareosMail(rows, (id) => id, () => '한국');
  assert.match(m.html, /원인\(첫 오류 줄\)/);
  assert.match(m.html, /Could not fetch SSL Cert from 192\.168\.52\.221/);
  assert.match(m.html, /→ FD 서버가 vCenter\(vcserver\):443 에 접속하지 못했습니다/);
  assert.match(m.html, /오류 줄 없음/);
  assert.match(m.html, /못 읽음 — &lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(m.html, /<b>x<\/b>/);
  assert.match(m.text, /원인: .*Could not fetch SSL Cert/);
  assert.match(m.text, /→ FD 서버가 vCenter/);
  assert.doesNotMatch(m.html, /`/, '백틱 없음');
});

test('④ tick — 원인 칸이 실린 메일 · 읽기 실패여도 보낸다 · trigger timer · 다시 보낼 때 다시 읽지 않는다', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2885t-'));
  fs.writeFileSync(path.join(cfg, 'bareos-jobs.json'), JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', bareosJob: 'pv-aaaa-vm-1', client: 'kr-fd', level: 'Incremental', enabled: true, directorId: 'D1', restores: [] },
    { id: 'j2', vcenterId: 'vcA', vmId: 'vcA:vm-2', vmName: 'db01', bareosJob: 'pv-aaaa-vm-2', client: 'kr-fd', level: 'Incremental', enabled: true, directorId: 'D2', restores: [] },
  ] }));
  const script = `
    import { mock } from 'node:test';
    globalThis.SENT = []; globalThis.FAILSEND = false; globalThis.READS = [];
    mock.module(${J('mail/service.js')}, { namedExports: { sendPortalMail: async (m) => { globalThis.SENT.push(m); return globalThis.FAILSEND ? { ok: false, reason: 'SMTP 오류' } : { ok: true }; } } });
    mock.module(${J('mail/settings.js')}, { namedExports: { load: () => ({ enabled: true, kinds: {} }) } });
    mock.module(${J('store.js')}, { namedExports: { store: { get: () => ({ source: 'live', vcenters: [{ id: 'vcA', name: 'VC-A' }] }) } } });
    mock.module(${J('bareos/service.js')}, { namedExports: {
      onDirector: async (dir, kind, args, o) => {
        globalThis.READS.push([dir, kind, o?.trigger, !!o?.signal, args.items.map((x) => x.jobid)]);
        if (dir === 'D2') throw new Error('엣지 응답 없음');
        return args.items.map((x) => ({ key: x.key, ok: true, firstError: ${JSON.stringify(SSL)} }));
      },
      isEdgeNode: () => false, isDemoActive: () => false,
    } });
    const reg = await import(${J('bareos/registry.js')});
    const n = await import(${J('bareos/notify.js')});
    const finish = (id, jobid) => reg.applyRunRow(id, { jobid, status: 'f', type: 'B', level: 'I', startedAt: null, endedAt: null, bytes: 0, files: 0, errors: 1 });
    const out = {};
    await n.tick();
    await new Promise((r) => setTimeout(r, 5));
    finish('j1', 501); finish('j2', 601);
    globalThis.FAILSEND = true; await n.tick();
    globalThis.FAILSEND = false; await n.tick();
    out.sent = globalThis.SENT.length;
    out.html = globalThis.SENT.at(-1).html;
    out.reads = globalThis.READS;
    out.cached = n.cachedCause('D1', 501, { jobName: 'pv-aaaa-vm-1' });
    out.otherJob = n.cachedCause('D1', 501, { jobName: 'pv-other' });
    out.missing = n.cachedCause('D2', 601, { jobName: 'pv-aaaa-vm-2' });
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.sent, 2, '발송 실패 뒤 다시 보낸다');
  assert.match(out.html, /web01[\s\S]*Could not fetch SSL Cert[\s\S]*→ FD 서버가 vCenter/);
  assert.match(out.html, /db01[\s\S]*못 읽음 — 엣지 응답 없음/, '읽기 실패여도 메일은 간다');
  const d1 = out.reads.filter((r) => r[0] === 'D1');
  assert.equal(d1.length, 1, '다시 보낼 때 읽어 둔 원인은 다시 묻지 않는다');
  assert.deepEqual(d1[0], ['D1', 'logs', 'timer', true, [501]], '묶음 로그 · 주기 작업(timer — 인증 정지된 Director 에 닿지 않는다) · 시한');
  assert.equal(out.reads.filter((r) => r[0] === 'D2').length, 1, '반증 M2: 못 읽은 것도 30분 안에는 다시 묻지 않는다(메일이 못 나가는 동안 매 분 세션을 열지 않게)');
  assert.equal(out.otherJob, null, '잡 이름이 다르면 쓰지 않는다');
  assert.deepEqual(out.cached, { line: 'LESANXMPNJ01-fd JobId 32: Fatal error: python3-fd-mod: Could not fetch SSL Cert from 192.168.52.221: [Errno 111] Connection refused' });
  assert.equal(out.missing, null);
  const st = JSON.parse(fs.readFileSync(path.join(cfg, 'bareos-mail-state.json'), 'utf8'));
  assert.ok(st.causes['D1:0:501'], '원인 기록은 상태 파일에(비밀 없음)');
});

test('⑤ 일일 요약 — 실패 메일이 읽어 둔 원인을 쓴다 · 없으면 예전 오류 문구', () => {
  const now = Date.UTC(2026, 10, 8, 0, 0);
  const set = { directors: [{ id: 'D1', name: '한국' }] };
  const job = (id, jobid, extra = {}) => ({ id, directorId: 'D1', vcenterId: 'vc-a', vmName: id, enabled: true, lastRun: { state: 'error', jobid, endedAt: now - 3600_000 }, lastError: { message: '포탈 기록 오류' }, restores: [], ...extra });
  const seen = [];
  const causeOf = (dir, jobid, o) => { seen.push([dir, jobid, o.epoch, o.jobName]); return dir === 'D1' && jobid === 1 ? { line: SSL } : dir === 'D1' && jobid === 2 ? { line: null } : null; };
  const d = DG.digestData([job('a', 1), job('b', 2), job('c', 3)], set, { D1: { ok: true } }, now, { causeOf });
  const msg = Object.fromEntries(d.fails.map((f) => [f.vmName, f.message]));
  assert.match(msg.a, /Could not fetch SSL Cert[\s\S]* → FD 서버가 vCenter/);
  assert.equal(msg.b, '오류 줄 없음(작업 로그)');
  assert.equal(msg.c, '포탈 기록 오류', '읽어 둔 원인이 없으면 예전 문구');
  assert.deepEqual(seen[0], ['D1', 1, 0, undefined], '세대 · 잡 이름을 넘긴다(대조는 cachedCause)');
  const old = DG.digestData([job('c', 3)], set, { D1: { ok: true } }, now);
  assert.equal(old.fails[0].message, '포탈 기록 오류', '인자를 주지 않으면 예전 그대로');
  // 보내는 쪽(computeAndSend)이 실패 메일의 기록을 넘긴다 — 순수 함수 시험만으로는 호출부가 빠져도 통과한다
  const strip = (f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const src = strip('bareos/digest.js');
  assert.match(src, /digestData\(listJobs\(\), loadSettings\(\), dirStatusNow\(\), now, \{ causeOf: cachedCause \}\)/);
  // 배선(순수 함수 시험이 닿지 않는 곳): 메일에 싣는 행만 읽는다(L2) · 설정 손상이면 묻지 않는다(L6) · 묶음 로그는 자르기 전 첫 오류(L3)

  const ns = strip('bareos/notify.js');
  assert.match(ns, /const shownRows = rows\.slice\(0, MAX_ROWS\);/);
  assert.match(ns, /await attachCauses\(shownRows,/);
  assert.match(ns, /if \(setErr\) \{ for \(const r of shownRows\) if \(r\.kind === 'backup'\) r\.causeMiss = 'Bareos 설정\(Director 등록부\)을 읽지 못했습니다'; \}/);
  const os_ = strip('bareos/ops.js');
  assert.match(os_, /jobLog\(s, it\.jobid, \{ maxBytes: 128 \* 1024, maxLines: 2000, firstErrorOf: firstErrorLine \}\)/);
  assert.match(os_, /firstError: log\.firstError \?\? null/);
});
