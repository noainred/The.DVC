/**
 * routes/central/storageRoutes.js — 스토리지 · 파트 장애 · 엣지 로그 · 베어메탈 사용률 위임
 *
 * v2.954(개선 검토 4번 — 사용자 선택 '동작 그대로 영역별 파일 이동'): routes/central.js(2,966줄)에서 이 영역의 엣지 수신 · 설정 인출 라우트를
 *   **글자 그대로** 옮겼다. 등록은 central.js 가 원래 자리에서 `registerStorageRoutes(centralRouter)` 로 부른다 — 라우트 순서 · 미들웨어 · 응답이 같다
 *   (회귀 `test/centralSplit2954.test.js` 가 등록 순서 · 개수 · 순환 없음을 고정한다 — 분할 때 라우트 본문은 원문 비교로 0 차이). 공용 판정(requireCentral · 503 응답 등)은 central.js 의 것을 그대로 쓴다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { capTrim } from '../../util/capStr.js';
// central.js 의 공용 판정 — 등록 때 인자로 받는다(import 하면 central.js ↔ 이 파일 순환이 생긴다 — archScan IMPORT_CYCLE_MAX)
let edgeNameKnown, edgeNameRegistered, intervalsPartOrUnreadable, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent;

/**
 * v2.607(감사 CEN2607-03 — 재현): 엣지 장비 수신은 **토큰 종류와 무관하게** 중앙 직접 수집 장비(등록부에 있고 agent 가
 *   빈 장비)를 거절한다 — v2.600 edgeVcWriteDenied(requireSite 없이)와 같은 판단(소유권이 아니라 대상의 구조적 성질: 엣지는
 *   그 장비를 수집하지 않는다). 예전에는 공유 토큰 발신자가 중앙 직접 수집 Unity 의 deviceId 로 9 PB 를 보내 목록과 용량
 *   이력(capacity_history)을 덮을 수 있었다. 등록부에 없는 id 는 형제 /inventory 와 같이 여기서 거절하지 않는다(목록의
 *   고아 TTL 이 정리한다 — 정직 기록: 그 id 의 스냅샷은 보관된다). 공유 토큰의 이름 좁히기는 하지 않는다(레거시 신뢰 유지).
 *   원소가 객체가 아니거나 id 가 없으면 여기서 판정하지 않고 뒤의 수신 정리(sanitizeEdgeDevices)가 센다.
 * @returns {Promise<{ list: any[], denied: number }>}
 */
/**
 * v2.630(감사 A4-02): 엣지 push 의 collectedAt 을 두 값으로 나눈다.
 *  - collectedAt       : 표시·병합용 — 중앙 수신 시각으로 clamp(v2.416 L-1: 미래 시각이 '최신 우선' 병합을 항상 이기지 않게).
 *  - edgeCollectedAt   : 엣지가 보낸 **원래 값(엣지 시계)**. 위임 '지금 수집' 큐의 완료 판정(v2.591 기준선 = 같은 시계의 두 값)과
 *                        같은 스냅샷 재전송 판별(_lastRec)은 이 값을 써야 한다. clamp 값은 중앙 시계가 섞여 엣지 시계가 빠르면
 *                        같은 옛 스냅샷이 재전송마다 '지금' 으로 새로 찍혀 요청이 새 수집 없이 완료되고 작업 로그가 중복됐다.
 *  - edgeClockAheadMs  : 엣지 시각이 수신 시각보다 5초 넘게 앞서면 그 차이(시계 빠름) — 신선도 표시가 '방금' 으로 보이는
 *                        이유를 화면이 밝힐 수 있게 싣는다. 모르면 싣지 않는다(0 을 지어내지 않는다).
 * 원래 값을 읽지 못하면(숫자 아님) edgeCollectedAt 은 null 이고 collectedAt 은 예전처럼 수신 시각이다.
 */
export const EDGE_CLOCK_AHEAD_TOLERANCE_MS = 5_000;

