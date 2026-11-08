/**
 * bmusage/collectHealth.js — 리눅스 성능 6단계 **수집 건강(메타 모니터링)**(설계 PROFILES §16 C · 아트보드 Collect).
 *
 * 수집 노드(엣지 또는 중앙 직접 수집분)가 **매 주기** 자기 수집을 잰다 — 주기 소요/예산 · 성공률 · 실패 사유(상태 9종과 같은 분류 — missReason 코어 하나) ·
 *   동시성 사용 최대 n/설정값(slots peak) · SSH 소요 중앙값/p95 · 기간 파일 수 · 크기(실측 — stat) · 집중 진행/대기 · 피크 창 결정(peakPlan).
 *   중앙은 봉투(`collectHealth`)로 받아 그대로 보인다(다시 판정하지 않는다 — 기준 대조 cells 도 수집 노드가 만든다).
 * ⚠ 무음 실패 금지 — 0대 주기 · 분류 실패 주기도 상태를 쓴다(servers 0 · 사유).
 * ⚠ 결측은 0 이 아니다 — 대상 0대면 성공률 null(100% 도 0% 도 아니다) · DB 상한을 정하지 않았으면 dbPct null · SSH 를 한 번도 안 열었으면 p50/p95 null.
 * ⚠ 서버 이름은 싣지 않는다 — 사유별 개수와 ‘며칠째’(이 프로세스가 본 뒤부터 — 재시작하면 다시 센다: sinceFrom) 뿐. 법인별 분해(byCorp)는 범위를 거는 라우트만 쓴다
 *   (bmUsageStatus 의 last 는 무스코프로 나간다 — v2.550.3 ‘last 에 counts 를 싣지 않는다’ 와 같은 판단으로 여기 값은 status 에 넣지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { numOrNull } from '../util/numOrNull.js';
import { osMissOf, idracMissOf } from './missReason.js';
import { parseFileName, FAMILIES } from './monthStore.js';

const n = numOrNull;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
/** 실패 사유 code(경로별) — FOCUS_MISS 와 같은 열거에서 no-path 를 뺀 것. 웹 문구 표와 1:1. */
export const HEALTH_REASON_CODES = Object.freeze(['auth', 'auth-stopped', 'timeout', 'ssh-error', 'host-key', 'not-linux', 'unreachable', 'pool-busy', 'no-telemetry', 'error']);
/** 정상인 빈 칸(실패가 아님) — 리포트 없음(텔레메트리 라이선스) · 첫 주기 · PSI 없음. */
export const HEALTH_INFO_CODES = Object.freeze(['no-telemetry', 'first', 'psi-absent']);
/** 사유 → 상태 9종(웹 STATE_TEXT 의 id) — 화면이 ‘기존 상태와 같은 분류’ 로 말한다. */
export function reasonState(pathId, code) {
  if (code === 'auth' || code === 'auth-stopped') return 'auth';
  if (code === 'no-telemetry') return 'osOnly';
  return pathId === 'os' ? 'idracOnlyUnread' : 'osOnlyUnread';
}
/** 수집 건강 기준(perfRules.collect — 알림 규칙 ‘수집 건강’ 행과 보드 상태가 같은 값). */
export const COLLECT_DEFAULTS = Object.freeze({ cyclePct: 80, successPct: 90, dbPct: 90, dbCapGb: 20 });
export const NODE_FLAGS = Object.freeze(['cycle', 'success', 'db', 'auth', 'error']);
/**
 * 주기 실패 code(반증 F1) — 이번 주기 대상 · 결과를 **모른다**(대상 0대가 아니다 · 정상도 아니다): 분류 실패 · 주기 예외 · 수집 건강 계산 실패.
 *   'no-targets' 는 사실 0(실패 아님). 열거 밖 값은 'health-failed' 로 본다(엣지 문자열을 그대로 싣지 않는다).
 */
