/**
 * bmusage/perfAlerts.js — 리눅스 성능 **알림 규칙**(v2.929 예정 · 5단계 · 설계 PROFILES §14 ① · 아트보드 Alerts).
 *
 * 판정 · 발송은 **수집 노드**(엣지 또는 중앙 직접 수집분)가 한다 — 판정 입력은 그 노드가 이미 만든 값(USE 판정 · 교차 판정 · 소모품 칸 · 베이스라인 이탈 · 용도 점검 · 집중 결론)이고
 *   여기서 다시 판정하지 않는다(조건 = 그 code 의 ‘변화’). 중앙은 엣지 봉투의 발송 기록(sent)을 받아 ‘알림 이력’ 으로 보이고, 이슈는 중앙이 만든다(이슈 저장소가 중앙에 있다).
 *
 * 폭주를 막는 장치(v2.551 bmusage 알림과 같은 네 개 + 상한):
 *   ① 지속(sustain 주기) ② **한 사건에 한 번**(조건이 거짓이 될 때까지 다시 보내지 않는다 — ‘같은 상태가 계속이면 다시 보내지 않음’) ③ 재발 억제(repeatMin — 새 사건이어도 그 안이면 보내지 않는다)
 *   ④ 상태 파일(`bm-perf-alert-state.json` — 원자 쓰기 · 재시작 뒤 재발송 없음 · 손상이면 보존하고 **첫 주기는 기준만 잡는다**(warmup — 진행 중인 사건을 한꺼번에 다시 보내지 않게))
 *   ⑤ 법인당 하루 상한(알림 50 · 이슈 20 · 자동 집중 10 — 설정) — 넘으면 보내지 않고 센다(조용히 버리지 않는다).
 * ⚠⚠ `null`(못 읽음 · 오래됨 · 판정 불가)은 참도 거짓도 아니다 — 판정 보류(상태 유지). 0 을 정상으로 세지 않는다.
 * ⚠ 유지보수 창 억제(Bareos · Veeam 스케줄): 지금 저장소에는 **베어메탈 서버의 백업 창을 읽는 원천이 없다**(Bareos 그룹 스케줄 · Veeam 스케줄은 VM 대상) —
 *   억제 훅(maintenanceFor)은 자리만 두고 항상 ‘원천 없음’ 이다(정직 기록 · 8단계 정비 창에서 채운다). 화면은 그 사실을 말한다.
 * 채널은 기존 알림 설정(alerts.json — 메일 · 웹훅 · Slack · Teams)을 그대로 쓰고 규칙이 고른 채널만 켠 사본으로 보낸다(새 채널 없음 · 웹훅 URL 은 화면 · 상태 파일에 없다).
 * 알림 본문에 `**` 를 쓰지 않는다(Slack · 메일에는 BoldText 가 없다). 문구는 ‘무엇이 · 얼마나 · 무엇 대비 · 언제부터’ 이고 원인을 단정하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { dayKey } from '../util/dayKey.js';
import { RULE_IDS, BASELINE_METRICS } from './perfRules.js';
import { VERDICT_LABEL } from './useJudge.js';

const n = numOrNull;
const FILE = () => path.join(config.configDir, 'bm-perf-alert-state.json');
export const SENT_LOG_MAX = 200;
/** 이번 주기에 없던 서버의 상태를 들고 가는 시간(수집 한 번 실패로 사건이 끊기지 않게 — 그보다 오래면 버린다: 인메모리 맵 규약). */
export const CARRY_MS = 24 * 3_600_000;
const BAD_VERDICT = new Set(['saturated', 'errors', 'bottleneck']);
const METRIC_LABEL = Object.freeze({ cpu_pct: 'CPU', mem_pct: '메모리', disk_busy_pct: '디스크 busy', disk_await_ms: '디스크 await', net_pct: '네트워크' });
const HEALTH_LABEL = Object.freeze({ chrony: '시각 동기', units: '실패 유닛', oom: 'OOM', dmesg: '커널 오류', uptime: '재부팅 필요', fdct: 'FD · conntrack', cert: '인증서', tuned: 'TuneD · SELinux · firewalld' });

/**
 * 규칙 조건(순수) — true(조건 성립) · false(성립 안 함) · null(판정 보류 — 못 읽음 · 오래됨 · 띠 없음).
 * @param {string} id  규칙 id
 * @param {{entry?:object, health?:object, dev?:object, profile?:object}} ctx  그 서버의 이번 주기 값(이 노드가 만든 것)
 */
