// v2.746 — 가상머신 상세 C안: CPU·메모리 사용률 분포(5% 칸 20개) · 전원·GPU · Guest OS 상위 · 패널 선택(facet).
//   계약: scratchpad v2746/CONTRACT.md '서버(그룹 S)' 절. 판정 모듈은 `inventory/vmDist.js` 하나다.
//   실제 `api` 라우터를 express 에 마운트해 HTTP 로 본다(소스 grep 아님) + 순수 단위.
//   ① 칸 판정 표 — null·''·음수 → 미수집 · 75 → 15 · 90 → 18 · 100·150 → 19
//   ② 패널 선택 쿼리 정규화 · 형식 오류 판정(키마다 여러 변형)
//   ③ 분포 — 항등식 · 자기 패널 선택은 자기 개수를 줄이지 않음 · 다른 패널 선택은 줄임 · 정지 VM 은 off · over100 · OS 상위·덧붙임
//   ④ 새 키 없는 요청은 예전 구현(이 파일 안의 오라클)과 **바이트 단위로** 같다(facets 빈 객체만 끝에 붙는다)
//   ⑤ 패널 선택이 있으면: total·items·페이지는 선택을 따르고 KPI(totals)는 따르지 않는다 · dist.total === total
//   ⑥ 400 bad-facet — memoJson·paged 판정보다 먼저 · 운영 경로(queryNormalize 뒤)의 배열·객체 모양도 400(v2.746 검토 SP-01)
//   ⑥-c 200자를 넘는 Guest OS — 분포 이름을 화면처럼 다듬어 다시 보내면 그 줄의 개수가 나온다(v2.746 검토 RV-S1·C-02)
//   ⑦ 선택을 바꾸면 옛 커서는 400 cursor-query-mismatch · 순서 기억을 다시 만들 때도 같은 집합(누락·유령 0)
//   ⑧ 범위 계정은 자기 vCenter 만 센다 · dist 없으면 응답에 없다
//   ⑨ 성능 — 운영 규모(VM 6,000) 한 번 계산이 수 ms(넉넉한 상한 + 선형 비율)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmDist2746-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

// 기준 시각은 경계에서 떨어뜨린 고정 값(CLAUDE.md — Date.now() 금지). 스냅샷마다 시각을 달리해 응답 기억이 섞이지 않게 한다.
const BASE_AT = Date.UTC(2026, 9, 20, 3, 30, 0);
let atSeq = 0;
const nextAt = () => BASE_AT + (atSeq++) * 60_000;

const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { api } = await import('../src/routes/api.js');
const { applyFilters, sortBy, scopeKey } = await import('../src/routes/api/shared.js');
const { numOrNull } = await import('../src/util/numOrNull.js');
const { VM_PINS, buildVmPage, isPagedRequest, createVmPinCache, VM_FILTER_KEYS } = await import('../src/inventory/vmPaging.js');
const dist = await import('../src/inventory/vmDist.js');
const { usageBinOf, parseVmFacets, vmDistribution, filterVmsByFacets, osKeyOf, powerKindOf } = dist;

/* ───────────────────────── 픽스처(합성 — 운영 식별자 없음) ───────────────────────── */
const CPU_SEQ = [null, '', -3, 0, 4.99, 5, 37.5, 74.9, 75, 77, 89.99, 90, 91, 96, 99.99, 100, 150, '42', 12, 63];
const MEM_SEQ = [8, 88, 91, 100, 120, null, 3, 76, 55, 95, -1, 0, 45, 22, 79, 90, 10, 66, 99, 50];
const POWER_SEQ = ['POWERED_ON', 'POWERED_ON', 'POWERED_ON', 'POWERED_OFF', 'POWERED_ON', 'SUSPENDED', 'POWERED_ON', undefined, 'POWERED_ON', 'weird'];
const OS_SEQ = ['Linux A 9', 'Linux A 10', 'Win Server 2022', '', '  Linux A 9  ', 'Win Server 2019', 'Other 64', 'Linux A 10', 'Win Server 2022', undefined, 'Rare OS', 'Linux A 9'];
const GPU_SEQ = [null, null, { type: 'vgpu', count: 1 }, null, { type: 'passthrough', count: 2 }, null, { type: 'mixed', count: 2 }, null, { type: 'other', count: 1 }];
const TOOLS_SEQ = ['toolsOk', 'toolsOld', 'toolsNotRunning'];

function mkVms(n, { vcs = 3 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const vc = `vc${(i % vcs) + 1}`;
    const v = {
      id: `${vc}:vm-${i}`,
      vcenterId: vc,
      name: i % 7 === 0 ? 'app' : `vm-${String(i % 211).padStart(3, '0')}`,
      host: `esx-${i % 9}`,
      powerState: POWER_SEQ[i % POWER_SEQ.length],
      cpuCount: (i % 8) + 1,
      cpuUsagePct: CPU_SEQ[i % CPU_SEQ.length],
      memUsagePct: MEM_SEQ[(i * 3) % MEM_SEQ.length],
      memMB: 1024 * ((i % 6) + 1),
      // 부동소수 합은 순서에 따라 비트가 달라진다 — 정렬 뒤 합계를 그대로 재현하는지 본다.
      storageGB: i % 13 === 0 ? null : 0.1 * (i % 17) + 0.3 * (i % 5),
      uncommittedGB: i % 11 === 0 ? null : 0.7 * (i % 3),
      guestOS: OS_SEQ[i % OS_SEQ.length],
      ipAddress: `10.${i % 3}.${i % 250}.${i % 200}`,
      toolsStatus: TOOLS_SEQ[i % 3],
    };
    if (v.guestOS === undefined) delete v.guestOS;
    if (v.powerState === undefined) delete v.powerState;
    const g = GPU_SEQ[i % GPU_SEQ.length];
    if (g) v.gpu = g;
    out.push(v);
  }
  return out;
}
function mkSnap(vms) {
  return {
    generatedAt: new Date(nextAt()).toISOString(),
    source: 'mock',
    vcenters: [
      { id: 'vc1', name: 'vc1', status: 'connected', location: { region: '아시아' } },
      { id: 'vc2', name: 'vc2', status: 'connected', location: { region: '유럽' } },
      { id: 'vc3', name: 'vc3', status: 'connected', location: { region: '북미' } },
    ],
    hosts: [], datastores: [], alarms: [], networks: [], vms, rollups: {},
  };
}

let SNAP = mkSnap(mkVms(600));
const ADMIN = { username: 'adm', role: 'admin', scope: null };
const SCOPED = { username: 'sc', role: 'admin', scope: { vcenters: ['vc1'] } };

