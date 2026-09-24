/**
 * 엣지 설정 pull 의 404 판정(v2.600 감사 EDGE2600-06).
 *
 * 중앙의 설정 배포 엔드포인트(`/api/central/*-config`)는 **central 기능이 꺼져 있으면**
 * `404 {ok:false, reason:'central 비활성화'}` 를 준다. 엔드포인트가 아예 없는 구버전 중앙(또는 CENTRAL_URL 이 포탈이
 * 아닌 곳)은 express 기본 404(HTML `Cannot GET …`)를 준다. 예전 pull 모듈들은 본문을 읽지 않고 404 를 전부
 * '구버전 중앙' 으로 읽었다 — 중앙을 꺼 둔 것을 '업그레이드하면 된다' 로 말하는 거짓이었다. 조치가 다르다
 * (중앙에서 central 을 켠다 / 중앙을 업그레이드하거나 CENTRAL_URL 을 확인한다). edgelog v2.549 가 같은 방식으로 가른다.
 *
 * @param {Response} res  status 404 응답
 * @returns {Promise<{kind:'disabled'|'refused'|'no-endpoint', reason:string}>}
 */
export async function classifyCentral404(res) {
  let body = null;
  // JSON 본문이 없는 옛 형태 `{ok:false}` 는 reason 이 없어 'no-endpoint' 로 떨어진다 — 설정 엔드포인트 5종은 전부 reason 을 싣는다.
  try { body = await res.json(); } catch { body = null; } // HTML(express 기본 404)이면 JSON 파싱이 실패한다
  return classifyCentral404Body(body);
}

/**
 * 이미 읽은 404 본문으로 판정한다(v2.602 감사 EDGE2602-02) — push 워커(svcmonPush 등)는 응답 본문을 먼저 파싱해 두므로
 * 같은 응답을 두 번 읽을 수 없다. 판정 규칙은 classifyCentral404 와 **같은 하나**다(그 함수가 이것을 부른다).
 * @param {any} body  JSON 파싱 결과(HTML 이었으면 null)
 */
export function classifyCentral404Body(body) {
  const why = body && typeof body === 'object' && typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
  if (/비활성/.test(why)) return { kind: 'disabled', reason: `중앙의 central 기능이 꺼져 있습니다(404 — ${why}) — 중앙 설정을 확인하세요` };
  if (why) return { kind: 'refused', reason: `중앙이 이 요청을 거절했습니다(404 — ${why})` };
  return { kind: 'no-endpoint', reason: '중앙에 이 엔드포인트가 없습니다(404) — 구버전 중앙이거나 CENTRAL_URL 이 포탈 주소가 아닙니다' };
}
