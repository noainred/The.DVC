/**
 * mock/demo/edgeSeed.js — 데모(DATA_SOURCE=mock) 엣지 그룹의 **시드·틱**(v2.708). 순수 합성은 mock/demo/edge.js.
 *
 * 둘로 나눈 이유: 이 모듈은 여러 도메인 모듈(등록부·통계·rma·relaytopo …)을 동적으로 불러온다. 그 모듈들이 순수 합성
 * (edge.js)을 import 하므로, 한 파일에 두면 import 순환(SCC)이 생긴다(test/arch2579 ②-b). 이 모듈을 import 하는 것은
 * collector/puller.js 하나뿐이다(새 import 를 만들지 말 것 — 순환이 된다).
 * 규칙은 edge.js 머리말과 같다 — mock 에서만, 시드는 비어 있을 때만, 접속하지 않는다.
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';
import {
  DEMO_EDGES, DEMO_EDGE_VERSION_FALLBACK, demoEdgeToken, demoEdgeUrl, demoEdgeOf, demoEdgeOfVcenter, isDemoCollector,
  countByVc, demoEdgeLogBody, demoTokenReport, demoProbeResult, _setDemoSnapVcenters, _setDemoNsxManagers, demoRelayTopology,
  demoRmaOutput, demoDirUsageTargets, demoCaptureResult,
} from './edge.js';

const MIN = 60_000;
const HOUR = 3_600_000;

let _seedTried = false;
/**
 * 중앙 수집 서버 등록부가 **비어 있을 때만** 데모 엣지를 1회 등록한다(mock 모드에서만).
 * @returns {Promise<{seeded:number, reason?:string}>}
 */
export async function ensureEdgeSeed({ force = false } = {}) {
  if (!isMockMode()) return { seeded: 0, reason: 'not-mock' };
  if (_seedTried && !force) return { seeded: 0, reason: 'already' };
  _seedTried = true;
  const reg = await import('../../collector/registry.js');
  if (reg.loadCollectors().length) return { seeded: 0, reason: 'not-empty' };
  let n = 0;
  for (const e of DEMO_EDGES) {
    const r = reg.addCollector({ id: e.id, name: e.name, url: demoEdgeUrl(e), token: demoEdgeToken(e), datacenter: e.datacenter });
    if (r.ok) n++;
  }
  if (n) console.log(`[mock] 데모 엣지 ${n}곳 등록(접속하지 않음 — .demo.invalid)`);
  return { seeded: n };
}
export function _resetEdgeSeedForTest() { _seedTried = false; _lastTick = 0; }

/* ───────────────────────── 인메모리 통계 틱 ───────────────────────── */

// 엣지가 중앙에 올리는(push) 경로 · 가져가는(pull) 경로 · 중앙이 엣지에서 당기는(cpull) 경로 — 실제 라우터 선언 이름이다.
const PUSH_EPS = [
  { ep: '/inventory', every: 1, bytes: 180_000, needVc: true },
  { ep: '/guest-disk', every: 10, bytes: 42_000, needVc: true },
  { ep: '/fleet', every: 5, bytes: 9_000 },
  { ep: '/link-check', every: 5, bytes: 3_500 },
  { ep: '/svcmon-report', every: 2, bytes: 6_000 },
  { ep: '/part-faults', every: 15, bytes: 2_200 },
  { ep: '/storage-data', every: 60, bytes: 24_000 },
  { ep: '/sanswitch-data', every: 5, bytes: 11_000 },
  { ep: '/pdu-data', every: 5, bytes: 4_000 },
  { ep: '/gpu-guest-data', every: 5, bytes: 7_500 },
];
const PULL_EPS = [
  { ep: '/storage-config', every: 5 }, { ep: '/sanswitch-config', every: 5 }, { ep: '/pdu-config', every: 5 },
  { ep: '/svcmon-config', every: 2 }, { ep: '/link-check-config', every: 5 }, { ep: '/gpu-guest-config', every: 10 },
  { ep: '/partfault-config', every: 10 }, { ep: '/users-config', every: 10 }, { ep: '/health-probe', every: 30 },
  { ep: '/edge-log-jobs', every: 1 }, { ep: '/ping-jobs', every: 1 }, { ep: '/capture-jobs', every: 1 },
  { ep: '/idrac-scan-jobs', every: 2 }, { ep: '/log-queries', every: 1 },
];
const CPULL_EPS = [{ path: '/api/collector/export', every: 1, bytes: 260_000 }];

