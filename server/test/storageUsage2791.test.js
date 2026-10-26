/**
 * storageUsage2791.test.js — 스토리지 사용량 보고서 v2.791 회귀: ISO 주차 · 전체 누적 · PowerScale HDD/SSD 풀 분리.
 *
 * 사용자 요청(2026-10-26): "누적된 모든 주간 사용량을 표시해줘, 2026년 1주차, 2주차..." (주차 기준 = ISO 8601 선택) ·
 *   "파워스케일/아이실론 스토리지는 HDD 풀과 SSD 풀 사용량을 분리해서 보여줘".
 *
 * 고정하는 것:
 *  ① ISO 주차 — 엑셀 ISOWEEKNUM 과 같은 번호(연말·연초 경계, 53주 해) · 주간 기간의 label/isoKey/dayLabel
 *  ② 전체 누적 — 'all' 은 주간·월간만 · 가장 이른 이력이 든 기간부터 · 상한 allMax
 *  ③ 풀 — 두 풀이 다 있으면 pools 두 줄 · 한 풀만 있으면 열 없이 poolNote · 매체 값이 없으면 아무것도 · PowerScale 만 ·
 *         못 읽은 풀 사용량은 null(0 이 아니다) · 풀은 합계(aggregateCells)에 더하지 않는다
 *  ④ DB·라우터 — 일 롤업 구간 조각 읽기 · ?count=all 이 첫 이력 주부터 오늘 주까지 · 풀이 응답에 실린다
 *  ⑤ 판단 자료(usageInsights) — 조치 항목 기준·순서·도달 예상 문구 · 증가 상위 · 풀별 · 못 읽음 · 부분 합은 대비를 내지 않음
 *  ⑥ 엑셀 — 5시트 · 주간 시트 머리 4줄·고정·ISO 주차 행 · 숫자 칸은 숫자(못 읽음은 빈 칸) · 수집 전 회색 · 데이터 시트 자동 필터 ·
 *         데이터 시트 줄이기 · 워커 결과 = 인라인 결과 · 워커를 못 띄우면 인라인
 *  ⑦ 메일 — 가짜 SMTP 로 보내고 첨부를 풀어 엑셀로 다시 읽는다 · 첨부 상한을 넘으면 첨부 없이 보내고 본문이 밝힌다 · 내려받기 라우트 · 동시 1건
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import ExcelJS from 'exceljs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'storageusage2791-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const T = 1024 ** 4;
const DAY = 86_400_000;
// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지 — storageUsage2789 머리말).
const R = await import('../src/storage/usageReport.js');
const db = await import('../src/storage/db.js');
const reg = await import('../src/storage/registry.js');
const { api } = await import('../src/routes/api.js');
const I = await import('../src/storage/usageInsights.js');
const X = await import('../src/storage/usageXlsx.js');
const M = await import('../src/storage/usageMailRules.js');
const U = await import('../src/storage/usageMail.js');
const MS = await import('../src/mail/settings.js');
const EB = await import('../src/util/exportBusy.js');
const dayOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/* ── ① ISO 주차 ──────────────────────────────────────────────────────── */
test('① ISO 주차 — 엑셀 ISOWEEKNUM 과 같은 번호 · 연도는 그 주 목요일의 연도', () => {
  // 기대값은 ISO 8601 정의(월요일 시작 · 첫 목요일이 든 주 = 1주차)로 손으로 확인한 날들
  const cases = [
    ['2026-10-26', '2026-W44'],   // 사용자 캡처의 마지막 월요일
    ['2026-09-28', '2026-W40'],   // 캡처의 첫 날짜
    ['2025-12-29', '2026-W01'],   // 2026-01-01 이 목요일 — 그 주 월요일은 전년도 날짜
    ['2026-01-04', '2026-W01'],   // 일요일은 그 주의 끝
    ['2026-01-05', '2026-W02'],
    ['2026-12-31', '2026-W53'],   // 1월 1일이 목요일인 해는 53주
    ['2027-01-03', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2024-12-30', '2025-W01'],
    ['2021-01-03', '2020-W53'],   // 윤년이 수요일에 시작 → 53주
    ['2023-01-01', '2022-W52'],
  ];
  for (const [iso, key] of cases) assert.equal(R.isoWeekKey(dayOf(iso)), key, iso);
  assert.equal(R.isoWeekLabel(dayOf('2025-12-29')), '2026년 1주차');

  const ps = R.buildPeriods({ gran: 'weekly', asOfDay: dayOf('2026-10-28'), count: 2 });
  assert.deepEqual(ps.map((p) => [p.label, p.isoKey, p.dayLabel]), [
    ['2026년 43주차', '2026-W43', '2026-10-19'], ['2026년 44주차', '2026-W44', '2026-10-26'],
  ], '기준일(월)은 dayLabel, 행 이름은 ISO 주차');
  assert.equal(ps[1].fromDay, dayOf('2026-10-20'), '값의 창은 그대로 — 기준일과 직전 6일');
  const d = R.buildPeriods({ gran: 'daily', asOfDay: dayOf('2026-10-28'), count: 1 });
  assert.equal(d[0].label, '2026-10-28'); assert.equal(d[0].isoKey, undefined, '일간·월간에는 주차를 붙이지 않는다');
});

/* ── ② 전체 누적 ─────────────────────────────────────────────────────── */
test('② 전체 누적 — 주간·월간만 · 가장 이른 이력이 든 기간부터 · 상한', () => {
  assert.deepEqual(R.normalizeReportQuery({ gran: 'weekly', count: 'all' }), { gran: 'weekly', count: R.GRANS.weekly.def, weekday: 1, all: true });
  assert.equal(R.normalizeReportQuery({ gran: 'daily', count: 'all' }).all, false, '일간에는 전체 누적이 없다');
  assert.equal(R.normalizeReportQuery({ gran: 'weekly', count: 9999 }).count, R.GRANS.weekly.max, '숫자 요청은 여전히 max 로 자른다');

  const asOf = dayOf('2026-10-28');   // 수 — 이번 주 기준일 10-26(월)
  // 2026-W01 월요일(2025-12-29)에 시작한 이력 → 1주차부터 44주차까지 44개
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: dayOf('2025-12-29') }), 44);
  const ps = R.buildPeriods({ gran: 'weekly', asOfDay: asOf, count: 44 });
  assert.equal(ps[0].isoKey, '2026-W01'); assert.equal(ps[43].isoKey, '2026-W44');
  // 첫 이력이 일요일(2025-12-28)이면 그 날을 덮는 기간(2025-12-29 기준일 — 창 12-23~12-29)이 첫 행
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: dayOf('2025-12-28') }), 44);
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: dayOf('2025-12-22') }), 45);
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: dayOf('2026-10-27') }), 1, '이번 기준일 뒤에 시작 — 1행');
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: dayOf('2010-01-04') }), R.GRANS.weekly.allMax, '상한');
  assert.equal(R.countForAll({ gran: 'weekly', asOfDay: asOf, firstDay: null }), R.GRANS.weekly.def, '이력이 없으면 기본값');
  assert.equal(R.countForAll({ gran: 'monthly', asOfDay: asOf, firstDay: dayOf('2025-12-31') }), 11, '2025-12 ~ 2026-10');
  // 전체 누적은 max(104)가 아니라 allMax 까지 — buildPeriods 가 다시 자르면 2년 넘는 이력이 잘린다(작성 중 합성 5년치로 실제 재현)
  assert.equal(R.buildPeriods({ gran: 'weekly', asOfDay: asOf, count: 200, all: true }).length, 200);
  assert.equal(R.buildPeriods({ gran: 'weekly', asOfDay: asOf, count: 200 }).length, R.GRANS.weekly.max, 'all 이 아니면 그대로 max');
  assert.equal(R.buildPeriods({ gran: 'weekly', asOfDay: asOf, count: 9999, all: true }).length, R.GRANS.weekly.allMax);
  assert.equal(R.buildPeriods({ gran: 'daily', asOfDay: asOf, count: 200, all: true }).length, R.GRANS.daily.max, '일간에는 all 이 없다');
  assert.ok(R.GRANS.weekly.allMax * 7 >= 5 * 365, '주간 상한이 일 롤업 기본 보존(5년)을 덮는다');
});

