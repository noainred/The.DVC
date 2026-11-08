/**
 * bmusage/powerSources.js — 전력 · 온도 집계의 **원천 묶음 하나**(8b 라우트 depsOf.sources 를 옮겼다 — 다음 점검 ②: 알림 규칙 판정이 같은 원천을 쓴다).
 *
 * 화면(routes/api/bmPower.js)과 알림 판정(bmusage/powerAlerts.js — 폴러 · 시험 실행)이 이 함수 하나를 쓴다(두 벌 금지 · 의존 방향: 라우트 → 도메인).
 *   · localOnly=true(알림 판정): 이 노드의 iDRAC 폴러가 읽은 것만 — 측정 source 'idrac' · 'ome'(엣지 사본 'remote' · vCenter 추정 제외) · 서버 분석 항목은 로컬 등록부만(remote 제외).
 *     판정 주체 = 전력 원천이 있는 노드(엣지 위임 서버는 그 엣지가 판정해 봉투 발송 기록으로 올린다 — 중앙이 사본으로 한 번 더 판정하지 않는다).
 *   · localOnly=false(화면): 엣지 사본까지(중앙이 보는 함대 전체).
 * 인벤토리는 INV_FRESH_MS(2시간) 안의 것만 ‘지금 사실’ 이다(hwFacts 와 같은 판단 — 낡은 상한을 걸림 판정에 쓰지 않는다).
 */
export const INV_FRESH_MS = 2 * 3_600_000;

export async function powerSources({ now = Date.now(), localOnly = false } = {}) {
  const [svc, ana, inv, ss, rt, pf, idb] = await Promise.all([import('../idrac/service.js'), import('../insights/analysisServers.js'), import('../idrac/invCache.js'),
    import('../idrac/sensorStore.js'), import('../idrac/roomTemp.js'), import('../partfault/db.js'), import('../idrac/db.js')]);
  return {
    measured: async () => {
      const all = await svc.allMeasuredPower({ hosts: [] });
      return localOnly ? all.filter((m) => m && (m.source === 'idrac' || m.source === 'ome')) : all;
    },
    analysisServers: async () => {
      const all = ana.analysisServersWithRemote();
      return localOnly ? all.filter((a) => a && !a.remote) : all;
    },
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
