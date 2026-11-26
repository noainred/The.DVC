/**
 * cvp/heavyGate.js — 무거운 CVP 조회의 동시 상한 + 같은 조회 합류(v3.42 버그 점검 2회차 A4-F5 → 3회차 다시 설계).
 *
 * 링크 품질 · 회수 · 예측 · GBIC 추세 · 토폴로지 · 이중화 · 전후 비교 · 전 스위치 여유는 요청마다 수백 ms 계산과 수백 MB 메모리를 쓴다.
 * 동시에 여러 건이 오면 정지 · 메모리가 요청 수만큼 쌓였다(실측: 동시 4건 최장 정지 1.17~1.69초 · GBIC 추세 3건 힙 875MB).
 *
 * 3회차가 찾은 2회차 판(전역 한 줄 · 동시 1 · 대기 8 · 미들웨어)의 결함과 이 판의 답:
 *  · 같은 조회가 합류하지 않아 3건이 4.1 / 8.4 / 12.5초 → **같은 키(라우트 · 관리자 판본 여부 · 질의)는 계산 하나를 함께 기다린다**.
 *  · 가벼운 조회(위치 찾기)가 무거운 조회 뒤에서 0.4 → 4.5초 → 위치 찾기는 여기 넣지 않는다 · 동시 HEAVY_MAX 건.
 *  · 한 계정이 줄을 채워 다른 사용자가 503 → **계정당 HEAVY_PER_USER_MAX 건**(기다리는 서로 다른 조회 수).
 *  · 줄에서 끊긴 요청이 줄 칸을 차지 → 기다리는 요청이 하나도 없는 조회는 **줄에서 바로 뺀다**(돌기 시작한 계산은 끝까지 — 취소할 수 없다).
 *  · 형식 검증(400 · 404)이 상한 뒤 → 처리기가 검증을 마친 뒤 `heavyJson` 을 부른다.
 *  · 자리 반환이 res.end 덮어쓰기 + 120초 시한 → 계산 함수의 **finally** 에서 돌려준다(던져도 돌려준다 — 영구 잠금 없음).
 *  · 줄이 차면 503(웹이 '업그레이드 중' 으로 바꾸고 두 번 더 보냄) → **429 + Retry-After**(4xx 는 서버 사유가 그대로 보이고 자동 재시도가 없다).
 */
export const HEAVY_MAX = 2;
export const HEAVY_QUEUE_MAX = 16;
export const HEAVY_PER_USER_MAX = 3;
export const HEAVY_RETRY_AFTER_S = 5;

let running = 0;
const queue = [];            // 차례를 기다리는 조회(flight)
const flights = new Map();   // key → { key, compute, state:'queued'|'running'|'done', promise, resolve, reject, users:Map<user,n>, waiters }

function pump() {
  while (running < HEAVY_MAX && queue.length) {
    const f = queue.shift();
    if (f.state !== 'queued') continue;
    f.state = 'running'; running++;
    Promise.resolve().then(() => f.compute()).then(f.resolve, f.reject).finally(() => {
      f.state = 'done'; running = Math.max(0, running - 1);
      if (flights.get(f.key) === f) flights.delete(f.key);
      pump();
    });
  }
}
function userLoad(user) { let n = 0; for (const f of flights.values()) if (f.users.has(user)) n++; return n; }
function busy(res, reason) {
  res.set('Retry-After', String(HEAVY_RETRY_AFTER_S));
  res.status(429).json({ ok: false, busy: true, reason });
}

/** 조회 키 — 라우트 이름 + 관리자 판본 여부 + 값들(글자로). 값이 같으면 같은 계산이다. */
export function heavyKey(name, admin, ...parts) {
  return [name, admin ? 'a' : 'u', ...parts.map((p) => (p == null ? '' : String(p).slice(0, 200)))].join('\u0000');
}

/**
 * 무거운 계산을 상한 안에서 돌리고 응답한다. compute() → { status?:number, body:any } (응답 객체에 손대지 않는다 — 여러 요청이 같은 결과를 받는다).
 * 줄이 찼거나 이 계정의 조회가 많으면 429 로 응답하고 끝낸다. 기다리는 사이 연결이 끊기면 응답하지 않는다.
 */
export async function heavyJson(req, res, key, compute) {
  const user = String(req.user?.username ?? '');
  let f = flights.get(key);
  if (!f) {
    if (userLoad(user) >= HEAVY_PER_USER_MAX) return busy(res, '이 계정의 무거운 CVP 조회가 이미 여러 건 진행 중입니다 — 끝난 뒤 다시 시도하세요.');
    if (running >= HEAVY_MAX && queue.length >= HEAVY_QUEUE_MAX) return busy(res, '무거운 CVP 조회가 많이 밀려 있습니다 — 잠시 뒤 다시 시도하세요.');
    f = { key, compute, state: 'queued', users: new Map(), waiters: 0 };
    f.promise = new Promise((resolve, reject) => { f.resolve = resolve; f.reject = reject; });
    f.promise.catch(() => {});   // 기다리는 요청이 없을 때 처리 안 된 거부가 되지 않게(기다리는 쪽은 아래 await 에서 받는다)
    flights.set(key, f); queue.push(f);
  }
  f.waiters++; f.users.set(user, (f.users.get(user) || 0) + 1);
  let gone = false; let left = false;
  const leave = () => {
    if (left) return; left = true;
    f.waiters--;
    const n = (f.users.get(user) || 1) - 1;
    if (n > 0) f.users.set(user, n); else f.users.delete(user);
    // 아직 줄에 있고 기다리는 요청이 없으면 줄에서 뺀다(끊긴 요청이 줄 칸을 차지하지 않게)
    if (f.waiters <= 0 && f.state === 'queued') {
      f.state = 'done';
      const i = queue.indexOf(f); if (i >= 0) queue.splice(i, 1);
      if (flights.get(key) === f) flights.delete(key);
      f.resolve(null);
    }
  };
  const onClose = () => { if (!res.writableEnded) { gone = true; leave(); } };
  res.once('close', onClose);
  pump();
  try {
    const out = await f.promise;
    if (gone || !out || res.writableEnded) return;
    res.status(out.status || 200).json(out.body);
  } finally { res.removeListener('close', onClose); leave(); }
}

/** 테스트 · 상태 확인용. */
export const heavyState = () => ({ running, queued: queue.length, flights: flights.size });
export function _resetHeavyGate() { running = 0; queue.length = 0; flights.clear(); }
