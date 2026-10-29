/**
 * bareos/service.js — Bareos 연동의 업무 단위(v2.820). 라우트·폴러·데모가 같은 함수를 쓴다.
 *
 *  - withDirector(fn): 요청마다 콘솔 세션 1개(상시 연결 없음). 데모(mock 모드 + Director 미설정)면 메모리 Director.
 *    인증 실패(auth·pam·tls)는 정지 기록(util/authGuard.js) — **주기 조회만** 멈추고 수동 실행은 계속(자동 재시도 금지).
 *  - createBackupTarget: 스냅샷의 VM → 사이트 매핑 → 플러그인 옵션 → Director `configure add job` → 원장.
 *    Director 에 같은 이름이 이미 있으면(예전에 지운 대상의 비활성 잡) 접미사(-r2…)로 새로 만든다 — 옛 잡의 옵션은
 *    바뀌었을 수 있어 그대로 '입양' 하지 않는다.
 */
import { openConsole, BareosConsoleError } from './console.js';
import { loadSettings, directorConn, directorCred, siteFor } from './settings.js';
import { addJob as directorAddJob, setJobEnabled } from './director.js';
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
/** 테스트 주입 — () => Promise<session>. null 이면 실제 경로. */
export function _setSessionFactoryForTest(fn) { _factory = fn; }

/** 데모 Director 를 쓰는가 — mock 모드이고 Director 설정이 비어 있을 때만. */
export function isDemoActive(s = loadSettings()) { return !_factory && isMockMode() && !directorConn(s).conn; }

/** 화면·라우트가 쓰는 설정(데모면 메모리 데모 설정 — 파일은 그대로). 비밀번호 포함(내부 전용). */
export function effectiveSettings() {
  const s = loadSettings();
  return isDemoActive(s) ? demoSettings(store.get?.()) : s;
}

const AUTH_CODES = new Set(['auth', 'pam', 'tls']);

/**
 * 세션을 열어 fn(session) 을 돌리고 닫는다.
 * @param {(s) => Promise<any>} fn
 * @param {{ trigger?: 'timer'|'manual', signal?: AbortSignal }} [o]
 */
export async function withDirector(fn, { trigger = 'manual', signal = null, demoOnly = false } = {}) {
  // 데모 계정(mock 모드 내장 계정 — 요청 문맥은 admin)은 **데모 Director 일 때만** 접속한다. 사람이 등록한 Director 에는
  // 닿지 않는다(auth/demoGuest.js '실제 호스트에 닿는 실행은 막는다' 의 GET 판 — audit2719b 가 라우트 호출 모양을 대조한다).
  if (demoOnly && !isDemoActive()) throw fail('demo-only', DEMO_ONLY_REASON);
  if (_factory) { const s = await _factory(); try { return await fn(s); } finally { s.close?.(); } }
  const settings = loadSettings();
  if (isDemoActive(settings)) {
    registerDemoJobNames(listJobs().filter((j) => j.demo).map((j) => j.bareosJob));
    const s = demoSession(demoSettings(store.get?.()));
    try { return await fn(s); } finally { s.close(); }
  }
  const { conn, missing } = directorConn(settings);
  if (!conn) throw fail('not-configured', `Bareos Director 설정이 덜 됐습니다(${missing.join('·')}) — 설정 탭에서 먼저 등록하세요.`);
  const cred = directorCred(settings);
  if (trigger === 'timer') {
    const stop = bareosAuthGuard.authStopFor(cred);
    if (stop) throw fail('auth-stopped', `인증 실패로 주기 조회를 멈췄습니다(${stop.reason}) — 설정을 고치면 다시 시작합니다.`);
  }
  let s;
  try {
    s = await openConsole(conn, { signal });
  } catch (e) {
    if (AUTH_CODES.has(e?.code)) bareosAuthGuard.markAuthStopped(cred.id, cred, e.message);
    throw e;
  }
  bareosAuthGuard.clearAuthStop(cred.id);
  // v2.822(검토 P1·S6 — 재현): 시한 신호를 **세션이 열린 뒤에도** 세션에 잇는다. 예전에는 openConsole 이 인증 뒤 리스너를 떼어
  //   폴러 예산(withDeadline)이 명령 단계를 끊지 못했다 — 느린 Director 에서 한 틱이 수십 분 _busy 를 붙잡았다(실측 30초 예산에 40초).
  const onAbort = () => s._fail?.(new BareosConsoleError('aborted', '시한·취소로 Director 세션을 끊었습니다.'));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try { return await fn(s); } finally { signal?.removeEventListener?.('abort', onAbort); s.close(); }
}

