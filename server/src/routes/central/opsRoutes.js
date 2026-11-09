/**
 * routes/central/opsRoutes.js — Veeam · Bareos · 핑 · 엣지 설정 · 로그 · 캡처 · VM 백업 · 베어메탈 스토리지 · IP 스캔 · 통신 점검
 *
 * v2.954(개선 검토 4번 — 사용자 선택 '동작 그대로 영역별 파일 이동'): routes/central.js(2,966줄)에서 이 영역의 엣지 수신 · 설정 인출 라우트를
 *   **글자 그대로** 옮겼다. 등록은 central.js 가 원래 자리에서 `registerOpsRoutes(centralRouter)` 로 부른다 — 라우트 순서 · 미들웨어 · 응답이 같다
 *   (회귀 `test/centralSplit2954.test.js` 가 분할 전 라우트 표와 기계 대조한다). 공용 판정(requireCentral · 503 응답 등)은 central.js 의 것을 그대로 쓴다.
 */
import { ackBmstorJob, bmstorAgentOfReq, bmstorJobKnown, lateBmstorResult, takeBmstorJobs } from '../../bmstor/jobs.js';
import { applyBmstorResults } from '../../bmstor/poller.js';
import { setAgentConfig } from '../../central/agentConfig.js';
import { getEffectiveUsers, registryLoadError as agentUsersLoadError } from '../../central/agentUsers.js';
import { applyCaptureResult, captureAgentOfReq, takeCaptureJobs } from '../../central/captureJobs.js';
import { REJECT_KIND } from '../../central/ingestReject.js';
import { listInventory } from '../../central/inventory.js';
import { putEdgeLinkReport } from '../../central/linkCheckEdge.js';
import { setLogQueryResult, takeLogQueries, vcenterOfReq } from '../../central/logQueries.js';
import { setPingResults, takePingJobs } from '../../central/pingJobs.js';
import { listCollectors as listCollectorsForLinks, registryLoadError as collectorsRegistryLoadError } from '../../collector/registry.js';
import { config, currentVersion, loadVcenterConfig } from '../../config.js';
import { instanceId } from '../../instanceId.js';
import { ipToNum } from '../../ipam/ledger.js';
import { specToRange } from '../../ipam/rangePolicies.js';
import { recordScanLog } from '../../ipam/scanLog.js';
import { loadScanSettings, mergeScanResults, recordAgentIncomplete, recordAgentReport, scanSettingsLoadError } from '../../ipam/scanStore.js';
import { EDGE_KINDS, buildLinks, publicLink } from '../../linkcheck/links.js';
import { linkCheckEnabled, linkCheckSettingsLoadError, loadLinkCheckSettings } from '../../linkcheck/settings.js';
import { recordCapture } from '../../net/captureHistory.js';
import { getDataSource as getDataSourceForVmClone } from '../../runtime-settings.js';
import { capStr } from '../../util/capStr.js';
import { strOf } from '../../util/coercionTrap.js';
import { listRegistry as listVcentersForLinks } from '../../vcenter/registry.js';
import fs from 'node:fs';
import path from 'node:path';
// central.js 의 공용 판정 — 등록 때 인자로 받는다(import 하면 central.js ↔ 이 파일 순환이 생긴다 — archScan IMPORT_CYCLE_MAX)
let PERSISTENT_503_HEADERS, agentOwnsVcenter, edgeVcWriteDenied, persistent503, registryUnreadable, reqAgentDenied, requireCentral, settingsUnreadable, strAgent;

// ── Veeam 백업 상태 위임(v2.751) — vCenter 와 같은 법인에 있는 Veeam B&R 을 그 엣지가 REST 로 읽는다 ────────────────
// GET /api/central/veeam-config?agent=<이름> — 이 엣지 몫 Veeam 서버(자격증명 포함: 엣지가 Veeam 에 로그인해야 한다 —
// WAN TLS 검증 ON). **개별(엣지별) 토큰만** 받는다 — 이 파일 머리말의 신규 라우트 규약 1·2(v2.751 검토 #5): 공유 CENTRAL_TOKEN 은
// 어느 엣지의 것인지 가릴 수 없어 `?agent=<아무 엣지>` 로 그 엣지의 Veeam 비밀번호를 받아 갈 수 있다(storage-config 의 레거시 동작을
// 새 라우트에 복사하지 않는다). 공유 토큰 엣지는 설정 › 수집 서버에서 그 엣지의 개별 토큰을 발급해야 Veeam 위임을 쓴다.
// 등록부를 못 읽으면 503(빈 목록을 ok 로 주면 엣지가 사본을 지운다 — v2.612).
const VEEAM_AGENT_TOKEN_ONLY = 'Veeam 위임은 엣지별(개별) 토큰으로만 받습니다 — 공유 CENTRAL_TOKEN 으로는 엣지를 가릴 수 없습니다. 중앙 설정 › 엣지·원격 › 수집 서버(원격)에서 이 엣지의 개별 토큰을 발급해 엣지 CENTRAL_TOKEN 에 넣으세요.';

// v2.763(V2-3): 403 의도(v2.751 검토 #5)는 그대로 — 거부 기록의 사유만 사실대로('토큰 불일치' 가 아니라 '개별 토큰 필요').
const veeamAgentTokenOnly = (res) => {
  res.locals.ingestReject = { kind: REJECT_KIND.AUTH, reason: '개별 토큰 필요 — 공유 토큰으로는 Veeam 위임을 받지 않습니다(토큰 자체는 맞습니다)' };
  return res.status(403).json({ ok: false, reason: VEEAM_AGENT_TOKEN_ONLY, agentTokenRequired: true });
};

