/**
 * veeam/push.js — 엣지 → 중앙 Veeam 결과 push(v2.751, isidu/push.js 와 같은 모양).
 *
 *  · 이 엣지 몫 서버의 마지막 결과를 통째로 보낸다(서버마다 교체 — 중앙은 그 엣지에 배정된 서버 id 만 받는다).
 *  · gzip · 재진입 가드(진행 중이면 끝난 뒤 한 번 더) · 503 은 같은 호출에서 다시 보내지 않는다(다음 주기).
 *  · **서버가 0대여도 상태를 올린다**(무음 실패 금지 — 중앙 화면이 이 엣지의 pull·폴러 상태를 알아야 한다).
 *  · 실패는 `_last` + 콘솔(같은 사유는 10분에 1줄). edgelog/spec.js 에 등재(push.veeam).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { postNo503Retry } from '../util/postNo503Retry.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { readJsonCapped } from '../util/readCapped.js';
import { classifyCentral404Body } from '../agent/central404.js';
import { agentNameHeader } from '../util/agentNameHeader.js';
import { serversForThisNode, registryLoadError } from './registry.js';
import { summarizeRegistryError } from '../util/registryCore.js';
import { getRecord } from './store.js';
import { veeamPollerStatus, onVeeamCollected, pollMs } from './poller.js';
import { store } from '../store.js';
import { getLogsDb } from '../logs/db.js';
import { loadLogSettings } from '../logs/settings.js';
import { eventNotCollectedMap } from '../logs/coverage.js';
import { edgeSnapPayload } from './snapEvents.js';
import { getSnapDb } from './snapDb.js';
import { logPollerRanOnce } from '../logs/poller.js';
import { snapEventsOkAt } from './snapCollector.js';   // v2.765: 로그 폴러·Veeam 계정 전용 수집기 중 늦은 완결 시각(결합 함수 하나 — 라우트와 같다)

const gzipAsync = promisify(zlib.gzip);
const failLog = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null; let _busy = null; let _again = false; let _last = null;

export function buildPushBody() {
  const servers = serversForThisNode();
  const results = [];
  for (const d of servers) {
    const rec = getRecord(d.id);
    if (rec?.result) results.push({ serverId: d.id, ...rec.result });
  }
  const p = veeamPollerStatus();
  return {
    agent: config.agent.name,
    status: { servers: servers.length, poller: { at: p.at ?? null, ok: p.ok ?? null, fail: p.fail ?? null, intervalMs: p.intervalMs, running: !!p.running }, version: currentVersion() || null },
    results,
  };
}

/** v2.754: 이 엣지가 직접 이벤트를 모으는 vCenter 의 'Veeam 계정 스냅샷 생성' 요약(veeam/snapEvents.js). 실패해도 결과 push 는 보낸다. */
async function snapEventsForPush() {
  try {
    // v2.761(C2): 이벤트 수집 신선도(마지막 온전한 수집 시각 · 폴러가 한 주기를 끝냈는가)도 싣는다 — 중앙이 6시간 판정·'아직 못 모음' 을 한다.
    // v2.765: collectedAt 은 로그 폴러와 Veeam 계정 전용 수집기 중 늦은 것(snapEventsOkAt). 전용 DB 가 없으면(로그 DB 경로) 전용 수집기 값은 섞지 않는다.
    //   push 필드는 그대로다(edgeSnapPayload 의 collectedAt 값만 바뀐다 — 중앙 sanitizeEdgeSnap 계약 변경 없음).
    //   v2.766(점검 R1-A1-1): 요약(sum — 판정이 Veeam 으로 본 계정)을 넘겨, 전용 수집기가 그 계정을 다 덮을 때만 그 시각을 섞는다. 필드는 그대로.
    const snapDb = await getSnapDb();
    return { list: await edgeSnapPayload({ db: await getLogsDb(), snap: store.get(), notCollected: eventNotCollectedMap(), logSettings: loadLogSettings(), snapDb,
      collectedAtFor: (vc, sum) => snapEventsOkAt(vc, { dedicated: !!snapDb, summary: sum }), collectRan: logPollerRanOnce() }) };
  } catch (e) {
    if (failLog('snap', String(e?.message || e))) console.warn(`[veeam-push] vCenter 이벤트 요약을 만들지 못했습니다(결과는 그대로 보냅니다): ${String(e?.message || e).slice(0, 200)}`);
    return { list: null, error: String(e?.message || e).slice(0, 200) };
  }
}

/** v2.763(V2-I1): 엣지 Veeam 등록부를 못 읽었는가(손상 → 보존 뒤 빈 목록). cvp/push.js edgeRegistryError 와 같다. */
function edgeRegistryError() {
  try { return registryLoadError(); } catch (e) { return { at: Date.now(), reason: e?.message || String(e) }; }
}

