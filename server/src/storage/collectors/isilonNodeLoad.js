/**
 * storage/collectors/isilonNodeLoad.js — Isilon/PowerScale 노드별 부하(디스크 쓰기·읽기 · CPU) 읽기(v2.926, 순수 모듈).
 *
 * 사용자 요청(2026-11-07): "노드별 io network 부하를 저장하고 차트로" → "Disk io 추가" → 성능 관점 추천 ①(노드 CPU).
 * 네트워크 In/Out 은 예전부터 읽는다(SSH `isi status` 처리량 열 · REST `node.net.ext.bytes.*.rate`). 이 모듈은 **그 옆에
 * 디스크·CPU 를 더하는 것만** 한다 — 장비 왕복을 늘리지 않는 쪽으로:
 *  · REST: 이미 부르는 `statistics/current?devid=all` 의 key 목록에 3개를 더한다(왕복 0).
 *  · SSH : 세션 안에 `isi statistics system --nodes all --format json` 1개(best-effort · 세션 예산 안 · 실패해도 `isi status` 값은 유지).
 *
 * ⚠⚠ 정직 기록 — **실장비에서 본 적이 없다**(OneFS 문서 지식 수준, 수집기 머리말들과 같은 수준):
 *  · REST 키 이름 `node.disk.bytes.{in,out}.rate.sum`(노드의 전 드라이브 합 B/s) · `node.cpu.idle.avg`.
 *  · `node.cpu.idle.avg` 의 단위는 **1/10 % (0~1000)** 로 가정한다(OneFS 의 cpu 통계 키가 per-mille 로 보고된다는 문서 기억).
 *    그 범위를 벗어나는 값은 버린다(null) — 단위를 값마다 추측하지 않는다(값마다 추측하면 모든 노드가 바쁠 때 해석이 뒤집힌다).
 *  · 디스크 In = 쓰기, Out = 읽기 로 화면이 부른다(디스크 기준 '들어감 = 기록'). 첫 실장비 수집에서 방향을 확인할 것.
 *  · `isi statistics system --format json` 의 행 모양·필드 이름. 그래서 셋을 받는다: ① 행 객체 배열 ② `{stats|nodes:[…]}` ③ 그 밖 = 못 읽음(null).
 *    필드 이름은 대소문자·밑줄·공백을 지우고 비교한다(`Disk In` · `disk_in` · `diskIn` 모두 `diskin`).
 *  못 읽은 값은 0 이 아니라 **필드를 만들지 않는다**(numOrNull 규약) — 화면은 키가 없는 장비에서 디스크·CPU 버튼을 그리지 않는다.
 */
import { numOrNull } from '../../util/numOrNull.js';

/** REST `statistics/current` 에 더하는 키(노드별 — devid=all). */
export const ISI_NODE_LOAD_REST_KEYS = Object.freeze(['node.disk.bytes.in.rate.sum', 'node.disk.bytes.out.rate.sum', 'node.cpu.idle.avg']);
/** SSH 세션에 더하는 명령 1개(사용자 입력이 섞이지 않는 고정 문자열). */
export const ISI_SYSTEM_STATS_CMD = 'isi statistics system --nodes all --format json';
export const ISI_SYSTEM_STATS_SOURCE = 'isi statistics system';
export const ISI_REST_LOAD_SOURCE = 'REST node.disk.bytes.*.rate.sum · node.cpu.idle.avg';

/** 음이 아닌 유한수만(B/s). */
export function rateOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= 0 ? n : null;
}
/** REST `node.cpu.idle.avg`(1/10 % 가정) → CPU 사용률 %(소수 1자리). 0~1000 밖은 null. */
export function cpuPctFromIdlePermille(v) {
  const n = numOrNull(v);
  if (n == null || n < 0 || n > 1000) return null;
  return Math.round((1000 - n)) / 10;
}
/** SSH 출력의 CPU 칸 → %. 숫자·'12.3'·'12.3%' 를 받고 0~100 밖은 null. */
export function cpuPctOf(v) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim().replace(/%$/, '') : v;
  const n = numOrNull(s);
  return n != null && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

