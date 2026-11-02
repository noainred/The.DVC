/**
 * upgrade/edgeSync.js — 중앙이 업그레이드되면 등록된 엣지(수집 서버)를 **모두** 같은 버전으로 맞춘다(v2.859, 사용자 요청
 * "중앙 포탈이 자동 업그레이드 되면 엣지도 모두 자동으로 업그레이드 · 기본값 켬").
 *
 * 예전(≤ v2.858): 중앙이 자기 업그레이드를 마친 **직후 한 번** 등록된 수집 서버 전부에 번들을 밀었다(manager.pushToCollectors).
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
 *    자기 push 를 한다(manager 가 `inflight` 를 기다린다). 결과는 수집 서버 상태(`upgrade`)와 이 모듈의 lastRun 에 남는다.
 *  - 상태 코드는 서버가 정하고 문장은 웹 `views/upgradeEdgeSyncText.js` 가 만든다(1:1 — 웹 테스트가 이 소스와 대조한다).
 *
 * v2.863(사용자 선택 A·B·C·D — '프로그램 개선'):
 *  A. lastRun 은 재시작 뒤에도 남는다 — manager 가 upgrade-status.json 에 `lastEdgeSync` 로 쓰고(onRun 훅), 기동 때 되살려 `restored:true`
 *     를 단다(화면이 '재시작 전 기록' 이라 말한다). 모르는 결과 코드는 'error' 로 읽는다(지어내지 않는다).
 *  B. 옛 방식 엣지(upgrade.json `edges` · env UPGRADE_EDGES — `/api/upgrade/bundle` 로 받는 포탈 엣지)도 동기화 대상이다. 버전은 수집 pull 이
 *     아니라 **공개 `/api/health` 의 version** 을 동기화 때마다 직접 묻는다(probeEdgeVersion — 토큰 없이, 10초 시한, 리다이렉트 안 따라감,
 *     SSRF 차단 대역 제외). 판정·settle·백오프는 수집 서버와 같은 planEdgeSync 를 탄다(행 id `edge:<origin>` · kind 'edge'). push 는
 *     upgrade.js pushBundleToEdge(번들 **파일**)로 — 그래서 번들은 패키지 폴더에 보관된 파일 경로가 있어야 한다(없으면 그 엣지만 사유와 함께 실패).
 *  C. '지금 동기화' — routes/upgrade.js `POST /api/upgrade/edge-sync` 가 run() 을 부른다(단일 진행 — 주기 실행과 겹치면 같은 약속).
 *  D. 같은 엣지가 같은 대상 버전으로 **백오프 상한(6시간)에 닿을 만큼 연속 실패**하면 알림 채널(alerts.js notify)로 한 번 알리고, 그 뒤
 *     성공하면 '해소' 를 한 번 알린다(key `edgesync:<id>|<버전>` · 억제는 alerts.js 의 key 단위 창이 한다). 알린 사실은 메모리에만 — 재시작하면
 *     연속 실패 수가 0 부터 다시 세므로 같은 장애를 한 번 더 알릴 수 있다(정직 기록).
 */
import { loadCollectors, ssrfBlockReason } from '../collector/registry.js';
import { getCollectorStatus } from '../collector/state.js';
import { pushUpgradeToCollectors, pushConcurrencyOf } from '../collector/upgradePush.js';
import { resolveBundleBytes, lastBundleReject } from './bundleSource.js';
import { getPackageDir } from './packageSettings.js';
import { keepBundle } from './fleetBundle.js';
import { nextCheckAt } from './autoState.js';
import { pushBundleToEdge } from './upgrade.js';
import { upgradeAgent } from './upgradeAgent.js';
import { notify as sendAlert } from '../alerts.js';
import { currentVersion as readCurrentVersion } from '../config.js';
import { cmpVersion } from '../util/cmpVersion.js';
import { numOrNull } from '../util/numOrNull.js';
import { poolSettled } from '../util/pool.js';
import { readJsonCapped } from '../util/readCapped.js';

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
/** 행의 종류 — 'collector'(등록 수집 서버 — 버전은 pull 보고) · 'edge'(옛 방식 엣지 — 버전은 /api/health 질의). 웹 `EDGE_KIND_TEXT` 와 1:1. */
export const EDGE_SYNC_KINDS = Object.freeze(['collector', 'edge']);

