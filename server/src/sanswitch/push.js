/**
 * sanswitch/push.js — 엣지 → 중앙 SAN 스위치 스냅샷 push(v2.410).
 *
 * ⚠ 포트 목록을 **그대로 올리지 않는다**. 디렉터 1대가 512포트 × 20필드라, 법인마다 몇 대씩
 *   있으면 매 주기 수 MB 를 고RTT 회선으로 밀어 올리게 된다. 중앙 목록 화면에 필요한 것은
 *   요약 + '문제 있는 포트'뿐이므로, 정상 포트는 빼고 보낸다(중앙 상세가 필요하면 그 엣지에
 *   재수집을 요청하는 기존 축을 쓴다). 무엇을 뺐는지는 portsOmitted 로 정직하게 표시한다.
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
    ports: { ...snap.ports, list: kept, portsOmitted: Math.max(0, list.length - kept.length) },
  };
}

export async function pushSanSwitchNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' };
  _busy = true;
  try {
    const devices = localSnapshots().map((s) => slimSnapshot(s));
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
    _last = { at: Date.now(), sent: devices.length, chunks: chunks.length, bytes, gzBytes, gzip: PUSH_GZIP };
    return { ok: true, sent: devices.length, chunks: chunks.length };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
  finally { _busy = false; }
}

export function startSanSwitchPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushSanSwitchNow(), { firstDelayMs: 55_000, name: 'SAN 스위치 push' });
}
export function sanSwitchPushStatus() { return { ..._last, intervalMs: pushMs() }; }