export const CYCLE_ERRORS = Object.freeze(['classify-failed', 'cycle-error', 'health-failed']);
export const NODE_ERRORS = Object.freeze([...CYCLE_ERRORS, 'no-targets']);
export const isCycleFailure = (e) => CYCLE_ERRORS.includes(e);
/** 봉투 표지(반증 F3) — 6단계 엣지는 첫 주기 전에도 이 값을 싣는다(필드 없음 = 구버전 · 표지만 있음 = 아직 주기 없음). */
export const COLLECT_HEALTH_VER = 1;

/** 백분위(가장 가까운 순위 — 순수). 빈 배열이면 null. */
export function pctl(values = [], p = 50) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

/**
 * 한 주기 요약(순수 — 폴러가 부른다). results 는 poller 의 주기 결과([{ ok, target, os, idrac, osMs, built }]).
 * @param {{results:Array, startedAt:number, endedAt:number, intervalMs:number, concurrency:number, slotPeak:number|null, focus?:object, peakPlan?:object|null,
 *          sinceMap?:Map, now?:number, error?:string|null}} p
 * @returns {{ node:object, byCorp:object, sinceMap:Map }}
 */
export function summarizeCycle({ results = [], startedAt, endedAt, intervalMs, concurrency, slotPeak = null, focus = null, peakPlan = null, sinceMap = new Map(), now = Date.now(), error = null } = {}) {
  /*
   * 8a단계 정비 창(설계 §20 ⑲): ④ 수집 중단으로 건너뛴 서버(maintSkip)와 창 안에서 실패한 서버(inMaint && !ok — 인증 거부는 폴러가 inMaint 를 달지 않는다)는
   *   **성공률 분모 · 실패 사유에서 빼고 따로 센다**(node.maint · byCorp[vc].maintSkipped/maintFail) — ‘정비 중’ 은 실패도 정상도 아니다.
   */
  const all = results.filter((r) => r && r.target && r.target.key);
  const maint = { skipped: 0, failInWindow: 0 };
  const byCorp = {};
  const live = [];
  for (const r of all) {
    const vc = String(r.target.vcenterId || '');
    if (r.maintSkip) { maint.skipped += 1; (byCorp[vc] ||= { servers: 0, ok: 0, fail: 0, reasons: {} }).maintSkipped = ((byCorp[vc].maintSkipped) || 0) + 1; continue; }
    if (r.inMaint && !r.ok) { maint.failInWindow += 1; (byCorp[vc] ||= { servers: 0, ok: 0, fail: 0, reasons: {} }).maintFail = ((byCorp[vc].maintFail) || 0) + 1; continue; }
    live.push(r);
  }
  const reasons = new Map();   // `${path}:${code}` → { path, code, n }
  const info = { 'no-telemetry': 0, first: 0, 'psi-absent': 0 };
  const sshMs = [];
  const nextSince = new Map();
  let ok = 0;
  for (const r of live) {
    const vc = String(r.target.vcenterId || '');
    const c = (byCorp[vc] ||= { servers: 0, ok: 0, fail: 0, reasons: {} });
    c.servers += 1;
    if (r.ok) { ok += 1; c.ok += 1; } else c.fail += 1;
    const paths = Array.isArray(r.target.paths) ? r.target.paths : [];
    const codes = [];
    if (paths.includes('os') && !r.demo) { const m = osMissOf(r.os); if (m && m !== 'no-path') codes.push(['os', m]); }
    if (paths.includes('idrac') && !r.demo) { const m = idracMissOf(r.idrac); if (m && m !== 'no-path') codes.push(['idrac', m]); }
    // 수집 함수가 예외로 끝난 서버(결과 없이 error 만)는 사유 ‘error’ — 경로가 없어 시도하지 않은 것(noPath)과 구분한다.
    if (!r.ok && !codes.length && r.error) codes.push([paths.includes('os') ? 'os' : 'idrac', 'error']);
    for (const [p, code] of codes) {
      if (code === 'no-telemetry') { info['no-telemetry'] += 1; continue; }
      const k = `${p}:${code}`;
      const cur = reasons.get(k) || { path: p, code, n: 0, since: null };
      cur.n += 1;
      const sk = `${r.target.key}|${k}`;
      const since = sinceMap.get(sk) ?? now;
      nextSince.set(sk, since);
      cur.since = cur.since == null ? since : Math.min(cur.since, since);
      reasons.set(k, cur);
      c.reasons[k] = (c.reasons[k] || 0) + 1;
    }
    if (r.built?.perfFlags?.firstSample) info.first += 1;
    if (r.built?.perfFlags?.psiAbsent) info['psi-absent'] += 1;
    if (n(r.osMs) != null) sshMs.push(n(r.osMs));
  }
  const servers = live.length;
  const cycleMs = n(endedAt) != null && n(startedAt) != null ? Math.max(0, endedAt - startedAt) : null;
  const budgetMs = n(intervalMs);
  const err = error ? (NODE_ERRORS.includes(error) ? error : 'health-failed') : null;
  const failed = isCycleFailure(err);   // 대상 · 결과를 모르는 주기 — 대상 수 · 성공 수는 null(0 이 아니다)
  const node = {
    at: now, cycleMs, budgetMs, cyclePct: cycleMs != null && budgetMs ? r1((cycleMs / budgetMs) * 100) : null,
    servers: failed ? null : servers, ok: failed ? null : ok, fail: failed ? null : servers - ok, successPct: !failed && servers ? r1((ok / servers) * 100) : null,
    reasons: [...reasons.values()].map((x) => ({ ...x, state: reasonState(x.path, x.code) })).sort((a, b) => b.n - a.n),
    info,
    conc: { max: n(slotPeak), cap: n(concurrency) },
    ssh: { n: sshMs.length, p50Ms: pctl(sshMs, 50), p95Ms: pctl(sshMs, 95) },
    focus: focus ? { running: n(focus.running) ?? 0, queued: n(focus.queued) ?? 0 } : null,
    peakPlan: peakPlan ? { windowS: n(peakPlan.windowS), capS: n(peakPlan.capS), reason: String(peakPlan.reason || '').slice(0, 32), expectedMs: n(peakPlan.expectedMs), budgetMs: n(peakPlan.budgetMs) } : null,
    // 8a단계: 정비 중(건너뜀 · 창 안 실패) — 주기 실패면 모름(null). leak(창 끝 뒤 억제)은 주기 끝 점검이 채운다(폴러).
    maint: failed ? null : { ...maint },
    ...(err ? { error: err } : {}),
  };
  return { node, byCorp: failed ? {} : byCorp, sinceMap: nextSince };
}

