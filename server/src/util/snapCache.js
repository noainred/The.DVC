/**
 * 스냅샷 리비전 키 기반 메모이저 — 무거운 폴링 엔드포인트(전력 대시보드·인사이트·전력분해 등)가
 * 같은 스냅샷에 대해 매 요청 재계산하는 것을 막는다. 동일 key의 '동시' 요청은 하나의 계산에
 * 합류(single-flight)시켜, N명이 동시에 같은 화면을 폴링해도 계산은 1회만 돈다(이벤트 루프
 * head-of-line blocking을 크게 줄임).
 *
 * key는 보통 `${snapshot.generatedAt}|${params...}`로 만든다(스냅샷이 갱신되면 key가 바뀌어
 * 자동 무효화). ttlMs는 generatedAt이 어떤 이유로 멈춰도 과도하게 오래된 값을 안 주도록 하는
 * 백스톱이다.
 */

const store = new Map(); // name -> { key, at, value, promise }

/**
 * @param name    캐시 이름(엔드포인트별 고유)
 * @param key     무효화 키(스냅샷 리비전 + 파라미터)
 * @param ttlMs   값 유효시간(백스톱)
 * @param compute async () => value
 */
export async function snapMemo(name, key, ttlMs, compute) {
  const now = Date.now();
  const cur = store.get(name);
  if (cur && cur.key === key) {
    if (cur.value !== undefined && (now - cur.at) < ttlMs) return cur.value; // 신선한 캐시 히트
    if (cur.promise) return cur.promise;                                     // 진행 중 계산에 합류
  }
  const promise = (async () => {
    const value = await compute();
    store.set(name, { key, at: Date.now(), value, promise: null });
    return value;
  })();
  // 진행 중 표시(같은 key 동시 요청이 위에서 promise에 합류). 이전 값은 key가 같을 때만 임시 보존.
  store.set(name, { key, at: now, value: (cur && cur.key === key) ? cur.value : undefined, promise });
  try {
    return await promise;
  } catch (e) {
    const s = store.get(name);
    if (s && s.promise === promise) store.delete(name); // 실패한 계산은 캐시에 남기지 않음
    throw e;
  }
}

/** 테스트/명시적 무효화용. */
export function snapCacheClear(name) {
  if (name) store.delete(name); else store.clear();
}

/** 캐시 key로부터 약한 ETag 생성(djb2). 같은 스냅샷/파라미터면 같은 ETag. */
export function weakEtag(key) {
  let h = 5381; const s = String(key);
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return `W/"${h.toString(36)}-${s.length.toString(36)}"`;
}

/**
 * ETag/304 응답 헬퍼 — key 기반 ETag를 설정하고, 클라이언트의 If-None-Match와 같으면 304(본문
 * 없음)로 응답해 대역폭을 아낀다. 반환 true=304 보냄(호출부는 즉시 return). false=본문 전송됨.
 */
export function sendCached(req, res, key, payload, { maxAge = 0 } = {}) {
  const etag = weakEtag(key);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${maxAge}, must-revalidate`);
  if ((req.headers['if-none-match'] || '') === etag) { res.status(304).end(); return true; }
  res.json(payload);
  return false;
}
