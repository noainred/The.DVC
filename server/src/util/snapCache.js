/**
 * 스냅샷 리비전 키 기반 메모이저 — 무거운 폴링 엔드포인트(전력 대시보드·인사이트·전력분해 등)가
 * 같은 스냅샷에 대해 매 요청 재계산하는 것을 막는다. 동일 key의 '동시' 요청은 하나의 계산에
 * 합류(single-flight)시켜, N명이 동시에 같은 화면을 폴링해도 계산은 1회만 돈다(이벤트 루프
 * head-of-line blocking을 크게 줄임).
 *
 * key는 보통 `${snapshot.generatedAt}|${params...}`로 만든다(스냅샷이 갱신되면 key가 바뀌어
 * 자동 무효화). ttlMs는 generatedAt이 어떤 이유로 멈춰도 과도하게 오래된 값을 안 주도록 하는
 * 백스톱이다.
 *
 * v2.447(감사 T6) — **엔드포인트당 슬롯 1개 → 소형 LRU**:
 *   예전에는 `name -> {key,...}` 라 이름당 최근 key **하나만** 보관했다. 사용자 A 가
 *   `?vcenterId=kr`, B 가 `?vcenterId=pl` 로 같은 화면을 폴링하면 매 요청이 서로의 엔트리를
 *   축출해 **히트율이 0%** 가 됐다(5,850 VM 집계를 폴 주기마다 사람 수만큼 반복). scope 가 다른
 *   계정이 섞여도 extraKey 가 달라 같은 현상이 났다. 이제 이름별로 최대 MAX_PER_NAME 개의 key 를
 *   LRU 로 들고 있어 사용자·필터 조합이 그 안이면 설계 의도(스냅샷당 1회 계산)대로 동작한다.
 *   엔트리 수는 (엔드포인트 42개 × MAX_PER_NAME) 로 유계이고, 값은 스냅샷이 넘어가면 교체된다.
 */
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)

// v2.503(성능 감사 P3): 기본값 12 는 **운영 vCenter 수(28, 30+ 확장 예정)보다 작다**.
// 화면 대부분이 `?vcenterId=` 로 스코프를 나누므로, 법인별로 다른 화면을 동시에 보는 사용자가
// 13명만 돼도 LRU 가 스래싱해 v2.447 이 고친 '히트율 0%' 가 그대로 되살아난다.
// 32 로 올리면 28개 vCenter + 'all' + 여유가 한 번에 들어간다. 상한은 엔드포인트 수 × 이 값이다.
// ⚠ v2.580(TUNE-C) 정정 — 여기 적혀 있던 "값은 스냅샷이 넘어가면 교체되므로 메모리는 스냅샷 1세대분" 은
// **틀렸다**. 키가 `${generatedAt}|…` 라 세대가 바뀌면 **새 키가 추가**될 뿐 옛 세대 항목은 32개가 찰 때까지
// 남았다(폴링 사용자 1명이면 30초마다 세대가 바뀌므로 16분 뒤 이름마다 32세대 응답 객체가 상주 —
// `ipam/ledger.js` 의 같은 유형을 힙 스냅샷으로 확정한 뒤 이쪽도 같은 규칙을 적용했다). 이제 새 키를 넣을 때
// **다른 세대(첫 조각이 다른) 항목을 버린다** — 같은 세대의 여러 scope 는 그대로 남고 32 상한은 백스톱이다.
// 첫 조각이 세대가 아닌 키(`anomalies|…`·`parts|…`)는 전부 한 세대로 취급되어 예전과 같다(TTL 만 적용).
export const MAX_PER_NAME = Math.max(2, Math.min(64, Number(process.env.SNAP_CACHE_PER_NAME) || 32));
const store = new Map(); // name -> Map(key -> { at, value, promise })  ※ Map 은 삽입 순서 = LRU 순서

