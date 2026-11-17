/**
 * svcFocusFullAudit61.test.js — 전체 점검 61회차(서비스 모니터링 svcmon · 서버 집중 모니터링 focusmon 2차) 확정분.
 *  F1 디스크 점검 결과 반영 도중 포탈이 다시 시작되면 상태 파일에 남은 'ingesting' 이 그 서버의 점검을 영원히 막았다
 *     (jobExpired 시한 없음 · 결과 받기 건너뜀 · 접수 'busy' — 48시간 뒤에도). 재시작 뒤에는 '실행 중' 으로 되돌리고, 반영 중에도 전체 시한(JOB_MAX_MS).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcfocus61-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.FOCUSMON_SSH_KEY = '';
after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const A = await import('../src/focusmon/audit/service.js');
const STATE = path.join(DIR, 'focusmon-audit.json');
// 기준 시각 — 실제 시각에서 정시로 떨어뜨려 고정(docs/rules/common.md)
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const tgt = (n) => ({ id: `fm-61aa00${n}${n}`, name: `s${n}`, host: `10.6.1.${n}`, port: 22, username: 'mon', agent: 'edge-61' });
const runResult = (runId) => ({ runId, result: { ok: true, kind: 'done', ran: true, out: ['##DA BEGIN x'], ready: [] } });
const settle = () => new Promise((r) => setTimeout(r, 200));

/** 엣지 작업 하나를 배달하고 결과를 올려 '반영 중' 이 파일에 쓰인 순간의 상태 파일을 돌려준다(앞 프로세스가 그 순간 끝났다고 본다). */
async function crashDuringIngest(t) {
  A._resetForTest(); try { fs.rmSync(STATE); } catch { /* 없음 */ }
  const mine = new Map([[t.id, t]]);
  assert.equal(A.requestAudit(t, { mode: 'run', now: T0 }).ok, true);
  const d = A.handleEdgeAudit('edge-61', mine, { active: [] }, T0 + 1000);
  assert.equal(d.jobs.length, 1);
  const runId = d.jobs[0].runId;
  A.handleEdgeAudit('edge-61', mine, { active: [], results: [runResult(runId)] }, T0 + 2000);
  const snap = fs.readFileSync(STATE, 'utf8'); // 묶음 끝의 한 번 쓰기 — 반영(DB await)은 아직
  assert.deepEqual(JSON.parse(snap).jobs.map((j) => j.state), ['ingesting'], '전제: 반영 중 상태가 파일에 쓰인다');
  await settle(); // 앞 프로세스의 반영 — 새 프로세스에는 없는 일이므로 파일을 그 순간으로 되돌린다
  A._resetForTest(); fs.writeFileSync(STATE, snap);
  return { runId, mine };
}

test('61회차 F1 ① 반영 도중 재시작 — 다시 온 결과를 반영한다(예전: 건너뛰고 ack 만 → 영원히 busy)', async () => {
  const t = tgt(1);
  const { runId, mine } = await crashDuringIngest(t);
  assert.notEqual(A.jobOf(t.id)?.state, 'ingesting', '재시작 뒤에는 반영 중이 아니다');
  // ack 를 받지 못한 엣지가 같은 결과를 다시 보낸다
  const r = A.handleEdgeAudit('edge-61', mine, { active: [], results: [runResult(runId)] }, T0 + 60_000);
  assert.deepEqual(r.ack, [runId]);
  await settle();
  assert.equal(A.jobOf(t.id), null, '반영이 끝나 작업이 빠진다');
  const rd = A.readinessOf(t.id);
  assert.ok(rd && rd.lastError == null, `결과가 반영돼 준비 상태가 남는다 — ${JSON.stringify(rd)}`);
});

test('61회차 F1 ② 결과가 다시 오지 않으면 보통 시한으로 lost — 같은 서버를 다시 접수할 수 있다', async () => {
  const t = tgt(2);
  await crashDuringIngest(t);
  // 다시 배달하지 않는다 — 엣지는 이미 실행을 끝냈다(다시 보내면 root 점검이 한 번 더 돈다)
  const again = A.handleEdgeAudit('edge-61', new Map([[t.id, t]]), { active: [] }, T0 + 2 * 60_000 + 5000);
  assert.deepEqual(again.jobs, [], '재시작 뒤 되돌린 작업을 다시 배달하지 않는다');
  const busy = A.requestAudit(t, { mode: 'check', now: T0 + 3 * 60_000 });
  assert.equal(busy.code, 'busy', '시한 전에는 기다린다(진행 중일 수 있다)');
  const later = A.requestAudit(t, { mode: 'check', now: T0 + 30 * 60_000 });
  assert.equal(later.ok, true, `엣지가 더 보고하지 않으면 시한(SEEN_TTL) 뒤 접수된다 — ${later.code}`);
  assert.equal(A.readinessOf(t.id)?.lastError?.kind, 'lost');
});

test('61회차 F1 ③ 반영 중(같은 프로세스)이어도 전체 시한(JOB_MAX_MS)은 있다 — jobExpired', () => {
  const j = { state: 'ingesting', node: 'edge-61', requestedAt: T0, deliveredAt: T0, seenAt: T0, deliveries: 1 };
  assert.equal(A.jobExpired(j, T0 + 60 * 60_000), false, '반영 중에는 보통 시한으로 지우지 않는다');
  assert.equal(A.jobExpired(j, T0 + A.JOB_MAX_MS + 1), true, '전체 시한을 넘기면 지운다(늦게 끝난 반영은 lost 기억으로 반영된다)');
});