let _lastTick = 0;
let _tickN = 0;

/**
 * 데모 엣지 틱 — 등록부를 시드하고(비어 있을 때만), 데모 엣지의 pull 상태·수신(push) 통계·pull 통계·중앙→엣지 호출 기록을 채운다.
 * 접속하지 않는다. puller 의 주기(기본 60초)마다 불린다. mock 이 아니면 아무것도 하지 않는다.
 * @returns {Promise<{edges:number, demo:true}|null>}
 */
let _tickBusy = null;
export async function demoEdgeTick(opts = {}) {
  if (!isMockMode()) return null;
  if (_tickBusy) return _tickBusy;                     // 진행 중인 틱을 공유한다(puller 가 기다리지 않고 부른다)
  _tickBusy = demoEdgeTickInner(opts).finally(() => { _tickBusy = null; });
  return _tickBusy;
}
async function demoEdgeTickInner({ now = Date.now(), snap = null } = {}) {
  await ensureEdgeSeed();
  const [{ loadCollectors }, state, ingest, pulls, outbound, cfg] = await Promise.all([
    import('../../collector/registry.js'), import('../../collector/state.js'), import('../../central/ingestStats.js'),
    import('../../central/pullStats.js'), import('../../util/outboundStats.js'), import('../../config.js'),
  ]);
  if (!snap) { try { snap = (await import('../../store.js')).store.get(); } catch { snap = null; } }
  _setDemoSnapVcenters(snap?.vcenters || []);
  try { _setDemoNsxManagers((await import('../../nsx/store.js')).nsxStore.get()?.managers || []); } catch { /* NSX 없음 */ }
  const counts = countByVc(snap);
  const version = (() => { try { return cfg.currentVersion(); } catch { return DEMO_EDGE_VERSION_FALLBACK; } })();
  const demoCollectors = loadCollectors().filter(isDemoCollector);
  const first = _lastTick === 0;
  _lastTick = now; _tickN++;
  for (const c of demoCollectors) {
    const e = demoEdgeOf(c.id) || demoEdgeOf(c.name) || { name: c.name || c.id, slug: c.id, datacenter: c.datacenter, vcPrefixes: [], rttMs: 50 };
    const name = c.name || c.id;
    // 맡은 vCenter 의 호스트 수(엣지 export 의 hosts — 전력 호스트 수 자리)
    let hosts = 0; let vms = 0;
    for (const v of snap?.vcenters || []) if (demoEdgeOfVcenter(v.id) === e) { const k = counts.get(v.id); if (k) { hosts += k.hosts; vms += k.vms; } }
    const degraded = !!e.degraded && demoRand(`deg|${e.id}|${Math.floor(now / (10 * MIN))}`) < 0.5;
    state.setCollectorStatus(c.id, {
      ok: true, degraded, error: degraded ? `응답 시한 초과 — 고지연 회선(RTT 약 ${e.rttMs}ms) 재시도 중(데모)` : null,
      fails: degraded ? 1 : 0, hosts, version, datacenter: c.datacenter || e.datacenter, agent: name,
      hostname: `${e.slug}.corp.example`, identity: null, mock: false, demo: true, vms,
    });
    // ── push(엣지 → 중앙): 처음엔 과거 기록이 없으므로 그 틱에 전 경로를 1회 기록한다. ──
    for (const p of PUSH_EPS) {
      if (!first && (_tickN % p.every) !== 0) continue;
      if (p.needVc && !hosts) continue;
      const wire = Math.round(p.bytes * (0.7 + demoRand(`w|${e.id}|${p.ep}|${_tickN}`) * 0.6) * (p.needVc ? Math.max(0.3, hosts / 20) : 1));
      ingest.recordIngest(name, p.ep, { wireBytes: wire, verified: true, summary: p.ep === '/inventory' ? { hosts, vms, gzip: true } : null });
    }
    // ── pull(엣지가 중앙에서 가져감): 처음엔 과거 3회분을 백필해 간격(EWMA)이 바로 보이게 ──
    for (const p of PULL_EPS) {
      const stepMs = p.every * MIN;
      const backfill = first ? [3, 2, 1] : [];
      for (const k of backfill) pulls.recordPull(name, p.ep, { status: 200, bytes: 400 + (demoHash(p.ep) % 3000), verified: true, now: now - k * stepMs });
      if (first || (_tickN % p.every) === 0) pulls.recordPull(name, p.ep, { status: 200, bytes: 400 + (demoHash(`${p.ep}|${_tickN}`) % 3000), verified: true, now });
    }
    // ── 중앙 → 엣지 호출(cpull): export 를 pull 주기마다 ──
    const base = c.url || demoEdgeUrl(e);
    for (const p of CPULL_EPS) {
      const rec = (t) => outbound.recordOutbound(`${base}${p.path}`, { status: 200, bytes: Math.round(p.bytes * Math.max(0.2, hosts / 20)), ms: e.rttMs * 2 + Math.round(demoRand(`ms|${e.id}|${t}`) * e.rttMs), now: t, tag: c.id });
      if (first) for (const k of [3, 2, 1]) rec(now - k * MIN);
      rec(now);
    }
    // 중앙이 엣지에서 토큰 점검·엣지 로그를 당긴 기록(누를 때만 가는 경로 — 처음 1회만)
    if (first) {
      outbound.recordOutbound(`${base}/api/collector/token-check`, { status: 200, bytes: 1800, ms: e.rttMs * 2, now: now - 4 * MIN, tag: c.id });
      outbound.recordOutbound(`${base}/api/collector/edge-log`, { status: 200, bytes: 48_000, ms: e.rttMs * 3, now: now - 6 * MIN, tag: c.id });
    }
  }
  if (first) await seedPulledStores(demoCollectors, { now, version });
  if (first) await ensureRelaySeed().catch(() => null);
  if (first) { await ensureRmaSeed(demoCollectors, { now }); await ensureCredentialSeed().catch(() => null); await ensureEdgePingSeed(demoCollectors, { now });
    await ensureDirUsageSeed({ now }); await ensureAssignmentSeed(); await ensureCaptureSeed({ now }); }
  await demoRmaTick({ now }).catch(() => null);
  return { edges: demoCollectors.length, demo: true };
}

