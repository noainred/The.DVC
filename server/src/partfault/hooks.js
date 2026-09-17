/**
 * partfault/hooks.js — 수집기 → 파트 장애 **즉시 트리거**(v2.548 F7).
 *
 * v2.547 의 탐지 지연은 최대 ~50분이었다(iDRAC 인벤토리 30분 + 스캔 10분 + push 10분) — 사용자가
 * 고른 '파트당 1건 즉시 알림' 과 어긋난다. 이제 iDRAC 폴러가 인벤토리를 **갱신한 직후** 이 훅을
 * 부르고, 엣지는 즉시 push · 중앙은 즉시 전이 판정을 한다. 남는 지연은 **인벤토리 주기(30분)** 뿐이고
 * 그것은 iDRAC 부하 때문에 여기서 줄이지 않는다(화면이 '탐지 지연 상한 = 인벤토리 주기' 를 밝힌다).
 *
 * ⚠ 디바운스(기본 15초) — 폴러는 서버마다 갱신하므로 30대면 30번 부른다. 한 번으로 모은다.
 * ⚠ 순환 import 방지 — 이 파일은 poller/push 를 **동적 import** 한다(idrac/poller.js 가 이 파일을 import).
 */
import { config } from '../config.js';

const DEBOUNCE_MS = Math.max(1_000, Number(process.env.PARTFAULT_HOOK_DEBOUNCE_MS) || 15_000);
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
        const { pushPartFaultsNow } = await import('./push.js');
        _last = { at: Date.now(), source, batched: n, result: await pushPartFaultsNow({ reason: `hook:${source}` }) };
      } else {
        const { runPartFaultsNow } = await import('./poller.js');
        _last = { at: Date.now(), source, batched: n, result: await runPartFaultsNow({ reason: `hook:${source}` }) };
      }
    } catch (e) { _last = { at: Date.now(), source, batched: n, error: String(e.message || e).slice(0, 200) }; }
  }, DEBOUNCE_MS);
  _timer.unref?.();
}

export function hookStatus() { return { debounceMs: DEBOUNCE_MS, pending: _pending, last: _last }; }
