/**
 * vcenter/collectTarget.js — '이 포탈이 직접 로그인해 수집하는 vCenter 인가' 판정(순수 · import 0) — v2.732(점검 2회차 B4-01).
 *
 * 같은 조건(enabled===false · maintenance · collectMode==='site')을 store.js 주 폴러 · vmseries · curuser 가 각자 들고 있었고
 * vCenter 이벤트 로그 폴러(logs/poller.js)·게스트 디스크(점검중)·OS 판별 스캐너는 빠져 있었다(형제 비대칭). 결과로 관리자가 끈 ·
 * 점검중으로 둔 · 엣지에 위임한 vCenter 에 중앙이 주기마다 로그인했다(재현: 3주기 × 계정 3개 = 로그인 9회). 주 폴러는 그 셋을
 * 수집하지 않으므로 인증 정지 기록도 생기지 않아 비밀번호가 틀린 구간에 같은 계정 실패 로그인이 쌓였다.
 *
 * 규칙(판정 순서가 계약 — 이유는 사람이 읽는 순서다):
 *  · `enabled === false` → 'disabled'(관리자가 끈 vCenter)
 *  · `maintenance` 참 → 'maintenance'(점검중 — 수집 일시 중단)
 *  · `collectMode === 'site'` → 'site'(엣지 위임 — 중앙은 직접 폴링하지 않는다. 데이터는 엣지가 push 한다)
 *  · 그 밖 → null(직접 수집 대상)
 * 수동 실행('지금 수집')도 이 셋은 건너뛴다 — store.js 의 collectAll 도 같은 순서로 먼저 거른다(인증 정지와 다르다).
 * ⚠ 이 모듈은 아무것도 import 하지 않는다 — store.js·poller 들이 함께 쓰므로 여기서 다른 모듈을 끌어오면 순환이 생긴다.
 */

/** 직접 수집하지 않는 이유 코드 — 화면·상태 문구가 이 집합과 1:1 이다. */
export const DIRECT_SKIP_REASONS = Object.freeze(['disabled', 'maintenance', 'site']);

/**
 * @param {object} vc 등록부 vCenter 항목(loadVcenterConfig().vcenters 의 원소)
 * @returns {null|'disabled'|'maintenance'|'site'|'invalid'} 직접 수집 대상이면 null
 */
export function directCollectSkipReason(vc) {
  if (!vc || typeof vc !== 'object') return 'invalid';
  if (vc.enabled === false) return 'disabled';
  if (vc.maintenance) return 'maintenance';
  if (vc.collectMode === 'site') return 'site';
  return null;
}

/** 직접 수집 대상인가(로그인해도 되는가). */
export function isDirectCollectTarget(vc) { return directCollectSkipReason(vc) === null; }

/**
 * 목록을 직접 수집 대상과 건너뛴 항목으로 나눈다. 건너뛴 것은 조용히 빼지 않고 `{vcenterId, why}` 로 돌려준다(상태에 싣는다).
 * @returns {{ targets: object[], skipped: {vcenterId: string, why: string}[] }}
 */
export function splitDirectCollectTargets(list) {
  const targets = [];
  const skipped = [];
  for (const vc of Array.isArray(list) ? list : []) {
    const why = directCollectSkipReason(vc);
    if (why) skipped.push({ vcenterId: String(vc?.id ?? ''), why });
    else targets.push(vc);
  }
  return { targets, skipped };
}

/** 건너뛴 항목을 이유별 개수로(`{disabled, maintenance, site}` — 0 인 이유는 싣지 않는다). */
export function skippedCountsOf(skipped) {
  const out = {};
  for (const s of Array.isArray(skipped) ? skipped : []) { const k = String(s?.why || ''); if (k) out[k] = (out[k] || 0) + 1; }
  return out;
}