/**
 * Bareos 법인 Director 엣지 대행(v2.824 — bareos/edgeOps.js · 선례 veeam-run-*). **개별 토큰 전용**(이 파일 머리말 신규 라우트 3규약):
 *  · GET  /bareos-config     — 이 엣지가 대행하는 Director(설정 agent = 이 엣지)의 접속값(콘솔 비밀번호 포함 — 엣지가 로그인해야 한다 · WAN TLS 검증 ON).
 *                              설정을 못 읽으면 503(빈 목록을 ok 로 주면 엣지가 사본을 지운다).
 *  · GET  /bareos-ops        — 자기 몫 작업 인출(콘솔 비밀번호 없음 · 자동 설정 대행만 1회용 secretArgs — 인출 즉시 중앙 메모리에서 지운다).
 *  · POST /bareos-op-result  — 회신(그 작업의 대상 엣지만 · 결과는 sanitizeEdgeResult).
 * 키는 req.centralAuth.agent 만(요청의 agent 값으로 고르지 않는다 — 공통 미들웨어가 토큰 ↔ agent 를 대조한다).
 */
const BAREOS_AGENT_TOKEN_ONLY = 'Bareos 법인 Director 대행은 엣지별(개별) 토큰으로만 받습니다 — 공유 CENTRAL_TOKEN 으로는 엣지를 가릴 수 없습니다. 중앙 설정 › 엣지·원격 › 수집 서버(원격)에서 이 엣지의 개별 토큰을 발급해 엣지 CENTRAL_TOKEN 에 넣으세요.';

const bareosAgentTokenOnly = (res) => {
  res.locals.ingestReject = { kind: REJECT_KIND.AUTH, reason: '개별 토큰 필요 — 공유 토큰으로는 Bareos 대행을 받지 않습니다(토큰 자체는 맞습니다)' };
  return res.status(403).json({ ok: false, reason: BAREOS_AGENT_TOKEN_ONLY, agentTokenRequired: true });
};

/** v2.600 RECENT2600-05 — 엣지 설정 사본 파일 1개 길이 상한 = 엣지 수집 상한(backup/service.js FILE_SIZE_CAP, 8MiB). */
export const AGENT_CONFIG_FILE_MAX = 8 * 1024 * 1024;

function require_basename(p) { return String(p).split(/[\\/]/).pop().slice(0, 200); }

// ── VM 백업 센터 법인 위임(v2.793) — vmclone/dispatch.js · agent/vmCloneWorker.js ──────────────────────────────
// 엣지는 자기 담당 vCenter(등록값 remoteAgent 우선, 없으면 그 vCenter 인벤토리를 올린 엣지 — 둘이 다르면 어느 쪽에도 맡기지 않는다)의
// 백업 잡 정의를 당기고, 인출한 작업(지금 실행·검증·복구·NFS 데이터스토어 연결)을 실행한 뒤 상태·회신을 올린다.
// 3규약(이 파일 머리): 개별 토큰(agent 모드)만 · 저장 키는 req.centralAuth.agent 만 · 엣지는 X-Agent-Name 을 붙인다.
function vmCloneAgentOnly(req, res) {
  if (req.centralAuth.mode === 'agent') return req.centralAuth.agent;
  res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(공유 CENTRAL_TOKEN 으로는 어느 법인의 백업인지 신뢰할 수 없습니다). 설정 > 엣지 토큰에서 이 엣지의 토큰을 발급해 주세요.' });
  return null;
}

/** vCenter 등록부·위임 인벤토리 → 실행 위치. 등록부 파일이 있는데 읽지 못했으면 null(빈 목록으로 답하지 않는다). */
async function vmCloneTargets() {
  const cfg = loadVcenterConfig();
  if (!cfg.file && fs.existsSync(path.join(config.configDir, 'vcenters.json'))) return null;
  const { execTargets } = await import('../../vmclone/dispatch.js');
  return execTargets(cfg.vcenters || [], listInventory(), { mock: isMockModeForVmClone() });
}

// 데모(mock) 중앙은 엣지에 위임하지 않는다(데모 법인 잡은 중앙이 시뮬레이션한다 — vmclone/scheduler.js).
function isMockModeForVmClone() { try { return getDataSourceForVmClone() === 'mock'; } catch { return false; } }

