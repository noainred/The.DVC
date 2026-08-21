/**
 * bmstor/registry.js — 베어메탈 스토리지 서버 목록 + 설정(v2.340).
 * CONFIG_DIR/bm-storage.json (0600, 원자적 쓰기, 손상 보존, v2.296 비밀 봉인) —
 * 수집 서버/배포 대상 레지스트리와 동일 계약.
 *
 * 서버: { id, name, host, port, username, password, agent(엣지 이름 — 빈 값=중앙 직접),
 *         group(합산 그룹 라벨), mounts:[절대경로...], enabled }
 * 설정: { intervalMinutes } — 사용자가 정하는 수집 주기(기본 10분, 1~1440 클램프).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { sanitizeMounts } from './collect.js';

const FILE = path.join(config.configDir, 'bm-storage.json');
const DEFAULT_INTERVAL_MIN = 10;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = { servers: openSecretsDeep(Array.isArray(j?.servers) ? j.servers : []), settings: j?.settings || {} };
    }
  } catch { preserveCorrupt(FILE); cache = null; }
  if (!cache) cache = { servers: [], settings: {} };
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ servers: cache.servers, settings: cache.settings }), null, 2), { mode: 0o600 });
}

const redact = ({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) });

export function listBmServers() { return load().servers.map(redact); }
/** 폴러 전용 원본(비밀 포함, 클론) — API 응답에 절대 그대로 내보내지 말 것. */
export function listBmServersRaw() { return structuredClone(load().servers); }

export function getBmSettings() {
  const s = load().settings || {};
  const iv = Number(s.intervalMinutes);
  return { intervalMinutes: Number.isFinite(iv) && iv >= 1 ? Math.min(1440, Math.round(iv)) : DEFAULT_INTERVAL_MIN };
}

export function saveBmSettings(body = {}) {
  const iv = Number(body.intervalMinutes);
  if (!Number.isFinite(iv) || iv < 1 || iv > 1440) return { ok: false, reason: '수집 주기는 1~1440분 사이여야 합니다.' };
  const data = load();
  data.settings = { ...data.settings, intervalMinutes: Math.round(iv) };
  persist();
  return { ok: true, settings: getBmSettings() };
}

/** 추가/수정 — id 있으면 수정(빈 비밀번호는 기존 유지), 없으면 신규. 검증은 저장과 단일 소스. */
export function saveBmServer(body = {}) {
  const host = String(body.host || '').trim();
  if (!host) return { ok: false, reason: 'host는 필수입니다.' };
  if (host.length > 253 || /[\s'"`;|&<>$\\]/.test(host)) return { ok: false, reason: 'host에 사용할 수 없는 문자가 있습니다.' };
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'SSH 포트가 올바르지 않습니다.' };
  const username = String(body.username ?? 'root').trim() || 'root';
  if (/[\s'"`;|&<>$\\]/.test(username)) return { ok: false, reason: '계정에 사용할 수 없는 문자가 있습니다.' };
  const { mounts, errors } = sanitizeMounts(body.mounts);
  if (errors.length) return { ok: false, reason: errors[0] };
  if (!mounts.length) return { ok: false, reason: '측정할 마운트 포인트를 1개 이상 입력하세요(예: / 또는 /data).' };
  if (mounts.length > 64) return { ok: false, reason: '마운트 포인트는 서버당 최대 64개입니다.' };

  const data = load();
  const existing = body.id ? data.servers.find((s) => s.id === body.id) : null;
  if (!existing && data.servers.length >= 1000) return { ok: false, reason: '서버는 최대 1,000대까지 등록할 수 있습니다.' };
  const server = existing || { id: crypto.randomBytes(5).toString('hex') };
  server.host = host;
  server.port = port;
  server.username = username;
  server.name = String(body.name || '').trim() || host;
  server.agent = String(body.agent || '').trim();
  server.group = String(body.group || '').trim();
  server.mounts = mounts;
  server.enabled = body.enabled !== false;
  // 빈/마스킹 비밀번호는 기존 유지(편집 시 재입력 강요 안 함) — 신규인데 비었으면 빈 값 저장(무비번 SSH 허용 안 하는 서버는 수집 실패로 표시됨).
  if (body.password !== undefined && body.password !== '' && body.password !== '********') server.password = String(body.password);
  else if (!existing) server.password = '';
  if (!existing) data.servers.push(server);
  persist();
  return { ok: true, server: redact(server) };
}

export function removeBmServer(id) {
  const data = load();
  const next = data.servers.filter((s) => s.id !== id);
  if (next.length === data.servers.length) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  data.servers = next;
  persist();
  return { ok: true };
}