/* ── ③ 풀 ────────────────────────────────────────────────────────────── */
const row = (id, day, t, u, h, s) => ({ device_id: id, day, total_bytes: t, used_bytes: u,
  hdd_total: h ? h[0] : null, hdd_used: h ? h[1] : null, ssd_total: s ? s[0] : null, ssd_used: s ? s[1] : null });

test('③ 풀 — 두 풀이면 두 줄 · 한 풀이면 poolNote · 매체 없으면 없음 · PowerScale 만 · 못 읽음은 null · 합계에 안 더함', () => {
  const ps = R.buildPeriods({ gran: 'daily', asOfDay: 100, count: 3 });
  const devices = [
    { id: 'mix', type: 'isilon' }, { id: 'hdd', type: 'isilon' }, { id: 'ssd', type: 'isilon' },
    { id: 'old', type: 'isilon' }, { id: 'xio', type: 'xtremio' },
  ];
  const rows = [
    row('mix', 98, 100 * T, 60 * T, [92 * T, 55 * T], [8 * T, 5 * T]),
    row('mix', 99, 100 * T, 61 * T, [92 * T, null], [8 * T, 5 * T]),          // HDD 사용량 못 읽음
    row('mix', 100, 100 * T, 62 * T, [92 * T, 56 * T], [8 * T, 6 * T]),
    row('hdd', 100, 50 * T, 20 * T, [50 * T, 20 * T], null),                   // SSD 풀 없음(L3 캐시 구성)
    row('ssd', 100, 30 * T, 10 * T, null, [30 * T, 10 * T]),                   // 올플래시
    row('old', 100, 40 * T, 10 * T, null, null),                               // 매체 값을 주지 않는 수집 경로
    row('xio', 100, 20 * T, 5 * T, null, [20 * T, 5 * T]),
  ];
  const rep = R.buildUsageReport({ rows, periods: ps, devices });
  const by = Object.fromEntries(rep.map((d) => [d.deviceId, d]));
  assert.deepEqual(by.mix.pools.map((p) => p.label), ['HDD 풀', 'SSD 풀']);
  assert.deepEqual(by.mix.pools[0].cells.map((c) => (c.usedBytes == null ? null : c.usedBytes / T)), [55, null, 56], '못 읽은 풀 사용량은 null');
  assert.equal(by.mix.pools[0].cells[1].pct, null);
  assert.deepEqual(by.mix.pools[1].cells.map((c) => c && c.pct), [62.5, 62.5, 75]);
  assert.equal(by.mix.poolNote, undefined);
  assert.deepEqual([by.hdd.pools, by.hdd.poolNote], [[], 'HDD 풀만'], '한 풀만 — 장비와 같은 숫자를 한 번 더 깔지 않는다');
  assert.deepEqual([by.ssd.pools, by.ssd.poolNote], [[], 'SSD 풀만']);
  assert.deepEqual([by.old.pools, by.old.poolNote], [[], undefined], '매체 값이 없으면 이유를 단정하지 않는다');
  assert.deepEqual([by.xio.pools, by.xio.poolNote], [[], undefined], 'PowerScale 이 아니면 풀을 나누지 않는다');

  // 풀은 장비 합계의 부분 — 합계는 장비 칸만 더한다
  const agg = R.aggregateCells(rep.map((d) => ({ ...d, firstDay: 98 })), ps);
  assert.equal(agg[2].totalBytes, (100 + 50 + 30 + 40 + 20) * T);
});