/**
 * 저장 실측(비동기 stat — 이벤트 루프를 막지 않는다). 메인 bm-usage.db(+ -wal) · 기간 파일 가족별 개수 · 크기.
 * @returns {Promise<{mainBytes:number|null, walBytes:number|null, families:object, files:number, bytes:number}>}
 */
export async function dbFilesNow(dir) {
  const fams = Object.fromEntries(Object.keys(FAMILIES).map((f) => [f, { files: 0, bytes: 0, first: null, last: null }]));
  let mainBytes = null; let walBytes = null; let files = 0; let bytes = 0; let unread = 0;
  let names = [];
  // 디렉터리를 못 읽으면 크기는 ‘모름’(null)이다 — 0 으로 두면 저장 상한 칸이 ‘기준 안’ 으로 읽힌다(결측은 0 이 아니다).
  // 가족별 개수 · 크기도 모름(null) — 0개 0KB 로 그리지 않는다(반증 F5).
  try { names = await fs.promises.readdir(dir); } catch { return { mainBytes, walBytes, families: null, files: null, bytes: null, error: 'readdir' }; }
  const size = async (f) => { try { return (await fs.promises.stat(path.join(dir, f))).size; } catch { return null; } };
  for (const f of names) {
    if (f === 'bm-usage.db') { mainBytes = await size(f); if (mainBytes == null) unread += 1; continue; }
    if (f === 'bm-usage.db-wal') { walBytes = await size(f); continue; }   // WAL 은 체크포인트 사이에 사라질 수 있다(못 읽음으로 세지 않는다)
    const p = parseFileName(f);
    if (!p) continue;
    const s = await size(f);
    if (s == null) { unread += 1; continue; }
    const fam = fams[p.family];
    fam.files += 1; fam.bytes += s;
    fam.first = fam.first == null || p.key < fam.first ? p.key : fam.first;
    fam.last = fam.last == null || p.key > fam.last ? p.key : fam.last;
    files += 1; bytes += s;
  }
  // 크기를 못 읽은 파일이 있으면 합은 부분 합이다 — 합을 내지 않고(null) 못 읽은 수를 따로 센다(부분 합으로 상한 대조를 하지 않는다).
  // 가족별 값은 읽은 파일만의 부분 합 — partial 표지로 밝힌다(화면이 ‘부분’ 을 붙인다 · 반증 F5).
  if (unread) return { mainBytes, walBytes, families: fams, files, bytes: null, unread, partial: true };
  return { mainBytes, walBytes, families: fams, files, bytes: bytes + (mainBytes || 0) + (walBytes || 0) };
}

