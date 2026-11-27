/**
 * vmchanges/analyze.js — 특수 기능 'VM 이동·구성 변경 이력'(도구 키 `vm-changes`, v2.702 — A7·A8) 판정(순수).
 * 입력은 logs DB 의 추적 이벤트 행(trackedEvents) — vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 이벤트는 vCenter 로그 수집이 켜진 동안 **이 포탈이 받아 둔 것** 만이다(vCenter 자체 보관은 짧다). 수집 전·보관 기간 밖은 없다.
 *  · VM 은 이벤트의 엔티티 **이름** 으로 묶는다 — 같은 vCenter 의 동명 VM 은 구분하지 못한다(전원 꺼짐 판정과 같은 한계).
 *  · 상세(detail)는 v2.702 부터 쌓는다 — 그 전 이벤트는 출발·도착을 모른다('—'). 개수는 센다.
 *  · 행을 상한으로 자르면 truncated 로 밝힌다(조용한 상한 금지).
 */
import { MOVE_TYPES, RECONFIG_TYPES, PERM_TYPES, parseDetail, moveKind } from './eventDetail.js';
import { dayIndex, dayStartMs } from '../util/dayKey.js';   // v2.727(감사 C-03): 날짜 경계는 포탈 오프셋(util/dayKey.js) 하나 — KST 상수 금지
import { FUTURE_CLOCK_TOLERANCE_MS } from '../logs/clockTolerance.js';   // 69회차 F2: 미래 행 경계 — 폴러 · coverage · 가용성과 같은 값

/**
 * 69회차 F2(재현 — v2.783 L-B1 의 형제 경로): 이력 화면(이동 · 변경 · 생성/삭제)의 vCenter 별 '마지막으로 받은 이벤트 시각'.
 *   DB 에 남은 미래 행 1건(2099 등 — prune 은 ts < ? 라 남는다)이 원본 MAX 를 미래로 밀어, 화면의 '마지막 이벤트가 이틀 넘게 지난 vCenter'
 *   경고와 VM 상세의 지연 대체 판단이 영영 뜨지 않았다. 지금 + 여유(FUTURE_CLOCK_TOLERANCE_MS) 이하의 MAX 를 쓴다(가용성 · 수집 진단과 같은 경계).
 */
export const eventLastTsOf = (db, id, now = Date.now()) => db.lastTs(id, { maxTs: now + FUTURE_CLOCK_TOLERANCE_MS }) || null;
/** 이력 화면의 수집 범위 행(상한 200) — vm-changes · vm-lifecycle 이 같은 모양을 쓴다. nc = 지금 이벤트를 수집하지 않는 vCenter 사유 맵. */
export function eventCoverageRows(db, ids, { vcName = new Map(), nc = new Map(), now = Date.now() } = {}) {
  return (ids || []).slice(0, 200).map((id) => ({ vcenterId: id, name: vcName.get(id) || id, lastTs: eventLastTsOf(db, id, now), ...(nc.has(id) ? { notCollected: nc.get(id) } : {}) }));
}

/** 7일에 10번 — 기간에 비례해 늘린다(14일이면 20). VM 하나가 이 이상 옮겨 다니면 '과다 이동' 후보다. */
export const CHURN_PER_WEEK = 10;
export const churnThreshold = (days) => Math.max(3, Math.ceil(CHURN_PER_WEEK * Math.max(1, days) / 7));
export const VM_ROWS_MAX = 1000;
export const EVENT_ROWS_MAX = 1000;

/**
 * v2.932: 이동 집계를 조각마다 더하는 누적기 — 보고서가 행을 모으지 않고 흘려보내며 센다(logs/db.js trackedEventsEach).
 *   add(rows) 를 몇 번에 나눠 불러도 한 번에 부른 analyzeMoves 와 결과가 같다(테스트 대조 · 순서 무관 — 최신 판정은 ts 최대).
 */
