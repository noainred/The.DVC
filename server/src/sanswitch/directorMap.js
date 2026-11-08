/**
 * sanswitch/directorMap.js — SAN 스토리지 성능의 관리자 재정의 저장소(v2.947).
 *
 * 두 가지를 담는다(둘 다 **표시에만** 영향 — 수집 표본 · 판정 데이터는 바꾸지 않는다):
 *  · kinds     : 연결 대상 키(어레이 키 — perfDb.storageKey) → 'array' | 'host'. 자동 분류(endpointKind — `::` 이름이면 어레이 **추정**)가
 *                틀릴 때 사람이 바로잡는다(평평한 이름 어레이 → 어레이 · HBA 가 `::` 이름 → 호스트).
 *  · directors : `어레이키|deviceId|port` → { group, name, note }. 자동 해석(directorOf)이 '(구분 못 함)' 인 포트를 사람이 채운다.
 *                name 은 저장 당시 심볼릭 이름 — 포트가 재배선돼 이름이 바뀌면 화면이 '이름이 바뀜' 표지를 달고 **자동으로 지우지 않는다**.
 *
 * 파일: CONFIG_DIR/san-storage-map.json — 자격증명 아님(vault 대상 아님). 원자적 쓰기 + 손상 보존(preserveCorrupt) — 서버 공통 규약.
 * 쓰기는 관리자 전용 라우트(전 법인 공용이라 fullRwOnly)만 부르고 감사 로그를 남긴다(routes/api/sanStorage.js).
 * 저장은 **전체 교체**다(화면이 지금 상태 + 편집을 통째로 보낸다) — 부분 패치의 순서 문제를 만들지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'san-storage-map.json');

export const MAP_LIMITS = Object.freeze({ kinds: 1000, directors: 8192, keyMax: 160, groupMax: 40, noteMax: 200, nameMax: 200 });
/** 디렉터 그룹 이름 — 영숫자로 시작 · 영숫자 · 공백 · `_ . : -` 만(화면 · CSV · 감사 로그에 그대로 실린다). */
export const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,39}$/;
const KIND_VALUES = new Set(['array', 'host']);

let _cache = null;

const empty = () => ({ v: 1, kinds: {}, directors: {}, updatedAt: null, updatedBy: '' });

export function loadDirectorMap() {
  if (_cache) return _cache;
  const file = FILE();
  let raw = null;
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { preserveCorrupt(file, String(e?.message || e)); raw = null; }
    if (raw && (typeof raw !== 'object' || Array.isArray(raw))) { preserveCorrupt(file, '객체가 아닌 JSON 값'); raw = null; }
  }
  _cache = normalizeMap(raw || {});
  return _cache;
}

/** 입력 정규화(순수) — 모르는 키 · 형식 밖 값은 버린다. 던지지 않는다(로드용). */
export function normalizeMap(input = {}) {
  const out = empty();
  const kinds = input && typeof input.kinds === 'object' && !Array.isArray(input.kinds) ? input.kinds : {};
  for (const [k, v] of Object.entries(kinds).slice(0, MAP_LIMITS.kinds)) {
    const key = String(k).slice(0, MAP_LIMITS.keyMax);
    const kind = v && typeof v === 'object' ? v.kind : v;
    if (!key || !KIND_VALUES.has(kind)) continue;
    out.kinds[key] = { kind, by: str(v?.by, 64), at: num(v?.at), note: str(v?.note, MAP_LIMITS.noteMax) };
  }
  const dirs = input && typeof input.directors === 'object' && !Array.isArray(input.directors) ? input.directors : {};
  for (const [k, v] of Object.entries(dirs).slice(0, MAP_LIMITS.directors)) {
    const key = String(k).slice(0, MAP_LIMITS.keyMax + 80);
    if (!v || typeof v !== 'object' || key.split('|').length !== 3) continue;
    const group = String(v.group || '').trim();
    if (!GROUP_RE.test(group)) continue;
    out.directors[key] = { group, name: str(v.name, MAP_LIMITS.nameMax), by: str(v.by, 64), at: num(v.at), note: str(v.note, MAP_LIMITS.noteMax) };
  }
  out.updatedAt = num(input.updatedAt);
  out.updatedBy = str(input.updatedBy, 64);
  return out;
}
const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * 저장(전체 교체). 형식 오류는 `{ issue }` 로 돌려준다(400 — 조용히 버리지 않는다).
 * @returns {{ map?: object, issue?: string }}
 */
