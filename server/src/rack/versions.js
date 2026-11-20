/**
 * rack/versions.js — 랙 실장도 법인별 '판'(스냅샷)의 순수 판정(2026-11-20 사용자 요청 '법인별 최근 30개 저장' · 선택 '판 30개 + 되돌리기').
 *
 * 판 = 한 법인의 원장 전체(데이터센터 · 전산실 · 랙 · 장비 배치)를 변경이 저장된 직후의 모습으로 담은 것. 저장 · 되돌리기는 db.js 가 하고,
 * 여기는 모양 만들기 · 모양 검사 · 두 판의 차이 계산만 한다(부작용 없음 — 테스트가 직접 부른다).
 * 측정값(상태 · 온도 · 전력)과 전산실 rev · 변경 이력은 판에 넣지 않는다(rev 는 되돌릴 때 새로 올린다 — 열려 있는 편집 화면이 옛 판으로 덮어쓰지 못하게).
 */

export const VERSION_KEEP = 30;          // 법인마다 남기는 판 수(사용자 요청)
export const SNAPSHOT_FORMAT = 1;

const S = (v, max = 600) => (typeof v === 'string' ? v.slice(0, max) : '');
const I = (v) => (Number.isInteger(v) ? v : null);
const N = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ID_RE = /^[a-f0-9]{16}$/;

/** db 행(정리된 모양) → 판. 정렬해 같은 원장이면 같은 글자가 나오게 한다. */
export function buildSnapshot(corpId, { sites = [], rooms = [], racks = [], places = [] }) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    format: SNAPSHOT_FORMAT,
    corpId,
    sites: sites.map((s) => ({ id: s.id, name: s.name, sort: s.sort })).sort(byId),
    rooms: rooms.map((r) => ({ id: r.id, siteId: r.siteId, name: r.name, sort: r.sort })).sort(byId),
    racks: racks.map((r) => ({ id: r.id, roomId: r.roomId, name: r.name, row: r.row, typeId: r.typeId, heightU: r.heightU, role: r.role, pduA: r.pduA, pduB: r.pduB, sort: r.sort })).sort(byId),
    places: places.map((p) => ({
      id: p.id, rackId: p.rackId, face: p.face, uStart: p.uStart, uSize: p.uSize, kind: p.kind, label: p.label, model: p.model,
      serial: p.serial, extraSerials: p.extraSerials || [], note: p.note, ratedW: p.ratedW ?? null, opW: p.opW ?? null, weightKg: p.weightKg ?? null,
    })).sort(byId),
  };
}

/**
 * 저장된 판을 되살릴 수 있는 모양인지 검사하고 정리한다(손상 · 다른 판 형식이면 null — 되돌리기를 거절한다).
 * 참조(장비 → 랙 → 전산실 → 데이터센터)가 판 안에서 닫혀 있어야 한다 — 끊어진 참조가 있으면 반쪽 원장을 만들지 않게 거절.
 */
export function validateSnapshot(snap, corpId) {
  if (!snap || typeof snap !== 'object' || snap.format !== SNAPSHOT_FORMAT || snap.corpId !== corpId) return null;
  const arr = (k) => (Array.isArray(snap[k]) ? snap[k] : null);
  const sites = arr('sites'); const rooms = arr('rooms'); const racks = arr('racks'); const places = arr('places');
  if (!sites || !rooms || !racks || !places) return null;
  if (sites.length > 1000 || rooms.length > 5000 || racks.length > 100_000 || places.length > 500_000) return null;
  const okId = (x) => typeof x?.id === 'string' && ID_RE.test(x.id);
  const siteIds = new Set(); const roomIds = new Set(); const rackIds = new Set(); const placeIds = new Set();
  const out = { sites: [], rooms: [], racks: [], places: [] };
  for (const s of sites) {
    if (!okId(s) || siteIds.has(s.id) || !S(s.name)) return null;
    siteIds.add(s.id); out.sites.push({ id: s.id, name: S(s.name, 64), sort: I(s.sort) ?? 0 });
  }
  for (const r of rooms) {
    if (!okId(r) || roomIds.has(r.id) || !siteIds.has(r.siteId) || !S(r.name)) return null;
    roomIds.add(r.id); out.rooms.push({ id: r.id, siteId: r.siteId, name: S(r.name, 64), sort: I(r.sort) ?? 0 });
  }
  for (const r of racks) {
    const h = I(r.heightU);
    if (!okId(r) || rackIds.has(r.id) || !roomIds.has(r.roomId) || !S(r.name) || h == null || h < 1 || h > 60) return null;
    rackIds.add(r.id);
    out.racks.push({ id: r.id, roomId: r.roomId, name: S(r.name, 64), row: S(r.row, 64), typeId: S(r.typeId, 40), heightU: h, role: S(r.role, 64), pduA: I(r.pduA) ?? 0, pduB: I(r.pduB) ?? 0, sort: I(r.sort) ?? 0 });
  }
  for (const p of places) {
    const u = I(p.uStart); const n = I(p.uSize);
    if (!okId(p) || placeIds.has(p.id) || !rackIds.has(p.rackId) || u == null || n == null || u < 1 || n < 1) return null;
    if (!['full', 'front', 'rear'].includes(p.face)) return null;
    placeIds.add(p.id);
    out.places.push({
      id: p.id, rackId: p.rackId, face: p.face, uStart: u, uSize: n, kind: S(p.kind, 16) || 'other', label: S(p.label, 96), model: S(p.model, 96),
      serial: S(p.serial, 64), extraSerials: Array.isArray(p.extraSerials) ? p.extraSerials.filter((x) => typeof x === 'string').slice(0, 16).map((x) => x.slice(0, 64)) : [],
      note: S(p.note, 300), ratedW: N(p.ratedW), opW: N(p.opW), weightKg: N(p.weightKg),
    });
  }
  return out;
}

