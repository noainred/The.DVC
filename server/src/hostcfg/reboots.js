/**
 * hostcfg/reboots.js — 'ESXi 호스트 구성 점검' 의 '최근 재부팅' 판정(v2.706 — C4, 순수).
 * 입력: 스냅샷 호스트의 bootTime(runtime.bootTime) + logs DB 의 호스트 운영 이벤트(유지보수 모드·연결 끊김·종료).
 *
 * 분류(근거를 같이 싣는다 — 원인을 단정하지 않는다)
 *  · planned    : 부팅 전 24시간 안에 유지보수 모드 진입 또는 vCenter 의 종료 요청이 있었다.
 *  · unexpected : 유지보수 모드 없이, 부팅 전 2시간 안에 vCenter 와 연결이 끊겼다 — PSOD·정전·전원 문제·수동 강제 재부팅 후보.
 *  · unknown    : 그 시간대 이벤트는 받았는데 유지보수·연결 끊김이 없다(직접 재부팅·짧은 끊김 등 — 판정하지 않는다).
 *  · no-events  : 이 포탈이 그 시간대 vCenter 이벤트를 받지 못했다(수집 꺼짐·보관 기간 밖·수집 시작 전). 판정 불가.
 *  · v2.721(감사 B1-04): 이벤트 읽기가 상한에서 잘렸으면(최신부터 읽으므로 readFrom 보다 오래된 이벤트가 입력에 없다)
 *    판정 창(부팅 전 24시간)이 readFrom 이하로 걸친 부팅은 근거가 빠졌을 수 있다 — 유지보수 근거가 보이지 않으면
 *    'unknown'·'unexpected' 로 단정하지 않고 'no-events' + readCut 으로 둔다(유지보수 근거가 보이면 그대로 planned).
 *  · v2.733(점검 3회차 C1-01): coverageOf 가 why(이 포탈이 **지금** 그 vCenter 이벤트를 수집하지 않는 사유 — logs/coverage.js)를 주면
 *    'no-events' 행에 notCollected(사유)를 싣고 counts 밖에서 noEventsNotCollected 로 센다 — '수집 실패·보관 기간 밖' 이 아니라
 *    '지금 수집하지 않는다' 가 원인이다(엣지 위임·비활성·점검중). 분류 자체는 바꾸지 않는다.
 */
const H = 3_600_000;
export const PLANNED_WINDOW_MS = 24 * H;
export const LOST_WINDOW_MS = 2 * H;
export const REBOOT_KINDS = Object.freeze(['unexpected', 'unknown', 'no-events', 'planned']);

/**
 * @param hosts   스냅샷 호스트(범위로 자른 것)
 * @param events  opsEvents 행(호스트 운영 종류 — 여러 호스트 섞임)
 * @param opts    { now, days, vcName:Map, coverageOf:(vcId)=>({firstTs,lastTs}) }
 */
export function analyzeReboots(hosts, events, { now = Date.now(), days = 30, vcName = new Map(), coverageOf = () => null, readFrom = null } = {}) {
  const since = now - days * 86_400_000;
  const byHost = new Map();
  for (const e of events || []) {
    const k = `${e.vcenterId}\u0000${e.entity}`;
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k).push(e);
  }
  const rows = [];
  const counts = { unexpected: 0, unknown: 0, 'no-events': 0, planned: 0 };
  let bootUnknown = 0; let readCut = 0; let noEventsNotCollected = 0;
  const cutAt = Number.isFinite(readFrom) ? readFrom : null;
  for (const h of hosts || []) {
    if (h.connectionState === 'DISCONNECTED') continue;
    if (!Number.isFinite(h.bootTime)) { bootUnknown += 1; continue; }
    if (h.bootTime < since) continue;
    const boot = h.bootTime;
    const evs = byHost.get(`${h.vcenterId}\u0000${h.name}`) || [];
    const before = (ms, types) => evs.filter((e) => types.includes(e.type) && e.ts <= boot && e.ts >= boot - ms).sort((a, b) => b.ts - a.ts)[0] || null;
    const maint = before(PLANNED_WINDOW_MS, ['EnteringMaintenanceModeEvent', 'EnteredMaintenanceModeEvent', 'HostShutdownEvent']);
    const lost = before(LOST_WINDOW_MS, ['HostConnectionLostEvent']);
    const cov = coverageOf(h.vcenterId);
    // 그 시간대 이벤트를 받았는가 — 부팅 시각 이후의 이벤트를 받은 적이 있고, 수집 시작이 부팅 2시간 전보다 이르면 받은 것으로 본다.
    const covered = !!cov && Number.isFinite(cov.lastTs) && cov.lastTs >= boot && Number.isFinite(cov.firstTs) && cov.firstTs <= boot - LOST_WINDOW_MS;
    let kind;
    const cut = cutAt != null && boot - PLANNED_WINDOW_MS <= cutAt;
    if (maint) kind = 'planned';
    else if (cut) { kind = 'no-events'; readCut += 1; }
    else if (lost) kind = 'unexpected';
    else kind = covered ? 'unknown' : 'no-events';
    counts[kind] += 1;
    const ncWhy = kind === 'no-events' && typeof cov?.why === 'string' && cov.why ? cov.why : null;
    if (ncWhy) noEventsNotCollected += 1;
    rows.push({
      id: h.id, name: h.name, vcenterId: h.vcenterId, vcenterName: vcName.get(h.vcenterId) || h.vcenterId, cluster: h.cluster || '',
      bootTime: boot, kind, readCut: !maint && cut,
      evidence: maint ? { type: maint.type, ts: maint.ts, user: maint.user || '' } : lost ? { type: lost.type, ts: lost.ts } : null,
      inMaintenanceNow: h.connectionState === 'MAINTENANCE',
      ...(ncWhy ? { notCollected: ncWhy } : {}),
    });
  }
  const order = Object.fromEntries(REBOOT_KINDS.map((k, i) => [k, i]));
  rows.sort((a, b) => order[a.kind] - order[b.kind] || b.bootTime - a.bootTime);
  return { days, since, counts, bootUnknown, readCut, noEventsNotCollected, rows: rows.slice(0, 500), omitted: Math.max(0, rows.length - 500) };
}
