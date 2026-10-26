/**
 * vmclone/store.js — VM 복제(백업식) 잡 저장소(v2.299).
 *
 * 사용자 요구사항(2026-08-15): "복제를 백업처럼" — vCenter 별로 VM 을 지정해 두면
 * ① 스케줄(매일 HH:MM 또는 N시간 간격)로 정기 복제 ② 대상은 datastore(서버측 클론) 또는
 * NFS(Edge 노드에 마운트한 경로로 파일 백업) ③ 최근 N개만 유지(보존정책).
 *
 * 저장 파일: CONFIG_DIR/vm-clone.json → { version:1, jobs:[...] }
 * job = {
 *   id, vcenterId, vmId, vmName,                     // 대상 VM(지정 시점의 이름 — 표시/클론 명명용)
 *   dest: { type:'datastore'|'nfs',
 *           datastoreName?,                          // datastore: 대상 데이터스토어 이름(스냅샷 스토어에서 MoRef 해석)
 *           mountId?, subdir? },                     // nfs: 설정 › NFS 마운트 의 항목 id + 하위 경로
 *   schedule: { mode:'manual'|'daily'|'interval', time?:'HH:MM', hours?:N },
 *   keep: N,                                        // 보존 개수(1~30)
 *   quiesce: bool,                                  // 정지점 스냅샷(VMware Tools VSS/freeze) 경유 — 앱 정합
 *   enabled: bool,
 *   clones: [{ name, ref, at }],                    // 우리가 만든 datastore 클론 원장 — ⚠ 보존정책은
 *                                                   //   **이 원장에 있는 VM만** 삭제한다(이름 패턴만 믿고
 *                                                   //   지우면 동명 수동 VM 오삭제 사고 — 절대 완화 금지)
 *   lastRun: { at, ok, detail, ms } | null,
 *   // v2.793(VM 백업 센터) — 아래는 모두 선택 필드다(이전 판 파일을 그대로 읽는다).
 *   verifyAfter: bool,                              // 백업 직후 사본 검증(데이터스토어 대상만 — vmclone/vsOps.js verifyClone)
 *   history: [{ at, kind, ok, detail, ms, trigger?, skipped?, phases? }],   // 최근 HISTORY_MAX 회(백업·검증·복구)
 *   clones[].bytes · clones[].verify{at,ok,detail}, // 사본 크기(커밋 바이트 — 못 읽으면 없음) · 마지막 검증 결과
 *   origin: 'central',                              // 엣지 전용 — 중앙이 위임한 잡(applyDelegatedJobs 만 만들고 고친다)
 * }
 * ops: [{ id, kind, jobId, vcenterId, vmName, at, ok, detail, ms, by }]  // 검증·복구·NFS 데이터스토어 연결 기록(최근 OPS_MAX)
 *
 * 원자적 쓰기 + 손상 보존(server/CLAUDE.md 자격증명 파일 규칙과 동일 패턴 — 이 파일은 잡
 * 정의라 자격증명은 없지만, 로드 손상 → 빈 목록 → 다음 저장이 원장(clones)을 덮어쓰면
 * 보존정책이 고아 클론을 인식 못 해 스토리지가 새는 같은 구조의 사고가 난다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { portalParts, portalMs, localStamp } from '../util/dayKey.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';

const FILE = path.join(config.configDir, 'vm-clone.json');
const MAX_JOBS = 200;
export const HISTORY_MAX = 30;
export const OPS_MAX = 100;

let _db = null;

/*
 * v2.793: 로드 오류 상태 — 이 파일은 이제 엣지에 **배포되는 설정**이다(central/vmCloneEdge.js 가 site vCenter 의 잡을 담당 엣지에 내려준다).
 *   손상 → preserveCorrupt → 빈 목록을 200 으로 내려보내면 엣지가 위임 잡을 전부 지운다(v2.631 EDGE2631-01 과 같은 구조).
 *   오류인 동안 위임 동기화 라우트는 503 settingsUnreadable 로 답하고, 관리자 저장(saveJob·deleteJob)이 풀어 준다.
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'VM 백업 잡(vm-clone.json)', confirm: () => persistByAdmin() });
/** 잡 파일을 못 읽었으면 { at, reason }, 읽었으면 null — 위임 동기화 라우트가 응답 전에 본다. */
export function jobsLoadError() { load(); return _loadErr.get(); }

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { jobs: Array.isArray(p.jobs) ? p.jobs : [], ops: Array.isArray(p.ops) ? p.ops : [] };
      _loadErr.ok();
      return _db;
    }
    _loadErr.missing();
  } catch (e) {
    _loadErr.corrupt(e);
    preserveCorrupt(FILE); // 파싱 실패 원본 보존 — 빈 목록 저장이 클론 원장을 지우는 사고 방지
  }
  _db = { jobs: [], ops: [] };
  return _db;
}

