/**
 * bareos/rehearsal.js — Bareos 복원 검증(리허설) — v2.862(사용자 결정 ⓔ '주 1회 · 법인마다 3대 · 성공한 검증용 VM 은 지우고 실패는 남김' · 시안 ⑫ · docs/design/bareos-ui-v2 §11).
 *
 * 백업이 '성공' 이어도 복원해서 켜지는지는 모른다(커뮤니티에서 가장 많이 나온 요구 — Veeam SureBackup 과 같은 생각). 정해진 요일 · 시각에 법인(Director)마다
 * 백업 대상 몇 대를 **새 VM**(이름 '{원래}-verify-YYYYMMDD' · 꺼진 채)으로 복원하고, 복원이 끝나면 vmclone 'bareos-verify' 가
 * NIC 를 모두 끊고(확인 못 하면 켜지 않는다) → 켜기 → VMware Tools 응답 → 끄기 → (성공이고 설정이면) 지우기를 한다(restoreFinish.js).
 *
 * 규칙:
 *  · 기본은 **꺼짐** — 켜려면 전체 범위 관리자가 정책을 저장(본인 OTP)한다. 검증은 VM 을 만들고 데이터스토어를 쓴다(사용자 결정의 주기 · 대수는 기본값으로 채워 둔다).
 *  · 고르기: 그 Director 의 활성 대상 중 마지막 백업이 성공(정상 · 경고)이고 진행 중 복원이 없는 것 — 가장 오래 검증하지 않은 순서(돌아가며).
 *  · 판정 · 보내기는 묶음 복원과 같은 길(bulkRestorePlan — 이름 겹침 · 데이터스토어 여유 · ops.restores 세션 하나). 하나라도 막히면 그 VM 만 뺀다(자동 작업이라 나머지는 보낸다).
 *  · 회차는 **보내기 전에** 기록한다(그 주 그 법인은 한 번 — 재시작 · 실패로 같은 주에 다시 돌지 않는다 · 백업 그룹 러너와 같은 규칙).
 *  · 중앙 전용(엣지는 기동하지 않는다). 인증 정지된 Director 는 주기 실행에서 건너뛴다(trigger 'timer').
 * 상태 파일: CONFIG_DIR/bareos-rehearsal.json(정책 — 비밀 없음) · bareos-rehearsal-state.json(회차 · 마지막 검증 시각 · 최근 결과 20건).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { listJobs, addRestore, inBatch, restoreOpen } from './registry.js';
import { loadSettings, jobDirectorId, directorById } from './settings.js';
import { bulkRestorePlan, placementDrift } from './restore.js';
import { capacityShortfall } from '../vmclone/capacity.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { noteRestoreBatchStart, noteRestoreBatchEnd } from './inflight.js';
import { logAudit } from '../audit.js';

export const TICK_MS = 60_000;
export const PER_CORP_MAX = 10;
const RUNS_KEEP = 20;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULTS = Object.freeze({ enabled: false, weekday: 6, time: '03:17', perCorp: 3, deleteOnOk: true, datastores: {} });
registerStateFile('bareos-rehearsal-state.json');
const FILE = () => path.join(config.configDir, 'bareos-rehearsal.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const STATE_FILE = () => path.join(config.configDir, 'bareos-rehearsal-state.json');
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const isEdge = () => !!(config.agent?.centralUrl && config.agent?.centralToken);
const DS_RE = /^[^"\\:;@\r\n\0]{1,80}$/;

let _cfg = null; const _loadErr = makeLoadError();
let _state = null; let _busy = false; let _timer = null; let _stateBad = '';

/** 정책 정규화 — 틀린 값은 거부(조용히 기본값으로 바꾸지 않는다). */
export function normPolicy(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const weekday = Number(b.weekday ?? DEFAULTS.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw fail('invalid', '요일은 0(일)~6(토) 중 하나로 고르세요.');
  const time = String(b.time ?? DEFAULTS.time);
  if (!TIME_RE.test(time)) throw fail('invalid', '시각은 HH:MM(00:00~23:59)으로 적으세요.');
  const perCorp = Number(b.perCorp ?? DEFAULTS.perCorp);
  if (!Number.isInteger(perCorp) || perCorp < 1 || perCorp > PER_CORP_MAX) throw fail('invalid', `법인마다 1~${PER_CORP_MAX}대 사이로 고르세요.`);
  const datastores = {};
  const ds = b.datastores && typeof b.datastores === 'object' && !Array.isArray(b.datastores) ? b.datastores : {};
  for (const [vc, name] of Object.entries(ds).slice(0, 200)) {
    const v = String(name || '').trim();
    if (!v) continue;
    if (!DS_RE.test(v)) throw fail('invalid', `데이터스토어 이름 ‘${v.slice(0, 40)}’ 이(가) 올바르지 않습니다.`);
    datastores[String(vc).slice(0, 200)] = v;
  }
  return { enabled: b.enabled === true, weekday, time, perCorp, deleteOnOk: b.deleteOnOk !== false, datastores };
}

export function loadPolicy() {
  if (_cfg) return _cfg;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _cfg = { ...normPolicy(p), savedBy: String(p.savedBy || '').slice(0, 64), savedAt: Number.isFinite(p.savedAt) ? p.savedAt : null };
      _loadErr.clear();
      return _cfg;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 복원 검증 정책을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다(돌리지 않고 저장을 막습니다).`);
  }
  _cfg = { ...DEFAULTS, datastores: {}, savedBy: '', savedAt: null };
  _loadErr.checkCorruptOnly(FILE());
  return _cfg;
}
export function policyLoadError() { loadPolicy(); return _loadErr.get(); }

/** 저장(전체 범위 관리자 · 본인 OTP — 라우트가 정한다). 못 읽은 정책 위에는 쓰지 않는다. */
export function savePolicy(body, { by = '', now = Date.now() } = {}) {
  if (policyLoadError()) throw fail('unreadable', '복원 검증 정책 파일을 읽지 못해 저장하지 않습니다 — 손상본을 확인하세요.');
  const next = { ...normPolicy(body), savedBy: String(by || '').slice(0, 64), savedAt: now };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { ...next };
}

function state() {
  if (_state) return _state;
  try { _state = fs.existsSync(STATE_FILE()) ? JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) : {}; } catch (e) {
    // 반증 F2: 조용히 비우면 오늘 회차 기록이 사라져 같은 날 다시 돈다 — 보존하고 이 프로세스에서는 검증을 멈춘다(재시작하면 새 상태로)
    preserveCorrupt(STATE_FILE(), e?.message); _stateBad = '복원 검증 상태 파일이 손상돼 보존했습니다 — 같은 날 두 번 돌지 않게 이 프로세스에서는 검증을 멈췄습니다(재시작하면 새로 시작)';
    console.warn(`[bareos] ${_stateBad}`); _state = {};
  }
  if (!_state || typeof _state !== 'object' || Array.isArray(_state)) _state = {};
  if (!_state.weeks || typeof _state.weeks !== 'object') _state.weeks = {};
  if (!_state.lastAt || typeof _state.lastAt !== 'object') _state.lastAt = {};
  if (!Array.isArray(_state.runs)) _state.runs = [];
  return _state;
}
function saveState() {
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(_state), { mode: 0o600 }); } catch (e) { console.warn(`[bareos] 복원 검증 상태를 저장하지 못했습니다(${e?.message || e})`); }
}
export function _resetRehearsalForTest() { _cfg = null; _state = null; _busy = false; _stateBad = ''; _loadErr.clear(); }
/** 지금 돌고 있는가(라우트가 OTP 를 쓰기 전에 본다 — 반증 F9). */
export const rehearsalBusy = () => _busy;

/** 포탈 시각의 요일 · 날짜 · 분(순수). */
export function clockOf(now = Date.now()) {
  const d = new Date(Number(now) + DAY_OFFSET_MIN * 60_000);
  return { day: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** 이 Director 가 지금 돌 차례인가(순수) — 정한 요일 · 시각이 지났고 오늘(그 요일) 아직 돌지 않았다. */
export function dueOf(policy, lastDay, now = Date.now()) {
  if (!policy?.enabled) return false;
  const c = clockOf(now);
  const [h, m] = String(policy.time || '').split(':').map(Number);
  if (c.weekday !== policy.weekday || c.minutes < h * 60 + m) return false;
  return lastDay !== c.day;
}
/** 검증용 VM 이름(날짜 — 실패한 검증용 VM 을 남겨도 다음 회차와 겹치지 않게). */
export const verifyName = (vmName, day) => {
  // 반증 F3(재현): 끝을 자르면 80자 VM 은 원래 이름과 같아지고 65~79자는 날짜가 잘려 매주 같은 이름이 됐다 — 날짜 꼬리를 지키고 원래 이름 쪽을 자른다
  const tail = `-verify-${String(day).replace(/-/g, '')}`;
  return `${String(vmName).slice(0, 80 - tail.length)}${tail}`;
};

/**
 * 고르기(순수) — 그 Director 의 활성 대상 중 마지막 백업이 성공이고 진행 중 복원이 없는 것, 가장 오래 검증하지 않은 순서로 n 대.
 * @param {object[]} jobs 원장
 * @param {(job)=>string} dirOf
 * @param {Record<string, number>} lastAt  대상 id → 마지막 검증 시각
 * @param {(job)=>any} driftOf  등록 뒤 위치 바뀜(인벤토리 — placementDrift. 원장에는 drift 칸이 없다 · 반증 F8)
 */
export function pickCandidates(jobs, dirId, n, dirOf, lastAt = {}, driftOf = () => null) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((j) => dirOf(j) === dirId && j.enabled !== false && !j.missingInDirector && !driftOf(j)
      && (j.lastRun?.state === 'ok' || j.lastRun?.state === 'warning') && Number.isInteger(j.lastRun?.jobid) && j.lastRun.jobid > 0
      && !(j.restores || []).some(restoreOpen))
    .sort((a, b) => ((lastAt[a.id] || 0) - (lastAt[b.id] || 0)) || String(a.vmName).localeCompare(String(b.vmName)))
    .slice(0, n);
}

/**
 * 한 법인(Director) 검증 한 회차 — 보내기 전에 회차를 기록하고 ops.restores 로 보낸다. 끝난 복원의 켜 보기는 restoreFinish.js.
 * @returns {Promise<{ ok:boolean, runId:string, started:number, items:object[], reason?:string }>}
 */
export async function runRehearsal(dirId, { trigger = 'timer', by = 'rehearsal', now = Date.now() } = {}) {
  const policy = loadPolicy();
  const settings = effectiveSettings();
  const st = state();
  if (_stateBad) throw fail('unavailable', _stateBad);
  const day = clockOf(now).day;
  const runId = `rv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // 반증 F3: 기동 직후 빈 인벤토리(initial)에서는 이름 겹침 검사가 비어 통과한다 — 회차를 차지하지 않고 미룬다(다음 틱에 다시)
  const snap = store.get();
  if (!snap || snap.initial || !(snap.vms || []).length) return { ok: false, started: 0, deferred: true, runId, items: [], reason: '인벤토리 수집 전이라 미뤘습니다(다음 확인에서 다시)' };
  st.weeks[dirId] = day;   // 보내기 전에 회차를 차지하고 **파일에 남긴다**(반증 F2 — 메모리에만 두면 송신 중 재시작에 같은 날 다시 돌았다)
  saveState();
  const jobs = listJobs();
  const dirOf = (j) => jobDirectorId(j, settings);
  const vmById = new Map((snap.vms || []).map((v) => [v.id, v]));
  const picked0 = pickCandidates(jobs, dirId, policy.perCorp, dirOf, st.lastAt, (j) => placementDrift(j, vmById.get(j.vmId)));
  const run = { id: runId, directorId: dirId, at: now, trigger, items: [] };
  const finishRun = (r) => { run.reason = r.reason || ''; st.runs = [run, ...st.runs].slice(0, RUNS_KEEP); saveState(); return { ...r, runId, items: run.items }; };
  // 반증 F5: 데이터스토어를 정하지 않으면(백업 당시 자리) 복원 판정이 여유를 보지 않는다 — 사람이 보지 않는 정기 작업이라 VM 의 홈 데이터스토어(첫 디스크)
  //   여유를 직접 본다. 모르면(디스크 정보 · 여유 · 용량을 못 읽음) 그 VM 은 건너뛴다(막지도 통과로 단정하지도 않는 대화형과 달리 — 자동 작업은 보내지 않는 쪽).
  const dsUse = new Map();
  const picked = [];
  for (const j of picked0) {
    if (policy.datastores[j.vcenterId]) { picked.push(j); continue; }   // 정한 DS 는 bulkRestorePlan 이 합산 검사
    const vm = vmById.get(j.vmId);
    const home = String(vm?.dev?.disks?.[0]?.datastore || '');
    const ds = home ? (snap.datastores || []).find((x) => String(x.vcenterId) === String(j.vcenterId) && x.name === home) : null;
    const need = Number(vm?.storageGB); const free = Number(ds?.freeGB); const cap = Number(ds?.capacityGB);
    if (!ds || !Number.isFinite(need) || need < 0 || vm?.storageGB == null || !Number.isFinite(free) || ds?.freeGB == null) {
      run.items.push({ jobId: j.id, vmName: j.vmName, ok: false, reason: '홈 데이터스토어 · 여유 · VM 용량을 읽지 못해 건너뛰었습니다(가득 차면 그 위의 VM 이 멈춥니다)' });
      continue;
    }
    const key = `${j.vcenterId}\u0000${home}`;
    const used = (dsUse.get(key) || 0) + need;
    const GIB = 1024 ** 3;
    if (capacityShortfall({ free: free * GIB, capacity: Number.isFinite(cap) && ds?.capacityGB != null ? cap * GIB : null, need: used * GIB })) {
      run.items.push({ jobId: j.id, vmName: j.vmName, ok: false, reason: `홈 데이터스토어 ‘${home}’ 여유가 부족해 건너뛰었습니다` });
      continue;
    }
    dsUse.set(key, used);
    picked.push(j);
  }
  if (!picked.length) return finishRun({ ok: true, started: 0, reason: run.items.length ? '보낼 수 있는 대상이 없습니다(여유 · 정보 부족으로 건너뜀)' : '검증할 대상이 없습니다(마지막 백업이 성공한 활성 대상 없음)' });
  // 판정은 묶음 복원과 같은 함수 — 이름 겹침 · 여유 · 덮어쓰기 없음(새 VM 만)
  const reserved = new Set();
  for (const j of jobs) for (const r of j.restores || []) if (r.mode === 'newVm' && r.target?.name) reserved.add(`${j.vcenterId}\u0000${String(r.target.name).toLowerCase()}`);
  const byId = new Map(picked.map((j) => [j.id, j]));
  const plan = bulkRestorePlan({
    items: picked.map((j) => ({ id: j.id, jobid: j.lastRun.jobid, mode: 'newVm', nic: 'disconnect', newVm: { name: verifyName(j.vmName, day), ...(policy.datastores[j.vcenterId] ? { datastore: policy.datastores[j.vcenterId] } : {}) } })),
    jobOf: (id) => byId.get(id) || null, dirOf, snapshot: store.get(), pluginName: settings.defaults.pluginName, reservedNames: reserved,
  });
  // v2.863: 정한 데이터스토어의 여유 판정이 '모름'(여유 · VM 용량을 못 읽음)이면 대화형 묶음 복원은 경고만 하지만, 사람이 보지 않는 정기 작업은
  //   보내지 않는다(홈 데이터스토어 경로와 같은 규칙 — 반증 F5). 정책 화면에서 데이터스토어를 고를 수 있게 되면서 이 경로가 열렸다.
  const unknownCap = new Set((plan.capacity || []).filter((c) => c.verdict === 'unknown').flatMap((c) => c.ids || []));
  const ready = plan.items.filter((x) => x.ok && !unknownCap.has(x.id));
  for (const x of plan.items.filter((y) => !y.ok)) run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: x.issue });
  for (const x of plan.items.filter((y) => y.ok && unknownCap.has(y.id))) run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: `정한 데이터스토어 ‘${x.plan?.target?.datastore || '?'}’ 의 여유 · VM 용량을 읽지 못해 건너뛰었습니다(정기 작업은 모르면 보내지 않습니다)` });
  if (!ready.length) return finishRun({ ok: false, started: 0, reason: '보낼 수 있는 대상이 없습니다(판정에서 모두 막힘)' });
  noteRestoreBatchStart(runId, `복원 검증 ${ready.length}대 · ${directorById(dirId, settings)?.name || dirId}`);
  try {
    const sendItems = ready.map((x, i) => {
      const job = byId.get(x.id);
      const site = settings.sites.find((s) => s.vcenterId === job.vcenterId);
      return { key: i, jobid: x.jobid, name: job.bareosJob, client: site?.client || job.client, restoreJob: settings.defaults.restoreJob, pluginOptions: x.plan.pluginOptions };
    });
    let out;
    try { out = await onDirector(dirId, 'restores', { items: sendItems }, { trigger }); } catch (e) {
      const why = String(e?.message || e).slice(0, 300);
      for (const x of ready) run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: e?.unknown || e?.code === 'unknown' ? `결과 모름 — ${why}` : why });
      logAudit({ user: by, action: 'Bareos 복원 검증', target: directorById(dirId, settings)?.name || dirId, detail: `실패 — ${why}` });
      return finishRun({ ok: false, started: 0, reason: why });
    }
    const byKey = new Map((Array.isArray(out) ? out : []).map((x) => [x.key, x]));
    let started = 0;
    try {
    inBatch(() => {
      ready.forEach((x, i) => {
        const r = byKey.get(i);
        const job = byId.get(x.id);
        if (r?.ok) {
          addRestore(job.id, { jobid: r.rid, fromJobids: r.chain, mode: 'newVm', target: x.plan.target, by, client: sendItems[i].client, batchId: runId, nic: 'disconnect', verify: true, deleteOnOk: policy.deleteOnOk, rehearsal: runId });
          st.lastAt[job.id] = now;
          started += 1;
          run.items.push({ jobId: job.id, vmName: job.vmName, ok: true, rid: r.rid, name: x.plan.target.name });
        } else {
          run.items.push({ jobId: job.id, vmName: job.vmName, ok: false, reason: r?.message || 'Director 회신에 없음 — 결과 모름' });
        }
      });
    });
    } catch (e) {
      // 원장 저장 실패 — 복원은 이미 시작됐다(묶음 라우트와 같은 처리 · 반증 F2 계열)
      console.warn(`[bareos] 복원 검증 ${runId} 원장 저장 실패: ${e?.message || e}`);
      run.reason = `원장 저장 실패 — 시작한 검증 복원의 끝맺음(끊기 · 켜 보기 · 지우기)이 돌지 않을 수 있습니다. vCenter 에서 '-verify-' VM 을 확인하세요`;
    }
    logAudit({ user: by, action: 'Bareos 복원 검증', target: directorById(dirId, settings)?.name || dirId, detail: `회차 ${runId} · 시작 ${started} / ${ready.length}대${trigger === 'timer' ? ' · 정기' : ' · 지금 검증'}` });
    return finishRun({ ok: started > 0, started, ...(run.reason ? { reason: run.reason } : {}) });
  } finally { noteRestoreBatchEnd(runId); }
}

