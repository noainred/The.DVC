/**
 * bareos/manage/service.js — 법인별 Bareos 설정(v2.845) 서비스: SSH 출처 판정 · 설정 조회(짧은 기억) · 쓰기 실행(중앙 직접 / 엣지 대행 / 데모) ·
 * 중앙 계정 통합(매트릭스 · 일괄) · 재설치 뒤 대상 다시 등록.
 *
 * 사용자 결정(2026-11-01): 법인 · vCenter · Bareos 1:1:1 · '백업은 법인 로컬' — 쓰기는 담당 엣지가 있으면 그 엣지가 SSH 로(작업 하나를 보내고 요약만 받는다).
 *   SSH 는 배포 등록부(Director 주소가 그 엣지 노드일 때만 — 저장 비밀은 저장 주소로만 · v2.480 규칙) 아니면 **그때마다 입력(저장하지 않는다)**.
 * 라우트(routes/api/bareosManage.js)가 권한 · 범위 · OTP · 잠금을 먼저 본다. 여기는 판정 · 실행만.
 */
import { store } from '../../store.js';
import { listInventory } from '../../central/inventory.js';
import { listTargetsRaw } from '../../agent/deployRegistry.js';
import { ipBlockReason } from '../../util/ssrfBlock.js';
import { directorById, jobDirectorId, settingsRev } from '../settings.js';
import { onDirector, relayToEdge, isDemoActive, effectiveSettings, eligibility, orphanCleanup } from '../service.js';

/** 다시 등록 한 번에 보내는 대상 수(엣지 회신 정제의 addJobs 상한 500 보다 작게 — v2.846 E-1). */
export const REREGISTER_BATCH = 200;
import { listJobs, rebindJobs, jobDigests } from '../registry.js';
import { jobNameFor } from '../names.js';
import { JOB_NAME_SUFFIXES, MID_COMMAND_CODES } from '../ops.js';
import { morefOf } from '../../vcenter/registry.js';
import { tryLockJob, unlockJob } from '../jobLocks.js';
import { requestReconcile } from '../poller.js';
import { listGroups, groupsLoadError } from '../groups.js';
import { poolSettled } from '../../util/pool.js';
import { knownHostAddrs } from '../install/job.js';
import { planManage, applyManage, RESERVED_CONSOLES } from './apply.js';
import { normConfigResult, normScanResult } from './showParse.js';
import * as demo from './demo.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/* ───────── SSH 출처(순수 — 시험이 고정) ───────── */
/**
 * 이 Director 를 고칠 SSH 를 어디서 얻는가.
 *  - 'registry': 배포 등록부의 엣지 SSH(비밀번호 저장된 것만) — Director 주소가 그 엣지 SSH 주소이거나, 완전 설치가 기록한 서버 주소이거나,
 *    담당 엣지(d.agent)에서 본 Director 주소가 루프백(엣지 노드 자신)일 때만. 다른 서버의 Director 에 엣지 비밀번호를 쓰지 않는다.
 *  - 'input': 그때마다 입력(저장하지 않는다). host 는 Director 주소를 미리 채운다(루프백 · 차단 대역이면 비움).
 * @returns {{ source: 'registry'|'input', targetId?, host, port, username, why }}
 */
