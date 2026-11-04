/**
 * Bareos 재해 복구 1차(시안 ② 'vCenter 를 다시 설치한 뒤 법인째 되살리기' · 사용자 결정 '두 번에 나눠' · 2026-11-04) — 화면 쪽 고르기 · 짝짓기 · 묶음(순수).
 *   판정은 서버(bulkRestorePlan + dr 규칙 drItemIssue · 미리 보기 POST restore-check/bulk)가 한다. 여기는 화면이 먼저 말하는 것과 보낼 모양만.
 *   1차는 50대씩 사람이 보낸다(한 번에 보낼 수 있는 상한 — 서버 BULK_RESTORE_MAX). 단계 자동 실행(복구 순서)은 2차.
 *   값이 없으면 '—'(0 이 아니다) · 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';

/** 한 번에 보낼 수 있는 VM(서버 BULK_RESTORE_MAX 와 같다). */
export const DR_CHUNK = 50;
/** 시험 1대 성공을 인정하는 기간 — 서버 bareos/drPlan.js DR_TRIAL_MS 와 같다(server/test/bareosDr1 이 대조). */
export const DR_TRIAL_MS = 7 * 86_400_000;
/** 이름 예약 기간 — 서버 RESERVE_MS(24시간)와 같은 뜻. 화면은 '최근 보냄' 표시에만 쓴다(판정은 서버). */
const RECENT_MS = 24 * 3600_000;
const FAILED = new Set(['error', 'canceled']);
/**
 * 반증 R1: 그 법인에서 재해 복구 1대가 성공으로 끝났는가(서버 drTrialIssue 와 같은 조건 — 아니면 서버가 2대 이상을 막는다).
 *   플러그인은 백업 때 저장한 vCenter 접속값으로 디스크를 쓴다 — 다시 설치로 지문이 바뀌면 껍데기만 생길 수 있어 먼저 1대로 확인한다.
 */
export function drTrialOk(jobs, vcenterId, now = Date.now()) {
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (String(j.vcenterId) !== String(vcenterId)) continue;
    for (const r of j.restores || []) if (r?.dr === true && (r.state === 'ok' || r.state === 'warning') && now - (Number(r.endedAt || r.at) || 0) < DR_TRIAL_MS) return true;
  }
  return false;
}
/** 반증 R3: 이 이름으로 최근(24시간) 보낸 새 VM 복원 — 끝났어도 다음 묶음에 다시 넣지 않는다(실패 · 취소는 서버가 다시 판정 — 그 뒤 인벤토리에 없으면 다시 보낼 수 있다). */
export function drRecentlySent(job, name, now = Date.now()) {
  const k = String(name || '').toLowerCase();
  return (job?.restores || []).some((r) => r?.mode === 'newVm' && String(r.target?.name || '').toLowerCase() === k && !FAILED.has(String(r.state || '')) && now - (Number(r.at) || 0) < RECENT_MS);
}
const pad = (x) => String(x).padStart(2, '0');

/** 기준 시각 입력(datetime-local 'YYYY-MM-DDTHH:MM' — 브라우저 현지 시각) → ms. 틀리면 null. */
export function drBeforeMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
/** ms → datetime-local 값(브라우저 현지 시각). */
export function drBeforeText(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 기준 시각 **이전에 시작한** 마지막 복원 지점(체인이 있는 성공 백업). 시작 시각을 못 읽은 지점은 이전인지 모른다 — 고르지 않는다(감염 뒤 백업을 고를 수 있다).
 * @returns {object|null}
 */
export function drPickPoint(points, beforeMs) {
  const lim = numOrNull(beforeMs);
  let best = null;
  for (const p of Array.isArray(points) ? points : []) {
    const t = numOrNull(p?.startedAt);
    if (!p?.chain || t === null || lim === null || t >= lim) continue;
    if (!best || t > best.t) best = { t, p };
  }
  return best ? best.p : null;
}

/** 백업 때 위치 — 고른 지점의 at(서버 placementAt) 이 있으면 그것, 없으면 원장 등록 위치. */
export const drAt = (job, point) => ({
  dc: point?.at?.dc || job?.dc || '',
  folder: point?.at?.folder || job?.folder || '/',
  vmName: point?.at?.vmName || job?.vmName || '',
});

/**
 * 행 — 원장 대상(그 vCenter) × 읽은 복원 지점. 고를 수 없는 사유가 있으면 why.
 * @param {object[]} jobs 원장(화면 목록) · @param {Map<string, object>|null} pts id → restore-points 항목 · @param {(job)=>string} blockOf pickBlock
 */
export function drRows(jobs, vcenterId, pts, beforeMs, blockOf = () => '', now = Date.now()) {
  const out = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (String(j.vcenterId) !== String(vcenterId)) continue;
    const p = pts ? pts.get(j.id) : null;
    const point = p?.ok ? drPickPoint(p.points, beforeMs) : null;
    const at = drAt(j, point);
    let why = blockOf(j) || '';
    if (!why && !pts) why = '복원 지점 읽기 전';
    else if (!why && !p) why = '복원 지점 읽기 전';
    else if (!why && !p.ok) why = p.reason || '복원 지점을 읽지 못했습니다';
    else if (!why && !point) why = beforeMs === null ? '기준 시각을 고르세요' : '기준 시각 이전 성공한 백업 없음';
    if (!why && drRecentlySent(j, at.vmName, now)) why = '최근 보냄 — 아래 최근 묶음에서 결과를 확인하세요';
    out.push({ id: j.id, job: j, point, at, path: `${at.dc} › ${at.folder}`, why });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'ko') || String(a.at.vmName).localeCompare(String(b.at.vmName), 'ko'));
}

