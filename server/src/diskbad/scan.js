/**
 * diskbad/scan.js — **이 노드가 가진** iDRAC 서버들의 Lifecycle 로그를 읽어 서버별 결과를 만든다(v3.8.0).
 *
 * 엣지(그 법인 서버)와 중앙(엣지가 없는 법인의 직결 서버)이 같은 함수를 쓴다. 결과는 판정하지 않은 **원문**이다 —
 * 분류 · 판정은 중앙(classify.js · verdict.js)이 한다(분류표를 고쳐도 엣지를 올리지 않아도 되게).
 *
 * 지키는 것(루트 CLAUDE.md 성능 · 자격증명 규칙):
 *  · 동시성 제한(`poolSettled`) · 서버당 시한(`withDeadline` — 세션을 실제로 끊는다) · 쪽 사이 예산(일부만 읽음으로 남긴다).
 *  · 인증 실패(401)는 그 서버의 **주기 점검을 멈춘다**(`createAuthGuard` — 자동 재시도 금지, 계정 잠금 방지).
 *    iDRAC 전력 · 온도 폴러가 이미 인증 정지한 서버는 로그인을 시도하지 않는다(같은 계정이다).
 *    서버 한 대를 화면에서 직접 누른 점검(manual)은 정지를 무시한다(비밀번호를 고친 뒤 확인할 길을 막지 않는다 — authGuard 규칙 3).
 *  · 403 은 인증 실패가 아니라 권한(로그 읽기 권한이 없는 계정)이다 — 정지하지 않고 사유로 밝힌다.
 *  · HPE iLO 는 제외(사용자 결정 README §11) · OME 등록은 물리 서버가 아니다.
 */
import { config } from '../config.js';
import { poolSettled } from '../util/pool.js';
import { withDeadline, deadlineMs } from '../util/deadline.js';
import { createAuthGuard } from '../util/authGuard.js';
import { readLclog, DEFAULT_MGR } from './lclog.js';
import { probeIdrac } from './probe.js';
import { readDiskVals } from './diskvals.js';
import { readSel } from './sel.js';
import { cursorOf, saveCursors } from './cursors.js';
import { mockScanServer } from './mock.js';

const authGuard = createAuthGuard({ file: 'diskbad-auth-stops.json' });
export const SERVER_TIMEOUT_MS = () => deadlineMs(process.env.DISKBAD_SERVER_TIMEOUT_MS, 10 * 60_000);
export const CONCURRENCY = () => Math.min(16, Math.max(1, Number(process.env.DISKBAD_CONCURRENCY) || 4));
const MAX_ENTRIES = () => Math.min(200_000, Math.max(1_000, Number(process.env.DISKBAD_MAX_ENTRIES) || 50_000));
export const CHUNK_SERVERS = 25;
export const DRIVES_MAX = 64;
export const RECORDS_MAX = 5_000;
/** 장비 진단(probe.js)의 시한 — 서버 한 대를 직접 점검할 때만 돈다(GET 십여 번). */
export const PROBE_TIMEOUT_MS = 120_000;
/** 과거 기록 읽기 1단계(README §22) — 디스크 값(GET 1 + 링크를 준 디스크 수) · SEL(쪽 수 상한 40)의 시한. 로그 읽기와 따로 끊는다. */
export const VALS_TIMEOUT_MS = 90_000;
export const SEL_TIMEOUT_MS = 90_000;
const SEL_BUDGET_MS = 60_000;

/** 결과 사유 코드 — 중앙이 화이트리스트로 받는다(ingest.js). */
export const REASON = Object.freeze({
  ok: '', excluded: 'excluded', authStopped: 'auth-stopped', authFailed: 'auth-failed', forbidden: 'forbidden',
  timeout: 'timeout', unreachable: 'unreachable', error: 'error',
});
export const REASON_LABEL = Object.freeze({
  excluded: '대상 아님(HPE iLO · 관리 콘솔)', 'auth-stopped': '인증 실패로 멈춤 — 자동으로 다시 시도하지 않음',
  'auth-failed': 'iDRAC 로그인 실패(401) — 자동으로 다시 시도하지 않음', forbidden: '로그 읽기 권한 없음(403)',
  timeout: '시한 초과', unreachable: '연결 실패', error: '읽기 실패',
});

const t = (v, n = 200) => String(v ?? '').slice(0, n);

function isHpe(s) {
  const v = String(s?.vendor || '').trim().toLowerCase();
  return v === 'hpe' || v === 'hp' || v.includes('hewlett');
}

