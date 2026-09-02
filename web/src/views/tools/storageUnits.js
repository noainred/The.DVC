/**
 * storageUnits.js — 스토리지 용량 표시 단위(v2.406, 사용자 요구
 * '모든 스토리지의 사용량을 추적해야 하니까 TB/GB 단위로 선택해서 볼 수 있게').
 * 적용 범위: 스토리지 모니터링 화면 전체 — 타입 구분 없이 표·장비 상세·용량 추이 차트가 모두 따른다.
 *
 * 왜 필요한가: 기본(auto)은 1024TB 를 넘으면 PB 로 접어 보여준다. 보기엔 깔끔하지만
 * **증가분을 추적할 때는 불리하다** — 1.30 PB → 1.31 PB 처럼 소수 둘째 자리에서만 움직여
 * 하루치 증가(수 TB)가 표시 정밀도에 묻힌다. TB/GB 로 고정하면 같은 값이
 * 1,331.2 TB → 1,341.7 TB 로 보여 증가가 그대로 드러난다.
 *
 * 순수 모듈로 둔 이유: 웹 테스트가 node 환경(DOM 없음)이라 렌더는 검증할 수 없다.
 * 포맷 규칙을 여기서 회귀로 고정한다(storageColumns.js 와 같은 패턴).
 */

const TB = 1024 ** 4;

/** 선택 가능한 단위. auto = 크기에 따라 TB/PB 자동(기존 동작). */
export const UNIT_OPTIONS = [
  { value: 'auto', label: '자동', hint: '1024TB 이상은 PB 로 접어 표시(기존 동작)' },
  { value: 'pb', label: 'PB', hint: '항상 PB' },
  { value: 'tb', label: 'TB', hint: '항상 TB — 증가분 추적에 유리' },
  { value: 'gb', label: 'GB', hint: '항상 GB — 소용량/일 단위 증가 추적' },
];
const VALID = new Set(UNIT_OPTIONS.map((u) => u.value));

/** 단위 문자열 정규화(모르는 값은 auto). */
export const normalizeUnit = (u) => (VALID.has(String(u)) ? String(u) : 'auto');

/**
 * 바이트 → 표시 문자열.
 * @param bytes 숫자(널/NaN 이면 '—' 를 쓰라고 null 을 돌려주지 않고 0 처리 — 호출부가
 *              값 유무를 이미 판단한다. storageColumns.cellValue 가 null 을 걸러낸다.)
 * @param unit  'auto' | 'pb' | 'tb' | 'gb'
 *
 * 자릿수: TB 는 1자리(1341.7 TB), GB 는 정수(1373390 GB — 소수까지 가면 읽기 어렵다),
 * PB 는 2자리(1.31 PB). 천 단위 구분자를 넣어 큰 수를 눈으로 비교할 수 있게 한다.
 */
export function formatBytes(bytes, unit = 'auto') {
  const n = Number(bytes) || 0;
  const tb = n / TB;
  const u = normalizeUnit(unit);
  if (u === 'gb') return `${Math.round(tb * 1024).toLocaleString()} GB`;
  if (u === 'tb') return `${(Math.round(tb * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} TB`;
  if (u === 'pb') return `${(tb / 1024).toFixed(2)} PB`;
  // auto — 기존 동작(1024TB 이상은 PB).
  return tb >= 1024 ? `${(tb / 1024).toFixed(2)} PB` : `${tb.toFixed(1)} TB`;
}

const KEY = 'storagemon.unit';

/** 브라우저에 저장된 선택(없거나 접근 불가면 auto). 저장 실패가 화면을 막지 않게 try/catch. */
export function loadUnit() {
  try { return normalizeUnit(localStorage.getItem(KEY)); } catch { return 'auto'; }
}
export function saveUnit(u) {
  try { localStorage.setItem(KEY, normalizeUnit(u)); } catch { /* 사생활 보호 모드 등 — 무시 */ }
  return normalizeUnit(u);
}
