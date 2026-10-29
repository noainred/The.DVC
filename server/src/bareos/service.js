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
import { addJob as directorAddJob } from './director.js';
import { addJob as registryAddJob, listJobs, findByVm } from './registry.js';
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
  try { return await fn(s); } finally { s.close(); }
}

/**
 * 스냅샷 VM 1대의 등록 가능 여부(순수에 가까움 — 스냅샷·설정만 본다).
 * @returns {{ ok: boolean, reason?: string, site?: object, plugin?: string }}
 */
export function eligibility(vm, settings) {
  if (!vm) return { ok: false, reason: '인벤토리에 없는 VM 입니다.' };
  if (vm.template) return { ok: false, reason: '템플릿은 백업할 수 없습니다(스냅샷을 만들 수 없음 — Bareos 플러그인 제약).' };
  if (!vm.vcDatacenter || !vm.folderPath) return { ok: false, reason: '인벤토리에 데이터센터·폴더 경로가 없습니다(vApp 안의 VM 이거나 SOAP 수집 전 — 다음 수집 뒤 다시 보세요).' };
  const site = siteFor(vm.vcenterId, settings);
  if (!site) return { ok: false, reason: '이 vCenter 의 사이트 매핑(FD·스토리지·풀)이 없습니다 — 설정 탭에서 먼저 지정하세요.' };
  const p = backupPluginOptions({ plugin: settings.defaults.pluginName, vcserver: site.vcserver, dc: vm.vcDatacenter, folder: vm.folderPath, vmname: vm.name, configFile: site.configFile });
  if (p.issue) return { ok: false, reason: p.issue };
  return { ok: true, site, plugin: p.value };
}

/**
 * 백업 대상 등록(Director 잡 생성 + 원장). 범위 판정은 라우트가 먼저 한다.
 * @param {{ vcenterId, vmId, level?, schedule?, by, demo? }} o
 * @returns {Promise<object>} 원장 job
 */
export async function createBackupTarget({ vcenterId, vmId, level, schedule, by, demo = false }) {
  const snap = store.get();
  const vm = (snap?.vms || []).find((v) => v.id === vmId);
  if (!vm || String(vm.vcenterId) !== String(vcenterId)) throw fail('invalid', '선택한 VM 이 이 vCenter 의 인벤토리에 없습니다.');
  if (findByVm(vcenterId, vmId)) throw fail('invalid', '이 VM 은 이미 백업 대상입니다.');
  const settings = effectiveSettings();
  const el = eligibility(vm, settings);
  if (!el.ok) throw fail('invalid', el.reason);
  const moref = morefOf(vm.id, vm.vcenterId);
  const lvl = normLevel(level || settings.defaults.level);
  const sched = schedule === '' ? '' : (schedule || el.site.schedule || '');
  const base = {
    jobDefs: settings.defaults.jobDefs, client: el.site.client, storage: el.site.storage, pool: el.site.pool,
    schedule: sched || undefined, level: lvl, pluginOptions: el.plugin, description: `VMware Portal ${vm.name}`.replace(/[^\p{L}\p{N} ._-]/gu, ' '),
  };
  let created = null;
  await withDirector(async (s) => {
    for (const sfx of ['', 'r2', 'r3', 'r4', 'r5']) {
      const name = jobNameFor(vm.vcenterId, moref, sfx);
      if (!name) throw fail('invalid', 'VM 관리 id(moref)로 잡 이름을 만들 수 없습니다.');
      const r = await directorAddJob(s, { ...base, name });
      if (!r.exists) { created = r; return; }
    }
    throw fail('invalid', '같은 VM 의 Bareos 잡이 Director 에 이미 여러 개 있습니다 — Director 의 bareos-dir.d/job 아래 pv-… 파일을 정리한 뒤 다시 시도하세요.');
  });
  return registryAddJob({
    vcenterId: vm.vcenterId, vmId: vm.id, vmName: vm.name, dc: vm.vcDatacenter, folder: vm.folderPath,
    bareosJob: created.name, client: el.site.client, storage: el.site.storage, pool: el.site.pool, schedule: sched, level: lvl,
    createdBy: by, demo,
  });
}
