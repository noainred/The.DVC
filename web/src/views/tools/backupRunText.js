/**
 * Backup 현황 › 백업 실행 화면 문구·표시(순수 — v2.818). 판정(실행 상태·방식 배정)은 서버(veeam/run/plan.js)가 한다 —
 * 여기서는 서버가 준 값을 **글자와 색으로만** 바꾼다(판정 복제 금지).
 */
import { agoText } from './relTime.js';

export const RUN_STATUS = Object.freeze({
  protected: { label: '보호됨 · Quick 가능', cls: 'green' },
  'in-job': { label: '복원 지점 없음', cls: 'amber' },
  unprotected: { label: '미보호', cls: 'amber' },
  elsewhere: { label: '다른 서버(미등록)', cls: 'gray' },
  unknown: { label: '확인 불가', cls: 'gray' },
  unmapped: { label: '연결 서버 없음', cls: 'gray' },
});
export const RUN_STATUS_ORDER = Object.freeze(['protected', 'in-job', 'unprotected', 'elsewhere', 'unknown', 'unmapped']);

export const VM_STATE = Object.freeze({
  queued: { label: '대기', cls: 'gray' },
  starting: { label: '요청 중', cls: 'blue' },
  running: { label: '진행 중', cls: 'blue' },
  success: { label: '성공', cls: 'green' },
  warning: { label: '경고', cls: 'amber' },
  failed: { label: '실패', cls: 'red' },
  skipped: { label: '보내지 않음', cls: 'gray' },
  unknown: { label: '확인 불가', cls: 'gray' },
});
export const HOW = Object.freeze({ quick: 'Quick Backup', portal: '포탈 전용 잡', skip: '건너뜀' });
export const HOST_HOW = Object.freeze({ manual: '직접 지정', alias: '대조가 배운 이름', host: '포탈 등록 주소', '': '모름' });

/** 상대 시각 — 코어(relTime.agoText)에 위임(로컬 구현 금지). */
export const ago = (ms, now = Date.now()) => agoText(ms, now);

/** epoch ms → 'MM-DD HH:mm'(없으면 '—'). */
export function shortTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 전원(POWERED_ON · poweredOn) → 한글. 모르는 값은 원문, 없으면 '—'. */
export function powerText(s) {
  const k = String(s || '').replace(/_/g, '').toLowerCase();
  if (!k) return '—';
  return k === 'poweredon' ? '켜짐' : k === 'poweredoff' ? '꺼짐' : k === 'suspended' ? '일시 중지' : String(s);
}

/** 실행 요약. */
export function runSummary(run) {
  const vms = Array.isArray(run?.vms) ? run.vms : [];
  const c = (st) => vms.filter((v) => v.state === st).length;
  const parts = [];
  const live = c('running') + c('starting') + c('queued');
  if (live) parts.push(`진행 ${live}`);
  for (const st of ['success', 'warning', 'failed', 'unknown', 'skipped']) { const n = c(st); if (n) parts.push(`${VM_STATE[st].label} ${n}`); }
  return parts.join(' · ') || '—';
}

/* ── Detail → 백업 실행 선택 넘김(sessionStorage — 주소에 VM id 수백 개를 싣지 않는다) ── */
export const HANDOFF_KEY = 'backup-run.handoff';
const HANDOFF_TTL_MS = 10 * 60_000;
export function saveHandoff(vcenterId, vmIds, store = globalThis.sessionStorage) {
  try { store?.setItem(HANDOFF_KEY, JSON.stringify({ vcenterId: String(vcenterId || ''), vmIds: (Array.isArray(vmIds) ? vmIds : []).slice(0, 200).map(String), at: Date.now() })); return true; } catch { return false; }
}
/** 한 번 읽고 지운다. 오래됐거나(10분) 모양이 틀리면 null. */
export function takeHandoff(store = globalThis.sessionStorage, now = Date.now()) {
  let raw = null;
  try { raw = store?.getItem(HANDOFF_KEY); store?.removeItem(HANDOFF_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j.vcenterId !== 'string' || !j.vcenterId || !Array.isArray(j.vmIds)) return null;
    if (!(now - Number(j.at) <= HANDOFF_TTL_MS)) return null;
    return { vcenterId: j.vcenterId, vmIds: j.vmIds.filter((x) => typeof x === 'string').slice(0, 200) };
  } catch { return null; }
}
