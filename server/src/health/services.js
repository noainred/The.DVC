/**
 * 다빈치 서비스 점검 — 포탈 내부 서비스/수집기의 상태를 한 번에 집계한다(빠르고 비차단).
 * v2.613 RUNTIME2613-01: 고정 항목 + `edgelog/spec.js` 의 `collect.*` 폴러 전부(+ 중앙 전용 2개). `coverage` 가 무엇을 보고
 *   무엇을 안 보는지(push/pull 워커) 말한다.
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
import { STATUS_SPEC } from '../edgelog/spec.js';
import { config } from '../config.js';
/*
 * v2.613 RUNTIME2613-01: 점검 대상 폴러를 손으로 적지 않는다 — `edgelog/spec.js STATUS_SPEC` 의 `collect.*` 항목이
 *   곧 목록이고, 아래 `MODS` 는 그 표의 `mod` 경로 → 모듈 네임스페이스 대응표다(전부 index.js 가 부팅에 import 하는
 *   모듈이라 정적 import 로 새 타이머가 켜지지 않는다). v2.612 까지는 고정 13항목이라 CVP·bmusage·통신 점검·현재 사용자·
 *   Horizon·SAN·PDU·스토리지 폴러가 멈춰도 `overall:'ok'` 였다(v2.590 W1 '샘플러가 멈춰도 정상' 의 형제 26개).
 *   ⚠ `getServiceCheck()` 는 **동기**다(소비처 `routes/api/checksLogs.js` 가 그대로 res.json 한다) — 그래서 동적 import
 *     가 아니라 정적 import 이고, 표에 새 `collect.*` 항목이 생겼는데 여기 대응표에 없으면 그 행은 `warn`(점검 미구현)으로
 *     드러나며 `test/audit2613g.test.js` 가 spec ⊆ MODS 를 고정한다(조용히 빠지지 않는다).
 */
import * as m_store from '../store.js';
import * as m_storagePoller from '../storage/poller.js';
import * as m_sanPoller from '../sanswitch/poller.js';
import * as m_sanPerfPoller from '../sanswitch/perfPoller.js';
import * as m_cvpPoller from '../cvp/poller.js';
import * as m_pduPoller from '../pdu/poller.js';
import * as m_curUserPoller from '../curuser/poller.js';
import * as m_hzPoller from '../horizon/sessionPoller.js';
import * as m_vmSeriesPoller from '../vmseries/poller.js';
import * as m_vmtrackPoller from '../vmtrack/poller.js';
import * as m_guestDiskPoller from '../guestdisk/poller.js';
import * as m_bmstorPoller from '../bmstor/poller.js';
import * as m_metricsSampler from '../metrics/sampler.js';
import * as m_ipamScanPoller from '../ipam/scanPoller.js';
import * as m_osScanner from '../inventory/osScanner.js';
import * as m_idracScanWorker from '../agent/idracScanWorker.js';
import * as m_ipScanWorker from '../agent/ipScanWorker.js';
import * as m_agentScanner from '../agent/scanner.js';
import * as m_bmUsagePoller from '../bmusage/poller.js';
import * as m_linkCheckPoller from '../linkcheck/poller.js';
import * as m_gpuPhysicalPoller from '../gpu/physicalPoller.js';
import * as m_dirUsageScheduler from '../dirusage/scheduler.js';
import * as m_gpuPoller from '../gpu/poller.js';
import * as m_idracPoller from '../idrac/poller.js';
import * as m_idracScanPoller from '../idrac/scanPoller.js';
import * as m_powerOffPoller from '../tools/powerOffPoller.js';
import * as m_vmCloneScheduler from '../vmclone/scheduler.js';
import * as m_logsPoller from '../logs/poller.js';
import * as m_capacitySampler from '../capacity/sampler.js';
import * as m_certMonitor from '../security/certMonitor.js';
import * as m_relayCheckPoller from '../relaycheck/poller.js';
import * as m_partFaultPoller from '../partfault/poller.js';
import { stallWatchStatus } from '../perf/stallWatch.js';