async function withServer(fn) {
  const orig = store.get;
  store.get = () => SNAP;
  const app = express();
  // 운영(index.js)처럼 라우터보다 먼저 쿼리 정규화기를 단다 — 없으면 배열·객체 쿼리가 운영과 다른 경로로 라우트에 닿는다(SP-01).
  app.use(queryNormalizer());
  app.use(express.json());
  app.use((req, _res, next) => { req.user = req.get('x-test-user') === 'scoped' ? SCOPED : ADMIN; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { store.get = orig; srv.close(); }
}
function qsOf(qs) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) {
    if (Array.isArray(v)) for (const x of v) u.append(k, x); else u.append(k, v);
  }
  return u.toString();
}
async function getRaw(base, qs, user = 'admin') {
  const r = await fetch(`${base}/api/vms?${qsOf(qs)}`, { headers: { 'x-test-user': user } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 본문 아님 */ }
  return { status: r.status, text, body };
}

async function getRawQs(base, raw, user = 'admin') {
  const r = await fetch(`${base}/api/vms?${raw}`, { headers: { 'x-test-user': user } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 본문 아님 */ }
  return { status: r.status, text, body };
}

/* ───────────────────────── 오라클 — BASE(4456f26) 의 matchVms · /vms 계산을 그대로 옮겼다 ───────────────────────── */
function oracleMatchVms(snap, q, user) {
  const nameOnly = q.nameOnly === '1' || q.nameOnly === 'true';
  const vms = applyFilters(snap.vms, q, snap, nameOnly ? ['name'] : ['name', 'guestOS', 'ipAddress', 'host'], user);
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const ranges = [
    ['cpuCount', num(q.vcpuMin), num(q.vcpuMax)],
    ['memMB', num(q.ramMinGB) != null ? num(q.ramMinGB) * 1024 : undefined, num(q.ramMaxGB) != null ? num(q.ramMaxGB) * 1024 : undefined],
    ['storageGB', num(q.diskMinGB), num(q.diskMaxGB)],
    ['cpuUsagePct', num(q.cpuUsageMin), num(q.cpuUsageMax)],
    ['memUsagePct', num(q.memUsageMin), num(q.memUsageMax)],
  ].filter(([, min, max]) => (min != null && !Number.isNaN(min)) || (max != null && !Number.isNaN(max)));
  const osq = q.os ? String(q.os).toLowerCase() : null;
  const wantGpu = q.gpu === '1' || q.gpu === 'true';
  const gpuType = (v) => v.gpu?.type || null;
  const gpuCounts = { total: 0, vgpu: 0, passthrough: 0, mixed: 0 };
  const out = [];
  for (const v of vms) {
    if (q.powerState && v.powerState !== q.powerState) continue;
    if (q.host && v.host !== q.host) continue;
    let hit = true;
    for (const [field, min, max] of ranges) {
      const val = numOrNull(v[field]);
      if (val == null) { hit = false; break; }
      if (min != null && !Number.isNaN(min) && !(val >= min)) { hit = false; break; }
      if (max != null && !Number.isNaN(max) && !(val <= max)) { hit = false; break; }
    }
    if (!hit) continue;
    if (osq && !String(v.guestOS).toLowerCase().includes(osq)) continue;
    if (q.toolsStatus && v.toolsStatus !== q.toolsStatus) continue;
    if (v.gpu) {
      gpuCounts.total++;
      const t = gpuType(v);
      if (t === 'vgpu') gpuCounts.vgpu++;
      else if (t === 'passthrough') gpuCounts.passthrough++;
      else if (t === 'mixed') gpuCounts.mixed++;
    }
    if (wantGpu && !v.gpu) continue;
    if (q.gpuType && gpuType(v) !== q.gpuType) continue;
    out.push(v);
  }
  return { vms: out, gpuCounts };
}
function oracleVms(snap, q, user, pins) {
  const paged = isPagedRequest(q);
  const matched = oracleMatchVms(snap, q, user);
  let vms = matched.vms;
  const gpuCounts = matched.gpuCounts;
  if (q.sortBy && !paged) vms = sortBy(vms, q.sortBy, q.order);
  const limit = Math.max(1, Math.min(Number(q.limit) || 500, 5000));
  const sm = (fn) => vms.reduce((a, v) => a + (fn(v) || 0), 0);
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const avgOf = (arr, fn) => {
    let sum = 0; let n = 0;
    for (const v of arr) { const x = numOrNull(fn(v)); if (x == null) continue; sum += x; n += 1; }
    return { value: n ? Math.round((sum / n) * 10) / 10 : null, missing: arr.length - n };
  };
  const cpuAvg = avgOf(on, (v) => v.cpuUsagePct);
  const memAvg = avgOf(on, (v) => v.memUsagePct);
  const avg = (arr, fn) => avgOf(arr, fn).value;
  const totals = {
    count: vms.length,
    poweredOn: on.length,
    poweredOff: vms.length - on.length,
    vcpu: sm((v) => v.cpuCount),
    ramGB: Math.round(sm((v) => v.memMB) / 1024),
    diskGB: sm((v) => v.storageGB),
    diskTB: Math.round(sm((v) => v.storageGB) / 1024 * 10) / 10,
    avgCpuUsagePct: cpuAvg.value,
    avgMemUsagePct: memAvg.value,
    usageUnknown: { cpu: cpuAvg.missing, mem: memAvg.missing },
    storageUnknown: vms.filter((v) => numOrNull(v.storageGB) == null).length,
    avgDiskUsagePct: avg(vms.filter((v) => numOrNull(v.storageGB) != null && numOrNull(v.uncommittedGB) != null && v.storageGB + v.uncommittedGB > 0),
      (v) => (v.storageGB / (v.storageGB + v.uncommittedGB)) * 100),
    gpu: gpuCounts,
  };
  const snapshotAt = snap.generatedAt ?? null;
  if (paged) {
    const pg = buildVmPage({ vms, q, snapAt: snap.generatedAt, scopeKeyStr: scopeKey(user, snap), pins });
    if (!pg.ok) throw new Error(pg.code);
    return { total: vms.length, items: pg.items, totals, returned: pg.items.length, hasMore: pg.hasMore, nextCursor: pg.nextCursor, snapshotAt, page: pg.page };
  }
  const items = vms.slice(0, limit);
  return { total: vms.length, items, totals, returned: items.length, hasMore: vms.length > items.length, nextCursor: null, snapshotAt };
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `@${i}: …${a.slice(Math.max(0, i - 60), i + 60)}… vs …${b.slice(Math.max(0, i - 60), i + 60)}…`;
  return a.length === b.length ? '' : `길이 ${a.length} vs ${b.length}`;
}

/* 패널 선택 판정을 이 파일 안에서 다시 계산(독립 검산) — 계약의 문장을 그대로 옮긴 것 */
function refBin(p) {
  const n = numOrNull(p);
  if (n == null || n < 0) return null;
  if (n >= 100) return 19;
  return Math.floor(n / 5);
}
function refPower(v) {
  if (v.powerState === 'POWERED_ON') return 'on';
  if (v.powerState === 'POWERED_OFF') return 'off';
  if (v.powerState === 'SUSPENDED') return 'suspended';
  return 'other';
}
function refOs(v) {
  const s = v.guestOS == null ? '' : String(v.guestOS).trim();
  return s === '' ? '~' : s;
}
function refBinPass(spec, v, field) {
  if (!spec) return true;
  if (v.powerState !== 'POWERED_ON') return false;
  const b = refBin(v[field]);
  if (spec === 'na') return b == null;
  const [a, z] = spec.split('-').map(Number);
  return b != null && b >= a && b <= z;
}
function refPass(v, f) {
  return refBinPass(f.cpuBin, v, 'cpuUsagePct') && refBinPass(f.memBin, v, 'memUsagePct')
    && (!f.power || refPower(v) === f.power) && (!f.osName || refOs(v) === f.osName);
}

/* ───────────────────────── ① 칸 판정 ───────────────────────── */
test('① usageBinOf — null·빈 값·음수는 미수집, 경계 75→15·90→18, 100 이상은 마지막 칸', () => {
  const table = [
    [null, null], [undefined, null], ['', null], ['   ', null], ['abc', null], [[], null], [{}, null], [NaN, null], [Infinity, null],
    [-0.1, null], [-5, null], [-100, null],
    [0, 0], [0.4, 0], [4.99, 0], [5, 1], [9.99, 1], [10, 2], [74.99, 14], [75, 15], [79.99, 15], [80, 16],
    [89.99, 17], [90, 18], [94.99, 18], [95, 19], [99.99, 19], [100, 19], [100.01, 19], [150, 19], [1e9, 19],
    ['42', 8], ['75', 15],
  ];
  for (const [p, want] of table) assert.equal(usageBinOf(p), want, `usageBinOf(${JSON.stringify(p)})`);
  assert.equal(dist.VM_DIST_BINS, 20);
  assert.equal(dist.VM_DIST_BIN_PCT, 5);
  // 칸 번호는 언제나 0~19 정수
  for (let x = -10; x <= 300; x += 0.37) {
    const b = usageBinOf(x);
    if (x < 0) assert.equal(b, null); else assert.ok(Number.isInteger(b) && b >= 0 && b <= 19, `x=${x} → ${b}`);
  }
});

test('①-b 전원·OS 키 — 전원 4종, OS 는 앞뒤 공백 제거·대소문자 그대로·빈 값은 ~', () => {
  assert.equal(powerKindOf({ powerState: 'POWERED_ON' }), 'on');
  assert.equal(powerKindOf({ powerState: 'POWERED_OFF' }), 'off');
  assert.equal(powerKindOf({ powerState: 'SUSPENDED' }), 'suspended');
  assert.equal(powerKindOf({ powerState: 'poweredOn' }), 'other');
  assert.equal(powerKindOf({}), 'other');
  assert.equal(osKeyOf({ guestOS: '  Linux A 9 ' }), 'Linux A 9');
  assert.equal(osKeyOf({ guestOS: 'linux a 9' }), 'linux a 9');
  assert.equal(osKeyOf({ guestOS: '' }), '~');
  assert.equal(osKeyOf({ guestOS: '   ' }), '~');
  assert.equal(osKeyOf({}), '~');
  assert.equal(osKeyOf({ guestOS: null }), '~');
});

/* 200자를 넘는 Guest OS — 자른 끝이 공백·서로게이트 반쪽이면 화면이 다듬어 다시 보낸 값과 키가 어긋난다(v2.746 검토 RV-S1·C-02). */
const LONG_OS = {
  spaceAt199: `Custom Linux ${'x'.repeat(186)} build 2026 (64-bit)`,         // 200번째 글자(색인 199)가 공백
  surrAt199: `Custom OS ${'y'.repeat(189)}\u{1F427} edition`,                  // 색인 199~200 이 서로게이트 쌍
  spaceThenSurr: `A${'z'.repeat(197)} \u{1F427} tail`,                          // 색인 198 공백 · 199~200 서로게이트 쌍
  ideoAt199: `B${'w'.repeat(198)}　tail-end`,                               // 색인 199 가 U+3000(trim 대상)
  loneHigh: 'Odd OS \ud83d build 9',                                           // 짝 없는 상위 서로게이트(짧은 이름)
  loneLow: 'Odd OS \udc27 build 7',                                            // 짝 없는 하위 서로게이트
  exact200: `C${'v'.repeat(199)}`,                                             // 정확히 200자 — 그대로
};
/* 화면(web vmDistText.cleanOs)과 같은 다듬기 — trim, 200자 넘으면 보내지 않음. */
const webCleanOs = (v) => { const t = typeof v === 'string' ? v.trim() : ''; return t && t.length <= dist.OS_NAME_MAX ? t : ''; };
/* 브라우저 pollFetch 처럼 URLSearchParams 로 실어 보내고 서버가 받는 값. */
const overTheWire = (v) => new URLSearchParams(new URLSearchParams({ osName: v }).toString()).get('osName');

test('①-c OS 키 — 200자로 자른 끝에 공백·서로게이트 반쪽이 남지 않는다(키 = 다듬은 키 · 잘 짜인 문자열)', () => {
  assert.equal(LONG_OS.spaceAt199[199], ' ');
  assert.equal(LONG_OS.surrAt199.charCodeAt(199), 0xD83D);
  assert.equal(LONG_OS.spaceThenSurr[198], ' ');
  assert.equal(osKeyOf({ guestOS: LONG_OS.spaceAt199 }), LONG_OS.spaceAt199.slice(0, 199), '끝 공백을 남기지 않는다');
  assert.equal(osKeyOf({ guestOS: LONG_OS.surrAt199 }), LONG_OS.surrAt199.slice(0, 199), '쌍 가운데서 자르지 않는다');
  assert.equal(osKeyOf({ guestOS: LONG_OS.spaceThenSurr }), LONG_OS.spaceThenSurr.slice(0, 198), '서로게이트를 뗀 뒤 남은 공백도 지운다');
  assert.equal(osKeyOf({ guestOS: LONG_OS.ideoAt199 }), LONG_OS.ideoAt199.slice(0, 199));
  assert.equal(osKeyOf({ guestOS: LONG_OS.exact200 }), LONG_OS.exact200, '정확히 200자는 그대로');
  assert.equal(osKeyOf({ guestOS: LONG_OS.loneHigh }), 'Odd OS \uFFFD build 9', '짝 없는 서로게이트는 U+FFFD — 전송에서 바뀌는 값과 같게');
  assert.equal(osKeyOf({ guestOS: LONG_OS.loneLow }), 'Odd OS \uFFFD build 7');
  // 불변식 — 결정적 난수로 만든 긴 이름 수천 개(공백·U+3000·서로게이트 쌍·짝 없는 서로게이트를 경계 근처에 섞는다)
  let seed = 20261020;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const parts = ['a', 'Z', '9', ' ', '　', '\t', '\u{1F427}', '\ud83d', '\udc27', '가', '-'];
  for (let k = 0; k < 4000; k++) {
    let str = 'L';
    const len = 180 + Math.floor(rnd() * 50);
    while (str.length < len) str += parts[Math.floor(rnd() * parts.length)];
    const key = osKeyOf({ guestOS: str });
    assert.ok(key.length > 0 && key.length <= dist.OS_NAME_MAX, `길이 ${key.length}`);
    assert.equal(key, key.trim(), `키 끝에 공백이 남았다 #${k}`);
    assert.ok(key.isWellFormed(), `짝 없는 서로게이트가 남았다 #${k}`);
    assert.ok(str.trim().toWellFormed().startsWith(key), `키가 원문의 앞부분이 아니다 #${k}`);
    // 화면이 다듬어 실어 보낸 값으로 다시 거르면 같은 키다
    const back = parseVmFacets({ osName: overTheWire(webCleanOs(key)) });
    assert.ok(back.ok, `#${k}`);
    assert.equal(back.sel.osName, key, `왕복이 깨졌다 #${k}`);
  }
});

/* ───────────────────────── ② 쿼리 정규화 ───────────────────────── */
test('② parseVmFacets — 정상 값은 정규화 메아리, 형식이 틀리면 그 키를 지목', () => {
  const ok = (q) => { const r = parseVmFacets(q); assert.equal(r.ok, true, JSON.stringify(q)); return r; };
  const bad = (q, field) => { const r = parseVmFacets(q); assert.equal(r.ok, false, `거부해야 한다 ${JSON.stringify(q)}`); assert.equal(r.field, field, JSON.stringify(q)); };
  assert.deepEqual(ok({}).facets, {});
  assert.deepEqual(ok({ cpuBin: '', memBin: '', power: '', osName: '' }).facets, {}, '빈 값은 선택 없음');
  assert.deepEqual(ok({ cpuBin: '18-19' }).facets, { cpuBin: '18-19' });
  assert.deepEqual(ok({ cpuBin: '07-09' }).facets, { cpuBin: '7-9' }, '앞자리 0 은 정규화');
  assert.deepEqual(ok({ cpuBin: '0-19' }).facets, { cpuBin: '0-19' });
  assert.deepEqual(ok({ cpuBin: '4-4', memBin: 'na' }).facets, { cpuBin: '4-4', memBin: 'na' });
  for (const p of ['on', 'off', 'suspended', 'other']) assert.deepEqual(ok({ power: p }).facets, { power: p });
  assert.deepEqual(ok({ osName: '  Win Server 2022 ' }).facets, { osName: 'Win Server 2022' });
  assert.deepEqual(ok({ osName: '~' }).facets, { osName: '~' });
  assert.deepEqual(ok({ osName: 'x'.repeat(200) }).facets, { osName: 'x'.repeat(200) });
  const r = ok({ cpuBin: '15-19', gpu: '1', gpuType: 'vgpu' });
  assert.equal(r.sel.gpu, true);
  // 형식 오류 — 키마다 여러 변형
  for (const v of ['20-20', '19-20', '5-3', '-1-2', '1--2', 'a-b', '1.5-2', '1', '1-', '-2', 'NA', 'Na', ' 1-2', '1-2 ', '001-2', '1-2-3', ['1-2', '3-4']]) {
    bad({ cpuBin: v }, 'cpuBin');
    bad({ memBin: v }, 'memBin');
  }
  for (const v of ['ON', 'On', 'x', 'poweredOn', 'POWERED_ON', ['on']]) bad({ power: v }, 'power');
  for (const v of ['x'.repeat(201), `  ${'y'.repeat(201)}  `, ['Linux', 'Win']]) bad({ osName: v }, 'osName');
  bad({ cpuBin: { a: '1' } }, 'cpuBin');
  // 여러 키가 틀리면 앞 키부터(cpuBin → memBin → power → osName)
  bad({ power: 'x', memBin: 'q' }, 'memBin');
  // 원문 쿼리 모양(SP-01) — 정규화기가 마지막 값으로 바꾼 req.query 라도 원문이 배열·객체 모양이면 그 키를 지목
  const badRaw = (q, rawQuery, field) => { const r = parseVmFacets(q, { rawQuery }); assert.equal(r.ok, false, rawQuery); assert.equal(r.field, field, rawQuery); };
  badRaw({ cpuBin: '18-19' }, 'cpuBin=bad&cpuBin=18-19', 'cpuBin');
  badRaw({}, 'cpuBin[x]=18-19', 'cpuBin');
  badRaw({ osName: 'a' }, 'osName=a&osName=a', 'osName');
  badRaw({ cpuBin: 'x' }, 'cpuBin=x&memBin=1&memBin=2', 'cpuBin');
  badRaw({ cpuBin: '1-2' }, 'cpuBin=1-2&memBin[0]=1', 'memBin');
  assert.equal(parseVmFacets({ cpuBin: '18-19' }, { rawQuery: 'cpuBin=18-19&cpuBinX=1&x[cpuBin]=2' }).ok, true, '다른 키는 보지 않는다');
  assert.equal(parseVmFacets({ cpuBin: '18-19' }, { rawQuery: '' }).ok, true);
  assert.equal(parseVmFacets({ cpuBin: '18-19' }, {}).ok, true, '원문이 없으면 req.query 만 본다');
  assert.equal(dist.facetShapeIssues('%E0%A4%A&cpuBin=1-2').size, 0, '깨진 퍼센트 인코딩도 던지지 않는다');
  // OS 이름의 짝 없는 서로게이트는 키와 같은 규칙(U+FFFD) — 직접 호출해도 osKeyOf 와 맞는다
  assert.equal(ok({ osName: ' Odd OS \ud83d build 9 ' }).sel.osName, osKeyOf({ guestOS: 'Odd OS \ud83d build 9' }));
  assert.equal(ok({ osName: 'Odd OS \ud83d build 9' }).sel.osName, 'Odd OS \uFFFD build 9');
});

/* ───────────────────────── ③ 분포(순수) ───────────────────────── */
function sumRange(arr, a, b) { let s = 0; for (let i = a; i <= b; i++) s += arr[i]; return s; }
function selOf(q) { const r = parseVmFacets(q); assert.ok(r.ok, JSON.stringify(q)); return r.sel; }

test('③ 분포 — 항등식(선택이 없을 때·cpuBin·memBin·na·power·gpu)과 dist.total = 모든 facet 통과 수', () => {
  const vms = mkVms(600);
  const none = vmDistribution(vms, selOf({}));
  assert.equal(none.binPct, 5);
  assert.equal(none.bins, 20);
  assert.equal(none.cpu.bins.length, 20);
  assert.equal(none.total, vms.length);
  assert.equal(none.cpu.bins.reduce((a, b) => a + b, 0) + none.cpu.na + none.cpu.off, none.total, 'cpu 항등식');
  assert.equal(none.mem.bins.reduce((a, b) => a + b, 0) + none.mem.na + none.mem.off, none.total, 'mem 항등식');
  assert.equal(none.power.on + none.power.off + none.power.suspended + none.power.other, none.total, 'power 합');
  assert.equal(none.gpu.total + none.gpu.none, none.total, 'gpu 합');
  const osSum = none.os.top.reduce((a, t) => a + t.n, 0) + none.os.other;
  assert.equal(osSum, none.total, 'os 합');
  // 독립 검산 — 미수집·정지·over100 개수
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  assert.equal(none.cpu.off, vms.length - on.length);
  assert.equal(none.cpu.na, on.filter((v) => refBin(v.cpuUsagePct) == null).length);
  assert.equal(none.cpu.over100, on.filter((v) => numOrNull(v.cpuUsagePct) > 100).length);
  assert.ok(none.cpu.over100 > 0, '픽스처에 100 초과가 있어야 한다');
  assert.ok(none.cpu.na > 0 && none.mem.na > 0, '픽스처에 미수집이 있어야 한다');
  for (let i = 0; i < 20; i++) assert.equal(none.cpu.bins[i], on.filter((v) => refBin(v.cpuUsagePct) === i).length, `cpu 칸 ${i}`);
  for (let i = 0; i < 20; i++) assert.equal(none.mem.bins[i], on.filter((v) => refBin(v.memUsagePct) === i).length, `mem 칸 ${i}`);

  for (const spec of ['18-19', '15-19', '0-0', '3-12', '19-19', '7-7']) {
    const [a, b] = spec.split('-').map(Number);
    const d = vmDistribution(vms, selOf({ cpuBin: spec }));
    assert.equal(sumRange(d.cpu.bins, a, b), d.total, `cpuBin ${spec}`);
    assert.equal(d.total, vms.filter((v) => refPass(v, { cpuBin: spec })).length);
    const m = vmDistribution(vms, selOf({ memBin: spec }));
    assert.equal(sumRange(m.mem.bins, a, b), m.total, `memBin ${spec}`);
  }
  const na = vmDistribution(vms, selOf({ cpuBin: 'na' }));
  assert.equal(na.cpu.na, na.total);
  assert.ok(na.total > 0);
  const mna = vmDistribution(vms, selOf({ memBin: 'na' }));
  assert.equal(mna.mem.na, mna.total);
  for (const p of ['on', 'off', 'suspended', 'other']) {
    const d = vmDistribution(vms, selOf({ power: p }));
    assert.equal(d.power[p], d.total, `power ${p}`);
    assert.ok(d.total > 0, `픽스처에 ${p} 가 있어야 한다`);
  }
  const g = vmDistribution(vms, selOf({ gpu: '1' }));
  assert.equal(g.gpu.total, g.total, 'gpu=1 이면 gpu.total === total');
  // 여러 패널을 함께 — 각 항등식이 동시에 성립
  const multi = vmDistribution(vms, selOf({ cpuBin: '0-14', memBin: '15-19', power: 'on' }));
  assert.equal(sumRange(multi.cpu.bins, 0, 14), multi.total);
  assert.equal(sumRange(multi.mem.bins, 15, 19), multi.total);
  assert.equal(multi.power.on, multi.total);
  assert.equal(multi.total, vms.filter((v) => refPass(v, { cpuBin: '0-14', memBin: '15-19', power: 'on' })).length);
  assert.deepEqual(multi.selected, { cpuBin: '0-14', memBin: '15-19', power: 'on', osName: null, gpu: false, gpuType: null });
});

test('③-b 자기 패널 선택은 자기 개수를 줄이지 않고, 다른 패널 선택은 줄인다', () => {
  const vms = mkVms(600);
  const none = vmDistribution(vms, selOf({}));
  const c = vmDistribution(vms, selOf({ cpuBin: '18-19' }));
  assert.ok(isDeepStrictEqual(c.cpu, none.cpu), 'cpu 선택이 cpu 분포를 바꾸면 안 된다');
  assert.ok(!isDeepStrictEqual(c.mem, none.mem), 'cpu 선택은 mem 분포를 줄인다');
  // mem 분포 = cpu 18~19 칸 VM 들만의 분포(독립 검산)
  const sub = vms.filter((v) => refPass(v, { cpuBin: '18-19' }));
  for (let i = 0; i < 20; i++) assert.equal(c.mem.bins[i], sub.filter((v) => refBin(v.memUsagePct) === i).length);
  assert.equal(c.mem.off, 0, 'cpu 칸을 고르면 정지 VM 은 다른 패널에서도 빠진다');
  assert.equal(c.power.on, c.total);
  assert.equal(c.power.off + c.power.suspended + c.power.other, 0);
  const m = vmDistribution(vms, selOf({ memBin: '15-19' }));
  assert.ok(isDeepStrictEqual(m.mem, none.mem), 'mem 선택이 mem 분포를 바꾸면 안 된다');
  const p = vmDistribution(vms, selOf({ power: 'off' }));
  assert.ok(isDeepStrictEqual(p.power, none.power), 'power 선택이 power 분포를 바꾸면 안 된다');
  assert.equal(p.cpu.off, p.total);
  assert.equal(p.cpu.bins.reduce((a, b) => a + b, 0), 0);
  const o = vmDistribution(vms, selOf({ osName: 'Win Server 2022' }));
  assert.equal(o.os.distinct, none.os.distinct, 'os 선택이 os 분포를 바꾸면 안 된다');
  assert.ok(isDeepStrictEqual(o.os.top.map((t) => [t.name, t.n]), none.os.top.map((t) => [t.name, t.n])));
  assert.ok(o.os.top.find((t) => t.name === 'Win Server 2022').selected);
  const g = vmDistribution(vms, selOf({ gpu: '1', gpuType: 'vgpu' }));
  assert.ok(isDeepStrictEqual(g.gpu, none.gpu), 'gpu 선택이 gpu 분포를 바꾸면 안 된다');
  assert.ok(g.cpu.off + g.cpu.na + g.cpu.bins.reduce((a, b) => a + b, 0) === g.total);
});

test('③-c 미수집·정지·over100 — 작은 표에서 칸 하나하나', () => {
  const V = (powerState, cpu, mem, guestOS = 'L') => ({ id: `x${Math.random()}`, vcenterId: 'vc1', powerState, cpuUsagePct: cpu, memUsagePct: mem, guestOS });
  const vms = [
    V('POWERED_ON', null, 10), V('POWERED_ON', '', 10), V('POWERED_ON', -1, 10), V('POWERED_ON', 'n/a', 10),
    V('POWERED_ON', 100, 100), V('POWERED_ON', 150, 99.9), V('POWERED_ON', 75, 90), V('POWERED_ON', 74.999, 89.999),
    V('POWERED_OFF', 95, 95), V('SUSPENDED', 50, 50), V(undefined, 5, 5),
  ];
  const d = vmDistribution(vms, selOf({}));
  assert.equal(d.cpu.na, 4, 'null·빈 문자열·음수·숫자 아님 → 미수집');
  assert.equal(d.cpu.off, 3, '정지·일시정지·전원 모름은 분포 밖');
  assert.equal(d.cpu.bins[19], 2, '100·150 → 칸 19');
  assert.equal(d.cpu.over100, 1, '100 초과만 따로 센다(100 은 아님)');
  assert.equal(d.cpu.bins[15], 1);
  assert.equal(d.cpu.bins[14], 1);
  assert.equal(d.mem.bins[19], 2);
  assert.equal(d.mem.bins[18], 1);
  assert.equal(d.mem.bins[17], 1);
  assert.equal(d.mem.bins[2], 4);
  assert.equal(d.mem.over100, 0);
  assert.equal(d.power.on, 8);
  assert.equal(d.power.off, 1);
  assert.equal(d.power.suspended, 1);
  assert.equal(d.power.other, 1);
  // 정지 VM 은 CPU 95% 여도 90%↑ 칸 선택에 들지 않는다
  const hi = filterVmsByFacets(vms, selOf({ cpuBin: '18-19' }));
  assert.equal(hi.length, 2);
  assert.ok(hi.every((v) => v.powerState === 'POWERED_ON'));
});

test('③-d Guest OS 상위 — 개수 내림차순·동률은 숫자 인식 이름 순·고른 OS 가 상위 밖이면 끝에 붙인다', () => {
  const mk = (os, n) => Array.from({ length: n }, (_, i) => ({ id: `${os}-${i}`, vcenterId: 'vc1', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 10, guestOS: os }));
  const vms = [...mk('Win 10', 5), ...mk('Win 9', 5), ...mk('Alpha', 7), ...mk('', 3), ...mk('Beta', 2), ...mk('Gamma', 2), ...mk('Zeta', 1), ...mk('Eta', 1)];
  const d = vmDistribution(vms, selOf({}));
  assert.deepEqual(d.os.top.map((t) => [t.name, t.n]), [['Alpha', 7], ['Win 9', 5], ['Win 10', 5], ['~', 3], ['Beta', 2]]);
  assert.equal(d.os.other, 4);
  assert.equal(d.os.distinct, 8);
  assert.equal(d.os.unknownKey, '~');
  assert.ok(d.os.top.every((t) => t.selected === false));
  const s = vmDistribution(vms, selOf({ osName: 'Eta' }));
  assert.equal(s.os.top.length, 6, '상위 밖의 선택은 끝에 붙는다 — 사라지면 해제할 수 없다');
  assert.deepEqual(s.os.top.at(-1), { name: 'Eta', n: 1, selected: true });
  assert.equal(s.os.other, 3, '덧붙인 항목은 other 에서 뺀다');
  assert.equal(s.total, 1);
  const z = vmDistribution(vms, selOf({ osName: 'Nope', cpuBin: '2-2' }));
  assert.deepEqual(z.os.top.at(-1), { name: 'Nope', n: 0, selected: true });
  assert.equal(z.total, 0);
  const u = vmDistribution(vms, selOf({ osName: '~' }));
  assert.equal(u.total, 3);
  assert.ok(u.os.top.find((t) => t.name === '~').selected);
  const k = vmDistribution(vms, selOf({}), { osTop: 2 });
  assert.equal(k.os.top.length, 2);
});

/* ───────────────────────── ④ 예전과 바이트 단위로 같다 ───────────────────────── */
const OLD_CASES = [
  {}, { q: 'app' }, { q: 'vm-01', notes: '1' }, { vcenterId: 'vc2' }, { region: '유럽' }, { gpu: '1' }, { gpuType: 'vgpu' },
  { gpu: 'true', gpuType: 'passthrough' }, { gpuType: 'nope' }, { powerState: 'POWERED_OFF' }, { cpuUsageMin: '50' }, { cpuUsageMax: '5' },
  { memUsageMin: '10', memUsageMax: '80' }, { sortBy: 'cpuUsagePct', order: 'desc' }, { sortBy: 'name', order: 'asc', limit: '50' },
  { sortBy: 'storageGB' }, { sortBy: 'storageGB', order: 'asc', gpu: '1' }, { os: 'win' }, { vcpuMin: '2', ramMaxGB: '8' }, { host: 'esx-3' },
  { nameOnly: '1', q: 'vm-1' }, { limit: '7' }, { toolsStatus: 'toolsOk', diskMinGB: '1' }, { q: '10.1', gpu: '1', sortBy: 'memUsagePct' },
  { paged: '1', limit: '100', sortBy: 'cpuUsagePct' }, { paged: '1', limit: '50' }, { paged: 'true', limit: '37', sortBy: 'name', order: 'asc', gpu: '1' },
  { dist: '0' },
];

test('④ 새 키가 없는 요청 — 응답이 예전 구현과 바이트 단위로 같다(facets 빈 객체만 끝에 붙는다)', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(600));
  await withServer(async (base) => {
    for (const user of ['admin', 'scoped']) {
      const U = user === 'scoped' ? SCOPED : ADMIN;
      const oraclePins = createVmPinCache();
      for (const qs of OLD_CASES) {
        const r = await getRaw(base, qs, user);
        assert.equal(r.status, 200, `${user} ${JSON.stringify(qs)} ${r.text.slice(0, 200)}`);
        const want = JSON.stringify({ ...oracleVms(SNAP, { ...qs }, U, oraclePins), facets: {} });
        assert.ok(r.text === want, `${user} ${JSON.stringify(qs)} 응답이 예전과 다르다 ${firstDiff(r.text, want)}`);
        assert.equal(r.body.dist, undefined, 'dist 를 요청하지 않으면 싣지 않는다');
        // 페이지 순회 — 다음 페이지도 예전과 같다
        if (r.body.nextCursor && qs.paged) {
          const q2 = { ...qs, cursor: r.body.nextCursor };
          delete q2.paged;
          const r2 = await getRaw(base, q2, user);
          const want2 = JSON.stringify({ ...oracleVms(SNAP, q2, U, oraclePins), facets: {} });
          assert.ok(r2.text === want2, `${user} ${JSON.stringify(qs)} 다음 페이지가 예전과 다르다 ${firstDiff(r2.text, want2)}`);
        }
      }
    }
  });
});

