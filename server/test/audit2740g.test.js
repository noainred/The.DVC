// v2.740 점검 그룹 g — 서버 2건(축 F 재확인분).
//  F-02 스토리지 증가량 합계의 증가율 분모 — 서버 totalsOf 와 웹 aggregateGrowth 가 같은 `usedMeasured`(그 기간 합계에 더한 장비의
//       지금 사용량 합)를 낸다. 웹 화면의 합계·그룹 증가율 분모가 이것이다(전 장비 사용량을 쓰면 증가율이 과소였다).
//  F-06 /tools/ipam·/sheet·엑셀·CSV — 입력 지문 생략(v2.619)으로 store 가 원장을 다시 만들지 않은 새 세대의 첫 요청이 원장을 **동기로**
//       다시 만들어 이벤트 루프를 멈췄다(합성 VM 4만 실측: 검색 1건 260~400ms · 시트 250~500ms). 이제 라우트는 양보판으로 만들고
//       (결과는 같다 — 같은 생성기·같은 세대 키) 같은 키의 진행 중 계산은 공유한다.
//  ⚠ CONFIG_DIR 은 import 전에 고정한다(config.js 가 import 시점에 굳는다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740g-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');

let st, led, ov, srv, baseUrl; let slimOwnerRow;
before(async () => {
  st = await import('../src/store.js');
  led = await import('../src/ipam/ledger.js');
  ov = await import('../src/ipam/overrides.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ slimOwnerRow } = await import('../src/routes/api/ipamExport.js')); // v2.744(리드 후속 RY): 시트 응답 다이어트 기준
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  baseUrl = `http://127.0.0.1:${srv.address().port}/api`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

/* ── F-02 ─────────────────────────────────────────────────────────────── */
const TB = 1e12;
const AS_OF = 20000; // 고정 일 인덱스(Date.now() 를 기준으로 쓰지 않는다 — v2.517 규약)
const row = (id, day, used, total = 2000 * TB) => ({ device_id: id, day, total_bytes: total, used_bytes: used, last_ts: day * 86_400_000 + 43_200_000, samples: 4 });

test('F-02 ① 재현 — 기준선 없는 대형 장비가 섞여도 usedMeasured 는 증가량을 더한 장비의 사용량뿐이다(서버 totalsOf)', async () => {
  const srvG = await import('../src/storage/growth.js');
  const rows = [];
  for (let d = AS_OF - 40; d <= AS_OF; d++) rows.push(row('A', d, (100 - 10 + (10 * (d - (AS_OF - 30))) / 30) * TB));
  for (let d = AS_OF - 3; d <= AS_OF; d++) rows.push(row('B', d, 900 * TB));   // 새로 등록 — 30일 기준선 없음
  const { periods } = srvG.normalizePeriods([30]);
  const m = srvG.growthMatrix(rows, { periods, asOfDay: AS_OF });
  const g = m.totals.growth['30d'];
  assert.equal(g.measured, 1); assert.equal(g.missing, 1); assert.equal(g.partial, true);
  const A = m.devices.find((d) => d.deviceId === 'A');
  assert.ok(Math.abs(g.usedMeasured - A.usedBytes) < 1, `usedMeasured ${g.usedMeasured} · A ${A.usedBytes}`);
  assert.ok(m.totals.usedBytes > g.usedMeasured * 5, '전 장비 사용량은 측정 장비 사용량보다 훨씬 크다(재현 전제)');
  const web = await import(path.join(WEB, 'views/tools/storageGrowthText.js'));
  const pct = web.aggregateGrowthPct(g);
  assert.ok(Math.abs(pct - web.growthPct(A.growth['30d'], A.usedBytes)) < 1e-9, `합계 증가율 ${pct} = A 의 증가율`);
  assert.ok(pct > 10, `측정 장비 기준 약 +11% 여야 한다(예전 분모면 약 +1%) — ${pct}`);
});

test('F-02 ② 서버 totalsOf 와 웹 aggregateGrowth 의 usedMeasured 가 같은 입력에 같다(공백·lagging·inexact·사용량 결측 함대)', async () => {
  const srvG = await import('../src/storage/growth.js');
  const web = await import(path.join(WEB, 'views/tools/storageGrowthText.js'));
  let s = 11;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let sawNull = 0; let sawPartial = 0; let compared = 0;
  for (let k = 0; k < 6; k++) {
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const id = `d${k}-${i}`;
      const latest = AS_OF - (rnd() < 0.15 ? 1 + Math.floor(rnd() * 12) : 0);
      const first = latest - (rnd() < 0.3 ? Math.floor(rnd() * 40) : 420); // 일부는 최근 등록(기준선 없음)
      let used = 100 * TB * (1 + rnd());
      for (let d = first; d <= latest; d++) {
        if (rnd() < 0.08 + (i % 3) * 0.1) continue;
        used += (rnd() - 0.3) * TB;
        rows.push(row(id, d, rnd() < 0.02 ? null : used, 1000 * TB));
      }
    }
    const m = srvG.growthMatrix(rows, { periods: srvG.DEFAULT_PERIODS, asOfDay: AS_OF });
    const devices = JSON.parse(JSON.stringify(m.devices)); // 화면은 HTTP 로 받은 행을 다시 더한다
    const a = web.aggregateGrowth(devices, m.periods, { asOfDay: AS_OF });
    for (const p of m.periods) {
      const S = m.totals.growth[p.key]; const W = a.growth[p.key];
      if (S.usedMeasured == null) sawNull++;
      if (S.partial) sawPartial++;
      if (typeof S.usedMeasured === 'number' && typeof W.usedMeasured === 'number') {
        assert.ok(Math.abs(S.usedMeasured - W.usedMeasured) <= Math.abs(S.usedMeasured) * 1e-12, `fleet-${k} ${p.key}: 서버 ${S.usedMeasured} · 웹 ${W.usedMeasured}`);
      } else assert.deepEqual(W.usedMeasured, S.usedMeasured, `fleet-${k} ${p.key}`);
      // 분모는 '더한 장비' 의 사용량이다 — 전 장비 사용량보다 클 수 없고, 더한 장비가 0 이면 null
      if (S.measured === 0) assert.equal(S.usedMeasured, null);
      if (S.usedMeasured != null) assert.ok(S.usedMeasured <= m.totals.usedBytes + 1);
      compared++;
    }
  }
  // 서버는 사용량을 모르는 장비에 증가량을 만들지 않으므로(growthFor 'no-latest-used') null 은 '더한 장비 0대' 일 때만 나온다 —
  //   그 경우를 따로 만든다(전부 최근 등록 장비 → 1년 기준선 없음).
  const fresh = [];
  for (let i = 0; i < 3; i++) for (let d = AS_OF - 5; d <= AS_OF; d++) fresh.push(row(`n${i}`, d, (10 + d - AS_OF) * TB));
  const mf = srvG.growthMatrix(fresh, { periods: srvG.DEFAULT_PERIODS, asOfDay: AS_OF });
  const af = web.aggregateGrowth(JSON.parse(JSON.stringify(mf.devices)), mf.periods, { asOfDay: AS_OF });
  for (const p of mf.periods) {
    assert.deepEqual(af.growth[p.key].usedMeasured, mf.totals.growth[p.key].usedMeasured, `최근 등록 함대 ${p.key}`);
    if (mf.totals.growth[p.key].measured === 0) sawNull++;
  }
  assert.ok(compared > 30 && sawPartial > 0 && sawNull > 0, `대조가 공허하다 — 비교 ${compared} · 부분 합 ${sawPartial} · null ${sawNull}`);
});

/* ── F-06 ─────────────────────────────────────────────────────────────── */
let gen = 0;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomSnap(seed) {
  const r = rng(seed);
  const vms = []; const hosts = [];
  for (let i = 0; i < 80 + Math.floor(r() * 120); i++) {
    const vc = r() < 0.5 ? 'vc1' : 'vc2';
    const ips = []; for (let j = 0; j < (r() < 0.2 ? 0 : (r() < 0.8 ? 1 : 2)); j++) ips.push(`10.${Math.floor(r() * 3)}.${Math.floor(r() * 6)}.${1 + Math.floor(r() * 254)}`);
    vms.push({ id: `vm-${i}`, name: `vm${i}`, vcenterId: vc, ipAddresses: ips, ipAddress: ips[0] || '', powerState: r() < 0.7 ? 'POWERED_ON' : 'POWERED_OFF', guestOS: 'CentOS 7 (64-bit)', host: `esx${i % 4}`, cluster: 'C1', notes: `n${i}` });
  }
  for (let i = 0; i < 6; i++) hosts.push({ id: `h-${i}`, name: `10.9.${i}.${10 + i}`, vcenterId: i % 2 ? 'vc1' : 'vc2', powerState: 'POWERED_ON', version: '8.0.2', cluster: 'C1', cpuUsageMhz: Math.floor(r() * 1e4) });
  return { generatedAt: `g-eq-${++gen}`, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }], vms, hosts, datastores: [], networks: [], alarms: [] };
}
const stripOwner = (out) => ({ ...out, rows: out.rows.map((r) => ({ ...r })) });

