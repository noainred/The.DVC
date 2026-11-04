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
 * 상태 파일: CONFIG_DIR/bareos-rehearsal.json(정책 — 비밀 없음) · bareos-rehearsal-state.json(회차 · 마지막 검증 · 시도 시각 · Director 마다 최근 결과 RUNS_PER_DIR 건 — v2.874).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { listJobs, addRestore, inBatch, restoreHeld, registryLoadError } from './registry.js';
import { targetsNow } from '../vmclone/opDispatch.js';
import { onDemandVcBlock } from '../vcenter/dsBrowse.js';
import { loadVcenterConfig } from '../config.js';
import { getDataSource } from '../runtime-settings.js';
import { tryLockJob, unlockJob } from './jobLocks.js';
import { loadSettings, jobDirectorId, directorById } from './settings.js';
import { bulkRestorePlan, placementDrift } from './restore.js';
import { capacityShortfall } from '../vmclone/capacity.js';
import { onDirector, isDemoActive, effectiveSettings, isEdgeNode } from './service.js';
import { noteRestoreBatchStart, noteRestoreBatchEnd } from './inflight.js';
import { RESTORES_DEADLINE_MS } from './edgeOps.js';
import { logAudit } from '../audit.js';

export const TICK_MS = 60_000;
export const PER_CORP_MAX = 10;
/** v2.874(점검 B4-03 — 재현): 전 법인 공용 20건이면 28 법인 틱 한 번에 앞 8 법인 기록이 사라졌다 — Director 마다 최근 k건. */
export const RUNS_PER_DIR = 4;
/** 회차 하나에 남기는 항목 상한(건너뜀 사유가 길게 쌓여 상태 파일이 커지지 않게 — 넘친 수는 moreItems). */
const RUN_ITEMS_MAX = 30;
/** v2.874(B4-01): 판정에서 막힌 VM 을 건너뛰고 다음 후보로 채울 때 더 볼 후보 수(고정 상한 — 요청 경로 아닌 정기 작업이지만 계산을 묶어 둔다). */
const EXTRA_TRIES = 30;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULTS = Object.freeze({ enabled: false, weekday: 6, time: '03:17', perCorp: 3, deleteOnOk: true, datastores: {} });
registerStateFile('bareos-rehearsal-state.json');
const FILE = () => path.join(config.configDir, 'bareos-rehearsal.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const STATE_FILE = () => path.join(config.configDir, 'bareos-rehearsal-state.json');
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const isEdge = () => isEdgeNode();   // v2.874 B4-11 판정은 service.js 하나
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
  if (!_state.triedAt || typeof _state.triedAt !== 'object') _state.triedAt = {};
  if (!Array.isArray(_state.runs)) _state.runs = [];
  return _state;
}
/** v2.874(점검 B4-09): 성공 여부를 돌려준다 — 회차 차지 저장이 실패하면 보내지 않는다(반증 F2 의 '보내기 전 파일 기록' 보장). */
function saveState() {
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(_state), { mode: 0o600 }); return true; } catch (e) { console.warn(`[bareos] 복원 검증 상태를 저장하지 못했습니다(${e?.message || e})`); return false; }
}
/** Director 마다 최근 k건(순수 — 앞이 최신). */
export function keepRunsPerDir(runs, k = RUNS_PER_DIR) {
  const n = new Map();
  return (Array.isArray(runs) ? runs : []).filter((r) => { const d = String(r?.directorId || ''); const c = (n.get(d) || 0) + 1; n.set(d, c); return c <= k; });
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
      && !(j.restores || []).some((r) => restoreHeld(r)))
    .sort((a, b) => ((lastAt[a.id] || 0) - (lastAt[b.id] || 0)) || String(a.vmName).localeCompare(String(b.vmName)))
    .slice(0, n);   // v2.874(B4-01): runRehearsal 은 n 을 넉넉히 받아 판정을 지난 것으로 perCorp 대를 채운다(판정 전에 자르면 막힌 VM 이 앞을 영구 점유)
}