/** 판의 크기 요약(목록 표시용). */
export const countsOf = (snap) => ({ sites: snap.sites.length, rooms: snap.rooms.length, racks: snap.racks.length, places: snap.places.length });

const PLACE_FIELDS = ['kind', 'label', 'model', 'serial', 'extraSerials', 'note', 'ratedW', 'opW', 'weightKg'];
const POS_FIELDS = ['rackId', 'face', 'uStart', 'uSize'];
const RACK_FIELDS = ['name', 'row', 'typeId', 'heightU', 'role', 'pduA', 'pduB', 'roomId'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 두 판의 차이 — from(지금) 을 to(고른 판) 로 바꾸면 무엇이 달라지는가.
 * @returns {{counts:object, items:Array<{type:string, op:'add'|'remove'|'move'|'change', id:string, name:string, where?:string, fields?:string[]}>, omitted:number}}
 */
export function diffSnapshots(from, to, { limit = 300 } = {}) {
  const items = [];
  const counts = { siteAdd: 0, siteRemove: 0, siteChange: 0, roomAdd: 0, roomRemove: 0, roomChange: 0, rackAdd: 0, rackRemove: 0, rackChange: 0, placeAdd: 0, placeRemove: 0, placeMove: 0, placeChange: 0 };
  const map = (list) => new Map((list || []).map((x) => [x.id, x]));
  const rackName = (snap) => { const m = map(snap.racks); return (id) => m.get(id)?.name || '?'; };
  const rnFrom = rackName(from); const rnTo = rackName(to);
  const posText = (p, rn) => `${rn(p.rackId)} U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}${p.face === 'front' ? '(앞)' : p.face === 'rear' ? '(뒤)' : ''}`;
  const push = (it) => items.push(it);
  const section = (type, a, b, fields, nameOf, extra = () => ({})) => {
    const ma = map(a); const mb = map(b);
    for (const [id, x] of mb) if (!ma.has(id)) { counts[`${type}Add`] += 1; push({ type, op: 'add', id, name: nameOf(x), ...extra(x, 'to') }); }
    for (const [id, x] of ma) if (!mb.has(id)) { counts[`${type}Remove`] += 1; push({ type, op: 'remove', id, name: nameOf(x), ...extra(x, 'from') }); }
    for (const [id, x] of ma) {
      const y = mb.get(id); if (!y) continue;
      const changed = fields.filter((f) => !same(x[f], y[f]));
      if (changed.length) { counts[`${type}Change`] += 1; push({ type, op: 'change', id, name: nameOf(y), fields: changed }); }
    }
  };
  section('site', from.sites, to.sites, ['name'], (x) => x.name);
  section('room', from.rooms, to.rooms, ['name', 'siteId'], (x) => x.name);
  section('rack', from.racks, to.racks, RACK_FIELDS, (x) => x.name);
  // 장비: 자리 이동과 정보 수정을 나눠 센다.
  const pa = map(from.places); const pb = map(to.places);
  const pname = (p) => p.label || '이름 없는 장비';
  for (const [id, p] of pb) if (!pa.has(id)) { counts.placeAdd += 1; push({ type: 'place', op: 'add', id, name: pname(p), where: posText(p, rnTo) }); }
  for (const [id, p] of pa) if (!pb.has(id)) { counts.placeRemove += 1; push({ type: 'place', op: 'remove', id, name: pname(p), where: posText(p, rnFrom) }); }
  for (const [id, p] of pa) {
    const q = pb.get(id); if (!q) continue;
    if (POS_FIELDS.some((f) => !same(p[f], q[f]))) { counts.placeMove += 1; push({ type: 'place', op: 'move', id, name: pname(q), where: `${posText(p, rnFrom)} → ${posText(q, rnTo)}` }); }
    const changed = PLACE_FIELDS.filter((f) => !same(p[f], q[f]));
    if (changed.length) { counts.placeChange += 1; push({ type: 'place', op: 'change', id, name: pname(q), fields: changed }); }
  }
  return { counts, items: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}