export function ruleCondition(id, ctx = {}, rule = {}) {
  if (id === 'use') {
    const v = ctx.entry?.verdict;
    if (!v || ['stale', 'partial', 'unknown'].includes(v)) return null;
    if (rule.cond === 'bottleneck') return v === 'bottleneck';
    if (rule.cond === 'errors') return v === 'errors';
    return BAD_VERDICT.has(v);
  }
  if (id === 'cross') {
    const xs = Array.isArray(ctx.entry?.cross) ? ctx.entry.cross : null;
    if (!xs || !xs.length) return null;
    if (xs.some((x) => x?.state === 'candidate')) return true;
    return xs.every((x) => x?.state === 'missing' || x?.state === 'nopath') ? null : false;
  }
  if (id === 'baseline') {
    const d = ctx.dev && typeof ctx.dev === 'object' ? Object.values(ctx.dev) : [];
    const judged = d.filter((x) => x && !x.reason && x.out);
    if (!judged.length) return null;
    return judged.some((x) => x.out === 'above' || x.out === 'below');
  }
  if (id === 'health') {
    const cells = ctx.health?.cells ? Object.values(ctx.health.cells) : null;
    if (!cells) return null;
    const judged = cells.filter((c) => ['ok', 'warn', 'bad'].includes(c?.code));
    if (!judged.length) return null;
    return rule.cond === 'bad' ? judged.some((c) => c.code === 'bad') : judged.some((c) => c.code === 'warn' || c.code === 'bad');
  }
  if (id === 'profile') {
    const st = ctx.profile?.status;
    if (!st || st === 'none' || st === 'unknown') return null;
    return st === 'bad';
  }
  return null;
}

/**
 * 한 규칙 · 한 서버의 상태 전이(순수).
 * @param {object|null} prev  { streak, active, firedAt, since, seenAt }
 * @returns {{ state:object, fire:boolean, reason:string }}
 */
export function stepRule(prev, cond, rule = {}, now = Date.now()) {
  const p = prev || { streak: 0, active: false, firedAt: null, since: null };
  if (cond === null || cond === undefined) return { state: { ...p, seenAt: now }, fire: false, reason: 'unknown' };
  if (cond === false) return { state: { streak: 0, active: false, firedAt: p.firedAt ?? null, since: null, seenAt: now }, fire: false, reason: 'clear' };
  const streak = (n(p.streak) ?? 0) + 1;
  const since = p.since ?? now;
  const sustain = Math.max(1, n(rule.sustain) ?? 1);
  if (p.active) return { state: { ...p, streak, since, seenAt: now }, fire: false, reason: 'ongoing' };
  if (streak < sustain) return { state: { ...p, streak, since, active: false, seenAt: now }, fire: false, reason: 'sustaining' };
  const rep = Math.max(0, n(rule.repeatMin) ?? 0) * 60_000;
  if (p.firedAt != null && rep > 0 && now - p.firedAt < rep) return { state: { ...p, streak, since, active: true, seenAt: now }, fire: false, reason: 'suppressed' };
  return { state: { streak, since, active: true, firedAt: now, seenAt: now }, fire: true, reason: 'fire' };
}

/**
 * 한 주기 판정(순수).
 * @param {Array<{key,name,vcenterId,entry,health,dev,profile}>} items
 * @param {object} rules   perfRules.rules(켠 것만)
 * @param {object} state   { '<rule>|<key>': {...} }
 */