function writeFile() {
  const db = load();
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, jobs: db.jobs, ops: db.ops }, null, 2), { mode: 0o600 });
}
/**
 * 실행·작업 기록 저장. ⚠ 로드 오류(손상 보존본만 남음) 동안은 **파일을 쓰지 않는다**(메모리에만 둔다) — 쓰면 빈 잡 목록이
 *   '정상 파일' 이 되어 재시작 뒤 위임 동기화가 200 jobs:[] 를 내려보내고, 엣지가 위임 잡과 클론 원장을 지운다(v2.793 반증 검토 F2).
 *   관리자 저장(persistByAdmin)·'기본값으로 확정' 만 파일을 쓰고 오류를 푼다.
 */
let _heldWarned = false;
function persist() {
  load();
  if (_loadErr.get()) {
    if (!_heldWarned) { _heldWarned = true; console.warn('[vmclone] vm-clone.json 을 읽지 못한 상태라 실행 기록을 파일에 쓰지 않습니다(메모리에만) — 손상 보존본을 되돌리거나 VM 백업 화면에서 잡을 저장하면 다시 씁니다'); }
    return;
  }
  writeFile();
}
/** 관리자 저장 — 쓰기에 성공하면 로드 오류를 푼다(그 저장이 지금 보이는 목록을 확정한다). */
function persistByAdmin() { writeFile(); _loadErr.ok(); _heldWarned = false; }

const clampKeep = (n) => Math.max(1, Math.min(30, Math.floor(Number(n)) || 3));

/** 스케줄 정규화 — 무효값은 manual(자동 실행 없음)로. time 은 'HH:MM' 24시간제. */
function normSchedule(s = {}) {
  if (s.mode === 'daily') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s.time || ''));
    return m ? { mode: 'daily', time: `${m[1].padStart(2, '0')}:${m[2]}` } : { mode: 'manual' };
  }
  if (s.mode === 'interval') {
    const h = Math.max(1, Math.min(168, Math.floor(Number(s.hours)) || 24));
    return { mode: 'interval', hours: h };
  }
  return { mode: 'manual' };
}

export function listJobs() { return load().jobs.map((j) => ({ ...j })); }
export function getJob(id) { return load().jobs.find((j) => j.id === id) || null; }

/**
 * 잡 정의 정규화(순수 — 저장·엣지 위임 동기화가 같은 규칙을 쓴다). 실행 상태(clones·history·lastRun·running)는 다루지 않는다.
 * @returns {{vcenterId,vmId,vmName,dest,schedule,keep,quiesce,enabled,verifyAfter}} 무효면 throw
 */
