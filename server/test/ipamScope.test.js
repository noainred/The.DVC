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

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-scope-'));

const { buildIpamRows, buildIpamInsights } = await import('../src/ipam/ledger.js').then(async (m) => ({
  buildIpamRows: m.buildIpamRows,
  buildIpamInsights: (await import('../src/ipam/insights.js')).buildIpamInsights,
}));

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
  const src = fs.readFileSync(new URL('../src/routes/api.js', import.meta.url), 'utf8');
  const csv = src.slice(src.indexOf("api.get('/tools/ipam/scan-report.csv'"), src.indexOf("api.get('/tools/ipam/scan-report.csv'") + 900);
  assert.match(csv, /scopedVcenterIds\(req\.user/);
  const hist = src.slice(src.indexOf("api.get('/tools/ipam/history'"), src.indexOf("api.get('/tools/ipam/history'") + 500);
  assert.match(hist, /scopedVcenterIds\(req\.user/);
  assert.match(hist, /history: null/);
});