/* ── ④ DB · 라우터 ───────────────────────────────────────────────────── */
async function call(url) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'root', role: 'admin', scope: {} }; next(); });
  app.use('/api', api);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}
const snap = (deviceId, type, ts, total, used, media) => ({
  deviceId, type, name: deviceId, ok: true, collectedAt: ts, capacity: { totalBytes: total, usedBytes: used }, media, extra: {},
});

test('④ DB·라우터 — 구간 조각 읽기 · ?count=all 은 첫 이력 주부터 · 풀이 응답에 실린다', async () => {
  const ps = reg.saveDevice({ type: 'isilon', name: 'PS-A', host: '10.30.0.5', username: 'svc', password: 'p' });
  const l3 = reg.saveDevice({ type: 'isilon', name: 'PS-L3', host: '10.30.0.6', username: 'svc', password: 'p' });
  // 오늘(포탈 시각)에서 날 경계로 떨어뜨린 기준(CLAUDE.md 테스트 기준 시각 규칙) — 20일 전부터 이틀 간격
  const today = db.dayIndex(Date.now());
  const first = today - 20;
  for (let d = first; d <= today; d += 2) {
    const ts = db.dayStartMs(d) + 7200_000;
    const k = d - first;
    await db.saveCapacityPoint(snap(ps.id, 'isilon', ts, 100 * T, (40 + k) * T,
      { hdd: { totalBytes: 92 * T, usedBytes: (36 + k) * T }, ssd: { totalBytes: 8 * T, usedBytes: 4 * T } }));
    if (d >= today - 6) await db.saveCapacityPoint(snap(l3.id, 'isilon', ts, 50 * T, 10 * T, { hdd: { totalBytes: 50 * T, usedBytes: 10 * T }, ssd: null }));
  }
  const rows = await db.dailyRange(first, today, { sliceDays: 3 });
  assert.equal(rows.filter((r) => r.device_id === ps.id).length, 11, '조각 경계에서 빠지거나 겹치지 않는다');
  assert.ok(rows.every((r) => r.day >= first && r.day <= today));
  assert.equal(rows.find((r) => r.device_id === l3.id).ssd_total, null, '없는 풀은 null 로 적재(0 이 아니다)');
  assert.deepEqual(await db.dailyRange(first, today, { deviceIds: ['nope'] }), []);

  const r = await call('/tools/storage-usage?gran=weekly&count=all');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.all, true);
  assert.equal(r.body.firstDay, first);
  const p0 = r.body.periods[0];
  assert.ok(p0.fromDay <= first && first <= p0.toDay, '첫 행은 첫 이력이 든 주');
  assert.equal(r.body.periods.length, r.body.count);
  assert.equal(r.body.periods[r.body.periods.length - 1].isoKey, R.isoWeekKey(r.body.periods[r.body.periods.length - 1].toDay));
  const a = r.body.devices.find((x) => x.deviceId === ps.id);
  assert.deepEqual(a.pools.map((p) => p.key), ['hdd', 'ssd']);
  const b = r.body.devices.find((x) => x.deviceId === l3.id);
  assert.equal(b.poolNote, 'HDD 풀만');
  assert.deepEqual(r.body.pools.map((p) => p.label), ['HDD 풀', 'SSD 풀'], '화면은 풀 이름을 서버 값으로');

  const n = await call('/tools/storage-usage?gran=weekly&count=4');
  assert.equal(n.body.periods.length, 4); assert.equal(n.body.all, false);
  const daily = await call('/tools/storage-usage?gran=daily&count=all');
  assert.equal(daily.body.periods.length, R.GRANS.daily.def, '일간 all 은 기본값');
});

