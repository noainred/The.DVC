/**
 * cvp/heavyGate.js — 무거운 CVP 조회의 동시 상한 + 같은 조회 합류(v3.42 버그 점검 2회차 A4-F5 → 3회차 다시 설계 → 3회차 반증 보강).
 *
 * 링크 품질 · 회수 · 예측 · GBIC 추세 · 토폴로지 · 이중화 · 전후 비교 · 전 스위치 여유는 요청마다 수백 ms 계산과 수백 MB 메모리를 쓴다.
 * 동시에 여러 건이 오면 정지 · 메모리가 요청 수만큼 쌓였다(실측: 동시 4건 최장 정지 1.17~1.69초 · GBIC 추세 3건 힙 875MB).
 *
 * 규칙:
 *  · **같은 키(라우트 · 관리자 판본 여부 · 값)는 계산 하나를 함께 기다린다**(2회차 판은 합류하지 않아 3건이 4.1 / 8.4 / 12.5초).
 *  · 줄(lane)마다 동시 상한: 'heavy' HEAVY_MAX 건 · 'light'(위치 찾기) LIGHT_MAX 건 — 가벼운 조회가 무거운 조회 뒤에서 기다리지 않고(0.4 → 4.5초),
 *    그렇다고 상한 없이 겹쳐 돌지도 않는다(3회차 반증 R1: 줄 밖으로 뺀 위치 찾기 12건이 정지 0.7초).
 *  · 기다리는 요청이 하나도 없는 조회: 줄에 있으면 **바로 뺀다** · 돌고 있으면 계산이 **다음 확인 지점에서 멈춘다**(ctx.check() · ctx.stop —
 *    3회차 반증 R2: 탭을 넘기며 취소한 계산이 끝까지 돌아 마지막 탭이 3.3~4.7초 기다렸다). 멈추기로 한 순간 합류 표에서 지워 새 요청이 죽은 계산에 붙지 않는다.
 *  · 동시에 기다리는 조회 수로는 거절하지 않는다(3회차 반증 R11: 줄이 비어도 4번째 조회를 429 로 돌려 공용 계정 · 인증 꺼짐에서 정상 사용이 거절됐다) —
 *    대신 아래 '시작 횟수' 와 '공평한 차례' 로 한 계정이 줄을 독차지하지 못하게 한다.
 *  · 자리는 계산의 finally 에서 돌려준다(던져도 돌려준다 — 영구 잠금 없음). 형식 검증(400 · 404)은 처리기가 이 함수를 부르기 전에 한다.
 *  · 계정마다 **새 계산을 시작하는 횟수**에 상한(START_BURST 건을 모아 쓰고 START_REFILL_MS 마다 1건 회복 — 4회차 A3-F1: 한 계정이 '보내고 60ms 뒤 끊기' 를
 *    초당 16건 되풀이하면 끊긴 계산의 첫 구간(baseOf 약 0.17초)만으로 자리 둘이 내내 차고 포탈 전체의 새 연결 수락이 밀렸다 — 지연 중앙값 5초).
 *    돌고 있는 계산에 합류하는 것은 세지 않는다. 계정 이름이 없으면(인증 꺼짐 — 모두가 한 계정) 4배.
 *  · 차례는 **계정 간 공평하게** — 줄에서 다음 계산을 고를 때 지금 돌고 있는 계산이 가장 적은 계정의 것부터(4회차 A3-F2: 한 계정이 실행 2 + 대기 8 을 채우면
 *    다른 사용자의 0.2초 조회가 15초 걸렸다). 한 계정이 줄의 절반 넘게 차지하지 못한다.
 *  · 계산은 **다음 매크로태스크에서** 시작한다(4회차 A4-F1: 양보 없이 끝나는 짧은 계산이 마이크로태스크로 이어 붙어 12건이 한 덩어리로 돌았다 — 합류도 안 됐다).
 *  · 줄이 차면 **429 + Retry-After**. 503 이면 웹 공용 오류 상자가 '업그레이드 중' 으로 바꾼다. 웹은 이 조회들을 `fetchHeavy`(자동 재시도 0)로 부른다 —
 *    공용 fetchJson 기본값은 429 도 두 번 더 보내므로(api.js isTransientFront) 다른 호출자는 재시도를 꺼야 한다.
 */
import crypto from 'node:crypto';

