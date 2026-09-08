/**
 * relaycheck/poller.js — HAProxy 경로 주기 점검(v2.429). CLAUDE.md 폴러 규약: 재진입 가드 + 동시 점검 제한 + 대상당 타임아웃 +
 * startAdaptiveTimer(설정 변경이 재시작 없이 먹음). 상태 전이(정상↔실패, 연속 failStreak 회)에 알림 채널 발화 + 해결방안 동봉.
 */
import { loadSettings, KINDS } from './settings.js';
import { runCheck } from './checks.js';
import { remedyFor } from './remedy.js';
import { loadCollectors } from '../collector/registry.js';
import { loadTopology } from '../relaytopo/store.js';        // 중계 토폴로지(v2.431) — 입력한 사이트도 점검 대상
import { kindForService } from '../relaytopo/validate.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { notify } from '../alerts.js';

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.RELAYCHECK_CONCURRENCY) || 4));
let _timer = null;
let _busy = false;
let _last = { at: 0, total: 0, ok: 0, fail: 0 };
const _state = new Map(); // `${host}:${port}` → { target, ok, phase, error, detail, ms, at, okStreak, failStreak, alerted, lastOkAt, lastFailAt, remedy }

/**
 * 점검 대상 생성(순수 — 테스트 고정). 수집 서버 URL 호스트(autoHosts) + 수동 호스트 × 프로파일. 포탈 종류는 같은 host:port 의
 * 수집 서버 항목에서 토큰·기대 이름을 붙인다. 중계 엣지(:4000 항목)의 이름은 relayAgent 로 넘겨 'IRS 포트가 자기에게 되돌아옴'을 판정.
 */
export function buildTargets(settings, collectors = [], topology = null) {
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } };
  const portOf = (u) => { try { const x = new URL(u); return Number(x.port) || (x.protocol === 'https:' ? 443 : 80); } catch { return 0; } };
  const cols = collectors.filter((c) => c.enabled !== false && c.url).map((c) => ({ ...c, _host: hostOf(c.url), _port: portOf(c.url) }));
  const hosts = new Map();
  if (settings.autoHosts) for (const c of cols) if (c._host) hosts.set(c._host, hosts.get(c._host) || c.datacenter || c.name || '');
  for (const h of settings.hosts || []) hosts.set(h.host, h.label || hosts.get(h.host) || '');
  // 중계 토폴로지(v2.431) 사이트: 중앙이 접속하는 Edge 주소(public 우선) + 그 사이트의 서비스 표에서 뽑은 포트 프로파일.
  const topoHosts = new Map(); const topoProfile = [];
  if (topology && settings.topologyHosts !== false) {
    const pp = topology.main?.portalPort || 4000;
    topoProfile.push({ port: pp, kind: 'edge-portal' });
    for (const s of topology.services || []) { const kind = s.enabled !== false && kindForService(s, topology.main); if (kind && !topoProfile.some((p) => p.port === s.listenPort)) topoProfile.push({ port: s.listenPort, kind, label: s.label }); }
    for (const site of topology.sites || []) { const h = site.edge?.publicIp || site.edge?.privateIp; if (h && !hosts.has(h)) { hosts.set(h, site.dc); topoHosts.set(h, site.dc); } }
  }
  const exclude = new Set(settings.exclude || []);
  const ids = cols.map((c) => c.id);
  const out = [];
  for (const [host, label] of hosts) {
    const relay = cols.find((c) => c._host === host && c._port === 4000);
    for (const p of (topoHosts.has(host) ? topoProfile : settings.profile)) {
      const key = `${host}:${p.port}`;
      if (exclude.has(key)) continue;
      const col = cols.find((c) => c._host === host && c._port === p.port);
      const t = { key, host, port: p.port, kind: p.kind, label: p.label || KINDS[p.kind]?.label || p.kind, site: label, collectorId: col?.id || '' };
      if (p.kind === 'edge-portal' || p.kind === 'irs-portal') {
        if (col) { t.token = col.token; t.expectAgent = col.id; t.otherIds = ids; }
        t.relayAgent = relay?.id || '';
      }
      out.push(t);
    }
  }
  return out;
}

