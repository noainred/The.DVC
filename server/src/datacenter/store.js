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
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';   // 결정(56~75 남긴 것) 73 ①
import { resolvePickedDc } from '../collector/datacenterMatch.js'; // v2.986(반증 D3): 법인 id 고르기 규칙 하나(순수 · 의존 없음)

const FILE = path.join(config.configDir, 'datacenters.json');
const norm = (s) => String(s || '').trim();
const idOf = (s) => norm(s).toLowerCase();

let cache = null;
let cacheTok = '';

function fileTok() {
  try { const st = fs.statSync(FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

/*
 * 결정(56~75 남긴 것) 73 ①(73회차 남긴 것): 로드 catch 가 읽기 오류(EACCES · EIO · EMFILE)도 손상으로 보고 원본을 .corrupt 로 옮긴 뒤 빈 등록부로 돌았다 —
 *   다음 법인 추가 · 할당 · 수집 서버 백필(ensureDatacenter) 한 번이 한두 건만 든 파일을 썼다. 이제 공용 로더: 읽기 오류는 원본을 두고 캐시하지 않으며
 *   (30초 간격 재읽기) · 손상은 보존 + 서비스 점검 등재 · 오류 중 쓰기는 전부 거절(settings-unreadable — 라우트 409 · 백필은 조용히 건너뜀).
 */
const EMPTY = () => ({ datacenters: [], assign: {}, deleted: [], order: [] });
const _file = makeJsonFileLoader(() => FILE, { label: 'DataCenter(법인) 목록 · vCenter 할당(datacenters.json) — 확정하면 법인 목록 · 할당이 모두 비워집니다(수집 서버 법인은 다음 조회에서 다시 생김)', confirm: () => { atomicWriteFileSync(FILE, JSON.stringify(EMPTY(), null, 2)); cache = EMPTY(); cacheTok = fileTok(); _file.saved(); }, tag: 'datacenter' });
/** 등록부를 못 읽었으면 { reason, at, readError }, 아니면 null(GET /admin/datacenters 표지). */
export function datacentersLoadError() { loadRaw(); return _file.marker(); }
const refused = () => _file.refusal('DataCenter(법인) 목록 · 할당');

function loadRaw() {
  const t = fileTok();
  if (cache && t === cacheTok && !_file.recheckDue()) return cache;   // 결정 G2 반증 후속 ③: 오류 중에는 캐시를 믿지 않고 30초마다 다시 판정(보존본을 되돌리면 재시작 없이 풀린다)
  const r = _file.load();
  if (r.kind === 'read-error') { cache = null; return EMPTY(); }   // 73 ①: 캐시하지 않는다
  if (r.kind !== 'ok') { cache = EMPTY(); cacheTok = t; return cache; }
  {
    const p = r.value;
    cache = {
      datacenters: Array.isArray(p.datacenters) ? p.datacenters : [],
      assign: (p.assign && typeof p.assign === 'object') ? p.assign : {},
      // 관리자가 명시적으로 삭제한 DataCenter id(tombstone). 수집서버 백필(ensureDatacenter)이
      // 삭제한 법인을 매 조회마다 되살리던 문제 방지 — 명시적 재등록(addDatacenter) 시 해제.
      deleted: Array.isArray(p.deleted) ? p.deleted : [],
      // 사용자가 지정한 표시 순서(id 배열). 모든 'DataCenter 선택' 콤보박스/목록에 적용.
      order: Array.isArray(p.order) ? p.order.map(String) : [],
    };
  }
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
  { const no = refused(); if (no) return no; }   // 73 ①
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
  { const no = refused(); if (no) return no; }   // 73 ①
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
  { const no = refused(); if (no) return no; }   // 73 ①: 수집 서버 백필도 읽지 못한 등록부 위에 쓰지 않는다
  if (cur.datacenters.some((d) => d.id === id)) return { ok: true, existed: true, datacenter: { id } };
  // 관리자가 삭제한 법인은 자동 재생성하지 않는다(백필로 부활 방지). 다시 원하면 명시적 등록.
  if ((cur.deleted || []).includes(id)) return { ok: true, skipped: 'deleted', datacenter: { id } };
  return addDatacenter({ id, name: norm(body.name) || id, region: body.region, note: body.note });
}

export function updateDatacenter(id, body = {}) {
  const cur = loadRaw();
  { const no = refused(); if (no) return no; }   // 73 ①
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
  { const no = refused(); if (no) return no; }   // 73 ①
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
  { const no = refused(); if (no) return no; }   // 73 ①
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
  { const no = refused(); if (no) return no; }   // 73 ①
  const valid = new Set(cur.datacenters.map((d) => d.id));
  const assign = { ...cur.assign };
  let changed = 0;
  // v2.632 AX3-08: 원소 모양을 검사한다 — 비반복 객체를 `for (const [a, b] of …)` 로 구조분해하면 TypeError 로 500 이었다.
  //   [vcenterId, datacenterId] 배열과 {vcenterId, datacenterId} 객체를 받고, 그 밖의 모양·없는 DataCenter 는
  //   건너뛰되 개수를 밝힌다(malformed·unknownDatacenter — 조용한 제외 금지).
  let malformed = 0; let unknownDatacenter = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    let rawVc; let rawDc;
    if (Array.isArray(e) && e.length === 2) [rawVc, rawDc] = e;
    else if (e && typeof e === 'object' && !Array.isArray(e) && 'vcenterId' in e) { rawVc = e.vcenterId; rawDc = e.datacenterId; }
    else { malformed += 1; continue; }
    if ((typeof rawVc !== 'string' && typeof rawVc !== 'number') || (rawDc != null && typeof rawDc !== 'string' && typeof rawDc !== 'number')) { malformed += 1; continue; }
    const vc = norm(rawVc); if (!vc) { malformed += 1; continue; }
    // v2.986(반증 D3): 법인 id 는 실제 id 로(정확 일치 → 대소문자 무시 — collector/datacenterMatch.js resolvePickedDc 하나). 예전 idOf(소문자) 비교는
    //   손으로 고친 대문자 id 법인에 할당할 수 없어 '바뀐 것 없음(unknownDatacenter)' 이었다.
    const rawS = norm(rawDc);
    const dc = rawS ? (valid.has(rawS) ? rawS : resolvePickedDc(rawS, cur.datacenters)) : '';
    if (rawS && !dc) { unknownDatacenter += 1; continue; }
    if (!dc) { if (vc in assign) { delete assign[vc]; changed += 1; } }
    else if (assign[vc] !== dc) { assign[vc] = dc; changed += 1; }
  }
  const extra = { ...(malformed ? { malformed } : {}), ...(unknownDatacenter ? { unknownDatacenter } : {}) };
  if (!changed) return { ok: true, changed: 0, ...extra };
  try { save({ ...cur, assign }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, changed, ...extra };
}

/** 테스트/관리용 초기화. */
export function resetDatacenters() {
  cache = null; cacheTok = ''; _file.resetRetry();
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
