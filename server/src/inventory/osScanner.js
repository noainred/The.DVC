/**
 * 실제 OS 인벤토리 스캐너 — 주기적으로 'DB에 없는(또는 오래된) VM'을 찾아 게스트에서 실제 OS를 읽어 저장.
 * 범위: 전체 vCenter 또는 1개. 주기/대수/재스캔 일수는 설정. 게스트 자격증명은 GPU 게스트 설정 재사용(OS별).
 * 설정: CONFIG_DIR/os-scan.json.
 */

import fs from 'node:fs';
import { morefOf } from '../vcenter/registry.js';   // v2.447: vcenterId 에 콜론이 있어도 안전한 moref 추출(감사 B1)
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { VimSoapClient } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { detectGuestOs } from './osDetect.js';
import { upsertOs, getScanInfo, osSummary, pruneMissing } from './osStore.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { gpuAuthGuard, isGpuAuthError, guestAccountStopDev } from '../gpu/sshCollect.js';
import { authStopView, createAuthBreaker, runWithBreakerWarmup } from '../util/authGuard.js';

const FILE = path.join(config.configDir, 'os-scan.json');
const DEFAULTS = { enabled: false, intervalMin: 720, scope: 'all', maxVms: 200, rescanDays: 30, concurrency: 4 };

/**
 * 손상 파일 보존 — 파싱 실패를 조용히 기본값으로 리셋하면 스캐너가 꺼지고(enabled=false 기본)
 * lastRun까지 사라져 재기동 직후 전 VM 재스캔이 도는데도 원인을 알 수 없다.
 * <file>.corrupt.<ts>로 옮겨 두고 경고만 — 기동은 계속(기본값).
 */
function backupCorrupt(err) {
  try {
    const bak = `${FILE}.corrupt.${Date.now()}`;
    fs.renameSync(FILE, bak);
    console.warn(`[osscan] ${FILE} 읽기/파싱 실패(${err?.message || err}) — ${bak}로 보존하고 기본 설정으로 시작합니다.`);
  } catch { /* 보존 실패가 기동을 막지 않게 */ }
}

let cache = null;
export function loadOsScanSettings() {
  if (cache) return cache;
  let p = {};
  try {
    if (fs.existsSync(FILE)) {
      p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아님'); // 형식 불일치도 손상
    }
  } catch (e) { p = {}; backupCorrupt(e); }
  cache = {
    enabled: !!p.enabled,
    intervalMin: clamp(p.intervalMin, 5, 100000, DEFAULTS.intervalMin),
    scope: p.scope || 'all',
    maxVms: clamp(p.maxVms, 1, 5000, DEFAULTS.maxVms),
    rescanDays: clamp(p.rescanDays, 0, 3650, DEFAULTS.rescanDays),
    concurrency: clamp(p.concurrency, 1, 16, DEFAULTS.concurrency),
    lastRun: p.lastRun || null, lastFound: p.lastFound ?? null, lastErr: p.lastErr || '',
    lastAuth: (p.lastAuth && typeof p.lastAuth === 'object' && !Array.isArray(p.lastAuth)) ? p.lastAuth : null,
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
    lastRun: cur.lastRun, lastFound: cur.lastFound, lastErr: cur.lastErr, lastAuth: cur.lastAuth,
  };
  write(next);
  return loadOsScanSettings();
}
// 원자적 쓰기 — 스캔 1회마다 lastRun/lastFound를 저장하므로(주기 기본 12시간, 수동 실행 포함)
// 부분기록 시 설정이 기본값으로 리셋되어 스캐너가 조용히 꺼진다. tmp+fsync+rename으로 방지.
function write(obj) { try { atomicWriteFileSync(FILE, JSON.stringify(obj, null, 2), { mode: 0o600 }); } catch { /* */ } cache = null; }


/**
 * 게스트 계정 정지 id — GPU 게스트 폴러와 **같은 이름공간·같은 파일**(`gpu-auth-stops.json`, `vm|<vcId>|<vmId>`)이다
 * (v2.591 — 감사 F2). 두 도구가 `resolveVmCreds` 로 **같은 VM·같은 계정**을 쓰므로 정지를 따로 두면 한쪽이 멈춰도
 * 다른 쪽이 같은 계정으로 계속 실패 로그온한다(GPU 폴러가 막은 경로를 이 도구가 우회하던 결함).
 */
