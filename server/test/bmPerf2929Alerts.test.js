/**
 * v2.929(리눅스 성능 5단계) — 알림 규칙(설계 PROFILES §14 ①). 고정하는 규약(idrac-server.md · security-api.md v2.929):
 *   ① 조건은 수집 노드의 판정 code 의 ‘변화’ 에만 · null(못 읽음 · 띠 없음)은 보류 · 지속 · 한 사건에 한 번 · 재발 억제
 *   ② 상태 파일 — 재시작 뒤 재발송 없음 · 손상이면 보존하고 첫 주기는 기준만(warmup) ③ 법인당 하루 상한(알림 · 이슈 · 자동 집중) · 법인 예외
 *   ④ 채널은 기존 알림 설정의 사본(규칙이 고른 채널만 켠다 — 새 채널 없음) · 본문에 ** 없음 ⑤ 이슈 = 기존 문지기 틀(출처 bmperf · 같은 건 두 번 안 만듦 · 하루 상한)
 *   ⑥ 켠 규칙만 저장 · 형식 밖 400 · 저장 = 설정 소유자 등급 + 감사 · 범위 계정 읽기는 자기 법인만 ⑦ 유지보수 창 억제 원천 없음(훅 자리만)
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2929al-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const A = await import('../src/bmusage/perfAlerts.js');
const R = await import('../src/bmusage/perfRules.js');

const rule = (o = {}) => ({ on: true, cond: 'sat-err', sustain: 2, repeatMin: 60, channels: ['email'], issue: false, autoFocus: false, corpsOff: [], ...o });

test('① 조건 — 수집 노드 판정 code 만 본다 · null 은 보류(못 읽음 · 오래됨 · 띠 없음 · 소모품 전부 못 읽음)', () => {
  assert.equal(A.ruleCondition('use', { entry: { verdict: 'saturated' } }, rule()), true);
  assert.equal(A.ruleCondition('use', { entry: { verdict: 'warn' } }, rule()), false);
  for (const v of ['stale', 'partial', 'unknown']) assert.equal(A.ruleCondition('use', { entry: { verdict: v } }, rule()), null, v);
  assert.equal(A.ruleCondition('use', { entry: { verdict: 'saturated' } }, rule({ cond: 'bottleneck' })), false);
  assert.equal(A.ruleCondition('cross', { entry: { cross: [{ state: 'missing' }, { state: 'nopath' }] } }, rule()), null);
  assert.equal(A.ruleCondition('cross', { entry: { cross: [{ state: 'candidate' }, { state: 'inactive' }] } }, rule()), true);
  assert.equal(A.ruleCondition('baseline', { dev: { cpu_pct: { reason: 'few-weeks' } } }, rule()), null, '띠 없음 = 규칙 안 걸림');
  assert.equal(A.ruleCondition('baseline', { dev: { cpu_pct: { out: 'in' }, net_pct: { out: 'above', ratio: 2.9 } } }, rule()), true);
  assert.equal(A.ruleCondition('health', { health: { cells: { a: { code: 'missing' }, b: { code: 'na' } } } }, rule()), null);
  assert.equal(A.ruleCondition('health', { health: { cells: { a: { code: 'warn' } } } }, rule({ cond: 'bad' })), false);
  assert.equal(A.ruleCondition('profile', { profile: { status: 'unknown' } }, rule()), null);
});

test('① 지속 · 한 사건에 한 번 · 보류 · 재발 억제', () => {
  const r = rule({ sustain: 2, repeatMin: 60 });
  let st = null; const fired = [];
  const step = (cond, t) => { const o = A.stepRule(st, cond, r, t); st = o.state; fired.push(o.fire ? 1 : 0); return o.reason; };
  assert.equal(step(true, NOW), 'sustaining');
  assert.equal(step(null, NOW + 300_000), 'unknown', '못 읽은 주기는 끊지도 늘리지도 않는다');
  assert.equal(step(true, NOW + 600_000), 'fire');
  assert.equal(step(true, NOW + 900_000), 'ongoing', '같은 상태가 계속이면 다시 보내지 않는다');
  assert.equal(step(false, NOW + 1_200_000), 'clear');
  step(true, NOW + 1_500_000);
  assert.equal(step(true, NOW + 1_800_000), 'suppressed', '새 사건이어도 재발 억제(60분) 안');
  step(false, NOW + 2_100_000); step(true, NOW + 5_000_000);
  assert.equal(step(true, NOW + 5_300_000), 'fire', '억제 시간이 지나면 다시');
  assert.equal(fired.filter(Boolean).length, 2);
});

test('평가 — 켠 규칙만 · 법인 예외 · 이번 주기에 없던 서버 상태는 들고 간다 · 끈 규칙 상태는 버린다', () => {
  const rules = { use: rule({ sustain: 1, corpsOff: ['vcX'] }) };
  const items = [{ key: 'S1', name: 's1', vcenterId: 'vcA', entry: { verdict: 'errors' } }, { key: 'S2', name: 's2', vcenterId: 'vcX', entry: { verdict: 'errors' } }];
  const e1 = A.evaluatePerfRules(items, rules, {}, NOW);
  assert.deepEqual(e1.fires.map((f) => f.key), ['S1']); assert.equal(e1.counts.corpOff, 1);
  const e2 = A.evaluatePerfRules([], rules, { ...e1.next, 'baseline|S9': { active: true, seenAt: NOW } }, NOW + 300_000);
  assert.ok(e2.next['use|S1'], '수집 한 번 실패로 사건이 끊기지 않는다'); assert.equal(e2.next['baseline|S9'], undefined, '끈 규칙 상태는 버린다');
  const e3 = A.evaluatePerfRules([], rules, e1.next, NOW + A.CARRY_MS + 1);
  assert.equal(e3.next['use|S1'], undefined, '오래되면 버린다(인메모리 맵 규약)');
});

test('본문 — ** 없음 · 무엇이 · 얼마나 · 무엇 대비 · 원인 단정 없음', () => {
  const f = { rule: 'baseline', key: 'S1', name: 'bm-kr1-db01', vcenterId: 'KR-SEL', ctx: { dev: { disk_await_ms: { value: 18, ratio: 2.9, out: 'above', mean: 6.2, lo: 3.72, hi: 8.68 } } }, weeks: 4, sustain: 3 };
  const al = A.perfAlertOf(f);
  assert.match(al.title, /^\[KR-SEL\] bm-kr1-db01 베이스라인 이탈$/);
  assert.match(al.detail, /디스크 await 2\.9× — 지금 18, 지난 4주 같은 요일 · 시각 평균 6\.2\(띠 3\.72~8\.68 밖\)/);
  for (const r of ['use', 'cross', 'health', 'profile', 'focusEnd', 'baseline']) {
    const x = A.perfAlertOf({ rule: r, key: 'k', name: 'n', vcenterId: 'v', ctx: { entry: { verdict: 'errors', line: 'l', cross: [] }, health: { cells: {} }, profile: { profiles: [] }, summary: {} } });
    assert.ok(!/\*\*/.test(`${x.title}${x.detail}`), `${r}: ** 없음`);
    assert.equal(x.key.startsWith(`bmperf:${r}:`), true);
  }
  assert.deepEqual(A.maintenanceFor({ key: 'k' }), { suppressed: false, source: 'none' }, '유지보수 창 원천 없음(훅 자리만)');
});