/** 누를 때만 당기는 보관소(엣지 로그·토큰 점검 자기보고·중앙→엣지 프로브)를 데모 엣지마다 1회 채운다. */
async function seedPulledStores(cols, { now, version }) {
  try {
    const [{ putEdgeLog }, tcp, tp, spec] = await Promise.all([
      import('../../central/edgeLogStore.js'), import('../../central/tokenCheckPull.js'),
      import('../../portalcheck/tokenProbe.js'), import('../../edgelog/spec.js'),
    ]);
    const probes = [];
    for (const c of cols) {
      const e = demoEdgeOf(c.id) || demoEdgeOf(c.name) || DEMO_EDGES[0];
      const ms = e.rttMs * 3;
      putEdgeLog(c.name || c.id, { ...demoEdgeLogBody(c, { now: now - 20 * MIN, version, limit: 200, statusSpec: spec.STATUS_SPEC }), via: 'pull', ok: true, ms });
      tcp.putEdgeTokenReport(c.id, { ok: true, ms: e.rttMs * 2, report: tcp.sanitizeEnvelope(demoTokenReport(c, { now: now - 20 * MIN, version })) });
      probes.push(demoProbeResult({ agent: c.id }, { now: now - 20 * MIN, version }));
    }
    tp.putProbeResults(probes);
  } catch (err) { console.warn(`[mock] 데모 엣지 보관소 시드 실패: ${err?.message || err}`); }
}

