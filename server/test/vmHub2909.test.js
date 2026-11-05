// v2.909 — 가상화 서버 허브(시안 docs/design/vm-screen 시안 1): VM 신호(조치 필요) · /vms signal·signals · 법인별 집계 /vms/by-vcenter.
//   판정 모듈은 `inventory/vmSignals.js`(신호) · `inventory/vmByVcenter.js`(법인별) · `inventory/vmTotals.js`(평균 한 벌).
//   실제 `api` 라우터를 express 에 마운트해 HTTP 로 본다(운영과 같은 queryNormalize 를 앞에 단다) + 순수 단위.
//   ① 신호 판정 표 — 과부하 경계 90(칸 18) · 꺼진 VM 제외 · 못 읽은 값은 과부하가 아니라 미수집 · Tools 집합 · 템플릿 제외 · 스냅샷은 vm-hygiene 판정 그대로
//   ② 신호 쿼리 형식 — 모르는 값·배열·객체 모양은 400 bad-facet(field signal) · 캐시보다 먼저
//   ③ /vms signals=1 — 개수는 KPI 집합 기준(선택과 무관) · 항목별 신호 · totals 는 signals 없는 요청과 같다
//   ④ /vms signal=<키> — items·total 은 그 신호만 · totals(KPI)는 그대로 · 페이지 순회 누락·중복 0 · 신호를 바꾸면 옛 커서 400
//   ⑤ 설정(스냅샷 기준 일수)을 바꾸면 같은 스냅샷에서도 다음 요청부터 새 판정(캐시 키에 설정 개정)
//   ⑥ /vms/by-vcenter — 법인 합 = 전체 · 평균은 구동 VM 의 평균(법인 평균의 평균 아님) · 모르는 법인은 null · 목록 밖 vCenter 의 VM 은 unlisted 줄
//   ⑦ 범위 계정 — 자기 vCenter 줄만(다른 법인 이름도 없다) · 요청 필터(vcenterId)로 넓힐 수 없다 · 캐시가 섞이지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmHub2909-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(CLAUDE.md: Date.now() 직접·고정 epoch 둘 다 깨진다).
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let atSeq = 0;
const nextAt = () => NOW + (atSeq++) * 60_000;

const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { api } = await import('../src/routes/api.js');
const sig = await import('../src/inventory/vmSignals.js');
const { vmByVcenter } = await import('../src/inventory/vmByVcenter.js');
const { saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
const { TOOLS_NEED_UPGRADE } = await import('../src/reports/compliance.js');

const HYG = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: ['keep-snap'], notify: { enabled: false, hour: 9 } };
const ctx = sig.signalContext(HYG, NOW);

/* ───────────── 픽스처(합성 — 운영 식별자 없음) ───────────── */
const CPU = [null, '', 10, 89.99, 90, 95, 100, 150, 50, 75];
const MEM = [20, 91, null, 40, 10, 89.9, 60, 90, '', 30];
const POWER = ['POWERED_ON', 'POWERED_ON', 'POWERED_OFF', 'POWERED_ON', 'POWERED_ON', 'SUSPENDED', 'POWERED_ON'];
const TOOLS = ['guestToolsCurrent', 'guestToolsNeedUpgrade', 'guestToolsTooOld', '', 'guestToolsUnmanaged', 'guestToolsBlacklisted', 'guestToolsNotInstalled'];

function mkVms(n, { vcs = 3 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const vc = `vc${(i % vcs) + 1}`;
    const snapN = i % 4 === 0 ? 1 + (i % 3) : 0;
    out.push({
      id: `${vc}:vm-${i}`, vcenterId: vc, name: i % 23 === 0 ? `keep-snap-${i}` : `vm-${i}`, host: `esx-${i % 5}`,
      powerState: POWER[i % POWER.length], cpuCount: (i % 4) + 1, memMB: 1024 * ((i % 3) + 1),
      cpuUsagePct: CPU[i % CPU.length], memUsagePct: MEM[(i * 7) % MEM.length],
      storageGB: 10 + (i % 9), uncommittedGB: i % 5,
      guestOS: i % 2 ? 'Linux A 9' : 'Win Server 2022', ipAddress: `10.0.${i % 200}.${i % 250}`,
      toolsVersionStatus: TOOLS[i % TOOLS.length], template: i % 31 === 0,
      snapshotCount: snapN,
      snapshotOldestTs: snapN ? (i % 8 === 0 ? null : NOW - ((i % 20) + 1) * DAY) : null,
      ...(i % 6 === 0 ? { gpu: { type: 'vgpu', count: 1 } } : {}),
    });
  }
  return out;
}
function mkSnap(vms, vcenters) {
  return {
    generatedAt: new Date(nextAt()).toISOString(), source: 'mock',
    vcenters: vcenters || [
      { id: 'vc1', name: 'VC-ONE', status: 'connected', location: { region: '아시아', city: 'A' } },
      { id: 'vc2', name: 'VC-TWO', status: 'connected', location: { region: '유럽', city: 'B' }, collectSource: 'site', receivedAt: NOW - 600_000 },
      { id: 'vc3', name: 'VC-THREE', status: 'connected', location: { region: '북미', city: 'C' } },
    ],
    hosts: [], datastores: [], alarms: [], networks: [], vms, rollups: {},
  };
}

