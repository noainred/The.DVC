/**
 * bmstor/history.js — 베어메탈 스토리지 디스크 사용량 **이력**의 판정(순수, v2.635).
 *
 * 사용자 요청(2026-09-28): "서버별 그룹별 디스크 사용량과 디스크 사용량의 합을 12시간마다 수집해서 별도의 DB 에
 * 저장해서 1일/7일/1달/반기/분기 별로 디스크 사용량을 차트로 볼 수 있게".
 *
 * 수집 자체는 기존 폴러(`poller.js`, 기본 10분)가 한다. 이 모듈은 그 **최신 결과**를 12시간 슬롯마다 한 번 떼어
 * (서버 · 그룹 · 합계) 행으로 만든다 — 장비에 다시 접속하지 않는다.
 *
 * ── 이 모듈이 막는 거짓 ─────────────────────────────────────────────────────
 *  ① **낡은 값을 지금 값으로 적재하지 않는다** — 폴러가 멈춰도 `latest` 에는 마지막 값이 남는다. 수집 시각이
 *     `freshMs`(수집 주기 × 3, 최소 30분)를 넘긴 서버는 '못 읽음' 으로 센다(v2.504 iDRAC 규약과 같다).
 *  ② **부분 합을 온전한 합처럼 적재하지 않는다** — 그룹·합계에 못 읽은 서버가 있으면 그 행은 `partial` 이고
 *     `read`/`servers` 로 몇 대를 더했는지 남긴다. 화면은 그 점을 선으로 잇지 않는다(부분 합 = 거짓 하락, v2.606 규약).
 *     한 대도 못 읽었으면 행을 만들지 않는다(0 바이트는 '비었다' 는 거짓이다).
 *  ③ 서버 한 대라도 등록 마운트를 찾지 못했으면(`missing`) 그 서버 합도 부분 합이다.
 *  ④ 비활성 서버는 현황 화면과 같이 합계·그룹에서 뺀다(`agg.js aggregate` 규칙을 그대로 쓴다 — 판정 복제 금지).
 */
import { aggregate, groupsOf } from './agg.js';

const HOUR = 3_600_000;
/** 한국 시각 기준(v2.531 `DAY_OFFSET_MIN` 과 같은 이유 — 사람이 세는 오전/오후 경계). */
const KST_OFFSET_MS = 9 * HOUR;

/** 기본 적재 간격(사용자 요청 12시간). env 로 1~24시간 사이에서 바꿀 수 있다. */
export function historyIntervalHours() {
  const raw = process.env.BMSTOR_HISTORY_INTERVAL_HOURS;
  const v = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) return 12;
  return Math.min(24, Math.max(1, Math.floor(v)));
}

/** 보존일(기본 5년 = 1825일). `0` = 전부 보관. 빈 값은 미지정(v2.618 numEnv 규약 — 빈 줄이 '무제한' 이 되지 않게). */
export function historyRetentionDays() {
  const raw = process.env.BMSTOR_HISTORY_RETENTION_DAYS;
  const v = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v) || v < 0) return 1825;
  return Math.floor(v);
}

/** 슬롯 번호 — KST 0시·12시(간격 12시간 기준)에 바뀐다. 한 슬롯에 한 번만 적재한다. */
export function slotOf(ts, intervalHours = historyIntervalHours()) {
  const iv = Math.max(1, Number(intervalHours) || 12) * HOUR;
  return Math.floor((Number(ts) + KST_OFFSET_MS) / iv);
}

/** 슬롯 시작 시각(ms, epoch). */
export function slotStart(slot, intervalHours = historyIntervalHours()) {
  const iv = Math.max(1, Number(intervalHours) || 12) * HOUR;
  return Number(slot) * iv - KST_OFFSET_MS;
}

/** 수집 결과가 '지금 값' 으로 볼 만큼 신선한가의 경계(ms). 폴러 주기 × 3, 최소 30분. */
export function freshMsFor(intervalMinutes) {
  const m = Number(intervalMinutes);
  const iv = Number.isFinite(m) && m > 0 ? m * 60_000 : 10 * 60_000;
  return Math.max(30 * 60_000, iv * 3);
}

/**
 * 최신 결과 → 이력 행.
 * @param {Array} servers  listBmServers() 결과
 * @param {Map} latest     poller.getBmLatest()
 * @param {object} o
 * @param {number} o.now
 * @param {number} o.freshMs
 * @returns {{ rows: Array<{kind,key,name,totalBytes,usedBytes,availBytes,servers,read,partial}>, stale:number, excluded:number }}
 */
