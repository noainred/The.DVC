/**
 * M1 후속 회귀 방지 — IPAM 조회 빌더에 사용자 scope(allowed) 강제.
 *  - allowed=null(무제한): 기존 동작 보존(전 vCenter 행).
 *  - allowed=Set: 범위 밖 vCenter 행·conflictVcenters·수동/스캔 미귀속 행 제외.
 *  - 캐시 격리: null 먼저 조회해도 Set 조회가 절단본을 받는다(캐시 키 scope 서명).
 *  - syncLedger 경로(무인자)는 무스코프 유지(외부 공유 ipam.db 온전).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiSource } from './lib/apiSource.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-scope-'));

const ledger = await import('../src/ipam/ledger.js');
const { buildIpamRows, ipVcenterOwners } = ledger;
const { buildIpamInsights } = await import('../src/ipam/insights.js');

const SNAP = {
  generatedAt: 'T0',
  vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
  vms: [
    { id: 'vc-a:1', name: 'a-vm1', vcenterId: 'vc-a', ipAddress: '10.1.0.1', powerState: 'POWERED_ON', guestOS: 'Linux' },
    { id: 'vc-b:1', name: 'b-vm1', vcenterId: 'vc-b', ipAddress: '10.2.0.1', powerState: 'POWERED_ON', guestOS: 'Windows' },
    // 같은 IP 를 두 vCenter 가 주장 → conflict (vc-a 관점에서 vc-b id 가 새면 안 됨)
    { id: 'vc-a:2', name: 'a-dup', vcenterId: 'vc-a', ipAddress: '10.9.9.9', powerState: 'POWERED_ON', guestOS: 'Linux' },
    { id: 'vc-b:2', name: 'b-dup', vcenterId: 'vc-b', ipAddress: '10.9.9.9', powerState: 'POWERED_ON', guestOS: 'Windows' },
  ],
  hosts: [],
};

const ipsOf = (rows) => rows.map((r) => r.ip).sort();

test('M1-IPAM: allowed=null 은 전 vCenter 행(기존 동작 보존)', () => {
  const { rows } = buildIpamRows(SNAP, '', null);
  const ips = new Set(rows.map((r) => r.ip));
  assert.ok(ips.has('10.1.0.1') && ips.has('10.2.0.1'), '두 vCenter IP 모두 포함');
});

test('M1-IPAM: allowed=Set(vc-a) 는 vc-b 행 제외', () => {
  const { rows } = buildIpamRows(SNAP, '', new Set(['vc-a']));
  assert.ok(!rows.some((r) => r.vcenterId === 'vc-b'), 'vc-b 행 없음');
  assert.ok(rows.some((r) => r.ip === '10.1.0.1'), 'vc-a 행 유지');
  assert.ok(!rows.some((r) => r.ip === '10.2.0.1'), 'vc-b IP 미노출');
});

test('M1-IPAM: conflictVcenters 에 범위 밖 vCenter id 가 새지 않는다', () => {
  const full = buildIpamRows(SNAP, '', null).rows.find((r) => r.ip === '10.9.9.9');
  assert.deepEqual([...(full.conflictVcenters || [])].sort(), ['vc-a', 'vc-b'], '무제한은 둘 다 충돌');
  const scoped = buildIpamRows(SNAP, '', new Set(['vc-a'])).rows.find((r) => r.ip === '10.9.9.9');
  // 범위 제한: vc-a 행만 남고, conflictVcenters 에 vc-b 가 없어야 한다(유출 차단).
  assert.ok(!(scoped.conflictVcenters || []).includes('vc-b'), 'vc-b 가 conflictVcenters 에 없어야 함');
});

test('M1-IPAM: 캐시 격리 — null 먼저 조회해도 Set 조회가 절단본을 받는다', () => {
  buildIpamRows(SNAP, '', null);                       // 전체를 먼저 캐시
  const scoped = buildIpamRows(SNAP, '', new Set(['vc-a'])).rows;
  assert.ok(!scoped.some((r) => r.vcenterId === 'vc-b'), '캐시 교차로 vc-b 가 새면 안 됨');
});

test('M1-IPAM: buildIpamInsights 도 allowed 를 존중', () => {
  const scoped = buildIpamInsights(SNAP, '', new Set(['vc-a']));
  // insights 는 rows 파생 집계 — vc-b IP(10.2.0.1)가 어떤 목록에도 안 나와야 한다.
  const blob = JSON.stringify(scoped);
  assert.ok(!blob.includes('10.2.0.1'), 'vc-b IP 가 insights 에 노출되면 안 됨');
});

test('M1-IPAM: syncLedger 경로(무인자)는 무스코프 — 외부 공유 원장 온전', () => {
  const { rows } = buildIpamRows(SNAP);   // allowed 미전달 = null = 전체
  const ips = new Set(rows.map((r) => r.ip));
  assert.ok(ips.has('10.1.0.1') && ips.has('10.2.0.1'), '외부 리더용 원장은 전 vCenter 포함');
});

/* M2-B 정적 검증: gpu-guest-data 엣지 간 쓰기 소유권 (콜론 포함 vc.id 안전) */
test('M2-B 정적: /gpu-guest-data 가 최장 프리픽스 매칭으로 소유권 판정(콜론 vc.id 오파싱 방지)', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const i = src.indexOf("centralRouter.post('/gpu-guest-data'");
  const body = src.slice(i, src.indexOf('centralRouter.get', i));
  assert.match(body, /req\.centralAuth\.mode === 'agent'/);
  assert.match(body, /listInventory\(\)/);
  assert.match(body, /\.startsWith\(/);   // 최장 프리픽스 매칭
  assert.match(body, /e\.vc\.length > best/);   // 최장 프리픽스 선택
  assert.ok(!/split\(':'\)\[0\]/.test(body), 'split(:)[0] 오파싱 방식은 제거되어야 함');
});