let SNAP = mkSnap(mkVms(420));
const ADMIN = { username: 'adm', role: 'admin', scope: null };
const SCOPED = { username: 'sc', role: 'admin', scope: { vcenters: ['vc1'] } };

async function withServer(fn) {
  const orig = store.get;
  store.get = () => SNAP;
  const app = express();
  app.use(queryNormalizer());
  app.use(express.json());
  app.use((req, _res, next) => { req.user = req.get('x-test-user') === 'scoped' ? SCOPED : ADMIN; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { store.get = orig; srv.close(); }
}
async function get(base, pathAndQs, user = 'admin') {
  const r = await fetch(`${base}/api${pathAndQs}`, { headers: { 'x-test-user': user } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 본문 아님 */ }
  return { status: r.status, body };
}

saveVmHygieneSettings(HYG, 'test');

/* ───────────── ① 신호 판정 표 ───────────── */
test('① 신호 판정 — 과부하 경계 90 · 꺼진 VM 제외 · 못 읽은 값은 미수집 · Tools 집합 · 템플릿 제외 · 스냅샷은 vm-hygiene 판정', () => {
  const on = (cpu, mem, extra = {}) => sig.vmSignalsOf({ powerState: 'POWERED_ON', cpuUsagePct: cpu, memUsagePct: mem, ...extra }, ctx);
  assert.deepEqual(on(89.99, 10), []);
  assert.deepEqual(on(90, 10), ['overload']);
  assert.deepEqual(on(10, 90), ['overload']);
  assert.deepEqual(on(150, 10), ['overload'], '100 초과도 과부하(마지막 칸)');
  assert.deepEqual(on(null, 10), ['usageUnknown'], '못 읽은 값은 과부하가 아니다');
  assert.deepEqual(on('', 95), ['overload', 'usageUnknown'], '한쪽만 읽혀도 그 값으로 과부하, 다른 쪽은 미수집');
  assert.deepEqual(on(-3, 10), ['usageUnknown'], '음수는 못 읽음(usageBinOf 와 같다)');
  assert.deepEqual(sig.vmSignalsOf({ powerState: 'POWERED_OFF', cpuUsagePct: 99, memUsagePct: null }, ctx), [], '꺼진 VM 은 사용률 신호 없음');
  for (const t of TOOLS_NEED_UPGRADE) assert.deepEqual(sig.vmSignalsOf({ powerState: 'POWERED_OFF', toolsVersionStatus: t }, ctx), ['toolsOld'], t);
  for (const t of ['guestToolsCurrent', 'guestToolsUnmanaged', 'guestToolsNotInstalled', '', undefined]) {
    assert.deepEqual(sig.vmSignalsOf({ powerState: 'POWERED_OFF', toolsVersionStatus: t }, ctx), [], String(t));
  }
  assert.deepEqual(sig.vmSignalsOf({ template: true, toolsVersionStatus: 'guestToolsNeedUpgrade' }, ctx), [], '템플릿 제외');
  const snap = (days, extra = {}) => sig.vmSignalsOf({ powerState: 'POWERED_OFF', name: 'x', snapshotCount: 1, snapshotOldestTs: days == null ? null : NOW - days * DAY, ...extra }, ctx);
  assert.deepEqual(snap(6), []);
  assert.deepEqual(snap(7), ['snapOld'], '기준 일수 이상(vm-hygiene 과 같다 — >=)');
  assert.deepEqual(snap(null), [], '생성일을 모르면 판정하지 않는다');
  assert.deepEqual(snap(30, { name: 'keep-snap-a' }), [], '예외 목록은 스냅샷 판정에서 뺀다');
  assert.deepEqual(snap(30, { snapshotCount: 0 }), [], '스냅샷 0개');
  assert.deepEqual(sig.vmSignalsOf({ powerState: 'POWERED_OFF', snapshotCount: 1, snapshotOldestTs: NOW - 30 * DAY }, sig.signalContext(null, NOW)), [], '설정이 없으면 판정하지 않는다');
  assert.equal(sig.OVERLOAD_BIN, 18);
  const vms = mkVms(300);
  const c = sig.signalCounts(vms, ctx);
  const any = vms.filter((v) => sig.vmSignalsOf(v, ctx).length).length;
  assert.equal(c.any, any);
  for (const k of sig.SIGNAL_KEYS) assert.equal(c[k], vms.filter((v) => sig.vmSignalsOf(v, ctx).includes(k)).length, k);
  for (const k of sig.SIGNAL_KEYS) assert.ok(c[k] > 0, `픽스처에 ${k} 가 있어야 의미가 있다`);
});

test('② 신호 쿼리 형식 — 모르는 값·배열·객체 모양은 400 bad-facet(field signal) · 정상 값은 그대로', async () => {
  assert.deepEqual(sig.parseSignalQuery({ signal: 'overload' }), { ok: true, signal: 'overload', want: false });
  assert.deepEqual(sig.parseSignalQuery({ signals: '1' }), { ok: true, signal: null, want: true });
  assert.deepEqual(sig.parseSignalQuery({ signal: 'nope' }), { ok: false, field: 'signal' });
  assert.deepEqual(sig.parseSignalQuery({ signal: ['overload'] }), { ok: false, field: 'signal' });
  assert.deepEqual(sig.parseSignalQuery({ signal: 'snapOld' }, { rawQuery: 'signal=overload&signal=snapOld' }), { ok: false, field: 'signal' });
  await withServer(async (base) => {
    for (const qs of ['signal=bogus', 'signal=overload&signal=toolsOld', 'signal[x]=overload', 'signal=overload&paged=1&cursor=zzz']) {
      const r = await get(base, `/vms?${qs}`);
      if (qs.includes('cursor')) continue;   // 커서 판정은 ④ 에서
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.error, 'bad-facet', qs);
      assert.equal(r.body.field, 'signal', qs);
    }
  });
});

test('③ /vms signals=1 — 개수는 KPI 집합 기준 · 항목별 신호 · totals 는 signals 없는 요청과 같다', async () => {
  SNAP = mkSnap(mkVms(420));
  await withServer(async (base) => {
    const plain = await get(base, '/vms?limit=5000');
    const withS = await get(base, '/vms?limit=5000&signals=1');
    assert.equal(withS.status, 200);
    assert.deepEqual(withS.body.totals, plain.body.totals, 'KPI 는 신호 싣기와 무관');
    assert.equal(plain.body.signalCounts, undefined, 'signals 없으면 개수를 싣지 않는다(예전 응답 그대로)');
    assert.equal(plain.body.items[0].signals, undefined);
    const exp = { ...sig.signalCounts(SNAP.vms, ctx), snapAgeDays: HYG.snapAgeDays };
    assert.deepEqual(withS.body.signalCounts, exp);
    for (const v of withS.body.items) assert.deepEqual(v.signals, sig.vmSignalsOf(SNAP.vms.find((x) => x.id === v.id), ctx), v.id);
    assert.equal(SNAP.vms[0].signals, undefined, '스냅샷 원본 객체를 바꾸지 않는다');
    // 패널 선택이 있어도 개수는 KPI 집합 기준
    const sel = await get(base, '/vms?limit=5000&signals=1&cpuBin=18-19');
    assert.deepEqual(sel.body.signalCounts, exp);
    // GPU 선택은 KPI 집합을 바꾸므로 개수도 따른다(KPI 와 같은 집합)
    const gpu = await get(base, '/vms?limit=5000&signals=1&gpu=1');
    assert.deepEqual(gpu.body.signalCounts, { ...sig.signalCounts(SNAP.vms.filter((v) => v.gpu), ctx), snapAgeDays: HYG.snapAgeDays });
  });
});

test('④ /vms signal=<키> — items·total 은 그 신호만 · KPI 그대로 · 페이지 순회 누락·중복 0 · 신호를 바꾸면 옛 커서 400', async () => {
  SNAP = mkSnap(mkVms(420));
  await withServer(async (base) => {
    const plain = await get(base, '/vms?limit=5000');
    for (const k of sig.SIGNAL_KEYS) {
      const r = await get(base, `/vms?limit=5000&signal=${k}`);
      const exp = SNAP.vms.filter((v) => sig.vmSignalsOf(v, ctx).includes(k)).map((v) => v.id);
      assert.equal(r.status, 200, k);
      assert.equal(r.body.signal, k);
      assert.equal(r.body.total, exp.length, k);
      assert.deepEqual(r.body.items.map((v) => v.id), exp, `${k} — 입력 순서 그대로`);
      assert.deepEqual(r.body.totals, plain.body.totals, `${k} — KPI 는 신호 선택과 무관`);
    }
    // 페이지 순회(서버 정렬 CPU 내림차순) — 과부하만, 누락·중복 0
    const exp = new Set(SNAP.vms.filter((v) => sig.vmSignalsOf(v, ctx).includes('overload')).map((v) => v.id));
    const seen = [];
    let cursor = null; let guard = 0; let first = null;
    do {
      const r = await get(base, `/vms?paged=1&limit=7&sortBy=cpuUsagePct&order=desc&signal=overload${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      if (!first) first = r.body;
      for (const v of r.body.items) seen.push(v.id);
      cursor = r.body.nextCursor;
    } while (cursor && ++guard < 200);
    assert.equal(seen.length, new Set(seen).size, '중복 0');
    assert.deepEqual(new Set(seen), exp, '누락 0 · 유령 0');
    // 신호를 바꾸면 옛 커서는 다른 목록 — 400
    const r1 = await get(base, '/vms?paged=1&limit=7&sortBy=cpuUsagePct&order=desc&signal=overload');
    const r2 = await get(base, `/vms?paged=1&limit=7&sortBy=cpuUsagePct&order=desc&signal=toolsOld&cursor=${encodeURIComponent(r1.body.nextCursor)}`);
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'cursor-query-mismatch');
  });
});

test('⑤ 설정(스냅샷 기준 일수)을 바꾸면 같은 스냅샷에서도 다음 요청부터 새 판정', async () => {
  SNAP = mkSnap(mkVms(420));
  await withServer(async (base) => {
    const a = await get(base, '/vms?limit=5000&signals=1');
    const b0 = await get(base, '/vms/by-vcenter');
    saveVmHygieneSettings({ snapAgeDays: 15 }, 'test');
    try {
      const b = await get(base, '/vms?limit=5000&signals=1');
      const c15 = sig.signalCounts(SNAP.vms, sig.signalContext({ ...HYG, snapAgeDays: 15 }, NOW));
      assert.equal(b.body.signalCounts.snapAgeDays, 15);
      assert.equal(b.body.signalCounts.snapOld, c15.snapOld);
      assert.ok(b.body.signalCounts.snapOld < a.body.signalCounts.snapOld, '기준이 길어지면 줄어야 한다(픽스처 확인)');
      const b1 = await get(base, '/vms/by-vcenter');
      assert.equal(b1.body.snapAgeDays, 15);
      assert.equal(b1.body.totals.signals.snapOld, c15.snapOld);
      assert.notEqual(b1.body.totals.signals.snapOld, b0.body.totals.signals.snapOld);
    } finally {
      saveVmHygieneSettings({ snapAgeDays: HYG.snapAgeDays }, 'test');
      _resetVmHygieneSettings();
    }
  });
});

test('⑥ /vms/by-vcenter — 법인 합 = 전체 · 평균은 전체 구동 VM 의 평균 · 모르는 법인은 null · 목록 밖 vCenter 의 VM 은 unlisted 줄', async () => {
  const vms = mkVms(420, { vcs: 4 });   // vc4 는 vcenters 목록에 없다
  SNAP = mkSnap(vms, [
    { id: 'vc1', name: 'VC-ONE', status: 'connected', location: { region: '아시아' } },
    { id: 'vc2', name: 'VC-TWO', status: 'connected', location: { region: '유럽' }, collectSource: 'site', receivedAt: NOW - 600_000, stale: true },
    { id: 'vc3', name: 'VC-THREE', status: 'connected', location: { region: '북미' } },
    { id: 'vc9', name: 'VC-NINE', status: 'pending', location: { region: '아시아' } },
  ]);
  await withServer(async (base) => {
    const r = await get(base, '/vms/by-vcenter');
    assert.equal(r.status, 200);
    const { corps, totals } = r.body;
    const byId = Object.fromEntries(corps.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['vc1', 'vc2', 'vc3', 'vc4', 'vc9']);
    assert.equal(byId.vc9.vms, null, '첫 수집 중·VM 0 → 모름(0대 아님)');
    assert.equal(byId.vc9.avgCpuPct, null);
    assert.equal(byId.vc4.unlisted, true);
    assert.equal(byId.vc2.collect, 'site');
    assert.equal(byId.vc2.stale, true);
    assert.equal(totals.corpsUnknown, 1);
    assert.equal(totals.corpsStale, 1);
    const known = corps.filter((c) => c.vms != null);
    for (const k of ['vms', 'on', 'off', 'vcpu', 'gpu']) assert.equal(known.reduce((a, c) => a + c[k], 0), totals[k], k);
    for (const k of sig.SIGNAL_KEYS) assert.equal(known.reduce((a, c) => a + c.signals[k], 0), totals.signals[k], k);
    assert.equal(totals.vms, vms.length);
    // 평균 — 전체 구동 VM 중 값이 있는 것의 평균(소수 한 자리)
    const on = vms.filter((v) => v.powerState === 'POWERED_ON').map((v) => (v.cpuUsagePct === '' || v.cpuUsagePct == null ? null : Number(v.cpuUsagePct))).filter((x) => x != null && x >= 0);
    // numOrNull 은 음수를 그대로 둔다 — 픽스처에 음수가 없으므로 위 필터와 같다
    assert.equal(totals.avgCpuPct, Math.round((on.reduce((a, x) => a + x, 0) / on.length) * 10) / 10);
    // 요청 필터로 좁히면 VM 0 인 법인은 뺀다
    const n = await get(base, '/vms/by-vcenter?q=vm-1');
    assert.ok(n.body.corps.every((c) => c.vms > 0));
    const v1 = await get(base, '/vms/by-vcenter?vcenterId=vc1');
    assert.deepEqual(v1.body.corps.map((c) => c.id), ['vc1']);
    assert.equal(v1.body.totals.vms, vms.filter((v) => v.vcenterId === 'vc1').length);
  });
});

test('⑦ 범위 계정 — 자기 vCenter 줄만 · 다른 법인 이름 없음 · 요청 필터로 넓힐 수 없음 · 캐시가 섞이지 않음', async () => {
  SNAP = mkSnap(mkVms(420));
  await withServer(async (base) => {
    const all = await get(base, '/vms/by-vcenter');            // 무제한 계정이 먼저 캐시를 채운다
    const sc = await get(base, '/vms/by-vcenter', 'scoped');
    assert.deepEqual(sc.body.corps.map((c) => c.id), ['vc1']);
    const text = JSON.stringify(sc.body);
    assert.ok(!text.includes('VC-TWO') && !text.includes('VC-THREE'), '범위 밖 법인 이름이 실리면 안 된다');
    assert.equal(sc.body.totals.vms, SNAP.vms.filter((v) => v.vcenterId === 'vc1').length);
    assert.ok(all.body.totals.vms > sc.body.totals.vms);
    const wide = await get(base, '/vms/by-vcenter?vcenterId=vc2', 'scoped');
    assert.deepEqual(wide.body.corps, [], '요청 필터로 범위 밖을 열 수 없다');
    assert.equal(wide.body.totals.vms, 0);
    // /vms 의 신호 개수·목록도 범위를 따른다
    const s1 = await get(base, '/vms?limit=5000&signals=1&signal=overload', 'scoped');
    assert.ok(s1.body.items.every((v) => v.vcenterId === 'vc1'));
    assert.deepEqual(s1.body.signalCounts, { ...sig.signalCounts(SNAP.vms.filter((v) => v.vcenterId === 'vc1'), ctx), snapAgeDays: HYG.snapAgeDays });
  });
});

test('⑧ 순수 vmByVcenter — 빈 입력 · 객체 아닌 항목은 건너뛴다', () => {
  const r = vmByVcenter({ vcenters: [null, { id: 'a', name: 'A', status: 'connected' }], vms: [null, 3, { id: 'a:1', vcenterId: 'a', powerState: 'POWERED_ON', cpuUsagePct: 50, memUsagePct: 50, cpuCount: 2, memMB: 2048 }], ctx });
  assert.equal(r.corps.length, 1);
  assert.equal(r.corps[0].vms, 1);
  assert.equal(r.corps[0].avgCpuPct, 50);
  assert.equal(r.totals.ramGB, 2);
  const e = vmByVcenter({ ctx });
  assert.deepEqual(e.corps, []);
  assert.equal(e.totals.vms, 0);
  assert.equal(e.totals.avgCpuPct, null, '대상이 없으면 평균은 null(0% 아님)');
});