/**
 * 스냅샷 VM 1대의 등록 가능 여부(순수에 가까움 — 스냅샷·설정만 본다).
 * @returns {{ ok: boolean, reason?: string, site?: object, plugin?: string }}
 */
export function eligibility(vm, settings) {
  if (!vm) return { ok: false, reason: '인벤토리에 없는 VM 입니다.' };
  if (vm.template) return { ok: false, reason: '템플릿은 백업할 수 없습니다(스냅샷을 만들 수 없음 — Bareos 플러그인 제약).' };
  if (!vm.vcDcPath || !vm.folderPath) return { ok: false, reason: '인벤토리에 데이터센터·폴더 경로가 없습니다(vApp 안의 VM 이거나 SOAP 수집 전 — 다음 수집 뒤 다시 보세요).' };
  const site = siteFor(vm.vcenterId, settings);
  if (!site) return { ok: false, reason: '이 vCenter 의 사이트 매핑(FD·스토리지·풀)이 없습니다 — 설정 탭에서 먼저 지정하세요.' };
  const p = backupPluginOptions({ plugin: settings.defaults.pluginName, vcserver: site.vcserver, dc: vm.vcDcPath, folder: vm.folderPath, vmname: vm.name, configFile: site.configFile });
  if (p.issue) return { ok: false, reason: p.issue };
  return { ok: true, site, plugin: p.value };
}

/**
 * 등록 준비(순수에 가까움 — 스냅샷·설정·원장만 본다). 실패는 throw(invalid).
 * @returns {{ vm, el, base, moref, lvl, sched }}
 */