export function evaluatePerfRules(items = [], rules = {}, state = {}, now = Date.now()) {
  const next = {}; const fires = [];
  const counts = { fire: 0, suppressed: 0, sustaining: 0, unknown: 0, ongoing: 0, corpOff: 0 };
  const on = RULE_IDS.filter((id) => id !== 'focusEnd' && rules?.[id]?.on);
  const seen = new Set();
  for (const it of items) {
    const key = String(it?.key || ''); if (!key) continue;
    for (const id of on) {
      const rule = rules[id];
      const sk = `${id}|${key}`; seen.add(sk);
      if ((rule.corpsOff || []).includes(String(it.vcenterId || ''))) { counts.corpOff += 1; continue; }
      const cond = ruleCondition(id, it, rule);
      const out = stepRule(state?.[sk] || null, cond, rule, now);
      next[sk] = out.state;
      if (counts[out.reason] != null) counts[out.reason] += 1;
      if (out.fire) { counts.fire += 1; fires.push({ rule: id, key, name: it.name || key, vcenterId: String(it.vcenterId || ''), ctx: it }); }
    }
  }
  // 이번 주기에 없던 서버(수집 실패 · 대상 제외)의 상태는 CARRY_MS 동안 들고 간다 — 켠 규칙만(끈 규칙의 상태는 버린다: 다시 켜면 처음부터).
  for (const [sk, st] of Object.entries(state || {})) {
    if (seen.has(sk) || next[sk]) continue;
    const id = sk.split('|')[0];
    if (!on.includes(id)) continue;
    if (n(st?.seenAt) != null && now - st.seenAt < CARRY_MS) next[sk] = st;
  }
  return { next, fires, counts };
}

/** 알림 본문(순수 — `**` 없음 · 원인 단정 없음). */
export function perfAlertOf(f, { corpName = '' } = {}) {
  const head = `${corpName || f.vcenterId ? `[${corpName || f.vcenterId}] ` : ''}${f.name}`;
  const key = `bmperf:${f.rule}:${f.key}`;
  const c = f.ctx || {};
  if (f.rule === 'use') {
    const v = c.entry?.verdict;
    return { key, severity: v === 'bottleneck' || v === 'errors' ? 'critical' : 'warning', title: capStr(`${head} 성능 판정 ‘${VERDICT_LABEL[v] || v}’`, 200),
      detail: capStr(`${c.entry?.line || ''}\n${f.sustain || 1}주기 지속 · 베어메탈 사용률 › 서버 상세에서 근거(USE 칸)를 확인하세요.`, 1_500) };
  }
  if (f.rule === 'cross') {
    const xs = (c.entry?.cross || []).filter((x) => x?.state === 'candidate').map((x) => `${x.id}(${x.code || '후보'})`);
    return { key, severity: 'warning', title: capStr(`${head} 교차 판정 후보 ${xs.join(' · ')}`, 200), detail: '두 경로(OS · iDRAC) 값이 맞물린 ‘후보’ 입니다 — 원인 확정은 담당자가 합니다.' };
  }
  if (f.rule === 'baseline') {
    const outs = Object.entries(c.dev || {}).filter(([, d]) => d && !d.reason && (d.out === 'above' || d.out === 'below'))
      .map(([m, d]) => `${METRIC_LABEL[m] || m} ${d.ratio != null ? `${d.ratio}×` : ''} — 지금 ${d.value}, 지난 ${f.weeks || 4}주 같은 요일 · 시각 평균 ${d.mean}(띠 ${d.lo}~${d.hi} 밖)`);
    return { key, severity: 'warning', title: capStr(`${head} 베이스라인 이탈`, 200), detail: capStr(`${outs.join('\n')}\n${f.sustain || 1}주기 지속 · 휴일 · 월말 같은 달력 효과는 모릅니다.`, 1_500) };
  }
  if (f.rule === 'health') {
    const cells = Object.entries(c.health?.cells || {}).filter(([, x]) => x?.code === 'warn' || x?.code === 'bad').map(([k, x]) => `${HEALTH_LABEL[k] || k}(${x.code === 'bad' ? '이상' : '주의'})`);
    return { key, severity: cells.some((x) => x.includes('이상')) ? 'critical' : 'warning', title: capStr(`${head} 점검 소모품 ${cells.length}칸 기준 밖`, 200), detail: capStr(cells.join(' · '), 1_500) };
  }
  if (f.rule === 'profile') {
    const bad = (c.profile?.profiles || []).filter((p) => p?.status === 'bad').map((p) => p.id);
    return { key, severity: 'critical', title: capStr(`${head} 용도 프로파일 점검 실패 ${bad.join(' · ')}`, 200), detail: '용도 탭에서 실패한 점검(근거 · 출처)을 확인하세요.' };
  }
  if (f.rule === 'focusEnd') {
    const s = c.summary || {};
    return { key: `${key}:${c.id || ''}`, severity: s.verdictTo && s.verdictTo !== 'ok' ? 'warning' : 'info',
      title: capStr(`${head} 집중 모니터링 결론 ${VERDICT_LABEL[s.verdictFrom] || s.verdictFrom || '—'} → ${VERDICT_LABEL[s.verdictTo] || s.verdictTo || '—'}`, 200),
      detail: capStr(`결측 OS ${s.missOs ?? '—'} · iDRAC ${s.missIdrac ?? '—'}${s.candidates?.[0] ? ` · 원인 후보(상관) ${s.candidates[0].name}` : ''} — 서버 상세 › 집중 모니터링 탭에서 세션을 보세요.`, 1_500) };
  }
  return { key, severity: 'warning', title: capStr(head, 200), detail: '' };
}

