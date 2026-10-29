/**
 * isidu/demoMask.js — '아이실론 디렉터리 사용량' 응답의 **데모 계정 판본**(v2.769 점검 R4-D4-05).
 *
 * mock 모드 데모 계정(요청 문맥 role admin + demoGuest)은 adminOnly·fullScopeOnly 를 통과해 이 도구를 본다(v2.716 '조회 전부').
 * 그런데 mock 모드에도 사람이 등록한 대상은 실제로 수집되고(설계), 메인 목록·보고서·사용자·추이·CSV 는 그 대상의 아이실론 관리 주소·
 * SSH 계정명·경로·담당 엣지와 사용자 폴더 이름(= 사용자명)을 싣는다. v2.743 AUTHZ-01 규약(데모 계정 = operator 와 같은 가림 판본,
 * 판정은 `isAdminDetailUser` 하나)이 이 도구에는 키 파일 경로에만 적용돼 있었다(3회차 C2-2 comm-map 과 같은 유형).
 * 이 도구는 adminOnly 라 operator 판본이 따로 없다 — 그래서 데모 계정에는 **데모(mock-) 대상만** 싣는다(commmap/demoMask.js 와 같은 판단:
 * 화면은 그대로 열고 데모 항목만 남긴다). 사람이 등록한 대상의 단건 조회(보고서·사용자·추이·CSV)는 '설정에 없는 대상' 404 다.
 *
 * 순수 모듈 — 데모 엣지 판정은 호출부가 넘긴다(mock/demo/edge.js 를 여기서 import 하지 않는다: 의존 방향).
 */

/** 데모 대상 id 인가(mock/demo 시드가 만드는 'mock-' 접두 — 폴러·메일의 데모 판정과 같은 글자). */
export function isDemoTargetId(id) { return /^mock-/i.test(String(id ?? '').trim()); }

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * 메인 목록 응답(GET /tools/isilon-dirusage) 가림.
 * @param {object} body 라우트가 만든 응답
 * @param {{ isDemoAgent?: (name:string)=>boolean }} preds
 * @returns {object} 새 객체(원본을 바꾸지 않는다) — 가린 수는 `demoMasked`
 */
export function maskIsiduMainForDemo(body = {}, { isDemoAgent = () => false } = {}) {
  const out = { ...body };
  const masked = {};
  const keep = (key, list, pred) => {
    const src = arr(list);
    const kept = src.filter((x) => { try { return !!pred(x); } catch { return false; } });
    if (src.length !== kept.length) masked[key] = (masked[key] || 0) + (src.length - kept.length);
    return kept;
  };
  const byTarget = (x) => isDemoTargetId(x?.targetId ?? x?.id);
  if ('targets' in body) out.targets = keep('targets', body.targets, (x) => isDemoTargetId(x?.id));
  // 엣지 공개키·버전·상태 — 실제 엣지 이름이 실린다. 데모 엣지만.
  if ('edges' in body) out.edges = keep('edges', body.edges, (e) => isDemoAgent(String(e?.agent ?? '').trim()));
  if ('drops' in body) out.drops = keep('drops', body.drops, byTarget);
  if (body.poller && typeof body.poller === 'object') {
    const p = { ...body.poller };
    for (const k of ['running', 'queued', 'interrupted', 'resumes']) if (k in p) p[k] = keep(`poller.${k}`, p[k], byTarget);
    // 폴러 기록 줄(recent)·마지막 오류는 자유 문구라 대상 이름·주소가 섞인다 — 데모 판본에는 싣지 않는다(개수만).
    if (arr(p.recent).length) masked['poller.recent'] = arr(p.recent).length;
    p.recent = [];
    if (p.lastError) { masked['poller.lastError'] = 1; p.lastError = null; }
    out.poller = p;
  }
  out.demoMasked = masked;
  return out;
}
