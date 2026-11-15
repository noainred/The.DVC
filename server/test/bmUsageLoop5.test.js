/**
 * 베어메탈 사용률 점검 반복 5회차(기준판 2d8d9e5a7 — 3 · 4회차 병합 판) — 성능 · DB · 폴러 확정 5건 + 개선 1건을 재현한 입력으로 고정한다.
 *   D1 정비 창 배포의 엣지 봉투 자동 인출이 사람 인출과 같은 상한(EDGE_PULL_LIMIT)으로 — 예전 limit 없이 400대에서 잘림(실제 collector 라우터 · 실제 pullBmUsage 자기 왕복) ·
 *      범위 계정에는 잘린 대수 대신 사실만 · 배포 현황이 잘림을 밝힌다
 *   D2 다섯 지표 알림은 대기열 — 응답 없는 웹훅이 주기를 붙잡지 않는다(실제 alerts 대기열 · 연결만 받고 답하지 않는 로컬 웹훅)
 *   D3 채널 실패는 ‘발송’ 이 아니다 — deliveryOutcome 으로 가르고 retryDelayMs 로 다시 보낸다(500 을 돌려주는 로컬 웹훅)
 *   D4 대상 전수 정비 창 판정은 같은 시각 · 같은 창의 발생을 한 번만 센다(값 같음 · 비용 비율)
 *   D5 요청 경로의 서버 루프는 양보한다(perfForRows · 함대 프로파일 — 결과 같음)
 *   I1 작업 로그는 간격 묶음 쓰기(서로 다른 틱 기록 N건 → 쓰기 2번 · 즉시 읽기 · 종료 flush)
 * 시간은 비율 · 상한으로만 단언한다(절대 ms 는 CI 에서 흔들린다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop5-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_TOKEN = 'tok-l5';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;
const EDGE = 'l5-edge';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcE', name: 'KR-E', host: 'e.invalid', collectMode: 'site', remoteAgent: EDGE }] }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 5회차 재확인 R2: 최상위 await(웹훅 listen)를 모든 test() 등록보다 앞에 둔다 — D1 하나만 위에 있을 때 --test-name-pattern 으로 D1 을 거르거나 D1 이 곧바로 끝나면(sqlite 없음 skip) 실행이 끝나지 않았다.
/** 로컬 웹훅 하나(실제 alerts.json — 모듈이 처음 읽기 전에 쓴다). mode: stall(연결만 받고 답하지 않는다) · fail(500) · ok(200). */
let hookMode = 'ok'; let hookHits = 0; const held = [];
const hook = http.createServer((req, res) => { hookHits += 1; req.resume(); req.on('end', () => { if (hookMode === 'stall') { held.push(res); return; } res.statusCode = hookMode === 'fail' ? 500 : 200; res.end('x'); }); });
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
hook.unref();   // 5회차 재확인 R2: 남은 핸들이 시험 프로세스를 붙잡지 않게
fs.writeFileSync(path.join(DIR, 'alerts.json'), JSON.stringify({ channels: { webhook: { enabled: true, url: `http://127.0.0.1:${hook.address().port}/hook` } }, suppressWindowMin: 0 }));
test.after(() => { for (const r of held) { try { r.socket?.destroy(); } catch { /* */ } } hook.close(); });

