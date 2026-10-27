/**
 * VM 백업 센터(v2.793) — 화면 판정·집계 한 벌(순수 — vmCloneView.test.js).
 *
 * 사용자 요구(2026-10-26): "VM 복제(백업) 도구를 Veeam 처럼" + 법인별 백업. 디자인 캔버스 'VM 백업 센터 시안'(①~⑥).
 * 화면의 숫자(KPI·법인 카드·최근 14회 막대·세션 목록)는 전부 여기서 계산한다 — 컴포넌트에서 따로 세지 말 것.
 *
 * 규칙(docs/rules/web.md · 루트 CLAUDE.md '못 읽은 값은 0 이 아니다'):
 *  · 사본 크기(bytes)를 모르는 사본은 합계에 넣지 않고 따로 센다(unknown) — 합계를 '최소' 로 밝힌다.
 *  · 건너뛴 실행(인증 정지·데모·위임·재시작 정리)은 성공도 실패도 아니다(skip).
 *  · 엣지 위임 잡의 실행 상태는 엣지가 보고한 것이다 — 보고가 없으면 '보고 없음' 이라 말하고 0 으로 칠하지 않는다.
 */
import { csvCell } from '../../util/csv.js'; // 수식 인젝션 가드 포함 공통 셀 이스케이프

const DAY = 86_400_000;

/** 이력 한 줄의 톤 — ok | warn | fail | skip. 성공했지만 경고(⚠ — 스냅샷 삭제·보존 삭제 실패)가 붙으면 warn. */
export function runTone(h) {
  if (!h || typeof h !== 'object') return 'none';
  if (h.skipped) return 'skip';
  if (h.ok) return /⚠|삭제 건너뜀/.test(String(h.detail || '')) ? 'warn' : 'ok';
  return 'fail';
}

/** 백업 실행 이력만(검증·복구 제외 — 옛 이력 줄에는 kind 가 없다 = 백업). */
export const backupRuns = (job) => (Array.isArray(job?.history) ? job.history : []).filter((h) => !h.kind || h.kind === 'backup');

/** 최근 n 회 백업 톤(오래된 것 → 최신). 모자라면 앞을 'none' 으로 채운다. */
export function lastRunTones(job, n = 14) {
  const runs = backupRuns(job).slice(-n).map(runTone);
  return [...Array(Math.max(0, n - runs.length)).fill('none'), ...runs];
}

/** 잡의 마지막 검증 결과(원장 사본 중 가장 최근 verify). 없으면 null. */
export function lastVerify(job) {
  let best = null;
  for (const c of Array.isArray(job?.clones) ? job.clones : []) if (c?.verify && (!best || (c.verify.at || 0) > (best.at || 0))) best = c.verify;
  return best;
}

/** 원장 사본 크기 합 — 모르는 사본은 unknown 으로 따로 센다. */
export function cloneBytes(clones) {
  let bytes = 0; let known = 0; let unknown = 0;
  for (const c of Array.isArray(clones) ? clones : []) {
    const b = Number(c?.bytes);
    if (c?.bytes != null && Number.isFinite(b) && b >= 0) { bytes += b; known++; } else unknown++;
  }
  return { bytes, known, unknown };
}