const guestStopDev = (vcId, vmId, creds) => ({ id: `vm|${vcId}|${vmId}`, username: creds.username, password: creds.password });

/**
 * 스캔 대상 VM 선별: 범위 내 전원 ON + Tools 동작 + (DB에 없거나 rescanDays 초과 또는 직전 오류).
 * v2.591: 주기 실행에서는 **게스트 계정이 인증 실패로 멈춘 VM 을 제외**한다 — '직전 오류 재선택' 규칙이 정지 VM 을
 * 매 주기 다시 골라 maxVms 슬롯까지 차지하던 것을 막는다. 제외 개수는 `authStopped` 로 돌려준다(조용히 빼지 않는다).
 */
function pickTargets(scopeVcId, settings, { manual = false } = {}) {
  const snap = store.get();
  const cut = settings.rescanDays > 0 ? Date.now() - settings.rescanDays * 86_400_000 : -1;
  let vms = (snap.vms || []).filter((v) => !v.template && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING');
  if (scopeVcId) vms = vms.filter((v) => v.vcenterId === scopeVcId);
  const due = vms.filter((v) => { const info = getScanInfo(v.id); if (!info) return true; if (info.error) return true; return cut > 0 && (info.at || 0) < cut; });
  if (manual) return { targets: due.slice(0, settings.maxVms), authStopped: 0 };
  const gset = loadGpuGuestSettings();
  let authStopped = 0;
  const out = [];
  for (const v of due) {
    const creds = resolveVmCreds(gset, v.vcenterId, v.id, /windows/i.test(v.guestOS || ''));
    if (creds?.username && gpuAuthGuard.peekAuthStop(guestStopDev(v.vcenterId, v.id, creds))) { authStopped += 1; continue; }
    // 계정 단위 정지(차단기가 끊은 공용 계정) — 이 스캐너가 기록의 주인이라 authStopFor(자격증명이 바뀌면 지우고 재개).
    if (creds?.username && gpuAuthGuard.authStopFor(guestAccountStopDev(v.vcenterId, creds))) { authStopped += 1; continue; }
    out.push(v);
    if (out.length >= settings.maxVms) break;
  }
  return { targets: out, authStopped };
}

async function scanVcenter(vc, targets, settings, { manual = false } = {}) {
  const snap = store.get();
  const hostByName = new Map(); for (const h of snap.hosts || []) if (h.vcenterId === vc.id) hostByName.set(h.name, h);
  const gset = loadGpuGuestSettings();
  let found = 0; const errs = [];
  const auth = { vcStopped: null, vmStopped: 0, breaker: null };
  // v2.591(감사 F1): 인벤토리 수집과 같은 vCenter 계정 — 멈춰 있으면 주기 실행은 로그인하지 않는다(읽기 전용 조회 —
  //   해제는 주 폴러·연결 테스트만). 수동 실행은 막지 않는다.
  if (!manual) {
    const st = vcAuthGuard.peekAuthStop(vc);
    if (st) { auth.vcStopped = authStopView(st); errs.push(`로그인:vCenter 인증 실패로 주기 스캔 정지(${st.attempts}회)`); return { found, errs, auth }; }
  }
  // v2.591(감사 F2): 한 실행 안의 회로 차단기 — 같은 게스트 계정의 거부가 연속 3회면 그 계정의 남은 VM 을 시작하지
  //   않는다(공용 도메인 계정이면 한 번에 수백 회 실패 로그온이 난다). 첫 로그인 성공 전까지는 하나씩 돈다.
  //   수동 실행에도 적용한다(한 번 누르면 수백 대일 수 있다).
  const breaker = createAuthBreaker({ threshold: 3 });
  const c = new VimSoapClient(vc);
  try {
    try { await c.login(); }
    catch (e) {
      if (isVcAuthError(e)) auth.vcStopped = authStopView(vcAuthGuard.markAuthStopped(vc.id, vc, e.message));
      throw e;
    }
    await runWithBreakerWarmup(targets, settings.concurrency, breaker, async (v) => {
      const isWindows = /windows/i.test(v.guestOS || '');
      const creds = resolveVmCreds(gset, vc.id, v.id, isWindows);
      if (!creds || !creds.username) { upsertOs(v, null, '게스트 계정 없음'); errs.push(`${v.name}:계정없음`); return; }
      const dev = guestStopDev(vc.id, v.id, creds);
      if (!breaker.allow(dev)) return;   // 이번 실행에서 이 계정이 끊겼다 — 시작하지 않는다(개수는 breaker 가 센다)
      const moref = morefOf(v.id, vc.id);
      const h = hostByName.get(v.host); const dlHosts = h ? [h.mgmtIp, h.name].filter(Boolean) : [];
      try {
        const detected = await detectGuestOs(c, moref, creds, { isWindows, dlHosts });
        breaker.ok(dev);
        gpuAuthGuard.clearAuthStop(dev.id);
        gpuAuthGuard.clearAuthStop(guestAccountStopDev(vc.id, creds).id);   // 그 계정이 통했다 — 계정 단위 정지도 푼다
        upsertOs(v, detected); found++;
      } catch (e) {
        if (isGpuAuthError(e)) {
          // 게스트 계정 거부 — GPU 폴러와 같은 기록(VM 단위)에 올리고, 주기 실행에서 이 VM 을 더는 고르지 않는다.
          const rec = gpuAuthGuard.markAuthStopped(dev.id, dev, e.message);
          auth.vmStopped += 1;
          if (breaker.fail(dev)) {
            console.warn(`[osscan] ${vc.id}: 게스트 계정 ${creds.username} 거부가 연속 ${breaker.summary().threshold}회 — 이번 실행에서 그 계정의 남은 VM 을 건너뛰고 다음 주기부터 계정 단위로 멈춥니다`);
            const ad = guestAccountStopDev(vc.id, creds);
            gpuAuthGuard.markAuthStopped(ad.id, ad, `게스트 계정 거부 연속 ${breaker.summary().threshold}회 — ${e.message}`);
          }
          upsertOs(v, null, `게스트 로그인 실패 — 인증 실패로 주기 스캔 정지(${rec.attempts}회)`);
          errs.push(`${v.name}:게스트 인증 실패`);
        } else {
          breaker.neutral();   // 인증과 무관한 실패 — 계정이 맞는지 모른다(도구 미동작·시한 초과도 여기로 온다). 성공으로 세지 않는다
          upsertOs(v, null, String(e.message).slice(0, 120)); errs.push(`${v.name}:${String(e.message).slice(0, 40)}`);
        }
      }
    });
  } catch (e) { errs.push(`로그인:${e.message}`); }
  finally { await c.logout().catch(() => {}); }
  const bs = breaker.summary();
  if (bs.tripped.length || bs.skipped) auth.breaker = bs;
  return { found, errs, auth };
}

/**
 * 즉시 실행. scopeVcId 지정 시 그 vCenter만, 아니면 설정 scope(all/특정). 반환 요약.
 * v2.591: `trigger` — 타이머는 'auto' 를 넘긴다. **수동('manual', 기본)은 인증 실패 정지를 무시하고 시도한다**
 * (고친 뒤 확인할 길을 없애면 안 된다 — authGuard 규칙 3). 회로 차단기는 수동에도 적용한다.
 */
export async function runOsScanNow(scopeVcId, { trigger = 'manual' } = {}) {
  // v2.478(감사 B2): 수동 '지금 스캔' API 와 60초 틱이 가드를 공유한다 — 겹치면 SSH/SOAP 세션 2배 +
  // lastFound/lastErr 상호 덮어쓰기(net/monitor.runMonitorNow 패턴).
  if (running) return { ok: false, skipped: true, reason: '이미 스캔이 진행 중입니다.' };
  running = true;
  try { return await runOsScanNowInner(scopeVcId, trigger === 'manual'); } finally { running = false; }
}
async function runOsScanNowInner(scopeVcId, manual) {
  const s = loadOsScanSettings();
  const scope = scopeVcId || (s.scope && s.scope !== 'all' ? s.scope : '');
  const vcs = (loadVcenterConfig().vcenters || []).filter((v) => !scope || v.id === scope);
  if (!vcs.length) { write({ ...rawSettings(), lastRun: Date.now(), lastErr: 'live vCenter 설정 없음' }); return { ok: false, reason: 'live vCenter 설정 없음(데모/미구성)' }; }
  let total = 0; const allErrs = [];
  // v2.591: 인증 정지 사실을 상태에 남긴다(화면이 말한다 — 조용한 정지 금지).
  const lastAuth = { at: Date.now(), manual, vcStopped: [], vmStopped: 0, vmSkipped: 0, breakerTripped: [], breakerSkipped: 0 };
  for (const vc of vcs) {
    const { targets, authStopped } = pickTargets(vc.id, s, { manual });
    lastAuth.vmSkipped += authStopped;
    if (!targets.length) continue;
    const r = await scanVcenter(vc, targets, s, { manual });
    total += r.found; allErrs.push(...r.errs);
    if (r.auth.vcStopped) lastAuth.vcStopped.push({ vcenterId: vc.id, ...r.auth.vcStopped });
    lastAuth.vmStopped += r.auth.vmStopped;
    if (r.auth.breaker) { lastAuth.breakerTripped.push(...r.auth.breaker.tripped.map((t) => ({ vcenterId: vc.id, ...t }))); lastAuth.breakerSkipped += r.auth.breaker.skipped; }
    console.log(`[osscan] ${vc.id} 대상 ${targets.length} → 탐지 ${r.found}${authStopped ? ` · 게스트 인증 정지로 제외 ${authStopped}` : ''}`);
  }
  // 삭제된 VM 정리
  try { const ids = new Set((store.get().vms || []).map((v) => v.id)); pruneMissing(ids); } catch { /* */ }
  const anyAuth = lastAuth.vcStopped.length || lastAuth.vmStopped || lastAuth.vmSkipped || lastAuth.breakerTripped.length || lastAuth.breakerSkipped;
  write({ ...rawSettings(), lastRun: Date.now(), lastFound: total, lastErr: allErrs.slice(0, 5).join(' · '), lastAuth: anyAuth ? lastAuth : null });
  return { ok: true, found: total, summary: osSummary(), ...(anyAuth ? { auth: lastAuth } : {}) };
}

function rawSettings() { const s = loadOsScanSettings(); return { enabled: s.enabled, intervalMin: s.intervalMin, scope: s.scope, maxVms: s.maxVms, rescanDays: s.rescanDays, concurrency: s.concurrency }; }

export function osScanStatus() { const s = loadOsScanSettings(); return { settings: rawSettings(), lastRun: s.lastRun, lastFound: s.lastFound, lastErr: s.lastErr, lastAuth: s.lastAuth || null, summary: osSummary() }; }

let timer = null;
let running = false; // 재진입 방지 — 긴 스캔이 다음 tick과 겹쳐 SSH/SOAP 세션 폭증하는 것을 막는다.
/**
 * 타이머 한 틱(v2.591 — 테스트가 **실제 타이머 경로**를 부를 수 있게 떼어 냈다). 주기가 도래했으면 'auto' 로 돈다.
 * @returns {Promise|null} 실행했으면 그 프라미스
 */
export function osScanTick() {
  if (running) return null;
  const s = loadOsScanSettings();
  if (!s.enabled) return null;
  if (s.lastRun && Date.now() - s.lastRun < s.intervalMin * 60_000) return null;
  // 가드는 runOsScanNow 안에서 공유 · 주기 실행이므로 인증 실패 정지를 따른다('auto').
  return runOsScanNow(undefined, { trigger: 'auto' }).catch((e) => console.warn('[osscan] 실행 실패:', e?.message));
}
export function startOsScanner() {
  timer = setInterval(() => { osScanTick(); }, 60_000);
  timer.unref?.();
  console.log('[osscan] 실제 OS 인벤토리 스캐너 시작');
}
