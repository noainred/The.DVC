/**
 * bareos/registry.js — 포탈의 Bareos 백업 대상 원장(v2.820). 파일: CONFIG_DIR/bareos-jobs.json (자격증명 없음 · 원자적 쓰기 · 손상 보존).
 *
 * job = {
 *   id, vcenterId, vmId, vmName, dc, folder,          // 등록 시점의 VM 위치(플러그인 옵션에 들어간 값 — 화면이 그대로 보인다)
 *   directorId,                                         // v2.823 등록 때의 법인 Director(잡은 그 Director 의 conf 에 있다 — 바꾸지 않는다. 옛 잡은 없음 → settings.jobDirectorId)
 *   bareosJob, client, storage, pool, schedule, level, // Director 에 만든 잡(이름은 names.jobNameFor)
 *   enabled, createdBy, createdAt, demo?,
 *   pending: { jobid, since, level, by, trigger } | null,   // 포탈이 실행했고 아직 끝나지 않은 백업
 *   cancelReq: { jobid, at, by, via:'single'|'group' } | null,   // v2.867 그 실행에 취소를 보냈다(판정은 cancelState.js — 지금 도는 실행일 때만 유효)
 *   lastRun: { jobid, status, state, level, startedAt, endedAt, bytes, files, errors, checkedAt } | null,
 *   lastError: { at, message } | null,
 *   missingInDirector: boolean,                         // Director `.jobs` 에 없으면 true(누가 conf 를 지웠다)
 *   restores: [ { jobid, fromJobids, mode, target, status, state, startedAt, endedAt, by, at, batchId?, nic?, finish? } ],   // 최근 RESTORES_KEEP 건
 *     v2.861 batchId(묶음 복원) · nic('disconnect'|'keep' — 새 VM 은 끊기가 기본) · finish{ nic:'pending'|'ok'|'failed'|'skipped', detail, at, opId?, tries? }
 *   finishedRuns: [ { jobid, status, state, level, startedAt, endedAt, bytes, errors, checkedAt } ],   // v2.858 startedAt·bytes 추가(그 전 항목에는 없다)
 *     // v2.822.3 끝난 백업 실행 최근 FINISHED_KEEP 건(실패 메일용)
 * }
 * retired = [ { name, directorId?, at, demo? } ]   // v2.822(I3): 원장에서 지운 대상의 Director 잡 이름 — 대조 틱이 다시 켜졌으면 disable 을 다시 보낸다
 *                                                  //   v2.823: (directorId, 이름)이 열쇠다 — 같은 이름이 다른 법인 Director 에 다시 생겨도 옛 Director 의 기록을 지우지 않는다
 *
 * 왜 원장을 두나: Bareos 에는 '이 잡이 어느 vCenter 의 어느 VM 인가' 가 없다(잡 이름만 있다). 범위(scope) 판정·트리 배지·
 *   화면은 vcenterId 가 필요하다. 원장이 손상되면 Director 의 잡은 남고 포탈만 모른다 — 그래서 손상 보존(preserveCorrupt)이
 *   필수다(빈 원장으로 저장하면 되살릴 근거가 사라진다 — vmclone/store.js 와 같은 이유).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { isFinalStatus, statusOf } from './names.js';
import { cancelTracked } from './cancelState.js';
import { DEFAULT_DIRECTOR_ID } from './settings.js';

export const FILE_NAME = 'bareos-jobs.json';
const FILE = () => path.join(config.configDir, 'bareos-jobs.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
// v2.828(사용자 승인 — 28개 법인 통합 화면): 500 → 3,000. 실측(scratch 벤치 · 대상마다 끝난 실행 10건): 5,000 이면 파일 8MB·한 번 쓰기 54ms·
//   listJobs 깊은 복사 47ms 로 폴링 주기마다 이벤트 루프를 오래 잡는다 — 3,000 은 그 6할(약 30ms). 더 올리려면 Director 별 파일 분할이 먼저다.
export const MAX_JOBS = 3000;
/** v2.847 D2-1: 다시 묶기 전 위치 기록(대상마다 최근 N번 — 위치가 바뀐 다시 묶기만 남는다). */
export const PLACEMENTS_KEEP = 5;
export const RESTORES_KEEP = 20;
export const RETIRED_KEEP = 1000;   // Director 하나에 남기는 지운 잡 이름 수(v2.846 D-6 — 예전에는 28개 Director 합계였다)
export const RETIRED_TOTAL_MAX = 40_000;   // 파일 전체 안전 상한(Director 30+ × RETIRED_KEEP)
/**
 * v2.846 D-6(반증 확정): 상한을 **Director 마다** 둔다 — 합계 1,000 이면 바쁜 법인이 다른 법인의 이름을 밀어내고, 밀려난 이름은 다음 reload 에
 * conf 값대로 다시 켜져 원장 밖에서 스케줄 백업이 돌았다(포탈 '삭제' 는 disable 뿐이라 conf 가 남는다). 각 Director 안에서는 오래된 것부터 버린다.
 */
export function trimRetired(list) {
  const arr = Array.isArray(list) ? list : [];
  const per = new Map();
  const keep = new Array(arr.length).fill(false);
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const d = retiredDir(arr[i]);
    const n = per.get(d) || 0;
    if (n < RETIRED_KEEP) { keep[i] = true; per.set(d, n + 1); }
  }
  return arr.filter((_, i) => keep[i]).slice(-RETIRED_TOTAL_MAX);
}
export const FINISHED_KEEP = 10;

