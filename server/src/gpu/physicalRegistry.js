/**
 * 물리(베어메탈) GPU 서버 등록부 — 가상화하지 않은 서버를 IP+계정으로 등록해 SSH(nvidia-smi)로
 * GPU를 수집한다. CONFIG_DIR/gpu-physical.json (0600, 비밀번호 포함)에 저장하며, 클라이언트로
 * 내보낼 때는 비밀번호를 가린다.
 *
 *   server: { id, name, host, port, username, password, os, vcenterId, enabled }
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'gpu-physical.json');

let cache = null;

export function loadPhysical() {
  if (cache) return cache;
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.servers || []; } catch { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify({ servers: cache }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** 비밀번호를 가린 목록(클라이언트용). */
export function listPhysical() {
  return loadPhysical().map((s) => ({
    id: s.id, name: s.name, host: s.host, port: s.port || 22, username: s.username || '',
    os: s.os || 'linux', vcenterId: s.vcenterId || '', enabled: s.enabled !== false, hasPassword: !!s.password,
    gpuModels: s.gpuModels || [],
  }));
}

export function getPhysicalRaw(id) { return loadPhysical().find((s) => s.id === id) || null; }
export function findPhysicalByHost(host) { const h = String(host || '').trim().toLowerCase(); return loadPhysical().find((s) => (s.host || '').toLowerCase() === h) || null; }

export function addPhysical(body = {}) {
  const host = String(body.host || '').trim();
  if (!host) return { ok: false, reason: 'IP/호스트가 필요합니다.' };
  if (!body.username) return { ok: false, reason: '계정이 필요합니다.' };
  const list = loadPhysical();
  const id = String(body.id || `pgpu-${crypto.randomBytes(3).toString('hex')}`).trim();
  if (list.find((s) => s.id === id)) return { ok: false, reason: '이미 존재하는 ID입니다.' };
  list.push({
    id, name: String(body.name || host).trim(), host, port: Number(body.port) || 22,
    username: String(body.username).trim(), password: String(body.password || ''),
    os: ['linux', 'windows'].includes(body.os) ? body.os : 'linux',
    vcenterId: String(body.vcenterId || '').trim(), enabled: body.enabled !== false,
    gpuModels: Array.isArray(body.gpuModels) ? body.gpuModels.slice(0, 32) : [],
  });
  cache = list; persist();
  return { ok: true, id };
}

export function updatePhysical(id, body = {}) {
  const s = getPhysicalRaw(id);
  if (!s) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  if (body.name !== undefined) s.name = String(body.name || '').trim() || s.host;
  if (body.host !== undefined) s.host = String(body.host || '').trim();
  if (body.port !== undefined) s.port = Number(body.port) || 22;
  if (body.username !== undefined) s.username = String(body.username || '').trim();
  // 빈 비밀번호 = 기존 유지
  if (body.password !== undefined && body.password !== '') s.password = String(body.password);
  if (body.os !== undefined && ['linux', 'windows'].includes(body.os)) s.os = body.os;
  if (body.vcenterId !== undefined) s.vcenterId = String(body.vcenterId || '').trim();
  if (body.enabled !== undefined) s.enabled = !!body.enabled;
  if (Array.isArray(body.gpuModels)) s.gpuModels = body.gpuModels.slice(0, 32);
  persist();
  return { ok: true };
}

export function removePhysical(id) {
  const list = loadPhysical();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  cache = next; persist();
  return { ok: true };
}