test('61회차 F1 ④ lost 기억에 남은 반영 중 표지도 재시작 뒤 풀린다 — 늦게 온 결과를 받는다', async () => {
  const t = tgt(3);
  A._resetForTest(); try { fs.rmSync(STATE); } catch { /* 없음 */ }
  const runId = 'da-61ab61ab61ab';
  fs.writeFileSync(STATE, JSON.stringify({ v: 1, ready: {}, jobs: [], lost: { [runId]: { runId, tid: t.id, mode: 'run', node: 'edge-61', requestedAt: T0, lostAt: T0 + 1000, state: 'ingesting' } } }));
  const mine = new Map([[t.id, t]]);
  A.handleEdgeAudit('edge-61', mine, { active: [], results: [runResult(runId)] }, T0 + 5000);
  await settle();
  assert.ok(A.readinessOf(t.id), 'lost 기억의 늦은 결과가 반영된다(준비 상태가 생긴다)');
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(st.lost[runId], undefined, '반영한 lost 기억은 지운다');
});

/*
 * F2 성능점검 로그 현황(logStatus) — 한 파일의 stat 실패(끊긴 링크 · 권한)가 목록 전체를 비워 설정 화면이 '파일 0개 · 0.0 MB' 라고 했다(재현).
 *    그 파일만 뺀다(정리 · 보유 범위와 같다). 폴더 자체를 못 읽으면(ENOENT 밖) 0 이 아니라 filesUnreadable · null.
 */
test('61회차 F2 ① 끊긴 링크 하나가 로그 파일 목록 전체를 비우지 않는다', async () => {
  const L = await import('../src/svcmon/logsettings.js');
  const C = await import('../src/svcmon/csvlog.js');
  const dir = L.logDir(); fs.mkdirSync(dir, { recursive: true });
  for (const d of ['20261101', '20261102', '20261103']) fs.writeFileSync(path.join(dir, `results-${d}.csv`), 'x'.repeat(1000));
  fs.symlinkSync(path.join(dir, 'nowhere.csv'), path.join(dir, 'results-20261104.csv'));
  const s = C.logStatus();
  assert.equal(s.fileCount, 3);
  assert.equal(s.totalBytes, 3000);
  assert.equal(s.filesUnreadable, undefined);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

test('61회차 F2 ② 로그 폴더를 못 읽으면(권한 · 입출력) 0개가 아니라 못 읽음 · 화면 두 곳이 같은 판정', async () => {
  const L = await import('../src/svcmon/logsettings.js');
  const C = await import('../src/svcmon/csvlog.js');
  const dir = L.logDir();
  const real = fs.readdirSync;
  // root 로 도는 시험에서는 권한으로 막을 수 없다 — 그 폴더의 readdir 만 EACCES 로(csvlog 는 같은 fs 객체를 쓴다)
  fs.readdirSync = (p, ...a) => { if (path.resolve(String(p)) === path.resolve(dir)) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return real.call(fs, p, ...a); };
  try {
    const bad = C.logStatus();
    assert.equal(bad.filesUnreadable, true);
    assert.equal(bad.fileCount, null);
    assert.equal(bad.totalBytes, null);
  } finally { fs.readdirSync = real; }
  assert.equal(C.logStatus().filesUnreadable, undefined, '읽히면 표지가 없다');
  const strip = (await import('./_stripComments.js')).stripComments;
  for (const f of ['../../web/src/views/svcmon/LogSettingsTab.jsx', '../../web/src/views/SvcMonitor.jsx']) {
    const src = strip(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), f), 'utf8'));
    assert.match(src, /filesUnreadable \? '파일 목록을 읽지 못했습니다/, f);
  }
});

/*
 * F3 Monitoring 개요의 '만료 임박' 표(dash.js certs)가 낡음(stale) · 무보고 엣지(unknown) 행의 옛 'D-n' 을 지금 남은 일수처럼 실었다(재현).
 *    지금 결과(ok · warn · bad)만 — 느린 TOP(ok · warn) · 연속 실패(bad)와 같은 규칙. 그 행은 KPI 낡음 · 알 수 없음으로 센다.
 */
test('61회차 F3 만료 임박 표는 지금 결과만(낡음 · 무보고 엣지의 옛 D-n 을 싣지 않는다)', async () => {
  const D = await import('../src/svcmon/dash.js');
  const now = T0;
  const tg = (id, name, iv) => ({ id, name, path: 'A', host: 'h', enabled: true, tests: [{ id: `${id}x`, name: '인증서', type: 'cert', intervalSec: iv }] });
  const targets = [tg('t1', 'stale1', 86400), tg('t2', 'fresh1', 86400)];
  const results = new Map([
    ['t1x', { status: 'warn', reply: 'D-5', ms: 10, ts: now - 10 * 86_400_000 }],   // 10일 전 측정 → 낡음
    ['t2x', { status: 'warn', reply: 'D-7', ms: 10, ts: now - 3_600_000 }],
  ]);
  const edgeStates = [{ agent: 'e1', silent: true, items: [{ state: 'unknown', status: 'warn', reply: 'D-2', path: 'B', target: 'mail', test: '인증서', type: 'cert' }] },
    { agent: 'e2', silent: false, items: [{ state: 'bad', status: 'bad', reply: '만료됨 (3일 경과)', path: 'C', target: 'old', test: '인증서', type: 'cert' }] }];
  const r = D.buildDash({ targets, results, edgeStates, now });
  assert.deepEqual(r.certs.map((c) => [c.target, c.days]), [['old', -3], ['fresh1', 7]]);
  assert.equal(r.summary.stale, 1); assert.equal(r.summary.unknown, 1);
  const ra = await D.buildDashAsync({ targets, results, agents: ['e1', 'e2'], edgeItemsOf: (a) => edgeStates.find((x) => x.agent === a).items, now });
  assert.deepEqual(ra.certs, r.certs, '양보판도 같은 누산기');
});
