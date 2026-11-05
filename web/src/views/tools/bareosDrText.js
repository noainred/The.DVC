/**
 * Bareos 재해 복구 1차(시안 ② 'vCenter 를 다시 설치한 뒤 법인째 되살리기' · 사용자 결정 '두 번에 나눠' · 2026-11-04) — 화면 쪽 고르기 · 짝짓기 · 묶음(순수).
 *   판정은 서버(bulkRestorePlan + dr 규칙 drItemIssue · 미리 보기 POST restore-check/bulk)가 한다. 여기는 화면이 먼저 말하는 것과 보낼 모양만.
 *   1차는 50대씩 사람이 보낸다(한 번에 보낼 수 있는 상한 — 서버 BULK_RESTORE_MAX). 단계 자동 실행(복구 순서)은 2차.
 *   값이 없으면 '—'(0 이 아니다) · 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';

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
    for (const r of j.restores || []) if (r?.dr === true && drRestorePassed(r) && now - (Number(r.endedAt || r.at) || 0) < DR_TRIAL_MS) return true;
  }
  return false;
}
/** 재해 복구 복원 한 건이 끝맺음(네트워크 끊기 · 켜 보기)까지 성공했는가 — 서버 drPlan.js drRestorePassed 와 같은 조건(server/test/bareosDr2 가 같은 입력으로 대조 · 버그 점검 B4-02). */
export function drRestorePassed(r) {
  if (!r || !(r.state === 'ok' || r.state === 'warning')) return false;
  if (r.nic === 'disconnect' && r.finish?.nic !== 'ok') return false;
  if (r.verify === true && r.finish?.verify !== 'ok') return false;
  return true;
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

/* ───────────── 2차 — 복구 순서(단계 자동 실행 · 서버 bareos/drRunner.js) ───────────── */

/** 단계 수 · 회차 대수 상한 — 서버 drRunner DR_WAVES_MAX · DR_ITEMS_MAX 와 같다(server/test/bareosDr2 가 normWaves 로 같은 값을 본다). */
export const DR_WAVES_MAX = 10;
export const DR_ITEMS_MAX = 1000;

/** 새 단계(이름 · 동시 복원 수 · 켜 보기). 동시 수는 1~DR_CHUNK. */
export const drNewWave = (i, n = 1) => ({ name: `${i + 1}단계`, concurrency: Math.max(1, Math.min(DR_CHUNK, Math.floor(Number(n)) || 1)), verify: false });

/** 이 VM 의 단계 번호 — 배정이 없거나 범위 밖이면 0(1단계). */
export function drWaveOf(assign, id, count) {
  const w = Number(assign?.[id]);
  return Number.isInteger(w) && w >= 0 && w < count ? w : 0;
}

/** 단계 지우기 — 그 단계 VM 은 바로 앞 단계로(첫 단계면 다음 단계로), 뒤 단계 번호는 하나씩 당긴다. 단계가 하나면 그대로. */
export function drRemoveWave(waves, assign, idx) {
  if (!Array.isArray(waves) || waves.length <= 1 || idx < 0 || idx >= waves.length) return { waves, assign };
  const to = idx === 0 ? 0 : idx - 1;
  const out = {};
  for (const id of Object.keys(assign || {})) {
    const w = drWaveOf(assign, id, waves.length);
    out[id] = w === idx ? to : w > idx ? w - 1 : w;
  }
  // 기본 이름('3단계')은 새 자리에 맞춘다 — 지운 뒤 2번째 자리에 '3단계' 가 남으면 헷갈린다. 사람이 지은 이름은 그대로.
  const rest = waves.map((w, i) => ({ w, i })).filter(({ i }) => i !== idx).map(({ w, i }, k) => (String(w.name || '').trim() === `${i + 1}단계` ? { ...w, name: `${k + 1}단계` } : w));
  return { waves: rest, assign: out };
}
/** 단계 선택지 문구 — 기본 이름이면 '2단계', 지은 이름이면 '2단계 · DB'. */
export const drWaveLabel = (w, i) => (String(w?.name || '').trim() && String(w.name).trim() !== `${i + 1}단계` ? `${i + 1}단계 · ${String(w.name).trim()}` : `${i + 1}단계`);

/** 서버로 보낼 단계 — 고른 행(why 없음)을 단계별로. 항목은 drItem 의 새 VM 모양(id · jobid · newVm). */
export function drRunWaves(waves, assign, rows, map) {
  const ws = Array.isArray(waves) ? waves : [];
  const list = Array.isArray(rows) ? rows : [];
  return ws.map((w, i) => ({
    name: String(w.name || '').trim() || `${i + 1}단계`, concurrency: Number(w.concurrency), verify: w.verify === true,
    items: list.filter((r) => drWaveOf(assign, r.id, ws.length) === i).map((r) => { const x = drItem(r, map); return { id: x.id, jobid: x.jobid, newVm: x.newVm }; }),
  }));
}

/** 시작 전 화면이 먼저 말하는 것('' = 계획 확인을 보낼 수 있다). 서버 normWaves 와 같은 규칙(서버가 다시 본다). */
export function drWavesIssue(runWaves) {
  const ws = Array.isArray(runWaves) ? runWaves : [];
  if (!ws.length || ws.length > DR_WAVES_MAX) return `단계는 1~${DR_WAVES_MAX}개입니다.`;
  let total = 0;
  for (const w of ws) {
    const c = Number(w.concurrency);
    if (!Number.isInteger(c) || c < 1 || c > DR_CHUNK) return `‘${w.name}’ 동시 복원 수는 1~${DR_CHUNK} 입니다.`;
    if (!w.items.length) return `‘${w.name}’ 에 VM 이 없습니다 — 단계를 지우거나 VM 을 옮기세요.`;
    total += w.items.length;
  }
  if (total > DR_ITEMS_MAX) return `한 회차는 ${DR_ITEMS_MAX}대까지입니다 — 고르기를 나눠 두 번 시작하세요.`;
  return '';
}

/** 회차 상태 → [문구, 색]. */
export const DR_RUN_STATE = Object.freeze({ running: ['진행 중', 'info'], paused: ['멈춤 — 확인이 필요합니다', 'warn'], stopped: ['멈춤(사람이 멈춤)', 'muted'], done: ['끝', 'ok'] });
/** 항목 상태 → [문구, 색]. 'sent' 는 Director 에서 복원 중이거나 끝맺음(네트워크 끊기 · 켜 보기) 중. */
export const DR_ITEM_STATE = Object.freeze({ queued: ['대기', 'muted'], sending: ['보내는 중', 'info'], sent: ['복원 중', 'info'], ok: ['성공', 'ok'], failed: ['실패', 'bad'], unknown: ['결과 모름', 'warn'], skipped: ['건너뜀', 'muted'] });
const COUNT_ORDER = ['ok', 'sent', 'sending', 'queued', 'failed', 'unknown', 'skipped'];
/** 단계 한 줄 — '성공 3 · 복원 중 2 · 대기 10 / 15대'(0 인 상태는 뺀다 · 대수를 모르면 '— / —'). 멈춘 회차의 대기는 '보내지 않음'(B5-12 — 다시 보내지 않는다). */
export function drWaveCountsText(w, runState = '') {
  const c = w?.counts || {};
  const parts = COUNT_ORDER.filter((k) => Number(c[k]) > 0).map((k) => `${k === 'queued' && runState === 'stopped' ? '보내지 않음' : DR_ITEM_STATE[k][0]} ${c[k]}`);
  return `${parts.join(' · ') || '—'} / ${unitText(numOrNull(w?.total), '대')}`;   // 못 읽은 대수는 '—'(단위를 붙이지 않는다)
}
/** 진행 중(running · paused)인가 — 이 법인에 새 회차를 시작할 수 없다. */
export const drRunActive = (run) => run?.state === 'running' || run?.state === 'paused';
/** 이 법인에서 보일 회차 — 진행 중 · 멈춤이 있으면 그것, 없으면 가장 최근(at). */
export function drCurrentRun(runs, vcenterId) {
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => String(r.vcenterId) === String(vcenterId));
  return mine.find(drRunActive) || mine.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0] || null;
}
/** 진행 중 회차에 든 VM(원장 id) — 고르기에서 막는다(같은 VM 을 두 번 보내지 않게 · 서버도 막는다). */
export function drRunIds(run) {
  const s = new Set();
  if (!drRunActive(run)) return s;
  for (const w of run.waves || []) for (const it of w.items || []) if (it.state === 'queued' || it.state === 'sending' || it.state === 'sent') s.add(it.id);
  return s;
}
