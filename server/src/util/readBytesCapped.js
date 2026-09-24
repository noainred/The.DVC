/**
 * util/readBytesCapped.js — 응답 본문을 **바이트 상한까지만** Buffer 로 읽는다(v2.607 감사 SEC2607-06).
 *
 * 왜: 업그레이드 아카이브 다운로드(`upgrade.js downloadArchive`)는 머리말에 'caps size' 라 적고서
 *   `Buffer.from(await res.arrayBuffer())` 로 **전량을 받은 뒤에야** 크기를 비교했다 — 상한이 사후 검사였다.
 *   형제 `fetchPackage.js`·`bundleSource.js` 는 상한 자체가 없었다. undici 는 gzip 을 자동으로 풀되 해제 후 상한이
 *   없으므로(util/readCapped.js 머리말) 원격 소스가 거대 본문·압축 폭탄을 주면 sha256 검증 전에 메모리가 부푼다.
 *
 * 스트림을 읽으며 누적이 상한을 넘으면 **즉시 취소하고** `{ ok:false, tooLarge:true }` 를 돌려준다(던지지 않는다 —
 * 호출부 셋 모두 `{ok:false, reason}` 실패 경로를 이미 갖고 있다). Content-Length 가 상한을 넘으면 읽지 않는다.
 */
export async function readBytesCapped(res, maxBytes) {
  const max = Math.max(1, Math.floor(Number(maxBytes) || 0));
  const len = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) {
    try { await res.body?.cancel?.(); } catch { /* */ }
    return { ok: false, tooLarge: true, bytes: len };
  }
  if (!res?.body || typeof res.body.getReader !== 'function') {
    // 스트림이 없는 응답(테스트 더블 등) — 받은 뒤 비교할 수밖에 없다.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) return { ok: false, tooLarge: true, bytes: buf.length };
    return { ok: true, buf };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      try { await reader.cancel(); } catch { /* */ }
      return { ok: false, tooLarge: true, bytes: n };
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { ok: true, buf: Buffer.concat(chunks, n) };
}