test('F-06 ① 결과 동일성 — 공유 양보판 원장은 동기 원장과 같다(범위·vCenter 별) · 시트는 넘겨받은 원장으로 같은 결과', async () => {
  let compared = 0;
  for (let k = 1; k <= 12; k++) {
    const snap = randomSnap(500 + k);
    for (const vc of ['', 'vc1']) {
      for (const allowed of [null, new Set(['vc2'])]) {
        const a = await led.buildIpamRowsShared(snap, vc, allowed, { sliceMs: 1 });
        // 동기판을 캐시 없이 비교하려면 다른 세대 객체로(같은 내용)
        const fresh = { ...snap, generatedAt: `${snap.generatedAt}-ref` };
        const b = led.buildIpamRows(fresh, vc, allowed);
        assert.ok(isDeepStrictEqual(stripOwner(a), stripOwner(b)), `seed ${k} vc=${vc} scope=${allowed ? [...allowed] : 'all'}`);
        const s1 = led.buildSubnetSheets(snap, { vcenterId: vc, allowed, ledger: a });
        const s2 = led.buildSubnetSheets(fresh, { vcenterId: vc, allowed });
        assert.ok(isDeepStrictEqual(s1, s2), `시트 seed ${k}`);
        compared++;
      }
    }
  }
  assert.equal(compared, 48);
});

