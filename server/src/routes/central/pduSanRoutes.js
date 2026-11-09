/**
 * routes/central/pduSanRoutes.js — PDU · SAN 스위치 · 원격 명령(RMA) 위임
 *
 * v2.954(개선 검토 4번 — 사용자 선택 '동작 그대로 영역별 파일 이동'): routes/central.js(2,966줄)에서 이 영역의 엣지 수신 · 설정 인출 라우트를
 *   **글자 그대로** 옮겼다. 등록은 central.js 가 원래 자리에서 `registerPduSanRoutes(centralRouter)` 로 부른다 — 라우트 순서 · 미들웨어 · 응답이 같다
 *   (회귀 `test/centralSplit2954.test.js` 가 분할 전 라우트 표와 기계 대조한다). 공용 판정(requireCentral · 503 응답 등)은 central.js 의 것을 그대로 쓴다.
 */
import { logAudit } from '../../audit.js';
import { REJECT_KIND } from '../../central/ingestReject.js';
import { getJob as getRmaJob, jobAgentOf as rmaJobAgentOf, noteHeartbeat as noteRmaHeartbeat, onlineInstances as rmaOnlineInstances, setJobResult as setRmaJobResult, takeJobsWait as takeRmaJobsWait } from '../../rma/jobs.js';
import { assignForInstance as rmaAssign, rmaSchedulesLoadError, scheduleFor as rmaScheduleFor } from '../../rma/schedules.js';
import { accessFor as rmaAccessFor, ipAllowed as rmaIpAllowed, remoteFor as rmaRemoteFor } from '../../rma/settings.js';
import { ingestResult as rmaIngestResult } from '../../rma/testResults.js';
import { brokerFetch as credentialBrokerFetch } from '../../security/credentialStore.js';
// central.js 의 공용 판정 — 등록 때 인자로 받는다(import 하면 central.js ↔ 이 파일 순환이 생긴다 — archScan IMPORT_CYCLE_MAX)
let intervalsPartOrUnreadable, loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, settingsUnreadableLog, strAgent;
import { edgeDropSummary, onlyDelegated, stampEdgeCollectedAt, withNotOwned } from './storageRoutes.js';

/**
 * 통합 계정 브로커(v2.419) — RMA 가 SSH 실행 직전에 계정(비밀 포함)을 받아 간다. **개별 토큰 전용** +
 * 계정의 법인/대상 호스트 범위 검사(credentialStore) + 법인당 분당 상한 + 감사로그(비밀 미기재).
 * Body: { credentialId, host }
 */
const credRate = new Map();

 // agentLower → { winStart, n }
const CRED_RATE_PER_MIN = Math.max(10, Number(process.env.RMA_CRED_RATE_PER_MIN) || 120);

