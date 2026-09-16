/**
 * storageGrowth2531.test.js — 스토리지 증가량(v2.531).
 *
 * 사용자 요청(2026-09-16): "특수기능에 스토리지 증가량이라는 메뉴 … 기간별로 얼마나 증가하고
 * 있는지 매트릭스 형태로" · "사용량 저장을 설정에서 지정 · 기본 5년" · "장비별로 1일·1주·1달·
 * 3개월 등 지정한 기간으로" · "증가 단위는 1기가/1TB 로 구분" · "폴링을 기본 1시간으로 변경".
 *
 * 이 파일이 고정하는 것은 **수치가 아니라 정직성 규칙**이다 — 기준선이 없을 때 0 을 내지 않는지,
 * 일부만 더한 합계를 '전체' 라 말하지 않는지, 0 바이트 스냅샷을 이력에 넣지 않는지.
 *
 * ⚠ 기준 시각은 **고정 일 인덱스**를 쓴다(CLAUDE.md: 테스트에서 `Date.now()` 를 기준 시각으로
 *   쓰지 말 것 — v2.517 에 실제로 CI 가 깨졌다). `growthMatrix` 가 `asOfDay` 를 주입받는 이유다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { growthMatrix, growthFor, normalizePeriods, labelForDays, totalsOf, DEFAULT_PERIODS } from '../src/storage/growth.js';
import { normalizeGrowthSettings, GROWTH_SPEC } from '../src/storage/growthSettings.js';
import { capacityPointEligible, dayIndex, dayLabel, DAILY_KEEP_DAYS_DEF, RAW_KEEP_DAYS_DEF } from '../src/storage/db.js';
import { INTERVAL_SPEC } from '../src/storage/intervals.js';

const D0 = 20000;                 // 고정 일 인덱스 — 실제 날짜와 무관하게 재현된다
const TB = 1024 ** 4;
const row = (id, day, used, total = 100 * TB) =>
  ({ device_id: id, day, last_ts: day * 86_400_000, total_bytes: total, used_bytes: used, max_used: used, samples: 4 });

/** 하루 1TB 씩 느는 장비 n일치. */
function ramp(id, days, startUsed = 10 * TB, perDay = TB, total = 1000 * TB) {
  return Array.from({ length: days }, (_, i) => row(id, D0 - days + 1 + i, startUsed + i * perDay, total));
}

/* ── 1. 증가량 계산 ──────────────────────────────────────────────── */

test('★ 기간별 증가량 — 요청한 구간과 기준선 날짜를 함께 낸다', () => {
  const m = growthMatrix(ramp('a', 120), { asOfDay: D0, periods: DEFAULT_PERIODS });
  const a = m.devices[0];
  assert.equal(a.growth['1d'].bytes, TB);
  assert.equal(a.growth['7d'].bytes, 7 * TB);
  assert.equal(a.growth['30d'].bytes, 30 * TB);
  assert.equal(a.growth['90d'].bytes, 90 * TB);
  assert.equal(a.growth['30d'].baselineDay, D0 - 30);
  assert.equal(a.growth['30d'].spanDays, 30);
  assert.equal(a.growth['30d'].exact, true);
  assert.equal(a.growth['30d'].perDayBytes, TB);
});

test('★ 기준선이 없으면 **0 이 아니라 null** 이다(짧은 관측을 긴 기간 증가량인 척하지 않는다)', () => {
  const m = growthMatrix(ramp('a', 10), { asOfDay: D0, periods: DEFAULT_PERIODS });
  const a = m.devices[0];
  assert.equal(a.growth['7d'].bytes, 7 * TB);
  assert.equal(a.growth['30d'].bytes, null, '관측 10일로 30일 증가량을 만들어내면 안 된다');
  assert.equal(a.growth['30d'].reason, 'no-baseline');
  assert.equal(a.growth['30d'].firstDay, D0 - 9, '가진 첫 관측일을 알려 화면이 "N일 뒤부터" 라고 말할 수 있게');
});

test('요청한 날짜에 관측이 없으면 그 이전 가장 가까운 날과 비교하고 **exact:false** 로 밝힌다', () => {
  // 30일 전(D0-30)에 구멍을 낸다 → D0-31 이 기준선이 되고 구간은 31일이다.
  const rows = ramp('a', 60).filter((r) => r.day !== D0 - 30);
  const g = growthFor({ days: rows.map((r) => r.day), map: new Map(rows.map((r) => [r.day, r])) }, D0, 30);
  assert.equal(g.exact, false);
  assert.equal(g.spanDays, 31, '실제 구간을 숨기면 31일 증가량이 30일 증가량으로 보고된다');
  assert.equal(g.bytes, 31 * TB);
});

