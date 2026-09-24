/**
 * util/hostPort.js — 등록 주소(`https://host:port/…`)에서 접속용 host·port 를 뽑는 공용 파서(v2.603 LEFT2603-02).
 *
 * 예전에는 인증서 감시·중계 점검·VM 콘솔이 각자 `clean.split(':')[0]` 으로 잘랐다 — IPv6 등록
 * (`https://[2001:db8::10]`)은 host 가 `[2001` 이 되어 '차단됨'·'형식 오류' 로 보고됐다.
 * 이제 `new URL` 로 해석하고, 접속(net/tls.connect)용 `host` 는 **대괄호를 뗀** 값,
 * URL·`host:port` 문자열용 `hostPort` 는 IPv6 면 **대괄호를 붙인** 값을 준다.
 *
 * - 스킴이 없으면 https 로 본다(예전 동작과 같다). 포트가 없으면 `defPort`(기본 443 — 예전과 같다).
 * - 대괄호 없는 IPv6(`fd00::1`)는 URL 로 해석되지 않으므로 전체를 호스트로 본다(포트 구분 불가 — 기본 포트).
 * - 해석하지 못하면 null — 호출부가 '형식 오류' 로 다룬다(지어낸 host 를 만들지 않는다).
 */
export function splitHostPort(raw, defPort = 443) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const noScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  if (!noScheme) return null;
  // 대괄호 없는 IPv6 리터럴(콜론 2개 이상) — 포트를 구분할 수 없으므로 전체가 호스트다.
  if (!noScheme.startsWith('[') && (noScheme.match(/:/g) || []).length >= 2) {
    return { host: noScheme.toLowerCase(), port: defPort, hostPort: `[${noScheme.toLowerCase()}]:${defPort}`, ipv6: true };
  }
  let u;
  try { u = new URL(`https://${noScheme}`); } catch {
    // URL 이 거부한 IPv4/이름 형태(예: 'host:abc')는 예전 규칙(콜론 앞 = 호스트)으로 — 동작을 바꾸지 않는다.
    if (noScheme.startsWith('[')) return null;
    const [h, p] = noScheme.split(':');
    if (!h) return null;
    const port = Number(p) || defPort;
    return { host: h, port, hostPort: `${h}:${port}`, ipv6: false };
  }
  const bracketed = u.hostname;                       // IPv6 면 '[…]'
  const host = bracketed.replace(/^\[|\]$/g, '');
  if (!host) return null;
  const port = u.port ? Number(u.port) : (/:443$/.test(noScheme) ? 443 : defPort);
  const ipv6 = bracketed.startsWith('[');
  return { host, port, hostPort: `${ipv6 ? `[${host}]` : host}:${port}`, ipv6 };
}
