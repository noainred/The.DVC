/**
 * bareos/service.js — Bareos 연동의 업무 단위(v2.820 · v2.823 법인별 Director). 라우트·폴러·데모가 같은 함수를 쓴다.
 *
 *  - withDirector(directorId, fn): 요청마다 그 Director 의 콘솔 세션 1개(상시 연결 없음). 데모(mock 모드 + 접속할 Director 가 하나도 없음)면 메모리 Director.
 *    인증 실패(auth·pam·tls)는 **그 Director 의** 정지 기록(util/authGuard.js) — 주기 조회만 멈추고 수동 실행은 계속(자동 재시도 금지).
 *  - onDirector(directorId, kind, args): 작업 표(ops.js)의 한 작업을 그 Director 에서 실행한다. 2차 릴리스에서 담당 엣지가 있는 Director 는
 *    같은 작업을 엣지 대행 큐로 보낸다(부르는 쪽은 바뀌지 않는다).
 *  - createBackupTarget(s): 스냅샷의 VM → 그 vCenter 의 법인 Director·매핑 → 플러그인 옵션 → `configure add job` → 원장(directorId 고정).
 */
import { openConsole, BareosConsoleError } from './console.js';
import {
  loadSettings, directorConn, directorCred, directorConnSig, directorById, siteFor, siteMissing,
} from './settings.js';
import { OPS } from './ops.js';
import { enqueueEdgeOp } from './edgeOps.js';
import { config } from '../config.js';
import { addJob as registryAddJob, addJobs as registryAddJobs, listJobs, findByVm, registryLoadError, jobCount, retireName, MAX_JOBS } from './registry.js';
import { backupPluginOptions, jobNameFor, normLevel } from './names.js';
import { createAuthGuard } from '../util/authGuard.js';
import { isMockMode } from '../mock/demo/flags.js';
import { demoSession, demoSettings, registerDemoJobNames } from '../mock/demo/bareos.js';
import { store } from '../store.js';
import { morefOf } from '../vcenter/registry.js';
import { DEMO_ONLY_REASON } from '../auth/demoGuest.js';

export const bareosAuthGuard = createAuthGuard({ file: 'bareos-auth-stops.json' });

const fail = (code, msg) => new BareosConsoleError(code, msg);

let _factory = null;
/** 테스트 주입 — (directorId) => Promise<session>. null 이면 실제 경로. */
export function _setSessionFactoryForTest(fn) { _factory = fn; }

/** 데모 Director 를 쓰는가 — mock 모드이고 접속할 수 있는 Director 가 하나도 없을 때만. */
// v2.823 검토(I4·W9 — 재현): 데모는 **사람이 등록한 Director 가 하나도 없을 때만**. 예전에는 '접속값을 모두 갖춘 Director' 가 없으면 데모라,
//   자동 설정을 쓰려고 비밀번호 없이 추가한 Director 가 설정 화면에 보이지 않고(데모 Director 만) 그 id 의 라우트가 404 였다 — 빠져나갈 길이 없었다.
export function isDemoActive(s = loadSettings()) { return !_factory && isMockMode() && !(s.directors || []).length; }

/** 화면·라우트가 쓰는 설정(데모면 메모리 데모 설정 — 파일은 그대로). 비밀번호 포함(내부 전용). */
export function effectiveSettings() {
  const s = loadSettings();
  return isDemoActive(s) ? demoSettings(store.get?.()) : s;
}

const AUTH_CODES = new Set(['auth', 'pam', 'tls']);
/** 엣지 노드(중앙으로 push) — 엣지에서는 대행하지 않는다(엣지 자기 Bareos 설정의 agent 는 쓰지 않는다). */
const isEdge = () => !!config.agent?.centralUrl;

/**
 * 그 Director 의 세션을 열어 fn(session) 을 돌리고 닫는다.
 * @param {string} directorId
 * @param {(s) => Promise<any>} fn
 * @param {{ trigger?: 'timer'|'manual', signal?: AbortSignal, demoOnly?: boolean }} [o]
 */
