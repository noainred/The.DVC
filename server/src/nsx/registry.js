/**
 * NSX Manager registry — read/write the managed list in CONFIG_DIR/nsx.json,
 * with validation, password redaction, and a connectivity test. Edited through
 * the admin API. The file is written 0600 because it holds credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { NsxClient } from './client.js';
import { ensureNsxDial } from './proxy.js';
import { describeError } from '../util/errors.js';
import { retryTransient } from '../util/resilientFetch.js';

const FILE = path.join(config.configDir, 'nsx.json');
const REGIONS = ['아시아', '중국', '유럽', '북미'];

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.managers) ? parsed.managers : [];
  } catch {
    return [];
  }
}

function saveRegistry(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ managers: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

export function redact(m) {
  const { password, ...rest } = m;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/** Validate + normalize an incoming NSX Manager payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  const host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://... 형식이어야 합니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  const loc = body.location || e.location || {};
  const region = REGIONS.includes(loc.region) ? loc.region : (loc.region || 'Unknown');

  const intRaw = body.pollIntervalSec ?? e.pollIntervalSec;
  const toRaw = body.timeoutMs ?? e.timeoutMs;
  const pollIntervalSec = intRaw != null && intRaw !== '' ? Math.max(0, Math.round(Number(intRaw) || 0)) : 0;
  const timeoutMs = toRaw != null && toRaw !== '' ? Math.max(0, Math.round(Number(toRaw) || 0)) : 0;
  const enabled = body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false);

  const entry = {
    id, name, host, username,
    password: body.password ? String(body.password) : e.password || '',
    vcenterId: String(body.vcenterId ?? e.vcenterId ?? '').trim(),
    // 다른 법인의 NSX를 등록된 HAProxy(중계 서버) 경유로 연결. 빈 값 = 직접 연결.
    proxyId: String(body.proxyId ?? e.proxyId ?? '').trim(),
    location: { region },
    enabled, pollIntervalSec, timeoutMs,
  };
  return [entry, null];
}

export function addManager(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((m) => m.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, manager: redact(entry) };
}

export function updateManager(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, reason: `없는 NSX Manager: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, manager: redact(entry) };
}

export function removeManager(id) {
  const list = loadRegistry();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 NSX Manager: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/** Test connectivity to an NSX Manager (login). Uses the stored password when omitted. */
export async function testConnection(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((m) => m.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  const started = Date.now();
  try {
    // 고RTT 블립으로 '연결 안 됨' 오판되지 않도록 일시 오류는 1회 재시도.
    const viaProxy = await retryTransient(async () => {
      const dial = await ensureNsxDial(entry); // proxyId가 있으면 HAProxy 경유로 테스트
      const client = new NsxClient(entry, dial);
      await client.ping();
      return !!dial;
    });
    return { ok: true, ms: Date.now() - started, viaProxy };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}