export const SYNC_MIN_MS = 60_000;
export const SYNC_MAX_MS = 86_400_000;
export const SYNC_FIRST_DELAY_MS = 120_000;      // 기동 뒤 첫 실행 — 수집 서버 pull(60초)이 엣지 버전을 한 번 보고할 시간
export const SYNC_SETTLE_MS = 30 * 60_000;       // push 성공 뒤 엣지가 재시작·보고할 시간
export const SYNC_BACKOFF_MAX_MS = 6 * 3_600_000;
export const SYNC_REMOTE_RETRY_MS = 3_600_000;   // 지금 버전 번들을 원격에서 못 구했으면 1시간 뒤에 다시 묻는다(로컬은 매번 본다)
export const EDGE_PROBE_TIMEOUT_MS = 10_000;     // 옛 방식 엣지 /api/health 질의 시한
const PROBE_RESPONSE_MAX_BYTES = 64 * 1024;

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
/** v2.863 D: 이 연속 실패 수가 백오프 상한에 닿았는가(= 알림을 보낼 때). */
export const backoffCapped = (attempts, baseMs, maxMs = SYNC_BACKOFF_MAX_MS) => backoffMs(attempts, baseMs, maxMs) >= maxMs;

const txt = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return ''; } };
const LEGACY_PREFIX = 'edge:';
export const isLegacyId = (id) => typeof id === 'string' && id.startsWith(LEGACY_PREFIX);

/**
 * v2.863 B: 옛 방식 엣지 목록(설정 `edges` — url·token) → 동기화 행. origin 으로 이름·id 를 만들고 중복·형식 오류·SSRF 차단 대역은 뺀다
 * (뺀 것은 `dropped` 에 사유와 함께 — 조용히 빼지 않는다).
 * @returns {{ edges:{id:string,name:string,url:string,token?:string,kind:'edge'}[], dropped:{url:string,reason:string}[] }}
 */
