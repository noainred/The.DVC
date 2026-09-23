/**
 * 게스트 조사 스케줄러 — 사용자가 지정한 주기로 게스트 OS를 조사해 기록·저장한다.
 * 조사 유형: 'login-fails'(로그인 실패), 'net-issues'(패킷드랍/에러). vCenter별·OS별 지정.
 * 작업 정의는 CONFIG_DIR/guest-scans.json(자격증명 포함, 0600).
 */

import fs from 'node:fs';
import { morefOf } from '../vcenter/registry.js';   // v2.447: vcenterId 에 콜론이 있어도 안전한 moref 추출(감사 B1)
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
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)
import { createAuthGuard, authStopView, createAuthBreaker, runWithBreakerWarmup } from '../util/authGuard.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { gpuAuthGuard, isGpuAuthError, guestAccountStopDev } from '../gpu/sshCollect.js';

const FILE = path.join(config.configDir, 'guest-scans.json');

/**
 * 손상 파일 보존 — 파싱 실패를 조용히 빈 목록으로 리셋하면 다음 persist(스캔 1회만 돌아도 발생)가
 * 손상본을 덮어써 게스트 자격증명을 포함한 작업 정의가 영구 유실되고 원인 추적도 불가능해진다.
 * <file>.corrupt.<ts>로 옮겨 두고(rename이라 0600 그대로) 경고만 — 기동은 계속(빈 목록).
 */
function backupCorrupt(err) {
  try {
    const bak = `${FILE}.corrupt.${Date.now()}`;
    fs.renameSync(FILE, bak);
    console.warn(`[gscan] ${FILE} 읽기/파싱 실패(${err?.message || err}) — ${bak}로 보존하고 빈 목록으로 시작합니다.`);
  } catch { /* 보존 실패가 기동을 막지 않게 */ }
}

let cache = null;
function load() {
  if (cache) return cache;
  cache = [];
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!Array.isArray(p)) throw new Error('배열이 아님'); // 형식 불일치도 손상으로 취급
      cache = openSecretsDeep(p);
    }
  } catch (e) { cache = []; backupCorrupt(e); }
  return cache;
}
// 원자적 쓰기(0600) — runJob이 매 실행마다 lastRun/lastErr을 저장하므로 쓰기 빈도가 높고,
// 그중 한 번이라도 부분기록으로 끊기면 load가 []가 되어 자격증명 포함 작업 정의가 사라진다.
function persist() { try { atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(cache), null, 2), { mode: 0o600 }); } catch { /* */ } }

const redact = (j) => ({ id: j.id, name: j.name, type: j.type, vcenterId: j.vcenterId, os: j.os, intervalMin: j.intervalMin, days: j.days, maxVms: j.maxVms, enabled: j.enabled, lastRun: j.lastRun || null, lastFound: j.lastFound ?? null, lastErr: j.lastErr || '', lastAuth: j.lastAuth || null });
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
    j.lastRun = p.lastRun; j.lastFound = p.lastFound; j.lastErr = p.lastErr; j.lastAuth = p.lastAuth || null;
    cache[idx] = j;
  } else cache.push(j);
  persist();
  return redact(j);
}
export function removeGuestScan(id) { load(); const b = cache.length; cache = cache.filter((x) => x.id !== id); if (cache.length !== b) persist(); return b !== cache.length; }


/**
 * 게스트 조사 **작업 전용 계정**의 인증 실패 정지(v2.591 — 감사 F2). 작업 계정(`guestUser/guestPass`)은 그 작업
 * 하나가 수천 대를 도는 도메인 계정인 경우가 많아, GPU 게스트 기록(`gpu-auth-stops.json`)과 **다른 파일·다른
 * 이름공간**을 쓴다: 작업 단위 `gscan|<jobId>` · VM 단위 `gscan|<jobId>|<vmId>`. 작업 계정이 비어 GPU 게스트 공용
 * 계정(`resolveVmCreds`)으로 도는 VM 은 **GPU 폴러와 같은 기록**(`vm|<vcId>|<vmId>`)을 쓴다 — 같은 VM·같은 계정을
 * 두 도구가 따로 관리하면 한쪽이 멈춰도 다른 쪽이 계속 실패 로그온한다.
 */
export const guestScanAuthGuard = createAuthGuard({ file: 'guestscan-auth-stops.json' });
const jobDevOf = (j) => ({ id: `gscan|${j.id}`, username: j.guestUser, password: j.guestPass });

