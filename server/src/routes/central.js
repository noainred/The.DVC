/**
 * Central orchestration endpoints used by agents (agent -> central). Mounted
 * outside user auth and gated by CENTRAL_TOKEN. Agents pull their IP assignment
 * by name and post scan results back.
 *
 * ## 신규 라우트 규약 (반드시 따를 것)
 * 이 라우터는 사용자 인증 밖에 있으므로 자격증명 횡탈 방어가 **라우트 작성자 책임**이다.
 * 새 엔드포인트를 만들 때:
 *  1. **`req.centralAuth.mode !== 'agent'` 면 거부한다.** 공유 CENTRAL_TOKEN 은 어떤 엣지의
 *     것인지 구별할 수 없어(config 기본값에서 COLLECTOR_TOKEN 과 같은 값이 된다) 엣지별
 *     데이터를 그 토큰으로 쓰게 하면 한 토큰 유출로 전 엣지 데이터가 위조된다.
 *  2. **저장 키는 `req.centralAuth.agent` 만 쓴다.** `body.agent`/`query.agent` 를 저장 키로
 *     읽으면 위 미들웨어의 바인딩 검사를 우회한다(이름 필드를 생략하면 검사가 아예 안 걸린다).
 *  3. 계측·바인딩 이중 방어를 위해 엣지가 `X-Agent-Name` 헤더를 붙이게 한다.
 * 기존 라우트 중 이 3가지를 모두 지키는 것은 `/svcmon-report` 뿐이므로, 다른 라우트를
 * 복사해 시작하면 이 방어가 빠진다.
 */

