/**
 * bmusage/snapshot/run.js — 진단 스냅샷 **실행(이 노드)** · 보관 · 조회(v2.923 예정 · 리눅스 성능 4단계 · 설계 README §4.1).
 *
 * 사람이 누를 때만 돈다(주기 수집이 아니다). 이 노드가 수집하는 서버만 — 엣지 위임 서버는 그 엣지가 이 함수를 돌린다(routes/collector.js POST /bm-usage/snapshot).
 *
 * ⚠⚠ 원격 명령 실행 경로의 규약(security-api.md v2.923 · 테스트 `server/test/bmPerf2923Snapshot.test.js`):
 *   · 명령은 `command.js SNAPSHOT_COMMAND` 상수 하나 — 서버 이름 · 사유 · 사용자 이름 · 설정값을 명령에 넣지 않는다.
 *   · 읽기 전용 · sudo 자동 시도 없음 · 프로세스 인자 없음 · 출력 상한(명령 head -c + sshExec 상한 + 파서 줄 상한).
 *   · **서버당 동시 1건**(이 노드의 실행 중 집합 — 검사와 등록 사이에 await 가 없다) · **법인당 24시간 상한**(보관 표의 실행 수 — 보관 DB 를 못 열면 셀 수 없으므로 실행하지 않는다).
 *   · SSH 는 공용 `withSsh`(호스트키 확인 S-01 · 출력 상한)와 `withDeadline`(시한이 세션을 실제로 끊는다) · 인증 실패는 주기 수집과 같은 가드에 기록(poller.recordOsAuthOutcome).
 *   · 결과는 이 노드에 **7일** 보관(SNAPSHOT_KEEP_DAYS — 실행 때마다 보관 밖을 지운다). 중앙은 결과만 당긴다(복제 적재하지 않는다).
 *   · 사유 · 실행자는 보관 행과 감사 로그(라우트)에 남는다 — 명령에는 들어가지 않는다.
 *   · iDRAC 쪽은 **이미 가진 데이터만**(인벤토리의 최근 SEL/LC · 센서 순간값 · 전력 최신값) — Redfish 호출 0(hwFacts 와 같은 규약).
 */
import crypto from 'node:crypto';
import { withSsh, withDeadline } from '../../proxy/sshExec.js';
import { SNAPSHOT_COMMAND, parseSnapshot, SNAPSHOT_CODE_STATUS, SNAPSHOT_CODES } from './command.js';
import { config } from '../../config.js';
import { isAuthFailureText, isPeerRejectText } from '../../util/authGuard.js';

/** 세션 시한(연결 + 명령 — 명령 안 sleep 2초 포함). 장비 시한보다 짧은 명령 시한(산수는 테스트가 고정). */
export const SNAPSHOT_READY_MS = 15_000;
export const SNAPSHOT_CMD_MS = 30_000;
export const SNAPSHOT_DEADLINE_MS = 50_000;
export const SNAPSHOT_KEEP_MS = 7 * 86_400_000;
export const SNAPSHOT_WINDOW_MS = 86_400_000;
/** 사유 — 줄바꿈 · 제어 문자를 빼고 2~300자. 비면 실행하지 않는다(400). */
export function cleanReason(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
  return s.length >= 2 ? s : '';
}

export { SNAPSHOT_CODE_STATUS, SNAPSHOT_CODES };

const _running = new Set();
export function snapshotRunningKeys() { return [..._running]; }
export function _resetSnapshotForTest() { _running.clear(); }