export function sshSourceFor(d, { settings, inventory = [], deployTargets = [], known = new Map() } = {}) {
  const sites = (settings?.sites || []).filter((s) => s.directorId === d.id);
  const agentOf = (vcId) => inventory.find((i) => i.vcenterId === vcId)?.agent || '';
  const targetOf = (agent) => (agent ? deployTargets.find((t) => lc(t.agentName) === lc(agent) && t.password && t.enabled !== false) || deployTargets.find((t) => lc(t.agentName) === lc(agent) && t.password) : null);
  const reg = (t, why) => ({ source: 'registry', targetId: t.id, host: t.host, port: Number(t.port) || 22, username: t.username || 'root', why });
  const host = lc(d.host);
  // v2.845 반증 F1(재현): 담당 엣지가 있으면 **그 엣지의** 등록부 계정만 — 다른 법인 엣지의 root 비밀번호를 이 엣지의 대행 작업에 실어 보내지 않는다.
  //   담당 엣지가 없으면(중앙 직접) 이 Director 에 묶인 vCenter 를 올리는 엣지의 계정 중 주소가 같은 것.
  const mine = (t) => !!t && (!d.agent || lc(t.agentName) === lc(d.agent));
  const agents = d.agent ? [d.agent] : [...new Set(sites.map((s) => agentOf(s.vcenterId)).filter(Boolean))];
  for (const a of agents) {
    const t = targetOf(a);
    if (!mine(t)) continue;
    if (lc(t.host) === host) return reg(t, `Director 주소가 엣지 ‘${a}’ 의 SSH 주소와 같습니다(배포 등록부 계정).`);
  }
  for (const s of sites) {
    const k = known.get(s.vcenterId);
    const t = targetOf(d.agent || agentOf(s.vcenterId));
    if (mine(t) && k && lc(k) === host) return reg(t, `완전 설치가 이 엣지 노드에 설치한 Director 입니다(배포 등록부 계정).`);
  }
  if (d.agent && LOOPBACK.has(host)) {
    const t = targetOf(d.agent);
    if (t) return reg(t, `담당 엣지 ‘${d.agent}’ 가 루프백으로 붙는 Director(엣지 노드 자신)입니다(배포 등록부 계정).`);
  }
  const pre = !host || LOOPBACK.has(host) || ipBlockReason(String(d.host)) ? '' : String(d.host);
  return { source: 'input', host: pre, port: 22, username: 'root', why: '배포 등록부에서 이 Director 서버의 SSH 계정을 찾지 못했습니다 — 실행할 때마다 SSH 비밀번호를 입력합니다(저장하지 않습니다).' };
}

/** 지금 값으로(라우트용). */
export function sshSource(d) {
  if (isDemoActive()) return { source: 'demo', host: '', port: 22, username: 'root', why: '데모 모드 — 장비에 접속하지 않습니다(SSH 를 쓰지 않음).' };
  let inventory = []; try { inventory = listInventory(); } catch { inventory = []; }
  let deployTargets = []; try { deployTargets = listTargetsRaw(); } catch { deployTargets = []; }
  let known = new Map(); try { known = knownHostAddrs(); } catch { known = new Map(); }
  return sshSourceFor(d, { settings: effectiveSettings(), inventory, deployTargets, known });
}
/** 공개용(비밀 · 내부 id 없음). */
export const publicSsh = (x) => ({ source: x.source, host: x.host, port: x.port, username: x.username, why: x.why });

/**
 * 실행에 쓸 SSH 값. registry 면 저장 주소 · 계정 · 비밀번호(요청 host 를 받지 않는다 — 저장 비밀은 저장 주소로만) · input 이면 요청 값.
 * @returns {{ host, sshPort, username, password }}
 */
export function resolveSsh(d, body = {}) {
  const src = sshSource(d);
  if (src.source === 'registry') {
    const t = listTargetsRaw().find((x) => x.id === src.targetId);
    if (!t?.password) throw fail('invalid', '배포 등록부의 SSH 비밀번호를 읽지 못했습니다.');
    return { host: t.host, sshPort: Number(t.port) || 22, username: t.username || 'root', password: t.password, registry: true };
  }
  const s = body && typeof body === 'object' ? body : {};
  if (typeof s.password !== 'string' || !s.password) throw fail('invalid', `‘${d.name}’ 는 배포 등록부 SSH 가 없어 SSH 비밀번호를 입력해야 합니다(저장하지 않습니다).`, { needSsh: true });
  return { host: String(s.host ?? '').trim(), sshPort: s.sshPort, username: String(s.username ?? '').trim() || 'root', password: s.password, registry: false };
}