test('② 상태 파일 · ③ 상한 · ④ 채널 사본 · ⑤ 이슈(중앙) · 자동 집중 — 재시작 뒤 재발송 없음 · 손상이면 warmup', async () => {
  A._resetPerfAlertsForTest();
  const rules = R.normalizeRules({ rules: { use: { on: true, sustain: 1, repeatMin: 0, channels: ['webhook'], issue: true, autoFocus: true } }, daily: { alerts: 2, issues: 1, autoFocus: 1 }, focus: { autoCorps: ['vcA'] } }, { strict: true }).value;
  const sent = []; const issued = []; const focused = [];
  const deps = {
    isMock: async () => false,
    alertConfig: async () => ({ channels: { slack: { enabled: true, url: 'https://s' }, webhook: { enabled: true, url: 'https://w' }, teams: { enabled: false }, email: { enabled: true } } }),
    notify: async (al, cfg) => { sent.push({ al, ch: Object.entries(cfg.channels).filter(([, v]) => v.enabled).map(([k]) => k) }); return ['webhook:200']; },
    applyIssues: async (fires) => { issued.push(...fires); return { byId: Object.fromEntries(fires.map((f, i) => [f.id, i === 0 ? 'created' : 'daily-cap'])) }; },
    startFocus: async (o) => { focused.push(o); return { ok: true, status: 'running', id: 'x' }; },
  };
  const item = (k, vc = 'vcA') => ({ key: k, name: k, vcenterId: vc, entry: { verdict: 'errors', line: '디스크 오류' }, target: { key: k, vcenterId: vc } });
  const r1 = await A.runPerfAlerts([item('S1'), item('S2'), item('S3')], { rules, now: NOW, deps });
  assert.equal(r1.fires, 3); assert.equal(r1.queued, 2, '법인당 하루 알림 상한 2(대기열에 넣은 수)'); assert.equal(r1.capped, 1);
  await A._drainPerfAlertsForTest();
  assert.deepEqual(A.perfAlertStatus().sent.slice(0, 2).map((x) => x.result), ['sent', 'sent'], '받은 채널(webhook:200)이 있으면 그때 ‘보냄’');
  assert.deepEqual(sent[0].ch, ['webhook'], '규칙이 고른 채널만(기존 설정 사본)');
  assert.equal(focused.length, 1, '자동 집중 하루 상한 1(법인 옵트인)'); assert.equal(focused[0].trigger, 'auto');
  assert.equal(issued.length, 3, '이슈 후보는 문지기에게(상한은 문지기 · 상태 둘 다)');
  const st = A.perfAlertStatus();
  assert.equal(st.sent.length, 3); assert.ok(st.sent.every((x) => !JSON.stringify(x).includes('https://')), '발송 기록에 채널 URL 없음');
  assert.equal(st.sent[2].result, 'daily-cap');
  // 재시작(인메모리 비움 · 파일은 남음) — 같은 사건을 다시 보내지 않는다
  A._resetPerfAlertsForTest({ unlink: false });
  const before = sent.length;
  const r2 = await A.runPerfAlerts([item('S1'), item('S2'), item('S3')], { rules, now: NOW + 300_000, deps });
  assert.equal(r2.fires, 0); assert.equal(sent.length, before, '재시작 뒤 재발송 없음');
  // 손상 — 보존하고 첫 주기는 기준만(warmup)
  fs.writeFileSync(path.join(DIR, 'bm-perf-alert-state.json'), '{broken');
  A._resetPerfAlertsForTest({ unlink: false });
  const r3 = await A.runPerfAlerts([item('S1')], { rules, now: NOW + 600_000, deps });
  assert.equal(r3.warmup, true); assert.equal(sent.length, before, 'warmup 주기는 보내지 않는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bm-perf-alert-state.json.corrupt')), '손상본 보존');
  // 켠 규칙이 없으면 판정도 하지 않는다
  assert.equal((await A.runPerfAlerts([item('S1')], { rules: R.normalizeRules({}, { strict: false }).value, deps })).skipped, 'no-rules');
  // 시험 실행 — 보내지 않고 상태도 바꾸지 않는다
  const n0 = sent.length;
  const dry = await A.runPerfAlerts([item('Z1')], { rules, now: NOW + 900_000, deps, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.fires.length, 1); assert.equal(sent.length, n0);
  A._resetPerfAlertsForTest();
});

