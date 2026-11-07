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
  assert.deepEqual(c1.cells, { cycle: 'true', success: 'true', db: 'true', auth: 'true' });
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
  assert.equal(byAgent['edge-old'].state, 'old-version', '봉투에 필드가 없으면 엣지 버전 낮음');
  assert.ok(a.body.minEdgeVersion, '문구의 최소 버전(릴리스 노트 6단계 · 없으면 package.json)');
  assert.ok(byAgent['edge-new'].node, '전체 범위 — 노드 값이 보인다');
  assert.ok(a.body.rows.some((r) => r.vcenterId === 'vcB' && r.servers === 5));
  assert.ok(!a.body.rows.some((r) => r.vcenterId === 'vcZ'), '엣지 대상 · 설정 법인이 아닌 byCorp 는 행이 되지 않는다'); assert.equal(a.body.corpsDropped, 1);
  assert.equal(a.body.kpi.corpsUnknown, 1, '구버전 엣지의 법인(vcC)은 모름 — 0 으로 더하지 않고 개수를 센다');
  assert.ok(a.body.kpi.servers >= 5 && a.body.rows.find((r) => r.vcenterId === 'vcC').servers === null);
  const la = byAgent['edge-new'].lastAttempt;
  assert.ok(la && la.reason === undefined, '마지막 당김은 사유 원문 없이');
  // 범위 계정(vcA) — 자기 법인 행만 · 로컬 노드는 vcB 도 켰으니 노드 값(주기 · SSH · DB · 추이 · 며칠째)은 숨김 · vcB/vcC 만 가진 엣지는 행 없음
  const o = await get('opA');
  assert.equal(o.status, 200);
  assert.ok(o.body.rows.every((r) => r.vcenterId === 'vcA'), JSON.stringify(o.body.rows.map((r) => r.vcenterId)));
  assert.ok(o.body.nodes.every((x) => x.nodeHidden === true && x.node === undefined), '다른 법인이 섞인 노드 값은 숨김');
  assert.equal(o.body.nodesOmitted, 2, '보이는 법인이 없는 엣지는 행을 주지 않는다(개수만)');
  assert.ok(o.body.reasons.every((x) => x.since == null), '며칠째(노드 값)는 숨김');
  assert.equal(o.body.kpi.dbBytes, null);
});

test('⑤ 저장 실측 — 폴더 · 파일을 못 읽으면 크기는 모름(null) · 부분 합을 내지 않는다', async () => {
  const miss = await CH.dbFilesNow(path.join(DIR, 'no-such-dir'));
  assert.equal(miss.bytes, null, '폴더를 못 읽으면 0 이 아니다'); assert.equal(miss.files, null); assert.equal(miss.error, 'readdir');
  assert.equal(CH.collectCells({ cyclePct: 10, successPct: 100 }, miss).cells.db, 'unread', '모르는 크기는 상한 대조 보류');
  const d = fs.mkdtempSync(path.join(DIR, 'dbf-'));
  fs.writeFileSync(path.join(d, 'bm-usage.db'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(d, 'bm-usage-2026-10.db'), Buffer.alloc(500));
  const ok = await CH.dbFilesNow(d);
  assert.equal(ok.bytes, 1500); assert.equal(ok.files, 1); assert.equal(ok.families.raw.files, 1);
  fs.symlinkSync(path.join(d, 'gone.db'), path.join(d, 'bm-usage-2026-11.db'));   // 끊긴 링크 — stat 실패
  const part = await CH.dbFilesNow(d);
  assert.equal(part.bytes, null, '못 읽은 파일이 있으면 합을 내지 않는다(부분 합 금지)'); assert.equal(part.unread, 1);
});
