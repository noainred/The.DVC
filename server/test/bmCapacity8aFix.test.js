/**
 * 리눅스 성능 8a단계 반증(F2 · F3 · F4 · F11 · 의심 항목 xfs 읽기) 회귀 — 용량 소진 예측.
 *   ① F2  이미 목표선 위인 자원이 평평 · 감소 · 출렁여도 ‘도달’(관문보다 먼저) — 알림 칸 참 · 함대 요약 · 봉투 축약에서 남는다
 *   ② F3  매일 반복 보정은 창 **합집합**의 날별 덮임 — 같은 일정을 창 1개 · 3개로 나눠도 같은 결과(실제 monthStore · 실제 저장소 창 · 실제 판정기)
 *   ③ F4  행 상한은 서버마다 공정하게(서버당 급한 마운트부터) — 뒤쪽 서버가 통째로 빠지지 않고, 빠진 서버 · 마운트 수를 결과 · 화면 문구가 밝힌다
 *   ④ F11 도달일은 마지막 관측일부터 센다 · 오래된 관측은 stale 표지(화면 ‘n일 전’)
 *   ⑤ 의심 — xfs 판별은 최신값 표의 두 열(key · tuning_json)만 조각으로 읽는다(SELECT * 동기 읽기 금지)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8acapfix-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AGENT_NAME = 'capnode';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const C = await import('../src/bmusage/capacity.js');
const DAY = 86_400_000;
const TODAY = '2026-11-08';
const T0 = Date.parse(`${TODAY}T00:00:00Z`);
const day = (i) => new Date(T0 - i * DAY).toISOString().slice(0, 10);
const series = (f, n = 30, skip = 0) => Array.from({ length: n }, (_, k) => ({ day: day(skip + n - 1 - k), v: f(n - 1 - k) }));

test('① F2 — 이미 목표선 위면 평평 · 감소 · 출렁여도 ‘도달’(알림 칸 참 · 요약 · 봉투 축약에서 남음)', async () => {
  const cases = {
    flat97: series(() => 97),
    declining96: series((i) => 95 + i * 0.05),
    noisy95: series((i) => 95 + ((i * 7) % 5) - 2),
    short93: series(() => 93, 3),   // 점이 3개뿐(데이터 부족 관문)이어도 지금 값이 목표 위면 도달
  };
  for (const [k, s] of Object.entries(cases)) {
    const f = C.forecastSeries(s, { today: TODAY });
    assert.equal(f.status, 'reached', k); assert.equal(f.daysToTarget, 0, k); assert.equal(f.dateToTarget, TODAY, `${k} — 마지막 관측일`);
    assert.equal(f.reason, undefined, `${k} — 도달 행에는 관문 사유를 달지 않는다`);
  }
  // 아래(85 · 평평)는 여전히 ‘증가 없음’ — 도달 판정이 목표 아래를 끌어올리지 않는다
  assert.equal(C.forecastSeries(series(() => 85), { today: TODAY }).status, 'no-growth');
  // 늘어나며 목표 위(기존 경로)는 100% 예측까지
  const up = C.forecastSeries(series((i) => 95 - i * 0.2), { today: TODAY });
  assert.equal(up.status, 'reached'); assert.ok(up.daysTo100 > 0 && up.conf, '추세가 쓸 만하면 100% 도달일도');
  const rows = Object.entries(cases).map(([k, s]) => ({ key: 'S1', vcenterId: 'vcA', kind: 'fs', res: `/${k}`, ...C.forecastSeries(s, { today: TODAY }) }));
  const PA = await import('../src/bmusage/perfAlerts.js');
  assert.equal(PA.ruleCondition('capacity', { capacity: { rows, days: 7 } }, { cond: 'fs-inode' }), true, '알림 칸 — 이미 도달 = 참');
  assert.equal(C.summarize(rows).reached, 1, '서버 1대(도달)');
  const EP = await import('../src/bmusage/edgePull.js');
  const env = { node: {}, targets: [], perf: [], capacity: { rows: [...rows, ...Array.from({ length: 4000 }, (_, i) => ({ key: `K${i}`, kind: 'fs', res: '/x'.repeat(40), status: 'insufficient' }))] } };
  const fit = EP.fitEnvelope(env, 200_000);
  assert.equal(fit.capacity.truncated, 'forecast-only');
  assert.equal(fit.capacity.rows.filter((r) => r.key === 'S1').length, 4, '도달 행은 봉투 축약에서 남는다');
});

test('② F3 — 매일 반복 보정은 합집합 날별 덮임: 같은 일정을 창 1개 · 3개로 나눠도 같은 결과(실제 monthStore · 저장소 · 판정기)', async () => {
  // 순수 — 하루 2시간 × 31일(일상) + 하루 8시간 더(일회 정비) → 그 날만 뺀다 · 창을 나눠도 합집합이 같으면 같다
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const from = now - 31 * DAY;
  const daily = Array.from({ length: 31 }, (_, b) => ({ from: now - b * DAY - 5 * 3_600_000, to: now - b * DAY - 3 * 3_600_000 }));
  const a = C.dayExclusion([...daily].sort((x, y) => x.from - y.from), from, now);
  assert.equal(a.excludedDays.size, 0); assert.equal(a.routineMin, 120);
  const { DAY_OFFSET_MIN } = await import('../src/util/dayKey.js');
  const off = DAY_OFFSET_MIN * 60_000; const d0 = Math.floor((now + off) / DAY) * DAY - off;   // 포탈 날 시작(날 경계를 넘지 않게)
  const big = { from: d0 - 10 * DAY + 12 * 3_600_000, to: d0 - 10 * DAY + 20 * 3_600_000 };
  const b = C.dayExclusion([...daily, big].sort((x, y) => x.from - y.from), from, now);
  assert.equal(b.excludedDays.size, 1, '일상보다 1시간 넘게 더 덮인 날만');
  const rare = C.dayExclusion([big], from, now);
  assert.equal(rare.excludedDays.size, 1); assert.equal(rare.routineMin, 0, '드문 정비는 덮인 날 전부');
  // 실제 경로(반증 r5 재현) — 마운트 일 롤업 31일 + 저장소 창 + 판정기 + computeServer
  const M = await import('../src/bmusage/monthStore.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const R = await import('../src/bmusage/maint/runtime.js');
  const rows = [];
  for (let d = 0; d < 31; d += 1) rows.push({ key: 'S1', ts: now - d * DAY, mount: '/data', used_pct: 80 - d * 0.5, inode_pct: 5, size_bytes: 1e12, used_bytes: 5e11 });
  await M.writeMountRows(rows, 'capnode');
  const target = { key: 'S1', name: 's1', vcenterId: 'vcA', paths: ['os'] };
  const base = { reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcA', tz: 'Asia/Seoul', scopes: { exclude: true } };
  const run = async () => { ST._resetMaintStoreForTest(); const J = await R.maintJudge({ now }); const r = await C.computeServer({ agent: 'capnode', target, now, judge: J }); const x = r.rows.find((y) => y.kind === 'fs'); return { status: x.status, n: x.n, excluded: x.excluded, dailyWin: x.dailyWin ?? null, daysToTarget: x.daysToTarget }; };
  const none = await run();
  const one = await ST.addWindow({ ...base, name: '매일 백업', schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '02:00', durMin: 120 } }, { by: 'o', now: now - 40 * DAY });
  const r1 = await run();
  await ST.deleteWindow(one.id, { by: 'o', rev: 1, now: now - 40 * DAY + 1 });   // 지운 시각이 기간 앞 — 묘비가 기간에 걸리지 않게
  for (const days of [[1, 2, 3], [4, 5, 6], [0]]) await ST.addWindow({ ...base, name: `백업 ${days}`, schedule: { kind: 'weekly', days, time: '02:00', durMin: 120 } }, { by: 'o', now: now - 40 * DAY });
  const r3 = await run();
  assert.equal(none.status, 'forecast');
  assert.deepEqual(r1, r3, '창 1개 = 창 3개(합집합 같음)');
  assert.equal(r3.status, 'forecast', '데이터 부족이 되지 않는다(반증 r5: 창 3개 → insufficient · 제외 31)');
  assert.equal(r3.excluded, 0); assert.equal(r3.dailyWin, 120);
  M._resetMonthStoreForTest();
});

test('③ F4 — 행 상한은 서버마다 공정하게(급한 마운트부터) · 빠진 서버 · 마운트 수를 밝힌다', async () => {
  // 순수 — 몫 5행: 메모리 1 + 마운트 2개(fs · inode) · 급한 순(도달 → 예측 이른 순 → 지금 값 높은 순)
  const mk = (res, status, extra = {}) => [{ kind: 'fs', res, status, ...extra }, { kind: 'inode', res, status: 'no-limit' }];
  const rows = [{ kind: 'mem', res: 'mem', status: 'forecast', daysToTarget: 50 }, ...mk('/a', 'no-growth', { current: 20 }), ...mk('/b', 'forecast', { daysToTarget: 9 }), ...mk('/c', 'reached'), ...mk('/d', 'forecast', { daysToTarget: 3 })];
  const fr = C.fairRows(rows, 5);
  assert.deepEqual(fr.rows.map((r) => `${r.kind}:${r.res}`), ['mem:mem', 'fs:/c', 'inode:/c', 'fs:/d', 'inode:/d']);
  assert.equal(fr.trimmedMounts, 2);
  assert.equal(C.fairRows(rows, 100).trimmedMounts, 0);
  // 실제 recomputeCapacity — 서버 40대 × 마운트 8개(서버당 17행) · 상한 200행 → 서버당 몫 5행: 40대 모두 행이 있다(예전: 앞 11대만)
  C._resetCapacityForTest();
  const now = Date.parse(`${TODAY}T03:00:00Z`);
  const fake = {
    readMountDaily: async () => ({ rows: Array.from({ length: 8 }, (_, m) => Array.from({ length: 20 }, (_, b) => ({ day: day(b), mount: `/m${m}`, used_pct_max: 60 + m - b * 0.5, inode_pct_max: 5 }))).flat() }),
    readDailyRange: async () => ({ live: Array.from({ length: 20 }, (_, b) => ({ day: day(b), mem_max: 40 })), mig: [] }),
  };
  const targets = Array.from({ length: 40 }, (_, i) => ({ key: `K${String(i).padStart(2, '0')}`, name: `bm-${i}`, vcenterId: 'vcA', paths: ['os'] }));
  const r = await C.recomputeCapacity({ targets, now, force: true, deps: { monthStore: fake, rules: { capacity: {} }, judge: { cover: () => [] }, rowsMax: 200 } });
  assert.equal(r.ok, true);
  const saved = C.loadCapacity();
  assert.equal(new Set(saved.rows.map((x) => x.key)).size, 40, '모든 서버에 행이 있다');
  assert.ok(saved.rows.length <= 200);
  assert.deepEqual({ servers: saved.cap.servers, skipped: saved.cap.skippedServers, trimmed: saved.cap.trimmedServers, mounts: saved.cap.trimmedMounts, share: saved.cap.perServerRows },
    { servers: 40, skipped: 0, trimmed: 40, mounts: 40 * 6, share: 5 });
  assert.equal(saved.truncated, true);
  // 몫이 최소(3행)보다 작아질 만큼 많으면 뒤쪽 서버는 계산하지 않고 그 수를 센다
  C._resetCapacityForTest();
  await C.recomputeCapacity({ targets, now, force: true, deps: { monthStore: fake, rules: { capacity: {} }, judge: { cover: () => [] }, rowsMax: 60 } });
  const s2 = C.loadCapacity();
  assert.equal(s2.cap.skippedServers, 20); assert.equal(new Set(s2.rows.map((x) => x.key)).size, 20);
  // 화면 문구 — 서버 수로(플래그 하나가 아니라)
  const W = await import('../../web/src/views/tools/bmCapacityText.js');
  assert.match(W.sourceText({ via: 'local', node: 'n1', day: TODAY, truncated: true, cap: s2.cap }), /계산 안 한 서버 20대/);
  // 엣지 봉투 → 중앙 정제도 내역(수만)을 나른다
  const SZ = await import('../src/central/bmMaintCapSanitize.js');
  const z = SZ.sanitizeCapacityEnvelope({ at: now, day: TODAY, rows: [], truncated: 'rows-cap', cap: { ...s2.cap, evil: 'x' } }, { targetKeys: new Set(), now });
  assert.deepEqual(Object.keys(z.cap).sort(), ['computed', 'perServerRows', 'servers', 'skippedServers', 'trimmedMounts', 'trimmedServers']);
});

test('④ F11 — 도달일은 마지막 관측일부터 · 오래된 관측은 stale(화면 ‘n일 전’)', async () => {
  // 마지막 관측 5일 전 85% · 하루 +1%p · 목표 90 → 그 관측일 + 5일 = 오늘(0일) — 예전: 오늘부터 5일 뒤
  const stale = series((i) => 85 - i, 20, 5);
  const f = C.forecastSeries(stale, { today: TODAY });
  assert.equal(f.status, 'forecast'); assert.equal(f.lastDay, day(5)); assert.equal(f.staleDays, 5); assert.equal(f.stale, true);
  assert.equal(f.dateToTarget, TODAY); assert.equal(f.daysToTarget, 0);
  // 어제까지 관측(정상) — stale 아님 · 오늘부터 세는 값과 같다
  const fresh = C.forecastSeries(series((i) => 85 - i, 20, 1), { today: TODAY });
  assert.equal(fresh.stale, undefined); assert.equal(fresh.staleDays, 1); assert.equal(fresh.daysToTarget, 4); assert.equal(fresh.dateToTarget, day(-4));
  const W = await import('../../web/src/views/tools/bmCapacityText.js');
  assert.equal(W.currentText({ current: 85, stale: true, staleDays: 5 }), '85% (5일 전)');
  assert.equal(W.currentText({ current: 85, staleDays: 1 }), '85%');
  assert.match(W.noteText({ ...f, kind: 'fs' }), /마지막 관측 .*5일 전/);
  // 중앙 정제 화이트리스트에 새 칸
  const SZ = await import('../src/central/bmMaintCapSanitize.js');
  const z = SZ.sanitizeCapacityEnvelope({ rows: [{ key: 'K1', kind: 'fs', res: '/', status: 'forecast', lastDay: f.lastDay, staleDays: '5', stale: true }] }, { targetKeys: new Set(['K1']) });
  assert.equal(z.rows[0].lastDay, f.lastDay); assert.equal(z.rows[0].staleDays, 5); assert.equal(z.rows[0].stale, true);
});

test('⑤ 의심 — xfs 판별은 두 열만 조각으로(SELECT * 동기 읽기 금지) · DB 가 비어도 계산은 돈다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const cap = stripComments(fs.readFileSync(new URL('../src/bmusage/capacity.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(cap, /latestUsage\(\{\s*json:\s*true/);
  assert.match(cap, /latestTuningRows\(/);
  const db = stripComments(fs.readFileSync(new URL('../src/bmusage/db.js', import.meta.url), 'utf8'));
  const fn = db.slice(db.indexOf('export async function latestTuningRows'), db.indexOf('export async function latestTuningRows') + 900);
  assert.match(fn, /SELECT key, tuning_json FROM usage_latest WHERE agent = \? AND key > \?/);
  assert.match(fn, /yieldFn\(\)/);
  const D = await import('../src/bmusage/db.js');
  assert.deepEqual(await D.latestTuningRows({ agent: 'capnode' }), []);
});
