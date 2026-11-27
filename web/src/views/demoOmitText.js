/**
 * 보안 잔여 11-27 L7(반증 2회차): 데모 계정 판본에서 뺀 것 안내 — 프로비저닝 '저장된 작업' · Bareos 백업 대상 공용.
 * 서버가 demoOnly: true 와 demoMasked[kind](양의 정수)를 실었을 때만 말한다(옛 서버 · 관리자 응답에는 없다 — 개수를 지어내지 않는다).
 *  · saved — routes/api/provision.js savedShownTo(데모 계정은 자기가 만든 저장 작업만)
 *  · jobs  — routes/api/bareosBackup.js bareosJobShownTo(데모 계정은 데모 Director 의 대상만)
 * @returns {string|null}
 */
export function demoOmitNote(d, kind) {
  if (!d || d.demoOnly !== true || !d.demoMasked || typeof d.demoMasked !== 'object') return null;
  const n = d.demoMasked[kind];
  if (!Number.isInteger(n) || n <= 0) return null;
  if (kind === 'saved') return `데모 계정에는 다른 계정이 만든 저장된 작업 ${n}건을 표시하지 않습니다(만든 계정 · IP 계획이 들어 있습니다).`;
  if (kind === 'jobs') return `데모 계정에는 사람이 등록한 Director 의 백업 대상 ${n}건을 표시하지 않습니다 — 아래 목록과 수는 데모 대상만 셉니다.`;
  return null;
}
