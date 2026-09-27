// v2.631 감사 그룹 a — AX2-01~06 · WEB2631-01·02(서버)·05(서버) · R2631-03 회귀.
//   ① /summary 스토리지: 사용량 미상 DS 는 용량·사용 양쪽에서 빼고 개수(usageUnknown) — 롤업과 같은 기준
//   ② /tools/waste 과할당: 사용률 없는 VM 은 합산·후보에서 빼고 개수(usageUnknown)
//   ③ /vms 범위 필터: null 사용률은 Max 조건을 통과하지 않는다
//   ④ /tools/threats: IDS 합계는 자르기 전 전량 · 심각도 우선 · 잘림 개수
//   ⑤ vCenter 로그 CSV 페이지 순회: 청크 사이 새 행이 끼어도 중복 없음 · '잘림' 은 실제로 더 있을 때만
//   ⑥ /tools/licenses: 같은 키를 여러 vCenter 가 보고하면 한 번만 센다
//   ⑦ /alarms: 최신순(시각 내림차순)
//   ⑧ /top: 값 없는 항목·끊긴 호스트는 순위에서 빼고 omitted 로 밝힌다
//   ⑨ diskTrend: 회수 가능 기울기는 새 정의 점만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2631a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

// 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md — Date.now() 금지)
const NOW = Date.UTC(2026, 8, 20, 3, 30, 0);
const H = 3_600_000;

const { store } = await import('../src/store.js');
const { nsxStore } = await import('../src/nsx/store.js');
const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');

const SNAP = {
  generatedAt: new Date(NOW).toISOString(),
  vcenters: [
    { id: 'vc1', name: 'vc1', status: 'connected', licenses: [
      { name: 'vSphere 8 Ent', key: 'ABCDE-…-VWXYZ', total: 32, used: 20 },
      { name: 'Eval', key: '00000-…-00000', total: 0, used: 0 },
    ] },
    { id: 'vc2', name: 'vc2', status: 'connected', licenses: [
      { name: 'vSphere 8 Ent', key: 'ABCDE-…-VWXYZ', total: 32, used: 20 },
      { name: 'Eval', key: '00000-…-00000', total: 0, used: 0 },
    ] },
  ],
  hosts: [
    { id: 'h1', vcenterId: 'vc1', name: 'esx1', cluster: 'c', connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 20000, cpuUsageMhz: 10000, memTotalMB: 100000, memUsageMB: 50000, cpuUsagePct: 50, memUsagePct: 50, vmCount: 3 },
    { id: 'h2', vcenterId: 'vc1', name: 'esx2', cluster: 'c', connectionState: 'DISCONNECTED', cpuCores: 10, cpuTotalMhz: 20000, cpuUsageMhz: 0, memTotalMB: 100000, memUsageMB: 0, cpuUsagePct: 0, memUsagePct: 0, vmCount: 0 },
    { id: 'h3', vcenterId: 'vc1', name: 'esx3', cluster: 'c', connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 20000, cpuUsageMhz: 2000, memTotalMB: 100000, memUsageMB: 1000, cpuUsagePct: null, memUsagePct: null, vmCount: 1 },
  ],
  datastores: [
    { id: 'd1', vcenterId: 'vc1', name: 'ds-a', capacityGB: 1000, usedGB: 800, freeGB: 200, usagePct: 80 },
    { id: 'd2', vcenterId: 'vc1', name: 'ds-b', capacityGB: 1000, usedGB: null, freeGB: null, usagePct: null },
    { id: 'd3', vcenterId: 'vc1', name: 'ds-c', capacityGB: 1000, usedGB: null, freeGB: 100, usagePct: 90 },
  ],
  alarms: [
    { id: 'a1', vcenterId: 'vc1', entity: 'e1', message: 'old', severity: 'critical', time: new Date(NOW - 5 * H).toISOString() },
    { id: 'a2', vcenterId: 'vc1', entity: 'e2', message: 'newest', severity: 'warning', time: new Date(NOW - 1 * H).toISOString() },
    { id: 'a3', vcenterId: 'vc2', entity: 'e3', message: 'no-time', severity: 'critical' },
    { id: 'a4', vcenterId: 'vc2', entity: 'e4', message: 'mid', severity: 'warning', time: new Date(NOW - 3 * H).toISOString() },
    { id: 'a5', vcenterId: 'vc2', entity: 'e5', message: 'tie-crit', severity: 'critical', time: new Date(NOW - 3 * H).toISOString() },
  ],
  networks: [],
  vms: [
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'busy', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 4, cpuUsagePct: 80, memUsagePct: 90, memMB: 16384, storageGB: 10 },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'rest-unknown', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 4, cpuUsagePct: null, memUsagePct: null, memMB: 65536, storageGB: 20 },
    { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'nofield', host: 'esx1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 2048, storageGB: 5 },
  ],
  rollups: {},
};