async function runJob(j, { manual = false } = {}) {
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === j.vcenterId);
  if (!vc) { const cur = (load() || []).find((x) => x.id === j.id) || j; cur.lastRun = j.lastRun = Date.now(); cur.lastErr = j.lastErr = 'vCenter 설정 없음(live 필요)'; persist(); return; }
  const jobCreds = !!(j.guestUser && j.guestPass);
  const lastAuth = { at: Date.now(), manual, vcStopped: null, jobStopped: null, vmStopped: 0, vmSkipped: 0, breaker: null };
  const finish = (found, errs) => {
    const any = lastAuth.vcStopped || lastAuth.jobStopped || lastAuth.vmStopped || lastAuth.vmSkipped || lastAuth.breaker;
    // v2.595(감사 FS-3): 실행 중 편집으로 캐시 항목이 새 객체가 됐으면 **현재 항목**에 쓴다(옛 객체에 쓰면 lastRun 이 사라져 곧바로 재실행).
    const fields = { lastRun: Date.now(), lastFound: found, lastErr: errs.slice(0, 5).join(' · '), lastAuth: any ? lastAuth : null };
    Object.assign(j, fields);
    const cur = (load() || []).find((x) => x.id === j.id);
    if (cur && cur !== j) Object.assign(cur, fields);
    if (cur) persist();
  };
  // v2.591(감사 F1): 인벤토리 수집과 같은 vCenter 계정 — 멈춰 있으면 **주기 실행**은 로그인하지 않는다(읽기 전용 조회 —
  //   해제는 주 폴러·연결 테스트만). 수동 '지금 실행' 은 막지 않는다.
  if (!manual) {
    const st = vcAuthGuard.peekAuthStop(vc);
    if (st) { lastAuth.vcStopped = authStopView(st); finish(null, [`vCenter 인증 실패로 주기 실행 정지(${st.attempts}회) — 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 재개`]); return; }
    // 작업 계정이 인증 실패로 멈춰 있으면(회로 차단기가 기록) 주기 실행은 시작하지 않는다. 계정을 고치면 credHash 가
    // 바뀌어 authStopFor 가 기록을 지우고 이번 주기부터 다시 돈다(자동 재개).
    const js = jobCreds ? guestScanAuthGuard.authStopFor(jobDevOf(j)) : null;
    if (js) { lastAuth.jobStopped = authStopView(js); finish(null, [`작업 계정 ${j.guestUser} 인증 실패로 주기 실행 정지(${js.attempts}회) — 계정을 고치면 자동 재개`]); return; }
  }
  const snap = store.get();
  const hostByName = new Map(); for (const h of snap.hosts || []) if (h.vcenterId === j.vcenterId) hostByName.set(h.name, h);
  const gset = loadGpuGuestSettings();
  let vms = (snap.vms || []).filter((v) => v.vcenterId === j.vcenterId && !v.template && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING');
  if (j.os === 'linux') vms = vms.filter((v) => !/windows/i.test(v.guestOS || ''));
  else if (j.os === 'windows') vms = vms.filter((v) => /windows/i.test(v.guestOS || ''));
  // VM 마다 쓸 계정·정지 기록 — 작업 계정이면 이 작업의 이름공간, 아니면 GPU 게스트 공용 기록.
  const credOf = (v) => {
    const isWindows = /windows/i.test(v.guestOS || '');
    if (jobCreds) return { isWindows, creds: { username: j.guestUser, password: j.guestPass }, guard: guestScanAuthGuard, id: `gscan|${j.id}|${v.id}` };
    const creds = resolveVmCreds(gset, j.vcenterId, v.id, isWindows);
    return { isWindows, creds, guard: gpuAuthGuard, id: `vm|${j.vcenterId}|${v.id}` };
  };
  // 주기 실행: 게스트 계정이 멈춘 VM 은 고르지 않는다(maxVms 슬롯을 정지 VM 이 차지하지 않게). 개수는 밝힌다.
  if (!manual) {
    vms = vms.filter((v) => {
      const k = credOf(v);
      if (k.creds?.username && k.guard.peekAuthStop({ id: k.id, username: k.creds.username, password: k.creds.password })) { lastAuth.vmSkipped += 1; return false; }
      // 공용 계정(GPU 게스트 설정)의 계정 단위 정지 — OS 스캐너와 같은 기록(차단기가 끊은 계정). 작업 계정은 위의 작업 정지가 담당한다.
      if (!jobCreds && k.creds?.username && gpuAuthGuard.authStopFor(guestAccountStopDev(j.vcenterId, k.creds))) { lastAuth.vmSkipped += 1; return false; }
      return true;
    });
  }
  vms = vms.slice(0, j.maxVms);

  // v2.591(감사 F2): 한 실행 안의 **회로 차단기** — 같은 계정의 게스트 인증 거부가 연속 3회면 그 계정의 남은 VM 을
  //   시작하지 않는다. 첫 로그인 성공 전까지는 하나씩 돈다(동시 실행이 임계를 넘겨 새지 않게). 수동 실행에도 적용한다
  //   (한 번 누르면 수천 대일 수 있다 — 도메인 계정은 첫 실행에 잠금 임계를 넘는다).
  const breaker = createAuthBreaker({ threshold: 3 });
  const c = new VimSoapClient(vc);
  let found = 0; const errs = [];
  try {
    try { await c.login(); }
    catch (e) {
      if (isVcAuthError(e)) lastAuth.vcStopped = authStopView(vcAuthGuard.markAuthStopped(vc.id, vc, e.message));
      throw e;
    }
    await runWithBreakerWarmup(vms, 4, breaker, async (v) => {
      const { isWindows, creds, guard, id } = credOf(v);
      if (!creds || !creds.username) { errs.push(`${v.name}:계정없음`); return; }
      const dev = { id, username: creds.username, password: creds.password };
      if (!breaker.allow(dev)) return;   // 이번 실행에서 이 계정이 끊겼다 — 시작하지 않는다(개수는 차단기가 센다)
      const moref = morefOf(v.id, v.vcenterId || j.vcenterId);
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
        breaker.ok(dev);
        guard.clearAuthStop(id);
        if (!jobCreds) gpuAuthGuard.clearAuthStop(guestAccountStopDev(j.vcenterId, creds).id);   // 공용 계정이 통했다 — 계정 단위 정지도 푼다
        // 수동 실행이 작업 계정으로 로그인에 성공했다 — 작업 단위 정지를 푼다(계정이 맞다는 증거).
        if (jobCreds) guestScanAuthGuard.clearAuthStop(`gscan|${j.id}`);
      } catch (e) {
        if (isGpuAuthError(e)) {
          const rec = guard.markAuthStopped(id, dev, e.message);
          lastAuth.vmStopped += 1;
          errs.push(`${v.name}:게스트 인증 실패(${rec.attempts}회)`);
          if (breaker.fail(dev)) {
            console.warn(`[gscan] ${j.name}: 게스트 계정 ${creds.username} 거부가 연속 ${breaker.summary().threshold}회 — 이번 실행에서 그 계정의 남은 VM 을 건너뜁니다`);
            // 작업 계정이면 작업 단위로 멈춘다 — 다음 주기가 첫 VM 부터 다시 3회를 쓰지 않게(계정을 고치면 자동 재개).
            if (jobCreds) lastAuth.jobStopped = authStopView(guestScanAuthGuard.markAuthStopped(`gscan|${j.id}`, jobDevOf(j), `게스트 계정 거부 연속 ${breaker.summary().threshold}회 — ${e.message}`));
            else { const ad = guestAccountStopDev(j.vcenterId, creds); gpuAuthGuard.markAuthStopped(ad.id, ad, `게스트 계정 거부 연속 ${breaker.summary().threshold}회 — ${e.message}`); }
          }
        } else {
          breaker.neutral();   // 인증과 무관한 실패 — 계정이 맞는지 모른다(도구 미동작·시한 초과도 여기로 온다). 성공으로 세지 않는다
          errs.push(`${v.name}:${String(e.message).slice(0, 50)}`);
        }
      }
    });
  } catch (e) { errs.push(`로그인:${e.message}`); }
  finally { await c.logout().catch(() => {}); }
  const bs = breaker.summary();
  if (bs.tripped.length || bs.skipped) lastAuth.breaker = bs;
  finish(found, errs);
  console.log(`[gscan] ${j.name}(${j.type}/${j.os}) ${vms.length}대 조사 → ${found}건${bs.skipped ? ` · 인증 차단기로 건너뜀 ${bs.skipped}대` : ''}${lastAuth.vmSkipped ? ` · 정지 VM 제외 ${lastAuth.vmSkipped}대` : ''}`);
}

