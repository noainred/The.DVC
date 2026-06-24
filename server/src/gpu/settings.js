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
  maxVmsPerVcenter: 1000, // 법인당 한 주기 최대 처리 VM(폭주 방지 안전상한)
  // { [vcenterId]: { enabled, username, password, vms: { [vmId]: { username, password } } } }
  //  - username/password : 법인 공용(기본) 계정 — 같은 계정 쓰는 VM에 적용(선택)
  //  - vms[vmId]         : VM별 계정 override(VM마다 계정이 다를 때). 있으면 공용보다 우선.
  vcenters: {},
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
    maxVmsPerVcenter: clamp(p.maxVmsPerVcenter, 1, 100_000, DEFAULTS.maxVmsPerVcenter),
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
  if (partial.maxVmsPerVcenter !== undefined) next.maxVmsPerVcenter = clamp(partial.maxVmsPerVcenter, 1, 100_000, DEFAULTS.maxVmsPerVcenter);
  next.vcenters = { ...(cur.vcenters || {}) };
  if (partial.vcenters && typeof partial.vcenters === 'object') {
    for (const [id, v] of Object.entries(partial.vcenters)) {
      const prev = next.vcenters[id] || {};
      const merged = {
        enabled: v.enabled !== undefined ? Boolean(v.enabled) : (prev.enabled ?? false),
        // username/password = Linux(기본) 공용 계정
        username: v.username !== undefined ? String(v.username || '') : (prev.username || ''),
        // 빈 비밀번호 = 기존 유지
        password: (v.password !== undefined && v.password !== '') ? String(v.password) : (prev.password || ''),
        // winUsername/winPassword = Windows 공용 계정(별도). 비우면 Linux 계정으로 폴백.
        winUsername: v.winUsername !== undefined ? String(v.winUsername || '') : (prev.winUsername || ''),
        winPassword: (v.winPassword !== undefined && v.winPassword !== '') ? String(v.winPassword) : (prev.winPassword || ''),
        vms: { ...(prev.vms || {}) }, // VM별 자격증명 override
      };
      if (v.vms && typeof v.vms === 'object') {
        for (const [vmId, cred] of Object.entries(v.vms)) {
          if (cred === null) { delete merged.vms[vmId]; continue; } // 공용으로 전환 = override 제거
          const pv = merged.vms[vmId] || {};
          merged.vms[vmId] = cred.passwordless
            // passwordless = 비번 없는 계정(빈 비번으로 인증). 저장값으로 폴백하지 않는다.
            ? { username: String(cred.username ?? pv.username ?? ''), password: '', passwordless: true }
            : {
              username: cred.username !== undefined ? String(cred.username || '') : (pv.username || ''),
              password: (cred.password !== undefined && cred.password !== '') ? String(cred.password) : (pv.password || ''),
            };
        }
      }
      next.vcenters[id] = merged;
    }
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  return loadGpuGuestSettings();
}

/** 비밀번호를 가려 클라이언트로 안전하게 내보낸다(VM별 자격증명 포함). */
export function redactGpuGuestSettings(s) {
  const vcenters = {};
  for (const [id, v] of Object.entries(s.vcenters || {})) {
    const vms = {};
    for (const [vmId, c] of Object.entries(v.vms || {})) vms[vmId] = { username: c.username || '', hasPassword: !!c.password, passwordless: !!c.passwordless };
    vcenters[id] = { enabled: !!v.enabled, username: v.username || '', hasPassword: !!v.password, winUsername: v.winUsername || '', hasWinPassword: !!v.winPassword, vms };
  }
  return { enabled: s.enabled, pollIntervalMs: s.pollIntervalMs, concurrency: s.concurrency, timeoutMs: s.timeoutMs, maxVmsPerVcenter: s.maxVmsPerVcenter, vcenters };
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

/**
 * VM 단위 게스트 자격증명 해석: VM별 override(자체 계정)가 있으면 그것을, 없으면
 * 법인(vCenter) 공용 계정으로 fallback. 둘 다 없으면 null(수집 대상 아님).
 * 반환 source: 'vm'(VM별) | 'vc'(법인 공용).
 */
export function resolveVmCreds(s, vcId, vmId, isWindows = false) {
  const vc = (s.vcenters || {})[vcId];
  if (!vc) return null;
  const per = (vc.vms || {})[vmId];
  if (per && per.username) return { username: per.username, password: per.password || '', source: 'vm' };
  // OS별 공용 계정: Windows VM이고 Windows 공용 계정이 있으면 그것, 아니면 Linux(기본) 공용 계정으로 폴백.
  if (isWindows && vc.winUsername) return { username: vc.winUsername, password: vc.winPassword || '', source: 'vc-win' };
  if (vc.username) return { username: vc.username, password: vc.password || '', source: 'vc' };
  return null;
}