/* ── ⑤ 판단 자료 ─────────────────────────────────────────────────────── */
// 주간 6주(2026-W39 ~ W44) — 장비마다 주별 사용량(TB)을 주고 기준일에 관측을 둔다.
const P6 = R.buildPeriods({ gran: 'weekly', asOfDay: dayOf('2026-10-28'), count: 6 });
function repOf(specs) {
  const rows = []; const devices = [];
  for (const sp of specs) {
    devices.push({ id: sp.id, name: sp.name || sp.id, type: sp.type || 'unity480', datacenterId: sp.dc || 'dc1', enabled: true });
    sp.used.forEach((u, i) => {
      if (u === undefined) return;
      const h = sp.hdd ? [sp.hdd[0] * T, sp.hdd[1][i] == null ? null : sp.hdd[1][i] * T] : null;
      const sd = sp.ssd ? [sp.ssd[0] * T, sp.ssd[1][i] == null ? null : sp.ssd[1][i] * T] : null;
      rows.push(row(sp.id, P6[i].toDay, sp.total * T, u == null ? null : u * T, h, sd));
    });
  }
  const spans = Object.fromEntries(specs.map((sp) => [sp.id, { firstDay: P6[sp.used.findIndex((x) => x !== undefined)].toDay, lastDay: P6[5].toDay }]));
  return {
    periods: P6, weekday: 1, weekdayLabels: R.WEEKDAY_LABELS, asOfLabel: '2026-10-28', asOfDay: dayOf('2026-10-28'),
    types: [{ type: 'unity480', label: 'Unity' }, { type: 'isilon', label: 'PowerScale' }],
    datacenters: [{ id: 'dc1', name: 'ESOC' }, { id: 'dc2', name: '법인 B' }],
    devices: R.buildUsageReport({ rows, periods: P6, devices, spans }),
  };
}
const SPECS = [
  { id: 'crit', total: 100, used: [86, 87, 88, 89, 90, 91] },                         // 이미 90% 넘음
  { id: 'warn', total: 100, used: [77, 78, 79, 80, 81, 82] },                         // 82% · 주당 1TB → 90% 까지 8주
  { id: 'fast', total: 100, used: [45, 50, 55, 60, 65, 70] },                         // 70% · 주당 5TB → 4주
  { id: 'slow', total: 100, used: [69.5, 69.6, 69.7, 69.8, 69.9, 70] },               // 70% · 느림 → 제외
  { id: 'flat', total: 100, used: [85, 85, 85, 85, 85, 85] },                         // 85% · 증가 없음
  { id: 'young', total: 100, used: [undefined, undefined, undefined, undefined, 84, 84.5] },   // 걸음 1개 → 추정 안 함
  { id: 'ps', type: 'isilon', total: 100, used: [50, 51, 52, 53, 54, 55], hdd: [92, [44, 44.5, 45, 45.5, 46, 46.5]], ssd: [8, [6, 6.5, 6.8, 7, 7.1, 7.04]] },
  { id: 'gone', dc: 'dc2', total: 50, used: [10, 11, 12, 13, 14, undefined] },        // 이번 주 못 읽음
  { id: 'b2', dc: 'dc2', total: 50, used: [20, 21, 22, 23, 24, 25] },
];

