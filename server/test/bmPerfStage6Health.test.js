/**
 * 리눅스 성능 6단계 — 수집 건강(메타 모니터링 · 설계 PROFILES §16 C). 고정하는 규약(idrac-server.md · edge.md 6단계):
 *   ① 계산(순수): 실패 사유는 missReason 코어 하나(상태 9종 분류) · 리포트 없음 · 첫 주기 · PSI 없음은 실패가 아니다 · 대상 0대면 성공률 null(0% 도 100% 도 아니다) ·
 *      SSH 를 연 서버만 소요를 센다 · ‘며칠째’ 는 이어지는 동안 유지 · 기준 대조는 값 없으면 unread(보류)
 *   ② 실제 폴러 배선: pollBmUsageOnce → 슬롯 최대 사용 · SSH 소요 · 인증 정지 사유 · collect_cycle 기록 · 0대 주기도 기록 · ‘수집 건강’ 알림 규칙(노드 한 칸)
 *   ③ 봉투 · 중앙 정제(아는 필드만 · 열거 밖 버림 · 시각 clamp) ④ 실제 라우터: viewer 403 · 범위 계정은 자기 법인 행만 · 다른 법인이 섞인 노드 값은 숨김 · 구버전 엣지 old-version
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bms6hl-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';   // 데모(mock)면 알림 경로가 보내지 않는다(skipped demo)
process.env.COLLECTOR_TOKEN = 'tok-s6-hl';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const CH = await import('../src/bmusage/collectHealth.js');

test('① 주기 요약 — 사유 분류 · 정상인 빈 칸 · 0대 · SSH 소요 · 며칠째 · 기준 대조', () => {
  const tg = (key, vc, paths = ['os', 'idrac']) => ({ key, vcenterId: vc, paths });
  const results = [
    { ok: true, target: tg('a', 'vcA'), os: { ok: true }, idrac: { ok: false, kind: 'no-telemetry' }, osMs: 400, built: { perfFlags: { firstSample: true, psiAbsent: true } } },
    { ok: false, target: tg('b', 'vcA'), os: { ok: false, error: 'OS 수집 시한 초과' }, idrac: { ok: false, kind: 'auth' }, osMs: 60_000 },
    { ok: false, target: tg('c', 'vcB', ['os']), os: { ok: false, error: '인증 실패로 주기 수집이 정지됐습니다', authStopped: { attempts: 3 } } },
    { ok: true, target: tg('d', 'vcB', ['idrac']), idrac: { ok: true }, os: null },
    { ok: false, target: tg('e', 'vcB', ['os']), error: 'boom' },
  ];
  const s1 = CH.summarizeCycle({ results, startedAt: NOW - 240_000, endedAt: NOW, intervalMs: 300_000, concurrency: 32, slotPeak: 4, sinceMap: new Map(), now: NOW });
  const R = Object.fromEntries(s1.node.reasons.map((x) => [`${x.path}:${x.code}`, x]));
  assert.equal(R['os:timeout'].n, 1); assert.equal(R['idrac:auth'].n, 1); assert.equal(R['os:auth-stopped'].n, 1); assert.equal(R['os:error'].n, 1, '예외로 끝난 서버');
  assert.equal(R['os:timeout'].state, 'idracOnlyUnread', '상태 9종 분류 — OS 못 읽음'); assert.equal(R['idrac:auth'].state, 'auth');
  assert.equal(R['idrac:no-telemetry'], undefined, '리포트 없음은 실패 사유가 아니다');
  assert.deepEqual(s1.node.info, { 'no-telemetry': 1, first: 1, 'psi-absent': 1 });
  assert.equal(s1.node.successPct, 40); assert.equal(s1.node.cyclePct, 80); assert.deepEqual(s1.node.conc, { max: 4, cap: 32 });
  assert.deepEqual(s1.node.ssh, { n: 2, p50Ms: 400, p95Ms: 60_000 }, 'SSH 를 연 서버만');
  assert.deepEqual(s1.byCorp.vcB, { servers: 3, ok: 1, fail: 2, reasons: { 'os:auth-stopped': 1, 'os:error': 1 } });
  // 며칠째 — 같은 서버가 같은 사유로 이어지면 처음 시각을 유지 · 풀리면 지운다
  const s2 = CH.summarizeCycle({ results: results.slice(1, 2), startedAt: NOW, endedAt: NOW + 1000, intervalMs: 300_000, concurrency: 32, sinceMap: s1.sinceMap, now: NOW + 300_000 });
  assert.equal(s2.node.reasons.find((x) => x.code === 'timeout').since, NOW, '이어지는 동안 처음 시각');
  assert.equal(s2.sinceMap.size, 2, '풀린 사유는 맵에서 빠진다(누수 없음)');
  const z = CH.summarizeCycle({ results: [], startedAt: NOW, endedAt: NOW + 5, intervalMs: 300_000, concurrency: 32, now: NOW });
  assert.equal(z.node.servers, 0); assert.equal(z.node.successPct, null, '대상 0대 — 0% 도 100% 도 아니다'); assert.equal(z.node.ssh.p50Ms, null);
  // 기준 대조 — 값 없으면 unread · DB 상한 0 이면 판정 보류
  const c1 = CH.collectCells(s1.node, { bytes: 19 * 1024 ** 3 }, { dbCapGb: 20 });
  assert.deepEqual(c1.cells, { cycle: 'true', success: 'true', db: 'true', auth: 'true', error: 'false' });
  // 반증 F1 — 분류 실패 · 주기 예외는 대상 · 결과를 모른다(대상 0 · 성공률 null · 실패 칸) · 대상 없음은 사실 0(실패 아님) · 열거 밖 오류는 계산 실패로
  const f = CH.summarizeCycle({ results: [], startedAt: NOW, endedAt: NOW + 5, intervalMs: 300_000, concurrency: 32, now: NOW, error: 'classify-failed' });
  assert.equal(f.node.servers, null, '분류 실패 — 대상 수를 모른다(0 이 아니다)'); assert.equal(f.node.ok, null); assert.equal(f.node.successPct, null);
  assert.equal(CH.collectCells(f.node, null).cells.error, 'true');
  assert.equal(CH.collectCells(CH.summarizeCycle({ results: [], startedAt: NOW, endedAt: NOW, intervalMs: 1, concurrency: 1, now: NOW, error: 'no-targets' }).node, null).cells.error, 'false');
  assert.equal(CH.summarizeCycle({ results: [], startedAt: NOW, endedAt: NOW, intervalMs: 1, concurrency: 1, now: NOW, error: '<script>' }).node.error, 'health-failed');
  const c2 = CH.collectCells(z.node, { bytes: 1 }, { dbCapGb: 0 });
  assert.equal(c2.cells.success, 'unread'); assert.equal(c2.cells.db, 'unread'); assert.equal(c2.dbPct, null);
  const tr = CH.hourlyTrend([{ ts: NOW, ms: 100, budget_ms: 300_000, servers: 10, ok: 9, conc_max: 3 }, { ts: NOW + 60_000, ms: 900, budget_ms: 300_000, servers: 10, ok: 5, conc_max: 7 }]);
  assert.deepEqual(tr.map((p) => [p.maxMs, p.minOkPct, p.concMax, p.cycles]), [[900, 50, 7, 2]]);
});

async function setupPoller() {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b', name: 'bm-b', host: '127.0.0.1', port: 9, username: 'mon2', password: 'pw2', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a', name: 'bm-a', serviceTag: 'HTAGA', vcenterId: 'vcA' },
    { serverId: 's-b', name: 'bm-b', serviceTag: 'HTAGB', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  return P;
}

test('② 실제 폴러 — 사유 · 슬롯 최대 · SSH 소요 · 주기 기록 · 0대 주기 · ‘수집 건강’ 규칙(노드 한 칸)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const P = await setupPoller();
  const R = await import('../src/bmusage/perfRules.js');
  R.savePerfRules({ rules: { collect: { on: true, cond: 'success', sustain: 1, channels: ['email'] } }, collect: { successPct: 90 } }, { by: 'adm' });
  const A = await import('../src/bmusage/perfAlerts.js');
  A._resetPerfAlertsForTest();
  t.after(() => { P._setFleetForTest(null); R._resetPerfRulesForTest(); });
  const tg = await P.currentTargets();
  const b = tg.targets.find((x) => x.key === 'HTAGB');
  P.recordOsAuthOutcome(b, { ok: false, errorText: 'Permission denied (publickey,password)' });   // b 는 인증 정지 상태
  const r1 = await P.pollBmUsageOnce({ trigger: 'auto' });
  assert.equal(r1.ok, true, JSON.stringify(r1).slice(0, 300));
  const h = P.collectHealthNow();
  assert.ok(h, '주기 뒤 상태가 있다');
  assert.equal(h.node.servers, 2); assert.equal(h.node.ok, 0); assert.equal(h.node.successPct, 0);
  const codes = h.node.reasons.map((x) => `${x.path}:${x.code}`).sort();
  assert.deepEqual(codes, ['os:auth-stopped', 'os:ssh-error'], JSON.stringify(h.node.reasons));
  assert.equal(h.node.ssh.n, 1, '정지된 서버는 SSH 를 열지 않는다 — 소요에 넣지 않는다');
  assert.ok(h.node.conc.max >= 1 && h.node.conc.max <= h.node.conc.cap, JSON.stringify(h.node.conc));
  assert.equal(h.node.cells.success, 'true'); assert.equal(h.node.cells.auth, 'true');
  assert.ok(h.node.db && h.node.db.mainBytes > 0, '저장 실측(stat)');
  assert.deepEqual(Object.keys(h.byCorp), ['vcA']);
  assert.equal(P.bmUsageStatus().last.health, undefined, 'status(무스코프)에는 사유 분해를 싣지 않는다');
  const O = await import('../src/bmusage/opsDb.js');
  const { config } = await import('../src/config.js');
  const rows = await O.cycleRange({ agent: config.agent?.name || '', from: 0, to: Date.now() + 1000 });
  assert.equal(rows.length, 1); assert.equal(rows[0].servers, 2); assert.equal(rows[0].ok, 0);
  await A._drainPerfAlertsForTest();
  const sent = A.perfAlertStatus().sent.filter((x) => x.rule === 'collect');
  assert.equal(sent.length, 1, '수집 건강 규칙 — 노드 한 칸'); assert.equal(sent[0].key, '__node__'); assert.match(sent[0].title, /성공률 0%/);
  // 0대 주기도 기록(무음 실패 금지)
  P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [] }));
  await P.pollBmUsageOnce({ trigger: 'auto' });
  const h0 = P.collectHealthNow();
  assert.equal(h0.node.servers, 0); assert.equal(h0.node.successPct, null); assert.equal(h0.node.error, 'no-targets');
  assert.equal(h0.node.cells.success, 'unread', '0대 — 성공률 칸은 판정 보류');
  // 반증 F1 — 분류 실패 주기: 상태는 ‘주기 실패’ · 법인 행은 대상 모름(0 아님) · ‘수집 건강’ 규칙(조건 ‘주기 실패’)이 이 경로에서도 돈다
  R.savePerfRules({ rules: { collect: { on: true, cond: 'error', sustain: 1, channels: ['email'] } }, collect: { successPct: 90 } }, { by: 'adm' });
  A._resetPerfAlertsForTest();
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  P._setFleetForTest(async () => { throw new Error('인벤토리 응답 없음'); });
  const rf = await P.pollBmUsageOnce({ trigger: 'auto' });
  assert.equal(rf.ok, false);
  const hf = P.collectHealthNow();
  assert.equal(hf.node.error, 'classify-failed'); assert.equal(hf.node.servers, null); assert.equal(hf.node.cells.error, 'true');
  await A._drainPerfAlertsForTest();
  const sentF = A.perfAlertStatus().sent.filter((x) => x.rule === 'collect');
  assert.equal(sentF.length, 1, '분류 실패 경로에서도 수집 건강 규칙이 돈다'); assert.match(sentF[0].title, /주기 실패/);
  const { bmCollectHealthView } = await import('../src/routes/api/bmCollectHealth.js');
  const v = await bmCollectHealthView({ user: { username: 'adm', role: 'admin', scope: null } }, {}, { listEdgeBmUsage: async () => [] });
  assert.equal(v.nodes[0].state, 'cycle-failed', '‘정상’ 이 아니다');
  assert.ok(v.rows.length >= 1 && v.rows.every((r) => r.servers === null && r.nodeState === 'cycle-failed'), JSON.stringify(v.rows).slice(0, 300));
  assert.equal(v.kpi.corpsUnknown, v.rows.length, '대상 모름 — 모름 개수로 센다');
  R.savePerfRules({ rules: { collect: { on: true, cond: 'success', sustain: 1, channels: ['email'] } }, collect: { successPct: 90 } }, { by: 'adm' });
  // 정리 틱이 주기 기록도 청크로 지운다(30일 밖)
  await O.cycleInsert({ agent: config.agent?.name || '', ts: Date.now() - 40 * 86_400_000, ms: 1, budgetMs: 1, servers: 1, ok: 1 });
  const p = await P.pruneTick({ every: 1 });
  assert.equal(p.opsPruned?.collectCycles, 1, JSON.stringify(p.opsPruned));
});

test('③ 봉투 · 중앙 정제 · ④ 실제 라우터(역할 · 범위 · 노드 값 숨김 · 구버전 엣지)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const P = await setupPoller();
  t.after(() => P._setFleetForTest(null));
  await P.pollBmUsageOnce({ trigger: 'auto' });
  const { buildBmUsageEnvelope } = await import('../src/bmusage/edgePull.js');
  const env = await buildBmUsageEnvelope();
  assert.ok(env.collectHealth?.node, '봉투에 수집 건강'); assert.ok(Array.isArray(env.collectHealth.trend));
  const { sanitizeBmUsageSnap, putEdgeBmUsage, _resetForTest } = await import('../src/central/bmUsageEdgePull.js');
  t.after(() => _resetForTest());
  const evil = { ...env.collectHealth, evil: 1, at: Date.now() + 9e9,
    node: { ...env.collectHealth.node, reasons: [{ path: 'os', code: 'rm -rf', n: 9 }, { path: 'os', code: 'timeout', n: '3', since: Date.now() + 9e9 }], cells: { cycle: 'pwn', success: 'true' }, evil: 2 },
    byCorp: { vcB: { servers: '5', ok: 4, fail: 1, reasons: { 'os:timeout': 1, 'x:y': 2 } }, '__proto__': { servers: 1 }, 'bad vc!': { servers: 1 } } };
  const rcv = Date.now();
  const s = sanitizeBmUsageSnap({ ...env, collectHealth: evil }, { receivedAt: rcv });
  const ch = s.collectHealth;
  assert.equal(ch.evil, undefined); assert.equal(ch.node.evil, undefined); assert.ok(ch.at <= rcv, '엣지 미래 시각은 수신 시각으로');
  assert.deepEqual(ch.node.reasons.map((x) => [x.code, x.n]), [['timeout', 3]], '열거 밖 사유 버림 · 문자열 수치는 수');
  assert.deepEqual(ch.node.cells, { success: 'true' }, '열거 밖 칸 버림');
  assert.deepEqual(Object.keys(ch.byCorp), ['vcB']); assert.deepEqual(ch.byCorp.vcB.reasons, { 'os:timeout': 1 }); assert.equal(ch.byCorp.vcB.servers, 5);
  // 엣지 둘 — 6단계 엣지(vcB 만) · 구버전 엣지(봉투에 collectHealth 없음)
  // vcZ — 그 엣지의 설정 법인도 대상 법인도 아니다(봉투 문자열만으로 법인 행을 만들지 않는다 → 버리고 개수를 밝힌다)
  putEdgeBmUsage('edge-new', { ok: true, snap: { ...env, enabled: true, settings: { ...env.settings, corps: ['vcB'] }, targets: [], collectHealth: { ...evil, byCorp: { vcB: evil.byCorp.vcB, vcZ: { servers: 7, ok: 0, fail: 7, reasons: {} } } } } });
  putEdgeBmUsage('edge-old', { ok: true, snap: { node: { agent: 'edge-old', version: '2.930.0' }, enabled: true, settings: { corps: ['vcC'] }, targets: [] } });
  // 반증 F3 — 재시작 직후(첫 주기 전) 6단계 엣지: 실제 봉투 → 실제 정제(표지만 있고 값 없음) → ‘아직 주기 없음’(버전 낮음 아님)
  const P0 = await import('../src/bmusage/poller.js');
  const fresh = sanitizeBmUsageSnap({ ...env, collectHealth: undefined, settings: { ...env.settings, corps: ['vcD'] } }, { receivedAt: Date.now() });
  assert.equal(fresh.collectHealthVer, 1, '표지는 주기 전에도 실린다'); assert.equal(fresh.collectHealth, undefined);
  putEdgeBmUsage('edge-fresh', { ok: true, snap: fresh });
  // 표지만으로도 가른다(버전을 모르는 봉투)
  putEdgeBmUsage('edge-fresh3', { ok: true, snap: { ...fresh, node: { ...fresh.node, version: '' }, settings: { ...fresh.settings, corps: ['vcG'] } } });
  // 표지 없이 버전만 최소 이상(같은 버전) — 단정하지 않는다
  putEdgeBmUsage('edge-fresh2', { ok: true, snap: { node: { agent: 'edge-fresh2', version: (await import('../src/config.js')).currentVersion() }, enabled: true, settings: { corps: ['vcE'] }, targets: [] } });
  // 반증 F4 — 성공 수를 못 읽은 법인 행은 0% 가 아니라 모름
  putEdgeBmUsage('edge-partial', { ok: true, snap: { ...env, enabled: true, settings: { ...env.settings, corps: ['vcF'] }, targets: [], collectHealth: { ...env.collectHealth, byCorp: { vcF: { servers: 5, ok: null, fail: null, reasons: {} } } } } });
  void P0;
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = { viewer: { username: 'v', role: 'viewer', scope: null }, opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, adm: { username: 'adm', role: 'admin', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => srv.close());
  const get = async (u) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/collect-health`, { headers: { 'x-u': u } }); return { status: r.status, body: await r.json() }; };
  assert.equal((await get('viewer')).status, 403, '관리자 · 운영자만');
  const a = await get('adm');
  assert.equal(a.status, 200);
  const byAgent = Object.fromEntries(a.body.nodes.map((x) => [x.agent, x]));
  assert.equal(byAgent['edge-old'].state, 'old-version', '봉투에 필드 · 표지가 없고 버전이 낮으면 엣지 버전 낮음');
  assert.equal(byAgent['edge-fresh'].state, 'no-cycle', '첫 주기 전 6단계 엣지 — 버전 낮음이 아니다');
  assert.equal(byAgent['edge-fresh2'].state, 'no-cycle', '표지가 없어도 버전이 최소 이상이면 단정하지 않는다');
  assert.equal(byAgent['edge-fresh3'].state, 'no-cycle', '버전을 몰라도 표지가 있으면 6단계 엣지');
  const pr = a.body.rows.find((r) => r.vcenterId === 'vcF');
  assert.equal(pr.servers, 5); assert.equal(pr.successPct, null, '성공 수를 모르면 성공률도 모른다(0% 아님)');
  assert.ok(a.body.minEdgeVersion, '문구의 최소 버전(릴리스 노트 6단계 · 없으면 package.json)');
  assert.ok(byAgent['edge-new'].node, '전체 범위 — 노드 값이 보인다');
  assert.ok(a.body.rows.some((r) => r.vcenterId === 'vcB' && r.servers === 5));
  assert.ok(!a.body.rows.some((r) => r.vcenterId === 'vcZ'), '엣지 대상 · 설정 법인이 아닌 byCorp 는 행이 되지 않는다'); assert.equal(a.body.corpsDropped, 1);
  assert.equal(a.body.kpi.corpsUnknown, 5, '구버전(vcC) · 첫 주기 전(vcD · vcE · vcG) · 성공 수 모름(vcF) — 0 으로 더하지 않고 개수를 센다');
  assert.ok(a.body.kpi.servers >= 5 && a.body.rows.find((r) => r.vcenterId === 'vcC').servers === null);
  const la = byAgent['edge-new'].lastAttempt;
  assert.ok(la && la.reason === undefined, '마지막 당김은 사유 원문 없이');
  // 범위 계정(vcA) — 자기 법인 행만 · 로컬 노드는 vcB 도 켰으니 노드 값(주기 · SSH · DB · 추이 · 며칠째)은 숨김 · vcB/vcC 만 가진 엣지는 행 없음
  const o = await get('opA');
  assert.equal(o.status, 200);
  assert.ok(o.body.rows.every((r) => r.vcenterId === 'vcA'), JSON.stringify(o.body.rows.map((r) => r.vcenterId)));
  assert.ok(o.body.nodes.every((x) => x.nodeHidden === true && x.node === undefined), '다른 법인이 섞인 노드 값은 숨김');
  assert.equal(o.body.nodesOmitted, 6, '보이는 법인이 없는 엣지는 행을 주지 않는다(개수만)');
  assert.ok(o.body.reasons.every((x) => x.since == null), '며칠째(노드 값)는 숨김');
  assert.equal(o.body.kpi.dbBytes, null);
});

test('⑤ 저장 실측 — 폴더 · 파일을 못 읽으면 크기는 모름(null) · 부분 합을 내지 않는다', async () => {
  const miss = await CH.dbFilesNow(path.join(DIR, 'no-such-dir'));
  assert.equal(miss.bytes, null, '폴더를 못 읽으면 0 이 아니다'); assert.equal(miss.files, null); assert.equal(miss.error, 'readdir');
  assert.equal(miss.families, null, '가족별 값도 모름(0개 0KB 가 아니다 — 반증 F5)');
  assert.equal(CH.collectCells({ cyclePct: 10, successPct: 100 }, miss).cells.db, 'unread', '모르는 크기는 상한 대조 보류');
  const d = fs.mkdtempSync(path.join(DIR, 'dbf-'));
  fs.writeFileSync(path.join(d, 'bm-usage.db'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(d, 'bm-usage-2026-10.db'), Buffer.alloc(500));
  const ok = await CH.dbFilesNow(d);
  assert.equal(ok.bytes, 1500); assert.equal(ok.files, 1); assert.equal(ok.families.raw.files, 1);
  fs.symlinkSync(path.join(d, 'gone.db'), path.join(d, 'bm-usage-2026-11.db'));   // 끊긴 링크 — stat 실패
  const part = await CH.dbFilesNow(d);
  assert.equal(part.bytes, null, '못 읽은 파일이 있으면 합을 내지 않는다(부분 합 금지)'); assert.equal(part.unread, 1); assert.equal(part.partial, true, '가족 값은 부분 표지');
  const { sanitizeCollectHealth } = await import('../src/central/bmCollectHealthSanitize.js');
  const sh = sanitizeCollectHealth({ node: { at: Date.now(), db: miss, error: 'rm -rf /' }, byCorp: {} });
  assert.equal(sh.node.db.families, null); assert.equal(sh.node.error, 'health-failed', '오류는 열거 code 만');
});

test('⑥ 엣지 ‘수집 건강’ 발송 기록 — 노드 한 칸은 중앙이 이름 · 법인을 다시 세운다(엣지 문자열 불신)', async () => {
  const { centralizeEdgeSent, sanitizeAlertSent } = await import('../src/central/bmPerfOpsPull.js');
  const sent = sanitizeAlertSent([
    { id: 'c1', at: Date.now(), rule: 'collect', key: '__node__', name: '가짜 http://evil.example/x', vcenterId: 'vcEVIL', title: 'pwn', result: 'sent' },
    { id: 'c2', at: Date.now(), rule: 'collect', key: 'NOT-A-TARGET', name: 'x', vcenterId: 'vcEVIL', title: 'pwn', result: 'sent' },
  ]);
  assert.deepEqual(sent.map((r) => r.rule), ['collect', 'collect'], '규칙 열거에 collect');
  const { list, dropped } = await centralizeEdgeSent('edge-a', { perfAlertSent: sent, targets: [] }, { resolveVc: async () => ({ id: 'vcEVIL' }) });
  assert.equal(list.length, 1); assert.equal(dropped, 1, '노드 칸이 아닌 키는 대상 목록 대조(없으면 버림)');
  assert.equal(list[0].key, '__node__'); assert.equal(list[0].vcenterId, '', '법인은 공용(엣지 주장 불신)');
  assert.equal(list[0].name, '수집 노드 edge-a'); assert.ok(!/pwn|evil/.test(list[0].title), list[0].title); assert.match(list[0].title, /수집 건강/);
});

test('⑦ 범위 계정 — 노드 값을 숨기면 노드 상태도 숨기고 법인 행은 그 법인 값으로(다른 법인의 인증 정지가 ‘기준 밖’ 으로 새지 않는다 · 반증 F8)', async () => {
  const tg = (key, vc) => ({ key, vcenterId: vc, paths: ['os'] });
  const sum = CH.summarizeCycle({ results: [
    { ok: true, target: tg('a', 'vcA'), os: { ok: true }, osMs: 100 },
    { ok: false, target: tg('b', 'vcB'), os: { ok: false, error: '인증 실패로 주기 수집이 정지됐습니다', authStopped: { attempts: 3 } } },
  ], startedAt: NOW - 1000, endedAt: NOW, intervalMs: 300_000, concurrency: 32, slotPeak: 1, now: NOW });
  const cc = CH.collectCells(sum.node, { bytes: 1 }, { dbCapGb: 20 });
  const health = { at: NOW, node: { ...sum.node, cells: cc.cells, th: cc.th }, byCorp: sum.byCorp };
  assert.equal(cc.cells.auth, 'true');
  const { bmCollectHealthView } = await import('../src/routes/api/bmCollectHealth.js');
  const deps = { localHealth: async () => health, localEnabled: async () => true, localCorps: async () => ['vcA', 'vcB'], localTrend: async () => [], listEdgeBmUsage: async () => [] };
  const full = await bmCollectHealthView({ user: { username: 'adm', role: 'admin', scope: null } }, {}, deps);
  assert.equal(full.nodes[0].state, 'attention', '전체 범위 — 노드 상태 그대로');
  const sc = await bmCollectHealthView({ user: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } } }, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] }, deps);
  assert.equal(sc.nodes[0].nodeHidden, true); assert.equal(sc.nodes[0].state, 'hidden', '노드 값으로 정한 상태는 숨긴다');
  assert.equal(sc.rows.length, 1); assert.equal(sc.rows[0].vcenterId, 'vcA');
  assert.equal(sc.rows[0].nodeState, 'ok', 'vcA 는 정상 — vcB 의 인증 정지가 새지 않는다'); assert.deepEqual(sc.rows[0].flags, []);
  assert.equal(sc.rows[0].successPct, 100);
  // 그 법인 자신의 실패는 그 법인 행에 보인다(같은 판정 코어)
  const sc2 = await bmCollectHealthView({ user: { username: 'opb', role: 'operator', scope: { vcenters: ['vcB'] } } }, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] }, deps);
  assert.equal(sc2.rows[0].nodeState, 'attention'); assert.ok(sc2.rows[0].flags.includes('auth') && sc2.rows[0].flags.includes('success'), JSON.stringify(sc2.rows[0].flags));
});