import { Router } from 'express';
import { config, loadVcenterConfig } from '../config.js';
import { getAssignment, setResult } from '../central/assignments.js';
import { tokenMatches } from '../util/secureCompare.js';
import { resolveAgentByToken, hasAnyAgentToken, listAgentTokens } from '../central/agentTokens.js';
import { setInventory, getInventory, listInventory } from '../central/inventory.js';
import { setEdgeFleet } from '../central/fleet.js';
import { setGuestGpu } from '../gpu/store.js';
import { setGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { takePingJobs, setPingResults } from '../central/pingJobs.js';
import { takeIdracScanJobs, setIdracScanResult, setIdracScanProgress, agentOfReq } from '../central/idracScanJobs.js';
import { pullNow as pullCollectorsNow } from '../collector/puller.js';
import { upsertCollectorFromAgent, ssrfBlockReasonResolved } from '../collector/registry.js';
import { recordIngest, noteInventoryCompression } from '../central/ingestStats.js';
import { notify } from '../alerts.js';
import { ingestReport } from '../central/svcmonEdge.js';
import { getAssignmentForAgent, markPulled, ackAssignment } from '../central/svcmonAssign.js';
import { setAgentConfig } from '../central/agentConfig.js';
import { getAssignedGpuGuest } from '../central/agentGpuGuestConfig.js';
import { getEffectiveUsers } from '../central/agentUsers.js';
import { takeLogQueries, setLogQueryResult, vcenterOfReq } from '../central/logQueries.js';
import { specToRange } from '../ipam/rangePolicies.js';
import { ipToNum } from '../ipam/ledger.js';
import { takeCaptureJobs, setCaptureResult, captureAgentOfReq } from '../central/captureJobs.js';
import { takeBmstorJobs, ackBmstorJob, bmstorAgentOfReq } from '../bmstor/jobs.js';
import { applyBmstorResults } from '../bmstor/poller.js';
import { recordCapture } from '../net/captureHistory.js';
import { loadScanSettings, mergeScanResults, recordAgentReport } from '../ipam/scanStore.js';

export const centralRouter = Router();

// 수신 트래픽 진단 — 에이전트→중앙 POST의 와이어 바이트(Content-Length)·페이로드 요약을 에이전트·
// 엔드포인트별로 집계한다(특정 에이전트가 무엇을 얼마나 보내는지 화면에서 확인). 응답 완료 시 1회 기록.
centralRouter.use((req, res, next) => {
  if (req.method === 'POST') {
    res.on('finish', () => {
      try {
        if (res.statusCode >= 400) return; // 인증 실패/오류는 집계 제외
        const agent = String(req.body?.agent || req.get('X-Agent-Name') || '').trim() || '(unknown)';
        const wireBytes = Number(req.get('content-length')) || 0;
        if (!wireBytes && agent === '(unknown)') return;
        // 인벤토리 push는 페이로드 규모(vCenter·호스트·VM 수)도 함께 기록 → '왜 큰지' 바로 파악.
        const b = req.body || {};
        const summary = req.path === '/inventory'
          ? { vcenterId: b.vcenterId || '', hosts: (b.hosts || []).length, vms: (b.vms || []).length,
              datastores: (b.datastores || []).length, networks: (b.networks || []).length, alarms: (b.alarms || []).length,
              gzip: (req.get('content-encoding') || '').includes('gzip') }
          : null;
        recordIngest(agent, req.path, { wireBytes, summary });
        // 무압축 대형 인벤토리 push 경고 승격(v2.344, #12) — 진단 표에만 보이던 '무압축(구버전
        // 엣지 추정)'을 알림 채널로. 연속 임계는 추적기가, 재발화 억제는 warned 래치+notify
        // 전역 억제 창이 담당. 알림 실패가 수신 경로를 막지 않게 catch.
        if (summary) {
          const ev = noteInventoryCompression(agent, { gzip: summary.gzip, wireBytes });
          if (ev?.type === 'warned') {
            notify({
              key: `ingest-plain:${ev.agent}`, severity: 'warning',
              title: `엣지 '${ev.agent}' 무압축 인벤토리 push 감지`,
              detail: `push당 ${(ev.wireBytes / 1048576).toFixed(1)}MB(무압축, 연속 ${ev.streak}회) — 구버전 엣지 또는 AGENT_PUSH_GZIP=false 추정. gzip 적용 시 ~1/5~1/10. 설정 › 수집 서버(원격) → 모두 업그레이드 권장.`,
            }).catch(() => {});
          } else if (ev?.type === 'resolved') {
            notify({
              key: `ingest-plain-ok:${ev.agent}`, severity: 'warning',
              title: `엣지 '${ev.agent}' 무압축 push 해소`,
              detail: 'gzip 압축 push 가 다시 관측되었습니다(업그레이드/설정 정상화).',
            }).catch(() => {});
          }
        }
      } catch { /* 진단은 best-effort */ }
    });
  }
  next();
});

// central 활성 조건 — 공유 CENTRAL_TOKEN 또는 엣지별 개별 토큰이 하나라도 있으면 활성.
// (개별 토큰만 발급하고 공유 토큰을 없애는 '완전 이관' 구성도 지원하기 위함.)
const centralEnabled = () => Boolean(config.central.token) || hasAnyAgentToken();

// 공유 토큰을 아예 금지하는 강화 모드(전 엣지 개별 토큰 이관 완료 후 켠다).
const REQUIRE_AGENT_TOKEN = process.env.CENTRAL_REQUIRE_AGENT_TOKEN === 'true';

// 공유 토큰 사용 통계 — 관리 화면이 '아직 개별 토큰으로 이관되지 않은 엣지가 있다'를 알 수 있게.
const sharedStats = { uses: 0, lastAt: null, lastAgent: '', lastPath: '' };
export function getCentralAuthStats() {
  return { ...sharedStats, requireAgentToken: REQUIRE_AGENT_TOKEN, agentTokens: listAgentTokens().length };
}

/**
 * central 인증 — 엣지별 개별 토큰이 우선, 없으면 공유 CENTRAL_TOKEN(하위호환).
 * 개별 토큰으로 인증하면 req.centralAuth.agent 에 그 엣지 이름이 바인딩되고, 아래 미들웨어가
 * '자기 agent 데이터만' 접근하도록 강제한다(엣지 1대 침해로 전 사이트 자격증명이 새는 것 차단).
 */
function resolveCentralAuth(req) {
  const t = req.get('X-Central-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const bound = resolveAgentByToken(t);
  if (bound) return { ok: true, mode: 'agent', agent: bound };
  if (config.central.token && tokenMatches(t, config.central.token)) {
    if (REQUIRE_AGENT_TOKEN) return { ok: false, reason: '공유 CENTRAL_TOKEN은 비활성입니다(CENTRAL_REQUIRE_AGENT_TOKEN=true) — 이 엣지의 개별 토큰을 사용하세요.' };
    return { ok: true, mode: 'shared', agent: null };
  }
  return { ok: false, reason: '토큰 불일치' };
}

// 요청이 다루려는 agent 이름(쿼리·헤더·본문 순).
// /register-collector 는 자기 이름을 body.name 으로 알리므로 그 필드도 바인딩 대상에 포함한다
// (개별 토큰을 가진 엣지가 남의 이름으로 수집 서버를 덮어쓰는 것 방지).
const requestedAgent = (req) => String(
  req.query?.agent || req.get('X-Agent-Name') || req.body?.agent
  || (req.path === '/register-collector' ? req.body?.name : '') || '',
).trim();

// 인증 1회 해석 + agent 바인딩 강제(모든 라우트 공통). 라우트별 authed(req)는 이 결과를 읽는다.
centralRouter.use((req, res, next) => {
  const auth = resolveCentralAuth(req);
  req.centralAuth = auth;
  if (!auth.ok) return next(); // 각 라우트가 404/403을 구분해 응답(하위호환 유지)
  const want = requestedAgent(req);
  if (auth.mode === 'agent' && want && want.toLowerCase() !== String(auth.agent).toLowerCase()) {
    // 개별 토큰은 남의 이름으로 조회/보고할 수 없다 — 자격증명 횡탈·데이터 위장 차단.
    console.warn(`[central] agent 불일치 거부 — 토큰=${auth.agent} 요청=${want} (${req.method} ${req.path})`);
    return res.status(403).json({ ok: false, reason: `이 토큰은 '${auth.agent}' 전용입니다(요청: '${want}').` });
  }
  if (auth.mode === 'shared') {
    sharedStats.uses++; sharedStats.lastAt = Date.now();
    sharedStats.lastAgent = want || '(unknown)'; sharedStats.lastPath = req.path;
  }
  next();
});

function authed(req) { return Boolean(req.centralAuth?.ok); }
// 인증 실패 사유(토큰 불일치 / 공유 토큰 금지)를 그대로 전달해 운영자가 원인을 알 수 있게.
const denyReason = (req) => req.centralAuth?.reason || '토큰 불일치';

/**
 * agent 가 이 vCenter 를 소유(inventory 등록)했나 — 조회/보고 select 키가 vcenters 인 라우트의
 * 소유권 검증. `?vcenters=` 로 데이터를 고르는 라우트는 미들웨어 바인딩(want 이 비면 단락)을
 * 우회하므로, 개별 토큰(agent 모드)이 남이 소유한 vCenter 의 잡/결과를 가로채/위조하지 못하게 한다.
 * 소유주가 없는 vCenter(미등록/direct-mode)는 TOFU 로 통과 — 정상 엣지 작업 분배를 깨지 않는다.
 * (공유 토큰 모드는 '구별 불가한 전체 신뢰'라 여기서 검사하지 않는다 — 완전 봉인은
 *  CENTRAL_REQUIRE_AGENT_TOKEN=true. gpu-guest-data 의 agent-모드-한정 검사와 동일 정책.)
 */
function agentOwnsVcenter(agent, vcenterId) {
  if (!agent || !vcenterId) return true;
  const owner = listInventory().find((e) => String(e.vcenterId) === String(vcenterId))?.agent || '';
  return !owner || owner.toLowerCase() === String(agent).toLowerCase();
}

// 위임 잡(iDRAC 스캔·캡처) reqId 소유권 판정. reqId 는 예측가능(idscan_<time>_<seq>·cap_<time>_<seq>)
// 하므로, 개별 토큰 agent 가 남의 reqId 로 진행/결과를 위조 주입하지 못하게 막는다. 공유 CENTRAL_TOKEN
// (레거시)과 미상 잡(assignedAgent='')은 기존 신뢰를 유지(TOFU) — 정상 엣지 흐름 무회귀.
function reqAgentDenied(req, assignedAgent) {
  if (req.centralAuth?.mode !== 'agent') return false; // 공유 토큰: 기존 신뢰
  if (!assignedAgent) return false;                    // 미상 잡: TOFU 통과
  return String(req.centralAuth.agent || '').trim().toLowerCase() !== String(assignedAgent).trim().toLowerCase();
}

// Agent pulls the IP assignment for its name (incl. iDRAC credentials).
centralRouter.get('/assignment', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const a = getAssignment(req.query.agent);
  if (!a || a.enabled === false) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, agent: a.agent, ips: a.ips, username: a.username, password: a.password });
});

