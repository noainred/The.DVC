/**
 * 성능점검 엣지 무보고 감시 — Active push 방식의 **최대 신규 실패 모드**를 사람에게 알린다.
 *
 * 엣지가 결과를 밀어 올리는 구조에서 가장 위험한 상태는 "엣지가 조용해졌는데 화면은 마지막
 * 결과를 초록으로 유지"다. pull 방식이라면 pull 실패 자체가 신호가 되지만 push 는 침묵이
 * 신호이므로 **직접 만들어야** 한다.
 *
 * 판정은 `svcmonEdge.isSilent()` 하나를 쓴다(화면과 알림이 같은 기준을 쓰게 한다). 임계는
 * 엣지가 봉투에 실어 보낸 자기 push 주기(`expectMs`)의 3배 → 주기를 바꾼 엣지에도 자동 적응.
 *
 * ## 전환에만 알린다
 * 장애 지속 중 매 주기 알림은 곧 무시된다. 그리고 **첫 관측은 기준점만 잡고 알리지 않는다** —
 * 그러지 않으면 중앙을 재시작할 때마다 전 엣지 알림이 폭발한다(R1 은 수신 상태를 디스크에
 * 보관하지 않으므로 재시작 직후 전 엣지가 '보고 없음'으로 시작한다).
 *
 * ## 명시적 한계
 * 이 감시는 **'엣지 무보고'만** 알린다. 개별 점검의 정상→실패 전이 알림은 아직 없다.
 * '엣지 위임을 붙였으니 장애 감시가 완성됐다'가 아니다.
 */

import { clampIntervalMs } from '../config.js';
import { notify } from '../alerts.js';
import { edgeSummary, noReportGraceMs, edgeStartedAt, _setEdgeStartedAt } from './svcmonEdge.js';
import { listAssignments } from './svcmonAssign.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

// v2.628(감사 EDGE2628-05): 상한 없음 → 2^31-1ms 초과가 setInterval 1ms 루프였다. config.js 관문으로 [15초, MAX_TIMER_MS].
const TICK_MS = clampIntervalMs(envNum('SVCMON_SILENCE_TICK_MS', 60_000), 60_000, 15_000);
const ENABLED = process.env.SVCMON_SILENCE_ALERT !== 'false';

let timer = null;
let running = false;                  // 재진입 가드(느린 웹훅이 주기를 넘길 수 있다)
const known = new Map();              // agent -> { silent:boolean, since:number }
let lastCheck = null;
// v2.629(감사 EDGE2629-02): 중앙 기동 시각. 수신 상태(svcmonEdge agents)는 인메모리라 재시작 직후에는 '보고 없음' 행
//   자체가 없어, 중앙이 내려가 있는 동안(또는 재시작 직후) 죽은 엣지는 **영원히** 무보고 알림이 나가지 않았다.
//   그래서 배정 목록(central-svcmon-assign.json — 파일 영속)의 엣지를 함께 본다: 기동 후 유예(판정 임계 — 기본 주기 기준)가
//   지나도 한 번도 보고하지 않은 배정 엣지는 '기동 후 보고 없음' 으로 **한 번** 알린다. 보고가 오면 아래 전환 규칙이
//   '보고 재개' 로 알린다(첫 관측 억제는 '보고가 있던 엣지' 에만 적용된다).
// v2.630(감사 R2630-06): 기동 시각은 svcmonEdge 가 소유한다(화면의 '배정됨 · 보고 없음' 행과 같은 기준). 유예는 엣지마다 —
//   배정 기록에 남은 그 엣지의 push 주기 기준(noReportGraceMs), 모르면 예전처럼 기본 주기 기준.

const sec = (ms) => Math.round((ms || 0) / 1000);

