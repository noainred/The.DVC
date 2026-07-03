/**
 * HTTP Digest 인증(RFC 2617/7616, MD5 + qop=auth) — iDRAC 일부 펌웨어/보안정책은 Redfish에서
 * Basic 인증을 거부(401)하고 Digest만 허용한다("계정정보 맞는데 인증실패"의 흔한 원인).
 * Basic 시도가 401이고 응답의 WWW-Authenticate가 Digest면 이 헤더를 만들어 재시도한다.
 *
 * 의존성 없이 node:crypto만 사용(에어갭 호환). MD5-sess/auth-int은 iDRAC이 쓰지 않아 미지원.
 */

import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** WWW-Authenticate: Digest ... 헤더를 파싱해 파라미터 맵으로. Digest가 아니면 null. */
export function parseDigestChallenge(headerValue) {
  const h = String(headerValue || '');
  // 여러 스킴이 콤마로 이어질 수 있어 'Digest' 스킴 부분만 취한다.
  const idx = h.toLowerCase().indexOf('digest ');
  if (idx === -1) return null;
  const params = {};
  const body = h.slice(idx + 7);
  // key=value 또는 key="value" (따옴표 안의 콤마 허용).
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(body))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return params.nonce ? params : null;
}

/** Digest Authorization 헤더 문자열을 만든다. uri는 요청 경로(예: /redfish/v1/Systems). */
export function buildDigestHeader({ username, password, method, uri, challenge, cnonce, nc = '00000001' }) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const opaque = challenge.opaque;
  const algorithm = (challenge.algorithm || 'MD5');
  const qopRaw = challenge.qop || '';
  const qop = qopRaw.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : (qopRaw ? qopRaw.split(',')[0].trim() : '');
  const cn = cnonce || crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cn}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) { parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cn}"`); }
  if (opaque !== undefined) parts.push(`opaque="${opaque}"`);
  return 'Digest ' + parts.join(', ');
}