/** spec `mod` 경로 → 모듈. 표에 새 모듈이 생기면 여기에 한 줄 더한다(테스트가 빠진 것을 잡는다). */
const MODS = Object.freeze({
  '../store.js': m_store,
  '../storage/poller.js': m_storagePoller,
  '../sanswitch/poller.js': m_sanPoller,
  '../sanswitch/perfPoller.js': m_sanPerfPoller,
  '../cvp/poller.js': m_cvpPoller,
  '../pdu/poller.js': m_pduPoller,
  '../curuser/poller.js': m_curUserPoller,
  '../horizon/sessionPoller.js': m_hzPoller,
  '../vmseries/poller.js': m_vmSeriesPoller,
  '../vmtrack/poller.js': m_vmtrackPoller,
  '../guestdisk/poller.js': m_guestDiskPoller,
  '../bmstor/poller.js': m_bmstorPoller,
  '../metrics/sampler.js': m_metricsSampler,
  '../ipam/scanPoller.js': m_ipamScanPoller,
  '../inventory/osScanner.js': m_osScanner,
  '../agent/idracScanWorker.js': m_idracScanWorker,
  '../agent/ipScanWorker.js': m_ipScanWorker,
  '../agent/scanner.js': m_agentScanner,
  '../bmusage/poller.js': m_bmUsagePoller,
  '../linkcheck/poller.js': m_linkCheckPoller,
  '../gpu/physicalPoller.js': m_gpuPhysicalPoller,
  '../dirusage/scheduler.js': m_dirUsageScheduler,
  '../gpu/poller.js': m_gpuPoller,
  '../idrac/poller.js': m_idracPoller,
  '../idrac/scanPoller.js': m_idracScanPoller,
  '../tools/powerOffPoller.js': m_powerOffPoller,
  '../vmclone/scheduler.js': m_vmCloneScheduler,
  '../logs/poller.js': m_logsPoller,
  '../capacity/sampler.js': m_capacitySampler,
  '../security/certMonitor.js': m_certMonitor,
  '../relaycheck/poller.js': m_relayCheckPoller,
  '../partfault/poller.js': m_partFaultPoller,
});

/**
 * 중앙 전용 폴러 — spec.js 는 엣지 화면용이라 이 둘을 **일부러** 뺐다(머리말: relaycheck 는 역할별 축약을 거쳐야 하고,
 * partfault 판정은 중앙만 돈다). 여기서는 상태 **문구**(켜짐·경과)만 만들고 응답 객체를 싣지 않으므로 그 축약 규칙과
 * 충돌하지 않는다. 엣지 노드(CENTRAL_URL 있음)에서는 행을 만들지 않는다 — '꺼짐' 잡음이 화면을 채운다.
 */
export const CENTRAL_ONLY_SPEC = Object.freeze([
  { key: 'collect.relayCheck', label: 'HAProxy 경로 점검', group: 'collect', mod: '../relaycheck/poller.js', fn: 'relayCheckStatus', centralOnly: true },
  { key: 'collect.partFault', label: '파트 장애 판정', group: 'collect', mod: '../partfault/poller.js', fn: 'partFaultStatus', centralOnly: true },
]);

/** 고정 항목이 이미 다루는 spec 키 — 같은 폴러를 두 줄로 그리지 않는다(고정 항목 쪽에 `specKey` 를 단다). */
const FIXED_SPEC_KEY = Object.freeze({ vcenter: 'collect.inventory', metrics: 'collect.metrics', 'gpu-guest': 'collect.gpuGuest', ipscan: 'collect.ipamScan' });