/** iDRAC 순간값 · 최근 이벤트(이미 가진 데이터 — 장비 왕복 0). 등록이 없으면 null(경로 없음). */
export async function idracSnapshotFacts(target, deps = {}) {
  const id = String(target?.idrac?.regId || '').trim();
  if (!id) return null;
  const D = {
    getInventory: async (x) => (await import('../../idrac/invCache.js')).getInventory(x),
    getSensorSeries: async (x) => (await import('../../idrac/sensorStore.js')).getSensorSeries(x, { minutes: 0 }),
    powerLatest: async (x) => { try { const db = await (await import('../../idrac/db.js')).getDb(); return db?.latest ? db.latest(x) : null; } catch { return null; } },
    ...deps,
  };
  let inv = null; let sensor = null; let power = null;
  try { inv = await D.getInventory(id); } catch { inv = null; }
  try { sensor = (await D.getSensorSeries(id))?.latest || null; } catch { sensor = null; }
  try { power = await D.powerLatest(id); } catch { power = null; }
  const events = Array.isArray(inv?.events) ? inv.events.slice(0, 5).map((e) => ({ severity: String(e?.severity || '').slice(0, 16), at: String(e?.created || '').slice(0, 40), message: String(e?.message || '').slice(0, 200) })) : null;
  const temps = sensor?.temps && typeof sensor.temps === 'object' ? Object.entries(sensor.temps).slice(0, 12).map(([name, c]) => ({ name: String(name).slice(0, 48), c: typeof c === 'number' ? c : null })) : null;
  return {
    events, eventsAt: typeof inv?.collectedAt === 'number' ? inv.collectedAt : null,
    temps, sensorAt: typeof sensor?.t === 'number' ? sensor.t : null, cpuPct: typeof sensor?.cpu === 'number' ? sensor.cpu : null,
    powerW: typeof power?.watts === 'number' ? power.watts : null, powerAt: typeof power?.ts === 'number' ? power.ts : null,
  };
}

/**
 * 한 서버의 스냅샷을 이 노드에서 실행한다.
 * @param {object} p
 * @param {object} p.target   이 노드의 대상(osHost 자격증명 포함 — 반환값에는 싣지 않는다)
 * @param {string} p.reason   사유(cleanReason 통과분)
 * @param {string} p.by       실행자(사람 계정 또는 'central-portal:<계정>')
 * @param {object} p.settings bmusage 설정(snapshot.dailyCorpMax · topN · dmesgLines)
 * @param {object} [deps]     테스트 주입(ssh · db · 인증 가드 · iDRAC)
 */