export async function withDirector(directorId, fn, { trigger = 'manual', signal = null, demoOnly = false } = {}) {
  // 데모 계정(mock 모드 내장 계정 — 요청 문맥은 admin)은 **데모 Director 일 때만** 접속한다. 사람이 등록한 Director 에는
  // 닿지 않는다(auth/demoGuest.js '실제 호스트에 닿는 실행은 막는다' 의 GET 판 — audit2719b 가 라우트 호출 모양을 대조한다).
  if (demoOnly && !isDemoActive()) throw fail('demo-only', DEMO_ONLY_REASON);
  if (_factory) {
    // 테스트 주입 경로도 시한 신호를 세션에 잇는다(v2.823 검토 P1 — 잇지 않아 시한 경로를 테스트가 못 잡았다).
    const s = await _factory(directorId);
    const onAbort = () => s._fail?.(new BareosConsoleError('aborted', '시한·취소로 Director 세션을 끊었습니다.'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try { return await fn(s); } finally { signal?.removeEventListener?.('abort', onAbort); s.close?.(); }
  }
  const settings = loadSettings();
  if (isDemoActive(settings)) {
    registerDemoJobNames(listJobs().filter((j) => j.demo).map((j) => ({ name: j.bareosJob, client: j.client, schedule: j.schedule })));
    const s = demoSession(demoSettings(store.get?.()), directorId);   // v2.839 정책 수집 데모는 그 Director 의 법인만
    try { return await fn(s); } finally { s.close(); }
  }
  const dir = directorById(directorId, settings);
  if (!dir) throw fail('not-configured', '이 백업 대상의 법인 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 확인하세요.');
  // v2.824: 엣지 대행 Director 는 중앙이 세션을 열지 않는다(onDirector 가 작업 표로 엣지에 보낸다) — 세션 함수(fn)는 엣지로 보낼 수 없다.
  if (dir.agent && !isEdge()) throw fail('edge-relay', `‘${dir.name}’ Director 는 법인 엣지 '${dir.agent}' 가 대행합니다 — 중앙에서 직접 접속하지 않습니다.`);
  return sessionOn(dir, fn, { trigger, signal });
}

/**
 * Director 항목(접속값 포함)으로 세션을 열어 fn(session) 을 돌리고 닫는다 — 중앙 직접(withDirector)과 엣지 대행 워커(엣지 사본)가 같이 쓴다.
 * 인증 정지 기록은 이 노드의 bareosAuthGuard(그 Director 의 cred). 시한 신호는 세션이 열린 뒤에도 세션에 잇는다.
 */
export async function sessionOn(dir, fn, { trigger = 'manual', signal = null } = {}) {
  const { conn, missing } = directorConn(dir);
  if (!conn) throw fail('not-configured', `‘${dir.name}’ Director 설정이 덜 됐습니다(${missing.join('·')}) — 설정 › 법인별 Director 에서 먼저 채우세요.`);
  const cred = directorCred(dir);
  if (trigger === 'timer') {
    const stop = bareosAuthGuard.authStopFor(cred);
    if (stop) throw fail('auth-stopped', `인증 실패로 ‘${dir.name}’ 주기 조회를 멈췄습니다(${stop.reason}) — 설정을 고치면 다시 시작합니다.`);
  }
  let s;
  try {
    s = await openConsole(conn, { signal });
  } catch (e) {
    if (AUTH_CODES.has(e?.code)) bareosAuthGuard.markAuthStopped(cred.id, cred, e.message);
    throw e;
  }
  clearAuthStopIfSame(dir);
  // v2.822(검토 P1·S6 — 재현): 시한 신호를 **세션이 열린 뒤에도** 세션에 잇는다(폴러 예산이 명령 단계를 끊을 수 있게).
  const onAbort = () => s._fail?.(new BareosConsoleError('aborted', '시한·취소로 Director 세션을 끊었습니다.'));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try { return await fn(s); } finally { signal?.removeEventListener?.('abort', onAbort); s.close(); }
}

/**
 * 성공한 접속으로 인증 정지를 푼다 — **지금 설정의 접속값이 그 접속에 쓴 값과 같을 때만**(v2.825.1 버그 점검 G1 — 재현).
 * 정지 해제는 id 로 지우므로, 시험·조회가 도는 사이 다른 화면이 새(틀린) 비밀번호를 저장하고 주기 조회가 그 값으로 정지를 남겼으면
 * 옛 값으로 성공한 이 접속이 그 정지를 지워 틀린 비밀번호로 다시 붙었다(자동 재시도 금지 위반 — v2.824 R3 와 같은 축).
 * 엣지 사본(edgeCopy)은 엣지 자기 키(`edge-director:`)라 중앙 설정과 대조하지 않는다.
 * @param {object} dir 접속에 쓴 Director 항목(그 순간의 사본)
 */
export function clearAuthStopIfSame(dir) {
  const cred = directorCred(dir);
  if (!dir?.edgeCopy) {
    let same = false;
    try { same = directorConnSig(directorById(dir.id)) === directorConnSig(dir); } catch { same = false; }
    if (!same) return false;
  }
  bareosAuthGuard.clearAuthStop(cred.id);
  return true;
}

/** 엣지 대행 회신의 실패 봉투 → 이 노드에서 직접 실행했을 때와 같은 모양의 오류(라우트·폴러가 같은 코드로 다룬다). */
function edgeError(r) {
  const e = fail(r.code || 'error', `법인 엣지 대행 — ${r.reason || '사유 미상'}`);
  return Object.assign(e, { edge: true, ...(r.unknown ? { unknown: true } : {}), ...(r.notSent ? { notSent: true } : {}), ...(r.paths ? { paths: r.paths } : {}), ...(r.files ? { files: r.files } : {}) });
}

/**
 * v2.824 엣지 대행 — 담당 엣지가 있는 Director 의 작업을 그 엣지 큐에 둔다(edgeOps.js). 콘솔 비밀번호는 보내지 않는다.
 * 인증 정지는 중앙이 그 Director 의 cred 로 기록한다(엣지 회신의 authFailed — 주기 조회는 정지면 큐에 넣지 않는다).
 * @param {{ secretArgs?: object }} [o] 자동 설정 대행만(1회 전달 — edgeOps 머리말)
 */
export async function relayToEdge(dir, kind, args = {}, { trigger = 'manual', signal = null, secretArgs = null, onLate = null } = {}) {
  const cred = directorCred(dir);
  if (trigger === 'timer') {
    const stop = bareosAuthGuard.authStopFor(cred);
    if (stop) throw fail('auth-stopped', `인증 실패로 ‘${dir.name}’ 주기 조회를 멈췄습니다(${stop.reason}) — 설정을 고치면 다시 시작합니다.`);
  }
  // v2.824 검토(I1 — 재현): 작업에 이 순간의 접속값 표지를 싣는다 — 엣지 사본이 다르면(저장 직후·배정 인출 전) 엣지가 배정을 다시 받고,
  //   그래도 다르면 Director 에 보내지 않는다(옛 비밀번호로 실패한 것을 새 비밀번호의 인증 정지로 기록하지 않게).
  const connSig = directorConnSig(dir);
  const r = await enqueueEdgeOp({ id: dir.id, agent: dir.agent, connSig }, kind, args, { secretArgs, signal, onLate });
  // 회신을 기다리는 사이 중앙 접속값이 바뀌었으면 그 결과로 정지를 걸거나 풀지 않는다(옛 접속값의 결과다).
  const sameNow = () => { try { return directorConnSig(directorById(dir.id)) === connSig; } catch { return false; } };
  if (r.ok) { if (!kind.startsWith('setup.') && sameNow()) bareosAuthGuard.clearAuthStop(cred.id); return r.value; }
  if (r.authFailed && sameNow()) bareosAuthGuard.markAuthStopped(cred.id, cred, r.reason);
  throw edgeError(r);
}

/** 엣지 대행 워커가 자기 사본의 Director 로 작업 표 한 줄을 실행한다(엣지 쪽 — agent/bareosOpWorker.js). */
export async function runLocalOp(dir, kind, args = {}, { signal = null } = {}) {
  const op = OPS[kind];
  if (!op) throw fail('invalid', `알 수 없는 Director 작업입니다(${kind}).`);
  return sessionOn(dir, (s) => op(s, args, { signal }), { trigger: 'manual', signal });
}

/**
 * 작업 표(ops.js)의 한 작업을 그 Director 에서 실행한다 — 중앙 직접, 또는 담당 엣지가 있으면 그 엣지 대행(v2.824). 결과는 작업이 돌려준 값 그대로.
 * @param {string} directorId
 * @param {keyof OPS} kind
 * @param {object} args 직렬화할 수 있는 값만(2차 엣지 대행이 같은 인자를 보낸다)
 */
export async function onDirector(directorId, kind, args = {}, { trigger = 'manual', signal = null, demoOnly = false, hooks = null, onLate = null } = {}) {
  const op = OPS[kind];
  if (!op) throw fail('invalid', `알 수 없는 Director 작업입니다(${kind}).`);
  if (demoOnly && !isDemoActive()) throw fail('demo-only', DEMO_ONLY_REASON);
  if (!_factory && !isEdge()) {
    const settings = loadSettings();
    if (!isDemoActive(settings)) {
      const dir = directorById(directorId, settings);
      if (dir?.agent) return relayToEdge(dir, kind, args, { trigger, signal, onLate });
    }
  }
  // hooks: 중앙 직접 실행에서만 쓰는 함수(예: poll 의 disableNow — 그 순간의 원장으로 고른다). 직렬화하지 않는다(엣지 대행에는 없다).
  return withDirector(directorId, (s) => op(s, args, { signal, ...(hooks || {}) }), { trigger, signal, demoOnly });
}

/**
 * 스냅샷 VM 1대의 등록 가능 여부(순수에 가까움 — 스냅샷·설정만 본다).
 * @returns {{ ok: boolean, reason?: string, site?: object, director?: object, plugin?: string }}
 */
export function eligibility(vm, settings) {
  if (!vm) return { ok: false, reason: '인벤토리에 없는 VM 입니다.' };
  if (vm.template) return { ok: false, reason: '템플릿은 백업할 수 없습니다(스냅샷을 만들 수 없음 — Bareos 플러그인 제약).' };
  if (!vm.vcDcPath || !vm.folderPath) return { ok: false, reason: '인벤토리에 데이터센터·폴더 경로가 없습니다(vApp 안의 VM 이거나 SOAP 수집 전 — 다음 수집 뒤 다시 보세요).' };
  const site = siteFor(vm.vcenterId, settings);
  if (!site) return { ok: false, reason: '이 vCenter 가 어느 법인 Director 에도 묶여 있지 않습니다 — 설정 › 법인별 Director 에서 먼저 묶으세요.' };
  const director = directorById(site.directorId, settings);
  if (!director) return { ok: false, reason: '이 vCenter 를 묶은 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 확인하세요.' };
  const miss = siteMissing(site);
  if (miss.length) return { ok: false, reason: `이 vCenter 의 매핑이 덜 됐습니다(${miss.join('·')}) — ‘${director.name}’ 편집 화면의 매핑 표를 채우세요.` };
  const p = backupPluginOptions({ plugin: settings.defaults.pluginName, vcserver: site.vcserver, dc: vm.vcDcPath, folder: vm.folderPath, vmname: vm.name, configFile: site.configFile });
  if (p.issue) return { ok: false, reason: p.issue };
  return { ok: true, site, director, plugin: p.value };
}

/**
 * 등록 준비(순수에 가까움 — 스냅샷·설정·원장만 본다). 실패는 throw(invalid).
 * @returns {{ vm, el, base, moref, lvl, sched, directorId }}
 */
export function prepareTarget({ vcenterId, vmId, level, schedule }, { snap = store.get(), settings = effectiveSettings() } = {}) {
  // 원장에 넣을 수 없는 상태면 Director 에 닿기 **전에** 거절한다(C3·P3).
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 새 대상을 추가하지 않습니다(손상본 보존 — 서비스 점검에서 확인).');
  if (jobCount() >= MAX_JOBS) throw fail('invalid', `백업 대상은 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
  const vm = (snap?.vms || []).find((v) => v.id === vmId);
  if (!vm || String(vm.vcenterId) !== String(vcenterId)) throw fail('invalid', '선택한 VM 이 이 vCenter 의 인벤토리에 없습니다.');
  if (findByVm(vcenterId, vmId)) throw fail('invalid', '이 VM 은 이미 백업 대상입니다.');
  const el = eligibility(vm, settings);
  if (!el.ok) throw fail('invalid', el.reason);
  const moref = morefOf(vm.id, vm.vcenterId);
  if (!jobNameFor(vm.vcenterId, moref)) throw fail('invalid', 'VM 관리 id(moref)로 잡 이름을 만들 수 없습니다.');
  const lvl = normLevel(level || settings.defaults.level);
  const sched = schedule === '' ? '' : (schedule || el.site.schedule || '');
  const base = {
    jobDefs: settings.defaults.jobDefs, client: el.site.client, storage: el.site.storage, pool: el.site.pool,
    schedule: sched || undefined, level: lvl, pluginOptions: el.plugin, description: `VMware Portal ${vm.name}`.replace(/[^\p{L}\p{N} ._-]/gu, ' '),
  };
  return { vm, el, base, moref, lvl, sched, directorId: el.site.directorId };
}

/*
 * 같은 VM 의 등록이 동시에 두 번 오면 둘 다 findByVm 을 통과하고 Director 잡이 두 개(-r2) 생겼다(C3 — 재현). 등록하는 동안 VM 을 잡아 둔다.
 * 단일 프로세스 메모리 표시다(포탈은 한 프로세스 — 원장 파일도 이 프로세스만 쓴다).
 */
const _registering = new Set();
function claimVm(prep) {
  const k = `${prep.vm.vcenterId}\u0000${prep.vm.id}`;
  if (_registering.has(k)) throw fail('busy', '이 VM 을 등록하는 중입니다 — 끝난 뒤 다시 보세요.');
  _registering.add(k);
  return k;
}

/** 원장 기록(Director 잡을 만든 **뒤**). directorId 를 고정한다(잡은 그 Director 의 conf 에 있다). */
function targetInput(prep, jobName, by, demo) {
  const { vm, el } = prep;
  return {
    vcenterId: vm.vcenterId, vmId: vm.id, vmName: vm.name, dc: vm.vcDcPath, folder: vm.folderPath, directorId: prep.directorId,
    bareosJob: jobName, client: el.site.client, storage: el.site.storage, pool: el.site.pool, schedule: prep.sched, level: prep.lvl,
    createdBy: by, demo,
  };
}
function recordTarget(prep, jobName, by, demo) { return registryAddJob(targetInput(prep, jobName, by, demo)); }
/**
 * 여러 대상을 원장에 **한 번의 쓰기로**(v2.830 버그 점검 S2 — 대상마다 원장 전체를 써 200대 5.2초 정지).
 * @param {{ prep, name }[]} list
 * @returns {{ ok:true, job } | { ok:false, err }}[]  — 끝 쓰기가 실패하면 전부 실패(원장은 되돌려졌다 — 부르는 쪽이 그 잡들을 끈다)
 */
function recordTargets(list, by, demo) {
  if (!list.length) return [];
  try { return registryAddJobs(list.map((o) => targetInput(o.prep, o.name, by, demo))); } catch (e) { return list.map(() => ({ ok: false, err: e })); }
}

/**
 * 원장 기록이 실패한 Director 잡들 — 끄고(스케줄이 돌지 않게) 이름을 남긴다(대조 틱이 다시 켜지면 또 끈다). 사유에 잡 이름을 밝힌다.
 * @returns {Promise<Map<string, string>>} 잡 이름 → 사유
 */
export async function orphanCleanup(directorId, orphans, demo) {
  const off = new Set();
  try {
    for (const r of await onDirector(directorId, 'disableJobs', { names: orphans.map((o) => o.name) })) if (r.ok) off.add(r.name);
  } catch { /* 아래 문구가 밝힌다 */ }
  const out = new Map();
  for (const o of orphans) {
    try { retireName(o.name, demo, directorId); } catch { /* 원장을 못 쓰는 상태일 수 있다 */ }
    out.set(o.name, `Director 잡 ‘${o.name}’ 은 만들었지만 원장에 넣지 못했습니다(${String(o.err?.message || o.err).slice(0, 200)}) — ${off.has(o.name) ? '그 잡은 비활성화했습니다' : '그 잡을 비활성화하지도 못했습니다'}. Director 호스트에서 bareos-dir.d/job/${o.name}.conf 를 정리하세요.`);
  }
  return out;
}

/**
 * v2.824 검토(P1 — 재현): 엣지가 등록(addJobs)을 가져간 뒤 시한 안에 회신하지 못해 '결과 모름' 으로 끝났는데 결과가 **늦게** 오면 —
 * 만든 잡을 그때 원장에 넣는다(이미 대상이면·원장을 못 쓰면 끈다 — orphanCleanup). 버리면 원장 밖 스케줄 잡이 Director 에 영구히 남고,
 * 다시 등록하면 같은 VM 의 스케줄 잡이 둘이 됐다. 늦은 결과는 edgeOps 가 그 엣지에서 온 것만·정제해서 넘긴다.
 */
function lateAddJobs(directorId, ready, by, demo) {
  return (lr) => {
    if (!lr?.ok || !Array.isArray(lr.value)) return;
    const byKey = new Map(lr.value.map((r) => [r.key, r]));
    const orphans = []; let recorded = 0;
    const made = [];
    for (const { i, prep } of ready) {
      const r = byKey.get(i);
      if (r?.ok && r.name) made.push({ i, prep, name: r.name });
    }
    recordTargets(made, by, demo).forEach((x, k) => { if (x.ok) recorded += 1; else orphans.push({ i: made[k].i, name: made[k].name, err: x.err }); });
    if (recorded || orphans.length) console.warn(`[bareos] 늦게 도착한 엣지 등록 결과를 반영했습니다(Director ${directorId}): 원장에 넣음 ${recorded} · 넣지 못해 끔 ${orphans.length}`);
    if (orphans.length) orphanCleanup(directorId, orphans, demo).catch(() => {});
  };
}
/** 엣지 '결과 모름' 의 사유(등록) — Director 에 잡이 생겼을 수 있다는 사실과 늦은 결과 처리를 밝힌다. */
const addUnknownText = (why) => `${why} — Director 에 잡이 생겼을 수 있습니다. 결과가 늦게 도착하면(그사이 포탈이 재시작하지 않으면) 포탈이 원장에 넣거나(이미 대상이면) 그 잡을 끕니다. 다시 등록하기 전에 목록을 새로 고쳐 확인하세요.`;

/**
 * 백업 대상 등록(Director 잡 생성 + 원장). 범위 판정은 라우트가 먼저 한다.
 * @param {{ vcenterId, vmId, level?, schedule?, by, demo? }} o
 * @returns {Promise<object>} 원장 job
 */
export async function createBackupTarget({ vcenterId, vmId, level, schedule, by, demo = false }) {
  const prep = prepareTarget({ vcenterId, vmId, level, schedule });
  const key = claimVm(prep);
  try {
    let r;
    try {
      [r] = await onDirector(prep.directorId, 'addJobs', { items: [{ key: 0, vcenterId: prep.vm.vcenterId, moref: prep.moref, base: prep.base }] },
        { onLate: lateAddJobs(prep.directorId, [{ i: 0, prep }], by, demo) });
    } catch (e) { if (e?.code === 'unknown') throw fail('unknown', addUnknownText(String(e.message || e).slice(0, 300))); throw e; }
    if (!r?.ok) throw fail(r?.code === 'skipped' ? 'connect' : (r?.code || 'error'), r?.message || 'Director 잡을 만들지 못했습니다.');
    if (!r.name) throw fail('unknown', 'Director 가 잡 이름 없이 성공을 회신했습니다 — 잡이 생겼을 수 있습니다. Director 에서 확인하세요.');   // G3
    try { return recordTarget(prep, r.name, by, demo); } catch (e) {
      const why = await orphanCleanup(prep.directorId, [{ name: r.name, err: e }], demo);
      throw fail('record', why.get(r.name));
    }
  } finally { _registering.delete(key); }
}

/**
 * v2.822 일괄 등록 — 같은 vCenter 의 여러 VM 을 **그 법인 Director 세션 하나**로 순차 등록한다(VM 마다 접속하지 않는다).
 * 한 VM 의 실패(이름·자격·Director 거부)는 나머지를 막지 않는다. 세션이 끊기면 남은 VM 은 그 사유로 '건너뜀'.
 * 준비 단계(인벤토리·이미 대상·등록 조건) 실패는 Director 에 닿기 전에 걸러진다. 범위·상한·원장 여유는 라우트가 먼저 본다.
 * @returns {Promise<Array<{ vmId, vmName, ok, job?, reason? }>>} 요청 순서 그대로
 */
export async function createBackupTargets({ vcenterId, vmIds, level, schedule, by, demo = false }) {
  const snap = store.get();
  const settings = effectiveSettings();
  const out = vmIds.map((vmId) => ({ vmId, vmName: (snap?.vms || []).find((v) => v.id === vmId)?.name || '', ok: false }));
  const ready = [];
  const claimed = [];
  out.forEach((o, i) => {
    try {
      const prep = prepareTarget({ vcenterId, vmId: o.vmId, level, schedule }, { snap, settings });
      claimed.push(claimVm(prep));
      ready.push({ i, prep });
    } catch (e) { o.reason = String(e?.message || e).slice(0, 300); }
  });
  if (!ready.length) return out;
  const directorId = ready[0].prep.directorId;   // vCenter 하나 → Director 하나
  try {
    let results;
    try {
      results = await onDirector(directorId, 'addJobs', { items: ready.map(({ i, prep }) => ({ key: i, vcenterId: prep.vm.vcenterId, moref: prep.moref, base: prep.base })) },
        { onLate: lateAddJobs(directorId, ready, by, demo) });
    } catch (e) {
      // 세션을 열지 못했다(설정 미완·접속·인증) — 준비를 통과한 VM 전부 같은 사유. 원장·Director 는 바뀌지 않았다.
      //   예외: 엣지 대행 '결과 모름'(unknown) — 엣지가 실행했을 수 있다(P1 — 늦은 결과는 lateAddJobs 가 처리한다).
      const why = e?.code === 'unknown' ? addUnknownText(String(e?.message || e).slice(0, 300)) : String(e?.message || e).slice(0, 300);
      for (const { i } of ready) if (!out[i].reason) out[i].reason = why;
      const err = fail(e?.code || 'connect', why); err.results = out; throw err;
    }
    const byKey = new Map(results.map((r) => [r.key, r]));
    const orphans = [];
    const made = [];
    for (const { i, prep } of ready) {
      const r = byKey.get(i);
      if (!r?.ok) { out[i].reason = r?.message || '사유 미상'; continue; }
      if (!r.name) { out[i].reason = 'Director 가 잡 이름 없이 성공을 회신했습니다 — 잡이 생겼을 수 있습니다. Director 에서 확인하세요.'; continue; }   // G3
      made.push({ i, prep, name: r.name });
    }
    // 원장은 한 번에(S2) — 끝 쓰기가 실패하면 이번 묶음 전부 원장 밖 잡이다(아래 orphanCleanup 이 끄고 이름을 밝힌다)
    recordTargets(made, by, demo).forEach((x, k) => {
      const o = made[k];
      if (x.ok) { out[o.i].job = x.job; out[o.i].ok = true; } else orphans.push({ i: o.i, name: o.name, err: x.err });
    });
    if (orphans.length) {
      // Director 잡은 이미 생겼다 — 끄고, 숨기지 않고 이름을 밝힌다.
      const why = await orphanCleanup(directorId, orphans, demo);
      for (const o of orphans) out[o.i].reason = why.get(o.name);
    }
  } finally {
    for (const k of claimed) _registering.delete(k);
  }
  return out;
}