/** 고른 행의 백업 때 데이터센터 → 대수(짝짓기 대상). */
export function drSourceDcs(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) m.set(r.at.dc, (m.get(r.at.dc) || 0) + 1);
  return [...m.entries()].map(([dc, n]) => ({ dc, n })).sort((a, b) => a.dc.localeCompare(b.dc, 'ko'));
}

/**
 * 짝짓기 기본값 — 같은 이름 데이터센터가 있으면 그것, 새 vCenter 에 데이터센터가 하나뿐이면 그것. 클러스터는 그 데이터센터에 하나뿐일 때만 저절로.
 * 데이터스토어는 '백업 당시 그대로'('' — 플러그인이 백업 때 데이터스토어 이름을 쓴다)가 기본. 사람이 고른 값은 덮지 않는다.
 */
export function drDefaultMap(sources, targets, cur = {}) {
  const dcs = Array.isArray(targets?.dcs) ? targets.dcs : [];
  const cls = Array.isArray(targets?.clusters) ? targets.clusters : [];
  const out = {};
  for (const { dc } of sources) {
    const prev = cur[dc] || {};
    const to = prev.dc ?? (dcs.includes(dc) ? dc : dcs.length === 1 ? dcs[0] : '');
    const inDc = cls.filter((c) => c.dc === to);
    const cluster = prev.cluster ?? (inDc.length === 1 ? inDc[0].name : '');
    out[dc] = { dc: to, cluster, datastore: prev.datastore ?? '' };
  }
  return out;
}

/** 짝짓기에서 빠진 것('' = 보낼 수 있다). 클러스터는 필수(다시 설치한 vCenter 에는 백업 때 호스트가 없을 수 있다 — 서버 drItemIssue 와 같은 규칙). */
export function drMapIssue(sources, map) {
  for (const { dc } of sources) {
    const m = map?.[dc];
    if (!m?.dc) return `백업 당시 데이터센터 ‘${dc || '—'}’ 를 새 vCenter 의 어느 데이터센터로 복원할지 고르세요.`;
    if (!m.cluster) return `‘${dc || '—'}’ → ‘${m.dc}’ 의 클러스터를 고르세요(다시 설치한 vCenter 에는 백업 때 호스트가 없을 수 있습니다).`;
  }
  return '';
}

/** 서버로 보낼 묶음 항목 — 새 VM · 백업 때 이름 · 끊은 채 · 짝지은 데이터센터 · 클러스터 · 데이터스토어. */
export function drItem(row, map) {
  const m = map?.[row.at.dc] || {};
  return {
    id: row.id, jobid: row.point?.jobid ?? null, mode: 'newVm', nic: 'disconnect',
    newVm: { name: row.at.vmName, ...(m.dc && m.dc !== row.at.dc ? { dc: m.dc } : {}), ...(m.cluster ? { cluster: m.cluster } : {}), ...(m.datastore ? { datastore: m.datastore } : {}) },
  };
}

/** 이번에 보낼 묶음 — 고른 행 중 아직 고를 수 있는(why 없음) 앞 DR_CHUNK 대. */
export function drNextChunk(rows, picked, size = DR_CHUNK) {
  const set = picked instanceof Set ? picked : new Set(picked || []);
  return (Array.isArray(rows) ? rows : []).filter((r) => set.has(r.id) && !r.why).slice(0, Math.max(1, Math.min(DR_CHUNK, size)));
}

/** 점검 한 줄의 표지 · 색. state ok · warn · bad · unknown(포탈이 모른다 — 막지 않지만 사람이 확인). */
export const DR_MARK = Object.freeze({ ok: ['✓', 'ok'], warn: ['!', 'warn'], bad: ['✕', 'bad'], unknown: ['?', 'info'] });
/** 점검 중 '다음' 을 막는 것(bad) 수. unknown 은 막지 않는다(포탈이 읽을 수 없는 것 — 확인 방법을 보인다). */
export const drBlocking = (checks) => (Array.isArray(checks) ? checks : []).filter((c) => c?.state === 'bad').length;
