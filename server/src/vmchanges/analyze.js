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

const DAY = 86_400_000;
/** 7일에 10번 — 기간에 비례해 늘린다(14일이면 20). VM 하나가 이 이상 옮겨 다니면 '과다 이동' 후보다. */
export const CHURN_PER_WEEK = 10;
export const churnThreshold = (days) => Math.max(3, Math.ceil(CHURN_PER_WEEK * Math.max(1, days) / 7));
export const VM_ROWS_MAX = 1000;
export const EVENT_ROWS_MAX = 1000;

export function analyzeMoves(rows, { days = 7, now = Date.now(), vcName = new Map(), q = '' } = {}) {
  const moves = (rows || []).filter((r) => MOVE_TYPES.includes(r.type));
  const qq = String(q || '').toLowerCase();
  const byKind = { drs: 0, vmotion: 0, svmotion: 0, both: 0, relocate: 0 };
  const byVm = new Map();
  const byDay = new Map();
  let noDetail = 0;
  for (const r of moves) {
    const d = parseDetail(r.detail);
    if (!d) noDetail += 1;
    const kind = d?.kind && Object.hasOwn(byKind, d.kind) ? d.kind : moveKind(r.type, d);
    byKind[kind] += 1;
    const day = Math.floor((r.ts + 9 * 3_600_000) / DAY);   // 한국 날짜(UTC+9)로 묶는다 — 사람이 세는 하루
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
  const thr = churnThreshold(days);
  let vms = [...byVm.values()].map((v) => ({ ...v, hosts: v.hosts.size, churn: v.moves >= thr }));
  const churnVms = vms.filter((v) => v.churn).length;
  if (qq) vms = vms.filter((v) => [v.vm, v.vcenterName].some((x) => String(x || '').toLowerCase().includes(qq)));
  vms.sort((a, b) => b.moves - a.moves || (b.last ?? 0) - (a.last ?? 0) || String(a.vm).localeCompare(String(b.vm)));
  const matched = vms.length;
  // 하루 칸 — 기간 전체(빈 날은 0 이 아니라 '이벤트 없음' 이지만, 수집이 켜져 있었다면 0 이 맞다 — 화면이 수집 범위를 함께 말한다).
  const today = Math.floor((now + 9 * 3_600_000) / DAY);
  const series = [];
  for (let d = today - Math.max(1, days) + 1; d <= today; d++) series.push({ day: d * DAY - 9 * 3_600_000, moves: byDay.get(d) || 0 });
  return { total: moves.length, byKind, noDetail, churnThreshold: thr, churnVms, vmCount: byVm.size, series, matched, vms: vms.slice(0, VM_ROWS_MAX), omitted: Math.max(0, matched - VM_ROWS_MAX) };
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

export function analyzeChanges(rows, { vcName = new Map(), q = '', kind = '' } = {}) {
  const list = (rows || []).filter((r) => RECONFIG_TYPES.includes(r.type) || PERM_TYPES.includes(r.type));
  const qq = String(q || '').toLowerCase();
  const byKind = { reconfig: 0, permission: 0, role: 0 };
  const byUser = new Map();
  let noDetail = 0;
  const events = [];
  for (const r of list) {
    const d = parseDetail(r.detail);
    if (!d) noDetail += 1;
    const s = changeSummary(r.type, d);
    byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    const u = r.user || '(사용자 미상)';
    byUser.set(u, (byUser.get(u) || 0) + 1);
    if (kind && s.kind !== kind) continue;
    if (qq && ![r.entity, r.user, vcName.get(r.vcenterId), s.principal].some((x) => String(x || '').toLowerCase().includes(qq))) continue;
    events.push({ ts: r.ts, vcenterId: r.vcenterId, vcenterName: vcName.get(r.vcenterId) || r.vcenterId, type: r.type, user: r.user || '', entity: r.entity || '', message: r.message || '', ...s, hasDetail: !!d });
  }
  const users = [...byUser].map(([user, n]) => ({ user, n })).sort((a, b) => b.n - a.n || a.user.localeCompare(b.user)).slice(0, 50);
  return { total: list.length, byKind, noDetail, users, matched: events.length, events: events.slice(0, EVENT_ROWS_MAX), omitted: Math.max(0, events.length - EVENT_ROWS_MAX) };
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
