/**
 * Alerting — evaluates threshold/condition rules against the current snapshot on
 * an interval and pushes notifications to Slack(incoming webhook) and/or a
 * generic Webhook(JSON POST) · **Email**(v2.454). Dependency-free — HTTP 는 fetch,
 * 메일은 `util/smtp.js`(net/tls 직접 구현)를 `mail/service.js` 경유로 쓴다.
 * 메일 SMTP·수신자는 **설정 › 메일 발송** 한 곳에서만 정하고 여기서는 on/off 만 본다
 * (기능마다 SMTP 를 따로 두면 운영자가 같은 값을 여러 번 입력하게 된다).
 *
 * Config: CONFIG_DIR/alerts.json. Fires on a condition becoming active (new),
 * re-notifies after cooldown while still active, and notes resolution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js';
import { store } from './store.js';
import { logAudit } from './audit.js';
import { resilientFetch } from './util/resilientFetch.js';
import { ssrfBlockReasonResolved } from './collector/registry.js';
import { Agent as UndiciAgent } from 'undici';
import { ssrfLookup } from './util/ssrfLookup.js';
import { numOrNull } from './util/numOrNull.js';   // v2.506: DNS 리바인딩(TOCTOU) 차단
import { sendPortalMail } from './mail/service.js'; // 공용 메일 발송(v2.454)
import { registerExitFlush } from './util/exitFlush.js';
// v2.604(감사 SEC2604-03): 채널 웹훅 URL 은 그 자체가 비밀(경로에 토큰이 들어 있다)이라 암호화 모드에서 봉인한다.
// 메모리는 평문이다 — 화면·연결 테스트·발송은 예전과 같다. 평문 파일(구버전·평문 모드)은 그대로 읽힌다.
import { openSecretsDeep, sealSecretsDeep, FILE_EXTRA_SECRET_FIELDS } from './security/secretVault.js';

const FILE = path.join(config.configDir, 'alerts.json');
const URL_SECRET_FIELDS = FILE_EXTRA_SECRET_FIELDS['alerts.json'];

const DEFAULTS = {
  channels: {
    slack: { enabled: false, url: '' },
    webhook: { enabled: false, url: '' },
    teams: { enabled: false, url: '' }, // Microsoft Teams incoming webhook (MessageCard)
    // 메일은 URL 이 아니라 전역 SMTP 설정(mail.json)을 쓴다 — 여기서는 이 채널을 쓸지만 정한다.
    email: { enabled: false },
  },
  rules: {
    criticalAlarms: { enabled: true },
    vcenterDown: { enabled: true },
    hostDisconnected: { enabled: true },
    massVmPowerOff: { enabled: true, threshold: 10, perVcenter: {} },
    datastorePct: { enabled: true, threshold: 90 },
    ramOvercommitPct: { enabled: false, threshold: 120 },
    vcpuPerCore: { enabled: false, threshold: 5 },
  },
  cooldownMin: 60,
  intervalSec: 60,
  // 채널 무관 전역 중복 억제 창(분) — 엔진의 firing/cooldown을 거치지 않고 notify()를 직접
  // 부르는 경로(loginMonitor·netMonitor·guestScanScheduler)까지 같은 key 폭주를 막는다.
  suppressWindowMin: 5,
};

/**
 * v2.605(감사 WEB2605-05 — 재현): 규칙 임계치의 범위. 예전 저장은 body.rules 를 **검증 없이** 병합해, 칸을 비우면
 * `Number('')=0` 이 그대로 저장·표시됐는데 평가는 `Number(0)||90` 이라 실제 기준은 90 이었다(화면 ≠ 실제). 음수(-5)는
 * 그대로 쓰여 전 데이터스토어가 발화했다. 규칙: 빈 값·숫자 아님·0 이하는 **미지정**(이전 값 유지), 그 밖은 범위로 자른다.
 */
export const RULE_THRESHOLD_RANGE = Object.freeze({
  datastorePct: { min: 1, max: 100 },
  ramOvercommitPct: { min: 1, max: 10000 },
  vcpuPerCore: { min: 0.1, max: 1000, float: true },
  massVmPowerOff: { min: 1, max: 100000 },
});

/** 임계치 1개 정규화(순수). 미지정이면 prev 를 돌려준다. */
export function normalizeRuleThreshold(rule, v, prev) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return prev;
  const r = RULE_THRESHOLD_RANGE[rule] || { min: 0, max: Infinity, float: true };
  const x = r.float ? n : Math.round(n);
  return Math.max(r.min, Math.min(r.max, x));
}