export function saveDirectorMap(input = {}, { by = '', now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { issue: '본문은 객체여야 합니다' };
  const kinds = input.kinds ?? {};
  const dirs = input.directors ?? {};
  if (typeof kinds !== 'object' || Array.isArray(kinds) || typeof dirs !== 'object' || Array.isArray(dirs)) return { issue: 'kinds · directors 는 객체여야 합니다' };
  if (Object.keys(kinds).length > MAP_LIMITS.kinds) return { issue: `분류 재정의는 최대 ${MAP_LIMITS.kinds}개입니다` };
  if (Object.keys(dirs).length > MAP_LIMITS.directors) return { issue: `디렉터 매핑은 최대 ${MAP_LIMITS.directors}개입니다` };
  for (const [k, v] of Object.entries(kinds)) {
    if (!k || k.length > MAP_LIMITS.keyMax) return { issue: `분류 키가 비었거나 깁니다: ${String(k).slice(0, 40)}` };
    const kind = v && typeof v === 'object' ? v.kind : v;
    if (!KIND_VALUES.has(kind)) return { issue: `분류 값은 array · host 중 하나입니다: ${String(k).slice(0, 40)}` };
  }
  for (const [k, v] of Object.entries(dirs)) {
    if (!k || k.split('|').length !== 3) return { issue: `디렉터 매핑 키는 '어레이키|스위치|포트' 꼴입니다: ${String(k).slice(0, 40)}` };
    const group = String(v?.group ?? '').trim();
    if (!GROUP_RE.test(group)) return { issue: `디렉터 그룹 이름 형식이 맞지 않습니다(영숫자 · 공백 · _ . : - · 40자): ${String(k).slice(0, 40)}` };
    if (v?.note != null && String(v.note).length > MAP_LIMITS.noteMax) return { issue: `메모는 ${MAP_LIMITS.noteMax}자까지입니다` };
  }
  const prev = loadDirectorMap();
  const next = normalizeMap({ kinds, directors: dirs, updatedAt: now, updatedBy: by });
  // 변경자 · 시각 — 값이 바뀐 항목만 새로 찍는다(바뀌지 않은 항목은 예전 기록을 지킨다).
  for (const [k, v] of Object.entries(next.kinds)) {
    const p = prev.kinds[k];
    if (p && p.kind === v.kind && p.note === v.note) { v.by = p.by; v.at = p.at; } else { v.by = str(by, 64); v.at = now; }
  }
  for (const [k, v] of Object.entries(next.directors)) {
    const p = prev.directors[k];
    if (p && p.group === v.group && p.note === v.note && p.name === v.name) { v.by = p.by; v.at = p.at; } else { v.by = str(by, 64); v.at = now; }
  }
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _cache = next;
  return { map: next };
}

/** 연결 대상 분류 재정의 — 없으면 null. */
export function kindOverrideOf(key) {
  const m = loadDirectorMap();
  return m.kinds[String(key)] || null;
}
/** 포트 디렉터 재정의 — 없으면 null. */
export function directorOverrideOf(key, deviceId, port) {
  const m = loadDirectorMap();
  return m.directors[`${key}|${deviceId}|${Number(port)}`] || null;
}
export const directorMapKey = (key, deviceId, port) => `${key}|${deviceId}|${Number(port)}`;

export function directorMapStatus() {
  const m = loadDirectorMap();
  return { kinds: Object.keys(m.kinds).length, directors: Object.keys(m.directors).length, updatedAt: m.updatedAt, updatedBy: m.updatedBy };
}

export function _resetForTest() { _cache = null; }