// 엣지 자기등록(EDGE_MODE=all): 부팅한 엣지가 자기 이름/포트/수집토큰을 알리면 수집 서버
// 목록에 자동 upsert — 관리자의 '수집 서버 추가' 수동 절차가 필요 없어진다.
// Body: { name, port, collectorToken, datacenter?, urlHint?, version? }
centralRouter.post('/register-collector', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, reason: 'name이 필요합니다.' });
  if (!b.collectorToken) return res.status(400).json({ ok: false, reason: 'collectorToken이 필요합니다(엣지의 export 인증 토큰).' });
  // URL: 엣지가 명시(urlHint)하지 않으면 요청 peer IP + 알린 포트로 유도(NAT 없는 사내망 가정).
  let url = String(b.urlHint || '').trim();
  if (!url) {
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ ok: false, reason: 'port가 올바르지 않습니다(1~65535) — urlHint로 전체 주소를 지정하세요.' });
    }
    let ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ip) return res.status(400).json({ ok: false, reason: '요청 IP를 확인할 수 없습니다(urlHint를 지정하세요).' });
    // 중앙이 리버스 프록시(nginx/HAProxy) 뒤면 peer가 127.0.0.1이 되어 모든 엣지가 중앙
    // 자신으로 등록되는 사고가 난다 → 루프백이면 거절하고 urlHint를 요구.
    if (/^(127\.|::1$|::$)/.test(ip) || ip === 'localhost') {
      return res.status(400).json({ ok: false, reason: '요청 IP가 루프백입니다(중앙이 프록시 뒤). 엣지에 EDGE_ADVERTISE_URL(urlHint)를 지정하세요.' });
    }
    if (ip.includes(':')) ip = `[${ip}]`; // IPv6
    url = `http://${ip}:${port}`;
  }
  // 엣지 자기등록 URL(특히 urlHint)은 신뢰 경계 밖 입력 — 저장 전 **해석형** SSRF 가드로 DNS 우회까지
  // 차단한다. 중앙이 이 URL 로 주기적 수집 요청을 보내므로(SSRF), 저장 경로 sync 검사만으로는 차단
  // 대역으로 '해석되는 이름'을 놓친다(감사 M-R4). RFC1918 사내 대역은 허용, 루프백/메타데이터만 차단.
  const ssrfReason = await ssrfBlockReasonResolved(String(url));
  if (ssrfReason) return res.status(400).json({ ok: false, reason: `수집 서버 URL: ${ssrfReason}` });
  const r = upsertCollectorFromAgent({ name, url, token: String(b.collectorToken), datacenter: String(b.datacenter || '') });
  if (r.ok) console.log(`[central] 엣지 자기등록: ${name} → ${url}${b.version ? ` (v${b.version})` : ''}`);
  res.status(r.ok ? 200 : 400).json(r);
});

