/**
 * bmusage/poller.js — 베어메탈 사용률 주기 수집(v2.550).
 *
 * ── CLAUDE.md 폴러 규약을 전부 지킨다 ───────────────────────────────────────
 *  ① **재진입 가드** — 이전 주기가 주기를 넘기면 이번 틱을 건너뛴다. 수동 실행('지금 수집')도
 *     **같은 가드를 공유**한다(연타가 SSH·Redfish 세션을 곱하지 않게 — `net/monitor` 패턴).
 *  ② **동시 수집 제한**(`BMUSAGE_CONCURRENCY` 기본 4) — 200대를 한꺼번에 찌르면 매 주기 SSH
 *     핸드셰이크가 몰려 CPU·회선이 순간 포화된다.
 *  ③ **서버당 타임아웃은 세션을 실제로 끊는다**(`withDeadline` + `signal` — v2.417). `Promise.race`
 *     로 결과만 포기하면 SSH 세션이 남아 동시성 상한이 실효를 잃고 다음 주기가 두 번째 세션을 연다.
 *  ④ **`startAdaptiveTimer`** — 주기를 매 틱 다시 읽는다(설정을 바꿔도 재시작이 필요 없게).
 *  ⑤ **prune 스로틀은 `(++tick % N) === 0`** — 기동 첫 틱에 즉시 참이 되면 안 된다(v2.453).
 *
 * ⚠ **인증 실패(401/403)로 주기 수집을 멈추는 가드를 붙였다**(`util/authGuard.js` — v2.535 규약).
 *   SSH 계정이 틀리면 5분마다 로그인 실패가 쌓여 **계정이 잠긴다**. 멈추는 것은 401/403 계열뿐이고
 *   (타임아웃·연결 실패로 멈추면 일시 장애가 수집을 영구 정지시킨다) 자격증명이 바뀌면 자동 재개한다.
 *   **수동 실행은 막지 않는다** — 고쳤는지 확인할 길을 없애면 안 된다.
 */
import { config } from '../config.js';
import { store } from '../store.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../proxy/sshExec.js';
import { createAuthGuard, isAuthFailureText } from '../util/authGuard.js';
import { loadBmUsageSettings, bmUsageEnabled } from './settings.js';
import { resolveTargets } from './targets.js';
import { buildUsage } from './usage.js';
import { collectOsUsage } from './collectors/osSsh.js';
import { insertUsage, pruneUsage } from './db.js';
import { recordBmUsage } from './activityLog.js';

const CONCURRENCY = Math.max(1, Number(process.env.BMUSAGE_CONCURRENCY) || 4);
const DEVICE_TIMEOUT_MS = Math.max(20_000, Number(process.env.BMUSAGE_DEVICE_TIMEOUT_MS) || 60_000);
const PRUNE_EVERY = 12;

const guard = createAuthGuard({ file: 'bmusage-auth-stops.json' });

let _running = false;
let _last = null;
let _timer = null;
/** 이전 주기의 누적 카운터(인메모리 — 재시작하면 첫 주기가 다시 `null` 이다. 그것이 정직하다). */
const _prev = new Map();

export function bmUsageStatus() {
  const s = loadBmUsageSettings();
  return {
    enabled: bmUsageEnabled(), running: _running, intervalMs: s.intervalMs,
    concurrency: CONCURRENCY, deviceTimeoutMs: DEVICE_TIMEOUT_MS,
    rawRetentionDays: s.rawRetentionDays, dailyRetentionDays: s.dailyRetentionDays,
    last: _last, prevKeys: _prev.size,
    authStopCount: _authStopped.size,
  };
}

/**
 * 지금 **인증 실패로 정지된** 대상 목록. ⚠ 인메모리 맵(`_authStopped`)은 재시작하면 비므로
 * 그것만 보고 '정지 0건' 이라 말하면 **조용한 정지**가 된다(v2.528 규약: "조용히 멈추지 않는다").
 * `authGuard` 는 파일에 남기므로 **대상마다 다시 물어본다**(자격증명이 바뀐 대상은 그 함수가
 * 스스로 기록을 지우고 null 을 준다 = 자동 재개).
 */
