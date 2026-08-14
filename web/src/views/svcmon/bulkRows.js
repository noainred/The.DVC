/**
 * bulkRows.js — 대량 자동등록(BulkTab)의 순수 로직(v2.295, 3차 모듈화 감사 확정 #3).
 * BulkTab.jsx 25~55·126~155행에서 추출(React/DOM 무의존) — vitest(bulkRows.test.js)로 고정한다.
 *
 * 왜 추출·고정하는가: ipMsg 는 서버 검증(nonCanonicalIp·SAFE_HOST)과 '같은 취지'의 클라이언트
 * 복제본이라, 서버와 어긋나면 ① 클라 통과 후 서버 거부(사용자 혼란) 또는 ② 클라 과잉 거부
 * (등록 불가)가 생기는데 이 드리프트를 잡을 테스트가 없었다. 이름 중복 판정·엣지 warn/error
 * 2단계·IPv4 선행 0 거부 같은 미묘한 규칙도 함께 고정한다(vcdSearch.js v2.293 과 같은 패턴).
 *
 * ⚠ 유지 규칙(감사 검증자 지적 — 어기면 테스트가 막는다):
 *  - IPv6 검사(ipMsg)는 실제 IPv6 검증이 아니라 **문자셋 검사**(':::::' 도 통과)다 — 의도적으로
 *    느슨하게 유지(서버가 최종 검증). '정리'하며 조이지 말 것.
 *  - '이름 중복' 메시지 prefix 는 validateRows 의 dupNames 집계(startsWith)와 암묵 결합 —
 *    문구를 바꾸면 집계가 0 이 된다(현재 동작 그대로 고정).
 *  - 엣지 후보가 비어 있으면(edgeSet empty) 비어있지 않은 edge 입력은 전부 'error' 다 —
 *    UI 문구('엣지 없으면 검증 건너뜀')와 다르지만 이것이 현재 동작(안전한 쪽)이다.
 */

// 표로 그리는 최대 줄 수 — 이보다 많으면 자유형식/CSV 를 안내한다(수천 input 은 무겁다).
export const TABLE_CAP = 500;
export const MAX_COUNT = 2000;   // 서버 maxBulkRows 와 정렬.

/** IPv4/IPv6/호스트명 형식 검사 — 서버(nonCanonicalIp·SAFE_HOST)와 같은 취지. 빈값/오류면 메시지, OK 면 ''. */
export function ipMsg(v) {
  const s = String(v || '').trim();
  if (!s) return 'IP를 입력하세요';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {           // IPv4 모양
    const parts = s.split('.');
    if (parts.some((p) => p.length > 1 && p[0] === '0')) return 'IPv4 형식 오류(선행 0)';
    if (parts.some((p) => Number(p) > 255)) return 'IPv4 형식 오류(0~255)';
    return '';
  }
  if (s.includes(':')) return /^[0-9a-fA-F:]+$/.test(s) ? '' : 'IPv6 형식 오류';
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) return '호스트/IP 형식 오류';   // 그 외는 호스트명 허용(서버 host 필드)
  return '';
}

export const EMPTY_ROW = () => ({ edge: '', hostname: '', ip: '' });

/** 자유형식 텍스트 → 줄 배열. 한 줄에 "엣지, 호스트네임, IP"(쉼표/공백/탭 구분). '#' 은 주석. */
export function parseFree(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    out.push({ edge: parts[0] || '', hostname: parts[1] || '', ip: parts[2] || '' });
  }
  return out;
}

/**
 * 검증 순수 코어 — 엣지 존재(candidates) + IP 형식 + 호스트명 + 이름 중복.
 * BulkTab.validate 의 setState 를 제거한 것 외에 로직 무변(순수 이동, v2.295).
 * @param {Array<{edge,hostname,ip}>} inputRows 트림 전 원시 행(effectiveRows() 결과)
 * @param {Set<string>} edgeSet 배정 후보 엣지 이름 집합
 * @returns {{ detail, okCount, total, edgeBad, edgeMissing, ipBad, dupNames }}
 *   ⚠ 반환 shape 는 렌더가 직접 참조한다(detail[i].msgs/ok/edgeLevel · 배지 카운트) — 키를
 *   바꾸면 화면이 조용히 비는 드리프트가 난다(과거 상태 주석이 실제 키와 어긋났던 전례 있음).
 */
export function validateRows(inputRows, edgeSet) {
  const rs = (inputRows || []).map((r) => ({ edge: (r.edge || '').trim(), hostname: (r.hostname || '').trim(), ip: (r.ip || '').trim() }));
  const seen = new Map();     // hostname(lower) → 첫 등장 행
  const detail = rs.map((r, i) => {
    const msgs = [];
    let edgeLevel = 'ok';
    if (!r.hostname) msgs.push('호스트네임 없음');
    if (!r.edge) { edgeLevel = 'warn'; msgs.push('엣지 미선택(경로 배정 따름)'); }
    else if (!edgeSet.has(r.edge)) { edgeLevel = 'error'; msgs.push(`없는 엣지: ${r.edge}`); }
    const ie = ipMsg(r.ip); if (ie) msgs.push(ie);
    const key = r.hostname.toLowerCase();
    if (r.hostname) { if (seen.has(key)) msgs.push(`이름 중복(${seen.get(key) + 1}행과 같음)`); else seen.set(key, i); }
    const hardBad = !r.hostname || (edgeLevel === 'error') || !!ie || (seen.get(key) !== i && !!r.hostname);
    return { i, ...r, msgs, edgeLevel, ok: !hardBad };
  });
  const edgeBad = detail.filter((d) => d.edgeLevel === 'error').length;
  const edgeMissing = detail.filter((d) => d.edgeLevel === 'warn').length;
  const ipBad = detail.filter((d) => ipMsg(d.ip)).length;
  const dupNames = detail.filter((d) => d.msgs.some((m) => m.startsWith('이름 중복'))).length;
  const okCount = detail.filter((d) => d.ok).length;
  return { detail, okCount, total: detail.length, edgeBad, edgeMissing, ipBad, dupNames };
}

/**
 * JSON import payload — 줄 → {kind, path, name:hostname, host:ip, enabled, agent}.
 * 빈 줄(hostname·ip 둘 다 없음)은 제외, edge 없으면 agent 키 자체를 생략(서버 스키마와 정렬).
 */
export function buildTargetRows(inputRows, { kind, path, enabled }) {
  return (inputRows || [])
    .map((r) => ({ edge: (r.edge || '').trim(), hostname: (r.hostname || '').trim(), ip: (r.ip || '').trim() }))
    .filter((r) => r.hostname || r.ip)
    .map((r) => ({ kind, path, name: r.hostname, host: r.ip, enabled, ...(r.edge ? { agent: r.edge } : {}) }));
}
