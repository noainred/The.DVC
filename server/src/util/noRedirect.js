// v2.620(SEC2620-01) — 자격증명을 싣는 장비 요청은 리다이렉트를 따라가지 않는다.
// 전역 fetch 의 기본값 redirect:'follow' 는 307/308 에 로그인 본문·커스텀 세션 헤더(vmware-api-session-id·
// EMC-CSRF-TOKEN 등)를 Location 으로 그대로 다시 보내고, IP 리터럴 대상은 SSRF lookup 을 타지 않아 루프백·
// 메타데이터 주소로도 간다(v2.612 SEC2612-02 가 CVP·Redfish 에만 고친 것의 형제 7곳). 여기서는
// redirect:'manual' 로 받고 3xx 를 실패로 밝힌다 — 장비가 정말 옮겼다면 등록 주소를 고치는 것이 조치다.
export const NO_REDIRECT = 'manual';

/** 3xx 응답이면 사유와 함께 던진다(Location 은 출처만 — 경로·쿼리에 토큰이 실릴 수 있다). */
export function refuseRedirect(res, what = '장비') {
  const st = Number(res?.status);
  if (!(st >= 300 && st < 400)) return res;
  let to = '';
  try { const loc = res.headers?.get?.('location'); if (loc) to = ` → ${new URL(loc, 'http://x').origin}`; } catch { /* */ }
  const err = new Error(`${what} 가 리다이렉트로 응답했습니다(HTTP ${st}${to}) — 자격증명을 싣는 요청은 따라가지 않습니다. 등록 주소(스킴·호스트·포트)를 확인하세요.`);
  err.status = st; err.redirect = true;
  throw err;
}