let _relaySeeded = false;
/** 중계 토폴로지가 비어 있으면 데모 사이트를 1회 저장하고, 가져오기·경로 점검을 1회 돌린다(접속 없음). */
export async function ensureRelaySeed() {
  if (!isMockMode() || _relaySeeded) return { seeded: false };
  _relaySeeded = true;
  const st = await import('../../relaytopo/store.js');
  if ((st.loadTopologyRaw().sites || []).length) return { seeded: false, reason: 'not-empty' };
  st.saveTopology(demoRelayTopology());
  try { await (await import('../../relaytopo/ops.js')).fetchAll(); } catch (e) { console.warn(`[mock] 데모 중계 토폴로지 가져오기 실패: ${e?.message || e}`); }
  try { await (await import('../../relaycheck/poller.js')).runRelayChecks({ force: true }); } catch (e) { console.warn(`[mock] 데모 HAProxy 경로 점검 실패: ${e?.message || e}`); }
  console.log('[mock] 데모 중계 토폴로지 시드(사이트 5곳 · 접속하지 않음)');
  return { seeded: true };
}

const RMA_INSTANCES = (e) => (e.slug === 'edge-seoul' ? ['rma-1', 'rma-2'] : ['rma-1']);
let _rmaTimer = null;
let _rmaSeeded = false;

/** 데모 RMA 에이전트 하트비트 + 대기 잡 처리(실행하지 않고 합성 결과 회신). mock 이 아니면 아무것도 하지 않는다. */
export async function demoRmaTick({ now = Date.now() } = {}) {
  if (!isMockMode()) return null;
  const [{ loadCollectors }, jobs] = await Promise.all([import('../../collector/registry.js'), import('../../rma/jobs.js')]);
  let version = DEMO_EDGE_VERSION_FALLBACK; try { version = (await import('../../config.js')).currentVersion(); } catch { /* */ }
  let n = 0;
  for (const c of loadCollectors().filter(isDemoCollector)) {
    const e = demoEdgeOf(c.id) || demoEdgeOf(c.name) || DEMO_EDGES[0];
    const name = c.name || c.id;
    RMA_INSTANCES(e).forEach((inst, k) => {
      jobs.noteHeartbeat(name, inst, { hostname: `${e.slug}${k ? `-${k + 1}` : ''}.corp.example`, version, os: 'Rocky Linux 9.4', pid: 2000 + k, uptimeSec: 3 * 86400, priority: 100 + k * 10, signed: true,
        comment: '데모 RMA 인스턴스(실제로 실행하지 않습니다)', stats: { active: 0, performed: 10 + (demoHash(e.id) % 50), rejected: 0, testsRun: 0, testsFailed: 0 },
        policy: { enabled: [], disabled: [], enabledTests: [], disabledTests: [], serviceUnits: ['vmware-portal.service'], allowReboot: false, fileRoots: ['/var/log'] } }, { ip: demoIp(`rma|ip|${e.id}|${k}`) });
      for (const j of jobs.takeJobs(name, inst, now)) {
        const out = demoRmaOutput(j.cmd, j.args || {}, e, now);
        jobs.setJobResult(j.reqId, { ok: true, exitCode: 0, durationMs: 40 + (demoHash(j.reqId) % 400), stdout: out, stderr: '', cmd: j.cmd, instance: inst });
        n++;
      }
    });
  }
  return { done: n };
}

