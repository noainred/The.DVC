/**
 * psInspect2963.test.js — PowerScale 법인별 장비 점검 · 주간 보고(v2.963 · 설계 docs/design/powerscale-inspection/README.md · 사용자 선택 1차 + 2차).
 *
 * 고정하는 것:
 *  ① 항목표 — 20개 · 구분 5 · 근거 번호가 참고 자료 표에 있다 · 조치 문구가 전 항목에 있다 · 백틱 없음 · 판정하지 않는 CPU 는 항목이 아니다
 *  ② 파서 — sysctl 그룹 · 드라이브(JSON · REST nodes · 텍스트) · 부트 미러 · 전원(텍스트 · REST) · 배터리 · 포트 · HealthCheck · NTP · VHS · 스냅샷(쪽 넘김 = 일부) ·
 *       SyncIQ 7일 · 이벤트 심각도 · 잡 · 앞 잡문자 있는 JSON · 모양을 모르면 null(정상으로 칠하지 않는다) · 스냅샷 재사용(SSH · REST)
 *  ③ 정제 — 아는 키만 · 문자열 · 목록 상한 · 객체가 아니면 버린다(엣지 → 중앙 화이트리스트)
 *  ④ 판정 — 기준(80 · 90 · 10 · 90 · 1.5)대로 · 확인 불가는 정상이 아니다(종합 · 개수) · 점검 전 장비는 장비 항목이 전부 확인 불가 · 노드 1대는 편중 해당 없음
 *  ⑤ 7일 통계 · Top 10 — 부분 합(In 만 있는 칸) 제외 · 가중 평균 · 편중 배수 · 순위 · 비중 · 클러스터 분포
 *  ⑥ 이력 — 같은 (장비, at) 한 번 · 최근 12회 · 저장 → 다시 읽기 · 손상 파일 보존
 *  ⑦ 실행기 — 세션 예산 < 장비 시한 · 명령은 조회만(설정 변경 낱말 없음 · 사용자 입력 자리 없음) · 실패 사유 분류 · 데모 합성
 *  ⑧ 엣지 → 중앙 — 수신 정제 · 중복 · 상한 · ack · storage-data 가 같은 소유권 필터를 지난다 · storage-config 가 inspectNow 를 싣는다 · push 가 확인을 읽는다
 *  ⑨ 회차 — 주간 회차 시각(포탈 시각) · init · go · missed(down · late) · rebase · 설정 정규화(요일 · 시각 · 메일 · 법인판 · 기준 범위)
 *  ⑩ 보고서 — 이상/주의 · 확인 불가를 나눈다 · HTML 은 전부 이스케이프 · 백틱 없음 · CSV 수식 가드 · BOM
 *  ⑪ 실제 api — 조회 admin · operator 200 · viewer 403 · 범위 계정 403 · 장비 404 · 지금 점검 admin 202 / operator 403 · 설정 400 · 비관리자 메일 가림 · CSV data.csv
 *  ⑫ 등록 — 도구 키 · 카탈로그 · 메일 종류 · 엣지 로그 상태 · 상태 파일 이름
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import express from 'express';
import { centralSource } from './_centralSource.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'psinspect2963-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL; delete process.env.CENTRAL_TOKEN;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const H = 3_600_000; const D = 24 * H;
const NOW = Math.floor(Date.now() / H) * H; // 정시 경계(docs/rules/common.md)
const CAT = await import('../src/storage/inspect/catalog.js');
const F = await import('../src/storage/inspect/facts.js');
const J = await import('../src/storage/inspect/judge.js');
const P = await import('../src/storage/inspect/perf.js');
const S = await import('../src/storage/inspect/store.js');
const RUN = await import('../src/storage/inspect/runner.js');
const DEMO = await import('../src/storage/inspect/demo.js');
const SCH = await import('../src/storage/inspect/schedule.js');
const REP = await import('../src/storage/inspect/report.js');
const EDGE = await import('../src/central/storageInspectEdge.js');
const CR = await import('../src/util/centralReply.js');
const REG = await import('../src/storage/registry.js');
const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
const { RUNTIME_STATE_NAMES } = await import('../src/backup/service.js');
const { api } = await import('../src/routes/api.js');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function call(urlPath, { user = { username: 'root', role: 'admin', scope: {} }, method = 'GET', body = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, body: j, text };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

test('① 항목표 — 20개 · 구분 5 · 근거 번호 · 조치 · 백틱 없음', () => {
  assert.equal(CAT.ITEMS.length, 20);
  assert.equal(new Set(CAT.ITEMS.map((i) => i.id)).size, 20);
  assert.deepEqual(CAT.ITEMS.map((i) => i.no), Array.from({ length: 20 }, (_, i) => i + 1));
  const groups = new Set(CAT.GROUPS.map((g) => g.id));
  assert.equal(groups.size, 5);
  const refNos = new Set(CAT.REFS.map((r) => r.n));
  assert.equal(CAT.REFS.length, 22);
  for (const i of CAT.ITEMS) {
    assert.ok(groups.has(i.group), i.id);
    assert.ok(i.refs.length && i.refs.every((n) => refNos.has(n)), `근거 번호가 표에 없다: ${i.id}`);
    assert.ok(CAT.ACTIONS[i.id], `조치 문구 없음: ${i.id}`);
  }
  for (const r of CAT.REVIEW_ITEMS) assert.ok(r.refs.every((n) => refNos.has(n)), r.id);
  for (const r of CAT.REFS) assert.ok(CAT.REF_LEVEL_KO[r.level], `확인 수준 문구 없음: ${r.n}`);
  // 기준값은 출처 숫자 그대로(편중만 포탈 기준)
  assert.deepEqual([CAT.THRESHOLD_DEFAULTS.capWarnPct, CAT.THRESHOLD_DEFAULTS.capBadPct, CAT.THRESHOLD_DEFAULTS.vhsMinPct, CAT.THRESHOLD_DEFAULTS.snapMaxPct, CAT.THRESHOLD_DEFAULTS.busyMaxPct], [80, 90, 10, 10, 90]);
  assert.ok(!CAT.ITEMS.some((i) => /cpu/i.test(i.id)), 'CPU 는 판정 항목이 아니다(Dell 기준 숫자 없음)');
  for (const f of ['storage/inspect/catalog.js', 'storage/inspect/judge.js', 'storage/inspect/report.js']) {
    const strs = src(f).match(/'[^'\n]*'/g) || [];
    assert.ok(!strs.some((x) => x.includes('`')), `${f}: 화면 문구에 백틱`);
  }
});

test('② 파서 — 모양을 알아보면 값, 모르면 null', () => {
  assert.deepEqual(F.parseGroup('efs.gmp.group: <2,272>: { 1-3:0-14, 4:0-13, down: 5, smb: 1-4, nfs: 1-4 }', 5), { inGroup: 4, total: 5, down: [5] });
  assert.deepEqual(F.parseGroup('efs.gmp.group: <1,9>: { 1-6:0-35, smb: 1-6 }', 6), { inGroup: 6, total: 6, down: [] });
  assert.equal(F.parseGroup('sysctl: unknown oid', 6), null);
  // 드라이브 — JSON 배열 · REST nodes · 텍스트
  const dj = F.parseDrives(JSON.stringify([{ lnn: 1, baynum: 1, ui_state: 'HEALTHY' }, { lnn: 1, baynum: 2, ui_state: 'L3' }, { lnn: 5, baynum: 7, ui_state: 'SMARTFAIL' }, { lnn: 2, baynum: 3, ui_state: 'EMPTY' }]));
  assert.deepEqual(dj, { total: 3, notHealthy: [{ lnn: 5, bay: '7', state: 'SMARTFAIL' }] });
  assert.equal(F.parseDrives({ nodes: [{ lnn: 2, drives: [{ baynum: 1, ui_state: 'healthy' }, { baynum: 4, ui_state: 'REPLACE' }] }] }).notHealthy[0].state, 'REPLACE');
  assert.equal(F.parseDrives('[]'), null, '상태 필드를 하나도 못 보면 null');
  assert.deepEqual(F.parseDrivesText('Lnn  Location  Device    Lnum  State   Serial   Sled\n1    Bay  1    /dev/da1  11   HEALTHY  S1  N/A\n5    Bay  7    /dev/da7  5    SMARTFAIL S2 N/A'), { total: 2, notHealthy: [{ lnn: 5, bay: 'Bay 7', state: 'SMARTFAIL' }] });
  assert.equal(F.parseDrivesText('Usage: isi devices'), null);
  // 부트 미러 · 전원(텍스트 — isi_for_array 접두)
  assert.deepEqual(F.parseBootMirror('c1-1: mirror/root0  COMPLETE  ad4s1\nc1-2: mirror/root0  DEGRADED  ad6s1'), { total: 2, bad: [2] });
  assert.equal(F.parseBootMirror('gmirror: command not found'), null);
  const psu = F.parsePsuText('clu-1: Power Supplies OK\nclu-1: PS1 : Good\nclu-1: PS2 : Failed\nclu-2: Power Supplies OK\nclu-2: PS1 : Good');
  assert.deepEqual(psu, { total: 3, bad: [{ lnn: 1, text: 'PS2 : Failed' }] });
  assert.equal(F.parsePsuText('nothing here'), null);
  assert.equal(F.parseRestPsu({ nodes: [{ lnn: 1, status: { powersupplies: { supplies: [{ name: 'PS0', good: true }, { name: 'PS1', good: false, status: 'failed' }] } } }] }).bad.length, 1);
  // 배터리 · 포트 · HealthCheck · NTP · VHS
  assert.equal(F.parseBatteries([{ lnn: 1, status1: 'Good', status2: 'Good' }, { lnn: 2, status1: 'Failed' }, { lnn: 3, present: false }]).bad[0].lnn, 2);
  const nif = F.parseIfaces({ interfaces: [{ lnn: 1, name: 'ext-1', status: 'up', ip_addrs: ['10.0.0.1'] }, { lnn: 2, name: 'ext-1', status: 'no_carrier', ip_addrs: ['10.0.0.2'] }, { lnn: 2, name: 'ext-2', status: 'down', ip_addrs: [] }] });
  assert.deepEqual(nif, { configured: 2, down: [{ lnn: 2, name: 'ext-1', status: 'no_carrier' }] });
  const hc = F.parseHealthcheck([{ id: 'e1', checklist_id: 'basic', overall_status: 'PASS', start_time: 1_700_000_000 }, { id: 'e2', checklist_id: 'nfs', overall_status: 'FAIL' }]);
  assert.equal(hc.evaluations, 2); assert.equal(hc.failed[0].checklist, 'nfs'); assert.equal(hc.lastAt, 1_700_000_000_000);
  assert.deepEqual(F.parseNtp({ servers: [{ name: 'a' }, { name: 'b' }] }), { servers: 2 });
  assert.deepEqual(F.parseVhsSettings({ settings: { virtual_hot_spare_limit_percent: 0, virtual_hot_spare_limit_drives: 2 } }), { enabled: true, pct: 0, drives: 2, source: 'settings' });
  assert.equal(F.parseVhsSettings({ settings: { spillover_enabled: true } }), null);
  // 스냅샷 · SyncIQ · 이벤트 · 잡
  const sn = F.parseSnapshots({ snapshots: [{ size: 100 }, { size: 300 }], resume: 'abc' });
  assert.deepEqual(sn, { count: 2, usedBytes: 400, largestBytes: 300, partial: true });
  const sr = F.parseSyncReports({ reports: [{ start_time: (NOW - D) / 1000, state: 'finished', policy_name: 'p1' }, { start_time: (NOW - 2 * D) / 1000, state: 'failed', policy_name: 'p2' }, { start_time: (NOW - 9 * D) / 1000, state: 'failed', policy_name: 'old' }] }, { now: NOW });
  assert.deepEqual(sr, { reports: 2, failed: 1, failedPolicies: ['p2'], partial: false });
  const ev = F.parseEventGroups({ eventgroups: [{ severity: 'critical' }, { severity: 'emergency' }, { severity: 'warning' }, { severity: 'critical', resolved: true }] });
  assert.deepEqual(ev, { total: 3, critical: 2, warning: 1, severityKnown: true, source: 'event-groups', partial: false });
  const jb = F.parseJobs({ jobs: [{ type: 'FlexProtect', state: 'running', progress: '40%' }, { type: 'MultiScan', state: 'failed' }] });
  assert.equal(jb.failed[0].name, 'MultiScan'); assert.equal(jb.running[0].name, 'FlexProtect');
  assert.deepEqual(F.jsonOf('Warning: something\n[{"a":1}]'), [{ a: 1 }]);
  assert.equal(F.jsonOf('not json at all'), null);
  // 스냅샷 재사용 — SSH(isi status) · REST(노드 상태로 판단)
  const ssh = F.factsFromSnapshot({ version: '9.5.0.8', nodes: { count: 4, list: [{ id: 1, health: 'ok' }, { id: 2, health: '-a--' }] }, capacity: { pct: 81, totalBytes: 1000 },
    alerts: { unresolved: 2 }, pools: [{ name: 'h500', pct: 86 }], extra: { collectMethod: 'ssh', clusterHealth: 'attention', vhsBytes: 100, jobs: { running: [{ job: 'FlexProtect[9]', phase: '2/6' }], paused: [], failed: [] } } });
  assert.equal(ssh.facts.health.word, 'ATTENTION'); assert.equal(ssh.facts.events.critical, 2); assert.equal(ssh.facts.vhs.pct, 10);
  assert.equal(ssh.facts.nodeState.bad[0].lnn, 2); assert.equal(ssh.facts.jobs.running[0].name, 'FlexProtect[9]');
  const rest = F.factsFromSnapshot({ nodes: { count: 2, list: [{ id: 1, health: 'ok' }, { id: 2, health: 'ok' }] }, alerts: { unresolved: 3 }, capacity: { pct: 40, totalBytes: 10 } });
  assert.deepEqual(rest.facts.health, { word: 'OK', derived: true });
  assert.equal(rest.facts.events.severityKnown, false);
  assert.ok(F.factsFromSnapshot(null).why.capacity, '스냅샷이 없으면 사유');
});

test('③ 정제 — 아는 키만 · 상한 · 객체가 아니면 버린다', () => {
  const big = 'x'.repeat(500);
  const s = F.sanitizeFacts({ facts: { evil: { a: 1 }, version: big, group: { inGroup: '4', total: 5, down: Array.from({ length: 100 }, (_, i) => i) }, drives: 'oops',
    psu: { total: 2, bad: [{ lnn: 1, text: big }] }, pools: Array.from({ length: 50 }, () => ({ name: big, pct: '50' })) }, why: { group: big, evil: 'x' } });
  assert.ok(!('evil' in s.facts)); assert.ok(!('drives' in s.facts));
  assert.equal(s.facts.version.length, 40); assert.equal(s.facts.group.inGroup, 4); assert.equal(s.facts.group.down.length, 64);
  assert.equal(s.facts.psu.bad[0].text.length, 80); assert.equal(s.facts.pools.length, 32); assert.equal(s.facts.pools[0].pct, 50);
  assert.equal(s.why.group.length, 160); assert.ok(!('evil' in s.why));
  assert.deepEqual(F.sanitizeFacts(null), { facts: {}, why: {} });
});

test('④ 판정 — 기준대로 · 확인 불가는 정상이 아니다', () => {
  const run = { facts: { health: { word: 'OK' }, group: { inGroup: 4, total: 4, down: [] }, events: { total: 0, critical: 0, warning: 0, severityKnown: true },
    nodeState: { total: 4, bad: [], unknown: 0 }, drives: { total: 96, notHealthy: [] }, bootMirror: { total: 4, bad: [] }, psu: { total: 8, bad: [] }, battery: { total: 4, bad: [] },
    ifaces: { configured: 8, down: [] }, healthcheck: { evaluations: 3, failed: [] }, ntp: { servers: 1 }, capacity: { pct: 79.9, totalBytes: 1000 }, pools: [{ name: 'a', pct: 50 }],
    vhs: { enabled: true, pct: 10 }, snapshots: { count: 3, usedBytes: 100, largestBytes: 10 }, jobs: { failed: [], running: [] }, synciq: { policies: 2, reports: 5, failed: 0 } }, why: {} };
  const perf = { samples: 100, nodes: [{ lnn: 1, busyAvg: 50, busyMax: 95 }], skew: { nodes: 4, ratio: 1.4, lnn: 1 } };
  const all = J.judgeDevice(run, perf);
  assert.deepEqual(J.summarize(all), { ok: 20, warn: 0, bad: 0, unknown: 0, na: 0, total: 20, overall: 'ok' });
  const st = (r, p = perf) => Object.fromEntries(J.judgeDevice(r, p).map((i) => [i.id, i.status]));
  const f = run.facts;
  assert.equal(st({ facts: { ...f, capacity: { pct: 80, totalBytes: 1000 } } }).capacity, 'warn');
  assert.equal(st({ facts: { ...f, capacity: { pct: 90, totalBytes: 1000 } } }).capacity, 'bad');
  assert.equal(st({ facts: { ...f, snapshots: { count: 1, usedBytes: 101, largestBytes: 1 } } }).snapshots, 'warn');
  assert.equal(st({ facts: { ...f, snapshots: { count: 1, usedBytes: 50, largestBytes: 1, partial: true } } }).snapshots, 'unknown', '일부만 센 합이 기준 아래면 단정하지 않는다');
  assert.equal(st({ facts: { ...f, drives: { total: 96, notHealthy: [{ lnn: 5, bay: '7', state: 'SMARTFAIL' }] } } }).drives, 'bad');
  assert.equal(st({ facts: { ...f, group: { inGroup: 3, total: 4, down: [4] } } }).group, 'bad');
  assert.equal(st({ facts: { ...f, events: { total: 2, critical: null, warning: null, severityKnown: false } } }).events, 'unknown');
  assert.equal(st({ facts: { ...f, jobs: { failed: [], running: [{ name: 'FlexProtect[1]', progress: '62%' }] } } }).reprotect, 'warn');
  assert.equal(st({ facts: { ...f, synciq: { policies: 0, reports: 0, failed: 0 } } }).synciq, 'na');
  assert.equal(st({ facts: { ...f, vhs: { enabled: true, pct: 5 } } }).vhs, 'warn');
  assert.equal(st(run, { samples: 10, nodes: [{ lnn: 1, busyAvg: 90 }], skew: { nodes: 4, ratio: 1.5, lnn: 2 } })['disk-busy'], 'warn');
  assert.equal(st(run, { samples: 10, nodes: [{ lnn: 1, busyAvg: 10 }], skew: { nodes: 4, ratio: 1.5, lnn: 2 } })['node-skew'], 'warn');
  assert.equal(st(run, { samples: 10, nodes: [], skew: { nodes: 1, ratio: 1, lnn: 1 } })['node-skew'], 'na');
  assert.equal(st(run, { samples: 0, nodes: [] })['disk-busy'], 'unknown');
  // 못 읽음 — 사유와 함께 확인 불가 · 종합은 정상 + 확인 불가 = unknown
  const part = J.judgeDevice({ facts: { ...f, ntp: undefined }, why: { ntp: '권한 없음' } }, perf);
  const ntp = part.find((i) => i.id === 'ntp');
  assert.equal(ntp.status, 'unknown'); assert.equal(ntp.why, '권한 없음');
  assert.equal(J.summarize(part).overall, 'unknown'); assert.equal(J.summarize(part).ok, 19);
  // 점검 전 장비 — 장비 항목은 전부 확인 불가(포탈 표본 항목만 판정)
  const none = J.judgeDevice(null, perf);
  assert.equal(none.filter((i) => i.status === 'unknown').length, 18);
  // 기준 정규화 — 범위 밖은 기본값 · warn ≥ bad 면 고친다
  assert.deepEqual([J.thresholdsOf({ capWarnPct: 95, capBadPct: 90 }).capWarnPct, J.thresholdsOf({ skewFactor: 99 }).skewFactor], [80, 1.5]);
  // 지난번 대비
  const d = J.diffItems([{ id: 'a', label: 'A', status: 'bad' }, { id: 'b', label: 'B', status: 'ok' }], [{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }]);
  assert.deepEqual([d.worse.map((x) => x.id), d.better.map((x) => x.id)], [['a'], ['b']]);
});

test('⑤ 7일 통계 · Top 10 — 부분 합 제외 · 가중 평균 · 편중 · 비중', () => {
  const a = P.aggregateNodeRows([{ node: 1, v: { in: 10, out: 5 }, n: { in: 2, out: 2 }, mx: { in: 20, out: 9 } }, { node: 1, v: { in: 20, out: null }, n: { in: 1, out: 0 } }, { node: 2, v: { in: 1, out: 1 }, n: { in: 4, out: 4 } }], ['in', 'out']);
  assert.deepEqual(a.get(1), { avg: 15, max: 29, n: 2 }, 'In 만 있는 칸은 더하지 않는다');
  assert.equal(a.get(2).max, null);
  assert.deepEqual(P.skewOf([{ lnn: 1, value: 10 }, { lnn: 2, value: 2 }, { lnn: 3, value: null }]), { nodes: 2, mean: 6, lnn: 1, ratio: 1.7, value: 10 });
  assert.equal(P.skewOf([]).ratio, null);
  const t = P.topNodes([{ deviceId: 'a', perf: { nodes: [{ lnn: 1, ops: 100 }, { lnn: 2, ops: 300 }, { lnn: 3, ops: null }] } }, { deviceId: 'b', perf: { nodes: [{ lnn: 1, ops: 200 }] } }, { deviceId: 'c', perf: { nodes: [] } }], { limit: 2 });
  assert.deepEqual(t.rows.map((r) => [r.deviceId, r.lnn, r.ratio, r.share]), [['a', 2, 1.5, 75], ['b', 1, 1, 100]]);
  assert.equal(t.nodesTotal, 3); assert.equal(t.topShare, 83.3);
  assert.deepEqual(t.clusters.map((c) => [c.deviceId, c.skewed]), [['a', true], ['b', false]]);
});

test('⑥ 이력 — 중복 · 상한 · 저장/다시 읽기 · 손상 보존', () => {
  S._resetStoreForTest();
  const base = { method: 'ssh', facts: { ntp: { servers: 1 } }, why: {}, errors: [{ step: 'x', error: 'y'.repeat(400) }] };
  assert.equal(S.recordRun('d1', { ...base, at: NOW - 20 * D }).saved, true);
  assert.equal(S.recordRun('d1', { ...base, at: NOW - 20 * D }).duplicate, true);
  for (let i = 0; i < 15; i += 1) S.recordRun('d1', { ...base, at: NOW - i * D });
  assert.equal(S.runsOf('d1').length, S.RUNS_MAX);
  assert.equal(S.latestRunOf('d1').at, NOW);
  assert.equal(S.runsOf('d1')[0].errors[0].error.length, 160);
  assert.equal(S.recordRun('d1', { at: 'bad' }).dropped, true);
  const file = S._flushStoreForTest();
  S._resetStoreForTest({ reload: true });
  assert.equal(S.runsOf('d1').length, S.RUNS_MAX, '다시 읽기');
  fs.writeFileSync(file, '{ broken');
  S._resetStoreForTest({ reload: true });
  assert.equal(S.runsOf('d1').length, 0);
  assert.ok(S.inspectStoreLoadError());
  assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith('storage-inspect-runs.json.corrupt')), '손상본 보존');
  S._resetStoreForTest();
});

test('⑦ 실행기 — 예산 < 시한 · 조회 명령만 · 실패 사유 · 데모', () => {
  assert.ok(RUN.SSH_BUDGET_MS < RUN.INSPECT_TIMEOUT_MS, '세션 예산 < 장비 시한');
  assert.ok(RUN.CMD_TIMEOUT_MS < RUN.SSH_BUDGET_MS);
  for (const c of RUN.SSH_CMDS) {
    for (const cmd of [c.cmd, c.fallback].filter(Boolean)) {
      assert.ok(!/\b(modify|delete|create|remove|set|smartfail|cancel|resolve|bulk|start|stop|run|reboot|shutdown|purge|format)\b(?!\s*--format)/i.test(cmd.replace(/--format json/g, '')), `설정을 바꾸는 낱말: ${cmd}`);
      assert.ok(!/\$\{|<|>\s*\//.test(cmd), `입력 자리 · 리다이렉트 없음: ${cmd}`);
    }
  }
  assert.ok(Object.values(RUN.REST_PATHS).flat().every((p) => p.startsWith('/platform/')));
  assert.match(RUN.cmdWhy('', 'Permission denied', null), /권한 없음/);
  assert.match(RUN.cmdWhy('', 'Unknown option --format', null), /판에서 명령/);
  assert.match(RUN.cmdWhy('weird', '', null), /형식 미인식/);
  assert.match(RUN.cmdWhy('', '', null), /비었습니다/);
  // 데모 — 상태 다섯 가지가 화면에 보이게(프랑크푸르트 이상 · 상하이 확인 불가)
  const fra = DEMO.demoInspectFacts({ id: 'ps-fra-01', nodeCount: 8 }, NOW);
  assert.equal(fra.facts.drives.notHealthy[0].state, 'SMARTFAIL'); assert.ok(fra.why.healthcheck);
  const sha = DEMO.demoInspectFacts({ id: 'ps-sha-01', nodeCount: 4 }, NOW);
  assert.ok(!sha.facts.group && sha.why.group);
  const filled = DEMO.fillDemoRatios({ ...DEMO.demoInspectFacts({ id: 'ps-sel-01' }, NOW).facts, capacity: { totalBytes: 1000, pct: 50 } });
  assert.equal(filled.snapshots.usedBytes, 120); assert.ok(!('_snapPct' in filled));
});

test('⑧ 엣지 → 중앙 — 정제 · 중복 · 상한 · ack · 라우트 소유권 필터', () => {
  S._resetStoreForTest();
  const r = EDGE.saveEdgeInspectRuns('edge-a', [
    { deviceId: 'dev-1', runs: [{ at: NOW, method: 'ssh', facts: { ntp: { servers: 2 }, evil: 1 }, why: {}, errors: [] }, { at: NOW, method: 'ssh', facts: {} }, 'x', { at: 'bad' }] },
    { deviceId: { a: 1 }, runs: [] }, 'junk',
    { deviceId: 'dev-2', runs: Array.from({ length: 6 }, (_, i) => ({ at: NOW - i * D, facts: {} })) },
  ], { now: NOW + H });
  assert.deepEqual([r.saved, r.duplicate, r.devices], [5, 1, 2]);
  assert.equal(r.dropped, 2 + 2 + 2, '객체 아님 · at 잘못 · deviceId 잘못 · junk · 장비당 상한 초과');
  const run = S.latestRunOf('dev-1');
  assert.equal(run.agent, 'edge-a'); assert.ok(!('evil' in run.facts));
  const fut = EDGE.saveEdgeInspectRuns('edge-a', [{ deviceId: 'dev-3', runs: [{ at: NOW + 10 * D, facts: {} }, { at: NOW + 11 * D, facts: {} }] }], { now: NOW + H });
  assert.deepEqual([fut.saved, fut.duplicate], [1, 1], '엣지 시계가 앞서면 수신 시각으로 잘리고 같은 at 은 한 번');
  assert.equal(S.latestRunOf('dev-3').at, NOW + H, 'at 은 수신 시각 이하');
  // 공용 판독기가 inspectRuns 확인을 읽는다 · 뺀 것은 문장으로
  const ds = CR.dropSummaryOf({ ok: true, inspectRuns: { devices: 1, received: 2, saved: 1, dropped: 1 } });
  assert.deepEqual(ds.inspectRuns, { devices: 1, received: 2, saved: 1, dropped: 1 });
  assert.match(ds.text, /점검 결과 1건 받지 않음/);
  // 라우트 소스 — 같은 소유권 필터(onlyDelegated + ownedSet) · storage-config 가 inspectNow · push 가 inspectRuns
  const cen = centralSource();
  const blk = cen.slice(cen.indexOf('inspectRuns) && req.body.inspectRuns.length'), cen.indexOf('saveEdgeInspectRuns(agent'));
  assert.match(blk, /onlyDelegated\(/); assert.match(blk, /ownedSet\.has/);
  assert.match(cen, /takeInspectRequests\(agent\)/);
  assert.match(src('storage/push.js'), /pendingInspectRuns\(\)[\s\S]*markInspectRunsSent\(inspectRuns\)/);
  assert.match(src('agent/storageConfigPull.js'), /body\?\.inspectNow[\s\S]{0,200}slice\(0, 10\)/);
  S._resetStoreForTest();
});

test('⑨ 회차 — 주간 회차 시각 · 계획 · 설정 정규화', () => {
  // 2026-11-11(수) 09:30 KST → 지난 월요일 09:00 KST = 2026-11-09 00:00 UTC
  const wed = Date.UTC(2026, 10, 11, 0, 30);
  assert.equal(SCH.weeklySlot({ weekday: 1, time: '09:00' }, wed), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(SCH.weeklySlot({ weekday: 3, time: '10:00' }, wed), Date.UTC(2026, 10, 4, 1, 0), '오늘 회차가 아직이면 지난주');
  assert.equal(SCH.weeklySlot({ weekday: 7, time: '23:30' }, wed), Date.UTC(2026, 10, 8, 14, 30));
  const slot = Date.UTC(2026, 10, 9, 0, 0);
  assert.deepEqual(SCH.planWeekly({ enabled: false, slot, last: null, now: slot + 60_000 }), { action: 'none' });
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot, last: null, now: slot + 60_000, bootAt: slot + 10 * 60_000 }), { action: 'init', last: slot });
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot, last: slot - 7 * D, now: slot + 60_000, bootAt: 0 }), { action: 'go', slot });
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot, last: slot - 7 * D, now: slot + 40 * 60_000, bootAt: 0 }), { action: 'missed', slot, reason: 'late' });
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot, last: slot - 7 * D, now: slot + 36 * 60_000, bootAt: slot + 35 * 60_000 }), { action: 'missed', slot, reason: 'down' });
  // 반증 F14: 회차 시각에 걸친 짧은 재시작(90초)은 유예 안 — 돌린다
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot, last: slot - 7 * D, now: slot + 2 * 60_000, bootAt: slot + 60_000 }), { action: 'go', slot });
  // 반증 F13: 시계를 2분 되돌려도 이미 돈 회차를 다시 돌리지 않는다(기록 유지 → 시계가 회차를 다시 지나도 none)
  assert.deepEqual(SCH.planWeekly({ enabled: true, slot: slot - 7 * D, last: slot, now: slot - 2 * 60_000, bootAt: 0 }), { action: 'none' });
  assert.equal(SCH.planWeekly({ enabled: true, slot, last: slot, now: slot + 60_000 }).action, 'none');
  assert.equal(SCH.planWeekly({ enabled: true, slot, last: slot, now: slot + 60_000 }).action, 'none');
  assert.equal(SCH.planWeekly({ enabled: true, slot, last: slot + 10 * D, now: slot + 60_000 }).action, 'rebase');
  const N = SCH.normalizeSettings;
  assert.ok(N({ weekday: 0 }).issue); assert.ok(N({ weekday: 8 }).issue); assert.ok(N({ time: '24:00' }).issue); assert.ok(N({ to: 'not-a-mail' }).issue);
  assert.ok(N({ corpTo: { sel: ['bad'] } }).issue); assert.ok(N({ mailDelayMin: 5 }).issue); assert.ok(N({ corpTo: [] }).issue);
  const ok = N({ weekday: 2, time: '07:05', to: 'a@x.com, b@y.com', corpTo: { sel: ['c@z.com'], empty: [] }, thresholds: { capWarnPct: 75, skewFactor: 99 }, mailEnabled: true });
  assert.deepEqual([ok.settings.weekday, ok.settings.time, ok.settings.to, ok.settings.corpTo, ok.settings.thresholds.capWarnPct, ok.settings.thresholds.skewFactor, ok.settings.mailEnabled],
    [2, '07:05', ['a@x.com', 'b@y.com'], { sel: ['c@z.com'] }, 75, 1.5, true]);
  assert.deepEqual(N({}, ok.settings).settings, ok.settings, '없는 키는 유지');
});

test('⑩ 보고서 — 이상/주의 · 확인 불가 분리 · 이스케이프 · CSV 수식 가드', () => {
  const item = (id, status, extra = {}) => ({ id, label: id, status, value: '<v>', basis: 'b', refs: [1], ...extra });
  const model = { thresholds: { capWarnPct: 80, capBadPct: 90 }, devices: [
    { id: 'a', name: '<script>x</script>', corp: 'c1', corpName: '서울', version: '9.7', nodeCount: 6, capacityPct: 81, run: { at: NOW }, summary: { ok: 1, warn: 1, bad: 1, unknown: 1, na: 0 }, diff: { worse: [], better: [] },
      items: [item('capacity', 'warn'), item('drives', 'bad'), item('group', 'unknown', { why: 'REST' }), item('ntp', 'ok')] },
    { id: 'b', name: '=cmd|calc', corp: 'c2', corpName: '애슈번', summary: { ok: 2, warn: 0, bad: 0, unknown: 0, na: 0 }, diff: {}, items: [item('ntp', 'ok'), item('capacity', 'ok')] },
  ] };
  const m = REP.buildReportModel(model, { rows: [{ deviceId: 'a', name: 'n', corpName: '서울', lnn: 2, value: 5668, ratio: 2.9, share: 49, skewed: true }], clusters: [{ deviceId: 'a', skewed: true, maxRatio: 2.9, maxLnn: 2, name: 'n', corpName: '서울' }], skewFactor: 1.5 }, { now: NOW });
  assert.deepEqual([m.issues.length, m.issues[0].status, m.unknowns.length, m.counts.ok], [2, 'bad', 1, 3]);
  assert.equal(m.top.skewed.length, 1);
  const corpOnly = REP.buildReportModel(model, null, { now: NOW, corp: 'c2' });
  assert.deepEqual([corpOnly.devices.length, corpOnly.issues.length, corpOnly.corpName], [1, 0, '애슈번']);
  const html = REP.renderReportHtml(m);
  assert.ok(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('`'));
  assert.match(html, /확인하지 못한 항목\(1\)/);
  const parts = REP.reportMailParts(m);
  assert.match(parts.subject, /이상 1 · 주의 1 · 확인 불가 1/);
  assert.match(parts.filename, /^powerscale-inspect-.*\.html$/);
  const csv = REP.reportCsv(model);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes("'=cmd|calc"), '수식 가드');
  assert.match(REP.weekLabel(Date.UTC(2026, 10, 9)), /^2026년 46주차$/);
});

test('⑪ 실제 api — 게이트 · 판정 · 가림', async () => {
  S._resetStoreForTest(); SCH._resetScheduleForTest();
  const d = REG.saveDevice({ type: 'isilon', name: '10.20.30.40', host: '10.20.30.40', username: 'u', password: 'p', collectMethod: 'ssh' });
  S.recordRun(d.id, { at: NOW - H, method: 'ssh', facts: { capacity: { pct: 85, totalBytes: 100 }, ntp: { servers: 0 } }, why: { group: '권한 없음 — 10.20.30.40 에서 거부' }, errors: [] });
  const admin = await call('/tools/ps-inspect');
  assert.equal(admin.status, 200);
  const dv = admin.body.devices.find((x) => x.id === d.id);
  assert.equal(dv.items.length, 20);
  assert.equal(dv.items.find((i) => i.id === 'capacity').status, 'warn');
  assert.equal(dv.items.find((i) => i.id === 'ntp').status, 'warn');
  assert.equal(dv.items.find((i) => i.id === 'group').status, 'unknown');
  assert.equal(admin.body.totals.devices >= 1, true);
  const op = await call('/tools/ps-inspect', { user: { username: 'o', role: 'operator', scope: {} } });
  assert.equal(op.status, 200);
  const odv = op.body.devices.find((x) => x.id === d.id);
  assert.notEqual(odv.name, '10.20.30.40', '비관리자 — 주소 이름 가림');
  assert.ok(!JSON.stringify(odv).includes('10.20.30.40'), '사유 문구 속 주소도 가림');
  assert.equal((await call('/tools/ps-inspect', { user: { username: 's', role: 'admin', scope: { vcenters: ['vc-1'] } } })).status, 403);
  assert.equal((await call('/tools/ps-inspect/devices/nope')).status, 404);
  const det = await call(`/tools/ps-inspect/devices/${d.id}`);
  assert.equal(det.status, 200); assert.equal(det.body.device.history.length, 1);
  const cat = await call('/tools/ps-inspect/catalog');
  assert.equal(cat.body.items.length, 20); assert.equal(cat.body.refs.length, 22); assert.ok(cat.body.commands.ssh.length >= 10);
  const top = await call('/tools/ps-inspect/top-nodes?range=bogus&metric=bogus&limit=999');
  assert.deepEqual([top.status, top.body.range, top.body.metric], [200, '7d', 'ops']);
  const rep = await call('/tools/ps-inspect/report');
  assert.equal(rep.status, 200); assert.ok(rep.body.model.issues.length >= 2);
  assert.ok(!JSON.stringify(rep.body.model).includes('10.20.30.40'), '보고서는 메일과 같은 가림 판본');
  const html = await call('/tools/ps-inspect/report?format=html');
  assert.equal(html.status, 200); assert.match(html.text, /PowerScale 주간 점검 보고서/);
  const csv = await call('/tools/ps-inspect/report.csv');
  assert.equal(csv.status, 200); assert.match(csv.text, /클러스터 사용률/);
  // 게이트(라우트 태그) — 인증을 끈 하네스에서는 역할 · 권한 게이트가 관리자로 통과하므로 태그로 고정한다(archCheck2614 와 같은 방식).
  const gatesOf = (method, p) => {
    const layer = api.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, `${method} ${p} 라우트 없음`);
    return layer.route.stack.map((x) => x.handle.gate).filter(Boolean).map((g) => `${g.kind}${g.arg ? `:${g.arg.join('|')}` : ''}`);
  };
  for (const p of ['/tools/ps-inspect', '/tools/ps-inspect/catalog', '/tools/ps-inspect/devices/:id', '/tools/ps-inspect/top-nodes', '/tools/ps-inspect/report']) assert.deepEqual(gatesOf('get', p), ['perm:tools', 'fullScope'], p);
  assert.deepEqual(gatesOf('get', '/tools/ps-inspect/report.csv'), ['perm:tools', 'fullScope', 'perm:data.csv']);
  for (const [m, p] of [['post', '/tools/ps-inspect/run'], ['put', '/tools/ps-inspect/settings'], ['post', '/tools/ps-inspect/report/send-now']]) assert.deepEqual(gatesOf(m, p), ['role:admin', 'fullScope'], p);
  // 쓰기
  assert.equal((await call('/tools/ps-inspect/run', { method: 'POST', body: { ids: [{}] } })).status, 400);
  const run = await call('/tools/ps-inspect/run', { method: 'POST', body: { ids: ['nope'] } });
  assert.deepEqual([run.status, run.body.local, run.body.queued, run.body.unknown], [202, 0, 0, ['nope']]);
  assert.equal((await call('/tools/ps-inspect/settings', { method: 'PUT', body: { weekday: 9 } })).status, 400);
  const put = await call('/tools/ps-inspect/settings', { method: 'PUT', body: { to: ['ops@example.com'], mailEnabled: true } });
  assert.equal(put.status, 200);
  const opv = await call('/tools/ps-inspect', { user: { username: 'o', role: 'operator', scope: {} } });
  assert.deepEqual([opv.body.schedule.settings.to, opv.body.schedule.settings.toCount, opv.body.schedule.settings.updatedBy], [[], 1, undefined]);
  assert.equal((await call('/tools/ps-inspect/run', { method: 'POST', body: {}, user: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-1'] } } })).status, 403, '쓰기 범위를 줄인 관리자는 막힌다(fullRwOnly)');
  SCH._resetScheduleForTest(); S._resetStoreForTest();
});

test('⑫ 등록 — 도구 키 · 카탈로그 · 메일 종류 · 엣지 로그 · 상태 파일', async () => {
  assert.equal(TOOL_PATH_KEYS['ps-inspect'], 'ps-inspect');
  assert.match(src('toolcats/catalog.js'), /'storage-mon', 'ps-inspect'/);
  assert.match(src('mail/kinds.js'), /id: 'storage-inspect-report'/);
  const keys = STATUS_SPEC.map((s) => s.key);
  assert.ok(keys.includes('collect.storageInspect') && keys.includes('service.storageInspectSchedule'));
  for (const n of ['storage-inspect-runs.json', 'storage-inspect-ring.json', 'storage-inspect-state.json']) assert.ok(RUNTIME_STATE_NAMES.has(n), n);
  assert.match(src('index.js'), /startInspectScheduler,/);
  assert.match(src('routes/api.js'), /registerPsInspect\(api\)/);
});
