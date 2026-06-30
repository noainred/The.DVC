/**
 * 통합 서버 인벤토리 — 베어메탈/물리 서버의 '소속 법인(vCenter)' 수동 등록 저장.
 *
 * 통합 인벤토리 화면에서 베어메탈 서버를 어느 법인(vCenter)에 귀속시킬지 드롭다운으로 고른 값을
 * 저장한다. iDRAC 레지스트리에 등록된 서버는 레지스트리의 vcenterId(전력 귀속과 공유)를 직접
 * 갱신하므로, 이 저장소는 주로 레지스트리에 없는 서버(OME/원격/무전력 발견분)의 귀속을 담는다.
 *
 * 키는 Dell 서비스태그(소문자) 우선, 없으면 서버 ID/호스트명(소문자). CONFIG_DIR/fleet-assign.json.
 * 무결성: 디스크 쓰기 성공 후에만 캐시 갱신, mtime으로 외부 변경 자동 무효화(fleet-tags와 동일).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { bumpFleetRev } from './fleetRev.js';

const FILE = path.join(config.configDir, 'fleet-assign.json');
const norm = (s) => String(s || '').trim().toLowerCase();

let cache = null;
let cacheMtimeMs = '';

// (mtimeMs, size) 복합 토큰 — coarse mtime 동일-틱에 외부 편집된 경우도 size 변화로 무효화.
function fileMtimeMs() {
  try { const st = fs.statSync(FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

export function loadFleetAssign() {
  const mtime = fileMtimeMs();
  if (cache && mtime === cacheMtimeMs) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = p && typeof p.assign === 'object' && p.assign ? p.assign : {};
  } catch {
    cache = {};
  }
  cacheMtimeMs = mtime;
  return cache;
}

/**
 * 소속 법인 지정/해제. vcenterId가 빈값이면 해제.
 * @param validIds  선택. 유효 vCenter id Set. 주어지면 빈값이 아닌데 미포함이면 거부(유령 법인 차단).
 */
export function setFleetAssign(key, vcenterId, validIds = null) {
  const k = norm(key);
  if (!k) return { ok: false, reason: 'key(서비스태그 또는 서버 ID)가 필요합니다.' };
  if (k.length > 128) return { ok: false, reason: 'key가 너무 깁니다.' };
  const vc = String(vcenterId || '').trim();
  if (vc.length > 128) return { ok: false, reason: 'vcenterId가 너무 깁니다.' };
  if (vc && validIds && !validIds.has(vc)) return { ok: false, reason: `존재하지 않는 vCenter id: ${vc}` };
  const cur = loadFleetAssign();
  if (!vc && !(k in cur)) return { ok: true, assign: cur };  // 해제인데 이미 없음 → 불필요한 디스크 write 생략
  if (cur[k] === vc) return { ok: true, assign: cur };        // 값 동일 → no-op
  const next = { ...cur };
  if (!vc) delete next[k];
  else next[k] = vc;
  try { atomicWriteFileSync(FILE, JSON.stringify({ assign: next }, null, 2)); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  cache = next;                 // 디스크 쓰기 성공 후에만 캐시 갱신
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return { ok: true, assign: next };
}

/**
 * 여러 키의 소속을 한 번의 디스크 쓰기로 일괄 설정/해제(일괄 등록·stale 정리용).
 * entries: [[key, vcenterId|''], ...]. vcenterId 빈값이면 해제. 반환 { ok, changed }.
 */
export function setFleetAssignMany(entries = [], validIds = null) {
  const next = { ...loadFleetAssign() };
  let changed = 0;
  for (const [rawKey, rawVc] of entries) {
    const k = norm(rawKey);
    if (!k || k.length > 128) continue;
    const vc = String(rawVc || '').trim();
    if (vc.length > 128) continue;
    if (vc && validIds && !validIds.has(vc)) continue;
    if (!vc) { if (k in next) { delete next[k]; changed += 1; } }
    else if (next[k] !== vc) { next[k] = vc; changed += 1; }
  }
  if (!changed) return { ok: true, changed: 0 };
  try { atomicWriteFileSync(FILE, JSON.stringify({ assign: next }, null, 2)); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  cache = next;
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return { ok: true, changed };
}

/**
 * 측정 전력 목록에 소속 법인(fleet-assign)을 덧입힌다 — PowerMap/FinOps가 OME/원격 베어메탈의
 * 수동 귀속을 똑같이 반영하도록(화면 간 귀속 불일치 방지). 수동 등록은 OME 추론/원격 귀속보다
 * 우선(플릿 화면과 일치). iDRAC 레지스트리·vCenter 호스트 PerfMgr 전력은 권위로 유지(덮지 않음).
 *
 * 조회 키: 서비스태그 → 서버ID → 호스트명(들) → host 순. 플릿 화면에서 호스트명 키로 귀속한
 * ESXi 호스트도 PowerMap/FinOps에 동일 반영되게 한다.
 * @param validIds  선택. 유효 vCenter id Set. 주어지면 미포함 귀속은 무시(죽은 법인으로의 split-brain 방지).
 */
export function applyFleetAssign(measured, validIds = null) {
  const a = loadFleetAssign();
  if (!a || !Object.keys(a).length) return measured;
  for (const m of (measured || [])) {
    // iDRAC 레지스트리 vcenterId, vCenter 호스트 PerfMgr 전력(source 'vcenter')은 권위 — 옮기지 않음.
    if (m.source === 'idrac' || m.source === 'vcenter') continue;
    let v = a[norm(m.serviceTag)] || a[norm(m.serverId)];
    if (!v) {
      for (const h of (m.hostNames || [])) { const hit = a[norm(h)]; if (hit) { v = hit; break; } }
      if (!v && m.host) v = a[norm(m.host)];
    }
    if (v && (!validIds || validIds.has(v))) m.vcenterId = v;
  }
  return measured;
}

/** live 키 집합에 없는 유령 키(교체/삭제된 서버의 잔재)를 제거. 제거 수 반환. */
export function pruneFleetAssign(liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  const cur = loadFleetAssign();
  const next = {};
  let removed = 0;
  for (const [k, v] of Object.entries(cur)) { if (live.has(k)) next[k] = v; else removed += 1; }
  if (!removed) return 0;
  // 쓰기 실패는 '0건 제거'와 구분해 throw — 라우트가 부분실패를 500으로 드러낼 수 있게(조용한 은폐 방지).
  atomicWriteFileSync(FILE, JSON.stringify({ assign: next }, null, 2));
  cache = next;
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return removed;
}

/** 테스트/관리용 초기화. */
export function resetFleetAssign() {
  cache = {};
  cacheMtimeMs = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
