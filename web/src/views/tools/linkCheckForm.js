/**
 * 통신 점검 설정 폼 ↔ 저장 요청(순수 — vitest 고정, v2.606 감사 WEB2606-10).
 *
 * 숫자 칸은 원문 문자열로 둔다. 예전에는 `Number('') || 90` 이 칸을 비우는 즉시 기본값(보존 90일·주기 1분)으로 다시
 * 채워 **빈 칸을 유지할 수 없었고**, 그대로 저장하면 365일 보존이 90일로 줄어 prune 이 과거 표본을 지웠다.
 * 이제 빈 칸은 보내지 않는다(서버 saveLinkCheckSettings 가 이전 값을 유지 — v2.596 규약).
 */
import { blankOr } from '../blankOr.js';

export const LINK_NUM_FIELDS = ['concurrency', 'sampleRetentionDays', 'eventRetentionDays'];

/** 서버 설정 → 폼(숫자 칸은 문자열, 주기는 분 단위 문자열 intervalMin). */
export function linkFormFromSettings(settings) {
  const s = settings || {};
  const f = { ...s, intervalMin: s.intervalMs != null ? String(Math.round(Number(s.intervalMs) / 60000)) : '' };
  for (const k of LINK_NUM_FIELDS) f[k] = s[k] != null ? String(s[k]) : '';
  return f;
}

/** 폼 → 저장 요청. 빈 칸·숫자 아님은 undefined(JSON 에서 빠진다 = 이전 값 유지). */
export function linkSettingsPayload(form) {
  const f = { ...(form || {}) };
  const min = blankOr(f.intervalMin);
  delete f.intervalMin;
  f.intervalMs = min != null ? min * 60000 : undefined;
  for (const k of LINK_NUM_FIELDS) f[k] = blankOr(f[k]);
  return f;
}