const MIN = 60_000;
const ago = (ts) => (ts ? Date.now() - ts : null);
// v2.590 W1: 폴러 상태의 lastRun/lastCheck 는 epoch 숫자가 아니라 `{ at, … }` 객체다(metrics/sampler·ipam/scanPoller·
// gpu/poller·upgrade/manager). 숫자로 빼면 NaN 이 되어 화면이 'NaN분 전' 을 말했고, 더 나쁘게는 `NaN > 30분` 이 항상 거짓이라
// **지표 샘플러가 멈춰도 '정상'** 이었다. 두 형태를 다 받고, 모르면 null(단정하지 않는다).
const atOf = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : (x && typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : null));
const wrap = (key, label, fn) => { try { return { key, label, ...fn() }; } catch (e) { return { key, label, status: 'warn', detail: `점검 오류: ${e.message}`, at: Date.now() }; } };

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
/** 폴러 상태 객체에서 '마지막 실행 시각' — 모듈마다 이름이 다르다(at · last.at · lastRun(.at) · lastRunTs · lastRunAt · lastTickAt · lastPollAt · lastTick). */
export function pollerLastAt(st) {
  if (!st || typeof st !== 'object') return null;
  const cands = [atOf(st.last), atOf(st.lastRun), atOf(st.lastResult), st.lastRunTs, st.lastRunAt, st.at, st.lastTickAt, st.lastPollAt, st.lastTick];
  for (const c of cands) { const v = finite(c); if (v) return v; }
  return null;
}
/** 폴러 주기(ms) — intervalMs · pollIntervalMs · tickMs · pollMs · intervalMinutes · settings.intervalMs. 모르면 null. */
export function pollerIntervalMs(st) {
  if (!st || typeof st !== 'object') return null;
  return finite(st.intervalMs) ?? finite(st.pollIntervalMs) ?? finite(st.tickMs) ?? finite(st.pollMs) ?? finite(st.settings?.intervalMs)
    ?? (finite(st.intervalMinutes) ? st.intervalMinutes * MIN : null) ?? (finite(st.settings?.pollIntervalMin) ? st.settings.pollIntervalMin * MIN : null);
}
/** 꺼짐 판정 — `enabled:false` 또는 `settings.enabled:false`. 필드가 없으면 켜진 것으로 본다(상시 폴러). */
export function pollerEnabled(st) {
  if (!st || typeof st !== 'object') return true;
  if (st.enabled === false) return false;
  if (st.settings && typeof st.settings === 'object' && st.settings.enabled === false) return false;
  return true;
}
/**
 * 공통 판정(순수 — now·uptimeMs 주입). 반환 { status, detail, at }.
 *  · 꺼짐 → off · 실행 중 표시 · 마지막 실행이 `max(30분, 주기×2)` 보다 오래됐으면 warn(v2.591 R-H1 과 같은 경계)
 *  · 실행 기록이 없는데 기동 후 그 경계를 넘겼으면 warn(v2.590 W1 — '한 번도 안 돌았다' 를 정상으로 칠하지 않는다)
 */
export function pollerCheck(st, { now = Date.now(), uptimeMs = process.uptime() * 1000 } = {}) {
  if (!pollerEnabled(st)) return { status: 'off', detail: '비활성(설정에서 꺼짐)', at: now };
  const running = !!(st && (st.running || st.busy || st.refreshing));
  const last = pollerLastAt(st);
  const iv = pollerIntervalMs(st);
  const staleMs = Math.max(30 * MIN, iv ? iv * 2 : 0);
  const ivText = iv ? ` · 주기 ${iv < MIN ? `${Math.round(iv / 1000)}초` : `${Math.round(iv / MIN)}분`}` : '';
  if (last == null) {
    const long = uptimeMs > staleMs;
    return { status: long ? 'warn' : 'ok', detail: `${running ? '실행 중' : '활성'} · 실행 기록 없음(기동 ${Math.round(uptimeMs / MIN)}분)${long ? ' — 경계를 넘겼는데 한 번도 돌지 않았습니다' : ''}${ivText}`, at: now };
  }
  const age = now - last;
  const stale = age > staleMs;
  return { status: stale ? 'warn' : 'ok', detail: `${running ? '실행 중' : '활성'} · 최근 ${Math.round(age / MIN)}분 전${stale ? ' — 주기의 2배를 넘겼습니다' : ''}${ivText}`, at: last };
}

/*
 * 비동기 상태 함수(partFaultStatus 처럼 DB 를 읽는 것)는 동기 경로에서 기다릴 수 없다 — 마지막으로 받은 값을 캐시하고
 * 호출마다 갱신을 **띄워 둔다**(다음 조회에 반영). 첫 조회는 '상태 조회 중' 이라고 말한다(추측하지 않는다).
 */
