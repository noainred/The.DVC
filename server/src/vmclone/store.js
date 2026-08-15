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
 * }
 *
 * 원자적 쓰기 + 손상 보존(server/CLAUDE.md 자격증명 파일 규칙과 동일 패턴 — 이 파일은 잡
 * 정의라 자격증명은 없지만, 로드 손상 → 빈 목록 → 다음 저장이 원장(clones)을 덮어쓰면
 * 보존정책이 고아 클론을 인식 못 해 스토리지가 새는 같은 구조의 사고가 난다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'vm-clone.json');
const MAX_JOBS = 200;

let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { jobs: Array.isArray(p.jobs) ? p.jobs : [] };
      return _db;
    }
  } catch {
    preserveCorrupt(FILE); // 파싱 실패 원본 보존 — 빈 목록 저장이 클론 원장을 지우는 사고 방지
  }
  _db = { jobs: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, jobs: load().jobs }, null, 2), { mode: 0o600 });
}

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

export function saveJob(input = {}) {
  const db = load();
  const vcenterId = String(input.vcenterId || '').trim();
  const vmId = String(input.vmId || '').trim();
  const vmName = String(input.vmName || '').trim();
  if (!vcenterId || !vmId || !vmName) throw new Error('vCenter·VM 지정이 필요합니다.');
  const destType = input.dest?.type === 'nfs' ? 'nfs' : 'datastore';
  const dest = destType === 'nfs'
    ? {
      type: 'nfs',
      mountId: String(input.dest?.mountId || '').trim(),
      // 하위 경로는 슬러그만(경로 탈출 차단 — NFS 루트 밖으로 나가는 subdir 금지)
      subdir: String(input.dest?.subdir || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64),
    }
    : { type: 'datastore', datastoreName: String(input.dest?.datastoreName || '').trim() };
  if (dest.type === 'nfs' && !dest.mountId) throw new Error('NFS 대상은 마운트 항목을 선택해야 합니다(설정 › NFS 마운트).');
  if (dest.type === 'datastore' && !dest.datastoreName) throw new Error('대상 데이터스토어를 선택하세요.');

  const existing = input.id ? db.jobs.find((j) => j.id === input.id) : null;
  const job = existing || { id: `vc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, clones: [], lastRun: null, createdAt: Date.now() };
  Object.assign(job, {
    vcenterId, vmId, vmName, dest,
    schedule: normSchedule(input.schedule),
    keep: clampKeep(input.keep),
    quiesce: !!input.quiesce,
    enabled: input.enabled !== false,
  });
  if (!existing) {
    if (db.jobs.length >= MAX_JOBS) throw new Error(`복제 잡은 최대 ${MAX_JOBS}개까지 등록할 수 있습니다.`);
    // 같은 VM 에 잡 중복 금지 — 같은 VM 을 두 잡이 스냅샷/클론하면 서로 간섭한다.
    if (db.jobs.some((j) => j.vcenterId === vcenterId && j.vmId === vmId)) throw new Error('이 VM 에는 이미 복제 잡이 있습니다(수정으로 변경하세요).');
    db.jobs.push(job);
  }
  persist();
  return { ...job };
}

export function deleteJob(id) {
  const db = load();
  const i = db.jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  // 잡 삭제는 정의만 지운다 — 만들어 둔 클론 VM/NFS 사본은 남긴다(백업을 지우는 파괴 행위는
  // 사용자가 vCenter/NAS 에서 직접, 또는 보존정책이 잡이 살아있는 동안만 수행).
  db.jobs.splice(i, 1);
  persist();
  return true;
}

/** 실행 결과 반영(runner 전용) — clones 원장 갱신 + lastRun. */
export function recordRun(id, { ok, detail, ms, addClone = null, removeCloneRefs = [] }) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return;
  if (addClone) j.clones.push(addClone);
  if (removeCloneRefs.length) j.clones = j.clones.filter((c) => !removeCloneRefs.includes(c.ref));
  j.lastRun = { at: Date.now(), ok: !!ok, detail: String(detail || '').slice(0, 400), ms: ms || 0 };
  persist();
}

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
    const today = new Date(now); today.setHours(hh, mm, 0, 0);
    const target = today.getTime();
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