/**
 * v2.874(점검 B3-03): 복원이 끝난 뒤 끝맺음(NIC 끊기 · 켜 보기 · 지우기)을 돌릴 수 있는 vCenter 인가 — 실행 위치가 정해지고(conflict · none 아님),
 *   중앙 직접이면 로그인 전에 막는 사유(위임 · 꺼짐 · 점검중 · 인증 정지 — onDemandVcBlock)가 없어야 한다. 사람이 보지 않는 정기 작업은
 *   끝맺음이 실패할 것을 알면 보내지 않는다(끊기 실패 검증 VM 이 매주 쌓였다). 데모는 vsOps 가 흉내 내므로 실행 위치만 본다.
 * @returns {(vcenterId:string) => string}  막는 사유('' = 보낼 수 있음)
 */
export function finishBlockOf() {
  let tg = null;
  try { tg = targetsNow().targets; } catch (e) { const why = `끝맺음 실행 위치를 정하지 못했습니다(${String(e?.message || e).slice(0, 120)})`; return () => why; }
  let mock = false; try { mock = getDataSource() === 'mock'; } catch { /* live */ }
  const vcs = new Map(((() => { try { return loadVcenterConfig().vcenters || []; } catch { return []; } })()).map((v) => [String(v.id), v]));
  const memo = new Map();
  return (vcenterId) => {
    const k = String(vcenterId);
    if (memo.has(k)) return memo.get(k);
    const t = tg.get(k);
    let why = '';
    if (!t || t.where === 'conflict' || t.where === 'none') why = `끝맺음(네트워크 끊기 · 켜 보기)을 돌릴 곳을 정할 수 없어 건너뛰었습니다${t?.reason ? ` — ${t.reason}` : ''}`;
    else if (t.where === 'local' && !mock) {
      const vc = vcs.get(k);
      const b = vc ? onDemandVcBlock(vc) : { reason: '이 vCenter 의 등록 정보를 찾을 수 없습니다' };
      if (b) why = `끝맺음(네트워크 끊기 · 켜 보기)을 위해 vCenter 에 로그인할 수 없어 건너뛰었습니다 — ${b.reason}`;
    }
    memo.set(k, why);
    return why;
  };
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
  // v2.874(점검 B4-08): 원장을 못 읽으면 대상 · 진행 중 복원을 모른다 — 회차를 차지하지 않고 미룬다('검증할 대상 없음' 으로 확정 기록하지 않는다)
  if (registryLoadError()) return { ok: false, started: 0, deferred: true, runId, items: [], reason: '백업 대상 원장을 읽지 못해 미뤘습니다(손상본 보존 · 서비스 점검에서 확인)' };
  const prevDay = st.weeks[dirId];
  st.weeks[dirId] = day;   // 보내기 전에 회차를 차지하고 **파일에 남긴다**(반증 F2 — 메모리에만 두면 송신 중 재시작에 같은 날 다시 돌았다)
  if (!saveState()) {   // v2.874(B4-09): 남기지 못하면 보내지 않는다(재시작하면 같은 날 다시 돈다) — 메모리 차지도 되돌려 다음 틱에 다시 시도
    if (prevDay === undefined) delete st.weeks[dirId]; else st.weeks[dirId] = prevDay;
    return { ok: false, started: 0, deferred: true, runId, items: [], reason: '복원 검증 상태 파일을 쓰지 못해 보내지 않았습니다(같은 날 두 번 돌지 않게) — 디스크 · 권한을 확인하세요' };
  }
  const jobs = listJobs();
  const dirOf = (j) => jobDirectorId(j, settings);
  const vmById = new Map((snap.vms || []).map((v) => [v.id, v]));
  const run = { id: runId, directorId: dirId, at: now, trigger, items: [] };
  const finishRun = (r) => {
    run.reason = r.reason || '';
    if (run.items.length > RUN_ITEMS_MAX) { run.moreItems = run.items.length - RUN_ITEMS_MAX; run.items = [...run.items.filter((x) => x.ok), ...run.items.filter((x) => !x.ok)].slice(0, RUN_ITEMS_MAX); }
    st.runs = keepRunsPerDir([run, ...st.runs]);   // v2.874 B4-03
    saveState();
    // v2.874(점검 B4-02): 0대 회차도 감사에 한 줄 — 정기 작업이 아무것도 하지 않은 것을 화면 밖에서도 알 수 있게(무음 실패 금지)
    const { audited, ...rest } = r;
    if (!(r.started > 0) && !audited) logAudit({ user: by, action: 'Bareos 복원 검증', target: directorById(dirId, settings)?.name || dirId, detail: `회차 ${runId} · 시작 0대 — ${String(r.reason || '').slice(0, 200)}${trigger === 'timer' ? ' · 정기' : ' · 지금 검증'}` });
    return { ...rest, runId, items: run.items };
  };
  // v2.874(점검 B4-01 — 재현): 판정 전에 n 대로 자르면 늘 막히는 VM(빠듯한 홈 데이터스토어 등)이 앞자리를 영구히 차지해 매주 0대였다 —
  //   순서대로 판정해 통과한 것으로 perCorp 대를 채우고(후보 상한 EXTRA_TRIES), 건너뛴 VM 은 시도 시각(triedAt)을 남겨 다음 회차에 뒤로 보낸다.
  const order = { ...st.lastAt };
  for (const [id, t] of Object.entries(st.triedAt || {})) if ((Number(t) || 0) > (order[id] || 0)) order[id] = Number(t) || 0;
  const cands = pickCandidates(jobs, dirId, policy.perCorp + EXTRA_TRIES, dirOf, order, (j) => placementDrift(j, vmById.get(j.vmId)));
  const skip = (j, reason) => { run.items.push({ jobId: j.id, vmName: j.vmName, ok: false, reason }); st.triedAt[j.id] = now; };
  const finishBlock = finishBlockOf();
  // 판정은 묶음 복원과 같은 함수 — 이름 겹침 · 여유 · 덮어쓰기 없음(새 VM 만)
  const reserved = new Set();
  for (const j of jobs) for (const r of j.restores || []) if (r.mode === 'newVm' && r.target?.name) reserved.add(`${j.vcenterId}\u0000${String(r.target.name).toLowerCase()}`);
  const baseOf = (job) => { const site = settings.sites.find((x) => String(x.vcenterId) === String(job.vcenterId)); return { vcserver: site?.vcserver || '', configFile: site?.configFile || '' }; };   // v2.866 복원 기본 키
  const planOf = (list) => {
    const byId = new Map(list.map((j) => [j.id, j]));
    return bulkRestorePlan({
      items: list.map((j) => ({ id: j.id, jobid: j.lastRun.jobid, mode: 'newVm', nic: 'disconnect', newVm: { name: verifyName(j.vmName, day), ...(policy.datastores[j.vcenterId] ? { datastore: policy.datastores[j.vcenterId] } : {}) } })),
      jobOf: (id) => byId.get(id) || null, dirOf, snapshot: snap, pluginName: settings.defaults.pluginName, reservedNames: reserved, baseOf,
    });
  };
  // 반증 F5: 데이터스토어를 정하지 않으면(백업 당시 자리) 복원 판정이 여유를 보지 않는다 — 사람이 보지 않는 정기 작업이라 VM 의 홈 데이터스토어(첫 디스크)
  //   여유를 직접 본다. 모르면(디스크 정보 · 여유 · 용량을 못 읽음) 그 VM 은 건너뛴다(막지도 통과로 단정하지도 않는 대화형과 달리 — 자동 작업은 보내지 않는 쪽).
  const dsUse = new Map();
  const GIB = 1024 ** 3;
  const chosen = [];
  for (const j of cands) {
    if (chosen.length >= policy.perCorp) break;
    const fb = finishBlock(j.vcenterId);
    if (fb) { skip(j, fb); continue; }
    let homeKey = ''; let homeNeed = 0;
    if (!policy.datastores[j.vcenterId]) {
      const vm = vmById.get(j.vmId);
      const home = String(vm?.dev?.disks?.[0]?.datastore || '');
      const ds = home ? (snap.datastores || []).find((x) => String(x.vcenterId) === String(j.vcenterId) && x.name === home) : null;
      const need = Number(vm?.storageGB); const free = Number(ds?.freeGB); const cap = Number(ds?.capacityGB);
      if (!ds || !Number.isFinite(need) || need < 0 || vm?.storageGB == null || !Number.isFinite(free) || ds?.freeGB == null) { skip(j, '홈 데이터스토어 · 여유 · VM 용량을 읽지 못해 건너뛰었습니다(가득 차면 그 위의 VM 이 멈춥니다)'); continue; }
      homeKey = `${j.vcenterId}\u0000${home}`; homeNeed = need;
      const used = (dsUse.get(homeKey) || 0) + need;
      if (capacityShortfall({ free: free * GIB, capacity: Number.isFinite(cap) && ds?.capacityGB != null ? cap * GIB : null, need: used * GIB })) { skip(j, `홈 데이터스토어 ‘${home}’ 여유가 부족해 건너뛰었습니다`); continue; }
    }
    // 정한 DS 의 합산 여유 · 이름 겹침 · 기본 키 — 이 VM 을 더해도 앞서 고른 VM 이 모두 통과해야 넣는다
    const trial = planOf([...chosen, j]);
    const unknownCap = new Set((trial.capacity || []).filter((c) => c.verdict === 'unknown').flatMap((c) => c.ids || []));
    const mine = trial.items.find((x) => x.id === j.id);
    if (!mine?.ok) { skip(j, mine?.issue || '복원 판정에서 막혔습니다'); continue; }
    if (unknownCap.has(j.id)) { skip(j, `정한 데이터스토어 ‘${mine.plan?.target?.datastore || '?'}’ 의 여유 · VM 용량을 읽지 못해 건너뛰었습니다(정기 작업은 모르면 보내지 않습니다)`); continue; }
    const hurt = trial.items.find((x) => x.id !== j.id && !x.ok);
    if (hurt) { skip(j, hurt.issue || '함께 고른 VM 과 데이터스토어 여유가 겹쳐 건너뛰었습니다'); continue; }
    if (homeKey) dsUse.set(homeKey, (dsUse.get(homeKey) || 0) + homeNeed);
    chosen.push(j);
  }
  if (!chosen.length) return finishRun({ ok: !run.items.length, started: 0, reason: run.items.length ? '보낼 수 있는 대상이 없습니다(판정 · 여유 · 정보 부족 · 끝맺음 불가로 건너뜀)' : '검증할 대상이 없습니다(마지막 백업이 성공한 활성 대상 없음)' });
  const plan = planOf(chosen);
  const byId = new Map(chosen.map((j) => [j.id, j]));
  const ready0 = plan.items.filter((x) => x.ok);
  for (const x of plan.items.filter((y) => !y.ok)) { run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: x.issue }); st.triedAt[x.id] = now; }   // 위 판정과 같은 함수라 생기지 않아야 한다(방어)
  // v2.874(점검 B2-01): 대상 잠금(jobLocks — 실행 · 복원 · 삭제 · 그룹과 공용). 묶음 · 단건 복원이 같은 VM 을 보내는 중이면(아직 원장에 없다) 두 번 돌았다 —
  //   잡지 못한 VM 은 이번 회차에서 건너뛴다(자동 작업 — 기다리지 않는다). 잠금은 원장에 남긴 뒤 푼다.
  const locked = [];
  const ready = [];
  for (const x of ready0) {
    if (tryLockJob(x.id)) { locked.push(x.id); ready.push(x); } else run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: '이 대상의 다른 요청(실행 · 복원 · 삭제)을 처리하는 중이라 건너뛰었습니다' });
  }
  if (!ready.length) return finishRun({ ok: false, started: 0, reason: '보낼 수 있는 대상이 없습니다(판정에서 모두 막힘)' });
  noteRestoreBatchStart(runId, `복원 검증 ${ready.length}대 · ${directorById(dirId, settings)?.name || dirId}`);
  try {
    const sendItems = ready.map((x, i) => {
      const job = byId.get(x.id);
      const site = settings.sites.find((s) => s.vcenterId === job.vcenterId);
      return { key: i, jobid: x.jobid, name: job.bareosJob, client: site?.client || job.client, restoreJob: settings.defaults.restoreJob, pluginOptions: x.plan.pluginOptions };
    });
    let out;
    try { out = await onDirector(dirId, 'restores', { items: sendItems }, { trigger, signal: AbortSignal.timeout(RESTORES_DEADLINE_MS) }); } catch (e) {   // v2.870 감사 A5-01
      const why = String(e?.message || e).slice(0, 300);
      const unknown = !!e?.unknown || e?.code === 'unknown';
      for (const x of ready) run.items.push({ jobId: x.id, vmName: x.vmName, ok: false, reason: unknown ? `결과 모름 — ${why}` : why });
      // v2.874(점검 B5-01): 결과 모름은 원장에 남긴다 — 그 VM 을 다음 회차 · 사람의 복원이 다시 보내지 않게(restoreHeld · 이름 예약)
      if (unknown) { try { inBatch(() => ready.forEach((x, i) => addRestore(x.id, { unknown: true, mode: 'newVm', target: x.plan.target, by, client: sendItems[i].client, batchId: runId, nic: 'disconnect', verify: true, rehearsal: runId }))); } catch (e2) { console.warn(`[bareos] 복원 검증 ${runId} 결과 모름 기록 실패: ${e2?.message || e2}`); } }
      logAudit({ user: by, action: 'Bareos 복원 검증', target: directorById(dirId, settings)?.name || dirId, detail: `실패 — ${why}` });
      return finishRun({ ok: false, started: 0, reason: why, audited: true });
    }
    const byKey = new Map((Array.isArray(out) ? out : []).map((x) => [x.key, x]));
    let started = 0;
    try {
    inBatch(() => {
      ready.forEach((x, i) => {
        const r = byKey.get(i);
        const job = byId.get(x.id);
        if (r?.ok) {
          // v2.874(점검 B2-01): 원장에 못 넣었으면(그사이 대상이 지워짐) '시작' 으로 세지 않는다 — 끝맺음(끊기 · 켜 보기 · 지우기)이 돌지 않는다
          const rec = addRestore(job.id, { jobid: r.rid, fromJobids: r.chain, mode: 'newVm', target: x.plan.target, by, client: sendItems[i].client, batchId: runId, nic: 'disconnect', verify: true, deleteOnOk: policy.deleteOnOk, rehearsal: runId });
          st.lastAt[job.id] = now;
          if (rec) { started += 1; run.items.push({ jobId: job.id, vmName: job.vmName, ok: true, rid: r.rid, name: x.plan.target.name }); }
          else run.items.push({ jobId: job.id, vmName: job.vmName, ok: false, rid: r.rid, name: x.plan.target.name, reason: `복원(jobid ${r.rid})은 시작했지만 원장에서 대상이 사라져 끝맺음(끊기 · 켜 보기 · 지우기)이 돌지 않습니다 — vCenter 에서 ‘${x.plan.target.name}’ 을 확인하세요` });
        } else {
          const unknown = !r || r.code === 'unknown';
          // v2.874(점검 B5-01): 결과 모름은 원장에 남긴다(다시 보내지 않게)
          if (unknown) addRestore(job.id, { unknown: true, mode: 'newVm', target: x.plan.target, by, client: sendItems[i].client, batchId: runId, nic: 'disconnect', verify: true, rehearsal: runId });
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
    return finishRun({ ok: started > 0, started, audited: true, ...(run.reason ? { reason: run.reason } : {}) });
  } finally { noteRestoreBatchEnd(runId); for (const id of locked) unlockJob(id); }
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