let _db = null;
const _loadErr = makeLoadError();

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _db = {
        jobs: (Array.isArray(p.jobs) ? p.jobs : []).filter((j) => j && typeof j === 'object' && typeof j.id === 'string'),
        retired: trimRetired((Array.isArray(p.retired) ? p.retired : []).filter((r) => r && typeof r.name === 'string' && r.name)),
      };
      const fixed = dedupeJobIds(_db.jobs);
      if (fixed) console.warn(`[bareos] 백업 대상 원장에 같은 id 가 ${fixed}건 있어 뒤 항목에 새 id 를 붙였습니다(옛 판 일괄 등록의 id 충돌 — 다음 저장 때 기록).`);
      _loadErr.clear();
      return _db;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 백업 대상 원장을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다.`);
  }
  _loadErr.checkCorruptOnly(FILE());
  _db = { jobs: [], retired: [] };
  return _db;
}

/** 원장을 읽지 못했나(손상) — 쓰기 라우트는 이 상태에서 새 잡을 만들지 않는다(빈 원장 저장이 보존본을 덮지 않게). */
export function registryLoadError() { load(); return _loadErr.get(); }

/*
 * v2.822(검토 P2·I4 — 실측): 대조 틱이 대상마다 persist() 를 불러 500개 원장에서 한 틱에 동기 2.5초(복원 이력이 많으면 18초)를
 *   막았다. inBatch(fn) 안의 쓰기는 끝에 **한 번만** 쓴다 — fn 은 동기여야 한다(await 를 넘어 묶으면 그 사이 라우트의 저장이 늦어진다).
 */
let _batch = 0;
// v2.871 감사 A2-09: '메모리 원장이 디스크보다 앞서 있다' 표지 — 쓰기에 **성공해야만** 내린다(writeNow). 예전에는 inBatch 가 writeNow 전에
//   false 로 내려, 디스크 쓰기가 실패하면 메모리 변경(복원 마무리의 pending + opId 등)이 다음 원장 변경 때까지 다시 쓰이지 않았다.
//   이제 실패하면 표지가 남아 다음 inBatch 끝(폴러 틱 · 복원 마무리 틱)에서 다시 쓴다.
let _dirty = false;
export function inBatch(fn) {
  _batch += 1;
  try { return fn(); } finally {
    _batch -= 1;
    if (!_batch && _dirty) writeNow();
  }
}
let _rev = 0;
/** v2.828 원장 변경 리비전 — 조회 화면(bareos-summary·bareos-detail) 응답 캐시 키(저장 즉시 수가 바뀌게). */
export function registryRev() { return _rev; }
function persist() {
  _rev += 1;
  if (_batch) { _dirty = true; return; }
  writeNow();   // 묶음 밖 단건 쓰기는 실패하면 호출부가 메모리를 되돌린다(patchJob · addJob — v2.847 D2-7) — 표지를 올리지 않는다
}
function writeNow() {
  const db = load();
  // v2.828: 들여쓰기 없이 쓴다(3,000개에서 크기·직렬화 시간이 약 절반 — 위 MAX_JOBS 실측). 읽기는 예전 들여쓴 파일도 같다.
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, jobs: db.jobs, retired: db.retired }), { mode: 0o600 });
  _dirty = false;
  _loadErr.clear();
}
/** v2.871 A2-09 시험용 — 디스크에 아직 못 쓴 메모리 변경이 있나. */
export const _dirtyForTest = () => _dirty;

const copy = (j) => (j ? JSON.parse(JSON.stringify(j)) : null);
export function listJobs() { return load().jobs.map(copy); }
/** 한 vCenter 의 대상만 깊은 복사(재해 복구 실행기 — 판정 · 이름 예약 키가 모두 vCenter 로 나뉜다 · 버그 점검 B3-01: 회차마다 원장 전체를 복사해 28회차 × 원장 28,000 에서 틱이 14초 막혔다). */
export function listJobsOf(vcenterId) { const k = String(vcenterId); return load().jobs.filter((j) => String(j.vcenterId) === k).map(copy); }
/**
 * v2.828 조회 화면용 가벼운 읽기 — 깊은 복사 없이 화면이 쓰는 칸만(얕은 사본 · 복원 이력·끝난 실행 원문은 싣지 않는다).
 *   listJobs 는 대상마다 JSON 왕복이라 3,000개에서 약 30ms 다(MAX_JOBS 실측). 돌려준 객체를 고쳐도 원장은 바뀌지 않는다(lastRun·pending 도 사본).
 */
export function jobDigests() {
  return load().jobs.map((j) => ({
    id: j.id, vcenterId: j.vcenterId, vmId: j.vmId, vmName: j.vmName, folder: j.folder, directorId: j.directorId, bareosJob: j.bareosJob,
    client: j.client, storage: j.storage, pool: j.pool, schedule: j.schedule, level: j.level, enabled: j.enabled !== false, demo: !!j.demo,
    createdBy: j.createdBy, createdAt: j.createdAt, missingInDirector: !!j.missingInDirector,
    pending: j.pending ? { ...j.pending } : null, lastRun: j.lastRun ? { ...j.lastRun } : null, lastError: j.lastError ? { ...j.lastError } : null,
    cancelReq: j.cancelReq ? { ...j.cancelReq } : null,
    lastOkAt: lastOkAt(j), lastRate: j.lastRate ? { ...j.lastRate } : null,
    recentRuns: (Array.isArray(j.finishedRuns) ? j.finishedRuns : []).slice(-5).map((r) => ({ ...r })),
  }));
}
/** 마지막으로 **백업이 만들어진**(T 성공 · W 경고 — 둘 다 복원 지점이 생긴다) 실행이 끝난 시각. lastRun 이 실패여도 finishedRuns 에 있으면 그 시각. 모르면 null. */
function lastOkAt(j) {
  // v2.830 버그 점검 S14: 끝난 실행 목록은 최근 FINISHED_KEEP 건뿐이라 성공 뒤 실패가 10번 넘으면 성공 기록이 밀려나 '백업 없음' 이 됐다 —
  //   원장 칸 lastOkAt(성공·경고가 끝날 때마다 올린다)을 함께 본다
  let best = Number.isFinite(j.lastOkAt) && j.lastOkAt > 0 ? j.lastOkAt : null;
  for (const r of [j.lastRun, ...(Array.isArray(j.finishedRuns) ? j.finishedRuns : [])]) {
    if (r && (r.status === 'T' || r.status === 'W') && Number.isFinite(r.endedAt) && r.endedAt > 0 && (best == null || r.endedAt > best)) best = r.endedAt;
  }
  return best;
}
export function getJob(id) { return copy(load().jobs.find((j) => j.id === id)); }
export function findByVm(vcenterId, vmId) { return copy(load().jobs.find((j) => j.vcenterId === vcenterId && j.vmId === vmId)); }

/**
 * 새 대상 추가(Director 잡을 만든 **뒤**에 부른다). 같은 VM 은 한 번만.
 * @returns {object} 저장한 job
 */
const LOAD_ERR_ADD = '백업 대상 원장을 읽지 못한 상태라 새 대상을 추가하지 않습니다(손상본 보존 — 다빈치 서비스 점검에서 확인).';
export function addJob(input) {
  const db = load();
  if (_loadErr.get()) throw new Error(LOAD_ERR_ADD);
  const retiredBefore = db.retired;
  const job = insertJob(db, input);
  // 파일에 못 쓰면 메모리에도 넣지 않는다(v2.822 — 예전에는 메모리에만 남아 화면은 '등록됨', 재시작하면 사라졌다)
  try { persist(); } catch (e) { db.jobs.pop(); db.retired = retiredBefore; throw e; }
  return job;
}

/**
 * 여러 대상을 **한 번의 쓰기로** 추가(Director 잡을 만든 뒤 — 일괄 등록·그룹 저장). 항목마다 { ok, job } | { ok:false, err }.
 * v2.830 버그 점검 S2(실측): 대상마다 addJob 이 원장 전체를 써 원장 2,800건에 200대 = 5.2초 동기 정지였다.
 * addJob 의 '쓰기 실패면 메모리에도 넣지 않는다' 계약을 **묶음 단위로** 지킨다 — 끝 쓰기가 실패하면 이번에 넣은 것을 전부 되돌리고 던진다
 * (부르는 쪽이 그 잡들을 원장 밖 잡으로 끈다 — service.orphanCleanup).
 */
export function addJobs(inputs) {
  const db = load();
  if (_loadErr.get()) throw new Error(LOAD_ERR_ADD);
  const jobsBefore = db.jobs.slice();
  const retiredBefore = db.retired;
  const out = (Array.isArray(inputs) ? inputs : []).map((input) => {
    try { return { ok: true, job: insertJob(db, input) }; } catch (e) { return { ok: false, err: e }; }
  });
  if (out.some((o) => o.ok)) {
    _rev += 1;
    if (_batch) _dirty = true;
    else {
      try { writeNow(); } catch (e) { db.jobs = jobsBefore; db.retired = retiredBefore; throw e; }
    }
  }
  return out;
}

/*
 * v2.850(릴리스 단위 테스트 간헐 실패로 발견 — 재현): id 가 `bj_<밀리초><무작위 3바이트>` 라 일괄 등록(같은 밀리초 수백 건)에서 겹칠 수 있었다
 *   (450건이면 약 0.6%). 겹친 뒤 항목은 id 로 찾을 수 없다(조회 · 실행 · 삭제 · 결과 반영이 모두 앞 항목으로 간다).
 *   새 id 는 무작위 6바이트 + 원장에 없는 것만 · 이미 겹친 원장은 읽을 때 뒤 항목에 **결정적** id(<원래>d<n>)를 준다(재시작해도 같은 id — 파일은 다음 저장 때).
 */
function newJobId(db) {
  for (let n = 0; ; n += 1) {   // 바로 위 같은 VM 검사와 같은 O(n) 훑기 — 겹칠 때만 한 번 더(뒤 n 으로 반드시 끝난다)
    const id = `bj_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}${n ? `n${n}` : ''}`;
    if (!db.jobs.some((j) => j.id === id)) return id;
  }
}
/** @returns {number} 새 id 를 붙인 항목 수 */
export function dedupeJobIds(jobs) {
  const all = new Set(jobs.map((j) => j.id));
  const seen = new Set();
  let fixed = 0;
  for (const j of jobs) {
    if (seen.has(j.id)) {
      let n = 1;
      while (all.has(`${j.id}d${n}`)) n += 1;
      j.id = `${j.id}d${n}`;
      all.add(j.id);
      fixed += 1;
    }
    seen.add(j.id);
  }
  return fixed;
}

/** 원장 메모리에 한 대상을 넣는다(쓰기는 부르는 쪽). 상한·같은 VM 은 거부. */
function insertJob(db, input) {
  if (db.jobs.length >= MAX_JOBS) throw new Error(`백업 대상은 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
  if (db.jobs.some((j) => j.vcenterId === input.vcenterId && j.vmId === input.vmId)) throw new Error('이 VM 은 이미 백업 대상입니다.');
  const job = {
    id: newJobId(db),
    vcenterId: String(input.vcenterId), vmId: String(input.vmId), vmName: String(input.vmName),
    dc: String(input.dc), folder: String(input.folder),
    ...(input.directorId ? { directorId: String(input.directorId) } : {}),
    bareosJob: String(input.bareosJob), client: String(input.client), storage: String(input.storage), pool: String(input.pool),
    schedule: String(input.schedule || ''), level: String(input.level || 'Incremental'),
    enabled: true, createdBy: String(input.createdBy || ''), createdAt: Date.now(),
    ...(input.demo ? { demo: true } : {}),
    pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [],
  };
  db.jobs.push(job);
  const sameRetired = (r) => r.name === job.bareosJob && retiredDir(r) === (job.directorId || DEFAULT_DIRECTOR_ID);
  if (db.retired?.some(sameRetired)) db.retired = db.retired.filter((r) => !sameRetired(r));   // 같은 Director 에서 같은 이름을 다시 쓰면 '지운 잡' 이 아니다
  return copy(job);
}

