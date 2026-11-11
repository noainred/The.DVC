/**
 * bmstor/diskMap.js — 디스크별 누적 카운터 맵 정제(순수, v2.969).
 * 엣지 회신(poller.sanitizeBmIo — 엣지 export 새 필드 = 중앙 화이트리스트)과 io_last.disks_json 되살리기(ioDb)가 **같은 함수**를 쓴다.
 * 모양: { <통짜 디스크 이름>: [rd_sectors, wr_sectors, io_ms, rd_ios, wr_ios, rw_ticks] } — diskstats.ioRate 가 만든다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { WHOLE_DISK_RE, DISK_MAP_MAX } from './diskstats.js';

/** 디스크 이름 길이 상한 — 실제 이름은 sdaa · nvme12n3 · mmcblk0 정도(10자 안팎). */
export const NAME_MAX = 32;

/**
 * v2.969: 엣지가 보낸 디스크별 누적 카운터 맵 정제 — 이름은 32자 이하 · 통짜 디스크 정규식(WHOLE_DISK_RE)만 · 상한 DISK_MAP_MAX 개
 * (넘으면 맵 전체를 버린다 — 일부만 남기면 다음 구간과 비교할 디스크 집합이 흔들린다) · 값은 길이 6 배열:
 * 섹터 두 개 · io_ms 는 0 이상 유한 수(아니면 그 디스크를 뺀다) · I/O 횟수 둘 · 소요 ms 는 셋 다 0 이상 수거나 셋 다 null.
 * 문자열 수치는 수로(루트 규칙 — 엣지 정제). 결과는 프로토타입 없는 객체가 아니라 일반 객체지만 키가 정규식을 통과한 이름뿐이라 '__proto__' 류가 들어오지 않는다.
 */
export function sanitizeDiskMap(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const keys = Object.keys(m);
  if (!keys.length || keys.length > DISK_MAP_MAX) return null;
  const out = {};
  const nn = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? n : null; };
  for (const k of keys) {
    if (k.length > NAME_MAX || !WHOLE_DISK_RE.test(k)) continue;   // 정규식은 길이를 묶지 않는다(sd[a-z]+) — 먼저 자른다
    const v = m[k];
    if (!Array.isArray(v) || v.length !== 6) continue;
    const a = [nn(v[0]), nn(v[1]), nn(v[2])];
    if (a.some((x) => x == null)) continue;
    const b = [nn(v[3]), nn(v[4]), nn(v[5])];
    out[k] = b.every((x) => x != null) ? [...a, ...b] : [...a, null, null, null];
  }
  return Object.keys(out).length ? out : null;
}
