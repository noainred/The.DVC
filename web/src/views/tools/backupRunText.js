/**
 * Backup 현황 › 백업 실행 화면 문구·표시(순수 — v2.818). 판정(실행 상태·방식 배정)은 서버(veeam/run/plan.js)가 한다 —
 * 여기서는 서버가 준 값을 **글자와 색으로만** 바꾼다(판정 복제 금지).
 */
import { agoText } from './relTime.js';

export const RUN_STATUS = Object.freeze({
  protected: { label: '보호됨 · Quick 가능', cls: 'green' },
  'in-job': { label: '복원 지점 없음', cls: 'amber' },
  unprotected: { label: '미보호', cls: 'amber' },
  agent: { label: '에이전트 백업 포함', cls: 'gray' },
  elsewhere: { label: '다른 서버(미등록)', cls: 'gray' },
  unknown: { label: '확인 불가', cls: 'gray' },
  unmapped: { label: '연결 서버 없음', cls: 'gray' },
});
export const RUN_STATUS_ORDER = Object.freeze(['protected', 'in-job', 'unprotected', 'agent', 'elsewhere', 'unknown', 'unmapped']);

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
export const HOW = Object.freeze({ quick: 'Quick Backup', portal: '포탈 전용 잡', skip: '건너뜀', restore: '새 VM 복원' });
export const HOST_HOW = Object.freeze({ manual: '직접 지정', alias: '대조가 배운 이름', host: '포탈 등록 주소', record: '지난 요청에 쓴 이름', '': '모름' });

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

/* ── v2.819 포탈 백업 관리 ──────────────────────────────────────────── */

/**
 * 포탈 백업 VM 기록(서버 portalVms.js) → 폴더 트리·목록 배지. 판정은 서버가 한 상태(lastState·excludedAt·deletedAt)를 글자로만 바꾼다.
 * 값이 없으면 null(배지 없음). 시각이 없으면 시각을 붙이지 않는다.
 */
export function portalMark(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const when = typeof rec.lastAt === 'number' ? shortTime(rec.lastAt).slice(0, 5) : '';
  const how = HOW[rec.how] || '';
  const st = VM_STATE[rec.lastState];
  const title = [`포탈 ${how || '백업'}`, typeof rec.lastAt === 'number' ? shortTime(rec.lastAt) : '', st ? st.label : ''].filter(Boolean).join(' · ');
  if (typeof rec.deletedAt === 'number') return { label: 'Portal 백업 삭제됨', cls: 'gray', title: `${title} · 백업 삭제 ${shortTime(rec.deletedAt)}` };
  if (typeof rec.excludedAt === 'number') return { label: 'Portal 잡에서 뺌', cls: 'gray', title: `${title} · 잡에서 뺌 ${shortTime(rec.excludedAt)}` };
  if (['queued', 'starting', 'running'].includes(rec.lastState)) return { label: 'Portal 백업 중', cls: 'blue', title };
  if (!st) return { label: 'Portal', cls: 'gray', title };
  const mark = rec.lastState === 'success' ? '✓' : rec.lastState === 'warning' ? '!' : rec.lastState === 'failed' ? '✕' : '?';
  return { label: `Portal ${mark}${when ? ` ${when}` : ''}`, cls: st.cls, title };
}

/** 복원 지점 표의 '백업' 칸 — 잡 이름(없으면 백업 이름) + 포탈 잡 여부. */
export function pointSource(p) {
  const name = p?.jobName || p?.backupName || '';
  return { name: name || '—', portal: p?.portal === true };
}

/* ── v2.820.1 ───────────────────────────────────────────────────────── */

/** 복원 지점 수 — 모니터링 코어는 '있지만 개수 모름' 을 -1 로 적는다(B2: 표에 '-1' 이 그대로 보였다). 값이 없으면 '—'. */
export function rpText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n === -1 ? '있음(개수 모름)' : String(n);
}

