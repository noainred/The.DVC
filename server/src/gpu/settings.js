/**
 * GPU 게스트 수집 설정 — 어떤 법인(vCenter)의 패스쓰루 GPU VM을 게스트 OS 계정으로
 * 모니터링할지, 폴링 주기/동시성/타임아웃, 그리고 vCenter별 게스트 OS 자격증명을
 * 보관한다. config/gpu-guest.json (gitignore, 0600 — 비밀번호 포함)에 저장하며,
 * 클라이언트로 내보낼 때는 비밀번호를 가린다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'gpu-guest.json');

const DEFAULTS = {
  enabled: false,
  pollIntervalMs: 60_000, // 1분
  concurrency: 4,         // 동시에 게스트 작업할 VM 수(고RTT 보호)
  timeoutMs: 20_000,      // VM당 게스트 작업 타임아웃
  vcenters: {},           // { [vcenterId]: { enabled, username, password } }
};

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

export function loadGpuGuestSettings() {
  const p = readFile();
  return {
    enabled: p.enabled ?? DEFAULTS.enabled,
    pollIntervalMs: clamp(p.pollIntervalMs, 10_000, 86_400_000, DEFAULTS.pollIntervalMs),
    concurrency: clamp(p.concurrency, 1, 32, DEFAULTS.concurrency),
    timeoutMs: clamp(p.timeoutMs, 3_000, 120_000, DEFAULTS.timeoutMs),
    vcenters: p.vcenters && typeof p.vcenters === 'object' ? p.vcenters : {},
  };
}

function clamp(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Persist a partial update. vcenters는 병합하며, 빈 password는 기존 값을 유지한다. */
export function saveGpuGuestSettings(partial) {
  const cur = readFile();
  const next = { ...DEFAULTS, ...cur };
  if (partial.enabled !== undefined) next.enabled = Boolean(partial.enabled);
  if (partial.pollIntervalMs !== undefined) next.pollIntervalMs = clamp(partial.pollIntervalMs, 10_000, 86_400_000, DEFAULTS.pollIntervalMs);
  if (partial.concurrency !== undefined) next.concurrency = clamp(partial.concurrency, 1, 32, DEFAULTS.concurrency);
  if (partial.timeoutMs !== undefined) next.timeoutMs = clamp(partial.timeoutMs, 3_000, 120_000, DEFAULTS.timeoutMs);
  next.vcenters = { ...(cur.vcenters || {}) };
  if (partial.vcenters && typeof partial.vcenters === 'object') {
    for (const [id, v] of Object.entries(partial.vcenters)) {
      const prev = next.vcenters[id] || {};
      next.vcenters[id] = {
        enabled: v.enabled !== undefined ? Boolean(v.enabled) : (prev.enabled ?? false),
        username: v.username !== undefined ? String(v.username || '') : (prev.username || ''),
        // 빈 비밀번호 = 기존 유지
        password: (v.password !== undefined && v.password !== '') ? String(v.password) : (prev.password || ''),
      };
    }
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  return loadGpuGuestSettings();
}

/** 비밀번호를 가려 클라이언트로 안전하게 내보낸다. */
export function redactGpuGuestSettings(s) {
  const vcenters = {};
  for (const [id, v] of Object.entries(s.vcenters || {})) {
    vcenters[id] = { enabled: !!v.enabled, username: v.username || '', hasPassword: !!v.password };
  }
  return { enabled: s.enabled, pollIntervalMs: s.pollIntervalMs, concurrency: s.concurrency, timeoutMs: s.timeoutMs, vcenters };
}

export function isVcenterGpuMonitored(vcId) {
  const s = loadGpuGuestSettings();
  return s.enabled && !!s.vcenters[vcId]?.enabled;
}

export function getGuestCreds(vcId) {
  const s = loadGpuGuestSettings();
  const v = s.vcenters[vcId];
  return v && v.username ? { username: v.username, password: v.password || '' } : null;
}