export function normalizeJobDef(input = {}) {
  const vcenterId = String(input.vcenterId || '').trim().slice(0, 200);
  const vmId = String(input.vmId || '').trim().slice(0, 300);
  const vmName = String(input.vmName || '').trim().slice(0, 200);
  if (!vcenterId || !vmId || !vmName) throw new Error('vCenter·VM 지정이 필요합니다.');
  const destType = input.dest?.type === 'nfs' ? 'nfs' : 'datastore';
  const dest = destType === 'nfs'
    ? {
      type: 'nfs',
      mountId: String(input.dest?.mountId || '').trim().slice(0, 80),
      // 하위 경로는 슬러그만(경로 탈출 차단 — NFS 루트 밖으로 나가는 subdir 금지)
      subdir: String(input.dest?.subdir || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64),
    }
    : {
      type: 'datastore', datastoreName: String(input.dest?.datastoreName || '').trim().slice(0, 200),
      // v2.793: 법인 설정의 ESXi NFS 데이터스토어를 고른 잡(표시용 연결 — 실행은 이름으로 해석하는 datastore 경로 그대로다)
      ...(typeof input.dest?.nfsDsId === 'string' && input.dest.nfsDsId.trim() ? { nfsDsId: input.dest.nfsDsId.trim().slice(0, 80) } : {}),
    };
  if (dest.type === 'nfs' && !dest.mountId) throw new Error('NFS 대상은 마운트 항목을 선택해야 합니다(설정 › NFS 마운트).');
  if (dest.type === 'datastore' && !dest.datastoreName) throw new Error('대상 데이터스토어를 선택하세요.');
  return {
    vcenterId, vmId, vmName, dest,
    schedule: normSchedule(input.schedule),
    keep: clampKeep(input.keep),
    quiesce: !!input.quiesce,
    enabled: input.enabled !== false,
    // 검증은 vCenter 에 등록된 사본(데이터스토어 대상)만 켤 수 있다 — NFS 파일 사본은 켤 VM 이 없다.
    verifyAfter: dest.type === 'datastore' && input.verifyAfter === true,
  };
}

/**
 * v2.793(반증 검토 F3) — 엣지 전용: 중앙이 '이 엣지 담당이 아니다' 라고 밝힌 vCenter(담당 변경·충돌·등록부에서 삭제)의 위임 잡을
 * **멈춘다**(suspended). 지우지 않는다 — 담당이 잠깐 바뀐 설정 실수로 클론 원장·이력이 사라지지 않게. 스케줄러가 건너뛰고,
 * 담당이 돌아오면 applyDelegatedJobs 가 푼다. 같은 VM 을 두 엣지가 스냅샷하지 않게 하는 것이 목적이다.
 * @returns {number} 새로 멈춘 수
 */
export function suspendDelegated(vcenterIds, reason) {
  const set = new Set((vcenterIds || []).map(String));
  if (!set.size) return 0;
  const why = String(reason || '중앙이 이 vCenter 를 이 엣지 담당으로 보지 않습니다').slice(0, 200);
  let n = 0;
  for (const j of load().jobs) {
    if (!isDelegatedJob(j) || !set.has(String(j.vcenterId)) || j.suspended) continue;
    j.suspended = why; n++;
  }
  if (n) persist();
  return n;
}

/** 엣지가 중앙에서 받아 둔 위임 잡인가(이 노드의 화면·API 로 고치거나 지우지 않는다). */
export const isDelegatedJob = (j) => j?.origin === 'central';

export function saveJob(input = {}) {
  const db = load();
  const def = normalizeJobDef(input);
  const existing = input.id ? db.jobs.find((j) => j.id === input.id) : null;
  if (existing && isDelegatedJob(existing)) throw new Error('중앙에서 위임한 잡입니다 — 중앙 포탈의 VM 백업 화면에서 고치세요.');
  const job = existing || { id: `vc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, clones: [], lastRun: null, createdAt: Date.now() };
  Object.assign(job, {
    ...def,
    // v2.719(감사 R1-07): 데모 표지 — 새 잡에만 입력으로 받고, 수정은 기존 표지를 유지한다(live 스케줄러가 건너뛴다).
    demo: existing ? existing.demo === true : input.demo === true,
  });
  if (!job.demo) delete job.demo;
  if (!job.verifyAfter) delete job.verifyAfter;
  if (!existing) {
    if (db.jobs.length >= MAX_JOBS) throw new Error(`복제 잡은 최대 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
    // 같은 VM 에 잡 중복 금지 — 같은 VM 을 두 잡이 스냅샷/클론하면 서로 간섭한다.
    if (db.jobs.some((j) => j.vcenterId === def.vcenterId && j.vmId === def.vmId)) throw new Error('이 VM 에는 이미 복제 잡이 있습니다(수정으로 변경하세요).');
    db.jobs.push(job);
  }
  persistByAdmin();
  return { ...job };
}

