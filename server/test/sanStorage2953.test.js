/**
 * test/sanStorage2953.test.js — v2.953 'SAN 스토리지 성능' 2차(설계 §12.2 후속 5건): 자기 기준선 · 알림 · 월간 보고서 · 공개 API · 용량 × 성능.
 *  ① storageBaseline(순수): 요일 × 시간 접기(창 안 제외 · 표본 수 · 평균 · 표준편차) · 비교(허용 폭 · 절대 하한 · 표본 부족은 null · 1시간 초과 칸은 전부 null) · 요약
 *  ② storagePerfNotifyStore: 설정 정규화 · 전이(첫 비교는 기준만 · unknown 은 올리지도 내리지도 않음 · collect 의 보고 끊김 · 회복 · 최소 수준) · 법인별 알림 묶음 · 파일 손상 보존
 *  ③ storagePerfReport(순수): 설정 정규화(1~28 · HH:MM · 이메일) · 월간 회차(직전 · 포탈 시각) · 틱 계획(none · send · missed down/late · rebase) · 모델 · HTML(자급형 · 판정표 · 기호) · 메일 조각
 *  ④ 실제 라우트(mock · 인증 끔): /array 의 baseline · growth 필드 · /notify GET/PUT/run-now(첫 실행은 기준만) · /report GET/PUT/preview(HTML)/send-now(메일 꺼짐 → skipped) · 현황 rows[].growth
 *  ⑤ 공개 API: /api/v1/san-storage/{arrays,check} — 선언 fields 와 응답 키가 같다 · san 분류 없는 키 403 · 범위 지정 키 403 needs-full-scope
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanstorage2953-'));
process.env.CONFIG_DIR = tmp;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000; const DAY = 24 * HOUR; const WEEK = 7 * DAY;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * MIN;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

let B; let NS; let R; let DK;
before(async () => {
  B = await import('../src/sanswitch/storageBaseline.js');
  NS = await import('../src/sanswitch/storagePerfNotifyStore.js');
  R = await import('../src/sanswitch/storagePerfReport.js');
  DK = await import('../src/util/dayKey.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① 자기 기준선 — 접기 · 비교 · 요약', () => {
  // 4주 × 1시간 — 월요일 09시(포탈 시각) 칸만 10e8, 나머지 1e8. 창(until 뒤)은 기준선에 넣지 않는다.
  const until = Math.floor(NOW / HOUR) * HOUR;
  const buckets = []; const values = [];
  for (let t = until - 4 * WEEK; t < until + 2 * HOUR; t += HOUR) { buckets.push(t); const c = B.cellOf(t); values.push(c.day === 0 && c.hour === 9 ? 10e8 : 1e8); }
  const fold = B.foldBaseline(buckets, values, { until, weeks: 4 });
  assert.equal(fold.measured, 4 * 168, '창(until 뒤 2칸)은 세지 않는다');
  const mon9 = fold.cells[9]; assert.equal(mon9.n, 4); assert.equal(mon9.mean, 10e8); assert.equal(mon9.sd, 0);
  assert.equal(fold.cells[10].mean, 1e8);
  // 비교 — 월 9시 칸에 1e8(평소의 0.1배 · 절대 차 9e8) → off · 화 10시 칸에 1.3e8(1.3배 · 허용 ±50% 안) → 아님 · 절대 하한 미만은 아님
  const idxMon9 = buckets.findIndex((t) => { const c = B.cellOf(t); return c.day === 0 && c.hour === 9; });
  const cmpB = [buckets[idxMon9], buckets[idxMon9 + 1]]; const cmpV = [1e8, 1.3e8];
  const cmp = B.compareToBaseline(cmpB, cmpV, fold, { bucketMs: HOUR, tolerance: 0.5 });
  assert.equal(cmp.applicable, true); assert.equal(cmp.compared, 2); assert.equal(cmp.offCount, 1);
  assert.equal(cmp.marks[0].off, true); assert.equal(cmp.marks[0].ratio, 0.1); assert.equal(cmp.marks[1].off, false); assert.equal(cmp.marks[1].ratio, 1.3);
  const small = B.compareToBaseline(cmpB, [9.9e8, 1e8], fold, { bucketMs: HOUR, tolerance: 0.5, minAbs: 62_500_000 });
  assert.equal(small.marks[0].off, false, '비율은 벗어나지 않고 절대 차도 하한 미만이 아니라… 0.99배는 폭 안'); assert.equal(small.marks[1].off, false);
  assert.equal(B.compareToBaseline(cmpB, cmpV, fold, { bucketMs: DAY }).applicable, false, '하루 칸은 요일 × 시간 비교가 뜻이 없다');
  assert.equal(B.compareToBaseline(cmpB, cmpV, null, { bucketMs: HOUR }).applicable, false);
  const few = B.foldBaseline(buckets.slice(0, 168), values.slice(0, 168), { until, weeks: 4 });   // 1주치 → 표본 1 → 비교 없음
  assert.equal(B.compareToBaseline(cmpB, cmpV, few, { bucketMs: HOUR }).compared, 0, '표본 3 미만 칸은 비교하지 않는다(모름 ≠ 평소)');
  const sm = B.baselineSummary(fold); assert.equal(sm.cells, 168); assert.deepEqual([sm.busiest.day, sm.busiest.hour, sm.busiest.mean], [0, 9, 10e8]);
  assert.deepEqual(B.baselineSummary(null), { cells: 0, busiest: null });
});

test('② 알림 저장소 — 설정 · 전이 · 묶음 · 손상 보존', () => {
  NS._resetNotifyForTest();
  assert.deepEqual(NS.normalizeNotifySettings({ enabled: 'true', minLevel: 'bad', recoveries: 'false', items: ['imbalance', 'fabric', 'imbalance'] }).settings,
    { enabled: true, minLevel: 'bad', recoveries: false, items: ['imbalance', 'fabric'] });
  assert.match(NS.normalizeNotifySettings({ minLevel: 'ok' }).issue, /minLevel/); assert.match(NS.normalizeNotifySettings({ items: ['bad key!'] }).issue, /items/);
  const r = NS.saveNotifySettings({ enabled: true }, { by: 'tester' }); assert.equal(r.settings.enabled, true); assert.equal(r.settings.updatedBy, 'tester');
  NS._resetNotifyForTest(); assert.equal(NS.loadNotifySettings().enabled, true, '파일에서 다시 읽힌다');
  // 전이
  const mk = (overall, items) => ({ key: 'K', datacenterId: 'dcA', datacenterName: '서울 법인', name: 'PMAX-1', overall, items: Object.fromEntries(Object.entries(items).map(([k, s]) => [k, { status: s, text: `${k} 문구` }])) });
  const s0 = NS.snapshotOf([mk('ok', { imbalance: 'ok', portSat: 'ok', collect: 'ok', dirBusy: 'unknown' })]);
  const first = NS.diffCheck({}, s0); assert.equal(first.first, true); assert.deepEqual([first.opened, first.recovered], [[], []], '첫 비교는 기준만');
  const s1 = NS.snapshotOf([mk('warn', { imbalance: 'warn', portSat: 'ok', collect: 'ok', dirBusy: 'warn' })]);
  const d1 = NS.diffCheck(s0, s1, { minLevel: 'warn' });
  assert.deepEqual(d1.opened.map((x) => [x.item, x.from, x.to]), [['imbalance', 'ok', 'warn'], ['dirBusy', 'unknown', 'warn']], 'unknown → warn 은 새 발견(열림)');
  assert.deepEqual(NS.diffCheck(s0, s1, { minLevel: 'bad' }).opened, [], '최소 수준 bad 면 warn 은 알리지 않는다');
  const s2 = NS.snapshotOf([mk('ok', { imbalance: 'ok', portSat: 'unknown', collect: 'unknown', dirBusy: 'unknown' })]);
  const d2 = NS.diffCheck(s1, s2);
  assert.deepEqual(d2.recovered.map((x) => x.item), ['imbalance'], 'warn → ok 회복');
  assert.deepEqual(d2.opened.map((x) => [x.item, x.kind]), [['collect', 'lost']], 'collect ok → unknown 은 보고 끊김 · 다른 항목의 → unknown 은 아무것도 아님');
  assert.deepEqual(NS.diffCheck(s1, s2, { recoveries: false }).recovered, []);
  const d3 = NS.diffCheck(s2, s0); assert.deepEqual(d3.recovered.map((x) => x.item), ['collect'], 'collect unknown → ok 는 회복');
  assert.deepEqual(NS.diffCheck(s0, s1, { items: ['portSat'] }).opened, [], '감시 항목 밖은 무시');
  const al = NS.alertsOf(d1, { labels: { imbalance: '디렉터 편중', dirBusy: '디렉터 busy' } });
  assert.equal(al.length, 1); assert.equal(al[0].key, 'san-storage:dcA'); assert.equal(al[0].severity, 'warning'); assert.match(al[0].title, /서울 법인: 주의 2/); assert.match(al[0].detail, /\[주의\] PMAX-1 · 디렉터 편중: ok → warn — imbalance 문구/);
  assert.equal(NS.alertsOf({ opened: [{ dc: 'd', dcName: 'D', item: 'portSat', from: 'warn', to: 'bad', name: 'X' }], recovered: [] })[0].severity, 'critical');
  assert.equal(NS.alertsOf({ opened: [], recovered: [{ dc: 'd', dcName: 'D', item: 'portSat', from: 'warn', to: 'ok', name: 'X' }] })[0].severity, 'info');
  // 손상 보존
  fs.writeFileSync(path.join(tmp, 'san-storage-notify.json'), '{bad');
  NS._resetNotifyForTest(); NS.loadNotifySettings();
  assert.ok(NS.notifyLoadError(), '손상이면 오류를 밝힌다'); assert.match(NS.saveNotifySettings({ enabled: false }).issue || '', /읽지 못해/);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('san-storage-notify.json.corrupt.')), '손상본 보존');
  fs.rmSync(path.join(tmp, 'san-storage-notify.json'), { force: true }); NS._resetNotifyForTest();
});

test('③ 월간 보고서(순수) — 설정 · 회차 · 틱 · 모델 · HTML · 메일 조각', () => {
  assert.deepEqual(R.normalizeReportSettings({ enabled: true, dayOfMonth: '5', time: '08:30', to: 'a@x.com, b@y.org a@x.com', topN: 5 }).settings, { enabled: true, dayOfMonth: 5, time: '08:30', to: ['a@x.com', 'b@y.org'], topN: 5 });
  assert.match(R.normalizeReportSettings({ dayOfMonth: 31 }).issue, /1~28/); assert.match(R.normalizeReportSettings({ time: '25:00' }).issue, /HH:MM/); assert.match(R.normalizeReportSettings({ to: ['nope'] }).issue, /이메일/);
  // 회차: 2026-11-09 10:00 KST 기준 — 매달 1일 09:00 → 2026-11-01 09:00 KST; 매달 15일이면 지난달 15일
  const now = Date.UTC(2026, 10, 9, 1, 0, 0);   // 10:00 KST
  const slot1 = R.monthlySlot({ dayOfMonth: 1, time: '09:00' }, now, 540); assert.equal(slot1, Date.UTC(2026, 10, 1, 0, 0, 0));
  const slot15 = R.monthlySlot({ dayOfMonth: 15, time: '09:00' }, now, 540); assert.equal(slot15, Date.UTC(2026, 9, 15, 0, 0, 0));
  assert.equal(R.monthLabelOf(slot1, 540), '2026-10', '1일 회차는 전달 보고서');
  const cfg = { enabled: true, dayOfMonth: 9, time: '09:50' };
  const slot = Date.UTC(2026, 10, 9, 0, 50, 0);
  assert.deepEqual(R.planMonthlyTick({ cfg, state: {}, now, bootAt: now - HOUR }), { action: 'send', slot }, '10분 전 회차 · 기동 뒤 → 보낸다');
  assert.deepEqual(R.planMonthlyTick({ cfg, state: { lastSlot: slot }, now, bootAt: 0 }), { action: 'none' }, '같은 회차는 두 번 보내지 않는다');
  assert.deepEqual(R.planMonthlyTick({ cfg, state: {}, now: now + HOUR, bootAt: 0 }), { action: 'missed', slot, reason: 'late' }, '30분 넘게 늦으면 놓침');
  assert.deepEqual(R.planMonthlyTick({ cfg, state: {}, now, bootAt: now + MIN }), { action: 'missed', slot, reason: 'down' }, '포탈이 꺼져 있던 회차');
  assert.equal(R.planMonthlyTick({ cfg: { ...cfg, enabled: false }, state: {}, now }).action, 'none');
  assert.equal(R.planMonthlyTick({ cfg, state: { lastSlot: now + DAY }, now }).action, 'rebase');
  // 모델 · HTML
  const list = { rows: [{ key: 'A', name: 'PMAX-A', datacenterId: 'd1', datacenterName: '서울', vendorLabel: 'PowerMax', avg24: 5e8, peak24: 9e8, utilPct: 12, delta7d: 4, now: { bps: 6e8 }, imbalance: { ratio: 1.6 }, state: 'ok' },
    { key: 'B', name: 'UN-B', datacenterId: 'd1', datacenterName: '서울', vendorLabel: 'Unity', avg24: null, peak24: null, utilPct: null, delta7d: null, now: null, imbalance: null, state: 'no-sample' }], total: { nowBps: 6e8 }, now: NOW };
  const check = { results: [
    { key: 'A', datacenterId: 'd1', datacenterName: '서울', name: 'PMAX-A', vendorLabel: 'PowerMax', overall: 'warn', uncheckedCount: 2, items: { imbalance: { status: 'warn', text: 'FA-1D 1.6×' }, fabric: { status: 'ok', text: '' }, dirBusy: { status: 'unknown', text: '값 없음' } }, arraySide: { keys: ['resp'] } },
    { key: 'B', datacenterId: 'd1', datacenterName: '서울', name: 'UN-B', vendorLabel: 'Unity', overall: 'unknown', uncheckedCount: 9, items: { imbalance: { status: 'unknown', text: '표본 없음' } }, arraySide: { keys: [] } }],
    summary: { arrays: 2, ok: 0, warn: 1, bad: 0, unknown: 1, na: 0, partiallyUnchecked: 0 }, settings: { items: [{ label: '회선 포화 — 주의', value: 70, unit: '%', source: 'MAPS', userSet: false }] }, items: [{ k: 'imbalance', label: '디렉터 편중', side: 'switch' }, { k: 'fabric', label: '팹 비대칭', side: 'switch' }, { k: 'dirBusy', label: '디렉터 busy', side: 'array' }] };
  const m = R.buildReportModel(list, check, { now: NOW, monthLabel: '2026-10', topN: 10 });
  assert.equal(m.results[0].key, 'A', '주의가 확인 불가보다 먼저'); assert.equal(m.top.length, 1, '24시간 평균이 있는 어레이만'); assert.equal(m.findings.length, 1); assert.deepEqual(m.arraySide, { withValues: 1, total: 2 });
  assert.deepEqual(m.byDc, [{ dc: '서울', arrays: 2, bad: 0, warn: 1, ok: 0, unknown: 1 }]);
  const html = R.renderReportHtml(m);
  assert.match(html, /^<!doctype html>/); assert.match(html, /2026-10 월간 성능 점검/); assert.match(html, /PMAX-A/); assert.match(html, /FA-1D 1\.6×/); assert.match(html, /▲/); assert.match(html, /확인 불가는 정상이 아니다/);
  assert.doesNotMatch(html, /<script/); assert.doesNotMatch(html, /src="http/); assert.match(html, /PDF 로 저장/);
  const parts = R.reportMailParts(m); assert.match(parts.subject, /2026-10 월간 점검 — 이상 0 · 주의 1 · 확인 불가 1/); assert.equal(parts.filename, 'san-storage-report_2026-10.html'); assert.match(parts.text, /PDF/);
});

test('④ 실제 라우트 — baseline · growth · 알림 · 보고서 · ⑤ 공개 API', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  NS._resetNotifyForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const publicApi = (await import('../src/routes/publicApi.js')).default;
  const keys = await import('../src/publicapi/keys.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { importSamples, invalidatePerfQueries } = await import('../src/sanswitch/perfDb.js');
  const swType = SAN_SWITCH_TYPES.find((x) => x.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'SW-ZA', host: '10.72.29.1', username: 'u', password: 'p', datacenterId: 'dcZ' });
  reg.saveDevice({ type: swType, name: 'SW-ZB', host: '10.72.29.2', username: 'u', password: 'p', datacenterId: 'dcZ' });
  const devA = reg.listDevices().find((d) => d.name === 'SW-ZA'); const devB = reg.listDevices().find((d) => d.name === 'SW-ZB');
  const now = Date.now();
  const nm = (dir, p) => `SYMMETRIX::000197952952::${dir} ${p}::FC::5978`;
  const meta = [
    { d: devA.id, p: 1, ts: now, name: nm('FA-1D', 4), wwn: '50:00:09:73:00:00:29:01', speed: '32G', type: 'F' }, { d: devB.id, p: 1, ts: now, name: nm('FA-1D', 5), wwn: '50:00:09:73:00:00:29:02', speed: '32G', type: 'F' },
    { d: devA.id, p: 2, ts: now, name: nm('FA-2D', 4), wwn: '50:00:09:73:00:00:29:03', speed: '32G', type: 'F' }, { d: devB.id, p: 2, ts: now, name: nm('FA-2D', 5), wwn: '50:00:09:73:00:00:29:04', speed: '32G', type: 'F' },
  ];
  // 5주 1시간 표본(기준선 4주 + 창) · 최근 1시간 1분 — 월요일 09시 칸은 3배(기준선이 그 칸을 '평소' 로 배운다)
  const rows = [];
  for (let k = 5 * 7 * 24; k >= 1; k--) { const ts = now - k * HOUR; const c = B.cellOf(ts); const mult = c.day === 0 && c.hour === 9 ? 3 : 1; for (const m of meta) rows.push({ d: m.d, ts, p: m.p, b: 100e6 * mult }); }
  for (let k = 60; k >= 0; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * MIN, p: m.p, b: 100e6 });
  await importSamples(rows, meta, 90);
  invalidatePerfQueries();
  const app = express(); app.use(express.json()); app.use('/api', api); app.use('/api/v1', publicApi);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p, h = {}) => { const r = await fetch(base + p, { headers: h }); const ct = r.headers.get('content-type') || ''; return { s: r.status, j: ct.includes('json') ? await r.json().catch(() => null) : null, text: ct.includes('json') ? '' : await r.text(), ct }; };
  const send = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { s: r.status, j: await r.json().catch(() => null) }; };
  try {
    const key = encodeURIComponent('SYMMETRIX::000197952952');
    const a = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcZ&hours=24`);
    assert.equal(a.s, 200, JSON.stringify(a.j).slice(0, 200));
    assert.equal(a.j.baseline.applicable, true, JSON.stringify(a.j.baseline).slice(0, 200)); assert.equal(a.j.baseline.weeks, 4); assert.equal(a.j.baseline.tolerancePct, 50);
    assert.equal(a.j.baseline.marks.length, a.j.buckets.length, '창의 칸마다 표시(또는 null)'); assert.ok(a.j.baseline.compared > 0, '기준선이 있는 칸이 비교됐다');
    assert.equal(a.j.baseline.offCount, 0, '창 값 = 평소 값이면 다른 칸이 없다');
    assert.ok(Object.hasOwn(a.j, 'growth'), 'growth 필드(짝 없으면 null)'); assert.equal(a.j.growth, null, '등록 스토리지 짝이 없으니 null(0 이 아니다)');
    // 기준선 끔(비움) → applicable false · reason disabled
    const S = await import('../src/sanswitch/storageCheckSettings.js');
    S.saveCheckSettings({ baselineTolerancePct: null }, { by: 't' });
    const a2 = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcZ&hours=24`);
    assert.deepEqual([a2.j.baseline.applicable, a2.j.baseline.reason], [false, 'disabled']);
    S.saveCheckSettings({ baselineTolerancePct: '' }, { by: 't' });   // 기본값으로
    const list = await get('/tools/san-storage?datacenterId=dcZ');
    assert.equal(list.s, 200); assert.ok(Object.hasOwn(list.j.rows[0], 'growth'), '현황 행에 growth(짝 없으면 null)');
    // 알림
    const n0 = await get('/tools/san-storage/notify'); assert.equal(n0.s, 200); assert.equal(n0.j.settings.enabled, false); assert.deepEqual(n0.j.minLevels, ['warn', 'bad']);
    const bad = await send('PUT', '/tools/san-storage/notify-settings', { minLevel: 'nope' }); assert.equal(bad.s, 400);
    const ok1 = await send('PUT', '/tools/san-storage/notify-settings', { enabled: true, minLevel: 'warn', recoveries: true }); assert.equal(ok1.s, 200); assert.equal(ok1.j.settings.enabled, true);
    const run1 = await send('POST', '/tools/san-storage/notify/run-now', {}); assert.equal(run1.s, 200); assert.equal(run1.j.action, 'baseline', JSON.stringify(run1.j).slice(0, 200)); assert.ok(run1.j.arrays >= 1);
    const run2 = await send('POST', '/tools/san-storage/notify/run-now', {}); assert.equal(run2.j.action, 'quiet', '바뀐 것이 없으면 보내지 않는다');
    const n1 = await get('/tools/san-storage/notify'); assert.ok(n1.j.arraysTracked >= 1); assert.equal(n1.j.status.lastTick.first, false);
    // 월간 보고서
    const r0 = await get('/tools/san-storage/report'); assert.equal(r0.s, 200); assert.equal(r0.j.settings.enabled, false); assert.equal(r0.j.nextSlot, null);
    const r1 = await send('PUT', '/tools/san-storage/report-settings', { enabled: true, dayOfMonth: 1, time: '09:00', to: 'ops@example.com' }); assert.equal(r1.s, 200); assert.deepEqual(r1.j.settings.to, ['ops@example.com']);
    assert.equal((await send('PUT', '/tools/san-storage/report-settings', { dayOfMonth: 30 })).s, 400);
    const pv = await get('/tools/san-storage/report/preview'); assert.equal(pv.s, 200); assert.match(pv.ct, /text\/html/); assert.match(pv.text, /월간 성능 점검/); assert.match(pv.text, /000197952952|SYMMETRIX/);
    const pj = await get('/tools/san-storage/report/preview?format=json'); assert.equal(pj.j.model.totals.arrays, 1);
    assert.ok(pj.j.model.thresholds.some((t) => t.value === 70 && /busy/.test(t.label)), '보고서 기준 표는 기본값(디렉터 busy 이상 70)을 값으로 적는다 — 전부 비움이 아니다'); assert.match(pv.text, /70%/); assert.match(pj.j.parts.filename, /^san-storage-report_\d{4}-\d{2}\.html$/);
    const sn = await send('POST', '/tools/san-storage/report/send-now', {}); assert.equal(sn.s, 409, '메일(SMTP)이 꺼진 환경 — 보내지 않았다고 말한다'); assert.ok(['skipped', 'failed'].includes(sn.j.state), JSON.stringify(sn.j));
    const r2 = await get('/tools/san-storage/report'); assert.equal(r2.j.history.length, 1); assert.equal(r2.j.history[0].kind, 'manual');
    // ⑤ 공개 API
    const { ENDPOINTS } = await import('../src/publicapi/allowlist.js');
    const kSan = keys.issueApiKey({ name: 'san', groups: ['san'] }).plaintext;
    const kNo = keys.issueApiKey({ name: 'inv', groups: ['inventory'] }).plaintext;
    const kScoped = keys.issueApiKey({ name: 'sc', groups: ['san'], vcenters: ['vc-ap-northeast'] }).plaintext;
    const H = (k) => ({ 'X-API-Key': k, Authorization: `Bearer ${k}` });
    for (const ep of ['/san-storage/arrays', '/san-storage/check']) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1${ep}?datacenterId=dcZ`, { headers: H(kSan) });
      const j = await r.json();
      assert.equal(r.status, 200, `${ep}: ${JSON.stringify(j).slice(0, 200)}`);
      assert.deepEqual(Object.keys(j).sort(), ['apiVersion', 'data', 'endpoint', 'generatedAt', 'meta', 'ok']);
      assert.ok(Array.isArray(j.data) && j.data.length >= 1, `${ep}: 데이터`);
      assert.deepEqual(Object.keys(j.data[0]).sort(), [...ENDPOINTS.find((e) => e.path === ep).fields].sort(), `${ep}: 선언 fields 와 같다`);
      const no = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1${ep}`, { headers: H(kNo) }); assert.equal(no.status, 403, 'san 분류 없는 키');
      const sc = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1${ep}`, { headers: H(kScoped) }); const sj = await sc.json();
      assert.equal(sc.status, 403); assert.equal(sj.code, 'needs-full-scope', '범위 지정 키는 빈 목록이 아니라 거절');
    }
    const arrays = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/san-storage/arrays?datacenterId=dcZ`, { headers: H(kSan) })).json();
    const row = arrays.data.find((x) => x.key === 'SYMMETRIX::000197952952');
    assert.equal(row.nowBps, 4e8); assert.equal(row.directors, 2); assert.equal(row.storageDeviceId, null); assert.equal(row.growth30dBytes, null); assert.equal(arrays.meta.unit, 'bytesPerSec');
    const chk = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/san-storage/check?datacenterId=dcZ`, { headers: H(kSan) })).json();
    assert.equal(chk.data[0].items.dirBusy, 'unknown'); assert.ok(chk.meta.summary.arrays >= 1); assert.equal(chk.meta.itemLabels.imbalance, '디렉터 편중');
  } finally { await new Promise((r) => srv.close(r)); }
});
