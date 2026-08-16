/**
 * Saved VM-provisioning jobs — every created job's spec is persisted so it can
 * be reloaded and reused later. Stored in CONFIG_DIR/provision-saved.json (ALL
 * jobs kept). Each entry carries an optional memo + tags. The portal lists a
 * page at a time (default 10) with an optional per-vCenter filter.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'provision-saved.json');

let cache = null;
function load() {
  if (cache) return cache;
  cache = [];
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = Array.isArray(j) ? j : (j.items || []); } } catch { cache = []; }
  return cache;
}
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}
const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Persist one provisioning spec (called whenever a job is created). */
export function addSaved({ spec, source, user, memo = '', tags = [] } = {}) {
  const list = load();
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    createdBy: user?.username || 'unknown',
    name: spec?.namePattern || source?.name || 'job',
    vcenterId: source?.vcenterId || spec?.vcenterId || '',
    sourceId: source?.id || spec?.sourceId || '',
    sourceName: source?.name || '',
    count: Array.isArray(spec?.guest?.ipList) && spec.guest.ipList.length && !(spec.count > 0) ? spec.guest.ipList.length : (Number(spec?.count) || 0),
    spec, // full spec to reload into the form
    memo: String(memo || '').slice(0, 2000),
    tags: cleanTags(tags),
    lastRunAt: new Date().toISOString(),
  };
  list.unshift(entry);
  persist();
  return entry;
}

/** Distinct vCenters present in saved jobs (for the filter tabs). allowed=scope 제한(null=전체). */
export function savedVcenters(allowed = null) {
  return [...new Set(load().map((e) => e.vcenterId).filter(Boolean))]
    .filter((id) => !allowed || allowed.has(id)).sort();
}

/**
 * Paginated list. { vcenterId?, limit=10, offset=0, allowed? } → { total, items, vcenters }.
 * allowed(Set|null): 사용자 scope 로 허용된 vCenter id 집합. 요청 vcenterId 필터보다 먼저
 * 적용해 범위 밖 저장 작업(spec 에 자격증명·토폴로지 포함)이 새지 않게 한다(v2.313 감사 반영).
 * vcenterId 가 없는 레거시 저장 작업은 범위 계정에 노출하지 않는다(vCenter 귀속 없는 데이터 규칙).
 */
export function listSaved({ vcenterId = '', limit = 10, offset = 0, allowed = null } = {}) {
  let items = load();
  if (allowed) items = items.filter((e) => e.vcenterId && allowed.has(e.vcenterId));
  if (vcenterId) items = items.filter((e) => e.vcenterId === vcenterId);
  const total = items.length;
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  const off = Math.max(0, Number(offset) || 0);
  return { total, offset: off, limit: lim, items: items.slice(off, off + lim), vcenters: savedVcenters(allowed) };
}

export function getSaved(id) { return load().find((e) => e.id === id) || null; }

export function updateSaved(id, { memo, tags } = {}) {
  const e = load().find((x) => x.id === id);
  if (!e) return { ok: false, reason: '저장된 작업을 찾을 수 없습니다.' };
  if (memo !== undefined) e.memo = String(memo || '').slice(0, 2000);
  if (tags !== undefined) e.tags = cleanTags(tags);
  persist();
  return { ok: true, item: e };
}

export function removeSaved(id) {
  const list = load();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return { ok: false, reason: '없는 작업' };
  list.splice(i, 1);
  persist();
  return { ok: true };
}