export function prepareTarget({ vcenterId, vmId, level, schedule }, { snap = store.get(), settings = effectiveSettings() } = {}) {
  // 원장에 넣을 수 없는 상태면 Director 에 닿기 **전에** 거절한다(C3·P3) — 예전에는 잡을 만든 뒤 원장 추가가 실패해 스케줄이 붙은 고아 잡이 남았다.
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 새 대상을 추가하지 않습니다(손상본 보존 — 서비스 점검에서 확인).');
  if (jobCount() >= MAX_JOBS) throw fail('invalid', `백업 대상은 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
  const vm = (snap?.vms || []).find((v) => v.id === vmId);
  if (!vm || String(vm.vcenterId) !== String(vcenterId)) throw fail('invalid', '선택한 VM 이 이 vCenter 의 인벤토리에 없습니다.');
  if (findByVm(vcenterId, vmId)) throw fail('invalid', '이 VM 은 이미 백업 대상입니다.');
  const el = eligibility(vm, settings);
  if (!el.ok) throw fail('invalid', el.reason);
  const moref = morefOf(vm.id, vm.vcenterId);
  const lvl = normLevel(level || settings.defaults.level);
  const sched = schedule === '' ? '' : (schedule || el.site.schedule || '');
  const base = {
    jobDefs: settings.defaults.jobDefs, client: el.site.client, storage: el.site.storage, pool: el.site.pool,
    schedule: sched || undefined, level: lvl, pluginOptions: el.plugin, description: `VMware Portal ${vm.name}`.replace(/[^\p{L}\p{N} ._-]/gu, ' '),
  };
  return { vm, el, base, moref, lvl, sched };
}

/** 열린 세션에서 Director 잡 만들기 — 같은 이름이 있으면 접미사(r2…r5)로 다시. */
async function addOnDirector(s, prep) {
  for (const sfx of ['', 'r2', 'r3', 'r4', 'r5']) {
    const name = jobNameFor(prep.vm.vcenterId, prep.moref, sfx);
    if (!name) throw fail('invalid', 'VM 관리 id(moref)로 잡 이름을 만들 수 없습니다.');
    const r = await directorAddJob(s, { ...prep.base, name });
    if (!r.exists) return r;
  }
  throw fail('invalid', '같은 VM 의 Bareos 잡이 Director 에 이미 여러 개 있습니다 — Director 의 bareos-dir.d/job 아래 pv-… 파일을 정리한 뒤 다시 시도하세요.');
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

/** 원장 기록이 실패한 Director 잡 — 끄고(스케줄이 돌지 않게) 이름을 남긴다(대조 틱이 다시 켜지면 또 끈다). 사유에 잡 이름을 밝힌다. */
async function orphanCleanup(s, created, err, demo) {
  let off = false;
  try { await setJobEnabled(s, created.name, false); off = true; } catch { /* 아래 문구가 밝힌다 */ }
  try { retireName(created.name, demo); } catch { /* 원장을 못 쓰는 상태일 수 있다 */ }
  return `Director 잡 ‘${created.name}’ 은 만들었지만 원장에 넣지 못했습니다(${String(err?.message || err).slice(0, 200)}) — ${off ? '그 잡은 비활성화했습니다' : '그 잡을 비활성화하지도 못했습니다'}. Director 호스트에서 bareos-dir.d/job/${created.name}.conf 를 정리하세요.`;
}

/** 원장 기록(Director 잡을 만든 **뒤**). */
function recordTarget(prep, created, by, demo) {
  const { vm, el } = prep;
  return registryAddJob({
    vcenterId: vm.vcenterId, vmId: vm.id, vmName: vm.name, dc: vm.vcDcPath, folder: vm.folderPath,
    bareosJob: created.name, client: el.site.client, storage: el.site.storage, pool: el.site.pool, schedule: prep.sched, level: prep.lvl,
    createdBy: by, demo,
  });
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
    return await withDirector(async (s) => {
      const created = await addOnDirector(s, prep);
      try { return recordTarget(prep, created, by, demo); } catch (e) { throw fail('record', await orphanCleanup(s, created, e, demo)); }
    });
  } finally { _registering.delete(key); }
}

/** 세션째 쓸 수 없게 된 오류(이후 VM 도 같은 이유로 실패한다) — 일괄 등록이 여기서 멈춘다. */
const SESSION_DEAD = new Set(['closed', 'timeout', 'aborted', 'protocol', 'too-large', 'connect', 'tls', 'auth', 'pam', 'blocked']);

/**
 * v2.822 일괄 등록 — 같은 vCenter 의 여러 VM 을 **Director 세션 하나**로 순차 등록한다(VM 마다 접속하지 않는다).
 * 한 VM 의 실패(이름·자격·Director 거부)는 나머지를 막지 않는다. 세션이 끊기면(SESSION_DEAD) 남은 VM 은 그 사유로 '건너뜀'.
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
  try {
    await withDirector(async (s) => {
      let dead = '';
      for (const { i, prep } of ready) {
        if (dead) { out[i].reason = `건너뜀 — ${dead}`; continue; }
        let created;
        try { created = await addOnDirector(s, prep); } catch (e) {
          out[i].reason = String(e?.message || e).slice(0, 300);
          if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
          continue;
        }
        try { out[i].job = recordTarget(prep, created, by, demo); out[i].ok = true; } catch (e) {
          // Director 잡은 이미 생겼다 — 끄고, 숨기지 않고 이름을 밝힌다(다시 등록하면 접미사가 붙은 새 잡이 생기므로 Director 쪽 정리가 필요할 수 있다).
          out[i].reason = await orphanCleanup(s, created, e, demo);
        }
      }
    });
  } catch (e) {
    // 세션을 열지 못했다(설정 미완·접속·인증) — 준비를 통과한 VM 전부 같은 사유. 원장·Director 는 바뀌지 않았다.
    const why = String(e?.message || e).slice(0, 300);
    for (const { i } of ready) if (!out[i].ok && !out[i].reason) out[i].reason = why;
    if (!ready.some(({ i }) => out[i].ok)) { const err = fail(e?.code || 'connect', why); err.results = out; throw err; }
  } finally {
    for (const k of claimed) _registering.delete(k);
  }
  return out;
}
