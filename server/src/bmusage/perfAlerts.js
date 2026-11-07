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
import { MAX_SEND } from './notify.js';

const n = numOrNull;
const FILE = () => path.join(config.configDir, 'bm-perf-alert-state.json');
export const SENT_LOG_MAX = 200;
/** 이번 주기에 없던 서버의 상태를 들고 가는 시간(수집 한 번 실패로 사건이 끊기지 않게 — 그보다 오래면 버린다: 인메모리 맵 규약). */
export const CARRY_MS = 24 * 3_600_000;
const BAD_VERDICT = new Set(['saturated', 'errors', 'bottleneck']);
const METRIC_LABEL = Object.freeze({ cpu_pct: 'CPU', mem_pct: '메모리', disk_busy_pct: '디스크 busy', disk_await_ms: '디스크 await', net_pct: '네트워크' });
const HEALTH_LABEL = Object.freeze({ chrony: '시각 동기', units: '실패 유닛', oom: 'OOM', dmesg: '커널 오류', uptime: '재부팅 필요', fdct: 'FD · conntrack', cert: '인증서', tuned: 'TuneD · SELinux · firewalld' });

/**
 * 칸 단위 판정(순수) — 칸 id → 'true'(조건 성립) · 'false'(읽었고 성립 안 함) · 'unread'(못 읽음 · 경로 없음 · 띠 없음 등 판정 불가).
 *   health = 소모품 칸 · baseline = 지표 · cross = 교차 판정 id. use · profile 은 칸이 하나라 쓰지 않는다.
 */
export function ruleCells(id, ctx = {}, rule = {}) {
  const out = {};
  if (id === 'health') {
    for (const [k, c] of Object.entries(ctx.health?.cells || {})) {
      const code = c?.code;
      if (!['ok', 'warn', 'bad'].includes(code)) { out[k] = 'unread'; continue; }
      out[k] = (rule.cond === 'bad' ? code === 'bad' : code === 'warn' || code === 'bad') ? 'true' : 'false';
    }
  } else if (id === 'baseline') {
    for (const [m, d] of Object.entries(ctx.dev && typeof ctx.dev === 'object' ? ctx.dev : {})) {
      if (!d || d.reason || !d.out) { out[m] = 'unread'; continue; }
      out[m] = d.out === 'above' || d.out === 'below' ? 'true' : 'false';
    }
  } else if (id === 'collect') {
    // 6단계 수집 건강 — 칸은 수집 노드가 기준과 대 본 결과(collectHealth.collectCells) 그대로 · 조건이 고른 칸만.
    const cells = ctx.collect?.cells || {};
    const want = rule.cond && rule.cond !== 'any' ? [rule.cond] : Object.keys(cells);
    for (const k of want) out[k] = ['true', 'false'].includes(cells[k]) ? cells[k] : 'unread';
  } else if (id === 'cross') {
    for (const [i, x] of (Array.isArray(ctx.entry?.cross) ? ctx.entry.cross : []).entries()) {
      const k = String(x?.id ?? i);
      if (!x || x.state === 'missing' || x.state === 'nopath') { out[k] = 'unread'; continue; }
      out[k] = x.state === 'candidate' ? 'true' : 'false';
    }
  }
  return out;
}
/**
 * 규칙 조건(순수) — true(조건 성립) · false(성립 안 함) · null(판정 보류 — 못 읽음 · 오래됨 · 띠 없음).
 * ⚠⚠ 반증 F5: **직전에 참이던 칸을 이번에 못 읽었으면 null**(보류 — 사건 유지)이다. 예전에는 남은 칸이 정상이면 false 라 한 주기 결측(chronyc 시한 등)이
 *   사건을 ‘해소’ 하고 다음 주기에 같은 사건을 새로 보냈다. prevOn = 직전 주기에 참이던 칸 id 목록(상태의 on).
 * @param {string} id  규칙 id
 * @param {{entry?:object, health?:object, dev?:object, profile?:object}} ctx  그 서버의 이번 주기 값(이 노드가 만든 것)
 */