export const HEAVY_MAX = 2;
export const LIGHT_MAX = 2;
export const HEAVY_QUEUE_MAX = 16;
export const HEAVY_RETRY_AFTER_S = 5;
export const START_BURST = 12;          // 계정이 모아 쓸 수 있는 '새 계산 시작' 횟수(무거운 화면 8개 + 위치 찾기를 한 번에 다 열어도 남는다)
export const START_REFILL_MS = 1500;    // 이 간격마다 1건 회복
const ANON_FACTOR = 4;                  // 계정 이름이 없는 요청(인증 꺼짐 — 모두가 한 계정)은 4배

/** 기다리는 요청이 없어 계산을 멈출 때 던지는 표지(받는 쪽이 없다 — 로그 · 응답에 실리지 않는다). */
export class HeavyAbandoned extends Error { constructor() { super('기다리는 요청이 없어 조회를 멈췄습니다'); this.code = 'HEAVY_ABANDONED'; } }

const lanes = { heavy: { max: HEAVY_MAX, running: 0, queue: [] }, light: { max: LIGHT_MAX, running: 0, queue: [] } };
const flights = new Map();   // key → { key, lane, compute, state, promise, resolve, reject, users:Map<user,n>, waiters, owner }
const active = new Set();    // 돌고 있는 조회(합류 표에서 지워진 '멈추는 중' 포함 — 계정 몫 계산용)

/** 줄에서 다음 계산 — 지금 돌고 있는 계산이 가장 적은 계정의 것(같으면 먼저 온 것). */
function takeNext(L) {
  let best = -1; let bestLoad = Infinity;
  for (let i = 0; i < L.queue.length; i++) {
    const f = L.queue[i];
    if (f.state !== 'queued') { L.queue.splice(i, 1); i--; continue; }
    let load = 0;
    for (const a of active) if (a.lane === L && a.owner === f.owner) load++;
    if (load < bestLoad) { best = i; bestLoad = load; if (load === 0) break; }
  }
  return best < 0 ? null : L.queue.splice(best, 1)[0];
}
function pump(L) {
  while (L.running < L.max && L.queue.length) {
    const f = takeNext(L);
    if (!f) break;
    f.state = 'running'; L.running++; active.add(f);
    const drop = () => { if (flights.get(f.key) === f) flights.delete(f.key); };
    const ctx = {
      /** 기다리는 요청이 없으면 true — 그 순간 합류 표에서 지운다(새 요청은 새 계산을 시작한다). DB 조회의 stop 으로 넘긴다. */
      stop: () => { if (f.waiters > 0) return false; drop(); return true; },
      /** 계산 단계 사이에서 부른다 — 기다리는 요청이 없으면 던져서 멈춘다. */
      check() { if (ctx.stop()) throw new HeavyAbandoned(); },
    };
    // 다음 매크로태스크에서 시작한다 — 시작 전에 이미 떠났으면 돌리지 않는다(ctx.check).
    new Promise((r) => setImmediate(r)).then(() => { ctx.check(); return f.compute(ctx); }).then(f.resolve, f.reject).finally(() => {
      f.state = 'done'; L.running = Math.max(0, L.running - 1); active.delete(f); drop();
      pump(L);
    });
  }
}
/** 계정별 '새 계산 시작' 횟수 — 토큰 통. 계정 수만큼만 자란다(상한을 넘으면 가득 찬 것부터 지운다). */
const buckets = new Map();   // user → { n, at }
const BUCKETS_MAX = 5000;
function takeStart(user, now = Date.now()) {
  const cap = user ? START_BURST : START_BURST * ANON_FACTOR;
  const refill = user ? START_REFILL_MS : START_REFILL_MS / ANON_FACTOR;
  let b = buckets.get(user);
  if (!b) {
    if (buckets.size >= BUCKETS_MAX) buckets.clear();   // 계정 수 규모라 닿을 일이 드물다 — 넘으면 통째로 비운다(모두의 횟수가 다시 찬다)
    b = { n: cap, at: now }; buckets.set(user, b);
  }
  const gained = Math.floor((now - b.at) / refill);
  if (gained > 0) { b.n = Math.min(cap, b.n + gained); b.at += gained * refill; }
  if (b.n <= 0) return false;
  b.n--; return true;
}
function queuedBy(L, user) { let n = 0; for (const f of L.queue) if (f.state === 'queued' && f.owner === user) n++; return n; }
function busy(res, reason) {
  res.set('Retry-After', String(HEAVY_RETRY_AFTER_S));
  res.status(429).json({ ok: false, busy: true, reason });
}

