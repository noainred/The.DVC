/**
 * upgrade/edgeSync.js — 중앙이 업그레이드되면 등록된 엣지(수집 서버)를 **모두** 같은 버전으로 맞춘다(v2.859, 사용자 요청
 * "중앙 포탈이 자동 업그레이드 되면 엣지도 모두 자동으로 업그레이드 · 기본값 켬").
 *
 * 예전(≤ v2.746): 중앙이 자기 업그레이드를 마친 **직후 한 번** 등록된 수집 서버 전부에 번들을 밀었다(manager.pushToCollectors).
 *   그때 닿지 않은 엣지(꺼짐·NAT·시한 초과·토큰 불일치)는 구버전으로 남았고, 재시작한 중앙은 그 사실을 기억하지도 다시 밀지도
 *   않았다. 수동 '모두 업그레이드' 버튼만이 남은 길이었다. 설정으로 끌 수도 없었다.
 *
 * 이제:
 *  - 설정 `edgeAutoUpgrade`(기본 켬 · env UPGRADE_EDGE_AUTO=false 로 끔)가 ① 적용 직후 push 와 ② 이 주기 동기화를 함께 다스린다.
 *  - 주기 동기화(UPGRADE_EDGE_SYNC_INTERVAL_MS, 기본 10분 · [1분, 24시간] · 기동 2분 뒤 첫 실행): 수집 서버 pull 이 보고한 엣지 버전
 *    (collector/state.js status.version — 엣지 export 의 currentVersion)을 중앙 버전과 비교해 **뒤처진 + 닿는** 엣지에만
 *    '중앙 현재 버전' 번들을 민다. 번들은 패키지 폴더(보관본·관리자 내려받기) → 감시 폴더 → 원격(최신 == 중앙 버전일 때만,
 *    1시간에 한 번만 묻는다)에서 구한다(bundleSource.resolveBundleBytes exactVersion — 중앙보다 새 버전을 엣지에 먼저 올리지 않는다).
 *  - 판정은 순수 함수 `planEdgeSync` 하나(테스트가 고정): 버전을 모르면 'unknown'(0 이 아니다 — 밀지 않는다) · 중앙보다 새 버전은
 *    'ahead'(내리지 않는다) · pull 실패 중이면 'unreachable'(push 도 같은 길이라 실패한다 — 돌아오면 민다) · 밀고 나서 settle(30분)
 *    동안은 'waiting'(엣지가 재시작해 새 버전을 보고할 시간) · 실패하면 주기 × 2^(n−1)(상한 6시간) 뒤에 다시 — 같은 엣지에 수십 MB 를
 *    10분마다 거듭 올리지 않게. 엣지가 '이미 최신(upToDate)' 으로 답하면 성공으로 본다(엣지가 /dl 로 먼저 올라간 경우).
 *  - 적용(manager.apply)과 겹치지 않는다: 적용·확인 중이면 이번 주기를 건너뛰고(skipped), 적용은 진행 중인 동기화 push 가 끝난 뒤에
 *    자기 push 를 한다(manager 가 `inflight` 를 기다린다). 결과는 수집 서버 상태(`upgrade`)와 이 모듈의 lastRun 에 남는다(메모리 —
 *    재시작 전 기록은 지어내지 않는다).
 *  - 상태 코드는 서버가 정하고 문장은 웹 `views/upgradeEdgeSyncText.js` 가 만든다(1:1 — 웹 테스트가 이 소스와 대조한다).
 *  ⚠ UPGRADE_EDGES(upgrade.json edges — /api/upgrade/bundle 로 받는 옛 방식 엣지)는 버전을 보고하지 않아 동기화 대상이 아니다 —
 *    예전처럼 적용 직후 1회 push 만 받는다(정직 기록).
 */
import { loadCollectors } from '../collector/registry.js';
import { getCollectorStatus } from '../collector/state.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { resolveBundleBytes, lastBundleReject } from './bundleSource.js';
import { getPackageDir } from './packageSettings.js';
import { keepBundle } from './fleetBundle.js';
import { nextCheckAt } from './autoState.js';
import { currentVersion as readCurrentVersion } from '../config.js';
import { cmpVersion } from '../util/cmpVersion.js';
import { numOrNull } from '../util/numOrNull.js';