// Agent posts its scan result. Body: { agent, scanned, found:[...], unreachable, notIdrac, authFailed }
centralRouter.post('/result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  // 저장 키는 개별 토큰이면 토큰에서 해석한 agent 를 강제한다(body.agent 위조 차단 —
  // ?agent=자기 + body.agent=남 우회 봉인). 공유 토큰(shared)은 어느 엣지인지 알 수 없어
  // 하위호환으로 body.agent 를 쓴다(완전 봉인은 CENTRAL_REQUIRE_AGENT_TOKEN=true).
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  setResult(agent, {
    scanned: b.scanned || 0,
    foundCount: b.foundCount ?? (b.found?.length || 0),
    found: Array.isArray(b.found) ? b.found.slice(0, 5000) : [],
    unreachable: b.unreachable || 0,
    notIdrac: b.notIdrac || 0,
    authFailed: b.authFailed || 0,
    durationMs: b.durationMs || null,
  });
  res.json({ ok: true });
});

// 사이트 위임 수집: 현장 서버가 로컬 vCenter 인벤토리 조각을 push.
// Body: { agent, vcenterId, vcenter, hosts[], vms[], datastores[], networks[], alarms[], generatedAt }
/**
 * 성능점검 엣지 보고 수신 (RMA Active). 엣지가 자기 대역을 로컬에서 점검하고 결과를 밀어 올린다.
 *
 * **개별 토큰 전용**이다. 저장 키는 토큰에서 해석한 `req.centralAuth.agent` 뿐이며 본문의
 * agent 필드는 읽지 않는다 — 그래야 한 엣지가 남의 이름으로 결과를 위조할 수 없다.
 */
centralRouter.post('/svcmon-report', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({
      ok: false,
      reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(공유 CENTRAL_TOKEN 으로는 어느 엣지의 결과인지 신뢰할 수 없습니다). 설정 > 엣지 토큰에서 이 엣지의 토큰을 발급해 주세요.',
    });
  }
  const agent = req.centralAuth.agent;
  // 소켓 관측 주소 — 통신 진단(probe)의 목적지. 프록시 뒤면 프록시 주소일 수 있다.
  const sourceIp = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const r = ingestReport(agent, req.body || {}, Date.now(), { sourceIp });
  recordIngest(agent, 'svcmon-report', {
    wireBytes: Number(req.get('content-length')) || 0,
    summary: { accepted: r.accepted, dropped: r.dropped, rows: Array.isArray(req.body?.rows) ? req.body.rows.length : 0 },
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

/**
 * Capacity Advisor 엣지 보고 — 엣지가 자기 호스트 리소스 스냅샷({metric,v} 행 + 메타)을
 * 밀어 올린다. **개별 토큰 전용**(svcmon-report 와 같은 3규약: agent 모드 필수 · 저장 키는
 * req.centralAuth.agent 만 · X-Agent-Name 이중 방어). 시각은 중앙 수신 시각이 진실이다.
 */
centralRouter.post('/capacity-report', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(어느 엣지의 리소스인지 신뢰할 수 없습니다).' });
  }
  const agent = req.centralAuth.agent;
  try {
    const b = req.body || {};
    const rawRows = Array.isArray(b.rows) ? b.rows.slice(0, 64) : [];   // 수집기 수 상한(폭주 방어)
    const rows = [];
    for (const r of rawRows) {
      const metric = typeof r?.metric === 'string' ? r.metric.slice(0, 40) : '';
      const v = Number(r?.v);
      if (metric && /^[a-z0-9_]+$/.test(metric) && Number.isFinite(v)) rows.push({ metric, v });
    }
    const meta = b.meta && typeof b.meta === 'object'
      ? {
        hostname: String(b.meta.hostname || '').slice(0, 100),
        platform: String(b.meta.platform || '').slice(0, 20),
        cores: Number(b.meta.cores) || 0,
        totalMemMB: Number(b.meta.totalMemMB) || 0,
        nodeVersion: String(b.meta.nodeVersion || '').slice(0, 20),
        portalVersion: String(b.meta.portalVersion || '').slice(0, 20),
        role: String(b.meta.role || '').slice(0, 10),
        intervalMs: Number(b.meta.intervalMs) || 0,
      }
      : {};
    const { getCapacityDb } = await import('../capacity/db.js');
    const db = await getCapacityDb();
    // 빈 rows 도 hosts.lastTs 는 갱신한다 — '살아 있으나 첫 델타 기준선 중'과 '죽음'을 구별(하트비트).
    db.insertSnapshot(agent, rows, Date.now(), meta);
    recordIngest(agent, 'capacity-report', {
      wireBytes: Number(req.get('content-length')) || 0,
      summary: { rows: rows.length },
    });
    res.json({ ok: true, accepted: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, reason: `저장 실패: ${e.message}` });
  }
});

