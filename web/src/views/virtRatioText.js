// 가상화율(할당 : 물리) 판정 — Summary 의 KPI 와 vCenter별 모달이 같은 규칙을 쓴다(v2.611 WEB2611-06).
//
// 분모(물리 코어·물리 RAM)가 0 이하이거나 읽지 못했으면 비율은 null('—')이고 배지는 '미수집'(회색)이다.
// 호스트가 없는 vCenter(첫 수집 중·연결 실패)는 byVcenter 에 0 으로 들어온다 — 그것을 '0 : 1 · 정상'(초록)
// 으로 칠하면 '확인하지 못한 것을 정상' 이라 말하는 거짓이 된다(v2.519·v2.534 규약).
import { numOrNull } from '../numOrNull.js';

export const RATIO_HI = { cpu: 4, mem: 1.5 };

/** 할당 ÷ 물리. 분모가 양수가 아니면 null. 할당을 못 읽었으면(null) 역시 null. */
export function ratioOrNull(allocated, physical) {
  const p = numOrNull(physical);
  if (p == null || !(p > 0)) return null;
  const a = numOrNull(allocated);
  if (a == null) return null;
  return Number((a / p).toFixed(2));
}

/**
 * 서버가 이미 계산한 비율(분모 0 이면 0 을 준다)을 분모로 다시 판정한다 — 분모가 없으면 null.
 * scale: ramOvercommitPct 처럼 퍼센트로 오는 값은 100.
 */
export function serverRatio(value, physical, scale = 1) {
  const p = numOrNull(physical);
  if (p == null || !(p > 0)) return null;
  const v = numOrNull(value);
  if (v == null) return null;
  return Number((v / scale).toFixed(2));
}

/** 비율 표시 문자열 — null 이면 단위 없이 '—'(unitText 규약). */
export function ratioLabel(ratio) {
  return ratio == null ? '—' : `${ratio} : 1`;
}

/**
 * 오버커밋 배지. kind='cpu'|'mem'.
 * @returns {{cls:string, text:string}}
 */
export function ratioBadge(ratio, kind = 'cpu') {
  if (ratio == null) return { cls: 'gray', text: '미수집' };
  const hi = RATIO_HI[kind] ?? RATIO_HI.cpu;
  if (ratio > hi) return { cls: 'amber', text: '높음' };
  return { cls: 'green', text: '정상' };
}

/** KPI 카드용 색·부제. */
export function ratioKpi(ratio, kind = 'cpu') {
  if (ratio == null) return { accent: 'var(--text-dim)', sub: '물리 자원 미수집 — 판정 보류' };
  const hi = RATIO_HI[kind] ?? RATIO_HI.cpu;
  if (ratio > hi) return { accent: 'var(--amber)', sub: '높은 오버커밋' };
  if (kind === 'mem' && ratio > 1) return { accent: 'var(--green)', sub: '물리 초과 할당' };
  return { accent: 'var(--green)', sub: '정상 범위' };
}

/** 표 셀 수치 — 결측은 '—'(0 으로 채우지 않는다). */
export function numCell(v) {
  const n = numOrNull(v);
  return n == null ? '—' : n.toLocaleString();
}
