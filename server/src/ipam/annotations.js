/**
 * Per-IP user annotations (custom memo + tags) for the IP ledger. These are
 * operator-authored notes kept SEPARATELY from the vCenter VM/host notes, so
 * they survive snapshot refreshes. Stored in CONFIG_DIR/ipam-annotations.json,
 * keyed by IP address.
 */

import { makeSettingsLoadError } from '../util/settingsLoadError.js';   // 25회차 F-4
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { canonIp } from '../util/ipv4.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'ipam-annotations.json');

let cache = null;
let rev = 0; // 메모/태그 변경 리비전(대장 캐시 무효화 키)
export function annotationsRev() { return rev; }

// 전체 점검 25회차 F-4: 손상 표지 · 서비스 점검 등재 · 오류 중 쓰기 거절(overrides.js 와 같은 판단)
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'IP 관리 메모 · 태그', confirm: () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify({ ...load() }, null, 2)); _loadErr.ok(); } });
export function annotationsLoadError() { load(); return _loadErr.get(); }
const ANNOTATION_REFUSAL = { ok: false, code: 'settings-unreadable', reason: 'IP 관리 메모 파일(ipam-annotations.json)을 읽지 못한 상태라 저장하지 않았습니다 — 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리고 재시작하세요.' };
function load() {
  if (cache) return cache;
  cache = {};
  try {
    if (fs.existsSync(FILE)) { cache = parseJsonObject(fs.readFileSync(FILE, 'utf8')); _loadErr.ok(); }
    else _loadErr.missing();
  } catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE, e.message); cache = {}; }
  return cache;
}

/** Whole map { ip: { memo, tags[], updatedAt, updatedBy } }. */
export function getAnnotations() { return load(); }

/** One IP's annotation, or null. */
export function getAnnotation(ip) { const d = load(); const c = canonIp(ip); return (c && d[c]) || d[String(ip)] || null; }

const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Create/update/clear one IP's annotation. Empty memo + no tags removes it. */
export function setAnnotation(ip, { memo = '', tags = [] } = {}, user) {
  const raw = String(ip || '').trim();
  if (!raw) return { ok: false, reason: 'IP가 필요합니다.' };
  // v2.594(감사 LO-2): IPv4 로 읽히면 정규형 키로 저장한다(선행 0 표기가 원장 행과 어긋나 유령이 되던 것).
  const key = canonIp(raw) || raw;
  if (annotationsLoadError()) return { ...ANNOTATION_REFUSAL };   // 25회차 F-4
  const data = { ...load() };   // 25회차 F-5: 사본 — persist 성공 뒤에만 캐시 교체
  if (raw !== key && data[raw]) delete data[raw];
  const m = String(memo || '').trim().slice(0, 2000);
  const t = cleanTags(tags);
  if (!m && t.length === 0) {
    delete data[key];
  } else {
    data[key] = { memo: m, tags: t, updatedAt: new Date().toISOString(), updatedBy: user?.username || 'unknown' };
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2)); // 부분기록 시 메모/태그 전량 유실 방지
  cache = data; rev++; _loadErr.ok();
  return { ok: true, annotation: data[key] || null };
}

/**
 * v2.636: 여러 IP 의 메모·태그를 한 번에 저장(CSV 가져오기) — 파일 쓰기 1회. 규칙은 setAnnotation 과 같다
 * (빈 메모 + 태그 없음 = 삭제, 메모 2000자·태그 20개 절단은 판정 단계에서 이미 오류로 걸렀다).
 * @param {{ip:string, memo:string, tags:string[]}[]} entries
 */
export function setAnnotationsMany(entries, user) {
  if (annotationsLoadError()) return { ...ANNOTATION_REFUSAL };   // 25회차 F-4
  const data = { ...load() };   // 25회차 F-5: 사본 — persist 성공 뒤에만 캐시 교체
  const now = new Date().toISOString();
  const by = user?.username || 'unknown';
  let changed = 0; let removed = 0;
  for (const e of entries || []) {
    const raw = String(e?.ip || '').trim();
    if (!raw) continue;
    const key = canonIp(raw) || raw;
    if (raw !== key && data[raw]) delete data[raw];
    const m = String(e.memo || '').trim().slice(0, 2000);
    const t = cleanTags(e.tags);
    if (!m && t.length === 0) { if (data[key]) { delete data[key]; removed++; } continue; }
    data[key] = { memo: m, tags: t, updatedAt: now, updatedBy: by };
    changed++;
  }
  if (changed || removed) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(data, null, 2));
    cache = data; rev++; _loadErr.ok();
  }
  return { ok: true, changed, removed };
}
