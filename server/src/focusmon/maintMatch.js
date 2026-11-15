/**
 * focusmon/maintMatch.js — 집중 모니터링 서버가 **정비 창 아래인가**(v3.16.0 ⑯ 반증 H2 — 알림 억제).
 *
 *  · 집중 모니터링 등록부의 법인은 **DataCenter id**(audit/corp.js — 등록 칸이 비면 담당 엣지의 법인)이고, 정비 창의 법인은 **vCenter id**다
 *    (bmusage/maint — 서버 창 = (vCenter id, 키) 쌍). 같은 값으로 비교하면 늘 어긋나 억제가 한 번도 먹지 않았다(재현).
 *  · 그래서 법인(DataCenter) → 그 법인의 vCenter 들(datacenters.json 할당)로 풀어, 각 vCenter 와 서버 주소(IP) 쌍으로 판정 코어(stateFor)에 묻는다.
 *  · 한 법인에 서비스(vCenter)가 여럿이면(법인 1 : 서비스 N) 법인 · 태그 단위 창은 **어느 서비스의 서버인지 몰라** 억제하지 않는다 —
 *    주소를 직접 적은 서버 창만 억제한다(다른 서비스의 정비로 이 서버 알림을 삼키지 않게 — 알림이 나가는 쪽). vCenter 가 하나면 모든 창.
 *  · 판정기 · 할당을 못 읽으면 억제하지 않는다(알림이 나가는 쪽).
 */
/**
 * @param {{stateFor:(target, at)=>object, windows?:Array}} J  maint 판정기(runtime.maintJudge 결과)
 * @param {{host:string}} t  집중 모니터링 대상
 * @param {string|null} corpId  그 대상의 DataCenter id(없으면 null — 억제하지 않는다)
 * @param {Record<string,string>} assign  vCenter id → DataCenter id
 * @returns {null|{scopes:{alerts:true}, vcenterId:string, windows:Array}}
 */
export function maintStateForTarget(J, t, corpId, assign, now = Date.now()) {
  if (!J || typeof J.stateFor !== 'function' || !t?.host || !corpId) return null;
  const vcs = Object.entries(assign || {}).filter(([, dc]) => String(dc) === String(corpId)).map(([vc]) => vc);
  if (!vcs.length) return null;
  const kindOf = new Map((Array.isArray(J.windows) ? J.windows : []).map((w) => [String(w?.id), w?.target?.kind || null]));
  for (const vc of vcs) {
    let st = null;
    try { st = J.stateFor({ vcenterId: vc, key: t.host }, now); } catch { st = null; }
    if (!st?.scopes?.alerts) continue;
    const ws = (st.windows || []).filter((w) => Array.isArray(w.scopes) && w.scopes.includes('alerts'));
    if (vcs.length === 1 || ws.some((w) => kindOf.get(String(w.id)) === 'server')) return { scopes: { alerts: true }, vcenterId: vc, windows: ws };
  }
  return null;
}