test('감소(−)를 0 으로 깎지 않는다', () => {
  const rows = [row('a', D0 - 7, 50 * TB), row('a', D0, 40 * TB)];
  const m = growthMatrix(rows, { asOfDay: D0, periods: [{ key: '7d', days: 7, label: '1주' }] });
  assert.equal(m.devices[0].growth['7d'].bytes, -10 * TB);
});

test('미래 날짜 행을 "최신" 으로 삼지 않는다', () => {
  const rows = [...ramp('a', 40), row('a', D0 + 5, 999 * TB)];
  const m = growthMatrix(rows, { asOfDay: D0, periods: [{ key: '1d', days: 1, label: '1일' }] });
  assert.equal(m.devices[0].latestDay, D0);
  assert.equal(m.devices[0].growth['1d'].bytes, TB);
});

test('같은 날끼리 비교하면 하루 평균은 0 이 아니라 null 이다(0 으로 나누지 않는다)', () => {
  const rows = [row('a', D0, 10 * TB)];
  const g = growthFor({ days: [D0], map: new Map([[D0, rows[0]]]) }, D0, 0);
  assert.equal(g.spanDays, 0);
  assert.equal(g.perDayBytes, null);
});

/* ── 2. 합계의 정직성 ────────────────────────────────────────────── */

test('★ 합계는 기준선이 있는 장비만 더하고 **뺀 장비 수를 밝힌다**', () => {
  const rows = [...ramp('a', 120), ...ramp('b', 10)];       // b 는 30일 기준선이 없다
  const m = growthMatrix(rows, { asOfDay: D0, periods: DEFAULT_PERIODS });
  const g30 = m.totals.growth['30d'];
  assert.equal(g30.measured, 1);
  assert.equal(g30.missing, 1);
  assert.equal(g30.partial, true, 'partial 이 없으면 화면이 부분 합을 전체라고 말하게 된다');
  assert.equal(g30.bytes, 30 * TB);
  // 7일은 둘 다 기준선이 있으므로 전체 합이다.
  assert.equal(m.totals.growth['7d'].partial, false);
  assert.equal(m.totals.growth['7d'].measured, 2);
});

test('아무 장비도 기준선이 없으면 합계는 0 이 아니라 null 이다', () => {
  const m = growthMatrix(ramp('a', 3), { asOfDay: D0, periods: [{ key: '30d', days: 30, label: '1개월' }] });
  assert.equal(m.totals.growth['30d'].bytes, null);
  assert.equal(m.totals.growth['30d'].measured, 0);
});

test('사용량을 읽지 못한 장비는 합계에서 빼고 그 수를 밝힌다', () => {
  const rows = [...ramp('a', 40), { device_id: 'b', day: D0, last_ts: 1, total_bytes: 5 * TB, used_bytes: null, samples: 1 }];
  const m = growthMatrix(rows, { asOfDay: D0, periods: [{ key: '7d', days: 7, label: '1주' }] });
  assert.equal(m.totals.unknownUsed, 1);
  assert.equal(m.totals.usedBytes, m.devices.find((d) => d.deviceId === 'a').usedBytes, 'null 을 0 으로 더하지 않는다');
});

test('전 장비의 수치가 전부 null 이면 합계도 null 이다(0 은 "용량 0" 이라는 거짓)', () => {
  const t = totalsOf([{ usedBytes: null, totalBytes: null, growth: {} }], []);
  assert.equal(t.usedBytes, null);
  assert.equal(t.totalBytes, null);
});

/* ── 3. 소진 예상 ────────────────────────────────────────────────── */

test('소진 예상은 증가 중일 때만 내고, **근거로 쓴 기간**을 함께 낸다', () => {
  // 1,000TB 중 129TB 사용 · 하루 1TB 증가 → 남은 871TB / 1TB = 871일.
  const m = growthMatrix(ramp('a', 120, 10 * TB, TB), { asOfDay: D0, periods: DEFAULT_PERIODS });
  const e = m.devices[0].daysToFull;
  assert.equal(e.basis, '30d', '30일 추세를 우선한다 — 1일 추세로 수년을 외삽하지 않는다');
  assert.equal(e.days, 871);
});