/** 사람이 읽는 바이트('—' = 모름). */
export function fmtBytes(b) {
  const n = Number(b);
  if (b == null || !Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** 경과 문구('방금' · 'N초/분/시간/일 전'). 모르면 '—'. */
export function agoText(ts, now = Date.now()) {
  const t = Number(ts);
  if (!t || !Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/** 소요 문구(ms → '8분 51초'). */
export function durText(ms) {
  const raw = Number(ms);
  if (ms == null || !Number.isFinite(raw) || raw < 0) return '—';
  const n = Math.round(raw / 1000);
  if (n < 60) return `${n}초`;
  if (n < 3600) return `${Math.floor(n / 60)}분 ${n % 60}초`;
  return `${Math.floor(n / 3600)}시간 ${Math.floor((n % 3600) / 60)}분`;
}

/**
 * KPI 다섯 장(보호 VM · 최근 24시간 · 복원 지점 · 사본 용량 · 최근 검증).
 * 24시간 셈은 백업 실행만 — 건너뜀은 따로(skip). 엣지 보고가 없는 위임 잡은 noReport 로 센다.
 */
export function kpisOf(jobs, now = Date.now()) {
  const list = Array.isArray(jobs) ? jobs : [];
  let ok = 0; let fail = 0; let warn = 0; let skip = 0; let points = 0; let oldest = null; let noReport = 0;
  let bytes = 0; let unknownBytes = 0; let vOk = 0; let vTotal = 0;
  for (const j of list) {
    if (j.exec && j.exec.where !== 'local' && !j.exec.reported) noReport++;
    for (const h of backupRuns(j)) {
      if (now - (h.at || 0) > DAY) continue;
      const tone = runTone(h);
      if (tone === 'ok') ok++; else if (tone === 'warn') warn++; else if (tone === 'fail') fail++; else if (tone === 'skip') skip++;
    }
    const clones = Array.isArray(j.clones) ? j.clones : [];
    points += clones.length;
    for (const c of clones) if (c?.at && (oldest == null || c.at < oldest)) oldest = c.at;
    const b = cloneBytes(clones); bytes += b.bytes; unknownBytes += b.unknown;
    const v = lastVerify(j);
    if (v) { vTotal++; if (v.ok) vOk++; }
  }
  return {
    protectedVms: list.filter((j) => j.enabled !== false).length, disabled: list.filter((j) => j.enabled === false).length,
    ok24: ok, fail24: fail, warn24: warn, skip24: skip, total24: ok + fail + warn,
    points, oldestPointAt: oldest, bytes, unknownBytes, verifyOk: vOk, verifyTotal: vTotal, noReport,
  };
}

/** 잡 한 줄의 상태 점 — fail(마지막 실패) · warn · ok · running · off · noreport · problem. */
export function jobState(j) {
  if (j?.enabled === false) return 'off';
  if (j?.exec && (j.exec.where === 'conflict' || j.exec.where === 'none' || j.exec.problem)) return 'problem';
  if (j?.exec?.runningPhase || j?.running) return 'running';
  if (j?.exec && j.exec.where === 'edge' && !j.exec.reported) return 'noreport';
  const runs = backupRuns(j);
  const last = runs.length ? runs[runs.length - 1] : (j?.lastRun || null);
  if (!last) return 'none';
  return runTone(last);
}

/** 실행 위치 문구 — 잡 표의 vCenter 아래 한 줄. */
export function execText(j, now = Date.now()) {
  const e = j?.exec;
  if (!e || e.where === 'local') return '';
  if (e.where === 'edge') return e.reported ? `담당 엣지 ${e.agent} · 보고 ${agoText(e.reportedAt, now)}` : `담당 엣지 ${e.agent} · 아직 보고 없음`;
  return e.reason || '실행 위치 미확정';
}

/** 엣지 상태 판정(법인 카드). */
export function corpEdgeState(c, now = Date.now(), { staleMs = 5 * 60_000 } = {}) {
  if (c?.problem) return 'problem';
  if (c?.simulated) return 'sim';
  if (!c?.agent) return 'central';
  if (!c.edge) return 'noreport';
  if ((c.edge.proto || 0) < 1) return 'old';
  if (now - (c.edge.at || 0) > staleMs) return 'stale';
  return 'ok';
}

export const CORP_STATE_LABEL = Object.freeze({
  central: '중앙 실행', ok: '정상', sim: '데모', noreport: '엣지 보고 없음', old: '엣지 업그레이드 필요', stale: '엣지 보고 끊김', problem: '담당 미확정',
});

/**
 * 법인 카드 — 법인별 잡 수 · 24시간 성공/전체 · 엣지 상태 · 저장소 요약.
 * @param corps 서버 corps · @param jobs 화면 잡 · @param nfsDs 서버 nfsDatastores
 */
export function corpCards(corps, jobs, nfsDs, now = Date.now()) {
  return (Array.isArray(corps) ? corps : []).map((c) => {
    const ids = new Set(c.vcenterIds || []);
    const mine = (jobs || []).filter((j) => ids.has(String(j.vcenterId)));
    const k = kpisOf(mine, now);
    const ds = (nfsDs || []).filter((d) => ids.has(String(d.vcenterId)));
    const mounts = c.edge?.mounts || [];
    const stores = [...ds.map((d) => `NFS-DS ${d.name}`), ...mounts.filter((m) => m.mounted).map((m) => `엣지 NFS ${m.label}`)];
    const state = corpEdgeState(c, now);
    return {
      key: c.key, name: c.label, state, stateLabel: CORP_STATE_LABEL[state] || state,
      sub: state === 'central' ? `중앙 직접 수집 · vCenter ${ids.size}`
        : state === 'problem' ? (c.problem || '담당 미확정')
          : state === 'sim' ? `데모 엣지 · vCenter ${ids.size}`
            : `엣지 ${c.agent}${c.edge ? ` · 보고 ${agoText(c.edge.at, now)}${c.edge.version ? ` · v${c.edge.version}` : ''}` : ' · 보고 없음'}`,
      jobs: mine.length, ok24: k.ok24 + k.warn24, total24: k.total24, fail24: k.fail24,
      storesText: stores.length ? stores.slice(0, 2).join(' · ') + (stores.length > 2 ? ` 외 ${stores.length - 2}` : '') : '저장소 미지정',
      running: c.edge?.runner?.running || null, queued: (c.edge?.runner?.queued || []).length,
    };
  });
}

/** 최근 세션(백업·검증·복구 이력 + 작업 기록) — 최신순 limit 개. */
export function recentSessions(jobs, ops, limit = 8) {
  const out = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    for (const h of Array.isArray(j.history) ? j.history : []) out.push({ at: h.at || 0, vm: j.vmName, kind: h.kind || 'backup', tone: runTone(h), detail: h.detail || '', ms: h.ms || 0, jobId: j.id });
  }
  for (const o of Array.isArray(ops) ? ops : []) {
    if (o.state !== 'done') out.push({ at: o.createdAt || 0, vm: o.vmName || o.target || '', kind: o.kind, tone: 'running', detail: `${o.label || o.kind} — ${o.where === 'edge' ? `담당 엣지 ${o.agent} ${o.state === 'pending' ? '가져가기 대기' : '실행 중'}` : '실행 중'}`, ms: 0, jobId: o.jobId || '' });
    else if (o.kind === 'nfsds-attach' || o.kind === 'nfsds-detach' || o.kind === 'run') out.push({ at: o.doneAt || o.createdAt || 0, vm: o.vmName || o.target || '', kind: o.kind, tone: o.ok ? 'ok' : 'fail', detail: o.detail || '', ms: 0, jobId: o.jobId || '' });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export const KIND_LABEL = Object.freeze({ backup: '백업', verify: '검증', restore: '복구', run: '지금 실행', 'nfsds-attach': 'NFS 연결', 'nfsds-detach': 'NFS 떼어 내기' });
/** 보존 정책 문구 — '7개' · '7개 · 30일'(v2.794 보존 기간). */
export const keepText = (j) => `${Number(j?.keep) || 0}개${Number(j?.keepDays) > 0 ? ` · ${Number(j.keepDays)}일` : ''}`;
/** 실행 사유 표시 — 모르는 값은 그대로(지어내지 않는다). */
export const TRIGGER_LABEL = Object.freeze({ schedule: '스케줄', auto: '자동', manual: '수동', resume: '재시작 뒤 재실행', restart: '재시작 정리' });
export const triggerText = (t) => TRIGGER_LABEL[t] || String(t || '');

/** 저장 위치별 사용량 — 잡 대상(데이터스토어 이름·엣지 마운트) 별 사본 바이트 합 + 인벤토리 용량. */
export function storageRows(jobs, datastores, nfsDs) {
  const m = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const key = j.dest?.type === 'nfs' ? `nfs|${j.dest.mountId}` : `ds|${j.vcenterId}|${j.dest?.datastoreName}`;
    if (!m.has(key)) {
      const inv = j.dest?.type === 'nfs' ? null : (datastores || []).find((d) => String(d.vcenterId) === String(j.vcenterId) && d.name === j.dest?.datastoreName)
        || (nfsDs || []).find((d) => String(d.vcenterId) === String(j.vcenterId) && d.name === j.dest?.datastoreName);
      m.set(key, { key, name: j.dest?.type === 'nfs' ? `NFS ${j.dest.mountId}` : j.dest?.datastoreName || '—', kind: j.dest?.type === 'nfs' ? 'nfs' : 'ds',
        capacityGB: inv?.capacityGB ?? null, freeGB: inv?.freeGB ?? null, bytes: 0, unknown: 0 });
    }
    const r = m.get(key); const b = cloneBytes(j.clones); r.bytes += b.bytes; r.unknown += b.unknown;
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

/** 필요 용량 예측(마법사) — VM 크기 × 보존. 모르면 null. */
export function capacityEstimate(vmGB, keep, freeGB) {
  const g = Number(vmGB); const k = Math.max(1, Math.min(30, Math.floor(Number(keep)) || 1));
  if (vmGB == null || !Number.isFinite(g) || g <= 0) return null;
  const needGB = g * k;
  const f = Number(freeGB);
  return { needGB, keep: k, freeGB: freeGB != null && Number.isFinite(f) ? f : null, fits: freeGB != null && Number.isFinite(f) ? needGB <= f : null };
}

/** 복구 새 이름 기본값 — 원본-restore-YYYYMMDD(포탈 시각은 서버가 정하지만 이름은 화면 시각으로 충분하다 — 사람이 고친다). */
export function restoreNameDefault(vmName, now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${String(vmName || 'vm').slice(0, 60)}-restore-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 진행 중 작업이 이 잡·이 사본에 있나(버튼 잠금 — 그 대상만 잠근다: web.md '긴 작업의 진행 중 잠금'). */
export function busyOp(ops, jobId, kind, ref = '') {
  return (ops || []).find((o) => o.state !== 'done' && o.jobId === jobId && o.kind === kind && (!ref || !o.ref || o.ref === ref)) || null;
}

/** 단계 타임라인 — 이력 phases(+ 진행 중 단계)를 줄로. */
export function phaseRows(entry, running = null) {
  const rows = (Array.isArray(entry?.phases) ? entry.phases : []).map((p) => ({ name: p.n, ms: p.ms, state: p.ok === false ? 'fail' : 'done' }));
  if (running?.phase) rows.push({ name: running.phase, ms: null, state: 'running' });
  return rows;
}

/** v2.794 이력 필터 — all · backup · verify · restore · fail(실패만 — 건너뜀 제외). 순서는 그대로. */
export const HISTORY_FILTERS = Object.freeze([['all', '전체'], ['backup', '백업'], ['verify', '검증'], ['restore', '복구'], ['fail', '실패만']]);
export function historyFilter(list, f = 'all') {
  const xs = Array.isArray(list) ? list : [];
  if (f === 'fail') return xs.filter((h) => runTone(h) === 'fail');
  if (f === 'backup' || f === 'verify' || f === 'restore') return xs.filter((h) => (h.kind || 'backup') === f);
  return xs;
}
/** v2.794 이력 CSV(순수) — 시각은 ISO(표계산이 읽는다) · 단계는 '이름 초' 를 ' > ' 로 잇는다. 값이 없으면 빈 칸. */
export function historyCsv(job, list) {
  const head = ['시각', 'VM', 'vCenter', '종류', '사유(실행)', '결과', '건너뜀', '소요(초)', '단계', '내용'];
  const lines = (Array.isArray(list) ? list : []).map((h) => [
    h.at ? new Date(h.at).toISOString() : '', job?.vmName || '', job?.vcenterId || '', KIND_LABEL[h.kind || 'backup'] || h.kind || '',
    h.trigger ? triggerText(h.trigger) : '', h.skipped ? '건너뜀' : h.ok ? '성공' : '실패', h.skipped || '',
    Number(h.ms) > 0 ? Math.round(h.ms / 1000) : '', (h.phases || []).map((p) => `${p.n} ${Math.round((Number(p.ms) || 0) / 1000)}s${p.ok === false ? '(실패)' : ''}`).join(' > '), h.detail || '',
  ]);
  return [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n');
}

/**
 * v2.795 RPO 초과 문구(서버 판정 jobs[].rpo 를 그대로 보여 준다 — 판정은 server/src/vmclone/rpo.js 하나). 초과가 아니면 ''.
 */
export function rpoText(rpo, now = Date.now()) {
  if (!rpo?.overdue) return '';
  const h = Math.round((Number(rpo.intervalMs) || 0) / 3_600_000);
  return rpo.lastOkAt ? `RPO 초과 · 마지막 성공 ${agoText(rpo.lastOkAt, now)}${h ? `(주기 ${h}시간)` : ''}` : `RPO 초과 · 성공한 백업 없음${h ? `(주기 ${h}시간)` : ''}`;
}
export const rpoOverdueCount = (jobs) => (Array.isArray(jobs) ? jobs : []).filter((j) => j?.rpo?.overdue).length;

// ───────────── v2.797 화면 개편(디자인 캔버스 'VM 백업 센터 디자인 v2' ①~⑥) — 새 시각 요소의 계산은 전부 여기 ─────────────

/** 남은 시간 문구('N분/시간/일 뒤'). 이미 지났으면 ''. */
export function untilText(ts, now = Date.now()) {
  const t = Number(ts);
  if (!t || !Number.isFinite(t) || t <= now) return '';
  const s = Math.round((t - now) / 1000);
  if (s < 60) return '1분 안';
  if (s < 3600) return `${Math.round(s / 60)}분 뒤`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 뒤`;
  return `${Math.round(s / 86400)}일 뒤`;
}

/**
 * 보호 현황 링 — 서버 RPO 판정(jobs[].rpo) 그대로 센다. 판정이 없는 잡(수동만·비활성·멈춘 위임·시작 시각 모름)은
 * 분모에 넣지 않고 따로 센다('못 읽은 값은 0 이 아니다'). judged 가 0 이면 pct 는 null(링에 '—').
 */
export function rpoSummary(jobs) {
  let judged = 0; let ok = 0; let overdue = 0; let manual = 0; let unjudged = 0; let disabled = 0; let noReport = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j?.exec && j.exec.where === 'edge' && !j.exec.reported) noReport++;
    if (j?.enabled === false) { disabled++; continue; }
    if (j?.rpo) { judged++; if (j.rpo.overdue) overdue++; else ok++; continue; }
    if (!j?.schedule?.mode || j.schedule.mode === 'manual') manual++; else unjudged++;
  }
  return { judged, ok, overdue, manual, unjudged, disabled, noReport, pct: judged ? Math.round((ok / judged) * 100) : null };
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 브라우저 시각 기준 그날 0시(ms). */
const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * 최근 days 일의 일별 백업 실행 수(오래된 날 → 오늘). 검증·복구는 넣지 않는다.
 * 이력은 잡마다 최근 historyMax 회만 남는다(서버 limits.historyMax) — 이력이 가득 찬 잡의 가장 오래된 기록보다 앞선 날은
 * 그 잡의 실행이 빠졌을 수 있으므로 partial 로 표시한다(세지 못한 것을 0 으로 보이지 않게). historyMax 를 모르면 판정하지 않는다.
 */
export function dayCounts(jobs, now = Date.now(), days = 14, { historyMax = null } = {}) {
  const today = dayStart(now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    // 날짜 산술은 Date 로(서머타임 지역에서 24시간 ≠ 하루).
    const d = new Date(today); d.setDate(d.getDate() - i);
    const start = d.getTime(); const e = new Date(d); e.setDate(e.getDate() + 1);
    out.push({ start, end: e.getTime(), label: `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`, ok: 0, warn: 0, fail: 0, skip: 0, total: 0, partial: false });
  }
  const from = out[0].start;
  let cutoff = null; // 이 시각 이전은 일부 잡의 이력이 잘렸을 수 있다
  const max = Number(historyMax);
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const hist = Array.isArray(j?.history) ? j.history : [];
    if (Number.isFinite(max) && max > 0 && hist.length >= max) {
      const oldest = hist.reduce((m, h) => (h?.at && (m == null || h.at < m) ? h.at : m), null);
      if (oldest != null && (cutoff == null || oldest > cutoff)) cutoff = oldest;
    }
    for (const h of backupRuns(j)) {
      const at = Number(h?.at);
      if (!at || at < from || at > now) continue;
      const day = out.find((x) => at >= x.start && at < x.end);
      if (!day) continue;
      const t = runTone(h);
      if (t === 'ok' || t === 'warn' || t === 'fail' || t === 'skip') day[t]++;
      if (t !== 'skip') day.total++;
    }
  }
  if (cutoff != null) for (const x of out) if (x.start < cutoff) x.partial = true;
  return out;
}

/** 실행 단계 문구 끝의 진행률('클론 → ds · 42%') — 없으면 null(진행률을 지어내지 않는다). */
export function progressOf(phase) {
  const m = /·\s?(\d{1,3})%$/.exec(String(phase || '').slice(-12));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** v2.797 잡 표 필터 칩 — 전체 · 실패 · RPO 초과 · 검증 실패 · 비활성. */
export const JOB_FILTERS = Object.freeze([['all', '전체'], ['fail', '실패'], ['rpo', 'RPO 초과'], ['verifyFail', '검증 실패'], ['off', '비활성']]);
const JOB_FILTER_TEST = {
  all: () => true,
  fail: (j) => { const s = jobState(j); return s === 'fail' || s === 'problem'; },
  rpo: (j) => !!j?.rpo?.overdue,
  verifyFail: (j) => { const v = lastVerify(j); return !!v && !v.ok; },
  off: (j) => j?.enabled === false,
};
export function jobFilter(jobs, f = 'all') {
  const xs = Array.isArray(jobs) ? jobs : [];
  return xs.filter(JOB_FILTER_TEST[f] || JOB_FILTER_TEST.all);
}
export function jobFilterCounts(jobs) {
  return Object.fromEntries(JOB_FILTERS.map(([k]) => [k, jobFilter(jobs, k).length]));
}

/**
 * 다음 실행 문구 — 'N시간 간격' 만 계산한다(서버 isDue 와 같은 규칙: 마지막 실행 + N시간). '매일 HH:MM' 은 **포탈 시각**이라
 * 브라우저 시각으로 다시 계산하면 시간대가 다른 PC 에서 틀린다 — 스케줄 문구가 이미 시각을 말하므로 ''.
 */
export function nextRunText(job, now = Date.now()) {
  if (!job || job.enabled === false || job.schedule?.mode !== 'interval') return '';
  const h = Number(job.schedule.hours);
  const last = Number(job.lastRun?.at);
  if (!Number.isFinite(h) || h <= 0) return '';
  if (!last) return '첫 실행 대기';
  const next = last + h * 3_600_000;
  return next <= now ? '주기 도래 · 곧 실행' : `${untilText(next, now)} 실행`;
}

/**
 * 세션 단계 간트 — 끝난 실행의 phases 를 누적 시각으로 배치한다(left·width %). ms 를 모르는 단계는 폭 0 으로 두고 시간 칸에 '—'.
 */
export function ganttRows(entry) {
  const ph = Array.isArray(entry?.phases) ? entry.phases : [];
  const total = ph.reduce((a, p) => a + (Number(p?.ms) > 0 ? Number(p.ms) : 0), 0);
  let acc = 0;
  const rows = ph.map((p) => {
    const ms = Number(p?.ms) > 0 ? Number(p.ms) : null;
    const left = total ? (acc / total) * 100 : 0;
    const width = total && ms ? Math.max(0.8, (ms / total) * 100) : 0;
    acc += ms || 0;
    return { name: p?.n || '—', ms, state: p?.ok === false ? 'fail' : 'done', left: Math.min(100, left), width: Math.min(100 - Math.min(100, left), width) };
  });
  return { rows, totalMs: total };
}

/**
 * 복원 지점 가로 타임라인 — 최근 max 개를 가장 오래된 지점 ~ 지금 사이에 놓는다(left %). 시각 모르는 사본은 빼고 따로 센다.
 * tone: ok(부팅 확인) · fail(검증 실패) · none(미검증). latest: 가장 최근 지점.
 */
export function pointTimeline(clones, now = Date.now(), max = 12) {
  const all = Array.isArray(clones) ? clones : [];
  const known = all.filter((c) => Number(c?.at) > 0).sort((a, b) => a.at - b.at).slice(-max);
  const unknown = all.filter((c) => !(Number(c?.at) > 0)).length;
  if (!known.length) return { points: [], from: null, to: now, unknown };
  const from = known[0].at;
  const to = Math.max(now, known[known.length - 1].at);
  const span = Math.max(to - from, 3_600_000);
  const points = known.map((c, i) => ({
    ref: c.ref, at: c.at, left: known.length === 1 ? 50 : Math.min(100, Math.max(0, ((c.at - from) / span) * 100)),
    tone: c.verify ? (c.verify.ok ? 'ok' : 'fail') : 'none', latest: i === known.length - 1,
  }));
  return { points, from, to, unknown };
}

/**
 * 저장소 미터 — 지금 쓰는 양 + 이번에 들어갈 양을 전체 대비 %로. 전체·여유를 모르면 null(막대를 그리지 않는다).
 * needGB 를 모르면 used 만. over: 들어갈 양이 여유보다 크다.
 */
export function meterOf({ capacityGB, freeGB, needGB = null } = {}) {
  const cap = capacityGB == null ? NaN : Number(capacityGB); const free = freeGB == null ? NaN : Number(freeGB);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(free) || free < 0) return null;
  const used = Math.max(0, Math.min(cap, cap - free));
  const need = needGB == null || !Number.isFinite(Number(needGB)) || Number(needGB) < 0 ? null : Number(needGB);
  const usedPct = (used / cap) * 100;
  const needPct = need == null ? 0 : Math.min(100 - usedPct, (need / cap) * 100);
  return { usedPct: Math.round(usedPct * 10) / 10, needPct: Math.round(needPct * 10) / 10, over: need != null && need > free, freeGB: free, capacityGB: cap };
}