/* ───────── 설정 조회(Director 콘솔 · SSH 없음) ───────── */
const CONFIG_TTL_MS = 30_000;
const _cfgMemo = new Map();   // `${demo}|${id}|${rev}` → { at, value }
const _cfgInflight = new Map();
const _cfgGen = new Map();   // directorId → 세대(반증 E7 — 쓰기 전에 시작한 조회가 쓰기 뒤에 끝나 옛 값을 다시 기억하지 않게)
export function forgetConfig(directorId) {
  _cfgGen.set(directorId, (_cfgGen.get(directorId) || 0) + 1);
  for (const k of [..._cfgMemo.keys()]) if (k.includes(`|${directorId}|`)) _cfgMemo.delete(k);
  for (const k of [..._cfgInflight.keys()]) if (k.includes(`|${directorId}|`)) _cfgInflight.delete(k);
}
export function _resetForTest() { _cfgMemo.clear(); _cfgInflight.clear(); _cfgGen.clear(); }

/**
 * @returns {Promise<{ results, version, at }>} — 비밀번호 칸 없음(ops.config 가 버리고 normConfigResult 가 다시 거른다).
 */
export async function readConfig(d, { refresh = false } = {}) {
  const key = `${isDemoActive() ? 1 : 0}|${d.id}|${settingsRev()}`;
  const hit = _cfgMemo.get(key);
  if (!refresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value;
  if (_cfgInflight.has(key)) return _cfgInflight.get(key);
  const gen0 = _cfgGen.get(d.id) || 0;
  const p = (async () => {
    const v = normConfigResult(await onDirector(d.id, 'config', {}));
    const value = { ...v, at: Date.now() };
    if ((_cfgGen.get(d.id) || 0) === gen0) _cfgMemo.set(key, { at: value.at, value });
    return value;
  })().finally(() => { if (_cfgInflight.get(key) === p) _cfgInflight.delete(key); });
  _cfgInflight.set(key, p);
  return p;
}
const okVal = (cfg, k) => (cfg?.results?.[k]?.ok ? cfg.results[k].value : []);

const groupsSafe = () => { try { return listGroups(); } catch { return []; } };
/** planManage 에 줄 '그 Director 의 지금 설정'(비밀 없음). 매핑 스토리지 = 사이트 매핑 + 이 법인 vCenter 의 백업 그룹이 지정한 스토리지(v2.846 D-5 ①). */
export function knownFor(d, cfg, settings = effectiveSettings(), groups = groupsSafe()) {
  const storages = okVal(cfg, 'storages');
  const prefer = storages.find((s) => s.name === 'File' && s.address) || storages.find((s) => s.address) || null;   // 반증 F9 — 주소가 빈 File 을 고르지 않는다
  return {
    config: { storages, consoles: okVal(cfg, 'consoles'), profiles: okVal(cfg, 'profiles') },
    portalConsole: d.consoleName || '',
    address: prefer?.address || '',
    mappedStorages: (() => {
      const vcs = new Set((settings.sites || []).filter((s) => s.directorId === d.id).map((s) => s.vcenterId));
      return [...new Set([...(settings.sites || []).filter((s) => s.directorId === d.id).map((s) => s.storage), ...groups.filter((g) => vcs.has(g.vcenterId)).map((g) => g.storage)].filter(Boolean))];
    })(),
  };
}

/* ───────── 쓰기 · 디스크 읽기 ───────── */
/**
 * 입력 판정(라우트가 OTP 전에 부른다 — 입력 실수가 1회용 OTP 를 태우지 않게). 설정을 못 읽었으면 판정이 할 수 있는 만큼만(이름 겹침은 원격 파일 · bareos-dir -t 가 다시 막는다).
 */
/**
 * @param {{ waitMs?: number }} [o] v2.847 C2-1(2회차 점검): 설정 조회를 기다리는 최대 시간(라우트의 남은 예산). 넘으면 '못 읽음'(cfg null)으로 판정한다.
 *   readConfig 에 signal 을 넘기지 않는다 — 진행 중 조회를 여러 호출이 공유하므로(_cfgInflight) 한 호출의 시한이 남의 조회를 끊으면 안 된다(반증 ⚠). 기다림만 끊는다.
 */
export async function planFor(d, action, input, { waitMs = Infinity } = {}) {
  let cfg = null;
  if (action !== 'scan') {
    let timer = null;
    try {
      const capped = Number.isFinite(waitMs) ? new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, waitMs)); }) : null;
      cfg = await (capped ? Promise.race([readConfig(d), capped]) : readConfig(d));
    } catch { cfg = null; } finally { if (timer) clearTimeout(timer); }
  }
  // v2.846 D-5 ③: 스토리지 편집 · 삭제는 Director 설정(목록 · 매핑 판정)을 읽었을 때만 — 못 읽은 목록은 '마지막 스토리지' 판정을 건너뛰게 했다
  if ((action === 'storage.delete' || action === 'storage.edit') && !cfg?.results?.storages?.ok) {
    throw Object.assign(new Error('Director 스토리지 목록을 읽지 못해 판정할 수 없습니다 — 연결을 확인하고 다시 읽은 뒤 하세요(아무것도 바꾸지 않았습니다).'), { code: 'conflict' });
  }
  // v2.847 D2-6(2회차 점검 — 재현): 그룹 원장이 손상되면 listGroups 는 빈 목록을 준다 — '그룹 스토리지 없음' 으로 보면 그룹이 쓰는 스토리지를 지울 수 있었다
  if ((action === 'storage.delete' || action === 'storage.edit') && groupsLoadError()) {
    throw Object.assign(new Error('백업 그룹 원장을 읽지 못해 이 스토리지를 그룹이 쓰는지 판정할 수 없습니다 — 서비스 점검에서 그룹 원장을 확인한 뒤 하세요(아무것도 바꾸지 않았습니다).'), { code: 'conflict' });
  }
  const known = knownFor(d, cfg);
  return { plan: planManage(action, input, known), known, configRead: !!cfg };
}

