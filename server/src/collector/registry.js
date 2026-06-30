/**
 * Collector registry — the list of remote collector agents (one per datacenter)
 * the central portal pulls power from. Stored in CONFIG_DIR/collectors.json
 * (0600; holds per-agent tokens). Edited via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { bumpFleetRev } from '../insights/fleetRev.js';

const FILE = path.join(config.configDir, 'collectors.json');

export function loadCollectors() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.collectors) ? parsed.collectors : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ collectors: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
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
  if (list.some((c) => c.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
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

export function removeCollector(id) {
  const list = loadCollectors();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 수집 서버: ${id}` };
  save(next);
  return { ok: true };
}
