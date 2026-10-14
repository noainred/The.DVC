/**
 * xferspeed/probe.js — **중앙 쪽** 측정기(v2.735). 엣지 하나와 한 방향을 잰다.
 *
 * ── 무엇을 재는가(화면 각주가 이 정의를 그대로 말한다) ──────────────────────
 *  · ↓ 엣지 → 메인(`down`): 중앙이 GET 으로 무작위 N 바이트를 받는다. **받는 쪽(중앙)** 이 응답 머리를 받은 순간부터
 *    마지막 바이트까지 걸린 시간 = `xferMs`. 연결·요청 왕복은 `ttfbMs`(요청 → 응답 머리)로 따로 둔다.
 *  · ↑ 메인 → 엣지(`up`): 중앙이 POST 로 무작위 N 바이트를 보낸다. **받는 쪽(엣지)** 이 첫 데이터부터 마지막 데이터까지
 *    받은 시간(`recvMs`)을 응답에 싣는다 = `xferMs`. 시계 하나로만 재므로 두 노드의 시계 차이가 끼지 않는다.
 *  · `mbps` = 받은 바이트 × 8 ÷ xferMs. 두 방향 모두 '받는 쪽에서 본 전송 구간' 이라 같은 뜻이다.
 *  · `ttfbMs`(화면 '지연') — ↓ 는 요청 → 응답 머리, ↑ 은 **전체 − 엣지 수신 구간**(응답 머리는 업로드가 끝나야 오므로 ↑ 에서
 *    '응답 시작' 은 뜻이 없다 — 2.735.1 까지 늘 비어 있었다). 둘 다 '데이터가 흐르기 전·후의 연결 + 왕복' 이다.
 *    보내는 쪽 전체 시간 기준(`sender-total`)이면 수신 구간이 LAN 구간이라 구하지 않는다(null).
 *  · ⚠ 엣지 앞에 **요청 본문을 통째로 모았다가 넘기는 프록시**(nginx proxy_request_buffering 등)가 있으면 엣지가 보는 수신
 *    구간이 LAN 구간이 되어 ↑ 값이 부풀려진다. recvMs 가 중앙 전체 시간의 25% 미만이고 전체가 1초를 넘으면 그 경우로 보고
 *    **중앙 전체 시간**으로 계산하고 `basis:'sender-total'` 로 밝힌다(조용히 고르지 않는다).
 *
 * ── 규약 ───────────────────────────────────────────────────────────────────
 *  · 재시도 0 — 다시 보내면 측정이 아니다. 실패는 원인별 `kind` 로 남긴다(`XFER_FAIL_KINDS` — 웹 문구와 1:1).
 *  · 대상·토큰은 **수집 서버 등록부**에서만(요청 본문 url·token 을 받지 않는다 — v2.480). 나가는 호출은 `withOutboundTag`.
 *  · 무작위 데이터 — 0 으로 채우면 WAN 가속기가 압축·중복 제거해 속도가 부풀려진다.
 *  · 시한(`timeoutMs`)이 본문 수신까지 덮는다(resilientFetch 의 AbortSignal 이 본문 스트림에도 걸린다). 시한에 걸리면 그때까지
 *    받은 바이트를 사유에 적는다.
 */
import crypto from 'node:crypto';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { withOutboundTag } from '../util/outboundStats.js';
import { trimTrailingSlashes } from '../util/trimSlashes.js';
import { strOf } from '../util/coercionTrap.js';
import { numOrNull } from '../util/numOrNull.js';
import { kindFor404 } from '../central/edgePull.js';

/** 측정에 쓰는 이 기능의 최소 엣지 버전 — 404(경로 없음)면 '이 버전 이상으로' 라고 말한다. */
export const MIN_XFER_EDGE_VERSION = '2.735.0';

/** 실패 종류 — 웹 `xferSpeedText.FAIL_TEXT` 와 1:1(테스트가 대조한다). */
export const XFER_FAIL_KINDS = Object.freeze([
  'no-url', 'timeout', 'unreachable', 'auth', 'disabled', 'old-version', 'busy', 'http', 'short', 'bad-body',
]);