test('남은 공간이 없으면 0 일이다(음수 남은 공간을 미래로 환산하지 않는다)', () => {
  const m = growthMatrix(ramp('a', 60, 10 * TB, TB, 20 * TB), { asOfDay: D0, periods: DEFAULT_PERIODS });
  assert.equal(m.devices[0].daysToFull.days, 0);
});

test('평평하거나 줄고 있으면 소진 예상을 내지 않는다', () => {
  const flat = Array.from({ length: 60 }, (_, i) => row('a', D0 - 59 + i, 10 * TB));
  const m = growthMatrix(flat, { asOfDay: D0, periods: DEFAULT_PERIODS });
  assert.equal(m.devices[0].daysToFull, null);
});

/* ── 4. 기간 입력 ────────────────────────────────────────────────── */

test('기간 입력은 정규화하고 **버린 개수를 밝힌다**', () => {
  const r = normalizePeriods('1,7,abc,30,-5,90');
  assert.deepEqual(r.periods.map((p) => p.days), [1, 7, 30, 90]);
  assert.equal(r.dropped, 2);
});

test('기간이 전부 잘못되면 기본 기간으로 떨어진다(빈 표를 그리지 않는다)', () => {
  assert.deepEqual(normalizePeriods('x,y').periods.map((p) => p.days), DEFAULT_PERIODS.map((p) => p.days));
});

test('딱 떨어지지 않는 일수는 "약 1개월" 이라 말하지 않는다', () => {
  assert.equal(labelForDays(30), '1개월');
  assert.equal(labelForDays(90), '3개월');
  assert.equal(labelForDays(45), '45일');
});

/* ── 5. 보존 설정 ────────────────────────────────────────────────── */

test('★ 사용량 저장 기간의 기본값은 **5년**이다(사용자 지정)', () => {
  assert.equal(DAILY_KEEP_DAYS_DEF, 5 * 365);
  const spec = GROWTH_SPEC.find((s) => s.key === 'dailyKeepDays');
  assert.equal(spec.def, 5 * 365);
  assert.ok(spec.presets.some((p) => p.days === 1825), '화면에 5년 프리셋이 있어야 한다');
});

test('원시 보존은 일 롤업보다 짧다(둘이 같으면 파일이 커지기만 하고 얻는 것이 없다)', () => {
  assert.ok(RAW_KEEP_DAYS_DEF < DAILY_KEEP_DAYS_DEF);
});

test('빈 값·0 을 하한으로 승격하지 않는다(미입력과 최소값 지정은 다른 뜻)', () => {
  const r = normalizeGrowthSettings({ dailyKeepDays: '', rawKeepDays: 0 });
  assert.deepEqual(r.values, {});
  assert.equal(r.issues.length, 1, '0 은 무시했다고 말해야 한다');
});

test('범위를 벗어난 값은 clamp 하고 그 사실을 밝힌다', () => {
  const r = normalizeGrowthSettings({ dailyKeepDays: 99999 });
  assert.equal(r.values.dailyKeepDays, 3650);
  assert.ok(r.issues[0].includes('3650'));
});

/* ── 6. 0 바이트 적재 결함(D1) ───────────────────────────────────── */

test('★ 수집은 성공(ok)했지만 용량을 못 읽은 스냅샷은 이력에 넣지 않는다', () => {
  // Unity/Isilon: ok = (config==='ok' || capacity==='ok') — 용량 파싱이 실패해도 ok 가 true 다.
  assert.deepEqual(capacityPointEligible({ ok: true, capacity: { totalBytes: 0, usedBytes: 0 } }),
    { ok: false, reason: 'no-capacity' }, '0 바이트 행 하나가 증가량을 -106TB → +106TB 로 만든다');
  // VPLEX: 가상화 계층이라 자체 용량이 없다(capacity 섹션이 의도적으로 skip).
  assert.equal(capacityPointEligible({ ok: true, capacity: {} }).ok, false);
  assert.equal(capacityPointEligible({ ok: false, capacity: { totalBytes: 100 } }).ok, false);
  assert.equal(capacityPointEligible({ ok: true, capacity: { totalBytes: 100 } }).ok, true);
});

/* ── 7. 일 경계 · 폴링 주기 ──────────────────────────────────────── */

