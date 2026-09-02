/**
 * storageIntervals.js — 스토리지 수집 주기 설정 화면의 순수 로직(v2.409).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더는 검증할 수 없다. 그래서 '상속 계산'과
 * '반영 지연 계산'처럼 **틀리면 사용자가 잘못된 기대를 갖게 되는 규칙**을 여기 순수 함수로
 * 두고 회귀로 고정한다(storageColumns.js·accessDeniedText.js 와 같은 패턴).
 */

/** 선택지(ms). '미지정'은 빈 문자열 — 상속(엣지 로컬 / 전역)을 뜻한다. */
export const PRESETS = [
  { ms: 60_000, label: '1분' },
  { ms: 120_000, label: '2분' },
  { ms: 180_000, label: '3분' },
  { ms: 300_000, label: '5분' },
  { ms: 600_000, label: '10분' },
  { ms: 900_000, label: '15분' },
  { ms: 1_800_000, label: '30분' },
  { ms: 3_600_000, label: '1시간' },
  { ms: 7_200_000, label: '2시간' },
  { ms: 21_600_000, label: '6시간' },
  { ms: 43_200_000, label: '12시간' },
  { ms: 86_400_000, label: '24시간' },
];

/** 그 항목의 하한(spec.min) 미만 선택지는 고를 수 없다 — 서버가 어차피 올림하므로 미리 숨긴다. */
export const presetsFor = (minMs) => PRESETS.filter((p) => p.ms >= (Number(minMs) || 0));

/** ms → 사람이 읽는 짧은 표기. 프리셋에 없는 값(직접 편집한 파일 등)도 근사 없이 정확히 표시. */
export function msLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '미지정';
  const hit = PRESETS.find((p) => p.ms === n);
  if (hit) return hit.label;
  if (n % 3_600_000 === 0) return `${n / 3_600_000}시간`;
  if (n % 60_000 === 0) return `${n / 60_000}분`;
  return `${Math.round(n / 1000)}초`;
}

/**
 * 어느 대상에 실제로 배포될 값 = 전역 위에 대상별 값을 덮은 것.
 * ⚠ 두 곳 모두 미지정인 키는 **결과에 넣지 않는다** — 서버가 지정한 키만 내려보내고,
 * 안 내려간 키는 엣지가 자기 portal.env 값을 유지한다는 계약이라 여기서도 같아야 한다.
 */
export function effectiveFor(global = {}, perTarget = {}) {
  const out = {};
  for (const [k, v] of Object.entries(global || {})) if (v) out[k] = v;
  for (const [k, v] of Object.entries(perTarget || {})) if (v) out[k] = v;
  return out;
}

/** 값의 출처(상속 표시용) — 대상별 지정 > 전역 > 미지정. */
export function sourceOf(key, global = {}, perTarget = {}) {
  if (perTarget?.[key]) return 'target';
  if (global?.[key]) return 'global';
  return 'inherit';
}

/**
 * 중앙 화면에 결과가 보이기까지의 **최악 지연**.
 *   엣지: 장비 수집 주기 + 중앙 push 주기 (수집 직후에 push 가 돌면 거의 0, 직전이면 합만큼)
 *   중앙 직접 수집: push 가 없으므로 수집 주기만.
 * 지정되지 않은 항목은 엣지의 로컬 값을 알 수 없으므로 fallback(서버가 준 기본값)을 쓰고,
 * 그 사실을 estimated=true 로 알린다 — 확정값처럼 보이면 안 된다(정직 표기).
 */
export function worstCaseLagMs(eff = {}, fallback = {}, { isEdge = true } = {}) {
  const poll = Number(eff.pollMs || fallback.pollMs) || 0;
  const push = isEdge ? (Number(eff.pushMs || fallback.pushMs) || 0) : 0;
  const estimated = !eff.pollMs || (isEdge && !eff.pushMs);
  return { ms: poll + push, estimated };
}

/** '최대 12분' 같은 문구(추정이면 '약'을 붙인다). */
export function lagText(eff, fallback, opts) {
  const { ms, estimated } = worstCaseLagMs(eff, fallback, opts);
  if (!ms) return '—';
  const m = Math.round(ms / 60_000);
  const body = m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? `${m % 60}분` : ''}`.trim() : `${m}분`;
  return `${estimated ? '약 ' : ''}최대 ${body}`;
}

/** 폼 상태(문자열 select 값) → 서버 body. 빈 문자열은 '미지정'이라 키를 뺀다. */
export function toBody(globalForm = {}, agentForms = {}) {
  const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)]));
  return {
    global: pick(globalForm),
    agents: Object.fromEntries(Object.entries(agentForms).map(([a, v]) => [a, pick(v)])),
  };
}
