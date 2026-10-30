/**
 * bareos/registry.js — 포탈의 Bareos 백업 대상 원장(v2.820). 파일: CONFIG_DIR/bareos-jobs.json (자격증명 없음 · 원자적 쓰기 · 손상 보존).
 *
 * job = {
 *   id, vcenterId, vmId, vmName, dc, folder,          // 등록 시점의 VM 위치(플러그인 옵션에 들어간 값 — 화면이 그대로 보인다)
 *   directorId,                                         // v2.823 등록 때의 법인 Director(잡은 그 Director 의 conf 에 있다 — 바꾸지 않는다. 옛 잡은 없음 → settings.jobDirectorId)
 *   bareosJob, client, storage, pool, schedule, level, // Director 에 만든 잡(이름은 names.jobNameFor)
 *   enabled, createdBy, createdAt, demo?,
 *   pending: { jobid, since, level, by, trigger } | null,   // 포탈이 실행했고 아직 끝나지 않은 백업
 *   lastRun: { jobid, status, state, level, startedAt, endedAt, bytes, files, errors, checkedAt } | null,
 *   lastError: { at, message } | null,
 *   missingInDirector: boolean,                         // Director `.jobs` 에 없으면 true(누가 conf 를 지웠다)
 *   restores: [ { jobid, fromJobids, mode, target, status, state, startedAt, endedAt, by, at } ],   // 최근 RESTORES_KEEP 건
 *   finishedRuns: [ { jobid, status, state, level, endedAt, errors, checkedAt } ],   // v2.822.3 끝난 백업 실행 최근 FINISHED_KEEP 건(실패 메일용)
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
import { DEFAULT_DIRECTOR_ID } from './settings.js';

export const FILE_NAME = 'bareos-jobs.json';
const FILE = () => path.join(config.configDir, 'bareos-jobs.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
// v2.828(사용자 승인 — 28개 법인 통합 화면): 500 → 3,000. 실측(scratch 벤치 · 대상마다 끝난 실행 10건): 5,000 이면 파일 8MB·한 번 쓰기 54ms·
//   listJobs 깊은 복사 47ms 로 폴링 주기마다 이벤트 루프를 오래 잡는다 — 3,000 은 그 6할(약 30ms). 더 올리려면 Director 별 파일 분할이 먼저다.
export const MAX_JOBS = 3000;
export const RESTORES_KEEP = 20;
export const RETIRED_KEEP = 1000;
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
        retired: (Array.isArray(p.retired) ? p.retired : []).filter((r) => r && typeof r.name === 'string' && r.name).slice(-RETIRED_KEEP),
      };
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
let _dirty = false;
export function inBatch(fn) {
  _batch += 1;
  try { return fn(); } finally {
    _batch -= 1;
    if (!_batch && _dirty) { _dirty = false; writeNow(); }
  }
}
let _rev = 0;
/** v2.828 원장 변경 리비전 — 조회 화면(bareos-summary·bareos-detail) 응답 캐시 키(저장 즉시 수가 바뀌게). */
export function registryRev() { return _rev; }
function persist() {
  _rev += 1;
  if (_batch) { _dirty = true; return; }
  writeNow();
}
function writeNow() {
  const db = load();
  // v2.828: 들여쓰기 없이 쓴다(3,000개에서 크기·직렬화 시간이 약 절반 — 위 MAX_JOBS 실측). 읽기는 예전 들여쓴 파일도 같다.
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, jobs: db.jobs, retired: db.retired }), { mode: 0o600 });
  _loadErr.clear();
}

