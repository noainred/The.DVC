/**
 * vmlife/analyze.js — 특수 기능 'VM 생성·삭제 이력'(도구 키 `vm-lifecycle`, v2.706 — C5) 판정(순수).
 * 입력은 logs DB 의 운영 이벤트 중 생성·삭제 계열(opsEvents — LIFE_TYPES). vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 이벤트는 vCenter 로그 수집이 켜진 동안 **이 포탈이 받아 둔 것** 만이다(vCenter 자체 보관은 짧다).
 *  · VmRemovedEvent 는 '디스크에서 삭제' 와 '인벤토리에서만 제거' 를 **구분하지 않는다**(vSphere 이벤트가 같다) — 화면이 말한다.
 *  · VM 은 이벤트의 엔티티 **이름** 으로 묶는다 — 같은 vCenter 의 동명 VM 은 구분하지 못한다.
 *  · 상세(호스트·DS·원본)는 v2.706 부터 쌓는다 — 그 전 이벤트는 '—' 이고 개수(noDetail)를 센다.
 *  · 상한으로 자르면 omitted 로 밝힌다(조용한 상한 금지).
 */
import { LIFE_TYPES, LIFE_KIND, parseDetail } from '../vmchanges/eventDetail.js';
import { dayIndex, dayStartMs } from '../util/dayKey.js';   // v2.727(감사 C-03): 날짜 경계는 포탈 오프셋(util/dayKey.js) 하나 — KST 상수 금지

export const LIFE_ROWS_MAX = 1000;
const ADD_KINDS = new Set(['create', 'clone', 'deploy', 'register']);

export const kindOfLife = (type, d) => (d?.kind && Object.values(LIFE_KIND).includes(d.kind) ? d.kind : LIFE_KIND[type] || null);

/**
 * @param rows   opsEvents 행(최신 먼저 — 순서는 상관없다)
 * @param opts   { days, now, vcName:Map, q, kind, liveNames:Map<vcenterId, Set<name>> }
 */
export function analyzeLifecycle(rows, { days = 7, now = Date.now(), vcName = new Map(), q = '', kind = '', liveNames = null } = {}) {
  const list = (rows || []).filter((r) => LIFE_TYPES.includes(r.type));
  const byKind = { create: 0, clone: 0, deploy: 0, register: 0, remove: 0, rename: 0 };
  const byDay = new Map();
  const byUser = new Map();
  const firstAdd = new Map();     // vc\0name -> 가장 이른 추가 ts
  const lastRemove = new Map();   // vc\0name -> 가장 늦은 삭제 ts
  let noDetail = 0;
  const qq = String(q || '').toLowerCase();
  const events = [];
  for (const r of list) {
    const d = parseDetail(r.detail);
    if (!d) noDetail += 1;
    const k = kindOfLife(r.type, d);
    if (!k) continue;
    byKind[k] += 1;
    const day = dayIndex(r.ts);   // v2.727(감사 C-03): 포탈 오프셋 날짜(기본 KST)
    const cell = byDay.get(day) || { added: 0, removed: 0 };
    if (ADD_KINDS.has(k)) cell.added += 1; else if (k === 'remove') cell.removed += 1;
    byDay.set(day, cell);
    const u = r.user || '(사용자 미상)';
    const uc = byUser.get(u) || { user: u, added: 0, removed: 0, other: 0 };
    if (ADD_KINDS.has(k)) uc.added += 1; else if (k === 'remove') uc.removed += 1; else uc.other += 1;
    byUser.set(u, uc);
    const key = `${r.vcenterId}\u0000${r.entity}`;
    if (ADD_KINDS.has(k) && (!firstAdd.has(key) || r.ts < firstAdd.get(key))) firstAdd.set(key, r.ts);
    if (k === 'remove' && (!lastRemove.has(key) || r.ts > lastRemove.get(key))) lastRemove.set(key, r.ts);
    // 지금 인벤토리에 있는가 — 이름으로만 안다(동명 VM 은 구분하지 못한다). liveNames 가 없으면 모른다(null).
    const live = liveNames?.get(r.vcenterId);
    const existsNow = live ? live.has(r.entity) : null;
    events.push({
      ts: r.ts, vcenterId: r.vcenterId, vcenterName: vcName.get(r.vcenterId) || r.vcenterId, type: r.type, kind: k,
      vm: r.entity || '', user: r.user || '', host: d?.host ?? null, ds: d?.ds ?? null, source: d?.source ?? null,
      oldName: d?.oldName ?? null, newName: d?.newName ?? null, existsNow, hasDetail: !!d,
    });
  }
  // 단명 VM — 이 기간 안에 추가된 뒤 삭제된 VM(같은 vCenter·같은 이름). 테스트·임시 VM 의 흔적이다.
  const shortLived = [];
  for (const [key, addTs] of firstAdd) {
    const rmTs = lastRemove.get(key);
    if (rmTs != null && rmTs >= addTs) {
      const [vcenterId, vm] = key.split('\u0000');
      shortLived.push({ vcenterId, vcenterName: vcName.get(vcenterId) || vcenterId, vm, added: addTs, removed: rmTs, lifeMs: rmTs - addTs });
    }
  }
  shortLived.sort((a, b) => a.lifeMs - b.lifeMs || String(a.vm).localeCompare(String(b.vm)));
  let shown = events;
  if (kind === 'added') shown = shown.filter((e) => ADD_KINDS.has(e.kind));
  else if (kind && kind !== 'all') shown = shown.filter((e) => e.kind === kind);
  if (qq) shown = shown.filter((e) => [e.vm, e.user, e.vcenterName, e.host, e.source, e.oldName, e.newName].some((x) => String(x || '').toLowerCase().includes(qq)));
  shown.sort((a, b) => b.ts - a.ts || String(a.vm).localeCompare(String(b.vm)));
  const today = dayIndex(now);
  const series = [];
  for (let d = today - Math.max(1, days) + 1; d <= today; d++) {
    const c = byDay.get(d) || { added: 0, removed: 0 };
    series.push({ day: dayStartMs(d), added: c.added, removed: c.removed });
  }
  const added = byKind.create + byKind.clone + byKind.deploy + byKind.register;
  const users = [...byUser.values()].sort((a, b) => (b.added + b.removed + b.other) - (a.added + a.removed + a.other) || a.user.localeCompare(b.user)).slice(0, 50);
  return {
    total: list.length, byKind, added, removed: byKind.remove, net: added - byKind.remove, noDetail,
    series, users, shortLivedCount: shortLived.length, shortLived: shortLived.slice(0, 200),
    matched: shown.length, events: shown.slice(0, LIFE_ROWS_MAX), omitted: Math.max(0, shown.length - LIFE_ROWS_MAX),
  };
}