/** body.rules 를 현재 규칙 위에 병합 — 객체가 아닌 규칙은 버리고, threshold 는 normalizeRuleThreshold 로 좁힌다. */
export function mergeRules(curRules = {}, bodyRules = {}) {
  const out = { ...curRules };
  if (!bodyRules || typeof bodyRules !== 'object' || Array.isArray(bodyRules)) return out;
  for (const [k, v] of Object.entries(bodyRules)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const prev = curRules[k] && typeof curRules[k] === 'object' ? curRules[k] : (DEFAULTS.rules[k] || {});
    const merged = { ...prev, ...v };
    if ('threshold' in v || 'threshold' in prev) {
      const prevTh = numOrNull(prev.threshold) != null && Number(prev.threshold) > 0 ? Number(prev.threshold) : DEFAULTS.rules[k]?.threshold;
      merged.threshold = 'threshold' in v ? normalizeRuleThreshold(k, v.threshold, prevTh) : prevTh;
    }
    out[k] = merged;
  }
  return out;
}

let cache = null;
export function loadAlertConfig() {
  if (cache) return cache;
  cache = structuredClone(DEFAULTS);
  try {
    if (fs.existsSync(FILE)) {
      const s = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')), URL_SECRET_FIELDS);
      cache = {
        channels: {
          slack: { ...DEFAULTS.channels.slack, ...s.channels?.slack },
          webhook: { ...DEFAULTS.channels.webhook, ...s.channels?.webhook },
          teams: { ...DEFAULTS.channels.teams, ...s.channels?.teams },
          email: { ...DEFAULTS.channels.email, ...s.channels?.email }, // v2.479(감사 코어 B-1): 로드에서 탈락돼 메일 알림이 죽어 있었다
        },
        rules: { ...DEFAULTS.rules, ...(s.rules || {}) },
        cooldownMin: s.cooldownMin ?? DEFAULTS.cooldownMin,
        intervalSec: s.intervalSec ?? DEFAULTS.intervalSec,
        suppressWindowMin: s.suppressWindowMin ?? DEFAULTS.suppressWindowMin,
      };
    }
  } catch (e) { preserveCorrupt(FILE, e.message); /* defaults */ }
  return cache;
}
export function saveAlertConfig(body = {}) {
  const cur = loadAlertConfig();
  const next = {
    channels: {
      slack: { enabled: !!body.channels?.slack?.enabled, url: body.channels?.slack?.url ?? cur.channels.slack.url },
      webhook: { enabled: !!body.channels?.webhook?.enabled, url: body.channels?.webhook?.url ?? cur.channels.webhook.url },
      teams: { enabled: !!body.channels?.teams?.enabled, url: body.channels?.teams?.url ?? (cur.channels.teams?.url || '') },
      email: { enabled: !!body.channels?.email?.enabled }, // v2.479: 저장에서도 탈락(웹 체크박스가 저장 직후 풀리던 원인)
    },
    rules: mergeRules(cur.rules, body.rules),
    cooldownMin: Math.max(1, Number(body.cooldownMin) || cur.cooldownMin),
    // v2.595(감사 T2595-01): 상한 1일 — 24.8일을 넘기면 setInterval 이 1ms 틱이 되고 저장값이라 재시작해도 남는다.
    intervalSec: Math.min(ALERT_INTERVAL_MAX_SEC, Math.max(15, Number(body.intervalSec) || cur.intervalSec)),
    suppressWindowMin: Math.max(0, body.suppressWindowMin != null ? Number(body.suppressWindowMin) || 0 : (cur.suppressWindowMin ?? 5)),
  };
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next, undefined, URL_SECRET_FIELDS), null, 2), { mode: 0o600 });
  cache = next; // 메모리는 평문(sealSecretsDeep 는 복제본을 봉인한다)
  rescheduleAlertEngine(); // 주기(intervalSec) 변경 즉시 반영 — 이전엔 재시작 전까지 저장만 되고 무시됐다
  return next;
}

/** 값을 못 읽어 판정 보류된 발생 알림을 유지하는 최대 시간(v2.598) — 넘으면 해소 알림 없이 끊는다. */
export const HELD_MAX_MS = 6 * 3600_000;

