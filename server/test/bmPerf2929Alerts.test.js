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
  assert.equal(r1.fires, 3); assert.equal(r1.sent, 2, '법인당 하루 알림 상한 2'); assert.equal(r1.capped, 1);
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
  assert.deepEqual(d.daily, { alerts: 50, issues: 20, autoFocus: 10 }); assert.deepEqual(d.focus.intervalS, 60); assert.equal(d.focus.durationMin, 10); assert.equal(d.focus.corpMax, 5);
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
