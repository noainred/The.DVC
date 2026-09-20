/**
 * test/invCheck2570.test.js — '포탈 점검 › 인벤토리 점검'(v2.570) 회귀.
 *
 * 사용자 요청(2026-09-20): 에이전트 수신 트래픽 진단 표의 '최근 페이로드 —' 를 보고
 * "여기서 수집되는 데이터가 없으면 어떤 문제가 발생하는지 확인하고 오류를 점검하려면
 * 어떻게 해야 하는지" → "점검할 수 있는 기능 만들어줘".
 *
 * 이 테스트가 고정하는 정직성 불변조건:
 *  · `stale`(낡음) 이 `ok` 와 같은 색으로 보이지 않는다 — KPI 항등식이 갈라 낸다
 *  · '안 보냈다'(never) 와 '보냈는데 막혔다'(rejected) 가 **다른 상태**로 분리된다
 *  · 거부 판정 순서 — 거부가 마지막 수신보다 뒤일 때만 rejected(과거 거부로 낡음을 가리지 않는다)
 *  · '인벤토리를 안 보낸 엣지' 발견은 그 엣지가 **위임 담당으로 학습된 적이 있을 때만** 뜬다
 *  · 발견 코드 ↔ INV_FINDING 상수 1:1
 *  · ingestReject 의 이름은 unverified 로 표시되고, 상한이 걸린다
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanInventory, kpisOf, findingsOf, groupFindings, findingCounts,
  INV_STATE, INV_FINDING, INV_GRADE,
} from '../src/portalcheck/invScan.js';
import { recordReject, rejectStats, rejectKindOf, resetRejects, REJECT_KIND } from '../src/central/ingestReject.js';

const NOW = 1_800_000_000_000; // 고정 시각(v2.517 규약 — Date.now() 를 기준으로 쓰지 않는다)

test.beforeEach(() => resetRejects());

/* ── 1. 상태 판정 ──────────────────────────────────────────────────────── */

test('신선한 수신은 ok, 기준 초과는 stale — 값이 같아도 age 로 갈린다', () => {
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'site' }, { id: 'vc2', name: 'B', collectMode: 'site' }];
  const inventory = [
    { vcenterId: 'vc1', agent: 'edge-a', at: NOW - 60_000, hosts: 5, vms: 10 },
    { vcenterId: 'vc2', agent: 'edge-b', at: NOW - 400_000, hosts: 5, vms: 10 },
  ];
  const scan = scanInventory({ vcenters, inventory, now: NOW, staleMs: 300_000 });
  assert.equal(scan.rows.find((r) => r.vcenterId === 'vc1').state, INV_STATE.OK);
  assert.equal(scan.rows.find((r) => r.vcenterId === 'vc2').state, INV_STATE.STALE);
});

test('한 번도 push 가 없으면 never — 0 을 지어내지 않는다', () => {
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'site' }];
  const scan = scanInventory({ vcenters, inventory: [], now: NOW });
  const r = scan.rows[0];
  assert.equal(r.state, INV_STATE.NEVER);
  assert.equal(r.lastAt, null);
  assert.equal(r.hosts, null); // 0 이 아니라 null — '호스트 0대' 라는 거짓을 만들지 않는다
});

test('direct(중앙 직접 수집) vCenter 는 대상에서 빠진다', () => {
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'direct' }, { id: 'vc2', name: 'B', collectMode: 'site' }];
  const scan = scanInventory({ vcenters, now: NOW });
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0].vcenterId, 'vc2');
  assert.equal(scan.vcenterCount, 2);
});

/* ── 2. 거부 판정 순서 — 이 모듈의 핵심 결함 수정 ────────────────────────────── */

test('거부가 마지막 수신보다 뒤면 rejected — never/stale 보다 우선한다', () => {
  // ⚠ recordReject 는 순수 함수가 아니라 실제 Date.now() 를 시각으로 찍는 계측기다(감사 목적상
  //   의도된 설계 — ingestStats.js 와 같은 성격). 그래서 이 테스트만은 실제 시간축을 쓴다.
  const real = Date.now();
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'site' }];
  const inventory = [{ vcenterId: 'vc1', agent: 'edge-a', at: real - 400_000, hosts: 5, vms: 10 }]; // stale 감
  recordReject('edge-a', '/inventory', { status: 400, kind: REJECT_KIND.MOCK, reason: 'mock 데이터', vcenterId: 'vc1' });
  const rejects = rejectStats();
  // 거부(recordReject 가 방금 찍은 real 근처 시각)가 마지막 수신(real-400_000)보다 뒤다.
  const scan = scanInventory({ vcenters, inventory, rejects, now: real + 1000 });
  assert.equal(scan.rows[0].state, INV_STATE.REJECTED, '낡음보다 거부가 우선해야 원인을 안내한다');
  assert.equal(scan.rows[0].reject.kind, REJECT_KIND.MOCK);
});