export function deleteJob(id) {
  const db = load();
  const i = db.jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  if (isDelegatedJob(db.jobs[i])) throw new Error('중앙에서 위임한 잡입니다 — 중앙 포탈의 VM 백업 화면에서 지우세요.');
  // 잡 삭제는 정의만 지운다 — 만들어 둔 클론 VM/NFS 사본은 남긴다(백업을 지우는 파괴 행위는
  // 사용자가 vCenter/NAS 에서 직접, 또는 보존정책이 잡이 살아있는 동안만 수행).
  db.jobs.splice(i, 1);
  persistByAdmin();
  return true;
}

/**
 * v2.793 — 엣지 전용: 중앙이 위임한 잡 정의를 로컬 저장소에 맞춘다(실행은 이 노드의 기존 스케줄러·실행기가 한다).
 *  · 정의 필드만 덮고 실행 상태(clones 원장·history·lastRun·running)는 그대로 둔다 — 보존정책 원장의 진실은 실행하는 엣지다.
 *  · 지우기는 **중앙이 이 엣지 담당이라고 확인한 vCenter(`ownedVcenterIds`)의 잡만** 한다. 중앙이 담당을 모르는 동안(재시작 직후·
 *    담당 충돌)은 지우지 않는다 — 빈 목록 한 번으로 백업이 멈추지 않게. 지우는 것은 정의뿐이다(사본은 남는다 — deleteJob 과 같다).
 *  · 같은 VM 에 이 노드가 직접 만든 잡이 있으면 받지 않는다(같은 VM 을 두 잡이 스냅샷하면 서로 간섭한다) — conflicts 로 밝힌다.
 * @returns {{added:number, updated:number, removed:number, conflicts:string[], invalid:string[]}}
 */
export function applyDelegatedJobs(defs, ownedVcenterIds) {
  const db = load();
  const owned = new Set((ownedVcenterIds || []).map(String));
  const seen = new Set();
  const out = { added: 0, updated: 0, removed: 0, conflicts: [], invalid: [] };
  let dirty = false;
  for (const raw of Array.isArray(defs) ? defs.slice(0, MAX_JOBS) : []) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().slice(0, 80) : '';
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) { out.invalid.push(String(id || '(id 없음)').slice(0, 80)); continue; }
    seen.add(id);   // 받은 id 는 정의가 무효여도 지우지 않는다(무효 정의 한 번으로 원장·이력이 사라지지 않게 — 이전 정의로 계속 돈다)
    let def;
    try { def = normalizeJobDef(raw); } catch (e) { out.invalid.push(`${id}: ${e.message}`); continue; }
    if (!owned.has(def.vcenterId)) { out.invalid.push(`${id}: 이 엣지 담당이 아닌 vCenter`); continue; }
    const cur = db.jobs.find((j) => j.id === id);
    if (cur && !isDelegatedJob(cur)) { out.conflicts.push(`${id}: 같은 id 의 로컬 잡이 있습니다`); continue; }
    const clash = db.jobs.find((j) => j.id !== id && j.vcenterId === def.vcenterId && j.vmId === def.vmId);
    if (clash) { out.conflicts.push(`${def.vmName}: 이 노드에 같은 VM 의 잡(${clash.id})이 있어 받지 않았습니다`); continue; }
    if (!cur) {
      if (db.jobs.length >= MAX_JOBS) { out.invalid.push(`${id}: 잡 상한(${MAX_JOBS}) 초과`); continue; }
      db.jobs.push({ id, ...def, origin: 'central', clones: [], lastRun: null, createdAt: Date.now() });
      out.added++; dirty = true;
      continue;
    }
    if (cur.suspended) { delete cur.suspended; out.resumed = (out.resumed || 0) + 1; dirty = true; }   // 담당이 돌아왔다(F3)
    const before = JSON.stringify([cur.vcenterId, cur.vmId, cur.vmName, cur.dest, cur.schedule, cur.keep, cur.quiesce, cur.enabled, !!cur.verifyAfter]);
    const after = JSON.stringify([def.vcenterId, def.vmId, def.vmName, def.dest, def.schedule, def.keep, def.quiesce, def.enabled, def.verifyAfter]);
    if (before !== after) {
      Object.assign(cur, def);
      if (!cur.verifyAfter) delete cur.verifyAfter;
      out.updated++; dirty = true;
    }
  }
  for (let i = db.jobs.length - 1; i >= 0; i--) {
    const j = db.jobs[i];
    if (!isDelegatedJob(j) || seen.has(j.id) || !owned.has(String(j.vcenterId))) continue;
    if (j.running) continue;   // 실행 중(또는 재시작 정리 대기) 기록이 남은 잡은 정리가 끝날 때까지 둔다 — 스냅샷이 남는다
    db.jobs.splice(i, 1); out.removed++; dirty = true;
  }
  if (dirty) persist();
  return out;
}