/**
 * Detail·폴더 트리에서 넘겨받은 VM → 선택(Map id→이름). 화면에서 고를 수 있는 행만(연결 서버 없음·조회 전용은 체크박스가 잠긴다 — 같은 기준).
 * 넘김은 **한 번만** 적용한다(B4: 요청 뒤 목록을 다시 읽을 때마다 같은 VM 이 다시 골라져 같은 백업을 또 보낼 수 있었다 — 호출부가 소비 표시).
 */
export function pickHandoff(rows, ids, writable) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  if (!writable || !want.size) return new Map();
  return new Map((Array.isArray(rows) ? rows : []).filter((r) => want.has(r.id) && r.run?.status !== 'unmapped').map((r) => [r.id, r.name]));
}
/** 복원 지점 정렬 값 — '있음(개수 모름)'(-1)은 0 보다 위·1 보다 아래(재검토: -1 그대로면 '없음' 아래로 갔다). */
export const rpSort = (n) => (typeof n === 'number' && Number.isFinite(n) ? (n === -1 ? 0.5 : n) : '');

/* ── v2.822.2 진행 상세 · VM 크기 ─────────────────────────────────────── */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
/** GB(vCenter 값) → 'N GB' · 1024 이상은 TB. 값이 없으면 '—'(단위를 붙이지 않는다). */
export function gbText(gb) {
  if (!fin(gb)) return '—';
  return gb >= 1024 ? `${(gb / 1024).toFixed(gb >= 10240 ? 0 : 1)} TB` : `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}
/** 바이트(Veeam 값) → GB/TB 글자. 없으면 '—'. */
export const bytesText = (b) => (fin(b) ? gbText(b / 1024 ** 3) : '—');
/** 경과(ms) → '45초' · '15분' · '2시간 5분'. 없거나 음수면 ''. */
export function elapsedText(ms) {
  if (!fin(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))}초`;
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}
/** 평균 처리 속도(처리량 ÷ 경과) — **계산값**(Veeam 이 준 속도가 아니다). 둘 중 하나라도 없으면 null. */
export function avgRate(processedBytes, elapsedMs) {
  if (!fin(processedBytes) || !fin(elapsedMs) || elapsedMs < 1000) return null;
  return processedBytes / (elapsedMs / 1000);
}
const rateText = (bps) => (bps == null ? '' : bps >= 1024 ** 3 ? `${(bps / 1024 ** 3).toFixed(1)} GB/s` : `${Math.round(bps / 1024 ** 2)} MB/s`);

/**
 * 진행 한 줄 요약 — '37% · 처리 120 GB / 할당 150 GB · 15분째 · 평균 133 MB/s(계산)'. 없는 조각은 뺀다(0 을 만들지 않는다).
 * live = portal-vms 의 live({ state, progress, metrics }), sizeGB/provisionedGB = VM 크기.
 */
export function progressLine(live, { provisionedGB = null, now = Date.now() } = {}) {
  if (!live) return '';
  const m = live.metrics || {};
  const running = ['starting', 'running', 'queued'].includes(live.state);
  const parts = [];
  if (fin(live.progress)) parts.push(`${live.progress}%`);
  if (fin(m.processedBytes)) parts.push(`처리 ${bytesText(m.processedBytes)}${fin(provisionedGB) ? ` / 할당 ${gbText(provisionedGB)}` : ''}${m.scope === 'session' ? '(세션 전체)' : ''}`);
  const end = fin(m.endedAt) ? m.endedAt : (running ? now : null);
  const el = fin(m.startedAt) && end != null ? end - m.startedAt : null;
  if (el != null) parts.push(running ? `${elapsedText(el)}째` : `${elapsedText(el)} 걸림`);
  const rate = avgRate(m.processedBytes, el);
  if (rate != null) parts.push(`평균 ${rateText(rate)}(계산)`);
  return parts.join(' · ');
}
