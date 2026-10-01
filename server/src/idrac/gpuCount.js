/**
 * iDRAC 인벤토리 GPU 카드 수량 — Overview 'GPU 카드' 카드와 서버 분석 › GPU 찾기가 같이 쓰는 한 벌(v2.683).
 *
 * 사용자 신고(v2.682): Overview 455장 vs GPU 찾기 463장. 두 화면이 각자 셌고 기준이 넷 달랐다 —
 *   ① GPU 찾기만 'GPU 물리 서버(SSH nvidia-smi 등록)' 의 GPU 를 더했다(같은 박스가 iDRAC 에도 있으면 두 번 센다 —
 *      OS IP 와 BMC IP 가 달라 가릴 수 없다) ② Overview 는 24시간 넘은 인벤토리를 뺐다 ③ Overview 만 비활성 서버를 뺐다
 *   ④ Overview 만 모델명이 빈 GPU 를 뺐다.
 * 사용자 결정: "iDRAC 에 등록된 카드만 GPU 카드 수량으로 카운트". 그래서 합계(`gpus`) =
 *   활성 · OME 콘솔이 아닌 서버의 iDRAC 인벤토리에 있는 GPU 항목 전부(오래된 인벤토리·모델명 없음 포함).
 *   오래된 인벤토리·모델 미상은 합계에 들어가되 개수를 따로 밝힌다(`gpusStale`·`gpusUnnamed`).
 *   SSH 물리 서버의 GPU 는 이 함수가 세지 않는다 — 호출부가 '합계에 넣지 않은 별도 수' 로 보인다.
 * 인벤토리가 아예 없는 서버의 GPU 는 알 수 없다 — `invMissing` 이 0 이 아니면 합계는 최소값이다.
 */
import { numOrNull } from '../util/numOrNull.js';

/** 인벤토리가 이보다 오래되면 '지금 수집된' 값이 아니다(인벤토리 주기 30분 — 넉넉히 하루). 합계에는 넣고 따로 센다. */
export const INVENTORY_STALE_MS = 24 * 3_600_000;

const tsMs = (v) => {
  const n = numOrNull(v);
  if (n != null) return n;
  if (typeof v === 'string' && v.trim()) { const p = Date.parse(v); return Number.isFinite(p) ? p : null; }
  return null;
};

/** 집계 대상 서버인가 — 비활성·OME 콘솔(관리 콘솔 등록이라 물리 서버가 아니다)은 세지 않는다. */
export const gpuCountable = (s) => !!s && s.enabled !== false && s.type !== 'ome';

/** GPU 항목의 모델명(없으면 ''). */
export const gpuModelOf = (g) => String(g?.model || g?.name || '').trim();

/**
 * @param {object[]} servers  서버 분석 등록(범위 적용 뒤)
 * @param {(s:object)=>object|null} invOf
 * @param {number} [now]
 * @param {(s:object, inv:object, gpus:object[], stale:boolean)=>void} [onServer]  인벤토리가 있는 대상 서버마다(목록을 같은 판정으로 만들 때)
 */
export function idracGpuCounts(servers, invOf, now = Date.now(), onServer = null) {
  let count = 0; let disabled = 0; let ome = 0; let invRead = 0; let invStale = 0; let invMissing = 0;
  let gpus = 0; let gpusStale = 0; let gpusUnnamed = 0; let serversWithGpu = 0;
  for (const s of servers || []) {
    if (!s) continue;
    if (s.type === 'ome') { ome += 1; continue; }
    if (s.enabled === false) { disabled += 1; continue; }
    count += 1;
    const inv = invOf(s);
    if (!inv) { invMissing += 1; continue; }
    const at = tsMs(inv.collectedAt);
    const stale = at != null && now - at > INVENTORY_STALE_MS;
    if (stale) invStale += 1; else invRead += 1;
    const list = (Array.isArray(inv.gpus) ? inv.gpus : []).filter((g) => g && typeof g === 'object');
    gpus += list.length;
    if (stale) gpusStale += list.length;
    gpusUnnamed += list.filter((g) => !gpuModelOf(g)).length;
    if (list.length) serversWithGpu += 1;
    if (onServer) onServer(s, inv, list, stale);
  }
  return { count, disabled, ome, invRead, invStale, invMissing, gpus, gpusStale, gpusUnnamed, serversWithGpu };
}