// 세대 = 키의 첫 조각(`|` 앞). `|` 가 없는 키는 세대 개념이 없으므로(null) 세대 축출 대상이 아니다 —
// 그런 키는 예전대로 TTL + LRU 상한만 적용된다(`audit2447.test.js` T6 의 `kr`/`pl` 형 키).
const generationOf = (key) => { const s = String(key); const i = s.indexOf('|'); return i < 0 ? null : s.slice(0, i); };
/** 새 key 와 세대가 다른 항목을 버린다(진행 중 계산은 남긴다 — 합류 중인 요청이 있을 수 있다). */
function evictOtherGenerations(b, key) {
  const gen = generationOf(key);
  if (gen == null) return;
  for (const [k, e] of b) { const g = generationOf(k); if (g != null && g !== gen && !e?.promise) b.delete(k); }
}
/** 테스트·진단용 — 이름별 항목 수와 세대 수. */
export function _snapCacheStats(name) {
  const b = store.get(name) || new Map();
  return { entries: b.size, generations: new Set([...b.keys()].map(generationOf)).size };
}

function bucket(name) {
  let b = store.get(name);
  if (!b) { b = new Map(); store.set(name, b); }
  return b;
}

/** 접근한 key 를 맨 뒤로 보내 LRU 순서를 유지하고, 상한 초과분(가장 오래 안 쓴 것)을 버린다. */
function touch(b, key, entry) {
  b.delete(key);
  b.set(key, entry);
  while (b.size > MAX_PER_NAME) {
    const oldest = b.keys().next().value;
    const e = b.get(oldest);
    if (e?.promise) break;          // 진행 중 계산은 버리지 않는다(합류 중인 요청이 있을 수 있다)
    b.delete(oldest);
  }
}

/**
 * @param name    캐시 이름(엔드포인트별 고유)
 * @param key     무효화 키(스냅샷 리비전 + 파라미터)
 * @param ttlMs   값 유효시간(백스톱)
 * @param compute async () => value
 */
export async function snapMemo(name, key, ttlMs, compute) {
  const now = Date.now();
  const b = bucket(name);
  const cur = b.get(key);
  if (cur) {
    // v2.447(감사 B14): 'has' 플래그로 값 유무를 판정한다 — undefined 를 '값 없음'과 '계산 중'의
    // 겸용 센티널로 쓰면 compute() 가 정상적으로 undefined 를 돌려주는 순간 영구 캐시 미스가 된다.
    if (cur.has && (now - cur.at) < ttlMs) { touch(b, key, cur); return cur.value; }
    if (cur.promise) return cur.promise;                                     // 진행 중 계산에 합류
  }
  const promise = (async () => {
    // v2.498: 집계 계산 중 루프가 막히면 hang 기록에 'memo:<이름>' 으로 남는다(계측 전용).
    const value = await withJob(`memo:${name}`, compute);
    // 이 계산이 끝났을 때 이미 다른 계산이 이 key 를 차지했으면 덮어쓰지 않는다 — 덮어쓰면
    // 그쪽 in-flight promise 가 사라져 후속 요청이 다시 재계산한다(single-flight 붕괴).
    const s = b.get(key);
    if (!s || s.promise === promise) touch(b, key, { at: Date.now(), value, has: true, promise: null });
    return value;
  })();
  // 진행 중 표시(같은 key 동시 요청이 위에서 promise 에 합류). 이전 값은 있으면 임시 보존.
  evictOtherGenerations(b, key); // v2.580(TUNE-C)
  touch(b, key, { at: now, value: cur ? cur.value : undefined, has: !!cur?.has, promise });
  try {
    return await promise;
  } catch (e) {
    const s = b.get(key);
    if (s && s.promise === promise) b.delete(key);   // 실패한 계산은 캐시에 남기지 않음
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

/** 진단용 — 이름별 보관 중인 key 수(운영 문제 추적 시 사용). */
export function snapCacheStats() {
  return [...store].map(([name, b]) => ({ name, keys: b.size }));
}