async function pushInner() {
  // v2.763(V2-I1): 등록부를 못 읽으면 serversForThisNode() 가 [] 라 '맡은 서버 0대' 를 보고했다 — 보내지 않는다(형제 push 와 같다).
  //   중앙 결과는 서버별 교체라 지워지지 않고, 다음 veeam-config pull 이 등록부를 다시 쓰면 풀린다. 사유는 요약만(원문은 파일 조각).
  const regErr = edgeRegistryError();
  if (regErr) {
    const e = new Error(`엣지 Veeam 서버 등록부를 읽지 못해 보내지 않았습니다(${summarizeRegistryError(regErr)?.text || '사유 미상'}) — '맡은 서버 0대' 가 아닙니다. 중앙 veeam-config pull 이 등록부를 다시 쓰면 풀립니다`);
    e.kind = 'edge-registry-unreadable';
    throw e;
  }
  const body = buildPushBody();
  const snapEv = await snapEventsForPush();
  if (snapEv.list) body.snapEvents = snapEv.list;
  // v2.763(V2-2): 송신 시각(엣지 시계) — 중앙이 수신 시각과의 차이로 결과 ts 를 중앙 시계로 옮긴다. 옛 중앙은 최상위 새 필드를 읽지 않는다.
  body.sentAt = Date.now();
  const json = Buffer.from(JSON.stringify(body));
  const payload = await gzipAsync(json);
  const res = await postNo503Retry(`${config.agent.centralUrl}/api/central/veeam-data?agent=${encodeURIComponent(config.agent.name || '')}`, {
    method: 'POST', timeoutMs: 120_000, body: payload,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Central-Token': config.agent.centralToken, ...agentNameHeader(config.agent.name) },
  });
  let reply = null;
  try { reply = await readJsonCapped(res, 256 * 1024, '중앙 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
  if (!res.ok) {
    const why = res.status === 404 ? classifyCentral404Body(reply).reason
      : res.status === 413 ? '본문이 중앙 수신 한도를 넘었습니다(413)'
        : `HTTP ${res.status}${typeof reply?.reason === 'string' ? ` — ${reply.reason.slice(0, 200)}` : ''}`;
    throw new Error(`veeam-data ← ${why}`);
  }
  const notOwned = Number(reply?.dropped?.notOwned) || 0;
  if (notOwned && failLog('notOwned', String(notOwned))) console.warn(`[veeam-push] 중앙이 이 엣지에 배정되지 않은 서버 결과 ${notOwned}건을 받지 않았습니다(배정이 바뀐 직후일 수 있습니다)`);
  // v2.762(G1): 중앙에서 접속처를 바꾼 뒤 아직 배정 pull 전이면 옛 접속처 결과를 받지 않는다(다음 pull·수집 뒤 새 접속처 결과가 간다).
  const stale = Number(reply?.dropped?.stale) || 0;
  if (stale && failLog('stale', String(stale))) console.warn(`[veeam-push] 중앙이 접속처가 바뀐 서버의 이전 접속처 결과 ${stale}건을 받지 않았습니다(배정 pull 뒤 다시 읽습니다)`);
  _last = { at: Date.now(), ok: true, servers: body.status.servers, results: body.results.length, bytes: json.length, gzBytes: payload.length, ...(notOwned ? { notOwned } : {}), ...(stale ? { stale } : {}),
    snapVcenters: snapEv.list ? snapEv.list.length : null, ...(snapEv.error ? { snapError: snapEv.error } : {}),
    ...(Number(reply?.snap?.saved) >= 0 ? { snapSaved: Number(reply.snap.saved) } : {}) };
  return { ok: true, sent: body.results.length, snapVcenters: snapEv.list ? snapEv.list.length : null };
}

export async function pushVeeamNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) { _again = true; return _busy; }
  const run = async () => {
    try { return await pushInner(); }
    catch (e) {
      _last = { at: Date.now(), ok: false, error: e.message };
      if (failLog('push', e.message)) console.warn(`[veeam-push] 실패: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  };
  _busy = (async () => {
    let r; let rounds = 0;
    do { _again = false; r = await run(); rounds++; } while (_again && rounds < 3);
    _again = false;
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

export function startVeeamPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  onVeeamCollected(() => { pushVeeamNow().catch(() => {}); });
  _timer = startAdaptiveTimer(pollMs, () => pushVeeamNow(), { firstDelayMs: 120_000, name: 'Veeam 백업 상태 push' });
}
export function veeamPushStatus() { return { ...(_last || {}), intervalMs: pollMs() }; }
export function _resetForTest() { _busy = null; _again = false; _last = null; }