/**
 * 실행. ssh = resolveSsh 결과 · accountPassword = 계정 비밀번호(생성은 라우트가) — 응답 · 감사 · 로그에 싣지 않는다.
 * @returns {Promise<object>} scan 이면 normScanResult · 쓰기면 { ok, files, restarted, reloaded, relay? }
 */
export async function runManage(d, { plan, known, input }, ssh, { accountPassword = '', signal = null } = {}) {
  if (isDemoActive()) return demo.applyDemo(d.id, plan, { accountPassword });
  const isScan = plan.action === 'scan';
  if (d.agent) {
    const kind = isScan ? 'setup.scan' : 'setup.manage';
    const secretArgs = { password: ssh.password, ...(accountPassword ? { accountPassword } : {}) };
    // signal(v2.846 C-4): 부른 쪽 시간 예산 — 엣지가 아직 가져가지 않았으면 거둔다(보내지 않음) · 가져갔으면 결과 모름(엣지가 실행 중일 수 있다)
    const v = await relayToEdge(d, kind, { body: { host: ssh.host, sshPort: ssh.sshPort, username: ssh.username }, action: plan.action, input: input || {}, known }, { secretArgs, signal });
    return isScan ? normScanResult(v) : { ok: true, ...v, relay: d.agent };
  }
  const v = await applyManage(plan, { host: ssh.host, sshPort: ssh.sshPort, username: ssh.username, password: ssh.password }, { accountPassword }, { dirPort: d.port, signal });
  return isScan ? normScanResult(v) : v;
}

/* ───────── 중앙 계정 통합 ───────── */
const MATRIX_CONCURRENCY = 4;

/**
 * 법인(Director)마다 WebUI 계정 목록 — 설정 조회(Director 마다 시한 · 동시 4). 실패한 법인은 사유와 함께(다른 법인을 막지 않는다).
 * @returns {Promise<{ directors: object[], names: string[] }>}
 */