/**
 * 결정(56~75 남긴 것) 69 ①: 하루 막대 칸 — **조회 시작 시각(since)이 걸친 날부터** 오늘까지. 예전에는 '오늘 − days + 1' 부터라
 *   since(now − days일)가 걸친 첫날의 이벤트가 KPI 합계(생성 · 이동 수)에는 들고 막대에는 없었다(KPI 합 ≠ 막대 합).
 *   첫날은 since 시각부터의 일부만 담으므로 그 칸에 partialFrom(since)을 싣는다(화면이 '그 시각부터' 로 밝힌다). vm-lifecycle 과 한 벌.
 * @param {{days:number, now:number, since:number|null}} o  since 가 없으면 now − days일
 * @param {(d:number) => object} cellOf 날짜 번호 → 칸 값
 */
export function daySeries({ days = 7, now = Date.now(), since = null } = {}, cellOf) {
  const today = dayIndex(now);
  const from = Number.isFinite(since) ? since : now - Math.max(1, days) * 86_400_000;
  const first = Math.min(today, dayIndex(from));
  const out = [];
  for (let d = first; d <= today; d++) {
    const day = dayStartMs(d);
    out.push({ day, ...cellOf(d), ...(d === first && from > day ? { partialFrom: from } : {}) });
  }
  return out;
}

export function createMovesAcc({ days = 7, now = Date.now(), since = null, vcName = new Map(), q = '' } = {}) {
  const byKind = { drs: 0, vmotion: 0, svmotion: 0, both: 0, relocate: 0 };
  const byVm = new Map();
  const byDay = new Map();
  let noDetail = 0; let total = 0;
  return {
    add(rows) {
      for (const r of rows || []) {
        if (!MOVE_TYPES.includes(r.type)) continue;
        total += 1;
        const d = parseDetail(r.detail);
        if (!d) noDetail += 1;
        const kind = d?.kind && Object.hasOwn(byKind, d.kind) ? d.kind : moveKind(r.type, d);
        byKind[kind] += 1;
        const day = dayIndex(r.ts);   // 포탈 오프셋 날짜(기본 KST)로 묶는다 — 사람이 세는 하루. v2.727: dayKey 코어 사용(PORTAL_TZ_OFFSET_MIN 을 따른다)
        byDay.set(day, (byDay.get(day) || 0) + 1);
        const k = `${r.vcenterId}\u0000${r.entity}`;
        let v = byVm.get(k);
        if (!v) { v = { vcenterId: r.vcenterId, vcenterName: vcName.get(r.vcenterId) || r.vcenterId, vm: r.entity, moves: 0, drs: 0, manual: 0, storage: 0, hosts: new Set(), last: null, lastFrom: null, lastTo: null }; byVm.set(k, v); }
        v.moves += 1;
        if (kind === 'drs') v.drs += 1; else v.manual += 1;
        if (kind === 'svmotion' || kind === 'both') v.storage += 1;
        if (d?.to) v.hosts.add(d.to);
        if (d?.from) v.hosts.add(d.from);
        if (v.last == null || r.ts > v.last) { v.last = r.ts; v.lastFrom = d?.from ?? null; v.lastTo = d?.to ?? null; }
      }
    },
    result({ since: sinceAt = since } = {}) {   // 69 ①: 라우트가 행을 읽은 뒤 그 조회의 since 를 넘긴다(같은 시각으로 첫날을 정한다)
      const qq = String(q || '').toLowerCase();
      const thr = churnThreshold(days);
      let vms = [...byVm.values()].map((v) => ({ ...v, hosts: v.hosts.size, churn: v.moves >= thr }));
      const churnVms = vms.filter((v) => v.churn).length;
      if (qq) vms = vms.filter((v) => [v.vm, v.vcenterName].some((x) => String(x || '').toLowerCase().includes(qq)));
      vms.sort((a, b) => b.moves - a.moves || (b.last ?? 0) - (a.last ?? 0) || String(a.vm).localeCompare(String(b.vm)));
      const matched = vms.length;
      // 하루 칸 — 기간 전체(빈 날은 0 이 아니라 '이벤트 없음' 이지만, 수집이 켜져 있었다면 0 이 맞다 — 화면이 수집 범위를 함께 말한다).
      const series = daySeries({ days, now, since: sinceAt }, (d) => ({ moves: byDay.get(d) || 0 }));
      return { total, byKind, noDetail, churnThreshold: thr, churnVms, vmCount: byVm.size, series, matched, vms: vms.slice(0, VM_ROWS_MAX), omitted: Math.max(0, matched - VM_ROWS_MAX) };
    },
  };
}
export function analyzeMoves(rows, opts = {}) {
  const acc = createMovesAcc(opts);
  acc.add(rows);
  return acc.result();
}