/** 일부 필드 갱신(존재하지 않으면 null). */
export function patchJob(id, patch) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return null;
  const allowed = ['enabled', 'pending', 'lastRun', 'lastError', 'missingInDirector', 'schedule', 'level', 'cancelReq'];
  const before = [];
  for (const k of allowed) if (Object.hasOwn(patch, k)) { before.push([k, Object.hasOwn(j, k), j[k]]); j[k] = patch[k]; }
  // v2.847 D2-7(2회차 점검 — 재현): 파일에 못 쓰면 메모리도 되돌린다(addJob 과 같은 계약 — 예전에는 화면은 바뀐 값, 재시작하면 옛 값이었다)
  try { persist(); } catch (e) { for (const [k, had, v] of before) { if (had) j[k] = v; else delete j[k]; } throw e; }
  return copy(j);
}

/**
 * v2.845 재설치 뒤 다시 등록 — Director 에 잡이 없어진 대상을 **같은 원장 행**(id · 스케줄 · 레벨 · 켜짐 그대로)에 새 잡 이름 · 지금 매핑의
 * client · storage · pool 로 다시 묶는다. patchJob 은 이 칸들을 받지 않는다(일반 수정 경로로 잡 이름을 바꾸지 못하게) — 이 함수만 바꾼다.
 * 실행 기록(lastRun · finishedRuns · lastRate · 끝난 복원)은 `restart` 일 때만 새로 시작한다(v2.847 D2-3 — 카탈로그 세대가 바뀌었거나 모를 때).
 * 한 번의 쓰기(addJobs 와 같은 묶음 계약 — 끝 쓰기가 실패하면 전부 되돌리고 던진다).
 * @param {{ id, bareosJob, client, storage, pool }[]} list
 * @param {{ restart?: boolean }} [o]
 * @returns {{ id, ok: boolean, job?, err? }[]}
 */
