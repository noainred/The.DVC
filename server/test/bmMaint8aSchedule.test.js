/**
 * 리눅스 성능 8a단계 — 정비 창 **일정 계산 · 판정 코어 · 저장소**(설계 PROFILES §20 ⑲). 고정하는 규약:
 *   ① 일정: 일회 · 매주 요일 · 매월 n째(5=마지막) 요일 · 법인 시간대 · DST(없는 시각은 간격만큼 뒤로 · 두 번 있는 시각은 앞의 것 · 길이는 실제 경과) · 길이 상한(계산도 자른다)
 *   ② 판정 코어 하나: 대상(서버 · 태그 · 법인 — 태그는 그 법인 안만) · 겹치는 창은 범위별 합집합 · 억제 시한(발생 끝 · 지금 끝내기 · 반복 재확인 만료) ·
 *      모르는 일정 = 억제 없음 · 중앙 판정(수동 태그) = 엣지 판정(배포본의 펼친 keys + 같은 정규화)
 *   ③ 저장소: 엄격 정규화(400) · 원자 쓰기 · 손상 보존 + 503 + 쓰기 거부 · 직렬 큐(동시 쓰기 유실 없음) · rev 409 · 지금 끝내기 · 배포본 TTL
 * 순수 함수는 고정 시각을 주입한다(common.md — now 주입 순수 함수는 고정 시각 허용). 저장 검사는 실제 시각을 정시로 떨어뜨린 기준.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8asch-'));
process.env.CONFIG_DIR = DIR;
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const S = await import('../src/bmusage/maint/schedule.js');
const J = await import('../src/bmusage/maint/judge.js');
const ST = await import('../src/bmusage/maint/store.js');
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

test('① 일정 — 시간대 · 일회 · 매주 · 매월 n째 · 마지막', () => {
  // 서울(UTC+9) 일회 22:00~24:00(다음 날 00:00)
  const once = { kind: 'once', start: '2026-11-07T22:00', end: '2026-11-08T00:00' };
  const occ = S.occurrencesBetween(once, 'Asia/Seoul', Date.UTC(2026, 10, 7), Date.UTC(2026, 10, 9));
  assert.deepEqual(occ.map((o) => [iso(o.start), iso(o.end)]), [['2026-11-07T13:00', '2026-11-07T15:00']]);
  // 매주 토 02:00 · 4시간 — 2026-11 토요일은 7 · 14 · 21 · 28
  const wk = { kind: 'weekly', days: [6], time: '02:00', durMin: 240 };
  const w = S.occurrencesBetween(wk, 'Asia/Seoul', Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
  assert.deepEqual(w.map((o) => iso(o.start)), ['2026-11-06T17:00', '2026-11-13T17:00', '2026-11-20T17:00', '2026-11-27T17:00']);
  assert.ok(w.every((o) => o.end - o.start === 240 * MIN));
  // 매월 둘째 토 · 마지막 금
  assert.equal(S.nthWeekdayOfMonth(2026, 11, 2, 6), 14);
  assert.equal(S.nthWeekdayOfMonth(2026, 11, 5, 5), 27);
  assert.equal(S.nthWeekdayOfMonth(2026, 2, 5, 6), 28);
  assert.equal(S.nthWeekdayOfMonth(2026, 2, 4, 0), 22);
  const mo = { kind: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 };
  const m = S.occurrencesBetween(mo, 'Asia/Seoul', Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 31));
  assert.deepEqual(m.map((o) => iso(o.start)), ['2026-10-09T17:00', '2026-11-13T17:00', '2026-12-11T17:00', '2027-01-08T17:00']);
  // 형식 밖 = 빈 발생(억제하지 않는다)
  assert.deepEqual(S.occurrencesBetween({ kind: 'weekly', days: [], time: '02:00', durMin: 60 }, 'Asia/Seoul', 0, Date.UTC(2030, 0, 1)), []);
  assert.deepEqual(S.occurrencesBetween(wk, 'Mars/Base', Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)), []);
  assert.deepEqual(S.occurrencesBetween({ kind: 'cron', expr: '* * * * *' }, 'Asia/Seoul', 0, Date.UTC(2030, 0, 1)), []);
});

test('① DST — 없는 시각은 뒤로 · 두 번 있는 시각은 앞의 것 · 길이는 실제 경과(Europe/Warsaw · America/New_York)', () => {
  // Warsaw 2026-03-29 02:00 → 03:00(봄). 02:30 은 없다 → 03:30 CEST = 01:30Z
  assert.equal(iso(S.localToUtc('Europe/Warsaw', 2026, 3, 29, 2, 30)), '2026-03-29T01:30');
  assert.equal(S.fmtLocal('Europe/Warsaw', S.localToUtc('Europe/Warsaw', 2026, 3, 29, 2, 30)), '2026-03-29 03:30');
  // 2026-10-25 03:00 → 02:00(가을). 02:30 이 두 번 → 앞의 것(CEST) = 00:30Z
  assert.equal(iso(S.localToUtc('Europe/Warsaw', 2026, 10, 25, 2, 30)), '2026-10-25T00:30');
  // 평범한 날
  assert.equal(iso(S.localToUtc('Europe/Warsaw', 2026, 7, 1, 2, 30)), '2026-07-01T00:30');
  assert.equal(iso(S.localToUtc('Europe/Warsaw', 2026, 12, 1, 2, 30)), '2026-12-01T01:30');
  // 매주 일 02:00~06:00 — 되돌림 날도 길이 4시간(벽시계 05:00 끝)
  const wk = { kind: 'weekly', days: [0], time: '02:00', durMin: 240 };
  const o = S.occurrencesBetween(wk, 'Europe/Warsaw', Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 26))[0];
  assert.equal(o.end - o.start, 4 * HOUR);
  assert.equal(S.fmtLocal('Europe/Warsaw', o.end), '2026-10-25 05:00');
  // 뉴욕 2026-03-08 02:00 → 03:00 · 02:15 없음 → 03:15 EDT = 07:15Z
  assert.equal(iso(S.localToUtc('America/New_York', 2026, 3, 8, 2, 15)), '2026-03-08T07:15');
  // 일회 창 길이 = 실제 경과(봄 날 01:00~05:00 벽시계 = 3시간)
  assert.equal(ST.durationMinOf({ kind: 'once', start: '2026-03-29T01:00', end: '2026-03-29T05:00' }, 'Europe/Warsaw'), 180);
});

test('① 길이 상한 — 저장 검사 + 계산에서도 자른다(손으로 고친 파일 · 배포본)', () => {
  const tooLong = { kind: 'once', start: '2026-11-07T00:00', end: '2026-11-09T00:00' };
  const occ = S.occurrencesBetween(tooLong, 'Asia/Seoul', Date.UTC(2026, 10, 5), Date.UTC(2026, 10, 12));
  assert.equal(occ[0].end - occ[0].start, 24 * HOUR, '일회 24시간에서 자른다');
  const longRecur = { kind: 'weekly', days: [1], time: '00:00', durMin: 5000 };
  const r = S.occurrencesBetween(longRecur, 'Asia/Seoul', Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 15));
  assert.ok(r.length && r.every((x) => x.end - x.start === 12 * HOUR), '반복 12시간에서 자른다');
});

const corpWin = (o = {}) => ({ id: 'mw-corp0001', name: '월간 패치', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcA', tz: 'Asia/Seoul',
  schedule: { kind: 'once', start: '2026-11-07T22:00', end: '2026-11-08T02:00' }, scopes: { alerts: true, hold: true }, at: Date.UTC(2026, 10, 1), confirmedAt: Date.UTC(2026, 10, 1), rev: 1, ...o });
const T_IN = Date.UTC(2026, 10, 7, 14);   // 서울 23:00
const T_OUT = Date.UTC(2026, 10, 7, 18);  // 서울 03:00(끝 뒤)

test('② 판정 코어 — 대상 · 범위 합집합 · 시한 · 지금 끝내기 · 재확인 만료', () => {
  const tg = { key: 'TAG1', vcenterId: 'vcA' };
  let s = J.maintStateFor([corpWin()], tg, T_IN);
  assert.equal(s.active, true); assert.equal(s.scopes.alerts, true); assert.equal(s.scopes.collect, false);
  assert.equal(s.until.alerts, Date.UTC(2026, 10, 7, 17));
  assert.equal(J.maintStateFor([corpWin()], tg, T_OUT).active, false, '끝 뒤 억제 없음(시한)');
  assert.equal(J.maintStateFor([corpWin()], { key: 'TAG1', vcenterId: 'vcB' }, T_IN).active, false, '다른 법인');
  assert.equal(J.maintStateFor([corpWin({ deleted: { at: 1, by: 'x' } })], tg, T_IN).active, false, '지운 창');
  // 서버 창 — 키
  const sv = corpWin({ id: 'mw-srv00001', target: { kind: 'server', keys: ['TAG1'] }, scopes: { collect: true } });
  assert.equal(J.maintStateFor([sv], tg, T_IN).scopes.collect, true);
  assert.equal(J.maintStateFor([sv], { key: 'TAG2', vcenterId: 'vcA' }, T_IN).active, false);
  // 합집합: 두 창 — 범위마다 늦은 끝
  const late = corpWin({ id: 'mw-late0001', schedule: { kind: 'once', start: '2026-11-07T23:00', end: '2026-11-08T05:00' }, scopes: { alerts: true } });
  s = J.maintStateFor([corpWin(), late], tg, T_IN);
  assert.equal(s.until.alerts, Date.UTC(2026, 10, 7, 20)); assert.equal(s.until.hold, Date.UTC(2026, 10, 7, 17)); assert.equal(s.windows.length, 2);
  // 지금 끝내기 — 일회는 끝을 자른다
  const ended = corpWin({ endedAt: T_IN - 10 * MIN });
  assert.equal(J.maintStateFor([ended], tg, T_IN).active, false);
  assert.equal(J.effectiveOccurrences(ended, Date.UTC(2026, 10, 7), Date.UTC(2026, 10, 9))[0].cut, true);
  // 반복 — 지금 끝내기는 그 발생만, 다음 발생은 그대로
  const wk = corpWin({ id: 'mw-week0001', schedule: { kind: 'weekly', days: [6], time: '22:00', durMin: 240 } });
  const occ = J.activeOccurrence(wk, T_IN);
  assert.ok(occ);
  const wkEnded = { ...wk, endedAt: T_IN, endedOccStart: occ.start };
  assert.equal(J.maintStateFor([wkEnded], tg, T_IN + MIN).active, false);
  assert.equal(J.maintStateFor([wkEnded], tg, T_IN + 7 * DAY).active, true, '다음 주 발생은 그대로');
  // 재확인 만료(반복 · 92일) — 확인 뒤 93일째 발생은 억제하지 않는다
  const old = { ...wk, confirmedAt: T_IN - 93 * DAY };
  assert.equal(J.maintStateFor([old], tg, T_IN).active, false);
  assert.equal(J.windowStatus(old, T_IN).status, 'expired');
  assert.equal(J.maintStateFor([{ ...wk, confirmedAt: T_IN - 10 * DAY }], tg, T_IN).active, true);
  // 형식 밖 일정 = 억제 없음
  assert.equal(J.maintStateFor([corpWin({ schedule: { kind: 'once', start: 'x', end: 'y' } })], tg, T_IN).active, false);
});

test('② 태그 창 — 그 법인 안만 · 중앙(수동 태그) 판정 = 엣지(배포본 keys + 같은 정규화) 판정', () => {
  const w = corpWin({ id: 'mw-tag00001', target: { kind: 'tag', tag: 'role:web' }, scopes: { alerts: true, focus: true } });
  const fleet = [{ key: 'W1', vcenterId: 'vcA', role: 'web' }, { key: 'W2', vcenterId: 'vcA', role: 'db' }, { key: 'W3', vcenterId: 'vcB', role: 'web' }, { key: 'W4', vcenterId: 'vcA', role: 'web' }];
  const tagsOf = (x) => (x.role ? [`role:${x.role}`] : []);
  // 중앙: 수동 태그
  const central = fleet.map((x) => J.maintStateFor([w], x, T_IN, { tagsOf }));
  assert.deepEqual(central.map((s) => s.active), [true, false, false, true]);
  // 엣지: 중앙이 펼친 keys(그 법인 · 그 태그) → 같은 정규화 → 태그 원천 없이 판정
  const deployed = ST.normalizeWindow({ ...w, target: { kind: 'tag', tag: 'role:web', keys: fleet.filter((x) => x.vcenterId === 'vcA' && tagsOf(x).includes('role:web')).map((x) => x.key) } });
  const edge = fleet.map((x) => J.maintStateFor([deployed], { key: x.key, vcenterId: x.vcenterId }, T_IN));
  assert.deepEqual(edge.map((s) => s.active), central.map((s) => s.active), '같은 입력 · 같은 판정');
  assert.deepEqual(edge.map((s) => s.scopes), central.map((s) => s.scopes));
  assert.deepEqual(edge.map((s) => s.until), central.map((s) => s.until));
});

test('② 구간 — 범위를 켠 창만 · 합치기 · 이분 탐색', () => {
  const a = corpWin({ scopes: { exclude: true } });
  const b = corpWin({ id: 'mw-bbbb0001', schedule: { kind: 'once', start: '2026-11-08T01:00', end: '2026-11-08T03:00' }, scopes: { exclude: true } });
  const c = corpWin({ id: 'mw-cccc0001', scopes: { alerts: true } });
  const iv = J.coverIntervals([a, b, c], { key: 'K', vcenterId: 'vcA' }, Date.UTC(2026, 10, 7), Date.UTC(2026, 10, 9), { scope: 'exclude' });
  assert.deepEqual(iv.map((x) => [iso(x.from), iso(x.to), x.ids.length]), [['2026-11-07T13:00', '2026-11-07T18:00', 2]]);
  assert.equal(J.inIntervals(Date.UTC(2026, 10, 7, 15), iv), true);
  assert.equal(J.inIntervals(Date.UTC(2026, 10, 7, 18), iv), false, '끝은 열린 구간');
});

const body = (o = {}) => ({ name: '디스크 교체', reason: '/data1 소진 대응', target: { kind: 'server', keys: ['TAG1'], names: ['bm-1'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
  schedule: { kind: 'once', start: S.fmtLocal('Asia/Seoul', NOW + HOUR).replace(' ', 'T'), end: S.fmtLocal('Asia/Seoul', NOW + 3 * HOUR).replace(' ', 'T') }, scopes: { alerts: true, hold: true }, ...o });

test('③ 엄격 정규화 — 형식 밖 400 · 길이 상한 · 지난 창 · 켠 범위만', () => {
  const ok = ST.normalizeWindow(body(), { strict: true, now: NOW, fresh: true });
  assert.deepEqual(ok.scopes, { alerts: true, hold: true });
  const e = (o, re) => assert.throws(() => ST.normalizeWindow(body(o), { strict: true, now: NOW, fresh: true }), re);
  e({ name: '' }, /이름/);
  e({ reason: '   ' }, /사유/);
  e({ tz: 'Mars/Base' }, /시간대/);
  e({ target: { kind: 'vm' } }, /대상/);
  e({ target: { kind: 'server', keys: [] } }, /1~20/);
  e({ target: { kind: 'tag', tag: 'web' } }, /role/);
  e({ scopes: {} }, /하나 이상/);
  e({ scopes: { alerts: true, nuke: true } }, /억제 범위/);
  e({ schedule: { kind: 'once', start: '2026-02-30T01:00', end: '2026-03-01T01:00' } }, /YYYY/);
  e({ schedule: { kind: 'weekly', days: [7], time: '02:00', durMin: 60 } }, /요일/);
  e({ schedule: { kind: 'weekly', days: [1], time: '02:00', durMin: 721 } }, /720/);
  e({ schedule: { kind: 'monthly', nth: 6, weekday: 1, time: '02:00', durMin: 60 } }, /n째/);
  const start = S.fmtLocal('Asia/Seoul', NOW + HOUR).replace(' ', 'T');
  e({ schedule: { kind: 'once', start, end: S.fmtLocal('Asia/Seoul', NOW + 26 * HOUR).replace(' ', 'T') } }, /24시간/);
  e({ schedule: { kind: 'once', start: S.fmtLocal('Asia/Seoul', NOW - 3 * HOUR).replace(' ', 'T'), end: S.fmtLocal('Asia/Seoul', NOW - HOUR).replace(' ', 'T') } }, /이미 끝난/);
  // 소유자 등급 판정(순수) — 법인 · 태그 · 12시간 초과
  assert.equal(ST.needsOwnerTier(ok), false);
  assert.equal(ST.needsOwnerTier({ ...ok, target: { kind: 'corp' } }), true);
  assert.equal(ST.needsOwnerTier({ ...ok, target: { kind: 'tag', tag: 'role:web' } }), true);
  const long = ST.normalizeWindow(body({ schedule: { kind: 'once', start, end: S.fmtLocal('Asia/Seoul', NOW + 14 * HOUR).replace(' ', 'T') } }), { strict: true, now: NOW, fresh: true });
  assert.equal(ST.needsOwnerTier(long), true);
});

test('③ 저장소 — 직렬 큐 동시 쓰기 · rev 409 · 지금 끝내기 · 지우기 · 손상 503 + 보존 + 쓰기 거부', async () => {
  ST._resetMaintStoreForTest();
  const made = await Promise.all(Array.from({ length: 12 }, (_, i) => ST.addWindow(body({ name: `창${i}` }), { by: 'op', now: NOW })));
  assert.equal(new Set(made.map((w) => w.id)).size, 12);
  assert.equal(ST.listWindows().length, 12, '동시 12건 유실 없음');
  const w0 = made[0];
  await assert.rejects(ST.editWindow(w0.id, { name: 'x' }, { by: 'op', rev: 99, now: NOW }), (e) => e.status === 409);
  const ed = await ST.editWindow(w0.id, { name: '이름 바꿈' }, { by: 'op', rev: 1, now: NOW });
  assert.equal(ed.rev, 2); assert.deepEqual(ed.edits.at(-1).fields, ['name']);
  await assert.rejects(ST.editWindow(w0.id, { vcenterId: 'vcB' }, { by: 'op', rev: 2, now: NOW }), /법인/);
  await assert.rejects(ST.editWindow(w0.id, { name: 'y' }, { by: 'op', now: NOW }), (e) => e.status === 409 && e.code === 'rev-required', 'rev 없는 쓰기는 409');
  await assert.rejects(ST.endWindowNow(w0.id, { by: 'op', rev: 2, now: NOW }), (e) => e.code === 'not-active', '예정 창은 끝낼 수 없다');
  const fin = await ST.endWindowNow(w0.id, { by: 'op', rev: 2, now: NOW + 90 * MIN });
  assert.equal(J.windowStatus(fin, NOW + 91 * MIN).status, 'ended');
  await ST.deleteWindow(made[1].id, { by: 'op', rev: 1, now: NOW });
  const W = ST.windowsForJudge(NOW);
  assert.equal(W.windows.filter((x) => !x.deleted).length, 11, '지운 창은 묘비로만 남는다');
  assert.equal(J.maintStateFor(W.windows.filter((x) => x.id === made[1].id), { key: 'K1', vcenterId: 'vcA' }, NOW + 61 * MIN).active, false, '지운 창은 지금 판정에서 빠진다');
  // 손상 → 보존 + 503 + 쓰기 거부 + 판정은 이 노드 창 없이(억제 없음) + 표지
  fs.writeFileSync(path.join(DIR, 'maintenance-windows.json'), '{broken');
  ST._resetMaintStoreForTest();
  assert.throws(() => ST.listWindows(), (e) => e.status === 503);
  await assert.rejects(ST.addWindow(body(), { by: 'op', now: NOW }), (e) => e.status === 503);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('maintenance-windows.json.corrupt')));
  const W2 = ST.windowsForJudge(NOW);
  assert.equal(W2.localUnreadable, true); assert.equal(W2.windows.length, 0);
  assert.ok(ST.maintLoadError());
});

test('③ 배포본 — 같은 정규화 · 형식 밖은 버리고 센다 · TTL 지나면 판정에 넣지 않는다(억제 시한)', () => {
  const good = { ...corpWin(), id: 'mw-dep00001' };
  const r = ST.saveDeployed([good, { id: 'mw-bad00001', name: 'x' }, 'str', { ...good, id: 'mw-dep00002', scopes: { alerts: true, rootkit: true } }], { sig: 'a'.repeat(32), now: NOW });
  assert.equal(r.n, 1); assert.equal(r.dropped, 3);
  let W = ST.windowsForJudge(NOW + HOUR);
  assert.equal(W.deployed.n, 1); assert.equal(W.deployed.stale, false);
  assert.ok(W.windows.some((w) => w.id === 'mw-dep00001' && w.origin === 'central'));
  W = ST.windowsForJudge(NOW + ST.DEPLOY_TTL_MS + MIN);
  assert.equal(W.deployed.stale, true);
  assert.ok(!W.windows.some((w) => w.origin === 'central'), '오래된 배포본으로 억제하지 않는다');
  fs.writeFileSync(path.join(DIR, 'maintenance-windows-deployed.json'), '{x');
  ST._resetMaintStoreForTest();
  const W3 = ST.windowsForJudge(NOW);
  assert.equal(W3.deployed.unreadable, true);
  assert.ok(!W3.windows.some((w) => w.origin === 'central'));
});
