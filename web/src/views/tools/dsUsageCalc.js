/**
 * dsUsageCalc.js — 특수기능 › DS 사용량 화면의 사용률 계산(순수, v2.601 감사 LO2601-04).
 *
 * v2.598 VC2598-07 부터 서버는 여유 공간(freeSpace)을 못 읽은 데이터스토어의 `freeGB`·`usedGB`·`usagePct` 를
 * **null** 로 준다(예전엔 여유 0 → 100% · critical). 그런데 이 화면은 `(d.usedGB || 0)` 로 0 에 폴백해
 * **0% 초록 막대**를 그렸고, 합계는 전체 용량엔 그 DS 를 넣고 여유엔 빼서 **사용량이 그 DS 용량만큼 부풀었다**
 * (v2.599 '새 null 은 소비처를 전수로 따라갈 것' 의 누락).
 *  - 행: 사용량을 모르면 사용률 null → 화면은 '—'·회색(0% 도 초록도 아니다).
 *  - 합계: 사용률의 분자·분모는 **사용량을 읽은 DS 끼리만**. 전체 용량은 전부를 더하되, 뺀 개수(`unknown`)를 밝힌다.
 */
import { numOrNull } from '../../numOrNull.js';

/** 한 DS 의 사용량(GB) — usedGB, 없으면 전체−여유. 둘 다 모르면 null. */
export function dsUsedOf(d) {
  const used = numOrNull(d?.usedGB);
  if (used != null) return used;
  const cap = numOrNull(d?.capacityGB), free = numOrNull(d?.freeGB);
  return cap != null && free != null ? Math.max(0, cap - free) : null;
}

/** 한 DS 의 사용률(%) — 모르면 null(0 이 아니다). */
export function dsRowPct(d) {
  const p = numOrNull(d?.usagePct);
  if (p != null) return p;
  const cap = numOrNull(d?.capacityGB), used = dsUsedOf(d);
  return cap != null && cap > 0 && used != null ? Math.round((used / cap) * 100) : null;
}

/**
 * DS 목록 합계.
 * @returns {{capacityGB:number, knownCapGB:number, usedGB:number, freeGB:number, pct:number|null, unknown:number}}
 */
export function dsAgg(items) {
  let capacityGB = 0, knownCapGB = 0, usedGB = 0, freeGB = 0, unknown = 0;
  for (const d of Array.isArray(items) ? items : []) {
    const cap = numOrNull(d?.capacityGB) ?? 0;
    capacityGB += cap;
    const used = dsUsedOf(d);
    if (used == null) { unknown += 1; continue; }
    knownCapGB += cap; usedGB += used;
    freeGB += numOrNull(d?.freeGB) ?? Math.max(0, cap - used);
  }
  return { capacityGB, knownCapGB, usedGB, freeGB, pct: knownCapGB > 0 ? Math.round((usedGB / knownCapGB) * 100) : null, unknown };
}

/** 사용률 색 — 모르면 회색(초록은 '정상' 이라는 판정이다). */
export function dsUsageColor(pct) {
  if (pct == null) return 'var(--text-dim, #94a3b8)';
  return pct >= 90 ? 'var(--red)' : pct >= 75 ? 'var(--amber)' : 'var(--green)';
}