test('⑤ 이슈 문지기 재사용(실제 이슈 저장소) — 출처 bmperf · 같은 발송 건 두 번 안 만듦 · 열린 이슈면 댓글 · 하루 상한', async () => {
  const I = await import('../src/issues/alertIssues.js');
  const S = await import('../src/issues/store.js');
  const f = (id, key = 'S1') => ({ id, at: NOW, rule: 'use', key, name: key, vcenterId: 'vcA', title: `${key} 성능 판정 ‘오류’`, agent: 'edge-kr' });
  const a = I.applyBmPerfFires([f('a1'), f('a2', 'S2')], { now: NOW, dailyMax: 1 });
  assert.deepEqual(a.byId, { a1: 'created', a2: 'daily-cap' });
  const made = S.findByOrigin((o) => o.kind === 'bmperf');
  assert.equal(made.length, 1); assert.equal(made[0].origin.alertKey, 'bmperf:edge-kr|S1|use');
  assert.deepEqual(I.applyBmPerfFires([f('a1')], { now: NOW, dailyMax: 5 }).byId, { a1: 'dup' }, '같은 발송 건(봉투를 다시 당겨도)은 두 번 쓰지 않는다');
  assert.deepEqual(I.applyBmPerfFires([f('a3')], { now: NOW, dailyMax: 5 }).byId, { a3: 'commented' }, '같은 서버 · 규칙의 열린 이슈가 있으면 댓글');
});

test('⑥ 설정 — 켠 규칙만 저장 · 형식 밖 400 · 모르는 규칙 · 채널 · Object.prototype 이름 거부 · 손상 보존 · 하한 · 상한', () => {
  const v = R.normalizeRules({ rules: { use: { on: true, channels: ['email'] }, cross: { on: false }, baseline: { on: true, corpsOff: ['vcA'] } } }, { strict: true }).value;
  assert.deepEqual(Object.keys(v.rules).sort(), ['baseline', 'use'], 'false 를 쌓지 않는다');
  assert.throws(() => R.normalizeRules({ rules: { evil: { on: true } } }), /모르는 규칙/);
  assert.throws(() => R.normalizeRules({ rules: { use: { on: true, channels: ['sms'] } } }), /channels/);
  assert.throws(() => R.normalizeRules({ rules: { use: { on: true, corpsOff: ['toString'] } } }), /corpsOff/);
  assert.throws(() => R.normalizeRules({ focus: { intervalS: 10 } }), /focus\.intervalS/, '간격 하한 30초');
  assert.throws(() => R.normalizeRules({ focus: { durationMin: 61 } }), /focus\.durationMin/, '길이 상한 60분');
  assert.throws(() => R.normalizeRules({ daily: { alerts: 0 } }), /daily\.alerts/);
  assert.equal(R.normalizeRules({ rules: { focusEnd: { on: true, autoFocus: true } } }).value.rules.focusEnd.autoFocus, false, '집중 결론 규칙은 자동 집중을 걸지 않는다(되먹임)');
  const d = R.normalizeRules({}, { strict: false }).value;
  assert.deepEqual(d.daily, { alerts: 50, issues: 20, autoFocus: 10, manualFocus: 20 }); assert.equal(d.focus.nodeMax, 10, '노드 전체 동시 상한(L11)'); assert.deepEqual(d.focus.intervalS, 60); assert.equal(d.focus.durationMin, 10); assert.equal(d.focus.corpMax, 5);
  assert.equal(d.baseline.weeks, 4); assert.equal(d.baseline.bandPct, 40); assert.equal(d.focus.keepDays, 30);
  // 저장 · 손상 보존
  R._resetPerfRulesForTest();
  const saved = R.savePerfRules({ rules: { health: { on: true } } }, { by: 'owner' });
  assert.deepEqual(Object.keys(saved.value.rules), ['health']); assert.equal(saved.value.by, 'owner');
  fs.writeFileSync(path.join(DIR, 'bm-perf-rules.json'), '{x');
  R._resetPerfRulesForTest();
  assert.deepEqual(R.loadPerfRules().rules, {}, '손상 — 기본값(전부 꺼짐)');
  assert.ok(R.perfRulesLoadError(), '화면이 loadError 로 말한다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bm-perf-rules.json.corrupt')));
  R._resetPerfRulesForTest();
  fs.rmSync(path.join(DIR, 'bm-perf-rules.json'), { force: true });
});

