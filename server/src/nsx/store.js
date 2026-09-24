/**
 * In-memory NSX aggregator + poller. Mirrors the vCenter store design: each
 * NSX Manager is polled in parallel with a per-manager timeout so one slow/
 * high-RTT site (폴란드/미국동부 800ms+) never stalls the rest. The API reads
 * only from the cached snapshot, never blocking on a live call.
 */

import { config } from '../config.js';
import { getDataSource } from '../runtime-settings.js';
import { describeError } from '../util/errors.js';
import { loadRegistry } from './registry.js';
import { scopedNsxRollup } from './scope.js'; // v2.600: rollup 단일 소스(scope.js 는 import 가 없어 순환 없음)
import { collectFromNsx } from './client.js';
import { generateNsxSnapshot, generateNsxForManager } from './mock.js';
import { nsxAuthGuard, isNsxAuthError } from './client.js'; // v2.590: 인증 실패 정지(정의는 client.js — 순환 방지)
export { nsxAuthGuard };
import { pushAll } from '../util/pushAll.js';
const stopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);

class NsxStore {
  constructor() {
    this.snapshot = empty();
    this.cache = new Map();   // managerId -> { ok, data } | { ok:false, mgr, err, at }
    this.last = new Map();    // managerId -> last attempt (ms)
    this.timer = null;
  }

  /** scheduled 틱은 진행 중이면 스킵, 그 외(매니저 등록/수정 등 뮤테이션)는 완료 대기 후 1회 더 실행. */
  async refresh(opts = {}) {
    const scheduled = !!opts.scheduled;
    if (this._refreshing) {
      if (scheduled) return undefined; // 재진입 방지(이전 폴 진행 중이면 이번 틱 건너뜀)
      if (!this._forcePending) {
        this._forcePending = (async () => {
          try { await this._inflight; } catch { /* */ }
          this._forcePending = null;
          return this.refresh();
        })();
      }
      return this._forcePending;
    }
    this._refreshing = true;
    this._inflight = (async () => {
      try { return await this._refreshInner(); } finally { this._refreshing = false; this._inflight = null; }
    })();
    return this._inflight;
  }

  async _refreshInner() {
    const dataSource = getDataSource();
    const managers = loadRegistry();

    // Mock mode (or no managers registered yet) → synthesize a snapshot so the
    // dashboard is populated without a real NSX Manager.
    if (dataSource === 'mock' || managers.length === 0) {
      this.snapshot = rollup(merge(generateNsxSnapshot(managers), [], dataSource));
      return;
    }

    const now = Date.now();
    const globalMs = config.pollIntervalMs;
    const due = managers.filter((m) => {
      if (m.enabled === false) return false;
      // v2.590: 인증 실패로 멈춘 매니저는 주기 수집에서 건너뛴다(비밀번호를 고치면 credHash 로 자동 재개).
      if (nsxAuthGuard.authStopFor(m)) return false;
      const last = this.last.get(m.id) || 0;
      const intervalMs = m.pollIntervalSec > 0 ? m.pollIntervalSec * 1000 : globalMs;
      return now - last >= intervalMs - 500;
    });
    const results = await Promise.allSettled(due.map((m) => collectFromNsx(m)));
    results.forEach((r, i) => {
      const m = due[i];
      this.last.set(m.id, Date.now());
      if (r.status === 'fulfilled') { this.cache.set(m.id, { ok: true, data: r.value }); nsxAuthGuard.clearAuthStop(m.id); }
      else {
        const d = describeError(r.reason);
        console.error(`[nsx] ${m.id} (${m.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
        this.cache.set(m.id, { ok: false, mgr: m, err: d, at: Date.now() });
        if (isNsxAuthError(r.reason)) {
          const rec = nsxAuthGuard.markAuthStopped(m.id, m, d.message);
          console.warn(`[nsx] ${m.id} (${m.name}) 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
        }
      }
    });
    const ids = new Set(managers.map((m) => m.id));
    for (const id of [...this.cache.keys()]) if (!ids.has(id)) this.cache.delete(id);
    for (const id of [...this.last.keys()]) if (!ids.has(id)) this.last.delete(id); // 마지막 수집시각 맵도 동기화

    const parts = [];
    const errors = [];
    const mockFallback = dataSource === 'auto';
    for (const m of managers) {
      if (m.enabled === false) { parts.push({ manager: disabledManager(m), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 }); continue; }
      const c = this.cache.get(m.id);
      // v2.590: 정지 기록(파일) — 재시작 뒤 캐시가 비어도 '대기(첫 수집 중)' 라는 거짓 안내가 되지 않게 싣는다.
      const stop = c?.ok ? null : stopView(nsxAuthGuard.authStopFor(m));
      if (c?.ok) parts.push(c.data);
      else if (c && !c.ok) {
        errors.push({ managerId: m.id, name: m.name, ...c.err, at: c.at, fallback: mockFallback, ...(stop ? { authStopped: stop } : {}) });
        if (mockFallback && !stop) parts.push(generateNsxForManager(m));
        else parts.push({ manager: unreachableManager(m, c.err, stop), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 });
      } else if (stop) {
        errors.push({ managerId: m.id, name: m.name, message: stop.reason, at: stop.at, fallback: false, authStopped: stop });
        parts.push({ manager: unreachableManager(m, { message: stop.reason, hint: '인증 실패 — 계정/비밀번호 또는 권한을 확인하세요.' }, stop), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 });
      } else parts.push({ manager: pendingManager(m), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 });
    }
    this.snapshot = rollup(merge(parts, errors, dataSource));
  }

