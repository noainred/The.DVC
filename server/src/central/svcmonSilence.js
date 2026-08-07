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

import { notify } from '../alerts.js';
import { edgeSummary } from './svcmonEdge.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

const TICK_MS = Math.max(15_000, envNum('SVCMON_SILENCE_TICK_MS', 60_000));
const ENABLED = process.env.SVCMON_SILENCE_ALERT !== 'false';

let timer = null;
let running = false;                  // 재진입 가드(느린 웹훅이 주기를 넘길 수 있다)
const known = new Map();              // agent -> { silent:boolean, since:number }
let lastCheck = null;

const sec = (ms) => Math.round((ms || 0) / 1000);

export async function checkSilenceOnce() {
  if (running) return { ok: false, reason: '이전 검사 진행 중' };
  running = true;
  const now = Date.now();
  const fired = [];
  try {
    for (const s of edgeSummary(now)) {
      const prev = known.get(s.agent);
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
    lastCheck = { at: now, agents: known.size, fired };
    return { ok: true, ...lastCheck };
  } finally {
    running = false;
  }
}

export function silenceStatus() {
  return {
    enabled: ENABLED,
    tickMs: TICK_MS,
    tracked: [...known.entries()].map(([agent, v]) => ({ agent, silent: v.silent, since: v.since })),
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

export function _resetSilenceState() { known.clear(); lastCheck = null; }