export function rebindJobs(list, { restart = true } = {}) {
  const db = load();
  if (_loadErr.get()) throw new Error('백업 대상 원장을 읽지 못한 상태라 바꾸지 않습니다(손상본 보존 — 서비스 점검에서 확인).');
  const before = db.jobs.map((j) => ({ ...j }));
  const retiredBefore = db.retired;
  const out = (Array.isArray(list) ? list : []).map((x) => {
    const j = db.jobs.find((y) => y.id === x?.id);
    if (!j) return { id: x?.id, ok: false, err: new Error('원장에 없는 대상입니다(그사이 지워졌습니다).') };
    for (const k of ['bareosJob', 'client', 'storage', 'pool']) if (typeof x[k] !== 'string' || !x[k]) return { id: j.id, ok: false, err: new Error(`${k} 값이 없습니다.`) };
    Object.assign(j, { bareosJob: x.bareosJob, client: x.client, storage: x.storage, pool: x.pool, missingInDirector: false, lastError: null, pending: null });
    // v2.847 D2-1(2회차 점검 — 재현): 카탈로그가 그대로면(restart 아님) 다시 묶기 전 복원 지점은 **그때의** 이름 · 위치로 백업됐다 — 위치가 바뀌면
    //   그 jobid 까지의 옛 위치를 남긴다(덮어쓰기 복원이 그 지점에는 옛 위치로 판정한다 — restore.placementAt). 새 카탈로그면 옛 지점이 없어 비운다.
    const moved = ['vmName', 'dc', 'folder'].some((k) => typeof x[k] === 'string' && x[k] && x[k] !== j[k]);
    if (restart) j.placements = [];
    else if (moved && Number.isInteger(j.lastRun?.jobid)) {
      j.placements = [...(Array.isArray(j.placements) ? j.placements : []), { upToJobid: j.lastRun.jobid, vmName: j.vmName, dc: j.dc, folder: j.folder, at: Date.now() }].slice(-PLACEMENTS_KEEP);
    }
    // v2.846 D-8: 잡은 지금 인벤토리 값(이름 · 데이터센터 · 폴더)으로 만들었다 — 원장도 같이(옛 값이면 거짓 위치 변경 · 덮어쓰기 복원 거부)
    for (const k of ['vmName', 'dc', 'folder']) if (typeof x[k] === 'string' && x[k]) j[k] = x[k];
    // v2.846 D-1(반증 확정 · 높음): 재설치는 카탈로그 DB 를 지우는 것이 기본 — 새 카탈로그는 jobid 를 1 부터 다시 매긴다.
    //   jobid 로 비교하는 칸(lastRun · finishedRuns · lastRate · restores)을 그대로 두면 새 실행이 '더 작은 jobid' 라 원장 · 실패 메일에서 버려졌고
    //   옛 복원 jobid 와 같은 새 jobid 의 로그가 복원 로그로 열렸다. lastOkAt(시각 기준 — RPO)은 둔다. runsEpoch 가 바뀌면 실패 메일 커서도 지운다(notify.js).
    // v2.847 D2-3(2회차 점검 — 재현 · 1회차 반증 권고를 따르지 않은 메인의 구현 잘못): v2.846 은 **무조건** 비웠다 — 카탈로그가 남은 경우(잡 conf 만 지워짐 ·
    //   카탈로그 유지 재설치)에도 이미 알린 실패를 다시 메일로 보냈고, 진행 중 복원의 추적(복원 중 409 · 삭제 거부)까지 지웠다.
    //   이제 부르는 쪽(manage/service.js catalogGeneration)이 카탈로그 세대가 바뀌었거나 판정하지 못했을 때만 restart 를 준다. 비울 때도 **진행 중 복원은 남긴다**.
    if (restart) {
      j.beforeRebind = { at: Date.now(), lastRun: j.lastRun ? { jobid: j.lastRun.jobid ?? null, status: j.lastRun.status ?? '', endedAt: j.lastRun.endedAt ?? null } : null, restores: Array.isArray(j.restores) ? j.restores.length : 0 };
      Object.assign(j, { lastRun: null, finishedRuns: [], lastRate: null, restores: (Array.isArray(j.restores) ? j.restores : []).filter((r) => restoreOpen(r) || restoreFinishing(r) || restoreUnknownHeld(r)), runsEpoch: Date.now() });   // v2.874 B2-04 마무리 중도 남긴다
    }
    const dir = j.directorId || DEFAULT_DIRECTOR_ID;
    if (db.retired?.some((r) => r.name === j.bareosJob && retiredDir(r) === dir)) db.retired = db.retired.filter((r) => !(r.name === j.bareosJob && retiredDir(r) === dir));
    return { id: j.id, ok: true, job: copy(j) };
  });
  if (out.some((o) => o.ok)) {
    _rev += 1;
    if (_batch) _dirty = true;
    else {
      try { writeNow(); } catch (e) { db.jobs = before; db.retired = retiredBefore; throw e; }
    }
  }
  return out;
}

