/**
 * bmusage/powerSources.js — 전력 · 온도 집계의 **원천 묶음 하나**(8b 라우트 depsOf.sources 를 옮겼다 — 다음 점검 ②: 알림 규칙 판정이 같은 원천을 쓴다).
 *
 * 화면(routes/api/bmPower.js)과 알림 판정(bmusage/powerAlerts.js — 폴러 · 시험 실행)이 이 함수 하나를 쓴다(두 벌 금지 · 의존 방향: 라우트 → 도메인).
 *   측정은 엣지 사본까지(중앙이 보는 함대 전체) — 알림 판정에서 ‘이 노드가 판정하는 서버인가’ 는 원천을 거르지 않고 판정 노드 함수 하나(powerJudge.js)가 정한다
 *   (반증 n2 F4 — 첫 판의 localOnly 거르기를 판정 노드 함수로 바꿨다: 화면과 알림이 같은 함수로 ‘판정 노드 없음 + 사유’ 를 말하게).
 * 인벤토리는 INV_FRESH_MS(2시간) 안의 것만 ‘지금 사실’ 이다(hwFacts 와 같은 판단 — 낡은 상한을 걸림 판정에 쓰지 않는다).
 */
export const INV_FRESH_MS = 2 * 3_600_000;

export async function powerSources({ now = Date.now() } = {}) {
  const [svc, ana, inv, ss, rt, pf, idb] = await Promise.all([import('../idrac/service.js'), import('../insights/analysisServers.js'), import('../idrac/invCache.js'),
    import('../idrac/sensorStore.js'), import('../idrac/roomTemp.js'), import('../partfault/db.js'), import('../idrac/db.js')]);
  return {
    measured: async () => svc.allMeasuredPower({ hosts: [] }),
    analysisServers: async () => ana.analysisServersWithRemote(),
    fanFaults: async () => (pf.partFaultDbExists() ? (await pf.openFaults({ scope: 'idrac' })).filter((f) => f.kind === 'fan') : null),
    powerDb: () => idb.getDb(),
    inventoryOf: (a, regId) => {
      const x = a?.remote ? (a.inv || null) : inv.getInventory(String(a?.id || regId || ''));
      if (!x) return null;
      if (!a?.remote && !(Number(x.collectedAt) && now - Number(x.collectedAt) <= INV_FRESH_MS)) return null;   // 낡은 인벤토리는 ‘지금 사실’ 이 아니다(hwFacts 와 같은 판단)
      return x;
    },
    sensorLatest: (id) => ss.getSensorSeries(id, { minutes: 0 }).latest || null,
    temps: { classify: rt.classifySensor, maxAgeOf: (latest, remote) => rt.sampleMaxAgeMs(rt.DEFAULT_MAX_AGE_MS, latest, { remote, localCycle: ss.sensorPollCycle(now) }) },
  };
}
