/**
 * DataCenter(법인) 레지스트리 — vCenter의 '상위 개념'.
 *
 * 데이터 모델: 법인 = DataCenter, vCenter는 DataCenter에 속한다. 한 DataCenter는 0개 이상의
 * vCenter를 갖고, 그 안의 '물리 서버'는 iDRAC 스캔으로 수집한다(향후 독립 DB). 여기서는
 *   - DataCenter '종류'(목록)를 설정에서 사전 정의하고,
 *   - 각 vCenter를 어느 DataCenter에 둘지(assign) 저장한다.
 *
 * CONFIG_DIR/datacenters.json 에 보관: { datacenters: [{id,name,region,note}], assign: { vcenterId: datacenterId } }.
 * 무결성: 디스크 쓰기 성공 후에만 캐시 갱신, (mtime,size) 토큰으로 외부 변경 자동 무효화.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'datacenters.json');
const norm = (s) => String(s || '').trim();
const idOf = (s) => norm(s).toLowerCase();

let cache = null;
let cacheTok = '';

function fileTok() {
  try { const st = fs.statSync(FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

function loadRaw() {
  const t = fileTok();
  if (cache && t === cacheTok) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      datacenters: Array.isArray(p.datacenters) ? p.datacenters : [],
      assign: (p.assign && typeof p.assign === 'object') ? p.assign : {},
      // 관리자가 명시적으로 삭제한 DataCenter id(tombstone). 수집서버 백필(ensureDatacenter)이
      // 삭제한 법인을 매 조회마다 되살리던 문제 방지 — 명시적 재등록(addDatacenter) 시 해제.
      deleted: Array.isArray(p.deleted) ? p.deleted : [],
      // 사용자가 지정한 표시 순서(id 배열). 모든 'DataCenter 선택' 콤보박스/목록에 적용.
      order: Array.isArray(p.order) ? p.order.map(String) : [],
    };
  } catch { cache = { datacenters: [], assign: {}, deleted: [], order: [] }; }
  cacheTok = t;
  return cache;
}

function save(next) {
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  cacheTok = fileTok();
}

/** 저장된 표시 순서로 정렬(순서에 없는 것은 원래 순서 유지하며 뒤로). */
function applyOrder(list, order) {
  if (!order || !order.length) return list;
  const rank = new Map(order.map((id, i) => [id, i]));
  return list
    .map((x, i) => [x, i])
    .sort((a, b) => {
      const ra = rank.has(a[0].id) ? rank.get(a[0].id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b[0].id) ? rank.get(b[0].id) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a[1] - b[1];
    })
    .map(([x]) => x);
}

/** DataCenter 목록(설정에서 정의한 종류) — 저장된 표시 순서 적용. */
export function listDatacenters() {
  const cur = loadRaw();
  return applyOrder(cur.datacenters.map((d) => ({ ...d })), cur.order);
}

/** 사용자가 지정한 표시 순서(id 배열). */
export function getDatacenterOrder() { return [...loadRaw().order]; }