/**
 * 성능점검 정의 배포 — 엣지가 자기 배정을 받아 간다. **개별 토큰 전용.**
 * `query.agent` 는 미들웨어 바인딩 검사를 걸기 위한 것이고, 실제 조회 키는 토큰에서 해석한
 * 이름만 쓴다(쿼리 값을 신뢰하지 않는다).
 */
centralRouter.get('/svcmon-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다.' });
  }
  const agent = req.centralAuth.agent;
  const r = getAssignmentForAgent(agent, String(req.query.sig || ''));
  if (r.assigned && !r.unchanged) markPulled(agent, r.sig);
  res.json({ ok: true, ...r });
});

/**
 * 엣지 적용 결과 회신 — **이것이 배포 성공 판정의 근거다.**
 * 적용 수가 배포 수와 다르면 중앙이 `mismatch` 로 남기고 그대로 노출한다.
 */
centralRouter.post('/svcmon-config-ack', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다.' });
  }
  const b = req.body || {};
  const r = ackAssignment(req.centralAuth.agent, {
    sig: String(b.sig || ''), applied: b.applied || {}, removed: b.removed, errors: b.errors,
  });
  res.status(r.ok ? 200 : 409).json(r);
});

centralRouter.post('/inventory', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.vcenterId || !b.vcenter) return res.status(400).json({ ok: false, reason: 'vcenterId/vcenter가 필요합니다.' });
  // 출처 agent 는 개별 토큰이면 토큰에서 해석한 값을 강제(body.agent 위조 무효화).
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  // 소유권 경계(TOFU): 이 vcenterId 를 이미 다른 엣지가 등록했다면 개별 토큰은 덮어쓸 수 없다.
  // (엣지 A 가 남의 vCenter 스냅샷을 위조·블랭킹하는 것을 차단. 공유 토큰은 agent 가 없어 검사 생략 —
  //  완전 봉인은 CENTRAL_REQUIRE_AGENT_TOKEN=true.)
  if (req.centralAuth.mode === 'agent') {
    const owner = getInventory(String(b.vcenterId))?.agent || '';
    if (owner && owner.toLowerCase() !== agent.toLowerCase()) {
      return res.status(403).json({ ok: false, reason: `vcenterId '${b.vcenterId}'는 '${owner}' 소유입니다(다른 엣지가 덮어쓸 수 없습니다).` });
    }
  }
  const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  const slice = {
    vcenter: b.vcenter,
    hosts: arr(b.hosts, 50_000),
    vms: arr(b.vms, 500_000),
    datastores: arr(b.datastores, 50_000),
    networks: arr(b.networks, 50_000),
    alarms: arr(b.alarms, 50_000),
  };
  setInventory(String(b.vcenterId), slice, agent, b.generatedAt || null);
  res.json({ ok: true, vcenterId: b.vcenterId, hosts: slice.hosts.length, vms: slice.vms.length });
});

// 엣지 베어메탈 집계: 현장 포탈이 자기 DC의 베어메탈 목록(전력 미보고 포함)을 push.
// Body: { agent, baremetal:[{fleetId,name,model,serviceTag,watts,vcenterId,source}], generatedAt }
centralRouter.post('/fleet', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const list = Array.isArray(b.baremetal) ? b.baremetal : [];
  setEdgeFleet(agent, list, b.generatedAt || null);
  res.json({ ok: true, agent, baremetal: list.length });
});

// 위임 iDRAC 스캔: 에이전트가 자기 이름의 온디맨드 스캔 잡을 인출.
centralRouter.get('/idrac-scan-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeIdracScanJobs(req.query.agent) });
});

// 위임 iDRAC 스캔: 에이전트가 스캔 진행률(중간)을 보고. Body: { reqId, scanned, total }
centralRouter.post('/idrac-scan-progress', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setIdracScanProgress(String(b.reqId), b);
  res.json({ ok: true });
});

// 위임 iDRAC 스캔: 에이전트가 발견 목록·요약을 reqId와 함께 회신.
// Body: { agent, reqId, scanned, found:[...], unreachable, notIdrac, authFailed, registered, error? }
centralRouter.post('/idrac-scan-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setIdracScanResult(String(b.reqId), b);
  // 위임 스캔이 에이전트 현지에 서버를 등록했으면, 그 전력은 '원격 수집(collector pull)'로 중앙에
  // 반영된다. 다음 정기 풀(최대 60s)을 기다리지 않고 즉시 + 지연(에이전트 전력 수집 시간 고려)으로
  // 당겨와 반영을 앞당긴다. best-effort(실패 무시).
  if (Number(b.registered) > 0) {
    pullCollectorsNow().catch(() => {});
    setTimeout(() => pullCollectorsNow().catch(() => {}), 30_000).unref?.();
  }
  res.json({ ok: true });
});