/*
 * ── v2.741(감사 TIMING-01) 실행 중 기록 ────────────────────────────────────────
 * 실행 상태(runner 의 _running)는 메모리에만 있어, 스냅샷을 만든 뒤 업그레이드·재시작이 오면 finally 의 스냅샷 삭제가 불리지 않았다.
 * 원본 VM 에 portal-clone-* 스냅샷이 남았고, lastRun 은 어제 기록 그대로라 재기동 1분 뒤 같은 잡이 다시 돌아 **스냅샷을 겹쳐** 만들었다.
 *  · 실행을 시작하면 잡에 `running`(스냅샷 이름·ref·클론 이름·NFS 폴더·시작 시각·이 프로세스 표지)을 **동기로** 남기고, 끝나면 지운다.
 *  · 기록의 `boot` 가 이 프로세스의 BOOT_ID 와 다르면 '이전 프로세스가 끝내지 못한 실행' 이다. 기동 때 lastRun 에 그 사실을 남기고
 *    (markInterruptedRuns), 다음 실행이 **새 스냅샷을 만들기 전에** 남은 스냅샷을 지운다(runner). 못 지우면 새 스냅샷을 만들지 않고
 *    RECOVER_RETRY_MS 뒤 다시 시도하며, RECOVER_GIVE_UP_MS 가 지나면 수동 삭제를 안내하고 기록을 내린다(보류에는 시한).
 *  · 다시 실행은 사슬마다 RESUME_LIMIT 번까지 · 시작한 지 RESUME_EXPIRE_MS 가 지난 실행은 정리만 한다(util/scanJournal 과 같은 값).
 */
export const BOOT_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const RECOVER_RETRY_MS = 10 * 60_000;
export const RECOVER_GIVE_UP_MS = 6 * 3_600_000;   // 클론 태스크 시한(4시간) + 스냅샷 병합 여유
export const RESUME_LIMIT = 2;
export const RESUME_EXPIRE_MS = 48 * 3_600_000;

const RUN_STR_KEYS = ['trigger', 'vmRef', 'snapName', 'snapRef', 'cloneName', 'destDir', 'phase', 'lastError'];
const RUN_NUM_KEYS = ['at', 'resumes', 'detectedAt', 'tries', 'nextAt'];
function cleanRunning(rec) {
  const out = {};
  for (const k of RUN_STR_KEYS) if (typeof rec?.[k] === 'string' && rec[k]) out[k] = rec[k].slice(0, k === 'destDir' ? 1024 : 300);
  for (const k of RUN_NUM_KEYS) { const n = Number(rec?.[k]); if (rec?.[k] != null && rec[k] !== '' && Number.isFinite(n)) out[k] = n; }
  if (typeof rec?.boot === 'string') out.boot = rec.boot.slice(0, 80);
  return out;
}

