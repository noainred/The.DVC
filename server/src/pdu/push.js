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
import { localSnapshots, pduPollerStatus } from './poller.js';
import { pushMs, startAdaptiveTimer } from './intervals.js';

const gzipAsync = promisify(zlib.gzip);
// v2.503: gzip 전송(SAN push v2.417·storage push 와 같은 규약) — 고RTT 회선에서 전송 시간을 줄인다.
// 중앙 express.json 은 Content-Encoding: gzip 을 투명하게 푼다.
const PUSH_GZIP = process.env.PDU_PUSH_GZIP !== 'false';

let _timer = null;
let _last = { at: null, ok: false, count: 0, reason: '' };
const PUSH_MAX = 500;

/** 중앙 응답의 거절 요약(v2.601 EDGE2601-04 — storage/sanswitch push 와 같은 모양. 도메인 간 import 를 피해 여기 둔다). */
async function readDropSummary(res) {
  try {
    const j = await res.json();
    if (!j || typeof j !== 'object') return null;
    const rejected = Number.isFinite(Number(j.rejected)) ? Number(j.rejected) : 0;
    return rejected > 0 ? { rejected, dropped: j.dropped && typeof j.dropped === 'object' && !Array.isArray(j.dropped) ? j.dropped : null } : null;
  } catch { return null; }
}

// v2.597(감사 L2597-04 — 재현): 재진입 가드 — 타이머 push 와 설정 pull 뒤 push 가 겹치면 늦게 끝난 옛 본문이 새 본문을
// 덮을 수 있다(storage/push.js 와 같은 규약). 진행 중에 들어온 요청은 끝난 뒤 한 번 더 보낸다(새 수집분을 놓치지 않게).
let _busy = null;
let _again = false;
let _withholdSince = null;
/** 부분 목록 보류 상한 — 첫 주기가 끝나지 않아도 이만큼 지나면 보낸다(보류에는 반드시 시한 — v2.601 규약). */
export const PDU_PUSH_WITHHOLD_MAX_MS = Math.max(60_000, Number(process.env.PDU_PUSH_WITHHOLD_MAX_MS) || 15 * 60_000);

/**
 * 이번 push 를 보류할지(순수 — v2.605 EDGE2605-01).
 *  · assignedIds null(등록부 못 읽음) + 스냅샷 0 → 보류(비우지 않는다 — v2.583 #13)
 *  · 위임 0대 → 보냄(빈 목록으로 중앙 보관분을 비운다 — 장비를 뺀 법인의 유령 PDU)
 *  · 스냅샷이 없는 위임 장비가 있고 첫 주기(pollOnce)가 아직 안 끝났으면 → 보류(시한 maxMs 까지)
 *  · 첫 주기 이후의 누락(인증 정지·추가 직후)은 보내되 개수(missing)를 밝힌다
 * 반환 { withhold, since, missing, reason }
 */
export function pduPushWithhold({ assignedIds, snapshotIds = [], firstPollDone = false, since = null, now = Date.now(), maxMs = PDU_PUSH_WITHHOLD_MAX_MS }) {
  if (assignedIds == null) {
    if (!snapshotIds.length) return { withhold: true, since: null, missing: 0, reason: '등록부를 읽지 못해 보내지 않았습니다' };
    return { withhold: false, since: null, missing: 0, reason: '' };
  }
  const have = new Set(snapshotIds);
  const missing = assignedIds.filter((id) => !have.has(id)).length;
  if (!missing) return { withhold: false, since: null, missing: 0, reason: '' };
  if (!snapshotIds.length && firstPollDone === false) {
    // v2.583 #13 과 같은 경우 — 첫 수집 대기
  }
  if (firstPollDone) return { withhold: false, since: null, missing, reason: '' };
  const s = since || now;
  if (now - s > maxMs) return { withhold: false, since: s, missing, reason: '' };
  return { withhold: true, since: s, missing, reason: `위임 PDU ${assignedIds.length}대 중 ${missing}대 — 아직 수집된 스냅샷이 없습니다(첫 수집 대기 · 일부만 보내면 중앙이 나머지를 지웁니다)` };
}
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
  // v2.601(감사 EDGE2601-04): 500대 상한은 **밝힌다**(omitted) — 예전에는 조용히 잘라 501번째부터가 중앙에 없는데 상태는 '성공' 이었다.
  const all = localSnapshots();
  const snapshots = all.slice(0, PUSH_MAX);
  const omitted = all.length - snapshots.length;
  if (omitted) console.warn(`[pdu-push] 스냅샷 ${all.length}건 중 ${omitted}건은 상한(${PUSH_MAX})으로 보내지 않았습니다.`);
  // v2.605(감사 EDGE2605-01 — 재현): 중앙 saveEdgePdu 는 이 엣지의 목록을 **통째로 교체**한다. 스냅샷은 인메모리라 재시작 직후
  //   첫 주기가 끝나기 전에는 일부 장비만 있다 — 그때 보내면 아직 수집하지 않은 장비가 중앙에서 사라졌다(0건 가드는 1건이라도
  //   있으면 통과했다). 판정은 순수 함수 pduPushWithhold 하나.
  let assigned = null;
  try { const { devicesForThisNode } = await import('./registry.js'); assigned = devicesForThisNode().map((d) => String(d.id)); } catch { /* 등록부를 못 읽음 — 비우지 않는다 */ }
  const wh = pduPushWithhold({ assignedIds: assigned, snapshotIds: all.map((x) => String(x?.id)), firstPollDone: !!pduPollerStatus()?.last?.at, since: _withholdSince, now: Date.now() });
  _withholdSince = wh.since;
  if (wh.withhold) {
    _last = { at: Date.now(), ok: true, count: 0, reason: wh.reason, withheld: true, ...(wh.missing ? { missing: wh.missing } : {}) };
    if (wh.missing) console.warn(`[pdu-push] ${wh.reason}`);
    return { ok: true, count: 0, withheld: true, reason: wh.reason };
  }
  const missingNote = wh.missing ? { missing: wh.missing } : {};
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
    // v2.601(감사 EDGE2601-04): 200 이어도 중앙이 일부를 뺐을 수 있다(소유권·형식) — 응답을 읽어 상태·콘솔에 남긴다.
    const ds = ok ? await readDropSummary(res) : null;
    if (ds?.rejected) console.warn(`[pdu-push] 중앙이 PDU ${ds.rejected}대를 받지 않았습니다(${Object.entries(ds.dropped || {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '사유 미상'}) — 그 PDU 는 중앙 화면에 나오지 않습니다`);
    const extra = { ...(omitted ? { omitted } : {}), ...(ds?.rejected ? { rejected: ds.rejected, dropped: ds.dropped } : {}), ...missingNote };
    if (ok && missingNote.missing) console.warn(`[pdu-push] 위임 PDU ${missingNote.missing}대는 스냅샷이 없어 이번 목록에 없습니다(보류 시한 초과 또는 첫 주기 이후 추가된 장비) — 중앙 화면에서 그 PDU 는 보이지 않습니다`);
    _last = { at: Date.now(), ok, count: snapshots.length, bytes: json.length, reason: ok ? (snapshots.length ? '' : '위임 PDU 0대 — 중앙 목록을 비웠습니다') : `HTTP ${res.status}`, ...extra };
    if (!ok && res.status !== 413) console.warn(`[pdu-push] 실패: HTTP ${res.status}`); // v2.583(카탈로그 N2) — 413 은 위에서 크기와 함께 찍었다
    return { ok, count: snapshots.length, ...extra };
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