// 게스트 GPU 수집 위임: ESXi 망에 닿는 현장 agent가 게스트 OS(nvidia-smi)에서 수집한
// GPU 사용률을 push. 중앙은 포탈이 ESXi에 직접 못 가는 환경에서 이 값을 오버레이로 사용.
// Body: { agent, hosts:[{hostId,utilPct}], vms:[{vmId,utilPct,memUsedPct,host,vcenterId}] }
centralRouter.post('/gpu-guest-data', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  let hosts = Array.isArray(b.hosts) ? b.hosts.slice(0, 50_000) : [];
  let vms = Array.isArray(b.vms) ? b.vms.slice(0, 500_000) : [];
  // 엣지 간 쓰기 격리: hostId/vmId 는 `${vc.id}:${moRef}` 네임스페이스다. 개별 토큰(agent 모드)일 때,
  // 그 vCenter 를 소유(최초 등록)한 엣지가 아니면 그 항목을 버린다 — 한 엣지가 남의 vCenter GPU
  // 오버레이를 덮어쓰는 것을 차단(/inventory TOFU 소유권과 동일 모델). 미등록 vCenter(owner='')는
  // TOFU 로 통과. 공유 토큰은 어느 엣지인지 알 수 없어 검사 생략(완전 봉인=CENTRAL_REQUIRE_AGENT_TOKEN).
  if (req.centralAuth.mode === 'agent') {
    // hostId/vmId 는 `${vc.id}:${moRef}`. vc.id 자체가 콜론을 포함할 수 있어(registry 가 콜론 허용)
    // 첫 콜론 기준 단순 분리로는 vcId 를 잘못 뽑아 소유권 검사가 우회된다. 등록된 vcenterId 중 이 id 의
    // 프리픽스인 것(가장 긴 것)으로 소유 vCenter 를 판정한다(최장 프리픽스 매칭).
    const invOwners = listInventory().map((e) => ({ vc: String(e.vcenterId || ''), agent: String(e.agent || '') }));
    // direct-mode(중앙 직접 수집) vCenter 의 GPU 는 로컬 폴러(agent='')만 기록해야 한다 — 엣지는
    // 그 vCenter 를 수집하지 않으므로 어떤 엣지의 쓰기도 위조다. collectMode!=='site' = direct.
    const directIds = (() => {
      try { return (loadVcenterConfig().vcenters || []).filter((v) => (v.collectMode || 'direct') !== 'site').map((v) => String(v.id)); }
      catch { return []; }
    })();
    const ownsVc = (id) => {
      const s = String(id || '');
      let owner = ''; let best = -1; let direct = false;
      // 등록된 vcenterId 중 이 id 의 프리픽스(가장 긴 것)로 소유 vCenter 판정 — vc.id 에 콜론이
      // 있어도(registry 가 콜론 허용) 안전하게 매칭(단순 split(':') 오파싱 방지).
      for (const e of invOwners) {
        if (e.vc && (s === e.vc || s.startsWith(`${e.vc}:`)) && e.vc.length > best) { best = e.vc.length; owner = e.agent; }
      }
      for (const vc of directIds) {   // direct-mode 도 최장 프리픽스로 — site 와 동률이면 direct 우선(안전측 거부)
        if ((s === vc || s.startsWith(`${vc}:`)) && vc.length >= best) { best = vc.length; direct = true; }
      }
      if (direct) return false;       // direct-mode = 중앙 소유, 엣지 쓰기 금지(잔여 위조 봉인)
      return !owner || owner.toLowerCase() === agent.toLowerCase();  // 미등록 site = TOFU 통과(부트스트랩)
    };
    const hBefore = hosts.length; const vBefore = vms.length;
    hosts = hosts.filter((h) => ownsVc(h.hostId));
    vms = vms.filter((v) => ownsVc(v.vmId));
    const dropped = (hBefore - hosts.length) + (vBefore - vms.length);
    if (dropped) console.warn(`[central] gpu-guest-data: ${agent} 가 소유하지 않은 vCenter 항목 ${dropped}개 드롭(위조 방지)`);
  }
  setGuestGpu({ hosts, vms, agent });
  if (b.diag) setGpuGuestDiag(agent, b.diag, { hosts: hosts.length, vms: vms.length }); // 수집 진단 보관
  console.log(`[central] gpu-guest-data 수신: agent=${agent} hosts=${hosts.length} vms=${vms.length}`);
  res.json({ ok: true, agent, hosts: hosts.length, vms: vms.length });
});

// 중앙→엣지 GPU 게스트 설정 배포(pull): 엣지가 자기 이름으로 배포 설정을 가져가 로컬 적용.
// 폐쇄망/NAT 엣지도 아웃바운드 GET만으로 동작. 비밀번호 포함(엣지가 실제 인증에 사용) → 토큰 필수.
// GET /api/central/gpu-guest-config?agent=<이름>
centralRouter.get('/gpu-guest-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const settings = getAssignedGpuGuest(agent);
  if (!settings) return res.json({ ok: true, agent, assigned: false }); // 지정 없음 → 엣지는 로컬 설정 유지
  const { _updatedAt, ...s } = settings;
  res.json({ ok: true, agent, assigned: true, at: _updatedAt || 0, settings: s });
});

