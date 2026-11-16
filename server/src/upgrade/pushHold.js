/**
 * 중앙이 민 번들의 설치 · 재시작 보류(51회차 #3 사용자 결정 — 2026-11-17 '권장 사항으로 진행').
 *
 * 예전: 수집기 `/api/collector/upgrade` · 엣지 `/api/upgrade/bundle` 는 받은 즉시 설치하고 250ms 뒤 재시작했다 — 자동 적용(manager)이 기다리는
 *   진행 중 작업(집중 모니터링 디스크 점검 · 설치, Veeam · Bareos 엣지 대행, VM 복제, 대량 배포, 재개 기록이 없는 스캔)을 그대로 끊었다.
 *   기본 업그레이드 경로(엣지 자동 업그레이드 동기화 · 적용 직후 push)가 이 길이라 그 '대기' 들이 엣지에서는 효과가 없었다.
 * 이제: 재시작 요청 push 가 왔을 때 `restartBlockers()`(manager — 자동 적용과 같은 목록)가 비어 있지 않으면
 *   ① 서명 · 번들 · 버전을 **미리 확인**하고(거부할 번들은 들고 있지 않는다 — 예전과 같은 거부 응답)
 *   ② **설치하지 않고** 번들을 메모리에 든다(재시작만 미루면 옛 프로세스가 새 파일 — 화면 dist · 지연 import — 을 읽는다)
 *   ③ 1분마다 다시 보고, 작업이 끝나거나 상한(UPGRADE_SCAN_DEFER_MAX_MS — 자동 적용과 같다)에 닿으면 설치 · 재시작한다(보류에는 시한).
 *   같은 버전을 다시 밀면 번들만 바꾸고 상한은 늘리지 않는다. 다른 버전이면 새로 시작한다. 재시작 요청이 없는 push 나 지금 설치하는 push 는 보류를 지운다.
 *   응답은 `{ ok:true, deferred:true, waitMs, reason, waitingFor }` — 중앙은 그 시간 동안 다시 밀지 않는다(edgeSync holdUntil).
 *   프로세스가 다른 이유로 재시작되면 보류는 사라진다(메모리) — 중앙 동기화가 다시 민다.
 */
import { restartBlockers, scanDeferMaxMs, upgradeManager } from './manager.js';
import { preverifyBundleBytes, upgradeFromBundleBytes, restartProcess } from './upgrade.js';
import { currentVersion } from '../config.js';
import { localStamp } from '../util/dayKey.js';

const RECHECK_MS = 60_000;
const defaults = {
  blockers: () => restartBlockers(),
  maxMs: () => scanDeferMaxMs(),
  now: () => Date.now(),
  preverify: (bytes, o) => preverifyBundleBytes(bytes, currentVersion(), o.pkgName, { allowSame: o.allowSame, manifestText: o.manifestText, where: o.where }),
  install: (bytes, o) => upgradeFromBundleBytes(bytes, o.installDir, currentVersion(), o.pkgName, { allowSame: o.allowSame, manifestText: o.manifestText, where: o.where }),
  restart: () => restartProcess(),
  applying: () => !!upgradeManager._applying,
  record: (r) => { upgradeManager.lastResult = r; },
};
const deps = { ...defaults };
/** 테스트 주입 — null 이면 운영 값. */
export function _setPushHoldDepsForTest(o = null) { Object.assign(deps, o ? o : defaults); if (!o) clearPushHold(); }

let pending = null;
let timer = null;

/** 보류 상태(화면 · 진단 — 번들 바이트는 싣지 않는다). */
export function pushHoldStatus() {
  if (!pending) return null;
  return { source: pending.source, version: pending.version, since: pending.since, until: pending.until };
}

export function clearPushHold() {
  pending = null;
  if (timer) { clearInterval(timer); timer = null; }
}

const labelsOf = (list) => list.map((x) => String(x?.label || x?.kind || '작업').slice(0, 120));

/**
 * 재시작 요청 push 를 받았을 때 — 기다릴 작업이 없으면 null(호출자가 예전처럼 지금 설치 · 재시작한다, 남은 보류는 지운다).
 * 기다리면 보류하고 응답 본문을, 미리 확인에서 거부되면 그 거부 본문(ok:false)을 돌려준다.
 */
export function holdPushIfBusy({ bytes, installDir, pkgName, allowSame = false, manifestText = null, where, source }) {
  const blockers = (() => { try { return deps.blockers() || []; } catch { return []; } })();
  const maxMs = deps.maxMs();
  if (!blockers.length || !(maxMs > 0)) { clearPushHold(); return null; }
  const pre = deps.preverify(bytes, { pkgName, allowSame, manifestText, where });
  if (!pre.ok) return pre;
  const now = deps.now();
  const keep = !!pending && pending.version === pre.version;
  const since = keep ? pending.since : now;
  const until = keep ? pending.until : now + maxMs;
  pending = { bytes, installDir, pkgName, allowSame, manifestText, where, source, version: pre.version, from: pre.from, since, until };
  if (!timer) { timer = setInterval(() => { tickPushHold(); }, RECHECK_MS); timer.unref?.(); }
  const labels = labelsOf(blockers);
  const reason = `진행 중 작업 ${blockers.length}건(${labels.slice(0, 3).join(', ')}${blockers.length > 3 ? ' …' : ''})이 끝나면 v${pre.version} 를 설치하고 재시작합니다 — 늦어도 ${localStamp(until)}`;
  return { ok: true, deferred: true, version: pre.version, from: pre.from, waitMs: Math.max(0, until - now), reason, waitingFor: labels.slice(0, 10) };
}

/** 1분마다(그리고 테스트가 직접) — 작업이 끝났거나 상한이면 설치 · 재시작. 자동 적용이 설치 중이면 이번은 건너뛴다. */
export function tickPushHold() {
  if (!pending) { clearPushHold(); return { outcome: 'none' }; }
  if (deps.applying()) return { outcome: 'busy' };
  const now = deps.now();
  const blockers = (() => { try { return deps.blockers() || []; } catch { return []; } })();
  if (blockers.length && now < pending.until) return { outcome: 'waiting', blockers: blockers.length };
  const p = pending;
  clearPushHold();
  const forced = blockers.length > 0;
  let r;
  try { r = deps.install(p.bytes, p); } catch (e) { r = { ok: false, reason: String(e?.message || e).slice(0, 300) }; }
  const note = forced
    ? `진행 중 작업 ${blockers.length}건(${labelsOf(blockers).slice(0, 3).join(', ')})이 대기 상한을 넘겨 설치합니다 — 그 작업은 결과를 받지 못합니다`
    : `진행 중이던 작업이 끝나 설치합니다(${Math.round((now - p.since) / 60_000)}분 기다림)`;
  try { deps.record({ at: now, source: p.source, heldMs: now - p.since, ...(forced ? { forced: true } : {}), note, ...r }); } catch { /* 기록 실패가 설치를 막지 않는다 */ }
  console.log(`[upgrade] 중앙 push 보류 해제 — ${note}${r?.ok ? '' : ` · 설치 실패: ${r?.reason || ''}`}`);
  const restartFn = deps.restart;   // 설치한 그 시점의 재시작 함수(250ms 뒤 주입이 바뀌어도 같은 것)
  if (r && r.ok) setTimeout(() => restartFn(), 250);
  return { outcome: r?.ok ? 'installed' : 'install-failed', forced, result: r };
}