/** Evaluate rules against a snapshot → array of { key, severity, title, detail }. */
export function evaluate(snap, cfg = loadAlertConfig()) {
  const out = [];
  // 판정 보류 키(값을 못 읽음) — 발생 중이면 해소하지 않는다. 배열 원소가 아니라 숨은 속성이다(기존 소비처·비교 무변경).
  const held = new Set();
  Object.defineProperty(out, 'held', { value: held, enumerable: false });
  const R = cfg.rules;
  if (R.criticalAlarms?.enabled) {
    for (const a of (snap.alarms || []).filter((x) => x.severity === 'critical').slice(0, 100)) {
      out.push({ key: `alarm:${a.id || a.name}`, vcenterId: a.vcenterId || '', severity: 'critical', title: `위험 알람: ${a.name || a.entity || ''}`, detail: `${a.vcenterId || ''} ${a.entity || ''} ${a.status || ''}`.trim() });
    }
  }
  if (R.vcenterDown?.enabled) {
    for (const v of (snap.vcenters || []).filter((x) => x.status === 'unreachable')) {
      out.push({ key: `vc:${v.id}`, vcenterId: v.id, severity: 'critical', title: `vCenter 수집 실패: ${v.name || v.id}`, detail: v.error || '연결 불가' });
    }
  }
  if (R.hostDisconnected?.enabled) {
    for (const h of (snap.hosts || []).filter((x) => x.connectionState === 'DISCONNECTED').slice(0, 100)) {
      out.push({ key: `host:${h.id}`, vcenterId: h.vcenterId || '', severity: 'warning', title: `호스트 연결 끊김: ${h.name}`, detail: `${h.vcenterId} / ${h.cluster || ''}` });
    }
  }
  if (R.datastorePct?.enabled) {
    const th = Number(R.datastorePct.threshold) || 90;
    // v2.598(감사 RECENT2598-03 — 재현): vCenter REST 폴백은 사용량을 못 읽은 DS 를 usagePct:null 로 준다(v2.597 C2597-08).
    // 예전 `(x.usagePct || 0) >= th` 는 그것을 0% 로 읽어 **발생 중이던 용량 알림을 '해소' 로 보냈다**. 못 읽은 값은 초과도
    // 정상도 아니다 — 판정 보류(held)로 두고 tick 이 해소하지 않는다(bmusage·PDU F5 와 같은 규약).
    for (const d of snap.datastores || []) if (numOrNull(d.usagePct) == null && d.id != null) held.add(`ds:${d.id}`);
    for (const d of (snap.datastores || []).filter((x) => numOrNull(x.usagePct) != null && Number(x.usagePct) >= th).slice(0, 200)) {
      out.push({ key: `ds:${d.id}`, vcenterId: d.vcenterId || '', severity: d.usagePct >= 95 ? 'critical' : 'warning', title: `데이터스토어 용량 ${d.usagePct}%: ${d.name}`, detail: `${d.vcenterId} · 여유 ${d.freeGB}GB` });
    }
  }
  if (R.ramOvercommitPct?.enabled || R.vcpuPerCore?.enabled) {
    const byC = new Map();
    for (const h of snap.hosts || []) {
      const k = `${h.vcenterId} ${h.cluster || 'standalone'}`;
      const c = byC.get(k) || { name: h.cluster || 'standalone', vc: h.vcenterId, cores: 0, memGB: 0, vcpu: 0, ramGB: 0 };
      c.cores += h.cpuCores || 0; c.memGB += (h.memTotalMB || 0) / 1024; byC.set(k, c);
    }
    for (const v of snap.vms || []) {
      if (v.powerState !== 'POWERED_ON' || v.template) continue;
      const k = `${v.vcenterId} ${v.cluster || 'standalone'}`;
      const c = byC.get(k); if (c) { c.vcpu += v.cpuCount || 0; c.ramGB += (v.memMB || 0) / 1024; }
    }
    for (const c of byC.values()) {
      if (R.ramOvercommitPct?.enabled && c.memGB > 0) {
        const pct = Math.round((c.ramGB / c.memGB) * 100);
        if (pct >= (Number(R.ramOvercommitPct.threshold) || 120)) out.push({ key: `ramoc:${c.vc}:${c.name}`, severity: 'warning', title: `RAM 오버커밋 ${pct}%: ${c.name}`, detail: `${c.vc} · 할당 ${Math.round(c.ramGB)}/${Math.round(c.memGB)}GB` });
      }
      if (R.vcpuPerCore?.enabled && c.cores > 0) {
        const ratio = Number((c.vcpu / c.cores).toFixed(1));
        if (ratio >= (Number(R.vcpuPerCore.threshold) || 5)) out.push({ key: `vcpuoc:${c.vc}:${c.name}`, severity: 'warning', title: `vCPU:코어 ${ratio}:1: ${c.name}`, detail: `${c.vc} · vCPU ${c.vcpu}/코어 ${c.cores}` });
      }
    }
  }
  return out;
}