/**
 * @param {string} id
 * @param {{ directorId?: string }} [o] 이 잡의 Director(옛 잡은 directorId 가 없어 라우트가 settings.jobDirectorId 로 풀어 넘긴다 —
 *   지운 뒤 그 vCenter 를 다른 Director 로 옮겨도 '다시 끄기' 가 옛 Director 로 가게)
 */
export function deleteJob(id, { directorId = '' } = {}) {
  const db = load();
  const i = db.jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  const retiredBefore = Array.isArray(db.retired) ? db.retired.slice() : db.retired;
  const [j] = db.jobs.splice(i, 1);
  addRetired(db, j.bareosJob, !!j.demo, j.directorId || directorId || DEFAULT_DIRECTOR_ID);
  // v2.847 D2-7(2회차 점검 — 재현): 쓰기가 실패하면 행 · 지운 이름을 되돌리고 던진다 — 예전에는 화면은 '삭제됨'(Director 잡은 꺼짐),
  //   재시작하면 원장에 켜짐으로 되살아나 '백업 중' 으로 보였다(지운 이름은 메모리에만 있어 다시 끄지도 않았다)
  try { persist(); } catch (e) { db.jobs.splice(i, 0, j); db.retired = retiredBefore; throw e; }
  return true;
}

/** 실행 시작 기록(포탈이 run 을 보냈다). */
export function markPending(id, { jobid, level, by, trigger = 'manual', late = false }) {
  // v2.938 반증 B-4: 늦은 회신은 trigger 를 바꾸지 않고 late 표지를 따로 단다(화면 triggerText 가 'group-late' 를 '수동' 으로 읽었다)
  return patchJob(id, { pending: { jobid, since: Date.now(), level, by: String(by || ''), trigger, ...(late ? { late: true } : {}) }, lastError: null });
}

/**
 * v2.867 취소를 보냈다(Director 가 cancel 을 받았다) — 그 실행이 끝나면(applyRunRow) 지운다. 화면의 '멈추는 중' · '멈추지 않음' 은 cancelState.cancelInfo 가 판정한다.
 * @param {{ jobid:number, by?:string, via?:'single'|'group', at?:number }} c
 */
export function markCancelReq(id, { jobid, by = '', via = 'single', at = Date.now() }) {
  return patchJob(id, { cancelReq: { jobid, at, by: String(by || '').slice(0, 80), via: via === 'group' ? 'group' : 'single' } });
}

/**
 * 카탈로그 행으로 결과 반영(폴러). 끝난 상태면 pending 을 내리고 lastRun 으로 옮긴다.
 * lastRun 은 **더 새 jobid 만** 덮는다(오래된 행이 최신 결과를 되돌리지 않게).
 * @param {object} row  director.normalizeJobRow 결과
 */