/** 엣지 하나의 판정 — 웹 `EDGE_STATE_TEXT` 의 키와 1:1. */
export const EDGE_SYNC_STATES = Object.freeze([
  'up-to-date',   // 중앙과 같은 버전
  'behind',       // 중앙보다 낮고 닿는다 — 이번에 민다
  'ahead',        // 중앙보다 새 버전 — 내리지 않는다
  'unknown',      // 버전을 모른다(아직 pull 기록 없음 · 보고 없음) — 0 이 아니다, 밀지 않는다
  'unreachable',  // pull 이 실패 중 — push 도 같은 길이라 돌아오면 민다
  'disabled',     // 수집 중지(enabled:false) 또는 URL 없음
  'waiting',      // 방금 밀었다 — 엣지가 재시작해 새 버전을 보고할 시간(settle)
  'backoff',      // 최근 push 가 실패했다 — 백오프 뒤 다시
]);
/** 동기화 한 번의 결과 — 웹 `SYNC_OUTCOME_TEXT` 의 키와 1:1. */
export const EDGE_SYNC_OUTCOMES = Object.freeze(['off', 'skipped', 'no-edges', 'idle', 'pushed', 'no-bundle', 'error']);

export const SYNC_MIN_MS = 60_000;
export const SYNC_MAX_MS = 86_400_000;
export const SYNC_FIRST_DELAY_MS = 120_000;      // 기동 뒤 첫 실행 — 수집 서버 pull(60초)이 엣지 버전을 한 번 보고할 시간
export const SYNC_SETTLE_MS = 30 * 60_000;       // push 성공 뒤 엣지가 재시작·보고할 시간
export const SYNC_BACKOFF_MAX_MS = 6 * 3_600_000;
export const SYNC_REMOTE_RETRY_MS = 3_600_000;   // 지금 버전 번들을 원격에서 못 구했으면 1시간 뒤에 다시 묻는다(로컬은 매번 본다)

/** 동기화 주기 — env 가 비었거나 0 이하면 10분, [1분, 24시간] 로 자른다(setInterval 24.8일 상한 안). */
export function edgeSyncIntervalMs(v = process.env.UPGRADE_EDGE_SYNC_INTERVAL_MS) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return 600_000;
  return Math.min(SYNC_MAX_MS, Math.max(SYNC_MIN_MS, Math.round(n)));
}
export const UPGRADE_EDGE_SYNC_INTERVAL_MS = edgeSyncIntervalMs(numOrNull(process.env.UPGRADE_EDGE_SYNC_INTERVAL_MS) ?? 600_000); // 같은 판정 — 기본값을 문서 생성기가 읽게 한 줄로

/** n 번째 연속 실패 뒤 기다리는 시간 — 주기 × 2^(n−1), 상한 6시간. */
export function backoffMs(attempts, baseMs, maxMs = SYNC_BACKOFF_MAX_MS) {
  const n = Math.max(1, Math.floor(numOrNull(attempts) ?? 1));
  const base = Math.max(SYNC_MIN_MS, numOrNull(baseMs) ?? 600_000);
  return Math.min(maxMs, base * 2 ** Math.min(20, n - 1));
}

const txt = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/**
 * 어느 엣지에 밀 것인가(순수).
 * @param {object} o
 * @param {object[]} o.collectors 등록부(loadCollectors) — id·name·url·enabled
 * @param {(id:string)=>object|null} o.statusOf 수집 서버 상태(version·ok·error)
 * @param {(id:string)=>({at:number,ok:boolean,target:string,attempts:number,reason?:string}|null)} o.attemptsOf 이 프로세스의 push 기록
 * @param {string|null} o.currentVersion 중앙 버전
 * @returns {{push:string[], edges:object[], counts:Record<string,number>, total:number, currentVersion:string|null}}
 */
export function planEdgeSync({ collectors = [], statusOf = () => null, attemptsOf = () => null, currentVersion = null, now = Date.now(), intervalMs = 600_000, settleMs = SYNC_SETTLE_MS, maxBackoffMs = SYNC_BACKOFF_MAX_MS } = {}) {
  const counts = Object.fromEntries(EDGE_SYNC_STATES.map((s) => [s, 0]));
  const edges = []; const push = [];
  const cur = typeof currentVersion === 'string' && currentVersion ? currentVersion : null;
  for (const c of Array.isArray(collectors) ? collectors : []) {
    if (!c || typeof c !== 'object' || !c.id) continue;
    const id = String(c.id);
    const st = statusOf(id);
    const v = typeof st?.version === 'string' ? st.version.trim() : '';
    const row = { id, name: txt(c.name, 120) || id, version: v || null, state: 'unknown', reason: null, nextAt: null };
    let state = null;
    if (c.enabled === false || !c.url) state = 'disabled';
    else {
      const cmp = v && cur ? cmpVersion(v, cur) : null;
      if (cmp == null) {
        state = 'unknown';
        // 왜 모르는가 — pull 이 실패 중이면 '닿지 않아 모름'(돌아오면 보고한다) · 닿는데 보고가 없으면 구버전 엣지(export 에 version 이 없다) 가능성.
        row.reason = !st ? '아직 수집(pull) 기록 없음'
          : v ? `버전 표기를 읽을 수 없음(‘${v.slice(0, 32)}’)`
            : st.ok === false ? `닿지 않아 버전을 모름${st.error ? ` — ${String(st.error).slice(0, 200)}` : ''}` : '엣지가 버전을 보고하지 않음';
      }
      else if (cmp === 0) state = 'up-to-date';
      else if (cmp > 0) state = 'ahead';
      else if (st.ok === false) { state = 'unreachable'; row.reason = txt(st.error, 300); }
      else {
        const a = attemptsOf(id);
        if (a && a.target === cur && a.ok && now - a.at < settleMs) { state = 'waiting'; row.nextAt = a.at + settleMs; }
        else if (a && a.target === cur && !a.ok) {
          const wait = backoffMs(a.attempts, intervalMs, maxBackoffMs);
          if (now - a.at < wait) { state = 'backoff'; row.nextAt = a.at + wait; row.reason = txt(a.reason, 300); }
        }
        if (!state) { state = 'behind'; push.push(id); }
      }
    }
    row.state = state;
    counts[state] += 1;
    edges.push(row);
  }
  return { push, edges, counts, total: edges.length, currentVersion: cur };
}

