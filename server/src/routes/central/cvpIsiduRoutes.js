/**
 * routes/central/cvpIsiduRoutes.js — Arista CVP · 아이실론 디렉터리 사용량 위임
 *
 * v2.954(개선 검토 4번 — 사용자 선택 '동작 그대로 영역별 파일 이동'): routes/central.js(2,966줄)에서 이 영역의 엣지 수신 · 설정 인출 라우트를
 *   **글자 그대로** 옮겼다. 등록은 central.js 가 원래 자리에서 `registerCvpIsiduRoutes(centralRouter)` 로 부른다 — 라우트 순서 · 미들웨어 · 응답이 같다
 *   (회귀 `test/centralSplit2954.test.js` 가 분할 전 라우트 표와 기계 대조한다). 공용 판정(requireCentral · 503 응답 등)은 central.js 의 것을 그대로 쓴다.
 */
import { canonicalAgent } from '../../util/agentKey.js';
import { numOrNull } from '../../util/numOrNull.js';
// central.js 의 공용 판정 — 등록 때 인자로 받는다(import 하면 central.js ↔ 이 파일 순환이 생긴다 — archScan IMPORT_CYCLE_MAX)
let loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent;
import { edgeDropSummary } from './storageRoutes.js';



/** central.js 가 원래 자리에서 부른다(등록 순서 유지). */
export function registerCvpIsiduRoutes(centralRouter, deps) {
  ({ loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent } = deps);
  // ── Arista CloudVision(CVP) 수집 위임(v2.608) — SAN 스위치와 같은 규약 ───────────────
  // GET /api/central/cvp-config?agent=<이름> — 이 엣지 몫 CVP 목록(자격증명 포함: 엣지가 CVP 에 로그인해야 한다) + 수집 설정 +
  // '지금 수집' 요청(claim→ack). 개별 토큰이면 바인딩 agent 불일치를 거부(자격증명 횡탈 차단).
  centralRouter.get('/cvp-config', requireCentral(), async (req, res) => {
    const agent = strAgent(req.query.agent) || strAgent(req.get('X-Agent-Name'));
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    // v2.613 DEPS2613-09: 토큰↔agent 대조는 위 `centralRouter.use` 미들웨어가 requestedAgent 로 이미 했다(여기 있던 재대조는 도달 불가 중복).
    const { serversForAgent, registryLoadError: cvpRegErr } = await import('../../cvp/registry.js');
    if (registryUnreadable(res, cvpRegErr, 'CVP')) return;
    const { loadSettings, cvpSettingsLoadError } = await import('../../cvp/settings.js');
    const { takeCvpRequests } = await import('../../cvp/collectRequests.js');
    const { takeEndpointRequests } = await import('../../cvp/epRequests.js');   // v2.935(C-③)
    res.set('Cache-Control', 'no-store');
    /*
     * v2.631 EDGE2631-01: 수집 설정 파일이 손상이면 **설정을 싣지 않는다**(엣지 applyCentralSettings 는 settings 가 없으면 현장 값을
     *   그대로 둔다). 목록·'지금 수집' 은 등록부가 원천이라 그대로 준다 — 503 으로 통째로 막으면 설정 하나 때문에 위임 수집이 멈춘다.
     */
    let setErr = null;
    try { setErr = cvpSettingsLoadError(); } catch (x) { setErr = { at: Date.now(), reason: x?.message || String(x) }; }
    const settingsPart = setErr
      ? { settingsUnreadable: { reason: loadWhy(setErr.reason), since: setErr.at || null } }
      : { settings: loadSettings() };
    // v2.935(C-③): epNow — EndpointLocation '지금 조회' 요청(MAC 목록뿐 · 비밀 없음). 엣지가 현지에서 묻고 cvp-data push(ep)로 올린다.
    res.json({ ok: true, agent, servers: serversForAgent(agent), ...settingsPart, collectNow: takeCvpRequests(agent), epNow: takeEndpointRequests(agent) });
  });

  /**
   * POST /api/central/cvp-data — 엣지가 수집한 CVP 결과(상태·장비 최신·원시 표본) 수신(v2.608).
   * 저장 키는 **인증된 agent**(개별 토큰이면 바인딩 이름, 공유 토큰이면 본문 이름 — 레거시 신뢰 축과 같다).
   * **소유 검사는 토큰 종류와 무관하게** 한다 — 그 이름에 위임된 CVP(serversForAgent)의 id 만 받는다(남의 cvp_id·중앙 직접 등록 CVP 거절).
   * 원소는 central/cvpEdge.js sanitizeCvpBody 가 객체만·아는 필드만 좁힌다. 뺀 개수는 응답의 rejected/dropped 로 밝힌다.
   */
  centralRouter.post('/cvp-data', requireCentral(), async (req, res) => {
    const authAgent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!authAgent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    if (await receiveRegistryUnreadable(res, '../cvp/registry.js', 'CVP')) return; // v2.620(EDGE2620-01) — noDelegation 분기가 상태·장비 행을 지우기 전에
    const { serversForAgent } = await import('../../cvp/registry.js');
    const { sanitizeCvpBody, saveEdgeCvpStatus, dropEdgeCvpStatus } = await import('../../central/cvpEdge.js');
    const cdb = await import('../../cvp/db.js');
    const ownedServers = serversForAgent(authAgent);
    /*
     * v2.612 CEN2612-01: 위임된 CVP 가 없는 엣지는 **보관하지 않는다** — 상태를 저장하면 CVP 를 쓰지 않는 엣지들이 보관 칸
     *   (EDGE_MAX_AGENTS)을 채워 실제 위임 엣지가 429 로 밀렸다. 이름 변형 정리(adoptAgentVariants)도 하지 않는다(행 소유권을 옮길 근거가 없다).
     *   예전 보관분·장비 행(위임에서 빠진 뒤 남은 것)은 지운다 — 남겨 두면 화면이 옛 상태를 지금 값처럼 보인다.
     */
    if (!ownedServers.length) {
      const statusRemoved = dropEdgeCvpStatus(authAgent);
      let removed = 0;
      const chunk0 = Math.max(0, Math.floor(numOrNull(req.body?.chunk) ?? 0)) === 0;
      if (chunk0) {
        try { removed = (await cdb.pruneDevices(authAgent, {}, { cvpIds: [] })).removed || 0; }
        catch (e) { console.warn(`[central] cvp-data: 위임 해제 엣지 장비 정리 실패(${String(authAgent).slice(0, 64)}): ${e.message}`); }
      }
      return res.json({ ok: true, noDelegation: true, statusRemoved, removed });
    }
    /*
     * v2.611(CEN2611-02): 저장 키는 **대소문자를 정규화한 이름**이다(util/agentKey canonicalAgent — 등록부 표기가 있으면 그것).
     *   조회·소유 판정은 대소문자를 무시하는데 저장만 원문이라, 개별↔공유 토큰 전환('Edge-A'↔'edge-a')으로 같은 엣지의 상태·장비
     *   행이 두 벌이 되고 옛 정상 행이 현재 오류를 가렸다(재현 — v2.604 RECENT2604-01 '저장·조회 둘 다' 규약).
     */
    const agent = canonicalAgent(authAgent, ownedServers.map((s) => s.agent));
    const owned = new Set(ownedServers.map((s) => String(s.id)));
    const clean = sanitizeCvpBody(req.body, owned);
    if (clean.dropped.notOwned) console.warn(`[central] cvp-data: ${String(agent).slice(0, 64)} 위임되지 않은 CVP 원소 ${clean.dropped.notOwned}건 거절`);
    const chunk = Math.max(0, Math.floor(numOrNull(req.body?.chunk) ?? 0));
    const saved = { devices: 0, ports: 0, samples: 0, duplicates: 0, removed: 0 };
    try { await cdb.adoptAgentVariants(agent); } catch (e) { console.warn(`[central] cvp-data: 이름 변형 행 정리 실패(${String(agent).slice(0, 64)}): ${e.message}`); }
    if (chunk === 0) {
      const st = saveEdgeCvpStatus(agent, clean.servers, { devicesUnavailable: clean.devicesUnavailable });
      if (!st.ok) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
      // 장비 목록 정리 — 엣지가 '온전히 읽은' CVP 의 키 목록을 보냈을 때만. 위임에서 빠진 CVP 의 행도 지운다.
      if (clean.deviceKeys && !clean.devicesUnavailable) {
        try { saved.removed = (await cdb.pruneDevices(agent, clean.deviceKeys, { cvpIds: [...owned] })).removed; }
        catch (e) { console.warn(`[central] cvp-data: 장비 정리 실패(${String(agent).slice(0, 64)}): ${e.message}`); }
      }
    }
    try {
      for (const [cvpId, devices] of clean.devicesByCvp) {
        const r = await cdb.saveDevices({ agent, cvpId, devices, samples: false });
        saved.devices += r.devices; saved.ports += r.ports;
        if (r.unavailable) saved.unavailable = true;
      }
      if (clean.touch.length) {
        const t = await cdb.touchDevices(agent, clean.touch);
        saved.touched = t.touched;
        if (t.unavailable) saved.unavailable = true;
      }
      if (clean.rows.length) {
        const r = await cdb.importSamples(agent, clean.rows);
        saved.samples += r.inserted; saved.duplicates += r.duplicates;
        if (r.unavailable) saved.unavailable = true;
      }
      // v2.641 ③④: CPU·메모리 최신 표본 · CVP 이벤트
      if (clean.devSamples.length) {
        const r = await cdb.importDevSamples(agent, clean.devSamples);
        saved.devSamples = r.samples;
        if (r.unavailable) saved.unavailable = true;
      }
      for (const [cvpId, list] of clean.eventsByCvp) {
        const r = await cdb.saveEvents(agent, cvpId, list);
        saved.events = (saved.events || 0) + r.saved;
        if (r.unavailable) saved.unavailable = true;
      }
      // v2.924(SAN·CVP 설계 B-②): LLDP · MAC 테이블. saved.l2 는 **항상 수**로 답한다 — 엣지는 이 칸이 있어야 보낸 것으로 친다(구버전 중앙과 구분).
      saved.l2 = 0;
      for (const [cvpId, list] of clean.l2ByCvp || []) {
        const r = await cdb.saveL2(agent, cvpId, list, { requireDevice: true });   // 반증 L-6: 장비 레코드로 보고한 장비만
        saved.l2 += r.devices;
        if (r.unavailable) saved.unavailable = true;
      }
      // v2.935(SAN·CVP 설계 C-③): EndpointLocation. saved.ep 도 **항상 수** — 엣지는 이 칸이 있어야 보낸 것으로 친다(L2 와 같은 규약).
      saved.ep = 0;
      for (const [cvpId, list] of clean.epByCvp || []) {
        const r = await cdb.saveEndpoints(agent, cvpId, list);
        saved.ep += r.saved || 0;
        if (r.unavailable) saved.unavailable = true;
      }
    } catch (e) {
      console.warn(`[central] cvp-data: 적재 실패(${String(agent).slice(0, 64)}): ${e.message}`);
      return res.status(500).json({ ok: false, reason: `중앙 DB 적재 실패: ${e.message}` });
    }
    /*
     * v2.611(CEN2611-03): 적재할 것이 있었는데 DB 를 못 열었으면 **503**. 200 으로 두면 엣지가 커서·보낸 해시를 전진해 그 표본·
     *   레코드가 다시 오지 않았다(조용한 소실). 청크 0 의 상태는 위에서 이미 저장했다 — 화면은 '엣지 수집 상태' 를 계속 말한다.
     */
    if (saved.unavailable && (clean.devicesByCvp.size || clean.rows.length || clean.touch.length || clean.devSamples.length || clean.eventsByCvp.size || clean.l2ByCvp?.size || clean.epByCvp?.size)) {
      return persistent503(res).json({ ok: false, dbUnavailable: true, saved, reason: '중앙 CVP DB 를 쓸 수 없습니다 — 엣지는 커서를 전진하지 않고 다음 주기에 다시 보냅니다(중앙 로그의 [cvp-db] 줄 참조)', ...(edgeDropSummary({ dropped: clean.dropped })) });
    }
    // v2.640(③ 장애 전이): 엣지 보고가 적재됐으면 중앙의 전이 판정을 예약한다(디바운스 — 엣지 여럿의 push 를 한 번으로 모은다).
    if (clean.devicesByCvp.size || clean.touch.length || chunk === 0) {
      try { (await import('../../cvp/faultScan.js')).scheduleCvpFaultScan('edge-push'); } catch (e) { console.warn(`[central] cvp-data: 장애 판정 예약 실패: ${e.message}`); }
    }
    res.json({ ok: true, saved, ...(edgeDropSummary({ dropped: clean.dropped })) });
  });

  // ── 아이실론 디렉터리 사용량 위임(v2.736) — 엣지가 속한 법인의 아이실론을 그 엣지가 SSH 로 조사한다 ────────────────
  // GET /api/central/isidu-config?agent=<이름> — 이 엣지 몫 대상(주소·경로·주기 — **비밀 없음**: 접속은 엣지 자신의 SSH 키 또는
  // 엣지 스토리지 등록부 계정) + '지금 수집' 요청(claim→ack). 등록부·설정을 못 읽으면 503(엣지는 직전 사본을 유지 — v2.612·v2.631).
  centralRouter.get('/isidu-config', requireCentral(), async (req, res) => {
    const agent = strAgent(req.query.agent) || strAgent(req.get('X-Agent-Name'));
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const T = await import('../../isidu/targets.js');
    if (registryUnreadable(res, T.storageRegistryLoadError, '스토리지')) return;
    const S = await import('../../isidu/settings.js');
    if (settingsUnreadable(res, S.isiduSettingsLoadError, '아이실론 디렉터리 사용량')) return;
    const { takeIsiduRequests } = await import('../../isidu/collectRequests.js');
    const targets = T.targetsForAgent(agent).map(S.edgeTargetView);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, agent, targets, retentionDays: S.loadSettings().retentionDays, runNow: takeIsiduRequests(agent) });
  });

  /**
   * POST /api/central/isidu-data — 엣지가 조사한 결과(스캔 + 폴더 전체) 수신(v2.736).
   *  · 저장 이름은 인증된 agent(개별 토큰이면 바인딩 이름). 대상은 **그 엣지에 배정된 것만** 받는다(남의 대상 id 는 버리고 개수를 밝힌다).
   *  · 상태(엣지 SSH 공개키·폴러)는 등록부를 쓰지 않으므로 먼저 받는다 — 키는 화면이 보여 줘야 관리자가 아이실론에 등록한다.
   *  · 스캔이 있는데 등록부·설정·DB 를 못 쓰면 503(엣지는 커서를 전진하지 않고 다시 보낸다 — v2.611·v2.620 규약).
   *  · v2.743(감사 LEFT-08): 상태의 `runDropped`(엣지가 시작하지 않고 버린 '지금 수집' 요청)를 상태처럼 먼저 반영한다 — 그 요청을 결과 시한
   *    (최대 약 10시간)까지 기다리지 않고 사유와 함께 폐기한다(화면의 '결과 없이 폐기' 배너가 말한다). 등록부·설정을 쓰지 않는다.
   *    구버전 엣지는 이 필드가 없다(예전처럼 시한으로 정리). 응답 `runDrops` 로 몇 건을 정리했는지 돌려준다.
   */
  centralRouter.post('/isidu-data', requireCentral(), async (req, res) => {
    const authAgent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!authAgent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const E = await import('../../central/isiduEdge.js');
    const hasScans = Array.isArray(req.body?.scans) && req.body.scans.length > 0;
    E.saveIsiduEdgeStatus(authAgent, req.body?.status, { at: Date.now(), scans: hasScans ? Math.min(req.body.scans.length, 999) : 0 });
    const { ackIsiduCollect, applyIsiduEdgeDrops } = await import('../../isidu/collectRequests.js');
    const runDropsRes = applyIsiduEdgeDrops(authAgent, req.body?.status);
    if (runDropsRes?.applied) console.warn(`[central] isidu-data: ${String(authAgent).slice(0, 64)} 엣지가 '지금 수집' 요청 ${runDropsRes.applied}건을 시작하지 않고 버렸다고 알려 와 그 요청을 정리했습니다(사유는 화면의 폐기 안내)`);
    const runDrops = runDropsRes ? { runDrops: runDropsRes } : {};
    if (!hasScans) return res.json({ ok: true, saved: { inserted: 0, duplicates: 0 }, ...runDrops });
    const T = await import('../../isidu/targets.js');
    if (registryUnreadable(res, T.storageRegistryLoadError, '스토리지')) { console.warn('[central] isidu-data: 중앙 스토리지 등록부를 읽지 못해 503 으로 답했습니다(엣지는 다음 주기에 다시 보냅니다)'); return; }
    const S = await import('../../isidu/settings.js');
    if (settingsUnreadable(res, S.isiduSettingsLoadError, '아이실론 디렉터리 사용량')) return;
    const list = T.resolvedTargets();
    const owned = T.ownedTargetIds(authAgent, list);
    const node = canonicalAgent(authAgent, list.filter((r) => owned.has(r.id)).map((r) => r.agent));
    const clean = E.sanitizeIsiduScans(req.body, owned);
    if (clean.dropped.notOwned) console.warn(`[central] isidu-data: ${String(node).slice(0, 64)} 배정되지 않은 대상의 결과 ${clean.dropped.notOwned}건 거절`);
    const db = await import('../../isidu/db.js');
    const { notifyScanStored: notifyIsidu } = await import('../../isidu/notify.js');
    const saved = { inserted: 0, duplicates: 0, failed: 0 };
    if (clean.scans.length && !(await db.available())) {
      return persistent503(res).json({ ok: false, dbUnavailable: true, saved, reason: '중앙 디렉터리 사용량 DB 를 쓸 수 없습니다 — 엣지는 커서를 전진하지 않고 다음 주기에 다시 보냅니다(중앙 로그의 [isidu-db] 줄 참조)', ...(edgeDropSummary({ dropped: clean.dropped })), ...runDrops });
    }
    for (const sc of clean.scans) {
      // v2.741 EDGE-01: sc.srcTs(엣지 원본 시각)로 재전송 중복을 거른다 — 잘라 둔 시각(sc.ts)은 받을 때마다 다른 '지금' 이다.
      const r = await db.insertScan({ ...sc, agent: T.HISTORY_AGENT, node });
      if (!r.ok) { saved.failed++; console.warn(`[central] isidu-data: 적재 실패(${String(node).slice(0, 64)} · ${sc.targetId}): ${r.error}`); continue; }
      if (r.duplicate) saved.duplicates++; else saved.inserted++;
      // 실제로 적힌(재전송이면 처음 적은) 시각 — 기준선·완료 판정이 재전송마다 새 '지금' 으로 밀리지 않게.
      if (Number.isFinite(r.ts)) sc.ts = r.ts;
      // v2.738 결과 메일 — 새로 적재한 것만(재전송 중복은 보내지 않는다). 기다리지 않는다(응답을 늦추지 않게 — notify 는 던지지 않는다).
      if (!r.duplicate) notifyIsidu({ targetId: sc.targetId, scanId: r.id, ok: sc.ok === true, ts: sc.ts });
      // v2.740 A-02: 기준선·완료 판정은 **잘라 둔 시각(sc.ts)** 이다. 미래 시각(엣지 시계가 앞으로 튐)을 그대로 넣으면 기준선(최댓값)이
      // 미래에 굳어, 시계가 돌아온 뒤의 정상 결과가 '더 새 수집' 이 아니게 되어 '지금 수집' 요청이 결과 없이 폐기됐다(재현).
      // 시계 차이가 허용 범위(5분) 안이면 sc.ts 가 곧 엣지 시각이라 v2.591 '엣지 시계끼리 비교' 는 그대로다.
      E.noteIsiduScanTs(sc.targetId, sc.ts);
      ackIsiduCollect(sc.targetId, sc.ts);
    }
    // 시각을 잘라 받은 스캔(clamped)은 거절이 아니다 — rejected 합계에 넣지 않고 따로 밝힌다(엣지 시계가 앞서 있다는 진단).
    const clampedPart = clean.clamped ? { clamped: clean.clamped } : {};
    if (saved.failed) return persistent503(res).json({ ok: false, dbUnavailable: true, saved, reason: `중앙이 결과 ${saved.failed}건을 적재하지 못했습니다 — 엣지는 다음 주기에 다시 보냅니다`, ...(edgeDropSummary({ dropped: clean.dropped })), ...clampedPart, ...runDrops });
    if (clean.clamped && E.clampWarnDue(node)) console.warn(`[central] isidu-data: ${String(node).slice(0, 64)} 엣지 시계가 중앙보다 5분 넘게 앞서 결과 ${clean.clamped}건의 시각을 수신 시각으로 잘랐습니다(원본 시각으로 중복을 거릅니다)`);
    res.json({ ok: true, saved, ...(edgeDropSummary({ dropped: clean.dropped })), ...clampedPart, ...runDrops });
  });
}
