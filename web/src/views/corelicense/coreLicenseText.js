// v2.703(A13) — 코어 라이선스 산정 문구. 판정은 서버 corelicense/analyze.js(규칙 키는 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const VSAN_PLAN_LABEL = Object.freeze({ none: '계산 안 함', vvf: 'VVF 가정(코어당 0.25 TiB)', vcf: 'VCF 가정(코어당 1 TiB)' });
const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export const fmtInt = (v) => (n(v) == null ? '—' : Math.round(n(v)).toLocaleString());
export const fmtTib = (v) => (n(v) == null ? '—' : `${n(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} TiB`);

/** 산정 못 한 호스트·끊긴 호스트 안내 — 합계가 부분 합일 때 그 사실을 먼저 말한다. */
export function coverageNote(t) {
  if (!t) return null;
  const parts = [];
  if (t.unknown > 0) parts.push(`소켓·코어 수를 읽지 못한 호스트 ${t.unknown.toLocaleString()}대는 합계에서 뺐습니다 — 실제 필요 코어는 이보다 많습니다(하한)`);
  if (t.disconnected > 0) parts.push(`연결이 끊긴 호스트 ${t.disconnected.toLocaleString()}대도 라이선스 대상이라 포함했습니다(마지막으로 읽은 하드웨어 값)`);
  if (t.vsanUnknown > 0) parts.push(`용량을 읽지 못한 vSAN 데이터스토어 ${t.vsanUnknown}개는 vSAN 합계에서 뺐습니다`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
/** vCenter 가 보고한 코어 라이선스 사용량과 산정값 비교 문구. */
export function reportedText(r) {
  if (r.reportedCoreUsed == null) return { text: '코어 단위 라이선스 없음', tone: 'muted' };
  if (r.reportedDiff == null) return { text: `보고 ${fmtInt(r.reportedCoreUsed)}(산정이 부분 합이라 비교 안 함)`, tone: 'muted' };
  if (r.reportedDiff === 0) return { text: `보고 ${fmtInt(r.reportedCoreUsed)} · 일치`, tone: 'ok' };
  return { text: `보고 ${fmtInt(r.reportedCoreUsed)} · 산정과 ${r.reportedDiff > 0 ? '+' : ''}${fmtInt(r.reportedDiff)}`, tone: 'warn' };
}
export const RULE_NOTE = '산정 규칙: 호스트마다 소켓 수 × max(16, 소켓당 코어). Broadcom 의 공개 공지 기준이며 계약 조건(최소 수량·에디션)에 따라 달라질 수 있습니다 — 견적·감사 근거로 쓰기 전에 계약서로 확인하세요.';
