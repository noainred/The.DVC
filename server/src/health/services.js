/**
 * 다빈치 서비스 점검 — 포탈 내부 서비스/수집기의 상태를 한 번에 집계한다(빠르고 비차단).
 * 각 항목: { key, label, status:'ok'|'warn'|'down'|'off', detail, at }.
 * 모든 점검은 try/catch로 격리되어 하나가 실패해도 전체 패널이 죽지 않는다.
 */

import { store } from '../store.js';
import { alertStatus } from '../alerts.js';
import { metricsSamplerStatus } from '../metrics/sampler.js';
import { gpuGuestStatus } from '../gpu/poller.js';
import { scanStatus } from '../ipam/scanPoller.js';
import { backupStatus } from '../backup/settings.js';
import { upgradeManager } from '../upgrade/manager.js';
import { nsxStore } from '../nsx/store.js';
import { allCollectorStatus } from '../collector/state.js';
import { listInventory } from '../central/inventory.js';
import { listAgentConfigs } from '../central/agentConfig.js';
import { getAllGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { loadLlmConfig } from '../llm/config.js';

const MIN = 60_000;
const ago = (ts) => (ts ? Date.now() - ts : null);
const wrap = (key, label, fn) => { try { return { key, label, ...fn() }; } catch (e) { return { key, label, status: 'warn', detail: `점검 오류: ${e.message}`, at: Date.now() }; } };

export function getServiceCheck() {
  const checks = [];

  checks.push(wrap('api', '중앙 API', () => ({ status: 'ok', detail: `응답 정상 · v${upgradeManager.status().version}`, at: Date.now() })));

  checks.push(wrap('vcenter', 'vCenter 수집', () => {
    const s = store.get();
    const total = (s.vcenters || []).length;
    const conn = (s.vcenters || []).filter((v) => v.status === 'connected').length;
    const age = ago(Date.parse(s.generatedAt));
    const stale = age != null && age > 5 * MIN;
    const status = total === 0 ? 'off' : conn === 0 ? 'down' : (conn < total || stale) ? 'warn' : 'ok';
    return { status, detail: `${conn}/${total} 연결${stale ? ' · 스냅샷 지연' : ''} · ${age != null ? Math.round(age / 1000) + '초 전' : '-'}`, at: Date.parse(s.generatedAt) || Date.now() };
  }));

  checks.push(wrap('nsx', 'NSX 수집', () => {
    const snap = nsxStore.get();
    const ms = snap.managers || [];
    if (!ms.length) return { status: 'off', detail: 'NSX 매니저 미등록', at: Date.now() };
    const down = ms.filter((m) => m.status === 'unreachable').length;
    return { status: down ? 'warn' : 'ok', detail: `매니저 ${ms.length} · 불가 ${down} · 세그먼트 ${(snap.segments || []).length}`, at: Date.parse(snap.generatedAt) || Date.now() };
  }));

  checks.push(wrap('power', '전력 수집(iDRAC/OME)', () => {
    const r = store.get().rollups || {};
    const cols = Object.values(allCollectorStatus() || {});
    const reporting = r.powerReporting || 0;
    return { status: (reporting || cols.length) ? 'ok' : 'off', detail: `측정 호스트 ${reporting} · 원격 수집기 ${cols.length}`, at: Date.now() };
  }));

  checks.push(wrap('metrics', '지표 샘플러', () => {
    const m = metricsSamplerStatus();
    const age = ago(m.lastRun);
    return { status: m.enabled === false ? 'off' : (age != null && age > 30 * MIN) ? 'warn' : 'ok', detail: `${m.enabled === false ? '비활성' : '활성'}${m.lastRun ? ` · 최근 ${Math.round(ago(m.lastRun) / MIN)}분 전` : ''}`, at: m.lastRun || Date.now() };
  }));

  checks.push(wrap('gpu-guest', 'GPU 게스트 수집', () => {
    const g = gpuGuestStatus();
    const ov = g.overlay || {};
    return { status: !g.enabled ? 'off' : 'ok', detail: `${g.enabled ? '활성' : '비활성'} · 대상 vCenter ${g.monitored ?? '-'} · 오버레이 호스트 ${ov.hosts ?? 0}/VM ${ov.vms ?? 0}`, at: g.lastRun || Date.now() };
  }));

  checks.push(wrap('ipscan', 'IP 스캔', () => {
    const s = scanStatus();
    return { status: s.enabled === false ? 'off' : 'ok', detail: `${s.enabled === false ? '비활성' : '활성'}${s.lastRun ? ` · 최근 ${Math.round(ago(s.lastRun) / MIN)}분 전` : ''}`, at: s.lastRun || Date.now() };
  }));

  checks.push(wrap('alerts', '알림 엔진', () => {
    const a = alertStatus();
    const ch = a.config?.channels || {};
    const chOn = !!(ch.slack?.enabled || ch.webhook?.enabled);
    return { status: a.engineOn === false ? 'off' : (a.firing || []).length ? 'warn' : 'ok', detail: `${a.engineOn === false ? '꺼짐' : '동작'} · 진행중 ${(a.firing || []).length} · 채널 ${chOn ? 'ON' : 'OFF'}`, at: Date.now() };
  }));

  checks.push(wrap('upgrade', '업그레이드 매니저', () => {
    const u = upgradeManager.status();
    return { status: 'ok', detail: `현재 v${u.version}${u.remoteConfigured ? ' · 원격소스 설정됨' : ' · 로컬'}${u.lastCheck ? ` · 점검 ${Math.round(ago(u.lastCheck) / MIN)}분 전` : ''}`, at: u.lastCheck || Date.now() };
  }));

  checks.push(wrap('backup', '포탈 백업', () => {
    const b = backupStatus();
    return { status: 'ok', detail: `정기 ${b.scheduleActive ? 'ON' : 'OFF'} · 변경감시 ${b.watching ? 'ON' : 'OFF'}${b.lastRun ? ` · 최근 ${Math.round(ago(b.lastRun.at) / MIN)}분 전` : ' · 백업 없음'}`, at: b.lastRun?.at || Date.now() };
  }));

  checks.push(wrap('edges', '엣지 포탈(에이전트)', () => {
    const inv = listInventory();
    const diag = getAllGpuGuestDiag();
    const cfg = listAgentConfigs();
    const agents = new Set([...inv.map((x) => x.agent).filter(Boolean), ...diag.map((x) => x.agent), ...cfg.map((x) => x.agent)]);
    if (!agents.size) return { status: 'off', detail: '연결된 엣지 없음', at: Date.now() };
    const freshest = Math.max(0, ...inv.map((x) => x.at || 0), ...cfg.map((x) => x.at || 0));
    const stale = freshest && ago(freshest) > 15 * MIN;
    return { status: stale ? 'warn' : 'ok', detail: `${agents.size}개 엣지${freshest ? ` · 최근 push ${Math.round(ago(freshest) / MIN)}분 전` : ''}`, at: freshest || Date.now() };
  }));

  checks.push(wrap('collectors', '원격 수집기', () => {
    const cols = Object.entries(allCollectorStatus() || {});
    if (!cols.length) return { status: 'off', detail: '원격 수집기 없음', at: Date.now() };
    return { status: 'ok', detail: `${cols.length}개`, at: Date.now() };
  }));

  checks.push(wrap('llm', 'AI(LLM)', () => {
    const c = loadLlmConfig();
    return { status: c.enabled ? 'ok' : 'off', detail: c.enabled ? `${c.provider} · ${c.model}` : '비활성(AI 검색/ChatOps 규칙기반)', at: Date.now() };
  }));

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    down: checks.filter((c) => c.status === 'down').length,
    off: checks.filter((c) => c.status === 'off').length,
    total: checks.length,
  };
  const overall = summary.down ? 'down' : summary.warn ? 'warn' : 'ok';
  return { overall, summary, checks, generatedAt: Date.now() };
}
