/**
 * guacd 연결 방식 판정(순수 — 의존 없음 · 등록부 · 터널 · 테스트 공용 · 48회차 F2 사용자 결정 — 2026-11-17 '권장 사항으로 진행').
 *
 * 예전에는 포탈 → guacd 구간이 늘 평문 TCP 였고, guacd 가 RDP 대상에 붙을 때 인증서 검증을 늘 껐다(`ignore-cert` 고정).
 * guacd 가 포탈 밖(WAN 너머)에 있으면 RDP 티켓의 사용자명 · 비밀번호가 connect 명령에 실려 평문으로 지난다.
 *
 *  - `tls`           : 포탈 → guacd 를 TLS 로(guacd 를 -C/-K 로 띄운 경우). **인증서는 검증한다** — 사설 CA 는 WAN_TLS_CA_FILE 을 함께 믿는다.
 *  - `verifyRdpCert` : guacd → RDP 대상 인증서 검증(`ignore-cert` = false). 대상 인증서를 guacd 호스트가 믿어야 붙는다.
 *  기본값은 둘 다 꺼짐(예전 동작 그대로 — 켜면 기존 환경이 붙지 않을 수 있어 사용자가 고른다).
 *  guacd 가 루프백이 아닌데 TLS 가 꺼져 있으면 설정 화면이 경고한다(`guacdPlaintextRemote` — 웹 `proxyGuacdText.js` 와 같은 판정, 테스트가 대조).
 */
/** 저장 · 사용 지점 공용 — 불리언 칸은 true / 'true' 만 켬(그 밖은 끔). 모르는 칸은 그대로 둔다(예전 저장본 호환). */
export function normalizeGuacdFlags(g) {
  const o = g && typeof g === 'object' ? { ...g } : {};
  o.tls = o.tls === true || o.tls === 'true';
  o.verifyRdpCert = o.verifyRdpCert === true || o.verifyRdpCert === 'true';
  return o;
}

/** 루프백 주소 · 이름(같은 호스트의 guacd) — 이 구간은 평문이어도 호스트 밖으로 나가지 않는다. */
export function isLoopbackGuacdHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 경고 판정: guacd 가 설정됐고 루프백이 아니며 TLS 가 꺼져 있다 → RDP 비밀번호가 평문으로 네트워크를 지난다. */
export function guacdPlaintextRemote(g) {
  const o = normalizeGuacdFlags(g);
  const host = String(o.host ?? '').trim();
  return !!host && !o.tls && !isLoopbackGuacdHost(host);
}

/** guacd connect 인자 'ignore-cert' — 검증을 켜면 'false'. */
export function rdpIgnoreCertArg(g) {
  return normalizeGuacdFlags(g).verifyRdpCert ? 'false' : 'true';
}