/**
 * 동시 다운 감지(상태 전이) — 직전 스냅샷에서 POWERED_ON이던 VM이 현재 POWERED_OFF로
 * 바뀐 수를 vCenter별로 집계해 임계 이상이면 위험 알림. 호스트/스토리지/클러스터 장애 징후.
 * 순수 함수: prevPower(Map: vmId→powerState)와 현재 snap을 받아 알림 배열 반환.
 * 주의: '현재 스냅샷에 존재하며 OFF로 바뀐' VM만 센다 → vCenter 수집 실패(VM 누락)로 인한
 * 오탐을 방지(누락 VM은 전이로 보지 않음).
 */
export function detectMassPowerOff(prevPower, snap, ruleOrThreshold = 10) {
  const out = [];
  if (!prevPower || !prevPower.size) return out;
  // 3번째 인자: 숫자(전역 임계, 하위호환) 또는 규칙객체 { threshold, perVcenter:{vcId:임계} }.
  const rule = (ruleOrThreshold && typeof ruleOrThreshold === 'object') ? ruleOrThreshold : { threshold: ruleOrThreshold };
  const defTh = Math.max(2, Number(rule.threshold) || 10);
  const per = rule.perVcenter || {};
  const thFor = (vc) => { const t = Number(per[vc]); return Number.isFinite(t) && t >= 1 ? Math.round(t) : defTh; };
  const byVc = new Map();
  for (const v of snap.vms || []) {
    if (v.template) continue;
    if (prevPower.get(v.id) === 'POWERED_ON' && v.powerState === 'POWERED_OFF') {
      const g = byVc.get(v.vcenterId) || []; g.push(v); byVc.set(v.vcenterId, g);
    }
  }
  for (const [vc, list] of byVc) {
    const th = thFor(vc);
    if (list.length < th) continue;
    const byHost = {};
    for (const v of list) { const h = v.host || '?'; byHost[h] = (byHost[h] || 0) + 1; }
    const hostStr = Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, n]) => `${h}:${n}대`).join(', ');
    const names = list.slice(0, 8).map((v) => v.name).join(', ');
    out.push({
      key: `massoff:${vc}`, severity: 'critical',
      title: `VM 동시 다운 ${list.length}대: ${vc}`,
      detail: `직전 수집 이후 ${list.length}대가 동시에 전원 OFF(임계 ${th}대). 호스트별 ${hostStr}. 대상 ${names}${list.length > 8 ? ` 외 ${list.length - 8}대` : ''}. 호스트/스토리지/클러스터 장애 의심.`,
    });
  }
  return out;
}

/** 이상동작 탐지(동시 다운) 설정 조회 — 전역 임계 + vCenter별 임계. */
export function getAnomalySettings() {
  const cfg = loadAlertConfig();
  const r = cfg.rules.massVmPowerOff || { enabled: true, threshold: 10, perVcenter: {} };
  return { enabled: r.enabled !== false, threshold: r.threshold ?? 10, perVcenter: r.perVcenter || {}, intervalSec: cfg.intervalSec };
}

/** 이상동작 탐지 설정 저장 — 채널/쿨다운 등 기존 알림 설정은 보존하고 동시다운 규칙만 갱신. */
export function saveAnomalySettings(body = {}) {
  const cur = loadAlertConfig();
  const perVcenter = {};
  for (const [k, v] of Object.entries(body.perVcenter || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) perVcenter[k] = Math.min(100000, Math.round(n));
  }
  const rule = { enabled: body.enabled !== false, threshold: Math.max(2, Number(body.threshold) || 10), perVcenter };
  saveAlertConfig({ channels: cur.channels, cooldownMin: cur.cooldownMin, intervalSec: cur.intervalSec, rules: { ...cur.rules, massVmPowerOff: rule } });
  return getAnomalySettings();
}