let timer = null;
const runningJobs = new Set(); // 작업 id별 재진입 방지(긴 조사가 다음 tick과 겹치지 않게)
/**
 * 스케줄러 한 틱(v2.591 — 테스트가 **실제 타이머 경로**를 부를 수 있게 떼어 냈다). 도래한 작업을 'schedule' 로 돌린다.
 * @returns {Promise[]} 시작한 실행들
 */
export function guestScanTick(now = Date.now()) {
  const started = [];
  for (const j of load()) {
    if (!j.enabled || runningJobs.has(j.id)) continue;
    if (j.lastRun && now - j.lastRun < j.intervalMin * 60_000) continue;
    started.push(runGuestScanNow(j.id, { trigger: 'schedule' }).catch(() => {}));
  }
  return started;
}
export function startGuestScanScheduler() {
  timer = setInterval(() => { guestScanTick(); }, 60_000);
  timer.unref?.();
  console.log('[gscan] 게스트 조사 스케줄러 시작');
}
/**
 * 작업 1회 실행 — 수동('manual', 기본)과 스케줄('schedule')이 **같은 재진입 가드**를 쓴다.
 * v2.591: 수동은 인증 실패 정지를 무시하고 시도한다(고친 뒤 확인할 길 — authGuard 규칙 3). 회로 차단기는 둘 다 적용.
 */
export async function runGuestScanNow(id, { trigger = 'manual' } = {}) {
  const j = load().find((x) => x.id === id);
  if (!j) return { ok: false, reason: '작업 없음' };
  // 스케줄러와 동일한 재진입 가드 공유 — 수동 '지금 실행'이 진행 중 스캔과 겹쳐 같은 job에
  // 두 runJob이 동시에 돌며 게스트 ops·파일 저장이 경쟁하는 것을 막는다(중복 클릭 포함).
  if (runningJobs.has(id)) return { ok: false, reason: '이미 실행 중입니다.' };
  runningJobs.add(id);
  try { await runJob(j, { manual: trigger === 'manual' }); return { ok: true, ...redact(j) }; }
  finally { runningJobs.delete(id); }
}