export function applyRunRow(id, row, now = Date.now()) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j || !row?.jobid) return null;
  const rec = {
    jobid: row.jobid, status: row.status, state: statusOf(row.status), level: row.level || '',
    startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null, bytes: row.bytes ?? null, files: row.files ?? null, errors: row.errors ?? null,
    checkedAt: now,
  };
  let changed = false;
  // v2.822.3(C2-2 — 재현): 끝난 실행을 따로 남긴다(최근 FINISHED_KEEP 건). 포탈이 시작한 실행이 끝날 때 더 큰 jobid(대기 중인 스케줄 실행)가
  //   이미 lastRun 이면 그 결과가 어디에도 남지 않아 실패 메일에서 빠졌다. 실패 메일(notify)이 이 목록도 본다.
  if (isFinalStatus(row.status) && !(j.finishedRuns || []).some((x) => x.jobid === rec.jobid)) {
    // v2.858: 바이트 · 시작 시각도 남긴다 — 진행 현황의 '지난 같은 레벨 실행' 기준(실행 중이면 lastRun 이 그 실행이라 끝난 값은 여기에만 있다)
    const { jobid, status, state, level, startedAt, endedAt, bytes, errors } = rec;
    j.finishedRuns = [...(Array.isArray(j.finishedRuns) ? j.finishedRuns : []), { jobid, status, state, level, startedAt, endedAt, bytes, errors, checkedAt: now }]
      .sort((a, b) => a.jobid - b.jobid).slice(-FINISHED_KEEP);
    changed = true;
  }
  // 마지막으로 **백업이 만들어진**(T·W) 시각 — 잘린 목록과 무관하게 남긴다(S14 · 더 새 값만)
  if ((row.status === 'T' || row.status === 'W') && Number.isFinite(rec.endedAt) && rec.endedAt > 0 && !(Number.isFinite(j.lastOkAt) && j.lastOkAt >= rec.endedAt)) {
    j.lastOkAt = rec.endedAt;
    changed = true;
  }
  // v2.833 진행 현황판: 마지막으로 끝난 성공(T·W) 백업의 평균 속도(바이트 ÷ 소요) — 실행 중 잡이 느린지 견줄 기준. 실행 중에는 lastRun 이
  //   그 실행으로 바뀌어 지난 값을 잃으므로 따로 남긴다(더 새 jobid · 값을 다 읽었을 때만 — 못 읽은 값으로 지어내지 않는다)
  if ((row.status === 'T' || row.status === 'W') && Number.isFinite(rec.bytes) && rec.bytes > 0 && Number.isFinite(rec.startedAt) && Number.isFinite(rec.endedAt)
    && rec.endedAt > rec.startedAt && !((Number(j.lastRate?.jobid) || 0) >= rec.jobid)) {
    j.lastRate = { jobid: rec.jobid, level: rec.level, bps: Math.round(rec.bytes / ((rec.endedAt - rec.startedAt) / 1000)), bytes: rec.bytes, at: rec.endedAt };
    changed = true;
  }
  // v2.867 취소를 보낸 실행이 끝났다(A 든 T 든) — 취소 기록을 내린다(지난 기록은 cancelInfo 가 어차피 무시하지만 원장에 남기지 않는다)
  if (j.cancelReq && j.cancelReq.jobid === row.jobid && isFinalStatus(row.status)) { j.cancelReq = null; changed = true; }
  if (j.pending && j.pending.jobid === row.jobid) {
    if (isFinalStatus(row.status)) { j.pending = null; changed = true; }
    else if (j.pending.status !== row.status || j.pending.misses) { j.pending = { ...j.pending, status: row.status, state: rec.state, misses: 0 }; changed = true; }
  }
  // lastRun 은 가장 새 실행(jobid 가 같거나 큰 것) — Bareos 스케줄이 돌린 실행(포탈이 시작하지 않은 것)도 여기로 들어온다.
  if (!j.lastRun || (Number(j.lastRun.jobid) || 0) <= row.jobid) {
    const L = j.lastRun;
    // 같은 실행을 덜 자세한 행(대조용 `list jobs`)으로 다시 받으면 이미 아는 값을 null 로 지우지 않는다.
    if (L && L.jobid === rec.jobid) for (const k of ['bytes', 'files', 'errors', 'startedAt', 'endedAt']) if (rec[k] === null && L[k] !== null && L[k] !== undefined) rec[k] = L[k];
    const same = L && L.jobid === rec.jobid && L.status === rec.status && L.bytes === rec.bytes && L.endedAt === rec.endedAt && L.files === rec.files;
    if (same) L.checkedAt = now; // 바뀐 것이 없으면 파일을 다시 쓰지 않는다(폴링마다 쓰기 금지)
    else { j.lastRun = rec; changed = true; }
  }
  if (changed) persist();
  return copy(j);
}

/** 복원 시작 기록. 최근 RESTORES_KEEP 건만 남긴다. */
export function addRestore(id, rec) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return null;
  // v2.874(점검 B5-01): 결과 모름(명령을 보낸 뒤 회신이 끊김 — jobid 없음)도 남긴다 — 같은 복원을 다시 보내 두 번 돌지 않게(restoreHeld · 새 VM 이름 예약)
  const st = rec?.unknown === true ? { jobid: null, status: '', state: 'unknown' } : { status: 'C', state: 'queued' };
  j.restores = [{ ...rec, ...st, at: Date.now() }, ...(Array.isArray(j.restores) ? j.restores : [])].slice(0, RESTORES_KEEP);
  persist();
  return copy(j);
}

/**
 * v2.938(제안 6번 — v2.824 '남긴 것' runJob·restore 늦은 회신 미반영): 시한으로 '결과 모름' 으로 남긴 복원 행(jobid 없음 · state unknown)에
 * 엣지의 늦은 회신이 rid 를 주면 그 행을 열린 복원(queued)으로 바꾼다 — 그래야 폴러가 그 복원을 추적해 결과를 남긴다.
 * 같은 묶음(batchId — 단건 복원은 lateKey)의 결과 모름 행 하나만 바꾼다. 이미 jobid 가 있거나(다른 경로가 채웠다) 같은 rid 가 다른 행에 있으면 하지 않는다.
 * 반증 B-5: 보낸 뒤(sentAt) 대상이 다시 묶였으면(runsEpoch — 재설치 · Director 변경) 옛 카탈로그의 rid 라 반영하지 않는다.
 * 반증 B-1: 묶음 밖 단건 쓰기가 실패하면 메모리를 되돌린다(patchJob 과 같은 규약). 여러 건은 호출부가 inBatch 로 묶는다.
 * @returns {object|null} 바꾼 job 사본(바꾸지 않았으면 null)
 */
export function lateResolveRestore(jobId, key, { rid, chain = [] } = {}, now = Date.now(), { sentAt = 0 } = {}) {
  if (!Number.isInteger(rid) || rid <= 0 || !key) return null;
  const db = load();
  const j = db.jobs.find((x) => x.id === jobId);
  if (!j || !Array.isArray(j.restores)) return null;
  if (sentAt && Number(j.runsEpoch) > sentAt) return null;
  if (j.restores.some((x) => x.jobid === rid)) return null;
  const r = j.restores.find((x) => x.state === 'unknown' && !x.jobid && (x.batchId === key || x.lateKey === key));
  if (!r) return null;
  const before = { ...r };
  Object.assign(r, { jobid: rid, fromJobids: Array.isArray(chain) ? chain.slice(0, 400) : [], status: 'C', state: 'queued', lateAt: now });
  delete r.unknown;
  try { persist(); } catch (e) {
    for (const k of Object.keys(r)) delete r[k];
    Object.assign(r, before);
    throw e;
  }
  return copy(j);
}

