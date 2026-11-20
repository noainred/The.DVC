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
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'provision-saved.json');

let cache = null;
/*
 * 74회차 F9: **읽기 오류**(EACCES · EISDIR · EIO 등 — 파일은 있는데 읽지 못함)를 손상으로 보지 않는다. 예전에는 같은 catch 가
 *   preserveCorrupt 로 원본을 `.corrupt.<시각>` 으로 옮기고 빈 목록으로 시작해, 다음 VM 생성이 새 파일(1건)을 써서 저장된 작업 전부가
 *   목록에서 사라졌다(34회차 F4 · 19회차 users.json 과 같은 모양). 읽기 오류면 원본을 그대로 두고 캐시하지 않으며(다음 호출에 다시 읽는다)
 *   그동안 쓰기(addSaved · updateSaved · removeSaved)를 막는다 — 빈 목록을 저장해 원본을 덮지 않게. 파싱 실패만 예전대로 보존 후 빈 값.
 */
let readErr = null;
function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') { readErr = null; cache = []; return cache; }
    readErr = { code: String(e?.code || 'EREAD'), at: Date.now() };
    console.error(`[provision] ${path.basename(FILE)} 읽기 실패(${readErr.code}) — 원본은 그대로 두었습니다. 파일 권한 · 소유자를 확인하세요(그동안 저장된 작업 쓰기를 막습니다).`);
    return [];   // 캐시하지 않는다
  }
  readErr = null;
  cache = [];
  try { const j = JSON.parse(raw); cache = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []); } catch (e) { preserveCorrupt(FILE, e.message); cache = []; }
  return cache;
}
/** 읽기 오류 중이면 사유(쓰기 거부) — 아니면 null. */
const writeBlocked = () => (readErr ? `저장된 작업 파일을 읽지 못했습니다(${readErr.code}) — 원본을 덮지 않도록 저장을 막았습니다. 파일 권한 · 소유자를 확인하세요.` : null);
/** 화면 · 진단용 — 읽기 오류 상태(없으면 null). */
export function savedReadError() { load(); return readErr ? { ...readErr } : null; }
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}
const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Persist one provisioning spec (called whenever a job is created). */
export function addSaved({ spec, source, user, memo = '', tags = [] } = {}) {
  const list = load();
  { const why = writeBlocked(); if (why) throw new Error(why); }   // 74회차 F9 — 호출부(createJob)는 best effort 로 삼킨다(작업은 진행)
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

// v2.583 감사 #26: 응답에는 **사본**을 준다. `util/compress.js` 는 응답 객체의 **정체성**으로 직렬화 본문·ETag 를
//   캐시하고(WeakMap), 이 모듈은 캐시 원소를 제자리에서 고친다(updateSaved) — 원본을 그대로 res.json 하면 메모를 고친 뒤
//   GET 이 **옛 메모**를 돌려줬다(실측). 원소 사본 + 배열 필드 사본이면 충분하다(깊은 중첩 없음).
const copyOf = (e) => (e ? { ...e, ...(Array.isArray(e.tags) ? { tags: [...e.tags] } : {}) } : e);
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
  // 74회차 F9: 읽기 오류면 빈 목록이 '저장된 작업 없음' 이 아니라는 사실을 함께 싣는다(사유에 경로 · 원문 없음).
  return { total, offset: off, limit: lim, items: items.slice(off, off + lim).map(copyOf), vcenters: savedVcenters(allowed), ...(readErr ? { readError: true, reason: writeBlocked() } : {}) };
}

export function getSaved(id) { return copyOf(load().find((e) => e.id === id)) || null; }

export function updateSaved(id, { memo, tags } = {}) {
  const list = load();
  { const why = writeBlocked(); if (why) return { ok: false, readError: true, reason: why }; }   // 74회차 F9
  const e = list.find((x) => x.id === id);
  if (!e) return { ok: false, reason: '저장된 작업을 찾을 수 없습니다.' };
  if (memo !== undefined) e.memo = String(memo || '').slice(0, 2000);
  if (tags !== undefined) e.tags = cleanTags(tags);
  persist();
  return { ok: true, item: copyOf(e) };
}

export function removeSaved(id) {
  const list = load();
  { const why = writeBlocked(); if (why) return { ok: false, readError: true, reason: why }; }   // 74회차 F9
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return { ok: false, reason: '없는 작업' };
  list.splice(i, 1);
  persist();
  return { ok: true };
}