test('⑥ 실제 api 라우터 — 저장은 설정 소유자 등급(범위 관리자 · operator 거부) · 감사 · 범위 계정 읽기는 자기 법인만', async (t) => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const audit = await import('../src/audit.js');
  fs.writeFileSync(path.join(DIR, 'settings-owners.txt'), 'own\n');
  const USERS = {
    op: { username: 'op', role: 'operator', scope: null },
    adm: { username: 'adm', role: 'admin', scope: null },
    own: { username: 'own', role: 'admin', scope: null },
    ownScoped: { username: 'own', role: 'admin', scope: { vcenters: ['vcA'] } },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/perf-rules`;
  const put = (u, body) => fetch(base, { method: 'PUT', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { rules: { use: { on: true, corpsOff: ['vcA', 'vcB'] } } };
  assert.equal((await put('op', body)).status, 403, 'operator 거부');
  assert.equal((await put('adm', body)).status, 403, '설정 소유자가 아닌 관리자 거부');
  assert.equal((await put('ownScoped', body)).status, 403, '범위가 지정된 소유자 거부(소유자 ∧ 전체 범위)');
  const ok = await put('own', body);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await put('own', { rules: { use: { on: true, sustain: 999 } } })).status, 400, '형식 밖 400');
  assert.ok(audit.auditEntriesWithAction('bm-perf.rules').some((a) => a.user === 'own' && /"after":"use"/.test(a.detail || '')), '감사(켠 규칙 요약)');
  const ro = await (await fetch(base, { headers: { 'x-u': 'ownScoped' } })).json();
  assert.deepEqual(ro.rules.rules.use.corpsOff, ['vcA'], '범위 계정은 자기 법인 예외만 본다');
  assert.equal(ro.readOnly, true); assert.equal(ro.maintenanceSource, 'none');
  const full = await (await fetch(base, { headers: { 'x-u': 'adm' } })).json();
  assert.deepEqual(full.rules.rules.use.corpsOff, ['vcA', 'vcB']);
  assert.ok(!JSON.stringify(full).includes('https://'), '채널 URL 은 싣지 않는다');
  const dry = await fetch(`${base}/dry-run`, { method: 'POST', headers: { 'x-u': 'op', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(dry.status, 403, '시험 실행은 관리자');
  // 시험 실행은 이 노드 전 서버를 대 본다(이름 · 법인) — 범위 관리자는 403(fullScopeOnly · archScan route-gate-missing)
  const dryScoped = await fetch(`${base}/dry-run`, { method: 'POST', headers: { 'x-u': 'ownScoped', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(dryScoped.status, 403, '범위 관리자 시험 실행 거부');
  const dryFull = await fetch(`${base}/dry-run`, { method: 'POST', headers: { 'x-u': 'adm', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(dryFull.status, 200, await dryFull.clone().text());
});

/* ── 반증 review-s5 반영 ─────────────────────────────────────────────── */
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const baseDeps = (over = {}) => ({ isMock: async () => false, alertConfig: async () => ({ channels: { email: { enabled: true } } }), applyIssues: async () => ({ byId: {} }), startFocus: async () => ({ ok: false, code: 'x' }), ...over });

test('F1 상태 직렬화 — 주기 발송 대기 중 집중 결론이 끝나도(양쪽 순서) 규칙 상태 · 발송 기록이 둘 다 남고 다음 주기에 같은 사건을 다시 보내지 않는다', async () => {
  for (const order of ['cycle-first', 'end-first']) {
    A._resetPerfAlertsForTest();
    const rules = { rules: { use: rule({ sustain: 1, repeatMin: 360 }), focusEnd: rule({ cond: 'any', sustain: 1, repeatMin: 0 }) }, daily: { alerts: 50, issues: 20, autoFocus: 10 }, focus: {}, maintenance: {} };
    const g1 = gate(); const g2 = gate(); const titles = [];
    const items = [{ key: 'srvA', name: 'srvA', vcenterId: 'vc1', entry: { verdict: 'saturated' } }];
    const p1 = A.runPerfAlerts(items, { rules, now: NOW, deps: baseDeps({ notify: async (al) => { titles.push(al.title); await g1.p; return ['email:ok']; } }) });
    const p2 = A.runFocusEndAlert({ id: 'x', key: 'srvB', name: 'srvB', vcenterId: 'vc1', status: 'done', summary: { verdictFrom: 'ok', verdictTo: 'ok' } }, { rules, now: NOW + 1000, deps: baseDeps({ notify: async (al) => { titles.push(al.title); await g2.p; return ['email:ok']; } }) });
    await Promise.all([p1, p2]);   // 판정 · 큐잉은 발송을 기다리지 않는다
    if (order === 'cycle-first') { g1.open(); await new Promise((r) => setImmediate(r)); g2.open(); } else { g2.open(); await new Promise((r) => setImmediate(r)); g1.open(); }
    await A._drainPerfAlertsForTest();
    const file = JSON.parse(fs.readFileSync(path.join(DIR, 'bm-perf-alert-state.json'), 'utf8'));
    assert.equal(file.rules['use|srvA']?.active, true, `${order}: 주기의 규칙 상태가 남는다`);
    assert.deepEqual(file.sent.map((x) => x.rule).sort(), ['focusEnd', 'use'], `${order}: 두 발송 기록 모두 남는다`);
    assert.deepEqual(file.sent.map((x) => x.result), ['sent', 'sent']);
    A._resetPerfAlertsForTest({ unlink: false });   // 재시작 = 파일에서 다시
    const r3 = await A.runPerfAlerts(items, { rules, now: NOW + 300_000, deps: baseDeps({ notify: async (al) => { titles.push(al.title); return ['email:ok']; } }) });
    assert.equal(r3.fires, 0, `${order}: 같은 포화가 이어져도 다시 보내지 않는다(repeatMin · 한 사건 한 번)`);
    assert.equal(titles.length, 2);
  }
  A._resetPerfAlertsForTest();
});

test('F6 발송은 주기 밖(대기열) — 주기당 상한 MAX_SEND · 넘친 건은 다음 주기 · 전 채널 실패는 ‘보냄’ 이 아니라 failed · 기존 재시도 규칙(5분 뒤 다시)', async () => {
  A._resetPerfAlertsForTest();
  const { MAX_SEND } = await import('../src/bmusage/notify.js');
  const rules = { rules: { health: rule({ cond: 'any', sustain: 1, repeatMin: 720, channels: ['email', 'webhook'] }) }, daily: { alerts: 500, issues: 20, autoFocus: 10 }, focus: {}, maintenance: {} };
  const g = gate(); let calls = 0;
  const deps = baseDeps({ alertConfig: async () => ({ suppressWindowMin: 5, channels: { email: { enabled: true }, webhook: { enabled: true, url: 'x' } } }),
    notify: async () => { calls += 1; await g.p; return ['webhook:500', 'email:err SMTP 연결 실패']; }, clock: () => NOW });
  const items = Array.from({ length: MAX_SEND + 20 }, (_, i) => ({ key: `s${i}`, name: `s${i}`, vcenterId: 'vc1', health: { cells: { dmesg: { code: 'warn' } } } }));
  const r = await A.runPerfAlerts(items, { rules, now: NOW, deps });   // 발송이 끝나지 않아도 돌아온다(구조 — 시간 단언 없음)
  assert.equal(r.fires, MAX_SEND + 20); assert.equal(r.queued, MAX_SEND, '주기당 상한'); assert.equal(r.deferred, 20, '넘친 건은 버리지 않고 다음 주기');
  assert.ok(A.perfAlertStatus().sent.every((x) => x.result === 'queued'));
  g.open(); await A._drainPerfAlertsForTest();
  assert.equal(calls, MAX_SEND);
  const st = A.perfAlertStatus();
  assert.ok(st.sent.every((x) => x.result === 'failed'), '전 채널 실패 = failed(‘보냄’ 아님)');
  assert.ok(st.sent.every((x) => /webhook:500/.test(x.error || '')));
  // 다음 주기: 넘친 20건은 이번에 판정 · 큐잉 · 실패한 건은 5분(RETRY_DELAYS_MS[0]) 전에는 다시 보내지 않는다
  const r2 = await A.runPerfAlerts(items, { rules, now: NOW + 60_000, deps });
  assert.equal(r2.fires, 20, '넘쳤던 20건만');
  const r3 = await A.runPerfAlerts(items, { rules, now: NOW + 5 * 60_000 + 61_000, deps });
  assert.equal(r3.counts.retry, MAX_SEND, '실패한 건은 재시도 시각에 다시(기존 알림 경로 retryDelayMs)');
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
});

test('F5 못 읽음은 보류 — 직전 참 칸이 이번에 못 읽음이면 사건 유지(해소 · 재발송 없음) · 소모품 since 유지 · missing 전이는 변경 이벤트 아님', async () => {
  const C = await import('../src/bmusage/changes.js');
  const r0 = rule({ cond: 'any', sustain: 1, repeatMin: 0 });
  const cells = (chrony) => ({ key: 'K', name: 'K', vcenterId: 'vc1', health: { cells: { chrony: { code: chrony }, units: { code: 'ok' }, oom: { code: 'ok' } } } });
  let st = {}; const steps = [];
  for (const [i, c] of ['warn', 'warn', 'missing', 'warn'].entries()) {
    const ev = A.evaluatePerfRules([cells(c)], { health: r0 }, st, NOW + i * 300_000);
    st = ev.next; steps.push(`${c}:${ev.fires.length ? 'fire' : Object.entries(ev.counts).find(([k, v]) => v && k !== 'fire')?.[0]}`);
  }
  assert.deepEqual(steps, ['warn:fire', 'warn:ongoing', 'missing:unknown', 'warn:ongoing'], '한 주기 결측이 사건을 끊지 않는다(재발송 없음)');
  // baseline · cross 도 같은 규칙
  const dev = (cpu) => ({ key: 'B', name: 'B', vcenterId: 'vc1', dev: { cpu_pct: cpu, net_pct: { out: 'in' } } });
  let sb = A.evaluatePerfRules([dev({ out: 'above', value: 90, mean: 40, lo: 24, hi: 56 })], { baseline: r0 }, {}, NOW).next;
  assert.equal(A.evaluatePerfRules([dev(null)], { baseline: r0 }, sb, NOW + 300_000).counts.unknown, 1, '띠 밖이던 지표가 결측 → 보류');
  const cx = (a) => ({ key: 'X', name: 'X', vcenterId: 'vc1', entry: { cross: [{ id: 'c2', state: a }, { id: 'c3', state: 'inactive' }] } });
  sb = A.evaluatePerfRules([cx('candidate')], { cross: r0 }, {}, NOW).next;
  assert.equal(A.evaluatePerfRules([cx('missing')], { cross: r0 }, sb, NOW + 300_000).counts.unknown, 1, '후보이던 교차가 결측 → 보류');
  assert.equal(A.evaluatePerfRules([cx('inactive')], { cross: r0 }, sb, NOW + 300_000).counts.clear, 1, '읽었고 아니면 해소');
  // since 유지 · 변경 이벤트 없음
  const T0 = NOW - 5 * 86_400_000;
  const s1 = C.healthSince({ chrony: { code: 'warn', since: T0 } }, { chrony: { code: 'missing' } }, NOW);
  const s2 = C.healthSince(s1, { chrony: { code: 'warn' } }, NOW + 300_000);
  assert.equal(s2.chrony.since, T0, '며칠째 유지');
  const d1 = C.diffChangeFacts({ health: { chrony: { code: 'warn', since: T0 } } }, { health: s1 }, { now: NOW });
  const d2 = C.diffChangeFacts(d1.facts, { health: s2 }, { now: NOW + 300_000 });
  assert.equal(d1.events.length + d2.events.length, 0, 'warn → missing → warn 은 변경 이벤트가 아니다');
  const d3 = C.diffChangeFacts(d2.facts, { health: C.healthSince(s2, { chrony: { code: 'ok' } }, NOW + 600_000) }, { now: NOW + 600_000 });
  assert.deepEqual(d3.events.map((e) => [e.kind, e.before, e.after]), [['health', 'warn', 'ok']], '읽은 code 끼리의 전이만');
});

test('F10 시험 실행 — 문구대로 지속 1주기 · 빈 상태로 대 본다(설정 지속 2 · 3 이어도 지금 성립이면 걸린 것 · 진행 중 사건도 보인다)', async () => {
  A._resetPerfAlertsForTest();
  const rules = R.normalizeRules({ rules: { use: { on: true }, baseline: { on: true } } }).value;
  assert.equal(rules.rules.use.sustain, 2); assert.equal(rules.rules.baseline.sustain, 3);
  const items = [{ key: 's1', name: 's1', vcenterId: 'vc1', entry: { verdict: 'saturated' }, dev: { cpu_pct: { out: 'above', ratio: 2.1, value: 90, mean: 40, lo: 24, hi: 56 } } }];
  const r = await A.runPerfAlerts(items, { rules, dryRun: true, now: NOW });
  assert.deepEqual(r.fires.map((f) => f.rule).sort(), ['baseline', 'use']);
  assert.equal(fs.existsSync(path.join(DIR, 'bm-perf-alert-state.json')), false, '상태 파일을 만들지도 고치지도 않는다');
});

test('F2 · F3 · F12 · F7 이슈 중복 — 한 봉투 같은 서버 · 규칙은 이슈 하나 + 댓글 · 다시 당겨도(밀려난 id 포함) 댓글 없음 · 닫은 이슈를 같은 건으로 되살리지 않음 · 상한은 법인별', async () => {
  const I = await import('../src/issues/alertIssues.js');
  const S = await import('../src/issues/store.js');
  const T = NOW - 3 * HOUR;
  const f = (id, at, o = {}) => ({ id: `edgeA:${id}`, agent: 'edgeA', key: 'srv1', name: 'srv1', rule: 'use', vcenterId: 'vcD', at, title: 'srv1 포화', ...o });
  // F2 — 같은 묶음 3건 → 이슈 1 + 댓글 2(계획 · 실제 저장소)
  const plan = I.planBmPerfIssues([f('a1', T), f('a2', T + 1), f('a3', T + 2)], { existing: [], dailyMax: 20 });
  assert.deepEqual(plan.actions.map((a) => a.type), ['create', 'again', 'again']);
  const r1 = I.applyBmPerfFires([f('a1', T), f('a2', T + 300_000), f('a3', T + 600_000)], { now: NOW, dailyMax: 20 });
  assert.deepEqual(Object.values(r1.byId), ['created', 'commented', 'commented']);
  assert.equal(S.findByOrigin((o) => o.kind === 'bmperf' && o.alertKey === 'bmperf:edgeA|srv1|use').length, 1);
  // F3 — 70건(partKeys 64 상한 밖으로 밀려남) · 같은 봉투를 다시 당겨도 댓글이 붙지 않는다(같은 ms 의 건 포함)
  const env = Array.from({ length: 70 }, (_, i) => f(`m${i}`, T + 900_000 + Math.floor(i / 2) * 1000, { key: 'srv2' }));
  const cnt = (o) => Object.values(o.byId).reduce((m, v) => ((m[v] = (m[v] || 0) + 1), m), {});
  assert.deepEqual(cnt(I.applyBmPerfFires(env, { now: NOW, dailyMax: 20 })), { created: 1, commented: 69 });
  for (let p = 0; p < 3; p += 1) assert.deepEqual(cnt(I.applyBmPerfFires(env, { now: NOW, dailyMax: 20 })), { dup: 70 }, `재당김 ${p + 1}: 댓글 없음`);
  // F12 — 사람이 닫은 뒤 같은 봉투 → 새 이슈 없음(dup) · 닫은 뒤 **새** 발생은 새 이슈(다른 알람 · 파트 장애와 같은 규약 — 닫힌 이슈는 다시 열지 않는다)
  const k1 = S.findByOrigin((o) => o.alertKey === 'bmperf:edgeA|srv1|use')[0].key;
  S.setStatus(k1, 'done', { username: 'adm', role: 'admin' }, { ignoreBlockers: true, note: '처리' });
  assert.deepEqual(Object.values(I.applyBmPerfFires([f('a1', T), f('a3', T + 600_000)], { now: NOW, dailyMax: 20 }).byId), ['dup', 'dup']);
  assert.deepEqual(Object.values(I.applyBmPerfFires([f('a9', T + 2 * HOUR)], { now: NOW, dailyMax: 20 }).byId), ['created'], '닫힌 뒤 새 발생');
  // F7 — 하루 상한은 법인별(한 법인이 다른 법인 이슈를 막지 않는다)
  const g = (id, key, vc) => ({ id: `edgeB:${id}`, agent: 'edgeB', key, name: key, rule: 'health', vcenterId: vc, at: T + 3 * HOUR, title: 't' });
  const r7 = I.applyBmPerfFires([g('x1', 'k1', 'vcE'), g('x2', 'k2', 'vcE'), g('x3', 'k3', 'vcF')], { now: NOW, dailyMax: 1 });
  assert.deepEqual(r7.byId, { 'edgeB:x1': 'created', 'edgeB:x2': 'daily-cap', 'edgeB:x3': 'created' });
});

test('F9 엣지 봉투의 법인 · 서버 키 · 제목을 믿지 않는다 — 대상 목록 밖 키는 버리고 · 법인은 중앙 결정(파트 장애와 같은 함수) · 제목은 code 로 · 중앙 규칙 게이트 · 법인 예외', async () => {
  const S = await import('../src/central/bmUsageEdgePull.js');
  const P = await import('../src/central/bmPerfOpsPull.js');
  const AC = await import('../src/issues/autoCreate.js');
  const IS = await import('../src/issues/store.js');
  R._resetPerfRulesForTest();
  R.savePerfRules({ rules: { use: { on: true, issue: true }, health: { on: true, issue: false } } }, { by: 'adm' });
  // 중앙이 아는 귀속: edge-A 는 vcA 만 담당(실제 resolveIssueVcenter — 판정 재료만 고정)
  const resolveVc = (p) => AC.resolveIssueVcenter(p, { loaded: true, names: new Map(), byTag: new Map(), agentIds: (ag) => (ag === 'edge-A' ? ['vcA', 'vcA2'] : []) });
  const raw = { node: { agent: 'edge-A' }, targets: [{ key: 'TAG-A1', name: 'a1 http://evil.example/x', vcenterId: 'vcA' }, { key: 'TAG-A2', name: 'a2', vcenterId: 'vcB' }], rows: [], perf: [],
    perfAlertSent: [
      { id: 'f0rge001', at: Date.now(), rule: 'use', key: 'TAG-OTHER-CORP', name: 'payroll-db', vcenterId: 'vcB', title: '긴급: payroll-db — http://evil.example/fix', channels: [], result: 'sent', issue: 'pending-central' },
      { id: 'ok000001', at: Date.now(), rule: 'use', key: 'TAG-A1', name: 'x', vcenterId: 'vcB', title: '긴급 http://evil.example/y', channels: [], result: 'sent', issue: 'pending-central' },
      { id: 'ok000002', at: Date.now(), rule: 'use', key: 'TAG-A2', name: 'x', vcenterId: 'vcB', title: 't', channels: [], result: 'sent', issue: 'pending-central' },
      { id: 'off00001', at: Date.now(), rule: 'health', key: 'TAG-A1', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent', issue: 'pending-central' },
    ] };
  const snap = S.sanitizeBmUsageSnap(raw, { receivedAt: Date.now() });
  const r = await P.ingestEdgeAlertIssues('edge-A', snap, { resolveVc });
  assert.equal(r.dropped, 1, '그 엣지 대상 목록 밖 키는 버리고 센다');
  assert.equal(r.created, 2);
  const made = IS.findByOrigin((o) => o.kind === 'bmperf' && o.alertKey.startsWith('bmperf:edge-A|')).map((x) => IS.getIssue(x.key));
  assert.equal(made.length, 2, '중앙 규칙에서 이슈를 끈 규칙(health)은 만들지 않는다');
  const byKey = Object.fromEntries(made.map((x) => [x.origin?.alertKey || x.title, x]));
  const a1 = made.find((x) => /a1/.test(x.title)); const a2 = made.find((x) => /a2/.test(x.title));
  assert.equal(a1.vcenterId, 'vcA', '엣지 주장(vcA) ∩ 그 엣지 담당 → vcA(행의 vcB 는 무시)');
  assert.equal(a2.vcenterId, '', '엣지가 담당하지 않는 법인(vcB)을 주장하면 공용(지어내지 않는다)');
  for (const x of made) { assert.doesNotMatch(x.title, /evil|긴급|http/, '엣지 제목 문자열을 쓰지 않는다'); assert.match(x.title, /USE 판정 변화/); }
  assert.ok(Object.keys(byKey).length);
  // 법인 예외는 중앙이 정한 법인으로
  R.savePerfRules({ rules: { use: { on: true, issue: true, corpsOff: ['vcA'] } } }, { by: 'adm' });
  const snap2 = { ...snap, perfAlertSent: snap.perfAlertSent.map((x) => ({ ...x, id: `${x.id}b`, at: x.at + 1 })) };
  const r2 = await P.ingestEdgeAlertIssues('edge-A', snap2, { resolveVc });
  assert.equal(r2.created ?? 0, 0, 'vcA 예외 · a2 는 이미 열린 이슈에 댓글');
  assert.deepEqual(Object.keys(r2.byId || {}), ['edge-A:ok000002b'], '중앙이 정한 법인(vcA)이 예외면 문지기로 넘기지도 않는다(a1)');
  // 중앙 규칙에서 이슈가 꺼져 있으면 아무것도
  R.savePerfRules({ rules: { use: { on: true, issue: false } } }, { by: 'adm' });
  const snap3 = { ...snap, perfAlertSent: snap.perfAlertSent.map((x) => ({ ...x, id: `${x.id}c`, at: x.at + 2 })) };
  const before = IS.findByOrigin((o) => o.kind === 'bmperf', { openOnly: false }).length;
  await P.ingestEdgeAlertIssues('edge-A', snap3, { resolveVc });
  assert.equal(IS.findByOrigin((o) => o.kind === 'bmperf', { openOnly: false }).length, before);
  // 발송 기록 시각은 수신 시각으로 자른다(미래 시각 불신)
  const rcv = Date.now();
  const cl = P.sanitizeAlertSent([{ id: 'z1', at: rcv + 86_400_000, rule: 'use', key: 'K' }], rcv);
  assert.equal(cl[0].at, rcv);
  R._resetPerfRulesForTest(); fs.rmSync(path.join(DIR, 'bm-perf-rules.json'), { force: true });
});