export function legacyEdgesOf(settings) {
  const out = []; const dropped = []; const seen = new Set();
  for (const e of Array.isArray(settings?.edges) ? settings.edges : []) {
    const url = typeof e?.url === 'string' ? e.url.trim() : '';
    if (!url) continue;
    const origin = originOf(url);
    if (!origin || !/^https?:$/.test(new URL(url).protocol)) { dropped.push({ url: url.slice(0, 200), reason: 'http(s) URL 이 아닙니다' }); continue; }
    const ssrf = ssrfBlockReason(url);
    if (ssrf) { dropped.push({ url: origin, reason: ssrf }); continue; }
    const id = `${LEGACY_PREFIX}${origin}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: origin, url, token: typeof e.token === 'string' ? e.token : '', kind: 'edge' });
  }
  return { edges: out, dropped };
}

/**
 * v2.863 B: 옛 방식 엣지의 버전 — 공개 `/api/health` 의 version(토큰 없이 · 리다이렉트 안 따라감 · 시한). 수집 서버 상태와 같은 모양
 * ({ at, ok, version, error })으로 돌려 planEdgeSync 가 그대로 판정한다.
 */
export async function probeEdgeVersion(edge, { fetchImpl = fetch, timeoutMs = EDGE_PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const url = `${String(edge.url).replace(/\/+$/, '')}/api/health`;
  const at = now();
  try {
    const res = await fetchImpl(url, { method: 'GET', dispatcher: upgradeAgent, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* 이미 소비 */ } return { at, ok: false, error: `health -> HTTP ${res.status}` }; }
    let body = {};
    try { const j = await readJsonCapped(res, PROBE_RESPONSE_MAX_BYTES, '엣지 health 응답'); if (j && typeof j === 'object' && !Array.isArray(j)) body = j; } catch { body = {}; }
    const version = txt(body.version, 32);
    return { at, ok: true, version: version || undefined, ...(version ? {} : { error: 'health 응답에 version 이 없습니다' }) };
  } catch (err) {
    const cause = err?.cause?.message && err.cause.message !== err?.message ? ` — ${String(err.cause.message).slice(0, 200)}` : '';
    return { at, ok: false, error: `health 질의 실패: ${String(err?.message || err).slice(0, 200)}${cause}` };
  }
}

/**
 * 어느 엣지에 밀 것인가(순수).
 * @param {object} o
 * @param {object[]} o.collectors 등록부(loadCollectors) — id·name·url·enabled(+ v2.863 kind: 'collector'|'edge')
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
    const kind = EDGE_SYNC_KINDS.includes(c.kind) ? c.kind : 'collector';
    const row = { id, name: txt(c.name, 120) || id, kind, version: v || null, state: 'unknown', reason: null, nextAt: null };
    let state = null;
    if (c.enabled === false || !c.url) state = 'disabled';
    else {
      const cmp = v && cur ? cmpVersion(v, cur) : null;
      if (cmp == null) {
        state = 'unknown';
        // 왜 모르는가 — pull 이 실패 중이면 '닿지 않아 모름'(돌아오면 보고한다) · 닿는데 보고가 없으면 구버전 엣지(export 에 version 이 없다) 가능성.
        row.reason = !st ? (kind === 'edge' ? '아직 health 질의 기록 없음' : '아직 수집(pull) 기록 없음')
          : v ? `버전 표기를 읽을 수 없음(‘${v.slice(0, 32)}’)`
            : st.ok === false ? `닿지 않아 버전을 모름${st.error ? ` — ${String(st.error).slice(0, 200)}` : ''}` : (txt(st.error, 200) || '엣지가 버전을 보고하지 않음');
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
 * 원격에서 받았으면 패키지 폴더에 보관한다(다음 동기화·/dl 이 쓴다 — 실패해도 수집 서버 push 는 한다). 돌려주는 객체의 `path` 는
 * 번들 **파일** 경로(옛 방식 엣지 push 가 쓴다) — 보관하지 못했으면 null.
 */
export async function resolveCurrentBundle(settings, cur, { allowRemote = true } = {}) {
  const b = await resolveBundleBytes(settings || {}, { exactVersion: cur, localDirs: [getPackageDir()], remote: allowRemote });
  if (b && b.source === 'remote') {
    const k = keepBundle({ bytes: b.bytes, version: cur, manifestText: b.manifest || undefined });
    if (!k.ok) console.warn(`[upgrade] 원격에서 받은 v${cur} 번들을 패키지 폴더에 보관하지 못했습니다: ${k.reason}`);
    b.path = k.ok ? k.path : null;
  }
  return b;
}

/** v2.863 D: 반복 실패 알림 본문(순수). closed 면 '해소'. */
export function edgeSyncAlert({ id, name, kind, target, attempts, reason, intervalMs, closed = false }) {
  const who = `${name || id}${kind === 'edge' ? ' (옛 방식 엣지)' : ''}`;
  const plain = (x) => String(x ?? '').replace(/\*\*/g, '');
  const lines = closed
    ? [`엣지: ${who}`, `대상 버전: v${target}`, '상태: 해소됨 — 중앙 버전 번들을 받았습니다(또는 이미 최신이라고 답했습니다).']
    : [`엣지: ${who}`, `대상 버전: v${target}`, `연속 실패: ${attempts}회 — 다음 시도까지 백오프 상한(${Math.round(SYNC_BACKOFF_MAX_MS / 3_600_000)}시간)에 닿았습니다(주기 ${Math.round((numOrNull(intervalMs) ?? 600_000) / 60_000)}분).`,
      `마지막 사유: ${reason || '사유 없음'}`, '조치: 설정 › 수집 서버에서 그 엣지의 토큰·URL·인바운드 경로(NAT/방화벽)를 확인하고 ‘모두 업그레이드’ 또는 ‘구버전 엣지 밀어 넣기’ 로 다시 시도하세요.'];
  return {
    key: `edgesync:${id}|${target}${closed ? ':close' : ''}`,
    severity: closed ? 'info' : 'warning',
    title: plain(closed ? `엣지 자동 업그레이드 해소 — ${who} v${target}` : `엣지 자동 업그레이드 실패 반복 — ${who} v${target}`),
    detail: plain(lines.join('\n')),
  };
}

export class EdgeSyncRunner {
  /**
   * @param {object} o
   * @param {() => object} o.settings 유효 업그레이드 설정(enabled·edgeAutoUpgrade·remoteBase·watchDir·token·edges)
   * @param {() => boolean} o.busy 업그레이드 확인·적용이 진행 중인가(그러면 이번 주기는 건너뛴다)
   * @param {(run:object) => void} [o.onRun] 한 번 돌 때마다(결과 확정 뒤) — manager 가 상태 파일에 쓴다(v2.863 A)
   */
  constructor({ settings = () => ({}), busy = () => false, now = () => Date.now(), currentVersion = readCurrentVersion,
    collectors = loadCollectors, statusOf = getCollectorStatus, pushFn = pushUpgradeToCollectors, pushEdgeFn = pushBundleToEdge,
    probeFn = probeEdgeVersion, notifyFn = sendAlert, resolveBundle = resolveCurrentBundle, onRun = null,
    intervalMs = null, firstDelayMs = SYNC_FIRST_DELAY_MS, log = console } = {}) {
    this.settings = settings; this.busy = busy; this.now = now; this.currentVersion = currentVersion;
    this.collectors = collectors; this.statusOf = statusOf; this.pushFn = pushFn; this.pushEdgeFn = pushEdgeFn;
    this.probeFn = probeFn; this.notifyFn = notifyFn; this.resolveBundle = resolveBundle; this.onRun = onRun;
    this.fixedIntervalMs = intervalMs; this.firstDelayMs = firstDelayMs; this.log = log;
    this.attempts = new Map();     // id → { at, ok, target, attempts, reason }
    this.legacyStatus = new Map(); // v2.863 B: 옛 방식 엣지 id → { at, ok, version, error }(마지막 health 질의)
    this.legacyDropped = [];       // v2.863 B: 설정에서 뺀 옛 방식 엣지(사유)
    this.alerted = new Set();      // v2.863 D: 알린 `${id}|${target}`
    this.timer = null; this.firstTimer = null; this.armedAt = null; this.intervalMs = 0;
    this.inflight = null; this.lastRun = null; this.lastPlan = null;
    this.remoteAskedAt = null;     // 지금 버전 번들을 원격에 물은 시각(못 구했을 때 1시간 안에 다시 묻지 않는다)
  }

  /** 설정상 지금 동작하는가 — 기능 켬 + edgeAutoUpgrade(기본 켬). */
  enabledNow() { const s = this.settings() || {}; return !!(s.enabled && s.edgeAutoUpgrade !== false); }

  /** v2.863 A: 재시작 전 기록을 되살린다(이 프로세스의 기록이 없을 때만). 모르는 결과 코드는 'error'. */
  restore(prev) {
    if (!prev || typeof prev !== 'object' || this.lastRun) return false;
    this.lastRun = { ...prev, outcome: EDGE_SYNC_OUTCOMES.includes(prev.outcome) ? prev.outcome : 'error', restored: true };
    return true;
  }

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

  /** 동기화 행 전부 — 등록 수집 서버 + 옛 방식 엣지(v2.863 B). */
  rows() {
    const cols = (this.collectors() || []).filter((c) => c && typeof c === 'object').map((c) => ({ ...c, kind: 'collector' }));
    const lg = legacyEdgesOf(this.settings() || {});
    this.legacyDropped = lg.dropped;
    return [...cols, ...lg.edges];
  }
  #statusOfRow(id) { return isLegacyId(id) ? (this.legacyStatus.get(id) || null) : this.statusOf(id); }

  plan(now = this.now(), rows = this.rows()) {
    return planEdgeSync({
      collectors: rows, statusOf: (id) => this.#statusOfRow(id), attemptsOf: (id) => this.attempts.get(id) || null,
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

  /** v2.863 D: push 결과 하나를 기록하고, 백오프 상한에 닿은 연속 실패·그 뒤의 성공을 알린다. */
  async #recordResult(r, cur, rowsById) {
    const ok = r.ok === true || r.upToDate === true;
    const prev = this.attempts.get(r.id);
    const attempts = ok ? 0 : (prev && prev.target === cur ? (prev.attempts || 0) + 1 : 1);
    const reason = ok ? null : (txt(r.reason, 300) || 'push 실패');
    this.attempts.set(r.id, { at: this.now(), ok, target: cur, attempts, reason });
    const row = rowsById.get(r.id) || {};
    const mark = `${r.id}|${cur}`;
    const base = this.intervalMs || this.fixedIntervalMs || edgeSyncIntervalMs();
    try {
      if (!ok && !this.alerted.has(mark) && backoffCapped(attempts, base)) {
        this.alerted.add(mark);
        await this.notifyFn(edgeSyncAlert({ id: r.id, name: row.name, kind: row.kind, target: cur, attempts, reason, intervalMs: base }));
        this.log.warn?.(`[upgrade] 엣지 자동 업그레이드 반복 실패 알림: ${row.name || r.id} v${cur} (${attempts}회)`);
      } else if (ok && this.alerted.has(mark)) {
        this.alerted.delete(mark);
        await this.notifyFn(edgeSyncAlert({ id: r.id, name: row.name, kind: row.kind, target: cur, attempts: 0, intervalMs: base, closed: true }));
      }
    } catch (e) { this.log.warn?.(`[upgrade] 엣지 자동 업그레이드 알림 발송 실패: ${e?.message || e}`); }
    return ok;
  }

  async #runInner() {
    const at = this.now();
    let rec = { at, outcome: 'error' };
    try {
      if (!this.enabledNow()) rec = { at, outcome: 'off' };
      else if (this.busy()) rec = { at, outcome: 'skipped', reason: '업그레이드 확인·적용이 진행 중' };
      else {
        const rows = this.rows();
        if (!rows.length) rec = { at, outcome: 'no-edges' };
        else {
          // v2.863 B: 옛 방식 엣지는 동기화 때마다 /api/health 로 버전을 묻는다(수집 pull 이 없다). 동시 개수는 push 와 같은 상한.
          const legacy = rows.filter((r) => r.kind === 'edge');
          if (legacy.length) {
            const probed = await poolSettled(legacy, pushConcurrencyOf(), (e) => this.probeFn(e));
            probed.forEach((p, i) => this.legacyStatus.set(legacy[i].id, p.status === 'fulfilled' ? p.value : { at: this.now(), ok: false, error: String(p.reason?.message || p.reason || 'health 질의 실패').slice(0, 200) }));
          }
          const plan = this.plan(at, rows); this.lastPlan = plan;
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
              const rowsById = new Map(rows.map((r) => [String(r.id), r]));
              const colIds = plan.push.filter((id) => !isLegacyId(id));
              const legacyPush = legacy.filter((e) => plan.push.includes(e.id));
              const results = [];
              if (colIds.length) {
                const rs = await this.pushFn(bundle.bytes, { ids: colIds, manifest: bundle.manifest || null });
                for (const r of Array.isArray(rs) ? rs : []) if (r && r.id) results.push(r);
              }
              if (legacyPush.length) {
                // v2.863 B: 옛 방식 엣지는 번들 **파일**로 민다(pushBundleToEdge) — 파일 경로가 없으면(보관 실패) 그 엣지만 사유와 함께 실패.
                if (!bundle.path) {
                  for (const e of legacyPush) results.push({ id: e.id, name: e.name, ok: false, reason: `번들 파일이 패키지 폴더에 없어 옛 방식 엣지에 보낼 수 없습니다(${lastBundleReject() || '보관 실패'})` });
                } else {
                  const settled = await poolSettled(legacyPush, pushConcurrencyOf(), (e) => this.pushEdgeFn({ url: e.url, token: e.token }, bundle.path, { manifestText: bundle.manifest || undefined }));
                  settled.forEach((s, i) => {
                    const e = legacyPush[i];
                    if (s.status === 'fulfilled' && s.value) results.push({ id: e.id, name: e.name, ok: s.value.ok === true, upToDate: s.value.upToDate === true, status: s.value.status, reason: s.value.reason, version: s.value.version });
                    else results.push({ id: e.id, name: e.name, ok: false, reason: String(s.reason?.message || s.reason || 'push 실패').slice(0, 300) });
                  });
                }
              }
              const failed = [];
              for (const r of results) {
                const ok = await this.#recordResult(r, cur, rowsById);
                if (!ok) failed.push({ id: String(r.id), name: txt(r.name, 120) || String(r.id), reason: txt(r.reason, 300) || '' });
              }
              const n = results.length;
              rec = { at, outcome: 'pushed', version: cur, source: txt(bundle.source, 20), pushed: n, ok: n - failed.length, failed: failed.slice(0, 20), counts: plan.counts };
              this.log.log?.(`[upgrade] 엣지 자동 업그레이드: 뒤처진 엣지 ${n}대에 v${cur} 번들 push — ${rec.ok}/${n} 성공`);
              for (const f of failed) this.log.warn?.(`[upgrade] 엣지 자동 업그레이드 push 실패 ${f.name}: ${f.reason}`);
            }
          }
        }
      }
    } catch (e) {
      rec = { at, outcome: 'error', reason: String(e?.message || e).slice(0, 300) };
    } finally {
      this.lastRun = { ...rec, finishedAt: this.now() };
      try { this.onRun?.(this.lastRun); } catch { /* 파일 쓰기 실패는 manager 가 말한다 */ }
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
      legacy: plan ? plan.edges.filter((e) => e.kind === 'edge').length : 0, legacyDropped: this.legacyDropped.slice(0, 10), // v2.863 B
    };
  }
}
