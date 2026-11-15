/**
 * 재시작하면 결과를 잃는 Veeam 백업 실행 · 관리 작업(전체 점검 2회차 V-3 — audits.md 'v2.825.1 남긴 것 ①' 의 Veeam 절반).
 * upgrade/manager.js 의 자동 적용 대기 목록이 읽는다(bareos/inflight.js runningBareosWork 와 같은 모양 · 읽기만).
 *  · 관리 작업 자리(잡에서 빼기 · 백업 삭제 — runs.js claimServer): 라우트가 결과를 기다린 **뒤에** 감사 · 기록을 남기므로 재시작하면 둘 다 사라진다.
 *  · 보내는 중(starting) VM 이 있는 실행: 재시작 복구가 '확인 불가' 로 닫는다(recoverRuns) — 보내기가 끝날 때까지만 기다린다(세션을 받은 실행은 재시작 뒤 추적을 잇는다).
 *  · 중앙 → 엣지 대행 대기열의 상태 변경 작업(edgeOps pendingView 중 MUTATING): 회신을 받을 곳이 사라진다.
 *  · 엣지 쪽 워커가 실행 중인 상태 변경 작업(agent/veeamRunWorker.js): 재시작하면 회신을 보내지 못한다.
 * 세션 조회(sessions) · 저장소 · 지점 조회 같은 읽기는 넣지 않는다(다음 주기에 다시 한다).
 */
import { pendingView } from './edgeOps.js';
import { MUTATING } from './ops.js';
import { listRuns, manageBusyView } from './runs.js';

const KIND_TEXT = Object.freeze({ exclude: '잡에서 빼기', deleteBackup: '백업 삭제', quickBackup: 'Quick Backup', portalJob: '포탈 전용 잡 실행', restoreVm: '새 VM 복원', jobExclude: '잡에서 빼기' });
const kindText = (k) => KIND_TEXT[k] || String(k || '').slice(0, 40);

const _edgeOps = new Map();   // 엣지 워커가 실행 중인 상태 변경 작업 id → { kind, serverId, since }(비밀 · 인자 없음)
export function noteVeeamEdgeOpStart(id, kind, serverId) { _edgeOps.set(String(id), { kind: String(kind).slice(0, 40), serverId: String(serverId || '').slice(0, 64), since: Date.now() }); }
export function noteVeeamEdgeOpEnd(id) { _edgeOps.delete(String(id)); }

/** @returns {{ kind:'veeam', key:string, label:string, since:number|null, resumable:false }[]} */
export function runningVeeamWork(now = Date.now()) {
  const out = [];
  let busy = [];
  try { busy = manageBusyView(); } catch { busy = []; }
  for (const b of busy) out.push({ kind: 'veeam', key: `manage:${b.serverId}`, label: `Veeam ${kindText(b.kind)}(서버 ${b.serverId})`.slice(0, 120), since: Number.isFinite(b.at) ? b.at : null, resumable: false });
  let runs = [];
  try { runs = listRuns(); } catch { runs = []; }
  for (const r of runs) {
    if (r?.status !== 'running' || !Array.isArray(r.vms) || !r.vms.some((v) => v?.state === 'starting')) continue;
    out.push({ kind: 'veeam', key: `start:${r.id}`, label: `Veeam ${r.mode === 'restore' ? '복원' : '백업 실행'} 요청 보내는 중(${r.id})`.slice(0, 120), since: Number.isFinite(r.at) ? r.at : null, resumable: false });
  }
  let ops = [];
  try { ops = pendingView(); } catch { ops = []; }
  for (const o of ops) {
    if (!MUTATING.has(o.kind)) continue;
    out.push({ kind: 'veeam', key: `edge:${o.agent}:${o.kind}:${o.ageMs}`, label: `Veeam 엣지 대행 ${kindText(o.kind)}(${o.agent})`.slice(0, 120), since: now - (Number(o.ageMs) || 0), resumable: false });
  }
  for (const [id, o] of _edgeOps) out.push({ kind: 'veeam', key: `edge-run:${id}`, label: `Veeam 대행 실행 ${kindText(o.kind)}(서버 ${o.serverId})`.slice(0, 120), since: o.since, resumable: false });
  return out;
}

export function _resetVeeamInflightForTest() { _edgeOps.clear(); }