export const DIRS = Object.freeze(['down', 'up']);

const SMALL_BODY = 64 * 1024;
const t = (v) => String(v ?? '').trim();
const randomBytesAsync = (n) => new Promise((resolve, reject) => crypto.randomBytes(n, (e, b) => (e ? reject(e) : resolve(b))));
const r1 = (v) => Math.round(v * 10) / 10;
const mb = (n) => `${(n / 1_048_576).toFixed(1)}MB`;

/** 오류 → kind(연결 단계). */
export function errKind(e) {
  const msg = [e?.name, e?.code, e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ');
  return /timeout|timed out|abort/i.test(msg) ? 'timeout' : 'unreachable';
}

/** Mbps(받은 바이트·전송 ms) — 둘 중 하나라도 0 이하·결측이면 null. */
export function mbpsOf(bytes, ms) {
  const b = numOrNull(bytes); const m = numOrNull(ms);
  if (b == null || m == null || b <= 0 || m <= 0) return null;
  return Math.round((b * 8 / (m / 1000) / 1e6) * 100) / 100;
}

/** 응답 상태 → 실패(성공이면 null). 404 는 본문으로 '엣지에서 꺼짐' 과 '구버전' 을 가른다. */
async function statusFail(res) {
  if (res.status >= 200 && res.status < 300) return null;
  let body = null;
  try { body = await readJsonCapped(res, SMALL_BODY, '엣지 응답'); } catch { body = null; }
  const why = body && typeof body === 'object' ? strOf(body.reason, 300) : '';
  if (res.status === 401 || res.status === 403) return { kind: 'auth', error: '수집 토큰이 거부됐습니다 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요.' };
  if (res.status === 404) {
    const k = kindFor404(body, { path: '/api/collector/xfer-test', minVersion: MIN_XFER_EDGE_VERSION, what: '전송 속도를 잴' });
    return { kind: k.kind, error: k.reason };
  }
  if (res.status === 429) return { kind: 'busy', error: why || '엣지가 다른 측정을 처리 중입니다.' };
  return { kind: 'http', error: `HTTP ${res.status}${why ? ` (${why})` : ''}` };
}

function baseRow(dir, bytes, startedAt) {
  return { dir, ok: false, bytes: null, want: bytes, mbps: null, xferMs: null, totalMs: null, ttfbMs: null, basis: null, kind: null, error: '', ts: startedAt };
}

/**
 * ↓ 엣지 → 메인. @param {object} col 수집 서버 등록부 항목(토큰 포함 원본)
 * @returns {Promise<object>} 측정 행(`ok`·`mbps`·`xferMs`·`ttfbMs`·`totalMs`·`kind`·`error`)
 */
export async function measureDown(col, { bytes, timeoutMs, fetchImpl = resilientFetch, now = Date.now } = {}) {
  const startedAt = now();
  const row = baseRow('down', bytes, startedAt);
  if (!t(col?.url)) return { ...row, kind: 'no-url', error: '이 수집 서버에 URL 이 없습니다.' };
  const url = `${trimTrailingSlashes(t(col.url))}/api/collector/xfer-test?bytes=${bytes}`;
  const t0 = performance.now();
  let got = 0;
  try {
    const res = await withOutboundTag(col.id || col.name, () => fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs, retries: 0,
    }));
    const tHead = performance.now();
    row.ttfbMs = Math.round(tHead - t0);
    const f = await statusFail(res);
    if (f) return { ...row, ...f, totalMs: Math.round(performance.now() - t0) };
    if (!res.body || typeof res.body.getReader !== 'function') return { ...row, kind: 'bad-body', error: '응답 본문이 없습니다.', totalMs: Math.round(performance.now() - t0) };
    const reader = res.body.getReader();
    const cap = bytes + 1_048_576;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value?.byteLength || 0;
      if (got > cap) { try { await reader.cancel(); } catch { /* */ } return { ...row, kind: 'bad-body', error: `요청한 크기보다 많이 받았습니다(${mb(got)} > ${mb(bytes)}) — 엣지가 아닌 서버에 닿았을 수 있습니다.`, totalMs: Math.round(performance.now() - t0) }; }
    }
    const tEnd = performance.now();
    row.totalMs = Math.round(tEnd - t0);
    row.bytes = got;
    if (got < bytes) return { ...row, kind: 'short', error: `받은 바이트가 모자랍니다(${mb(got)} / ${mb(bytes)}) — 전송 중 끊겼습니다.` };
    row.xferMs = r1(Math.max(1, tEnd - tHead));
    row.mbps = mbpsOf(got, row.xferMs);
    row.basis = 'receiver';
    row.ok = row.mbps != null;
    if (!row.ok) { row.kind = 'bad-body'; row.error = '전송 시간을 잴 수 없습니다.'; }
    return row;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    // 받기 시작한 뒤 연결이 끊겼으면 '닿지 않음' 이 아니라 '전송 중 끊김' 이다(조치가 다르다 — 회선 품질을 본다).
    const kind = errKind(e) === 'timeout' ? 'timeout' : got > 0 ? 'short' : 'unreachable';
    const note = got ? ` — ${kind === 'timeout' ? '시한 안에 ' : '끊기기 전까지 '}${mb(got)} / ${mb(bytes)} 만 받았습니다` : '';
    return { ...row, kind, error: `${String(e?.message || e).slice(0, 200)}${note}`, totalMs: ms, bytes: got || null };
  }
}

