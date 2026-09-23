/**
 * 연속 네트워크 모니터링 — 두 서버 간 캡처를 주기적으로 자동 실행해 이력에 기록하고, 경로
 * 손실/미수신 등 이슈가 감지되면 알림을 보낸다. 모니터 정의는 CONFIG_DIR/capture-monitors.json
 * 에 보관(SSH 자격증명 포함, 0600). 중앙 직접 실행(사설망은 향후 에이전트 위임 확장).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runTrafficCapture, runDualCapture } from './tcpdump.js';
import { recordCapture } from './captureHistory.js';
import { notify } from '../alerts.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';
import { createAuthGuard, authStopView } from '../util/authGuard.js';
import { isSshAuthError } from '../proxy/sshExec.js';

/**
 * 연속 모니터의 **SSH 인증 실패 정지**(v2.591 — 감사 F5). 모니터는 주기(최소 1분)마다 캡처 호스트에 SSH 로그인한다 —
 * 비밀번호가 바뀐 구간에 그대로 두면 하루 최대 1,440회 실패 로그인이 쌓여 **그 서버 계정이 잠긴다**(authGuard 규칙).
 * 자격증명 거부(ssh2 `client-authentication`)면 **그 쪽(A/B)만** 주기 실행을 멈추고, '지금 실행'(수동)은 막지 않는다.
 * id 는 `mon|<모니터 id>|A` / `|B` — 모니터·방향마다 따로(한쪽이 멈춰도 다른 모니터·다른 쪽을 멈추지 않는다).
 * 접속처·계정·비밀번호·개인키가 바뀌면 credHash 가 달라져 자동 재개한다. 정지 파일은 도구마다 따로다.
 */
export const netmonAuthGuard = createAuthGuard({ file: 'netmon-auth-stops.json' });
const SIDES = (m) => (m.mode === 'dual' ? ['A', 'B'] : ['A']);
/** 정지 기록용 자격증명 — 비밀번호와 개인키를 함께 넣어 어느 쪽을 바꿔도 재개되게(평문 미저장 — 지문만). */
export function netmonSideDev(m, side) {
  const h = (side === 'B' ? m.hostB : m.hostA) || {};
  return { id: `mon|${m.id}|${side}`, username: `${String(h.username || '')}@${String(h.host || '')}:${String(h.port || '')}`, password: `${String(h.password || '')}\n${String(h.privateKey || '')}` };
}
/** 화면용 정지 상태(읽기 전용 — 조회가 기록을 지우지 않는다). 없으면 null. */
function authStopsOf(m) {
  const out = {};
  for (const side of SIDES(m)) { const v = authStopView(netmonAuthGuard.peekAuthStop(netmonSideDev(m, side))); if (v) out[side] = v; }
  return Object.keys(out).length ? out : null;
}

const FILE = path.join(config.configDir, 'capture-monitors.json');

/**
 * 손상 파일 보존 — 파싱 실패를 조용히 빈 목록으로 리셋하면 다음 persist가 손상본을 덮어써
 * SSH 자격증명을 포함한 모니터 정의가 영구 유실되고 원인 추적도 불가능해진다.
 * <file>.corrupt.<ts>로 옮겨 두고(모드 0600 유지) 경고만 남긴다 — 기동은 계속(빈 목록).
 */
function backupCorrupt(err) {
  try {
    const bak = `${FILE}.corrupt.${Date.now()}`;
    fs.renameSync(FILE, bak);
    console.warn(`[netmon] ${FILE} 읽기/파싱 실패(${err?.message || err}) — ${bak}로 보존하고 빈 목록으로 시작합니다.`);
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
      cache = openSecretsDeep(p); // v2.296 캡처 호스트 SSH 자격증명 복호(메모리 평문)
    }
  } catch (e) { cache = []; backupCorrupt(e); }
  return cache;
}
// 원자적 쓰기 — 크래시/정전 중 부분기록으로 파일이 깨지면 load가 []를 반환하고 다음 persist가
// 빈 목록으로 덮어써 전 모니터 정의(자격증명 포함)가 사라진다. tmp+fsync+rename으로 방지.
function persist() { try { atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(cache), null, 2), { mode: 0o600 }); } catch { /* */ } } // 암호화 모드면 password/privateKey 봉인

const redact = (m) => ({ useSudo: m.useSudo !== false,
  id: m.id, name: m.name, enabled: m.enabled, mode: m.mode, intervalMin: m.intervalMin,
  iface: m.iface, seconds: m.seconds, maxPackets: m.maxPackets,
  hostA: m.hostA?.host || '', hostB: m.mode === 'dual' ? (m.hostB?.host || '') : (m.peer || ''),
  lastRun: m.lastRun || null, lastWorst: m.lastWorst || null, lastDetail: m.lastDetail || '',
  authStopped: authStopsOf(m), // v2.591(감사 F5): 인증 실패로 주기 실행을 멈춘 쪽(A/B) — 조용히 멈추지 않는다
});