test('거부가 마지막 수신보다 앞(이미 해소됨)이면 상태에 반영하지 않는다', () => {
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'site' }];
  recordReject('edge-a', '/inventory', { status: 403, kind: REJECT_KIND.AUTH, reason: '토큰 불일치', vcenterId: 'vc1' });
  const rejects = rejectStats();
  const inventory = [{ vcenterId: 'vc1', agent: 'edge-a', at: Date.now() + 5000, hosts: 5, vms: 10 }]; // 거부 이후 성공
  const scan = scanInventory({ vcenters, inventory, rejects, now: Date.now() + 5000 });
  assert.equal(scan.rows[0].state, INV_STATE.OK, '해소된 과거 거부로 정상 수신을 가리면 안 된다');
});

test('거부 종류(mock/owner/auth)가 다른 finding 코드로 갈린다', () => {
  for (const [kind, code] of [[REJECT_KIND.MOCK, INV_FINDING.REJECT_MOCK], [REJECT_KIND.OWNER, INV_FINDING.REJECT_OWNER], [REJECT_KIND.AUTH, INV_FINDING.REJECT_AUTH]]) {
    resetRejects();
    recordReject('edge-x', '/inventory', { status: 400, kind, reason: 'r', vcenterId: 'vcx' });
    const scan = scanInventory({ vcenters: [{ id: 'vcx', name: 'X', collectMode: 'site' }], rejects: rejectStats(), now: Date.now() + 1000 });
    const f = findingsOf(scan).find((x) => x.target === 'vcx');
    assert.equal(f.code, code, `kind=${kind} 이면 code=${code} 여야 한다`);
  }
});

/* ── 3. 엣지 축 — '인벤토리를 안 보낸다' 오탐 방지 ──────────────────────────── */

test('위임 담당으로 학습된 적 없는 엣지는 인벤토리 미전송을 결함으로 세지 않는다', () => {
  // storage-only 엣지처럼 인벤토리를 아예 다루지 않는 정상 구성.
  const ingestRows = [{ agent: 'storage-only', pushes: 100, wireBytes: 1000, lastAt: NOW, last: { endpoint: '/storage-data' } }];
  const scan = scanInventory({ vcenters: [], ingestRows, now: NOW });
  assert.equal(scan.agents[0].sentInventory, false);
  assert.equal(scan.agents[0].knownOwner, false);
  const findings = findingsOf(scan);
  assert.ok(!findings.some((f) => f.code === INV_FINDING.AGENT_NO_INVENTORY), '위임 담당이 아닌 엣지를 결함으로 세면 정상 구성을 결함이라 말하는 것이다');
});

test('위임 담당으로 학습됐는데 인벤토리를 안 보내면 결함이다', () => {
  const vcenters = [{ id: 'vc1', name: 'A', collectMode: 'site' }];
  const inventory = [{ vcenterId: 'vc1', agent: 'edge-a', at: NOW - 60_000, hosts: 5, vms: 10 }];
  const ingestRows = [{ agent: 'edge-a', pushes: 50, wireBytes: 1000, lastAt: NOW, last: { endpoint: '/svcmon-report' } }]; // 최근엔 다른 것만
  const scan = scanInventory({ vcenters, inventory, ingestRows, now: NOW });
  const agentRow = scan.agents.find((a) => a.agent === 'edge-a');
  assert.equal(agentRow.knownOwner, true);
  assert.equal(agentRow.sentInventory, false); // 최근 push 는 인벤토리가 아니다
  assert.ok(findingsOf(scan).some((f) => f.code === INV_FINDING.AGENT_NO_INVENTORY && f.target === 'edge-a'));
});

test('mock 데이터를 자기보고한 엣지는 항상 결함이다(담당 여부 무관)', () => {
  const identity = { byAgent: { 'edge-m': { mock: true } }, vcenterConflicts: [] };
  const ingestRows = [{ agent: 'edge-m', pushes: 1, wireBytes: 10, lastAt: NOW, last: null }];
  const scan = scanInventory({ vcenters: [], ingestRows, identity, now: NOW });
  assert.equal(scan.agents[0].mockReported, true);
  assert.ok(findingsOf(scan).some((f) => f.code === INV_FINDING.AGENT_MOCK));
});

/* ── 4. KPI 항등식 ─────────────────────────────────────────────────────── */

test('KPI 합계 = ok+stale+never+rejected+unknown, emptyPush 는 별도 축', () => {
  const vcenters = [
    { id: 'v1', name: 'ok', collectMode: 'site' },
    { id: 'v2', name: 'stale', collectMode: 'site' },
    { id: 'v3', name: 'never', collectMode: 'site' },
    { id: 'v4', name: 'empty', collectMode: 'site' },
  ];
  const inventory = [
    { vcenterId: 'v1', agent: 'a', at: NOW - 1000, hosts: 5, vms: 5 },
    { vcenterId: 'v2', agent: 'b', at: NOW - 999_999, hosts: 5, vms: 5 },
    { vcenterId: 'v4', agent: 'c', at: NOW - 1000, hosts: 0, vms: 0 }, // 정상 수신인데 빈 vCenter
  ];
  const scan = scanInventory({ vcenters, inventory, now: NOW });
  const k = scan.kpis;
  assert.equal(k.total, 4);
  assert.equal(k.ok + k.stale + k.never + k.rejected + k.unknown, k.total);
  assert.equal(k.emptyPush, 1, 'emptyPush 는 상태와 별도 축이다');
  assert.equal(k.ok, 2); // v1, v4 둘 다 신선 — 내용이 비어도 수신 자체는 정상
});