/** 실행 시작 기록(runner 전용) — 이 프로세스 표지와 시작 시각을 붙여 동기로 쓴다. */
export function setRunning(id, rec = {}) {
  const j = load().jobs.find((x) => x.id === id);
  if (!j) return;
  j.running = cleanRunning({ ...rec, at: Date.now(), boot: BOOT_ID });
  persist();
}
/** 실행 기록 갱신(스냅샷 ref·단계 등). 기본은 이 프로세스의 기록만 — anyBoot 면 이전 프로세스의 기록도(정리 재시도 표지). */
export function patchRunning(id, patch = {}, { anyBoot = false } = {}) {
  const j = load().jobs.find((x) => x.id === id);
  if (!j?.running || (!anyBoot && j.running.boot !== BOOT_ID)) return;
  j.running = cleanRunning({ ...j.running, ...patch, boot: j.running.boot });
  persist();
}
/** 실행 기록 지우기. 기본은 이 프로세스의 기록만(이전 프로세스의 기록은 정리가 끝났을 때만 anyBoot 로 지운다). */
export function clearRunning(id, { anyBoot = false } = {}) {
  const j = load().jobs.find((x) => x.id === id);
  if (!j?.running || (!anyBoot && j.running.boot !== BOOT_ID)) return;
  delete j.running;
  persist();
}
/** 이전 프로세스가 끝내지 못한 실행 기록(없으면 null). */
export function interruptedRunOf(job) {
  const r = job?.running;
  return r && typeof r === 'object' && r.boot !== BOOT_ID ? r : null;
}
/** 남은 스냅샷 정리(와 다시 실행)를 지금 시도할 차례인가 — 켜진 잡 · 이전 프로세스의 기록 · 재시도 시각 도래. */
export function recoveryDue(job, now = Date.now()) {
  const r = interruptedRunOf(job);
  if (!r || !job.enabled) return false;
  return !(Number(r.nextAt) > now);
}

/**
 * 기동 때 1회(scheduler) — 이전 프로세스가 끝내지 못한 실행을 lastRun 에 '재시작으로 중단' 으로 남긴다(화면이 말하게).
 * 이미 남긴 기록(detectedAt)은 다시 덮지 않는다(재시도 결과를 지우지 않게). @returns 새로 찾은 개수
 */
export function markInterruptedRuns(now = Date.now()) {
  const db = load();
  let n = 0;
  for (const j of db.jobs) {
    const r = interruptedRunOf(j);
    if (!r || r.detectedAt) continue;
    r.detectedAt = now;
    const snap = r.snapName ? `스냅샷 ‘${r.snapName}’` : '스냅샷';
    const next = !j.enabled ? `잡이 꺼져 있어 다시 켜면 남은 ${snap} 을 정리합니다`
      : (r.resumes || 0) >= RESUME_LIMIT || (r.at && now - r.at > RESUME_EXPIRE_MS)
        ? `곧 남은 ${snap} 을 정리합니다(다시 실행은 하지 않습니다 — 자동 재실행 상한·시한)`
        : `곧 남은 ${snap} 을 정리한 뒤 다시 실행합니다`;
    j.lastRun = { at: now, ok: false, skipped: 'restart-interrupted', detail: `업그레이드·서비스 재시작으로 실행이 중단됐습니다(${(r.at && localStamp(r.at)) || '시작 시각 모름'} 시작) — ${next}.`.slice(0, 400), ms: 0 };
    pushHistory(j, { at: now, kind: 'backup', ok: false, skipped: 'restart-interrupted', detail: j.lastRun.detail.slice(0, 300), ms: 0 });
    n++;
  }
  if (n) persist();
  return n;
}

/** 단계 기록 정규화 — [{n: 단계 이름, ms}] 최대 12개(화면의 세션 타임라인). */
function cleanPhases(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list.slice(0, 12) : []) {
    const n = typeof p?.n === 'string' ? p.n.slice(0, 60) : '';
    const ms = Number(p?.ms);
    if (n && Number.isFinite(ms) && ms >= 0) out.push({ n, ms: Math.round(ms), ...(p.ok === false ? { ok: false } : {}) });
  }
  return out;
}

