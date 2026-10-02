/**
 * views/horizonAdminText.js — Horizon 연결 테스트 결과 문구(v2.685, 순수).
 *
 * 사용자 신고: 등록 뒤 연결 테스트가 '라이선스 조회 실패 (HTTP 404)' 한 줄만 말해 로그인이 된 건지 알 수 없었다.
 * 서버(`horizon.js testHorizon`)가 로그인과 라이선스 조회를 나눠 보내고, 여기는 그것을 문장으로 만든다.
 *  · licenses === null → 로그인은 성공, 라이선스 경로만 실패(주황 — 실시간 사용자·앱별 사용 수집은 쓸 수 있다).
 *  · 버전·다른 API 응답은 단정하지 않고 받은 그대로 적는다(필드 이름을 실장비로 확인하지 못했다).
 */
export function hzTestMessage(r) {
  if (!r) return { ok: false, text: '응답이 없습니다.' };
  if (!r.ok) return { ok: false, text: `${r.reason || '연결 실패'}${r.hint ? ` · ${r.hint}` : ''}` };
  if (r.licenses == null) {
    const parts = [`로그인 성공 (${r.ms}ms) — 계정·주소는 맞습니다.`, r.licenseError || `라이선스 조회 실패 (HTTP ${r.licenseStatus})`];
    if (r.csVersion) parts.push(`커넥션 서버 버전: ${r.csVersion}`);
    if (r.probe) parts.push(r.probe.status ? `다른 API(${r.probe.path}) 응답: HTTP ${r.probe.status}` : `다른 API(${r.probe.path}) 확인 실패`);
    parts.push('라이선스 만료일은 보이지 않지만 실시간 사용자·앱별 사용 수집은 이 등록으로 동작할 수 있습니다.');
    return { ok: false, warn: true, text: parts.join(' · ') };
  }
  return { ok: true, text: `연결 성공 (${r.ms}ms) · 라이선스 ${r.licenses}건${r.first ? ` · ${r.first}` : ''}` };
}