/**
 * '중앙 현재 버전' 번들 — 패키지 폴더(보관본·내려받기) → 감시 폴더 → 원격(allowRemote 일 때, 최신 == 지금 버전일 때만).
 * 원격에서 받았으면 패키지 폴더에 보관한다(다음 동기화·/dl 이 쓴다 — 실패해도 push 는 한다).
 */
export async function resolveCurrentBundle(settings, cur, { allowRemote = true } = {}) {
  const b = await resolveBundleBytes(settings || {}, { exactVersion: cur, localDirs: [getPackageDir()], remote: allowRemote });
  if (b && b.source === 'remote') {
    const k = keepBundle({ bytes: b.bytes, version: cur, manifestText: b.manifest || undefined });
    if (!k.ok) console.warn(`[upgrade] 원격에서 받은 v${cur} 번들을 패키지 폴더에 보관하지 못했습니다: ${k.reason}`);
  }
  return b;
}

export class EdgeSyncRunner {
  /**
   * @param {object} o
   * @param {() => object} o.settings 유효 업그레이드 설정(enabled·edgeAutoUpgrade·remoteBase·watchDir·token)
   * @param {() => boolean} o.busy 업그레이드 확인·적용이 진행 중인가(그러면 이번 주기는 건너뛴다)
   */
  constructor({ settings = () => ({}), busy = () => false, now = () => Date.now(), currentVersion = readCurrentVersion,
    collectors = loadCollectors, statusOf = getCollectorStatus, pushFn = pushUpgradeToCollectors, resolveBundle = resolveCurrentBundle,
    intervalMs = null, firstDelayMs = SYNC_FIRST_DELAY_MS, log = console } = {}) {
    this.settings = settings; this.busy = busy; this.now = now; this.currentVersion = currentVersion;
    this.collectors = collectors; this.statusOf = statusOf; this.pushFn = pushFn; this.resolveBundle = resolveBundle;
    this.fixedIntervalMs = intervalMs; this.firstDelayMs = firstDelayMs; this.log = log;
    this.attempts = new Map();     // collectorId → { at, ok, target, attempts, reason }
    this.timer = null; this.firstTimer = null; this.armedAt = null; this.intervalMs = 0;
    this.inflight = null; this.lastRun = null; this.lastPlan = null;
    this.remoteAskedAt = null;     // 지금 버전 번들을 원격에 물은 시각(못 구했을 때 1시간 안에 다시 묻지 않는다)
  }

  /** 설정상 지금 동작하는가 — 기능 켬 + edgeAutoUpgrade(기본 켬). */
  enabledNow() { const s = this.settings() || {}; return !!(s.enabled && s.edgeAutoUpgrade !== false); }