export function authStopsFor(targets = []) {
  const out = [];
  for (const tg of targets) {
    const dev = authDev(tg);
    if (!dev) continue;
    const rec = guard.authStopFor(dev);
    if (rec) out.push({ key: tg.key, name: tg.name, vcenterId: tg.vcenterId || '', ...rec });
  }
  return out;
}

/** 대상 해석 — 스냅샷·등록부를 읽어 온다(장비에 접속하지 않는다). */
export async function currentTargets() {
  const s = loadBmUsageSettings();
  const snap = store.get();
  const [{ getFleetInventory }, { loadRegistry }, { listBmServersRaw }] = await Promise.all([
    import('../insights/fleetInventory.js'), import('../idrac/registry.js'), import('../bmstor/registry.js'),
  ]);
  const fleet = await getFleetInventory(snap).catch(() => ({ bareMetal: [] }));
  const registry = (() => { try { return loadRegistry(); } catch { return []; } })();
  const bmServers = (() => { try { return listBmServersRaw(); } catch { return []; } })();
  const isEdge = !!config.agent?.centralUrl;
  return {
    settings: s,
    ...resolveTargets({
      bareMetal: fleet.bareMetal || [], registry, bmServers, settings: s,
      agentName: config.agent?.name || '', isEdge,
    }),
    vcenters: (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id })),
    isEdge,
  };
}

/**
 * 인증 정지 판정용 식별자 — **도구 안에서 유일**해야 한다(`authGuard` 는 `dev.id` 로 찾는다).
 * ⚠ 서버 키만 쓰면 한 법인의 정지가 다른 법인의 같은 태그 서버를 멈춘다 → agent 축을 앞에 둔다
 *   (v2.548 `(agent, part_key)` 와 같은 판단).
 */
function authDev(target) {
  if (!target.osHost) return null;
  return {
    id: `${config.agent?.name || 'central'}|os|${target.key}`,
    username: target.osHost.username, password: target.osHost.password,
  };
}
/** 화면이 '몇 대가 정지됐나' 를 말할 수 있게 이번 주기의 정지분을 기억한다. */
const _authStopped = new Map();

/** 한 서버 수집 — 두 경로를 병렬로 시도하고 실패도 사유와 함께 돌려준다. */
async function collectOne(target, now, { trigger = 'auto' } = {}) {
  const t0 = Date.now();
  const dev = authDev(target);
  // ⚠ **수동 실행은 막지 않는다** — 사람이 1회 누르는 것은 잠금 위험이 없고, 비밀번호를 고친 뒤
  //   확인할 길을 없애면 안 된다(v2.528·v2.535 규약). 막는 것은 주기 수집뿐이다.
  const stopped = (dev && trigger !== 'manual') ? guard.authStopFor(dev) : null;
  if (stopped) _authStopped.set(target.key, stopped); else _authStopped.delete(target.key);
  const jobs = [];
  jobs.push(target.paths.includes('idrac')
    ? import('../idrac/redfish.js').then((m) => m.fetchUsage(target.idrac)).catch((e) => ({ ok: false, kind: 'unreachable', error: String(e?.message || e).slice(0, 300) }))
    : Promise.resolve(null));
  jobs.push((target.paths.includes('os') && !stopped)
    ? withDeadline(DEVICE_TIMEOUT_MS, (signal) => collectOsUsage(target.osHost, { signal }), 'OS 수집 시한 초과')
      .catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }))
    : Promise.resolve(stopped ? { ok: false, error: `인증 실패로 주기 수집이 정지됐습니다(${stopped.attempts}회 시도). 비밀번호를 고치면 자동 재개합니다.`, authStopped: stopped } : null));
  const [idrac, os] = await Promise.all(jobs);

  // 인증 실패면 주기 수집을 멈춘다 — 반복 시도는 결과가 같고 계정만 잠근다.
  if (dev && os && os.ok === false && !os.authStopped && isAuthFailureText(os.error)) {
    const rec = guard.markAuthStopped(dev.id, dev, os.error);
    _authStopped.set(target.key, rec);
    console.warn(`[bmusage] ${target.name}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — ${rec.reason}`);
  } else if (dev && os && os.ok) {
    guard.clearAuthStop(dev.id);
    _authStopped.delete(target.key);
  }

  const built = buildUsage({ target, idrac, os, prev: _prev.get(target.key) || null, now });
  if (built.next) _prev.set(target.key, built.next);
  const ok = !!(idrac?.ok || os?.ok);
  recordBmUsage({
    // ⚠ `idracHost` 는 `publicTarget()` 이 만드는 응답용 필드다 — **내부 target 에는 없다**.
    //   `target.idracHost` 로 읽으면 iDRAC 전용 서버의 작업 로그에 host 가 빈 칸으로 남는다.
    deviceId: target.key, name: target.name, host: target.osHost?.host || target.idrac?.host || '',
    source: config.agent?.name || 'central', ok, durationMs: Date.now() - t0,
    error: ok ? null : (os?.error || idrac?.error || '두 경로 모두 실패'),
    // ⚠ 실패 주기의 수치는 싣지 않는다(0 은 '부하 없음' 이라는 거짓).
    ...(ok ? { cpuPct: built.row.cpu_pct, memPct: built.row.mem_pct, diskBusyPct: built.row.disk_busy_pct, netPct: built.row.net_pct, hbaPct: built.row.hba_pct } : {}),
  });
  return { ok, target, built, idrac, os };
}

