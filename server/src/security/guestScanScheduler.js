/**
 * 게스트 조사 스케줄러 — 사용자가 지정한 주기로 게스트 OS를 조사해 기록·저장한다.
 * 조사 유형: 'login-fails'(로그인 실패), 'net-issues'(패킷드랍/에러). vCenter별·OS별 지정.
 * 작업 정의는 CONFIG_DIR/guest-scans.json(자격증명 포함, 0600).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { VimSoapClient } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { scanGuestLoginFails } from './guestLoginScan.js';
import { scanGuestNetCounters } from './guestNetScan.js';
import { recordLoginFails } from './loginStore.js';
import { recordNetScan } from './netIssueStore.js';
import { notify } from '../alerts.js';

const FILE = path.join(config.configDir, 'guest-scans.json');

let cache = null;
function load() { if (cache) return cache; cache = []; try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { cache = []; } return cache; }
function persist() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 }); } catch { /* */ } }

const redact = (j) => ({ id: j.id, name: j.name, type: j.type, vcenterId: j.vcenterId, os: j.os, intervalMin: j.intervalMin, days: j.days, maxVms: j.maxVms, enabled: j.enabled, lastRun: j.lastRun || null, lastFound: j.lastFound ?? null, lastErr: j.lastErr || '' });
export function listGuestScans() { return load().map(redact); }

export function saveGuestScan(body = {}) {
  load();
  const id = body.id || `gscan_${Date.now().toString(36)}`;
  const j = {
    id, name: String(body.name || '무제 조사').slice(0, 80),
    type: ['login-fails', 'net-issues'].includes(body.type) ? body.type : 'login-fails',
    vcenterId: String(body.vcenterId || ''), os: ['linux', 'windows', 'all'].includes(body.os) ? body.os : 'all',
    intervalMin: Math.max(1, Math.min(10080, Number(body.intervalMin) || 60)),
    days: Math.max(1, Math.min(90, Number(body.days) || 7)),
    maxVms: Math.max(1, Math.min(2000, Number(body.maxVms) || 100)),
    enabled: body.enabled !== false,
    guestUser: body.guestUser || '', guestPass: body.guestPass || '',
    lastRun: null, lastFound: null, lastErr: '',
  };
  const idx = cache.findIndex((x) => x.id === id);
  if (idx >= 0) {
    const p = cache[idx];
    j.guestUser = body.guestUser || p.guestUser; j.guestPass = body.guestPass || p.guestPass; // 비우면 기존 유지
    j.lastRun = p.lastRun; j.lastFound = p.lastFound; j.lastErr = p.lastErr;
    cache[idx] = j;
  } else cache.push(j);
  persist();
  return redact(j);
}
export function removeGuestScan(id) { load(); const b = cache.length; cache = cache.filter((x) => x.id !== id); if (cache.length !== b) persist(); return b !== cache.length; }

async function eachLimited(items, limit, fn) { let i = 0; const w = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); }

async function runJob(j) {
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === j.vcenterId);
  if (!vc) { j.lastRun = Date.now(); j.lastErr = 'vCenter 설정 없음(live 필요)'; persist(); return; }
  const snap = store.get();
  const hostByName = new Map(); for (const h of snap.hosts || []) if (h.vcenterId === j.vcenterId) hostByName.set(h.name, h);
  const gset = loadGpuGuestSettings();
  let vms = (snap.vms || []).filter((v) => v.vcenterId === j.vcenterId && !v.template && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING');
  if (j.os === 'linux') vms = vms.filter((v) => !/windows/i.test(v.guestOS || ''));
  else if (j.os === 'windows') vms = vms.filter((v) => /windows/i.test(v.guestOS || ''));
  vms = vms.slice(0, j.maxVms);

  const c = new VimSoapClient(vc);
  let found = 0; const errs = [];
  try {
    await c.login();
    await eachLimited(vms, 4, async (v) => {
      const isWindows = /windows/i.test(v.guestOS || '');
      const creds = (j.guestUser && j.guestPass) ? { username: j.guestUser, password: j.guestPass } : resolveVmCreds(gset, j.vcenterId, v.id, isWindows);
      if (!creds || !creds.username) { errs.push(`${v.name}:계정없음`); return; }
      const moref = String(v.id).split(':').slice(1).join(':') || String(v.id);
      const os = isWindows ? 'windows' : 'linux';
      const h = hostByName.get(v.host); const dlHosts = h ? [h.mgmtIp, h.name].filter(Boolean) : [];
      try {
        if (j.type === 'login-fails') {
          const fails = await scanGuestLoginFails(c, moref, creds, { isWindows, days: j.days, dlHosts });
          found += recordLoginFails(fails.map((f) => ({ ...f, source: v.name, kind: 'guest', vm: v.name, vcenterId: j.vcenterId, os })));
        } else {
          const ifaces = await scanGuestNetCounters(c, moref, creds, { isWindows, dlHosts });
          const issues = recordNetScan({ vcenterId: j.vcenterId, vm: v.name, os }, ifaces, { threshold: 1 });
          if (issues.length) { found += issues.length; notify({ key: `netissue:${j.vcenterId}:${v.name}`, severity: 'warning', title: `게스트 네트워크 이슈: ${v.name}`, detail: issues.map((i) => `${i.iface} 드롭 ${i.newDrop}/에러 ${i.newErr}`).join(', ') }).catch(() => {}); }
        }
      } catch (e) { errs.push(`${v.name}:${String(e.message).slice(0, 50)}`); }
    });
  } catch (e) { errs.push(`로그인:${e.message}`); }
  finally { await c.logout().catch(() => {}); }
  j.lastRun = Date.now(); j.lastFound = found; j.lastErr = errs.slice(0, 5).join(' · '); persist();
  console.log(`[gscan] ${j.name}(${j.type}/${j.os}) ${vms.length}대 조사 → ${found}건`);
}

let timer = null;
const runningJobs = new Set(); // 작업 id별 재진입 방지(긴 조사가 다음 tick과 겹치지 않게)
export function startGuestScanScheduler() {
  timer = setInterval(() => {
    const now = Date.now();
    for (const j of load()) {
      if (!j.enabled || runningJobs.has(j.id)) continue;
      if (j.lastRun && now - j.lastRun < j.intervalMin * 60_000) continue;
      runningJobs.add(j.id);
      runJob(j).catch(() => {}).finally(() => runningJobs.delete(j.id));
    }
  }, 60_000);
  timer.unref?.();
  console.log('[gscan] 게스트 조사 스케줄러 시작');
}
export async function runGuestScanNow(id) { const j = load().find((x) => x.id === id); if (!j) return { ok: false, reason: '작업 없음' }; await runJob(j); return { ok: true, ...redact(j) }; }