/** 현재 스냅샷의 VM 전원상태로 직전상태 맵을 갱신(존재하는 VM만 → 수집 실패 시 직전값 유지). */
function updatePrevPower(prev, snap) {
  const vms = snap.vms || [];
  // 정상 수집(현재 스냅샷에 VM이 있음)일 때만, 스냅샷에서 사라진 VM 키를 제거한다 — 무한 증식과
  // moref 재사용 시 옛 POWERED_ON 잔재로 인한 오탐(대량 전원차단 감지) 방지. 수집 실패(빈 스냅샷)
  // 시에는 직전값을 보존한다.
  if (vms.length) {
    const live = new Set(vms.map((v) => v.id));
    for (const id of prev.keys()) if (!live.has(id)) prev.delete(id);
  }
  for (const v of vms) { if (!v.template) prev.set(v.id, v.powerState); }
  return prev;
}

// 웹훅은 Slack 등 '공인 CA' SaaS가 대상 — 내부 자체서명용 wanAgent(검증 off)로 보내면
// 웹훅 URL(시크릿 포함)이 무검증 TLS로 나간다. 검증 켠 전용 디스패처를 사용한다.
// v2.506(감사 S1 #2): DNS 리바인딩(TOCTOU) 차단 — 검증을 `lookup` 안에서 해 소켓이 실제로 쓸
// 주소를 그 순간에 검사한다. SNI(`servername`)·Host·인증서 검증은 원래 호스트명을 그대로 쓴다.
// 자세한 근거는 util/ssrfLookup.js 머리말.
// 웹훅 URL 은 관리자가 넣는 외부 주소라 리바인딩 표적이 되기 쉽다(223행의 사전 검사만으로는
// 검사-접속 사이가 열려 있었다). `redirect:'manual'` 과 함께 2중으로 막는다.
const webhookAgent = new UndiciAgent({ connect: { rejectUnauthorized: true, lookup: ssrfLookup }, connections: 4 });
async function post(url, payload) {
  // 웹훅 URL 은 사용자 입력 — 전송 **직전**에 해석형 SSRF 가드를 다시 통과시킨다. 저장 시점에만
  // 검사하면 그 뒤 DNS 가 루프백/메타데이터로 바뀌는 경우(TOCTOU/DNS rebinding)를 놓친다. RFC1918
  // 사내 웹훅은 허용, 루프백/링크로컬/우회표기만 차단(pyportal notify._post_webhook 와 동형).
  const ssrf = await ssrfBlockReasonResolved(String(url || ''));
  if (ssrf) throw new Error(`웹훅 대상이 차단됐습니다: ${ssrf}`);
  // 일시적 네트워크 오류로 알림이 조용히 유실되지 않도록 1회 재시도(고RTT 외부 웹훅 대응).
  // redirect:'manual' — 웹훅 응답의 3xx 리다이렉트를 따라가지 않는다(공격자가 302 로 사내
  // 호스트로 되돌리는 우회 SSRF 차단; 정상 Slack/Teams 는 200 직응답이라 영향 없음).
  return resilientFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 15000, retries: 1, dispatcher: webhookAgent, redirect: 'manual' });
}
/** Teams incoming webhook용 MessageCard 페이로드 — 순수 함수(테스트 대상). */
export function buildTeamsPayload(alert, text) {
  const color = alert.severity === 'critical' ? 'D73A3A' : alert.severity === 'resolved' ? '2EB67D' : 'E8A33D';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: color,
    summary: alert.title || 'VMware Portal 알림',
    title: alert.title || 'VMware Portal 알림',
    text: (alert.detail || text || '').replace(/\n/g, '\n\n'), // Teams는 단일 \n을 무시
  };
}

/**
 * 전역 중복 억제 판정 — 같은 key가 창(windowMs) 안에서 재발송되면 true. 순수 함수(맵 주입).
 * 엔진 cooldown과 별개로 notify() 직접 호출 경로(브루트포스·네트워크 모니터)의 폭주를 막는다.
 */
export function shouldSuppress(sentMap, key, now, windowMs) {
  if (!key || !windowMs) return false;
  const last = sentMap.get(key) || 0;
  if (now - last < windowMs) return true;
  sentMap.set(key, now);
  // 맵 무한 증식 방지 — 오래된 키 정리(호출 빈도가 낮아 전체 순회 비용 무시 가능).
  if (sentMap.size > 2000) { for (const [k, t] of sentMap) if (now - t > windowMs * 10) sentMap.delete(k); }
  return false;
}
const _sentAt = new Map(); // key -> lastSentTs (전역 억제 창)

