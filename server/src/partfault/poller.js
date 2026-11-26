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
let _busy = null;   // 진행 중인 점검(프라미스) — 없으면 null
let _again = null;  // 진행 중에 들어온 요청 { reason, notify, manual } — 끝난 뒤 한 번 더
let _last = null;
let _lastSkip = null; // 꺼져 있어 건너뛴 마지막 비수동 요청 { at, reason, source }

/**
 * 한 주기. 수동 실행('지금 점검')과 훅도 이 함수를 부른다 — 가드를 공유한다.
 * v2.742(감사 TIMING-03): ① 수동('manual')이 아닌 요청(훅·주기·기동)은 **스위치가 꺼져 있으면 아무것도 하지 않는다** — 예전에는
 *   iDRAC 인벤토리 갱신 훅(hooks.js)이 꺼짐(기본값)을 보지 않고 이 함수를 불러 판정·DB 생성·**실제 알림 발송**까지 했다(주기·기동
 *   타이머만 스위치를 봤다 — 엣지 push.js 는 보고 있었다). 판정은 partFaultEnabled() 하나.
 *   ② 진행 중에 들어온 요청을 **거절하지 않고 끝난 뒤 한 번 더** 돈다(push.js v2.603 EDGE2603-01 과 같은 규약). 예전에는 '이전 점검
 *   진행 중' 으로 끝나 진행 중이던 점검이 인벤토리 갱신 **전**에 시작했으면 새 장애가 다음 주기(기본 10분)까지 판정되지 않았다.
 *   합류한 호출자는 **다시 돈 결과**를 받는다. 다시 도는 사유는 `reason+again`.
 */