const _asyncCache = new Map(); // key -> { at, value }
const _asyncPending = new Set();
function readStatus(key, fn) {
  const r = fn();
  if (!r || typeof r.then !== 'function') return { value: r, pending: false };
  if (!_asyncPending.has(key)) {
    _asyncPending.add(key);
    Promise.resolve(r).then((v) => { _asyncCache.set(key, { at: Date.now(), value: v }); }, () => {}).finally(() => _asyncPending.delete(key));
  }
  const c = _asyncCache.get(key);
  return c ? { value: c.value, pending: false, cachedAt: c.at } : { value: null, pending: true };
}
export function _resetAsyncStatusCacheForTest() { _asyncCache.clear(); _asyncPending.clear(); }

/** spec 한 줄 → 점검 행. 대응표에 없는 모듈·함수는 warn(점검 미구현)으로 드러난다. */
function specRow(spec, opts) {
  return wrap(spec.key, spec.label, () => {
    const mod = MODS[spec.mod];
    const fn = mod && mod[spec.fn];
    if (typeof fn !== 'function') return { status: 'warn', detail: `점검 미구현 — ${spec.mod} ${spec.fn}() 이 대응표(MODS)에 없습니다`, at: Date.now() };
    const { value, pending } = readStatus(spec.key, fn);
    if (pending) return { status: 'ok', detail: '상태 조회 중(비동기 상태 함수) — 다음 조회에 반영됩니다', at: Date.now(), pendingAsync: true };
    return pollerCheck(value, opts);
  });
}