test('D1 — 정비 창 배포의 자동 인출도 사람 인출과 같은 상한(500대 엣지 — 예전 400대에서 잘림) · 범위 계정에는 잘린 대수 대신 사실만 · 배포 현황이 잘림을 밝힌다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const N = 500;
  const tag = (i) => `L5TAG${String(i).padStart(4, '0')}`;
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: Array.from({ length: N }, (_, i) => ({ id: `r-${i}`, name: `idrac-${i}`, host: `10.50.${Math.floor(i / 250)}.${(i % 250) + 1}`, username: 'root', password: 'p', serviceTag: tag(i), vcenterId: 'vcE' })) }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcE: true }, osSsh: false, idracTelemetry: true }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: Array.from({ length: N }, (_, i) => ({ serverId: `r-${i}`, name: `bm-${i}`, serviceTag: tag(i), vcenterId: 'vcE' })), virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: EDGE, name: EDGE, url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-l5' }).ok, true);
  const E = await import('../src/central/bmUsageEdgePull.js');
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  // 자동 인출의 실제 경로 — 그 엣지 법인에 태그 창이 있고 대상을 모른다 → deployFor 가 봉투를 자동으로 당긴다
  const ST = await import('../src/bmusage/maint/store.js'); const S = await import('../src/bmusage/maint/schedule.js');
  const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
  const T0 = Math.floor(Date.now() / HOUR) * HOUR;
  await ST.addWindow({ name: '웹 롤아웃', reason: 'r', target: { kind: 'tag', tag: 'role:web' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: { kind: 'once', start: loc(T0 + HOUR), end: loc(T0 + 2 * HOUR) }, scopes: { alerts: true } }, { by: 'own', now: T0 });
  const DP = await import('../src/bmusage/maint/deploy.js');
  DP._resetMaintDeployForTest(); E._resetForTest();
  const body = await DP.deployFor(EDGE, { verified: true, now: Date.now() });
  assert.equal(body.targetsUnknown, true, '대상을 몰라 자동 인출을 걸었다');
  let rec = null;
  for (let i = 0; i < 200 && !(rec = E.getEdgeBmUsage(EDGE))?.snap; i += 1) await sleep(50);
  assert.ok(rec?.snap, JSON.stringify(rec || {}).slice(0, 300));
  assert.equal(rec.snap.targets.length, N, `자동 인출 보관분 ${rec.snap.targets.length}대(재현 r5 — 예전 400대 · truncated 100)`);
  assert.equal(rec.snap.truncated || 0, 0);
  // 엣지 쪽 상한과 같은 수(사람 인출 · 자동 인출이 이 상수 하나)
  assert.equal(E.EDGE_PULL_LIMIT, (await import('../src/bmusage/edgePull.js')).MAX_LIMIT);
  // 범위 계정 — 잘린 대수(엣지 전체 · 다른 법인 포함)는 주지 않고 사실만 · 전체 범위는 수
  E.putEdgeBmUsage(EDGE, { ok: true, snap: { ...rec.snap, truncated: 600 } });
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcE', name: 'KR-E' }, { id: 'vcB', name: 'B' }] });
  const USERS = { adm: { username: 'adm', role: 'admin', scope: null }, opE: { username: 'ope', role: 'operator', scope: { vcenters: ['vcE'] } } };
  const app2 = express(); app2.use(express.json()); app2.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); }); app2.use('/api', api);
  const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv2.close());
  const get = async (u) => (await (await fetch(`http://127.0.0.1:${srv2.address().port}/api/tools/bm-usage/edges`, { headers: { 'x-u': u } })).json());
  const ra = (await get('adm')).rows.find((x) => x.agent === EDGE);
  const ro = (await get('opE')).rows.find((x) => x.agent === EDGE);
  assert.equal(ra.truncated, 600);
  assert.equal(ro.truncated, true, '범위 계정 — 잘렸다는 사실만(엣지 전체 대수를 주지 않는다)');
  // 배포 현황 — 그 엣지 보관분이 잘렸으면 태그 창 펼침이 받은 대상만이라는 사실을 싣는다
  const view = await DP.deployStatusView(E.listEdgeBmUsage(), Date.now());
  assert.equal(view.edges.find((x) => x.agent.toLowerCase() === EDGE).targetsTruncated, 600);
});

const rowsOf = (keys, v = 99) => keys.map((k) => ({ key: k, name: `bm-${k}`, vcenterId: 'vcA', cpu_pct: v }));
const settingsOf = () => ({ alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, maintJudge: { stateFor: () => null } });

