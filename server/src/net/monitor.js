/**
 * 연속 네트워크 모니터링 — 두 서버 간 캡처를 주기적으로 자동 실행해 이력에 기록하고, 경로
 * 손실/미수신 등 이슈가 감지되면 알림을 보낸다. 모니터 정의는 CONFIG_DIR/capture-monitors.json
 * 에 보관(SSH 자격증명 포함, 0600). 중앙 직접 실행(사설망은 향후 에이전트 위임 확장).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runTrafficCapture, runDualCapture } from './tcpdump.js';
import { recordCapture } from './captureHistory.js';
import { notify } from '../alerts.js';

const FILE = path.join(config.configDir, 'capture-monitors.json');

let cache = null;
function load() {
  if (cache) return cache;
  cache = [];
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { cache = []; }
  return cache;
}
function persist() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 }); } catch { /* */ } }

const redact = (m) => ({
  id: m.id, name: m.name, enabled: m.enabled, mode: m.mode, intervalMin: m.intervalMin,
  iface: m.iface, seconds: m.seconds, maxPackets: m.maxPackets,
  hostA: m.hostA?.host || '', hostB: m.mode === 'dual' ? (m.hostB?.host || '') : (m.peer || ''),
  lastRun: m.lastRun || null, lastWorst: m.lastWorst || null, lastDetail: m.lastDetail || '',
});

export function listMonitors() { return load().map(redact); }

export function saveMonitor(body = {}) {
  load();
  const id = body.id || `mon_${Date.now().toString(36)}`;
  const m = {
    id, name: String(body.name || '무제 모니터').slice(0, 80),
    enabled: body.enabled !== false, mode: body.mode === 'dual' ? 'dual' : 'single',
    intervalMin: Math.max(1, Math.min(1440, Number(body.intervalMin) || 10)),
    iface: body.iface || 'any', seconds: Math.min(60, Math.max(1, Number(body.seconds) || 10)), maxPackets: Math.min(20000, Math.max(10, Number(body.maxPackets) || 1000)),
    hostA: body.hostA || {}, hostB: body.hostB || {}, peer: body.peer || '',
    useSudo: body.useSudo !== false,
    lastRun: null, lastWorst: null, lastDetail: '',
  };
  const idx = cache.findIndex((x) => x.id === id);
  if (idx >= 0) {
    const prev = cache[idx];
    // 자격증명: 목록은 creds를 노출하지 않으므로, 새 값이 비면 기존 유지(토글/수정 시 보존).
    const merge = (a = {}, b = {}) => ({ host: b.host || a.host, port: b.port || a.port, username: b.username || a.username, password: b.password || a.password, privateKey: b.privateKey || a.privateKey });
    m.hostA = merge(prev.hostA, body.hostA); m.hostB = merge(prev.hostB, body.hostB); m.peer = body.peer || prev.peer;
    m.lastRun = prev.lastRun; m.lastWorst = prev.lastWorst; m.lastDetail = prev.lastDetail;
    cache[idx] = m;
  } else cache.push(m);
  persist();
  return redact(m);
}

export function removeMonitor(id) { load(); const before = cache.length; cache = cache.filter((m) => m.id !== id); if (cache.length !== before) persist(); return before !== cache.length; }

async function runMonitor(m) {
  try {
    const opts = { iface: m.iface, seconds: m.seconds, maxPackets: m.maxPackets, useSudo: m.useSudo };
    const result = m.mode === 'dual'
      ? await runDualCapture({ hostA: m.hostA, hostB: m.hostB, ...opts })
      : await runTrafficCapture({ hostA: m.hostA, peer: String(m.peer).trim(), ...opts });
    const rec = recordCapture(result, { source: 'monitor', monitorName: m.name, via: 'central', hostA: m.hostA?.host, peer: m.peer });
    m.lastRun = Date.now(); m.lastWorst = rec.worst; m.lastDetail = (rec.issues[0]?.title) || '정상';
    persist();
    if (rec.worst !== 'ok') {
      notify({ key: `netmon:${m.id}`, severity: rec.worst === 'error' ? 'critical' : 'warning', title: `네트워크 모니터 '${m.name}' 이슈`, detail: `${m.hostA?.host} ↔ ${m.mode === 'dual' ? m.hostB?.host : m.peer}: ${rec.issues.map((i) => i.title).join(', ')}` }).catch(() => {});
    }
  } catch (e) {
    m.lastRun = Date.now(); m.lastWorst = 'error'; m.lastDetail = `실행 실패: ${e.message}`.slice(0, 120); persist();
  }
}

let timer = null;
export function startCaptureMonitor() {
  // 1분마다 점검, 각 모니터의 주기가 도래하면 실행.
  timer = setInterval(() => {
    const now = Date.now();
    for (const m of load()) {
      if (!m.enabled) continue;
      if (!m.lastRun || now - m.lastRun >= m.intervalMin * 60_000) runMonitor(m).catch(() => {});
    }
  }, 60_000);
  timer.unref?.();
  console.log('[netmon] 연속 네트워크 모니터 시작');
}

export async function runMonitorNow(id) { const m = load().find((x) => x.id === id); if (!m) return { ok: false, reason: '모니터 없음' }; await runMonitor(m); return { ok: true, ...redact(m) }; }
