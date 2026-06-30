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
    };
  } catch { cache = { datacenters: [], assign: {} }; }
  cacheTok = t;
  return cache;
}

function save(next) {
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  cacheTok = fileTok();
}

/** DataCenter 목록(설정에서 정의한 종류). */
export function listDatacenters() {
  return loadRaw().datacenters.map((d) => ({ ...d }));
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
  try { save({ ...cur, datacenters: [...cur.datacenters, entry] }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, datacenter: entry };
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
  try { save({ datacenters: cur.datacenters.filter((d) => d.id !== id), assign }); }
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
