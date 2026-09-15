/**
 * sanswitch/push.js — 엣지 → 중앙 SAN 스위치 스냅샷 push(v2.410).
 *
 * ── 포트 전송 범위(v2.517 에 '전체' 로 전환 — 사용자 요청 "전체 포트 보는 것으로 기능 개선") ──
 *
 * v2.516 까지는 **문제 포트만** 올렸다. 당시 근거는 "디렉터 1대가 512포트 × 20필드라 매 주기
 * 수 MB 를 고RTT 회선으로 밀게 된다" 였는데, 그 수치는 **압축 전 크기**였고 이 경로는 그 뒤
 * gzip 이 붙었다(`PUSH_GZIP`). 실제 포트 객체 형태로 **실측**한 값(v2.517):
 *
 *   128포트 × 4대 → 원본 204KB · gzip   6KB
 *   128포트 × 8대 → 원본 408KB · gzip  12KB
 *   768포트 × 2대 → 원본 614KB · gzip  18KB
 *
 * 포트 객체가 극도로 반복적이라 **약 34배** 압축된다. 5분 주기 12KB = 하루 3.5MB 로, 800ms RTT
 * 회선에서도 부담이 아니다. 그래서 기본을 **전체 포트**로 바꿨다 — 중앙 상세에서 정상 포트가
 * 통째로 비어 있던 것이 사용자가 실제로 불편해한 지점이다.
 *
 * ⚠ 되돌리는 길을 남겨 둘 것:
 *   · `SANSW_PUSH_PORTS=problem` — 그 엣지만 예전 동작(문제 포트만)으로 되돌린다. 회선이
 *     실제로 좁은 법인의 탈출구다. **이 환경변수를 없애지 말 것.**
 *   · **크기 가드** — 한 장비의 전체 스냅샷이 `SANSW_PUSH_DEVICE_MAX_BYTES`(기본 900KB, 중앙
 *     express.json 한도 아래)를 넘으면 그 장비만 자동으로 문제 포트로 떨어진다. 필드가 많은
 *     디렉터에서 413(= 그 법인 데이터의 조용한 전량 소실)을 만들지 않기 위한 것이다.
 *
 * ⚠ 무엇을 보냈는지 **스냅샷이 스스로 밝힌다**(`ports.portsScope` = 'full' | 'problem',
 *   `portsOmitted`, `portsScopeReason`). 화면은 이 값으로 배너를 고른다 — 구버전 엣지는 계속
 *   문제 포트만 보내므로(필드 없음) '전체를 받았다' 고 단정하면 거짓이 된다.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { localSnapshots } from './store.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';

export const pushMs = () => Math.max(60_000, Number(process.env.SANSW_PUSH_MS) || 5 * 60_000);
/** 중앙으로 올릴 포트 상한 — 문제 포트 우선. */
const PUSH_PORT_LIMIT = Math.max(0, Number(process.env.SANSW_PUSH_PORT_LIMIT) || 64);
const gzipAsync = promisify(zlib.gzip);
// 요청당 JSON 상한(압축 전, v2.417) — 중앙 express.json 한도(1MB, 해제 후 길이)보다 넉넉히 아래.
// 문제 포트 64개 × ~625B ≈ 40KB/장비라 스위치 ~25대면 1MB 를 넘겨 413 으로 전량 실패했다(리뷰 확정).
const PUSH_CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.SANSW_PUSH_CHUNK_BYTES) || 700 * 1024);
const PUSH_GZIP = process.env.SANSW_PUSH_GZIP !== 'false';
/**
 * 포트 전송 범위(v2.517). 기본 `full`. `problem` 이면 예전 동작(문제 포트만) — 회선이 좁은
 * 법인의 탈출구다. 알 수 없는 값은 기본(full)으로 본다(오타가 조용히 축약으로 떨어지지 않게).
 */
export const portsScopeSetting = () => (String(process.env.SANSW_PUSH_PORTS || '').toLowerCase() === 'problem' ? 'problem' : 'full');
/** 장비 1대의 전체 스냅샷 상한(압축 전). 넘으면 그 장비만 문제 포트로 떨어진다(413 방지). */
const DEVICE_MAX_BYTES = Math.max(128 * 1024, Number(process.env.SANSW_PUSH_DEVICE_MAX_BYTES) || 900 * 1024);