test('⑤ 판단 자료 — 조치 기준·급한 순·도달 예상 · 증가 상위 · 풀 · 못 읽음 · 부분 합은 대비 없음', () => {
  const ins = I.buildInsights(repOf(SPECS));
  assert.deepEqual(ins.actions.map((e) => e.key), ['crit', 'ps|pool:ssd', 'fast', 'warn', 'flat', 'young'],
    '이미 넘은 것 먼저 → 도달이 가까운 순(SSD 풀 88% · 0.26TB/주 → 2주) → 도달 예상 없는 것은 사용률 순');
  const by = Object.fromEntries(ins.actions.map((e) => [e.key, e]));
  assert.equal(by.crit.eta90, '이미 넘음');
  assert.equal(by.warn.w90, 8); assert.equal(by.warn.eta90, '2026년 52주차 (8주 뒤)');
  assert.equal(by.fast.w90, 4);
  assert.equal(by.flat.eta90, '증가 없음');
  assert.equal(by.young.eta90, '추정 안 함(이력 부족)', '걸음이 모자라면 날짜를 지어내지 않는다');
  assert.ok(!ins.actions.some((e) => e.key === 'slow'), '80% 미만이고 8주 안에 닿지 않으면 빼다');
  assert.equal(by['ps|pool:ssd'].name, 'ps › SSD 풀');
  assert.deepEqual(ins.growthTop.map((e) => e.key), ['fast', 'crit', 'warn', 'ps', 'b2'], '장비만 · 증가량 큰 순 5개');
  assert.equal(ins.poolRows.length, 1); assert.equal(ins.poolRows[0].ssd.key, 'ps|pool:ssd');
  assert.deepEqual(ins.missing.map((m) => [m.deviceId, m.corp]), [['gone', '법인 B']]);
  assert.match(ins.missing[0].why, /^마지막 관측 \d\d-\d\d\(\d+일 전\)$/);
  const b = ins.byCorp.find((g) => g.key === '법인 B');
  assert.equal(b.cur.partial, true); assert.equal(b.delta, null, '부분 합끼리 빼지 않는다'); assert.equal(b.deltaWhy, 'partial');
  const e = ins.byCorp.find((g) => g.key === 'ESOC');
  assert.ok(Math.abs(e.delta / T - 8.6) < 1e-9, `완전한 두 주의 차(1+1+5+0.1+0+0.5+1) — ${e.delta / T}`);
  assert.equal(ins.kpi.missing, 1);
  assert.equal(ins.weekLabel, '2026년 44주차'); assert.equal(ins.weekKey, '2026-W44');
  assert.equal(I.etaText(200, 1, P6[5].toDay), '2년 넘게', '먼 미래까지 직선을 늘이지 않는다');
});

