/**
 * Saved agent-deploy targets (CONFIG_DIR/agent-deploy-targets.json, 0600) so a
 * datacenter host's SSH + agent settings can be stored once and (re)deployed —
 * individually or in bulk — without re-entering everything each time.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'agent-deploy-targets.json');
const SECRET_KEYS = ['password', 'privateKey'];
const FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'agentName',
  'centralUrl', 'centralToken', 'collectorToken', 'collectorDatacenter', 'installerPath', 'portalPort', 'autoUpgrade', 'pushInventory', 'enabled'];

let cache = null;

function load() {
  if (cache) return cache;
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.targets || []; } catch { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ targets: cache }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
}

const redact = (t) => {
  const out = { ...t };
  for (const k of SECRET_KEYS) { out[`has${k[0].toUpperCase()}${k.slice(1)}`] = !!t[k]; delete out[k]; }
  // gpuGuest는 enabled/대상/계정은 보여주되 비밀번호는 가린다(has* 플래그로 저장 여부만 표시).
  if (t.gpuGuest && typeof t.gpuGuest === 'object') {
    const g = t.gpuGuest;
    out.gpuGuest = {
      ...g,
      vcenterPass: '', guestPass: '',
      hasVcenterPass: !!g.vcenterPass, hasGuestPass: !!g.guestPass,
    };
  }
  return out;
};

export function listTargets() { return load().map(redact); }
export function getTargetRaw(id) { return load().find((t) => t.id === id) || null; }
// 같은 호스트(+SSH포트/계정)로 저장된 대상 — 배포 시 중복 생성 없이 기존 대상을 upsert 하기 위함.
export function findTargetByHost(host, port, username) {
  const h = String(host || '').trim();
  if (!h) return null;
  return load().find((t) => String(t.host || '').trim() === h
    && String(t.port || 22) === String(port || 22)
    && String(t.username || '') === String(username || '')) || null;
}

export function saveTarget(body = {}) {
  if (!body.host) return { ok: false, reason: 'host는 필수입니다.' };
  const list = load();
  const existing = body.id ? list.find((t) => t.id === body.id) : null;
  const target = existing || { id: crypto.randomBytes(5).toString('hex'), enabled: true };
  for (const k of FIELDS) {
    if (body[k] === undefined) continue;
    // keep stored secret when UI sends an empty/redacted value
    if (SECRET_KEYS.includes(k) && (body[k] === '' || body[k] === '********')) continue;
    target[k] = body[k];
  }
  // gpuGuest(중첩 객체) 병합 — 'GPU 게스트 수집 자동 구성' 체크/계정을 보존한다.
  // 비밀번호(vcenterPass/guestPass)는 비거나 redacted(********)면 기존 저장값을 유지(편집 시 안 지워짐).
  if (body.gpuGuest && typeof body.gpuGuest === 'object') {
    const prev = target.gpuGuest || {};
    const g = body.gpuGuest;
    const keepSecret = (nv, ov) => (nv && nv !== '' && nv !== '********') ? nv : (ov || '');
    target.gpuGuest = {
      enabled: !!g.enabled,
      vcenterId: g.vcenterId !== undefined ? g.vcenterId : (prev.vcenterId || ''),
      vcenterName: g.vcenterName !== undefined ? g.vcenterName : (prev.vcenterName || ''),
      vcenterHost: g.vcenterHost !== undefined ? g.vcenterHost : (prev.vcenterHost || ''),
      vcenterUser: g.vcenterUser !== undefined ? g.vcenterUser : (prev.vcenterUser || ''),
      vcenterPass: keepSecret(g.vcenterPass, prev.vcenterPass),
      guestUser: g.guestUser !== undefined ? g.guestUser : (prev.guestUser || ''),
      guestPass: keepSecret(g.guestPass, prev.guestPass),
    };
  }
  if (!existing) list.push(target);
  cache = list; persist();
  return { ok: true, target: redact(target) };
}

export function removeTarget(id) {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return { ok: false, reason: '대상을 찾을 수 없습니다.' };
  cache = next; persist();
  return { ok: true };
}

export function recordResult(id, result) {
  const t = getTargetRaw(id);
  if (!t) return;
  t.lastResult = { at: Date.now(), ok: result.ok, active: result.active, reason: result.reason };
  persist();
}