/** 조회 키 — 라우트 이름 + 관리자 판본 여부 + 값들(글자로). 값이 같으면 같은 계산이다. */
export function heavyKey(name, admin, ...parts) {
  // 4회차 A3-F3: 값을 200자에서 자르면 앞 200자가 같은 서로 다른 요청이 같은 계산의 본문을 받았다 — 긴 값은 통째로 해시한다.
  const part = (p) => { const v = p == null ? '' : String(p); return v.length <= 200 ? v : `#${crypto.createHash('sha256').update(v).digest('hex')}`; };
  return [name, admin ? 'a' : 'u', ...parts.map(part)].join('\u0000');
}

/**
 * 무거운 계산을 상한 안에서 돌리고 응답한다. compute(ctx) → { status?:number, body:any } (응답 객체에 손대지 않는다 — 여러 요청이 같은 결과를 받는다 ·
 * 요청별 값은 계산 안에서 쓰지 말고 키에 넣는다). 줄이 찼으면 429 로 응답하고 끝낸다. 기다리는 사이 연결이 끊기면 응답하지 않는다.
 * @param {{ lane?: 'heavy'|'light' }} [opts]
 */
export async function heavyJson(req, res, key, compute, { lane = 'heavy' } = {}) {
  const L = lanes[lane] || lanes.heavy;
  const user = String(req.user?.username ?? '');
  let f = flights.get(key);
  if (!f) {
    const full = L.running >= L.max && L.queue.length >= HEAVY_QUEUE_MAX;
    if (full) return busy(res, 'CVP 조회가 많이 밀려 있습니다 — 잠시 뒤 다시 시도하세요.');
    if (queuedBy(L, user) >= HEAVY_QUEUE_MAX / 2) return busy(res, '이 계정의 CVP 조회가 이미 여러 건 줄을 서 있습니다 — 끝난 뒤 다시 시도하세요.');
    if (!takeStart(user)) return busy(res, '이 계정의 CVP 조회 요청이 너무 잦습니다 — 잠시 뒤 다시 시도하세요.');
    f = { key, lane: L, compute, state: 'queued', users: new Map(), waiters: 0, owner: user };
    f.promise = new Promise((resolve, reject) => { f.resolve = resolve; f.reject = reject; });
    f.promise.catch(() => {});   // 기다리는 요청이 없을 때 처리 안 된 거부가 되지 않게(기다리는 쪽은 아래 await 에서 받는다)
    flights.set(key, f); L.queue.push(f);
  }
  f.waiters++; f.users.set(user, (f.users.get(user) || 0) + 1);
  let gone = false; let left = false;
  const leave = () => {
    if (left) return; left = true;
    f.waiters--;
    const n = (f.users.get(user) || 1) - 1;
    if (n > 0) f.users.set(user, n); else f.users.delete(user);
    // 아직 줄에 있고 기다리는 요청이 없으면 줄에서 뺀다(끊긴 요청이 줄 칸을 차지하지 않게). 돌고 있으면 계산이 다음 확인 지점에서 스스로 멈춘다.
    if (f.waiters <= 0 && f.state === 'queued') {
      f.state = 'done';
      const i = f.lane.queue.indexOf(f); if (i >= 0) f.lane.queue.splice(i, 1);
      if (flights.get(key) === f) flights.delete(key);
      f.resolve(null);
    }
  };
  const onClose = () => { if (!res.writableEnded) { gone = true; leave(); } };
  res.once('close', onClose);
  pump(L);
  try {
    let out;
    // 떠난 요청은 계산이 멈추거나(HeavyAbandoned) 던져도 받을 사람이 없다 — 조용히 끝낸다(오류 처리기로 보내면 끊긴 연결에 500 을 쓰려 하고 로그만 남는다).
    try { out = await f.promise; } catch (e) { if (gone) return; throw e; }
    if (gone || !out || res.writableEnded) return;
    res.status(out.status || 200).json(out.body);
  } finally { res.removeListener('close', onClose); leave(); }
}

/** 테스트 · 상태 확인용. */
export const heavyState = (lane = 'heavy') => ({ running: lanes[lane].running, queued: lanes[lane].queue.length, flights: flights.size });
export function _resetHeavyGate() { for (const L of Object.values(lanes)) { L.running = 0; L.queue.length = 0; } flights.clear(); active.clear(); buckets.clear(); }