/* ── ⑥ 엑셀 ─────────────────────────────────────────────────────────── */
async function readXlsx(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }
const valuesOf = (wb) => wb.worksheets.map((ws) => { const out = []; ws.eachRow({ includeEmpty: true }, (r) => out.push(JSON.stringify(r.values))); return [ws.name, out]; });

test('⑥ 엑셀 — 5시트 · 주간 시트 머리·고정·ISO 행 · 숫자 칸 · 빈 칸 · 회색 · 데이터 시트 · 줄이기 · 워커 = 인라인', async () => {
  const rep = repOf(SPECS);
  const ins = I.buildInsights(rep);
  const out = await X.buildUsageWorkbook(rep, ins, { stamp: '2026-10-28 08:00' });
  assert.equal(out.filename, 'storage-usage-weekly-2026-W44.xlsx');
  const wb = await readXlsx(out.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [...X.SHEETS]);

  const w = wb.getWorksheet('주간 사용량');
  assert.deepEqual([w.views[0].state, w.views[0].xSplit, w.views[0].ySplit], ['frozen', 2, 7], '머리 4줄 + 주차·기준일 열 고정');
  assert.equal(w.getCell('A4').value, '법인'); assert.equal(w.getCell('A7').value, '주차');
  assert.equal(w.getCell('C4').value, '법인 B', '법인 순서는 포탈 표(deviceFacets.groupBy — ko 정렬)와 같다');
  assert.equal(w.getCell('A8').value, '2026년 39주차'); assert.equal(w.getCell('B8').value, '2026-09-21');
  assert.equal(w.getCell('A13').value, '2026년 44주차');
  // 열 찾기 — 장비 'crit' 의 전체 3칸
  const col = (rowNo, text) => { let c = -1; w.getRow(rowNo).eachCell({ includeEmpty: true }, (cell, i) => { if (c < 0 && String(cell.value || '').startsWith(text)) c = i; }); return c; };
  const crit = col(5, 'crit');
  assert.ok(crit > 2);
  assert.equal(w.getCell(13, crit).value, 100); assert.equal(w.getCell(13, crit + 1).value, 91);
  assert.equal(w.getCell(13, crit + 2).value, 0.91); assert.equal(w.getCell(13, crit + 2).numFmt, '0.0%', '사용률은 % 서식의 숫자');
  assert.equal(w.getCell(13, crit + 2).fill?.fgColor?.argb, 'FFFDE2E1', '90% 이상 빨강');
  const young = col(5, 'young');
  assert.equal(w.getCell(8, young).value, null); assert.equal(w.getCell(8, young).fill?.fgColor?.argb, 'FFECEFF3', '수집 전은 회색');
  const gone = col(5, 'gone');
  assert.equal(w.getCell(13, gone + 1).value, null, '못 읽은 주는 빈 칸(0 이 아니다)');
  assert.notEqual(w.getCell(13, gone + 1).fill?.fgColor?.argb, 'FFECEFF3', '못 읽음은 회색(수집 전)이 아니다');
  const ps = col(5, 'ps');
  assert.deepEqual([w.getCell(6, ps).value, w.getCell(6, ps + 3).value, w.getCell(6, ps + 6).value], ['전체', 'HDD 풀', 'SSD 풀'], '풀은 장비 바로 뒤');

  const s = wb.getWorksheet('요약');
  const text = []; s.eachRow((r) => r.eachCell((c) => text.push(String(c.value ?? ''))));
  assert.ok(text.some((t) => t.startsWith('조치가 필요한 항목 — 6개')));
  assert.ok(text.includes('2026년 52주차 (8주 뒤)'));

  const d = wb.getWorksheet('데이터 (행 단위)');
  assert.deepEqual(d.getRow(1).values.slice(1), [...X.DATA_COLUMNS]);
  assert.ok(d.autoFilter, '자동 필터');
  assert.equal(d.getCell('A2').value, '2026-W44', '최근 주가 위');
  const goneRow = []; d.eachRow((r, i) => { if (i > 1 && r.getCell(7).value === 'gone' && r.getCell(1).value === '2026-W44') goneRow.push(r); });
  assert.equal(goneRow.length, 1); assert.equal(goneRow[0].getCell(15).value, '못 읽음'); assert.equal(goneRow[0].getCell(12).value, null);
  let youngRows = 0; d.eachRow((r, i) => { if (i > 1 && r.getCell(7).value === 'young') youngRows += 1; });
  assert.equal(youngRows, 2, '수집 전 주는 줄을 만들지 않는다');

  const small = await X.buildUsageWorkbook(rep, ins, { stamp: 'x', dataWeeks: 2 });
  assert.equal(small.dataTrimmed, true); assert.ok(small.dataRows < out.dataRows);
  const sw = await readXlsx(small.buffer);
  const legend = []; sw.getWorksheet('읽는 법').eachRow((r) => legend.push(String(r.getCell(2).value ?? '')));
  assert.ok(legend.some((t) => t.includes('메일 첨부 크기 상한')), '줄였다는 사실을 읽는 법에 밝힌다');
  assert.equal(sw.getWorksheet('주간 사용량').getCell('A8').value, '2026년 39주차', '주간 시트는 줄이지 않는다');

  // 워커 결과 = 인라인 결과(같은 함수) · 워커를 못 띄우면 인라인
  const viaWorker = await X.renderUsageWorkbook(rep, { stamp: 's' });
  assert.equal(viaWorker.mode, 'worker');
  process.env.STORAGE_XLSX_WORKER = '0';
  const inline = await X.renderUsageWorkbook(rep, { stamp: 's' });
  delete process.env.STORAGE_XLSX_WORKER;
  assert.equal(inline.mode, 'inline');
  assert.deepEqual(valuesOf(await readXlsx(viaWorker.buffer)), valuesOf(await readXlsx(inline.buffer)));
  X._setUsageXlsxWorkerUrlForTest(new URL('file:///nonexistent/usageXlsxWorker-missing.js'));
  try {
    const fb = await X.renderUsageWorkbook(rep, { stamp: 's' });
    assert.deepEqual([fb.mode, fb.reason], ['inline', 'spawn-failed']);
  } finally { X._setUsageXlsxWorkerUrlForTest(null); }
});

