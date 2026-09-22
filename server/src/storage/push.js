/**
 * storage/push.js — 엣지 → 중앙 스토리지 스냅샷 push(v2.302, gpuGuestPush 패턴).
 * 이 노드가 수집한 정규화 스냅샷(자격증명 없음)을 중앙 POST /api/central/storage-data 로 밀어
 * 올린다. CENTRAL_URL/토큰 미설정(=중앙 자신)이면 스스로 기동하지 않는다.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { localSnapshots } from './store.js';
import { devicesForThisNode } from './registry.js';
import { runtimeIntervals, startAdaptiveTimer } from './intervals.js';

// v2.409: 주기는 중앙 배포값(storage/intervals.js)을 매번 조회 — 모듈 로드 시 상수로 굳히지 않는다.
const pushMs = () => runtimeIntervals().pushMs;
const gzipAsync = promisify(zlib.gzip);
// v2.503: 본문을 gzip 으로 보낸다(SAN push v2.417 과 같은 규약). 스토리지 스냅샷은 반복이 많은
// JSON 이라 압축비가 높고, 한국↔폴란드/미국동부처럼 RTT 800ms 를 넘는 회선에서 전송 시간이
// 그대로 push 타임아웃 여유가 된다. 중앙 express.json 은 Content-Encoding: gzip 을 투명하게 푼다.
const PUSH_GZIP = process.env.STORAGE_PUSH_GZIP !== 'false';
let _timer = null;
let _busy = false;
let _last = null;

export async function pushStorageNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' }; // 재진입 가드
  _busy = true;
  try {
    const devices = localSnapshots();
    if (!devices.length) {
      // v2.581(BUG-D): **0대여도 상태는 올린다**(v2.517 `sendStatusOnly` 규약 — v2.548 이 "storage/push.js:30 에는
      // 아직 '0대면 POST 안 함' 결함이 남아 있다" 고 기록해 둔 것). 예전에는 여기서 조용히 반환해 중앙은
      // '엣지가 안 보냈다' 와 '보냈는데 장비가 0대다' 를 구분할 수 없었다. 상태 전용 본문은 수백 바이트다.
      const r = await sendStatusOnly({ reason: 'no-snapshots', registered: registeredCount() });
      _last = { at: Date.now(), sent: 0, statusSent: r.ok, statusError: r.ok ? null : r.reason };
      return { ok: true, sent: 0, statusSent: r.ok };
    }
    const json = JSON.stringify({ agent: config.agent.name, devices });
    const hdrs = { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
    let body = json;
    if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/storage-data`, {
      method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2,
    });
    // 413 은 재시도 대상이 아니다(resilientFetch RETRYABLE_STATUS 에 없다) — 조용히 버리면 그 법인
    // 스토리지 데이터가 통째로 사라진다. 원인을 알 수 있게 크기와 함께 남긴다(v2.503).
    if (res.status === 413) {
      console.warn(`[storage-push] 중앙이 본문 크기를 거부(413). 장비 ${devices.length}대 · JSON ${Math.round(json.length / 1024)}KB — 중앙의 JSON_BODY_LIMIT 또는 수집 장비 수를 확인하세요.`);
    }
    if (!res.ok) throw new Error(`storage-data <- ${res.status}`);
    _last = { at: Date.now(), sent: devices.length, bytes: json.length, gzip: PUSH_GZIP && hdrs['Content-Encoding'] === 'gzip' };
    return { ok: true, sent: devices.length };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
  finally { _busy = false; }
}

/** 이 노드에 위임된 장비 수(상태 보고용 — 자격증명은 싣지 않는다). 등록부를 못 읽으면 null. */
function registeredCount() {
  try { return devicesForThisNode().length; } catch { return null; }
}

/**
 * 상태 전용 push(v2.581) — `devices: []` 에 `statusOnly:true` 를 붙인다. 중앙은 보관 중인 장비 목록을
 * **건드리지 않고** 상태만 기록한다(빈 목록으로 덮으면 엣지 재시작 직후 한 주기 동안 중앙 화면이 빈다).
 */
async function sendStatusOnly(status) {
  try {
    const json = JSON.stringify({ agent: config.agent.name, devices: [], statusOnly: true, status: { ...status, at: Date.now() } });
    const hdrs = { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken };
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/storage-data`, { method: 'POST', headers: hdrs, body: json, timeoutMs: 20_000, retries: 1 });
    if (!res.ok) return { ok: false, reason: `storage-data <- ${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export function startStoragePush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  // 첫 수집(15s+α) 뒤에 첫 push, 이후 현재 주기로 재무장.
  _timer = startAdaptiveTimer(pushMs, () => pushStorageNow(), { firstDelayMs: 45_000, name: '중앙 push' });
}
export function storagePushStatus() { return { ..._last, intervalMs: pushMs() }; }
