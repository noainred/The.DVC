// v2.759 Veeam 스냅샷 전용 DB 준비(기동 · 화면 요청) — 엣지 요약 복원 + 백필 시작. 판정·저장은 snapDb.js · snapEvents.js.
import { store } from '../store.js';
import { getLogsDb } from '../logs/db.js';
import { eventNotCollectedMap } from '../logs/coverage.js';
import { backfillSnap } from './snapDb.js';
import { restoreEdgeSnap } from './snapEvents.js';

/** 이 포탈이 직접 이벤트를 모으는 vCenter 전부의 백필 시작(진행 중이면 그것을 쓴다). 기다리지 않는다. */
export async function kickSnapBackfill() {
  try {
    const nc = eventNotCollectedMap();
    const ids = (store.get()?.vcenters || []).map((v) => String(v.id)).filter((id) => !nc.get(id));
    if (ids.length) backfillSnap({ logsDb: await getLogsDb(), vcenterIds: ids }).catch((e) => console.warn(`[veeam-snap] 백필 실패(다음 요청에서 다시): ${String(e?.message || e).slice(0, 200)}`));
  } catch { /* 다음 요청에서 다시 */ }
}

/** 기동: 엣지 요약 복원은 바로, 백필은 첫 인벤토리 수집을 기다려(골격 스냅샷이면 vCenter 목록만 있다 — 그래도 id 는 있다) 잠시 뒤. */
export function startVeeamSnapWarmup({ delayMs = 45_000 } = {}) {
  restoreEdgeSnap().then((n) => { if (n) console.log(`[veeam-snap] 엣지 요약 ${n}건을 전용 DB 에서 복원했습니다`); }).catch(() => {});
  const t = setTimeout(() => { kickSnapBackfill(); }, delayMs);
  t.unref?.();
}