function changeSummary(type, d) {
  if (RECONFIG_TYPES.includes(type)) {
    if (!d) return { kind: 'reconfig', lines: [] };
    const lines = [];
    for (const k of ['modified', 'added', 'deleted']) if (d[k]) lines.push({ k, text: d[k] });
    return { kind: 'reconfig', lines, fields: Array.isArray(d.fields) ? d.fields : [], devices: Array.isArray(d.devices) ? d.devices : [], numCpu: d.numCpu ?? null, memoryMB: d.memoryMB ?? null };
  }
  if (PERM_TYPES.includes(type)) {
    return { kind: type.startsWith('Role') ? 'role' : 'permission', principal: d?.principal ?? null, role: d?.role ?? null, group: d?.group ?? null, propagate: d?.propagate ?? null };
  }
  return { kind: 'other' };
}

/**
 * v2.932: 구성 · 권한 변경 집계 누적기 — 행을 최신 먼저 흘려 넣으면(trackedEventsEach 순서) 목록은 최신 EVENT_ROWS_MAX 건,
 *   개수 · 사용자별 수는 넣은 행 전부다. 한 번에 부른 analyzeChanges 와 결과가 같다(테스트 대조).
 */
export function createChangesAcc({ vcName = new Map(), q = '', kind = '' } = {}) {
  const qq = String(q || '').toLowerCase();
  const byKind = { reconfig: 0, permission: 0, role: 0 };
  const byUser = new Map();
  let noDetail = 0; let total = 0; let matched = 0;
  const events = [];
  return {
    add(rows) {
      for (const r of rows || []) {
        if (!(RECONFIG_TYPES.includes(r.type) || PERM_TYPES.includes(r.type))) continue;
        total += 1;
        const d = parseDetail(r.detail);
        if (!d) noDetail += 1;
        const s = changeSummary(r.type, d);
        byKind[s.kind] = (byKind[s.kind] || 0) + 1;
        const u = r.user || '(사용자 미상)';
        byUser.set(u, (byUser.get(u) || 0) + 1);
        if (kind && s.kind !== kind) continue;
        if (qq && ![r.entity, r.user, vcName.get(r.vcenterId), s.principal].some((x) => String(x || '').toLowerCase().includes(qq))) continue;
        matched += 1;
        if (events.length >= EVENT_ROWS_MAX) continue;   // 목록은 최신 상한까지만 들고 있는다(개수는 계속 센다)
        events.push({ ts: r.ts, vcenterId: r.vcenterId, vcenterName: vcName.get(r.vcenterId) || r.vcenterId, type: r.type, user: r.user || '', entity: r.entity || '', message: r.message || '', ...s, hasDetail: !!d });
      }
    },
    result() {
      const users = [...byUser].map(([user, n]) => ({ user, n })).sort((a, b) => b.n - a.n || a.user.localeCompare(b.user)).slice(0, 50);
      return { total, byKind, noDetail, users, matched, events, omitted: Math.max(0, matched - EVENT_ROWS_MAX) };
    },
  };
}
export function analyzeChanges(rows, opts = {}) {
  const acc = createChangesAcc(opts);
  acc.add(rows);
  return acc.result();
}

/** VM 상세 창용 — 그 VM 의 최근 이동·구성 변경(이미 entity 로 좁힌 행). */
export function vmHistory(rows, limit = 20) {
  const out = [];
  for (const r of rows || []) {
    const d = parseDetail(r.detail);
    if (MOVE_TYPES.includes(r.type)) out.push({ ts: r.ts, cat: 'move', kind: d?.kind || moveKind(r.type, d), from: d?.from ?? null, to: d?.to ?? null, fromDs: d?.fromDs ?? null, toDs: d?.toDs ?? null, user: r.user || '' });
    else if (RECONFIG_TYPES.includes(r.type)) out.push({ ts: r.ts, cat: 'change', ...changeSummary(r.type, d), user: r.user || '', message: r.message || '' });
    if (out.length >= limit) break;
  }
  return out;
}
