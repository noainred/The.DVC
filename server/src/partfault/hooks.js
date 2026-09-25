/**
 * partfault/hooks.js — 수집기 → 파트 장애 **즉시 트리거**(v2.548 F7).
 *
 * v2.547 의 탐지 지연은 최대 ~50분이었다(iDRAC 인벤토리 30분 + 스캔 10분 + push 10분) — 사용자가
 * 고른 '파트당 1건 즉시 알림' 과 어긋난다. 이제 iDRAC 폴러가 인벤토리를 **갱신한 직후** 이 훅을
 * 부르고, 엣지는 즉시 push · 중앙은 즉시 전이 판정을 한다. 남는 지연은 **인벤토리 주기(30분)** 뿐이고
 * 그것은 iDRAC 부하 때문에 여기서 줄이지 않는다(화면이 '탐지 지연 상한 = 인벤토리 주기' 를 밝힌다).
 *
 * ⚠ 디바운스(기본 15초) — 폴러는 서버마다 갱신하므로 30대면 30번 부른다. 한 번으로 모은다.
 * v2.613 DEPS2613-03: push/poller 는 정적 import 다 — 예전 머리말의 '순환 방지 동적 import' 는 앞 절(idrac/poller.js 가 이 파일을
 *   import)만 참이고 `partfault/{push,poller}.js` 에서 idrac/poller.js·이 파일로 되돌아오는 정적 경로가 없어 순환이 아니었다
 *   (arch2579 는 동적 import 도 edge 로 세므로 동적화는 어차피 순환을 숨기지 못한다).
 */
import { config } from '../config.js';
import { deadlineMs } from '../util/deadline.js';
import { pushPartFaultsNow } from './push.js';
import { runPartFaultsNow } from './poller.js';

// v2.611 TIM2611-03: 상한 없는 `Math.max(1_000, env)` 는 2^31ms 초과·Infinity 에서 setTimeout 이 1ms 가 되어 디바운스가
// 사라졌다(스냅샷 갱신마다 즉시 push·판정). 시한 관문 deadlineMs([1초, 2시간], 빈 값·비숫자는 기본 15초)를 거친다.
export const hookDebounceMs = (v) => deadlineMs(v, 15_000);
const DEBOUNCE_MS = hookDebounceMs(process.env.PARTFAULT_HOOK_DEBOUNCE_MS);
let _timer = null;
let _pending = 0;
let _last = null;

/** iDRAC 인벤토리(또는 스토리지·SAN 스냅샷)가 갱신됐다. 여러 번 불려도 한 번만 돈다. */
export function onSnapshotRefreshed(source = 'idrac') {
  _pending += 1;
  if (_timer) return;
  _timer = setTimeout(async () => {
    const n = _pending; _pending = 0; _timer = null;
    try {
      if (config.agent.centralUrl) {
        _last = { at: Date.now(), source, batched: n, result: await pushPartFaultsNow({ reason: `hook:${source}` }) };
      } else {
        _last = { at: Date.now(), source, batched: n, result: await runPartFaultsNow({ reason: `hook:${source}` }) };
      }
    } catch (e) { _last = { at: Date.now(), source, batched: n, error: String(e.message || e).slice(0, 200) }; }
  }, DEBOUNCE_MS);
  _timer.unref?.();
}

export function hookStatus() { return { debounceMs: DEBOUNCE_MS, pending: _pending, last: _last }; }
