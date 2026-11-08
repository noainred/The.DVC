/**
 * 리눅스 성능 8b단계 ㉑ — 저활용 서버 찾기(점수 · 분모 환산 · 제외 집계 · 주기 사용 · 하루 계산 · 봉투 정제 · 실제 라우터 · 검토 상태 쓰기).
 *   ① 점수(순수): 지표마다 기준 안 = 전부 · 2배 안 = 절반 · 넘으면 0 · **없는 지표는 분모에서 빼고 100 으로 환산**(뺀 지표 표시) · 남은 가중 0 = 점수 없음
 *   ② 상태: 데이터 부족(<21일) · 정비 창 중 = 제외 · 주기 사용(높은 날 2 ~ 주 수+1 · 나머지 낮음) · 후보 · 관찰 · 사용 중 · 요약은 (법인, 키) 쌍으로 · 후보 전력 합은 측정한 것만
 *   ③ 하루 계산: 실제 일 롤업(1d 연 파일) · 전력 0 W 시간은 미측정 · 후보 시작/이탈 이어 쓰기 · 진입/이탈 = 변경 이벤트(kind idle) · 결과 파일
 *   ④ 봉투 정제: 대상 밖 키 · 모르는 상태 · 점수 범위 밖 · 엣지 시각 · 열거 밖 뺀 지표
 *   ⑤ 라우트: 이 노드 + 엣지 봉투 · 범위(법인) · 검토 상태(대기 · DR = 제외 사유 dr · 점수는 남김) · 쓰기 404(조회 밖) → 403(쓰기 밖) · 유지 사유 필수 · 감사
 *   ⑧ 반증 F5: 실제 7a 분류 → 실제 logWriteBatch → 실제 recomputeIdle(활동 읽기 실제) — 포탈 수집 계정(+ 출발 주소)의 로그인은 활동이 아니다 · 못 가르면 모름(null)
 *   ⑨ 반증 F9: 검토 쓰기 대상 = (법인, 키) 쌍 — 같은 키 두 법인에서 B 행 검토는 B 에 적히고 B 만 보는 운영자도 쓸 수 있다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8bidle-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const I = await import('../src/bmusage/idle.js');

const LOW = { days: 30, cpuAvg: 1.2, cpuMax: 6, memAvg: 9, diskMax: 0.4, netMax: 0.1, highDays: 0, lowRest: true };
test('① 점수 — 기준 · 절반 · 0 · 분모 환산 · 뺀 지표', () => {
  const full = I.scoreIdle({ metrics: LOW, power: { avgW: 148, minW: 140 }, activity: { ssh: 0, focus: 0, snap: 0 } });
  assert.equal(full.score, 100); assert.equal(full.status, 'candidate'); assert.deepEqual(full.dropped, []);
  // 전력 · 활동이 없으면 그 가중(15 + 10)을 분모에서 뺀다 — 나머지가 다 ‘낮다’ 면 여전히 100(전력 없는 서버가 불리하지 않게)
  const np = I.scoreIdle({ metrics: LOW, power: null, activity: null });
  assert.equal(np.score, 100); assert.deepEqual(np.dropped, ['power', 'act']);
  // CPU 만 절반(평균 7% — 2배 안) · 나머지 낮음: (30×0.5 + 15+15+15) / 75 = 80
  const half = I.scoreIdle({ metrics: { ...LOW, cpuAvg: 7 }, power: null, activity: null });
  assert.equal(half.score, 80); assert.equal(half.grades.cpu, 0.5);
  // CPU 일 최대 45%(2배 넘음) → CPU 0 · (0 + 45) / 75 = 60 → 관찰
  const w = I.scoreIdle({ metrics: { ...LOW, cpuMax: 45 }, power: null, activity: null });
  assert.equal(w.score, 60); assert.equal(w.status, 'watch');
  // 전력: 평균이 최소 × 1.10 안 = 1 · 1.20 안 = 0.5 · 넘으면 0
  assert.equal(I.scoreIdle({ metrics: LOW, power: { avgW: 160, minW: 140 } }).grades.power, 0.5);
  assert.equal(I.scoreIdle({ metrics: LOW, power: { avgW: 200, minW: 140 } }).grades.power, 0);
  // 활동: SSH 를 모르면 칸 전체 —(집중 · 스냅샷만으로 ‘흔적 없음’ 이라 하지 않는다)
  assert.equal(I.scoreIdle({ metrics: LOW, activity: { ssh: null, focus: 0, snap: 0 } }).grades.act, null);
  assert.equal(I.scoreIdle({ metrics: LOW, activity: { ssh: 3, focus: 0, snap: 0 } }).grades.act, 0);
  // 지표가 하나도 없으면 점수 없음(0 이 아니다) → 제외(no-score)
  const none = I.scoreIdle({ metrics: { days: 30 } });
  assert.equal(none.score, null); assert.equal(none.status, 'excluded'); assert.equal(none.reason, 'no-score');
  // 가중치 설정(전력만 남기고 0) — 분모 = 전력 가중뿐
  assert.equal(I.scoreIdle({ metrics: LOW, power: { avgW: 200, minW: 140 }, cfg: { wCpu: 0, wMem: 0, wDisk: 0, wNet: 0, wAct: 0 } }).score, 0);
});

test('② 상태 · 요약', () => {
  assert.equal(I.scoreIdle({ metrics: { ...LOW, days: 20 } }).status, 'excluded', '21일 미만 = 데이터 부족');
  assert.equal(I.scoreIdle({ metrics: { ...LOW, days: 20 } }).score, null, '데이터 부족은 점수를 내지 않는다');
  assert.equal(I.scoreIdle({ metrics: LOW, maintActive: true }).reason, 'maint');
  // 주기 사용 — 일 최대가 높은 날 4일(30일 = 5주) · 나머지는 낮음 → 점수와 무관하게 주기 사용
  const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(NOW - (30 - i) * DAY).toISOString().slice(0, 10), cpu_sum: 30, cpu_n: 10, cpu_max: i % 7 === 3 ? 71 : 6, mem_sum: 100, mem_n: 10, disk_busy_max: i % 7 === 3 ? 60 : 2, net_max: 0.5 }));
  const m = I.windowMetrics(days, { periodicHighPct: 50 });
  assert.equal(m.days, 30); assert.equal(m.highDays, 4); assert.equal(m.lowRest, true); assert.equal(m.sameWeekday, true);
  const sc = I.scoreIdle({ metrics: m });
  assert.equal(sc.status, 'periodic'); assert.equal(sc.periodic.highDays, 4);
  // 높은 날이 많으면(매일 바쁨) 주기 사용이 아니다
  const busy = days.map((d) => ({ ...d, cpu_max: 80 }));
  assert.notEqual(I.scoreIdle({ metrics: I.windowMetrics(busy) }).status, 'periodic');
  // 요약 — (법인, 키) 쌍 · 제외 사유별 · 후보 전력은 측정한 것만
  const s = I.summarizeIdle([
    { key: 'A', vcenterId: 'v1', status: 'candidate', metrics: { powerAvgW: 150 } }, { key: 'A', vcenterId: 'v2', status: 'candidate', metrics: { powerAvgW: null } },
    { key: 'A', vcenterId: 'v1', status: 'candidate', metrics: { powerAvgW: 999 } },   // 같은 (법인, 키) 두 번 — 한 대
    { key: 'B', vcenterId: 'v1', status: 'excluded', reason: 'insufficient' }, { key: 'C', vcenterId: 'v1', status: 'excluded', reason: 'maint' }, { key: 'D', vcenterId: 'v1', status: 'watch' },
  ]);
  assert.equal(s.servers, 5); assert.equal(s.candidate, 2, 'IP 키가 법인 사이에 겹쳐도 다른 서버(8a 반증 F1)');
  assert.equal(s.candPowerW, 150); assert.equal(s.candPowerMeasured, 1); assert.equal(s.candPowerUnmeasured, 1);
  assert.equal(s.excludedBy.insufficient, 1); assert.equal(s.excludedBy.maint, 1);
  // 후보 시작 · 이탈 이어 쓰기 · 진입/이탈 전이
  const prev = [{ key: 'A', vcenterId: 'v1', status: 'candidate', candSince: '2026-10-01', score: 80 }, { key: 'B', vcenterId: 'v1', status: 'watch', score: 50 }];
  const rows = [{ key: 'A', vcenterId: 'v1', status: 'active', score: 20 }, { key: 'B', vcenterId: 'v1', status: 'candidate', score: 75 }];
  I.carryCandidacy(prev, rows, '2026-11-08');
  assert.equal(rows[0].candLeft, '2026-11-08'); assert.equal(rows[1].candSince, '2026-11-08');
  const tr = I.idleTransitions(prev, rows, { now: NOW });
  assert.equal(tr.length, 2); assert.equal(tr[0].events[0].kind, 'idle'); assert.match(tr[0].events[0].before, /^후보 80점$/);
  assert.equal(I.idleTransitions([], rows).length, 0, '직전 결과가 없으면 이벤트 없음(기준만)');
});

test('③ 하루 계산 — 실제 일 롤업 · 전력 0 W 시간 · 이력 · 변경 이벤트', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  const db = await import('../src/bmusage/db.js');
  const rows = [];
  for (let d = 25; d >= 1; d -= 1) for (const h of [2, 14]) {
    const ts = NOW - d * DAY + h * HOUR;
    rows.push({ key: 'IDLE1', ts, cpu_pct: 1, mem_pct: 8, disk_busy_pct: 0.5, net_pct: 0.1, os_at: ts });
    rows.push({ key: 'BUSY1', ts, cpu_pct: 70, mem_pct: 60, disk_busy_pct: 40, net_pct: 30, os_at: ts });
    if (d <= 10) rows.push({ key: 'NEW1', ts, cpu_pct: 1, mem_pct: 5, os_at: ts });
  }
  await db.insertUsage(rows, agent);
  const targets = [{ key: 'IDLE1', name: 'bm-idle', vcenterId: 'vcI', idrac: { regId: 'r1' } }, { key: 'BUSY1', name: 'bm-busy', vcenterId: 'vcI' }, { key: 'NEW1', name: 'bm-new', vcenterId: 'vcI' }];
  const powerOf = (tg) => (tg.key === 'IDLE1' ? I.powerStats([...Array.from({ length: 80 }, (_, i) => ({ avg: i % 10 ? 150 : 140 })), { avg: 0 }, { avg: 0 }]) : null);
  const events = [];
  const deps = { rules: { idle: {} }, judge: null, powerOf, activityOf: () => ({ ssh: 0, focus: 0, snap: 0 }), opsDb: { changeWriteBatch: async (x) => { events.push(...x.items); return { events: x.items.length }; } } };
  I._resetIdleForTest();
  const r1 = await I.recomputeIdle({ targets, now: NOW, force: true, deps });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const out = I.loadIdle();
  const by = Object.fromEntries(out.rows.map((x) => [x.key, x]));
  assert.equal(by.IDLE1.status, 'candidate'); assert.equal(by.IDLE1.metrics.powerMinW, 140, '0 W 시간은 최소에 들어가지 않는다(미측정)');
  assert.equal(by.BUSY1.status, 'active'); assert.deepEqual(by.BUSY1.dropped, ['power'], '전력 없는 서버 — 뺀 지표에 적는다');
  assert.equal(by.NEW1.status, 'excluded'); assert.equal(by.NEW1.reason, 'insufficient'); assert.equal(by.NEW1.days, 10);
  assert.equal(out.history.at(-1).candidate, 1); assert.equal(out.firstDay, out.day);
  assert.equal(events.length, 0, '첫 계산은 전이 없음');
  // 다음 날 — BUSY1 이 한가해졌다고 하자(직전 결과를 고쳐 진입 전이 확인)
  const cur = I.loadIdle();
  I.saveIdle({ ...cur, rows: cur.rows.map((x) => (x.key === 'IDLE1' ? { ...x, status: 'watch', score: 50 } : x)), day: '2000-01-01' });
  await I.recomputeIdle({ targets, now: NOW, force: true, deps });
  assert.equal(events.length, 1); assert.equal(events[0].key, 'IDLE1'); assert.match(events[0].events[0].after, /^후보/);
  assert.equal(I.loadIdle().rows.find((x) => x.key === 'IDLE1').candSince, I.loadIdle().day);
  assert.equal(I.dueForIdle(I.loadIdle(), NOW), false, '같은 날 다시 계산하지 않는다');
});

test('④ 봉투 정제', async () => {
  const S = await import('../src/central/bmIdleSanitize.js');
  const now = Date.now();
  const e = S.sanitizeIdleEnvelope({ at: now + 99 * DAY, day: '2026-11-08', firstDay: 'x', cfg: { candidate: '70', evil: 1 },
    rows: [{ key: 'K1', status: 'candidate', score: 92, grades: { cpu: 1, mem: 0.7, power: 'x' }, dropped: ['power', 'evil'], metrics: { cpuAvg: '1.2', ssh: '' }, candSince: '2026-11-01', name: 'injected' },
      { key: 'OTHER', status: 'candidate', score: 99 }, { key: 'K2', status: 'pwned' }, { key: 'K3', status: 'watch', score: 250 }],
    history: [{ day: 'bad' }, { day: '2026-11-07', candidate: '3' }] }, { targetKeys: new Set(['K1', 'K2', 'K3']), now });
  assert.equal(e.at, now, '엣지 미래 시각은 수신 시각'); assert.equal(e.firstDay, null); assert.equal(e.cfg.candidate, 70); assert.ok(!('evil' in e.cfg));
  assert.equal(e.rows.length, 2, '대상 밖 키 · 모르는 상태는 버린다'); assert.equal(e.dropped, 2);
  const k1 = e.rows[0];
  assert.equal(k1.grades.mem, null, '등급은 0 · 0.5 · 1 만'); assert.equal(k1.grades.power, null); assert.deepEqual(k1.dropped, ['power']);
  assert.equal(k1.metrics.cpuAvg, 1.2); assert.equal(k1.metrics.ssh, null, '빈 문자열은 0 이 아니라 null'); assert.ok(!('name' in k1), '이름은 대상 목록에서 붙인다');
  assert.equal(e.rows[1].score, null, '점수 범위 밖 = null');
  assert.deepEqual(e.history, [{ day: '2026-11-07', candidate: 3, watch: null, active: null, periodic: null, excluded: null }]);
});

test('⑤ 라우트 — 이 노드 + 엣지 · 범위 · 검토 상태(대기 · DR) · 쓰기 404 → 403 · 감사', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-i1', name: 'bm-idle', host: '127.0.0.2', port: 9, username: 'mon', password: 'pw', mounts: [] }, { id: 'o-j1', name: 'bm-j1', host: '127.0.0.3', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcI: true, vcJ: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-i1', name: 'bm-idle', serviceTag: 'IDLE1', vcenterId: 'vcI' }, { serverId: 's-j1', name: 'bm-j1', serviceTag: 'JTAG1', vcenterId: 'vcJ' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  t.after(() => poller._setFleetForTest(null));
  I.saveIdle({ v: 1, at: NOW, day: '2026-11-08', firstDay: '2026-09-01', cfg: I.IDLE_DEFAULTS, rows: [
    { key: 'IDLE1', vcenterId: 'vcI', name: 'bm-idle', status: 'candidate', score: 92, metrics: { powerAvgW: 150 }, candSince: new Date(NOW - 3 * DAY).toISOString().slice(0, 10) },
    { key: 'JTAG1', vcenterId: 'vcJ', name: 'bm-j1', status: 'candidate', score: 80, metrics: {} },
  ], history: [] });
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('edge-i', { ok: true, snap: { targets: [{ key: 'EI1', name: 'bm-e', vcenterId: 'vcI' }], idleVer: 1, idle: { at: NOW, day: '2026-11-08', firstDay: '2026-11-01', rows: [{ key: 'EI1', status: 'watch', score: 55 }] } } });
  E.putEdgeBmUsage('edge-old', { ok: true, snap: { targets: [{ key: 'OI1', name: 'bm-o', vcenterId: 'vcI' }] } });
  t.after(() => E._resetForTest());
  const audits = [];
  const R = await import('../src/routes/api/bmIdle.js');
  const deps = { audit: (x) => audits.push(x), now: () => NOW };
  const adm = { user: { username: 'adm', role: 'admin', scope: null }, query: {}, params: {}, body: {} };
  const f = await R.bmIdleFleet(adm, { vcenters: [{ id: 'vcI' }, { id: 'vcJ' }] }, deps);
  assert.equal(f.ok, true);
  assert.equal(f.summary.candidate, 2); assert.ok(f.rows.some((x) => x.key === 'EI1' && x.via === 'edge'));
  const src = Object.fromEntries(f.sources.map((s) => [s.node, s]));
  assert.equal(src['edge-old'].old, true, '구버전 엣지 = 표지');
  assert.equal(f.summary.month, null, '엣지 계산 이력이 30일 안 되면 지난 30일 칸은 —(모두 새 후보로 보이지 않게)');
  const opI = { user: { username: 'opi', role: 'operator', scope: { vcenters: ['vcI'] } }, query: {}, params: {}, body: {} };
  const fi = await R.bmIdleFleet(opI, { vcenters: [{ id: 'vcI' }, { id: 'vcJ' }] }, deps);
  assert.ok(fi.rows.every((x) => x.vcenterId === 'vcI'), '범위 계정은 자기 법인 행만'); assert.equal(fi.summary.candidate, 1);
  // 검토 상태 쓰기 — 조회 밖 404 · 쓰기 밖 403 · 유지 사유 필수 · 대기 · DR = 제외(dr) · 감사
  const rv = (user, body) => R.bmIdleReview({ user, body, ip: '' }, deps);
  assert.equal((await rv(opI.user, { key: 'JTAG1', vcenterId: 'vcJ', status: 'review' })).status, 404, '조회 범위 밖 = 404');
  assert.equal((await rv(adm.user, { key: 'IDLE1', status: 'review' })).status, 400, '법인(vcenterId) 없이는 쓰지 않는다(반증 F9)');
  const roI = { username: 'roi', role: 'operator', scope: { vcenters: ['vcI', 'vcJ'], writeVcenters: ['vcJ'] } };   // vcI 는 조회만
  assert.equal((await rv(roI, { key: 'IDLE1', vcenterId: 'vcI', status: 'review' })).status, 403, '조회는 되지만 쓰기 밖 = 403(조회 전용)');
  assert.equal((await rv(adm.user, { key: 'IDLE1', vcenterId: 'vcI', status: 'keep' })).status, 400, '유지는 사유 필수');
  assert.equal((await rv(adm.user, { key: 'IDLE1', vcenterId: 'vcI', status: 'pwn' })).status, 400);
  const ok = await rv(adm.user, { key: 'IDLE1', vcenterId: 'vcI', status: 'dr', reason: 'DR 대기 서버' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.ok(audits.some((a) => a.action === 'bm-perf.idle.review' && a.target === 'IDLE1'));
  const f2 = await R.bmIdleFleet(adm, { vcenters: [{ id: 'vcI' }, { id: 'vcJ' }] }, deps);
  const ir = f2.rows.find((x) => x.key === 'IDLE1');
  assert.equal(ir.status, 'excluded'); assert.equal(ir.reason, 'dr'); assert.equal(ir.scoredStatus, 'candidate', '점수 · 원래 상태는 남긴다'); assert.equal(ir.score, 92);
  assert.equal(f2.summary.excludedBy.dr, 1); assert.equal(f2.summary.candidate, 1);
  // 지우기 → 다시 후보
  assert.equal((await rv(adm.user, { key: 'IDLE1', vcenterId: 'vcI', status: 'clear' })).status, 200);
  assert.equal((await R.bmIdleFleet(adm, { vcenters: [{ id: 'vcI' }, { id: 'vcJ' }] }, deps)).rows.find((x) => x.key === 'IDLE1').status, 'candidate');
  // 주석 저장소에 남는다(감사 · 누가 · 언제)
  const A = await import('../src/bmusage/annotations.js');
  assert.ok(A.listAnnotations().filter((a) => a.auto?.startsWith('idle:')).length >= 2);
  // 비관리자 판본 — 검토한 사람은 가림 토큰
  const op = { user: { username: 'op', role: 'operator', scope: null }, query: {}, params: {}, body: {} };
  await rv(adm.user, { key: 'IDLE1', vcenterId: 'vcI', status: 'review' });
  const fo = await R.bmIdleFleet(op, { vcenters: [{ id: 'vcI' }, { id: 'vcJ' }] }, deps);
  assert.notEqual(fo.rows.find((x) => x.key === 'IDLE1').review.by, 'adm');
});

test('⑥ 봉투 — 엣지가 싣는 표지 · 저활용 행 → 중앙 정제(sanitizePerfFields) 왕복 · 봉투 상한에서 사용 중 행만 뺀다', async () => {
  const S = await import('../src/central/bmPerfSanitize.js');
  const now = Date.now();
  const snap = { targets: [{ key: 'K1' }, { key: 'K2' }], topVer: 1, idleVer: 1, idle: { at: now, day: '2026-11-08', rows: [{ key: 'K1', status: 'candidate', score: 90 }, { key: 'ZZ', status: 'candidate', score: 90 }] } };
  const f = S.sanitizePerfFields(snap, now).fields;
  assert.equal(f.topVer, 1); assert.equal(f.idleVer, 1); assert.deepEqual(f.idle.rows.map((r) => r.key), ['K1'], '같은 봉투 대상 밖 키는 버린다');
  assert.equal(S.sanitizePerfFields({ ...snap, topVer: '1', idleVer: 1000 }, now).fields.topVer, undefined, '표지는 작은 양의 정수만');
  const E = await import('../src/bmusage/edgePull.js');
  const rows = Array.from({ length: 400 }, (_, i) => ({ key: `K${i}`, status: i % 4 ? 'active' : 'candidate', score: 10, metrics: { cpuAvg: 1 }, grades: {}, dropped: [] }));
  const env = { node: {}, rows: [], perf: [], idle: { rows } };
  const fit = E.fitEnvelope(env, 30_000);
  assert.equal(fit.idle.truncated, 'non-active-only'); assert.ok(fit.idle.rows.every((r) => r.status !== 'active')); assert.equal(fit.idle.dropped, 300);
});

test('⑦ 변경 이벤트 kind idle — 수집 노드 목록 · 중앙 대행 정제가 같은 값(둘을 같이 고친다)', async () => {
  const C = await import('../src/bmusage/changes.js');
  const P = await import('../src/central/bmPerfOpsPull.js');
  assert.ok(C.CHANGE_KINDS.includes('idle'));
  const e = P.cleanChange({ id: 1, ts: Date.now(), kind: 'idle', item: '저활용 후보', before: '관찰 50점', after: '후보 80점' });
  assert.equal(e?.kind, 'idle', '엣지 서버의 저활용 전이가 중앙 대행에서 버려지지 않는다');
  for (const k of C.CHANGE_KINDS) assert.ok(P.cleanChange({ ts: Date.now(), kind: k, item: 'x' }), `중앙 정제가 ${k} 를 받는다`);
});

test('⑧ 반증 F5 — 포탈 수집 계정의 SSH 로그인은 활동 흔적이 아니다(실제 분류 · 적재 · 활동 읽기) · 못 가르면 모름', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  // 순수 — 항목 `<계정> <주소>` · 접힘 ‘(기타)’
  assert.equal(I.humanLogins([{ item: 'portalsvc 10.1.1.1', c: 864 }], { user: 'portalsvc', ip: '10.1.1.1' }), 0, '수집 계정 · 수집 주소 = 활동 아님');
  assert.equal(I.humanLogins([{ item: 'portalsvc 10.1.1.1', c: 864 }, { item: 'root 10.2.2.2', c: 1 }], { user: 'root', ip: '10.1.1.1' }), 865, '같은 계정이라도 다른 주소면 사람(주소를 알 때)');
  assert.equal(I.humanLogins([{ item: 'root 10.1.1.1', c: 864 }, { item: 'root 10.2.2.2', c: 1 }], { user: 'root', ip: null }), 0, '주소를 모르면 그 계정 줄은 모두 뺀다(정직 기록 — 적게 보일 수 있다)');
  assert.equal(I.humanLogins([{ item: 'portalsvc 10.1.1.1', c: 9 }, { item: '(기타)', c: 4 }], { user: 'portalsvc', ip: '10.1.1.1' }), null, '접힌 항목만 남으면 가를 수 없다 → 모름');
  assert.equal(I.humanLogins([{ item: 'alice 10.9.9.9', c: 2 }, { item: '(기타)', c: 4 }], { user: 'portalsvc', ip: null }), 2, '사람 접속이 하나라도 확인되면 그 수');
  assert.equal(I.humanLogins([{ item: 'alice 10.9.9.9', c: 2 }], null), null, '수집 계정을 모르면 모름');
  I._resetSelfLoginForTest();
  assert.equal(I.selfLoginOf('X', { osHost: { username: 'mon', authError: '키 없음' } }), null, '자격 해석 실패 = 계정 모름');
  assert.deepEqual(I.selfLoginOf('X', { osHost: { username: 'mon' } }), { user: 'mon', ip: null });
  I.noteSelfLogin('X', 'mon', '10.1.1.1');
  assert.deepEqual(I.selfLoginOf('X', { osHost: { username: 'mon' } }), { user: 'mon', ip: '10.1.1.1' });
  assert.deepEqual(I.selfLoginOf('X', { osHost: { username: 'other' } }), { user: 'other', ip: null }, '등록 계정이 바뀌면 옛 주소를 쓰지 않는다');
  I.noteSelfLogin('X', 'mon', '$(id)'); assert.equal(I.selfLoginOf('X', { osHost: { username: 'mon' } }).ip, null, '주소 형식 밖은 버린다');
  // 실제 경로 — 반증 rv8b/idleact.mjs: SRV1 = 3일 동안 수집 계정 portalsvc@10.1.1.1 의 5분 로그인만 · SRV2 = 로그 읽기 · 로그인 0 · SRV3 = 같은 + 사람 alice 1회
  const L = await import('../src/bmusage/logs/classify.js');
  const LS = await import('../src/bmusage/logs/store.js');
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  const now = NOW - 10 * 60_000;
  const lines = [];
  for (let ts = now - 3 * DAY; ts < now; ts += 300_000) lines.push({ src: 'secure', ts, msg: `Accepted publickey for portalsvc from 10.1.1.1 port ${40000 + ((ts / 300_000) % 20000)} ssh2: ED25519 SHA256:abc` });
  const c1 = await L.classifyItems(lines, { now, authSrc: 'secure' });
  const c3 = await L.classifyItems([...lines, { src: 'secure', ts: now - DAY, msg: 'Accepted password for alice from 10.9.9.9 port 51515 ssh2' }], { now, authSrc: 'secure' });
  const item = (key, c) => ({ key, readRev: null, at: now, state: { pos: {} }, status: {}, patterns: c ? [...c.patterns.values()] : [], hours: c ? [...c.hours.values()] : [], sec: c ? [...c.sec.values()] : [] });
  const w = await LS.logWriteBatch({ agent, items: [item('SRV1', c1), item('SRV2', null), item('SRV3', c3), item('SRV4', c1)] });
  assert.equal(w.ok !== false, true, JSON.stringify(w));
  const low = Array.from({ length: 30 }, (_, i) => ({ day: new Date(now - (i + 1) * DAY + 9 * HOUR).toISOString().slice(0, 10), cpu_sum: 288, cpu_n: 288, cpu_max: 3, mem_sum: 2880, mem_n: 288, disk_busy_max: 1, net_max: 0.5 }));
  I._resetSelfLoginForTest(); I._resetIdleForTest();
  I.noteSelfLogin('SRV1', 'portalsvc', '10.1.1.1'); I.noteSelfLogin('SRV3', 'portalsvc', '10.1.1.1');
  const os1 = { username: 'portalsvc', host: '10.0.0.1' };
  const targets = [{ key: 'SRV1', name: 's1', vcenterId: 'vcA', osHost: os1 }, { key: 'SRV2', name: 's2', vcenterId: 'vcA', osHost: os1 }, { key: 'SRV3', name: 's3', vcenterId: 'vcA', osHost: os1 },
    { key: 'SRV4', name: 's4', vcenterId: 'vcA', osHost: { username: 'portalsvc', authError: '공통 계정 없음' } }];
  const r = await I.recomputeIdle({ targets, now, force: true,
    deps: { rules: { idle: {} }, judge: { cover: () => [], stateFor: () => null }, monthStore: { readDailyRange: async () => ({ live: low, mig: [] }) }, powerOf: () => null, opsDb: { changeWriteBatch: async () => ({ events: 0 }) } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(I.loadIdle().rows.map((x) => [x.key, x]));
  assert.equal(by.SRV1.metrics.ssh, 0, `수집 계정 줄만 = 사람 접속 0(예전 864) — ${by.SRV1.metrics.ssh}`); assert.equal(by.SRV1.grades.act, 1, '활동 흔적 없음 = 만점');
  assert.equal(by.SRV1.score, by.SRV2.score, '수집 로그인만 있는 서버 = 로그인 0 서버(예전 88 vs 100)');
  assert.equal(by.SRV3.metrics.ssh, 1); assert.equal(by.SRV3.grades.act, 0, '사람 접속 1회 = 활동 있음');
  assert.equal(by.SRV4.metrics.ssh, null, '수집 계정을 해석하지 못했으면 모름(0 이 아니다)'); assert.ok(by.SRV4.dropped.includes('act'), '모름은 분모에서 뺀다');
});

test('⑨ 반증 F9 — 검토 쓰기는 (법인, 키) 쌍: 같은 키 두 법인에서 B 행 검토가 B 에 적힌다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const R = await import('../src/routes/api/bmIdle.js');
  const A = await import('../src/bmusage/annotations.js');
  const targets = [{ key: '10.0.0.5', name: 'a-srv', vcenterId: 'vcA', paths: ['os'] }, { key: '10.0.0.5', name: 'b-srv', vcenterId: 'vcB', paths: ['os'] }];
  const deps = { audit: () => {}, now: () => NOW, currentTargets: async () => ({ targets }), listEdgeBmUsage: async () => [], bmAddressHosts: async () => ['10.0.0.5'] };
  const rv = (user, body) => R.bmIdleReview({ user, body, ip: '' }, deps);
  const adm = { username: 'adm', role: 'admin', scope: null };
  const before = A.listAnnotations().length;
  const ok = await rv(adm, { key: '10.0.0.5', vcenterId: 'vcB', status: 'retire', reason: 'B 서버 반납' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  const rec = A.listAnnotations().slice(before).find((a) => a.auto === 'idle:retire');
  assert.deepEqual(rec.target.vcenterIds, ['vcB'], 'B 행 검토는 B 서버에(예전: A 서버에 적힘)'); assert.deepEqual(rec.target.names, ['b-srv']);
  // 법인 B 만 보는 운영자 — 자기 B 서버 검토가 된다(예전 404)
  const opB = { username: 'opb', role: 'operator', scope: { vcenters: ['vcB'] } };
  const b = await rv(opB, { key: '10.0.0.5', vcenterId: 'vcB', status: 'review' });
  assert.equal(b.status, 200, JSON.stringify(b));
  // 같은 운영자가 A 법인 쌍을 대면 조회 밖 404(쓰기 0)
  assert.equal((await rv(opB, { key: '10.0.0.5', vcenterId: 'vcA', status: 'review' })).status, 404);
});