/* ── ⑦ 메일 · 라우터 ─────────────────────────────────────────────────── */
async function rawSmtp() {
  const st = { mails: [] };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; let cur = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) { if (line === '.') { inData = false; st.mails.push(cur); cur = { rcpt: [], data: '' }; sock.write('250 queued\r\n'); } else cur.data += `${line.startsWith('..') ? line.slice(1) : line}\n`; return; }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO')) sock.write('250-fake\r\n250 OK\r\n');
      else if (u.startsWith('RCPT TO')) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l); } });
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  after(() => new Promise((r) => srv.close(() => r())));
  return { st, port };
}
/** 원문 MIME 에서 첨부 하나를 꺼낸다(Content-Disposition: attachment 파트의 base64). */
function attachmentOf(raw) {
  const i = raw.search(/Content-Disposition: attachment; filename="([^"]+)"/);
  if (i < 0) return null;
  const name = /filename="([^"]+)"/.exec(raw.slice(i))[1];
  const rest = raw.slice(i).split('\n');
  const b64 = []; let started = false;
  for (const l of rest.slice(1)) {
    if (!started) { if (l.trim() === '') started = true; continue; }
    if (l.trim() === '' || l.startsWith('--')) break;
    b64.push(l.trim());
  }
  return { name, buf: Buffer.from(b64.join(''), 'base64') };
}
async function callM(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'root', role: 'admin', scope: {} }; next(); });
  app.use('/api', api);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, ct, cd: res.headers.get('content-disposition') || '', buf: Buffer.from(await res.arrayBuffer()) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

