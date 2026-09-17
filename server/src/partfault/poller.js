/**
 * partfault/poller.js — 중앙: 스캔 → 전이 → DB → 알림(v2.547).
 *
 * 중앙은 두 입력을 **합쳐서** 한 번에 판정한다:
 *  ① 이 노드가 직접 수집한 장비(`runScan()` — agent 없는 장비)
 *  ② 엣지가 올린 보고(`central/partFaultEdge.js mergeEdgeReports()`)
 * 둘을 따로 돌리면 전이 계산이 두 번 일어나 **같은 파트가 열렸다 닫혔다** 한다.
 *
 * ⚠ **재진입 가드 필수**(CLAUDE.md 성능 불변조건) — 이전 주기가 간격을 넘기면 중첩 실행돼
 *   전이가 꼬인다. 수동 실행 API 도 같은 가드를 공유한다(net/monitor.runMonitorNow 패턴).
 *
 * ⚠ **엣지 위임 장비의 `deviceOk` 는 엣지가 정한다.** 중앙은 그 장비에 닿지 않으므로
 *   중앙의 판단으로 덮으면 안 된다 — 덮으면 엣지가 '못 봤다' 고 한 장비를 중앙이 닫는다.
 */
import { runScan } from './scan.js';
import { transition } from './transition.js';
import { openFaults, applyTransition, partFaultDbStatus, markNotified } from './db.js';
import { notifyTransition, countDropped } from './notify.js';

const intervalMs = () => Math.max(60_000, Number(process.env.PARTFAULT_POLL_MS) || 10 * 60_000);
/** 기본 꺼짐(opt-in) — 새 알림을 켜는 기능이므로 현장이 명시적으로 켜게 한다. */
const enabled = () => String(process.env.PARTFAULT_ENABLED || '').toLowerCase() === 'true';

let _timer = null;
let _busy = false;
let _last = null;

