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