export async function notify(alert, cfg = loadAlertConfig()) {
  const text = `[${alert.severity === 'critical' ? '🔴 위험' : '🟠 경고'}] ${alert.title}${alert.detail ? `\n${alert.detail}` : ''}`;
  const windowMs = Math.max(0, cfg.suppressWindowMin ?? 5) * 60_000;
  if (shouldSuppress(_sentAt, alert.key, Date.now(), windowMs)) return ['suppressed'];
  const results = [];
  if (cfg.channels.slack?.enabled && cfg.channels.slack.url) {
    try { const r = await post(cfg.channels.slack.url, { text }); results.push(`slack:${r.status}`); } catch (e) { results.push(`slack:err ${e.message}`); }
  }
  if (cfg.channels.webhook?.enabled && cfg.channels.webhook.url) {
    try { const r = await post(cfg.channels.webhook.url, { source: 'vmware-portal', ...alert, text, at: new Date().toISOString() }); results.push(`webhook:${r.status}`); } catch (e) { results.push(`webhook:err ${e.message}`); }
  }
  if (cfg.channels.teams?.enabled && cfg.channels.teams.url) {
    try { const r = await post(cfg.channels.teams.url, buildTeamsPayload(alert, text)); results.push(`teams:${r.status}`); } catch (e) { results.push(`teams:err ${e.message}`); }
  }
  if (cfg.channels.email?.enabled) {
    // sendPortalMail 은 throw 하지 않는다(폴러가 메일 하나로 죽으면 안 된다) — 결과만 기록.
    const r = await sendPortalMail({ kind: 'alert', subject: alertSubject(alert), html: alertHtml(alert), text });
    results.push(`email:${r.ok ? 'ok' : (r.skipped ? 'skip' : 'err')}${r.ok ? '' : ` ${r.reason}`}`);
  }
  return results;
}

/** 알림 메일 제목 — 심각도를 앞에 두어 받은 편지함에서 정렬·필터가 쉽게. */
export function alertSubject(alert) {
  const sev = alert?.severity === 'critical' ? '[위험]' : alert?.severity === 'info' ? '[안내]' : '[경고]';
  return `${sev} ${String(alert?.title || '알림').slice(0, 180)}`;
}

/** 알림 메일 본문(HTML) — 메일 클라이언트 호환을 위해 인라인 스타일만 쓴다. */
export function alertHtml(alert) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = alert?.severity === 'critical' ? '#d92d20' : alert?.severity === 'info' ? '#2e90fa' : '#f79009';
  const label = alert?.severity === 'critical' ? '위험' : alert?.severity === 'info' ? '안내' : '경고';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;max-width:680px;padding:16px;color:#101828;">
  <div style="display:inline-block;padding:2px 10px;border-radius:10px;background:${color};color:#fff;font-size:12px;font-weight:600;">${label}</div>
  <h2 style="margin:10px 0 6px;font-size:17px;">${esc(alert?.title || '알림')}</h2>
  ${alert?.detail ? `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.7;color:#344054;margin:0;">${esc(alert.detail)}</pre>` : ''}
  <div style="color:#667085;font-size:11.5px;margin-top:16px;border-top:1px solid #eaecf0;padding-top:10px;">
    VMware Global Monitoring Portal — 설정 › 메일 발송에서 수신자와 종류별 on/off 를 바꿀 수 있습니다.
  </div>