/** central.js 가 원래 자리에서 부른다(등록 순서 유지). */
export function registerOpsRoutes(centralRouter, deps) {
  ({ PERSISTENT_503_HEADERS, agentOwnsVcenter, edgeVcWriteDenied, persistent503, registryUnreadable, reqAgentDenied, requireCentral, settingsUnreadable, strAgent } = deps);
  centralRouter.get('/veeam-config', requireCentral(), async (req, res) => {
    if (req.centralAuth?.mode !== 'agent') return veeamAgentTokenOnly(res);
    const agent = req.centralAuth.agent;
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const R = await import('../../veeam/registry.js');
    if (registryUnreadable(res, R.registryLoadError, 'Veeam 서버')) return;
    res.set('Cache-Control', 'no-store');
    // v2.754: 'Veeam 계정' — 사람이 적은 것 + 중앙이 배운 것. 엣지가 자기 vCenter 이벤트에서 Veeam 스냅샷을 가리는 데 쓴다(비밀 아님).
    const S = await import('../../veeam/snapEvents.js');
    //   계정 파일을 못 읽었으면 필드를 싣지 않는다(빈 목록을 보내면 엣지 사본이 지워진다 — 엣지는 필드가 없으면 그대로 둔다, v2.754 검토 #4).
    res.json({ ok: true, agent, servers: R.serversForAgent(agent), ...(S.accountsUnreadable() ? {} : { vcAccounts: S.veeamAccounts() }) });
  });

  // POST /api/central/veeam-data — 엣지가 읽은 Veeam 결과. 저장 이름은 인증된 agent · 그 엣지에 배정된 서버 id 만 받는다.
  // 결과가 0건이어도 상태는 받는다(엣지 무음 실패 금지 규약). 결과가 있는데 등록부를 못 읽으면 503(엣지는 다음 주기에 다시 보낸다).
  centralRouter.post('/veeam-data', requireCentral(), async (req, res) => {
    if (req.centralAuth?.mode !== 'agent') return veeamAgentTokenOnly(res); // v2.751 검토 #5
    const agent = req.centralAuth.agent;
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const E = await import('../../central/veeamEdge.js');
    // v2.754: 엣지가 직접 이벤트를 모으는 vCenter 의 'Veeam 계정 스냅샷 생성' 요약 — 그 엣지가 맡은 site vCenter 만 받는다
    //   (위임 인벤토리 소유자 일치 + edgeVcWriteDenied(requireSite)). 정제는 veeam/snapEvents.js sanitizeEdgeSnap.
    let snap = null;
    if (Array.isArray(req.body?.snapEvents)) {
      const S = await import('../../veeam/snapEvents.js');
      // 소유권은 TOFU 없이 — 그 site vCenter 의 위임 인벤토리를 실제로 보내는 엣지만(인벤토리가 아직 없으면 받지 않는다 — 다음 push 에 다시 온다).
      const inv = new Map(listInventory().map((e) => [String(e.vcenterId), String(e.agent || '').toLowerCase()]));
      const me = String(agent).toLowerCase();
      const r = S.sanitizeEdgeSnap(req.body.snapEvents, (vcId) => inv.get(vcId) === me && !edgeVcWriteDenied(vcId, { requireSite: true }));
      S.putEdgeSnap(agent, r.items);
      snap = { saved: r.items.length, ...(r.dropped.notOwned || r.dropped.bad ? { dropped: r.dropped } : {}) };
      if (r.dropped.notOwned) console.warn(`[central] veeam-data: ${String(agent).slice(0, 64)} 가 맡지 않은 vCenter 의 이벤트 요약 ${r.dropped.notOwned}건 거절`);
    }
    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    if (!results.length) { const at = Date.now(); E.saveVeeamEdgeStatus(agent, req.body?.status, { at, results: 0, saved: 0 }, { clockOffsetMs: E.edgeClockOffset(req.body, at), now: at }); return res.json({ ok: true, saved: 0, ...(snap ? { snap } : {}) }); }
    const R = await import('../../veeam/registry.js');
    if (registryUnreadable(res, R.registryLoadError, 'Veeam 서버')) { console.warn('[central] veeam-data: 중앙 Veeam 서버 등록부를 읽지 못해 503 으로 답했습니다(엣지는 다음 주기에 다시 보냅니다)'); return; }
    // v2.762(G1): id → 지금 접속처 지문 — 접속처를 바꾼 뒤 옛 접속처에서 읽은 결과(엣지가 아직 pull 전)를 받지 않는다.
    const owned = new Map(R.serversForAgent(agent).map((d) => [d.id, R.accessFingerprint(d)]));
    const r = E.ingestVeeamPush(agent, req.body || {}, owned);
    if (r.dropped.notOwned) console.warn(`[central] veeam-data: ${String(agent).slice(0, 64)} 배정되지 않은 서버 결과 ${r.dropped.notOwned}건 거절`);
    const rejected = r.dropped.notOwned + r.dropped.bad + (r.dropped.stale || 0);
    res.json({ ok: true, saved: r.saved, ...(rejected ? { rejected, dropped: r.dropped } : {}), ...(snap ? { snap } : {}) });
  });

  // GET /api/central/users-config?agent=<이름>
  centralRouter.get('/users-config', requireCentral(), (req, res) => {
    const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    if (registryUnreadable(res, agentUsersLoadError, '엣지 배포 사용자')) return;
    // 글로벌('*') 공통 사용자 + 이 엣지 전용을 합쳐서 반환(개별이 글로벌보다 우선).
    res.json({ ok: true, agent, users: getEffectiveUsers(agent) });
  });

  // 위임 Ping: 현장 에이전트가 자기 담당 vCenter들의 대기 IP를 인출 → ping → 결과 보고.
  // 중앙이 VM 사설 IP에 직접 못 가는 환경에서, 그 망에 닿는 에이전트가 ping을 대행.
  /**
   * Backup 백업 실행 대행(v2.818 — veeam/run/edgeOps.js). **개별 토큰 전용**(svcmon-report 3규약): 담당 엣지가 자기 몫 작업을 인출해
   * 현지 Veeam 에 보내고 결과를 회신한다. 작업에는 비밀번호가 없다(서버 id 뿐 — 엣지는 중앙이 배정한 자기 등록부 사본으로 로그인한다).
   * 키는 req.centralAuth.agent 만. 회신은 그 작업의 대상 엣지만(completeEdgeOp 대조) · 결과는 작업 종류의 sanitize 를 지난다.
   */
  centralRouter.get('/veeam-run-ops', requireCentral(), async (req, res) => {
    if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: 'Veeam 백업 실행 대행은 엣지별 개별 토큰만 허용합니다 — 설정 › 엣지 토큰에서 이 엣지의 토큰을 발급하세요.' });
    const { takeEdgeOps } = await import('../../veeam/run/edgeOps.js');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ops: takeEdgeOps(req.centralAuth.agent) });
  });

  // Body: { id, result }
  centralRouter.post('/veeam-run-result', requireCentral({ notFound: { ok: false } }), async (req, res) => {
    if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: 'Veeam 백업 실행 대행은 엣지별 개별 토큰만 허용합니다.' });
    const id = typeof req.body?.id === 'string' ? req.body.id.slice(0, 64) : '';
    if (!id) return res.status(400).json({ ok: false, reason: 'id 가 필요합니다(글자).' });
    const { completeEdgeOp } = await import('../../veeam/run/edgeOps.js');
    const r = completeEdgeOp(id, req.centralAuth.agent, req.body?.result);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason });
    res.json(r);
  });

  centralRouter.get('/bareos-config', requireCentral(), async (req, res) => {
    if (req.centralAuth?.mode !== 'agent') return bareosAgentTokenOnly(res);
    const agent = req.centralAuth.agent;
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const S = await import('../../bareos/settings.js');
    if (registryUnreadable(res, S.settingsLoadError, 'Bareos Director 설정')) return;
    const me = String(agent).trim().toLowerCase();
    res.set('Cache-Control', 'no-store');
    // connSig: 작업과 사본이 같은 접속값인지 엣지가 대조하는 표지(v2.824 검토 I1 — 비밀번호를 풀 수 없는 HMAC)
    res.json({ ok: true, agent, directors: S.loadSettings().directors.filter((d) => String(d.agent || '').trim().toLowerCase() === me).map((d) => ({ ...d, connSig: S.directorConnSig(d) })) });
  });

  centralRouter.get('/bareos-ops', requireCentral(), async (req, res) => {
    if (req.centralAuth?.mode !== 'agent') return bareosAgentTokenOnly(res);
    const { takeEdgeOps, TAKE_MAX } = await import('../../bareos/edgeOps.js');
    // max: 엣지 워커의 빈 자리(v2.824 검토 P2) — 없거나 틀리면 기본 상한
    const max = /^[0-9]{1,2}$/.test(String(req.query.max ?? '')) ? Number(req.query.max) : TAKE_MAX;
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ops: takeEdgeOps(req.centralAuth.agent, max) });
  });

  // Body: { id, result }
  centralRouter.post('/bareos-op-result', requireCentral({ notFound: { ok: false } }), async (req, res) => {
    if (req.centralAuth?.mode !== 'agent') return bareosAgentTokenOnly(res);
    const id = typeof req.body?.id === 'string' ? req.body.id.slice(0, 64) : '';
    if (!id) return res.status(400).json({ ok: false, reason: 'id 가 필요합니다(글자).' });
    const { completeEdgeOp } = await import('../../bareos/edgeOps.js');
    const r = completeEdgeOp(id, req.centralAuth.agent, req.body?.result);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason });
    res.json(r);
  });

  centralRouter.get('/ping-jobs', requireCentral(), (req, res) => {
    let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 개별 토큰은 자기가 소유한 vCenter 의 대기 ping 작업만 인출(남의 사이트 대상 IP 목록 가로채기 차단).
    if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
    res.json({ ok: true, jobs: takePingJobs(vcs) });
  });

  // Body: { vcenterId, results:[{ ip, alive, rttMs }] }
  centralRouter.post('/ping-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
    const b = req.body || {};
    const vcId = strOf(b.vcenterId, 256); // v2.603 CEN2603-05: 글자·수만(객체면 String() 이 던졌다)
    if (!vcId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다(글자).' });
    // 개별 토큰은 자기 소유 vCenter 의 도달성만 보고(남의 사이트 상태 위조 차단).
    if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(req.centralAuth.agent, b.vcenterId)) { // vcId 검사로 b.vcenterId 는 글자·수다
      return res.status(403).json({ ok: false, reason: `vcenterId '${vcId.slice(0, 128)}'는 '${req.centralAuth.agent}' 소유가 아닙니다.` });
    }
    // v2.600(CEN2600-02): direct vCenter 의 도달성은 중앙이 직접 잰다(v2.590 P11 — 엣지 큐에 올리지 않는다) — 엣지 보고는 위조다.
    // v2.603(감사 CEN2603-06): **사이트 위임으로 등록된 vCenter 만** 받는다(requireSite). 예전에는 등록되지 않은 id 도 받아
    //   새 id 를 연달아 보내면 결과 Map 의 256개 상한에서 실제 vCenter 의 결과가 밀려났다(pingJobs.sweepResults).
    const pingDeny = edgeVcWriteDenied(vcId, { requireSite: true });
    if (pingDeny) return res.status(403).json({ ok: false, reason: pingDeny });
    setPingResults(vcId, Array.isArray(b.results) ? b.results.slice(0, 200) : []);
    res.json({ ok: true, count: Array.isArray(b.results) ? b.results.length : 0 });
  });

  // 엣지 설정 push: 에이전트가 자기 CONFIG_DIR 설정을 보내 중앙 통합 백업에 합쳐지게 한다.
  // Body: { agent, files:{ name: content } }
  centralRouter.post('/agent-config', requireCentral(), (req, res) => {
    const b = req.body || {};
    // 저장 키는 개별 토큰이면 토큰 해석 agent 강제(body.agent 로 남의 통합백업 config 위조 차단).
    const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
    if (!agent || !b.files || typeof b.files !== 'object') return res.status(400).json({ ok: false, reason: 'agent·files가 필요합니다.' });
    // 파일 수/크기 상한(남용 방지).
    // v2.600(감사 RECENT2600-05): 길이 상한은 엣지의 수집 상한(backup/service.js FILE_SIZE_CAP = 8MiB 바이트)과 같아야 한다 —
    //   예전 8,000,000 은 그보다 작아 8,000,001~8,388,608 사이 파일이 **기록도 개수도 없이** 사라졌다. UTF-8 에서 글자 수 ≤ 바이트 수이므로
    //   8MiB 바이트 이하 파일은 전부 통과한다. 그래도 빠진 파일은 이름을 응답·로그에 밝힌다(조용한 상한 금지).
    const files = {};
    const lenOmitted = [];
    let n = 0;
    for (const [k, v] of Object.entries(b.files)) {
      if (n++ >= 200) { lenOmitted.push({ name: require_basename(k), reason: 'count' }); continue; }
      if (typeof v !== 'string') { lenOmitted.push({ name: require_basename(k), reason: 'not-string' }); continue; }
      if (v.length > AGENT_CONFIG_FILE_MAX) { lenOmitted.push({ name: require_basename(k), reason: 'too-large', length: v.length }); continue; }
      files[require_basename(k)] = v;
    }
    // v2.621(감사 RECENT-09): 엣지가 413 으로 보내지 못한 파일 이름(retainFiles) — 그 파일은 직전 사본을 유지한다(교체로 지우지 않는다).
    //   이름만 받는다(내용은 이미 중앙에 있는 것만 쓴다). 상한 50개 · basename · 이번 본문에 있는 이름은 무시.
    const retainAsked = Array.isArray(b.retainFiles);
    const retain = retainAsked
      ? [...new Set(b.retainFiles.slice(0, 50).filter((x) => typeof x === 'string' && x).map(require_basename))]
        .filter((n) => n && n !== '__proto__' && !Object.hasOwn(files, n))
      : [];
    const r = setAgentConfig(agent.slice(0, 120), files, { retain }) || {};
    if (r.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
    const lenNote = lenOmitted.length ? ` · 수신 상한으로 ${lenOmitted.length}개 제외(${lenOmitted.slice(0, 5).map((x) => `${x.name}:${x.reason}`).join(', ')}${lenOmitted.length > 5 ? ' …' : ''})` : '';
    (lenOmitted.length ? console.warn : console.log)(`[central] agent-config 수신: agent=${agent} (${Object.keys(files).length}개${r.omitted ? ` · 합계 상한으로 ${r.omitted}개 제외` : ''}${lenNote})`);
    // v2.621(감사 RECENT-09): retainFiles 를 받았으면 **항상** retained 를 싣는다(0 이어도) — 엣지는 이 필드의 유무로 '직전 사본 유지를
    //   아는 중앙' 인지 가른다(구버전 중앙은 모르고 사본을 교체한다 — 엣지가 그 사실을 상태·콘솔에 밝힌다).
    res.json({ ok: true, agent, files: Object.keys(files).length, ...(r.omitted ? { omitted: r.omitted } : {}), ...(retainAsked ? { retained: r.retained || 0, retainMissing: r.retainMissing || 0 } : {}), ...(lenOmitted.length ? { rejectedFiles: lenOmitted.slice(0, 50), rejectedFileCount: lenOmitted.length } : {}), ...(r.evicted ? { evicted: r.evicted } : {}) });
  });

  // 엣지 로그 연합 조회: 에이전트가 자기 vCenter들의 대기 조회를 인출 → 로컬 로그 DB 조회 → 결과 보고.
  centralRouter.get('/log-queries', requireCentral(), (req, res) => {
    let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 개별 토큰은 자기 소유 vCenter 의 대기 조회만 인출(운영자 검색 필터·계정명 유출 차단).
    if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
    res.json({ ok: true, queries: takeLogQueries(vcs) });
  });

  // Body: { reqId, vcenterId, total, rows, dbKind }
  centralRouter.post('/log-query-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
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
    // v2.600(CEN2600-02): 조회의 진짜 vCenter 가 direct 면 엣지 결과를 받지 않는다(중앙이 자기 로그 DB 로 답한다).
    //   ⚠ 미등록 id 는 거부하지 않는다 — 연합 조회의 원격 목록은 배정표에서 오고 중앙 등록부에 없을 수 있다(checksLogs.js).
    { const lqDeny = edgeVcWriteDenied(vcenterOfReq(b.reqId)); if (lqDeny) return res.status(403).json({ ok: false, reason: lqDeny }); }
    setLogQueryResult(String(b.reqId), b);
    res.json({ ok: true });
  });

  // 위임 tcpdump 캡처: 에이전트가 자기 이름의 대기 캡처 작업을 인출 → 로컬 SSH 캡처 → 결과 보고.
  centralRouter.get('/capture-jobs', requireCentral(), (req, res) => {
    res.json({ ok: true, jobs: takeCaptureJobs(String(req.query.agent || '')) });
  });

  // Body: { reqId, result }
  centralRouter.post('/capture-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
    const b = req.body || {};
    if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
    if (reqAgentDenied(req, captureAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
    // v2.622(감사 LEFT-03): 반영 결과를 본다 — 모르는 reqId 는 410 + 이력 미기록, 같은 결과의 재전송은 이력을 다시 적지 않는다.
    //   예전에는 반환값을 무시하고 200 + 이력 기록이라 화면('unknown')과 이력이 어긋났고, 소유자 미상 통과(TOFU)로 이력 행을 주입할 수 있었다.
    const applied = applyCaptureResult(String(b.reqId), b.result || { ok: false, reason: '빈 결과' });
    if (applied.unknown) return res.status(410).json({ ok: false, error: 'unknown-job', reason: '중앙에 이 캡처 잡이 없습니다(만료되었거나 중앙이 재시작됨) — 결과는 반영·이력 기록되지 않았습니다.' });
    if (applied.duplicate) return res.json({ ok: true, duplicate: true });
    // v2.600(CEN2600-09): 엣지 워커가 결과에 싣는 A 호스트(잡 spec.host)를 이력의 hostA 로 — 글자만, 제어문자 제거, 255자.
    const hostA = typeof b.result?.hostA === 'string' ? b.result.hostA.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) : '';
    try { if (b.result?.ok) recordCapture(b.result, { source: 'manual', via: 'agent', ...(hostA ? { hostA } : {}) }); } catch { /* */ }
    res.json({ ok: true, ...(applied.late ? { late: true } : {}) });
  });

  centralRouter.get('/vm-clone-sync', requireCentral(), async (req, res) => {
    const agent = vmCloneAgentOnly(req, res); if (!agent) return;
    const { jobsLoadError, listJobs: listCloneJobs } = await import('../../vmclone/store.js');
    // 잡 파일을 못 읽었으면 503 — 빈 목록을 내려보내면 엣지가 위임 잡을 지운다(v2.631 EDGE2631-01 과 같은 구조).
    if (settingsUnreadable(res, jobsLoadError, 'VM 백업 잡(vm-clone.json)')) return;
    const targets = await vmCloneTargets();
    if (!targets) return persistent503(res).json({ ok: false, reason: 'registryUnreadable', detail: '중앙 vCenter 등록부(vcenters.json)를 읽지 못했습니다 — 엣지는 위임 잡을 그대로 유지합니다.' });
    const { syncPayloadFor, takeOps, releasedFor } = await import('../../vmclone/dispatch.js');
    const p = syncPayloadFor(agent, listCloneJobs(), targets);
    const mine = (op) => { const tg = targets.get(String(op.vcenterId)); return tg?.where === 'edge' && tg.agent.toLowerCase() === String(agent).toLowerCase(); };
    const ops = takeOps(agent, Date.now(), mine);
    // have: 엣지가 들고 있는 위임 잡의 vCenter(쉼표 구분) → 이 엣지 담당이 아닌 것을 released 로 알려 엣지가 멈추게 한다(반증 검토 F3).
    const have = typeof req.query.have === 'string' ? req.query.have.slice(0, 20_000).split(',') : [];
    res.json({ ok: true, proto: 1, vcenters: p.vcenters, jobs: p.jobs, ops, released: releasedFor(agent, have, targets) });
  });

  centralRouter.post('/vm-clone-report', requireCentral(), async (req, res) => {
    const agent = vmCloneAgentOnly(req, res); if (!agent) return;
    const targets = await vmCloneTargets();
    if (!targets) return persistent503(res).json({ ok: false, reason: 'registryUnreadable', detail: '중앙 vCenter 등록부(vcenters.json)를 읽지 못해 보고를 받지 않았습니다 — 다음 주기에 다시 보내세요.' });
    const { sanitizeReport: sanitizeVmCloneReport, ingestReport: ingestVmCloneReport } = await import('../../vmclone/dispatch.js');   // svcmon 의 ingestReport 와 이름을 겹치지 않는다(TDZ 스윕)
    const clean = sanitizeVmCloneReport(req.body);
    const r = ingestVmCloneReport(agent, clean, targets);
    res.locals.ingestSummary = { accepted: r.jobs, dropped: r.droppedJobs + r.droppedAcks, rows: clean.jobs.length };
    res.json(r);
  });

  // 베어메탈 스토리지 폴링 위임(v2.341): 엣지가 자기 이름의 df 수집 잡을 인출(claim) →
  // 현지 SSH 수집 → 결과 회신(ack). 캡처/iDRAC 스캔과 동일한 claim→ack + 소유권 검증.
  centralRouter.get('/bmstor-jobs', requireCentral(), (req, res) => {
    res.json({ ok: true, jobs: takeBmstorJobs(String(req.query.agent || '')) });
  });

  // Body: { reqId, results: [{ id, ok, mounts, missing?, error? }] } — 비밀번호 없음(용량 수치만).
  centralRouter.post('/bmstor-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
    const b = req.body || {};
    if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
    if (reqAgentDenied(req, bmstorAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
    let ackd = ackBmstorJob(String(b.reqId));
    // v2.622(감사 EDGE-03): 만료 종결 잡의 늦은 결과는 반영한다(late) · 중앙에 없는 잡은 410(엣지가 상태·콘솔에 남긴다) ·
    //   같은 결과의 재전송·더 새 잡이 이미 반영된 경우만 200 stale(반영하지 않은 사유를 함께).
    if (!ackd) {
      if (!bmstorJobKnown(String(b.reqId))) return res.status(410).json({ ok: false, error: 'unknown-job', reason: '중앙에 이 수집 잡이 없습니다(만료 후 정리되었거나 중앙이 재시작됨) — 결과가 반영되지 않았습니다.' });
      const late = lateBmstorResult(String(b.reqId));
      if (!late) return res.json({ ok: true, stale: true, duplicate: true }); // 이미 정상 회신된 잡의 재전송 — 무해
      if (late.duplicate) return res.json({ ok: true, stale: true, duplicate: true });
      if (late.superseded) return res.json({ ok: true, stale: true, superseded: true, reason: '같은 엣지의 더 새 수집 결과가 이미 반영돼 이 늦은 결과는 쓰지 않았습니다.' });
      ackd = late;
    }
    // 결과는 **그 잡에 실제로 할당된 서버 id 로만** 반영한다 — 인증된 엣지가 b.results 에 남의
    // 서버 id 를 끼워 넣어 그 서버의 latest 용량 수치를 위조하는 것을 차단(잡 소유권 = 서버 소유권).
    const owned = new Set((ackd.serverIds || []).map(String));
    const results = (Array.isArray(b.results) ? b.results : []).filter((r) => r && owned.has(String(r.id)));
    applyBmstorResults(ackd.agent, results);
    res.json({ ok: true, ...(ackd.late ? { late: true } : {}) });
  });

  // Agent pulls its IP-scan assignment (TCP connect scan config) by name.
  centralRouter.get('/ip-scan-assignment', requireCentral(), (req, res) => {
    // v2.632(감사 EDGE2632-03): 스캔 설정 파일을 못 읽었으면 assigned:false(엣지 스캔 중단)를 200 으로 내리지 않는다.
    if (settingsUnreadable(res, scanSettingsLoadError, 'IP 스캔')) return;
    // v2.604(감사 RECENT2604-01): 개별 토큰이면 **결과 라우트와 같은 키**(토큰 이름)로 찾는다 — 배정과 결과가 서로 다른 이름으로
    //   설정을 찾으면 '배정됨' 을 받고 스캔한 뒤 결과가 전량 409 가 된다. 조회 자체도 대소문자 무시(scanStore.loadScanSettings).
    const cfg = loadScanSettings(req.centralAuth?.mode === 'agent' && req.centralAuth.agent ? req.centralAuth.agent : String(req.query.agent || ''));
    if (!cfg.enabled || !cfg.ranges.length) return res.json({ ok: true, assigned: false });
    res.json({ ok: true, assigned: true, ...cfg });
  });

  // Agent posts its IP-scan result. Body: { agent, alive:[{ip,openPorts,services,hostname}] }
  centralRouter.post('/ip-scan-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
    const b = req.body || {};
    const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    let alive = Array.isArray(b.alive) ? b.alive.slice(0, 8000) : [];
    // 개별 토큰은 자기 배정 스캔 ranges 안의 IP 만 보고할 수 있다(범위 밖 임의 IP 의 열린포트·소유
    // agent 위조 차단 — gpu-guest-data 소유권 필터와 동일 모델). ranges 미설정 agent 는 통과(TOFU).
    // ⚠️ ranges 는 **필터 진입 전 1회 로드·컴파일**한다 — IP 마다 loadScanSettings(무캐시 파일 읽기)를
    // 부르면 8,000개 보고에 동기 read 8,000회로 이벤트 루프가 막힌다(CLAUDE.md 논블로킹 불변조건).
    if (req.centralAuth.mode === 'agent') {
      const bounds = ((loadScanSettings(agent)?.ranges) || []).map(specToRange).filter(Boolean);
      if (bounds.length) {
        const before = alive.length;
        alive = alive.filter((h) => { const n = h && ipToNum(h.ip); return n != null && bounds.some((r) => n >= r.lo && n <= r.hi); });
        if (before !== alive.length) console.warn(`[central] ip-scan-result: ${agent} 배정 범위 밖 IP ${before - alive.length}개 드롭(위조 방지)`);
      } else {
        // v2.603(감사 CEN2603-02): 배정 범위가 없는 개별 토큰은 거부한다(/result 의 CEN2601-04 와 같은 판단). 예전에는 전량 통과(TOFU)라
        //   개별 토큰 하나가 임의 IP 를 무한히 쌓았다. 정상 엣지는 배정(ranges)이 있을 때만 스캔·보고한다(agent/ipScanWorker.js —
        //   ip-scan-assignment 가 assigned:false 면 보고하지 않는다). 공유 토큰은 이름을 가릴 수 없어 전체 상한(scanStore)이 막는다.
        console.warn(`[central] ip-scan-result: ${agent} 는 스캔 배정 범위가 없습니다 — 결과를 받지 않습니다`);
        recordScanLog({ event: 'reject', agent, message: '이 엣지에 배정된 스캔 대역이 없어 보고를 받지 않았습니다(409).' });
        return res.status(409).json({ ok: false, reason: `엣지 '${agent}' 에 배정된 스캔 범위가 없습니다 — 설정 › IPAM › 스캔에서 이 엣지의 범위를 지정하세요.`, unassigned: true });
      }
    }
    // v2.607(감사 EDGE2607-02): 8,000 초과분은 예전에 개수도 밝히지 않고 버렸다 — 응답에 omitted 로 싣고 콘솔에 남긴다.
    const aliveOmitted = Array.isArray(b.alive) ? Math.max(0, b.alive.length - 8000) : 0;
    if (aliveOmitted) console.warn(`[central] ip-scan-result: ${String(agent).slice(0, 64)} alive ${b.alive.length}개 중 상한 8000 초과분 ${aliveOmitted}개를 받지 않았습니다`);
    // v2.594(감사 EDGE2-03): 형식이 틀린 원소는 병합에서 버려진다 — 버리기 전 개수를 merged·alive 로 보고하면 수치가 부풀었다.
    const validAlive = alive.filter((h) => h && ipToNum(h.ip) != null);
    const dropped = alive.length - validAlive.length;
    // v2.733(점검 3회차 C1-02): `incomplete` 가 있으면 엣지 스캔이 시한·실패로 끝난 **미완료 보고**다(2.733 엣지가 2.733 이상 중앙에만 보낸다).
    //   alive 는 시한 전에 찾은 부분 결과 — 마지막 확인 시각만 갱신하고(seenOnly), 완료로 기록하지 않는다(recordAgentReport·완료 이력 X).
    //   대신 그 엣지의 '스캔 미완료' 를 남겨 해제 판정(sweepReleases)이 그 엣지 IP 의 down 전환을 보류한다. 필드가 없으면 예전 계약 그대로.
    const inc = b.incomplete && typeof b.incomplete === 'object' && !Array.isArray(b.incomplete) ? b.incomplete : null;
    const mr = validAlive.length ? mergeScanResults(validAlive, Date.now(), agent, inc ? { seenOnly: true } : undefined) : { merged: 0, capped: 0 };
    const capped = mr?.capped || 0;
    if (inc) {
      recordAgentIncomplete(agent, { code: typeof inc.code === 'string' ? inc.code : 'error', reason: typeof inc.reason === 'string' ? inc.reason : '',
        durationMs: b.durationMs, partial: validAlive.length - capped, done: b.scanned, total: inc.total });
    } else recordAgentReport(agent, { scanned: b.scanned || 0, alive: validAlive.length, durationMs: b.durationMs || null });
    {
      // v2.636: 엣지 보고를 실행 로그에 — 받지 않은 개수(범위 밖·형식 오류·상한)를 사유와 함께 남긴다(조용한 드롭 금지).
      const outOfRange = Array.isArray(b.alive) ? Math.max(0, Math.min(b.alive.length, 8000) - alive.length) : 0;
      const notes = [];
      if (outOfRange) notes.push(`배정 범위 밖 ${outOfRange}개 제외`);
      if (dropped) notes.push(`형식 오류 ${dropped}개 제외`);
      if (capped) notes.push(`저장 상한으로 새 IP ${capped}개 미반영`);
      if (aliveOmitted) notes.push(`보고 상한(8000) 초과 ${aliveOmitted}개 미수신`);
      if (inc) {
        const why = capStr(inc.reason, 160) || capStr(inc.code, 32) || '사유 없음'; // 평탄화 — 실행 로그 링버퍼가 요청 본문을 붙잡지 않게
        recordScanLog({ event: 'fail', trigger: 'edge', agent, scanned: b.scanned, alive: validAlive.length, durationMs: b.durationMs,
          dropped: outOfRange + dropped + aliveOmitted,
          message: [`엣지 스캔 미완료 보고 — ${why}`, `시한 전에 찾은 생존 IP ${validAlive.length - capped}개는 마지막 확인 시각만 갱신 · 해제(down) 판정은 완료된 스캔이 올 때까지 보류`, ...notes].join(' · ') });
      } else {
        recordScanLog({ event: 'report', agent, scanned: b.scanned, alive: validAlive.length, durationMs: b.durationMs,
          dropped: outOfRange + dropped + aliveOmitted, message: notes.join(' · ') });
      }
    }
    // v2.603 CEN2603-02: 전체 상한으로 받지 않은 새 IP 수를 밝힌다(merged 는 받은 것만).
    res.json({ ok: true, merged: validAlive.length - capped, ...(inc ? { incomplete: true } : {}), ...(dropped ? { dropped } : {}), ...(capped ? { capped } : {}), ...(aliveOmitted ? { omitted: aliveOmitted } : {}) });
  });

  /*
   * ── 통신 점검(v2.552) ──────────────────────────────────────────────────────────
   *
   * `GET /health-probe` — **엣지가 '중앙까지 닿는가' 를 재는 표적**이다. 엣지는 이 응답의
   *   `yourAgent` 로 '내 토큰이 중앙에서 내 이름으로 해석되는가' 까지 확인한다(토큰 뒤바뀜 탐지).
   *   ⚠ 인벤토리 같은 무거운 경로를 표적으로 쓰지 말 것 — 점검이 곧 부하가 된다.
   *   ⚠ 응답에 **다른 엣지의 이름·주소를 싣지 않는다**(한 법인이 다른 법인 구성을 알게 된다).
   *
   * `POST /link-check` — 엣지가 잰 링크(엣지→중앙·엣지→vCenter·엣지↔엣지) 결과.
   *   개별 토큰 전용이고 저장 키는 `req.centralAuth.agent` 뿐이다(본문 agent 미사용 — v2.548 F5).
   *   ⚠ async 핸들러의 throw 는 express 4 가 잡지 않아 **요청이 응답 없이 매달린다** — try/catch 로
   *     400 을 돌려준다(v2.548 S1, 리뷰에서 실제 hang 을 확인했다).
   */
  centralRouter.get('/health-probe', requireCentral(), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      at: Date.now(),
      version: currentVersion(),
      instance: instanceId(),
      role: 'central',
      // 공유 토큰이면 어느 엣지인지 알 수 없다 — **빈 값**이고 그것 자체가 진단이다(개별 토큰 미이관).
      yourAgent: req.centralAuth?.mode === 'agent' ? String(req.centralAuth.agent || '') : '',
      tokenMode: req.centralAuth?.mode === 'agent' ? 'agent' : 'shared',
    });
  });

  centralRouter.post('/link-check', requireCentral(), async (req, res) => {
    if (req.centralAuth.mode !== 'agent') {
      return res.status(403).json({
        ok: false,
        reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(공유 CENTRAL_TOKEN 으로는 어느 엣지의 측정인지 신뢰할 수 없습니다). 설정 > 엣지 토큰에서 이 엣지의 토큰을 발급해 주세요.',
      });
    }
    try {
      const out = await putEdgeLinkReport(req.centralAuth.agent, req.body || {});
      // v2.681(R2F-03): DB 를 못 쓰면 200 이 아니라 503(엣지가 '저장됨' 이라 적지 않게 — v2.611 규약).
      if (out?.dbUnavailable) return res.status(503).set(PERSISTENT_503_HEADERS).json(out); // v2.742(EDGE-03): 지속형 503 머리 — persistent503 과 같다(audit2681b 가 이 모양을 고정한다)
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });

  /*
   * `GET /link-check-config?agent=<이름>` — **그 엣지가 재야 하는 링크**를 중앙이 계산해 내려준다.
   *
   * 왜 엣지가 스스로 만들지 않는가: 켜진 종류·엣지↔엣지 짝·시한은 **중앙 설정**이고, 엣지가 자기
   * 복사본을 들고 있으면 중앙에서 바꾼 설정이 그 법인에 영원히 안 먹는다(v2.409 스토리지 주기와
   * 같은 사고). 판정 규칙은 중앙이 소유한다.
   *
   * ⚠ **자기 몫만** 내려간다(`from === agent`). 전 링크를 내려보내면 한 법인이 다른 법인의 주소를
   *   알게 되고, 남의 링크를 재서 올릴 수도 있다(수신은 거부하지만 애초에 주지 않는다).
   * ⚠ 엣지↔엣지 짝은 **상대 엣지의 주소**를 필요로 하므로 그 링크에만 상대 주소가 실린다 —
   *   관리자가 명시한 짝뿐이고(자동 전량 생성 없음), 그 사실을 문서와 화면이 밝힌다.
   * ⚠ 링크 객체에는 **토큰이 없다**(`links.js` 규약) — 엣지는 자기 `CENTRAL_TOKEN` 을 쓴다.
   */
  centralRouter.get('/link-check-config', requireCentral(), (req, res) => {
    if (req.centralAuth.mode !== 'agent') {
      return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(설정 > 엣지 토큰).' });
    }
    const agent = String(req.centralAuth.agent || '');
    const reqAgent = String(req.query.agent || '').trim();
    if (reqAgent && reqAgent.toLowerCase() !== agent.toLowerCase()) {
      return res.status(403).json({ ok: false, reason: `요청한 agent('${reqAgent}')가 이 토큰의 엣지('${agent}')와 다릅니다.` });
    }
    // v2.632(감사 EDGE2632-03): 설정 파일을 못 읽었으면 기본값(꺼짐)을 enabled:false 로 내리지 않는다 — 화면이 '점검 꺼짐' 이라 말했다.
    //   env LINKCHECK_ENABLED 로 강제한 경우도 링크·주기·시한은 파일 값이라 같은 판단이다.
    if (settingsUnreadable(res, linkCheckSettingsLoadError, '통신 점검')) return;
    // v2.771(점검 R6-F4-2): 수집 서버 등록부를 읽지 못했으면 빈 목록으로 엣지↔엣지 링크를 0개로 내려보내지 않는다(엣지는 직전 링크 유지).
    if (registryUnreadable(res, collectorsRegistryLoadError, '수집 서버')) return;
    const s = loadLinkCheckSettings();
    let links = [];
    try {
      const built = buildLinks({
        collectors: listCollectorsForLinks(), vcenters: listVcentersForLinks(), pairs: s.pairs, settings: s,
      });
      links = built.links
        .filter((l) => EDGE_KINDS.includes(l.kind) && l.enabled !== false
          && String(l.from || '').toLowerCase() === agent.toLowerCase())
        .map(publicLink);
    } catch (e) {
      return res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 200) });
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      // ⚠ 꺼져 있으면 **빈 목록이 아니라 enabled:false** 를 준다 — 엣지가 '링크가 없다' 와
      //   '중앙이 껐다' 를 구분해 화면·로그에 말할 수 있어야 한다.
      enabled: linkCheckEnabled(),
      intervalMs: s.intervalMs, concurrency: s.concurrency,
      timeouts: { dnsMs: s.dnsTimeoutMs, tcpMs: s.tcpTimeoutMs, tlsMs: s.tlsTimeoutMs, httpMs: s.httpTimeoutMs },
      links, count: links.length,
    });
  });
}