/**
 * 기준 대조(순수 — 알림 규칙 ‘수집 건강’ 행과 보드 상태가 이 함수 하나를 쓴다). 칸: 'true'(기준 밖) · 'false'(안) · 'unread'(값 없음 — 판정 보류).
 */
export function collectCells(node = {}, db = null, cfg = COLLECT_DEFAULTS) {
  const c = { ...COLLECT_DEFAULTS, ...(cfg || {}) };
  const capBytes = n(c.dbCapGb) && c.dbCapGb > 0 ? c.dbCapGb * 1024 ** 3 : null;
  const dbPct = capBytes && n(db?.bytes) != null ? r1((db.bytes / capBytes) * 100) : null;
  const cyclePct = n(node.cyclePct); const successPct = n(node.successPct);
  return {
    cells: {
      cycle: cyclePct == null ? 'unread' : cyclePct >= c.cyclePct ? 'true' : 'false',
      success: successPct == null ? 'unread' : successPct < c.successPct ? 'true' : 'false',
      db: dbPct == null ? 'unread' : dbPct >= c.dbPct ? 'true' : 'false',
      auth: (node.reasons || []).some((x) => x.code === 'auth' || x.code === 'auth-stopped') ? 'true' : (node.reasons ? 'false' : 'unread'),
      error: isCycleFailure(node.error) ? 'true' : 'false',   // 주기 실패(분류 · 예외) — 반증 F1: 실패 주기가 ‘정상 · 대상 0’ 으로 보이지 않게
    },
    dbPct, capBytes, th: { cyclePct: c.cyclePct, successPct: c.successPct, dbPct: c.dbPct, dbCapGb: c.dbCapGb },
  };
}

/** 주기 추이(DB 행 → 1시간 칸 — 순수). 칸마다 최대 소요 · 예산 · 최저 성공률 · 최대 동시 사용. */
export function hourlyTrend(rows = [], { maxPoints = 200 } = {}) {
  const H = 3_600_000;
  const m = new Map();
  for (const r of rows) {
    const t = n(r.ts); if (t == null) continue;
    const h = Math.floor(t / H) * H;
    const cur = m.get(h) || { t: h, maxMs: null, budgetMs: null, minOkPct: null, concMax: null, cycles: 0 };
    const ms = n(r.ms); const b = n(r.budget_ms); const sv = n(r.servers); const okc = n(r.ok); const cm = n(r.conc_max);
    if (ms != null) cur.maxMs = cur.maxMs == null ? ms : Math.max(cur.maxMs, ms);
    if (b != null) cur.budgetMs = cur.budgetMs == null ? b : Math.max(cur.budgetMs, b);
    if (sv) { const p = r1((okc / sv) * 100); cur.minOkPct = cur.minOkPct == null ? p : Math.min(cur.minOkPct, p); }
    if (cm != null) cur.concMax = cur.concMax == null ? cm : Math.max(cur.concMax, cm);
    cur.cycles += 1;
    m.set(h, cur);
  }
  return [...m.values()].sort((a, b) => a.t - b.t).slice(-maxPoints);
}