test('F-06 ② 같은 키의 동시 계산은 하나만 돈다 · shouldCache 가 거짓이면 캐시에 넣지 않는다', async () => {
  const snap = randomSnap(901);
  const s0 = led._ledgerCacheStats();
  const [a, b, c] = await Promise.all([led.buildIpamRowsShared(snap, '', null), led.buildIpamRowsShared(snap, '', null), led.buildIpamRowsShared(snap, '', null)]);
  const s1 = led._ledgerCacheStats();
  assert.equal(s1.asyncBuilds - s0.asyncBuilds, 1, '같은 키 세 요청이 원장을 한 번만 만든다');
  assert.equal(s1.syncBuilds, s0.syncBuilds);
  assert.ok(a === b && b === c, '같은 결과 객체를 공유한다');
  assert.equal(s1.inflight, 0, '끝난 계산은 진행 목록에서 빠진다');

  const snap2 = randomSnap(902);
  const r = await led.buildIpamRowsShared(snap2, '', null, { shouldCache: () => false });
  assert.ok(r && Array.isArray(r.rows));
  const s2 = led._ledgerCacheStats();
  led.buildIpamRows(snap2, '', null); // 캐시에 없어야 한다 → 동기로 한 번 만든다
  assert.equal(led._ledgerCacheStats().syncBuilds, s2.syncBuilds + 1, 'shouldCache=false 인데 캐시에 들어갔다(옛 세대가 새 세대 항목을 밀어낸다)');
});

