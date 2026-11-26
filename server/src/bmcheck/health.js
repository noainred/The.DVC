/**
 * bmcheck/health.js — 물리서버 **건강 점수**(v3.49 · 설계 docs/design/bm-feature-proposals ⑩). 순수.
 *
 *  · 100 에서 시작해 **확인된 문제만큼 뺀다**(감점 합산 — 시안 그대로. Dell 은 가장 큰 감점 하나만 뺀다고 하나 시안은 합산 · 결정 기록 README §12).
 *  · 입력은 목록이 이미 가진 판정뿐이다(새 수집 없음): 부품 장애 수 · 보증(자산 원장) · 펌웨어 뒤처짐 · BIOS 설정 편차(v3.45 점검 요약 `chk`).
 *  · **못 읽은 항목은 감점하지 않고 따로 센다**(unknown) — 점수 옆에 그 수를 늘 함께 보인다(못 읽어서 100 점처럼 보이지 않게).
 *    견준 항목이 하나도 없으면 점수를 내지 않는다(null — ‘판정 못 함’).
 *  · 감점 크기 · 경계는 이 파일의 상수 하나(HEALTH_RULES · HEALTH_BANDS) — 화면은 응답 값을 쓴다(숫자를 박지 않는다).
 *  · 점수는 운영 판정의 보조다 — 사유가 점수보다 먼저다(화면은 사유를 항상 같이 보인다).
 */
import { numOrNull } from '../util/numOrNull.js';

/** 감점 규칙 — per = 한 건당 · cap = 그 항목 최대 감점. */
export const HEALTH_RULES = Object.freeze({
  fault: Object.freeze({ per: 12, cap: 36 }),             // 열린 부품 장애(건)
  warrantyExpired: Object.freeze({ per: 10, cap: 10 }),   // 보증 끝남
  warrantySoon: Object.freeze({ per: 3, cap: 3 }),        // 보증 곧 끝남
  fwBehind: Object.freeze({ per: 3, cap: 12 }),           // 펌웨어 기준보다 뒤처진 구성요소(개)
  biosDiff: Object.freeze({ per: 2, cap: 8 }),            // 묶음 다수 값과 다른 BIOS 설정(개)
});
/** 경계 — 이 점수 이상이면 그 단계(위에서부터). */
export const HEALTH_BANDS = Object.freeze([
  Object.freeze({ band: 'ok', min: 90 }),
  Object.freeze({ band: 'warn', min: 70 }),
  Object.freeze({ band: 'bad', min: 0 }),
]);
/**
 * 점수를 내는 조건(v3.49 반증 B1 — 못 읽어서 ‘100 · 양호’ 인 서버가 생기지 않게): 견준 항목이 **minJudged 개 이상**이고
 * **볼 항목의 절반 이상**(judged ≥ unknown)이어야 한다. 아니면 점수 없이 ‘판정 못 함’ — 견준 항목의 사실(감점 · 0)은 그대로 보인다.
 */
export const HEALTH_MIN = Object.freeze({ judged: 2, share: 0.5 });
export const bandOf = (score) => {
  const s = numOrNull(score);
  if (s == null) return 'none';
  for (const b of HEALTH_BANDS) if (s >= b.min) return b.band;
  return 'bad';
};
const pts = (rule, n) => Math.min(rule.cap, rule.per * n);
// 갈림(split)은 견준 줄이 하나라도 있을 때만 ‘견준 것’ — 판정 함수는 견준 줄이 0 이어도 열린 줄이 있으면 split 을 낸다(fw.js · bios.js).
// 수가 없거나(구버전 행) 0 이면 모름(못 읽은 값은 0 점 감점의 ‘견줌’ 이 아니다 — v3.49 반증 A1)
const splitJudged = (n) => (numOrNull(n) ?? 0) > 0;

/**
 * @param {{ faults?: number|null, chk?: { w?:string, fw?:string, fwn?:number, fwj?:number, bios?:string, biosn?:number, biosj?:number }|undefined, kind?: string }} row  목록 행(서버 판정)
 * @returns {{ score:number|null, band:'ok'|'warn'|'bad'|'none', items:Array<{k:string, pts:number, n?:number, state?:string}>, unknown:string[], judged:number }}
 *   items = 견준 항목(감점 0 포함 — 사유를 같이 보이게) · unknown = 못 읽었거나 견주지 않은 항목의 키
 */
