/**
 * guacd 연결 방식 판정 · 문구(48회차 F2 사용자 결정 — 2026-11-17). 서버 `server/src/proxy/guacdFlags.js` 와 같은 판정이다
 * (서버 테스트 leftoverA56 이 같은 입력으로 대조한다 — 한쪽만 고치지 말 것).
 */

/** 불리언 칸은 true / 'true' 만 켬. */
export function guacdFlag(v) { return v === true || v === 'true'; }

/** 루프백 주소 · 이름(같은 호스트의 guacd). */
export function isLoopbackGuacdHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** guacd 가 설정됐고 루프백이 아니며 TLS 가 꺼져 있다 → RDP 비밀번호가 평문으로 네트워크를 지난다. */
export function guacdPlaintextRemote(g) {
  const host = String(g?.host ?? '').trim();
  return !!host && !guacdFlag(g?.tls) && !isLoopbackGuacdHost(host);
}

export const GUACD_TEXT = {
  tls: 'guacd 와 TLS 로 연결(인증서 검증)',
  tlsHint: 'guacd 를 -C(인증서) · -K(키)로 띄운 경우에만 켭니다. 사설 CA 는 WAN_TLS_CA_FILE 을 함께 믿습니다.',
  verify: 'RDP 대상 인증서 검증',
  verifyHint: '켜면 guacd 호스트가 RDP 대상 인증서를 믿어야 접속됩니다(자체 서명 대상은 접속 실패).',
  plaintextWarn: 'guacd 가 이 서버 밖에 있는데 TLS 가 꺼져 있습니다 — RDP 접속 때 사용자명 · 비밀번호가 평문으로 네트워크를 지납니다. 같은 호스트에 두거나 TLS 를 켜세요.',
};
