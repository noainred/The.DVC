// 클라이언트 CSV 내보내기 공통 유틸 — **수식 인젝션 가드**를 한 곳에 모은다.
// 서버(server/src/util/csv.js guardCell)·pyportal(hub/csvio.py)과 동일 정책:
// Excel/Sheets 는 `= + - @` (및 앞선 탭/CR)로 시작하는 셀을 수식으로 실행하므로, 그런 셀은
// 앞에 작은따옴표(')를 붙여 텍스트로 강제한다. 과거 클라이언트 내보내기(FleetInventory/NicTools/
// PowerMap/HardwareTools/LicenseTools/ToolsReports/vcdOverview)는 이 가드가 없어, VM 이름 등
// 사용자 영향 텍스트에 `=HYPERLINK(...)` 같은 값이 있으면 열람자 PC 에서 수식이 실행될 수 있었다.

// 순수 숫자(부호·소수·지수만) — 엑셀이 숫자로 읽을 뿐 수식으로 실행하지 않는다(v2.741 WEB-02).
// 서버 server/src/util/csv.js·pyportal hub/csvio.py 와 같은 규칙이어야 한다(테스트가 세 벌을 대조).
const PLAIN_NUMBER_RE = /^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i;

/**
 * 셀 값을 수식 가드만 적용해 돌려준다(따옴표로 항상 감싸는 기존 내보내기용).
 * ⚠ 유한 숫자와 순수 숫자 문자열(`-12.5`·`+3`·`1e-3`)은 가드하지 않는다 — 예전엔 음수에도
 * 작은따옴표가 붙어 엑셀에서 텍스트가 되어 정렬·합계에서 빠졌다. `-2+3`·`=…`·`@…` 는 계속 가드한다.
 */
export function guardCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = v === null || v === undefined ? '' : String(v);
  if (PLAIN_NUMBER_RE.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** 셀 값 → CSV 셀(수식 가드 + 필요한 경우만 따옴표). 서버 csvLine 과 같은 형식. */
export function csvCell(v) {
  const s = guardCell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 셀 배열들의 배열 → CSV 본문(CRLF, 수식 가드 포함). */
export function toCsv(rows) {
  return (rows || []).map((r) => (r || []).map(csvCell).join(',')).join('\r\n');
}