/* ───────────────────────── ⑤ 패널 선택이 있는 요청 ───────────────────────── */
test('⑤ 패널 선택 — total·items 는 선택을 따르고 totals(KPI)는 따르지 않는다 · dist.total === total · 항등식', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(600));
  await withServer(async (base) => {
    const cases = [
      { cpuBin: '18-19' }, { cpuBin: '15-19', sortBy: 'cpuUsagePct', order: 'desc' }, { cpuBin: 'na' }, { memBin: '0-4' }, { memBin: 'na', power: 'on' },
      { power: 'off' }, { power: 'suspended' }, { power: 'other' }, { osName: 'Linux A 9' }, { osName: '~' }, { osName: 'linux a 9' },
      { cpuBin: '0-19', memBin: '15-19', gpu: '1' }, { cpuBin: '18-19', vcenterId: 'vc2' }, { osName: 'Win Server 2022', q: 'app', limit: '3' },
      { cpuBin: '3-12', sortBy: 'name', order: 'asc', limit: '10' },
    ];
    for (const user of ['admin', 'scoped']) {
      const U = user === 'scoped' ? SCOPED : ADMIN;
      for (const qs of cases) {
        const r = await getRaw(base, { ...qs, dist: '1' }, user);
        assert.equal(r.status, 200, `${JSON.stringify(qs)} ${r.text.slice(0, 200)}`);
        const b = r.body;
        // 예전 계산(패널 선택 없음)의 KPI 와 같아야 한다
        const plain = { ...qs };
        for (const k of ['cpuBin', 'memBin', 'power', 'osName']) delete plain[k];
        const old = oracleVms(SNAP, plain, U, createVmPinCache());
        assert.ok(isDeepStrictEqual(b.totals, old.totals), `${user} ${JSON.stringify(qs)} KPI(totals)가 패널 선택에 따라 바뀌었다`);
        // items 집합 = 예전 일치 집합(정렬 포함)을 패널 선택으로 거른 것
        const facetsOnly = {};
        for (const k of ['cpuBin', 'memBin', 'power', 'osName']) if (qs[k] != null) facetsOnly[k] = k === 'osName' ? String(qs[k]).trim() : qs[k];
        const oldAll = oracleVms(SNAP, { ...plain, limit: '5000' }, U, createVmPinCache()).items;
        const expSet = oldAll.filter((v) => refPass(v, facetsOnly));
        assert.equal(b.total, expSet.length, `${user} ${JSON.stringify(qs)} total`);
        const lim = Math.max(1, Math.min(Number(qs.limit) || 500, 5000));
        assert.deepEqual(b.items.map((v) => v.id), expSet.slice(0, lim).map((v) => v.id), `${user} ${JSON.stringify(qs)} items`);
        assert.equal(b.hasMore, expSet.length > lim);
        assert.equal(b.returned, Math.min(lim, expSet.length));
        // dist
        assert.ok(b.dist, 'dist=1 이면 dist 를 싣는다');
        assert.equal(b.dist.total, b.total, 'dist.total === /vms total');
        if (qs.cpuBin === 'na') assert.equal(b.dist.cpu.na, b.total);
        else if (qs.cpuBin) { const [a, z] = qs.cpuBin.split('-').map(Number); assert.equal(sumRange(b.dist.cpu.bins, a, z), b.total, `cpuBin ${qs.cpuBin}`); }
        if (qs.memBin === 'na') assert.equal(b.dist.mem.na, b.total);
        else if (qs.memBin) { const [a, z] = qs.memBin.split('-').map(Number); assert.equal(sumRange(b.dist.mem.bins, a, z), b.total); }
        if (qs.power) assert.equal(b.dist.power[qs.power], b.total);
        // 정규화 메아리
        assert.deepEqual(b.facets, facetsOnly);
        assert.equal(b.dist.selected.cpuBin, facetsOnly.cpuBin ?? null);
        assert.equal(b.dist.selected.osName, facetsOnly.osName ?? null);
        if (user === 'scoped') assert.ok(b.items.every((v) => v.vcenterId === 'vc1'));
      }
    }
    // 아무 선택도 없을 때의 항등식(라우트로)
    const r0 = await getRaw(base, { dist: '1' });
    const d0 = r0.body.dist;
    assert.equal(d0.cpu.bins.reduce((a, b) => a + b, 0) + d0.cpu.na + d0.cpu.off, r0.body.total);
    assert.equal(d0.total, r0.body.total);
    assert.deepEqual(r0.body.facets, {});
    // dist 없이는 응답에 없다(계산하지 않는다)
    const r1 = await getRaw(base, { cpuBin: '18-19' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.dist, undefined);
    assert.deepEqual(r1.body.facets, { cpuBin: '18-19' });
  });
});