export async function accountsMatrix({ refresh = false, showAddr = true } = {}) {
  const s = effectiveSettings();
  const dirs = s.directors || [];
  const settled = await poolSettled(dirs, MATRIX_CONCURRENCY, async (d) => {
    const base = { id: d.id, name: d.name, agent: d.agent || '', ...(showAddr ? { host: d.host } : {}), portalConsole: d.consoleName || '', ssh: publicSsh(sshSource(d)) };
    try {
      const cfg = await readConfig(d, { refresh });
      const c = cfg.results.consoles;
      if (!c?.ok) return { ...base, ok: false, error: c ? `${c.code}: ${c.message}`.slice(0, 300) : '계정 목록을 읽지 못했습니다.' };
      return {
        ...base, ok: true, at: cfg.at, version: cfg.version,
        consoles: c.value.map((x) => ({ name: x.name, profile: x.profile, tlsEnable: x.tlsEnable, reserved: RESERVED_CONSOLES.includes(lc(x.name)), portalConsole: lc(x.name) === lc(d.consoleName) })),
        profiles: okVal(cfg, 'profiles').map((p) => p.name),
      };
    } catch (e) { return { ...base, ok: false, error: `${e?.code || 'error'}: ${String(e?.message || e)}`.slice(0, 300) }; }
  });
  // 한 법인의 예외가 다른 법인 결과를 버리지 않게(util/pool — 판정 코어 하나)
  const rows = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { id: dirs[i].id, name: dirs[i].name, agent: dirs[i].agent || '', ok: false, error: String(r.reason?.message || r.reason).slice(0, 300) }));
  const names = [...new Set(rows.flatMap((r) => (r.consoles || []).filter((c) => !c.reserved && !c.portalConsole).map((c) => c.name)))].sort((a, b) => a.localeCompare(b));
  return { directors: rows, names };
}

/* ───────── 재설치 뒤 대상 다시 등록 ───────── */
/** Director `.jobs` 에 없는 원장 대상(이 Director 에 고정된 것만). */
export async function missingTargets(d) {
  const demoNow = isDemoActive();
  const settings = effectiveSettings();
  const r = await onDirector(d.id, 'jobNames', {});
  const names = (Array.isArray(r?.names) ? r.names : []).map(String);
  // v2.847 D2-2(2회차 점검 — 재현): 빈 `.jobs` 를 믿으면 그 Director 의 대상이 전부 '빠짐' 으로 보였다(화면이 전부 미리 체크 → 같은 VM 의 두 번째 잡).
  //   재설치 직후에도 패키지 기본 잡(BackupClient1 · RestoreFiles · BackupCatalog)이 있다 — 빈 목록은 '못 읽음' 이다(폴러 I2-5 와 같은 규칙).
  if (!names.length) throw Object.assign(new Error('Director 의 잡 목록(.jobs)이 비어 왔습니다 — 판정할 수 없어 빠진 대상을 보이지 않습니다(재설치 직후에도 패키지 기본 잡이 있어야 합니다). 잠시 뒤 다시 읽으세요.'), { code: 'conflict' });
  const have = new Set(names);
  return listJobs()
    .filter((j) => (demoNow ? j.demo : !j.demo) && jobDirectorId(j, settings) === d.id && !have.has(j.bareosJob))
    .map((j) => ({ id: j.id, vcenterId: j.vcenterId, vmId: j.vmId, vmName: j.vmName, bareosJob: j.bareosJob, schedule: j.schedule, level: j.level, enabled: j.enabled !== false }));
}

/**
 * v2.847 D2-3: 이 Director 카탈로그의 세대가 바뀌었는가(재설치가 카탈로그 DB 를 새로 만들었나). 원장에서 lastRun jobid 가 가장 큰 대상 하나를 골라
 * 그 잡 이름의 카탈로그 실행 목록(`history` — 이미 있는 작업이라 옛 엣지도 받는다)에 그 jobid 가 있으면 'same', 없으면 'new',
 * 묻지 못했으면 'unknown', 원장에 실행 기록이 하나도 없으면 'none'(비울 것이 없다). Director 마다 명령 하나.
 * @returns {Promise<'same'|'new'|'unknown'|'none'>}
 */
