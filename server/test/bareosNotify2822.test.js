/**
 * test/bareosNotify2822.test.js — Bareos 백업 실패 메일(v2.822, bareos/notify.js).
 *  ① 모으기(순수): 끝난 실행 중 오류·경고만 · 취소·성공은 커서만 · 끝나지 않은 실행은 커서도 옮기지 않는다 · 처음 보는 대상은 since 이후만 ·
 *     데모 대상 제외 · 복원 오류 · jobid 커서(시각 아님)
 *  ② 본문(순수): 값 이스케이프 · 50행 상한 · 제목 개수
 *  ③ tick(자식 프로세스 — 메일·설정·store 모듈 대체): 발송 실패면 다음 틱 재시도 · 중복 없음 · 메일 꺼짐 동안의 실패는 켠 뒤 쏟지 않는다 · mock 인벤토리는 보내지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const J = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2822n-'));
process.env.CONFIG_DIR = tmp;
const { collectBareosFailures, renderBareosMail } = await import('../src/bareos/notify.js');

const SINCE = 1_000_000;
const job = (id, lastRun, extra = {}) => ({ id, vcenterId: 'vcA', vmId: `vcA:${id}`, vmName: `vm-${id}`, bareosJob: `pv-x-${id}`, client: 'kr-fd', lastRun, ...extra });
const run = (jobid, status, state, checkedAt = SINCE + 10) => ({ jobid, status, state, level: 'I', checkedAt });

test('① 오류·경고만 알리고, 끝난 실행이면 커서를 옮긴다 · 끝나지 않은 실행은 커서도 그대로', () => {
  const st = { since: SINCE, runs: { a: 10, b: 10, c: 10, d: 10, e: 10 }, restores: {} };
  const { rows, marks } = collectBareosFailures([
    job('a', run(11, 'f', 'error')),
    job('b', run(12, 'W', 'warning')),
    job('c', run(13, 'T', 'ok')),
    job('d', run(14, 'A', 'canceled')),
    job('e', run(15, 'R', 'running')),
    job('old', run(9, 'f', 'error'), {}),          // 커서 없음 + checkedAt > since → 처음 보는 대상의 새 실패
    job('stale', run(8, 'f', 'error', SINCE - 1)),  // 커서 없음 + since 이전 → 지난 실패(쏟지 않는다)
    job('demo', run(30, 'f', 'error'), { demo: true }),
  ], st);
  assert.deepEqual(rows.map((r) => [r.vmName, r.state]).sort(), [['vm-a', 'error'], ['vm-b', 'warning'], ['vm-old', 'error']]);
  assert.deepEqual(marks.runs, { a: 11, b: 12, c: 13, d: 14, old: 9, stale: 8 }, '성공·취소·지난 실패도 커서는 옮긴다 · 실행 중(e)·데모는 옮기지 않는다');
});

test('① 커서는 jobid 다 — 같은 jobid 를 다시 보거나 더 작은 jobid 는 알리지 않는다', () => {
  const st = { since: SINCE, runs: { a: 11 }, restores: {} };
  assert.equal(collectBareosFailures([job('a', run(11, 'f', 'error', SINCE + 999))], st).rows.length, 0);
  assert.equal(collectBareosFailures([job('a', run(7, 'f', 'error', SINCE + 999))], st).rows.length, 0);
  // 실행 중이던 같은 jobid 가 나중에 오류로 끝나면 알린다(실행 중에는 커서를 옮기지 않았으므로)
  const st2 = { since: SINCE, runs: { a: 10 }, restores: {} };
  assert.equal(collectBareosFailures([job('a', run(11, 'R', 'running'))], st2).rows.length, 0);
  assert.equal(collectBareosFailures([job('a', run(11, 'E', 'error'))], st2).rows.length, 1);
});

test('① 복원은 오류만 · 끝난 복원의 가장 큰 jobid 로 커서', () => {
  const st = { since: SINCE, runs: {}, restores: { a: 100 } };
  const restores = [
    { jobid: 103, status: 'R', state: 'running', at: SINCE + 5 },
    { jobid: 102, status: 'f', state: 'error', mode: 'newVm', at: SINCE + 4, checkedAt: SINCE + 6 },
    { jobid: 101, status: 'T', state: 'ok', at: SINCE + 3, checkedAt: SINCE + 6 },
    { jobid: 99, status: 'f', state: 'error', at: SINCE + 1 },
  ];
  const { rows, marks } = collectBareosFailures([job('a', null, { restores })], st);
  assert.deepEqual(rows.map((r) => [r.kind, r.jobid, r.mode]), [['restore', 102, 'newVm']]);
  assert.deepEqual(marks.restores, { a: 102 });
});

test('② 본문 — 값 이스케이프 · 50행 상한 · 제목에 실패·경고 개수', () => {
  const rows = Array.from({ length: 55 }, (_, i) => ({ kind: 'backup', state: i % 5 === 0 ? 'warning' : 'error', status: 'f', jobid: i + 1, at: SINCE, level: 'Full', jobName: 'pv-1', vmName: i === 0 ? '<b>evil</b>' : `vm${i}`, vcenterId: 'vcA', client: 'kr-fd' }));
  const m = renderBareosMail(rows, (id) => (id === 'vcA' ? 'VC-서울' : id));
  assert.match(m.subject, /^\[Bareos 백업\] 실패 44건 · 경고 11건 — <b>evil<\/b>, vm1, vm2 외 52$/);
  assert.doesNotMatch(m.html, /<b>evil/);
  assert.match(m.html, /&lt;b&gt;evil/);
  assert.match(m.html, /VC-서울/);
  assert.match(m.html, /그 밖에 5건/);
  assert.doesNotMatch(m.html, /https?:\/\//, '포탈 링크를 싣지 않는다');
});

test('③ tick — 발송 실패면 다음 틱 재시도 · 중복 없음 · 메일 꺼짐 동안의 실패는 켠 뒤 쏟지 않는다 · mock 이면 보내지 않는다', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2822t-'));
  fs.writeFileSync(path.join(cfg, 'bareos-jobs.json'), JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', bareosJob: 'pv-aaaa-vm-1', client: 'kr-fd', level: 'Incremental', enabled: true, restores: [] },
  ] }));
  const script = `
    import { mock } from 'node:test';
    globalThis.SENT = []; globalThis.MAIL = { enabled: true, kinds: {} }; globalThis.FAILSEND = false; globalThis.SRCKIND = 'live';
    mock.module(${J('mail/service.js')}, { namedExports: { sendPortalMail: async (m) => { globalThis.SENT.push(m); return globalThis.FAILSEND ? { ok: false, reason: 'SMTP 오류' } : { ok: true }; } } });
    mock.module(${J('mail/settings.js')}, { namedExports: { load: () => globalThis.MAIL } });
    mock.module(${J('store.js')}, { namedExports: { store: { get: () => ({ source: globalThis.SRCKIND, vcenters: [{ id: 'vcA', name: 'VC-A' }] }) } } });
    const reg = await import(${J('bareos/registry.js')});
    const n = await import(${J('bareos/notify.js')});
    const finish = (jobid, status) => reg.applyRunRow('j1', { jobid, status, type: 'B', level: 'I', startedAt: null, endedAt: null, bytes: 0, files: 0, errors: 1 });
    const out = {};
    await n.tick();                                   // 처음 — 지금부터 센다
    await new Promise((r) => setTimeout(r, 5));
    finish(501, 'f');
    globalThis.FAILSEND = true; await n.tick();
    out.afterFail = [globalThis.SENT.length, n.bareosMailStatus().sent];
    globalThis.FAILSEND = false; await n.tick();
    out.afterOk = [globalThis.SENT.length, globalThis.SENT.at(-1).kind, globalThis.SENT.at(-1).subject];
    await n.tick();
    out.noDup = globalThis.SENT.length;
    globalThis.MAIL = { enabled: false }; finish(502, 'E'); await n.tick();
    globalThis.MAIL = { enabled: true, kinds: {} }; await n.tick();
    out.offThenOn = globalThis.SENT.length;
    globalThis.MAIL = { enabled: true, kinds: { 'bareos-backup': { enabled: false } } }; finish(503, 'f'); await n.tick();
    globalThis.MAIL = { enabled: true, kinds: {} }; await n.tick();
    out.kindOff = globalThis.SENT.length;
    globalThis.SRCKIND = 'mock'; finish(504, 'f'); await n.tick();
    out.mock = globalThis.SENT.length;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.deepEqual(out.afterFail, [1, false], '발송 실패 — 기록');
  assert.equal(out.afterOk[0], 2, '다음 틱에 같은 실패를 다시 보낸다');
  assert.equal(out.afterOk[1], 'bareos-backup');
  assert.match(out.afterOk[2], /^\[Bareos 백업\] 실패 1건 — web01$/);
  assert.equal(out.noDup, 2, '보낸 실패는 다시 보내지 않는다');
  assert.equal(out.offThenOn, 2, '메일이 꺼져 있던 동안의 실패는 켠 뒤 쏟지 않는다');
  assert.equal(out.kindOff, 2, '이 종류만 꺼져 있어도 같다');
  assert.equal(out.mock, 2, 'mock 인벤토리에서는 보내지 않는다');
  assert.ok(fs.existsSync(path.join(cfg, 'bareos-mail-state.json')));
  assert.equal(fs.statSync(path.join(cfg, 'bareos-mail-state.json')).mode & 0o777, 0o600);
});

test('등록 — 메일 종류·중앙 전용 기동·엣지 스윕 제외 사유', async () => {
  const { KINDS } = await import('../src/mail/kinds.js');
  const k = KINDS.find((x) => x.id === 'bareos-backup');
  assert.ok(k && k.label && k.desc);
  const idx = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  assert.match(idx, /startBareosMail,/);
  const nf = fs.readFileSync(path.join(SRC, 'bareos/notify.js'), 'utf8');
  assert.match(nf, /if \(_timer \|\| isEdge\(\)\) return;/, '엣지는 기동하지 않는다');
});

test('C2-2(v2.822.3): 포탈 실행이 실패로 끝날 때 더 큰 jobid(스케줄 실행)가 lastRun 이어도 알린다 · 끝나는 순서가 바뀌어도 · 중복 없음', () => {
  const fin = (jobid, status, state) => ({ jobid, status, state, level: 'I', checkedAt: SINCE + 50 });
  // ① 포탈 실행 590 이 먼저 실패로 끝남(lastRun 은 대기 중인 600) — finishedRuns 에 590
  let st = { since: SINCE, runs: { a: 500 }, seen: {}, restores: {} };
  const a1 = job('a', run(600, 'C', 'queued'), { finishedRuns: [fin(590, 'f', 'error')] });
  let out = collectBareosFailures([a1], st);
  assert.deepEqual(out.rows.map((r) => r.jobid), [590]);
  st = { ...st, runs: { ...st.runs, ...out.marks.runs }, seen: { ...out.marks.seen } };
  // 600 이 성공으로 끝남 — 새 알림 없음 · 590 을 다시 알리지 않는다
  out = collectBareosFailures([job('a', run(600, 'T', 'ok'), { finishedRuns: [fin(590, 'f', 'error'), fin(600, 'T', 'ok')] })], st);
  assert.equal(out.rows.length, 0);
  // ② 순서 반대 — 스케줄 실행 600 이 먼저 끝나고 포탈 실행 590 은 아직 진행 중(pending) → 커서는 590 앞에서 멈춘다
  st = { since: SINCE, runs: { b: 500 }, seen: {}, restores: {} };
  out = collectBareosFailures([job('b', run(600, 'T', 'ok'), { pending: { jobid: 590 }, finishedRuns: [fin(600, 'T', 'ok')] })], st);
  assert.equal(out.rows.length, 0);
  assert.equal(out.marks.runs.b, 589, '진행 중인 포탈 실행 앞에서 멈춘다');
  assert.deepEqual(out.marks.seen.b, [600]);
  st = { ...st, runs: { b: 589 }, seen: { b: [600] } };
  // 그 뒤 590 이 실패로 끝남 — 커서(589)보다 크므로 알린다 · 600 은 seen 이라 다시 알리지 않는다
  out = collectBareosFailures([job('b', run(600, 'T', 'ok'), { finishedRuns: [fin(590, 'E', 'error'), fin(600, 'T', 'ok')] })], st);
  assert.deepEqual(out.rows.map((r) => r.jobid), [590]);
  assert.equal(out.marks.runs.b, 590);
  assert.deepEqual(out.marks.seen.b, [600], '600 은 커서보다 커도 seen 이라 다시 알리지 않는다');
  assert.equal(collectBareosFailures([job('b', run(600, 'T', 'ok'), { finishedRuns: [fin(590, 'E', 'error'), fin(600, 'T', 'ok')] })], { ...st, runs: { b: 590 }, seen: { b: [600] } }).rows.length, 0, '다음 틱에 중복 없음');
});