/**
 * 유지보수 창 억제 훅 — ⚠ 원천 없음(위 머리말). 항상 { suppressed:false, source:'none' }. 원천이 생기면 여기서만 채운다(호출부는 이미 결과를 본다).
 */
export function maintenanceFor(_target, _now = Date.now(), _cfg = {}) { return { suppressed: false, source: 'none' }; }

/* ── 상태 파일 ─────────────────────────────────────────────────────────── */
let _state = null; let _warmup = false; let _loadError = null;
function fresh() { return { v: 1, rules: {}, day: '', counts: {}, sent: [] }; }
function load() {
  if (_state) return _state;
  try {
    if (!fs.existsSync(FILE())) { _state = fresh(); return _state; }
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    _state = { v: 1, rules: raw.rules && typeof raw.rules === 'object' ? raw.rules : {}, day: String(raw.day || ''), counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
      sent: Array.isArray(raw.sent) ? raw.sent.slice(-SENT_LOG_MAX) : [] };
  } catch (e) {
    // 손상 — 보존하고 첫 주기는 기준만 잡는다(진행 중인 사건을 ‘새 사건’ 으로 한꺼번에 다시 보내지 않게).
    preserveCorrupt(FILE(), String(e?.message || e));
    _loadError = { at: Date.now(), reason: '상태 파일 손상 — 보존본을 남기고 다음 주기부터 새로 셉니다' };
    _warmup = true;
    _state = fresh();
    console.warn('[bmusage] bm-perf-alert-state.json 을 읽지 못해 보존하고 기준을 다시 잡습니다(이번 주기는 알림을 보내지 않습니다)');
  }
  return _state;
}
function save(st) {
  _state = st;
  try { atomicWriteFileSync(FILE(), `${JSON.stringify({ ...st, at: Date.now() })}\n`, { mode: 0o600 }); } catch (e) { _loadError = { at: Date.now(), reason: `상태 파일 쓰기 실패: ${String(e?.message || e).slice(0, 120)}` }; }
}
export function _resetPerfAlertsForTest({ unlink = true } = {}) { _state = null; _warmup = false; _loadError = null; if (unlink) { try { fs.unlinkSync(FILE()); } catch { /* */ } } }
/** 화면 · 봉투용 — 추적 수 · 오늘 상한 사용 · 발송 기록(최근 SENT_LOG_MAX — 채널 URL 없음). */
export function perfAlertStatus() {
  const st = load();
  const tracked = Object.values(st.rules || {}).filter((x) => x?.active).length;
  return { tracked, day: st.day, counts: st.counts || {}, sent: (st.sent || []).slice(-SENT_LOG_MAX), ...(_loadError ? { loadError: _loadError } : {}) };
}

/** 오늘(포탈 날짜) 법인 상한 사용량 — 날이 바뀌면 0 부터. */
function bump(st, vc, kind, today) {
  if (st.day !== today) { st.day = today; st.counts = {}; }
  const c = st.counts[vc] || { alerts: 0, issues: 0, autoFocus: 0 };
  c[kind] = (c[kind] || 0) + 1; st.counts[vc] = c;
  return c[kind];
}
function used(st, vc, kind, today) { return st.day === today ? (st.counts?.[vc]?.[kind] || 0) : 0; }
const channelCfg = (cfg, wanted) => ({ ...cfg, channels: Object.fromEntries(Object.entries(cfg?.channels || {}).map(([k, v]) => [k, { ...v, enabled: !!v?.enabled && wanted.includes(k) }])) });

/**
 * 발송 한 묶음(I/O) — 상한 · 억제 · 채널 · 이슈 · 자동 집중. 순차 발송(alerts 의 POST 를 수백 개 동시에 열지 않는다).
 * @param {Array} fires   evaluatePerfRules().fires 또는 집중 결론 한 건
 */
