/**
 * partfault/poller.js — **중앙 전용**: 스캔 → 전이 → DB → 알림(v2.548).
 *
 * 중앙은 두 입력을 **합쳐서** 한 번에 판정한다:
 *  ① 이 노드가 직접 수집한 장비(`runScan()` — agent 없는 장비)
 *  ② 엣지가 올린 판정 보고(`central/partFaultEdge.js mergeEdgeReports()` — 프로토콜 2는 판정한 파트
 *     **전량**이므로 v2.547 의 `synth`/`unknownKeys` 3단 우회가 필요 없다)
 * 둘을 따로 돌리면 전이 계산이 두 번 일어나 **같은 파트가 열렸다 닫혔다** 한다.
 *
 * ⚠ **엣지에서는 돌지 않는다**(v2.548 F3). 엣지가 `PARTFAULT_ENABLED=true` 를 주면 v2.547 은 엣지
 *   poller 까지 돌아 **알림이 두 번** 나갔다. 엣지의 몫은 push 뿐이다(`push.js`).
 * ⚠ **재진입 가드 필수**(CLAUDE.md 성능 불변조건) — 수동 실행 API 와 훅(`hooks.js`)도 같은 가드를 쓴다.
 * ⚠ **엣지 위임 장비의 `deviceOk` 는 엣지가 정한다.** 중앙은 그 장비에 닿지 않으므로 덮으면 안 된다.
 */
import { config, clampIntervalMs } from '../config.js';
import { runScan } from './scan.js';
import { transition } from './transition.js';
import { openFaults, applyTransition, partFaultDbStatus, markNotified, resetInfo } from './db.js';
import { notifyTransition, countDropped } from './notify.js';
import { partFaultEnabled } from './settings.js';

// v2.599 T2599-02: 상한도 둔다(2^31 초과 → 1ms 루프).
const intervalMs = () => clampIntervalMs(Number(process.env.PARTFAULT_POLL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
const isEdge = () => !!config.agent.centralUrl;

let _timer = null;
let _busy = false;
let _last = null;

/** 한 주기. 수동 실행('지금 점검')과 훅도 이 함수를 부른다 — 가드를 공유한다. */
export async function runPartFaultsNow({ notify = true, reason = 'timer' } = {}) {
  if (isEdge()) return { ok: false, reason: '이 노드는 엣지입니다 — 판정·이력·알림은 중앙이 합니다(엣지는 push 만).' };
  if (_busy) return { ok: false, reason: '이전 점검 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  try {
    const local = await runScan();
    const { mergeEdgeReports } = await import('../central/partFaultEdge.js');
    const edge = mergeEdgeReports();

    // 중앙 직접분은 agent '' · 엣지분은 수신 시 인증된 agent 가 이미 붙어 있다(partFaultEdge.js).
    const observed = [...local.parts, ...edge.observed];
    const deviceOk = { ...edge.deviceOk, ...local.deviceOk };
    const kindFailed = { ...edge.kindFailed, ...local.kindFailed };

    const prev = await openFaults();
    // 이번 주기에 판정 대상을 낸 agent — 중앙 로컬('') + 보고가 있는 엣지. 없는 agent 의 열린 장애는 'no-report'(C5).
    const agentsReported = new Set(['', ...edge.agents.map((a) => String(a.agent || '').toLowerCase())]);
    const tr = transition({ open: prev, observed, scan: { deviceOk, kindFailed, agentsReported, deviceReason: edge.deviceReason } });
    const saved = await applyTransition(tr);

    let note = null;
    if (notify && (tr.opened.length || tr.closed.length || tr.updated.some((u) => !u.sameState))) {
      note = await notifyTransition(tr);
      if (tr.opened.length) await markNotified(tr.opened.map((p) => ({ agent: p.agent || '', partKey: p.partKey })));
    }

    _last = {
      at: Date.now(), ms: Date.now() - t0, reason,
      local: local.scanned, edgeAgents: edge.agents,
      stats: tr.stats, saved,
      notify: note ? { ...note, dropped: countDropped(note.results) } : null,
    };
    // 성공·실패 **둘 다** 로그를 남긴다(무음 실패 금지).
    console.log(`[partfault] 점검(${reason}) ${Date.now() - t0}ms — 신규 ${tr.stats.opened} · 해소 ${tr.stats.closed} · 변화 ${tr.stats.changed}`
      + ` · 보류 unknown ${tr.stats.heldUnknown}/장비실패 ${tr.stats.heldDeviceFailed}/컬렉션실패 ${tr.stats.heldCollectionFailed}/누락 ${tr.stats.heldMissing}`
      + (note ? ` · 알림 ${note.sent}건${note.capped ? `(상한 ${note.capped}건 제외)` : ''}` : ''));
    return { ok: true, ..._last };
  } catch (e) {
    _last = { at: Date.now(), reason, error: String(e.message || e).slice(0, 300) };
    console.warn(`[partfault] 점검 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  } finally { _busy = false; }
}

export function startPartFaultPoller() {
  if (_timer) return;
  if (isEdge()) { console.log('[partfault] 이 노드는 엣지 — 판정 폴러를 켜지 않습니다(push 만, 중앙이 판정).'); return; }
  const en = partFaultEnabled();
  // ⚠ 꺼져 있어도 타이머는 건다 — 설정 화면에서 켜면 다음 틱부터 돈다. 매 틱 스위치를 다시 본다.
  console.log(`[partfault] ${en.enabled ? 'poller started' : '대기(꺼짐 — 설정 › 파트 장애에서 켜면 시작)'} · 스위치 ${en.source} · interval=${Math.round(intervalMs() / 1000)}s`);
  _timer = setInterval(() => { if (partFaultEnabled().enabled) runPartFaultsNow().catch(() => {}); }, intervalMs());
  _timer.unref?.();
  setTimeout(() => { if (partFaultEnabled().enabled) runPartFaultsNow({ reason: 'boot' }).catch(() => {}); }, 90_000).unref?.();
}

export async function partFaultStatus() {
  const en = partFaultEnabled();
  return {
    role: isEdge() ? 'edge' : 'central',
    enabled: en.enabled, source: en.source, intervalMs: intervalMs(), busy: _busy,
    last: _last, db: await partFaultDbStatus(), reset: await resetInfo().catch(() => null),
  };
}