export async function catalogGeneration(d, settings = effectiveSettings()) {
  const demoNow = isDemoActive();
  let best = null;
  for (const j of jobDigests()) {   // 얕은 요약(lastRun 포함) — 원장 깊은 복사를 하지 않는다
    if ((demoNow ? j.demo : !j.demo) && jobDirectorId(j, settings) === d.id && Number.isInteger(j.lastRun?.jobid) && j.lastRun.jobid > 0
      && (!best || j.lastRun.jobid > best.lastRun.jobid)) best = j;
  }
  if (!best) return 'none';
  try {
    const rows = await onDirector(d.id, 'history', { name: best.bareosJob, limit: 200 });
    if (!Array.isArray(rows)) return 'unknown';
    return rows.some((r) => r?.jobid === best.lastRun.jobid) ? 'same' : 'new';
  } catch { return 'unknown'; }
}

/** 등록 회신 한 줄이 '결과 모름'(잡이 생겼을 수 있다)인가 — 회신 없음 · 엣지가 이름 없이 성공 · 명령 도중 끊김(E2-1 — groupRunner.itemState 와 같은 표). */
export const addResultUnknown = (r) => !r || r.code === 'unknown' || MID_COMMAND_CODES.has(r.code);

/**
 * 다시 등록 — 고른 대상 중 **지금 다시 읽은** 빠진 목록에 있는 것만(화면 목록을 믿지 않는다). 세션 하나로 addJobs → 원장 같은 행에 다시 묶기(rebindJobs).
 * 켜짐 · 스케줄 · 레벨은 원장 값 그대로(그룹 잡은 스케줄 없이) — 꺼 둔 대상은 다음 대조가 다시 끈다(부르는 쪽이 requestReconcile).
 * @returns {Promise<{ results: { id, vmName, ok, name?, reason? }[] }>}
 */
/**
 * v2.847 C2-5 ②(2회차 점검 — 산수): 다시 등록의 서버 예산(라우트 진입부터) — 화면 시한(600초)보다 짧게. 새 묶음은 남은 시간이 REREGISTER_MIN_BATCH_MS 이상일 때만
 * 보내고(아니면 '보내지 않음'), 보낸 묶음은 남은 시간까지만 기다린다(엣지 대행이면 결과 모름 → 늦은 회신 처리 · 중앙 직접이면 명령 도중 끊김 → `.jobs` 로 가림).
 */
