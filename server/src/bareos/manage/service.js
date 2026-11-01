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
import { onDirector, relayToEdge, isDemoActive, effectiveSettings, eligibility } from '../service.js';
import { listJobs, rebindJobs } from '../registry.js';
import { jobNameFor } from '../names.js';
import { morefOf } from '../../vcenter/registry.js';
import { tryLockJob, unlockJob } from '../jobLocks.js';
import { requestReconcile } from '../poller.js';
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

/** planManage 에 줄 '그 Director 의 지금 설정'(비밀 없음). */
export function knownFor(d, cfg, settings = effectiveSettings()) {
  const storages = okVal(cfg, 'storages');
  const prefer = storages.find((s) => s.name === 'File' && s.address) || storages.find((s) => s.address) || null;   // 반증 F9 — 주소가 빈 File 을 고르지 않는다
  return {
    config: { storages, consoles: okVal(cfg, 'consoles'), profiles: okVal(cfg, 'profiles') },
    portalConsole: d.consoleName || '',
    address: prefer?.address || '',
    mappedStorages: [...new Set((settings.sites || []).filter((s) => s.directorId === d.id).map((s) => s.storage).filter(Boolean))],
  };
}

/* ───────── 쓰기 · 디스크 읽기 ───────── */
/**
 * 입력 판정(라우트가 OTP 전에 부른다 — 입력 실수가 1회용 OTP 를 태우지 않게). 설정을 못 읽었으면 판정이 할 수 있는 만큼만(이름 겹침은 원격 파일 · bareos-dir -t 가 다시 막는다).
 */
export async function planFor(d, action, input) {
  let cfg = null;
  if (action !== 'scan') { try { cfg = await readConfig(d); } catch { cfg = null; } }
  const known = knownFor(d, cfg);
  return { plan: planManage(action, input, known), known, configRead: !!cfg };
}

/**
 * 실행. ssh = resolveSsh 결과 · accountPassword = 계정 비밀번호(생성은 라우트가) — 응답 · 감사 · 로그에 싣지 않는다.
 * @returns {Promise<object>} scan 이면 normScanResult · 쓰기면 { ok, files, restarted, reloaded, relay? }
 */
export async function runManage(d, { plan, known, input }, ssh, { accountPassword = '' } = {}) {
  if (isDemoActive()) return demo.applyDemo(d.id, plan, { accountPassword });
  const isScan = plan.action === 'scan';
  if (d.agent) {
    const kind = isScan ? 'setup.scan' : 'setup.manage';
    const secretArgs = { password: ssh.password, ...(accountPassword ? { accountPassword } : {}) };
    const v = await relayToEdge(d, kind, { body: { host: ssh.host, sshPort: ssh.sshPort, username: ssh.username }, action: plan.action, input: input || {}, known }, { secretArgs });
    return isScan ? normScanResult(v) : { ok: true, ...v, relay: d.agent };
  }
  const v = await applyManage(plan, { host: ssh.host, sshPort: ssh.sshPort, username: ssh.username, password: ssh.password }, { accountPassword }, { dirPort: d.port });
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
  const have = new Set((r?.names || []).map(String));
  return listJobs()
    .filter((j) => (demoNow ? j.demo : !j.demo) && jobDirectorId(j, settings) === d.id && !have.has(j.bareosJob))
    .map((j) => ({ id: j.id, vcenterId: j.vcenterId, vmId: j.vmId, vmName: j.vmName, bareosJob: j.bareosJob, schedule: j.schedule, level: j.level, enabled: j.enabled !== false }));
}

/**
 * 다시 등록 — 고른 대상 중 **지금 다시 읽은** 빠진 목록에 있는 것만(화면 목록을 믿지 않는다). 세션 하나로 addJobs → 원장 같은 행에 다시 묶기(rebindJobs).
 * 켜짐 · 스케줄 · 레벨은 원장 값 그대로(그룹 잡은 스케줄 없이) — 꺼 둔 대상은 다음 대조가 다시 끈다(부르는 쪽이 requestReconcile).
 * @returns {Promise<{ results: { id, vmName, ok, name?, reason? }[] }>}
 */
