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
