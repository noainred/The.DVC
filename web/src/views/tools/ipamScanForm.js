/**
 * IPAM 스캔 설정 폼 → 저장 요청 본문(v2.605, 감사 LEFT2605-06).
 *
 * 숫자 칸(주기 분·동시성·타임아웃·보존일)은 **원문 문자열**을 폼 상태에 두고 여기서만 숫자로 바꾼다 — 형제 화면
 * (MetricsSettings·VmSeriesSettings)과 같은 패턴. 예전 onChange 는 `Number(e.target.value) || 기본값` 이라
 * 보존 칸을 비우면 0(= 정리 안 함, 90일 → 무제한)이, 주기 칸을 비우면 이전 값이 아니라 기본 60분이 저장됐다.
 * 빈 칸은 **보내지 않는다**(blankOr → undefined — 서버가 이전 값을 유지한다). 명시적 0 보존일은 값이다.
 */
import { blankOr } from '../blankOr.js';

/** 폼 표시용 주기(분) — 사용자가 고친 원문이 있으면 그것, 없으면 저장값에서 계산. */
export function intervalMinText(s) {
  if (s && s.intervalMin !== undefined) return s.intervalMin;
  const ms = Number(s?.intervalMs);
  return Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 60000)) : '';
}

/** 저장 요청 본문. 폼 전용 키(intervalMin)는 빼고 intervalMs 로 바꾼다. */
export function scanSettingsBody(s, agent) {
  const { intervalMin, ...rest } = s || {};
  const body = { ...rest, agent };
  if (intervalMin !== undefined) {
    const m = blankOr(intervalMin);
    body.intervalMs = m == null ? undefined : m * 60000;
  }
  for (const k of ['concurrency', 'timeoutMs', 'retentionDays']) body[k] = blankOr(rest[k]);
  return body;
}