/** 동시성 제한 풀(store.collectPool 과 같은 판단 — 새 의존성을 들이지 않는다). */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i; i += 1;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 한 주기. `trigger:'manual'` 이면 인증 정지를 무시한다(사람이 1회 누르는 것은 잠금 위험이 없다).
 */
export async function pollBmUsageOnce({ trigger = 'auto' } = {}) {
  if (!bmUsageEnabled()) return { ok: false, reason: '베어메탈 사용률 수집이 꺼져 있습니다(설정에서 켜세요).' };
  if (_running) return { ok: false, reason: '이전 수집이 진행 중입니다.' };
  _running = true;
  const t0 = Date.now();
  try {
    const { targets, counts, settings } = await currentTargets();
    if (!targets.length) {
      _last = { at: Date.now(), ms: Date.now() - t0, servers: 0, okCount: 0, failCount: 0, inserted: 0, counts, trigger };
      return { ok: true, servers: 0, counts, reason: '대상 서버가 없습니다.' };
    }
    const now = Date.now();
    const results = await pool(targets, CONCURRENCY, (tg) => collectOne(tg, now, { trigger }).catch((e) => ({ ok: false, target: tg, error: String(e?.message || e) })));
    const rows = results.filter((r) => r?.ok && r.built).map((r) => ({ ...r.built.row, src: r.built.row.src }));
    const ins = await insertUsage(rows, config.agent?.name || '');
    const okCount = results.filter((r) => r?.ok).length;
    await pruneUsage({ rawDays: settings.rawRetentionDays, dailyDays: settings.dailyRetentionDays, every: PRUNE_EVERY });
    _last = {
      at: Date.now(), ms: Date.now() - t0, servers: targets.length,
      okCount, failCount: targets.length - okCount, inserted: ins.inserted || 0,
      dbOk: !!ins.ok, dbError: ins.error || null, counts, trigger,
    };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300), trigger };
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

export function startBmUsagePoller() {
  if (_timer) return;
  // ⚠ 인자 순서는 `(getMs, fn, opts)` — 매 틱 주기를 다시 읽어야 설정 변경이 재시작 없이 먹는다.
  _timer = startAdaptiveTimer(() => loadBmUsageSettings().intervalMs, async () => {
    if (!bmUsageEnabled()) return;
    await pollBmUsageOnce({ trigger: 'auto' });
  }, { name: 'bmusage', firstDelayMs: 45_000 });
  console.log('[bmusage] 폴러 등록(설정에서 켜면 수집 시작)');
}

export function stopBmUsagePoller() { _timer?.stop?.(); _timer = null; }
export function _resetForTest() { _prev.clear(); _authStopped.clear(); _last = null; _running = false; guard._resetForTest(); }
export { guard as _authGuardForTest };