test('⑤-b 페이지 순회도 선택을 따른다 — 누락·중복·유령 0, 순서 기억을 다시 만들어도 같은 집합', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(900));
  await withServer(async (base) => {
    for (const qs of [{ cpuBin: '15-19', sortBy: 'cpuUsagePct', order: 'desc' }, { power: 'on', memBin: '0-9', sortBy: 'name', order: 'asc' }, { osName: 'Linux A 10' }]) {
      const expIds = SNAP.vms.filter((v) => refPass(v, qs)).map((v) => v.id).sort();
      assert.ok(expIds.length > 20, `픽스처 ${JSON.stringify(qs)} 이 너무 작다`);
      for (const clearBetween of [false, true]) {
        VM_PINS.clear();
        const got = [];
        let cursor = null;
        for (let k = 0; k < 100; k++) {
          // 두 순회의 URL 이 같으면 응답 기억이 첫 순회 결과를 돌려준다 — 페이지 크기를 달리해 다시 계산하게 한다.
          const limit = clearBetween ? '11' : '13';
          const r = await getRaw(base, cursor ? { ...qs, limit, cursor } : { ...qs, limit, paged: '1' });
          assert.equal(r.status, 200, `${JSON.stringify(qs)} ${r.text.slice(0, 200)}`);
          assert.equal(r.body.total, expIds.length);
          assert.equal(r.body.page.orderTotal, expIds.length, '순서 목록은 선택 집합이어야 한다');
          assert.equal(r.body.page.vanished, 0, '선택 밖 VM 이 순서 목록에 들어가 있으면 유령으로 건너뛴다');
          got.push(...r.body.items.map((v) => v.id));
          if (!r.body.hasMore) break;
          cursor = r.body.nextCursor;
          if (clearBetween) VM_PINS.clear(); // 같은 스냅샷 — 라우트가 판정 함수로 순서를 다시 만든다
        }
        assert.equal(got.length, expIds.length, `${JSON.stringify(qs)} clear=${clearBetween}`);
        assert.deepEqual([...got].sort(), expIds);
      }
    }
  });
});