/** 인벤토리 캐시의 디스크 → 보낼 모양(없으면 null — '못 읽음'. 빈 배열과 다르다). */
export function drivesOf(inv) {
  if (!inv || !Array.isArray(inv.disks)) return null;
  if (inv.collections && inv.collections.disks && inv.collections.disks !== 'ok') return null;
  return inv.disks.slice(0, DRIVES_MAX).map((d) => ({
    id: t(d?.id, 200), name: t(d?.name, 128), model: t(d?.model, 80), serial: t(d?.serial, 64),
    capacityGB: Number.isFinite(d?.capacityGB) ? d.capacityGB : null, media: t(d?.media, 16), health: t(d?.health, 16), state: t(d?.state, 24),
    predictive: d?.predictiveFailure === true ? true : (d?.predictiveFailure === false ? false : null),
    inVolume: d?.inVolume === true ? true : (d?.inVolume === false ? false : null),
  }));
}

/** 인벤토리 디스크의 DriveMetrics 링크(장비가 알려 준 것만 — 꼴 검사는 diskvals.js metricsPathOf). */
function metricLinksOf(inv) {
  return Array.isArray(inv?.disks) ? inv.disks.slice(0, DRIVES_MAX).map((d) => ({ id: t(d?.id, 200), metricsPath: typeof d?.metricsPath === 'string' ? d.metricsPath : '' })) : null;
}

/**
 * 디스크 값 · SEL(과거 기록 읽기 1단계). 로그 읽기와 **따로** 시한을 걸고 실패를 격리한다 — 둘 중 하나가 실패해도 로그 결과는 그대로다.
 * 401 이면 인증 정지로 적고 나머지를 묻지 않는다(다시 로그인하지 않는다 — authGuard 규칙).
 * @returns {Promise<{vals:object, sel:object}>}
 */
async function readPast(s, { inv, mgr, now }) {
  const at = now();
  const fail = (e) => ({ at, status: /시한/.test(String(e?.message || '')) ? 'timeout' : (e?.status === 403 ? 'forbidden' : (e?.status === 404 ? 'absent' : 'error')) });
  const authStop = (e) => { authGuard.markAuthStopped(s.id, s, t(e?.message, 200)); return { vals: { at, status: 'auth' }, sel: { at, status: 'auth' } }; };
  const isAuth = (e) => e?.status === 401 || e?.authFailed === true;
  let vals;
  try { vals = await withDeadline(VALS_TIMEOUT_MS, (signal) => readDiskVals(s, { signal, drives: metricLinksOf(inv), now }), '디스크 값 읽기 시한 초과'); }
  catch (e) { if (isAuth(e)) return authStop(e); vals = fail(e); }
  let sel;
  try { sel = await withDeadline(SEL_TIMEOUT_MS, (signal) => readSel(s, { mgr, signal, now, budgetMs: SEL_BUDGET_MS }), 'SEL 읽기 시한 초과'); }
  catch (e) { if (isAuth(e)) return { ...authStop(e), vals }; sel = fail(e); }
  return { vals, sel };
}

function failReason(e) {
  if (e?.authFailed === true || e?.status === 401) return REASON.authFailed;
  if (e?.status === 403) return REASON.forbidden;
  const m = String(e?.message || e || '');
  if (/시한|timeout|aborted/i.test(m)) return REASON.timeout;
  if (/ECONN|ENOTFOUND|EHOSTUNREACH|socket|fetch failed|TLS|certificate/i.test(m)) return REASON.unreachable;
  return REASON.error;
}

/**
 * 서버 한 대.
 * @param {object} s 등록부 항목(자격증명 포함 — 결과에는 싣지 않는다)
 * @param {{mode:'incremental'|'full', manual?:boolean, invOf?:Function, now?:Function}} o
 */