/** 복원 잡 상태 반영(폴러). */
export function applyRestoreRow(id, row, now = Date.now()) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  const r = j?.restores?.find((x) => x.jobid === row?.jobid);
  if (!r) return null;
  // v2.874(점검 B2-03 — 재현): 끝난 상태(T)를 늦게 온 옛 행(R — 다른 경로의 조회 결과)이 되돌려 열린 복원으로 만들었다 — 끝난 뒤의 끝나지 않은 행은 받지 않는다
  if (isFinalStatus(r.status) && !isFinalStatus(row?.status)) return null;
  const changed = r.status !== row.status || (r.endedAt ?? null) !== (row.endedAt ?? null) || !!r.misses;
  Object.assign(r, { status: row.status, state: statusOf(row.status), startedAt: row.startedAt ?? r.startedAt ?? null, endedAt: row.endedAt ?? null, checkedAt: now, misses: 0 });
  if (changed) persist();
  return copy(j);
}

/**
 * v2.861 복원 마무리(NIC 끊기)를 볼 복원 — 끊기를 고른 복원이고(nic === 'disconnect' — 새 VM 기본 · 덮어쓰기는 고를 때만) 끝났거나 추적을 놓쳤고 마무리가 없거나 아직 '보냄' 인 것.
 *   원장 사본을 통째로 만들지 않는다(폴러 주기마다 부른다) — 필요한 칸만.
 * @returns {{ jobId, vcenterId, rid, name, state, finish }[]}
 */
export function restoresToFinish() {
  const out = [];
  for (const j of load().jobs) {
    for (const r of Array.isArray(j.restores) ? j.restores : []) {
      // 추적을 놓친(abandoned) 복원도 넣는다 — 결과를 모르니 '직접 확인' 으로 남긴다(반증 검토 L1: 예전에는 화면이 영원히 '끊기 대기')
      if (r?.nic !== 'disconnect' || !r.jobid || (!isFinalStatus(r.status) && !r.abandoned)) continue;
      const f = r.finish && typeof r.finish === 'object' ? r.finish : null;
      if (f && f.nic !== 'pending') continue;
      out.push({ jobId: j.id, vcenterId: j.vcenterId, rid: r.jobid, name: String(r.target?.name || ''), state: r.state, abandoned: !!r.abandoned && !isFinalStatus(r.status), finish: f ? { ...f } : null,
        ...(r.verify === true ? { verify: true, deleteOnOk: r.deleteOnOk !== false } : {}) });   // v2.862 복원 검증(리허설)
    }
  }
  return out;
}

/**
 * v2.861 복원 마무리 기록 — guard(지금 finish) 가 false 면 쓰지 않는다(늦게 온 보냄 기록이 이미 끝난 결과를 덮지 않게).
 * @returns {boolean} 썼는가
 */
export function patchRestoreFinish(jobId, rid, finish, guard = null) {
  const db = load();
  const j = db.jobs.find((x) => x.id === jobId);
  const r = j?.restores?.find((x) => x.jobid === rid);
  if (!r) return false;
  const cur = r.finish && typeof r.finish === 'object' ? r.finish : null;
  if (guard && !guard(cur)) return false;
  r.finish = { ...finish };
  persist();
  return true;
}

/** 아직 끝나지 않은(추적 중인) 복원인가 — 진행 중 409·복원 지점 화면·삭제 거부가 같은 판정을 쓴다. */
export const restoreOpen = (r) => !!r?.jobid && !isFinalStatus(r.status) && !r.abandoned;
/** v2.874(점검 B5-01) 결과 모름 복원을 붙잡아 두는 시간 — Director 에서 확인할 시간. 웹 bareosRestoreText.RESTORE_UNKNOWN_HOLD_MS 와 같다(시험 대조). */
export const RESTORE_UNKNOWN_HOLD_MS = 6 * 3600_000;
/** 결과 모름 복원(jobid 없음)이 아직 붙잡는 중인가. */
export const restoreUnknownHeld = (r, now = Date.now()) => r?.unknown === true && !r.jobid && now - (Number(r.at) || 0) < RESTORE_UNKNOWN_HOLD_MS;
/** 이 대상에 새 복원을 보내면 안 되는가 — 진행 중이거나, 직전 복원의 결과를 모른다(두 번 돌 수 있다). */
export const restoreHeld = (r, now = Date.now()) => restoreOpen(r) || restoreUnknownHeld(r, now);
/**
 * v2.874(점검 B2-04 — 재현): 복원은 끝났지만 마무리(NIC 끊기 · 검증)가 아직인 복원 — restoresToFinish 와 같은 조건. 재설치 다시 묶기 · 삭제가
 *   restoreOpen 만 봐 이 행을 지웠다 → 마무리 결과를 쓸 곳이 없어 새 VM 이 연결된 채 '끊기 대기' 로 사라졌다.
 */
export const RESTORE_FINISH_HOLD_MS = 24 * 3600_000;   // 마무리가 이만큼 넘게 걸려 있으면 붙잡지 않는다(마무리를 다시 부를 폴러 갱신이 없을 때 삭제가 영영 막히지 않게)
export const restoreFinishing = (r, now = Date.now()) => r?.nic === 'disconnect' && !!r.jobid && (isFinalStatus(r.status) || !!r.abandoned) && (!r.finish || r.finish.nic === 'pending')
  && now - (Number(r.finish?.at || r.endedAt || r.at) || 0) < RESTORE_FINISH_HOLD_MS;

/** 아직 끝나지 않은 실행(백업·복원) — 폴러가 이것만 조회한다. */
export function pendingWork(now = Date.now()) {
  const out = [];
  for (const j of load().jobs) {
    const dir = j.directorId || '';   // 옛 잡('')은 폴러가 settings.jobDirectorId 로 푼다
    if (j.pending?.jobid) out.push({ id: j.id, jobid: j.pending.jobid, kind: 'backup', job: j.bareosJob, demo: !!j.demo, directorId: dir, vcenterId: j.vcenterId });
    // v2.867 취소를 보낸 Bareos 스케줄 실행(포탈이 시작하지 않아 pending 이 없다)도 결과가 나올 때까지 묻는다(CANCEL_TRACK_MS 동안 — 그 뒤는 대조 틱)
    if (cancelTracked(j, now)) out.push({ id: j.id, jobid: j.cancelReq.jobid, kind: 'backup', job: j.bareosJob, demo: !!j.demo, directorId: dir, vcenterId: j.vcenterId, cancelOnly: true });
    for (const r of j.restores || []) if (restoreOpen(r)) out.push({ id: j.id, jobid: r.jobid, kind: 'restore', demo: !!j.demo, directorId: dir, vcenterId: j.vcenterId });
  }
  return out;
}