async function withServer(fn) {
  const orig = store.get;
  const origNsx = nsxStore.get;
  store.get = () => SNAP;
  const ids = Array.from({ length: 600 }, (_, i) => ({ id: `ev${i}`, severity: i >= 550 ? 'critical' : 'low', signature: `s${i}` }));
  nsxStore.get = () => ({ managers: [], idsEvents: ids });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { store.get = orig; nsxStore.get = origNsx; srv.close(); }
}

test('① AX2-01·WEB2631-01 /summary 스토리지는 사용량을 읽은 DS 만(롤업 기준) + 미상 개수', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/summary`)).json();
    // 읽은 DS = d1(1000/800) + d3(1000/ 1000-100=900) → 2000 / 1700 → 85%
    assert.equal(j.storage.usagePct, 85, `사용률 ${j.storage.usagePct} — 미상 DS 를 사용 0 으로 더하면 57% 다`);
    assert.equal(j.storage.capacityTB, Number((2000 / 1024).toFixed(1)));
    assert.equal(j.storage.freeTB, Number((300 / 1024).toFixed(1)));
    assert.equal(j.storage.usageUnknown, 1);
    assert.equal(j.storage.capacityTBAll, Number((3000 / 1024).toFixed(1)));
    const vc1 = j.byVcenter.find((v) => v.id === 'vc1');
    assert.equal(vc1.storageTotalTB, Number((2000 / 1024).toFixed(1)), 'vCenter 카드(롤업)와 같은 기준');
    assert.equal(vc1.datastoresUsageUnknown, 1);
  });
});

test('② AX2-02 /tools/waste 과할당: 사용률 없는 VM 은 합산·후보에서 빼고 개수', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/tools/waste`)).json();
    const oa = j.overAllocated;
    assert.deepEqual(oa.usageUnknown, { cpu: 2, mem: 2 });
    assert.equal(oa.mem.allocGB, 16, '읽은 VM(16GB)만');
    assert.equal(oa.mem.usedPct, 90);
    assert.equal(oa.mem.candidates, 0, '사용률 미상 VM 이 메모리 과할당 후보가 되면 안 된다');
    assert.ok(!(oa.memTop || []).some((x) => x.name === 'rest-unknown'));
    assert.ok(!(oa.cpuTop || []).some((x) => x.name === 'rest-unknown' || x.name === 'nofield'));
  });
});

test('③ AX2-03 /vms Max 필터: null 사용률 VM 은 통과하지 않는다', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/vms?cpuUsageMax=5&memUsageMax=5`)).json();
    assert.deepEqual(j.items.map((v) => v.name), [], 'null 은 0% 가 아니다');
    const k = await (await fetch(`${base}/api/vms?cpuUsageMax=95`)).json();
    assert.deepEqual(k.items.map((v) => v.name), ['busy']);
  });
});

test('④ AX2-04 /tools/threats: IDS 합계는 전량 · 심각도 우선 · 잘림 밝힘', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/tools/threats`)).json();
    assert.equal(j.summary.idsEvents, 600);
    assert.equal(j.summary.idsCritical, 50, '뒤쪽 critical 50건이 잘려 사라지면 안 된다');
    assert.equal(j.ids.events.length, 500);
    assert.ok(j.ids.events.slice(0, 50).every((e) => e.severity === 'critical'), '심각도 우선으로 잘라야 한다');
    assert.equal(j.ids.omitted, 100);
    assert.equal(j.omitted.idsEvents, 100);
  });
});

test('⑤ AX2-05 로그 CSV 페이지 순회: 중간 삽입에도 중복 없음 · 잘림은 실제로 더 있을 때만', async () => {
  const { exportLogPages } = await import('../src/routes/api/checksLogs.js');
  // logs/db.js sqlite 와 같은 의미: until 포함 · ORDER BY ts DESC, rowid DESC · LIMIT/OFFSET
  const mk = (n) => {
    let rid = 0;
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ rowid: ++rid, ts: NOW - i * 1000 - (i % 3 === 0 ? 0 : 0), vcenterId: 'vc1', message: `m${i}` });
    // 동률 ts 묶음도 넣는다
    for (let i = 0; i < 4; i++) rows.push({ rowid: ++rid, ts: NOW - 5000, vcenterId: 'vc1', message: `tie${i}` });
    return {
      rows,
      insert(r) { rows.push({ ...r, rowid: ++rid }); },
      query(f, limit, offset) {
        return rows.filter((r) => (!f.until || r.ts <= f.until))
          .sort((a, b) => b.ts - a.ts || b.rowid - a.rowid).slice(offset, offset + limit);
      },
    };
  };
  const db = mk(20);
  const seen = [];
  let calls = 0;
  const r = await exportLogPages(db, { until: 0 }, {
    max: 1000, chunk: 5,
    onRows: async (rows) => { calls++; seen.push(...rows.map((x) => x.rowid)); db.insert({ ts: NOW + calls * 10, vcenterId: 'vc1', message: 'new' }); return true; },
  });
  assert.equal(new Set(seen).size, seen.length, `중복 행이 나갔다: ${seen.length - new Set(seen).size}건`);
  assert.equal(r.emitted, 24 + 1, '원래 24행 + 첫 청크 전에 들어온 새 행은 없고, 첫 청크 뒤 삽입분은 커서보다 새라 제외 — 첫 조회분 1행만 포함');
  assert.equal(r.truncated, false);

  const exact = mk(6);   // 10행
  const r2 = await exportLogPages(exact, {}, { max: 10, chunk: 5, onRows: async () => true });
  assert.equal(r2.emitted, 10);
  assert.equal(r2.truncated, false, '정확히 상한이면 잘린 것이 아니다');
  const over = mk(7);    // 11행
  const r3 = await exportLogPages(over, {}, { max: 10, chunk: 5, onRows: async () => true });
  assert.equal(r3.truncated, true);
});

