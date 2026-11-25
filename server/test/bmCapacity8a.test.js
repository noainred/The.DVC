/**
 * 리눅스 성능 8a단계 — 용량 소진 예측(설계 PROFILES §20 ⑱ · 아트보드 Capacity). 고정하는 규약(순수 — 고정 날짜를 주입한다: common.md 순수 함수 예외):
 *   ① 선형(최소제곱) · R² · 값이 전부 같으면 r2 null(추세 없음 — 0 도 1 도 아니다)
 *   ② 데이터 부족(14일 창 점 < 7) · 결측 일은 0 으로 메우지 않는다 · 정비 창 날 제외(센다)
 *   ③ 불안정(R² < 0.5 · 14일/30일 기울기 ±30%) — 예측 값을 내지 않는다(최근 30일 최대만)
 *   ④ 리셋(하루 −10%p) 뒤부터 창 · 증가 없음(평탄 · 감소)은 ‘안전’ 이 아니라 no-growth · 도달 · 1년 넘음
 *   ⑤ 서버 자원 행 — 마운트 fs · inode(xfs 동적 · 값 없음은 ‘상한 없음’) · 메모리 ‘참고’ · 함대 요약은 서버 수로(부족 · 불안정 따로)
 *   ⑥ 하루 1회 계산 · 저장(원자 쓰기 · 손상 보존) · 재계산 시점 · 알림 규칙 ‘소진 ≤ N일’ 칸
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8acap-'));
process.env.CONFIG_DIR = DIR;
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const C = await import('../src/bmusage/capacity.js');
const TODAY = '2026-11-06';
const d = (back) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
/** 오늘부터 거꾸로 n일 — f(i) = i일 전의 값(i=0 이 오늘). */
const series = (nDays, f) => Array.from({ length: nDays }, (_, i) => ({ day: d(nDays - 1 - i), v: f(nDays - 1 - i) }));

test('① 선형 · R²', () => {
  const f = C.linFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  assert.equal(f.slope, 2); assert.equal(f.intercept, 1); assert.equal(f.r2, 1);
  assert.equal(C.linFit([{ x: 0, y: 5 }, { x: 1, y: 5 }]).r2, null, '평탄 = 추세 없음(null)');
  assert.equal(C.linFit([{ x: 0, y: 5 }]), null);
});

test('② 예측 · 데이터 부족 · 결측 · 정비 창 날 제외', () => {
  // 30일 동안 하루 +0.9%p · 오늘 87.2%
  const s = series(30, (back) => 87.2 - back * 0.9);
  const f = C.forecastSeries(s, { today: TODAY });
  assert.equal(f.status, 'forecast'); assert.equal(f.slope, 0.9); assert.equal(f.conf, 'high'); assert.equal(f.current, 87.2);
  assert.equal(f.daysToTarget, 4, '(90−87.2)/0.9 = 3.1 → 올림 4'); assert.equal(f.dateToTarget, '2026-11-10');
  assert.equal(f.daysTo100, 15);
  // 6일만 — 데이터 부족(0일 · 안전으로 적지 않는다)
  const few = C.forecastSeries(series(6, (b) => 50 + b), { today: TODAY });
  assert.equal(few.status, 'insufficient'); assert.equal(few.daysToTarget, null); assert.equal(few.n, 6);
  // 결측(null)은 점이 아니다 — 14일 중 8일 결측이면 부족
  const gaps = C.forecastSeries(series(14, (b) => (b % 2 || b === 0 ? null : 50 + (14 - b))), { today: TODAY });
  assert.ok(gaps.missing >= 6); assert.equal(gaps.status, 'insufficient');
  // 정비 창 날은 빼고 센다 — 창 날에 튄 값(99%)이 추세를 흔들지 않는다
  const ex = series(20, (b) => (b === 3 ? 99 : 60 + (20 - b) * 0.5)).map((x) => (x.day === d(3) ? { ...x, excluded: true } : x));
  const fe = C.forecastSeries(ex, { today: TODAY });
  assert.equal(fe.excluded, 1); assert.equal(fe.status, 'forecast'); assert.equal(fe.slope, 0.5);
});

