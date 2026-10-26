/**
 * vmclone/capacity.js — 백업·복구 전 용량 사전 검사(순수, v2.795).
 *
 * 사용자 요구(2026-10-26): "백업 실행 경로" 개선. 클론·내려받기가 저장소를 가득 채우면 **그 데이터스토어 위의 운영 VM 이 멈춘다**
 * (VMFS·NFS 데이터스토어가 100% 면 thin 디스크 VM 이 쓰기에서 일시 정지된다). 그래서 스냅샷을 만들기 **전에** 여유를 본다.
 *  · 필요량 = 원본 VM 사용량(데이터스토어 클론은 committed, NFS 파일 백업은 committed+uncommitted — thin -flat 파일은 내려받으면
 *    프로비저닝 크기 그대로다). 보존정책은 새 사본을 만든 **뒤에** 옛 사본을 지우므로 그 순간엔 옛 사본도 자리를 차지한다.
 *  · 남겨 둘 여유 하한 = max(10GiB, 전체의 5%).
 *  · 값을 못 읽으면(null) 검사하지 않는다 — '못 읽은 값은 0 이 아니다'(util/numOrNull 규약). 0 으로 보고 막지도, 통과시켰다고 단정하지도 않는다.
 */

const GIB = 1024 ** 3;
export const MIN_FREE_FLOOR = 10 * GIB;
export const MIN_FREE_RATIO = 0.05;

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

/**
 * @param {{free:any, capacity:any, need:any}} x 바이트(문자열 수치 허용)
 * @returns {null | {free:number, need:number, floor:number, capacity:number|null}} 부족하면 숫자들, 충분하거나 판정할 수 없으면 null
 */
export function capacityShortfall({ free, capacity, need } = {}) {
  const f = num(free); const n = num(need); const cap = num(capacity);
  if (f == null || n == null) return null;
  const floor = Math.max(MIN_FREE_FLOOR, cap != null ? cap * MIN_FREE_RATIO : 0);
  return f - n < floor ? { free: f, need: n, floor, capacity: cap } : null;
}

const gb = (b) => `${(b / GIB).toFixed(b >= 100 * GIB ? 0 : 1)}GB`;

/** 부족 사유 한 줄(순수). where: '대상 데이터스토어 ‘ds1’' 등. */
export function shortfallText(where, s, { tail = '' } = {}) {
  return `${where} 여유가 부족해 시작하지 않았습니다 — 여유 ${gb(s.free)}, 필요 약 ${gb(s.need)} + 남겨 둘 여유 ${gb(s.floor)}. ` +
    `가득 차면 그 저장소 위의 VM 이 멈출 수 있습니다${tail}`;
}