export function ruleCondition(id, ctx = {}, rule = {}, prevOn = null) {
  if (id === 'use') {
    const v = ctx.entry?.verdict;
    if (!v || ['stale', 'partial', 'unknown'].includes(v)) return null;
    if (rule.cond === 'bottleneck') return v === 'bottleneck';
    if (rule.cond === 'errors') return v === 'errors';
    return BAD_VERDICT.has(v);
  }
  if (id === 'profile') {
    const st = ctx.profile?.status;
    if (!st || st === 'none' || st === 'unknown') return null;
    return st === 'bad';
  }
  if (id === 'health' || id === 'baseline' || id === 'cross' || id === 'collect') {
    if (id === 'health' && !ctx.health?.cells) return null;
    if (id === 'collect' && !ctx.collect?.cells) return null;
    if (id === 'cross' && !(Array.isArray(ctx.entry?.cross) && ctx.entry.cross.length)) return null;
    const cells = ruleCells(id, ctx, rule);
    const vals = Object.values(cells);
    if (vals.includes('true')) return true;
    if (Array.isArray(prevOn) && prevOn.some((k) => cells[k] !== 'true' && cells[k] !== 'false')) return null;   // 직전 참 칸을 못 읽음 — 보류
    if (!vals.includes('false')) return null;
    return false;
  }
  return null;
}
/** 상태에 남길 ‘참이던 칸’(순수) — 성립이면 지금 참인 칸 · 보류면 직전 그대로 · 해소면 비움. */
export function onCellsAfter(id, ctx, rule, cond, prevOn) {
  if (cond === true) return Object.entries(ruleCells(id, ctx, rule)).filter(([, v]) => v === 'true').map(([k]) => k).slice(0, 16);
  if (cond === null || cond === undefined) return Array.isArray(prevOn) ? prevOn : [];
  return [];
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
  // 발송 실패 재시도(반증 F6 — 기존 알림 경로 규칙 retryDelayMs 재사용: 5분 · 15분 두 번까지) — 사건이 이어지는 동안만.
  if (p.active && n(p.retryAt) != null && now >= p.retryAt) return { state: { ...p, streak, since, seenAt: now, retryAt: null, firedAt: now }, fire: true, reason: 'retry' };
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
  const counts = { fire: 0, suppressed: 0, sustaining: 0, unknown: 0, ongoing: 0, corpOff: 0, retry: 0, clear: 0 };
  const on = RULE_IDS.filter((id) => id !== 'focusEnd' && rules?.[id]?.on);
  const seen = new Set();
  for (const it of items) {
    const key = String(it?.key || ''); if (!key) continue;
    for (const id of on) {
      const rule = rules[id];
      const sk = `${id}|${key}`; seen.add(sk);
      if ((rule.corpsOff || []).includes(String(it.vcenterId || ''))) { counts.corpOff += 1; continue; }
      const prev = state?.[sk] || null;
      const cond = ruleCondition(id, it, rule, prev?.on || null);
      const out = stepRule(prev, cond, rule, now);
      const on = onCellsAfter(id, it, rule, cond, prev?.on || null);
      next[sk] = on.length ? { ...out.state, on } : out.state;
      if (counts[out.reason] != null) counts[out.reason] += 1;
      if (out.fire) { counts.fire += 1; fires.push({ rule: id, key, name: it.name || key, vcenterId: String(it.vcenterId || ''), ctx: it, prevState: prev, retry: out.reason === 'retry' }); }
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
  if (f.rule === 'collect') {
    const x = c.collect || {};
    const LBL = { cycle: `주기 소요 ${x.cyclePct ?? '—'}%(예산 대비 · 기준 ${x.th?.cyclePct ?? '—'}%)`, success: `성공률 ${x.successPct ?? '—'}%(기준 ${x.th?.successPct ?? '—'}% 미만)`, db: `DB ${x.dbPct ?? '—'}%(상한 대비 · 기준 ${x.th?.dbPct ?? '—'}%)`, auth: '인증 정지 서버 있음' };
    const on = Object.entries(x.cells || {}).filter(([, v]) => v === 'true').map(([k]) => LBL[k] || k);
    return { key, severity: x.cells?.success === 'true' || x.cells?.db === 'true' ? 'critical' : 'warning', title: capStr(`${head} 수집 건강 기준 밖 — ${on.join(' · ')}`, 200),
      detail: capStr(`베어메탈 사용률 › 수집 건강 보드에서 법인별 실패 사유 · 조치를 확인하세요. 재진입 가드가 다음 주기를 건너뛰기 전에 알리는 것이 목적입니다.`, 1_500) };
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
      sent: Array.isArray(raw.sent) ? raw.sent.slice(-SENT_LOG_MAX) : [], ...(raw.autoAt && typeof raw.autoAt === 'object' ? { autoAt: raw.autoAt } : {}) };
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
/*
 * ⚠⚠ 상태 변경은 **한 직렬 큐**(반증 F1): 주기 판정(runPerfAlerts) · 집중 결론(runFocusEndAlert) · 발송 결과 기록이 각자 `load → await → save` 하면
 *   늦게 끝난 쪽이 앞의 결과를 통째로 덮었다(규칙 상태가 되돌아가 같은 사건을 다시 보냄 · 발송 기록 소실 · 하루 상한 카운트 공유/유실).
 *   이제 읽기-수정-쓰기를 큐의 한 단위로 하고, 단위 안에서는 같은 _state 객체를 고친 뒤 저장한다. 발송(I/O)은 단위 밖(대기열 — 아래 dispatch).
 */
let _chain = Promise.resolve();
function withState(fn) {
  const run = _chain.then(async () => { const st = load(); const r = await fn(st); save(st); return r; });
  _chain = run.catch(() => {});
  return run;
}
const _pendingSends = new Set();
export function _resetPerfAlertsForTest({ unlink = true } = {}) { _state = null; _warmup = false; _loadError = null; _chain = Promise.resolve(); if (unlink) { try { fs.unlinkSync(FILE()); } catch { /* */ } } }
/** 테스트 · 종료용 — 대기열에 넣은 발송의 결과 기록까지 끝날 때까지 기다린다. */
export async function _drainPerfAlertsForTest() { while (_pendingSends.size) await Promise.allSettled([..._pendingSends]); await _chain; }
/** 화면 · 봉투용 — 추적 수 · 오늘 상한 사용 · 발송 기록(최근 SENT_LOG_MAX — 채널 URL 없음). */
export function perfAlertStatus() {
  const st = load();
  const tracked = Object.values(st.rules || {}).filter((x) => x?.active).length;
  return { tracked, day: st.day, counts: st.counts || {}, sent: (st.sent || []).slice(-SENT_LOG_MAX), pendingSends: _pendingSends.size, ...(_loadError ? { loadError: _loadError } : {}) };
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
 * 발송 결과 → 기록 · 재시도(순수에 가까운 상태 고치기 — withState 안에서). 결과 판정은 기존 알림 경로의 deliveryOutcome(한 채널이라도 받았으면 delivered ·
 *   받은 채널 없이 오류면 failed · 정책상 안 보냄은 skipped). ⚠ 전 채널 실패를 ‘보냄’ 으로 적지 않는다(반증 F6).
 *   failed 이고 사건이 이어지는 중이면 retryDelayMs(기존 규칙 — 5분 · 15분 두 번)로 다음 시도 시각을 규칙 상태에 적는다(주기 판정이 그때 다시 보낸다).
 */
export function recordOutcome(st, { recId, sk = null, res, outcome, rule = {}, now = Date.now(), retryDelay = null } = {}) {
  const rec = (st.sent || []).find((x) => x.id === recId);
  const line = Array.isArray(res) ? res.map(String).join(' · ') : String(res ?? '');
  const result = outcome === 'delivered' ? 'sent' : outcome === 'failed' ? 'failed' : (/suppressed/.test(line) ? 'suppressed' : 'no-channel');
  if (rec) { rec.result = result; if (result === 'failed') rec.error = capStr(line, 160); }
  const rs = sk ? st.rules?.[sk] : null;
  if (rs && rs.active) {
    if (result === 'sent') { delete rs.retries; delete rs.retryAt; }
    else if (result === 'failed' && typeof retryDelay === 'function') {
      const cooldownMs = Math.max(0, n(rule.repeatMin) ?? 0) * 60_000 || Infinity;
      const d = retryDelay(n(rs.retries) ?? 0, cooldownMs);
      if (d != null) { rs.retries = (n(rs.retries) ?? 0) + 1; rs.retryAt = now + d; }
    }
  }
  return result;
}

/**
 * 발송 한 묶음 — 상한 · 억제 · 채널 · 이슈 · 자동 집중. ⚠ 반증 F6: 주기 수집 경로는 **판정 · 큐잉만** 한다 — 발송은 기존 알림 대기열(alerts.enqueueNotify — 채널별 레인 · 상한)이
 *   하고 결과는 끝난 뒤 큐 단위로 기록한다(예전에는 fires 마다 순차 await 라 SMTP 장애면 한 주기가 수십 분 묶였다). 주기당 상한 = 기존 MAX_SEND(bmusage/notify.js) —
 *   넘친 건은 상태를 되돌려 **다음 주기에 다시 판정**한다(조용히 버리지 않는다 · deferred 로 센다).
 * @param {Array} fires   evaluatePerfRules().fires 또는 집중 결론 한 건
 */
async function dispatch(fires, { rules, st, now, D, targetsByKey = new Map(), cycleMax = Infinity }) {
  const today = dayKey(now) || '';
  const out = { queued: 0, capped: 0, deferred: 0, maintenance: 0, failed: 0, issues: 0, autoFocus: 0 };
  const isEdge = !!config.agent?.centralUrl;
  const alertCfg = await D.alertConfig().catch(() => null);
  const issueFires = []; const sends = [];
  for (const f of fires) {
    const rule = rules.rules?.[f.rule] || {};
    const sk = f.rule === 'focusEnd' ? null : `${f.rule}|${f.key}`;
    if (sends.length >= cycleMax && alertCfg && sk) {
      // 주기 상한 — 이번에는 보내지 않고 상태를 되돌린다(다음 주기 다시 판정 · 지속은 그대로).
      const cur = st.rules?.[sk];
      if (cur) st.rules[sk] = { ...cur, active: false, firedAt: f.prevState?.firedAt ?? null, ...(f.retry ? { active: true, retryAt: now } : {}) };
      out.deferred += 1;
      continue;
    }
    const tg = targetsByKey.get(f.key) || f.ctx?.target || null;
    const rec = { id: crypto.randomUUID().slice(0, 12), at: now, rule: f.rule, key: f.key, name: capStr(f.name, 120), vcenterId: f.vcenterId, title: '', channels: rule.channels || [], result: '', issue: null, autoFocus: null, ...(f.retry ? { retry: true } : {}) };
    const mw = maintenanceFor(tg, now, rules.maintenance);
    const al = perfAlertOf({ ...f, sustain: rule.sustain, weeks: rules.baseline?.weeks }, {});
    rec.title = al.title;
    if (mw.suppressed && rules.maintenance?.backupWindows) { rec.result = 'maintenance'; out.maintenance += 1; }
    else if (used(st, f.vcenterId, 'alerts', today) >= (rules.daily?.alerts ?? 50)) { rec.result = 'daily-cap'; out.capped += 1; }
    else if (!alertCfg) { rec.result = 'no-channel-config'; out.failed += 1; }
    else {
      bump(st, f.vcenterId, 'alerts', today);
      rec.result = 'queued';
      sends.push({ recId: rec.id, sk, al, cfg: channelCfg(alertCfg, rule.channels || []), rule });
      out.queued += 1;
    }
    // 이슈 — 이슈 저장소가 있는 중앙이 만든다. 엣지는 ‘원함’ 표시만(중앙이 봉투를 받을 때 자기 문지기로 판단 — bmPerfOpsPull.ingestEdgeAlertIssues).
    if (rule.issue && !f.retry) {
      if (isEdge) rec.issue = 'pending-central';
      else issueFires.push({ ...rec, agent: config.agent?.name || '' });
    }
    // 자동 집중 — 법인 옵트인(focus.autoCorps) · 같은 서버 재발 억제 · 하루 상한. 이 노드의 대상만(엣지 위임 서버는 그 엣지가).
    if (rule.autoFocus && f.rule !== 'focusEnd' && !f.retry) {
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
    // 법인별 하루 상한은 이슈 문지기가 이슈 저장소에서 센다(applyBmPerfFires — 반증 F7).
    const r = await D.applyIssues(issueFires, { now, dailyMax: rules.daily?.issues ?? 20 }).catch((e) => ({ error: String(e?.message || e) }));
    for (const x of issueFires) {
      const rec = st.sent.find((y) => y.id === x.id);
      if (!rec) continue;
      const res = r?.byId?.[rec.id];
      if (res) { rec.issue = res; if (res === 'created') bump(st, rec.vcenterId, 'issues', today); }
      else rec.issue = r?.error ? 'error' : 'skipped';
    }
    out.issues = Object.values(r?.byId || {}).filter((x) => x === 'created').length;
  }
  // 발송은 대기열로 — 결과는 끝난 뒤 큐 단위로 기록(이 함수는 기다리지 않는다).
  for (const job of sends) {
    const p = Promise.resolve().then(() => D.notify(job.al, job.cfg))
      .catch((e) => [`queue:err ${String(e?.message || e).slice(0, 120)}`])
      .then(async (res) => {
        const outcome = await D.outcome(res).catch(() => 'failed');
        const retryDelay = await D.retryDelay().catch(() => null);
        const supMs = Math.max(0, n(job.cfg?.suppressWindowMin) ?? 5) * 60_000;
        await withState((s2) => recordOutcome(s2, { recId: job.recId, sk: job.sk, res, outcome, rule: job.rule, now: D.clock(), retryDelay: retryDelay ? (a, c) => retryDelay(a, c, supMs) : null }));
      })
      .catch(() => {})
      .finally(() => _pendingSends.delete(p));
    _pendingSends.add(p);
  }
  return out;
}

function depsOf(deps = {}) {
  return {
    alertConfig: async () => (await import('../alerts.js')).loadAlertConfig(),
    notify: async (al, cfg) => (await import('../alerts.js')).enqueueNotify(al, cfg),
    outcome: async (res) => (await import('../alerts.js')).deliveryOutcome(res),
    retryDelay: async () => (await import('../alerts.js')).retryDelayMs,
    applyIssues: async (fires, o) => (await import('../issues/alertIssues.js')).applyBmPerfFires(fires, o),
    startFocus: async (o) => (await import('./focus/run.js')).startFocusLocal(o),
    isMock: async () => (await import('../mock/demo/flags.js')).isMockMode(),
    clock: () => Date.now(),   // 발송 결과를 받은 시각(재시도 기준 — 기존 경로와 같이 ‘결과를 받은 시각’)
    ...deps,
  };
}

/**
 * 한 주기(폴러가 적재 · 소모품 판정 뒤 부른다). 켠 규칙이 없으면 판정도 하지 않는다(상태를 건드리지 않는다 — 다시 켤 때 예전 사건이 한꺼번에 나가지 않게).
 *   발송은 기다리지 않는다(대기열) — 돌려주는 queued 는 ‘대기열에 넣은 수’ 이고 결과는 발송 기록(sent)의 result 가 나중에 바뀐다.
 * @param {Array} items  [{ key, name, vcenterId, entry, health, dev, profile, target }]
 */
export async function runPerfAlerts(items = [], { rules, now = Date.now(), deps = {}, dryRun = false, cycleMax = MAX_SEND } = {}) {
  const D = depsOf(deps);
  const on = RULE_IDS.filter((id) => id !== 'focusEnd' && rules?.rules?.[id]?.on);
  if (!on.length) return { ok: true, skipped: 'no-rules' };
  if (dryRun) {
    // 시험 실행(반증 F10): 화면 문구대로 **지속 1주기 · 빈 상태**로 지금 값에 대 본다(재발 억제 · 진행 중 사건 무시) — 상태 파일을 읽지도 고치지도 않는다.
    const r1 = Object.fromEntries(Object.entries(rules.rules || {}).map(([id, x]) => [id, { ...x, sustain: 1, repeatMin: 0 }]));
    const { fires, counts } = evaluatePerfRules(items, r1, {}, now);
    return { ok: true, dryRun: true, counts, fires: fires.map((f) => ({ rule: f.rule, key: f.key, name: f.name, vcenterId: f.vcenterId, title: perfAlertOf(f).title })) };
  }
  if (await D.isMock().catch(() => false)) return { ok: true, skipped: 'demo' };
  return withState(async (st) => {
    const { next, fires, counts } = evaluatePerfRules(items, rules.rules, st.rules, now);
    st.rules = next;
    // 상태가 바뀐 적 없는 첫 주기(손상 뒤 warmup)는 기준만 잡는다.
    if (_warmup) { _warmup = false; return { ok: true, warmup: true, counts }; }
    const targetsByKey = new Map(items.filter((x) => x?.target).map((x) => [x.key, x.target]));
    const out = fires.length ? await dispatch(fires, { rules, st, now, D, targetsByKey, cycleMax }) : {};
    return { ok: true, counts, fires: fires.length, ...out };
  });
}

/** 집중 결론 규칙 — 세션이 끝날 때 한 번(focus/run.js onFocusEnd 구독). 같은 직렬 큐. */
export async function runFocusEndAlert(ev, { rules, now = Date.now(), deps = {} } = {}) {
  const rule = rules?.rules?.focusEnd;
  if (!rule?.on) return { ok: true, skipped: 'off' };
  if ((rule.corpsOff || []).includes(String(ev.vcenterId || ''))) return { ok: true, skipped: 'corp-off' };
  const D = depsOf(deps);
  if (await D.isMock().catch(() => false)) return { ok: true, skipped: 'demo' };
  const s = ev.summary || {};
  if (!['done', 'stopped', 'auth'].includes(ev.status)) return { ok: true, skipped: 'status' };
  if (rule.cond !== 'any' && (!s.verdictTo || s.verdictTo === 'ok')) return { ok: true, skipped: 'returned-ok' };
  return withState(async (st) => {
    const out = await dispatch([{ rule: 'focusEnd', key: ev.key, name: ev.name, vcenterId: String(ev.vcenterId || ''), ctx: { summary: s, id: ev.id, target: ev.target } }], { rules, st, now, D });
    return { ok: true, ...out };
  });
}

/** 베이스라인 지표 — 웹 · 테스트 공용(같은 목록). */
export { BASELINE_METRICS };