test('F-06 ③ 시트는 지금 입력으로 만든 원장만 받는다 — 리비전이 바뀐 뒤 넘긴 옛 원장은 버리고 새로 만든다', async () => {
  const snap = randomSnap(903);
  const ledger = await led.buildIpamRowsShared(snap, '', null);
  const ip = '10.250.0.7';
  assert.equal(ov.setOverride(ip, { owner: '예약' }, { username: 't' }).ok, true); // overridesRev 가 오른다
  try {
    const got = led.buildSubnetSheets(snap, { ledger });
    const want = led.buildSubnetSheets({ ...snap, generatedAt: `${snap.generatedAt}-ref` }, {});
    assert.ok(isDeepStrictEqual(got, want), '옛 원장으로 시트를 만들었다(새 예약 IP 가 빠진다)');
    assert.ok(got.some((s) => s.base === '10.250.0'), '새 예약 IP 의 /24 가 있어야 한다');
  } finally { ov.clearOverride(ip); }
});

/** 큰 원장 — VM 수만 대가 /24 수천 개에 흩어진다. */
function bigSnap(n = 30_000) {
  const vms = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i / 20);
    vms.push({ id: `vm-${i}`, name: `big${i}`, vcenterId: i % 3 ? 'vc1' : 'vc2', ipAddresses: [`10.${100 + (s >> 8)}.${s & 255}.${1 + (i % 20)}`], ipAddress: '', powerState: 'POWERED_ON', guestOS: 'Ubuntu 22.04', host: 'esx1', cluster: 'C1' });
  }
  return { generatedAt: `g-big-${++gen}`, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }], vms, hosts: [], datastores: [], networks: [], alarms: [] };
}
/** 요청 하나 동안의 이벤트 루프 최장 정지(2ms 간격 타이머의 최대 지연). */
async function getWithLag(p) {
  let maxLag = 0; let last = performance.now();
  const probe = setInterval(() => { const n = performance.now(); maxLag = Math.max(maxLag, n - last); last = n; }, 2);
  try {
    const r = await fetch(`${baseUrl}${p}`);
    const body = await r.json();
    return { status: r.status, body, lag: maxLag };
  } finally { clearInterval(probe); }
}

