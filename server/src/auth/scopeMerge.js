import { scopedVcenterIds } from './scope.js';
import { store } from '../store.js';

/**
 * 범위 제한 계정의 설정 저장 병합(v2.605 AUTHZ2605-01).
 *
 * GET 은 범위 밖 vCenter 키를 걸러 준다('범위 밖 id 노출 금지'). 그 값을 화면이 그대로 PUT 으로
 * 돌려보내면, 서버가 그것을 **전체 목록**으로 저장해 다른 법인의 설정이 지워지고(vmperf 는 DB 파일까지)
 * 삭제됐다. 범위 계정의 PUT 은 이 두 함수로 **범위 밖 키를 직전 값 그대로 보존**한다.
 *  · 본문의 범위 밖 키는 무시한다(범위 계정은 그 키를 볼 수도 바꿀 수도 없다) — 개수는 `ignored` 로 밝힌다.
 *  · `allowed === null`(전체 범위)이면 아무것도 하지 않는다(예전 동작 그대로).
 */

/** `{ [vcenterId]: 값 }` 맵 병합 — 범위 밖 키는 before, 범위 안 키는 body. */
export function mergeScopedMap(before, body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!allowed) return { merged: b, ignored: [] };
  const merged = {};
  const ignored = [];
  for (const [id, v] of Object.entries(before && typeof before === 'object' ? before : {})) {
    if (!allowed.has(id)) merged[id] = v;
  }
  for (const [id, v] of Object.entries(b)) {
    if (allowed.has(id)) merged[id] = v; else ignored.push(id);
  }
  return { merged, ignored };
}

/** 맵을 범위로 거른다(GET 과 같은 필터 — PUT 응답에도 쓴다). */
export function filterScopedMap(map, allowed) {
  if (!allowed || !map || typeof map !== 'object') return map;
  return Object.fromEntries(Object.entries(map).filter(([id]) => allowed.has(id)));
}

/**
 * id 배열 병합 — 빈 배열이 '전체 대상' 인 목록(vmperf vcenterIds)용.
 *  · 직전이 빈 배열(전체)이면 직전 집합을 `allIds` 로 펼친다.
 *  · 범위 계정이 보낸 빈 배열은 '범위 안은 그대로' 다 — GET 이 범위 교집합을 주므로, 범위 안 선택이
 *    하나도 없을 때 GET 이 준 [] 를 되돌려 보내는 것이 곧 '변경 없음' 이다(전체로 넓히지 않는다).
 *  · 결과가 직전과 같은 집합이면 직전 배열을 그대로 돌려준다([] 의 뜻을 보존한다).
 */
export function mergeScopedIds(before, body, allowed, allIds) {
  const prev = Array.isArray(before) ? before.map(String) : [];
  const req = Array.isArray(body) ? body.map(String) : [];
  if (!allowed) return { merged: req, ignored: [] };
  const all = [...new Set((allIds || []).map(String))];
  const prevSet = prev.length ? new Set(prev) : new Set(all);
  const ignored = req.filter((id) => !allowed.has(id));
  const inScopeReq = req.filter((id) => allowed.has(id));
  const prevInScope = [...prevSet].filter((id) => allowed.has(id));
  const inScope = inScopeReq.length ? new Set(inScopeReq) : new Set(prevInScope);
  const mergedSet = new Set([...prevSet].filter((id) => !allowed.has(id)));
  for (const id of inScope) mergedSet.add(id);
  const same = mergedSet.size === prevSet.size && [...mergedSet].every((id) => prevSet.has(id));
  // 적용하지 않은 요청은 사유를 싣는다(v2.606 RECENT2606-04) — 화면이 '저장됐다' 고만 말하지 않게.
  const emptyNote = req.length === 0 && prevInScope.length > 0
    ? '범위 안 vCenter 를 모두 빼는 요청은 적용하지 않았습니다 — 빈 목록은 이 계정에서 \'범위 안은 그대로\' 를 뜻합니다.'
    : null;
  if (same) return { merged: prev, ignored, ...(emptyNote && prev.length ? { unapplied: 'empty-in-scope', unappliedReason: emptyNote } : {}) };
  // v2.606 RECENT2606-04: 직전이 '전체 대상([])' 이면 범위 계정은 그것을 **고정 목록으로 바꾸지 않는다**. 펼쳐 저장하면
  //   이후 추가되는 vCenter(범위 밖 법인 포함)가 대상에서 조용히 빠져, 전체 범위 admin 이 모르는 사이 전 법인 설정의
  //   뜻이 바뀐다(AUTHZ2605-01 '범위 밖은 직전 값 그대로' 와 어긋난다). 직전 값을 그대로 두고 사유를 밝힌다.
  if (!prev.length) {
    return {
      merged: prev, ignored, unapplied: 'all-mode',
      unappliedReason: '대상이 \'전체 vCenter\' 로 설정돼 있어 범위 제한 계정은 목록을 바꿀 수 없습니다 — 전체 범위(vCenter 제한 없는) 계정이 바꿔야 합니다. 적용하지 않았습니다.',
    };
  }
  return { merged: [...mergedSet], ignored };
}

/**
 * 전 법인에 접속하는 수동 실행을 범위 제한 계정에 403 으로 거절한다(v2.605 AUTHZ2605-02 — 형제
 * `/tools/bm-usage/collect`(v2.583)와 같은 규약). 실행 결과는 전 법인 합계·오류 원문이라 범위로 나눌 수 없고,
 * 실행 자체가 범위 밖 vCenter·서버에 접속한다. 거절했으면 true.
 */
export function denyScopedRun(req, res, what = '이 실행') {
  if (!scopedVcenterIds(req.user, store.get())) return false;
  res.status(403).json({
    ok: false, error: 'forbidden', requiredOwner: true,
    reason: `${what}은(는) 전 법인에 접속하고 전 법인 결과를 돌려줍니다 — 전체 범위(vCenter 제한 없는) 계정만 실행할 수 있습니다.`,
  });
  return true;
}
