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
let cacheMtimeMs = 0;

function fileMtimeMs() {
  try { return fs.statSync(FILE).mtimeMs; } catch { return 0; }
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
  const next = { ...loadFleetAssign() };
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
 * 측정 전력 목록에 소속 법인(fleet-assign)을 덧입힌다 — PowerMap/FinOps가 OME/원격 베어메탈의
 * 수동 귀속을 똑같이 반영하도록(화면 간 귀속 불일치 방지). vcenterId가 비어 있는 항목만 채운다
 * (레지스트리/원격이 제공한 값은 권위로 유지).
 */
export function applyFleetAssign(measured) {
  const a = loadFleetAssign();
  if (!a || !Object.keys(a).length) return measured;
  for (const m of (measured || [])) {
    if (m.vcenterId) continue;
    const v = a[norm(m.serviceTag)] || a[norm(m.serverId)];
    if (v) m.vcenterId = v;
  }
  return measured;
}

/** 테스트/관리용 초기화. */
export function resetFleetAssign() {
  cache = {};
  cacheMtimeMs = 0;
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