/** 화면용 — 정책 · 최근 회차(법인 범위는 부르는 쪽이 거른다). */
export function rehearsalStatus() {
  const st = state();
  return { policy: { ...loadPolicy() }, loadError: !!policyLoadError(), runs: st.runs.map((r) => ({ ...r, items: r.items.map((x) => ({ ...x })) })), weeks: { ...st.weeks } };
}

/** 틱 — 차례인 Director 를 하나씩(재진입 가드 · 엣지 제외). */
export async function tick(now = Date.now()) {
  if (_busy) return null;
  _busy = true;
  try {
    const policy = loadPolicy();
    if (policyLoadError() || !policy.enabled) return null;
    state();
    if (_stateBad) return null;
    const settings = isDemoActive() ? effectiveSettings() : loadSettings();
    const st = state();
    const out = [];
    for (const d of settings.directors || []) {
      if (!dueOf(policy, st.weeks[d.id], now)) continue;
      try { out.push(await runRehearsal(d.id, { trigger: 'timer', now })); } catch (e) { console.warn(`[bareos] ‘${d.name}’ 복원 검증 실패: ${e?.message || e}`); }
    }
    return out;
  } finally { _busy = false; }
}
/** '지금 검증'(전체 범위 관리자 · OTP — 라우트). 다른 회차가 돌면 기다리지 않고 거절한다. */
export async function runNow(dirId, { by = '' } = {}) {
  if (_busy) throw fail('busy', '다른 복원 검증이 진행 중입니다 — 끝난 뒤 다시 누르세요.');
  _busy = true;
  try { return await runRehearsal(dirId, { trigger: 'manual', by }); } finally { _busy = false; }
}

export function startRehearsal() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch((e) => console.warn(`[bareos] 복원 검증 틱 실패: ${e?.message || e}`)); }, TICK_MS);
  _timer.unref?.();
}
