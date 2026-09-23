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
  // v2.594(감사 R2594-02): 못 읽은 값(null·빈 값·숫자 아님)은 '—' — '0.0 TB' 는 '비었다' 는 거짓이다.
  // v2.593 에 REST 수집기 5종이 사용량 결측을 0 대신 null 로 내기 시작해 이 경로가 실제로 쓰인다.
  if (bytes == null || bytes === '' || !Number.isFinite(Number(bytes))) return '—';
  const n = Number(bytes);
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

/**
 * 용량 합계(v2.594, 감사 R2594-02) — **사용량을 읽은 장비끼리만** 사용률을 계산한다.
 * 예전 화면은 `a + (used || 0)` 로 사용량 결측을 0 으로 더하면서 그 장비의 전체 용량은 분모에 남겨
 * 사용률을 **과소**로 보여줬다(오류 없이 틀린 값). 전체 용량 합계(total)는 그대로 모든 장비를 더하고,
 * 사용률은 사용량을 읽은 장비의 (used / 그 장비들의 total) 이며, 뺀 대수를 `unknownUsed` 로 밝힌다.
 * @param list 장비 목록
 * @param pick (r) => r.snap?.capacity (없으면 건너뛴다)
 */
export function capacityTotals(list, pick) {
  let total = 0; let used = 0; let usedBase = 0; let unknownUsed = 0; let counted = 0;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of Array.isArray(list) ? list : []) {
    const c = pick(r);
    if (!c) continue;
    const t = num(c.totalBytes);
    if (t == null || !(t > 0)) continue;
    counted += 1; total += t;
    const u = num(c.usedBytes);
    if (u == null) { unknownUsed += 1; continue; }
    used += u; usedBase += t;
  }
  const pct = usedBase > 0 ? Math.round((used / usedBase) * 100) : null;
  return { total, used: usedBase > 0 ? used : (counted ? null : 0), usedBase, unknownUsed, counted, pct };
}