// 중앙→엣지 배포 사용자(pull): 엣지가 자기 이름으로 '중앙이 지정한 사용자 목록'을 가져가 로컬
// users.json에 managed로 반영. 비밀번호 해시 포함(엣지가 로그인 검증에 사용) → 토큰 필수.
// ── 스토리지 모니터링 위임(v2.302) ────────────────────────────────────────────
// GET /api/central/storage-config?agent=<이름> — 이 엣지 몫 스토리지 장비 목록(자격증명 포함:
// 엣지가 장비에 로그인해야 한다 — gpu-guest-config 의 계정 배포와 같은 신뢰 경계·WAN TLS 검증 ON).
// 개별 토큰이면 바인딩된 agent 와 요청 agent 불일치를 거부(자격증명 횡탈 차단 — 헤더 규약 2).
centralRouter.get('/storage-config', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  if (req.centralAuth?.mode === 'agent' && String(req.centralAuth.agent).toLowerCase() !== agent.toLowerCase()) {
    return res.status(403).json({ ok: false, reason: '토큰의 agent 와 요청 agent 불일치' });
  }
  const { devicesForAgent } = await import('../storage/registry.js');
  // collectNow(v2.316): 중앙 UI 의 '수집' 클릭이 남긴 재수집 요청을 one-shot 으로 서빙 —
  // 엣지는 이 목록을 즉시 수집 + 즉시 push 한다(agent/storageConfigPull.js 참조).
  const { takeRequestsForAgent } = await import('../storage/collectRequests.js');
  res.json({ ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent) });
});

// POST /api/central/storage-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
// **인증된 agent**(개별 토큰 바인딩)만 쓴다. 공유 토큰(레거시)은 body.agent 신뢰(TOFU — 기존 축과 동일).
centralRouter.post('/storage-data', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : String(req.body?.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { saveEdgeStorage } = await import('../central/storageEdge.js');
  const saved = saveEdgeStorage(agent, req.body?.devices || []);
  res.json({ ok: true, saved });
});

// GET /api/central/users-config?agent=<이름>
centralRouter.get('/users-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  // 글로벌('*') 공통 사용자 + 이 엣지 전용을 합쳐서 반환(개별이 글로벌보다 우선).
  res.json({ ok: true, agent, users: getEffectiveUsers(agent) });
});

// 위임 Ping: 현장 에이전트가 자기 담당 vCenter들의 대기 IP를 인출 → ping → 결과 보고.
// 중앙이 VM 사설 IP에 직접 못 가는 환경에서, 그 망에 닿는 에이전트가 ping을 대행.
centralRouter.get('/ping-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 개별 토큰은 자기가 소유한 vCenter 의 대기 ping 작업만 인출(남의 사이트 대상 IP 목록 가로채기 차단).
  if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
  res.json({ ok: true, jobs: takePingJobs(vcs) });
});

// Body: { vcenterId, results:[{ ip, alive, rttMs }] }
centralRouter.post('/ping-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  // 개별 토큰은 자기 소유 vCenter 의 도달성만 보고(남의 사이트 상태 위조 차단).
  if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(req.centralAuth.agent, b.vcenterId)) {
    return res.status(403).json({ ok: false, reason: `vcenterId '${b.vcenterId}'는 '${req.centralAuth.agent}' 소유가 아닙니다.` });
  }
  setPingResults(String(b.vcenterId), Array.isArray(b.results) ? b.results.slice(0, 200) : []);
  res.json({ ok: true, count: Array.isArray(b.results) ? b.results.length : 0 });
});

// 엣지 설정 push: 에이전트가 자기 CONFIG_DIR 설정을 보내 중앙 통합 백업에 합쳐지게 한다.
// Body: { agent, files:{ name: content } }
centralRouter.post('/agent-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  // 저장 키는 개별 토큰이면 토큰 해석 agent 강제(body.agent 로 남의 통합백업 config 위조 차단).
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  if (!agent || !b.files || typeof b.files !== 'object') return res.status(400).json({ ok: false, reason: 'agent·files가 필요합니다.' });
  // 파일 수/크기 상한(남용 방지).
  const files = {};
  let n = 0;
  for (const [k, v] of Object.entries(b.files)) { if (n++ >= 200) break; if (typeof v === 'string' && v.length <= 8_000_000) files[require_basename(k)] = v; }
  setAgentConfig(agent.slice(0, 120), files);
  console.log(`[central] agent-config 수신: agent=${agent} (${Object.keys(files).length}개)`);
  res.json({ ok: true, agent, files: Object.keys(files).length });
});
function require_basename(p) { return String(p).split(/[\\/]/).pop().slice(0, 200); }