  /** 타이머를 (다시) 무장한다 — 설정 저장·기동 때. 꺼져 있으면 풀기만 하고 false. */
  arm() {
    this.disarm();
    if (!this.enabledNow()) return false;
    this.intervalMs = this.fixedIntervalMs ?? edgeSyncIntervalMs();
    const run = () => { this.run().catch((e) => this.log.warn?.(`[upgrade] 엣지 자동 업그레이드 동기화 실패: ${e?.message || e}`)); };
    this.firstTimer = setTimeout(run, Math.min(this.intervalMs, this.firstDelayMs)); this.firstTimer.unref?.();
    this.timer = setInterval(run, this.intervalMs); this.timer.unref?.();
    this.armedAt = this.now();
    return true;
  }
  disarm() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null; this.firstTimer = null; this.armedAt = null; this.intervalMs = 0;
  }

  plan(now = this.now()) {
    return planEdgeSync({
      collectors: this.collectors(), statusOf: this.statusOf, attemptsOf: (id) => this.attempts.get(id) || null,
      currentVersion: this.currentVersion(), now, intervalMs: this.intervalMs || this.fixedIntervalMs || edgeSyncIntervalMs(),
    });
  }

  /** 한 번 돈다(단일 진행 — 겹치면 진행 중인 것을 돌려준다). 결과는 lastRun 에도 남는다. */
  run() {
    if (this.inflight) return this.inflight;
    const p = this.#runInner().finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  async #runInner() {
    const at = this.now();
    let rec = { at, outcome: 'error' };
    try {
      if (!this.enabledNow()) rec = { at, outcome: 'off' };
      else if (this.busy()) rec = { at, outcome: 'skipped', reason: '업그레이드 확인·적용이 진행 중' };
      else {
        const list = this.collectors();
        if (!list.length) rec = { at, outcome: 'no-edges' };
        else {
          const plan = this.plan(at); this.lastPlan = plan;
          if (!plan.push.length) rec = { at, outcome: 'idle', counts: plan.counts };
          else {
            const cur = plan.currentVersion;
            const allowRemote = this.remoteAskedAt == null || at - this.remoteAskedAt >= SYNC_REMOTE_RETRY_MS;
            const bundle = await this.resolveBundle(this.settings(), cur, { allowRemote });
            if (!bundle) {
              if (allowRemote) this.remoteAskedAt = at;
              rec = { at, outcome: 'no-bundle', version: cur, behind: plan.push.length, reason: lastBundleReject() || `v${cur} 번들을 패키지 폴더·감시 폴더에서 찾지 못했습니다`, counts: plan.counts };
            } else {
              this.remoteAskedAt = null;
              const results = await this.pushFn(bundle.bytes, { ids: plan.push, manifest: bundle.manifest || null });
              const failed = [];
              for (const r of Array.isArray(results) ? results : []) {
                if (!r || !r.id) continue;
                const ok = r.ok === true || r.upToDate === true;
                const prev = this.attempts.get(r.id);
                this.attempts.set(r.id, { at: this.now(), ok, target: cur, attempts: ok ? 0 : (prev && prev.target === cur ? (prev.attempts || 0) + 1 : 1), reason: ok ? null : (txt(r.reason, 300) || 'push 실패') });
                if (!ok) failed.push({ id: String(r.id), name: txt(r.name, 120) || String(r.id), reason: txt(r.reason, 300) || '' });
              }
              const n = Array.isArray(results) ? results.length : 0;
              rec = { at, outcome: 'pushed', version: cur, source: txt(bundle.source, 20), pushed: n, ok: n - failed.length, failed: failed.slice(0, 20), counts: plan.counts };
              this.log.log?.(`[upgrade] 엣지 자동 업그레이드: 뒤처진 수집 서버 ${n}대에 v${cur} 번들 push — ${rec.ok}/${n} 성공`);
              for (const f of failed) this.log.warn?.(`[upgrade] 엣지 자동 업그레이드 push 실패 ${f.name}: ${f.reason}`);
            }
          }
        }
      }
    } catch (e) {
      rec = { at, outcome: 'error', reason: String(e?.message || e).slice(0, 300) };
    } finally {
      this.lastRun = { ...rec, finishedAt: this.now() };
    }
    return this.lastRun;
  }

  /** 화면용 상태 — 켜짐·다음 실행·마지막 실행·엣지별 판정(최신·중지 제외 최대 20). 꺼져 있으면 판정을 하지 않는다. */
  status(now = this.now()) {
    const enabled = this.enabledNow();
    const armed = !!this.timer;
    let plan = null;
    if (enabled) { try { plan = this.plan(now); } catch { plan = null; } }
    const pending = plan ? plan.edges.filter((e) => e.state !== 'up-to-date' && e.state !== 'disabled').slice(0, 20) : [];
    let nextRunAt = null;
    if (armed && this.armedAt != null) {
      const first = this.armedAt + Math.min(this.intervalMs, this.firstDelayMs);
      nextRunAt = this.firstTimer && now < first ? first : nextCheckAt({ armedAt: this.armedAt, intervalMs: this.intervalMs, now });
    }
    return {
      enabled, armed, intervalMs: this.intervalMs || 0, nextRunAt, running: !!this.inflight, lastRun: this.lastRun,
      currentVersion: plan?.currentVersion ?? null, total: plan?.total ?? 0, counts: plan?.counts || null, pending,
    };
  }
}