/* 적대적 검증(wf_e76670be)이 찾은 스캔 데이터 형제 누락 회귀 방지 */
test('M1-scan 정적: scan-report.csv·ipam/history 가 범위 제한 계정에 스캔을 노출하지 않음', () => {
  const src = readApiSource(); // v2.283.0 분할 — api.js + routes/api/* 결합 소스 검사
  const csv = src.slice(src.indexOf("api.get('/tools/ipam/scan-report.csv'"), src.indexOf("api.get('/tools/ipam/scan-report.csv'") + 900);
  assert.match(csv, /scopedVcenterIds\(req\.user/);
  const hist = src.slice(src.indexOf("api.get('/tools/ipam/history'"), src.indexOf("api.get('/tools/ipam/history'") + 500);
  assert.match(hist, /scopedVcenterIds\(req\.user/);
  assert.match(hist, /history: null/);
});

/* ── ① IPAM 쓰기 scope (v2.257 후속) ── */

test('WR1 ipVcenterOwners: IP → 소유 vCenter Set(전체, unscoped)', () => {
  const owners = ipVcenterOwners(SNAP);
  assert.deepEqual([...(owners.get('10.1.0.1') || [])], ['vc-a']);
  assert.deepEqual([...(owners.get('10.2.0.1') || [])], ['vc-b']);
  // 충돌 IP 는 두 vCenter 모두(쓰기 판정은 전체 소유를 본 뒤 allowed 와 교집합해야 하므로)
  assert.deepEqual([...(owners.get('10.9.9.9') || [])].sort(), ['vc-a', 'vc-b']);
});

test('WR2 쓰기 scope 모델: 범위 밖 IP 차단·미귀속은 claimed 필수', () => {
  // 라우트 로컬 헬퍼 ipInWriteScope 와 동일 로직(회귀 기준). allowed=null 은 항상 통과.
  const owners = ipVcenterOwners(SNAP);
  const inScope = (allowed, ip, claimed) => {
    if (!allowed) return true;
    const own = owners.get(ip);
    if (own && own.size) return [...own].some((v) => allowed.has(v));
    return claimed ? allowed.has(claimed) : false;
  };
  const A = new Set(['vc-a']);
  assert.equal(inScope(null, '10.2.0.1', ''), true, '무제한은 항상 통과');
  assert.equal(inScope(A, '10.1.0.1', ''), true, 'vc-a IP 허용');
  assert.equal(inScope(A, '10.2.0.1', ''), false, 'vc-b IP 차단');
  assert.equal(inScope(A, '10.9.9.9', ''), true, '충돌 IP 는 vc-a 포함이라 허용');
  assert.equal(inScope(A, '10.55.0.1', ''), false, '미귀속 IP + claimed 없음 → 차단');
  assert.equal(inScope(A, '10.55.0.1', 'vc-a'), true, '미귀속 IP + claimed=vc-a → 허용');
  assert.equal(inScope(A, '10.55.0.1', 'vc-b'), false, '미귀속 IP + claimed=vc-b → 차단');
});

test('WR3 정적: IPAM 쓰기 7라우트가 scope 가드를 건다', async () => {
  const src = readApiSource(); // v2.283.0 분할 — api.js + routes/api/* 결합 소스 검사
  for (const anchor of [
    "api.put('/tools/ipam/annotation'", "api.put('/tools/ipam/ip/:ip'", "api.delete('/tools/ipam/ip/:ip'",
    "api.post('/tools/ipam/bulk'", "api.post('/tools/ipam/policies'", "api.put('/tools/ipam/policies/:id'", "api.delete('/tools/ipam/policies/:id'",
  ]) {
    const i = src.indexOf(anchor);
    assert.ok(i >= 0, `${anchor} 존재`);
    const body = src.slice(i, i + 600);
    assert.match(body, /scopedVcenterIds\(req\.user/, `${anchor} 에 scope 가드 필요`);
  }
});

test('WR5 정적: IPAM 읽기 형제(GET /ip/:ip·/policies summary·manage-meta)도 scope', () => {
  const src = readApiSource(); // v2.283.0 분할 — api.js + routes/api/* 결합 소스 검사
  // GET /ip/:ip — override 읽기 scope 가드(적대적 검증 wf_23fac1ba 확정 결함)
  const ipGet = src.slice(src.indexOf("api.get('/tools/ipam/ip/:ip'"), src.indexOf("api.get('/tools/ipam/ip/:ip'") + 500);
  assert.match(ipGet, /scopedVcenterIds\(req\.user/);
  assert.match(ipGet, /ipInWriteScope/);
  // GET /policies — summary 도 스코프된 목록으로 재계산(byVcenter 열거 차단)
  const polGet = src.slice(src.indexOf("api.get('/tools/ipam/policies'"), src.indexOf("api.get('/tools/ipam/policies'") + 500);
  assert.match(polGet, /policiesSummary\(allowed \? policies : null\)/);
  // manage-meta — policiesSummary·overridesSummary 둘 다 스코프
  const mm = src.slice(src.indexOf("api.get('/tools/ipam/manage-meta'"), src.indexOf("api.get('/tools/ipam/manage-meta'") + 800);
  assert.match(mm, /policiesSummary\(polList\)/);
  assert.match(mm, /overridesSummary\(ovInclude\)/);
});

test('WR6 policiesSummary(list) 오버로드: 주어진 목록만 집계(byVcenter 열거 차단)', async () => {
  const { policiesSummary } = await import('../src/ipam/rangePolicies.js');
  const scoped = policiesSummary([{ status: 'reserved', claimedVcenterId: 'vc-a', enabled: true, specSize: 4 }]);
  assert.deepEqual(Object.keys(scoped.byVcenter), ['vc-a'], '주어진 목록의 vCenter 만');
  assert.equal(scoped.total, 1);
});

test('WR7 overridesSummary(includeFn): 필터 통과분만 집계(범위 밖 override 총계 차단 — 3차 검증 확정)', async () => {
  const ov = await import('../src/ipam/overrides.js');
  // includeFn 미지정 = 전체(admin 보존), includeFn 지정 = 통과분만. 저장소 부작용 없이 콜백 계약만 검증.
  assert.equal(typeof ov.overridesSummary, 'function');
  const full = ov.overridesSummary();
  const none = ov.overridesSummary(() => false);
  assert.equal(none.total, 0, 'includeFn 이 전부 false 면 집계 0');
  assert.ok(full.total >= none.total, '무필터 총계 ≥ 필터 총계');
  const src = readApiSource(); // v2.283.0 분할 — api.js + routes/api/* 결합 소스 검사
  const mm = src.slice(src.indexOf("api.get('/tools/ipam/manage-meta'"), src.indexOf("api.get('/tools/ipam/manage-meta'") + 700);
  assert.match(mm, /overridesSummary\(ovInclude\)/, 'manage-meta 가 스코프된 override 집계를 넘겨야 함');
});

test('WR4 정적: direct-mode vCenter GPU 쓰기 봉인(central)', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const i = src.indexOf("centralRouter.post('/gpu-guest-data'");
  const body = src.slice(i, src.indexOf('centralRouter.get', i));
  assert.match(body, /loadVcenterConfig\(\)/);
  assert.match(body, /collectMode/);
  assert.match(body, /directIds/);
  assert.match(body, /if \(direct\) return false/);
});
