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
  loadSettings, directorConn, directorCred, directorById, siteFor, siteMissing, anyDirectorConfigured,
} from './settings.js';
import { OPS } from './ops.js';
import { addJob as registryAddJob, listJobs, findByVm, registryLoadError, jobCount, retireName, MAX_JOBS } from './registry.js';
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
export function isDemoActive(s = loadSettings()) { return !_factory && isMockMode() && !anyDirectorConfigured(s); }

/** 화면·라우트가 쓰는 설정(데모면 메모리 데모 설정 — 파일은 그대로). 비밀번호 포함(내부 전용). */
export function effectiveSettings() {
  const s = loadSettings();
  return isDemoActive(s) ? demoSettings(store.get?.()) : s;
}

const AUTH_CODES = new Set(['auth', 'pam', 'tls']);

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
  if (_factory) { const s = await _factory(directorId); try { return await fn(s); } finally { s.close?.(); } }
  const settings = loadSettings();
  if (isDemoActive(settings)) {
    registerDemoJobNames(listJobs().filter((j) => j.demo).map((j) => j.bareosJob));
    const s = demoSession(demoSettings(store.get?.()));
    try { return await fn(s); } finally { s.close(); }
  }
  const dir = directorById(directorId, settings);
  if (!dir) throw fail('not-configured', '이 백업 대상의 법인 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 확인하세요.');
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
  bareosAuthGuard.clearAuthStop(cred.id);
  // v2.822(검토 P1·S6 — 재현): 시한 신호를 **세션이 열린 뒤에도** 세션에 잇는다(폴러 예산이 명령 단계를 끊을 수 있게).
  const onAbort = () => s._fail?.(new BareosConsoleError('aborted', '시한·취소로 Director 세션을 끊었습니다.'));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try { return await fn(s); } finally { signal?.removeEventListener?.('abort', onAbort); s.close(); }
}

/**
 * 작업 표(ops.js)의 한 작업을 그 Director 에서 실행한다(1차 릴리스: 중앙이 직접). 결과는 작업이 돌려준 값 그대로.
 * @param {string} directorId
 * @param {keyof OPS} kind
 * @param {object} args 직렬화할 수 있는 값만(2차 엣지 대행이 같은 인자를 보낸다)
 */
export async function onDirector(directorId, kind, args = {}, { trigger = 'manual', signal = null, demoOnly = false } = {}) {
  const op = OPS[kind];
  if (!op) throw fail('invalid', `알 수 없는 Director 작업입니다(${kind}).`);
  return withDirector(directorId, (s) => op(s, args, { signal }), { trigger, signal, demoOnly });
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
function recordTarget(prep, jobName, by, demo) {
  const { vm, el } = prep;
  return registryAddJob({
    vcenterId: vm.vcenterId, vmId: vm.id, vmName: vm.name, dc: vm.vcDcPath, folder: vm.folderPath, directorId: prep.directorId,
    bareosJob: jobName, client: el.site.client, storage: el.site.storage, pool: el.site.pool, schedule: prep.sched, level: prep.lvl,
    createdBy: by, demo,
  });
}

/**
 * 원장 기록이 실패한 Director 잡들 — 끄고(스케줄이 돌지 않게) 이름을 남긴다(대조 틱이 다시 켜지면 또 끈다). 사유에 잡 이름을 밝힌다.
 * @returns {Promise<Map<string, string>>} 잡 이름 → 사유
 */
async function orphanCleanup(directorId, orphans, demo) {
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
 * 백업 대상 등록(Director 잡 생성 + 원장). 범위 판정은 라우트가 먼저 한다.
 * @param {{ vcenterId, vmId, level?, schedule?, by, demo? }} o
 * @returns {Promise<object>} 원장 job
 */
export async function createBackupTarget({ vcenterId, vmId, level, schedule, by, demo = false }) {
  const prep = prepareTarget({ vcenterId, vmId, level, schedule });
  const key = claimVm(prep);
  try {
    const [r] = await onDirector(prep.directorId, 'addJobs', { items: [{ key: 0, vcenterId: prep.vm.vcenterId, moref: prep.moref, base: prep.base }] });
    if (!r?.ok) throw fail(r?.code === 'skipped' ? 'connect' : (r?.code || 'error'), r?.message || 'Director 잡을 만들지 못했습니다.');
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
      results = await onDirector(directorId, 'addJobs', { items: ready.map(({ i, prep }) => ({ key: i, vcenterId: prep.vm.vcenterId, moref: prep.moref, base: prep.base })) });
    } catch (e) {
      // 세션을 열지 못했다(설정 미완·접속·인증) — 준비를 통과한 VM 전부 같은 사유. 원장·Director 는 바뀌지 않았다.
      const why = String(e?.message || e).slice(0, 300);
      for (const { i } of ready) if (!out[i].reason) out[i].reason = why;
      const err = fail(e?.code || 'connect', why); err.results = out; throw err;
    }
    const byKey = new Map(results.map((r) => [r.key, r]));
    const orphans = [];
    for (const { i, prep } of ready) {
      const r = byKey.get(i);
      if (!r?.ok) { out[i].reason = r?.message || '사유 미상'; continue; }
      try { out[i].job = recordTarget(prep, r.name, by, demo); out[i].ok = true; } catch (e) { orphans.push({ i, name: r.name, err: e }); }
    }
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
