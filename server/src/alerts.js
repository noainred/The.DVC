/**
 * Alerting — evaluates threshold/condition rules against the current snapshot on
 * an interval and pushes notifications to Slack(incoming webhook) and/or a
 * generic Webhook(JSON POST). Dependency-free (HTTP via fetch). Email은 SMTP
 * 라이브러리가 필요하므로 현재는 webhook 경유를 권장(추후 옵션).
 *
 * Config: CONFIG_DIR/alerts.json. Fires on a condition becoming active (new),
 * re-notifies after cooldown while still active, and notes resolution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { logAudit } from './audit.js';

const FILE = path.join(config.configDir, 'alerts.json');

const DEFAULTS = {
  channels: {
    slack: { enabled: false, url: '' },
    webhook: { enabled: false, url: '' },
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
};

let cache = null;
export function loadAlertConfig() {
  if (cache) return cache;
  cache = structuredClone(DEFAULTS);
  try {
    if (fs.existsSync(FILE)) {
      const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = {
        channels: { slack: { ...DEFAULTS.channels.slack, ...s.channels?.slack }, webhook: { ...DEFAULTS.channels.webhook, ...s.channels?.webhook } },
        rules: { ...DEFAULTS.rules, ...(s.rules || {}) },
        cooldownMin: s.cooldownMin ?? DEFAULTS.cooldownMin,
        intervalSec: s.intervalSec ?? DEFAULTS.intervalSec,
      };
    }
  } catch { /* defaults */ }
  return cache;
}
export function saveAlertConfig(body = {}) {
  const cur = loadAlertConfig();
  const next = {
    channels: {
      slack: { enabled: !!body.channels?.slack?.enabled, url: body.channels?.slack?.url ?? cur.channels.slack.url },
      webhook: { enabled: !!body.channels?.webhook?.enabled, url: body.channels?.webhook?.url ?? cur.channels.webhook.url },
    },
    rules: { ...cur.rules, ...(body.rules || {}) },
    cooldownMin: Math.max(1, Number(body.cooldownMin) || cur.cooldownMin),
    intervalSec: Math.max(15, Number(body.intervalSec) || cur.intervalSec),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

/** Evaluate rules against a snapshot → array of { key, severity, title, detail }. */
export function evaluate(snap, cfg = loadAlertConfig()) {
  const out = [];
  const R = cfg.rules;
  if (R.criticalAlarms?.enabled) {
    for (const a of (snap.alarms || []).filter((x) => x.severity === 'critical').slice(0, 100)) {
      out.push({ key: `alarm:${a.id || a.name}`, severity: 'critical', title: `위험 알람: ${a.name || a.entity || ''}`, detail: `${a.vcenterId || ''} ${a.entity || ''} ${a.status || ''}`.trim() });
    }
  }
  if (R.vcenterDown?.enabled) {
    for (const v of (snap.vcenters || []).filter((x) => x.status === 'unreachable')) {
      out.push({ key: `vc:${v.id}`, severity: 'critical', title: `vCenter 수집 실패: ${v.name || v.id}`, detail: v.error || '연결 불가' });
    }
  }
  if (R.hostDisconnected?.enabled) {
    for (const h of (snap.hosts || []).filter((x) => x.connectionState === 'DISCONNECTED').slice(0, 100)) {
      out.push({ key: `host:${h.id}`, severity: 'warning', title: `호스트 연결 끊김: ${h.name}`, detail: `${h.vcenterId} / ${h.cluster || ''}` });
    }
  }
  if (R.datastorePct?.enabled) {
    const th = Number(R.datastorePct.threshold) || 90;
    for (const d of (snap.datastores || []).filter((x) => (x.usagePct || 0) >= th).slice(0, 200)) {
      out.push({ key: `ds:${d.id}`, severity: d.usagePct >= 95 ? 'critical' : 'warning', title: `데이터스토어 용량 ${d.usagePct}%: ${d.name}`, detail: `${d.vcenterId} · 여유 ${d.freeGB}GB` });
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
  for (const v of snap.vms || []) { if (!v.template) prev.set(v.id, v.powerState); }
  return prev;
}

async function post(url, payload) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
}
export async function notify(alert, cfg = loadAlertConfig()) {
  const text = `[${alert.severity === 'critical' ? '🔴 위험' : '🟠 경고'}] ${alert.title}${alert.detail ? `\n${alert.detail}` : ''}`;
  const results = [];
  if (cfg.channels.slack?.enabled && cfg.channels.slack.url) {
    try { const r = await post(cfg.channels.slack.url, { text }); results.push(`slack:${r.status}`); } catch (e) { results.push(`slack:err ${e.message}`); }
  }
  if (cfg.channels.webhook?.enabled && cfg.channels.webhook.url) {
    try { const r = await post(cfg.channels.webhook.url, { source: 'vmware-portal', ...alert, text, at: new Date().toISOString() }); results.push(`webhook:${r.status}`); } catch (e) { results.push(`webhook:err ${e.message}`); }
  }
  return results;
}

// --- Engine state ---
const firing = new Map();   // key -> { alert, since, lastNotified }
const recent = [];          // recent notifications (in-memory, newest first)
let timer = null;
let vmPowerPrev = null;      // vmId -> powerState (직전 스냅샷, 동시 다운 감지용)

function pushRecent(entry) { recent.unshift(entry); if (recent.length > 200) recent.pop(); }

async function tick() {
  const cfg = loadAlertConfig();
  if (!cfg.channels.slack?.enabled && !cfg.channels.webhook?.enabled) { // still track state for UI
    refreshState(cfg, false);
    return;
  }
  await refreshState(cfg, true);
}

async function refreshState(cfg, sendEnabled) {
  let active = [];
  const snap = store.get();
  try { active = evaluate(snap, cfg); } catch { active = []; }
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
  for (const a of active) {
    seen.add(a.key);
    const prev = firing.get(a.key);
    if (!prev) {
      firing.set(a.key, { alert: a, since: now, lastNotified: 0 });
    }
    const st = firing.get(a.key);
    st.alert = a;
    if (sendEnabled && now - (st.lastNotified || 0) >= cooldownMs) {
      st.lastNotified = now;
      notify(a, cfg).then((res) => { pushRecent({ at: new Date().toISOString(), ...a, channels: res }); }).catch(() => {});
    }
  }
  // resolve
  for (const [key, st] of [...firing.entries()]) {
    if (!seen.has(key)) { firing.delete(key); pushRecent({ at: new Date().toISOString(), key, title: `해소: ${st.alert.title}`, severity: 'resolved' }); }
  }
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

export function startAlertEngine() {
  const cfg = loadAlertConfig();
  const iv = Math.max(15, cfg.intervalSec || 60) * 1000;
  setTimeout(() => tick().catch(() => {}), 8000).unref?.();
  timer = setInterval(() => tick().catch(() => {}), iv);
  timer.unref?.();
  console.log(`[alerts] engine started (every ${Math.round(iv / 1000)}s)`);
}

/** Send a test notification to verify channel config. */
export async function testAlert(user) {
  const res = await notify({ key: 'test', severity: 'warning', title: '테스트 알림', detail: `${user || ''} · ${new Date().toLocaleString()}` });
  logAudit({ user: user || 'unknown', action: '알림 테스트 발송', detail: res.join(', ') });
  return { ok: res.some((r) => /:(2\d\d)/.test(r)) || res.length === 0, results: res };
}