async function dispatch(fires, { rules, st, now, D, targetsByKey = new Map() }) {
  const today = dayKey(now) || '';
  const out = { sent: 0, capped: 0, maintenance: 0, failed: 0, issues: 0, autoFocus: 0 };
  const isEdge = !!config.agent?.centralUrl;
  const alertCfg = await D.alertConfig().catch(() => null);
  const issueFires = [];
  for (const f of fires) {
    const rule = rules.rules?.[f.rule] || {};
    const tg = targetsByKey.get(f.key) || f.ctx?.target || null;
    const rec = { id: crypto.randomUUID().slice(0, 12), at: now, rule: f.rule, key: f.key, name: capStr(f.name, 120), vcenterId: f.vcenterId, title: '', channels: rule.channels || [], result: '', issue: null, autoFocus: null };
    const mw = maintenanceFor(tg, now, rules.maintenance);
    const al = perfAlertOf({ ...f, sustain: rule.sustain, weeks: rules.baseline?.weeks }, {});
    rec.title = al.title;
    if (mw.suppressed && rules.maintenance?.backupWindows) { rec.result = 'maintenance'; out.maintenance += 1; }
    else if (used(st, f.vcenterId, 'alerts', today) >= (rules.daily?.alerts ?? 50)) { rec.result = 'daily-cap'; out.capped += 1; }
    else if (!alertCfg) { rec.result = 'no-channel-config'; out.failed += 1; }
    else {
      bump(st, f.vcenterId, 'alerts', today);
      try {
        const r = await D.notify(al, channelCfg(alertCfg, rule.channels || []));
        const line = Array.isArray(r) ? r.join(' · ') : String(r);
        rec.result = /suppressed/.test(line) ? 'suppressed' : (Array.isArray(r) && r.length ? 'sent' : 'no-channel');
        if (rec.result === 'sent') out.sent += 1;
      } catch (e) { rec.result = 'error'; rec.error = String(e?.message || e).slice(0, 120); out.failed += 1; }
    }
    // 이슈 — 이슈 저장소가 있는 중앙이 만든다. 엣지는 ‘원함’ 표시만(중앙이 봉투를 받을 때 자기 문지기로 판단 — bmPerfOpsPull.ingestEdgeAlertIssues).
    if (rule.issue) {
      if (isEdge) rec.issue = 'pending-central';
      else if (used(st, f.vcenterId, 'issues', today) >= (rules.daily?.issues ?? 20)) rec.issue = 'daily-cap';
      else { issueFires.push({ ...rec, agent: config.agent?.name || '' }); }
    }
    // 자동 집중 — 법인 옵트인(focus.autoCorps) · 같은 서버 재발 억제 · 하루 상한. 이 노드의 대상만(엣지 위임 서버는 그 엣지가).
    if (rule.autoFocus && f.rule !== 'focusEnd') {
      const opted = (rules.focus?.autoCorps || []).includes(f.vcenterId);
      const lastAuto = n(st.autoAt?.[f.key]);
      const supMs = Math.max(5, n(rules.focus?.autoSuppressMin) ?? 30) * 60_000;
      if (!opted) rec.autoFocus = 'not-opted';
      else if (!tg) rec.autoFocus = 'no-target';
      else if (lastAuto != null && now - lastAuto < supMs) rec.autoFocus = 'suppressed';
      else if (used(st, f.vcenterId, 'autoFocus', today) >= (rules.daily?.autoFocus ?? 10)) rec.autoFocus = 'daily-cap';
      else {
        const r = await D.startFocus({ target: tg, trigger: 'auto', rule: f.rule, reason: `자동 규칙 ‘${f.rule}’ — ${al.title}`.slice(0, 300), by: 'rule' }).catch((e) => ({ ok: false, code: 'error', reason: String(e?.message || e) }));
        rec.autoFocus = r?.ok ? (r.status === 'queued' ? 'queued' : 'started') : `skipped:${r?.code || 'error'}`;
        if (r?.ok) { bump(st, f.vcenterId, 'autoFocus', today); st.autoAt = { ...(st.autoAt || {}), [f.key]: now }; out.autoFocus += 1; }
      }
    }
    st.sent = [...(st.sent || []), rec].slice(-SENT_LOG_MAX);
  }
  if (issueFires.length) {
    const r = await D.applyIssues(issueFires, { now, dailyMax: rules.daily?.issues ?? 20 }).catch((e) => ({ error: String(e?.message || e) }));
    for (const rec of st.sent.slice(-fires.length)) {
      const res = r?.byId?.[rec.id];
      if (res) { rec.issue = res; if (res === 'created') bump(st, rec.vcenterId, 'issues', today); }
      else if (issueFires.some((x) => x.id === rec.id)) rec.issue = r?.error ? 'error' : 'skipped';
    }
    out.issues = Object.values(r?.byId || {}).filter((x) => x === 'created').length;
  }
  return out;
}