/** 장비 목록을 JSON 크기 기준으로 나눈다(순수). 한 장비가 상한을 넘어도 단독 청크로 보낸다. */
export function chunkDevices(devices, maxBytes = PUSH_CHUNK_BYTES) {
  const chunks = []; let cur = []; let size = 0;
  for (const d of devices) {
    const n = Buffer.byteLength(JSON.stringify(d));
    if (cur.length && size + n > maxBytes) { chunks.push(cur); cur = []; size = 0; }
    cur.push(d); size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

let _timer = null;
let _busy = false;
let _last = null;

/** 중앙 전송용 축약(순수 — 테스트가 고정한다). 문제 포트를 우선 남긴다. */
export function slimSnapshot(snap, limit = PUSH_PORT_LIMIT) {
  const list = snap?.ports?.list || [];
  const problem = (p) => p.state === 'faulty' || p.state === 'disabled'
    || (p.errCrc || 0) > 0 || (p.errLinkFail || 0) > 0 || (p.errLossSync || 0) > 0
    || (p.rxPowerDbm != null && p.rxPowerDbm < -9);
  const kept = list.filter(problem).slice(0, limit);
  return {
    ...snap,
    // portsScope(v2.517): 화면이 '무엇을 받았는지' 를 추측하지 않게 스냅샷이 밝힌다.
    ports: { ...snap.ports, list: kept, portsOmitted: Math.max(0, list.length - kept.length), portsScope: 'problem' },
  };
}

/** 전체 포트를 그대로 싣는다(v2.517 기본). 뺀 것이 없으므로 portsOmitted 는 0 이다. */
export function fullSnapshot(snap) {
  const list = snap?.ports?.list || [];
  return { ...snap, ports: { ...snap.ports, list, portsOmitted: 0, portsScope: 'full' } };
}

/**
 * 전송 범위 결정(순수 — 테스트가 고정한다).
 *
 * `scope='problem'` 이면 축약. 아니면 전체를 쓰되, 한 장비가 `maxBytes` 를 넘으면 **그 장비만**
 * 축약으로 떨어지고 사유를 남긴다 — 조용히 줄이면 화면이 '전체를 받았다' 고 거짓말한다.
 */
export function scopeSnapshot(snap, { scope = 'full', maxBytes = DEVICE_MAX_BYTES, limit = PUSH_PORT_LIMIT } = {}) {
  if (scope === 'problem') return slimSnapshot(snap, limit);
  const full = fullSnapshot(snap);
  const size = Buffer.byteLength(JSON.stringify(full));
  if (size <= maxBytes) return full;
  const slim = slimSnapshot(snap, limit);
  return {
    ...slim,
    ports: {
      ...slim.ports,
      portsScopeReason: `전체 포트가 1회 전송 상한(${Math.round(maxBytes / 1024)}KB)을 넘어(${Math.round(size / 1024)}KB) 문제 포트만 보냈습니다`,
    },
  };
}

export async function pushSanSwitchNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' };
  _busy = true;
  try {
    const scope = portsScopeSetting();
    const devices = localSnapshots().map((s) => scopeSnapshot(s, { scope }));
    if (!devices.length) { _last = { at: Date.now(), sent: 0 }; return { ok: true, sent: 0 }; }
    // 청크 전송(chunk/chunks 필드): 첫 청크는 중앙의 내 목록을 교체, 이후 청크는 덧붙인다(중앙 sanSwitchEdge).
    const chunks = chunkDevices(devices);
    let bytes = 0, gzBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      const json = Buffer.from(JSON.stringify({ agent: config.agent.name, devices: chunks[i], chunk: i, chunks: chunks.length }));
      let body = json;
      const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
      if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
      bytes += json.length; gzBytes += body.length;
      const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-data`, {
        method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2,
      });
      if (!res.ok) throw new Error(`sanswitch-data <- ${res.status} (청크 ${i + 1}/${chunks.length})`);
    }
    // 범위·크기를 상태에 남긴다 — '전체로 바꿨는데 회선이 버티나' 를 수치로 확인할 수 있게.
    const downgraded = devices.filter((d) => d.ports?.portsScopeReason).length;
    _last = { at: Date.now(), sent: devices.length, chunks: chunks.length, bytes, gzBytes, gzip: PUSH_GZIP, portsScope: scope, downgraded };
    return { ok: true, sent: devices.length, chunks: chunks.length, portsScope: scope, downgraded };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
  finally { _busy = false; }
}

export function startSanSwitchPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushSanSwitchNow(), { firstDelayMs: 55_000, name: 'SAN 스위치 push' });
}
export function sanSwitchPushStatus() { return { ..._last, intervalMs: pushMs(), portsScope: portsScopeSetting() }; }
