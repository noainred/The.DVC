/**
 * psInspectReview2964.test.js — PowerScale 장비 점검(v2.964) 반증 검토 결과 반영분 회귀.
 *
 *  F1  공유 토큰이 ' isi-direct '(앞뒤 공백)로 중앙 직접 장비 이력을 쓰지 못한다 — id 를 저장 키 모양으로 맞춘 뒤 소유권을 본다(실제 central 라우터)
 *  F8  같은 deviceId 원소를 반복해도 push 하나에 장비당 4건
 *  F9  미등록 id 는 받지 않는다(실제 장비 이력을 밀어내지 못한다) · 중앙 정리는 등록부 전부 기준(위임 장비 이력을 지우지 않는다)
 *  F7  시계 빠른 엣지의 재전송은 엣지 원본 시각으로 중복 판정
 *  F2  why 문구는 평탄화(capStr) — 소스 고정
 *  F3  정제가 빠진 필드를 0 · [] 로 채우지 않는다 → 확인 불가 · 정책 있는데 7일 보고서 0건은 확인 불가
 *  F4  8일 넘은 실행은 판정에 쓰지 않는다(확인 불가 + 사유 · 값은 참고) · 보고서 주차는 만든 주
 *  F5  법인판 Top 10 은 그 법인 장비만으로 다시 줄 세운다(corpFilterOf)
 *  F6  노드 통계는 질의 사이 실제로 양보 · 8일 넘는 창은 일 요약 · 잘리면 확인 불가
 *  F10 REST 점검이 장비 시한에 끊기면 남은 경로를 '조회 실패' 로 넘기지 않고 던진다(일부만)
 *  F11 이벤트 · SyncIQ 쪽 넘김이 남으면 실패 0 을 정상으로 단정하지 않는다
 *  F12 HealthCheck 는 체크리스트마다 가장 최근 평가만
 *  F13 · F14 회차 계획 — psInspect2964 ⑨ 에 있다
 *  F15 스냅샷 크기 못 읽은 행이 있으면 partial · 노드 수 모르는 장비는 따로 센다
 *  E1  엣지 점검 뒤 push 를 당긴다(훅) · E2 비관리자 판본의 사유 · 오류에서 IPv4 를 가린다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'psinspect-rev-'));
Object.assign(process.env, { CONFIG_DIR: TMP, CENTRAL_TOKEN: 'shared-review-token-2964', DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(TMP, 'storage-devices.json'), JSON.stringify({ version: 1, devices: [
  { id: 'isi-direct', type: 'isilon', name: 'direct-isi', host: '10.1.1.1', username: 'u', password: 'p', agent: '', enabled: true, datacenterId: 'A' },
  { id: 'isi-b', type: 'isilon', name: 'edgeb-isi', host: '10.2.2.2', username: 'u', password: 'p', agent: 'edgeB', enabled: true, datacenterId: 'B' },
] }));
let srv = null;
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const H = 3_600_000; const D = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const S = await import('../src/storage/inspect/store.js');
const F = await import('../src/storage/inspect/facts.js');
const J = await import('../src/storage/inspect/judge.js');
const EDGE = await import('../src/central/storageInspectEdge.js');
const SCH = await import('../src/storage/inspect/schedule.js');
const REP = await import('../src/storage/inspect/report.js');

async function central() {
  if (srv) return srv.base;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json({ limit: '20mb' })); app.use('/api/central', centralRouter);
  srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  srv.base = `http://127.0.0.1:${srv.address().port}/api/central`;
  return srv.base;
}
const post = async (body) => {
  const r = await fetch(`${await central()}/storage-data`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Central-Token': process.env.CENTRAL_TOKEN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('F1 · F8 · F9 — 실제 central 라우터: 공백 id 우회 막힘 · 장비당 상한 · 미등록 id 거절', async () => {
  const now = Date.now();
  S.recordRun('isi-direct', { at: now - H, method: 'ssh', facts: { health: { word: 'DOWN' } }, why: {}, errors: [] });
  for (const id of ['isi-direct', ' isi-direct ', 'isi-direct\t']) {
    const r = await post({ agent: 'edgeA', devices: [], inspectRuns: [{ deviceId: id, runs: [{ at: now, facts: { health: { word: 'OK' } } }] }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.inspectRuns.saved, 0, JSON.stringify(id));
    assert.equal(r.body.inspectRuns.notOwned, 1, JSON.stringify(id));
  }
  assert.deepEqual(S.runsOf('isi-direct').map((x) => x.facts.health.word), ['DOWN'], '중앙 직접 장비의 실제 결과가 가려지지 않는다');
  // F8 — 같은 id 원소 4개 × 4건 → 4건만
  const ents = []; for (let k = 0; k < 4; k += 1) ents.push({ deviceId: 'isi-b', runs: [0, 1, 2, 3].map((j) => ({ at: now - 1000 * (k * 4 + j + 1), facts: {} })) });
  const r2 = await post({ agent: 'edgeA', devices: [], inspectRuns: ents });
  assert.equal(r2.body.inspectRuns.saved, 4);
  assert.equal(r2.body.inspectRuns.dropped, 12);
  // F9 — 미등록 id
  const list = []; for (let i = 0; i < 50; i += 1) list.push({ deviceId: `fake-${i}`, runs: [{ at: now - 10, facts: {} }] });
  const r3 = await post({ agent: 'edgeA', devices: [], inspectRuns: list });
  assert.equal(r3.body.inspectRuns.unknownDevice, 50);
  assert.equal(S.runsOf('fake-0').length, 0);
  // 노드 표본 고리도 같은 정규화를 먼저 거친다(형제 경로)
  const rt = src('routes/central/storageRoutes.js');
  assert.match(rt, /let list = normDeviceIds\(req\.body\.nodeLoadSamples\.slice\(0, 500\)\)/);
  assert.match(rt, /let list = normDeviceIds\(req\.body\.inspectRuns\.slice\(0, 500\)\)/);
  // 중앙 정리 기준은 등록부 전부(엣지가 아니면) — 이 노드 몫만 넘기면 위임 장비 이력이 지워진다
  assert.match(src('storage/inspect/runner.js'), /pruneRuns\(new Set\(\(isEdge\(\) \? targets : listDevices\(\)\.filter\(\(d\) => d && d\.type === 'isilon'\)\)/);
});

test('F7 — 시계 빠른 엣지의 재전송은 중복', () => {
  const now = NOW;
  const a1 = EDGE.saveEdgeInspectRuns('edgeB', [{ deviceId: 'isi-x', runs: [{ at: now + 600_000, facts: {} }] }], { now });
  const a2 = EDGE.saveEdgeInspectRuns('edgeB', [{ deviceId: 'isi-x', runs: [{ at: now + 600_000, facts: {} }] }], { now: now + 300_000 });
  assert.equal(a1.saved, 1); assert.equal(a2.saved, 0); assert.equal(a2.duplicate, 1);
  assert.equal(S.runsOf('isi-x').length, 1);
});

test('F2 — why 는 capStr 로 평탄화(상주 이력이 엣지 본문 원문을 붙잡지 않게)', () => {
  const big = 'x'.repeat(2_000_000);
  const { why } = F.sanitizeFacts({ facts: {}, why: { health: big } });
  assert.equal(why.health.length, 160);
  assert.match(src('storage/inspect/facts.js'), /why\[k\] = capStr\(w\[k\], 160\)/);
  assert.doesNotMatch(src('storage/inspect/facts.js'), /w\[k\]\.slice\(0, 160\)/);
});

test('F3 — 빠진 필드를 0 · [] 로 채우지 않는다 → 확인 불가', () => {
  const cases = { nodeState: {}, snapshots: { count: 5 }, synciq: { policies: 3 }, drives: { total: 12, notHealthy: 'oops' }, psu: { total: 4 }, jobs: {}, healthcheck: { evaluations: 2 } };
  const { facts } = F.sanitizeFacts({ facts: { ...cases, events: { total: 7, severityKnown: true }, capacity: { pct: 40, totalBytes: 1e15 } } });
  for (const k of Object.keys(cases)) assert.equal(facts[k], undefined, k);
  assert.equal(facts.events.severityKnown, false, 'critical 개수가 없으면 심각도를 안다고 하지 않는다');
  const items = J.judgeDevice({ facts, why: {} });
  for (const id of ['node-state', 'snapshots', 'synciq', 'drives', 'psu', 'jobs', 'healthcheck', 'events']) assert.equal(items.find((i) => i.id === id).status, 'unknown', id);
  const sy = J.judgeDevice({ facts: { synciq: { policies: 3, reports: 0, failed: 0, failedPolicies: [] } }, why: {} }).find((i) => i.id === 'synciq');
  assert.equal(sy.status, 'unknown', '정책 3 · 7일 보고서 0건은 돌았는지 모른다');
});

test('F4 — 8일 넘은 실행은 판정에 쓰지 않는다 · 보고서 주차는 만든 주', () => {
  const run = { at: NOW - 60 * D, facts: { health: { word: 'OK' }, ntp: { servers: 2 } }, why: {} };
  const items = J.judgeDevice(run, null, null, { staleDays: 60 });
  const h = items.find((i) => i.id === 'cluster-health');
  assert.equal(h.status, 'unknown'); assert.equal(h.value, 'OK'); assert.match(h.why, /60일 전/);
  assert.equal(items.filter((i) => i.status === 'ok').length, 0);
  const dev = { id: 'd', name: 'd', corp: 'A', corpName: 'A', summary: J.summarize(items), items, run: { at: run.at, staleDays: 60 }, diff: { worse: [], better: [] } };
  const m = REP.buildReportModel({ devices: [dev] }, { rows: [], clusters: [] }, { now: NOW });
  assert.equal(m.week, REP.weekLabel(NOW));
  assert.match(REP.renderReportHtml(m), /60일 전 — 판정 안 함/);
  assert.match(src('storage/inspect/view.js'), /STALE_MS = 8 \* 86_400_000/);
});

test('F5 — 법인판 Top 10 은 그 법인 장비만으로 줄 세운다', () => {
  const devs = [{ id: 'a1', datacenterId: 'A' }, { id: 'b1', datacenterId: 'B' }, { id: 'n1' }];
  const fB = SCH.corpFilterOf('B', null, devs);
  assert.deepEqual(devs.map((d) => fB(d.id)), [false, true, false]);
  const fNone = SCH.corpFilterOf('', null, devs);
  assert.deepEqual(devs.map((d) => fNone(d.id)), [false, false, true], "빈 법인 키 = '법인 미지정' 판");
  assert.equal(SCH.corpFilterOf(null, null, devs), null);
  assert.match(src('storage/inspect/schedule.js'), /filter: corpFilterOf\(corp, filter\)/);
});

test('F6 — 질의 사이 실제 양보 · 30일은 일 요약 · 잘리면 확인 불가', () => {
  const p = src('storage/inspect/perf.js');
  assert.match(p, /createYielder/);
  assert.match(p, /kind: 'day'/);
  assert.match(p, /some\(\(r\) => r\.truncated\)/);
  assert.match(src('storage/inspect/view.js'), /run\?\.at \?\? Math\.floor\(now \/ 3_600_000\) \* 3_600_000/);
});

test('F10 — REST 시한이 끊으면 남은 경로를 넘기지 않고 던진다', () => {
  const r = src('storage/inspect/runner.js');
  const i = r.indexOf('const soft = async (paths)');
  const body = r.slice(i, r.indexOf('};', i));
  assert.match(body, /if \(signal\?\.aborted\) throw/);
});

test('F11 · F12 · F15 — 쪽 넘김 · 최근 평가 · 크기 못 읽은 스냅샷', () => {
  const ev = F.parseEventGroups(JSON.stringify({ eventgroups: [{ severity: 'warning' }], resume: 'abc' }));
  assert.equal(ev.partial, true);
  assert.equal(J.judgeDevice({ facts: { events: F.sanitizeFacts({ facts: { events: ev } }).facts.events }, why: {} }).find((x) => x.id === 'events').status, 'unknown');
  const sr = F.parseSyncReports(JSON.stringify({ reports: [{ start_time: Math.floor(NOW / 1000) - 3600, state: 'finished' }], resume: 'x' }), { now: NOW });
  assert.equal(sr.partial, true);
  const sy = { policies: 1, ...sr };
  assert.equal(J.judgeDevice({ facts: F.sanitizeFacts({ facts: { synciq: sy } }).facts, why: {} }).find((x) => x.id === 'synciq').status, 'unknown');
  const hc = F.parseHealthcheck(JSON.stringify({ evaluations: [
    { id: 'e1', checklist_id: 'basic', overall_status: 'FAIL', start_time: Math.floor((NOW - 180 * D) / 1000) },
    { id: 'e2', checklist_id: 'basic', overall_status: 'PASS', start_time: Math.floor((NOW - D) / 1000) },
    { id: 'e3', checklist_id: 'upgrade', overall_status: 'FAIL', start_time: Math.floor((NOW - 2 * D) / 1000) },
  ] }));
  assert.deepEqual(hc.failed.map((x) => x.id), ['e3'], '체크리스트마다 최근 평가 하나 — basic 은 어제 PASS');
  const sn = F.parseSnapshots(JSON.stringify({ snapshots: [{ size: 10 }, { name: 'no-size' }, { size: 5 }] }));
  assert.equal(sn.partial, true);
  assert.match(src('storage/inspect/view.js'), /nodesUnknown/);
});

test('E1 · E2 — 엣지 점검 뒤 push 훅 · 비관리자 사유의 IPv4 가림', () => {
  assert.match(src('storage/push.js'), /setAfterEdgeInspectHook\(\(\) => pushStorageNow\(\)\)/);
  assert.match(src('storage/inspect/runner.js'), /if \(isEdge\(\) && ok && _afterEdgeRun\)/);
  const v = src('storage/inspect/view.js');
  assert.match(v, /scrubMsg = \(s\) => \(admin \|\| typeof s !== 'string' \? s : scrub\(s\)\.replace\(/);
  assert.match(v, /errors: run\.errors\.map\(\(e\) => \(\{ \.\.\.e, error: scrubMsg\(e\.error\) \}\)\)/);
});
