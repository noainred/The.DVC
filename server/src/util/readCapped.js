/**
 * util/readCapped.js — 응답 본문을 **상한까지만** 읽어 JSON 으로(v2.583 — 감사 확정).
 *
 * 왜: undici fetch 는 `Content-Encoding: gzip` 을 자동으로 풀되 **해제 후 크기 상한이 없다**. 엣지(또는
 * 그 앞의 무엇)가 작은 gzip 폭탄을 돌려주면 `res.json()` 이 수백 MB 로 부풀린다 — 반증 에이전트 실측:
 * 전송 305KB → 해제 300MB, 중앙 RSS 372 → 691MB. 엣지 28곳을 주기로 당기면 중앙이 죽을 수 있다.
 * v2.577 의 '압축 해제에는 예외 없이 maxOutputLength' 규약은 명시적 zlib 호출만 훑어 이 경로를 놓쳤다.
 *
 * 스트림을 읽으며 누적 바이트가 상한을 넘으면 **즉시 취소**한다(해제는 읽는 만큼만 일어난다 — 멈추면 더 풀지 않는다).
 * 넘으면 던진다 — 호출부는 이미 '응답 형식 이상' 실패 경로를 갖고 있다.
 */
export async function readJsonCapped(res, maxBytes, what = '응답') {
  const text = await readTextCapped(res, maxBytes, what);
  return JSON.parse(text);
}

export async function readTextCapped(res, maxBytes, what = '응답') {
  const max = Math.max(1024, Number(maxBytes) || 0);
  const len = Number(res?.headers?.get?.('content-length'));
  // Content-Length 는 **압축된 크기**일 수 있어 판정 근거로 부족하다 — 넘으면 바로 거절만 한다.
  if (Number.isFinite(len) && len > max) {
    try { await res.body?.cancel?.(); } catch { /* */ }
    throw new Error(`${what}이 상한(${Math.round(max / 1048576)}MB)을 넘었습니다(${Math.round(len / 1048576)}MB)`);
  }
  if (!res?.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new Error(`${what}이 상한(${Math.round(max / 1048576)}MB)을 넘었습니다`);
    return t;
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
      throw new Error(`${what}이 상한(${Math.round(max / 1048576)}MB)을 넘어 읽기를 멈췄습니다(압축 해제 후 크기)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/** 엣지 응답 상한 — 인벤토리 export 는 수 MB 라 넉넉히, 나머지는 16MB(중앙 수신 한도와 같은 축). */
export const EDGE_EXPORT_MAX_BYTES = Math.max(1_048_576, Number(process.env.EDGE_EXPORT_MAX_BYTES) || 64 * 1048576);
export const EDGE_RESPONSE_MAX_BYTES = Math.max(1_048_576, Number(process.env.EDGE_RESPONSE_MAX_BYTES) || 16 * 1048576);
