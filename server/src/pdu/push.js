/**
 * pdu/push.js — 엣지 → 중앙 PDU 스냅샷 전송.
 *
 * storage/push.js 와 같은 축. 자격증명은 절대 싣지 않는다(스냅샷은 측정값만).
 * 페이로드가 커질 수 있어(PDU 4대 × 뱅크 12 × 센서 N) 장비 수 상한을 두고, 중앙의
 * express.json 한도 아래로 유지한다.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { localSnapshots } from './poller.js';
import { pushMs, startAdaptiveTimer } from './intervals.js';

const gzipAsync = promisify(zlib.gzip);
// v2.503: gzip 전송(SAN push v2.417·storage push 와 같은 규약) — 고RTT 회선에서 전송 시간을 줄인다.
// 중앙 express.json 은 Content-Encoding: gzip 을 투명하게 푼다.
const PUSH_GZIP = process.env.PDU_PUSH_GZIP !== 'false';

let _timer = null;
let _last = { at: null, ok: false, count: 0, reason: '' };

// v2.597(감사 L2597-04 — 재현): 재진입 가드 — 타이머 push 와 설정 pull 뒤 push 가 겹치면 늦게 끝난 옛 본문이 새 본문을
// 덮을 수 있다(storage/push.js 와 같은 규약). 진행 중에 들어온 요청은 끝난 뒤 한 번 더 보낸다(새 수집분을 놓치지 않게).
let _busy = null;
let _again = false;
export async function pushPduNow() {
  if (_busy) { _again = true; return _busy; }
  _busy = (async () => {
    let r;
    do { _again = false; r = await pushPduOnce(); } while (_again);
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}
async function pushPduOnce() {
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    return { ok: false, reason: 'push 비활성화(CENTRAL_URL/CENTRAL_TOKEN 미설정)' };
  }
  const snapshots = localSnapshots().slice(0, 500);
  if (!snapshots.length) {
    // v2.583 감사 #13: 위임 PDU 가 **정말 0대**일 때만 빈 목록을 보내 중앙 보관분을 비운다(장비를 뺀 법인의 유령 PDU).
    //   위임 장비는 있는데 스냅샷이 아직 없으면(재기동 직후) 보내지 않는다 — 빈 목록으로 덮으면 중앙 화면이 빈다.
    let assigned = null;
    try { const { devicesForThisNode } = await import('./registry.js'); assigned = devicesForThisNode().length; } catch { /* 등록부를 못 읽음 — 비우지 않는다 */ }
    if (assigned !== 0) {
      _last = { at: Date.now(), ok: true, count: 0, reason: assigned == null ? '등록부를 읽지 못해 보내지 않았습니다' : `위임 PDU ${assigned}대 — 아직 수집된 스냅샷이 없습니다(첫 수집 대기)` };
      return { ok: true, count: 0 };
    }
  }
  try {
    const json = JSON.stringify({ agent: config.agent.name, snapshots });
    const hdrs = { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken };
    let body = json;
    if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/pdu-data`, {
      method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2,
    });
    const ok = res.ok;
    // 413 은 재시도 대상이 아니다(resilientFetch RETRYABLE_STATUS 에 없다) — 조용히 버리면 그 법인
    // PDU 데이터가 통째로 사라진다. 원인을 알 수 있게 크기와 함께 남긴다(v2.503).
    if (res.status === 413) {
      console.warn(`[pdu-push] 중앙이 본문 크기를 거부(413). 스냅샷 ${snapshots.length}건 · JSON ${Math.round(json.length / 1024)}KB — 중앙의 JSON_BODY_LIMIT 을 확인하세요.`);
    }
    _last = { at: Date.now(), ok, count: snapshots.length, bytes: json.length, reason: ok ? (snapshots.length ? '' : '위임 PDU 0대 — 중앙 목록을 비웠습니다') : `HTTP ${res.status}` };
    if (!ok && res.status !== 413) console.warn(`[pdu-push] 실패: HTTP ${res.status}`); // v2.583(카탈로그 N2) — 413 은 위에서 크기와 함께 찍었다
    return { ok, count: snapshots.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, count: 0, reason: e.message };
    console.warn(`[pdu-push] 실패: ${e.message}`); // v2.583(카탈로그 N2)
    return { ok: false, reason: e.message };
  }
}

export function startPduPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushPduNow(), { firstDelayMs: 75_000, name: 'pdu-push' });
  console.log(`[pdu-push] started (interval=${Math.round(pushMs() / 1000)}s)`);
}

export function pduPushStatus() { return { ..._last, intervalMs: pushMs() }; }
