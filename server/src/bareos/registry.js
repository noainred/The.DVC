/**
 * bareos/registry.js — 포탈의 Bareos 백업 대상 원장(v2.747). 파일: CONFIG_DIR/bareos-jobs.json (자격증명 없음 · 원자적 쓰기 · 손상 보존).
 *
 * job = {
 *   id, vcenterId, vmId, vmName, dc, folder,          // 등록 시점의 VM 위치(플러그인 옵션에 들어간 값 — 화면이 그대로 보인다)
 *   bareosJob, client, storage, pool, schedule, level, // Director 에 만든 잡(이름은 names.jobNameFor)
 *   enabled, createdBy, createdAt, demo?,
 *   pending: { jobid, since, level, by, trigger } | null,   // 포탈이 실행했고 아직 끝나지 않은 백업
 *   lastRun: { jobid, status, state, level, startedAt, endedAt, bytes, files, errors, checkedAt } | null,
 *   lastError: { at, message } | null,
 *   missingInDirector: boolean,                         // Director `.jobs` 에 없으면 true(누가 conf 를 지웠다)
 *   restores: [ { jobid, fromJobids, mode, target, status, state, startedAt, endedAt, by, at } ],   // 최근 RESTORES_KEEP 건
 * }
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

export const FILE_NAME = 'bareos-jobs.json';
const FILE = () => path.join(config.configDir, 'bareos-jobs.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
export const MAX_JOBS = 500;
export const RESTORES_KEEP = 20;

let _db = null;
const _loadErr = makeLoadError();

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _db = { jobs: (Array.isArray(p.jobs) ? p.jobs : []).filter((j) => j && typeof j === 'object' && typeof j.id === 'string') };
      _loadErr.clear();
      return _db;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 백업 대상 원장을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다.`);
  }
  _loadErr.checkCorruptOnly(FILE());
  _db = { jobs: [] };
  return _db;
}

/** 원장을 읽지 못했나(손상) — 쓰기 라우트는 이 상태에서 새 잡을 만들지 않는다(빈 원장 저장이 보존본을 덮지 않게). */
export function registryLoadError() { load(); return _loadErr.get(); }

function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, jobs: load().jobs }, null, 2), { mode: 0o600 });
  _loadErr.clear();
}

const copy = (j) => (j ? JSON.parse(JSON.stringify(j)) : null);
export function listJobs() { return load().jobs.map(copy); }
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
    bareosJob: String(input.bareosJob), client: String(input.client), storage: String(input.storage), pool: String(input.pool),
    schedule: String(input.schedule || ''), level: String(input.level || 'Incremental'),
    enabled: true, createdBy: String(input.createdBy || ''), createdAt: Date.now(),
    ...(input.demo ? { demo: true } : {}),
    pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [],
  };
  db.jobs.push(job);
  persist();
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

export function deleteJob(id) {
  const db = load();
  const i = db.jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  db.jobs.splice(i, 1);
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
  if (j.pending && j.pending.jobid === row.jobid) {
    if (isFinalStatus(row.status)) { j.pending = null; changed = true; }
    else if (j.pending.status !== row.status) { j.pending = { ...j.pending, status: row.status, state: rec.state }; changed = true; }
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
  const changed = r.status !== row.status || (r.endedAt ?? null) !== (row.endedAt ?? null);
  Object.assign(r, { status: row.status, state: statusOf(row.status), startedAt: row.startedAt ?? r.startedAt ?? null, endedAt: row.endedAt ?? null, checkedAt: now });
  if (changed) persist();
  return copy(j);
}

/** 아직 끝나지 않은 실행(백업·복원) — 폴러가 이것만 조회한다. */
export function pendingWork() {
  const out = [];
  for (const j of load().jobs) {
    if (j.pending?.jobid) out.push({ id: j.id, jobid: j.pending.jobid, kind: 'backup', demo: !!j.demo });
    for (const r of j.restores || []) if (r.jobid && !isFinalStatus(r.status)) out.push({ id: j.id, jobid: r.jobid, kind: 'restore', demo: !!j.demo });
  }
  return out;
}

/** 트리 배지 — 이 vCenter 의 (활성) 백업 대상 vmId. */
export function jobVmIds(vcenterId) {
  return load().jobs.filter((j) => j.vcenterId === vcenterId && j.enabled).map((j) => j.vmId);
}

export function _resetForTest() { _db = null; _loadErr.clear(); }