test('F-06 ④ live 재현 — store 가 원장을 건너뛴 새 세대에서 검색·시트 요청은 원장을 동기로 만들지 않는다(양보판 · 결과 동일)', async (t) => {
  const S = st.store;
  st._setLedgerAsyncMinForTest(1e9); // store 는 동기 경로(커밋을 기다리기 쉽게)
  try {
    S.snapshot = bigSnap();
    const t0 = Date.now();
    S._ledgerFullAt = 0;
    S.syncLedger();
    for (let i = 0; i < 400 && !(S.ledgerSync && S.ledgerSync.at >= t0); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(S.ledgerSync?.ok, true, `원장 커밋 실패: ${JSON.stringify(S.ledgerSync)}`);
    const lags = []; const ref = [];
    for (const p of ['/tools/ipam?q=10.100.5', '/tools/ipam/sheet?base=10.100.7', '/tools/ipam?q=10.101.']) {
      const skips = S.ledgerInputSkips || 0;
      S.snapshot = bigSnap(); // 같은 내용 · 새 세대 — store 는 입력 지문이 같아 원장을 만들지 않는다
      S.syncLedger();
      assert.equal(S.ledgerInputSkips, skips + 1, '테스트 전제: store 가 원장 재구성을 건너뛴다');
      const before = led._ledgerCacheStats();
      const r = await getWithLag(p);
      assert.equal(r.status, 200, `${p} ${JSON.stringify(r.body).slice(0, 200)}`);
      const after = led._ledgerCacheStats();
      assert.equal(after.syncBuilds, before.syncBuilds, `${p}: 라우트가 원장을 동기로 다시 만들었다`);
      assert.equal(after.asyncBuilds, before.asyncBuilds + 1, `${p}: 양보판으로 한 번 만든다`);
      lags.push(r.lag);
      // 비교 기준 — 같은 내용 원장을 동기로 새로 만드는 시간(예전 요청의 정지 하한)
      const snap = { ...S.snapshot, generatedAt: `${S.snapshot.generatedAt}-ref` };
      const ts = performance.now(); led.buildIpamRows(snap, '', null); ref.push(performance.now() - ts);
      // 결과는 동기 원장으로 만든 것과 같다
      if (p.startsWith('/tools/ipam/sheet')) {
        const want = led.buildSubnetSheets(snap, { onlyBase: '10.100.7' })[0];
        // v2.744(리드 후속 RY): 시트 라우트는 VM·호스트 칸의 owner 본문을 뺀다(slimOwnerRow) — 기준도 같은 다이어트를 거친다.
        assert.ok(isDeepStrictEqual(r.body, JSON.parse(JSON.stringify({ ...want, rows: want.rows.map(slimOwnerRow) }))), '시트 결과가 동기 원장과 다르다');
      } else {
        const q = new URL(`http://x${p}`).searchParams.get('q');
        const want = led.buildIpamRows(snap, '', null).rows.filter((x) => String(x.ip).toLowerCase().includes(q)).length;
        assert.equal(r.body.matched, want, '검색 결과 개수가 동기 원장과 다르다');
      }
    }
    // 판정의 주축은 위의 syncBuilds 계수(결정적)다. 정지 시간은 보조 — GC·다른 프로세스 부하로 한 번 튈 수 있어 중앙값으로 본다
    //   (동기로 되돌아가면 세 요청 모두 재구성 시간만큼 멈춰 중앙값이 그 이상이 된다).
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const lagMed = med(lags); const refMed = med(ref);
    t.diagnostic(`요청 중 최장 정지 ${lags.map((x) => x.toFixed(1)).join('·')}ms · 동기 재구성 ${ref.map((x) => x.toFixed(1)).join('·')}ms`);
    assert.ok(refMed > 40, `비교 기준이 너무 작다(${refMed.toFixed(1)}ms) — 표본을 키울 것`);
    assert.ok(lagMed < refMed / 2, `요청 중 정지 중앙값 ${lagMed.toFixed(1)}ms 가 동기 재구성 ${refMed.toFixed(1)}ms 의 절반 이상이다 — 원장을 동기로 만든다`);
  } finally {
    st._setLedgerAsyncMinForTest(NaN);
  }
});

test('F-06 ④-b 계산 도중 새 스냅샷이 게시돼도(캐시에 넣지 않는 경우) 시트는 넘겨받은 양보판 원장으로 만든다 — 동기로 다시 만들지 않는다', async () => {
  const S = st.store;
  st._setLedgerAsyncMinForTest(1e9);
  try {
    S.snapshot = bigSnap();
    const t0 = Date.now();
    S._ledgerFullAt = 0;
    S.syncLedger();
    for (let i = 0; i < 400 && !(S.ledgerSync && S.ledgerSync.at >= t0); i++) await new Promise((r) => setTimeout(r, 20));
    const skips = S.ledgerInputSkips || 0;
    const old = bigSnap();
    S.snapshot = old; S.syncLedger();
    assert.equal(S.ledgerInputSkips, skips + 1, '테스트 전제: store 가 원장 재구성을 건너뛴다');
    const before = led._ledgerCacheStats();
    const pr = fetch(`${baseUrl}/tools/ipam/sheet?base=10.100.9`);
    // 라우트의 양보판 계산이 시작된 뒤 새 세대를 게시한다(30초마다 store.refresh 가 하는 일)
    let seen = false;
    for (let i = 0; i < 20000; i++) { if (led._ledgerCacheStats().inflight > 0) { seen = true; break; } await new Promise((r) => setImmediate(r)); }
    assert.ok(seen, '라우트의 양보판 계산을 관측하지 못했다(테스트 전제)');
    S.snapshot = bigSnap();
    const r = await pr;
    const body = await r.json();
    assert.equal(r.status, 200);
    const after = led._ledgerCacheStats();
    assert.equal(after.syncBuilds, before.syncBuilds, '새 세대 게시 뒤 시트가 원장을 동기로 다시 만들었다(넘겨받은 원장을 쓰지 않았다)');
    assert.equal(after.asyncBuilds, before.asyncBuilds + 1);
    const want = led.buildSubnetSheets({ ...old, generatedAt: `${old.generatedAt}-ref` }, { onlyBase: '10.100.9' })[0];
    assert.ok(isDeepStrictEqual(body, JSON.parse(JSON.stringify({ ...want, rows: want.rows.map(slimOwnerRow) }))), '시트 결과가 동기 원장과 다르다'); // v2.744(리드 후속 RY)
  } finally {
    st._setLedgerAsyncMinForTest(NaN);
  }
});

test('F-06 ④-c 시트 cache:false — 기다리는 사이 새 세대가 게시된 라우트는 옛 세대 시트로 새 세대 항목을 밀어내지 않는다', () => {
  const cur = randomSnap(905);
  led.buildSubnetSheets(cur, { onlyBase: '10.0.1' });                 // 지금 세대 시트 둘(옛 세대 항목이 들어오면 둘 다 지워져 1이 된다)
  led.buildSubnetSheets(cur, { onlyBase: '10.0.2' });
  const s0 = led._ledgerCacheStats();
  assert.ok(s0.sheets >= 2 && s0.sheetsGenerations === 1, JSON.stringify(s0));
  const old = randomSnap(906);                                           // 다른 세대(옛 스냅샷)
  const got = led.buildSubnetSheets(old, { onlyBase: '10.0.1', cache: false });
  const s1 = led._ledgerCacheStats();
  assert.equal(s1.sheets, s0.sheets, 'cache:false 인데 시트 캐시가 바뀌었다(옛 세대가 지금 세대 항목을 지웠다)');
  assert.equal(s1.sheetsGenerations, s0.sheetsGenerations);
  assert.ok(isDeepStrictEqual(got, led.buildSubnetSheets({ ...old, generatedAt: `${old.generatedAt}-ref` }, { onlyBase: '10.0.1' })), '결과는 캐시와 무관하게 같다');
});

test('F-06 ⑤ 소스 — 라우트 파일은 원장을 동기 buildIpamRows 로 만들지 않는다(양보판 routeLedger 하나)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const s = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/ipamExport.js'), 'utf8'));
  assert.doesNotMatch(s, /\bbuildIpamRows\(/, 'ipamExport.js 에 동기 원장 호출이 남아 있다');
  for (const route of ["'/tools/ipam'", "'/tools/ipam/sheet'", "'/tools/ipam.xlsx'", "'/tools/ipam.csv'"]) {
    const i = s.indexOf(`api.get(${route}`);
    assert.ok(i > 0, route);
    assert.match(s.slice(i, i + 600), /routeLedger\(/, `${route} 는 routeLedger 를 쓴다`);
  }
  // 기다린 뒤 시트를 만드는 라우트는 지금 세대일 때만 시트를 캐시에 넣는다
  assert.equal((s.match(/cache: store\.get\(\) === snap/g) || []).length, 2, '/sheet·엑셀 두 곳');
});