test('하루 경계는 한국 시각(UTC+9) 기준이다 — UTC 로 자르면 오전 9시에 날이 바뀐다', () => {
  const a = dayIndex(Date.parse('2026-09-16T23:30:00+09:00'));
  const b = dayIndex(Date.parse('2026-09-16T00:30:00+09:00'));
  assert.equal(a, b, '같은 한국 날짜는 같은 일 인덱스여야 한다');
  assert.equal(dayLabel(a), '2026-09-16');
  assert.equal(dayIndex(Date.parse('2026-09-17T00:30:00+09:00')), a + 1);
});

test('★ 스토리지 수집 기본 주기는 1시간이다(사용자 지시)', () => {
  const poll = INTERVAL_SPEC.find((s) => s.key === 'pollMs');
  assert.equal(poll.def, 60 * 60_000);
  assert.ok(poll.min <= poll.def, '하한이 기본값보다 크면 저장이 불가능해진다');
});

/* ── 8. 화면이 실제로 있는 CSS 클래스만 쓰는가(v2.531.1) ──────────────────
 *
 * 왜 소스를 검사하나: 단위 테스트는 **문자열과 판정**만 본다. 없는 클래스를 달아도 아무도 틀렸다고
 * 말해 주지 않고, 화면은 '스타일이 안 먹은 상태' 로 조용히 나온다 — v2.531 초판이 실제로 그랬다:
 *   ① `className="kpi"` — `styles.css` 에 `.kpi` **단독 박스 규칙이 없다**(자식 규칙뿐). 포탈의
 *      다른 26곳은 전부 `card kpi` 다. 그래서 핵심 수치 7개가 **배경·테두리 없이 맨 텍스트**로 나왔다.
 *   ② `className="rpt-table"` — 그런 규칙 자체가 없다(있는 것은 `.rpt-wrap`). 죽은 클래스였다.
 * 둘 다 **브라우저로 봐야** 보이는 종류이고, 실제로 스크린샷 판독에서 잡혔다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const readWeb = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
/**
 * 주석을 걷어낸 소스. ⚠ **이것 없이 원문을 검사하면 주석이 코드로 읽힌다** — 이 테스트의 첫 판이
 * 정확히 그랬다: 결함을 설명하려고 주석에 적어 둔 `className="kpi"`·`rpt-wrap` 을 실제 사용으로
 * 보고 방금 고친 코드를 '아직 결함' 이라 보고했다(테스트가 틀린 것을 본 것이다).
 * `//` 는 줄 앞 공백 뒤에 있을 때만 주석으로 본다 — `https://` 를 자르지 않기 위해서다.
 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('★ 핵심 수치 타일은 `card kpi` 다 — `kpi` 단독은 박스가 통째로 안 걸린다', () => {
  const src = codeOf(readWeb('views/tools/StorageGrowthTool.jsx'));
  assert.match(src, /className="card kpi"/, 'ReportKpi 가 card 를 잃으면 KPI 가 맨 텍스트가 된다');
  const bare = [...src.matchAll(/className="kpi"/g)];
  assert.equal(bare.length, 0, '`className="kpi"` 단독은 쓰지 않는다');
});

test('★ 화면이 쓰는 CSS 클래스는 전부 styles.css 에 실제로 존재한다', () => {
  const css = readWeb('styles.css');
  const src = readWeb('views/tools/StorageGrowthTool.jsx');
  // 정적 문자열 className 만 본다(템플릿 리터럴은 값이 런타임에 정해져 여기서 판정할 수 없다).
  const used = new Set();
  for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
    for (const t of m[1].trim().split(/\s+/)) if (t) used.add(t);
  }
  assert.ok(used.size > 0, '클래스를 하나도 못 읽었다면 이 테스트가 무의미해진 것이다');
  const missing = [...used].filter((t) => !new RegExp(`\\.${t.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css));
  assert.deepEqual(missing, [], `styles.css 에 없는 클래스: ${missing.join(', ')} — 규칙이 하나도 안 걸린다`);
});

test('숫자 칸을 `rpt-wrap` 으로 풀지 않는다(v2.525 — 단어 중간에서 쪼개진다)', () => {
  const src = codeOf(readWeb('views/tools/StorageGrowthTool.jsx'));
  assert.ok(!/rpt-wrap/.test(src), '이 표는 전역 nowrap 이 맞다');
});