export function listMonitors() { return load().map(redact); }

export function saveMonitor(body = {}) {
  load();
  const id = body.id || `mon_${Date.now().toString(36)}`;
  const m = {
    id, name: String(body.name || '무제 모니터').slice(0, 80),
    enabled: body.enabled !== false, mode: body.mode === 'dual' ? 'dual' : 'single',
    intervalMin: Math.max(1, Math.min(1440, Number(body.intervalMin) || 10)),
    iface: body.iface || 'any', seconds: Math.min(60, Math.max(1, Number(body.seconds) || 10)), maxPackets: Math.min(20000, Math.max(10, Number(body.maxPackets) || 1000)),
    hostA: body.hostA || {}, hostB: body.hostB || {}, peer: body.peer || '',
    // v2.478(감사 B7): 시작/중지 토글처럼 useSudo 를 안 보내면 기존 값을 유지(예전엔 true 로 되돌아가 sudo -n 막힌
    // 서버에서 매 주기 캡처 실패). redact 도 useSudo 를 내려 프론트가 복원할 수 있게 한다.
    useSudo: body.useSudo !== undefined ? body.useSudo !== false : (cache.find((x) => x.id === id)?.useSudo !== false),
    lastRun: null, lastWorst: null, lastDetail: '',
  };
  const idx = cache.findIndex((x) => x.id === id);
  if (idx >= 0) {
    const prev = cache[idx];
    // 자격증명: 목록은 creds를 노출하지 않으므로, 새 값이 비면 기존 유지(토글/수정 시 보존).
    // ⚠ 보안(v2.500 감사 M1): 단, **접속처(host/port/계정)가 바뀌면 승계하지 않는다**. 없으면
    // `PUT /api/admin/net/monitors` 로 host 만 공격자 주소로 바꾼 뒤 `POST .../:id/run` 을 부르면
    // 저장된 캡처 호스트 SSH 비밀번호·개인키가 그 주소로 전송된다(60초 스케줄러가 계속 재시도).
    // 규칙 설명: util/secretCarry.js.
    const merge = (a = {}, b = {}) => {
      const moved = accessMoved(a, b, ['host', 'port', 'username']);
      const out = { host: b.host || a.host, port: b.port || a.port, username: b.username || a.username, password: b.password || a.password, privateKey: b.privateKey || a.privateKey };
      if (moved) dropCarriedSecrets(out, b, ['password', 'privateKey']);
      return out;
    };
    m.hostA = merge(prev.hostA, body.hostA); m.hostB = merge(prev.hostB, body.hostB); m.peer = body.peer || prev.peer;
    m.lastRun = prev.lastRun; m.lastWorst = prev.lastWorst; m.lastDetail = prev.lastDetail;
    cache[idx] = m;
  } else cache.push(m);
  persist();
  return redact(m);
}

export function removeMonitor(id) {
  load(); const before = cache.length; cache = cache.filter((m) => m.id !== id);
  if (cache.length !== before) {
    persist();
    // v2.591: 지운 모니터의 정지 기록도 지운다 — 같은 id 가 다시 쓰일 일은 거의 없지만 유령 기록을 남기지 않는다.
    netmonAuthGuard.clearAuthStop(`mon|${id}|A`); netmonAuthGuard.clearAuthStop(`mon|${id}|B`);
  }
  return before !== cache.length;
}

/** 테스트 전용 — 모듈 캐시를 비운다(설정 파일을 다시 읽게). */
export function _resetNetMonitorForTest() { cache = null; runningMon.clear(); }

/** 한 쪽의 결과를 정지 기록에 반영한다 — 거부면 기록, 로그인이 통했으면 해제. */
function noteSide(m, side, { authFailed = false, ok = false, reason = '' } = {}) {
  const dev = netmonSideDev(m, side);
  if (authFailed) {
    const rec = netmonAuthGuard.markAuthStopped(dev.id, dev, reason || 'SSH 인증 실패');
    console.warn(`[netmon] '${m.name}' ${side} 쪽 SSH 인증 실패 — 주기 실행을 멈춥니다(${rec.attempts}회). 계정·비밀번호를 고치면 자동 재개되고 '지금 실행' 은 막지 않습니다.`);
  } else if (ok && netmonAuthGuard.clearAuthStop(dev.id)) {
    console.log(`[netmon] '${m.name}' ${side} 쪽 SSH 로그인 성공 — 인증 실패 정지를 풀었습니다`);
  }
}