test('③ 불안정 — R² < 0.5 · 14일/30일 기울기 ±30% · 예측 값 없음(최근 30일 최대만)', () => {
  // 흔들림 ±4(하루 하락 8%p — 리셋 기준 10 미만)에 기울기 0.2 — R² 가 낮다
  const noisy = series(14, (b) => 50 + (b % 2 ? 4 : -4) + (14 - b) * 0.2);
  const u = C.forecastSeries(noisy, { today: TODAY });
  assert.equal(u.status, 'unstable'); assert.equal(u.reason, 'r2'); assert.equal(u.daysToTarget, null); assert.ok(u.max30 != null);
  // 주기 정리형(이틀마다 −15%p) — 리셋이 잦으면 ‘데이터 부족’ 이 아니라 불안정(periodic-reset)
  const saw = C.forecastSeries(series(30, (b) => 60 + (b % 2 ? 0 : -15) + (30 - b) * 0.05), { today: TODAY });
  assert.equal(saw.status, 'unstable'); assert.equal(saw.reason, 'periodic-reset'); assert.ok(saw.resets30 >= 2);
  // 30일 중 앞 16일은 평탄 · 뒤 14일 급증 → 14일 기울기가 30일보다 30% 넘게 큼
  const step = series(30, (b) => (b >= 14 ? 40 + (30 - b) * 0.1 : 41.6 + (14 - b) * 1.5));
  const s2 = C.forecastSeries(step, { today: TODAY });
  assert.equal(s2.status, 'unstable'); assert.equal(s2.reason, 'slope-diff'); assert.ok(s2.slope30 < s2.slope);
});

test('④ 리셋 뒤부터 · 증가 없음 · 도달 · 1년 넘음', () => {
  // 재부팅 리셋형 메모리: 40일 전부터 오르다 12일 전 −30%p 떨어짐 → 그 뒤 12점은 부족(7 이상이면 예측)
  const m = series(40, (b) => (b >= 12 ? 50 + (40 - b) * 1 : 48 + (12 - b) * 1.1));
  const f = C.forecastSeries(m, { today: TODAY });
  assert.equal(f.reset, true); assert.equal(f.resetDay, d(11)); assert.equal(f.n, 12, '리셋 뒤 12점만');
  assert.equal(f.status, 'forecast'); assert.equal(f.slope, 1.1);
  // 평탄 · 감소
  assert.equal(C.forecastSeries(series(14, () => 55), { today: TODAY }).status, 'no-growth');
  const down = C.forecastSeries(series(14, (b) => 40 + b * 0.5), { today: TODAY });
  assert.equal(down.status, 'no-growth'); assert.equal(down.reason, 'declining');
  // 이미 목표선 위
  const re = C.forecastSeries(series(14, (b) => 91 + (14 - b) * 0.1), { today: TODAY });
  assert.equal(re.status, 'reached'); assert.equal(re.daysToTarget, 0);
  // 1년 넘음
  const slow = C.forecastSeries(series(14, (b) => 10 + (14 - b) * 0.02), { today: TODAY });
  assert.equal(slow.status, 'forecast'); assert.equal(slow.daysToTarget, null); assert.equal(slow.beyondTarget, true);
});

