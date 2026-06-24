/**
 * 실제 OS 인벤토리 스캐너 — 주기적으로 'DB에 없는(또는 오래된) VM'을 찾아 게스트에서 실제 OS를 읽어 저장.
 * 범위: 전체 vCenter 또는 1개. 주기/대수/재스캔 일수는 설정. 게스트 자격증명은 GPU 게스트 설정 재사용(OS별).
 * 설정: CONFIG_DIR/os-scan.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { VimSoapClient } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { detectGuestOs } from './osDetect.js';
import { upsertOs, getScannedIds, getScanInfo, osSummary, pruneMissing } from './osStore.js';

const FILE = path.join(config.configDir, 'os-scan.json');
const DEFAULTS = { enabled: false, intervalMin: 720, scope: 'all', maxVms: 200, rescanDays: 30, concurrency: 4 };

let cache = null;
export function loadOsScanSettings() {
  if (cache) return cache;
  let p = {};
  try { if (fs.existsSync(FILE)) p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { p = {}; }
  cache = {
    enabled: !!p.enabled,
    intervalMin: clamp(p.intervalMin, 5, 100000, DEFAULTS.intervalMin),
    scope: p.scope || 'all',
    maxVms: clamp(p.maxVms, 1, 5000, DEFAULTS.maxVms),
    rescanDays: clamp(p.rescanDays, 0, 3650, DEFAULTS.rescanDays),
    concurrency: clamp(p.concurrency, 1, 16, DEFAULTS.concurrency),
    lastRun: p.lastRun || null, lastFound: p.lastFound ?? null, lastErr: p.lastErr || '',
  };
  return cache;
}
function clamp(v, mn, mx, d) { const n = Number(v); return Number.isFinite(n) ? Math.max(mn, Math.min(mx, Math.round(n))) : d; }

export function saveOsScanSettings(body = {}) {
  const cur = loadOsScanSettings();
  const next = {
    enabled: body.enabled !== undefined ? !!body.enabled : cur.enabled,
    intervalMin: body.intervalMin !== undefined ? clamp(body.intervalMin, 5, 100000, cur.intervalMin) : cur.intervalMin,
    scope: body.scope !== undefined ? String(body.scope || 'all') : cur.scope,
    maxVms: body.maxVms !== undefined ? clamp(body.maxVms, 1, 5000, cur.maxVms) : cur.maxVms,
    rescanDays: body.rescanDays !== undefined ? clamp(body.rescanDays, 0, 3650, cur.rescanDays) : cur.rescanDays,
    concurrency: body.concurrency !== undefined ? clamp(body.concurrency, 1, 16, cur.concurrency) : cur.concurrency,
    lastRun: cur.lastRun, lastFound: cur.lastFound, lastErr: cur.lastErr,
  };
  write(next);
  return loadOsScanSettings();
}
function write(obj) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), { mode: 0o600 }); } catch { /* */ } cache = null; }

async function eachLimited(items, limit, fn) { let i = 0; const w = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); }

/** 스캔 대상 VM 선별: 범위 내 전원 ON + Tools 동작 + (DB에 없거나 rescanDays 초과). */
function pickTargets(scopeVcId, settings) {
  const snap = store.get();
  const scanned = getScannedIds();
  const cut = settings.rescanDays > 0 ? Date.now() - settings.rescanDays * 86_400_000 : -1;
  let vms = (snap.vms || []).filter((v) => !v.template && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING');
  if (scopeVcId) vms = vms.filter((v) => v.vcenterId === scopeVcId);
  return vms.filter((v) => { const info = getScanInfo(v.id); if (!info) return true; if (info.error) return true; return cut > 0 && (info.at || 0) < cut; }).slice(0, settings.maxVms);
}

async function scanVcenter(vc, targets, settings) {
  const snap = store.get();
  const hostByName = new Map(); for (const h of snap.hosts || []) if (h.vcenterId === vc.id) hostByName.set(h.name, h);
  const gset = loadGpuGuestSettings();
  const c = new VimSoapClient(vc);
  let found = 0; const errs = [];
  try {
    await c.login();
    await eachLimited(targets, settings.concurrency, async (v) => {
      const isWindows = /windows/i.test(v.guestOS || '');
      const creds = resolveVmCreds(gset, vc.id, v.id, isWindows);
      if (!creds || !creds.username) { upsertOs(v, null, '게스트 계정 없음'); errs.push(`${v.name}:계정없음`); return; }
      const moref = String(v.id).split(':').slice(1).join(':') || String(v.id);
      const h = hostByName.get(v.host); const dlHosts = h ? [h.mgmtIp, h.name].filter(Boolean) : [];
      try {
        const detected = await detectGuestOs(c, moref, creds, { isWindows, dlHosts });
        upsertOs(v, detected); found++;
      } catch (e) { upsertOs(v, null, String(e.message).slice(0, 120)); errs.push(`${v.name}:${String(e.message).slice(0, 40)}`); }
    });
  } catch (e) { errs.push(`로그인:${e.message}`); }
  finally { await c.logout().catch(() => {}); }
  return { found, errs };
}

/** 즉시 실행. scopeVcId 지정 시 그 vCenter만, 아니면 설정 scope(all/특정). 반환 요약. */
export async function runOsScanNow(scopeVcId) {
  const s = loadOsScanSettings();
  const scope = scopeVcId || (s.scope && s.scope !== 'all' ? s.scope : '');
  const vcs = (loadVcenterConfig().vcenters || []).filter((v) => !scope || v.id === scope);
  if (!vcs.length) { write({ ...rawSettings(), lastRun: Date.now(), lastErr: 'live vCenter 설정 없음' }); return { ok: false, reason: 'live vCenter 설정 없음(데모/미구성)' }; }
  let total = 0; const allErrs = [];
  for (const vc of vcs) {
    const targets = pickTargets(vc.id, s);
    if (!targets.length) continue;
    const r = await scanVcenter(vc, targets, s);
    total += r.found; allErrs.push(...r.errs);
    console.log(`[osscan] ${vc.id} 대상 ${targets.length} → 탐지 ${r.found}`);
  }
  // 삭제된 VM 정리
  try { const ids = new Set((store.get().vms || []).map((v) => v.id)); pruneMissing(ids); } catch { /* */ }
  write({ ...rawSettings(), lastRun: Date.now(), lastFound: total, lastErr: allErrs.slice(0, 5).join(' · ') });
  return { ok: true, found: total, summary: osSummary() };
}

function rawSettings() { const s = loadOsScanSettings(); return { enabled: s.enabled, intervalMin: s.intervalMin, scope: s.scope, maxVms: s.maxVms, rescanDays: s.rescanDays, concurrency: s.concurrency }; }

export function osScanStatus() { const s = loadOsScanSettings(); return { settings: rawSettings(), lastRun: s.lastRun, lastFound: s.lastFound, lastErr: s.lastErr, summary: osSummary() }; }

let timer = null;
export function startOsScanner() {
  timer = setInterval(() => {
    const s = loadOsScanSettings();
    if (!s.enabled) return;
    if (s.lastRun && Date.now() - s.lastRun < s.intervalMin * 60_000) return;
    runOsScanNow().catch((e) => console.warn('[osscan] 실행 실패:', e?.message));
  }, 60_000);
  timer.unref?.();
  console.log('[osscan] 실제 OS 인벤토리 스캐너 시작');
}
