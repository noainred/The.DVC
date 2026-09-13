/**
 * perfClientLogic.js — 브라우저 성능 보고의 **순수 로직**(v2.498): 경로 정규화·장기 로딩 문구·
 * 쿨다운/상한 판정. 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는 여기서 회귀로 고정한다.
 *
 * 배경(사용자 신고): "'불러오는 중…' 이 3분 이상 지속될 때가 있다." 웹 GET 은 20초에 스스로 끊고
 * 최대 3회 재시도(≈61초)라, 서버 지연만으로 3분은 구조적으로 나오지 않는다 — 상당수는 **뷰가
 * 스피너에 갇힌 경우**다. 그래서 (a) 화면에 '몇 초째·무엇을 기다리는지' 를 정직하게 보이고,
 * (b) 기다리는 요청이 하나도 없으면 그 사실을 자백하고, (c) 서버에 1회 보고해 근거를 남긴다.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;

/** 경로 정규화 — 쿼리 제거(검색어·id 유출 방지) + 식별자 세그먼트 마스킹. 서버 집계 키와 같은 규칙. */
export function normPath(p) {
  const raw = String(p || '').split('?')[0].split('#')[0];
  const parts = raw.split('/').map((seg) => {
    if (!seg) return seg;
    if (NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg) || seg.includes(':')) return ':id';
    return seg;
  });
  return (parts.join('/') || '/').slice(0, 200);
}

/** 화면 해시 정규화(`#/insights/finops?x=1` → `#/insights/finops`). */
export const normView = (hash) => String(hash || '').split('?')[0].slice(0, 120);

/**
 * '불러오는 중' 표시 문구. 15초까지는 기존 문구 그대로(짧은 대기에 잡음을 더하지 않는다),
 * 그 뒤에는 경과 초, 30초 뒤에는 무엇을 기다리는지, 기다리는 요청이 없으면 그 사실을 밝힌다.
 * @returns {{text: string, detail: string, suggestReload: boolean}}
 */
export function loadingText({ elapsedSec = 0, inflight = [], hintSec = 15, detailSec = 30 } = {}) {
  const s = Math.max(0, Math.round(elapsedSec));
  if (s < hintSec) return { text: '불러오는 중…', detail: '', suggestReload: false };
  const text = `불러오는 중… (${s}초째)`;
  if (s < detailSec) return { text, detail: '', suggestReload: false };
  const rows = (inflight || []).filter((x) => x && x.path);
  if (!rows.length) {
    return {
      text,
      detail: '대기 중인 요청이 없습니다 — 서버 응답은 끝났는데 화면이 갱신되지 않은 상태일 수 있습니다.',
      suggestReload: true,
    };
  }
  const top = [...rows].sort((a, b) => (b.ms || 0) - (a.ms || 0))[0];
  const more = rows.length > 1 ? ` 외 ${rows.length - 1}건` : '';
  return { text, detail: `요청 ${normPath(top.path)} 응답 대기 ${Math.round((top.ms || 0) / 1000)}초${more}`, suggestReload: false };
}

/**
 * 쿨다운·상한 판정(폭주 방지). state 는 { keys: Map<key, ts>, hourBucket, hourCount, dropped }.
 * 반환 true 면 보고해도 된다. 부수효과는 state 갱신뿐(순수하게 테스트 가능).
 */
export function allowReport(state, key, now, { cooldownMs = 300_000, maxPerHour = 50, maxKeys = 300 } = {}) {
  const s = state;
  const bucket = Math.floor(now / 3_600_000);
  if (s.hourBucket !== bucket) { s.hourBucket = bucket; s.hourCount = 0; }
  if (s.hourCount >= maxPerHour) { s.dropped = (s.dropped || 0) + 1; return false; }
  const last = s.keys.get(key) || 0;
  if (now - last < cooldownMs) return false;
  if (s.keys.size >= maxKeys) { const first = s.keys.keys().next().value; if (first !== undefined) s.keys.delete(first); }
  s.keys.set(key, now);
  s.hourCount += 1;
  return true;
}

/** 새 보고 상태. */
export const newReportState = () => ({ keys: new Map(), hourBucket: 0, hourCount: 0, dropped: 0 });

/** 보고 본문 — 사용자·IP 는 넣지 않는다(서버가 채운다). 경로는 정규화, 목록은 10건까지. */
export function stallPayload({ view = '', path = '', ms = 0, inflight = [] } = {}) {
  return {
    view: normView(view),
    path: normPath(path),
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    inflight: (inflight || []).filter((x) => x && x.path).slice(0, 10)
      .map((x) => ({ path: normPath(x.path), ms: Math.max(0, Math.round(Number(x.ms) || 0)) })),
  };
}
