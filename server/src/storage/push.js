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
import { devicesForThisNode, registryLoadError } from './registry.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { runtimeIntervals, startAdaptiveTimer } from './intervals.js';
import { readCentralReply, dropSummaryOf, dropText } from '../util/centralReply.js'; // v2.613 EDGE2613-05: readDropSummary 사본 → 공용
import { centralStatusOnlySupport, sendStatusOnly as sendStatusOnlyTo, STATUS_ONLY_MIN_CENTRAL, _resetStatusOnlyCapForTest } from '../agent/centralStatusOnly.js'; // v2.613 EDGE2613-04: 프로브를 공용으로 승격
// 옛 import 경로 호환(audit2602a 등) — `export … from` 은 이 스코프에 이름을 만들지 않는다(v2.575).
export { centralStatusOnlySupport, STATUS_ONLY_MIN_CENTRAL, _resetStatusOnlyCapForTest };
import { agentNameHeader } from '../util/agentNameHeader.js'; // v2.620(RECENT2620-02)

// v2.409: 주기는 중앙 배포값(storage/intervals.js)을 매번 조회 — 모듈 로드 시 상수로 굳히지 않는다.
const pushMs = () => runtimeIntervals().pushMs;
const gzipAsync = promisify(zlib.gzip);
// v2.503: 본문을 gzip 으로 보낸다(SAN push v2.417 과 같은 규약). 스토리지 스냅샷은 반복이 많은
// JSON 이라 압축비가 높고, 한국↔폴란드/미국동부처럼 RTT 800ms 를 넘는 회선에서 전송 시간이
// 그대로 push 타임아웃 여유가 된다. 중앙 express.json 은 Content-Encoding: gzip 을 투명하게 푼다.
const PUSH_GZIP = process.env.STORAGE_PUSH_GZIP !== 'false';
let _timer = null;
let _busy = null;   // 진행 중인 push(프라미스)
let _again = false; // 진행 중에 들어온 요청 — 끝난 뒤 한 번 더 보낸다
let _last = null;

/**
 * v2.601(감사 EDGE2601-06): 재진입 가드는 유지하되, 진행 중에 들어온 요청을 **거절하지 않고 한 번 더 보낸다**
 *   (pdu/push.js v2.597 와 같은 규약). 예전에는 '지금 수집' 직후의 push 가 주기 push 와 겹치면 `{ok:false}` 로
 *   조용히 돌아가, 진행 중이던 push 는 **재수집 전 스냅샷**을 보냈고 새 결과는 다음 주기까지 중앙에 없었다.
 */