/** central.js 가 원래 자리에서 부른다(등록 순서 유지). */
export function registerPduSanRoutes(centralRouter, deps) {
  ({ intervalsPartOrUnreadable, loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, settingsUnreadableLog, strAgent } = deps);
  // ── PDU 모니터링 위임(v2.424) — 스토리지 위임과 완전히 같은 규약 ────────────────
  // GET /api/central/pdu-config?agent=<이름> — 이 엣지 몫 PDU 목록(자격증명 포함: 엣지가 PDU 에
  // SSH 로그인해야 한다). 개별 토큰이면 바인딩된 agent 와 요청 agent 불일치를 거부(자격증명 횡탈 차단).
  centralRouter.get('/pdu-config', requireCentral(), async (req, res) => {
    const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    // v2.613 DEPS2613-09: 토큰↔agent 대조는 위 `centralRouter.use` 미들웨어가 requestedAgent 로 이미 했다(여기 있던 재대조는 도달 불가 중복).
    const { devicesForAgent, registryLoadError: pduRegErr } = await import('../../pdu/registry.js');
    if (registryUnreadable(res, pduRegErr, 'PDU')) return;
    const { takeRequestsForAgent } = await import('../../pdu/collectRequests.js');
    // intervals: **지정한 키만** 내려간다 — 전 키를 채우면 엣지 portal.env 의 현장 설정을 덮어쓴다.
    const { intervalsForEdge, pduIntervalsLoadError } = await import('../../pdu/intervals.js');
    const ivPart = intervalsPartOrUnreadable(req, res, pduIntervalsLoadError, 'PDU 수집 주기', () => intervalsForEdge());
    if (!ivPart) return;
    // v2.769(점검 R4-D4-02): 임계치도 싣는다 — 위임 PDU 경보는 엣지가 현장에서 평가·발송하는데(pdu/poller.js 의도) 엣지가 중앙 임계치를
    //   몰라 중앙 화면에서 바꾼 값이 먹지 않았다. 중앙 파일이 있을 때만 싣고(thresholdsForEdge), 못 읽었으면 값 대신 thresholdsUnreadable
    //   (엣지는 직전 값 유지 — 옛 엣지는 이 필드를 모르고 무시하므로 503 으로 막지 않는다). ⚠ 알림 채널 설정은 배포하지 않는다(pdu/thresholds.js 머리말).
    // v2.770(점검 R5-E1-1): thresholdsForEdge 는 **관리자가 바꾼 키만**(enabled 제외) 돌려주고, 파일·지정 키가 없으면 `{}` 다 — {} 도 싣는다
    //   (엣지가 v2.769 가 넣은 전체 세트를 지우는 '중앙 지정 없음' 신호. 필드를 빼면 엣지는 직전 값을 유지한다).
    const { thresholdsForEdge, pduThresholdsLoadError } = await import('../../pdu/thresholds.js');
    let thPart = {};
    try {
      const thErr = pduThresholdsLoadError();
      if (thErr) thPart = { thresholdsUnreadable: { reason: loadWhy(thErr.reason), since: thErr.at || null } };
      else { const th = thresholdsForEdge(); if (th) thPart = { thresholds: th }; }
    } catch (e) { thPart = { thresholdsUnreadable: { reason: loadWhy(e?.message || String(e)), since: Date.now() } }; }
    res.json({
      ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent),
      ...ivPart, ...thPart,
    });
  });

  // POST /api/central/pdu-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
  // **인증된 agent**(개별 토큰 바인딩)만 쓴다. 미위임 장비 id 는 드롭(위조 방지).
  centralRouter.post('/pdu-data', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { saveEdgePdu, saveEdgePduStatus } = await import('../../central/pduEdge.js');
    // v2.613(감사 EDGE2613-04): 상태 전용 보고(보류 중 — 위임은 있는데 스냅샷이 아직 없다) — 목록은 건드리지 않고 상태만 기록한다.
    if (req.body?.statusOnly === true) {
      const saved = saveEdgePduStatus(agent, req.body?.status);
      return res.json({ ok: true, saved: 0, statusOnly: true, recorded: saved });
    }
    if (await receiveRegistryUnreadable(res, '../pdu/registry.js', 'PDU')) return; // v2.620(EDGE2620-01)
    let snapshots = Array.isArray(req.body?.snapshots) ? req.body.snapshots : [];
    let notOwned = 0; // v2.601 EDGE2601-04
    const now = Date.now();
    snapshots = snapshots.map((s) => stampEdgeCollectedAt(s, now)); // v2.630 A4-02
    {
      const r = await onlyDelegated(snapshots, (x) => x.id, '../pdu/registry.js'); // v2.607 CEN2607-03
      snapshots = r.list; notOwned += r.denied;
      if (r.denied) console.warn(`[central] pdu-data: ${String(agent).slice(0, 64)} 중앙 직접 수집 장비 ${r.denied}건 거절`);
    }
    if (req.centralAuth.mode === 'agent') {
      const { devicesForAgent } = await import('../../pdu/registry.js');
      const owned = new Set(devicesForAgent(agent).map((d) => d.id));
      const before = snapshots.length;
      snapshots = snapshots.filter((s) => s && owned.has(s.id));
      notOwned += before - snapshots.length;
      if (before - snapshots.length) console.warn(`[central] pdu-data: ${agent} 미위임 id ${notOwned}건 드롭(위조 방지)`);
    }
    const r = saveEdgePdu(agent, snapshots);
    if (r?.refused) return res.status(429).json({ ok: false, refused: true, reason: r.reason });
    // ⚠ 예전에는 결과 객체 전체를 saved 에 담았다({ok,count}). 하위호환으로 그 모양을 유지하고 뺀 개수를 옆에 싣는다.
    res.json({ ok: true, saved: r, ...(edgeDropSummary(withNotOwned(r, notOwned))) });
  });

  // ── SAN 스위치 모니터링 위임(v2.410) — 스토리지 위임과 완전히 같은 규약 ──────────
  // GET /api/central/sanswitch-config?agent=<이름> — 이 엣지 몫 스위치 목록(자격증명 포함:
  // 엣지가 스위치에 SSH/REST 로그인해야 한다). 개별 토큰이면 바인딩 agent 불일치를 거부.
  centralRouter.get('/sanswitch-config', requireCentral(), async (req, res) => {
    const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    // v2.613 DEPS2613-09: 토큰↔agent 대조는 위 `centralRouter.use` 미들웨어가 requestedAgent 로 이미 했다(여기 있던 재대조는 도달 불가 중복).
    const { devicesForAgent, registryLoadError: sanRegErr } = await import('../../sanswitch/registry.js');
    if (registryUnreadable(res, sanRegErr, 'SAN 스위치')) return;
    const { takeRequestsForAgent, takePerfRequestForAgent } = await import('../../sanswitch/collectRequests.js');
    const { takeTestRequestsForAgent } = await import('../../sanswitch/testRuns.js');
    const { takeFlowJobsForAgent } = await import('../../sanswitch/flowJobs.js');
    const { loadPerfSettings, perfSettingsLoadError } = await import('../../sanswitch/perfSettings.js');
    // v2.632(감사 EDGE2632-02): 포트 사용량 설정 파일을 못 읽었으면 기본값(꺼짐 · 보존 90일)을 perf 로 싣지 않는다 — 엣지가 그대로
    //   저장해 수집을 끄고 보존을 줄였다. 장비 목록·collectNow·testNow 는 등록부가 원천이라 그대로 준다(cvp-config 와 같은 모양).
    let perfErr = null;
    try { perfErr = perfSettingsLoadError(); } catch (x) { perfErr = { at: Date.now(), reason: x?.message || String(x) }; }
    if (perfErr && settingsUnreadableLog('SAN 스위치 포트 사용량', String(perfErr.reason || ''))) {
      console.warn(`[central] 중앙 SAN 스위치 포트 사용량 설정 파일을 읽지 못해 sanswitch-config 에서 perf 를 뺍니다(엣지는 직전 설정 유지): ${loadWhy(perfErr.reason)}`);
    }
    const perfPart = perfErr
      ? { perfSettingsUnreadable: { reason: loadWhy(perfErr.reason), since: perfErr.at || null } }
      : { perf: loadPerfSettings() };
    // testNow(v2.421): 중앙 등록 화면의 '연결 테스트' 를 이 엣지가 현지에서 대행(비밀번호 포함 — 엣지가 로그인해야 한다).
    // perf(v2.423): 중앙의 포트 사용량 수집 설정(켜짐/주기/표본/보관)을 위임 스위치에도 적용 — 엣지가 현지 수집 후 중앙으로 중계.
    // perfCollectNow(v2.517): 중앙의 '지금 수집'(포트 사용량)을 이 엣지가 현지에서 대행 — 엣지 단위
    // one-shot 플래그다(엣지의 pollPerfOnce 는 자기 몫 전체를 한 주기에 수집한다).
    // flowNow(v2.935 C-②): Flow Vision 플로우 작업(만들기 · 지우기 · 카운터 읽기 · 계정 점검) — 비밀 없음(장치 id · 동작 · 플로우 정의).
    //   엣지는 명령 글자를 받지 않고 flowCmd.js 로 다시 검사해 직접 만든다 · 자기 등록부의 자격증명으로 실행한다.
    res.json({ ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent), testNow: takeTestRequestsForAgent(agent), flowNow: takeFlowJobsForAgent(agent), ...perfPart, perfCollectNow: takePerfRequestForAgent(agent) });
  });

  /**
   * POST /api/central/sanswitch-perf — 엣지가 현지 수집한 portperfshow 시계열 중계 수신(v2.423).
   * body { agent, chunk, chunks, rows:[[deviceId, ts, port, bytesPerSec]...], meta:[[deviceId, port, ts, name, wwn, speed, type]...] }
   * 소유권(sanswitch-data 와 동일): 개별 토큰 엣지는 자기에게 위임된 deviceId 만 — 남의 스위치 시계열 위조 차단.
   * ts 는 수신 시각으로 clamp(미래 시각이 '최신' 판정을 항상 이기는 것 방지). 적재는 perfDb.importSamples(트랜잭션·중복 건너뜀).
   */
  centralRouter.post('/sanswitch-perf', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    if (await receiveRegistryUnreadable(res, '../sanswitch/registry.js', 'SAN 스위치(사용량)')) return; // v2.620(EDGE2620-01)
    const { devicesForAgent } = await import('../../sanswitch/registry.js');
    const { importSamples } = await import('../../sanswitch/perfDb.js');
    const { loadPerfSettings, perfSettingsLoadError, LIMITS: PERF_LIMITS } = await import('../../sanswitch/perfSettings.js');
    const { saveEdgePerfStatus } = await import('../../central/sanSwitchPerfEdge.js');
    const ownedDevices = devicesForAgent(agent);
    const owned = new Set(ownedDevices.map((d) => String(d.id)));
    const now = Date.now();
    const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 100_000) : [];
    const metaIn = Array.isArray(req.body?.meta) ? req.body.meta.slice(0, 20_000) : [];
    // v2.602: 장비 id·수치는 글자·숫자만 받는다 — 객체면 String()/Number() 가 던졌다(async 핸들러 500).
    const idOf = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '');
    const nOf = (v) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);
    const rows = rowsIn.filter((r) => Array.isArray(r) && owned.has(idOf(r[0]))).map((r) => ({ d: idOf(r[0]), ts: Math.min(nOf(r[1]) || now, now), p: nOf(r[2]), b: nOf(r[3]) }));
    const meta = metaIn.filter((m) => Array.isArray(m) && owned.has(idOf(m[0]))).map((m) => ({ d: idOf(m[0]), p: nOf(m[1]), ts: Math.min(nOf(m[2]) || now, now), name: m[3], wwn: m[4], speed: m[5], type: m[6] }));
    const dropped = rowsIn.length - rows.length;
    const metaDropped = metaIn.length - meta.length;
    if (dropped > 0) console.warn(`[central] sanswitch-perf: ${agent} 미위임 deviceId 표본 ${dropped}건 드롭(위조 방지)`);
    // v2.632(감사 EDGE2632-02): 설정 파일을 못 읽는 동안에는 기본 보존(90일)으로 prune 하지 않는다 — 상한(보존 최대)을 써서
    //   정리를 사실상 보류한다(관리자가 3650일로 둔 중앙 표본이 손상 한 번으로 잘리지 않게).
    let perfLoadErr = null; try { perfLoadErr = perfSettingsLoadError(); } catch { perfLoadErr = { reason: 'load' }; }
    const r = await importSamples(rows, meta, perfLoadErr ? PERF_LIMITS.retentionDays.max : loadPerfSettings().retentionDays);
    /**
     * v2.517: 엣지의 **수집 상태**를 함께 받는다(청크 0 에만 실린다). 표본이 0건이어도 엣지가 상태
     * 전용 하트비트를 올리므로, 중앙이 '엣지가 켜졌는지·돌았는지·왜 실패하는지' 를 알 수 있다 —
     * 예전에는 표본이 없으면 아무것도 오지 않아 중앙 화면이 '설정에서 켜세요' 한 문구로 전부를 덮었다.
     * 소유권은 시계열과 같은 규약(위임된 deviceId 만).
     */
    let statusSaved = 0;
    let statusRefused = false;
    // v2.605(CEN2605-04): 위임 장비가 0대인 **공유 토큰** 이름은 상태를 저장하지 않는다 — 진단(perfDiag)은 위임 장비 단위라 쓸 곳이
    //   없고, 임의 이름으로 보관 행을 채우는 통로만 된다. 개별 토큰 엣지는 0대여도 저장한다(토큰으로 이름이 검증됐다).
    const statusAllowed = req.centralAuth?.mode === 'agent' || owned.size > 0;
    if (statusAllowed && req.body?.status && typeof req.body.status === 'object') {
      try {
        const names = new Map(ownedDevices.map((d) => [String(d.id), d.name || d.host || d.id]));
        const sv = saveEdgePerfStatus(agent, req.body.status, { owned, names });
        statusSaved = sv.saved; statusRefused = !!sv.refused;
      } catch (e) { console.warn(`[central] sanswitch-perf 상태 저장 실패(${agent}): ${e.message}`); }
    }
    // v2.602: 적재에서 버린 메타(포트 범위 밖·빈 장비 id — perfDb.importSamples)와 위임 밖 메타를 **항상** 싣는다 —
    //   엣지(sanswitch/perfPush.js)가 상태·콘솔에 남긴다. 조용히 버리면 포트 이름·WWN 이 왜 비었는지 알 길이 없다.
    /*
     * v2.611(CEN2611-03·DB2611-03): 중앙 DB 를 못 열었는데 적재할 표본·메타가 있었으면 **503** 이다. 예전에는 200 + unavailable 을
     *   주고 엣지가 청크마다 커서를 전진해 그 표본이 **조용히 전량 소실**됐다(형제 vmseries·guest-disk 는 5xx 로 재전송시킨다).
     *   상태(하트비트)는 위에서 이미 저장했다 — 상태만 온 요청(표본 0)은 200 그대로(화면 진단이 살아 있게).
     */
    if (r.unavailable && (rows.length || meta.length)) {
      return persistent503(res).json({ ok: false, dbUnavailable: true, statusSaved, reason: '중앙 SAN 포트 사용량 DB 를 쓸 수 없습니다 — 엣지는 커서를 전진하지 않고 다음 주기에 다시 보냅니다(중앙 로그의 [sanswitch-perf-db] 줄 참조)' });
    }
    res.json({ ok: true, ...r, metaRejected: r.metaRejected || 0, dropped, metaDropped, statusSaved,
      ...(statusRefused ? { statusRefused: true } : {}), ...(!statusAllowed && req.body?.status ? { statusIgnored: 'no-delegated-devices' } : {}) });
  });

  // POST /api/central/sanswitch-test-result — 엣지가 대행한 연결 테스트 결과(추적 로그 포함) 회신(v2.421).
  // 개별 토큰이면 바인딩 agent 만, 공유 토큰은 body.agent — 어느 쪽이든 그 요청의 대상 엣지와 같아야 한다.
  centralRouter.post('/sanswitch-test-result', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { completeTestRun } = await import('../../sanswitch/testRuns.js');
    const r = completeTestRun(String(req.body?.id || ''), agent, req.body?.result);
    if (!r.ok) return res.status(404).json(r);
    res.json({ ok: true });
  });

  // POST /api/central/sanswitch-flow-result — 엣지가 대행한 Flow Vision 플로우 작업 결과(v2.935 C-②).
  // 연결 테스트 회신과 같은 규약: 개별 토큰이면 바인딩 agent, 공유 토큰은 body.agent — 그 작업의 대상 엣지만(completeFlowJob 대조).
  //   결과는 sanitizeFlowResult 가 '그 작업이 실행했어야 하는 명령' 의 출력만 · 상한으로 자른다(임의 명령 출력 · 대용량 차단).
  centralRouter.post('/sanswitch-flow-result', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { completeFlowJob } = await import('../../sanswitch/flowJobs.js');
    const r = completeFlowJob(String(req.body?.id || '').slice(0, 64), agent, req.body?.result);
    if (!r.ok) return res.status(404).json(r);
    res.json({ ok: true, ...(r.already ? { already: true } : {}) });
  });

  // POST /api/central/sanswitch-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
  // **인증된 agent**(개별 토큰 바인딩)만 쓴다. 공유 토큰(레거시)은 body.agent 신뢰(기존 축과 동일).
  /**
   * RMA 원격 명령(v2.416) — 엣지의 별도 프로세스(rma/agent.js)가 자기 잡을 롱폴 인출(claim)하고
   * 결과를 회신(ack)한다. **개별 토큰 전용**(svcmon-report 3규약: agent 모드 필수 · 키는
   * req.centralAuth.agent 만 · X-Agent-Name 이중 방어). 공유 CENTRAL_TOKEN 으로는 어느 엣지가
   * 명령을 가져가는지 신뢰할 수 없고, 원격 명령은 자격증명보다 더 큰 권한이라 예외를 두지 않는다.
   * Body: { agent, instance, info:{hostname,version,os,pid,uptimeSec,priority,allowCustom,signed,busy}, wait }
   * instance = 같은 법인의 여러 RMA 프로세스 구별자(분배는 rma/jobs.js). 형식 검증 후 그대로 키로 쓴다.
   */
  centralRouter.post('/rma-poll', requireCentral(), async (req, res) => {
    res.locals.perfExpectSlow = true; // v2.498: 롱폴(최대 55초 대기)은 정상이다 — '느린 요청' 목록을 이걸로 채우지 않는다
    if (req.centralAuth.mode !== 'agent') {
      return res.status(403).json({ ok: false, reason: '원격 명령(RMA)은 엣지별 개별 토큰만 허용합니다 — 설정 › 엣지 토큰에서 이 엣지의 토큰을 발급해 portal.env 의 EDGE_TOKEN/CENTRAL_TOKEN 에 넣으세요.' });
    }
    const agent = req.centralAuth.agent;
    const b = req.body || {};
    const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    // 접속 허용 IP(v2.418, HostMonitor 'Accept connections from…' 대응) — 법인별 목록이 있으면 그 밖의 출처는 거부.
    const access = rmaAccessFor(agent);
    if (!rmaIpAllowed(ip, access.allowedIps)) {
      console.warn(`[central] rma-poll: ${agent} 허용되지 않은 출처 IP ${ip} 거부`);
      return res.status(403).json({ ok: false, reason: `이 법인의 RMA 접속 허용 IP 목록에 없는 출처(${ip})입니다 — 설정 › 원격 명령 › 접속 허용 IP 를 확인하세요.` });
    }
    const instance = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(b.instance || '')) ? String(b.instance) : 'default';
    // v2.606(감사 RECENT2606-06): 인스턴스 수 상한으로 거절되면 **작업을 배달하지 않고 사유를 돌려준다**. 예전에는 반환값을
    //   버려 거절된 인스턴스가 온라인 목록·스케줄 배정에는 없으면서 롱폴 작업만 받았고, 엣지는 왜인지 알 길이 없었다.
    //   403 + reason 이면 엣지 rma/agent.js 가 그 사유를 로그에 적고 백오프한다(200 으로 즉시 돌려주면 엣지가 쉬지 않고 재폴한다).
    const hb = noteRmaHeartbeat(agent, instance, b.info || {}, { ip });
    if (hb && hb.refused) {
      res.locals.ingestReject = { kind: REJECT_KIND.OTHER, reason: hb.reason || 'RMA 인스턴스 수 상한' };
      return res.status(403).json({ ok: false, refused: true, reason: hb.reason || 'RMA 인스턴스 수 상한으로 이 인스턴스를 받지 않았습니다.', jobs: [] });
    }
    /*
     * v2.631 EDGE2631-01: 스케줄 파일이 손상이면 known 이 비어 결과를 전부 버리고(엣지는 200 이면 outbox 를 지운다) 빈 스케줄을
     *   내려보내 엣지 점검이 전부 멈췄다. 결과를 받기 **전에** 503 — 엣지는 outbox·스케줄을 그대로 두고 백오프한다.
     *   ⚠ 그 동안 원격 명령(작업)도 배달되지 않는다(롱폴을 열지 않는다) — 작업 큐는 중앙에 남는다.
     */
    if (settingsUnreadable(res, rmaSchedulesLoadError, 'RMA 점검 스케줄')) return;
    // 점검 결과 동봉(outbox) — 이 법인의 스케줄에 있는 항목만 반영(남의 항목 id 로 상태 위조 차단).
    const sch = rmaScheduleFor(agent);
    const known = new Set(sch.tests.map((t) => t.id));
    const nameOf = new Map(sch.tests.map((t) => [t.id, t.name || '']));
    const results = Array.isArray(b.results) ? b.results.slice(0, 500) : [];
    let accepted = 0;
    for (const r of results) {
      if (!r || !known.has(String(r.id))) continue;
      try { await rmaIngestResult(agent, { ...r, instance }, { name: nameOf.get(String(r.id)) }); accepted++; } catch { /* */ }
    }
    const wait = Math.min(55_000, Math.max(0, Number(b.wait) || 0));
    // v2.428(미스매치 #11): 롱폴 대기 중 클라이언트(HAProxy 타임아웃 등)가 끊기면 깨어나도 claim 하지 않는다 — 예전에는 응답을
    // 버리면서 잡을 claim(MAX_CLAIMS=1)해 실행되지 않은 명령이 '미회신'으로 종결됐다.
    let gone = false;
    // ⚠ req.on('close') 는 본문을 다 읽으면 소켓이 살아 있어도 발생한다(Node 16+) — 응답 객체의 close(연결 종료) + writableFinished 로 판정.
    res.on('close', () => { if (!res.writableFinished) gone = true; });
    const jobs = await takeRmaJobsWait(agent, instance, wait, { isAlive: () => !gone });
    if (gone) return; // 소켓이 이미 닫혔다 — 응답 불가
    const out = { ok: true, jobs, accepted };
    // 스케줄 배포 — 엣지가 보고한 버전과 다를 때만(인스턴스별로 나눠 배정). 배정은 온라인 인스턴스 집합에
    // 결정적이라, 인스턴스가 늘거나 줄면 다음 폴에서 다시 내려간다(버전은 같아도 배정이 달라질 수 있어
    // 배정 서명(assignKey)을 함께 비교).
    const assign = rmaAssign(sch, instance, rmaOnlineInstances(agent));
    const assignKey = `${sch.version}:${assign.tests.map((t) => t.id).join(',')}`;
    if (String(b.assignKey || '') !== assignKey || Number(b.scheduleVersion) !== sch.version) out.schedule = { version: sch.version, assignKey, tests: assign.tests };
    const remote = rmaRemoteFor(agent);
    if (remote.longpollMs || remote.testConcurrency || remote.disabledTests.length) out.config = remote;
    res.json(out);
  });

  centralRouter.post('/rma-credential', requireCentral(), (req, res) => {
    if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: '계정 브로커는 엣지별 개별 토큰만 허용합니다.' });
    const agent = req.centralAuth.agent;
    const b = req.body || {};
    const id = String(b.credentialId || ''), host = String(b.host || '').trim();
    if (!/^cred_[A-Za-z0-9_]{1,64}$/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(host)) return res.status(400).json({ ok: false, reason: 'credentialId/host 형식 오류' });
    const k = String(agent).toLowerCase(); const now = Date.now();
    const rl = credRate.get(k) || { winStart: now, n: 0 };
    if (now - rl.winStart > 60_000) { rl.winStart = now; rl.n = 0; }
    if (++rl.n > CRED_RATE_PER_MIN) { credRate.set(k, rl); return res.status(429).json({ ok: false, reason: '계정 인출 요청이 너무 잦습니다(분당 상한).' }); }
    credRate.set(k, rl);
    const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const r = credentialBrokerFetch(id, { agent, host });
    logAudit({ user: `rma:${agent}`, action: r.ok ? 'RMA 계정 브로커 인출' : 'RMA 계정 브로커 거부', target: r.ok ? r.name : id, detail: `→ ${host}${b.instance ? ` (인스턴스 ${String(b.instance).slice(0, 64)})` : ''}${r.ok ? '' : ` — ${r.reason}`}`, ip });
    if (!r.ok) return res.status(403).json({ ok: false, reason: r.reason });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, name: r.name, secret: r.secret });
  });

  // Body: { reqId, result }
  centralRouter.post('/rma-result', requireCentral({ notFound: { ok: false } }), (req, res) => {
    if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: '원격 명령(RMA)은 엣지별 개별 토큰만 허용합니다.' });
    const b = req.body || {};
    if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
    const owner = rmaJobAgentOf(String(b.reqId));
    if (!owner) return res.json({ ok: true, stale: true });
    if (owner.toLowerCase() !== String(req.centralAuth.agent).toLowerCase()) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
    const stored = setRmaJobResult(String(b.reqId), b.result);
    // v2.630(감사 A4-03): 미회신 종결 뒤 도착한 실제 결과면 late 로 밝힌다(엣지는 outbox 에서 지운다 — 재전송 불필요).
    const late = stored && getRmaJob(String(b.reqId))?.late === true;
    res.json({ ok: true, stale: !stored, ...(late ? { late: true } : {}) });
  });

  centralRouter.post('/sanswitch-data', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { saveEdgeSanSwitch, saveEdgeSanSwitchStatus } = await import('../../central/sanSwitchEdge.js');
    // v2.613(감사 EDGE2613-04): 상태 전용 보고(엣지가 위임은 있는데 첫 수집 대기 중) — 목록은 건드리지 않고 상태만 기록한다(/storage-data v2.581 과 같다).
    //   ⚠ 이 분기가 없던 중앙(≤2.612)은 빈 청크 0 을 목록 교체로 받는다 — 엣지가 health-probe 버전으로 먼저 확인한다(agent/centralStatusOnly.js).
    if (req.body?.statusOnly === true) {
      const saved = saveEdgeSanSwitchStatus(agent, req.body?.status);
      return res.json({ ok: true, saved: 0, statusOnly: true, recorded: saved });
    }
    if (await receiveRegistryUnreadable(res, '../sanswitch/registry.js', 'SAN 스위치')) return; // v2.620(EDGE2620-01)
    // 소유권 필터(v2.416 감사 L-1): 개별 토큰 엣지는 **자기에게 위임된 deviceId** 만 올릴 수 있다 — 남의
    // 스위치 id 로 '정상' 스냅샷을 밀어 실제 장애를 가리는 위조 차단. collectedAt 도 수신 시각으로 clamp
    // (미래 시각으로 '최신 우선' 병합을 항상 이기는 것 방지). 공유 토큰(레거시)은 기존 신뢰 유지.
    let devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
    let sanNotOwned = 0; // v2.601 EDGE2601-04
    const now = Date.now();
    devices = devices.map((d) => stampEdgeCollectedAt(d, now)); // v2.630 A4-02: 원본 엣지 시각은 edgeCollectedAt 으로 따로
    {
      const r = await onlyDelegated(devices, (d) => d.deviceId, '../sanswitch/registry.js'); // v2.607 CEN2607-03
      devices = r.list; sanNotOwned += r.denied;
      if (r.denied) console.warn(`[central] sanswitch-data: ${String(agent).slice(0, 64)} 중앙 직접 수집 장비 ${r.denied}건 거절`);
    }
    if (req.centralAuth.mode === 'agent') {
      const { devicesForAgent } = await import('../../sanswitch/registry.js');
      const owned = new Set(devicesForAgent(agent).map((d) => d.id));
      const before = devices.length;
      devices = devices.filter((d) => d && owned.has(d.deviceId));
      sanNotOwned += before - devices.length;
      if (before - devices.length) console.warn(`[central] sanswitch-data: ${agent} 미위임 deviceId ${sanNotOwned}건 드롭(위조 방지)`);
    }
    const chunk = Math.max(0, Number(req.body?.chunk) || 0), chunks = Math.max(1, Number(req.body?.chunks) || 1);
    const info = {};
    const saved = saveEdgeSanSwitch(agent, devices, { chunk, chunks, info });
    if (info.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
    res.json({ ok: true, saved, ...(edgeDropSummary(withNotOwned(info, sanNotOwned))) });
  });
}