/** 한 주기. 수동 실행('지금 점검')도 이 함수를 부른다 — 가드를 공유한다. */
export async function runPartFaultsNow({ notify = true } = {}) {
  if (_busy) return { ok: false, reason: '이전 점검 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  try {
    const local = await runScan();
    const { mergeEdgeReports } = await import('../central/partFaultEdge.js');
    const edge = mergeEdgeReports();

    const observed = [...local.open, ...edge.open];
    /*
     * ⚠ 관측 목록은 **장애만** 담는다(엣지가 장애만 보내므로 중앙 직접분도 같은 기준으로 맞춘다).
     *   그래서 '복구' 는 '이번 관측에 없다' 로 나타난다 — 그런데 transition 의 규칙 ④ 는
     *   '없어진 것을 닫지 않는다' 이다. 둘이 충돌하면 장애가 영원히 안 닫힌다.
     *   → 해결: **중앙 직접분은 판정한 파트 전량(`local.parts`)을 넘긴다.** 그러면 ok 로 바뀐
     *     파트가 관측에 있으므로 정상적으로 닫힌다. 엣지분은 전량을 받지 않으므로
     *     `closeHint` 로 처리한다(아래).
     */
    const localAll = local.parts;
    const deviceOk = { ...edge.deviceOk, ...local.deviceOk };

    /*
     * 엣지 장애의 '닫힘' 판정: 엣지는 **지금 열린 장애 전량**을 보낸다(스냅샷 방식).
     * 그러므로 그 엣지가 신선하게 보고했는데 목록에 없는 파트는 **해소된 것**이다.
     * 이를 transition 에 알려주기 위해, 엣지가 담당하는 장비의 '열린 장애 중 이번 목록에
     * 없는 것' 을 `ok` 상태의 관측으로 합성해 넣는다.
     * ⚠ 단 **그 엣지의 보고가 신선하고 그 장비를 봤다고 한 경우에만** 한다
     *   (`deviceOk[deviceId] === true`). 아니면 합성하지 않아 열린 채로 둔다.
     */
    const prev = await openFaults();
    const edgeKeys = new Set(edge.open.map((p) => p.partKey));
    const localKeys = new Set(localAll.map((p) => p.partKey));
    const synth = [];
    for (const o of prev) {
      if (localKeys.has(o.partKey) || edgeKeys.has(o.partKey)) continue;
      if (!o.agent) continue;                       // 중앙 직접분은 localAll 이 이미 다룬다
      if (deviceOk[o.deviceId] !== true) continue;  // 엣지가 못 본 장비는 건드리지 않는다
      /*
       * ⚠⚠ **상태를 읽지 못한 파트를 '해소' 로 만들지 않는다.** 엣지는 장애만 보내므로
       *   `unknown` 이 된 파트도 목록에서 사라진다 — 그것을 ok 로 합성하면 전이 규칙 ②가
       *   **위임 장비에서만** 깨져 '정상으로 복귀' 라는 거짓 이력이 남는다. 그래서 엣지가
       *   `unknownKeys` 로 알려 준 파트는 `unknown` 으로 합성해 **보류**시킨다.
       *   ⚠ 구버전 엣지는 `unknownKeys` 를 보내지 않는다 — 그때는 이 구분이 불가능하다.
       *     (그 한계를 없애려면 엣지를 올려야 한다. 지어내지 않는다.)
       */
      // 구버전·상한절단 엣지는 구분이 불가능하므로 **합성하지 않는다**(전이 규칙 ④ 가 보류한다).
      if (edge.unknownTruncated?.has?.(o.agent)) continue;
      const uk = edge.unknownKeys?.has?.(o.partKey);
      synth.push({ ...o, state: uk ? 'unknown' : 'ok', rawState: '' });
    }

    const tr = transition({
      open: prev,
      observed: [...localAll, ...edge.open, ...synth],
      scan: { deviceOk },
    });
    const saved = await applyTransition(tr);

    let note = null;
    if (notify && (tr.opened.length || tr.closed.length || tr.updated.some((u) => !u.sameState))) {
      note = await notifyTransition(tr);
      if (tr.opened.length) await markNotified(tr.opened.map((p) => p.partKey));
    }

    _last = {
      at: Date.now(), ms: Date.now() - t0,
      local: local.scanned, edgeAgents: edge.agents,
      stats: tr.stats, saved,
      notify: note ? { ...note, dropped: countDropped(note.results) } : null,
    };
    // 성공·실패 **둘 다** 로그를 남긴다(무음 실패 금지 — 이번 조사의 확정 결함을 반복하지 않는다).
    console.log(`[partfault] 점검 완료 ${Date.now() - t0}ms — 신규 ${tr.stats.opened} · 해소 ${tr.stats.closed} · 변화 ${tr.stats.changed}`
      + ` · 확인불가 유지 ${tr.stats.heldUnknown} · 수집실패 유지 ${tr.stats.heldDeviceFailed}`
      + (note ? ` · 알림 ${note.sent}건${note.capped ? `(상한 ${note.capped}건 제외)` : ''}` : ''));
    return { ok: true, ..._last };
  } catch (e) {
    _last = { at: Date.now(), error: String(e.message || e).slice(0, 300) };
    console.warn(`[partfault] 점검 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  } finally { _busy = false; }
}

export function startPartFaultPoller() {
  if (_timer) return;
  if (!enabled()) {
    // ⚠ 조용히 return 하지 않는다 — 왜 안 도는지 로그가 말한다.
    console.log('[partfault] 비활성 — PARTFAULT_ENABLED=true 로 켜면 파트 장애 점검을 시작합니다(기본 꺼짐).');
    return;
  }
  console.log(`[partfault] poller started (interval=${Math.round(intervalMs() / 1000)}s)`);
  _timer = setInterval(() => { runPartFaultsNow().catch(() => {}); }, intervalMs());
  _timer.unref?.();
  setTimeout(() => { runPartFaultsNow().catch(() => {}); }, 90_000).unref?.();
}

export async function partFaultStatus() {
  return {
    enabled: enabled(), intervalMs: intervalMs(), busy: _busy,
    last: _last, db: await partFaultDbStatus(),
  };
}
