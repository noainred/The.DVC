/**
 * xferspeed/serve.js — **엣지 쪽** 전송 속도 측정 상대(v2.735). `routes/collector.js` 의 `/api/collector/xfer-test` 가 부른다.
 *
 * 중앙이 같은 수집 URL·같은 토큰(`X-Collector-Token`)으로 두 방향을 잰다 — 새 네트워크 허용이 필요 없다(v2.549 규약):
 *   · GET  `?bytes=N` → 엣지가 무작위 N 바이트를 흘려 보낸다(**엣지 → 메인**). 중앙이 받는 시간을 잰다.
 *   · POST `?bytes=N` → 중앙이 보낸 본문을 세기만 하고 버린다(**메인 → 엣지**). 엣지가 첫 바이트부터 마지막 바이트까지
 *     받은 시간을 응답에 싣는다(그 구간이 실제 전송이다 — 연결·요청 머리는 빠진다).
 *
 * 규약:
 *  · **무작위 데이터**다 — 0 으로 채우면 회선의 압축·중복 제거 장비(WAN 가속기)가 줄여 보내 속도가 부풀려진다.
 *    `crypto.randomBytes` 를 비동기(스레드 풀)로 조각마다 만든다(이벤트 루프를 막지 않는다).
 *  · 상한 `XFER_TEST_MAX_BYTES`(기본 64MB) · 동시 2건 — 토큰을 가진 쪽만 부르지만 회선·메모리를 지킨다.
 *  · 저장하지 않는다 — 받은 바이트는 세고 버린다(디스크·메모리에 남지 않는다).
 *  · 현장에서 끄려면 엣지 portal.env `XFER_TEST_ENABLED=false` — 404 + 사유로 답해 중앙이 '엣지에서 꺼짐' 으로 말한다
 *    (구버전 엣지의 express 기본 404 HTML 과 본문으로 갈린다 — central/edgePull.js kindFor404 와 같은 판정).
 */
import crypto from 'node:crypto';
import { config, currentVersion } from '../config.js';
import { waitDrain } from '../util/waitDrain.js'; // v2.783(점검 Q5): 공용 백프레셔 대기(drain·close·error 중 먼저 — 리스너 전부 뗀다)

export const XFER_TEST_MAX_BYTES = Math.max(1_048_576, Number(process.env.XFER_TEST_MAX_BYTES) || 67108864);   // 기본 64MB(리터럴 — env-doc 생성기가 첫 숫자를 기본값으로 적는다)
export const XFER_TEST_MAX_CONCURRENT = 2;
const CHUNK = 256 * 1024;

let _active = 0;

// drain 또는 close 중 먼저 오는 것을 기다린다 — 둘 다 떼고 끝낸다(조각마다 once 를 걸면 남은 쪽 리스너가 쌓인다).
// v2.783(점검 Q5): 이 지역 함수가 원형이었다 — 내보내기 라우트들이 같은 규칙을 쓰도록 util/waitDrain.js 로 옮겼다.

const randomBytesAsync = (n) => new Promise((resolve, reject) => crypto.randomBytes(n, (e, b) => (e ? reject(e) : resolve(b))));

/** 요청한 바이트 수 — 정수 1..상한만(그 밖은 null). */
export function parseBytes(v, max = XFER_TEST_MAX_BYTES) {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

export function xferTestDisabled(env = process.env) {
  return String(env.XFER_TEST_ENABLED ?? '').trim().toLowerCase() === 'false';
}

const nodeInfo = () => {
  let version = '';
  try { version = currentVersion(); } catch { /* */ }
  return { agent: String(config.agent?.name || '').slice(0, 64), version };
};

function gate(res, upload = false) {
  if (upload) res.set('Connection', 'close');   // 거절이면 본문을 읽지 않고 닫는다 — 아래 성공 경로에서 되돌린다
  if (xferTestDisabled()) {
    res.status(404).json({ ok: false, reason: '이 엣지에서 전송 속도 측정을 껐습니다(portal.env XFER_TEST_ENABLED=false).' });
    return false;
  }
  if (_active >= XFER_TEST_MAX_CONCURRENT) {
    res.status(429).json({ ok: false, reason: `이 엣지가 이미 측정 ${_active}건을 처리 중입니다 — 잠시 뒤 다시 잽니다.` });
    return false;
  }
  return true;
}

/** GET — 엣지 → 메인 방향. 무작위 N 바이트를 흘려 보낸다(Content-Length 고정). */
export async function serveXferDownload(req, res) {
  const bytes = parseBytes(req.query?.bytes);
  if (bytes == null) return res.status(400).json({ ok: false, reason: `bytes 는 1 ~ ${XFER_TEST_MAX_BYTES} 사이 정수여야 합니다.` });
  if (!gate(res)) return undefined;
  _active += 1;
  let closed = false;
  const onClose = () => { closed = true; };
  res.on('close', onClose);
  try {
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes));
    // 중간 장비·프록시가 압축하거나 저장하지 않게(무작위라 압축 이득도 없다).
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Xfer-Agent', encodeURIComponent(nodeInfo().agent));
    let left = bytes;
    while (left > 0 && !closed) {
      const n = Math.min(CHUNK, left);
      const buf = await randomBytesAsync(n);
      left -= n;
      if (!res.write(buf)) {
        await waitDrain(res);
      }
    }
    if (!closed) res.end();
  } catch {
    try { res.destroy(); } catch { /* 이미 닫힘 */ }
  } finally {
    _active -= 1;
    res.off('close', onClose);
  }
  return undefined;
}

/**
 * POST — 메인 → 엣지 방향. 본문을 세고 버린다. 응답 `{ok, bytes, recvMs, node}`.
 * `recvMs` = 첫 데이터 조각부터 마지막 조각까지(엣지 시계 하나로만 잰다 — 시계 차이가 끼지 않는다).
 */
export async function receiveXferUpload(req, res) {
  const want = parseBytes(req.query?.bytes);
  if (want == null) {
    res.set('Connection', 'close');   // 본문을 읽지 않고 연결을 닫는다(받지도 않을 수십 MB 를 흘려보내지 않게)
    return res.status(400).json({ ok: false, reason: `bytes 는 1 ~ ${XFER_TEST_MAX_BYTES} 사이 정수여야 합니다.` });
  }
  if (!gate(res, true)) return undefined;
  res.removeHeader('Connection');
  _active += 1;
  try {
    let got = 0;
    let tFirst = 0;
    let tLast = 0;
    let over = false;
    await new Promise((resolve) => {
      const done = () => { req.off('data', onData); resolve(); };
      const onData = (chunk) => {
        if (!tFirst) tFirst = performance.now();
        tLast = performance.now();
        got += chunk.length;
        // 넘친 뒤에는 받지 않는다 — 응답 뒤 연결을 닫아 남은 본문을 끊는다(계속 흘려받지 않게).
        if (got > want) { over = true; req.off('data', onData); res.set('Connection', 'close'); resolve(); }
      };
      req.on('data', onData);
      req.once('end', done);
      req.once('aborted', done);
      req.once('error', done);
      req.once('close', done);
    });
    if (over) return res.status(413).json({ ok: false, reason: `보낸 바이트가 요청한 크기(${want})를 넘습니다.` });
    const recvMs = tFirst ? Math.max(0, Math.round((tLast - tFirst) * 10) / 10) : null;
    if (res.headersSent || res.writableEnded) return undefined;
    return res.json({ ok: true, bytes: got, want, recvMs, node: nodeInfo() });
  } finally {
    _active -= 1;
  }
}

export function _resetServeForTest() { _active = 0; }