async function runMonitor(m, { manual = false } = {}) {
  // v2.591(감사 F5): 주기 실행은 인증 실패로 멈춘 쪽이 하나라도 있으면 **로그인하지 않는다**(dual 은 두 쪽을 함께
  //   캡처해야 비교가 되므로 한쪽만 돌리지 않는다). authStopFor 는 자격증명이 바뀌었으면 기록을 지우고 null — 자동 재개.
  //   조용히 멈추지 않는다 — 목록 응답의 authStopped 가 화면에 사유를 말한다. 수동('지금 실행')은 막지 않는다.
  if (!manual) {
    const stopped = SIDES(m).filter((side) => netmonAuthGuard.authStopFor(netmonSideDev(m, side)));
    if (stopped.length) return { skipped: 'auth-stopped', sides: stopped };
  }
  try {
    const opts = { iface: m.iface, seconds: m.seconds, maxPackets: m.maxPackets, useSudo: m.useSudo };
    let result;
    try {
      result = m.mode === 'dual'
        ? await runDualCapture({ hostA: m.hostA, hostB: m.hostB, ...opts })
        : await runTrafficCapture({ hostA: m.hostA, peer: String(m.peer).trim(), ...opts });
    } catch (e) {
      // 단일 모드의 로그인 거부는 여기로 던져진다(연결 실패·타임아웃은 멈추지 않는다 — isSshAuthError 가 경계).
      if (m.mode !== 'dual' && isSshAuthError(e)) noteSide(m, 'A', { authFailed: true, reason: e.message });
      throw e;
    }
    if (m.mode === 'dual') {
      noteSide(m, 'A', { authFailed: !!result?.a?.authFailed, ok: result?.a?.ok !== false, reason: result?.a?.reason });
      noteSide(m, 'B', { authFailed: !!result?.b?.authFailed, ok: result?.b?.ok !== false, reason: result?.b?.reason });
    } else {
      noteSide(m, 'A', { ok: true });
    }
    const rec = recordCapture(result, { source: 'monitor', monitorName: m.name, via: 'central', hostA: m.hostA?.host, peer: m.peer });
    m.lastRun = Date.now(); m.lastWorst = rec.worst; m.lastDetail = (rec.issues[0]?.title) || '정상';
    persist();
    if (rec.worst !== 'ok') {
      notify({ key: `netmon:${m.id}`, severity: rec.worst === 'error' ? 'critical' : 'warning', title: `네트워크 모니터 '${m.name}' 이슈`, detail: `${m.hostA?.host} ↔ ${m.mode === 'dual' ? m.hostB?.host : m.peer}: ${rec.issues.map((i) => i.title).join(', ')}` }).catch(() => {});
    }
  } catch (e) {
    m.lastRun = Date.now(); m.lastWorst = 'error'; m.lastDetail = `실행 실패: ${e.message}`.slice(0, 120); persist();
  }
  return { skipped: '' };
}

let timer = null;
const runningMon = new Set(); // 모니터 id별 재진입 방지(긴 캡처가 다음 tick과 겹치지 않게)
/**
 * 스케줄러 한 틱(v2.591 — 테스트가 직접 부를 수 있게 떼어 냈다). 주기가 도래한 모니터를 실행한다.
 * @returns {Promise<Array<{id:string, skipped:string}>>} 이번 틱에 시작한 모니터의 결과(인증 정지로 건너뛴 것 포함)
 */
export async function captureMonitorTick(now = Date.now()) {
  const started = [];
  for (const m of load()) {
    if (!m.enabled || runningMon.has(m.id)) continue;
    if (m.lastRun && now - m.lastRun < m.intervalMin * 60_000) continue;
    runningMon.add(m.id);
    started.push(runMonitor(m).then((r) => ({ id: m.id, skipped: r?.skipped || '' }), () => ({ id: m.id, skipped: '' })).finally(() => runningMon.delete(m.id)));
  }
  return Promise.all(started);
}

export function startCaptureMonitor() {
  // 1분마다 점검, 각 모니터의 주기가 도래하면 실행.
  timer = setInterval(() => { captureMonitorTick().catch(() => {}); }, 60_000);
  timer.unref?.();
  console.log('[netmon] 연속 네트워크 모니터 시작');
}

export async function runMonitorNow(id) {
  const m = load().find((x) => x.id === id);
  if (!m) return { ok: false, reason: '모니터 없음' };
  // 스케줄러와 같은 재진입 가드를 공유 — 진행 중인 캡처와 같은 모니터의 tcpdump SSH 세션이
  // 이중으로 돌고 lastRun/persist가 경쟁하는 것을 방지.
  if (runningMon.has(m.id)) return { ok: false, reason: '이미 실행 중입니다.' };
  runningMon.add(m.id);
  // v2.591(감사 F5): 수동 실행은 인증 실패 정지를 무시하고 1회 시도한다(고쳤는지 확인하는 길) — 성공하면 풀린다.
  try { await runMonitor(m, { manual: true }); } finally { runningMon.delete(m.id); }
  return { ok: true, ...redact(m) };
}