test('⑤ 서버 자원 행 — fs · inode(xfs 동적 · 값 없음) · 메모리 참고 · 함대 요약', () => {
  const mountRows = [];
  for (let b = 0; b < 20; b += 1) {
    mountRows.push({ day: d(b), mount: '/data1', used_pct_max: 87.2 - b * 0.9, inode_pct_max: 10, size_bytes: 8e12 });
    mountRows.push({ day: d(b), mount: '/', used_pct_max: 30, inode_pct_max: null });
  }
  const dailyRows = Array.from({ length: 20 }, (_, b) => ({ day: d(b), mem_max: 60 + (20 - b) * 0.3 }));
  const rows = C.forecastServer({ key: 'K1', mountRows, dailyRows, dynInodeMounts: new Set(['/data1']), today: TODAY });
  const by = (k, r) => rows.find((x) => x.kind === k && x.res === r);
  assert.equal(by('fs', '/data1').status, 'forecast'); assert.equal(by('fs', '/data1').sizeBytes, 8e12);
  assert.equal(by('inode', '/data1').status, 'no-limit'); assert.equal(by('inode', '/data1').reason, 'xfs-dynamic');
  assert.equal(by('inode', '/').status, 'no-limit'); assert.equal(by('inode', '/').reason, 'no-inode-limit');
  assert.equal(by('fs', '/').status, 'no-growth');
  assert.equal(by('mem', 'mem').grade, 'ref'); assert.equal(by('mem', 'mem').status, 'forecast');
  assert.equal(rows.some((x) => 'fit' in x), false, '저장 행에는 맞춤선 원자료를 싣지 않는다');
  const sum = C.summarize([...rows, { key: 'K2', kind: 'fs', res: '/', status: 'insufficient' }, { key: 'K3', kind: 'fs', res: '/', status: 'unstable' }]);
  assert.equal(sum.servers, 3); assert.equal(sum.soon, 1); assert.equal(sum.soonByKind.fs, 1); assert.equal(sum.insufficient, 1); assert.equal(sum.unstable, 1);
  // 정비 창 구간 → 제외 날짜(포탈 날)
  const days = C.excludedDaysOf([{ from: Date.UTC(2026, 10, 5, 14), to: Date.UTC(2026, 10, 5, 18) }], 0, Date.UTC(2026, 10, 30));
  assert.deepEqual([...days], ['2026-11-05', '2026-11-06'], '서울 23:00~03:00 은 두 날');
});