</div>`;
}

/**
 * 일반 텍스트 브로드캐스트(일일 리포트 등) — 알림 규칙/억제와 무관하게 활성 채널 전체로 발송.
 * title은 Teams 카드 제목·웹훅 메타에 쓰인다.
 */
export async function sendText(text, title = 'VMware Portal 리포트', kind = 'daily') {
  const cfg = loadAlertConfig();
  const results = [];
  if (cfg.channels.slack?.enabled && cfg.channels.slack.url) {
    try { const r = await post(cfg.channels.slack.url, { text }); results.push(`slack:${r.status}`); } catch (e) { results.push(`slack:err ${e.message}`); }
  }
  if (cfg.channels.webhook?.enabled && cfg.channels.webhook.url) {
    try { const r = await post(cfg.channels.webhook.url, { source: 'vmware-portal', kind: 'report', title, text, at: new Date().toISOString() }); results.push(`webhook:${r.status}`); } catch (e) { results.push(`webhook:err ${e.message}`); }
  }
  if (cfg.channels.teams?.enabled && cfg.channels.teams.url) {
    try { const r = await post(cfg.channels.teams.url, buildTeamsPayload({ title, detail: text, severity: 'info' }, text)); results.push(`teams:${r.status}`); } catch (e) { results.push(`teams:err ${e.message}`); }
  }
  if (cfg.channels.email?.enabled) {
    // 일일 리포트 등 브로드캐스트는 'daily' 종류로 보낸다 — 알림과 수신자를 따로 둘 수 있게.
    const r = await sendPortalMail({ kind, subject: title, html: alertHtml({ title, detail: text, severity: 'info' }), text });
    results.push(`email:${r.ok ? 'ok' : (r.skipped ? 'skip' : 'err')}${r.ok ? '' : ` ${r.reason}`}`);
  }
  return results;
}

// --- Engine state ---
const firing = new Map();   // key -> { alert, since, lastNotified }
/*
 * v2.597(감사 LC2597-01 — 재현): 발생 중 알림의 since·lastNotified 를 파일에 남긴다. 인메모리뿐이라 재시작(업그레이드 포함)
 * 마다 발생 중인 알림 **전부**가 쿨다운과 무관하게 다시 발송됐다(첫 평가 8초 뒤). bmusage(v2.551)·파트 장애(v2.548)와
 * 같은 이유다. 기동 시 복원하고, 해소되면 지운다. 저장은 디바운스 + 종료 flush.
 */
const STATE_FILE = path.join(config.configDir, 'alerts-state.json');
const STATE_MAX = 5000;
let _restored = null;   // key -> { since, lastNotified } (첫 평가에서 소비)
function loadAlertState() {
  if (_restored) return _restored;
  _restored = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j?.firing || {})) {
      if (v && Number.isFinite(v.since)) _restored.set(k, { since: v.since, lastNotified: Number(v.lastNotified) || 0 });
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE, e.message); console.warn(`[alerts] 상태 파일 손상(${e.message}) — 보존 후 빈 상태로 시작`); }
  }
  return _restored;
}
let _stateTimer = null;
function writeAlertStateNow() {
  clearTimeout(_stateTimer); _stateTimer = null;
  const out = {};
  let n = 0;
  for (const [k, st] of firing) { if (n++ >= STATE_MAX) break; out[k] = { since: st.since, lastNotified: st.lastNotified || 0 }; }
  for (const [k, r] of (_restored || new Map())) { if (n++ >= STATE_MAX) break; if (!out[k]) out[k] = { since: r.since, lastNotified: r.lastNotified || 0 }; }
  try { atomicWriteFileSync(STATE_FILE, JSON.stringify({ version: 1, at: Date.now(), firing: out })); } catch (e) { console.warn(`[alerts] 상태 저장 실패: ${e.message}`); }
}
function saveAlertStateSoon() {
  if (_stateTimer) return;
  _stateTimer = setTimeout(writeAlertStateNow, 3_000);
  _stateTimer.unref?.();
}
registerExitFlush('alerts-state', () => { if (_stateTimer) writeAlertStateNow(); });
export function _resetAlertStateForTest() { firing.clear(); _restored = null; clearTimeout(_stateTimer); _stateTimer = null; }
export { refreshState as _refreshStateForTest, writeAlertStateNow as _writeAlertStateForTest };
const recent = [];          // recent notifications (in-memory, newest first)
let timer = null;
let vmPowerPrev = null;      // vmId -> powerState (직전 스냅샷, 동시 다운 감지용)

function pushRecent(entry) { recent.unshift(entry); if (recent.length > 200) recent.pop(); }

let _ticking = false;   // v2.595: 재진입 가드(짧은 주기에서 평가가 겹치지 않게 — 폴러 규약)
async function tick() {
  if (_ticking) return;
  _ticking = true;
  try { return await tickInner(); } finally { _ticking = false; }
}
async function tickInner() {
  const cfg = loadAlertConfig();
  if (!cfg.channels.slack?.enabled && !cfg.channels.webhook?.enabled && !cfg.channels.teams?.enabled && !cfg.channels.email?.enabled) { // still track state for UI (v2.479: email 포함)
    refreshState(cfg, false);
    return;
  }
  await refreshState(cfg, true);
}

async function refreshState(cfg, sendEnabled) {
  let active = [];
  const snap = store.get();
  try { active = evaluate(snap, cfg); } catch { active = []; }
  // 판정 보류 키는 아래 concat(새 배열) 전에 잡아 둔다 — 숨은 속성은 concat 으로 옮겨지지 않는다.
  const held = active.held instanceof Set ? active.held : new Set();
  // 동시 다운 감지: 직전 스냅샷과 비교(전이). 규칙 켜져 있을 때만 알림에 포함하되,
  // 직전상태 맵은 항상 갱신해 다음 주기 비교를 유지한다.
  try {
    if (vmPowerPrev && cfg.rules?.massVmPowerOff?.enabled) {
      active = active.concat(detectMassPowerOff(vmPowerPrev, snap, cfg.rules.massVmPowerOff));
    }
    vmPowerPrev = updatePrevPower(vmPowerPrev || new Map(), snap);
  } catch { /* */ }
  const now = Date.now();
  const cooldownMs = (cfg.cooldownMin || 60) * 60_000;
  const seen = new Set();
  const restored = loadAlertState();
  let changed = false;
  for (const a of active) {
    seen.add(a.key);
    const prev = firing.get(a.key);
    if (!prev) {
      const r = restored.get(a.key);   // 재시작 전에 이미 발생·발송된 알림이면 그 시각을 이어받는다
      firing.set(a.key, { alert: a, since: r ? r.since : now, lastNotified: r ? r.lastNotified : 0 });
      changed = true;
    }
    const st = firing.get(a.key);
    st.alert = a;
    if (sendEnabled && now - (st.lastNotified || 0) >= cooldownMs) {
      st.lastNotified = now;
      changed = true;
      notify(a, cfg).then((res) => { pushRecent({ at: new Date().toISOString(), ...a, channels: res }); }).catch(() => {});
    }
  }
  // resolve
  for (const [key, st] of [...firing.entries()]) {
    if (seen.has(key)) { if (st.heldSince) { st.heldSince = 0; changed = true; } continue; }
    // v2.598 RECENT2598-03: 값을 못 읽은 항목은 해소가 아니다 — 발생 상태를 유지한다. 오래(HELD_MAX_MS) 못 읽으면 알림 없이
    // 끊는다(복구가 아니라 **모르는 것**이다 — '해소' 알림을 내지 않는다).
    if (held.has(key)) {
      if (!st.heldSince) { st.heldSince = now; changed = true; }
      if (now - st.heldSince < HELD_MAX_MS) continue;
      firing.delete(key); changed = true; continue;
    }
    firing.delete(key); changed = true; pushRecent({ at: new Date().toISOString(), key, title: `해소: ${st.alert.title}`, severity: 'resolved' });
  }
  // 복원 목록은 **쿨다운이 남은 동안만** 들고 있는다 — 기동 직후에는 스냅샷이 아직 비어(첫 수집 중) 활성 목록이 0 이라
  // 첫 평가에서 비우면 수집이 끝난 뒤 전부 다시 발송된다. 쿨다운이 지난 항목은 어차피 재발송 대상이라 버린다.
  for (const [k, r] of restored) {
    if (firing.has(k) || now - (r.lastNotified || 0) >= cooldownMs) { restored.delete(k); changed = true; }
  }
  if (changed) saveAlertStateSoon();
}

export function alertStatus() {
  const cfg = loadAlertConfig();
  return {
    config: cfg,
    firing: [...firing.values()].map((s) => ({ ...s.alert, since: new Date(s.since).toISOString() })),
    recent: recent.slice(0, 100),
    engineOn: !!timer,
  };
}

export const ALERT_INTERVAL_MAX_SEC = 86_400;

export function startAlertEngine() {
  const cfg = loadAlertConfig();
  const iv = Math.min(ALERT_INTERVAL_MAX_SEC, Math.max(15, cfg.intervalSec || 60)) * 1000;
  setTimeout(() => tick().catch(() => {}), 8000).unref?.();
  timer = setInterval(() => tick().catch(() => {}), iv);
  timer.unref?.();
  console.log(`[alerts] engine started (every ${Math.round(iv / 1000)}s)`);
}

/** 설정 저장 시 평가 주기를 즉시 재적용(엔진이 켜져 있을 때만). */
function rescheduleAlertEngine() {
  if (!timer) return;
  clearInterval(timer);
  const iv = Math.min(ALERT_INTERVAL_MAX_SEC, Math.max(15, loadAlertConfig().intervalSec || 60)) * 1000;
  timer = setInterval(() => tick().catch(() => {}), iv);
  timer.unref?.();
}

/** Send a test notification to verify channel config. */
export async function testAlert(user) {
  const res = await notify({ key: 'test', severity: 'warning', title: '테스트 알림', detail: `${user || ''} · ${new Date().toLocaleString()}` });
  logAudit({ user: user || 'unknown', action: '알림 테스트 발송', detail: res.join(', ') });
  return { ok: res.some((r) => /:(2\d\d|ok)\b/.test(r)) || res.length === 0, results: res }; // v2.479: 메일 결과 'email:ok' 인식(코어 B-9)
}
