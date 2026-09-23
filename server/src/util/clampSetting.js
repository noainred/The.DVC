/**
 * 숫자 설정 정규화(v2.595, 감사 DEPS2595-01 — 재현).
 *
 * 왜 하나로 두는가: `const n = Number(v); Number.isFinite(n) ? clamp(n) : d` 형태가 저장소에 여러 벌이고, 셋이
 * **빈 값의 뜻**이 달랐다. `Number('') === 0` 이라 화면이 비운 칸('')이 0 이 되고 하한으로 올라간다 — OS 스캔 설정은
 * 빈 칸을 저장하면 주기 720분 → 5분 · 재스캔 30일 → 0(안 함) · 최대 200대 → 1 · 동시 4 → 1 이 됐다(오류 없이 '저장됨').
 * 규칙: 빈 값·null·숫자 아님·배열·불리언은 **미지정**(이전 값/기본값 유지) · 숫자와 숫자 문자열만 값이다(명시적 0 포함).
 * 판정은 util/numOrNull.js 에 맡긴다(Number(null)===0 함정 — v2.561 규약).
 */
import { numOrNull } from './numOrNull.js';

export function clampSetting(v, { min = -Infinity, max = Infinity, def, round = true } = {}) {
  const n = numOrNull(v);
  if (n == null) return def;
  const x = round ? Math.round(n) : n;
  return Math.max(min, Math.min(max, x));
}
