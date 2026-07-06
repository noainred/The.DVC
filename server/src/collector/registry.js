/**
 * Collector registry — the list of remote collector agents (one per datacenter)
 * the central portal pulls power from. Stored in CONFIG_DIR/collectors.json
 * (0600; holds per-agent tokens). Edited via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { bumpFleetRev } from '../insights/fleetRev.js';

const FILE = path.join(config.configDir, 'collectors.json');

/**
 * id가 대소문자만 다른 중복 수집서버를 하나로 병합한다. 엣지 자기등록(v2.117~)이 소문자
 * 이름('gm1')으로 등록하는데 기존 수동 등록이 대문자('GM1')라 id 비교가 대소문자를 구분해
 * 별개 항목으로 쌓이던 문제(같은 엣지가 2번 표시·이중 pull) 정리. 생존자는 vcenterId(관리자
 * 매핑)가 있는 쪽 우선, 없으면 먼저 온 것. 빈 필드는 다른 쪽 값으로 채운다.
 */
function dedupeByIdCase(list) {
  const groups = new Map(); const order = [];
  for (const c of list) {
    const k = String(c.id || '').toLowerCase();
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(c);
  }
  let changed = false;
  const out = [];
  for (const k of order) {
    const g = groups.get(k);
    if (g.length === 1) { out.push(g[0]); continue; }
    changed = true;
    const base = g.find((c) => String(c.vcenterId || '').trim()) || g[0];
    const merged = { ...base };
    for (const c of g) {
      if (c === base) continue;
      for (const f of ['vcenterId', 'datacenter', 'name', 'url', 'token']) {
        if (!String(merged[f] || '').trim() && String(c[f] || '').trim()) merged[f] = c[f];
      }
    }
    out.push(merged);
  }
  return { list: out, changed };
}

export function loadCollectors() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const arr = Array.isArray(parsed?.collectors) ? parsed.collectors : [];
    // 대소문자 중복을 로드 시 자동 정리(최초 1회 병합·영속화, 이후엔 중복이 없어 재저장 안 함).
    const { list, changed } = dedupeByIdCase(arr);
    if (changed) { try { save(list); } catch { /* best effort — 다음 로드에서 재시도 */ } }
    return list;
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 원자적 쓰기 — 크래시/정전 시 부분기록으로 collectors.json이 손상되면 loadCollectors가
  // []를 반환하고 다음 저장이 빈 목록으로 덮어써 전 수집서버·토큰이 영구 유실된다(자기등록으로
  // 쓰기 빈도가 늘어 노출 창이 커짐). atomicWrite(임시파일+rename)로 방지.
  atomicWriteFileSync(FILE, JSON.stringify({ collectors: list }, null, 2), { mode: 0o600 });
  bumpFleetRev(); // 수집서버 vcenterId 매핑 변경 → fleet/finops 캐시 즉시 무효화
}

export function redact(c) {
  const { token, ...rest } = c;
  return { ...rest, hasToken: Boolean(token) };
}

export function listCollectors() {
  return loadCollectors().map(redact);
}

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let url = String(body.url ?? e.url ?? '').trim();
  const datacenter = String(body.datacenter ?? e.datacenter ?? '').trim();
  // 이 수집서버가 보고하는 원격 호스트를 귀속시킬 vCenter(전력 집계에서 '미매핑' 방지). 선택.
  const vcenterId = String(body.vcenterId ?? e.vcenterId ?? '').trim();

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!url) return [null, '수집 서버 URL은 필수입니다.'];
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  // URL 형식 검증 — http/https + 유효 호스트만 허용(잘못된 스킴/입력 차단).
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return [null, 'http/https URL만 허용됩니다.'];
    if (!u.hostname) return [null, '수집 서버 URL의 호스트가 올바르지 않습니다.'];
    // 링크로컬/클라우드 메타데이터(169.254.0.0/16, fd00::/8 등)는 차단(SSRF 방어). 수집 서버는
    // 사설 IP(192.168.x.x 등)에 두므로 RFC1918 사설 대역은 허용한다.
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (/^169\.254\./.test(host) || /^fe80:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) {
      return [null, '링크로컬/메타데이터 주소는 수집 서버로 사용할 수 없습니다.'];
    }
  } catch { return [null, '수집 서버 URL 형식이 올바르지 않습니다.']; }

  const entry = {
    id, name, url, datacenter, vcenterId,
    token: body.token ? String(body.token) : e.token || '',
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  return [entry, null];
}

export function addCollector(body) {
  const list = loadCollectors();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  // 대소문자 무시 중복 방지 — 'GM1'이 있으면 'gm1' 추가를 막는다(같은 엣지 이중 등록 방지).
  const dupe = list.find((c) => String(c.id).toLowerCase() === String(entry.id).toLowerCase());
  if (dupe) return { ok: false, reason: `이미 존재하는 id: ${dupe.id}` };
  list.push(entry);
  save(list);
  return { ok: true, collector: redact(entry) };
}

export function updateCollector(id, body) {
  const list = loadCollectors();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: `없는 수집 서버: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  save(list);
  return { ok: true, collector: redact(entry) };
}

/**
 * 엣지 자기등록(EDGE_MODE=all) upsert — 같은 id(에이전트 이름)가 있으면 URL/토큰/DC를
 * 갱신하고, 없으면 추가한다. 관리자가 수동 등록한 항목의 enabled/vcenterId는 보존.
 */
export function upsertCollectorFromAgent({ name, url, token, datacenter = '' } = {}) {
  const id = String(name || '').trim();
  if (!id) return { ok: false, reason: 'name(에이전트 이름)은 필수입니다.' };
  const list = loadCollectors();
  // 대소문자 무시 매칭 — 'gm1' 자기등록이 기존 'GM1'을 새 항목으로 추가해 중복되던 것 방지.
  // 기존 항목의 실제 id를 그대로 두고 URL/토큰만 갱신한다(관리자 매핑·표시이름 보존).
  const existing = list.find((c) => String(c.id).toLowerCase() === id.toLowerCase());
  if (existing) {
    return updateCollector(existing.id, { url, token, datacenter: datacenter || existing.datacenter, name: existing.name || existing.id });
  }
  return addCollector({ id, name: id, url, token, datacenter, enabled: true });
}

export function removeCollector(id) {
  const list = loadCollectors();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 수집 서버: ${id}` };
  save(next);
  return { ok: true };
}