export async function checkSilenceOnce({ now: nowArg } = {}) {
  if (running) return { ok: false, reason: '이전 검사 진행 중' };
  running = true;
  const now = Number.isFinite(nowArg) ? nowArg : Date.now();
  const fired = [];
  try {
    for (const s of edgeSummary(now)) {
      let prev = known.get(s.agent);
      if (!prev) {
        // '기동 후 보고 없음' 으로 알린 배정 엣지가 (대소문자만 다른 이름으로) 보고를 시작하면 그 기록을 이어 받는다 —
        //   그래야 아래 전환 규칙이 '보고 재개' 를 알린다.
        const lc = String(s.agent).toLowerCase();
        for (const [k, v] of known) if (v.noReport && k.toLowerCase() === lc) { prev = v; known.delete(k); known.set(s.agent, v); break; }
      }
      if (!prev) {
        // 첫 관측 — 기준점만 잡는다(알리지 않는다).
        known.set(s.agent, { silent: s.silent, since: now });
        continue;
      }
      if (prev.silent === s.silent) continue;      // 전환 없음
      known.set(s.agent, { silent: s.silent, since: now });
      if (!ENABLED) continue;

      if (s.silent) {
        fired.push({ agent: s.agent, kind: 'silent' });
        await notify({
          severity: 'critical',
          key: `svcmon.edge.silent:${s.agent}`,
          title: `성능점검 엣지 무보고: ${s.agent}`,
          detail: `마지막 보고 ${sec(s.ageMs)}초 전(예상 간격 ${sec(s.expectMs)}초 · 판정 임계 ${sec(s.silenceLimitMs)}초) · `
            + `이 엣지가 담당한 점검 ${s.rows}개(대상 항목 ${s.items}개)의 **현재 상태를 알 수 없습니다**. `
            + `대상이 정상인지 장애인지 판단할 수 없는 상태이며, 화면에서는 '알 수 없음'으로 표시됩니다.`,
        }).catch(() => {});
      } else {
        fired.push({ agent: s.agent, kind: 'recovered' });
        await notify({
          severity: 'warning',
          key: `svcmon.edge.recovered:${s.agent}`,
          title: `성능점검 엣지 보고 재개: ${s.agent}`,
          detail: `보고가 다시 들어옵니다(점검 ${s.rows}개 · 정상 ${s.counts.ok} · 주의 ${s.counts.warn} · 실패 ${s.counts.bad} · 갱신 안 됨 ${s.counts.stale}).`,
        }).catch(() => {});
      }
    }
    // 배정됐는데 이 중앙이 기동한 뒤 한 번도 보고하지 않은 엣지.
    const reported = new Set(edgeSummaryNames(now));
    const startedAt = edgeStartedAt();
    const graceByAgent = {};
    const noReport = [];
    let assignments = [];
    try { assignments = listAssignments(); } catch (e) { assignments = []; lastAssignError = e?.message || String(e); }
    for (const a of assignments) {
      const name = String(a?.agent || '');
      if (!name || reported.has(name.toLowerCase())) continue;
      noReport.push(name);
      const graceMs = noReportGraceMs(a);
      graceByAgent[name] = graceMs;
      if (now - startedAt < graceMs) continue;   // 유예 중 — 아직 판정하지 않는다
      const prev = known.get(name);
      if (prev) continue;                         // 이미 알렸거나(무보고) 추적 중
      known.set(name, { silent: true, since: now, noReport: true });
      if (!ENABLED) continue;
      fired.push({ agent: name, kind: 'no-report' });
      await notify({
        severity: 'critical',
        key: `svcmon.edge.silent:${name}`,
        title: `성능점검 엣지 무보고(중앙 기동 후 보고 없음): ${name}`,
        detail: `중앙이 기동한 지 ${sec(now - startedAt)}초가 지났지만 이 엣지의 보고가 한 번도 없습니다(판정 임계 ${sec(graceMs)}초 · 배정 상태 ${a.state || '—'} · `
          + `배정 점검 ${a.counts?.tests ?? '—'}개). 이 엣지가 담당한 점검의 **현재 상태를 알 수 없습니다** — 중앙이 내려가 있는 동안 엣지가 멈췄을 수 있습니다.`,
      }).catch(() => {});
    }
    // graceMs(단일 값)는 하위호환 — 엣지별 값의 최소(없으면 기본 주기 기준). 엣지별은 graceByAgent.
    const graces = Object.values(graceByAgent);
    const graceMs = graces.length ? Math.min(...graces) : noReportGraceMs(null);
    lastCheck = { at: now, agents: known.size, fired, noReport, graceMs, graceByAgent, startedAt };
    return { ok: true, ...lastCheck };
  } finally {
    running = false;
  }
}

let lastAssignError = '';
/** edgeSummary 의 엣지 이름(소문자) — 배정 이름과 대소문자 무시로 맞춘다(v2.604 util/agentKey 규약과 같은 판단). */
function edgeSummaryNames(now) { return edgeSummary(now).map((s) => String(s.agent || '').toLowerCase()); }

export function silenceStatus() {
  return {
    enabled: ENABLED,
    tickMs: TICK_MS,
    tracked: [...known.entries()].map(([agent, v]) => ({ agent, silent: v.silent, since: v.since, ...(v.noReport ? { noReport: true } : {}) })),
    startedAt: edgeStartedAt(),
    ...(lastAssignError ? { assignError: lastAssignError } : {}),
    lastCheck,
    note: '엣지 무보고만 알립니다. 개별 점검의 정상→실패 전이 알림은 아직 없습니다.',
  };
}

export function startSvcmonSilenceWatch() {
  if (timer) return;
  timer = setInterval(() => { checkSilenceOnce().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  console.log(`[svcmon-silence] 엣지 무보고 감시 시작 (${Math.round(TICK_MS / 1000)}초 주기${ENABLED ? '' : ' · 알림 비활성'})`);
}

export function _resetSilenceState({ startedAt: at } = {}) { known.clear(); lastCheck = null; lastAssignError = ''; if (Number.isFinite(at)) _setEdgeStartedAt(at); }
