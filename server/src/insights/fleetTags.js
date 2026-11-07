/**
 * 통합 서버 인벤토리 — 수동 분류 예외(override) 저장.
 *
 * 기본 분류는 자동(iDRAC/OME 서버가 vCenter ESXi 호스트에 매칭되면 '가상화 호스트', 아니면 '베어메탈')
 * 이지만, 자동 추정이 틀리는 경우를 사람이 직접 바로잡을 수 있게 한다.
 *   - 'baremetal'      : 호스트에 매칭되더라도 베어메탈로 강제
 *   - 'virtualization' : 매칭이 안 돼도 가상화(=베어메탈 아님)로 강제
 *   - 'exclude'        : 인벤토리/전력 집계에서 제외
 * 키는 Dell 서비스태그(소문자) 우선, 없으면 서버 ID/호스트명(소문자). CONFIG_DIR/fleet-tags.json에 저장.
 *
 * 무결성: 디스크 쓰기에 성공한 뒤에만 메모리 캐시를 갱신한다(쓰기 실패 시 캐시가 디스크보다 앞서가지
 * 않게). 외부에서 파일이 바뀌면(수동 편집/업그레이드) mtime으로 캐시를 자동 무효화한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { bumpFleetRev } from './fleetRev.js';

const FILE = path.join(config.configDir, 'fleet-tags.json');
const VALID = new Set(['baremetal', 'virtualization', 'exclude']);

let cache = null;
let cacheMtimeMs = '';
/*
 * v2.923(리눅스 성능 4단계 — 설계 PROFILES §1 ‘수동 태그가 덮어쓴다 · 새 등록부를 만들지 않는다’): 같은 파일에 **용도 태그** `purposes` 를 더한다.
 *   `{ tags:{…}, purposes:{ <키>:{ apps:[…], role, by, at } } }` — tags 를 쓰는 함수들도 purposes 를 **보존**한다(한쪽 저장이 다른 쪽을 지우지 않게).
 */
let purposesCache = {};