// 엣지 로그 연합 조회: 에이전트가 자기 vCenter들의 대기 조회를 인출 → 로컬 로그 DB 조회 → 결과 보고.
centralRouter.get('/log-queries', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 개별 토큰은 자기 소유 vCenter 의 대기 조회만 인출(운영자 검색 필터·계정명 유출 차단).
  if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
  res.json({ ok: true, queries: takeLogQueries(vcs) });
});
// Body: { reqId, vcenterId, total, rows, dbKind }
centralRouter.post('/log-query-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  // 개별 토큰은 자기 소유 vCenter 의 reqId 결과만 보고(위조 로그 주입 차단). reqId 의 진짜 vCenter 는
  // 발급 시각에 기록해 둔 값(vcenterOfReq)으로 판정 — body 값(위조 가능)이 아니다. 미상 reqId 는 무시.
  if (req.centralAuth.mode === 'agent') {
    const vc = vcenterOfReq(b.reqId);
    if (!vc || !agentOwnsVcenter(req.centralAuth.agent, vc)) {
      return res.status(403).json({ ok: false, reason: '이 reqId 는 소유하지 않은(또는 만료된) 조회입니다.' });
    }
  }
  setLogQueryResult(String(b.reqId), b);
  res.json({ ok: true });
});

// 위임 tcpdump 캡처: 에이전트가 자기 이름의 대기 캡처 작업을 인출 → 로컬 SSH 캡처 → 결과 보고.
centralRouter.get('/capture-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeCaptureJobs(String(req.query.agent || '')) });
});
// Body: { reqId, result }
centralRouter.post('/capture-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, captureAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setCaptureResult(String(b.reqId), b.result || { ok: false, reason: '빈 결과' });
  try { if (b.result?.ok) recordCapture(b.result, { source: 'manual', via: 'agent' }); } catch { /* */ }
  res.json({ ok: true });
});

// 베어메탈 스토리지 폴링 위임(v2.341): 엣지가 자기 이름의 df 수집 잡을 인출(claim) →
// 현지 SSH 수집 → 결과 회신(ack). 캡처/iDRAC 스캔과 동일한 claim→ack + 소유권 검증.
centralRouter.get('/bmstor-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeBmstorJobs(String(req.query.agent || '')) });
});
// Body: { reqId, results: [{ id, ok, mounts, missing?, error? }] } — 비밀번호 없음(용량 수치만).
centralRouter.post('/bmstor-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, bmstorAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  const ackd = ackBmstorJob(String(b.reqId));
  if (!ackd) return res.json({ ok: true, stale: true }); // TTL 정리/중복 회신 — 무해하게 무시
  // 결과는 **그 잡에 실제로 할당된 서버 id 로만** 반영한다 — 인증된 엣지가 b.results 에 남의
  // 서버 id 를 끼워 넣어 그 서버의 latest 용량 수치를 위조하는 것을 차단(잡 소유권 = 서버 소유권).
  const owned = new Set((ackd.serverIds || []).map(String));
  const results = (Array.isArray(b.results) ? b.results : []).filter((r) => r && owned.has(String(r.id)));
  applyBmstorResults(ackd.agent, results);
  res.json({ ok: true });
});

// Agent pulls its IP-scan assignment (TCP connect scan config) by name.
centralRouter.get('/ip-scan-assignment', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const cfg = loadScanSettings(String(req.query.agent || ''));
  if (!cfg.enabled || !cfg.ranges.length) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, ...cfg });
});

// Agent posts its IP-scan result. Body: { agent, alive:[{ip,openPorts,services,hostname}] }
centralRouter.post('/ip-scan-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  let alive = Array.isArray(b.alive) ? b.alive.slice(0, 8000) : [];
  // 개별 토큰은 자기 배정 스캔 ranges 안의 IP 만 보고할 수 있다(범위 밖 임의 IP 의 열린포트·소유
  // agent 위조 차단 — gpu-guest-data 소유권 필터와 동일 모델). ranges 미설정 agent 는 통과(TOFU).
  // ⚠️ ranges 는 **필터 진입 전 1회 로드·컴파일**한다 — IP 마다 loadScanSettings(무캐시 파일 읽기)를
  // 부르면 8,000개 보고에 동기 read 8,000회로 이벤트 루프가 막힌다(CLAUDE.md 논블로킹 불변조건).
  if (req.centralAuth.mode === 'agent') {
    const bounds = ((loadScanSettings(agent)?.ranges) || []).map(specToRange).filter(Boolean);
    if (bounds.length) {   // ranges 미설정이면 전량 통과(TOFU) — 기존 동작 유지
      const before = alive.length;
      alive = alive.filter((h) => { const n = h && ipToNum(h.ip); return n != null && bounds.some((r) => n >= r.lo && n <= r.hi); });
      if (before !== alive.length) console.warn(`[central] ip-scan-result: ${agent} 배정 범위 밖 IP ${before - alive.length}개 드롭(위조 방지)`);
    }
  }
  if (alive.length) mergeScanResults(alive, Date.now(), agent);
  recordAgentReport(agent, { scanned: b.scanned || 0, alive: alive.length, durationMs: b.durationMs || null });
  res.json({ ok: true, merged: alive.length });
});