export function getServiceCheck(opts = {}) {
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

  // v2.617: 메인 이벤트 루프 멈춤 감시(perf/stallWatch.js). 이 행은 루프가 **풀린 뒤에** 읽히므로 '지금 멈춤' 이 아니라
  //   '최근에 멈춘 적이 있다' 를 말한다. 멈춘 동안의 기록(스택 포함)은 journal 의 [stallwatch] 줄에 있다.
  checks.push(wrap('stallwatch', '이벤트 루프 멈춤 감시', () => {
    const w = stallWatchStatus();
    if (!w.enabled) return { status: 'off', detail: w.error ? `꺼짐 — ${w.error}` : '꺼짐(STALL_WATCH=0)', at: Date.now() };
    const l = w.last;
    const recent = l && Date.now() - l.at < 24 * 60 * MIN;
    const heap = w.heapWarns ? ` · 힙 한계 근접 경고 ${w.heapWarns}회` : '';
    if (!l) return { status: w.heapWarns ? 'warn' : 'ok', detail: `기동 후 멈춤 없음(경계 ${Math.round(w.stallMs / 1000)}초)${heap}`, at: Date.now() };
    const dur = l.durMs == null ? '지속 시간 미상' : `${Math.round(l.durMs / 1000)}초`;
    // v2.617(SEC-2): 스택 프레임에는 설치 절대 경로·소스 줄이 들어 있다 — 관리자에게만 싣는다(operator 는 tools 를 기본 보유).
    const where = Array.isArray(l.frames) && l.frames.length
      ? (opts.isAdmin ? ` · 멈춘 지점 ${l.frames[0]}` : ' · 멈춘 지점은 관리자에게만 표시')
      : (l.error ? ' · 스택 없음(GC·네이티브 호출 가능성)' : '');
    return { status: recent ? 'warn' : 'ok', detail: `멈춤 ${w.stalls}회 · 최근 ${Math.round((Date.now() - l.at) / MIN)}분 전 ${dur}${where}${heap} — journal 의 [stallwatch] 줄에 전체 스택`, at: l.at };
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
    const last = atOf(m.lastRun);
    const age = last == null ? null : ago(last);
    // v2.591(3차 감사 R-H1): 정체 경계는 **설정된 샘플 주기의 2배**(최소 30분). 30분 고정이면 주기를 60분으로 둔 현장에서
    // 멀쩡한 샘플러가 매번 '주의' 가 된다(v2.590 atOf 수정 전에는 NaN 이라 경고 자체가 안 났다 — 수정이 새 거짓을 만들었다).
    const iv = Number(m.intervalMs);
    const staleMs = Math.max(30 * MIN, Number.isFinite(iv) && iv > 0 ? iv * 2 : 0);
    return { status: m.enabled === false ? 'off' : (age != null && age > staleMs) ? 'warn' : 'ok', detail: `${m.enabled === false ? '비활성' : '활성'}${last != null ? ` · 최근 ${Math.round(age / MIN)}분 전` : ''}`, at: last ?? Date.now() };
  }));

  checks.push(wrap('gpu-guest', 'GPU 게스트 수집', () => {
    const g = gpuGuestStatus();
    const ov = g.overlay || {};
    return { status: !g.enabled ? 'off' : 'ok', detail: `${g.enabled ? '활성' : '비활성'} · 대상 vCenter ${g.monitored ?? '-'} · 오버레이 호스트 ${ov.hosts ?? 0}/VM ${ov.vms ?? 0}`, at: atOf(g.lastRun) ?? Date.now() };
  }));

  checks.push(wrap('ipscan', 'IP 스캔', () => {
    const s = scanStatus();
    const last = atOf(s.lastRun);
    return { status: s.enabled === false ? 'off' : 'ok', detail: `${s.enabled === false ? '비활성' : '활성'}${last != null ? ` · 최근 ${Math.round(ago(last) / MIN)}분 전` : ''}`, at: last ?? Date.now() };
  }));

  checks.push(wrap('alerts', '알림 엔진', () => {
    const a = alertStatus();
    const ch = a.config?.channels || {};
    const chOn = !!(ch.slack?.enabled || ch.webhook?.enabled);
    return { status: a.engineOn === false ? 'off' : (a.firing || []).length ? 'warn' : 'ok', detail: `${a.engineOn === false ? '꺼짐' : '동작'} · 진행중 ${(a.firing || []).length} · 채널 ${chOn ? 'ON' : 'OFF'}`, at: Date.now() };
  }));

  checks.push(wrap('upgrade', '업그레이드 매니저', () => {
    const u = upgradeManager.status();
    const last = atOf(u.lastCheck);
    return { status: 'ok', detail: `현재 v${u.version}${u.remoteConfigured ? ' · 원격소스 설정됨' : ' · 로컬'}${last != null ? ` · 점검 ${Math.round(ago(last) / MIN)}분 전` : ''}`, at: last ?? Date.now() };
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

  // v2.613 RUNTIME2613-01: 고정 항목이 이미 다루는 폴러에는 spec 키를 단다(같은 폴러를 두 줄로 그리지 않는다).
  for (const c of checks) if (FIXED_SPEC_KEY[c.key]) c.specKey = FIXED_SPEC_KEY[c.key];
  const covered = new Set(Object.values(FIXED_SPEC_KEY));
  const isEdge = !!config.agent?.centralUrl;
  const specs = [...STATUS_SPEC.filter((x) => x.group === 'collect'), ...CENTRAL_ONLY_SPEC];
  const skippedOnEdge = [];
  const fixedCount = checks.length;
  for (const spec of specs) {
    if (covered.has(spec.key)) continue;
    if (spec.centralOnly && isEdge) { skippedOnEdge.push(spec.key); continue; }
    checks.push({ ...specRow(spec, opts), specKey: spec.key });
  }
  const notCovered = STATUS_SPEC.filter((x) => x.group !== 'collect').map((x) => x.key);
  const coverage = {
    fixed: fixedCount,
    pollers: specs.length - skippedOnEdge.length,
    centralOnly: CENTRAL_ONLY_SPEC.map((x) => x.key),
    skippedOnEdge,
    // push/pull 워커는 이 화면의 대상이 아니다 — 엣지 로그 화면(특수기능 › 엣지 로그)이 그 상태를 보여 준다.
    notCovered,
    note: `점검 대상: 고정 항목 + 로컬 폴러 ${specs.length - skippedOnEdge.length}개(edgelog/spec.js collect.* + 중앙 전용 ${CENTRAL_ONLY_SPEC.length}개${skippedOnEdge.length ? ` — 엣지 노드라 ${skippedOnEdge.length}개 제외` : ''}). 대상 밖: push/pull 워커 ${notCovered.length}개(엣지 로그 화면에서 본다).`,
  };

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    down: checks.filter((c) => c.status === 'down').length,
    off: checks.filter((c) => c.status === 'off').length,
    total: checks.length,
  };
  const overall = summary.down ? 'down' : summary.warn ? 'warn' : 'ok';
  return { overall, summary, checks, coverage, generatedAt: Date.now() };
}
export { atOf as _atOf };
