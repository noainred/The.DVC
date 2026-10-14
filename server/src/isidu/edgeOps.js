/**
 * isidu/edgeOps.js — 엣지가 메인의 직접 요청을 받아 하는 일(v2.736 — iDRAC PUSH 스캔과 같은 길: POST {엣지}/api/collector/isidu-*,
 * X-Collector-Token). 라우트(`routes/collector.js`)는 토큰 검사만 하고 여기를 부른다.
 *
 *  · nudge: 중앙 설정을 **지금** 다시 받아(대상 사본 + '지금 수집' 요청) 요청된 수집을 시작한다. 본문의 대상 id 를 믿지 않는다 —
 *    무엇을 돌릴지는 중앙 pull(claim→ack 큐)이 정한다. 다른 pull 이 진행 중이면 그것이 끝난 뒤 한 번 더 받는다(그 pull 은 요청이
 *    큐에 들어가기 전에 시작했을 수 있다).
 *  · test : 메인이 보낸 대상(비밀 없음)을 엣지에서 다시 검증(cleanEdgeTarget)하고 **이 엣지의 키·등록부로** `ls -d` 만 한다.
 *    동시에 2개까지(넘으면 429) — 시험을 연타해 아이실론에 세션을 쌓지 않게.
 */
import { config, currentVersion } from '../config.js';
import { pullIsiduConfigNow } from '../agent/isiduConfigPull.js';
import { cleanEdgeTarget, edgeTargets } from './settings.js';
import { testTargetPath } from './collect.js';
import { keyInfo } from './sshKey.js';

const NUDGE_WAIT_MS = 20_000;
const TEST_MAX = 2;
let _tests = 0;
let _last = null;   // 엣지 로그·진단용 마지막 원격 요청

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function edgeIsiduNudge({ waitMs = NUDGE_WAIT_MS } = {}) {
  const node = config.agent.name || '';
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    _last = { at: Date.now(), op: 'nudge', ok: false, reason: 'no-central' };
    return { ok: false, node, reason: '이 노드는 중앙 설정 pull 이 꺼져 있습니다(CENTRAL_URL/CENTRAL_TOKEN 미설정) — 메인이 정한 대상과 요청을 받을 수 없습니다.' };
  }
  const until = Date.now() + Math.max(0, waitMs);
  let r;
  for (;;) {
    r = await pullIsiduConfigNow();
    if (r.ok || !r.busy || Date.now() >= until) break;
    await sleep(400);
  }
  _last = { at: Date.now(), op: 'nudge', ok: !!r.ok, ...(r.ok ? { runRequested: r.runRequested, started: (r.started || []).length } : { reason: String(r.reason || '').slice(0, 200) }) };
  if (!r.ok) console.warn(`[isidu] 메인의 원격 실행 요청을 처리하지 못했습니다: ${r.reason}`);
  return { ok: !!r.ok, node, version: currentVersion(), ...(r.ok ? { runRequested: r.runRequested ?? 0, count: r.count ?? 0, started: r.started || [] } : { reason: String(r.reason || '').slice(0, 300) }) };
}

/** @returns {Promise<{status:number, body:object}>} */
export async function edgeIsiduTest(body) {
  const node = config.agent.name || '';
  const t = cleanEdgeTarget(body?.target);
  if (!t) return { status: 400, body: { ok: false, node, reason: '대상 형식이 잘못됐습니다(경로·주소·계정 판정을 통과하지 못했습니다).' } };
  if (_tests >= TEST_MAX) return { status: 429, body: { ok: false, node, reason: `이 엣지에서 연결 시험이 이미 ${_tests}개 진행 중입니다 — 끝난 뒤 다시 누르세요.` } };
  _tests++;
  try {
    const known = edgeTargets().targets.some((x) => x.id === t.id);
    const r = await testTargetPath(t, { clearStopId: known ? t.id : '' });
    _last = { at: Date.now(), op: 'test', ok: !!r.ok, target: t.id, ...(r.ok ? {} : { kind: r.kind || null }) };
    // 시험 중에 키를 새로 만들었으면 곧바로 메인 화면에 보이게 한다(관리자가 그 공개키를 아이실론에 등록해야 한다).
    if (r.keyCreated) import('./push.js').then((m) => m.pushIsiduNow()).catch(() => {});
    const k = t.auth === 'device' ? null : keyInfo();
    return { status: 200, body: { ...r, node, version: currentVersion(), ...(k ? { key: { fingerprint: k.fingerprint || '', created: !!r.keyCreated } } : {}) } };
  } finally { _tests--; }
}

export function isiduEdgeOpsStatus() { return { ...(_last || {}), testsRunning: _tests }; }
export function _resetForTest() { _tests = 0; _last = null; }