export function stampEdgeCollectedAt(d, now) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
  const orig = numOrNull(d.collectedAt);
  const edgeTs = orig != null && orig > 0 ? orig : null;
  const out = { ...d, collectedAt: Math.min(edgeTs ?? now, now), edgeCollectedAt: edgeTs };
  if (edgeTs != null && edgeTs - now > EDGE_CLOCK_AHEAD_TOLERANCE_MS) out.edgeClockAheadMs = edgeTs - now;
  else delete out.edgeClockAheadMs; // 엣지가 보낸 값을 믿지 않는다 — 중앙이 계산한 것만 싣는다
  return out;
}

/** v2.965 반증 F1: 엣지 원소의 deviceId 를 저장 키와 같은 모양(글자 · 앞뒤 공백 뗌 · 128자 — capTrim)으로 맞춘다. 객체가 아니면 그대로(저장 단계가 뺀다). */
export function normDeviceIds(list) {
  return (Array.isArray(list) ? list : []).map((e) => (e && typeof e === 'object' && !Array.isArray(e) ? { ...e, deviceId: capTrim(e.deviceId, 128) } : e));
}

export async function onlyDelegated(list, idOf, registryPath) {
  // v2.954(분할): 경로 문자열은 호출부가 routes/ 기준으로 준다(receiveRegistryUnreadable 와 같은 값) — 이 파일은 routes/central/ 라 routes/ 기준으로 푼다
  const reg = await import(new URL(registryPath, new URL('../central.js', import.meta.url)).href);
  const direct = new Set(reg.listDevices().filter((d) => d && d.id != null && !String(d.agent || '').trim()).map((d) => String(d.id)));
  if (!direct.size) return { list, denied: 0 };
  const kept = list.filter((d) => {
    const id = d && typeof d === 'object' ? idOf(d) : null;
    return !((typeof id === 'string' || typeof id === 'number') && direct.has(String(id)));
  });
  return { list: kept, denied: list.length - kept.length };
}

/** v2.601(감사 EDGE2601-04): 소유권 필터로 뺀 수를 dropped.notOwned 로 합친다(원 객체는 바꾸지 않는다). */
export function withNotOwned(info, notOwned) {
  if (!notOwned) return info;
  return { ...(info || {}), dropped: { ...((info && info.dropped) || {}), notOwned } };
}

/** v2.599: 엣지 장비 수신 정리 결과를 응답 필드로(뺀 것이 없으면 빈 객체). */
export function edgeDropSummary(info) {
  const d = info?.dropped || {};
  const n = Object.values(d).reduce((a, x) => a + (Number(x) || 0), 0);
  return {
    ...(n ? { rejected: n, dropped: d } : {}),
    ...(info?.coerced ? { coerced: info.coerced } : {}),
    ...(info?.evicted ? { evicted: info.evicted } : {}),
    ...(info?.trimmed ? { zoningTrimmed: info.trimmed } : {}),   // v2.600 RECENT2600-02 — 조닝을 잘라 받은 장비 수(버린 것 아님)
  };
}