/* ───────────────────────── ⑥ 400 bad-facet ───────────────────────── */
test('⑥ 형식이 틀린 선택은 400 bad-facet(field) — 캐시·페이지 판정보다 먼저', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(120));
  await withServer(async (base) => {
    const bads = [
      [{ cpuBin: '20-20' }, 'cpuBin'], [{ cpuBin: '9-3' }, 'cpuBin'], [{ cpuBin: 'x' }, 'cpuBin'], [{ cpuBin: ['1-2', '3-4'] }, 'cpuBin'], [{ cpuBin: '1' }, 'cpuBin'],
      [{ memBin: '0-20' }, 'memBin'], [{ memBin: 'NA' }, 'memBin'], [{ memBin: '1.5-2' }, 'memBin'],
      [{ power: 'ON' }, 'power'], [{ power: 'x' }, 'power'], [{ power: ['on', 'off'] }, 'power'],
      [{ osName: 'z'.repeat(201) }, 'osName'], [{ osName: ['a', 'b'] }, 'osName'],
    ];
    for (const [qs, field] of bads) {
      for (const extra of [{}, { paged: '1' }, { cursor: '!!!not-a-cursor' }, { dist: '1' }]) {
        const r = await getRaw(base, { ...qs, ...extra });
        assert.equal(r.status, 400, `${JSON.stringify({ ...qs, ...extra })} → ${r.status} ${r.text.slice(0, 120)}`);
        assert.deepEqual(r.body, { ok: false, error: 'bad-facet', reason: 'bad-facet', field });
      }
    }
    // 200자는 받는다
    const ok = await getRaw(base, { osName: 'q'.repeat(200) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.total, 0);
  });
});

