/**
 * issues/alertIssues.js — 다른 알람 → 이슈 자동 등록(v2.908 · 기능 추천 10 · 시안 docs/design/wiki-issues ⑪ '다른 알람(다음 단계)').
 * 파트 장애 자동 등록(autoCreate.js)과 같은 틀 — 출처(origin) · 중복(열린 이슈가 있으면 댓글) · 하루 상한 · 해소 댓글 · 설정에 따라 '검토'.
 *
 * 무엇을(설정 › 자동 등록 › 다른 알람 — 파일 `issue-alert-auto.json`, 비밀 없음 · 기본 꺼짐):
 *   알람 엔진(alerts.js onAlertState)의 상태 알람 — vCenter 수집 실패(vc) · 엣지 보고 끊김(vcstale) · 호스트 연결 끊김(host) · 데이터스토어 용량(ds) ·
 *   vCenter 위험 알람(alarm) · VM 동시 전원 꺼짐(massoff). 오버커밋(ramoc · vcpuoc)은 용량 경고라 대상에서 뺐다.
 *   Bareos 백업 실패(backup — bareos/notify.js onBareosFailures).
 *   인증서 만료(cert — v2.929 · security/certMonitor.js onCertResults). ⚠ 정정: v2.908 은 '인증서 만료는 판정이 없다' 고 적었는데, 알람 엔진에만
 *   없고 certMonitor 가 vCenter · NSX 443 인증서를 12시간마다 확인해 남은 30일 이하(critical) · 만료(expired)를 판정한다 — 그 판정을 쓴다.
 *
 * 언제:
 *   · 상태 알람은 **delayMin 분 넘게 이어질 때** 만든다(잠깐 깜빡인 알람으로 이슈가 쌓이지 않게). 같은 알람 키의 열린 이슈가 있으면 만들지 않는다.
 *     해소되면 댓글 · onResolve='review' 면 '검토' 로(완료는 사람이). 해소 뒤 다시 나면 같은 열린 이슈에 '다시 발생 N회째' 댓글.
 *     판정 보류(못 읽음)로 끊긴 것은 해소가 아니다 — 알람 엔진이 resolved 에 넣지 않는다.
 *   · 백업 실패는 잡(Director · 잡 이름)마다 열린 이슈 하나 — 같은 잡이 또 실패하면 그 이슈에 댓글(jobid 로 두 번 쓰지 않는다). 성공해도 닫지 않는다(사람이).
 *   · 인증서는 대상(vCenter · NSX)마다 열린 이슈 하나 — 남은 30일 이하 · 만료면 만들고(지연 없음 — 12시간 주기라), 만료로 바뀌면 한 번 댓글,
 *     갱신돼 남은 날이 30일을 넘으면 해소(댓글 · 설정에 따라 검토). 확인 실패 · 차단 · 모름은 판정 보류(아무것도 하지 않는다).
 *   · 하루(포탈 날짜) 상한 dailyMax — 넘으면 만들지 않고 센다(status.capped · 콘솔 하루 한 줄).
 * 법인: 알람의 vcenterId(없으면 공용 — 지어내지 않는다). 저장은 라우트가 관리자 + 전체 범위 + 쓰기 범위 무제한으로 막는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { capStr } from '../util/capStr.js';
import { dayKey, DAY_MS, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { createIssue, addComment, setStatus, findByOrigin, patchOrigin, originCreatedSince, issueStats, PRIORITIES } from './store.js';
import { loadIssueSettings, suggestAssignee } from './settings.js';
import { issueViewers } from './visibility.js';

export const ALERT_ISSUE_KINDS = Object.freeze(['vc', 'vcstale', 'host', 'ds', 'alarm', 'massoff', 'backup', 'cert']);
export const ALERT_KIND_LABEL = Object.freeze({
  vc: 'vCenter 수집 실패', vcstale: '엣지 보고 끊김', host: '호스트 연결 끊김', ds: '데이터스토어 용량', alarm: 'vCenter 위험 알람', massoff: 'VM 동시 전원 꺼짐', backup: 'Bareos 백업 실패',
  cert: '인증서 만료(30일 이하 · 만료)', // v2.929
});
// v2.932(점검 B1-03) noteWindowMin — 한 이슈의 재발 · 해소 자동 댓글은 이 창마다 한 번(그 사이 변화는 수만 세어 다음 댓글에 싣는다)
export const ALERT_ISSUE_LIMITS = Object.freeze({ delayMin: [0, 1440], dailyMax: [1, 500], labels: 10, label: 30, noteWindowMin: 30 });
export const ALERT_NOTE_WINDOW_MS = ALERT_ISSUE_LIMITS.noteWindowMin * 60_000;
export function defaultAlertAuto() {
  return {
    enabled: false,
    kinds: { vc: true, vcstale: true, host: false, ds: false, alarm: false, massoff: true, backup: false, cert: false },
    priority: { vc: 'p1', vcstale: 'p1', host: 'p1', ds: 'p2', alarm: 'p1', massoff: 'p0', backup: 'p2', cert: 'p1' },
    delayMin: 10, dailyMax: 30, labels: ['alert', 'auto'], onResolve: 'review',
  };
}
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }

export function normalizeAlertAuto(raw, { strict = true } = {}) {
  const d = defaultAlertAuto();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let dropped = 0;
  const bad = (field, msg) => { if (strict) throw fieldError(field, msg); dropped += 1; };
  const kinds = {}; const priority = {};
  for (const k of ALERT_ISSUE_KINDS) {
    const v = r.kinds?.[k];
    if (v == null) kinds[k] = d.kinds[k]; else if (typeof v === 'boolean') kinds[k] = v; else { bad(`kinds.${k}`, 'true 또는 false 여야 합니다'); kinds[k] = d.kinds[k]; }
    const p = r.priority?.[k];
    if (p == null) priority[k] = d.priority[k]; else if (PRIORITIES.includes(p)) priority[k] = p; else { bad(`priority.${k}`, `${PRIORITIES.join('·')} 중 하나여야 합니다`); priority[k] = d.priority[k]; }
  }
  const int = (v, [lo, hi], field, def) => {
    if (v == null || v === '') return def;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN);
    if (Number.isInteger(n) && n >= lo && n <= hi) return n;
    bad(field, `${lo}~${hi} 의 정수여야 합니다`); return def;
  };
  let labels = d.labels;
  if (r.labels != null) {
    const list = Array.isArray(r.labels) ? r.labels : (typeof r.labels === 'string' ? r.labels.split(',') : null);
    if (!list) bad('labels', '배열이어야 합니다');
    else {
      labels = [...new Set(list.map((x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
      if (labels.length > ALERT_ISSUE_LIMITS.labels || labels.some((x) => x.length > ALERT_ISSUE_LIMITS.label)) {
        bad('labels', `라벨은 ${ALERT_ISSUE_LIMITS.label}자 · ${ALERT_ISSUE_LIMITS.labels}개까지입니다`);
        labels = labels.filter((x) => x.length <= ALERT_ISSUE_LIMITS.label).slice(0, ALERT_ISSUE_LIMITS.labels);
      }
    }
  }
  let onResolve = d.onResolve;
  if (r.onResolve != null) { if (['review', 'keep'].includes(r.onResolve)) onResolve = r.onResolve; else bad('onResolve', 'review·keep 중 하나여야 합니다'); }
  return {
    value: {
      enabled: r.enabled === true, kinds, priority, labels, onResolve,
      delayMin: int(r.delayMin, ALERT_ISSUE_LIMITS.delayMin, 'delayMin', d.delayMin),
      dailyMax: int(r.dailyMax, ALERT_ISSUE_LIMITS.dailyMax, 'dailyMax', d.dailyMax),
    },
    dropped,
  };
}

/* ───── 저장소 ───── */
const fileOf = () => path.join(config.configDir, 'issue-alert-auto.json');
let cache = null;
const loadErr = makeLoadError();
export function loadAlertAuto() {
  if (cache) return cache;
  const f = fileOf();
  loadErr.clear();
  try {
    if (fs.existsSync(f)) {
      const { value, dropped } = normalizeAlertAuto(JSON.parse(fs.readFileSync(f, 'utf8')), { strict: false });
      if (dropped) console.warn(`[issues] issue-alert-auto.json 의 형식 밖 항목 ${dropped}개를 읽지 않았습니다`);
      cache = value;
      return cache;
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    loadErr.set(safeLoadText(e) || '사유 미상');
    console.warn(`[issues] issue-alert-auto.json 을 읽지 못해 기본값(다른 알람 자동 등록 꺼짐)으로 시작합니다: ${loadErr.get().reason}`);
  }
  loadErr.checkCorruptOnly(f);
  cache = defaultAlertAuto();
  return cache;
}
export function alertAutoLoadError() { loadAlertAuto(); return loadErr.get()?.reason || null; }
export function saveAlertAuto(body) {
  const { value } = normalizeAlertAuto(body, { strict: true });
  atomicWriteFileSync(fileOf(), JSON.stringify(value, null, 1), { mode: 0o600 });
  cache = value; loadErr.clear();
  return value;
}

/* ───── 판정(순수) ───── */
/** 알람 키 → 종류(대상이 아니면 ''). */
export function alertKindOf(key) { const k = String(key || '').split(':')[0]; return ALERT_ISSUE_KINDS.includes(k) && k !== 'backup' && k !== 'cert' ? k : ''; }

/**
 * 알람 상태 → 할 일(순수 — 테스트가 고정).
 * @param {{ firing:Array<{key,alert,since}>, resolved:Array<{key,alert}> }} st
 * @param {object} cfg  loadAlertAuto()
 * @param {{ existing:Array, now:number, createdToday:number }} ctx  existing = findByOrigin(kind 'alert')
 *
 * v2.932(점검 B1-03 — 재현: 2분마다 깜빡이는 호스트가 약 4시간에 댓글 200개를 채워 담당자 댓글이 409):
 *   · 다시 발생(again)도 **delayMin 분 넘게 이어질 때만**(새로 만들 때와 같은 유예 — 잠깐 깜빡인 것은 재발로 치지 않는다).
 *   · 재발 · 해소 댓글은 이슈마다 ALERT_NOTE_WINDOW_MS 에 한 번 — 창 안이면 note:false(댓글 없이 출처에 수만 센다). 재발 횟수(reopen)는 계속 센다.
 *   · 묶어 둔 변화가 있고 창이 지났는데 이번에 그 이슈에 다른 할 일이 없으면 summary(요약 댓글 한 줄 · 지금 해소 상태면 '검토').
 */
export function planAlertIssues(st, cfg, { existing = [], now = Date.now(), createdToday = 0 } = {}) {
  const actions = []; let capped = 0;
  const byKey = new Map();
  for (const x of existing) if (x.origin?.alertKey) byKey.set(x.origin.alertKey, x);
  const noteDue = (o) => now - (Number(o?.noteAt) || 0) >= ALERT_NOTE_WINDOW_MS;
  const touched = new Set();
  let room = Math.max(0, cfg.dailyMax - createdToday);
  for (const f of st?.firing || []) {
    const kind = alertKindOf(f.key);
    if (!kind || !cfg.kinds[kind]) continue;
    const ex = byKey.get(f.key);
    const young = now - (Number(f.since) || now) < cfg.delayMin * 60_000;
    if (ex) {
      if (ex.origin.resolvedAt && !young) { actions.push({ type: 'again', key: ex.key, f, note: noteDue(ex.origin) }); touched.add(ex.key); }
      continue;
    }
    if (young) continue;
    if (room <= 0) { capped += 1; continue; }
    room -= 1;
    actions.push({ type: 'create', kind, f });
  }
  for (const r of st?.resolved || []) {
    const ex = byKey.get(r.key);
    if (ex && !ex.origin.resolvedAt) { actions.push({ type: 'resolve', key: ex.key, r, note: noteDue(ex.origin) }); touched.add(ex.key); }
  }
  for (const x of existing) {
    const o = x.origin || {};
    if (!o.alertKey || touched.has(x.key) || !alertKindOf(o.alertKey)) continue;
    if ((Number(o.quietAgain) || 0) + (Number(o.quietResolve) || 0) > 0 && noteDue(o)) actions.push({ type: 'summary', key: x.key });
  }
  return { actions, capped };
}

/** 백업 실패 행 → 할 일(순수). 잡 열쇠 = Director|잡 이름. 복원 실패는 이번 범위에 넣지 않는다(사람이 바로 보고 있는 작업이다). */
export const backupJobKey = (r) => `${String(r.directorId || '')}|${String(r.jobName || '')}`;
export function planBackupIssues(rows, cfg, { existing = [], createdToday = 0 } = {}) {
  const actions = []; let capped = 0;
  if (!cfg.kinds.backup) return { actions, capped };
  const byKey = new Map();
  for (const x of existing) if (x.origin?.alertKey) byKey.set(x.origin.alertKey, x);
  const groups = new Map();
  for (const r of rows || []) {
    if (r?.kind !== 'backup' || !r.jobName) continue;
    const k = backupJobKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let room = Math.max(0, cfg.dailyMax - createdToday);
  for (const [k, list] of groups) {
    const ex = byKey.get(k);
    const fresh = ex ? list.filter((r) => !(ex.origin.partKeys || []).includes(String(r.jobid))) : list;
    if (!fresh.length) continue;
    if (ex) { actions.push({ type: 'again', key: ex.key, rows: fresh }); continue; }
    if (room <= 0) { capped += 1; continue; }
    room -= 1;
    actions.push({ type: 'create', jobKey: k, rows: fresh });
  }
  return { actions, capped };
}

/** 인증서 확인 결과 → 할 일(순수 — v2.929). 열쇠 = 'cert:<vcenter|nsx>:<id>'. partKeys 에 본 상태(critical · expired)를 적어 같은 상태 댓글을 두 번 달지 않는다. */
export const CERT_BAD = Object.freeze(['critical', 'expired']);
export const CERT_GOOD = Object.freeze(['ok', 'expiring']); // 남은 날이 30일을 넘는다 — 갱신된 것으로 본다(expiring = 31~90일)
export const certKey = (c) => `cert:${String(c?.kind || '')}:${String(c?.id || '')}`;
export function planCertIssues(items, cfg, { existing = [], createdToday = 0 } = {}) {
  const actions = []; let capped = 0;
  if (!cfg.kinds.cert) return { actions, capped };
  const byKey = new Map();
  for (const x of existing) if (x.origin?.alertKey) byKey.set(x.origin.alertKey, x);
  let room = Math.max(0, cfg.dailyMax - createdToday);
  for (const c of Array.isArray(items) ? items : []) {
    if (!c?.id || !c.kind) continue;
    const key = certKey(c);
    const ex = byKey.get(key);
    if (CERT_BAD.includes(c.status)) {
      if (ex) {
        const seen = ex.origin.partKeys || [];
        if (ex.origin.resolvedAt) actions.push({ type: 'again', key: ex.key, c });
        else if (!seen.includes(c.status)) actions.push({ type: 'worse', key: ex.key, c });
        continue;
      }
      if (room <= 0) { capped += 1; continue; }
      room -= 1;
      actions.push({ type: 'create', certKey: key, c });
    } else if (CERT_GOOD.includes(c.status) && ex && !ex.origin.resolvedAt) {
      actions.push({ type: 'resolve', key: ex.key, c });
    }
    // error · blocked · unknown — 판정 보류(확인하지 못한 것은 갱신도 만료도 아니다)
  }
  return { actions, capped };
}

/* ───── 실행 ───── */
const SYSTEM_USER = 'alert-auto';
// v2.932(점검 B1-03): quiet — 창 안이라 댓글 없이 센 재발 · 해소 수 · commentCapped — 자동 댓글 상한(autoCommentMax)에 닿아 달지 못한 수
const freshStatus = () => ({ ranAt: null, created: 0, commented: 0, review: 0, capped: 0, errors: 0, error: null, cappedAt: null, quiet: 0, commentCapped: 0 });
const status = freshStatus();
let capWarnedDay = '';
export function alertIssuesStatus() { return { ...status }; }
function todayStartMs(now) { const k = dayKey(now); return k ? Date.parse(`${k}T00:00:00Z`) - DAY_OFFSET_MIN * 60_000 : now - (now % DAY_MS); }
function portalTime(ms) { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n + DAY_OFFSET_MIN * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '모름'; }
const createdToday = (now) => originCreatedSince('alert', todayStartMs(now)) + originCreatedSince('backup', todayStartMs(now));
function noteCap(capped, cfg, now) {
  if (!capped) return;
  status.capped += capped; status.cappedAt = now;
  const day = dayKey(now);
  if (capWarnedDay !== day) { capWarnedDay = day; console.warn(`[issues] 다른 알람 자동 등록 하루 상한(${cfg.dailyMax}건)에 닿아 ${capped}건을 만들지 않았습니다 — 이슈 › 설정 › 자동 등록`); }
}
function comment(key, body) {
  try { addComment(key, { body: capStr(body, 1_900) }, SYSTEM_USER, { auto: true }); status.commented += 1; }
  catch (e) {
    if (e?.extra?.code === 'auto-comments-full') { status.commentCapped += 1; return; } // 사람 댓글 몫과 따로 — 재발 수는 출처(reopen)에 계속 남는다
    status.errors += 1; status.error = `comment ${key}: ${String(e?.message || e).slice(0, 160)}`;
  }
}
/** 묶어 둔 변화 한 마디('' = 없음). */
const quietText = (o) => {
  const a = Number(o?.quietAgain) || 0; const r = Number(o?.quietResolve) || 0;
  return a || r ? ` · 앞서 묶어 둔 변화: 다시 발생 ${a}회 · 해소 ${r}회(댓글은 이슈마다 ${ALERT_ISSUE_LIMITS.noteWindowMin}분에 한 번)` : '';
};
/** 해소 → '검토'(설정이 review 이고 아직 검토 · 완료가 아닐 때). */
function toReview(key, cfg) {
  if (cfg.onResolve !== 'review') return;
  const cur = findByOrigin((_o, x) => x.key === key)[0];
  if (cur && cur.status !== 'review' && cur.status !== 'done') { setStatus(key, 'review', SYSTEM_USER, { note: '자동 등록: 알람 해소' }); status.review += 1; }
}
function make(body, origin, settings, viewers) {
  let auto = null;
  if (viewers) auto = suggestAssignee({ component: body.component, vcenterId: body.vcenterId }, settings, issueStats().byAssignee, viewers.canSee);
  try { return createIssue(body, SYSTEM_USER, { auto, origin }); } catch (e) {
    if (e?.field !== 'vcenterId') throw e;
    return createIssue({ ...body, vcenterId: '' }, SYSTEM_USER, { auto, origin }); // 형식 밖 vCenter id — 공용으로
  }
}

/** 알람 상태 한 번(알람 엔진 구독). 던지지 않는다. */
export function applyAlertState(st, { now = Date.now() } = {}) {
  const cfg = loadAlertAuto();
  if (!cfg.enabled) return { created: 0 };
  status.ranAt = now;
  let plan;
  try { plan = planAlertIssues(st, cfg, { existing: findByOrigin((o) => o.kind === 'alert'), now, createdToday: createdToday(now) }); }
  catch (e) { status.errors += 1; status.error = String(e?.message || e).slice(0, 200); return { created: 0 }; }
  noteCap(plan.capped, cfg, now);
  const settings = loadIssueSettings();
  const viewers = settings.autoAssign?.enabled ? issueViewers() : null;
  let created = 0;
  for (const a of plan.actions) {
    try {
      if (a.type === 'create') {
        const al = a.f.alert || {};
        const label = ALERT_KIND_LABEL[a.kind];
        make({
          title: capStr(`[알람] ${al.title || a.f.key}`, 200), type: 'incident', priority: cfg.priority[a.kind] || 'p2', labels: cfg.labels, component: label,
          vcenterId: String(al.vcenterId || ''), status: 'backlog',
          body: capStr([`알람 ‘${label}’ 이 ${cfg.delayMin}분 넘게 이어져 이슈로 등록했습니다.`, '', `■ ${al.title || ''}`, al.detail ? String(al.detail) : '', `발생: ${portalTime(a.f.since)} · 심각도 ${al.severity || '—'}`, '',
            '알람 화면: 알림 › 발생 중', '이 이슈는 다른 알람 자동 등록이 만들었습니다(이슈 › 설정 › 자동 등록 › 다른 알람). 알람이 해소되면 댓글이 달리고, 설정에 따라 상태가 ‘검토’ 로 바뀝니다 — 완료는 사람이 합니다.'].join('\n'), 9_000),
        }, { kind: 'alert', alertKey: a.f.key, alertKind: a.kind, title: al.title || '' }, settings, viewers);
        created += 1; status.created += 1;
      } else if (a.type === 'again') {
        let before = null;
        const o = patchOrigin(a.key, (o2) => { before = o2; return { ...o2, resolvedAt: null, reopen: (o2.reopen || 0) + 1, ...(a.note ? { noteAt: now, quietAgain: 0, quietResolve: 0 } : { quietAgain: (o2.quietAgain || 0) + 1 }) }; }).origin;
        if (a.note) comment(a.key, `다시 발생했습니다(${o.reopen}회째) — ${a.f.alert?.title || a.f.key}${quietText(before)}`);
        else status.quiet += 1;
      } else if (a.type === 'resolve') {
        let before = null;
        patchOrigin(a.key, (o2) => { before = o2; return { ...o2, resolvedAt: now, ...(a.note ? { noteAt: now, quietAgain: 0, quietResolve: 0 } : { quietResolve: (o2.quietResolve || 0) + 1 }) }; });
        if (a.note) { comment(a.key, `해소: ${a.r.alert?.title || a.r.key} — 알람이 더 이상 발생하지 않습니다.${quietText(before)}`); toReview(a.key, cfg); }
        else status.quiet += 1; // '검토' 로 옮기기도 묶는다 — 창이 지나 summary 가 그때 상태로 한다
      } else if (a.type === 'summary') {
        let before = null;
        const o = patchOrigin(a.key, (o2) => { before = o2; return { ...o2, noteAt: now, quietAgain: 0, quietResolve: 0 }; }).origin;
        comment(a.key, `알람이 오르내렸습니다 — 지금: ${o.resolvedAt ? '해소' : '발생 중'} · ${o.title || o.alertKey}${quietText(before)}`);
        if (o.resolvedAt) toReview(a.key, cfg);
      }
    } catch (e) { status.errors += 1; status.error = `${a.type}: ${String(e?.message || e).slice(0, 180)}`; console.warn(`[issues] 다른 알람 자동 등록 실패(${status.error})`); }
  }
  return { created };
}

const ST_TEXT = Object.freeze({ error: '오류', warning: '경고' });
/** 백업 실패 행(Bareos 구독). 던지지 않는다. */
export function applyBackupFailures(rows, { now = Date.now() } = {}) {
  const cfg = loadAlertAuto();
  if (!cfg.enabled || !cfg.kinds.backup) return { created: 0 };
  status.ranAt = now;
  let plan;
  try { plan = planBackupIssues(rows, cfg, { existing: findByOrigin((o) => o.kind === 'backup'), createdToday: createdToday(now) }); }
  catch (e) { status.errors += 1; status.error = String(e?.message || e).slice(0, 200); return { created: 0 }; }
  noteCap(plan.capped, cfg, now);
  const settings = loadIssueSettings();
  const viewers = settings.autoAssign?.enabled ? issueViewers() : null;
  const lineOf = (r) => `· jobid ${r.jobid} ${ST_TEXT[r.state] || r.state}${r.status ? `(${r.status})` : ''}${r.level ? ` · ${r.level}` : ''} · ${portalTime(r.at)}${r.errors != null ? ` · 오류 ${r.errors}` : ''}`;
  let created = 0;
  for (const a of plan.actions) {
    try {
      if (a.type === 'create') {
        const r0 = a.rows[0];
        make({
          title: capStr(`[백업 실패] ${r0.vmName || r0.jobName}${a.rows.length > 1 ? ` 외 ${a.rows.length - 1}회` : ''}`, 200), type: 'incident', priority: cfg.priority.backup || 'p2', labels: cfg.labels,
          component: ALERT_KIND_LABEL.backup, vcenterId: String(r0.vcenterId || ''), status: 'backlog',
          body: capStr([`Bareos 잡 ‘${r0.jobName}’ (VM ${r0.vmName || '—'}) 이 실패해 이슈로 등록했습니다.`, '', ...a.rows.map(lineOf), '',
            '백업 화면: 운영 작업 › Bareos 백업', '같은 잡이 또 실패하면 이 이슈에 댓글이 달립니다. 다음 백업이 성공해도 자동으로 닫지 않습니다 — 확인한 뒤 사람이 닫습니다.'].join('\n'), 9_000),
        }, { kind: 'backup', alertKey: a.jobKey, alertKind: 'backup', title: r0.jobName, deviceName: r0.vmName || '', partKeys: a.rows.map((r) => String(r.jobid)) }, settings, viewers);
        created += 1; status.created += 1;
      } else if (a.type === 'again') {
        patchOrigin(a.key, (o) => ({ ...o, partKeys: [...(o.partKeys || []), ...a.rows.map((r) => String(r.jobid))].slice(-64), reopen: (o.reopen || 0) + 1 }));
        comment(a.key, `같은 잡이 또 실패했습니다(${a.rows.length}회)\n${a.rows.map(lineOf).join('\n')}`);
      }
    } catch (e) { status.errors += 1; status.error = `${a.type}: ${String(e?.message || e).slice(0, 180)}`; console.warn(`[issues] 백업 실패 자동 등록 실패(${status.error})`); }
  }
  return { created };
}

const certWhen = (c) => (Number.isFinite(Number(c?.validTo)) ? portalTime(Number(c.validTo)).slice(0, 10) : '모름');
const certLeft = (c) => (Number.isInteger(c?.daysLeft) ? (c.daysLeft < 0 ? `${-c.daysLeft}일 지남` : `${c.daysLeft}일 남음`) : '남은 날 모름');
/** 인증서 확인 결과(certMonitor 구독 — v2.929). 던지지 않는다. */
export function applyCertResults(items, { now = Date.now() } = {}) {
  const cfg = loadAlertAuto();
  if (!cfg.enabled || !cfg.kinds.cert) return { created: 0 };
  status.ranAt = now;
  let plan;
  try { plan = planCertIssues(items, cfg, { existing: findByOrigin((o) => o.kind === 'alert' && o.alertKind === 'cert'), createdToday: createdToday(now) }); }
  catch (e) { status.errors += 1; status.error = String(e?.message || e).slice(0, 200); return { created: 0 }; }
  noteCap(plan.capped, cfg, now);
  const settings = loadIssueSettings();
  const viewers = settings.autoAssign?.enabled ? issueViewers() : null;
  const KIND = { vcenter: 'vCenter', nsx: 'NSX Manager' };
  let created = 0;
  for (const a of plan.actions) {
    const c = a.c;
    const what = `${KIND[c.kind] || c.kind} ${c.name || c.id}`;
    try {
      if (a.type === 'create') {
        make({
          title: capStr(`[인증서 ${c.status === 'expired' ? '만료' : '만료 임박'}] ${what} — ${certLeft(c)}`, 200), type: 'incident', priority: cfg.priority.cert || 'p1', labels: cfg.labels,
          component: '인증서', vcenterId: c.kind === 'vcenter' ? String(c.id) : String(c.vcenterId || ''), status: 'backlog',
          body: capStr([`${what}(${c.host || ''}${c.port && c.port !== 443 ? `:${c.port}` : ''}) 의 TLS 인증서가 ${c.status === 'expired' ? '만료됐습니다' : '30일 안에 만료됩니다'}.`, '',
            `만료일: ${certWhen(c)} · ${certLeft(c)}`, c.cn ? `CN: ${c.cn}` : '', c.issuer ? `발급자: ${c.issuer}${c.selfSigned ? '(자체 서명)' : ''}` : '', '',
            '인증서 화면: 보안·계정 › 인증서 만료 감시(#/tools/cert-expiry — 12시간마다 확인)', '이 이슈는 다른 알람 자동 등록이 만들었습니다(이슈 › 설정 › 자동 등록 › 다른 알람). 갱신돼 남은 날이 30일을 넘으면 댓글이 달리고, 설정에 따라 상태가 ‘검토’ 로 바뀝니다 — 완료는 사람이 합니다.'].filter((l) => l !== null).join('\n'), 9_000),
        }, { kind: 'alert', alertKey: a.certKey, alertKind: 'cert', title: what, partKeys: [c.status] }, settings, viewers);
        created += 1; status.created += 1;
      } else if (a.type === 'worse') {
        patchOrigin(a.key, (o) => ({ ...o, partKeys: [...(o.partKeys || []), c.status] }));
        comment(a.key, `인증서가 만료됐습니다 — ${what} · 만료일 ${certWhen(c)}(${certLeft(c)})`);
      } else if (a.type === 'again') {
        const o = patchOrigin(a.key, (o2) => ({ ...o2, resolvedAt: null, reopen: (o2.reopen || 0) + 1, partKeys: [c.status] })).origin;
        comment(a.key, `다시 만료 임박/만료로 확인됐습니다(${o.reopen}회째) — ${what} · 만료일 ${certWhen(c)}(${certLeft(c)})`);
      } else if (a.type === 'resolve') {
        patchOrigin(a.key, (o) => ({ ...o, resolvedAt: now }));
        comment(a.key, `해소: 인증서가 갱신됐습니다 — ${what} · 새 만료일 ${certWhen(c)}(${certLeft(c)})`);
        if (cfg.onResolve === 'review') {
          const cur = findByOrigin((_o, x) => x.key === a.key)[0];
          if (cur && cur.status !== 'review' && cur.status !== 'done') { setStatus(a.key, 'review', SYSTEM_USER, { note: '자동 등록: 인증서 갱신 확인' }); status.review += 1; }
        }
      }
    } catch (e) { status.errors += 1; status.error = `cert ${a.type}: ${String(e?.message || e).slice(0, 180)}`; console.warn(`[issues] 인증서 자동 등록 실패(${status.error})`); }
  }
  return { created };
}

/* ───── v2.929(리눅스 성능 5단계) — 베어메탈 성능 알림 규칙 → 이슈(같은 문지기) ─────
 * 규칙 열 ‘이슈 자동 등록’ 이 켜진 발송 건(bmusage/perfAlerts.js · 중앙 직접 수집분, 또는 엣지 봉투의 pending-central 을 중앙이 받아서)을 이슈로 만든다.
 * 틀은 위와 같다: 출처(origin kind 'bmperf' · alertKey = agent|서버|규칙) · 같은 키의 열린 이슈가 있으면 댓글 · 하루 상한(규칙 설정 daily.issues — 이슈 문지기와 별도 축이라
 *   다른 알람 상한과 따로 센다) · 법인 = 서버의 vCenter(없으면 공용 — 지어내지 않는다). 같은 발송 건(id)을 두 번 쓰지 않는다(엣지 봉투를 다시 당겨도).
 * 판정(조건) · 발송은 그 서버를 수집하는 노드가 이미 했다 — 여기서 다시 판정하지 않는다.
 */
export const BMPERF_RULE_LABEL = Object.freeze({ use: 'USE 판정 변화', cross: '교차 판정', focusEnd: '집중 모니터링 결론', baseline: '베이스라인 이탈', health: '점검 소모품', profile: '용도 점검 실패' });
/**
 * 발송 건 → 할 일(순수).
 *  · 중복 원천은 **받은 발송 건**이다(F2 · F3 · F12 반증): ① id 가 어느 이슈(닫힌 것 포함)의 partKeys 에 있으면 dup ② 그 열쇠(agent|서버|규칙)의 이슈들(닫힌 것 포함)이
 *    이미 받은 가장 늦은 발송 시각(origin.lastAt)보다 이른 건은 dup — 엣지 봉투는 24시간 기록을 매번 다시 싣고, partKeys 는 64개 상한이라 밀려난 id 가 ‘새 건’ 이 되던 것을 막는다.
 *  · 같은 묶음 안의 같은 열쇠는 하나로 — 첫 건이 만들면 나머지는 그 이슈에 댓글(만든 이슈를 byKey 에 바로 넣는다).
 *  · 닫힌 이슈 뒤의 **새** 발생(lastAt 이후)은 새 이슈다 — 다른 알람 · 파트 장애 자동 등록과 같은 규약(‘열린 이슈가 있으면 댓글’ · 닫기는 사람의 판단이라 다시 열지 않는다).
 *  · 하루 상한은 **법인별**(createdTodayByVc — F7: 예전에는 전 법인 합계 20 이라 한 법인이 다른 법인 이슈를 막았다).
 * @param {Array} existing  findByOrigin(bmperf, { openOnly:false }) — 닫힌 이슈 포함
 */
export function planBmPerfIssues(fires, { existing = [], createdTodayByVc = new Map(), dailyMax = 20 } = {}) {
  const actions = []; let capped = 0;
  const byKey = new Map(); const seenIds = new Set(); const lastAt = new Map(); const lastIds = new Map();
  for (const x of existing) {
    const k = x.origin?.alertKey;
    for (const id of x.origin?.partKeys || []) seenIds.add(String(id));
    if (k) {
      const la = Number(x.origin?.lastAt);
      if (Number.isFinite(la) && la > (lastAt.get(k) ?? -Infinity)) { lastAt.set(k, la); lastIds.set(k, new Set((x.origin?.lastIds || []).map(String))); }
      else if (Number.isFinite(la) && la === lastAt.get(k)) for (const id of x.origin?.lastIds || []) lastIds.get(k).add(String(id));
      if (x.status !== 'done') byKey.set(k, x);
    }
  }
  const room = new Map();
  const roomOf = (vc) => { if (!room.has(vc)) room.set(vc, Math.max(0, dailyMax - (Number(createdTodayByVc.get(vc)) || 0))); return room.get(vc); };
  const ordered = [...(fires || [])].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  for (const f of ordered) {
    if (!f?.id || seenIds.has(String(f.id))) { actions.push({ type: 'dup', f }); continue; }
    const k = `bmperf:${f.agent || ''}|${f.key}|${f.rule}`;
    const at = Number(f.at);
    // 같은 시각(ms)의 건은 그 시각에 받은 id 목록(lastIds)으로 가른다 — 더 이른 건은 이미 받은 것.
    if (Number.isFinite(at) && lastAt.has(k) && (at < lastAt.get(k) || (at === lastAt.get(k) && lastIds.get(k)?.has(String(f.id))))) { actions.push({ type: 'dup', f }); continue; }
    seenIds.add(String(f.id));
    if (Number.isFinite(at) && at > (lastAt.get(k) ?? -Infinity)) { lastAt.set(k, at); lastIds.set(k, new Set([String(f.id)])); }
    else if (Number.isFinite(at) && at === lastAt.get(k)) lastIds.get(k)?.add(String(f.id));
    const ex = byKey.get(k);
    if (ex) { actions.push({ type: 'again', key: ex.key, alertKey: k, f }); continue; }
    const vc = String(f.vcenterId || '');
    if (roomOf(vc) <= 0) { capped += 1; actions.push({ type: 'capped', f }); continue; }
    room.set(vc, roomOf(vc) - 1);
    actions.push({ type: 'create', alertKey: k, f });
    byKey.set(k, { key: null, pendingOf: k, status: 'backlog' });   // 같은 묶음 다음 건은 이 이슈에 댓글(만든 뒤 열쇠를 채운다)
  }
  return { actions, capped };
}
let bmCapWarnedDay = '';
function noteBmPerfCap(capped, dailyMax, now) {
  if (!capped) return;
  status.capped += capped; status.cappedAt = now;
  const day = dayKey(now);
  if (bmCapWarnedDay !== day) { bmCapWarnedDay = day; console.warn(`[issues] 베어메탈 성능 이슈 하루 상한(법인당 ${dailyMax}건)에 닿아 ${capped}건을 만들지 않았습니다 — 베어메탈 사용률 › 설정 › 리눅스 성능 알림 규칙`); }
}
/** 발송 건 → 이슈. 반환 byId: 발송 id → 'created' | 'commented' | 'daily-cap' | 'dup' | 'error'. 던지지 않는다. */
export function applyBmPerfFires(fires, { now = Date.now(), dailyMax = 20 } = {}) {
  const byId = {};
  let plan;
  try {
    const existing = findByOrigin((o) => o.kind === 'bmperf', { openOnly: false });
    const since = todayStartMs(now);
    const vcs = new Set((fires || []).map((f) => String(f?.vcenterId || '')));
    const createdTodayByVc = new Map([...vcs].map((vc) => [vc, originCreatedSince('bmperf', since, (x) => String(x.vcenterId || '') === vc)]));
    plan = planBmPerfIssues(fires, { existing, createdTodayByVc, dailyMax });
  } catch (e) { status.errors += 1; status.error = String(e?.message || e).slice(0, 200); return { byId, error: status.error }; }
  if (plan.capped) noteBmPerfCap(plan.capped, dailyMax, now);
  const settings = loadIssueSettings();
  const viewers = settings.autoAssign?.enabled ? issueViewers() : null;
  const madeKey = new Map();   // alertKey → 이번 묶음에서 만든 이슈 키
  const bumpLast = (o, f) => {
    const at = Number(f.at); const la = Number(o.lastAt) || 0;
    if (!Number.isFinite(at)) return {};
    if (at > la) return { lastAt: at, lastIds: [String(f.id)] };
    if (at === la) return { lastIds: [...(o.lastIds || []), String(f.id)].slice(-64) };
    return {};
  };
  for (const a of plan.actions) {
    const f = a.f;
    try {
      if (a.type === 'dup') { byId[f.id] = 'dup'; continue; }
      if (a.type === 'capped') { byId[f.id] = 'daily-cap'; continue; }
      if (a.type === 'again') {
        const key = a.key || madeKey.get(a.alertKey);
        if (!key) { byId[f.id] = 'error'; continue; }
        patchOrigin(key, (o) => ({ ...o, partKeys: [...(o.partKeys || []), String(f.id)].slice(-64), reopen: (o.reopen || 0) + 1, ...bumpLast(o, f) }));
        comment(key, `다시 발생했습니다 — ${f.title || f.rule} (${portalTime(f.at)})`);
        byId[f.id] = 'commented';
        continue;
      }
      const label = BMPERF_RULE_LABEL[f.rule] || f.rule;
      const made = make({
        title: capStr(`[베어메탈 성능] ${f.title || `${f.name} ${label}`}`, 200), type: 'incident', priority: f.rule === 'use' || f.rule === 'profile' ? 'p1' : 'p2', labels: ['bm-perf', 'auto'], component: label,
        vcenterId: String(f.vcenterId || ''), status: 'backlog',
        body: capStr([`베어메탈 성능 알림 규칙 ‘${label}’ 이 이 서버에서 성립해 이슈로 등록했습니다.`, '', `■ ${f.title || ''}`, `서버: ${f.name || f.key}${f.agent ? ` · 수집 노드 ${f.agent}` : ''} · 발생 ${portalTime(f.at)}`, '',
          '화면: 특수 기능 › 베어메탈 사용률 › 서버 상세(판정 근거 · 집중 모니터링).', '판정 · 발송은 그 서버를 수집하는 노드가 했습니다. 같은 규칙이 다시 성립하면 이 이슈에 댓글이 달립니다 — 닫기는 사람이 합니다.'].join('\n'), 9_000),
      }, { kind: 'bmperf', alertKey: a.alertKey, alertKind: f.rule, title: f.title || '', deviceName: f.name || '', partKeys: [String(f.id)], lastAt: Number(f.at) || null, lastIds: [String(f.id)] }, settings, viewers);
      if (made?.key) madeKey.set(a.alertKey, made.key);
      status.created += 1;
      byId[f.id] = 'created';
    } catch (e) { status.errors += 1; status.error = `bmperf ${a.type}: ${String(e?.message || e).slice(0, 160)}`; byId[f.id] = 'error'; }
  }
  return { byId };
}

let started = false;
/** index.js 가 기동 때 한 번 — 알람 엔진 · Bareos 실패 메일 틱 · 인증서 감시(v2.929)를 구독한다(그 모듈들은 이슈를 모른다). */
export async function startAlertIssues() {
  if (started) return;
  started = true;
  const [{ onAlertState }, { onBareosFailures }, { onCertResults }] = await Promise.all([import('../alerts.js'), import('../bareos/notify.js'), import('../security/certMonitor.js')]);
  onAlertState((st) => applyAlertState(st));
  onBareosFailures((rows, now) => applyBackupFailures(rows, { now }));
  onCertResults((items) => applyCertResults(items));
}
/** 테스트 전용. */
export function _resetAlertIssuesForTest() { cache = null; loadErr.clear(); Object.assign(status, freshStatus()); capWarnedDay = ''; bmCapWarnedDay = ''; }
