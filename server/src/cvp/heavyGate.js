/**
 * cvp/heavyGate.js — v3.42(버그 점검 2회차 A4-F5): 무거운 CVP 조회 라우트의 동시 상한(미들웨어).
 *
 * 링크 품질 · 회수 · 예측 · GBIC 추세 · 토폴로지 · 위치 찾기 · 이중화 · 전후 비교 · 전 스위치 여유는 요청마다 수백 ms 동기 계산과
 * 수백 MB 메모리를 쓴다. 동시에 여러 건이 오면 정지 · 메모리가 요청 수만큼 쌓였다(실측: 동시 4건 최장 정지 1.17~1.69초,
 * GBIC 추세 3건 힙 875MB). 한 번에 HEAVY_MAX 건만 돌리고 나머지는 줄을 세운다 — 줄이 HEAVY_QUEUE_MAX 를 넘으면 503(다시 시도).
 * 끝(응답 finish) 또는 연결 끊김(close) 때 자리를 돌려준다. 줄에서 기다리던 요청의 연결이 이미 끊겼으면 돌리지 않고 다음으로 넘긴다.
 */
export const HEAVY_MAX = 1;
export const HEAVY_QUEUE_MAX = 8;
let running = 0;
const queue = [];

function release() {
  for (;;) {
    const next = queue.shift();
    if (!next) { running = Math.max(0, running - 1); return; }
    if (next()) return;   // 다음 요청이 자리를 넘겨받았다(running 그대로)
  }
}

/** express 미들웨어. */
export function heavyGate(req, res, next) {
  const start = () => {
    if (res.writableEnded || res.destroyed || req.destroyed) return false;   // 기다리는 사이 끊긴 요청은 돌리지 않는다
    let done = false;
    const rel = () => { if (done) return; done = true; release(); };
    res.once('finish', rel); res.once('close', rel);
    next();
    return true;
  };
  if (running < HEAVY_MAX) { running++; if (!start()) release(); return; }
  if (queue.length >= HEAVY_QUEUE_MAX) {
    res.status(503).json({ ok: false, busy: true, reason: '무거운 CVP 조회가 많이 밀려 있습니다 — 잠시 뒤 다시 시도하세요.' });
    return;
  }
  queue.push(start);
}

/** 테스트 · 상태 확인용. */
export const heavyState = () => ({ running, queued: queue.length });
export function _resetHeavyGate() { running = 0; queue.length = 0; }