test('⑥-b 운영 경로(queryNormalize 뒤)에서도 배열·객체 모양의 선택은 400 — 마지막 값으로 받거나 조용히 버리지 않는다(SP-01)', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(120));
  await withServer(async (base) => {
    const bads = [
      ['cpuBin[x]=18-19', 'cpuBin'], ['cpuBin%5Bx%5D=18-19', 'cpuBin'], ['cpuBin[=1', 'cpuBin'], ['osName[a]=Linux', 'osName'],
      ['power[__proto__]=on', 'power'], ['memBin[0]=1-2&memBin[1]=3-4', 'memBin'], ['cpuBin[]=bad&cpuBin[]=18-19', 'cpuBin'],
      ['cpuBin=bad&cpuBin=18-19', 'cpuBin'], ['cpuBin=18-19&cpuBin=bad', 'cpuBin'], ['cpuBin=1-2&cpuBin=3-4', 'cpuBin'],
      ['power=on&power=on', 'power'], ['osName=a&osName=a', 'osName'], ['memBin=&memBin=2-3', 'memBin'],
      // 여러 키가 틀리면 앞 키부터(cpuBin → memBin → power → osName) — 값 오류와 모양 오류를 같은 순서로 본다
      ['cpuBin=x&memBin=1-2&memBin=3-4', 'cpuBin'], ['cpuBin=1-2&memBin=0-1&memBin=2-3&power=x', 'memBin'], ['memBin=1-2&cpuBin[x]=3', 'cpuBin'],
      ['osName=a&osName=b&power=ON', 'power'],
    ];
    for (const [raw, field] of bads) {
      for (const extra of ['', '&paged=1', '&cursor=!!!not-a-cursor', '&dist=1']) {
        const r = await getRawQs(base, raw + extra);
        assert.equal(r.status, 400, `${raw}${extra} → ${r.status} ${r.text.slice(0, 120)}`);
        assert.deepEqual(r.body, { ok: false, error: 'bad-facet', reason: 'bad-facet', field }, `${raw}${extra}`);
      }
    }
    // 대조군 — 이름이 다른 키·예전 키의 중복은 예전 동작 그대로(200)
    for (const raw of ['cpuBin=18-19&dist=1', 'cpuBinX=1&cpuBin=18-19', 'xcpuBin=1', 'cpuBin.x=1', 'gpu=1&gpu=1', 'q=a&q=b', 'cpuBin', 'cpuBin=']) {
      const r = await getRawQs(base, raw);
      assert.equal(r.status, 200, `${raw} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    const one = await getRawQs(base, 'cpuBin=18-19');
    assert.deepEqual(one.body.facets, { cpuBin: '18-19' });
  });
});

test('⑥-c 200자를 넘는 Guest OS — 분포에 나온 이름을 화면처럼 다듬어 다시 보내면 그 줄의 개수가 나온다(RV-S1·C-02)', async () => {
  VM_PINS.clear();
  const mk = (guestOS, n, tag) => Array.from({ length: n }, (_, i) => ({
    id: `vc1:vm-${tag}-${i}`, vcenterId: 'vc1', name: `long-${tag}-${i}`, host: 'esx-0', powerState: 'POWERED_ON',
    cpuCount: 2, cpuUsagePct: 20, memUsagePct: 30, memMB: 2048, storageGB: 10, uncommittedGB: 1, guestOS,
  }));
  const rounds = [
    [...mk(LONG_OS.spaceAt199, 3, 'a'), ...mk(LONG_OS.surrAt199, 2, 'b'), ...mk(LONG_OS.spaceThenSurr, 4, 'c'), ...mk('Linux A 9', 1, 'd')],
    [...mk(LONG_OS.ideoAt199, 3, 'e'), ...mk(LONG_OS.loneHigh, 2, 'f'), ...mk(LONG_OS.loneLow, 1, 'g'), ...mk(LONG_OS.exact200, 5, 'h')],
  ];
  for (const vms of rounds) {
    SNAP = mkSnap(vms);
    await withServer(async (base) => {
      const d = (await getRaw(base, { dist: '1' })).body.dist;
      assert.equal(d.os.distinct, 4);
      assert.equal(d.os.top.length, 4);
      for (const row of d.os.top) {
        const sent = webCleanOs(row.name);
        assert.ok(sent, `화면이 보낼 수 없는 이름 ${JSON.stringify(row.name.slice(-6))}`);
        const r = await getRaw(base, { osName: sent, dist: '1' });
        assert.equal(r.status, 200, r.text.slice(0, 200));
        assert.equal(r.body.total, row.n, `이름 끝 ${JSON.stringify(row.name.slice(-4))} — 분포 ${row.n}대인데 고르면 ${r.body.total}대`);
        assert.equal(r.body.items.length, row.n);
        const picked = r.body.dist.os.top.filter((t) => t.selected);
        assert.equal(picked.length, 1, '고른 줄이 하나여야 한다(0대짜리 줄이 덧붙으면 같은 OS 가 두 줄)');
        assert.equal(picked[0].name, row.name);
        assert.equal(picked[0].n, row.n);
        assert.equal(r.body.dist.os.top.length, d.os.top.length, '덧붙은 줄이 없어야 한다');
        assert.equal(r.body.facets.osName, row.name, '정규화 메아리 = 분포 이름');
      }
    });
  }
});

/* ───────────────────────── ⑦ 커서 ───────────────────────── */
test('⑦ 패널 선택을 바꾸면 옛 커서는 400 cursor-query-mismatch', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(600));
  await withServer(async (base) => {
    for (const k of ['cpuBin', 'memBin', 'power', 'osName']) assert.ok(VM_FILTER_KEYS.includes(k), `VM_FILTER_KEYS 에 ${k}`);
    assert.ok(!VM_FILTER_KEYS.includes('dist'), 'dist 는 목록을 바꾸지 않는다');
    const p1 = await getRaw(base, { paged: '1', limit: '10', cpuBin: '0-19' });
    assert.ok(p1.body.nextCursor);
    const cur = p1.body.nextCursor;
    const variants = [{ cpuBin: '10-19' }, {}, { cpuBin: '0-19', memBin: 'na' }, { cpuBin: '0-19', power: 'on' }, { cpuBin: '0-19', osName: 'Rare OS' }];
    for (const v of variants) {
      const r = await getRaw(base, { ...v, limit: '10', cursor: cur });
      assert.equal(r.status, 400, JSON.stringify(v));
      assert.equal(r.body.reason, 'cursor-query-mismatch', JSON.stringify(v));
    }
    // 같은 선택이면 이어지고, dist 를 붙이거나 떼도 같은 목록이다
    for (const extra of [{}, { dist: '1' }]) {
      const ok = await getRaw(base, { cpuBin: '0-19', limit: '10', cursor: cur, ...extra });
      assert.equal(ok.status, 200, ok.text.slice(0, 200));
    }
    // 선택 없는 순회의 커서에 선택을 더해도 400
    const p0 = await getRaw(base, { paged: '1', limit: '10' });
    const r = await getRaw(base, { limit: '10', cursor: p0.body.nextCursor, power: 'on' });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'cursor-query-mismatch');
  });
});

/* ───────────────────────── ⑧ 범위 ───────────────────────── */
test('⑧ 범위 계정의 분포는 자기 vCenter 만 센다(요청 필터로 넓힐 수 없다)', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(600));
  await withServer(async (base) => {
    const mine = SNAP.vms.filter((v) => v.vcenterId === 'vc1');
    const s = await getRaw(base, { dist: '1' }, 'scoped');
    assert.equal(s.body.dist.total, mine.length);
    assert.equal(s.body.dist.power.on + s.body.dist.power.off + s.body.dist.power.suspended + s.body.dist.power.other, mine.length);
    const exp = vmDistribution(mine, selOf({}));
    assert.ok(isDeepStrictEqual(s.body.dist, exp), '범위 계정 분포 = 자기 vCenter VM 만으로 계산한 분포');
    const wide = await getRaw(base, { dist: '1', vcenterId: 'vc2' }, 'scoped');
    assert.equal(wide.body.dist.total, 0);
    assert.equal(wide.body.dist.os.distinct, 0);
    const a = await getRaw(base, { dist: '1' });
    assert.equal(a.body.dist.total, SNAP.vms.length);
  });
});

/* ───────────────────────── ⑨ 성능 ───────────────────────── */
test('⑨ 성능 — VM 6,000 한 번 계산이 수 ms(넉넉한 상한) · 4배 입력에 시간이 대략 선형', () => {
  const v6 = mkVms(6000, { vcs: 30 });
  const v24 = mkVms(24000, { vcs: 30 });
  const sel = selOf({ cpuBin: '15-19', memBin: '0-14', osName: 'Linux A 9' });
  const timeOf = (vms) => {
    const xs = [];
    for (let k = 0; k < 7; k++) { const t0 = process.hrtime.bigint(); vmDistribution(vms, sel); xs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    xs.sort((a, b) => a - b);
    return xs[3];
  };
  vmDistribution(v6, sel); // 예열
  const t6 = timeOf(v6);
  const t24 = timeOf(v24);
  assert.ok(t6 < 150, `6,000개 계산 ${t6.toFixed(2)}ms — 수 ms 여야 한다`);
  // 선형이면 약 4배, 제곱이면 약 16배. 잡음을 감안해 10배 아래면 통과
  assert.ok(t24 < Math.max(10 * t6, 40), `24,000개 ${t24.toFixed(2)}ms vs 6,000개 ${t6.toFixed(2)}ms — 선형이 아니다`);
  const ft0 = process.hrtime.bigint();
  filterVmsByFacets(v6, sel);
  assert.ok(Number(process.hrtime.bigint() - ft0) / 1e6 < 150);
});
