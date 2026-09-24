/**
 * util/readPrefix.js — 응답 본문을 **앞부분만** 읽는다(v2.603 감사 SEC2603-03).
 *
 * `(await res.text()).slice(0, N)` 은 본문 **전체**를 메모리로 읽은 뒤 자른다(실측 400MB 응답에 RSS 74 → 1,359MB).
 * 키워드 검사처럼 앞부분만 필요한 곳은 이 헬퍼로 읽고 상한에서 스트림을 취소한다. 쓰는 곳:
 * `svcmon/checker.js`(HTTP 키워드) · `rma/testRunner.js`(url 점검 본문). `util/readCapped.js` 와 달리 넘어도 던지지 않는다.
 */
/**
 * 본문을 **앞 maxBytes 까지만** 스트림으로 읽는다(순수 I/O 헬퍼 — v2.603 SEC2603-03). 넘으면 거기서 취소하고
 * `capped:true` 로 알린다(던지지 않는다 — 키워드 검사는 앞부분만 보면 된다). 압축 응답도 해제된 바이트로 센다.
 */
export async function readBodyPrefix(res, maxBytes) {
  const max = Math.max(1, Number(maxBytes) || 0);
  if (!res?.body || typeof res.body.getReader !== 'function') {
    const t = String(await res.text());
    const b = Buffer.from(t, 'utf8');
    return b.length > max ? { text: b.subarray(0, max).toString('utf8'), capped: true } : { text: t, capped: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0, capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - n;
    if (value.byteLength >= room) {
      chunks.push(Buffer.from(value.buffer, value.byteOffset, room));
      n = max;
      capped = value.byteLength > room;
      if (!capped) {   // 정확히 상한에 닿았다 — 뒤에 더 있는지 한 번만 본다
        const nx = await reader.read();
        capped = !nx.done;
      }
      if (capped) { try { await reader.cancel(); } catch { /* */ } }
      break;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    n += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), capped };
}
