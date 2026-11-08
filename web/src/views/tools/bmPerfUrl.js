/**
 * 리눅스 성능 — **서버 = (법인, 키) 쌍**(다음 점검 ① · 2026-11-08). 서버 하나를 여는 요청(상세 · 탭 · 팝업 · 비교 · 쓰기)은 법인(vcenterId)을 함께 싣는다.
 *   같은 키(IP 로 등록한 iDRAC 은 키 = IP)가 두 법인에 있을 수 있다 — 키만 보내면 서버가 400 ambiguous-key 로 답하고(후보 법인 — 범위 안만)
 *   화면은 법인 고르기를 보인다. 판정(누가 그 서버인가)은 서버 resolvePerfTarget 하나 — 이 파일은 요청 모양과 응답 읽기만.
 */

/** `/tools/bm-usage/perf/<키><suffix>?<query>&vcenterId=<법인>` — 법인이 비면 예전처럼 키만. query 는 'a=1&b=2' 글자(앞 ? · & 는 떼어 낸다). */
export function perfPath(key, vc = '', suffix = '', query = '') {
  const base = `/tools/bm-usage/perf/${encodeURIComponent(String(key ?? ''))}${suffix || ''}`;
  const q = [String(query || '').replace(/^[?&]+/, ''), vc ? `vcenterId=${encodeURIComponent(String(vc))}` : ''].filter(Boolean).join('&');
  return q ? `${base}?${q}` : base;
}
/** 질의 객체에 법인을 더한다(fetchJson(path, params) 용) — 비면 그대로. */
export const withVc = (params = {}, vc = '') => (vc ? { ...params, vcenterId: String(vc) } : { ...params });
/**
 * 서버 하나의 식별 글자 ‘법인|키’(법인 모름이면 ‘|키’) — 같은 키 · 다른 법인 = 다른 서버. 비교에 담는 목록 · 공유 링크 · 비교 응답의 열 cid 가 같은 꼴이다.
 *   법인 id 에는 ‘|’ 가 없다(서버 VC_RE) — 첫 ‘|’ 에서 가른다. ‘|’ 가 없는 글자(예전 판이 저장한 키만)는 법인 모름으로 읽는다.
 */
export const refOf = (key, vc = '') => `${String(vc || '')}|${String(key ?? '')}`;
export const pairId = refOf;
export function parseRef(ref) {
  const s = String(ref ?? '');
  const i = s.indexOf('|');
  return i < 0 ? { vc: '', key: s } : { vc: s.slice(0, i), key: s.slice(i + 1) };
}
/** 예전 판 목록(키만)도 쌍 글자로 — 비교 담기 · 공유 링크를 읽을 때. */
export const normRef = (x) => { const p = parseRef(x); return p.key ? refOf(p.key, p.vc) : ''; };
/**
 * 비교 응답의 열 식별을 쌍 글자로(순수) — 서버가 준 cid(요청한 ‘법인|키’)를 key 로, 원래 키는 realKey 로. 표 셀 · 최고 · 스큐 · 판정도 cid 로 온다(서버가 cid 로 표를 만든다).
 *   화면의 나머지(색 · 이름 · 칩 · CSV)는 key 하나로 열을 가리키므로 고칠 곳이 이 함수 하나다.
 */
export function normCompareResp(resp) {
  if (!resp || !Array.isArray(resp.columns)) return resp;
  return { ...resp, columns: resp.columns.map((c) => ({ ...c, key: c.cid || refOf(c.key, c.vcenterId || ''), realKey: c.key })) };
}

/**
 * 응답(또는 fetchJson 이 던진 HttpError)이 ‘같은 키 여러 법인’ 인가 — 그렇다면 후보 법인 목록(범위 안만 — 서버가 거른다), 아니면 null.
 * @returns {null | Array<{vcenterId:string, vcName:string|null}>}
 */
export function ambiguousOf(x) {
  const b = x && typeof x === 'object' ? (x.body && typeof x.body === 'object' ? x.body : x) : null;
  if (!b || b.code !== 'ambiguous-key' || !Array.isArray(b.candidates)) return null;
  // 반증 F4: 귀속 없음 후보는 노드까지 갈라 ‘-@<노드>’ 로 고른다(pick) — 예전에는 빈 법인 후보를 버려 사유 수와 버튼 수가 달랐다.
  return b.candidates.filter((c) => c && typeof c === 'object' && ((typeof c.vcenterId === 'string' && c.vcenterId) || (c.unassigned === true && typeof c.pick === 'string' && c.pick.startsWith('-@'))))
    .map((c) => (c.vcenterId ? { vcenterId: c.vcenterId, vcName: typeof c.vcName === 'string' && c.vcName ? c.vcName : null }
      : { vcenterId: c.pick, vcName: null, unassigned: true, agent: typeof c.agent === 'string' ? c.agent : '', via: c.via === 'edge' ? 'edge' : 'local' }));
}
/** 법인 고르기 버튼 글자 — 법인 이름이 있으면 ‘이름(id)’ · 귀속 없음은 ‘귀속 없음(엣지 X)’ / ‘귀속 없음(이 노드)’ — 이 노드도 agent 이름이 있어 via 로 가른다(2차 재확인 G4). */
export const corpLabel = (c) => (c?.unassigned ? `귀속 없음(${c.via === 'edge' && c.agent ? `엣지 ${c.agent}` : '이 노드'})`
  : (c?.vcName && c.vcName !== c.vcenterId ? `${c.vcName}(${c.vcenterId})` : String(c?.vcenterId || '')));
export const AMBIGUOUS_TEXT = '같은 식별 키의 서버가 **여러 법인**에 있습니다 — 볼 서버의 법인을 고르세요(IP 로 등록한 iDRAC 은 키가 IP 라 법인끼리 겹칠 수 있습니다).';