/**
 * ↑ 메인 → 엣지. 엣지가 돌려준 `recvMs`(받는 쪽 시간)로 계산한다. 버퍼링 프록시로 보이면 중앙 전체 시간으로(basis 표시).
 */
export async function measureUp(col, { bytes, timeoutMs, fetchImpl = resilientFetch, now = Date.now, payload = null } = {}) {
  const startedAt = now();
  const row = baseRow('up', bytes, startedAt);
  if (!t(col?.url)) return { ...row, kind: 'no-url', error: '이 수집 서버에 URL 이 없습니다.' };
  const url = `${trimTrailingSlashes(t(col.url))}/api/collector/xfer-test?bytes=${bytes}`;
  const body = payload || await randomBytesAsync(bytes);
  const t0 = performance.now();
  try {
    const res = await withOutboundTag(col.id || col.name, () => fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      body, timeoutMs, retries: 0,
    }));
    const tEnd = performance.now();
    row.totalMs = Math.round(tEnd - t0);
    const f = await statusFail(res);
    if (f) return { ...row, ...f };
    let j = null;
    try { j = await readJsonCapped(res, SMALL_BODY, '엣지 응답'); } catch { j = null; }
    if (!j || typeof j !== 'object' || j.ok !== true) return { ...row, kind: 'bad-body', error: (j && strOf(j.reason, 200)) || '응답 형식이 다릅니다(엣지가 아닌 서버에 닿았을 수 있습니다).' };
    const got = numOrNull(j.bytes);
    row.bytes = got;
    if (got == null || got < bytes) return { ...row, kind: 'short', error: `엣지가 받은 바이트가 모자랍니다(${got == null ? '?' : mb(got)} / ${mb(bytes)}) — 전송 중 끊겼습니다.` };
    const recv = numOrNull(j.recvMs);
    const buffered = recv == null || recv <= 0 || (row.totalMs > 1000 && recv < row.totalMs * 0.25);
    row.xferMs = r1(buffered ? Math.max(1, row.totalMs) : recv);
    row.basis = buffered ? 'sender-total' : 'receiver';
    row.ttfbMs = buffered ? null : Math.max(0, Math.round(row.totalMs - row.xferMs));
    row.mbps = mbpsOf(got, row.xferMs);
    row.ok = row.mbps != null;
    if (!row.ok) { row.kind = 'bad-body'; row.error = '전송 시간을 잴 수 없습니다.'; }
    return row;
  } catch (e) {
    return { ...row, kind: errKind(e), error: String(e?.message || e).slice(0, 200), totalMs: Math.round(performance.now() - t0) };
  }
}
