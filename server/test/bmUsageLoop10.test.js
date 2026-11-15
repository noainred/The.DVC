/**
 * 베어메탈 사용률 점검 반복 10회차(마지막) — 회귀 고정.
 *  K1: 9회차 G1 이 프로세스 행의 comm 칸만 가려, 실제 파서 칸(name) 안 IPv4 가 비관리자에게 원문 — 스냅샷 · 집중 표본 · 기간 비교 procs 를 한 함수(bmProcScrub)로.
 *  L2: OS 경로가 없는 서버에도 스냅샷 실행 칸이 열리고 누르면 409 no-os-path — 표지 = 데모 · 역할 ∧ 실행과 같은 OS 경로 판정.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop10-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('K1 — 프로세스 행 가림 하나(scrubProcDeep): 집중 표본 꼴(세션 · 표본 · snap.cpuTop · ioTop) · 이름 안 주소 · 사용자 토큰 · 원본 그대로', async () => {
  const { scrubProcDeep, scrubProcRow } = await import('../src/routes/api/bmProcScrub.js');
  const fns = { scrub: (s) => s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'MASK'), tok: (v) => `tok-${v}` };
  const body = { ok: true, session: { id: 'f1', samples: [{ at: 1, snap: { cpuTop: [{ name: 'curl 10.1.2.3', cpuPct: 9 }], ioTop: [{ name: 'rsync 10.9.9.9', readBps: 1 }] } }] },
    sessions: [{ id: 'f1', last: { snap: { cpuTop: [{ name: 'x 10.0.0.1', user: 'svc' }] } } }] };
  const out = scrubProcDeep(body, fns);
  const j = JSON.stringify(out);
  assert.ok(!/10\.1\.2\.3|10\.9\.9\.9|10\.0\.0\.1/.test(j), `재현 r10 K1 — 집중 표본 이름 안 주소 · ${j}`);
  assert.equal(out.sessions[0].last.snap.cpuTop[0].user, 'tok-svc');
  assert.equal(body.session.samples[0].snap.cpuTop[0].name, 'curl 10.1.2.3', '원본 그대로');
  assert.deepEqual(scrubProcRow({ name: 'a 1.2.3.4', comm: 'b 5.6.7.8', user: 'u' }, fns), { name: 'a MASK', comm: 'b MASK', user: 'tok-u' });
  // 호출처 — 집중 응답 · 기간 비교 procs · 스냅샷이 같은 모듈(소스)
  const { stripComments } = await import('./_stripComments.js');
  const po = stripComments(fs.readFileSync(new URL('../src/routes/api/bmPerfOps.js', import.meta.url), 'utf8'));
  assert.match(po, /scrubProcDeep\(body0, PROC_FNS\)/);
  assert.match(po, /out\.procs && Array\.isArray\(out\.procs\.rows\)[\s\S]{0,160}scrubIp\(r\.name\)/);
  const bu = stripComments(fs.readFileSync(new URL('../src/routes/api/bmUsage.js', import.meta.url), 'utf8'));
  assert.match(bu, /scrubProcRow\(p, PROC_FNS\)/);
});

test('L2 — 스냅샷 실행 표지: OS 경로가 없으면 no-os-path(실행과 같은 판정) · 엣지 대행은 봉투 paths · 데모 · 역할이 먼저', async () => {
  const { snapRunGateOf } = await import('../src/routes/api/bmUsage.js');
  const { snapshotOsPathIssue } = await import('../src/bmusage/snapshot/run.js');
  const adm = { user: { username: 'adm', role: 'admin', scope: null } };
  const demo = { user: { username: 'thedvcdemp', role: 'admin', demoGuest: true } };
  assert.equal(snapshotOsPathIssue({ key: 'K' }), 'no-os-path'); assert.equal(snapshotOsPathIssue({ key: 'K', osHost: { host: ' ' } }), 'no-os-path');
  assert.equal(snapshotOsPathIssue({ key: 'K', osHost: { host: '10.0.0.5' } }), null);
  assert.deepEqual(snapRunGateOf(adm, null, { key: 'K', paths: ['idrac'] }, snapshotOsPathIssue), { ok: false, why: 'no-os-path' }, '재현 r10 L2 — 예전 ok(누르면 409)');
  assert.equal(snapRunGateOf(adm, null, { key: 'K', paths: ['os'], osHost: { host: 'h' } }, snapshotOsPathIssue).ok, true);
  assert.deepEqual(snapRunGateOf(adm, null, { key: 'K', paths: ['idrac'] }, snapshotOsPathIssue, 'edge'), { ok: false, why: 'no-os-path' });
  assert.equal(snapRunGateOf(adm, null, { key: 'K', paths: ['os', 'idrac'] }, snapshotOsPathIssue, 'edge').ok, true, '엣지 대행은 봉투 paths');
  assert.deepEqual(snapRunGateOf(demo, null, { key: 'K', paths: ['idrac'] }, snapshotOsPathIssue), { ok: false, why: 'demo' }, '데모 · 역할이 먼저');
  // 실행 경로도 같은 함수
  const { stripComments } = await import('./_stripComments.js');
  const run = stripComments(fs.readFileSync(new URL('../src/bmusage/snapshot/run.js', import.meta.url), 'utf8'));
  assert.match(run, /if \(snapshotOsPathIssue\(target\)\) return \{ ok: false, code: 'no-os-path'/);
});

test('K1b(10회차 재확인) — 집중 모니터링 원인 후보(summary.candidates · 함대 candidate)의 이름 안 주소도 가림(실제 summarizeFocus 출력)', async () => {
  const { summarizeFocus } = await import('../src/bmusage/focus/summary.js');
  const { scrubProcDeep } = await import('../src/routes/api/bmProcScrub.js');
  const samples = [1, 2, 3].map((i) => ({ at: i * 60_000, vals: {}, snap: { cpuTop: [{ name: '10.20.30.40:80', cpuPct: 50 }], ioTop: [{ name: '10.20.30.40:80', readBps: 1000, writeBps: 0 }] } }));
  const summary = summarizeFocus(samples, { hasOs: true });
  assert.ok((summary.candidates || []).some((c) => c.name === '10.20.30.40:80'), `전제 — 원인 후보는 표본 name 을 옮긴다 · ${JSON.stringify(summary.candidates)}`);
  const fns = { scrub: (s) => s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'MASK'), tok: (v) => `tok-${v}` };
  const body = { ok: true, session: { id: 'f1', summary, samples }, sessions: [{ id: 'f1', summary }] };
  const out = JSON.stringify(scrubProcDeep(body, fns));
  assert.ok(!out.includes('10.20.30.40'), `재현 r10 K1b — 원인 후보 이름 안 주소 · ${out.slice(0, 300)}`);
  // 함대 목록 candidate(문자열) — 라우트가 scrubIp(소스)
  const { stripComments } = await import('./_stripComments.js');
  const po = stripComments(fs.readFileSync(new URL('../src/routes/api/bmPerfOps.js', import.meta.url), 'utf8'));
  assert.match(po, /typeof s\.candidate === 'string' \? \{ \.\.\.s, candidate: scrubIp\(s\.candidate\) \}/);
});