export async function pushStorageNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) { _again = true; return _busy; }
  _busy = (async () => {
    let r;
    do { _again = false; r = await pushStorageOnce(); } while (_again);
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

async function pushStorageOnce() {
  try {
    const devices = localSnapshots();
    if (!devices.length) {
      // v2.581(BUG-D): **0대여도 상태는 올린다**(v2.517 `sendStatusOnly` 규약 — v2.548 이 "storage/push.js:30 에는
      // 아직 '0대면 POST 안 함' 결함이 남아 있다" 고 기록해 둔 것). 예전에는 여기서 조용히 반환해 중앙은
      // '엣지가 안 보냈다' 와 '보냈는데 장비가 0대다' 를 구분할 수 없었다. 상태 전용 본문은 수백 바이트다.
      const registered = registeredCount();
      // v2.599(감사 EDGE2599-01): SAN·PDU(v2.583 #13)와 같은 규약 — 위임 장비가 **정말 0대**면 빈 목록을 보내 중앙의
      //   이 엣지 보관분을 비운다. 예전에는 상태 전용 보고만 보내 중앙이 마지막 목록을 무기한 들고 있었다(장비를 다른
      //   엣지로 옮기면 두 엣지 행이 함께 남는 유령·중복 장비). 위임은 있는데 스냅샷이 아직 없거나(재기동 직후)
      //   등록부를 못 읽으면(null) **비우지 않는다** — 빈 목록으로 덮으면 한 주기 동안 중앙 화면이 빈다(v2.581 BUG-D).
      //   비운 뒤에도 상태 보고는 보낸다 — 화면이 '위임 0대(정상)' 를 말하는 근거다(상태가 목록보다 나중이어야 보인다).
      let cleared = false, clearError = null;
      if (registered === 0) {
        const c = await sendClearList();
        cleared = c.ok; clearError = c.ok ? null : c.reason;
        if (!c.ok) console.warn(`[storage-push] 위임 0대 — 중앙 목록 비우기 실패: ${c.reason}`);
      }
      // ⚠ v2.602(감사 EDGE2602-03): 상태 전용 본문(statusOnly)은 **v2.581 이상 중앙만** 안다. v2.580 이하 중앙은 그 플래그를
      //   무시하고 devices:[] 를 이 엣지 목록의 **교체**로 받아 중앙 스토리지 목록을 비웠다(엣지가 중앙보다 먼저 올라간 현장).
      //   중앙 버전을 확인할 수 있을 때만 보내고, 모르거나 낮으면 **보내지 않고** 사유를 남긴다(SAN·PDU 는 첫 수집 대기 중
      //   아무것도 보내지 않는다 — 같은 쪽으로 실패한다). 위임 0대(registered===0)는 위에서 이미 목록을 비웠으므로 구버전
      //   중앙이 devices:[] 를 교체로 받아도 결과가 같다 — 그때는 확인하지 않는다(왕복 절약·기존 동작 유지).
      const cap = registered === 0 ? { ok: true } : await centralStatusOnlySupport({ minVersion: STATUS_ONLY_MIN_CENTRAL });
      if (!cap.ok) {
        _last = { at: Date.now(), sent: 0, statusSent: false, statusSkipped: cap.reason, centralVersion: cap.version || null,
          ...(registered === 0 ? { cleared, ...(clearError ? { clearError } : {}) } : {}) };
        console.warn(`[storage-push] 상태 보고 생략: ${cap.text}`);
        return { ok: true, sent: 0, statusSent: false, statusSkipped: cap.reason, ...(registered === 0 ? { cleared } : {}) };
      }
      // v2.618(BUG-2): 등록부를 못 읽었으면(registered null) 사유도 그렇게 말한다 — 'no-snapshots' 는 '위임은 있는데 스냅샷이 없다' 이다.
      const r = await sendStatusOnly({ reason: registered == null ? 'registry-unreadable' : 'no-snapshots', registered });
      _last = { at: Date.now(), sent: 0, statusSent: r.ok, statusError: r.ok ? null : r.reason,
        ...(registered == null ? { reason: '등록부를 읽지 못해 목록을 보내지 않았습니다(위임 0대가 아닙니다)' } : {}), // v2.621(EDGE-03)
        ...(registered === 0 ? { cleared, ...(clearError ? { clearError } : {}) } : {}) };
      if (!r.ok) console.warn(`[storage-push] 상태 보고 실패: ${r.reason}`);
      return { ok: true, sent: 0, statusSent: r.ok, ...(registered === 0 ? { cleared } : {}) };
    }
    const json = JSON.stringify({ agent: config.agent.name, devices });
    const hdrs = { 'Content-Type': 'application/json', ...agentNameHeader(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
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
    // v2.601(감사 EDGE2601-04): 200 이어도 중앙이 일부 장비를 뺐을 수 있다(소유권·형식·크기) — SAN push(v2.600)와 같이
    //   응답을 읽어 상태·콘솔에 남긴다. 예전에는 res.ok 만 봐 '보냈다' 고만 말했다(그 장비는 중앙 화면에 없다).
    const ds = dropSummaryOf(await readCentralReply(res)); // v2.613 EDGE2613-05: 공용 판독기(util/centralReply.js)
    if (ds?.rejected) console.warn(`[storage-push] 중앙이 장비 ${ds.rejected}대를 받지 않았습니다(${dropText(ds.dropped)}) — 그 장비는 중앙 화면에 나오지 않습니다`);
    _last = { at: Date.now(), sent: devices.length, bytes: json.length, gzip: PUSH_GZIP && hdrs['Content-Encoding'] === 'gzip', ...(ds?.rejected ? { rejected: ds.rejected, dropped: ds.dropped } : {}) };
    return { ok: true, sent: devices.length, ...(ds?.rejected ? { rejected: ds.rejected, dropped: ds.dropped } : {}) };
  } catch (e) {
    _last = { at: Date.now(), error: e.message };
    console.warn(`[storage-push] 실패: ${e.message}`); // v2.583(카탈로그 N2): 상태 객체만이 아니라 로그에도 — 로그 분석이 볼 수 있게
    return { ok: false, reason: e.message };
  }
}

// v2.613 EDGE2613-05: readDropSummary·dropText 는 util/centralReply.js 하나다(사본 3벌 → 1).

/**
 * 이 노드에 위임된 장비 수(상태 보고용 — 자격증명은 싣지 않는다). 등록부를 못 읽으면 null.
 * v2.621(감사 EDGE-03): 등록부 손상은 **던지지 않는다**(v2.613 registryCore — preserveCorrupt 뒤 빈 목록 + registryLoadError()).
 *   예전 catch 는 도달할 수 없어 손상 등록부가 0(= '위임 0대') 으로 읽혔고, 스냅샷 파일도 비면(신규 엣지·파일 유실) 빈 목록으로
 *   중앙의 이 엣지 보관분을 비우고 상태에는 'no-snapshots · registered:0' 이라는 틀린 사유가 남았다(CVP 는 v2.620 EDGE2620-05).
 *   손상이면 null — 비우지 않고 'registry-unreadable' 상태만 올린다. 다음 storage-config pull 이 등록부를 다시 쓰면 풀린다.
 */
function registeredCount() {
  try {
    const err = registryLoadError();
    if (err) {
      if (_regLog('registry', err.reason)) console.warn(`[storage-push] 엣지 스토리지 등록부를 읽지 못해 목록을 보내지 않습니다(${String(err.reason || '사유 미상').slice(0, 200)}) — '위임 0대' 가 아닙니다. 중앙 storage-config pull 이 등록부를 다시 쓰면 풀립니다`);
      return null;
    }
    return devicesForThisNode().length;
  } catch { return null; }
}
const _regLog = createChangeLogger({ windowMs: 60 * 60_000 });

/**
 * 위임 0대일 때 중앙 목록 비우기(v2.599 EDGE2599-01) — `statusOnly` 가 **없는** 빈 `devices` 본문이다. 중앙
 * `/storage-data` 는 그것을 이 엣지 목록의 교체로 받는다(saveEdgeStorage — 마지막 상태 보고는 보존된다).
 */
async function sendClearList() {
  try {
    const json = JSON.stringify({ agent: config.agent.name, devices: [] });
    const hdrs = { 'Content-Type': 'application/json', ...agentNameHeader(config.agent.name), 'X-Central-Token': config.agent.centralToken };
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/storage-data`, { method: 'POST', headers: hdrs, body: json, timeoutMs: 20_000, retries: 1 });
    if (!res.ok) return { ok: false, reason: `storage-data <- ${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/**
 * 상태 전용 push(v2.581) — v2.613 EDGE2613-04: 본체·버전 프로브는 agent/centralStatusOnly.js(sanswitch·pdu 와 공용).
 * 중앙은 보관 중인 장비 목록을 **건드리지 않고** 상태만 기록한다.
 */
function sendStatusOnly(status) { return sendStatusOnlyTo('/api/central/storage-data', status, { devices: [] }); }

export function startStoragePush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  // 첫 수집(15s+α) 뒤에 첫 push, 이후 현재 주기로 재무장.
  _timer = startAdaptiveTimer(pushMs, () => pushStorageNow(), { firstDelayMs: 45_000, name: '중앙 push' });
}
export function storagePushStatus() { return { ..._last, intervalMs: pushMs() }; }