export async function runPartFaultsNow({ notify = true, reason = 'timer' } = {}) {
  if (isEdge()) return { ok: false, reason: '이 노드는 엣지입니다 — 판정·이력·알림은 중앙이 합니다(엣지는 push 만).' };
  const manual = reason === 'manual';
  if (!manual) {
    const en = partFaultEnabled();
    if (!en.enabled) {
      _lastSkip = { at: Date.now(), reason, source: en.source };
      return { ok: false, skipped: true, reason: `파트 장애 기능이 꺼져 있습니다(${en.source}) — 판정·이력·알림을 하지 않았습니다` };
    }
  }
  if (_busy) { // 재진입 가드(CLAUDE.md 필수) — 거절하지 않고 끝난 뒤 한 번 더
    if (!_again) console.log(`[partfault] ${reason} — 이전 점검 진행 중, 끝난 뒤 한 번 더 점검합니다`);
    _again = { reason: _again ? _again.reason : reason, notify: !!(notify || _again?.notify), manual: !!(manual || _again?.manual) };
    return _busy;
  }
  _busy = (async () => {
    let r = await runOnce({ notify, reason });
    let rounds = 1;
    while (_again && rounds < 5) {
      const next = _again; _again = null; rounds++;
      // 재실행 사이에 꺼졌을 수 있다 — 수동 요청이 섞이지 않았으면 스위치를 다시 본다.
      if (!next.manual && !partFaultEnabled().enabled) { r = { ok: false, skipped: true, reason: '파트 장애 기능이 꺼져 있습니다 — 다시 점검하지 않았습니다' }; break; }
      r = await runOnce({ notify: next.notify, reason: `${next.reason}+again` });
    }
    // 5회 상한을 넘은 요청은 버리지 않고 곧 판정으로 한 번 더 잡는다 — 버리면 그 장애 알림이 정규 주기(최대 10분)까지 늦었다(이벤트 묶음이 판정을 기다리지 않게 된 뒤 — 10회차 성능 #3)
    if (_again) { const left = _again; _again = null; console.warn('[partfault] 다시 점검 요청이 5회 연속 겹쳤습니다 — 곧 판정으로 한 번 더 잡습니다'); setImmediate(() => { try { runPartFaultsSoon(`${String(left.reason || '').replace(/(?:\+cap)+$/, '').slice(0, 60)}+cap`); } catch { /* 다음 주기 점검이 처리한다 */ } }); }
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

let _lastJudgeCost = null;   // 마지막 runOnce 의 판정 몫 ms(알림 발송 제외)
async function runOnce({ notify = true, reason = 'timer' } = {}) {
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
    // v2.744(감사 EDGE-01): 장비군 등록부를 읽지 못한 노드(중앙 로컬 '' · 신선한 엣지 보고) — 그 장비군 장비가 빠진 열린 장애는
    //   '재배정·등록 삭제(unassigned)' 가 아니라 '등록부 손상' 으로 보류한다(transition.js).
    const scopeUnreadable = { ...(edge.scopeUnreadable || {}) };
    for (const [sc, e] of Object.entries(local.registryUnreadable || {})) scopeUnreadable[`|${sc}`] = e?.reason || '사유 미상';
    // 8a단계 ② 정비 창 — 전이 보류를 켠 창 안의 장비(판정 코어 maint/judge.js · 중앙 창). 못 만들면 빈 집합(평소대로 전이).
    let maint = null;
    try { maint = await (await import('../bmusage/maint/partfaultHold.js')).partfaultMaintHold([...observed, ...prev]); } catch { maint = null; }
    let tr = transition({ open: prev, observed, scan: { deviceOk, kindFailed, agentsReported, deviceReason: edge.deviceReason, scopeUnreadable, ...(maint?.hold?.size ? { maintHold: maint.hold } : {}) } });
    const saved = await applyTransition(tr);
    _lastJudgeCost = Date.now() - t0;   // 판정 몫(스캔 · 전이 · 적용)만 — 뒤의 알림 발송 대기는 넣지 않는다(곧 판정 간격의 비용 · 10회차 성능 #2)

    // v2.880: 파트 장애 → 이슈 자동 등록(issues/autoCreate.js — 설정에서 켠 칸만). DB 에 쓴 뒤 · 알림 전에 한 번. 던지지 않는다.
    //   '파트 장애 알림 대신 이슈 알림만'(replaceNotify)이 켜져 있으면 이슈가 맡은 파트는 아래 파트 장애 알림에서 뺀다(두 통 방지).
    let auto = null;
    try {
      const { applyPartFaultIssues, loadAutoCreate } = await import('../issues/autoCreate.js');
      auto = await applyPartFaultIssues(tr);
      if (auto.enabled && loadAutoCreate().partfault.replaceNotify && auto.handled.size) {
        const keep = (p) => !auto.handled.has(`${String(p.agent || '').trim().toLowerCase()}|${p.partKey}`);
        tr = { ...tr, opened: tr.opened.filter(keep), updated: tr.updated.filter(keep), closed: tr.closed.filter(keep) };
      }
    } catch (e) { console.warn(`[partfault] 이슈 자동 등록 실패: ${String(e?.message || e).slice(0, 200)}`); }

    let note = null;
    // v2.708: 데모(mock)로만 켜진 상태(source 'demo')면 알림을 보내지 않는다 — 합성 장애가 설정된 실제 채널(메일·웹훅)로 나가지 않게.
    //   저장 설정으로 켠 경우는 예전 그대로. 전이·이벤트 기록은 그대로 한다.
    const demoOnly = partFaultEnabled().source === 'demo';
    if (notify && !demoOnly && (tr.opened.length || tr.closed.length || tr.updated.some((u) => !u.sameState))) {
      note = await notifyTransition(tr);
      if (tr.opened.length) await markNotified(tr.opened.map((p) => ({ agent: p.agent || '', partKey: p.partKey })));
    }

    _last = {
      at: Date.now(), ms: Date.now() - t0, reason,
      local: local.scanned, edgeAgents: edge.agents,
      stats: tr.stats, saved,
      ...(auto?.enabled ? { issues: { created: auto.created, attached: auto.attached, commented: auto.commented, review: auto.review, capped: auto.capped } } : {}),
      notify: note ? { ...note, dropped: countDropped(note.results) } : null,
      ...(demoOnly ? { demo: true, notifySuppressed: 'demo' } : {}),
      // v2.954(점검 D-2): 정비 창 보류 판정을 못 한 엣지 장비(중앙이 그 엣지 대상을 모름 — 재시작 뒤 · 베어메탈 엣지 인출 전). 보류하지 않았다는 사실을 숨기지 않는다.
      ...(maint?.targetsUnknown ? { maintTargetsUnknown: maint.targetsUnknown } : {}),
    };
    // 성공·실패 **둘 다** 로그를 남긴다(무음 실패 금지).
    console.log(`[partfault] 점검(${reason}) ${Date.now() - t0}ms — 신규 ${tr.stats.opened} · 해소 ${tr.stats.closed} · 변화 ${tr.stats.changed}`
      + ` · 보류 unknown ${tr.stats.heldUnknown}/장비실패 ${tr.stats.heldDeviceFailed}/컬렉션실패 ${tr.stats.heldCollectionFailed}/누락 ${tr.stats.heldMissing}`
      + (tr.stats.heldRegistryUnreadable ? `/등록부손상 ${tr.stats.heldRegistryUnreadable}` : '')
      + (tr.stats.heldMaintenance || tr.stats.maintDeferred ? `/정비창 ${tr.stats.heldMaintenance}(새 장애 보류 ${tr.stats.maintDeferred})` : '')
      + (maint?.targetsUnknown ? ` · 정비창 판정 못 함(엣지 대상 모름) ${maint.targetsUnknown.devices}대/${maint.targetsUnknown.agents.length}엣지` : '')
      + (note ? ` · 알림 ${note.sent}건${note.capped ? `(상한 ${note.capped}건 제외)` : ''}` : '')
      + (auto?.enabled ? ` · 이슈 생성 ${auto.created}/붙임 ${auto.attached}/댓글 ${auto.commented}${auto.capped ? `/상한 ${auto.capped}` : ''}` : ''));
    return { ok: true, ..._last };
  } catch (e) {
    _last = { at: Date.now(), reason, error: String(e.message || e).slice(0, 300) };
    console.warn(`[partfault] 점검 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  }
}

/**
 * v3.52 ⑬ — 엣지가 장비 이벤트 뒤 보낸 보고(urgent)를 받으면 판정을 곧 한 번(PART_FAULT_SOON_MS 에 한 번으로 묶음 · 재진입 가드는 runPartFaultsNow 가).
 * 중앙 주기(기본 10분)를 기다리면 엣지의 ‘바로 받기’ 가 화면 · 알림에 늦게 닿았다(디버깅 1회차 엣지 #5).
 * 묶음은 5초 — 엣지는 이벤트 묶음 안에서 서버를 다시 읽을 때마다 보고하므로(6회차 judgeLoop · 시작 사이 2초) 30초로 묶으면 둘째 보고부터 30초 뒤에 판정했다(7회차 엣지 #1).
 */
let _soonTimer = null; let _soonRunning = false; let _soonAgain = false; let _soonEnd = 0; let _soonDur = 0;
export const PART_FAULT_SOON_MS = 5_000;
export const PART_FAULT_SOON_COST_X = 20;   // 다음 ‘곧 판정’ 은 앞 판정이 끝난 뒤 max(5초, 20 × 앞 판정 길이) — 판정이 통째로 동기라 큰 함대에서 루프 정지 비율을 ~5% 안으로(디버깅 8회차 성능 P1)
/** 다음 ‘곧 판정’ 까지 기다릴 ms(순수 — 시험이 고정). 조용한 뒤 첫 보고는 0(바로 — 7회차 엣지 #1). */
export const PART_FAULT_SOON_MAX_MS = 60_000;   // 간격 상한 — 판정 길이에 알림 I/O 대기가 들어가 30초면 10분을 기다렸다 · 시계가 뒤로 가면 한 시간을 기다렸다(9회차 보안 관찰)
export const soonWaitMs = (now, lastEnd, lastDur) => {
  const gap = Math.min(PART_FAULT_SOON_MAX_MS, Math.max(PART_FAULT_SOON_MS, PART_FAULT_SOON_COST_X * Math.max(0, Number(lastDur) || 0)));
  return Math.max(0, gap - Math.max(0, now - (Number(lastEnd) || 0)));   // 시계가 뒤로 가면 지난 시간을 0 으로(간격만큼만 기다린다)
};
export function runPartFaultsSoon(reason = 'edge-event') {
  if (isEdge()) return false;
  // 판정 중에 온 보고는 끝난 뒤 한 번 더(잃지 않는다 — 그 보고의 값은 지금 판정이 못 봤을 수 있다) · 이미 예약돼 있으면 그 판정이 이 보고를 본다
  if (_soonRunning) { _soonAgain = true; return true; }
  if (_soonTimer) return false;
  _soonTimer = setTimeout(() => {
    _soonTimer = null; _soonRunning = true;   // 판정 몫은 지우지 않는다 — 이 곧 판정이 진행 중 판정에 합류만 하면 새 runOnce 가 없어 벽시계(알림 대기)로 떨어졌다(11회차 엣지 #1). 마지막 runOnce 의 값을 쓴다
    runPartFaultsNow({ reason }).catch(() => {}).finally(() => {
      // 비용은 판정 몫(runOnce 의 스캔 · 전이 · 적용)만 — 알림 발송(네트워크 대기)을 넣으면 웹훅이 느릴 때 다음 곧 판정이 수십 초 · 10분 밀렸고(9회차 판정 #2),
      //   프로세스 전체 루프 시간(ELU)을 쓰면 그동안의 다른 일까지 셌다(10회차 성능 #2).
      _soonRunning = false; _soonEnd = Date.now(); _soonDur = Number.isFinite(_lastJudgeCost) ? _lastJudgeCost : 0;   // 판정 몫을 아직 모르면 0(5초 바닥)
      if (_soonAgain) { _soonAgain = false; runPartFaultsSoon(reason); }
    });
  }, soonWaitMs(Date.now(), _soonEnd, _soonDur));
  _soonTimer.unref?.();
  return true;
}
export function _resetSoonForTest() { if (_soonTimer) clearTimeout(_soonTimer); _soonTimer = null; _soonRunning = false; _soonAgain = false; _soonEnd = 0; _soonDur = 0; }

export function startPartFaultPoller() {
  if (_timer) return;
  if (isEdge()) { console.log('[partfault] 이 노드는 엣지 — 판정 폴러를 켜지 않습니다(push 만, 중앙이 판정).'); return; }
  const en = partFaultEnabled();
  // ⚠ 꺼져 있어도 타이머는 건다 — 설정 화면에서 켜면 다음 틱부터 돈다. 매 틱 스위치를 다시 본다.
  console.log(`[partfault] ${en.enabled ? 'poller started' : '대기(꺼짐 — 설정 › 파트 장애에서 켜면 시작)'} · 스위치 ${en.source} · interval=${Math.round(intervalMs() / 1000)}s`);
  _timer = setInterval(() => { if (partFaultEnabled().enabled) runPartFaultsNow().catch(() => {}); }, intervalMs());
  _timer.unref?.();
  setTimeout(() => { if (partFaultEnabled().enabled) runPartFaultsNow({ reason: 'boot' }).catch(() => {}); }, 90_000).unref?.();
  // v3.51 알림 단계 올리기(⑪) — 중앙만 · 60초마다(꺼져 있으면 보내지 않는다 — 설정을 매 회차 다시 본다)
  import('./escalationRun.js').then((m) => m.startEscalation()).catch((e) => console.warn(`[partfault] 알림 단계 올리기를 시작하지 못했습니다: ${String(e?.message || e).slice(0, 120)}`));
}

export async function partFaultStatus() {
  const en = partFaultEnabled();
  return {
    role: isEdge() ? 'edge' : 'central',
    enabled: en.enabled, source: en.source, intervalMs: intervalMs(), busy: !!_busy,
    last: _last, ...(_lastSkip ? { lastSkip: _lastSkip } : {}), db: await partFaultDbStatus(), reset: await resetInfo().catch(() => null),
  };
}