/** 첫 틱: RMA 이력 백필(DB 가 비어 있을 때만) + 5초 처리 타이머(데모 잡이 바로 끝나게). */
async function ensureRmaSeed(cols, { now }) {
  if (_rmaSeeded) return; _rmaSeeded = true;
  try {
    const hdb = await import('../../rma/historyDb.js');
    const have = await hdb.listHistoryRows({ limit: 1 }).catch(() => null);
    if (Array.isArray(have) && !have.length) {
      const cmds = ['uptime', 'df', 'free', 'sysctl-status', 'ss-listen', 'ip-addr'];
      let k = 0;
      for (const c of cols) {
        const e = demoEdgeOf(c.id) || demoEdgeOf(c.name) || DEMO_EDGES[0];
        for (let i = 0; i < 6; i++) {
          const cmd = cmds[(i + k) % cmds.length];
          const at = now - (i * 7 + k * 3 + 1) * HOUR - (demoHash(`${e.id}|${i}`) % (30 * MIN));
          await hdb.saveHistoryRow({ reqId: `mock-${e.slug}-${i}`, agent: c.name || c.id, instance: 'rma-1', cmd, args: cmd === 'sysctl-status' ? { unit: 'vmware-portal.service' } : {}, label: cmd, user: 'admin',
            createdAt: at - 2000, takenAt: at - 1500, doneAt: at, ok: true, exitCode: 0, timedOut: false, durationMs: 120 + (demoHash(`${e.id}|d|${i}`) % 300), reason: '', stdout: demoRmaOutput(cmd, {}, e, at), stderr: '' });
        }
        k++;
      }
    }
  } catch (err) { console.warn(`[mock] 데모 RMA 이력 백필 실패: ${err?.message || err}`); }
  if (!_rmaTimer) { _rmaTimer = setInterval(() => { demoRmaTick().catch(() => null); demoCaptureDrain().catch(() => null); }, 5_000); _rmaTimer.unref?.(); }
}

let _credSeeded = false;
/** 통합 계정 관리 — 비어 있을 때만 데모 계정 3개(비밀번호 'mock', 이름 mock- 접두). 접속에 쓰이지 않는다(데모 엣지는 RMA 를 실행하지 않는다). */
export async function ensureCredentialSeed() {
  if (!isMockMode() || _credSeeded) return { seeded: 0 };
  _credSeeded = true;
  const cs = await import('../../security/credentialStore.js');
  if (cs.listCredentials().length) return { seeded: 0, reason: 'not-empty' };
  const items = [
    { name: 'mock-linux-admin', kind: 'password', username: 'svc_portal', password: 'mock', hosts: '10.0.0.0/8, *.corp.example', agents: '*', note: '데모 계정(비밀번호 mock) — 실제로 쓰이지 않습니다' },
    { name: 'mock-seoul-ops', kind: 'password', username: 'ops_seoul', password: 'mock', hosts: '*.corp.example', agents: `${demoEdgeOf('edge-seoul').name}, ${demoEdgeOf('edge-singapore').name}`, note: '데모 계정 — 아시아 법인 전용' },
    { name: 'mock-eu-readonly', kind: 'password', username: 'ro_monitor', password: 'mock', hosts: '10.0.0.0/8', agents: demoEdgeOf('edge-frankfurt').name, note: '데모 계정 — 조회 전용' },
  ];
  let n = 0;
  for (const it of items) { try { cs.saveCredential(it, { actor: 'mock-demo' }); n++; } catch (err) { console.warn(`[mock] 데모 계정 등록 실패(${it.name}): ${err?.message || err}`); } }
  if (n) console.log(`[mock] 데모 통합 계정 ${n}개 등록`);
  return { seeded: n };
}