test('신선율 분모는 measured(ok+stale) — never 를 분모에 넣지 않는다', () => {
  const vcenters = [{ id: 'v1', name: 'a', collectMode: 'site' }, { id: 'v2', name: 'b', collectMode: 'site' }];
  const inventory = [{ vcenterId: 'v1', agent: 'a', at: NOW - 1000, hosts: 1, vms: 1 }];
  const scan = scanInventory({ vcenters, inventory, now: NOW });
  assert.equal(scan.kpis.measured, 1);
  assert.equal(scan.kpis.freshPct, 100);
});

test('measured 0 이면 freshPct 는 null(0% 가 아니다)', () => {
  const scan = scanInventory({ vcenters: [{ id: 'v1', name: 'a', collectMode: 'site' }], now: NOW });
  assert.equal(scan.kpis.measured, 0);
  assert.equal(scan.kpis.freshPct, null);
});

/* ── 5. 발견 코드 ↔ 상수 1:1, 묶기 ────────────────────────────────────────── */

test('findingsOf 가 내는 모든 code 는 INV_FINDING 에 선언돼 있다', () => {
  const vcenters = [{ id: 'v1', name: 'a', collectMode: 'site' }];
  recordReject('e', '/inventory', { status: 400, kind: REJECT_KIND.OTHER, reason: 'r', vcenterId: 'v1' });
  const scan = scanInventory({ vcenters, rejects: rejectStats(), ingestRows: [{ agent: 'e', pushes: 1, wireBytes: 1, lastAt: NOW, last: null }], now: Date.now() + 1000 });
  const declared = new Set(Object.values(INV_FINDING));
  for (const f of findingsOf(scan)) assert.ok(declared.has(f.code), `선언되지 않은 code: ${f.code}`);
});

test('groupFindings 는 같은 코드를 묶고 개수·대상 목록을 남긴다(v2.509 규약)', () => {
  const vcenters = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, name: `n${i}`, collectMode: 'site' }));
  const scan = scanInventory({ vcenters, now: NOW }); // 전부 never
  const findings = findingsOf(scan);
  const groups = groupFindings(findings);
  const neverGroup = groups.find((g) => g.code === INV_FINDING.NEVER);
  assert.equal(neverGroup.count, 5);
  assert.equal(neverGroup.targets.length, 5);
});

test('findingCounts 는 fault/warn/info 만 갖고 grade 밖 값은 세지 않는다', () => {
  const c = findingCounts([{ grade: INV_GRADE.FAULT }, { grade: INV_GRADE.WARN }, { grade: INV_GRADE.WARN }]);
  assert.deepEqual(c, { fault: 1, warn: 2, info: 0 });
});

/* ── 6. ingestReject 자체 — 미검증 이름·상한 ─────────────────────────────── */

test('rejectStats 는 unverified:true 를 항상 낸다 — agent 이름이 위조됐을 수 있다', () => {
  recordReject('공격자가-고른-이름', '/inventory', { status: 403, kind: REJECT_KIND.AUTH, reason: 'x' });
  const s = rejectStats();
  assert.equal(s.unverified, true);
});

test('rejectKindOf 는 힌트를 우선하고, 없으면 상태코드로 추정한다', () => {
  assert.equal(rejectKindOf(403, ''), REJECT_KIND.AUTH);
  assert.equal(rejectKindOf(404, ''), REJECT_KIND.DISABLED);
  assert.equal(rejectKindOf(500, ''), REJECT_KIND.SERVER);
  assert.equal(rejectKindOf(400, ''), REJECT_KIND.BAD);
  assert.equal(rejectKindOf(400, REJECT_KIND.MOCK), REJECT_KIND.MOCK, '힌트가 상태코드 추정보다 우선한다');
});

test('recordReject 는 원문 사유를 300자로 자른다(SSH 추적·스택 방지 — activityLog 와 같은 상한)', () => {
  recordReject('e', '/inventory', { status: 400, kind: REJECT_KIND.BAD, reason: 'x'.repeat(500) });
  const row = rejectStats().rows.find((r) => r.agent === 'e');
  assert.equal(row.lastReason.length, 300);
});

test('resetRejects 후에는 완전히 빈다', () => {
  recordReject('e', '/inventory', { status: 403, kind: REJECT_KIND.AUTH });
  resetRejects();
  const s = rejectStats();
  assert.equal(s.total, 0);
  assert.deepEqual(s.rows, []);
  assert.deepEqual(s.recent, []);
});