export function healthOf(row) {
  const r = row && typeof row === 'object' ? row : {};
  const c = r.chk && typeof r.chk === 'object' ? r.chk : {};
  const items = []; const unknown = [];
  // ① 부품 장애 — 못 읽음(null) · 수가 아닌 값은 모름(0 으로 세지 않는다)
  const f = numOrNull(r.faults);
  if (f == null || f < 0) unknown.push('fault'); else items.push({ k: 'fault', n: f, pts: f > 0 ? pts(HEALTH_RULES.fault, f) : 0 });
  // ② 보증 — 원장에 없음(unknown) · 판정 안 함(키 없음)은 모름
  if (c.w === 'expired') items.push({ k: 'warranty', state: 'expired', pts: HEALTH_RULES.warrantyExpired.per });
  else if (c.w === 'soon') items.push({ k: 'warranty', state: 'soon', pts: HEALTH_RULES.warrantySoon.per });
  else if (c.w === 'ok') items.push({ k: 'warranty', state: 'ok', pts: 0 });
  else unknown.push('warranty');
  // ③ 펌웨어 — 뒤처짐만 감점 · 갈림(split)은 견준 줄이 있으면 감점 없이 견준 것으로 · 기준 없음 · 못 읽음 · 받지 못함 · 견준 줄 0 인 갈림은 모름
  if (r.kind !== 'esxi') {
    // 뒤처짐(behind)만 감점 — 순서를 모르는 ‘다름’(differ · fwd)은 감점하지 않는다(확인된 문제가 아니다 · 반증 B8). differ 만 있으면 감점 0 으로 견준 것
    const fwBehind = c.fw === 'behind' ? Math.max(0, (numOrNull(c.fwn) ?? 1) - Math.max(0, numOrNull(c.fwd) ?? 0)) : 0;
    if (c.fw === 'behind' && fwBehind > 0) items.push({ k: 'fw', state: 'behind', n: fwBehind, pts: pts(HEALTH_RULES.fwBehind, fwBehind) });
    else if (c.fw === 'behind') items.push({ k: 'fw', state: 'differ', pts: 0 });
    else if (c.fw === 'ok' || (c.fw === 'split' && splitJudged(c.fwj))) items.push({ k: 'fw', state: c.fw, pts: 0 });
    else unknown.push('fw');
    // ④ BIOS — 다른 설정만 감점 · 미분류(unplaced)도 견주지 않은 것(모름)
    if (c.bios === 'diff') { const n = Math.max(1, numOrNull(c.biosn) ?? 1); items.push({ k: 'bios', state: 'diff', n, pts: pts(HEALTH_RULES.biosDiff, n) }); }
    else if (c.bios === 'ok' || (c.bios === 'split' && splitJudged(c.biosj))) items.push({ k: 'bios', state: c.bios, pts: 0 });
    else unknown.push('bios');
  }
  const judged = items.length;
  if (judged < HEALTH_MIN.judged || judged < (judged + unknown.length) * HEALTH_MIN.share) return { score: null, band: 'none', items, unknown, judged, ...(judged > 0 ? { few: true } : {}) };
  const score = Math.max(0, 100 - items.reduce((a, x) => a + x.pts, 0));
  return { score, band: bandOf(score), items, unknown, judged };
}

/**
 * 목록 행에 싣는 줄인 꼴 — { s 점수 · b 단계 · u 모름 수 · uk 모름 키 · d 감점 항목 [키, 점수, 수?] · z 감점 0 으로 견준 항목 [키, 상태?] }.
 * 점수가 없으면 { b:'none', u, uk, few?, d?, z? }(HEALTH_MIN 미달 · 견준 항목 없음). 화면은 견줌 · 모름을 이 값으로만 그린다(판정을 웹에서 다시 하지 않는다 — 판정 코어는 하나).
 */
export function healthRowOf(row) {
  const h = healthOf(row);
  // 감점 항목 [키, 점수, 수|null, 상태?] — 보증은 상태(expired · soon)를 싣는다(화면이 ‘끝남’ · ‘곧 끝남’ 을 가른다 · 반증 B7)
  const d = h.items.filter((x) => x.pts > 0).map((x) => (x.state && x.k === 'warranty' ? [x.k, x.pts, null, x.state] : x.n != null ? [x.k, x.pts, x.n] : [x.k, x.pts]));
  const z = h.items.filter((x) => x.pts === 0).map((x) => (x.state ? [x.k, x.state] : [x.k]));
  const uk = h.unknown.slice();
  const facts = { ...(d.length ? { d } : {}), ...(z.length ? { z } : {}) };
  // 점수가 없어도 견준 항목의 사실(감점 · 0)은 싣는다 — few = 견준 것이 있으나 부족해 점수를 내지 않음
  return h.score == null ? { b: 'none', u: uk.length, uk, ...(h.few ? { few: 1 } : {}), ...facts } : { s: h.score, b: h.band, u: uk.length, uk, ...facts };
}
