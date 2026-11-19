/**
 * v2.977 전체 점검(데이터 정합 · 보안 축) 회귀.
 *  ① 베어메탈 전력 월 누적 kWh — 오늘 몫도 끝난 정시 칸만(진행 중 칸을 1시간치로 더하지 않는다) · 덮은 시간 / 기대 시간을 싣고 빈 시간이 있는 서버를 센다.
 *  ② bmstor 디스크 I/O 합 — busyPct:null · totalBps:null 을 0 으로 세지 않는다(Number.isFinite(Number(null)) 함정).
 *  ③ SAN 매핑 재정의의 비관리자 판본 — 바꾼 사람(by)을 뺀다.
 *  기준 시각: 실제 시각을 정시로 떨어뜨린 뒤 −30분(정시가 아닌 시각 · common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'data-audit-2977-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const A = await import('../src/bmusage/powerAgg.js');

// idrac/db.js hourlyStats 와 같은 창 규칙(hb ∈ [floor(from/1h), ceil(to/1h)) · ts = hb × 1h). gap(hb) 이 참이면 그 시간은 측정 없음.
const dbLike = (w, gap = () => false) => ({ hourlyStats: (key, from, to) => {
  const out = [];
  for (let hb = Math.floor(from / HOUR); hb < Math.ceil(to / HOUR); hb += 1) if (!gap(hb)) out.push({ ts: hb * HOUR, avg: w, min: w, max: w });
  return out;
} });
const depsOf = (idb) => ({ measured: async () => [{ serverId: 'r1', watts: 1000, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac' }], analysisServers: async () => [{ id: 'r1', serviceTag: 'T1' }],
  powerDb: async () => idb, fanFaults: async () => [], inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 15 * 60_000 }, yielder: async () => {} });
const TARGET = { key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] };

test('① 월 누적 kWh = 끝난 정시 칸 수 × 1 kWh(1,000 W) — 진행 중 칸을 더하지 않는다 · 빈 시간 없음', async () => {
  A._resetPowerAggForTest();
  const [s] = await A.gatherPower({ targets: [TARGET], deps: depsOf(dbLike(1000)), now: NOW, withMonth: true });
  assert.ok(s.kwhMonthSpanH >= 1, `기대 시간 ${s.kwhMonthSpanH}`);
  assert.equal(s.kwhMonthHours, s.kwhMonthSpanH, '덮은 시간 = 기대 시간');
  assert.equal(s.kwhMonth, s.kwhMonthSpanH, `월 누적 ${s.kwhMonth} kWh = ${s.kwhMonthSpanH}시간 × 1 kWh(예전: 진행 중 칸 1시간치가 더해졌다)`);
  const agg = A.aggregatePower([s]);
  assert.equal(agg.fleet.monthPartial, 0);
});

test('① 측정이 빈 시간이 있으면 덮은 시간이 기대보다 적고, 집계가 그런 서버 수를 센다', async () => {
  A._resetPowerAggForTest();
  const h0 = Math.floor(NOW / HOUR);
  const [s] = await A.gatherPower({ targets: [TARGET], deps: depsOf(dbLike(1000, (hb) => hb === h0 - 1)), now: NOW, withMonth: true });
  if (s.kwhMonthSpanH < 2) return; // 달의 첫 1시간이면 빈 시간을 만들 자리가 없다
  assert.equal(s.kwhMonthHours, s.kwhMonthSpanH - 1);
  assert.equal(s.kwhMonth, s.kwhMonthSpanH - 1);
  assert.equal(A.aggregatePower([s]).fleet.monthPartial, 1, '빈 시간 있는 서버 1대');
});

test('② bmstor 합 — busyPct:null 은 최고 사용률 null(0 아님) · totalBps:null 은 측정으로 세지 않는다', async () => {
  const { aggregate } = await import('../src/bmstor/agg.js');
  const servers = [{ id: 'a', name: 'a', host: 'a' }, { id: 'b', name: 'b', host: 'b' }];
  const latest = new Map([['a', { ok: true, mounts: [], io: { readBps: 100, writeBps: 0, totalBps: 100, busyPct: null, disks: 1 } }], ['b', { ok: true, mounts: [], io: { readBps: null, writeBps: null, totalBps: null, busyPct: null, disks: 1 } }]]);
  const r = aggregate(servers, latest);
  assert.equal(r.total.io.busyMax, null, 'busyMax 는 null(예전: 0)');
  assert.equal(r.total.io.measured, 1, 'totalBps:null 서버는 측정이 아니다(예전: 측정 0 으로 셌다)');
  assert.equal(r.total.io.partial, true);
  const latest2 = new Map([['a', { ok: true, mounts: [], io: { readBps: 1, writeBps: 1, totalBps: 2, busyPct: 37, disks: 1 } }], ['b', { ok: true, mounts: [], io: { readBps: 1, writeBps: 1, totalBps: 2, busyPct: '', disks: 1 } }]]);
  assert.equal(aggregate(servers, latest2).total.io.busyMax, 37);
});

test('③ SAN 매핑 재정의 — 비관리자 판본은 by 를 뺀다 · 관리자 판본은 그대로', async () => {
  const { byView } = await import('../src/routes/api/sanStorage.js');
  const o = { kind: 'array', by: 'secret-admin', at: 1 };
  assert.deepEqual(byView(o, false), { kind: 'array', at: 1 });
  assert.equal(byView(o, true), o);
  assert.equal(byView(null, false), null);
  // 라우트가 byView 를 거친다(소스 대조 — 응답 전체는 SAN 표본 맥락이 필요하다)
  const src = fs.readFileSync(new URL('../src/routes/api/sanStorage.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("api.get('/tools/san-storage/mapping'"), src.indexOf("api.get('/tools/san-storage/mapping'") + 4000);
  assert.match(route, /byView\(b\.map\.kinds\[s\.key\]/);
  assert.match(route, /byView\(b\.map\.directors\[mk\]/);
  assert.match(route, /\.\.\.\(admin \? \{ updatedBy: b\.map\.updatedBy \} : \{\}\)/);
});
