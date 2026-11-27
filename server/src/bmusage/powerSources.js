/**
 * bmusage/powerSources.js — 전력 · 온도 집계의 **원천 묶음 하나**(8b 라우트 depsOf.sources 를 옮겼다 — 다음 점검 ②: 알림 규칙 판정이 같은 원천을 쓴다).
 *
 * 화면(routes/api/bmPower.js)과 알림 판정(bmusage/powerAlerts.js — 폴러 · 시험 실행)이 이 함수 하나를 쓴다(두 벌 금지 · 의존 방향: 라우트 → 도메인).
 *   측정은 엣지 사본까지(중앙이 보는 함대 전체) — 알림 판정에서 ‘이 노드가 판정하는 서버인가’ 는 원천을 거르지 않고 판정 노드 함수 하나(powerJudge.js)가 정한다
 *   (반증 n2 F4 — 첫 판의 localOnly 거르기를 판정 노드 함수로 바꿨다: 화면과 알림이 같은 함수로 ‘판정 노드 없음 + 사유’ 를 말하게).
 * 인벤토리는 원본 그대로 넘긴다 — ‘지금 사실’ 인가(2시간)는 집계(powerAgg)가 hwFacts capStateAt 하나로 정한다(점검 반복 6회차 Y: 예전에는 여기서 로컬만 걸러
 *   엣지 사본 인벤토리는 3일 전 상한도 set 이었고, 봉투 갈래는 stale 이었다 — 같은 사실이 갈래마다 달랐다).
 */

export async function powerSources({ now = Date.now() } = {}) {
  const [svc, ana, inv, ss, rt, pf, idb] = await Promise.all([import('../idrac/service.js'), import('../insights/analysisServers.js'), import('../idrac/invCache.js'),
    import('../idrac/sensorStore.js'), import('../idrac/roomTemp.js'), import('../partfault/db.js'), import('../idrac/db.js')]);
  return {
    measured: async () => svc.allMeasuredPower({ hosts: [] }),
    analysisServers: async () => ana.analysisServersWithRemote(),
    fanFaults: async () => (pf.partFaultDbExists() ? (await pf.openFaults({ scope: 'idrac' })).filter((f) => f.kind === 'fan') : null),
    powerDb: () => idb.getDb(),
    inventoryOf: (a, regId) => (a?.remote ? (a.inv || null) : inv.getInventory(String(a?.id || regId || ''))) || null,   // 원본(신선도는 powerAgg capStateAt)
    sensorLatest: (id) => ss.getSensorSeries(id, { minutes: 0 }).latest || null,
    temps: { classify: rt.classifySensor, maxAgeOf: (latest, remote) => rt.sampleMaxAgeMs(rt.DEFAULT_MAX_AGE_MS, latest, { remote, localCycle: ss.sensorPollCycle(now) }) },
  };
}
