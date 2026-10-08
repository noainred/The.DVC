// v2.703(A13) — 코어 라이선스 산정 문구. 판정은 서버 corelicense/analyze.js(규칙 키는 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const VSAN_PLAN_LABEL = Object.freeze({ none: '계산 안 함', vvf: 'VVF 가정(코어당 0.25 TiB)', vcf: 'VCF 가정(코어당 1 TiB)' });
const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export const fmtInt = (v) => (n(v) == null ? '—' : Math.round(n(v)).toLocaleString());
export const fmtTib = (v) => (n(v) == null ? '—' : `${n(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} TiB`);

/** v2.721(감사 B1-03): vSAN 추가분의 확정 여부(서버 corelicense/analyze.js addonBoundOf 와 키 1:1). */
export const ADDON_BOUND_NOTE = Object.freeze({
  exact: null,
  upper: 'vSAN 추가 필요량은 산정 못 한 호스트를 빼고 계산해 실제보다 클 수 있습니다(상한)',
  lower: 'vSAN 추가 필요량은 용량을 못 읽은 vSAN 데이터스토어를 빼고 계산해 실제보다 작을 수 있습니다(하한)',
  unknown: 'vSAN 추가 필요량은 산정 못 한 호스트와 용량 미상 vSAN 데이터스토어가 함께 있어 계산하지 않았습니다',
});
/** vSAN 추가 필요량 표기 — 상한·하한이면 그 사실을 붙이고, 산정 불가면 '산정 불가'. */
export function addonText(v, bound) {
  if (bound === 'unknown') return '산정 불가';
  const s = fmtTib(v);
  if (s === '—') return s;
  if (bound === 'upper') return `최대 ${s}`;
  if (bound === 'lower') return `최소 ${s}`;
  return s;
}
/** 산정 못 한 호스트·끊긴 호스트 안내 — 합계가 부분 합일 때 그 사실을 먼저 말한다. */
export function coverageNote(t) {
  if (!t) return null;
  const parts = [];
  if (t.unknown > 0) parts.push(`소켓·코어 수를 읽지 못한 호스트 ${t.unknown.toLocaleString()}대는 합계에서 뺐습니다 — 실제 필요 코어는 이보다 많습니다(하한)`);
  if (t.disconnected > 0) parts.push(`연결이 끊긴 호스트 ${t.disconnected.toLocaleString()}대도 라이선스 대상이라 포함했습니다(마지막으로 읽은 하드웨어 값)`);
  if (t.vsanUnknown > 0) parts.push(`용량을 읽지 못한 vSAN 데이터스토어 ${t.vsanUnknown}개는 vSAN 합계에서 뺐습니다`);
  // v2.721(감사 B1-03): vSAN 추가분이 확정값이 아니면 어느 방향으로 틀릴 수 있는지 말한다.
  const bn = ADDON_BOUND_NOTE[t.vsanAddonBound];
  if (bn) parts.push(bn);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
/** vCenter 가 보고한 코어 라이선스 사용량과 산정값 비교 문구. */
export function reportedText(r) {
  // v2.727(감사 C-02): vCenter 가 used 를 보고하지 않은 코어 라이선스가 있으면 보고 합이 null 이다 — '없음' 이 아니라 '일부 미상' 이고 비교하지 않는다.
  if (r.reportedUsedUnknown > 0) return { text: `보고값 일부 미상(사용량 없는 코어 라이선스 ${r.reportedUsedUnknown}개) · 비교 안 함`, tone: 'muted' };
  if (r.reportedCoreUsed == null) return { text: '코어 단위 라이선스 없음', tone: 'muted' };
  if (r.reportedDiff == null) return { text: `보고 ${fmtInt(r.reportedCoreUsed)}(산정이 부분 합이라 비교 안 함)`, tone: 'muted' };
  if (r.reportedDiff === 0) return { text: `보고 ${fmtInt(r.reportedCoreUsed)} · 일치`, tone: 'ok' };
  return { text: `보고 ${fmtInt(r.reportedCoreUsed)} · 산정과 ${r.reportedDiff > 0 ? '+' : ''}${fmtInt(r.reportedDiff)}`, tone: 'warn' };
}
export const RULE_NOTE = '산정 규칙: 호스트마다 소켓 수 × max(16, 소켓당 코어). Broadcom 의 공개 공지 기준이며 계약 조건(최소 수량·에디션)에 따라 달라질 수 있습니다 — 견적·감사 근거로 쓰기 전에 계약서로 확인하세요.';