test('D2 — 응답 없는 웹훅이 있어도 알림 주기는 기다리지 않는다(대기열 — 예전 순차 await 로 1건당 시한만큼 주기가 묶였다)', async (t) => {
  hookMode = 'stall';   // 연결은 받고 답하지 않는다(응답을 쥐고 있다)
  t.after(() => { hookMode = 'fail'; for (const r of held.splice(0)) { try { r.socket?.destroy(); } catch { /* */ } } });   // 실패해도 쥔 연결을 남기지 않는다
  const N = await import('../src/bmusage/notify.js');
  N._resetAlertStateForTest();
  const t0 = performance.now();
  const r = await N.runBmUsageAlerts(rowsOf(['H1', 'H2', 'H3']), settingsOf());
  const ms = performance.now() - t0;
  // 웹훅 시한은 15초 × 재시도 — 예전 순차 await 면 첫 건 시한만으로 15초 이상(재현 r5: 3건 91.5초). 대기열이면 그 시한의 1/10 안에 돌아온다.
  assert.ok(ms < 1_500, `알림 주기 ${Math.round(ms)}ms(웹훅 시한 15,000ms 의 1/10 미만이어야)`);
  assert.equal(r.queued, 3);
  const d = N.alertStateInfo().delivery;
  assert.equal(d.queued, 3); assert.equal(d.pending, 3, '보내는 중 — 결과가 오기 전에는 보냄으로 세지 않는다');
  hookMode = 'fail'; for (const r of held.splice(0)) { try { r.socket?.destroy(); } catch { /* */ } }   // 쥐고 있던 연결을 끊는다(재시도는 500 — 대기열 정리)
  await N._drainBmUsageAlertsForTest();
});

test('D3 — 채널 실패는 ‘발송’ 이 아니다: 실패 수 · 재시도 예약(retryDelayMs 5분) · 받으면 재시도 지움', async () => {
  hookMode = 'fail'; const hits0 = hookHits;
  const AL = await import('../src/alerts.js');
  const N = await import('../src/bmusage/notify.js');
  N._resetAlertStateForTest();
  const r = await N.runBmUsageAlerts(rowsOf(['F1']), settingsOf());
  assert.equal(r.sent, undefined, '재현 r5 — 예전 sent 1(채널 실패를 발송으로) · 주기 결과는 넣은 수만(받은 결과를 단정하지 않는다)');
  assert.equal(r.queued, 1);
  await N._drainBmUsageAlertsForTest();
  assert.ok(hookHits > hits0);
  const d = N.alertStateInfo().delivery;
  assert.deepEqual([d.sent, d.failed, d.retry, d.pending], [0, 1, 1, 0], `재현 r5 — 예전 sent 1(실패를 발송으로) · ${JSON.stringify(d)}`);
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-alert-state.json'), 'utf8')).metrics;
  const s1 = st['F1|cpu_pct'];
  assert.equal(s1.retries, 1);
  assert.equal(N.alertStateInfo().notified, 0, '재시도를 기다리는 것은 ‘알린 것’ 으로 세지 않는다');
  const repeatMs = 6 * HOUR;
  const nextAt = s1.notifiedAt + repeatMs;   // 다음 판정이 다시 보내는 시각(재알림 간격이 지난 것으로 본다)
  assert.ok(Math.abs(nextAt - Date.now() - AL.RETRY_DELAYS_MS[0]) < MIN, `재시도는 약 ${AL.RETRY_DELAYS_MS[0] / MIN}분 뒤(예전: 재알림 간격 6시간 뒤)`);
  // 받으면 — 보냄 · 재시도 지움(다른 키 — 같은 키는 다음 판정 시각 전이라 지금 다시 나가지 않는다)
  hookMode = 'ok';
  await N.runBmUsageAlerts(rowsOf(['F2']), settingsOf());
  await N._drainBmUsageAlertsForTest();
  const d2 = N.alertStateInfo().delivery;
  assert.deepEqual([d2.queued, d2.sent, d2.failed], [1, 1, 0]);
  // 순수 — 같은 함수로: 받음은 재시도 지움 · 정책상 안 보냄은 그대로 · 이미 다른 주기 것이면 건드리지 않음
  const state = { 'K|cpu_pct': { notifiedAt: 1000, retries: 1 } };
  assert.equal(N.applyAlertOutcome(state, { id: 'K|cpu_pct', mark: 1000, kind: 'over', outcome: 'delivered', repeatMs }), true); assert.equal(state['K|cpu_pct'].retries, undefined);
  assert.equal(N.applyAlertOutcome(state, { id: 'K|cpu_pct', mark: 1000, kind: 'over', outcome: 'skipped', repeatMs }), false);
  assert.equal(N.applyAlertOutcome(state, { id: 'K|cpu_pct', mark: 999, kind: 'over', outcome: 'failed', repeatMs }), false, '그 사이 다시 보낸 상태는 건드리지 않는다');
  assert.equal(N.applyAlertOutcome(state, { id: 'K|cpu_pct', mark: 1000, kind: 'recovered', outcome: 'failed', repeatMs }), false, '해제 실패는 상태가 없어 재시도하지 않는다');
});