/** 네트워크 체크(엣지 노드 핑) — 데모 엣지를 핑 대상으로 등록(ping/store seedEdgeTargets)하고 24시간 이력을 백필한다. */
async function ensureEdgePingSeed(cols, { now }) {
  try {
    const ps = await import('../../ping/store.js');
    const before = new Set(ps.listTargets().map((t) => t.id));
    ps.seedEdgeTargets(cols);
    const added = ps.listTargets().filter((t) => t.source === 'edge' && !before.has(t.id));
    if (!added.length) return;
    const { getPingDb } = await import('../../ping/db.js');
    const db = await getPingDb();
    const recs = [];
    for (const t of added) {
      const e = demoEdgeOf(String(t.id).replace(/^edge_/, '')) || demoEdgeOf(t.name) || DEMO_EDGES[0];
      for (let ts = now - 24 * HOUR; ts <= now; ts += 15 * MIN) {
        const down = demoRand(`png|${t.id}|${ts}`) < 0.01;
        recs.push({ target: t.id, ts, rtt: down ? null : Math.round(e.rttMs * (0.85 + demoRand(`pr|${t.id}|${ts}`) * 0.35)), ok: !down });
      }
    }
    try { db?.insertMany?.(recs); } catch { /* best effort */ }
    console.log(`[mock] 데모 엣지 핑 대상 ${added.length}개 + 24h 이력`);
  } catch (err) { console.warn(`[mock] 데모 엣지 핑 시드 실패: ${err?.message || err}`); }
}

/** 폴더 사용량 이력 백필(DB 가 비어 있을 때만) — 14일 · 하루 1회. `buildScanRecord` 는 dirusage/scan.js 의 것(조립 복제 금지). */
async function ensureDirUsageSeed({ now }) {
  try {
    const [{ getDb }, { buildScanRecord }] = await Promise.all([import('../../dirusage/db.js'), import('../../dirusage/scan.js')]);
    const db = await getDb();
    if (!db || db.latestAll().length) return;
    const users = ['kim.jh', 'lee.sm', 'park.yh', 'choi.dw', 'jung.hr', 'kang.mj', 'cho.ys', 'yoon.ji', 'jang.sh', 'lim.th', 'han.ek', 'oh.sw', 'seo.yj', 'shin.dh', 'kwon.mk', 'hwang.sb', 'ahn.jw', 'song.hn', 'yoo.cr', 'hong.gd', 'archive', 'shared', 'tmp'];
    for (const t of demoDirUsageTargets()) {
      for (let d = 13; d >= 0; d--) {
        const ts = now - d * 24 * HOUR - (demoHash(`${t.id}|${d}`) % HOUR);
        const entries = users.map((u, i) => {
          const base = (2 + (demoHash(`${t.id}|${u}`) % 400)) * 1024 ** 3 / (1 + i * 0.15);
          const grow = 1 + ((13 - d) * (demoHash(`g|${u}`) % 7)) / 1000;
          return { name: `${t.path}/${u}`, bytes: Math.round(base * grow) };
        });
        const sum = entries.reduce((a, x) => a + x.bytes, 0);
        db.insertScan(buildScanRecord({ targetId: t.id, root: t.path, agent: t.agent, ts, parsed: { entries, totalBytes: Math.round(sum * 1.04), skipped: 0, truncated: false }, topN: t.topN }));
      }
    }
    console.log('[mock] 데모 폴더 사용량 이력 백필(대상 3개 × 14일)');
  } catch (err) { console.warn(`[mock] 데모 폴더 사용량 백필 실패: ${err?.message || err}`); }
}

