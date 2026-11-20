/**
 * bmfolders/edgeCopy.js — 엣지의 **중앙 폴더 사본**(v2.996 · 설계 docs/design/bm-folders §11 — 묶음 D). 파일 `bm-folders-central.json`(설정 변경 감시 밖 — backup/service.js).
 *
 * · 엣지는 중앙 문자열을 그대로 믿지 않는다 — 받은 묶음을 같은 규칙으로 다시 자른다(`sanitizeBundle`: 아는 필드만 · 글자만 · 상한 · 경로 검증 `cleanFolderPath` · 키 `isMemberKey`).
 * · 원자 쓰기 · 읽기 손상이면 보존본(.corrupt.<ts>)을 남기고 '못 읽음'(빈 사본으로 덮지 않는다 — 다음 받기가 새로 쓴다).
 * · 끊겨도 지우지 않는다 — 받은 시각(`savedAt`)으로 나이를 보인다(결정 4 기본값).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { cleanFolderPath } from '../servicemap/store.js';
import { isMemberKey } from './store.js';
import { BUNDLE_MAX, BUNDLE_VER } from './edgeBundle.js';

const FILE = () => path.join(config.configDir, 'bm-folders-central.json');
const t = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 경로는 **글자만**(이 폴더 규약 — cleanFolderPath 는 숫자도 글자로 바꿔 받는다). */
const pathOf = (v) => (typeof v === 'string' ? cleanFolderPath(v) : { error: 'not-string' });
/** 받은 묶음 → 아는 필드만(순수). 형식이 아니면 null. dropped = 버린 항목 수. */
export function sanitizeBundle(raw) {
  if (!isObj(raw) || raw.v !== BUNDLE_VER || !Array.isArray(raw.corps) || !isObj(raw.place)) return null;
  let dropped = 0;
  const corps = [];
  for (const c of raw.corps.slice(0, 64)) {
    const vc = t(c?.vcenterId).slice(0, 128);
    if (!vc) { dropped += 1; continue; }
    const folders = [];
    for (const f of Array.isArray(c.folders) ? c.folders.slice(0, BUNDLE_MAX.folders) : []) { const p = pathOf(f); if (p.error || !p.value) dropped += 1; else folders.push(p.value); }
    const services = [];
    for (const s of Array.isArray(c.services) ? c.services.slice(0, BUNDLE_MAX.services) : []) { const p = pathOf(s?.prefix); const n = t(s?.service).slice(0, BUNDLE_MAX.name); if (p.error || !p.value || !n) dropped += 1; else services.push({ prefix: p.value, service: n }); }
    corps.push({ vcenterId: vc, name: t(c.name).slice(0, BUNDLE_MAX.name) || vc, folders, services });
  }
  const corpIds = new Set(corps.map((c) => c.vcenterId));
  const place = {}; let n = 0;
  for (const [k, v] of Object.entries(raw.place)) {
    if (n >= BUNDLE_MAX.place) { dropped += 1; continue; }
    const p = pathOf(v?.path); const corp = t(v?.corp);
    if (!isMemberKey(k) || p.error || !p.value || !corpIds.has(corp)) { dropped += 1; continue; }
    place[k] = { path: p.value, src: v.src === 'rule' ? 'rule' : 'manual', corp }; n += 1;
  }
  const outside = [];
  for (const o of Array.isArray(raw.outside) ? raw.outside.slice(0, BUNDLE_MAX.outside) : []) {
    const p = pathOf(o?.path); const corp = t(o?.corp);
    if (p.error || !p.value || !corpIds.has(corp)) { dropped += 1; continue; }
    outside.push({ corp, path: p.value, name: t(o.name).slice(0, BUNDLE_MAX.name), via: ['other-edge', 'collector', 'central'].includes(o.via) ? o.via : 'central' });
  }
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { v: BUNDLE_VER, rev: t(raw.rev).slice(0, 64), at: num(raw.at), corps, place, outside, outsideMore: num(raw.outsideMore), noEdgeKey: num(raw.noEdgeKey), dropped };
}

let _cache = null; // { mtime, copy, error }
/** 사본 읽기 — { copy:null } 이면 받은 적 없음 · { error } 면 못 읽음(손상 — 보존본을 남겼다). */
export function loadCopy() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { _cache = null; return { copy: null }; }
  if (_cache && _cache.mtime === st.mtimeMs) return { copy: _cache.copy, ...(_cache.error ? { error: _cache.error } : {}) };
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const b = sanitizeBundle(j?.bundle);
    if (!b) throw new Error('형식이 아닙니다');
    const copy = { ...b, savedAt: Number.isFinite(j.savedAt) ? j.savedAt : 0 };
    _cache = { mtime: st.mtimeMs, copy };
    return { copy };
  } catch (e) {
    try { preserveCorrupt(FILE(), 'bm-folders-central'); } catch { /* 보존 실패는 읽기 결과를 바꾸지 않는다 */ }
    _cache = null;
    return { copy: null, error: `사본(bm-folders-central.json)을 읽지 못했습니다: ${String(e?.message || e).slice(0, 120)}` };
  }
}
/** 받은 묶음 저장(정제 뒤) — { ok, dropped } · 형식이 아니면 { ok:false }(지난 사본 유지). */
export function saveCopy(bundle, { now = Date.now() } = {}) {
  const b = sanitizeBundle(bundle);
  if (!b) return { ok: false, reason: '묶음 형식 오류' };
  atomicWriteFileSync(FILE(), JSON.stringify({ savedAt: now, bundle: b }));
  _cache = null;
  return { ok: true, dropped: b.dropped, place: Object.keys(b.place).length, corps: b.corps.length };
}
export function _copyFileForTest() { return FILE(); }