/** REST 노드 통계 맵(키 → 값)에서 디스크·CPU 필드. 키가 없으면 그 필드를 만들지 않는다. */
export function restNodeLoadFields(st) {
  const has = (k) => !!st && Object.prototype.hasOwnProperty.call(st, k);
  const out = {};
  if (has('node.disk.bytes.in.rate.sum')) { const v = rateOrNull(st['node.disk.bytes.in.rate.sum']); if (v != null) out.diskInBytesPs = v; }
  if (has('node.disk.bytes.out.rate.sum')) { const v = rateOrNull(st['node.disk.bytes.out.rate.sum']); if (v != null) out.diskOutBytesPs = v; }
  if (has('node.cpu.idle.avg')) { const v = cpuPctFromIdlePermille(st['node.cpu.idle.avg']); if (v != null) out.cpuPct = v; }
  return out;
}

const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_KEYS = new Set(['node', 'lnn', 'devid', 'nodeid', 'id']);
const DIN_KEYS = new Set(['diskin', 'diskinrate', 'diskbytesin', 'diskwrite', 'diskwritebytes']);
const DOUT_KEYS = new Set(['diskout', 'diskoutrate', 'diskbytesout', 'diskread', 'diskreadbytes']);
const CPU_KEYS = new Set(['cpu', 'cpupct', 'cpupercent', 'cpuusage']);

/**
 * `isi statistics system --nodes all --format json` → Map(lnn → {diskInBytesPs?, diskOutBytesPs?, cpuPct?}).
 * 못 읽으면 null(형식 불명) · 읽었는데 노드 행이 없으면 빈 Map. 클러스터 합계 행('All'·'Cluster')은 뺀다.
 * 입력 길이는 1MB 로 자른다(장비 출력은 외부 입력 — 정규식 없이 JSON.parse 한 번).
 */
export function parseIsiSystemStats(text) {
  const s = String(text ?? '').slice(0, 1_048_576).trim();
  if (!s) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  const list = Array.isArray(j) ? j : Array.isArray(j?.stats) ? j.stats : Array.isArray(j?.nodes) ? j.nodes : null;
  if (!list) return null;
  const out = new Map();
  for (const row of list.slice(0, 512)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    let id = null; const v = {};
    for (const [k0, val] of Object.entries(row)) {
      const k = keyOf(k0);
      if (ID_KEYS.has(k)) { const n = numOrNull(val); if (n != null && Number.isSafeInteger(n) && n >= 0) id = n; }
      else if (DIN_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.diskInBytesPs = n; }
      else if (DOUT_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.diskOutBytesPs = n; }
      else if (CPU_KEYS.has(k)) { const n = cpuPctOf(val); if (n != null) v.cpuPct = n; }
    }
    if (id == null || out.has(id)) continue;
    out.set(id, v);
  }
  return out;
}

/** 몇 대에서 무엇을 읽었는지 — 화면이 '디스크 키 없음' 을 밝히는 근거(조용히 비우지 않는다). */
export function nodeLoadProbeOf(list, source) {
  const nodes = Array.isArray(list) ? list.filter((n) => n && typeof n === 'object') : [];
  const cnt = (f) => nodes.filter((n) => n[f] != null).length;
  return { source, total: nodes.length, disk: Math.max(cnt('diskInBytesPs'), cnt('diskOutBytesPs')), cpu: cnt('cpuPct') };
}

/**
 * SSH 결과를 정규화 스냅샷의 노드 목록에 붙인다(lnn = `nodes.list[].id`). `parsed` 가 null 이면 사유만 남긴다.
 * @param {object} snap 정규화 스냅샷(제자리 수정)
 * @param {Map|null} parsed parseIsiSystemStats 결과
 * @param {{budget?:boolean, failed?:boolean}} [why]
 */
export function applyIsiSystemStats(snap, parsed, why = {}) {
  if (!snap?.nodes || !Array.isArray(snap.nodes.list) || !snap.nodes.list.length) return snap;
  snap.extra = snap.extra || {};
  if (!(parsed instanceof Map)) {
    snap.extra.nodeLoadProbe = { source: ISI_SYSTEM_STATS_SOURCE, total: snap.nodes.list.length, disk: 0, cpu: 0,
      reason: why.budget ? 'budget' : why.failed ? 'exec' : 'parse' };
    return snap;
  }
  for (const n of snap.nodes.list) {
    const v = n && parsed.get(Number(n.id));
    if (v) Object.assign(n, v);
  }
  snap.extra.nodeLoadProbe = nodeLoadProbeOf(snap.nodes.list, ISI_SYSTEM_STATS_SOURCE);
  if (!parsed.size) snap.extra.nodeLoadProbe.reason = 'empty';
  return snap;
}