export async function runSnapshotLocal({ target, reason, by = '', settings = {}, now = Date.now() } = {}, deps = {}) {
  const D = {
    withSsh, withDeadline,
    db: async () => import('../db.js'),
    authOutcome: async (tg, o) => (await import('../poller.js')).recordOsAuthOutcome(tg, o),
    authStop: async (tg) => (await import('../poller.js')).osAuthStopFor(tg),
    idrac: (tg) => idracSnapshotFacts(tg),
    ...deps,
  };
  const r = cleanReason(reason);
  if (!r) return { ok: false, code: 'bad-reason', reason: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).' };
  if (!target || !target.key) return { ok: false, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' };
  if (!target.osHost || !String(target.osHost.host || '').trim()) return { ok: false, code: 'no-os-path', reason: '이 서버에는 OS 계정(베어메탈 스토리지 등록부)이 없습니다 — 스냅샷은 SSH 경로가 있어야 합니다.' };
  // ⚠ 동시 1건: 검사와 등록 사이에 await 를 두지 않는다(같은 틱의 두 요청이 둘 다 통과하지 않게).
  if (_running.has(target.key)) return { ok: false, code: 'busy', reason: '이 서버의 스냅샷이 이미 실행 중입니다 — 끝난 뒤 다시 누르세요.' };
  _running.add(target.key);
  try {
    const DB = await D.db();
    if (!(await DB.snapshotStoreAvailable())) return { ok: false, code: 'store-unavailable', reason: '스냅샷 보관 DB 를 열 수 없어 실행하지 않았습니다(하루 상한을 셀 수 없습니다).' };
    const snapCfg = settings?.snapshot || {};
    const max = Math.max(1, Number(snapCfg.dailyCorpMax) || 20);
    const used = await DB.snapshotCountSince({ vcenterId: String(target.vcenterId || ''), since: now - SNAPSHOT_WINDOW_MS });
    if (used == null) return { ok: false, code: 'store-unavailable', reason: '스냅샷 보관 DB 를 열 수 없어 실행하지 않았습니다(하루 상한을 셀 수 없습니다).' };
    if (used >= max) return { ok: false, code: 'daily-cap', reason: `이 법인의 24시간 스냅샷 상한(${max}회)에 닿았습니다(지금 ${used}회).`, used, max };
    try { await DB.snapshotPrune({ before: now - SNAPSHOT_KEEP_MS }); } catch { /* 지우기 실패는 실행을 막지 않는다 — 다음 실행이 다시 지운다 */ }
    const stopBefore = await D.authStop(target).catch(() => null);
    const t0 = Date.now();
    let code = 'ok'; let errText = ''; let result = null;
    try {
      const out = await D.withDeadline(SNAPSHOT_DEADLINE_MS, (signal) => D.withSsh({
        host: String(target.osHost.host).trim(), port: Number(target.osHost.port) || 22,
        username: String(target.osHost.username || 'root'), password: target.osHost.password || '', privateKey: target.osHost.privateKey || undefined,
        readyTimeout: SNAPSHOT_READY_MS, signal,
      }, async ({ exec }) => exec(SNAPSHOT_COMMAND, SNAPSHOT_CMD_MS)), '진단 스냅샷 시한 초과');
      const parsed = parseSnapshot(out?.stdout || '', { topN: snapCfg.topN, dmesgLines: snapCfg.dmesgLines });
      // 구획 표지가 하나도 없으면(Windows · 제한 셸) 리눅스 스냅샷이 아니다.
      if (!['cpu', 'mem', 'io', 'ss', 'dmesg'].some((k) => parsed.states[k] !== 'missing')) { code = 'not-linux'; errText = '구획 표지가 없습니다 — 리눅스 셸이 아니거나 명령이 제한된 계정입니다.'; }
      else result = parsed;
    } catch (e) {
      errText = String(e?.message || e).slice(0, 300);
      code = isPeerRejectText(errText) ? 'host-key' : isAuthFailureText(errText) ? 'auth' : /시한 초과|timeout|타임아웃/i.test(errText) ? 'timeout' : 'ssh-error';
    }
    const ms = Date.now() - t0;
    try { await D.authOutcome(target, { ok: code === 'ok', errorText: code === 'auth' ? errText : '' }); } catch { /* 가드 기록 실패는 결과를 바꾸지 않는다 */ }
    const idrac = await Promise.resolve(D.idrac(target)).catch(() => null);
    const id = crypto.randomUUID();
    const at = Date.now();
    const full = { ...(result || {}), idrac, ...(errText ? { error: errText } : {}), ...(stopBefore ? { authStoppedBefore: { since: stopBefore.since, attempts: stopBefore.attempts } } : {}) };
    const ins = await DB.snapshotInsert({ id, agent: config.agent?.name || '', key: target.key, vcenterId: target.vcenterId || '', at, by, reason: r, ok: code === 'ok', code, ms, result: full }).catch(() => ({ ok: false }));
    return { ok: code === 'ok', code, id, at, ms, key: target.key, result: full, stored: !!ins?.ok, ...(errText ? { reason: errText } : {}), used: used + 1, max };
  } finally {
    _running.delete(target.key);
  }
}

/** 이 노드에 보관된 스냅샷 목록(결과 본문 없이). */
export async function listSnapshotsLocal({ key, limit = 20 } = {}, deps = {}) {
  const DB = deps.db ? await deps.db() : await import('../db.js');
  const list = await DB.snapshotList({ key, agent: config.agent?.name || '', limit });
  if (list == null) return { ok: false, code: 'store-unavailable', reason: '스냅샷 보관 DB 를 열 수 없습니다.' };
  return { ok: true, snapshots: list, keepDays: SNAPSHOT_KEEP_MS / 86_400_000, running: _running.has(String(key)) };
}
/** 이 노드에 보관된 스냅샷 하나 — 키가 다르면 없는 것으로(다른 서버의 id 로 읽지 못하게). */
export async function getSnapshotLocal({ key, id } = {}, deps = {}) {
  const DB = deps.db ? await deps.db() : await import('../db.js');
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { ok: false, code: 'not-found', reason: '스냅샷을 찾지 못했습니다.' };
  const s = await DB.snapshotGet(String(id));
  if (!s || s.key !== String(key) || s.agent !== (config.agent?.name || '')) return { ok: false, code: 'not-found', reason: '스냅샷을 찾지 못했습니다.' };
  return { ok: true, snapshot: s };
}