export async function scanOne(s, { mode = 'incremental', manual = false, invOf = () => null, now = Date.now, authStoppedByPoller = () => false, mock = false } = {}) {
  const base = { id: t(s.id, 128), name: t(s.name || s.host || s.id, 128), host: t(String(s.host || '').replace(/^https?:\/\//i, ''), 256), serviceTag: t(s.serviceTag, 32), at: now() };
  if (String(s.type || '') === 'ome' || isHpe(s)) return { ...base, ok: false, reason: REASON.excluded };
  const inv = invOf(s.id);
  const drives = drivesOf(inv);
  const invAt = Number.isFinite(inv?.collectedAt) ? inv.collectedAt : null;
  if (mock) return { ...mockScanServer({ ...base, drives, invAt, mode, manual, cursor: mode === 'full' ? null : cursorOf(s.id), now: now() }) };
  if (!manual) {
    if (authStoppedByPoller(s)) return { ...base, ok: false, reason: REASON.authStopped, drives, invAt };
    if (authGuard.authStopFor(s)) return { ...base, ok: false, reason: REASON.authStopped, drives, invAt };
  }
  // 지난번이 일부만 읽은 것이면(complete:false) 처음부터 다시 읽는다 — 이어 읽기는 '그 아래는 다 읽었다' 가 참일 때만.
  const prevCursor = mode === 'full' ? null : cursorOf(s.id);
  const cursor = prevCursor && prevCursor.complete ? prevCursor : null;
  const timeout = SERVER_TIMEOUT_MS();
  // 서버 한 대를 화면에서 직접 점검할 때만 — 그 장비가 실제로 무엇을 주는지 읽기 전용으로 묻는다(probe.js). 실패해도 점검 결과는 그대로다.
  const probe = async () => {
    if (!manual) return undefined;
    try { return await withDeadline(PROBE_TIMEOUT_MS, (signal) => probeIdrac(s, { signal, now }), '장비 진단 시한 초과'); }
    catch (e) { return { v: 0, at: now(), error: t(e?.status ? `HTTP ${e.status}` : e?.message, 80) }; }
  };
  try {
    const r = await withDeadline(timeout, (signal) => readLclog(s, { cursor, signal, budgetMs: Math.max(30_000, timeout - 60_000), maxEntries: MAX_ENTRIES(), now }), 'Lifecycle 로그 읽기 시한 초과');
    authGuard.clearAuthStop(s.id);
    const log = {
      order: r.order, total: r.total, read: r.read, undated: r.undated, newestId: r.newest?.entryId || '', newestCreated: r.newest?.created ?? null,
      oldestRead: r.oldestRead, reachedEnd: r.reachedEnd, foundCursor: r.foundCursor, cursorUsed: r.cursorUsed, stopped: r.stopped,
      cursorCreated: cursor?.created ?? null,
      // 무엇을 읽었는가(진단 — 판정에 쓰지 않는다): 쪽 수 · 걸린 시간 · 기록 ID 구성 · 첫 쪽 크기 · 다음 쪽 링크 · 경로.
      pages: r.pages, ms: r.ms, distinct: r.distinct, top: r.top, firstLen: r.firstLen, hasNext: r.hasNext, path: r.path, oldestCode: r.oldestCode,
    };
    // 상한을 넘으면 **가장 새 것** 을 남긴다(반증 #8 — 장비가 준 순서와 무관하게). 잘렸으면 이어 읽기 커서도 '끝까지 봄' 이 아니다
    //   — 다음 점검이 처음부터 다시 읽고, 중앙은 잘린 아래 구간을 '본 구간' 에서 뺀다(db.js).
    const capped = r.entries.length > RECORDS_MAX;
    const records = capped ? [...r.entries].sort((a, b) => (b.created ?? -Infinity) - (a.created ?? -Infinity)).slice(0, RECORDS_MAX) : r.entries;
    const past = await readPast(s, { inv, mgr: r.mgrPath, now });
    // 디스크 값 · SEL 에서 인증이 거부됐으면 장비 진단으로 다시 로그인하지 않는다(반증 F6).
    const pr = past.vals?.status === 'auth' || past.sel?.status === 'auth' ? undefined : await probe();
    return { ...base, ok: true, reason: REASON.ok, log, records, recordsCapped: capped, drives, invAt, ...past, ...(pr ? { probe: pr } : {}),
      _cursor: r.newest ? { entryId: r.newest.entryId, created: r.newest.created, complete: !capped && (r.reachedEnd || r.foundCursor) } : (cursor || null) };
  } catch (e) {
    const reason = failReason(e);
    if (reason === REASON.authFailed) authGuard.markAuthStopped(s.id, s, t(e?.message, 200));
    // 로그 읽기가 실패해도(경로 없음 · 권한) 장비 진단은 답할 수 있다 — 인증 실패 · 연결 실패면 묻지 않는다(다시 로그인하지 않는다).
    const pr = (reason === REASON.authFailed || reason === REASON.unreachable) ? undefined : await probe();
    // 디스크 값 · SEL 은 로그 권한이 없거나(403) 로그 경로가 없어도(404) 읽힐 수 있다. 그 밖(시한 · 인증 · 연결 실패 · 429 · 5xx — 장비가 느리거나
    //   막혔거나 바쁘다)이면 더 묻지 않는다(반증 F5). 장비 진단이 인증 거부를 받았으면 다시 로그인하지 않는다(반증 F6).
    const lcMissing = reason === REASON.error && e?.status === 404;
    const past = (reason === REASON.forbidden || lcMissing) && !pr?.authDenied ? await readPast(s, { inv, mgr: DEFAULT_MGR, now }) : {};
    return { ...base, ok: false, reason, reasonText: t(e?.message, 200), drives, invAt, ...past, ...(pr ? { probe: pr } : {}) };
  }
}

/**
 * 여러 대. 끝난 서버부터 `onChunk` 로 묶어 넘긴다(엣지는 그 묶음을 바로 중앙에 올린다 — 진행률 · 본문 크기).
 *
 * ⚠ 반증 #1(높음): 이어 읽기 커서는 **그 묶음이 저장됐다는 답을 받은 서버만** 앞으로 보낸다. `onChunk` 가 false 를 돌려주거나
 *   던지면 그 묶음 서버들의 커서는 그대로다(다음 점검이 같은 구간을 다시 읽고, 중앙이 키로 중복을 거른다). 보고가 버려졌는데
 *   커서만 앞으로 가면 그 구간의 기록은 영영 읽히지 않고, 중앙은 그 구간을 '끊김 없이 봄' 으로 남긴다(거짓 '기록 없음').
 *   한 묶음이 실패해도 다음 묶음은 계속 보낸다.
 * @param {Array} servers 등록부 항목
 * @param {{mode?:string, manual?:boolean, serverIds?:string[]|null, onChunk?:(batch:Array, stat:object)=>Promise<boolean|void>, onProgress?:Function}} o
 * @returns {Promise<{total:number, done:number, failed:number, excluded:number, unsaved:number}>}  unsaved = 저장 답을 못 받은 서버 수
 */
export async function scanServers(servers, { mode = 'incremental', manual = false, serverIds = null, onChunk = async () => {}, onProgress = () => {}, shouldStop = () => false, deps = {} } = {}) {
  const want = Array.isArray(serverIds) && serverIds.length ? new Set(serverIds.map(String)) : null;
  const list = (servers || []).filter((s) => s && s.id && (!want || want.has(String(s.id))));
  const invOf = deps.invOf || (await import('../idrac/invCache.js')).getInventory;
  let authStoppedByPoller = deps.authStoppedByPoller;
  if (!authStoppedByPoller) {
    try { const { idracAuthStopFor } = await import('../idrac/poller.js'); authStoppedByPoller = (s) => !!idracAuthStopFor(s); } catch { authStoppedByPoller = () => false; }
  }
  let mock = deps.mock;
  if (mock == null) { try { mock = (await import('../mock/demo/flags.js')).isMockMode(); } catch { mock = false; } }
  const stat = { total: list.length, done: 0, failed: 0, excluded: 0, unsaved: 0 };
  let buf = [];
  const pending = new Map();      // 결과 객체 → 그 서버의 새 커서(저장 답을 받으면 적는다)
  let flushing = Promise.resolve();
  const flush = (final) => {
    const batch = buf; buf = [];
    if (!batch.length && !final) return flushing;
    flushing = flushing.then(async () => {
      let stored = false;
      try { stored = (await onChunk(batch, { ...stat, final })) !== false; } catch { stored = false; }
      const m = {};
      for (const r of batch) { if (pending.has(r)) { if (stored) m[r.id] = pending.get(r); pending.delete(r); } }
      if (stored) { if (Object.keys(m).length) saveCursors(m); } else stat.unsaved += batch.length;
    });
    return flushing;
  };
  await poolSettled(list, CONCURRENCY(), async (s) => {
    if (shouldStop()) return;   // 중단 — 진행 중인 서버는 끝내고 다음 서버부터 멈춘다
    const r = await scanOne(s, { mode, manual, invOf, authStoppedByPoller, mock });
    if (r._cursor !== undefined) { if (r._cursor) pending.set(r, r._cursor); delete r._cursor; }
    stat.done += 1;
    if (!r.ok) { if (r.reason === REASON.excluded) stat.excluded += 1; else stat.failed += 1; }
    buf.push(r);
    onProgress({ ...stat });
    if (buf.length >= CHUNK_SERVERS) await flush(false);
  });
  await flush(true);
  return stat;
}

/** 이 노드의 등록부(엣지 · 중앙 공용). OME 는 위에서 걸러진다. */
export async function localServers() {
  const { loadRegistry } = await import('../idrac/registry.js');
  try { return loadRegistry() || []; } catch { return []; }
}

export function diskBadAuthStops() { return authGuard; }
void config;