/*
 * v2.822(검토 P5 — 재현): Director 카탈로그가 그 jobid 를 모르면(재시작으로 기록이 사라짐·다른 Director 로 바꿈) pending 이 영원히 남아
 *   ① '할 일이 없으면 접속하지 않는다' 가 깨지고 ② 그 대상은 실행·삭제·복원이 막혔다. 연속 MISS_LIMIT 번 못 찾고 시작한 지
 *   MISS_MIN_AGE_MS 가 지났으면 **추적을 멈추고** 그 사실을 lastError 에 남긴다(결과를 지어내지 않는다 — '실패' 로 적지 않는다).
 */
export const MISS_LIMIT = 5;
export const MISS_MIN_AGE_MS = 60 * 60_000;
export function notePendingMiss(id, kind, jobid, now = Date.now()) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return null;
  const msg = (n) => `jobid ${jobid} 를 Director 카탈로그에서 ${n}번 연속 찾지 못해 포탈의 추적을 멈췄습니다(Director 재시작·설정 변경 등) — 실제 결과는 Director 에서 확인하세요.`;
  if (kind === 'backup') {
    if (j.pending?.jobid !== jobid) return null;
    const misses = (Number(j.pending.misses) || 0) + 1;
    if (misses >= MISS_LIMIT && now - (Number(j.pending.since) || now) >= MISS_MIN_AGE_MS) {
      if (j.cancelReq?.jobid === jobid) j.cancelReq = null;
      j.pending = null;
      j.lastError = { at: now, message: msg(misses) };
      persist();
      return 'abandoned';
    }
    j.pending = { ...j.pending, misses };
    persist();
    return 'missed';
  }
  const r = (j.restores || []).find((x) => x.jobid === jobid);
  if (!r || !restoreOpen(r)) return null;
  r.misses = (Number(r.misses) || 0) + 1;
  if (r.misses >= MISS_LIMIT && now - (Number(r.at) || now) >= MISS_MIN_AGE_MS) {
    Object.assign(r, { abandoned: true, state: 'unknown', detail: msg(r.misses) });
    persist();
    return 'abandoned';
  }
  persist();
  return 'missed';
}

/** 포탈 쪽 추적만 내린다(취소 요청인데 Director 가 그 실행을 모를 때). */
export function clearPending(id, message, now = Date.now()) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j?.pending) return null;
  if (j.cancelReq?.jobid === j.pending.jobid) j.cancelReq = null;   // v2.867 추적을 내린 실행의 취소 기록도 함께
  j.pending = null;
  j.lastError = { at: now, message: String(message || '').slice(0, 300) };
  persist();
  return copy(j);
}

/*
 * v2.822(검토 I3 — Bareos 소스 확인): `disable job=` 은 Director 메모리의 값만 바꾼다(ua_cmds.cc — conf 파일은 그대로).
 *   Director 를 reload·재시작하면 conf 값(기본 활성)으로 돌아가 **지운 대상·비활성 대상이 다시 스케줄 백업된다**. 지운 대상의 잡 이름을
 *   남겨 두고 폴러 대조 틱이 `.jobs` 의 enabled 를 보고 다시 끈다(비활성 대상은 원장 enabled:false 로 같은 처리).
 *   Director 에서 잡이 사라지면(관리자가 conf 를 지움) 기록도 지운다.
 */
/** 지운 잡 기록의 Director — v2.823 이전 기록은 Director 가 하나뿐이었다('dir_default'). */
export const retiredDir = (r) => (typeof r?.directorId === 'string' && r.directorId) || DEFAULT_DIRECTOR_ID;
function addRetired(db, name, demo, directorId = DEFAULT_DIRECTOR_ID) {
  if (!name) return;
  const dir = directorId || DEFAULT_DIRECTOR_ID;
  db.retired = [...(db.retired || []).filter((r) => !(r.name === name && retiredDir(r) === dir)), { name: String(name), directorId: dir, at: Date.now(), ...(demo ? { demo: true } : {}) }];
  db.retired = trimRetired(db.retired);
}
/** Director 에 잡만 남은 이름을 기록(원장 등록 실패 등) — 원장을 못 읽은 상태면 쓰지 않는다(빈 원장 저장이 보존본을 덮지 않게). */
export function retireName(name, demo = false, directorId = DEFAULT_DIRECTOR_ID) {
  const db = load();
  if (_loadErr.get()) return false;
  addRetired(db, name, demo, directorId);
  persist();
  return true;
}
export function retiredNames() { return (load().retired || []).map((r) => ({ ...r, directorId: retiredDir(r) })); }
/** @param {string} directorId @param {string[]} names 그 Director 에서 사라진 잡 이름(다른 Director 의 같은 이름 기록은 건드리지 않는다) */
export function forgetRetired(directorId, names) {
  const drop = new Set(names);
  const db = load();
  const before = (db.retired || []).length;
  db.retired = (db.retired || []).filter((r) => !(drop.has(r.name) && retiredDir(r) === directorId));
  if (db.retired.length !== before) persist();
}
export function jobCount() { return load().jobs.length; }

/** 트리 배지 — 이 vCenter 의 (활성) 백업 대상 vmId. */
export function jobVmIds(vcenterId) {
  return load().jobs.filter((j) => j.vcenterId === vcenterId && j.enabled).map((j) => j.vmId);
}

export function _resetForTest() { _db = null; _dirty = false; _loadErr.clear(); }
