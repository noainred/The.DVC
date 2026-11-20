/**
 * sanswitch/flowView.js — Flow Vision 플로우 기록 → 화면 값(순수 · v2.940). SAN 플로우 모니터 · 호스트 상세 '경로별 실측' · SAN 호스트 귀속 표가 같은 계산을 쓴다
 *   (판정 코어는 하나 — 예전에는 routes/api/sanFlow.js 안에만 있었다).
 *   못 읽은 카운터는 0 이 아니다(numOrNull) · 비활성 플로우는 장비가 세지 않으므로 속도를 비운다(0 으로 만들지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';

/** 바이트 카운터 두 번 → 초당(델타). 하나라도 못 읽었거나(null — 0 이 아니다) 리셋이면 null(C-② 반증 M-4). */
export function rateOf(cur, prev, curAt, prevAt, k) {
  const a = numOrNull(cur?.[k]); const b = numOrNull(prev?.[k]); const t1 = numOrNull(curAt); const t0 = numOrNull(prevAt);
  if (a == null || b == null || t1 == null || t0 == null) return null;
  const dt = (t1 - t0) / 1000;
  if (!(dt > 0) || a < b) return null;
  return Math.round((a - b) / dt);
}
/** ESXi 경로 실측 — 읽기 · 쓰기가 **둘 다** 있을 때만 합(한쪽만 있으면 부분 합 — 비교하지 않는다, C-② 반증 M-5). */
export function esxiBpsOf(t) {
  const r = numOrNull(t?.rKBps); const w = numOrNull(t?.wKBps);
  return r == null || w == null ? null : Math.round((r + w) * 1024);
}
/**
 * 플로우 기록 하나의 지금 속도(수신 = 호스트 쓰기 · 송신 = 호스트 읽기). **활성이고 최근에 읽은 것만**(v2.940 반증 M-1):
 *   비활성 · 장비에 없음 · 이름 충돌 · 결과 모름은 null(직전 카운터로 계산한 옛 속도를 '지금' 으로 말하지 않는다).
 *   마지막 성공 읽기가 staleMs(기본 카운터 주기 2배)보다 오래되면 null + stale — 오래됨은 정상에 넣지 않고 따로 센다(루트 CLAUDE.md).
 */
export function flowRatesOf(f, { now = Date.now(), staleMs = null } = {}) {
  if (!f || f.state !== 'active') return { rxBps: null, txBps: null };
  const at = numOrNull(f.lastAt);
  if (staleMs != null && at != null && now - at > staleMs) return { rxBps: null, txBps: null, stale: true };
  return { rxBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'rxBytes'), txBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'txBytes') };
}
/** 장비에 있을 수 있는 기록만(지움 · 만들지 못함 제외) — 호스트 화면에 싣는 것. */
export const FLOW_SHOWN_STATES = new Set(['pending', 'active', 'inactive', 'unknown', 'conflict', 'gone']);
/** 호스트 화면용 한 줄 — 비밀 · 관리 주소 없음(이름 · 상태 · HBA · 타깃 · 속도 · 마지막 읽은 시각). */
export function hostFlowOut(f, switchName = '', opts = {}) {
  const r = flowRatesOf(f, opts);
  return { name: f.name, state: f.state, deviceId: f.deviceId, switchName: switchName || f.deviceId, hba: f.hba || '', srcdev: f.srcdev, dstdev: f.dstdev,
    targetName: f.targetName || '', rxBps: r.rxBps, txBps: r.txBps, ...(r.stale ? { stale: true } : {}), lastAt: numOrNull(f.lastAt) };
}
/** 오래됨 기준 — 카운터 주기의 2배(주기 한 번을 놓친 것까지는 '지금' 으로 본다). */
export const staleMsOf = (showEveryMs) => 2 * Math.max(60_000, Number(showEveryMs) || 15 * 60_000);
