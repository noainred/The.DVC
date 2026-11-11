/**
 * v2.977 반증 F3 — 30분 단위 포탈 시간대(+05:30)에서 월 누적 kWh 의 기대 시간이 덮은 시간보다 1 크게 나와 모든 서버가 '측정이 빈 시간 있음' 으로 세였다.
 *   달 시작이 정시가 아니면 경계 칸은 이전 날에 붙어 세지 않는다 — 기대 시간도 다음 정시부터 센다.
 *   오프셋은 모듈 로드 때 읽으므로(util/dayKey.js) 별도 파일에서 env 를 먼저 둔다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'power-offset-2977-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.PORTAL_TZ_OFFSET_MIN = '330';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * 60_000;
const A = await import('../src/bmusage/powerAgg.js');
const dbLike = (w) => ({ hourlyStats: (key, from, to) => { const out = []; for (let hb = Math.floor(from / HOUR); hb < Math.ceil(to / HOUR); hb += 1) out.push({ ts: hb * HOUR, avg: w, min: w, max: w }); return out; } });
const deps = { measured: async () => [{ serverId: 'r1', watts: 1000, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac' }], analysisServers: async () => [{ id: 'r1', serviceTag: 'T1' }],
  powerDb: async () => dbLike(1000), fanFaults: async () => [], inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 15 * 60_000 }, yielder: async () => {} };

test('+05:30 — 빈 시간 없는 데이터면 덮은 시간 = 기대 시간 · 부분 서버 0', async () => {
  A._resetPowerAggForTest();
  const [s] = await A.gatherPower({ targets: [{ key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] }], deps, now: NOW, withMonth: true });
  if (s.kwhMonthSpanH == null || s.kwhMonthSpanH < 1) return; // 달의 첫 시간 — 셀 칸이 없다
  assert.equal(s.kwhMonthHours, s.kwhMonthSpanH, `덮은 ${s.kwhMonthHours} · 기대 ${s.kwhMonthSpanH}`);
  assert.equal(A.aggregatePower([s]).fleet.monthPartial, 0);
});

/**
 * v2.978(CI 실패로 발견 — 이 파일의 위 테스트가 실제 시각에 따라 깨졌다): +05:30 에서 포탈 날이 바뀐 뒤 첫 30분(로컬 00:00~00:30)에는
 * 날 경계에 걸친 시간 칸(UTC 18:00~19:00)이 아직 끝나지 않았는데, 지난 날 읽기(끝 = 오늘 시작 18:30)가 그 칸을 어제 몫으로 셌다 → 덮은 시간이 기대보다 1 많다.
 * 고침: 지난 날 읽기도 끝난 정시 칸(h0 앞)만 · 마지막 칸이 아직 안 끝난 날은 캐시하지 않는다(캐시하면 칸이 끝난 뒤 그날이 1시간 모자라 '빈 시간' 으로 남는다).
 * 기준 시각은 실제 시각에서 이번 달 10일로 떨어뜨려 고정한다(달의 첫날 · 실제 시각에 따라 갈리지 않게 — docs/rules/common.md).
 */
test('+05:30 — 날이 바뀐 직후 30분(경계 칸 진행 중) · 칸이 끝난 뒤 · 한낮 모두 덮은 시간 = 기대 시간', async () => {
  const d = new Date();
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  for (const [label, t] of [['로컬 00:10', Date.UTC(y, m, 9, 18, 40)], ['로컬 00:40', Date.UTC(y, m, 9, 19, 10)], ['로컬 12:10', Date.UTC(y, m, 10, 6, 40)]]) {
    A._resetPowerAggForTest();
    const [s] = await A.gatherPower({ targets: [{ key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] }], deps, now: t, withMonth: true });
    assert.ok(s.kwhMonthSpanH > 200, `${label}: 기대 시간 ${s.kwhMonthSpanH}`);
    assert.equal(s.kwhMonthHours, s.kwhMonthSpanH, `${label}: 덮은 ${s.kwhMonthHours} · 기대 ${s.kwhMonthSpanH}`);
    assert.equal(s.kwhMonth, s.kwhMonthSpanH * 1000 / 1000, `${label}: 1kW × 기대 시간 = kWh`);
  }
  // 캐시: 00:10 에 계산한 어제를 담아 두면 00:40(경계 칸이 끝난 뒤)에 1시간 모자라 '빈 시간' 이 된다 — 같은 모듈 상태로 이어서 부른다
  A._resetPowerAggForTest();
  const tg = [{ key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] }];
  await A.gatherPower({ targets: tg, deps, now: Date.UTC(y, m, 9, 18, 40), withMonth: true });
  const [s2] = await A.gatherPower({ targets: tg, deps, now: Date.UTC(y, m, 9, 19, 10), withMonth: true });
  assert.equal(s2.kwhMonthHours, s2.kwhMonthSpanH, `캐시 뒤: 덮은 ${s2.kwhMonthHours} · 기대 ${s2.kwhMonthSpanH}`);
});