export function buildHistoryRows(servers, latest, { now = Date.now(), freshMs = freshMsFor(10) } = {}) {
  // ① 신선하고 성공한 결과만 남긴 사본으로 기존 합산기를 돌린다(판정은 agg.js 하나).
  const fresh = new Map();
  let stale = 0;
  for (const [id, r] of (latest instanceof Map ? latest : new Map())) {
    if (!r) continue;
    const at = Number(r.at);
    if (!Number.isFinite(at) || now - at > freshMs) { stale += 1; continue; }
    fresh.set(id, r);
  }
  const list = Array.isArray(servers) ? servers : [];
  const { total, groups, perServer } = aggregate(list, fresh);
  const rows = [];
  // ③ 등록 마운트를 못 찾은 서버는 부분 합이다 — 그 서버가 들어간 그룹·합계도 부분 합이 된다.
  const partialServer = new Set();
  let excluded = 0;
  for (const s of perServer) {
    if (!s.enabled) continue;
    if (!s.ok) { excluded += 1; continue; }
    const part = (s.missing || []).length > 0;
    if (part) partialServer.add(s.id);
    rows.push({ kind: 'server', key: String(s.id), name: String(s.name || s.host || s.id), totalBytes: s.totalBytes, usedBytes: s.usedBytes, availBytes: s.availBytes, servers: 1, read: 1, partial: part });
  }
  const groupPartial = new Map();
  for (const s of list) {
    if (s?.enabled === false || !partialServer.has(s.id)) continue;
    for (const g of groupsOf(s).length ? groupsOf(s) : ['']) groupPartial.set(g, true);
  }
  for (const g of groups) {
    if (!g.ok) continue;                                  // ② 한 대도 못 읽었으면 행을 만들지 않는다
    const key = g.name === '(그룹 없음)' ? '' : g.name;
    rows.push({ kind: 'group', key, name: g.name, totalBytes: g.totalBytes, usedBytes: g.usedBytes, availBytes: g.availBytes, servers: g.servers, read: g.ok, partial: g.ok < g.servers || !!groupPartial.get(key) });
  }
  if (total.ok > 0) {
    rows.push({ kind: 'total', key: '', name: '전체 합계', totalBytes: total.totalBytes, usedBytes: total.usedBytes, availBytes: total.availBytes, servers: total.servers, read: total.ok, partial: total.ok < total.servers || partialServer.size > 0 });
  }
  return { rows, stale, excluded };
}

/**
 * 차트 기간(사용자 요청 1일/7일/1달/분기/반기). 길이 순서로 둔다.
 * ⚠ 12시간 간격이면 '1일' 은 점이 2~3개뿐이다 — 화면이 그 사실을 말한다(`pointsNote`).
 */
export const HISTORY_PERIODS = Object.freeze([
  { key: '1d', label: '1일', days: 1 },
  { key: '7d', label: '7일', days: 7 },
  { key: '1m', label: '1달', days: 30 },
  { key: '3m', label: '분기', days: 91 },
  { key: '6m', label: '반기', days: 182 },
]);
export function historyPeriodOf(key) {
  return HISTORY_PERIODS.find((p) => p.key === key) || HISTORY_PERIODS[1];
}

/**
 * DB 행(시간 오름차순) → 계열 목록. 서버 계열은 **현재 등록부 이름**을 쓰고, 삭제된 서버는 `deleted` 로 밝힌다
 * (지우지 않는다 — 기간 안의 사실이다).
 */
export function seriesFromRows(rows, { servers = [] } = {}) {
  const nameById = new Map((Array.isArray(servers) ? servers : []).map((s) => [String(s.id), String(s.name || s.host || s.id)]));
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = `${r.kind}|${r.key}`;
    if (!map.has(id)) {
      const deleted = r.kind === 'server' && !nameById.has(String(r.key));
      const name = r.kind === 'server' ? (nameById.get(String(r.key)) || r.name || r.key)
        : r.kind === 'group' ? (r.key ? r.key : '(그룹 없음)') : '전체 합계';
      map.set(id, { kind: r.kind, key: r.key, name, deleted, points: [] });
    }
    map.get(id).points.push({
      ts: Number(r.ts), totalBytes: r.totalBytes, usedBytes: r.usedBytes, availBytes: r.availBytes,
      servers: r.servers, read: r.read, partial: !!r.partial,
    });
  }
  const order = { total: 0, group: 1, server: 2 };
  return [...map.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.name).localeCompare(String(b.name), 'ko', { numeric: true }));
}