// (mtimeMs, size) 복합 토큰 — coarse mtime 동일-틱에 외부 편집된 경우도 size 변화로 무효화.
function fileMtimeMs() {
  try { const st = fs.statSync(FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

export function loadFleetTags() {
  const mtime = fileMtimeMs();
  if (cache && mtime === cacheMtimeMs) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = p && typeof p.tags === 'object' && p.tags ? p.tags : {};
    purposesCache = p && p.purposes && typeof p.purposes === 'object' && !Array.isArray(p.purposes) ? p.purposes : {};
  } catch (e) {
    preserveCorrupt(FILE, e.message);
    cache = {};
    purposesCache = {};
  }
  cacheMtimeMs = mtime;
  return cache;
}

/** 태그 지정/해제. tag가 빈값/'auto'면 해제(=자동 분류로 복귀). 반환 { ok, tags? , reason? }. */
export function setFleetTag(key, tag) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return { ok: false, reason: 'key(서비스태그 또는 서버 ID)가 필요합니다.' };
  if (k.length > 128) return { ok: false, reason: 'key가 너무 깁니다.' };
  const next = { ...loadFleetTags() };
  if (tag == null || tag === '' || tag === 'auto') {
    delete next[k];
  } else if (VALID.has(tag)) {
    next[k] = tag;
  } else {
    return { ok: false, reason: `잘못된 tag: ${tag}` };
  }
  try { atomicWriteFileSync(FILE, JSON.stringify(fileBody(next, purposesCache), null, 2)); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  cache = next;                 // 디스크 쓰기 성공 후에만 캐시 갱신
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return { ok: true, tags: next };
}

/** live 키 집합에 없는 유령 키(교체/삭제된 서버의 잔재)를 제거. 제거 수 반환. */
export function pruneFleetTags(liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  const cur = loadFleetTags();
  const next = {};
  let removed = 0;
  for (const [k, v] of Object.entries(cur)) { if (live.has(k)) next[k] = v; else removed += 1; }
  if (!removed) return 0;
  // 쓰기 실패는 '0건 제거'와 구분해 throw — 라우트가 부분실패를 500으로 드러낼 수 있게(조용한 은폐 방지).
  atomicWriteFileSync(FILE, JSON.stringify(fileBody(next, purposesCache), null, 2));
  cache = next;
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return removed;
}

/**
 * 측정 전력 목록에서 'exclude' 태그가 달린 물리 서버를 제거 — FinOps/PowerMap 등 전력 화면이
 * 통합 인벤토리(classifyFleet)와 같은 제외 집합을 쓰도록(화면 간 제외 불일치 방지).
 * 키는 서비스태그/서버ID/호스트명(들) 중 하나라도 'exclude'면 제외.
 */
export function applyFleetExclude(measured) {
  const t = loadFleetTags();
  if (!t || !Object.keys(t).length) return measured;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const isExcluded = (m) =>
    [m.serviceTag, m.serverId, m.host, ...(m.hostNames || [])].some((k) => t[norm(k)] === 'exclude');
  return (measured || []).filter((m) => !isExcluded(m));
}

/** 파일 본문 — purposes 가 비면 예전 모양({tags}) 그대로 쓴다(이 기능을 안 쓰는 현장의 파일이 바뀌지 않게). */
function fileBody(tags, purposes) {
  return purposes && Object.keys(purposes).length ? { tags, purposes } : { tags };
}

/** v2.923 — 용도 태그 전체(키 → { apps, role, by, at }). */
export function loadFleetPurposes() { loadFleetTags(); return purposesCache; }
/** 한 서버의 용도 태그(없으면 null). 키는 서비스태그(또는 서버 ID) — 대소문자 무시. */
export function fleetPurposeOf(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  const p = loadFleetPurposes();
  return Object.hasOwn(p, k) ? p[k] : null;
}
const PURPOSE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * 용도 태그 지정/해제(v2.923). value 가 null 이면 해제(자동 감지로 복귀). apps 는 알려진 기능 프로파일 id 만(호출부가 knownApps 로 넘긴다) ·
 * role 은 knownRoles 중 하나 또는 ''(역할 미지정 → 일반). 반환 { ok, purpose?, reason? }. 디스크 쓰기 성공 뒤에만 캐시를 바꾼다.
 */
export function setFleetPurpose(key, value, { by = '', knownApps = [], knownRoles = [] } = {}) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return { ok: false, reason: 'key(서비스태그 또는 서버 ID)가 필요합니다.' };
  if (k.length > 128 || k === '__proto__' || k === 'constructor' || k === 'prototype') return { ok: false, reason: 'key 형식이 아닙니다.' };
  const tags = loadFleetTags();
  const next = { ...purposesCache };
  let purpose = null;
  if (value == null) delete next[k];
  else {
    const apps = Array.isArray(value.apps) ? [...new Set(value.apps.map((x) => String(x)))] : null;
    if (apps && apps.some((a) => !PURPOSE_ID_RE.test(a) || !knownApps.includes(a))) return { ok: false, reason: `기능은 ${knownApps.join(' · ') || '(없음)'} 중에서만 고를 수 있습니다(프로파일이 없는 기능은 태그하지 않습니다).` };
    const role = value.role == null || value.role === '' ? '' : String(value.role);
    if (role && !knownRoles.includes(role)) return { ok: false, reason: `역할은 ${knownRoles.join(' · ')} 중 하나입니다.` };
    if (!apps && !role) return { ok: false, reason: 'apps 또는 role 중 하나는 있어야 합니다(둘 다 지우려면 해제).' };
    purpose = { ...(apps ? { apps } : {}), ...(role ? { role } : {}), by: String(by || '').slice(0, 64), at: Date.now() };
    next[k] = purpose;
  }
  try { atomicWriteFileSync(FILE, JSON.stringify(fileBody(tags, next), null, 2)); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  purposesCache = next;
  cacheMtimeMs = fileMtimeMs();
  bumpFleetRev();
  return { ok: true, purpose };
}

/** 테스트/관리용 초기화. */
export function resetFleetTags() {
  cache = {};
  purposesCache = {};
  cacheMtimeMs = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
