/**
 * dbg3221 2회차 — Hypervisor 분석 집계(vcenter/hostInsight.js) 결함 회귀:
 *  ① 예기치 않은 재부팅 ‘모름’(rebootsUnread)은 판정하지 못한 호스트만 — no-events(readCut 포함) · bootTime 못 읽음 · 끊김.
 *     기간 안 재부팅이 없는 정상 호스트(analyzeReboots 행 없음 → boot null)는 0(예전: 정상 호스트를 전부 ‘모름’ 으로 셌고 no-events 는 뺐다).
 *  ② 클러스터 지도 칸 down = 끊김 · 무응답만(platformSummary.hostsSection 과 같은 판정) — 사용률 못 읽음은 usageUnknown 으로만.
 * 실제 analyzeReboots → hostChecksOf → hostInsightOf 경로를 탄다(운영 라우트와 같은 순서).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostInsightOf } from '../src/vcenter/hostInsight.js';
import { hostChecksOf } from '../src/vcenter/hostChecks.js';
import { analyzeReboots } from '../src/hostcfg/reboots.js';
import { hostsSection } from '../src/inventory/platformSummary.js';

const HOUR = 3_600_000;
const D = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정
const readable = (h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING';
const capKnown = (h) => Number.isFinite(h.cpuCores) && h.cpuCores > 0 && Number.isFinite(h.memTotalMB) && h.memTotalMB > 0;
const H = (id, o = {}) => ({ id: `vc1:${id}`, name: id, vcenterId: 'vc1', cluster: 'CL', clusterRef: 'domain-CL', connectionState: 'CONNECTED',
  cpuUsagePct: 40, memUsagePct: 50, cpuCores: 32, memTotalMB: 262144, ...o });
const VCS = [{ id: 'vc1', name: 'A', status: 'connected' }];

async function insightWithReboots(hosts, { events = [], coverageOf = () => null, readFrom = null } = {}) {
  const r = analyzeReboots(hosts, events, { now: NOW, days: 30, coverageOf, readFrom });
  const reboots = new Map(r.rows.map((x) => [x.id, x]));
  const checks = hostChecksOf(hosts, { access: { hygiene: true, hw: false }, reboots, now: NOW });
  const out = await hostInsightOf({ vcenters: VCS, hosts, vms: [], readable, capKnown, access: { cluster: false }, checks, now: NOW, bootDays: 30 });
  return { r, row: out.rows[0] };
}

test('① 정상(기간 안 재부팅 없음) 3대 + 이벤트 못 받음 1대 → 모름 1(예전: 3)', async () => {
  const hosts = [H('h1', { bootTime: NOW - 200 * D }), H('h2', { bootTime: NOW - 300 * D }), H('h3', { bootTime: NOW - 120 * D }), H('h4', { bootTime: NOW - 10 * D })];
  const { r, row } = await insightWithReboots(hosts);
  assert.deepEqual(r.rows.map((x) => `${x.name}:${x.kind}`), ['h4:no-events']);
  assert.equal(row.reboots30d, 0);
  assert.equal(row.rebootsUnread, 1, '모름 = 판정하지 못한 h4 하나 · 정상 h1~h3 은 0');
  assert.equal(row.rebootsUnread, r.counts['no-events'] + r.bootUnknown, 'ESXi 구성 점검(analyzeReboots)의 no-events + bootUnknown 과 같은 뜻');
});

test('① bootTime 못 읽음 · 끊김은 모름 · 예기치 않은 재부팅은 그 칸 · 계획 재부팅 · unknown 판정은 모름이 아니다', async () => {
  const boot = NOW - 5 * D;
  const hosts = [
    H('ok', { bootTime: NOW - 90 * D }),
    H('nob', { bootTime: null }),
    H('disc', { connectionState: 'DISCONNECTED', bootTime: NOW - 90 * D, cpuUsagePct: null, memUsagePct: null }),
    H('unexp', { bootTime: boot }),
    H('plan', { bootTime: boot }),
    H('quiet', { bootTime: boot }),
  ];
  const events = [
    { vcenterId: 'vc1', entity: 'unexp', type: 'HostConnectionLostEvent', ts: boot - HOUR },
    { vcenterId: 'vc1', entity: 'plan', type: 'EnteredMaintenanceModeEvent', ts: boot - 2 * HOUR },
  ];
  const coverageOf = () => ({ firstTs: NOW - 60 * D, lastTs: NOW });
  const { r, row } = await insightWithReboots(hosts, { events, coverageOf });
  assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.name, x.kind])), { unexp: 'unexpected', plan: 'planned', quiet: 'unknown' });
  assert.equal(row.reboots30d, 1);
  assert.equal(row.rebootsUnread, 2, 'bootTime 못 읽음(nob) + 끊김(disc) — 정상 · 계획 · unknown 판정은 세지 않는다');
});

test('① 이벤트 읽기가 상한에서 잘려 no-events(readCut)가 된 호스트도 모름', async () => {
  const boot = NOW - 3 * D;
  const hosts = [H('cut', { bootTime: boot }), H('ok', { bootTime: NOW - 90 * D })];
  const coverageOf = () => ({ firstTs: NOW - 60 * D, lastTs: NOW });
  const { r, row } = await insightWithReboots(hosts, { coverageOf, readFrom: boot });
  assert.equal(r.rows[0].kind, 'no-events'); assert.equal(r.rows[0].readCut, true);
  assert.equal(row.rebootsUnread, 1);
});

test('② 지도 칸 down = 끊김 · 무응답만 — 연결됐는데 사용률을 못 읽은 호스트는 usageUnknown 으로만', async () => {
  const hosts = [H('h1'), H('h2'), H('h3', { cpuUsagePct: null }), H('h4', { connectionState: 'MAINTENANCE' })];
  const out = await hostInsightOf({ vcenters: VCS, hosts, vms: [], readable, capKnown, access: { cluster: false } });
  const row = out.rows[0]; const c = out.clusters[0];
  assert.equal(row.hosts.down, 0);
  assert.equal(c.down, 0, '끊긴 호스트가 없다(예전: 1 — 사용률 못 읽음을 끊김으로 셌다)');
  assert.equal(c.usageUnknown, 1);
  assert.equal(c.connected + c.maint + c.down <= c.hosts, true);
});

test('② 끊김 · 무응답은 칸 down 에 — 법인 줄 hosts.down(hostsSection)과 같은 수 · 독립 호스트 칸도 같다', async () => {
  const hosts = [
    H('h1'), H('h2', { connectionState: 'DISCONNECTED', cpuUsagePct: null }), H('h3', { connectionState: 'NOT_RESPONDING' }), H('h4', { cpuUsagePct: null }),
    H('s1', { cluster: null, clusterRef: null, connectionState: 'NOT_RESPONDING' }), H('s2', { cluster: null, clusterRef: null, cpuUsagePct: null }),
  ];
  const out = await hostInsightOf({ vcenters: VCS, hosts, vms: [], readable, capKnown, access: { cluster: false } });
  const row = out.rows[0];
  const cl = out.clusters.find((x) => !x.standalone); const st = out.clusters.find((x) => x.standalone);
  assert.ok(cl && st);
  assert.equal(cl.down, 2); assert.equal(st.down, 1);
  assert.equal(cl.down + st.down, row.hosts.down);
  assert.equal(row.hosts.down, hostsSection(hosts, readable).down);
  assert.equal(cl.usageUnknown, 3, '사용률 모름은 끊김 · 무응답 · 못 읽음을 다 센다(평균 · 칸 밖 — 법인 줄 usageUnknown 과 같은 뜻)');
});
