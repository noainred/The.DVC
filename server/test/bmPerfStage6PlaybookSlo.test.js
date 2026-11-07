/**
 * 리눅스 성능 6단계 — 진단 플레이북(§16 E) · 목표선(SLO · §16 D). 고정하는 규약(security-api.md · idrac-server.md 6단계):
 *   플레이북 ① 카탈로그: 모든 판정 id 에 플레이북 · 모든 명령은 읽기 전용 화이트리스트 통과 · 근거 번호는 아는 것만 · 교차 결론 code 는 useJudge 와 1:1(소스 스윕)
 *            ② 포탈은 실행하지 않는다(소스 스윕 — SSH · exec 경로 import 없음 · POST 라우트 없음) ③ 자리표시 값 화이트리스트 ④ 실제 라우터(범위 404)
 *   목표선 ⑤ 정규화(형식 · 중복 · 용도) · 우선순위(개별 > 용도 > 역할) ⑥ 평가(결측은 분모 제외 · 연속 위반은 결측에서 끊김 · 일 추이 · p95 · 자료 없음)
 *          ⑦ 실제 라우터(실제 시간 단위 파일 · 범위 404 · 저장은 설정 소유자 등급 · 감사 · 손상이면 기본값 + loadError)
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bms6pb-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const P = await import('../src/bmusage/playbooks.js');
const L = await import('../src/bmusage/slo.js');
const SRC = (f) => fs.readFileSync(path.join(import.meta.dirname, '../src', f), 'utf8');

test('① 카탈로그 — 모든 판정 id · 읽기 전용 명령 · 근거 번호 · 교차 code 1:1', async () => {
  const ids = P.allJudgmentIds();
  const covered = new Set(P.PLAYBOOKS.flatMap((p) => p.appliesTo));
  assert.deepEqual(ids.filter((x) => !covered.has(x)), [], '플레이북 없는 판정 id');
  assert.deepEqual([...covered].filter((x) => !ids.includes(x)), [], '없는 판정 id 를 가리키는 플레이북');
  const { ALL_SOURCES } = await import('../src/bmusage/tuning/sources.js');
  const known = new Set([...ALL_SOURCES.map((s) => s.id), ...P.METHOD_SOURCES]);
  for (const p of P.PLAYBOOKS) {
    assert.equal(p.steps[0].kind, 'portal', `${p.id} 첫 단계는 포탈에서 먼저 확인`);
    assert.equal(p.steps.at(-1).kind, 'action', `${p.id} 끝은 조치 후보 · 기록`);
    for (const s of p.steps) {
      assert.ok(P.STEP_KINDS.includes(s.kind));
      for (const c of s.commands || []) assert.ok(P.isReadOnlyCommand(c), `${p.id}: 읽기 전용이 아님 — ${c}`);
      for (const x of s.sources || []) assert.ok(known.has(x), `${p.id}: 모르는 근거 번호 ${x}`);
    }
  }
  assert.equal(P.playbookCatalog().flatMap((p) => p.steps.flatMap((s) => s.commands || [])).length, P.PLAYBOOKS.flatMap((p) => p.steps.flatMap((s) => s.commands || [])).length, '런타임 거름에서 빠진 명령 없음');
  for (const bad of ['rm -rf /', 'sysctl -w vm.swappiness=10', 'sysctl vm.swappiness=10', 'cat /etc/shadow > /tmp/x', 'systemctl restart sshd', 'echo 3 | tee /proc/sys/vm/drop_caches', 'dmesg -c', 'ethtool -K eth0 gro off',
    'ethtool -G eth0 rx 4096', 'sudo iostat', 'cat $(ls)', 'sed -i s/a/b/ /etc/x', 'ip link set eth0 down', 'nvme format /dev/nvme0n1', 'cat a; reboot', 'smartctl -t long /dev/sda', 'journalctl --vacuum-time=1d',
    'tuned-adm profile latency-performance', 'chronyc makestep', 'dnf update -y', 'gpstate -x', 'psql -c "DELETE FROM t"', "grep 'x", 'kill -9 1', 'gprecoverseg -a', 'iostat 1 & ']) {
    assert.equal(P.isReadOnlyCommand(bad), false, `거부해야 함: ${bad}`);
  }
  for (const ok of ["grep -iE 'drop|miss' x", 'ethtool -S eth0', 'iostat -xz 1 5 # 주석의 > 기호는 설명', 'sysctl vm.dirty_ratio']) assert.equal(P.isReadOnlyCommand(ok), true, ok);
  // 교차 결론 code — useJudge 소스의 candidate · clear code 와 같은 목록(두 벌이 갈라지면 플레이북이 빠진다)
  const { stripComments } = await import('./_stripComments.js');
  const uj = stripComments(SRC('bmusage/useJudge.js'));
  const codes = [...uj.matchAll(/state: '(?:candidate|clear)', code: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(codes)].sort(), [...P.CROSS_CODES].sort());
});

test('② 포탈은 실행하지 않는다 — SSH · exec 경로 import 없음 · 쓰기 라우트 없음 · ③ 자리표시 화이트리스트', async () => {
  const { stripComments } = await import('./_stripComments.js');
  for (const f of ['bmusage/playbooks.js', 'routes/api/bmPlaybookSlo.js']) {
    const s = stripComments(SRC(f));
    assert.doesNotMatch(s, /child_process|sshExec|collectOsUsage|runSnapshot|ssh2|redfish/i, f);
  }
  const r = stripComments(SRC('routes/api/bmPlaybookSlo.js'));
  assert.doesNotMatch(r, /api\.post\(['"][^'"]*playbook/, '플레이북 POST(실행) 경로 없음');
  const fill = P.fillOf({ disks: [{ name: 'sda', busyPct: 10 }, { name: 'nvme1n1', busyPct: 94 }, { name: 'x;rm', busyPct: 99 }], nics: [{ iface: 'eth0', dropDelta: 5, errDelta: 1 }, { iface: 'bad$(x)', dropDelta: 9 }] });
  assert.equal(fill['{장치}'], undefined, '가장 바쁜 장치 이름이 화이트리스트 밖이면 비운다(다음 것으로 바꾸지도 않는다 — 지어내지 않는다)');
  assert.equal(P.fillOf({ disks: [{ name: 'sda', busyPct: 10 }, { name: 'nvme1n1', busyPct: 94 }] })['{장치}'], 'nvme1n1');
  assert.equal(fill['{인터페이스}'], undefined);
  assert.equal(P.fillOf({ nics: [{ iface: 'bond0', dropDelta: 3 }] })['{인터페이스}'], 'bond0');
  assert.equal(P.fillCommand('iostat -x {장치}', { '{장치}': 'a b' }), 'iostat -x {장치}', '채울 값도 화이트리스트');
  assert.deepEqual(P.judgmentIdsOf({ entry: { perResource: { disk: 'saturated', cpu: 'ok' }, cross: [{ id: 2, state: 'clear', code: 'io-volume' }, { id: 1, state: 'missing', code: '' }] },
    health: { cells: { chrony: { code: 'warn' }, oom: { code: 'missing' } } }, profile: { profiles: [{ checks: [{ id: 'gp.diskSpace', status: 'bad' }, { id: 'gp.downSeg', status: 'unknown' }] }] } }).sort(),
  ['cross:io-volume', 'health:chrony', 'profile:gp.diskSpace', 'use:disk'], '못 읽음 · 확인 불가는 판정 id 가 아니다');
  assert.deepEqual(P.playbooksFor(['use:disk']).map((x) => x.id), ['disk-await']);
});

test('⑤ 목표 정규화 · 우선순위 ⑥ 평가', () => {
  assert.throws(() => L.normalizeSlo({ default: [{ metric: 'evil', basis: 'avg', op: 'lt', value: 1 }] }), /지표/);
  assert.throws(() => L.normalizeSlo({ default: [{ metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 1 }, { metric: 'cpu_pct', basis: 'avg', op: 'gt', value: 2 }] }), /두 번/);
  assert.throws(() => L.normalizeSlo({ profiles: { oracle: [] } }), /용도/);
  assert.throws(() => L.normalizeSlo({ servers: { __proto__: [] }, default: [] }) && L.normalizeSlo({ servers: JSON.parse('{"__proto__":[{"metric":"cpu_pct","basis":"avg","op":"lt","value":1}]}') }), /형식/);
  assert.deepEqual(L.normalizeSlo({ default: [] }).value.default, [], '명시적 빈 기본은 빈 그대로');
  assert.equal(L.normalizeSlo({}).value.default.length, 3, '없으면 시작값');
  const cfg = { default: [{ id: 'a', metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 }, { id: 'b', metric: 'disk_used_pct', basis: 'avg', op: 'lt', value: 90, objectivePct: 99 }],
    profiles: { gpdb: [{ id: 'c', metric: 'disk_used_pct', basis: 'avg', op: 'lt', value: 75, objectivePct: 99 }] }, servers: { K1: [{ id: 'd', metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 50, objectivePct: 95 }] } };
  const eg = L.effectiveGoals(cfg, { key: 'K1', apps: ['gpdb'] });
  assert.deepEqual(eg.map((g) => [g.metric, g.value, g.source]).sort(), [['cpu_pct', 50, 'server'], ['disk_used_pct', 75, 'profile:gpdb']].sort(), '개별 > 용도 > 역할');
  const step = 300_000; const from = NOW - 12 * step; const to = NOW;
  const pts = [10, 90, 95, null, 92, 10, 10, 10, 10, 10, 10, 10].map((v, i) => ({ t: from + i * step, avg: v, max: v, peak: v == null ? null : v + 5 }));
  const ev = L.evaluateGoal({ metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 90 }, pts.filter((p) => p.avg != null), { from, to, stepMs: step, now: NOW });
  assert.equal(ev.valid, 11); assert.equal(ev.missing, 1, '결측 주기는 분모에서 빼고 센다'); assert.equal(ev.within, 8); assert.equal(ev.achievementPct, 72.7);
  assert.equal(ev.violations, 3); assert.equal(ev.violationMs, 3 * step);
  assert.equal(ev.longest.cycles, 2, '결측 주기에서 연속 위반이 끊긴다'); assert.equal(ev.status, 'missed');
  assert.deepEqual(ev.maintenance, { source: 'none', excluded: 0 }, '정비 창 원천 없음(정직 기록)');
  assert.ok(ev.daily.length >= 1 && ev.daily.every((d) => d.pct != null));
  const pk = L.evaluateGoal({ metric: 'cpu_pct', basis: 'peak', op: 'lt', value: 99, objectivePct: 90 }, pts, { from, to, stepMs: step, now: NOW });
  assert.equal(pk.violations, 1, '피크 기준은 피크 값으로');
  const p95 = L.evaluateGoal({ metric: 'cpu_pct', basis: 'p95', op: 'lt', value: 50, objectivePct: 90 }, pts, { from, to, stepMs: step, now: NOW });
  assert.equal(p95.p95, 95); assert.equal(p95.status, 'missed');
  const none = L.evaluateGoal({ metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 }, [], { from, to, stepMs: step, now: NOW });
  assert.equal(none.status, 'no-data'); assert.equal(none.achievementPct, null, '자료 없음 — 0% 가 아니다');
  assert.equal(L.sloRes(0, 10 * 86_400_000), '5m'); assert.equal(L.sloRes(0, 31 * 86_400_000), '1h');
});

test('④ ⑦ 실제 라우터 — 플레이북 · 목표선(실제 파일) · 범위 404 · 저장은 설정 소유자 · 감사 · 손상', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b', name: 'bm-b', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a', name: 'bm-a', serviceTag: 'PTAGA', vcenterId: 'vcA' }, { serverId: 's-b', name: 'bm-b', serviceTag: 'PTAGB', vcenterId: 'vcB' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const db = await import('../src/bmusage/db.js');
  const { config } = await import('../src/config.js');
  const rows = [];
  for (let i = 0; i < 12; i++) { const ts = NOW - HOUR + (i + 1) * 300_000; rows.push({ key: 'PTAGA', ts, runq_per_core: i < 3 ? 2 : 0.2, disk_await_ms: 4, disk_await_ms_peak: i === 5 ? 40 : 6, swap_out_ps: 0, os_at: ts }); }
  await db.insertUsage(rows, config.agent?.name || '');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = { viewer: { username: 'v', role: 'viewer', scope: null }, opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, adm: { username: 'adm', role: 'admin', scope: null }, admA: { username: 'ada', role: 'admin', scope: { vcenters: ['vcA'] } }, own: { username: 'noainred', role: 'admin', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  const call = async (u, m, p, body) => { const r = await fetch(`${base}${p}`, { method: m, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  const cat = await call('viewer', 'GET', '/playbooks');
  assert.equal(cat.status, 200); assert.equal(cat.body.executes, false); assert.ok(cat.body.playbooks.length >= 10);
  assert.equal((await call('opA', 'GET', '/perf/PTAGB/playbook')).status, 404, '범위 밖 404');
  const pb = await call('opA', 'GET', '/perf/PTAGA/playbook');
  assert.equal(pb.status, 200, JSON.stringify(pb.body).slice(0, 200)); assert.equal(pb.body.executes, false); assert.ok(Array.isArray(pb.body.ids));
  // 목표선 — 기본 목표(await 피크 < 10 · 런큐 < 1 · 스왑 0) · 실제 파일의 1시간
  assert.equal((await call('opA', 'GET', '/perf/PTAGB/slo')).status, 404);
  const s1 = await call('opA', 'GET', `/perf/PTAGA/slo?from=${NOW - HOUR}&to=${NOW}`);
  assert.equal(s1.status, 200, JSON.stringify(s1.body).slice(0, 300));
  const by = Object.fromEntries(s1.body.items.map((x) => [x.goal.metric, x]));
  assert.equal(by.runq_per_core.violations, 3); assert.equal(by.runq_per_core.valid, 12); assert.equal(by.runq_per_core.achievementPct, 75);
  assert.equal(by.disk_await_ms.violations, 1, '피크 기준'); assert.equal(by.swap_out_ps.status, 'met');
  assert.equal(s1.body.maintenanceSource, 'none'); assert.equal(s1.body.res, '5m');
  // 저장 — 설정 소유자 등급만 · 감사
  const body = { default: [{ metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 70, objectivePct: 99 }], servers: { PTAGA: [{ metric: 'runq_per_core', basis: 'avg', op: 'lt', value: 3, objectivePct: 99 }], PTAGB: [{ metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 60, objectivePct: 99 }] } };
  assert.equal((await call('opA', 'PUT', '/slo', body)).status, 403);
  assert.equal((await call('adm', 'PUT', '/slo', body)).status, 403, '소유자가 아닌 관리자');
  assert.equal((await call('own', 'PUT', '/slo', { default: [{ metric: 'evil' }] })).status, 400);
  const w = await call('own', 'PUT', '/slo', body);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const audit = await import('../src/audit.js');
  assert.ok(audit.auditEntriesWithAction('bm-perf.slo').length >= 1);
  const s2 = await call('opA', 'GET', `/perf/PTAGA/slo?from=${NOW - HOUR}&to=${NOW}`);
  assert.equal(s2.body.items.find((x) => x.goal.metric === 'runq_per_core').goal.source, 'server', '개별 목표가 이긴다');
  const rdA = await call('admA', 'GET', '/slo');
  assert.deepEqual(Object.keys(rdA.body.slo.servers), ['PTAGA'], '범위 관리자 — 범위 안 서버의 개별 목표만'); assert.equal(rdA.body.canEdit, false);
  const rd = await call('opA', 'GET', '/slo');
  assert.deepEqual(rd.body.slo.servers, {}, '비관리자 — 서버 키(주소일 수 있다)를 싣지 않는다'); assert.equal(rd.body.serversHidden, 1, '보이는 서버의 개별 목표 개수만'); assert.equal(rd.body.canEdit, false);
  const rv = await call('viewer', 'GET', '/slo');
  assert.deepEqual(rv.body.slo.servers, {}); assert.equal(rv.body.serversHidden, 2);
  const ro = await call('own', 'GET', '/slo');
  assert.deepEqual(Object.keys(ro.body.slo.servers).sort(), ['PTAGA', 'PTAGB']); assert.equal(ro.body.canEdit, true);
  fs.writeFileSync(path.join(DIR, 'bm-perf-slo.json'), '{ broken');
  L._resetSloForTest();
  const s3 = await call('opA', 'GET', `/perf/PTAGA/slo?from=${NOW - HOUR}&to=${NOW}`);
  assert.ok(s3.body.loadError, '손상 — 기본 목표로 계산하고 그 사실을 말한다');
  assert.ok(fs.readdirSync(DIR).some((x) => x.startsWith('bm-perf-slo.json.corrupt')));
});