/** 이력 한 줄 추가(최근 HISTORY_MAX 회만). kind: backup | verify | restore. */
function pushHistory(j, entry) {
  if (!Array.isArray(j.history)) j.history = [];
  j.history.push(entry);
  if (j.history.length > HISTORY_MAX) j.history.splice(0, j.history.length - HISTORY_MAX);
}

/**
 * 실행 결과 반영(runner 전용) — clones 원장 갱신 + lastRun + 이력(v2.793).
 * `lastRun` 은 **백업 실행**만 뜻한다(스케줄 도래 판정 isDue 가 이 값을 본다 — 검증·복구 기록이 바꾸면 안 된다).
 */
export function recordRun(id, { ok, detail, ms, addClone = null, removeCloneRefs = [], skipped = '', authStopped = null, trigger = '', phases = null, history = true, historyAt = null }) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return;
  if (addClone) j.clones.push(addClone);
  if (removeCloneRefs.length) j.clones = j.clones.filter((c) => !removeCloneRefs.includes(c.ref));
  // v2.591: 건너뛴 실행은 사유(skipped)·정지 기록(authStopped)을 함께 남긴다 — 화면이 '실패' 와 구분해 말한다.
  j.lastRun = { at: Date.now(), ok: !!ok, detail: String(detail || '').slice(0, 400), ms: ms || 0, ...(skipped ? { skipped: String(skipped).slice(0, 40) } : {}), ...(authStopped ? { authStopped } : {}) };
  // 스냅샷 경고 덧붙이기처럼 같은 실행을 다시 적는 호출(history:false)은 마지막 이력 줄만 고친다(한 실행이 두 줄이 되지 않게).
  if (history) {
    const ph = cleanPhases(phases);
    // historyAt: 데모 시드 전용(과거 실행을 그 시각으로 남긴다) — lastRun.at(스케줄 판정)은 언제나 지금이다.
    pushHistory(j, { at: Number(historyAt) > 0 ? Number(historyAt) : j.lastRun.at, kind: 'backup', ok: j.lastRun.ok, detail: j.lastRun.detail.slice(0, 300), ms: j.lastRun.ms,
      ...(trigger ? { trigger: String(trigger).slice(0, 20) } : {}), ...(skipped ? { skipped: j.lastRun.skipped } : {}), ...(ph.length ? { phases: ph } : {}) });
  } else if (Array.isArray(j.history) && j.history.length && j.history[j.history.length - 1].kind === 'backup') {
    const last = j.history[j.history.length - 1];
    last.detail = j.lastRun.detail.slice(0, 300); last.ok = j.lastRun.ok;
  }
  persist();
}

/** 마지막 백업 이력 줄에 단계를 덧붙인다(실행기가 결과를 적은 뒤의 스냅샷 병합 — 화면 타임라인이 끝까지 보이게). */
export function appendBackupPhases(id, extra) {
  const j = load().jobs.find((x) => x.id === id);
  const last = Array.isArray(j?.history) ? j.history[j.history.length - 1] : null;
  if (!last || last.kind !== 'backup') return;
  const ph = cleanPhases([...(last.phases || []), ...(extra || [])]);
  if (ph.length) last.phases = ph;
  persist();
}

/** 원장 사본의 부가 정보(크기·검증 결과)를 고친다 — 원장에 없는 ref 는 무시(지어내지 않는다). */
export function patchClone(id, ref, patch = {}) {
  const j = load().jobs.find((x) => x.id === id);
  const c = j?.clones?.find((x) => x.ref === ref);
  if (!c) return false;
  const bytes = Number(patch.bytes);
  if (patch.bytes != null && Number.isFinite(bytes) && bytes >= 0) c.bytes = Math.round(bytes);
  if (patch.verify && typeof patch.verify === 'object') {
    c.verify = { at: Number(patch.verify.at) || Date.now(), ok: !!patch.verify.ok, detail: String(patch.verify.detail || '').slice(0, 300) };
  }
  persist();
  return true;
}