/** central.js 가 원래 자리에서 부른다(등록 순서 유지). */
export function registerStorageRoutes(centralRouter, deps) {
  ({ edgeNameKnown, edgeNameRegistered, intervalsPartOrUnreadable, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent } = deps);
  // ── 스토리지 모니터링 위임(v2.302) ────────────────────────────────────────────
  // GET /api/central/storage-config?agent=<이름> — 이 엣지 몫 스토리지 장비 목록(자격증명 포함:
  // 엣지가 장비에 로그인해야 한다 — gpu-guest-config 의 계정 배포와 같은 신뢰 경계·WAN TLS 검증 ON).
  // 개별 토큰이면 바인딩된 agent 와 요청 agent 불일치를 거부(자격증명 횡탈 차단 — 헤더 규약 2).
  centralRouter.get('/storage-config', requireCentral(), async (req, res) => {
    const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    // v2.613 DEPS2613-09: 토큰↔agent 대조는 위 `centralRouter.use` 미들웨어가 requestedAgent 로 이미 했다(여기 있던 재대조는 도달 불가 중복).
    const { devicesForAgent, registryLoadError: storageRegErr } = await import('../../storage/registry.js');
    if (registryUnreadable(res, storageRegErr, '스토리지')) return;
    // collectNow(v2.316): 중앙 UI 의 '수집' 클릭이 남긴 재수집 요청을 one-shot 으로 서빙 —
    // 엣지는 이 목록을 즉시 수집 + 즉시 push 한다(agent/storageConfigPull.js 참조).
    const { takeRequestsForAgent } = await import('../../storage/collectRequests.js');
    // intervals(v2.409): 중앙이 이 엣지에 지정한 수집 주기(전역 위에 엣지별 덮어쓰기). **지정한 키만**
    // 내려간다 — 전 키를 채워 보내면 엣지 portal.env 의 현장 설정을 통째로 덮어쓴다(intervals.js 계약).
    const { intervalsForAgent, storageIntervalsLoadError } = await import('../../storage/intervals.js');
    const ivPart = intervalsPartOrUnreadable(req, res, storageIntervalsLoadError, '스토리지 수집 주기', () => intervalsForAgent(agent));
    if (!ivPart) return;
    // v2.965: PowerScale 점검 요청(주간 회차 · '지금 점검') — 수집 요청 큐와 따로(claim → ack). 엣지는 받아서 로컬로 점검하고 결과를 다음 push 에 싣는다.
    const { takeInspectRequests } = await import('../../storage/inspect/requests.js');
    const inspectNow = takeInspectRequests(agent);
    res.json({
      ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent),
      ...(inspectNow.length ? { inspectNow } : {}),
      ...ivPart,
    });
  });

  // POST /api/central/part-faults — 엣지가 **로컬에서 판정한 파트 장애만** 올린다(v2.547).
  // 사용자 지시: "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘".
  // ⚠ 본문은 `{open[], scanned, deviceOk}` 이고 **open 이 0건이어도 받는다** — 요약이 있어야
  //   중앙이 '정상' 과 '수집 안 됨' 을 구분한다(v2.517 규약. `storage/push.js:30` 의 미수정 결함
  //   — 장비 0대면 POST 자체를 안 하는 것 — 을 이 경로는 반복하지 않는다).
  // ⚠ BIG_JSON 등록 필수(index.js) — 열린 장애가 많은 법인이 413 으로 **조용히 전량 소실**된다.
  centralRouter.post('/part-faults', requireCentral(), async (req, res) => {
    // 개별 토큰이면 **인증된 agent** 만 쓴다(body.agent 를 믿지 않는다 — 자격증명 횡탈 차단).
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { putEdgeReport } = await import('../../central/partFaultEdge.js');
    // v2.548: 프로토콜 2(장애 + 전체 요약) — 수신이 스토리지·SAN 소유권을 검사하고(rejected) agent 를 덮어쓴다.
    // 수신 예외는 400 으로 답한다 — async 핸들러의 throw 는 express 4 가 잡지 않아 요청이 **응답 없이 매달린다**(v2.548 S1).
    let r;
    try { r = await putEdgeReport(agent, req.body || {}); } catch (e) {
      return res.status(400).json({ ok: false, reason: `본문 형식 오류: ${String(e?.message || e).slice(0, 200)}` });
    }
    // v2.621(감사 EDGE-04): 중앙 스토리지·SAN 등록부 손상이면 소유 판정을 하지 않고 503(형제 수신 receiveRegistryUnreadable 과 같은 모양) —
    //   빈 소유 집합으로 전부 '미소유' 로 버리고 200 을 주면 직전 보고가 교체돼 새 장애 탐지가 멈췄다. 503 은 엣지가 다음 주기에 다시 보낸다.
    if (r.registryUnreadable) {
      const u = r.registryUnreadable;
      registryUnreadable(res, () => ({ at: u.at, reason: u.reason }), u.what);
      console.warn(`[central] part-faults 수신: 중앙 ${u.what} 등록부를 읽지 못해 503 으로 답했습니다(엣지는 다음 주기에 다시 보냅니다)`);
      return;
    }
    if (!r.ok) return res.status(r.refused ? 429 : 400).json(r); // v2.605(CEN2605-02): 엣지 수 상한 거절은 429(형제 수신과 같다)
    // 응답에 중앙의 스위치 상태를 실어 보낸다 — 엣지가 '보냈는데 중앙이 꺼져 있다' 를 알 수 있게.
    const { partFaultEnabled } = await import('../../partfault/settings.js');
    // v2.607(감사 EDGE2607-02): 상한으로 버린 파트 수도 돌려준다 — 예전에는 중앙 보관분에만 있어 엣지가 알 수 없었다.
    return res.json({ ok: true, agent, protocol: r.protocol, devices: r.devices, rejected: r.rejected, open: r.open, ...(r.partsOmitted ? { partsOmitted: r.partsOmitted } : {}), centralEnabled: partFaultEnabled().enabled });
  });

  /**
   * 엣지 로그 폴백 큐(v2.549) — 중앙이 그 엣지에 **닿지 못할 때만** 쓰인다.
   * 엣지가 대기 요청을 인출(claim)하고 결과를 회신(ack)한다. 미들웨어가 이미 `?agent=` 와 토큰의
   * agent 일치를 강제하므로(개별 토큰), 여기서는 그 값을 그대로 쓴다.
   */
  centralRouter.get('/edge-log-jobs', requireCentral(), async (req, res) => {
    const agent = String(req.centralAuth.agent || req.query.agent || '').trim();
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { takeEdgeLogJob } = await import('../../central/edgeLogJobs.js');
    res.json({ ok: true, job: takeEdgeLogJob(agent) });
  });

  centralRouter.post('/edge-log-result', requireCentral(), async (req, res) => {
    // ⚠ 저장 키는 **인증된 agent** 다 — 본문의 `node.agent` 를 믿지 않는다(v2.548 F5 와 같은 규칙).
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : (strAgent(req.body?.agent) || strAgent(req.query?.agent));
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    try {
      const [{ putEdgeLog }, { ackEdgeLogJob }] = await Promise.all([
        import('../../central/edgeLogStore.js'), import('../../central/edgeLogJobs.js'),
      ]);
      // ⚠ v2.602(감사 CEN2602-02): 공유 토큰은 본문 agent 를 마음대로 고를 수 있다 — 예전에는 그 이름으로 **다른 엣지의
      //   보관분을 덮었다**. 공유 토큰 회신은 ① 중앙이 아는 이름(edgeNameKnown)이고 ② 중앙이 실제로 그 엣지에 요청해 둔
      //   작업(acked)일 때만 저장한다. 개별 토큰은 인증된 이름이므로 예전대로(요청 없는 회신도 버리지 않고 밝힌다).
      const shared = req.centralAuth?.mode !== 'agent';
      // v2.605(RECENT2605-02): 폴백 큐는 **중앙이 닿지 못하는 엣지**를 위한 경로다 — 그런 공유 토큰 엣지는 자기등록 검증도 pull 성공도
      //   없어 selfRegUnverified 로 남고 edgeNameKnown 에서 빠진다(v2.604 CEN2604-04). 그래서 회신이 영원히 403 이었다(인출은 되는데
      //   회신만 거부). 수집 서버 **등록부에 있는 이름**(미검증 포함)이면 받되, ② acked(중앙이 그 이름으로 요청해 둔 작업) 조건은 그대로
      //   요구한다 — 요청 없이 이름만 골라 보관분을 덮는 길(v2.602)은 계속 막힌다. /fleet 의 미검증 귀속 비움(v2.601)은 건드리지 않는다.
      if (shared && !edgeNameKnown(agent) && !edgeNameRegistered(agent)) return res.status(403).json({ ok: false, reason: `중앙이 모르는 엣지 이름(${agent}) — 공유 토큰 회신은 등록된 엣지 이름만 받습니다.`, unverifiedAgent: true });
      const { acked } = ackEdgeLogJob(agent);
      if (shared && !acked) return res.json({ ok: true, agent, stored: false, acked, reason: '요청한 적 없는 공유 토큰 회신은 보관하지 않습니다(다른 엣지 보관분을 덮지 못하게).' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const rec = putEdgeLog(agent, { ...body, via: 'job', ok: true });
      // `acked:false` 는 '요청한 적 없는 회신'(기한 초과로 회수됐거나 중앙이 재시작) — 버리지 않고 밝힌다.
      res.json({ ok: true, agent, stored: !!rec, acked });
    } catch (e) {
      // async throw 는 express 4 가 잡지 않아 요청이 응답 없이 매달린다(v2.548 S1).
      res.status(400).json({ ok: false, reason: `본문 형식 오류: ${String(e?.message || e).slice(0, 200)}` });
    }
  });

  // 파트 장애 스위치 배포(v2.548 F3) — 엣지가 주기적으로 GET. 중앙 관리자가 전체/엣지별로 정한 값만 내려간다.
  centralRouter.get('/partfault-config', requireCentral(), async (req, res) => {
    const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
    const { settingsForAgent, partFaultSettingsLoadError } = await import('../../partfault/settings.js');
    if (settingsUnreadable(res, partFaultSettingsLoadError, '파트 장애')) return; // v2.631 EDGE2631-01
    res.json({ ok: true, settings: settingsForAgent(agent) });
  });

  // v2.627 베어메탈 사용률 설정 배포(사용자 요청 "한번에 켜는 기능") — 엣지가 주기적으로 GET. 중앙이 배포를 켜고 그 엣지를
  //   제외하지 않았으면 배포 키(Enterprise 제외)를 내려주고, 아니면 distribute:false + 사유(엣지는 사본을 지워 로컬로 돌아간다).
  //   v2.927: 전체 배포가 덮지 않는 엣지라도 '중앙에서 켜기' 가 저장돼 있으면 그 엣지만 켜는 판(mode:'per-edge')을 내려준다.
  //   `?applied=<sig>` 는 엣지가 지금 적용 중인 판 — 화면이 '적용됨 / 대기' 를 가르는 근거다(인메모리 기록).
  centralRouter.get('/bmusage-config', requireCentral(), async (req, res) => {
    const agent = String(req.centralAuth.agent || req.query.agent || '').trim();
    const { distributeFor, recordBmUsagePull, bmUsageSettingsLoadError } = await import('../../bmusage/settings.js');
    // v2.631 EDGE2631-01: 배포 설정·로컬 설정 중 하나라도 손상이면 distribute:false(엣지가 사본을 지움) 나 기본값 배포 대신 503.
    // v2.632(감사 AX1-2632-02): 503 전에 인출 기록을 남긴다 — 예전에는 기록 없이 반환해 배포 현황이 '인출 기록 없음'(중립)으로만 보였다.
    {
      let le = null; try { le = bmUsageSettingsLoadError(); } catch (x) { le = { reason: x?.message || String(x) }; }
      if (le) recordBmUsagePull(agent, { appliedSig: String(req.query.applied || ''), version: String(req.get('x-agent-version') || ''), reason: 'settings-unreadable', verified: req.centralAuth?.mode === 'agent', deliveredSig: '' });
    }
    if (settingsUnreadable(res, bmUsageSettingsLoadError, '베어메탈 사용률')) return;
    // v2.927 '중앙에서 켜기': 한 엣지만 켜는 판은 **개별 토큰으로 검증된 이름**에만 내준다(공유 토큰의 ?agent= 는 남의 이름을 댈 수 있다 —
    //   켜진 설정·그 엣지 법인 목록을 받아 가지 못하게). 법인은 **저장 때 확정한 목록**을 그대로 보낸다(인출 때 매핑을 다시 계산하지 않는다 —
    //   점검중·push 전·fleet 만료·중앙 재기동 같은 순간 상태가 엣지 수집을 끄지 않게. 반증 F2).
    const verified = req.centralAuth?.mode === 'agent';
    const out = distributeFor(agent, { verified });
    recordBmUsagePull(agent, { appliedSig: String(req.query.applied || ''), version: String(req.get('x-agent-version') || ''), reason: out.distribute ? '' : out.reason, verified, deliveredSig: out.distribute ? String(out.sig || '') : '' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...out });
  });

  // 7b단계 서버 등록 배포 — 수집 경로 ‘edge’ 로 등록한 서버 목록(비밀 없음 — 공통 계정 · 키는 이름만). 엣지가 주기적으로 GET.
  //   **개별 토큰으로 인증된 이름에만** 행을 준다(공유 토큰의 ?agent= 는 남의 법인 서버 목록을 받아 갈 수 있다 — v2.589 규약).
  //   `?applied=<서명>&ok=&rej=&rm=` 은 엣지가 지금 적용한 판과 결과 수(숫자만) — 화면이 '반영됨 / 대기' 를 가른다(인메모리 기록).
  centralRouter.get('/bm-onboard', requireCentral(), async (req, res) => {
    const verified = req.centralAuth?.mode === 'agent';
    const agent = verified ? String(req.centralAuth.agent || '').trim() : String(req.query.agent || '').trim();
    const ED = await import('../../bmusage/onboard/edgeDeploy.js');
    const num = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null; };
    if (verified) {
      ED.recordOnboardPull(agent, { appliedSig: String(req.query.applied || ''), version: String(req.get('x-agent-version') || ''), applied: { ok: num(req.query.ok), rejected: num(req.query.rej), removed: num(req.query.rm) } });
      try { ED.settlePending(agent, String(req.query.applied || '').slice(0, 64)); } catch { /* 정리 실패는 다음 인출에 다시 */ }   // 7b 반증 F14
    }
    if (settingsUnreadable(res, ED.edgeDeployLoadError, '서버 등록 배포(bm-onboard-edge.json)')) return;   // 엣지는 지난 등록을 그대로 둔다
    const out = ED.deployFor(agent, { verified });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...out });
  });

  // 8a단계 정비 창 배포 — 그 엣지 법인의 진행 중 · 예정 창(태그 창은 그 엣지 대상의 키로 펼친다 · bmusage/maint/deploy.js). 엣지가 주기적으로 GET.
  //   **개별 토큰으로 인증된 이름에만** 준다(공유 토큰의 ?agent= 는 남의 법인 정비 일정을 받아 갈 수 있다 · 억제 범위를 남에게 씌울 수 없다).
  //   중앙 창 파일을 못 읽으면 503(빈 목록을 보내 엣지 억제를 지우지 않는다 — 엣지는 받은 지 24시간까지 지난 배포본을 쓴다).
  //   `?applied=<서명>` 은 엣지가 지금 쓰는 판(숫자 · 서명만 — 화면 ‘반영됨 / 대기’).
  centralRouter.get('/bm-maint', requireCentral(), async (req, res) => {
    const verified = req.centralAuth?.mode === 'agent';
    const agent = verified ? String(req.centralAuth.agent || '').trim() : String(req.query.agent || '').trim();
    const DP = await import('../../bmusage/maint/deploy.js');
    if (verified) DP.recordMaintPull(agent, { appliedSig: String(req.query.applied || '').slice(0, 64), version: String(req.get('x-agent-version') || '') });
    const ST = await import('../../bmusage/maint/store.js');
    if (settingsUnreadable(res, ST.maintLoadError, '정비 창(maintenance-windows.json)')) return;
    try {
      const out = await DP.deployFor(agent, { verified });
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...out });
    } catch (e) { res.status(e?.status === 503 ? 503 : 500).json({ ok: false, reason: String(e?.message || e).slice(0, 200) }); }
  });

  // v2.994(물리서버 폴더 묶음 D — 설계 bm-folders §11): 엣지가 자기 법인의 폴더 사본을 주기적으로 GET. **개별 토큰으로 인증된 이름에만** 준다
  //   (공유 토큰의 ?agent= 는 남의 법인 폴더 · 서버 이름을 받아 갈 수 있다 → distribute:false). 저장소를 못 읽으면 503(엣지는 지난 사본을 그대로 둔다).
  //   `?have=<세대>` 는 엣지가 지금 가진 판(중앙 법인 표의 '엣지 전달').
  centralRouter.get('/bm-folders', requireCentral(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.centralAuth?.mode !== 'agent' || !String(req.centralAuth.agent || '').trim()) return res.json({ ok: true, distribute: false, reason: 'unverified' });
    const agent = String(req.centralAuth.agent).trim();
    const EB = await import('../../bmfolders/edgeBundle.js');
    EB.recordEdgeSync(agent, { have: String(req.query.have || '').slice(0, 64), version: String(req.get('x-agent-version') || '') });
    try {
      const { edgeBundleFor } = await import('../api/bmFolders.js');
      const out = await edgeBundleFor(agent);
      if (out.unreadable) return res.status(503).json({ ok: false, reason: 'settingsUnreadable', detail: '물리서버 폴더 저장소(bm-folders.json · bm-folders-assign.json)를 읽지 못했습니다' });
      res.json({ ok: true, distribute: true, bundle: out });
    } catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 200) }); }
  });

  // POST /api/central/storage-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
  // **인증된 agent**(개별 토큰 바인딩)만 쓴다. 공유 토큰(레거시)은 body.agent 신뢰(TOFU — 기존 축과 동일).
  centralRouter.post('/storage-data', requireCentral(), async (req, res) => {
    const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
    const { saveEdgeStorage, saveEdgeStorageStatus } = await import('../../central/storageEdge.js');
    // v2.581(BUG-D): 상태 전용 보고(엣지가 0대일 때) — 장비 목록은 건드리지 않고 상태만 기록한다.
    if (req.body?.statusOnly === true) {
      const saved = saveEdgeStorageStatus(agent, req.body?.status);
      return res.json({ ok: true, saved: 0, statusOnly: true, recorded: saved });
    }
    if (await receiveRegistryUnreadable(res, '../storage/registry.js', '스토리지')) return; // v2.620(EDGE2620-01)
    // 소유권 필터(v2.417, sanswitch-data 와 동일): 개별 토큰 엣지는 자기에게 위임된 deviceId 만,
    // collectedAt 은 수신 시각으로 clamp. 공유 토큰(레거시)은 기존 신뢰 유지.
    let devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
    let notOwned = 0; // v2.601 EDGE2601-04: 소유권 필터로 뺀 수도 응답에 싣는다(엣지가 상태·콘솔에 남긴다)
    const now = Date.now();
    devices = devices.map((d) => stampEdgeCollectedAt(d, now)); // v2.630 A4-02: 원본 엣지 시각은 edgeCollectedAt 으로 따로
    {
      const r = await onlyDelegated(devices, (d) => d.deviceId ?? d.id, '../storage/registry.js'); // v2.607 CEN2607-03
      devices = r.list; notOwned += r.denied;
      if (r.denied) console.warn(`[central] storage-data: ${String(agent).slice(0, 64)} 중앙 직접 수집 장비 ${r.denied}건 거절`);
    }
    let ownedSet = null; // v2.932: 개별 토큰 엣지의 위임 장비 집합 — 장비 목록과 표본 고리가 같은 집합으로 걸러진다
    if (req.centralAuth.mode === 'agent') {
      const { devicesForAgent } = await import('../../storage/registry.js');
      const owned = new Set(devicesForAgent(agent).map((d) => d.id));
      ownedSet = new Set([...owned].map((x) => String(x)));
      const before = devices.length;
      devices = devices.filter((d) => d && owned.has(d.deviceId));
      notOwned += before - devices.length;
      if (before - devices.length) console.warn(`[central] storage-data: ${agent} 미위임 deviceId ${notOwned}건 드롭(위조 방지)`);
    }
    // v2.932(2차 ⑨): 엣지 5분 표본 고리(`nodeLoadSamples`) — 장비 목록과 **같은 소유권 필터**(중앙 직접 장비 거절 · 개별 토큰은 위임분만)를 지난 뒤
    //   중앙 DB 에 적재한다(storageEdge.saveEdgeNodeLoadSamples — 아는 필드만·상한·ts 는 수신 시각 이하). 응답 `nodeLoadSamples` 가 받은·적재·중복·뺀 수를 말한다
    //   (엣지가 그것으로 고리를 비우고 상태에 남긴다). 본문에 키가 없으면(구버전 엣지) 아무것도 하지 않고 응답에도 싣지 않는다.
    let sampleAck = null;
    if (Array.isArray(req.body?.nodeLoadSamples) && req.body.nodeLoadSamples.length) {
      let list = normDeviceIds(req.body.nodeLoadSamples.slice(0, 500));  // v2.965 반증 F1: 저장이 쓰는 id(앞뒤 공백 뗌)로 먼저 맞춘 뒤 소유권을 본다
      let denied = 0;
      { const r = await onlyDelegated(list, (d) => d.deviceId, '../storage/registry.js'); list = r.list; denied += r.denied; }
      if (ownedSet) { const before = list.length; list = list.filter((d) => d && typeof d === 'object' && ownedSet.has(String(d.deviceId))); denied += before - list.length; }
      const { saveEdgeNodeLoadSamples } = await import('../../central/storageEdge.js');
      sampleAck = { ...(await saveEdgeNodeLoadSamples(agent, list, { now })), ...(denied ? { notOwned: denied } : {}) };
      if (denied) console.warn(`[central] storage-data: ${String(agent).slice(0, 64)} 미위임·중앙 직접 장비의 노드 부하 표본 ${denied}건 드롭`);
    }
    // v2.965: PowerScale 점검 결과(`inspectRuns`) — 표본 고리와 **같은 소유권 필터**(중앙 직접 장비 거절 · 개별 토큰은 위임분만)를 지난 뒤
    //   중앙 이력에 적는다(central/storageInspectEdge.js — 아는 필드만 · facts 화이트리스트 · at 은 수신 시각 이하). 응답 `inspectRuns` 가 받은 · 기록 · 중복 · 뺀 수를 말한다.
    let inspectAck = null;
    if (Array.isArray(req.body?.inspectRuns) && req.body.inspectRuns.length) {
      // 반증 F1: id 를 저장 키와 같은 모양(앞뒤 공백 뗌 · 128자)으로 **먼저** 맞춘다 — 원문으로 소유권을 보고 저장에서 trim 하면 ' isi-direct ' 가 필터를 지나 중앙 직접 장비 이력을 쓴다.
      let list = normDeviceIds(req.body.inspectRuns.slice(0, 500));
      let denied = 0;
      { const r = await onlyDelegated(list, (d) => d?.deviceId, '../storage/registry.js'); list = r.list; denied += r.denied; }
      if (ownedSet) { const before = list.length; list = list.filter((d) => d && typeof d === 'object' && ownedSet.has(String(d.deviceId))); denied += before - list.length; }
      // 반증 F9: 등록된 아이실론 장비만 — 공유 토큰이 모르는 id 를 대량으로 보내 실제 장비 이력을 밀어내지 못하게.
      let unknownDevice = 0;
      { const { listDevices } = await import('../../storage/registry.js'); const known = new Set(listDevices().filter((d) => d && d.type === 'isilon').map((d) => String(d.id)));
        const before = list.length; list = list.filter((d) => d && typeof d === 'object' && known.has(String(d.deviceId))); unknownDevice = before - list.length; }
      const { saveEdgeInspectRuns } = await import('../../central/storageInspectEdge.js');
      inspectAck = { ...saveEdgeInspectRuns(agent, list, { now }), ...(denied ? { notOwned: denied } : {}), ...(unknownDevice ? { unknownDevice } : {}) };
      if (denied) console.warn(`[central] storage-data: ${String(agent).slice(0, 64)} 미위임·중앙 직접 장비의 점검 결과 ${denied}건 드롭`);
    }
    // v2.599(CEN-2599-03·04·05): 모듈이 원소를 정리하고(객체 아님·식별자 아님·크기 초과를 빼고 표시 필드의 객체 값은 null)
    //   뺀 개수를 info 에 싣는다 — 응답이 그 사실을 말한다(조용한 제외 금지).
    const info = {};
    const saved = saveEdgeStorage(agent, devices, info);
    if (info.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
    res.json({ ok: true, saved, ...(sampleAck ? { nodeLoadSamples: sampleAck } : {}), ...(inspectAck ? { inspectRuns: inspectAck } : {}), ...(edgeDropSummary(withNotOwned(info, notOwned))) });
  });
}