test('⑦ 메일 — 가짜 SMTP 왕복으로 첨부 엑셀을 다시 읽는다 · 상한 초과는 첨부 없이 밝힘 · 내려받기 라우트 · 동시 1건', async () => {
  const smtp = await rawSmtp();
  fs.writeFileSync(path.join(TMP, 'mail.json'), JSON.stringify({ enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['admin@corp.local'], kinds: {}, rateLimitPerHour: 0 }));
  MS.invalidate?.();
  const put = await callM('PUT', '/tools/storage-usage/mail', { mail: { enabled: true, days: [1], time: '08:00' } });
  assert.equal(put.status, 200, put.buf.toString());
  const sent = await callM('POST', '/tools/storage-usage/mail/send-now', {});
  assert.equal(sent.status, 200, sent.buf.toString());
  assert.equal(smtp.st.mails.length, 1);
  const raw = smtp.st.mails[0].data;
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet; name="storage-usage-weekly-\d{4}-W\d{2}\.xlsx"/);
  const att = attachmentOf(raw);
  assert.ok(att && att.buf.length > 1000, '첨부를 꺼냈다');
  const wb = await readXlsx(att.buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [...X.SHEETS]);
  const names = []; wb.getWorksheet('주간 사용량').getRow(5).eachCell((c) => names.push(String(c.value)));
  assert.ok(names.some((n) => n.startsWith('PS-A')), '④ 에서 넣은 장비가 엑셀 머리에 있다');
  assert.ok(!att.buf.toString('latin1').includes('10.30.0.5'), '메일 첨부는 비관리자 판본(관리 주소 없음)');
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'storage-usage-mail-state.json'), 'utf8'));
  assert.equal(st.history[0].attach, 'attached');

  // 상한을 넘으면 첨부 없이 — 본문이 밝힌다(조용히 빼지 않는다)
  const rep = repOf(SPECS);
  const a = await U.buildAttachment(rep, M.mailOf({}), { limit: 500 });
  assert.equal(a.state, 'failed'); assert.match(a.reason, /첨부 상한/); assert.equal(a.attachment, undefined);
  const body = M.renderUsageMail(M.buildMailModel(rep), { mail: { enabled: true }, attach: a });
  assert.match(body.html, /엑셀을 붙이지 못했습니다/); assert.match(body.text, /엑셀을 붙이지 못했습니다/);
  const off = M.renderUsageMail(M.buildMailModel(rep), { mail: { attachExcel: false } });
  assert.ok(!off.html.includes('첨부 엑셀'), '첨부를 끄면 안내도 없다');
  assert.match(off.html, /조치가 필요한 항목/); assert.match(off.html, /PowerScale\(아이실론\) 풀별 사용량/);
  // 좁은 폭(Chromium 확인 — 400px 에서 풀별 표가 카드 밖으로 잘렸다): 520px 이하 줄바꿈 허용 · 카드가 넘침을 숨기지 않음 ·
  //   word-break 로 숫자를 소수점에서 끊지 않음 · '(N주 뒤)' 는 한 덩어리
  assert.match(off.html, /@media only screen and \(max-width:520px\)\{[^<]*\.su-t td,\.su-t th\{[^}]*white-space:normal!important;overflow-wrap:break-word\}/);
  assert.ok(!/word-break:break-word/.test(off.html));
  assert.ok(!/max-width:720px[^"]*overflow:hidden/.test(off.html), '카드가 넘친 부분을 숨기지 않는다');
  assert.match(off.html, /<span style="white-space:nowrap">\(\d+주 뒤\)<\/span>/);

  // 내려받기 라우트 — 관리자 판본 · 동시 1건
  const x = await callM('GET', '/tools/storage-usage/xlsx');
  assert.equal(x.status, 200, x.buf.toString().slice(0, 300));
  assert.equal(x.ct, X.XLSX_MIME);
  assert.match(x.cd, /attachment; filename="storage-usage-weekly-\d{4}-W\d{2}\.xlsx"/);
  assert.deepEqual((await readXlsx(x.buf)).worksheets.map((w) => w.name), [...X.SHEETS]);
  const lock = EB.acquireExport('storage-usage-xlsx', { user: { username: 'someone' } });
  try {
    const busy = await callM('GET', '/tools/storage-usage/xlsx');
    assert.equal(busy.status, 409, '무거운 내보내기는 동시 1건');
  } finally { lock.release(); }
  // 게이트는 소스로 고정(인증을 끈 하네스라 역할 판정이 익명이다 — storageUsage2789 ⑤ 와 같은 이유)
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'api', 'storageUsage.js'), 'utf8');
  assert.match(src, /api\.get\('\/tools\/storage-usage\/xlsx', adminOnly, fullScopeOnly, csvPerm,/);
});