test('⑥ AX2-06 /tools/licenses: 같은 키는 한 번만 · 평가판 키는 예전대로', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/tools/licenses`)).json();
    const ent = j.byLicense.find((l) => l.name === 'vSphere 8 Ent');
    assert.equal(ent.total, 32, '두 vCenter 가 같은 키를 보고해도 total 은 한 번');
    assert.equal(ent.used, 20);
    assert.equal(ent.count, 2);
    assert.equal(ent.duplicates, 1);
    assert.equal(j.duplicateKeys, 1);
    assert.equal(j.totalAssigned, 20);
    assert.equal(j.items.length, 4, '원본 항목은 그대로');
  });
});

test('⑦ WEB2631-02 /alarms 는 최신순 · 동률은 심각도 · 시각 없음은 뒤', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/alarms`)).json();
    assert.deepEqual(j.items.map((a) => a.message), ['newest', 'tie-crit', 'mid', 'old', 'no-time']);
  });
  const { alarmTimeMs } = await import('../src/routes/api/inventory.js');
  assert.equal(alarmTimeMs('12345'), 12345, '숫자 문자열은 Date.parse 에 넘기지 않는다');
  assert.equal(alarmTimeMs(''), null);
  assert.equal(alarmTimeMs(null), null);
});

test('⑧ WEB2631-05 /top: 값 없는 항목·끊긴 호스트는 순위에서 빼고 개수', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/top?limit=10`)).json();
    assert.deepEqual(j.vmsByCpuUsage.map((v) => v.name), ['busy']);
    assert.equal(j.omitted.vmsByCpuUsage, 2);
    assert.deepEqual(j.hostsByCpu.map((h) => h.name), ['esx1'], '끊긴 esx2(0%)·값 없는 esx3 제외');
    assert.equal(j.omitted.hostsByCpu, 2);
    assert.deepEqual(j.datastoresByUsage.map((d) => d.name), ['ds-c', 'ds-a']);
    assert.equal(j.omitted.datastoresByUsage, 1);
    assert.equal(j.vmsByRam.length, 3, '값이 다 있는 목록은 그대로');
    assert.equal(j.omitted.vmsByRam, undefined);
  });
});

test('⑨ R2631-03 회수 가능 기울기는 새 정의 점만 — 옛 정의 점이 섞이면 거짓 감소가 없어야 한다', async () => {
  const { analyzeDiskTrend } = await import('../src/tools/diskTrend.js');
  const D = 86_400_000;
  const T0 = NOW - 20 * D;
  const pts = [];
  // 옛 정의 10일(1000GB 일정) → 새 정의 10일(600GB 일정): 섞으면 음의 기울기
  for (let i = 0; i < 10; i++) pts.push({ ts: T0 + i * D, dsUsedGB: 100, provGB: 100, reclaimGB: 1000, reclaimLegacy: true });
  for (let i = 10; i < 20; i++) pts.push({ ts: T0 + i * D, dsUsedGB: 100, provGB: 100, reclaimGB: 600 });
  const a = analyzeDiskTrend({ points: pts, now: NOW, policy: { minPoints: 3, minSpanDays: 2 } });
  assert.equal(a.growth.reclaimGBperDay, 0, `새 정의 점만이면 0 — ${a.growth.reclaimGBperDay}`);
  assert.equal(a.growth.reclaimLegacyExcluded, 10);

  const few = [...pts.slice(0, 10), { ts: T0 + 10 * D, dsUsedGB: 100, provGB: 100, reclaimGB: 600 }];
  const b = analyzeDiskTrend({ points: few, now: NOW, policy: { minPoints: 3, minSpanDays: 2 } });
  assert.equal(b.growth.reclaimGBperDay, null, '새 정의 점이 모자라면 null');
  assert.match(b.growth.reclaimReason, /옛 정의 표본 10점/);
});