  start() {
    this.refresh({ scheduled: true }).catch((e) => console.error('[nsx] refresh 실패:', e.message));
    this.timer = setInterval(() => this.refresh({ scheduled: true }).catch(() => {}), config.pollIntervalMs);
    this.timer.unref?.();
  }

  get() { return this.snapshot; }
}

const disabledManager = (m) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'disabled', version: '', nodeCount: 0 });
const pendingManager = (m) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'pending', version: '', nodeCount: 0 });
const unreachableManager = (m, err, authStopped = null) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'unreachable', version: '', nodeCount: 0, error: err.message, hint: err.hint, code: err.code, ...(authStopped ? { authStopped } : {}) });

function empty() {
  return { generatedAt: new Date().toISOString(), source: getDataSource(), managers: [], gateways: [], segments: [], transportNodes: [], dfw: [], securityGroups: [], idsEvents: [], collectionErrors: [], rollup: null };
}

export function merge(parts, errors, source) {
  const snap = empty();
  snap.source = source;
  snap.collectionErrors = errors;
  for (const p of parts) {
    // v2.600(COL-2600-06 후속): 조회에 실패한 목록의 개수는 0 이 아니라 null(빈 배열 길이를 쓰지 않는다).
    const lf = new Set(Array.isArray(p.manager?.listsFailed) ? p.manager.listsFailed : []);
    snap.managers.push({ ...p.manager,
      gateways: lf.has('tier0s') || lf.has('tier1s') ? null : p.gateways.length,
      segments: lf.has('segments') ? null : p.segments.length,
      transportNodes: lf.has('transportNodes') ? null : p.transportNodes.length,
      firewall: p.firewall, groups: p.groups });
    pushAll(snap.gateways, p.gateways);
    pushAll(snap.segments, p.segments);
    pushAll(snap.transportNodes, p.transportNodes);
    pushAll(snap.dfw, (p.dfw || []));
    pushAll(snap.securityGroups, (p.securityGroups || []));
    pushAll(snap.idsEvents, (p.ids?.events || []));
  }
  snap.generatedAt = new Date().toISOString();
  return snap;
}

// v2.600(감사 COL-2600-06 후속): 전 함대 rollup 도 범위 rollup 과 **같은 함수**로 센다 — 두 벌이던 합계가
//   목록 조회 실패(listsFailed)를 각자 0 으로 더하고 있었다. 필드 구성은 그대로다.
export function rollup(snap) {
  snap.rollup = scopedNsxRollup(snap);
  return snap;
}

export const nsxStore = new NsxStore();

export function startNsxPoller() {
  nsxStore.start();
  console.log(`[nsx] poller started (every ${Math.round(config.pollIntervalMs / 1000)}s)`);
}
