/**
 * util/waitDrain.js — 쓰기 백프레셔 대기 공용(v2.783 점검 Q5 — O-B4 · 형제 스윕).
 *
 * `stream.write()` 가 false 를 돌려준 뒤 'drain' 을 기다린다. **연결이 끊기면(close·error) 기다림을 끝낸다.**
 *
 * 왜 공용인가(되돌리지 말 것):
 *  ⓐ `res.once('drain', r)` 만 기다리면 백프레셔 중 클라이언트가 끊었을 때 drain 이 영원히 오지 않는다 —
 *     핸들러가 멈추고, 그 핸들러가 `acquireExport` 잠금을 finally 에서 푸는 경로(GPU 시계열 내보내기)는
 *     **재기동 전까지 409 로 잠겼다**(v2.782 이전 hardwareGpu.js CSV·JSON, checksLogs.js vclogs CSV).
 *  ⓑ `res.once('drain', ok); res.once('close', ok)` 처럼 조각마다 둘 다 걸면 먼저 오지 않은 쪽 리스너가 남아
 *     쌓인다(xferSpeed CSV 2.2만 행 이상에서 'close' 리스너 11개 → MaxListenersExceededWarning).
 *  → 먼저 오는 쪽 하나로 끝내고 **건 리스너를 전부 뗀다**(xferspeed/serve.js 의 지역 waitDrain 이 원형).
 *
 * 돌려주는 값: true = drain(계속 써도 된다) · false = 끊김·오류·이미 닫힘(**호출자는 쓰기를 멈추고 빠져나간다** —
 *   그래야 finally 의 잠금 해제가 돈다).
 *
 * @param {import('node:stream').Writable} stream  drain 을 기다릴 쓰기 스트림(res 또는 res 로 pipe 된 gzip 등)
 * @param {import('node:stream').Writable} [closeOn]  끊김을 볼 대상(기본 = stream). gzip→res 파이프면 res 를 준다.
 * @returns {Promise<boolean>}
 */
export function waitDrain(stream, closeOn = stream) {
  const targets = closeOn && closeOn !== stream ? [stream, closeOn] : [stream];
  if (targets.some((s) => !s || s.destroyed || s.closed === true)) return Promise.resolve(false);
  // 이미 비워졌다(write 가 false 를 준 뒤 같은 틱에 drain 이 지나갈 수는 없지만, 호출자가 write 없이 부를 때를 위해).
  if (stream.writableNeedDrain === false) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      stream.off('drain', onDrain);
      for (const s of targets) { s.off('close', onGone); s.off('error', onGone); }
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onGone = () => done(false);
    stream.on('drain', onDrain);
    for (const s of targets) { s.on('close', onGone); s.on('error', onGone); }
  });
}