test('R1(5회차 재확인) — 채널이 계속 실패하면 재시도는 두 번에서 멈춘다(재시도 수를 주기마다 들고 간다) · 그 뒤는 재알림 간격대로', async (t) => {
  const AL = await import('../src/alerts.js');
  const N = await import('../src/bmusage/notify.js');
  const AR = await import('../src/bmusage/alertRules.js');
  N._resetAlertStateForTest();
  hookMode = 'fail';
  const realNow = Date.now; let off = 0;
  Date.now = () => realNow() + off;
  t.after(() => { Date.now = realNow; hookMode = 'ok'; });
  const hits0 = hookHits; const tries = [];
  for (let m = 0; m <= 180; m += 5) {   // 5분 주기 · 3시간(재알림 간격 6시간 안)
    off = m * MIN;
    const h = hookHits;
    await N.runBmUsageAlerts(rowsOf(['R1']), settingsOf());
    await N._drainBmUsageAlertsForTest();
    if (hookHits > h) tries.push(m);
  }
  assert.equal(tries.length, 1 + AL.RETRY_DELAYS_MS.length, `재현 r5 재확인 R1 — 예전: 10분마다 영원히(180분에 18번) · 시도 ${JSON.stringify(tries)}`);
  assert.ok(hookHits - hits0 >= tries.length);
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-alert-state.json'), 'utf8')).metrics['R1|cpu_pct'];
  assert.equal(st.retries, AL.RETRY_DELAYS_MS.length, '재시도 수가 주기를 넘어 이어진다');
  // 순수 — stepAlert 가 재시도 수를 들고 간다(초과 지속 · 억제 중 · 경계 떨림) · 받으면(applyAlertOutcome) 지운다
  const cfg = { pct: 90, sustainMin: 0, repeatHours: 6, intervalMs: 300_000 };
  const T = 1_000_000_000_000;
  const a = AR.stepAlert({ since: T - MIN, lastOverAt: T - MIN, overMs: 0, peak: 99, notifiedAt: T - 2 * MIN, retries: 2 }, 99, cfg, T);
  assert.equal(a.state.retries, 2);
  const b = AR.stepAlert(a.state, 88, cfg, T + 5 * MIN);   // 히스테리시스(임계 바로 아래 · 해제 문턱 위) — 상태 유지
  assert.equal(b.state?.retries, 2);
  assert.equal(AR.stepAlert({ since: T, lastOverAt: T, overMs: 0, peak: 99, notifiedAt: null }, 99, cfg, T + MIN).state.retries, undefined, '재시도가 없으면 필드도 없다');
});

