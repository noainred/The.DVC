/**
 * views/edgeTokenSyncText.js — 설정 › 수집 서버 › 엣지 토큰 맞추기(v2.825, 사용자 요청 "토큰 맞추는 기능을 설정에 서브메뉴로 별도로 만들어줘").
 *   등록된 수집 서버(엣지)마다 개별 central 토큰 상태를 판정한다(순수 — 화면 EdgeTokenSync.jsx 와 테스트가 같은 함수를 쓴다).
 *
 * 판정 규칙:
 *  - 개별 토큰 목록을 못 읽었으면(조회 실패·파일 손상) **'모름'** — '없음' 으로 칠하지 않는다(없음으로 보이면 자동 적용을 누르게 된다).
 *  - 엣지 이름은 등록부의 이름(없으면 id) — 서버 자동 적용(central/tokenApplyJob.js)이 같은 값으로 찾는다(registry.findCollectorByName,
 *    대소문자·앞뒤 공백 무시). 토큰 대조도 대소문자를 가리지 않는다(tokenApplyJob tokenOf 와 같은 규칙).
 *  - 자동 적용은 **켜진 수집 서버 + 개별 토큰 없음** 일 때만 연다 — 서버도 이미 토큰이 있으면 멈춘다(재발급은 엣지가 쓰는 토큰을 즉시 폐기한다).
 *  - '마지막 사용' 은 중앙이 그 토큰을 본 시각이다. 이름 검사 전에 찍히므로 '받아들였다' 의 증거는 아니다 — 문구도 그렇게만 쓴다.
 */

const norm = (v) => String(v ?? '').trim().toLowerCase();
const posMs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** 행 상태 → 배지 문구·색. */
export const SYNC_STATE = Object.freeze({
  ok: { text: '개별 토큰 사용', tone: 'ok' },
  unused: { text: '발급됨 · 사용 기록 없음', tone: 'warn' },
  shared: { text: '공유 토큰(개별 토큰 없음)', tone: 'bad' },
  off: { text: '수집 꺼짐', tone: 'muted' },
  unknown: { text: '모름', tone: 'muted' },
});

/** 수집 서버 1개의 엣지 이름(등록부 이름 → id). 없으면 ''. */
export function agentNameOf(c) {
  if (!c || typeof c !== 'object') return '';
  return String(c.name ?? '').trim() || String(c.id ?? '').trim();
}

/**
 * 표의 행(순수).
 * @param {object[]} collectors  GET /admin/collectors 의 collectors
 * @param {object[]|null} tokens GET /admin/central/agent-tokens 의 tokens — 못 읽었으면 null
 * @returns {{ agent:string, url:string, enabled:boolean, state:string, createdAt:number|null, lastUsedAt:number|null, canApply:boolean, hint:string }[]}
 */
export function syncRows(collectors, tokens) {
  const list = Array.isArray(collectors) ? collectors : [];
  const known = Array.isArray(tokens);
  return list.filter((c) => c && typeof c === 'object').map((c) => {
    const agent = agentNameOf(c);
    const enabled = c.enabled !== false;
    const tk = known ? tokens.find((t) => t && norm(t.agent) === norm(agent)) || null : null;
    const createdAt = tk ? posMs(tk.createdAt) : null;
    const lastUsedAt = tk ? posMs(tk.lastUsedAt) : null;
    let state; let hint = '';
    if (!known) { state = 'unknown'; hint = '개별 토큰 목록을 읽지 못해 이 엣지의 토큰 상태를 모릅니다.'; }
    else if (tk && lastUsedAt) state = 'ok';
    else if (tk) { state = 'unused'; hint = '발급 뒤 그 토큰으로 들어온 요청이 없습니다 — 엣지가 아직 공유 토큰을 쓰고 있을 수 있습니다. 이전 자동 적용이 중단됐다면 수집 서버(원격) 화면에서 회수한 뒤 다시 자동 적용하세요.'; }
    else if (!enabled) { state = 'off'; hint = '수집이 꺼진 서버는 자동 적용 대상이 아닙니다.'; }
    else state = 'shared';
    return { agent, url: String(c.url ?? ''), enabled, state, createdAt, lastUsedAt, canApply: known && enabled && !tk && !!agent && !!c.url, hint };
  }).sort((a, b) => a.agent.localeCompare(b.agent, 'ko'));
}

/** 요약 한 줄 — '엣지 12대 · 개별 토큰 사용 9 · 사용 기록 없음 1 · 공유 토큰 2'. 0 인 항목은 뺀다. */
export function syncSummary(rows) {
  const r = Array.isArray(rows) ? rows : [];
  if (!r.length) return '등록된 수집 서버(엣지)가 없습니다.';
  const cnt = (s) => r.filter((x) => x.state === s).length;
  const parts = [`엣지 ${r.length}대`];
  for (const [k, label] of [['ok', '개별 토큰 사용'], ['unused', '사용 기록 없음'], ['shared', '공유 토큰'], ['off', '수집 꺼짐'], ['unknown', '모름']]) {
    const n = cnt(k);
    if (n) parts.push(`${label} ${n}`);
  }
  return parts.join(' · ');
}

/** 개별 토큰은 있는데 등록부에 없는 이름(삭제한 수집 서버의 남은 토큰 등). 토큰 목록을 못 읽었으면 []. */
export function orphanTokens(collectors, tokens) {
  if (!Array.isArray(tokens)) return [];
  const names = new Set((Array.isArray(collectors) ? collectors : []).flatMap((c) => [norm(c?.name), norm(c?.id)]).filter(Boolean));
  return tokens.filter((t) => t && t.agent && !names.has(norm(t.agent))).map((t) => String(t.agent));
}