export const REREGISTER_BUDGET_MS = 540_000;
export const REREGISTER_MIN_BATCH_MS = 120_000;
export async function reregisterTargets(d, ids = [], { startedAt = Date.now() } = {}) {
  const left = () => REREGISTER_BUDGET_MS - (Date.now() - startedAt);
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const missing = (await missingTargets(d)).filter((m) => want.has(m.id));
  const snap = store.get();
  const settings = effectiveSettings();
  const out = []; const ready = []; const locked = [];
  for (const m of missing) {
    const o = { id: m.id, vmName: m.vmName, ok: false };
    out.push(o);
    const vm = (snap?.vms || []).find((v) => v.id === m.vmId && String(v.vcenterId) === String(m.vcenterId));
    if (!vm) { o.reason = 'VM 이 인벤토리에 없습니다(지워졌거나 수집 전).'; continue; }
    const el = eligibility(vm, settings);
    if (!el.ok) { o.reason = el.reason; continue; }
    if (el.site.directorId !== d.id) { o.reason = '이 VM 의 vCenter 가 지금 다른 Director 에 묶여 있습니다.'; continue; }
    const moref = morefOf(vm.id, vm.vcenterId);
    if (!jobNameFor(vm.vcenterId, moref)) { o.reason = 'VM 관리 id(moref)로 잡 이름을 만들 수 없습니다.'; continue; }
    if (!tryLockJob(m.id)) { o.reason = '이 대상의 다른 작업(실행 · 삭제 · 복원)이 진행 중입니다.'; continue; }
    locked.push(m.id);
    // D2-2: 원장 이름 그대로만 만든다(그 이름이 이미 있으면 '이미 있음' 으로 건너뜀 — 접미사로 두 번째 잡을 만들지 않는다)
    const exactSfx = JOB_NAME_SUFFIXES.find((sfx) => jobNameFor(vm.vcenterId, moref, sfx) === m.bareosJob);
    const base = {
      jobDefs: settings.defaults.jobDefs, client: el.site.client, storage: el.site.storage, pool: el.site.pool,
      schedule: m.schedule || undefined, level: m.level, pluginOptions: el.plugin, description: `VMware Portal ${vm.name}`.replace(/[^\p{L}\p{N} ._-]/gu, ' '),
    };
    ready.push({ o, vm, key: out.length - 1, item: { key: out.length - 1, vcenterId: vm.vcenterId, moref, base, ...(exactSfx !== undefined ? { exactSfx } : {}) }, site: el.site, exactName: exactSfx !== undefined ? m.bareosJob : '' });
  }
  let generation = 'none';
  try {
    if (!ready.length) return { results: out, generation };
    // v2.847 D2-3: 실행 기록은 카탈로그 세대가 바뀌었거나(new) 판정하지 못했을 때(unknown — D-1 의 '새 실행을 버림' 이 더 큰 손실)만 새로 시작한다
    generation = await catalogGeneration(d, settings);
    const restart = generation === 'new' || generation === 'unknown';
    /** 한 묶음의 회신 → 원장 같은 행에 다시 묶기. 결과 모름(회신 없음 · 명령 도중 끊김 — E-1 · E2-1)은 뒤에서 `.jobs` 로 한 번 가린다 · 묶지 못한 잡은 끄고 지운 이름에 남긴다(E-4 · 일반 등록 orphanCleanup 하나). */
    const unsure = [];
    const bind = async (part, results) => {
      const byKey = new Map((Array.isArray(results) ? results : []).map((r) => [r.key, r]));
      const list = [];
      for (const x of part) {
        const r = byKey.get(x.key);
        if (addResultUnknown(r)) {
          x.o.reason = `결과 모름 — ${r ? (r.message || '명령 도중 연결이 끊겼습니다') : '회신에 이 항목이 없습니다'}(Director 에 잡이 생겼을 수 있습니다 — 빠진 대상 목록을 다시 읽으세요).`;
          x.o.unknown = true; unsure.push(x); continue;
        }
        if (!r.ok || !r.name) { x.o.reason = r.message || (r.ok ? 'Director 가 잡 이름 없이 성공을 회신했습니다.' : '사유 미상'); if (r.code === 'exists') x.o.exists = true; continue; }
        x.o.name = r.name;
        list.push({ id: x.o.id, bareosJob: r.name, client: x.site.client, storage: x.site.storage, pool: x.site.pool, vmName: x.vm.name, dc: x.vm.vcDcPath, folder: x.vm.folderPath });
      }
      await bindList(list);
    };
    const bindList = async (list) => {
      if (!list.length) return;
      let res;
      try { res = rebindJobs(list, { restart }); } catch (e) { res = list.map((x) => ({ id: x.id, ok: false, err: e })); }
      const orphans = [];
      for (const r of res) {
        const o = out.find((y) => y.id === r.id);
        if (o) o.ok = r.ok;
        if (!r.ok) orphans.push({ name: list.find((x) => x.id === r.id)?.bareosJob, err: r.err, o });
      }
      if (orphans.some((x) => x.name)) {
        const why = await orphanCleanup(d.id, orphans.filter((x) => x.name), isDemoActive());
        for (const x of orphans) if (x.o) x.o.reason = why.get(x.name) || `원장에 묶지 못했습니다(${String(x.err?.message || x.err).slice(0, 160)})`;
      }
      requestReconcile(d.id);
    };
    // v2.846 E-1: 엣지 회신 정제는 addJobs 를 500건에서 자른다(엣지 계약) — 묶음 200건으로 차례로 보낸다(중앙 직접도 같은 크기 — 세션 하나가 너무 오래 잡히지 않게)
    for (let i = 0; i < ready.length; i += REREGISTER_BATCH) {
      const part = ready.slice(i, i + REREGISTER_BATCH);
      if (left() < REREGISTER_MIN_BATCH_MS) {
        for (const x of ready.slice(i)) Object.assign(x.o, { notSent: true, reason: '보내지 않음 — 이번 요청의 시간 예산이 지나 이 묶음부터 보내지 않았습니다(다시 실행하세요 — 빠진 대상만 다시 만듭니다).' });
        break;
      }
      let results;
      try {
        // 늦은 회신(엣지 '결과 모름' 뒤): 같은 규칙으로 묶고, 묶지 못하면 끈다 — 잡 잠금은 이미 풀렸다(남긴 것: 그 사이 같은 대상 작업과 겹칠 수 있다)
        results = await onDirector(d.id, 'addJobs', { items: part.map((x) => x.item) }, { signal: AbortSignal.timeout(Math.max(1, left() - 60_000)), onLate: (lr) => { if (lr?.ok && Array.isArray(lr.value)) bind(part, lr.value).catch(() => {}); } });
      } catch (e) {
        const why = e?.code === 'unknown' ? `결과 모름 — 법인 엣지가 회신하지 않았습니다. 늦은 회신이 오면 원장에 반영합니다(잠시 뒤 목록을 다시 읽으세요). ${String(e?.message || '').slice(0, 200)}` : String(e?.message || e).slice(0, 300);
        for (const x of part) { x.o.reason = why; if (e?.code === 'unknown' || MID_COMMAND_CODES.has(e?.code)) x.o.unknown = true; }
        if (MID_COMMAND_CODES.has(e?.code)) for (const x of part) unsure.push(x);   // 중앙 직접 세션이 명령 도중 끊김(엣지 '결과 모름' 은 늦은 회신이 처리한다)
        for (const x of ready.slice(i + REREGISTER_BATCH)) Object.assign(x.o, { notSent: true, reason: '보내지 않음 — 앞 묶음이 실패해 멈췄습니다(다시 실행하세요).' });
        break;
      }
      await bind(part, results);
    }
    // v2.847 E2-1(2회차 점검 — 재현): 명령 도중 끊긴 항목은 Director 에 잡이 생겼을 수 있다. 실패로 적으면 그 행은 다시 묶이지 않고(다음 '빠진 대상' 에서도 사라짐)
    //   옛 카탈로그 jobid 기준이 남았다. 원장 이름 그대로 만든 항목(exactName)은 `.jobs` 한 번으로 가린다 — 지금 있으면 우리가 만든 것(바로 앞에서 '없음' 을 읽었다).
    const exactUnsure = unsure.filter((x) => x.exactName);
    if (exactUnsure.length && left() > 30_000) {
      let have = null;
      try { const r = await onDirector(d.id, 'jobNames', {}, { signal: AbortSignal.timeout(left() - 10_000) }); const n = (Array.isArray(r?.names) ? r.names : []).map(String); if (n.length) have = new Set(n); } catch { /* 결과 모름 그대로 */ }
      if (have) {
        const list = [];
        for (const x of exactUnsure) {
          if (have.has(x.exactName)) {
            Object.assign(x.o, { name: x.exactName, unknown: false, reason: undefined });
            list.push({ id: x.o.id, bareosJob: x.exactName, client: x.site.client, storage: x.site.storage, pool: x.site.pool, vmName: x.vm.name, dc: x.vm.vcDcPath, folder: x.vm.folderPath });
          } else Object.assign(x.o, { unknown: false, reason: '만들어지지 않았습니다 — 명령 도중 연결이 끊겼고 Director 에 그 잡이 없습니다(다시 등록하세요).' });
        }
        await bindList(list);
      }
    }
    return { results: out, generation };
  } finally { for (const id of locked) unlockJob(id); }
}

export { RESERVED_CONSOLES };
export const _directorById = (id) => directorById(id, effectiveSettings());