export async function reregisterTargets(d, ids = []) {
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
    const base = {
      jobDefs: settings.defaults.jobDefs, client: el.site.client, storage: el.site.storage, pool: el.site.pool,
      schedule: m.schedule || undefined, level: m.level, pluginOptions: el.plugin, description: `VMware Portal ${vm.name}`.replace(/[^\p{L}\p{N} ._-]/gu, ' '),
    };
    ready.push({ o, key: out.length - 1, item: { key: out.length - 1, vcenterId: vm.vcenterId, moref, base }, site: el.site });
  }
  try {
    if (!ready.length) return { results: out };
    const bind = async (results) => {
      const byKey = new Map((results || []).map((r) => [r.key, r]));
      const list = [];
      for (const x of ready) {
        const r = byKey.get(x.key);
        if (!r?.ok || !r.name) { x.o.reason = r?.message || (r?.ok ? 'Director 가 잡 이름 없이 성공을 회신했습니다.' : '사유 미상'); continue; }
        x.o.name = r.name;
        list.push({ id: x.o.id, bareosJob: r.name, client: x.site.client, storage: x.site.storage, pool: x.site.pool });
      }
      if (!list.length) return;
      let res;
      try { res = rebindJobs(list); } catch (e) { res = list.map((x) => ({ id: x.id, ok: false, err: e })); }
      const orphans = [];
      for (const r of res) {
        const o = out.find((y) => y.id === r.id);
        if (o) { o.ok = r.ok; if (!r.ok) o.reason = `Director 잡 ‘${o.name}’ 은 만들었지만 원장에 묶지 못했습니다(${String(r.err?.message || r.err).slice(0, 160)})`; }
        if (!r.ok) orphans.push(list.find((x) => x.id === r.id)?.bareosJob);
      }
      // 반증 F8: 원장에 묶지 못한 잡은 끈다(일반 등록의 orphanCleanup 과 같은 규칙 — 원장 밖 스케줄 잡이 켜진 채 남지 않게)
      if (orphans.filter(Boolean).length) {
        let off = new Set();
        try { off = new Set((await onDirector(d.id, 'disableJobs', { names: orphans.filter(Boolean) })).filter((x) => x.ok).map((x) => x.name)); } catch { /* 아래 문구 */ }
        for (const o of out) if (!o.ok && o.name && orphans.includes(o.name)) o.reason += off.has(o.name) ? ' — 그 잡은 비활성화했습니다.' : ' — 그 잡을 비활성화하지도 못했습니다(Director 에서 직접 정리하세요).';
      }
      requestReconcile(d.id);
    };
    let results;
    try {
      // 늦은 회신(엣지 '결과 모름' 뒤): 같은 규칙으로 묶고, 묶지 못하면 끈다 — 잡 잠금은 이미 풀렸다(남긴 것: 그 사이 같은 대상 작업과 겹칠 수 있다)
      results = await onDirector(d.id, 'addJobs', { items: ready.map((x) => x.item) }, { onLate: (lr) => { if (lr?.ok && Array.isArray(lr.value)) bind(lr.value).catch(() => {}); } });
    } catch (e) {
      const why = e?.code === 'unknown' ? `결과 모름 — 법인 엣지가 회신하지 않았습니다. 늦은 회신이 오면 원장에 반영합니다(잠시 뒤 목록을 다시 읽으세요). ${String(e?.message || '').slice(0, 200)}` : String(e?.message || e).slice(0, 300);
      for (const x of ready) x.o.reason = why;
      return { results: out };
    }
    await bind(results);
    return { results: out };
  } finally { for (const id of locked) unlockJob(id); }
}

export { RESERVED_CONSOLES };
export const _directorById = (id) => directorById(id, effectiveSettings());