test('D4 — 대상 전수 정비 창 판정: 같은 시각 · 같은 창의 발생을 한 번만(값 같음 · 비용 비율)', async () => {
  const R = await import('../src/bmusage/maint/runtime.js');
  const J = await import('../src/bmusage/maint/judge.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const now = Math.floor(Date.now() / HOUR) * HOUR + 7 * MIN;
  const corps = Array.from({ length: 30 }, (_, i) => `vc${i}`);
  const wins = [];
  const mk = (i, target, vc, schedule) => ST.normalizeWindow({ id: `mw-d4${String(i).padStart(5, '0')}`, name: 'w', reason: 'r', tz: 'Asia/Seoul', vcenterId: vc, target, schedule, scopes: { alerts: true, collect: true }, at: now - DAY, confirmedAt: now - DAY });
  corps.forEach((vc, i) => {
    wins.push(mk(i * 3, { kind: 'corp' }, vc, { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '02:00', durMin: 120 }));
    wins.push(mk(i * 3 + 1, { kind: 'corp' }, vc, { kind: 'monthly', nth: 2, weekday: 6, time: '01:00', durMin: 240 }));
    wins.push(mk(i * 3 + 2, { kind: 'server', keys: Array.from({ length: 20 }, (_, k) => `${vc}-S${k}`) }, vc, { kind: 'weekly', days: [1, 3, 5], time: '03:00', durMin: 60 }));
  });
  const targets = Array.from({ length: 1_000 }, (_, i) => ({ key: `${corps[i % 30]}-S${Math.floor(i / 30)}`, vcenterId: corps[i % 30] }));
  const MJ = await R.maintJudge({ now, tagsOf: () => [], windowsOf: () => ({ windows: wins, deployed: null }) });
  const timeIt = (fn) => { const t0 = performance.now(); const out = targets.map(fn); return { ms: performance.now() - t0, out }; };
  timeIt((tg) => MJ.stateFor(tg, now)); timeIt((tg) => J.maintStateFor(wins, tg, now));   // 데우기
  const memo = timeIt((tg) => MJ.stateFor(tg, now));
  const direct = timeIt((tg) => J.maintStateFor(wins, tg, now));
  assert.deepEqual(memo.out, direct.out, '값은 같다(메모 없는 판정 코어와 대조)');
  assert.ok(memo.ms <= 0.5 * direct.ms + 5, `메모 ${Math.round(memo.ms)}ms · 직접 ${Math.round(direct.ms)}ms(재현 r5 — 예전 판정기는 직접과 같았다: 1,000대 · 창 90개 304ms 단일 정지)`);
  // 시각이 바뀌면 그 시각의 발생으로(오래된 기억을 쓰지 않는다)
  const later = now + 3 * HOUR;
  assert.deepEqual(MJ.stateFor(targets[0], later), J.maintStateFor(wins, targets[0], later));
  // 폴러 — 대상 전수 판정은 한 시각 · 대상 사이 양보(배선)
  const src = fs.readFileSync(new URL('../src/bmusage/poller.js', import.meta.url), 'utf8');
  assert.match(src, /const tM = Date\.now\(\); const yM = createYielder\(15\);\n\s+for \(const tg of realTargets\) \{\n\s+const ms = mj \? mj\.stateFor\(tg, tM\) : null;[\s\S]{0,200}await yM\(\);/);
});

test('D5 — 요청 경로 서버 루프는 양보한다(perfForRows · 함대 프로파일 — 결과 같음)', async () => {
  const EP = await import('../src/bmusage/edgePull.js');
  const S = await import('../src/bmusage/settings.js');
  const s = S.loadBmUsageSettings();
  const rows = Array.from({ length: 300 }, (_, i) => ({ key: `P${i}`, agent: '', ts: Date.now(), cpu_pct: (i * 7) % 100, mem_pct: 50, disk_busy_pct: 10, net_pct: 5, hba_pct: null }));
  let yields = 0;
  const a = await EP.perfForRows(rows, [], s, { full: false, now: 1_800_000_000_000, yieldFn: async () => { yields += 1; } });
  const b = await EP.perfForRows(rows, [], s, { full: false, now: 1_800_000_000_000 });
  assert.equal(yields, rows.length, `서버마다 양보 기회(${yields} — 재현 r5: 예전 0)`);
  assert.deepEqual(a, b, '결과 · 순서 같음');
  // 함대 프로파일 — 같은 누적기(동기 · 비동기 결과 같음)
  const O = await import('../src/bmusage/opsView.js');
  const items = rows.slice(0, 120).map((r, i) => ({ key: r.key, name: r.key, vcenterId: 'vcA', row: r, tuning: i % 3 ? { at: 1, kernel: '5.14' } : null, detail: null, entry: a.perf[i], manual: null }));
  let fy = 0;
  const v1 = O.fleetProfileView(items);
  const v2 = await O.fleetProfileViewAsync(items, { yieldFn: async () => { fy += 1; } });
  assert.deepEqual(v2, v1); assert.equal(fy, items.length);
  const route = fs.readFileSync(new URL('../src/routes/api/bmUsage.js', import.meta.url), 'utf8');
  assert.match(route, /await O\.fleetProfileViewAsync\(/, '/profiles 는 양보하는 판본');
});

test('I1 — 작업 로그는 간격 묶음 쓰기: 서로 다른 틱의 기록 200건 → 쓰기 2번(예전 200번) · 즉시 읽기 · 종료 flush', async () => {
  const { createActivityLog, ACTIVITY_WRITE_GAP_MS } = await import('../src/util/activityLog.js');
  const { runExitFlush } = await import('../src/util/exitFlush.js');
  const log = createActivityLog({ fileName: 'loop5-activity.json', numFields: ['cpuPct'] });
  const orig = fs.renameSync; let writes = 0;
  fs.renameSync = function patched(a, b) { if (b === log.FILE) writes += 1; return orig.apply(this, arguments); };
  try {
    for (let i = 0; i < 200; i += 1) { log.recordActivity({ deviceId: `S${i}`, ok: true, at: 1_800_000_000_000 + i, cpuPct: i }); await new Promise((r) => setImmediate(r)); }
    assert.equal(writes, 1, `첫 기록만 곧바로(앞 경계) — 나머지는 간격 끝(실제 ${writes}회 · 재현 r5: 예전 200회)`);
    assert.equal(log.listActivity(1)[0].deviceId, 'S199', '조회는 즉시(대기분을 먼저 쓴다)');
    assert.equal(writes, 2, '조회가 대기분을 썼다');
    log.recordActivity({ deviceId: 'late', ok: false, error: 'x' });
    runExitFlush('test');
    assert.equal(JSON.parse(fs.readFileSync(log.FILE, 'utf8')).at(-1).deviceId, 'late', '종료 flush 가 대기분을 쓴다');
    log.recordActivity({ deviceId: 'tail', ok: true });
    await sleep(ACTIVITY_WRITE_GAP_MS + 200);
    assert.equal(JSON.parse(fs.readFileSync(log.FILE, 'utf8')).at(-1).deviceId, 'tail', '간격 끝에 쓴다(타이머)');
    assert.equal((fs.statSync(log.FILE).mode & 0o777), 0o600);
    // 5회차 재확인 R3: 간격은 단조 시계 — 벽시계가 1시간 뒤로 가도 뒤 경계는 간격 끝(예전: 1시간 뒤에야 써서 그 사이 강제 종료면 유실)
    const realNow = Date.now;
    try {
      await sleep(ACTIVITY_WRITE_GAP_MS + 50);   // 직전 쓰기에서 간격이 지나게(대기 타이머 없음)
      log.recordActivity({ deviceId: 'pre', ok: true });   // 앞 경계 — 곧바로 쓴다(타이머 없음 — 뒤 'back' 은 새 타이머가 쓴다)
      Date.now = () => realNow() - 3_600_000;
      log.recordActivity({ deviceId: 'back', ok: true });
      await sleep(ACTIVITY_WRITE_GAP_MS + 300);
      assert.equal(JSON.parse(fs.readFileSync(log.FILE, 'utf8')).at(-1).deviceId, 'back', '시계가 뒤로 가도 간격 끝에 쓴다');
    } finally { Date.now = realNow; }
  } finally { fs.renameSync = orig; }
});