/** 표시 순서 저장. 등록된 id만 유지(정리), 중복 제거. */
export function saveDatacenterOrder(ids) {
  const cur = loadRaw();
  const valid = new Set(cur.datacenters.map((d) => d.id));
  const order = Array.isArray(ids)
    ? [...new Set(ids.map((x) => String(x).trim()).filter((id) => valid.has(id)))]
    : [];
  try { save({ ...cur, order }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, order };
}

/** vCenter → DataCenter 할당 맵 사본. */
export function getDatacenterAssign() {
  return { ...loadRaw().assign };
}

/** vCenterId의 소속 DataCenter id(없으면 ''). */
export function datacenterOfVcenter(vcenterId) {
  return loadRaw().assign[norm(vcenterId)] || '';
}

export function addDatacenter(body = {}) {
  const id = idOf(body.id);
  const name = norm(body.name);
  if (!id) return { ok: false, reason: 'id가 필요합니다.' };
  if (!/^[a-z0-9._-]{1,64}$/.test(id)) return { ok: false, reason: 'id는 영문/숫자/.-_ 1~64자만 가능합니다.' };
  if (!name) return { ok: false, reason: 'name(표시 이름)이 필요합니다.' };
  const cur = loadRaw();
  if (cur.datacenters.some((d) => d.id === id)) return { ok: false, reason: `이미 존재하는 DataCenter: ${id}` };
  const entry = { id, name: name.slice(0, 128), region: norm(body.region).slice(0, 64), note: norm(body.note).slice(0, 256) };
  // 명시적 추가는 tombstone 해제(관리자가 다시 원함).
  try { save({ ...cur, datacenters: [...cur.datacenters, entry], deleted: (cur.deleted || []).filter((x) => x !== id) }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, datacenter: entry };
}

/** DataCenter가 없으면 생성(있으면 no-op). 수집 서버 등록/에이전트 배포 시 그 법인을 자동 등록해
 *  '스캔 대역 추가' 등 DataCenter 목록에 바로 뜨게 한다. id는 정규화(소문자), name 없으면 id 사용. */
export function ensureDatacenter(body = {}) {
  const id = idOf(body.id);
  if (!id || !/^[a-z0-9._-]{1,64}$/.test(id)) return { ok: false, reason: 'invalid id' };
  const cur = loadRaw();
  if (cur.datacenters.some((d) => d.id === id)) return { ok: true, existed: true, datacenter: { id } };
  // 관리자가 삭제한 법인은 자동 재생성하지 않는다(백필로 부활 방지). 다시 원하면 명시적 등록.
  if ((cur.deleted || []).includes(id)) return { ok: true, skipped: 'deleted', datacenter: { id } };
  return addDatacenter({ id, name: norm(body.name) || id, region: body.region, note: body.note });
}

export function updateDatacenter(id, body = {}) {
  const cur = loadRaw();
  const idx = cur.datacenters.findIndex((d) => d.id === id);
  if (idx === -1) return { ok: false, reason: `없는 DataCenter: ${id}` };
  const e = { ...cur.datacenters[idx] };
  if (body.name != null) e.name = norm(body.name).slice(0, 128);
  if (body.region != null) e.region = norm(body.region).slice(0, 64);
  if (body.note != null) e.note = norm(body.note).slice(0, 256);
  if (!e.name) return { ok: false, reason: 'name(표시 이름)이 필요합니다.' };
  try { save({ ...cur, datacenters: cur.datacenters.map((d, i) => (i === idx ? e : d)) }); }
  catch (err) { return { ok: false, reason: `저장 실패: ${err.message}` }; }
  return { ok: true, datacenter: e };
}

export function removeDatacenter(id) {
  const cur = loadRaw();
  if (!cur.datacenters.some((d) => d.id === id)) return { ok: false, reason: `없는 DataCenter: ${id}` };
  // 이 DataCenter에 할당돼 있던 vCenter 매핑도 함께 정리(유령 매핑 방지).
  const assign = {};
  for (const [vc, dc] of Object.entries(cur.assign)) if (dc !== id) assign[vc] = dc;
  // tombstone 기록 — 수집서버 백필(ensureDatacenter)이 삭제한 법인을 매 조회마다 되살리던
  // 문제 방지(예: WA-IRS 수집서버가 계속 존재해 삭제 직후 재생성되던 것).
  const deleted = Array.from(new Set([...(cur.deleted || []), idOf(id)]));
  const order = (cur.order || []).filter((x) => x !== id); // 삭제된 id는 순서에서도 제거
  try { save({ datacenters: cur.datacenters.filter((d) => d.id !== id), assign, deleted, order }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true };
}

/** vCenter를 DataCenter에 할당/해제. datacenterId 빈값이면 해제. */
export function setVcenterDatacenter(vcenterId, datacenterId) {
  const vc = norm(vcenterId);
  if (!vc) return { ok: false, reason: 'vcenterId가 필요합니다.' };
  const dc = idOf(datacenterId);
  const cur = loadRaw();
  if (dc && !cur.datacenters.some((d) => d.id === dc)) return { ok: false, reason: `없는 DataCenter: ${dc}` };
  const assign = { ...cur.assign };
  if (!dc) delete assign[vc]; else assign[vc] = dc;
  try { save({ ...cur, assign }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, vcenterId: vc, datacenterId: dc };
}

/** 여러 vCenter 할당을 한 번에(설정 페이지 일괄 저장용). entries: [[vcenterId, datacenterId], ...]. */
export function setVcenterDatacenterMany(entries = []) {
  const cur = loadRaw();
  const valid = new Set(cur.datacenters.map((d) => d.id));
  const assign = { ...cur.assign };
  let changed = 0;
  for (const [rawVc, rawDc] of entries) {
    const vc = norm(rawVc); if (!vc) continue;
    const dc = idOf(rawDc);
    if (dc && !valid.has(dc)) continue;
    if (!dc) { if (vc in assign) { delete assign[vc]; changed += 1; } }
    else if (assign[vc] !== dc) { assign[vc] = dc; changed += 1; }
  }
  if (!changed) return { ok: true, changed: 0 };
  try { save({ ...cur, assign }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, changed };
}

/** 테스트/관리용 초기화. */
export function resetDatacenters() {
  cache = null; cacheTok = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