function depsOf(deps = {}) {
  return {
    alertConfig: async () => (await import('../alerts.js')).loadAlertConfig(),
    notify: async (al, cfg) => (await import('../alerts.js')).notify(al, cfg),
    applyIssues: async (fires, o) => (await import('../issues/alertIssues.js')).applyBmPerfFires(fires, o),
    startFocus: async (o) => (await import('./focus/run.js')).startFocusLocal(o),
    isMock: async () => (await import('../mock/demo/flags.js')).isMockMode(),
    ...deps,
  };
}

/**
 * 한 주기(폴러가 적재 · 소모품 판정 뒤 부른다). 켠 규칙이 없으면 판정도 하지 않는다(상태를 건드리지 않는다 — 다시 켤 때 예전 사건이 한꺼번에 나가지 않게).
 * @param {Array} items  [{ key, name, vcenterId, entry, health, dev, profile, target }]
 */
export async function runPerfAlerts(items = [], { rules, now = Date.now(), deps = {}, dryRun = false } = {}) {
  const D = depsOf(deps);
  const on = RULE_IDS.filter((id) => id !== 'focusEnd' && rules?.rules?.[id]?.on);
  if (!on.length) return { ok: true, skipped: 'no-rules' };
  if (!dryRun && await D.isMock().catch(() => false)) return { ok: true, skipped: 'demo' };
  const st = load();
  const { next, fires, counts } = evaluatePerfRules(items, rules.rules, st.rules, now);
  if (dryRun) return { ok: true, dryRun: true, counts, fires: fires.map((f) => ({ rule: f.rule, key: f.key, name: f.name, vcenterId: f.vcenterId, title: perfAlertOf(f).title })) };
  // 상태가 바뀐 적 없는 첫 주기(손상 뒤 warmup)는 기준만 잡는다.
  if (_warmup) { _warmup = false; save({ ...st, rules: next }); return { ok: true, warmup: true, counts }; }
  const st2 = { ...st, rules: next };
  const targetsByKey = new Map(items.filter((x) => x?.target).map((x) => [x.key, x.target]));
  const out = fires.length ? await dispatch(fires, { rules, st: st2, now, D, targetsByKey }) : {};
  save(st2);
  return { ok: true, counts, fires: fires.length, ...out };
}

/** 집중 결론 규칙 — 세션이 끝날 때 한 번(focus/run.js onFocusEnd 구독). */
export async function runFocusEndAlert(ev, { rules, now = Date.now(), deps = {} } = {}) {
  const rule = rules?.rules?.focusEnd;
  if (!rule?.on) return { ok: true, skipped: 'off' };
  if ((rule.corpsOff || []).includes(String(ev.vcenterId || ''))) return { ok: true, skipped: 'corp-off' };
  const D = depsOf(deps);
  if (await D.isMock().catch(() => false)) return { ok: true, skipped: 'demo' };
  const s = ev.summary || {};
  if (!['done', 'stopped', 'auth'].includes(ev.status)) return { ok: true, skipped: 'status' };
  if (rule.cond !== 'any' && (!s.verdictTo || s.verdictTo === 'ok')) return { ok: true, skipped: 'returned-ok' };
  const st = load();
  const out = await dispatch([{ rule: 'focusEnd', key: ev.key, name: ev.name, vcenterId: String(ev.vcenterId || ''), ctx: { summary: s, id: ev.id, target: ev.target } }], { rules, st, now, D });
  save(st);
  return { ok: true, ...out };
}

/** 베이스라인 지표 — 웹 · 테스트 공용(같은 목록). */
export { BASELINE_METRICS };
