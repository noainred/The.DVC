/**
 * 리눅스 성능 8a단계 반증 회귀 — 정비 창(판정 · 억제 경로).
 *   ① F1  서버 대상은 (법인, 키) 쌍 — 같은 키 · 다른 법인은 맞지 않는다(판정 · 배포 · 함대 요약 같은 규칙)
 *   ② F7  배포본 받은 시각이 미래면 지금으로 자른다(한 번 · 파일에 남김) — 그 뒤 24시간이면 시한
 *   ③ F8  ‘창 끝 뒤 억제’ 점검은 판정과 독립 — 엣지 서버의 법인 창 보류(정당)는 leak 0 · 계수 · 점검은 파트 장애 쪽에서도 저장된다(중앙)
 *   ④ F9  창 밖에서 보낸 초과의 ‘해제’ 는 창 안에서도 바로 보낸다 · 억제 계수에 넣지 않는다(실제 notify.runBmUsageAlerts)
 *   ⑤ F10 엣지에 배포된 태그 창은 펼친 keys 만 — 엣지 로컬 용도 태그로 넓히지 않는다(엣지 판정 = 중앙 판정)
 *   ⑥ 의심 — 지운 창은 묘비: 지금 판정에서는 빠지고 지난 구간(분모 제외 · 음영)에는 지운 시각까지 남는다
 *   ⑦ F6  windowStatus 는 조각 탐색 — 400일 전부 세는 옛 답과 같고 창 하나가 가볍다
 *   ⑧ F5  합친 덮임 규칙(순수) — 같은 서버 · 다른 법인 · 소유자 창은 합에서 빠진다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8afix-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const S = await import('../src/bmusage/maint/schedule.js');
const J = await import('../src/bmusage/maint/judge.js');
const ST = await import('../src/bmusage/maint/store.js');
const R = await import('../src/bmusage/maint/runtime.js');
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const T0 = Math.floor(Date.now() / HOUR) * HOUR + 7 * MIN;   // 정시 경계 + 7분(common.md)
const NOW = Date.now();
function resetAll() {
  ST._resetMaintStoreForTest(); R._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json', 'bmusage-alert-state.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
}
const win = (o = {}) => ({ id: 'mw-fix00001', name: '창', reason: 'r', target: { kind: 'server', keys: ['10.0.0.5'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
  schedule: { kind: 'once', start: loc(NOW - 30 * MIN), end: loc(NOW + 90 * MIN) }, scopes: { alerts: true, collect: true }, rev: 1, at: NOW, confirmedAt: NOW, ...o });

test('① F1 — 서버 대상은 (법인, 키) 쌍: 같은 키 · 다른 법인은 판정 · 배포 · 함대 요약에서 섞이지 않는다', async () => {
  const w = win();
  assert.equal(J.matchTarget(w, { key: '10.0.0.5', vcenterId: 'vcA' }), true);
  assert.equal(J.matchTarget(w, { key: '10.0.0.5', vcenterId: 'vcB' }), false, '반증 r1 — 예전 true');
  assert.equal(J.matchTarget(w, { key: '10.0.0.5' }), false, '법인을 모르는 대상은 맞추지 않는다(억제하지 않는 쪽)');
  assert.equal(J.maintStateFor([w], { key: '10.0.0.5', vcenterId: 'vcB' }, NOW).active, false);
  assert.equal(J.targetIdOf({ key: 'k', vcenterId: 'vcA' }) === J.targetIdOf({ key: 'k', vcenterId: 'vcB' }), false);
  // 배포 — 키가 그 엣지 대상과 겹쳐도 그 법인이 아니면 보내지 않는다
  const DP = await import('../src/bmusage/maint/deploy.js');
  const live = await DP.liveWindows([w], NOW);
  assert.equal(DP.windowsForEdge({ live, corps: new Set(['vcB']), edgeTargets: [{ key: '10.0.0.5', vcenterId: 'vcB' }] }).length, 0);
  assert.equal(DP.windowsForEdge({ live, corps: new Set(['vcA']), edgeTargets: [{ key: '10.0.0.5', vcenterId: 'vcA' }] }).length, 1);
  // 함대 용량 요약 — 같은 키 두 법인 = 서버 2대
  const C = await import('../src/bmusage/capacity.js');
  const s = C.summarize([{ key: '10.0.0.5', vcenterId: 'vcA', kind: 'fs', res: '/', status: 'reached' }, { key: '10.0.0.5', vcenterId: 'vcB', kind: 'fs', res: '/', status: 'forecast', daysToTarget: 3 }]);
  assert.equal(s.servers, 2); assert.equal(s.reached, 1); assert.equal(s.soon, 1);
});

test('② F7 — 배포본 받은 시각이 미래면 지금으로 자르고(파일에 남김) 그때부터 24시간이 시한', () => {
  resetAll();
  const future = NOW + 365 * DAY;   // 받을 때 엣지 시계가 1년 앞서 있었다
  ST.saveDeployed([win({ schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '00:00', durMin: 720 } })], { sig: 'a'.repeat(32), now: future });
  const w1 = ST.windowsForJudge(NOW);
  assert.equal(w1.deployed.stale, false); assert.equal(w1.deployed.at, NOW, '지금으로 잘렸다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'maintenance-windows-deployed.json'), 'utf8')).atClampedFrom, future, '원래 값은 따로');
  ST._resetMaintStoreForTest();
  const w2 = ST.windowsForJudge(NOW + 25 * HOUR);
  assert.equal(w2.deployed.stale, true, '잘린 시각부터 24시간 — 반증 r3: 예전에는 92일까지 억제'); assert.equal(w2.windows.filter((x) => x.origin === 'central').length, 0);
  assert.equal(ST.deployedStale({ at: NOW }, NOW + 25 * HOUR), true); assert.equal(ST.deployedStale({ at: NOW }, NOW + HOUR), false);
});

test('③ F8 — 점검은 판정과 독립: 엣지 서버의 법인 창 보류(정당)는 leak 0 · 파트 장애 쪽에서도 계수 · 점검을 저장한다', async () => {
  resetAll();
  await ST.addWindow({ name: '법인 E 펌웨어', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcE', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(NOW - 30 * MIN), end: loc(NOW + 90 * MIN) }, scopes: { hold: true } }, { by: 'own', now: NOW });
  const PH = await import('../src/bmusage/maint/partfaultHold.js');
  const r = await PH.partfaultMaintHold([{ agent: 'Edge-A', deviceId: 'idrac-1', deviceKey: 'E1TAG', scope: 'idrac' }],
    { now: NOW, deps: { targets: [{ agent: 'edge-a', key: 'E1TAG', serviceTag: 'E1TAG', vcenterId: 'vcE', regId: '' }] } });
  assert.deepEqual([...r.hold], ['edge-a|idrac-1']);
  assert.deepEqual(r.audit, { checked: 1, leak: 0 }, '반증 r8 — 예전 leak 1(대상을 키만으로 다시 판정)');
  // 계수 · 점검은 파일에 남는다(중앙 — 로컬 bmusage 대상 0대여도: 의심 항목 flushMaintStats 호출처 0)
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'maintenance-stats.json'), 'utf8'));
  assert.equal(Object.values(saved.byWindow)[0].hold, 1); assert.equal(saved.leak.n, 0); assert.ok(saved.leak.at > 0);
  // 순수 기준 — 끝낸 뒤 적용 · 재확인 만료 뒤 적용 · 배포본 시한 뒤 적용
  const facts = new Map([['mw-a1', { kind: 'once', endedAt: NOW - MIN }], ['mw-r1', { kind: 'weekly', confirmedAt: NOW - 93 * DAY }], ['mw-d1', { kind: 'once', deployedAt: NOW - 25 * HOUR }]]);
  assert.equal(R.leakReason({ at: NOW, until: NOW + HOUR, since: NOW - HOUR, windowIds: ['mw-a1'] }, facts), 'ended');
  assert.equal(R.leakReason({ at: NOW, until: NOW + HOUR, since: NOW - HOUR, windowIds: ['mw-r1'] }, facts), 'expired');
  assert.equal(R.leakReason({ at: NOW, until: NOW + HOUR, since: NOW - HOUR, windowIds: ['mw-d1'] }, facts), 'deploy-stale');
  assert.equal(R.leakReason({ at: NOW, until: NOW + HOUR, since: NOW - HOUR, windowIds: ['mw-zz'] }, facts), null, '파일에 없는 창은 사실로 반박할 수 없다(세지 않음)');
  // 점검 사실은 캐시 없이 — 파일을 지금 다시 읽는다(주석의 ‘캐시 없이’ 와 같다)
  const src = fs.readFileSync(new URL('../src/bmusage/maint/store.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function windowFactsNoCache'), src.indexOf('export function _resetMaintStoreForTest'));
  assert.match(body, /fs\.readFileSync\(file/); assert.doesNotMatch(body, /_cache|loadAll\(|_dep/);
});

test('④ F9 — 창 밖에서 보낸 초과의 해제는 창 안에서도 보낸다 · 억제 계수에 넣지 않는다(실제 notify)', async () => {
  resetAll();
  const N = await import('../src/bmusage/notify.js');
  const w = win({ id: 'mw-rec00001', target: { kind: 'server', keys: ['K1'] }, scopes: { alerts: true } });
  const judge = async (inWin) => R.maintJudge({ now: Date.now(), tagsOf: () => [], windowsOf: () => ({ windows: inWin ? [w] : [], deployed: null }) });
  const set = (mj) => ({ alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, maintJudge: mj, targetOf: () => ({ key: 'K1', vcenterId: 'vcA' }) });
  const row = (v) => [{ key: 'K1', name: 'bm-k1', vcenterId: 'vcA', cpu_pct: v }];
  const a = await N.runBmUsageAlerts(row(99), set(await judge(false)));
  assert.deepEqual((a.fires || []).map((f) => f.kind), ['over'], '창 전 — 초과 발송');
  const b = await N.runBmUsageAlerts(row(10), set(await judge(true)));
  assert.deepEqual((b.fires || []).map((f) => f.kind), ['recovered'], '창 안 해제 — 보낸다(반증 r11: 예전 held)');
  assert.equal(b.maint.held, 0);
  assert.equal(R.maintStats().byWindow['mw-rec00001']?.alerts ?? 0, 0, '해제는 억제 계수에 넣지 않는다');
  // 창 안에서 막은 초과는 notifiedAt 을 되돌려 해제 발화가 생기지 않는다(받는 쪽에 열린 사건이 없다)
  resetAll();
  const c1 = await N.runBmUsageAlerts(row(99), set(await judge(true)));
  assert.equal((c1.fires || []).length, 0); assert.equal(c1.maint.held, 1);
  const c2 = await N.runBmUsageAlerts(row(10), set(await judge(true)));
  assert.equal((c2.fires || []).length, 0, '보낸 적 없는 초과의 해제는 없다');
});

test('⑤ F10 — 엣지에 배포된 태그 창은 펼친 keys 만(엣지 로컬 용도 태그로 넓히지 않는다)', async () => {
  resetAll();
  const tw = win({ id: 'mw-tagweb01', target: { kind: 'tag', tag: 'role:web', keys: ['E2'] }, vcenterId: 'vcE', schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '00:00', durMin: 720 }, scopes: { alerts: true, hold: true } });
  const tagsOf = (x) => (['E2', 'E3'].includes(x.key) ? ['role:web'] : []);   // 엣지 로컬 태그 — E3 도 web(중앙은 모름)
  assert.equal(J.matchTarget({ ...tw, origin: 'central' }, { key: 'E3', vcenterId: 'vcE' }, { tagsOf }), false, '반증 r10 — 예전 true');
  assert.equal(J.matchTarget({ ...tw, origin: 'central' }, { key: 'E2', vcenterId: 'vcE' }, { tagsOf }), true);
  assert.equal(J.matchTarget({ ...tw, origin: 'local', target: { kind: 'tag', tag: 'role:web' } }, { key: 'E3', vcenterId: 'vcE' }, { tagsOf }), true, '이 노드의 태그 창은 수동 태그로');
  // 실제 경로 — 배포본 저장 → 판정기(엣지 로컬 수동 태그를 실제로 심는다)
  ST.saveDeployed([tw], { sig: 'b'.repeat(32), now: NOW });
  const FT = await import('../src/insights/fleetTags.js');
  assert.equal(FT.setFleetPurpose('e3', { role: 'web' }, { knownRoles: ['db', 'web', 'cache', 'file', 'general'] }).ok, true);
  const MJ = await R.maintJudge({ now: NOW });
  let at = null;
  for (let t = NOW; t < NOW + DAY; t += HOUR) if (MJ.stateFor({ key: 'E2', serviceTag: 'E2', vcenterId: 'vcE' }, t).scopes.alerts) { at = t; break; }
  assert.ok(at != null);
  assert.equal(MJ.stateFor({ key: 'E3', serviceTag: 'E3', vcenterId: 'vcE' }, at).scopes.alerts, false, '엣지 판정 = 중앙 판정(E3 는 중앙이 펼치지 않았다)');
});

test('⑥ 의심 — 지운 창은 묘비: 지금 판정에서 빠지고 지난 구간에는 지운 시각까지(소급 소거 금지)', async () => {
  resetAll();
  const w = await ST.addWindow({ name: '매일 백업', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: S.fmtLocal('Asia/Seoul', T0 - 3 * HOUR).slice(11), durMin: 120 }, scopes: { exclude: true, alerts: true } }, { by: 'own', now: T0 - 10 * DAY });
  const tg = { key: 'S1', vcenterId: 'vcA' };
  const before = (await R.maintJudge({ now: T0 })).cover(tg, T0 - 7 * DAY, T0, 'exclude');
  await ST.deleteWindow(w.id, { by: 'own', rev: 1, now: T0 - 2 * DAY });
  const MJ = await R.maintJudge({ now: T0 });
  const after = MJ.cover(tg, T0 - 7 * DAY, T0, 'exclude');
  assert.ok(before.length >= 7);
  assert.equal(after.length, before.filter((x) => x.from < T0 - 2 * DAY).length, '지운 시각 전 구간은 남는다');
  assert.ok(after.every((x) => x.to <= T0 - 2 * DAY), '지운 뒤 구간은 없다');
  assert.equal(MJ.stateFor(tg, T0 - 3 * HOUR + MIN).active, false, '지금 판정에서는 빠진다');
  assert.equal(J.windowStatus({ ...w, deleted: { at: T0 - 2 * DAY } }, T0).status, 'deleted');
  // 묘비는 보관 90일(쓰기 때 정리) — 정리 뒤에는 구간도 없다(정직 기록)
  assert.equal(ST.listWindows().filter((x) => x.deleted).length, 1);
});

test('⑦ F6 — windowStatus 조각 탐색: 400일 전부 세는 옛 답과 같다 · 매일 반복 창 하나가 가볍다', () => {
  const old = (w, now) => {   // 옛 구현(반증 판 — 비교 기준)
    const next = J.effectiveOccurrences(w, now, now + 400 * DAY).find((o) => o.start > now) || null;
    const past = J.effectiveOccurrences(w, now - 90 * DAY, now).filter((o) => o.end <= now);
    return { next, last: past.length ? past[past.length - 1] : null };
  };
  const cases = [
    win({ schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '02:00', durMin: 120 }, tz: 'Europe/Warsaw' }),
    win({ schedule: { kind: 'weekly', days: [3], time: '23:30', durMin: 600 } }),
    win({ schedule: { kind: 'monthly', nth: 5, weekday: 0, time: '02:30', durMin: 60 }, tz: 'Europe/Warsaw' }),
    win({ schedule: { kind: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 }, confirmedAt: NOW - 80 * DAY }),   // 12일 뒤 만료
    win({ schedule: { kind: 'once', start: loc(NOW + 3 * DAY), end: loc(NOW + 3 * DAY + HOUR) } }),
    win({ schedule: { kind: 'once', start: loc(NOW - 3 * DAY), end: loc(NOW - 3 * DAY + HOUR) } }),
  ];
  for (const w of cases) {
    const st = J.windowStatus(w, NOW); const o = old(w, NOW);
    assert.deepEqual(st.last ?? null, o.last, `last ${w.schedule.kind}`);
    if (st.status !== 'expired') assert.deepEqual(st.next ?? null, o.next, `next ${w.schedule.kind}`);
  }
  const daily = cases[0];
  const t = performance.now(); for (let i = 0; i < 20; i += 1) J.windowStatus(daily, NOW); const per = (performance.now() - t) / 20;
  assert.ok(per < 3, `매일 반복 창 하나 ${per.toFixed(2)}ms(반증 실측 7~11ms)`);
});

test('⑧ F5 — 합친 덮임 규칙(순수): 같은 서버 비소유자 창 합이 24시간 중 12시간 초과면 소유자 · 다른 법인 · 소유자 창 · 다른 서버는 빠진다', () => {
  const all7 = [0, 1, 2, 3, 4, 5, 6];
  const am = win({ id: 'mw-am000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }, approvedBy: '' });
  const pm = win({ id: 'mw-pm000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'weekly', days: all7, time: '12:00', durMin: 720 } });
  assert.equal(ST.coverNeedsOwner(pm, [am], NOW), true, '12h + 12h = 24h');
  assert.equal(ST.coverNeedsOwner(pm, [{ ...am, approvedBy: 'own' }], NOW), false, '소유자가 저장한 창은 합에서 빠진다');
  assert.equal(ST.coverNeedsOwner(pm, [{ ...am, vcenterId: 'vcB' }], NOW), false, '다른 법인(같은 키)은 다른 서버');
  assert.equal(ST.coverNeedsOwner(pm, [{ ...am, target: { kind: 'server', keys: ['S2'] } }], NOW), false, '다른 서버');
  const shortPm = { ...pm, schedule: { ...pm.schedule, time: '13:00', durMin: 600 } };   // 00~12 + 13~23 → 어느 24시간이든 22시간
  assert.equal(ST.coverNeedsOwner(shortPm, [am], NOW), true);
  const ok = { ...pm, schedule: { ...pm.schedule, time: '18:00', durMin: 60 } };          // 12 + 1 = 13 > 12 → 소유자
  assert.equal(ST.coverNeedsOwner(ok, [am], NOW), true);
  const fine = { ...am, id: 'mw-sm000001', schedule: { kind: 'weekly', days: all7, time: '02:00', durMin: 360 } };   // 같은 시간대 안(겹침) — 합집합 12h
  assert.equal(ST.coverNeedsOwner(fine, [am], NOW), false, '겹치는 창은 합집합으로(12시간 그대로)');
  // 일회 12h 두 개 이어 붙이기
  const s0 = NOW + HOUR;
  const o1 = win({ id: 'mw-o1000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'once', start: loc(s0), end: loc(s0 + 12 * HOUR) } });
  const o2 = win({ id: 'mw-o2000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'once', start: loc(s0 + 12 * HOUR), end: loc(s0 + 24 * HOUR) } });
  assert.equal(ST.coverNeedsOwner(o2, [o1], NOW), true);
  // 매월(마지막 일요일 12h) + 매월 첫 월요일 00:00 12h — 달마다 맞닿는 달이 다르다(400일 기준점)
  const lastSun = win({ id: 'mw-ls000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'monthly', nth: 5, weekday: 0, time: '12:00', durMin: 720 } });
  const firstMon = win({ id: 'mw-fm000001', target: { kind: 'server', keys: ['S1'] }, schedule: { kind: 'monthly', nth: 1, weekday: 1, time: '00:00', durMin: 720 } });
  assert.equal(ST.coverNeedsOwner(firstMon, [lastSun], NOW), true, '마지막 일요일 다음 날이 첫 월요일인 달');
  // 24시간 창의 끝을 후보 발생 끝에 맞춰야 드러나는 합(이 규칙 전에 만든 비소유자 창 둘이 22시간 이어짐 + 5시간 뒤 6시간 후보 → [9h, 33h) 에 19시간)
  const t1 = NOW + 2 * HOUR;
  const l1 = win({ id: 'mw-l1000001', target: { kind: 'server', keys: ['S9'] }, schedule: { kind: 'once', start: loc(t1), end: loc(t1 + 11 * HOUR) } });
  const l2 = win({ id: 'mw-l2000001', target: { kind: 'server', keys: ['S9'] }, schedule: { kind: 'once', start: loc(t1 + 10 * HOUR), end: loc(t1 + 22 * HOUR) } });
  const c6 = win({ id: 'mw-c6000001', target: { kind: 'server', keys: ['S9'] }, schedule: { kind: 'once', start: loc(t1 + 27 * HOUR), end: loc(t1 + 33 * HOUR) } });
  assert.equal(ST.coverNeedsOwner(c6, [l1, l2], NOW), true, '창 시작만 보면 6시간 — 끝 맞춤에서 19시간');
});