/** 검증·복구 결과를 잡 이력에 남긴다(lastRun 은 건드리지 않는다 — 스케줄 판정 보호). */
export function recordJobEvent(id, { kind, ok, detail, ms = 0, trigger = '', phases = null, at = null }) {
  const j = load().jobs.find((x) => x.id === id);
  if (!j || !['verify', 'restore'].includes(kind)) return;
  const ph = cleanPhases(phases);
  pushHistory(j, { at: Number(at) > 0 ? Number(at) : Date.now(), kind, ok: !!ok, detail: String(detail || '').slice(0, 300), ms: Math.max(0, Math.round(Number(ms) || 0)),
    ...(trigger ? { trigger: String(trigger).slice(0, 20) } : {}), ...(ph.length ? { phases: ph } : {}) });
  persist();
}

/** 작업(검증·복구·NFS 데이터스토어 연결·지금 실행 위임) 기록 — 최근 OPS_MAX 건. */
export function recordOp(op = {}) {
  const db = load();
  const rec = {
    id: String(op.id || `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).slice(0, 80),
    kind: String(op.kind || '').slice(0, 20), at: Number(op.at) || Date.now(), ok: !!op.ok,
    detail: String(op.detail || '').slice(0, 400), ms: Math.max(0, Math.round(Number(op.ms) || 0)),
    ...(op.jobId ? { jobId: String(op.jobId).slice(0, 80) } : {}),
    ...(op.vcenterId ? { vcenterId: String(op.vcenterId).slice(0, 200) } : {}),
    ...(op.vmName ? { vmName: String(op.vmName).slice(0, 200) } : {}),
    ...(op.target ? { target: String(op.target).slice(0, 200) } : {}),
    ...(op.agent ? { agent: String(op.agent).slice(0, 64) } : {}),
    ...(op.by ? { by: String(op.by).slice(0, 80) } : {}),
  };
  // 같은 작업의 늦은 회신(시한으로 닫힌 뒤 도착한 결과)은 새 줄이 아니라 그 줄을 고친다.
  const at = db.ops.findIndex((o) => o.id === rec.id);
  if (at >= 0) db.ops[at] = rec; else db.ops.push(rec);
  if (db.ops.length > OPS_MAX) db.ops.splice(0, db.ops.length - OPS_MAX);
  persist();
  return rec;
}
export function listOps() { return load().ops.map((o) => ({ ...o })); }

/**
 * 스케줄 도래 판정(순수 — vmcloneStore.test.js 로 고정).
 * daily: 오늘 그 시각이 지났고, 마지막 실행이 오늘 그 시각 이전이면 due.
 * interval: 마지막 실행 후 hours 경과. manual/비활성: 항상 false.
 */
export function isDue(job, now = Date.now()) {
  if (!job?.enabled) return false;
  const s = job.schedule || {};
  const last = job.lastRun?.at || 0;
  if (s.mode === 'interval') return now - last >= s.hours * 3600_000;
  if (s.mode === 'daily') {
    const [hh, mm] = s.time.split(':').map(Number);
    // v2.590 P8: '매일 HH:MM' 은 **포탈 시각**(util/dayKey — 기본 KST)이다. setHours(프로세스 TZ)로 두면 TZ 를 지정하지
    // 않는 패키지 unit(UTC 호스트)에서 02:00 잡이 한국 11:00(업무 시간)에 돌았다(v2.582 '스케줄 판정도 localClock' 규약).
    const { y, mo, d } = portalParts(now);
    const target = portalMs(y, mo, d, hh) + mm * 60_000;
    return now >= target && last < target;
  }
  return false;
}

/** 보존 대상 계산(순수) — keep 개를 남기고 오래된 것부터 삭제 목록으로. */
export function pruneList(clones, keep) {
  const sorted = [...(clones || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
  const excess = sorted.length - clampKeep(keep);
  return excess > 0 ? sorted.slice(0, excess) : [];
}

/** 트리 배지용 — vCenter 의 복제 잡 대상 vmId 목록(뷰가 'Clone' 아이콘 표시). */
export function jobVmIds(vcenterId) {
  return load().jobs.filter((j) => j.vcenterId === vcenterId && j.enabled).map((j) => j.vmId);
}

export function _resetForTest() { _db = null; } // CONFIG_DIR 교체 테스트용