const copy = (j) => (j ? JSON.parse(JSON.stringify(j)) : null);
export function listJobs() { return load().jobs.map(copy); }
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
    lastOkAt: lastOkAt(j),
    recentRuns: (Array.isArray(j.finishedRuns) ? j.finishedRuns : []).slice(-5).map((r) => ({ ...r })),
  }));
}
/** 마지막으로 **백업이 만들어진**(T 성공 · W 경고 — 둘 다 복원 지점이 생긴다) 실행이 끝난 시각. lastRun 이 실패여도 finishedRuns 에 있으면 그 시각. 모르면 null. */
function lastOkAt(j) {
  let best = null;
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
export function addJob(input) {
  const db = load();
  if (_loadErr.get()) throw new Error('백업 대상 원장을 읽지 못한 상태라 새 대상을 추가하지 않습니다(손상본 보존 — 다빈치 서비스 점검에서 확인).');
  if (db.jobs.length >= MAX_JOBS) throw new Error(`백업 대상은 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
  if (db.jobs.some((j) => j.vcenterId === input.vcenterId && j.vmId === input.vmId)) throw new Error('이 VM 은 이미 백업 대상입니다.');
  const job = {
    id: `bj_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    vcenterId: String(input.vcenterId), vmId: String(input.vmId), vmName: String(input.vmName),
    dc: String(input.dc), folder: String(input.folder),
    ...(input.directorId ? { directorId: String(input.directorId) } : {}),
    bareosJob: String(input.bareosJob), client: String(input.client), storage: String(input.storage), pool: String(input.pool),
    schedule: String(input.schedule || ''), level: String(input.level || 'Incremental'),
    enabled: true, createdBy: String(input.createdBy || ''), createdAt: Date.now(),
    ...(input.demo ? { demo: true } : {}),
    pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [],
  };
  const retiredBefore = db.retired;
  db.jobs.push(job);
  const sameRetired = (r) => r.name === job.bareosJob && retiredDir(r) === (job.directorId || DEFAULT_DIRECTOR_ID);
  if (db.retired?.some(sameRetired)) db.retired = db.retired.filter((r) => !sameRetired(r));   // 같은 Director 에서 같은 이름을 다시 쓰면 '지운 잡' 이 아니다
  // 파일에 못 쓰면 메모리에도 넣지 않는다(v2.822 — 예전에는 메모리에만 남아 화면은 '등록됨', 재시작하면 사라졌다)
  try { persist(); } catch (e) { db.jobs.pop(); db.retired = retiredBefore; throw e; }
  return copy(job);
}

/** 일부 필드 갱신(존재하지 않으면 null). */
export function patchJob(id, patch) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return null;
  const allowed = ['enabled', 'pending', 'lastRun', 'lastError', 'missingInDirector', 'schedule', 'level'];
  for (const k of allowed) if (Object.hasOwn(patch, k)) j[k] = patch[k];
  persist();
  return copy(j);
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
  const [j] = db.jobs.splice(i, 1);
  addRetired(db, j.bareosJob, !!j.demo, j.directorId || directorId || DEFAULT_DIRECTOR_ID);
  persist();
  return true;
}

/** 실행 시작 기록(포탈이 run 을 보냈다). */
export function markPending(id, { jobid, level, by, trigger = 'manual' }) {
  return patchJob(id, { pending: { jobid, since: Date.now(), level, by: String(by || ''), trigger }, lastError: null });
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
    const { jobid, status, state, level, endedAt, errors } = rec;
    j.finishedRuns = [...(Array.isArray(j.finishedRuns) ? j.finishedRuns : []), { jobid, status, state, level, endedAt, errors, checkedAt: now }]
      .sort((a, b) => a.jobid - b.jobid).slice(-FINISHED_KEEP);
    changed = true;
  }
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
  j.restores = [{ ...rec, status: 'C', state: 'queued', at: Date.now() }, ...(Array.isArray(j.restores) ? j.restores : [])].slice(0, RESTORES_KEEP);
  persist();
  return copy(j);
}

/** 복원 잡 상태 반영(폴러). */
export function applyRestoreRow(id, row, now = Date.now()) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  const r = j?.restores?.find((x) => x.jobid === row?.jobid);
  if (!r) return null;
  const changed = r.status !== row.status || (r.endedAt ?? null) !== (row.endedAt ?? null) || !!r.misses;
  Object.assign(r, { status: row.status, state: statusOf(row.status), startedAt: row.startedAt ?? r.startedAt ?? null, endedAt: row.endedAt ?? null, checkedAt: now, misses: 0 });
  if (changed) persist();
  return copy(j);
}

/** 아직 끝나지 않은(추적 중인) 복원인가 — 진행 중 409·복원 지점 화면·삭제 거부가 같은 판정을 쓴다. */
export const restoreOpen = (r) => !!r?.jobid && !isFinalStatus(r.status) && !r.abandoned;

/** 아직 끝나지 않은 실행(백업·복원) — 폴러가 이것만 조회한다. */
export function pendingWork() {
  const out = [];
  for (const j of load().jobs) {
    const dir = j.directorId || '';   // 옛 잡('')은 폴러가 settings.jobDirectorId 로 푼다
    if (j.pending?.jobid) out.push({ id: j.id, jobid: j.pending.jobid, kind: 'backup', job: j.bareosJob, demo: !!j.demo, directorId: dir, vcenterId: j.vcenterId });
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
  db.retired = [...(db.retired || []).filter((r) => !(r.name === name && retiredDir(r) === dir)), { name: String(name), directorId: dir, at: Date.now(), ...(demo ? { demo: true } : {}) }].slice(-RETIRED_KEEP);
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

export function _resetForTest() { _db = null; _loadErr.clear(); }