test('⑥ 하루 계산 · 저장 · 손상 보존 · 재계산 시점 · 알림 규칙 칸', async () => {
  C._resetCapacityForTest();
  const now = Date.parse(`${TODAY}T03:00:00Z`);   // 서울 12:00
  const fake = {
    readMountDaily: async ({ key }) => ({ rows: key === 'K1' ? Array.from({ length: 20 }, (_, b) => ({ day: d(b), mount: '/data1', used_pct_max: 87.2 - b * 0.9, inode_pct_max: 5 + (20 - b) * 0.01 })) : [] }),
    readDailyRange: async () => ({ live: Array.from({ length: 20 }, (_, b) => ({ day: d(b), mem_max: 50 + (20 - b) * 0.5 })), mig: [] }),
  };
  const r = await C.recomputeCapacity({ targets: [{ key: 'K1', name: 'gp04', vcenterId: 'vcA', paths: ['os'] }, { key: 'K2', name: 'idrac-only', paths: ['idrac'] }], now, force: true,
    deps: { monthStore: fake, rules: { capacity: { targetPct: 90, minDays: 7 } }, judge: { cover: () => [] } } });
  assert.equal(r.ok, true); assert.equal(r.rows, 3, 'K1 fs · inode · 메모리 — K2(iDRAC 만)는 마운트 행이 없고 메모리는 OS(MemAvailable) 값이 아니라 행을 만들지 않는다');
  const saved = C.loadCapacity();
  assert.equal(saved.rows.filter((x) => x.key === 'K2').length, 0); assert.equal(saved.rows.filter((x) => x.kind === 'mem').length, 1);
  assert.equal(saved.rows[0].name, 'gp04'); assert.equal(saved.rows[0].vcenterId, 'vcA'); assert.equal(saved.day, TODAY);
  assert.equal(C.dueForRecompute(saved, now + 3_600_000), false);
  assert.equal(C.dueForRecompute(saved, Date.parse('2026-11-06T16:30:00Z')), true, '다음 포탈 날 01:30');
  assert.equal(C.dueForRecompute(saved, Date.parse('2026-11-06T15:30:00Z')), false, '다음 날 00:30 — 01:10 전');
  fs.writeFileSync(path.join(DIR, 'bm-capacity.json'), '{x');
  assert.equal(C.loadCapacity().unreadable, true);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bm-capacity.json.corrupt')));
  // ⑤ 정비 창 날 제외 — 매일 반복 창(합집합이 기간 절반 넘는 날)은 일상 몫을 빼지 않는다(r1 판독: 매일 2시간 창이 30일을 전부 지워 ‘데이터 부족’) ·
  //   그보다 1시간 넘게 더 덮인 날(일회 2시간 창이 겹친 날)만 뺀다 — 합집합 기준(창을 나눠도 같다: bmCapacity8aFix ②)
  const HOURx = 3_600_000;
  const daily = Array.from({ length: 31 }, (_, b) => ({ from: now - b * 86_400_000 - 5 * HOURx, to: now - b * 86_400_000 - 3 * HOURx }));
  const once = [{ from: now - 3 * 86_400_000 - 2 * HOURx, to: now - 3 * 86_400_000 }];
  const judge = { cover: () => [...daily, ...once].sort((a, b) => a.from - b.from) };
  const cs = await C.computeServer({ agent: '', target: { key: 'K1', paths: ['os'] }, now, cfg: {}, judge, deps: { monthStore: fake } });
  const fsx = cs.rows.find((x) => x.kind === 'fs');
  assert.equal(fsx.status, 'forecast', '매일 창이 예측을 지우지 않는다'); assert.equal(fsx.excluded, 1, '일상보다 더 덮인 날만 뺀다'); assert.equal(fsx.dailyWin, 120, '일상 몫 = 하루 120분');
  // 알림 규칙 ‘소진 ≤ N일’ — 칸 판정(못 읽음은 보류 · 0 이 아니다)
  const A = await import('../src/bmusage/perfAlerts.js');
  const rule = { cond: 'fs-inode' };
  const ctx = (rows, days = 7) => ({ capacity: { rows, days } });
  assert.equal(A.ruleCondition('capacity', ctx([{ kind: 'fs', res: '/d', status: 'forecast', daysToTarget: 4 }]), rule), true);
  assert.equal(A.ruleCondition('capacity', ctx([{ kind: 'fs', res: '/d', status: 'forecast', daysToTarget: 40 }]), rule), false);
  assert.equal(A.ruleCondition('capacity', ctx([{ kind: 'fs', res: '/d', status: 'insufficient' }]), rule), null, '데이터 부족 = 보류');
  assert.equal(A.ruleCondition('capacity', ctx([{ kind: 'mem', res: 'mem', status: 'reached' }]), rule), null, '메모리는 any 일 때만');
  assert.equal(A.ruleCondition('capacity', ctx([{ kind: 'mem', res: 'mem', status: 'reached' }]), { cond: 'any' }), true);
  assert.equal(A.ruleCondition('capacity', {}, rule), null, '결과 없음 = 보류');
  const al = A.perfAlertOf({ rule: 'capacity', key: 'K1', name: 'gp04', vcenterId: 'vcA', ctx: ctx([{ kind: 'fs', res: '/data1', status: 'forecast', daysToTarget: 4, current: 87.2, dateToTarget: '2026-11-10', targetPct: 90 }]) });
  assert.match(al.title, /용량 소진 예측 7일 안 — \/data1 87\.2% · 4일 뒤 90%/);
  assert.equal(/\*\*/.test(al.title + al.detail), false);
  const R = await import('../src/bmusage/perfRules.js');
  assert.equal(R.normalizeRules({ rules: { capacity: { on: true, autoFocus: true } } }).value.rules.capacity.autoFocus, false);
  assert.throws(() => R.normalizeRules({ capacity: { days: 0 } }), /1~90/);
});