async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (let n = it.next(); !n.done; n = it.next()) await fn(n.value); }));
}

/** 상태 전이 판정(순수): 이전 상태와 이번 결과로 알림 종류 반환 'fail'|'recover'|null. */
export function transition(prev, ok, failStreak) {
  const p = prev || { okStreak: 0, failStreak: 0, alerted: false };
  const next = { ...p, okStreak: ok ? p.okStreak + 1 : 0, failStreak: ok ? 0 : p.failStreak + 1 };
  let event = null;
  if (!ok && !p.alerted && next.failStreak >= failStreak) { next.alerted = true; event = 'fail'; }
  if (ok && p.alerted) { next.alerted = false; event = 'recover'; }
  return { next, event };
}

export async function runRelayChecks({ force = false } = {}) {
  const st = loadSettings();
  if (!force && !st.enabled) return { ok: false, reason: 'HAProxy 경로 점검이 꺼져 있습니다.' };
  if (_busy) return { ok: false, reason: '이전 점검 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  try {
    const targets = buildTargets(st, loadCollectors(), safeTopology());
    const seen = new Set();
    let okN = 0, failN = 0;
    await pool(targets, CONCURRENCY, async (t) => {
      seen.add(t.key);
      let r;
      try { r = await runCheck(t, { timeoutMs: st.timeoutMs }); } catch (e) { r = { ok: false, phase: 'unknown', error: e.message, ms: 0 }; }
      const prev = _state.get(t.key);
      const { next, event } = transition(prev, r.ok, st.failStreak);
      const remedy = r.ok ? null : remedyFor({ kind: t.kind, host: t.host, port: t.port, phase: r.phase, error: r.error, expect: { agent: t.expectAgent, relayAgent: t.relayAgent }, got: r.got || null });
      const now = Date.now();
      _state.set(t.key, { ...next, target: { key: t.key, host: t.host, port: t.port, kind: t.kind, label: t.label, site: t.site, collectorId: t.collectorId, expectAgent: t.expectAgent || '' },
        ok: r.ok, phase: r.ok ? 'ok' : (r.phase || 'unknown'), error: r.error || '', detail: r.detail || '', got: r.got || null, ms: r.ms || 0, at: now,
        lastOkAt: r.ok ? now : prev?.lastOkAt || null, lastFailAt: r.ok ? prev?.lastFailAt || null : now, remedy });
      if (r.ok) okN++; else failN++;
      if (event && st.alerts) {
        const key = `relaycheck:${t.key}`;
        if (event === 'fail') notify({ key, severity: 'critical', title: `[HAProxy 경로] ${t.site ? `${t.site} · ` : ''}${remedy.title}`, detail: `${remedy.cause}\n조치: ${remedy.steps.slice(0, 2).join(' / ')}` }).catch(() => {});
        else notify({ key: `${key}:ok`, severity: 'warning', title: `[HAProxy 경로] ${t.site ? `${t.site} · ` : ''}${t.label} ${t.host}:${t.port} 복구`, detail: r.detail || '' }).catch(() => {});
      }
    });
    for (const k of [..._state.keys()]) if (!seen.has(k)) _state.delete(k); // 대상에서 빠진 항목 정리
    _last = { at: Date.now(), total: targets.length, ok: okN, fail: failN, durationMs: Date.now() - t0 };
    return { ok: true, ..._last };
  } finally { _busy = false; }
}

function safeTopology() { try { return loadTopology(); } catch { return null; } }
export function relayCheckStatus() {
  const st = loadSettings();
  return { last: _last, busy: _busy, settings: st, results: [..._state.values()].sort((a, b) => (a.target.host + a.target.port).localeCompare(b.target.host + b.target.port, undefined, { numeric: true })), kinds: KINDS };
}

export function startRelayCheckPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(() => loadSettings().intervalMs, async () => { if (loadSettings().enabled) await runRelayChecks(); }, { firstDelayMs: 90_000, name: 'HAProxy 경로 점검' });
}
export function _resetForTest() { _state.clear(); _last = { at: 0, total: 0, ok: 0, fail: 0 }; }