/** 에이전트 작업(엣지별 iDRAC 스캔 대역 할당) — 비어 있을 때만 데모 할당 3개(비밀번호 'mock') + 보고 결과. 엣지가 실제로 가져가지 않는다. */
async function ensureAssignmentSeed() {
  try {
    const as = await import('../../central/assignments.js');
    if (as.listAssignments().length) return;
    for (const slug of ['edge-seoul', 'edge-frankfurt', 'edge-shanghai']) {
      const e = demoEdgeOf(slug);
      const net = demoIp(`asg|${e.id}`).split('.').slice(0, 3).join('.');
      as.addAssignment({ agent: e.name, ips: `${net}.0/24`, username: 'root', password: 'mock', enabled: true });
      const n = 4 + (demoHash(e.id) % 9);
      const found = Array.from({ length: n }, (_, i) => ({ ip: `${net}.${20 + i}`, serviceTag: `MOCK${(demoHash(`${e.id}|${i}`) % 900000 + 100000)}`, model: i % 3 ? 'PowerEdge R750' : 'PowerEdge R760', manufacturer: 'Dell Inc.', hostName: `esx-${e.slug.replace('edge-', '')}-${String(i + 1).padStart(2, '0')}` }));
      as.setResult(e.name, { scanned: 254, foundCount: n, found, unreachable: 230 - n, notIdrac: 20, authFailed: slug === 'edge-shanghai' ? 2 : 0, durationMs: 40_000 + (demoHash(e.id) % 30_000) });
    }
    console.log('[mock] 데모 에이전트 작업(iDRAC 스캔 할당) 3개 + 보고 결과');
  } catch (err) { console.warn(`[mock] 데모 에이전트 작업 시드 실패: ${err?.message || err}`); }
}

async function ensureCaptureSeed({ now }) {
  try {
    const ch = await import('../../net/captureHistory.js');
    if (ch.listCaptures({ limit: 1 }).length) return;
    const pairs = DEMO_EDGES.slice(0, 4).map((e, i) => ({ e, hostA: demoIp(`capA|${e.id}`), peer: demoIp(`capB|${e.id}`), i }));
    const recs = [];
    for (let k = 0; k < 8; k++) {
      const p = pairs[k % pairs.length];
      const r = ch.recordCapture(demoCaptureResult({ hostA: p.hostA, peer: p.peer, rttMs: p.e.rttMs, seed: `${p.e.id}|${k}` }), { source: k % 3 ? 'manual' : 'monitor', via: 'agent', hostA: p.hostA, peer: p.peer, monitorName: k % 3 ? '' : `${p.e.datacenter} 백업 경로(데모)` });
      recs.push([r, now - (8 - k) * 5 * HOUR]);
    }
    for (const [r, at] of recs) r.at = at;   // 이력이 시간에 퍼지게(저장소가 기록 시각을 '지금' 으로 찍는다 — 다음 저장 때 반영된다)
    console.log('[mock] 데모 트래픽 분석 이력 8건');
  } catch (err) { console.warn(`[mock] 데모 트래픽 분석 시드 실패: ${err?.message || err}`); }
}

/** 데모 엣지에 위임된 캡처 잡을 합성 결과로 끝낸다(5초 타이머 — 실행하지 않는다). */
async function demoCaptureDrain() {
  const cj = await import('../../central/captureJobs.js');
  for (const e of DEMO_EDGES) {
    for (const j of cj.takeCaptureJobs(e.name)) {
      const sp = j.spec || {};
      const r = sp.dual
        ? (() => { const a = demoCaptureResult({ hostA: sp.hostA?.host, peer: sp.hostB?.host, rttMs: e.rttMs, seed: j.reqId }); const b = demoCaptureResult({ hostA: sp.hostB?.host, peer: sp.hostA?.host, rttMs: e.rttMs, seed: `${j.reqId}b` });
          return { ok: true, dual: true, hostA: sp.hostA?.host, hostB: sp.hostB?.host, a, b, comparison: { issues: [], lossAB: 0, lossBA: 0 } }; })()
        : demoCaptureResult({ hostA: sp.host, peer: sp.peer, seconds: Number(sp.seconds) || 10, rttMs: e.rttMs, seed: j.reqId });
      cj.setCaptureResult(j.reqId, r);
    }
  }
}
